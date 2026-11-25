// Growable columnar OHLCV buffer on the main thread. One per chart. Typed arrays, so a crosshair
// lookup or a legend update never allocates.

import { emptyBars } from './timeframes.js';

const FIELDS = /** @type {const} */ (['time', 'open', 'high', 'low', 'close', 'volume']);

export class BarBuffer {
  /** @param {import('./timeframes.js').Bars} [bars] */
  constructor(bars) {
    this.cap = 0; this.length = 0;
    /** @type {Record<string, Float64Array>} */
    this.cols = {};
    this.replace(bars || emptyBars(0));
  }

  replace(bars) {
    this.cap = Math.max(64, Math.ceil(bars.length * 1.25));
    for (const f of FIELDS) { const a = new Float64Array(this.cap); a.set(bars[f].subarray(0, bars.length)); this.cols[f] = a; }
    this.length = bars.length;
  }

  /** Older bars in front (history paging). Returns how many were added. */
  prepend(older) {
    const first = this.length ? this.cols.time[0] : Infinity;
    let n = older.length;
    while (n > 0 && older.time[n - 1] >= first) n--;
    if (!n) return 0;
    const len = this.length + n;
    const cap = Math.max(64, Math.ceil(len * 1.25));
    for (const f of FIELDS) {
      const a = new Float64Array(cap);
      a.set(older[f].subarray(0, n), 0);
      a.set(this.cols[f].subarray(0, this.length), n);
      this.cols[f] = a;
    }
    this.cap = cap; this.length = len;
    return n;
  }

  /**
   * Apply a live bar. @returns {'update'|'append'|'stale'}
   * @param {{ time: number, open: number, high: number, low: number, close: number, volume: number }} bar
   */
  apply(bar) {
    const n = this.length, t = this.cols.time;
    if (n && bar.time === t[n - 1]) { for (const f of FIELDS) this.cols[f][n - 1] = bar[f]; return 'update'; }
    if (n && bar.time < t[n - 1]) return 'stale';
    if (n + 1 > this.cap) {
      this.cap = Math.ceil(this.cap * 1.5) + 16;
      for (const f of FIELDS) { const a = new Float64Array(this.cap); a.set(this.cols[f].subarray(0, n)); this.cols[f] = a; }
    }
    for (const f of FIELDS) this.cols[f][n] = bar[f];
    this.length = n + 1;
    return 'append';
  }

  /** Zero-copy view for the Pine worker / chart. */
  view() {
    const v = { length: this.length };
    for (const f of FIELDS) v[f] = this.cols[f].subarray(0, this.length);
    return /** @type {import('./timeframes.js').Bars} */ (v);
  }

  /** Copy (for postMessage, which would otherwise copy the whole capacity). */
  copy() {
    const v = { length: this.length };
    for (const f of FIELDS) v[f] = this.cols[f].slice(0, this.length);
    return /** @type {import('./timeframes.js').Bars} */ (v);
  }

  bar(i) {
    if (i < 0 || i >= this.length) return null;
    const c = this.cols;
    return { time: c.time[i], open: c.open[i], high: c.high[i], low: c.low[i], close: c.close[i], volume: c.volume[i] };
  }

  indexOfTime(t) {
    let lo = 0, hi = this.length - 1;
    const a = this.cols.time;
    while (lo <= hi) { const mid = (lo + hi) >> 1; if (a[mid] === t) return mid; if (a[mid] < t) lo = mid + 1; else hi = mid - 1; }
    return -1;
  }
}
