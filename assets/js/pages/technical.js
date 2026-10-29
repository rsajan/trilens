import { h, icon, fmt, badge, sheet } from '../lib/dom.js';
import { getJSON } from '../lib/data.js';
import { store } from '../lib/store.js';
import { decryptEnvelope, cryptoAvailable } from '../lib/crypto.js';
import { renderMarkdown } from '../lib/md.js';
import { lineChart, columns } from '../lib/charts.js';
import { pageHead, sectionHead, tabsBar, segmented, chipGroup, dataTable } from '../lib/ui.js';

const TABS = [
  { id: 'signals', label: 'Signals' },
  { id: 'strategies', label: 'Strategies' },
  { id: 'results', label: 'Results' },
  { id: 'automation', label: 'Automation' },
  { id: 'library', label: 'Library' },
];
let BUNDLE = null;

// ------------------------------------------------------------------ loading / unlocking
async function fetchEnvelope() {
  for (const p of ['data/technical/bundle.json', 'data/technical/bundle.local.json']) {
    const o = await getJSON(p, { fresh: true });
    if (o) return o;
  }
  return null;
}

async function unlock(env, pass) {
  const b = await decryptEnvelope(env, pass);
  BUNDLE = b;
  return b;
}

export async function render(ctx) {
  ctx.setTitle('Technical');
  const [tab = 'signals', id] = ctx.params;
  const root = h('div');
  root.append(pageHead('Technical', 'Your scanners, strategy research and backtests, and the automation that runs them.'));
  if (!BUNDLE) {
    const env = await fetchEnvelope();
    if (!env) { root.append(notPublished()); return root; }
    if (!env.enc) BUNDLE = env;
    else {
      const saved = store.get('techpass');
      if (saved) { try { await unlock(env, saved); } catch { store.del('techpass'); } }
      if (!BUNDLE) { root.append(lockScreen(env, ctx)); return root; }
    }
  }
  const b = BUNDLE;
  root.append(h('div', { class: 'row between wrap', style: { gap: '8px' } },
    h('span', { class: 'tiny muted' }, `Built ${fmt.rel(b.built_at)} on your PC`)));
  root.append(tabsBar(TABS, TABS.some((t) => t.id === tab) ? tab : 'signals', (t) => { location.hash = `#/technical/${t}`; }));
  const body = h('div', { style: { marginTop: '18px' } });
  root.append(body);
  const t = TABS.some((x) => x.id === tab) ? tab : 'signals';
  if (t === 'signals') body.append(signals(b, ctx));
  else if (t === 'strategies') body.append(id ? strategyDetail(b, id) : strategies(b));
  else if (t === 'results') body.append(results(b));
  else if (t === 'automation') body.append(automation(b));
  else body.append(id ? libraryItem(b, id) : library(b));
  return root;
}

function notPublished() {
  return h('div', { class: 'lock' }, icon('lock', 'big'), h('h2', null, 'Technical data is not published yet'),
    h('p', { class: 'soft', style: { margin: '10px 0 0' } }, 'This page is built from the scanner files on your computer. Run PUBLISH.bat in your project folder once, and it will appear here. The README explains the one-time setup.'));
}

function lockScreen(env, ctx) {
  const err = h('div', { class: 'err', role: 'alert' });
  const pass = h('input', { class: 'field', type: 'password', placeholder: 'Technical page password', autocomplete: 'current-password', 'aria-label': 'Password', required: true });
  const remember = h('input', { type: 'checkbox', checked: true, id: 'rem' });
  const form = h('form', { onSubmit: async (e) => {
    e.preventDefault(); err.textContent = '';
    if (!cryptoAvailable()) { err.textContent = 'Your browser only unlocks on a secure address. Open the site by its https:// link.'; return; }
    try {
      await unlock(env, pass.value);
      if (remember.checked) store.set('techpass', pass.value);
      location.reload();
    } catch (x) { err.textContent = x.message === 'bad-password' ? 'That password did not open it. Check it and try again.' : 'Could not unlock: ' + x.message; }
  } }, pass, h('label', { class: 'check', for: 'rem' }, remember, 'Remember on this device'), h('button', { class: 'btn primary', type: 'submit' }, 'Unlock'), err);
  return h('div', { class: 'lock' }, icon('lock', 'big'), h('h2', null, 'Your strategies are locked'),
    h('p', { class: 'soft', style: { margin: '10px 0 0' } }, 'Everything on this page is encrypted in your repository. Enter the password you chose during setup to read it. It is checked on your device only.'), form);
}

