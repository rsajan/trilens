// Drawing layer: one lightweight-charts series primitive that renders every drawing on the price
// pane, plus the pointer/keyboard controller that creates, selects, drags and deletes them.
//
// Why one primitive for all drawings: the chart calls each primitive's renderer on every frame;
// one renderer walking a small array is cheaper and simpler than N primitives with N views.
// Why our own pointer handling: we need hit-testing with handles, and the chart must stop
// panning only while a drawing is grabbed. We listen in the capture phase on the chart element
// and swallow the matching mousedown/touchstart so the chart never starts a pan under a drag.

import * as G from './geometry.js';
import { loadDrawings, saveDrawings } from './store.js';
import { fmtNum } from '../engine/chart-engine.js';

const HANDLE_R = 5;
const css = (name, fb) => getComputedStyle(document.documentElement).getPropertyValue(name).trim() || fb;
const hexA = (c, a) => {
  const m = /^#([0-9a-f]{6})/i.exec(c);
  if (!m) return c;
  const n = parseInt(m[1], 16);
  return `rgba(${n >> 16}, ${(n >> 8) & 255}, ${n & 255}, ${a})`;
};
const uid = () => 'd' + Date.now().toString(36) + Math.random().toString(36).slice(2, 6);

export class DrawingLayer {
  /**
   * @param {import('../engine/chart-engine.js').ChartEngine} engine
   * @param {{ onChange?: () => void, magnet?: () => boolean, hidden?: () => boolean, onToolDone?: () => void }} hooks
   */
  constructor(engine, hooks = {}) {
    this.engine = engine;
    this.hooks = hooks;
    this.symbol = null;
    this.barSec = 3600;
    /** @type {import('./geometry.js').Drawing[]} */
    this.drawings = [];
    this.tool = 'cursor';
    this.selected = null;
    this.creating = null; // { type, points, placed }
    this.drag = null; // { id, kind, index, startL, startPrice, orig }
    this.swallow = false;
    this.saveTimer = 0;
    this.loadToken = 0;
    this.requestUpdate = () => {};
    this.touch = false;

    const self = this;
    this.primitive = {
      attached(p) { self.requestUpdate = p.requestUpdate; },
      detached() { self.requestUpdate = () => {}; },
      updateAllViews() {},
      paneViews() { return [{ zOrder: () => 'top', renderer: () => ({ draw: (target) => self.draw(target) }) }]; },
      priceAxisViews() { return self.axisViews(); },
    };
    engine.candles.attachPrimitive(this.primitive);

    const el = engine.chartEl;
    this.el = el;
    this.on = [
      ['pointerdown', (e) => this.down(e)],
      ['pointermove', (e) => this.move(e)],
      ['pointerup', (e) => this.up(e)],
      ['pointercancel', (e) => this.up(e)],
      ['mousedown', (e) => { if (this.swallow) e.stopPropagation(); }],
      ['touchstart', (e) => { if (this.swallow) e.stopPropagation(); }],
      ['touchmove', (e) => { if (this.swallow) { e.stopPropagation(); e.preventDefault(); } }],
    ];
    for (const [t, f] of this.on) el.addEventListener(t, f, { capture: true, passive: false });
    this.onKey = (e) => this.key(e);
    addEventListener('keydown', this.onKey);
  }

  // ------------------------------------------------------------------ context & persistence
  /** Called when the chart's symbol or timeframe changes. */
  async setContext(symbol, barSec) {
    this.barSec = barSec;
    if (symbol === this.symbol) { this.requestUpdate(); return; }
    this.flushSave();
    this.symbol = symbol;
    this.drawings = [];
    this.selected = null;
    this.creating = null;
    const my = ++this.loadToken;
    const list = await loadDrawings(symbol);
    if (my !== this.loadToken) return;
    this.drawings = list.filter((d) => d && d.id && G.TOOL_POINTS[d.type] && Array.isArray(d.points));
    this.changed(false);
  }

  changed(save = true) {
    this.requestUpdate();
    if (save) { clearTimeout(this.saveTimer); this.saveTimer = setTimeout(() => this.flushSave(), 300); }
    this.hooks.onChange && this.hooks.onChange();
  }

  flushSave() {
    if (!this.saveTimer || !this.symbol) return;
    clearTimeout(this.saveTimer);
    this.saveTimer = 0;
    saveDrawings(this.symbol, this.drawings);
  }

