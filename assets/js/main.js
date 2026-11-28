import { h, $, clear, icon, fmt, sheet, toDate } from './lib/dom.js';
import { store } from './lib/store.js';
import { getJSON, clearMemo } from './lib/data.js';

const NAV = [
  { id: 'chart', label: 'Chart', path: '#/', icon: 'chart' },
  { id: 'watchlists', label: 'Watch Lists', path: '#/watchlists', icon: 'watchlist' },
  { id: 'scanner', label: 'Scanner', path: '#/scanner', icon: 'scanner' },
  { id: 'scanner-results', label: 'Scanner Results', path: '#/scanner-results', icon: 'results' },
  { id: 'fundamentals', label: 'Fundamental Analysis', path: '#/fundamentals', icon: 'fundamentals' },
  { id: 'fundamental-results', label: 'Fundamental Results', path: '#/fundamental-results', icon: 'results' },
  { id: 'tv', label: 'TradingView', path: '#/tv', icon: 'live' },
];

const PAGES = {
  scanner: () => import('./pages/scanner.js'),
  fundamentals: () => import('./pages/fundamentals.js'),
  'scanner-results': () => import('./pages/scanner-results.js'),
  'fundamental-results': () => import('./pages/fundamental-results.js'),
  watchlists: () => import('./pages/watchlists.js'),
  chart: () => import('./pages/chart.js'),
  tv: () => import('./pages/tv.js'),
};

const view = $('#view');
let meta = null;
let renderToken = 0;
let currentPage = null; // module of the page on screen, so it can release workers/timers on leave

// ---------- theme ----------
function applyTheme() {
  const pref = store.get('theme', 'auto');
  const t = pref === 'auto' ? (matchMedia('(prefers-color-scheme: light)').matches ? 'light' : 'dark') : pref;
  document.documentElement.setAttribute('data-theme', t);
  $('meta[name=theme-color]').setAttribute('content', t === 'light' ? '#edf1f5' : '#0d1b2a');
  const btn = $('#theme');
  clear(btn).append(icon(t === 'light' ? 'moon' : 'sun'));
  btn.title = t === 'light' ? 'Switch to dark theme' : 'Switch to light theme';
}
$('#theme').addEventListener('click', () => {
  const cur = document.documentElement.getAttribute('data-theme');
  store.set('theme', cur === 'light' ? 'dark' : 'light');
  applyTheme();
  route(); // charts read CSS variables at draw time
});
$('#refresh').append(icon('refresh'));
$('#refresh').addEventListener('click', async () => { clearMemo(); await boot(true); route(); });
applyTheme();

// ---------- nav ----------
const nav = $('#nav');
for (const n of NAV) nav.append(h('a', { href: n.path, dataset: { id: n.id } }, icon(n.icon), n.label));
function markNav(id) { nav.querySelectorAll('a').forEach((a) => (a.dataset.id === id ? a.setAttribute('aria-current', 'page') : a.removeAttribute('aria-current'))); }

// ---------- status ----------
function renderStatus() {
  const chip = $('#status');
  chip.className = 'status-chip';
  let text = 'Not published yet';
  if (meta?.built_at) {
    const when = toDate(meta.built_at);
    const age = when ? (Date.now() - when.getTime()) / 3600000 : 999;
    if (age > 36) chip.classList.add('stale');
    text = 'Updated ' + fmt.rel(meta.built_at);
  } else chip.classList.add('stale');
  $('#status-text').textContent = text;
}
$('#status').addEventListener('click', () => {
  sheet('Data status',
    h('div', { class: 'ledger' }, h('div', { class: 'lrow', style: { minHeight: '48px' } },
      h('span', { class: 'grow' }, 'Technical bundle (from your PC)'),
      h('span', { class: 'muted num' }, meta?.built_at ? fmt.rel(meta.built_at) : 'not yet'))),
    h('p', { class: 'muted small', style: { marginTop: '14px' } }, 'Strategies, backtests and scanner signals, built on your PC and published when you run PUBLISH.bat. Nothing here is investment advice.'),
    backupSection());
});

