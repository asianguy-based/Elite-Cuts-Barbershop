// In-app update flow, run with plain Node (22+), no browser:
//   node --test tests/app-update.test.mjs
// Drives js/update.js with fake service-worker objects, and runs sw.js in a sandbox to check
// that a new version waits for the OK tap instead of taking over by itself.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import vm from 'node:vm';
import { watchForUpdates, showUpdatePopup, askReleaseNotes, SKIP_WAITING, GET_RELEASE, DEFAULT_NOTES } from '../js/update.js';

// ---------- fakes ----------
class FakeWorker extends EventTarget {
  constructor(state = 'installing') { super(); this.state = state; this.messages = []; }
  postMessage(m) { this.messages.push(m); }
  setState(s) { this.state = s; this.dispatchEvent(new Event('statechange')); }
}
class FakeReg extends EventTarget {
  constructor() { super(); this.installing = null; this.waiting = null; this.updates = 0; }
  update() { this.updates++; return Promise.resolve(); }
  // the browser found a new sw.js and starts installing it
  newVersion() { const w = new FakeWorker('installing'); this.installing = w; this.dispatchEvent(new Event('updatefound')); return w; }
  installed(w) { this.installing = null; this.waiting = w; w.setState('installed'); }
}
class FakeContainer extends EventTarget {
  constructor(controller) { super(); this.controller = controller; }
  takeOver(w) { this.controller = w; this.dispatchEvent(new Event('controllerchange')); }
}
const setup = ({ controlled = true } = {}) => {
  const container = new FakeContainer(controlled ? new FakeWorker('activated') : null);
  const reg = new FakeReg();
  const calls = { ready: 0, reload: 0, apply: null };
  const watcher = watchForUpdates({
    container, reg,
    onReady: (apply) => { calls.ready++; calls.apply = apply; },
    reload: () => { calls.reload++; }
  });
  return { container, reg, calls, watcher };
};

test('a new deploy shows the update popup once it has finished installing', () => {
  const { reg, calls } = setup();
  const w = reg.newVersion();
  assert.equal(calls.ready, 0, 'not while it is still downloading');
  reg.installed(w);
  assert.equal(calls.ready, 1);
  w.setState('installed');
  assert.equal(calls.ready, 1, 'announced only once');
});

test('tapping OK activates the new version, then the page reloads once', () => {
  const { container, reg, calls } = setup();
  const w = reg.newVersion();
  reg.installed(w);
  calls.apply();
  assert.deepEqual(w.messages, [SKIP_WAITING], 'asks the waiting version to take over');
  assert.equal(calls.reload, 0, 'reload waits for the new version to take control');
  container.takeOver(w);
  container.takeOver(w);
  assert.equal(calls.reload, 1);
});

test('a version already waiting when the app opens is offered right away', () => {
  const container = new FakeContainer(new FakeWorker('activated'));
  const reg = new FakeReg();
  reg.waiting = new FakeWorker('installed');
  let ready = 0;
  watchForUpdates({ container, reg, onReady: () => ready++, reload: () => {} });
  assert.equal(ready, 1);
});

test('the very first install is not an update', () => {
  const { container, reg, calls } = setup({ controlled: false });
  const w = reg.newVersion();
  reg.installed(w);
  container.takeOver(w);   // clients.claim() on first install
  assert.equal(calls.ready, 0);
  assert.equal(calls.reload, 0, 'no surprise reload on first visit');
  // ...but a deploy later in that same visit is offered
  const next = reg.newVersion();
  reg.installed(next);
  assert.equal(calls.ready, 1);
});

test('OK with nothing waiting (another tab already switched) just reloads', () => {
  const { calls, watcher } = setup();
  watcher.applyUpdate();
  assert.equal(calls.reload, 1);
});

test('checks again when the app comes back to the foreground (iPhone resumes apps) and on a timer', async () => {
  const container = new FakeContainer(new FakeWorker('activated'));
  const reg = new FakeReg();
  const doc = new EventTarget(); doc.visibilityState = 'hidden';
  const win = new EventTarget();
  let tick = null;
  win.document = doc;
  win.setInterval = (fn, ms) => { tick = { fn, ms }; return 1; };
  win.clearInterval = () => {};
  watchForUpdates({ container, reg, win, onReady: () => {}, reload: () => {} });
  doc.dispatchEvent(new Event('visibilitychange'));
  assert.equal(reg.updates, 0, 'not when going to the background');
  doc.visibilityState = 'visible';
  doc.dispatchEvent(new Event('visibilitychange'));
  win.dispatchEvent(new Event('focus'));
  assert.equal(reg.updates, 2);
  assert.equal(tick.ms, 30 * 60 * 1000);
  tick.fn();
  assert.equal(reg.updates, 3);
});

