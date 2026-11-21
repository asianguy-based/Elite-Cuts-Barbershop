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
 *   PATCH /api/manager/bookings/:id { status }               -> { booking, creditReturned?, email? } (X-Manager-Token)
 *   POST  /api/manager/bookings/clear-cancelled              -> { cleared }  hides cancelled bookings from the queue
 *   POST  /api/reviews          { name, stars, text }        -> 201 { ok }  a client leaves a review (not shown until ticked)
 *   GET   /api/manager/reviews                               -> { reviews, unread }     (X-Manager-Token)
 *   POST  /api/manager/reviews  { name, stars, text, shown } -> { review, settings }    the manager adds one
 *   PATCH /api/manager/reviews/:id { shown }                 -> { review, settings }    ticked reviews are published
 *   DELETE /api/manager/reviews/:id                          -> { ok, settings }        (X-Manager-Token)
 *   POST  /api/manager/reviews/read                          -> { ok }  marks every review as read
 *   GET   /api/manager/loyalty.csv                           -> text/csv                 (X-Manager-Token)
 *   GET   /api/manager/report?from&to                        -> { rows }   (new: per-day, per-barber totals)
 *   GET   /api/shop                                          -> { settings, updatedAt }  (public shop profile)
 *   PUT   /api/manager/shop     { ...settings }              -> { settings, updatedAt }  (X-Manager-Token)
 *   POST  /api/webhook/stripe                                -> { received: true }
 *   GET   /api/payments                                      -> { stripe, testMode, ... }  (which online options work)
 *   POST  /api/wallet          { phone, pin }                -> { balance, history }    (VIP wallet credit)
 *   POST  /api/wallet/topup    { phone, pin, amount, name }  -> { checkoutUrl }
 *   GET   /api/manager/wallets                               -> { wallets }             (X-Manager-Token)
 *   POST  /api/manager/wallets/:phone/adjust { amount, note } -> { balance }            (X-Manager-Token)
 *   POST  /api/manager/wallets/:phone/reset-pin               -> { ok }                 (X-Manager-Token)
 *
 * Payments (see migrations/0001_payments.sql): POST /api/bookings takes paymentMode
 *   deposit | prepay | wallet | chair. Deposit and prepay open a Stripe Checkout page (amounts are worked out
 *   here from the published shop settings, never taken from the client); wallet bookings are paid from the
 *   client's store credit on the spot. Webhooks mark bookings paid and credit wallet top-ups.
 *
 * Secrets: MANAGER_PIN (required)
 *          STRIPE_SECRET_KEY — creates Checkout pages. TEST keys only (sk_test_/rk_test_): a live key is
 *            ignored for checkout unless the var STRIPE_ALLOW_LIVE is "true". Also re-checks webhooks
 *            when there is no webhook secret.
 *          STRIPE_WEBHOOK_SECRET (recommended) — verifies Stripe webhook signatures
 *            With neither secret, webhooks are refused.
 *          RESEND_API_KEY (optional) — sends the "your credit is back" email through Resend (resend.com).
 *            Needs the var EMAIL_FROM too, e.g. "Elite Cuts <bookings@elite-cuts-barbershop.app>", on a domain
 *            verified in Resend. Without both, no email is sent and the manager is told so.
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
const PAY_OPTIONS = ['deposit', 'prepay', 'wallet', 'chair'];
const DEFAULT_DEPOSIT = 15;        // dollars, when the shop hasn't published its own deposit amount
const CHECKOUT_MINUTES = 31;       // Stripe's minimum Checkout lifetime is 30 minutes; unpaid bookings free up after it
// The wallet is in-house store credit: what a client loads can't be cashed out or refunded to a card.
export const WALLET_TERMS = "VIP wallet credit is non-refundable store credit, good for cuts and products only. It can't be cashed out or refunded to your card.";
const WALLET_MIN_TOPUP = 5, WALLET_MAX_TOPUP = 500;   // whole dollars per top-up
const WALLET_PIN = /^\d{4,6}$/;
const WALLET_PER_HOUR = 30;        // wallet balance checks / top-ups per client address per hour
const WALLET_PIN_MAX_FAILS = 5;
const REVIEWS_PER_HOUR = 3;        // reviews a client address may leave per hour
const MAX_REVIEWS_SHOWN = 50;      // the published settings hold at most this many (same cap as the validator)
const EMAIL_RE = /^[^\s@<>()",;:]+@[^\s@<>()",;:]+\.[A-Za-z]{2,}$/;    // wrong wallet PINs per phone before a lockout
const PBKDF2_ITERATIONS = 100000;  // the most Workers' WebCrypto allows
const enc = new TextEncoder();

// ---------- small helpers (exported for unit tests) ----------
export const json = (data, status = 200, headers = {}) =>
  new Response(JSON.stringify(data), { status, headers: { 'Content-Type': 'application/json', ...headers } });

