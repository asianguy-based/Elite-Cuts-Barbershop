// Payments: Stripe Checkout deposits, full prepay and the VIP wallet. Run with: node --test test/
// Stripe is never called for real: globalThis.fetch is replaced by a fake that records each request.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, readdirSync } from 'node:fs';
import { DatabaseSync } from 'node:sqlite';
import worker, { hmacHex, stripeKeyInfo, priceServices } from '../src/index.js';

const schema = readFileSync(new URL('../schema.sql', import.meta.url), 'utf8');
const migrationsDir = new URL('../migrations/', import.meta.url);
const migrations = readdirSync(migrationsDir).filter((f) => f.endsWith('.sql')).sort()
  .map((f) => readFileSync(new URL(f, migrationsDir), 'utf8'));

function makeD1() {
  const db = new DatabaseSync(':memory:');
  db.exec('PRAGMA foreign_keys = ON;');
  db.exec(schema);
  migrations.forEach((m) => db.exec(m));
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
    async batch(list) {
      db.exec('BEGIN');
      try { list.forEach((s) => s._exec()); db.exec('COMMIT'); } catch (e) { db.exec('ROLLBACK'); throw e; }
      return list.map(() => ({ success: true }));
    }
  };
}

const ORIGIN = 'https://elite-cuts-barbershop.app';
const day = (n) => new Date(Date.now() + n * 86400000).toISOString().slice(0, 10);
const D = day(10);
const TEST_KEY = 'sk_test_51FakeKeyForUnitTests';
const newEnv = (over = {}) => ({
  DB: makeD1(), MANAGER_PIN: '4321', STRIPE_WEBHOOK_SECRET: 'whsec_test', STRIPE_SECRET_KEY: TEST_KEY,
  ALLOWED_ORIGINS: ORIGIN, ...over
});
let ipCounter = 0;
const call = async (env, method, path, body, headers = {}) => {
  const res = await worker.fetch(new Request('https://api.test' + path, {
    method,
    headers: { 'Content-Type': 'application/json', Origin: ORIGIN, 'CF-Connecting-IP': `198.51.100.${(ipCounter++ % 200) + 1}`, ...headers },
    body: body === undefined ? undefined : (typeof body === 'string' ? body : JSON.stringify(body))
  }), env);
  const type = res.headers.get('content-type') || '';
  return { status: res.status, data: type.includes('json') ? await res.json() : await res.text() };
};
const booking = (over = {}) => ({
  services: ['Cut'], totalCost: 1, totalMin: 45,
  barberId: 'brb-1', barberName: 'Marcus Vance', date: D, time: '11:00 AM',
  clientName: 'Jordan Lee', clientPhone: '(555) 010-2030', paymentMode: 'chair', ...over
});
const shop = (over = {}) => ({
  shopName: 'FADE HOUSE', depositAmount: 20,
  services: [
    { id: 'srv-1', name: 'Cut', price: 40, duration: 45, category: 'Hair', desc: '' },
    { id: 'srv-2', name: 'Beard', price: 25, duration: 25, category: 'Beard', desc: '' }
  ],
  barbers: [{ id: 'brb-1', firstName: 'Marcus', lastName: 'Vance', name: 'Marcus Vance', folder: 'marcus_vance', photoFilename: 'm.jpg', role: '', specialty: '', rating: '5.0', avatar: 'https://images.example.com/m.jpg' }],
  timeSlots: ['10:00 AM', '11:00 AM', '12:00 PM'],
  ...over
});
const login = async (env) => ({ 'X-Manager-Token': (await call(env, 'POST', '/api/manager/login', { pin: '4321' })).data.token });
const publish = async (env, over) => assert.equal((await call(env, 'PUT', '/api/manager/shop', shop(over), await login(env))).status, 200);

/** Fake Stripe: records requests, answers Checkout Session creates. */
function fakeStripe({ fail = false } = {}) {
  const calls = [];
  const real = globalThis.fetch;
  let n = 0;
  globalThis.fetch = async (url, init = {}) => {
    const form = new URLSearchParams(init.body || '');
    calls.push({ url: String(url), headers: init.headers || {}, form });
    if (fail) return new Response(JSON.stringify({ error: { message: 'boom' } }), { status: 500 });
    const id = `cs_test_${++n}`;
    return new Response(JSON.stringify({ id, url: `https://checkout.stripe.com/c/pay/${id}` }), { status: 200 });
  };
  return { calls, restore: () => { globalThis.fetch = real; } };
}

