// Data loading. All data is static JSON written by the pipeline.
import { fileKey } from './dom.js';

let version = '';
const memo = new Map();

export function setVersion(v) { version = v ? String(v) : ''; }
export function clearMemo() { memo.clear(); }

export async function getJSON(path, { fresh = false } = {}) {
  const key = path + '|' + version;
  if (!fresh && memo.has(key)) return memo.get(key);
  const p = (async () => {
    try {
      const url = new URL(path, document.baseURI);
      if (version) url.searchParams.set('v', version);
      const res = await fetch(url, { cache: 'no-cache' });
      if (!res.ok) return null;
      return await res.json();
    } catch (e) {
      console.warn('getJSON failed', path, e);
      return null;
    }
  })();
  memo.set(key, p);
  const val = await p;
  if (val == null) memo.delete(key);
  return val;
}

export const D = {
  meta: () => getJSON('data/meta.json', { fresh: true }),
  market: () => getJSON('data/market.json'),
  index: () => getJSON('data/fundamentals/index.json'),
  feed: () => getJSON('data/fundamentals/feed.json'),
  company: (sym) => getJSON(`data/fundamentals/${fileKey(sym)}.json`),
  sentiment: () => getJSON('data/sentiment/summary.json'),
  sentimentFor: (sym) => getJSON(`data/sentiment/${fileKey(sym)}.json`),
  signals: () => getJSON('data/technical/public_signals.json'),
  edgarIndex: () => getJSON('data/edgar/tickers.json'),
  indiaIndex: () => getJSON('data/india/tickers.json'),
};

// Fetches an absolute URL directly (not one of our own static JSON files) and returns parsed JSON or null.
// Used for ad-hoc lookups of companies outside the watchlist, straight from the browser.
export async function getJSONAbsolute(url) {
  try {
    const res = await fetch(url, { headers: { Accept: 'application/json' } });
    if (!res.ok) return null;
    return await res.json();
  } catch (e) {
    console.warn('getJSONAbsolute failed', url, e);
    return null;
  }
}

// Joins market + fundamentals + sentiment + public signals into one row per ticker
export async function loadBoard() {
  const [market, index, sent, sig] = await Promise.all([D.market(), D.index(), D.sentiment(), D.signals()]);
  const rows = [];
  const idx = index?.companies || [];
  const q = market?.quotes || {};
  const sMap = Object.fromEntries((sent?.tickers || []).map((t) => [t.symbol, t]));
  const gMap = sig?.tickers || {};
  for (const c of idx) {
    const quote = q[c.symbol] || {};
    const s = sMap[c.symbol];
    const g = gMap[c.symbol];
    rows.push({
      ...c,
      price: quote.price ?? c.price,
      change_pct: quote.change_pct ?? c.change_pct,
      spark: quote.spark || c.spark || [],
      pre_price: quote.pre_price, post_price: quote.post_price,
      sentiment: s || null,
      signal: g || null,
      lens: lensFor(c, s, g),
    });
  }
  return { rows, market, index, sent, sig };
}

// Lens states are computed in the pipeline (c.lens) for F and T; S from the sentiment score.
function lensFor(c, s, g) {
  const L = { ...(c.lens || {}) };
  if (g) {
    if (g.state === 'BUY') { L.T = 1; L.T_why = `${g.src}: breakout signal`; }
    else if (g.state === 'WATCH') { if (L.T !== -1) L.T = L.T === 1 ? 1 : 0; L.T_why = `${g.src}: on watchlist`; }
  }
  if (s && typeof s.score === 'number' && s.mentions >= 3) {
    L.S = s.score >= 20 ? 1 : s.score <= -20 ? -1 : 0;
    L.S_why = `crowd score ${s.score > 0 ? '+' : ''}${Math.round(s.score)}`;
  } else L.S = 'none';
  if (L.F === undefined) L.F = 'none';
  if (L.T === undefined) L.T = 'none';
  return L;
}
