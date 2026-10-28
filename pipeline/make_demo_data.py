"""Writes clearly-labelled SAMPLE data so the site can be previewed before the first live update.

Everything produced here carries "demo": true, the site shows a banner, and the first real
pipeline run deletes it. Names of people and firms are generic on purpose: no real
individual is ever attributed a made-up trade.

Usage:  python pipeline/make_demo_data.py
"""
from __future__ import annotations

import math
import random
import shutil
from datetime import date, datetime, timedelta, timezone

from common import DATA, now_iso, file_key, write_json, market_of
from model import index_row, build_feed, rating_label, sentiment_label

# symbol, name, sector, industry, base price, market cap, currency, exchange
DEMO = [
    ("NVDA", "NVIDIA Corporation", "Technology", "Semiconductors", 180, 4.4e12, "USD", "NASDAQ"),
    ("AAPL", "Apple Inc.", "Technology", "Consumer Electronics", 235, 3.5e12, "USD", "NASDAQ"),
    ("MSFT", "Microsoft Corporation", "Technology", "Software", 510, 3.8e12, "USD", "NASDAQ"),
    ("AMZN", "Amazon.com, Inc.", "Consumer Cyclical", "Internet Retail", 225, 2.4e12, "USD", "NASDAQ"),
    ("LLY", "Eli Lilly and Company", "Healthcare", "Drug Manufacturers", 780, 7.4e11, "USD", "NYSE"),
    ("JPM", "JPMorgan Chase & Co.", "Financial Services", "Banks", 300, 8.2e11, "USD", "NYSE"),
    ("TSLA", "Tesla, Inc.", "Consumer Cyclical", "Auto Manufacturers", 340, 1.1e12, "USD", "NASDAQ"),
    ("ABBV", "AbbVie Inc.", "Healthcare", "Biotechnology", 286, 5.0e11, "USD", "NYSE"),
    ("RELIANCE.NS", "Reliance Industries Limited", "Energy", "Conglomerate", 1450, 1.96e13, "INR", "NSE"),
    ("TCS.NS", "Tata Consultancy Services", "Technology", "IT Services", 3300, 1.2e13, "INR", "NSE"),
    ("HDFCBANK.NS", "HDFC Bank Limited", "Financial Services", "Banks", 1000, 1.5e13, "INR", "NSE"),
    ("HAL.NS", "Hindustan Aeronautics", "Industrials", "Aerospace & Defense", 4850, 3.2e12, "INR", "NSE"),
]

FIRMS = ["Sample Securities", "Example Capital", "Placeholder Partners", "Demo Research", "Mock Advisors"]
ROLES = ["Chief Executive Officer", "Chief Financial Officer", "Director", "10% owner", "EVP, Operations"]
HEADLINES = [
    "Sample headline: company reports quarterly results ahead of expectations",
    "Sample headline: analysts raise price targets after investor day",
    "Sample headline: regulators open routine review of the sector",
    "Sample headline: supply chain update points to steady demand",
    "Sample headline: company announces share repurchase programme",
    "Sample headline: new product line expected to launch next quarter",
    "Sample headline: management comments at industry conference",
    "Sample headline: dividend declared for shareholders of record",
]
SOURCES = ["Sample Wire", "Example Times", "Demo Finance"]


def rnd(sym: str) -> random.Random:
    return random.Random(sum(ord(c) * (i + 7) for i, c in enumerate(sym)))


def walk(r: random.Random, start: float, n: int, vol: float = 0.017, drift: float = 0.0004) -> list[float]:
    p, out = start * 0.78, []
    for _ in range(n):
        p *= math.exp(r.gauss(drift, vol))
        out.append(p)
    scale = start / out[-1]
    return [x * scale for x in out]


def bdays(n: int) -> list[str]:
    d, out = date.today(), []
    while len(out) < n:
        if d.weekday() < 5:
            out.append(d.isoformat())
        d -= timedelta(days=1)
    return out[::-1]


