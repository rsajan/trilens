// Deterministic synthetic futures market. Runs inside data.worker.js, never on the main thread.
//
// How the prices are built, so every timeframe agrees with every other one:
//  1. A daily process (one step per UTC day) sets each day's open and close: trending regimes,
//     weak mean reversion to the contract's reference price, clustered volatility, fat tails.
//  2. Each day's 1,440 one-minute bars are a Brownian bridge from that day's open to its close,
//     with US/EU session volatility humps and occasional jumps. The bridge is seeded by
//     (symbol, day), so a day is reproduced exactly whenever it is needed, then dropped.
//  3. Every other timeframe is an aggregate of those minutes (intraday) or of the days (1D+).
//  4. The forming minute is revealed tick by tick (4 per second) along a path that hits the
//     minute's high and low at seeded moments and ends exactly on its close, so the live bar
//     becomes the same bar you see after a reload.
//
// Same inputs -> same market, on every device. Nothing here is real market data.

import { TF, DAY, bucketStart, emptyBars, sliceBars } from './timeframes.js';

const HISTORY_DAYS = 365 * 5;
const FUTURE_DAYS = 60; // generated ahead so a long session can cross midnight
const MIN = 1440;

/**
 * @typedef {Object} ContractSpec
 * @property {string} symbol @property {string} name @property {string} base @property {string} quote
 * @property {'perp'|'dated'} kind @property {number} tick @property {number} ref reference price
 * @property {number} annVol annualised volatility @property {number} vol0 mean volume per minute (contracts)
 * @property {number} oi0 mean open interest (contracts) @property {number=} expiryRule  quarter-end Friday
 */

/** @type {ContractSpec[]} */
export const CONTRACTS = [
  { symbol: 'BTCUSDT.P', name: 'Bitcoin perpetual', base: 'BTC', quote: 'USDT', kind: 'perp', tick: 0.1, ref: 92000, annVol: 0.55, vol0: 140, oi0: 82000 },
  { symbol: 'ETHUSDT.P', name: 'Ether perpetual', base: 'ETH', quote: 'USDT', kind: 'perp', tick: 0.01, ref: 3200, annVol: 0.7, vol0: 2600, oi0: 1900000 },
  { symbol: 'SOLUSDT.P', name: 'Solana perpetual', base: 'SOL', quote: 'USDT', kind: 'perp', tick: 0.001, ref: 160, annVol: 0.9, vol0: 14000, oi0: 9500000 },
  { symbol: 'BNBUSDT.P', name: 'BNB perpetual', base: 'BNB', quote: 'USDT', kind: 'perp', tick: 0.01, ref: 640, annVol: 0.5, vol0: 900, oi0: 720000 },
  { symbol: 'XAUUSDT.P', name: 'Gold perpetual', base: 'XAU', quote: 'USDT', kind: 'perp', tick: 0.01, ref: 2650, annVol: 0.16, vol0: 420, oi0: 260000 },
  { symbol: 'BTCUSDT.Q', name: 'Bitcoin quarterly future', base: 'BTC', quote: 'USDT', kind: 'dated', tick: 0.1, ref: 92000, annVol: 0.55, vol0: 30, oi0: 21000 },
];
const SPEC = Object.fromEntries(CONTRACTS.map((c) => [c.symbol, c]));

