// Admin Portal update: Clear Cancelled, credit-back emails, client reviews. Run with: node --test test/
// No real email is ever sent: globalThis.fetch is replaced by a fake that records each request.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, readdirSync } from 'node:fs';
import { DatabaseSync } from 'node:sqlite';
import worker, { isEmail, sendEmail, validateReview } from '../src/index.js';

const schema = readFileSync(new URL('../schema.sql', import.meta.url), 'utf8');
const migrationsDir = new URL('../migrations/', import.meta.url);
const migrationFiles = readdirSync(migrationsDir).filter((f) => f.endsWith('.sql')).sort();
const migration = (f) => readFileSync(new URL(f, migrationsDir), 'utf8');

function makeD1({ beforeLast } = {}) {
  const db = new DatabaseSync(':memory:');
  db.exec('PRAGMA foreign_keys = ON;');
  db.exec(schema);
  migrationFiles.forEach((f, i) => {
    if (i === migrationFiles.length - 1 && beforeLast) beforeLast(db);
    db.exec(migration(f));
  });
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
const newEnv = (over = {}) => ({ DB: makeD1(), MANAGER_PIN: '4321', ALLOWED_ORIGINS: ORIGIN, ...over });
let ipCounter = 0;
const call = async (env, method, path, body, headers = {}) => {
  const res = await worker.fetch(new Request('https://api.test' + path, {
    method,
    headers: { 'Content-Type': 'application/json', Origin: ORIGIN, 'CF-Connecting-IP': `203.0.113.${(ipCounter++ % 200) + 1}`, ...headers },
    body: body === undefined ? undefined : JSON.stringify(body)
  }), env);
  const type = res.headers.get('content-type') || '';
  return { status: res.status, data: type.includes('json') ? await res.json() : await res.text() };
};
const booking = (over = {}) => ({
  services: ['Cut'], totalCost: 40, totalMin: 45,
  barberId: 'brb-1', barberName: 'Marcus Vance', date: D, time: '11:00 AM',
  clientName: 'Jordan Lee', clientPhone: '(555) 010-2030', paymentMode: 'chair', ...over
});
const shop = (over = {}) => ({
  shopName: 'FADE HOUSE',
  services: [{ id: 'srv-1', name: 'Cut', price: 40, duration: 45, category: 'Hair', desc: '' }],
  barbers: [{ id: 'brb-1', firstName: 'Marcus', lastName: 'Vance', name: 'Marcus Vance', folder: 'marcus_vance', photoFilename: 'm.jpg', role: '', specialty: '', rating: '5.0', avatar: 'https://images.example.com/m.jpg' }],
  timeSlots: ['10:00 AM', '11:00 AM', '12:00 PM'],
  ...over
});
const login = async (env) => ({ 'X-Manager-Token': (await call(env, 'POST', '/api/manager/login', { pin: '4321' })).data.token });

/** Fake email provider: records every request, answers 200 (or 500 with fail). */
function fakeMail({ fail = false } = {}) {
  const calls = [];
  const real = globalThis.fetch;
  globalThis.fetch = async (url, init = {}) => {
    calls.push({ url: String(url), headers: init.headers || {}, body: JSON.parse(init.body || '{}') });
    return new Response(JSON.stringify(fail ? { error: 'boom' } : { id: 'em_1' }), { status: fail ? 500 : 200 });
  };
  return { calls, restore: () => { globalThis.fetch = real; } };
}

/** A $50 wallet (loaded by the manager, PIN 1234) and a $40 wallet booking. */
async function walletBooking(env, H, over = {}) {
  assert.equal((await call(env, 'PUT', '/api/manager/shop', shop(), H)).status, 200);
  assert.equal((await call(env, 'POST', '/api/manager/wallets/5550102030/adjust', { amount: 50 }, H)).status, 200);
  assert.equal((await call(env, 'POST', '/api/wallet', { phone: '5550102030', pin: '1234' })).data.balance, 50);
  const r = await call(env, 'POST', '/api/bookings', booking({ paymentMode: 'wallet', walletPin: '1234', ...over }));
  assert.equal(r.status, 201, JSON.stringify(r.data));
  return r.data.booking;
}

test('Clear Cancelled hides cancelled bookings on the server, keeps the rows and everything else', async () => {
  const env = newEnv();
  const H = await login(env);
  const a = (await call(env, 'POST', '/api/bookings', booking())).data.booking;
  const b = (await call(env, 'POST', '/api/bookings', booking({ time: '12:00 PM' }))).data.booking;
  await call(env, 'PATCH', `/api/manager/bookings/${a.id}`, { status: 'Cancelled' }, H);

  assert.equal((await call(env, 'POST', '/api/manager/bookings/clear-cancelled')).status, 401, 'manager only');
  const r = await call(env, 'POST', '/api/manager/bookings/clear-cancelled', undefined, H);
  assert.deepEqual([r.status, r.data.cleared], [200, 1]);
  const list = (await call(env, 'GET', '/api/manager/bookings', undefined, H)).data.bookings;
  assert.deepEqual(list.map((x) => x.id), [b.id], 'only the active booking is left in the queue');
  assert.equal(env.DB.raw.prepare('SELECT COUNT(*) AS n FROM bookings').get().n, 2, 'row kept for the ledgers');
  assert.equal((await call(env, 'POST', '/api/manager/bookings/clear-cancelled', undefined, H)).data.cleared, 0, 'nothing left to clear');

  // The freed slot can still be booked, and a later cancellation shows up until it is cleared too.
  assert.equal((await call(env, 'POST', '/api/bookings', booking({ clientPhone: '555 999 0000' }))).status, 201);
});

test('wallet credit back: refunded once, client emailed, phone taken off the cancelled appointment', async () => {
  const env = newEnv({ RESEND_API_KEY: 're_test_key', EMAIL_FROM: 'Fade House <bookings@example.com>' });
  const H = await login(env);
  const bk = await walletBooking(env, H, { clientEmail: 'jordan@example.com' });
  assert.equal(env.DB.raw.prepare('SELECT email FROM customers').get().email, 'jordan@example.com');

  const mail = fakeMail();
  let r;
  try {
    r = await call(env, 'PATCH', `/api/manager/bookings/${bk.id}`, { status: 'Cancelled' }, H);
    const again = await call(env, 'PATCH', `/api/manager/bookings/${bk.id}`, { status: 'Cancelled' }, H);
    assert.equal(again.data.creditReturned, undefined, 'second cancel returns nothing');
    assert.equal(again.data.email, undefined);
  } finally { mail.restore(); }

  assert.equal(r.status, 200);
  assert.equal(r.data.creditReturned, 40);
  assert.equal(r.data.email, 'sent');
  assert.equal(r.data.booking.clientPhone, '', 'phone taken off the appointment');
  assert.equal(mail.calls.length, 1, 'one email, even when cancelled twice');
  const sent = mail.calls[0];
  assert.equal(sent.url, 'https://api.resend.com/emails');
  assert.equal(sent.headers.Authorization, 'Bearer re_test_key');
  assert.deepEqual(sent.body.to, ['jordan@example.com']);
  assert.equal(sent.body.from, 'Fade House <bookings@example.com>');
  assert.match(sent.body.subject, /\$40\.00 is back in your VIP wallet/);
  assert.match(sent.body.text, new RegExp(`${bk.refCode}.*cancelled`));
  assert.match(sent.body.text, /balance is now \$50\.00/);

  assert.equal((await call(env, 'POST', '/api/wallet', { phone: '5550102030', pin: '1234' })).data.balance, 50, 'credit back once');
  const history = (await call(env, 'GET', '/api/loyalty?phone=5550102030')).data.history;
  assert.equal(history.some((h) => h.refCode === bk.refCode), false, 'cancelled appointment no longer listed under the number');
  assert.equal(env.DB.raw.prepare('SELECT COUNT(*) AS n FROM customers').get().n, 1, 'client record kept');
});

test('credit back without email set up, without an address, or when the email fails: cancel still works', async () => {
  // Not configured: no request is made at all.
  let env = newEnv();
  let H = await login(env);
  let bk = await walletBooking(env, H, { clientEmail: 'jordan@example.com' });
  let mail = fakeMail();
  try {
    const r = await call(env, 'PATCH', `/api/manager/bookings/${bk.id}`, { status: 'Cancelled' }, H);
    assert.deepEqual([r.data.creditReturned, r.data.email, r.data.booking.status], [40, 'not_configured', 'Cancelled']);
    assert.equal(mail.calls.length, 0);
  } finally { mail.restore(); }

  // Configured, but the client gave no email.
  env = newEnv({ RESEND_API_KEY: 're_test_key', EMAIL_FROM: 'bookings@example.com' });
  H = await login(env);
  bk = await walletBooking(env, H);
  mail = fakeMail();
  try {
    const r = await call(env, 'PATCH', `/api/manager/bookings/${bk.id}`, { status: 'Cancelled' }, H);
    assert.deepEqual([r.data.creditReturned, r.data.email], [40, 'no_address']);
    assert.equal(mail.calls.length, 0);
  } finally { mail.restore(); }

  // The provider errors: the credit still goes back.
  env = newEnv({ RESEND_API_KEY: 're_test_key', EMAIL_FROM: 'bookings@example.com' });
  H = await login(env);
  bk = await walletBooking(env, H, { clientEmail: 'jordan@example.com' });
  mail = fakeMail({ fail: true });
  try {
    const r = await call(env, 'PATCH', `/api/manager/bookings/${bk.id}`, { status: 'Cancelled' }, H);
    assert.deepEqual([r.status, r.data.creditReturned, r.data.email], [200, 40, 'failed']);
  } finally { mail.restore(); }
  assert.equal((await call(env, 'POST', '/api/wallet', { phone: '5550102030', pin: '1234' })).data.balance, 50);
});

test('card and pay-at-chair cancellations keep the phone and send nothing', async () => {
  const env = newEnv({ RESEND_API_KEY: 're_test_key', EMAIL_FROM: 'bookings@example.com' });
  const H = await login(env);
  const bk = (await call(env, 'POST', '/api/bookings', booking({ clientEmail: 'jordan@example.com' }))).data.booking;
  const mail = fakeMail();
  try {
    const r = await call(env, 'PATCH', `/api/manager/bookings/${bk.id}`, { status: 'Cancelled' }, H);
    assert.equal(r.data.creditReturned, undefined);
    assert.equal(r.data.booking.clientPhone, '(555) 010-2030');
    assert.equal(mail.calls.length, 0);
  } finally { mail.restore(); }
});

test('client email is optional and checked', async () => {
  const env = newEnv();
  assert.equal((await call(env, 'POST', '/api/bookings', booking({ clientEmail: 'not an email' }))).status, 400);
  assert.equal((await call(env, 'POST', '/api/bookings', booking({ clientEmail: '' }))).status, 201);
  assert.equal(isEmail('a@b.co'), true);
  assert.equal(isEmail('a@b'), false);
  assert.equal(isEmail('x'.repeat(120) + '@b.co'), false);
  // A later booking without an email keeps the one on file.
  await call(env, 'POST', '/api/bookings', booking({ time: '12:00 PM', clientEmail: 'jordan@example.com' }));
  await call(env, 'POST', '/api/bookings', booking({ time: '10:00 AM' }));
  assert.equal(env.DB.raw.prepare('SELECT email FROM customers').get().email, 'jordan@example.com');
  assert.equal(await sendEmail({}, { to: 'a@b.co', subject: 's', text: 't' }), 'not_configured');
});

test('client reviews: logged unread and hidden; a tick publishes, an untick or delete removes', async () => {
  const env = newEnv();
  const H = await login(env);
  assert.equal((await call(env, 'POST', '/api/reviews', { name: 'Ana', stars: 5, text: '' })).status, 400, 'text required');
  assert.equal((await call(env, 'POST', '/api/reviews', { name: 'Ana', stars: 9, text: 'Great' })).status, 400, 'stars 1-5');
  assert.equal((await call(env, 'POST', '/api/reviews', { name: 'Ana', stars: 5, text: 'Best fade in town' })).status, 201);
  assert.equal((await call(env, 'POST', '/api/reviews', { name: 'Bo', stars: 4, text: 'Quick and clean' })).status, 201);

  assert.equal((await call(env, 'GET', '/api/shop')).data.settings, null, 'nothing published by a client review');
  assert.equal((await call(env, 'GET', '/api/manager/reviews')).status, 401, 'manager only');
  let log = (await call(env, 'GET', '/api/manager/reviews', undefined, H)).data;
  assert.equal(log.unread, 2);
  assert.deepEqual(log.reviews.map((r) => [r.name, r.shown, r.source]).sort(), [['Ana', false, 'client'], ['Bo', false, 'client']]);

  const ana = log.reviews.find((r) => r.name === 'Ana');
  const tick = await call(env, 'PATCH', `/api/manager/reviews/${ana.id}`, { shown: true }, H);
  assert.equal(tick.status, 200);
  assert.deepEqual(tick.data.settings.reviews, [{ name: 'Ana', stars: 5, text: 'Best fade in town' }]);
  assert.deepEqual((await call(env, 'GET', '/api/shop')).data.settings.reviews, [{ name: 'Ana', stars: 5, text: 'Best fade in town' }]);

  // The manager adds one by hand (e.g. from Google); it is shown straight away.
  const add = await call(env, 'POST', '/api/manager/reviews', { name: 'Cy', stars: 5, text: 'From Google' }, H);
  assert.equal(add.status, 201);
  assert.equal(add.data.settings.reviews.length, 2);

  await call(env, 'POST', '/api/manager/reviews/read', undefined, H);
  log = (await call(env, 'GET', '/api/manager/reviews', undefined, H)).data;
  assert.equal(log.unread, 0);

  const untick = await call(env, 'PATCH', `/api/manager/reviews/${ana.id}`, { shown: false }, H);
  assert.deepEqual(untick.data.settings.reviews.map((r) => r.name), ['Cy']);
  const del = await call(env, 'DELETE', `/api/manager/reviews/${add.data.review.id}`, undefined, H);
  assert.equal(del.status, 200);
  assert.deepEqual((await call(env, 'GET', '/api/shop')).data.settings.reviews, []);
  assert.equal((await call(env, 'DELETE', '/api/manager/reviews/9999', undefined, H)).status, 404);
  assert.equal((await call(env, 'PATCH', `/api/manager/reviews/${ana.id}`, { shown: 'yes' }, H)).status, 400);
});

test('ticking a review keeps the rest of the published settings', async () => {
  const env = newEnv();
  const H = await login(env);
  await call(env, 'PUT', '/api/manager/shop', shop(), H);
  await call(env, 'POST', '/api/reviews', { name: 'Ana', stars: 5, text: 'Great' });
  const id = (await call(env, 'GET', '/api/manager/reviews', undefined, H)).data.reviews[0].id;
  await call(env, 'PATCH', `/api/manager/reviews/${id}`, { shown: true }, H);
  const s = (await call(env, 'GET', '/api/shop')).data.settings;
  assert.equal(s.shopName, 'FADE HOUSE');
  assert.equal(s.barbers.length, 1);
  assert.equal(s.reviews.length, 1);
});

test('an older app that saves the whole review list keeps the Client Reviews log in step', async () => {
  const env = newEnv();
  const H = await login(env);
  await call(env, 'POST', '/api/reviews', { name: 'Ana', stars: 5, text: 'Great' });   // logged, hidden
  const r1 = await call(env, 'PUT', '/api/manager/shop', shop({ reviews: [{ name: 'Lee', stars: 4, text: 'Quick and clean.' }] }), H);
  assert.equal(r1.status, 200);
  assert.deepEqual(r1.data.settings.reviews, [{ name: 'Lee', stars: 4, text: 'Quick and clean.' }]);
  let log = (await call(env, 'GET', '/api/manager/reviews', undefined, H)).data.reviews;
  assert.deepEqual(log.map((r) => [r.text, r.shown]).sort(), [['Great', false], ['Quick and clean.', true]]);
  // Saving the same list again adds nothing; dropping a review only unticks it.
  await call(env, 'PUT', '/api/manager/shop', { reviews: [{ name: 'Lee', stars: 4, text: 'Quick and clean.' }] }, H);
  await call(env, 'PUT', '/api/manager/shop', { reviews: [] }, H);
  log = (await call(env, 'GET', '/api/manager/reviews', undefined, H)).data.reviews;
  assert.equal(log.length, 2);
  assert.ok(log.every((r) => !r.shown));
  const s = (await call(env, 'GET', '/api/shop')).data.settings;
  assert.deepEqual(s.reviews, []);
  assert.equal(s.shopName, 'FADE HOUSE');
  // A save without reviews leaves them alone.
  const id = log.find((r) => r.text === 'Great').id;
  await call(env, 'PATCH', `/api/manager/reviews/${id}`, { shown: true }, H);
  await call(env, 'PUT', '/api/manager/shop', { shopName: 'FADE HOUSE 2' }, H);
  assert.deepEqual((await call(env, 'GET', '/api/shop')).data.settings.reviews, [{ name: 'Ana', stars: 5, text: 'Great' }]);
});

test('reviews are rate-limited per address and cleaned', async () => {
  const env = newEnv();
  const ip = { 'CF-Connecting-IP': '192.0.2.77' };
  for (let i = 0; i < 3; i++) assert.equal((await call(env, 'POST', '/api/reviews', { stars: 5, text: `ok ${i}` }, ip)).status, 201);
  assert.equal((await call(env, 'POST', '/api/reviews', { stars: 5, text: 'one more' }, ip)).status, 429);
  assert.deepEqual(validateReview({ stars: '4', text: '  Nice  ' }).review, { name: 'Client', stars: 4, text: 'Nice' });
  assert.ok(validateReview({ stars: 5, text: 'x'.repeat(601) }).error);
});

test('migration keeps the reviews that were already published, ticked', async () => {
  const published = { shopName: 'FADE HOUSE', reviews: [{ name: 'Old A', stars: 5, text: 'First' }, { name: '', stars: 3, text: 'Second' }] };
  const env = newEnv({
    DB: makeD1({ beforeLast: (db) => db.prepare('INSERT INTO shop_settings (id, data, updated_at) VALUES (1, ?, ?)').run(JSON.stringify(published), 'now') })
  });
  const H = await login(env);
  const log = (await call(env, 'GET', '/api/manager/reviews', undefined, H)).data;
  assert.deepEqual(log.reviews.map((r) => [r.name, r.stars, r.text, r.shown, r.read]),
    [['Old A', 5, 'First', true, true], ['Client', 3, 'Second', true, true]]);
  // Unticking one republishes the other, in the original order.
  await call(env, 'POST', '/api/reviews', { name: 'New', stars: 5, text: 'Third' });
  const newId = (await call(env, 'GET', '/api/manager/reviews', undefined, H)).data.reviews.find((r) => r.name === 'New').id;
  const r = await call(env, 'PATCH', `/api/manager/reviews/${newId}`, { shown: true }, H);
  assert.deepEqual(r.data.settings.reviews.map((x) => x.text), ['Third', 'First', 'Second']);
});
