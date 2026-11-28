// One chart of the split-screen layout. Owns its bar buffer, live subscription, Pine dataset,
// studies, drawings, crosshair sync hooks and bar replay. Reads and writes only its own slice of
// the workspace (cells[index]); the page decides which cell is active.

import { h } from '../../lib/dom.js';
import { TF, sliceBars } from '../data/timeframes.js';
import { BarBuffer } from '../data/bar-buffer.js';
import { ChartEngine, fmtNum } from '../engine/chart-engine.js';
import { DrawingLayer } from '../drawings/layer.js';
import { BUILTIN } from '../indicators/builtins.js';
import { LineStyle } from '../../../vendor/lightweight-charts/lightweight-charts.mjs';
import { workspace, scripts, getScript, setCell } from '../store/workspace.js';
import { popMenu } from './menu.js';

const MAX_BARS = 20000; // history paging stops here: every recalculation runs over all loaded bars
const RERUN_MS = 250;
const SPEEDS = [1, 2, 5, 10, 25];

export function sourceFor(ref) {
  if (ref.startsWith('builtin:')) { const b = BUILTIN[ref.slice(8)]; return b ? { source: b.source, name: b.short } : null; }
  if (ref.startsWith('script:')) { const s = getScript(ref.slice(7)); return s ? { source: s.source, name: s.name, scriptId: s.id } : null; }
  return null;
}

export class ChartCell {
  /**
   * @param {number} index
   * @param {{ pine: import('../pine/client.js').PineEngine, adapterFor: (feed: string) => any,
   *   onActivate: (i: number) => void, onStudyAction: (cell: ChartCell, uid: string, action: string) => void,
   *   onRunReport: (scriptId: string, res: any, error: string|null) => void,
   *   onCrosshair: (cell: ChartCell, time: number|null, price: number|null) => void,
   *   onContract: (cell: ChartCell) => void, onReplay: (cell: ChartCell) => void,
   *   drawHooks: { magnet: () => boolean, hidden: () => boolean, onChange: () => void, onToolDone: () => void } }} o
   */
  constructor(index, o) {
    this.index = index;
    this.o = o;
    this.pine = o.pine;
    this.ds = 'c' + index;
    this.token = 0;
    this.buf = new BarBuffer();
    this.contract = null;
    this.contracts = [];
    this.adapter = null;
    this.unsubBars = null;
    this.historyBusy = false; this.historyDone = false;
    this.runTimer = 0; this.running = false; this.rerunWanted = false;
    /** uid -> { res, study, error } */
    this.live = new Map();
    this.reportNext = new Set();
    this.replay = null; // { full, cursor, playing, timer, speed }
    this.selecting = false;
    this.syncing = false;
    this.alertLines = [];
    this.disposed = false;

    this.host = h('div', { class: 'cx-host' });
    this.status = h('div', { class: 'cx-status hide', role: 'status' });
    this.replayBar = h('div', { class: 'rp-bar hide', role: 'toolbar', 'aria-label': 'Bar replay' });
    // chart settings (TradingView's gear where the price and time axes meet)
    this.gear = h('button', { type: 'button', class: 'cx-gear', title: 'Chart settings: scale type, invert, reset view…', 'aria-label': 'Chart settings', 'aria-haspopup': 'menu', onClick: () => this.settingsMenu() },
      h('span', { 'aria-hidden': 'true' }, '⚙'));
    this.wrap = h('div', { class: 'cx-chart' }, this.host, this.status, this.replayBar, this.gear);
    this.el = h('div', { class: 'cx-cell', dataset: { cell: String(index) } }, this.wrap);
    this.el.addEventListener('pointerdown', () => o.onActivate(index), { capture: true });

    this.engine = new ChartEngine(this.host, {
      onNeedHistory: () => this.loadHistory(),
      onStudyAction: (uidv, action) => o.onStudyAction(this, uidv, action),
    });
    this.layer = new DrawingLayer(this.engine, o.drawHooks);
    this.engine.setChartType(workspace.get().cells[index].chartType || 'candles');
    this.engine.setScale(workspace.get().cells[index].scale || {});
    this.engine.chart.subscribeCrosshairMove((p) => {
      if (this.syncing) return;
      const t = p && p.time !== undefined ? p.time : null;
      const price = t !== null && p.point ? this.engine.candles.coordinateToPrice(p.point.y) : null;
      o.onCrosshair(this, t, price);
    });
    this.onClick = (p) => {
      if (!this.selecting || !p || p.logical === undefined || p.logical === null) return;
      this.selecting = false;
      this.showStatus('');
      this.beginReplay(Math.max(5, Math.min(this.buf.length - 2, Math.round(p.logical))));
    };
    this.engine.chart.subscribeClick(this.onClick);

    const cell = () => workspace.get().cells[index];
    let prevStudies = cell().studies;
    this.unsubs = [
      workspace.subscribe((w) => w.feed + '|' + w.cells[index].symbol + '|' + w.cells[index].tf, () => this.load()),
      workspace.subscribe((w) => w.cells[index].chartType, (t) => this.engine.setChartType(t || 'candles')),
      workspace.subscribe((w) => w.cells[index].scale, (s) => this.engine.setScale(s || {})),
      workspace.subscribe((w) => w.cells[index].studies, (next) => {
        const prevMap = new Map(prevStudies.map((s) => [s.uid, s]));
        const ids = new Set(next.map((s) => s.uid));
        for (const s of prevStudies) if (!ids.has(s.uid)) { this.engine.removeStudy(s.uid); this.live.delete(s.uid); }
        for (const s of next) if (prevMap.get(s.uid) !== s) this.runStudy(s, false);
        prevStudies = next;
      }),
      scripts.subscribe((list) => list, (next, prev) => {
        const before = new Map(prev.map((s) => [s.id, s]));
        for (const st of cell().studies) {
          if (!st.ref.startsWith('script:')) continue;
          const id = st.ref.slice(7);
          if (before.get(id) !== next.find((s) => s.id === id)) this.runStudy(st, true);
        }
      }),
    ];
  }

