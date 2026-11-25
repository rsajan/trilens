// Dialogs for the chart page, built on the app's existing sheet() so they look and behave like the
// rest of Trilens (Escape / backdrop closes, full width on a phone).

import { h, sheet, clear } from '../../lib/dom.js';
import { BUILTINS } from '../indicators/builtins.js';
import { scripts } from '../store/workspace.js';

/** @param {{ contracts: any[], current: string, feedLabel: string, onPick: (symbol: string) => void }} o */
export function symbolDialog(o) {
  const q = h('input', { class: 'field', type: 'search', placeholder: 'Search contracts', 'aria-label': 'Search contracts' });
  const list = h('div', { class: 'ledger' });
  const draw = () => {
    clear(list);
    const term = q.value.trim().toLowerCase();
    for (const c of o.contracts.filter((c) => !term || (c.symbol + ' ' + c.name).toLowerCase().includes(term))) {
      list.append(h('button', { type: 'button', class: 'lrow cx-pickrow' + (c.symbol === o.current ? ' on' : ''), style: { width: '100%', textAlign: 'left', minHeight: '52px' }, onClick: () => { o.onPick(c.symbol); bg.remove(); } },
        h('span', { class: 'who' }, h('span', { class: 'sym' }, c.symbol), h('div', { class: 'name' }, c.name)),
        h('span', { class: 'badge' }, c.kind === 'perp' ? 'Perpetual' : 'Quarterly')));
    }
    if (!list.childNodes.length) list.append(h('p', { class: 'muted', style: { padding: '14px 2px' } }, 'No contract matches.'));
  };
  q.addEventListener('input', draw);
  draw();
  const bg = sheet('Contracts · ' + o.feedLabel, q, h('div', { style: { height: '10px' } }), list);
  setTimeout(() => q.focus(), 30);
  return bg;
}

/** @param {{ onAdd: (ref: string) => void, onNewScript: () => void }} o */
export function indicatorDialog(o) {
  const q = h('input', { class: 'field', type: 'search', placeholder: 'Search indicators and your scripts', 'aria-label': 'Search indicators' });
  const list = h('div');
  const row = (ref, name, sub) => h('button', { type: 'button', class: 'lrow cx-pickrow', style: { width: '100%', textAlign: 'left', minHeight: '50px' }, onClick: () => { o.onAdd(ref); bg.remove(); } },
    h('span', { class: 'who' }, h('b', null, name), sub ? h('div', { class: 'name' }, sub) : null), h('span', { class: 'muted small' }, 'Add'));
  const draw = () => {
    clear(list);
    const t = q.value.trim().toLowerCase();
    const hit = (s) => !t || s.toLowerCase().includes(t);
    const mine = scripts.get().filter((s) => hit(s.name));
    list.append(h('h4', { class: 'cx-h' }, 'My scripts'));
    if (mine.length) list.append(h('div', { class: 'ledger' }, mine.map((s) => row('script:' + s.id, s.name, 'Edited ' + new Date(s.updatedAt).toLocaleString()))));
    else list.append(h('p', { class: 'muted small' }, scripts.get().length ? 'No script matches.' : 'No saved scripts yet. Write one in the Pine editor and press Save.'));
    list.append(h('h4', { class: 'cx-h' }, 'Built-in'));
    list.append(h('div', { class: 'ledger' }, BUILTINS.filter((b) => hit(b.name + ' ' + b.short)).map((b) => row('builtin:' + b.id, b.name, b.short))));
  };
  q.addEventListener('input', draw);
  draw();
  const bg = sheet('Indicators', q, list,
    h('div', { class: 'row', style: { marginTop: '16px' } }, h('button', { type: 'button', class: 'btn', onClick: () => { bg.remove(); o.onNewScript(); } }, 'New Pine script')));
  setTimeout(() => q.focus(), 30);
  return bg;
}

