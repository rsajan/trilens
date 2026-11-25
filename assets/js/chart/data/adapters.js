// Data adapters. The UI and chart engine only ever talk to the DataAdapter interface below, so a
// feed can be swapped without touching a component.
//
//  - SyntheticAdapter: the default. A deterministic futures market generated in a Web Worker.
//    Works offline, needs no key, costs nothing.
//  - BinanceAdapter: optional. Binance USD-M futures *public* REST + WebSocket endpoints (no key,
//    no account). Blocked in some countries and by some networks; when it fails the UI says so and
//    you switch back to Synthetic. Off by default.

import { TF, aggregate, bucketStart, emptyBars, sliceBars } from './timeframes.js';

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

// ---------------------------------------------------------------------------------------------
const BN_REST = 'https://fapi.binance.com';
const BN_WS = 'wss://fstream.binance.com/ws';
const BN_TF = { '1m': '1m', '3m': '3m', '5m': '5m', '15m': '15m', '30m': '30m', '1h': '1h', '2h': '2h', '4h': '4h', '6h': '6h', '12h': '12h', '1D': '1d', '3D': '3d', '1W': '1w', '1M': '1M' };
const BN_CONTRACTS = [
  { symbol: 'BTCUSDT', name: 'Bitcoin perpetual', base: 'BTC', quote: 'USDT', kind: 'perp', tick: 0.1 },
  { symbol: 'ETHUSDT', name: 'Ether perpetual', base: 'ETH', quote: 'USDT', kind: 'perp', tick: 0.01 },
  { symbol: 'SOLUSDT', name: 'Solana perpetual', base: 'SOL', quote: 'USDT', kind: 'perp', tick: 0.01 },
  { symbol: 'BNBUSDT', name: 'BNB perpetual', base: 'BNB', quote: 'USDT', kind: 'perp', tick: 0.01 },
  { symbol: 'XRPUSDT', name: 'XRP perpetual', base: 'XRP', quote: 'USDT', kind: 'perp', tick: 0.0001 },
];

async function getJSON(url) {
  let res;
  try { res = await fetch(url, { credentials: 'omit', cache: 'no-store' }); }
  catch { throw new Error('Could not reach Binance: you are offline, or this network or country blocks it.'); }
  if (res.status === 451 || res.status === 403) throw new Error('Binance refuses requests from this location or network (HTTP ' + res.status + '). Switch the feed back to Synthetic.');
  if (!res.ok) throw new Error(`Binance returned HTTP ${res.status}`);
  return res.json();
}

/** @implements {DataAdapter} */
export class BinanceAdapter {
  constructor() {
    this.id = 'binance';
    this.label = 'Binance futures (public)';
    this.note = 'Live public prices from Binance USD-M futures. No key. Not available in every country.';
    this.sockets = new Set();
  }

  async contracts() { return BN_CONTRACTS; }

  /** @returns {Promise<Bars>} */
  async bars(symbol, tf, opts = {}) {
    const limit = Math.min(opts.limit ?? 1500, 1500);
    if (tf === '3M') {
      const m = await this.bars(symbol, '1M', { to: opts.to, limit: Math.min(1500, limit * 3) });
      return aggregate(m, TF['3M']);
    }
    const iv = BN_TF[tf];
    if (!iv) throw new Error(`Timeframe ${tf} is not offered by Binance`);
    let url = `${BN_REST}/fapi/v1/klines?symbol=${encodeURIComponent(symbol)}&interval=${iv}&limit=${limit}`;
    if (opts.to) url += `&endTime=${Math.floor(opts.to * 1000)}`;
    const rows = await getJSON(url);
    const b = emptyBars(rows.length);
    rows.forEach((r, i) => { b.time[i] = r[0] / 1000; b.open[i] = +r[1]; b.high[i] = +r[2]; b.low[i] = +r[3]; b.close[i] = +r[4]; b.volume[i] = +r[5]; });
    return sliceBars(b, 0, rows.length);
  }

  socket(stream, onMsg) {
    let ws, closed = false, retry = 0, timer;
    const open = () => {
      ws = new WebSocket(`${BN_WS}/${stream}`);
      this.sockets.add(ws);
      ws.onmessage = (e) => { retry = 0; try { onMsg(JSON.parse(e.data)); } catch (err) { console.error(err); } };
      ws.onclose = () => { this.sockets.delete(ws); if (!closed) timer = setTimeout(open, Math.min(30000, 1000 * 2 ** retry++)); };
    };
    open();
    return () => { closed = true; clearTimeout(timer); ws.close(); };
  }

  subscribeBars(symbol, tf, onBar) {
    const s = symbol.toLowerCase();
    if (tf === '3M') {
      // Binance has no quarterly candles: rebuild the forming quarter from monthly updates
      const tf3 = TF['3M'];
      const months = new Map();
      return this.socket(`${s}@kline_1M`, (m) => {
        const k = m.k; const t = k.t / 1000;
        months.set(t, { open: +k.o, high: +k.h, low: +k.l, close: +k.c, volume: +k.v });
        const q = bucketStart(t, tf3);
        const inQ = [...months.entries()].filter(([mt]) => bucketStart(mt, tf3) === q).sort((a, b) => a[0] - b[0]).map((x) => x[1]);
        onBar({ time: q, open: inQ[0].open, high: Math.max(...inQ.map((x) => x.high)), low: Math.min(...inQ.map((x) => x.low)), close: inQ[inQ.length - 1].close, volume: inQ.reduce((a, x) => a + x.volume, 0) });
      });
    }
    return this.socket(`${s}@kline_${BN_TF[tf]}`, (m) => {
      const k = m.k;
      onBar({ time: k.t / 1000, open: +k.o, high: +k.h, low: +k.l, close: +k.c, volume: +k.v });
    });
  }

  subscribeTelemetry(symbol, onTele) {
    const s = symbol.toLowerCase();
    /** @type {any} */
    const t = { symbol, kind: 'perp', time: 0, last: NaN, mark: NaN, index: NaN, change24h: NaN, changePct24h: NaN, high24h: NaN, low24h: NaN, volume24h: NaN, turnover24h: NaN, openInterest: NaN, openInterestValue: NaN, fundingRate: NaN, nextFundingTime: NaN };
    const emit = () => { t.time = Date.now() / 1000; t.openInterestValue = t.openInterest * t.mark; onTele({ ...t }); };
    const stopMark = this.socket(`${s}@markPrice@1s`, (m) => { t.mark = +m.p; t.index = +m.i; t.fundingRate = +m.r; t.nextFundingTime = m.T / 1000; emit(); });
    const stopTicker = this.socket(`${s}@ticker`, (m) => { t.last = +m.c; t.change24h = +m.p; t.changePct24h = +m.P; t.high24h = +m.h; t.low24h = +m.l; t.volume24h = +m.v; t.turnover24h = +m.q; emit(); });
    let stopped = false;
    const pollOi = async () => {
      if (stopped) return;
      try { const r = await getJSON(`${BN_REST}/fapi/v1/openInterest?symbol=${encodeURIComponent(symbol)}`); t.openInterest = +r.openInterest; emit(); }
      catch (err) { console.warn(err.message); }
      if (!stopped) setTimeout(pollOi, 15000);
    };
    pollOi();
    return () => { stopped = true; stopMark(); stopTicker(); };
  }

  dispose() { for (const ws of this.sockets) ws.close(); this.sockets.clear(); }
}

export const ADAPTERS = {
  synthetic: () => new SyntheticAdapter(),
  binance: () => new BinanceAdapter(),
};
