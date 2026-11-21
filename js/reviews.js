import { MANAGER_TOKEN_KEY, api, apiConfigured, escapeHtml } from './api.js';
import { applySharedSettings, saveConfig, shopConfig } from './config.js';
import { renderHome } from './ui.js';

// Client reviews. Clients leave one from the home screen; it is logged for the manager and stays hidden
// until the manager ticks "Show" in Manager Studio > Admin > Client Reviews. The ticked reviews are what
// shopConfig.reviews holds and the home screen shows.
// Live mode: the log is the Worker's reviews table. Demo mode: a list in this browser's localStorage.

export const STORAGE_KEY_REVIEWS = 'ELITE_CUTS_H5_REVIEWS_V1';

function loadLocalLog() {
  let log = null;
  try { log = JSON.parse(localStorage.getItem(STORAGE_KEY_REVIEWS) || 'null'); } catch (err) { log = null; }
  if (Array.isArray(log)) return log;
  // First use: the reviews already on the home screen become the start of the log, ticked.
  const now = new Date().toISOString();
  log = (shopConfig.reviews || []).filter(r => r && r.text).map((r, i) => ({
    id: i + 1, name: r.name || 'Client', stars: clampStars(r.stars), text: r.text,
    source: 'manager', shown: true, read: true, createdAt: now
  }));
  saveLocalLog(log);
  return log;
}
function saveLocalLog(log) {
  localStorage.setItem(STORAGE_KEY_REVIEWS, JSON.stringify(log));
}
/** Demo mode: the ticked reviews become the published list, newest first (same order as the Worker). */
function publishLocal(log) {
  shopConfig.reviews = sortLog(log).filter(r => r.shown).slice(0, 50).map(r => ({ name: r.name, stars: r.stars, text: r.text }));
  saveConfig();
}
function sortLog(log) {
  return [...log].sort((a, b) => (b.createdAt || '').localeCompare(a.createdAt || '') || a.id - b.id);
}
function clampStars(v) {
  const n = Math.round(Number(v));
  return Number.isFinite(n) ? Math.min(5, Math.max(1, n)) : 5;
}

// ---------- client: Leave a Review (home screen) ----------
export function toggleReviewForm(open) {
  const form = document.getElementById('leaveReviewForm');
  const show = typeof open === 'boolean' ? open : form.classList.contains('hidden');
  form.classList.toggle('hidden', !show);
  document.getElementById('leaveReviewToggle').setAttribute('aria-expanded', String(show));
  if (show) document.getElementById('leaveReviewMsg').classList.add('hidden');
}

export async function submitClientReview() {
  const name = document.getElementById('reviewName').value.trim().slice(0, 60);
  const stars = clampStars(document.getElementById('reviewStars').value);
  const text = document.getElementById('reviewText').value.trim().slice(0, 600);
  if (!text) { alert('Please write a few words about your visit.'); return; }
  const btn = document.getElementById('reviewSubmitBtn');
  btn.disabled = true;
  try {
    if (apiConfigured()) {
      let res;
      try {
        res = await api('/api/reviews', { method: 'POST', body: { name, stars, text } });
      } catch (err) {
        alert('Could not reach the shop to send your review. Please try again.');
        return;
      }
      if (!res.ok) { alert((res.data && res.data.error) || 'Your review could not be sent. Please try again later.'); return; }
    } else {
      const log = loadLocalLog();
      log.push({ id: log.reduce((m, r) => Math.max(m, r.id), 0) + 1, name: name || 'Client', stars, text, source: 'client', shown: false, read: false, createdAt: new Date().toISOString() });
      saveLocalLog(log);
    }
    document.getElementById('reviewName').value = '';
    document.getElementById('reviewText').value = '';
    document.getElementById('reviewStars').value = '5';
    toggleReviewForm(false);
    const msg = document.getElementById('leaveReviewMsg');
    msg.textContent = 'Thanks for your review! The shop reads every one before it goes up.';
    msg.classList.remove('hidden');
  } finally {
    btn.disabled = false;
  }
}

// ---------- manager: Client Reviews log (Admin tab) ----------
let managerLog = [];

export async function loadReviewLog() {
  if (apiConfigured()) {
    if (!sessionStorage.getItem(MANAGER_TOKEN_KEY)) return [];
    try {
      const res = await api('/api/manager/reviews');
      if (res.ok) managerLog = res.data.reviews || [];
      else if (res.status === 404) managerLog = [];   // Worker without the reviews update yet
    } catch (err) {
      console.warn('Reviews fetch failed:', err);
    }
  } else {
    managerLog = sortLog(loadLocalLog());
  }
  return managerLog;
}

