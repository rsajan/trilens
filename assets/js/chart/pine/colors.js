// Pine colours. Internally every colour is a lowercase "#rrggbbaa" string; the chart gets rgba().

export const PINE_COLORS = {
  'color.aqua': '#00bcd4ff', 'color.black': '#363a45ff', 'color.blue': '#2962ffff', 'color.fuchsia': '#e040fbff',
  'color.gray': '#787b86ff', 'color.green': '#4caf50ff', 'color.lime': '#00e676ff', 'color.maroon': '#880e4fff',
  'color.navy': '#311b92ff', 'color.olive': '#808000ff', 'color.orange': '#ff9800ff', 'color.purple': '#9c27b0ff',
  'color.red': '#f23645ff', 'color.silver': '#b2b5beff', 'color.teal': '#089981ff', 'color.white': '#ffffffff',
  'color.yellow': '#ffeb3bff',
};

/** @param {any} c @returns {string|null} "#rrggbbaa" or null for na / not a colour */
const SEEN = new Map(); // string -> normalised colour or null; scripts reuse a handful of colours
export function toHex8(c) {
  if (typeof c !== 'string') return null;
  const hit = SEEN.get(c);
  if (hit !== undefined) return hit;
  const out = /^#[0-9a-f]{8}$/i.test(c) ? c.toLowerCase() : /^#[0-9a-f]{6}$/i.test(c) ? c.toLowerCase() + 'ff' : null;
  if (SEEN.size > 4096) SEEN.clear();
  SEEN.set(c, out);
  return out;
}

const h2 = (n) => Math.max(0, Math.min(255, Math.round(n))).toString(16).padStart(2, '0');

/** color.new(color, transp 0-100) */
const TRANSP = new Map();
export function withTransp(c, transp) {
  const key = c + '|' + transp;
  const hit = TRANSP.get(key);
  if (hit !== undefined) return hit;
  const x = toHex8(c);
  const t = Number.isFinite(transp) ? Math.max(0, Math.min(100, transp)) : 0;
  const out = x ? x.slice(0, 7) + h2(255 * (1 - t / 100)) : null;
  if (TRANSP.size > 4096) TRANSP.clear();
  TRANSP.set(key, out);
  return out;
}

export function rgb(r, g, b, transp = 0) {
  return '#' + h2(r) + h2(g) + h2(b) + h2(255 * (1 - (Number.isFinite(transp) ? transp : 0) / 100));
}

/** color.from_gradient: linear blend between two colours by where value sits in [lo, hi] */
export function gradient(value, lo, hi, cLo, cHi) {
  const a = toHex8(cLo), b = toHex8(cHi);
  if (!a || !b || !Number.isFinite(value)) return null;
  const t = hi === lo ? 0 : Math.max(0, Math.min(1, (value - lo) / (hi - lo)));
  const ch = (s, i) => parseInt(s.slice(1 + i * 2, 3 + i * 2), 16);
  return '#' + [0, 1, 2, 3].map((i) => h2(ch(a, i) + (ch(b, i) - ch(a, i)) * t)).join('');
}

/** "#rrggbbaa" -> "rgba(r, g, b, a)" for the chart library */
export function toCss(c) {
  const x = toHex8(c);
  if (!x) return null;
  const n = (i) => parseInt(x.slice(1 + i * 2, 3 + i * 2), 16);
  return `rgba(${n(0)}, ${n(1)}, ${n(2)}, ${+(n(3) / 255).toFixed(3)})`;
}
