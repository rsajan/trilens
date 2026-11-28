// One-time tidy of the imported "17 signals" pack, as the owner chose (Nov 2026): keep EMA Playbook
// S1/S2/S5 and Reversal Bot v5/v6 under their full version names, remove the other versions.
// Runs once per browser, by script name only; renamed scripts keep their id, so charts using them
// keep working. Scripts you renamed yourself are left alone.
import { store } from '../../lib/store.js';
import { scripts, deleteScript } from './workspace.js';

const FLAG = 'scriptTidy1';
const RENAME = {
  '05 · EMA Playbook S1 (Trilens)': '05 · EMA Playbook S1 Monthly50 + Weekly200 + Daily20 (Trilens)',
  '05 · EMA Playbook S2 (Trilens)': '05 · EMA Playbook S2 Weekly 50 EMA Reclaim (Trilens)',
  '05 · EMA Playbook S5 (Trilens)': '05 · EMA Playbook S5 Weekly 50/200 EMA Confluence (Trilens)',
  '17 · Reversal Bot v5 (Trilens)': '17 · Reversal Bot v5 trend200 4R (Trilens)',
  '17 · Reversal Bot v6 (Trilens)': '17 · Reversal Bot v6 L11 rsi30 ema200 (Trilens)',
};
const REMOVE = new Set([
  '05 · EMA Playbook S3 (Trilens)', '05 · EMA Playbook S6 (Trilens)',
  '17 · Reversal Bot S3 Range Break (Trilens)', '17 · Reversal Bot EMA20 Confirm (Trilens)', '17 · Reversal Bot FIB33 + EMA20 (Trilens)',
]);

/** The script's own title (first strategy()/indicator() argument) follows the new name. */
export function retitle(source, name) {
  const title = name.replace(/^\d+ · /, '');
  return source.replace(/((?:strategy|indicator)\(\s*")[^"]*(")/, (_, a, b) => a + title + b);
}

/** @returns {{ renamed: number, removed: number }} what changed (zeros when there was nothing to do) */
export function tidyScripts() {
  if (store.get(FLAG)) return { renamed: 0, removed: 0 };
  const list = scripts.get();
  const gone = list.filter((s) => REMOVE.has(s.name));
  let renamed = 0;
  const next = list.filter((s) => !REMOVE.has(s.name)).map((s) => {
    const to = RENAME[s.name];
    if (!to || list.some((x) => x.name === to)) return s;
    renamed++;
    return { ...s, name: to, source: retitle(s.source, to), updatedAt: Date.now() };
  });
  scripts.set(next);
  for (const s of gone) deleteScript(s.id); // also takes them off any chart
  store.set(FLAG, true);
  return { renamed, removed: gone.length };
}