// ------------------------------------------------------------------ signals
function signals(b, ctx) {
  const root = h('div', { class: 'stack', style: { '--gap': '30px' } });
  const sg = b.signals || {};
  const acc = sg.accumulation || {};
  for (const mk of ['US', 'IN']) {
    const a = acc[mk]; if (!a) continue;
    root.append(accumulationBlock(mk, a));
  }
  if (sg.reversal && Object.keys(sg.reversal).length) {
    let cur = Object.keys(sg.reversal)[0];
    const box = h('div');
    const paint = () => {
      const r = sg.reversal[cur];
      box.replaceChildren(r.html
        ? h('iframe', { class: 'report-frame', sandbox: '', srcdoc: r.html, title: `Reversal bot ${cur}` })
        : h('pre', { class: 'txt' }, r.text || 'No report found.'));
    };
    root.append(h('section', null, sectionHead('Reversal bot: v5, v6, S1 and S3', sg.reversal[cur]?.asof ? `data through ${sg.reversal[cur].asof}` : ''),
      Object.keys(sg.reversal).length > 1 ? segmented(Object.keys(sg.reversal).map((k) => ({ id: k, label: k })), cur, (v) => { cur = v; paint(); }) : null,
      h('div', { style: { height: '10px' } }), box));
    paint();
  }
  if (sg.revenue_dip && Object.keys(sg.revenue_dip).length) {
    let cur = Object.keys(sg.revenue_dip)[0];
    const box = h('div');
    const paint = () => {
      const r = sg.revenue_dip[cur];
      const recs = r.records || [];
      const gate = r.regime_on == null ? null : h('div', { class: 'row wrap', style: { gap: '8px', marginBottom: '10px' } }, badge(r.regime_on ? 'Market filter on' : 'Market filter off: no new entries', r.regime_on ? 'gain' : 'loss'), r.regime_gap_pct != null ? badge(`index ${r.regime_gap_pct > 0 ? '+' : ''}${fmt.num(r.regime_gap_pct, 1)}% vs 200-day average`, 'outline') : null);
      if (!recs.length) { box.replaceChildren(...[gate, h('div', { class: 'empty' }, 'No candidates in the latest file.')].filter(Boolean)); return; }
      const cols = Object.keys(recs[0]).slice(0, 9);
      box.replaceChildren(...[gate, dataTable(cols.map((c) => ({ label: c.replace(/_/g, ' '), align: typeof recs[0][c] === 'number' ? 'r' : '', render: (row) => cell(row[c]) })), recs.slice(0, 40), { compact: true })].filter(Boolean));
    };
    root.append(h('section', null, sectionHead('Revenue trend and price dip', 'a watch list, not a trading signal'),
      Object.keys(sg.revenue_dip).length > 1 ? segmented(Object.keys(sg.revenue_dip).map((k) => ({ id: k, label: k })), cur, (v) => { cur = v; paint(); }) : null,
      h('div', { style: { height: '10px' } }), box));
    paint();
  }
  if (sg.context && Object.keys(sg.context).length) {
    let cur = Object.keys(sg.context)[0];
    const box = h('div');
    const paint = () => {
      const r = sg.context[cur];
      const counts = r.tag_counts || {};
      const chips = h('div', { class: 'row wrap', style: { gap: '8px', marginBottom: '10px' } },
        ...CONTEXT_TAGS.filter((t) => counts[t]).map((t) => badge(`${counts[t]} ${CONTEXT_LABEL[t]}`, CONTEXT_KIND[t])));
      const recs = r.records || [];
      if (!recs.length) { box.replaceChildren(chips, h('div', { class: 'empty' }, 'No actionable context signals today.')); return; }
      const cols = [
        { label: 'symbol', render: (row) => h('a', { class: 'sym', href: `#/fundamentals/${encodeURIComponent(row.symbol)}`, style: { textDecoration: 'none' } }, row.symbol) },
        { label: 'context', render: (row) => badge(CONTEXT_LABEL[row.context] || row.context, CONTEXT_KIND[row.context]) },
        { label: 'close', align: 'r', render: (row) => cell(row.close) },
        { label: 'detail', render: (row) => contextDetail(row) },
      ];
      box.replaceChildren(chips, dataTable(cols, recs.slice(0, 60), { compact: true }));
    };
    root.append(h('section', null, sectionHead('Market context classifier', sg.context[cur]?.asof ? `data through ${sg.context[cur].asof} · ${sg.context[cur].universe} scanned` : ''),
      Object.keys(sg.context).length > 1 ? segmented(Object.keys(sg.context).map((k) => ({ id: k, label: k })), cur, (v) => { cur = v; paint(); }) : null,
      h('div', { style: { height: '10px' } }), box));
    paint();
  }
  if (sg.analog && Object.keys(sg.analog).length) {
    let cur = Object.keys(sg.analog)[0];
    const box = h('div');
    const paint = () => {
      const r = sg.analog[cur];
      const recs = r.records || [];
      if (!recs.length) { box.replaceChildren(h('div', { class: 'empty' }, 'No live setups right now.')); return; }
      const cols = [
        { label: 'symbol', render: (row) => h('a', { class: 'sym', href: `#/fundamentals/${encodeURIComponent(row.symbol)}`, style: { textDecoration: 'none' } }, row.symbol) },
        { label: 'context', render: (row) => row.context ? badge(CONTEXT_LABEL[row.context] || row.context, CONTEXT_KIND[row.context]) : '—' },
        { label: 'entry', align: 'r', render: (row) => cell(row.entry_level) },
        { label: 'stop', align: 'r', render: (row) => cell(row.stop_level) },
        { label: 'break-even', align: 'r', render: (row) => cell(row.breakeven_level) },
        { label: 'target', align: 'r', render: (row) => cell(row.take_profit_level) },
        { label: 'risk', align: 'r', render: (row) => row.risk_pct != null ? fmt.pct(row.risk_pct, 2, false) : '—' },
        { label: 'analogs', align: 'r', render: (row) => `${row.n_analogs_confirmed ?? '—'}/${row.n_analogs ?? '—'}` },
      ];
      box.replaceChildren(dataTable(cols, recs.slice(0, 60), { compact: true }));
    };
    root.append(h('section', null, sectionHead('Analog setup scanner (stage 1 + stages 2-4)', 'context-gated: only stocks currently tagged a fresh breakout, then validated against ≥2 confirmed historical retests on the same stock, daily-bar proxy for the 4H chart'),
      Object.keys(sg.analog).length > 1 ? segmented(Object.keys(sg.analog).map((k) => ({ id: k, label: k })), cur, (v) => { cur = v; paint(); }) : null,
      h('div', { style: { height: '10px' } }), box));
    paint();
  }
  if (!root.childNodes.length) root.append(h('div', { class: 'empty' }, h('b', null, 'No scan results in the bundle'), 'Run PUBLISH.bat after a scan has finished and they will show up here.'));
  if (b.notes?.length) root.append(h('details', null, h('summary', { class: 'small muted', style: { cursor: 'pointer', padding: '6px 0' } }, `Build notes (${b.notes.length})`), h('ul', { class: 'soft small', style: { paddingLeft: '20px' } }, b.notes.map((n) => h('li', null, n)))));
  return root;
}
function cell(v) {
  if (v == null || v === '') return '—';
  if (typeof v === 'number') return Number.isInteger(v) || Math.abs(v) >= 1000 ? fmt.int(v) : fmt.num(v, Math.abs(v) < 1 ? 3 : 2);
  return String(v);
}

