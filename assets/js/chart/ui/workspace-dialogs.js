// Templates dialog: indicator templates (save the focused chart's indicators, apply them to any
// chart) and layout presets (the whole split screen: layout, sync settings, every chart's
// contract, timeframe and indicators).

import { h, sheet, clear } from '../../lib/dom.js';
import { promptDialog } from './dialogs.js';
import { templates, saveTemplate, deleteTemplate, layouts, saveLayout, applyLayout, deleteLayout } from '../store/library.js';
import { workspace, applyStudies, activeCell } from '../store/workspace.js';
import { BUILTIN } from '../indicators/builtins.js';
import { getScript } from '../store/workspace.js';

const refName = (ref) => (ref.startsWith('builtin:') ? (BUILTIN[ref.slice(8)] || {}).short || ref : (getScript(ref.slice(7)) || {}).name || 'deleted script');

export function templatesDialog() {
  const tBox = h('div', { class: 'ledger' });
  const lBox = h('div', { class: 'ledger' });
  const row = (title, sub, actions) => h('div', { class: 'lrow', style: { minHeight: '54px' } }, h('div', { class: 'who' }, h('b', null, title), h('div', { class: 'name' }, sub)), h('div', { class: 'row' }, ...actions));
  const small = (label, fn, primary) => h('button', { type: 'button', class: 'btn' + (primary ? ' primary' : ''), style: { minHeight: '36px', padding: '0 12px' }, onClick: fn }, label);

  const paint = () => {
    clear(tBox);
    if (!templates.get().length) tBox.append(h('p', { class: 'muted small', style: { padding: '8px 2px' } }, 'None saved yet.'));
    for (const t of templates.get()) {
      tBox.append(row(t.name, t.studies.map((s) => refName(s.ref)).join(', ') || 'no indicators', [
        small('Apply', () => { applyStudies(workspace.get().active, t.studies); bg.remove(); }, true),
        small('Delete', () => { if (window.confirm(`Delete template "${t.name}"?`)) deleteTemplate(t.id); }),
      ]));
    }
    clear(lBox);
    if (!layouts.get().length) lBox.append(h('p', { class: 'muted small', style: { padding: '8px 2px' } }, 'None saved yet.'));
    for (const l of layouts.get()) {
      const n = l.layout === '2x2' ? 4 : l.layout === '1x2' ? 2 : 1;
      lBox.append(row(l.name, `${l.layout} · ` + l.cells.slice(0, n).map((c) => `${c.symbol} ${c.tf}`).join(' | '), [
        small('Load', () => { applyLayout(l.id); bg.remove(); }, true),
        small('Delete', () => { if (window.confirm(`Delete layout "${l.name}"?`)) deleteLayout(l.id); }),
      ]));
    }
  };
  const u1 = templates.subscribe((x) => x, paint), u2 = layouts.subscribe((x) => x, paint);
  paint();

  const bg = sheet('Templates & layouts',
    h('div', { class: 'row between', style: { marginTop: '6px' } }, h('h4', { class: 'cx-h', style: { margin: 0 } }, 'Indicator templates'),
      small('Save current', async () => {
        const st = activeCell().studies;
        if (!st.length) { window.alert('The focused chart has no indicators to save.'); return; }
        const name = await promptDialog('Save indicator template', 'Name', st.map((s) => refName(s.ref)).join(' + '));
        if (name) saveTemplate(name, st);
      })),
    h('p', { class: 'muted small' }, 'Apply replaces the focused chart\'s indicators, inputs and styles included.'),
    tBox,
    h('div', { class: 'row between', style: { marginTop: '18px' } }, h('h4', { class: 'cx-h', style: { margin: 0 } }, 'Layouts'),
      small('Save current', async () => { const name = await promptDialog('Save layout', 'Name', `${workspace.get().layout} layout`); if (name) saveLayout(name); })),
    h('p', { class: 'muted small' }, 'A layout keeps the split, the sync settings and every chart\'s contract, timeframe and indicators. Drawings stay with their contract.'),
    lBox);
  new MutationObserver((_, obs) => { if (!bg.isConnected) { obs.disconnect(); u1(); u2(); } }).observe(document.body, { childList: true });
  return bg;
}
