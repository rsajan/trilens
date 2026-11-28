// Tests for drawing geometry. Run with: node --test "tests/*.test.mjs"
import test from 'node:test';
import assert from 'node:assert/strict';
import * as G from '../assets/js/chart/drawings/geometry.js';

const H = 3600;
const times = Float64Array.from({ length: 10 }, (_, i) => 1_700_000_000 + i * H);

test('time <-> logical index round-trips inside, before and after the bars', () => {
  for (const L of [-5, -0.5, 0, 3, 4.25, 9, 12.5]) {
    const t = G.logicalToTime(L, times, 10, H);
    assert.ok(Math.abs(G.timeToLogical(t, times, 10, H) - L) < 1e-9, `L=${L}`);
  }
  assert.equal(G.timeToLogical(times[4], times, 10, H), 4);
  assert.equal(G.timeToLogical(times[9] + 2 * H, times, 10, H), 11);
});

test('a time drawn on 1m lands between the right 1h bars', () => {
  const t = times[2] + 15 * 60; // 15 minutes into hour 2
  assert.equal(G.timeToLogical(t, times, 10, H), 2.25);
});

test('time mapping interpolates across gaps (weekends, missing bars)', () => {
  const gap = Float64Array.from([0, 100, 200, 1000, 1100]);
  assert.equal(G.timeToLogical(600, gap, 5, 100), 2.5);
  assert.equal(G.logicalToTime(2.5, gap, 5, 100), 600);
});

test('segment and ray distances', () => {
  assert.equal(G.distToSegment(5, 5, 0, 0, 10, 0), 5);
  assert.equal(G.distToSegment(15, 0, 0, 0, 10, 0), 5); // past the end: distance to the end point
  assert.equal(G.distToRay(15, 0, 0, 0, 10, 0), 0); // a ray keeps going
  assert.equal(G.distToRay(-3, 4, 0, 0, 10, 0), 5); // but not backwards
});

test('fibonacci levels: 0 on the second point, 1 on the first', () => {
  const lv = G.fibLevels(100, 200);
  const at = (l) => lv.find((x) => x.level === l).price;
  assert.equal(at(0), 200);
  assert.equal(at(1), 100);
  assert.equal(at(0.5), 150);
  assert.ok(Math.abs(at(0.618) - 138.2) < 1e-9);
  assert.ok(Math.abs(at(1.618) - 38.2) < 1e-9);
});

test('risk/reward for long and short, and a stop on the wrong side', () => {
  const l = G.riskReward(100, 110, 95);
  assert.equal(l.side, 'long'); assert.equal(l.ratio, 2); assert.equal(l.valid, true);
  assert.ok(Math.abs(l.rewardPct - 10) < 1e-9 && Math.abs(l.riskPct + 5) < 1e-9);
  const s = G.riskReward(100, 85, 105);
  assert.equal(s.side, 'short'); assert.equal(s.ratio, 3); assert.equal(s.valid, true);
  assert.equal(G.riskReward(100, 110, 106).valid, false);
});

test('default position: target forced to the right side, 2:1 reward to risk', () => {
  const e = { time: 10, price: 100 };
  const [, t, st] = G.defaultPosition('long', e, { time: 20, price: 90 }); // clicked below: mirrored up
  assert.equal(t.price, 110); assert.equal(st.price, 95); assert.equal(t.time, 20);
  const [, ts, ss] = G.defaultPosition('short', e, { time: 20, price: 80 });
  assert.equal(ts.price, 80); assert.equal(ss.price, 110);
  assert.equal(G.riskReward(100, ts.price, ss.price).ratio, 2);
});

test('magnet snaps to the closest OHLC within the radius only', () => {
  const bar = { open: 100, high: 110, low: 95, close: 105 };
  const toY = (p) => 1000 - p * 5; // 5 px per unit
  assert.equal(G.magnetPrice(109, toY(109), bar, toY), 110); // 5 px away -> snap
  assert.equal(G.magnetPrice(102.5, toY(102.5), bar, toY, 10), 102.5); // 12.5 px from 100 and 105: outside a 10 px radius
  assert.equal(G.magnetPrice(104, toY(104), bar, toY), 105); // nearest wins, not the first checked
});

test('new drawing tools: point counts, infinite-line distance, measure, angle', async () => {
  const G = await import('../assets/js/chart/drawings/geometry.js');
  assert.deepEqual(['extline', 'infoline', 'angle', 'hray', 'vline', 'cross', 'rect', 'arrow', 'measure'].map((t) => G.TOOL_POINTS[t]), [2, 2, 2, 1, 1, 1, 2, 2, 2]);
  assert.equal(G.distToLine(10, 5, 0, 0, 1, 0), 5);
  assert.equal(G.distToLine(-50, 0, 0, 0, 1, 0), 0, 'beyond both ends still on the line');
  const m = G.measure({ time: 0, price: 100 }, { time: 86400 * 10, price: 110 }, 86400);
  assert.deepEqual([m.change, m.pct, m.bars, m.days], [10, 10, 10, 10]);
  assert.equal(Math.round(G.screenAngle(0, 0, 10, -10)), 45);
});
