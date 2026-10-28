"""SEC EDGAR: insider transactions (Form 4) and the filing tape (8-K, 10-Q, 10-K, 13D/G ...) for US companies.

EDGAR is free but asks every client to identify itself. Put your name and email in the
SEC_USER_AGENT secret (or sec_user_agent in config/watchlist.json), for example
"Jane Doe jane@example.com". Without it this job is skipped.
Fair-access limit is 10 requests a second; this module stays well under it."""
from __future__ import annotations

import os
import time
import xml.etree.ElementTree as ET
from datetime import date, datetime, timedelta

from .common import DATA, file_key, http_get, log, now_iso, read_json, safe_float, write_json

FORM_DESC = {
    "10-K": "Annual report", "10-K/A": "Annual report (amended)", "10-Q": "Quarterly report", "10-Q/A": "Quarterly report (amended)",
    "8-K": "Current report", "8-K/A": "Current report (amended)", "6-K": "Foreign issuer report", "20-F": "Annual report (foreign issuer)", "40-F": "Annual report (Canadian issuer)",
    "SC 13D": "Activist ownership report (over 5%)", "SC 13D/A": "Activist ownership update", "SC 13G": "Passive ownership report (over 5%)", "SC 13G/A": "Passive ownership update",
    "SCHEDULE 13D": "Activist ownership report (over 5%)", "SCHEDULE 13D/A": "Activist ownership update", "SCHEDULE 13G": "Passive ownership report (over 5%)", "SCHEDULE 13G/A": "Passive ownership update",
    "DEF 14A": "Proxy statement", "DEFA14A": "Proxy materials", "S-1": "Registration statement", "S-3": "Shelf registration", "S-8": "Employee stock plan registration",
    "424B5": "Prospectus supplement", "424B2": "Prospectus supplement", "144": "Proposed insider sale", "3": "Initial insider holdings", "5": "Annual insider changes",
    "NT 10-K": "Late annual report notice", "NT 10-Q": "Late quarterly report notice", "25": "Delisting notice", "15": "Deregistration", "CORRESP": "Letter to the SEC", "UPLOAD": "Letter from the SEC",
}
ITEM_DESC = {
    "1.01": "Material agreement", "1.02": "Agreement ended", "1.03": "Bankruptcy", "2.01": "Acquisition or sale completed", "2.02": "Results of operations", "2.03": "New debt",
    "2.05": "Restructuring costs", "2.06": "Impairment", "3.01": "Listing notice", "3.02": "Unregistered share sale", "4.01": "Auditor change", "4.02": "Financials not reliable",
    "5.01": "Control change", "5.02": "Director or officer change", "5.03": "Bylaw change", "5.07": "Shareholder vote", "7.01": "Regulation FD disclosure", "8.01": "Other events", "9.01": "Exhibits",
}
CODES = {
    "P": ("buy", "Purchase"), "S": ("sell", "Sale"), "A": ("other", "Award"), "M": ("other", "Option exercise"), "X": ("other", "Option exercise"),
    "F": ("other", "Tax withholding"), "G": ("other", "Gift"), "D": ("other", "Returned to company"), "C": ("other", "Conversion"), "J": ("other", "Other"),
    "I": ("other", "Discretionary"), "W": ("other", "Inheritance"), "K": ("other", "Equity swap"), "L": ("other", "Small acquisition"), "V": ("other", "Voluntary report"),
}
SKIP_FORMS = {"4", "4/A", "SD", "CERT", "EFFECT", "FWP", "ARS", "11-K", "S-8 POS"}


def user_agent(cfg: dict) -> str:
    return (os.environ.get("SEC_USER_AGENT") or cfg.get("sec_user_agent") or "").strip()


def _text(el, path):
    if el is None:
        return None
    n = el.find(path)
    return n.text.strip() if n is not None and n.text else None


def _flag(v) -> bool:
    return str(v).strip().lower() in ("1", "true")


