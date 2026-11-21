import { api, apiConfigured, escapeHtml, paymentsInfo } from './api.js';
import { shopConfig } from './config.js';
import { LoyaltyVault, bookings, loyaltyDB, normalizePhone, saveBookings, saveLoyaltyDB } from './storage.js';
import { switchTab } from './ui.js';

// Booking wizard, time slots, the "Next open chair" card, .ics and SMS receipts.

export let currentBooking = {
  serviceIds: ['srv-1'],
  barberId: 'brb-1',
  date: localDateStr(new Date()),   // the shop's local day, not UTC (UTC is already tomorrow on US evenings)
  time: '11:00 AM',
  paymentMode: 'deposit',
  clientName: '',
  clientPhone: '',
  notes: '',
  refCode: ''
};

// PAYMENT OPTIONS. deposit | prepay | wallet | chair. Prepay and wallet need the Worker with Stripe set up
// (GET /api/payments says what works); demo mode keeps the old deposit link + pay at chair.
export const PAY_MODE_BUTTONS = { deposit: 'payModeDepositBtn', prepay: 'payModePrepayBtn', wallet: 'payModeWalletBtn', chair: 'payModeChairBtn' };
export const PENDING_PAYMENT_KEY = 'EC_PENDING_PAYMENT';

export function availablePaymentModes() {
  const opts = apiConfigured() && paymentsInfo ? paymentsInfo.options : null;
  const modes = [];
  if (shopConfig.depositEnabled !== false && (!opts || opts.deposit)) modes.push('deposit');
  if (opts && opts.prepay && shopConfig.prepayEnabled !== false) modes.push('prepay');
  if (opts && opts.wallet && shopConfig.walletEnabled !== false) modes.push('wallet');
  if (!shopConfig.requireDeposit || !modes.length) modes.push('chair');   // never leave a client with no way to book
  return modes;
}

const depositAmount = () => (paymentsInfo && paymentsInfo.stripe ? paymentsInfo.depositAmount : null) ?? (shopConfig.depositAmount || 15);

export function selectPaymentMode(mode) {
  const modes = availablePaymentModes();
  if (!modes.includes(mode)) {
    if (mode === 'chair' && shopConfig.requireDeposit) {
      alert(`${shopConfig.shopName} asks for payment when you book. Pick one of the online options.`);
      return;
    }
    mode = modes[0];
  }
  currentBooking.paymentMode = mode;
  const depAmt = depositAmount();
  const { totalCost } = updateBookingTotals();
  const stripeOn = !!(apiConfigured() && paymentsInfo && paymentsInfo.stripe);

  Object.entries(PAY_MODE_BUTTONS).forEach(([m, id]) => {
    const btn = document.getElementById(id);
    if (!btn) return;
    const base = m === mode
      ? 'p-2.5 rounded-xl border border-accent bg-white/10 text-left transition'
      : 'p-2.5 rounded-xl border border-white/10 bg-secondary text-left transition opacity-70';
    btn.className = base + (modes.includes(m) ? '' : ' hidden');
  });
  document.getElementById('depositAmtLabel').textContent = depAmt;
  document.getElementById('prepayAmtLabel').textContent = totalCost;
  document.getElementById('depositViaLabel').textContent = stripeOn ? 'Card via Stripe' : 'Via Stripe / Square';
  document.getElementById('walletPinRow').classList.toggle('hidden', mode !== 'wallet');
  const usesStripe = mode === 'prepay' || (mode === 'deposit' && stripeOn);
  document.getElementById('stripeTestNote').classList.toggle('hidden', !(usesStripe && paymentsInfo && paymentsInfo.testMode));

  document.getElementById('submitBtnText').textContent = {
    deposit: `Pay $${depAmt} Deposit & Reserve Chair (+150 Pts)`,
    prepay: `Pay $${totalCost} Now & Reserve Chair (+150 Pts)`,
    wallet: `Pay $${totalCost} from Wallet & Reserve Chair (+150 Pts)`,
    chair: 'Confirm Appointment & Pay at Chair (+100 Pts after your visit)'
  }[mode];
}

export function quickBookService(serviceId) {
  currentBooking.serviceIds = [serviceId];
  switchTab('book');
  goToBookingStep(2);
}

export function quickBookBarber(barberId) {
  currentBooking.barberId = barberId;
  switchTab('book');
  goToBookingStep(1);
}

