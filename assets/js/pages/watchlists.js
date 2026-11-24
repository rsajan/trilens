import { h, icon, sheet } from '../lib/dom.js';
import { pageHead, chipGroup, dataTable } from '../lib/ui.js';
import { store } from '../lib/store.js';

const COUNT = 15;
const KEY = 'watchlists';

function defaults() {
  return Array.from({ length: COUNT }, (_, i) => ({ id: 'wl' + (i + 1), name: `Watch list ${i + 1}`, symbols: [] }));
}

function load() {
  const saved = store.get(KEY, null);
  if (!Array.isArray(saved) || saved.length !== COUNT) return defaults();
  return saved.map((w, i) => ({ id: w?.id || 'wl' + (i + 1), name: w?.name || `Watch list ${i + 1}`, symbols: Array.isArray(w?.symbols) ? w.symbols : [] }));
}

function save(lists) { store.set(KEY, lists); }

function normalizeSymbol(s) { return String(s || '').trim().toUpperCase().replace(/\s+/g, ''); }

export async function render(ctx) {
  ctx.setTitle('Watch Lists');
  const lists = load();
  let cur = lists[0].id;

  const root = h('div');
  root.append(pageHead('Watch Lists', 'Your own symbol lists, side by side. Add tickers, switch between lists, and rename any of them.'));

  const chipsBox = h('div');
  const body = h('div', { style: { marginTop: '18px' } });
  root.append(chipsBox, body);

  function paintChips() {
    chipsBox.replaceChildren(chipGroup(
      lists.map((w) => ({ id: w.id, label: w.name, count: w.symbols.length })),
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
          save(lists);
          bg.remove();
          paintChips(); paintBody();
        } }, 'Save')));
    setTimeout(() => { field.focus(); field.select(); }, 0);
  }

  function addSymbol(list, raw, input) {
    const sym = normalizeSymbol(raw);
    if (!sym) return;
    if (!list.symbols.includes(sym)) { list.symbols.push(sym); list.symbols.sort(); save(lists); paintChips(); paintBody(); }
    if (input) input.value = '';
  }

  function removeSymbol(list, sym) {
    list.symbols = list.symbols.filter((s) => s !== sym);
    save(lists);
    paintChips(); paintBody();
  }

  function paintBody() {
    const list = lists.find((w) => w.id === cur) || lists[0];
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
