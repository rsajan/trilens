// Watchlist panel: several named lists, colour flags, live last price and 24h change per row.
// Click a row to load it in the focused chart. Prices come from the same feed as the charts
// (one telemetry subscription per listed symbol, dropped when the list changes).

import { h, clear, sheet } from '../../lib/dom.js';
import { lockScreen, notPublished } from '../../lib/bundle.js';
import { refreshAutoLists } from '../store/auto-lists.js';
import { fmtNum } from '../engine/chart-engine.js';
import { kindLabel } from '../data/stocks.js';
import { promptDialog } from './dialogs.js';
import { watchlists, activeList, addList, renameList, deleteList, selectList, addToList, removeFromList, cycleFlag, moveInList } from '../store/library.js';

const decOf = (tick) => { const s = String(tick); return s.includes('e-') ? +s.split('e-')[1] : (s.split('.')[1] || '').length; };

/**
 * @param {{ getAdapter: () => any, getContracts: () => Promise<any[]>, currentSymbol: () => string, onPick: (symbol: string) => void, onClose: () => void }} o
 */
export function createWatchlist(o) {
  const listSel = h('select', { class: 'ipt wl-sel', 'aria-label': 'Watchlist' });
  listSel.addEventListener('change', () => selectList(listSel.value));
  const menuBtn = (label, title, fn) => h('button', { type: 'button', class: 'wl-mini', title, 'aria-label': title, onClick: fn }, label);
  const addSel = h('select', { class: 'ipt wl-add', 'aria-label': 'Add a contract to this list' });
  addSel.addEventListener('change', () => { if (addSel.value) addToList(activeList().id, addSel.value); addSel.value = ''; });
  const rows = h('div', { class: 'wl-rows', role: 'list' });
  const el = h('aside', { class: 'wl', 'aria-label': 'Watchlist' },
    h('div', { class: 'wl-head' },
      listSel,
      menuBtn('⚡', 'Build the 20 watchlists: 17 Scanner signals, US top 500, India top 500, Crypto (needs your Technical password; automatic once it is remembered)', () => fromSignals()),
      menuBtn('+', 'New list', async () => { const n = await promptDialog('New watchlist', 'Name', 'My list'); if (n) addList(n); }),
      menuBtn('✎', 'Rename this list', async () => { const l = activeList(); const n = await promptDialog('Rename watchlist', 'Name', l.name); if (n) renameList(l.id, n); }),
      menuBtn('🗑', 'Delete this list', () => { const l = activeList(); if (window.confirm(`Delete the list "${l.name}"?`)) deleteList(l.id); }),
      menuBtn('✕', 'Close the watchlist', () => o.onClose())),
    h('div', { class: 'wl-cols' }, h('span', null, 'Contract'), h('span', { class: 'right' }, 'Last'), h('span', { class: 'right' }, '24h')),
    rows,
    h('div', { class: 'wl-foot' }, addSel));

  let contracts = [];
  /** symbol -> { last, chg, cells } */
  const cells = new Map();
  let subs = [];
  let adapterRef = null;

  function unsubscribeAll() { subs.forEach((u) => u()); subs = []; }

  async function paint() {
    const w = watchlists.get();
    const list = activeList();
    clear(listSel).append(...w.lists.map((l) => h('option', { value: l.id }, `${l.name} (${l.items.length})`)));
    listSel.value = list.id;
    contracts = await o.getContracts().catch(() => []);
    const bySym = new Map(contracts.map((c) => [c.symbol, c]));
    clear(addSel).append(h('option', { value: '' }, '+ Add contract…'), ...contracts.filter((c) => !list.items.some((x) => x.symbol === c.symbol)).map((c) => h('option', { value: c.symbol }, `${c.symbol} · ${c.name}`)));

    unsubscribeAll();
    cells.clear();
    clear(rows);
    const cur = o.currentSymbol();
    const adapter = o.getAdapter();
    adapterRef = adapter;
    if (!list.items.length) rows.append(h('p', { class: 'muted small wl-empty' }, 'Empty list. Add a contract below.'));
    for (const item of list.items) {
      const c = bySym.get(item.symbol);
      const last = h('span', { class: 'num right wl-last' }, '—');
      const chg = h('span', { class: 'num right wl-chg' }, '');
      const flag = h('button', { type: 'button', class: 'wl-flag', title: 'Colour flag (click to change)', 'aria-label': 'Colour flag', onClick: (e) => { e.stopPropagation(); cycleFlag(list.id, item.symbol); } });
      if (item.flag) flag.style.background = item.flag;
      const actions = h('span', { class: 'wl-acts' },
        h('button', { type: 'button', class: 'wl-mini', title: 'Move up', 'aria-label': 'Move up', onClick: (e) => { e.stopPropagation(); moveInList(list.id, item.symbol, -1); } }, '↑'),
        h('button', { type: 'button', class: 'wl-mini', title: 'Move down', 'aria-label': 'Move down', onClick: (e) => { e.stopPropagation(); moveInList(list.id, item.symbol, 1); } }, '↓'),
        h('button', { type: 'button', class: 'wl-mini', title: 'Remove from list', 'aria-label': 'Remove from list', onClick: (e) => { e.stopPropagation(); removeFromList(list.id, item.symbol); } }, '✕'));
      const row = h('div', { class: 'wl-row' + (item.symbol === cur ? ' on' : '') + (c ? '' : ' off'), role: 'listitem', tabindex: '0', title: c ? c.name : 'Not offered by the current feed',
        onClick: () => { if (c) o.onPick(item.symbol); },
        onKeydown: (e) => { if (e.key === 'Enter' && c) o.onPick(item.symbol); } },
        flag, h('span', { class: 'wl-sym' }, item.symbol, h('small', null, c ? kindLabel(c) : 'Not on this feed')), last, chg, actions);
      rows.append(row);
      cells.set(item.symbol, { last, chg, row });
      if (c) {
        const dec = decOf(c.tick);
        let prev = NaN;
        subs.push(adapter.subscribeTelemetry(item.symbol, (t) => {
          if (adapterRef !== adapter) return;
          last.textContent = fmtNum(t.last, dec);
          if (Number.isFinite(prev) && t.last !== prev) { last.classList.remove('flash-up', 'flash-down'); void last.offsetWidth; last.classList.add(t.last > prev ? 'flash-up' : 'flash-down'); }
          prev = t.last;
          if (Number.isFinite(t.changePct24h)) {
            chg.textContent = (t.changePct24h >= 0 ? '+' : '') + t.changePct24h.toFixed(2) + '%';
            chg.className = 'num right wl-chg ' + (t.changePct24h >= 0 ? 'up' : 'down');
          }
        }));
      }
    }
  }

  const status = h('p', { class: 'tiny muted wl-status' });
  el.querySelector('.wl-foot').prepend(status);

  // The 20 automatic lists (17 signals, Crypto, US / India top 500), built here from your unlocked data.
  async function fromSignals(auto = false) {
    if (!auto) status.textContent = 'Opening your signal data…';
    const r = await refreshAutoLists(auto);
    if (auto || r.state === 'skipped') return;
    if (r.state === 'not-published') { status.textContent = ''; sheet('Signal watchlists', notPublished()); return; }
    if (r.state === 'locked') {
      status.textContent = '';
      const bg = sheet('Unlock your signals', lockScreen(r.env, () => { bg.remove(); fromSignals(); }));
      return;
    }
    const filled = r.lists.filter((l) => l.symbols.length).length;
    const total = r.lists.reduce((a, l) => a + l.symbols.length, 0);
    const first = watchlists.get().lists.find((l) => l.name === r.lists[0].name);
    if (first) selectList(first.id);
    status.textContent = `${r.lists.length} lists updated from your Scanner data (${filled} with symbols, ${total} symbols).${r.stocks ? '' : ' No end-of-day stock prices are published yet, so stock rows show no price. Run PUBLISH.bat (needs pandas).'}`;
  }

  const unsub = watchlists.subscribe((s) => s, paint);
  paint();
  fromSignals(true).catch((err) => console.error(err));

  return {
    el,
    /** Feed changed (contracts and prices come from a different adapter) or the focused symbol changed. */
    refresh: paint,
    markCurrent(symbol) { for (const [sym, c] of cells) c.row.classList.toggle('on', sym === symbol); },
    dispose() { unsub(); unsubscribeAll(); },
  };
}
