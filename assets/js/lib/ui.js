// Shared UI pieces used by more than one page.
import { h } from './dom.js';

export function pageHead(title, sub, right) {
  return h('div', { class: 'page-head' }, h('div', null, h('h1', null, title), sub ? h('p', null, sub) : null), right || null);
}
export function sectionHead(title, sub, right) {
  return h('header', null, h('h2', null, title), right || (sub ? h('span', { class: 'sub' }, sub) : null));
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
