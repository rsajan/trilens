# Chart desk — engineering blueprint

The `#/chart` page: futures charting, futures telemetry and a Pine Script editor/runtime, running
entirely in the browser. $0, no API keys, no build step, works offline as part of the PWA.

## 1. The calls that shaped it

**Stack.** This repo forbids a build step, CDNs and outside scripts (see `CLAUDE.md`). React,
Tailwind, Vite and Monaco all assume a bundler, and Monaco alone is ~3 MB on a phone. So:

| Asked for | Shipped | Why |
|---|---|---|
| React + Zustand | Vanilla ES modules + a 40-line observable store (`store/workspace.js`) | No build step; the chart is canvas, so a virtual DOM adds nothing to the hot path |
| TypeScript | JSDoc types | Same editor checking, no compile step. Add `tsc --checkJs --noEmit` in CI if you want enforcement |
| Tailwind | Existing design tokens in `app.css` | One design system for the whole site, both themes for free |
| lightweight-charts v5 | Vendored `assets/vendor/lightweight-charts` (5.0.9, Apache-2.0) | Same library, no CDN |
| Monaco / CodeMirror 6 | `ui/code-editor.js`: native textarea + highlighted mirror | Zero bytes of dependency; native mobile keyboard, IME, undo |
| IndexedDB | localStorage for now | Scripts and settings are KBs and needed synchronously at first paint. IndexedDB comes with drawings/replay (M3+) |

**Performance traps and what prevents each one.**

- *Main-thread blocking.* Price generation (`data/data.worker.js`) and Pine execution
  (`pine/pine.worker.js`) each run in their own Web Worker. Five years of minute paths for the
  daily view cost ~400 ms once per symbol, and none of it runs on the UI thread.
- *Render thrashing.* Live ticks arrive 4×/s and are coalesced into one `requestAnimationFrame`
  flush. Studies re-run at most every 250 ms, with at most one batch in flight. A re-run of the
  same length updates only the newest point; `setData` happens only when the bar count changes.
- *Legend churn.* Legend rows are built once and their text nodes are rewritten in place on
  crosshair moves. They are rebuilt only when a study's label, inputs or styles change.
- *Memory.* OHLCV is held in columnar `Float64Array`s (`data/bar-buffer.js`); bars are moved to
  workers as transferables. Minute paths are cached LRU (48 days, ~2.7 MB). History paging stops
  at 20,000 bars, because every live recalculation runs over every loaded bar.
- *Leaks.* The router calls each page's `cleanup()`: the chart, timers, subscriptions and key
  handlers are released, and async results that land afterwards are dropped (`engine.disposed`).
  The two workers are shared across re-renders, not recreated per theme switch.
- *Runaway scripts.* Loops share a 5M-iteration budget (runtime error with a line number). On top
  of that, a 4 s watchdog terminates and respawns the Pine worker, then reloads its data.

**Pine compatibility, bluntly.** There is no complete open-source Pine runtime for the browser.
PineTS is a library you write TypeScript against, not a Pine source interpreter, and other
projects cover small subsets. So Trilens has its own: lexer → parser (AST with line/col) → static
checks → per-bar tree-walking interpreter with TradingView's series semantics (`x[n]`, `var`,
per-call-site `ta.*` state). It runs ~2–4 µs per bar per script. It covers what indicator scripts
mostly use; anything else fails at compile time with a clear message rather than misbehaving:

- **Supported:** `indicator`/`study`, `var`/`varip`, typed declarations, `:=`/`+=` etc., tuples,
  `if`/`else if`/`else` (statement and expression), `for … to … by`, `while`, `break`/`continue`,
  user functions (single-line and block), ternaries, `na`/`nz`/`fixnan`, history on any expression.
- **ta.\*:** sma ema rma wma vwma rsi macd bb atr tr stdev dev cci highest lowest change mom roc
  rising falling crossover crossunder cross vwap stoch cum barssince valuewhen.
- **math.\*, color.\*** (new, rgb, from_gradient, the named colours), `str.tostring`.
- **input**, input.int/float/bool/color/string/source → the settings dialog is generated from them.
- **Outputs:** plot (line, step, histogram, columns, area, circles; per-bar colour; offset;
  `display.none`), plotshape, plotchar, hline, bgcolor, barcolor.
