// RClone Manager — Minimal Service Worker for PWA installability

const CACHE_NAME = 'rcman-v1';
const OFFLINE_URL = '/offline.html';

// Install: pre-cache the app shell and offline page
self.addEventListener('install', event => {
  self.skipWaiting();
  event.waitUntil(
    caches.open(CACHE_NAME).then(cache =>
      cache.addAll(['/', '/index.html', OFFLINE_URL]).catch(() => {
        // Non-critical: caching may fail on first load, that's okay
      })
    )
  );
});

// Activate: clean up old caches
self.addEventListener('activate', event => {
  event.waitUntil(
    caches
      .keys()
      .then(keys =>
        Promise.all(keys.filter(key => key !== CACHE_NAME).map(key => caches.delete(key)))
      )
  );
  self.clients.claim();
});

// Fetch: network-first strategy
// API calls and SSE are always network-only.
// Navigation requests fall back to offline page on failure.
// Static assets try network first, then fall back to cache.
self.addEventListener('fetch', event => {
  const url = new URL(event.request.url);

  // Never cache API calls, SSE streams, or non-GET requests
  if (
    event.request.method !== 'GET' ||
    url.pathname.startsWith('/api/') ||
    url.pathname.startsWith('/health') ||
    url.pathname.startsWith('/stream') ||
    event.request.url.includes('/invoke') ||
    event.request.url.includes('/events') ||
    event.request.headers.get('accept')?.includes('text/event-stream')
  ) {
    return;
  }

  // Navigation requests (HTML pages): show offline page on failure
  if (event.request.mode === 'navigate') {
    event.respondWith(
      fetch(event.request)
        .then(response => {
          // Cache successful navigation responses
          if (response.ok) {
            const clone = response.clone();
            caches.open(CACHE_NAME).then(cache => cache.put(event.request, clone));
          }
          return response;
        })
        .catch(() => caches.match(OFFLINE_URL))
    );
    return;
  }

  // Static assets: network-first with cache fallback
  event.respondWith(
    fetch(event.request)
      .then(response => {
        if (response.ok) {
          const clone = response.clone();
          caches.open(CACHE_NAME).then(cache => cache.put(event.request, clone));
        }
        return response;
      })
      .catch(() => caches.match(event.request))
  );
});
