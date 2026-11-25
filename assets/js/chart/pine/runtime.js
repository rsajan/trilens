// Pine Script interpreter for the Trilens chart. Runs inside a Web Worker (see worker.js).
//
// Execution model (same as TradingView): the script body runs once per bar, oldest to newest.
// Every variable is a series: `x[1]` reads the value x had at the end of the previous bar.
// `var x = ...` initialises once and then carries its value from bar to bar.
// Each `ta.*` call site owns its own incremental state, keyed by call-site id (plus the chain of
// user-function call sites it was reached through), so `ta.ema(close, 9)` written twice keeps two
// separate averages, exactly like Pine.
//
// Sandbox: this is an AST interpreter. User code is never passed to eval/Function, cannot reach
// globals, the DOM or the network, and loops share an iteration budget so a runaway `while`
// ends with an error instead of hanging. The worker host adds a wall-clock watchdog on top.

import { parse, K } from './parser.js';
import { PineSyntaxError } from './lexer.js';
import * as TA from './ta.js';
import { PINE_COLORS, toHex8, withTransp, rgb, gradient } from './colors.js';

const LOOP_BUDGET = 5_000_000;

/** @typedef {{ severity: 'error'|'warning', line: number, col: number, message: string }} Diagnostic */
/**
 * @typedef {Object} Bars  columnar OHLCV
 * @property {Float64Array} time  seconds (UTC)
 * @property {Float64Array} open @property {Float64Array} high @property {Float64Array} low
 * @property {Float64Array} close @property {Float64Array} volume
 * @property {number} length
 */
/**
 * @typedef {Object} InputDef
 * @property {string} key @property {string} title @property {'int'|'float'|'bool'|'color'|'string'|'source'} type
 * @property {any} defval @property {any} value @property {number=} minval @property {number=} maxval
 * @property {number=} step @property {string[]=} options @property {string=} group
 */
/**
 * @typedef {Object} PlotOut
 * @property {number} id @property {string} title @property {string} style @property {string|null} color
 * @property {number} linewidth @property {Float64Array} values @property {(string|null)[]|null} colors
 * @property {boolean} hidden @property {number} offset
 */

class PineRuntimeError extends Error {
  constructor(message, line, col) { super(message); this.line = line; this.col = col; }
}
const OPK = { and: 1, or: 2, '+': 3, '-': 4, '*': 5, '/': 6, '%': 7, '==': 8, '!=': 9, '<': 10, '>': 11, '<=': 12, '>=': 13 };
const BREAK = Symbol('break');
const CONTINUE = Symbol('continue');

const isNa = TA.isNa;
const num = (v) => (typeof v === 'number' ? v : typeof v === 'boolean' ? (v ? 1 : 0) : NaN);
const truthy = (v) => (typeof v === 'boolean' ? v : typeof v === 'number' ? !Number.isNaN(v) && v !== 0 : !!v);
const intArg = (v, name, node) => {
  const n = num(v);
  if (!Number.isFinite(n)) throw new PineRuntimeError(`${name} must be a number, got na`, node.line, node.col);
  return Math.round(n);
};
const lenArg = (v, name, node) => {
  const n = intArg(v, name, node);
  if (n < 1) throw new PineRuntimeError(`${name} must be at least 1 (got ${n})`, node.line, node.col);
  if (n > 5000) throw new PineRuntimeError(`${name} is too large (max 5000, got ${n})`, node.line, node.col);
  return n;
};

const SERIES = new Set(['open', 'high', 'low', 'close', 'volume', 'time', 'bar_index', 'hl2', 'hlc3', 'ohlc4', 'hlcc4', 'year', 'month', 'dayofmonth', 'dayofweek', 'hour', 'minute', 'last_bar_index', 'ta.tr']);
export const SOURCE_NAMES = ['open', 'high', 'low', 'close', 'hl2', 'hlc3', 'ohlc4', 'hlcc4', 'volume'];

const CONSTS = {
  ...PINE_COLORS,
  'plot.style_line': 'line', 'plot.style_linebr': 'line', 'plot.style_stepline': 'step', 'plot.style_steplinebr': 'step',
  'plot.style_histogram': 'histogram', 'plot.style_columns': 'columns', 'plot.style_area': 'area', 'plot.style_areabr': 'area',
  'plot.style_circles': 'circles', 'plot.style_cross': 'circles',
  'shape.triangleup': 'triangleup', 'shape.triangledown': 'triangledown', 'shape.arrowup': 'arrowup', 'shape.arrowdown': 'arrowdown',
  'shape.circle': 'circle', 'shape.square': 'square', 'shape.diamond': 'diamond', 'shape.cross': 'cross', 'shape.xcross': 'xcross',
  'shape.labelup': 'labelup', 'shape.labeldown': 'labeldown', 'shape.flag': 'flag',
  'location.abovebar': 'abovebar', 'location.belowbar': 'belowbar', 'location.top': 'top', 'location.bottom': 'bottom', 'location.absolute': 'absolute',
  'size.auto': 'auto', 'size.tiny': 'tiny', 'size.small': 'small', 'size.normal': 'normal', 'size.large': 'large', 'size.huge': 'huge',
  'hline.style_solid': 'solid', 'hline.style_dashed': 'dashed', 'hline.style_dotted': 'dotted',
  'display.all': 'all', 'display.none': 'none', 'display.pane': 'all', 'display.data_window': 'none', 'display.status_line': 'none', 'display.price_scale': 'all',
  'format.price': 'price', 'format.volume': 'volume', 'format.percent': 'percent', 'format.inherit': 'inherit',
  'scale.right': 'right', 'scale.left': 'left', 'scale.none': 'none',
  'math.pi': Math.PI, 'math.e': Math.E, 'math.phi': 1.618033988749895, 'math.rphi': 0.6180339887498949,
};

