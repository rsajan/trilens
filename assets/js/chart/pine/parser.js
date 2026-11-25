// Pine Script parser: tokens -> AST. Recursive descent, precedence climbing for expressions.
// Every node carries line/col so the editor console can point at the exact place.

import { lex, PineSyntaxError } from './lexer.js';

/** Numeric node kinds: the interpreter switches on these (a string switch compares one by one). */
export const K = Object.freeze(Object.fromEntries(['Num', 'Str', 'Bool', 'Color', 'Na', 'Ident', 'Hist', 'Unary', 'Binary', 'Ternary', 'If', 'Tuple', 'Call', 'Decl', 'TupleDecl', 'Assign', 'ExprStmt', 'FuncDef', 'For', 'While', 'Break', 'Continue'].map((k, i) => [k, i + 1])));

const TYPE_WORDS = new Set(['int', 'float', 'bool', 'string', 'color', 'series', 'simple', 'const', 'input', 'line', 'label', 'box', 'table', 'array']);
const BINARY = [
  ['or'],
  ['and'],
  ['==', '!='],
  ['<', '>', '<=', '>='],
  ['+', '-'],
  ['*', '/', '%'],
];

/**
 * @typedef {{ type: string, line: number, col: number, id?: number, [k: string]: any }} Node
 */

