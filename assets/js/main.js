import { h, $, clear, icon, fmt, sheet, toDate } from './lib/dom.js';
import { store } from './lib/store.js';
import { D, setVersion, clearMemo, getJSON } from './lib/data.js';

const NAV = [
  { id: 'overview', label: 'Overview', path: '#/', icon: 'overview' },
  { id: 'fundamentals', label: 'Fundamentals', path: '#/fundamentals', icon: 'fundamentals' },
  { id: 'technical', label: 'Technical', path: '#/technical', icon: 'technical' },
  { id: 'sentiment', label: 'Sentiment', path: '#/sentiment', icon: 'sentiment' },
];

const PAGES = {
  overview: () => import('./pages/overview.js'),
  fundamentals: () => import('./pages/fundamentals.js'),
  technical: () => import('./pages/technical.js'),
  sentiment: () => import('./pages/sentiment.js'),
};

const view = $('#view');
let meta = null;
let renderToken = 0;

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
  let text = 'No data yet';
  if (meta) {
    const when = toDate(meta.generated_at);
    const age = when ? (Date.now() - when.getTime()) / 3600000 : 999;
    if (meta.demo) { chip.classList.add('demo'); text = 'Sample data'; }
    else if (age > 36) { chip.classList.add('stale'); text = 'Updated ' + fmt.rel(meta.generated_at); }
    else text = 'Updated ' + fmt.rel(meta.generated_at);
  } else chip.classList.add('stale');
  $('#status-text').textContent = text;
}
$('#status').addEventListener('click', () => {
  const jobs = meta?.jobs || {};
  const rows = [['Prices and indices', jobs.quotes], ['Company fundamentals', jobs.fundamentals], ['SEC insider trades and filings', jobs.edgar], ['Sentiment', jobs.sentiment], ['Technical bundle (from your PC)', meta?.technical_built_at]];
  sheet('Data status',
    meta?.demo ? h('p', { class: 'soft' }, 'The numbers on the Fundamentals and Sentiment pages are sample data so you can try the layout. They are replaced the first time the automatic update runs on GitHub.') : null,
    h('div', { class: 'ledger' }, rows.map(([l, v]) => h('div', { class: 'lrow', style: { minHeight: '48px' } }, h('span', { class: 'grow' }, l), h('span', { class: 'muted num' }, v ? fmt.rel(v) : 'not yet')))),
    meta?.errors && Object.keys(meta.errors).length ? h('div', { class: 'banner warn', style: { marginTop: '14px' } }, icon('alert'), h('div', null, h('b', null, 'Last run had problems. '), Object.entries(meta.errors).map(([k, v]) => `${k}: ${v}`).join('. '), '. The pages keep the last good data.')) : null,
    h('p', { class: 'muted small', style: { marginTop: '14px' } }, 'Prices come from Yahoo Finance and can be delayed by 15 minutes or more. Nothing here is investment advice.'));
});

function banners() {
  const box = h('div');
  if (meta?.demo) box.append(h('div', { class: 'banner demo' }, icon('info'), h('div', null, h('b', null, 'Sample data. '), 'Fundamentals and Sentiment are showing made-up numbers so you can try the layout. Real data replaces them after the first automatic update.')));
  else if (meta) {
    const when = toDate(meta.generated_at);
    if (when && (Date.now() - when.getTime()) / 3600000 > 36) box.append(h('div', { class: 'banner warn' }, icon('alert'), h('div', null, h('b', null, 'Data is more than a day old. '), 'Open the Actions tab of your GitHub repository and check that "Refresh data and publish" is running.')));
  }
  if (!navigator.onLine) box.append(h('div', { class: 'banner warn' }, icon('alert'), h('div', null, h('b', null, 'You are offline. '), 'Showing the last data saved on this device.')));
  return box.childNodes.length ? box : null;
}

// ---------- routing ----------
export const ctx = {
  get meta() { return meta; },
  go(path) { location.hash = path; },
  setTitle(t) { document.title = t ? `${t} · Trilens` : 'Trilens — fundamentals, technicals and sentiment'; },
  keepScroll() { route.keepScroll = true; },
};

async function route() {
  const token = ++renderToken;
  const hash = location.hash.replace(/^#/, '') || '/';
  const parts = hash.split('/').filter(Boolean).map(decodeURIComponent);
  const id = PAGES[parts[0]] ? parts[0] : 'overview';
  markNav(id);
  view.classList.add('loading');
  try {
    const mod = await PAGES[id]();
    const body = await mod.render({ ...ctx, params: id === parts[0] ? parts.slice(1) : parts });
    if (token !== renderToken) return;
    clear(view);
    const b = banners();
    if (b) view.append(b);
    view.append(body);
    if (mod.afterRender) mod.afterRender(view);
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
  meta = await D.meta();
  const tm = await getJSON('data/technical/meta.json', { fresh: true }).catch(() => null);
  if (meta && tm?.built_at) meta = { ...meta, technical_built_at: tm.built_at };
  setVersion(meta?.generated_at || '');
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
// with. Without this, a deploy looks "stuck on the old version" until a second manual refresh.
// Reload once, automatically, the moment a new worker actually takes control.
if ('serviceWorker' in navigator && (location.protocol === 'https:' || location.hostname === 'localhost' || location.hostname === '127.0.0.1')) {
  navigator.serviceWorker.addEventListener('controllerchange', () => {
    if (sessionStorage.getItem('trilens:sw-reloaded')) return;
    sessionStorage.setItem('trilens:sw-reloaded', '1');
    location.reload();
  });
  addEventListener('load', () => navigator.serviceWorker.register('./sw.js').catch(() => {}));
}
