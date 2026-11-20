// End-to-end tests for the D1 worker, run with plain Node (22+), no Cloudflare tooling:
//   node --test worker/test/
// A tiny D1 stand-in wraps Node's built-in SQLite and loads the real schema.sql,
// so the same constraints that protect production are exercised here.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { DatabaseSync } from 'node:sqlite';
import worker, { verifyStripeSignature, hmacHex, cors, clientKey } from '../src/index.js';

const schema = readFileSync(new URL('../schema.sql', import.meta.url), 'utf8');

function makeD1() {
  const db = new DatabaseSync(':memory:');
  db.exec('PRAGMA foreign_keys = ON;');
  db.exec(schema);
  const stmt = (sql, args = []) => ({
    bind: (...a) => stmt(sql, a),
    first: async () => db.prepare(sql).get(...args) ?? null,
    all: async () => ({ results: db.prepare(sql).all(...args) }),
    run: async () => { const r = db.prepare(sql).run(...args); return { meta: { changes: Number(r.changes) } }; },
    _exec: () => db.prepare(sql).run(...args)
  });
  return {
    raw: db,
    prepare: (sql) => stmt(sql),
    async batch(list) { // D1 batches are a single transaction
      db.exec('BEGIN');
      try { list.forEach((s) => s._exec()); db.exec('COMMIT'); } catch (e) { db.exec('ROLLBACK'); throw e; }
      return list.map(() => ({ success: true }));
    }
  };
}

const ORIGIN = 'http://localhost:8203'; // test-only origin
const day = (n) => new Date(Date.now() + n * 86400000).toISOString().slice(0, 10);
const D = day(10); // a valid booking date relative to today, so the tests don't age out
const newEnv = () => ({ DB: makeD1(), MANAGER_PIN: '4321', STRIPE_WEBHOOK_SECRET: 'whsec_test', ALLOWED_ORIGINS: `https://elite-cuts.pages.dev,${ORIGIN}` });
const call = async (env, method, path, body, headers = {}) => {
  const res = await worker.fetch(new Request('https://api.test' + path, {
    method, headers: { 'Content-Type': 'application/json', Origin: ORIGIN, ...headers },
    body: body === undefined ? undefined : (typeof body === 'string' ? body : JSON.stringify(body))
  }), env);
  const type = res.headers.get('content-type') || '';
  return { status: res.status, headers: res.headers, data: type.includes('json') ? await res.json() : await res.text() };
};
const booking = (over = {}) => ({
  services: ['The Executive Cut & Style'], totalCost: 45, totalMin: 45,
  barberId: 'brb-1', barberName: 'Marcus Vance', date: D, time: '11:00 AM',
  clientName: 'Jordan Lee', clientPhone: '(555) 010-2030', paymentMode: 'chair', ...over
});

test('booking, slots and loyalty round trip', async () => {
  const env = newEnv();
  const r = await call(env, 'POST', '/api/bookings', booking());
  assert.equal(r.status, 201);
  assert.match(r.data.booking.refCode, /^EC-\d{4}/);
  assert.deepEqual(r.data.booking.services, ['The Executive Cut & Style']);
  assert.equal(r.data.booking.status, 'Confirmed');
  const s = await call(env, 'GET', `/api/slots?date=${D}&barberId=brb-1`);
  assert.deepEqual(s.data.booked, ['11:00 AM']);
  const l = await call(env, 'GET', '/api/loyalty?phone=5550102030');
  assert.equal(l.data.points, 0, 'no points until the visit is completed');
  assert.equal(l.data.history[0].refCode, r.data.booking.refCode);
  const H = { 'X-Manager-Token': (await call(env, 'POST', '/api/manager/login', { pin: '4321' })).data.token };
  assert.equal((await call(env, 'PATCH', `/api/manager/bookings/${r.data.booking.id}`, { status: 'Completed' }, H)).status, 200);
  assert.equal((await call(env, 'PATCH', `/api/manager/bookings/${r.data.booking.id}`, { status: 'Completed' }, H)).status, 200);
  const l2 = await call(env, 'GET', '/api/loyalty?phone=5550102030');
  assert.equal(l2.data.points, 100, 'completed once, awarded once');
  assert.equal(l2.data.stamps, 1);
});

