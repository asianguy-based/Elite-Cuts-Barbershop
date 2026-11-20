import { shopConfig } from './config.js';

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
