// Tests for the in-browser Pine runtime. Run with: node --test "tests/*.test.mjs"
// Reference values come from straightforward (non-incremental) implementations written here,
// so a bug in the incremental code cannot hide behind the same bug in the test.
import test from 'node:test';
import assert from 'node:assert/strict';
import { compile, run } from '../assets/js/chart/pine/runtime.js';

function makeBars(n = 400, seed = 7) {
  let s = seed;
  const rnd = () => ((s = (s * 1664525 + 1013904223) >>> 0) / 4294967296);
  const b = { time: new Float64Array(n), open: new Float64Array(n), high: new Float64Array(n), low: new Float64Array(n), close: new Float64Array(n), volume: new Float64Array(n), length: n };
  let p = 100;
  for (let i = 0; i < n; i++) {
    const o = p; const c = o * (1 + (rnd() - 0.5) * 0.04);
    b.time[i] = 1_700_000_000 + i * 3600; b.open[i] = o; b.close[i] = c;
    b.high[i] = Math.max(o, c) * (1 + rnd() * 0.01); b.low[i] = Math.min(o, c) * (1 - rnd() * 0.01);
    b.volume[i] = 1000 + rnd() * 500; p = c;
  }
  return b;
}
const bars = makeBars();
const C = Array.from(bars.close);

function exec(src, opts) {
  const c = compile(src);
  assert.equal(c.diagnostics.filter((d) => d.severity === 'error').length, 0, JSON.stringify(c.diagnostics));
  const r = run(c.ast, bars, opts);
  assert.ok(r.ok, JSON.stringify(r.diagnostics));
  return r;
}
const close = (a, b, eps = 1e-9) => (Number.isNaN(a) && Number.isNaN(b)) || Math.abs(a - b) <= eps * Math.max(1, Math.abs(b));
function assertSeries(actual, expected, label) {
  for (let i = 0; i < expected.length; i++) assert.ok(close(actual[i], expected[i]), `${label} differs at bar ${i}: ${actual[i]} vs ${expected[i]}`);
}

const refSma = (x, L) => x.map((_, i) => (i < L - 1 ? NaN : x.slice(i - L + 1, i + 1).reduce((a, b) => a + b, 0) / L));
function refEma(x, L, alpha = 2 / (L + 1)) {
  const out = []; let prev = NaN;
  for (let i = 0; i < x.length; i++) {
    if (i < L - 1) { out.push(NaN); continue; }
    if (i === L - 1) { prev = refSma(x, L)[i]; out.push(prev); continue; }
    prev = alpha * x[i] + (1 - alpha) * prev; out.push(prev);
  }
  return out;
}
function refRsi(x, L) {
  const up = [NaN], dn = [NaN];
  for (let i = 1; i < x.length; i++) { const d = x[i] - x[i - 1]; up.push(Math.max(d, 0)); dn.push(Math.max(-d, 0)); }
  const ru = [NaN, ...refEma(up.slice(1), L, 1 / L)], rd = [NaN, ...refEma(dn.slice(1), L, 1 / L)];
  return x.map((_, i) => (Number.isNaN(ru[i]) ? NaN : rd[i] === 0 ? 100 : ru[i] === 0 ? 0 : 100 - 100 / (1 + ru[i] / rd[i])));
}

test('sma / ema match reference', () => {
  const r = exec('//@version=5\nindicator("t", overlay=true)\nplot(ta.sma(close, 14))\nplot(ta.ema(close, 21))');
  assertSeries(r.plots[0].values, refSma(C, 14), 'sma');
  assertSeries(r.plots[1].values, refEma(C, 21), 'ema');
  assert.equal(r.meta.overlay, true);
});

test('rsi matches reference and input override applies', () => {
  const r = exec('indicator("RSI")\nlen = input.int(14, "Length", minval=1)\nplot(ta.rsi(close, len), "RSI")\nhline(70)\nhline(30)', { inputs: { Length: 9 } });
  assertSeries(r.plots[0].values, refRsi(C, 9), 'rsi');
  assert.equal(r.inputs[0].value, 9);
  assert.equal(r.inputs[0].minval, 1);
  assert.equal(r.hlines.length, 2);
  assert.equal(r.meta.overlay, false);
});