def parse_form4(xml_text: str, url: str, acc: str) -> list[dict]:
    """One aggregated row per (person, code, date): shares summed, price volume-weighted."""
    try:
        root = ET.fromstring(xml_text)
    except ET.ParseError:
        return []
    owner = root.find("reportingOwner")
    name = _text(owner, "reportingOwnerId/rptOwnerName") or "Unknown"
    rel = owner.find("reportingOwnerRelationship") if owner is not None else None
    title = _text(rel, "officerTitle")
    if not title and rel is not None:
        bits = []
        if _flag(_text(rel, "isDirector")):
            bits.append("Director")
        if _flag(_text(rel, "isTenPercentOwner")):
            bits.append("10% owner")
        if _flag(_text(rel, "isOfficer")):
            bits.append("Officer")
        title = ", ".join(bits) or None
    plan = _flag(_text(root, "aff10b5One"))
    groups: dict[tuple, dict] = {}
    for tx in root.findall("nonDerivativeTable/nonDerivativeTransaction"):
        code = _text(tx, "transactionCoding/transactionCode") or "J"
        d = (_text(tx, "transactionDate/value") or "")[:10]
        sh = safe_float(_text(tx, "transactionAmounts/transactionShares/value"), 0.0) or 0.0
        px = safe_float(_text(tx, "transactionAmounts/transactionPricePerShare/value"))
        after = safe_float(_text(tx, "postTransactionAmounts/sharesOwnedFollowingTransaction/value"))
        if sh <= 0 or not d:
            continue
        g = groups.setdefault((code, d), {"shares": 0.0, "notional": 0.0, "priced": 0.0, "after": None})
        g["shares"] += sh
        if px:
            g["notional"] += sh * px
            g["priced"] += sh
        if after is not None:
            g["after"] = after
    out = []
    for (code, d), g in groups.items():
        typ, label = CODES.get(code, ("other", "Other"))
        price = round(g["notional"] / g["priced"], 2) if g["priced"] else None
        row = {"date": d, "name": name.title() if name.isupper() else name, "title": title, "code": code, "type": typ, "type_label": label,
               "shares": int(round(g["shares"])), "price": price, "value": int(round(g["notional"])) if g["notional"] else None,
               "owned_after": int(round(g["after"])) if g["after"] is not None else None, "url": url, "acc": acc}
        if plan:
            row["plan"] = True
        out.append(row)
    return out


def summarise(txs: list[dict], today: date | None = None) -> dict:
    today = today or date.today()
    cut = (today - timedelta(days=90)).isoformat()
    buys = [t for t in txs if t["type"] == "buy" and t["date"] >= cut]
    sells = [t for t in txs if t["type"] == "sell" and t["date"] >= cut]
    bv = sum(t.get("value") or 0 for t in buys)
    sv = sum(t.get("value") or 0 for t in sells)
    return {"buys_90d": len(buys), "sells_90d": len(sells), "buy_value": bv, "sell_value": sv, "net_value": bv - sv}


def filings_from_recent(recent: dict, cik: int, limit: int = 40) -> list[dict]:
    out = []
    n = len(recent.get("accessionNumber", []))
    for i in range(n):
        form = recent["form"][i]
        if form in SKIP_FORMS:
            continue
        acc = recent["accessionNumber"][i]
        doc = recent.get("primaryDocument", [""] * n)[i]
        items = recent.get("items", [""] * n)[i] or ""
        desc = FORM_DESC.get(form) or FORM_DESC.get(form.split("/")[0]) or recent.get("primaryDocDescription", [""] * n)[i] or form
        if form.startswith("8-K") and items:
            names = [ITEM_DESC[c] for c in items.split(",") if c in ITEM_DESC and c not in ("9.01",)]
            if names:
                desc = names[0] + (f" and {len(names) - 1} more" if len(names) > 1 else "")
        url = f"https://www.sec.gov/Archives/edgar/data/{cik}/{acc.replace('-', '')}/{doc}" if doc else None
        out.append({"date": recent["filingDate"][i], "form": form, "desc": desc, "items": items, "url": url})
        if len(out) >= limit:
            break
    return out


