// Client side of the shared shop settings, run with plain Node (22+), no browser:
//   node --test tests/shared-settings.test.mjs
// The app modules are loaded with a fake localStorage / sessionStorage and a fetch that is
// answered by the REAL worker (worker/src/index.js) over an in-memory SQLite database, so the
// browser code and the API are checked together.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { DatabaseSync } from 'node:sqlite';

const memStore = () => {
  const m = new Map();
  return { getItem: (k) => (m.has(k) ? m.get(k) : null), setItem: (k, v) => m.set(k, String(v)), removeItem: (k) => m.delete(k), clear: () => m.clear() };
};
globalThis.localStorage = memStore();
globalThis.sessionStorage = memStore();

const worker = (await import('../worker/src/index.js')).default;
const { SHOP_SETTINGS_FIELDS, validateShopSettings } = await import('../worker/src/index.js');
const schema = readFileSync(new URL('../worker/schema.sql', import.meta.url), 'utf8');

function makeD1() {
  const db = new DatabaseSync(':memory:');
  db.exec(schema);
  const stmt = (sql, args = []) => ({
    bind: (...a) => stmt(sql, a),
    first: async () => db.prepare(sql).get(...args) ?? null,
    all: async () => ({ results: db.prepare(sql).all(...args) }),
    run: async () => { const r = db.prepare(sql).run(...args); return { meta: { changes: Number(r.changes) } }; },
    _exec: () => db.prepare(sql).run(...args)
  });
  return {
    prepare: (sql) => stmt(sql),
    async batch(list) {
      db.exec('BEGIN');
      try { list.forEach((s) => s._exec()); db.exec('COMMIT'); } catch (e) { db.exec('ROLLBACK'); throw e; }
      return list.map(() => ({ success: true }));
    }
  };
}

const API = 'https://api.test';
const env = { DB: makeD1(), MANAGER_PIN: '4321', ALLOWED_ORIGINS: '*' };
globalThis.fetch = async (url, opts = {}) => worker.fetch(new Request(url, { ...opts, headers: { ...(opts.headers || {}), Origin: 'https://shop.test' } }), env);

// Point the app at the test API before its modules read the saved config.
localStorage.setItem('ELITE_CUTS_H5_CONFIG_V1', JSON.stringify({ apiBaseUrl: API }));
const config = await import('../js/config.js');
const api = await import('../js/api.js');
const { shopConfig, DEFAULT_CONFIG, SHARED_FIELDS, pickShared } = config;

const loginAsManager = async () => {
  const res = await api.api('/api/manager/login', { method: 'POST', body: { pin: '4321' } });
  sessionStorage.setItem(api.MANAGER_TOKEN_KEY, res.data.token);
};
const resetDevice = () => {
  sessionStorage.clear();
  for (const k of SHARED_FIELDS) shopConfig[k] = structuredClone(DEFAULT_CONFIG[k]);
};

test('the app and the API agree on which settings are shared', () => {
  assert.deepEqual([...SHARED_FIELDS].sort(), [...SHOP_SETTINGS_FIELDS].sort());
  assert.ok(!SHARED_FIELDS.includes('apiBaseUrl'), 'the API address stays per device');
});

test('the default shop profile passes the API checks, so a first publish works', () => {
  const { error } = validateShopSettings(pickShared(DEFAULT_CONFIG));
  assert.equal(error, undefined);
});

test('nothing published yet: clients keep their current settings', async () => {
  resetDevice();
  const r = await api.loadSharedSettings();
  assert.deepEqual(r, { published: false, changed: false });
  assert.equal(shopConfig.shopName, DEFAULT_CONFIG.shopName);
});

test('manager publishes, another device picks it up on load', async () => {
  resetDevice();
  await loginAsManager();
  const reviews = [{ name: 'Dana R.', stars: 5, text: 'Best fade in town.' }];
  const pub = await api.publishSharedSettings({ ...pickShared(), shopName: 'FADE HOUSE', reviews, reviewsAreSamples: false });
  assert.deepEqual(pub, { ok: true });
  assert.equal(shopConfig.shopName, 'FADE HOUSE', 'the manager device shows what the server stored');

  // "Another device": fresh defaults, no token, cache still holds the defaults.
  resetDevice();
  assert.equal(shopConfig.shopName, DEFAULT_CONFIG.shopName);
  const r = await api.loadSharedSettings();
  assert.deepEqual(r, { published: true, changed: true });
  assert.equal(shopConfig.shopName, 'FADE HOUSE');
  assert.deepEqual(shopConfig.reviews, reviews);
  assert.equal(shopConfig.reviewsAreSamples, false);
  assert.equal(shopConfig.apiBaseUrl, API, 'device API address untouched');
  const cached = JSON.parse(localStorage.getItem('ELITE_CUTS_H5_CONFIG_V1'));
  assert.equal(cached.shopName, 'FADE HOUSE', 'cached for the next offline start');

  // Loading again changes nothing.
  assert.deepEqual(await api.loadSharedSettings(), { published: true, changed: false });
});

test('a rejected save leaves the device unchanged and reports why', async () => {
  resetDevice();
  await loginAsManager();
  const before = shopConfig.shopName;
  const r = await api.publishSharedSettings({ shopName: '' });
  assert.equal(r.ok, false);
  assert.match(r.error, /shopName is required/);
  assert.equal(shopConfig.shopName, before);
});

test('saving without a manager login is refused', async () => {
  resetDevice();
  const r = await api.publishSharedSettings({ shopName: 'HIJACKED' });
  assert.equal(r.ok, false);
  assert.match(r.error, /login expired/);
  resetDevice();
  await api.loadSharedSettings();
  assert.notEqual(shopConfig.shopName, 'HIJACKED');
});

test('API unreachable: clients keep the cached settings', async () => {
  resetDevice();
  const realFetch = globalThis.fetch;
  globalThis.fetch = async () => { throw new TypeError('Failed to fetch'); };
  const warn = console.warn; console.warn = () => {};
  try {
    assert.equal(await api.loadSharedSettings(), null);
    assert.equal(shopConfig.shopName, DEFAULT_CONFIG.shopName);
  } finally {
    globalThis.fetch = realFetch;
    console.warn = warn;
  }
});