test('macd tuple destructuring', () => {
  const r = exec('indicator("MACD")\n[m, s, h] = ta.macd(close, 12, 26, 9)\nplot(m)\nplot(s)\nplot(h, style=plot.style_histogram)');
  const m = refEma(C, 12).map((v, i) => v - refEma(C, 26)[i]);
  assertSeries(r.plots[0].values, m, 'macd');
  assert.equal(r.plots[2].style, 'histogram');
});

test('var carries state, history operator, if/else blocks and user functions', () => {
  const src = [
    'indicator("state")',
    'var int count = 0',
    'if close > open',
    '    count := count + 1',
    'else',
    '    count := count',
    'f(x, n) =>',
    '    s = 0.0',
    '    for k = 0 to n - 1',
    '        s := s + x[k]',
    '    s / n',
    'plot(count)',
    'plot(f(close, 5))',
    'plot(close[2])',
  ].join('\n');
  const r = exec(src);
  let cnt = 0;
  const exp = C.map((c, i) => (cnt += c > bars.open[i] ? 1 : 0));
  assertSeries(r.plots[0].values, exp, 'count');
  assertSeries(r.plots[1].values, refSma(C, 5), 'user-fn sma');
  assertSeries(r.plots[2].values, C.map((_, i) => (i < 2 ? NaN : C[i - 2])), 'close[2]');
});

test('crossover drives plotshape, bgcolor and color.new', () => {
  const src = 'indicator("x", overlay=true)\nf = ta.ema(close, 5)\ns = ta.ema(close, 20)\nup = ta.crossover(f, s)\nplotshape(up, style=shape.triangleup, location=location.belowbar, color=color.green)\nbgcolor(up ? color.new(color.green, 80) : na)';
  const r = exec(src);
  const fe = refEma(C, 5), se = refEma(C, 20);
  const expected = [];
  for (let i = 1; i < C.length; i++) if (fe[i] > se[i] && fe[i - 1] <= se[i - 1]) expected.push(i);
  assert.deepEqual(r.shapes[0].points.map((p) => p.i), expected);
  assert.ok(expected.length > 0);
  assert.equal(r.bgcolors[expected[0]], '#4caf5033');
});

test('compile errors carry line numbers', () => {
  const bad = compile('indicator("x")\nplot(ta.nope(close))');
  assert.equal(bad.ast, null);
  assert.equal(bad.diagnostics[0].line, 2);
  assert.match(bad.diagnostics[0].message, /Unknown function 'ta.nope'/);

  const syn = compile('indicator("x")\na = (close + \nplot(a)');
  assert.equal(syn.ast, null);
  assert.match(syn.diagnostics[0].message, /Syntax error/);

  const strat = compile('strategy("s")\nplot(close)');
  assert.ok(strat.ast, 'strategy() scripts compile');
  assert.match(strat.diagnostics[0].message, /runs as signals/);

  const missing = compile('plot(close)');
  assert.match(missing.diagnostics[0].message, /Missing indicator/);
});

test('runaway loops stop with a runtime error instead of hanging', () => {
  const c = compile('indicator("loop")\nx = 0\nwhile true\n    x := x + 1\nplot(x)');
  const r = run(c.ast, bars);
  assert.equal(r.ok, false);
  assert.match(r.diagnostics[0].message, /Loop budget/);
  assert.equal(r.diagnostics[0].line, 3);
});

test('bollinger bands, atr and input.source', () => {
  const r = exec('indicator("bb", overlay=true)\nsrc = input.source(close, "Source")\n[mid, up, lo] = ta.bb(src, 20, 2)\nplot(mid)\nplot(up)\nplot(lo)\nplot(ta.atr(14))', { inputs: { Source: 'hl2' } });
  const hl2 = C.map((_, i) => (bars.high[i] + bars.low[i]) / 2);
  const mid = refSma(hl2, 20);
  const sd = hl2.map((_, i) => { if (i < 19) return NaN; const w = hl2.slice(i - 19, i + 1); const m = mid[i]; return Math.sqrt(w.reduce((a, b) => a + (b - m) ** 2, 0) / 20); });
  assertSeries(r.plots[0].values, mid, 'bb mid');
  assertSeries(r.plots[1].values, mid.map((m, i) => m + 2 * sd[i]), 'bb upper', 1e-8);
  assert.equal(r.inputs[0].type, 'source');
  assert.equal(r.inputs[0].value, 'hl2');
  assert.ok(Number.isFinite(r.plots[3].values[50]));
});

