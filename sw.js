const CACHE_NAME = 'elite-cuts-h5-v1.1.0';
const APP_SHELL = [
  './',
  './index.html',
  './manifest.json'
];
// Cross-origin CDN assets (Tailwind, Font Awesome, Google Fonts) are NOT pre-cached:
// cache.addAll() rejects on any opaque/failed response. They get cached on first fetch below.

// 1. Install & Pre-cache App Shell
self.addEventListener('install', (event) => {
  event.waitUntil(
    caches.open(CACHE_NAME).then((cache) => cache.addAll(APP_SHELL))
  );
  self.skipWaiting();
});

// 2. Activate & Purge Old Caches
self.addEventListener('activate', (event) => {
  event.waitUntil(
    caches.keys().then((keys) =>
      Promise.all(
        keys.map((key) => {
          if (key !== CACHE_NAME) {
            return caches.delete(key);
          }
        })
      )
    )
  );
  self.clients.claim();
});

// 3. Fetch Strategy: Network-First for APIs, Stale-While-Revalidate for Static Assets
self.addEventListener('fetch', (event) => {
  const { request } = event;

  // Backend API calls are always network-only (never served from cache)
  if (request.url.includes('/api/')) return;

  // Always bypass cache for non-GET requests
  if (request.method !== 'GET') {
    return;
  }

  event.respondWith(
    caches.match(request).then((cachedResponse) => {
      const networkFetch = fetch(request)
        .then((networkResponse) => {
          if (networkResponse && networkResponse.status === 200) {
            const cloned = networkResponse.clone();
            caches.open(CACHE_NAME).then((cache) => cache.put(request, cloned));
          }
          return networkResponse;
        })
        .catch(() => cachedResponse);

      return cachedResponse || networkFetch;
    })
  );
});

// 4. Push Notification Hook (Ready for Appointment Reminders)
self.addEventListener('push', (event) => {
  const data = event.data
    ? event.data.json()
    : {
        title: 'Elite Cuts Barbershop',
        body: 'Your chair is ready! See you soon.',
        url: './index.html?tab=loyalty'
      };

  event.waitUntil(
    self.registration.showNotification(data.title, {
      body: data.body,
      vibrate: [150, 75, 150],
      data: { url: data.url || './index.html' }
    })
  );
});

self.addEventListener('notificationclick', (event) => {
  event.notification.close();
  event.waitUntil(clients.openWindow(event.notification.data.url));
});