test('an offline update check fails quietly', async () => {
  const container = new FakeContainer(new FakeWorker('activated'));
  const reg = new FakeReg();
  reg.update = () => Promise.reject(new TypeError('Failed to fetch'));
  const w = watchForUpdates({ container, reg, onReady: () => {}, reload: () => {} });
  await w.checkNow();
});

// ---------- the popup ----------
function fakeDoc() {
  const el = (extra = {}) => ({
    textContent: '', disabled: false, onclick: null, focused: false, focus() { this.focused = true; },
    classList: { _h: true, add(c) { if (c === 'hidden') this._h = true; }, remove(c) { if (c === 'hidden') this._h = false; }, contains(c) { return c === 'hidden' && this._h; } },
    ...extra
  });
  const nodes = { appUpdatePopup: el(), appUpdateNotes: el(), appUpdateOkBtn: el() };
  return { nodes, getElementById: (id) => nodes[id] || null };
}

test('popup reads "UPDATE: <what changed>" with an OK button that applies the update', () => {
  const doc = fakeDoc();
  let applied = 0;
  showUpdatePopup('New barber photos and faster booking.', () => applied++, doc);
  const { appUpdatePopup, appUpdateNotes, appUpdateOkBtn } = doc.nodes;
  assert.equal(appUpdatePopup.classList.contains('hidden'), false);
  assert.equal(appUpdateNotes.textContent, 'New barber photos and faster booking.');
  assert.equal(appUpdateOkBtn.textContent, 'OK');
  assert.equal(appUpdateOkBtn.focused, true);
  appUpdateOkBtn.onclick();
  assert.equal(applied, 1);
  assert.equal(appUpdateOkBtn.disabled, true, 'no double taps while switching');
});

test('popup falls back to a plain message when there are no notes', () => {
  const doc = fakeDoc();
  showUpdatePopup('', () => {}, doc);
  assert.equal(doc.nodes.appUpdateNotes.textContent, DEFAULT_NOTES);
});

test('release notes come from the waiting version, over a message channel', async () => {
  const worker = { postMessage(msg, [port]) { assert.deepEqual(msg, GET_RELEASE); port.postMessage({ version: 'v9', notes: '  Online deposits.  ' }); } };
  assert.equal(await askReleaseNotes(worker), 'Online deposits.');
});

test('no answer from the waiting version: generic popup text', async () => {
  const silent = { postMessage() {} };
  assert.equal(await askReleaseNotes(silent, { timeoutMs: 20 }), DEFAULT_NOTES);
  assert.equal(await askReleaseNotes(null), DEFAULT_NOTES);
});

// ---------- sw.js ----------
function loadSW() {
  const handlers = {};
  const calls = { skipWaiting: 0, cached: [] };
  const self = {
    addEventListener: (type, fn) => { handlers[type] = fn; },
    skipWaiting: () => { calls.skipWaiting++; return Promise.resolve(); },
    clients: { claim: () => Promise.resolve() },
    registration: { scope: 'https://shop.test/' }
  };
  const ctx = {
    self,
    clients: self.clients,
    URL,
    Request: class { constructor(url, init) { this.url = url; this.cache = init && init.cache; } },
    caches: { open: async () => ({ addAll: async (reqs) => { calls.cached.push(...reqs); } }), keys: async () => [] },
    fetch: async () => { throw new Error('offline'); }
  };
  vm.runInNewContext(readFileSync(new URL('../sw.js', import.meta.url), 'utf8'), ctx);
  return { handlers, calls };
}

test('sw.js: a new version waits for the OK tap instead of taking over', async () => {
  const { handlers, calls } = loadSW();
  let done;
  handlers.install({ waitUntil: (p) => { done = p; } });
  await done;
  assert.equal(calls.skipWaiting, 0, 'install does not skip waiting');
  assert.ok(calls.cached.length > 5);
  assert.ok(calls.cached.every((r) => r.cache === 'reload'), 'pre-cache bypasses the HTTP cache');
  assert.ok(calls.cached.some((r) => r.url === './js/update.js'));
  handlers.message({ data: { type: 'SOMETHING_ELSE' } });
  assert.equal(calls.skipWaiting, 0);
  handlers.message({ data: SKIP_WAITING });
  assert.equal(calls.skipWaiting, 1);
});

test('sw.js: tells the page its version and what changed', () => {
  const { handlers } = loadSW();
  let reply = null;
  handlers.message({ data: GET_RELEASE, ports: [{ postMessage: (m) => { reply = m; } }] });
  assert.match(reply.version, /^elite-cuts-h5-v\d/);
  assert.equal(typeof reply.notes, 'string');
  assert.ok(reply.notes.length > 0 && reply.notes.length <= 300, 'RELEASE_NOTES is set and short');
});
