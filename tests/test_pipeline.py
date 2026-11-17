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