const today = () => new Date().toISOString().slice(0, 10);
export const normalizePhone = (p) => String(p || '').replace(/\D/g, '');
export const isEmail = (s) => typeof s === 'string' && s.length <= 120 && EMAIL_RE.test(s.trim());
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
    'Access-Control-Allow-Methods': 'GET, POST, PUT, PATCH, DELETE, OPTIONS',
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
  b.payOption = r.pay_option || r.payment_mode;
  if (r.amount_due) b.amountDue = r.amount_due;
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
  // Which online payment options clients see (each one on by default until the manager turns it off).
  depositEnabled: (v) => bool(v, 'depositEnabled'),
  prepayEnabled: (v) => bool(v, 'prepayEnabled'),
  walletEnabled: (v) => bool(v, 'walletEnabled'),
  walletTopUps: (v) => {
    if (!Array.isArray(v) || v.length < 1 || v.length > 6) fail('walletTopUps must have 1 to 6 amounts');
    const out = v.map((n, i) => num(n, `walletTopUps[${i}]`, WALLET_MIN_TOPUP, WALLET_MAX_TOPUP, { int: true }));
    if (new Set(out).size !== out.length) fail('walletTopUps must not repeat');
    return out.sort((a, b) => a - b);
  },
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
  if (Array.isArray(settings.reviews)) {
    // An older app (or a settings backup) sent the whole published list: keep the Client Reviews log in step.
    await syncReviewLog(env, settings.reviews);
    const published = await publishShownReviews(env);
    return json({ settings: published, updatedAt });
  }
  return json({ settings: merged, updatedAt });
}

/** Make the log's ticked reviews match a published list: new ones are added ticked, missing ones unticked (kept). */
async function syncReviewLog(env, list) {
  const key = (r) => `${r.name}\u0000${r.stars}\u0000${r.text}`;
  const wanted = new Set(list.map(key));
  const { results } = await env.DB.prepare('SELECT id, name, stars, text, shown FROM reviews').all();
  const have = new Set(results.map(key));
  const now = nowIso();
  const stmts = [];
  for (const r of results) {
    const keep = wanted.has(key(r)) ? 1 : 0;
    if (keep !== r.shown) stmts.push(env.DB.prepare('UPDATE reviews SET shown = ?1 WHERE id = ?2').bind(keep, r.id));
  }
  for (const r of list) {
    if (have.has(key(r))) continue;
    have.add(key(r));
    stmts.push(env.DB.prepare(`INSERT INTO reviews (name, stars, text, source, shown, read_at) VALUES (?1, ?2, ?3, 'manager', 1, ?4)`)
      .bind(r.name, r.stars, r.text, now));
  }
  if (stmts.length) await env.DB.batch(stmts);
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
  if (!PAY_OPTIONS.includes(body.paymentMode)) return 'paymentMode must be deposit, prepay, wallet or chair';
  if (!normalizePhone(body.clientPhone)) return 'clientPhone must contain digits';
  if (body.clientEmail != null && body.clientEmail !== '' && !isEmail(body.clientEmail)) return 'clientEmail does not look like an email address';
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
  // Payment option: must be one the shop offers, and its amount is worked out here, never from the client.
  const option = body.paymentMode;
  const stripe = stripeKeyInfo(env);
  if (shop && shop.requireDeposit && option === 'chair') return json({ error: 'This shop asks for payment when you book' }, 400);
  if (option !== 'chair' && shop && shop[`${option}Enabled`] === false) return json({ error: `${option} payments are turned off for this shop` }, 400);
  let totalCost = Number(body.totalCost) || 0;
  if (option === 'prepay' || option === 'wallet') {
    const priced = priceServices(shop, body.services);
    if (priced.error) return json({ error: priced.error }, 400);
    totalCost = priced.total;
  }
  if (option === 'prepay' && !stripe.usable) return json({ error: 'Online prepay is not set up for this shop yet' }, 503);
  // Deposits go through Stripe Checkout when a test key is set; otherwise the old payment-link flow (client-sent amount).
  const checkout = (option === 'deposit' && stripe.usable) || option === 'prepay';
  let amountDue = 0;
  if (option === 'deposit') {
    amountDue = checkout ? depositFor(shop) : Number(body.depositAmount) || 0;
    if (checkout && !(amountDue > 0)) return json({ error: 'This shop has no deposit amount set' }, 400);
  } else if (option === 'prepay' || option === 'wallet') {
    amountDue = totalCost;
  }
  if (checkout && Math.round(amountDue * 100) < 50) return json({ error: 'Online payments must be at least $0.50' }, 400);

  let wallet = null;
  if (option === 'wallet') {
    if (!(amountDue > 0)) return json({ error: 'Nothing to pay from the wallet' }, 400);
    const walletLimited = await rateLimit(env, `wallet:${clientKey(req)}`, WALLET_PER_HOUR, 3600);
    if (walletLimited) return walletLimited;
    wallet = await checkWalletPin(env, normalizePhone(body.clientPhone), body.walletPin, { mustExist: true });
    if (wallet.response) return wallet.response;
  }

  const limited = await rateLimit(env, `book:${clientKey(req)}`, BOOKINGS_PER_HOUR, 3600);
  if (limited) return limited;

  const online = option !== 'chair';
  const phone = normalizePhone(body.clientPhone);
  const clientName = String(body.clientName).slice(0, 120);
  const clientPhone = String(body.clientPhone).slice(0, 40);
  const clientEmail = body.clientEmail ? String(body.clientEmail).trim() : '';
  const id = `${Date.now().toString(36)}-${crypto.randomUUID().slice(0, 8)}`;
  const createdAt = nowIso();

  // One transaction: customer upsert + booking (+ wallet spend). If the slot is taken, the unique index fails
  // the INSERT and the whole batch rolls back. Points are NOT awarded for unpaid bookings: pay-at-chair visits
  // earn when the manager marks them Completed, online ones when the payment lands, so a script booking fake
  // appointments earns nothing.
  for (let attempt = 0; attempt < 5; attempt++) {
    const refCode = 'EC-' + String(Math.floor(1000 + Math.random() * 9000)) + (attempt > 2 ? String(attempt) : '');
    const stmts = [
      env.DB.prepare(
        `INSERT INTO customers (phone, name, phone_raw, last_visit, email) VALUES (?1, ?2, ?3, ?4, ?5)
         ON CONFLICT(phone) DO UPDATE SET name = excluded.name, phone_raw = excluded.phone_raw,
           last_visit = MAX(COALESCE(last_visit, ''), excluded.last_visit),
           email = CASE WHEN excluded.email <> '' THEN excluded.email ELSE email END,
           updated_at = strftime('%Y-%m-%dT%H:%M:%fZ', 'now')`
      ).bind(phone, clientName, clientPhone, body.date, clientEmail),
      env.DB.prepare(
        `INSERT INTO bookings (id, ref_code, customer_phone, client_name, client_phone, services, total_cost, total_min,
           barber_id, barber_name, date, time, notes, payment_mode, deposit_amount, status, paid, created_at,
           pay_option, amount_due, paid_at)
         VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11, ?12, ?13, ?14, ?15, ?16, ?17, ?18, ?19, ?20, ?21)`
      ).bind(
        id, refCode, phone, clientName, clientPhone, JSON.stringify(body.services.map(String)),
        totalCost, Number(body.totalMin) || 0,
        String(body.barberId), barberName, body.date, String(body.time),
        String(body.notes || '').slice(0, 500), online ? 'deposit' : 'chair',
        amountDue,
        option === 'wallet' ? 'Paid' : online ? 'Deposit Unpaid' : 'Confirmed',
        option === 'wallet' ? 1 : 0, createdAt, option, amountDue,
        option === 'wallet' ? createdAt : null
      )
    ];
    if (option === 'wallet') {
      // Spend only if the balance covers it: otherwise the amount is NULL, the NOT NULL column refuses it
      // and the whole batch (booking included) rolls back. Then award the paid-booking points.
      stmts.push(env.DB.prepare(
        `INSERT INTO wallet_ledger (phone, kind, amount_cents, booking_id, note)
         VALUES (?1, 'spend', CASE WHEN (SELECT COALESCE(SUM(amount_cents), 0) FROM wallet_ledger WHERE phone = ?1) >= ?2
                                   THEN -?2 ELSE NULL END, ?3, ?4)`
      ).bind(phone, Math.round(amountDue * 100), id, refCode));
      stmts.push(env.DB.prepare(
        `INSERT OR IGNORE INTO loyalty_events (phone, booking_id, kind, points) VALUES (?1, ?2, 'deposit_paid', ?3)`
      ).bind(phone, id, DEPOSIT_POINTS));
    }
    try {
      await env.DB.batch(stmts);
    } catch (err) {
      if (isSlotConflict(err)) return json({ error: 'That time is already booked' }, 409);
      if (isRefConflict(err)) continue; // 1-in-9000 ref collision: roll a new one
      if (isWalletShort(err)) return json({ error: 'Not enough wallet credit for this booking. Top up in the VIP Wallet tab or pick another way to pay.' }, 402);
      throw err;
    }
    if (!checkout) return json({ booking: await getBooking(env, id) }, 201);

    // Stripe Checkout for the deposit or the full price. If Stripe can't be reached, drop the booking so the
    // chair isn't held by a booking nobody can pay for.
    const site = siteUrl(req, env);
    const session = await createCheckoutSession(env, {
      amountCents: Math.round(amountDue * 100),
      name: option === 'prepay' ? `Prepaid: ${body.services.join(' + ')}`.slice(0, 250) : `Booking deposit ${refCode}`,
      description: `${barberName}, ${body.date} at ${body.time}`.slice(0, 250),
      refCode,
      metadata: { kind: 'booking', booking_id: id, pay_option: option },
      successUrl: `${site}/?tab=loyalty&paid=${encodeURIComponent(refCode)}`,
      cancelUrl: `${site}/?tab=book&payment=cancelled&ref=${encodeURIComponent(refCode)}`,
      idempotencyKey: `booking-${id}`
    });
    if (!session) {
      await env.DB.prepare('DELETE FROM bookings WHERE id = ?').bind(id).run();
      return json({ error: 'Could not start the online payment. Please try again or pick another way to pay.' }, 502);
    }
    await env.DB.prepare('UPDATE bookings SET stripe_session_id = ?1 WHERE id = ?2').bind(session.id, id).run();
    return json({ booking: await getBooking(env, id), checkoutUrl: session.url, testMode: stripe.testMode }, 201);
  }
  return json({ error: 'Could not allocate a reference code, try again' }, 503);
}