// Chart layouts, drawings, scripts, watchlists, alerts and chart settings live only in this browser.
function backupSection() {
  const note = h('p', { class: 'small', role: 'status', style: { margin: '8px 0 0' } });
  const picker = h('input', { type: 'file', accept: '.json,application/json', class: 'hide', 'aria-label': 'Backup file to restore' });
  picker.addEventListener('change', async () => {
    const f = picker.files[0]; picker.value = '';
    if (!f) return;
    try {
      const { restoreAndReload } = await import('./lib/backup.js');
      const n = await restoreAndReload(JSON.parse(await f.text()));
      note.textContent = `Restored ${n} settings from ${f.name}. Reloading…`;
    } catch (e) { note.textContent = 'Could not restore: ' + e.message; }
  });
  const btn = (label, onClick, primary) => h('button', { type: 'button', class: 'btn' + (primary ? ' primary' : ''), style: { minHeight: '44px' }, onClick }, label);
  return h('div', { style: { marginTop: '18px', paddingTop: '14px', borderTop: '1px solid var(--line)' } },
    h('h3', { style: { margin: '0 0 6px' } }, 'Your settings on this device'),
    h('p', { class: 'muted small', style: { margin: '0 0 10px' } }, 'Chart layouts, drawings, Pine scripts, watchlists, alerts, templates and chart settings are saved only in this browser. Download a backup file to keep them safe or to move them to another phone or PC, then Restore it there. Your password and GitHub token are never included.'),
    h('div', { class: 'row wrap', style: { gap: '8px' } },
      btn('Download backup', async () => { const { download } = await import('./lib/backup.js'); const n = download(); note.textContent = `Backup downloaded: ${n} settings. Keep the file private: it contains your watchlists.`; }, true),
      btn('Restore from file…', () => picker.click())),
    picker, note);
}

function banners() {
  const box = h('div');
  if (meta?.built_at) {
    const when = toDate(meta.built_at);
    if (when && (Date.now() - when.getTime()) / 3600000 > 36) box.append(h('div', { class: 'banner warn' }, icon('alert'), h('div', null, h('b', null, 'Data is more than a day old. '), 'Run PUBLISH.bat on your PC after your next scan.')));
  }
  if (!navigator.onLine) box.append(h('div', { class: 'banner warn' }, icon('alert'), h('div', null, h('b', null, 'You are offline. '), 'Showing the last data saved on this device.')));
  return box.childNodes.length ? box : null;
}

// ---------- routing ----------
export const ctx = {
  get meta() { return meta; },
  go(path) { location.hash = path; },
  setTitle(t) { document.title = t ? `${t} · Trilens` : 'Trilens — technical signals and strategies'; },
  keepScroll() { route.keepScroll = true; },
};

async function route() {
  const token = ++renderToken;
  const hash = location.hash.replace(/^#/, '') || '/';
  const parts = hash.split('/').filter(Boolean).map(decodeURIComponent);
  const id = PAGES[parts[0]] ? parts[0] : 'chart'; // the chart is the home page
  markNav(id);
  view.classList.add('loading');
  try {
    const mod = await PAGES[id]();
    const body = await mod.render({ ...ctx, params: id === parts[0] ? parts.slice(1) : parts });
    if (token !== renderToken) return;
    if (currentPage && currentPage.cleanup) { try { currentPage.cleanup(); } catch (err) { console.error(err); } }
    currentPage = mod;
    view.classList.toggle('wide', !!mod.wide);
    clear(view);
    const b = banners();
    if (b) view.append(b);
    view.append(body);
    if (mod.afterRender) await mod.afterRender(view);
  } catch (e) {
    console.error(e);
    if (token !== renderToken) return;
    clear(view).append(h('div', { class: 'empty' }, h('b', null, 'This page could not load'), 'Try reloading. If it keeps happening, open the browser console for details.', h('pre', { class: 'txt', style: { marginTop: '12px', textAlign: 'left' } }, String(e && e.stack || e))));
  }
  view.classList.remove('loading');
  if (!route.keepScroll) window.scrollTo(0, 0);
  route.keepScroll = false;
}
export function keepScroll() { route.keepScroll = true; }

async function boot(force) {
  meta = await getJSON('data/technical/meta.json', { fresh: true }).catch(() => null);
  renderStatus();
}

addEventListener('hashchange', route);
addEventListener('online', () => route());
addEventListener('offline', () => route());
await boot();
route();

// ---------- service worker (offline + install) ----------
// The new worker takes over as soon as it finishes installing (sw.js calls skipWaiting +
// clients.claim), but the page already open at that moment keeps running on whatever it loaded
// with. Without this, a deploy looks "stuck on the old version" until a manual refresh.
// 'controllerchange' fires exactly once per actual handover, so reload every time it fires -
// a sessionStorage "already reloaded" guard here would silently disable this for every deploy
// after the first one in a session, which is exactly what happened.
if ('serviceWorker' in navigator && (location.protocol === 'https:' || location.hostname === 'localhost' || location.hostname === '127.0.0.1')) {
  navigator.serviceWorker.addEventListener('controllerchange', () => location.reload());
  addEventListener('load', () => navigator.serviceWorker.register('./sw.js').catch(() => {}));
}
