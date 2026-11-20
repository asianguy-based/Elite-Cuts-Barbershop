import { renderBookingStep1, renderBookingStep2, renderNextChair, renderTimeSlots, updateBookingTotals } from './booking.js';
import { escapeHtml } from './api.js';
import { shopConfig } from './config.js';
import { renderPunchCard } from './loyalty.js';

// Theme, home/lookbook rendering, tab switching and the PWA install banner.

export function applyThemeVariables() {
  document.documentElement.style.setProperty('--primary', shopConfig.primaryColor || '#1a1a2e');
  document.documentElement.style.setProperty('--accent', shopConfig.accentColor || '#d4af37');
  document.getElementById('headerShopName').textContent = shopConfig.shopName;
  document.getElementById('loyaltyCardShopName').textContent = `${shopConfig.shopName} REWARDS`;
  document.getElementById('headerTagline').textContent = shopConfig.tagline;
  document.getElementById('shopAddressText').textContent = shopConfig.address;
  document.getElementById('headerPhoneBtn').href = `tel:${shopConfig.phone}`;
  document.getElementById('statBarberCount').textContent = `${shopConfig.barbers.length} Chairs`;
  document.getElementById('depositAmtLabel').textContent = shopConfig.depositAmount || 15;
}

export function renderHome() {
  refreshInstallFooter();   // keeps the footer's shop name in sync with white-label edits
  const srvList = document.getElementById('homeServicesList');
  srvList.innerHTML = shopConfig.services.map(s => `
    <div onclick="quickBookService('${s.id}')" class="glass-card rounded-xl p-3.5 flex items-center justify-between cursor-pointer hover:border-accent/60 transition">
      <div class="pr-3">
        <div class="flex items-center gap-2">
          <span class="text-sm font-bold text-white">${s.name}</span>
          <span class="text-[10px] px-2 py-0.5 rounded bg-white/10 text-gray-300">${s.duration}m</span>
        </div>
        <p class="text-xs text-gray-400 mt-0.5 line-clamp-1">${s.desc}</p>
      </div>
      <div class="text-right shrink-0">
        <div class="text-accent font-extrabold text-sm">$${s.price}</div>
        <span class="text-[10px] text-gray-400">Select <i class="fa-solid fa-chevron-right text-[8px]"></i></span>
      </div>
    </div>
  `).join('');

  const brbList = document.getElementById('homeBarbersList');
  brbList.innerHTML = shopConfig.barbers.map(b => `
    <div onclick="quickBookBarber('${b.id}')" class="glass-card rounded-xl p-3 min-w-[165px] shrink-0 cursor-pointer hover:border-accent/60 transition">
      <div class="flex items-center gap-2.5">
        <img src="${b.avatar}" class="w-11 h-11 rounded-full object-cover border border-accent" alt="${b.name}" />
        <div>
          <div class="text-xs font-bold text-white leading-tight">${b.name}</div>
          <div class="text-[10px] text-accent font-semibold mt-0.5"><i class="fa-solid fa-star text-[9px]"></i> ${b.rating}</div>
        </div>
      </div>
      <div class="text-[11px] text-gray-300 mt-2 font-medium">${b.specialty}</div>
      <div class="text-[10px] text-gray-400 mt-0.5">Folder: /barbers/${b.folder}/</div>
    </div>
  `).join('');

  const galGrid = document.getElementById('galleryGrid');
  galGrid.innerHTML = shopConfig.lookbook.map(item => `
    <div onclick="selectLookbookStyle('${item.title}')" class="glass-card rounded-xl overflow-hidden cursor-pointer group">
      <div class="relative h-36 overflow-hidden">
        <img src="${item.img}" class="w-full h-full object-cover group-hover:scale-105 transition duration-300" alt="${item.title}" />
        <span class="absolute top-2 left-2 text-[10px] bg-black/70 text-accent px-2 py-0.5 rounded font-semibold">${item.tag}</span>
      </div>
      <div class="p-2.5">
        <div class="text-xs font-semibold text-white leading-snug">${item.title}</div>
        <div class="text-[10px] text-accent mt-1">Book This Cut <i class="fa-solid fa-arrow-right text-[9px]"></i></div>
      </div>
    </div>
  `).join('');

  renderReviews();
  renderNextChair();
}