// Parameter names for every builtin, so named arguments (`ta.ema(source=close, length=9)`) work.
const P = {
  indicator: ['title', 'shorttitle', 'overlay', 'format', 'precision', 'scale', 'max_bars_back', 'timeframe', 'timeframe_gaps', 'explicit_plot_zorder', 'max_lines_count', 'max_labels_count', 'max_boxes_count', 'max_polylines_count', 'dynamic_requests', 'behind_chart'],
  plot: ['series', 'title', 'color', 'linewidth', 'style', 'trackprice', 'histbase', 'offset', 'join', 'editable', 'show_last', 'display', 'format', 'precision', 'force_overlay'],
  plotshape: ['series', 'title', 'style', 'location', 'color', 'offset', 'text', 'textcolor', 'editable', 'size', 'show_last', 'display', 'format', 'precision', 'force_overlay'],
  plotchar: ['series', 'title', 'char', 'location', 'color', 'offset', 'text', 'textcolor', 'editable', 'size', 'show_last', 'display', 'format', 'precision', 'force_overlay'],
  hline: ['price', 'title', 'color', 'linestyle', 'linewidth', 'editable', 'display'],
  bgcolor: ['color', 'offset', 'editable', 'show_last', 'title', 'display', 'force_overlay'],
  barcolor: ['color', 'offset', 'editable', 'show_last', 'title', 'display'],
  fill: ['hline1', 'hline2', 'color', 'title', 'editable', 'fillgaps', 'display'],
  alertcondition: ['condition', 'title', 'message'],
  input: ['defval', 'title', 'tooltip', 'inline', 'group', 'confirm'],
  'input.int': ['defval', 'title', 'minval', 'maxval', 'step', 'tooltip', 'inline', 'group', 'confirm', 'options', 'display'],
  'input.float': ['defval', 'title', 'minval', 'maxval', 'step', 'tooltip', 'inline', 'group', 'confirm', 'options', 'display'],
  'input.bool': ['defval', 'title', 'tooltip', 'inline', 'group', 'confirm', 'display'],
  'input.color': ['defval', 'title', 'tooltip', 'inline', 'group', 'confirm', 'display'],
  'input.string': ['defval', 'title', 'options', 'tooltip', 'inline', 'group', 'confirm', 'display'],
  'input.source': ['defval', 'title', 'tooltip', 'inline', 'group', 'display'],
  'ta.sma': ['source', 'length'], 'ta.ema': ['source', 'length'], 'ta.rma': ['source', 'length'], 'ta.wma': ['source', 'length'],
  'ta.vwma': ['source', 'length'], 'ta.stdev': ['source', 'length', 'biased'], 'ta.dev': ['source', 'length'], 'ta.cci': ['source', 'length'],
  'ta.highest': ['source', 'length'], 'ta.lowest': ['source', 'length'], 'ta.change': ['source', 'length'], 'ta.mom': ['source', 'length'], 'ta.roc': ['source', 'length'],
  'ta.rsi': ['source', 'length'], 'ta.macd': ['source', 'fastlen', 'slowlen', 'siglen'], 'ta.bb': ['series', 'length', 'mult'],
  'ta.atr': ['length'], 'ta.crossover': ['source1', 'source2'], 'ta.crossunder': ['source1', 'source2'], 'ta.cross': ['source1', 'source2'],
  'ta.vwap': ['source'], 'ta.stoch': ['source', 'high', 'low', 'length'], 'ta.cum': ['source'], 'ta.barssince': ['condition'],
  'ta.valuewhen': ['condition', 'source', 'occurrence'], 'ta.rising': ['source', 'length'], 'ta.falling': ['source', 'length'],
  nz: ['source', 'replacement'], na: ['x'], fixnan: ['source'],
  'math.abs': ['number'], 'math.round': ['number', 'precision'], 'math.floor': ['number'], 'math.ceil': ['number'], 'math.sqrt': ['number'],
  'math.pow': ['base', 'exponent'], 'math.log': ['number'], 'math.log10': ['number'], 'math.exp': ['number'], 'math.sign': ['number'], 'math.sum': ['source', 'length'],
  'math.max': null, 'math.min': null, 'math.avg': null, 'math.sin': ['angle'], 'math.cos': ['angle'], 'math.tan': ['angle'],
  'color.new': ['color', 'transp'], 'color.rgb': ['red', 'green', 'blue', 'transp'], 'color.from_gradient': ['value', 'bottom_value', 'top_value', 'bottom_color', 'top_color'],
  'str.tostring': ['value', 'format'], int: ['x'], float: ['x'], bool: ['x'],
};
P.study = P.indicator;

/** Map positional + named argument nodes onto a builtin's parameter order. */
function argNodes(node, params) {
  if (!params) return node.args;
  const out = node.args.slice();
  for (const [k, v] of Object.entries(node.named)) {
    const i = params.indexOf(k);
    if (i < 0) throw new PineRuntimeError(`${node.name}() has no parameter named '${k}'`, v.line, v.col);
    out[i] = v;
  }
  return out;
}

// ------------------------------------------------------------------------------------------
// Compile: parse + static checks. Returns diagnostics instead of throwing.

/**
 * @param {string} source
 * @returns {{ ast: any|null, diagnostics: Diagnostic[] }}
 */
export function compile(source) {
  /** @type {Diagnostic[]} */
  const diagnostics = [];
  let ast;
  try { ast = parse(source); }
  catch (e) {
    if (e instanceof PineSyntaxError) diagnostics.push({ severity: 'error', line: e.line, col: e.col, message: 'Syntax error: ' + e.message });
    else diagnostics.push({ severity: 'error', line: 1, col: 1, message: String(e && e.message || e) });
    return { ast: null, diagnostics };
  }
  const declared = new Set();
  const funcs = new Map();
  let header = null;
  const walkDecl = (stmts) => {
    for (const s of stmts) {
      if (s.type === 'Decl') declared.add(s.name);
      else if (s.type === 'TupleDecl') s.names.forEach((n) => declared.add(n));
      else if (s.type === 'FuncDef') { funcs.set(s.name, s); s.params.forEach((p) => declared.add(p.name)); walkDecl(s.body); }
      else if (s.type === 'For') { declared.add(s.name); walkDecl(s.body); }
      else if (s.type === 'While') walkDecl(s.body);
      else if (s.type === 'ExprStmt' && s.expr.type === 'If') walkIf(s.expr);
      if ((s.type === 'Decl' || s.type === 'Assign') && (s.init || s.value) && (s.init || s.value).type === 'If') walkIf(s.init || s.value);
    }
  };
  const walkIf = (n) => { walkDecl(n.cons); if (n.alt) walkDecl(n.alt); };
  walkDecl(ast.body);

  const err = (n, message) => diagnostics.push({ severity: 'error', line: n.line, col: n.col, message });
  const warn = (n, message) => diagnostics.push({ severity: 'warning', line: n.line, col: n.col, message });
  const visit = (n) => {
    if (!n || typeof n !== 'object') return;
    if (Array.isArray(n)) { n.forEach(visit); return; }
    switch (n.k) {
      case K.Call: {
        const name = n.name;
        if (name === 'strategy' || name.startsWith('strategy.')) err(n, 'strategy() scripts are out of scope here: Trilens charts indicators only, with no order simulation. Use indicator().');
        else if (name === 'library') err(n, 'library() scripts are not supported; paste the functions into your indicator.');
        else if (name.startsWith('request.')) err(n, `${name}() is not supported: scripts run on the chart's own bars only.`);
        else if (name.startsWith('line.') || name.startsWith('label.') || name.startsWith('box.') || name.startsWith('table.') || name.startsWith('array.') || name.startsWith('matrix.') || name.startsWith('map.')) err(n, `${name}() is not supported yet (drawing objects and collections are a later milestone).`);
        else if (name === 'indicator' || name === 'study') { if (header) err(n, 'Only one indicator() call is allowed'); header = n; }
        else if (!(name in P) && !funcs.has(name) && !BUILTIN_FNS.has(name)) err(n, `Unknown function '${name}'`);
        if (name === 'fill') warn(n, 'fill() is ignored for now: the area between plots is not shaded.');
        n.args.forEach(visit); Object.values(n.named).forEach(visit);
        return;
      }
      case K.Ident: {
        const nm = n.name;
        if (!declared.has(nm) && !SERIES.has(nm) && !(nm in CONSTS) && !BUILTIN_VARS.has(nm)) err(n, `Undeclared identifier '${nm}'`);
        return;
      }
      case K.Assign:
        if (!declared.has(n.name)) err(n, `Cannot assign to '${n.name}' with ${n.op}: declare it first with =`);
        visit(n.value); return;
      default:
        for (const [k, v] of Object.entries(n)) if (k !== 'type' && v && typeof v === 'object') visit(v);
    }
  };
  visit(ast.body);
  if (!header) diagnostics.push({ severity: 'error', line: 1, col: 1, message: 'Missing indicator("Title") declaration. Every script needs one (study() also works).' });
  return { ast: diagnostics.some((d) => d.severity === 'error') ? null : ast, diagnostics };
}

