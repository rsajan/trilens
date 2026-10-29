import { h, icon, fmt, badge, lensRow, debounce, extLink } from '../lib/dom.js';
import { loadBoard, D } from '../lib/data.js';
import { pageHead, sectionHead, chipGroup, segmented, feedItem, noDataPanel, lensExplainer } from '../lib/ui.js';
import { insiderToFeed } from './overview.js';
import { listPins, togglePin, hrefFor } from '../lib/pins.js';

const VIEWS = [
  { id: 'companies', label: 'Companies' },
  { id: 'tape-earnings', label: 'Earnings' },
  { id: 'tape-insiders', label: 'Insiders' },
  { id: 'tape-filings', label: 'Filings' },
  { id: 'tape-news', label: 'News' },
];

export async function render(ctx) {
  const first = ctx.params[0];
  if (first === 'lookup') {
    const { renderLookup } = await import('./lookup.js');
    return renderLookup(ctx, ctx.params[1]);
  }
  if (first === 'india') {
    const { renderIndiaLookup } = await import('./lookup.js');
    return renderIndiaLookup(ctx, ctx.params[1]);
  }
  if (first && !first.startsWith('tape-')) {
    const { renderCompany } = await import('./company.js');
    return renderCompany(ctx, first, ctx.params[1] || 'overview');
  }
  ctx.setTitle('Fundamentals');
  const view = first || 'companies';
  const root = h('div');
  root.append(pageHead('Fundamentals', 'Earnings, analyst views, insider and institutional activity, filings and news for every company on your watchlist.'));
  root.append(segmented(VIEWS, view, (v) => { location.hash = v === 'companies' ? '#/fundamentals' : `#/fundamentals/${v}`; }, 'Fundamentals views'));
  const body = h('div', { style: { marginTop: '16px' } });
  root.append(body);
  if (view === 'companies') await companies(body);
  else await tape(body, view);
  return root;
}

// One universal-search block: loads its index on first real query, filters by symbol prefix
// or name match, excludes anything already on the watchlist, links to a lookup page.
function externalSearchBox({ title, sub, loadIndex, getSym, getName, linkFor, tagLabel }, inWatchlist) {
  const listEl = h('div', { class: 'ledger' });
  const box = h('div', { class: 'section', style: { marginTop: '18px', display: 'none' } }, sectionHead(title, sub), listEl);
  let rows = null;
  return {
    el: box,
    async paint(ql, stillCurrent) {
      if (!ql || ql.length < 2) { box.style.display = 'none'; return; }
      if (!rows) rows = (await loadIndex())?.rows || [];
      if (!stillCurrent()) return;
      const starts = [], has = [];
      for (const r of rows) {
        const sym = getSym(r);
        if (inWatchlist.has(sym.toUpperCase())) continue;
        const name = (getName(r) || '').toLowerCase();
        if (sym.toLowerCase().startsWith(ql)) starts.push(r);
        else if (name.includes(ql)) has.push(r);
        if (starts.length >= 30) break;
      }
      const matches = [...starts, ...has].slice(0, 12);
      box.style.display = matches.length ? '' : 'none';
      listEl.replaceChildren(...matches.map((r) => h('a', { class: 'lrow', href: linkFor(r) },
        h('div', { class: 'who' }, h('div', { class: 'sym ell' }, getSym(r)), h('div', { class: 'name ell' }, getName(r) || '')),
        h('span', { class: 'tiny muted', style: { flex: 'none' } }, tagLabel))));
    },
  };
}

function pinnedSection() {
  const pins = listPins();
  if (!pins.length) return null;
  const list = h('div', { class: 'ledger' });
  const box = h('div', { class: 'section', style: { marginBottom: '18px' } }, sectionHead('Pinned', 'saved on this device only'), list);
  const paint = () => {
    const cur = listPins();
    if (!cur.length) { box.remove(); return; }
    list.replaceChildren(...cur.map((p) => h('a', { class: 'lrow', href: hrefFor(p) },
      h('div', { class: 'who' }, h('div', { class: 'sym ell' }, p.sym), h('div', { class: 'name ell' }, p.name || '')),
      h('button', { class: 'icon-btn', type: 'button', 'aria-label': `Unpin ${p.sym}`, style: { flex: 'none' }, onClick: (e) => { e.preventDefault(); togglePin(p.sym, p.name, p.kind); paint(); } }, icon('dash')))));
  };
  paint();
  return box;
}

