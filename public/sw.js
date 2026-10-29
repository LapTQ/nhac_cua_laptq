/**
 * Symphony R2 - Service Worker (sw.js)
 * Caches static shell, scripts, styles, icons, and CDN bundles for offline usage.
 * Large audio files are stored in IndexedDB (PersonalMusicDB) rather than CacheStorage.
 */

const CACHE_NAME = 'symphony-r2-v5';

const STATIC_ASSETS = [
  './',
  './index.html',
  './app.js',
  './manifest.json',
  './icon.svg',
  './pwa-192x192.png',
  './pwa-512x512.png',
  './apple-touch-icon.png',
  'https://cdn.tailwindcss.com',
  'https://unpkg.com/lucide@latest',
  'https://esm.sh/@aws-sdk/client-s3@3.600.0?bundle',
  'https://esm.sh/@aws-sdk/s3-request-presigner@3.600.0?bundle'
];

// Install: Cache core application assets
self.addEventListener('install', (event) => {
  event.waitUntil(
    caches.open(CACHE_NAME).then(async (cache) => {
      // Use individual puts so a single CDN network hiccup does not abort the install
      await Promise.all(
        STATIC_ASSETS.map(async (url) => {
          try {
            const response = await fetch(url, { mode: 'cors' });
            if (response.ok || response.type === 'opaque') {
              await cache.put(url, response);
            }
          } catch (err) {
            console.warn('[SW] Could not precache:', url, err);
          }
        })
      );
    })
  );
  self.skipWaiting();
});

// Activate: Clean up previous cache versions and claim clients
self.addEventListener('activate', (event) => {
  event.waitUntil(
    caches.keys().then((keys) => {
      return Promise.all(
        keys.map((key) => {
          if (key !== CACHE_NAME) {
            console.log('[SW] Deleting old cache:', key);
            return caches.delete(key);
          }
        })
      );
    }).then(() => self.clients.claim())
  );
});

// Fetch: Strategy depending on request type
self.addEventListener('fetch', (event) => {
  const request = event.request;
  const url = new URL(request.url);

  // 1. Skip non-GET requests
  if (request.method !== 'GET') {
    return;
  }

  // 2. Bypass Service Worker cache for live audio streaming / R2 presigned URLs
  // (Audio blobs are managed directly by IndexedDB 'PersonalMusicDB')
  if (
    url.hostname.includes('r2.cloudflarestorage.com') ||
    url.pathname.includes('/tracks/') ||
    request.destination === 'audio' ||
    url.searchParams.has('X-Amz-Signature')
  ) {
    return;
  }

  // 3. Navigation requests & app.js: Network-First with cached fallback
  if (request.mode === 'navigate' || url.pathname.endsWith('/app.js') || url.pathname.endsWith('app.js')) {
    event.respondWith(
      fetch(request)
        .then((networkResponse) => {
          if (networkResponse && networkResponse.ok) {
            const clone = networkResponse.clone();
            caches.open(CACHE_NAME).then((cache) => cache.put(request, clone));
          }
          return networkResponse;
        })
        .catch(async () => {
          const cached = await caches.match(request);
          if (cached) return cached;
          return caches.match('./index.html') || caches.match('/index.html');
        })
    );
    return;
  }

  // 4. Stale-While-Revalidate for app assets and CDN libraries
  event.respondWith(
    caches.match(request).then((cachedResponse) => {
      const fetchPromise = fetch(request)
        .then((networkResponse) => {
          if (networkResponse && (networkResponse.ok || networkResponse.type === 'opaque')) {
            const clone = networkResponse.clone();
            caches.open(CACHE_NAME).then((cache) => cache.put(request, clone));
          }
          return networkResponse;
        })
        .catch(() => {
          // Network failed, we already have cachedResponse if available
        });

      return cachedResponse || fetchPromise;
    })
  );
});
