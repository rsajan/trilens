// Chart engine: everything that touches lightweight-charts lives here. The page hands it bars and
// Pine results; it owns panes, series, markers, price lines and the legend.
//
// Rules that keep it fast:
//  - live ticks are coalesced into one requestAnimationFrame flush (never one draw per message);
//  - a study whose shape did not change gets setData() only when its length changed, otherwise
//    just update() of its last point;
//  - the legend is a fixed set of text nodes rewritten in place, never rebuilt on crosshair moves.

import { createChart, CandlestickSeries, HistogramSeries, LineSeries, AreaSeries, CrosshairMode, LineStyle, LineType, createSeriesMarkers } from '../../../vendor/lightweight-charts/lightweight-charts.mjs';
import { toCss } from '../pine/colors.js';
import { h, clear } from '../../lib/dom.js';

/** @typedef {import('../data/bar-buffer.js').BarBuffer} BarBuffer */

const css = (name) => getComputedStyle(document.documentElement).getPropertyValue(name).trim();
const decimalsOf = (tick) => { const s = String(tick); return s.includes('e-') ? +s.split('e-')[1] : (s.split('.')[1] || '').length; };
const withAlpha = (c, a) => { const x = toCss(c.length === 7 ? c + 'ff' : c); return x ? x.replace(/[\d.]+\)$/, a + ')') : c; };

export function fmtNum(v, dec) {
  if (!Number.isFinite(v)) return '∅';
  const a = Math.abs(v);
  if (dec == null) dec = a >= 1000 ? 2 : a >= 1 ? 2 : 4;
  return v.toLocaleString('en-US', { minimumFractionDigits: dec, maximumFractionDigits: dec });
}
export function fmtVol(v) {
  if (!Number.isFinite(v)) return '∅';
  const a = Math.abs(v);
  for (const [d, s] of [[1e12, 'T'], [1e9, 'B'], [1e6, 'M'], [1e3, 'K']]) if (a >= d) return (v / d).toFixed(2) + s;
  return v.toFixed(a < 10 ? 2 : 0);
}

const SHAPE = {
  triangleup: ['arrowUp', 'belowBar'], arrowup: ['arrowUp', 'belowBar'], labelup: ['arrowUp', 'belowBar'],
  triangledown: ['arrowDown', 'aboveBar'], arrowdown: ['arrowDown', 'aboveBar'], labeldown: ['arrowDown', 'aboveBar'],
  circle: ['circle', null], square: ['square', null], diamond: ['square', null], flag: ['square', null],
  cross: ['circle', null], xcross: ['circle', null], char: ['circle', null],
};
const LOC = { abovebar: 'aboveBar', belowbar: 'belowBar', top: 'aboveBar', bottom: 'belowBar' };
const SIZE = { auto: 1, tiny: 0.6, small: 0.8, normal: 1, large: 1.5, huge: 2 };

export class ChartEngine {
  /**
   * @param {HTMLElement} host
   * @param {{ onNeedHistory?: () => void, onStudyAction?: (uid: string, action: 'hide'|'settings'|'remove'|'edit') => void }} hooks
   */
  constructor(host, hooks = {}) {
    this.host = host;
    this.hooks = hooks;
    this.buf = null;
    this.dec = 2;
    this.symbolLabel = '';
    /** @type {Map<string, any>} */
    this.studies = new Map();
    this.pendingLive = false;
    this.hoverIndex = -1;
    this.barColors = null;
    this.raf = 0;
    this.disposed = false; // async results (Pine runs, frames) can land after the page left

    this.chartEl = h('div', { class: 'cx-canvas' });
    this.legendEl = h('div', { class: 'cx-legends' });
    host.append(this.chartEl, this.legendEl);

    this.chart = createChart(this.chartEl, { autoSize: true, ...this.themeOptions() });
    this.candles = this.chart.addSeries(CandlestickSeries, { priceLineVisible: true, lastValueVisible: true });
    this.volume = this.chart.addSeries(HistogramSeries, { priceScaleId: 'vol', priceFormat: { type: 'volume' }, lastValueVisible: false, priceLineVisible: false });
    this.chart.priceScale('vol').applyOptions({ scaleMargins: { top: 0.82, bottom: 0 }, visible: false });
    this.candleMarkers = createSeriesMarkers(this.candles, []);
    this.applyTheme();

    this.mainLegend = this.buildMainLegend();
    this.chart.subscribeCrosshairMove((p) => {
      const idx = p && p.logical !== undefined && p.logical !== null ? Math.round(p.logical) : -1;
      if (idx !== this.hoverIndex) { this.hoverIndex = idx; this.scheduleLegend(); }
    });
    this.chart.timeScale().subscribeVisibleLogicalRangeChange((r) => {
      if (r && r.from < 25 && this.hooks.onNeedHistory) this.hooks.onNeedHistory();
    });
    this.paneTimer = setInterval(() => this.layoutLegends(), 400);
  }

