// Trilens service worker: app shell works offline; data is network-first with a saved fallback.
const VERSION = 'trilens-v35';
const SHELL = [
  './', 'index.html', 'manifest.webmanifest',
  'assets/css/app.css',
  'assets/js/main.js',
  'assets/js/lib/dom.js', 'assets/js/lib/data.js', 'assets/js/lib/store.js', 'assets/js/lib/charts.js', 'assets/js/lib/md.js', 'assets/js/lib/crypto.js', 'assets/js/lib/ui.js', 'assets/js/lib/bundle.js',
  'assets/js/pages/scanner.js', 'assets/js/pages/fundamentals.js',
  'assets/js/pages/results.js', 'assets/js/pages/scanner-results.js', 'assets/js/pages/fundamental-results.js', 'assets/js/pages/watchlists.js',
  'assets/js/lib/crosscheck.js', 'assets/js/lib/sync.js',
  'assets/js/pages/chart.js',
  'assets/js/chart/drawings/geometry.js', 'assets/js/chart/drawings/layer.js', 'assets/js/chart/drawings/store.js', 'assets/js/chart/ui/draw-rail.js',
  'assets/js/chart/ui/chart-page.js', 'assets/js/chart/ui/menu.js', 'assets/js/chart/ui/chart-cell.js', 'assets/js/chart/ui/watchlist.js', 'assets/js/chart/ui/alerts.js', 'assets/js/chart/ui/workspace-dialogs.js',
  'assets/js/chart/store/library.js', 'assets/js/chart/store/script-pack.js', 'assets/js/chart/ui/code-editor.js', 'assets/js/chart/ui/dialogs.js', 'assets/js/chart/ui/pine-drawer.js',
  'assets/js/chart/engine/chart-engine.js', 'assets/js/chart/store/workspace.js', 'assets/js/chart/indicators/builtins.js',
  'assets/js/chart/data/adapters.js', 'assets/js/chart/data/live.js', 'assets/js/chart/data/stocks.js', 'assets/js/chart/store/auto-lists.js', 'assets/js/chart/data/bar-buffer.js', 'assets/js/chart/data/data.worker.js', 'assets/js/chart/data/synthetic-engine.js', 'assets/js/chart/data/timeframes.js',
  'assets/js/chart/pine/client.js', 'assets/js/chart/pine/colors.js', 'assets/js/chart/pine/lexer.js', 'assets/js/chart/pine/parser.js', 'assets/js/chart/pine/pine.worker.js', 'assets/js/chart/pine/runtime.js', 'assets/js/chart/pine/ta.js',
  'assets/vendor/lightweight-charts/lightweight-charts.mjs',
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