// Tags from market_context.py / MARKET_CONTEXT_FRAMEWORK.md, in decision-tree order.
const CONTEXT_TAGS = ['NEW_ATH_BREAKOUT', 'DOWNTREND_BREAK', 'UPTREND_PULLBACK_SMALL', 'UPTREND_PULLBACK_DEEP', 'DOWNTREND_INTACT', 'RANGE_CORRECTION_300D', 'UNCLASSIFIED'];
const CONTEXT_LABEL = { NEW_ATH_BREAKOUT: 'new ATH', DOWNTREND_BREAK: 'downtrend break', UPTREND_PULLBACK_SMALL: 'small pullback', UPTREND_PULLBACK_DEEP: 'deep pullback', DOWNTREND_INTACT: 'downtrend', RANGE_CORRECTION_300D: '300d range', UNCLASSIFIED: 'unclassified' };
const CONTEXT_KIND = { NEW_ATH_BREAKOUT: 'gain', DOWNTREND_BREAK: 'gain', UPTREND_PULLBACK_SMALL: 'gain', UPTREND_PULLBACK_DEEP: 'loss', DOWNTREND_INTACT: 'loss', RANGE_CORRECTION_300D: 'outline', UNCLASSIFIED: 'outline' };
function contextDetail(row) {
  if (row.context === 'NEW_ATH_BREAKOUT') return row.prior_ath_bars_ago != null ? `prior high stood ${fmt.int(row.prior_ath_bars_ago)} bars` : '—';
  if (row.context === 'DOWNTREND_BREAK') return row.trendline_value != null ? `trendline ${cell(row.trendline_value)}` : '—';
  if (row.context === 'UPTREND_PULLBACK_SMALL' || row.context === 'UPTREND_PULLBACK_DEEP') return row.retracement_pct != null ? `${fmt.num(row.retracement_pct, 1)}% retracement` : '—';
  return '—';
}