test('double booking is rejected with 409 and leaves no partial rows', async () => {
  const env = newEnv();
  assert.equal((await call(env, 'POST', '/api/bookings', booking())).status, 201);
  const dup = await call(env, 'POST', '/api/bookings', booking({ clientName: 'Sam', clientPhone: '555 999 0000' }));
  assert.equal(dup.status, 409);
  // the losing request's customer upsert was rolled back with the failed insert
  assert.equal(env.DB.raw.prepare('SELECT COUNT(*) n FROM customers').get().n, 1);
  // other barber, same time: fine
  assert.equal((await call(env, 'POST', '/api/bookings', booking({ barberId: 'brb-2', barberName: 'Mateo Cruz' }))).status, 201);
});

test('concurrent requests for one slot: exactly one wins', async () => {
  const env = newEnv();
  const results = await Promise.all(Array.from({ length: 8 }, (_, i) =>
    call(env, 'POST', '/api/bookings', booking({ clientPhone: `555000${i}` }))));
  assert.equal(results.filter((r) => r.status === 201).length, 1);
  assert.equal(results.filter((r) => r.status === 409).length, 7);
});

test('cancelled slot can be re-booked; un-cancel then conflicts', async () => {
  const env = newEnv();
  const a = (await call(env, 'POST', '/api/bookings', booking())).data.booking;
  const login = await call(env, 'POST', '/api/manager/login', { pin: '4321' });
  const H = { 'X-Manager-Token': login.data.token };
  assert.equal((await call(env, 'PATCH', `/api/manager/bookings/${a.id}`, { status: 'Cancelled' }, H)).status, 200);
  assert.equal((await call(env, 'POST', '/api/bookings', booking({ clientPhone: '5551112222' }))).status, 201);
  assert.equal((await call(env, 'PATCH', `/api/manager/bookings/${a.id}`, { status: 'Confirmed' }, H)).status, 409);
});

test('manager endpoints need a token; list, csv, report', async () => {
  const env = newEnv();
  const b = (await call(env, 'POST', '/api/bookings', booking())).data.booking;
  assert.equal((await call(env, 'GET', '/api/manager/bookings?from=2026-01-01')).status, 401);
  assert.equal((await call(env, 'POST', '/api/manager/login', { pin: '0000' })).status, 401);
  const H = { 'X-Manager-Token': (await call(env, 'POST', '/api/manager/login', { pin: '4321' })).data.token };
  const list = await call(env, 'GET', '/api/manager/bookings?from=2026-01-01', undefined, H);
  assert.equal(list.data.bookings.length, 1);
  await call(env, 'PATCH', `/api/manager/bookings/${b.id}`, { status: 'Completed' }, H);
  const csv = await call(env, 'GET', '/api/manager/loyalty.csv', undefined, H);
  assert.equal(csv.data, `name,phone,points,stamps,lastVisit\n"Jordan Lee","(555) 010-2030",100,1,"${D}"\n`);
  const rep = await call(env, 'GET', '/api/manager/report?from=2026-01-01', undefined, H);
  assert.equal(rep.data.rows[0].revenue, 45);
});

test('stripe webhook: signature required, awards deposit points once', async () => {
  const env = newEnv();
  const b = (await call(env, 'POST', '/api/bookings', booking({ paymentMode: 'deposit', depositAmount: 15 }))).data.booking;
  assert.equal(b.status, 'Deposit Unpaid');
  const payload = JSON.stringify({ type: 'checkout.session.completed', data: { object: { client_reference_id: b.refCode } } });
  const t = Math.floor(Date.now() / 1000);
  const sig = `t=${t},v1=${await hmacHex('whsec_test', `${t}.${payload}`)}`;
  assert.equal((await call(env, 'POST', '/api/webhook/stripe', payload, { 'Stripe-Signature': 'bogus' })).status, 400);
  assert.equal((await call(env, 'POST', '/api/webhook/stripe', payload, { 'Stripe-Signature': sig })).status, 200);
  assert.equal((await call(env, 'POST', '/api/webhook/stripe', payload, { 'Stripe-Signature': sig })).status, 200); // Stripe retry
  const l = await call(env, 'GET', '/api/loyalty?phone=5550102030');
  assert.equal(l.data.points, 150);
  assert.equal(l.data.history[0].status, 'Paid');
  assert.equal(await verifyStripeSignature(payload, sig, 'whsec_test', t + 301), false); // replay window
  assert.equal((await call({ ...env, STRIPE_WEBHOOK_SECRET: '' }, 'POST', '/api/webhook/stripe', payload)).status, 503);
});