  themeOptions() {
    const ink3 = css('--ink-3') || '#7f95ab';
    const grid = css('--line-soft') || '#1d3349';
    return {
      layout: { background: { color: css('--bg') || '#0d1b2a' }, textColor: css('--ink-2') || '#a9b9c9', fontFamily: getComputedStyle(document.body).fontFamily, fontSize: 11, attributionLogo: true, panes: { separatorColor: css('--line') || '#27425c', separatorHoverColor: css('--accent-soft') || 'rgba(240,184,73,.14)', enableResize: true } },
      grid: { vertLines: { color: grid }, horzLines: { color: grid } },
      crosshair: { mode: CrosshairMode.Normal, vertLine: { color: ink3, labelBackgroundColor: css('--surface-3') || '#223a54' }, horzLine: { color: ink3, labelBackgroundColor: css('--surface-3') || '#223a54' } },
      rightPriceScale: { borderColor: css('--line') || '#27425c' },
      timeScale: { borderColor: css('--line') || '#27425c', timeVisible: true, secondsVisible: false, rightOffset: 8, barSpacing: 7 },
    };
  }

  applyTheme() {
    this.chart.applyOptions(this.themeOptions());
    const up = css('--gain') || '#2fcb92', dn = css('--loss') || '#ff7a73';
    this.upColor = up; this.downColor = dn;
    this.candles.applyOptions({ upColor: up, downColor: dn, borderUpColor: up, borderDownColor: dn, wickUpColor: up, wickDownColor: dn });
    this.volUp = withAlpha(up, 0.35); this.volDn = withAlpha(dn, 0.35);
    if (this.buf) this.setVolume();
  }

  // ------------------------------------------------------------------ price data
  /** @param {BarBuffer} buf @param {{ tick: number, label: string }} info */
  setBars(buf, info, { keepRange = false, shiftBy = 0 } = {}) {
    this.buf = buf;
    this.dec = decimalsOf(info.tick);
    this.symbolLabel = info.label;
    this.candles.applyOptions({ priceFormat: { type: 'price', precision: this.dec, minMove: info.tick } });
    const range = keepRange ? this.chart.timeScale().getVisibleLogicalRange() : null;
    this.setCandles();
    this.setVolume();
    if (range) this.chart.timeScale().setVisibleLogicalRange({ from: range.from + shiftBy, to: range.to + shiftBy });
    this.mainLegend.symbol.textContent = info.label;
    this.scheduleLegend();
  }

  setCandles() {
    const c = this.buf.cols, n = this.buf.length, bc = this.barColors;
    const data = new Array(n);
    for (let i = 0; i < n; i++) {
      const d = { time: c.time[i], open: c.open[i], high: c.high[i], low: c.low[i], close: c.close[i] };
      if (bc && bc[i]) { d.color = bc[i]; d.borderColor = bc[i]; d.wickColor = bc[i]; }
      data[i] = d;
    }
    this.candles.setData(data);
  }

  setVolume() {
    const c = this.buf.cols, n = this.buf.length;
    const data = new Array(n);
    for (let i = 0; i < n; i++) data[i] = { time: c.time[i], value: c.volume[i], color: c.close[i] >= c.open[i] ? this.volUp : this.volDn };
    this.volume.setData(data);
  }

