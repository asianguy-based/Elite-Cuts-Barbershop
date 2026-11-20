/**
 * Elite Cuts API — Cloudflare Worker backend for the static booking PWA.
 *
 * Storage (KV binding BOOKINGS):
 *   booking:{id}                 -> booking object
 *   bookings:{date}:{barberId}   -> [id, ...]                 (per-day slot index)
 *   bookings:all                 -> [{ id, date }, ...]       (newest first, capped)
 *   ref:{refCode}                -> id                        (Stripe client_reference_id lookup)
 *   loyalty:{normalizedPhone}    -> { name, phone, points, stamps, lastVisit, history: [] }
 *
 *   lock:{ip}                    -> failed manager-login count  (expires after 15 min)
 *
 * Secrets: MANAGER_PIN (required)
 *          STRIPE_WEBHOOK_SECRET (recommended) — verifies Stripe webhook signatures
 *          STRIPE_SECRET_KEY (fallback) — if no webhook secret is set, each webhook's
 *            checkout session is re-fetched from Stripe and must be paid
 *          With neither set, the webhook refuses to mark anything paid.
 * Vars:    ALLOWED_ORIGIN — comma-separated list of allowed browser origins; an entry
 *          like "https://*.example.pages.dev" also matches preview subdomains. "*" = any.
 */

const ALL_CAP = 2000;
const HISTORY_CAP = 50;
const STATUSES = ['Confirmed', 'Deposit Unpaid', 'Paid', 'Completed', 'Cancelled', 'No-Show'];
const REQUIRED = ['services', 'barberId', 'barberName', 'date', 'time', 'clientName', 'clientPhone', 'paymentMode'];
const enc = new TextEncoder();

// ---------- helpers ----------
const json = (data, status = 200, headers = {}) =>
  new Response(JSON.stringify(data), { status, headers: { 'Content-Type': 'application/json', ...headers } });

const LOGIN_MAX_FAILS = 5;
const LOGIN_LOCK_SECONDS = 900;

/** Match a request Origin against the ALLOWED_ORIGIN list ("*", exact origins, or https://*.domain). */
function allowedOrigin(env, origin) {
  const list = String(env.ALLOWED_ORIGIN || '*').split(',').map((s) => s.trim()).filter(Boolean);
  if (list.includes('*')) return '*';
  if (!origin) return null;
  for (const entry of list) {
    if (entry === origin) return origin;
    const m = entry.match(/^(https?):\/\/\*\.(.+)$/);
    if (m) {
      try {
        const u = new URL(origin);
        if (u.protocol === `${m[1]}:` && u.hostname.endsWith(`.${m[2]}`) && !u.port) return origin;
      } catch { /* malformed origin */ }
    }
  }
  return null;
}

const corsHeaders = (env, origin) => {
  const allow = allowedOrigin(env, origin);
  const h = {
    'Access-Control-Allow-Methods': 'GET, POST, PATCH, OPTIONS',
    'Access-Control-Allow-Headers': 'Content-Type, X-Manager-Token',
    'Access-Control-Max-Age': '86400',
    'Vary': 'Origin'
  };
  if (allow) h['Access-Control-Allow-Origin'] = allow;
  return h;
};

const today = () => new Date().toISOString().slice(0, 10);
const normalizePhone = (p) => String(p || '').replace(/\D/g, '');
const isDate = (s) => /^\d{4}-\d{2}-\d{2}$/.test(s || '');
const hex = (buf) => [...new Uint8Array(buf)].map((b) => b.toString(16).padStart(2, '0')).join('');

function timingSafeEqual(a, b) {
  const x = enc.encode(String(a)), y = enc.encode(String(b));
  let diff = x.length ^ y.length;
  for (let i = 0; i < Math.max(x.length, y.length); i++) diff |= (x[i] || 0) ^ (y[i] || 0);
  return diff === 0;
}

