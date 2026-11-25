// Live futures data from exchanges' *public* endpoints: no account, no key, no cost.
//
//  - BinanceAdapter: Binance USD-M futures, every USDT perpetual that is trading.
//  - BybitAdapter:   Bybit linear (USDT) perpetuals, every one that is trading.
//  - AutoLiveAdapter: tries Binance, then Bybit, and if neither is reachable from this network or
//    country falls back to the synthetic market, saying so. This is the default feed.
//
// Symbols use TradingView's naming, BTCUSDT.P for a USDT perpetual, on every feed, so watchlists,
// drawings and alerts carry over when the feed changes. The exchange symbol is the part before ".P".
//
// Parsing is in small pure functions (exported for tests) so a change in an exchange's payload
// shows up as a test failure, not as a blank chart.

import { TF, aggregate, bucketStart, emptyBars, sliceBars } from './timeframes.js';
import { SyntheticAdapter } from './adapters.js';

const toApi = (sym) => sym.replace(/\.P$/, '');
const toSym = (api) => api + '.P';

async function getJSON(url, exchange) {
  let res;
  try { res = await fetch(url, { credentials: 'omit', cache: 'no-store' }); }
  catch { throw new Error(`Could not reach ${exchange}: offline, or this network or country blocks it.`); }
  if (res.status === 451 || res.status === 403) throw new Error(`${exchange} refuses requests from this location (HTTP ${res.status}).`);
  if (!res.ok) throw new Error(`${exchange} returned HTTP ${res.status}`);
  return res.json();
}

function withTimeout(p, ms, what) {
  return Promise.race([p, new Promise((_, rej) => setTimeout(() => rej(new Error(`${what} did not answer within ${ms / 1000} s`)), ms))]);
}

/** Columnar Bars from rows of { time (s), open, high, low, close, volume }, oldest first. */
function toBars(rows) {
  const b = emptyBars(rows.length);
  rows.forEach((r, i) => { b.time[i] = r.time; b.open[i] = r.open; b.high[i] = r.high; b.low[i] = r.low; b.close[i] = r.close; b.volume[i] = r.volume; });
  return sliceBars(b, 0, rows.length);
}

/**
 * Live bar for a timeframe the exchange does not stream (e.g. 3M): stream the base interval and
 * fold the base bars of the current bucket together.
 */
function aggregatedBar(base, tf) {
  const byStart = new Map();
  return (bar) => {
    byStart.set(bar.time, bar);
    const q = bucketStart(bar.time, tf);
    const inQ = [...byStart.entries()].filter(([t]) => bucketStart(t, tf) === q).sort((a, b) => a[0] - b[0]).map((x) => x[1]);
    for (const t of [...byStart.keys()]) if (bucketStart(t, tf) < q) byStart.delete(t);
    return { time: q, open: inQ[0].open, high: Math.max(...inQ.map((x) => x.high)), low: Math.min(...inQ.map((x) => x.low)), close: inQ[inQ.length - 1].close, volume: inQ.reduce((a, x) => a + x.volume, 0) };
  };
}

// =============================================================================== Binance
const BN_REST = 'https://fapi.binance.com';
const BN_WS = 'wss://fstream.binance.com/ws';
const BN_TF = { '1m': '1m', '3m': '3m', '5m': '5m', '15m': '15m', '30m': '30m', '1h': '1h', '2h': '2h', '4h': '4h', '6h': '6h', '12h': '12h', '1D': '1d', '3D': '3d', '1W': '1w', '1M': '1M' };

