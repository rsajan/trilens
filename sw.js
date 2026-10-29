// Trilens service worker: app shell works offline; data is network-first with a saved fallback.
const VERSION = 'trilens-v4';
const SHELL = [
  './', 'index.html', 'manifest.webmanifest',
  'assets/css/app.css',
  'assets/js/main.js',
  'assets/js/lib/dom.js', 'assets/js/lib/data.js', 'assets/js/lib/store.js', 'assets/js/lib/charts.js', 'assets/js/lib/md.js', 'assets/js/lib/crypto.js', 'assets/js/lib/ui.js',
  'assets/js/pages/overview.js', 'assets/js/pages/fundamentals.js', 'assets/js/pages/company.js', 'assets/js/pages/technical.js', 'assets/js/pages/sentiment.js', 'assets/js/pages/lookup.js',
  'assets/fonts/bricolage.woff2', 'assets/fonts/plex-400.woff2', 'assets/fonts/plex-500.woff2', 'assets/fonts/plex-600.woff2',
  'assets/icons/icon.svg', 'assets/icons/icon-192.png', 'assets/icons/icon-512.png', 'assets/icons/apple-touch-icon.png',
];

self.addEventListener('install', (e) => {
  e.waitUntil(caches.open(VERSION).then((c) => Promise.allSettled(SHELL.map((u) => c.add(u)))).then(() => self.skipWaiting()));
});
self.addEventListener('activate', (e) => {
  e.waitUntil(caches.keys().then((ks) => Promise.all(ks.filter((k) => k !== VERSION).map((k) => caches.delete(k)))).then(() => self.clients.claim()));
});
self.addEventListener('fetch', (e) => {
  const req = e.request;
  if (req.method !== 'GET') return;
  const url = new URL(req.url);
  if (url.origin !== location.origin) return;
  const isData = url.pathname.includes('/data/');
  if (isData) {
    // network first, fall back to whatever we saved last
    e.respondWith(fetch(req).then((res) => {
      if (res.ok) { const copy = res.clone(); caches.open(VERSION).then((c) => c.put(req, copy)); }
      return res;
    }).catch(() => caches.match(req, { ignoreSearch: true })));
    return;
  }
  // shell: stale-while-revalidate
  e.respondWith(caches.match(req, { ignoreSearch: true }).then((hit) => {
    const net = fetch(req).then((res) => {
      if (res.ok) { const copy = res.clone(); caches.open(VERSION).then((c) => c.put(req, copy)); }
      return res;
    }).catch(() => hit);
    return hit || net;
  }));
});
