// Data worker: owns the synthetic market so price generation never blocks the UI thread.
// Protocol (all messages are plain objects):
//   in  { id, type: 'contracts' }                         -> { id, ok, result: ContractSpec[] }
//   in  { id, type: 'bars', symbol, tf, to?, limit? }       -> { id, ok, result: Bars }   (arrays transferred)
//   in  { type: 'sub', key, symbol, tf } / { type: 'unsub', key }
//   in  { type: 'tele', symbol } / { type: 'untele', symbol }
//   out { type: 'bar', key, bar }          4x per second per bar subscription
//   out { type: 'tele', symbol, data }     1x per second per telemetry subscription
import { SyntheticMarket } from './synthetic-engine.js';

const market = new SyntheticMarket();
/** @type {Map<string, { symbol: string, tf: string }>} */
const barSubs = new Map();
/** @type {Map<string, number>} */
const teleSubs = new Map();

self.onmessage = (e) => {
  const m = e.data;
  try {
    switch (m.type) {
      case 'contracts': self.postMessage({ id: m.id, ok: true, result: market.contracts() }); return;
      case 'bars': {
        const b = market.bars(m.symbol, m.tf, { to: m.to, limit: m.limit });
        // copy out of any shared views, then transfer the buffers (zero-copy to the main thread)
        const own = {};
        for (const f of ['time', 'open', 'high', 'low', 'close', 'volume']) own[f] = Float64Array.from(b[f]);
        own.length = b.length;
        self.postMessage({ id: m.id, ok: true, result: own }, ['time', 'open', 'high', 'low', 'close', 'volume'].map((f) => own[f].buffer));
        return;
      }
      case 'sub': barSubs.set(m.key, { symbol: m.symbol, tf: m.tf }); return;
      case 'unsub': barSubs.delete(m.key); return;
      case 'tele': teleSubs.set(m.symbol, (teleSubs.get(m.symbol) || 0) + 1); pushTele(m.symbol); return;
      case 'untele': { const n = (teleSubs.get(m.symbol) || 1) - 1; if (n <= 0) teleSubs.delete(m.symbol); else teleSubs.set(m.symbol, n); return; }
      default: throw new Error(`Unknown message ${m.type}`);
    }
  } catch (err) {
    if (m.id !== undefined) self.postMessage({ id: m.id, ok: false, error: String(err && err.message || err) });
    else console.error(err);
  }
};

function pushTele(symbol) {
  self.postMessage({ type: 'tele', symbol, data: market.telemetry(symbol) });
}

setInterval(() => {
  const t = Date.now() / 1000;
  for (const [key, s] of barSubs) {
    try { self.postMessage({ type: 'bar', key, bar: market.currentBar(s.symbol, s.tf, t) }); }
    catch (err) { console.error(err); }
  }
}, 250);

setInterval(() => { for (const symbol of teleSubs.keys()) pushTele(symbol); }, 1000);
