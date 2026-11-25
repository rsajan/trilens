// Chart page controller. Owns the wiring between the data adapter, the bar buffer, the chart
// engine, the Pine worker and the workspace store. Components never talk to each other directly.

import { h, clear } from '../../lib/dom.js';
import { TIMEFRAMES, TF } from '../data/timeframes.js';
import { ADAPTERS } from '../data/adapters.js';
import { BarBuffer } from '../data/bar-buffer.js';
import { ChartEngine } from '../engine/chart-engine.js';
import { PineEngine } from '../pine/client.js';
import { BUILTIN, NEW_SCRIPT } from '../indicators/builtins.js';
import { workspace, scripts, getScript, addStudy, removeStudy, patchStudy, setEditor } from '../store/workspace.js';
import { createTelemetryBar } from './telemetry-bar.js';
import { createPineDrawer } from './pine-drawer.js';
import { symbolDialog, indicatorDialog, settingsDialog } from './dialogs.js';
import { DrawingLayer } from '../drawings/layer.js';
import { createDrawRail } from './draw-rail.js';

const FAV_TF = ['1m', '5m', '15m', '1h', '4h', '1D', '1W'];
const MAX_BARS = 20000; // history paging stops here: every live recalculation runs over all loaded bars
const RERUN_MS = 250;

// Workers survive page re-renders (the theme switch re-renders every page).
let pine = null;
const adapters = new Map();
const adapterFor = (feed) => { if (!adapters.has(feed)) adapters.set(feed, (ADAPTERS[feed] || ADAPTERS.synthetic)()); return adapters.get(feed); };

function sourceFor(ref) {
  if (ref.startsWith('builtin:')) { const b = BUILTIN[ref.slice(8)]; return b ? { source: b.source, name: b.short } : null; }
  if (ref.startsWith('script:')) { const s = getScript(ref.slice(7)); return s ? { source: s.source, name: s.name, scriptId: s.id } : null; }
  return null;
}