def make_company(row) -> dict:
    sym, name, sector, industry, base, cap, ccy, exch = row
    r = rnd(sym)
    market = market_of(sym)
    closes = walk(r, base, 260)
    dates = bdays(260)
    last, prev = closes[-1], closes[-2]
    p = {
        "last": round(last, 2), "prev_close": round(prev, 2), "change": round(last - prev, 2), "change_pct": round((last / prev - 1) * 100, 2),
        "pre": None, "post": round(last * (1 + r.uniform(-0.006, 0.006)), 2) if market == "US" else None,
        "day_low": round(last * 0.988, 2), "day_high": round(last * 1.011, 2),
        "wk52_low": round(min(closes) * 0.99, 2), "wk52_high": round(max(closes) * 1.01, 2),
        "volume": int(r.uniform(8e6, 6e7)), "avg_volume": int(r.uniform(1e7, 5e7)), "market_cap": cap,
    }
    # earnings
    q_end = date.today().replace(day=1) - timedelta(days=1)
    hist, quarters = [], []
    rev = cap / r.uniform(20, 40) / 4
    for i in range(10):
        qe = (q_end.replace(day=1) - timedelta(days=95 * i)).replace(day=1) - timedelta(days=1)
        est = round(r.uniform(0.8, 3.5) if market == "US" else r.uniform(18, 60), 2)
        act = round(est * r.uniform(0.94, 1.12), 2)
        hist.append({"date": (qe + timedelta(days=28)).isoformat(), "eps_est": est, "eps_actual": act, "surprise_pct": round((act / est - 1) * 100, 1)})
        rv = rev * (1 - 0.018 * i) * r.uniform(0.97, 1.03)
        quarters.append({"period": qe.isoformat(), "revenue": round(rv), "net_income": round(rv * r.uniform(0.12, 0.28)), "eps": act})
    nxt = date.today() + timedelta(days=r.randint(2, 40))
    earnings = {"next": {"date": nxt.isoformat(), "eps_est": round(hist[0]["eps_est"] * 1.04, 2), "rev_est": round(rev * 1.03)}, "history": hist, "quarters": quarters}
    # analysts
    counts = {"strong_buy": r.randint(2, 14), "buy": r.randint(6, 22), "hold": r.randint(2, 12), "sell": r.randint(0, 3), "strong_sell": r.randint(0, 2)}
    tot = sum(counts.values())
    mean_score = round(sum(v * s for v, s in zip(counts.values(), [1, 2, 3, 4, 5])) / tot, 2)
    analysts = {
        "mean_score": mean_score, "rating_label": rating_label(mean_score), "counts": counts,
        "target": {"low": round(last * 0.82, 2), "mean": round(last * r.uniform(0.97, 1.26), 2), "median": round(last * 1.12, 2), "high": round(last * 1.48, 2), "current": round(last, 2), "n": tot},
        "changes": [{"date": (date.today() - timedelta(days=r.randint(1, 60))).isoformat(), "firm": r.choice(FIRMS), "action": r.choice(["Upgrade", "Downgrade", "Reiterated", "Initiated"]), "from": r.choice(["Hold", "Buy", "Neutral"]), "to": r.choice(["Buy", "Overweight", "Hold"])} for _ in range(6)],
    }
    analysts["changes"].sort(key=lambda c: c["date"], reverse=True)
    # insiders (US only)
    txs, ins = [], {}
    if market == "US":
        for _ in range(r.randint(5, 11)):
            kind = r.choices(["buy", "sell", "other"], [0.25, 0.6, 0.15])[0]
            sh = r.randint(500, 60000)
            px = round(last * r.uniform(0.9, 1.05), 2)
            txs.append({"date": (date.today() - timedelta(days=r.randint(1, 85))).isoformat(), "name": f"Sample Insider {r.choice('ABCDEFGH')}", "title": r.choice(ROLES),
                        "code": {"buy": "P", "sell": "S", "other": "A"}[kind], "type": kind, "type_label": {"buy": "Purchase", "sell": "Sale", "other": "Award"}[kind],
                        "shares": sh, "price": px, "value": round(sh * px), "owned_after": sh * r.randint(3, 40), "url": None})
        txs.sort(key=lambda t: t["date"], reverse=True)
        b = [t for t in txs if t["type"] == "buy"]; s = [t for t in txs if t["type"] == "sell"]
        ins = {"buys_90d": len(b), "sells_90d": len(s), "buy_value": sum(t["value"] for t in b), "sell_value": sum(t["value"] for t in s)}
        ins["net_value"] = ins["buy_value"] - ins["sell_value"]
    holders = {"major": {"insiders_pct": round(r.uniform(0.2, 9), 1), "institutions_pct": round(r.uniform(55, 88), 1)},
               "institutions": [{"name": n, "pct": round(r.uniform(0.6, 8.5), 2), "shares": int(r.uniform(2e6, 9e8)), "change_pct": round(r.uniform(-6, 9), 1), "date": (date.today() - timedelta(days=r.randint(40, 80))).isoformat()}
                                 for n in ["Sample Index Fund", "Example Asset Management", "Demo Pension Trust", "Placeholder Capital", "Mock Investment Group", "Sample Growth Fund"]]}
    filings = []
    if market == "US":
        for form, desc in [("8-K", "Results of operations"), ("4", "Statement of changes in beneficial ownership"), ("10-Q", "Quarterly report"), ("8-K", "Regulation FD disclosure"), ("SC 13G/A", "Ownership report")]:
            filings.append({"date": (date.today() - timedelta(days=r.randint(1, 70))).isoformat(), "form": form, "desc": desc, "items": "", "url": None})
        filings.sort(key=lambda f: f["date"], reverse=True)
    news = [{"ts": (datetime.now(timezone.utc) - timedelta(hours=r.randint(1, 120))).replace(microsecond=0).isoformat().replace("+00:00", "Z"), "title": f"{h} ({sym.replace('.NS', '')})", "source": r.choice(SOURCES), "url": None} for h in r.sample(HEADLINES, 6)]
    news.sort(key=lambda n: n["ts"], reverse=True)
    co = {
        "symbol": sym, "name": name, "market": market, "exchange": exch, "currency": ccy, "sector": sector, "industry": industry,
        "website": None, "about": f"Sample description for {name}. Real company descriptions appear here after the first live update.",
        "asof": now_iso(), "demo": True, "price": p, "history": {"dates": dates, "close": [round(c, 2) for c in closes]},
        "stats": {"pe_trailing": round(r.uniform(12, 55), 1), "pe_forward": round(r.uniform(11, 45), 1), "eps_ttm": round(r.uniform(2, 14), 2), "eps_fwd": round(r.uniform(3, 16), 2),
                  "div_yield": round(r.uniform(0, 2.4), 2), "beta": round(r.uniform(0.7, 1.9), 2), "revenue_growth": round(r.uniform(-4, 28), 1), "profit_margin": round(r.uniform(8, 32), 1),
                  "roe": round(r.uniform(8, 45), 1), "debt_equity": round(r.uniform(10, 160), 0), "short_pct_float": round(r.uniform(0.6, 4.5), 1), "held_insiders_pct": holders["major"]["insiders_pct"], "held_institutions_pct": holders["major"]["institutions_pct"]},
        "earnings": earnings, "analysts": analysts, "insiders": {"summary": ins, "transactions": txs} if market == "US" else {},
        "holders": holders, "filings": filings, "news": news,
        "actions": {"dividends": [{"date": (date.today() - timedelta(days=90 * i + 20)).isoformat(), "amount": round(r.uniform(0.2, 1.1), 3)} for i in range(3)], "splits": []},
    }
    return co