/** exchangeInfo + 24h tickers -> contracts, most traded first. */
export function parseBinanceContracts(info, tickers) {
  const vol = new Map((tickers || []).map((t) => [t.symbol, +t.quoteVolume || 0]));
  return (info.symbols || [])
    .filter((s) => s.contractType === 'PERPETUAL' && s.status === 'TRADING' && s.quoteAsset === 'USDT')
    .map((s) => {
      const pf = (s.filters || []).find((f) => f.filterType === 'PRICE_FILTER');
      return { symbol: toSym(s.symbol), name: `${s.baseAsset} perpetual`, base: s.baseAsset, quote: s.quoteAsset, kind: 'perp', tick: pf ? +pf.tickSize : 0.01, _vol: vol.get(s.symbol) || 0 };
    })
    .sort((a, b) => b._vol - a._vol)
    .map(({ _vol, ...c }) => c);
}
/** /fapi/v1/klines rows -> bar rows */
export const parseBinanceKlines = (rows) => rows.map((r) => ({ time: r[0] / 1000, open: +r[1], high: +r[2], low: +r[3], close: +r[4], volume: +r[5] }));

export class BinanceAdapter {
  constructor() {
    this.id = 'binance';
    this.label = 'Binance futures (live)';
    this.short = 'Binance';
    this.note = 'Live public prices from Binance USD-M futures. No key. Not available in every country.';
    this.sockets = new Set();
    this._contracts = null;
  }

  contracts() {
    if (!this._contracts) {
      this._contracts = Promise.all([getJSON(`${BN_REST}/fapi/v1/exchangeInfo`, 'Binance'), getJSON(`${BN_REST}/fapi/v1/ticker/24hr`, 'Binance').catch(() => [])])
        .then(([info, tickers]) => parseBinanceContracts(info, tickers))
        .catch((err) => { this._contracts = null; throw err; });
    }
    return this._contracts;
  }

  async bars(symbol, tf, opts = {}) {
    const limit = Math.min(opts.limit ?? 1500, 1500);
    if (tf === '3M') return aggregate(await this.bars(symbol, '1M', { to: opts.to, limit: Math.min(1500, limit * 3) }), TF['3M']);
    const iv = BN_TF[tf];
    if (!iv) throw new Error(`Timeframe ${tf} is not offered by Binance`);
    let url = `${BN_REST}/fapi/v1/klines?symbol=${encodeURIComponent(toApi(symbol))}&interval=${iv}&limit=${limit}`;
    if (opts.to) url += `&endTime=${Math.floor(opts.to * 1000)}`;
    return toBars(parseBinanceKlines(await getJSON(url, 'Binance')));
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
    const s = toApi(symbol).toLowerCase();
    const k = (m) => ({ time: m.k.t / 1000, open: +m.k.o, high: +m.k.h, low: +m.k.l, close: +m.k.c, volume: +m.k.v });
    if (tf === '3M') { const fold = aggregatedBar('1M', TF['3M']); return this.socket(`${s}@kline_1M`, (m) => onBar(fold(k(m)))); }
    return this.socket(`${s}@kline_${BN_TF[tf]}`, (m) => onBar(k(m)));
  }

  subscribeTelemetry(symbol, onTele) {
    const s = toApi(symbol).toLowerCase();
    /** @type {any} */
    const t = { symbol, kind: 'perp', time: 0, last: NaN, mark: NaN, index: NaN, change24h: NaN, changePct24h: NaN, high24h: NaN, low24h: NaN, volume24h: NaN, turnover24h: NaN, openInterest: NaN, openInterestValue: NaN, fundingRate: NaN, nextFundingTime: NaN };
    const emit = () => { t.time = Date.now() / 1000; t.openInterestValue = t.openInterest * t.mark; onTele({ ...t }); };
    const stopMark = this.socket(`${s}@markPrice@1s`, (m) => { t.mark = +m.p; t.index = +m.i; t.fundingRate = +m.r; t.nextFundingTime = m.T / 1000; emit(); });
    const stopTicker = this.socket(`${s}@ticker`, (m) => { t.last = +m.c; t.change24h = +m.p; t.changePct24h = +m.P; t.high24h = +m.h; t.low24h = +m.l; t.volume24h = +m.v; t.turnover24h = +m.q; emit(); });
    return () => { stopMark(); stopTicker(); };
  }

