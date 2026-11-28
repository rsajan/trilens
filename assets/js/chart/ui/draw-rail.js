// Drawing tool rail (left edge of the chart) and the small bar that edits the selected drawing.
// Icons are constant SVG strings, like lib/dom.js icons.

import { h, clear, sheet } from '../../lib/dom.js';
import { workspace, setDraw } from '../store/workspace.js';
import { drawStyles, saveDrawTemplate, deleteDrawTemplate, setDefaultStyle, defaultStyle } from '../store/library.js';
import { promptDialog } from './dialogs.js';

const TOOL_NAMES = { trend: 'trend lines', ray: 'rays', channel: 'parallel channels', hline: 'horizontal levels', fib: 'Fibonacci retracements', long: 'long positions', short: 'short positions', text: 'text notes' };
const DASHES = [['solid', 'Solid line', []], ['dashed', 'Dashed line', [5, 3]], ['dotted', 'Dotted line', [1.5, 2.5]]];
const styleOf = (d) => ({ color: d.color, width: d.width, dash: d.dash || 'solid' });

function swatch(style) {
  const c = document.createElement('canvas');
  c.width = 44; c.height = 14; c.className = 'dr-prev';
  const x = c.getContext('2d');
  x.strokeStyle = style.color; x.lineWidth = style.width;
  x.setLineDash(DASHES.find((q) => q[0] === style.dash)[2]);
  x.beginPath(); x.moveTo(2, 7); x.lineTo(42, 7); x.stroke();
  return c;
}

/** Template menu for the selected drawing's tool: apply, save, make default, delete. */
function templateSheet(L) {
  const d = L().selectedDrawing();
  if (!d) return;
  const type = d.type, label = TOOL_NAMES[type] || type;
  const box = h('div', { class: 'ledger' });
  const btn = (text, fn, primary) => h('button', { type: 'button', class: 'btn' + (primary ? ' primary' : ''), style: { minHeight: '36px', padding: '0 12px' }, onClick: fn }, text);
  const paint = () => {
    clear(box);
    const list = drawStyles.get().list.filter((t) => t.type === type);
    const def = defaultStyle(type);
    if (!list.length) box.append(h('p', { class: 'muted small', style: { padding: '8px 2px' } }, `No templates for ${label} yet.`));
    for (const t of list) {
      const isDef = def && def.color === t.style.color && def.width === t.style.width && def.dash === t.style.dash;
      box.append(h('div', { class: 'lrow', style: { minHeight: '52px' } },
        swatch(t.style), h('div', { class: 'who' }, h('b', null, t.name), isDef ? h('div', { class: 'name' }, 'Default for new ' + label) : null),
        h('div', { class: 'row' },
          btn('Apply', () => { L().patchSelected({ ...t.style }); bg.remove(); }, true),
          btn('Default', () => setDefaultStyle(type, t.style)),
          btn('Delete', () => deleteDrawTemplate(t.id)))));
    }
  };
  const unsub = drawStyles.subscribe((x) => x, paint);
  paint();
  const cur = L().selectedDrawing();
  const bg = sheet('Templates · ' + label,
    h('div', { class: 'row wrap', style: { gap: '8px', marginBottom: '10px' } },
      btn('Save this style…', async () => { const n = await promptDialog('Save drawing template', 'Name', `${label} ${cur.dash || 'solid'} ${cur.width}px`); if (n) saveDrawTemplate(n, type, styleOf(cur)); }),
      btn('Use this style for new ' + label, () => setDefaultStyle(type, styleOf(cur))),
      defaultStyle(type) ? btn('Reset default', () => setDefaultStyle(type, null)) : null),
    box,
    h('p', { class: 'muted small', style: { marginTop: '10px' } }, 'A template is a colour, line width and line style for one drawing tool. The default is used for every new drawing of that tool.'));
  new MutationObserver((_, o) => { if (!bg.isConnected) { o.disconnect(); unsub(); } }).observe(document.body, { childList: true });
}

