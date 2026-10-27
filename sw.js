// 离线缓存与升级。发布新版本时，把 CACHE_VERSION 加 1（同时更新 app.js 的 APP_VERSION）。
const CACHE_VERSION = 'v0.6.0';
const CACHE_NAME = 'personal-music-' + CACHE_VERSION;
const SHELL = [
  './',
  'index.html',
  'style.css',
  'app.js',
  'manifest.webmanifest',
  'icon.svg',
];

self.addEventListener('install', (event) => {
  event.waitUntil(
    caches.open(CACHE_NAME).then((c) => c.addAll(SHELL)).then(() => self.skipWaiting())
  );
});

self.addEventListener('activate', (event) => {
  event.waitUntil(
    caches.keys()
      .then((keys) => Promise.all(
        keys.filter((k) => k.startsWith('personal-music-') && k !== CACHE_NAME)
            .map((k) => caches.delete(k))
      ))
      .then(() => self.clients.claim())
  );
});

self.addEventListener('fetch', (event) => {
  const req = event.request;
  if (req.method !== 'GET') return;
  const url = new URL(req.url);

  // 曲库清单：网络优先，离线时用缓存（保证拿到最新清单）
  if (url.pathname.endsWith('/tracks.json')) {
    event.respondWith(
      fetch(req).then((res) => {
        const copy = res.clone();
        caches.open(CACHE_NAME).then((c) => c.put(req, copy));
        return res;
      }).catch(() => caches.match(req))
    );
    return;
  }

  // 应用外壳：缓存优先
  if (url.origin === self.location.origin) {
    event.respondWith(
      caches.match(req).then((hit) => hit || fetch(req))
    );
  }
  // 音频来自 archive.org 等外部站点：不缓存，直接走网络
});
