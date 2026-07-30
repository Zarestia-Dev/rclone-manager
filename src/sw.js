// Import Google's Workbox library via CDN
importScripts('https://storage.googleapis.com/workbox-cdn/releases/7.0.0/workbox-sw.js');

if (workbox) {
  console.log('Workbox loaded successfully');

  const { registerRoute, setDefaultHandler, setCatchHandler } = workbox.routing;
  const { NetworkFirst, NetworkOnly, StaleWhileRevalidate } = workbox.strategies;
  const { precacheAndRoute, cleanupOutdatedCaches } = workbox.precaching;

  // 1. Immediate Activation (Skip waiting and claim clients)
  workbox.core.skipWaiting();
  workbox.core.clientsClaim();

  // Clean up outdated precaches from previous builds
  cleanupOutdatedCaches();

  // 2. Precaching Critical Offline Assets
  // NOTE: Do NOT precache index.html with a static hardcoded revision string,
  // as Angular produces hashed JS/CSS filenames on every build. Precaching index.html
  // statically causes the browser to serve stale HTML pointing to deleted asset chunks.
  precacheAndRoute([
    { url: '/offline.html', revision: 'v3' },
    { url: 'assets/icons/files/folder.svg', revision: 'v3' },
    { url: 'assets/icons/files/file.svg', revision: 'v3' },
    { url: 'assets/icons/devices/hard-drive.svg', revision: 'v3' },
    { url: 'assets/icons/devices/server.svg', revision: 'v3' },
    { url: 'assets/icons/devices/globe.svg', revision: 'v3' },
    { url: 'assets/icons/general/gear.svg', revision: 'v3' },
    { url: 'assets/icons/general/info.svg', revision: 'v3' },
    { url: 'assets/icons/navigation/chevron-left.svg', revision: 'v3' },
    { url: 'assets/icons/navigation/chevron-right.svg', revision: 'v3' },
    { url: 'assets/icons/navigation/chevron-up.svg', revision: 'v3' },
    { url: 'assets/icons/navigation/chevron-down.svg', revision: 'v3' },
    { url: 'assets/icons/titlebar/search.svg', revision: 'v3' },
    { url: 'assets/icons/actions/rotate.svg', revision: 'v3' },
    { url: 'assets/icons/titlebar/close.svg', revision: 'v3' },
    { url: 'assets/icons/titlebar/add.svg', revision: 'v3' },
    { url: 'assets/icons/adwaita/places/folder.svg', revision: 'v3' },
    { url: 'assets/icons/adwaita/mimetypes/text-x-generic.svg', revision: 'v3' },
  ]);

  // 3. Navigation Routes (HTML pages like /, /index.html, /nautilus/*) -> Network First
  // Guarantees the browser always gets the latest index.html referencing active bundle hashes.
  registerRoute(
    ({ request, url }) =>
      request.mode === 'navigate' ||
      url.pathname === '/' ||
      url.pathname === '/index.html' ||
      url.pathname.startsWith('/nautilus'),
    new NetworkFirst({
      cacheName: 'rcman-navigation-cache',
      plugins: [
        new workbox.expiration.ExpirationPlugin({
          maxEntries: 10,
          maxAgeSeconds: 24 * 60 * 60, // 24 Hours
        }),
      ],
    })
  );

  // 4. Exclusions (API, SSE Streams, Dev Server) -> Network Only
  registerRoute(
    ({ url, request }) =>
      url.pathname.startsWith('/api/') ||
      url.pathname.startsWith('/health') ||
      url.pathname.startsWith('/stream') ||
      url.pathname.includes('/invoke') ||
      url.pathname.includes('/events') ||
      request.headers.get('accept')?.includes('text/event-stream') ||
      url.port === '1420',
    new NetworkOnly()
  );

  // 5. Static Assets (JS, CSS, Images, Fonts) -> Stale-While-Revalidate
  registerRoute(
    ({ url }) =>
      url.pathname.includes('/assets/') ||
      /\.(js|css|woff2?|ttf|png|jpe?g|gif|svg|ico|webmanifest)$/i.test(url.pathname),
    new StaleWhileRevalidate({
      cacheName: 'rcman-static-assets',
      plugins: [
        new workbox.expiration.ExpirationPlugin({
          maxEntries: 100,
          maxAgeSeconds: 7 * 24 * 60 * 60, // 7 Days
        }),
      ],
    })
  );

  // 6. Default Strategy -> Network First
  setDefaultHandler(
    new NetworkFirst({
      cacheName: 'rcman-dynamic-fallback',
    })
  );

  // 7. Global Catch Handler -> Offline Page Fallback
  setCatchHandler(({ event }) => {
    if (event.request.mode === 'navigate') {
      return workbox.precaching.matchPrecache('/offline.html');
    }
    return Response.error();
  });
} else {
  console.error('Workbox failed to load!');
}