  get state() { return workspace.get().cells[this.index]; }
  get tf() { return TF[this.state.tf] || TF['1h']; }

  showStatus(text, kind = '') {
    this.status.className = 'cx-status ' + kind + (text ? '' : ' hide');
    this.status.textContent = text || '';
  }

  label() {
    const tf = this.tf;
    return `${this.contract.symbol} · ${tf.label} · ${this.contract.kind === 'stock' ? 'End of day' : this.adapter.short || this.adapter.id}${this.replay ? ' · Replay' : ''}`;
  }

  // ---------------------------------------------------------------- data
  /** TradingView's chart settings menu (bottom-right gear). */
  settingsMenu() {
    const s = this.state.scale || {}, mode = s.mode || 'normal';
    const set = (patch) => setCell(this.index, { scale: patch });
    popMenu(this.gear, [
      { label: 'Reset chart view', hint: 'fit prices, latest bars', onClick: () => this.resetView() },
      { sep: true },
      { label: 'Auto (fits data to screen)', checked: this.engine.isAutoScale(), onClick: () => this.engine.setAutoScale(!this.engine.isAutoScale()) },
      { label: 'Invert scale', checked: !!s.invert, onClick: () => set({ invert: !s.invert }) },
      { sep: true },
      { label: 'Regular', checked: mode === 'normal', onClick: () => set({ mode: 'normal' }) },
      { label: 'Percent', checked: mode === 'percent', onClick: () => set({ mode: 'percent' }) },
      { label: 'Indexed to 100', checked: mode === 'indexed', onClick: () => set({ mode: 'indexed' }) },
      { label: 'Logarithmic', checked: mode === 'log', onClick: () => set({ mode: 'log' }) },
      { sep: true },
      { label: s.left ? 'Move scale to right' : 'Move scale to left', onClick: () => set({ left: !s.left }) },
      { sep: true },
      { header: 'Labels and lines' },
      { label: 'Last price label on the scale', checked: s.priceLabel !== false, onClick: () => set({ priceLabel: s.priceLabel === false }) },
      { label: 'Last price line', checked: s.priceLine !== false, onClick: () => set({ priceLine: s.priceLine === false }) },
      { label: 'Grid lines', checked: s.grid !== false, onClick: () => set({ grid: s.grid === false }) },
      { sep: true },
      { label: 'Reset all chart settings', onClick: () => { setCell(this.index, { scale: { mode: 'normal', invert: false, left: false, priceLabel: true, priceLine: true, grid: true } }); this.resetView(); } },
    ]);
  }

