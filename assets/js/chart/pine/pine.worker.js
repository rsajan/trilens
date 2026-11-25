// Pine worker: compiles and runs scripts off the UI thread.
//   in  { type: 'data', ds, bars, symbol, tf }      replace a dataset (bars: columnar, copied in)
//   in  { type: 'bar', ds, bar }                     update the last bar or append a new one
//   in  { id, type: 'run', ds, source, inputs }      -> { id, ok: true, result } (plot arrays transferred)
//   in  { id, type: 'check', source }                -> { id, ok: true, result: { diagnostics } }
import { compile, createSession } from './runtime.js';

/** @type {Map<string, { bars: any, cap: number, symbol: any, tf: any }>} */
const datasets = new Map();
const compiled = new Map(); // source -> compile() result (small LRU)
const FIELDS = ['time', 'open', 'high', 'low', 'close', 'volume'];

function getCompiled(source) {
  let c = compiled.get(source);
  if (c) { compiled.delete(source); compiled.set(source, c); return c; }
  c = compile(source);
  compiled.set(source, c);
  if (compiled.size > 40) compiled.delete(compiled.keys().next().value);
  return c;
}

// One resumable session per run key (a study, or an alert): it re-executes only the bars that
// changed. A new session starts when the script, its inputs or the dataset are replaced.
/** @type {Map<string, { source: string, inputsKey: string, ds: string, version: number, session: any }>} */
const sessions = new Map();
let dataVersion = 0;

function setData(ds, bars, symbol, tf) {
  const cap = Math.max(16, Math.ceil(bars.length * 1.25));
  const b = { length: bars.length };
  for (const f of FIELDS) { const a = new Float64Array(cap); a.set(bars[f].subarray ? bars[f].subarray(0, bars.length) : bars[f]); b[f] = a; }
  datasets.set(ds, { bars: b, cap, symbol, tf, version: ++dataVersion });
}

function sessionFor(key, ds, d, source, ast, inputs) {
  const inputsKey = JSON.stringify(inputs || {});
  let s = sessions.get(key);
  if (!s || s.source !== source || s.inputsKey !== inputsKey || s.ds !== ds || s.version !== d.version || s.session.broken) {
    s = { source, inputsKey, ds, version: d.version, session: createSession(ast, { inputs, symbol: d.symbol, timeframe: d.tf, realtime: true }) };
    sessions.set(key, s);
  } else { sessions.delete(key); sessions.set(key, s); } // LRU order
  if (sessions.size > 64) sessions.delete(sessions.keys().next().value);
  return s.session;
}

function pushBar(ds, bar) {
  const d = datasets.get(ds);
  if (!d) return;
  const b = d.bars;
  const n = b.length;
  if (n && bar.time === b.time[n - 1]) {
    for (const f of FIELDS) b[f][n - 1] = bar[f];
    return;
  }
  if (n && bar.time < b.time[n - 1]) return;
  if (n + 1 > d.cap) {
    const cap = Math.ceil(d.cap * 1.5) + 16;
    for (const f of FIELDS) { const a = new Float64Array(cap); a.set(b[f]); b[f] = a; }
    d.cap = cap;
  }
  for (const f of FIELDS) b[f][n] = bar[f];
  b.length = n + 1;
}

self.onmessage = (e) => {
  const m = e.data;
  try {
    if (m.type === 'data') { setData(m.ds, m.bars, m.symbol, m.tf); return; }
    if (m.type === 'bar') { pushBar(m.ds, m.bar); return; }
    if (m.type === 'drop') { datasets.delete(m.ds); for (const [k, x] of sessions) if (x.ds === m.ds) sessions.delete(k); return; }
    if (m.type === 'check') {
      const c = getCompiled(m.source);
      self.postMessage({ id: m.id, ok: true, result: { diagnostics: c.diagnostics } });
      return;
    }
    if (m.type === 'run') {
      const c = getCompiled(m.source);
      if (!c.ast) { self.postMessage({ id: m.id, ok: true, result: { ok: false, diagnostics: c.diagnostics, plots: [], shapes: [], hlines: [], inputs: [], meta: null } }); return; }
      const d = datasets.get(m.ds);
      if (!d) throw new Error('No price data loaded yet');
      const view = { length: d.bars.length };
      for (const f of FIELDS) view[f] = d.bars[f].subarray(0, d.bars.length);
      const r = sessionFor(m.key || m.ds, m.ds, d, m.source, c.ast, m.inputs).update(view, true);
      r.diagnostics = [...c.diagnostics.filter((x) => x.severity === 'warning'), ...r.diagnostics];
      r.firstTime = view.length ? view.time[0] : 0;
      self.postMessage({ id: m.id, ok: true, result: r }, [...r.plots.map((p) => p.values.buffer), ...r.alertconds.map((x) => x.at.buffer)]);
      return;
    }
    throw new Error('Unknown message ' + m.type);
  } catch (err) {
    if (m.id !== undefined) self.postMessage({ id: m.id, ok: false, error: String(err && err.message || err) });
    else console.error(err);
  }
};
