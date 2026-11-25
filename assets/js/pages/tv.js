// TradingView page (#/tv, #/tv/<symbol>): TradingView's free embedded chart, for live or slightly
// delayed prices on every stock, index and crypto, with TradingView's own search.
//
// This is the site's one outside script (owner's exception to rule 5 in CLAUDE.md). It is loaded
// only while this page is open, from TradingView's embed host, and runs in TradingView's iframe.
// Nothing from Trilens is sent to it except the symbol shown. Your Pine scripts, drawings, alerts
// and replay belong to the Trilens chart and do not work inside this one.
import { h } from '../lib/dom.js';
import { store } from '../lib/store.js';

export const wide = true;
const EMBED = 'https://s3.tradingview.com/external-embedding/embed-widget-advanced-chart.js';

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
  const box = h('div', { class: 'tradingview-widget-container', style: { height: '100%', width: '100%' } },
    h('div', { class: 'tradingview-widget-container__widget', style: { height: '100%', width: '100%' } }));
  const dark = document.documentElement.getAttribute('data-theme') !== 'light';
  const s = document.createElement('script');
  s.src = EMBED; s.async = true; s.type = 'text/javascript';
  s.textContent = JSON.stringify({
    autosize: true, symbol: sym, interval: 'D', timezone: 'Etc/UTC', theme: dark ? 'dark' : 'light', style: '1', locale: 'en',
    allow_symbol_change: true, calendar: false, hide_volume: false, support_host: 'https://www.tradingview.com',
  });
  box.append(s);
  return h('div', { class: 'tv-page' },
    h('p', { class: 'tiny muted tv-note' }, 'TradingView\'s own chart: live or slightly delayed prices for every market. Search any symbol in its top-left box (e.g. MU, NSE:CIPLA). Your Trilens scripts, drawings and alerts are on the Chart page.'),
    h('div', { class: 'tv-frame' }, box));
}
