"""Company fundamentals from Yahoo Finance (through yfinance): profile, valuation, earnings,
analyst ratings and targets, holders, dividends. Insiders, filings and news are filled by
other jobs, and this job never overwrites them."""
from __future__ import annotations

import math
import time
from datetime import date, datetime, timezone

from .common import DATA, file_key, log, now_iso, r2, read_json, safe_float, write_json
from .model import rating_label


def _f(x, nd=2):
    v = safe_float(x)
    return None if v is None else round(v, nd)


def _pct(x, nd=1):
    """Yahoo gives some ratios as fractions (0.21 = 21%)."""
    v = safe_float(x)
    return None if v is None else round(v * 100, nd)


def _isnan(x) -> bool:
    try:
        return x is None or (isinstance(x, float) and math.isnan(x))
    except Exception:
        return True


def _date(x) -> str | None:
    try:
        if x is None:
            return None
        if hasattr(x, "strftime"):
            return x.strftime("%Y-%m-%d")
        return str(x)[:10]
    except Exception:
        return None


# ------------------------------------------------------------------ pure transforms (unit-tested)
def stats_from_info(info: dict, last: float | None) -> dict:
    rate = safe_float(info.get("dividendRate")) or safe_float(info.get("trailingAnnualDividendRate"))
    dy = round(rate / last * 100, 2) if rate and last else None
    return {
        "pe_trailing": _f(info.get("trailingPE")), "pe_forward": _f(info.get("forwardPE")),
        "eps_ttm": _f(info.get("trailingEps")), "eps_fwd": _f(info.get("forwardEps")),
        "div_yield": dy, "beta": _f(info.get("beta")),
        "revenue_growth": _pct(info.get("revenueGrowth")), "profit_margin": _pct(info.get("profitMargins")),
        "roe": _pct(info.get("returnOnEquity")), "debt_equity": _f(info.get("debtToEquity"), 1),
        "short_pct_float": _pct(info.get("shortPercentOfFloat")),
        "held_insiders_pct": _pct(info.get("heldPercentInsiders")), "held_institutions_pct": _pct(info.get("heldPercentInstitutions")),
    }


def analysts_from(info: dict, targets: dict | None, rec_df, ud_df, last: float | None) -> dict:
    counts = {"strong_buy": 0, "buy": 0, "hold": 0, "sell": 0, "strong_sell": 0}
    try:
        if rec_df is not None and len(rec_df):
            row = rec_df.iloc[0]
            counts = {"strong_buy": int(row.get("strongBuy", 0)), "buy": int(row.get("buy", 0)), "hold": int(row.get("hold", 0)),
                      "sell": int(row.get("sell", 0)), "strong_sell": int(row.get("strongSell", 0))}
    except Exception:
        pass
    n_counts = sum(counts.values())
    ms = safe_float(info.get("recommendationMean"))
    if ms is None and n_counts:
        ms = (counts["strong_buy"] * 1 + counts["buy"] * 2 + counts["hold"] * 3 + counts["sell"] * 4 + counts["strong_sell"] * 5) / n_counts
    t = targets or {}
    target = {
        "low": _f(t.get("low") or info.get("targetLowPrice")), "mean": _f(t.get("mean") or info.get("targetMeanPrice")),
        "median": _f(t.get("median") or info.get("targetMedianPrice")), "high": _f(t.get("high") or info.get("targetHighPrice")),
        "current": _f(t.get("current") or last), "n": int(safe_float(info.get("numberOfAnalystOpinions"), 0) or 0) or None,
    }
    changes = []
    try:
        if ud_df is not None and len(ud_df):
            for ts, r in ud_df.head(14).iterrows():
                act = str(r.get("Action", "")).lower()
                label = {"up": "Upgrade", "down": "Downgrade", "init": "Initiated", "main": "Reiterated", "reit": "Reiterated"}.get(act, act.title() or "Update")
                fr, to = r.get("FromGrade"), r.get("ToGrade")
                changes.append({"date": _date(ts), "firm": str(r.get("Firm", "")), "action": label,
                                "from": None if _isnan(fr) or fr == "" else str(fr), "to": None if _isnan(to) or to == "" else str(to)})
    except Exception:
        pass
    if ms is None and not target["mean"] and not changes:
        return {}
    return {"mean_score": r2(ms), "rating_label": rating_label(ms), "counts": counts, "target": target, "changes": changes}


