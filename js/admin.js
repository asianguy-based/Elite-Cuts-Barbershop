import { MANAGER_TOKEN_KEY, api, apiConfigured, escapeHtml, loadPaymentsInfo, loadSharedSettings, paymentsInfo, publishSharedSettings } from './api.js';
import { refreshNextChair, renderNextChair, resetSlotCaches, syncBookingWithConfig } from './booking.js';
import { SHARED_FIELDS, STORAGE_KEY_CONFIG, pickShared, saveConfig, shopConfig } from './config.js';
import { STORAGE_KEY_REVIEWS, markReviewsRead, renderAdminReviews } from './reviews.js';
import { LoyaltyVault, STORAGE_KEY_BOOKINGS, STORAGE_KEY_LOYALTY, bookings, loyaltyDB, normalizePhone, saveBookings, saveLoyaltyDB, setBookings } from './storage.js';
import { applyThemeVariables, renderHome, switchTab } from './ui.js';

// Manager portal (?portal=admin): PIN gate, then four tabs:
//   Appointments (queue + calendar) / Barber Roster / Customer VIP Information (wallets + loyalty CSV) /
//   Admin (Application Settings, Client Reviews, Import/Export Barbershop Settings).

const ADMIN_TABS = ['appointments', 'barbers', 'vip', 'admin'];
const ADMIN_TAB_KEY = 'EC_ADMIN_TAB';

export function switchAdminTab(tab) {
  if (!ADMIN_TABS.includes(tab)) tab = 'appointments';
  ADMIN_TABS.forEach(t => {
    document.getElementById(`adminPanel-${t}`).classList.toggle('hidden', t !== tab);
    const btn = document.getElementById(`adminTabBtn-${t}`);
    btn.setAttribute('aria-selected', String(t === tab));
    btn.tabIndex = t === tab ? 0 : -1;
  });
  try { sessionStorage.setItem(ADMIN_TAB_KEY, tab); } catch (err) { /* ignore */ }
  if (tab === 'appointments') renderAdminCalendar();
  if (tab === 'admin') renderAdminReviews().then(markReviewsRead);
}

function savedAdminTab() {
  try { return sessionStorage.getItem(ADMIN_TAB_KEY) || 'appointments'; } catch (err) { return 'appointments'; }
}

// EXPORT / IMPORT CSV
export async function exportLoyaltyCSV() {
  if (apiConfigured()) {
    try {
      const res = await api('/api/manager/loyalty.csv');
      if (!res.ok) { alert('CSV export failed (' + res.status + '). Are you logged in?'); return; }
      const blob = new Blob([res.data], { type: 'text/csv;charset=utf-8;' });
      const link = document.createElement('a');
      link.href = URL.createObjectURL(blob);
      link.download = `${shopConfig.shopName.toLowerCase().replace(/\s+/g, '-')}-vip-loyalty-database.csv`;
      link.click();
    } catch (err) {
      alert('Could not reach the booking server for CSV export.');
    }
    return;
  }
  let csv = 'Phone,Name,Points,Stamps\n';
  Object.keys(loyaltyDB).forEach(key => {
    const c = loyaltyDB[key];
    csv += `"${c.phone}","${c.name || 'Client'}",${c.points || 0},${c.stamps || 0}\n`;
  });
  const blob = new Blob([csv], { type: 'text/csv;charset=utf-8;' });
  const link = document.createElement('a');
  link.href = URL.createObjectURL(blob);
  link.download = `${shopConfig.shopName.toLowerCase().replace(/\s+/g, '-')}-vip-loyalty-database.csv`;
  link.click();
}