  /** A live tick changed (or appended) the newest bar: draw it on the next frame. */
  liveUpdate() {
    if (this.pendingLive || this.disposed) return;
    this.pendingLive = true;
    requestAnimationFrame(() => {
      this.pendingLive = false;
      if (this.disposed) return;
      const i = this.buf.length - 1;
      if (i < 0) return;
      const c = this.buf.cols;
      const d = { time: c.time[i], open: c.open[i], high: c.high[i], low: c.low[i], close: c.close[i] };
      const bc = this.barColors && this.barColors[i];
      if (bc) { d.color = bc; d.borderColor = bc; d.wickColor = bc; }
      this.candles.update(d);
      this.volume.update({ time: c.time[i], value: c.volume[i], color: c.close[i] >= c.open[i] ? this.volUp : this.volDn });
      this.scheduleLegend();
    });
  }

  // ------------------------------------------------------------------ studies
  /**
   * Draw (or redraw) a study from a Pine run result.
   * @param {string} uid
   * @param {any} res  runtime result
   * @param {{ hidden: boolean, styles: Record<string, {color?: string, hidden?: boolean}>, label: string, inputsLabel: string, error?: string }} cfg
   */
  renderStudy(uid, res, cfg) {
    if (this.disposed) return;
    let s = this.studies.get(uid);
    const overlay = !!(res && res.meta && res.meta.overlay);
    const shapeKey = res && res.meta ? JSON.stringify([overlay, res.plots.map((p) => [p.title, p.style]), res.hlines.map((l) => [l.price, l.color, l.style]), !!res.bgcolors]) : 'error';
    if (s && (s.shapeKey !== shapeKey || s.hidden !== cfg.hidden)) { this.dropStudySeries(s); s.series = null; }
    if (!s) {
      s = { uid, series: null, pane: null, overlay, res: null, cfg, legend: null, shapeKey, bg: null, markers: null, lines: [], hidden: cfg.hidden };
      this.studies.set(uid, s);
    }
    s.cfg = cfg; s.shapeKey = shapeKey; s.overlay = overlay; s.hidden = cfg.hidden;
    const prev = s.res;
    s.res = res;
    if (!res || !res.meta || cfg.hidden) {
      this.dropStudySeries(s); s.series = null; s.legendKey = null;
      this.updateBarColors();
      this.updateOverlayMarkers();
      this.buildLegends();
      return;
    }
    if (!s.series) this.createStudySeries(s);
    this.fillStudySeries(s, prev);
    this.updateBarColors();
    this.updateOverlayMarkers();
    const legendKey = JSON.stringify([cfg.label, cfg.inputsLabel, cfg.error || '', cfg.styles, res.plots.map((p) => [p.title, p.color, p.hidden])]);
    if (!s.legend || s.legendKey !== legendKey) { s.legendKey = legendKey; this.buildLegends(); }
    this.scheduleLegend();
  }

