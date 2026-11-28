// Pure maths for drawings: no DOM, no chart. Tested in tests/drawings.test.mjs.
//
// Drawings are stored as (time, price) points, never as pixels or bar indexes, so one drawing
// shows up in the right place on every timeframe and survives history loading. To place a time
// on screen we turn it into a *fractional logical index* against the bars on the chart:
// between two bars it interpolates, past either end it extrapolates by the bar length.

/** @typedef {{ time: number, price: number }} Pt */
/** @typedef {'trend'|'ray'|'hline'|'fib'|'long'|'short'|'channel'|'text'} DrawingType */
/**
 * @typedef {Object} Drawing
 * @property {string} id @property {DrawingType} type @property {Pt[]} points
 * @property {string} color @property {number} width @property {number} created
 * @property {string=} text  for text notes
 */

export const TOOL_POINTS = { trend: 2, ray: 2, hline: 1, fib: 2, long: 2, short: 2, channel: 3, text: 1,
  extline: 2, infoline: 2, angle: 2, hray: 1, vline: 1, cross: 1, rect: 2, arrow: 2, measure: 2 };

/** Distance from P to the infinite line through A and B. */
export function distToLine(px, py, ax, ay, bx, by) {
  const dx = bx - ax, dy = by - ay, len = Math.hypot(dx, dy);
  return len ? Math.abs((px - ax) * dy - (py - ay) * dx) / len : Math.hypot(px - ax, py - ay);
}

/** Screen angle of A->B in degrees, up is positive (TradingView's trend angle). */
export const screenAngle = (ax, ay, bx, by) => Math.atan2(ay - by, bx - ax) * 180 / Math.PI;

/** Price change, percent and time span between two points; `bars` from the chart's bar length. */
export function measure(a, b, barSec) {
  const change = b.price - a.price;
  return { change, pct: a.price ? (change / a.price) * 100 : NaN, bars: barSec ? Math.round((b.time - a.time) / barSec) : 0, days: (b.time - a.time) / 86400 };
}
export const FIB_LEVELS = [0, 0.236, 0.382, 0.5, 0.618, 0.786, 1, 1.618];

/**
 * @param {number} t time (s) @param {ArrayLike<number>} times bar times, ascending
 * @param {number} n bar count @param {number} barSec typical bar length
 * @returns {number|null}
 */
export function timeToLogical(t, times, n, barSec) {
  if (!n) return null;
  if (t <= times[0]) return (t - times[0]) / barSec;
  if (t >= times[n - 1]) return n - 1 + (t - times[n - 1]) / barSec;
  let lo = 0, hi = n - 1;
  while (hi - lo > 1) { const mid = (lo + hi) >> 1; if (times[mid] <= t) lo = mid; else hi = mid; }
  return lo + (t - times[lo]) / (times[hi] - times[lo]);
}

/** Inverse of timeToLogical. */
export function logicalToTime(L, times, n, barSec) {
  if (!n) return null;
  if (L <= 0) return times[0] + L * barSec;
  if (L >= n - 1) return times[n - 1] + (L - (n - 1)) * barSec;
  const i = Math.floor(L), f = L - i;
  return times[i] + f * (times[i + 1] - times[i]);
}

/** Distance from point P to segment AB (pixels). */
export function distToSegment(px, py, ax, ay, bx, by) {
  const dx = bx - ax, dy = by - ay;
  const len2 = dx * dx + dy * dy;
  let t = len2 ? ((px - ax) * dx + (py - ay) * dy) / len2 : 0;
  t = Math.max(0, Math.min(1, t));
  return Math.hypot(px - (ax + t * dx), py - (ay + t * dy));
}

/** Distance from P to the ray starting at A and passing through B. */
export function distToRay(px, py, ax, ay, bx, by) {
  const dx = bx - ax, dy = by - ay;
  const len2 = dx * dx + dy * dy;
  const t = Math.max(0, len2 ? ((px - ax) * dx + (py - ay) * dy) / len2 : 0);
  return Math.hypot(px - (ax + t * dx), py - (ay + t * dy));
}

/** Far end of a ray from A through B, far enough to leave any chart. */
export function rayEnd(ax, ay, bx, by, reach = 20000) {
  const dx = bx - ax, dy = by - ay;
  const len = Math.hypot(dx, dy) || 1;
  return [ax + (dx / len) * reach, ay + (dy / len) * reach];
}

/**
 * Fibonacci retracement: level 0 sits on the second point, 1 on the first (TradingView's
 * convention: drag from swing low to swing high and 0.618 is the "golden" pullback).
 * @returns {{ level: number, price: number }[]}
 */
export function fibLevels(p1, p2, levels = FIB_LEVELS) {
  return levels.map((level) => ({ level, price: p2 - (p2 - p1) * level }));
}

/**
 * Long/short position measurement. points: [entry, target, stop]; the side is the direction of
 * the target. Returned percentages are moves from the entry price; ratio is reward / risk.
 */
export function riskReward(entry, target, stop) {
  const reward = target - entry, risk = entry - stop;
  const side = reward >= 0 ? 'long' : 'short';
  const ratio = Math.abs(risk) > 0 ? Math.abs(reward) / Math.abs(risk) : Infinity;
  return {
    side,
    rewardPct: (reward / entry) * 100,
    riskPct: (-risk / entry) * 100,
    ratio,
    // a stop on the wrong side of the entry is not a stop: flag it instead of printing nonsense
    valid: side === 'long' ? stop < entry : stop > entry,
  };
}

/** Default target/stop for a new position: 1:2 reward:risk using the second click as target. */
export function defaultPosition(type, entry, second) {
  let target = second.price;
  // a long's target must be above entry and a short's below; mirror a click on the wrong side
  if ((type === 'long' && target < entry.price) || (type === 'short' && target > entry.price)) target = 2 * entry.price - target;
  if (target === entry.price) target = entry.price * (type === 'long' ? 1.02 : 0.98);
  const stop = entry.price - (target - entry.price) / 2;
  const right = Math.max(second.time, entry.time);
  return [{ time: entry.time, price: entry.price }, { time: right, price: target }, { time: right, price: stop }];
}

/**
 * Magnet: snap a price to the nearest open/high/low/close of the bar under the cursor if it is
 * within `radius` pixels. toY converts a price to a pixel y.
 */
export function magnetPrice(price, y, bar, toY, radius = 14) {
  if (!bar) return price;
  let best = price, bestD = radius;
  for (const p of [bar.open, bar.high, bar.low, bar.close]) {
    const py = toY(p);
    if (py == null) continue;
    const d = Math.abs(py - y);
    if (d <= bestD) { bestD = d; best = p; }
  }
  return best;
}

/**
 * Parallel channel: the base line runs p1 -> p2; the third point sets how far (in price) the
 * parallel line sits from it, measured at the third point's time.
 */
export function channelOffset(p1, p2, p3) {
  const dt = p2.time - p1.time;
  const base = dt ? p1.price + (p2.price - p1.price) * (p3.time - p1.time) / dt : p1.price;
  return p3.price - base;
}
