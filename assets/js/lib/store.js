// localStorage that never throws (private windows, blocked storage, previews).
const mem = new Map();
export const store = {
  get(k, fallback = null) {
    try { const v = localStorage.getItem('trilens:' + k); return v == null ? (mem.has(k) ? mem.get(k) : fallback) : JSON.parse(v); }
    catch { return mem.has(k) ? mem.get(k) : fallback; }
  },
  set(k, v) {
    mem.set(k, v);
    try { localStorage.setItem('trilens:' + k, JSON.stringify(v)); } catch { /* memory only */ }
  },
  del(k) { mem.delete(k); try { localStorage.removeItem('trilens:' + k); } catch { /* ignore */ } },
};
