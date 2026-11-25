// Saved things that are not the live workspace: watchlists, indicator templates, layout presets
// and price alerts. Each is a small observable store persisted in localStorage (lib/store.js
// never throws). All of it stays in this browser.

import { store } from '../../lib/store.js';
import { createStore, uid, workspace, LAYOUT_CELLS } from './workspace.js';

const load = (key, fallback, ok) => { const v = store.get(key, fallback); return ok(v) ? v : fallback; };

// ------------------------------------------------------------------ watchlists
/**
 * @typedef {{ symbol: string, flag: string|null }} WatchItem  flag: one of FLAGS or null
 * @typedef {{ id: string, name: string, items: WatchItem[] }} WatchList
 */
export const FLAGS = ['#ff7a73', '#f0b849', '#2fcb92', '#3987e5', '#9085e9'];
const DEFAULT_LISTS = {
  active: 'w1',
  lists: [
    { id: 'w1', name: 'Crypto perps', items: ['BTCUSDT.P', 'ETHUSDT.P', 'SOLUSDT.P', 'BNBUSDT.P'].map((symbol) => ({ symbol, flag: null })) },
    { id: 'w2', name: 'Majors & gold', items: ['BTCUSDT.P', 'BTCUSDT.Q', 'XAUUSDT.P'].map((symbol) => ({ symbol, flag: null })) },
  ],
};
export const watchlists = createStore(
  load('chart:watchlists', structuredClone(DEFAULT_LISTS), (v) => v && Array.isArray(v.lists) && v.lists.length && v.lists.every((l) => l.id && Array.isArray(l.items))),
  (s) => store.set('chart:watchlists', s),
);
export const activeList = () => { const w = watchlists.get(); return w.lists.find((l) => l.id === w.active) || w.lists[0]; };
const patchList = (id, fn) => watchlists.set((w) => ({ ...w, lists: w.lists.map((l) => (l.id === id ? fn(l) : l)) }));
export function addList(name) { const l = { id: uid('w'), name, items: [] }; watchlists.set((w) => ({ active: l.id, lists: [...w.lists, l] })); return l; }
export function renameList(id, name) { patchList(id, (l) => ({ ...l, name })); }
export function deleteList(id) {
  watchlists.set((w) => {
    const lists = w.lists.filter((l) => l.id !== id);
    if (!lists.length) lists.push({ id: uid('w'), name: 'Watchlist', items: [] });
    return { active: w.active === id ? lists[0].id : w.active, lists };
  });
}
export function selectList(id) { watchlists.set((w) => ({ ...w, active: id })); }
export function addToList(id, symbol) { patchList(id, (l) => (l.items.some((x) => x.symbol === symbol) ? l : { ...l, items: [...l.items, { symbol, flag: null }] })); }
export function removeFromList(id, symbol) { patchList(id, (l) => ({ ...l, items: l.items.filter((x) => x.symbol !== symbol) })); }
/** Cycle an item's colour flag: none -> each flag -> none. */
export function cycleFlag(id, symbol) {
  patchList(id, (l) => ({ ...l, items: l.items.map((x) => {
    if (x.symbol !== symbol) return x;
    const i = x.flag ? FLAGS.indexOf(x.flag) : -1;
    return { ...x, flag: i + 1 < FLAGS.length ? FLAGS[i + 1] : null };
  }) }));
}
export function moveInList(id, symbol, dir) {
  patchList(id, (l) => {
    const i = l.items.findIndex((x) => x.symbol === symbol), j = i + dir;
    if (i < 0 || j < 0 || j >= l.items.length) return l;
    const items = l.items.slice(); [items[i], items[j]] = [items[j], items[i]];
    return { ...l, items };
  });
}

// ------------------------------------------------------------------ indicator templates & layouts
/** @typedef {{ id: string, name: string, studies: { ref: string, inputs: object, styles: object, hidden: boolean }[] }} Template */
export const templates = createStore(load('chart:templates', [], Array.isArray), (s) => store.set('chart:templates', s));
const strip = (studies) => studies.map(({ ref, inputs, styles, hidden }) => ({ ref, inputs: structuredClone(inputs || {}), styles: structuredClone(styles || {}), hidden: !!hidden }));
export function saveTemplate(name, studies) { const t = { id: uid('t'), name, studies: strip(studies) }; templates.set([...templates.get(), t]); return t; }
export function deleteTemplate(id) { templates.set(templates.get().filter((t) => t.id !== id)); }

/** @typedef {{ id: string, name: string, layout: string, sync: object, cells: { symbol: string, tf: string, studies: any[] }[] }} LayoutPreset */
export const layouts = createStore(load('chart:layouts', [], Array.isArray), (s) => store.set('chart:layouts', s));
export function saveLayout(name) {
  const w = workspace.get();
  const p = { id: uid('l'), name, layout: w.layout, sync: { ...w.sync }, cells: w.cells.map((c) => ({ symbol: c.symbol, tf: c.tf, studies: strip(c.studies) })) };
  layouts.set([...layouts.get(), p]);
  return p;
}
export function applyLayout(id) {
  const p = layouts.get().find((x) => x.id === id);
  if (!p) return;
  workspace.set((w) => ({
    ...w,
    layout: LAYOUT_CELLS[p.layout] ? p.layout : '1x1',
    active: 0,
    sync: { ...w.sync, ...p.sync },
    cells: w.cells.map((c, i) => {
      const pc = p.cells[i];
      if (!pc) return c;
      return { symbol: pc.symbol, tf: pc.tf, studies: pc.studies.map((s) => ({ uid: uid('s'), ref: s.ref, inputs: structuredClone(s.inputs || {}), styles: structuredClone(s.styles || {}), hidden: !!s.hidden })) };
    }),
  }));
}
export function deleteLayout(id) { layouts.set(layouts.get().filter((x) => x.id !== id)); }

// ------------------------------------------------------------------ alerts
/**
 * @typedef {Object} Alert
 * @property {string} id @property {string} symbol @property {'crosses'|'above'|'below'} cond
 * @property {number} price @property {string} note @property {boolean} active
 * @property {number} created @property {number|null} firedAt @property {number|null} firedPrice
 */
export const alerts = createStore(load('chart:alerts', [], Array.isArray), (s) => store.set('chart:alerts', s));
export function addAlert({ symbol, cond, price, note }) {
  const a = { id: uid('a'), symbol, cond, price, note: note || '', active: true, created: Date.now(), firedAt: null, firedPrice: null };
  alerts.set([...alerts.get(), a]);
  return a;
}
export function patchAlert(id, patch) { alerts.set(alerts.get().map((a) => (a.id === id ? { ...a, ...patch } : a))); }
export function deleteAlert(id) { alerts.set(alerts.get().filter((a) => a.id !== id)); }

/**
 * Has the alert's condition been met by the move from prev to last? Pure, so it is tested.
 * "crosses" fires when the price passes or touches the level from either side;
 * "above"/"below" fire on the first price at or beyond the level, even with no previous price.
 */
export function alertHit(cond, level, prev, last) {
  if (!Number.isFinite(last)) return false;
  if (cond === 'above') return last >= level;
  if (cond === 'below') return last <= level;
  if (!Number.isFinite(prev)) return false;
  return (prev < level && last >= level) || (prev > level && last <= level);
}
