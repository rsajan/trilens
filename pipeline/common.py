"""Shared helpers: paths, atomic JSON IO, polite HTTP with retries, logging."""
from __future__ import annotations

import json
import logging
import os
import re
import time
from datetime import datetime, timezone
from pathlib import Path
from typing import Any

ROOT = Path(__file__).resolve().parent.parent
DATA = ROOT / "data"
CONFIG = ROOT / "config"

log = logging.getLogger("trilens")
if not log.handlers:
    logging.basicConfig(level=logging.INFO, format="%(asctime)s %(levelname)s %(message)s", datefmt="%H:%M:%S")


def now_iso() -> str:
    return datetime.now(timezone.utc).replace(microsecond=0).isoformat().replace("+00:00", "Z")


def file_key(sym: str) -> str:
    """Must match fileKey() in assets/js/lib/dom.js."""
    return re.sub(r"[^A-Za-z0-9]+", "_", str(sym))


def read_json(path: Path, default: Any = None) -> Any:
    try:
        with open(path, encoding="utf-8") as f:
            return json.load(f)
    except (FileNotFoundError, json.JSONDecodeError):
        return default


def write_json(path: Path, obj: Any, pretty: bool = False) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    tmp = path.with_suffix(path.suffix + ".tmp")
    with open(tmp, "w", encoding="utf-8") as f:
        if pretty:
            json.dump(obj, f, ensure_ascii=False, indent=2, default=str)
        else:
            json.dump(obj, f, ensure_ascii=False, separators=(",", ":"), default=str)
    os.replace(tmp, path)


def load_config() -> dict:
    cfg = read_json(CONFIG / "watchlist.json", {}) or {}
    cfg.setdefault("tickers", [])
    cfg.setdefault("indices", [])
    cfg.setdefault("sec_user_agent", "")
    return cfg


def market_of(symbol: str) -> str:
    return "IN" if symbol.upper().endswith((".NS", ".BO")) else "US"


def ticker_list(cfg: dict) -> list[dict]:
    """Normalised watchlist: [{symbol, name, market}], deduplicated, config order first,
    then (optionally) tickers that the PC-side scanners flagged."""
    out, seen = [], set()
    for t in cfg.get("tickers", []):
        t = {"symbol": t} if isinstance(t, str) else dict(t)
        sym = t["symbol"].strip().upper()
        if sym in seen:
            continue
        seen.add(sym)
        out.append({"symbol": sym, "name": t.get("name", ""), "market": market_of(sym)})
    if cfg.get("include_scanner_tickers", True):
        extra = read_json(DATA / "technical" / "public_signals.json", {}) or {}
        limit = int(cfg.get("max_scanner_tickers", 15))
        n = 0
        for sym, v in (extra.get("tickers") or {}).items():
            sym = sym.upper()
            if sym in seen or n >= limit:
                continue
            seen.add(sym)
            n += 1
            out.append({"symbol": sym, "name": v.get("name", ""), "market": market_of(sym)})
    return out


# ------------------------------------------------------------------ HTTP
_session = None


def session():
    global _session
    if _session is None:
        import requests

        _session = requests.Session()
        _session.headers.update({
            "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0 Safari/537.36 Trilens/1.0",
            "Accept-Language": "en-US,en;q=0.9",
        })
    return _session


def http_get(url: str, *, params=None, headers=None, retries: int = 2, timeout: int = 20, pause: float = 0.0):
    """GET with small retry/backoff. Returns the Response or None. Never raises."""
    import requests

    for attempt in range(retries + 1):
        try:
            r = session().get(url, params=params, headers=headers, timeout=timeout)
            if r.status_code == 200:
                if pause:
                    time.sleep(pause)
                return r
            if r.status_code in (429, 500, 502, 503, 504):
                time.sleep(1.5 * (attempt + 1))
                continue
            log.debug("GET %s -> %s", url, r.status_code)
            return None
        except requests.RequestException as e:
            log.debug("GET %s failed: %s", url, e)
            time.sleep(1.0 * (attempt + 1))
    return None


def safe_float(x, default=None):
    try:
        if x is None:
            return default
        v = float(x)
        if v != v or v in (float("inf"), float("-inf")):
            return default
        return v
    except (TypeError, ValueError):
        return default


def r2(x, nd=2):
    v = safe_float(x)
    return None if v is None else round(v, nd)