  // ------------------------------------------------------------------ public API
  setTool(tool) {
    this.tool = tool;
    this.creating = null;
    if (tool !== 'cursor') this.selected = null;
    this.el.style.cursor = tool === 'cursor' ? '' : 'crosshair';
    this.changed(false);
  }
  selectedDrawing() { return this.drawings.find((d) => d.id === this.selected) || null; }
  patchSelected(patch) {
    const d = this.selectedDrawing();
    if (!d) return;
    Object.assign(d, patch);
    this.changed();
  }
  deleteSelected() {
    if (!this.selected) return;
    this.drawings = this.drawings.filter((d) => d.id !== this.selected);
    this.selected = null;
    this.changed();
  }
  clearAll() { this.drawings = []; this.selected = null; this.creating = null; this.changed(); }
  refresh() { this.requestUpdate(); }

  // ------------------------------------------------------------------ coordinates
  bars() { const b = this.engine.buf; return b && b.length ? b : null; }
  toX(t) {
    const b = this.bars(); if (!b) return null;
    const L = G.timeToLogical(t, b.cols.time, b.length, this.barSec);
    return L == null ? null : this.engine.chart.timeScale().logicalToCoordinate(L);
  }
  toY(p) { return this.engine.candles.priceToCoordinate(p); }
  local(e) { const r = this.el.getBoundingClientRect(); return { x: e.clientX - r.left, y: e.clientY - r.top }; }
  inPricePane(x, y) {
    const panes = this.engine.chart.panes();
    const h0 = panes.length ? panes[0].getHeight() : 0;
    const w = this.el.clientWidth - this.engine.chart.priceScale('right').width();
    return x >= 0 && x < w && y >= 0 && y < h0;
  }
  /** Pixel -> (time, price), snapped to a bar and optionally to its OHLC. */
  fromXY(x, y, snap = true) {
    const b = this.bars(); if (!b) return null;
    const Lraw = this.engine.chart.timeScale().coordinateToLogical(x);
    const price0 = this.engine.candles.coordinateToPrice(y);
    if (Lraw == null || price0 == null) return null;
    const L = Math.round(Lraw);
    let price = price0;
    if (snap && this.hooks.magnet && this.hooks.magnet() && L >= 0 && L < b.length) price = G.magnetPrice(price0, y, b.bar(L), (p) => this.toY(p));
    return { time: G.logicalToTime(L, b.cols.time, b.length, this.barSec), price, L };
  }

  // ------------------------------------------------------------------ hit-testing
  screenPoints(d) { return d.points.map((p) => ({ x: this.toX(p.time), y: this.toY(p.price) })); }

  handles(d) {
    const s = this.screenPoints(d);
    if (d.type === 'hline') return s[0].y == null ? [] : [{ x: this.el.clientWidth / 2, y: s[0].y, index: 0 }];
    return s.map((p, index) => ({ ...p, index })).filter((p) => p.x != null && p.y != null);
  }

  hitDrawing(d, x, y, tol) {
    const s = this.screenPoints(d);
    if (s.some((p) => p.y == null) || (d.type !== 'hline' && s.some((p) => p.x == null))) return false;
    switch (d.type) {
      case 'trend': return G.distToSegment(x, y, s[0].x, s[0].y, s[1].x, s[1].y) <= tol;
      case 'ray': return G.distToRay(x, y, s[0].x, s[0].y, s[1].x, s[1].y) <= tol;
      case 'hline': return Math.abs(y - s[0].y) <= tol;
      case 'fib': {
        const xl = Math.min(s[0].x, s[1].x), xr = Math.max(s[0].x, s[1].x);
        if (x < xl - tol || x > xr + tol) return false;
        return G.fibLevels(d.points[0].price, d.points[1].price).some((l) => { const ly = this.toY(l.price); return ly != null && Math.abs(y - ly) <= tol; })
          || G.distToSegment(x, y, s[0].x, s[0].y, s[1].x, s[1].y) <= tol;
      }
      case 'long': case 'short': {
        const xl = Math.min(s[0].x, s[1].x), xr = Math.max(s[0].x, s[1].x);
        const yt = Math.min(s[1].y, s[2].y), yb = Math.max(s[1].y, s[2].y);
        return x >= xl - tol && x <= xr + tol && y >= yt - tol && y <= yb + tol;
      }
      default: return false;
    }
  }

