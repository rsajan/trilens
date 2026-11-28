// End-of-day stock prices (US and India) for the chart.
//
// PUBLISH.bat reads the daily price files your scanners keep on your PC and writes
// data/technical/prices.json, encrypted with your Technical password exactly like the bundle.
// Here it is fetched once, unlocked with the remembered password (or the lock screen), and
// served through the normal DataAdapter interface. One daily bar per trading day, no intraday,
// no live ticks: the newest bar is the last close in your price files.
//
// withStocks(feed) adds these symbols to any other feed, so the search box and watchlists find
// a stock (e.g. "MU" or "CIPLA.NS") next to the crypto contracts.

import { getJSON } from '../../lib/data.js';
import { store } from '../../lib/store.js';
import { decryptEnvelope, cryptoAvailable } from '../../lib/crypto.js';
import { TF, aggregate, emptyBars, sliceBars } from './timeframes.js';

const PATHS = ['data/technical/prices.json', 'data/technical/prices.local.json'];
const MARKET = { US: { name: 'US stock', quote: 'USD' }, IN: { name: 'India stock (NSE)', quote: 'INR' } };

/** Encoded series (see encode_prices in pipeline/build_technical.py) -> columnar daily Bars. */
export function decodeSeries(e) {
  const n = e.c.length, m = 10 ** e.dp;
  const b = emptyBars(n);
  let day = e.d0, c = 0;
  for (let i = 0; i < n; i++) {
    if (i) day += e.dd[i - 1];
    c += e.c[i];
    const o = c + e.o[i];
    b.time[i] = day * 86400;
    b.open[i] = o / m; b.close[i] = c / m;
    b.high[i] = (Math.max(o, c) + e.h[i]) / m;
    b.low[i] = (Math.min(o, c) - e.l[i]) / m;
    b.volume[i] = e.v[i];
  }
  return sliceBars(b, 0, n);
}

/** Several daily Bars (history pieces + this month) -> one, by time, later copies winning. */
export function mergeBars(parts) {
  const byTime = new Map();
  for (const b of parts) for (let i = 0; i < b.length; i++) byTime.set(b.time[i], [b.open[i], b.high[i], b.low[i], b.close[i], b.volume[i]]);
  const times = [...byTime.keys()].sort((a, b) => a - b);
  const out = emptyBars(times.length);
  times.forEach((t, i) => { const r = byTime.get(t); out.time[i] = t; out.open[i] = r[0]; out.high[i] = r[1]; out.low[i] = r[2]; out.close[i] = r[3]; out.volume[i] = r[4]; });
  return sliceBars(out, 0, times.length);
}

/** Decrypted prices (v1: full series per market; v2: index of [symbol, decimals, bucket]) -> contracts. */
export function stockContracts(data) {
  const out = [];
  for (const [mk, v] of Object.entries((data && data.markets) || {})) {
    const info = MARKET[mk] || { name: mk + ' stock', quote: '' };
    const rows = v.symbols ? v.symbols.map(([s, dp]) => ({ s, dp })) : (v.series || []);
    for (const e of rows) {
      out.push({ symbol: e.s, name: `${info.name} · end of day`, base: e.s.replace(/\.NS$/, ''), quote: info.quote, kind: 'stock', market: mk, tick: 1 / 10 ** e.dp });
    }
  }
  return out;
}

/** "Perpetual", "Quarterly", "US stock · EOD" ... for a contract's badge. */
export function kindLabel(c) {
  if (!c) return '';
  if (c.kind === 'stock') return (c.market === 'IN' ? 'India' : c.market || '') + ' stock · EOD';
  return c.kind === 'perp' ? 'Perpetual' : 'Quarterly';
}