  dispose() { for (const ws of this.sockets) ws.close(); this.sockets.clear(); }
}

// =============================================================================== Bybit (v5)
const BY_REST = 'https://api.bybit.com';
const BY_WS = 'wss://stream.bybit.com/v5/public/linear';
const BY_TF = { '1m': '1', '3m': '3', '5m': '5', '15m': '15', '30m': '30', '1h': '60', '2h': '120', '4h': '240', '6h': '360', '12h': '720', '1D': 'D', '1W': 'W', '1M': 'M' };
const BY_BASE = { '3D': '1D', '3M': '1M' }; // not offered by Bybit: built from these

export function parseBybitContracts(instruments, tickers) {
  const vol = new Map(((tickers && tickers.result && tickers.result.list) || []).map((t) => [t.symbol, +t.turnover24h || 0]));
  return ((instruments.result && instruments.result.list) || [])
    .filter((s) => s.contractType === 'LinearPerpetual' && s.status === 'Trading' && s.quoteCoin === 'USDT')
    .map((s) => ({ symbol: toSym(s.symbol), name: `${s.baseCoin} perpetual`, base: s.baseCoin, quote: s.quoteCoin, kind: 'perp', tick: +(s.priceFilter && s.priceFilter.tickSize) || 0.01, _vol: vol.get(s.symbol) || 0 }))
    .sort((a, b) => b._vol - a._vol)
    .map(({ _vol, ...c }) => c);
}
/** /v5/market/kline list (newest first) -> bar rows, oldest first */
export const parseBybitKlines = (json) => ((json.result && json.result.list) || []).map((r) => ({ time: +r[0] / 1000, open: +r[1], high: +r[2], low: +r[3], close: +r[4], volume: +r[5] })).reverse();
/** Fold a tickers snapshot or delta into the running telemetry object. */
export function mergeBybitTicker(t, d) {
  const num = (k) => (d[k] !== undefined && d[k] !== '' ? +d[k] : undefined);
  const set = (key, v) => { if (v !== undefined && Number.isFinite(v)) t[key] = v; };
  set('last', num('lastPrice')); set('mark', num('markPrice')); set('index', num('indexPrice'));
  set('high24h', num('highPrice24h')); set('low24h', num('lowPrice24h')); set('volume24h', num('volume24h')); set('turnover24h', num('turnover24h'));
  set('openInterest', num('openInterest')); set('fundingRate', num('fundingRate'));
  if (num('nextFundingTime') !== undefined) t.nextFundingTime = num('nextFundingTime') / 1000;
  if (num('price24hPcnt') !== undefined) t.changePct24h = num('price24hPcnt') * 100;
  if (num('prevPrice24h') !== undefined) t.prev24h = num('prevPrice24h');
  if (Number.isFinite(t.prev24h) && Number.isFinite(t.last)) t.change24h = t.last - t.prev24h;
  return t;
}

