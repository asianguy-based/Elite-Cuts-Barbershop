import { MANAGER_TOKEN_KEY, api, apiConfigured, escapeHtml } from './api.js';
import { refreshNextChair, renderNextChair, resetSlotCaches } from './booking.js';
import { STORAGE_KEY_CONFIG, saveConfig, shopConfig } from './config.js';
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
  document.getElementById('cfgShopName').value = shopConfig.shopName;
  document.getElementById('cfgTagline').value = shopConfig.tagline;
  document.getElementById('cfgPrimaryColor').value = shopConfig.primaryColor || '#1a1a2e';
  document.getElementById('cfgAccentColor').value = shopConfig.accentColor || '#d4af37';
  document.getElementById('cfgPaymentLinkUrl').value = shopConfig.paymentLinkUrl || '';
  document.getElementById('cfgApiBaseUrl').value = shopConfig.apiBaseUrl || '';
  document.getElementById('cfgReviews').value = reviewsToText(shopConfig.reviews);
  document.getElementById('cfgReviewsAreSamples').checked = !!shopConfig.reviewsAreSamples;
  document.getElementById('adminPinHint').textContent = apiConfigured()
    ? '(Live mode — PIN is checked by the API server)'
    : '(Demo mode — set an API URL in Settings for a real PIN. Demo PIN: 1234)';
  renderAdminQueue();
  renderAdminBarbers();
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
  renderAdminQueue();
  renderAdminBarbers();
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
        <div class="text-[11px] text-gray-400">${escapeHtml(b.date)} ${escapeHtml(b.time)} • ${escapeHtml(b.barberName)} • <span class="text-gray-300">${escapeHtml(b.status || '')}</span></div>
      </div>
      <div class="flex gap-1">
        ${apiConfigured() && b.paymentMode === 'deposit' && !b.paid ? `<button data-id="${escapeHtml(b.id)}" onclick="updateBookingStatus(this.dataset.id, 'Paid')" class="px-2 py-1 rounded bg-accent/20 text-accent text-[10px]">Paid</button>` : ''}
        <button data-id="${escapeHtml(b.id)}" onclick="updateBookingStatus(this.dataset.id, 'Completed')" class="px-2 py-1 rounded bg-emerald-500/20 text-emerald-300 text-[10px]">Done</button>
        <button data-id="${escapeHtml(b.id)}" onclick="updateBookingStatus(this.dataset.id, 'Cancelled')" class="px-2 py-1 rounded bg-rose-500/20 text-rose-300 text-[10px]">Cancel</button>
      </div>
    </div>
  `).join('');
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
        <img src="${b.avatar}" class="w-8 h-8 rounded-full object-cover border border-accent" />
        <div>
          <div class="font-bold text-white">${b.name}</div>
          <div class="text-[10px] text-accent">Folder: /barbers/${b.folder}/ (${b.photoFilename})</div>
        </div>
      </div>
      <button onclick="removeBarber('${b.id}')" class="px-2 py-1 rounded bg-rose-500/20 text-rose-300 text-[10px]">
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
  const ext = fileInput.files[0] ? fileInput.files[0].name.split('.').pop() : 'jpg';
  const filename = `${folderName}_${nextNum}.${ext}`;

  if (fileInput.files && fileInput.files[0]) {
    const reader = new FileReader();
    reader.onload = function(e) {
      saveBarberToConfig(first, last, folderName, filename, specialty, e.target.result);
    };
    reader.readAsDataURL(fileInput.files[0]);
  } else {
    const defaultAvatar = 'https://images.unsplash.com/photo-1534528741775-53994a69daeb?auto=format&fit=crop&w=240&q=80';
    saveBarberToConfig(first, last, folderName, filename, specialty, defaultAvatar);
  }
}

export function saveBarberToConfig(first, last, folder, filename, specialty, avatar) {
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

  shopConfig.barbers.push(newBarber);
  saveConfig();

  document.getElementById('newBarberFirst').value = '';
  document.getElementById('newBarberLast').value = '';
  document.getElementById('newBarberSpecialty').value = '';
  document.getElementById('newBarberPhotoFile').value = '';

  renderAdminBarbers();
  renderHome();
  applyThemeVariables();
  alert(`Barber folder created: /barbers/${folder}/\nPhoto saved as: ${filename}`);
}

export function removeBarber(id) {
  if (shopConfig.barbers.length <= 1) {
    alert('You must keep at least one active barber chair.');
    return;
  }
  shopConfig.barbers = shopConfig.barbers.filter(b => b.id !== id);
  saveConfig();
  renderAdminBarbers();
  renderHome();
  applyThemeVariables();
}

export function saveWhiteLabelConfig() {
  shopConfig.shopName = document.getElementById('cfgShopName').value.trim() || 'ELITE CUTS';
  shopConfig.tagline = document.getElementById('cfgTagline').value.trim();
  shopConfig.primaryColor = document.getElementById('cfgPrimaryColor').value;
  shopConfig.accentColor = document.getElementById('cfgAccentColor').value;
  shopConfig.paymentLinkUrl = document.getElementById('cfgPaymentLinkUrl').value.trim();
  shopConfig.apiBaseUrl = document.getElementById('cfgApiBaseUrl').value.trim();
  shopConfig.reviews = textToReviews(document.getElementById('cfgReviews').value);
  shopConfig.reviewsAreSamples = document.getElementById('cfgReviewsAreSamples').checked;
  saveConfig();
  resetSlotCaches();
  applyThemeVariables();
  renderHome();
  alert('Settings Updated!' + (apiConfigured() ? ' Live API mode is on.' : ' Demo mode (no API URL).'));
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