  /** Back to the default view: price scale fits the data again, latest bars in view. */
  resetView() {
    this.engine.setAutoScale(true);
    if (this.buf && this.buf.length) this.engine.showLatest(this.tf.calendar ? 120 : 160);
  }

  async load() {
    if (this.disposed) return;
    const my = ++this.token;
    this.exitReplay(false);
    if (this.unsubBars) { this.unsubBars(); this.unsubBars = null; }
    this.historyDone = false;
    const w = workspace.get();
    const c = this.state;
    this.adapter = this.o.adapterFor(w.feed);
    this.showStatus('Loading ' + (c.symbol || '') + ' ' + this.tf.label + '…');
    try {
      this.contracts = await this.adapter.contracts();
      if (my !== this.token) return;
      const contract = this.contracts.find((x) => x.symbol === c.symbol) || this.contracts[0];
      if (contract.symbol !== c.symbol) { // symbol not on this feed: switch this cell to the feed's first contract
        workspace.set((ws) => ({ ...ws, cells: ws.cells.map((x, i) => (i === this.index ? { ...x, symbol: contract.symbol } : x)) }));
        return;
      }
      if (contract.kind === 'stock' && !this.tf.calendar) { // end-of-day prices: daily is the finest timeframe
        workspace.set((ws) => ({ ...ws, cells: ws.cells.map((x, i) => (i === this.index ? { ...x, tf: '1D' } : x)) }));
        return;
      }
      this.contract = contract;
      const tf = this.tf;
      const bars = await this.adapter.bars(contract.symbol, tf.id, { limit: tf.calendar ? 5000 : 1500 });
      if (my !== this.token || this.disposed) return;
      this.buf = new BarBuffer(bars);
      this.engine.setBars(this.buf, { tick: contract.tick, label: this.label() });
      this.engine.showLatest(tf.calendar ? 120 : 160);
      this.layer.setContext(contract.symbol, tf.sec);
      this.pine.setData(this.ds, this.buf.copy(), { ticker: contract.symbol, mintick: contract.tick }, { period: tf.pine, seconds: tf.sec });
      this.showStatus('');
      this.o.onContract(this);
      this.runAll(true);
      this.unsubBars = this.adapter.subscribeBars(contract.symbol, tf.id, (bar) => this.onBar(my, bar));
    } catch (err) {
      if (my !== this.token) return;
      console.error(err);
      this.showStatus(String(err.message || err) + (w.feed !== 'synthetic' ? ' Choose "Live (auto)" or "Synthetic (offline)" in the feed menu.' : ''), 'err');
    }
  }

  onBar(my, bar) {
    if (my !== this.token || this.disposed) return;
    if (this.replay) { this.replay.full.apply(bar); return; } // the hidden future keeps up; the view does not move
    if (this.buf.apply(bar) === 'stale') return;
    this.engine.liveUpdate();
    this.pine.pushBar(this.ds, bar);
    this.scheduleRuns();
  }

  async loadHistory() {
    if (this.replay || this.historyBusy || this.historyDone || !this.buf.length || !this.contract) return;
    if (this.buf.length >= MAX_BARS) { this.historyDone = true; return; }
    this.historyBusy = true;
    const my = this.token;
    const tf = this.tf;
    try {
      const older = await this.adapter.bars(this.contract.symbol, tf.id, { to: this.buf.cols.time[0] - 1, limit: 1000 });
      if (my !== this.token || this.disposed || this.replay) return;
      const added = this.buf.prepend(older);
      if (!added) { this.historyDone = true; return; }
      this.engine.setBars(this.buf, { tick: this.contract.tick, label: this.label() }, { keepRange: true, shiftBy: added });
      this.pine.setData(this.ds, this.buf.copy(), { ticker: this.contract.symbol, mintick: this.contract.tick }, { period: tf.pine, seconds: tf.sec });
      this.runAll(true);
    } catch (err) { console.warn('history', err); this.historyDone = true; }
    finally { this.historyBusy = false; }
  }

  // ---------------------------------------------------------------- studies
  scheduleRuns() {
    if (this.runTimer) return;
    this.runTimer = setTimeout(() => { this.runTimer = 0; this.runAll(false); }, RERUN_MS);
  }

