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