test('alertcondition() is recorded per bar with its title and message', () => {
  const r = exec('indicator("a", overlay=true)\nf = ta.ema(close, 5)\ns = ta.ema(close, 20)\nalertcondition(ta.crossover(f, s), "Bull cross", "{{ticker}} up at {{close}}")\nalertcondition(close > open, title="Green bar")');
  assert.equal(r.alertconds.length, 2);
  const [bull, green] = r.alertconds;
  assert.equal(bull.title, 'Bull cross');
  assert.equal(bull.message, '{{ticker}} up at {{close}}');
  assert.equal(green.title, 'Green bar');
  const fe = refEma(C, 5), se = refEma(C, 20);
  for (let i = 1; i < C.length; i++) assert.equal(bull.at[i], fe[i] > se[i] && fe[i - 1] <= se[i - 1] ? 1 : 0, `bar ${i}`);
  for (let i = 0; i < C.length; i++) assert.equal(green.at[i], C[i] > bars.open[i] ? 1 : 0);
  assert.equal(compile('indicator("a")\nalertcondition(close > open, "x")').diagnostics.length, 0, 'no "ignored" warning any more');
});

// ---------------------------------------------------------------- incremental (rollback) execution
import { createSession } from '../assets/js/chart/pine/runtime.js';
import { BUILTINS, NEW_SCRIPT } from '../assets/js/chart/indicators/builtins.js';

const TRICKY = [
  ['var counters and barstate', 'indicator("t")\nvar int ups = 0\nvar float firstLast = na\nif close > open\n    ups += 1\nif barstate.islast and na(firstLast)\n    firstLast := close\nplot(ups)\nplot(firstLast)\nplot(barstate.isconfirmed ? 1 : 0)'],
  ['user function with ta state, history of expressions', 'indicator("t")\nf(x, n) =>\n    m = ta.sma(x, n)\n    (x - m)[1]\nplot(f(close, 10))\nplot((high - low)[3])\nplot(ta.valuewhen(close > open, close, 1))\nplot(ta.barssince(ta.crossover(close, ta.ema(close, 9))))'],
  ['shapes, colours, bgcolor, barcolor, alertcondition', 'indicator("t", overlay=true)\nup = ta.crossover(ta.ema(close, 3), ta.ema(close, 8))\nplotshape(up, style=shape.triangleup, location=location.belowbar, color=color.green)\nplotshape(close > high[1], title="hh", location=location.abovebar)\nplot(close, color=close > open ? color.green : color.red)\nbgcolor(up ? color.new(color.blue, 80) : na)\nbarcolor(close < open ? color.orange : na)\nalertcondition(up, "Up")'],
  ['fixnan, cum, rising, stoch, cci, vwma', 'indicator("t")\nplot(fixnan(close > open ? close : na))\nplot(ta.cum(volume))\nplot(ta.rising(close, 3) ? 1 : 0)\nplot(ta.stoch(close, high, low, 14))\nplot(ta.cci(hlc3, 20))\nplot(ta.vwma(close, 10))\nplot(ta.vwap(hlc3))'],
];

/** Feed `final` bars to a session: first `start` bars at once, then each later bar as three partial ticks plus its final values. */
function replayTicks(ast, final, start, opts) {
  const n = final.length;
  const work = { time: new Float64Array(n), open: new Float64Array(n), high: new Float64Array(n), low: new Float64Array(n), close: new Float64Array(n), volume: new Float64Array(n) };
  for (const f of Object.keys(work)) work[f].set(final[f].subarray(0, start));
  const view = (len) => { const v = { length: len }; for (const f of Object.keys(work)) v[f] = work[f].subarray(0, len); return v; };
  const sess = createSession(ast, opts);
  let res = sess.update(view(start));
  let maxRan = 0;
  for (let k = start; k < n; k++) {
    const o = final.open[k];
    for (const frac of [0.2, 0.6, 1]) {
      const c = o + (final.close[k] - o) * frac;
      work.time[k] = final.time[k]; work.open[k] = o;
      work.high[k] = frac === 1 ? final.high[k] : Math.max(o, c); work.low[k] = frac === 1 ? final.low[k] : Math.min(o, c);
      work.close[k] = frac === 1 ? final.close[k] : c; work.volume[k] = final.volume[k] * frac;
      res = sess.update(view(k + 1));
      assert.ok(res.ok, JSON.stringify(res.diagnostics));
      maxRan = Math.max(maxRan, res.ran);
    }
  }
  return { res, maxRan };
}