async function webhook(env, type, object) {
  const payload = JSON.stringify({ type, data: { object } });
  const t = Math.floor(Date.now() / 1000);
  const sig = `t=${t},v1=${await hmacHex('whsec_test', `${t}.${payload}`)}`;
  return call(env, 'POST', '/api/webhook/stripe', payload, { 'Stripe-Signature': sig, Origin: '' });
}
const points = async (env) => (await call(env, 'GET', '/api/loyalty?phone=5550102030')).data.points;
const status = (env, id) => ({ ...env.DB.raw.prepare('SELECT status, paid FROM bookings WHERE id = ?').get(id) });

test('only Stripe test keys may create Checkout pages', async () => {
  assert.equal(stripeKeyInfo({}).usable, false);
  assert.deepEqual(stripeKeyInfo({ STRIPE_SECRET_KEY: TEST_KEY }).usable, true);
  assert.equal(stripeKeyInfo({ STRIPE_SECRET_KEY: 'rk_test_abc' }).testMode, true);
  const live = stripeKeyInfo({ STRIPE_SECRET_KEY: 'sk_live_abc' });
  assert.equal(live.usable, false);
  assert.equal(live.reason, 'live_key_blocked');
  assert.equal(stripeKeyInfo({ STRIPE_SECRET_KEY: 'sk_live_abc', STRIPE_ALLOW_LIVE: 'true' }).usable, true);

  const info = (await call(newEnv({ STRIPE_SECRET_KEY: 'sk_live_abc' }), 'GET', '/api/payments')).data;
  assert.equal(info.stripe, false);
  assert.equal(info.liveKeyBlocked, true);
  assert.equal(info.options.prepay, false);
  const ok = (await call(newEnv(), 'GET', '/api/payments')).data;
  assert.deepEqual([ok.stripe, ok.testMode, ok.options.prepay, ok.options.walletTopUp, ok.depositAmount], [true, true, true, true, 15]);
  assert.deepEqual(ok.walletTopUps, [25, 50, 100]);
});

