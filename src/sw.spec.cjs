const { test } = require('node:test');
const assert = require('node:assert/strict');
const { readFileSync } = require('node:fs');
const { runInNewContext } = require('node:vm');

function worker(fetchImpl = async () => new Response('network')) {
  const handlers = {};
  const deleted = [];
  const offline = new Response('offline');
  const caches = {
    open: async () => ({ add: async () => {}, match: async () => offline }),
    keys: async () => [
      'rcman-static-assets',
      'rcman-navigation-cache',
      'rcman-dynamic-fallback',
      'workbox-precache-v2-http://localhost/',
      'rcman-offline-v1',
      'unrelated-cache',
    ],
    delete: async key => {
      deleted.push(key);
      return true;
    },
  };
  runInNewContext(readFileSync(`${__dirname}/sw.js`, 'utf8'), {
    URL,
    Request,
    Response,
    caches,
    fetch: fetchImpl,
    self: {
      location: { origin: 'http://localhost' },
      registration: { scope: 'http://localhost/' },
      addEventListener: (type, handler) => {
        handlers[type] = handler;
      },
      skipWaiting: async () => {},
      clients: { claim: async () => {} },
    },
  });
  return { handlers, deleted, offline };
}

function request(path, options = {}) {
  return {
    url: `http://localhost${path}`,
    method: 'GET',
    mode: 'navigate',
    headers: new Headers(),
    signal: new AbortController().signal,
    ...options,
  };
}

function dispatch(handlers, req) {
  let response;
  handlers.fetch({
    request: req,
    respondWith: value => {
      response = value;
    },
  });
  return response;
}

test('API, media, Range and module preloads never use respondWith', () => {
  const { handlers } = worker(() => {
    throw new Error('must bypass worker');
  });
  for (const req of [
    request('/api/invoke', { method: 'POST' }),
    request('/api/events'),
    request('/api/stream/remote?path=song.mp3'),
    request('/stream'),
    request('/health'),
    request('/assets/icon.svg'),
    request('/chunk-abc.js', { mode: 'cors' }),
    request('/video', { mode: 'no-cors', destination: 'video' }),
    request('/audio', { mode: 'no-cors', destination: 'audio' }),
    request('/file', { headers: new Headers({ Range: 'bytes=0-' }) }),
    request('/events', { headers: new Headers({ Accept: 'text/event-stream' }) }),
    request('/page', { url: 'https://another.example/page' }),
  ])
    assert.equal(dispatch(handlers, req), undefined, req.url);
});

test('navigation uses the network without caching application HTML', async () => {
  const { handlers } = worker();
  assert.equal(await (await dispatch(handlers, request('/nautilus/dropbox'))).text(), 'network');
});

test('offline fallback is limited to failed navigations, not HTTP errors or aborts', async () => {
  const failed = worker(async () => {
    throw new Error('offline');
  });
  assert.equal(await dispatch(failed.handlers, request('/')), failed.offline);
  const serverError = worker(async () => new Response('error', { status: 500 }));
  assert.equal((await dispatch(serverError.handlers, request('/'))).status, 500);
  const controller = new AbortController();
  controller.abort();
  await assert.rejects(
    dispatch(failed.handlers, request('/', { signal: controller.signal })),
    /offline/
  );
});

test('activation removes only obsolete application caches', async () => {
  const { handlers, deleted } = worker();
  let activation;
  handlers.activate({
    waitUntil: value => {
      activation = value;
    },
  });
  await activation;
  assert.deepEqual(
    deleted.sort(),
    [
      'rcman-static-assets',
      'rcman-navigation-cache',
      'rcman-dynamic-fallback',
      'workbox-precache-v2-http://localhost/',
    ].sort()
  );
});
