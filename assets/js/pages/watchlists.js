import { h, icon, sheet, fmt } from '../lib/dom.js';
import { pageHead, chipGroup, dataTable } from '../lib/ui.js';
import { store } from '../lib/store.js';
import * as sync from '../lib/sync.js';

const COUNT = 15;
const KEY = 'watchlists';
const PUSH_DELAY = 1500;

function defaults() {
  return Array.from({ length: COUNT }, (_, i) => ({ id: 'wl' + (i + 1), name: `Watch list ${i + 1}`, symbols: [] }));
}

function normalizeLists(raw) {
  const lists = Array.isArray(raw) && raw.length === COUNT ? raw : defaults();
  return lists.map((w, i) => ({ id: w?.id || 'wl' + (i + 1), name: w?.name || `Watch list ${i + 1}`, symbols: Array.isArray(w?.symbols) ? w.symbols : [] }));
}

// Local storage holds {updated_at, lists}; an older save from before sync existed was a bare
// array - treat that as updated_at 0 so a connected device's synced copy always wins over it.
function loadLocal() {
  const saved = store.get(KEY, null);
  if (Array.isArray(saved)) return { updated_at: 0, lists: normalizeLists(saved) };
  if (saved && Array.isArray(saved.lists)) return { updated_at: saved.updated_at || 0, lists: normalizeLists(saved.lists) };
  return { updated_at: 0, lists: defaults() };
}

function saveLocal(state) { store.set(KEY, state); }

function normalizeSymbol(s) { return String(s || '').trim().toUpperCase().replace(/\s+/g, ''); }

