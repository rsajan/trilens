// Incremental technical-analysis primitives. Each Pine call site (e.g. one `ta.ema(close, 20)`)
// owns one state object and is fed one value per bar, so a full run is O(bars × length) at worst
// and O(bars) for the recursive averages. NaN is Pine's `na`.
//
// Formulas follow TradingView's published Pine reference (ta.rma seeds with an SMA, ta.stdev is the
// population deviation, ta.rsi uses RMA of gains/losses, ta.vwap resets at each UTC day).

const isNa = (x) => x === null || x === undefined || (typeof x === 'number' && Number.isNaN(x));
export { isNa };

/** Fixed-length window of the last `len` values. */
export class Window {
  constructor(len) { this.len = Math.max(1, len | 0); this.buf = new Float64Array(this.len); this.n = 0; this.head = 0; }
  push(v) { this.buf[this.head] = v; this.head = (this.head + 1) % this.len; if (this.n < this.len) this.n++; }
  full() { return this.n === this.len; }
  /** k = 0 is the newest value */
  get(k) { if (k >= this.n) return NaN; return this.buf[(this.head - 1 - k + this.len * 2) % this.len]; }
}

export class Sma {
  constructor(len) { this.w = new Window(len); this.sum = 0; this.nan = 0; }
  next(v) {
    const w = this.w;
    if (w.full()) { const old = w.get(w.len - 1); if (Number.isNaN(old)) this.nan--; else this.sum -= old; }
    w.push(v);
    if (Number.isNaN(v)) this.nan++; else this.sum += v;
    return w.full() && this.nan === 0 ? this.sum / w.len : NaN;
  }
}

/** Exponential average with SMA seed. alpha = 2/(len+1) for EMA, 1/len for RMA. */
export class Ema {
  constructor(len, alpha) { this.len = Math.max(1, len | 0); this.alpha = alpha ?? 2 / (this.len + 1); this.prev = NaN; this.seed = new Sma(this.len); }
  next(v) {
    if (Number.isNaN(this.prev)) {
      if (Number.isNaN(v)) return NaN;
      const s = this.seed.next(v);
      if (!Number.isNaN(s)) this.prev = s;
      return s;
    }
    if (Number.isNaN(v)) return this.prev;
    this.prev = this.alpha * v + (1 - this.alpha) * this.prev;
    return this.prev;
  }
}
export const rma = (len) => new Ema(len, 1 / Math.max(1, len | 0));

export class Wma {
  constructor(len) { this.w = new Window(len); }
  next(v) {
    this.w.push(v);
    if (!this.w.full()) return NaN;
    const L = this.w.len; let num = 0, den = 0;
    for (let k = 0; k < L; k++) { const x = this.w.get(k); if (Number.isNaN(x)) return NaN; const wt = L - k; num += x * wt; den += wt; }
    return num / den;
  }
}

export class Stdev {
  constructor(len) { this.w = new Window(len); }
  next(v) {
    this.w.push(v);
    if (!this.w.full()) return NaN;
    const L = this.w.len; let s = 0;
    for (let k = 0; k < L; k++) { const x = this.w.get(k); if (Number.isNaN(x)) return NaN; s += x; }
    const m = s / L; let q = 0;
    for (let k = 0; k < L; k++) { const d = this.w.get(k) - m; q += d * d; }
    return Math.sqrt(q / L);
  }
}

export class Extreme {
  constructor(len, isMax) { this.w = new Window(len); this.isMax = isMax; }
  next(v) {
    this.w.push(v);
    if (!this.w.full()) return NaN;
    let best = this.isMax ? -Infinity : Infinity;
    for (let k = 0; k < this.w.len; k++) {
      const x = this.w.get(k);
      if (Number.isNaN(x)) continue;
      if (this.isMax ? x > best : x < best) best = x;
    }
    return Number.isFinite(best) ? best : NaN;
  }
}

/** Value `len` bars ago (for change / mom / roc). */
export class Lag {
  constructor(len) { this.w = new Window(Math.max(1, len | 0) + 1); }
  next(v) { this.w.push(v); return this.w.full() ? this.w.get(this.w.len - 1) : NaN; }
}

export class Rsi {
  constructor(len) { this.up = rma(len); this.dn = rma(len); this.prev = NaN; }
  next(v) {
    const ch = v - this.prev;
    this.prev = v;
    if (Number.isNaN(ch)) return NaN;
    const u = this.up.next(Math.max(ch, 0));
    const d = this.dn.next(Math.max(-ch, 0));
    if (Number.isNaN(u) || Number.isNaN(d)) return NaN;
    if (d === 0) return 100;
    if (u === 0) return 0;
    return 100 - 100 / (1 + u / d);
  }
}

export class Cross {
  /** dir: 1 over, -1 under, 0 either */
  constructor(dir) { this.dir = dir; this.pa = NaN; this.pb = NaN; }
  next(a, b) {
    const { pa, pb } = this;
    this.pa = a; this.pb = b;
    if ([a, b, pa, pb].some(Number.isNaN)) return false;
    const over = a > b && pa <= pb;
    const under = a < b && pa >= pb;
    return this.dir === 1 ? over : this.dir === -1 ? under : over || under;
  }
}

export class TrueRange {
  constructor() { this.pc = NaN; }
  next(h, l, c, handleNa) {
    const pc = this.pc; this.pc = c;
    if (Number.isNaN(pc)) return handleNa ? h - l : NaN;
    return Math.max(h - l, Math.abs(h - pc), Math.abs(l - pc));
  }
}

/** Session VWAP that resets at every UTC day boundary. */
export class Vwap {
  constructor() { this.day = -1; this.pv = 0; this.v = 0; }
  next(src, vol, timeSec) {
    const day = Math.floor(timeSec / 86400);
    if (day !== this.day) { this.day = day; this.pv = 0; this.v = 0; }
    if (Number.isNaN(src) || Number.isNaN(vol)) return this.v ? this.pv / this.v : NaN;
    this.pv += src * vol; this.v += vol;
    return this.v ? this.pv / this.v : NaN;
  }
}

/** Mean absolute deviation for CCI. */
export class Dev {
  constructor(len) { this.w = new Window(len); }
  next(v) {
    this.w.push(v);
    if (!this.w.full()) return NaN;
    const L = this.w.len; let s = 0;
    for (let k = 0; k < L; k++) s += this.w.get(k);
    const m = s / L; let d = 0;
    for (let k = 0; k < L; k++) d += Math.abs(this.w.get(k) - m);
    return d / L;
  }
}
