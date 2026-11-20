/**
 * Elite Cuts API — Cloudflare Worker backed by a D1 (SQLite) database bound as DB; see ../schema.sql.
 *
 * Replaced the original KV storage: KV is eventually consistent, so two clients could take the
 * same chair within the propagation window. Here a unique index makes that impossible, every
 * booking is written in one transaction, and loyalty is an append-only ledger.
 *
 *   GET   /api/health
 *   GET   /api/slots?date=YYYY-MM-DD&barberId=brb-1        -> { booked: ["11:00 AM", ...] }
 *   POST  /api/bookings                                      -> 201 { booking } | 409 slot taken
 *   POST  /api/bookings/late   { refCode, phone, minutes }   -> { booking }      (new, used by the chat)
 *   GET   /api/loyalty?phone=...                             -> { points, stamps, history }
 *   POST  /api/manager/login   { pin }                       -> { token, expiresAt }
 *   POST  /api/manager/logout                                -> { ok }                   (X-Manager-Token)
 *   GET   /api/manager/bookings?from&to                      -> { bookings, from, to }   (X-Manager-Token)
 *   PATCH /api/manager/bookings/:id { status }               -> { booking }              (X-Manager-Token)
 *   GET   /api/manager/loyalty.csv                           -> text/csv                 (X-Manager-Token)
 *   GET   /api/manager/report?from&to                        -> { rows }   (new: per-day, per-barber totals)
 *   GET   /api/shop                                          -> { settings, updatedAt }  (public shop profile)
 *   PUT   /api/manager/shop     { ...settings }              -> { settings, updatedAt }  (X-Manager-Token)
 *   POST  /api/webhook/stripe                                -> { received: true }
 *
 * Secrets: MANAGER_PIN (required)
 *          STRIPE_WEBHOOK_SECRET (recommended) — verifies Stripe webhook signatures
 *          STRIPE_SECRET_KEY (fallback) — with no webhook secret, each webhook's checkout session is
 *            re-fetched from Stripe and must be paid. With neither, webhooks are refused.
 * Vars:    ALLOWED_ORIGINS  comma-separated allow-list of browser origins; "https://*.example.pages.dev"
 *                           also matches preview subdomains; "*" allows any (also reads ALLOWED_ORIGIN)
 */

const STATUSES = ['Confirmed', 'Deposit Unpaid', 'Paid', 'Completed', 'Cancelled', 'No-Show'];
const REQUIRED = ['services', 'barberId', 'barberName', 'date', 'time', 'clientName', 'clientPhone', 'paymentMode'];
const BOOKING_POINTS = 100;   // pay-at-chair bookings earn when the manager marks the visit Completed
const DEPOSIT_POINTS = 150;   // deposit bookings earn when Stripe (or the manager) marks them paid
const LOGIN_MAX_FAILS = 5;     // wrong manager PINs from one IP before a lockout
const LOGIN_LOCK_MINUTES = 15;
const LOGIN_GLOBAL_MAX_FAILS = 100; // wrong PINs from ALL addresses per hour before logins pause (stops IP-rotation guessing)
const SESSION_HOURS = 12;          // a manager login lasts this long, or until logout
const BOOKINGS_PER_HOUR = 10;      // new bookings per client address per hour
const LOOKUPS_PER_HOUR = 30;       // loyalty lookups per client address per hour
const LATE_PER_HOUR = 10;          // "running late" calls per client address per hour
const BOOK_AHEAD_DAYS = 120;       // furthest date a client can book
const enc = new TextEncoder();

// ---------- small helpers (exported for unit tests) ----------
export const json = (data, status = 200, headers = {}) =>
  new Response(JSON.stringify(data), { status, headers: { 'Content-Type': 'application/json', ...headers } });

const today = () => new Date().toISOString().slice(0, 10);
export const normalizePhone = (p) => String(p || '').replace(/\D/g, '');
export const isDate = (s) => /^\d{4}-\d{2}-\d{2}$/.test(s || '') && !Number.isNaN(Date.parse(s + 'T00:00:00Z'));
const hex = (buf) => [...new Uint8Array(buf)].map((b) => b.toString(16).padStart(2, '0')).join('');
const nowIso = () => new Date().toISOString();

export function timingSafeEqual(a, b) {
  const x = enc.encode(String(a)), y = enc.encode(String(b));
  let diff = x.length ^ y.length;
  for (let i = 0; i < Math.max(x.length, y.length); i++) diff |= (x[i] || 0) ^ (y[i] || 0);
  return diff === 0;
}

export async function hmacHex(secret, message) {
  const key = await crypto.subtle.importKey('raw', enc.encode(secret), { name: 'HMAC', hash: 'SHA-256' }, false, ['sign']);
  return hex(await crypto.subtle.sign('HMAC', key, enc.encode(message)));
}

export const sha256Hex = async (s) => hex(await crypto.subtle.digest('SHA-256', enc.encode(s)));
const randomToken = () => hex(crypto.getRandomValues(new Uint8Array(32)));

/**
 * Manager sessions are random tokens. Only their SHA-256 hash is stored, each one expires after
 * SESSION_HOURS and logout deletes it. (The old token was derived from the PIN, so one leaked
 * token let anyone recover a short PIN offline and mint tokens for any future day.)
 */
