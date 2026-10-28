// 一度開いた後は通信なしでも動くよう、画面一式と同梱データをキャッシュする。
const BUILD_ID = '20261028143031';
const CACHE_NAME = `decoy-${BUILD_ID}`;
const ASSETS = [
  './',
  './index.html',
  './app.css',
  './js/main.js',
  './js/core.js',
  './js/crypto.js',
  './js/store.js',
  './data.bin',
];

self.addEventListener('install', (event) => {
  event.waitUntil(
    caches.open(CACHE_NAME)
      .then((cache) => cache.addAll(ASSETS.map((url) => new Request(url, { cache: 'reload' }))))
      .then(() => self.skipWaiting()),
  );
});

self.addEventListener('activate', (event) => {
  event.waitUntil(
    caches.keys()
      .then((keys) => Promise.all(keys.filter((key) => key !== CACHE_NAME).map((key) => caches.delete(key))))
      .then(() => self.clients.claim()),
  );
});

self.addEventListener('fetch', (event) => {
  const request = event.request;
  if (request.method !== 'GET' || new URL(request.url).origin !== self.location.origin) return;
  event.respondWith(
    caches.match(request, { ignoreSearch: true })
      .then((cached) => cached ?? fetch(request))
      .catch(() => caches.match('./index.html')),
  );
});
