// Chart settings window (TradingView's "Settings": Symbol, Status line, Scales and lines, Canvas).
// Changes preview live on the chart; OK saves them for this chart, Cancel / Close puts them back.
// "Template" saves the settings as your default for charts you have not customised.

import { h, clear, sheet } from '../../lib/dom.js';
import { store } from '../../lib/store.js';
import { workspace } from '../store/workspace.js';

export const DEFAULT_KEY = 'chart:settingsDefault';
/** The settings a chart uses: its own, or your default when it has none. */
export function effectiveSettings(cellScale) {
  return cellScale && Object.keys(cellScale).length ? cellScale : store.get(DEFAULT_KEY, {}) || {};
}

const TZ = [['UTC', 'UTC'], ['local', 'This device\'s time zone'], ['Asia/Kolkata', '(UTC+5:30) Kolkata'], ['Asia/Singapore', '(UTC+8) Singapore'],
  ['America/New_York', '(UTC-5/-4) New York'], ['Europe/London', '(UTC+0/+1) London'], ['Asia/Tokyo', '(UTC+9) Tokyo'], ['Australia/Sydney', '(UTC+10/+11) Sydney']];
const TABS = [['symbol', 'Symbol'], ['status', 'Status line'], ['scales', 'Scales and lines'], ['canvas', 'Canvas']];