async function requireManager(req, env) {
  const sent = req.headers.get('X-Manager-Token') || '';
  if (!/^[0-9a-f]{64}$/.test(sent)) return json({ error: 'Unauthorized' }, 401);
  const row = await env.DB.prepare('SELECT expires_at FROM manager_sessions WHERE token_hash = ?').bind(await sha256Hex(sent)).first();
  if (!row || row.expires_at <= nowIso()) return json({ error: 'Unauthorized' }, 401);
  return null;
}

/** Address used for limits. IPv6 users can rotate addresses inside their /64, so the whole /64 counts as one. */
export function clientKey(req) {
  const ip = req.headers.get('CF-Connecting-IP') || 'unknown';
  if (!ip.includes(':')) return ip;
  const full = ip.includes('::')
    ? (() => { const [a, b] = ip.split('::'); const h = a ? a.split(':') : [], t = b ? b.split(':') : []; return [...h, ...Array(8 - h.length - t.length).fill('0'), ...t]; })()
    : ip.split(':');
  return full.slice(0, 4).map((x) => x.toLowerCase().replace(/^0+(?=.)/, '')).join(':') + '::/64';
}

/** Fixed-window counter in D1. Returns null when allowed, or a 429 response. */
async function rateLimit(env, bucket, limit, windowSec) {
  const now = nowIso();
  const windowStart = new Date(Date.now() - windowSec * 1000).toISOString();
  const row = await env.DB.prepare(
    `INSERT INTO rate_limits (bucket, window_start, count) VALUES (?1, ?2, 1)
     ON CONFLICT(bucket) DO UPDATE SET
       count = CASE WHEN window_start <= ?3 THEN 1 ELSE count + 1 END,
       window_start = CASE WHEN window_start <= ?3 THEN ?2 ELSE window_start END
     RETURNING count, window_start`
  ).bind(bucket, now, windowStart).first();
  if (!row || row.count <= limit) return null;
  const retry = Math.max(1, Math.ceil((Date.parse(row.window_start) + windowSec * 1000 - Date.now()) / 1000));
  return json({ error: 'Too many requests. Please try again later.' }, 429, { 'Retry-After': String(retry) });
}

async function readBody(req) {
  try { return await req.json(); } catch { return null; }
}

/** D1 surfaces SQLite's message, e.g. "UNIQUE constraint failed: bookings.barber_id, bookings.date, bookings.time". */
export const isSlotConflict = (err) => /UNIQUE constraint failed: bookings\.barber_id/.test(String(err && err.message || err));
const isRefConflict = (err) => /UNIQUE constraint failed: bookings\.ref_code/.test(String(err && err.message || err));

// ---------- CORS allow-list ----------
export function allowedOrigins(env) {
  return String(env.ALLOWED_ORIGINS || env.ALLOWED_ORIGIN || '')
    .split(',').map((s) => s.trim().replace(/\/+$/, '')).filter(Boolean);
}

/** Exact origin, or a "https://*.domain" entry matching any single-host subdomain (Pages previews). */
export function originMatches(entry, origin) {
  if (entry === origin) return true;
  const m = entry.match(/^(https?):\/\/\*\.(.+)$/);
  if (!m) return false;
  try {
    const u = new URL(origin);
    return u.protocol === `${m[1]}:` && !u.port && u.hostname.endsWith(`.${m[2]}`);
  } catch { return false; }
}

/** Returns { allowed, headers }. Requests without an Origin header (curl, Stripe) are not browser calls and pass. */
export function cors(req, env) {
  const list = allowedOrigins(env);
  const origin = req.headers.get('Origin');
  const base = {
    'Access-Control-Allow-Methods': 'GET, POST, PUT, PATCH, OPTIONS',
    'Access-Control-Allow-Headers': 'Content-Type, X-Manager-Token',
    'Access-Control-Max-Age': '86400',
    'Vary': 'Origin'
  };
  if (!origin) return { allowed: true, headers: base };
  if (list.includes('*')) return { allowed: true, headers: { ...base, 'Access-Control-Allow-Origin': '*' } };
  if (list.some((e) => originMatches(e, origin))) return { allowed: true, headers: { ...base, 'Access-Control-Allow-Origin': origin } };
  return { allowed: false, headers: base };
}

// ---------- row mapping (DB snake_case -> the API's camelCase booking shape) ----------
export function rowToBooking(r) {
  if (!r) return null;
  let services = [];
  try { services = JSON.parse(r.services); } catch { /* keep [] */ }
  const b = {
    id: r.id, refCode: r.ref_code, services,
    totalCost: r.total_cost, totalMin: r.total_min,
    barberId: r.barber_id, barberName: r.barber_name,
    date: r.date, time: r.time,
    clientName: r.client_name, clientPhone: r.client_phone,
    notes: r.notes || '',
    paymentMode: r.payment_mode, depositAmount: r.deposit_amount,
    status: r.status, paid: !!r.paid,
    createdAt: r.created_at
  };
  if (r.paid_at) b.paidAt = r.paid_at;
  if (r.updated_at) b.updatedAt = r.updated_at;
  if (r.late_minutes != null) b.lateMinutes = r.late_minutes;
  return b;
}

const getBooking = async (env, id) => rowToBooking(await env.DB.prepare('SELECT * FROM bookings WHERE id = ?').bind(id).first());

