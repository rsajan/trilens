// localStorage that never throws (private windows, blocked storage, previews).
const mem = new Map();
// After a settings restore the page reloads; until then nothing may write over the restored
// values (the chart saves its state when the page is hidden).
let frozen = false;
export function freezeWrites() { frozen = true; }
// Settings sync: note when a synced setting really changes (same value written again does not count).
const NOT_SYNCED = /^(techpass|gh_token|gist_id|watchlists|sync:)/;
function markChanged(k, json) {
  if (NOT_SYNCED.test(k)) return;
  try {
    if (localStorage.getItem('trilens:' + k) === json) return;
    localStorage.setItem('trilens:sync:changedAt', String(Date.now()));
  } catch { /* ignore */ }
}
export const store = {
  get(k, fallback = null) {
    try { const v = localStorage.getItem('trilens:' + k); return v == null ? (mem.has(k) ? mem.get(k) : fallback) : JSON.parse(v); }
    catch { return mem.has(k) ? mem.get(k) : fallback; }
  },
  set(k, v) {
    mem.set(k, v);
    if (frozen) return;
    try { const j = JSON.stringify(v); markChanged(k, j); localStorage.setItem('trilens:' + k, j); } catch { /* memory only */ }
  },
  del(k) { mem.delete(k); if (frozen) return; markChanged(k, null); try { localStorage.removeItem('trilens:' + k); } catch { /* ignore */ } },
};
