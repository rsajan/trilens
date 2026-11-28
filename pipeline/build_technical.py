#!/usr/bin/env python3
"""Build the Technical page from the scanner folders on THIS computer.

Reads (read-only, nothing in those folders is changed):
  - the Reversal bot folder        (specs, backtest workbooks, pine scripts, logic2 output)
  - the Accumulation bot folder    (latest scan CSVs, README, SOP)
  - the scans folder               (LATEST_US / LATEST_India reports, revenue and dip JSON)
  - PAPER_TRADING.xlsx             (live paper-trade scorecard)
  - technical_uploads/             (anything you drop in later)

Writes into data/technical/:
  bundle.json         AES-256-GCM encrypted with your password (this is what gets published)
  bundle.local.json   the same content unencrypted, for PREVIEW.bat only (git-ignored)
  meta.json           build time and counts only
  prices.json         end-of-day stock prices for the chart, encrypted the same way (needs pandas)
  prices.local.json   the same prices unencrypted, for PREVIEW.bat only (git-ignored)
  public_signals.json only if publish_public_signals is true (ticker symbols and BUY/WATCH, nothing else)

Needs: openpyxl, cryptography.  Optional: Pillow (shrinks big images), pypdf (reads PDFs).
"""
from __future__ import annotations

import argparse
import base64
import csv
import gzip
import hashlib
import html
import io
import json
import os
import re
import secrets
import sys
import zipfile
from datetime import date, datetime, timezone
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
OUT = ROOT / "data" / "technical"
PBKDF2_ITER = 250_000

NOTES: list[str] = []


def note(msg: str) -> None:
    NOTES.append(msg)
    print("  note:", msg)


# ------------------------------------------------------------------ small helpers
def read_json(p: Path, default=None):
    try:
        return json.loads(Path(p).read_text(encoding="utf-8"))
    except Exception:
        return default


def slug(s: str) -> str:
    return re.sub(r"[^a-z0-9]+", "-", s.lower()).strip("-")[:60] or "item"


def num(v):
    """Turn a cell into a clean JSON value."""
    if v is None:
        return None
    if isinstance(v, bool):
        return v
    if isinstance(v, (datetime, date)):
        return v.strftime("%Y-%m-%d")
    if isinstance(v, int):
        return v
    if isinstance(v, float):
        if v != v or v in (float("inf"), float("-inf")):
            return None
        return int(v) if v.is_integer() and abs(v) < 1e15 else round(v, 4)
    s = str(v).strip()
    if s == "":
        return None
    if re.fullmatch(r"-?\d+", s) and len(s) < 16:
        return int(s)
    if re.fullmatch(r"-?\d*\.\d+(e-?\d+)?|-?\d+\.\d*", s):
        try:
            return round(float(s), 4)
        except ValueError:
            pass
    return s


def truthy(v):
    if isinstance(v, bool):
        return v
    s = str(v).strip().lower() if v is not None else ""
    return True if s == "true" else False if s == "false" else None


def read_csv_rows(p: Path) -> tuple[list[str], list[list]]:
    with open(p, encoding="utf-8-sig", newline="") as f:
        sample = f.read(4096)
        f.seek(0)
        dialect = csv.excel_tab if sample.count("\t") > sample.count(",") else csv.excel
        rd = csv.reader(f, dialect)
        rows = list(rd)
    if not rows:
        return [], []
    cols = [c.strip() for c in rows[0]]
    return cols, [[num(c) for c in r] for r in rows[1:] if any(str(c).strip() for c in r)]


def read_xlsx(p: Path, sheets: list[str] | None = None, max_rows: int = 100000):
    """Return {sheet_name: (columns, rows)}"""
    import openpyxl

    wb = openpyxl.load_workbook(p, read_only=True, data_only=True)
    out = {}
    for ws in wb.worksheets:
        if sheets and ws.title not in sheets:
            continue
        it = ws.iter_rows(values_only=True)
        try:
            head = next(it)
        except StopIteration:
            continue
        cols = ["" if c is None else str(c).strip() for c in head]
        while cols and cols[-1] == "":
            cols.pop()
        rows = []
        for r in it:
            r = [num(c) for c in list(r)[: len(cols)]]
            if any(c not in (None, "") for c in r):
                rows.append(r)
            if len(rows) >= max_rows:
                break
        out[ws.title] = (cols, rows)
    wb.close()
    return out


def sheet_dicts(p: Path, sheet: str):
    d = read_xlsx(p, [sheet]).get(sheet)
    if not d:
        return []
    cols, rows = d
    return [dict(zip(cols, r)) for r in rows]


# ------------------------------------------------------------------ paths
class Dirs:
    def __init__(self, a):
        cfg = read_json(ROOT / "config" / "technical_sources.json", {}) or {}
        self.cfg = cfg

        def pick(arg, key):
            v = arg or cfg.get(key) or ""
            return Path(os.path.expanduser(v)) if v else None

        self.reversal = pick(a.reversal_dir, "reversal_dir")
        self.accumulation = pick(a.accumulation_dir, "accumulation_dir")
        self.ema = pick(getattr(a, "ema_dir", None), "ema_dir")
        self.playbook = pick(getattr(a, "playbook_dir", None), "playbook_dir")
        self.scans = pick(a.scans_dir, "scans_dir")
        self.paper = pick(a.paper_book, "paper_book")
        up = cfg.get("uploads_dir", "technical_uploads")
        self.uploads = Path(a.uploads_dir) if a.uploads_dir else (ROOT / up)

    def fill(self, s: str) -> str:
        return (s.replace("{reversal_dir}", str(self.reversal or ""))
                 .replace("{accumulation_dir}", str(self.accumulation or ""))
                 .replace("{ema_dir}", str(self.ema or ""))
                 .replace("{playbook_dir}", str(self.playbook or ""))
                 .replace("{scans_dir}", str(self.scans or "")))

    def path(self, s: str) -> Path:
        return Path(self.fill(s))


# ------------------------------------------------------------------ metrics from workbooks
def resolve_metrics(spec: dict, D: Dirs) -> dict:
    p = D.path(spec["file"])
    if not p.exists():
        return {}
    try:
        if p.suffix.lower() == ".csv":
            cols, rows = read_csv_rows(p)
            recs = [dict(zip(cols, r)) for r in rows]
        else:
            recs = sheet_dicts(p, spec["sheet"])
    except Exception as e:  # unreadable or locked workbook: keep the curated numbers
        note(f"could not read {p.name}: {e}")
        return {}
    row = None
    if "match" in spec:
        for r in recs:
            if all(str(r.get(k)) == str(v) for k, v in spec["match"].items()):
                row = r
                break
    elif "row" in spec and len(recs) > spec["row"]:
        row = recs[spec["row"]]
    if not row:
        note(f"no matching row in {p.name} for {spec.get('match') or spec.get('row')}")
        return {}
    out = {}
    for k, src in spec["map"].items():
        if isinstance(src, list):
            v = row.get(src[0])
            if v is not None:
                out[k] = src[1].format(int(v) if isinstance(v, (int, float)) else v)
        else:
            v = row.get(src)
            if isinstance(v, (int, float)):
                out[k] = v
    return out


# ------------------------------------------------------------------ library items
TEXT_EXT = {".txt", ".pine", ".py", ".log", ".json", ".bat", ".ps1", ".yml", ".yaml", ".ini", ".cfg", ".toml", ".sql", ".js", ".r"}
IMG_MIME = {".png": "image/png", ".jpg": "image/jpeg", ".jpeg": "image/jpeg", ".gif": "image/gif", ".webp": "image/webp", ".svg": "image/svg+xml"}
MAX_TEXT = 600_000
MAX_ROWS = 300
MAX_COLS = 40


def kind_of(p: Path) -> str | None:
    e = p.suffix.lower()
    if e in (".md", ".markdown", ".docx"):
        return "doc"
    if e in TEXT_EXT:
        return "text"
    if e in (".csv", ".tsv", ".xlsx", ".xlsm"):
        return "table"
    if e in (".html", ".htm"):
        return "report"
    if e in IMG_MIME:
        return "image"
    if e == ".pdf":
        return "doc"
    return None


def read_text(p: Path) -> str:
    raw = p.read_bytes()
    for enc in ("utf-8-sig", "utf-16", "cp1252"):
        try:
            t = raw.decode(enc)
            break
        except UnicodeError:
            continue
    else:
        t = raw.decode("utf-8", "replace")
    if len(t) > MAX_TEXT:
        t = t[:MAX_TEXT] + "\n\n[Shortened: the file is longer than the page shows.]"
    return t


def docx_to_md(p: Path) -> str:
    with zipfile.ZipFile(p) as z:
        xml = z.read("word/document.xml").decode("utf-8", "replace")
    paras = re.findall(r"<w:p[ >].*?</w:p>", xml, flags=re.S)
    out = []
    for para in paras:
        txt = "".join(re.findall(r"<w:t[^>]*>(.*?)</w:t>", para, flags=re.S))
        txt = (txt.replace("&amp;", "&").replace("&lt;", "<").replace("&gt;", ">").replace("&quot;", '"').replace("&apos;", "'"))
        m = re.search(r'<w:pStyle w:val="Heading(\d)"', para)
        if m and txt.strip():
            txt = "#" * min(int(m.group(1)), 4) + " " + txt
        elif "<w:numPr>" in para and txt.strip():
            txt = "- " + txt
        out.append(txt)
    return "\n\n".join(t for t in out if t.strip())


def pdf_to_md(p: Path) -> str | None:
    try:
        from pypdf import PdfReader
    except Exception:
        return None
    try:
        r = PdfReader(str(p))
        pages = [(pg.extract_text() or "").strip() for pg in r.pages[:80]]
        return "\n\n".join(t for t in pages if t) or None
    except Exception:
        return None


def shrink_image(raw: bytes, suffix: str) -> bytes:
    if len(raw) <= 700_000 or suffix == ".svg":
        return raw
    try:
        from PIL import Image
    except Exception:
        return raw
    try:
        im = Image.open(io.BytesIO(raw))
        im.thumbnail((1600, 1600))
        buf = io.BytesIO()
        if suffix in (".jpg", ".jpeg"):
            im.convert("RGB").save(buf, "JPEG", quality=84, optimize=True)
        else:
            im.save(buf, "PNG", optimize=True)
        return buf.getvalue() if len(buf.getvalue()) < len(raw) else raw
    except Exception:
        return raw


def table_sheets(p: Path):
    if p.suffix.lower() in (".csv", ".tsv"):
        cols, rows = read_csv_rows(p)
        return [{"name": p.stem, "columns": cols[:MAX_COLS], "rows": [r[:MAX_COLS] for r in rows[:MAX_ROWS]], "total_rows": len(rows)}]
    out = []
    for name, (cols, rows) in read_xlsx(p).items():
        if not cols:
            continue
        out.append({"name": name, "columns": cols[:MAX_COLS], "rows": [r[:MAX_COLS] for r in rows[:MAX_ROWS]], "total_rows": len(rows)})
        if len(out) >= 12:
            break
    return out