// Home-screen reviews plus the rating tile. The tile is worked out from the reviews themselves,
// so the app never shows a score or a count that the shop didn't put in.
export function renderReviews() {
  const reviews = (shopConfig.reviews || []).filter(r => r && r.text);
  const samples = !!shopConfig.reviewsAreSamples;
  const section = document.getElementById('homeReviewsSection');
  const scoreEl = document.getElementById('statReviewScore');
  const labelEl = document.getElementById('statReviewLabel');
  section.classList.toggle('hidden', reviews.length === 0);
  document.getElementById('reviewsSampleBadge').classList.toggle('hidden', !samples);
  if (reviews.length) {
    const avg = reviews.reduce((t, r) => t + clampStars(r.stars), 0) / reviews.length;
    scoreEl.textContent = avg.toFixed(1);
    labelEl.textContent = `${reviews.length} ${samples ? 'Sample ' : ''}Review${reviews.length === 1 ? '' : 's'}`;
  } else {
    scoreEl.textContent = '—';
    labelEl.textContent = 'No Reviews Yet';
  }
  document.getElementById('homeReviewsList').innerHTML = reviews.map(r => {
    const n = clampStars(r.stars);
    return `
    <figure class="glass-card rounded-xl p-3.5">
      <div class="text-accent text-[11px]" aria-label="${n} out of 5 stars">${'<i class="fa-solid fa-star"></i>'.repeat(n)}${'<i class="fa-regular fa-star"></i>'.repeat(5 - n)}</div>
      <blockquote class="text-xs text-gray-200 mt-1.5 leading-relaxed">“${escapeHtml(r.text)}”</blockquote>
      <figcaption class="text-[11px] text-gray-400 mt-1.5">${escapeHtml(r.name || 'Client')}${samples ? ' · sample' : ''}</figcaption>
    </figure>`;
  }).join('');
}

function clampStars(v) {
  const n = Math.round(Number(v));
  return Number.isFinite(n) ? Math.min(5, Math.max(1, n)) : 5;
}

// "Name | 5 | Review" lines from the manager portal <-> review objects.
export function reviewsToText(reviews) {
  return (reviews || []).map(r => `${r.name || ''} | ${clampStars(r.stars)} | ${r.text || ''}`).join('\n');
}
export function textToReviews(text) {
  return String(text || '').split('\n').map(line => line.trim()).filter(Boolean).map(line => {
    const parts = line.split('|').map(p => p.trim());
    if (parts.length === 1) return { name: 'Client', stars: 5, text: parts[0] };
    if (parts.length === 2) return { name: parts[0], stars: 5, text: parts[1] };
    return { name: parts[0], stars: clampStars(parts[1]), text: parts.slice(2).join(' | ') };
  }).filter(r => r.text);
}

export function switchTab(tab) {
  ['home', 'book', 'loyalty', 'gallery'].forEach(t => {
    document.getElementById(`view-${t}`).classList.add('hidden');
    const navBtn = document.getElementById(`nav-${t}`);
    navBtn.classList.remove('text-accent');
    navBtn.classList.add('text-gray-400');
  });
  document.getElementById(`view-${tab}`).classList.remove('hidden');
  const activeNav = document.getElementById(`nav-${tab}`);
  activeNav.classList.remove('text-gray-400');
  activeNav.classList.add('text-accent');

  if (tab === 'book') {
    renderBookingStep1();
    renderBookingStep2();
    renderTimeSlots();
    updateBookingTotals();
  } else if (tab === 'loyalty') {
    renderPunchCard(0);
  } else if (tab === 'home') {
    renderNextChair();
  }
  window.scrollTo({ top: 0, behavior: 'smooth' });
}

export function selectLookbookStyle(title) {
  document.getElementById('clientNotes').value = `Requested Lookbook Style: ${title}`;
  switchTab('book');
}

let deferredInstallPrompt = null;

export const isInstalledApp = () =>
  window.matchMedia('(display-mode: standalone)').matches || window.navigator.standalone === true;

/** Hide every install prompt once the app runs from the home screen or was just installed. */
export function refreshInstallFooter() {
  const footer = document.getElementById('installAppFooter');
  if (!footer) return;
  footer.classList.toggle('hidden', isInstalledApp());
  const name = document.getElementById('installFooterShopName');
  if (name) name.textContent = shopConfig.shopName;
}

export function listenForInstallPrompt() {
  refreshInstallFooter();
  window.addEventListener('appinstalled', () => {
    deferredInstallPrompt = null;
    document.getElementById('pwaInstallBanner').classList.add('hidden');
    document.getElementById('installAppFooter')?.classList.add('hidden');
  });
  window.addEventListener('beforeinstallprompt', (e) => {
    e.preventDefault();
    deferredInstallPrompt = e;
    if (!localStorage.getItem('EC_PWA_DISMISSED')) {
      document.getElementById('pwaShopName').textContent = shopConfig.shopName;
      document.getElementById('pwaInstallBanner').classList.remove('hidden');
    }
  });
}

