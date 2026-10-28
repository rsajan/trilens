"""Company news from Google News RSS (free, no key), merged with whatever Yahoo supplied."""
from __future__ import annotations

import re
import time
import xml.etree.ElementTree as ET
from datetime import datetime, timedelta, timezone
from email.utils import parsedate_to_datetime
from urllib.parse import quote_plus

from .common import DATA, file_key, http_get, log, read_json, write_json

SUFFIX = re.compile(r"\b(inc|incorporated|corp|corporation|co|company|ltd|limited|plc|holdings|group|n\.v\.|s\.a\.|the)\b\.?,?", re.I)


def short_name(name: str, sym: str) -> str:
    n = SUFFIX.sub("", name or "").replace(",", " ").strip()
    n = re.sub(r"\s+", " ", n)
    return n or sym.split(".")[0]


def parse_rss(xml_text: str) -> list[dict]:
    try:
        root = ET.fromstring(xml_text)
    except ET.ParseError:
        return []
    out = []
    for it in root.iter("item"):
        title = (it.findtext("title") or "").strip()
        link = (it.findtext("link") or "").strip()
        pub = it.findtext("pubDate")
        src_el = it.find("source")
        src = src_el.text.strip() if src_el is not None and src_el.text else None
        if src and title.endswith(" - " + src):
            title = title[: -(len(src) + 3)]
        elif not src and " - " in title:
            title, src = title.rsplit(" - ", 1)
        try:
            ts = parsedate_to_datetime(pub).astimezone(timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ") if pub else None
        except Exception:
            ts = None
        if title and ts:
            out.append({"ts": ts, "title": title, "source": src or "Google News", "url": link or None})
    return out


def google_news(name: str, sym: str, market: str, days: int = 7) -> list[dict]:
    q = f'"{short_name(name, sym)}" stock when:{days}d' if name else f"{sym.split('.')[0]} stock when:{days}d"
    loc = "hl=en-IN&gl=IN&ceid=IN:en" if market == "IN" else "hl=en-US&gl=US&ceid=US:en"
    r = http_get(f"https://news.google.com/rss/search?q={quote_plus(q)}&{loc}", retries=2, timeout=20)
    return parse_rss(r.text) if r else []


def _key(t: str) -> str:
    return re.sub(r"[^a-z0-9]+", "", t.lower())[:70]


def merge(old: list[dict], new: list[dict], keep_days: int = 14, cap: int = 40) -> list[dict]:
    cut = (datetime.now(timezone.utc) - timedelta(days=keep_days)).strftime("%Y-%m-%dT%H:%M:%SZ")
    seen, out = set(), []
    for n in sorted(new + (old or []), key=lambda x: x["ts"], reverse=True):
        k = _key(n["title"])
        if k in seen or n["ts"] < cut:
            continue
        seen.add(k)
        out.append(n)
    return out[:cap]


def run(tickers: list[dict]) -> dict:
    ok = 0
    for tk in tickers:
        path = DATA / "fundamentals" / f"{file_key(tk['symbol'])}.json"
        co = read_json(path)
        if not co or co.get("demo"):
            continue
        items = google_news(co.get("name") or tk.get("name", ""), tk["symbol"], tk["market"])
        if items:
            co["news"] = merge(co.get("news") or [], items)
            write_json(path, co)
            ok += 1
        time.sleep(0.8)
    log.info("news: %d companies updated", ok)
    if ok == 0:
        raise RuntimeError("no news came back")
    return {"ok": ok}
