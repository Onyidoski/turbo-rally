/**
 * Turbo Kart Rally service worker: offline-capable PWA shell.
 *
 * Same-origin game files: stale-while-revalidate (instant load, fresh soon).
 * Three.js CDN + fonts: cache-first (works offline after the first visit).
 * Navigations: network-first, cache fallback.
 *
 * Bump VERSION when shipping game updates so old caches are purged.
 */
const VERSION = 'tkr-v3';
const CORE = [
  './',
  './index.html',
  './manifest.webmanifest',
  './src/styles.css',
  './src/main.js',
  './src/config.js',
  './src/events.js',
  './src/track.js',
  './src/environment.js',
  './src/track-textures.js',
  './src/kart.js',
  './src/ai.js',
  './src/input.js',
  './src/items.js',
  './src/effects.js',
  './src/models.js',
  './src/camera.js',
  './src/race.js',
  './src/hud.js',
  './src/menu.js',
  './src/audio.js',
  './src/net.js',
  './src/mp.js',
  './icons/icon-192.png',
  './icons/icon-512.png',
  './icons/icon-maskable-512.png',
];

self.addEventListener('install', (event) => {
  event.waitUntil(
    caches.open(VERSION).then((cache) => cache.addAll(CORE)).then(() => self.skipWaiting())
  );
});

self.addEventListener('activate', (event) => {
  event.waitUntil(
    caches.keys()
      .then((keys) => Promise.all(keys.filter((k) => k !== VERSION).map((k) => caches.delete(k))))
      .then(() => self.clients.claim())
  );
});

self.addEventListener('fetch', (event) => {
  const req = event.request;
  if (req.method !== 'GET') return;
  const url = new URL(req.url);

  if (req.mode === 'navigate') {
    event.respondWith(
      fetch(req).then((res) => {
        const copy = res.clone();
        caches.open(VERSION).then((cache) => cache.put(req, copy));
        return res;
      }).catch(() => caches.match('./index.html'))
    );
    return;
  }

  if (url.origin === self.location.origin) {
    event.respondWith(
      caches.match(req).then((cached) => {
        const fresh = fetch(req).then((res) => {
          if (res && res.ok) {
            const copy = res.clone();
            caches.open(VERSION).then((cache) => cache.put(req, copy));
          }
          return res;
        }).catch(() => cached);
        return cached || fresh;
      })
    );
    return;
  }

  // Third-party (Three.js CDN, fonts): cache-first.
  event.respondWith(
    caches.match(req).then(
      (cached) => cached || fetch(req).then((res) => {
        if (res && res.ok) {
          const copy = res.clone();
          caches.open(VERSION).then((cache) => cache.put(req, copy));
        }
        return res;
      })
    )
  );
});
