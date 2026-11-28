// localStorage that never throws (private windows, blocked storage, previews).
const mem = new Map();
// After a settings restore the page reloads; until then nothing may write over the restored
// values (the chart saves its state when the page is hidden).
let frozen = false;
export function freezeWrites() { frozen = true; }
export const store = {
  get(k, fallback = null) {
    try { const v = localStorage.getItem('trilens:' + k); return v == null ? (mem.has(k) ? mem.get(k) : fallback) : JSON.parse(v); }
    catch { return mem.has(k) ? mem.get(k) : fallback; }
  },
  set(k, v) {
    mem.set(k, v);
    if (frozen) return;
    try { localStorage.setItem('trilens:' + k, JSON.stringify(v)); } catch { /* memory only */ }
  },
  del(k) { mem.delete(k); if (frozen) return; try { localStorage.removeItem('trilens:' + k); } catch { /* ignore */ } },
};
