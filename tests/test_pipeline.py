"""Run:  python -m unittest discover -s tests -v      (from the project folder)

These use small samples shaped like the real SEC, Google News and Yahoo responses, so the
parsers are checked without needing the network."""
import base64
import gzip
import hashlib
import json
import sys
import unittest
from datetime import date, datetime, timedelta, timezone
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
sys.path.insert(0, str(ROOT))

import pandas as pd  # noqa: E402

from pipeline import build_technical as bt  # noqa: E402
from pipeline import fetch_edgar as ed  # noqa: E402
from pipeline import fetch_fundamentals as ff  # noqa: E402
from pipeline import fetch_india_index as fi  # noqa: E402
from pipeline import fetch_news as fn  # noqa: E402
from pipeline import fetch_quotes as fq  # noqa: E402
from pipeline import fetch_sentiment as fs  # noqa: E402
from pipeline import model  # noqa: E402
from pipeline.sentiment_lexicon import keywords, score_text  # noqa: E402

FORM4 = """<?xml version="1.0"?>
<ownershipDocument>
  <documentType>4</documentType><periodOfReport>2026-10-20</periodOfReport><aff10b5One>1</aff10b5One>
  <issuer><issuerCik>0001045810</issuerCik><issuerName>NVIDIA CORP</issuerName><issuerTradingSymbol>NVDA</issuerTradingSymbol></issuer>
  <reportingOwner>
    <reportingOwnerId><rptOwnerCik>0001</rptOwnerCik><rptOwnerName>DOE JANE</rptOwnerName></reportingOwnerId>
    <reportingOwnerRelationship><isDirector>1</isDirector><isOfficer>1</isOfficer><officerTitle>Chief Financial Officer</officerTitle></reportingOwnerRelationship>
  </reportingOwner>
  <nonDerivativeTable>
    <nonDerivativeTransaction>
      <securityTitle><value>Common Stock</value></securityTitle><transactionDate><value>2026-10-20</value></transactionDate>
      <transactionCoding><transactionFormType>4</transactionFormType><transactionCode>S</transactionCode></transactionCoding>
      <transactionAmounts><transactionShares><value>75000</value></transactionShares><transactionPricePerShare><value>181.25</value></transactionPricePerShare><transactionAcquiredDisposedCode><value>D</value></transactionAcquiredDisposedCode></transactionAmounts>
      <postTransactionAmounts><sharesOwnedFollowingTransaction><value>3600000</value></sharesOwnedFollowingTransaction></postTransactionAmounts>
    </nonDerivativeTransaction>
    <nonDerivativeTransaction>
      <securityTitle><value>Common Stock</value></securityTitle><transactionDate><value>2026-10-20</value></transactionDate>
      <transactionCoding><transactionFormType>4</transactionFormType><transactionCode>S</transactionCode></transactionCoding>
      <transactionAmounts><transactionShares><value>25000</value></transactionShares><transactionPricePerShare><value>182.00</value></transactionPricePerShare><transactionAcquiredDisposedCode><value>D</value></transactionAcquiredDisposedCode></transactionAmounts>
      <postTransactionAmounts><sharesOwnedFollowingTransaction><value>3575000</value></sharesOwnedFollowingTransaction></postTransactionAmounts>
    </nonDerivativeTransaction>
    <nonDerivativeTransaction>
      <securityTitle><value>Common Stock</value></securityTitle><transactionDate><value>2026-10-18</value></transactionDate>
      <transactionCoding><transactionFormType>4</transactionFormType><transactionCode>P</transactionCode></transactionCoding>
      <transactionAmounts><transactionShares><value>1000</value></transactionShares><transactionPricePerShare></transactionPricePerShare><transactionAcquiredDisposedCode><value>A</value></transactionAcquiredDisposedCode></transactionAmounts>
      <postTransactionAmounts><sharesOwnedFollowingTransaction><value>10000</value></sharesOwnedFollowingTransaction></postTransactionAmounts>
    </nonDerivativeTransaction>
  </nonDerivativeTable>
</ownershipDocument>"""

