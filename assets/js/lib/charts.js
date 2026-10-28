// SVG charts: hand-rolled, no libraries, so the app stays fast and works offline.
// Conventions follow the data-viz rules used across Trilens:
// 2px lines, 8px+ end markers with a 2px surface ring, 4px rounded bar ends,
// recessive hairline grid, tooltips built with textContent only.
import { h, fmt, clamp } from './dom.js';

const NS = 'http://www.w3.org/2000/svg';
function s(tag, attrs, ...kids) {
  const el = document.createElementNS(NS, tag);
  if (attrs) for (const [k, v] of Object.entries(attrs)) if (v != null) el.setAttribute(k, v);
  for (const k of kids.flat()) if (k != null) el.append(k instanceof Node ? k : document.createTextNode(String(k)));
  return el;
}

export function niceTicks(min, max, count = 4) {
  if (!(isFinite(min) && isFinite(max))) return [0, 1];
  if (min === max) { min -= 1; max += 1; }
  const raw = (max - min) / Math.max(1, count);
  const mag = Math.pow(10, Math.floor(Math.log10(raw)));
  const norm = raw / mag;
  const step = (norm < 1.5 ? 1 : norm < 3 ? 2 : norm < 7 ? 5 : 10) * mag;
  const start = Math.ceil(min / step) * step;
  const out = [];
  for (let v = start; v <= max + step * 1e-6; v += step) out.push(+v.toPrecision(12));
  return out;
}
function logTicks(min, max) {
  const out = [];
  for (let e = Math.floor(Math.log10(min)); e <= Math.ceil(Math.log10(max)); e++) for (const m of [1, 2, 5]) { const v = m * 10 ** e; if (v >= min && v <= max) out.push(v); }
  return out.length > 7 ? out.filter((_, i) => i % 2 === 0) : out;
}

function observe(wrap, draw) {
  let last = 0;
  const run = () => { const w = wrap.clientWidth; if (w && Math.abs(w - last) > 1) { last = w; draw(); } };
  if ('ResizeObserver' in window) new ResizeObserver(run).observe(wrap);
  else addEventListener('resize', run);
  requestAnimationFrame(() => { draw(); last = wrap.clientWidth; });
}

function placeTip(tip, wrap, px, py) {
  tip.classList.remove('hide');
  const w = wrap.clientWidth, tw = tip.offsetWidth;
  const x = clamp(px, tw / 2 + 4, w - tw / 2 - 4);
  const y = Math.max(py - 12, tip.offsetHeight + 4);
  tip.style.left = x + 'px'; tip.style.top = y + 'px';
}
function tipRow(color, name, value) {
  return h('div', { class: 'tk' }, h('i', { style: { background: color } }), h('span', { class: 'tv' }, value), name ? h('span', { class: 'muted' }, name) : null);
}

/** Line / area chart with crosshair tooltip.
 * series: [{name, values:[..], color:'var(--s1)'}]; x: labels aligned with values */