export function getSelectedServices() {
  return shopConfig.services.filter(s => currentBooking.serviceIds.includes(s.id));
}

export function updateBookingTotals() {
  const selected = getSelectedServices();
  const totalCost = selected.reduce((sum, s) => sum + Number(s.price), 0);
  const totalMin = selected.reduce((sum, s) => sum + Number(s.duration), 0);
  document.getElementById('bookingLiveSummary').textContent = `$${totalCost} • ${totalMin} min`;
  return { totalCost, totalMin, selected };
}

export function toggleServiceSelection(id) {
  const idx = currentBooking.serviceIds.indexOf(id);
  if (idx > -1 && currentBooking.serviceIds.length > 1) {
    currentBooking.serviceIds.splice(idx, 1);
  } else if (idx === -1) {
    currentBooking.serviceIds.push(id);
  }
  renderBookingStep1();
  updateBookingTotals();
}

export function renderBookingStep1() {
  const container = document.getElementById('bookingServicesGrid');
  container.innerHTML = shopConfig.services.map(s => {
    const active = currentBooking.serviceIds.includes(s.id);
    return `
      <div data-id="${escapeHtml(s.id)}" onclick="toggleServiceSelection(this.dataset.id)" class="glass-card rounded-xl p-3.5 cursor-pointer flex items-center justify-between border ${active ? 'border-accent bg-white/10' : 'border-white/10'}">
        <div class="pr-3">
          <div class="flex items-center gap-2">
            <i class="fa-solid ${active ? 'fa-square-check text-accent' : 'fa-square text-gray-500'}"></i>
            <span class="text-sm font-bold text-white">${escapeHtml(s.name)}</span>
          </div>
          <p class="text-xs text-gray-400 mt-1">${escapeHtml(s.desc)}</p>
        </div>
        <div class="text-right shrink-0">
          <div class="text-sm font-extrabold text-accent">$${escapeHtml(s.price)}</div>
          <div class="text-[10px] text-gray-400">${escapeHtml(s.duration)} min</div>
        </div>
      </div>
    `;
  }).join('');
}

export function selectBarber(id) {
  currentBooking.barberId = id;
  renderBookingStep2();
  renderTimeSlots();
}

export function renderBookingStep2() {
  const container = document.getElementById('bookingBarbersGrid');
  container.innerHTML = shopConfig.barbers.map(b => {
    const active = currentBooking.barberId === b.id;
    return `
      <div data-id="${escapeHtml(b.id)}" onclick="selectBarber(this.dataset.id)" class="glass-card rounded-xl p-3.5 cursor-pointer flex items-center justify-between border ${active ? 'border-accent bg-white/10' : 'border-white/10'}">
        <div class="flex items-center gap-3">
          <img src="${escapeHtml(b.avatar)}" class="w-12 h-12 rounded-full object-cover border border-accent" alt="${escapeHtml(b.name)}" />
          <div>
            <div class="text-sm font-bold text-white">${escapeHtml(b.name)}</div>
            <div class="text-xs text-gray-300">${escapeHtml(b.specialty)}</div>
          </div>
        </div>
        <i class="fa-solid ${active ? 'fa-circle-check text-accent text-lg' : 'fa-circle text-white/10 text-lg'}"></i>
      </div>
    `;
  }).join('');
}

export let remoteBookedSlots = { key: '', times: [] };