const CHECKS = ['A1', 'A2', 'A3', 'A4', 'A5', 'B1', 'B2', 'B3', 'B4', 'B5', 'B6', 'B7'];
function accumulationBlock(mk, a) {
  const cur = a.cur || (mk === 'IN' ? '₹' : '$');
  const money = (v) => (v == null ? '—' : cur + fmt.num(v, v >= 1000 ? 0 : 2));
  const open = a.gate;
  const wrap = h('section', null,
    sectionHead(`Accumulation bot: ${mk === 'US' ? 'United States' : 'India'}`, a.scanned_at || a.date),
    h('div', { class: 'row wrap', style: { gap: '8px', marginBottom: '12px' } },
      badge(`Market ${a.regime || 'unknown'}`, open ? 'gain' : 'loss'),
      badge(open ? 'Buy gate open' : 'Buy gate closed: no new buys', open ? 'gain' : 'loss'),
      badge(`${(a.buys || []).length} buy`, (a.buys || []).length ? 'gain' : 'outline'),
      badge(`${(a.watch || []).length} on watch`, 'outline'),
      badge(`${(a.near || []).length} near miss`, 'outline')));
  const mkRows = (rows, withChecks) => h('div', { class: 'ledger' }, rows.map((r) => h('div', { class: 'lrow', style: { alignItems: 'flex-start', padding: '12px 2px', flexDirection: 'column', gap: '8px' } },
    h('div', { class: 'row between', style: { width: '100%' } },
      h('div', { class: 'row', style: { gap: '10px', minWidth: 0 } }, h('a', { class: 'sym', href: `#/fundamentals/${encodeURIComponent(r.ticker)}`, style: { textDecoration: 'none' } }, r.ticker.replace(/\.NS$/, '')),
        h('span', { class: 'name ell' }, [r.sector, r.industry && r.industry !== r.sector ? r.industry : null].filter(Boolean).join(', '))),
      badge(`Grade ${r.grade}`, r.grade === 'A+' ? 'gain' : 'outline')),
    h('div', { class: 'small soft' }, r.verdict),
    h('div', { class: 'row wrap tnum small', style: { gap: '4px 18px' } },
      kvInline('Close', money(r.close)), kvInline('Pivot', money(r.pivot)), kvInline('Stop', money(r.stop)), kvInline('Risk', r.risk_pct != null ? fmt.pct(r.risk_pct * 100, 1, false) : '—'),
      kvInline('Reward:risk', fmt.num(r.rr, 1)), r.shares ? kvInline('Shares', fmt.int(r.shares)) : null, r.earnings ? kvInline('Earnings', fmt.shortDate(r.earnings)) : null, r.rs_rating != null ? kvInline('RS rating', fmt.int(r.rs_rating)) : null),
    withChecks ? h('div', { class: 'checks', title: 'Checklist: A = preliminary, B = the seven points' }, CHECKS.map((k) => h('span', { class: r.checks?.[k] === true ? 'y' : r.checks?.[k] === false ? 'n' : 'u', title: k + (r.checks?.[k] === true ? ' pass' : r.checks?.[k] === false ? ' fail' : ' not applicable') }, k))) : null)));
  if (a.buys?.length) wrap.append(h('h3', { style: { margin: '14px 0 4px' } }, 'Breakouts today'), mkRows(a.buys, true));
  if (a.watch?.length) wrap.append(h('h3', { style: { margin: '18px 0 4px' } }, 'Watchlist: set an alert at the pivot'), mkRows(a.watch, true));
  if (a.near?.length) {
    const d = h('details', { style: { marginTop: '18px' } }, h('summary', { class: 'small soft', style: { cursor: 'pointer', padding: '6px 0' } }, `Near misses (${a.near.length})`), mkRows(a.near.slice(0, 40), true));
    wrap.append(d);
  }
  if (!a.buys?.length && !a.watch?.length && !a.near?.length) wrap.append(h('div', { class: 'empty' }, 'The scan found nothing today.'));
  return wrap;
}
const kvInline = (k, v) => h('span', null, h('span', { class: 'muted' }, k + ' '), v);

