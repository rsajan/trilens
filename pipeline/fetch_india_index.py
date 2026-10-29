"""Builds the site's India universal search index: data/india/tickers.json.

Source: NSE's own public, static constituent list for the Nifty Total Market index - the
~750 largest NSE companies by free-float market value (it already covers Nifty 500 and Nifty
Midcap/Smallcap). Nifty Microcap 250 is added as a safety net for anything Total Market might
drop later; in practice it is already a subset. The full listed-equity file supplies face
value. These are plain archive files (no login, no bot-check, no key) - not the nseindia.com
live API, which blocks scripted access and is not used here. NSE's own index screening stands
in for "top companies by market cap" without this project fetching a market cap for each of
NSE's ~2,000 listings.

This does not give Screener.in-style figures (ROCE, promoter holding, quarter-over-quarter
variation): those come from NSE's protected corporate-filing APIs or from Screener's own site,
neither of which is fetchable here for free without working around bot protection, which this
project will not do. See CLAUDE.md."""
from __future__ import annotations

import csv
import io

from .common import DATA, http_get, log, now_iso, write_json

INDEX_LISTS = [
    "https://nsearchives.nseindia.com/content/indices/ind_niftytotalmarket_list.csv",
    "https://nsearchives.nseindia.com/content/indices/ind_niftymicrocap250_list.csv",
]
EQUITY_LIST = "https://nsearchives.nseindia.com/content/equities/EQUITY_L.csv"


def _csv_rows(text: str) -> list[dict]:
    return list(csv.DictReader(io.StringIO(text)))


def face_value_map(text: str) -> dict[str, str]:
    out = {}
    for row in _csv_rows(text):
        sym = (row.get("SYMBOL") or "").strip().upper()
        fv = (row.get(" FACE VALUE") or row.get("FACE VALUE") or "").strip()
        if sym and fv:
            out[sym] = fv
    return out


def build_rows(lists_text: list[str], fv_map: dict[str, str]) -> list[dict]:
    seen, rows = set(), []
    for text in lists_text:
        for row in _csv_rows(text):
            sym = (row.get("Symbol") or "").strip().upper()
            if not sym or sym in seen:
                continue
            seen.add(sym)
            rows.append({"s": sym, "n": (row.get("Company Name") or "").strip(), "ind": (row.get("Industry") or "").strip(),
                         "fv": fv_map.get(sym)})
    rows.sort(key=lambda r: r["s"])
    return rows


def run() -> dict:
    lists_text = []
    for url in INDEX_LISTS:
        r = http_get(url, timeout=25, retries=2)
        if r:
            lists_text.append(r.text)
        else:
            log.warning("india index: could not fetch %s", url)
    if not lists_text:
        raise RuntimeError("could not load any NSE index constituent list")
    fv_map = {}
    r = http_get(EQUITY_LIST, timeout=25, retries=2)
    if r:
        fv_map = face_value_map(r.text)
    else:
        log.warning("india index: could not fetch the face-value list")
    rows = build_rows(lists_text, fv_map)
    write_json(DATA / "india" / "tickers.json", {"generated_at": now_iso(), "source": "NSE Nifty 500 + Nifty Midsmallcap 400 constituents", "rows": rows})
    log.info("india index: %d companies", len(rows))
    return {"ok": len(rows)}
