// Elite Cuts PWA — end-to-end regression suite.
//
//   node tests/e2e.mjs            (starts its own static server on PORT, default 8301)
//   BASE_URL=http://127.0.0.1:9000 node tests/e2e.mjs   (use an already running server)
//   SHOTS=/some/dir node tests/e2e.mjs                   (also save screenshots there)
//
// SAFETY: every browser context aborts all traffic to the LIVE Worker and forces demo mode
// (apiBaseUrl = '') through localStorage before any page script runs. The API code path is only
// exercised against a fake host answered by context.route() stubs. Never point this at real data.

import { createRequire } from 'module';
import { spawn } from 'child_process';
import { fileURLToPath } from 'url';
import path from 'path';
import fs from 'fs';
import http from 'http';

const require = createRequire(import.meta.url);
const { chromium } = require('playwright');

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const PORT = Number(process.env.PORT || 8301);
const BASE = process.env.BASE_URL || `http://127.0.0.1:${PORT}`;
const SHOTS = process.env.SHOTS || '';

const LIVE_HOST = 'elite-cuts-api.voxlibera.workers.dev';
const STUB_API = 'https://stub-api.example.test';
const CONFIG_KEY = 'ELITE_CUTS_H5_CONFIG_V1';
const BOOKINGS_KEY = 'ELITE_CUTS_H5_BOOKINGS_V1';
// Hosts whose network failures are expected in this sandbox / by design.
const IGNORED_FAIL_HOSTS = ['images.unsplash.com', LIVE_HOST, 'stub-api.example.test'];

// Freeze "now" to Wednesday 2026-11-18 2:10 PM in New York so slot math is deterministic.
const TZ = 'America/New_York';
const NOW = new Date('2026-11-18T14:10:00-05:00');
const TODAY = '2026-11-18';
const TOMORROW = '2026-11-19';

const VIEWPORTS = [
  { name: 'mobile', width: 390, height: 844 },
  { name: 'desktop', width: 1280, height: 800 }
];

// ---------------------------------------------------------------- tiny harness
const results = [];
let failures = 0;
async function test(name, fn) {
  const t0 = Date.now();
  try {
    await fn();
    results.push(`PASS  ${name} (${Date.now() - t0}ms)`);
  } catch (err) {
    failures++;
    results.push(`FAIL  ${name}\n      ${String(err && err.stack || err).split('\n').slice(0, 4).join('\n      ')}`);
  }
  console.log(results[results.length - 1]);
}
function assert(cond, msg) { if (!cond) throw new Error('Assertion failed: ' + msg); }
function assertIncludes(hay, needle, what) {
  assert(String(hay).includes(needle), `${what}: expected to include ${JSON.stringify(needle)}, got ${JSON.stringify(String(hay).slice(0, 300))}`);
}

// ---------------------------------------------------------------- static server
async function waitForServer(url, ms = 8000) {
  const end = Date.now() + ms;
  while (Date.now() < end) {
    const ok = await new Promise(res => {
      const req = http.get(url, r => { r.resume(); res(r.statusCode === 200); });
      req.on('error', () => res(false));
    });
    if (ok) return;
    await new Promise(r => setTimeout(r, 150));
  }
  throw new Error('Static server did not start at ' + url);
}
let server = null;
async function startServer() {
  if (process.env.BASE_URL) return;
  server = spawn('python3', ['-m', 'http.server', String(PORT), '--bind', '127.0.0.1', '--directory', ROOT], { stdio: 'ignore' });
  await waitForServer(BASE + '/index.html');
}
function stopServer() { if (server) { server.kill(); server = null; } }

// ---------------------------------------------------------------- context factory
/**
 * mode: 'demo' (apiBaseUrl '') | 'stub' (apiBaseUrl = STUB_API, answered by `stub` handler)
 * extraConfig: merged into the stored config before page scripts run (every navigation).
 * seedBookings: written once to localStorage before first load.
 */