  createStudySeries(s) {
    const res = s.res;
    s.filled = false;
    let paneIndex = 0;
    if (!s.overlay) {
      if (!s.pane) {
        const pane = this.chart.addPane(true);
        pane.setStretchFactor(0.42);
        s.pane = pane;
      }
      paneIndex = s.pane.paneIndex();
    }
    const fmt = { type: 'price', precision: res.meta.precision ?? (s.overlay ? this.dec : 2), minMove: 10 ** -(res.meta.precision ?? (s.overlay ? this.dec : 2)) };
    if (res.bgcolors) {
      s.bg = this.chart.addSeries(HistogramSeries, { priceScaleId: 'bg-' + s.uid, lastValueVisible: false, priceLineVisible: false, base: 0 }, paneIndex);
      this.chart.priceScale('bg-' + s.uid, paneIndex).applyOptions({ scaleMargins: { top: 0, bottom: 0 }, visible: false });
      s.bg.setSeriesOrder(0);
    }
    s.series = res.plots.map((p) => {
      const st = s.cfg.styles[p.title] || {};
      const color = toCss(st.color || p.color) || '#2962ff';
      const common = { priceFormat: fmt, lastValueVisible: !p.hidden && !st.hidden, priceLineVisible: false, title: '', visible: !p.hidden && !st.hidden };
      let api;
      if (p.style === 'histogram' || p.style === 'columns') api = this.chart.addSeries(HistogramSeries, { ...common, color, base: 0 }, paneIndex);
      else if (p.style === 'area') api = this.chart.addSeries(AreaSeries, { ...common, lineColor: color, topColor: withAlpha(color, 0.28), bottomColor: withAlpha(color, 0.02), lineWidth: p.linewidth }, paneIndex);
      else api = this.chart.addSeries(LineSeries, { ...common, color, lineWidth: p.linewidth, lineType: p.style === 'step' ? LineType.WithSteps : LineType.Simple, lineVisible: p.style !== 'circles', pointMarkersVisible: p.style === 'circles', crosshairMarkerVisible: p.style !== 'circles' }, paneIndex);
      return { plot: p, api, color: st.color ? toCss(st.color) : null };
    });
    // a pane needs at least one series to host hlines and markers
    if (!s.series.length && (res.hlines.length || res.shapes.length)) {
      const api = this.chart.addSeries(LineSeries, { lastValueVisible: false, priceLineVisible: false, color: 'rgba(0,0,0,0)' }, paneIndex);
      s.series.push({ plot: null, api, color: null });
    }
    const host = s.series[0] ? s.series[0].api : null;
    s.lines = host ? res.hlines.map((l) => host.createPriceLine({ price: l.price, color: toCss(l.color), lineWidth: Math.max(1, Math.min(4, l.width)), lineStyle: l.style === 'solid' ? LineStyle.Solid : l.style === 'dotted' ? LineStyle.Dotted : LineStyle.Dashed, axisLabelVisible: true, title: '' })) : [];
    s.markers = !s.overlay && host && res.shapes.length ? createSeriesMarkers(host, []) : null;
  }

  dropStudySeries(s) {
    if (s.series) for (const x of s.series) this.chart.removeSeries(x.api);
    if (s.bg) { this.chart.removeSeries(s.bg); s.bg = null; }
    if (s.markers) { s.markers.detach(); s.markers = null; }
    s.lines = [];
    if (s.pane) {
      const idx = s.pane.paneIndex();
      if (idx > 0) this.chart.removePane(idx);
      s.pane = null;
    }
    s.legend = null;
  }

  fillStudySeries(s, prev) {
    const res = s.res, t = this.buf.cols.time, n = this.buf.length;
    const sameLen = prev && prev.bars === res.bars && prev.firstTime === res.firstTime && s.filled;
    s.series.forEach((x, k) => {
      if (!x.plot) { if (!sameLen) x.api.setData(Array.from({ length: n }, (_, i) => ({ time: t[i] }))); return; }
      // always read the *current* result: plot arrays are replaced on every run
      const p = res.plots[k];
      x.plot = p;
      const v = p.values, cols = p.colors, off = p.offset || 0;
      const point = (i) => {
        const j = i + off;
        if (j < 0 || j >= n) return null;
        const val = v[i];
        if (!Number.isFinite(val) || (cols && cols[i] === null)) return { time: t[j] };
        const d = { time: t[j], value: val };
        if (cols && !x.color) d.color = toCss(cols[i]);
        return d;
      };
      if (sameLen) {
        // only the newest point may change between runs of the same length (the chart library
        // can only update its last point); a new bar changes the length and takes the setData path
        const d = point(res.bars - 1 - Math.max(0, off)); if (d) x.api.update(d);
      } else {
        const data = [];
        for (let i = 0; i < res.bars; i++) { const d = point(i); if (d) data.push(d); }
        x.api.setData(data);
      }
    });
    if (s.bg) {
      const bg = res.bgcolors;
      const pt = (i) => (bg[i] ? { time: t[i], value: 1, color: toCss(bg[i]) } : { time: t[i] });
      if (sameLen) s.bg.update(pt(res.bars - 1));
      else s.bg.setData(Array.from({ length: Math.min(res.bars, n) }, (_, i) => pt(i)));
    }
    if (s.markers) s.markers.setMarkers(this.shapeMarkers(res, s.cfg));
    s.filled = true;
  }

