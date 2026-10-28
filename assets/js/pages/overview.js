import { h, icon, fmt, lensRow, badge, toDate } from '../lib/dom.js';
import { loadBoard, D } from '../lib/data.js';
import { pageHead, sectionHead, companyRow, chipGroup, segmented, feedItem, lensExplainer, noDataPanel } from '../lib/ui.js';
import { sparkline } from '../lib/charts.js';

function tally(rows, key) {
  let b = 0, n = 0, r = 0, none = 0;
  for (const x of rows) { const v = x.lens?.[key]; if (v === 1) b++; else if (v === -1) r++; else if (v === 0) n++; else none++; }
  return { b, n, r, none, total: b + n + r };
}

function triCard({ letter, title, href, fact, t }) {
  const bar = h('div', { class: 'split', role: 'img', 'aria-label': `${t.b} bullish, ${t.n} neutral, ${t.r} bearish` },
    t.b ? h('i', { class: 'b', style: { flexGrow: t.b } }) : null,
    t.n ? h('i', { class: 'n', style: { flexGrow: t.n } }) : null,
    t.r ? h('i', { class: 'r', style: { flexGrow: t.r } }) : null,
    !t.total ? h('i', { class: 'n', style: { flexGrow: 1, opacity: 0.25 } }) : null);
  return h('a', { class: 'tri', href },
    h('span', { class: 'letter', 'aria-hidden': 'true' }, letter),
    h('h3', null, title),
    h('div', { class: 'fact' }, fact),
    bar,
    h('div', { class: 'split-legend' },
      h('span', { class: 'up' }, h('b', null, t.b), ' bullish'),
      h('span', null, h('b', null, t.n), ' neutral'),
      h('span', { class: 'down' }, h('b', null, t.r), ' bearish')));
}