RSS = """<?xml version="1.0" encoding="UTF-8"?><rss version="2.0"><channel><title>x</title>
<item><title>Nvidia soars after record quarter - Reuters</title><link>https://news.google.com/rss/articles/abc</link><pubDate>Tue, 27 Oct 2026 14:30:00 GMT</pubDate><source url="https://reuters.com">Reuters</source></item>
<item><title>Analysts cut targets on chip stocks - Bloomberg</title><link>https://news.google.com/rss/articles/def</link><pubDate>Mon, 26 Oct 2026 09:00:00 GMT</pubDate><source url="https://bloomberg.com">Bloomberg</source></item>
<item><title>No date item</title><link>https://x</link></item></channel></rss>"""


class Edgar(unittest.TestCase):
    def test_form4_aggregates_by_code_and_day(self):
        rows = ed.parse_form4(FORM4, "https://x/f.xml", "0001-26-000001")
        sells = [r for r in rows if r["code"] == "S"]
        self.assertEqual(len(sells), 1)
        s = sells[0]
        self.assertEqual(s["shares"], 100000)
        self.assertAlmostEqual(s["price"], 181.44, places=2)
        self.assertEqual(s["value"], 18143750)
        self.assertEqual(s["owned_after"], 3575000)
        self.assertEqual(s["type"], "sell")
        self.assertEqual(s["name"], "Doe Jane")
        self.assertEqual(s["title"], "Chief Financial Officer")
        self.assertTrue(s["plan"])
        buy = [r for r in rows if r["code"] == "P"][0]
        self.assertEqual(buy["type"], "buy")
        self.assertIsNone(buy["price"])
        self.assertIsNone(buy["value"])

    def test_bad_xml_returns_empty(self):
        self.assertEqual(ed.parse_form4("<html>not xml", "u", "a"), [])

    def test_summary_window(self):
        today = date(2026, 10, 28)
        txs = [{"type": "buy", "date": "2026-10-01", "value": 100}, {"type": "sell", "date": "2026-09-30", "value": 400},
               {"type": "sell", "date": "2026-05-01", "value": 9999}, {"type": "other", "date": "2026-10-10", "value": 5}]
        s = ed.summarise(txs, today)
        self.assertEqual((s["buys_90d"], s["sells_90d"], s["net_value"]), (1, 1, -300))

    def test_filings_skip_form4_and_describe_8k(self):
        recent = {"accessionNumber": ["0001-26-1", "0001-26-2", "0001-26-3"], "filingDate": ["2026-10-27", "2026-10-26", "2026-10-20"],
                  "form": ["8-K", "4", "SC 13G/A"], "items": ["2.02,9.01", "", ""], "primaryDocument": ["a.htm", "xslF345X05/f.xml", "g.htm"], "primaryDocDescription": ["", "", ""]}
        f = ed.filings_from_recent(recent, 1045810)
        self.assertEqual([x["form"] for x in f], ["8-K", "SC 13G/A"])
        self.assertEqual(f[0]["desc"], "Results of operations")
        self.assertEqual(f[0]["url"], "https://www.sec.gov/Archives/edgar/data/1045810/0001261/a.htm")
        self.assertIn("Passive ownership", f[1]["desc"])

    def test_edgar_symbol(self):
        self.assertEqual(ed.edgar_symbol("brk.b"), "BRK-B")

    def test_cik_map_and_ticker_index(self):
        raw = {"0": {"cik_str": 320193, "ticker": "aapl", "title": "Apple Inc."}, "1": {"cik_str": 1045810, "ticker": "nvda", "title": "NVIDIA CORP"}}
        self.assertEqual(ed.cik_map(raw), {"AAPL": 320193, "NVDA": 1045810})
        rows = ed.ticker_index(raw)
        self.assertEqual(rows, [{"t": "AAPL", "c": 320193, "n": "Apple Inc."}, {"t": "NVDA", "c": 1045810, "n": "NVIDIA CORP"}])


