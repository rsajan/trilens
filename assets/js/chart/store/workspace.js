// Workspace state for the chart page: a tiny observable store (Zustand-style: get / set / subscribe
// with selectors) persisted to localStorage through lib/store.js, which never throws.
//
// Why localStorage and not IndexedDB: scripts and chart settings are a few KB, are read once at
// start, and must be available synchronously to paint the first frame. IndexedDB earns its keep
// later for drawings, replay snapshots and templates; it is not worth an async layer today.

import { store } from '../../lib/store.js';

/**
 * @typedef {{ id: string, name: string, source: string, createdAt: number, updatedAt: number }} Script
 * @typedef {{ uid: string, ref: string, inputs: Record<string, any>, styles: Record<string, { color?: string, hidden?: boolean }>, hidden: boolean }} Study
 * @typedef {{ symbol: string, tf: string, chartType: 'candles'|'bars'|'line'|'area', studies: Study[] }} Cell  one chart of the split-screen layout
 * @typedef {Object} Workspace
 * @property {'live'|'binance'|'bybit'|'synthetic'} feed  live = first reachable exchange (see data/live.js)
 * @property {number} v  saved-format version (2: live feed is the default)
 * @property {'1x1'|'1x2'|'2x2'} layout @property {number} active index of the focused cell
 * @property {{ symbol: boolean, tf: boolean, crosshair: boolean }} sync  what follows the focused cell
 * @property {Cell[]} cells  always four; the layout decides how many are shown
 * @property {{ open: boolean, height: number, scriptId: string|null, draft: string, tab: 'editor'|'library' }} editor
 * @property {{ magnet: boolean, hidden: boolean, panel: boolean }} draw  drawing-tool preferences; panel: show the tool rail
 * @property {boolean} watchOpen  watchlist panel shown
 */

const KEY_WS = 'chart:workspace';
const KEY_SCRIPTS = 'chart:scripts';
export const LAYOUT_CELLS = { '1x1': 1, '1x2': 2, '2x2': 4 };
export const CHART_TYPES = ['candles', 'bars', 'line', 'area'];

const study = (uidv, ref) => ({ uid: uidv, ref, inputs: {}, styles: {}, hidden: false });
/** @type {Workspace} */
const DEFAULT_WS = {
  v: 2, feed: 'live', layout: '1x1', active: 0,
  sync: { symbol: false, tf: false, crosshair: true },
  cells: [
    { symbol: 'BTCUSDT.P', tf: '1h', studies: [study('s1', 'builtin:ema'), study('s2', 'builtin:rsi')] },
    { symbol: 'ETHUSDT.P', tf: '1h', studies: [study('s3', 'builtin:ema')] },
    { symbol: 'BTCUSDT.P', tf: '15m', studies: [study('s4', 'builtin:vwap')] },
    { symbol: 'SOLUSDT.P', tf: '4h', studies: [study('s5', 'builtin:bb')] },
  ],
  editor: { open: false, height: 300, scriptId: null, draft: '', tab: 'editor' },
  draw: { magnet: true, hidden: false, panel: true },
  watchOpen: true,
};

export function uid(prefix = 'x') { return prefix + Date.now().toString(36) + Math.random().toString(36).slice(2, 7); }

export function createStore(initial, persist) {
  let state = initial;
  const subs = new Set();
  let saveTimer = 0;
  return {
    get: () => state,
    /** @param {(s: any) => any | object} patch */
    set(patch) {
      // a function computes the next state; an array or a non-object state is replaced;
      // a plain object is merged into a plain-object state
      const next = typeof patch === 'function' ? patch(state)
        : Array.isArray(patch) || Array.isArray(state) || typeof state !== 'object' ? patch
          : { ...state, ...patch };
      if (next === state) return;
      state = next;
      // one failing listener must not stop the others (or the save below)
      for (const s of subs) { try { s(state); } catch (err) { console.error(err); } }
      clearTimeout(saveTimer);
      saveTimer = setTimeout(() => persist(state), 150);
    },
    /** Write the current state now (the debounced save may still be pending). */
    flush() { clearTimeout(saveTimer); persist(state); },
    /** Subscribe to a slice; the listener only fires when selector(state) changes (by ===). */
    subscribe(selector, fn) {
      let last = selector(state);
      const s = (st) => { const v = selector(st); if (v !== last) { const old = last; last = v; fn(v, old); } };
      subs.add(s);
      return () => subs.delete(s);
    },
  };
}

const cleanStudies = (list) => (Array.isArray(list) ? list.filter((x) => x && x.uid && x.ref).map((x) => ({ inputs: {}, styles: {}, hidden: false, ...x })) : []);