// ---------- payments: Stripe Checkout + VIP wallet ----------
const isWalletShort = (err) => /NOT NULL constraint failed: wallet_ledger\.amount_cents/.test(String(err && err.message || err));

/** Which Stripe key may create Checkout pages. Only test keys, unless STRIPE_ALLOW_LIVE is "true". */
export function stripeKeyInfo(env) {
  const key = String(env.STRIPE_SECRET_KEY || '').trim();
  if (!key) return { usable: false, testMode: false, reason: 'not_configured' };
  const testMode = /^(sk|rk)_test_/.test(key);
  if (!testMode && env.STRIPE_ALLOW_LIVE !== 'true') return { usable: false, testMode: false, reason: 'live_key_blocked' };
  return { usable: true, testMode, key };
}

const depositFor = (shop) => (shop && typeof shop.depositAmount === 'number' ? shop.depositAmount : DEFAULT_DEPOSIT);

/** Total price of the named services, from the shop's published price list. */
export function priceServices(shop, names) {
  if (!shop || !Array.isArray(shop.services) || !shop.services.length) {
    return { error: 'The shop must publish its services (Manager Studio, Apply Settings) before clients can pay online in full' };
  }
  let total = 0;
  for (const n of names) {
    const s = shop.services.find((x) => x.name === String(n));
    if (!s) return { error: `"${String(n).slice(0, 60)}" is not one of this shop's services` };
    total += Number(s.price) || 0;
  }
  return { total: Math.round(total * 100) / 100 };
}

