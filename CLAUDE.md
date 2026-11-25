# Trilens

Free personal market desk: a static website (GitHub Pages) that works as an Android PWA and on a PC. One page: your own scanner signals, strategy research and backtests, and the automation that runs them - encrypted. (Earlier versions also had Fundamentals and Sentiment pages pulling from Yahoo/SEC/social sources; those, and the server-side jobs that fed them, were removed.) Owner uses Windows; everything must stay free.

## Rules that must not be broken

1. **The GitHub repo and the website are public.** Never write strategy results, scanner picks, tickers flagged by a scanner, passwords, keys, emails or personal paths into any tracked file, including this one, commit messages and issues. The page ships only as the encrypted `data/technical/bundle.json` (AES-256-GCM, key from the owner's password via PBKDF2).
2. **Never read, print, copy or commit `config/local.json`** (password) or `data/technical/bundle.local.json`, `data/technical/prices.local.json` and `technical_uploads/*` (plaintext private data). They are git-ignored. `.claude/settings.json` blocks reads of them (it is a copy of `claude-settings.example.json`; if it is missing, tell the owner to copy it, do not skip the rule). Do not work around the block.
3. **Never weaken `tools/safety_check.py`.** It refuses to publish an unencrypted bundle or tracked private files. If it fails, fix the cause.
4. **Scanner folders are read-only.** Do not change anything in the folders listed in `config/technical_sources.json`.
5. **Free only.** No paid APIs, no CDN, no analytics, no outside fonts or scripts, no build step. If a source needs a card, drop it.
6. **Ask before anything that publishes or spends:** `git push`, `gh` commands (repo, secrets, workflows), editing `.github/workflows/`. A push to `main` redeploys the public site.

## Commands (run from the project root; Windows, Python 3.10+)

| Task | Command |
|---|---|
| Run the tests | `python -m unittest discover -s tests` and `node --test "tests/*.test.mjs"` (Pine runtime) |
| Build the page for local preview | `python pipeline\build_technical.py` (or `PREVIEW.bat`, which also serves `localhost:8080`) |
| Build, check, encrypt and upload the page | `PUBLISH.bat` (runs `tools\publish.py`) |
| Upload any other local change (code, config) | `PUSH_CHANGES.bat` |
| First-time setup, daily publish tasks | `SETUP_ONCE.bat`, `SCHEDULE_PUBLISH.bat` |

Set `PYTHONUTF8=1` when running Python by hand. `tools\_py.bat` does this for the `.bat` files.

## How it fits together

- `index.html`, `assets/`, `sw.js`: the site. Vanilla ES modules, hash routing, one page (`assets/js/pages/overview.js`, which holds everything - signals/strategies/results/automation/library), design tokens in `assets/css/app.css` (Harbour dark and Paper light, gold accent). No framework, no bundler.
- The chart is the home page (`#/`, also `#/chart`; `assets/js/pages/chart.js` → `assets/js/chart/`); the scanner is at `#/scanner`. Futures chart, drawing tools and Pine editor, fully client-side (synthetic market in a worker, Pine interpreter in a worker, vendored lightweight-charts in `assets/vendor/`). Design and roadmap: `docs/chart-blueprint.md`. It has no private data and does not touch the bundle.
- `data/technical/`: the only runtime data. `bundle.json` is the encrypted page content; `prices.json` holds end-of-day US/India stock prices for the chart (same encryption, built by `read_prices` from the scanners' price pickles, needs pandas; served by `assets/js/chart/data/stocks.js`, which adds the stocks to every chart feed after unlock); `meta.json` (`built_at`, `strategies`, `library`, `markets_scanned`) is public and drives the status chip.
- `pipeline/build_technical.py`: reads the scanner folders on the owner's PC and builds the bundle. Fully self-contained (stdlib + `openpyxl`/`cryptography`/`pypdf`/`Pillow` from `pipeline/requirements-pc.txt`) - no network calls, no watchlist. `pipeline/technical_curated.json`: strategy library text.
- `.github/workflows/site.yml`: deploys on every push to `main`. There is no scheduled data fetch - `tools/publish.py` pushes the new bundle directly, which is what triggers a redeploy.
- `tools/`: Windows setup and publishing helpers. `tests/test_pipeline.py`: tests for `build_technical.py` (encryption, numeric parsing, the curated-strategy-file shape).

## Conventions

- Adding a JS, CSS, font or icon file to the site means adding it to `SHELL` in `sw.js` and bumping `VERSION`, or phones keep serving the old app.
- Keep pages light for a phone: no large dependencies, tables scroll inside their own container, touch targets about 44px.
- Plain, specific wording in the UI. Say what the number is and where it came from.
- The scanner pages have no watchlist, no ticker search and no links to a `#/fundamentals/...` or `#/sentiment/...` route anymore - those pages are gone. Symbols in signal tables render as plain text, not links. (The `#/chart` page has its own watchlist of synthetic/public futures contracts; that is separate and holds no scanner data.)

## Before finishing a change

Run the tests, open `PREVIEW.bat` in a browser at phone width for any UI change, and confirm `python tools\safety_check.py` passes if anything near `data/technical/` or `config/` changed.
