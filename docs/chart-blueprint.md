# Chart desk — engineering blueprint

The `#/chart` page: futures charting, drawing tools and a Pine Script editor/runtime, running
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

Realtime semantics follow TradingView's rollback model (`createSession` in `pine/runtime.js`):
- **Closed bars run once.** Their end state is committed as a snapshot of every `ta.*` call-site
  state and each `var` slot's initialised flag.
- **Each tick re-runs only the forming bar,** on a fresh copy of that snapshot.
- **Per-bar outputs** (series history, plot values, colours, alert flags) are indexed by bar,
  so re-running a bar overwrites its own index after it is cleared.
- **Sessions:** the Pine worker keeps one session per study or alert. It starts a fresh one when
  the script, inputs or dataset change (symbol or timeframe switch, history load, replay start).
- **Cost:** a full run of 1,500 bars takes ~20 ms; a live update takes ~0.1 ms.
- **Tests:** `tests/pine_runtime.test.mjs` feeds every built-in, the starter script and several
  stateful scripts tick by tick and checks the result is identical to a full run on the final
  bars.

## 2. Layout

```
assets/js/pages/chart.js            route entry (lazy-loads everything below)
assets/js/chart/
  data/        timeframes.js · synthetic-engine.js · data.worker.js · adapters.js · bar-buffer.js
  engine/      chart-engine.js        (the only file that imports lightweight-charts)
  pine/        lexer.js · parser.js · runtime.js · ta.js · colors.js · pine.worker.js · client.js
  indicators/  builtins.js            (EMA SMA BB VWAP RSI MACD ATR, written in Pine)
  store/       workspace.js           (workspace + script library, persisted)
  ui/          chart-page.js (shell) · chart-cell.js · menu.js · pine-drawer.js · code-editor.js · dialogs.js · watchlist.js · alerts.js
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

**M3 — drawing tools (done).** `assets/js/chart/drawings/` holds the work:
- **Rendering:** one series primitive draws every drawing (`layer.js`).
- **Maths:** pure functions in `geometry.js`, tested in `tests/drawings.test.mjs`.
- **Storage:** IndexedDB per symbol, shared by every timeframe (`store.js`), falling back to
  localStorage and then memory.

The tools are trend line, ray, horizontal level (with a price-axis label), Fibonacci
retracement (0 on the second point, 0.236–1.618) and long/short positions. A position
measures risk/reward only: target/stop percentages and the ratio, and it flags a stop on the
wrong side of the entry. Nothing is traded.

Drawings are stored as time/price, never pixels or bar indexes. A time maps to a fractional
logical index (interpolated between bars, extrapolated past either end), so a drawing lands
correctly on any timeframe and survives history loading.

Interaction:
- **Selecting and editing:** hit-testing with handles, then drag a handle or the whole body. A
  selection bar sets colour, width or deletes. Del deletes, Esc cancels.
- **Shortcuts:** Alt+T/R/H/F/L/S pick the tools.
- **Magnet and hide:** a magnet snaps to OHLC, and you can hide or clear all drawings.
- **Touch:** tap-tap works on a phone.
- **Panning:** the chart stops panning only while a drawing is grabbed. The layer listens in
  the capture phase and swallows the matching mousedown/touchstart.

Fixed along the way: switching timeframe used to leave the view on old bars, because study
series still held the previous timeframe's times. They are now emptied when a new dataset
loads.

Moved to M4: incremental Pine (rollback, since done), drawing templates, and parallel channels and text
notes.

**M4 — workspace (done).** The page shell (`ui/chart-page.js`) lays out 1×1, 1×2 or 2×2
`ChartCell`s (`ui/chart-cell.js`). Each cell owns its buffer, live feed, Pine dataset, studies,
drawings and replay. The toolbar, Pine editor and drawing rail act on the
focused cell, which is outlined.

- **Sync:** optional symbol and timeframe sync across the visible charts, and crosshair sync
  that snaps to the bar containing the time in each chart.
- **Watchlists:** multiple named lists, colour flags, reorder, and a live last price and 24h
  change per row. Click a row to load it in the focused chart. On phones the panel is an overlay.
- **Indicator templates:** save the focused chart's indicators, inputs and styles, then apply
  them to any chart.
- **Layout presets:** save the split, the sync settings and every chart's contract, timeframe
  and indicators.
- **Storage:** `store/library.js`. Workspaces saved before split layouts existed migrate into
  cell 0.
- **New drawings:** parallel channel (three clicks, with a midline) and text notes
  (double-click to edit).

**M5 — replay and alerts (done).**

- **Bar replay** on the focused chart:
  - pick a start bar, then step, or play at 1–25 bars/s; Shift+→ steps and Shift+Space plays or
    pauses;
  - every step feeds the bar to the Pine worker and re-runs every study;
  - live bars keep arriving into the hidden future, and Exit returns to live;
  - history paging is off during replay.
- **Price alerts:**
  - conditions: crosses, at or above, at or below; set from the toolbar or from a selected
    horizontal level;
  - checked against live telemetry about once a second while the page is open (no server, so
    nothing fires while it's closed);
  - a firing shows a toast, a browser notification (permission asked on the first alert) and a
    short tone, then the alert switches off until re-armed;
  - armed alerts show as dashed price lines on their contract's charts;
  - the trigger logic (`alertHit`) is tested.

**Incremental Pine (done).** Re-running only the forming bar, as described under realtime
semantics above. In the editor, the console says how many bars the last update re-ran.

**Follow-ups (done).**
- **`alertcondition()` alerts.** The runtime records each `alertcondition()` per bar
  (`res.alertconds`). The Alert dialog lists every condition from the focused chart's
  indicators.
  - Each script alert runs its own copy of the script in the Pine worker on its own 600 bars for
    its contract and timeframe, so it keeps working whatever the charts show.
  - It fires when a bar *closes* with the condition true. The forming bar is ignored, so
    in-bar flicker never fires, and history present when the alert starts never fires.
  - Fire once, or on every bar close that meets it.
  - Messages fill `{{ticker}} {{interval}} {{open}} {{high}} {{low}} {{close}} {{volume}} {{time}}`
    (`fillMessage`, tested).
  - The alert switches itself off with a message if its script is deleted, errors, or loses
    that condition.
- **Drawing templates.** Drawings gain a line style (solid, dashed, dotted). Per-tool
  templates hold a colour, width and line style. From a selected drawing's Tpl menu you can
  apply a template, save the current style, or make a style the default for new drawings of
  that tool (`store/library.js` `drawStyles`).

Each milestone ends the same way: `node --test "tests/*.test.mjs"`, then the Playwright flow (desktop and
phone, both themes, zero console errors).

**Toolbar clean-up.** The toolbar follows TradingView's order:
- **Left:** a symbol search box, a chart-type menu (Candles, Bars, Line, Area; per chart, saved),
  then the timeframe dropdown.
- **Middle:** Indicators, Templates, a Drawings switch (shows or hides the tool rail), Replay,
  one Alert menu (new alert / manage alerts), and the Pine Editor.
- **Right:** layout, sync, Watchlist, Latest, and the feed.

The futures telemetry strip (mark/index, funding countdown, 24h stats, open interest) was
removed at the owner's request. The adapters still provide telemetry: the watchlist and the
price alerts use it.

For bars, line and area charts the candle series stays, made fully transparent, so drawings,
markers and alert lines keep their anchor; a second series draws the chosen style.

**Live data by default.** Feeds (`data/live.js`):
- **Live (auto), the default:** Binance if it answers, else Bybit, else the synthetic market
  with a notice saying why.
- **Binance:** every trading USDT perpetual on Binance USD-M futures.
- **Bybit:** every trading USDT linear perpetual on Bybit.
- **Synthetic (offline).**

Details:
- Contract lists come from each exchange, most traded first.
- Symbols use TradingView's `BTCUSDT.P` naming on every feed, so watchlists, drawings and alerts
  carry over.
- Timeframes the exchange does not stream (3M everywhere, 3D on Bybit) are built from the base
  interval.
- Everything uses public endpoints: no account, no key.
- Both exchanges block some countries and networks. The feed chip in the toolbar shows the
  source actually in use.
- Stocks and indices (NSE, NASDAQ, …) have no free, no-key, browser-usable live feed, so they
  are not offered.
- Parsers are pure functions tested against the documented payloads
  (`tests/live.test.mjs`).

**Pine runtime: strategy scripts and more TradingView features.** Added so TradingView
strategy scripts run unchanged:
- **`strategy()`:** runs as signals, with no equity, P&L or trade list.
  - Market orders fill at the next bar's open (or the same bar's close with
    `process_orders_on_close`).
  - Stop/limit entries wait until touched; `strategy.exit` stops and limits are checked
    against each bar's range from the bar after they are placed.
  - `strategy.position_size` / `position_avg_price` reflect the open position, and every fill is
    a marker carrying its comment.
- **`request.security` on the chart's own symbol at a higher timeframe:** higher-timeframe bars
  are built from the chart's bars with TradingView's non-repainting `lookahead_off` timing.
  - On history, a value appears on the bar that closes its higher-timeframe bar and holds until
    the next one closes; on the live bar it shows the forming bar.
  - Other symbols and `request.financial` return `na` with a warning: there is no free data for
    them.
- **Also new:** `ta.pivothigh`/`ta.pivotlow`, `ta.dmi`, arrays (`float[]`, `array<float>`, and the
  common `array.*` functions), `label.new`/`label.delete` (drawn as markers with text),
  `input.symbol`, `input.timeframe` and `str.format`.
- **Incremental runs:** strategy, higher-timeframe and label state all take part in the
  forming-bar rollback, so incremental runs equal full runs. Scripts that use arrays re-run in
  full each update, because arrays are shared references the snapshot does not copy.

### End-of-day stocks (US / India)

- `PUBLISH.bat` reads the scanners' daily price pickles (default `{accumulation_dir}/data/prices_*.pkl`, or `price_files` globs in `config/technical_sources.json`) with pandas. It understands a dict of per-ticker frames, yfinance-style wide tables, long tables with a symbol column, and close-only wide tables. It keeps the 500 most traded symbols per market (average close × volume over 60 days) plus every symbol in the signals, 400 daily bars each. The prices are integer-encoded and written to `data/technical/prices.json`, encrypted like the bundle. `safety_check.py` refuses to publish an unencrypted copy.
- `assets/js/chart/data/stocks.js` unlocks the file with the remembered Technical password (or the "🔒 Unlock stocks" button) and adds the stocks to every feed (`withStocks`). The `Stocks (end of day)` feed shows only the stocks. Daily is the finest timeframe; W/M are aggregated. There are no live ticks.
- The watchlists are 17 signal lists + Crypto + "US top 500" + "India top 500". They are built automatically when the chart opens with a remembered password (once per publish), or with ⚡.
