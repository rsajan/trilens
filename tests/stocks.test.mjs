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
