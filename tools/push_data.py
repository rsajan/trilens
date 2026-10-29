"""Backup route: fetch market data on THIS PC and upload it, in case Yahoo blocks GitHub's servers.
Run through REFRESH_MARKET_DATA_HERE.bat."""
from __future__ import annotations

import os
import shutil
import sys
import tempfile
from pathlib import Path

from _util import ROOT, git, have, read_local, repo_slug, run, say

sys.path.insert(0, str(ROOT))


def main() -> int:
    loc = read_local()
    if loc.get("sec_user_agent"):
        os.environ.setdefault("SEC_USER_AGENT", loc["sec_user_agent"])
    for k in ("REDDIT_CLIENT_ID", "REDDIT_CLIENT_SECRET", "YOUTUBE_API_KEY", "BSKY_HANDLE", "BSKY_APP_PASSWORD"):
        if loc.get(k):
            os.environ.setdefault(k, loc[k])
    from pipeline import run as pr

    args = [a for a in sys.argv[1:] if not a.startswith("/")]
    jobs = args[0] if args else "all"
    say(f"Fetching: {jobs}  (this takes a few minutes)")
    pr.main(["--jobs", jobs])
    slug = repo_slug()
    if not slug or not have("git"):
        say("Not connected to GitHub. Run SETUP_ONCE.bat first.")
        return 1
    url = f"https://github.com/{slug}.git"
    tmp = Path(tempfile.mkdtemp())
    shutil.copytree(ROOT / "data", tmp / "data", ignore=shutil.ignore_patterns("technical"))
    run(["git", "init", "-q", "-b", "data"], cwd=tmp)
    run(["git", "add", "-A"], cwd=tmp)
    run(["git", "-c", "user.name=trilens", "-c", "user.email=trilens@users.noreply.github.com", "commit", "-q", "-m", "data from PC"], cwd=tmp)
    p = run(["git", "push", "-q", "-f", url, "data"], cwd=tmp)
    if p.returncode != 0:
        say("Upload failed:\n" + (p.stderr or p.stdout))
        return 1
    if have("gh"):
        run(["gh", "workflow", "run", "site.yml", "-f", "jobs=none"])
    say("Uploaded. The site updates in about a minute.")
    shutil.rmtree(tmp, ignore_errors=True)
    return 0


if __name__ == "__main__":
    sys.exit(main())
