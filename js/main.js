// Entry point: wires the modules together, exposes inline-handler globals, boots the app.
import {
  bookNextChair, downloadICS, goToBookingStep, pickAnotherTime, quickBookBarber, quickBookService,
  renderTimeSlots, resetBookingFlow, selectBarber, selectPaymentMode, selectTimeSlot,
  sendSMSConfirmation, submitBooking, toggleServiceSelection
} from './booking.js';
import { lookupLoyalty } from './loyalty.js';
import {
  addNewBarberWithFolder, clearCompletedBookings, closeAdminModal, exportConfigJSON, exportLoyaltyCSV,
  importLoyaltyCSV, openAdminModal, removeBarber, resetDemoData, saveWhiteLabelConfig, unlockAdmin,
  updateBookingStatus
} from './admin.js';
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
  // loyalty
  lookupLoyalty,
  // manager portal
  addNewBarberWithFolder, clearCompletedBookings, closeAdminModal, exportConfigJSON, exportLoyaltyCSV,
  importLoyaltyCSV, removeBarber, resetDemoData, saveWhiteLabelConfig, unlockAdmin, updateBookingStatus,
  // tabs, lookbook, PWA banner + Install app footer
  closeInstallHelp, dismissPWABanner, openInstallApp, selectLookbookStyle, switchTab, triggerPWAInstall
});

applyThemeVariables();
renderHome();
listenForInstallPrompt();

// PWA INSTALL & PORTAL ROUTER (?tab=..., ?portal=admin)
window.addEventListener('load', () => {
  if ('serviceWorker' in navigator) {
    navigator.serviceWorker.register('./sw.js').catch(err => console.warn('SW setup skipped:', err));
  }

  const params = new URLSearchParams(window.location.search);
  const targetTab = params.get('tab');
  if (targetTab && ['home', 'book', 'loyalty', 'gallery'].includes(targetTab)) {
    switchTab(targetTab);
  }

  if (params.get('portal') === 'admin' || params.get('portal') === 'management') {
    setTimeout(() => {
      openAdminModal();
    }, 120);
  }

  showIOSInstallHint();
});
