// End-of-day stock decoding (the inverse of encode_prices in pipeline/build_technical.py). Made-up symbols.
import test from 'node:test';
import assert from 'node:assert/strict';
import { decodeSeries, stockContracts, kindLabel, StocksAdapter, stockData } from '../assets/js/chart/data/stocks.js';

// two bars: day 20000 o 10.00 h 10.50 l 9.80 c 10.20 v 100; day 20003 o 10.30 h 10.40 l 10.10 c 10.25 v 50
const E = { s: 'AAA', dp: 2, d0: 20000, dd: [3], c: [1020, 5], o: [-20, 5], h: [30, 10], l: [20, 15], v: [100, 50] };

test('decodeSeries rebuilds OHLCV from the compact integers', () => {
  const b = decodeSeries(E);
  assert.equal(b.length, 2);
  assert.deepEqual([...b.time], [20000 * 86400, 20003 * 86400]);
  assert.deepEqual([...b.open], [10, 10.3]);
  assert.deepEqual([...b.high], [10.5, 10.4]);
  assert.deepEqual([...b.low], [9.8, 10.1]);
  assert.deepEqual([...b.close], [10.2, 10.25]);
  assert.deepEqual([...b.volume], [100, 50]);
});

test('contracts per market, badges, adapter bars and top lists', async () => {
  const data = { built_at: 'x', markets: { US: { top: ['AAA'], series: [E] }, IN: { top: ['BBB.NS'], series: [{ ...E, s: 'BBB.NS' }] } } };
  const cs = stockContracts(data);
  assert.deepEqual(cs.map((c) => [c.symbol, c.market, c.quote, c.base]), [['AAA', 'US', 'USD', 'AAA'], ['BBB.NS', 'IN', 'INR', 'BBB']]);
  assert.equal(kindLabel(cs[1]), 'India stock · EOD');
  assert.equal(kindLabel({ kind: 'perp' }), 'Perpetual');
  stockData.set(data); stockData._p = Promise.resolve(stockData);
  const a = new StocksAdapter();
  assert.equal((await a.contracts()).length, 2);
  assert.equal((await a.bars('AAA', '1D')).length, 2);
  assert.equal((await a.bars('AAA', '1D', { to: 20001 * 86400 })).length, 1);
  assert.equal((await a.bars('AAA', '1M')).length, 1);
  await assert.rejects(a.bars('AAA', '1h'), /end-of-day/);
  const t = await new Promise((r) => a.subscribeTelemetry('AAA', r));
  assert.equal(t.last, 10.25);
  assert.ok(Math.abs(t.changePct24h - (10.25 / 10.2 - 1) * 100) < 1e-9);
  assert.deepEqual(stockData.topLists(), [{ name: 'US top 500', symbols: ['AAA'] }, { name: 'India top 500', symbols: ['BBB.NS'] }]);
});

test('v2 prices: history pieces load once per bucket and join this month', async () => {
  const { stockData: sd, StocksAdapter: SA } = await import('../assets/js/chart/data/stocks.js');
  const enc = (s, d0, closes) => ({ s, dp: 2, d0, dd: closes.slice(1).map(() => 1), c: closes.map((c, i) => (i ? c - closes[i - 1] : c)), o: closes.map(() => 0), h: closes.map(() => 0), l: closes.map(() => 0), v: closes.map(() => 1) });
  const files = {
    'data/technical/prices/y2024-b03.json': { piece: 'y2024', bucket: 3, series: [enc('XXX', 19800, [100, 101])] },
    'data/technical/prices/m2025-01-b03.json': { piece: 'm2025-01', bucket: 3, series: [enc('XXX', 20100, [102, 103])] },
  };
  const asked = [];
  globalThis.fetch = async (url) => { asked.push(url); const o = files[url]; return { ok: !!o, json: async () => o }; };
  sd.set({ v: 2, built_at: 'x', buckets: 64, pieces: ['m2025-01', 'y2024'], recent: [enc('XXX', 20101, [103, 104])],
    markets: { US: { top: ['XXX'], asof: 'x', symbols: [['XXX', 2, 3]] } } });
  sd._p = Promise.resolve(sd);
  const a = new SA();
  assert.deepEqual((await a.contracts()).map((c) => c.symbol), ['XXX']);
  const b = await a.bars('XXX', '1D');
  assert.deepEqual([...b.close], [1, 1.01, 1.02, 1.03, 1.04], 'history, this month, overlap once');
  assert.equal(asked.length, 2);
  await a.bars('XXX', '1W');
  assert.equal(asked.length, 2, 'pieces fetched once');
  const t = await new Promise((r) => a.subscribeTelemetry('XXX', r));
  assert.equal(t.last, 1.04);
});