async function hmacHex(secret, message) {
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

const kvGet = (env, key) => env.BOOKINGS.get(key, { type: 'json' });
const kvPut = (env, key, value) => env.BOOKINGS.put(key, JSON.stringify(value));

async function getBookingsByIds(env, ids) {
  const rows = await Promise.all(ids.map((id) => kvGet(env, `booking:${id}`)));
  return rows.filter(Boolean);
}

/** Award points/stamp to a phone and push a history entry. Idempotency is the caller's job. */
async function awardLoyalty(env, booking, points) {
  const key = `loyalty:${normalizePhone(booking.clientPhone)}`;
  const rec = (await kvGet(env, key)) || { points: 0, stamps: 0, history: [] };
  rec.name = booking.clientName;
  rec.phone = booking.clientPhone;
  rec.points = (rec.points || 0) + points;
  rec.stamps = ((rec.stamps || 0) + 1) % 11;
  rec.lastVisit = booking.date;
  rec.history = [{
    date: booking.date, time: booking.time, services: booking.services,
    barberName: booking.barberName, refCode: booking.refCode, status: booking.status
  }, ...(rec.history || [])].slice(0, HISTORY_CAP);
  await kvPut(env, key, rec);
  return rec;
}

/** Mark a deposit booking paid and award its 150 pts exactly once. */
async function markPaid(env, booking) {
  if (booking.paid) return booking;
  booking.paid = true;
  booking.status = booking.status === 'Deposit Unpaid' ? 'Paid' : booking.status;
  booking.paidAt = new Date().toISOString();
  await kvPut(env, `booking:${booking.id}`, booking);
  await awardLoyalty(env, booking, 150);
  return booking;
}

// ---------- route handlers ----------
async function getSlots(url, env) {
  const date = url.searchParams.get('date'), barberId = url.searchParams.get('barberId');
  if (!isDate(date) || !barberId) return json({ error: 'date (YYYY-MM-DD) and barberId are required' }, 400);
  const ids = (await kvGet(env, `bookings:${date}:${barberId}`)) || [];
  const rows = await getBookingsByIds(env, ids);
  const booked = rows.filter((b) => b.status !== 'Cancelled').map((b) => b.time);
  return json({ booked: [...new Set(booked)] });
}

async function createBooking(req, env) {
  const body = await readBody(req);
  if (!body) return json({ error: 'Invalid JSON' }, 400);
  const missing = REQUIRED.filter((k) => body[k] === undefined || body[k] === null || body[k] === '');
  if (missing.length) return json({ error: `Missing fields: ${missing.join(', ')}` }, 400);
  if (!Array.isArray(body.services) || !body.services.length) return json({ error: 'services must be a non-empty array' }, 400);
  if (!isDate(body.date)) return json({ error: 'date must be YYYY-MM-DD' }, 400);
  if (!['deposit', 'chair'].includes(body.paymentMode)) return json({ error: 'paymentMode must be deposit or chair' }, 400);
  if (!normalizePhone(body.clientPhone)) return json({ error: 'clientPhone must contain digits' }, 400);

  // Conflict check. KV is eventually consistent, so this is "atomic enough" for a
  // single-shop booking rate, not a hard guarantee under concurrent writes.
  const slotKey = `bookings:${body.date}:${body.barberId}`;
  const slotIds = (await kvGet(env, slotKey)) || [];
  const existing = await getBookingsByIds(env, slotIds);
  if (existing.some((b) => b.time === body.time && b.status !== 'Cancelled')) {
    return json({ error: 'That time is already booked' }, 409);
  }

  const isDeposit = body.paymentMode === 'deposit';
  const id = `${Date.now().toString(36)}-${crypto.randomUUID().slice(0, 8)}`;
  // Ref codes are looked up by Stripe webhooks, so never reuse one that is still mapped.
  let refCode;
  for (let i = 0; i < 20 && !refCode; i++) {
    const digits = i < 10 ? 4 : 6;
    const candidate = 'EC-' + String(Math.floor(10 ** (digits - 1) + Math.random() * 9 * 10 ** (digits - 1)));
    if (!(await env.BOOKINGS.get(`ref:${candidate}`))) refCode = candidate;
  }
  if (!refCode) return json({ error: 'Could not allocate a reference code, please retry' }, 503);
  const booking = {
    id, refCode,
    services: body.services.map(String),
    totalCost: Number(body.totalCost) || 0,
    totalMin: Number(body.totalMin) || 0,
    barberId: String(body.barberId), barberName: String(body.barberName),
    date: body.date, time: String(body.time),
    clientName: String(body.clientName).slice(0, 120),
    clientPhone: String(body.clientPhone).slice(0, 40),
    notes: String(body.notes || '').slice(0, 500),
    paymentMode: body.paymentMode,
    depositAmount: isDeposit ? Number(body.depositAmount) || 0 : 0,
    status: isDeposit ? 'Deposit Unpaid' : 'Confirmed',
    paid: false,
    createdAt: new Date().toISOString()
  };

  await kvPut(env, `booking:${id}`, booking);
  await kvPut(env, `ref:${refCode}`, id);
  await kvPut(env, slotKey, [...slotIds, id]);
  const all = (await kvGet(env, 'bookings:all')) || [];
  await kvPut(env, 'bookings:all', [{ id, date: booking.date }, ...all].slice(0, ALL_CAP));

  if (!isDeposit) await awardLoyalty(env, booking, 100); // deposit mode is awarded on payment
  return json({ booking }, 201);
}

async function managerLogin(req, env) {
  if (!env.MANAGER_PIN) return json({ error: 'MANAGER_PIN secret not configured' }, 500);
  // Brute-force guard: a short PIN must not be guessable by scripting this endpoint.
  const ip = req.headers.get('CF-Connecting-IP') || 'unknown';
  const lockKey = `lock:${ip}`;
  const fails = Number(await env.BOOKINGS.get(lockKey)) || 0;
  if (fails >= LOGIN_MAX_FAILS) {
    return json({ error: 'Too many attempts. Try again in 15 minutes.' }, 429, { 'Retry-After': String(LOGIN_LOCK_SECONDS) });
  }
  const body = await readBody(req);
  if (!body || !timingSafeEqual(body.pin || '', env.MANAGER_PIN)) {
    await env.BOOKINGS.put(lockKey, String(fails + 1), { expirationTtl: LOGIN_LOCK_SECONDS });
    return json({ error: 'Invalid PIN' }, 401);
  }
  if (fails) await env.BOOKINGS.delete(lockKey);
  return json({ token: await managerToken(env), validFor: today() });
}

async function managerBookings(url, env) {
  const from = isDate(url.searchParams.get('from')) ? url.searchParams.get('from') : today();
  const to = isDate(url.searchParams.get('to')) ? url.searchParams.get('to') : '9999-12-31';
  const all = (await kvGet(env, 'bookings:all')) || [];
  const ids = all.filter((e) => e.date >= from && e.date <= to).slice(0, 500).map((e) => e.id);
  const rows = await getBookingsByIds(env, ids);
  rows.sort((a, b) => (b.createdAt || '').localeCompare(a.createdAt || ''));
  return json({ bookings: rows, from, to });
}

async function managerPatchBooking(req, env, id) {
  const body = await readBody(req);
  if (!body || !STATUSES.includes(body.status)) return json({ error: `status must be one of: ${STATUSES.join(', ')}` }, 400);
  let booking = await kvGet(env, `booking:${id}`);
  if (!booking) return json({ error: 'Booking not found' }, 404);
  if (body.status === 'Paid' && booking.paymentMode === 'deposit') {
    booking = await markPaid(env, booking);
  }
  booking.status = body.status;
  booking.updatedAt = new Date().toISOString();
  await kvPut(env, `booking:${id}`, booking);
  return json({ booking });
}

async function managerLoyaltyCsv(env) {
  const csvCell = (v) => `"${String(v ?? '').replace(/"/g, '""')}"`;
  const lines = ['name,phone,points,stamps,lastVisit'];
  let cursor;
  do {
    const page = await env.BOOKINGS.list({ prefix: 'loyalty:', cursor });
    const recs = await Promise.all(page.keys.map((k) => kvGet(env, k.name)));
    for (const r of recs) if (r) lines.push([csvCell(r.name), csvCell(r.phone), r.points || 0, r.stamps || 0, csvCell(r.lastVisit)].join(','));
    cursor = page.list_complete ? undefined : page.cursor;
  } while (cursor);
  return new Response(lines.join('\n') + '\n', {
    headers: { 'Content-Type': 'text/csv; charset=utf-8', 'Content-Disposition': 'attachment; filename="loyalty.csv"' }
  });
}

async function getLoyalty(url, env) {
  const phone = normalizePhone(url.searchParams.get('phone'));
  if (!phone) return json({ error: 'phone is required' }, 400);
  const rec = (await kvGet(env, `loyalty:${phone}`)) || { points: 0, stamps: 0, history: [] };
  return json({ points: rec.points || 0, stamps: rec.stamps || 0, history: (rec.history || []).slice(0, 10) });
}

async function verifyStripeSignature(payload, header, secret) {
  if (!header) return false;
  const parts = Object.fromEntries(header.split(',').map((kv) => kv.split('=').map((s) => s.trim())));
  const t = Number(parts.t);
  if (!t || Math.abs(Date.now() / 1000 - t) > 300) return false;
  const expected = await hmacHex(secret, `${t}.${payload}`);
  const sigs = header.split(',').filter((kv) => kv.trim().startsWith('v1=')).map((kv) => kv.trim().slice(3));
  return sigs.some((s) => timingSafeEqual(s, expected));
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
    // Never trust an unauthenticated "payment completed" claim.
    return json({ error: 'Stripe webhook not configured (set STRIPE_WEBHOOK_SECRET)' }, 503);
  }
  let event;
  try { event = JSON.parse(payload); } catch { return json({ error: 'Invalid JSON' }, 400); }
  if (event.type === 'checkout.session.completed') {
    let session = event.data?.object;
    if (!env.STRIPE_WEBHOOK_SECRET) {
      session = await fetchPaidStripeSession(env, session?.id);
      if (!session) return json({ error: 'Session not found or not paid' }, 400);
    }
    const refCode = session?.client_reference_id;
    const id = refCode ? await kvGet(env, `ref:${refCode}`) : null;
    const booking = id ? await kvGet(env, `booking:${id}`) : null;
    if (booking) await markPaid(env, booking);
  }
  return json({ received: true });
}