def earnings_from(dates_df, calendar: dict | None, qinc_df, today: date | None = None) -> dict:
    today = today or date.today()
    nxt, hist = {}, []
    try:
        if dates_df is not None and len(dates_df):
            for ts, r in dates_df.sort_index().iterrows():
                d = _date(ts)
                est, act, sur = r.get("EPS Estimate"), r.get("Reported EPS"), r.get("Surprise(%)")
                if _isnan(act):
                    if d and d >= today.isoformat() and not nxt:
                        nxt = {"date": d, "eps_est": None if _isnan(est) else _f(est), "rev_est": None}
                else:
                    hist.append({"date": d, "eps_est": None if _isnan(est) else _f(est), "eps_actual": _f(act),
                                 "surprise_pct": None if _isnan(sur) else _f(sur, 1)})
            hist.sort(key=lambda x: x["date"] or "", reverse=True)
            hist = hist[:10]
    except Exception:
        pass
    try:
        if calendar:
            ed = calendar.get("Earnings Date")
            first = ed[0] if isinstance(ed, (list, tuple)) and ed else ed
            d = _date(first)
            if d and d >= today.isoformat() and (not nxt or nxt.get("date") != d):
                nxt = {"date": d, "eps_est": _f(calendar.get("Earnings Average")) if calendar.get("Earnings Average") is not None else nxt.get("eps_est"), "rev_est": None}
            if nxt and calendar.get("Revenue Average") is not None:
                nxt["rev_est"] = safe_float(calendar.get("Revenue Average"))
    except Exception:
        pass
    quarters = []
    try:
        if qinc_df is not None and len(qinc_df):
            for col in list(qinc_df.columns)[:8]:
                def g(*names):
                    for n in names:
                        if n in qinc_df.index:
                            v = qinc_df.at[n, col]
                            return None if _isnan(v) else float(v)
                    return None
                quarters.append({"period": _date(col), "revenue": g("Total Revenue", "Operating Revenue"), "net_income": g("Net Income", "Net Income Common Stockholders"),
                                 "eps": _f(g("Diluted EPS", "Basic EPS"))})
    except Exception:
        pass
    if not (nxt or hist or quarters):
        return {}
    return {"next": nxt or None, "history": hist, "quarters": quarters}


def holders_from(major_df, inst_df) -> dict:
    out = {}
    try:
        if major_df is not None and len(major_df):
            v = major_df.iloc[:, 0]
            ins = v.get("insidersPercentHeld")
            inst = v.get("institutionsPercentHeld")
            out["major"] = {"insiders_pct": _pct(ins), "institutions_pct": _pct(inst)}
    except Exception:
        pass
    try:
        if inst_df is not None and len(inst_df):
            rows = []
            for _, r in inst_df.head(8).iterrows():
                pc = safe_float(r.get("pctChange"))
                rows.append({"name": str(r.get("Holder", "")), "pct": _pct(r.get("pctHeld"), 2), "shares": int(safe_float(r.get("Shares"), 0) or 0),
                             "change_pct": None if pc is None else round(pc * 100, 1), "date": _date(r.get("Date Reported"))})
            out["institutions"] = rows
    except Exception:
        pass
    return out


def actions_from(div_s, split_s) -> dict:
    out = {"dividends": [], "splits": []}
    try:
        if div_s is not None and len(div_s):
            out["dividends"] = [{"date": _date(i), "amount": round(float(v), 4)} for i, v in list(div_s.items())[-8:]][::-1]
        if split_s is not None and len(split_s):
            out["splits"] = [{"date": _date(i), "ratio": float(v)} for i, v in list(split_s.items())[-5:]][::-1]
    except Exception:
        pass
    return out


