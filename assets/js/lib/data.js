// Static JSON loader, with a small per-session memo cache.
const memo = new Map();

export async function getJSON(path, { fresh = false } = {}) {
  if (!fresh && memo.has(path)) return memo.get(path);
  const p = (async () => {
    try {
      const res = await fetch(path, { cache: 'no-cache' });
      if (!res.ok) return null;
      return await res.json();
    } catch (e) {
      console.warn('getJSON failed', path, e);
      return null;
    }
  })();
  memo.set(path, p);
  const val = await p;
  if (val == null) memo.delete(path);
  return val;
}

export function clearMemo() { memo.clear(); }
