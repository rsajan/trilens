# Trilens

Free personal market desk: a static website (GitHub Pages) that works as an Android PWA and on a PC. Three pages: **Fundamentals** (prices, earnings, analysts, SEC insider trades and filings, news), **Technical** (the owner's own scanner results and tested strategies, encrypted), **Sentiment** (crowd mood from free public sources). Owner uses Windows; everything must stay free.

## Rules that must not be broken

1. **The GitHub repo and the website are public.** Never write strategy results, scanner picks, tickers flagged by a scanner, passwords, keys, emails or personal paths into any tracked file, including this one, commit messages and issues. Technical content ships only as the encrypted `data/technical/bundle.json` (AES-256-GCM, key from the owner's password via PBKDF2).
2. **Never read, print, copy or commit `config/local.json`** (password and API keys) or `data/technical/bundle.local.json` and `technical_uploads/*` (plaintext private data). They are git-ignored. `.claude/settings.json` blocks reads of them (it is a copy of `claude-settings.example.json`; if it is missing, tell the owner to copy it, do not skip the rule). Do not work around the block.
3. **Never weaken `tools/safety_check.py`.** It refuses to publish an unencrypted bundle or tracked private files. If it fails, fix the cause.
4. **Scanner folders are read-only.** Do not change anything in the folders listed in `config/technical_sources.json`.
5. **Free only.** No paid APIs, no CDN, no analytics, no outside fonts or scripts, no build step. If a source needs a card, drop it.
6. **Do not invent data.** If a source cannot be reached, show that it is missing. X, Instagram and TikTok have no free access; the Sentiment page says so. Nothing here is investment advice.
7. **Ask before anything that publishes or spends:** `git push`, `gh` commands (repo, secrets, workflows), editing `.github/workflows/`. A push to `main` redeploys the public site.

## Commands (run from the project root; Windows, Python 3.10+)

| Task | Command |
|---|---|
| Run the tests | `python -m unittest discover -s tests` |
| Try a data job on a few tickers | `python -m pipeline.run --jobs quotes,news --limit 3` |
| Build the Technical page for local preview | `python pipeline\build_technical.py` (or `PREVIEW.bat`, which also serves `localhost:8080`) |
| Build, check, encrypt and upload the Technical page | `PUBLISH.bat` (runs `tools\publish.py`) |
| Upload site or watchlist changes | `PUSH_CHANGES.bat` |
| Fetch market data on this PC if GitHub's servers are blocked | `REFRESH_MARKET_DATA_HERE.bat` |
| First-time setup, daily publish tasks | `SETUP_ONCE.bat`, `SCHEDULE_PUBLISH.bat` |

Set `PYTHONUTF8=1` when running Python by hand. `tools\_py.bat` does this for the `.bat` files.

## How it fits together

- `index.html`, `assets/`, `sw.js`: the site. Vanilla ES modules, hash routing (`#/fundamentals`, `#/company/AAPL`), design tokens in `assets/css/app.css` (Harbour dark and Paper light, gold accent). No framework, no bundler.
- `data/`: JSON the pages read. On `main` it holds sample data (flagged `"demo": true`) plus `data/technical/`. Live data is written by GitHub Actions to a force-pushed orphan branch called `data`, which the workflow overlays onto `main` before building `_site`. Do not commit generated live data to `main`.
- `pipeline/`: one module per source (`fetch_quotes`, `fetch_fundamentals`, `fetch_edgar`, `fetch_news`, `fetch_sentiment`), `model.py` (index rows, feed, the Fundamentals/Technical/Sentiment lenses), `run.py` (job runner), `build_technical.py` (runs on the owner's PC only), `technical_curated.json` (strategy library text).
- `.github/workflows/site.yml`: scheduled refresh and Pages deploy. Only `index.html`, `manifest.webmanifest`, `sw.js`, `assets` and `data` are published. This file and everything else stay in the repo only.
- `tools/`: Windows setup and publishing helpers. `tests/test_pipeline.py`: parser and transform tests on fixtures.

## Conventions

- Each data job fails on its own and keeps the last good files. `run.py` removes sample data only after a job succeeds. Keep it that way: the site must never go blank.
- Put parsing in pure functions that take raw text or DataFrames, and test them with small fixtures. The build sandbox cannot reach market-data hosts, so the live fetchers have only been checked this way. When touching a fetcher, say what was and was not tested.
- Yahoo is rate limited. Prefer bulk calls and keep the watchlist near 40 names or fewer. SEC EDGAR needs a User-Agent with a name and email (`SEC_USER_AGENT` secret, or `sec_user_agent` in `config/local.json`).
- Adding a JS, CSS, font or icon file to the site means adding it to `SHELL` in `sw.js` and bumping `VERSION`, or phones keep serving the old app.
- Keep pages light for a phone: no large dependencies, tables scroll inside their own container, touch targets about 44px.
- Sentiment is a rough gauge. The score uses shrinkage, `100*(bull-bear)/(n+5)`. Do not present a score from a handful of posts as meaningful.
- Plain, specific wording in the UI. Say what the number is and where it came from.

## Before finishing a change

Run the tests, open `PREVIEW.bat` in a browser at phone width for any UI change, and confirm `python tools\safety_check.py` passes if anything near `data/technical/` or `config/` changed.
