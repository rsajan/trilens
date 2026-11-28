// Small dropdown menu anchored under a toolbar button. Closes on choice, outside click or Escape.

import { h } from '../../lib/dom.js';

let open = null;

/**
 * @param {HTMLElement} anchor
 * @param {{ label: string, hint?: string, icon?: Node, checked?: boolean, onClick: () => void }[]} items
 */
export function popMenu(anchor, items) {
  if (open) { const was = open.anchor; open.close(); if (was === anchor) return; } // second click on the same button closes it
  const menu = h('div', { class: 'cx-menu', role: 'menu' });
  for (const it of items) {
    if (it.sep) { menu.append(h('div', { class: 'cx-menu-sep', role: 'separator' })); continue; }
    if (it.header) { menu.append(h('div', { class: 'cx-menu-head' }, it.header)); continue; }
    menu.append(h('button', { type: 'button', role: 'menuitemradio', 'aria-checked': it.checked ? 'true' : 'false', class: 'cx-menu-item' + (it.checked ? ' on' : ''),
      onClick: () => { close(); it.onClick(); } },
      it.icon || (it.checked !== undefined ? h('span', { class: 'cx-menu-check', 'aria-hidden': 'true' }, it.checked ? '✓' : '') : null), h('span', { class: 'grow' }, it.label), it.hint ? h('span', { class: 'cx-menu-hint' }, it.hint) : null));
  }
  document.body.append(menu);
  const r = anchor.getBoundingClientRect();
  const w = menu.offsetWidth, mh = menu.offsetHeight;
  menu.style.left = Math.max(8, Math.min(r.left, innerWidth - w - 8)) + 'px';
  // open upwards when there is no room below (e.g. the chart settings button in the bottom corner)
  menu.style.top = (r.bottom + 4 + mh > innerHeight - 8 && r.top - 4 - mh > 8 ? r.top - 4 - mh : Math.min(r.bottom + 4, Math.max(8, innerHeight - mh - 8))) + 'px';
  anchor.setAttribute('aria-expanded', 'true');
  const onDown = (e) => { if (!menu.contains(e.target) && !anchor.contains(e.target)) close(); };
  const onKey = (e) => { if (e.key === 'Escape') close(); };
  function close() {
    menu.remove();
    anchor.setAttribute('aria-expanded', 'false');
    removeEventListener('pointerdown', onDown, true);
    removeEventListener('keydown', onKey);
    if (open && open.menu === menu) open = null;
  }
  addEventListener('pointerdown', onDown, true);
  addEventListener('keydown', onKey);
  open = { menu, anchor, close };
  setTimeout(() => { const first = menu.querySelector('.on') || menu.firstChild; if (first) first.focus(); }, 0);
}