function assertSameResult(a, b, label) {
  assert.equal(a.plots.length, b.plots.length, label + ' plot count');
  a.plots.forEach((p, k) => {
    assertSeries(Array.from(p.values), Array.from(b.plots[k].values), `${label} plot ${k} (${p.title})`);
    assert.deepEqual(p.colors, b.plots[k].colors, `${label} plot ${k} colours`);
  });
  assert.deepEqual(a.shapes.map((s) => s.points), b.shapes.map((s) => s.points), label + ' shapes');
  assert.deepEqual(a.bgcolors, b.bgcolors, label + ' bgcolor');
  assert.deepEqual(a.barcolors, b.barcolors, label + ' barcolor');
  assert.deepEqual(a.alertconds.map((x) => Array.from(x.at)), b.alertconds.map((x) => Array.from(x.at)), label + ' alertconditions');
}

const SCRIPTS = [...BUILTINS.map((b) => [b.id, b.source]), ['starter', NEW_SCRIPT], ...TRICKY];
for (const [label, src] of SCRIPTS) {
  test(`incremental ticks give exactly the full run's result: ${label}`, () => {
    const c = compile(src);
    assert.ok(c.ast, JSON.stringify(c.diagnostics));
    const opts = { realtime: true, timeframe: { period: '60', seconds: 3600 } };
    const { res, maxRan } = replayTicks(c.ast, bars, 340, opts);
    const full = run(compile(src).ast, bars, opts);
    assertSameResult(res, full, label);
    assert.ok(maxRan <= 2, `a tick should run at most the closed bar and the forming bar, ran ${maxRan}`);
  });
}

test('incremental: several bars appended at once, then ticks', () => {
  const c = compile(BUILTINS.find((b) => b.id === 'macd').source);
  const sess = createSession(c.ast, {});
  const slice = (len) => { const v = { length: len }; for (const f of ['time', 'open', 'high', 'low', 'close', 'volume']) v[f] = bars[f].subarray(0, len); return v; };
  sess.update(slice(100));
  const r = sess.update(slice(150)); // 50 new bars in one go (e.g. a tab woke up)
  // the old forming bar (99) and 49 new bars close for good, then the new forming bar (149) runs
  assert.equal(r.ran, 51);
  const full = run(c.ast, slice(150), {});
  assertSameResult(r, full, 'jump');
});

test('incremental: a session that hit a runtime error stays broken', () => {
  const c = compile('indicator("e")\nx = 0\nif bar_index == 120\n    while true\n        x := x + 1\nplot(x)');
  const sess = createSession(c.ast, {});
  const slice = (len) => { const v = { length: len }; for (const f of ['time', 'open', 'high', 'low', 'close', 'volume']) v[f] = bars[f].subarray(0, len); return v; };
  assert.equal(sess.update(slice(100)).ok, true);
  assert.equal(sess.update(slice(130)).ok, false);
  assert.equal(sess.broken, true);
  assert.equal(sess.update(slice(131)).ok, false);
});

// ---------------------------------------------------------------- strategy signals, HTF, pivots, arrays, labels
test('strategy(): market entry fills next bar open, stop exit at the stop, markers carry comments', () => {
  const src = 'strategy("s", overlay=true)\nif bar_index == 10\n    strategy.entry("L", strategy.long, comment="GO")\nif strategy.position_size > 0\n    strategy.exit("X", "L", stop=low[1] - 1000000, limit=high * 100, comment="OUT")\nif bar_index == 20\n    strategy.close("L", comment="TIME")\nplot(strategy.position_size)';
  const r = exec(src);
  const ent = r.shapes.find((s) => s.title === 'Strategy entries'), ext = r.shapes.find((s) => s.title === 'Strategy exits');
  assert.deepEqual(ent.points.map((p) => [p.i, p.price, p.text]), [[11, bars.open[11], 'GO']]);
  assert.deepEqual(ext.points.map((p) => [p.i, p.price, p.text]), [[21, bars.open[21], 'TIME']]);
  assert.equal(r.plots[0].values[10], 0); assert.equal(r.plots[0].values[11], 1); assert.equal(r.plots[0].values[21], 0);
  // a stop that is hit exits at the stop price
  const s2 = exec('strategy("s2", overlay=true)\nif bar_index == 5\n    strategy.entry("L", strategy.long)\nif strategy.position_size > 0\n    strategy.exit("X", "L", stop=strategy.position_avg_price * 1.5)\nplot(close)');
  const ex2 = s2.shapes.find((s) => s.title === 'Strategy exits').points[0];
  // entry fills at bar 6's open; the exit placed on bar 6 is live from bar 7, as in TradingView
  assert.equal(ex2.i, 7); // stop above price: hit on the first bar it is active
  assert.equal(ex2.price, bars.open[7]); // already through the stop at the open: filled at the open
});