  async runAll(force) {
    if (this.running && !force) { this.rerunWanted = true; return; }
    this.running = true;
    try { await Promise.all(this.state.studies.filter((s) => !s.hidden).map((s) => this.runStudy(s, false))); }
    finally {
      this.running = false;
      if (this.rerunWanted) { this.rerunWanted = false; this.scheduleRuns(); }
    }
  }

  labelFor(res, fallback) {
    const name = res && res.meta ? (res.meta.shorttitle || res.meta.title) : fallback;
    const ins = res && res.inputs ? res.inputs.filter((d) => d.type !== 'bool' && d.type !== 'color').map((d) => String(d.value)).join(' ') : '';
    return { label: name, inputsLabel: ins };
  }

  async runStudy(study, report) {
    if (this.disposed || !this.contract) return;
    const src = sourceFor(study.ref);
    const l = this.live.get(study.uid) || { res: null, study, error: null };
    this.live.set(study.uid, l);
    l.study = study;
    if (!src) {
      l.error = 'The script for this indicator was deleted';
      this.engine.renderStudy(study.uid, null, { hidden: false, styles: {}, label: study.ref, inputsLabel: '', error: l.error });
      return;
    }
    if (study.hidden) {
      this.engine.renderStudy(study.uid, l.res, { hidden: true, styles: study.styles, ...this.labelFor(l.res, src.name), error: null });
      return;
    }
    let res = null, error = null;
    try {
      res = await this.pine.run(study.uid, this.ds, src.source, study.inputs);
      if (res === null) return; // superseded by a newer run
    } catch (err) { error = String(err.message || err); }
    if (this.disposed) return;
    const current = this.state.studies.find((s) => s.uid === study.uid);
    if (!current) return;
    const first = error || (res && res.diagnostics.find((d) => d.severity === 'error'));
    const errText = typeof first === 'string' ? first : first ? `line ${first.line}: ${first.message}` : null;
    const okChanged = (l.error || null) !== (errText || null);
    l.error = errText;
    if (res && res.ok) l.res = res;
    this.engine.renderStudy(study.uid, res && res.meta ? res : null, { hidden: false, styles: current.styles, ...this.labelFor(res && res.meta ? res : l.res, src.name), error: errText });
    if (src.scriptId && (report || okChanged || this.reportNext.has(src.scriptId))) {
      this.reportNext.delete(src.scriptId);
      this.o.onRunReport(src.scriptId, res || { ok: false, diagnostics: [], plots: [], inputs: [], bars: 0, ms: 0 }, error);
    }
  }

  // ---------------------------------------------------------------- crosshair sync
  /** Show another cell's crosshair here: snap the time to this cell's bar containing it. */
  showCrosshair(time, price) {
    const ch = this.engine.chart;
    this.syncing = true;
    try {
      if (time === null || !this.buf.length) { ch.clearCrosshairPosition(); return; }
      const t = this.buf.cols.time;
      let lo = 0, hi = this.buf.length - 1;
      if (time < t[0] || time > t[hi] + this.tf.sec) { ch.clearCrosshairPosition(); return; }
      while (lo < hi) { const mid = (lo + hi + 1) >> 1; if (t[mid] <= time) lo = mid; else hi = mid - 1; }
      ch.setCrosshairPosition(price ?? this.buf.cols.close[lo], t[lo], this.engine.candles);
    } finally { this.syncing = false; }
  }

  // ---------------------------------------------------------------- alerts on the chart
  setAlertLines(list) {
    for (const l of this.alertLines) this.engine.candles.removePriceLine(l);
    this.alertLines = list.map((a) => this.engine.candles.createPriceLine({ price: a.price, color: '#f0b849', lineWidth: 1, lineStyle: LineStyle.LargeDashed, axisLabelVisible: true, title: '⏰' }));
  }

  // ---------------------------------------------------------------- bar replay
  startReplaySelect() {
    if (!this.buf.length) return;
    this.exitReplay();
    this.selecting = true;
    this.showStatus('Bar replay: click the bar to start from. Esc cancels.');
    this.o.onReplay(this);
  }
  cancelSelect() { if (this.selecting) { this.selecting = false; this.showStatus(''); this.o.onReplay(this); } }

  beginReplay(idx) {
    const full = this.buf;
    const view = new BarBuffer(sliceBars(full.view(), 0, idx + 1));
    this.replay = { full, cursor: idx + 1, playing: false, timer: 0, speed: 2 };
    this.setDataset(view);
    this.paintReplay();
    this.o.onReplay(this);
  }