test('deposit: amount comes from the shop settings, Stripe Checkout opens, webhook marks it paid', async () => {
  const env = newEnv();
  await publish(env);
  const s = fakeStripe();
  let r;
  try {
    r = await call(env, 'POST', '/api/bookings', booking({ paymentMode: 'deposit', depositAmount: 1 }));
  } finally { s.restore(); }
  assert.equal(r.status, 201);
  assert.match(r.data.checkoutUrl, /^https:\/\/checkout\.stripe\.com\//);
  assert.equal(r.data.testMode, true);
  const b = r.data.booking;
  assert.deepEqual([b.status, b.payOption, b.amountDue, b.depositAmount], ['Deposit Unpaid', 'deposit', 20, 20]);
  assert.equal(s.calls.length, 1);
  const { form, headers } = s.calls[0];
  assert.equal(headers.Authorization, `Bearer ${TEST_KEY}`);
  assert.ok(headers['Idempotency-Key']);
  assert.equal(form.get('line_items[0][price_data][unit_amount]'), '2000', 'the $1 the client sent is ignored');
  assert.equal(form.get('client_reference_id'), b.refCode);
  assert.equal(form.get('metadata[booking_id]'), b.id);
  assert.ok(form.get('success_url').startsWith(`${ORIGIN}/?tab=loyalty&paid=`));
  assert.ok(Number(form.get('expires_at')) >= Math.floor(Date.now() / 1000) + 30 * 60);

  assert.equal(await points(env), 0, 'no points before payment');
  assert.equal((await webhook(env, 'checkout.session.completed', { id: 'cs_test_1', client_reference_id: b.refCode, payment_status: 'paid', metadata: { kind: 'booking' } })).status, 200);
  assert.deepEqual(status(env, b.id), { status: 'Paid', paid: 1 });
  assert.equal(await points(env), 150);
});

test('deposit with no usable key keeps the old payment-link flow', async () => {
  const env = newEnv({ STRIPE_SECRET_KEY: 'sk_live_realmoney' });
  const s = fakeStripe();
  let r;
  try { r = await call(env, 'POST', '/api/bookings', booking({ paymentMode: 'deposit', depositAmount: 15 })); } finally { s.restore(); }
  assert.equal(r.status, 201);
  assert.equal(r.data.checkoutUrl, undefined);
  assert.equal(s.calls.length, 0, 'a live key is never used to charge');
  assert.equal(r.data.booking.status, 'Deposit Unpaid');
  assert.equal(r.data.booking.depositAmount, 15);
});

test('prepay: full price from the published price list', async () => {
  const env = newEnv();
  const s = fakeStripe();
  try {
    const unpublished = await call(env, 'POST', '/api/bookings', booking({ paymentMode: 'prepay' }));
    assert.equal(unpublished.status, 400);
    assert.match(unpublished.data.error, /publish its services/);
    await publish(env);
    const r = await call(env, 'POST', '/api/bookings', booking({ paymentMode: 'prepay', services: ['Cut', 'Beard'] }));
    assert.equal(r.status, 201);
    assert.equal(r.data.booking.totalCost, 65, 'server total, not the client\'s $1');
    assert.equal(r.data.booking.amountDue, 65);
    assert.equal(r.data.booking.payOption, 'prepay');
    assert.equal(s.calls.at(-1).form.get('line_items[0][price_data][unit_amount]'), '6500');
    const ghost = await call(env, 'POST', '/api/bookings', booking({ paymentMode: 'prepay', services: ['Free Cut'], time: '12:00 PM' }));
    assert.equal(ghost.status, 400);
    assert.match(ghost.data.error, /not one of this shop's services/);
  } finally { s.restore(); }
  const noKey = newEnv({ STRIPE_SECRET_KEY: '' });
  await publish(noKey);
  assert.equal((await call(noKey, 'POST', '/api/bookings', booking({ paymentMode: 'prepay' }))).status, 503);
});

test('manager can switch payment options off; required deposit blocks pay-at-chair', async () => {
  const env = newEnv();
  await publish(env, { prepayEnabled: false, walletEnabled: false, requireDeposit: true });
  const r = await call(env, 'POST', '/api/bookings', booking({ paymentMode: 'prepay' }));
  assert.equal(r.status, 400);
  assert.match(r.data.error, /turned off/);
  assert.equal((await call(env, 'POST', '/api/bookings', booking({ paymentMode: 'wallet', walletPin: '1234' }))).status, 400);
  assert.equal((await call(env, 'POST', '/api/bookings', booking({ paymentMode: 'chair' }))).status, 400);
  const info = (await call(env, 'GET', '/api/payments')).data;
  assert.deepEqual([info.options.deposit, info.options.prepay, info.options.wallet, info.depositAmount], [true, false, false, 20]);
  assert.equal((await call(env, 'POST', '/api/wallet/topup', { phone: '5550102030', pin: '1234', amount: 25 })).status, 400);
});

test('Stripe failure frees the chair; an expired checkout cancels the unpaid booking', async () => {
  const env = newEnv();
  await publish(env);
  let s = fakeStripe({ fail: true });
  try {
    const r = await call(env, 'POST', '/api/bookings', booking({ paymentMode: 'deposit' }));
    assert.equal(r.status, 502);
  } finally { s.restore(); }
  assert.deepEqual((await call(env, 'GET', `/api/slots?date=${D}&barberId=brb-1`)).data.booked, []);

  s = fakeStripe();
  let a, b;
  try {
    a = (await call(env, 'POST', '/api/bookings', booking({ paymentMode: 'deposit' }))).data.booking;
    b = (await call(env, 'POST', '/api/bookings', booking({ paymentMode: 'deposit', time: '12:00 PM' }))).data.booking;
  } finally { s.restore(); }
  await webhook(env, 'checkout.session.completed', { id: 'cs_test_2', client_reference_id: b.refCode, payment_status: 'paid' });
  await webhook(env, 'checkout.session.expired', { id: 'cs_test_1', client_reference_id: a.refCode, status: 'expired', metadata: { kind: 'booking' } });
  await webhook(env, 'checkout.session.expired', { id: 'cs_test_2', client_reference_id: b.refCode, status: 'expired' });
  assert.equal(status(env, a.id).status, 'Cancelled', 'abandoned checkout frees the chair');
  assert.equal(status(env, b.id).status, 'Paid', 'a paid booking is never cancelled by an expiry');
  assert.deepEqual((await call(env, 'GET', `/api/slots?date=${D}&barberId=brb-1`)).data.booked, ['12:00 PM']);
});

test('a pending card payment is only marked paid when it succeeds', async () => {
  const env = newEnv();
  await publish(env);
  const s = fakeStripe();
  let b;
  try { b = (await call(env, 'POST', '/api/bookings', booking({ paymentMode: 'prepay' }))).data.booking; } finally { s.restore(); }
  await webhook(env, 'checkout.session.completed', { id: 'cs_test_1', client_reference_id: b.refCode, payment_status: 'unpaid' });
  assert.equal(status(env, b.id).paid, 0);
  await webhook(env, 'checkout.session.async_payment_succeeded', { id: 'cs_test_1', client_reference_id: b.refCode, payment_status: 'paid' });
  assert.equal(status(env, b.id).paid, 1);
  assert.equal((await webhook(env, 'payment_intent.created', { id: 'pi_1' })).status, 200, 'other events are ignored');
});

test('VIP wallet: PIN-protected top-up, credited once by the webhook, spent on a booking', async () => {
  const env = newEnv();
  await publish(env);
  const phone = '5550102030';
  const s = fakeStripe();
  try {
    assert.equal((await call(env, 'POST', '/api/wallet', { phone, pin: '1234' })).status, 404, 'no wallet yet');
    assert.equal((await call(env, 'POST', '/api/wallet/topup', { phone, pin: '12', amount: 50 })).status, 400, 'PIN too short');
    assert.equal((await call(env, 'POST', '/api/wallet/topup', { phone, pin: '1234', amount: 2 })).status, 400, 'below $5');
    assert.equal((await call(env, 'POST', '/api/wallet/topup', { phone, pin: '1234', amount: 12.5 })).status, 400, 'whole dollars');
    const t = await call(env, 'POST', '/api/wallet/topup', { phone, pin: '1234', amount: 50, name: 'Jordan' });
    assert.equal(t.status, 200);
    assert.match(t.data.checkoutUrl, /checkout\.stripe\.com/);
    const form = s.calls.at(-1).form;
    assert.equal(form.get('line_items[0][price_data][unit_amount]'), '5000');
    assert.equal(form.get('metadata[kind]'), 'wallet_topup');
    assert.equal(form.get('metadata[phone]'), phone);
    assert.equal((await call(env, 'POST', '/api/wallet/topup', { phone, pin: '9999', amount: 50 })).status, 401, 'PIN is set now');
  } finally { s.restore(); }

  // Booking before the money lands: refused, chair stays free.
  const short = await call(env, 'POST', '/api/bookings', booking({ paymentMode: 'wallet', walletPin: '1234' }));
  assert.equal(short.status, 402);
  assert.deepEqual((await call(env, 'GET', `/api/slots?date=${D}&barberId=brb-1`)).data.booked, []);
  assert.equal(env.DB.raw.prepare('SELECT COUNT(*) AS n FROM bookings').get().n, 0, 'rolled back');

  const paid = { id: 'cs_test_1', payment_status: 'paid', amount_total: 5000, metadata: { kind: 'wallet_topup', phone } };
  await webhook(env, 'checkout.session.completed', paid);
  await webhook(env, 'checkout.session.completed', paid); // Stripe retry
  assert.equal((await call(env, 'POST', '/api/wallet', { phone, pin: '1234' })).data.balance, 50, 'credited once');

  assert.equal((await call(env, 'POST', '/api/bookings', booking({ paymentMode: 'wallet', walletPin: '0000' }))).status, 401);
  const r = await call(env, 'POST', '/api/bookings', booking({ paymentMode: 'wallet', walletPin: '1234' }));
  assert.equal(r.status, 201);
  assert.equal(r.data.checkoutUrl, undefined);
  assert.deepEqual([r.data.booking.status, r.data.booking.paid, r.data.booking.payOption, r.data.booking.amountDue], ['Paid', true, 'wallet', 40]);
  assert.equal(await points(env), 150);
  const w = (await call(env, 'POST', '/api/wallet', { phone, pin: '1234' })).data;
  assert.equal(w.balance, 10);
  assert.deepEqual(w.history.map((h) => [h.kind, h.amount]), [['spend', -40], ['topup', 50]]);
  assert.equal((await call(env, 'POST', '/api/bookings', booking({ paymentMode: 'wallet', walletPin: '1234', time: '12:00 PM' }))).status, 402);

  // Manager cancels the wallet booking: the $40 goes back once.
  const H = await login(env);
  await call(env, 'PATCH', `/api/manager/bookings/${r.data.booking.id}`, { status: 'Cancelled' }, H);
  await call(env, 'PATCH', `/api/manager/bookings/${r.data.booking.id}`, { status: 'Cancelled' }, H);
  assert.equal((await call(env, 'POST', '/api/wallet', { phone, pin: '1234' })).data.balance, 50);
});

test('VIP wallet: wrong PINs lock the wallet; manager list, adjust and PIN reset', async () => {
  const env = newEnv();
  const phone = '5550102030';
  const H = await login(env);
  assert.equal((await call(env, 'POST', `/api/manager/wallets/${phone}/adjust`, { amount: -5 }, H)).status, 400, 'cannot go below $0');
  const add = await call(env, 'POST', `/api/manager/wallets/${phone}/adjust`, { amount: 30, note: 'Cash load' }, H);
  assert.equal(add.data.balance, 30);
  assert.equal((await call(env, 'POST', `/api/manager/wallets/${phone}/adjust`, { amount: 30 })).status, 401, 'manager only');

  // A wallet the manager created has no PIN: the client's first PIN sets it.
  assert.equal((await call(env, 'POST', '/api/wallet', { phone, pin: '2468' })).data.balance, 30);
  for (let i = 0; i < 5; i++) assert.equal((await call(env, 'POST', '/api/wallet', { phone, pin: '1111' })).status, 401);
  assert.equal((await call(env, 'POST', '/api/wallet', { phone, pin: '2468' })).status, 429, 'locked even with the right PIN');

  const list = (await call(env, 'GET', '/api/manager/wallets', undefined, H)).data.wallets;
  assert.deepEqual(list.map((w) => [w.phone, w.balance, w.hasPin]), [[phone, 30, true]]);
  assert.equal((await call(env, 'POST', `/api/manager/wallets/${phone}/reset-pin`, undefined, H)).status, 200);
  assert.equal((await call(env, 'POST', '/api/wallet', { phone, pin: '1357' })).data.balance, 30, 'reset clears the lock; new PIN set');
  assert.equal((await call(env, 'POST', '/api/wallet', { phone, pin: '2468' })).status, 401, 'old PIN no longer works');
  assert.equal(env.DB.raw.prepare('SELECT pin_hash FROM wallet_accounts').get().pin_hash.includes('1357'), false);
  assert.equal((await call(env, 'POST', '/api/manager/wallets/999/reset-pin', undefined, H)).status, 404);
});

test('payment settings are validated', async () => {
  const env = newEnv();
  const H = await login(env);
  const bad = async (body, re) => {
    const r = await call(env, 'PUT', '/api/manager/shop', body, H);
    assert.equal(r.status, 400, JSON.stringify(body));
    assert.match(r.data.error, re);
  };
  await bad({ prepayEnabled: 'yes' }, /true or false/);
  await bad({ walletTopUps: [] }, /1 to 6/);
  await bad({ walletTopUps: [2] }, /walletTopUps\[0\]/);
  await bad({ walletTopUps: [25, 25] }, /repeat/);
  const ok = await call(env, 'PUT', '/api/manager/shop', { walletTopUps: [100, 25], depositEnabled: true }, H);
  assert.deepEqual(ok.data.settings.walletTopUps, [25, 100]);
  assert.deepEqual(priceServices(null, ['Cut']).error !== undefined, true);
});
