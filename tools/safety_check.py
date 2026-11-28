"""Refuses to let anything private reach GitHub. Run automatically by PUBLISH.bat."""
from __future__ import annotations

import json
import sys

from _util import ROOT, git, say

BLOCKED_PREFIXES = ("config/local.json", "technical_uploads/", "data/technical/bundle.local.json", "data/technical/prices.local.json", ".cache/")


def check() -> list[str]:
    problems = []
    tracked = git("ls-files").stdout.split("\n") if (ROOT / ".git").exists() else []
    for f in tracked:
        f = f.strip().replace("\\", "/")
        if f.startswith(BLOCKED_PREFIXES) and f != "technical_uploads/README.txt":
            problems.append(f"{f} is tracked by git and would be published")
    b = ROOT / "data" / "technical" / "bundle.json"
    if b.exists():
        try:
            env = json.loads(b.read_text(encoding="utf-8"))
        except Exception:
            problems.append("data/technical/bundle.json is not valid JSON")
        else:
            if env.get("enc") is not True or not env.get("data") or "strategies" in env or "signals" in env:
                problems.append("data/technical/bundle.json is NOT encrypted")
            elif env.get("iter", 0) < 100000:
                problems.append("bundle.json uses too few key-stretching rounds")
    tech = ROOT / "data" / "technical"
    for pr in [tech / "prices.json", *sorted((tech / "prices").glob("*"))]:
        if not pr.is_file():
            continue
        rel = pr.relative_to(ROOT).as_posix()
        try:
            env = json.loads(pr.read_text(encoding="utf-8"))
        except Exception:
            problems.append(f"{rel} is not valid JSON")
            continue
        if not isinstance(env, dict) or env.get("enc") is not True or not env.get("data") or "markets" in env or "series" in env:
            problems.append(f"{rel} is NOT encrypted")
        elif env.get("iter", 0) < 100000:
            problems.append(f"{rel} uses too few key-stretching rounds")
    return problems


if __name__ == "__main__":
    p = check()
    for x in p:
        say("STOP: " + x)
    if not p:
        say("Safety check passed: the Technical page and stock prices are encrypted and nothing private is tracked.")
    sys.exit(1 if p else 0)