export function renderTimeSlots() {
  const dateInput = document.getElementById('bookingDateInput');
  const today = localDateStr(new Date());
  dateInput.min = today;
  if (!dateInput.value) {
    dateInput.value = currentBooking.date;
  }
  if (dateInput.value < today) dateInput.value = today;   // no bookings in the past
  currentBooking.date = dateInput.value;
  const now = new Date();
  const cutoffMin = now.getHours() * 60 + now.getMinutes() + NEXT_CHAIR_LEAD_MIN;   // same cutoff as the card
  const isPast = (slot) => currentBooking.date === today && (slotToMinutes(slot) ?? Infinity) < cutoffMin;

  // When a backend is configured, fetch booked times for this date+barber once and re-render.
  const slotKey = `${currentBooking.date}|${currentBooking.barberId}`;
  if (apiConfigured() && remoteBookedSlots.key !== slotKey) {
    remoteBookedSlots = { key: slotKey, times: [] };
    api(`/api/slots?date=${encodeURIComponent(currentBooking.date)}&barberId=${encodeURIComponent(currentBooking.barberId)}`)
      .then(res => {
        if (res && res.ok && remoteBookedSlots.key === slotKey) {
          remoteBookedSlots.times = res.data.booked || [];
          renderTimeSlots();
        }
      })
      .catch(err => console.warn('Slot fetch failed, using local data:', err));
  }
  const remoteTaken = apiConfigured() && remoteBookedSlots.key === slotKey ? remoteBookedSlots.times : [];

  const unavailable = (slot) => isPast(slot) || remoteTaken.includes(slot) || isSlotTakenLocally(currentBooking.barberId, currentBooking.date, slot);
  // Never leave a past or taken time selected: move to the first open one (or none).
  if (!currentBooking.time || unavailable(currentBooking.time)) {
    currentBooking.time = shopConfig.timeSlots.find(slot => !unavailable(slot)) || '';
  }

  const grid = document.getElementById('bookingTimeSlotsGrid');
  if (!currentBooking.time) {
    grid.innerHTML = `<p class="col-span-full text-sm text-gray-400 py-2">No open times left on this day. Please pick another date.</p>`;
    return;
  }
  grid.innerHTML = shopConfig.timeSlots.map(slot => {
    const isTaken = unavailable(slot);
    const isSelected = currentBooking.time === slot && !isTaken;
    if (isTaken) {
      return `<button disabled class="py-2.5 rounded-xl bg-white/5 text-gray-600 text-xs font-medium line-through border border-white/5 cursor-not-allowed">${escapeHtml(slot)}</button>`;
    }
    return `
      <button data-slot="${escapeHtml(slot)}" onclick="selectTimeSlot(this.dataset.slot)" class="py-2.5 rounded-xl text-xs font-semibold border transition ${isSelected ? 'gold-gradient text-[#1a1a2e] border-accent font-bold shadow' : 'bg-secondary text-white border-white/10 hover:border-accent/50'}">
        ${escapeHtml(slot)}
      </button>
    `;
  }).join('');
}

export function selectTimeSlot(slot) {
  currentBooking.time = slot;
  renderTimeSlots();
}

export function isSlotTakenLocally(barberId, date, slot) {
  return bookings.some(b => b.barberId === barberId && b.date === date && b.time === slot && b.status !== 'Cancelled');
}

// NEXT OPEN CHAIR — earliest free slot across all barbers, today then the next days.
export const NEXT_CHAIR_DAYS = 7;          // today + 6
export const NEXT_CHAIR_LEAD_MIN = 15;     // never offer a slot that starts within 15 minutes
export const nextChairRemote = new Map();  // `${date}|${barberId}` -> { done, times } from GET /api/slots
export let nextChair = null;               // { date, time, barberId, dayOffset }

export function localDateStr(d) {
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
}

export function slotToMinutes(slot) {
  const m = /^(\d{1,2}):(\d{2})\s*(AM|PM)$/i.exec(String(slot).trim());
  if (!m) return null;
  return (Number(m[1]) % 12 + (m[3].toUpperCase() === 'PM' ? 12 : 0)) * 60 + Number(m[2]);
}

// API mode only: lazily fetch booked times for one day (one request per barber), then re-render.
export function ensureNextChairRemote(date) {
  shopConfig.barbers.forEach(b => {
    const key = `${date}|${b.id}`;
    if (nextChairRemote.has(key)) return;
    const entry = { done: false, times: [] };
    nextChairRemote.set(key, entry);
    const finish = (times) => {
      entry.done = true;
      entry.times = times;
      if (nextChairRemote.get(key) === entry) renderNextChair();
    };
    api(`/api/slots?date=${encodeURIComponent(date)}&barberId=${encodeURIComponent(b.id)}`)
      .then(res => finish(res && res.ok && res.data && Array.isArray(res.data.booked) ? res.data.booked : []))
      .catch(err => { console.warn('Next-chair slot fetch failed, using local data:', err); finish([]); });
  });
}

