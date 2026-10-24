// Only document navigations need an offline fallback. Let the browser own API,
// Range, media and module requests, including their preload and cancellation behavior.
const OFFLINE_CACHE = 'rcman-offline-v1';
const OFFLINE_URL = '/offline.html';

self.addEventListener('install', event => {
  event.waitUntil(
    (async () => {
      const cache = await caches.open(OFFLINE_CACHE);
      await cache.add(new Request(OFFLINE_URL, { cache: 'reload' }));
      await self.skipWaiting();
    })()
  );
});

self.addEventListener('activate', event => {
  event.waitUntil(
    (async () => {
      const obsolete = new Set([
        'rcman-navigation-cache',
        'rcman-static-assets',
        'rcman-dynamic-fallback',
        `workbox-precache-v2-${self.registration.scope}`,
      ]);
      await Promise.all(
        (await caches.keys()).filter(key => obsolete.has(key)).map(key => caches.delete(key))
      );
      await self.clients.claim();
    })()
  );
});

self.addEventListener('fetch', event => {
  const request = event.request;
  const url = new URL(request.url);
  if (
    request.method !== 'GET' ||
    request.mode !== 'navigate' ||
    url.origin !== self.location.origin ||
    request.headers.has('range') ||
    request.headers.get('accept')?.includes('text/event-stream') ||
    /^\/(api|stream|health)(\/|$)/.test(url.pathname) ||
    url.pathname.startsWith('/assets/') ||
    /\.[^/]+$/.test(url.pathname)
  ) {
    return;
  }

  event.respondWith(
    fetch(request).catch(async error => {
      // An aborted navigation must not be replaced with the offline page.
      if (request.signal.aborted) throw error;
      const cache = await caches.open(OFFLINE_CACHE);
      const offline = await cache.match(OFFLINE_URL);
      if (offline) return offline;
      throw error;
    })
  );
});