/** Mark a deposit booking paid and award its points. Safe to call twice: the loyalty index rejects a second award. */
async function markPaid(env, id) {
  const t = nowIso();
  await env.DB.batch([
    env.DB.prepare(
      `UPDATE bookings SET paid = 1, paid_at = ?1, updated_at = ?1,
         status = CASE WHEN status = 'Deposit Unpaid' THEN 'Paid' ELSE status END
       WHERE id = ?2 AND paid = 0`
    ).bind(t, id),
    env.DB.prepare(
      `INSERT OR IGNORE INTO loyalty_events (phone, booking_id, kind, points)
       SELECT customer_phone, id, 'deposit_paid', ?2 FROM bookings WHERE id = ?1`
    ).bind(id, DEPOSIT_POINTS)
  ]);
  return getBooking(env, id);
}

// ---------- shop settings (Manager Studio profile, shared by every client) ----------
// Before this, Manager Studio edits were saved only in the manager's own browser, so clients never
// saw a new shop name, review or barber. Now they live in one D1 row that every client loads.
// The manager can only write the fields listed here, each checked for type, length and format,
// because the client pages render them.
const SAFE_ID = /^[A-Za-z0-9_-]{1,40}$/;
const HEX_COLOR = /^#[0-9a-fA-F]{6}$/;
const DATA_IMAGE = /^data:image\/(png|jpeg|webp|gif);base64,[A-Za-z0-9+/]+={0,2}$/;
const MAX_IMAGE_CHARS = 400000;          // ~300 KB photo; the app shrinks uploads well below this
const MAX_SETTINGS_BYTES = 1500000;      // D1 rows top out at 2 MB
const MAX_BODY_BYTES = 2000000;

class SettingsError extends Error {}
const fail = (msg) => { throw new SettingsError(msg); };

function text(v, field, max, { required = false } = {}) {
  if (v === undefined || v === null) v = '';
  if (typeof v !== 'string') fail(`${field} must be text`);
  const t = v.trim();
  if (required && !t) fail(`${field} is required`);
  if (t.length > max) fail(`${field} must be at most ${max} characters`);
  return t;
}
function num(v, field, min, max, { int = false } = {}) {
  const n = typeof v === 'string' && v.trim() !== '' ? Number(v) : v;
  if (typeof n !== 'number' || !Number.isFinite(n) || n < min || n > max || (int && !Number.isInteger(n))) {
    fail(`${field} must be a ${int ? 'whole ' : ''}number from ${min} to ${max}`);
  }
  return n;
}
function bool(v, field) {
  if (typeof v !== 'boolean') fail(`${field} must be true or false`);
  return v;
}
function httpsUrl(v, field, { allowEmpty = true } = {}) {
  const t = text(v, field, 1000);
  if (!t && allowEmpty) return '';
  let u;
  try { u = new URL(t); } catch { fail(`${field} must be an https:// link`); }
  if (u.protocol !== 'https:' || u.username || u.password) fail(`${field} must be an https:// link`);
  return u.href;
}
function image(v, field) {
  if (typeof v === 'string' && v.startsWith('data:')) {
    if (v.length > MAX_IMAGE_CHARS) fail(`${field} photo is too large (max about 300 KB)`);
    if (!DATA_IMAGE.test(v)) fail(`${field} must be a PNG, JPEG, WebP or GIF photo`);
    return v;
  }
  return httpsUrl(v, field, { allowEmpty: false });
}
function list(v, field, max, { min = 0 } = {}) {
  if (!Array.isArray(v)) fail(`${field} must be a list`);
  if (v.length < min || v.length > max) fail(`${field} must have ${min ? `${min} to ` : 'at most '}${max} items`);
  v.forEach((x, i) => { if (!x || typeof x !== 'object' || Array.isArray(x)) fail(`${field}[${i}] must be an object`); });
  return v;
}
function uniqueIds(items, field) {
  const seen = new Set();
  for (const x of items) { if (seen.has(x.id)) fail(`${field} ids must be unique (${x.id})`); seen.add(x.id); }
  return items;
}