// ---------------------------------------------------------------- shared, unlocked once per page
/** status: 'idle' | 'loading' | 'none' (not published) | 'locked' | 'ready' | 'error' */
export const stockData = {
  status: 'idle', env: null, data: null, contracts: [], error: '', pass: '',
  /** symbol -> encoded series (v1: all bars; v2: this month); full decoded Bars cached in `bars` */
  series: new Map(), bars: new Map(), listeners: new Set(), _p: null,
  /** v2: symbol -> bucket, bucket -> Promise<Map<symbol, encoded[]>> of its history pieces */
  bucket: new Map(), pieces: new Map(),

  subscribe(fn) { this.listeners.add(fn); return () => this.listeners.delete(fn); },
  emit() { for (const f of [...this.listeners]) { try { f(this); } catch (err) { console.error(err); } } },

  set(data, pass = '') {
    this.data = data;
    this.pass = pass;
    this.series = new Map();
    this.bucket = new Map();
    this.pieces = new Map();
    for (const v of Object.values(data.markets || {})) {
      for (const e of v.series || []) this.series.set(e.s, e);
      for (const [s, , b] of v.symbols || []) this.bucket.set(s, b);
    }
    for (const e of data.recent || []) this.series.set(e.s, e);
    this.bars = new Map();
    this.contracts = stockContracts(data);
    this.status = 'ready';
  },

  /** Fetch and open the file once; `force` retries after an unlock elsewhere (e.g. the ⚡ button). */
  load(force = false) {
    if (this._p && !force) return this._p;
    if (force && this.status === 'ready') return Promise.resolve(this);
    this._p = (async () => {
      this.status = 'loading';
      let env = null;
      for (const p of PATHS) { env = await getJSON(p, { fresh: true }); if (env) break; }
      if (!env) { this.status = 'none'; this.emit(); return this; }
      if (!env.enc) { this.set(env); this.emit(); return this; }
      this.env = env;
      const saved = store.get('techpass');
      if (saved && cryptoAvailable()) {
        try { this.set(await decryptEnvelope(env, saved), saved); this.emit(); return this; } catch { /* stays locked */ }
      }
      this.status = 'locked'; this.emit(); return this;
    })().catch((err) => { this.status = 'error'; this.error = String(err.message || err); this.emit(); return this; });
    return this._p;
  },

  /** Used by the lock screen. Throws 'bad-password'. */
  async unlock(env, pass) { this.set(await decryptEnvelope(env, pass), pass); this._p = Promise.resolve(this); this.emit(); },

  has(symbol) { return this.series.has(symbol) || this.bucket.has(symbol); },
  /** This month's bars only (v2) or everything (v1): enough for last price and day change. */
  recent(symbol) {
    const e = this.series.get(symbol);
    return e ? decodeSeries(e) : emptyBars(0);
  },
  /** v2: every history piece of the symbol's bucket, fetched and opened once per bucket. */
  bucketPieces(b) {
    if (!this.pieces.has(b)) {
      const names = (this.data && this.data.pieces) || [];
      const pass = this.pass;
      const p = (async () => {
        const map = new Map();
        const one = async (name) => {
          const env = await getJSON(`data/technical/prices/${name}-b${String(b).padStart(2, '0')}.json`, { fresh: true });
          if (!env) return; // piece missing: that stretch of history is simply not shown
          const obj = env.enc ? await decryptEnvelope(env, pass) : env;
          for (const e of obj.series || []) { if (!map.has(e.s)) map.set(e.s, []); map.get(e.s).push(e); }
        };
        for (let i = 0; i < names.length; i += 8) await Promise.all(names.slice(i, i + 8).map((n) => one(n).catch((err) => console.warn('price piece', n, err))));
        return map;
      })();
      this.pieces.set(b, p);
    }
    return this.pieces.get(b);
  },
  /** All daily bars of a symbol: history pieces + this month. */
  async daily(symbol) {
    if (!this.bars.has(symbol)) {
      if (!this.has(symbol)) throw new Error(`${symbol} is not in your end-of-day prices`);
      const parts = [];
      if (this.bucket.has(symbol)) for (const e of (await this.bucketPieces(this.bucket.get(symbol))).get(symbol) || []) parts.push(decodeSeries(e));
      parts.push(this.recent(symbol));
      this.bars.set(symbol, parts.length === 1 ? parts[0] : mergeBars(parts));
    }
    return this.bars.get(symbol);
  },
  /** { name, symbols } for the "US top 500" and "India top 500" watchlists. */
  topLists() {
    const m = (this.data && this.data.markets) || {};
    return [['US', 'US top 500'], ['IN', 'India top 500']].filter(([k]) => m[k]).map(([k, name]) => ({ name, symbols: m[k].top || [] }));
  },
};

