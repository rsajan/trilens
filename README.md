# Trilens

A free personal market desk that works on your Android phone and your PC.

| Page | What it shows | Where the data comes from |
|---|---|---|
| **Fundamentals** | Prices (with pre-market and after-hours), earnings dates and surprises, analyst ratings and targets, insider buying and selling (SEC Form 4), 13D/13G ownership filings, 8-K/10-Q/10-K filings, company news, big holders | Yahoo Finance, SEC EDGAR, Google News |
| **Technical** | Your Reversal bot, Accumulation bot and revenue-dip scans, every strategy you have tested with its rules and results, the automation schedule, and a library for anything you upload | Your own scanner folders, read on your PC |
| **Sentiment** | Bullish and bearish mood per company from news, StockTwits, Bluesky, Mastodon and Hacker News (Reddit and YouTube if you add free keys) | Free public sources |

It costs nothing. The site is a set of static files on GitHub Pages. GitHub's free servers refresh the data on a schedule, so your PC does not need to be on.

---

## Set it up (about 15 minutes, once)

1. **Install two free programs** (skip any you already have). Open Command Prompt and run:
   ```
   winget install --id Git.Git
   winget install --id GitHub.cli
   ```
   Close the window and open a new one afterwards. You also need Python, which you already have.
2. **Double-click `SETUP_ONCE.bat`.** It asks you to sign in to GitHub in your browser (create a free account at github.com if you do not have one), then asks for:
   - a **password for the Technical page**. Press Enter to get a generated one. Save it in a password manager: it cannot be recovered;
   - your **name and email**, because the US SEC asks every visitor to identify themselves.
   It then creates the repository, turns on the website, uploads your encrypted Technical page and starts the first data refresh.
3. **Open the address it prints on your phone** (Chrome), tap the three dots, then **Add to Home screen**. Open Technical once, enter the password and tick "Remember on this device".

The first refresh takes about ten minutes. Until then the site shows sample data with a banner saying so.

## Day to day

- **Fundamentals and Sentiment update by themselves.** Prices every 30 minutes while the US and India markets are open, filings and news every 3 hours, sentiment every 2 hours, company data twice a day.
- **Technical updates when you run `PUBLISH.bat`**, because that page is built from files on your PC. Double-click `SCHEDULE_PUBLISH.bat` once and Windows will do it for you at 08:30 and 20:30, after your 07:00 and 19:00 scans. Check that your PC clock is on Singapore time.
- **Add anything to the Technical Library** by dropping Markdown, Word, PDF, CSV, Excel, HTML, image or text files into `technical_uploads`, then run `PUBLISH.bat`.
- **Change the stocks you follow** by editing `config/watchlist.json` (India tickers end in `.NS`), then double-click `PUSH_CHANGES.bat`. Keep the list to about 40 names or fewer so the free servers finish in time.
- **Test on your PC first** with `PREVIEW.bat`. It builds the Technical page and opens the site at `localhost:8080`.

## Privacy: what is public and what is not

- The website address is public to anyone who has it (GitHub Pages cannot password-protect a site for free). Fundamentals and Sentiment only contain public market information.
- **The Technical page is encrypted on your PC** with AES-256-GCM and a key stretched from your password (PBKDF2, 250,000 rounds) before anything is uploaded. GitHub only ever holds random-looking bytes. Your phone decrypts it in the browser, and the password never leaves the device.
- `PUBLISH.bat` runs a safety check and refuses to upload if the file is not encrypted or if your password, uploads or preview copy are tracked by git.
- A weak password weakens the lock, because anyone can download the encrypted file and guess offline. Use the generated passphrase or something long.
- Option: `config/technical_sources.json` has `publish_public_signals`. If you turn it on, the Fundamentals page shows a small badge on tickers your scanners flag (symbols and BUY or WATCH only). Off by default.

## What it cannot do for free, honestly

- **X (Twitter), Instagram and TikTok** have no free search access, so they are not in the sentiment score. The Sentiment page says so rather than faking it. Bluesky, StockTwits, Mastodon, news and Hacker News stand in.
- **Reddit** and **YouTube** need free keys. Add them to `config/local.json` as `REDDIT_CLIENT_ID`, `REDDIT_CLIENT_SECRET` and `YOUTUBE_API_KEY`, then run `SETUP_ONCE.bat` again. Bluesky may also ask for a free login (`BSKY_HANDLE`, `BSKY_APP_PASSWORD`) if it closes anonymous search.
- **Prices can be delayed** by up to 15 minutes. Insider trades appear when companies file them (within two business days). India has no free insider or filing feed, so Indian companies show prices, fundamentals, news and sentiment only.
- **Sentiment is a rough gauge.** It is a word list plus StockTwits' own bullish/bearish tags, not a prediction. Treat a score from fewer than a dozen mentions as noise.
- **Nothing here is investment advice.**

## If something looks wrong

| Symptom | Fix |
|---|---|
| The banner still says "Sample data" after 30 minutes | Open `github.com/<you>/trilens/actions`. If the first run failed, open it and read the red step. Press **Run workflow** to retry. |
| Prices or fundamentals stop updating, and the Actions log mentions "Too Many Requests" | Yahoo sometimes blocks GitHub's servers. Double-click `REFRESH_MARKET_DATA_HERE.bat` once a day from your PC instead. |
| Updates stop after a long quiet spell | GitHub pauses scheduled jobs in repositories with no activity for 60 days. Press **Run workflow** once. Publishing from your PC counts as activity. |
| Technical says "not published yet" | Run `PUBLISH.bat`. |
| Technical says the password is wrong | Check for typos. If it is lost, delete `technical_password` from `config/local.json`, run `SETUP_ONCE.bat` for a new one, then `PUBLISH.bat`, and sign in again on each device. |
| A strategy number looks different from your Excel file | The page re-reads the S1/S2/S3/blend/Logic 2 numbers from your workbooks every publish. The other figures are written in `pipeline/technical_curated.json`, taken from your spec files. Edit that file to change them. |

## What is where

```
index.html, assets/, sw.js        the website (no build step, no tracking, no outside fonts or scripts)
data/                             the JSON the pages read (sample data until the first refresh)
pipeline/                         fetchers for prices, company data, SEC, news and sentiment
pipeline/build_technical.py       reads your scanner folders and builds the encrypted Technical page
pipeline/technical_curated.json   the strategy library text and automation notes
config/watchlist.json             your tickers and indices
config/technical_sources.json     where your scanner folders are
config/local.json                 your password and keys (created by setup, never uploaded)
tools/, *.bat                     setup and publishing helpers for Windows
.github/workflows/site.yml        the free schedule that refreshes data and publishes the site
tests/                            checks for the parsers (python -m unittest discover -s tests)
```

Your scanner folders are only read, never changed.