const SETTINGS_FIELDS = {
  shopName: (v) => text(v, 'shopName', 60, { required: true }),
  tagline: (v) => text(v, 'tagline', 120),
  phone: (v) => { const t = text(v, 'phone', 30); if (!/^[0-9+()\-. ]*$/.test(t)) fail('phone may only contain digits, spaces and + ( ) - .'); return t; },
  address: (v) => text(v, 'address', 200),
  primaryColor: (v) => { if (!HEX_COLOR.test(v)) fail('primaryColor must look like #1a1a2e'); return v.toLowerCase(); },
  accentColor: (v) => { if (!HEX_COLOR.test(v)) fail('accentColor must look like #d4af37'); return v.toLowerCase(); },
  depositAmount: (v) => num(v, 'depositAmount', 0, 500),
  requireDeposit: (v) => bool(v, 'requireDeposit'),
  paymentLinkUrl: (v) => httpsUrl(v, 'paymentLinkUrl'),
  reviewsAreSamples: (v) => bool(v, 'reviewsAreSamples'),
  reviews: (v) => list(v, 'reviews', 50).map((r, i) => ({
    name: text(r.name, `reviews[${i}].name`, 60) || 'Client',
    stars: num(Math.round(Number(r.stars)), `reviews[${i}].stars`, 1, 5, { int: true }),
    text: text(r.text, `reviews[${i}].text`, 600, { required: true })
  })),
  services: (v) => uniqueIds(list(v, 'services', 30, { min: 1 }).map((s, i) => {
    if (!SAFE_ID.test(s.id || '')) fail(`services[${i}].id must be letters, digits, - or _`);
    return {
      id: s.id,
      name: text(s.name, `services[${i}].name`, 100, { required: true }),
      price: num(s.price, `services[${i}].price`, 0, 10000),
      duration: num(s.duration, `services[${i}].duration`, 5, 480, { int: true }),
      category: text(s.category, `services[${i}].category`, 30),
      desc: text(s.desc, `services[${i}].desc`, 300)
    };
  }), 'services'),
  barbers: (v) => uniqueIds(list(v, 'barbers', 30, { min: 1 }).map((b, i) => {
    if (!SAFE_ID.test(b.id || '')) fail(`barbers[${i}].id must be letters, digits, - or _`);
    const folder = text(b.folder, `barbers[${i}].folder`, 80);
    if (!/^[a-z0-9_]*$/.test(folder)) fail(`barbers[${i}].folder must be lowercase letters, digits or _`);
    const photoFilename = text(b.photoFilename, `barbers[${i}].photoFilename`, 120);
    if (!/^[A-Za-z0-9_.-]*$/.test(photoFilename)) fail(`barbers[${i}].photoFilename has invalid characters`);
    return {
      id: b.id,
      firstName: text(b.firstName, `barbers[${i}].firstName`, 40),
      lastName: text(b.lastName, `barbers[${i}].lastName`, 40),
      name: text(b.name, `barbers[${i}].name`, 80, { required: true }),
      folder,
      photoFilename,
      role: text(b.role, `barbers[${i}].role`, 60),
      specialty: text(b.specialty, `barbers[${i}].specialty`, 80),
      rating: text(String(b.rating ?? ''), `barbers[${i}].rating`, 5),
      avatar: image(b.avatar, `barbers[${i}].avatar`)
    };
  }), 'barbers'),
  lookbook: (v) => list(v, 'lookbook', 40).map((l, i) => ({
    title: text(l.title, `lookbook[${i}].title`, 100, { required: true }),
    tag: text(l.tag, `lookbook[${i}].tag`, 30),
    img: image(l.img, `lookbook[${i}].img`)
  })),
  timeSlots: (v) => {
    if (!Array.isArray(v) || v.length < 1 || v.length > 48) fail('timeSlots must have 1 to 48 items');
    if (v.some((t) => !TIME_SLOT.test(String(t)))) fail('each time slot must look like "09:00 AM"');
    if (new Set(v).size !== v.length) fail('timeSlots must not repeat');
    return v.map(String);
  }
};
export const SHOP_SETTINGS_FIELDS = Object.keys(SETTINGS_FIELDS);

/** Returns { settings } with only the fields sent, each cleaned, or { error }. */
export function validateShopSettings(body) {
  if (!body || typeof body !== 'object' || Array.isArray(body)) return { error: 'Send the settings as a JSON object' };
  const unknown = Object.keys(body).filter((k) => !SETTINGS_FIELDS[k]);
  if (unknown.length) return { error: `Unknown settings: ${unknown.join(', ')}` };
  try {
    const settings = {};
    for (const [k, v] of Object.entries(body)) settings[k] = SETTINGS_FIELDS[k](v);
    return { settings };
  } catch (err) {
    if (err instanceof SettingsError) return { error: err.message };
    throw err;
  }
}

async function loadShopSettings(env) {
  const row = await env.DB.prepare('SELECT data, updated_at FROM shop_settings WHERE id = 1').first();
  if (!row) return { settings: null, updatedAt: null };
  try { return { settings: JSON.parse(row.data), updatedAt: row.updated_at }; } catch { return { settings: null, updatedAt: null }; }
}

async function getShop(env) {
  const res = json(await loadShopSettings(env));
  res.headers.set('Cache-Control', 'no-cache');
  return res;
}

async function managerPutShop(req, env) {
  if (Number(req.headers.get('Content-Length') || 0) > MAX_BODY_BYTES) return json({ error: 'Settings are too large' }, 413);
  const raw = await req.text();
  if (raw.length > MAX_BODY_BYTES) return json({ error: 'Settings are too large' }, 413);
  let body;
  try { body = JSON.parse(raw); } catch { return json({ error: 'Invalid JSON' }, 400); }
  const { settings, error } = validateShopSettings(body);
  if (error) return json({ error }, 400);
  // Fields not sent keep their saved value, so a client that only edits reviews can't wipe barbers.
  const current = (await loadShopSettings(env)).settings || {};
  const merged = { ...current, ...settings };
  const data = JSON.stringify(merged);
  if (enc.encode(data).length > MAX_SETTINGS_BYTES) return json({ error: 'Settings are too large (use smaller photos)' }, 413);
  const updatedAt = nowIso();
  await env.DB.prepare(
    `INSERT INTO shop_settings (id, data, updated_at) VALUES (1, ?1, ?2)
     ON CONFLICT(id) DO UPDATE SET data = excluded.data, updated_at = excluded.updated_at`
  ).bind(data, updatedAt).run();
  return json({ settings: merged, updatedAt });
}

