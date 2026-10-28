import { h, icon, fmt, badge, lensRow, lensBadge, extLink, toDate, sum } from '../lib/dom.js';
import { D, loadBoard } from '../lib/data.js';
import { lineChart, columns, legend, stackBar, rangeBar, sparkline } from '../lib/charts.js';
import { tabsBar, segmented, kvGrid, feedItem, chipGroup, dataTable, sectionHead, lensExplainer } from '../lib/ui.js';

const TABS = [
  { id: 'overview', label: 'Overview' },
  { id: 'activity', label: 'Activity' },
  { id: 'earnings', label: 'Earnings' },
  { id: 'analysts', label: 'Analysts' },
  { id: 'insiders', label: 'Insiders' },
  { id: 'filings', label: 'Filings' },
  { id: 'news', label: 'News' },
];

export async function renderCompany(ctx, sym, tab) {
  const [co, board] = await Promise.all([D.company(sym), loadBoard()]);
  const row = board.rows.find((r) => r.symbol === sym) || null;
  const root = h('div');
  root.append(h('a', { class: 'back', href: '#/fundamentals' }, icon('back'), 'Fundamentals'));
  if (!co) {
    root.append(h('div', { class: 'empty', style: { marginTop: '16px' } }, h('b', null, `No data for ${sym} yet`), 'It will appear after the next automatic update. Check that the symbol is listed in config/watchlist.json.'));
    return root;
  }
  ctx.setTitle(`${co.symbol} ${co.name || ''}`);
  const ccy = co.currency || (co.market === 'IN' ? 'INR' : 'USD');
  const p = co.price || {};
  const head = h('div', { class: 'co-head' },
    h('div', null,
      h('h1', null, co.symbol.replace(/\.NS$/, '')),
      h('div', { class: 'soft' }, co.name),
      h('div', { class: 'tiny muted', style: { marginTop: '2px' } }, [co.exchange, co.sector, co.industry].filter(Boolean).join(', '))),
    h('div', { class: 'right' },
      h('div', { class: 'price' }, fmt.money(p.last, ccy)),
      h('div', { class: 'chg ' + fmt.dir(p.change_pct) }, `${fmt.arrow(p.change_pct)} ${fmt.signed(p.change)} (${fmt.pct(p.change_pct)})`),
      extHours(p, ccy)));
  root.append(head);
  if (row) {
    root.append(h('button', { class: 'row', style: { gap: '10px', margin: '2px 0 10px', textAlign: 'left' }, onClick: lensExplainer, 'aria-label': 'How the lenses are scored' },
      lensRow(row.lens), h('span', { class: 'tiny muted' }, lensSummary(row))));
  }
  const body = h('div', { style: { marginTop: '4px' } });
  const show = (id) => {
    history.replaceState(null, '', `#/fundamentals/${encodeURIComponent(sym)}${id === 'overview' ? '' : '/' + id}`);
    body.replaceChildren(TAB_FN[id](co, { ccy, row, ctx }));
  };
  root.append(tabsBar(TABS, TABS.some((t) => t.id === tab) ? tab : 'overview', show), h('div', { style: { height: '16px' } }), body);
  show(TABS.some((t) => t.id === tab) ? tab : 'overview');
  if (co.demo) root.append(h('p', { class: 'muted tiny', style: { marginTop: '24px' } }, 'Sample data.'));
  return root;
}

function lensSummary(row) {
  const bits = [];
  if (row.lens?.F_why) bits.push(row.lens.F_why);
  if (row.lens?.T_why) bits.push(row.lens.T_why);
  if (row.lens?.S_why) bits.push(row.lens.S_why);
  return bits.join('; ') || 'Tap to see how the lenses are scored';
}

function extHours(p, ccy) {
  const items = [];
  if (p.pre != null) items.push(`Pre-market ${fmt.money(p.pre, ccy)}`);
  if (p.post != null) items.push(`After hours ${fmt.money(p.post, ccy)}`);
  return items.length ? h('div', { class: 'ah' }, items.join(', ')) : null;
}

