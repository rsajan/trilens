// Built-in indicators, written in Pine. They run through the same worker, runtime, renderer and
// settings dialog as your own scripts: one code path to test, and you can open any of them in the
// editor as a starting point.

export const BUILTINS = [
  {
    id: 'ema', name: 'Exponential Moving Average', short: 'EMA',
    source: `//@version=6
indicator("Exponential Moving Average", shorttitle="EMA", overlay=true)
src = input.source(close, "Source")
len = input.int(21, "Length", minval=1)
plot(ta.ema(src, len), "EMA", color=#f0b849, linewidth=2)
`,
  },
  {
    id: 'sma', name: 'Simple Moving Average', short: 'SMA',
    source: `//@version=6
indicator("Simple Moving Average", shorttitle="SMA", overlay=true)
src = input.source(close, "Source")
len = input.int(50, "Length", minval=1)
plot(ta.sma(src, len), "SMA", color=#3987e5, linewidth=2)
`,
  },
  {
    id: 'bb', name: 'Bollinger Bands', short: 'BB',
    source: `//@version=6
indicator("Bollinger Bands", shorttitle="BB", overlay=true)
src = input.source(close, "Source")
len = input.int(20, "Length", minval=1)
mult = input.float(2.0, "StdDev", minval=0.1, step=0.1)
[basis, upper, lower] = ta.bb(src, len, mult)
plot(basis, "Basis", color=#ff9800)
plot(upper, "Upper", color=#2962ff)
plot(lower, "Lower", color=#2962ff)
`,
  },
  {
    id: 'vwap', name: 'VWAP (daily session)', short: 'VWAP',
    source: `//@version=6
indicator("VWAP", overlay=true)
src = input.source(hlc3, "Source")
plot(ta.vwap(src), "VWAP", color=#d55181, linewidth=2)
`,
  },
  {
    id: 'rsi', name: 'Relative Strength Index', short: 'RSI',
    source: `//@version=6
indicator("Relative Strength Index", shorttitle="RSI", format=format.price, precision=2)
src = input.source(close, "Source")
len = input.int(14, "Length", minval=1)
ob = input.int(70, "Overbought", minval=50, maxval=100)
os = input.int(30, "Oversold", minval=0, maxval=50)
r = ta.rsi(src, len)
plot(r, "RSI", color=#9085e9, linewidth=2)
hline(ob, "Overbought", color=#787b86)
hline(50, "Middle", color=#787b86, linestyle=hline.style_dotted)
hline(os, "Oversold", color=#787b86)
bgcolor(r > ob ? color.new(color.red, 88) : r < os ? color.new(color.green, 88) : na)
`,
  },
  {
    id: 'macd', name: 'MACD', short: 'MACD',
    source: `//@version=6
indicator("MACD")
src = input.source(close, "Source")
fast = input.int(12, "Fast length", minval=1)
slow = input.int(26, "Slow length", minval=1)
sig = input.int(9, "Signal length", minval=1)
[m, s, h] = ta.macd(src, fast, slow, sig)
plot(h, "Histogram", style=plot.style_columns, color=h >= 0 ? (h > h[1] ? #26a69a : #b2dfdb) : (h < h[1] ? #ff5252 : #ffcdd2))
plot(m, "MACD", color=#2962ff)
plot(s, "Signal", color=#ff6d00)
hline(0, "Zero", color=#787b86, linestyle=hline.style_dotted)
`,
  },
  {
    id: 'atr', name: 'Average True Range', short: 'ATR',
    source: `//@version=6
indicator("Average True Range", shorttitle="ATR")
len = input.int(14, "Length", minval=1)
plot(ta.atr(len), "ATR", color=#e66767)
`,
  },
];

export const BUILTIN = Object.fromEntries(BUILTINS.map((b) => [b.id, b]));

/** Starter text for a new script in the editor. */
export const NEW_SCRIPT = `//@version=6
indicator("My script", overlay=true)
fastLen = input.int(9, "Fast EMA", minval=1)
slowLen = input.int(21, "Slow EMA", minval=1)
showSignals = input.bool(true, "Show cross signals")
upColor = input.color(#26a69a, "Bull colour")
dnColor = input.color(#ef5350, "Bear colour")

fast = ta.ema(close, fastLen)
slow = ta.ema(close, slowLen)
plot(fast, "Fast", color=fast > slow ? upColor : dnColor, linewidth=2)
plot(slow, "Slow", color=#787b86)

bull = ta.crossover(fast, slow)
bear = ta.crossunder(fast, slow)
plotshape(showSignals and bull, "Bull cross", style=shape.triangleup, location=location.belowbar, color=upColor, text="Bull")
plotshape(showSignals and bear, "Bear cross", style=shape.triangledown, location=location.abovebar, color=dnColor, text="Bear")
bgcolor(fast > slow ? color.new(upColor, 92) : color.new(dnColor, 92))

// Alerts: choose "Alert" in the toolbar, then one of these conditions
alertcondition(bull, "Bull cross", "{{ticker}} {{interval}}: fast EMA crossed above slow, close {{close}}")
alertcondition(bear, "Bear cross", "{{ticker}} {{interval}}: fast EMA crossed below slow, close {{close}}")
`;
