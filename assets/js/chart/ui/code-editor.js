// Pine code editor: a native <textarea> (so typing, selection, IME, mobile keyboards, undo and
// accessibility all come from the browser) with a syntax-highlighted mirror drawn underneath it.
// Zero dependencies; Monaco would add ~3 MB to a phone PWA for the same job.
//
// Keys: Tab / Shift+Tab indent, Enter keeps indentation (+4 after `=>`, if, else, for, while),
// Ctrl/Cmd+/ toggles comments, Ctrl/Cmd+S saves, Ctrl/Cmd+Enter adds/updates on the chart.

import { h, clear } from '../../lib/dom.js';

const TOKEN = new RegExp([
  /(\/\/.*$)/.source,                                                     // 1 comment
  /("(?:[^"\\]|\\.)*"?|'(?:[^'\\]|\\.)*'?)/.source,                      // 2 string
  /(#[0-9a-fA-F]{8}\b|#[0-9a-fA-F]{6}\b)/.source,                         // 3 colour
  /(\b\d+\.?\d*(?:[eE][+-]?\d+)?\b|\B\.\d+\b)/.source,                   // 4 number
  /(\b(?:var|varip|if|else|for|to|by|while|and|or|not|true|false|na|switch|break|continue|import|export)\b)/.source, // 5 keyword
  /(\b(?:int|float|bool|string|color|series|simple|const)\b(?=\s+[A-Za-z_]))/.source, // 6 type
  /([A-Za-z_]\w*(?:\.[A-Za-z_]\w*)*)(?=\s*\()/.source,                    // 7 function call
  /(\b(?:open|high|low|close|volume|time|bar_index|hl2|hlc3|ohlc4|hlcc4|last_bar_index)\b)/.source, // 8 builtin series
  /([A-Za-z_]\w*(?:\.[A-Za-z_]\w*)+)/.source,                             // 9 namespaced constant
  /(=>|:=|[-+*/%]=?|==|!=|<=|>=|[<>?:=])/.source,                        // 10 operator
].join('|'), 'g');
const CLS = [null, 'cm', 'st', 'co', 'nu', 'kw', 'ty', 'fn', 'bi', 'ns', 'op'];

function highlightLine(text) {
  const frag = document.createDocumentFragment();
  let last = 0;
  TOKEN.lastIndex = 0;
  let m;
  while ((m = TOKEN.exec(text))) {
    if (m[0] === '') { TOKEN.lastIndex++; continue; }
    if (m.index > last) frag.append(text.slice(last, m.index));
    let k = 1; while (k < m.length && m[k] === undefined) k++;
    const span = document.createElement('span');
    span.className = 'tk-' + CLS[k];
    if (k === 3) span.style.setProperty('--sw', m[0].slice(0, 7));
    span.textContent = m[0];
    frag.append(span);
    last = m.index + m[0].length;
  }
  if (last < text.length) frag.append(text.slice(last));
  return frag;
}

/**
 * @param {{ value: string, onChange?: (v: string) => void, onSave?: () => void, onRun?: () => void, label?: string }} opts
 */
export function createCodeEditor(opts) {
  const ta = h('textarea', { class: 'ce-ta', spellcheck: 'false', autocapitalize: 'off', autocomplete: 'off', autocorrect: 'off', wrap: 'off', 'aria-label': opts.label || 'Pine Script source' });
  const hl = h('pre', { class: 'ce-hl', 'aria-hidden': 'true' });
  const gutter = h('div', { class: 'ce-gutter', 'aria-hidden': 'true' });
  const gutterInner = h('div', { class: 'ce-gutter-in' });
  gutter.append(gutterInner);
  const scroll = h('div', { class: 'ce-body' }, hl, ta);
  const el = h('div', { class: 'ce' }, gutter, scroll);
  ta.value = opts.value || '';

  /** @type {Map<number, 'error'|'warning'>} */
  let marks = new Map();
  let raf = 0;
  let lineCount = 0;

  function paint() {
    raf = 0;
    const lines = ta.value.split('\n');
    clear(hl);
    const frag = document.createDocumentFragment();
    lines.forEach((ln, i) => {
      const div = document.createElement('div');
      div.className = 'ln' + (marks.has(i + 1) ? ' m-' + marks.get(i + 1) : '');
      div.append(highlightLine(ln), '\n');
      frag.append(div);
    });
    hl.append(frag);
    if (lines.length !== lineCount || marks.size || gutterInner.dataset.marks) {
      lineCount = lines.length;
      clear(gutterInner);
      const g = document.createDocumentFragment();
      for (let i = 1; i <= lines.length; i++) {
        const d = document.createElement('div');
        d.textContent = String(i);
        if (marks.has(i)) d.className = 'm-' + marks.get(i);
        g.append(d);
      }
      gutterInner.append(g);
      gutterInner.dataset.marks = marks.size ? '1' : '';
    }
    sync();
  }
  const schedule = () => { if (!raf) raf = requestAnimationFrame(paint); };
  function sync() {
    hl.style.transform = `translate(${-ta.scrollLeft}px, ${-ta.scrollTop}px)`;
    gutterInner.style.transform = `translateY(${-ta.scrollTop}px)`;
  }

  // insertText keeps the browser's undo stack intact; setRangeText is the fallback
  function insert(text) {
    ta.focus();
    if (!document.execCommand || !document.execCommand('insertText', false, text)) {
      ta.setRangeText(text, ta.selectionStart, ta.selectionEnd, 'end');
      ta.dispatchEvent(new Event('input'));
    }
  }
  function lineBounds(pos) {
    const v = ta.value;
    const start = v.lastIndexOf('\n', pos - 1) + 1;
    let end = v.indexOf('\n', pos); if (end < 0) end = v.length;
    return [start, end];
  }
  function selectedLines() {
    const [s] = lineBounds(ta.selectionStart);
    const [, e] = lineBounds(Math.max(ta.selectionStart, ta.selectionEnd - (ta.selectionEnd > ta.selectionStart && ta.value[ta.selectionEnd - 1] === '\n' ? 1 : 0)));
    return [s, e];
  }
  function transformLines(fn) {
    const [s, e] = selectedLines();
    const block = ta.value.slice(s, e);
    const out = fn(block.split('\n')).join('\n');
    ta.setSelectionRange(s, e);
    insert(out);
    ta.setSelectionRange(s, s + out.length);
  }

  ta.addEventListener('keydown', (e) => {
    const mod = e.ctrlKey || e.metaKey;
    if (mod && e.key.toLowerCase() === 's') { e.preventDefault(); opts.onSave && opts.onSave(); return; }
    if (mod && e.key === 'Enter') { e.preventDefault(); opts.onRun && opts.onRun(); return; }
    if (mod && e.key === '/') {
      e.preventDefault();
      transformLines((ls) => {
        const all = ls.filter((l) => l.trim()).every((l) => /^\s*\/\//.test(l));
        return ls.map((l) => (!l.trim() ? l : all ? l.replace(/^(\s*)\/\/ ?/, '$1') : l.replace(/^(\s*)/, '$1// ')));
      });
      return;
    }
    if (e.key === 'Tab' && !e.altKey && !mod) {
      e.preventDefault();
      if (e.shiftKey) { transformLines((ls) => ls.map((l) => l.replace(/^( {1,4}|\t)/, ''))); return; }
      if (ta.selectionStart !== ta.selectionEnd && ta.value.slice(ta.selectionStart, ta.selectionEnd).includes('\n')) { transformLines((ls) => ls.map((l) => '    ' + l)); return; }
      insert('    ');
      return;
    }
    if (e.key === 'Enter' && !mod && !e.shiftKey && !e.isComposing) {
      e.preventDefault();
      const [s] = lineBounds(ta.selectionStart);
      const line = ta.value.slice(s, ta.selectionStart);
      let ind = (/^\s*/.exec(line) || [''])[0];
      const t = line.trim();
      if (/=>\s*(\/\/.*)?$/.test(t) || /^(if|else|for|while)\b/.test(t)) ind += '    ';
      insert('\n' + ind);
    }
  });
  ta.addEventListener('input', () => { schedule(); opts.onChange && opts.onChange(ta.value); });
  ta.addEventListener('scroll', sync, { passive: true });
  paint();

  return {
    el,
    getValue: () => ta.value,
    /** Replace the whole text (not undoable: used when switching scripts). */
    setValue(v) { if (v !== ta.value) { ta.value = v; ta.scrollTop = 0; ta.scrollLeft = 0; schedule(); } },
    /** @param {{ line: number, severity: 'error'|'warning' }[]} diags */
    setMarks(diags) {
      const next = new Map();
      for (const d of diags) if (!next.has(d.line) || d.severity === 'error') next.set(d.line, d.severity);
      marks = next;
      schedule();
    },
    goToLine(line, col = 1) {
      const lines = ta.value.split('\n');
      let pos = 0;
      for (let i = 0; i < Math.min(line - 1, lines.length); i++) pos += lines[i].length + 1;
      pos += Math.max(0, col - 1);
      ta.focus();
      ta.setSelectionRange(pos, pos);
      const lh = parseFloat(getComputedStyle(ta).lineHeight) || 19;
      ta.scrollTop = Math.max(0, (line - 4) * lh);
      sync();
    },
    focus: () => ta.focus(),
  };
}
