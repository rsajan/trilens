// Chart page shell. Lays out the split-screen grid of ChartCells and owns everything shared:
// toolbar, Pine editor, drawing rail, watchlist, alerts,
// templates and crosshair sync. Cells never talk to each other; they talk to this shell.

import { h, clear } from '../../lib/dom.js';
import { TIMEFRAMES } from '../data/timeframes.js';
import { ADAPTERS, FEEDS } from '../data/adapters.js';
import { PineEngine } from '../pine/client.js';
import { BUILTIN, NEW_SCRIPT } from '../indicators/builtins.js';
import { workspace, scripts, removeStudy, patchStudy, addStudy, setEditor, setDraw, setLayout, setActive, setSync, setCell, activeCell, LAYOUT_CELLS } from '../store/workspace.js';
import { alerts, defaultStyle, watchlists, templates, layouts, drawStyles } from '../store/library.js';
import { popMenu } from './menu.js';
import { createPineDrawer } from './pine-drawer.js';
import { symbolDialog, indicatorDialog, settingsDialog, promptDialog } from './dialogs.js';
import { createDrawRail } from './draw-rail.js';
import { ChartCell, sourceFor } from './chart-cell.js';
import { createWatchlist } from './watchlist.js';
import { AlertEngine, alertDialog, alertsListDialog } from './alerts.js';
import { templatesDialog } from './workspace-dialogs.js';
import { fmtNum } from '../engine/chart-engine.js';

// Toolbar icons: constant SVG strings only (same pattern as lib/dom.js icons).
const ICON = {
  search: '<circle cx="10.5" cy="10.5" r="6"/><path d="M15 15l5 5"/>',
  candles: '<path d="M7 3.5v3.5M7 15v5.5M17 5.5v3.5M17 15v3.5"/><rect x="5" y="7" width="4" height="8" rx="1"/><rect x="15" y="9" width="4" height="6" rx="1"/>',
  bars: '<path d="M7 4v16M4 8h3M7 15h3M17 6v14M14 10h3M17 17h3"/>',
  line: '<path d="M3.5 17l5-6 4 3.5 7.5-9"/>',
  area: '<path d="M3.5 17l5-6 4 3.5 7.5-9V20H3.5z" fill="currentColor" fill-opacity=".25"/><path d="M3.5 17l5-6 4 3.5 7.5-9"/>',
  chev: '<path d="M7 10l5 5 5-5"/>',
};
function svg(name) {
  const e = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
  e.setAttribute('viewBox', '0 0 24 24'); e.setAttribute('fill', 'none'); e.setAttribute('stroke', 'currentColor');
  e.setAttribute('stroke-width', '1.7'); e.setAttribute('stroke-linecap', 'round'); e.setAttribute('stroke-linejoin', 'round'); e.setAttribute('aria-hidden', 'true');
  e.innerHTML = ICON[name]; // constant strings above only
  return e;
}
const CHART_TYPE_LABEL = { candles: 'Candles', bars: 'Bars', line: 'Line', area: 'Area' };

// Workers survive page re-renders (the theme switch re-renders every page).
let pine = null;
const adapters = new Map();
const adapterFor = (feed) => { if (!adapters.has(feed)) adapters.set(feed, (ADAPTERS[feed] || ADAPTERS.synthetic)()); return adapters.get(feed); };
const decOf = (tick) => { const s = String(tick); return s.includes('e-') ? +s.split('e-')[1] : (s.split('.')[1] || '').length; };


