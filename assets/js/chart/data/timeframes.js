// Timeframes and bucket maths shared by every data adapter, the chart and the Pine runtime.
// All times are UTC seconds.

/** @typedef {{ id: string, label: string, sec: number, pine: string, calendar?: 'D'|'W'|'M' , mult?: number }} Timeframe */

/** @type {Timeframe[]} */
export const TIMEFRAMES = [
  { id: '1m', label: '1m', sec: 60, pine: '1' },
  { id: '3m', label: '3m', sec: 180, pine: '3' },
  { id: '5m', label: '5m', sec: 300, pine: '5' },
  { id: '15m', label: '15m', sec: 900, pine: '15' },
  { id: '30m', label: '30m', sec: 1800, pine: '30' },
  { id: '1h', label: '1h', sec: 3600, pine: '60' },
  { id: '2h', label: '2h', sec: 7200, pine: '120' },
  { id: '4h', label: '4h', sec: 14400, pine: '240' },
  { id: '6h', label: '6h', sec: 21600, pine: '360' },
  { id: '12h', label: '12h', sec: 43200, pine: '720' },
  { id: '1D', label: 'D', sec: 86400, pine: 'D', calendar: 'D', mult: 1 },
  { id: '3D', label: '3D', sec: 259200, pine: '3D', calendar: 'D', mult: 3 },
  { id: '1W', label: 'W', sec: 604800, pine: 'W', calendar: 'W', mult: 1 },
  { id: '1M', label: 'M', sec: 2629800, pine: 'M', calendar: 'M', mult: 1 },
  { id: '3M', label: '3M', sec: 7889400, pine: '3M', calendar: 'M', mult: 3 },
];
export const TF = Object.fromEntries(TIMEFRAMES.map((t) => [t.id, t]));
export const DAY = 86400;

/** Start of the bar that contains `t`. Weeks start Monday, like TradingView. */
export function bucketStart(t, tf) {
  if (!tf.calendar) return Math.floor(t / tf.sec) * tf.sec;
  const day = Math.floor(t / DAY);
  if (tf.calendar === 'D') return Math.floor(day / tf.mult) * tf.mult * DAY;
  if (tf.calendar === 'W') return (day - ((day + 3) % 7)) * DAY; // 1970-01-01 was a Thursday
  const d = new Date(day * DAY * 1000);
  const m = d.getUTCMonth();
  return Date.UTC(d.getUTCFullYear(), m - (m % tf.mult), 1) / 1000;
}

/** Start of the bar after the one starting at `start`. */
export function bucketNext(start, tf) {
  if (!tf.calendar) return start + tf.sec;
  if (tf.calendar === 'D') return start + tf.mult * DAY;
  if (tf.calendar === 'W') return start + 7 * DAY;
  const d = new Date(start * 1000);
  return Date.UTC(d.getUTCFullYear(), d.getUTCMonth() + tf.mult, 1) / 1000;
}

/**
 * @typedef {Object} Bars
 * @property {Float64Array} time @property {Float64Array} open @property {Float64Array} high
 * @property {Float64Array} low @property {Float64Array} close @property {Float64Array} volume
 * @property {number} length
 */

/** @param {number} n @returns {Bars} */
export function emptyBars(n) {
  return { time: new Float64Array(n), open: new Float64Array(n), high: new Float64Array(n), low: new Float64Array(n), close: new Float64Array(n), volume: new Float64Array(n), length: n };
}

/** Trim a Bars object to its first `n` rows (views, no copy). */
export function sliceBars(b, from, to) {
  const s = (a) => a.subarray(from, to);
  return { time: s(b.time), open: s(b.open), high: s(b.high), low: s(b.low), close: s(b.close), volume: s(b.volume), length: Math.max(0, to - from) };
}

/** Aggregate finer bars into a coarser timeframe. Input must be sorted by time. */
export function aggregate(src, tf) {
  const out = emptyBars(src.length);
  let k = -1, cur = -Infinity;
  for (let i = 0; i < src.length; i++) {
    const b = bucketStart(src.time[i], tf);
    if (b !== cur) {
      k++; cur = b;
      out.time[k] = b; out.open[k] = src.open[i]; out.high[k] = src.high[i]; out.low[k] = src.low[i]; out.close[k] = src.close[i]; out.volume[k] = src.volume[i];
    } else {
      if (src.high[i] > out.high[k]) out.high[k] = src.high[i];
      if (src.low[i] < out.low[k]) out.low[k] = src.low[i];
      out.close[k] = src.close[i]; out.volume[k] += src.volume[i];
    }
  }
  return sliceBars(out, 0, k + 1);
}

/** Concatenate two Bars (a older than b). */
export function concatBars(a, b) {
  const n = a.length + b.length;
  const out = emptyBars(n);
  for (const f of ['time', 'open', 'high', 'low', 'close', 'volume']) { out[f].set(a[f].subarray(0, a.length), 0); out[f].set(b[f].subarray(0, b.length), a.length); }
  return out;
}