def make_sentiment(co: dict, hours: int = 24) -> dict:
    sym = co["symbol"]
    r = rnd(sym + "s")
    base = r.uniform(-55, 70)
    hist, t0 = [], datetime.now(timezone.utc) - timedelta(hours=2 * 70)
    for i in range(70):
        hist.append({"t": (t0 + timedelta(hours=2 * i)).replace(microsecond=0).isoformat().replace("+00:00", "Z"), "s": round(max(-100, min(100, base + r.gauss(0, 14) + 8 * math.sin(i / 7))), 1), "n": r.randint(8, 60)})
    score = hist[-1]["s"]
    mentions = r.randint(30, 480)
    srcs = {"news": 0.3, "stocktwits": 0.25, "reddit": 0.2, "bluesky": 0.1, "hn": 0.05, "mastodon": 0.1}
    by = {}
    for k, w in srcs.items():
        n = max(1, int(mentions * w)); sc = max(-100, min(100, score + r.gauss(0, 18)))
        bull = int(n * (0.45 + sc / 250)); bear = int(n * (0.3 - sc / 300)); by[k] = {"n": n, "score": round(sc, 1), "bull": bull, "bear": max(0, bear), "neutral": max(0, n - bull - max(0, bear))}
    bull_pct = 38 + score / 4; bear_pct = max(4, 30 - score / 4)
    items = []
    for i in range(24):
        lab = r.choices(["bull", "neutral", "bear"], [0.4 + score / 300, 0.35, 0.25 - score / 400])[0]
        items.append({"ts": (datetime.now(timezone.utc) - timedelta(minutes=r.randint(3, 1400))).replace(microsecond=0).isoformat().replace("+00:00", "Z"), "source": r.choice(list(srcs)),
                      "author": r.choice(["sample_user_1", "sample_user_2", "example_trader", None]), "text": {"bull": "Sample post: looking strong into the next report, adding on dips.", "bear": "Sample post: valuation looks stretched, staying on the sidelines.", "neutral": "Sample post: waiting for the earnings call before deciding."}[lab],
                      "url": None, "label": lab, "score": {"bull": 0.6, "bear": -0.6, "neutral": 0.0}[lab], "likes": r.randint(0, 340)})
    items.sort(key=lambda x: x["ts"], reverse=True)
    return {"symbol": sym, "name": co["name"], "asof": now_iso(), "demo": True, "score": score, "label": sentiment_label(score), "mentions": mentions,
            "bull_pct": round(bull_pct, 1), "bear_pct": round(bear_pct, 1), "neutral_pct": round(100 - bull_pct - bear_pct, 1), "by_source": by, "history": hist, "items": items,
            "keywords": [{"w": w, "n": r.randint(4, 60)} for w in ["earnings", "guidance", "buyback", "valuation", "breakout", "dip", "margin", "demand"]]}