def make_item(p: Path, *, id: str, title: str | None, source: str, kind: str | None = None):
    kind = kind or kind_of(p)
    if kind is None or not p.exists() or not p.is_file():
        return None
    st = p.stat()
    item = {"id": id, "title": title or p.stem.replace("_", " ").replace("-", " ").strip(), "kind": kind, "source": source,
            "mtime": datetime.fromtimestamp(st.st_mtime, timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ")}
    try:
        e = p.suffix.lower()
        if kind == "doc":
            if e == ".docx":
                item["md"] = docx_to_md(p)
            elif e == ".pdf":
                md = pdf_to_md(p)
                if not md:
                    note(f"{p.name}: PDF text could not be read (install pypdf, or save it as Markdown)")
                    return None
                item["md"] = md
            else:
                item["md"] = read_text(p)
        elif kind == "text":
            item["text"] = read_text(p)
        elif kind == "report":
            item["html"] = read_text(p)
        elif kind == "image":
            raw = shrink_image(p.read_bytes(), e)
            item["mime"] = IMG_MIME[e]
            item["b64"] = base64.b64encode(raw).decode()
        elif kind == "table":
            item["sheets"] = table_sheets(p)
            if not item["sheets"]:
                return None
    except Exception as ex:
        note(f"{p.name}: skipped ({ex})")
        return None
    return item


def md_title(md: str, fallback: str) -> str:
    m = re.search(r"^#\s+(.+)$", md or "", flags=re.M)
    return m.group(1).strip()[:90] if m else fallback


def build_library(cur: dict, D: Dirs) -> list[dict]:
    items, seen = [], set()
    for d in cur.get("docs", []):
        p = D.path(d["path"])
        if not p.exists():
            note(f"library file not found: {p.name}")
            continue
        it = make_item(p, id=d["id"], title=d["title"], source=p.parent.name, kind=d.get("kind"))
        if it:
            items.append(it)
            seen.add(it["id"])
    if D.uploads.exists():
        for p in sorted(D.uploads.rglob("*")):
            if not p.is_file() or p.name.startswith((".", "~$")) or p.name.lower() in ("readme.md", "readme.txt"):
                continue
            rel = p.relative_to(D.uploads).as_posix()
            base = "up-" + slug(rel)
            i, id_ = 2, base
            while id_ in seen:
                id_ = f"{base}-{i}"
                i += 1
            it = make_item(p, id=id_, title=None, source="technical_uploads")
            if it:
                if it["kind"] == "doc":
                    it["title"] = md_title(it.get("md", ""), it["title"])
                items.append(it)
                seen.add(id_)
    return items


# ------------------------------------------------------------------ signals: Accumulation bot
CHECKS = ["A1", "A2", "A3", "A4", "A5", "B1", "B2", "B3", "B4", "B5", "B6", "B7"]


def acc_row(r: dict) -> dict:
    o = {
        "ticker": str(r.get("ticker") or "").strip(),
        "grade": r.get("grade"), "verdict": r.get("verdict"), "sector": r.get("sector"), "industry": r.get("industry"),
        "close": num(r.get("close")), "pivot": num(r.get("pivot")), "entry": num(r.get("entry")), "stop": num(r.get("stop")),
        "risk_pct": num(r.get("risk_pct")), "target": num(r.get("target")), "rr": num(r.get("rr")),
        "shares": num(r.get("shares")), "earnings": r.get("earnings") or None, "rs_rating": num(r.get("rs_rating")),
        "breakout_vol_x": num(r.get("breakout_vol_x")),
    }
    o["checks"] = {k: truthy(r.get(k)) for k in CHECKS}
    return o


def read_accumulation(D: Dirs) -> dict:
    out = {}
    if not D.accumulation:
        return out
    rep = D.accumulation / "reports"
    if not rep.exists():
        note("Accumulation bot: no reports folder found")
        return out
    for mk in ("US", "IN"):
        meta = read_json(rep / f"latest_{mk}.json", {}) or {}
        files = sorted(rep.glob(f"accumulation_scan_{mk}_*.csv"))
        if not files:
            continue
        want = rep / f"accumulation_scan_{mk}_{meta.get('date')}.csv"
        f = want if want.exists() else files[-1]
        try:
            cols, rows = read_csv_rows(f)
        except Exception as e:
            note(f"Accumulation {mk}: could not read {f.name} ({e})")
            continue
        recs = [dict(zip(cols, [c if c is not None else "" for c in r])) for r in rows]
        buys, watch, near = [], [], []
        for r in recs:
            lst = str(r.get("list") or "").upper()
            if not r.get("ticker"):
                continue
            (buys if lst.startswith(("BUY", "BREAKOUT")) else watch if lst.startswith("WATCH") else near).append(acc_row(r))
        if not buys:
            for r in meta.get("buy_rows") or []:
                buys.append(acc_row(r))
        m = re.search(r"(\d{4}-\d{2}-\d{2})", f.name)
        out[mk] = {
            "date": meta.get("date") or (m.group(1) if m else None), "scanned_at": meta.get("scanned_at"),
            "regime": meta.get("regime"), "gate": bool(meta.get("gate")), "cur": meta.get("cur") or ("₹" if mk == "IN" else "$"),
            "buys": buys, "watch": watch, "near": near[:60],
        }
    return out


# ------------------------------------------------------------------ signals: Reversal bot + Revenue and dip
def _strip_tags(s: str) -> str:
    s = re.sub(r"<br\s*/?>", "\n", s)
    s = re.sub(r"<[^>]+>", "", s)
    return html.unescape(s).strip()


def _div_text(text: str, cls: str) -> str | None:
    m = re.search(rf"<div class=['\"]{cls}['\"]>(.*?)</div>", text, re.DOTALL)
    return _strip_tags(m.group(1)) if m else None


def _parse_dataframe_tables(text: str) -> list[dict]:
    """Each <h2>title</h2><table class="dataframe">...</table> in the reversal bot's own
    report -- a plain pandas .to_html() table, so no nested markup inside a cell -- becomes
    {title, cols, rows} with rows as lists of cell strings."""
    out = []
    for m in re.finditer(r"<h2>(.*?)</h2>\s*<table class=\"dataframe\">(.*?)</table>", text, re.DOTALL):
        title = _strip_tags(m.group(1))
        table_html = m.group(2)
        cols = []
        thead_m = re.search(r"<thead>(.*?)</thead>", table_html, re.DOTALL)
        if thead_m:
            cols = [_strip_tags(c) for c in re.findall(r"<th[^>]*>(.*?)</th>", thead_m.group(1), re.DOTALL)]
        rows = []
        tbody_m = re.search(r"<tbody>(.*?)</tbody>", table_html, re.DOTALL)
        if tbody_m:
            for row_m in re.finditer(r"<tr[^>]*>(.*?)</tr>", tbody_m.group(1), re.DOTALL):
                cells = [_strip_tags(c) for c in re.findall(r"<td[^>]*>(.*?)</td>", row_m.group(1), re.DOTALL)]
                if cells:
                    rows.append(cells)
        out.append({"title": title, "cols": cols, "rows": rows})
    return out


REVERSAL_ROW_COLS = ["timeframe", "symbol", "date", "pattern", "close", "confirm_close", "trigger_above",
                     "stop", "risk_pct", "risk_mult", "target", "rsi", "vol_x_avg", "bars_ago", "action"]
REVERSAL_STRING_COLS = ("timeframe", "symbol", "date", "pattern", "action")
REVERSAL_STATE_FROM_TITLE = (("Actionable now", "ACTIONABLE"), ("Pending", "PENDING"), ("Already triggered", "TRIGGERED"))
REVERSAL_STATE_ORDER = {"ACTIONABLE": 0, "PENDING": 1, "TRIGGERED": 2}


def read_reversal(D: Dirs) -> dict:
    out = {}
    if not D.scans or not D.scans.exists():
        note("scans folder not found: the Reversal bot and Revenue and dip signals will appear once PUBLISH.bat runs on the PC that has it")
        return out
    for mk in ("US", "India"):
        h, t = D.scans / f"LATEST_{mk}.html", D.scans / f"LATEST_{mk}.txt"
        if not h.exists() and not t.exists():
            continue
        raw = read_text(h) if h.exists() else ""
        text = raw or read_text(t)
        m = re.search(r"data through (\d{4}-\d{2}-\d{2})", text)
        item = {"asof": m.group(1) if m else datetime.fromtimestamp((h if h.exists() else t).stat().st_mtime).strftime("%Y-%m-%d")}
        m2 = re.search(r"SCAN\s+(\d{4}-\d{2}-\d{2})_(\d{2})(\d{2})\b", text)
        item["run_at"] = f"{m2.group(1)} {m2.group(2)}:{m2.group(3)}" if m2 else None
        if raw:
            item["gates"] = _div_text(raw, "sub")
            item["throttle"] = _div_text(raw, "warn")
            item["headline"] = _div_text(raw, "trig")
            configs: dict[str, list] = {}
            counts: dict[str, int] = {}
            for sec in _parse_dataframe_tables(raw):
                state = next((s for prefix, s in REVERSAL_STATE_FROM_TITLE if sec["title"].startswith(prefix)), "OTHER")
                counts[state] = counts.get(state, 0) + len(sec["rows"])
                for cells in sec["rows"]:
                    raw_rec = dict(zip(sec["cols"], cells))
                    cfg = raw_rec.get("config")
                    if not cfg:
                        continue
                    rec = {"state": state}
                    for k in REVERSAL_ROW_COLS:
                        v = raw_rec.get(k)
                        if v is None or v == "" or v.lower() == "nan":
                            continue
                        rec[k] = v if k in REVERSAL_STRING_COLS else num(v)
                    configs.setdefault(cfg, []).append(rec)
            for rows in configs.values():
                rows.sort(key=lambda r: (REVERSAL_STATE_ORDER.get(r.get("state"), 9),
                                          r.get("bars_ago") if r.get("bars_ago") is not None else 999))
            item["configs"] = configs
            item["counts"] = counts
        elif t.exists():
            item["text"] = text
        out[mk] = item
    return out


REV_COLS = ["group", "rank", "symbol", "name", "close", "dd_pct", "rsi", "revenue_trend", "rev_cagr_pct", "yoy_pct", "stop_price", "stop_pct", "size_pct_equity"]


def read_revenue(D: Dirs) -> dict:
    out = {}
    if not D.scans or not D.scans.exists():
        return out
    for mk in ("US", "India"):
        j = read_json(D.scans / f"LATEST_REVENUE_{mk}.json")
        if not j:
            continue
        rows = [r for r in j.get("rows", []) if r.get("group") in ("SIGNAL", "WATCH")]
        rows.sort(key=lambda r: (0 if r.get("group") == "SIGNAL" else 1, r.get("rank") or 9999))
        recs = []
        for r in rows[:60]:
            rec = {}
            for k in REV_COLS:
                if k in r:
                    rec["status" if k == "group" else k] = num(r[k])
            recs.append(rec)
        out[mk] = {"records": recs, "regime_on": j.get("regime_on"), "regime_gap_pct": num(j.get("regime_gap_pct")),
                   "asof": j.get("data_through") or j.get("asof") or j.get("date"), "run_at": j.get("run_at")}
    return out


# ------------------------------------------------------------------ signals: Market context classifier
# Row-level detail is only worth shipping for the actionable tags (see
# MARKET_CONTEXT_FRAMEWORK.md section 4) -- the sideways/unclassified buckets
# dominate by count (typically 70-80% of the universe) and are "wait and
# see", so they're surfaced as counts only, not 400+ rows of nothing to do.
CONTEXT_ACTIONABLE_TAGS = ["NEW_ATH_BREAKOUT", "DOWNTREND_BREAK", "UPTREND_PULLBACK_DEEP", "UPTREND_PULLBACK_SMALL"]
CONTEXT_ROW_COLS = ["symbol", "close", "context", "retracement_pct", "trendline_value", "prior_ath_bars_ago",
                    "pressing_upper_band", "range_high", "range_low"]


def read_context(D: Dirs) -> dict:
    out = {}
    if not D.scans or not D.scans.exists():
        return out
    for mk in ("US", "India"):
        j = read_json(D.scans / f"LATEST_CONTEXT_{mk}.json")
        if not j:
            continue
        recs = []
        for r in j.get("rows", []):
            if r.get("context") not in CONTEXT_ACTIONABLE_TAGS:
                continue
            rec = {}
            for k in CONTEXT_ROW_COLS:
                if k in r and r[k] is not None:
                    rec[k] = num(r[k]) if not isinstance(r[k], bool) else r[k]
            recs.append(rec)
        recs.sort(key=lambda r: (CONTEXT_ACTIONABLE_TAGS.index(r["context"]), -(r.get("retracement_pct") or 0)))
        out[mk] = {"records": recs, "tag_counts": j.get("tag_counts") or {}, "universe": j.get("universe"),
                   "asof": j.get("data_through"), "run_at": j.get("run_at")}
    return out


# ------------------------------------------------------------------ signals: Analog setup scanner (stage 1 + stages 2-4)
ANALOG_ROW_COLS = ["symbol", "context", "breakout_date", "entry_level", "stop_level", "breakeven_level", "take_profit_level",
                   "risk_pct", "target_r_used", "n_analogs", "n_analogs_confirmed", "n_analogs_failed"]


def read_analog(D: Dirs) -> dict:
    out = {}
    if not D.scans or not D.scans.exists():
        return out
    for mk in ("US", "India"):
        j = read_json(D.scans / f"LATEST_ANALOG_{mk}.json")
        if not j:
            continue
        recs = []
        for r in j.get("rows", []):
            rec = {}
            for k in ANALOG_ROW_COLS:
                if k in r and r[k] is not None:
                    rec[k] = num(r[k]) if not isinstance(r[k], bool) else r[k]
            recs.append(rec)
        recs.sort(key=lambda r: -(r.get("n_analogs_confirmed") or 0))
        out[mk] = {"records": recs, "run_at": j.get("run_at")}
    return out


# ------------------------------------------------------------------ signals: Base + breakout scanner (stage 1 + stage 2)
BASEBREAKOUT_ROW_COLS = ["symbol", "context", "breakout_date", "weeks_ago", "zone_high", "zone_low",
                         "zone_width_pct", "n_prior_events", "close"]


def read_basebreakout(D: Dirs) -> dict:
    out = {}
    if not D.scans or not D.scans.exists():
        return out
    for mk in ("US", "India"):
        j = read_json(D.scans / f"LATEST_BASEBREAKOUT_{mk}.json")
        if not j:
            continue
        recs = []
        for r in j.get("rows", []):
            rec = {}
            for k in BASEBREAKOUT_ROW_COLS:
                if k in r and r[k] is not None:
                    rec[k] = num(r[k]) if not isinstance(r[k], bool) else r[k]
            recs.append(rec)
        recs.sort(key=lambda r: (r.get("weeks_ago") if r.get("weeks_ago") is not None else 999, -(r.get("n_prior_events") or 0)))
        out[mk] = {"records": recs, "asof": j.get("data_through"), "run_at": j.get("run_at")}
    return out


# ------------------------------------------------------------------ signals: Double-bottom pyramid scanner (RSI divergence + trendline + EMA20 + breakout + retest)
DBPYRAMID_ROW_COLS = ["symbol", "state", "entry1_date", "entry2_date", "entry3_date", "avg_entry",
                      "stop", "target", "close", "risk_pct", "days_since_entry1"]
DBPYRAMID_STATE_ORDER = {"full": 0, "confirmed": 1, "watch": 2}


def read_dbpyramid(D: Dirs) -> dict:
    out = {}
    if not D.scans or not D.scans.exists():
        return out
    for mk in ("US", "India"):
        j = read_json(D.scans / f"LATEST_DBPYRAMID_{mk}.json")
        if not j:
            continue
        recs = []
        for r in j.get("rows", []):
            rec = {}
            for k in DBPYRAMID_ROW_COLS:
                if k in r and r[k] is not None:
                    rec[k] = num(r[k]) if k not in ("symbol", "state", "entry1_date", "entry2_date", "entry3_date") else r[k]
            recs.append(rec)
        recs.sort(key=lambda r: (DBPYRAMID_STATE_ORDER.get(r.get("state"), 9),
                                  r.get("days_since_entry1") if r.get("days_since_entry1") is not None else 999))
        out[mk] = {"records": recs, "asof": j.get("data_through"), "run_at": j.get("run_at")}
    return out


# ------------------------------------------------------------------ signals: Fundamental Analysis scanner (automatable screening + financials + valuation slice)
FUNDAMENTAL_ROW_COLS = ["symbol", "sector", "quant_score", "tier", "quality_veto", "rev_cagr_3y_pct", "eps_cagr_3y_pct",
                        "roe_pct", "de_ratio", "fcf_conversion_pct", "pe", "sector_discount_pct", "analyst_upside_pct",
                        "red_flags", "shenanigans"]
FUNDAMENTAL_TIER_ORDER = {"Strong": 0, "Good": 1, "Starter": 2, "Watch": 3, "Reject": 4, "Reject (quality veto)": 5, "Not enough data": 6}


def read_fundamental(D: Dirs) -> dict:
    out = {}
    if not D.scans or not D.scans.exists():
        return out
    for mk in ("US", "India"):
        j = read_json(D.scans / f"LATEST_FUNDAMENTAL_{mk}.json")
        if not j:
            continue
        recs = []
        for r in j.get("rows", []):
            rec = {}
            for k in FUNDAMENTAL_ROW_COLS:
                if k in r and r[k] is not None:
                    rec[k] = r[k] if k in ("symbol", "sector", "tier") else (bool(r[k]) if k == "quality_veto" else num(r[k]))
            recs.append(rec)
        recs.sort(key=lambda r: (FUNDAMENTAL_TIER_ORDER.get(r.get("tier"), 9), -(r.get("quant_score") or -1)))
        out[mk] = {"records": recs, "universe": j.get("universe"), "asof": j.get("data_through"), "run_at": j.get("run_at")}
    return out


# ------------------------------------------------------------------ signals: Weinstein Stage-2 scanner (30-week MA bull market bottom)
WEINSTEIN_ROW_COLS = ["symbol", "state", "date", "close", "cross_close", "ma30w",
                      "stop_base_low", "risk_pct", "vol_x_avg", "r_so_far",
                      "pct_below_ma", "ma_flat_pct", "base_low", "weeks_ago"]
WEINSTEIN_STATE_ORDER = {"TRIGGER": 0, "MISSED": 1, "SETUP": 2}


def read_weinstein(D: Dirs) -> dict:
    out = {}
    if not D.scans or not D.scans.exists():
        return out
    for mk in ("US", "India"):
        j = read_json(D.scans / f"LATEST_WEINSTEIN_{mk}.json")
        if not j:
            continue
        recs = []
        for r in j.get("rows", []):
            rec = {}
            for k in WEINSTEIN_ROW_COLS:
                if k in r and r[k] is not None:
                    rec[k] = num(r[k]) if k not in ("symbol", "state", "date") else r[k]
            recs.append(rec)
        recs.sort(key=lambda r: (WEINSTEIN_STATE_ORDER.get(r.get("state"), 9),
                                  r.get("weeks_ago") if r.get("weeks_ago") is not None else 999))
        out[mk] = {"records": recs, "asof": j.get("data_through"), "run_at": j.get("run_at")}
    return out


# ------------------------------------------------------------------ signals: VCP Positional scanner
VCP_ROW_COLS = ["symbol", "state", "date", "close", "pivot", "stop", "risk_pct",
                 "target", "score", "n_legs", "final_depth_pct", "vol_x_avg",
                 "pct_to_pivot", "shares_1pct_risk", "action", "bars_ago"]
VCP_STATE_ORDER = {"TRIGGER": 0, "MISSED": 1, "SETUP": 2}
VCP_STRING_COLS = ("symbol", "state", "date", "action")


def read_vcp(D: Dirs) -> dict:
    out = {}
    if not D.scans or not D.scans.exists():
        return out
    for mk in ("US", "India"):
        j = read_json(D.scans / f"LATEST_VCP_{mk}.json")
        if not j:
            continue
        recs = []
        for r in j.get("rows", []):
            rec = {}
            for k in VCP_ROW_COLS:
                if k in r and r[k] is not None:
                    rec[k] = r[k] if k in VCP_STRING_COLS else num(r[k])
            recs.append(rec)
        recs.sort(key=lambda r: (VCP_STATE_ORDER.get(r.get("state"), 9),
                                  r.get("bars_ago") if r.get("bars_ago") is not None else 999))
        out[mk] = {"records": recs, "asof": j.get("data_through"), "run_at": j.get("run_at")}
    return out


# ------------------------------------------------------------------ signals: BB Ladder (trough + ascending ladder + breakout)
BBLADDER_ROW_COLS = ["symbol", "state", "date", "trough_date", "n_pivots", "resistance",
                     "entry", "stop", "target", "risk_pct", "last_close", "bars_ago"]
BBLADDER_STATE_ORDER = {"TRIGGER": 0, "MISSED": 1, "ARMED": 2}
BBLADDER_STRING_COLS = ("symbol", "state", "date", "trough_date")


def read_bbladder(D: Dirs) -> dict:
    out = {}
    if not D.scans or not D.scans.exists():
        return out
    for mk in ("US", "India"):
        j = read_json(D.scans / f"LATEST_BBLADDER_{mk}.json")
        if not j:
            continue
        recs = []
        for r in j.get("rows", []):
            rec = {}
            for k in BBLADDER_ROW_COLS:
                if k in r and r[k] is not None:
                    rec[k] = r[k] if k in BBLADDER_STRING_COLS else num(r[k])
            recs.append(rec)
        recs.sort(key=lambda r: (BBLADDER_STATE_ORDER.get(r.get("state"), 9),
                                  r.get("bars_ago") if r.get("bars_ago") is not None else 999))
        out[mk] = {"records": recs, "asof": j.get("data_through"), "run_at": j.get("run_at")}
    return out


# ------------------------------------------------------------------ signals: MTF Trend Strategy (Monthly->Weekly->Daily)
MTF_ROW_COLS = ["symbol", "close", "atr14", "stop_B", "target_B", "risk_B_pct", "stop_A", "target_A", "risk_A_pct"]


def read_mtf(D: Dirs) -> dict:
    out = {}
    if not D.scans or not D.scans.exists():
        return out
    for mk in ("US", "India"):
        j = read_json(D.scans / f"LATEST_MTF_{mk}.json")
        if not j:
            continue
        recs = []
        for r in j.get("rows", []):
            rec = {}
            for k in MTF_ROW_COLS:
                if k in r and r[k] is not None:
                    rec[k] = num(r[k])
            recs.append(rec)
        out[mk] = {"records": recs, "universe": j.get("universe"), "asof": j.get("data_through"), "run_at": j.get("run_at")}
    return out


# ------------------------------------------------------------------ signals: Master Support & Resistance Framework (Hourly/Daily/Weekly checklist scorer)
MSR_ROW_COLS = ["symbol", "direction", "grade", "total", "entry", "stop", "target", "rr", "risk_pct",
                "level", "level_touches", "bias", "adx", "sr_score", "value_score", "value_label",
                "confirm_score", "confirm_label", "risk_score", "confluence_score", "confluence_label"]


def read_msr(D: Dirs) -> dict:
    out = {}
    if not D.scans or not D.scans.exists():
        return out
    for mk in ("US", "India"):
        j = read_json(D.scans / f"LATEST_MSR_{mk}.json")
        if not j:
            continue
        strategies = {}
        for name, sv in (j.get("strategies") or {}).items():
            recs = []
            for r in sv.get("rows", []):
                rec = {}
                for k in MSR_ROW_COLS:
                    if k in r and r[k] is not None:
                        rec[k] = num(r[k]) if k not in ("symbol", "direction", "grade", "bias", "value_label",
                                                          "confirm_label", "confluence_label") else r[k]
                recs.append(rec)
            strategies[name] = {"records": recs, "min_score": sv.get("min_score")}
        out[mk] = {"strategies": strategies, "universe": j.get("universe"), "asof": j.get("data_through"),
                   "run_at": j.get("run_at")}
    return out


# ------------------------------------------------------------------ signals: EMA-VCP Positional Strategy (Weekly/Daily/Hourly/Combined)
EMA_VCP_ROW_COLS = ["symbol", "close", "stop", "risk_pct", "pivot", "weekly_score", "daily_score",
                     "volume_score", "hourly_score", "total_score", "grade", "breakout_confirmed", "elite_vdu"]


def read_ema_vcp(D: Dirs) -> dict:
    out = {}
    if not D.scans or not D.scans.exists():
        return out
    for mk in ("US", "India"):
        j = read_json(D.scans / f"LATEST_EMA_VCP_{mk}.json")
        if not j:
            continue
        strategies = {}
        for name, sv in (j.get("strategies") or {}).items():
            recs = []
            for r in sv.get("rows", []):
                rec = {}
                for k in EMA_VCP_ROW_COLS:
                    if k in r and r[k] is not None:
                        rec[k] = num(r[k]) if k not in ("symbol", "grade", "breakout_confirmed", "elite_vdu") else r[k]
                recs.append(rec)
            strategies[name] = {"records": recs}
        out[mk] = {"strategies": strategies, "universe": j.get("universe"), "asof": j.get("data_through"),
                   "run_at": j.get("run_at"), "breadth": j.get("breadth"), "market_ok": j.get("market_ok"),
                   "config": j.get("config")}
    return out


# ------------------------------------------------------------------ signals: Multi-Timeframe EMA Trading Playbook (S1/S2/S3/S5/S6 -- S4/S7 excluded, see spec)
PLAYBOOK_ROW_COLS = ["symbol", "grade", "total_score", "A_score", "B_score", "C_score", "D_score", "E_score",
                     "F_score", "close", "atr14", "stop", "risk_pct", "runner_trail", "position_size_shares_1pct_100k"]
PLAYBOOK_GRADE_ORDER = {"A": 0, "B": 1, "C": 2, "X": 3}


def read_playbook(D: Dirs) -> dict:
    out = {}
    if not D.scans or not D.scans.exists():
        return out
    for mk in ("US", "India"):
        j = read_json(D.scans / f"LATEST_PLAYBOOK_{mk}.json")
        if not j:
            continue
        strategies = {}
        for name, sv in (j.get("strategies") or {}).items():
            recs = []
            for r in sv.get("rows", []):
                rec = {}
                for k in PLAYBOOK_ROW_COLS:
                    if k in r and r[k] is not None:
                        rec[k] = r[k] if k in ("symbol", "grade", "runner_trail") else num(r[k])
                for k, v in r.items():
                    if (k.startswith("t1_") or k.startswith("t2_")) and v is not None:
                        rec[k] = num(v)
                recs.append(rec)
            recs.sort(key=lambda r: (PLAYBOOK_GRADE_ORDER.get(r.get("grade"), 9), -(r.get("total_score") or 0)))
            strategies[name] = {"records": recs}
        out[mk] = {"strategies": strategies, "universe": j.get("universe"), "asof": j.get("data_through"),
                   "run_at": j.get("run_at"), "live_strategies": j.get("live_strategies"),
                   "excluded_strategies": j.get("excluded_strategies")}
    return out


# ------------------------------------------------------------------ signals: Fundamental Analysis Master Framework (StockLens watchlist, not the 1,003-name universe)
MASTER_FRAMEWORK_ROW_COLS = ["symbol", "sector", "currency", "investmentScore", "grade", "action", "finalBuy",
                              "qualityScore", "opportunityScore", "technicalScore", "industryRank",
                              "redFlagCount", "redFlagsTriggered", "redFlagReject", "peg", "marginOfSafety",
                              "riskPct", "allocationPct", "dataGap"]
MASTER_FRAMEWORK_STR_FIELDS = ("symbol", "sector", "currency", "grade", "action", "industryRank",
                                "riskPct", "allocationPct", "dataGap")


def read_master_framework(D: Dirs) -> dict:
    out = {}
    if not D.scans or not D.scans.exists():
        return out
    for mk in ("US", "India"):
        j = read_json(D.scans / f"LATEST_MASTERFRAMEWORK_{mk}.json")
        if not j:
            continue
        recs = []
        for r in j.get("rows", []):
            rec = {}
            for k in MASTER_FRAMEWORK_ROW_COLS:
                if k not in r or r[k] is None:
                    continue
                rec[k] = r[k] if (k in MASTER_FRAMEWORK_STR_FIELDS or k == "redFlagsTriggered") else num(r[k])
            recs.append(rec)
        out[mk] = {"records": recs, "universe": j.get("universe"), "asof": j.get("data_through"),
                   "run_at": j.get("run_at"), "grade_counts": j.get("grade_counts")}
    return out


# ------------------------------------------------------------------ signals: Ultimate Hedge Fund Manager Alpha Framework (Multi-Market)
ALPHA_FRAMEWORK_ROW_COLS = ["symbol", "sector", "currency", "totalScore", "tier", "action",
                             "priceDislocationScore", "drawdownFromHigh", "valuationScore", "dcfUpside",
                             "qualityScore", "qualityGateFailed", "institutionalScore", "growthScore",
                             "growthBucket", "revenueCagr", "epsCagr", "catalystScore", "catalystSignals",
                             "hardFilterFailed", "riskPct", "allocationPct", "dataGap"]
ALPHA_FRAMEWORK_STR_FIELDS = ("symbol", "sector", "currency", "tier", "action", "growthBucket",
                               "riskPct", "allocationPct", "dataGap")


def read_alpha_framework(D: Dirs) -> dict:
    out = {}
    if not D.scans or not D.scans.exists():
        return out
    for mk in ("US", "India"):
        j = read_json(D.scans / f"LATEST_ALPHAFRAMEWORK_{mk}.json")
        if not j:
            continue
        recs = []
        for r in j.get("rows", []):
            rec = {}
            for k in ALPHA_FRAMEWORK_ROW_COLS:
                if k not in r or r[k] is None:
                    continue
                rec[k] = r[k] if (k in ALPHA_FRAMEWORK_STR_FIELDS or k in ("catalystSignals", "hardFilterFailed", "qualityGateFailed")) else num(r[k])
            recs.append(rec)
        out[mk] = {"records": recs, "universe": j.get("universe"), "asof": j.get("data_through"),
                   "run_at": j.get("run_at"), "tier_counts": j.get("tier_counts")}
    return out


# ------------------------------------------------------------------ signals: Akshat Shrivastava Fundamental + VCP Hybrid Framework
AKSHAT_ROW_COLS = ["symbol", "sector", "industry", "price", "industry_score", "business_score",
                    "valuation_score", "supply_demand_score", "vcp_score", "total_score", "grade",
                    "fundamental_gate", "checklist_all_met", "entry_signal", "stop_loss",
                    "partial_exit_1", "partial_exit_2"]
AKSHAT_STR_OR_BOOL_FIELDS = ("symbol", "sector", "industry", "grade", "fundamental_gate",
                              "checklist_all_met", "entry_signal")


def read_akshat(D: Dirs) -> dict:
    out = {}
    if not D.scans or not D.scans.exists():
        return out
    for mk in ("US", "India"):
        j = read_json(D.scans / f"LATEST_AKSHAT_{mk}.json")
        if not j:
            continue
        recs = []
        for r in j.get("rows", []):
            rec = {}
            for k in AKSHAT_ROW_COLS:
                if k not in r or r[k] is None:
                    continue
                rec[k] = r[k] if k in AKSHAT_STR_OR_BOOL_FIELDS else num(r[k])
            recs.append(rec)
        out[mk] = {"records": recs, "universe": j.get("universe"), "asof": j.get("data_through"),
                   "run_at": j.get("run_at"), "market_bullish": j.get("market_bullish")}
    return out


# ------------------------------------------------------------------ signals: Master Stock Analysis & Trade Execution Framework (CA Rachana Ranade style)
TEF_ROW_COLS = ["symbol", "sector", "totalScore", "pctScore", "action", "gradeTag", "goldenRuleBuy",
                "fundamentalsPct", "technicalsPct", "riskPct", "allocationPct",
                "stage1", "stage2", "stage3", "stage4", "stage5", "stage6", "stage7"]
TEF_STR_OR_BOOL_FIELDS = ("symbol", "sector", "action", "gradeTag", "goldenRuleBuy")


def read_tef(D: Dirs) -> dict:
    out = {}
    if not D.scans or not D.scans.exists():
        return out
    for mk in ("US", "India"):
        j = read_json(D.scans / f"LATEST_TEF_{mk}.json")
        if not j:
            continue
        recs = []
        for r in j.get("rows", []):
            rec = {}
            for k in TEF_ROW_COLS:
                if k not in r or r[k] is None:
                    continue
                rec[k] = r[k] if k in TEF_STR_OR_BOOL_FIELDS else num(r[k])
            recs.append(rec)
        out[mk] = {"records": recs, "universe": j.get("universe"), "asof": j.get("data_through"),
                   "run_at": j.get("run_at"), "action_counts": j.get("action_counts")}
    return out


# ------------------------------------------------------------------ signals: CA Rachana Ranade Combined Framework -- "Trade Probability Scoring Model"
# Distinct from "tef" above: tef is a different pasted checklist (Business
# Quality + Fundamentals/Valuation/Turnaround + VCP timing) that also cites
# Rachana Ranade's style; this one is the pure price-action scanner (trend,
# chart pattern, RSI, volume, Fibonacci pivots, candlestick, VCP, risk/reward
# -- 175-point Decision Matrix), backtested over the full 1,003-symbol/26-yr
# cache. See RachanaRanade_Strategy/RACHANA_RANADE_BACKTEST_RESULTS.md.
RACHANA_ROW_COLS = ["symbol", "close", "entry", "stop", "target", "total_score", "grade", "best_pattern",
                     "trend_score", "pattern_score", "rsi_score", "rsi", "volume_score", "pivot_score",
                     "candlestick_score", "vcp_score", "rr_score", "rr", "size_caveat"]
RACHANA_STR_OR_BOOL_FIELDS = ("symbol", "grade", "best_pattern", "size_caveat")


def read_rachana(D: Dirs) -> dict:
    out = {}
    if not D.scans or not D.scans.exists():
        return out
    for mk in ("US", "India"):
        j = read_json(D.scans / f"LATEST_RACHANA_{mk}.json")
        if not j:
            continue
        recs = []
        for r in j.get("actionable", []):
            rec = {}
            for k in RACHANA_ROW_COLS:
                if k not in r or r[k] is None:
                    continue
                rec[k] = r[k] if k in RACHANA_STR_OR_BOOL_FIELDS else num(r[k])
            recs.append(rec)
        watch = []
        for r in j.get("watchlist", []):
            rec = {}
            for k in RACHANA_ROW_COLS:
                if k not in r or r[k] is None:
                    continue
                rec[k] = r[k] if k in RACHANA_STR_OR_BOOL_FIELDS else num(r[k])
            watch.append(rec)
        out[mk] = {"records": recs, "watchlist": watch, "universe": j.get("universe"),
                   "asof": j.get("data_through"), "run_at": j.get("run_at"), "counts": j.get("counts")}
    return out


# ------------------------------------------------------------------ signals: Break & Retest Master Framework (C.E.S.T, Hourly/Daily/Weekly)
BREAKRETEST_ROW_COLS = ["symbol", "direction", "pattern", "date", "close", "entry_level1_aggressive",
                         "entry_level2_conservative", "stop", "target", "risk_pct", "rr_multiple",
                         "total_score", "grade", "section_A_trend", "section_B_breakout", "section_C_retest",
                         "section_D_mtf", "section_E_rr"]


def read_breakretest(D: Dirs) -> dict:
    out = {}
    if not D.scans or not D.scans.exists():
        return out
    for mk in ("US", "India"):
        j = read_json(D.scans / f"LATEST_BREAKRETEST_{mk}.json")
        if not j:
            continue
        strategies = {}
        for name, sv in (j.get("strategies") or {}).items():
            recs = []
            for r in sv.get("rows", []):
                rec = {}
                for k in BREAKRETEST_ROW_COLS:
                    if k in r and r[k] is not None:
                        rec[k] = num(r[k]) if k not in ("symbol", "direction", "pattern", "date", "grade") else r[k]
                recs.append(rec)
            strategies[name] = {"records": recs, "min_score": sv.get("min_score")}
        out[mk] = {"strategies": strategies, "universe": j.get("universe"), "asof": j.get("data_through"),
                   "run_at": j.get("run_at")}
    return out


# ------------------------------------------------------------------ signals: Logic 3 DBE (double bottom + engulfing) live feed
DBE_ROW_COLS = ["symbol", "state", "bars_ago", "date", "b1_date", "b2_date", "gap",
                "trigger", "entry", "stop", "target", "risk_pct", "vol_ok", "last_close"]
DBE_STATE_ORDER = {"TRIGGER": 0, "ARMED": 1, "MISSED": 2}


def read_dbe(D: Dirs) -> dict:
    out = {}
    if not D.scans or not D.scans.exists():
        return out
    for mk in ("US", "India"):
        j = read_json(D.scans / f"LATEST_DBE_{mk}.json")
        if not j:
            continue
        recs = []
        for r in j.get("rows", []):
            rec = {}
            for k in DBE_ROW_COLS:
                if k in r and r[k] is not None:
                    rec[k] = num(r[k]) if k not in ("symbol", "state", "date", "b1_date", "b2_date", "vol_ok") else r[k]
            recs.append(rec)
        recs.sort(key=lambda r: (DBE_STATE_ORDER.get(r.get("state"), 9),
                                  r.get("bars_ago") if r.get("bars_ago") is not None else 999))
        out[mk] = {"records": recs, "asof": j.get("data_through"), "run_at": j.get("run_at")}
    return out


# ------------------------------------------------------------------ signals: Pullback-Retest MTF Swing Strategy (Weekly/Daily/Hourly scorecards + alignment)
PBMTF_ROW_COLS = ["symbol", "direction", "weekly_score", "weekly_decision", "daily_score", "daily_decision",
                  "hourly_score", "hourly_decision", "alignment_score", "three_way_aligned", "take_trade",
                  "position_size_R", "close", "atr_hourly", "stop", "risk_pct", "target_1_5R", "target_2R",
                  "target_prior_swing", "rr_to_prior_swing", "position_size_shares", "daily_date", "hourly_bar"]


def read_pbmtf(D: Dirs) -> dict:
    out = {}
    if not D.scans or not D.scans.exists():
        return out
    for mk in ("US", "India"):
        j = read_json(D.scans / f"LATEST_PBMTF_{mk}.json")
        if not j:
            continue

        def recs_of(rows):
            out_rows = []
            for r in rows:
                rec = {}
                for k in PBMTF_ROW_COLS:
                    if k in r and r[k] is not None:
                        rec[k] = num(r[k]) if k not in ("symbol", "direction", "weekly_decision", "daily_decision",
                                                          "hourly_decision", "three_way_aligned", "take_trade",
                                                          "daily_date", "hourly_bar") else r[k]
                out_rows.append(rec)
            out_rows.sort(key=lambda r: -(r.get("alignment_score") or 0))
            return out_rows

        out[mk] = {
            "signals": recs_of(j.get("signals", [])), "watchlist": recs_of(j.get("watchlist", [])),
            "universe": j.get("universe"), "hourly_covered": j.get("hourly_covered"),
            "asof": j.get("data_through"), "run_at": j.get("run_at"),
        }
    return out


# ------------------------------------------------------------------ signals: Inverse head & shoulders (live setups only)
INVERSEHS_ROW_COLS = ["symbol", "timeframe", "status", "config", "entry", "stop", "target",
                      "watch_level", "risk_pct", "unrealized_r", "close", "asof"]


def read_inversehs(D: Dirs) -> dict:
    out = {}
    if not D.scans or not D.scans.exists():
        return out
    for mk in ("US", "India"):
        j = read_json(D.scans / f"LATEST_INVERSEHS_{mk}.json")
        if not j:
            continue
        recs = []
        for r in j.get("rows", []):
            rec = {}
            for k in INVERSEHS_ROW_COLS:
                if k in r and r[k] is not None:
                    rec[k] = num(r[k]) if not isinstance(r[k], bool) else r[k]
            recs.append(rec)
        status_order = {"ACTIVE": 0, "AWAITING_ENTRY": 1, "AWAITING_RECLAIM": 2, "AWAITING_RETEST": 3, "WATCHING": 4}
        recs.sort(key=lambda r: (status_order.get(r.get("status"), 9), r.get("symbol") or ""))
        out[mk] = {"records": recs, "run_at": j.get("run_at")}
    return out


# ------------------------------------------------------------------ results
def downsample(xs, ys, n=520):
    if len(xs) <= n:
        return xs, ys
    step = len(xs) / n
    idx = sorted({int(i * step) for i in range(n)} | {len(xs) - 1})
    return [xs[i] for i in idx], [ys[i] for i in idx]


def equity_series(path: Path, sheet: str, title: str, note_: str):
    if not path.exists():
        return None
    try:
        d = read_xlsx(path, [sheet]).get(sheet)
    except Exception as e:
        note(f"could not read {path.name}: {e}")
        return None
    if not d:
        return None
    pts = [(r[0], r[1]) for r in d[1] if r and r[0] and isinstance(r[1], (int, float))]
    if len(pts) < 5:
        return None
    xs, ys = downsample([p[0] for p in pts], [round(p[1]) for p in pts])
    return {"title": title, "note": note_, "x": xs, "y": ys, "log": True}


def table_from(path: Path, sheet: str | None, title: str, note_: str, keep: list[str] | None = None, limit=60):
    if not path.exists():
        return None
    try:
        if path.suffix.lower() == ".csv":
            cols, rows = read_csv_rows(path)
        else:
            d = read_xlsx(path, [sheet]).get(sheet)
            if not d:
                return None
            cols, rows = d
    except Exception as e:
        note(f"could not read {path.name}: {e}")
        return None
    if keep:
        idx = [cols.index(c) for c in keep if c in cols]
        cols = [cols[i] for i in idx]
        rows = [[r[i] if i < len(r) else None for i in idx] for r in rows]
    if not rows:
        return None
    return {"title": title, "note": note_, "columns": cols, "rows": rows[:limit]}


LOGIC3_SKIP0820 = Path(r"G:\trading\new back test\LOGIC3_SKIP0820_RESULTS.xlsx")


def read_results(D: Dirs) -> dict:
    R = {"equity": [], "yearly": [], "tables": []}
    rd = D.reversal
    t_l3 = table_from(LOGIC3_SKIP0820, "summary", "Logic 3 (double bottom + engulfing): spec vs tuned builds, 2008/2020 excluded",
                      "VALIDATED is the recommended build -- the only one chosen by a TRAIN-only protocol rather than by looking at the whole sample. See the Logic 3 strategy entry and its 2008/2020 write-up for the full comparison.",
                      ["variant", "trades", "per_yr", "win_pct", "avg_r", "t_stat", "PF", "max_dd_r", "cagr_at_20dd", "sharpe", "TRAIN_avgR", "TEST_avgR", "cells_of_4"])
    if t_l3:
        R["tables"].append(t_l3)
    if D.paper and D.paper.exists():
        for sheet, title, nt in (("scorecard", "Live paper-trade scorecard", "Forward test of the scanner signals. Fewer than 30 closed trades is too few to judge."),
                                 ("open_positions", "Paper trades open now", "Replayed from each trade's entry bar."),
                                 ("awaiting_entry", "Signals waiting for tomorrow's open", "")):
            try:
                t = table_from(D.paper, sheet, title, nt, limit=40)
            except Exception as e:
                note(f"PAPER_TRADING.xlsx: {e}")
                t = None
            if t and t["columns"] != ["status"] and t["columns"] != ["result"]:
                R["tables"].append(t)
    elif D.paper:
        note("PAPER_TRADING.xlsx not found: the live scorecard will appear once PUBLISH.bat runs on the PC that has it")
    if rd and rd.exists():
        wf = rd / "S123_WALKFORWARD.xlsx"
        fr = rd / "S123_FINAL_REPORT.xlsx"
        e1 = equity_series(wf, "FROZEN Equity", "Blend equity, frozen settings, 2010 to now",
                           "S1 and S3 together, 12 positions at most, 1% risk per trade, $100,000 start, log scale. Settings were frozen at 2010, so every year is out-of-sample.")
        if e1:
            R["equity"].append(e1)
        e2 = equity_series(fr, "Recommended Equity", "Blend equity, 2000 to now (settings chosen on the same years)",
                           "In-sample, so it reads better than anything you should plan around. Compare with the frozen curve above.")
        if e2:
            R["equity"].append(e2)
        try:
            by = sheet_dicts(wf, "FROZEN ByYear") if wf.exists() else []
        except Exception:
            by = []
        by = [r for r in by if isinstance(r.get("year"), int)]
        if by:
            R["yearly"].append({"title": "Yearly return of the frozen blend", "note": "Percent change in the account each calendar year; the current year is partial.",
                                "years": [r["year"] for r in by], "values": [r.get("year_ret_pct") or 0 for r in by], "label": "Return", "unit": "%"})
            R["yearly"].append({"title": "R earned each year", "note": "Sum of every trade's result in R for that year.",
                                "years": [r["year"] for r in by], "values": [r.get("total_R") or 0 for r in by], "label": "Total R", "unit": "R"})
        for t in (
            table_from(fr, "Summary", "S1, S2 and S3 builds compared", "Spec = the checklist as first written. Tuned and freq = settings chosen on 2000-2015 only. Train and test average R show how much survived on the untouched later years.",
                       ["build", "trades", "per_yr", "win_pct", "avg_r", "t_stat", "PF", "mdd_at_1pct", "cagr_at_20dd", "TRAIN_avgR", "TEST_avgR", "cells_of_4"]),
            table_from(wf, "RefitComparison", "Does re-tuning every year help?", "Growth at a 20% drawdown budget for each way of choosing settings. Not re-tuning did as well or better."),
            table_from(rd / "logic2_output" / "waterfall_comparison.csv", None, "Logic 2: from the original code to the tuned version", "Each row adds one fix or rule to the row above it.",
                       ["step", "trades", "win_rate_pct", "avg_r", "delta_avg_r", "t_stat", "profit_factor", "cells_positive_of_4"]),
            table_from(rd / "watchlist_output" / "market_summary.csv", None, "Retired 700-stock watchlist backtest", "The older Reversal-After-Impulse bot on independent $10,000 books per stock. A quality screen, not a shared-capital portfolio.",
                       ["market", "num_symbols", "num_trades", "win_rate_pct", "profit_factor", "avg_r_multiple", "cagr_pct", "max_drawdown_pct"]),
        ):
            if t:
                R["tables"].append(t)
    return {k: v for k, v in R.items() if v}


# ------------------------------------------------------------------ automation
def read_automation(cur: dict, D: Dirs) -> dict:
    A = dict(cur.get("automation", {}))
    notes = A.pop("bat_notes", {})
    files = []
    for folder in (D.reversal, D.accumulation, D.ema, D.playbook):
        if not folder or not folder.exists():
            continue
        for p in sorted(folder.glob("*.bat")):
            does = notes.get(p.name)
            if not does:
                try:
                    first = [ln for ln in read_text(p).splitlines() if ln.strip().lower().startswith("rem ")][:1]
                    does = first[0][4:].strip() if first else "Starts one of the scripts in this folder."
                except Exception:
                    does = "Starts one of the scripts in this folder."
            files.append({"file": p.name, "folder": folder.name, "does": does})
    if not files:
        files = [{"file": k, "folder": "", "does": v} for k, v in notes.items()]
    first = ("SCAN_NOW.bat", "SCAN NOW - Accumulation bot.bat", "SETUP_SYSTEM_TASKS.bat")
    files.sort(key=lambda f: (first.index(f["file"]) if f["file"] in first else 99, f["folder"], f["file"]))
    A["files"] = files
    return A


# ------------------------------------------------------------------ end-of-day stock prices
# Daily prices for the chart's "Stocks (end of day)" feed, read from the price files your scanners
# already keep (default: prices_*.pkl in the Accumulation bot's data folder). Written to
# data/technical/prices.json, encrypted like the bundle, so nothing about your universe is public.
PRICE_BARS = 400            # about 19 months of trading days per symbol
PRICE_TOP = 500             # "US top 500" / "India top 500": highest average traded value
PRICE_FILES = ["{accumulation_dir}/data/prices_*.pkl"]
_FIELDS = {"open": "o", "high": "h", "low": "l", "close": "c", "price": "c", "last": "c", "ltp": "c", "volume": "v", "vol": "v"}
_SYM_COLS = ("symbol", "ticker", "tradingsymbol", "scrip", "code")
_DATE_COLS = ("date", "datetime", "timestamp", "time", "day")


def _field(name) -> str | None:
    return _FIELDS.get(str(name).strip().lower().replace("_", " "))


def _ohlcv(df, pd):
    """One symbol's frame -> DataFrame[o,h,l,c,v] on a sorted, naive daily DatetimeIndex, or None."""
    if not isinstance(df, pd.DataFrame) or df.empty:
        return None
    cols = {str(c).strip().lower(): c for c in df.columns}
    datec = next((cols[k] for k in _DATE_COLS if k in cols), None)
    if datec is not None:
        df = df.set_index(datec)
    pick = {}
    for c in df.columns:
        f = _field(c)
        if f and f not in pick:
            pick[f] = c
    if "c" not in pick:
        return None
    out = pd.DataFrame({f: pd.to_numeric(df[c], errors="coerce") for f, c in pick.items()})
    idx = pd.to_datetime(out.index, errors="coerce")
    if getattr(idx, "tz", None) is not None:
        idx = idx.tz_localize(None)
    out.index = idx.normalize()
    out = out[out.index.notna() & out["c"].notna() & (out["c"] > 0)]
    if out.empty:
        return None
    for f in ("o", "h", "l"):
        out[f] = out[f].fillna(out["c"]) if f in out else out["c"]
    out["v"] = out["v"].fillna(0).clip(lower=0) if "v" in out else 0.0
    out["h"] = out[["o", "h", "l", "c"]].max(axis=1)
    out["l"] = out[["o", "h", "l", "c"]].min(axis=1)
    out = out[~out.index.duplicated(keep="last")].sort_index()
    return out[["o", "h", "l", "c", "v"]]


def price_frames(obj, pd, depth: int = 0) -> dict:
    """Any common layout -> {ticker: frame}. Handles a dict of per-ticker frames, a yfinance-style
    wide table (MultiIndex columns in either order), a long table with a symbol column, a wide
    close-only table (one column per ticker), a dict of per-field tables ({"Open": table,
    "Close": table, ...}, each with one column per ticker), and a dict wrapping any of those."""
    if isinstance(obj, dict):
        fields = {}
        for k, v in obj.items():
            f = _field(k)
            if f and f not in fields and isinstance(v, (pd.DataFrame, pd.Series)):
                fields[f] = v.to_frame() if isinstance(v, pd.Series) else v
        if "c" in fields and len(fields["c"].columns) >= 1:
            names = {"o": "open", "h": "high", "l": "low", "c": "close", "v": "volume"}
            out = {}
            for t in fields["c"].columns:
                df = pd.DataFrame({names[f]: tab[t] for f, tab in fields.items() if t in tab.columns})
                f = _ohlcv(df, pd)
                if f is not None:
                    out[str(t)] = f
            if out:
                return out
        out = {}
        for k, v in obj.items():
            if isinstance(v, pd.DataFrame):
                if any(str(c).strip().lower() in _SYM_COLS for c in v.columns):
                    out.update(price_frames(v, pd, depth + 1))   # a long table (symbol column) on this sheet
                    continue
                f = _ohlcv(v, pd)
                if f is not None:
                    out[str(k)] = f
        if out:
            return out
        if depth < 2:
            best = {}
            for v in obj.values():
                r = price_frames(v, pd, depth + 1)
                if len(r) > len(best):
                    best = r
            return best
        return {}
    if not isinstance(obj, pd.DataFrame) or obj.empty:
        return {}
    df = obj
    if isinstance(df.columns, pd.MultiIndex) and df.columns.nlevels == 2:
        for lvl in (0, 1):
            names = set(df.columns.get_level_values(lvl))
            if "c" in {_field(x) for x in names}:
                other = 1 - lvl
                out = {}
                for t in dict.fromkeys(df.columns.get_level_values(other)):
                    f = _ohlcv(df.xs(t, axis=1, level=other), pd)
                    if f is not None:
                        out[str(t)] = f
                return out
        return {}
    if isinstance(df.index, pd.MultiIndex) and depth < 2:
        return price_frames(df.reset_index(), pd, depth + 1)
    cols = {str(c).strip().lower(): c for c in df.columns}
    symc = next((cols[k] for k in _SYM_COLS if k in cols), None)
    if symc is not None:
        out = {}
        for t, g in df.groupby(symc, sort=False):
            f = _ohlcv(g.drop(columns=[symc]), pd)
            if f is not None:
                out[str(t)] = f
        return out
    if _ohlcv(df, pd) is not None:   # a single symbol's table: no ticker to file it under
        return {}
    idx = pd.to_datetime(df.index, errors="coerce")
    if len(df.columns) >= 2 and idx.notna().mean() > 0.9:
        out = {}
        for t in df.columns:
            f = _ohlcv(pd.DataFrame({"close": df[t]}, index=df.index), pd)
            if f is not None:
                out[str(t)] = f
        return out
    return {}


def price_market(name: str, tickers) -> str:
    n = re.sub(r"[^A-Z]+", " ", name.upper()).split()
    if {"IN", "INDIA", "NSE", "BSE", "IND"} & set(n):
        return "IN"
    if {"US", "USA", "NYSE", "NASDAQ"} & set(n):
        return "US"
    tickers = list(tickers)
    ns = sum(1 for t in tickers if str(t).upper().endswith((".NS", ".BO")))
    return "IN" if tickers and ns * 2 > len(tickers) else "US"


def price_symbol(t, market: str) -> str:
    s = re.sub(r"^(NSE|BSE|NASDAQ|NYSE|AMEX)[:_]", "", str(t).strip().upper())
    if market == "IN":
        return re.sub(r"\.(NS|BO)$", "", s) + ".NS"
    return s


def signal_symbols(signals: dict) -> dict:
    """Every symbol/ticker in the scanner signals, per market (India tagged .NS), so the watchlists
    built from the signals have prices too."""
    out: dict = {}

    def walk(x, mk):
        if isinstance(x, dict):
            for k in ("symbol", "ticker"):
                v = x.get(k)
                if isinstance(v, str) and v.strip() and len(v) <= 24:
                    out.setdefault(mk, set()).add(price_symbol(v, mk))
            for v in x.values():
                walk(v, mk)
        elif isinstance(x, list):
            for v in x:
                walk(v, mk)

    for per in (signals or {}).values():
        if isinstance(per, dict):
            for mk, v in per.items():
                if mk in ("US", "IN"):
                    walk(v, mk)
    return out


def encode_prices(sym: str, f, bars: int = PRICE_BARS) -> dict:
    """Compact integer encoding (gzip shrinks it well): days and closes as deltas, open/high/low
    as offsets from the close, all in price ticks of 10^-dp."""
    f = f.iloc[-bars:]
    med = float(f["c"].median())
    dp = 2 if med >= 1 else 4
    m = 10 ** dp
    day = [int(t.value // 86_400_000_000_000) for t in f.index]
    o, h, l, c = ([int(round(float(x) * m)) for x in f[k]] for k in ("o", "h", "l", "c"))
    v = [int(round(float(x))) for x in f["v"]]
    return {"s": sym, "dp": dp, "d0": day[0], "dd": [b - a for a, b in zip(day, day[1:])],
            "c": [c[0]] + [b - a for a, b in zip(c, c[1:])],
            "o": [a - b for a, b in zip(o, c)], "h": [a - max(x, y) for a, x, y in zip(h, o, c)],
            "l": [min(x, y) - a for a, x, y in zip(l, o, c)], "v": v}


def decode_prices(e: dict) -> list[tuple]:
    """Inverse of encode_prices (the browser does the same in assets/js/chart/data/stocks.js)."""
    m = 10 ** e["dp"]
    day, c, rows = e["d0"], 0, []
    for i in range(len(e["c"])):
        if i:
            day += e["dd"][i - 1]
        c += e["c"][i]
        o = c + e["o"][i]
        rows.append((day * 86400, o / m, (max(o, c) + e["h"][i]) / m, (min(o, c) - e["l"][i]) / m, c / m, e["v"][i]))
    return rows


def _load_price_file(p: Path, pd):
    if p.suffix.lower() in (".pkl", ".pickle"):
        return pd.read_pickle(p)   # your own scanner's file, on your own PC
    if p.suffix.lower() == ".csv":
        return pd.read_csv(p)
    if p.suffix.lower() == ".parquet":
        return pd.read_parquet(p)
    if p.suffix.lower() in (".xlsx", ".xlsm"):
        return pd.read_excel(p, sheet_name=None)   # {sheet name: table}
    return None


def _describe(obj) -> str:
    kind = type(obj).__name__ + (f" of {len(obj)}" if isinstance(obj, dict) else f" {getattr(obj, 'shape', '')}")
    if isinstance(obj, dict) and len(obj) <= 12:
        kind += ": " + ", ".join(str(k) for k in obj)
    return kind


def _frames_from_file(p: Path, pd, label: str) -> dict:
    """{ticker: frame} from one price file, with a line saying what was found."""
    try:
        obj = _load_price_file(p, pd)
    except Exception as e:  # noqa: BLE001
        print(f"  {label:<17} could not open {p.name}: {type(e).__name__}: {e}")
        return {}
    if obj is None:
        return {}
    frames = price_frames(obj, pd)
    if not frames and isinstance(obj, dict) and p.suffix.lower() in (".xlsx", ".xlsm"):
        # workbooks with two header rows (field over ticker, or ticker over field)
        try:
            frames = price_frames(pd.read_excel(p, sheet_name=None, header=[0, 1], index_col=0), pd)
        except Exception:  # noqa: BLE001
            frames = {}
    if not frames:
        cols = list(obj)[:5] if isinstance(obj, dict) else list(getattr(obj, "columns", []))[:8]
        if isinstance(obj, dict) and obj:
            first = next(iter(obj.values()))
            cols = f"{cols}; first table columns {list(getattr(first, 'columns', []))[:8]}"
        print(f"  {label:<17} {p.name}: layout not recognised ({_describe(obj)}; {cols}). Please send this line to get it supported.")
        return {}
    span = (min(f.index[0] for f in frames.values()).date(), max(f.index[-1] for f in frames.values()).date())
    print(f"  {label:<17} {p.name}: {len(frames)} symbols, {span[0]} to {span[1]} ({_describe(obj)[:90]})")
    return frames


def read_price_history(cfg: dict, pd) -> dict:
    """{market: {symbol: frame}} from the long-history workbooks in config "price_history_files"
    ({"US": path, "IN": path}). Reading a big workbook takes minutes, so the result is cached in
    .cache/prices (git-ignored, never published) until the workbook changes."""
    out: dict = {}
    cache = ROOT / ".cache" / "prices"
    for mk, path in (cfg.get("price_history_files") or {}).items():
        p = Path(os.path.expanduser(str(path)))
        if not p.is_file():
            print(f"  Price history     NOT FOUND ({mk}: {p.name})")
            continue
        st = p.stat()
        key = cache / f"{mk}-{hashlib.sha256(str(p).encode()).hexdigest()[:10]}-{int(st.st_mtime)}-{st.st_size}.pkl"
        frames = None
        if key.is_file():
            try:
                frames = pd.read_pickle(key)
                print(f"  Price history     {p.name}: {len(frames)} symbols (cached copy, workbook unchanged)")
            except Exception:  # noqa: BLE001
                frames = None
        if frames is None:
            print(f"  Price history     reading {p.name} - a large workbook can take several minutes the first time...")
            frames = _frames_from_file(p, pd, "Price history")
            if frames:
                cache.mkdir(parents=True, exist_ok=True)
                for old in cache.glob(f"{mk}-{key.name.split('-')[1]}-*.pkl"):
                    old.unlink()
                pd.to_pickle(frames, key)
        dst = out.setdefault(mk, {})
        for t, f in (frames or {}).items():
            dst[price_symbol(t, mk)] = f
    return out


def read_prices(D: Dirs, signals: dict, cfg: dict) -> dict | None:
    """Recent prices from the scanners' price files, joined onto the long history workbooks.
    Returns {"built_at", "markets": {mk: {"top": [...], "frames": {symbol: frame}, "asof"}}}."""
    globs = cfg.get("price_files") or PRICE_FILES
    files = []
    for g in globs:
        p = Path(D.fill(g))
        if p.parent.exists():
            files += sorted(x for x in p.parent.glob(p.name) if x.is_file())
    if not files and not cfg.get("price_history_files"):
        print("  Stock prices      NOT FOUND (looked for " + ", ".join(Path(g).name for g in globs) + ")")
        return None
    try:
        import pandas as pd
    except ImportError:
        print("  Stock prices      SKIPPED: your price files need pandas. Install it once with:  python -m pip install pandas")
        note("End-of-day stock prices were skipped: pandas is not installed on the publishing PC.")
        return None
    per: dict = {}
    for p in files:
        frames = _frames_from_file(p, pd, "Stock prices")
        if not frames:
            continue
        mk = price_market(p.stem, frames)
        dst = per.setdefault(mk, {})
        for t, f in frames.items():
            s = price_symbol(t, mk)
            old = dst.get(s)
            if old is None or (f.index[-1], len(f)) > (old.index[-1], len(old)):
                dst[s] = f
    # long history underneath: the scanners' newer files win wherever dates overlap
    for mk, hist in read_price_history(cfg, pd).items():
        dst = per.setdefault(mk, {})
        joined = 0
        for s, h in hist.items():
            cur = dst.get(s)
            if cur is None:
                dst[s] = h
            else:
                both = pd.concat([h, cur])
                dst[s] = both[~both.index.duplicated(keep="last")].sort_index()
                joined += 1
        print(f"  Price history     {mk}: {len(hist)} symbols, {joined} joined to the recent prices")
    if not per:
        return None
    markets = {}
    for mk, frames in per.items():
        value = {s: float((f["c"].iloc[-60:] * f["v"].iloc[-60:]).mean()) for s, f in frames.items()}
        if not any(value.values()):
            print(f"  Stock prices      {mk}: no volume in the price files, so the top 500 is not ranked by traded value")
        flat = sum(1 for f in frames.values() if (f["h"] == f["l"]).all())
        if flat * 2 > len(frames):
            print(f"  Stock prices      {mk}: only one price per day found (no open/high/low), so candles show as lines")
        ranked = sorted(frames, key=lambda s: -value[s])
        top = [s for s in ranked if value[s] > 0][:PRICE_TOP] or ranked[:PRICE_TOP]
        first = min(f.index[0] for f in frames.values())
        asof = max(f.index[-1] for f in frames.values())
        markets[mk] = {"top": top, "frames": frames, "asof": asof.strftime("%Y-%m-%d")}
        print(f"  Stock prices      {mk}: {len(frames)} symbols, {first.date()} to {asof.date()}, top {len(top)} by traded value")
    return {"built_at": datetime.now(timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ"), "markets": markets}


# ------------------------------------------------------------------ price pieces
# History is split into encrypted pieces so a daily publish only uploads what changed:
#   prices.json                 index + this month's bars (changes every publish, small)
#   prices/y2019-b07.json       one closed year, symbols of bucket 07 (written once)
#   prices/m2026-03-b07.json    one closed month of the current year (written once)
# A symbol's bucket comes from an HMAC of the symbol with a key from your password, so file names
# say nothing about which stocks are inside. Pieces whose content is unchanged are not rewritten.
PRICE_BUCKETS = 64


def bucket_of(sym: str, password: str) -> int:
    import hmac
    return int(hmac.new(password.encode("utf-8"), ("trilens-bucket:" + sym).encode("utf-8"), "sha256").hexdigest()[:8], 16) % PRICE_BUCKETS


class Sealer:
    """AES-GCM envelopes sharing one salt (one PBKDF2 run per publish, and one in the browser)."""

    def __init__(self, password: str, salt: bytes | None = None):
        self.password = password
        self.salt = salt or secrets.token_bytes(16)
        self.keys: dict = {}
        self.key = self._key(self.salt)

    def _key(self, salt: bytes) -> bytes:
        if salt not in self.keys:
            self.keys[salt] = hashlib.pbkdf2_hmac("sha256", self.password.encode("utf-8"), salt, PBKDF2_ITER, dklen=32)
        return self.keys[salt]

    def seal(self, obj: dict, built_at: str) -> dict:
        from cryptography.hazmat.primitives.ciphers.aead import AESGCM
        raw = gzip.compress(json.dumps(obj, ensure_ascii=False, separators=(",", ":")).encode("utf-8"), 9, mtime=0)
        iv = secrets.token_bytes(12)
        b = lambda x: base64.b64encode(x).decode()
        return {"v": 1, "enc": True, "alg": "AES-256-GCM", "kdf": "PBKDF2-SHA256", "iter": PBKDF2_ITER, "comp": "gzip",
                "salt": b(self.salt), "iv": b(iv), "data": b(AESGCM(self.key).encrypt(iv, raw, None)), "built_at": built_at}

    def open(self, env: dict):
        from cryptography.hazmat.primitives.ciphers.aead import AESGCM
        d = lambda x: base64.b64decode(x)
        key = self._key(d(env["salt"])) if env.get("iter") == PBKDF2_ITER else hashlib.pbkdf2_hmac("sha256", self.password.encode(), d(env["salt"]), env["iter"], dklen=32)
        return json.loads(gzip.decompress(AESGCM(key).decrypt(d(env["iv"]), d(env["data"]), None)))


def price_pieces(prices: dict, password: str, today: date) -> tuple[dict, dict]:
    """-> (index with this month's bars, {piece name: {bucket, series}}) for closed years/months."""
    month0 = datetime(today.year, today.month, 1)
    year0 = datetime(today.year, 1, 1)
    pieces: dict = {}
    index = {"v": 2, "built_at": prices["built_at"], "buckets": PRICE_BUCKETS, "markets": {}, "recent": []}
    for mk, m in prices["markets"].items():
        syms = []
        for s, f in sorted(m["frames"].items()):
            b = bucket_of(s, password)
            recent = f[f.index >= month0]
            before = f[f.index < month0]
            if len(before):
                recent = pd_concat_last(before, recent)   # one earlier bar: the day change needs it
            dp = 2 if float(f["c"].iloc[-60:].median()) >= 1 else 4
            syms.append([s, dp, b])
            if len(recent):
                index["recent"].append(encode_prices(s, recent, bars=len(recent)))
            for key, part in _closed_parts(f[f.index < month0], year0):
                name = f"{key}-b{b:02d}"
                pieces.setdefault(name, {"piece": key, "bucket": b, "series": []})["series"].append(encode_prices(s, part, bars=len(part)))
        index["markets"][mk] = {"top": m["top"], "asof": m["asof"], "symbols": syms}
    index["pieces"] = sorted({p["piece"] for p in pieces.values()})
    return index, pieces


def pd_concat_last(before, recent):
    import pandas as pd
    return pd.concat([before.iloc[-1:], recent])


def _closed_parts(f, year0):
    """Closed calendar years before this year as y2019, and closed months of this year as m2026-03."""
    if not len(f):
        return
    for y, part in f[f.index < year0].groupby(f[f.index < year0].index.year):
        yield f"y{y}", part
    cur = f[f.index >= year0]
    for (y, mth), part in cur.groupby([cur.index.year, cur.index.month]):
        yield f"m{y}-{mth:02d}", part


def write_prices(out_dir: Path, prices: dict, password: str, today: date | None = None) -> dict:
    """Write prices.json and the pieces under prices/; returns counts for the summary line."""
    index, pieces = price_pieces(prices, password, today or datetime.now(timezone.utc).date())
    pdir = out_dir / "prices"
    pdir.mkdir(parents=True, exist_ok=True)
    existing = {p.stem: p for p in pdir.glob("*.json")}
    salt = None
    for p in list(existing.values())[:1]:
        try:
            salt = base64.b64decode(json.loads(p.read_text(encoding="utf-8"))["salt"])
        except Exception:  # noqa: BLE001
            salt = None
    sealer = Sealer(password, salt)
    written = kept = 0
    for name, obj in pieces.items():
        p = pdir / f"{name}.json"
        if p.exists():
            try:
                if sealer.open(json.loads(p.read_text(encoding="utf-8"))) == obj:
                    kept += 1
                    continue
            except Exception:  # noqa: BLE001
                pass
        p.write_text(json.dumps(sealer.seal(obj, prices["built_at"]), separators=(",", ":")), encoding="utf-8")
        written += 1
    removed = 0
    for stem, p in existing.items():
        if stem not in pieces:
            p.unlink()
            removed += 1
    (out_dir / "prices.json").write_text(json.dumps(sealer.seal(index, prices["built_at"]), separators=(",", ":")), encoding="utf-8")
    return {"pieces": len(pieces), "written": written, "kept": kept, "removed": removed,
            "index_kb": (out_dir / "prices.json").stat().st_size / 1024,
            "total_mb": sum(p.stat().st_size for p in pdir.glob("*.json")) / 1048576}


# ------------------------------------------------------------------ encryption
def encrypt(obj: dict, password: str) -> dict:
    from cryptography.hazmat.primitives.ciphers.aead import AESGCM

    raw = gzip.compress(json.dumps(obj, ensure_ascii=False, separators=(",", ":")).encode("utf-8"), 9, mtime=0)
    salt, iv = secrets.token_bytes(16), secrets.token_bytes(12)
    key = hashlib.pbkdf2_hmac("sha256", password.encode("utf-8"), salt, PBKDF2_ITER, dklen=32)
    ct = AESGCM(key).encrypt(iv, raw, None)  # ciphertext || 16-byte tag, which is what WebCrypto expects
    b = lambda x: base64.b64encode(x).decode()
    return {"v": 1, "enc": True, "alg": "AES-256-GCM", "kdf": "PBKDF2-SHA256", "iter": PBKDF2_ITER, "comp": "gzip",
            "salt": b(salt), "iv": b(iv), "data": b(ct), "built_at": obj["built_at"]}


def get_password(a) -> str:
    if a.password:
        return a.password
    if os.environ.get("TRILENS_PASSWORD"):
        return os.environ["TRILENS_PASSWORD"]
    loc = read_json(ROOT / "config" / "local.json", {}) or {}
    return str(loc.get("technical_password") or "")


# ------------------------------------------------------------------ main
def main(argv=None) -> int:
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("--reversal-dir")
    ap.add_argument("--accumulation-dir")
    ap.add_argument("--ema-dir")
    ap.add_argument("--playbook-dir")
    ap.add_argument("--scans-dir")
    ap.add_argument("--paper-book")
    ap.add_argument("--uploads-dir")
    ap.add_argument("--password", help="override; normally read from config/local.json")
    ap.add_argument("--no-local", action="store_true", help="do not write bundle.local.json")
    ap.add_argument("--out", help="output folder (default data/technical)")
    ap.add_argument("--no-prices", action="store_true", help="skip the end-of-day stock prices")
    a = ap.parse_args(argv)

    out_dir = Path(a.out) if a.out else OUT
    D = Dirs(a)
    cur = read_json(ROOT / "pipeline" / "technical_curated.json", {}) or {}
    print("Reading your scanner folders...")
    for label, p in (("Reversal bot", D.reversal), ("Accumulation bot", D.accumulation), ("EMA Positional", D.ema), ("EMA Playbook", D.playbook), ("Scans", D.scans), ("Paper book", D.paper)):
        print(f"  {label:<17}", "found" if p and p.exists() else "NOT FOUND", f"({p})" if p else "(not set)")

    strategies = []
    for s in cur.get("strategies", []):
        s = json.loads(json.dumps(s))
        spec = s.pop("metrics_from", None)
        if spec:
            fresh = resolve_metrics(spec, D)
            if fresh:
                s["metrics"] = {**s.get("metrics", {}), **fresh}
        strategies.append(s)

    signals = {"accumulation": read_accumulation(D), "reversal": read_reversal(D), "revenue_dip": read_revenue(D),
              "context": read_context(D), "analog": read_analog(D), "basebreakout": read_basebreakout(D),
              "weinstein": read_weinstein(D), "mtf": read_mtf(D), "dbe": read_dbe(D),
              "dbpyramid": read_dbpyramid(D), "msr": read_msr(D), "pbmtf": read_pbmtf(D),
              "breakretest": read_breakretest(D), "ema_vcp": read_ema_vcp(D), "ema_playbook": read_playbook(D),
              "inversehs": read_inversehs(D), "fundamental": read_fundamental(D),
              "master_framework": read_master_framework(D), "alpha_framework": read_alpha_framework(D), "akshat": read_akshat(D),
              "tef": read_tef(D), "vcp": read_vcp(D), "rachana_tps": read_rachana(D), "bbladder": read_bbladder(D)}
    signals = {k: v for k, v in signals.items() if v}
    bundle = {
        "v": 1, "built_at": datetime.now(timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ"),
        "signals": signals, "strategies": strategies, "results": read_results(D),
        "automation": read_automation(cur, D), "library": build_library(cur, D), "notes": NOTES,
    }

    out_dir.mkdir(parents=True, exist_ok=True)
    if not a.no_local:
        (out_dir / "bundle.local.json").write_text(json.dumps(bundle, ensure_ascii=False, separators=(",", ":")), encoding="utf-8")
    pw = get_password(a)
    published = False
    if pw:
        env = encrypt(bundle, pw)
        (out_dir / "bundle.json").write_text(json.dumps(env, separators=(",", ":")), encoding="utf-8")
        published = True
    else:
        print("\nNo password set (config/local.json, key technical_password). bundle.json was NOT written, so nothing private can be published.")

    meta = {"built_at": bundle["built_at"], "encrypted": published, "strategies": len(strategies), "library": len(bundle["library"]),
            "markets_scanned": sorted(signals.get("accumulation", {}).keys())}
    (out_dir / "meta.json").write_text(json.dumps(meta), encoding="utf-8")

    # public ticker list: opt-in only, symbols and BUY/WATCH, nothing else
    ps = out_dir / "public_signals.json"
    cfg = D.cfg
    if cfg.get("publish_public_signals"):
        tick = {}
        for mk, v in (signals.get("accumulation") or {}).items():
            for st, rows in (("BUY", v["buys"]), ("WATCH", v["watch"])):
                for r in rows:
                    tick.setdefault(r["ticker"].upper(), {"state": st, "src": "Accumulation bot"})
        ps.write_text(json.dumps({"asof": bundle["built_at"], "tickers": tick}), encoding="utf-8")
    elif ps.exists():
        ps.unlink()

    # end-of-day stock prices for the chart, encrypted with the same password
    print("\nReading end-of-day stock prices...")
    prices = None if a.no_prices else read_prices(D, signals, D.cfg)
    if prices and pw:
        r = write_prices(out_dir, prices, pw)
        print(f"  prices.json {r['index_kb']:.0f} KB (this month) + {r['pieces']} history pieces, {r['total_mb']:.0f} MB in all, encrypted:"
              f" {r['written']} new or changed, {r['kept']} unchanged, {r['removed']} removed.")
    elif prices:
        print("  Stock prices were read but not written: no password set (config/local.json).")
    meta["stock_markets"] = sorted(prices["markets"]) if prices else []
    (out_dir / "meta.json").write_text(json.dumps(meta), encoding="utf-8")

    size = (out_dir / ("bundle.json" if published else "bundle.local.json")).stat().st_size
    print(f"\nBuilt: {len(strategies)} strategies, {len(bundle['library'])} library items, signals for {', '.join(signals) or 'none'}.")
    print(f"Bundle size {size/1024:.0f} KB, {'encrypted' if published else 'NOT encrypted (local only)'}.")
    if size > 40_000_000:
        print("Warning: this is large for GitHub (limit 100 MB). Remove big images or tables from technical_uploads.")
    return 0


if __name__ == "__main__":
    sys.exit(main())