/** Where Stripe sends the client back to: the calling site when it's on the allow-list, else SITE_URL. */
function siteUrl(req, env) {
  const origin = req.headers.get('Origin');
  if (origin && allowedOrigins(env).some((e) => e !== '*' && originMatches(e, origin))) return origin;
  return String(env.SITE_URL || 'https://elite-cuts-barbershop.app').replace(/\/+$/, '');
}

/** POST /v1/checkout/sessions with an inline price. Returns { id, url } or null. */
async function createCheckoutSession(env, { amountCents, name, description, submitMessage, refCode, metadata, successUrl, cancelUrl, idempotencyKey }) {
  const { usable, key } = stripeKeyInfo(env);
  if (!usable) return null;
  const form = new URLSearchParams({
    mode: 'payment',
    'line_items[0][quantity]': '1',
    'line_items[0][price_data][currency]': 'usd',
    'line_items[0][price_data][unit_amount]': String(amountCents),
    'line_items[0][price_data][product_data][name]': name,
    success_url: successUrl,
    cancel_url: cancelUrl,
    expires_at: String(Math.floor(Date.now() / 1000) + CHECKOUT_MINUTES * 60)
  });
  if (description) form.set('line_items[0][price_data][product_data][description]', description);
  if (submitMessage) form.set('custom_text[submit][message]', submitMessage);   // shown next to the Pay button
  if (refCode) form.set('client_reference_id', refCode);
  for (const [k, v] of Object.entries(metadata || {})) {
    form.set(`metadata[${k}]`, String(v));
    form.set(`payment_intent_data[metadata][${k}]`, String(v));
  }
  try {
    const res = await fetch('https://api.stripe.com/v1/checkout/sessions', {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${key}`,
        'Content-Type': 'application/x-www-form-urlencoded',
        'Idempotency-Key': idempotencyKey
      },
      body: form.toString()
    });
    const data = await res.json().catch(() => ({}));
    if (!res.ok || !data.id || !data.url) {
      console.error('Stripe checkout failed', res.status, data && data.error && data.error.message);
      return null;
    }
    return { id: data.id, url: data.url };
  } catch (err) {
    console.error('Stripe checkout failed', err);
    return null;
  }
}

async function paymentsInfo(env) {
  const { settings: shop } = await loadShopSettings(env);
  const stripe = stripeKeyInfo(env);
  const walletOn = !shop || shop.walletEnabled !== false;
  return json({
    stripe: stripe.usable,
    testMode: stripe.testMode,
    liveKeyBlocked: stripe.reason === 'live_key_blocked',
    options: {
      deposit: !shop || shop.depositEnabled !== false,
      prepay: stripe.usable && (!shop || shop.prepayEnabled !== false),
      wallet: walletOn,
      walletTopUp: stripe.usable && walletOn
    },
    depositAmount: depositFor(shop),
    walletTopUps: (shop && shop.walletTopUps) || [25, 50, 100]
  });
}

// Wallet PINs: PBKDF2-SHA256 with a random salt, so a leaked table doesn't give the PINs away cheaply.
async function hashPin(pin, saltHex) {
  const salt = saltHex || hex(crypto.getRandomValues(new Uint8Array(16)));
  const key = await crypto.subtle.importKey('raw', enc.encode(String(pin)), 'PBKDF2', false, ['deriveBits']);
  const bits = await crypto.subtle.deriveBits(
    { name: 'PBKDF2', hash: 'SHA-256', salt: enc.encode(salt), iterations: PBKDF2_ITERATIONS }, key, 256);
  return { hash: hex(bits), salt };
}

/**
 * Checks the wallet PIN for a phone. An account without a PIN (new, or reset by the manager) takes the PIN
 * sent as its new one. Wrong PINs lock that wallet for LOGIN_LOCK_MINUTES after WALLET_PIN_MAX_FAILS tries.
 * Returns { account } or { response } (an error to send back).
 */
async function checkWalletPin(env, phone, pin, { mustExist = false, create = false, name = '' } = {}) {
  if (!phone) return { response: json({ error: 'phone is required' }, 400) };
  if (!WALLET_PIN.test(String(pin || ''))) return { response: json({ error: 'Wallet PIN must be 4 to 6 digits' }, 400) };
  const lockKey = `wallet:${phone}`;
  const now = nowIso();
  const lock = await env.DB.prepare('SELECT fails, locked_until FROM login_attempts WHERE ip = ?').bind(lockKey).first();
  if (lock && lock.locked_until && lock.locked_until > now) {
    const retry = Math.max(1, Math.ceil((Date.parse(lock.locked_until) - Date.now()) / 1000));
    return { response: json({ error: `Too many wrong PINs. Try again in ${Math.ceil(retry / 60)} minutes.` }, 429, { 'Retry-After': String(retry) }) };
  }
  let account = await env.DB.prepare('SELECT * FROM wallet_accounts WHERE phone = ?').bind(phone).first();
  if (!account) {
    if (mustExist || !create) return { response: json({ error: 'No wallet credit for this phone yet. Top up in the VIP Wallet tab first.' }, 404) };
    const { hash, salt } = await hashPin(pin);
    await env.DB.prepare('INSERT OR IGNORE INTO wallet_accounts (phone, name, pin_hash, pin_salt) VALUES (?1, ?2, ?3, ?4)')
      .bind(phone, String(name || '').slice(0, 120), hash, salt).run();
    account = await env.DB.prepare('SELECT * FROM wallet_accounts WHERE phone = ?').bind(phone).first();
    return { account };
  }
  if (!account.pin_hash) {
    const { hash, salt } = await hashPin(pin);
    await env.DB.prepare('UPDATE wallet_accounts SET pin_hash = ?1, pin_salt = ?2, updated_at = ?3 WHERE phone = ?4 AND pin_hash IS NULL')
      .bind(hash, salt, now, phone).run();
    account = await env.DB.prepare('SELECT * FROM wallet_accounts WHERE phone = ?').bind(phone).first();
  }
  const { hash } = await hashPin(pin, account.pin_salt);
  if (!timingSafeEqual(hash, account.pin_hash)) {
    const fails = (lock && (!lock.locked_until || lock.locked_until <= now) ? lock.fails : 0) + 1;
    const lockedUntil = fails >= WALLET_PIN_MAX_FAILS ? new Date(Date.now() + LOGIN_LOCK_MINUTES * 60000).toISOString() : null;
    await env.DB.prepare(
      `INSERT INTO login_attempts (ip, fails, locked_until, updated_at) VALUES (?1, ?2, ?3, ?4)
       ON CONFLICT(ip) DO UPDATE SET fails = ?2, locked_until = ?3, updated_at = ?4`
    ).bind(lockKey, lockedUntil ? 0 : fails, lockedUntil, now).run();
    return { response: json({ error: 'Wrong wallet PIN' }, 401) };
  }
  if (lock) await env.DB.prepare('DELETE FROM login_attempts WHERE ip = ?').bind(lockKey).run();
  return { account };
}

const walletBalanceCents = async (env, phone) =>
  (await env.DB.prepare('SELECT COALESCE(SUM(amount_cents), 0) AS c FROM wallet_ledger WHERE phone = ?').bind(phone).first()).c;

async function walletLookup(req, env) {
  const limited = await rateLimit(env, `wallet:${clientKey(req)}`, WALLET_PER_HOUR, 3600);
  if (limited) return limited;
  const body = await readBody(req);
  const phone = normalizePhone(body && body.phone);
  const { response } = await checkWalletPin(env, phone, body && body.pin, { mustExist: true });
  if (response) return response;
  const { results } = await env.DB.prepare(
    'SELECT kind, amount_cents, note, created_at FROM wallet_ledger WHERE phone = ? ORDER BY id DESC LIMIT 10'
  ).bind(phone).all();
  return json({
    balance: (await walletBalanceCents(env, phone)) / 100,
    history: results.map((r) => ({ kind: r.kind, amount: r.amount_cents / 100, note: r.note, at: r.created_at }))
  });
}

async function walletTopUp(req, env) {
  const limited = await rateLimit(env, `wallet:${clientKey(req)}`, WALLET_PER_HOUR, 3600);
  if (limited) return limited;
  const stripe = stripeKeyInfo(env);
  if (!stripe.usable) return json({ error: 'Online top-ups are not set up for this shop yet' }, 503);
  const { settings: shop } = await loadShopSettings(env);
  if (shop && shop.walletEnabled === false) return json({ error: 'The VIP wallet is turned off for this shop' }, 400);
  const body = await readBody(req);
  const phone = normalizePhone(body && body.phone);
  const amount = Number(body && body.amount);
  if (!Number.isInteger(amount) || amount < WALLET_MIN_TOPUP || amount > WALLET_MAX_TOPUP) {
    return json({ error: `Top-up must be a whole dollar amount from $${WALLET_MIN_TOPUP} to $${WALLET_MAX_TOPUP}` }, 400);
  }
  const { response } = await checkWalletPin(env, phone, body.pin, { create: true, name: body.name });
  if (response) return response;
  const site = siteUrl(req, env);
  const session = await createCheckoutSession(env, {
    amountCents: amount * 100,
    name: `VIP wallet credit ($${amount})`,
    description: `Non-refundable store credit for ${String((shop && shop.shopName) || 'the shop').slice(0, 60)}. Good for cuts and products only.`,
    submitMessage: WALLET_TERMS,
    metadata: { kind: 'wallet_topup', phone },
    successUrl: `${site}/?tab=loyalty&topup=ok`,
    cancelUrl: `${site}/?tab=loyalty&topup=cancelled`,
    idempotencyKey: `topup-${phone}-${crypto.randomUUID()}`
  });
  if (!session) return json({ error: 'Could not start the online payment. Please try again.' }, 502);
  return json({ checkoutUrl: session.url, testMode: stripe.testMode });
}

async function managerWallets(env) {
  const { results } = await env.DB.prepare(
    `SELECT a.phone, a.name, a.pin_hash IS NOT NULL AS has_pin, COALESCE(SUM(l.amount_cents), 0) AS cents,
            MAX(l.created_at) AS last_activity
     FROM wallet_accounts a LEFT JOIN wallet_ledger l ON l.phone = a.phone
     GROUP BY a.phone ORDER BY cents DESC LIMIT 500`
  ).all();
  return json({ wallets: results.map((r) => ({ phone: r.phone, name: r.name, balance: r.cents / 100, hasPin: !!r.has_pin, lastActivity: r.last_activity })) });
}

async function managerWalletAdjust(req, env, phoneParam) {
  const phone = normalizePhone(phoneParam);
  const body = await readBody(req);
  const amount = Number(body && body.amount);
  if (!phone) return json({ error: 'phone is required' }, 400);
  if (!Number.isFinite(amount) || amount === 0 || Math.abs(amount) > 1000) return json({ error: 'amount must be a dollar amount from -1000 to 1000 (not 0)' }, 400);
  const cents = Math.round(amount * 100);
  const customer = await env.DB.prepare('SELECT name FROM customers WHERE phone = ?').bind(phone).first();
  try {
    await env.DB.batch([
      env.DB.prepare('INSERT OR IGNORE INTO wallet_accounts (phone, name) VALUES (?1, ?2)').bind(phone, (customer && customer.name) || ''),
      // A deduction can't take the balance below zero (same NULL trick as a booking spend).
      env.DB.prepare(
        `INSERT INTO wallet_ledger (phone, kind, amount_cents, note)
         VALUES (?1, 'adjustment', CASE WHEN ?2 > 0 OR (SELECT COALESCE(SUM(amount_cents), 0) FROM wallet_ledger WHERE phone = ?1) >= -?2
                                        THEN ?2 ELSE NULL END, ?3)`
      ).bind(phone, cents, String((body && body.note) || 'Manager adjustment').slice(0, 200))
    ]);
  } catch (err) {
    if (isWalletShort(err)) return json({ error: 'That would take the wallet below $0' }, 400);
    throw err;
  }
  return json({ balance: (await walletBalanceCents(env, phone)) / 100 });
}

async function managerWalletResetPin(env, phoneParam) {
  const phone = normalizePhone(phoneParam);
  const r = await env.DB.prepare('UPDATE wallet_accounts SET pin_hash = NULL, pin_salt = NULL, updated_at = ?1 WHERE phone = ?2')
    .bind(nowIso(), phone).run();
  if (!r.meta || !r.meta.changes) return json({ error: 'No wallet for that phone' }, 404);
  await env.DB.prepare('DELETE FROM login_attempts WHERE ip = ?').bind(`wallet:${phone}`).run();
  return json({ ok: true });
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
    `SELECT * FROM bookings WHERE date BETWEEN ?1 AND ?2 AND cleared_at IS NULL ORDER BY created_at DESC LIMIT 500`
  ).bind(from, to).all();
  return json({ bookings: results.map(rowToBooking), from, to });
}

async function managerPatchBooking(req, env, id) {
  const body = await readBody(req);
  if (!body || !STATUSES.includes(body.status)) return json({ error: `status must be one of: ${STATUSES.join(', ')}` }, 400);
  const booking = await getBooking(env, id);
  if (!booking) return json({ error: 'Booking not found' }, 404);
  if (body.status === 'Paid' && booking.paymentMode === 'deposit') await markPaid(env, id);
  // A booking paid from the VIP wallet goes back on the wallet when it's cancelled (once per booking).
  // Card payments (deposit / prepay) are refunded by the shop in the Stripe dashboard.
  let refund = null;
  if (body.status === 'Cancelled' && booking.payOption === 'wallet') {
    const spend = await env.DB.prepare(`SELECT phone, -amount_cents AS cents FROM wallet_ledger WHERE booking_id = ? AND kind = 'spend'`).bind(id).first();
    const done = await env.DB.prepare(`SELECT 1 AS x FROM wallet_ledger WHERE booking_id = ? AND kind = 'refund'`).bind(id).first();
    if (spend && !done && spend.cents > 0) refund = spend;
  }
  try {
    const stmts = [env.DB.prepare('UPDATE bookings SET status = ?1, updated_at = ?2 WHERE id = ?3').bind(body.status, nowIso(), id)];
    if (refund) {
      // Once the credit is back, the client's phone number comes off this (cancelled) appointment. The wallet,
      // its balance and the loyalty record stay; only the copy of the number shown on the booking is removed.
      stmts.push(env.DB.prepare(`UPDATE bookings SET client_phone = '' WHERE id = ?1`).bind(id));
      stmts.push(env.DB.prepare(
        `INSERT OR IGNORE INTO wallet_ledger (phone, kind, amount_cents, booking_id, note)
         SELECT phone, 'refund', -amount_cents, booking_id, note FROM wallet_ledger WHERE booking_id = ?1 AND kind = 'spend'`
      ).bind(id));
    }
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
  const out = { booking: await getBooking(env, id) };
  if (refund) {
    out.creditReturned = refund.cents / 100;
    out.email = await sendCreditBackEmail(env, booking, refund);
  }
  return json(out);
}

/** Hide every cancelled booking from the manager's queue (rows are kept: ledgers point at them). */
async function managerClearCancelled(env) {
  const r = await env.DB.prepare(`UPDATE bookings SET cleared_at = ?1 WHERE status = 'Cancelled' AND cleared_at IS NULL`).bind(nowIso()).run();
  return json({ cleared: (r.meta && r.meta.changes) || 0 });
}

// ---------- email (credit back on the VIP wallet) ----------
/**
 * Send one email through Resend. Returns 'sent', 'not_configured' (no RESEND_API_KEY / EMAIL_FROM),
 * 'no_address' or 'failed'. Never throws: a failed email must not undo the cancellation.
 */
export async function sendEmail(env, { to, subject, text }) {
  if (!env.RESEND_API_KEY || !env.EMAIL_FROM) return 'not_configured';
  if (!isEmail(to)) return 'no_address';
  try {
    const res = await fetch('https://api.resend.com/emails', {
      method: 'POST',
      headers: { Authorization: `Bearer ${env.RESEND_API_KEY}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ from: env.EMAIL_FROM, to: [to.trim()], subject, text })
    });
    return res.ok ? 'sent' : 'failed';
  } catch (err) {
    console.error('email failed', err);
    return 'failed';
  }
}