const cssVar = (n, f) => { const v = getComputedStyle(document.documentElement).getPropertyValue(n).trim(); return /^#[0-9a-f]{6}$/i.test(v) ? v : f; };

/**
 * @param {{ index: number, engine: import('../engine/chart-engine.js').ChartEngine, symbol: string }} o
 */
export function chartSettingsDialog(o) {
  const saved = { ...effectiveSettings(workspace.get().cells[o.index].scale) };
  let draft = { ...saved };
  let committed = false;
  const preview = () => o.engine.setScale(draft);
  const theme = { up: cssVar('--gain', '#2fcb92'), dn: cssVar('--loss', '#ff7a73'), bg: cssVar('--bg', '#0d1b2a'), grid: cssVar('--line-soft', '#1d3349'), ink: cssVar('--ink-2', '#a9b9c9'), cross: cssVar('--ink-3', '#7f95ab') };

  // ---- controls
  const set = (k, v) => { if (v === undefined) delete draft[k]; else draft[k] = v; preview(); };
  const check = (label, k, on = true) => {
    const id = 'cs-' + k;
    const box = h('input', { type: 'checkbox', id, checked: draft[k] === undefined ? on : !!draft[k], onChange: (e) => set(k, e.target.checked) });
    return h('label', { class: 'cs-row cs-check', for: id }, box, h('span', null, label));
  };
  const color = (k, fallback, title) => {
    const inp = h('input', { type: 'color', class: 'cs-color', value: draft[k] || fallback, title, 'aria-label': title, onInput: (e) => set(k, e.target.value) });
    return inp;
  };
  const resetBtn = (keys, onDone) => h('button', { type: 'button', class: 'cs-reset', title: 'Back to the theme colour', 'aria-label': 'Back to the theme colour', onClick: () => { keys.forEach((k) => delete draft[k]); preview(); onDone(); } }, '↺');
  const select = (label, k, options, def) => {
    const s = h('select', { class: 'ipt cs-sel', 'aria-label': label, onChange: (e) => set(k, e.target.value === '' ? undefined : e.target.value) },
      options.map(([v, t]) => h('option', { value: v }, t)));
    s.value = draft[k] ?? def ?? options[0][0];
    return h('div', { class: 'cs-row' }, h('span', { class: 'cs-lab' }, label), s);
  };
  const head = (t) => h('div', { class: 'cs-head' }, t);
  const pair = (label, partKey, upKey, dnKey, upDef, dnDef) => {
    const row = h('div', { class: 'cs-row' });
    const paint = () => clear(row).append(check(label, partKey), h('span', { class: 'grow' }),
      color(upKey, upDef, label + ': up bars'), color(dnKey, dnDef, label + ': down bars'), resetBtn([upKey, dnKey], () => paint()));
    paint();
    return row;
  };

  const panes = {
    symbol: () => [
      head('Candles'),
      check('Color bars based on previous close', 'prevClose', false),
      pair('Body', 'body', 'upColor', 'downColor', theme.up, theme.dn),
      pair('Borders', 'border', 'borderUp', 'borderDown', draft.upColor || theme.up, draft.downColor || theme.dn),
      pair('Wick', 'wick', 'wickUp', 'wickDown', draft.upColor || theme.up, draft.downColor || theme.dn),
      head('Data'),
      select('Precision', 'precision', [['', 'Default (from the contract)'], ...[0, 1, 2, 3, 4, 5, 6, 8].map((p) => [String(p), p === 0 ? '1 (no decimals)' : '0.' + '0'.repeat(p - 1) + '1'])]),
      select('Time zone', 'tz', TZ, 'UTC'),
      h('p', { class: 'tiny muted' }, 'Daily, weekly and monthly bars always show their trading date; the time zone changes intraday times.'),
    ],
    status: () => [
      head('Top-left status line'),
      check('Symbol and timeframe', 'showSymbol'),
      check('Open, high, low, close values', 'showOHLC'),
      check('Bar change values', 'showChange'),
      check('Volume value', 'showVolume'),
      check('Indicator titles', 'showIndicators'),
      check('Indicator values', 'showIndValues'),
    ],
    scales: () => [
      head('Price scale'),
      select('Scale type', 'mode', [['normal', 'Regular'], ['percent', 'Percent'], ['indexed', 'Indexed to 100'], ['log', 'Logarithmic']], 'normal'),
      check('Invert scale', 'invert', false),
      select('Scale position', 'left', [['', 'Right'], ['1', 'Left']], ''),
      head('Lines and labels'),
      check('Last price label on the scale', 'priceLabel'),
      check('Last price line', 'priceLine'),
      check('Volume bars on the chart', 'volume'),
    ],
    canvas: () => {
      const bgRow = h('div', { class: 'cs-row' });
      const paintBg = () => clear(bgRow).append(h('span', { class: 'cs-lab grow' }, 'Background'), color('bg', theme.bg, 'Background colour'), resetBtn(['bg'], paintBg));
      paintBg();
      const gridRow = h('div', { class: 'cs-row' });
      const paintGrid = () => clear(gridRow).append(h('span', { class: 'cs-lab grow' }, 'Grid colour'), color('gridColor', theme.grid, 'Grid colour'), resetBtn(['gridColor'], paintGrid));
      paintGrid();
      const crossRow = h('div', { class: 'cs-row' });
      const paintCross = () => clear(crossRow).append(h('span', { class: 'cs-lab grow' }, 'Crosshair colour'), color('crossColor', theme.cross, 'Crosshair colour'), resetBtn(['crossColor'], paintCross));
      paintCross();
      const textRow = h('div', { class: 'cs-row' });
      const paintText = () => clear(textRow).append(h('span', { class: 'cs-lab grow' }, 'Scale text colour'), color('text', theme.ink, 'Scale text colour'), resetBtn(['text'], paintText));
      paintText();
      return [
        head('Chart'), bgRow,
        check('Vertical grid lines', 'gridV', draft.grid !== false), check('Horizontal grid lines', 'gridH', draft.grid !== false), gridRow,
        select('Crosshair', 'crosshair', [['', 'Long dashes'], ['dashed', 'Dashed'], ['dotted', 'Dotted'], ['solid', 'Solid'], ['none', 'Hidden']], ''),
        crossRow,
        head('Scales'), textRow,
        select('Text size', 'fontSize', [['', 'Default'], ...[10, 12, 13, 14, 16].map((n) => [String(n), n + ' px'])], ''),
        head('Other'),
        check('Symbol watermark', 'watermark', false),
      ];
    },
  };

  // ---- layout
  let tab = store.get('chart:settingsTab', 'symbol');
  const body = h('div', { class: 'cs-body' });
  const nav = h('div', { class: 'cs-tabs', role: 'tablist' });
  const paint = () => {
    clear(nav).append(...TABS.map(([id, label]) => h('button', { type: 'button', role: 'tab', class: 'cs-tab', 'aria-selected': String(id === tab), onClick: () => { tab = id; store.set('chart:settingsTab', id); paint(); } }, label)));
    clear(body).append(...panes[tab]());
  };
  paint();

  const tpl = h('select', { class: 'ipt cs-sel', 'aria-label': 'Template', onChange: () => {
    const v = tpl.value; tpl.value = '';
    if (v === 'save') { store.set(DEFAULT_KEY, { ...draft }); tplNote.textContent = 'Saved as your default for charts you have not changed.'; }
    if (v === 'apply') { draft = { ...(store.get(DEFAULT_KEY, {}) || {}) }; preview(); paint(); }
    if (v === 'reset') { draft = {}; preview(); paint(); }
  } }, h('option', { value: '' }, 'Template…'), h('option', { value: 'save' }, 'Save as my default'), h('option', { value: 'apply' }, 'Apply my default'), h('option', { value: 'reset' }, 'Reset to Trilens defaults'));
  const tplNote = h('span', { class: 'tiny muted cs-note' });
  const ok = h('button', { type: 'button', class: 'btn primary', onClick: () => {
    committed = true;
    workspace.set((w) => ({ ...w, cells: w.cells.map((c, i) => (i === o.index ? { ...c, scale: { ...draft } } : c)) }));
    bg.remove();
  } }, 'Ok');
  const cancel = h('button', { type: 'button', class: 'btn', onClick: () => bg.remove() }, 'Cancel');

  const bg = sheet('Settings · ' + o.symbol, h('div', { class: 'cs' }, nav, body), h('div', { class: 'cs-foot' }, tpl, tplNote, h('span', { class: 'grow' }), cancel, ok));
  bg.querySelector('.sheet').classList.add('cs-sheet');
  // closed without OK (Cancel, Close, Esc, backdrop): put the chart back as it was
  new MutationObserver((_, mo) => { if (!bg.isConnected) { mo.disconnect(); if (!committed) o.engine.setScale(saved); } }).observe(document.body, { childList: true });
  return bg;
}
