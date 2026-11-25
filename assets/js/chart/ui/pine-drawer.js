// Pine Editor drawer: editor + console, and the "My scripts" library. Docked under the chart,
// resizable by dragging its top edge, collapsible. Unsaved text is kept as a draft in the
// workspace, so a reload or a crash never loses what you typed.

import { h, clear } from '../../lib/dom.js';
import { createCodeEditor } from './code-editor.js';
import { promptDialog } from './dialogs.js';
import { BUILTINS, BUILTIN, NEW_SCRIPT } from '../indicators/builtins.js';
import { workspace, scripts, getScript, saveScript, renameScript, duplicateScript, deleteScript, setEditor } from '../store/workspace.js';

const titleOf = (src) => { const m = /\b(?:indicator|study)\s*\(\s*(?:title\s*=\s*)?"([^"]+)"/.exec(src); return m ? m[1] : 'Untitled script'; };

/**
 * @param {{ pine: import('../pine/client.js').PineEngine, onApply: (scriptId: string) => void, onRemoveFromChart: (scriptId: string) => void, isOnChart: (scriptId: string) => boolean }} o
 */
export function createPineDrawer(o) {
  const ed0 = workspace.get().editor;
  const initial = ed0.draft || (ed0.scriptId && getScript(ed0.scriptId) ? getScript(ed0.scriptId).source : NEW_SCRIPT);

  let checkTimer = 0, draftTimer = 0;
  /** @type {{ severity: string, line: number, col: number, message: string }[]} */
  let compileDiags = [];
  let runNote = null; // { ok, text, diags }

  const nameEl = h('span', { class: 'pd-name' });
  const dirtyEl = h('span', { class: 'pd-dirty', title: 'Unsaved changes' }, '●');
  const applyBtn = h('button', { type: 'button', class: 'btn primary pd-apply', onClick: () => apply() }, 'Add to chart');
  const saveBtn = h('button', { type: 'button', class: 'btn', onClick: () => save(), title: 'Save (Ctrl+S)' }, 'Save');
  const saveAsBtn = h('button', { type: 'button', class: 'btn', onClick: () => save(true) }, 'Save as…');
  const newBtn = h('button', { type: 'button', class: 'btn', onClick: () => openNew(NEW_SCRIPT) }, 'New');
  const tplSel = h('select', { class: 'ipt pd-tpl', 'aria-label': 'Start from a built-in indicator' },
    h('option', { value: '' }, 'Start from…'), BUILTINS.map((b) => h('option', { value: b.id }, b.name)));
  tplSel.addEventListener('change', () => { const b = BUILTIN[tplSel.value]; tplSel.value = ''; if (b) openNew(b.source.replace(/indicator\("([^"]+)"/, 'indicator("$1 (my copy)"')); });

  const editor = createCodeEditor({
    value: initial,
    onChange: (v) => { runNote = null; refreshState(); clearTimeout(draftTimer); draftTimer = setTimeout(() => setEditor({ draft: v }), 400); scheduleCheck(); },
    onSave: () => save(),
    onRun: () => apply(),
  });
  const consoleEl = h('div', { class: 'pd-console', role: 'log', 'aria-live': 'polite' });

  const tabEditor = h('button', { type: 'button', role: 'tab' }, 'Pine Editor');
  const tabLib = h('button', { type: 'button', role: 'tab' });
  const tabs = h('div', { class: 'tabs pd-tabs', role: 'tablist' }, tabEditor, tabLib);
  const closeBtn = h('button', { type: 'button', class: 'icon-btn pd-close', title: 'Close editor', 'aria-label': 'Close editor', onClick: () => setEditor({ open: false }) }, '✕');
  const grip = h('div', { class: 'pd-grip', role: 'separator', 'aria-orientation': 'horizontal', 'aria-label': 'Resize editor', tabindex: '0' });

  const editorPane = h('div', { class: 'pd-editor' },
    h('div', { class: 'pd-bar' }, h('span', { class: 'pd-title' }, nameEl, dirtyEl), h('span', { class: 'grow' }), tplSel, newBtn, saveBtn, saveAsBtn, applyBtn),
    h('div', { class: 'pd-split' }, editor.el, consoleEl));
  const libPane = h('div', { class: 'pd-lib' });
  const el = h('section', { class: 'pd', 'aria-label': 'Pine editor' }, grip, h('div', { class: 'pd-head' }, tabs, closeBtn), editorPane, libPane);

  tabEditor.addEventListener('click', () => setEditor({ tab: 'editor' }));
  tabLib.addEventListener('click', () => setEditor({ tab: 'library' }));

  // ---- resize by dragging the grip
  grip.addEventListener('pointerdown', (e) => {
    e.preventDefault();
    grip.setPointerCapture(e.pointerId);
    const startY = e.clientY, startH = el.getBoundingClientRect().height;
    const max = Math.max(200, window.innerHeight - 220);
    const move = (ev) => { el.style.height = Math.round(Math.min(max, Math.max(140, startH + (startY - ev.clientY)))) + 'px'; };
    const up = () => { grip.removeEventListener('pointermove', move); setEditor({ height: parseInt(el.style.height, 10) }); };
    grip.addEventListener('pointermove', move);
    grip.addEventListener('pointerup', up, { once: true });
    grip.addEventListener('pointercancel', up, { once: true });
  });
  grip.addEventListener('keydown', (e) => {
    if (e.key !== 'ArrowUp' && e.key !== 'ArrowDown') return;
    e.preventDefault();
    setEditor({ height: Math.max(140, workspace.get().editor.height + (e.key === 'ArrowUp' ? 40 : -40)) });
  });

  // ---- state
  function current() { const id = workspace.get().editor.scriptId; return id ? getScript(id) : null; }
  function refreshState() {
    const s = current();
    const src = editor.getValue();
    nameEl.textContent = s ? s.name : titleOf(src) + ' (unsaved)';
    dirtyEl.classList.toggle('hide', !!s && s.source === src);
    applyBtn.textContent = s && o.isOnChart(s.id) ? 'Update on chart' : 'Add to chart';
  }

  function scheduleCheck() {
    clearTimeout(checkTimer);
    checkTimer = setTimeout(async () => {
      try {
        const r = await o.pine.check(editor.getValue());
        if (!r) return;
        compileDiags = r.diagnostics;
        paintConsole(); // a result from running on the chart (runNote) stays until the text changes
      } catch (err) { compileDiags = [{ severity: 'error', line: 1, col: 1, message: String(err.message || err) }]; paintConsole(); }
    }, 350);
  }

  function paintConsole() {
    clear(consoleEl);
    const diags = runNote && runNote.diags ? runNote.diags : compileDiags;
    editor.setMarks(diags);
    const errs = diags.filter((d) => d.severity === 'error');
    const head = runNote ? runNote.text : errs.length ? `${errs.length} error${errs.length > 1 ? 's' : ''}` : 'Compiled. No errors.';
    consoleEl.append(h('div', { class: 'pd-msg ' + (errs.length ? 'err' : 'ok') }, (errs.length ? '✕ ' : '✓ ') + head));
    for (const d of diags) {
      consoleEl.append(h('button', { type: 'button', class: 'pd-msg ' + (d.severity === 'error' ? 'err' : 'warn'), onClick: () => editor.goToLine(d.line, d.col) },
        h('span', { class: 'pd-loc num' }, `${d.line}:${d.col}`), ' ', d.message));
    }
  }

  async function save(asNew = false) {
    const src = editor.getValue();
    const s = current();
    if (s && !asNew) { saveScript({ id: s.id, source: src }); setEditor({ draft: '' }); refreshState(); return s.id; }
    const name = await promptDialog(asNew ? 'Save as a new script' : 'Save script', 'Name', asNew && s ? s.name + ' (copy)' : titleOf(src));
    if (!name) return null;
    const created = saveScript({ name, source: src });
    setEditor({ scriptId: created.id, draft: '' });
    refreshState();
    return created.id;
  }

  async function apply() {
    const src = editor.getValue();
    let s = current();
    if (!s) { s = saveScript({ name: titleOf(src), source: src }); setEditor({ scriptId: s.id, draft: '' }); }
    else if (s.source !== src) { saveScript({ id: s.id, source: src }); setEditor({ draft: '' }); }
    refreshState();
    o.onApply(s.id);
  }

  function openScript(id) {
    const s = getScript(id);
    if (!s) return;
    setEditor({ open: true, tab: 'editor', scriptId: id, draft: '' });
    editor.setValue(s.source);
    refreshState(); scheduleCheck();
  }

  function openNew(source) {
    const s = current();
    const dirty = s ? s.source !== editor.getValue() : editor.getValue() !== NEW_SCRIPT && editor.getValue().trim() !== '';
    if (dirty && !window.confirm('Discard the unsaved changes in the editor?')) return;
    setEditor({ open: true, tab: 'editor', scriptId: null, draft: source });
    editor.setValue(source);
    refreshState(); scheduleCheck();
  }

  // ---- library
  function paintLibrary() {
    clear(libPane);
    const list = [...scripts.get()].sort((a, b) => b.updatedAt - a.updatedAt);
    tabLib.textContent = `My scripts (${list.length})`;
    libPane.append(h('div', { class: 'pd-bar' }, h('span', { class: 'muted small' }, 'Saved in this browser. Back up anything important: clearing site data deletes them.'), h('span', { class: 'grow' }),
      h('button', { type: 'button', class: 'btn', onClick: () => openNew(NEW_SCRIPT) }, 'New script')));
    if (!list.length) { libPane.append(h('div', { class: 'empty', style: { margin: '12px' } }, h('b', null, 'No scripts yet'), 'Write or paste a script in the Pine Editor tab and press Save.')); return; }
    const rows = h('div', { class: 'ledger pd-rows' });
    for (const s of list) {
      const on = o.isOnChart(s.id);
      rows.append(h('div', { class: 'lrow' },
        h('div', { class: 'who' }, h('b', null, s.name), h('div', { class: 'name' }, (on ? 'On chart · ' : '') + 'Edited ' + new Date(s.updatedAt).toLocaleString())),
        h('div', { class: 'row wrap pd-acts' },
          h('button', { type: 'button', class: 'btn', onClick: () => openScript(s.id) }, 'Edit'),
          h('button', { type: 'button', class: 'btn' + (on ? '' : ' primary'), onClick: () => (on ? o.onRemoveFromChart(s.id) : o.onApply(s.id)) }, on ? 'Remove from chart' : 'Add to chart'),
          h('button', { type: 'button', class: 'btn', onClick: async () => { const n = await promptDialog('Rename script', 'Name', s.name); if (n) renameScript(s.id, n); } }, 'Rename'),
          h('button', { type: 'button', class: 'btn', onClick: () => duplicateScript(s.id) }, 'Duplicate'),
          h('button', { type: 'button', class: 'btn', onClick: () => { if (window.confirm(`Delete "${s.name}"? It will also be removed from the chart.`)) deleteScript(s.id); } }, 'Delete'))));
    }
    libPane.append(rows);
  }

  function paintLayout() {
    const e = workspace.get().editor;
    el.classList.toggle('hide', !e.open);
    el.style.height = e.height + 'px';
    tabEditor.setAttribute('aria-selected', String(e.tab !== 'library'));
    tabLib.setAttribute('aria-selected', String(e.tab === 'library'));
    editorPane.classList.toggle('hide', e.tab === 'library');
    libPane.classList.toggle('hide', e.tab !== 'library');
  }

  const unsubs = [
    workspace.subscribe((w) => w.editor, paintLayout),
    workspace.subscribe((w) => w.cells[w.active].studies, () => { refreshState(); paintLibrary(); }),
    scripts.subscribe((s) => s, () => { refreshState(); paintLibrary(); }),
  ];
  paintLayout(); paintLibrary(); refreshState(); scheduleCheck();

  return {
    el,
    openScript,
    openNew,
    /** Diagnostics from running a script on the chart (runtime errors included). */
    showRun(scriptId, res, error) {
      const s = current();
      if (!s || s.id !== scriptId) return;
      if (error) runNote = { text: error, diags: [{ severity: 'error', line: 1, col: 1, message: error }] };
      else if (!res.ok || res.diagnostics.some((d) => d.severity === 'error')) runNote = { text: 'Error on the chart', diags: res.diagnostics };
      else {
        // a full run executes every bar; a live update only re-runs the bars that changed
        const ran = res.ran ?? res.bars;
        const work = ran >= res.bars ? `${res.bars.toLocaleString()} bars in ${res.ms} ms` : `${res.bars.toLocaleString()} bars · last update re-ran ${ran} bar${ran === 1 ? '' : 's'} in ${res.ms} ms`;
        runNote = { text: `On the chart · ${work} · ${res.plots.length} plot${res.plots.length === 1 ? '' : 's'}${res.inputs.length ? ' · ' + res.inputs.length + ' inputs' : ''}`, diags: res.diagnostics };
      }
      paintConsole();
    },
    dispose() { unsubs.forEach((u) => u()); clearTimeout(checkTimer); clearTimeout(draftTimer); },
  };
}
