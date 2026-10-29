// Shared UI pieces used by more than one page.
import { h, icon, fmt, lensRow, sheet, extLink, badge, toDate, LENS_NAMES, lensBadge } from './dom.js';
import { sparkline } from './charts.js';
import { isPinned, togglePin } from './pins.js';

export function pageHead(title, sub, right) {
  return h('div', { class: 'page-head' }, h('div', null, h('h1', null, title), sub ? h('p', null, sub) : null), right || null);
}
export function sectionHead(title, sub, right) {
  return h('header', null, h('h2', null, title), right || (sub ? h('span', { class: 'sub' }, sub) : null));
}

export function companyRow(r, href) {
  const ccy = r.currency || (r.market === 'IN' ? 'INR' : 'USD');
  return h('a', { class: 'lrow', href: href || `#/fundamentals/${encodeURIComponent(r.symbol)}` },
    h('div', { class: 'who' },
      h('div', { class: 'sym ell' }, r.symbol.replace(/\.NS$|\.BO$/, '')),
      h('div', { class: 'name ell' }, r.name || '')),
    r.spark && r.spark.length > 2 ? sparkline(r.spark) : null,
    h('div', { class: 'px' },
      h('div', { class: 'p' }, fmt.money(r.price, ccy)),
      h('div', { class: 'c ' + fmt.dir(r.change_pct) }, `${fmt.arrow(r.change_pct)} ${fmt.pct(r.change_pct)}`)),
    lensRow(r.lens));
}

export function chipGroup(options, active, onChange) {
  const box = h('div', { class: 'chips', role: 'group' });
  const btns = options.map((o) => {
    const b = h('button', { class: 'chip', type: 'button', 'aria-pressed': String(o.id === active), onClick: () => {
      btns.forEach((x, i) => x.setAttribute('aria-pressed', String(options[i].id === o.id)));
      onChange(o.id);
    } }, o.label, o.count != null ? h('span', { class: 'count' }, o.count) : null);
    return b;
  });
  box.append(...btns);
  return box;
}

export function segmented(options, active, onChange, label) {
  const box = h('div', { class: 'seg', role: 'tablist', 'aria-label': label || null });
  const btns = options.map((o) => h('button', { type: 'button', role: 'tab', 'aria-selected': String(o.id === active), onClick: () => {
    btns.forEach((x, i) => x.setAttribute('aria-selected', String(options[i].id === o.id)));
    onChange(o.id);
  } }, o.label));
  box.append(...btns);
  return box;
}

export function tabsBar(options, active, onChange) {
  const box = h('div', { class: 'tabs', role: 'tablist' });
  const btns = options.map((o) => h('button', { type: 'button', role: 'tab', 'aria-selected': String(o.id === active), onClick: () => {
    btns.forEach((x, i) => x.setAttribute('aria-selected', String(options[i].id === o.id)));
    onChange(o.id);
  } }, o.label));
  box.append(...btns);
  return box;
}

export function kvGrid(pairs) {
  const dl = h('dl', { class: 'kv' });
  for (const [k, v, cls] of pairs) dl.append(h('div', null, h('dt', null, k), h('dd', { class: cls || '' }, v ?? '—')));
  return dl;
}

const FEED_ICON = { news: 'news', filing: 'filing', insider: 'insider', earnings: 'earnings', analyst: 'analyst', dividend: 'coin', split: 'coin' };
export function feedItem(it, { showSymbol = false, symbolLink = true } = {}) {
  const tone = it.tone || '';
  const meta = h('div', { class: 'm' });
  if (showSymbol && it.symbol) meta.append(h('b', { style: { color: 'var(--ink-2)', fontWeight: 600 } }, it.symbol.replace(/\.NS$/, '')));
  if (it.kind) meta.append(it.kind);
  if (it.sub) meta.append(it.sub);
  if (it.ts || it.date) meta.append(h('span', { title: fmt.date(it.ts || it.date) }, it.ts ? fmt.rel(it.ts) : fmt.shortDate(it.date)));
  const body = h('div', { class: 'grow' }, h('div', { class: 't' }, it.title), meta);
  const ic = h('div', { class: 'ic ' + tone }, icon(FEED_ICON[it.type] || 'news'));
  const url = it.url;
  if (url) {
    const a = extLink('', url, 'item'); a.append(ic, body);
    return a;
  }
  return h('div', { class: 'item' }, ic, body);
}

