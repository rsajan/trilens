// Data adapters. The UI and chart engine only ever talk to the DataAdapter interface below, so a
// feed can be swapped without touching a component.
//
//  - SyntheticAdapter: a deterministic futures market generated in a Web Worker.
//    Works offline, needs no key, costs nothing.
//  - Live feeds (live.js): Binance and Bybit public endpoints, no key. "Live (auto)" is the
//    default: the first exchange that answers, the synthetic market only if none does.


/**
 * @typedef {import('./timeframes.js').Bars} Bars
 * @typedef {{ time: number, open: number, high: number, low: number, close: number, volume: number }} Bar
 * @typedef {{ symbol: string, name: string, base: string, quote: string, kind: 'perp'|'dated', tick: number }} Contract
 * @typedef {Object} Telemetry
 * @property {string} symbol @property {'perp'|'dated'} kind @property {number} time
 * @property {number} last @property {number} mark @property {number} index
 * @property {number} change24h @property {number} changePct24h @property {number} high24h @property {number} low24h
 * @property {number} volume24h @property {number} turnover24h @property {number} openInterest @property {number} openInterestValue
 * @property {number=} fundingRate @property {number=} nextFundingTime @property {number=} expiryTime
 * @property {number=} basis @property {number=} basisPct @property {number=} basisAnnualPct
 *
 * @typedef {Object} DataAdapter
 * @property {string} id @property {string} label @property {string} note
 * @property {() => Promise<Contract[]>} contracts
 * @property {(symbol: string, tf: string, opts?: { to?: number, limit?: number }) => Promise<Bars>} bars
 * @property {(symbol: string, tf: string, onBar: (bar: Bar) => void) => () => void} subscribeBars
 * @property {(symbol: string, onTele: (t: Telemetry) => void) => () => void} subscribeTelemetry
 * @property {() => void} dispose
 */

// ---------------------------------------------------------------------------------------------
/** @implements {DataAdapter} */
export class SyntheticAdapter {
  constructor() {
    this.id = 'synthetic';
    this.label = 'Synthetic market';
    this.short = 'Synthetic';
    this.note = 'Generated in your browser. Realistic behaviour, not real prices.';
    this.worker = new Worker(new URL('./data.worker.js', import.meta.url), { type: 'module' });
    this.seq = 0;
    this.pending = new Map();
    this.barHandlers = new Map();
    this.teleHandlers = new Map();
    this.worker.onmessage = (e) => {
      const m = e.data;
      if (m.id !== undefined) {
        const p = this.pending.get(m.id);
        if (!p) return;
        this.pending.delete(m.id);
        m.ok ? p.resolve(m.result) : p.reject(new Error(m.error));
      } else if (m.type === 'bar') this.barHandlers.get(m.key)?.(m.bar);
      else if (m.type === 'tele') this.teleHandlers.get(m.symbol)?.forEach((f) => f(m.data));
    };
    this.worker.onerror = (e) => console.error('data worker', e.message);
  }

  call(msg) {
    const id = ++this.seq;
    return new Promise((resolve, reject) => { this.pending.set(id, { resolve, reject }); this.worker.postMessage({ ...msg, id }); });
  }

  contracts() { return this.call({ type: 'contracts' }); }
  bars(symbol, tf, opts = {}) { return this.call({ type: 'bars', symbol, tf, to: opts.to, limit: opts.limit }); }

  subscribeBars(symbol, tf, onBar) {
    const key = `b${++this.seq}`;
    this.barHandlers.set(key, onBar);
    this.worker.postMessage({ type: 'sub', key, symbol, tf });
    return () => { this.barHandlers.delete(key); this.worker.postMessage({ type: 'unsub', key }); };
  }

  subscribeTelemetry(symbol, onTele) {
    let set = this.teleHandlers.get(symbol);
    if (!set) { set = new Set(); this.teleHandlers.set(symbol, set); }
    set.add(onTele);
    this.worker.postMessage({ type: 'tele', symbol });
    return () => { set.delete(onTele); this.worker.postMessage({ type: 'untele', symbol }); };
  }

  dispose() { this.worker.terminate(); this.pending.clear(); }
}

// Live adapters live in live.js (it imports SyntheticAdapter from here for its fallback; the
// registry below only touches them when a feed is first used, so the import cycle is harmless).
import { AutoLiveAdapter, BinanceAdapter, BybitAdapter } from './live.js';
import { StocksAdapter, withStocks } from './stocks.js';

export const FEEDS = [
  { id: 'live', label: 'Live (auto)', title: 'Binance, or Bybit if Binance is blocked here; synthetic only if neither answers. Your end-of-day stocks are added once unlocked.' },
  { id: 'binance', label: 'Binance (live)', title: 'Binance USD-M perpetuals, plus your end-of-day stocks' },
  { id: 'bybit', label: 'Bybit (live)', title: 'Bybit linear perpetuals, plus your end-of-day stocks' },
  { id: 'stocks', label: 'Stocks (end of day)', title: 'Only your US and India stocks, daily bars from PUBLISH.bat' },
  { id: 'synthetic', label: 'Synthetic (offline)', title: 'Generated in your browser: works offline, not real prices' },
];

// Every crypto feed also carries your end-of-day stocks (withStocks), so one search box finds both.
export const ADAPTERS = {
  live: () => withStocks(new AutoLiveAdapter()),
  binance: () => withStocks(new BinanceAdapter()),
  bybit: () => withStocks(new BybitAdapter()),
  stocks: () => new StocksAdapter(),
  synthetic: () => withStocks(new SyntheticAdapter()),
};