  /** @returns {{ d: any, kind: 'handle'|'body', index?: number }|null} */
  hit(x, y) {
    const tol = this.touch ? 12 : 6, htol = this.touch ? 16 : 9;
    const order = [...this.drawings].reverse(); // newest on top
    const sel = this.selectedDrawing();
    if (sel) for (const hd of this.handles(sel)) if (Math.hypot(hd.x - x, hd.y - y) <= htol) return { d: sel, kind: 'handle', index: hd.index };
    for (const d of order) for (const hd of this.handles(d)) if (Math.hypot(hd.x - x, hd.y - y) <= htol) return { d, kind: 'handle', index: hd.index };
    for (const d of order) if (this.hitDrawing(d, x, y, tol)) return { d, kind: 'body' };
    return null;
  }

  // ------------------------------------------------------------------ pointer handling
  grab() {
    this.swallow = true;
    this.engine.chart.applyOptions({ handleScroll: false, handleScale: false });
  }
  release() {
    this.swallow = false;
    this.engine.chart.applyOptions({ handleScroll: true, handleScale: true });
  }

  down(e) {
    if (e.button !== 0 && e.pointerType === 'mouse') return;
    if (this.hooks.hidden && this.hooks.hidden()) return;
    this.touch = e.pointerType !== 'mouse';
    const { x, y } = this.local(e);
    if (!this.inPricePane(x, y)) return;

    if (this.tool !== 'cursor') {
      const pt = this.fromXY(x, y);
      if (!pt) return;
      this.grab();
      e.preventDefault();
      if (!this.creating) {
        const n = G.TOOL_POINTS[this.tool];
        this.creating = { type: this.tool, points: [pt, pt], placed: 1 };
        if (n === 1) this.finishCreate();
      } else {
        this.creating.points[1] = pt;
        this.finishCreate();
      }
      this.requestUpdate();
      return;
    }

    const h = this.hit(x, y);
    if (!h) { if (this.selected) { this.selected = null; this.changed(false); } return; }
    this.grab();
    e.preventDefault();
    this.el.setPointerCapture && this.el.setPointerCapture(e.pointerId);
    this.selected = h.d.id;
    const p = this.fromXY(x, y, false);
    this.drag = { id: h.d.id, kind: h.kind, index: h.index, startL: p ? p.L : 0, startPrice: p ? p.price : 0, orig: JSON.parse(JSON.stringify(h.d.points)), moved: false };
    this.changed(false);
  }

  finishCreate() {
    const c = this.creating;
    const color = c.type === 'long' || c.type === 'short' ? css('--s1', '#3987e5') : css('--accent', '#f0b849');
    let points = c.type === 'hline' ? [c.points[0]] : c.points.map((p) => ({ time: p.time, price: p.price }));
    if (c.type === 'long' || c.type === 'short') points = G.defaultPosition(c.type, points[0], points[1]);
    const d = { id: uid(), type: c.type, points: points.map(({ time, price }) => ({ time, price })), color, width: c.type === 'fib' ? 1 : 2, created: Date.now() };
    this.creating = null;
    this.drawings.push(d);
    this.selected = d.id;
    this.tool = 'cursor';
    this.el.style.cursor = '';
    this.changed();
    this.hooks.onToolDone && this.hooks.onToolDone();
  }

  move(e) {
    const { x, y } = this.local(e);
    if (this.creating) {
      const pt = this.fromXY(x, y);
      if (pt) { this.creating.points[1] = pt; this.requestUpdate(); }
      return;
    }
    if (this.drag) {
      const d = this.drawings.find((q) => q.id === this.drag.id);
      if (!d) return;
      const b = this.bars();
      const dr = this.drag;
      if (dr.kind === 'handle') {
        const pt = this.fromXY(x, y);
        if (!pt) return;
        if (d.type === 'long' || d.type === 'short') {
          if (dr.index === 0) { d.points[0] = { time: pt.time, price: pt.price }; }
          else { d.points[dr.index].price = pt.price; d.points[1].time = d.points[2].time = Math.max(pt.time, d.points[0].time); }
        } else d.points[dr.index] = { time: pt.time, price: pt.price };
      } else {
        const p = this.fromXY(x, y, false);
        if (!p || !b) return;
        const dL = p.L - dr.startL, dP = p.price - dr.startPrice;
        d.points = dr.orig.map((o) => {
          const L0 = G.timeToLogical(o.time, b.cols.time, b.length, this.barSec);
          return { time: G.logicalToTime(Math.round(L0 + dL), b.cols.time, b.length, this.barSec), price: o.price + dP };
        });
      }
      dr.moved = true;
      this.requestUpdate();
      return;
    }
    if (e.pointerType === 'mouse' && this.tool === 'cursor' && !(this.hooks.hidden && this.hooks.hidden())) {
      const over = this.inPricePane(x, y) && this.hit(x, y);
      this.el.style.cursor = over ? (over.kind === 'handle' ? 'grab' : 'pointer') : '';
    }
  }

