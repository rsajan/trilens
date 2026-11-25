// Pine Script lexer (the subset Trilens runs). Produces a flat token list with INDENT/DEDENT
// tokens for blocks, like Python. Pure function, no DOM: it runs inside the Pine worker.
//
// Pine rules it follows:
//  - a block is indented by 4 spaces (or one tab) more than its header line;
//  - a line indented by a number of spaces that is NOT a multiple of 4 continues the line above;
//  - newlines inside ( ) and [ ] do not end a statement;
//  - "//" starts a comment.

/** @typedef {{ t: string, v: any, line: number, col: number }} Token */

export class PineSyntaxError extends Error {
  /** @param {string} message @param {number} line @param {number} col */
  constructor(message, line, col) { super(message); this.line = line; this.col = col; }
}

const KEYWORDS = new Set(['var', 'varip', 'if', 'else', 'for', 'to', 'by', 'while', 'and', 'or', 'not', 'true', 'false', 'switch', 'import', 'export', 'method', 'type', 'break', 'continue']);
const OPS2 = new Set(['==', '!=', '<=', '>=', ':=', '+=', '-=', '*=', '/=', '%=', '=>']);
const OPS1 = new Set(['+', '-', '*', '/', '%', '<', '>', '=', '?', ':', ',', '(', ')', '[', ']', '.']);

/** @param {string} src @returns {Token[]} */
export function lex(src) {
  /** @type {Token[]} */
  const out = [];
  const lines = src.replace(/\r\n?/g, '\n').split('\n');
  const indents = [0];
  let depth = 0; // bracket depth
  let endLine = 1, endCol = 1; // where the last real token ended: errors at "end of line" point here
  for (let li = 0; li < lines.length; li++) {
    const raw = lines[li];
    const line = li + 1;
    // measure indentation (tab = 4 spaces)
    let ind = 0, p = 0;
    while (p < raw.length && (raw[p] === ' ' || raw[p] === '\t')) { ind += raw[p] === '\t' ? 4 : 1; p++; }
    const rest = raw.slice(p);
    if (rest === '' || rest.startsWith('//')) continue; // blank or comment-only line

    if (depth === 0) {
      const top = indents[indents.length - 1];
      const continuation = out.length > 0 && ind > top && ind % 4 !== 0;
      if (!continuation) {
        if (out.length && out[out.length - 1].t !== 'NL' && out[out.length - 1].t !== 'INDENT' && out[out.length - 1].t !== 'DEDENT') out.push({ t: 'NL', v: null, line: endLine, col: endCol });
        if (ind > top) {
          if (ind !== top + 4 && ind % 4 === 0) throw new PineSyntaxError('Block indented too far: use 4 spaces (or one tab) per level', line, 1);
          indents.push(ind);
          out.push({ t: 'INDENT', v: null, line, col: 1 });
        } else {
          while (ind < indents[indents.length - 1]) {
            indents.pop();
            out.push({ t: 'DEDENT', v: null, line, col: 1 });
          }
          if (ind !== indents[indents.length - 1]) throw new PineSyntaxError('Indentation does not match any outer block', line, 1);
        }
      }
    }

    let i = p;
    while (i < raw.length) {
      const c = raw[i];
      const col = i + 1;
      if (c === ' ' || c === '\t') { i++; continue; }
      if (c === '/' && raw[i + 1] === '/') break;
      // numbers: 12, 1.5, .5, 1e-3
      if (/[0-9]/.test(c) || (c === '.' && /[0-9]/.test(raw[i + 1] || ''))) {
        const m = /^(?:\d+\.?\d*|\.\d+)(?:[eE][+-]?\d+)?/.exec(raw.slice(i));
        out.push({ t: 'NUM', v: parseFloat(m[0]), line, col });
        i += m[0].length; continue;
      }
      if (c === '"' || c === "'") {
        let j = i + 1, s = '';
        while (j < raw.length && raw[j] !== c) {
          if (raw[j] === '\\' && j + 1 < raw.length) { const n = raw[j + 1]; s += n === 'n' ? '\n' : n === 't' ? '\t' : n; j += 2; }
          else s += raw[j++];
        }
        if (j >= raw.length) throw new PineSyntaxError('Unterminated string', line, col);
        out.push({ t: 'STR', v: s, line, col });
        i = j + 1; continue;
      }
      if (c === '#') {
        const m = /^#([0-9a-fA-F]{8}|[0-9a-fA-F]{6})\b/.exec(raw.slice(i));
        if (!m) throw new PineSyntaxError('Bad color literal: use #RRGGBB or #RRGGBBAA', line, col);
        out.push({ t: 'COLOR', v: '#' + m[1].toLowerCase(), line, col });
        i += m[0].length; continue;
      }
      if (/[A-Za-z_]/.test(c)) {
        // dotted names (ta.sma, color.red, input.int) are one identifier token
        const m = /^[A-Za-z_][A-Za-z0-9_]*(?:\.[A-Za-z_][A-Za-z0-9_]*)*/.exec(raw.slice(i));
        const w = m[0];
        if (KEYWORDS.has(w)) out.push({ t: 'KW', v: w, line, col });
        else out.push({ t: 'ID', v: w, line, col });
        i += w.length; continue;
      }
      const two = raw.slice(i, i + 2);
      if (OPS2.has(two)) { out.push({ t: 'OP', v: two, line, col }); i += 2; continue; }
      if (OPS1.has(c)) {
        if (c === '(' || c === '[') depth++;
        else if (c === ')' || c === ']') depth = Math.max(0, depth - 1);
        out.push({ t: 'OP', v: c, line, col }); i++; continue;
      }
      throw new PineSyntaxError(`Unexpected character '${c}'`, line, col);
    }
    if (out.length && out[out.length - 1].line === line) {
      endLine = line;
      endCol = raw.replace(/\s*\/\/.*$/, '').replace(/\s+$/, '').length + 1;
    }
  }
  const last = lines.length;
  if (out.length && out[out.length - 1].t !== 'NL') out.push({ t: 'NL', v: null, line: endLine, col: endCol });
  while (indents.length > 1) { indents.pop(); out.push({ t: 'DEDENT', v: null, line: last, col: 1 }); }
  out.push({ t: 'EOF', v: null, line: last, col: 1 });
  return out;
}