test('running late endpoint checks the phone', async () => {
  const env = newEnv();
  const b = (await call(env, 'POST', '/api/bookings', booking())).data.booking;
  assert.equal((await call(env, 'POST', '/api/bookings/late', { refCode: b.refCode, phone: '1', minutes: 10 })).status, 404);
  const ok = await call(env, 'POST', '/api/bookings/late', { refCode: b.refCode, phone: '555-010-2030', minutes: 10 });
  assert.equal(ok.data.booking.lateMinutes, 10);
});

test('CORS allow-list', async () => {
  const env = newEnv();
  const pre = await call(env, 'OPTIONS', '/api/bookings');
  assert.equal(pre.status, 204);
  assert.equal(pre.headers.get('Access-Control-Allow-Origin'), ORIGIN);
  const bad = await call(env, 'POST', '/api/bookings', booking(), { Origin: 'https://evil.example' });
  assert.equal(bad.status, 403);
  assert.equal(cors(new Request('https://x', {}), env).allowed, true); // no Origin (curl/Stripe)
});

test('validation errors', async () => {
  const env = newEnv();
  assert.equal((await call(env, 'POST', '/api/bookings', '{nope')).status, 400);
  assert.equal((await call(env, 'POST', '/api/bookings', booking({ date: '2026-13-45' }))).status, 400);
  assert.equal((await call(env, 'POST', '/api/bookings', booking({ services: [] }))).status, 400);
  assert.equal((await call(env, 'GET', '/api/slots?date=x')).status, 400);
});

// ---- Hardening carried over from the KV worker ----
test('CORS: wildcard entry matches Pages preview subdomains only', async () => {
  const env = { ...newEnv(), ALLOWED_ORIGINS: 'https://elite-cuts-4qn.pages.dev,https://*.elite-cuts-4qn.pages.dev' };
  const ok = async (origin) => (await call(env, 'GET', `/api/slots?date=${D}&barberId=brb-1`, undefined, { Origin: origin }));
  assert.equal((await ok('https://elite-cuts-4qn.pages.dev')).headers.get('access-control-allow-origin'), 'https://elite-cuts-4qn.pages.dev');
  assert.equal((await ok('https://a1481edc.elite-cuts-4qn.pages.dev')).headers.get('access-control-allow-origin'), 'https://a1481edc.elite-cuts-4qn.pages.dev');
  assert.equal((await ok('https://evilelite-cuts-4qn.pages.dev')).status, 403);
  assert.equal((await ok('https://evil.example')).status, 403);
});

test('Stripe: without a webhook secret, the session is re-checked with Stripe', async () => {
  const env = { ...newEnv(), STRIPE_WEBHOOK_SECRET: undefined, STRIPE_SECRET_KEY: 'sk_test' };
  const b = (await call(env, 'POST', '/api/bookings', booking({ paymentMode: 'deposit', depositAmount: 15 }))).data.booking;
  const ev = { type: 'checkout.session.completed', data: { object: { id: 'cs_test_1', client_reference_id: 'EC-0000' } } };
  const realFetch = globalThis.fetch;
  try {
    globalThis.fetch = async () => new Response(JSON.stringify({ id: 'cs_test_1', payment_status: 'unpaid', client_reference_id: b.refCode }));
    assert.equal((await call(env, 'POST', '/api/webhook/stripe', ev, { Origin: '' })).status, 400);
    globalThis.fetch = async () => new Response(JSON.stringify({ id: 'cs_test_1', payment_status: 'paid', client_reference_id: b.refCode }));
    assert.equal((await call(env, 'POST', '/api/webhook/stripe', ev)).status, 200);
  } finally { globalThis.fetch = realFetch; }
  const l = await call(env, 'GET', '/api/loyalty?phone=5550102030');
  assert.equal(l.data.points, 150, 'paid via the ref code Stripe reported, not the forged one in the body');
  const none = { ...newEnv(), STRIPE_WEBHOOK_SECRET: undefined };
  assert.equal((await call(none, 'POST', '/api/webhook/stripe', ev)).status, 503);
});