export function lineChart({ series, x, height = 220, yFmt = (v) => fmt.num(v, 0), xFmt = (v) => v, scale = 'linear', area = false, label = '' }) {
  const wrap = h('div', { class: 'chart', style: { height: height + 'px' } });
  const tip = h('div', { class: 'tip hide' });
  const n = x.length;
  function draw() {
    wrap.querySelectorAll('svg').forEach((e) => e.remove());
    const W = wrap.clientWidth || 320, H = height;
    const m = { l: 6, r: 50, t: 10, b: 22 };
    const iw = W - m.l - m.r, ih = H - m.t - m.b;
    const all = series.flatMap((se) => se.values).filter((v) => v != null && isFinite(v) && (scale !== 'log' || v > 0));
    if (!all.length || n < 2) return;
    let lo = Math.min(...all), hi = Math.max(...all);
    const pad = (hi - lo || Math.abs(hi) || 1) * 0.06;
    if (scale === 'log') { lo = lo / 1.08; hi = hi * 1.08; } else { lo -= pad; hi += pad; }
    const ty = scale === 'log' ? (v) => Math.log(v) : (v) => v;
    const a = ty(lo), b = ty(hi);
    const Y = (v) => m.t + (1 - (ty(v) - a) / (b - a)) * ih;
    const X = (i) => m.l + (i / (n - 1)) * iw;
    const ticks = scale === 'log' ? logTicks(lo, hi) : niceTicks(lo, hi, Math.max(2, Math.round(ih / 55)));
    const svg = s('svg', { viewBox: `0 0 ${W} ${H}`, height: H, role: 'img', 'aria-label': label || 'Line chart' });
    const grid = s('g', { class: 'grid' }), axis = s('g', { class: 'axis' });
    for (const t of ticks) {
      const yy = Y(t); if (yy < m.t - 1 || yy > H - m.b + 1) continue;
      grid.append(s('line', { x1: m.l, x2: W - m.r, y1: yy, y2: yy }));
      axis.append(s('text', { x: W - m.r + 7, y: yy + 4 }, yFmt(t)));
    }
    const nx = W < 420 ? 3 : 5;
    for (let k = 0; k < nx; k++) {
      const i = Math.round((k / (nx - 1)) * (n - 1));
      axis.append(s('text', { x: X(i), y: H - 5, 'text-anchor': k === 0 ? 'start' : k === nx - 1 ? 'end' : 'middle' }, xFmt(x[i])));
    }
    svg.append(grid, axis);
    series.forEach((se) => {
      let d = '', pen = false, first = null, last = null;
      se.values.forEach((v, i) => {
        if (v == null || !isFinite(v) || (scale === 'log' && v <= 0)) { pen = false; return; }
        d += (pen ? 'L' : 'M') + X(i).toFixed(1) + ' ' + Y(v).toFixed(1); pen = true;
        if (first == null) first = i; last = i;
      });
      if (!d) return;
      if (area && first != null) svg.append(s('path', { d: d + `L${X(last).toFixed(1)} ${H - m.b}L${X(first).toFixed(1)} ${H - m.b}Z`, fill: se.color, opacity: 0.1 }));
      svg.append(s('path', { d, class: 'line', stroke: se.color }));
      if (last != null) svg.append(s('circle', { cx: X(last), cy: Y(se.values[last]), r: 4, fill: se.color, stroke: 'var(--bg)', 'stroke-width': 2 }));
    });
    const cross = s('line', { y1: m.t, y2: H - m.b, stroke: 'var(--ink-3)', 'stroke-width': 1, opacity: 0, 'pointer-events': 'none' });
    const dots = series.map((se) => s('circle', { r: 4.5, fill: se.color, stroke: 'var(--bg)', 'stroke-width': 2, opacity: 0, 'pointer-events': 'none' }));
    svg.append(cross, ...dots);
    const hit = s('rect', { class: 'hit', x: m.l, y: 0, width: iw, height: H });
    const show = (e) => {
      const r = svg.getBoundingClientRect();
      const px = (e.clientX - r.left) * (W / r.width);
      const i = clamp(Math.round(((px - m.l) / iw) * (n - 1)), 0, n - 1);
      cross.setAttribute('x1', X(i)); cross.setAttribute('x2', X(i)); cross.setAttribute('opacity', 1);
      let ty0 = null;
      tip.replaceChildren(h('div', { class: 'td' }, String(xFmt(x[i], true))));
      series.forEach((se, k) => {
        const v = se.values[i];
        if (v == null) { dots[k].setAttribute('opacity', 0); return; }
        dots[k].setAttribute('cx', X(i)); dots[k].setAttribute('cy', Y(v)); dots[k].setAttribute('opacity', 1);
        if (ty0 == null) ty0 = Y(v);
        tip.append(tipRow(se.color, series.length > 1 ? se.name : '', yFmt(v, true)));
      });
      placeTip(tip, wrap, X(i) * (r.width / W), (ty0 ?? 40) * (r.height / H));
    };
    const hide = () => { cross.setAttribute('opacity', 0); dots.forEach((d) => d.setAttribute('opacity', 0)); tip.classList.add('hide'); };
    hit.addEventListener('pointermove', show); hit.addEventListener('pointerdown', show);
    hit.addEventListener('pointerleave', hide); hit.addEventListener('pointercancel', hide);
    svg.append(hit);
    wrap.prepend(svg);
  }
  wrap.append(tip);
  observe(wrap, draw);
  return wrap;
}

function barPath(x, y0, y1, w, r) {
  // y0 baseline, y1 data end. Rounded at the data end only.
  const up = y1 < y0, h_ = Math.abs(y0 - y1);
  if (h_ < 0.5) return `M${x} ${y0}h${w}v0.5h-${w}z`;
  r = Math.min(r, w / 2, h_);
  if (up) return `M${x} ${y0}V${y1 + r}Q${x} ${y1} ${x + r} ${y1}H${x + w - r}Q${x + w} ${y1} ${x + w} ${y1 + r}V${y0}Z`;
  return `M${x} ${y0}V${y1 - r}Q${x} ${y1} ${x + r} ${y1}H${x + w - r}Q${x + w} ${y1} ${x + w} ${y1 - r}V${y0}Z`;
}

/** Grouped / signed columns with per-bar tooltips.
 * series: [{name, values, color}] ; signColor colours each bar gain/loss by sign instead. */