// ------------------------------------------------------------------ strategies
const STATUS = { live: ['Live', 'live'], shadow: ['Shadow test', 'val'], validated: ['Validated, not live', 'val'], candidate: ['Candidate', 'cand'], retired: ['Retired', 'ret'], rejected: ['Rejected', 'rej'] };
function statusBadge(s) { const [t, c] = STATUS[s.status] || [s.status, '']; return badge(s.status_label || t, c); }

const M = (m, k, f) => (m && m[k] != null ? f(m[k]) : '—');

function strategies(b) {
  const list = b.strategies || [];
  let filter = 'all';
  const box = h('div', { class: 'scards' });
  const paint = () => {
    box.replaceChildren(...list.filter((s) => filter === 'all' || s.status === filter || (filter === 'active' && ['live', 'shadow'].includes(s.status))).map((s) => h('a', { class: 'scard', href: `#/technical/strategies/${encodeURIComponent(s.id)}` },
      h('div', { class: 'row between' }, statusBadge(s), h('span', { class: 'tiny muted' }, s.family)),
      h('h3', null, s.name), h('p', null, s.headline),
      h('div', { class: 'mini' },
        miniStat('Win rate', M(s.metrics, 'win_pct', (v) => fmt.pct(v, 1, false))),
        miniStat('Avg R', M(s.metrics, 'avg_r', (v) => fmt.signed(v, 2))),
        miniStat('Trades/yr', M(s.metrics, 'per_year', (v) => fmt.num(v, 1))),
        miniStat('CAGR@20%DD', M(s.metrics, 'cagr20', (v) => fmt.pct(v, 1, false)))))));
  };
  const counts = (st) => list.filter((s) => st === 'all' ? true : st === 'active' ? ['live', 'shadow'].includes(s.status) : s.status === st).length;
  const root = h('div', null,
    h('div', { class: 'row between wrap', style: { gap: '8px' } },
      chipGroup([{ id: 'all', label: 'All', count: counts('all') }, { id: 'active', label: 'Running now', count: counts('active') }, { id: 'validated', label: 'Validated', count: counts('validated') }, { id: 'candidate', label: 'Candidates', count: counts('candidate') }, { id: 'retired', label: 'Retired', count: counts('retired') }].filter((o) => o.count || o.id === 'all'), filter, (v) => { filter = v; paint(); }),
      h('button', { class: 'chip', onClick: metricsHelp }, icon('info'), 'What the numbers mean')),
    h('div', { style: { height: '8px' } }), box);
  paint();
  return root;
}
const miniStat = (l, v) => h('div', null, h('div', { class: 'v' }, v), h('div', { class: 'l' }, l));

function metricsHelp() {
  sheet('What the numbers mean',
    h('dl', { class: 'stack', style: { '--gap': '12px', margin: 0 } },
      ...[['R', 'One unit of risk: the distance from entry to stop. A win of +2R made twice what the trade risked. Everything is measured in R so it does not depend on account size.'],
        ['Avg R', 'Average result per trade, after costs. +0.30R means 30% of the risked amount, on average.'],
        ['Profit factor', 'Total won divided by total lost. Above 1.5 is healthy.'],
        ['t-stat', 'How far the average is from zero relative to its noise. Above 2 is the usual bar for "probably not luck".'],
        ['Max drawdown at 1% risk', 'Worst peak-to-trough fall of the account if every trade risks 1% of equity.'],
        ['CAGR at 20% drawdown', 'Yearly growth if you size positions so the worst historical drawdown is 20%. It lets strategies with different risk be compared fairly.'],
        ['Cells 4/4', 'The edge was positive in all four market and era slices (US and India, early and late history).'],
        ['Train and test', 'Settings chosen on the early years only, then checked once on the later years they never saw.']]
        .map(([k, v]) => h('div', null, h('dt', { style: { fontWeight: 600 } }, k), h('dd', { class: 'soft small', style: { margin: '2px 0 0' } }, v)))));
}

