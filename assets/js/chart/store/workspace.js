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
 * @typedef {Object} Workspace
 * @property {'synthetic'|'binance'} feed @property {string} symbol @property {string} tf
 * @property {Study[]} studies
 * @property {{ open: boolean, height: number, scriptId: string|null, draft: string, tab: 'editor'|'library' }} editor
 * @property {{ magnet: boolean, hidden: boolean }} draw  drawing-tool preferences
 */

const KEY_WS = 'chart:workspace';
const KEY_SCRIPTS = 'chart:scripts';

/** @type {Workspace} */
const DEFAULT_WS = {
  feed: 'synthetic', symbol: 'BTCUSDT.P', tf: '1h',
  studies: [
    { uid: 's1', ref: 'builtin:ema', inputs: {}, styles: {}, hidden: false },
    { uid: 's2', ref: 'builtin:rsi', inputs: {}, styles: {}, hidden: false },
  ],
  editor: { open: false, height: 300, scriptId: null, draft: '', tab: 'editor' },
  draw: { magnet: true, hidden: false },
};

export function uid(prefix = 'x') { return prefix + Date.now().toString(36) + Math.random().toString(36).slice(2, 7); }

function createStore(initial, persist) {
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
    /** Subscribe to a slice; the listener only fires when selector(state) changes (by ===). */
    subscribe(selector, fn) {
      let last = selector(state);
      const s = (st) => { const v = selector(st); if (v !== last) { const old = last; last = v; fn(v, old); } };
      subs.add(s);
      return () => subs.delete(s);
    },
  };
}

function loadWs() {
  const w = store.get(KEY_WS, null);
  if (!w || typeof w !== 'object') return structuredClone(DEFAULT_WS);
  return {
    ...structuredClone(DEFAULT_WS), ...w,
    editor: { ...DEFAULT_WS.editor, ...(w.editor || {}) },
    draw: { ...DEFAULT_WS.draw, ...(w.draw || {}) },
    studies: Array.isArray(w.studies) ? w.studies.filter((s) => s && s.uid && s.ref).map((s) => ({ inputs: {}, styles: {}, hidden: false, ...s })) : [],
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
  workspace.set((w) => ({ ...w, studies: w.studies.filter((st) => st.ref !== 'script:' + id), editor: w.editor.scriptId === id ? { ...w.editor, scriptId: null } : w.editor }));
}

// ---- studies on the chart
export function addStudy(ref) {
  const st = { uid: uid('s'), ref, inputs: {}, styles: {}, hidden: false };
  workspace.set((w) => ({ ...w, studies: [...w.studies, st] }));
  return st;
}
export function removeStudy(uidv) { workspace.set((w) => ({ ...w, studies: w.studies.filter((s) => s.uid !== uidv) })); }
export function patchStudy(uidv, patch) {
  workspace.set((w) => ({ ...w, studies: w.studies.map((s) => (s.uid === uidv ? { ...s, ...patch } : s)) }));
}
export function setDraw(patch) { workspace.set((w) => ({ ...w, draw: { ...w.draw, ...patch } })); }
export function setEditor(patch) { workspace.set((w) => ({ ...w, editor: { ...w.editor, ...patch } })); }