export function dayGroups(items, getDay) {
  // returns DOM: day separators + items already rendered by caller via map
  const out = []; let cur = '';
  for (const it of items) {
    const d = getDay(it);
    if (d !== cur) { cur = d; out.push(h('div', { class: 'daysep' }, fmt.weekday(d))); }
    out.push(it.__node);
  }
  return out;
}

export function lensExplainer() {
  sheet('How the three lenses work',
    h('p', { class: 'soft' }, 'Each stock gets three quick reads. They are screening aids built from simple rules, not predictions.'),
    h('div', { class: 'stack', style: { '--gap': '14px' } },
      h('div', null, h('div', { class: 'row' }, lensBadge('F', 1), h('b', null, 'Fundamentals')),
        h('p', { class: 'soft small', style: { margin: '6px 0 0' } }, 'Adds a point for each of: analysts rate it Buy or better, the average price target is 15% or more above the price, the last earnings beat estimates by 3% or more, and insiders were net buyers in the last 90 days. Subtracts for the opposite. Two points or more reads bullish, minus two or less reads bearish.')),
      h('div', null, h('div', { class: 'row' }, lensBadge('T', 1), h('b', null, 'Technical')),
        h('p', { class: 'soft small', style: { margin: '6px 0 0' } }, 'Bullish when one of your scanners (Accumulation bot, reversal bot) flags it, or when the price is above both its 50-day and 200-day averages. Bearish when it is below both. Otherwise neutral.')),
      h('div', null, h('div', { class: 'row' }, lensBadge('S', 1), h('b', null, 'Sentiment')),
        h('p', { class: 'soft small', style: { margin: '6px 0 0' } }, 'The crowd score from news, social posts and forums, from −100 to +100. At least +20 reads bullish, −20 or lower reads bearish. Needs at least 3 mentions, otherwise it shows no read.')),
      h('div', { class: 'row' }, lensBadge('F', 'none'), h('span', { class: 'soft small' }, 'A dashed badge means there is not enough data yet.'))));
}

export function noDataPanel() {
  return h('div', { class: 'empty' }, h('b', null, 'No data yet'),
    'The automatic update has not produced data. On GitHub open Actions, choose "Update data", then Run workflow. It takes about two minutes. The README in your project folder has the step-by-step.');
}

export function sourceLink(text, url) { return extLink(text, url); }

export function pinButton(sym, name, kind) {
  const set = (btn, on) => { btn.textContent = on ? '★ Pinned' : '+ Pin'; btn.classList.toggle('primary', on); };
  const btn = h('button', { class: 'btn', type: 'button', style: { minHeight: '38px', padding: '0 16px' } });
  set(btn, isPinned(sym));
  btn.addEventListener('click', () => set(btn, togglePin(sym, name, kind)));
  return btn;
}
export { badge, toDate, LENS_NAMES };

/** Simple responsive table. cols: [{label, align:'r', nw:true, render:(row)=>node|string}] */
export function dataTable(cols, rows, opts = {}) {
  const t = h('table', { class: 'tbl' + (opts.compact ? ' compact' : '') },
    h('thead', null, h('tr', null, cols.map((c) => h('th', { class: c.align === 'r' ? 'r' : '' }, c.label)))),
    h('tbody', null, rows.map((r) => h('tr', null, cols.map((c) => {
      const v = c.render(r);
      return h('td', { class: (c.align === 'r' ? 'r ' : '') + (c.nw ? 'nw' : ''), title: opts.compact && typeof v === 'string' && v.length > 28 ? v : null }, v);
    })))));
  return h('div', { class: 'tbl-wrap' }, t);
}