async function newApp(browser, vp, { mode = 'demo', stub = null, extraConfig = null, seedBookings = null, serviceWorkers = 'block' } = {}) {
  const context = await browser.newContext({
    viewport: { width: vp.width, height: vp.height },
    timezoneId: TZ,
    serviceWorkers,
    acceptDownloads: true
  });
  const stats = { liveHits: 0, stubCalls: [] };
  // 1) Hard block of the live Worker, for every context, always.
  await context.route(`**/${LIVE_HOST}/**`, r => { stats.liveHits++; return r.abort(); });
  // Unsplash is unreachable in the sandbox; abort fast instead of waiting on the tunnel.
  await context.route('**/images.unsplash.com/**', r => r.abort());
  // 2) Stubbed API host (only used by mode 'stub').
  await context.route(`${STUB_API}/**`, async r => {
    const req = r.request();
    const cors = { 'access-control-allow-origin': '*', 'access-control-allow-headers': '*', 'access-control-allow-methods': 'GET,POST,PATCH,OPTIONS' };
    if (req.method() === 'OPTIONS') return r.fulfill({ status: 204, headers: cors });
    stats.stubCalls.push(req.url());
    if (!stub) return r.abort();
    return stub(r, cors);
  });
  // 3) Force the API base URL before any page script runs, on every navigation.
  await context.addInitScript(({ key, apiBaseUrl, extra, bookingsKey, seed }) => {
    try {
      const cfg = JSON.parse(localStorage.getItem(key) || '{}');
      cfg.apiBaseUrl = apiBaseUrl;
      if (extra && !sessionStorage.getItem('__e2e_extra')) { Object.assign(cfg, extra); sessionStorage.setItem('__e2e_extra', '1'); }
      localStorage.setItem(key, JSON.stringify(cfg));
      if (seed && !sessionStorage.getItem('__e2e_seed')) { localStorage.setItem(bookingsKey, JSON.stringify(seed)); sessionStorage.setItem('__e2e_seed', '1'); }
    } catch (_) { /* storage blocked */ }
  }, { key: CONFIG_KEY, apiBaseUrl: mode === 'stub' ? STUB_API : '', extra: extraConfig, bookingsKey: BOOKINGS_KEY, seed: seedBookings });

  const page = await context.newPage();
  await page.clock.setSystemTime(NOW);
  const errors = [];
  const dialogs = [];
  page.on('pageerror', e => errors.push('pageerror: ' + e.message));
  page.on('console', msg => {
    if (msg.type() !== 'error') return;
    const loc = (msg.location() && msg.location().url) || '';
    const text = msg.text();
    const ignoredHost = IGNORED_FAIL_HOSTS.some(h => loc.includes(h) || text.includes(h));
    if (ignoredHost && /Failed to load resource|net::ERR_|Failed to fetch|CORS/i.test(text)) return;
    errors.push('console.error: ' + text + (loc ? ' @ ' + loc : ''));
  });
  page.on('dialog', d => { dialogs.push(d.message()); d.accept(); });
  return { context, page, errors, dialogs, stats };
}

async function noHorizontalScroll(page, where) {
  const m = await page.evaluate(() => ({ sw: document.documentElement.scrollWidth, cw: document.documentElement.clientWidth }));
  assert(m.sw <= m.cw, `${where}: horizontal scroll (scrollWidth ${m.sw} > clientWidth ${m.cw})`);
}
async function assertDemoMode(page) {
  const cfg = await page.evaluate(k => JSON.parse(localStorage.getItem(k) || '{}'), CONFIG_KEY);
  assert(cfg.apiBaseUrl === '', 'stored apiBaseUrl is empty (demo mode)');
}
async function shot(page, name) {
  if (!SHOTS) return;
  fs.mkdirSync(SHOTS, { recursive: true });
  await page.waitForTimeout(700); // let fade-in animations and smooth scrolls settle
  await page.evaluate(() => window.scrollTo({ top: 0, behavior: 'instant' }));
  await page.waitForTimeout(100);
  await page.screenshot({ path: path.join(SHOTS, name + '.png'), fullPage: true });
}
const visible = (page, sel) => page.locator(sel).isVisible();

