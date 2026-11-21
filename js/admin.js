import { MANAGER_TOKEN_KEY, api, apiConfigured, escapeHtml, loadPaymentsInfo, loadSharedSettings, paymentsInfo, publishSharedSettings } from './api.js';
import { refreshNextChair, renderNextChair, resetSlotCaches, syncBookingWithConfig } from './booking.js';
import { STORAGE_KEY_CONFIG, pickShared, saveConfig, shopConfig } from './config.js';
import { LoyaltyVault, STORAGE_KEY_BOOKINGS, STORAGE_KEY_LOYALTY, bookings, loyaltyDB, normalizePhone, saveBookings, saveLoyaltyDB, setBookings } from './storage.js';
import { applyThemeVariables, renderHome, reviewsToText, switchTab, textToReviews } from './ui.js';

// Manager portal (?portal=admin): PIN gate, queue, barber folders, CSV, white-label settings.

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
  document.getElementById('cfgReviews').value = reviewsToText(shopConfig.reviews);
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
    return;
  }
  list.innerHTML = rows.map(b => `
    <div class="p-2.5 rounded-xl bg-primary border border-white/10 flex items-center justify-between text-xs">
      <div>
        <div class="font-bold text-white">${escapeHtml(b.clientName)} <span class="text-accent">(${escapeHtml(b.refCode)})</span></div>
        <div class="text-[11px] text-gray-400">${escapeHtml(b.date)} ${escapeHtml(b.time)} • ${escapeHtml(b.barberName)} • <span class="text-gray-300">${escapeHtml(b.status || '')}</span>${payLabel(b)}</div>
      </div>
      <div class="flex gap-1">
        ${apiConfigured() && b.paymentMode === 'deposit' && !b.paid ? `<button data-id="${escapeHtml(b.id)}" onclick="updateBookingStatus(this.dataset.id, 'Paid')" class="px-2 py-1 rounded bg-accent/20 text-accent text-[10px]">Paid</button>` : ''}
        <button data-id="${escapeHtml(b.id)}" onclick="updateBookingStatus(this.dataset.id, 'Completed')" class="px-2 py-1 rounded bg-emerald-500/20 text-emerald-300 text-[10px]">Done</button>
        <button data-id="${escapeHtml(b.id)}" onclick="updateBookingStatus(this.dataset.id, 'Cancelled')" class="px-2 py-1 rounded bg-rose-500/20 text-rose-300 text-[10px]">Cancel</button>
      </div>
    </div>
  `).join('');
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

export function clearCompletedBookings() {
  setBookings(bookings.filter(b => b.status !== 'Cancelled'));
  saveBookings();
  renderAdminQueue();
  renderNextChair();
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
    walletTopUps: parseTopUps(document.getElementById('cfgWalletTopUps').value),
    reviews: textToReviews(document.getElementById('cfgReviews').value),
    reviewsAreSamples: document.getElementById('cfgReviewsAreSamples').checked
  };
  const apiBaseUrl = document.getElementById('cfgApiBaseUrl').value.trim();
  const apiChanged = apiBaseUrl !== (shopConfig.apiBaseUrl || '').trim();
  let note;
  if (apiConfigured() && !apiChanged) {
    // Publish the whole shared profile, so a shop's first save also publishes its services, hours etc.
    if (!(await commitShared({ ...pickShared(), ...edits }))) return;
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

export function exportConfigJSON() {
  const payload = JSON.stringify({ shopConfig, bookings, loyaltyDB }, null, 2);
  const blob = new Blob([payload], { type: 'application/json' });
  const a = document.createElement('a');
  a.href = URL.createObjectURL(blob);
  a.download = `${shopConfig.shopName.toLowerCase().replace(/\s+/g, '-')}-backup.json`;
  a.click();
}

export function resetDemoData() {
  localStorage.removeItem(STORAGE_KEY_CONFIG);
  localStorage.removeItem(STORAGE_KEY_BOOKINGS);
  localStorage.removeItem(STORAGE_KEY_LOYALTY);
  location.reload();
}
