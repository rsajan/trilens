// Client-only shortcuts to companies outside the curated watchlist ("+ Pin" on a lookup page).
// Stored on this device alone (localStorage); picking one never touches config/watchlist.json
// and fetches no price, analyst or sentiment data - it is just a fast way back to a lookup page.
// Add it to config/watchlist.json on the PC for the full, data-backed view.
import { store } from './store.js';

const KEY = 'pins';

export function listPins() {
  return store.get(KEY, []);
}

export function isPinned(sym) {
  return listPins().some((p) => p.sym === sym);
}

export function togglePin(sym, name, kind) {
  const pins = listPins();
  const i = pins.findIndex((p) => p.sym === sym);
  if (i >= 0) pins.splice(i, 1);
  else pins.unshift({ sym, name, kind, at: Date.now() });
  store.set(KEY, pins.slice(0, 60));
  return i < 0; // true if it is now pinned
}

export function hrefFor(p) {
  return p.kind === 'in' ? `#/fundamentals/india/${encodeURIComponent(p.sym)}` : `#/fundamentals/lookup/${encodeURIComponent(p.sym)}`;
}
