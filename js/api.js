import { applySharedSettings, pickShared, shopConfig } from './config.js';

// Anything that came from a booking (names, times, notes...) was typed by a stranger. Escape it before
// it goes into innerHTML, or a booking named with HTML in it runs code in the manager's browser.
export function escapeHtml(v) {
  return String(v ?? '').replace(/[&<>"'`]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;', '`': '&#96;' }[c]));
}

// BACKEND API (Cloudflare Worker). Returns null when no apiBaseUrl is set = demo/localStorage mode.
export const MANAGER_TOKEN_KEY = 'EC_MANAGER_TOKEN';
export function apiConfigured() {
  return !!(shopConfig.apiBaseUrl && shopConfig.apiBaseUrl.trim());
}
export async function api(path, opts = {}) {
  if (!apiConfigured()) return null;
  const base = shopConfig.apiBaseUrl.trim().replace(/\/+$/, '');
  const headers = Object.assign({ 'Content-Type': 'application/json' }, opts.headers || {});
  const token = sessionStorage.getItem(MANAGER_TOKEN_KEY);
  if (token) headers['X-Manager-Token'] = token;
  const res = await fetch(base + path, {
    method: opts.method || 'GET',
    headers,
    body: opts.body !== undefined ? JSON.stringify(opts.body) : undefined
  });
  const isJson = (res.headers.get('content-type') || '').includes('application/json');
  const data = isJson ? await res.json().catch(() => ({})) : await res.text();
  return { ok: res.ok, status: res.status, data };
}

// SHARED SHOP PROFILE. Returns { published, changed } or null in demo mode / when the API is unreachable.
export async function loadSharedSettings() {
  if (!apiConfigured()) return null;
  try {
    const res = await api('/api/shop');
    if (!res || !res.ok || !res.data || typeof res.data !== 'object') return null;
    const published = !!res.data.settings;
    return { published, changed: published ? applySharedSettings(res.data.settings) : false };
  } catch (err) {
    console.warn('Shop settings fetch failed, using cached settings:', err);
    return null;
  }
}

/**
 * Publish a config (the shared fields only) so every client sees it. Needs the manager token.
 * Returns { ok: true } after applying what the server stored, or { ok: false, error }.
 */
export async function publishSharedSettings(cfg) {
  let res;
  try {
    res = await api('/api/manager/shop', { method: 'PUT', body: pickShared(cfg) });
  } catch (err) {
    return { ok: false, error: 'Could not reach the booking server.' };
  }
  if (!res || !res.ok) {
    if (res && res.status === 401) sessionStorage.removeItem(MANAGER_TOKEN_KEY);
    const msg = res && res.data && res.data.error;
    return { ok: false, error: res && res.status === 401 ? 'Your manager login expired. Close the studio and log in again.' : (msg || `Server error ${res && res.status}`) };
  }
  applySharedSettings(res.data.settings);
  return { ok: true };
}

// ONLINE PAYMENTS. What the Worker can take right now (Stripe test key set? which options on?).
// null = demo mode or API unreachable: only the old deposit link and pay-at-chair are offered.
export let paymentsInfo = null;
export async function loadPaymentsInfo() {
  if (!apiConfigured()) { paymentsInfo = null; return null; }
  try {
    const res = await api('/api/payments');
    paymentsInfo = res && res.ok && res.data && typeof res.data === 'object' ? res.data : null;
  } catch (err) {
    console.warn('Payments info fetch failed:', err);
    paymentsInfo = null;
  }
  return paymentsInfo;
}