function strategyDetail(b, id) {
  const s = (b.strategies || []).find((x) => x.id === id);
  const root = h('div', { class: 'stack', style: { '--gap': '26px' } });
  root.append(h('a', { class: 'back', href: '#/technical/strategies' }, icon('back'), 'All strategies'));
  if (!s) { root.append(h('div', { class: 'empty' }, 'Strategy not found.')); return root; }
  const m = s.metrics || {};
  root.append(h('div', null, h('div', { class: 'row wrap', style: { gap: '8px', marginBottom: '8px' } }, statusBadge(s), badge(s.family, 'outline'), s.universe ? badge(s.universe, 'outline') : null), h('h1', null, s.name), h('p', { class: 'soft', style: { marginTop: '8px', maxWidth: '66ch' } }, s.headline)));
  root.append(h('div', null, h('div', { class: 'row between', style: { marginBottom: '10px' } }, h('h3', null, 'Backtest results'), h('button', { class: 'chip', style: { height: '30px' }, onClick: metricsHelp }, icon('info'), 'Explain')),
    h('div', { class: 'figs' },
      fig('Trades', fmt.int(m.trades), m.per_year ? `${fmt.num(m.per_year, 1)} a year` : ''),
      fig('Win rate', M(m, 'win_pct', (v) => fmt.pct(v, 1, false))),
      fig('Average R', M(m, 'avg_r', (v) => fmt.signed(v, 3)), m.t_stat ? `t = ${fmt.num(m.t_stat, 2)}` : ''),
      fig('Profit factor', M(m, 'pf', (v) => fmt.num(v, 2))),
      fig('Max drawdown', M(m, 'mdd_1pct', (v) => fmt.pct(v, 1)), 'at 1% risk per trade'),
      fig('CAGR at 20% drawdown', M(m, 'cagr20', (v) => fmt.pct(v, 1, false))),
      fig('Sharpe', M(m, 'sharpe', (v) => fmt.num(v, 2))),
      fig('Slices positive', m.cells || '—'))));
  if (m.train_avg_r != null && m.test_avg_r != null) root.append(h('div', { class: 'panel' }, h('h3', null, 'Out-of-sample check'),
    h('p', { class: 'soft small', style: { margin: '6px 0 12px' } }, 'Settings chosen on the early years, then run once on later years they never saw.'),
    columns({ labels: ['Train', 'Test'], series: [{ name: 'Average R', values: [m.train_avg_r, m.test_avg_r], color: 'var(--s1)' }], height: 130, yFmt: (v) => fmt.num(v, 2), label: 'Train versus test average R' })));
  const ruleBlock = (title, arr) => arr?.length ? h('div', null, h('h3', { style: { marginBottom: '6px' } }, title), h('ol', { class: 'rules' }, arr.map((r) => h('li', null, r)))) : null;
  root.append(ruleBlock('Entry rules', s.entry), ruleBlock('Stop, target and management', s.exit), ruleBlock('Filters and portfolio rules', s.filters));
  if (s.verdict) root.append(h('div', null, h('h3', { style: { marginBottom: '6px' } }, 'What the tests showed'), h('p', { class: 'soft', style: { maxWidth: '68ch' } }, s.verdict), s.caveats?.length ? h('ul', { class: 'soft', style: { paddingLeft: '20px', maxWidth: '68ch' } }, s.caveats.map((c) => h('li', null, c))) : null));
  if (s.rejected?.length) root.append(h('div', null, h('h3', { style: { marginBottom: '6px' } }, 'Tried and rejected'), h('ul', { class: 'soft', style: { paddingLeft: '20px', maxWidth: '68ch' } }, s.rejected.map((c) => h('li', null, c)))));
  const docs = (s.docs || []).map((d) => (b.library || []).find((l) => l.id === d)).filter(Boolean);
  if (docs.length) root.append(h('div', null, h('h3', { style: { marginBottom: '6px' } }, 'Full write-ups'), h('div', { class: 'ledger' }, docs.map((d) => libRow(d)))));
  return root;
}
const fig = (l, v, d) => h('div', { class: 'fig' }, h('div', { class: 'v' }, v), h('div', { class: 'l' }, l), d ? h('div', { class: 'd muted' }, d) : null);

