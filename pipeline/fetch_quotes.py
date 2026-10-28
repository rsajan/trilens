"""Prices: one bulk Yahoo download for the whole watchlist, plus pre/post-market prices for US names."""
from __future__ import annotations

import time
from datetime import datetime, timezone

from .common import DATA, log, now_iso, r2, read_json, safe_float, write_json

INDEX_NAMES = {
    "^GSPC": "S&P 500", "^IXIC": "Nasdaq", "^DJI": "Dow Jones", "^RUT": "Russell 2000", "^VIX": "VIX",
    "^NSEI": "Nifty 50", "^BSESN": "Sensex", "^NSEBANK": "Bank Nifty", "^STI": "Straits Times",
    "^FTSE": "FTSE 100", "^N225": "Nikkei 225", "^HSI": "Hang Seng", "^GDAXI": "DAX",
}


def _series(df, sym: str, col: str):
    """Pull one column for one symbol out of a yfinance frame, single or multi ticker."""
    try:
        cols = df.columns
        if getattr(cols, "nlevels", 1) > 1:
            if sym in cols.get_level_values(0):
                s = df[sym][col]
            elif sym in cols.get_level_values(1):
                s = df[col][sym]
            else:
                return []
        else:
            s = df[col]
        return [float(x) for x in s.dropna().tolist()]
    except Exception:
        return []


def quote_from_closes(closes: list[float]) -> dict | None:
    if len(closes) < 2:
        return None
    last, prev = closes[-1], closes[-2]
    if not prev:
        return None
    return {"price": round(last, 2), "prev_close": round(prev, 2), "change_pct": round((last / prev - 1) * 100, 2), "spark": [round(x, 2) for x in closes[-30:]]}


def extended_hours(sym_frame_last_ts, price: float, regular_close: float) -> tuple[str | None, float | None]:
    """sym_frame_last_ts: tz-aware timestamp of the newest 5-minute bar (any tz)."""
    try:
        import pandas as pd

        ts = pd.Timestamp(sym_frame_last_ts)
        ny = ts.tz_convert("America/New_York")
        mins = ny.hour * 60 + ny.minute
        age_h = (pd.Timestamp.now(tz="UTC") - ts.tz_convert("UTC")).total_seconds() / 3600
        if age_h > 20 or ny.weekday() >= 5 and age_h > 70:
            return None, None
        if mins < 9 * 60 + 30:
            return "pre", price
        if mins >= 16 * 60:
            return "post", price
    except Exception:
        pass
    return None, None


def run(symbols: list[str], indices: list[str]) -> dict:
    import yfinance as yf

    prev = read_json(DATA / "market.json", {}) or {}
    prev_q = prev.get("quotes", {}) if not prev.get("demo") else {}
    prev_i = {i["symbol"]: i for i in prev.get("indices", [])} if not prev.get("demo") else {}
    quotes, ok, miss = {}, 0, []

    def chunked(seq, n):
        for i in range(0, len(seq), n):
            yield seq[i:i + n]

    for batch in chunked(symbols, 25):
        df = None
        for attempt in range(3):
            try:
                df = yf.download(batch, period="3mo", interval="1d", auto_adjust=False, group_by="ticker", threads=False, progress=False)
                if df is not None and len(df):
                    break
            except Exception as e:
                log.warning("quotes batch failed (%s), try %d", e, attempt + 1)
            time.sleep(4 * (attempt + 1))
        for s in batch:
            q = quote_from_closes(_series(df, s, "Close")) if df is not None else None
            if q:
                quotes[s] = q
                ok += 1
            else:
                miss.append(s)
                if s in prev_q:
                    quotes[s] = prev_q[s]
        time.sleep(1.0)

    # pre/post market, US names only
    us = [s for s in symbols if not s.endswith((".NS", ".BO")) and s in quotes]
    if us:
        try:
            ex = yf.download(us, period="1d", interval="5m", prepost=True, auto_adjust=False, group_by="ticker", threads=False, progress=False)
            for s in us:
                try:
                    sub = ex[s] if getattr(ex.columns, "nlevels", 1) > 1 else ex
                    sub = sub.dropna(subset=["Close"])
                    if sub.empty:
                        continue
                    where, px = extended_hours(sub.index[-1], float(sub["Close"].iloc[-1]), quotes[s]["price"])
                    quotes[s].pop("pre_price", None)
                    quotes[s].pop("post_price", None)
                    if where and px and abs(px - quotes[s]["price"]) > 0.004:
                        quotes[s]["pre_price" if where == "pre" else "post_price"] = round(px, 2)
                except Exception:
                    continue
        except Exception as e:
            log.info("extended-hours prices unavailable: %s", e)

    # indices
    idx_out = []
    if indices:
        try:
            df = yf.download(indices, period="3mo", interval="1d", auto_adjust=False, group_by="ticker", threads=False, progress=False)
        except Exception as e:
            log.warning("index download failed: %s", e)
            df = None
        for s in indices:
            q = quote_from_closes(_series(df, s, "Close")) if df is not None else None
            if q:
                idx_out.append({"symbol": s, "name": INDEX_NAMES.get(s, s), "price": q["price"], "change_pct": q["change_pct"], "spark": q["spark"]})
            elif s in prev_i:
                idx_out.append(prev_i[s])

    log.info("quotes: %d of %d symbols, %d indices", ok, len(symbols), len(idx_out))
    if not quotes and not idx_out:
        raise RuntimeError("no quotes came back (Yahoo may be rate limiting this network)")
    out = {"asof": now_iso(), "demo": False, "indices": idx_out, "quotes": quotes}
    write_json(DATA / "market.json", out)
    return {"ok": ok, "missing": miss}