export async function render() {
  const [{ rows, market, sent, sig }, feed] = await Promise.all([loadBoard(), D.feed()]);
  const root = h('div');
  root.append(pageHead('Today', 'Your watchlist through three lenses: what the company reports, what your scanners see, and what the crowd says.',
    h('button', { class: 'btn', onClick: lensExplainer, 'aria-label': 'How the lenses work' }, icon('info'), 'Lenses')));

  if (!rows.length) { root.append(noDataPanel()); return root; }

  // ----- triptych -----
  const tf = tally(rows, 'F'), tt = tally(rows, 'T'), ts = tally(rows, 'S');
  const soon = (feed?.earnings || []).filter((e) => { const d = fmt.daysUntil(e.date); return d != null && d >= 0 && d <= 7; });
  const sigCount = sig?.summary || {};
  const sMark = sent?.market;
  root.append(h('div', { class: 'triptych' },
    triCard({ letter: 'F', title: 'Fundamentals', href: '#/fundamentals', t: tf,
      fact: soon.length ? `${soon.length} earnings report${soon.length > 1 ? 's' : ''} in the next 7 days.` : 'No earnings reports in the next 7 days.' }),
    triCard({ letter: 'T', title: 'Technical', href: '#/technical', t: tt,
      fact: sigCount.buys != null ? `${sigCount.buys} scanner buy${sigCount.buys === 1 ? '' : 's'}, ${sigCount.watch ?? 0} on watch (${fmt.shortDate(sig.asof)}).` : 'Open for strategies, backtests and the latest scans.' }),
    triCard({ letter: 'S', title: 'Sentiment', href: '#/sentiment', t: ts,
      fact: sMark && typeof sMark.score === 'number' ? `Crowd mood ${fmt.signed(sMark.score, 0)} across ${fmt.compact(sMark.mentions)} mentions.` : 'Waiting for the first sentiment run.' })));

  // ----- indices -----
  if (market?.indices?.length) {
    root.append(h('div', { class: 'section', style: { marginTop: '22px' } },
      h('div', { class: 'strip', role: 'list', 'aria-label': 'Market indices' }, market.indices.map((ix) =>
        h('div', { class: 'ix', role: 'listitem' },
          h('div', { class: 'n' }, ix.name),
          h('div', { class: 'v' }, fmt.num(ix.price, ix.price > 1000 ? 0 : 2)),
          h('div', { class: 'c ' + fmt.dir(ix.change_pct) }, `${fmt.arrow(ix.change_pct)} ${fmt.pct(ix.change_pct)}`))))));
  }

  // ----- watchlist -----
  const listBox = h('div', { class: 'ledger' });
  let mk = 'ALL', sort = 'agree';
  const agree = (r) => ['F', 'T', 'S'].reduce((a, k) => a + (r.lens?.[k] === 1 ? 1 : r.lens?.[k] === -1 ? -1 : 0), 0);
  const sorters = {
    agree: (a, b) => agree(b) - agree(a) || (b.change_pct ?? 0) - (a.change_pct ?? 0),
    move: (a, b) => (b.change_pct ?? -99) - (a.change_pct ?? -99),
    loss: (a, b) => (a.change_pct ?? 99) - (b.change_pct ?? 99),
    az: (a, b) => a.symbol.localeCompare(b.symbol),
  };
  function paint() {
    const list = rows.filter((r) => mk === 'ALL' || r.market === mk).sort(sorters[sort]);
    listBox.replaceChildren(...list.map((r) => companyRow(r)));
    if (!list.length) listBox.append(h('div', { class: 'empty' }, 'No companies in this market yet.'));
  }
  const hasIN = rows.some((r) => r.market === 'IN'), hasUS = rows.some((r) => r.market === 'US');
  const mkOpts = [{ id: 'ALL', label: 'All', count: rows.length }];
  if (hasUS) mkOpts.push({ id: 'US', label: 'US', count: rows.filter((r) => r.market === 'US').length });
  if (hasIN) mkOpts.push({ id: 'IN', label: 'India', count: rows.filter((r) => r.market === 'IN').length });
  root.append(h('section', { class: 'section' },
    sectionHead('Watchlist', `${rows.length} companies`),
    h('div', { class: 'row between wrap', style: { gap: '10px 14px', marginBottom: '6px' } },
      mkOpts.length > 2 ? chipGroup(mkOpts, mk, (v) => { mk = v; paint(); }) : h('span'),
      segmented([{ id: 'agree', label: 'Lens agreement' }, { id: 'move', label: 'Top movers' }, { id: 'loss', label: 'Biggest drops' }, { id: 'az', label: 'A–Z' }], sort, (v) => { sort = v; paint(); }, 'Sort')),
    listBox));
  paint();

  // ----- this week + insiders -----
  const grid = h('div', { class: 'two even section' });
  const upcoming = (feed?.earnings || []).filter((e) => { const d = fmt.daysUntil(e.date); return d != null && d >= 0; }).sort((a, b) => a.date.localeCompare(b.date)).slice(0, 7);
  grid.append(h('section', null, sectionHead('Earnings coming up'),
    upcoming.length ? h('div', { class: 'ledger' }, upcoming.map((e) => {
      const d = fmt.daysUntil(e.date);
      return h('a', { class: 'lrow', href: `#/fundamentals/${encodeURIComponent(e.symbol)}/earnings`, style: { minHeight: '56px' } },
        h('div', { class: 'tnum', style: { width: '64px', flex: 'none' } }, h('div', { style: { fontWeight: 600 } }, fmt.shortDate(e.date)), h('div', { class: 'tiny muted' }, d === 0 ? 'today' : d === 1 ? 'tomorrow' : `in ${d} days`)),
        h('div', { class: 'who' }, h('div', { class: 'sym ell', style: { fontSize: '16px' } }, e.symbol.replace(/\.NS$/, '')), h('div', { class: 'name ell' }, e.name || '')),
        h('div', { class: 'right small' }, h('div', { class: 'muted' }, 'EPS estimate'), h('div', { class: 'num', style: { fontWeight: 600 } }, e.eps_est != null ? fmt.num(e.eps_est) : '—')));
    })) : h('div', { class: 'empty' }, 'No upcoming dates in the data yet.')));
  const ins = (feed?.insiders || []).slice(0, 7);
  grid.append(h('section', null, sectionHead('Insider desk', 'SEC Form 4'),
    ins.length ? h('div', { class: 'feed' }, ins.map((t) => feedItem(insiderToFeed(t), { showSymbol: true }))) : h('div', { class: 'empty' }, 'No insider trades in the data yet.')));
  root.append(grid);

  // ----- chatter -----
  const hot = (sent?.tickers || []).slice().sort((a, b) => (b.mentions || 0) - (a.mentions || 0)).slice(0, 5);
  if (hot.length) {
    root.append(h('section', { class: 'section' }, sectionHead('Most talked about', 'last 7 days'),
      h('div', { class: 'ledger' }, hot.map((t) => h('a', { class: 'lrow', href: `#/sentiment/${encodeURIComponent(t.symbol)}`, style: { minHeight: '56px' } },
        h('div', { class: 'who' }, h('div', { class: 'sym', style: { fontSize: '16px' } }, t.symbol.replace(/\.NS$/, '')), h('div', { class: 'name ell' }, `${fmt.int(t.mentions)} mentions`)),
        t.trend?.length > 2 ? sparkline(t.trend, { color: 'var(--s1)' }) : null,
        h('div', { class: 'px' }, h('div', { class: 'p ' + fmt.dir(t.score) }, fmt.signed(t.score, 0)), h('div', { class: 'c muted' }, t.label)))))));
  }
  return root;
}

export function insiderToFeed(t) {
  const buy = t.type === 'buy', sell = t.type === 'sell';
  const verb = buy ? 'bought' : sell ? 'sold' : (t.type_label || 'filed');
  const who = t.name || 'An insider';
  const shares = t.shares != null ? `${fmt.compact(t.shares, 1)} shares` : '';
  const price = t.price ? ` at ${fmt.money(t.price)}` : '';
  return {
    type: 'insider', symbol: t.symbol, date: t.date, url: t.url,
    tone: buy ? 'gain' : sell ? 'loss' : '',
    title: `${who} ${verb} ${shares}${price}`.replace(/\s+/g, ' ').trim(),
    sub: [t.title, t.value ? fmt.moneyC(t.value) : null].filter(Boolean).join(', '),
  };
}