export function findNextOpenChair() {
  if (!shopConfig.barbers.length || !shopConfig.services.length) return null;
  const now = new Date();
  const nowMin = now.getHours() * 60 + now.getMinutes();
  const slots = shopConfig.timeSlots
    .map(slot => ({ slot, min: slotToMinutes(slot) }))
    .filter(s => s.min !== null)
    .sort((a, b) => a.min - b.min);
  for (let i = 0; i < NEXT_CHAIR_DAYS; i++) {
    const date = localDateStr(new Date(now.getFullYear(), now.getMonth(), now.getDate() + i));
    if (apiConfigured()) ensureNextChairRemote(date);
    for (const { slot, min } of slots) {
      if (i === 0 && min < nowMin + NEXT_CHAIR_LEAD_MIN) continue;
      for (const b of shopConfig.barbers) {
        if (isSlotTakenLocally(b.id, date, slot)) continue;
        const remote = apiConfigured() ? nextChairRemote.get(`${date}|${b.id}`) : null;
        if (remote && remote.times.includes(slot)) continue;
        return { date, time: slot, barberId: b.id, dayOffset: i };
      }
    }
  }
  return null;
}

export function renderNextChair() {
  const card = document.getElementById('nextChairCard');
  if (!card) return;
  nextChair = findNextOpenChair();
  if (!nextChair) {
    card.classList.add('hidden');
    return;
  }
  const svc = shopConfig.services[0];
  const barber = shopConfig.barbers.find(b => b.id === nextChair.barberId);
  const [y, mo, d] = nextChair.date.split('-').map(Number);
  const dayLabel = nextChair.dayOffset === 0 ? 'Today'
    : nextChair.dayOffset === 1 ? 'Tomorrow'
    : new Date(y, mo - 1, d).toLocaleDateString('en-US', { weekday: 'short', month: 'short', day: 'numeric' });
  const time = nextChair.time.replace(/^0/, '');
  const first = barber.firstName || barber.name.split(' ')[0];
  document.getElementById('nextChairWhen').textContent = `${dayLabel}, ${time} with ${first}`;
  document.getElementById('nextChairService').textContent = `${svc.name} · ${svc.duration} min · $${svc.price}`;
  document.getElementById('nextChairBookBtn').setAttribute('aria-label', `Book it: ${svc.name}, ${dayLabel} at ${time} with ${barber.name}`);
  card.classList.remove('hidden');
}

export function refreshNextChair() {
  nextChairRemote.clear();
  renderNextChair();
}

// "Book it": pre-fill the normal wizard (default service, barber, date, time) and jump to details.
export function bookNextChair() {
  renderNextChair();
  if (!nextChair) return;
  currentBooking.serviceIds = [shopConfig.services[0].id];
  currentBooking.barberId = nextChair.barberId;
  currentBooking.date = nextChair.date;
  currentBooking.time = nextChair.time;
  document.getElementById('bookingDateInput').value = nextChair.date;
  switchTab('book');
  goToBookingStep(4);
  document.getElementById('clientName').focus({ preventScroll: true });
}

export function pickAnotherTime() {
  switchTab('book');
  goToBookingStep(1);
}

export function goToBookingStep(step) {
  if (step === 4 && !currentBooking.time) step = 3;   // no open time chosen on this date yet
  document.getElementById('bookConfirmation').classList.add('hidden');
  [1, 2, 3, 4].forEach(s => {
    document.getElementById(`bookStep${s}`).classList.toggle('hidden', s !== step);
    const ind = document.getElementById(`stepInd${s}`);
    if (s === step) {
      ind.className = 'py-1.5 rounded-lg bg-accent text-[#1a1a2e] font-bold';
    } else if (s < step) {
      ind.className = 'py-1.5 rounded-lg bg-emerald-500/20 text-emerald-300 font-semibold';
    } else {
      ind.className = 'py-1.5 rounded-lg bg-white/5 text-gray-400';
    }
  });

  if (step === 4) {
    const { totalCost, totalMin, selected } = updateBookingTotals();
    const barber = shopConfig.barbers.find(b => b.id === currentBooking.barberId) || shopConfig.barbers[0];
    document.getElementById('bookingSummaryBox').innerHTML = `
      <div class="flex justify-between"><span class="text-gray-400">Services:</span><span class="text-white font-semibold text-right">${escapeHtml(selected.map(s => s.name).join(", "))}</span></div>
      <div class="flex justify-between"><span class="text-gray-400">Master Barber:</span><span class="text-white font-semibold">${escapeHtml(barber.name)}</span></div>
      <div class="flex justify-between"><span class="text-gray-400">Date & Time:</span><span class="text-accent font-bold">${escapeHtml(currentBooking.date)} @ ${escapeHtml(currentBooking.time)}</span></div>
      <div class="flex justify-between border-t border-white/10 pt-1.5 mt-1"><span class="text-gray-300 font-semibold">Total Service Value:</span><span class="text-accent font-extrabold text-sm">$${totalCost} (${totalMin} min)</span></div>
    `;
    selectPaymentMode(currentBooking.paymentMode);
  }
}

