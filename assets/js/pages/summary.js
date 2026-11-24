import { h, fmt } from '../lib/dom.js';
import { pageHead, sectionHead, dataTable } from '../lib/ui.js';
import { loadBundle, notPublished, lockScreen } from '../lib/bundle.js';

// A compact digest across every scanner/fundamental signal, both markets - headline counts
// only, linking back to Scanner / Fundamental Analysis for the full tables. Built from the
// same published bundle those pages read; it cannot reach the raw per-bot report HTML files
// that only exist on the PC (e.g. Accumulation_Bot's reports/latest_scan_US.html).

const SCANNER_ORDER = [
  ['accumulation', 'Accumulation Bot'],
  ['reversal', 'Reversal Bot'],
  ['revenue_dip', 'Revenue Dip'],
  ['context', 'Market Context'],
  ['analog', 'Analog Setup'],
  ['basebreakout', 'Base + Breakout'],
  ['weinstein', 'Weinstein Stage-2'],
  ['vcp', 'VCP Positional'],
  ['bbladder', 'BB Ladder'],
  ['mtf', 'MTF Trend'],
  ['msr', 'Master S&R (MSR)'],
  ['breakretest', 'Break & Retest'],
  ['pbmtf', 'Pullback-Retest MTF'],
  ['dbe', 'Logic3 DBE'],
  ['dbpyramid', 'Double-Bottom Pyramid'],
  ['inversehs', 'Inverse H&S'],
  ['ema_playbook', 'EMA Playbook'],
];
const FUNDAMENTAL_ORDER = [
  ['master_framework', 'Master Framework'],
  ['alpha_framework', 'Alpha Framework'],
  ['fundamental', 'Fundamental Scanner'],
  ['akshat', 'Akshat Framework'],
  ['tef', 'Trade Execution Framework'],
  ['rachana_tps', 'Rachana TPS'],
];

function fmtRunAt(s) {
  const m = /^(\d{4})-(\d{2})-(\d{2}) (\d{2}):(\d{2})/.exec(s || '');
  if (!m) return '';
  const [, y, mo, d] = m;
  const dt = new Date(+y, +mo - 1, +d);
  const wd = dt.toLocaleDateString('en-GB', { weekday: 'short' });
  const mon = dt.toLocaleDateString('en-GB', { month: 'short' });
  return `${wd} ${+d} ${mon} ${m[4]}:${m[5]}`;
}

function lastUpdated(item) {
  if (item.run_at) { const f = fmtRunAt(item.run_at); if (f) return f; }
  const raw = item.scanned_at || item.date || item.asof;
  if (raw) {
    const f = fmtRunAt(raw);
    if (f) return f;
    const sd = fmt.shortDate(raw);
    if (sd !== fmt.dash) return sd;
    return String(raw);
  }
  return fmt.dash;
}

function marketLabel(code) { return code === 'IN' ? 'India' : code; }

function countN(records, noun) { const n = (records || []).length; return `${n} ${noun}${n === 1 ? '' : 's'}`; }
function hotVsTotal(records, field, hotValues, hotLabel) {
  const rows = records || [];
  const hot = rows.filter((r) => hotValues.includes(r[field])).length;
  return `${hot} ${hotLabel} / ${rows.length} total`;
}
function sumValues(obj) { return Object.values(obj || {}).reduce((a, b) => a + (b || 0), 0); }