  shapeMarkers(res, cfg) {
    const t = this.buf.cols.time, n = this.buf.length, out = [];
    for (const sh of res.shapes) {
      if ((cfg.styles[sh.title] || {}).hidden) continue;
      const [shape, defPos] = SHAPE[sh.style] || ['circle', null];
      const pos = LOC[sh.location] || defPos || 'aboveBar';
      for (const p of sh.points) {
        if (p.i >= n) continue;
        const m = { time: t[p.i], shape, color: toCss((cfg.styles[sh.title] || {}).color || p.color), size: SIZE[sh.size] || 1, text: sh.text || '' };
        if (sh.location === 'absolute' && Number.isFinite(p.price)) { m.position = 'atPriceMiddle'; m.price = p.price; }
        else m.position = pos;
        out.push(m);
      }
    }
    return out.sort((a, b) => a.time - b.time);
  }

  updateOverlayMarkers() {
    const all = [];
    for (const s of this.studies.values()) if (s.overlay && s.res && s.res.meta && !s.hidden) all.push(...this.shapeMarkers(s.res, s.cfg));
    all.sort((a, b) => a.time - b.time);
    this.candleMarkers.setMarkers(all);
  }

  updateBarColors() {
    let bc = null;
    for (const s of this.studies.values()) if (s.res && s.res.barcolors && !s.hidden) bc = s.res.barcolors.map((c) => (c ? toCss(c) : null));
    const changed = JSON.stringify(bc) !== JSON.stringify(this.barColors);
    this.barColors = bc;
    if (changed && this.buf) this.setCandles();
  }

  removeStudy(uid) {
    if (this.disposed) return;
    const s = this.studies.get(uid);
    if (!s) return;
    this.dropStudySeries(s);
    this.studies.delete(uid);
    this.updateBarColors();
    this.updateOverlayMarkers();
    this.buildLegends();
  }

  // ------------------------------------------------------------------ legend
  buildMainLegend() {
    const mk = (cls) => h('span', { class: cls });
    const symbol = mk('cx-sym');
    const o = mk('v'), hi = mk('v'), lo = mk('v'), c = mk('v'), ch = mk('v'), vol = mk('v');
    const row = h('div', { class: 'cx-ohlc num' }, symbol, h('span', { class: 'k' }, 'O'), o, h('span', { class: 'k' }, 'H'), hi, h('span', { class: 'k' }, 'L'), lo, h('span', { class: 'k' }, 'C'), c, ch, h('span', { class: 'k' }, 'Vol'), vol);
    const box = h('div', { class: 'cx-legend' }, row);
    const studies = h('div', { class: 'cx-legend-studies' });
    box.append(studies);
    this.legendEl.append(box);
    return { box, symbol, o, hi, lo, c, ch, vol, studies, panes: new Map() };
  }