export function mountChartPage(root) {
  pine = pine || new PineEngine();
  const cleanups = [];
  /** @type {ChartCell[]} */
  const cells = [];
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
  const tfSel = h('select', { class: 'ipt cx-tfsel', 'aria-label': 'Timeframe', title: 'Timeframe' }, TIMEFRAMES.map((t) => h('option', { value: t.id }, t.label)));
  tfSel.addEventListener('change', () => setCell(workspace.get().active, { tf: tfSel.value }));
  const feedSel = h('select', { class: 'ipt cx-feed', 'aria-label': 'Data feed', title: 'Where prices come from' },
    FEEDS.map((f) => h('option', { value: f.id, title: f.title }, f.label)));
  feedSel.addEventListener('change', () => workspace.set({ feed: feedSel.value }));
  // which source is really in use: "Live (auto)" settles on an exchange, or on synthetic
  const feedChip = h('span', { class: 'cx-feedchip', role: 'status' });
  const savedChip = h('span', { class: 'cx-saved', title: 'Chart settings, drawings, scripts, watchlists and alerts are saved in this browser: on every change, every 2 minutes, and when you leave the page' });
  let warnedFallback = false;
  function paintFeed() {
    const a = adapterFor(workspace.get().feed);
    const live = a.id !== 'synthetic' && !(a.source === 'synthetic');
    feedChip.className = 'cx-feedchip ' + (live ? 'live' : 'off');
    feedChip.textContent = live ? (a.source || a.id !== 'live' ? '● Live · ' + (a.chosen ? a.chosen.short : a.short) : '○ Connecting…') : '○ Synthetic';
    feedChip.title = a.fallbackReason ? 'Live feeds unreachable from here: ' + a.fallbackReason : (a.note || a.label || '');
    if (a.source === 'synthetic' && !warnedFallback) {
      warnedFallback = true;
      toast('Live data unavailable here', 'Binance and Bybit did not answer from this network or country, so the chart shows the synthetic market. ' + a.fallbackReason, 'ℹ');
    }
  }

  // 2. symbol search box (TradingView-style): shows the focused chart's contract, opens search
  const symText = h('span', { class: 'cx-symtext' }, '—');
  const symBtn = h('button', { type: 'button', class: 'cx-symbox', title: 'Search contracts', 'aria-label': 'Search contracts', onClick: () => {
    const c = active();
    symbolDialog({ contracts: c.contracts, current: c.state.symbol, feedLabel: c.adapter ? c.adapter.label : '', onPick: (symbol) => setCell(workspace.get().active, { symbol }) });
  } }, svg('search'), symText);
  // 3. chart type
  const typeBtn = h('button', { type: 'button', class: 'cx-iconbtn', 'aria-haspopup': 'menu', onClick: () => {
    const cur = activeCell().chartType || 'candles';
    popMenu(typeBtn, Object.entries(CHART_TYPE_LABEL).map(([id, label]) => ({ label, icon: svg(id), checked: cur === id, onClick: () => setCell(workspace.get().active, { chartType: id }) })));
  } });
  // 5. drawings panel switch
  const drawSwitch = h('button', { type: 'button', class: 'cx-switch', role: 'switch', title: 'Show or hide the drawing tools', onClick: () => {
    const on = !workspace.get().draw.panel;
    if (!on) cells.forEach((c) => c.layer.setTool('cursor'));
    setDraw({ panel: on });
  } }, h('span', null, 'Drawings'), h('i', { class: 'cx-knob' }));
  const editorBtn = btn('Pine Editor', 'Open the Pine Script editor (Alt+P)', () => setEditor({ open: !workspace.get().editor.open, tab: 'editor' }));
  const replayBtn = btn('Replay', 'Bar replay: cut the focused chart at a past bar and play it forward', () => { const c = active(); c.replay || c.selecting ? c.exitReplay() : c.startReplaySelect(); });
  // 8. one Alert button: new alert, or manage the list
  const alertBtn = h('button', { type: 'button', class: 'btn cx-tool cx-dd', 'aria-haspopup': 'menu', title: 'Create or manage alerts', onClick: () => {
    const armed = alerts.get().filter((a) => a.active).length;
    popMenu(alertBtn, [
      { label: 'New alert…', hint: activeCell().symbol, onClick: () => newAlert() },
      { label: 'Manage alerts', hint: `${armed} armed`, onClick: () => alertsListDialog({ fmt: fmtFor }) },
    ]);
  } }, 'Alert', svg('chev'));
  const watchBtn = btn('Watchlist', 'Show or hide the watchlist', () => workspace.set({ watchOpen: !workspace.get().watchOpen }));
  const sep = () => h('span', { class: 'cx-sep', 'aria-hidden': 'true' });
  const toolbar = h('div', { class: 'cx-toolbar' },
    symBtn, typeBtn, tfSel, sep(),
    btn('Indicators', 'Add an indicator or one of your scripts to the focused chart', () => indicatorDialog({ onAdd: (ref) => addStudy(ref), onNewScript: () => drawer.openNew(NEW_SCRIPT) })),
    btn('Templates', 'Indicator templates and saved layouts', () => templatesDialog()),
    sep(), drawSwitch, editorBtn, replayBtn, alertBtn,
    sep(), layoutSeg, syncSeg,
    h('span', { class: 'grow' }),
    watchBtn,
    btn('Latest', 'Jump to the latest bar', () => active().engine.scrollToRealtime()),
    savedChip, feedChip, feedSel);

  const grid = h('div', { class: 'cx-grid' });
  const toasts = h('div', { class: 'cx-toasts', 'aria-live': 'assertive' });
  const watch = createWatchlist({
    getAdapter: () => adapterFor(workspace.get().feed),
    getContracts: () => adapterFor(workspace.get().feed).contracts(),
    currentSymbol: () => activeCell().symbol,
    onPick: (symbol) => setCell(workspace.get().active, { symbol }),
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
  const page = h('div', { class: 'cx-page' }, toolbar, main, drawer.el);
  clear(root).append(page);

  const rail = createDrawRail(() => (active() ? active().layer : null), {
    onAlert: (price) => newAlert(price),
    refreshAll: () => cells.forEach((c) => c.layer.refresh()),
  });
  cleanups.push(() => rail.dispose(), () => drawer.dispose(), () => watch.dispose());

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
        if (cell === active()) { watch.markCurrent(cell.contract.symbol); paintToolbar(); }
        paintFeed();
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
    if (a.contract) watch.markCurrent(a.contract.symbol);
    paintToolbar();
  }

  function paintToolbar() {
    const w = workspace.get();
    const c = w.cells[w.active];
    const lay = ['1x1', '1x2', '2x2'];
    [...layoutSeg.children].forEach((b, i) => b.setAttribute('aria-pressed', String(w.layout === lay[i])));
    [...syncSeg.children].forEach((b, i) => b.setAttribute('aria-pressed', String([w.sync.symbol, w.sync.tf, w.sync.crosshair][i])));
    syncSeg.classList.toggle('hide', w.layout === '1x1');
    tfSel.value = c.tf;
    symText.textContent = c.symbol || '—';
    const type = c.chartType || 'candles';
    typeBtn.replaceChildren(svg(type));
    typeBtn.title = `Chart type: ${CHART_TYPE_LABEL[type]}`;
    typeBtn.setAttribute('aria-label', typeBtn.title);
    drawSwitch.setAttribute('aria-checked', String(w.draw.panel));
    rail.rail.classList.toggle('hide', !w.draw.panel);
    main.classList.toggle('no-rail', !w.draw.panel);
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

  function toast(title, body, icon = '⏰') {
    const t = h('div', { class: 'cx-toast', role: 'alert' }, h('b', null, icon + ' ' + title), h('div', null, body),
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
    workspace.subscribe((w) => w.feed, (feed) => { warnedFallback = false; watch.refresh(); alertEngine.sync(); paintToolbar(); paintFeed(); adapterFor(feed).contracts().then(paintFeed, paintFeed); }),
    workspace.subscribe((w) => w.cells[w.active].tf + '|' + w.cells[w.active].symbol + '|' + w.cells[w.active].chartType + '|' + w.draw.panel + '|' + w.editor.open + '|' + w.watchOpen + '|' + JSON.stringify(w.sync), paintToolbar),
    alerts.subscribe((x) => x, () => { for (const c of cells) if (c.contract) c.setAlertLines(priceAlertsFor(c.contract.symbol)); }),
  );

  const onKey = (e) => {
    if (e.target && /^(INPUT|TEXTAREA|SELECT)$/.test(e.target.tagName)) return;
    if (active() && active().replayKey(e)) { e.preventDefault(); return; }
    if (e.altKey && e.key.toLowerCase() === 'p') { e.preventDefault(); setEditor({ open: !workspace.get().editor.open }); }
  };
  addEventListener('keydown', onKey);
  cleanups.push(() => removeEventListener('keydown', onKey));

  // ---------------------------------------------------------------- auto-save
  // Every store already saves itself a moment after each change. This also writes everything
  // every 2 minutes and when the tab is hidden or closed, so nothing waits on a pending timer.
  function saveAll() {
    for (const st of [workspace, scripts, watchlists, templates, layouts, alerts, drawStyles]) { try { st.flush(); } catch (err) { console.error(err); } }
    for (const c of cells) c.layer.flushSave(true);
    const t = new Date();
    savedChip.textContent = `Saved ${String(t.getHours()).padStart(2, '0')}:${String(t.getMinutes()).padStart(2, '0')}`;
  }
  const saveTimer = setInterval(saveAll, 120000);
  const onHide = () => { if (document.visibilityState === 'hidden') saveAll(); };
  document.addEventListener('visibilitychange', onHide);
  addEventListener('pagehide', saveAll);
  cleanups.push(() => { clearInterval(saveTimer); document.removeEventListener('visibilitychange', onHide); removeEventListener('pagehide', saveAll); saveAll(); });

  layoutCells();
  paintToolbar();
  saveAll();
  paintFeed();
  adapterFor(workspace.get().feed).contracts().then(paintFeed, paintFeed);

  return () => {
    for (const f of cleanups) f();
    while (cells.length) cells.pop().dispose();
  };
}
