// Tests for importing/exporting Pine script packs. Run with: node --test "tests/*.test.mjs"
import test from 'node:test';
import assert from 'node:assert/strict';
import { parsePack, buildPack } from '../assets/js/chart/store/script-pack.js';

test('pack round trip keeps names and sources', () => {
  const pack = buildPack([{ name: 'A', source: 'indicator("A")\nplot(close)', id: 'x' }, { name: 'B', source: 'indicator("B")\nplot(open)' }]);
  const { scripts, skipped } = parsePack('trilens-scripts.json', pack);
  assert.deepEqual(scripts, [{ name: 'A', source: 'indicator("A")\nplot(close)' }, { name: 'B', source: 'indicator("B")\nplot(open)' }]);
  assert.deepEqual(skipped, []);
});

test('plain .pine file is named after its indicator title, else the file name; CRLF normalised', () => {
  assert.equal(parsePack('x.pine', 'indicator("My Signal", overlay=true)\r\nplot(close)').scripts[0].name, 'My Signal');
  assert.equal(parsePack('vcp setup.txt', '// no header\nplot(close)').scripts[0].name, 'vcp setup');
  assert.equal(parsePack('x.pine', 'a\r\nb').scripts[0].source, 'a\nb');
});

test('bad entries are skipped with a reason, good ones kept', () => {
  const { scripts, skipped } = parsePack('p.json', JSON.stringify([{ name: 'ok', source: 'indicator("ok")' }, { name: 'empty', source: '  ' }, 42]));
  assert.equal(scripts.length, 1);
  assert.equal(skipped.length, 2);
  assert.match(parsePack('p.json', '{oops').skipped[0], /not valid JSON/);
});

test('one-time tidy keeps and renames the chosen versions, removes the rest, once', async () => {
  const { tidyScripts, retitle } = await import('../assets/js/chart/store/script-tidy.js');
  const { scripts, saveScript, workspace } = await import('../assets/js/chart/store/workspace.js');
  const src = (t) => `//@version=5\nstrategy("${t}", overlay=true)\nplot(close)`;
  const keep = saveScript({ name: '17 · Reversal Bot v6 (Trilens)', source: src('Reversal Bot v6 (Trilens)') });
  saveScript({ name: '05 · EMA Playbook S6 (Trilens)', source: src('x') });
  const drop = saveScript({ name: '17 · Reversal Bot FIB33 + EMA20 (Trilens)', source: src('y') });
  const other = saveScript({ name: '16 · Accumulation Bot (Trilens)', source: src('z') });
  workspace.set((w) => ({ ...w, cells: w.cells.map((c, i) => (i === 0 ? { ...c, studies: [...c.studies, { uid: 'u1', ref: 'script:' + drop.id, inputs: {} }] } : c)) }));
  const r = tidyScripts();
  assert.deepEqual(r, { renamed: 1, removed: 2 });
  const names = scripts.get().map((s) => s.name);
  assert.ok(names.includes('17 · Reversal Bot v6 L11 rsi30 ema200 (Trilens)'));
  assert.ok(names.includes(other.name));
  assert.ok(!names.some((n) => /S6|FIB33/.test(n)));
  const k = scripts.get().find((s) => s.id === keep.id);
  assert.match(k.source, /strategy\("Reversal Bot v6 L11 rsi30 ema200 \(Trilens\)"/);
  assert.ok(!workspace.get().cells[0].studies.some((st) => st.ref === 'script:' + drop.id), 'removed script left the chart');
  assert.deepEqual(tidyScripts(), { renamed: 0, removed: 0 }, 'runs once');
  assert.equal(retitle('indicator("a")', '01 · B $1'), 'indicator("B $1")');
});