async function sendCreditBackEmail(env, booking, refund) {
  if (!env.RESEND_API_KEY || !env.EMAIL_FROM) return 'not_configured';
  const customer = await env.DB.prepare('SELECT email, name FROM customers WHERE phone = ?').bind(refund.phone).first();
  if (!customer || !customer.email) return 'no_address';
  const { settings } = await loadShopSettings(env);
  const shopName = String((settings && settings.shopName) || 'Elite Cuts');
  const balance = (await walletBalanceCents(env, refund.phone)) / 100;
  const amount = (refund.cents / 100).toFixed(2);
  return sendEmail(env, {
    to: customer.email,
    subject: `${shopName}: $${amount} is back in your VIP wallet`,
    text: [
      `Hi ${booking.clientName || customer.name || 'there'},`,
      '',
      `Your appointment ${booking.refCode} on ${booking.date} at ${booking.time} was cancelled, and the $${amount} you paid from your VIP wallet is back on your wallet.`,
      `Your wallet balance is now $${balance.toFixed(2)}. You can use it on your next booking.`,
      'Wallet credit is non-refundable store credit, good for cuts and products only. It is not refunded to your card.',
      'Your phone number has been taken off the cancelled appointment.',
      '',
      shopName
    ].join('\n')
  });
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
     WHERE customer_phone = ? AND client_phone <> '' ORDER BY date DESC, created_at DESC LIMIT 10`
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

/** Fallback when no webhook secret is set: ask Stripe directly for the session (the event body can't be trusted). */
async function fetchStripeSession(env, sessionId) {
  if (!/^cs_[A-Za-z0-9_]+$/.test(sessionId || '')) return null;
  const res = await fetch(`https://api.stripe.com/v1/checkout/sessions/${sessionId}`, {
    headers: { Authorization: `Bearer ${env.STRIPE_SECRET_KEY}` }
  });
  if (!res.ok) return null;
  return res.json();
}

