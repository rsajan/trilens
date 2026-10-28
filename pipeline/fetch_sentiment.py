"""Crowd sentiment from every free, legal source that works without paying.

Always tried (no key):  news headlines, StockTwits, Bluesky, Mastodon, Hacker News
Optional (free key):    Reddit (REDDIT_CLIENT_ID + REDDIT_CLIENT_SECRET), YouTube (YOUTUBE_API_KEY),
                        Bluesky login (BSKY_HANDLE + BSKY_APP_PASSWORD) if Bluesky closes anonymous search
Not available free:     X/Twitter and Instagram (their search needs paid access). The page says so.

Every source is wrapped so one failure never stops the others, and each source reports
its own status on the Sentiment page."""
from __future__ import annotations

import base64
import hashlib
import html
import os
import re
import time
from collections import defaultdict
from datetime import datetime, timedelta, timezone

from .common import DATA, file_key, http_get, log, now_iso, read_json, session, write_json
from .fetch_news import short_name
from .model import sentiment_label
from .sentiment_lexicon import keywords, score_text

AMBIGUOUS = {"A", "ALL", "ARE", "ON", "IT", "CAT", "COST", "NOW", "FAST", "LOW", "HAS", "KEY", "TRUE", "LOVE", "WELL", "BIG", "GOOD", "PEAK", "OPEN", "FUN", "SO", "T", "V", "F", "C", "D", "X", "Z", "UP", "AI", "PLAY"}
SOURCE_META = {
    "news": ("News headlines", "Google News and Yahoo Finance headlines"),
    "stocktwits": ("StockTwits", "Traders tag their own posts bullish or bearish"),
    "reddit": ("Reddit", "Needs free Reddit app keys (see README)"),
    "bluesky": ("Bluesky", "Public posts mentioning the cashtag"),
    "mastodon": ("Mastodon", "Public hashtag timelines"),
    "hn": ("Hacker News", "Stories and comments naming the company"),
    "youtube": ("YouTube", "Needs a free YouTube Data API key"),
    "x": ("X (Twitter)", "No free search access. Bluesky and StockTwits stand in."),
    "instagram": ("Instagram", "No public search access."),
}
DAYS = 7


def strip_html(s: str) -> str:
    return html.unescape(re.sub(r"\s+", " ", re.sub(r"<[^>]+>", " ", s or ""))).strip()


