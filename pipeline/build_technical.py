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
  public_signals.json only if publish_public_signals is true (ticker symbols and BUY/WATCH, nothing else)

Needs: openpyxl, cryptography.  Optional: Pillow (shrinks big images), pypdf (reads PDFs).
"""
from __future__ import annotations

import argparse
import base64
import csv
import gzip
import hashlib
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
        self.scans = pick(a.scans_dir, "scans_dir")
        self.paper = pick(a.paper_book, "paper_book")
        up = cfg.get("uploads_dir", "technical_uploads")
        self.uploads = Path(a.uploads_dir) if a.uploads_dir else (ROOT / up)

    def fill(self, s: str) -> str:
        return (s.replace("{reversal_dir}", str(self.reversal or ""))
                 .replace("{accumulation_dir}", str(self.accumulation or ""))
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
def read_reversal(D: Dirs) -> dict:
    out = {}
    if not D.scans or not D.scans.exists():
        note("scans folder not found: the Reversal bot and Revenue and dip signals will appear once PUBLISH.bat runs on the PC that has it")
        return out
    for mk in ("US", "India"):
        h, t = D.scans / f"LATEST_{mk}.html", D.scans / f"LATEST_{mk}.txt"
        if not h.exists() and not t.exists():
            continue
        item = {}
        if h.exists():
            item["html"] = read_text(h)
        if t.exists():
            item["text"] = read_text(t)
        m = re.search(r"data through (\d{4}-\d{2}-\d{2})", item.get("text") or item.get("html") or "")
        item["asof"] = m.group(1) if m else datetime.fromtimestamp((h if h.exists() else t).stat().st_mtime).strftime("%Y-%m-%d")
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
        out[mk] = {"records": recs, "regime_on": j.get("regime_on"), "regime_gap_pct": num(j.get("regime_gap_pct")), "asof": j.get("asof") or j.get("date")}
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


def read_results(D: Dirs) -> dict:
    R = {"equity": [], "yearly": [], "tables": []}
    rd = D.reversal
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
    for folder in (D.reversal, D.accumulation):
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
    ap.add_argument("--scans-dir")
    ap.add_argument("--paper-book")
    ap.add_argument("--uploads-dir")
    ap.add_argument("--password", help="override; normally read from config/local.json")
    ap.add_argument("--no-local", action="store_true", help="do not write bundle.local.json")
    ap.add_argument("--out", help="output folder (default data/technical)")
    a = ap.parse_args(argv)

    out_dir = Path(a.out) if a.out else OUT
    D = Dirs(a)
    cur = read_json(ROOT / "pipeline" / "technical_curated.json", {}) or {}
    print("Reading your scanner folders...")
    for label, p in (("Reversal bot", D.reversal), ("Accumulation bot", D.accumulation), ("Scans", D.scans), ("Paper book", D.paper)):
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

    signals = {"accumulation": read_accumulation(D), "reversal": read_reversal(D), "revenue_dip": read_revenue(D)}
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

    size = (out_dir / ("bundle.json" if published else "bundle.local.json")).stat().st_size
    print(f"\nBuilt: {len(strategies)} strategies, {len(bundle['library'])} library items, signals for {', '.join(signals) or 'none'}.")
    print(f"Bundle size {size/1024:.0f} KB, {'encrypted' if published else 'NOT encrypted (local only)'}.")
    if size > 40_000_000:
        print("Warning: this is large for GitHub (limit 100 MB). Remove big images or tables from technical_uploads.")
    return 0


if __name__ == "__main__":
    sys.exit(main())