async function companies(body) {
  const { rows } = await loadBoard();
  if (!rows.length) { body.append(noDataPanel()); return; }
  let q = '', mk = 'ALL', sort = 'name';
  const list = h('div', { class: 'ledger' });
  const inWatchlist = new Set(rows.map((r) => r.symbol.toUpperCase()));
  const usBox = externalSearchBox({
    title: 'Other US companies', sub: 'live from SEC EDGAR — filings and profile only, no price',
    loadIndex: D.edgarIndex, getSym: (r) => r.t, getName: (r) => r.n, tagLabel: 'SEC lookup',
    linkFor: (r) => `#/fundamentals/lookup/${encodeURIComponent(r.t)}`,
  }, inWatchlist);
  const inBox = externalSearchBox({
    title: 'Other India companies', sub: 'Nifty Total Market + Microcap 250 — profile only, no price',
    loadIndex: D.indiaIndex, getSym: (r) => r.s, getName: (r) => r.n, tagLabel: 'NSE lookup',
    linkFor: (r) => `#/fundamentals/india/${encodeURIComponent(r.s)}`,
  }, inWatchlist);
  const sorters = {
    name: (a, b) => a.symbol.localeCompare(b.symbol),
    cap: (a, b) => (b.market_cap ?? 0) - (a.market_cap ?? 0),
    move: (a, b) => (b.change_pct ?? -99) - (a.change_pct ?? -99),
    earn: (a, b) => (a.next_earnings || '9999').localeCompare(b.next_earnings || '9999'),
    insider: (a, b) => (b.insider_net_90d ?? -1e18) - (a.insider_net_90d ?? -1e18),
  };
  function paint() {
    const ql = q.trim().toLowerCase();
    const items = rows.filter((r) => (mk === 'ALL' || r.market === mk) && (!ql || r.symbol.toLowerCase().includes(ql) || (r.name || '').toLowerCase().includes(ql) || (r.sector || '').toLowerCase().includes(ql))).sort(sorters[sort]);
    list.replaceChildren(...items.map(fundRow));
    if (!items.length) list.append(h('div', { class: 'empty' }, h('b', null, 'No match'), 'Try a different name, symbol or sector.'));
    const stillCurrent = () => q.trim().toLowerCase() === ql;
    usBox.paint(ql, stillCurrent);
    inBox.paint(ql, stillCurrent);
  }
  const input = h('input', { class: 'field', type: 'search', placeholder: 'Search symbol, company or sector', 'aria-label': 'Search companies', autocomplete: 'off', onInput: debounce((e) => { q = e.target.value; paint(); }) });
  const pinned = pinnedSection();
  if (pinned) body.append(pinned);
  body.append(
    h('div', { class: 'search' }, icon('search'), input),
    h('div', { class: 'row between wrap', style: { gap: '8px 14px', margin: '12px 0 4px' } },
      chipGroup([{ id: 'ALL', label: 'All', count: rows.length }, { id: 'US', label: 'US', count: rows.filter((r) => r.market === 'US').length }, { id: 'IN', label: 'India', count: rows.filter((r) => r.market === 'IN').length }].filter((o) => o.id === 'ALL' || o.count), mk, (v) => { mk = v; paint(); }),
      h('label', { class: 'row small soft', style: { gap: '8px' } }, 'Sort by',
        h('select', { class: 'field', style: { width: 'auto', height: '36px', padding: '0 10px' }, 'aria-label': 'Sort companies', onChange: (e) => { sort = e.target.value; paint(); } },
          h('option', { value: 'name' }, 'Symbol'), h('option', { value: 'cap' }, 'Market value'), h('option', { value: 'move' }, 'Today’s move'), h('option', { value: 'earn' }, 'Next earnings'), h('option', { value: 'insider' }, 'Insider buying')))),
    list,
    usBox.el,
    inBox.el,
    h('p', { class: 'muted small', style: { marginTop: '14px' } }, 'The F, T and S badges are the three lenses. ', h('button', { class: 'chip', style: { height: '28px', padding: '0 10px', fontSize: '13px' }, onClick: lensExplainer }, 'How they work')));
  paint();
}