def iso(dt: datetime) -> str:
    return dt.astimezone(timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ")


def parse_ts(s) -> datetime | None:
    try:
        if isinstance(s, (int, float)):
            return datetime.fromtimestamp(s, timezone.utc)
        return datetime.fromisoformat(str(s).replace("Z", "+00:00")).astimezone(timezone.utc)
    except Exception:
        return None


def mentions_ticker(text: str, sym: str, name: str) -> bool:
    base = sym.split(".")[0].replace("-", "")
    if re.search(r"\$" + re.escape(base) + r"\b", text, flags=re.I):
        return True
    if base.upper() not in AMBIGUOUS and len(base) >= 3 and re.search(r"(?<![A-Za-z$])" + re.escape(base.upper()) + r"(?![A-Za-z])", text):
        return True
    nm = short_name(name, sym).lower()
    return len(nm) >= 5 and nm in text.lower()


def is_spam(text: str) -> bool:
    return len(re.findall(r"\$[A-Za-z]{1,5}\b", text)) > 6 or len(text) < 12 or text.lower().count("http") > 2


def mk(source, ts, author, text, url, likes=0, label=None, score=None):
    return {"ts": ts, "source": source, "author": author, "text": text[:400], "url": url, "likes": int(likes or 0), "label": label, "score": score}


# ------------------------------------------------------------------ collectors: each returns a list, or None when the source itself failed
def collect_news(sym, name, co, ctx):
    items = []
    cut = iso(datetime.now(timezone.utc) - timedelta(days=DAYS))
    for n in (co or {}).get("news", []):
        if n["ts"] >= cut:
            items.append(mk("news", n["ts"], n.get("source"), n["title"], n.get("url")))
    return items


def collect_stocktwits(sym, name, co, ctx):
    if sym.endswith((".NS", ".BO")):
        return []
    r = http_get(f"https://api.stocktwits.com/api/2/streams/symbol/{sym}.json", retries=1, timeout=15)
    if not r:
        return None
    out = []
    for m in r.json().get("messages", []):
        body = strip_html(m.get("body", ""))
        if is_spam(body):
            continue
        tag = ((m.get("entities") or {}).get("sentiment") or {}).get("basic")
        label, score = (("bull", 0.8) if tag == "Bullish" else ("bear", -0.8) if tag == "Bearish" else (None, None))
        out.append(mk("stocktwits", m.get("created_at", "").replace("Z", "Z"), (m.get("user") or {}).get("username"), body,
                      f"https://stocktwits.com/{(m.get('user') or {}).get('username')}/message/{m.get('id')}", ((m.get("likes") or {}).get("total")), label, score))
    return out


def bsky_token(ctx):
    if "bsky_token" in ctx:
        return ctx["bsky_token"]
    h, p = os.environ.get("BSKY_HANDLE"), os.environ.get("BSKY_APP_PASSWORD")
    tok = None
    if h and p:
        try:
            r = session().post("https://bsky.social/xrpc/com.atproto.server.createSession", json={"identifier": h, "password": p}, timeout=20)
            if r.status_code == 200:
                tok = r.json().get("accessJwt")
        except Exception:
            tok = None
    ctx["bsky_token"] = tok
    return tok


def collect_bluesky(sym, name, co, ctx):
    base = sym.split(".")[0]
    tok = bsky_token(ctx)
    host = "https://bsky.social" if tok else "https://public.api.bsky.app"
    hdr = {"Authorization": f"Bearer {tok}"} if tok else None
    r = http_get(f"{host}/xrpc/app.bsky.feed.searchPosts", params={"q": f"${base}", "limit": 40, "sort": "latest"}, headers=hdr, retries=1, timeout=20)
    if not r:
        return None
    out = []
    for p in r.json().get("posts", []):
        rec = p.get("record") or {}
        text = strip_html(rec.get("text", ""))
        if is_spam(text) or not mentions_ticker(text, sym, name):
            continue
        handle = (p.get("author") or {}).get("handle", "")
        rkey = (p.get("uri") or "").rsplit("/", 1)[-1]
        out.append(mk("bluesky", rec.get("createdAt"), handle, text, f"https://bsky.app/profile/{handle}/post/{rkey}", p.get("likeCount")))
    return out


def collect_mastodon(sym, name, co, ctx):
    tags = {sym.split(".")[0].lower()}
    nm = re.sub(r"[^a-z0-9]", "", short_name(name, sym).lower())
    if len(nm) >= 4:
        tags.add(nm)
    out, failed = [], 0
    for tag in tags:
        r = http_get(f"https://mastodon.social/api/v1/timelines/tag/{tag}", params={"limit": 40}, retries=1, timeout=15)
        if not r:
            failed += 1
            continue
        for s in r.json():
            text = strip_html(s.get("content", ""))
            if is_spam(text) or not mentions_ticker(text, sym, name):
                continue
            out.append(mk("mastodon", s.get("created_at"), (s.get("account") or {}).get("acct"), text, s.get("url"), s.get("favourites_count")))
    return None if failed == len(tags) else out


def collect_hn(sym, name, co, ctx):
    nm = short_name(name, sym)
    if len(nm) < 4:
        return []
    since = int((datetime.now(timezone.utc) - timedelta(days=DAYS)).timestamp())
    r = http_get("https://hn.algolia.com/api/v1/search_by_date", params={"query": f'"{nm}"', "tags": "(story,comment)", "numericFilters": f"created_at_i>{since}", "hitsPerPage": 30}, retries=1, timeout=15)
    if not r:
        return None
    out = []
    for h in r.json().get("hits", []):
        text = strip_html(h.get("title") or h.get("story_title") or h.get("comment_text") or "")
        if is_spam(text) or nm.lower() not in text.lower():
            continue
        out.append(mk("hn", iso(datetime.fromtimestamp(h["created_at_i"], timezone.utc)), h.get("author"), text, f"https://news.ycombinator.com/item?id={h.get('objectID')}", h.get("points")))
    return out


def reddit_token(ctx):
    if "reddit_token" in ctx:
        return ctx["reddit_token"]
    cid, sec = os.environ.get("REDDIT_CLIENT_ID"), os.environ.get("REDDIT_CLIENT_SECRET")
    tok = None
    if cid and sec:
        try:
            r = session().post("https://www.reddit.com/api/v1/access_token", data={"grant_type": "client_credentials"},
                               headers={"Authorization": "Basic " + base64.b64encode(f"{cid}:{sec}".encode()).decode(), "User-Agent": "trilens/1.0 (personal dashboard)"}, timeout=20)
            if r.status_code == 200:
                tok = r.json().get("access_token")
        except Exception:
            tok = None
    ctx["reddit_token"] = tok
    return tok


def collect_reddit(sym, name, co, ctx):
    tok = reddit_token(ctx)
    if not tok:
        return "off"
    base = sym.split(".")[0]
    subs = "wallstreetbets+stocks+investing+stockmarket+options+IndianStockMarket+IndiaInvestments" if sym.endswith(".NS") else "wallstreetbets+stocks+investing+stockmarket+options+StockMarket"
    r = http_get(f"https://oauth.reddit.com/r/{subs}/search", params={"q": f"${base} OR {short_name(name, sym)}", "restrict_sr": 1, "sort": "new", "t": "week", "limit": 40},
                 headers={"Authorization": f"bearer {tok}", "User-Agent": "trilens/1.0 (personal dashboard)"}, retries=1, timeout=20)
    if not r:
        return None
    out = []
    for c in r.json().get("data", {}).get("children", []):
        d = c.get("data", {})
        text = strip_html(d.get("title", "") + ". " + (d.get("selftext", "") or "")[:300])
        if is_spam(text) or not mentions_ticker(text, sym, name):
            continue
        out.append(mk("reddit", iso(datetime.fromtimestamp(d["created_utc"], timezone.utc)), d.get("author"), text, "https://www.reddit.com" + d.get("permalink", ""), d.get("score")))
    return out


def collect_youtube(sym, name, co, ctx):
    key = os.environ.get("YOUTUBE_API_KEY")
    if not key:
        return "off"
    if not ctx.get("youtube_due"):
        return "skip"
    since = iso(datetime.now(timezone.utc) - timedelta(days=DAYS))
    r = http_get("https://www.googleapis.com/youtube/v3/search", params={"part": "snippet", "q": f"{short_name(name, sym)} stock", "type": "video", "order": "date", "publishedAfter": since, "maxResults": 15, "key": key}, retries=1, timeout=20)
    if not r:
        return None
    out = []
    for v in r.json().get("items", []):
        sn = v.get("snippet", {})
        text = strip_html(sn.get("title", "") + ". " + sn.get("description", ""))
        if not mentions_ticker(text, sym, name):
            continue
        out.append(mk("youtube", sn.get("publishedAt"), sn.get("channelTitle"), text, f"https://www.youtube.com/watch?v={(v.get('id') or {}).get('videoId')}"))
    return out


COLLECTORS = [("news", collect_news), ("stocktwits", collect_stocktwits), ("bluesky", collect_bluesky), ("mastodon", collect_mastodon),
              ("hn", collect_hn), ("reddit", collect_reddit), ("youtube", collect_youtube)]


# ------------------------------------------------------------------ scoring and aggregation (unit-tested)
def label_items(items: list[dict]) -> list[dict]:
    seen, out = set(), []
    for it in items:
        ts = parse_ts(it.get("ts"))
        if not ts:
            continue
        it["ts"] = iso(ts)
        key = hashlib.md5((it["source"] + (it["url"] or it["text"][:80])).encode()).hexdigest()
        if key in seen:
            continue
        seen.add(key)
        if not it.get("label"):
            it["label"], it["score"] = score_text(it["text"])
        out.append(it)
    return out


def tally(items: list[dict]) -> dict:
    bull = sum(1 for i in items if i["label"] == "bull")
    bear = sum(1 for i in items if i["label"] == "bear")
    n = len(items)
    return {"n": n, "bull": bull, "bear": bear, "neutral": n - bull - bear, "score": round(100 * (bull - bear) / (n + 3), 1) if n else 0.0}


def aggregate(items: list[dict]) -> dict:
    by = defaultdict(list)
    for i in items:
        by[i["source"]].append(i)
    by_source = {s: tally(v) for s, v in by.items()}
    t = tally(items)
    n = max(t["n"], 1)
    score = round(100 * (t["bull"] - t["bear"]) / (t["n"] + 5), 1) if t["n"] else 0.0
    return {"score": score, "label": sentiment_label(score), "mentions": t["n"], "bull_pct": round(100 * t["bull"] / n, 1), "bear_pct": round(100 * t["bear"] / n, 1),
            "neutral_pct": round(100 * t["neutral"] / n, 1), "by_source": by_source}


def trend_from(history: list[dict], days: int = 14) -> list[float]:
    byday: dict[str, list[float]] = defaultdict(list)
    for h in history:
        byday[h["t"][:10]].append(h["s"])
    ks = sorted(byday)[-days:]
    return [round(sum(byday[k]) / len(byday[k]), 1) for k in ks]


def changes(history: list[dict], items: list[dict], score: float) -> tuple[float, float]:
    now = datetime.now(timezone.utc)
    old = [h["s"] for h in history if (now - parse_ts(h["t"])).total_seconds() > 20 * 3600]
    sc = round(score - (sum(old[-12:]) / len(old[-12:])), 1) if old else 0.0
    last24 = [i for i in items if (now - parse_ts(i["ts"])).total_seconds() <= 86400]
    prev24 = [i for i in items if 86400 < (now - parse_ts(i["ts"])).total_seconds() <= 172800]
    mc = round((len(last24) / len(prev24) - 1) * 100) if len(prev24) >= 5 else 0
    return sc, mc


def top_items(items: list[dict], k: int = 24) -> list[dict]:
    now = datetime.now(timezone.utc)

    def rank(i):
        age_h = max((now - parse_ts(i["ts"])).total_seconds() / 3600, 0.1)
        return (1 + min(i.get("likes") or 0, 200) ** 0.5) / (1 + age_h / 24) + (0.6 if i["label"] != "neutral" else 0)

    pick = sorted(items, key=rank, reverse=True)[:k]
    return sorted(pick, key=lambda i: i["ts"], reverse=True)


# ------------------------------------------------------------------ run
def run(tickers: list[dict]) -> dict:
    state_path = DATA / "sentiment" / "_state.json"
    state = read_json(state_path, {}) or {}
    ctx: dict = {}
    last_yt = parse_ts(state.get("youtube_last")) if state.get("youtube_last") else None
    ctx["youtube_due"] = not last_yt or (datetime.now(timezone.utc) - last_yt).total_seconds() > 20 * 3600
    status = {s: {"ok": 0, "fail": 0, "items": 0, "off": False} for s in SOURCE_META}
    rows, all_items = [], []
    for tk in tickers:
        sym = tk["symbol"]
        co = read_json(DATA / "fundamentals" / f"{file_key(sym)}.json") or {}
        if co.get("demo"):
            co = {}
        name = co.get("name") or tk.get("name") or sym
        items = []
        for sid, fn in COLLECTORS:
            try:
                got = fn(sym, name, co, ctx)
            except Exception as e:
                log.debug("%s %s: %s", sym, sid, e)
                got = None
            if got == "off":
                status[sid]["off"] = True
                continue
            if got == "skip":
                continue
            if got is None:
                status[sid]["fail"] += 1
                continue
            status[sid]["ok"] += 1
            status[sid]["items"] += len(got)
            items.extend(got)
            time.sleep(0.25)
        items = label_items(items)
        cut = datetime.now(timezone.utc) - timedelta(days=DAYS)
        items = [i for i in items if parse_ts(i["ts"]) >= cut]
        path = DATA / "sentiment" / f"{file_key(sym)}.json"
        prev = read_json(path, {}) or {}
        hist = [] if prev.get("demo") else list(prev.get("history", []))
        agg = aggregate(items)
        hist.append({"t": now_iso(), "s": agg["score"], "n": agg["mentions"]})
        hist = hist[-500:]
        sc_ch, mc_ch = changes(hist[:-1], items, agg["score"])
        kw = keywords([i["text"] for i in items], {sym.split(".")[0].lower(), *re.findall(r"[a-z]{4,}", short_name(name, sym).lower())})
        doc = {"symbol": sym, "name": name, "asof": now_iso(), "demo": False, **agg, "history": hist, "items": top_items(items), "keywords": kw}
        write_json(path, doc)
        all_items.extend(items)
        rows.append({"symbol": sym, "name": name, "score": agg["score"], "label": agg["label"], "bull_pct": agg["bull_pct"], "bear_pct": agg["bear_pct"], "neutral_pct": agg["neutral_pct"],
                     "mentions": agg["mentions"], "mentions_change": mc_ch, "score_change": sc_ch, "trend": trend_from(hist), "by_source": agg["by_source"]})
    if ctx.get("youtube_due") and os.environ.get("YOUTUBE_API_KEY"):
        state["youtube_last"] = now_iso()
        write_json(state_path, state)
    rows.sort(key=lambda r: r["mentions"], reverse=True)
    mk_agg = aggregate(all_items)
    sources = []
    for sid, (nm, note) in SOURCE_META.items():
        s = status.get(sid, {})
        if sid in ("x", "instagram") or (s.get("off") and not s.get("ok")):
            sources.append({"id": sid, "name": nm, "status": "off", "note": note})
        elif s.get("ok"):
            sources.append({"id": sid, "name": nm, "status": "ok", "items": s["items"], **({"note": f"{s['fail']} lookups failed"} if s["fail"] else {})})
        elif s.get("fail"):
            sources.append({"id": sid, "name": nm, "status": "error", "note": "Could not be reached on the last run. Will retry."})
        else:
            sources.append({"id": sid, "name": nm, "status": "off", "note": note})
    summary = {"asof": now_iso(), "demo": False, "market": {k: mk_agg[k] for k in ("score", "label", "mentions", "bull_pct", "bear_pct", "neutral_pct")}, "sources": sources, "tickers": rows}
    write_json(DATA / "sentiment" / "summary.json", summary)
    log.info("sentiment: %d tickers, %d items, sources ok: %s", len(rows), len(all_items), [s["id"] for s in sources if s["status"] == "ok"])
    if not all_items:
        raise RuntimeError("no sentiment items came back from any source")
    return {"tickers": len(rows), "items": len(all_items)}