def _sec_get(url: str, ua: str):
    r = http_get(url, headers={"User-Agent": ua, "Accept-Encoding": "gzip, deflate"}, retries=2, timeout=25, pause=0.13)
    return r


def cik_map(ua: str) -> dict[str, int]:
    r = _sec_get("https://www.sec.gov/files/company_tickers.json", ua)
    if not r:
        return {}
    try:
        return {v["ticker"].upper(): int(v["cik_str"]) for v in r.json().values()}
    except Exception:
        return {}


def edgar_symbol(sym: str) -> str:
    return sym.upper().replace(".", "-")


def update_company(sym: str, cik: int, ua: str, prev: dict) -> dict:
    sub = _sec_get(f"https://data.sec.gov/submissions/CIK{cik:010d}.json", ua)
    if not sub:
        raise RuntimeError("submissions unavailable")
    recent = sub.json().get("filings", {}).get("recent", {})
    filings = filings_from_recent(recent, cik)
    known = {t.get("acc") for t in (prev.get("insiders") or {}).get("transactions", []) if t.get("acc")}
    txs = list((prev.get("insiders") or {}).get("transactions", []))
    cutoff = (date.today() - timedelta(days=120)).isoformat()
    n = len(recent.get("accessionNumber", []))
    fetched = 0
    for i in range(n):
        if recent["form"][i] not in ("4", "4/A"):
            continue
        if recent["filingDate"][i] < cutoff:
            break
        acc = recent["accessionNumber"][i]
        if acc in known:
            continue
        if fetched >= 40:
            break
        doc = (recent.get("primaryDocument", [""] * n)[i] or "").split("/")[-1]
        if not doc.endswith(".xml"):
            continue
        base = f"https://www.sec.gov/Archives/edgar/data/{cik}/{acc.replace('-', '')}/"
        r = _sec_get(base + doc, ua)
        fetched += 1
        if r:
            txs.extend(parse_form4(r.text, base + doc, acc))
    keep = (date.today() - timedelta(days=370)).isoformat()
    txs = sorted({(t["acc"], t["code"], t["date"], t["name"]): t for t in txs if t["date"] >= keep}.values(), key=lambda t: (t["date"], t["acc"]), reverse=True)[:80]
    return {"insiders": {"summary": summarise(txs), "transactions": txs}, "filings": filings}


def run(tickers: list[dict], cfg: dict) -> dict:
    ua = user_agent(cfg)
    if not ua or "@" not in ua:
        log.warning("EDGAR skipped: set the SEC_USER_AGENT secret to your name and email")
        return {"skipped": "no sec_user_agent"}
    m = cik_map(ua)
    if not m:
        raise RuntimeError("could not load the SEC ticker list")
    ok, bad = 0, []
    for tk in tickers:
        sym = tk["symbol"]
        if tk["market"] != "US":
            continue
        cik = m.get(edgar_symbol(sym))
        path = DATA / "fundamentals" / f"{file_key(sym)}.json"
        co = read_json(path)
        if not co or co.get("demo"):
            continue
        if not cik:
            log.info("%s: not in the SEC list (ETF or foreign issuer)", sym)
            continue
        try:
            upd = update_company(sym, cik, ua, co)
            co.update(upd)
            write_json(path, co)
            ok += 1
        except Exception as e:
            log.warning("%s: EDGAR failed (%s)", sym, e)
            bad.append(sym)
    log.info("edgar: %d updated, %d failed", ok, len(bad))
    if ok == 0 and bad:
        raise RuntimeError("EDGAR returned nothing")
    return {"ok": ok, "failed": bad}
