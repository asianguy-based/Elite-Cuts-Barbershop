import { api, apiConfigured, escapeHtml, paymentsInfo } from './api.js';
import { shopConfig } from './config.js';
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

  renderWalletCard();
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
        <div class="text-xs font-bold text-white">${escapeHtml((b.services || []).join(', '))}</div>
        <div class="text-[11px] text-gray-400">${escapeHtml(b.date)} @ ${escapeHtml(b.time)} • ${escapeHtml(b.barberName)}</div>
      </div>
      <span class="text-[10px] px-2 py-0.5 rounded font-semibold bg-emerald-500/20 text-emerald-300">${escapeHtml(b.status || b.refCode || '')}</span>
    </div>
  `).join('');
}

// VIP WALLET CREDIT (live mode with the Worker). Store credit per phone number, protected by a 4-6 digit
// PIN that the client's first top-up sets. Top-ups go through Stripe Checkout; the webhook adds the credit.
export function walletAvailable() {
  return !!(apiConfigured() && paymentsInfo && paymentsInfo.options && paymentsInfo.options.wallet && shopConfig.walletEnabled !== false);
}

export function renderWalletCard() {
  const card = document.getElementById('walletCreditCard');
  if (!card) return;
  card.classList.toggle('hidden', !walletAvailable());
  if (!walletAvailable()) return;
  const canTopUp = !!paymentsInfo.options.walletTopUp;
  const amounts = (Array.isArray(paymentsInfo.walletTopUps) && paymentsInfo.walletTopUps.length ? paymentsInfo.walletTopUps : shopConfig.walletTopUps) || [25, 50, 100];
  document.getElementById('walletTopUpButtons').innerHTML = canTopUp
    ? amounts.map(a => `<button data-amount="${escapeHtml(a)}" onclick="topUpWallet(Number(this.dataset.amount))" class="py-2 rounded-xl gold-gradient text-[#1a1a2e] font-bold text-xs">+ $${escapeHtml(a)}</button>`).join('')
    : `<p class="col-span-full text-[11px] text-gray-400">Online top-ups are not set up yet. Ask the shop to load credit for you.</p>`;
  document.getElementById('walletTestNote').classList.toggle('hidden', !(canTopUp && paymentsInfo.testMode));
}

function walletCredentials() {
  const phone = normalizePhone(document.getElementById('loyaltyLookupPhone').value.trim());
  const pin = document.getElementById('walletPinInput').value.trim();
  if (!phone) { alert('Enter your phone number above first.'); return null; }
  if (!/^[0-9]{4,6}$/.test(pin)) { alert('Enter your 4-6 digit wallet PIN. Your first top-up sets it.'); return null; }
  return { phone, pin };
}

const money = (n) => `$${Number(n).toFixed(2)}`;
const KIND_LABEL = { topup: 'Top-up', spend: 'Booking', refund: 'Refund', adjustment: 'Shop adjustment' };

export async function loadWalletBalance() {
  const creds = walletCredentials();
  if (!creds) return;
  let res;
  try {
    res = await api('/api/wallet', { method: 'POST', body: creds });
  } catch (err) {
    alert('Could not reach the booking server.');
    return;
  }
  if (!res.ok) { alert((res.data && res.data.error) || `Server error ${res.status}`); return; }
  document.getElementById('walletBalanceDisplay').textContent = money(res.data.balance);
  document.getElementById('walletHistoryList').innerHTML = (res.data.history || []).map(h => `
    <div class="flex justify-between"><span>${escapeHtml(KIND_LABEL[h.kind] || h.kind)} ${escapeHtml(h.note || '')}</span>
      <span class="${h.amount < 0 ? 'text-rose-300' : 'text-emerald-300'} font-semibold">${h.amount < 0 ? '-' : '+'}${escapeHtml(money(Math.abs(h.amount)))}</span></div>
  `).join('');
}

export async function topUpWallet(amount) {
  const creds = walletCredentials();
  if (!creds) return;
  let res;
  try {
    res = await api('/api/wallet/topup', { method: 'POST', body: { ...creds, amount } });
  } catch (err) {
    alert('Could not reach the booking server.');
    return;
  }
  if (!res.ok || !res.data.checkoutUrl) { alert((res.data && res.data.error) || `Server error ${res.status}`); return; }
  try { sessionStorage.setItem('EC_WALLET_PHONE', document.getElementById('loyaltyLookupPhone').value.trim()); } catch (err) { /* ignore */ }
  window.location.assign(res.data.checkoutUrl);
}