// ---------- router ----------
const routes = [
  ['GET', /^\/api\/health$/, () => json({ ok: true, time: new Date().toISOString() })],
  ['GET', /^\/api\/slots$/, (req, env, url) => getSlots(url, env)],
  ['POST', /^\/api\/bookings$/, (req, env) => createBooking(req, env)],
  ['GET', /^\/api\/loyalty$/, (req, env, url) => getLoyalty(url, env)],
  ['POST', /^\/api\/manager\/login$/, (req, env) => managerLogin(req, env)],
  ['GET', /^\/api\/manager\/bookings$/, (req, env, url) => managerBookings(url, env), true],
  ['PATCH', /^\/api\/manager\/bookings\/([^/]+)$/, (req, env, url, m) => managerPatchBooking(req, env, decodeURIComponent(m[1])), true],
  ['GET', /^\/api\/manager\/loyalty\.csv$/, (req, env) => managerLoyaltyCsv(env), true],
  ['POST', /^\/api\/webhook\/stripe$/, (req, env) => stripeWebhook(req, env)]
];

export default {
  async fetch(req, env) {
    const cors = corsHeaders(env, req.headers.get('Origin'));
    if (req.method === 'OPTIONS') return new Response(null, { status: 204, headers: cors });
    const url = new URL(req.url);
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
      res = json({ error: 'Internal error', detail: String(err && err.message || err) }, 500);
    }
    const headers = new Headers(res.headers);
    for (const [k, v] of Object.entries(cors)) headers.set(k, v);
    return new Response(res.body, { status: res.status, headers });
  }
};
