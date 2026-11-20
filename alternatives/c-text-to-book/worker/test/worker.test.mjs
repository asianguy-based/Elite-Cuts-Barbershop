// End-to-end tests for the D1 worker, run with plain Node (22+), no Cloudflare tooling:
//   node --test worker/test/
// A tiny D1 stand-in wraps Node's built-in SQLite and loads the real schema.sql,
// so the same constraints that protect production are exercised here.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { DatabaseSync } from 'node:sqlite';
import worker, { verifyStripeSignature, hmacHex, cors } from '../src/index.js';

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

const ORIGIN = 'http://localhost:8203';
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
  barberId: 'brb-1', barberName: 'Marcus Vance', date: '2026-12-01', time: '11:00 AM',
  clientName: 'Jordan Lee', clientPhone: '(555) 010-2030', paymentMode: 'chair', ...over
});

test('booking, slots and loyalty round trip', async () => {
  const env = newEnv();
  const r = await call(env, 'POST', '/api/bookings', booking());
  assert.equal(r.status, 201);
  assert.match(r.data.booking.refCode, /^EC-\d{4}/);
  assert.deepEqual(r.data.booking.services, ['The Executive Cut & Style']);
  assert.equal(r.data.booking.status, 'Confirmed');
  const s = await call(env, 'GET', '/api/slots?date=2026-12-01&barberId=brb-1');
  assert.deepEqual(s.data.booked, ['11:00 AM']);
  const l = await call(env, 'GET', '/api/loyalty?phone=5550102030');
  assert.equal(l.data.points, 100);
  assert.equal(l.data.stamps, 1);
  assert.equal(l.data.history[0].refCode, r.data.booking.refCode);
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
  await call(env, 'POST', '/api/bookings', booking());
  assert.equal((await call(env, 'GET', '/api/manager/bookings?from=2026-01-01')).status, 401);
  assert.equal((await call(env, 'POST', '/api/manager/login', { pin: '0000' })).status, 401);
  const H = { 'X-Manager-Token': (await call(env, 'POST', '/api/manager/login', { pin: '4321' })).data.token };
  const list = await call(env, 'GET', '/api/manager/bookings?from=2026-01-01', undefined, H);
  assert.equal(list.data.bookings.length, 1);
  const csv = await call(env, 'GET', '/api/manager/loyalty.csv', undefined, H);
  assert.match(csv.data, /^name,phone,points,stamps,lastVisit\n"Jordan Lee","\(555\) 010-2030",100,1,"2026-12-01"\n$/);
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