export function importLoyaltyCSV(event) {
  const file = event.target.files[0];
  if (!file) return;
  const reader = new FileReader();
  reader.onload = function(e) {
    const text = e.target.result;
    const lines = text.split('\n');
    let importedCount = 0;
    for (let i = 1; i < lines.length; i++) {
      const line = lines[i].trim();
      if (!line) continue;
      const cols = line.split(/,(?=(?:(?:[^"]*"){2})*[^"]*$)/);
      if (cols.length >= 3) {
        const phone = cols[0].replace(/["']/g, '').trim();
        const name = cols[1].replace(/["']/g, '').trim();
        const points = Number(cols[2]) || 0;
        const stamps = Number(cols[3]) || 0;
        const key = normalizePhone(phone);
        if (key) {
          loyaltyDB[key] = { name, phone, points, stamps };
          LoyaltyVault.saveToDevice(phone, { name, phone, points, stamps, history: [] });
          importedCount++;
        }
      }
    }
    saveLoyaltyDB();
    alert(`Successfully imported ${importedCount} client records!`);
  };
  reader.readAsText(file);
}

// ADMIN STUDIO
export function openAdminModal() {
  document.getElementById('adminModal').classList.remove('hidden');
  fillSettingsForm();
  document.getElementById('adminPinHint').textContent = apiConfigured()
    ? '(Live mode — PIN is checked by the API server)'
    : '(Demo mode — set an API URL in Settings for a real PIN. Demo PIN: 1234)';
  setPublishHint('');
  switchAdminTab(savedAdminTab());
  renderAdminQueue();
  renderAdminBarbers();
}

function fillSettingsForm() {
  document.getElementById('cfgShopName').value = shopConfig.shopName;
  document.getElementById('cfgTagline').value = shopConfig.tagline;
  document.getElementById('cfgPrimaryColor').value = shopConfig.primaryColor || '#1a1a2e';
  document.getElementById('cfgAccentColor').value = shopConfig.accentColor || '#d4af37';
  document.getElementById('cfgPaymentLinkUrl').value = shopConfig.paymentLinkUrl || '';
  document.getElementById('cfgApiBaseUrl').value = shopConfig.apiBaseUrl || '';
  document.getElementById('cfgReviewsAreSamples').checked = !!shopConfig.reviewsAreSamples;
  document.getElementById('cfgDepositAmount').value = shopConfig.depositAmount ?? 15;
  document.getElementById('cfgWalletTopUps').value = (shopConfig.walletTopUps || [25, 50, 100]).join(', ');
  document.getElementById('cfgDepositEnabled').checked = shopConfig.depositEnabled !== false;
  document.getElementById('cfgPrepayEnabled').checked = shopConfig.prepayEnabled !== false;
  document.getElementById('cfgWalletEnabled').checked = shopConfig.walletEnabled !== false;
  document.getElementById('cfgRequireDeposit').checked = !!shopConfig.requireDeposit;
  const info = apiConfigured() ? paymentsInfo : null;
  document.getElementById('cfgStripeStatus').textContent = !apiConfigured() ? '(demo mode: payment link only)'
    : !info ? ''
    : info.stripe ? (info.testMode ? '(Stripe TEST mode: no real money)' : '(Stripe LIVE)')
    : info.liveKeyBlocked ? '(Stripe live key ignored: set a test key)'
    : '(Stripe not set up: deposits use the payment link)';
}

function setPublishHint(msg) {
  const el = document.getElementById('adminPublishHint');
  if (!el) return;
  el.textContent = msg;
  el.classList.toggle('hidden', !msg);
}

// Live mode: the studio edits the published profile, so pull the latest one before showing the form.
async function syncSettingsFromServer() {
  const result = await loadSharedSettings();
  if (result && result.changed) { applyThemeVariables(); renderHome(); }
  fillSettingsForm();
  if (result && !result.published) {
    setPublishHint('Your shop settings are not published yet, so clients see the defaults. Press Apply Settings to publish what is shown here.');
  } else if (!result) {
    setPublishHint('Could not load the published shop settings. Edits will be checked when you save.');
  } else {
    setPublishHint('');
  }
}

export function closeAdminModal() {
  // Closing the portal logs the manager out (the server deletes the session), so a shared
  // shop tablet doesn't stay unlocked.
  const token = sessionStorage.getItem(MANAGER_TOKEN_KEY);
  if (token && apiConfigured()) api('/api/manager/logout', { method: 'POST' }).catch(() => {});
  sessionStorage.removeItem(MANAGER_TOKEN_KEY);
  remoteBookings = null;
  document.getElementById('adminPinInput').value = '';
  document.getElementById('adminContent').classList.add('hidden');
  document.getElementById('adminPinGate').classList.remove('hidden');
  if (window.location.search.includes('portal=')) {
    window.history.replaceState({}, document.title, window.location.pathname);
  }
  document.getElementById('adminModal').classList.add('hidden');
  switchTab('home');
}

export async function unlockAdmin() {
  const pin = document.getElementById('adminPinInput').value;
  if (apiConfigured()) {
    let res;
    try {
      res = await api('/api/manager/login', { method: 'POST', body: { pin } });
    } catch (err) {
      alert('Could not reach the booking server to verify the PIN.');
      return;
    }
    if (!res.ok || !res.data.token) {
      alert('Invalid Manager PIN.');
      return;
    }
    sessionStorage.setItem(MANAGER_TOKEN_KEY, res.data.token);
  } else if (pin !== '1234') {
    alert('Invalid Manager PIN. Demo mode — set an API URL in Settings for a real PIN (demo PIN is 1234).');
    return;
  }
  document.getElementById('adminPinGate').classList.add('hidden');
  document.getElementById('adminContent').classList.remove('hidden');
  if (apiConfigured()) {
    await loadPaymentsInfo();
    await syncSettingsFromServer();
  }
  renderAdminQueue();
  renderAdminBarbers();
  renderAdminWallets();
  renderAdminReviews();
  switchAdminTab(savedAdminTab());
}

export let remoteBookings = null; // manager list loaded from the API (live mode only)

export async function renderAdminQueue() {
  let rows = bookings;
  if (apiConfigured()) {
    if (sessionStorage.getItem(MANAGER_TOKEN_KEY)) {
      try {
        const res = await api('/api/manager/bookings');
        if (res.ok) remoteBookings = res.data.bookings || [];
        else if (res.status === 401) sessionStorage.removeItem(MANAGER_TOKEN_KEY);
      } catch (err) {
        console.warn('Manager bookings fetch failed:', err);
      }
    }
    rows = remoteBookings || [];
  }
  document.getElementById('adminBookingCount').textContent = rows.length;
  const list = document.getElementById('adminAppointmentsList');
  if (rows.length === 0) {
    list.innerHTML = `<div class="text-xs text-gray-400 py-1">No appointments in queue.</div>`;
  } else {
    list.innerHTML = rows.map(bookingRow).join('');
  }
  renderAdminCalendar();
}

function bookingRow(b) {
  const phone = b.clientPhone
    ? ` • ${escapeHtml(b.clientPhone)}`
    : (b.status === 'Cancelled' ? ' • <span class="text-gray-500">phone removed</span>' : '');
  return `
    <div class="p-2.5 rounded-xl bg-primary border border-white/10 flex items-center justify-between gap-2 text-xs">
      <div class="min-w-0">
        <div class="font-bold text-white">${escapeHtml(b.clientName)} <span class="text-accent">(${escapeHtml(b.refCode)})</span></div>
        <div class="text-[11px] text-gray-400">${escapeHtml(b.date)} ${escapeHtml(b.time)} • ${escapeHtml(b.barberName)} • <span class="text-gray-300">${escapeHtml(b.status || '')}</span>${payLabel(b)}${phone}</div>
      </div>
      <div class="flex gap-1 shrink-0">
        ${apiConfigured() && b.paymentMode === 'deposit' && !b.paid ? `<button data-id="${escapeHtml(b.id)}" onclick="updateBookingStatus(this.dataset.id, 'Paid')" class="px-2 py-1 rounded bg-accent/20 text-accent text-[10px]">Paid</button>` : ''}
        <button data-id="${escapeHtml(b.id)}" onclick="updateBookingStatus(this.dataset.id, 'Completed')" class="px-2 py-1 rounded bg-emerald-500/20 text-emerald-300 text-[10px]">Done</button>
        <button data-id="${escapeHtml(b.id)}" onclick="updateBookingStatus(this.dataset.id, 'Cancelled')" class="px-2 py-1 rounded bg-rose-500/20 text-rose-300 text-[10px]">Cancel</button>
      </div>
    </div>`;
}

// CALENDAR (Appointments tab): one month, a count per day; tap a day to list its bookings.
const pad2 = (n) => String(n).padStart(2, '0');
const localDate = (d) => `${d.getFullYear()}-${pad2(d.getMonth() + 1)}-${pad2(d.getDate())}`;
let calMonth = localDate(new Date()).slice(0, 7);   // "YYYY-MM"
let calSelected = '';
let calRows = [];
let calLoadedFor = '';

export function shiftAdminCalendar(delta) {
  const [y, m] = calMonth.split('-').map(Number);
  const d = new Date(y, m - 1 + delta, 1);
  calMonth = `${d.getFullYear()}-${pad2(d.getMonth() + 1)}`;
  calSelected = '';
  renderAdminCalendar();
}

export function selectAdminCalendarDay(date) {
  calSelected = calSelected === date ? '' : date;
  drawCalendar();
}

export async function renderAdminCalendar() {
  const grid = document.getElementById('adminCalendarGrid');
  if (!grid) return;
  const [y, m] = calMonth.split('-').map(Number);
  const last = new Date(y, m, 0).getDate();
  const from = `${calMonth}-01`, to = `${calMonth}-${pad2(last)}`;
  if (apiConfigured()) {
    if (sessionStorage.getItem(MANAGER_TOKEN_KEY)) {
      try {
        const res = await api(`/api/manager/bookings?from=${from}&to=${to}`);
        if (res.ok) { calRows = res.data.bookings || []; calLoadedFor = calMonth; }
      } catch (err) {
        console.warn('Calendar fetch failed:', err);
      }
    }
    if (calLoadedFor !== calMonth) calRows = [];
  } else {
    calRows = bookings.filter(b => b.date >= from && b.date <= to);
  }
  drawCalendar();
}

function drawCalendar() {
  const grid = document.getElementById('adminCalendarGrid');
  if (!grid) return;
  const [y, m] = calMonth.split('-').map(Number);
  const first = new Date(y, m - 1, 1);
  const days = new Date(y, m, 0).getDate();
  const today = localDate(new Date());
  document.getElementById('adminCalMonth').textContent = first.toLocaleDateString(undefined, { month: 'long', year: 'numeric' });
  const active = calRows.filter(b => b.status !== 'Cancelled');
  const counts = {};
  active.forEach(b => { counts[b.date] = (counts[b.date] || 0) + 1; });
  let cells = '';
  for (let i = 0; i < first.getDay(); i++) cells += '<span></span>';
  for (let d = 1; d <= days; d++) {
    const date = `${calMonth}-${pad2(d)}`;
    const n = counts[date] || 0;
    const sel = date === calSelected;
    cells += `<button type="button" data-date="${date}" onclick="selectAdminCalendarDay(this.dataset.date)"
      aria-label="${date}: ${n} appointment${n === 1 ? '' : 's'}" aria-pressed="${sel}"
      class="h-11 rounded-lg flex flex-col items-center justify-center text-[11px] border ${sel ? 'bg-accent text-[#1a1a2e] border-accent font-bold' : date === today ? 'bg-white/10 text-white border-accent/60' : 'bg-primary text-gray-300 border-white/10'}">
      <span>${d}</span>${n ? `<span class="text-[9px] leading-none ${sel ? '' : 'text-accent'} font-bold">${n}</span>` : ''}
    </button>`;
  }
  grid.innerHTML = cells;
  const dayBox = document.getElementById('adminCalendarDay');
  if (!calSelected) {
    dayBox.innerHTML = `<p class="text-[11px] text-gray-400">${active.length} appointment${active.length === 1 ? '' : 's'} this month. Tap a day to see them.</p>`;
    return;
  }
  const rows = calRows.filter(b => b.date === calSelected).sort((a, b) => slotMinutes(a.time) - slotMinutes(b.time));
  dayBox.innerHTML = `<div class="text-[11px] font-semibold text-white">${escapeHtml(calSelected)}</div>` +
    (rows.length ? rows.map(bookingRow).join('') : '<p class="text-[11px] text-gray-400">No appointments that day.</p>');
}

/** "01:30 PM" -> minutes after midnight, for sorting a day's list. */
function slotMinutes(t) {
  const mt = /^(\d{1,2}):(\d{2})\s*(AM|PM)$/i.exec(String(t || '').trim());
  if (!mt) return 0;
  return ((Number(mt[1]) % 12) + (mt[3].toUpperCase() === 'PM' ? 12 : 0)) * 60 + Number(mt[2]);
}

const PAY_LABELS = { deposit: 'Deposit', prepay: 'Prepaid', wallet: 'Wallet', chair: 'At chair' };
function payLabel(b) {
  const opt = b.payOption || b.paymentMode;
  if (!opt || !PAY_LABELS[opt]) return '';
  const amt = b.amountDue ? ` $${escapeHtml(b.amountDue)}` : '';
  return ` • <span class="text-accent">${PAY_LABELS[opt]}${amt}</span>`;
}

export async function updateBookingStatus(id, status) {
  if (apiConfigured()) {
    try {
      const res = await api(`/api/manager/bookings/${encodeURIComponent(id)}`, { method: 'PATCH', body: { status } });
      if (!res.ok) alert('Update failed: ' + ((res.data && res.data.error) || res.status));
      else if (res.data && res.data.creditReturned) alert(creditBackMessage(res.data));
    } catch (err) {
      alert('Could not reach the booking server to update this booking.');
    }
    renderAdminQueue();
    refreshNextChair();
    return;
  }
  setBookings(bookings.map(b => b.id === id ? { ...b, status } : b));
  saveBookings();
  renderAdminQueue();
  renderNextChair();
}

const EMAIL_RESULT = {
  sent: 'The client was emailed that their credit is back.',
  no_address: 'No email sent: the client did not give an email address.',
  not_configured: 'No email sent: email is not set up on the booking server yet.',
  failed: 'The email could not be sent. You may want to call or text the client.'
};
export function creditBackMessage(data) {
  return `$${Number(data.creditReturned).toFixed(2)} went back on the client's VIP wallet and their phone number was taken off this appointment.\n` +
    (EMAIL_RESULT[data.email] || '');
}

// Clear Cancelled: in live mode the queue comes from the server, so the server hides them
// (it used to filter only this browser's demo list, so nothing happened in live mode).
export async function clearCancelledBookings() {
  if (apiConfigured()) {
    let res;
    try {
      res = await api('/api/manager/bookings/clear-cancelled', { method: 'POST' });
    } catch (err) {
      alert('Could not reach the booking server to clear cancelled appointments.');
      return;
    }
    if (!res.ok) {
      if (res.status === 401) sessionStorage.removeItem(MANAGER_TOKEN_KEY);
      alert(res.status === 401 ? 'Your manager login expired. Close the studio and log in again.' : 'Clear failed: ' + ((res.data && res.data.error) || res.status));
      return;
    }
    await renderAdminQueue();
    if (!res.data.cleared) alert('There are no cancelled appointments to clear.');
    return;
  }
  const before = bookings.length;
  setBookings(bookings.filter(b => b.status !== 'Cancelled'));
  saveBookings();
  renderAdminQueue();
  renderNextChair();
  if (before === bookings.length) alert('There are no cancelled appointments to clear.');
}

export function renderAdminBarbers() {
  document.getElementById('adminBarberCount').textContent = shopConfig.barbers.length;
  const list = document.getElementById('adminBarbersList');
  list.innerHTML = shopConfig.barbers.map(b => `
    <div class="p-2.5 rounded-xl bg-primary border border-white/10 flex items-center justify-between text-xs">
      <div class="flex items-center gap-2">
        <img src="${escapeHtml(b.avatar)}" class="w-8 h-8 rounded-full object-cover border border-accent" alt="" />
        <div>
          <div class="font-bold text-white">${escapeHtml(b.name)}</div>
          <div class="text-[10px] text-accent">Folder: /barbers/${escapeHtml(b.folder)}/ (${escapeHtml(b.photoFilename)})</div>
        </div>
      </div>
      <button data-id="${escapeHtml(b.id)}" onclick="removeBarber(this.dataset.id)" aria-label="Remove ${escapeHtml(b.name)}" class="px-2 py-1 rounded bg-rose-500/20 text-rose-300 text-[10px]">
        <i class="fa-solid fa-trash-can"></i>
      </button>
    </div>
  `).join('');
}

export function addNewBarberWithFolder() {
  const first = document.getElementById('newBarberFirst').value.trim();
  const last = document.getElementById('newBarberLast').value.trim();
  const specialty = document.getElementById('newBarberSpecialty').value.trim() || 'Precision Fades';
  const fileInput = document.getElementById('newBarberPhotoFile');

  if (!first || !last) {
    alert('Please enter both first and last name for the barber.');
    return;
  }

  const firstName = first.toLowerCase().replace(/[^a-z0-9]/g, '');
  const lastName = last.toLowerCase().replace(/[^a-z0-9]/g, '');
  const folderName = `${firstName}_${lastName}`;

  const existingSameFolder = shopConfig.barbers.filter(b => b.folder === folderName);
  const nextNum = String(existingSameFolder.length + 1).padStart(3, '0');
  const filename = `${folderName}_${nextNum}.jpg`;   // uploads are re-encoded as JPEG below

  if (fileInput.files && fileInput.files[0]) {
    // Shrink the photo first: it is stored with the shop settings and downloaded by every client.
    return shrinkPhoto(fileInput.files[0]).then(dataUrl => {
      if (!dataUrl) { alert('Could not read that photo. Try a JPEG or PNG.'); return; }
      return saveBarberToConfig(first, last, folderName, filename, specialty, dataUrl);
    });
  }
  const defaultAvatar = 'https://images.unsplash.com/photo-1534528741775-53994a69daeb?auto=format&fit=crop&w=240&q=80';
  return saveBarberToConfig(first, last, folderName, filename, specialty, defaultAvatar);
}

/** Read an image file and return it as a JPEG data URL at most `max` pixels on its longest side. */
export function shrinkPhoto(file, max = 320) {
  return new Promise(resolve => {
    const reader = new FileReader();
    reader.onerror = () => resolve(null);
    reader.onload = () => {
      const img = new Image();
      img.onerror = () => resolve(null);
      img.onload = () => {
        try {
          const scale = Math.min(1, max / Math.max(img.width, img.height));
          const canvas = document.createElement('canvas');
          canvas.width = Math.max(1, Math.round(img.width * scale));
          canvas.height = Math.max(1, Math.round(img.height * scale));
          canvas.getContext('2d').drawImage(img, 0, 0, canvas.width, canvas.height);
          resolve(canvas.toDataURL('image/jpeg', 0.85));
        } catch (err) {
          resolve(null);
        }
      };
      img.src = reader.result;
    };
    reader.readAsDataURL(file);
  });
}

// Live mode: send the change to the API first and only show it once the server has stored it,
// so the studio never shows an edit that clients won't see. Demo mode: save on this device.
async function commitShared(changes) {
  if (apiConfigured()) {
    const result = await publishSharedSettings(changes);
    if (!result.ok) { alert('Not saved: ' + result.error); return false; }
    setPublishHint('');
    return true;
  }
  Object.assign(shopConfig, changes);
  saveConfig();
  return true;
}

export async function saveBarberToConfig(first, last, folder, filename, specialty, avatar) {
  const newBarber = {
    id: 'brb-' + Date.now(),
    firstName: first,
    lastName: last,
    name: `${first} ${last}`,
    folder,
    photoFilename: filename,
    role: 'Master Barber',
    specialty,
    rating: '5.0',
    avatar
  };

  if (!(await commitShared({ barbers: [...shopConfig.barbers, newBarber] }))) return;

  document.getElementById('newBarberFirst').value = '';
  document.getElementById('newBarberLast').value = '';
  document.getElementById('newBarberSpecialty').value = '';
  document.getElementById('newBarberPhotoFile').value = '';

  renderAdminBarbers();
  renderHome();
  applyThemeVariables();
  alert(`Barber folder created: /barbers/${folder}/\nPhoto saved as: ${filename}` + (apiConfigured() ? '\nPublished to every client.' : ''));
}

export async function removeBarber(id) {
  if (shopConfig.barbers.length <= 1) {
    alert('You must keep at least one active barber chair.');
    return;
  }
  if (!(await commitShared({ barbers: shopConfig.barbers.filter(b => b.id !== id) }))) return;
  syncBookingWithConfig();
  renderAdminBarbers();
  renderHome();
  applyThemeVariables();
}

export async function saveWhiteLabelConfig() {
  const edits = {
    shopName: document.getElementById('cfgShopName').value.trim() || 'ELITE CUTS',
    tagline: document.getElementById('cfgTagline').value.trim(),
    primaryColor: document.getElementById('cfgPrimaryColor').value,
    accentColor: document.getElementById('cfgAccentColor').value,
    paymentLinkUrl: document.getElementById('cfgPaymentLinkUrl').value.trim(),
    depositAmount: Math.max(0, Math.min(500, Math.round(Number(document.getElementById('cfgDepositAmount').value) || 0))),
    depositEnabled: document.getElementById('cfgDepositEnabled').checked,
    prepayEnabled: document.getElementById('cfgPrepayEnabled').checked,
    walletEnabled: document.getElementById('cfgWalletEnabled').checked,
    requireDeposit: document.getElementById('cfgRequireDeposit').checked,
    walletTopUps: parseTopUps(document.getElementById('cfgWalletTopUps').value)
  };
  const apiBaseUrl = document.getElementById('cfgApiBaseUrl').value.trim();
  const apiChanged = apiBaseUrl !== (shopConfig.apiBaseUrl || '').trim();
  let note;
  if (apiConfigured() && !apiChanged) {
    // Publish the whole shared profile, so a shop's first save also publishes its services, hours etc.
    // Reviews are left out: the server keeps them in step with the Client Reviews log.
    if (!(await commitShared({ ...sharedWithoutReviews(), ...edits }))) return;
    note = ' Published to every client.';
  } else {
    // Demo mode, or the API URL itself is changing: keep the edits on this device for now.
    Object.assign(shopConfig, edits);
    note = !apiBaseUrl ? ' Demo mode (no API URL).'
      : ' API URL changed: close the Manager Studio and log in again, then Apply Settings to publish to the new server.';
  }
  shopConfig.apiBaseUrl = apiBaseUrl;
  saveConfig();
  resetSlotCaches();
  applyThemeVariables();
  renderHome();
  renderAdminBarbers();
  alert('Settings Updated!' + note);
}

/** "25, 50, 100" -> [25, 50, 100]: whole dollars $5-$500, no repeats, at most 6 (the server checks the same). */
export function parseTopUps(text) {
  const list = [...new Set(String(text).split(/[\s,]+/).map(Number).filter(n => Number.isInteger(n) && n >= 5 && n <= 500))].sort((a, b) => a - b).slice(0, 6);
  return list.length ? list : [25, 50, 100];
}

// VIP WALLET CREDIT (live mode): balances, add/remove credit (cash loads, goodwill, fixes), PIN reset.
export async function renderAdminWallets() {
  const section = document.getElementById('adminWalletsSection');
  if (!section) return;
  const live = apiConfigured() && sessionStorage.getItem(MANAGER_TOKEN_KEY);
  section.classList.toggle('hidden', !live);
  document.getElementById('adminWalletsDemoNote').classList.toggle('hidden', !!live);
  if (!live) return;
  let wallets = [];
  try {
    const res = await api('/api/manager/wallets');
    if (res.ok) wallets = res.data.wallets || [];
    else if (res.status === 404) { section.classList.add('hidden'); return; }   // Worker without payments yet
  } catch (err) {
    console.warn('Wallets fetch failed:', err);
  }
  document.getElementById('adminWalletCount').textContent = wallets.length;
  document.getElementById('adminWalletsList').innerHTML = wallets.length ? wallets.map(w => `
    <div class="p-2.5 rounded-xl bg-primary border border-white/10 flex items-center justify-between text-xs">
      <div>
        <div class="font-bold text-white">${escapeHtml(w.name || 'Client')} <span class="text-gray-400 font-normal">${escapeHtml(w.phone)}</span></div>
        <div class="text-[11px] text-accent font-semibold">$${escapeHtml(Number(w.balance).toFixed(2))}${w.hasPin ? '' : ' <span class="text-gray-400 font-normal">• no PIN set</span>'}</div>
      </div>
      <button data-phone="${escapeHtml(w.phone)}" onclick="adminResetWalletPin(this.dataset.phone)" class="px-2 py-1 rounded bg-white/10 text-gray-200 text-[10px]">Reset PIN</button>
    </div>
  `).join('') : `<div class="text-xs text-gray-400 py-1">No wallets yet.</div>`;
}

export async function adminAddWalletCredit() {
  const phone = (prompt('Client phone number:') || '').replace(/\D/g, '');
  if (!phone) return;
  const amount = Number(prompt('Amount in dollars. Use a minus sign to remove credit (e.g. -10):') || '');
  if (!Number.isFinite(amount) || amount === 0) return;
  const note = prompt('Note (optional, e.g. "Cash load"):') || '';
  try {
    const res = await api(`/api/manager/wallets/${encodeURIComponent(phone)}/adjust`, { method: 'POST', body: { amount, note } });
    if (!res.ok) { alert('Not saved: ' + ((res.data && res.data.error) || res.status)); return; }
    alert(`New balance: $${Number(res.data.balance).toFixed(2)}`);
  } catch (err) {
    alert('Could not reach the booking server.');
  }
  renderAdminWallets();
}

export async function adminResetWalletPin(phone) {
  if (!confirm(`Reset the wallet PIN for ${phone}? The next PIN the client enters becomes the new one, so do this with the client in the shop.`)) return;
  try {
    const res = await api(`/api/manager/wallets/${encodeURIComponent(phone)}/reset-pin`, { method: 'POST' });
    if (!res.ok) alert('Reset failed: ' + ((res.data && res.data.error) || res.status));
  } catch (err) {
    alert('Could not reach the booking server.');
  }
  renderAdminWallets();
}

function sharedWithoutReviews() {
  const out = pickShared();
  delete out.reviews;
  return out;
}

// "Label shown reviews as samples" (Admin > Client Reviews) saves straight away.
export async function saveReviewsAreSamples(checked) {
  if (!(await commitShared({ reviewsAreSamples: !!checked }))) {
    document.getElementById('cfgReviewsAreSamples').checked = !!shopConfig.reviewsAreSamples;
    return;
  }
  renderHome();
}

// IMPORT / EXPORT BARBERSHOP SETTINGS. The file holds the shop profile only (no client phones or bookings).
export const SETTINGS_FILE_KIND = 'elite-cuts-barbershop-settings';

export function buildSettingsExport(cfg = shopConfig) {
  return { kind: SETTINGS_FILE_KIND, version: 1, exportedAt: new Date().toISOString(), settings: pickShared(cfg) };
}

/** The shared settings inside an export file (this format, or an old "Tenant Backup"), or null. */
export function settingsFromFile(data) {
  if (!data || typeof data !== 'object') return null;
  const src = data.kind === SETTINGS_FILE_KIND ? data.settings : data.shopConfig;
  if (!src || typeof src !== 'object' || Array.isArray(src)) return null;
  const out = {};
  SHARED_FIELDS.forEach(k => { if (src[k] !== undefined) out[k] = src[k]; });
  return Object.keys(out).length ? out : null;
}

export function exportShopSettings() {
  const blob = new Blob([JSON.stringify(buildSettingsExport(), null, 2)], { type: 'application/json' });
  const a = document.createElement('a');
  a.href = URL.createObjectURL(blob);
  a.download = `${shopConfig.shopName.toLowerCase().replace(/[^a-z0-9]+/g, '-')}-settings.json`;
  a.click();
}

export function importShopSettings(event) {
  const input = event.target;
  const file = input.files && input.files[0];
  if (!file) return;
  const reader = new FileReader();
  reader.onload = async () => {
    input.value = '';
    let settings = null;
    try { settings = settingsFromFile(JSON.parse(reader.result)); } catch (err) { settings = null; }
    if (!settings) { alert('That file is not an Elite Cuts settings export.'); return; }
    // Live mode: reviews live in the Client Reviews log (ticked there), so an import leaves them alone.
    const live = apiConfigured();
    if (live) delete settings.reviews;
    const name = settings.shopName || shopConfig.shopName;
    if (!confirm(`Replace this shop's settings with the ones in "${file.name}" (${name})?` +
      (live ? ' They are published to every client right away. Reviews are not changed.' : ''))) return;
    if (!(await commitShared(live ? { ...sharedWithoutReviews(), ...settings } : settings))) return;
    if (!live) {
      try { localStorage.removeItem(STORAGE_KEY_REVIEWS); } catch (err) { /* ignore */ }   // re-seed the demo log from the imported reviews
    }
    syncBookingWithConfig();
    resetSlotCaches();
    applyThemeVariables();
    renderHome();
    fillSettingsForm();
    renderAdminBarbers();
    renderAdminReviews();
    alert('Settings imported.' + (live ? ' Published to every client.' : ''));
  };
  reader.readAsText(file);
}

export function resetDemoData() {
  localStorage.removeItem(STORAGE_KEY_REVIEWS);
  localStorage.removeItem(STORAGE_KEY_CONFIG);
  localStorage.removeItem(STORAGE_KEY_BOOKINGS);
  localStorage.removeItem(STORAGE_KEY_LOYALTY);
  location.reload();
}