const ICONS = {
  cursor: '<path d="M6 3.5l12 7.2-5.3 1.4 3.2 5.8-2.3 1.3-3.2-5.8L6.5 17z"/>',
  trend: '<path d="M4.5 19.5l15-15"/><circle cx="4.5" cy="19.5" r="1.8"/><circle cx="19.5" cy="4.5" r="1.8"/>',
  ray: '<path d="M4.5 18l16-12"/><circle cx="4.5" cy="18" r="1.8"/><circle cx="12" cy="12.4" r="1.8"/>',
  hline: '<path d="M2.5 12h19"/><circle cx="12" cy="12" r="1.8"/>',
  fib: '<path d="M3 5h18M3 9.5h18M3 13h18M3 19h18"/><path d="M5 19L19 5" stroke-dasharray="2 2"/>',
  long: '<rect x="4" y="4" width="16" height="8" rx="1"/><rect x="4" y="12" width="16" height="6" rx="1" stroke-dasharray="2 2"/><path d="M12 9.5V5.5M10 7.5l2-2 2 2"/>',
  channel: '<path d="M3.5 15.5l14-9M6.5 20.5l14-9"/><circle cx="3.5" cy="15.5" r="1.6"/><circle cx="17.5" cy="6.5" r="1.6"/><circle cx="20.5" cy="11.5" r="1.6"/>',
  text: '<path d="M5 6V4.5h14V6M12 4.5v15M9 19.5h6"/>',
  bell: '<path d="M6 16.5V11a6 6 0 0 1 12 0v5.5l1.5 2h-15z"/><path d="M10 20.5a2 2 0 0 0 4 0"/>',
  short: '<rect x="4" y="12" width="16" height="8" rx="1"/><rect x="4" y="6" width="16" height="6" rx="1" stroke-dasharray="2 2"/><path d="M12 14.5v4M10 16.5l2 2 2-2"/>',
  magnet: '<path d="M6 4v8a6 6 0 0 0 12 0V4"/><path d="M6 8h3M15 8h3"/><path d="M9 4v8a3 3 0 0 0 6 0V4"/>',
  eye: '<path d="M2.5 12s3.5-6.5 9.5-6.5S21.5 12 21.5 12 18 18.5 12 18.5 2.5 12 2.5 12z"/><circle cx="12" cy="12" r="2.8"/>',
  trash: '<path d="M4.5 7h15M9.5 7V4.5h5V7M6.5 7l1 13h9l1-13"/>',
  star: '<path d="M12 3.5l2.6 5.4 5.9.8-4.3 4.1 1 5.8L12 16.8l-5.2 2.8 1-5.8-4.3-4.1 5.9-.8z"/>',
  flip: '<path d="M4 8h13l-3-3M20 16H7l3 3"/>',
  grip: '<circle cx="9" cy="7" r="1.1"/><circle cx="15" cy="7" r="1.1"/><circle cx="9" cy="12" r="1.1"/><circle cx="15" cy="12" r="1.1"/><circle cx="9" cy="17" r="1.1"/><circle cx="15" cy="17" r="1.1"/>',
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
  ['channel', 'Parallel channel: three clicks (Alt+C)'],
  ['hline', 'Horizontal level (Alt+H)'],
  ['fib', 'Fibonacci retracement (Alt+F)'],
  ['long', 'Long position: risk/reward measure (Alt+L)'],
  ['short', 'Short position: risk/reward measure (Alt+S)'],
  ['text', 'Text note; double-click a note to edit it (Alt+N)'],
];
const KEYS = { t: 'trend', r: 'ray', c: 'channel', h: 'hline', f: 'fib', l: 'long', s: 'short', n: 'text' };
const SWATCHES = ['#f0b849', '#3987e5', '#2fcb92', '#ff7a73', '#9085e9', '#e8eef4'];

/** Right-click, or press and hold for half a second (touch), runs `fn` instead of a click. */
function onHold(el, fn) {
  el.addEventListener('contextmenu', (e) => { e.preventDefault(); fn(); });
  let t = null, held = false;
  el.addEventListener('pointerdown', (e) => { if (e.pointerType === 'mouse') return; held = false; t = setTimeout(() => { held = true; fn(); }, 500); });
  const stop = () => clearTimeout(t);
  el.addEventListener('pointerup', stop); el.addEventListener('pointerleave', stop); el.addEventListener('pointercancel', stop);
  el.addEventListener('click', (e) => { if (held) { e.stopImmediatePropagation(); e.preventDefault(); held = false; } }, true);
}

/**
 * @param {() => import('../drawings/layer.js').DrawingLayer} L  the focused cell's layer, read on every use
 * @param {{ onAlert?: (price: number) => void }} [hooks]
 */