// ---------- route handlers ----------
async function getSlots(url, env) {
  const date = url.searchParams.get('date'), barberId = url.searchParams.get('barberId');
  if (!isDate(date) || !barberId) return json({ error: 'date (YYYY-MM-DD) and barberId are required' }, 400);
  const { results } = await env.DB.prepare(
    `SELECT DISTINCT time FROM bookings WHERE date = ? AND barber_id = ? AND status <> 'Cancelled'`
  ).bind(date, barberId).all();
  return json({ booked: results.map((r) => r.time) });
}

const TIME_SLOT = /^(0[1-9]|1[0-2]):[0-5]\d (AM|PM)$/;   // the PWA's slot labels, e.g. "09:00 AM"
const BARBER_ID = /^[A-Za-z0-9_-]{1,40}$/;
const addDays = (n) => new Date(Date.now() + n * 86400000).toISOString().slice(0, 10);

export function validateBooking(body) {
  if (!body || typeof body !== 'object') return 'Invalid JSON';
  const missing = REQUIRED.filter((k) => body[k] === undefined || body[k] === null || body[k] === '');
  if (missing.length) return `Missing fields: ${missing.join(', ')}`;
  if (!Array.isArray(body.services) || !body.services.length || body.services.length > 10) return 'services must be a list of 1 to 10 items';
  if (body.services.some((x) => typeof x !== 'string' || !x.trim() || x.length > 100)) return 'each service must be text up to 100 characters';
  if (!isDate(body.date)) return 'date must be YYYY-MM-DD';
  // One day of slack before today covers time zones west of UTC.
  if (body.date < addDays(-1) || body.date > addDays(BOOK_AHEAD_DAYS)) return `date must be between today and ${BOOK_AHEAD_DAYS} days ahead`;
  if (!TIME_SLOT.test(String(body.time))) return 'time must look like "09:00 AM"';
  if (!BARBER_ID.test(String(body.barberId))) return 'barberId is invalid';
  if (String(body.barberName).length > 80) return 'barberName is too long';
  if (!['deposit', 'chair'].includes(body.paymentMode)) return 'paymentMode must be deposit or chair';
  if (!normalizePhone(body.clientPhone)) return 'clientPhone must contain digits';
  return null;
}

async function createBooking(req, env) {
  const body = await readBody(req);
  const problem = validateBooking(body);
  if (problem) return json({ error: problem }, 400);
  // Once the shop has published its settings, a booking must name one of its barbers and time
  // slots, and the barber's display name comes from the server rather than the client.
  const { settings: shop } = await loadShopSettings(env);
  let barberName = String(body.barberName);
  if (shop && Array.isArray(shop.barbers) && shop.barbers.length) {
    const barber = shop.barbers.find((b) => b.id === String(body.barberId));
    if (!barber) return json({ error: "barberId is not one of this shop's barbers" }, 400);
    barberName = barber.name;
  }
  if (shop && Array.isArray(shop.timeSlots) && shop.timeSlots.length && !shop.timeSlots.includes(String(body.time))) {
    return json({ error: "time is not one of this shop's time slots" }, 400);
  }
  const limited = await rateLimit(env, `book:${clientKey(req)}`, BOOKINGS_PER_HOUR, 3600);
  if (limited) return limited;

  const isDeposit = body.paymentMode === 'deposit';
  const phone = normalizePhone(body.clientPhone);
  const clientName = String(body.clientName).slice(0, 120);
  const clientPhone = String(body.clientPhone).slice(0, 40);
  const id = `${Date.now().toString(36)}-${crypto.randomUUID().slice(0, 8)}`;

  // One transaction: customer upsert + booking. If the slot is taken, the unique index fails the
  // INSERT and the whole batch rolls back. Points are NOT awarded here: pay-at-chair bookings earn
  // when the manager marks the visit Completed, deposits when the deposit is paid, so a script
  // booking fake appointments earns nothing.
  for (let attempt = 0; attempt < 5; attempt++) {
    const refCode = 'EC-' + String(Math.floor(1000 + Math.random() * 9000)) + (attempt > 2 ? String(attempt) : '');
    const stmts = [
      env.DB.prepare(
        `INSERT INTO customers (phone, name, phone_raw, last_visit) VALUES (?1, ?2, ?3, ?4)
         ON CONFLICT(phone) DO UPDATE SET name = excluded.name, phone_raw = excluded.phone_raw,
           last_visit = MAX(COALESCE(last_visit, ''), excluded.last_visit),
           updated_at = strftime('%Y-%m-%dT%H:%M:%fZ', 'now')`
      ).bind(phone, clientName, clientPhone, body.date),
      env.DB.prepare(
        `INSERT INTO bookings (id, ref_code, customer_phone, client_name, client_phone, services, total_cost, total_min,
           barber_id, barber_name, date, time, notes, payment_mode, deposit_amount, status, paid, created_at)
         VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11, ?12, ?13, ?14, ?15, ?16, 0, ?17)`
      ).bind(
        id, refCode, phone, clientName, clientPhone, JSON.stringify(body.services.map(String)),
        Number(body.totalCost) || 0, Number(body.totalMin) || 0,
        String(body.barberId), barberName, body.date, String(body.time),
        String(body.notes || '').slice(0, 500), body.paymentMode,
        isDeposit ? Number(body.depositAmount) || 0 : 0,
        isDeposit ? 'Deposit Unpaid' : 'Confirmed', nowIso()
      )
    ];
    try {
      await env.DB.batch(stmts);
      return json({ booking: await getBooking(env, id) }, 201);
    } catch (err) {
      if (isSlotConflict(err)) return json({ error: 'That time is already booked' }, 409);
      if (isRefConflict(err)) continue; // 1-in-9000 ref collision: roll a new one
      throw err;
    }
  }
  return json({ error: 'Could not allocate a reference code, try again' }, 503);
}

