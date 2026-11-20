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
  await page.waitForTimeout(350); // let fade-in animations settle
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
      const pageErrors = errors.filter(e => e.startsWith('pageerror'));
      assert(pageErrors.length === 0, 'no page errors offline:\n' + pageErrors.join('\n'));
      assert(stats.liveHits === 0, 'no live Worker hits');
      await context.setOffline(false);
    } finally {
      await context.close();
    }
  });
}

// ---------------------------------------------------------------- main
await startServer();
const browser = await chromium.launch();
try {
  for (const vp of VIEWPORTS) {
    await coreSuite(browser, vp);
    await offlineSuite(browser, vp);
  }
} finally {
  await browser.close();
  stopServer();
}
console.log(`\n${results.length - failures}/${results.length} passed`);
process.exit(failures ? 1 : 0);