const BUILTIN_FNS = new Set(['ta.tr', 'math.max', 'math.min', 'math.avg', 'plotchar']);
const BUILTIN_VARS = new Set(['timeframe.period', 'timeframe.multiplier', 'timeframe.isintraday', 'timeframe.isdaily', 'timeframe.isweekly', 'timeframe.ismonthly', 'syminfo.ticker', 'syminfo.tickerid', 'syminfo.mintick', 'barstate.islast', 'barstate.isfirst', 'barstate.isconfirmed', 'barstate.isrealtime', 'barstate.ishistory', 'barstate.isnew']);

// ------------------------------------------------------------------------------------------
// Run

class Slot {
  constructor(n, isVar) { this.hist = new Array(n); this.isVar = isVar; this.init = false; }
}

/**
 * @param {any} ast  from compile()
 * @param {Bars} bars
 * @param {{ inputs?: Record<string, any>, symbol?: { ticker: string, mintick: number }, timeframe?: { period: string, seconds: number }, realtime?: boolean }} opts
 */
export function run(ast, bars, opts = {}) {
  return createSession(ast, opts).update(bars, false);
}

/** Deep copy of interpreter state (ta.* objects keep their class; typed arrays are copied). */
function cloneDeep(v) {
  if (v === null || typeof v !== 'object') return v;
  if (ArrayBuffer.isView(v)) return v.slice();
  if (Array.isArray(v)) return v.map(cloneDeep);
  const o = Object.create(Object.getPrototypeOf(v));
  for (const k of Object.keys(v)) o[k] = cloneDeep(v[k]);
  return o;
}

/**
 * A resumable run of one script over one growing series of bars, with TradingView's realtime
 * semantics: closed bars are executed once and committed; the forming bar is re-executed from the
 * committed state on every update ("rollback"), so a tick costs one bar, not the whole history.
 *
 * What a commit saves: every ta.* call-site state, plus each `var` slot's "already initialised"
 * flag. Everything else is indexed by bar (series history, plot values, colours, alert flags), so
 * re-running a bar simply overwrites its own index after beginBar() clears it.
 *
 * Contract for update(bars): `bars` is the same series as last time with the last bar possibly
 * changed and/or new bars appended. Anything else (history prepended, a different symbol) needs
 * a new session.
 *
 * @param {any} ast @param {Parameters<typeof run>[2]} opts
 */
