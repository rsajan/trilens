"""Run the data jobs.   python -m pipeline.run --jobs quotes,news      (or: all, prices, daily, social)

Jobs, in the order they run:
  quotes        prices, pre/post market, indices           (Yahoo, one bulk call)
  fundamentals  profile, valuation, earnings, analysts     (Yahoo, one call set per company)
  edgar         insider trades (Form 4) and filings        (SEC EDGAR, US only)
  news          headlines                                  (Google News RSS)
  sentiment     crowd mood                                 (news, StockTwits, Bluesky, Mastodon, Hacker News, optional Reddit/YouTube)

Each job fails on its own. A failed job keeps yesterday's files, so the site never goes blank."""
from __future__ import annotations

import argparse
import sys
import time

from .common import DATA, file_key, load_config, log, now_iso, read_json, ticker_list, write_json
from .model import build_feed, index_row

ORDER = ["quotes", "fundamentals", "edgar", "news", "sentiment"]
GROUPS = {"all": ORDER, "prices": ["quotes"], "daily": ["fundamentals", "edgar", "news"], "social": ["sentiment"], "filings": ["edgar", "news"]}


def purge_demo() -> bool:
    """Sample files shipped with the site are removed the first time real data is fetched,
    so real and fake numbers never sit side by side."""
    removed = False
    for pat in ("fundamentals/*.json", "sentiment/*.json", "market.json"):
        for p in DATA.glob(pat):
            d = read_json(p)
            if isinstance(d, dict) and d.get("demo"):
                p.unlink()
                removed = True
    return removed


def rebuild_index(tickers: list[dict]) -> int:
    companies = []
    for tk in tickers:
        co = read_json(DATA / "fundamentals" / f"{file_key(tk['symbol'])}.json")
        if co and not co.get("demo"):
            companies.append(co)
    if not companies:
        return 0
    write_json(DATA / "fundamentals" / "index.json", {"asof": now_iso(), "demo": False, "companies": [index_row(c) for c in companies]})
    feed = build_feed(companies)
    feed["demo"] = False
    write_json(DATA / "fundamentals" / "feed.json", feed)
    return len(companies)


def main(argv=None) -> int:
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("--jobs", default="all", help="comma list of jobs or a group: all, prices, daily, social, filings")
    ap.add_argument("--limit", type=int, help="only the first N tickers (for testing)")
    ap.add_argument("--tickers", help="comma list that replaces the watchlist for this run")
    a = ap.parse_args(argv)

    cfg = load_config()
    tickers = ticker_list(cfg)
    if a.tickers:
        from .common import market_of
        tickers = [{"symbol": s.strip().upper(), "name": "", "market": market_of(s.strip())} for s in a.tickers.split(",") if s.strip()]
    if a.limit:
        tickers = tickers[: a.limit]
    if not tickers:
        log.error("The watchlist is empty. Add tickers to config/watchlist.json")
        return 2
    want = []
    for j in a.jobs.split(","):
        want += GROUPS.get(j.strip(), [j.strip()])
    jobs = [j for j in ORDER if j in want]

    meta = read_json(DATA / "meta.json", {}) or {}
    was_demo = bool(meta.get("demo", True))
    symbols = [t["symbol"] for t in tickers]
    done, failed = [], {}
    for job in jobs:
        t0 = time.time()
        log.info("== %s", job)
        try:
            if job == "quotes":
                from . import fetch_quotes
                fetch_quotes.run(symbols, cfg.get("indices", []))
            elif job == "fundamentals":
                from . import fetch_fundamentals
                fetch_fundamentals.run(tickers)
            elif job == "edgar":
                from . import fetch_edgar
                r = fetch_edgar.run(tickers, cfg)
                if r.get("skipped"):
                    failed[job] = r["skipped"]
                    continue
            elif job == "news":
                from . import fetch_news
                fetch_news.run(tickers)
            elif job == "sentiment":
                from . import fetch_sentiment
                fetch_sentiment.run(tickers)
            done.append(job)
            log.info("%s finished in %.0fs", job, time.time() - t0)
        except Exception as e:
            log.error("%s failed: %s", job, e)
            failed[job] = str(e)[:160]
        if job in ("fundamentals", "edgar", "news"):
            rebuild_index(tickers)

    if done and purge_demo():
        log.info("removed the sample data")
    n = rebuild_index(tickers) if any(j in done for j in ("fundamentals", "edgar", "news")) or (done and was_demo) else 0
    if done:
        jobs_t = dict(meta.get("jobs", {})) if not was_demo else {}
        for j in done:
            jobs_t[j] = now_iso()
        write_json(DATA / "meta.json", {"version": 1, "demo": False if (DATA / "market.json").exists() or n else was_demo, "generated_at": now_iso(),
                                        "jobs": jobs_t, "tickers": symbols, **({"errors": failed} if failed else {})}, pretty=True)
    log.info("done: %s | failed: %s", done or "none", failed or "none")
    return 0 if done else 1


if __name__ == "__main__":
    sys.exit(main())