/** One multiplexed Bybit socket: topic subscriptions, 20 s pings, reconnect + resubscribe. */
class BybitSocket {
  constructor(sockets) {
    this.handlers = new Map(); // topic -> Set<fn>
    this.sockets = sockets;
    this.ws = null; this.retry = 0; this.timer = 0; this.ping = 0;
  }
  ensure() {
    if (this.ws) return;
    const ws = new WebSocket(BY_WS);
    this.ws = ws; this.sockets.add(ws);
    ws.onopen = () => {
      this.retry = 0;
      const topics = [...this.handlers.keys()];
      for (let i = 0; i < topics.length; i += 10) ws.send(JSON.stringify({ op: 'subscribe', args: topics.slice(i, i + 10) }));
      this.ping = setInterval(() => { try { ws.send('{"op":"ping"}'); } catch { /* closing */ } }, 20000);
    };
    ws.onmessage = (e) => {
      let m; try { m = JSON.parse(e.data); } catch { return; }
      if (!m.topic) return;
      const hs = this.handlers.get(m.topic);
      if (hs) for (const f of hs) { try { f(m); } catch (err) { console.error(err); } }
    };
    ws.onclose = () => {
      clearInterval(this.ping); this.sockets.delete(ws); this.ws = null;
      if (this.handlers.size) this.timer = setTimeout(() => this.ensure(), Math.min(30000, 1000 * 2 ** this.retry++));
    };
  }
  sub(topic, fn) {
    let hs = this.handlers.get(topic);
    const fresh = !hs;
    if (!hs) { hs = new Set(); this.handlers.set(topic, hs); }
    hs.add(fn);
    this.ensure();
    if (fresh && this.ws && this.ws.readyState === 1) this.ws.send(JSON.stringify({ op: 'subscribe', args: [topic] }));
    return () => {
      hs.delete(fn);
      if (hs.size) return;
      this.handlers.delete(topic);
      if (this.ws && this.ws.readyState === 1) this.ws.send(JSON.stringify({ op: 'unsubscribe', args: [topic] }));
      if (!this.handlers.size && this.ws) { clearTimeout(this.timer); this.ws.close(); }
    };
  }
}

export class BybitAdapter {
  constructor() {
    this.id = 'bybit';
    this.label = 'Bybit futures (live)';
    this.short = 'Bybit';
    this.note = 'Live public prices from Bybit linear perpetuals. No key. Not available in every country.';
    this.sockets = new Set();
    this.ws = new BybitSocket(this.sockets);
    this._contracts = null;
  }

  contracts() {
    if (!this._contracts) {
      this._contracts = Promise.all([getJSON(`${BY_REST}/v5/market/instruments-info?category=linear&limit=1000`, 'Bybit'), getJSON(`${BY_REST}/v5/market/tickers?category=linear`, 'Bybit').catch(() => null)])
        .then(([inst, tick]) => {
          if (inst.retCode !== 0 && inst.retCode !== undefined) throw new Error(`Bybit: ${inst.retMsg || 'error ' + inst.retCode}`);
          return parseBybitContracts(inst, tick);
        })
        .catch((err) => { this._contracts = null; throw err; });
    }
    return this._contracts;
  }

  async bars(symbol, tf, opts = {}) {
    if (BY_BASE[tf]) {
      const base = await this.bars(symbol, BY_BASE[tf], { to: opts.to, limit: Math.min(1000, (opts.limit ?? 1000) * 3) });
      return aggregate(base, TF[tf]);
    }
    const iv = BY_TF[tf];
    if (!iv) throw new Error(`Timeframe ${tf} is not offered by Bybit`);
    const limit = Math.min(opts.limit ?? 1000, 1000);
    let url = `${BY_REST}/v5/market/kline?category=linear&symbol=${encodeURIComponent(toApi(symbol))}&interval=${iv}&limit=${limit}`;
    if (opts.to) url += `&end=${Math.floor(opts.to * 1000)}`;
    const json = await getJSON(url, 'Bybit');
    if (json.retCode) throw new Error(`Bybit: ${json.retMsg || 'error ' + json.retCode}`);
    return toBars(parseBybitKlines(json));
  }

  subscribeBars(symbol, tf, onBar) {
    const api = toApi(symbol);
    const base = BY_BASE[tf] || tf;
    const fold = BY_BASE[tf] ? aggregatedBar(base, TF[tf]) : null;
    if (fold && BY_BASE[tf]) {
      // seed the forming bucket with the base bars already closed inside it
      this.bars(symbol, base, { limit: 100 }).then((b) => {
        for (let i = 0; i < b.length; i++) if (bucketStart(b.time[i], TF[tf]) === bucketStart(Date.now() / 1000, TF[tf])) fold({ time: b.time[i], open: b.open[i], high: b.high[i], low: b.low[i], close: b.close[i], volume: b.volume[i] });
      }).catch(() => {});
    }
    return this.ws.sub(`kline.${BY_TF[base]}.${api}`, (m) => {
      for (const k of m.data || []) {
        const bar = { time: +k.start / 1000, open: +k.open, high: +k.high, low: +k.low, close: +k.close, volume: +k.volume };
        onBar(fold ? fold(bar) : bar);
      }
    });
  }