const PAID_EVENTS = ['checkout.session.completed', 'checkout.session.async_payment_succeeded'];

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
  const isPaidEvent = PAID_EVENTS.includes(event.type);
  if (!isPaidEvent && event.type !== 'checkout.session.expired') return json({ received: true });

  let session = event.data && event.data.object;
  if (!env.STRIPE_WEBHOOK_SECRET) {
    session = await fetchStripeSession(env, session && session.id);
    const ok = session && (isPaidEvent ? session.payment_status === 'paid' : session.status === 'expired');
    if (!ok) return json({ error: isPaidEvent ? 'Session not found or not paid' : 'Session not found or not expired' }, 400);
  }
  if (!session) return json({ received: true });
  const meta = session.metadata || {};

  if (isPaidEvent) {
    // A card payment can still be pending (completed with payment_status "unpaid"); its
    // async_payment_succeeded event comes later.
    if (session.payment_status === 'unpaid') return json({ received: true });
    if (meta.kind === 'wallet_topup') {
      const phone = normalizePhone(meta.phone);
      const cents = Math.round(Number(session.amount_total));
      if (phone && cents > 0 && session.id) {
        await env.DB.batch([
          env.DB.prepare('INSERT OR IGNORE INTO wallet_accounts (phone) VALUES (?)').bind(phone),
          env.DB.prepare(
            `INSERT OR IGNORE INTO wallet_ledger (phone, kind, amount_cents, stripe_session_id, note)
             VALUES (?1, 'topup', ?2, ?3, 'Card top-up')`
          ).bind(phone, cents, String(session.id))
        ]);
      }
      return json({ received: true });
    }
    const refCode = session.client_reference_id;
    const row = refCode ? await env.DB.prepare('SELECT id FROM bookings WHERE ref_code = ?').bind(String(refCode)).first() : null;
    if (row) await markPaid(env, row.id);
    return json({ received: true });
  }

  // checkout.session.expired: the client never paid, so free the chair. Only bookings this worker created the
  // session for (matched by session id) and that are still unpaid; payment-link bookings are left alone.
  if (session.id && meta.kind !== 'wallet_topup') {
    await env.DB.prepare(
      `UPDATE bookings SET status = 'Cancelled', updated_at = ?1
       WHERE stripe_session_id = ?2 AND paid = 0 AND status = 'Deposit Unpaid'`
    ).bind(nowIso(), String(session.id)).run();
  }
  return json({ received: true });
}