// ------------------------------------------------------------------ results
function hbars(items, { fmtv = (v) => fmt.num(v, 1), color = 'var(--s1)', max } = {}) {
  const top = max ?? Math.max(...items.map((i) => Math.abs(i.value)), 1e-9);
  return h('div', { class: 'stack', style: { '--gap': '12px' } }, items.map((i) => h('div', null,
    h('div', { class: 'row between small', style: { marginBottom: '4px' } }, h('span', { class: 'ell' }, i.label), h('b', { class: 'num' }, fmtv(i.value))),
    h('div', { style: { height: '12px', background: 'var(--surface-2)', borderRadius: '4px' } }, h('div', { style: { height: '100%', width: Math.max(1.5, (Math.abs(i.value) / top) * 100) + '%', background: i.color || color, borderRadius: '0 4px 4px 0' } })))));
}

function results(b) {
  const root = h('div', { class: 'stack', style: { '--gap': '32px' } });
  const R = b.results || {};
  const cmp = (b.strategies || []).filter((s) => s.metrics?.cagr20 != null).sort((a, c) => c.metrics.cagr20 - a.metrics.cagr20);
  if (cmp.length) root.append(h('section', null, sectionHead('Growth at a common 20% drawdown', 'yearly, after costs'),
    hbars(cmp.map((s) => ({ label: s.name, value: s.metrics.cagr20 })), { fmtv: (v) => fmt.pct(v, 1, false) }),
    h('p', { class: 'muted small', style: { marginTop: '10px', maxWidth: '64ch' } }, 'Each strategy is sized so its worst historical fall is 20%, which makes them comparable. Backtests use today’s index members, so older years read optimistically.')));
  for (const eq of R.equity || []) {
    root.append(h('section', null, sectionHead(eq.title, eq.note),
      lineChart({ series: [{ name: 'Equity', values: eq.y, color: 'var(--s1)' }], x: eq.x, height: 230, scale: eq.log ? 'log' : 'linear', area: true, yFmt: (v) => fmt.compact(v), xFmt: (d, tip) => (tip ? fmt.date(d) : String(d).slice(0, 4)), label: eq.title })));
  }
  for (const yr of R.yearly || []) {
    root.append(h('section', null, sectionHead(yr.title, yr.note),
      columns({ labels: yr.years.map((y) => String(y).slice(2)), series: [{ name: yr.label || 'Return', values: yr.values, color: 'var(--s1)' }], signColor: true, height: 190, yFmt: (v) => fmt.num(v, 0) + (yr.unit || ''), label: yr.title })));
  }
  if (R.tables) for (const t of R.tables) root.append(h('section', null, sectionHead(t.title, t.note), dataTable(t.columns.map((c, i) => ({ label: c, align: typeof t.rows[0]?.[i] === 'number' ? 'r' : '', render: (r) => cell(r[i]) })), t.rows, { compact: true })));
  if (!root.childNodes.length) root.append(h('div', { class: 'empty' }, 'No results in the bundle yet.'));
  return root;
}

// ------------------------------------------------------------------ automation
function automation(b) {
  const A = b.automation || {};
  const root = h('div', { class: 'stack', style: { '--gap': '32px' } });
  if (A.schedule?.length) root.append(h('section', null, sectionHead('Daily schedule', A.timezone || ''),
    h('div', { class: 'sched' }, A.schedule.map((s) => h('div', { class: 's' }, h('div', { class: 'tm' }, s.time), h('div', { class: 'grow' }, h('div', { style: { fontWeight: 600 } }, s.title), h('div', { class: 'small soft' }, s.detail)), s.tag ? badge(s.tag, 'outline') : null)))));
  for (const f of A.flows || []) {
    root.append(h('section', null, sectionHead(f.title, f.file), f.intro ? h('p', { class: 'soft small', style: { maxWidth: '64ch' } }, f.intro) : null,
      h('div', { class: 'flow' }, f.steps.map((st) => h('div', { class: 'step' }, h('h4', null, st.title), h('div', { class: 'small soft' }, st.detail), st.code ? h('code', null, st.code) : null)))));
  }
  if (A.files?.length) root.append(h('section', null, sectionHead('Your .bat files, in plain words'), dataTable([
    { label: 'File', render: (r) => h('div', null, h('code', null, r.file), h('div', { class: 'tiny muted', style: { marginTop: '3px' } }, r.folder)) },
    { label: 'What it does', render: (r) => r.does },
  ], A.files)));
  if (A.website?.length) root.append(h('section', null, sectionHead('How this website stays up to date'), h('div', { class: 'flow' }, A.website.map((st) => h('div', { class: 'step' }, h('h4', null, st.title), h('div', { class: 'small soft' }, st.detail))))));
  return root;
}

