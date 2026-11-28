// Back up and restore everything this site keeps in the browser: chart layouts, drawings, Pine
// scripts, watchlists, alerts, templates and chart settings. They live only in this browser
// (localStorage), so a backup file is how you move them to another device or keep them safe.
// Never included: your Technical password and your GitHub token.

const PREFIX = 'trilens:';
const SECRET = new Set(['techpass', 'gh_token', 'gist_id']);
export const FORMAT = 'trilens-backup';

/** @returns {{ format: string, version: number, exported: string, items: Record<string, string> }} */
export function collect(storage = localStorage) {
  const items = {};
  for (let i = 0; i < storage.length; i++) {
    const k = storage.key(i);
    if (!k || !k.startsWith(PREFIX)) continue;
    const name = k.slice(PREFIX.length);
    if (SECRET.has(name)) continue;
    items[name] = storage.getItem(k);
  }
  return { format: FORMAT, version: 1, exported: new Date().toISOString(), items };
}

/** Write a backup back; returns how many settings were restored. Throws on a file that is not a backup. */
export function restore(obj, storage = localStorage) {
  if (!obj || obj.format !== FORMAT || typeof obj.items !== 'object') throw new Error('This is not a Trilens settings backup file.');
  let n = 0;
  for (const [name, val] of Object.entries(obj.items)) {
    if (SECRET.has(name) || typeof val !== 'string') continue;
    storage.setItem(PREFIX + name, val);
    n++;
  }
  return n;
}

export function download() {
  const data = collect();
  const blob = new Blob([JSON.stringify(data, null, 1)], { type: 'application/json' });
  const a = document.createElement('a');
  a.href = URL.createObjectURL(blob);
  a.download = `trilens-settings-${data.exported.slice(0, 10)}.json`;
  document.body.append(a); a.click(); a.remove();
  setTimeout(() => URL.revokeObjectURL(a.href), 2000);
  return Object.keys(data.items).length;
}
