// Small, safe Markdown renderer: builds DOM nodes (never HTML strings), so documents
// pulled from disk cannot inject markup. Covers what the strategy specs use:
// headings, paragraphs, bold/italic/code, links, lists (nested), tables, quotes, code fences, rules.
import { h, safeUrl } from './dom.js';

function inline(text) {
  const out = [];
  let i = 0, buf = '';
  const flush = () => { if (buf) { out.push(buf); buf = ''; } };
  while (i < text.length) {
    const c = text[i];
    if (c === '\\' && i + 1 < text.length) { buf += text[i + 1]; i += 2; continue; }
    if (c === '`') {
      const j = text.indexOf('`', i + 1);
      if (j > i) { flush(); out.push(h('code', null, text.slice(i + 1, j))); i = j + 1; continue; }
    }
    if (c === '*' && text[i + 1] === '*') {
      const j = text.indexOf('**', i + 2);
      if (j > i + 2) { flush(); out.push(h('strong', null, ...inline(text.slice(i + 2, j)))); i = j + 2; continue; }
    }
    if ((c === '*' || c === '_') && text[i + 1] && text[i + 1] !== ' ' && text[i + 1] !== c) {
      const prev = text[i - 1];
      if (c === '*' || !prev || /[\s(]/.test(prev)) {
        let j = i + 1;
        while ((j = text.indexOf(c, j)) !== -1 && (text[j - 1] === ' ' || (c === '_' && /\w/.test(text[j + 1] || '')))) j++;
        if (j > i + 1) { flush(); out.push(h('em', null, ...inline(text.slice(i + 1, j)))); i = j + 1; continue; }
      }
    }
    if (c === '[') {
      const m = /^\[([^\]]+)\]\(([^)\s]+)\)/.exec(text.slice(i));
      if (m) {
        flush();
        const u = safeUrl(m[2]);
        out.push(u ? h('a', { href: u, target: '_blank', rel: 'noopener noreferrer' }, m[1]) : m[1]);
        i += m[0].length; continue;
      }
    }
    buf += c; i++;
  }
  flush();
  return out;
}

const isTableSep = (l) => /^\s*\|?\s*:?-{2,}:?\s*(\|\s*:?-{2,}:?\s*)*\|?\s*$/.test(l || '') && (l || '').includes('-');
const splitRow = (l) => l.trim().replace(/^\|/, '').replace(/\|$/, '').split(/(?<!\\)\|/).map((c) => c.trim().replace(/\\\|/g, '|'));
const indentOf = (l) => l.match(/^\s*/)[0].replace(/\t/g, '  ').length;
const LIST_RE = /^(\s*)([-*+]|\d+[.)])\s+(.*)$/;

function parseList(lines, start) {
  const first = LIST_RE.exec(lines[start]);
  const base = indentOf(lines[start]);
  const ordered = /\d/.test(first[2]);
  const el = h(ordered ? 'ol' : 'ul');
  let i = start;
  while (i < lines.length) {
    const m = LIST_RE.exec(lines[i]);
    if (!m) {
      // continuation line of the previous item
      if (lines[i].trim() && indentOf(lines[i]) > base && el.lastChild) { el.lastChild.append(' ', ...inline(lines[i].trim())); i++; continue; }
      break;
    }
    const ind = indentOf(lines[i]);
    if (ind < base) break;
    if (ind > base) {
      const [sub, next] = parseList(lines, i);
      if (el.lastChild) el.lastChild.append(sub); else el.append(h('li', null, sub));
      i = next; continue;
    }
    el.append(h('li', null, ...inline(m[3])));
    i++;
  }
  return [el, i];
}

export function renderMarkdown(src) {
  const root = h('div', { class: 'md' });
  const lines = String(src || '').replace(/\r\n?/g, '\n').split('\n');
  let i = 0;
  while (i < lines.length) {
    const line = lines[i];
    if (!line.trim()) { i++; continue; }
    // fenced code
    if (/^\s*```/.test(line)) {
      const buf = []; i++;
      while (i < lines.length && !/^\s*```/.test(lines[i])) buf.push(lines[i++]);
      i++;
      root.append(h('pre', null, h('code', null, buf.join('\n'))));
      continue;
    }
    const hm = /^(#{1,4})\s+(.*)$/.exec(line);
    if (hm) { root.append(h('h' + hm[1].length, null, ...inline(hm[2].replace(/\s*#+\s*$/, '')))); i++; continue; }
    if (/^\s*(-{3,}|\*{3,}|_{3,})\s*$/.test(line)) { root.append(h('hr')); i++; continue; }
    if (line.includes('|') && isTableSep(lines[i + 1])) {
      const head = splitRow(line); i += 2;
      const rows = [];
      while (i < lines.length && lines[i].includes('|') && lines[i].trim()) rows.push(splitRow(lines[i++]));
      const t = h('table', null,
        h('thead', null, h('tr', null, ...head.map((c) => h('th', null, ...inline(c))))),
        h('tbody', null, ...rows.map((r) => h('tr', null, ...head.map((_, k) => h('td', null, ...inline(r[k] ?? '')))))));
      root.append(h('div', { class: 'tw' }, t));
      continue;
    }
    if (/^\s*>/.test(line)) {
      const buf = [];
      while (i < lines.length && /^\s*>/.test(lines[i])) buf.push(lines[i++].replace(/^\s*>\s?/, ''));
      const inner = renderMarkdown(buf.join('\n'));
      const bq = h('blockquote'); while (inner.firstChild) bq.append(inner.firstChild);
      root.append(bq);
      continue;
    }
    if (LIST_RE.test(line)) { const [el, next] = parseList(lines, i); root.append(el); i = next; continue; }
    // paragraph
    const buf = [line.trim()]; i++;
    while (i < lines.length && lines[i].trim() && !/^(\s*```|#{1,4}\s|\s*>|\s*(-{3,}|\*{3,})\s*$)/.test(lines[i]) && !LIST_RE.test(lines[i]) && !(lines[i].includes('|') && isTableSep(lines[i + 1]))) buf.push(lines[i++].trim());
    root.append(h('p', null, ...inline(buf.join(' '))));
  }
  return root;
}
