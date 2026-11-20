// In-app updates. The app is installed from the browser, not an app store, so nothing tells a
// home-screen user that a new version was deployed. This module notices a new service worker
// (sw.js) waiting to take over and shows a popup:
//
//     UPDATE: <what changed>        [ OK ]
//
// Tapping OK switches to the new version and reloads.
//
// How a new version arrives: every deploy changes sw.js (bump CACHE_NAME and write RELEASE_NOTES).
// The browser downloads it, the new worker pre-caches the new files and then WAITS (sw.js no longer
// skips waiting by itself), so the page keeps running the old code until OK is tapped. The popup's
// text comes from the waiting worker's RELEASE_NOTES, so it always describes the version being
// installed, even offline. iPhone home-screen apps are usually resumed rather than reopened, so we
// also check whenever the app comes back to the foreground, plus every 30 minutes while it is open.

export const UPDATE_CHECK_MS = 30 * 60 * 1000;
export const SKIP_WAITING = { type: 'SKIP_WAITING' };
export const GET_RELEASE = { type: 'GET_RELEASE' };
export const DEFAULT_NOTES = 'A new version of the app is ready.';

/**
 * Core logic, no DOM. container = navigator.serviceWorker, reg = its registration.
 * onReady(applyUpdate, waitingWorker) is called once when a new version is installed and waiting.
 * reload() is called once after the new version takes control.
 */
export function watchForUpdates({ container, reg, onReady, reload, win = null, intervalMs = UPDATE_CHECK_MS }) {
  let announced = false;
  let reloading = false;
  // A first install (no controlling worker yet) is not an update.
  let hadController = !!container.controller;

  const applyUpdate = () => {
    if (reg.waiting) reg.waiting.postMessage(SKIP_WAITING);
    else reload();   // already activated (another tab tapped OK): just load the new files
  };

  const announce = () => {
    if (announced || !hadController || !reg.waiting) return;
    announced = true;
    onReady(applyUpdate, reg.waiting);
  };

  const trackInstalling = (worker) => {
    if (!worker) return;
    worker.addEventListener('statechange', () => { if (worker.state === 'installed') announce(); });
  };

  announce();                         // a version was already waiting when the app opened
  trackInstalling(reg.installing);    // one is installing right now
  reg.addEventListener('updatefound', () => trackInstalling(reg.installing));

  // The new worker took over (after OK, here or in another tab): load the new version once.
  container.addEventListener('controllerchange', () => {
    if (!hadController) { hadController = true; return; }   // first install claimed the page: no reload
    if (reloading) return;
    reloading = true;
    reload();
  });

  const checkNow = () => Promise.resolve(reg.update && reg.update()).catch(() => { /* offline */ });
  let timer = null;
  if (win) {
    win.document.addEventListener('visibilitychange', () => { if (win.document.visibilityState === 'visible') checkNow(); });
    win.addEventListener('focus', checkNow);
    if (intervalMs) timer = win.setInterval(checkNow, intervalMs);
  }
  return { checkNow, applyUpdate, stop: () => timer && win.clearInterval(timer) };
}

/** Ask the waiting worker what changed in its version. Resolves to a short text, never rejects. */
export function askReleaseNotes(worker, { MessageChannelImpl = globalThis.MessageChannel, timeoutMs = 1500 } = {}) {
  return new Promise(resolve => {
    if (!worker || !MessageChannelImpl) return resolve(DEFAULT_NOTES);
    const channel = new MessageChannelImpl();
    const done = (notes) => {
      clearTimeout(timer);
      channel.port1.onmessage = null;
      if (channel.port1.close) channel.port1.close();
      resolve(notes || DEFAULT_NOTES);
    };
    const timer = setTimeout(() => done(DEFAULT_NOTES), timeoutMs);
    channel.port1.onmessage = (e) => {
      done(e && e.data && typeof e.data.notes === 'string' ? e.data.notes.trim().slice(0, 300) : '');
    };
    worker.postMessage(GET_RELEASE, [channel.port2]);
  });
}

/** The popup: "UPDATE: <notes>" and an OK button that applies the update. */
export function showUpdatePopup(notes, applyUpdate, doc = document) {
  const popup = doc.getElementById('appUpdatePopup');
  if (!popup) return;
  doc.getElementById('appUpdateNotes').textContent = notes || DEFAULT_NOTES;   // text, never HTML
  const ok = doc.getElementById('appUpdateOkBtn');
  ok.disabled = false;
  ok.textContent = 'OK';
  ok.onclick = () => {
    ok.disabled = true;
    ok.textContent = 'Updating…';
    applyUpdate();
  };
  popup.classList.remove('hidden');
  ok.focus && ok.focus();
}

/** Register sw.js and start watching for new versions. */
export async function initAppUpdates(win = window) {
  const container = win.navigator.serviceWorker;
  if (!container) return null;
  // updateViaCache 'none': the browser always asks the server for a fresh sw.js.
  const reg = await container.register('./sw.js', { updateViaCache: 'none' });
  return watchForUpdates({
    container,
    reg,
    win,
    onReady: async (applyUpdate, waiting) => showUpdatePopup(await askReleaseNotes(waiting), applyUpdate, win.document),
    reload: () => win.location.reload()
  });
}