- **Not yet (compile error or warning):** `strategy()` (out of scope by design), `request.*`,
  `switch`, `line./label./box./table.`, `array./matrix./map.`, `fill()` (ignored with a warning),
  `alertcondition()` (ignored; alerts are M5), methods and user types, `library`/`import`.

Realtime semantics: every update re-runs the script over all bars, so there is no repainting
mismatch with history. It costs O(bars) per update, which is fine up to the 20k cap. The upgrade
path is snapshot/rollback of interpreter state at the last confirmed bar, re-executing only the
forming bar.

## 2. Layout

```
assets/js/pages/chart.js            route entry (lazy-loads everything below)
assets/js/chart/
  data/        timeframes.js · synthetic-engine.js · data.worker.js · adapters.js · bar-buffer.js
  engine/      chart-engine.js        (the only file that imports lightweight-charts)
  pine/        lexer.js · parser.js · runtime.js · ta.js · colors.js · pine.worker.js · client.js
  indicators/  builtins.js            (EMA SMA BB VWAP RSI MACD ATR, written in Pine)
  store/       workspace.js           (workspace + script library, persisted)
  ui/          chart-page.js (controller) · telemetry-bar.js · pine-drawer.js · code-editor.js · dialogs.js
assets/vendor/lightweight-charts/   vendored library + licence
tests/pine_runtime.test.mjs         node --test "tests/*.test.mjs"   (checks against independent reference maths)
```

**Data adapter contract** (`data/adapters.js`): `contracts()`, `bars(symbol, tf, {to, limit})`
returning columnar bars, `subscribeBars(symbol, tf, cb)`, `subscribeTelemetry(symbol, cb)`,
`dispose()`. The UI never imports a concrete feed.

- `SyntheticAdapter` (default): deterministic market in a worker. A daily regime process plus
  per-day Brownian-bridge minute paths with session seasonality and jumps. Every timeframe is an
  exact aggregate of the same minutes, so a 1h bar equals its sixty 1m bars. Telemetry includes
  mark/index/basis, Binance-style funding (`P + clamp(0.01% − P, ±0.05%)`, 8 h cycle), OI, 24h
  stats, and a quarterly contract with annualised basis and expiry countdown.
- `BinanceAdapter` (opt-in): public USD-M REST + WebSocket, no key. Blocked in some countries and
  networks; the page then says so and you switch back. 3M bars are rebuilt from 1M.

## 3. Milestones

**M1 — done.** Adapters + synthetic engine, timeframes from 1m to 3M, chart with volume, crosshair
OHLCV legend, history paging on scroll, futures telemetry strip, symbol picker, phone layout,
offline shell.

**M2 — done.** Pine editor drawer (highlighting, line numbers, auto-indent, comment toggle, Ctrl+S
/ Ctrl+Enter, resizable, collapsible), live compile diagnostics with clickable line:col, runtime
errors, My Scripts (save, save as, rename, duplicate, delete, add/remove on chart), unsaved drafts
kept, overlay vs separate pane chosen from `overlay=`, settings dialog generated from `input.*`
plus per-plot style overrides, built-ins in Pine, persistence across reloads.

**M3 — drawing tools.** Series primitives (lightweight-charts `ISeriesPrimitive`) for trendline,
ray, horizontal level, Fibonacci retracement and long/short risk-reward box. Drawings stored per
symbol in IndexedDB, with hit-testing, drag handles and a magnet to OHLC. Incremental Pine
(rollback) lands here too.

**M4 — workspace.** 1×1 / 1×2 / 2×2 layouts. Each cell is a `mountChartPage`-style controller
over a shared adapter, with symbol, timeframe and crosshair sync via `setCrosshairPosition`.
Multi-list watchlists with colour tags and live badges (one telemetry subscription per symbol).
Indicator templates and layout presets.

**M5 — replay and alerts.** Bar replay: cut the buffer at a chosen bar, then step or play by
feeding `BarBuffer.apply` from the held-back bars, re-running Pine on each step (the dataset API
already supports this). Client-side alerts on price crossing a level or on `alertcondition()`,
evaluated in the Pine worker, using the Notification API while the tab is open.

Each milestone ends the same way: `node --test "tests/*.test.mjs"`, then the Playwright flow (desktop and
phone, both themes, zero console errors).
