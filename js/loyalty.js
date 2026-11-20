import { api, apiConfigured } from './api.js';
import { LoyaltyVault, normalizePhone } from './storage.js';

// VIP wallet: punch card + phone lookup.

export function renderPunchCard(stamps = 0) {
  const grid = document.getElementById('punchCardGrid');
  let html = '';
  for (let i = 1; i <= 10; i++) {
    const filled = i <= stamps;
    html += `
      <div class="h-12 rounded-xl flex flex-col items-center justify-center border ${filled ? 'gold-gradient text-[#1a1a2e] border-accent font-extrabold shadow' : 'bg-secondary border-white/10 text-gray-500'}">
        <i class="fa-solid ${i === 10 ? 'fa-crown' : (filled ? 'fa-check' : 'fa-scissors')} text-xs"></i>
        <span class="text-[9px] mt-0.5">${i === 10 ? 'FREE' : '#' + i}</span>
      </div>
    `;
  }
  grid.innerHTML = html;
}

export async function lookupLoyalty() {
  const rawPhone = document.getElementById('loyaltyLookupPhone').value.trim();
  const key = normalizePhone(rawPhone);
  let record = LoyaltyVault.loadFromDevice(key);

  if (apiConfigured() && key) {
    try {
      const res = await api(`/api/loyalty?phone=${encodeURIComponent(key)}`);
      if (res && res.ok) record = res.data;
    } catch (err) {
      console.warn('Loyalty lookup failed, showing local cache:', err);
    }
  }

  document.getElementById('loyaltyPointsDisplay').textContent = `${record.points || 0} PTS`;
  document.getElementById('loyaltyStampsCount').textContent = `${record.stamps || 0} / 10 Cuts`;
  renderPunchCard(record.stamps || 0);

  const listEl = document.getElementById('clientAppointmentsList');
  if (!record.history || record.history.length === 0) {
    listEl.innerHTML = `<div class="text-xs text-gray-400">No past haircut visits found for this number.</div>`;
    return;
  }
  listEl.innerHTML = record.history.map(b => `
    <div class="p-3 rounded-xl bg-secondary border border-white/10 flex justify-between items-center">
      <div>
        <div class="text-xs font-bold text-white">${(b.services || []).join(', ')}</div>
        <div class="text-[11px] text-gray-400">${b.date} @ ${b.time} • ${b.barberName}</div>
      </div>
      <span class="text-[10px] px-2 py-0.5 rounded font-semibold bg-emerald-500/20 text-emerald-300">${b.status || b.refCode || ''}</span>
    </div>
  `).join('');
}