export async function render(ctx) {
  ctx.setTitle('Watch Lists');
  const state = loadLocal();
  let pushTimer = null;
  let syncMsg = '';

  if (sync.isConnected()) {
    try {
      const remote = await sync.pull();
      if (remote && typeof remote.updated_at === 'number' && Array.isArray(remote.lists)) {
        if (remote.updated_at > state.updated_at) {
          state.lists = normalizeLists(remote.lists);
          state.updated_at = remote.updated_at;
          saveLocal(state);
          syncMsg = 'Pulled your latest watch lists from your other device.';
        } else if (remote.updated_at < state.updated_at) {
          await sync.push(state);
          syncMsg = 'Synced.';
        } else {
          syncMsg = 'Synced.';
        }
      } else {
        await sync.push(state);
        syncMsg = 'Connected - this is now the shared copy.';
      }
    } catch (e) {
      syncMsg = 'Sync failed: ' + e.message;
    }
  }

  let cur = state.lists[0].id;

  const root = h('div');
  const syncLine = h('p', { class: 'tiny muted', style: { margin: '4px 0 0' } });
  root.append(pageHead('Watch Lists', 'Your own symbol lists, side by side. Add tickers, switch between lists, and rename any of them.',
    h('button', { class: 'icon-btn', type: 'button', 'aria-label': 'Sync across devices', title: 'Sync across devices', onClick: openSyncSheet }, icon('cloud'))));
  root.append(syncLine);

  const chipsBox = h('div', { style: { marginTop: '14px' } });
  const body = h('div', { style: { marginTop: '18px' } });
  root.append(chipsBox, body);

  function setSyncMsg(msg) { syncMsg = msg; syncLine.textContent = msg; }
  setSyncMsg(syncMsg);

  function persist() {
    state.updated_at = Date.now();
    saveLocal(state);
    if (sync.isConnected()) {
      setSyncMsg('Saving…');
      clearTimeout(pushTimer);
      pushTimer = setTimeout(() => {
        sync.push(state)
          .then(() => setSyncMsg('Synced ' + fmt.rel(new Date(state.updated_at).toISOString())))
          .catch((e) => setSyncMsg('Sync failed: ' + e.message));
      }, PUSH_DELAY);
    }
  }

  function openSyncSheet() {
    const connected = sync.isConnected();
    let bg;
    if (connected) {
      bg = sheet('Sync across devices',
        h('p', { class: 'soft small' }, 'Connected. This browser automatically pushes and pulls your watch lists from a private GitHub Gist whenever they change.'),
        h('div', { class: 'row', style: { marginTop: '14px' } },
          h('button', { class: 'btn', type: 'button', onClick: () => { sync.setToken(''); bg.remove(); setSyncMsg('Disconnected. Changes now stay on this device only.'); } }, 'Disconnect')));
    } else {
      const field = h('input', { class: 'ipt', type: 'password', placeholder: 'ghp_...', autocomplete: 'off', style: { width: '100%', marginTop: '10px' } });
      bg = sheet('Sync across devices',
        h('p', { class: 'soft small' }, 'Paste a GitHub personal access token scoped ONLY to "gist" - it cannot read or change your repos or anything else. Use the same token on every browser/device you want kept in sync.'),
        h('a', { href: 'https://github.com/settings/tokens/new?scopes=gist&description=Trilens%20watch%20list%20sync', target: '_blank', rel: 'noopener noreferrer' }, 'Create a gist-only token on GitHub →'),
        field,
        h('div', { class: 'row', style: { marginTop: '14px' } },
          h('button', { class: 'btn primary', type: 'button', onClick: async () => {
            const v = field.value.trim();
            if (!v) return;
            sync.setToken(v);
            bg.remove();
            setSyncMsg('Connecting…');
            try {
              const remote = await sync.pull();
              if (remote && Array.isArray(remote.lists) && remote.updated_at > state.updated_at) {
                state.lists = normalizeLists(remote.lists);
                state.updated_at = remote.updated_at;
                saveLocal(state);
                cur = state.lists[0].id;
                paintChips(); paintBody();
                setSyncMsg('Connected - pulled your watch lists from GitHub.');
              } else {
                await sync.push(state);
                setSyncMsg('Connected - this is now the shared copy.');
              }
            } catch (e) {
              setSyncMsg('Sync failed: ' + e.message);
            }
          } }, 'Connect')));
      setTimeout(() => field.focus(), 0);
    }
  }

  function paintChips() {
    chipsBox.replaceChildren(chipGroup(
      state.lists.map((w) => ({ id: w.id, label: w.name, count: w.symbols.length })),
      cur,
      (v) => { cur = v; paintBody(); },
    ));
  }

  function openRename(list) {
    const field = h('input', { class: 'ipt', type: 'text', value: list.name, maxlength: 40, style: { width: '100%' } });
    const bg = sheet('Rename watch list',
      field,
      h('div', { class: 'row', style: { marginTop: '14px', justifyContent: 'flex-end' } },
        h('button', { class: 'btn primary', type: 'button', onClick: () => {
          const v = field.value.trim();
          if (v) list.name = v;
          persist();
          bg.remove();
          paintChips(); paintBody();
        } }, 'Save')));
    setTimeout(() => { field.focus(); field.select(); }, 0);
  }

  function addSymbol(list, raw, input) {
    const sym = normalizeSymbol(raw);
    if (!sym) return;
    if (!list.symbols.includes(sym)) { list.symbols.push(sym); list.symbols.sort(); persist(); paintChips(); paintBody(); }
    if (input) input.value = '';
  }

  function removeSymbol(list, sym) {
    list.symbols = list.symbols.filter((s) => s !== sym);
    persist();
    paintChips(); paintBody();
  }

  function paintBody() {
    const list = state.lists.find((w) => w.id === cur) || state.lists[0];
    const input = h('input', { class: 'ipt', type: 'text', placeholder: 'Add symbol, e.g. AAPL', style: { flex: '1', minWidth: '0' } });
    input.addEventListener('keydown', (e) => { if (e.key === 'Enter') { e.preventDefault(); addSymbol(list, input.value, input); } });

    const table = list.symbols.length
      ? dataTable([
          { label: 'symbol', render: (s) => s },
          { label: '', align: 'r', render: (s) => h('button', { class: 'btn', type: 'button', style: { minHeight: '32px', padding: '0 12px' }, onClick: () => removeSymbol(list, s) }, 'Remove') },
        ], list.symbols, { compact: true })
      : h('div', { class: 'empty' }, h('b', null, 'No symbols yet'), 'Add a ticker above to start tracking it here.');

    body.replaceChildren(
      h('div', { class: 'row between wrap', style: { gap: '10px' } },
        h('h2', { style: { margin: 0 } }, list.name),
        h('button', { class: 'icon-btn', type: 'button', 'aria-label': 'Rename this watch list', title: 'Rename this watch list', onClick: () => openRename(list) }, icon('edit'))),
      h('div', { class: 'row', style: { marginTop: '14px', gap: '8px' } },
        input,
        h('button', { class: 'btn primary', type: 'button', onClick: () => addSymbol(list, input.value, input) }, 'Add')),
      h('div', { style: { marginTop: '16px' } }, table),
    );
  }

  paintChips();
  paintBody();
  return root;
}