test('request.security on this symbol: weekly value appears when the week closes and holds (no repaint)', () => {
  // hourly bars from makeBars(): 24 per day; use a daily request on them
  const r = exec('indicator("h")\nd = request.security(syminfo.tickerid, "D", close)\nplot(d)', { timeframe: { period: '60', seconds: 3600 }, symbol: { ticker: 'X', mintick: 0.01 } });
  const v = r.plots[0].values, t = bars.time;
  const dayOf = (x) => Math.floor(x / 86400);
  for (let i = 1; i < bars.length - 1; i++) {
    const lastOfDay = dayOf(t[i + 1]) !== dayOf(t[i]);
    if (lastOfDay) assert.equal(v[i], C[i], `bar ${i}: daily close appears on the day's last bar`);
    else if (!Number.isNaN(v[i])) {
      // otherwise it is the previous day's close
      let j = i; while (j >= 0 && dayOf(t[j]) === dayOf(t[i])) j--;
      assert.equal(v[i], C[j], `bar ${i}: holds the previous day's close`);
    }
  }
  const other = run(compile('indicator("o")\nx = request.security("SPY", "D", close)\nplot(x)').ast, bars, {});
  assert.ok(Number.isNaN(other.plots[0].values[100]));
  assert.match(other.diagnostics.find((d) => d.severity === 'warning').message, /only this chart's own contract/);
});

test('ta.pivothigh / ta.pivotlow mark the bar `right` bars after the pivot', () => {
  const r = exec('indicator("p")\nplot(ta.pivothigh(high, 3, 2))\nplot(ta.pivotlow(3, 2))');
  const H = Array.from(bars.high), L = Array.from(bars.low);
  for (let i = 5; i < H.length; i++) {
    const c = i - 2;
    const isHi = H.slice(c - 3, c).every((x) => x < H[c]) && H.slice(c + 1, c + 3).every((x) => x <= H[c]);
    const isLo = L.slice(c - 3, c).every((x) => x > L[c]) && L.slice(c + 1, c + 3).every((x) => x >= L[c]);
    assert.equal(Number.isNaN(r.plots[0].values[i]) ? null : r.plots[0].values[i], isHi ? H[c] : null, `pivot high at ${i}`);
    assert.equal(Number.isNaN(r.plots[1].values[i]) ? null : r.plots[1].values[i], isLo ? L[c] : null, `pivot low at ${i}`);
  }
});

test('arrays, typed declarations and labels', () => {
  const r = exec('indicator("a")\nvar float[] xs = array.new_float(0)\narray.push(xs, close)\nif array.size(xs) > 5\n    array.shift(xs)\nplot(array.avg(xs))\nplot(array.get(xs, -1))\nvar label lb = na\nif barstate.islast\n    label.delete(lb)\n    lb := label.new(bar_index, high, "last " + str.tostring(close, "#.##"))');
  const ref = C.map((_, i) => (i < 4 ? NaN : C.slice(Math.max(0, i - 4), i + 1).reduce((a, b) => a + b, 0) / Math.min(5, i + 1)));
  for (let i = 10; i < C.length; i++) assert.ok(Math.abs(r.plots[0].values[i] - ref[i]) < 1e-9);
  assertSeries(r.plots[1].values, C, 'array.get -1');
  const lab = r.shapes.find((s) => s.title === 'Labels');
  assert.equal(lab.points.length, 1);
  assert.equal(lab.points[0].text, 'last ' + C[C.length - 1].toFixed(2));
  assert.match(run(compile('indicator("e")\nxs = array.new_float(2)\nplot(array.get(xs, 5))').ast, bars, {}).diagnostics[0].message, /out of bounds/);
});