def news_from_yf(items: list | None) -> list[dict]:
    out = []
    for n in items or []:
        try:
            c = n.get("content") or n
            title = c.get("title")
            ts = c.get("pubDate") or c.get("providerPublishTime")
            if isinstance(ts, (int, float)):
                ts = datetime.fromtimestamp(ts, timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ")
            prov = c.get("provider") or {}
            src = (prov.get("displayName") if isinstance(prov, dict) else None) or c.get("publisher")
            url = (c.get("canonicalUrl") or {}).get("url") if isinstance(c.get("canonicalUrl"), dict) else c.get("link")
            if title and ts:
                out.append({"ts": str(ts), "title": title, "source": src or "Yahoo Finance", "url": url})
        except Exception:
            continue
    return out


# ------------------------------------------------------------------ live fetch
def _try(fn, default=None):
    try:
        return fn()
    except Exception as e:
        log.debug("fetch step failed: %s", e)
        return default


def fetch_company(sym: str, name_hint: str, market: str, prev: dict | None) -> dict | None:
    import yfinance as yf

    t = yf.Ticker(sym)
    info = {}
    for attempt in range(3):
        try:
            info = t.info or {}
            if info:
                break
        except Exception as e:
            msg = str(e).lower()
            log.warning("%s: info failed (%s)", sym, str(e)[:80])
            time.sleep(20 if "too many" in msg or "429" in msg else 3 * (attempt + 1))
    hist = _try(lambda: t.history(period="1y", interval="1d", auto_adjust=False))
    closes, dates = [], []
    if hist is not None and len(hist):
        h = hist.dropna(subset=["Close"])
        closes = [round(float(x), 2) for x in h["Close"].tolist()]
        dates = [_date(i) for i in h.index]
    if not closes and not info:
        return None
    last = closes[-1] if closes else _f(info.get("regularMarketPrice") or info.get("currentPrice"))
    prev_close = closes[-2] if len(closes) > 1 else _f(info.get("previousClose"))
    chg = round(last - prev_close, 2) if last is not None and prev_close else None
    vol = None
    avgv = None
    day_low = day_high = None
    if hist is not None and len(hist):
        try:
            vol = int(hist["Volume"].iloc[-1])
            day_low, day_high = _f(hist["Low"].iloc[-1]), _f(hist["High"].iloc[-1])
            avgv = int(hist["Volume"].tail(30).mean())
        except Exception:
            pass
    price = {
        "last": last, "prev_close": prev_close, "change": chg, "change_pct": round(chg / prev_close * 100, 2) if chg is not None and prev_close else None,
        "pre": None, "post": None, "day_low": day_low or _f(info.get("dayLow")), "day_high": day_high or _f(info.get("dayHigh")),
        "wk52_low": _f(info.get("fiftyTwoWeekLow")) or (min(closes) if closes else None), "wk52_high": _f(info.get("fiftyTwoWeekHigh")) or (max(closes) if closes else None),
        "volume": vol or safe_float(info.get("volume")), "avg_volume": avgv or safe_float(info.get("averageVolume")), "market_cap": safe_float(info.get("marketCap")),
    }
    ud = _try(lambda: t.upgrades_downgrades)
    rec = _try(lambda: t.recommendations)
    tg = _try(lambda: t.analyst_price_targets)
    co = {
        "symbol": sym, "name": info.get("longName") or info.get("shortName") or name_hint or sym, "market": market,
        "exchange": info.get("fullExchangeName") or info.get("exchange"), "currency": info.get("currency") or ("INR" if market == "IN" else "USD"),
        "sector": info.get("sector"), "industry": info.get("industry"), "website": info.get("website"),
        "about": info.get("longBusinessSummary"), "asof": now_iso(), "demo": False,
        "price": price, "history": {"dates": dates, "close": closes}, "stats": stats_from_info(info, last),
        "earnings": earnings_from(_try(lambda: t.get_earnings_dates(limit=12)), _try(lambda: t.calendar), _try(lambda: t.quarterly_income_stmt)),
        "analysts": analysts_from(info, tg, rec, ud, last),
        "holders": holders_from(_try(lambda: t.major_holders), _try(lambda: t.institutional_holders)),
        "actions": actions_from(_try(lambda: t.dividends), _try(lambda: t.splits)),
    }
    yfnews = news_from_yf(_try(lambda: t.news))
    # carry over sections that other jobs own, and any section Yahoo failed to give us this time
    p = prev or {}
    for k in ("insiders", "filings", "news"):
        if p.get(k):
            co[k] = p[k]
    if not co.get("news") and yfnews:
        co["news"] = yfnews
    for k in ("earnings", "analysts", "holders"):
        if not co.get(k) and p.get(k):
            co[k] = p[k]
    if not co["stats"].get("pe_trailing") and not co["stats"].get("beta") and p.get("stats"):
        co["stats"] = p["stats"]
    return co


def run(tickers: list[dict], limit: int | None = None) -> dict:
    ok, bad = 0, []
    for i, tk in enumerate(tickers[:limit] if limit else tickers):
        sym = tk["symbol"]
        path = DATA / "fundamentals" / f"{file_key(sym)}.json"
        prev = read_json(path)
        if prev and prev.get("demo"):
            prev = None
        try:
            co = fetch_company(sym, tk.get("name", ""), tk["market"], prev)
        except Exception as e:
            log.warning("%s failed: %s", sym, e)
            co = None
        if co:
            write_json(path, co)
            ok += 1
        else:
            bad.append(sym)
        time.sleep(1.6)
    log.info("fundamentals: %d ok, %d failed %s", ok, len(bad), bad)
    if ok == 0:
        raise RuntimeError("no company data came back")
    return {"ok": ok, "failed": bad}
