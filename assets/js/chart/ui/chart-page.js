// Chart page shell. Lays out the split-screen grid of ChartCells and owns everything shared:
// toolbar, telemetry strip (for the focused chart), Pine editor, drawing rail, watchlist, alerts,
// templates and crosshair sync. Cells never talk to each other; they talk to this shell.

import { h, clear } from '../../lib/dom.js';
import { TIMEFRAMES, TF } from '../data/timeframes.js';
import { ADAPTERS } from '../data/adapters.js';
import { PineEngine } from '../pine/client.js';
import { BUILTIN, NEW_SCRIPT } from '../indicators/builtins.js';
import { workspace, removeStudy, patchStudy, addStudy, setEditor, setLayout, setActive, setSync, setCell, activeCell, LAYOUT_CELLS } from '../store/workspace.js';
import { alerts, defaultStyle } from '../store/library.js';
import { createTelemetryBar } from './telemetry-bar.js';
import { createPineDrawer } from './pine-drawer.js';
import { symbolDialog, indicatorDialog, settingsDialog, promptDialog } from './dialogs.js';
import { createDrawRail } from './draw-rail.js';
import { ChartCell, sourceFor } from './chart-cell.js';
import { createWatchlist } from './watchlist.js';
import { AlertEngine, alertDialog, alertsListDialog } from './alerts.js';
import { templatesDialog } from './workspace-dialogs.js';
import { fmtNum } from '../engine/chart-engine.js';

const FAV_TF = ['1m', '5m', '15m', '1h', '4h', '1D', '1W'];

// Workers survive page re-renders (the theme switch re-renders every page).
let pine = null;
const adapters = new Map();
const adapterFor = (feed) => { if (!adapters.has(feed)) adapters.set(feed, (ADAPTERS[feed] || ADAPTERS.synthetic)()); return adapters.get(feed); };
const decOf = (tick) => { const s = String(tick); return s.includes('e-') ? +s.split('e-')[1] : (s.split('.')[1] || '').length; };

const narrow = () => matchMedia('(max-width: 900px)').matches;