// ---------------------------------------------------------------- adapter
export class StocksAdapter {
  constructor() {
    this.id = 'stocks';
    this.label = 'Stocks (end of day)';
    this.short = 'Stocks EOD';
    this.note = 'Daily US and India stock prices from the price files on your PC, published encrypted by PUBLISH.bat. One bar per trading day, no live ticks.';
  }

  async contracts() {
    await stockData.load();
    if (stockData.status === 'ready') return stockData.contracts;
    if (stockData.status === 'locked') throw new Error('Your stock prices are locked. Press "🔒 Unlock stocks" in the toolbar and enter your Technical password.');
    if (stockData.status === 'none') throw new Error('No stock prices are published yet. Run PUBLISH.bat on your PC (it needs pandas: python -m pip install pandas).');
    throw new Error('Could not open the stock prices: ' + stockData.error);
  }

  async bars(symbol, tf, opts = {}) {
    const t = TF[tf];
    if (!t || !t.calendar) throw new Error('Stocks have end-of-day prices only. Pick D, W or M.');
    await stockData.load();
    let b = await stockData.daily(symbol);
    if (opts.to != null) {
      let n = 0;
      while (n < b.length && b.time[n] <= opts.to) n++;
      b = sliceBars(b, 0, n);
    }
    if (tf !== '1D') b = aggregate(b, t);
    const limit = opts.limit ?? 5000;
    return b.length > limit ? sliceBars(b, b.length - limit, b.length) : b;
  }

  subscribeBars() { return () => {}; } // end of day: nothing moves until the next publish

  subscribeTelemetry(symbol, onTele) {
    let live = true;
    stockData.load().then(() => {
      if (!live || !stockData.has(symbol)) return;
      const b = stockData.recent(symbol), n = b.length;
      if (!n) return;
      const last = b.close[n - 1], prev = n > 1 ? b.close[n - 2] : NaN;
      onTele({ symbol, kind: 'stock', time: b.time[n - 1], last, mark: last, index: last,
        change24h: last - prev, changePct24h: Number.isFinite(prev) && prev ? (last / prev - 1) * 100 : NaN,
        high24h: b.high[n - 1], low24h: b.low[n - 1], volume24h: b.volume[n - 1], turnover24h: b.volume[n - 1] * last,
        openInterest: NaN, openInterestValue: NaN });
    });
    return () => { live = false; };
  }

  dispose() {}
}

/**
 * Any feed plus your stocks: contracts are the feed's followed by the stocks (once unlocked);
 * each call goes to whichever side owns the symbol. Status fields read through to the feed.
 */
export function withStocks(inner) {
  const stocks = new StocksAdapter();
  let cache = null;
  stockData.subscribe(() => { cache = null; });
  const route = (symbol) => (stockData.has(symbol) ? stocks : inner);
  return {
    get id() { return inner.id; }, get label() { return inner.label; }, get short() { return inner.short; }, get note() { return inner.note; },
    get source() { return inner.source; }, get chosen() { return inner.chosen; }, get fallbackReason() { return inner.fallbackReason; },
    inner,
    contracts() {
      if (!cache) {
        cache = Promise.allSettled([inner.contracts(), stockData.load()]).then(([a]) => {
          const extra = stockData.status === 'ready' ? stockData.contracts : [];
          if (a.status === 'rejected') { if (!extra.length) { cache = null; throw a.reason; } return extra; }
          return [...a.value, ...extra];
        });
      }
      return cache;
    },
    bars: (symbol, tf, opts) => route(symbol).bars(symbol, tf, opts),
    subscribeBars: (symbol, tf, onBar) => route(symbol).subscribeBars(symbol, tf, onBar),
    subscribeTelemetry: (symbol, onTele) => route(symbol).subscribeTelemetry(symbol, onTele),
    dispose() { inner.dispose(); },
  };
}