export function createDrawRail(L, hooks = {}) {
  const btns = new Map();
  const rail = h('div', { class: 'dr-rail', role: 'toolbar', 'aria-label': 'Drawing tools', 'aria-orientation': 'vertical' });
  const favs = () => workspace.get().draw.favorites || [];
  const toggleFav = (id) => { const f = favs(); setDraw({ favorites: f.includes(id) ? f.filter((x) => x !== id) : [...f, id] }); };
  for (const [id, label] of TOOLS) {
    const b = h('button', { type: 'button', class: 'dr-btn', title: label + (id === 'cursor' ? '' : ' · right-click or long-press: add to favorites'), 'aria-label': label, onClick: () => pick(id) }, svg(id));
    if (id !== 'cursor') onHold(b, () => toggleFav(id));
    btns.set(id, b); rail.append(b);
  }
  rail.append(h('span', { class: 'dr-sep' }));
  const magnet = h('button', { type: 'button', class: 'dr-btn', title: 'Magnet: snap to open/high/low/close', 'aria-label': 'Magnet', onClick: () => setDraw({ magnet: !workspace.get().draw.magnet }) }, svg('magnet'));
  const eye = h('button', { type: 'button', class: 'dr-btn', title: 'Hide or show all drawings', 'aria-label': 'Hide drawings', onClick: () => setDraw({ hidden: !workspace.get().draw.hidden }) }, svg('eye'));
  const trash = h('button', { type: 'button', class: 'dr-btn', title: 'Remove all drawings on this contract', 'aria-label': 'Remove all drawings', onClick: () => {
    if (L() && L().drawings.length && window.confirm(`Remove all ${L().drawings.length} drawings on ${L().symbol}?`)) L().clearAll();
  } }, svg('trash'));
  const starBtn = h('button', { type: 'button', class: 'dr-btn', title: 'Favorites: choose the tools on the floating favorites bar', 'aria-label': 'Drawing favorites', onClick: () => favSheet() }, svg('star'));
  const flipBtn = h('button', { type: 'button', class: 'dr-btn', title: 'Toolbar along the top (horizontal) or the left edge (vertical)', 'aria-label': 'Horizontal or vertical toolbar', onClick: () => setDraw({ horizontal: !workspace.get().draw.horizontal }) }, svg('flip'));
  rail.append(magnet, eye, trash, h('span', { class: 'dr-sep' }), starBtn, flipBtn);

  // floating favorites bar (TradingView-style): starred tools, drag it by its grip
  const favBar = h('div', { class: 'dr-fav hide', role: 'toolbar', 'aria-label': 'Favorite drawing tools' });
  function favSheet() {
    const box = h('div', { class: 'ledger' });
    const paintList = () => {
      clear(box);
      for (const [id, label] of TOOLS.slice(1)) {
        const on = favs().includes(id);
        box.append(h('button', { type: 'button', class: 'lrow', style: { width: '100%', minHeight: '48px', textAlign: 'left' }, 'aria-pressed': String(on), onClick: () => { toggleFav(id); paintList(); } },
          h('span', { class: 'dr-fav-ic' + (on ? ' on' : '') }, svg('star')), svg(id), h('span', { class: 'grow' }, label.replace(/ \(.*\)$/, ''))));
      }
    };
    paintList();
    sheet('Drawing favorites', h('p', { class: 'muted small', style: { margin: '0 0 10px' } }, 'Starred tools sit on a small floating bar over the chart. Drag the bar by its dotted grip. Tip: right-click a tool (long-press on a phone) to star it.'), box);
  }
  function paintFav() {
    const w = workspace.get().draw, list = favs();
    favBar.classList.toggle('hide', !list.length || !w.panel);
    clear(favBar);
    const grip = h('span', { class: 'dr-grip', title: 'Drag to move', 'aria-hidden': 'true' }, svg('grip'));
    favBar.append(grip);
    for (const id of list) {
      const t = TOOLS.find((x) => x[0] === id);
      if (!t) continue;
      favBar.append(h('button', { type: 'button', class: 'dr-btn', title: t[1], 'aria-label': t[1], 'aria-pressed': String(L() && L().tool === id), onClick: () => pick(id) }, svg(id)));
    }
    if (w.favPos) { favBar.style.left = w.favPos.x + 'px'; favBar.style.top = w.favPos.y + 'px'; favBar.style.transform = 'none'; }
    else { favBar.style.left = ''; favBar.style.top = ''; favBar.style.transform = ''; }
    grip.addEventListener('pointerdown', (e) => {
      e.preventDefault();
      const host = favBar.offsetParent; if (!host) return;
      const hr = host.getBoundingClientRect(), br = favBar.getBoundingClientRect();
      const dx = e.clientX - br.left, dy = e.clientY - br.top;
      let pos = null;
      const move = (ev) => {
        const x = Math.max(0, Math.min(hr.width - br.width, ev.clientX - hr.left - dx));
        const y = Math.max(0, Math.min(hr.height - br.height, ev.clientY - hr.top - dy));
        pos = { x: Math.round(x), y: Math.round(y) };
        favBar.style.left = pos.x + 'px'; favBar.style.top = pos.y + 'px'; favBar.style.transform = 'none';
      };
      const up = () => { removeEventListener('pointermove', move); removeEventListener('pointerup', up); if (pos) setDraw({ favPos: pos }); };
      addEventListener('pointermove', move); addEventListener('pointerup', up);
    });
  }

  // selected-drawing bar
  const bar = h('div', { class: 'dr-bar hide', role: 'toolbar', 'aria-label': 'Selected drawing' });

  function pick(id) { if (L()) L().setTool(id); paint(); }
  function paint() {
    if (!L()) return; // no chart mounted yet
    const w = workspace.get().draw;
    for (const [id, b] of btns) { b.setAttribute('aria-pressed', String(L().tool === id)); b.classList.toggle('fav', favs().includes(id)); }
    rail.classList.toggle('horiz', !!w.horizontal);
    rail.setAttribute('aria-orientation', w.horizontal ? 'horizontal' : 'vertical');
    flipBtn.setAttribute('aria-pressed', String(!!w.horizontal));
    starBtn.setAttribute('aria-pressed', String(favs().length > 0));
    paintFav();
    magnet.setAttribute('aria-pressed', String(w.magnet));
    eye.setAttribute('aria-pressed', String(w.hidden));
    eye.title = w.hidden ? 'Show drawings' : 'Hide all drawings';
    paintBar();
  }
  function paintBar() {
    const d = L() && L().selectedDrawing();
    bar.classList.toggle('hide', !d || workspace.get().draw.hidden);
    if (!d) return;
    clear(bar);
    for (const c of SWATCHES) {
      const b = h('button', { type: 'button', class: 'dr-sw' + (d.color === c ? ' on' : ''), title: 'Colour', 'aria-label': 'Colour ' + c, onClick: () => { L().patchSelected({ color: c }); } });
      b.style.background = c;
      bar.append(b);
    }
    bar.append(h('span', { class: 'dr-sep v' }));
    for (const wd of [1, 2, 3]) bar.append(h('button', { type: 'button', class: 'dr-w' + (d.width === wd ? ' on' : ''), title: `Line width ${wd}`, onClick: () => L().patchSelected({ width: wd }) }, h('i', { style: { height: wd + 'px' } })));
    bar.append(h('span', { class: 'dr-sep v' }));
    for (const [id, title] of DASHES) bar.append(h('button', { type: 'button', class: 'dr-w dr-dash ' + id + ((d.dash || 'solid') === id ? ' on' : ''), title, 'aria-label': title, onClick: () => L().patchSelected({ dash: id }) }, h('i')));
    bar.append(h('span', { class: 'dr-sep v' }));
    bar.append(h('button', { type: 'button', class: 'dr-w dr-tpl', title: 'Drawing templates: save, apply, set default', 'aria-label': 'Drawing templates', onClick: () => templateSheet(L) }, 'Tpl'));
    if (d.type === 'hline' && hooks.onAlert) bar.append(h('button', { type: 'button', class: 'dr-w', title: 'Create a price alert at this level', 'aria-label': 'Alert at this level', onClick: () => hooks.onAlert(d.points[0].price) }, svg('bell')));
    bar.append(h('button', { type: 'button', class: 'dr-del', title: 'Delete (Del)', onClick: () => L().deleteSelected() }, svg('trash')));
  }

  const onKey = (e) => {
    if (!e.altKey || e.ctrlKey || e.metaKey || (e.target && /^(INPUT|TEXTAREA|SELECT)$/.test(e.target.tagName))) return;
    const t = KEYS[e.key.toLowerCase()];
    if (t && rail.isConnected) { e.preventDefault(); pick(t); }
  };
  addEventListener('keydown', onKey);
  const unsub = workspace.subscribe((w) => w.draw, () => { paint(); hooks.refreshAll ? hooks.refreshAll() : L().refresh(); });
  paint();

  return {
    rail, bar, favBar, paint,
    dispose() { removeEventListener('keydown', onKey); unsub(); },
  };
}