function fundRow(r) {
  const ccy = r.currency || (r.market === 'IN' ? 'INR' : 'USD');
  const d = r.next_earnings ? fmt.daysUntil(r.next_earnings) : null;
  const chips = h('div', { class: 'row wrap', style: { gap: '6px', marginTop: '6px' } });
  if (r.rating) chips.append(badge(r.rating, r.rating_score != null && r.rating_score <= 2.2 ? 'gain' : r.rating_score >= 3.2 ? 'loss' : ''));
  if (d != null && d >= 0 && d <= 45) chips.append(badge(d === 0 ? 'Reports today' : `Reports in ${d}d`, d <= 7 ? 'accent' : 'outline'));
  if (r.insider_net_90d != null && r.insider_net_90d !== 0) chips.append(badge(`Insiders net ${r.insider_net_90d > 0 ? 'bought' : 'sold'} ${fmt.moneyC(Math.abs(r.insider_net_90d), ccy)}`, r.insider_net_90d > 0 ? 'gain' : 'loss'));
  return h('a', { class: 'lrow', href: `#/fundamentals/${encodeURIComponent(r.symbol)}`, style: { alignItems: 'flex-start', padding: '14px 2px' } },
    h('div', { class: 'who' },
      h('div', { class: 'row', style: { gap: '10px' } }, h('span', { class: 'sym' }, r.symbol.replace(/\.NS$/, '')), h('span', { class: 'name ell' }, r.name || '')),
      h('div', { class: 'tiny muted', style: { marginTop: '2px' } }, [r.sector, r.market_cap ? `${fmt.moneyC(r.market_cap, ccy)} market value` : null, r.pe ? `P/E ${fmt.num(r.pe, 1)}` : null].filter(Boolean).join(', ')),
      chips),
    h('div', { class: 'px' }, h('div', { class: 'p' }, fmt.money(r.price, ccy)), h('div', { class: 'c ' + fmt.dir(r.change_pct) }, `${fmt.arrow(r.change_pct)} ${fmt.pct(r.change_pct)}`), h('div', { style: { marginTop: '8px' } }, lensRow(r.lens))));
}

// ---------- cross-company tapes ----------
async function tape(body, view) {
  const feed = await D.feed();
  if (!feed) { body.append(noDataPanel()); return; }
  if (view === 'tape-earnings') return earningsTape(body, feed);
  if (view === 'tape-insiders') return insiderTape(body, feed);
  if (view === 'tape-filings') return filingTape(body, feed);
  return newsTape(body, feed);
}

function earningsTape(body, feed) {
  const up = (feed.earnings || []).filter((e) => (fmt.daysUntil(e.date) ?? -1) >= 0).sort((a, b) => a.date.localeCompare(b.date));
  const done = (feed.reported || []).slice().sort((a, b) => b.date.localeCompare(a.date)).slice(0, 25);
  body.append(sectionHead('Upcoming reports', `${up.length} on your watchlist`));
  body.append(up.length ? h('div', { class: 'ledger' }, up.map((e) => {
    const d = fmt.daysUntil(e.date);
    return h('a', { class: 'lrow', href: `#/fundamentals/${encodeURIComponent(e.symbol)}/earnings` },
      h('div', { class: 'tnum', style: { width: '78px', flex: 'none' } }, h('div', { style: { fontWeight: 600 } }, fmt.shortDate(e.date)), h('div', { class: 'tiny muted' }, d === 0 ? 'today' : `in ${d} days`)),
      h('div', { class: 'who' }, h('div', { class: 'sym ell', style: { fontSize: '16px' } }, e.symbol.replace(/\.NS$/, '')), h('div', { class: 'name ell' }, e.name || '')),
      h('div', { class: 'right small' }, h('div', { class: 'muted' }, 'EPS estimate'), h('div', { class: 'num', style: { fontWeight: 600 } }, e.eps_est != null ? fmt.num(e.eps_est) : '—')));
  })) : h('div', { class: 'empty' }, 'No upcoming earnings dates found.'));
  body.append(h('div', { class: 'section' }, sectionHead('Recently reported', 'actual versus estimate'),
    done.length ? h('div', { class: 'ledger' }, done.map((e) => h('a', { class: 'lrow', href: `#/fundamentals/${encodeURIComponent(e.symbol)}/earnings` },
      h('div', { class: 'tnum', style: { width: '78px', flex: 'none' } }, fmt.shortDate(e.date)),
      h('div', { class: 'who' }, h('div', { class: 'sym', style: { fontSize: '16px' } }, e.symbol.replace(/\.NS$/, '')), h('div', { class: 'name' }, `Estimate ${fmt.num(e.eps_est)}, actual ${fmt.num(e.eps_actual)}`)),
      badge(`${e.surprise_pct > 0 ? 'Beat' : e.surprise_pct < 0 ? 'Missed' : 'Met'} ${fmt.pct(e.surprise_pct, 1)}`, e.surprise_pct > 0 ? 'gain' : e.surprise_pct < 0 ? 'loss' : '')))) : h('div', { class: 'empty' }, 'No reported quarters in the data yet.')));
}

