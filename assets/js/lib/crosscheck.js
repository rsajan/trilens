// Cross-signal confluence: walks every signal section in the bundle and works out which
// symbols get confirmed by two or more DIFFERENT scanners/signals/frameworks -- used by the
// Scanner Results and Fundamental Results pages. No new data is fetched or stored; this is a
// pure read of whatever is already in the published bundle, so it stays current automatically
// every time a fresh bundle is published -- there is nothing here to keep in sync by hand.
//
// "Source" = one of the named sections already on the Scanner/Fundamental Analysis pages (the
// Reversal bot's 8 configs each count as their own source, since they're separately named
// scanners sharing one report). A symbol showing up twice WITHIN one source (e.g. both a daily
// and a weekly row in the same scanner) still counts as one confirmation from that source --
// only distinct sources count toward the occurrence total.

function pushRow(out, seen, source, market, symbol, sector, runAt, score) {
  if (!symbol) return;
  const key = `${source}::${market}::${symbol}`;
  if (seen.has(key)) return;
  seen.add(key);
  out.push({ source, market, symbol, sector: sector || null, runAt: runAt || null, score: score != null ? score : null });
}

function scoreOf(row, field) {
  return field && row[field] != null ? row[field] : null;
}

function fromRecords(sg, key, label, scoreField, out, seen) {
  const byMarket = sg[key];
  if (!byMarket) return;
  for (const market of Object.keys(byMarket)) {
    const bucket = byMarket[market] || {};
    for (const r of bucket.records || []) pushRow(out, seen, label, market, r.symbol, r.sector, bucket.run_at, scoreOf(r, scoreField));
  }
}

function fromStrategies(sg, key, label, scoreField, out, seen) {
  const byMarket = sg[key];
  if (!byMarket) return;
  for (const market of Object.keys(byMarket)) {
    const bucket = byMarket[market] || {};
    for (const strat of Object.values(bucket.strategies || {})) {
      for (const r of strat.records || []) pushRow(out, seen, label, market, r.symbol, r.sector, bucket.run_at, scoreOf(r, scoreField));
    }
  }
}

function fromBuckets(sg, key, label, bucketNames, scoreField, out, seen) {
  const byMarket = sg[key];
  if (!byMarket) return;
  for (const market of Object.keys(byMarket)) {
    const bucket = byMarket[market] || {};
    for (const bn of bucketNames) {
      for (const r of bucket[bn] || []) pushRow(out, seen, label, market, r.symbol, r.sector, bucket.run_at, scoreOf(r, scoreField));
    }
  }
}

function fromReversalConfigs(sg, out, seen) {
  const byMarket = sg.reversal;
  if (!byMarket) return;
  for (const market of Object.keys(byMarket)) {
    const bucket = byMarket[market] || {};
    for (const [cfg, rows] of Object.entries(bucket.configs || {})) {
      for (const r of rows || []) pushRow(out, seen, `Reversal: ${cfg}`, market, r.symbol, null, bucket.run_at, null);
    }
  }
}

function fromAccumulation(sg, out, seen) {
  const byMarket = sg.accumulation;
  if (!byMarket) return;
  for (const mk of Object.keys(byMarket)) {
    const a = byMarket[mk] || {};
    const market = mk === 'IN' ? 'India' : mk;
    // a.scanned_at is already-formatted display text ("Tue 17 Nov 07:03"), not a sortable
    // date like every other source's run_at/asof -- a.date (plain YYYY-MM-DD) is, so use that
    // for "last updated" instead of mixing an unsortable format into the comparison.
    for (const bn of ['buys', 'watch', 'near']) {
      for (const r of a[bn] || []) pushRow(out, seen, 'Accumulation bot', market, (r.ticker || '').replace(/\.NS$/, ''), r.sector, a.date || null, null);
    }
  }
}

// [signal key, display name, score field to carry through if present (or null)]
const SIMPLE_SOURCES = [
  ['context', 'Market context classifier', null],
  ['analog', 'Analog setup scanner', null],
  ['basebreakout', 'Base + breakout scanner', null],
  ['weinstein', 'Weinstein Stage-2 scanner', null],
  ['vcp', 'VCP Positional scanner', 'score'],
  ['mtf', 'MTF Trend Strategy', null],
  ['dbe', 'Logic 3 DBE', null],
  ['dbpyramid', 'Double-bottom pyramid scanner', null],
  ['inversehs', 'Inverse head & shoulders', null],
  ['revenue_dip', 'Revenue trend and price dip', null],
  ['master_framework', 'Fundamental Analysis Master Framework', 'investmentScore'],
  ['alpha_framework', 'Alpha Framework', 'totalScore'],
  ['fundamental', 'Fundamental Analysis screen', 'quant_score'],
  ['akshat', 'Akshat Shrivastava Hybrid', 'total_score'],
  ['tef', 'Master Stock Analysis & Trade Execution Framework', 'totalScore'],
];
const STRATEGY_SOURCES = [
  ['msr', 'Master Support & Resistance Framework', 'total'],
  ['breakretest', 'Break & Retest Master Framework', 'total_score'],
];

/** keys: a Set of sg.<key> names to include (SCANNER_KEYS or FUNDAMENTAL_KEYS from scanner.js). */
export function collectOccurrences(sg, keys) {
  const out = [];
  const seen = new Set();
  for (const [key, label, scoreField] of SIMPLE_SOURCES) if (keys.has(key)) fromRecords(sg, key, label, scoreField, out, seen);
  for (const [key, label, scoreField] of STRATEGY_SOURCES) if (keys.has(key)) fromStrategies(sg, key, label, scoreField, out, seen);
  if (keys.has('pbmtf')) fromBuckets(sg, 'pbmtf', 'Pullback-Retest MTF Swing Strategy', ['signals', 'watchlist'], 'alignment_score', out, seen);
  if (keys.has('rachana_tps')) fromBuckets(sg, 'rachana_tps', 'CA Rachana Ranade Framework', ['records', 'watchlist'], 'total_score', out, seen);
  if (keys.has('reversal')) fromReversalConfigs(sg, out, seen);
  if (keys.has('accumulation')) fromAccumulation(sg, out, seen);
  return out;
}

/** Groups by (market, symbol), keeps only symbols confirmed by >= minSources DISTINCT sources. */
export function rankBySymbol(occurrences, minSources = 2) {
  const bySymbol = new Map();
  for (const o of occurrences) {
    const k = `${o.market}::${o.symbol}`;
    if (!bySymbol.has(k)) bySymbol.set(k, { symbol: o.symbol, market: o.market, sector: null, rows: [], lastUpdated: null, bestScore: null });
    const g = bySymbol.get(k);
    g.rows.push(o);
    if (!g.sector && o.sector) g.sector = o.sector;
    if (o.runAt && (!g.lastUpdated || o.runAt > g.lastUpdated)) g.lastUpdated = o.runAt;
    if (o.score != null && (g.bestScore == null || o.score > g.bestScore)) g.bestScore = o.score;
  }
  const out = [];
  for (const g of bySymbol.values()) {
    const sourceNames = [...new Set(g.rows.map((r) => r.source))];
    if (sourceNames.length < minSources) continue;
    out.push({ symbol: g.symbol, market: g.market, sector: g.sector, lastUpdated: g.lastUpdated, bestScore: g.bestScore, sourceNames, count: sourceNames.length });
  }
  out.sort((a, b) => b.count - a.count || a.symbol.localeCompare(b.symbol));
  return out;
}