test('Manager PIN: 5 wrong tries lock the IP out, even for the right PIN', async () => {
  const env = newEnv();
  const ip = { 'CF-Connecting-IP': '203.0.113.9' };
  for (let i = 0; i < 4; i++) assert.equal((await call(env, 'POST', '/api/manager/login', { pin: '0000' }, ip)).status, 401);
  assert.equal((await call(env, 'POST', '/api/manager/login', { pin: '4321' }, ip)).status, 200, 'under the limit, right PIN works and resets');
  for (let i = 0; i < 5; i++) await call(env, 'POST', '/api/manager/login', { pin: '0000' }, ip);
  const locked = await call(env, 'POST', '/api/manager/login', { pin: '4321' }, ip);
  assert.equal(locked.status, 429);
  assert.ok(Number(locked.headers.get('retry-after')) > 0);
  assert.equal((await call(env, 'POST', '/api/manager/login', { pin: '4321' }, { 'CF-Connecting-IP': '198.51.100.1' })).status, 200, 'other IPs unaffected');
  env.DB.raw.exec("UPDATE login_attempts SET locked_until = '2000-01-01T00:00:00Z'");
  assert.equal((await call(env, 'POST', '/api/manager/login', { pin: '4321' }, ip)).status, 200, 'works again after the lock expires');
});

test('API root redirects browsers to the booking site', async () => {
  const env = newEnv();
  const res = await worker.fetch(new Request('https://api.test/'), env);
  assert.equal(res.status, 302);
  assert.equal(res.headers.get('location'), 'https://elite-cuts-4qn.pages.dev/');
  const withVar = await worker.fetch(new Request('https://api.test/'), { ...env, SITE_URL: 'https://example.test/' });
  assert.equal(withVar.headers.get('location'), 'https://example.test/');
});

// ---- Security fixes (Nov 2026 review) ----
test('manager sessions: random tokens, rejected after logout or expiry', async () => {
  const env = newEnv();
  const a = (await call(env, 'POST', '/api/manager/login', { pin: '4321' })).data;
  const b = (await call(env, 'POST', '/api/manager/login', { pin: '4321' })).data;
  assert.match(a.token, /^[0-9a-f]{64}$/);
  assert.notEqual(a.token, b.token, 'not derived from the PIN');
  assert.notEqual(a.token, await hmacHex('4321', `manager:${day(0)}`), 'old PIN-derived token no longer exists');
  assert.ok(a.expiresAt > new Date().toISOString());
  const A = { 'X-Manager-Token': a.token }, B = { 'X-Manager-Token': b.token };
  assert.equal((await call(env, 'GET', '/api/manager/bookings', undefined, A)).status, 200);
  assert.equal((await call(env, 'GET', '/api/manager/bookings', undefined, { 'X-Manager-Token': await hmacHex('4321', `manager:${day(0)}`) })).status, 401);
  assert.equal((await call(env, 'POST', '/api/manager/logout', undefined, A)).status, 200);
  assert.equal((await call(env, 'GET', '/api/manager/bookings', undefined, A)).status, 401, 'logged out');
  assert.equal((await call(env, 'GET', '/api/manager/bookings', undefined, B)).status, 200, 'other session unaffected');
  env.DB.raw.exec("UPDATE manager_sessions SET expires_at = '2000-01-01T00:00:00Z'");
  assert.equal((await call(env, 'GET', '/api/manager/bookings', undefined, B)).status, 401, 'expired');
  assert.equal(env.DB.raw.prepare('SELECT COUNT(*) n FROM manager_sessions WHERE token_hash = ?').get(a.token)?.n ?? 0, 0, 'raw token never stored');
});

test('manager PIN: shop-wide cap stops guessing from many addresses', async () => {
  const env = newEnv();
  for (let i = 0; i < 100; i++) {
    await call(env, 'POST', '/api/manager/login', { pin: '0000' }, { 'CF-Connecting-IP': `198.51.${Math.floor(i / 4)}.${i % 4}` });
  }
  const r = await call(env, 'POST', '/api/manager/login', { pin: '4321' }, { 'CF-Connecting-IP': '203.0.113.50' });
  assert.equal(r.status, 429);
  env.DB.raw.exec("UPDATE rate_limits SET window_start = '2000-01-01T00:00:00Z' WHERE bucket = 'login-fail:all'");
  assert.equal((await call(env, 'POST', '/api/manager/login', { pin: '4321' }, { 'CF-Connecting-IP': '203.0.113.50' })).status, 200, 'resets after the hour');
});