export async function renderAdminReviews() {
  await loadReviewLog();
  const unread = managerLog.filter(r => !r.read).length;
  document.getElementById('adminReviewCount').textContent = managerLog.length;
  const badge = document.getElementById('adminReviewsBadge');
  badge.textContent = unread > 9 ? '9+' : String(unread);
  badge.classList.toggle('hidden', !unread);
  const newTag = document.getElementById('adminReviewsNew');
  newTag.textContent = `${unread} new`;
  newTag.classList.toggle('hidden', !unread);
  document.getElementById('cfgReviewsAreSamples').checked = !!shopConfig.reviewsAreSamples;
  const list = document.getElementById('adminReviewsList');
  list.innerHTML = managerLog.length ? managerLog.map(r => {
    const n = clampStars(r.stars);
    const when = r.createdAt ? escapeHtml(String(r.createdAt).slice(0, 10)) : '';
    return `
    <div class="p-2.5 rounded-xl bg-primary border ${r.read ? 'border-white/10' : 'border-accent/60'} text-xs space-y-1.5" data-review-id="${escapeHtml(r.id)}">
      <div class="flex items-start justify-between gap-2">
        <div class="min-w-0">
          <div class="font-bold text-white">${escapeHtml(r.name || 'Client')} ${r.read ? '' : '<span class="ml-1 text-[9px] px-1.5 py-0.5 rounded bg-accent text-[#1a1a2e] font-bold uppercase">New</span>'}</div>
          <div class="text-accent text-[10px]" aria-label="${n} out of 5 stars">${'★'.repeat(n)}${'☆'.repeat(5 - n)} <span class="text-gray-400">• ${when} • ${r.source === 'client' ? 'from a client' : 'added by you'}</span></div>
        </div>
        <div class="flex items-center gap-2 shrink-0">
          <label class="flex items-center gap-1 text-[11px] text-gray-200 cursor-pointer">
            <input type="checkbox" class="accent-[#d4af37] w-4 h-4" ${r.shown ? 'checked' : ''} data-id="${escapeHtml(r.id)}" onchange="toggleReviewShown(this.dataset.id, this.checked)" aria-label="Show this review on the home screen" /> Show
          </label>
          <button data-id="${escapeHtml(r.id)}" onclick="deleteReview(this.dataset.id)" aria-label="Delete this review" class="px-2 py-1 rounded bg-rose-500/20 text-rose-300 text-[10px]"><i class="fa-solid fa-trash-can"></i></button>
        </div>
      </div>
      <p class="text-[11px] text-gray-200 leading-relaxed whitespace-pre-line">${escapeHtml(r.text)}</p>
    </div>`;
  }).join('') : `<div class="text-xs text-gray-400 py-1">No reviews yet. When a client leaves one, it shows up here.</div>`;
}

/** Opening the Admin tab counts as reading the reviews: the NEW marks stay until the next time it opens. */
export async function markReviewsRead() {
  if (!managerLog.some(r => !r.read)) return;
  if (apiConfigured()) {
    try { await api('/api/manager/reviews/read', { method: 'POST' }); } catch (err) { /* try again next time */ }
  } else {
    saveLocalLog(loadLocalLog().map(r => ({ ...r, read: true })));
  }
  document.getElementById('adminReviewsBadge').classList.add('hidden');
}

function afterPublish(settings) {
  if (settings) applySharedSettings(settings);
  renderHome();
}

export async function toggleReviewShown(id, shown) {
  if (apiConfigured()) {
    let res;
    try {
      res = await api(`/api/manager/reviews/${encodeURIComponent(id)}`, { method: 'PATCH', body: { shown: !!shown } });
    } catch (err) {
      alert('Could not reach the booking server.');
      renderAdminReviews();
      return;
    }
    if (!res.ok) { alert('Not saved: ' + ((res.data && res.data.error) || res.status)); renderAdminReviews(); return; }
    afterPublish(res.data.settings);
  } else {
    const log = loadLocalLog().map(r => String(r.id) === String(id) ? { ...r, shown: !!shown, read: true } : r);
    saveLocalLog(log);
    publishLocal(log);
    afterPublish(null);
  }
  renderAdminReviews();
}

export async function deleteReview(id) {
  if (!confirm('Delete this review for good? It also comes off the home screen.')) return;
  if (apiConfigured()) {
    let res;
    try {
      res = await api(`/api/manager/reviews/${encodeURIComponent(id)}`, { method: 'DELETE' });
    } catch (err) {
      alert('Could not reach the booking server.');
      return;
    }
    if (!res.ok) { alert('Not deleted: ' + ((res.data && res.data.error) || res.status)); return; }
    afterPublish(res.data.settings);
  } else {
    const log = loadLocalLog().filter(r => String(r.id) !== String(id));
    saveLocalLog(log);
    publishLocal(log);
    afterPublish(null);
  }
  renderAdminReviews();
}

export async function adminAddReview() {
  const name = document.getElementById('adminNewReviewName').value.trim().slice(0, 60) || 'Client';
  const stars = clampStars(document.getElementById('adminNewReviewStars').value);
  const text = document.getElementById('adminNewReviewText').value.trim().slice(0, 600);
  if (!text) { alert('Type what the client said first.'); return; }
  if (apiConfigured()) {
    let res;
    try {
      res = await api('/api/manager/reviews', { method: 'POST', body: { name, stars, text, shown: true } });
    } catch (err) {
      alert('Could not reach the booking server.');
      return;
    }
    if (!res.ok) { alert('Not saved: ' + ((res.data && res.data.error) || res.status)); return; }
    afterPublish(res.data.settings);
  } else {
    const log = loadLocalLog();
    log.push({ id: log.reduce((m, r) => Math.max(m, r.id), 0) + 1, name, stars, text, source: 'manager', shown: true, read: true, createdAt: new Date().toISOString() });
    saveLocalLog(log);
    publishLocal(log);
    afterPublish(null);
  }
  document.getElementById('adminNewReviewName').value = '';
  document.getElementById('adminNewReviewText').value = '';
  document.getElementById('adminNewReviewStars').value = '5';
  renderAdminReviews();
}
