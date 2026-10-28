"""Small finance-aware sentiment scorer. No downloads, no model, fully deterministic.

score_text(text) -> (label, score)   label in {"bull", "bear", "neutral"}, score in [-1, 1]

It is a lexicon with negation handling. It is deliberately simple so you can read
and change it: the word lists below are the whole model.
"""
from __future__ import annotations

import math
import re

BULL = {
    # direction and price action
    "bullish": 2.0, "bull": 1.5, "long": 0.8, "calls": 1.0, "call": 0.4, "moon": 1.5, "mooning": 1.8, "rally": 1.5, "rallies": 1.5, "rallying": 1.5,
    "breakout": 1.6, "breaks out": 1.6, "surge": 1.6, "surges": 1.6, "soar": 1.7, "soars": 1.7, "jump": 1.2, "jumps": 1.2, "climb": 1.0, "climbs": 1.0,
    "rebound": 1.2, "rebounds": 1.2, "recover": 1.0, "recovers": 1.0, "uptrend": 1.4, "higher": 0.6, "gain": 0.9, "gains": 0.9, "green": 0.7,
    "buy": 1.3, "buying": 1.2, "bought": 1.0, "accumulate": 1.3, "accumulating": 1.3, "load": 0.6, "loading": 0.8, "dip": 0.2, "btd": 1.4,
    "hodl": 1.0, "hold": 0.3, "holding": 0.4, "squeeze": 1.0, "undervalued": 1.6, "cheap": 0.9, "bargain": 1.2,
    # fundamentals and news
    "beat": 1.6, "beats": 1.6, "beating": 1.4, "topped": 1.4, "tops": 1.3, "exceeds": 1.3, "exceeded": 1.3, "outperform": 1.5, "outperforms": 1.5,
    "upgrade": 1.8, "upgraded": 1.8, "upgrades": 1.8, "raises": 1.0, "raised": 1.0, "boost": 1.2, "boosts": 1.2, "record": 1.0, "strong": 1.0,
    "growth": 0.8, "profit": 0.7, "profitable": 1.0, "dividend": 0.5, "buyback": 1.2, "repurchase": 1.0, "approval": 1.0, "approved": 1.0,
    "wins": 1.0, "win": 0.8, "contract": 0.5, "partnership": 0.7, "expands": 0.7, "expansion": 0.7, "bullrun": 1.6, "optimistic": 1.3, "confident": 0.9,
    "overweight": 1.0, "strongbuy": 1.8, "momentum": 0.8, "tailwind": 1.0, "tailwinds": 1.0, "guidance raised": 1.8, "all-time high": 1.6, "ath": 1.2,
    "insider buying": 1.5, "gem": 1.0, "undervalue": 1.4, "winner": 1.0, "rocket": 1.2, "lfg": 1.2,
}
BEAR = {
    "bearish": 2.0, "bear": 1.5, "short": 0.9, "shorting": 1.2, "puts": 1.0, "put": 0.4, "dump": 1.6, "dumping": 1.6, "crash": 2.0, "crashes": 2.0,
    "plunge": 1.8, "plunges": 1.8, "tumble": 1.6, "tumbles": 1.6, "slump": 1.5, "slumps": 1.5, "sink": 1.3, "sinks": 1.3, "drop": 1.0, "drops": 1.0,
    "fall": 0.8, "falls": 0.8, "falling": 1.0, "decline": 1.0, "declines": 1.0, "downtrend": 1.4, "lower": 0.6, "loss": 1.0, "losses": 1.1, "red": 0.7,
    "sell": 1.2, "selling": 1.0, "sold": 0.8, "selloff": 1.6, "sell-off": 1.6, "exit": 0.5, "overvalued": 1.6, "expensive": 0.7, "bubble": 1.5,
    "miss": 1.6, "misses": 1.6, "missed": 1.6, "disappoint": 1.5, "disappoints": 1.5, "disappointing": 1.5, "weak": 1.0, "warning": 1.1, "warns": 1.3,
    "downgrade": 1.8, "downgraded": 1.8, "downgrades": 1.8, "cuts": 1.0, "cut": 0.8, "slashes": 1.2, "lawsuit": 1.4, "sued": 1.3, "sues": 1.0,
    "investigation": 1.4, "probe": 1.2, "fraud": 2.0, "scandal": 1.8, "recall": 1.3, "layoffs": 1.2, "layoff": 1.2, "bankruptcy": 2.0, "bankrupt": 2.0,
    "default": 1.3, "delisting": 1.6, "dilution": 1.3, "offering": 0.6, "headwind": 1.0, "headwinds": 1.0, "underperform": 1.5, "underweight": 1.0,
    "bagholder": 1.5, "bagholders": 1.5, "rug": 1.6, "scam": 1.8, "ponzi": 1.8, "tank": 1.2, "tanks": 1.2, "tanking": 1.3, "fear": 0.8, "panic": 1.2,
    "guidance cut": 1.8, "insider selling": 1.4, "sec charges": 1.8, "halted": 0.8, "concern": 0.8, "concerns": 0.8, "risk": 0.3, "bleed": 1.3, "bleeding": 1.4,
}
EMOJI = {"🚀": 1.5, "📈": 1.2, "🐂": 1.5, "💎": 0.9, "🟢": 0.7, "🔥": 0.5, "💰": 0.5, "🤑": 0.8, "✅": 0.4,
         "📉": 1.2, "🐻": 1.5, "🔴": 0.7, "🩸": 1.3, "💀": 0.8, "⚠️": 0.6, "❌": 0.4, "🤡": 0.9, "😱": 0.7}