async function markLate(req, env) {
  const limited = await rateLimit(env, `late:${clientKey(req)}`, LATE_PER_HOUR, 3600);
  if (limited) return limited;
  const body = await readBody(req);
  const minutes = Math.round(Number(body && body.minutes));
  if (!body || !body.refCode || !normalizePhone(body.phone) || !(minutes >= 1 && minutes <= 90)) {
    return json({ error: 'refCode, phone and minutes (1-90) are required' }, 400);
  }
  // The phone acts as a light check that the caller owns this booking.
  const res = await env.DB.prepare(
    `UPDATE bookings SET late_minutes = ?1, updated_at = ?2
     WHERE ref_code = ?3 AND customer_phone = ?4 AND status NOT IN ('Cancelled', 'Completed', 'No-Show')`
  ).bind(minutes, nowIso(), String(body.refCode), normalizePhone(body.phone)).run();
  if (!res.meta || !res.meta.changes) return json({ error: 'No active booking found for that reference and phone' }, 404);
  const row = await env.DB.prepare('SELECT * FROM bookings WHERE ref_code = ?').bind(String(body.refCode)).first();
  return json({ booking: rowToBooking(row) });
}

async function managerLogin(req, env) {
  if (!env.MANAGER_PIN) return json({ error: 'MANAGER_PIN secret not configured' }, 500);
  // Brute-force guard: a 4-digit PIN must not be guessable by scripting this endpoint.
  const ip = clientKey(req);
  const now = nowIso();
  const row = await env.DB.prepare('SELECT fails, locked_until FROM login_attempts WHERE ip = ?').bind(ip).first();
  if (row && row.locked_until && row.locked_until > now) {
    const retry = Math.max(1, Math.ceil((Date.parse(row.locked_until) - Date.now()) / 1000));
    return json({ error: `Too many attempts. Try again in ${Math.ceil(retry / 60)} minutes.` }, 429, { 'Retry-After': String(retry) });
  }
  // Shop-wide cap: someone rotating through many addresses still gets only LOGIN_GLOBAL_MAX_FAILS guesses an hour.
  const hourAgo = new Date(Date.now() - 3600000).toISOString();
  const global = await env.DB.prepare('SELECT count, window_start FROM rate_limits WHERE bucket = ?').bind('login-fail:all').first();
  if (global && global.window_start > hourAgo && global.count >= LOGIN_GLOBAL_MAX_FAILS) {
    const retry = Math.max(1, Math.ceil((Date.parse(global.window_start) + 3600000 - Date.now()) / 1000));
    return json({ error: 'Too many failed logins. Try again later.' }, 429, { 'Retry-After': String(retry) });
  }
  const body = await readBody(req);
  if (!body || !timingSafeEqual(body.pin || '', env.MANAGER_PIN)) {
    await rateLimit(env, 'login-fail:all', LOGIN_GLOBAL_MAX_FAILS, 3600);
    const fails = (row && (!row.locked_until || row.locked_until <= now) ? row.fails : 0) + 1;
    const lockedUntil = fails >= LOGIN_MAX_FAILS ? new Date(Date.now() + LOGIN_LOCK_MINUTES * 60000).toISOString() : null;
    await env.DB.prepare(
      `INSERT INTO login_attempts (ip, fails, locked_until, updated_at) VALUES (?1, ?2, ?3, ?4)
       ON CONFLICT(ip) DO UPDATE SET fails = ?2, locked_until = ?3, updated_at = ?4`
    ).bind(ip, lockedUntil ? 0 : fails, lockedUntil, now).run();
    return json({ error: 'Invalid PIN' }, 401);
  }
  if (row) await env.DB.prepare('DELETE FROM login_attempts WHERE ip = ?').bind(ip).run();
  const token = randomToken();
  const expiresAt = new Date(Date.now() + SESSION_HOURS * 3600000).toISOString();
  await env.DB.batch([
    env.DB.prepare('DELETE FROM manager_sessions WHERE expires_at <= ?').bind(now), // tidy up old sessions
    env.DB.prepare('INSERT INTO manager_sessions (token_hash, expires_at, created_at) VALUES (?1, ?2, ?3)')
      .bind(await sha256Hex(token), expiresAt, now)
  ]);
  return json({ token, expiresAt });
}

async function managerLogout(req, env) {
  const sent = req.headers.get('X-Manager-Token') || '';
  await env.DB.prepare('DELETE FROM manager_sessions WHERE token_hash = ?').bind(await sha256Hex(sent)).run();
  return json({ ok: true });
}

const rangeFrom = (url) => ({
  from: isDate(url.searchParams.get('from')) ? url.searchParams.get('from') : today(),
  to: isDate(url.searchParams.get('to')) ? url.searchParams.get('to') : '9999-12-31'
});

