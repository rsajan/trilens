// Tests for multi-chart workspace state, alerts and channel geometry.
// Run with: node --test "tests/*.test.mjs"   (localStorage is absent in Node; the store falls back to memory)
import test from 'node:test';
import assert from 'node:assert/strict';
import { workspace, setCell, setSync, setLayout, setActive, addStudy, removeStudy, applyStudies, activeCell } from '../assets/js/chart/store/workspace.js';
import { alertHit, saveTemplate, templates, addToList, cycleFlag, activeList, FLAGS } from '../assets/js/chart/store/library.js';
import { channelOffset } from '../assets/js/chart/drawings/geometry.js';

test('alerts: crosses needs a previous price and fires from either side, touching counts', () => {
  assert.equal(alertHit('crosses', 100, NaN, 101), false);
  assert.equal(alertHit('crosses', 100, 99, 101), true);
  assert.equal(alertHit('crosses', 100, 101, 99), true);
  assert.equal(alertHit('crosses', 100, 99, 100), true);
  assert.equal(alertHit('crosses', 100, 101, 102), false);
  assert.equal(alertHit('above', 100, NaN, 100), true);
  assert.equal(alertHit('below', 100, NaN, 100.5), false);
});

test('channel offset is measured at the third point time', () => {
  assert.equal(channelOffset({ time: 0, price: 100 }, { time: 10, price: 110 }, { time: 5, price: 120 }), 15);
  assert.equal(channelOffset({ time: 3, price: 100 }, { time: 3, price: 200 }, { time: 3, price: 90 }), -10);
});

test('cells: symbol/timeframe changes stay in one chart unless sync is on', () => {
  setLayout('2x2');
  setSync({ symbol: false, tf: false });
  const before = workspace.get().cells.map((c) => c.symbol);
  setCell(1, { symbol: 'XAUUSDT.P' });
  assert.deepEqual(workspace.get().cells.map((c) => c.symbol), [before[0], 'XAUUSDT.P', before[2], before[3]]);
  setSync({ tf: true });
  setCell(0, { tf: '4h' });
  assert.deepEqual(workspace.get().cells.map((c) => c.tf), ['4h', '4h', '4h', '4h']);
  setLayout('1x2');
  setCell(0, { tf: '1D' }); // only visible charts follow
  assert.deepEqual(workspace.get().cells.map((c) => c.tf), ['1D', '1D', '4h', '4h']);
});

test('studies: add to the focused chart, remove anywhere, templates get fresh ids', () => {
  setActive(1);
  const st = addStudy('builtin:macd');
  assert.ok(workspace.get().cells[1].studies.some((s) => s.uid === st.uid));
  assert.ok(!workspace.get().cells[0].studies.some((s) => s.uid === st.uid));
  const t = saveTemplate('test', activeCell().studies);
  assert.equal(templates.get().at(-1).id, t.id);
  applyStudies(0, t.studies);
  const ids0 = workspace.get().cells[0].studies.map((s) => s.uid), ids1 = workspace.get().cells[1].studies.map((s) => s.uid);
  assert.equal(ids0.length, ids1.length);
  assert.ok(ids0.every((id) => !ids1.includes(id)), 'template copies must not share uids');
  removeStudy(st.uid);
  assert.ok(!workspace.get().cells[1].studies.some((s) => s.uid === st.uid));
});

test('watchlist flags cycle through every colour and back to none', () => {
  const l = activeList();
  addToList(l.id, 'XAUUSDT.P');
  const flag = () => activeList().items.find((x) => x.symbol === 'XAUUSDT.P').flag;
  const seen = [];
  for (let i = 0; i <= FLAGS.length; i++) { cycleFlag(l.id, 'XAUUSDT.P'); seen.push(flag()); }
  assert.deepEqual(seen, [...FLAGS, null]);
});