  up() {
    if (this.drag) {
      const moved = this.drag.moved;
      this.drag = null;
      if (moved) this.changed();
    }
    if (this.swallow && !this.creating) this.release();
    else if (this.creating) { this.swallow = false; } // keep pan disabled until the second click
  }

  key(e) {
    if (e.target && /^(INPUT|TEXTAREA|SELECT)$/.test(e.target.tagName)) return;
    if (!this.el.isConnected) return;
    if (e.key === 'Escape') {
      if (this.creating || this.tool !== 'cursor') { this.setTool('cursor'); this.release(); this.hooks.onToolDone && this.hooks.onToolDone(); }
      else if (this.selected) { this.selected = null; this.changed(false); }
      return;
    }
    if ((e.key === 'Delete' || e.key === 'Backspace') && this.selected) { e.preventDefault(); this.deleteSelected(); }
  }

  // ------------------------------------------------------------------ rendering
  draw(target) {
    if (this.hooks.hidden && this.hooks.hidden()) return;
    const list = this.creating ? [...this.drawings, this.previewDrawing()] : this.drawings;
    if (!list.length) return;
    target.useMediaCoordinateSpace(({ context: ctx, mediaSize }) => {
      ctx.save();
      ctx.font = `11px ${getComputedStyle(document.body).fontFamily}`;
      ctx.textBaseline = 'middle';
      for (const d of list) {
        try { this.drawOne(ctx, d, mediaSize); } catch (err) { console.error(err); }
      }
      ctx.restore();
    });
  }

  previewDrawing() {
    const c = this.creating;
    const color = css('--accent', '#f0b849');
    let points = c.points;
    if (c.type === 'long' || c.type === 'short') points = G.defaultPosition(c.type, c.points[0], c.points[1]);
    return { id: '__preview', type: c.type, points, color, width: c.type === 'fib' ? 1 : 2, preview: true };
  }

  label(ctx, text, x, y, color, align = 'left', bg = null) {
    ctx.textAlign = align;
    if (bg) {
      const w = ctx.measureText(text).width + 8;
      const x0 = align === 'left' ? x - 4 : align === 'right' ? x - w + 4 : x - w / 2;
      ctx.fillStyle = bg;
      ctx.fillRect(x0, y - 8, w, 16);
    }
    ctx.fillStyle = color;
    ctx.fillText(text, x, y);
  }