  setDataset(buf) {
    const tf = this.tf;
    this.buf = buf;
    this.engine.setBars(buf, { tick: this.contract.tick, label: this.label() });
    this.engine.showLatest(tf.calendar ? 120 : 160);
    this.pine.setData(this.ds, buf.copy(), { ticker: this.contract.symbol, mintick: this.contract.tick }, { period: tf.pine, seconds: tf.sec });
    this.runAll(true);
  }

  /** Reveal the next bar and recalculate every study on it. */
  step(force = true) {
    const r = this.replay;
    if (!r) return false;
    if (r.cursor >= r.full.length) { this.pauseReplay(); this.paintReplay('Caught up with the live bar.'); return false; }
    const bar = r.full.bar(r.cursor++);
    this.buf.apply(bar);
    this.engine.liveUpdate();
    this.pine.pushBar(this.ds, bar);
    this.runAll(force);
    this.paintReplay();
    return true;
  }
  playReplay() {
    const r = this.replay;
    if (!r || r.playing) return;
    r.playing = true;
    r.timer = setInterval(() => { if (!this.step(false)) this.pauseReplay(); }, 1000 / r.speed);
    this.paintReplay();
  }
  pauseReplay() {
    const r = this.replay;
    if (!r) return;
    r.playing = false; clearInterval(r.timer); r.timer = 0;
    this.paintReplay();
  }
  setSpeed(s) {
    const r = this.replay; if (!r) return;
    const was = r.playing; this.pauseReplay(); r.speed = s; if (was) this.playReplay();
  }
  exitReplay(restore = true) {
    this.selecting = false;
    const r = this.replay;
    if (!r) return;
    clearInterval(r.timer);
    this.replay = null;
    this.replayBar.classList.add('hide');
    if (restore && this.contract) this.setDataset(r.full);
    this.o.onReplay(this);
  }

  paintReplay(note) {
    const r = this.replay;
    const bar = this.replayBar;
    bar.classList.toggle('hide', !r);
    if (!r) return;
    bar.replaceChildren();
    const b = (label, title, fn, cls = '') => h('button', { type: 'button', class: 'btn rp-btn ' + cls, title, 'aria-label': title, onClick: fn }, label);
    const last = this.buf.length ? this.buf.cols.time[this.buf.length - 1] : 0;
    const when = new Date(last * 1000).toISOString().replace('T', ' ').slice(0, 16) + ' UTC';
    const speed = h('select', { class: 'ipt rp-speed', 'aria-label': 'Replay speed' }, SPEEDS.map((s) => h('option', { value: String(s) }, s + ' bar' + (s > 1 ? 's' : '') + '/s')));
    speed.value = String(r.speed);
    speed.addEventListener('change', () => this.setSpeed(+speed.value));
    bar.append(...[
      h('span', { class: 'rp-label' }, h('b', null, 'Replay'), ` · ${when} · ${(r.full.length - r.cursor).toLocaleString()} bars hidden`),
      note ? h('span', { class: 'rp-note' }, note) : null,
      b('↺', 'Pick a new start bar', () => this.startReplaySelect()),
      r.playing ? b('❚❚', 'Pause', () => this.pauseReplay(), 'primary') : b('▶', 'Play', () => this.playReplay(), 'primary'),
      b('▶|', 'Step one bar', () => { this.pauseReplay(); this.step(true); }),
      speed,
      b('Exit', 'Leave replay and return to live', () => this.exitReplay()),
    ].filter(Boolean));
  }

  replayKey(e) {
    if (e.key === 'Escape' && this.selecting) { this.cancelSelect(); return true; }
    if (!this.replay) return false;
    if (e.key === 'ArrowRight' && e.shiftKey) { this.pauseReplay(); this.step(true); return true; }
    if (e.key === ' ' && e.shiftKey) { this.replay.playing ? this.pauseReplay() : this.playReplay(); return true; }
    return false;
  }

  priceText(p) { return fmtNum(p, this.engine.dec); }

  dispose() {
    this.disposed = true;
    this.token++;
    clearTimeout(this.runTimer);
    if (this.replay) clearInterval(this.replay.timer);
    if (this.unsubBars) this.unsubBars();
    this.unsubs.forEach((u) => u());
    this.pine.drop(this.ds);
    this.layer.dispose();
    this.engine.dispose();
  }
}