export function mountChartPage(root) {
  pine = pine || new PineEngine();
  // on a phone the watchlist is an overlay over the chart: start with it closed
  if (narrow() && workspace.get().watchOpen) workspace.set({ watchOpen: false });
  const cleanups = [];
  /** @type {ChartCell[]} */
  const cells = [];
  let unsubTele = null, teleSymbol = null;
  const tickOf = new Map(); // symbol -> tick, for formatting alert prices

  const active = () => cells[workspace.get().active] || cells[0];
  // armed price alerts draw as dashed lines; script alerts have no single price to draw
  const priceAlertsFor = (symbol) => alerts.get().filter((a) => a.active && a.kind !== 'script' && a.symbol === symbol);
  const fmtFor = (symbol, p) => fmtNum(p, tickOf.has(symbol) ? decOf(tickOf.get(symbol)) : 2);

  // ---------------------------------------------------------------- toolbar
  const btn = (label, title, onClick, cls = '') => h('button', { type: 'button', class: 'btn cx-tool ' + cls, title, onClick }, label);
  const seg = (label, title, onClick) => h('button', { type: 'button', title, 'aria-label': title, onClick }, label);
  const layoutSeg = h('div', { class: 'seg cx-tfs cx-layouts', role: 'group', 'aria-label': 'Layout' },
    seg('▢', 'One chart', () => setLayout('1x1')), seg('◫', 'Two charts side by side', () => setLayout('1x2')), seg('⊞', 'Four charts', () => setLayout('2x2')));
  const syncSeg = h('div', { class: 'seg cx-tfs cx-sync', role: 'group', 'aria-label': 'Sync between charts' },
    seg('Sym', 'Same contract on every chart', () => setSync({ symbol: !workspace.get().sync.symbol })),
    seg('TF', 'Same timeframe on every chart', () => setSync({ tf: !workspace.get().sync.tf })),
    seg('✛', 'Crosshair follows across charts', () => setSync({ crosshair: !workspace.get().sync.crosshair })));
  const tfSel = h('select', { class: 'ipt cx-tfsel', 'aria-label': 'More timeframes' }, TIMEFRAMES.map((t) => h('option', { value: t.id }, t.label)));
  const tfButtons = h('div', { class: 'seg cx-tfs', role: 'group', 'aria-label': 'Timeframe' },
    FAV_TF.map((id) => h('button', { type: 'button', dataset: { tf: id }, onClick: () => setCell(workspace.get().active, { tf: id }) }, TF[id].label)));
  tfSel.addEventListener('change', () => setCell(workspace.get().active, { tf: tfSel.value }));
  const feedSel = h('select', { class: 'ipt cx-feed', 'aria-label': 'Data feed', title: 'Where prices come from' },
    h('option', { value: 'synthetic' }, 'Synthetic market'), h('option', { value: 'binance' }, 'Binance public (live)'));
  feedSel.addEventListener('change', () => workspace.set({ feed: feedSel.value }));
  const editorBtn = btn('Pine Editor', 'Open the Pine Script editor (Alt+P)', () => setEditor({ open: !workspace.get().editor.open, tab: 'editor' }));
  const replayBtn = btn('Replay', 'Bar replay: cut the focused chart at a past bar and play it forward', () => { const c = active(); c.replay || c.selecting ? c.exitReplay() : c.startReplaySelect(); });
  const watchBtn = btn('Watchlist', 'Show or hide the watchlist', () => workspace.set({ watchOpen: !workspace.get().watchOpen }));
  const toolbar = h('div', { class: 'cx-toolbar' },
    layoutSeg, syncSeg, tfButtons, tfSel,
    btn('Indicators', 'Add an indicator or one of your scripts to the focused chart', () => indicatorDialog({ onAdd: (ref) => addStudy(ref), onNewScript: () => drawer.openNew(NEW_SCRIPT) })),
    btn('Templates', 'Indicator templates and saved layouts', () => templatesDialog()),
    editorBtn, replayBtn,
    btn('Alert', 'Create a price alert for the focused contract', () => newAlert()),
    btn('Alerts', 'Your alerts', () => alertsListDialog({ fmt: fmtFor })),
    h('span', { class: 'grow' }),
    watchBtn,
    btn('Latest', 'Jump to the latest bar', () => active().engine.scrollToRealtime()),
    feedSel);

  const tele = createTelemetryBar({ onPickSymbol: () => { const c = active(); symbolDialog({ contracts: c.contracts, current: c.state.symbol, feedLabel: c.adapter ? c.adapter.label : '', onPick: (symbol) => setCell(workspace.get().active, { symbol }) }); } });
  const grid = h('div', { class: 'cx-grid' });
  const toasts = h('div', { class: 'cx-toasts', 'aria-live': 'assertive' });
  const watch = createWatchlist({
    getAdapter: () => adapterFor(workspace.get().feed),
    getContracts: () => adapterFor(workspace.get().feed).contracts(),
    currentSymbol: () => activeCell().symbol,
    onPick: (symbol) => { setCell(workspace.get().active, { symbol }); if (narrow()) workspace.set({ watchOpen: false }); },
    onClose: () => workspace.set({ watchOpen: false }),
  });
  const main = h('div', { class: 'cx-main' }, grid, watch.el, toasts);
  const drawer = createPineDrawer({
    pine,
    onApply: (scriptId) => {
      const c = active(), ref = 'script:' + scriptId;
      c.reportNext.add(scriptId);
      const st = c.state.studies.find((s) => s.ref === ref);
      if (st) c.runStudy(st, true); else addStudy(ref);
    },
    onRemoveFromChart: (scriptId) => { for (const s of activeCell().studies) if (s.ref === 'script:' + scriptId) removeStudy(s.uid); },
    isOnChart: (scriptId) => activeCell().studies.some((s) => s.ref === 'script:' + scriptId),
  });
  const page = h('div', { class: 'cx-page' }, toolbar, tele.el, main, drawer.el);
  clear(root).append(page);

  const rail = createDrawRail(() => (active() ? active().layer : null), {
    onAlert: (price) => newAlert(price),
    refreshAll: () => cells.forEach((c) => c.layer.refresh()),
  });
  cleanups.push(() => rail.dispose(), () => tele.dispose(), () => drawer.dispose(), () => watch.dispose());

  // ---------------------------------------------------------------- cells
  const drawHooks = {
    magnet: () => workspace.get().draw.magnet,
    hidden: () => workspace.get().draw.hidden,
    onChange: () => rail.paint(),
    onToolDone: () => rail.paint(),
    askText: (v) => promptDialog(v ? 'Edit note' : 'Text note', 'Text (empty deletes the note)', v),
    defaultStyle: (type) => defaultStyle(type),
  };
  function makeCell(i) {
    return new ChartCell(i, {
      pine, adapterFor, drawHooks,
      onActivate: (k) => setActive(k),
      onStudyAction: (cell, uidv, action) => studyAction(cell, uidv, action),
      onRunReport: (scriptId, res, error) => drawer.showRun(scriptId, res, error),
      onCrosshair: (cell, time, price) => {
        if (!workspace.get().sync.crosshair) return;
        for (const other of cells) if (other !== cell && other.contract) other.showCrosshair(time, other.contract.symbol === (cell.contract && cell.contract.symbol) ? price : null);
      },
      onContract: (cell) => {
        tickOf.set(cell.contract.symbol, cell.contract.tick);
        cell.setAlertLines(priceAlertsFor(cell.contract.symbol));
        if (cell === active()) { subscribeTele(); watch.markCurrent(cell.contract.symbol); }
      },
      onReplay: () => paintToolbar(),
    });
  }

  function layoutCells() {
    const w = workspace.get();
    const n = LAYOUT_CELLS[w.layout];
    while (cells.length > n) cells.pop().dispose();
    while (cells.length < n) { const c = makeCell(cells.length); cells.push(c); c.load(); }
    grid.className = 'cx-grid l' + w.layout;
    grid.replaceChildren(...cells.map((c) => c.el));
    focusCell();
  }

  function focusCell() {
    const a = active();
    cells.forEach((c) => c.el.classList.toggle('on', c === a && cells.length > 1));
    // the drawing rail and selection bar live inside the focused chart
    a.wrap.append(rail.rail, rail.bar);
    for (const c of cells) if (c !== a) { c.layer.setTool('cursor'); c.layer.selected = null; c.layer.refresh(); }
    rail.paint();
    if (a.contract) { subscribeTele(); watch.markCurrent(a.contract.symbol); }
    paintToolbar();
  }

  function subscribeTele() {
    const a = active();
    if (!a.contract) return;
    const key = workspace.get().feed + '|' + a.contract.symbol;
    if (key === teleSymbol) return;
    if (unsubTele) unsubTele();
    teleSymbol = key;
    tele.setContract(a.contract, a.adapter.label);
    unsubTele = a.adapter.subscribeTelemetry(a.contract.symbol, (t) => { if (teleSymbol === key) tele.update(t); });
  }

  function paintToolbar() {
    const w = workspace.get();
    const c = w.cells[w.active];
    const lay = ['1x1', '1x2', '2x2'];
    [...layoutSeg.children].forEach((b, i) => b.setAttribute('aria-pressed', String(w.layout === lay[i])));
    [...syncSeg.children].forEach((b, i) => b.setAttribute('aria-pressed', String([w.sync.symbol, w.sync.tf, w.sync.crosshair][i])));
    syncSeg.classList.toggle('hide', w.layout === '1x1');
    for (const b of tfButtons.children) b.setAttribute('aria-pressed', String(b.dataset.tf === c.tf));
    tfSel.value = c.tf;
    tfSel.classList.toggle('on', !FAV_TF.includes(c.tf));
    feedSel.value = w.feed;
    editorBtn.classList.toggle('on', w.editor.open);
    watchBtn.classList.toggle('on', w.watchOpen);
    main.classList.toggle('wl-open', w.watchOpen);
    const a = active();
    replayBtn.classList.toggle('on', !!(a && (a.replay || a.selecting)));
    replayBtn.textContent = a && (a.replay || a.selecting) ? 'Exit replay' : 'Replay';
  }

  function studyAction(cell, uidv, action) {
    setActive(cell.index);
    const st = cell.state.studies.find((s) => s.uid === uidv);
    if (!st) return;
    if (action === 'remove') removeStudy(uidv);
    else if (action === 'hide') patchStudy(uidv, { hidden: !st.hidden });
    else if (action === 'edit') {
      if (st.ref.startsWith('script:')) drawer.openScript(st.ref.slice(7));
      else { const b = BUILTIN[st.ref.slice(8)]; if (b) drawer.openNew(b.source.replace(/indicator\("([^"]+)"/, 'indicator("$1 (my copy)"')); }
    } else if (action === 'settings') {
      const l = cell.live.get(uidv);
      const src = sourceFor(st.ref);
      settingsDialog({ title: (l && l.res && l.res.meta && l.res.meta.title) || (src && src.name) || 'Indicator', result: l && l.res, study: st, onChange: (patch) => patchStudy(uidv, patch) });
    }
  }

  function newAlert(price) {
    const a = active();
    if (!a.contract || !a.buf.length) return;
    const last = a.replay ? a.replay.full.cols.close[a.replay.full.length - 1] : a.buf.cols.close[a.buf.length - 1];
    // every alertcondition() of the focused chart's indicators, as of their latest run
    const conds = [];
    for (const st of a.state.studies) {
      const l = a.live.get(st.uid);
      const res = l && l.res;
      if (!res || !res.alertconds) continue;
      const name = res.meta ? res.meta.shorttitle || res.meta.title : st.ref;
      for (const ac of res.alertconds) conds.push({ label: `${name}: ${ac.title}`, ref: st.ref, inputs: st.inputs, title: ac.title, message: ac.message });
    }
    alertDialog({ symbol: a.contract.symbol, tf: a.state.tf, price: price ?? last, last, fmt: (p) => a.priceText(p), conds });
  }

  function toast(title, body) {
    const t = h('div', { class: 'cx-toast', role: 'alert' }, h('b', null, '⏰ ' + title), h('div', null, body),
      h('button', { type: 'button', class: 'cx-toast-x', 'aria-label': 'Dismiss', onClick: () => t.remove() }, '✕'));
    toasts.append(t);
    setTimeout(() => t.remove(), 15000);
  }

  const alertEngine = new AlertEngine({ getAdapter: () => adapterFor(workspace.get().feed), pine, toast, fmt: fmtFor });
  cleanups.push(() => alertEngine.dispose());

  // ---------------------------------------------------------------- store wiring
  cleanups.push(
    workspace.subscribe((w) => w.layout, layoutCells),
    workspace.subscribe((w) => w.active, focusCell),
    workspace.subscribe((w) => w.feed, () => { teleSymbol = null; watch.refresh(); alertEngine.sync(); paintToolbar(); }),
    workspace.subscribe((w) => w.cells[w.active].tf + '|' + w.cells[w.active].symbol + '|' + w.editor.open + '|' + w.watchOpen + '|' + JSON.stringify(w.sync), paintToolbar),
    alerts.subscribe((x) => x, () => { for (const c of cells) if (c.contract) c.setAlertLines(priceAlertsFor(c.contract.symbol)); }),
  );

  const onKey = (e) => {
    if (e.target && /^(INPUT|TEXTAREA|SELECT)$/.test(e.target.tagName)) return;
    if (active() && active().replayKey(e)) { e.preventDefault(); return; }
    if (e.altKey && e.key.toLowerCase() === 'p') { e.preventDefault(); setEditor({ open: !workspace.get().editor.open }); }
  };
  addEventListener('keydown', onKey);
  cleanups.push(() => removeEventListener('keydown', onKey));

  layoutCells();
  paintToolbar();

  return () => {
    if (unsubTele) unsubTele();
    for (const f of cleanups) f();
    while (cells.length) cells.pop().dispose();
  };
}
