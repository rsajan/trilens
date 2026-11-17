# Trilens

A free personal market desk that works on your Android phone and your PC: your Reversal bot, Accumulation bot and every other scanner you run, every strategy you have tested with its rules and results, the automation schedule, and a library for anything you upload. Built from your own scanner folders, read on your PC.

It costs nothing. The site is a set of static files on GitHub Pages. There is no watchlist and no live market data - it is entirely your own scanner output, encrypted before it ever leaves your PC.

---

## Set it up (about 15 minutes, once)

1. **Install two free programs** (skip any you already have). Open Command Prompt and run:
   ```
   winget install --id Git.Git
   winget install --id GitHub.cli
   ```
   Close the window and open a new one afterwards. You also need Python, which you already have.
2. **Double-click `SETUP_ONCE.bat`.** It asks you to sign in to GitHub in your browser (create a free account at github.com if you do not have one), then asks for a **password for the page**. Press Enter to get a generated one. Save it in a password manager: it cannot be recovered.
   It then creates the repository, turns on the website, and uploads your encrypted page.
3. **Open the address it prints on your phone** (Chrome), tap the three dots, then **Add to Home screen**. Open it once, enter the password and tick "Remember on this device".

## Day to day

- **The page updates when you run `PUBLISH.bat`**, because it is built from files on your PC. Double-click `SCHEDULE_PUBLISH.bat` once and Windows will do it for you at 08:30 and 20:30, after your 07:00 and 19:00 scans. Check that your PC clock is on Singapore time.
- **Add anything to the Library** by dropping Markdown, Word, PDF, CSV, Excel, HTML, image or text files into `technical_uploads`, then run `PUBLISH.bat`.
- **Test on your PC first** with `PREVIEW.bat`. It builds the page and opens the site at `localhost:8080`.

## Privacy: what is public and what is not

- The website address is public to anyone who has it (GitHub Pages cannot password-protect a site for free).
- **The page is encrypted on your PC** with AES-256-GCM and a key stretched from your password (PBKDF2, 250,000 rounds) before anything is uploaded. GitHub only ever holds random-looking bytes. Your phone decrypts it in the browser, and the password never leaves the device.
- `PUBLISH.bat` runs a safety check and refuses to upload if the file is not encrypted or if your password, uploads or preview copy are tracked by git.
- A weak password weakens the lock, because anyone can download the encrypted file and guess offline. Use the generated passphrase or something long.

## If something looks wrong

| Symptom | Fix |
|---|---|
| Says "not published yet" | Run `PUBLISH.bat`. |
| Says the password is wrong | Check for typos. If it is lost, delete `technical_password` from `config/local.json`, run `SETUP_ONCE.bat` for a new one, then `PUBLISH.bat`, and sign in again on each device. |
| A strategy number looks different from your Excel file | The page re-reads the numbers from your workbooks every publish. The other figures are written in `pipeline/technical_curated.json`, taken from your spec files. Edit that file to change them. |
| Looks stuck on an old version after you publish | A deploy can take a minute; reload once more. The app also reloads itself automatically the moment a new version takes over. |

## What is where

```
index.html, assets/, sw.js        the website (no build step, no tracking, no outside fonts or scripts)
data/technical/                   the only runtime data: the encrypted bundle plus a small public meta.json
pipeline/build_technical.py       reads your scanner folders and builds the encrypted page
pipeline/technical_curated.json   the strategy library text and automation notes
config/technical_sources.json     where your scanner folders are
config/local.json                 your password (created by setup, never uploaded)
tools/, *.bat                     setup and publishing helpers for Windows
.github/workflows/site.yml        deploys the site on every push - no scheduled data fetch
tests/                            checks for build_technical.py (python -m unittest discover -s tests)
```

Your scanner folders are only read, never changed.