export function createSession(ast, opts = {}) {
  let n = 0;
  /** @type {Bars} */
  let bars = null;
  const overrides = opts.inputs || {};
  const tf = opts.timeframe || { period: '60', seconds: 3600 };
  const sym = opts.symbol || { ticker: 'SYMBOL', mintick: 0.01 };

  /** @type {Diagnostic[]} */
  const diagnostics = [];
  const meta = { title: 'Indicator', shorttitle: '', overlay: false, precision: null, format: 'price' };
  /** @type {InputDef[]} */
  const inputs = [];
  const inputBySite = new Map();
  /** @type {PlotOut[]} */
  const plots = [];
  const plotBySite = new Map();
  const shapes = [];
  const shapeBySite = new Map();
  const hlines = [];
  const hlineSites = new Set();
  /** @type {{ title: string, message: string, at: Uint8Array }[]} */
  const alertconds = [];
  const alertBySite = new Map();
  let bg = null;
  let barColors = null;

  const slots = [];
  const ctxs = new Map(); // path -> Map<name, Slot>
  const states = new Map(); // path:id -> state
  const siteHist = new Map(); // path:id -> any[] (history of arbitrary expressions)
  const funcs = new Map();
  for (const s of ast.body) if (s.type === 'FuncDef') funcs.set(s.name, s);

  let i = 0;
  let loopOps = 0;
  let callDepth = 0;
  let cap = 0; // allocated length of per-bar output arrays (grows with the bars)
  let committed = -1; // bars [0, committed) are final and their end state is in `snap`
  let snap = null;
  let broken = false;

  const ctxFor = (path) => { let c = ctxs.get(path); if (!c) { c = new Map(); ctxs.set(path, c); } return c; };
  const global = ctxFor('');
  const topStates = new Array(ast.nodeCount + 1); // call sites reached directly from the script body
  const stateFor = (path, node, make) => {
    if (path === '') { let s = topStates[node.id]; if (!s) { s = make(); topStates[node.id] = s; } return s; }
    const k = path + ':' + node.id; let s = states.get(k); if (!s) { s = make(); states.set(k, s); } return s;
  };
  const declare = (ctx, name, isVar) => { let s = ctx.get(name); if (!s) { s = new Slot(0, isVar); ctx.set(name, s); slots.push(s); } return s; };
  const lookup = (ctx, name) => ctx.get(name) || global.get(name);

  const seriesAt = (name, k) => {
    const j = i - k;
    if (j < 0 || j >= n) return NaN;
    switch (name) {
      case 'open': return bars.open[j];
      case 'high': return bars.high[j];
      case 'low': return bars.low[j];
      case 'close': return bars.close[j];
      case 'volume': return bars.volume[j];
      case 'time': return bars.time[j] * 1000;
      case 'bar_index': return j;
      case 'last_bar_index': return n - 1;
      case 'hl2': return (bars.high[j] + bars.low[j]) / 2;
      case 'hlc3': return (bars.high[j] + bars.low[j] + bars.close[j]) / 3;
      case 'ohlc4': return (bars.open[j] + bars.high[j] + bars.low[j] + bars.close[j]) / 4;
      case 'hlcc4': return (bars.high[j] + bars.low[j] + bars.close[j] * 2) / 4;
      case 'ta.tr': {
        if (j === 0) return NaN;
        const pc = bars.close[j - 1];
        return Math.max(bars.high[j] - bars.low[j], Math.abs(bars.high[j] - pc), Math.abs(bars.low[j] - pc));
      }
      default: {
        const d = new Date(bars.time[j] * 1000);
        if (name === 'year') return d.getUTCFullYear();
        if (name === 'month') return d.getUTCMonth() + 1;
        if (name === 'dayofmonth') return d.getUTCDate();
        if (name === 'dayofweek') return d.getUTCDay() + 1;
        if (name === 'hour') return d.getUTCHours();
        if (name === 'minute') return d.getUTCMinutes();
        return NaN;
      }
    }
  };

  const builtinVar = (name) => {
    switch (name) {
      case 'timeframe.period': return tf.period;
      case 'timeframe.multiplier': return tf.seconds >= 86400 ? Math.max(1, Math.round(tf.seconds / 86400)) : Math.max(1, Math.round(tf.seconds / 60));
      case 'timeframe.isintraday': return tf.seconds < 86400;
      case 'timeframe.isdaily': return tf.seconds >= 86400 && tf.seconds < 604800;
      case 'timeframe.isweekly': return tf.seconds >= 604800 && tf.seconds < 2419200;
      case 'timeframe.ismonthly': return tf.seconds >= 2419200;
      case 'syminfo.ticker': case 'syminfo.tickerid': return sym.ticker;
      case 'syminfo.mintick': return sym.mintick;
      case 'barstate.islast': return i === n - 1;
      case 'barstate.isfirst': return i === 0;
      case 'barstate.isconfirmed': return i < n - 1 || !opts.realtime;
      case 'barstate.isrealtime': return i === n - 1 && !!opts.realtime;
      case 'barstate.ishistory': return !(i === n - 1 && opts.realtime);
      case 'barstate.isnew': return true;
      default: return undefined;
    }
  };

  // ---------------- expression evaluation ----------------
  function ev(node, ctx, path) {
    switch (node.k) {
      case K.Num: return node.value;
      case K.Str: return node.value;
      case K.Bool: return node.value;
      case K.Color: return toHex8(node.value);
      case K.Na: return NaN;
      case K.Ident: return identValue(node, ctx, path, 0);
      case K.Hist: {
        const k = intArg(ev(node.index, ctx, path), 'History offset', node);
        if (k < 0) throw new PineRuntimeError('History offset cannot be negative', node.line, node.col);
        const t = node.target;
        if (t.type === 'Ident') return identValue(t, ctx, path, k);
        // history of an arbitrary expression: keep its own per-bar buffer
        const key = path + ':' + node.id;
        let h = siteHist.get(key);
        if (!h) { h = []; siteHist.set(key, h); }
        h[i] = ev(t, ctx, path);
        const j = i - k;
        return j >= 0 && h[j] !== undefined ? h[j] : NaN;
      }
      case K.Unary: {
        const v = ev(node.arg, ctx, path);
        if (node.op === 'not') return !truthy(v);
        return node.op === '-' ? -num(v) : num(v);
      }
      case K.Binary: {
        const op = node.opk || (node.opk = OPK[node.op]);
        if (op === 1) return truthy(ev(node.left, ctx, path)) && truthy(ev(node.right, ctx, path));
        if (op === 2) return truthy(ev(node.left, ctx, path)) || truthy(ev(node.right, ctx, path));
        const a = ev(node.left, ctx, path), b = ev(node.right, ctx, path);
        if (typeof a === 'number' && typeof b === 'number') {
          switch (op) {
            case 3: return a + b; case 4: return a - b; case 5: return a * b; case 6: return a / b; case 7: return a % b;
            case 8: return a === b; case 9: return !(a === b) && !(a !== a && b !== b);
            case 10: return a < b; case 11: return a > b; case 12: return a <= b; case 13: return a >= b;
          }
        }
        switch (op) {
          case 3: return typeof a === 'string' || typeof b === 'string' ? strOf(a) + strOf(b) : num(a) + num(b);
          case 4: return num(a) - num(b);
          case 5: return num(a) * num(b);
          case 6: return num(a) / num(b);
          case 7: return num(a) % num(b);
          case 8: return typeof a === 'number' || typeof b === 'number' ? num(a) === num(b) : a === b;
          case 9: return typeof a === 'number' || typeof b === 'number' ? !(num(a) === num(b)) && !(isNa(a) && isNa(b)) : a !== b;
          case 10: return num(a) < num(b);
          case 11: return num(a) > num(b);
          case 12: return num(a) <= num(b);
          case 13: return num(a) >= num(b);
          default: throw new PineRuntimeError(`Unknown operator ${node.op}`, node.line, node.col);
        }
      }
      case K.Ternary: return truthy(ev(node.test, ctx, path)) ? ev(node.cons, ctx, path) : ev(node.alt, ctx, path);
      case K.If: {
        if (truthy(ev(node.test, ctx, path))) return execBlock(node.cons, ctx, path);
        if (node.alt) return execBlock(node.alt, ctx, path);
        return NaN;
      }
      case K.Tuple: return node.items.map((x) => ev(x, ctx, path));
      case K.Call: return call(node, ctx, path);
      default: throw new PineRuntimeError(`Cannot evaluate ${node.type}`, node.line, node.col);
    }
  }

  function identValue(node, ctx, path, k) {
    const name = node.name;
    const s = lookup(ctx, name);
    if (s) { const j = i - k; return j >= 0 && s.hist[j] !== undefined ? s.hist[j] : NaN; }
    if (SERIES.has(name)) return seriesAt(name, k);
    if (name in CONSTS) return CONSTS[name];
    const b = builtinVar(name);
    if (b !== undefined) return b;
    throw new PineRuntimeError(`'${name}' is not defined at this point`, node.line, node.col);
  }

  const strOf = (v) => (typeof v === 'number' ? (Number.isNaN(v) ? 'NaN' : String(+v.toFixed(8))) : String(v));

  // ---------------- statements ----------------
  function execBlock(stmts, ctx, path) {
    let last = NaN;
    for (const s of stmts) {
      const r = exec(s, ctx, path);
      if (r === BREAK || r === CONTINUE) return r;
      last = r;
    }
    return last;
  }

  function assignTo(slot, op, v, node) {
    const cur = slot.hist[i];
    let out = v;
    if (op === '+=') out = num(cur) + num(v);
    else if (op === '-=') out = num(cur) - num(v);
    else if (op === '*=') out = num(cur) * num(v);
    else if (op === '/=') out = num(cur) / num(v);
    else if (op === '%=') out = num(cur) % num(v);
    if (out === BREAK || out === CONTINUE) throw new PineRuntimeError('break/continue outside a loop', node.line, node.col);
    slot.hist[i] = out;
    return out;
  }

  function exec(s, ctx, path) {
    switch (s.k) {
      case K.Decl: {
        const slot = declare(ctx, s.name, s.isVar);
        if (s.isVar) {
          if (!slot.init) { slot.init = true; slot.hist[i] = ev(s.init, ctx, path); }
          return slot.hist[i];
        }
        return assignTo(slot, '=', ev(s.init, ctx, path), s);
      }
      case K.TupleDecl: {
        const v = ev(s.init, ctx, path);
        if (!Array.isArray(v)) throw new PineRuntimeError(`The right side returns one value, but ${s.names.length} names are on the left`, s.line, s.col);
        if (v.length < s.names.length) throw new PineRuntimeError(`The right side returns ${v.length} values, but ${s.names.length} names are on the left`, s.line, s.col);
        s.names.forEach((nm, k) => { if (nm !== '_') declare(ctx, nm, false).hist[i] = v[k]; });
        return v;
      }
      case K.Assign: {
        const slot = lookup(ctx, s.name);
        if (!slot) throw new PineRuntimeError(`'${s.name}' must be declared with = before it is reassigned`, s.line, s.col);
        return assignTo(slot, s.op, ev(s.value, ctx, path), s);
      }
      case K.ExprStmt: return ev(s.expr, ctx, path);
      case K.FuncDef: return NaN;
      case K.For: {
        const from = num(ev(s.from, ctx, path)), to = num(ev(s.to, ctx, path));
        if (Number.isNaN(from) || Number.isNaN(to)) return NaN;
        let step = s.step ? num(ev(s.step, ctx, path)) : (to >= from ? 1 : -1);
        if (!step || Number.isNaN(step)) throw new PineRuntimeError('Loop step cannot be 0 or na', s.line, s.col);
        if ((to - from) * step < 0) step = -step;
        const slot = declare(ctx, s.name, false);
        let last = NaN;
        for (let v = from; step > 0 ? v <= to : v >= to; v += step) {
          if (++loopOps > LOOP_BUDGET) throw new PineRuntimeError('Loop budget exceeded (too many iterations across all bars)', s.line, s.col);
          slot.hist[i] = v;
          const r = execBlock(s.body, ctx, path);
          if (r === BREAK) break;
          if (r !== CONTINUE) last = r;
        }
        return last;
      }
      case K.While: {
        let last = NaN;
        while (truthy(ev(s.test, ctx, path))) {
          if (++loopOps > LOOP_BUDGET) throw new PineRuntimeError('Loop budget exceeded: this while loop may never end', s.line, s.col);
          const r = execBlock(s.body, ctx, path);
          if (r === BREAK) break;
          if (r !== CONTINUE) last = r;
        }
        return last;
      }
      case K.Break: return BREAK;
      case K.Continue: return CONTINUE;
      default: throw new PineRuntimeError(`Unknown statement ${s.type}`, s.line, s.col);
    }
  }

  // ---------------- calls ----------------
  function callUser(fn, node, ctx, path) {
    if (++callDepth > 64) throw new PineRuntimeError('Too much recursion (Pine does not allow recursive functions)', node.line, node.col);
    const p2 = path + '>' + node.id;
    const local = ctxFor(p2);
    const args = node.args.slice();
    for (const [k, v] of Object.entries(node.named)) {
      const idx = fn.params.findIndex((p) => p.name === k);
      if (idx < 0) throw new PineRuntimeError(`${fn.name}() has no parameter named '${k}'`, v.line, v.col);
      args[idx] = v;
    }
    if (args.length > fn.params.length) throw new PineRuntimeError(`${fn.name}() takes ${fn.params.length} arguments, got ${args.length}`, node.line, node.col);
    fn.params.forEach((p, k) => {
      const a = args[k];
      const v = a ? ev(a, ctx, path) : p.def ? ev(p.def, local, p2) : NaN;
      if (!a && !p.def) throw new PineRuntimeError(`${fn.name}() is missing argument '${p.name}'`, node.line, node.col);
      declare(local, p.name, false).hist[i] = v;
    });
    const r = execBlock(fn.body, local, p2);
    callDepth--;
    return r === BREAK || r === CONTINUE ? NaN : r;
  }

  function registerInput(node, type, a, raw) {
    let def = inputBySite.get(node.id);
    if (!def) {
      const title = typeof a[1] === 'string' && a[1] ? a[1] : `Input ${inputs.length + 1}`;
      const key = inputs.some((x) => x.key === title) ? `${title} (${inputs.length + 1})` : title;
      def = { key, title, type, defval: raw, value: raw };
      if (type === 'int' || type === 'float') {
        if (Number.isFinite(num(a[2]))) def.minval = num(a[2]);
        if (Number.isFinite(num(a[3]))) def.maxval = num(a[3]);
        if (Number.isFinite(num(a[4]))) def.step = num(a[4]);
      }
      if (type === 'string' && Array.isArray(a[2])) def.options = a[2].map(String);
      if (type === 'source') def.options = SOURCE_NAMES.slice();
      const ov = overrides[key];
      if (ov !== undefined) {
        if ((type === 'int' || type === 'float') && Number.isFinite(+ov)) {
          let v = type === 'int' ? Math.round(+ov) : +ov;
          if (def.minval !== undefined) v = Math.max(def.minval, v);
          if (def.maxval !== undefined) v = Math.min(def.maxval, v);
          def.value = v;
        } else if (type === 'bool' && typeof ov === 'boolean') def.value = ov;
        else if (type === 'color' && toHex8(ov)) def.value = toHex8(ov);
        else if (type === 'string' && typeof ov === 'string' && (!def.options || def.options.includes(ov))) def.value = ov;
        else if (type === 'source' && SOURCE_NAMES.includes(ov)) def.value = ov;
      }
      inputs.push(def);
      inputBySite.set(node.id, def);
    }
    return def.value;
  }

  // Builtin handlers, looked up once per call site (a string switch here costs ~90 compares/call).
  const H = new Map();
  const def = (names, fn) => { for (const nm of names) H.set(nm, fn); };
    def(['indicator', 'study'], (name, node, ctx, path, an, a) => {
      if (i === 0) {
        meta.title = typeof a[0] === 'string' ? a[0] : 'Indicator';
        meta.shorttitle = typeof a[1] === 'string' ? a[1] : '';
        meta.overlay = a[2] === true;
        meta.format = typeof a[3] === 'string' ? a[3] : 'price';
        meta.precision = Number.isFinite(num(a[4])) ? num(a[4]) : null;
      }
      return NaN;

      // ----- inputs
    });
    def(['input'], (name, node, ctx, path, an, a) => {
      {
      const d = a[0];
      const type = typeof d === 'boolean' ? 'bool' : typeof d === 'number' ? (Number.isInteger(d) ? 'int' : 'float') : toHex8(d) ? 'color' : 'string';
      return registerInput(node, type, a, d);
      }
    });
    def(['input.int'], (name, node, ctx, path, an, a) => {
      return registerInput(node, 'int', a, Math.round(num(a[0])));
    });
    def(['input.float'], (name, node, ctx, path, an, a) => {
      return registerInput(node, 'float', a, num(a[0]));
    });
    def(['input.bool'], (name, node, ctx, path, an, a) => {
      return registerInput(node, 'bool', a, a[0] === true);
    });
    def(['input.color'], (name, node, ctx, path, an, a) => {
      return registerInput(node, 'color', a, toHex8(a[0]) || '#2962ffff');
    });
    def(['input.string'], (name, node, ctx, path, an, a) => {
      return registerInput(node, 'string', a, String(a[0] ?? ''));

      // ----- outputs
    });
    def(['plot'], (name, node, ctx, path, an, a) => {
      {
      let p = plotBySite.get(path + ':' + node.id);
      if (!p) {
        p = {
          id: plots.length, title: typeof a[1] === 'string' ? a[1] : `Plot ${plots.length + 1}`,
          style: typeof a[4] === 'string' ? a[4] : 'line', color: toHex8(a[2]) || '#2962ffff',
          linewidth: Number.isFinite(num(a[3])) ? Math.max(1, Math.min(4, num(a[3]))) : 1,
          values: new Float64Array(cap).fill(NaN), colors: null, hidden: a[11] === 'none',
          offset: Number.isFinite(num(a[7])) ? Math.round(num(a[7])) : 0,
        };
        plots.push(p);
        plotBySite.set(path + ':' + node.id, p);
      }
      p.values[i] = num(a[0]);
      if (an[2]) {
        const c = toHex8(a[2]);
        if (c !== p.color || p.colors) {
          if (!p.colors) p.colors = new Array(cap).fill(p.color);
          p.colors[i] = c; // null = gap (na colour)
        }
      }
      return p.id;
      }
    });
    def(['plotshape', 'plotchar'], (name, node, ctx, path, an, a) => {
      {
      const key = path + ':' + node.id;
      let s = shapeBySite.get(key);
      if (!s) {
        s = {
          title: typeof a[1] === 'string' ? a[1] : `Shape ${shapes.length + 1}`,
          style: name === 'plotchar' ? 'char' : (typeof a[2] === 'string' ? a[2] : 'xcross'),
          location: typeof a[3] === 'string' ? a[3] : 'abovebar',
          color: toHex8(a[4]) || '#2962ffff', size: typeof a[9] === 'string' ? a[9] : 'auto',
          text: name === 'plotchar' ? String(a[2] ?? '★') : (typeof a[6] === 'string' ? a[6] : ''),
          points: [],
        };
        shapes.push(s); shapeBySite.set(key, s);
      }
      const v = a[0];
      const on = typeof v === 'boolean' ? v : !isNa(v) && (s.location === 'absolute' || num(v) !== 0);
      if (on) s.points.push({ i, price: s.location === 'absolute' ? num(v) : NaN, color: toHex8(a[4]) || s.color });
      return NaN;
      }
    });
    def(['hline'], (name, node, ctx, path, an, a) => {
      {
      if (!hlineSites.has(node.id)) {
        hlineSites.add(node.id);
        hlines.push({ id: hlines.length, price: num(a[0]), title: typeof a[1] === 'string' ? a[1] : 'Level', color: toHex8(a[2]) || '#787b86ff', style: typeof a[3] === 'string' ? a[3] : 'dashed', width: Number.isFinite(num(a[4])) ? num(a[4]) : 1 });
      }
      return hlines.length - 1;
      }
    });
    def(['bgcolor'], (name, node, ctx, path, an, a) => {
      {
      const c = toHex8(a[0]);
      if (c) { if (!bg) bg = new Array(cap).fill(null); bg[i] = c; }
      return NaN;
      }
    });
    def(['barcolor'], (name, node, ctx, path, an, a) => {
      {
      const c = toHex8(a[0]);
      if (c) { if (!barColors) barColors = new Array(cap).fill(null); barColors[i] = c; }
      return NaN;
      }
    });
    def(['fill'], (name, node, ctx, path, an, a) => {
      return NaN; // compile() already warned that fill() is ignored
    });
    // alertcondition(condition, title, message): recorded per bar; the alert engine decides when to fire
    def(['alertcondition'], (name, node, ctx, path, an, a) => {
      const key = path + ':' + node.id;
      let ac = alertBySite.get(key);
      if (!ac) {
        const title = typeof a[1] === 'string' && a[1] ? a[1] : `Alert ${alertconds.length + 1}`;
        ac = { title, message: typeof a[2] === 'string' ? a[2] : '', at: new Uint8Array(cap) };
        alertconds.push(ac);
        alertBySite.set(key, ac);
      }
      ac.at[i] = truthy(a[0]) ? 1 : 0;
      return NaN;

      // ----- ta
    });
    def(['ta.sma'], (name, node, ctx, path, an, a) => {
      return stateFor(path, node, () => new TA.Sma(lenArg(a[1], 'length', node))).next(num(a[0]));
    });
    def(['ta.ema'], (name, node, ctx, path, an, a) => {
      return stateFor(path, node, () => new TA.Ema(lenArg(a[1], 'length', node))).next(num(a[0]));
    });
    def(['ta.rma'], (name, node, ctx, path, an, a) => {
      return stateFor(path, node, () => TA.rma(lenArg(a[1], 'length', node))).next(num(a[0]));
    });
    def(['ta.wma'], (name, node, ctx, path, an, a) => {
      return stateFor(path, node, () => new TA.Wma(lenArg(a[1], 'length', node))).next(num(a[0]));
    });
    def(['ta.vwma'], (name, node, ctx, path, an, a) => {
      {
      const s = stateFor(path, node, () => ({ pv: new TA.Sma(lenArg(a[1], 'length', node)), v: new TA.Sma(lenArg(a[1], 'length', node)) }));
      const vol = bars.volume[i];
      const x = s.pv.next(num(a[0]) * vol), y = s.v.next(vol);
      return x / y;
      }
    });
    def(['ta.stdev'], (name, node, ctx, path, an, a) => {
      return stateFor(path, node, () => new TA.Stdev(lenArg(a[1], 'length', node))).next(num(a[0]));
    });
    def(['ta.dev'], (name, node, ctx, path, an, a) => {
      return stateFor(path, node, () => new TA.Dev(lenArg(a[1], 'length', node))).next(num(a[0]));
    });
    def(['ta.cci'], (name, node, ctx, path, an, a) => {
      {
      const s = stateFor(path, node, () => ({ m: new TA.Sma(lenArg(a[1], 'length', node)), d: new TA.Dev(lenArg(a[1], 'length', node)) }));
      const v = num(a[0]); const m = s.m.next(v), d = s.d.next(v);
      return d === 0 ? 0 : (v - m) / (0.015 * d);
      }
    });
    def(['ta.highest', 'ta.lowest'], (name, node, ctx, path, an, a) => {
      {
      const one = a.length === 1 || a[1] === undefined;
      const len = lenArg(one ? a[0] : a[1], 'length', node);
      const v = one ? (name === 'ta.highest' ? bars.high[i] : bars.low[i]) : num(a[0]);
      return stateFor(path, node, () => new TA.Extreme(len, name === 'ta.highest')).next(v);
      }
    });
    def(['ta.change', 'ta.mom'], (name, node, ctx, path, an, a) => {
      {
      const len = a[1] === undefined ? 1 : lenArg(a[1], 'length', node);
      const v = a[0] === true || a[0] === false ? num(a[0]) : num(a[0]);
      const prev = stateFor(path, node, () => new TA.Lag(len)).next(v);
      return v - prev;
      }
    });
    def(['ta.roc'], (name, node, ctx, path, an, a) => {
      {
      const v = num(a[0]); const prev = stateFor(path, node, () => new TA.Lag(lenArg(a[1], 'length', node))).next(v);
      return 100 * (v - prev) / prev;
      }
    });
    def(['ta.rising', 'ta.falling'], (name, node, ctx, path, an, a) => {
      {
      const len = lenArg(a[1], 'length', node);
      const s = stateFor(path, node, () => new TA.Window(len + 1));
      s.push(num(a[0]));
      if (!s.full()) return false;
      for (let k = 0; k < len; k++) { const d = s.get(k) - s.get(k + 1); if (name === 'ta.rising' ? !(d > 0) : !(d < 0)) return false; }
      return true;
      }
    });
    def(['ta.rsi'], (name, node, ctx, path, an, a) => {
      return stateFor(path, node, () => new TA.Rsi(lenArg(a[1], 'length', node))).next(num(a[0]));
    });
    def(['ta.macd'], (name, node, ctx, path, an, a) => {
      {
      const s = stateFor(path, node, () => ({ f: new TA.Ema(lenArg(a[1] ?? 12, 'fastlen', node)), s: new TA.Ema(lenArg(a[2] ?? 26, 'slowlen', node)), g: new TA.Ema(lenArg(a[3] ?? 9, 'siglen', node)) }));
      const v = num(a[0]);
      const m = s.f.next(v) - s.s.next(v);
      const sig = s.g.next(m);
      return [m, sig, m - sig];
      }
    });
    def(['ta.bb'], (name, node, ctx, path, an, a) => {
      {
      const s = stateFor(path, node, () => ({ m: new TA.Sma(lenArg(a[1], 'length', node)), d: new TA.Stdev(lenArg(a[1], 'length', node)) }));
      const v = num(a[0]); const mid = s.m.next(v), dev = num(a[2]) * s.d.next(v);
      return [mid, mid + dev, mid - dev];
      }
    });
    def(['ta.tr'], (name, node, ctx, path, an, a) => {
      return stateFor(path, node, () => new TA.TrueRange()).next(bars.high[i], bars.low[i], bars.close[i], a[0] === true);
    });
    def(['ta.atr'], (name, node, ctx, path, an, a) => {
      {
      const s = stateFor(path, node, () => ({ tr: new TA.TrueRange(), r: TA.rma(lenArg(a[0], 'length', node)) }));
      return s.r.next(s.tr.next(bars.high[i], bars.low[i], bars.close[i], true));
      }
    });
    def(['ta.crossover'], (name, node, ctx, path, an, a) => {
      return stateFor(path, node, () => new TA.Cross(1)).next(num(a[0]), num(a[1]));
    });
    def(['ta.crossunder'], (name, node, ctx, path, an, a) => {
      return stateFor(path, node, () => new TA.Cross(-1)).next(num(a[0]), num(a[1]));
    });
    def(['ta.cross'], (name, node, ctx, path, an, a) => {
      return stateFor(path, node, () => new TA.Cross(0)).next(num(a[0]), num(a[1]));
    });
    def(['ta.vwap'], (name, node, ctx, path, an, a) => {
      return stateFor(path, node, () => new TA.Vwap()).next(a[0] === undefined ? (bars.high[i] + bars.low[i] + bars.close[i]) / 3 : num(a[0]), bars.volume[i], bars.time[i]);
    });
    def(['ta.stoch'], (name, node, ctx, path, an, a) => {
      {
      const len = lenArg(a[3], 'length', node);
      const s = stateFor(path, node, () => ({ h: new TA.Extreme(len, true), l: new TA.Extreme(len, false) }));
      const hh = s.h.next(num(a[1])), ll = s.l.next(num(a[2]));
      return hh === ll ? NaN : 100 * (num(a[0]) - ll) / (hh - ll);
      }
    });
    def(['ta.cum'], (name, node, ctx, path, an, a) => {
      { const s = stateFor(path, node, () => ({ v: 0 })); const v = num(a[0]); if (!Number.isNaN(v)) s.v += v; return s.v; }
    });
    def(['ta.barssince'], (name, node, ctx, path, an, a) => {
      {
      const s = stateFor(path, node, () => ({ last: -1 }));
      if (truthy(a[0])) s.last = i;
      return s.last < 0 ? NaN : i - s.last;
      }
    });
    def(['ta.valuewhen'], (name, node, ctx, path, an, a) => {
      {
      const occ = a[2] === undefined ? 0 : intArg(a[2], 'occurrence', node);
      const s = stateFor(path, node, () => ({ vals: [] }));
      if (truthy(a[0])) { s.vals.unshift(a[1]); if (s.vals.length > occ + 1) s.vals.length = occ + 1; }
      return s.vals[occ] ?? NaN;
      }

      // ----- math & utilities
    });
    def(['nz'], (name, node, ctx, path, an, a) => {
      return isNa(a[0]) ? (a[1] === undefined ? 0 : a[1]) : a[0];
    });
    def(['na'], (name, node, ctx, path, an, a) => {
      return isNa(a[0]);
    });
    def(['fixnan'], (name, node, ctx, path, an, a) => {
      { const s = stateFor(path, node, () => ({ v: NaN })); if (!isNa(a[0])) s.v = a[0]; return s.v; }
    });
    def(['math.abs'], (name, node, ctx, path, an, a) => {
      return Math.abs(num(a[0]));
    });
    def(['math.round'], (name, node, ctx, path, an, a) => {
      {
      if (a[1] === undefined) return Math.round(num(a[0]));
      const f = 10 ** intArg(a[1], 'precision', node); return Math.round(num(a[0]) * f) / f;
      }
    });
    def(['math.floor'], (name, node, ctx, path, an, a) => {
      return Math.floor(num(a[0]));
    });
    def(['math.ceil'], (name, node, ctx, path, an, a) => {
      return Math.ceil(num(a[0]));
    });
    def(['math.sqrt'], (name, node, ctx, path, an, a) => {
      return Math.sqrt(num(a[0]));
    });
    def(['math.pow'], (name, node, ctx, path, an, a) => {
      return num(a[0]) ** num(a[1]);
    });
    def(['math.log'], (name, node, ctx, path, an, a) => {
      return Math.log(num(a[0]));
    });
    def(['math.log10'], (name, node, ctx, path, an, a) => {
      return Math.log10(num(a[0]));
    });
    def(['math.exp'], (name, node, ctx, path, an, a) => {
      return Math.exp(num(a[0]));
    });
    def(['math.sign'], (name, node, ctx, path, an, a) => {
      return Math.sign(num(a[0]));
    });
    def(['math.sin'], (name, node, ctx, path, an, a) => {
      return Math.sin(num(a[0]));
    });
    def(['math.cos'], (name, node, ctx, path, an, a) => {
      return Math.cos(num(a[0]));
    });
    def(['math.tan'], (name, node, ctx, path, an, a) => {
      return Math.tan(num(a[0]));
    });
    def(['math.max'], (name, node, ctx, path, an, a) => {
      return a.some(isNa) ? NaN : Math.max(...a.map(num));
    });
    def(['math.min'], (name, node, ctx, path, an, a) => {
      return a.some(isNa) ? NaN : Math.min(...a.map(num));
    });
    def(['math.avg'], (name, node, ctx, path, an, a) => {
      return a.some(isNa) ? NaN : a.reduce((x, y) => x + num(y), 0) / a.length;
    });
    def(['math.sum'], (name, node, ctx, path, an, a) => {
      {
      const len = lenArg(a[1], 'length', node);
      const s = stateFor(path, node, () => new TA.Sma(len));
      return s.next(num(a[0])) * len;
      }
    });
    def(['int'], (name, node, ctx, path, an, a) => {
      return Number.isNaN(num(a[0])) ? NaN : Math.trunc(num(a[0]));
    });
    def(['float'], (name, node, ctx, path, an, a) => {
      return num(a[0]);
    });
    def(['bool'], (name, node, ctx, path, an, a) => {
      return truthy(a[0]);
    });
    def(['color.new'], (name, node, ctx, path, an, a) => {
      return withTransp(a[0], num(a[1]));
    });
    def(['color.rgb'], (name, node, ctx, path, an, a) => {
      return rgb(num(a[0]), num(a[1]), num(a[2]), a[3] === undefined ? 0 : num(a[3]));
    });
    def(['color.from_gradient'], (name, node, ctx, path, an, a) => {
      return gradient(num(a[0]), num(a[1]), num(a[2]), a[3], a[4]);
    });
    def(['str.tostring'], (name, node, ctx, path, an, a) => {
      {
      const v = a[0];
      if (typeof v !== 'number') return String(v);
      if (Number.isNaN(v)) return 'NaN';
      const f = typeof a[1] === 'string' ? a[1] : '';
      if (f === 'percent') return (v).toFixed(2) + '%';
      const m = /^#*\.?(#*|0*)$/.exec(f);
      if (f && m) { const d = (f.split('.')[1] || '').length; return v.toFixed(d); }
      return strOf(v);
      }
    });

  function call(node, ctx, path) {
    const name = node.name;
    const fn = funcs.get(name);
    if (fn) return callUser(fn, node, ctx, path);

    // input.source needs the *name* of its default series, so handle it before evaluating args
    if (name === 'input.source') {
      const an = argNodes(node, P[name]);
      const d = an[0] && an[0].type === 'Ident' && SOURCE_NAMES.includes(an[0].name) ? an[0].name : 'close';
      const title = an[1] ? ev(an[1], ctx, path) : undefined;
      const src = registerInput(node, 'source', [d, title], d);
      return seriesAt(src, 0);
    }

    const an = node._an || (node._an = argNodes(node, P[name] === undefined ? null : P[name]));
    const a = new Array(an.length);
    for (let k = 0; k < an.length; k++) a[k] = an[k] ? ev(an[k], ctx, path) : undefined;

    const h = H.get(name);
    if (!h) throw new PineRuntimeError(`Function '${name}' is not available`, node.line, node.col);
    return h(name, node, ctx, path, an, a);
  }

  // ---------------- bar execution ----------------
  /** Make room for N bars in every per-bar output array. */
  function grow(N) {
    if (N <= cap) return;
    const next = cap === 0 ? N : Math.ceil(N * 1.25) + 16;
    for (const p of plots) {
      const v = new Float64Array(next).fill(NaN); v.set(p.values.subarray(0, cap)); p.values = v;
      if (p.colors) { const old = p.colors; p.colors = new Array(next).fill(p.color); for (let k = 0; k < cap; k++) p.colors[k] = old[k]; }
    }
    for (const ac of alertconds) { const at = new Uint8Array(next); at.set(ac.at.subarray(0, cap)); ac.at = at; }
    if (bg) for (let k = cap; k < next; k++) bg[k] = null;
    if (barColors) for (let k = cap; k < next; k++) barColors[k] = null;
    cap = next;
  }

  /** Clear bar k's outputs, so a re-executed bar cannot keep a value from an earlier tick. */
  function beginBar(k) {
    for (const p of plots) { p.values[k] = NaN; if (p.colors) p.colors[k] = p.color; }
    for (const ac of alertconds) ac.at[k] = 0;
    if (bg) bg[k] = null;
    if (barColors) barColors[k] = null;
    for (const sh of shapes) while (sh.points.length && sh.points[sh.points.length - 1].i >= k) sh.points.pop();
    for (const h of siteHist.values()) if (h.length > k) h[k] = undefined;
  }

  function execBar(k) {
    i = k;
    for (let q = 0; q < slots.length; q++) {
      const s = slots[q];
      s.hist[k] = s.isVar && k > 0 ? s.hist[k - 1] : NaN;
    }
    callDepth = 0;
    for (const stmt of ast.body) {
      const r = exec(stmt, global, '');
      if (r === BREAK || r === CONTINUE) throw new PineRuntimeError('break/continue used outside a loop', stmt.line, stmt.col);
    }
  }

  function snapshot() {
    const top = new Map();
    topStates.forEach((v, id) => { if (v !== undefined) top.set(id, cloneDeep(v)); });
    const rest = new Map();
    for (const [k, v] of states) rest.set(k, cloneDeep(v));
    return { top, rest, inits: slots.map((x) => x.init) };
  }

  function restore() {
    topStates.fill(undefined);
    for (const [id, v] of snap.top) topStates[id] = cloneDeep(v);
    states.clear();
    for (const [k, v] of snap.rest) states.set(k, cloneDeep(v));
    slots.forEach((x, q) => { x.init = q < snap.inits.length ? snap.inits[q] : false; });
  }

  const out = (copy) => {
    const cut = (a) => (copy ? a.slice(0, n) : a.subarray(0, n));
    return {
      plots: plots.map((p) => ({ ...p, values: cut(p.values), colors: p.colors ? p.colors.slice(0, n) : null })),
      shapes: shapes.map((sh) => ({ ...sh, points: copy ? sh.points.slice() : sh.points })),
      alertconds: alertconds.map((ac) => ({ ...ac, at: cut(ac.at) })),
      bgcolors: bg ? bg.slice(0, n) : null,
      barcolors: barColors ? barColors.slice(0, n) : null,
    };
  };

  return {
    /** True after a runtime error: the session's state is undefined, start a new one. */
    get broken() { return broken; },
    /**
     * Bring the run up to date with `nextBars` and return a result like run()'s.
     * @param {Bars} nextBars @param {boolean} [copy] copy output arrays (needed when the session keeps running)
     */
    update(nextBars, copy = true) {
      const t0 = (typeof performance !== 'undefined' ? performance : Date).now();
      /** @type {Diagnostic[]} */
      const diagnostics = [];
      bars = nextBars;
      const N = nextBars.length;
      let ran = 0;
      let error = null;
      try {
        if (broken) throw new PineRuntimeError('This run stopped on an earlier error', 1, 1);
        if (committed >= 0 && N - 1 < committed) throw new Error('bars went backwards: start a new session');
        n = N;
        grow(N);
        loopOps = 0;
        if (N > 0) {
          if (committed < 0) committed = 0;
          else restore();
          // bars that closed since the last update: execute them for good and commit
          for (let k = committed; k < N - 1; k++) { beginBar(k); execBar(k); ran++; }
          if (!snap || N - 1 > committed) { snap = snapshot(); committed = N - 1; }
          // the forming bar runs on a scratch copy of the committed state
          beginBar(N - 1); execBar(N - 1); ran++;
        }
      } catch (e) {
        broken = true;
        const where = e && e.line ? e : null;
        error = { severity: 'error', line: where ? where.line : 1, col: where ? where.col : 1, message: `Runtime error on bar ${i}: ${e && e.message || e}` };
        if (!(e instanceof PineRuntimeError)) error.message += ' (internal)';
        diagnostics.push(error);
      }
      return {
        ok: !error,
        meta, inputs, hlines,
        ...out(copy),
        diagnostics,
        bars: n,
        ran,
        ms: Math.round(((typeof performance !== 'undefined' ? performance : Date).now() - t0) * 10) / 10,
      };
    },
  };
}
