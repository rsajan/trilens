// TradingView page (#/tv, #/tv/<symbol>): TradingView's free embedded chart, for live or slightly
// delayed prices on every stock, index and crypto, with TradingView's own search.
//
// Owner-approved exception to rule 5 in CLAUDE.md: TradingView's chart is shown in an iframe
// (their widget-embed page) only while this page is open. No TradingView script runs on this
// site, and nothing from Trilens is sent except the symbol and theme in the frame address. Your Pine scripts, drawings, alerts
// and replay belong to the Trilens chart and do not work inside this one.
import { h } from '../lib/dom.js';
import { store } from '../lib/store.js';

export const wide = true;
const FRAME = 'https://s.tradingview.com/widgetembed/';

/** Trilens symbol -> TradingView symbol: CIPLA.NS -> NSE:CIPLA, BTCUSDT.P -> BINANCE:BTCUSDT.P, MU -> MU. */
export function tvSymbol(s) {
  s = String(s || '').trim().toUpperCase();
  if (!s) return 'NASDAQ:MU';
  if (s.includes(':')) return s;
  if (s.endsWith('.NS')) return 'NSE:' + s.slice(0, -3);
  if (s.endsWith('.BO')) return 'BSE:' + s.slice(0, -3);
  if (/USDT\.P$/.test(s)) return 'BINANCE:' + s;
  return s;
}

/** TradingView's chart as a plain frame: no TradingView script runs on this site at all. */
export function tvFrame(sym) {
  const dark = document.documentElement.getAttribute('data-theme') !== 'light';
  const q = new URLSearchParams({ symbol: sym, interval: 'D', symboledit: '1', saveimage: '0', toolbarbg: dark ? '0d1b2a' : 'f1f3f6',
    studies: '[]', theme: dark ? 'dark' : 'light', style: '1', timezone: 'Etc/UTC', locale: 'en', hideideas: '1', withdateranges: '1', allow_symbol_change: '1' });
  const frame = h('iframe', { src: FRAME + '?' + q, title: 'TradingView chart: ' + sym, allow: 'fullscreen', allowfullscreen: true,
    referrerpolicy: 'origin', style: { width: '100%', height: '100%', border: '0', display: 'block' } });
  return frame;
}

export async function render(ctx) {
  ctx.setTitle('TradingView');
  const sym = tvSymbol(ctx.params[0] || store.get('tvSymbol', 'NASDAQ:MU'));
  store.set('tvSymbol', sym);
  const frame = tvFrame(sym);
  const open = h('a', { href: 'https://www.tradingview.com/chart/?symbol=' + encodeURIComponent(sym), target: '_blank', rel: 'noopener noreferrer' }, 'Open ' + sym + ' on tradingview.com ↗');
  // our own search box: the embedded chart does not always show TradingView's symbol search
  const input = h('input', { class: 'field tv-q', type: 'search', value: sym, placeholder: 'Symbol, e.g. MU, NSE:CIPLA, NIFTY, BTCUSDT', 'aria-label': 'Symbol to load', autocomplete: 'off', list: 'tv-syms', enterkeyhint: 'go' });
  const list = h('datalist', { id: 'tv-syms' });
  import('../chart/data/stocks.js').then(({ stockData }) => {
    const add = (c) => list.append(h('option', { value: c.symbol }, c.name));
    if (stockData.status === 'ready') stockData.contracts.forEach(add);
  }).catch(() => {});
  const go = (e) => { e.preventDefault(); const v = input.value.trim(); if (v) location.hash = '#/tv/' + encodeURIComponent(tvSymbol(v)); };
  const form = h('form', { class: 'tv-search', role: 'search', onSubmit: go }, input, list, h('button', { class: 'btn primary', type: 'submit' }, 'Load'));
  return h('div', { class: 'tv-page' },
    form,
    h('p', { class: 'tiny muted tv-note' }, 'TradingView\'s own chart: live or slightly delayed prices for every market. Type a ticker (MU, not Micron); India stocks as NSE:CIPLA or CIPLA.NS. Blank? ', open, '. Your Trilens scripts, drawings and alerts are on the Chart page.'),
    h('div', { class: 'tv-frame' }, frame));
}
