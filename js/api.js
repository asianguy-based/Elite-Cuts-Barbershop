import { shopConfig } from './config.js';

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