NEGATORS = {"not", "no", "never", "n't", "isn't", "aren't", "don't", "doesn't", "didn't", "won't", "wouldn't", "can't", "cannot", "without", "hardly", "fails", "failed", "unlikely"}
FLIP_PAIRS = {"fall short": -1.5, "falls short": -1.5, "short squeeze": 1.5, "short interest": 0.0, "shorts covering": 1.2, "buy the dip": 1.6, "sell the news": -1.2,
              "beat expectations": 1.6, "miss expectations": -1.6, "above expectations": 1.4, "below expectations": -1.4, "better than expected": 1.5, "worse than expected": -1.5,
              "all time high": 1.6, "new high": 1.2, "new low": -1.2, "52-week high": 1.2, "52-week low": -1.2, "price target raised": 1.6, "price target cut": -1.6,
              "price target lowered": -1.6, "raises price target": 1.6, "lowers price target": -1.6, "cut to sell": -1.8, "raised to buy": 1.8}

_WORD = re.compile(r"[a-z][a-z'\-]+|[\U0001F300-\U0001FAFF☀-➿]️?")
_TOK = re.compile(r"[a-z][a-z'\-]*|\d+|[\U0001F300-\U0001FAFF☀-➿]️?")


def _clean(t: str) -> str:
    t = re.sub(r"https?://\S+", " ", t or "")
    t = re.sub(r"<[^>]+>", " ", t)
    return t.replace("&amp;", "&").replace("&#39;", "'").replace("&quot;", '"')


def score_raw(text: str) -> float:
    """Unbounded evidence: positive means bullish."""
    t = _clean(text).lower()
    total = 0.0
    for phrase, w in FLIP_PAIRS.items():
        if phrase in t:
            total += w
            t = t.replace(phrase, " ")
    toks = _TOK.findall(t)
    for i, w in enumerate(toks):
        val = 0.0
        if w in BULL:
            val = BULL[w]
        elif w in BEAR:
            val = -BEAR[w]
        elif w in EMOJI:
            val = EMOJI[w] if w in ("🚀", "📈", "🐂", "💎", "🟢", "🔥", "💰", "🤑", "✅") else -EMOJI[w]
        if not val:
            continue
        window = toks[max(0, i - 3):i]
        if any(n in NEGATORS or n.endswith("n't") for n in window):
            val = -0.7 * val
        total += val
    return total


def score_text(text: str, bull_cut: float = 0.18) -> tuple[str, float]:
    raw = score_raw(text)
    s = math.tanh(raw / 2.5)
    if s >= bull_cut:
        return "bull", round(s, 3)
    if s <= -bull_cut:
        return "bear", round(s, 3)
    return "neutral", round(s, 3)


STOP = set("""a about above after again all also am an and any are as at be because been before being below between both but by can could did do does doing down during each few for from further had has have having he her here hers him his how i if in into is it its just like me more most my no nor not now of off on once only or other our out over own same she should so some such than that the their them then there these they this those through to too under until up us very was we were what when where which while who whom why will with would you your
stock stocks share shares market price today new says said one two get got going still much even back will may might year week day time per cent percent com www http https amp rt via""".split())


def keywords(texts: list[str], exclude: set[str], n: int = 8) -> list[dict]:
    from collections import Counter

    c: Counter = Counter()
    for t in texts:
        seen = set()
        for w in re.findall(r"[a-z][a-z\-']{3,}", _clean(t).lower()):
            if w in STOP or w in exclude or w in seen:
                continue
            seen.add(w)
            c[w] += 1
    return [{"w": w, "n": k} for w, k in c.most_common(n) if k >= 2]