export function columns({ labels, series, height = 190, yFmt = (v) => fmt.compact(v), signColor = false, label = '' }) {
  const wrap = h('div', { class: 'chart', style: { height: height + 'px' } });
  const tip = h('div', { class: 'tip hide' });
  function draw() {
    wrap.querySelectorAll('svg').forEach((e) => e.remove());
    const W = wrap.clientWidth || 320, H = height;
    const m = { l: 4, r: 46, t: 10, b: 22 };
    const iw = W - m.l - m.r, ih = H - m.t - m.b;
    const vals = series.flatMap((se) => se.values).filter((v) => v != null && isFinite(v));
    if (!vals.length) return;
    let lo = Math.min(0, ...vals), hi = Math.max(0, ...vals);
    if (lo === hi) hi = lo + 1;
    const ticks = niceTicks(lo, hi, 3);
    lo = Math.min(lo, ticks[0]); hi = Math.max(hi, ticks[ticks.length - 1]);
    const Y = (v) => m.t + (1 - (v - lo) / (hi - lo)) * ih;
    const svg = s('svg', { viewBox: `0 0 ${W} ${H}`, height: H, role: 'img', 'aria-label': label || 'Bar chart' });
    const grid = s('g', { class: 'grid' }), axis = s('g', { class: 'axis' });
    for (const t of ticks) { grid.append(s('line', { x1: m.l, x2: W - m.r, y1: Y(t), y2: Y(t) })); axis.append(s('text', { x: W - m.r + 7, y: Y(t) + 4 }, yFmt(t))); }
    const n = labels.length, band = iw / n, k = series.length;
    const bw = Math.min(24, (band * 0.72) / k - 2);
    const step = Math.max(1, Math.ceil(n / Math.max(3, Math.floor(iw / 54))));
    const bars = s('g');
    const base = Y(0);
    labels.forEach((lb, i) => {
      const cx = m.l + band * (i + 0.5);
      if (i % step === 0) axis.append(s('text', { x: cx, y: H - 5, 'text-anchor': 'middle' }, lb));
      series.forEach((se, j) => {
        const v = se.values[i]; if (v == null || !isFinite(v)) return;
        const x0 = cx - (k * (bw + 2) - 2) / 2 + j * (bw + 2);
        const col = signColor ? (v >= 0 ? 'var(--gain)' : 'var(--loss)') : se.color;
        const p = s('path', { d: barPath(x0, base, Y(v), bw, 4), fill: col, opacity: se.faded ? 0.45 : 1 });
        const hitR = s('rect', { x: cx - band / 2, y: m.t, width: band, height: ih, fill: 'transparent' });
        bars.append(p);
        const show = () => {
          tip.replaceChildren(h('div', { class: 'td' }, lb), tipRow(col, k > 1 || signColor ? se.name : '', yFmt(v, true)));
          series.forEach((se2, j2) => { if (j2 !== j && se2.values[i] != null) tip.append(tipRow(se2.color, se2.name, yFmt(se2.values[i], true))); });
          const r = svg.getBoundingClientRect();
          placeTip(tip, wrap, cx * (r.width / W), Math.min(Y(v), base) * (r.height / H));
          p.setAttribute('opacity', 0.78);
        };
        const hide = () => { tip.classList.add('hide'); p.setAttribute('opacity', se.faded ? 0.45 : 1); };
        hitR.addEventListener('pointerenter', show); hitR.addEventListener('pointerdown', show);
        hitR.addEventListener('pointerleave', hide);
        if (j === 0) bars.append(hitR);
        else bars.append(hitR);
      });
    });
    svg.append(grid, axis, bars, s('line', { x1: m.l, x2: W - m.r, y1: base, y2: base, stroke: 'var(--line)', 'stroke-width': 1 }));
    wrap.prepend(svg);
  }
  wrap.append(tip);
  observe(wrap, draw);
  return wrap;
}

export function legend(items) {
  return h('div', { class: 'legend' }, items.map((it) => h('span', null, h('i', { class: it.sq ? 'sq' : '', style: { background: it.color } }), it.label)));
}

export function sparkline(values, { w = 70, hgt = 30, color } = {}) {
  const v = (values || []).filter((x) => x != null && isFinite(x));
  const svg = s('svg', { viewBox: `0 0 ${w} ${hgt}`, width: w, height: hgt, class: 'spark', 'aria-hidden': 'true' });
  if (v.length < 2) return svg;
  const lo = Math.min(...v), hi = Math.max(...v), span = hi - lo || 1;
  const X = (i) => 2 + (i / (v.length - 1)) * (w - 8);
  const Y = (x) => 3 + (1 - (x - lo) / span) * (hgt - 6);
  const col = color || (v[v.length - 1] >= v[0] ? 'var(--gain)' : 'var(--loss)');
  svg.append(s('path', { d: v.map((x, i) => (i ? 'L' : 'M') + X(i).toFixed(1) + ' ' + Y(x).toFixed(1)).join(''), fill: 'none', stroke: col, 'stroke-width': 1.7, 'stroke-linejoin': 'round', 'stroke-linecap': 'round' }));
  svg.append(s('circle', { cx: X(v.length - 1), cy: Y(v[v.length - 1]), r: 2.6, fill: col }));
  return svg;
}