/** @param {string} src @returns {{ body: Node[], nodeCount: number }} */
export function parse(src) {
  const toks = lex(src);
  let pos = 0;
  let nextId = 1;

  const peek = (o = 0) => toks[Math.min(pos + o, toks.length - 1)];
  const at = (t, v) => { const k = peek(); return k.t === t && (v === undefined || k.v === v); };
  const atOp = (v) => at('OP', v);
  const atKw = (v) => at('KW', v);
  const next = () => toks[pos++];
  const fail = (msg, tok = peek()) => { throw new PineSyntaxError(msg, tok.line, tok.col); };
  const expectOp = (v) => { if (!atOp(v)) fail(`Expected '${v}' but found ${describe(peek())}`); return next(); };
  /** @returns {Node} */
  const node = (type, tok, props) => ({ type, k: K[type], line: tok.line, col: tok.col, id: nextId++, ...props });

  function describe(t) {
    if (t.t === 'EOF') return 'end of script';
    if (t.t === 'NL') return 'end of line';
    if (t.t === 'INDENT') return 'an indented block';
    if (t.t === 'DEDENT') return 'end of block';
    if (t.t === 'STR') return `"${t.v}"`;
    return `'${t.v}'`;
  }

  function endStmt() {
    if (at('NL')) { next(); return; }
    if (at('EOF') || at('DEDENT')) return;
    if (pos > 0 && toks[pos - 1].t === 'DEDENT') return; // statement ended with an indented block
    fail(`Unexpected ${describe(peek())}: expected end of line`);
  }

  function skipNL() { while (at('NL')) next(); }

  /** @returns {Node[]} */
  function block() {
    if (!at('NL')) fail('Expected a new line and an indented block');
    next();
    if (!at('INDENT')) fail('Expected an indented block (4 spaces)');
    next();
    const body = [];
    skipNL();
    while (!at('DEDENT') && !at('EOF')) { body.push(statement()); skipNL(); }
    if (at('DEDENT')) next();
    return body;
  }

  // find the index of the bracket that closes the one at toks[i]
  function matchClose(i) {
    const open = toks[i].v, close = open === '(' ? ')' : ']';
    let d = 0;
    for (let j = i; j < toks.length; j++) {
      const t = toks[j];
      if (t.t === 'OP' && t.v === open) d++;
      else if (t.t === 'OP' && t.v === close) { d--; if (d === 0) return j; }
      else if (t.t === 'EOF') break;
    }
    return -1;
  }

  /** @returns {Node} */
  function statement() {
    const tok = peek();
    if (tok.t === 'KW') {
      switch (tok.v) {
        case 'var': case 'varip': {
          next();
          if (at('ID') && TYPE_WORDS.has(peek().v) && peek(1).t === 'ID') next();
          if (!at('ID')) fail('Expected a variable name after var');
          const name = next().v;
          expectOp('=');
          const init = valueExpr();
          endStmt();
          return node('Decl', tok, { name, isVar: true, init });
        }
        case 'if': { const n = ifNode(); return node('ExprStmt', tok, { expr: n }); }
        case 'for': return forNode();
        case 'while': {
          next();
          const test = expr();
          const body = block();
          return node('While', tok, { test, body });
        }
        case 'break': next(); endStmt(); return node('Break', tok, {});
        case 'continue': next(); endStmt(); return node('Continue', tok, {});
        case 'switch': fail('switch is not supported yet: use if / else if');
        case 'import': case 'export': case 'method': case 'type': fail(`'${tok.v}' is not supported in the Trilens Pine runtime`);
        default: break;
      }
    }
    // typed declaration: float x = ...
    if (tok.t === 'ID' && TYPE_WORDS.has(tok.v) && peek(1).t === 'ID' && peek(2).t === 'OP' && peek(2).v === '=') {
      next();
      const nameTok = next();
      next();
      const init = valueExpr();
      endStmt();
      return node('Decl', nameTok, { name: nameTok.v, isVar: false, init });
    }
    // function definition: name(a, b = 1) => ...
    if (tok.t === 'ID' && peek(1).t === 'OP' && peek(1).v === '(') {
      const close = matchClose(pos + 1);
      if (close > 0 && toks[close + 1] && toks[close + 1].t === 'OP' && toks[close + 1].v === '=>') return funcDef();
    }
    // tuple declaration: [a, b, c] = f()
    if (tok.t === 'OP' && tok.v === '[') {
      const close = matchClose(pos);
      if (close > 0 && toks[close + 1] && toks[close + 1].t === 'OP' && toks[close + 1].v === '=') {
        next();
        const names = [];
        while (!atOp(']')) {
          if (!at('ID')) fail('Expected a variable name in the tuple');
          names.push(next().v);
          if (atOp(',')) next();
        }
        next(); expectOp('=');
        const init = valueExpr();
        endStmt();
        return node('TupleDecl', tok, { names, init });
      }
    }
    if (tok.t === 'ID' && peek(1).t === 'OP') {
      const op = peek(1).v;
      if (op === '=') {
        if (tok.v.includes('.')) fail(`Cannot declare '${tok.v}': names cannot contain dots`);
        next(); next();
        const init = valueExpr();
        endStmt();
        return node('Decl', tok, { name: tok.v, isVar: false, init });
      }
      if (op === ':=' || op === '+=' || op === '-=' || op === '*=' || op === '/=' || op === '%=') {
        next(); next();
        const value = valueExpr();
        endStmt();
        return node('Assign', tok, { name: tok.v, op, value });
      }
    }
    const e = expr();
    endStmt();
    return node('ExprStmt', tok, { expr: e });
  }

  // right side of = / := : an expression, or an if-expression block
  function valueExpr() {
    if (atKw('if')) return ifNode();
    return expr();
  }

  function ifNode() {
    const tok = next(); // if
    const test = expr();
    const cons = block();
    let alt = null;
    skipNLBeforeElse();
    if (atKw('else')) {
      next();
      if (atKw('if')) alt = [node('ExprStmt', peek(), { expr: ifNode() })];
      else alt = block();
    }
    return node('If', tok, { test, cons, alt });
  }
  // an `else` sits on its own line after the DEDENT that closed the if-block
  function skipNLBeforeElse() {
    let k = pos;
    while (toks[k] && toks[k].t === 'NL') k++;
    if (toks[k] && toks[k].t === 'KW' && toks[k].v === 'else') pos = k;
  }

  function forNode() {
    const tok = next();
    if (!at('ID')) fail('Expected a loop counter name after for');
    const name = next().v;
    expectOp('=');
    const from = expr();
    if (!atKw('to')) fail("Expected 'to' in the for loop");
    next();
    const to = expr();
    let step = null;
    if (atKw('by')) { next(); step = expr(); }
    const body = block();
    return node('For', tok, { name, from, to, step, body });
  }

  function funcDef() {
    const tok = next();
    if (tok.v.includes('.')) fail('Function names cannot contain dots', tok);
    expectOp('(');
    const params = [];
    while (!atOp(')')) {
      if (at('ID') && TYPE_WORDS.has(peek().v) && peek(1).t === 'ID') next();
      if (!at('ID')) fail('Expected a parameter name');
      const name = next().v;
      let def = null;
      if (atOp('=')) { next(); def = expr(); }
      params.push({ name, def });
      if (atOp(',')) next(); else if (!atOp(')')) fail("Expected ',' or ')' in the parameter list");
    }
    next(); expectOp('=>');
    let body;
    if (at('NL')) body = block();
    else { const e = valueExpr(); endStmt(); body = [node('ExprStmt', tok, { expr: e })]; }
    return node('FuncDef', tok, { name: tok.v, params, body });
  }

  /** @returns {Node} */
  function expr() {
    const test = binary(0);
    if (atOp('?')) {
      const tok = next();
      const cons = expr();
      expectOp(':');
      const alt = expr();
      return node('Ternary', tok, { test, cons, alt });
    }
    return test;
  }

  function binary(level) {
    if (level >= BINARY.length) return unary();
    let left = binary(level + 1);
    for (;;) {
      const t = peek();
      const isOp = (t.t === 'OP' || t.t === 'KW') && BINARY[level].includes(t.v);
      if (!isOp) return left;
      next();
      const right = binary(level + 1);
      left = node('Binary', t, { op: t.v, left, right });
    }
  }

  function unary() {
    const t = peek();
    if ((t.t === 'OP' && (t.v === '-' || t.v === '+')) || (t.t === 'KW' && t.v === 'not')) {
      next();
      return node('Unary', t, { op: t.v, arg: unary() });
    }
    return postfix(primary());
  }

  function postfix(n) {
    while (atOp('[')) {
      const t = next();
      const index = expr();
      expectOp(']');
      n = node('Hist', t, { target: n, index });
    }
    return n;
  }

  function primary() {
    const t = peek();
    if (t.t === 'NUM') { next(); return node('Num', t, { value: t.v }); }
    if (t.t === 'STR') { next(); return node('Str', t, { value: t.v }); }
    if (t.t === 'COLOR') { next(); return node('Color', t, { value: t.v }); }
    if (t.t === 'KW' && (t.v === 'true' || t.v === 'false')) { next(); return node('Bool', t, { value: t.v === 'true' }); }
    if (t.t === 'OP' && t.v === '(') { next(); const e = expr(); expectOp(')'); return e; }
    if (t.t === 'OP' && t.v === '[') {
      next();
      const items = [];
      while (!atOp(']')) { items.push(expr()); if (atOp(',')) next(); else if (!atOp(']')) fail("Expected ',' or ']'"); }
      next();
      return node('Tuple', t, { items });
    }
    if (t.t === 'ID') {
      next();
      if (atOp('(')) {
        next();
        const args = [], named = {};
        while (!atOp(')')) {
          if (at('ID') && peek(1).t === 'OP' && peek(1).v === '=') {
            const k = next().v; next();
            named[k] = expr();
          } else {
            if (Object.keys(named).length) fail('Positional arguments must come before named ones');
            args.push(expr());
          }
          if (atOp(',')) next(); else if (!atOp(')')) fail(`Expected ',' or ')' but found ${describe(peek())}`);
        }
        next();
        return node('Call', t, { name: t.v, args, named });
      }
      if (t.v === 'na') return node('Na', t, {});
      return node('Ident', t, { name: t.v });
    }
    if (t.t === 'KW' && t.v === 'if') return ifNode();
    return fail(`Unexpected ${describe(t)}`);
  }

  const body = [];
  skipNL();
  while (!at('EOF')) {
    if (at('DEDENT')) { next(); continue; }
    body.push(statement());
    skipNL();
  }
  return { body, nodeCount: nextId };
}
