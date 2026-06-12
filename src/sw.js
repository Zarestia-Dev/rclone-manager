// Import Google's Workbox library via CDN
importScripts('https://storage.googleapis.com/workbox-cdn/releases/7.0.0/workbox-sw.js');

if (workbox) {
  console.log('Workbox loaded successfully');

  const { registerRoute, setDefaultHandler, setCatchHandler } = workbox.routing;
  const { CacheFirst, NetworkFirst, NetworkOnly } = workbox.strategies;
  const { precacheAndRoute } = workbox.precaching;

  // 1. Immediate Activation (Skip waiting and claim clients)
  workbox.core.skipWaiting();
  workbox.core.clientsClaim();

  // 2. Precaching the App Shell & Critical Assets
  // Workbox automatically revisions and updates these files when they change
  precacheAndRoute([
    { url: '/', revision: 'v2' },
    { url: '/index.html', revision: 'v2' },
    { url: '/offline.html', revision: 'v2' },
    { url: 'assets/icons/files/folder.svg', revision: 'v2' },
    { url: 'assets/icons/files/file.svg', revision: 'v2' },
    { url: 'assets/icons/devices/hard-drive.svg', revision: 'v2' },
    { url: 'assets/icons/devices/server.svg', revision: 'v2' },
    { url: 'assets/icons/devices/globe.svg', revision: 'v2' },
    { url: 'assets/icons/general/gear.svg', revision: 'v2' },
    { url: 'assets/icons/general/info.svg', revision: 'v2' },
    { url: 'assets/icons/navigation/chevron-left.svg', revision: 'v2' },
    { url: 'assets/icons/navigation/chevron-right.svg', revision: 'v2' },
    { url: 'assets/icons/navigation/chevron-up.svg', revision: 'v2' },
    { url: 'assets/icons/navigation/chevron-down.svg', revision: 'v2' },
    { url: 'assets/icons/titlebar/search.svg', revision: 'v2' },
    { url: 'assets/icons/actions/rotate.svg', revision: 'v2' },
    { url: 'assets/icons/titlebar/close.svg', revision: 'v2' },
    { url: 'assets/icons/titlebar/add.svg', revision: 'v2' },
    { url: 'assets/icons/adwaita/places/folder.svg', revision: 'v2' },
    { url: 'assets/icons/adwaita/mimetypes/text-x-generic.svg', revision: 'v2' },
  ]);

  // 3. Exclusions (API, SSE Streams, Dev Server) -> Network Only
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

  // 4. Static Assets (JS, CSS, Images, Fonts) -> Cache First
  registerRoute(
    ({ url }) =>
      url.pathname.includes('/assets/') ||
      /\.(js|css|woff2?|ttf|png|jpe?g|gif|svg|ico|webmanifest)$/i.test(url.pathname),
    new CacheFirst({
      cacheName: 'rcman-static-assets',
      plugins: [
        new workbox.expiration.ExpirationPlugin({
          maxEntries: 60,
          maxAgeSeconds: 30 * 24 * 60 * 60, // 30 Days
        }),
      ],
    })
  );

  // 5. Default Strategy -> Network First
  // Handles navigation and regular page requests dynamically
  setDefaultHandler(
    new NetworkFirst({
      cacheName: 'rcman-dynamic-fallback',
    })
  );

  // 6. Global Catch Handler -> Offline Page Fallback
  // If a navigation request completely fails (no network, no cache), show offline.html
  setCatchHandler(({ event }) => {
    if (event.request.mode === 'navigate') {
      return workbox.precaching.matchPrecache('/offline.html');
    }
    return Response.error();
  });

} else {
  console.error('Workbox failed to load!');
}