export async function submitBooking() {
  const name = document.getElementById('clientName').value.trim();
  const phone = document.getElementById('clientPhone').value.trim();
  const notes = document.getElementById('clientNotes').value.trim();
  const email = (document.getElementById('clientEmail')?.value || '').trim();
  if (email && !/^[^\s@<>()",;:]+@[^\s@<>()",;:]+\.[A-Za-z]{2,}$/.test(email)) {
    alert('That email address does not look right. Fix it or leave it empty.');
    return;
  }

  if (!name || !phone) {
    alert('Please enter your name and mobile phone number to reserve your chair.');
    return;
  }

  const { totalCost, totalMin, selected } = updateBookingTotals();
  const barber = shopConfig.barbers.find(b => b.id === currentBooking.barberId) || shopConfig.barbers[0];
  let refCode = 'EC-' + Math.floor(1000 + Math.random() * 9000);
  const modes = availablePaymentModes();
  const mode = modes.includes(currentBooking.paymentMode) ? currentBooking.paymentMode : modes[0];
  const isDeposit = mode === 'deposit';
  const isOnline = mode !== 'chair';
  const pointsEarned = isOnline ? 150 : 100;
  const walletPin = mode === 'wallet' ? document.getElementById('bookingWalletPin').value.trim() : '';
  if (mode === 'wallet' && !/^[0-9]{4,6}$/.test(walletPin)) {
    alert('Enter your 4-6 digit VIP Wallet PIN to pay from your wallet.');
    return;
  }

  let newBooking = {
    id: Date.now().toString(),
    refCode,
    services: selected.map(s => s.name),
    totalCost,
    totalMin,
    depositPaid: isDeposit ? depositAmount() : 0,
    barberId: barber.id,
    barberName: barber.name,
    date: currentBooking.date,
    time: currentBooking.time,
    clientName: name,
    clientPhone: phone,
    notes,
    status: isDeposit ? 'Deposit Pending / Confirmed' : 'Confirmed'
  };

  let pointsLabel = `+${pointsEarned} VIP PTS`;
  if (apiConfigured()) {
    // Backend mode: the Worker owns the booking, conflict check, and loyalty award.
    let res;
    try {
      res = await api('/api/bookings', {
        method: 'POST',
        body: {
          services: newBooking.services, totalCost, totalMin,
          barberId: barber.id, barberName: barber.name,
          date: currentBooking.date, time: currentBooking.time,
          clientName: name, clientPhone: phone, notes,
          ...(email ? { clientEmail: email } : {}),
          paymentMode: mode,
          depositAmount: isDeposit ? depositAmount() : 0,
          ...(walletPin ? { walletPin } : {})
        }
      });
    } catch (err) {
      alert('Could not reach the booking server. Please check your connection and try again.');
      return;
    }
    if (res.status === 409) {
      alert('That time was just taken — pick another');
      remoteBookedSlots.key = '';
      nextChairRemote.clear();
      renderTimeSlots();
      return;
    }
    if (!res.ok || !res.data.booking) {
      const msg = (res.data && res.data.error) || `server error ${res.status}`;
      alert(res.status === 401 || res.status === 402 ? msg : 'Booking failed: ' + msg);
      return;
    }
    newBooking = Object.assign({}, newBooking, res.data.booking, { depositPaid: 0 });
    refCode = newBooking.refCode;
    pointsLabel = mode === 'wallet' ? `Paid from wallet • +${pointsEarned} VIP PTS`
      : isOnline ? `+${pointsEarned} VIP PTS once your payment goes through`
      : `+${pointsEarned} VIP PTS after your visit`;
    // Local mirror only (receipt + offline slot hint); the server is the source of truth.
    bookings.unshift(newBooking);
    saveBookings();
    remoteBookedSlots.key = '';
    if (res.data.checkoutUrl) {
      // Stripe Checkout (deposit or prepay): the webhook marks the booking paid; Stripe sends the client back
      // to ?paid=REF (or ?payment=cancelled), which main.js handles.
      currentBooking.lastConfirmed = newBooking;
      try {
        sessionStorage.setItem(PENDING_PAYMENT_KEY, JSON.stringify({ refCode, phone, checkoutUrl: res.data.checkoutUrl }));
      } catch (err) { /* private mode: the return page still works without it */ }
      window.location.assign(res.data.checkoutUrl);
      return;
    }
  } else {
    bookings.unshift(newBooking);
    saveBookings();

    // Update local client cache
    const phoneKey = normalizePhone(phone);
    let clientVault = LoyaltyVault.loadFromDevice(phoneKey);
    clientVault.name = name;
    clientVault.phone = phone;
    clientVault.points = (clientVault.points || 0) + pointsEarned;
    clientVault.stamps = ((clientVault.stamps || 0) + 1) % 11;
    clientVault.history = clientVault.history || [];
    clientVault.history.unshift(newBooking);
    LoyaltyVault.saveToDevice(phoneKey, clientVault);

    // Also mirror to global loyalty DB for shop owner CSV export
    loyaltyDB[phoneKey] = { name, phone, points: clientVault.points, stamps: clientVault.stamps };
    saveLoyaltyDB();
  }

  if (isDeposit && shopConfig.paymentLinkUrl && !(paymentsInfo && paymentsInfo.stripe)) {
    const sep = shopConfig.paymentLinkUrl.includes('?') ? '&' : '?';
    window.open(`${shopConfig.paymentLinkUrl}${sep}client_reference_id=${refCode}`, '_blank');
  }

  currentBooking.lastConfirmed = newBooking;
  refreshNextChair();
  [1, 2, 3, 4].forEach(s => document.getElementById(`bookStep${s}`).classList.add('hidden'));
  document.getElementById('receiptCode').textContent = `REF #${refCode} (${pointsLabel})`;
  document.getElementById('receiptDetailsText').textContent = `${selected.map(s => s.name).join(' + ')} with ${barber.name} on ${newBooking.date} at ${newBooking.time}.`;
  document.getElementById('bookConfirmation').classList.remove('hidden');
  document.getElementById('loyaltyLookupPhone').value = phone;
  if (mode === 'wallet') document.getElementById('bookingWalletPin').value = '';
}