class News(unittest.TestCase):
    def test_parse_rss(self):
        items = fn.parse_rss(RSS)
        self.assertEqual(len(items), 2)
        self.assertEqual(items[0]["title"], "Nvidia soars after record quarter")
        self.assertEqual(items[0]["source"], "Reuters")
        self.assertEqual(items[0]["ts"], "2026-10-27T14:30:00Z")

    def test_merge_dedupes_and_sorts(self):
        now = datetime.now(timezone.utc)
        a = {"ts": (now - timedelta(hours=2)).strftime("%Y-%m-%dT%H:%M:%SZ"), "title": "Nvidia Soars!", "source": "A", "url": "u1"}
        b = {"ts": (now - timedelta(hours=1)).strftime("%Y-%m-%dT%H:%M:%SZ"), "title": "nvidia soars", "source": "B", "url": "u2"}
        c = {"ts": (now - timedelta(days=40)).strftime("%Y-%m-%dT%H:%M:%SZ"), "title": "Old", "source": "C", "url": "u3"}
        out = fn.merge([a, c], [b])
        self.assertEqual(len(out), 1)
        self.assertEqual(out[0]["source"], "B")

    def test_short_name(self):
        self.assertEqual(fn.short_name("NVIDIA Corporation", "NVDA"), "NVIDIA")
        self.assertEqual(fn.short_name("Apple Inc.", "AAPL"), "Apple")


class Lexicon(unittest.TestCase):
    def test_directions(self):
        self.assertEqual(score_text("NVDA beats estimates, raises guidance 🚀")[0], "bull")
        self.assertEqual(score_text("Company misses estimates and faces lawsuit, shares plunge")[0], "bear")
        self.assertEqual(score_text("Annual meeting scheduled for next month")[0], "neutral")

    def test_negation_and_phrases(self):
        self.assertNotEqual(score_text("I am not bullish on this at all")[0], "bull")
        self.assertEqual(score_text("Earnings fall short of expectations")[0], "bear")
        self.assertEqual(score_text("Time to buy the dip")[0], "bull")

    def test_keywords(self):
        kws = keywords(["chip demand strong", "chip supply tight", "supply chain chip"], {"nvda"})
        self.assertEqual(kws[0]["w"], "chip")


class Sentiment(unittest.TestCase):
    def test_mentions_ticker(self):
        self.assertTrue(fs.mentions_ticker("loading $NVDA here", "NVDA", "NVIDIA Corporation"))
        self.assertTrue(fs.mentions_ticker("NVDA to the moon", "NVDA", ""))
        self.assertFalse(fs.mentions_ticker("turn it ON please", "ON", "ON Semiconductor Corporation"))
        self.assertTrue(fs.mentions_ticker("bought $ON today", "ON", "ON Semiconductor"))
        self.assertFalse(fs.mentions_ticker("V for victory", "V", "Visa Inc."))

    def test_spam(self):
        self.assertTrue(fs.is_spam("$A $B $C $D $E $F $G buy now"))
        self.assertFalse(fs.is_spam("Solid earnings from $AAPL today"))

    def test_aggregate_shrinks_small_samples(self):
        now = fs.iso(datetime.now(timezone.utc))
        two = fs.label_items([fs.mk("news", now, "a", "Stock surges on strong beat", "u1"), fs.mk("news", now, "a", "Shares soar after upgrade", "u2")])
        many = fs.label_items([fs.mk("news", now, "a", f"Stock surges on strong beat number {i}", f"u{i}") for i in range(40)])
        self.assertLess(fs.aggregate(two)["score"], fs.aggregate(many)["score"])
        self.assertGreater(fs.aggregate(two)["score"], 0)

    def test_native_labels_win_and_dedupe(self):
        now = fs.iso(datetime.now(timezone.utc))
        a = fs.mk("stocktwits", now, "x", "this is going nowhere fast honestly", "u", label="bull", score=0.8)
        b = fs.mk("stocktwits", now, "x", "this is going nowhere fast honestly", "u")
        out = fs.label_items([a, b])
        self.assertEqual(len(out), 1)
        self.assertEqual(out[0]["label"], "bull")

    def test_trend_and_label(self):
        h = [{"t": "2026-10-26T10:00:00Z", "s": 10, "n": 5}, {"t": "2026-10-26T12:00:00Z", "s": 20, "n": 5}, {"t": "2026-10-27T12:00:00Z", "s": 40, "n": 5}]
        self.assertEqual(fs.trend_from(h), [15.0, 40.0])
        self.assertEqual(model.sentiment_label(35), "Bullish")
        self.assertEqual(model.sentiment_label(-60), "Very bearish")


