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

export async function render(ctx) {
  ctx.setTitle('TradingView');
  const sym = tvSymbol(ctx.params[0] || store.get('tvSymbol', 'NASDAQ:MU'));
  store.set('tvSymbol', sym);
  const dark = document.documentElement.getAttribute('data-theme') !== 'light';
  // TradingView's chart as a plain frame: no TradingView script runs on this site at all
  const q = new URLSearchParams({ symbol: sym, interval: 'D', symboledit: '1', saveimage: '0', toolbarbg: dark ? '0d1b2a' : 'f1f3f6',
    studies: '[]', theme: dark ? 'dark' : 'light', style: '1', timezone: 'Etc/UTC', locale: 'en', hideideas: '1', withdateranges: '1' });
  const frame = h('iframe', { src: FRAME + '?' + q, title: 'TradingView chart: ' + sym, allow: 'fullscreen', allowfullscreen: true,
    referrerpolicy: 'origin', style: { width: '100%', height: '100%', border: '0', display: 'block' } });
  const open = h('a', { href: 'https://www.tradingview.com/chart/?symbol=' + encodeURIComponent(sym), target: '_blank', rel: 'noopener noreferrer' }, 'Open ' + sym + ' on tradingview.com ↗');
  return h('div', { class: 'tv-page' },
    h('p', { class: 'tiny muted tv-note' }, 'TradingView\'s own chart: live or slightly delayed prices for every market. Search any symbol in its top-left box (e.g. MU, NSE:CIPLA). Blank? ', open, '. Your Trilens scripts, drawings and alerts are on the Chart page.'),
    h('div', { class: 'tv-frame' }, frame));
}