def main():
    for sub in ("fundamentals", "sentiment"):
        d = DATA / sub
        if d.exists():
            shutil.rmtree(d)
    cos = [make_company(row) for row in DEMO]
    for co in cos:
        write_json(DATA / "fundamentals" / f"{file_key(co['symbol'])}.json", co)
    idx = [index_row(c) for c in cos]
    write_json(DATA / "fundamentals" / "index.json", {"asof": now_iso(), "demo": True, "companies": idx})
    write_json(DATA / "fundamentals" / "feed.json", {**build_feed(cos), "demo": True})
    # market
    indices = []
    for sym, nm, base in [("^GSPC", "S&P 500", 6900), ("^IXIC", "Nasdaq", 23500), ("^NSEI", "Nifty 50", 25800), ("^VIX", "VIX", 16.5), ("GC=F", "Gold", 3900)]:
        r = rnd(sym); c = walk(r, base, 30, 0.008)
        indices.append({"symbol": sym, "name": nm, "price": round(c[-1], 2), "change_pct": round((c[-1] / c[-2] - 1) * 100, 2), "spark": [round(x, 2) for x in c]})
    quotes = {c["symbol"]: {"price": c["price"]["last"], "change_pct": c["price"]["change_pct"], "spark": [round(x, 2) for x in c["history"]["close"][-30:]]} for c in cos}
    write_json(DATA / "market.json", {"asof": now_iso(), "demo": True, "indices": indices, "quotes": quotes})
    # sentiment
    sents = [make_sentiment(c) for c in cos]
    for s in sents:
        write_json(DATA / "sentiment" / f"{file_key(s['symbol'])}.json", s)
    tick = []
    for s in sents:
        trend = [h["s"] for h in s["history"][-14:]]
        tick.append({"symbol": s["symbol"], "name": s["name"], "score": s["score"], "label": s["label"], "bull_pct": s["bull_pct"], "bear_pct": s["bear_pct"], "neutral_pct": s["neutral_pct"],
                     "mentions": s["mentions"], "mentions_change": round(rnd(s["symbol"] + "m").uniform(-40, 60), 0), "score_change": round(trend[-1] - trend[0], 1), "trend": trend, "by_source": s["by_source"]})
    tot = sum(t["mentions"] for t in tick) or 1
    ms = sum(t["score"] * t["mentions"] for t in tick) / tot
    write_json(DATA / "sentiment" / "summary.json", {
        "asof": now_iso(), "demo": True,
        "market": {"score": round(ms, 1), "label": sentiment_label(ms), "mentions": tot, "bull_pct": round(sum(t["bull_pct"] * t["mentions"] for t in tick) / tot, 1), "bear_pct": round(sum(t["bear_pct"] * t["mentions"] for t in tick) / tot, 1), "neutral_pct": round(sum(t["neutral_pct"] * t["mentions"] for t in tick) / tot, 1)},
        "sources": [
            {"id": "news", "name": "News headlines", "status": "ok", "items": 412, "note": "Google News and Yahoo Finance"},
            {"id": "stocktwits", "name": "StockTwits", "status": "ok", "items": 233},
            {"id": "reddit", "name": "Reddit", "status": "off", "note": "Needs free Reddit app keys (see README)"},
            {"id": "bluesky", "name": "Bluesky", "status": "ok", "items": 88},
            {"id": "mastodon", "name": "Mastodon", "status": "ok", "items": 41},
            {"id": "hn", "name": "Hacker News", "status": "ok", "items": 19},
            {"id": "youtube", "name": "YouTube", "status": "off", "note": "Needs a free YouTube Data API key"},
            {"id": "x", "name": "X (Twitter)", "status": "off", "note": "No free search access. Bluesky and StockTwits stand in."},
            {"id": "instagram", "name": "Instagram", "status": "off", "note": "No public search access."},
        ],
        "tickers": tick})
    write_json(DATA / "meta.json", {"version": 1, "demo": True, "generated_at": now_iso(), "jobs": {"quotes": now_iso(), "fundamentals": now_iso(), "edgar": now_iso(), "sentiment": now_iso()}, "tickers": [c["symbol"] for c in cos]})
    print(f"demo data written for {len(cos)} companies")


if __name__ == "__main__":
    main()
