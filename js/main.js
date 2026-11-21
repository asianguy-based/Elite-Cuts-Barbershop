// Entry point: wires the modules together, exposes inline-handler globals, boots the app.
import { loadPaymentsInfo, loadSharedSettings } from './api.js';
import {
  PENDING_PAYMENT_KEY, bookNextChair, downloadICS, goToBookingStep, pickAnotherTime, quickBookBarber, quickBookService,
  currentBooking, renderBookingStep1, renderBookingStep2, renderTimeSlots, resetBookingFlow, resetSlotCaches, selectBarber,
  selectPaymentMode, selectTimeSlot, sendSMSConfirmation, submitBooking, syncBookingWithConfig,
  toggleServiceSelection, updateBookingTotals
} from './booking.js';
import { loadWalletBalance, lookupLoyalty, renderWalletCard, topUpWallet } from './loyalty.js';
import {
  addNewBarberWithFolder, adminAddWalletCredit, adminResetWalletPin, clearCompletedBookings, closeAdminModal, exportConfigJSON, exportLoyaltyCSV,
  importLoyaltyCSV, openAdminModal, removeBarber, resetDemoData, saveWhiteLabelConfig, unlockAdmin,
  updateBookingStatus
} from './admin.js';
import { initAppUpdates } from './update.js';
import {
  applyThemeVariables, dismissPWABanner, listenForInstallPrompt, renderHome, selectLookbookStyle,
  closeInstallHelp, openInstallApp, showIOSInstallHint, switchTab, triggerPWAInstall
} from './ui.js';

// INLINE HANDLER GLOBALS — the markup (index.html and the HTML strings rendered by the modules)
// uses onclick="fn()" / onchange="fn()" attributes, which resolve against window. This is the one
// place those functions are made global; add a name here when you add a new inline handler.
Object.assign(window, {
  // booking wizard + next open chair
  bookNextChair, downloadICS, goToBookingStep, pickAnotherTime, quickBookBarber, quickBookService,
  renderTimeSlots, resetBookingFlow, selectBarber, selectPaymentMode, selectTimeSlot,
  sendSMSConfirmation, submitBooking, toggleServiceSelection,
  // loyalty + VIP wallet credit
  loadWalletBalance, lookupLoyalty, topUpWallet,
  // manager portal
  addNewBarberWithFolder, adminAddWalletCredit, adminResetWalletPin, clearCompletedBookings, closeAdminModal, exportConfigJSON, exportLoyaltyCSV,
  importLoyaltyCSV, removeBarber, resetDemoData, saveWhiteLabelConfig, unlockAdmin, updateBookingStatus,
  // tabs, lookbook, PWA banner + Install app footer
  closeInstallHelp, dismissPWABanner, openInstallApp, selectLookbookStyle, switchTab, triggerPWAInstall
});

syncBookingWithConfig();
applyThemeVariables();
renderHome();
listenForInstallPrompt();

// Live mode: load the shop profile the manager published (name, colors, reviews, barbers...), so
// every client sees the same shop. The first paint uses the cached copy; this refreshes it.
loadSharedSettings().then(result => {
  if (!result || !result.changed) return;
  renderWalletCard();
  syncBookingWithConfig();
  resetSlotCaches();
  applyThemeVariables();
  renderHome();
  if (!document.getElementById('view-book').classList.contains('hidden')) {
    renderBookingStep1();
    renderBookingStep2();
    renderTimeSlots();
    updateBookingTotals();
  }
});

// Online payments: which options the Worker can take (Stripe test key set, options switched on).
loadPaymentsInfo().then(() => {
  renderWalletCard();
  if (!document.getElementById('view-book').classList.contains('hidden') &&
      !document.getElementById('bookStep4').classList.contains('hidden')) {
    selectPaymentMode(currentBooking.paymentMode);
  }
});

/** Back from Stripe Checkout: ?paid=REF, ?payment=cancelled&ref=REF, ?topup=ok|cancelled. */
function handlePaymentReturn(params) {
  let pending = null;
  try { pending = JSON.parse(sessionStorage.getItem(PENDING_PAYMENT_KEY) || 'null'); } catch (err) { pending = null; }
  const ref = params.get('paid') || params.get('ref') || '';
  if (params.get('paid')) {
    try { sessionStorage.removeItem(PENDING_PAYMENT_KEY); } catch (err) { /* ignore */ }
    if (pending && pending.phone) {
      document.getElementById('loyaltyLookupPhone').value = pending.phone;
      setTimeout(lookupLoyalty, 2500);   // give Stripe's webhook a moment to mark the booking paid
    }
    alert(`Thanks! Your payment for ${ref} went through and your chair is booked. It shows as Paid in your VIP Wallet in a moment.`);
  } else if (params.get('payment') === 'cancelled') {
    const retry = pending && pending.refCode === ref && pending.checkoutUrl;
    if (retry && confirm(`Payment for ${ref} wasn't finished. Your chair is held for about 30 minutes. Go back to the payment page?`)) {
      window.location.assign(pending.checkoutUrl);
      return true;
    }
    if (!retry) alert(`Payment for ${ref} wasn't finished. Your chair is held for about 30 minutes, then released.`);
  } else if (params.get('topup') === 'ok') {
    let phone = '';
    try { phone = sessionStorage.getItem('EC_WALLET_PHONE') || ''; } catch (err) { /* ignore */ }
    if (phone) document.getElementById('loyaltyLookupPhone').value = phone;
    alert('Thanks! Your wallet top-up went through. Enter your PIN and tap Check Balance to see it.');
  } else if (params.get('topup') === 'cancelled') {
    alert('Top-up cancelled. Nothing was charged.');
  } else {
    return false;
  }
  window.history.replaceState({}, document.title, window.location.pathname + (params.get('tab') ? `?tab=${encodeURIComponent(params.get('tab'))}` : ''));
  return false;
}

// PWA INSTALL & PORTAL ROUTER (?tab=..., ?portal=admin)
window.addEventListener('load', () => {
  // Registers sw.js and shows the "UPDATE: what changed [OK]" popup when a new version is deployed.
  initAppUpdates().catch(err => console.warn('SW setup skipped:', err));

  const params = new URLSearchParams(window.location.search);
  const targetTab = params.get('tab');
  if (targetTab && ['home', 'book', 'loyalty', 'gallery'].includes(targetTab)) {
    switchTab(targetTab);
  }
  if (handlePaymentReturn(params)) return;

  if (params.get('portal') === 'admin' || params.get('portal') === 'management') {
    setTimeout(() => {
      openAdminModal();
    }, 120);
  }

  showIOSInstallHint();
});