class YahooTransforms(unittest.TestCase):
    def test_earnings(self):
        idx = pd.to_datetime(["2026-11-20", "2026-08-27", "2026-05-28"]).tz_localize("America/New_York")
        df = pd.DataFrame({"EPS Estimate": [2.1, 1.9, 1.8], "Reported EPS": [float("nan"), 2.1, 1.7], "Surprise(%)": [float("nan"), 10.5, -5.6]}, index=idx)
        out = ff.earnings_from(df, None, None, today=date(2026, 10, 28))
        self.assertEqual(out["next"]["date"], "2026-11-20")
        self.assertEqual(out["history"][0]["date"], "2026-08-27")
        self.assertEqual(out["history"][0]["surprise_pct"], 10.5)
        self.assertEqual(len(out["history"]), 2)

    def test_analysts(self):
        rec = pd.DataFrame({"period": ["0m"], "strongBuy": [5], "buy": [9], "hold": [8], "sell": [1], "strongSell": [0]})
        ud = pd.DataFrame({"Firm": ["A", "B"], "ToGrade": ["Buy", "Hold"], "FromGrade": ["Hold", "Hold"], "Action": ["up", "main"]},
                          index=pd.to_datetime(["2026-10-23", "2026-10-20"]))
        a = ff.analysts_from({"recommendationMean": 2.2, "numberOfAnalystOpinions": 23}, {"low": 100, "mean": 190, "median": 200, "high": 260, "current": 180}, rec, ud, 180.0)
        self.assertEqual(a["rating_label"], "Buy")
        self.assertEqual(a["counts"]["buy"], 9)
        self.assertEqual(a["changes"][0]["action"], "Upgrade")
        self.assertEqual(a["target"]["n"], 23)

    def test_stats_and_empty(self):
        s = ff.stats_from_info({"trailingPE": 51.84, "revenueGrowth": 0.201, "dividendRate": 0.4, "profitMargins": 0.092,
                                 "bookValue": 668.05, "priceToBook": 1.76, "pegRatio": 0.82, "totalDebt": 7140000000}, 200.0)
        self.assertEqual(s["revenue_growth"], 20.1)
        self.assertEqual(s["div_yield"], 0.2)
        self.assertEqual(s["book_value"], 668.05)
        self.assertEqual(s["price_to_book"], 1.76)
        self.assertEqual(s["peg_ratio"], 0.82)
        self.assertEqual(s["total_debt"], 7140000000)
        self.assertEqual(ff.analysts_from({}, None, None, None, None), {})
        self.assertEqual(ff.earnings_from(None, None, None), {})

    def test_news_both_formats(self):
        new = [{"content": {"title": "A", "pubDate": "2026-10-27T10:00:00Z", "provider": {"displayName": "Yahoo"}, "canonicalUrl": {"url": "https://y/a"}}}]
        old = [{"title": "B", "providerPublishTime": 1793000000, "publisher": "Reuters", "link": "https://y/b"}]
        self.assertEqual(ff.news_from_yf(new)[0]["source"], "Yahoo")
        self.assertEqual(ff.news_from_yf(old)[0]["source"], "Reuters")

    def test_quote_math(self):
        q = fq.quote_from_closes([100.0, 101.0, 103.02])
        self.assertEqual(q["change_pct"], 2.0)
        self.assertIsNone(fq.quote_from_closes([100.0]))


class IndiaIndex(unittest.TestCase):
    def test_face_value_map(self):
        csv_text = "SYMBOL,NAME OF COMPANY, SERIES, DATE OF LISTING, PAID UP VALUE, MARKET LOT, ISIN NUMBER, FACE VALUE\n" \
                   "RELIANCE,Reliance Industries Limited,EQ,29-NOV-1995,10,1,INE002A01018,10\n"
        self.assertEqual(fi.face_value_map(csv_text), {"RELIANCE": "10"})

    def test_build_rows_dedupes_across_lists(self):
        a = "Company Name,Industry,Symbol,Series,ISIN Code\nReliance Industries Ltd.,Energy,RELIANCE,EQ,X\nTCS Ltd.,IT,TCS,EQ,Y\n"
        b = "Company Name,Industry,Symbol,Series,ISIN Code\nReliance Industries Ltd.,Energy,RELIANCE,EQ,X\nInfosys Ltd.,IT,INFY,EQ,Z\n"
        rows = fi.build_rows([a, b], {"RELIANCE": "10", "TCS": "1"})
        self.assertEqual([r["s"] for r in rows], ["INFY", "RELIANCE", "TCS"])
        self.assertEqual(rows[1], {"s": "RELIANCE", "n": "Reliance Industries Ltd.", "ind": "Energy", "fv": "10"})
        self.assertIsNone(rows[0]["fv"])