/** One stacked horizontal bar with a 2px gap between segments. parts: [{label,value,color}] */
export function stackBar(parts, { showLegend = true } = {}) {
  const total = parts.reduce((a, p) => a + (p.value || 0), 0) || 1;
  const bar = h('div', { class: 'bar-h', role: 'img', 'aria-label': parts.map((p) => `${p.label} ${p.value}`).join(', ') });
  parts.filter((p) => p.value > 0).forEach((p) => bar.append(h('i', { style: { flexGrow: p.value / total, background: p.color }, title: `${p.label}: ${p.value}` })));
  const box = h('div', null, bar);
  if (showLegend) box.append(h('div', { class: 'legend' }, parts.map((p) => h('span', null, h('i', { class: 'sq', style: { background: p.color } }), `${p.label} `, h('b', { class: 'num', style: { color: 'var(--ink)', fontWeight: 600 } }, p.value)))));
  return box;
}

/** Position markers along a numeric range (52-week range, analyst targets). */
export function rangeBar({ min, max, from, to, marks, fmtv = (v) => fmt.num(v, 2) }) {
  const pos = (v) => clamp(((v - min) / (max - min || 1)) * 100, 0, 100) + '%';
  const el = h('div', { class: 'rangebar', style: { height: '58px' } },
    h('div', { class: 'track', style: { top: '27px' } }));
  if (from != null && to != null) el.append(h('div', { class: 'fill', style: { top: '27px', left: pos(from), width: `calc(${pos(to)} - ${pos(from)})` } }));
  for (const mk of marks || []) {
    el.append(h('div', { class: 'mk ' + (mk.kind || ''), style: { left: pos(mk.v), top: '21px' }, title: `${mk.label}: ${fmtv(mk.v)}` }));
    el.append(h('div', { class: 'lbl', style: { left: pos(mk.v), top: mk.above ? '0' : '38px' } }, `${mk.label} ${fmtv(mk.v)}`));
  }
  return el;
}

/** Semicircle gauge for a -100..+100 score. */
export function gauge(score, { size = 220, label } = {}) {
  const W = size, Hh = Math.round(size * 0.62), cx = W / 2, cy = Hh - 10, R = size * 0.4, sw = 14;
  const pt = (sc, r = R) => { const a = Math.PI * (1 - (sc + 100) / 200); return [cx + r * Math.cos(a), cy - r * Math.sin(a)]; };
  const arc = (a, b, color) => {
    const [x1, y1] = pt(a), [x2, y2] = pt(b);
    return s('path', { d: `M${x1} ${y1}A${R} ${R} 0 0 1 ${x2} ${y2}`, fill: 'none', stroke: color, 'stroke-width': sw });
  };
  const svg = s('svg', { viewBox: `0 0 ${W} ${Hh}`, width: W, height: Hh, class: 'gauge', role: 'img', 'aria-label': `${label || 'Score'} ${Math.round(score)} out of 100` });
  svg.append(arc(-100, -22, 'var(--loss)'), arc(-18, 18, 'var(--flat)'), arc(22, 100, 'var(--gain)'));
  svg.lastChild.previousSibling.setAttribute('opacity', 0.7);
  const sc = clamp(score, -100, 100);
  const [nx, ny] = pt(sc, R - sw / 2 - 6), [bx, by] = pt(sc, R + sw / 2 + 5);
  svg.append(s('line', { x1: nx, y1: ny, x2: bx, y2: by, stroke: 'var(--ink)', 'stroke-width': 3.5, 'stroke-linecap': 'round' }));
  svg.append(s('text', { x: cx, y: cy - 6, 'text-anchor': 'middle', 'font-size': size * 0.2, 'font-weight': 600, fill: 'var(--ink)', 'letter-spacing': '-0.03em' }, (sc > 0 ? '+' : sc < 0 ? '−' : '') + Math.abs(Math.round(sc))));
  svg.append(s('text', { x: pt(-100)[0] , y: cy + 6, 'text-anchor': 'middle', 'font-size': 11, fill: 'var(--ink-3)' }, 'Bear'));
  svg.append(s('text', { x: pt(100)[0], y: cy + 6, 'text-anchor': 'middle', 'font-size': 11, fill: 'var(--ink-3)' }, 'Bull'));
  return svg;
}

/** -100..100 horizontal meter with a pin */
export function meter(score) {
  return h('div', { class: 'meter', role: 'img', 'aria-label': `Score ${Math.round(score)}` }, h('div', { class: 'pin', style: { left: clamp((score + 100) / 2, 1, 99) + '%' } }));
}