// ---------- client reviews ----------
// Every review is logged in the reviews table. The ones the manager ticks (shown = 1) are copied into the
// published shop settings, which is what the home screen reads, so clients never see an unticked review.

/** Returns { review } cleaned, or { error }. */
export function validateReview(body) {
  if (!body || typeof body !== 'object') return { error: 'Send the review as a JSON object' };
  try {
    return { review: {
      name: text(body.name, 'name', 60) || 'Client',
      stars: num(Math.round(Number(body.stars)), 'stars', 1, 5, { int: true }),
      text: text(body.text, 'text', 600, { required: true })
    } };
  } catch (err) {
    if (err instanceof SettingsError) return { error: err.message };
    throw err;
  }
}

const rowToReview = (r) => r && ({
  id: r.id, name: r.name, stars: r.stars, text: r.text, source: r.source,
  shown: !!r.shown, read: !!r.read_at, createdAt: r.created_at
});

/** Copy the ticked reviews into the published settings. Returns the new settings. */
async function publishShownReviews(env) {
  const { results } = await env.DB.prepare(
    `SELECT name, stars, text FROM reviews WHERE shown = 1 ORDER BY created_at DESC, id ASC LIMIT ?1`
  ).bind(MAX_REVIEWS_SHOWN).all();
  const current = (await loadShopSettings(env)).settings || {};
  const merged = { ...current, reviews: results.map((r) => ({ name: r.name, stars: r.stars, text: r.text })) };
  await env.DB.prepare(
    `INSERT INTO shop_settings (id, data, updated_at) VALUES (1, ?1, ?2)
     ON CONFLICT(id) DO UPDATE SET data = excluded.data, updated_at = excluded.updated_at`
  ).bind(JSON.stringify(merged), nowIso()).run();
  return merged;
}