// ------------------------------------------------------------------ library
const KIND_ICON = { doc: 'doc', table: 'table', image: 'image', report: 'filing', text: 'doc' };
function libRow(it) {
  return h('a', { class: 'lrow', href: `#/technical/library/${encodeURIComponent(it.id)}`, style: { minHeight: '60px' } },
    h('div', { class: 'ic', style: { width: '36px', height: '36px', borderRadius: '10px', display: 'grid', placeItems: 'center', background: 'var(--surface-2)', color: 'var(--ink-2)', flex: 'none' } }, icon(KIND_ICON[it.kind] || 'doc')),
    h('div', { class: 'who' }, h('div', { style: { fontWeight: 500 } }, it.title), h('div', { class: 'tiny muted ell' }, [it.source, it.mtime ? fmt.date(it.mtime) : null].filter(Boolean).join(', '))),
    badge(it.kind === 'doc' ? 'Document' : it.kind === 'table' ? 'Table' : it.kind === 'image' ? 'Image' : it.kind === 'report' ? 'Report' : 'Text', 'outline'));
}
function library(b) {
  const items = b.library || [];
  const root = h('div');
  root.append(h('div', { class: 'banner' }, icon('info'), h('div', null, h('b', null, 'Add more here any time. '), 'Drop Markdown, CSV, Excel, text, HTML or image files into the technical_uploads folder in your project, then run PUBLISH.bat. They show up in this list on your phone.')));
  let kind = 'all';
  const box = h('div', { class: 'ledger' });
  const paint = () => { const f = items.filter((i) => kind === 'all' || i.kind === kind); box.replaceChildren(...f.map(libRow)); if (!f.length) box.append(h('div', { class: 'empty' }, 'Nothing here yet.')); };
  const kinds = [...new Set(items.map((i) => i.kind))];
  root.append(chipGroup([{ id: 'all', label: 'All', count: items.length }, ...kinds.map((k) => ({ id: k, label: { doc: 'Documents', table: 'Tables', image: 'Images', report: 'Reports', text: 'Text' }[k] || k, count: items.filter((i) => i.kind === k).length }))], kind, (v) => { kind = v; paint(); }), box);
  paint();
  return root;
}
function libraryItem(b, id) {
  const it = (b.library || []).find((x) => x.id === id);
  const root = h('div', { class: 'stack', style: { '--gap': '18px' } }, h('a', { class: 'back', href: '#/technical/library' }, icon('back'), 'Library'));
  if (!it) { root.append(h('div', { class: 'empty' }, 'Item not found.')); return root; }
  root.append(h('div', null, h('h2', null, it.title), h('div', { class: 'tiny muted', style: { marginTop: '4px' } }, [it.source, it.mtime ? 'saved ' + fmt.date(it.mtime) : null].filter(Boolean).join(', '))));
  if (it.kind === 'doc') root.append(renderMarkdown(it.md));
  else if (it.kind === 'text') root.append(h('pre', { class: 'txt' }, it.text));
  else if (it.kind === 'report') root.append(h('iframe', { class: 'report-frame', sandbox: '', srcdoc: it.html, title: it.title }));
  else if (it.kind === 'image') root.append(h('div', { class: 'imgbox' }, h('img', { src: `data:${it.mime};base64,${it.b64}`, alt: it.title })));
  else if (it.kind === 'table') {
    for (const sh of it.sheets || []) {
      root.append(h('section', null, h('div', { class: 'row between', style: { marginBottom: '6px' } }, h('h3', null, sh.name), h('span', { class: 'tiny muted' }, sh.total_rows > sh.rows.length ? `first ${sh.rows.length} of ${fmt.int(sh.total_rows)} rows` : `${fmt.int(sh.total_rows)} rows`)),
        dataTable(sh.columns.map((c, i) => ({ label: c, align: typeof sh.rows.find((r) => r[i] != null)?.[i] === 'number' ? 'r' : '', render: (r) => cell(r[i]) })), sh.rows, { compact: true })));
    }
  }
  return root;
}