test('IPv6 addresses in one /64 count as one client', () => {
  const k = (ip) => clientKey(new Request('https://x', { headers: { 'CF-Connecting-IP': ip } }));
  assert.equal(k('2001:db8:1:2::1'), k('2001:0db8:0001:0002:ffff:1:2:3'));
  assert.notEqual(k('2001:db8:1:2::1'), k('2001:db8:1:3::1'));
  assert.equal(k('203.0.113.9'), '203.0.113.9');
});

test('booking input is checked: time, barber, date range, list sizes', async () => {
  const env = newEnv();
  const bad = async (over) => (await call(env, 'POST', '/api/bookings', booking(over))).status;
  assert.equal(await bad({ time: '11:00 AM ' }), 400, 'cannot dodge the one-per-slot rule with spaces');
  assert.equal(await bad({ time: '<img src=x onerror=alert(1)>' }), 400);
  assert.equal(await bad({ barberId: 'brb-1"><script>' }), 400);
  assert.equal(await bad({ barberName: 'x'.repeat(81) }), 400);
  assert.equal(await bad({ date: day(-5) }), 400, 'past');
  assert.equal(await bad({ date: day(400) }), 400, 'too far ahead');
  assert.equal(await bad({ services: Array(11).fill('Cut') }), 400);
  assert.equal(await bad({ services: [{ evil: true }] }), 400);
  assert.equal(await bad({}), 201);
});

test('bookings are rate-limited per address and earn no points by themselves', async () => {
  const env = newEnv();
  const ip = { 'CF-Connecting-IP': '203.0.113.77' };
  const slots = ['09:00 AM', '10:00 AM', '11:00 AM', '12:00 PM', '01:30 PM', '02:30 PM', '03:30 PM', '04:30 PM', '05:30 PM', '06:30 PM', '07:30 PM'];
  const codes = [];
  for (const time of slots) codes.push((await call(env, 'POST', '/api/bookings', booking({ time }), ip)).status);
  assert.deepEqual(codes.slice(0, 10), Array(10).fill(201));
  assert.equal(codes[10], 429);
  const l = await call(env, 'GET', '/api/loyalty?phone=5550102030');
  assert.equal(l.data.points, 0, '10 fake bookings = 0 points');
  assert.equal((await call(env, 'POST', '/api/bookings', booking({ time: '07:30 PM' }), { 'CF-Connecting-IP': '203.0.113.78' })).status, 201, 'other addresses unaffected');
});

test('loyalty lookups and running-late calls are rate-limited', async () => {
  const env = newEnv();
  const ip = { 'CF-Connecting-IP': '203.0.113.90' };
  let last;
  for (let i = 0; i < 31; i++) last = await call(env, 'GET', `/api/loyalty?phone=55500${String(i).padStart(5, '0')}`, undefined, ip);
  assert.equal(last.status, 429);
  for (let i = 0; i < 11; i++) last = await call(env, 'POST', '/api/bookings/late', { refCode: `EC-${1000 + i}`, phone: '5550102030', minutes: 5 }, ip);
  assert.equal(last.status, 429, 'ref codes cannot be guessed by brute force');
});

test('loyalty CSV neutralises spreadsheet formulas but keeps phone numbers', async () => {
  const env = newEnv();
  const b = (await call(env, 'POST', '/api/bookings', booking({ clientName: '=HYPERLINK("http://x","hi")', clientPhone: '+1 555 010 2030' }))).data.booking;
  const H = { 'X-Manager-Token': (await call(env, 'POST', '/api/manager/login', { pin: '4321' })).data.token };
  await call(env, 'PATCH', `/api/manager/bookings/${b.id}`, { status: 'Completed' }, H);
  const csv = (await call(env, 'GET', '/api/manager/loyalty.csv', undefined, H)).data;
  assert.match(csv, /\n"'=HYPERLINK\(""http:\/\/x"",""hi""\)","\+1 555 010 2030",100,/);
});