function insiderTape(body, feed) {
  let f = 'all';
  const all = feed.insiders || [];
  const box = h('div', { class: 'feed' });
  const paint = () => {
    const items = all.filter((t) => f === 'all' || t.type === f);
    box.replaceChildren(...items.slice(0, 120).map((t) => feedItem(insiderToFeed(t), { showSymbol: true })));
    if (!items.length) box.append(h('div', { class: 'empty' }, 'No trades of this type.'));
  };
  const buys = all.filter((t) => t.type === 'buy'), sells = all.filter((t) => t.type === 'sell');
  body.append(
    h('p', { class: 'soft', style: { maxWidth: '62ch' } }, 'Open-market purchases and sales reported by company officers, directors and 10% owners on SEC Form 4. Sales are common and often scheduled, so purchases are usually the stronger signal.'),
    chipGroup([{ id: 'all', label: 'All', count: all.length }, { id: 'buy', label: 'Purchases', count: buys.length }, { id: 'sell', label: 'Sales', count: sells.length }], f, (v) => { f = v; paint(); }),
    box);
  paint();
}

function filingTape(body, feed) {
  let f = 'all';
  const all = feed.filings || [];
  const groups = { all: () => true, '8-K': (x) => x.form.startsWith('8-K'), periodic: (x) => /^(10-Q|10-K|20-F|40-F|6-K)/.test(x.form), holders: (x) => /13[DGF]|SC 13/.test(x.form), proxy: (x) => /DEF 14A|PRE 14A|DEFA14A/.test(x.form) };
  const box = h('div', { class: 'feed' });
  const paint = () => {
    const items = all.filter(groups[f]);
    box.replaceChildren(...items.slice(0, 120).map((x) => feedItem({ type: 'filing', symbol: x.symbol, date: x.date, url: x.url, title: `${x.form}${x.desc ? ': ' + x.desc : ''}`, sub: x.items || '' }, { showSymbol: true })));
    if (!items.length) box.append(h('div', { class: 'empty' }, 'No filings of this type.'));
  };
  body.append(
    h('p', { class: 'soft', style: { maxWidth: '62ch' } }, 'Everything your companies file with the SEC: 8-K event reports, 10-Q and 10-K results, and 13D/G ownership stakes. Tap to open the original on sec.gov.'),
    chipGroup([{ id: 'all', label: 'All' }, { id: '8-K', label: '8-K events' }, { id: 'periodic', label: 'Results' }, { id: 'holders', label: 'Big holders' }, { id: 'proxy', label: 'Proxy' }], f, (v) => { f = v; paint(); }),
    box);
  paint();
}

function newsTape(body, feed) {
  const all = feed.news || [];
  body.append(all.length ? h('div', { class: 'feed' }, all.slice(0, 100).map((n) => feedItem({ type: 'news', symbol: n.symbol, ts: n.ts, url: n.url, title: n.title, sub: n.source }, { showSymbol: true }))) : h('div', { class: 'empty' }, 'No headlines yet.'));
}