function loadWs() {
  const w = store.get(KEY_WS, null);
  const d = structuredClone(DEFAULT_WS);
  if (!w || typeof w !== 'object') return d;
  let cells = Array.isArray(w.cells) ? w.cells : null;
  // single-chart workspaces saved before split layouts existed become cell 0
  if (!cells && w.symbol) cells = [{ symbol: w.symbol, tf: w.tf || '1h', studies: w.studies }];
  cells = d.cells.map((dc, i) => {
    const c = cells && cells[i];
    return c && typeof c === 'object' ? { symbol: typeof c.symbol === 'string' ? c.symbol : dc.symbol, tf: typeof c.tf === 'string' ? c.tf : dc.tf, chartType: CHART_TYPES.includes(c.chartType) ? c.chartType : 'candles', studies: cleanStudies(c.studies) } : { ...dc, chartType: 'candles' };
  });
  const layout = LAYOUT_CELLS[w.layout] ? w.layout : '1x1';
  return {
    v: 2,
    // before v2 the default feed was synthetic: move those workspaces to live data once
    feed: !w.v && (w.feed === 'synthetic' || !w.feed) ? 'live' : ['live', 'binance', 'bybit', 'synthetic'].includes(w.feed) ? w.feed : 'live',
    layout,
    active: Number.isInteger(w.active) && w.active >= 0 && w.active < LAYOUT_CELLS[layout] ? w.active : 0,
    sync: { ...d.sync, ...(w.sync || {}) },
    cells,
    editor: { ...d.editor, ...(w.editor || {}) },
    draw: { ...d.draw, ...(w.draw || {}) },
    watchOpen: w.watchOpen !== false,
  };
}

export const workspace = createStore(loadWs(), (s) => store.set(KEY_WS, s));

/** @type {ReturnType<typeof createStore>} */
export const scripts = createStore(
  (() => { const v = store.get(KEY_SCRIPTS, []); return Array.isArray(v) ? v.filter((x) => x && x.id && typeof x.source === 'string') : []; })(),
  (s) => store.set(KEY_SCRIPTS, s),
);

/** @returns {Script|undefined} */
export const getScript = (id) => scripts.get().find((s) => s.id === id);

/** @returns {Script} */
export function saveScript({ id, name, source }) {
  const now = Date.now();
  const list = scripts.get();
  const existing = id && list.find((s) => s.id === id);
  if (existing) {
    const upd = { ...existing, name: name ?? existing.name, source, updatedAt: now };
    scripts.set(list.map((s) => (s.id === id ? upd : s)));
    return upd;
  }
  const created = { id: uid('p'), name: name || 'Untitled script', source, createdAt: now, updatedAt: now };
  scripts.set([...list, created]);
  return created;
}

export function renameScript(id, name) {
  scripts.set(scripts.get().map((s) => (s.id === id ? { ...s, name, updatedAt: Date.now() } : s)));
}

export function duplicateScript(id) {
  const s = getScript(id);
  if (!s) return null;
  return saveScript({ name: s.name + ' (copy)', source: s.source });
}

export function deleteScript(id) {
  scripts.set(scripts.get().filter((s) => s.id !== id));
  workspace.set((w) => ({ ...w, cells: w.cells.map((c) => ({ ...c, studies: c.studies.filter((st) => st.ref !== 'script:' + id) })), editor: w.editor.scriptId === id ? { ...w.editor, scriptId: null } : w.editor }));
}

// ---- cells, layout and sync
export const activeCell = () => workspace.get().cells[workspace.get().active];
export const visibleCount = () => LAYOUT_CELLS[workspace.get().layout];
export function setLayout(layout) {
  if (!LAYOUT_CELLS[layout]) return;
  workspace.set((w) => ({ ...w, layout, active: w.active < LAYOUT_CELLS[layout] ? w.active : 0 }));
}
export function setActive(i) { workspace.set((w) => (w.active === i ? w : { ...w, active: i })); }
export function setSync(patch) { workspace.set((w) => ({ ...w, sync: { ...w.sync, ...patch } })); }
/** Change a cell's symbol or timeframe; with sync on, every visible cell follows. */
export function setCell(i, patch) {
  workspace.set((w) => {
    const n = LAYOUT_CELLS[w.layout];
    const cells = w.cells.map((c, k) => {
      const p = {};
      if (patch.symbol !== undefined && (k === i || (w.sync.symbol && k < n))) p.symbol = patch.symbol;
      if (patch.tf !== undefined && (k === i || (w.sync.tf && k < n))) p.tf = patch.tf;
      if (patch.studies !== undefined && k === i) p.studies = patch.studies;
      if (patch.chartType !== undefined && k === i) p.chartType = patch.chartType;
      return Object.keys(p).length ? { ...c, ...p } : c;
    });
    return { ...w, cells };
  });
}

// ---- studies on a chart (default: the focused cell); uids are unique across cells
export function addStudy(ref, cell = workspace.get().active) {
  const st = study(uid('s'), ref);
  setCell(cell, { studies: [...workspace.get().cells[cell].studies, st] });
  return st;
}
const mapStudies = (fn) => workspace.set((w) => ({ ...w, cells: w.cells.map((c) => { const next = fn(c.studies); return next === c.studies ? c : { ...c, studies: next }; }) }));
export function removeStudy(uidv) { mapStudies((list) => (list.some((s) => s.uid === uidv) ? list.filter((s) => s.uid !== uidv) : list)); }
export function patchStudy(uidv, patch) { mapStudies((list) => (list.some((s) => s.uid === uidv) ? list.map((s) => (s.uid === uidv ? { ...s, ...patch } : s)) : list)); }
/** Replace a cell's studies with copies of a template's (fresh uids). */
export function applyStudies(cell, list) {
  setCell(cell, { studies: list.map((s) => ({ ...study(uid('s'), s.ref), inputs: { ...(s.inputs || {}) }, styles: structuredClone(s.styles || {}), hidden: !!s.hidden })) });
}
export function setDraw(patch) { workspace.set((w) => ({ ...w, draw: { ...w.draw, ...patch } })); }
export function setEditor(patch) { workspace.set((w) => ({ ...w, editor: { ...w.editor, ...patch } })); }