const SUMMARIZERS = {
  weinstein: (item) => hotVsTotal(item.records, 'state', ['TRIGGER'], 'trigger'),
  vcp: (item) => hotVsTotal(item.records, 'state', ['TRIGGER'], 'trigger'),
  bbladder: (item) => hotVsTotal(item.records, 'state', ['TRIGGER'], 'trigger'),
  dbe: (item) => hotVsTotal(item.records, 'state', ['TRIGGER'], 'trigger'),
  revenue_dip: (item) => countN(item.records, 'candidate'),
  analog: (item) => countN(item.records, 'match'),
  basebreakout: (item) => countN(item.records, 'candidate'),
  mtf: (item) => countN(item.records, 'signal'),
  inversehs: (item) => hotVsTotal(item.records, 'status', ['ACTIVE'], 'active'),
  dbpyramid: (item) => hotVsTotal(item.records, 'state', ['full'], 'full'),
  fundamental: (item) => hotVsTotal(item.records, 'tier', ['Strong', 'Good'], 'strong+good'),
  akshat: (item) => hotVsTotal(item.records, 'grade', ['A_PLUS', 'A'], 'A-grade'),
  context: (item) => {
    const tc = item.tag_counts || {};
    const breakouts = (tc.NEW_ATH_BREAKOUT || 0) + (tc.DOWNTREND_BREAK || 0);
    return `${breakouts} breakouts / ${sumValues(tc)} classified`;
  },
  master_framework: (item) => {
    const gc = item.grade_counts || {};
    return `${(gc['A+'] || 0) + (gc['A'] || 0)} A-grade / ${sumValues(gc)} total`;
  },
  alpha_framework: (item) => {
    const tc = item.tier_counts || {};
    return `${tc['Tier 1'] || 0} Tier 1 / ${sumValues(tc)} total`;
  },
  ema_playbook: (item) => {
    const strat = item.strategies || {};
    const names = Object.keys(strat);
    const total = names.reduce((n, k) => n + (strat[k]?.records || []).length, 0);
    return `${total} across ${names.length} playbooks`;
  },
  msr: (item) => {
    const strat = item.strategies || {};
    const names = ['Hourly', 'Daily', 'Weekly'].filter((n) => strat[n]);
    const total = names.reduce((n, k) => n + (strat[k]?.records || []).length, 0);
    return `${total} across ${names.length} timeframes`;
  },
  breakretest: (item) => {
    const strat = item.strategies || {};
    const names = ['Hourly', 'Daily', 'Weekly'].filter((n) => strat[n]);
    const total = names.reduce((n, k) => n + (strat[k]?.records || []).length, 0);
    return `${total} across ${names.length} timeframes`;
  },
  pbmtf: (item) => `${(item.signals || []).length} signals · ${(item.watchlist || []).length} watchlist`,
  rachana_tps: (item) => `${(item.records || []).length} actionable · ${(item.watchlist || []).length} watchlist`,
  accumulation: (item) => `${(item.buys || []).length} buy · ${(item.watch || []).length} watch · ${(item.near || []).length} near`,
  reversal: (item) => {
    const counts = item.counts || (() => {
      const c = {};
      for (const rows of Object.values(item.configs || {})) for (const r of rows) c[r.state] = (c[r.state] || 0) + 1;
      return c;
    })();
    return `${counts.ACTIONABLE || 0} actionable / ${sumValues(counts)} total`;
  },
  tef: (item) => {
    const rows = (item.records || []).filter((r) => !(r.action === 'Reject' && (r.totalScore ?? 0) < 80));
    const buy = rows.filter((r) => r.action === 'Aggressive Buy' || r.action === 'Buy').length;
    return `${buy} buy / ${rows.length} total`;
  },
};

function buildRows(sg, order) {
  const rows = [];
  for (const [key, label] of order) {
    const byMarket = sg[key];
    if (!byMarket || typeof byMarket !== 'object') continue;
    for (const market of Object.keys(byMarket)) {
      const item = byMarket[market];
      if (!item) continue;
      let headline = '—';
      try { headline = (SUMMARIZERS[key] || (() => '—'))(item); } catch { headline = '—'; }
      rows.push({ label, market: marketLabel(market), updated: lastUpdated(item), headline });
    }
  }
  return rows;
}

function section(title, link, rows) {
  if (!rows.length) return null;
  return h('section', null,
    sectionHead(title, null, h('a', { href: link }, 'Open →')),
    h('div', { style: { marginTop: '10px' } }, dataTable([
      { label: 'signal', render: (r) => r.label },
      { label: 'market', render: (r) => r.market },
      { label: 'updated', nw: true, render: (r) => r.updated },
      { label: 'current', wrap: true, render: (r) => r.headline },
    ], rows, { compact: true })));
}

export async function render(ctx) {
  ctx.setTitle('Summary Reports');
  const root = h('div');
  root.append(pageHead('Summary Reports', 'A quick digest across every scanner and fundamental signal, both US and India - jump to Scanner or Fundamental Analysis for the full tables.'));
  const loaded = await loadBundle();
  if (loaded.lock === 'not-published') { root.append(notPublished()); return root; }
  if (loaded.lock === 'locked') { root.append(lockScreen(loaded.env, () => location.reload())); return root; }
  const b = loaded.bundle;
  const sg = b.signals || {};
  root.append(h('p', { class: 'tiny muted' }, `Built ${fmt.rel(b.built_at)} on your PC`));

  const scannerRows = buildRows(sg, SCANNER_ORDER);
  const fundRows = buildRows(sg, FUNDAMENTAL_ORDER);
  const sScanner = section('Scanner signals', '#/', scannerRows);
  const sFund = section('Fundamental Analysis signals', '#/fundamentals', fundRows);

  const stack = h('div', { class: 'stack', style: { '--gap': '30px', marginTop: '18px' } });
  if (sScanner) stack.append(sScanner);
  if (sFund) stack.append(sFund);
  if (!sScanner && !sFund) stack.append(h('div', { class: 'empty' }, h('b', null, 'Nothing published yet'), 'Run your scans and PUBLISH.bat, then reload.'));
  root.append(stack);
  return root;
}