export function resetBookingFlow() {
  goToBookingStep(1);
  renderTimeSlots();
}

export function downloadICS() {
  const b = currentBooking.lastConfirmed;
  if (!b) return;
  const icsContent = [
    'BEGIN:VCALENDAR',
    'VERSION:2.0',
    'PRODID:-//Elite Cuts Barbershop H5//EN',
    'BEGIN:VEVENT',
    `SUMMARY:${shopConfig.shopName} - ${b.services.join(', ')}`,
    `DESCRIPTION:Barber: ${b.barberName} | Ref: ${b.refCode} | Total: $${b.totalCost}`,
    `LOCATION:${shopConfig.address}`,
    'END:VEVENT',
    'END:VCALENDAR'
  ].join('\n');

  const blob = new Blob([icsContent], { type: 'text/calendar;charset=utf-8' });
  const link = document.createElement('a');
  link.href = URL.createObjectURL(blob);
  link.setAttribute('download', `${b.refCode}-appointment.ics`);
  document.body.appendChild(link);
  link.click();
  document.body.removeChild(link);
}

export function sendSMSConfirmation() {
  const b = currentBooking.lastConfirmed;
  if (!b) return;
  const msg = encodeURIComponent(`Hi ${shopConfig.shopName}, confirming my booking ${b.refCode} with ${b.barberName} on ${b.date} at ${b.time}.`);
  window.location.href = `sms:${shopConfig.phone}?body=${msg}`;
}

// Drop cached server slot data (used when the API URL changes).
/** After the shop's services or barbers change, drop picks that no longer exist. */
export function syncBookingWithConfig() {
  const serviceIds = shopConfig.services.map(s => s.id);
  currentBooking.serviceIds = currentBooking.serviceIds.filter(id => serviceIds.includes(id));
  if (!currentBooking.serviceIds.length && serviceIds.length) currentBooking.serviceIds = [serviceIds[0]];
  if (!shopConfig.barbers.some(b => b.id === currentBooking.barberId) && shopConfig.barbers.length) {
    currentBooking.barberId = shopConfig.barbers[0].id;
  }
  if (currentBooking.time && !shopConfig.timeSlots.includes(currentBooking.time)) currentBooking.time = '';
}

export function resetSlotCaches() {
  remoteBookedSlots = { key: '', times: [] };
  nextChairRemote.clear();
}
