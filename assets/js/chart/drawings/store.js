// Drawings persisted per symbol in IndexedDB (shared across timeframes, like TradingView).
// Falls back to localStorage if IndexedDB is unavailable (some private windows), and to memory
// if that fails too: drawing must never break because storage is blocked.

import { store as ls } from '../../lib/store.js';

const DB = 'trilens-chart', STORE = 'drawings';
let dbp = null;

function open() {
  if (dbp) return dbp;
  dbp = new Promise((resolve) => {
    try {
      const req = indexedDB.open(DB, 1);
      req.onupgradeneeded = () => req.result.createObjectStore(STORE);
      req.onsuccess = () => resolve(req.result);
      req.onerror = () => resolve(null);
      req.onblocked = () => resolve(null);
    } catch { resolve(null); }
  });
  return dbp;
}

/** @returns {Promise<import('./geometry.js').Drawing[]>} */
export async function loadDrawings(symbol) {
  const db = await open();
  if (!db) return ls.get('chart:drawings:' + symbol, []);
  return new Promise((resolve) => {
    try {
      const req = db.transaction(STORE, 'readonly').objectStore(STORE).get(symbol);
      req.onsuccess = () => resolve(Array.isArray(req.result) ? req.result : []);
      req.onerror = () => resolve([]);
    } catch { resolve([]); }
  });
}

export async function saveDrawings(symbol, drawings) {
  const db = await open();
  const plain = JSON.parse(JSON.stringify(drawings));
  if (!db) { ls.set('chart:drawings:' + symbol, plain); return; }
  await new Promise((resolve) => {
    try {
      const tx = db.transaction(STORE, 'readwrite');
      tx.objectStore(STORE).put(plain, symbol);
      tx.oncomplete = tx.onerror = tx.onabort = () => resolve();
    } catch { ls.set('chart:drawings:' + symbol, plain); resolve(); }
  });
}
