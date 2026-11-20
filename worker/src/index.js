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
 *   POST  /api/manager/login   { pin }                       -> { token, validFor }
 *   GET   /api/manager/bookings?from&to                      -> { bookings, from, to }   (X-Manager-Token)
 *   PATCH /api/manager/bookings/:id { status }               -> { booking }              (X-Manager-Token)
 *   GET   /api/manager/loyalty.csv                           -> text/csv                 (X-Manager-Token)
 *   GET   /api/manager/report?from&to                        -> { rows }   (new: per-day, per-barber totals)
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
const BOOKING_POINTS = 100;   // pay-at-chair bookings earn on booking
const DEPOSIT_POINTS = 150;   // deposit bookings earn when Stripe (or the manager) marks them paid
const LOGIN_MAX_FAILS = 5;     // wrong manager PINs from one IP before a lockout
const LOGIN_LOCK_MINUTES = 15;
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

const managerToken = (env, day = today()) => hmacHex(env.MANAGER_PIN, `manager:${day}`);

async function requireManager(req, env) {
  if (!env.MANAGER_PIN) return json({ error: 'MANAGER_PIN secret not configured' }, 500);
  const sent = req.headers.get('X-Manager-Token') || '';
  if (!sent || !timingSafeEqual(sent, await managerToken(env))) return json({ error: 'Unauthorized' }, 401);
  return null;
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
    'Access-Control-Allow-Methods': 'GET, POST, PATCH, OPTIONS',
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

// ---------- route handlers ----------
async function getSlots(url, env) {
  const date = url.searchParams.get('date'), barberId = url.searchParams.get('barberId');
  if (!isDate(date) || !barberId) return json({ error: 'date (YYYY-MM-DD) and barberId are required' }, 400);
  const { results } = await env.DB.prepare(
    `SELECT DISTINCT time FROM bookings WHERE date = ? AND barber_id = ? AND status <> 'Cancelled'`
  ).bind(date, barberId).all();
  return json({ booked: results.map((r) => r.time) });
}

export function validateBooking(body) {
  if (!body || typeof body !== 'object') return 'Invalid JSON';
  const missing = REQUIRED.filter((k) => body[k] === undefined || body[k] === null || body[k] === '');
  if (missing.length) return `Missing fields: ${missing.join(', ')}`;
  if (!Array.isArray(body.services) || !body.services.length) return 'services must be a non-empty array';
  if (!isDate(body.date)) return 'date must be YYYY-MM-DD';
  if (!['deposit', 'chair'].includes(body.paymentMode)) return 'paymentMode must be deposit or chair';
  if (!normalizePhone(body.clientPhone)) return 'clientPhone must contain digits';
  return null;
}

async function createBooking(req, env) {
  const body = await readBody(req);
  const problem = validateBooking(body);
  if (problem) return json({ error: problem }, 400);

  const isDeposit = body.paymentMode === 'deposit';
  const phone = normalizePhone(body.clientPhone);
  const clientName = String(body.clientName).slice(0, 120);
  const clientPhone = String(body.clientPhone).slice(0, 40);
  const id = `${Date.now().toString(36)}-${crypto.randomUUID().slice(0, 8)}`;

  // One transaction: customer upsert + booking + (pay-at-chair) loyalty award.
  // If the slot is taken, the unique index fails the INSERT and the whole batch rolls back.
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
        String(body.barberId), String(body.barberName), body.date, String(body.time),
        String(body.notes || '').slice(0, 500), body.paymentMode,
        isDeposit ? Number(body.depositAmount) || 0 : 0,
        isDeposit ? 'Deposit Unpaid' : 'Confirmed', nowIso()
      )
    ];
    if (!isDeposit) {
      stmts.push(env.DB.prepare(
        `INSERT INTO loyalty_events (phone, booking_id, kind, points) VALUES (?1, ?2, 'booking', ?3)`
      ).bind(phone, id, BOOKING_POINTS));
    }
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
  const ip = req.headers.get('CF-Connecting-IP') || 'unknown';
  const now = nowIso();
  const row = await env.DB.prepare('SELECT fails, locked_until FROM login_attempts WHERE ip = ?').bind(ip).first();
  if (row && row.locked_until && row.locked_until > now) {
    const retry = Math.max(1, Math.ceil((Date.parse(row.locked_until) - Date.now()) / 1000));
    return json({ error: `Too many attempts. Try again in ${Math.ceil(retry / 60)} minutes.` }, 429, { 'Retry-After': String(retry) });
  }
  const body = await readBody(req);
  if (!body || !timingSafeEqual(body.pin || '', env.MANAGER_PIN)) {
    const fails = (row && (!row.locked_until || row.locked_until <= now) ? row.fails : 0) + 1;
    const lockedUntil = fails >= LOGIN_MAX_FAILS ? new Date(Date.now() + LOGIN_LOCK_MINUTES * 60000).toISOString() : null;
    await env.DB.prepare(
      `INSERT INTO login_attempts (ip, fails, locked_until, updated_at) VALUES (?1, ?2, ?3, ?4)
       ON CONFLICT(ip) DO UPDATE SET fails = ?2, locked_until = ?3, updated_at = ?4`
    ).bind(ip, lockedUntil ? 0 : fails, lockedUntil, now).run();
    return json({ error: 'Invalid PIN' }, 401);
  }
  if (row) await env.DB.prepare('DELETE FROM login_attempts WHERE ip = ?').bind(ip).run();
  return json({ token: await managerToken(env), validFor: today() });
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
    await env.DB.prepare('UPDATE bookings SET status = ?1, updated_at = ?2 WHERE id = ?3').bind(body.status, nowIso(), id).run();
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
  const csvCell = (v) => `"${String(v ?? '').replace(/"/g, '""')}"`;
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

async function getLoyalty(url, env) {
  const phone = normalizePhone(url.searchParams.get('phone'));
  if (!phone) return json({ error: 'phone is required' }, 400);
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
const routes = [
  ['GET', /^\/api\/health$/, async (req, env) => {
    const r = await env.DB.prepare('SELECT COUNT(*) AS n FROM bookings').first();
    return json({ ok: true, time: nowIso(), bookings: r ? r.n : 0 });
  }],
  ['GET', /^\/api\/slots$/, (req, env, url) => getSlots(url, env)],
  ['POST', /^\/api\/bookings$/, (req, env) => createBooking(req, env)],
  ['POST', /^\/api\/bookings\/late$/, (req, env) => markLate(req, env)],
  ['GET', /^\/api\/loyalty$/, (req, env, url) => getLoyalty(url, env)],
  ['POST', /^\/api\/manager\/login$/, (req, env) => managerLogin(req, env)],
  ['GET', /^\/api\/manager\/bookings$/, (req, env, url) => managerBookings(url, env), true],
  ['PATCH', /^\/api\/manager\/bookings\/([^/]+)$/, (req, env, url, m) => managerPatchBooking(req, env, decodeURIComponent(m[1])), true],
  ['GET', /^\/api\/manager\/loyalty\.csv$/, (req, env) => managerLoyaltyCsv(env), true],
  ['GET', /^\/api\/manager\/report$/, (req, env, url) => managerReport(url, env), true],
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