  drawOne(ctx, d, size) {
    const s = this.screenPoints(d);
    const W = size.width;
    const dec = this.engine.dec;
    const selected = d.id === this.selected || d.preview;
    ctx.strokeStyle = d.color;
    ctx.lineWidth = d.width;
    ctx.setLineDash(d.preview ? [5, 4] : []);
    const line = (ax, ay, bx, by) => { ctx.beginPath(); ctx.moveTo(ax, ay); ctx.lineTo(bx, by); ctx.stroke(); };

    switch (d.type) {
      case 'trend': if (s[0].x != null && s[1].x != null) line(s[0].x, s[0].y, s[1].x, s[1].y); break;
      case 'ray': if (s[0].x != null && s[1].x != null) { const [ex, ey] = G.rayEnd(s[0].x, s[0].y, s[1].x, s[1].y); line(s[0].x, s[0].y, ex, ey); } break;
      case 'hline': if (s[0].y != null) line(0, s[0].y, W, s[0].y); break;
      case 'fib': {
        if (s[0].x == null || s[1].x == null) break;
        const xl = Math.min(s[0].x, s[1].x), xr = Math.max(s[0].x, s[1].x);
        const lv = G.fibLevels(d.points[0].price, d.points[1].price);
        const palette = ['#787b86', '#f23645', '#ff9800', '#4caf50', '#089981', '#00bcd4', '#787b86', '#2962ff'];
        lv.forEach((l, i) => {
          const y = this.toY(l.price); if (y == null) return;
          const next = lv[i + 1] && this.toY(lv[i + 1].price);
          if (next != null && i < lv.length - 1) { ctx.fillStyle = hexA(palette[i + 1] || d.color, 0.07); ctx.fillRect(xl, Math.min(y, next), xr - xl, Math.abs(next - y)); }
          ctx.strokeStyle = palette[i] || d.color;
          ctx.lineWidth = d.width;
          line(xl, y, xr, y);
          // keep labels readable when the box's left edge is scrolled off-screen
          if (xr > 60) this.label(ctx, `${l.level} (${fmtNum(l.price, dec)})`, Math.max(xl, 56) + 4, y - 7, palette[i] || d.color);
        });
        ctx.strokeStyle = hexA('#787b86', 0.8); ctx.setLineDash([4, 4]); ctx.lineWidth = 1;
        line(s[0].x, s[0].y, s[1].x, s[1].y);
        ctx.setLineDash([]);
        break;
      }
      case 'long': case 'short': {
        if (s[0].x == null || s[1].x == null) break;
        const xl = s[0].x, xr = Math.max(s[1].x, s[0].x + 8);
        const [e, t, st] = d.points;
        const gain = css('--gain', '#2fcb92'), loss = css('--loss', '#ff7a73');
        ctx.fillStyle = hexA(gain, 0.18); ctx.fillRect(xl, Math.min(s[0].y, s[1].y), xr - xl, Math.abs(s[1].y - s[0].y));
        ctx.fillStyle = hexA(loss, 0.18); ctx.fillRect(xl, Math.min(s[0].y, s[2].y), xr - xl, Math.abs(s[2].y - s[0].y));
        ctx.strokeStyle = css('--ink-2', '#a9b9c9'); ctx.lineWidth = 1; line(xl, s[0].y, xr, s[0].y);
        const rr = G.riskReward(e.price, t.price, st.price);
        const cx = (xl + xr) / 2, ink = css('--ink', '#e8eef4'), bg = hexA(css('--bg', '#0d1b2a'), 0.85);
        this.label(ctx, `Target ${fmtNum(t.price, dec)} (${rr.rewardPct >= 0 ? '+' : ''}${rr.rewardPct.toFixed(2)}%)`, cx, s[1].y + (s[1].y < s[0].y ? 10 : -10), gain, 'center', bg);
        this.label(ctx, `Stop ${fmtNum(st.price, dec)} (${rr.riskPct >= 0 ? '+' : ''}${rr.riskPct.toFixed(2)}%)`, cx, s[2].y + (s[2].y > s[0].y ? -10 : 10), loss, 'center', bg);
        const side = rr.side === 'long' ? 'Long' : 'Short';
        this.label(ctx, rr.valid ? `${side} · Risk/reward ${Number.isFinite(rr.ratio) ? rr.ratio.toFixed(2) : '∞'}` : `${side} · stop is on the wrong side of entry`, cx, s[0].y + (rr.side === 'long' ? 10 : -10), rr.valid ? ink : loss, 'center', bg);
        break;
      }
      default: break;
    }

    if (selected && !d.preview) {
      const fill = css('--bg', '#0d1b2a');
      for (const hd of this.handles(d)) {
        ctx.beginPath();
        ctx.setLineDash([]);
        ctx.arc(hd.x, hd.y, HANDLE_R, 0, Math.PI * 2);
        ctx.fillStyle = fill; ctx.fill();
        ctx.lineWidth = 2; ctx.strokeStyle = d.color; ctx.stroke();
      }
    }
  }

  /** Price-axis labels: every horizontal level, and the points of the selected drawing. */
  axisViews() {
    if (this.hooks.hidden && this.hooks.hidden()) return [];
    const out = [];
    const dec = this.engine.dec;
    const add = (price, color) => {
      // read the coordinate when the axis paints, not now: the price scale may have moved since
      out.push({ coordinate: () => this.toY(price) ?? -1000, text: () => fmtNum(price, dec), textColor: () => '#ffffff', backColor: () => color, visible: () => this.toY(price) != null, tickVisible: () => true });
    };
    for (const d of this.drawings) {
      if (d.type === 'hline') add(d.points[0].price, d.color);
      else if (d.id === this.selected) d.points.forEach((p) => add(p.price, d.color));
    }
    return out;
  }

  dispose() {
    this.flushSave();
    for (const [t, f] of this.on) this.el.removeEventListener(t, f, { capture: true });
    removeEventListener('keydown', this.onKey);
  }
}