// ---------- deterministic randomness ----------
function hashStr(s) {
  let h = 2166136261 >>> 0;
  for (let i = 0; i < s.length; i++) { h ^= s.charCodeAt(i); h = Math.imul(h, 16777619); }
  return h >>> 0;
}
/** mulberry32: one 32-bit state word, fast in V8/SpiderMonkey, plenty for market noise */
function seeded(...parts) {
  let a = hashStr(parts.join('|'));
  return () => {
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}
// Standard normal via an inverse-CDF lookup table (Acklam's approximation, built once).
// About 5x faster than Box-Muller, which matters: five years of minutes is ~10M draws.
// The table stops near ±3.8σ; the explicit jump process supplies the fat tails.
const NT = 8192;
const NORMAL = (() => {
  const a = [-39.69683028665376, 220.9460984245205, -275.9285104469687, 138.357751867269, -30.66479806614716, 2.506628277459239];
  const b = [-54.47609879822406, 161.5858368580409, -155.6989798598866, 66.80131188771972, -13.28068155288572];
  const c = [-0.007784894002430293, -0.3223964580411365, -2.400758277161838, -2.549732539343734, 4.374664141464968, 2.938163982698783];
  const d = [0.007784695709041462, 0.3224671290700398, 2.445134137142996, 3.754408661907416];
  const inv = (p) => {
    if (p < 0.02425) { const q = Math.sqrt(-2 * Math.log(p)); return (((((c[0] * q + c[1]) * q + c[2]) * q + c[3]) * q + c[4]) * q + c[5]) / ((((d[0] * q + d[1]) * q + d[2]) * q + d[3]) * q + 1); }
    if (p > 1 - 0.02425) { const q = Math.sqrt(-2 * Math.log(1 - p)); return -(((((c[0] * q + c[1]) * q + c[2]) * q + c[3]) * q + c[4]) * q + c[5]) / ((((d[0] * q + d[1]) * q + d[2]) * q + d[3]) * q + 1); }
    const q = p - 0.5, r = q * q;
    return (((((a[0] * r + a[1]) * r + a[2]) * r + a[3]) * r + a[4]) * r + a[5]) * q / (((((b[0] * r + b[1]) * r + b[2]) * r + b[3]) * r + b[4]) * r + 1);
  };
  const t = new Float64Array(NT);
  for (let i = 0; i < NT; i++) t[i] = inv((i + 0.5) / NT);
  return t;
})();
const gauss = (r) => NORMAL[(r() * NT) | 0];
const LOGN = NORMAL.map((z) => Math.exp(0.35 * z)); // lognormal volume noise
/** cheap stateless hash -> [0,1) for tick noise */
function hash01(x, y) {
  let h = Math.imul(x | 0, 374761393) + Math.imul(y | 0, 668265263);
  h = Math.imul(h ^ (h >>> 13), 1274126177);
  return ((h ^ (h >>> 16)) >>> 0) / 4294967296;
}

// Intraday volatility profile: quiet Asia night, EU open hump (07:00-09:00 UTC), US open hump (13:30-16:00).
const SEASON = (() => {
  const w = new Float64Array(MIN);
  let s = 0;
  for (let m = 0; m < MIN; m++) {
    const v = 0.65 + 0.55 * Math.exp(-(((m - 480) / 80) ** 2)) + 0.95 * Math.exp(-(((m - 830) / 95) ** 2)) + 0.25 * Math.exp(-(((m - 0) / 60) ** 2));
    w[m] = v; s += v;
  }
  for (let m = 0; m < MIN; m++) w[m] *= MIN / s;
  return w;
})();
const WORK = { W: new Float64Array(MIN), T: new Float64Array(MIN), sd: new Float64Array(MIN) };
const SCRATCH = { o: new Float64Array(MIN), h: new Float64Array(MIN), l: new Float64Array(MIN), c: new Float64Array(MIN), v: new Float64Array(MIN) };
const SQRT_SEASON = SEASON.map((x) => Math.sqrt(x / MIN));

class SymbolModel {
  /** @param {ContractSpec} spec @param {number} nowSec */
  constructor(spec, nowSec) {
    this.spec = spec;
    // the quarterly contract shares its perpetual's underlying path; only its premium differs
    this.seed = spec.symbol.replace(/\.(P|Q)$/, '');
    this.firstDay = Math.floor(nowSec / DAY) - HISTORY_DAYS;
    const N = HISTORY_DAYS + FUTURE_DAYS + 1;
    this.dOpen = new Float64Array(N);
    this.dClose = new Float64Array(N);
    this.dVol = new Float64Array(N);
    this.dHigh = new Float64Array(N).fill(NaN); // filled lazily from minute paths
    this.dLow = new Float64Array(N).fill(NaN);
    this.dVolume = new Float64Array(N).fill(NaN);
    this.minuteCache = new Map(); // day -> { o,h,l,c,v } Float64Array(1440) each, LRU
    this.genDaily();
  }

  genDaily() {
    const s = this.spec;
    // dated contract shares the perp's daily path (same underlying) plus a premium, see priceFactor()
    const r = seeded(this.seed, 'daily', this.firstDay);
    const sigma = s.annVol / Math.sqrt(365);
    const lref = Math.log(s.ref);
    let lp = lref + gauss(r) * 0.25;
    let lv = 0, mu = 0;
    for (let k = 0; k < this.dOpen.length; k++) {
      lv = 0.965 * lv + 0.26 * Math.sqrt(1 - 0.965 ** 2) * gauss(r) * 2.2;
      mu = 0.992 * mu + 0.0016 * gauss(r);
      const vm = Math.exp(Math.max(-1.2, Math.min(1.6, lv)));
      const sd = sigma * vm;
      const tail = r() < 0.035 ? 2.6 : 1;
      const ret = mu * sigma * 2 - 0.0025 * (lp - lref) + sd * gauss(r) * tail;
      this.dVol[k] = vm;
      this.dOpen[k] = Math.exp(lp);
      lp += ret;
      this.dClose[k] = Math.exp(lp);
    }
  }

  /** extra multiplicative premium for the dated contract (contango that decays into expiry) */
  priceFactor(t) {
    if (this.spec.kind !== 'dated') return 1;
    const exp = quarterlyExpiry(t);
    const days = Math.max(0, (exp - t) / DAY);
    return 1 + 0.085 * days / 365; // ~8.5% annualised basis
  }

  idx(day) {
    const k = day - this.firstDay;
    if (k < 0 || k >= this.dOpen.length) return -1;
    return k;
  }

  /**
   * One day of minute bars. Cached (LRU 48 days, ~2.7 MB). With `scratch`, writes into shared
   * buffers instead and skips the cache: used when only the day's high/low/volume are needed.
   */
  minutes(day, scratch = false) {
    const hit = this.minuteCache.get(day);
    if (hit) { this.minuteCache.delete(day); this.minuteCache.set(day, hit); return hit; }
    const k = this.idx(day);
    if (k < 0) return null;
    const s = this.spec;
    const r = seeded(this.seed, 'day', day);
    const sigD = (s.annVol / Math.sqrt(365)) * this.dVol[k];
    const buf = scratch ? SCRATCH : null;
    const o = buf ? buf.o : new Float64Array(MIN), h = buf ? buf.h : new Float64Array(MIN), l = buf ? buf.l : new Float64Array(MIN), c = buf ? buf.c : new Float64Array(MIN), v = buf ? buf.v : new Float64Array(MIN);
    // random walk W with seasonal minute volatility, plus rare jumps
    const W = WORK.W, T = WORK.T, sd = WORK.sd;
    let w = 0, tt = 0;
    for (let m = 0; m < MIN; m++) {
      const sdm = sigD * SQRT_SEASON[m];
      sd[m] = sdm;
      let step = sdm * gauss(r);
      if (r() < 0.0012) step += sdm * (4 + 5 * r()) * (r() < 0.5 ? -1 : 1);
      w += step; tt += sdm * sdm;
      W[m] = w; T[m] = tt;
    }
    const D = Math.log(this.dClose[k] / this.dOpen[k]);
    const open0 = this.dOpen[k];
    const inv = Math.round(1 / s.tick);
    const round = (x) => Math.round(x * inv) / inv;
    const volBase = s.vol0 * this.dVol[k];
    const drift = (w - D) / tt;
    let prev = round(open0);
    for (let m = 0; m < MIN; m++) {
      const cl = m === MIN - 1 ? round(this.dClose[k]) : round(open0 * Math.exp(W[m] - T[m] * drift));
      const op = prev;
      const sdm = sd[m];
      // wick sizes and volume noise: |N| * 0.55 sd is < 1%, so 1+x stands in for exp(x)
      const up = Math.abs(gauss(r)) * sdm * 0.55, dn = Math.abs(gauss(r)) * sdm * 0.55;
      const hi = op > cl ? op : cl, lo = op < cl ? op : cl;
      o[m] = op; c[m] = cl;
      h[m] = round(hi * (1 + up));
      l[m] = round(lo * (1 - dn));
      const move = Math.abs(cl - op) / (op * sdm);
      v[m] = Math.max(1, Math.round(volBase * SEASON[m] * (0.55 + 0.6 * move) * LOGN[(r() * NT) | 0]));
      prev = cl;
    }
    const out = { o, h, l, c, v };
    if (!scratch) {
      this.minuteCache.set(day, out);
      if (this.minuteCache.size > 48) this.minuteCache.delete(this.minuteCache.keys().next().value);
    }
    // fill the daily high/low/volume while we have the path
    let hh = -Infinity, ll = Infinity, vv = 0;
    for (let m = 0; m < MIN; m++) { if (h[m] > hh) hh = h[m]; if (l[m] < ll) ll = l[m]; vv += v[m]; }
    this.dHigh[k] = hh; this.dLow[k] = ll; this.dVolume[k] = vv;
    return out;
  }

  /** Daily high/low/volume for every past day (generates each day once; ~100 ms for 5 years). */
  ensureDailyStats(uptoDay) {
    for (let d = this.firstDay; d <= uptoDay; d++) {
      const k = this.idx(d);
      if (Number.isNaN(this.dHigh[k])) this.minutes(d, true);
    }
  }

  /** The live price inside the forming minute, at time t (seconds, fractional). */
  tickPrice(t) {
    const day = Math.floor(t / DAY);
    const mins = this.minutes(day);
    const m = Math.floor((t - day * DAY) / 60);
    const f = (t - day * DAY - m * 60) / 60;
    const o = mins.o[m], h = mins.h[m], l = mins.l[m], c = mins.c[m];
    const a1 = 0.12 + 0.3 * hash01(day * MIN + m, 11), a2 = 0.55 + 0.33 * hash01(day * MIN + m, 12);
    const highFirst = hash01(day * MIN + m, 13) < 0.5;
    const p1 = highFirst ? h : l, p2 = highFirst ? l : h;
    let base, seg, segLen;
    if (f < a1) { seg = f / a1; base = o + (p1 - o) * seg; segLen = a1; }
    else if (f < a2) { seg = (f - a1) / (a2 - a1); base = p1 + (p2 - p1) * seg; segLen = a2 - a1; }
    else { seg = (f - a2) / (1 - a2); base = p2 + (c - p2) * seg; segLen = 1 - a2; }
    const step = Math.floor(f * 240);
    const noise = (hash01(day * MIN + m, 100 + step) - 0.5) * (h - l) * 0.35 * Math.sin(Math.PI * seg) * Math.min(1, segLen * 4);
    const p = Math.min(h, Math.max(l, base + noise));
    const inv = Math.round(1 / this.spec.tick);
    return Math.round(p * inv) / inv;
  }

  /** The forming minute at time t: open, running high/low, live close, partial volume. */
  formingMinute(t) {
    const day = Math.floor(t / DAY);
    const mins = this.minutes(day);
    const m = Math.floor((t - day * DAY) / 60);
    const start = day * DAY + m * 60;
    const steps = Math.floor((t - start) * 4);
    let hi = mins.o[m], lo = mins.o[m];
    for (let k = 0; k <= steps; k++) {
      const p = this.tickPrice(start + k / 4);
      if (p > hi) hi = p; if (p < lo) lo = p;
    }
    const last = this.tickPrice(t);
    const f = (t - start) / 60;
    return { time: start, open: mins.o[m], high: Math.max(hi, last), low: Math.min(lo, last), close: last, volume: Math.round(mins.v[m] * f) };
  }
}

/** Last Friday of the quarter's last month, 08:00 UTC (the common crypto quarterly expiry). */
export function quarterlyExpiry(t) {
  const d = new Date(t * 1000);
  let y = d.getUTCFullYear(), q = Math.floor(d.getUTCMonth() / 3);
  for (let i = 0; i < 3; i++) {
    const lastMonth = q * 3 + 2;
    const end = new Date(Date.UTC(y, lastMonth + 1, 0, 8));
    while (end.getUTCDay() !== 5) end.setUTCDate(end.getUTCDate() - 1);
    const e = end.getTime() / 1000;
    if (e > t) return e;
    q++; if (q > 3) { q = 0; y++; }
  }
  return t + 90 * DAY;
}

export class SyntheticMarket {
  constructor(now = () => Date.now() / 1000) {
    this.now = now;
    /** @type {Map<string, SymbolModel>} */
    this.models = new Map();
  }

  contracts() { return CONTRACTS; }

  model(symbol) {
    let m = this.models.get(symbol);
    if (!m) {
      const spec = SPEC[symbol];
      if (!spec) throw new Error(`Unknown contract ${symbol}`);
      m = new SymbolModel(spec, this.now());
      this.models.set(symbol, m);
    }
    return m;
  }

  /**
   * Bars ending at `to` (default: now, including the forming bar).
   * @param {string} symbol @param {string} tfId @param {{ to?: number, limit?: number }} opts
   */
  bars(symbol, tfId, opts = {}) {
    const tf = TF[tfId];
    if (!tf) throw new Error(`Unknown timeframe ${tfId}`);
    const m = this.model(symbol);
    const now = this.now();
    const to = Math.min(opts.to ?? now, now);
    const limit = Math.max(1, Math.min(opts.limit ?? 1500, 5000));
    const pf = (t) => m.priceFactor(t);
    const inv = Math.round(1 / m.spec.tick);
    const rnd = (x) => Math.round(x * inv) / inv;

    if (tf.calendar) {
      const lastDay = Math.floor(to / DAY);
      m.ensureDailyStats(lastDay - 1);
      const out = emptyBars(HISTORY_DAYS + 2);
      let k = -1, cur = -Infinity;
      for (let d = m.firstDay; d <= lastDay; d++) {
        const i = m.idx(d);
        let o = m.dOpen[i], h = m.dHigh[i], l = m.dLow[i], c = m.dClose[i], v = m.dVolume[i];
        if (d === lastDay) {
          const part = this.partialDay(m, d, to);
          if (!part) continue;
          ({ open: o, high: h, low: l, close: c, volume: v } = part);
        }
        const f = pf(d * DAY);
        o = rnd(o * f); h = rnd(h * f); l = rnd(l * f); c = rnd(c * f);
        const b = bucketStart(d * DAY, tf);
        if (b !== cur) { k++; cur = b; out.time[k] = b; out.open[k] = o; out.high[k] = h; out.low[k] = l; out.close[k] = c; out.volume[k] = v; }
        else { if (h > out.high[k]) out.high[k] = h; if (l < out.low[k]) out.low[k] = l; out.close[k] = c; out.volume[k] += v; }
      }
      const n = k + 1;
      return sliceBars(out, Math.max(0, n - limit), n);
    }

    // intraday: walk back from `to` day by day until we have `limit` bars
    const endBucket = bucketStart(to, tf);
    const startT = Math.max(m.firstDay * DAY, endBucket - (limit - 1) * tf.sec);
    const nOut = Math.floor((endBucket - startT) / tf.sec) + 1;
    const out = emptyBars(nOut);
    let k = -1, cur = -Infinity;
    const lastMinuteStart = Math.floor(to / 60) * 60;
    for (let day = Math.floor(startT / DAY); day <= Math.floor(to / DAY); day++) {
      const mins = m.minutes(day);
      const f = pf(day * DAY);
      for (let mi = 0; mi < MIN; mi++) {
        const t = day * DAY + mi * 60;
        if (t < startT) continue;
        if (t > lastMinuteStart) break;
        let o = mins.o[mi], h = mins.h[mi], l = mins.l[mi], c = mins.c[mi], v = mins.v[mi];
        if (t === lastMinuteStart) ({ open: o, high: h, low: l, close: c, volume: v } = m.formingMinute(to));
        o = rnd(o * f); h = rnd(h * f); l = rnd(l * f); c = rnd(c * f);
        const b = Math.floor(t / tf.sec) * tf.sec;
        if (b !== cur) { k++; cur = b; out.time[k] = b; out.open[k] = o; out.high[k] = h; out.low[k] = l; out.close[k] = c; out.volume[k] = v; }
        else { if (h > out.high[k]) out.high[k] = h; if (l < out.low[k]) out.low[k] = l; out.close[k] = c; out.volume[k] += v; }
      }
    }
    return sliceBars(out, 0, k + 1);
  }

  partialDay(m, day, to) {
    const mins = m.minutes(day);
    const last = Math.floor((to - day * DAY) / 60);
    if (last < 0) return null;
    let h = -Infinity, l = Infinity, v = 0;
    for (let mi = 0; mi < last; mi++) { if (mins.h[mi] > h) h = mins.h[mi]; if (mins.l[mi] < l) l = mins.l[mi]; v += mins.v[mi]; }
    const fm = m.formingMinute(to);
    return { open: mins.o[0], high: Math.max(h, fm.high), low: Math.min(l, fm.low), close: fm.close, volume: v + fm.volume };
  }

  /** The bar of timeframe tf that contains `t`, as it stands at time t. */
  currentBar(symbol, tfId, t = this.now()) {
    const b = this.bars(symbol, tfId, { to: t, limit: 1 });
    return { time: b.time[0], open: b.open[0], high: b.high[0], low: b.low[0], close: b.close[0], volume: b.volume[0] };
  }

  /** Futures telemetry: last / mark / index, 24h stats, open interest, funding or basis. */
  telemetry(symbol, t = this.now()) {
    const m = this.model(symbol);
    const spec = m.spec;
    const inv = Math.round(1 / spec.tick);
    const rnd = (x) => Math.round(x * inv) / inv;
    const pf = m.priceFactor(t);
    const last = rnd(m.tickPrice(t) * pf);

    // 24h window from minute bars (today + yesterday are cached)
    const from = t - DAY;
    let hi = -Infinity, lo = Infinity, vol = 0, open24 = NaN;
    for (let day = Math.floor(from / DAY); day <= Math.floor(t / DAY); day++) {
      const mins = m.minutes(day);
      for (let mi = 0; mi < MIN; mi++) {
        const ts = day * DAY + mi * 60;
        if (ts < from - 59 || ts >= Math.floor(t / 60) * 60) continue;
        if (Number.isNaN(open24)) open24 = mins.o[mi];
        if (mins.h[mi] > hi) hi = mins.h[mi];
        if (mins.l[mi] < lo) lo = mins.l[mi];
        vol += mins.v[mi];
      }
    }
    const fm = m.formingMinute(t);
    hi = Math.max(hi, fm.high) * pf; lo = Math.min(lo, fm.low) * pf; vol += fm.volume; open24 *= pf;

    // basis between the contract and its spot index: slow + fast deterministic waves (±~0.06%)
    const ph = hashStr(spec.symbol) % 1000;
    const slow = 0.00032 * Math.sin(2 * Math.PI * (t / 21600) + ph) + 0.00018 * Math.sin(2 * Math.PI * (t / 5400) + ph * 0.7);
    const fast = 0.00012 * Math.sin(2 * Math.PI * (t / 47) + ph) + 0.00006 * Math.sin(2 * Math.PI * (t / 13) + ph * 1.3);
    const premium = spec.kind === 'perp' ? slow : pf - 1;
    const index = rnd(last / (1 + premium + fast));
    const mark = rnd(index * (1 + premium));

    const oiWave = 1 + 0.08 * Math.sin(2 * Math.PI * (t / (DAY * 3.3)) + ph) + 0.03 * Math.sin(2 * Math.PI * (t / 7200) + ph);
    const oi = Math.round(spec.oi0 * oiWave * m.dVol[Math.max(0, m.idx(Math.floor(t / DAY)))] ** 0.3);

    /** @type {any} */
    const out = {
      symbol, kind: spec.kind, time: t, last, mark, index,
      change24h: last - open24, changePct24h: (last / open24 - 1) * 100,
      high24h: rnd(hi), low24h: rnd(lo), volume24h: vol, turnover24h: vol * last,
      openInterest: oi, openInterestValue: oi * mark,
    };
    if (spec.kind === 'perp') {
      // Binance-style: F = P + clamp(I - P, -0.05%, 0.05%), I = 0.01% per 8h; capped at ±0.75%
      const I = 0.0001;
      const f = premium + Math.max(-0.0005, Math.min(0.0005, I - premium));
      out.fundingRate = Math.max(-0.0075, Math.min(0.0075, f));
      out.nextFundingTime = (Math.floor(t / 28800) + 1) * 28800;
      out.fundingIntervalHours = 8;
    } else {
      out.expiryTime = quarterlyExpiry(t);
      out.basis = mark - index;
      out.basisPct = (mark / index - 1) * 100;
      const days = Math.max(1 / 24, (out.expiryTime - t) / DAY);
      out.basisAnnualPct = out.basisPct * 365 / days;
    }
    return out;
  }
}
