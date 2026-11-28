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
    this.boxes = new Map(); // text-note boxes from the last paint, for hit-testing

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
      ['dblclick', (e) => this.dbl(e)],
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

  flushSave(force = false) {
    if ((!this.saveTimer && !force) || !this.symbol) return;
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
  /** Width of a left price scale: pane x = element x minus this. */
  leftScale() { const ps = this.engine.chart.priceScale('left'); return ps.options().visible ? ps.width() : 0; }
  local(e) { const r = this.el.getBoundingClientRect(); return { x: e.clientX - r.left - this.leftScale(), y: e.clientY - r.top }; }
  inPricePane(x, y) {
    const panes = this.engine.chart.panes();
    const h0 = panes.length ? panes[0].getHeight() : 0;
    const right = this.engine.chart.priceScale('right');
    const w = this.el.clientWidth - this.leftScale() - (right.options().visible ? right.width() : 0);
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
    if (d.type === 'vline') return s[0].x == null ? [] : [{ x: s[0].x, y: (this.paneHeight ? this.paneHeight() : this.el.clientHeight) / 2, index: 0 }];
    return s.map((p, index) => ({ ...p, index })).filter((p) => p.x != null && p.y != null);
  }

  hitDrawing(d, x, y, tol) {
    const s = this.screenPoints(d);
    if ((d.type !== 'vline' && s.some((p) => p.y == null)) || (d.type !== 'hline' && s.some((p) => p.x == null))) return false;
    switch (d.type) {
      case 'trend': return G.distToSegment(x, y, s[0].x, s[0].y, s[1].x, s[1].y) <= tol;
      case 'ray': return G.distToRay(x, y, s[0].x, s[0].y, s[1].x, s[1].y) <= tol;
      case 'hline': return Math.abs(y - s[0].y) <= tol;
      case 'extline': return G.distToLine(x, y, s[0].x, s[0].y, s[1].x, s[1].y) <= tol;
      case 'infoline': case 'angle': case 'arrow': return G.distToSegment(x, y, s[0].x, s[0].y, s[1].x, s[1].y) <= tol;
      case 'hray': return Math.abs(y - s[0].y) <= tol && x >= s[0].x - tol;
      case 'vline': return Math.abs(x - s[0].x) <= tol;
      case 'cross': return Math.abs(y - s[0].y) <= tol || Math.abs(x - s[0].x) <= tol;
      case 'rect': case 'measure': {
        const xl = Math.min(s[0].x, s[1].x), xr = Math.max(s[0].x, s[1].x), yt = Math.min(s[0].y, s[1].y), yb = Math.max(s[0].y, s[1].y);
        return x >= xl - tol && x <= xr + tol && y >= yt - tol && y <= yb + tol;
      }
      case 'channel': {
        const off = G.channelOffset(...d.points);
        const q1 = this.toY(d.points[0].price + off), q2 = this.toY(d.points[1].price + off);
        if (q1 == null || q2 == null) return false;
        if (G.distToSegment(x, y, s[0].x, s[0].y, s[1].x, s[1].y) <= tol || G.distToSegment(x, y, s[0].x, q1, s[1].x, q2) <= tol) return true;
        // inside the band
        const xl = Math.min(s[0].x, s[1].x), xr = Math.max(s[0].x, s[1].x);
        if (x < xl || x > xr || xr === xl) return false;
        const f = (x - s[0].x) / (s[1].x - s[0].x);
        const ya = s[0].y + f * (s[1].y - s[0].y), yb = q1 + f * (q2 - q1);
        return y >= Math.min(ya, yb) && y <= Math.max(ya, yb);
      }
      case 'text': {
        const b = this.boxes.get(d.id);
        return !!b && x >= b.x - tol && x <= b.x + b.w + tol && y >= b.y - tol && y <= b.y + b.h + tol;
      }
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
      const n = G.TOOL_POINTS[this.tool];
      if (!this.creating) {
        // points[placed] is the preview point that follows the pointer
        this.creating = { type: this.tool, points: [pt, pt], placed: 1 };
        if (n === 1) this.finishCreate();
      } else {
        const c = this.creating;
        c.points[c.placed] = pt;
        c.placed++;
        if (c.placed >= n) this.finishCreate();
        else c.points.push(pt);
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
    const n = G.TOOL_POINTS[c.type];
    const color = c.type === 'long' || c.type === 'short' || c.type === 'channel' ? css('--s1', '#3987e5') : css('--accent', '#f0b849');
    let points = c.points.slice(0, n).map(({ time, price }) => ({ time, price }));
    if (c.type === 'long' || c.type === 'short') points = G.defaultPosition(c.type, points[0], points[1]);
    const d = { id: uid(), type: c.type, points, color, width: c.type === 'fib' || c.type === 'text' ? 1 : 2, dash: 'solid', created: Date.now() };
    const def = this.hooks.defaultStyle && this.hooks.defaultStyle(c.type);
    if (def) Object.assign(d, { color: def.color, width: def.width, dash: def.dash });
    this.creating = null;
    this.tool = 'cursor';
    this.el.style.cursor = '';
    if (c.type === 'text') {
      // the note's words come from a dialog; nothing is added if it is cancelled or empty
      this.release();
      const ask = this.hooks.askText ? this.hooks.askText('') : Promise.resolve(null);
      ask.then((text) => {
        if (text) { d.text = text; this.drawings.push(d); this.selected = d.id; }
        this.changed(!!text);
      });
      this.hooks.onToolDone && this.hooks.onToolDone();
      return;
    }
    this.drawings.push(d);
    this.selected = d.id;
    this.changed();
    this.hooks.onToolDone && this.hooks.onToolDone();
  }

  /** Double-click a text note to change its words. */
  dbl(e) {
    const { x, y } = this.local(e);
    const h = this.inPricePane(x, y) && this.hit(x, y);
    if (!h || h.d.type !== 'text' || !this.hooks.askText) return;
    e.stopPropagation();
    this.hooks.askText(h.d.text || '').then((text) => {
      if (text === null) return;
      if (!text) { this.selected = h.d.id; this.deleteSelected(); return; }
      h.d.text = text; this.changed();
    });
  }

  move(e) {
    const { x, y } = this.local(e);
    if (this.creating) {
      const pt = this.fromXY(x, y);
      if (pt) { const c = this.creating; c.points[c.points.length - 1] = pt; this.requestUpdate(); }
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
    if (c.type === 'channel' && points.length < 3) return { id: '__preview', type: 'trend', points, color, width: 2, preview: true };
    return { id: '__preview', type: c.type, points, color, width: c.type === 'fib' ? 1 : 2, preview: true, text: '…' };
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
    const dash = d.preview ? [5, 4] : d.dash === 'dashed' ? [7, 5] : d.dash === 'dotted' ? [1.5, 3.5] : [];
    ctx.setLineDash(dash);
    const line = (ax, ay, bx, by) => { ctx.beginPath(); ctx.moveTo(ax, ay); ctx.lineTo(bx, by); ctx.stroke(); };

    switch (d.type) {
      case 'trend': if (s[0].x != null && s[1].x != null) line(s[0].x, s[0].y, s[1].x, s[1].y); break;
      case 'ray': if (s[0].x != null && s[1].x != null) { const [ex, ey] = G.rayEnd(s[0].x, s[0].y, s[1].x, s[1].y); line(s[0].x, s[0].y, ex, ey); } break;
      case 'hline': if (s[0].y != null) line(0, s[0].y, W, s[0].y); break;
      case 'extline': {
        if (s[0].x == null || s[1].x == null) break;
        const [ax, ay] = G.rayEnd(s[1].x, s[1].y, s[0].x, s[0].y), [bx, by] = G.rayEnd(s[0].x, s[0].y, s[1].x, s[1].y);
        line(ax, ay, bx, by); break;
      }
      case 'hray': if (s[0].x != null && s[0].y != null) line(s[0].x, s[0].y, W, s[0].y); break;
      case 'vline': if (s[0].x != null) line(s[0].x, 0, s[0].x, size.height); break;
      case 'cross': if (s[0].x != null && s[0].y != null) { line(0, s[0].y, W, s[0].y); line(s[0].x, 0, s[0].x, size.height); } break;
      case 'arrow': {
        if (s[0].x == null || s[1].x == null) break;
        line(s[0].x, s[0].y, s[1].x, s[1].y);
        const a = Math.atan2(s[1].y - s[0].y, s[1].x - s[0].x), k = 10 + d.width * 2;
        ctx.setLineDash([]);
        line(s[1].x, s[1].y, s[1].x - k * Math.cos(a - 0.45), s[1].y - k * Math.sin(a - 0.45));
        line(s[1].x, s[1].y, s[1].x - k * Math.cos(a + 0.45), s[1].y - k * Math.sin(a + 0.45));
        break;
      }
      case 'infoline': case 'angle': {
        if (s[0].x == null || s[1].x == null) break;
        line(s[0].x, s[0].y, s[1].x, s[1].y);
        const bg = hexA(css('--bg', '#0d1b2a'), 0.85), ink = css('--ink', '#e8eef4');
        if (d.type === 'angle') {
          ctx.setLineDash([3, 3]); ctx.lineWidth = 1; line(s[0].x, s[0].y, s[0].x + 60, s[0].y); ctx.setLineDash([]);
          this.label(ctx, `${G.screenAngle(s[0].x, s[0].y, s[1].x, s[1].y).toFixed(1)}°`, s[0].x + 64, s[0].y - 10, ink, 'left', bg);
        } else {
          const m = G.measure(d.points[0], d.points[1], this.barSec);
          this.label(ctx, `${m.change >= 0 ? '+' : ''}${fmtNum(m.change, dec)} (${m.pct >= 0 ? '+' : ''}${m.pct.toFixed(2)}%) · ${m.bars} bars`, s[1].x + 6, s[1].y - 10, ink, 'left', bg);
        }
        break;
      }
      case 'rect': case 'measure': {
        if (s[0].x == null || s[1].x == null) break;
        const xl = Math.min(s[0].x, s[1].x), yt = Math.min(s[0].y, s[1].y), w = Math.abs(s[1].x - s[0].x), hgt = Math.abs(s[1].y - s[0].y);
        if (d.type === 'rect') {
          ctx.fillStyle = hexA(d.color, 0.12); ctx.fillRect(xl, yt, w, hgt); ctx.strokeRect(xl, yt, w, hgt); break;
        }
        const m = G.measure(d.points[0], d.points[1], this.barSec);
        const col = m.change >= 0 ? css('--gain', '#2fcb92') : css('--loss', '#ff7a73');
        ctx.fillStyle = hexA(col, 0.16); ctx.fillRect(xl, yt, w, hgt);
        ctx.strokeStyle = col; ctx.lineWidth = 1; ctx.setLineDash([]);
        line(s[0].x, (s[0].y + s[1].y) / 2, s[1].x, (s[0].y + s[1].y) / 2); line((s[0].x + s[1].x) / 2, s[0].y, (s[0].x + s[1].x) / 2, s[1].y);
        const span = m.days >= 1 ? `${m.bars} bars, ${Math.round(Math.abs(m.days))}d` : `${m.bars} bars`;
        this.label(ctx, `${m.change >= 0 ? '+' : ''}${fmtNum(m.change, dec)} (${m.pct >= 0 ? '+' : ''}${m.pct.toFixed(2)}%) · ${span}`, xl + w / 2, s[1].y + (s[1].y > s[0].y ? 12 : -12), css('--ink', '#e8eef4'), 'center', hexA(css('--bg', '#0d1b2a'), 0.85));
        break;
      }
      case 'channel': {
        if (s.some((p) => p.x == null || p.y == null)) break;
        const off = G.channelOffset(...d.points);
        const q1 = this.toY(d.points[0].price + off), q2 = this.toY(d.points[1].price + off);
        if (q1 == null || q2 == null) break;
        ctx.fillStyle = hexA(d.color, 0.1);
        ctx.beginPath(); ctx.moveTo(s[0].x, s[0].y); ctx.lineTo(s[1].x, s[1].y); ctx.lineTo(s[1].x, q2); ctx.lineTo(s[0].x, q1); ctx.closePath(); ctx.fill();
        line(s[0].x, s[0].y, s[1].x, s[1].y);
        line(s[0].x, q1, s[1].x, q2);
        ctx.setLineDash([4, 4]); ctx.lineWidth = 1;
        line(s[0].x, (s[0].y + q1) / 2, s[1].x, (s[1].y + q2) / 2); // midline
        ctx.setLineDash([]);
        break;
      }
      case 'text': {
        if (s[0].x == null || s[0].y == null) break;
        const fam = getComputedStyle(document.body).fontFamily;
        ctx.font = `13px ${fam}`;
        const lines = String(d.text || '').split('\n').slice(0, 8);
        const w = Math.max(...lines.map((t) => ctx.measureText(t).width)) + 14, lh = 17, hgt = lines.length * lh + 8;
        const bx = s[0].x, by = s[0].y - hgt / 2;
        ctx.fillStyle = hexA(css('--bg', '#0d1b2a'), 0.86); ctx.fillRect(bx, by, w, hgt);
        ctx.strokeStyle = d.color; ctx.lineWidth = 1; ctx.strokeRect(bx + 0.5, by + 0.5, w - 1, hgt - 1);
        ctx.fillStyle = css('--ink', '#e8eef4'); ctx.textAlign = 'left';
        lines.forEach((t, i) => ctx.fillText(t, bx + 7, by + 4 + lh / 2 + i * lh));
        ctx.font = `11px ${fam}`;
        if (!d.preview) this.boxes.set(d.id, { x: bx, y: by, w, h: hgt });
        break;
      }
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
      if (d.type === 'hline' || d.type === 'hray' || d.type === 'cross') add(d.points[0].price, d.color);
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
