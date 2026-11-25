// Drawing tool rail (left edge of the chart) and the small bar that edits the selected drawing.
// Icons are constant SVG strings, like lib/dom.js icons.

import { h, clear } from '../../lib/dom.js';
import { workspace, setDraw } from '../store/workspace.js';

const ICONS = {
  cursor: '<path d="M6 3.5l12 7.2-5.3 1.4 3.2 5.8-2.3 1.3-3.2-5.8L6.5 17z"/>',
  trend: '<path d="M4.5 19.5l15-15"/><circle cx="4.5" cy="19.5" r="1.8"/><circle cx="19.5" cy="4.5" r="1.8"/>',
  ray: '<path d="M4.5 18l16-12"/><circle cx="4.5" cy="18" r="1.8"/><circle cx="12" cy="12.4" r="1.8"/>',
  hline: '<path d="M2.5 12h19"/><circle cx="12" cy="12" r="1.8"/>',
  fib: '<path d="M3 5h18M3 9.5h18M3 13h18M3 19h18"/><path d="M5 19L19 5" stroke-dasharray="2 2"/>',
  long: '<rect x="4" y="4" width="16" height="8" rx="1"/><rect x="4" y="12" width="16" height="6" rx="1" stroke-dasharray="2 2"/><path d="M12 9.5V5.5M10 7.5l2-2 2 2"/>',
  short: '<rect x="4" y="12" width="16" height="8" rx="1"/><rect x="4" y="6" width="16" height="6" rx="1" stroke-dasharray="2 2"/><path d="M12 14.5v4M10 16.5l2 2 2-2"/>',
  magnet: '<path d="M6 4v8a6 6 0 0 0 12 0V4"/><path d="M6 8h3M15 8h3"/><path d="M9 4v8a3 3 0 0 0 6 0V4"/>',
  eye: '<path d="M2.5 12s3.5-6.5 9.5-6.5S21.5 12 21.5 12 18 18.5 12 18.5 2.5 12 2.5 12z"/><circle cx="12" cy="12" r="2.8"/>',
  trash: '<path d="M4.5 7h15M9.5 7V4.5h5V7M6.5 7l1 13h9l1-13"/>',
};
function svg(name) {
  const s = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
  s.setAttribute('viewBox', '0 0 24 24'); s.setAttribute('fill', 'none'); s.setAttribute('stroke', 'currentColor');
  s.setAttribute('stroke-width', '1.6'); s.setAttribute('stroke-linecap', 'round'); s.setAttribute('stroke-linejoin', 'round'); s.setAttribute('aria-hidden', 'true');
  s.innerHTML = ICONS[name]; // constant strings above only
  return s;
}

const TOOLS = [
  ['cursor', 'Cursor (Esc)'],
  ['trend', 'Trend line (Alt+T)'],
  ['ray', 'Ray (Alt+R)'],
  ['hline', 'Horizontal level (Alt+H)'],
  ['fib', 'Fibonacci retracement (Alt+F)'],
  ['long', 'Long position: risk/reward measure (Alt+L)'],
  ['short', 'Short position: risk/reward measure (Alt+S)'],
];
const KEYS = { t: 'trend', r: 'ray', h: 'hline', f: 'fib', l: 'long', s: 'short' };
const SWATCHES = ['#f0b849', '#3987e5', '#2fcb92', '#ff7a73', '#9085e9', '#e8eef4'];

/** @param {import('../drawings/layer.js').DrawingLayer} layer */
export function createDrawRail(layer) {
  const btns = new Map();
  const rail = h('div', { class: 'dr-rail', role: 'toolbar', 'aria-label': 'Drawing tools', 'aria-orientation': 'vertical' });
  for (const [id, label] of TOOLS) {
    const b = h('button', { type: 'button', class: 'dr-btn', title: label, 'aria-label': label, onClick: () => pick(id) }, svg(id));
    btns.set(id, b); rail.append(b);
  }
  rail.append(h('span', { class: 'dr-sep' }));
  const magnet = h('button', { type: 'button', class: 'dr-btn', title: 'Magnet: snap to open/high/low/close', 'aria-label': 'Magnet', onClick: () => setDraw({ magnet: !workspace.get().draw.magnet }) }, svg('magnet'));
  const eye = h('button', { type: 'button', class: 'dr-btn', title: 'Hide or show all drawings', 'aria-label': 'Hide drawings', onClick: () => setDraw({ hidden: !workspace.get().draw.hidden }) }, svg('eye'));
  const trash = h('button', { type: 'button', class: 'dr-btn', title: 'Remove all drawings on this contract', 'aria-label': 'Remove all drawings', onClick: () => {
    if (layer.drawings.length && window.confirm(`Remove all ${layer.drawings.length} drawings on ${layer.symbol}?`)) layer.clearAll();
  } }, svg('trash'));
  rail.append(magnet, eye, trash);

  // selected-drawing bar
  const bar = h('div', { class: 'dr-bar hide', role: 'toolbar', 'aria-label': 'Selected drawing' });

  function pick(id) { layer.setTool(id); paint(); }
  function paint() {
    const w = workspace.get().draw;
    for (const [id, b] of btns) b.setAttribute('aria-pressed', String(layer.tool === id));
    magnet.setAttribute('aria-pressed', String(w.magnet));
    eye.setAttribute('aria-pressed', String(w.hidden));
    eye.title = w.hidden ? 'Show drawings' : 'Hide all drawings';
    paintBar();
  }
  function paintBar() {
    const d = layer.selectedDrawing();
    bar.classList.toggle('hide', !d || workspace.get().draw.hidden);
    if (!d) return;
    clear(bar);
    for (const c of SWATCHES) {
      const b = h('button', { type: 'button', class: 'dr-sw' + (d.color === c ? ' on' : ''), title: 'Colour', 'aria-label': 'Colour ' + c, onClick: () => { layer.patchSelected({ color: c }); } });
      b.style.background = c;
      bar.append(b);
    }
    bar.append(h('span', { class: 'dr-sep v' }));
    for (const wd of [1, 2, 3]) bar.append(h('button', { type: 'button', class: 'dr-w' + (d.width === wd ? ' on' : ''), title: `Line width ${wd}`, onClick: () => layer.patchSelected({ width: wd }) }, h('i', { style: { height: wd + 'px' } })));
    bar.append(h('span', { class: 'dr-sep v' }));
    bar.append(h('button', { type: 'button', class: 'dr-del', title: 'Delete (Del)', onClick: () => layer.deleteSelected() }, svg('trash')));
  }

  const onKey = (e) => {
    if (!e.altKey || e.ctrlKey || e.metaKey || (e.target && /^(INPUT|TEXTAREA|SELECT)$/.test(e.target.tagName))) return;
    const t = KEYS[e.key.toLowerCase()];
    if (t && rail.isConnected) { e.preventDefault(); pick(t); }
  };
  addEventListener('keydown', onKey);
  const unsub = workspace.subscribe((w) => w.draw, () => { paint(); layer.refresh(); });
  paint();

  return {
    rail, bar, paint,
    dispose() { removeEventListener('keydown', onKey); unsub(); },
  };
}
