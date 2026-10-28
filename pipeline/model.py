"""Data model helpers shared by the live pipeline and the demo generator:
the three "lens" rules, the per-company index row, and the cross-company feed."""
from __future__ import annotations

from datetime import date, datetime, timezone
from typing import Optional


# ------------------------------------------------------------------ lenses
def sma(values: list[float], n: int) -> Optional[float]:
    v = [x for x in values if x is not None]
    if len(v) < n:
        return None
    return sum(v[-n:]) / n


def fundamentals_lens(co: dict) -> tuple[Optional[int], str]:
    """+1 / 0 / -1 / None. Points from analysts, price target, last surprise, insider buying."""
    pts, parts, seen = 0, [], 0
    a = co.get("analysts") or {}
    ms = a.get("mean_score")
    if ms is not None:
        seen += 1
        if ms <= 2.2:
            pts += 1; parts.append("analysts rate it Buy")
        elif ms >= 3.2:
            pts -= 1; parts.append("analysts rate it Sell")
    t = a.get("target") or {}
    if t.get("mean") and t.get("current"):
        seen += 1
        up = (t["mean"] / t["current"] - 1) * 100
        if up >= 15:
            pts += 1; parts.append(f"target {up:+.0f}%")
        elif up <= -5:
            pts -= 1; parts.append(f"target {up:+.0f}%")
    hist = [h for h in (co.get("earnings") or {}).get("history", []) if h.get("surprise_pct") is not None]
    if hist:
        seen += 1
        s = hist[0]["surprise_pct"]
        if s >= 3:
            pts += 1; parts.append(f"beat estimates by {s:.0f}%")
        elif s <= -3:
            pts -= 1; parts.append(f"missed estimates by {abs(s):.0f}%")
    sm = (co.get("insiders") or {}).get("summary") or {}
    if sm.get("buys_90d") is not None:
        seen += 1
        if (sm.get("buys_90d") or 0) > 0 and (sm.get("net_value") or 0) > 0:
            pts += 1; parts.append("insiders net buyers")
        elif (sm.get("sells_90d") or 0) >= 3 and (sm.get("net_value") or 0) <= -1_000_000:
            pts -= 1; parts.append("heavy insider selling")
    if seen < 2:
        return None, "not enough data"
    state = 1 if pts >= 2 else -1 if pts <= -2 else 0
    return state, ", ".join(parts) or "mixed signals"


def technical_lens(closes: list[float]) -> tuple[Optional[int], str]:
    if not closes or len(closes) < 60:
        return None, "not enough price history"
    last = closes[-1]
    s50, s200 = sma(closes, 50), sma(closes, 200)
    if s200 is None:
        return (1 if last > s50 else -1), ("above its 50-day average" if last > s50 else "below its 50-day average")
    if last > s50 and last > s200:
        return 1, "above 50-day and 200-day averages"
    if last < s50 and last < s200:
        return -1, "below 50-day and 200-day averages"
    return 0, "between its 50-day and 200-day averages"


def rating_label(score: Optional[float]) -> Optional[str]:
    if score is None:
        return None
    return "Strong buy" if score <= 1.5 else "Buy" if score <= 2.5 else "Hold" if score <= 3.5 else "Sell" if score <= 4.5 else "Strong sell"


def sentiment_label(score: float) -> str:
    return "Very bullish" if score >= 50 else "Bullish" if score >= 20 else "Neutral" if score > -20 else "Bearish" if score > -50 else "Very bearish"


# ------------------------------------------------------------------ index row
def index_row(co: dict) -> dict:
    p = co.get("price") or {}
    a = co.get("analysts") or {}
    ins = (co.get("insiders") or {}).get("summary") or {}
    f_state, f_why = fundamentals_lens(co)
    closes = (co.get("history") or {}).get("close") or []
    t_state, t_why = technical_lens(closes)
    t = a.get("target") or {}
    return {
        "symbol": co["symbol"], "name": co.get("name"), "market": co.get("market"), "exchange": co.get("exchange"),
        "sector": co.get("sector"), "industry": co.get("industry"), "currency": co.get("currency"),
        "price": p.get("last"), "change_pct": p.get("change_pct"), "market_cap": p.get("market_cap"),
        "pe": (co.get("stats") or {}).get("pe_trailing"),
        "next_earnings": ((co.get("earnings") or {}).get("next") or {}).get("date"),
        "rating": a.get("rating_label"), "rating_score": a.get("mean_score"),
        "target_upside_pct": round((t["mean"] / t["current"] - 1) * 100, 1) if t.get("mean") and t.get("current") else None,
        "insider_net_90d": ins.get("net_value"),
        "spark": [round(x, 2) for x in closes[-30:]] if closes else [],
        "lens": {"F": f_state, "F_why": f_why, "T": t_state, "T_why": t_why},
        "asof": co.get("asof"),
    }


# ------------------------------------------------------------------ cross-company feed
def build_feed(companies: list[dict], limit: int = 150) -> dict:
    today = date.today().isoformat()
    earnings, reported, insiders, filings, news = [], [], [], [], []
    for co in companies:
        s, nm = co["symbol"], co.get("name")
        e = co.get("earnings") or {}
        nx = e.get("next") or {}
        if nx.get("date") and nx["date"] >= today:
            earnings.append({"symbol": s, "name": nm, "date": nx["date"], "eps_est": nx.get("eps_est")})
        for h in (e.get("history") or [])[:2]:
            if h.get("eps_actual") is not None:
                reported.append({"symbol": s, "name": nm, "date": h["date"], "eps_est": h.get("eps_est"), "eps_actual": h.get("eps_actual"), "surprise_pct": h.get("surprise_pct")})
        for t in (co.get("insiders") or {}).get("transactions", [])[:25]:
            insiders.append({**t, "symbol": s})
        for f in (co.get("filings") or [])[:25]:
            filings.append({**f, "symbol": s})
        for n in (co.get("news") or [])[:12]:
            news.append({**n, "symbol": s})
    insiders.sort(key=lambda x: x.get("date") or "", reverse=True)
    filings.sort(key=lambda x: x.get("date") or "", reverse=True)
    news.sort(key=lambda x: x.get("ts") or "", reverse=True)
    reported.sort(key=lambda x: x.get("date") or "", reverse=True)
    earnings.sort(key=lambda x: x["date"])
    return {
        "asof": datetime.now(timezone.utc).replace(microsecond=0).isoformat().replace("+00:00", "Z"),
        "earnings": earnings, "reported": reported[:60],
        "insiders": insiders[:limit], "filings": filings[:limit], "news": news[:limit],
    }
