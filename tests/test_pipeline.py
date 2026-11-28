"""Run:  python -m unittest discover -s tests -v      (from the project folder)"""
import base64
import gzip
import hashlib
import json
import sys
import unittest
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
sys.path.insert(0, str(ROOT))

from pipeline import build_technical as bt  # noqa: E402


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


try:
    import pandas as _pd
except ImportError:  # the pipeline only needs pandas for the stock prices
    _pd = None


@unittest.skipIf(_pd is None, "pandas not installed")
class StockPrices(unittest.TestCase):
    """Made-up symbols only (rule 1)."""

    def frame(self, n=5, base=10.0):
        idx = _pd.date_range("2025-01-06", periods=n, freq="B")
        c = [base + i * 0.5 for i in range(n)]
        return _pd.DataFrame({"Open": [x - 0.1 for x in c], "High": [x + 0.3 for x in c], "Low": [x - 0.4 for x in c],
                              "Close": c, "Adj Close": [x * 0.9 for x in c], "Volume": [1000 + i for i in range(n)]}, index=idx)

    def test_layouts(self):
        pd = _pd
        a, b = self.frame(), self.frame(base=50)
        dict_of = bt.price_frames({"AAA": a, "BBB": b}, pd)
        self.assertEqual(sorted(dict_of), ["AAA", "BBB"])
        self.assertAlmostEqual(dict_of["AAA"]["c"].iloc[-1], 12.0)  # Close, not Adj Close
        wide = pd.concat({"AAA": a, "BBB": b}, axis=1)              # (ticker, field)
        self.assertEqual(sorted(bt.price_frames(wide, pd)), ["AAA", "BBB"])
        self.assertEqual(sorted(bt.price_frames(wide.swaplevel(axis=1), pd)), ["AAA", "BBB"])  # (field, ticker)
        long = pd.concat([a.assign(Symbol="AAA"), b.assign(Symbol="BBB")]).rename_axis("Date").reset_index()
        self.assertEqual(sorted(bt.price_frames(long, pd)), ["AAA", "BBB"])
        closes = pd.DataFrame({"AAA": a["Close"], "BBB": b["Close"]})
        got = bt.price_frames(closes, pd)
        self.assertEqual(sorted(got), ["AAA", "BBB"])
        self.assertTrue((got["BBB"]["o"] == got["BBB"]["c"]).all())
        self.assertEqual(sorted(bt.price_frames({"data": {"AAA": a}}, pd)), ["AAA"])
        self.assertEqual(bt.price_frames(pd.DataFrame({"x": [1, 2]}), pd), {})

    def test_market_and_symbols(self):
        self.assertEqual(bt.price_market("prices_scan_IN", []), "IN")
        self.assertEqual(bt.price_market("prices_scan_US", []), "US")
        self.assertEqual(bt.price_market("prices", ["AAA.NS", "BBB.NS", "CCC"]), "IN")
        self.assertEqual(bt.price_symbol("aaa.ns", "IN"), "AAA.NS")
        self.assertEqual(bt.price_symbol("NSE:AAA", "IN"), "AAA.NS")
        self.assertEqual(bt.price_symbol("bbb", "US"), "BBB")
        sig = {"x": {"US": {"rows": [{"symbol": "aaa"}]}, "IN": {"buys": [{"ticker": "CCC"}]}}}
        self.assertEqual(bt.signal_symbols(sig), {"US": {"AAA"}, "IN": {"CCC.NS"}})

    def test_encoding_roundtrip(self):
        f = bt._ohlcv(self.frame(8, base=123.45), _pd)
        e = bt.encode_prices("AAA", f)
        rows = bt.decode_prices(e)
        self.assertEqual(len(rows), 8)
        for (t, o, h, l, c, v), (ts, r) in zip(rows, f.iterrows()):
            self.assertEqual(t, int(ts.timestamp()))
            for x, y in ((o, r.o), (h, r.h), (l, r.l), (c, r.c)):
                self.assertAlmostEqual(x, y, places=6)
            self.assertEqual(v, r.v)
        self.assertEqual(len(bt.encode_prices("AAA", f, bars=3)["c"]), 3)


@unittest.skipIf(_pd is None, "pandas not installed")
class StockPriceFieldTables(unittest.TestCase):
    def test_dict_of_field_tables(self):
        pd = _pd
        idx = pd.date_range("2025-01-06", periods=4, freq="B")
        wide = lambda base: pd.DataFrame({"AAA": [base + i for i in range(4)], "BBB": [base * 2 + i for i in range(4)]}, index=idx)
        obj = {"Open": wide(10), "High": wide(12), "Low": wide(9), "Close": wide(11), "Adj Close": wide(5), "Volume": wide(1000), "meta": {"x": 1}}
        got = bt.price_frames(obj, pd)
        self.assertEqual(sorted(got), ["AAA", "BBB"])
        a = got["AAA"]
        self.assertEqual(list(a["o"]), [10, 11, 12, 13])
        self.assertEqual(list(a["h"]), [12, 13, 14, 15])
        self.assertEqual(list(a["l"]), [9, 10, 11, 12])
        self.assertEqual(list(a["c"]), [11, 12, 13, 14])   # Close, not Adj Close
        self.assertEqual(list(a["v"]), [1000, 1001, 1002, 1003])