  /** Rebuild the legend rows (only when studies are added/removed/reshaped). */
  buildLegends() {
    clear(this.mainLegend.studies);
    for (const el of this.mainLegend.panes.values()) el.remove();
    this.mainLegend.panes.clear();
    for (const s of this.studies.values()) {
      const vals = (s.res && s.res.plots ? s.res.plots : []).map((p, idx) => ({ p, idx })).filter(({ p }) => !p.hidden && !(s.cfg.styles[p.title] || {}).hidden).map(({ p, idx }) => {
        const el = h('span', { class: 'v' });
        el.style.color = toCss((s.cfg.styles[p.title] || {}).color || p.color) || '';
        return { idx, el };
      });
      const act = (a, label, glyph) => h('button', { type: 'button', class: 'cx-act', title: label, 'aria-label': label, onClick: (e) => { e.stopPropagation(); this.hooks.onStudyAction && this.hooks.onStudyAction(s.uid, a); } }, glyph);
      const err = s.cfg.error ? h('span', { class: 'cx-err', title: s.cfg.error }, '⚠ ' + s.cfg.error.slice(0, 80)) : null;
      const row = h('div', { class: 'cx-study' + (s.hidden ? ' off' : '') },
        h('span', { class: 'cx-name' }, s.cfg.label), s.cfg.inputsLabel ? h('span', { class: 'cx-in' }, s.cfg.inputsLabel) : null,
        ...vals.map((x) => x.el), err,
        h('span', { class: 'cx-acts' }, act('hide', s.hidden ? 'Show' : 'Hide', s.hidden ? '◌' : '◉'), act('settings', 'Settings', '⚙'), act('edit', 'Open in Pine editor', '{}'), act('remove', 'Remove', '✕')));
      s.legend = { row, vals };
      if (s.overlay || !s.pane) this.mainLegend.studies.append(row);
      else {
        const box = h('div', { class: 'cx-legend pane' }, row);
        this.legendEl.append(box);
        this.mainLegend.panes.set(s.uid, box);
      }
    }
    this.layoutLegends();
    this.scheduleLegend();
  }

  layoutLegends() {
    if (this.disposed) return;
    const panes = this.chart.panes();
    const tops = []; let y = 0;
    for (const p of panes) { tops.push(y); y += p.getHeight() + 1; }
    for (const [uidv, box] of this.mainLegend.panes) {
      const s = this.studies.get(uidv);
      if (!s || !s.pane) continue;
      const idx = s.pane.paneIndex();
      box.style.top = (tops[idx] ?? 0) + 4 + 'px';
    }
  }

  scheduleLegend() {
    if (this.raf) return;
    this.raf = requestAnimationFrame(() => { this.raf = 0; if (!this.disposed) this.paintLegend(); });
  }

  paintLegend() {
    const b = this.buf;
    if (!b || !b.length) return;
    const i = this.hoverIndex >= 0 && this.hoverIndex < b.length ? this.hoverIndex : b.length - 1;
    const c = b.cols, L = this.mainLegend, d = this.dec;
    L.o.textContent = fmtNum(c.open[i], d); L.hi.textContent = fmtNum(c.high[i], d); L.lo.textContent = fmtNum(c.low[i], d); L.c.textContent = fmtNum(c.close[i], d);
    const prev = i > 0 ? c.close[i - 1] : c.open[i];
    const chg = c.close[i] - prev;
    L.ch.textContent = (chg >= 0 ? '+' : '') + fmtNum(chg, d) + ' (' + (chg >= 0 ? '+' : '') + (prev ? (chg / prev * 100).toFixed(2) : '0.00') + '%)';
    const cls = 'v ' + (c.close[i] >= c.open[i] ? 'up' : 'down');
    for (const el of [L.o, L.hi, L.lo, L.c, L.ch]) el.className = cls;
    L.vol.textContent = fmtVol(c.volume[i]);
    for (const s of this.studies.values()) {
      if (!s.legend || !s.res || !s.res.plots) continue;
      const prec = s.res.meta && s.res.meta.precision != null ? s.res.meta.precision : (s.overlay ? d : 2);
      for (const x of s.legend.vals) {
        const p = s.res.plots[x.idx];
        if (!p) continue;
        const k = i - (p.offset || 0);
        x.el.textContent = fmtNum(k >= 0 && k < p.values.length ? p.values[k] : NaN, prec);
      }
    }
  }

  // ------------------------------------------------------------------ misc
  fit() { this.chart.timeScale().fitContent(); }
  showLatest(bars = 150) {
    const n = this.buf ? this.buf.length : 0;
    this.chart.timeScale().setVisibleLogicalRange({ from: Math.max(0, n - bars), to: n + 8 });
  }
  scrollToRealtime() { this.chart.timeScale().scrollToRealTime(); }

  dispose() {
    this.disposed = true;
    clearInterval(this.paneTimer);
    cancelAnimationFrame(this.raf);
    this.chart.remove();
    this.host.replaceChildren();
  }
}
