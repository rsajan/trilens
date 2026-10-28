"""Upload changes you made to the site or settings (for example a new ticker in config/watchlist.json)."""
from __future__ import annotations

import sys

from _util import ROOT, git, repo_slug, run, say


def main() -> int:
    if not (ROOT / ".git").exists():
        say("Run SETUP_ONCE.bat first.")
        return 1
    git("add", "-A")
    r = run([sys.executable, str(ROOT / "tools" / "safety_check.py")])
    say((r.stdout or "").strip())
    if r.returncode != 0:
        git("reset", "-q")
        return 1
    if not git("status", "--porcelain").stdout.strip():
        say("No changes to upload.")
        return 0
    git("commit", "-m", "Update settings")
    git("pull", "--rebase", "--autostash", "origin", "main")
    p = git("push", "origin", "HEAD:main")
    if p.returncode != 0:
        say("Upload failed:\n" + (p.stderr or p.stdout))
        return 1
    slug = repo_slug()
    say("Uploaded. The site updates in about a minute." + (f"\nhttps://{slug.split('/')[0]}.github.io/{slug.split('/')[1]}/" if slug else ""))
    return 0


if __name__ == "__main__":
    sys.exit(main())