@unittest.skipIf(_pd is None, "pandas not installed")
class StockPricePieces(unittest.TestCase):
    """History split into encrypted year/month pieces; made-up symbols only."""

    def prices(self):
        pd = _pd
        idx = pd.bdate_range("2023-12-20", "2026-03-10")
        mk = lambda base: bt._ohlcv(pd.DataFrame({"Close": [base + i * 0.01 for i in range(len(idx))], "Volume": [100] * len(idx)}, index=idx), pd)
        return {"built_at": "2026-03-10T00:00:00Z", "markets": {"US": {"top": ["AAA"], "asof": "2026-03-10", "frames": {"AAA": mk(10), "BBB": mk(50)}}}}

    def test_pieces_cover_every_bar_once(self):
        pr = self.prices()
        index, pieces = bt.price_pieces(pr, "pw", bt.date(2026, 3, 11))
        self.assertEqual(index["pieces"], ["m2026-01", "m2026-02", "y2023", "y2024", "y2025"])
        for sym in ("AAA", "BBB"):
            rows = []
            for p in pieces.values():
                for e in p["series"]:
                    if e["s"] == sym:
                        rows += bt.decode_prices(e)
            rec = [r for e in index["recent"] if e["s"] == sym for r in bt.decode_prices(e)]
            self.assertEqual(rec[0][0], rows[-1][0] if rows else None, "recent starts with the last closed bar")
            got = sorted({r[0] for r in rows + rec})
            want = [int(t.timestamp()) for t in pr["markets"]["US"]["frames"][sym].index]
            self.assertEqual(got, want)
        b = {s: bk for s, dp, bk in index["markets"]["US"]["symbols"]}
        self.assertEqual(b["AAA"], bt.bucket_of("AAA", "pw"))
        self.assertTrue(0 <= b["BBB"] < bt.PRICE_BUCKETS)

    def test_write_skips_unchanged_pieces_and_stays_encrypted(self):
        import tempfile
        with tempfile.TemporaryDirectory() as d:
            out = Path(d)
            r1 = bt.write_prices(out, self.prices(), "pw", bt.date(2026, 3, 11))
            self.assertEqual(r1["written"], r1["pieces"])
            r2 = bt.write_prices(out, self.prices(), "pw", bt.date(2026, 3, 11))
            self.assertEqual((r2["written"], r2["kept"], r2["removed"]), (0, r1["pieces"], 0))
            for p in list((out / "prices").glob("*.json")) + [out / "prices.json"]:
                env = json.loads(p.read_text())
                self.assertTrue(env["enc"])
                self.assertNotIn("AAA", p.read_text())
            salts = {json.loads(p.read_text())["salt"] for p in (out / "prices").glob("*.json")}
            self.assertEqual(len(salts), 1, "one salt, so one key derivation in the browser")
            idx = bt.Sealer("pw").open(json.loads((out / "prices.json").read_text()))
            self.assertEqual(idx["v"], 2)
            r3 = bt.write_prices(out, self.prices(), "pw", bt.date(2027, 1, 5))   # new year: months fold into y2026
            self.assertGreater(r3["removed"], 0)
            self.assertFalse(list((out / "prices").glob("m2026-*")))


@unittest.skipIf(_pd is None, "pandas not installed")
class StockPriceWorkbooks(unittest.TestCase):
    def test_history_workbooks_sheet_per_ticker_and_long_table_with_cache(self):
        import tempfile
        pd = _pd
        idx = pd.bdate_range("2001-01-02", periods=30)
        sheet = lambda base: pd.DataFrame({"Date": idx, "Open": base, "High": base + 1, "Low": base - 1, "Close": base + 0.5, "Volume": 1000})
        with tempfile.TemporaryDirectory() as d:
            a = Path(d) / "us_eod.xlsx"
            with pd.ExcelWriter(a) as w:
                sheet(10.0).to_excel(w, sheet_name="AAA", index=False)
                sheet(20.0).to_excel(w, sheet_name="BBB", index=False)
            b = Path(d) / "in_eod.xlsx"
            pd.concat([sheet(30.0).assign(Symbol="CCC.NS"), sheet(40.0).assign(Symbol="DDD.NS")]).to_excel(b, index=False)
            old_root = bt.ROOT
            bt.ROOT = Path(d)
            try:
                cfg = {"price_history_files": {"US": str(a), "IN": str(b)}}
                h1 = bt.read_price_history(cfg, pd)
                self.assertEqual(sorted(h1["US"]), ["AAA", "BBB"])
                self.assertEqual(sorted(h1["IN"]), ["CCC.NS", "DDD.NS"])
                self.assertEqual(float(h1["US"]["BBB"]["h"].iloc[0]), 21.0)
                self.assertTrue(list((Path(d) / ".cache" / "prices").glob("US-*.pkl")))
                h2 = bt.read_price_history(cfg, pd)   # from the cache
                self.assertEqual(len(h2["US"]["AAA"]), 30)
            finally:
                bt.ROOT = old_root