async function managerBookings(url, env) {
  const { from, to } = rangeFrom(url);
  const { results } = await env.DB.prepare(
    `SELECT * FROM bookings WHERE date BETWEEN ?1 AND ?2 ORDER BY created_at DESC LIMIT 500`
  ).bind(from, to).all();
  return json({ bookings: results.map(rowToBooking), from, to });
}

async function managerPatchBooking(req, env, id) {
  const body = await readBody(req);
  if (!body || !STATUSES.includes(body.status)) return json({ error: `status must be one of: ${STATUSES.join(', ')}` }, 400);
  const booking = await getBooking(env, id);
  if (!booking) return json({ error: 'Booking not found' }, 404);
  if (body.status === 'Paid' && booking.paymentMode === 'deposit') await markPaid(env, id);
  try {
    const stmts = [env.DB.prepare('UPDATE bookings SET status = ?1, updated_at = ?2 WHERE id = ?3').bind(body.status, nowIso(), id)];
    if (body.status === 'Completed' && booking.paymentMode === 'chair') {
      // Pay-at-chair visits earn their points once the barber confirms the visit happened (once per booking).
      stmts.push(env.DB.prepare(
        `INSERT OR IGNORE INTO loyalty_events (phone, booking_id, kind, points)
         SELECT customer_phone, id, 'booking', ?2 FROM bookings WHERE id = ?1`
      ).bind(id, BOOKING_POINTS));
    }
    await env.DB.batch(stmts);
  } catch (err) {
    // e.g. un-cancelling a booking whose slot has since been re-booked
    if (isSlotConflict(err)) return json({ error: 'That slot has been re-booked by someone else' }, 409);
    throw err;
  }
  return json({ booking: await getBooking(env, id) });
}

/** Points = sum of the ledger; stamps = awards mod 11 (same 10-cut punch card as the KV version). */
const LOYALTY_SQL = `
  SELECT c.phone, c.name, c.phone_raw, c.last_visit,
         COALESCE(SUM(e.points), 0) AS points,
         COUNT(CASE WHEN e.kind IN ('booking', 'deposit_paid') THEN 1 END) % 11 AS stamps
  FROM customers c LEFT JOIN loyalty_events e ON e.phone = c.phone`;

async function managerLoyaltyCsv(env) {
  // A cell starting with = or @ (or + / - followed by letters) would run as a formula in Excel/Sheets, so it gets a ' prefix.
  const csvCell = (v) => { let t = String(v ?? ''); if (/^[=@\t\r]/.test(t) || /^[+-].*[A-Za-z]/.test(t)) t = "'" + t; return `"${t.replace(/"/g, '""')}"`; };
  const { results } = await env.DB.prepare(`${LOYALTY_SQL} GROUP BY c.phone ORDER BY points DESC`).all();
  const lines = ['name,phone,points,stamps,lastVisit'];
  for (const r of results) lines.push([csvCell(r.name), csvCell(r.phone_raw), r.points, r.stamps, csvCell(r.last_visit)].join(','));
  return new Response(lines.join('\n') + '\n', {
    headers: { 'Content-Type': 'text/csv; charset=utf-8', 'Content-Disposition': 'attachment; filename="loyalty.csv"' }
  });
}

async function managerReport(url, env) {
  const { from, to } = rangeFrom(url);
  const { results } = await env.DB.prepare(
    `SELECT date, barber_name AS barberName,
            COUNT(*) AS bookings,
            SUM(CASE WHEN status = 'Completed' THEN 1 ELSE 0 END) AS completed,
            SUM(CASE WHEN status = 'No-Show' THEN 1 ELSE 0 END) AS noShows,
            SUM(CASE WHEN status IN ('Completed', 'Paid', 'Confirmed') THEN total_cost ELSE 0 END) AS revenue
     FROM bookings WHERE date BETWEEN ?1 AND ?2 AND status <> 'Cancelled'
     GROUP BY date, barber_id ORDER BY date, barber_name`
  ).bind(from, to).all();
  return json({ rows: results, from, to });
}

async function getLoyalty(req, url, env) {
  const phone = normalizePhone(url.searchParams.get('phone'));
  if (!phone) return json({ error: 'phone is required' }, 400);
  const limited = await rateLimit(env, `loyalty:${clientKey(req)}`, LOOKUPS_PER_HOUR, 3600);
  if (limited) return limited;
  const rec = await env.DB.prepare(`${LOYALTY_SQL} WHERE c.phone = ? GROUP BY c.phone`).bind(phone).first();
  const { results } = await env.DB.prepare(
    `SELECT date, time, services, barber_name, ref_code, status FROM bookings
     WHERE customer_phone = ? ORDER BY date DESC, created_at DESC LIMIT 10`
  ).bind(phone).all();
  const history = results.map((r) => ({
    date: r.date, time: r.time, services: JSON.parse(r.services), barberName: r.barber_name, refCode: r.ref_code, status: r.status
  }));
  return json({ points: rec ? rec.points : 0, stamps: rec ? rec.stamps : 0, history });
}

