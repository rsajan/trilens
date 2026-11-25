// Tests for the live-feed adapters' parsing and the automatic feed choice. No network: payloads
// below follow the exchanges' documented response shapes.
// Run with: node --test "tests/*.test.mjs"
import test from 'node:test';
import assert from 'node:assert/strict';
import { parseBinanceContracts, parseBinanceKlines, parseBybitContracts, parseBybitKlines, mergeBybitTicker, AutoLiveAdapter } from '../assets/js/chart/data/live.js';

test('Binance: only trading USDT perpetuals, TradingView names, tick size, most traded first', () => {
  const info = { symbols: [
    { symbol: 'ETHUSDT', contractType: 'PERPETUAL', status: 'TRADING', baseAsset: 'ETH', quoteAsset: 'USDT', filters: [{ filterType: 'PRICE_FILTER', tickSize: '0.01' }] },
    { symbol: 'BTCUSDT', contractType: 'PERPETUAL', status: 'TRADING', baseAsset: 'BTC', quoteAsset: 'USDT', filters: [{ filterType: 'PRICE_FILTER', tickSize: '0.10' }] },
    { symbol: 'BTCUSDT_261225', contractType: 'CURRENT_QUARTER', status: 'TRADING', baseAsset: 'BTC', quoteAsset: 'USDT', filters: [] },
    { symbol: 'OLDUSDT', contractType: 'PERPETUAL', status: 'SETTLING', baseAsset: 'OLD', quoteAsset: 'USDT', filters: [] },
    { symbol: 'BTCUSDC', contractType: 'PERPETUAL', status: 'TRADING', baseAsset: 'BTC', quoteAsset: 'USDC', filters: [] },
  ] };
  const tickers = [{ symbol: 'ETHUSDT', quoteVolume: '9000000000' }, { symbol: 'BTCUSDT', quoteVolume: '20000000000' }];
  const c = parseBinanceContracts(info, tickers);
  assert.deepEqual(c.map((x) => x.symbol), ['BTCUSDT.P', 'ETHUSDT.P']);
  assert.equal(c[0].tick, 0.1);
  assert.equal(c[0].name, 'BTC perpetual');
  assert.equal(c[0].kind, 'perp');
});

test('Binance klines: ms -> s, strings -> numbers', () => {
  const rows = parseBinanceKlines([[1700000000000, '100.5', '101', '99.5', '100.9', '1234.5', 1700003599999, '0', 10, '0', '0', '0']]);
  assert.deepEqual(rows, [{ time: 1700000000, open: 100.5, high: 101, low: 99.5, close: 100.9, volume: 1234.5 }]);
});

test('Bybit: instruments + tickers -> contracts; klines arrive newest first and are reversed', () => {
  const inst = { retCode: 0, result: { list: [
    { symbol: 'SOLUSDT', contractType: 'LinearPerpetual', status: 'Trading', baseCoin: 'SOL', quoteCoin: 'USDT', priceFilter: { tickSize: '0.001' } },
    { symbol: 'BTCUSDT', contractType: 'LinearPerpetual', status: 'Trading', baseCoin: 'BTC', quoteCoin: 'USDT', priceFilter: { tickSize: '0.10' } },
    { symbol: 'BTC-26DEC26', contractType: 'LinearFutures', status: 'Trading', baseCoin: 'BTC', quoteCoin: 'USDC', priceFilter: { tickSize: '0.5' } },
  ] } };
  const tick = { result: { list: [{ symbol: 'BTCUSDT', turnover24h: '5e9' }, { symbol: 'SOLUSDT', turnover24h: '1e9' }] } };
  assert.deepEqual(parseBybitContracts(inst, tick).map((x) => [x.symbol, x.tick]), [['BTCUSDT.P', 0.1], ['SOLUSDT.P', 0.001]]);
  const k = parseBybitKlines({ retCode: 0, result: { list: [['1700003600000', '2', '3', '1', '2.5', '10', '25'], ['1700000000000', '1', '2', '0.5', '2', '5', '10']] } });
  assert.deepEqual(k.map((r) => r.time), [1700000000, 1700003600]);
  assert.equal(k[1].close, 2.5);
});

test('Bybit tickers: snapshot then partial deltas keep earlier fields', () => {
  const t = {};
  mergeBybitTicker(t, { lastPrice: '100', markPrice: '100.1', indexPrice: '99.9', prevPrice24h: '95', price24hPcnt: '0.0526', highPrice24h: '101', lowPrice24h: '94', volume24h: '5', turnover24h: '500', openInterest: '7', fundingRate: '0.0001', nextFundingTime: '1700028800000' });
  mergeBybitTicker(t, { lastPrice: '102' }); // delta: only what changed
  assert.equal(t.last, 102); assert.equal(t.mark, 100.1); assert.equal(t.change24h, 7);
  assert.ok(Math.abs(t.changePct24h - 5.26) < 1e-9); assert.equal(t.nextFundingTime, 1700028800);
});

const fake = (id, ok, list = [{ symbol: 'BTCUSDT.P' }]) => ({ id, short: id, contracts: () => (ok ? Promise.resolve(list) : Promise.reject(new Error(`${id} blocked`))), bars: async () => id, subscribeBars: () => () => {}, subscribeTelemetry: () => () => {}, dispose() {} });

test('Live (auto): first exchange that answers wins', async () => {
  const a = new AutoLiveAdapter([fake('binance', true), fake('bybit', true)], fake('synthetic', true));
  await a.contracts();
  assert.equal(a.source, 'binance');
  assert.equal(await a.bars('BTCUSDT.P', '1h'), 'binance');
  assert.equal(a.label, 'Live · binance');
});

test('Live (auto): blocked exchange falls through to the next, then to synthetic with the reasons', async () => {
  const b = new AutoLiveAdapter([fake('binance', false), fake('bybit', true)], fake('synthetic', true));
  await b.contracts();
  assert.equal(b.source, 'bybit');
  const c = new AutoLiveAdapter([fake('binance', false), fake('bybit', false)], fake('synthetic', true));
  await c.contracts();
  assert.equal(c.source, 'synthetic');
  assert.match(c.fallbackReason, /binance blocked.*bybit blocked/);
  assert.match(c.label, /Synthetic market/);
});

test('Live (auto): subscriptions made before the choice land on the chosen adapter', async () => {
  let got = null;
  const chosen = { ...fake('bybit', true), subscribeBars: (s) => { got = s; return () => {}; } };
  const a = new AutoLiveAdapter([fake('binance', false), chosen], fake('synthetic', true));
  a.subscribeBars('ETHUSDT.P', '1m', () => {});
  await a.contracts();
  await new Promise((r) => setTimeout(r, 0));
  assert.equal(got, 'ETHUSDT.P');
});