const hex6 = (c) => (typeof c === 'string' && /^#[0-9a-f]{6,8}$/i.test(c) ? c.slice(0, 7) : '#2962ff');
const alphaOf = (c) => (typeof c === 'string' && c.length === 9 ? parseInt(c.slice(7, 9), 16) / 255 : 1);
const withAlpha = (rgb6, a) => rgb6 + Math.round(Math.max(0, Math.min(1, a)) * 255).toString(16).padStart(2, '0');

/**
 * Settings dialog generated from the script's input.*() calls, plus plot style overrides.
 * Changes apply live (like TradingView); Reset clears every override.
 * @param {{ title: string, result: any, study: any, onChange: (patch: { inputs?: any, styles?: any }) => void }} o
 */
export function settingsDialog(o) {
  const res = o.result;
  let inputs = { ...o.study.inputs };
  let styles = structuredClone(o.study.styles || {});
  const push = () => o.onChange({ inputs: { ...inputs }, styles: structuredClone(styles) });

  const inTab = h('div', { class: 'cx-form' });
  const styleTab = h('div', { class: 'cx-form hide' });
  const tabs = h('div', { class: 'seg', role: 'tablist', style: { marginBottom: '14px' } });
  const tab = (label, panel) => {
    const b = h('button', { type: 'button', role: 'tab', 'aria-selected': panel === inTab ? 'true' : 'false', onClick: () => {
      for (const x of tabs.children) x.setAttribute('aria-selected', 'false');
      b.setAttribute('aria-selected', 'true');
      inTab.classList.toggle('hide', panel !== inTab); styleTab.classList.toggle('hide', panel !== styleTab);
    } }, label);
    return b;
  };
  tabs.append(tab('Inputs', inTab), tab('Style', styleTab));

  const defs = (res && res.inputs) || [];
  if (!defs.length) inTab.append(h('p', { class: 'muted' }, 'This script has no inputs.'));
  for (const d of defs) {
    const cur = inputs[d.key] !== undefined ? inputs[d.key] : d.defval;
    let ctl;
    if (d.type === 'bool') {
      ctl = h('input', { type: 'checkbox', class: 'cx-check' });
      ctl.checked = !!cur;
      ctl.addEventListener('change', () => { inputs[d.key] = ctl.checked; push(); });
    } else if (d.type === 'int' || d.type === 'float') {
      ctl = h('input', { type: 'number', class: 'ipt cx-num', inputmode: d.type === 'int' ? 'numeric' : 'decimal', step: d.step ?? (d.type === 'int' ? 1 : 'any'), min: d.minval, max: d.maxval });
      ctl.value = String(cur);
      ctl.addEventListener('input', () => { const v = parseFloat(ctl.value); if (Number.isFinite(v)) { inputs[d.key] = d.type === 'int' ? Math.round(v) : v; push(); } });
    } else if (d.type === 'color') {
      ctl = colorControl(cur, (c) => { inputs[d.key] = c; push(); });
    } else if (d.options && d.options.length) {
      ctl = h('select', { class: 'ipt' }, d.options.map((x) => h('option', { value: x }, x)));
      ctl.value = String(cur);
      ctl.addEventListener('change', () => { inputs[d.key] = ctl.value; push(); });
    } else {
      ctl = h('input', { type: 'text', class: 'ipt' });
      ctl.value = String(cur);
      ctl.addEventListener('input', () => { inputs[d.key] = ctl.value; push(); });
    }
    inTab.append(h('label', { class: 'cx-field' + (d.type === 'bool' ? ' inline' : '') }, h('span', null, d.title), ctl));
  }

  const plots = (res && res.plots) || [];
  const shapes = (res && res.shapes) || [];
  for (const p of [...plots, ...shapes]) {
    const st = styles[p.title] || (styles[p.title] = {});
    const vis = h('input', { type: 'checkbox', class: 'cx-check' });
    vis.checked = !st.hidden;
    vis.addEventListener('change', () => { st.hidden = !vis.checked; push(); });
    const col = colorControl(st.color || p.color, (c) => { st.color = c; push(); });
    styleTab.append(h('div', { class: 'cx-field inline' }, vis, h('span', { class: 'grow' }, p.title), col));
  }
  if (!plots.length && !shapes.length) styleTab.append(h('p', { class: 'muted' }, 'Nothing to style: this script draws no plots.'));

  const reset = h('button', { type: 'button', class: 'btn', onClick: () => { inputs = {}; styles = {}; o.onChange({ inputs: {}, styles: {} }); bg.remove(); } }, 'Reset to defaults');
  const bg = sheet(o.title + ' · settings', tabs, inTab, styleTab, h('div', { class: 'row', style: { marginTop: '18px' } }, reset));
  return bg;
}

/** Colour + opacity control producing "#rrggbbaa". */
function colorControl(value, onChange) {
  const c = h('input', { type: 'color', class: 'cx-color', 'aria-label': 'Colour' });
  const a = h('input', { type: 'range', min: '0', max: '100', class: 'cx-alpha', 'aria-label': 'Opacity' });
  c.value = hex6(value);
  a.value = String(Math.round(alphaOf(value) * 100));
  const fire = () => onChange(withAlpha(c.value, +a.value / 100));
  c.addEventListener('input', fire);
  a.addEventListener('input', fire);
  return h('span', { class: 'row', style: { gap: '8px' } }, c, a);
}

/** Small prompt using the same sheet look. Resolves to the entered text or null. */
export function promptDialog(title, label, value = '') {
  return new Promise((resolve) => {
    const ipt = h('input', { class: 'field', type: 'text', 'aria-label': label });
    ipt.value = value;
    let done = false;
    const finish = (v) => { if (done) return; done = true; bg.remove(); resolve(v); };
    const ok = h('button', { type: 'button', class: 'btn primary', onClick: () => finish(ipt.value.trim() || null) }, 'OK');
    const bg = sheet(title, h('label', { class: 'cx-field' }, h('span', null, label), ipt), h('div', { class: 'row', style: { marginTop: '14px' } }, ok));
    ipt.addEventListener('keydown', (e) => { if (e.key === 'Enter') finish(ipt.value.trim() || null); });
    new MutationObserver((_, obs) => { if (!bg.isConnected) { obs.disconnect(); finish(null); } }).observe(document.body, { childList: true });
    setTimeout(() => { ipt.focus(); ipt.select(); }, 30);
  });
}