export function mountChartPage(root) {
  pine = pine || new PineEngine();
  const cleanups = [];
  let token = 0;
  let buf = new BarBuffer();
  let contract = null;
  let contracts = [];
  let adapter = null;
  let unsubBars = null, unsubTele = null;
  let historyBusy = false, historyDone = false;
  let runTimer = 0, running = false, rerunWanted = false;
  /** uid -> { res, study, error } */
  const live = new Map();
  const reportNext = new Set(); // script ids whose next run result goes to the editor console
  const DS = 'main';

  // ---------------------------------------------------------------- layout
  const tfSel = h('select', { class: 'ipt cx-tfsel', 'aria-label': 'More timeframes' }, TIMEFRAMES.map((t) => h('option', { value: t.id }, t.label)));
  const tfButtons = h('div', { class: 'seg cx-tfs', role: 'group', 'aria-label': 'Timeframe' },
    FAV_TF.map((id) => h('button', { type: 'button', dataset: { tf: id }, onClick: () => workspace.set({ tf: id }) }, TF[id].label)));
  tfSel.addEventListener('change', () => workspace.set({ tf: tfSel.value }));
  const feedSel = h('select', { class: 'ipt cx-feed', 'aria-label': 'Data feed', title: 'Where prices come from' },
    h('option', { value: 'synthetic' }, 'Synthetic market'), h('option', { value: 'binance' }, 'Binance public (live)'));
  feedSel.addEventListener('change', () => workspace.set({ feed: feedSel.value, symbol: '' }));
  const btn = (label, title, onClick) => h('button', { type: 'button', class: 'btn cx-tool', title, onClick }, label);
  const editorBtn = btn('Pine Editor', 'Open the Pine Script editor', () => setEditor({ open: !workspace.get().editor.open, tab: 'editor' }));
  const toolbar = h('div', { class: 'cx-toolbar' },
    tfButtons, tfSel,
    btn('Indicators', 'Add an indicator or one of your scripts', () => indicatorDialog({ onAdd: (ref) => addStudy(ref), onNewScript: () => drawer.openNew(NEW_SCRIPT) })),
    editorBtn,
    h('span', { class: 'grow' }),
    btn('Latest', 'Jump to the latest bar', () => engine.scrollToRealtime()),
    feedSel);

  const tele = createTelemetryBar({ onPickSymbol: () => symbolDialog({ contracts, current: workspace.get().symbol, feedLabel: adapter ? adapter.label : '', onPick: (symbol) => workspace.set({ symbol }) }) });
  const chartHost = h('div', { class: 'cx-host' });
  const status = h('div', { class: 'cx-status hide', role: 'status' });
  const chartWrap = h('div', { class: 'cx-chart' }, chartHost, status);
  const drawer = createPineDrawer({
    pine,
    onApply: (scriptId) => {
      const ref = 'script:' + scriptId;
      reportNext.add(scriptId);
      const st = workspace.get().studies.find((s) => s.ref === ref);
      if (st) runStudy(st, true);
      else addStudy(ref);
    },
    onRemoveFromChart: (scriptId) => { for (const s of workspace.get().studies) if (s.ref === 'script:' + scriptId) removeStudy(s.uid); },
    isOnChart: (scriptId) => workspace.get().studies.some((s) => s.ref === 'script:' + scriptId),
  });
  const page = h('div', { class: 'cx-page' }, toolbar, tele.el, chartWrap, drawer.el);
  clear(root).append(page);

  const engine = new ChartEngine(chartHost, {
    onNeedHistory: () => loadHistory(),
    onStudyAction: (uid, action) => studyAction(uid, action),
  });
  const layer = new DrawingLayer(engine, {
    magnet: () => workspace.get().draw.magnet,
    hidden: () => workspace.get().draw.hidden,
    onChange: () => rail && rail.paint(),
    onToolDone: () => rail && rail.paint(),
  });
  const rail = createDrawRail(layer);
  chartWrap.append(rail.rail, rail.bar);
  // drawings release their listeners (and save) before the chart they draw on goes away
  cleanups.push(() => rail.dispose(), () => layer.dispose(), () => engine.dispose(), () => tele.dispose(), () => drawer.dispose());

  function showStatus(text, kind = '') {
    status.className = 'cx-status ' + kind + (text ? '' : ' hide');
    status.textContent = text || '';
  }

  function paintToolbar() {
    const w = workspace.get();
    for (const b of tfButtons.children) b.setAttribute('aria-pressed', String(b.dataset.tf === w.tf));
    tfSel.value = w.tf;
    tfSel.classList.toggle('on', !FAV_TF.includes(w.tf));
    feedSel.value = w.feed;
    editorBtn.classList.toggle('on', w.editor.open);
  }

  // ---------------------------------------------------------------- data
  async function load() {
    const my = ++token;
    unsubBars && unsubBars(); unsubTele && unsubTele();
    unsubBars = unsubTele = null;
    historyDone = false;
    const w = workspace.get();
    adapter = adapterFor(w.feed);
    showStatus('Loading ' + (w.symbol || '') + ' ' + TF[w.tf].label + '…');
    try {
      contracts = await adapter.contracts();
      if (my !== token) return;
      contract = contracts.find((c) => c.symbol === w.symbol) || contracts[0];
      if (contract.symbol !== w.symbol) { workspace.set({ symbol: contract.symbol }); return; } // triggers load() again
      tele.setContract(contract, adapter.label);
      const tf = TF[w.tf];
      const bars = await adapter.bars(contract.symbol, tf.id, { limit: tf.calendar ? 5000 : 1500 });
      if (my !== token) return;
      buf = new BarBuffer(bars);
      engine.setBars(buf, { tick: contract.tick, label: `${contract.symbol} · ${tf.label} · ${adapter.id === 'synthetic' ? 'Synthetic' : 'Binance'}` });
      engine.showLatest(tf.calendar ? 120 : 160);
      layer.setContext(contract.symbol, tf.sec);
      pine.setData(DS, buf.copy(), { ticker: contract.symbol, mintick: contract.tick }, { period: tf.pine, seconds: tf.sec });
      showStatus('');
      runAll(true);
      unsubBars = adapter.subscribeBars(contract.symbol, tf.id, (bar) => {
        if (my !== token) return;
        const kind = buf.apply(bar);
        if (kind === 'stale') return;
        engine.liveUpdate();
        pine.pushBar(DS, bar);
        scheduleRuns();
      });
      unsubTele = adapter.subscribeTelemetry(contract.symbol, (t) => { if (my === token) tele.update(t); });
    } catch (err) {
      if (my !== token) return;
      console.error(err);
      showStatus(String(err.message || err) + (w.feed !== 'synthetic' ? ' — choose "Synthetic market" in the feed menu to keep working offline.' : ''), 'err');
    }
  }

  async function loadHistory() {
    if (historyBusy || historyDone || !buf.length || !contract) return;
    if (buf.length >= MAX_BARS) { historyDone = true; return; }
    historyBusy = true;
    const my = token;
    const tf = TF[workspace.get().tf];
    try {
      const older = await adapter.bars(contract.symbol, tf.id, { to: buf.cols.time[0] - 1, limit: 1000 });
      if (my !== token || engine.disposed) return;
      const added = buf.prepend(older);
      if (!added) { historyDone = true; return; }
      engine.setBars(buf, { tick: contract.tick, label: engine.symbolLabel }, { keepRange: true, shiftBy: added });
      pine.setData(DS, buf.copy(), { ticker: contract.symbol, mintick: contract.tick }, { period: tf.pine, seconds: tf.sec });
      runAll(true);
    } catch (err) { console.warn('history', err); historyDone = true; }
    finally { historyBusy = false; }
  }

  // ---------------------------------------------------------------- studies
  function scheduleRuns() {
    if (runTimer) return;
    runTimer = setTimeout(() => { runTimer = 0; runAll(false); }, RERUN_MS);
  }

  async function runAll(force) {
    if (running && !force) { rerunWanted = true; return; }
    running = true;
    try { await Promise.all(workspace.get().studies.filter((s) => !s.hidden).map((s) => runStudy(s, false))); }
    finally {
      running = false;
      if (rerunWanted) { rerunWanted = false; scheduleRuns(); }
    }
  }

  function labelFor(study, res, fallback) {
    const name = res && res.meta ? (res.meta.shorttitle || res.meta.title) : fallback;
    const ins = res && res.inputs ? res.inputs.filter((d) => d.type !== 'bool' && d.type !== 'color').map((d) => String(d.value)).join(' ') : '';
    return { label: name, inputsLabel: ins };
  }

  async function runStudy(study, report) {
    const src = sourceFor(study.ref);
    const l = live.get(study.uid) || { res: null, study, error: null };
    live.set(study.uid, l);
    l.study = study;
    if (!src) {
      l.error = 'The script for this indicator was deleted';
      engine.renderStudy(study.uid, null, { hidden: false, styles: {}, label: study.ref, inputsLabel: '', error: l.error });
      return;
    }
    if (study.hidden) {
      engine.renderStudy(study.uid, l.res, { hidden: true, styles: study.styles, ...labelFor(study, l.res, src.name), error: null });
      return;
    }
    let res = null, error = null;
    try {
      res = await pine.run(study.uid, DS, src.source, study.inputs);
      if (res === null) return; // superseded by a newer run
    } catch (err) { error = String(err.message || err); }
    if (engine.disposed) return; // the page was left while the script ran
    const current = workspace.get().studies.find((s) => s.uid === study.uid);
    if (!current) return; // removed while running
    const firstError = error || (res && res.diagnostics.find((d) => d.severity === 'error'));
    const errText = typeof firstError === 'string' ? firstError : firstError ? `line ${firstError.line}: ${firstError.message}` : null;
    const okChanged = (l.error || null) !== (errText || null);
    l.error = errText;
    if (res && res.ok) l.res = res;
    engine.renderStudy(study.uid, res && res.ok ? res : res && res.meta ? res : null, { hidden: false, styles: current.styles, ...labelFor(current, res && res.meta ? res : l.res, src.name), error: errText });
    if (src.scriptId && (report || okChanged || reportNext.has(src.scriptId))) {
      reportNext.delete(src.scriptId);
      drawer.showRun(src.scriptId, res || { ok: false, diagnostics: [], plots: [], inputs: [], bars: 0, ms: 0 }, error);
    }
  }

  function studyAction(uid, action) {
    const st = workspace.get().studies.find((s) => s.uid === uid);
    if (!st) return;
    if (action === 'remove') removeStudy(uid);
    else if (action === 'hide') patchStudy(uid, { hidden: !st.hidden });
    else if (action === 'edit') {
      if (st.ref.startsWith('script:')) drawer.openScript(st.ref.slice(7));
      else { const b = BUILTIN[st.ref.slice(8)]; if (b) drawer.openNew(b.source.replace(/indicator\("([^"]+)"/, 'indicator("$1 (my copy)"')); }
    } else if (action === 'settings') {
      const l = live.get(uid);
      const src = sourceFor(st.ref);
      settingsDialog({ title: (l && l.res && l.res.meta && l.res.meta.title) || (src && src.name) || 'Indicator', result: l && l.res, study: st, onChange: (patch) => patchStudy(uid, patch) });
    }
  }

  // ---------------------------------------------------------------- store wiring
  let prevStudies = workspace.get().studies;
  cleanups.push(
    workspace.subscribe((w) => w.feed + '|' + w.symbol + '|' + w.tf, () => { paintToolbar(); load(); }),
    workspace.subscribe((w) => w.editor.open, paintToolbar),
    workspace.subscribe((w) => w.studies, (next) => {
      const prevMap = new Map(prevStudies.map((s) => [s.uid, s]));
      const nextIds = new Set(next.map((s) => s.uid));
      for (const s of prevStudies) if (!nextIds.has(s.uid)) { engine.removeStudy(s.uid); live.delete(s.uid); }
      for (const s of next) if (prevMap.get(s.uid) !== s) runStudy(s, false);
      prevStudies = next;
    }),
    scripts.subscribe((list) => list, (next, prev) => {
      const before = new Map(prev.map((s) => [s.id, s]));
      for (const st of workspace.get().studies) {
        if (!st.ref.startsWith('script:')) continue;
        const id = st.ref.slice(7);
        const a = before.get(id), b = next.find((s) => s.id === id);
        if (a !== b) runStudy(st, true);
      }
    }),
  );

  const onKey = (e) => {
    if (e.target && /^(INPUT|TEXTAREA|SELECT)$/.test(e.target.tagName)) return;
    if (e.altKey && e.key.toLowerCase() === 'p') { e.preventDefault(); setEditor({ open: !workspace.get().editor.open }); }
  };
  addEventListener('keydown', onKey);
  cleanups.push(() => removeEventListener('keydown', onKey));

  paintToolbar();
  load();

  return () => {
    token++;
    clearTimeout(runTimer);
    unsubBars && unsubBars(); unsubTele && unsubTele();
    pine.drop(DS);
    for (const f of cleanups) f();
  };
}