class Model(unittest.TestCase):
    def test_lenses(self):
        up = [100 + i * 0.5 for i in range(260)]
        self.assertEqual(model.technical_lens(up)[0], 1)
        self.assertEqual(model.technical_lens(up[::-1])[0], -1)
        self.assertIsNone(model.technical_lens([1, 2, 3])[0])
        co = {"analysts": {"mean_score": 1.8, "target": {"mean": 130, "current": 100}}, "earnings": {"history": [{"surprise_pct": 6}]}, "insiders": {"summary": {"buys_90d": 0, "sells_90d": 0, "net_value": 0}}}
        self.assertEqual(model.fundamentals_lens(co)[0], 1)
        self.assertIsNone(model.fundamentals_lens({})[0])

    def test_feed(self):
        co = {"symbol": "X", "name": "X Inc", "earnings": {"next": {"date": "2099-01-01", "eps_est": 1}, "history": []}, "insiders": {"transactions": [{"date": "2026-01-02"}]}, "filings": [], "news": []}
        f = model.build_feed([co])
        self.assertEqual(f["earnings"][0]["symbol"], "X")
        self.assertEqual(f["insiders"][0]["symbol"], "X")


class Technical(unittest.TestCase):
    def test_num(self):
        self.assertEqual(bt.num("12"), 12)
        self.assertEqual(bt.num("0.12345678"), 0.1235)
        self.assertIsNone(bt.num(""))
        self.assertEqual(bt.num(float("nan")), None)
        self.assertEqual(bt.num(3.0), 3)

    def test_encrypt_roundtrip_matches_browser_scheme(self):
        from cryptography.hazmat.primitives.ciphers.aead import AESGCM

        obj = {"built_at": "2026-10-28T00:00:00Z", "x": [1, 2, 3], "t": "héllo ₹"}
        env = bt.encrypt(obj, "correct horse")
        self.assertTrue(env["enc"] and env["iter"] == 250000 and env["comp"] == "gzip")
        b = base64.b64decode
        key = hashlib.pbkdf2_hmac("sha256", b"correct horse", b(env["salt"]), env["iter"], dklen=32)
        plain = gzip.decompress(AESGCM(key).decrypt(b(env["iv"]), b(env["data"]), None))
        self.assertEqual(json.loads(plain), obj)
        bad = hashlib.pbkdf2_hmac("sha256", b"wrong", b(env["salt"]), env["iter"], dklen=32)
        with self.assertRaises(Exception):
            AESGCM(bad).decrypt(b(env["iv"]), b(env["data"]), None)

    def test_curated_file_is_complete(self):
        cur = json.loads((ROOT / "pipeline" / "technical_curated.json").read_text(encoding="utf-8"))
        ids = [s["id"] for s in cur["strategies"]]
        self.assertEqual(len(ids), len(set(ids)))
        docs = {d["id"] for d in cur["docs"]}
        for s in cur["strategies"]:
            for k in ("name", "status", "headline", "entry", "exit"):
                self.assertTrue(s.get(k), f"{s['id']} missing {k}")
            for d in s.get("docs", []):
                self.assertIn(d, docs)

    def test_acc_row_checks(self):
        r = bt.acc_row({"ticker": "SN", "grade": "A", "risk_pct": "0.0893", "A1": "True", "A3": "False", "A5": ""})
        self.assertEqual(r["risk_pct"], 0.0893)
        self.assertEqual((r["checks"]["A1"], r["checks"]["A3"], r["checks"]["A5"]), (True, False, None))


if __name__ == "__main__":
    unittest.main()
