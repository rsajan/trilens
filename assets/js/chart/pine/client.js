// Main-thread handle to the Pine worker.
//  - Only the newest run per key matters: older results that arrive late resolve to null.
//  - Watchdog: a run that takes longer than WATCHDOG_MS kills the worker (the only way to stop
//    a stuck script in JS), starts a fresh one, reloads its datasets and reports the timeout.

const WATCHDOG_MS = 4000;

/** @typedef {import('../data/timeframes.js').Bars} Bars */

export class PineEngine {
  constructor() {
    this.seq = 0;
    this.pending = new Map(); // id -> { resolve, reject, key, started }
    this.latest = new Map(); // key -> id
    this.datasets = new Map(); // ds -> { bars, symbol, tf } (main-thread copy for restarts)
    this.spawn();
    this.timer = setInterval(() => this.watchdog(), 500);
  }

  spawn() {
    this.worker = new Worker(new URL('./pine.worker.js', import.meta.url), { type: 'module' });
    this.worker.onmessage = (e) => {
      const m = e.data;
      const p = this.pending.get(m.id);
      if (!p) return;
      this.pending.delete(m.id);
      if (!m.ok) { p.reject(new Error(m.error)); return; }
      p.resolve(this.latest.get(p.key) === m.id ? m.result : null);
    };
    this.worker.onerror = (e) => console.error('pine worker', e.message);
    for (const [ds, d] of this.datasets) this.worker.postMessage({ type: 'data', ds, bars: d.bars, symbol: d.symbol, tf: d.tf });
  }

  watchdog() {
    const now = performance.now();
    let stuck = null;
    for (const p of this.pending.values()) if (now - p.started > WATCHDOG_MS) { stuck = p; break; }
    if (!stuck) return;
    this.worker.terminate();
    const err = new Error(`Script stopped: it ran for more than ${WATCHDOG_MS / 1000} seconds`);
    for (const p of this.pending.values()) p.reject(err);
    this.pending.clear();
    this.spawn();
  }

  /** @param {string} ds @param {Bars} bars @param {{ticker: string, mintick: number}} symbol @param {{period: string, seconds: number}} tf */
  setData(ds, bars, symbol, tf) {
    this.datasets.set(ds, { bars, symbol, tf });
    this.worker.postMessage({ type: 'data', ds, bars, symbol, tf });
  }

  /** Live update of the newest bar (or a new bar). */
  pushBar(ds, bar) {
    const d = this.datasets.get(ds);
    if (d) d.lastBar = bar;
    this.worker.postMessage({ type: 'bar', ds, bar });
  }

  drop(ds) { this.datasets.delete(ds); this.worker.postMessage({ type: 'drop', ds }); }

  /** @returns {Promise<any|null>} null when a newer run for the same key superseded this one */
  run(key, ds, source, inputs) {
    const id = ++this.seq;
    this.latest.set(key, id);
    return new Promise((resolve, reject) => {
      this.pending.set(id, { resolve, reject, key, started: performance.now() });
      this.worker.postMessage({ id, type: 'run', key, ds, source, inputs });
    });
  }

  /** Compile only, for live diagnostics while typing. */
  check(source) {
    const id = ++this.seq;
    const key = '__check';
    this.latest.set(key, id);
    return new Promise((resolve, reject) => {
      this.pending.set(id, { resolve, reject, key, started: performance.now() });
      this.worker.postMessage({ id, type: 'check', source });
    });
  }

  dispose() { clearInterval(this.timer); this.worker.terminate(); this.pending.clear(); }
}