// ---------------------------------------------------------------- suites
async function coreSuite(browser, vp) {
  await test(`[${vp.name}] core flows: home, booking, loyalty, admin, white-label, lookbook`, async () => {
    const { context, page, errors, dialogs, stats } = await newApp(browser, vp);
    try {
      // HOME
      await page.goto(BASE + '/', { waitUntil: 'load' });
      await assertDemoMode(page);
      assert(await page.textContent('#headerShopName') === 'ELITE CUTS', 'header shop name');
      assert(await page.locator('#homeServicesList > div').count() === 4, '4 services on home');
      assert(await page.locator('#homeBarbersList > div').count() === 2, '2 barbers on home');
      await noHorizontalScroll(page, 'home');
      await shot(page, `${vp.name}-home`);

      // FULL BOOKING: service -> barber -> date/time -> details -> confirm (pay at chair)
      await page.click('button:has-text("Book Chair Now")');
      assert(await visible(page, '#bookStep1'), 'step 1 visible');
      await page.click('#bookingServicesGrid >> text=Traditional Straight Razor Shave');
      assertIncludes(await page.textContent('#bookingLiveSummary'), '$85 • 75 min', 'live summary after adding shave');
      await shot(page, `${vp.name}-book-step1`);
      await page.click('#bookStep1 button:has-text("Continue to Barber Selection")');
      assert(await visible(page, '#bookStep2'), 'step 2 visible');
      await page.click('#bookingBarbersGrid >> text=Mateo Cruz');
      await page.click('#bookStep2 button:has-text("Select Date & Time")');
      assert(await visible(page, '#bookStep3'), 'step 3 visible');
      await page.fill('#bookingDateInput', TOMORROW);
      await page.click('#bookingTimeSlotsGrid button:has-text("04:30 PM")');
      await shot(page, `${vp.name}-book-step3`);
      await page.click('#bookStep3 button:has-text("Continue to Details")');
      assert(await visible(page, '#bookStep4'), 'step 4 visible');
      const summary = await page.textContent('#bookingSummaryBox');
      assertIncludes(summary, 'Mateo Cruz', 'summary barber');
      assertIncludes(summary, `${TOMORROW} @ 04:30 PM`, 'summary date/time');
      assertIncludes(summary, 'The Executive Cut & Style, Traditional Straight Razor Shave', 'summary services');
      await page.click('#payModeChairBtn');
      assertIncludes(await page.textContent('#submitBtnText'), 'Pay at Chair', 'pay-at-chair submit label');
      await page.fill('#clientName', 'Test Client');
      await page.fill('#clientPhone', '(555) 777-0101');
      await noHorizontalScroll(page, 'booking step 4');
      await shot(page, `${vp.name}-book-step4`);
      await page.click('#finalSubmitBookingBtn');
      await page.waitForSelector('#bookConfirmation:not(.hidden)');
      const receipt = await page.textContent('#receiptCode');
      const ref = (receipt.match(/EC-\d{4}/) || [])[0];
      assert(/^REF #EC-\d{4} \(\+100 VIP PTS\)$/.test(receipt), 'receipt code format, got ' + receipt);
      assertIncludes(await page.textContent('#receiptDetailsText'), `with Mateo Cruz on ${TOMORROW} at 04:30 PM`, 'receipt details');
      await shot(page, `${vp.name}-book-confirm`);

      // LOYALTY LOOKUP for that phone
      await page.click('#nav-loyalty');
      await page.fill('#loyaltyLookupPhone', '(555) 777-0101');
      await page.click('#view-loyalty button:has-text("Load")');
      await page.waitForFunction(() => document.getElementById('loyaltyPointsDisplay').textContent === '100 PTS');
      assert(await page.textContent('#loyaltyStampsCount') === '1 / 10 Cuts', 'stamps after one booking');
      assertIncludes(await page.textContent('#clientAppointmentsList'), `${TOMORROW} @ 04:30 PM • Mateo Cruz`, 'loyalty history');
      await noHorizontalScroll(page, 'loyalty');
      await shot(page, `${vp.name}-loyalty`);

      // ADMIN PORTAL
      await page.goto(BASE + '/?portal=admin', { waitUntil: 'load' });
      await page.waitForSelector('#adminModal:not(.hidden)');
      await assertDemoMode(page);
      assertIncludes(await page.textContent('#adminPinHint'), 'Demo mode', 'admin PIN hint says demo mode');
      await page.fill('#adminPinInput', '1234');
      await page.click('#adminPinGate button:has-text("Unlock")');
      await page.waitForSelector('#adminContent:not(.hidden)');
      const row = page.locator('#adminAppointmentsList > div', { hasText: ref });
      assert(await row.count() === 1, 'booking row present in admin queue');
      assertIncludes(await row.textContent(), `${TOMORROW} 04:30 PM • Mateo Cruz`, 'admin row date/time/barber');
      await row.locator('button:has-text("Done")').click();
      await page.waitForFunction(r => [...document.querySelectorAll('#adminAppointmentsList > div')].some(d => d.textContent.includes(r) && d.textContent.includes('Completed')), ref);
      const stored = await page.evaluate(k => JSON.parse(localStorage.getItem(k)), BOOKINGS_KEY);
      assert(stored.find(b => b.refCode === ref).status === 'Completed', 'status persisted');
      await noHorizontalScroll(page, 'admin');
      await shot(page, `${vp.name}-admin`);

      // CSV EXPORT
      const [download] = await Promise.all([
        page.waitForEvent('download'),
        page.click('button:has-text("Export CSV Spreadsheet")')
      ]);
      const csvPath = await download.path();
      const csv = fs.readFileSync(csvPath, 'utf8');
      assertIncludes(csv, 'Phone,Name,Points,Stamps', 'csv header');
      assertIncludes(csv, '"(555) 777-0101","Test Client",100,1', 'csv row');

      // WHITE-LABEL setting
      await page.fill('#cfgShopName', 'FADE HOUSE');
      await page.click('button:has-text("Apply Settings")');
      await page.waitForFunction(() => document.getElementById('headerShopName').textContent === 'FADE HOUSE');
      assert(dialogs.some(d => d.includes('Settings Updated!') && d.includes('Demo mode')), 'settings alert reports demo mode');
      assert(await page.textContent('#loyaltyCardShopName') === 'FADE HOUSE REWARDS', 'loyalty card name');
      await page.click('#adminModal button:has(i.fa-xmark)');
      await page.reload({ waitUntil: 'load' });
      assert(await page.textContent('#headerShopName') === 'FADE HOUSE', 'shop name persisted after reload');
      await assertDemoMode(page);

      // LOOKBOOK
      await page.click('#nav-gallery');
      assert(await visible(page, '#view-gallery'), 'lookbook visible');
      assert(await page.locator('#galleryGrid > div').count() === 2, '2 lookbook items');
      await noHorizontalScroll(page, 'lookbook');
      await shot(page, `${vp.name}-lookbook`);
      await page.click('#galleryGrid > div >> nth=0');
      assert(await visible(page, '#view-book'), 'lookbook tap opens booking');
      assertIncludes(await page.inputValue('#clientNotes'), 'Requested Lookbook Style: Mid Drop Skin Fade', 'lookbook prefilled notes');

      assert(stats.liveHits === 0, `no requests to live Worker (got ${stats.liveHits})`);
      assert(errors.length === 0, 'no page/console errors:\n' + errors.join('\n'));
    } finally {
      await context.close();
    }
  });
}

async function offlineSuite(browser, vp) {
  await test(`[${vp.name}] offline reload serves the cached app shell`, async () => {
    const { context, page, errors, stats } = await newApp(browser, vp, { serviceWorkers: 'allow' });
    try {
      await page.goto(BASE + '/', { waitUntil: 'load' });
      await page.evaluate(async () => { await navigator.serviceWorker.ready; });
      await page.waitForFunction(() => !!navigator.serviceWorker.controller, null, { timeout: 10000 });
      await page.waitForTimeout(300);
      await context.setOffline(true);
      await page.reload({ waitUntil: 'load' });
      assert(await page.textContent('#headerShopName') === 'ELITE CUTS', 'header rendered offline');
      assert(await page.locator('#homeServicesList > div').count() === 4, 'app JS ran offline (services rendered)');
      assert(await page.locator('#nextChairCard').isVisible(), 'next-chair card rendered offline');
      assertIncludes(await page.evaluate(() => getComputedStyle(document.body).fontFamily), 'Inter', 'app stylesheet applied offline');
      const swSrc = fs.readFileSync(path.join(ROOT, 'sw.js'), 'utf8');
      const cacheName = (swSrc.match(/CACHE_NAME = '([^']+)'/) || [])[1];
      const keys = await page.evaluate(() => caches.keys());
      assert(keys.length === 1 && keys[0] === cacheName, `only the current cache (${cacheName}) exists, got ${JSON.stringify(keys)}`);
      const shell = [...swSrc.match(/APP_SHELL = \[([\s\S]*?)\]/)[1].matchAll(/'([^']+)'/g)].map(m => m[1]);
      const cached = await page.evaluate(async (files) => {
        const c = await caches.open((await caches.keys())[0]);
        return Promise.all(files.map(async f => !!(await c.match(new URL(f, location.href).href))));
      }, shell);
      assert(cached.every(Boolean), 'every APP_SHELL file is cached: ' + JSON.stringify(shell.filter((_, i) => !cached[i])));
      const pageErrors = errors.filter(e => e.startsWith('pageerror'));
      assert(pageErrors.length === 0, 'no page errors offline:\n' + pageErrors.join('\n'));
      assert(stats.liveHits === 0, 'no live Worker hits');
      await context.setOffline(false);
    } finally {
      await context.close();
    }
  });
}

async function nextChairSuite(browser, vp) {
  // At the frozen time (Wed 2:10 PM) 09:00 AM – 01:30 PM are past, so the first open chair is 2:30 PM.
  await test(`[${vp.name}] next open chair: one-tap Book it -> details -> confirm -> admin queue`, async () => {
    const { context, page, errors, stats } = await newApp(browser, vp);
    try {
      await page.goto(BASE + '/', { waitUntil: 'load' });
      await assertDemoMode(page);
      await page.waitForSelector('#nextChairCard:not(.hidden)');
      assert(await page.textContent('#nextChairWhen') === 'Today, 2:30 PM with Marcus', 'card time/barber, got ' + await page.textContent('#nextChairWhen'));
      assert(await page.textContent('#nextChairService') === 'The Executive Cut & Style · 45 min · $45', 'card service line');
      assert(await page.locator('#nextChairBookBtn').evaluate(e => e.tagName) === 'BUTTON', 'Book it is a real button');
      await noHorizontalScroll(page, 'home with next-chair card');
      await shot(page, `${vp.name}-home-nextchair`);

      // Keyboard activation (focus + Enter) to prove it is reachable and usable without a pointer.
      await page.focus('#nextChairBookBtn');
      assert(await page.evaluate(() => document.activeElement.id) === 'nextChairBookBtn', 'Book it focusable');
      await page.keyboard.press('Enter');
      await page.waitForSelector('#bookStep4:not(.hidden)');
      assert(!(await visible(page, '#bookStep1')) && !(await visible(page, '#bookStep3')), 'landed directly on details step');
      assertIncludes(await page.getAttribute('#stepInd4', 'class'), 'bg-accent', 'step 4 indicator active');
      const summary = await page.textContent('#bookingSummaryBox');
      assertIncludes(summary, 'The Executive Cut & Style', 'prefilled default service');
      assertIncludes(summary, 'Marcus Vance', 'prefilled barber');
      assertIncludes(summary, `${TODAY} @ 02:30 PM`, 'prefilled date/time');
      assert(await page.textContent('#bookingLiveSummary') === '$45 • 45 min', 'totals for default service');
      assert(await page.evaluate(() => document.activeElement.id) === 'clientName', 'name field focused');
      await shot(page, `${vp.name}-nextchair-details`);

      await page.fill('#clientName', 'One Tap');
      await page.fill('#clientPhone', '555-010-2030');
      await page.click('#payModeChairBtn');
      await page.click('#finalSubmitBookingBtn');
      await page.waitForSelector('#bookConfirmation:not(.hidden)');
      const ref = ((await page.textContent('#receiptCode')).match(/EC-\d{4}/) || [])[0];
      assert(ref, 'ref code shown');
      assertIncludes(await page.textContent('#receiptDetailsText'), `The Executive Cut & Style with Marcus Vance on ${TODAY} at 02:30 PM`, 'receipt');

      // Card updates after the booking: Marcus is now taken at 2:30, Mateo is still free.
      await page.click('#nav-home');
      assert(await page.textContent('#nextChairWhen') === 'Today, 2:30 PM with Mateo', 'card moved after booking, got ' + await page.textContent('#nextChairWhen'));

      // "Pick another time" opens the normal flow at step 1.
      await page.click('#nextChairOtherBtn');
      assert(await visible(page, '#bookStep1'), 'pick another time -> step 1');

      // Booking appears in the admin queue with the right barber/date/time.
      await page.goto(BASE + '/?portal=admin', { waitUntil: 'load' });
      await page.waitForSelector('#adminModal:not(.hidden)');
      await page.fill('#adminPinInput', '1234');
      await page.click('#adminPinGate button:has-text("Unlock")');
      await page.waitForSelector('#adminContent:not(.hidden)');
      const row = page.locator('#adminAppointmentsList > div', { hasText: ref });
      assert(await row.count() === 1, 'one-tap booking in admin queue');
      assertIncludes(await row.textContent(), `One Tap (${ref})`, 'admin row client');
      assertIncludes(await row.textContent(), `${TODAY} 02:30 PM • Marcus Vance`, 'admin row barber/date/time');

      // Cancelling it frees the slot again.
      await row.locator('button:has-text("Cancel")').click();
      await page.click('#adminModal button:has(i.fa-xmark)');
      assert(await page.textContent('#nextChairWhen') === 'Today, 2:30 PM with Marcus', 'cancel frees the slot');

      assert(stats.liveHits === 0, 'no live Worker hits');
      assert(errors.length === 0, 'no errors:\n' + errors.join('\n'));
    } finally {
      await context.close();
    }
  });

  await test(`[${vp.name}] next open chair: stubbed API reports first slot booked, card moves on`, async () => {
    // Fake Worker state: Marcus booked 2:30 + 3:30 today, Mateo booked 2:30 today.
    const booked = { [`${TODAY}|brb-1`]: ['02:30 PM', '03:30 PM'], [`${TODAY}|brb-2`]: ['02:30 PM'] };
    const stub = async (r, cors) => {
      const req = r.request();
      const u = new URL(req.url());
      const json = (status, body) => r.fulfill({ status, headers: { ...cors, 'content-type': 'application/json' }, body: JSON.stringify(body) });
      if (u.pathname === '/api/slots') {
        return json(200, { booked: booked[`${u.searchParams.get('date')}|${u.searchParams.get('barberId')}`] || [] });
      }
      if (u.pathname === '/api/bookings' && req.method() === 'POST') {
        const body = req.postDataJSON();
        const key = `${body.date}|${body.barberId}`;
        booked[key] = (booked[key] || []).concat(body.time);
        return json(201, { booking: { ...body, id: 'stub-1', refCode: 'EC-5555', status: 'Confirmed', paid: false } });
      }
      return json(404, { error: 'not stubbed' });
    };
    const { context, page, errors, stats } = await newApp(browser, vp, { mode: 'stub', stub });
    try {
      await page.goto(BASE + '/', { waitUntil: 'load' });
      await page.waitForFunction(() => document.getElementById('nextChairWhen').textContent === 'Today, 3:30 PM with Mateo', null, { timeout: 5000 })
        .catch(async () => { throw new Error('card did not move to 3:30 PM Mateo, got ' + await page.textContent('#nextChairWhen')); });
      const slotCalls = stats.stubCalls.filter(u => u.includes('/api/slots'));
      assert(slotCalls.length === 2 && slotCalls.every(u => u.includes(`date=${TODAY}`)), 'only today x 2 barbers fetched, got ' + JSON.stringify(slotCalls));

      await page.click('#nextChairBookBtn');
      await page.waitForSelector('#bookStep4:not(.hidden)');
      const summary = await page.textContent('#bookingSummaryBox');
      assertIncludes(summary, 'Mateo Cruz', 'stub: prefilled barber');
      assertIncludes(summary, `${TODAY} @ 03:30 PM`, 'stub: prefilled time');
      await page.fill('#clientName', 'Stub Client');
      await page.fill('#clientPhone', '5550009999');
      await page.click('#payModeChairBtn');
      await page.click('#finalSubmitBookingBtn');
      await page.waitForSelector('#bookConfirmation:not(.hidden)');
      assertIncludes(await page.textContent('#receiptCode'), 'EC-5555', 'stub ref code');
      // After booking the card re-fetches and moves on: 4:30 PM, Marcus is first in roster order.
      await page.click('#nav-home');
      await page.waitForFunction(() => document.getElementById('nextChairWhen').textContent === 'Today, 4:30 PM with Marcus', null, { timeout: 5000 })
        .catch(async () => { throw new Error('card did not move after stub booking, got ' + await page.textContent('#nextChairWhen')); });
      assert(stats.liveHits === 0, 'no live Worker hits');
      assert(errors.length === 0, 'no errors:\n' + errors.join('\n'));
    } finally {
      await context.close();
    }
  });

  await test(`[${vp.name}] next open chair: API unreachable fails soft to local data`, async () => {
    const { context, page, errors, stats } = await newApp(browser, vp, { mode: 'stub', stub: null });
    try {
      await page.goto(BASE + '/', { waitUntil: 'load' });
      await page.waitForFunction(() => !document.getElementById('nextChairCard').classList.contains('hidden'));
      await page.waitForTimeout(300);
      assert(await page.textContent('#nextChairWhen') === 'Today, 2:30 PM with Marcus', 'local fallback slot');
      assert(stats.stubCalls.length >= 1, 'API was attempted');
      assert(stats.liveHits === 0, 'no live Worker hits');
      assert(errors.length === 0, 'no errors:\n' + errors.join('\n'));
    } finally {
      await context.close();
    }
  });

  await test(`[${vp.name}] next open chair: looks ahead up to 7 days, hides when fully booked`, async () => {
    const days = ['2026-11-19', '2026-11-20', '2026-11-21', '2026-11-22', '2026-11-23', '2026-11-24'];
    const seed = [];
    days.forEach(date => ['brb-1', 'brb-2'].forEach(barberId => seed.push({ id: `${date}-${barberId}`, refCode: 'EC-0000', services: ['x'], barberId, barberName: barberId, date, time: '09:00 AM', clientName: 'Seed', clientPhone: '1', status: 'Confirmed' })));
    const extraConfig = { timeSlots: ['09:00 AM'] }; // today's only slot is already past
    // Last day, last barber free -> card shows it.
    let app = await newApp(browser, vp, { extraConfig, seedBookings: seed.slice(0, -1) });
    try {
      await app.page.goto(BASE + '/', { waitUntil: 'load' });
      assert(await app.page.textContent('#nextChairWhen') === 'Tue, Nov 24, 9:00 AM with Mateo', 'day 7 slot, got ' + await app.page.textContent('#nextChairWhen'));
      assert(app.errors.length === 0, 'no errors:\n' + app.errors.join('\n'));
    } finally {
      await app.context.close();
    }
    // Everything booked -> card hidden.
    app = await newApp(browser, vp, { extraConfig, seedBookings: seed });
    try {
      await app.page.goto(BASE + '/', { waitUntil: 'load' });
      assert(await app.page.locator('#nextChairCard').isHidden(), 'card hidden when nothing free in 7 days');
      assert(app.errors.length === 0, 'no errors:\n' + app.errors.join('\n'));
    } finally {
      await app.context.close();
    }
  });
}

async function datesSuite(browser, vp) {
  // At 2:10 PM the booking flow must not offer the past: date min is today, earlier slots disabled,
  // and the default 11:00 AM selection moves to the first open slot.
  await test(`[${vp.name}] booking flow: no past dates or times`, async () => {
    const { context, page, errors, stats } = await newApp(browser, vp);
    try {
      await page.goto(BASE + '/', { waitUntil: 'load' });
      await page.evaluate(() => { switchTab('book'); goToBookingStep(3); });
      await page.waitForSelector('#bookStep3:not(.hidden)');
      assert(await page.inputValue('#bookingDateInput') === TODAY, 'date defaults to local today');
      assert(await page.getAttribute('#bookingDateInput', 'min') === TODAY, 'date input min is today');
      const btn = (t) => page.locator('#bookingTimeSlotsGrid button', { hasText: t });
      assert(await btn('11:00 AM').isDisabled(), '11:00 AM (past) disabled');
      assert(!(await btn('02:30 PM').isDisabled()), '02:30 PM open');
      assertIncludes(await btn('02:30 PM').getAttribute('class'), 'gold-gradient', 'first open slot auto-selected');
      // Typing a past date snaps back to today.
      await page.fill('#bookingDateInput', '2026-11-01');
      await page.dispatchEvent('#bookingDateInput', 'change');
      assert(await page.inputValue('#bookingDateInput') === TODAY, 'past date snapped to today');
      assert(errors.length === 0, 'no errors: ' + errors.join(' | '));
      assert(stats.liveHits === 0, 'live Worker never contacted');
    } finally { await context.close(); }
  });

  // 9:30 PM in New York is already tomorrow in UTC. The flow must still open on the local day,
  // say nothing is left today, and not let the client continue without a time.
  await test(`[${vp.name}] booking flow: evening uses local date, no slots left today`, async () => {
    const { context, page, errors, stats } = await newApp(browser, vp);
    try {
      await page.clock.setSystemTime(new Date('2026-11-18T21:30:00-05:00'));
      await page.goto(BASE + '/', { waitUntil: 'load' });
      await page.evaluate(() => { switchTab('book'); goToBookingStep(3); });
      await page.waitForSelector('#bookStep3:not(.hidden)');
      assert(await page.inputValue('#bookingDateInput') === TODAY, 'evening still defaults to local today, got ' + await page.inputValue('#bookingDateInput'));
      assertIncludes(await page.textContent('#bookingTimeSlotsGrid'), 'No open times left', 'empty-day message');
      await page.evaluate(() => goToBookingStep(4));
      assert(await visible(page, '#bookStep3') && !(await visible(page, '#bookStep4')), 'cannot continue without a time');
      await page.fill('#bookingDateInput', TOMORROW);
      await page.dispatchEvent('#bookingDateInput', 'change');
      assert(await page.locator('#bookingTimeSlotsGrid button').count() > 0, 'tomorrow has slots');
      assert(errors.length === 0, 'no errors: ' + errors.join(' | '));
      assert(stats.liveHits === 0, 'live Worker never contacted');
    } finally { await context.close(); }
  });
}

// Install-to-home-screen: real PNG icons, a start URL that is not redirected by Pages,
// and the installed app opening offline at its start URL and shortcut URLs.
const pngSize = (buf) => (buf.slice(1, 4).toString() === 'PNG' ? { w: buf.readUInt32BE(16), h: buf.readUInt32BE(20), alpha: buf[25] === 6 } : null);

async function pwaSuite(browser, vp) {
  await test(`[${vp.name}] installable: PNG icons, Chrome install check, offline start URL and shortcuts`, async () => {
    const man = JSON.parse(fs.readFileSync(path.join(ROOT, 'manifest.json'), 'utf8'));
    const html = fs.readFileSync(path.join(ROOT, 'index.html'), 'utf8');
    const urls = [man.start_url, man.id, ...(man.shortcuts || []).map(s => s.url)];
    assert(urls.every(u => !/index\.html/.test(u)), 'manifest never points at index.html (Pages redirects it): ' + urls.join(', '));
    assert(!/data:image\/svg/.test(JSON.stringify(man.icons)) && !/apple-touch-icon" href="data:/.test(html), 'icons are files, not data: SVGs');
    const want = { 'any:192x192': 192, 'any:512x512': 512, 'maskable:512x512': 512 };
    for (const [key, size] of Object.entries(want)) {
      const [purpose, sizes] = key.split(':');
      const icon = man.icons.find(i => i.purpose === purpose && i.sizes === sizes);
      assert(icon && icon.type === 'image/png', `manifest has a ${purpose} ${sizes} PNG`);
      const dim = pngSize(fs.readFileSync(path.join(ROOT, icon.src)));
      assert(dim && dim.w === size && dim.h === size, `${icon.src} is ${size}x${size}, got ${JSON.stringify(dim)}`);
      if (purpose === 'maskable') assert(!dim.alpha, 'maskable icon is opaque');
    }
    const apple = (html.match(/rel="apple-touch-icon" href="([^"]+)"/) || [])[1];
    const appleDim = apple && pngSize(fs.readFileSync(path.join(ROOT, apple)));
    assert(appleDim && appleDim.w === 180 && appleDim.h === 180 && !appleDim.alpha, 'apple-touch-icon is an opaque 180x180 PNG');

    const { context, page, errors, stats } = await newApp(browser, vp, { serviceWorkers: 'allow' });
    try {
      await page.goto(BASE + '/', { waitUntil: 'load' });
      await page.evaluate(async () => { await navigator.serviceWorker.ready; });
      await page.waitForFunction(() => !!navigator.serviceWorker.controller, null, { timeout: 10000 });
      await page.waitForTimeout(300);
      const cdp = await context.newCDPSession(page);
      const { installabilityErrors } = await cdp.send('Page.getInstallabilityErrors');
      assert(installabilityErrors.length === 0, 'Chrome reports installable: ' + JSON.stringify(installabilityErrors));
      const { errors: manErrors } = await cdp.send('Page.getAppManifest');
      assert(manErrors.length === 0, 'manifest parses cleanly: ' + JSON.stringify(manErrors));

      await context.setOffline(true);
      for (const u of [man.start_url, ...(man.shortcuts || []).map(s => s.url), './?portal=admin']) {
        const res = await page.goto(new URL(u, BASE + '/').href, { waitUntil: 'load' });
        assert(res && res.ok(), `offline ${u} answered from cache`);
        assert(await page.textContent('#headerShopName') === 'ELITE CUTS', `offline ${u} renders the app`);
      }
      assert(await page.locator('#portalScreen, [id*="admin"]').count() > 0, 'portal route renders offline');
      const pageErrors = errors.filter(e => e.startsWith('pageerror'));
      assert(pageErrors.length === 0, 'no page errors:\n' + pageErrors.join('\n'));
      assert(stats.liveHits === 0, 'no live Worker hits');
      await context.setOffline(false);
    } finally { await context.close(); }
  });
}

async function shellSuite() {
  await test('sw.js APP_SHELL lists every local css/js file and nothing missing', async () => {
    const swSrc = fs.readFileSync(path.join(ROOT, 'sw.js'), 'utf8');
    const shell = [...swSrc.match(/APP_SHELL = \[([\s\S]*?)\]/)[1].matchAll(/'([^']+)'/g)].map(m => m[1].replace(/^\.\//, ''));
    for (const f of shell.filter(Boolean)) assert(fs.existsSync(path.join(ROOT, f)), `APP_SHELL entry exists: ${f}`);
    const local = ['css', 'js'].flatMap(d => fs.existsSync(path.join(ROOT, d)) ? fs.readdirSync(path.join(ROOT, d)).map(f => `${d}/${f}`) : []);
    for (const f of local) assert(shell.includes(f), `${f} is in APP_SHELL`);
  });
}

// ---------------------------------------------------------------- main
await startServer();
const browser = await chromium.launch();
try {
  await shellSuite();
  for (const vp of VIEWPORTS) {
    await coreSuite(browser, vp);
    await nextChairSuite(browser, vp);
    await datesSuite(browser, vp);
    await offlineSuite(browser, vp);
    await pwaSuite(browser, vp);
  }
} finally {
  await browser.close();
  stopServer();
}
console.log(`\n${results.length - failures}/${results.length} passed`);
process.exit(failures ? 1 : 0);
