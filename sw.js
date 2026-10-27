const CACHE_NAME = 'elite-cuts-h5-v1.0.0';
const APP_SHELL = [
  './',
  './index.html',
  './manifest.json',
  'https://cdn.tailwindcss.com',
  'https://cdnjs.cloudflare.com/ajax/libs/font-awesome/6.5.1/css/all.min.css',
  'https://fonts.googleapis.com/css2?family=Cinzel:wght@600;700;800&family=Inter:wght@400;500;600;700&display=swap'
];

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

  // Always bypass cache for POST requests or live WordPress REST API endpoints
  if (request.method !== 'GET' || request.url.includes('/wp-json/')) {
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