export async function verifyStripeSignature(payload, header, secret, nowSec = Date.now() / 1000) {
  if (!header) return false;
  const parts = header.split(',').map((kv) => kv.trim());
  const t = Number((parts.find((p) => p.startsWith('t=')) || '').slice(2));
  if (!t || Math.abs(nowSec - t) > 300) return false; // 5-minute replay window, as Stripe recommends
  const expected = await hmacHex(secret, `${t}.${payload}`);
  return parts.filter((p) => p.startsWith('v1=')).some((p) => timingSafeEqual(p.slice(3), expected));
}

/** Fallback when no webhook secret is set: ask Stripe directly whether the session is really paid. */
async function fetchPaidStripeSession(env, sessionId) {
  if (!/^cs_[A-Za-z0-9_]+$/.test(sessionId || '')) return null;
  const res = await fetch(`https://api.stripe.com/v1/checkout/sessions/${sessionId}`, {
    headers: { Authorization: `Bearer ${env.STRIPE_SECRET_KEY}` }
  });
  if (!res.ok) return null;
  const session = await res.json();
  return session.payment_status === 'paid' ? session : null;
}

async function stripeWebhook(req, env) {
  const payload = await req.text();
  if (env.STRIPE_WEBHOOK_SECRET) {
    const ok = await verifyStripeSignature(payload, req.headers.get('Stripe-Signature'), env.STRIPE_WEBHOOK_SECRET);
    if (!ok) return json({ error: 'Invalid signature' }, 400);
  } else if (!env.STRIPE_SECRET_KEY) {
    // Never trust an unauthenticated "payment completed" claim: anyone could mark deposits paid.
    return json({ error: 'Stripe webhook not configured (set STRIPE_WEBHOOK_SECRET)' }, 503);
  }
  let event;
  try { event = JSON.parse(payload); } catch { return json({ error: 'Invalid JSON' }, 400); }
  if (event.type === 'checkout.session.completed') {
    let session = event.data && event.data.object;
    if (!env.STRIPE_WEBHOOK_SECRET) {
      session = await fetchPaidStripeSession(env, session && session.id);
      if (!session) return json({ error: 'Session not found or not paid' }, 400);
    }
    const refCode = session && session.client_reference_id;
    const row = refCode ? await env.DB.prepare('SELECT id FROM bookings WHERE ref_code = ?').bind(String(refCode)).first() : null;
    if (row) await markPaid(env, row.id);
  }
  return json({ received: true });
}

// ---------- router ----------
const SITE_URL = 'https://elite-cuts-4qn.pages.dev/';

const routes = [
  // People who open the API address in a browser land on the booking site instead of a bare 404.
  ['GET', /^\/?$/, (req, env) => Response.redirect(env.SITE_URL || SITE_URL, 302)],
  ['GET', /^\/api\/health$/, async (req, env) => {
    const r = await env.DB.prepare('SELECT COUNT(*) AS n FROM bookings').first();
    return json({ ok: true, time: nowIso(), bookings: r ? r.n : 0 });
  }],
  ['GET', /^\/api\/slots$/, (req, env, url) => getSlots(url, env)],
  ['POST', /^\/api\/bookings$/, (req, env) => createBooking(req, env)],
  ['POST', /^\/api\/bookings\/late$/, (req, env) => markLate(req, env)],
  ['GET', /^\/api\/loyalty$/, (req, env, url) => getLoyalty(req, url, env)],
  ['POST', /^\/api\/manager\/login$/, (req, env) => managerLogin(req, env)],
  ['POST', /^\/api\/manager\/logout$/, (req, env) => managerLogout(req, env), true],
  ['GET', /^\/api\/manager\/bookings$/, (req, env, url) => managerBookings(url, env), true],
  ['PATCH', /^\/api\/manager\/bookings\/([^/]+)$/, (req, env, url, m) => managerPatchBooking(req, env, decodeURIComponent(m[1])), true],
  ['GET', /^\/api\/manager\/loyalty\.csv$/, (req, env) => managerLoyaltyCsv(env), true],
  ['GET', /^\/api\/manager\/report$/, (req, env, url) => managerReport(url, env), true],
  ['GET', /^\/api\/shop$/, (req, env) => getShop(env)],
  ['PUT', /^\/api\/manager\/shop$/, (req, env) => managerPutShop(req, env), true],
  ['POST', /^\/api\/webhook\/stripe$/, (req, env) => stripeWebhook(req, env)]
];

export default {
  async fetch(req, env) {
    const url = new URL(req.url);
    const { allowed, headers: corsHeaders } = cors(req, env);
    if (!allowed) return json({ error: 'Origin not allowed' }, 403, corsHeaders);
    if (req.method === 'OPTIONS') return new Response(null, { status: 204, headers: corsHeaders });
    let res;
    try {
      const route = routes.find(([m, re]) => m === req.method && re.test(url.pathname));
      if (!route) {
        res = json({ error: 'Not found' }, 404);
      } else {
        const [, re, handler, needsManager] = route;
        res = needsManager ? await requireManager(req, env) : null;
        if (!res) res = await handler(req, env, url, url.pathname.match(re));
      }
    } catch (err) {
      console.error(err);
      res = json({ error: 'Internal error' }, 500);
    }
    const headers = new Headers(res.headers);
    for (const [k, v] of Object.entries(corsHeaders)) headers.set(k, v);
    return new Response(res.body, { status: res.status, headers });
  }
};