// ---------------- overview ----------------
function overview(co, { ccy, row }) {
  const p = co.price || {}, st = co.stats || {};
  const wrap = h('div', { class: 'stack', style: { '--gap': '26px' } });
  const hist = co.history;
  if (hist?.dates?.length > 2) {
    const ranges = [{ id: '1M', n: 21 }, { id: '3M', n: 63 }, { id: '6M', n: 126 }, { id: '1Y', n: 260 }];
    const box = h('div');
    let cur = '6M';
    const draw = () => {
      const n = ranges.find((r) => r.id === cur).n;
      const dates = hist.dates.slice(-n), close = hist.close.slice(-n);
      const up = close[close.length - 1] >= close[0];
      const chg = ((close[close.length - 1] / close[0]) - 1) * 100;
      box.replaceChildren(
        h('div', { class: 'row between', style: { marginBottom: '6px' } },
          h('span', { class: 'small ' + (up ? 'up' : 'down') }, `${fmt.pct(chg, 1)} over ${cur}`),
          segmented(ranges.map((r) => ({ id: r.id, label: r.id })), cur, (v) => { cur = v; draw(); }, 'Chart range')),
        lineChart({ series: [{ name: 'Close', values: close, color: 'var(--s1)' }], x: dates, height: 230, area: true,
          yFmt: (v, tip) => (tip ? fmt.money(v, ccy) : fmt.num(v, v >= 1000 ? 0 : v >= 100 ? 0 : 1)),
          xFmt: (d, tip) => (tip ? fmt.date(d) : (n > 126 ? fmt.monthYear(d) : fmt.shortDate(d))), label: `${co.symbol} closing price, ${cur}` }));
    };
    draw();
    wrap.append(box);
  }
  if (p.wk52_low != null && p.wk52_high != null) {
    wrap.append(h('div', null, h('h3', { style: { marginBottom: '2px' } }, '52-week range'),
      rangeBar({ min: p.wk52_low, max: p.wk52_high, from: p.wk52_low, to: p.last, marks: [{ v: p.last, label: 'Now' }], fmtv: (v) => fmt.money(v, ccy) })));
  }
  const nextE = co.earnings?.next;
  const figs = h('div', { class: 'figs' });
  figs.append(
    fig('Market value', fmt.moneyC(p.market_cap, ccy)),
    fig('P/E (trailing)', fmt.num(st.pe_trailing, 1), st.pe_forward != null ? `${fmt.num(st.pe_forward, 1)} forward` : ''),
    fig('Next earnings', nextE?.date ? fmt.shortDate(nextE.date) : '—', nextE?.date ? (fmt.daysUntil(nextE.date) === 0 ? 'today' : `in ${fmt.daysUntil(nextE.date)} days`) : ''),
    fig('Analyst view', co.analysts?.rating_label || '—', co.analysts?.target?.mean ? `Target ${fmt.money(co.analysts.target.mean, ccy, 0)}` : ''));
  wrap.append(figs);
  wrap.append(h('div', null, h('h3', { style: { marginBottom: '8px' } }, 'Key numbers'), kvGrid([
    ['Day range', p.day_low != null ? `${fmt.num(p.day_low)} – ${fmt.num(p.day_high)}` : '—'],
    ['Volume', `${fmt.compact(p.volume)}${p.avg_volume ? ` (avg ${fmt.compact(p.avg_volume)})` : ''}`],
    ['EPS (trailing)', fmt.num(st.eps_ttm)],
    ['EPS (forward)', fmt.num(st.eps_fwd)],
    ['Dividend yield', st.div_yield != null ? fmt.pct(st.div_yield, 2, false) : '—'],
    ['Beta', fmt.num(st.beta)],
    ['Revenue growth', st.revenue_growth != null ? fmt.pct(st.revenue_growth, 1) : '—', fmt.dir(st.revenue_growth)],
    ['Profit margin', st.profit_margin != null ? fmt.pct(st.profit_margin, 1, false) : '—'],
    ['Return on equity', st.roe != null ? fmt.pct(st.roe, 1, false) : '—'],
    ['Debt to equity', fmt.num(st.debt_equity, 0)],
    ['Short interest', st.short_pct_float != null ? `${fmt.pct(st.short_pct_float, 1, false)} of float` : '—'],
    ['Held by insiders', st.held_insiders_pct != null ? fmt.pct(st.held_insiders_pct, 1, false) : '—'],
  ])));
  if (co.about) wrap.append(h('div', null, h('h3', { style: { marginBottom: '6px' } }, 'About'), h('p', { class: 'soft', style: { maxWidth: '70ch' } }, co.about), co.website ? extLink(co.website.replace(/^https?:\/\//, ''), co.website, 'small muted') : null));
  return wrap;
}
function fig(label, value, delta) {
  return h('div', { class: 'fig' }, h('div', { class: 'v' }, value), h('div', { class: 'l' }, label), delta ? h('div', { class: 'd muted' }, delta) : null);
}

// ---------------- activity (everything, newest first) ----------------
function buildEvents(co) {
  const ev = [];
  for (const n of co.news || []) ev.push({ type: 'news', ts: n.ts, day: (n.ts || '').slice(0, 10), title: n.title, sub: n.source, url: n.url });
  for (const f of co.filings || []) ev.push({ type: 'filing', date: f.date, day: f.date, title: `${f.form}${f.desc ? ': ' + f.desc : ''}`, sub: f.items || '', url: f.url });
  for (const t of co.insiders?.transactions || []) {
    const buy = t.type === 'buy', sell = t.type === 'sell';
    ev.push({ type: 'insider', date: t.date, day: t.date, tone: buy ? 'gain' : sell ? 'loss' : '', url: t.url,
      title: `${t.name} ${buy ? 'bought' : sell ? 'sold' : (t.type_label || 'filed').toLowerCase()} ${fmt.compact(t.shares, 1)} shares${t.price ? ' at ' + fmt.money(t.price) : ''}`,
      sub: [t.title, t.value ? fmt.moneyC(t.value) : ''].filter(Boolean).join(', ') });
  }
  for (const e of co.earnings?.history || []) if (e.eps_actual != null) ev.push({ type: 'earnings', date: e.date, day: e.date, tone: e.surprise_pct > 0 ? 'gain' : e.surprise_pct < 0 ? 'loss' : 'accent',
    title: `Reported EPS ${fmt.num(e.eps_actual)} against ${fmt.num(e.eps_est)} expected${e.surprise_pct != null ? ` (${e.surprise_pct > 0 ? 'beat' : 'missed'} by ${fmt.pct(Math.abs(e.surprise_pct), 1, false)})` : ''}` });
  if (co.earnings?.next?.date) ev.push({ type: 'earnings', date: co.earnings.next.date, day: co.earnings.next.date, tone: 'accent', title: `Next earnings report${co.earnings.next.eps_est != null ? `, EPS estimate ${fmt.num(co.earnings.next.eps_est)}` : ''}`, future: true });
  for (const a of co.analysts?.changes || []) ev.push({ type: 'analyst', date: a.date, day: a.date, tone: /up/i.test(a.action) ? 'gain' : /down/i.test(a.action) ? 'loss' : '', title: `${a.firm}: ${a.action}${a.from ? ` from ${a.from}` : ''}${a.to ? ` to ${a.to}` : ''}` });
  for (const d of co.actions?.dividends || []) ev.push({ type: 'dividend', date: d.date, day: d.date, title: `Dividend ${fmt.num(d.amount, 3)} per share` });
  for (const s of co.actions?.splits || []) ev.push({ type: 'split', date: s.date, day: s.date, title: `Stock split ${s.ratio}` });
  return ev.filter((e) => e.day).sort((a, b) => (b.ts || b.date || '').localeCompare(a.ts || a.date || ''));
}
function activity(co) {
  const all = buildEvents(co);
  const kinds = [['all', 'Everything'], ['news', 'News'], ['filing', 'Filings'], ['insider', 'Insiders'], ['earnings', 'Earnings'], ['analyst', 'Analysts'], ['dividend', 'Dividends']];
  const box = h('div', { class: 'feed' });
  let f = 'all';
  const paint = () => {
    const items = all.filter((e) => f === 'all' || e.type === f || (f === 'dividend' && e.type === 'split')).slice(0, 150);
    const nodes = []; let cur = '';
    for (const it of items) {
      if (it.day !== cur) { cur = it.day; nodes.push(h('div', { class: 'daysep' }, (it.future ? 'Upcoming: ' : '') + fmt.weekday(cur))); }
      nodes.push(feedItem(it));
    }
    box.replaceChildren(...nodes);
    if (!items.length) box.append(h('div', { class: 'empty' }, 'Nothing of this type yet.'));
  };
  const wrap = h('div', null,
    h('p', { class: 'soft small', style: { margin: '0 0 8px' } }, 'Every news item, filing, insider trade, earnings report, analyst change and dividend for this company, newest first.'),
    chipGroup(kinds.map(([id, label]) => ({ id, label, count: id === 'all' ? all.length : all.filter((e) => e.type === id || (id === 'dividend' && e.type === 'split')).length })).filter((k) => k.id === 'all' || k.count), f, (v) => { f = v; paint(); }),
    box);
  paint();
  return wrap;
}

// ---------------- earnings ----------------
function earnings(co, { ccy }) {
  const e = co.earnings || {};
  const wrap = h('div', { class: 'stack', style: { '--gap': '26px' } });
  if (e.next?.date) {
    const d = fmt.daysUntil(e.next.date);
    wrap.append(h('div', { class: 'panel' }, h('div', { class: 'figs' },
      fig('Next report', fmt.date(e.next.date), d === 0 ? 'today' : d > 0 ? `in ${d} days` : `${-d} days ago`),
      fig('EPS estimate', fmt.num(e.next.eps_est)),
      e.next.rev_est != null ? fig('Revenue estimate', fmt.moneyC(e.next.rev_est, ccy)) : null)));
  }
  const hist = (e.history || []).filter((x) => x.eps_actual != null || x.eps_est != null).slice(0, 12).reverse();
  if (hist.length) {
    wrap.append(h('div', null, h('h3', { style: { marginBottom: '8px' } }, 'Earnings per share: estimate and actual'),
      columns({ labels: hist.map((x) => fmt.monthYear(x.date)), series: [{ name: 'Estimate', values: hist.map((x) => x.eps_est), color: 'var(--s1)', faded: true }, { name: 'Actual', values: hist.map((x) => x.eps_actual), color: 'var(--s1)' }], yFmt: (v) => fmt.num(v, 2), label: 'EPS estimate versus actual' }),
      legend([{ label: 'Estimate', color: 'var(--s1)', sq: true }, { label: 'Actual', color: 'var(--s1)', sq: true }]),
      h('div', { style: { marginTop: '14px' } }, dataTable([
        { label: 'Reported', render: (r) => fmt.date(r.date), nw: true },
        { label: 'Estimate', align: 'r', render: (r) => fmt.num(r.eps_est) },
        { label: 'Actual', align: 'r', render: (r) => fmt.num(r.eps_actual) },
        { label: 'Surprise', align: 'r', render: (r) => (r.surprise_pct == null ? '—' : h('span', { class: fmt.dir(r.surprise_pct) }, fmt.pct(r.surprise_pct, 1))) },
      ], hist.slice().reverse())), ));
  }
  const q = (e.quarters || []).slice(0, 8).reverse();
  if (q.length) {
    wrap.append(h('div', null, h('h3', { style: { marginBottom: '8px' } }, 'Revenue and profit by quarter'),
      columns({ labels: q.map((x) => fmt.monthYear(x.period)), series: [{ name: 'Revenue', values: q.map((x) => x.revenue), color: 'var(--s1)' }, { name: 'Net income', values: q.map((x) => x.net_income), color: 'var(--s3)' }], yFmt: (v) => fmt.moneyC(v, ccy), label: 'Quarterly revenue and net income' }),
      legend([{ label: 'Revenue', color: 'var(--s1)', sq: true }, { label: 'Net income', color: 'var(--s3)', sq: true }]),
      h('div', { style: { marginTop: '14px' } }, dataTable([
        { label: 'Quarter ending', render: (r) => fmt.date(r.period), nw: true },
        { label: 'Revenue', align: 'r', render: (r) => fmt.moneyC(r.revenue, ccy) },
        { label: 'Net income', align: 'r', render: (r) => fmt.moneyC(r.net_income, ccy) },
        { label: 'Margin', align: 'r', render: (r) => (r.revenue && r.net_income != null ? fmt.pct((r.net_income / r.revenue) * 100, 1, false) : '—') },
      ], q.slice().reverse()))));
  }
  if (wrap.childNodes.length === 0) wrap.append(h('div', { class: 'empty' }, 'No earnings data for this company yet.'));
  return wrap;
}

// ---------------- analysts ----------------
function analysts(co, { ccy }) {
  const a = co.analysts || {};
  const wrap = h('div', { class: 'stack', style: { '--gap': '26px' } });
  const c = a.counts;
  if (c && sum(Object.values(c)) > 0) {
    wrap.append(h('div', null,
      h('div', { class: 'row between', style: { marginBottom: '10px' } }, h('h3', null, 'What analysts say'), a.rating_label ? badge(a.rating_label, a.mean_score <= 2.2 ? 'gain' : a.mean_score >= 3.2 ? 'loss' : '') : null),
      stackBar([
        { label: 'Strong buy', value: c.strong_buy || 0, color: 'var(--gain)' },
        { label: 'Buy', value: c.buy || 0, color: 'color-mix(in srgb, var(--gain) 60%, var(--surface-3))' },
        { label: 'Hold', value: c.hold || 0, color: 'var(--flat)' },
        { label: 'Sell', value: c.sell || 0, color: 'color-mix(in srgb, var(--loss) 65%, var(--surface-3))' },
        { label: 'Strong sell', value: c.strong_sell || 0, color: 'var(--loss)' },
      ])));
  }
  const t = a.target;
  if (t && t.mean) {
    const lo = Math.min(t.low ?? t.mean, t.current ?? t.mean), hi = Math.max(t.high ?? t.mean, t.current ?? t.mean);
    const up = t.current ? ((t.mean / t.current) - 1) * 100 : null;
    wrap.append(h('div', null,
      h('div', { class: 'row between', style: { marginBottom: '2px' } }, h('h3', null, 'Price target'), up != null ? h('span', { class: 'small ' + fmt.dir(up) }, `${fmt.pct(up, 1)} to average`) : null),
      rangeBar({ min: lo * 0.97, max: hi * 1.03, from: t.low, to: t.high, marks: [{ v: t.low ?? t.mean, label: 'Low' }, { v: t.mean, label: 'Average', kind: 'm', above: true }, { v: t.high ?? t.mean, label: 'High' }, ...(t.current ? [{ v: t.current, label: 'Now', above: true }] : [])].filter((m) => m.v != null), fmtv: (v) => fmt.money(v, ccy, 0) }),
      h('p', { class: 'muted tiny', style: { marginTop: '4px' } }, t.n ? `Based on ${t.n} analysts.` : '')));
  }
  if (a.changes?.length) {
    wrap.append(h('div', null, h('h3', { style: { marginBottom: '8px' } }, 'Recent rating changes'), dataTable([
      { label: 'Date', render: (r) => fmt.shortDate(r.date), nw: true },
      { label: 'Firm', render: (r) => r.firm },
      { label: 'Action', render: (r) => badge(r.action, /up|init/i.test(r.action) ? 'gain' : /down/i.test(r.action) ? 'loss' : '') },
      { label: 'Rating', render: (r) => (r.from && r.to ? `${r.from} to ${r.to}` : r.to || '—') },
    ], a.changes.slice(0, 15))));
  }
  if (!wrap.childNodes.length) wrap.append(h('div', { class: 'empty' }, 'No analyst coverage in the data yet.'));
  return wrap;
}

// ---------------- insiders & holders ----------------
const TYPE_BADGE = { buy: ['Buy', 'gain'], sell: ['Sell', 'loss'] };
function insiders(co, { ccy }) {
  const ins = co.insiders || {};
  const sm = ins.summary || {};
  const wrap = h('div', { class: 'stack', style: { '--gap': '26px' } });
  if (co.market === 'IN') wrap.append(h('div', { class: 'banner' }, icon('info'), h('div', null, 'SEC Form 4 filings only cover US-listed companies. For Indian stocks this page shows the holder data Yahoo Finance provides.')));
  if (ins.transactions?.length || sm.buys_90d != null) {
    wrap.append(h('div', null, h('h3', { style: { marginBottom: '10px' } }, 'Insider trading, last 90 days'),
      h('div', { class: 'figs' },
        fig('Purchases', String(sm.buys_90d ?? 0), sm.buy_value ? fmt.moneyC(sm.buy_value, ccy) : ''),
        fig('Sales', String(sm.sells_90d ?? 0), sm.sell_value ? fmt.moneyC(sm.sell_value, ccy) : ''),
        h('div', { class: 'fig' }, h('div', { class: 'v ' + fmt.dir(sm.net_value) }, (sm.net_value > 0 ? '+' : sm.net_value < 0 ? '−' : '') + fmt.moneyC(Math.abs(sm.net_value || 0), ccy)), h('div', { class: 'l' }, 'Net bought or sold')))));
    if (ins.transactions?.length) {
      wrap.append(h('div', null, h('h3', { style: { marginBottom: '8px' } }, 'Transactions'), dataTable([
        { label: 'Date', render: (r) => fmt.shortDate(r.date), nw: true },
        { label: 'Insider', render: (r) => h('div', null, h('div', { style: { fontWeight: 500 } }, r.name), h('div', { class: 'tiny muted' }, r.title || '')) },
        { label: 'Type', render: (r) => { const b = TYPE_BADGE[r.type]; return badge(b ? b[0] : (r.type_label || 'Other'), b ? b[1] : 'outline'); } },
        { label: 'Shares', align: 'r', render: (r) => fmt.int(r.shares) },
        { label: 'Price', align: 'r', render: (r) => (r.price ? fmt.money(r.price, ccy) : '—') },
        { label: 'Value', align: 'r', render: (r) => (r.value ? fmt.moneyC(r.value, ccy) : '—') },
        { label: 'Owns after', align: 'r', render: (r) => fmt.compact(r.owned_after) },
        { label: '', render: (r) => (r.url ? extLink(icon('ext'), r.url, 'icon-btn') : '') },
      ], ins.transactions.slice(0, 40)), h('p', { class: 'muted tiny', style: { marginTop: '8px' } }, 'Source: SEC EDGAR Form 4. Awards, option exercises and tax withholding are shown but are not counted as buying or selling.')));
    }
  }
  const hd = co.holders;
  if (hd) {
    const m = hd.major || {};
    if (m.insiders_pct != null && m.institutions_pct != null) {
      const other = Math.max(0, 100 - m.insiders_pct - m.institutions_pct);
      wrap.append(h('div', null, h('h3', { style: { marginBottom: '10px' } }, 'Who owns the shares'),
        stackBar([{ label: 'Insiders', value: +m.insiders_pct.toFixed(1), color: 'var(--s2)' }, { label: 'Institutions', value: +m.institutions_pct.toFixed(1), color: 'var(--s1)' }, { label: 'Everyone else', value: +other.toFixed(1), color: 'var(--surface-3)' }])));
    }
    if (hd.institutions?.length) {
      wrap.append(h('div', null, h('h3', { style: { marginBottom: '8px' } }, 'Largest institutional holders'), dataTable([
        { label: 'Holder', render: (r) => r.name },
        { label: 'Held', align: 'r', render: (r) => (r.pct != null ? fmt.pct(r.pct, 2, false) : '—') },
        { label: 'Shares', align: 'r', render: (r) => fmt.compact(r.shares) },
        { label: 'Change', align: 'r', render: (r) => (r.change_pct == null ? '—' : h('span', { class: fmt.dir(r.change_pct) }, fmt.pct(r.change_pct, 1))) },
        { label: 'As of', render: (r) => fmt.shortDate(r.date), nw: true },
      ], hd.institutions.slice(0, 12)), h('p', { class: 'muted tiny', style: { marginTop: '8px' } }, 'Institutions report holdings quarterly on 13F filings, so these figures are up to 45 days old when published.')));
    }
  }
  if (!wrap.querySelector('h3')) wrap.append(h('div', { class: 'empty' }, 'No insider or holder data in the data yet.'));
  return wrap;
}

// ---------------- filings / news ----------------
function filings(co) {
  const f = co.filings || [];
  if (!f.length) return h('div', { class: 'empty' }, co.market === 'IN' ? 'SEC filings only exist for US-listed companies.' : 'No filings in the data yet.');
  return h('div', { class: 'feed' }, f.slice(0, 80).map((x) => feedItem({ type: 'filing', date: x.date, url: x.url, title: `${x.form}${x.desc ? ': ' + x.desc : ''}`, sub: x.items || '' })));
}
function news(co) {
  const n = co.news || [];
  if (!n.length) return h('div', { class: 'empty' }, 'No headlines in the data yet.');
  return h('div', { class: 'feed' }, n.slice(0, 60).map((x) => feedItem({ type: 'news', ts: x.ts, url: x.url, title: x.title, sub: x.source })));
}

const TAB_FN = { overview, activity, earnings, analysts, insiders, filings, news };