export function showIOSInstallHint() {
  const isIOS = /iphone|ipad|ipod/i.test(window.navigator.userAgent);
  const isStandalone = window.matchMedia('(display-mode: standalone)').matches || window.navigator.standalone;
  if (isIOS && !isStandalone && !localStorage.getItem('EC_PWA_DISMISSED')) {
    document.getElementById('pwaShopName').textContent = shopConfig.shopName;
    document.getElementById('pwaInstallSubtext').innerHTML = 'Tap <i class="fa-solid fa-arrow-up-from-bracket text-accent mx-0.5"></i> Share then <b>"Add to Home Screen"</b>';
    document.getElementById('pwaInstallActionBtn').classList.add('hidden');
    document.getElementById('pwaInstallBanner').classList.remove('hidden');
  }
}

export async function triggerPWAInstall() {
  if (!deferredInstallPrompt) return;
  deferredInstallPrompt.prompt();
  const { outcome } = await deferredInstallPrompt.userChoice;
  if (outcome === 'accepted') {
    document.getElementById('pwaInstallBanner').classList.add('hidden');
  }
  deferredInstallPrompt = null;
}

/** Steps for browsers that have no one-tap install prompt (all of iOS, Firefox, in-app browsers). */
export function installSteps(ua = window.navigator.userAgent) {
  const share = '<i class="fa-solid fa-arrow-up-from-bracket text-accent mx-0.5" aria-hidden="true"></i>';
  const isIOS = /iphone|ipad|ipod/i.test(ua) || (/macintosh/i.test(ua) && navigator.maxTouchPoints > 1);
  const inAppBrowser = /FBAN|FBAV|Instagram|Line\/|TikTok|Snapchat|Twitter|LinkedInApp/i.test(ua);
  if (inAppBrowser) {
    return [
      `Tap the <b>⋯</b> menu in the corner and choose <b>Open in ${isIOS ? 'Safari' : 'browser'}</b>.`,
      'On the page that opens, tap <b>Install app</b> again.'
    ];
  }
  if (isIOS) {
    return [
      `Tap the Share button ${share} ${/CriOS|FxiOS|EdgiOS/i.test(ua) ? 'in the address bar' : 'at the bottom of Safari'}.`,
      'Scroll down and tap <b>Add to Home Screen</b>.',
      'Tap <b>Add</b>. The Elite Cuts logo appears on your home screen.'
    ];
  }
  if (/android/i.test(ua)) {
    return [
      'Open your browser menu <b>⋮</b> (top right, or bottom bar on Samsung Internet).',
      'Tap <b>Install app</b> or <b>Add to Home screen</b>.',
      'Confirm with <b>Install</b> / <b>Add</b>.'
    ];
  }
  return [
    'In Chrome or Edge, click the install icon <i class="fa-solid fa-display text-accent mx-0.5" aria-hidden="true"></i> at the right end of the address bar.',
    'In Safari on a Mac, choose <b>File → Add to Dock</b>.',
    'Or open this page on your phone and tap <b>Install app</b>.'
  ];
}

let installHelpReturnFocus = null;

export function closeInstallHelp() {
  document.getElementById('installHelpSheet').classList.add('hidden');
  document.removeEventListener('keydown', installHelpKeydown);
  installHelpReturnFocus?.focus();
}

function installHelpKeydown(e) {
  if (e.key === 'Escape') closeInstallHelp();
}

/** "Install app" button: use the browser's one-tap prompt when it offers one, otherwise show the steps. */
export async function openInstallApp() {
  if (deferredInstallPrompt) {
    const promptEvent = deferredInstallPrompt;
    deferredInstallPrompt = null;               // a prompt event can only be used once
    promptEvent.prompt();
    const { outcome } = await promptEvent.userChoice;
    if (outcome === 'accepted') {
      document.getElementById('pwaInstallBanner').classList.add('hidden');
      document.getElementById('installAppFooter')?.classList.add('hidden');
    }
    return;
  }
  installHelpReturnFocus = document.activeElement;
  document.getElementById('installHelpSteps').innerHTML = installSteps().map((step, i) =>
    `<li class="flex gap-3"><span class="w-6 h-6 rounded-full gold-gradient text-[#1a1a2e] text-xs font-bold flex items-center justify-center shrink-0">${i + 1}</span><span>${step}</span></li>`
  ).join('');
  document.getElementById('installHelpSheet').classList.remove('hidden');
  document.addEventListener('keydown', installHelpKeydown);
  document.querySelector('#installHelpSheet button[aria-label="Close"]').focus();
}

export function dismissPWABanner() {
  localStorage.setItem('EC_PWA_DISMISSED', 'true');
  document.getElementById('pwaInstallBanner').classList.add('hidden');
}