async function createReview(req, env) {
  const { review, error } = validateReview(await readBody(req));
  if (error) return json({ error }, 400);
  const limited = await rateLimit(env, `review:${clientKey(req)}`, REVIEWS_PER_HOUR, 3600);
  if (limited) return limited;
  await env.DB.prepare(`INSERT INTO reviews (name, stars, text, source, shown) VALUES (?1, ?2, ?3, 'client', 0)`)
    .bind(review.name, review.stars, review.text).run();
  return json({ ok: true }, 201);
}

async function managerReviews(env) {
  const { results } = await env.DB.prepare('SELECT * FROM reviews ORDER BY created_at DESC, id ASC LIMIT 500').all();
  const reviews = results.map(rowToReview);
  return json({ reviews, unread: reviews.filter((r) => !r.read).length });
}

async function managerAddReview(req, env) {
  const body = await readBody(req);
  const { review, error } = validateReview(body);
  if (error) return json({ error }, 400);
  const shown = !body || body.shown !== false;
  const row = await env.DB.prepare(
    `INSERT INTO reviews (name, stars, text, source, shown, read_at) VALUES (?1, ?2, ?3, 'manager', ?4, ?5) RETURNING *`
  ).bind(review.name, review.stars, review.text, shown ? 1 : 0, nowIso()).first();
  return json({ review: rowToReview(row), settings: await publishShownReviews(env) }, 201);
}

async function managerPatchReview(req, env, idParam) {
  const id = Number(idParam);
  const body = await readBody(req);
  if (!Number.isInteger(id) || !body || typeof body.shown !== 'boolean') return json({ error: 'Send { shown: true | false }' }, 400);
  const row = await env.DB.prepare('UPDATE reviews SET shown = ?1, read_at = COALESCE(read_at, ?2) WHERE id = ?3 RETURNING *')
    .bind(body.shown ? 1 : 0, nowIso(), id).first();
  if (!row) return json({ error: 'Review not found' }, 404);
  return json({ review: rowToReview(row), settings: await publishShownReviews(env) });
}

async function managerDeleteReview(env, idParam) {
  const id = Number(idParam);
  const r = await env.DB.prepare('DELETE FROM reviews WHERE id = ?').bind(Number.isInteger(id) ? id : -1).run();
  if (!r.meta || !r.meta.changes) return json({ error: 'Review not found' }, 404);
  return json({ ok: true, settings: await publishShownReviews(env) });
}

async function managerMarkReviewsRead(env) {
  await env.DB.prepare('UPDATE reviews SET read_at = ?1 WHERE read_at IS NULL').bind(nowIso()).run();
  return json({ ok: true });
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
  ['POST', /^\/api\/manager\/bookings\/clear-cancelled$/, (req, env) => managerClearCancelled(env), true],
  ['PATCH', /^\/api\/manager\/bookings\/([^/]+)$/, (req, env, url, m) => managerPatchBooking(req, env, decodeURIComponent(m[1])), true],
  ['GET', /^\/api\/manager\/loyalty\.csv$/, (req, env) => managerLoyaltyCsv(env), true],
  ['GET', /^\/api\/manager\/report$/, (req, env, url) => managerReport(url, env), true],
  ['GET', /^\/api\/shop$/, (req, env) => getShop(env)],
  ['PUT', /^\/api\/manager\/shop$/, (req, env) => managerPutShop(req, env), true],
  ['POST', /^\/api\/webhook\/stripe$/, (req, env) => stripeWebhook(req, env)],
  ['GET', /^\/api\/payments$/, (req, env) => paymentsInfo(env)],
  ['POST', /^\/api\/wallet$/, (req, env) => walletLookup(req, env)],
  ['POST', /^\/api\/wallet\/topup$/, (req, env) => walletTopUp(req, env)],
  ['GET', /^\/api\/manager\/wallets$/, (req, env) => managerWallets(env), true],
  ['POST', /^\/api\/manager\/wallets\/([^/]+)\/adjust$/, (req, env, url, m) => managerWalletAdjust(req, env, decodeURIComponent(m[1])), true],
  ['POST', /^\/api\/manager\/wallets\/([^/]+)\/reset-pin$/, (req, env, url, m) => managerWalletResetPin(env, decodeURIComponent(m[1])), true],
  ['POST', /^\/api\/reviews$/, (req, env) => createReview(req, env)],
  ['GET', /^\/api\/manager\/reviews$/, (req, env) => managerReviews(env), true],
  ['POST', /^\/api\/manager\/reviews$/, (req, env) => managerAddReview(req, env), true],
  ['POST', /^\/api\/manager\/reviews\/read$/, (req, env) => managerMarkReviewsRead(env), true],
  ['PATCH', /^\/api\/manager\/reviews\/(\d+)$/, (req, env, url, m) => managerPatchReview(req, env, m[1]), true],
  ['DELETE', /^\/api\/manager\/reviews\/(\d+)$/, (req, env, url, m) => managerDeleteReview(env, m[1]), true]
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