  subscribeTelemetry(symbol, onTele) {
    /** @type {any} */
    const t = { symbol, kind: 'perp', time: 0, last: NaN, mark: NaN, index: NaN, change24h: NaN, changePct24h: NaN, high24h: NaN, low24h: NaN, volume24h: NaN, turnover24h: NaN, openInterest: NaN, openInterestValue: NaN, fundingRate: NaN, nextFundingTime: NaN };
    return this.ws.sub(`tickers.${toApi(symbol)}`, (m) => {
      mergeBybitTicker(t, m.data || {});
      t.time = Date.now() / 1000; t.openInterestValue = t.openInterest * t.mark;
      onTele({ ...t });
    });
  }

  dispose() { for (const ws of this.sockets) ws.close(); this.sockets.clear(); }
}

// =============================================================================== automatic choice
/**
 * Live data from the first exchange that answers; the synthetic market if none does.
 * The choice is made once per page load (on the first contracts() call) and then every call
 * goes to the chosen adapter. `source` and `fallbackReason` say what happened.
 */
export class AutoLiveAdapter {
  /** @param {any[]} [chain] adapters to try in order (tests pass fakes) @param {any} [fallback] */
  constructor(chain, fallback) {
    this.id = 'live';
    this.chain = chain || [new BinanceAdapter(), new BybitAdapter()];
    this.fallbackAdapter = fallback || null;
    this.chosen = null;
    this.fallbackReason = '';
    this._pick = null;
  }

  get label() { return this.chosen ? (this.chosen.id === 'synthetic' ? 'Synthetic market (live feeds unreachable)' : `Live · ${this.chosen.short}`) : 'Live (auto)'; }
  get short() { return this.chosen ? (this.chosen.id === 'synthetic' ? 'Synthetic' : this.chosen.short) : 'Live'; }
  get source() { return this.chosen ? this.chosen.id : null; }

  pick() {
    if (!this._pick) {
      this._pick = (async () => {
        const reasons = [];
        for (const a of this.chain) {
          try {
            const list = await withTimeout(a.contracts(), 10000, a.short || a.id);
            if (list && list.length) { this.chosen = a; return list; }
            reasons.push(`${a.short || a.id}: no contracts`);
          } catch (err) { reasons.push(String(err.message || err)); }
        }
        this.fallbackReason = reasons.join(' ');
        this.chosen = this.fallbackAdapter || (this.fallbackAdapter = new SyntheticAdapter());
        return this.chosen.contracts();
      })();
    }
    return this._pick;
  }

  contracts() { return this.pick(); }
  async bars(symbol, tf, opts) { await this.pick(); return this.chosen.bars(symbol, tf, opts); }
  subscribeBars(symbol, tf, onBar) { return this.whenChosen((a) => a.subscribeBars(symbol, tf, onBar)); }
  subscribeTelemetry(symbol, onTele) { return this.whenChosen((a) => a.subscribeTelemetry(symbol, onTele)); }
  /** Subscribe on the chosen adapter, even if the choice is still being made. */
  whenChosen(fn) {
    if (this.chosen) return fn(this.chosen);
    let unsub = null, cancelled = false;
    this.pick().then(() => { if (!cancelled) unsub = fn(this.chosen); }).catch(() => {});
    return () => { cancelled = true; if (unsub) unsub(); };
  }
  dispose() { for (const a of this.chain) a.dispose(); if (this.fallbackAdapter) this.fallbackAdapter.dispose(); }
}
