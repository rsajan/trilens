"""Build the encrypted Technical page from your scanner folders and push it. Run through PUBLISH.bat."""
from __future__ import annotations

import sys

from _util import ROOT, git, have, read_local, repo_slug, run, say

sys.path.insert(0, str(ROOT))


def main() -> int:
    say("1/4  Reading your scanner folders and building the Technical page...")
    if not read_local().get("technical_password"):
        say("No password yet. Run SETUP_ONCE.bat first.")
        return 1
    from pipeline import build_technical

    if build_technical.main([]) != 0:
        return 1
    say("\n2/4  Safety check...")
    r = run([sys.executable, str(ROOT / "tools" / "safety_check.py")])
    say((r.stdout or "").strip())
    if r.returncode != 0:
        say("Nothing was uploaded.")
        return 1
    if not have("git") or not (ROOT / ".git").exists():
        say("\nThis folder is not connected to GitHub yet. Run SETUP_ONCE.bat first.")
        return 1
    say("\n3/4  Saving the encrypted file...")
    files = [f for f in ("data/technical/bundle.json", "data/technical/meta.json", "data/technical/public_signals.json") if (ROOT / f).exists()]
    git("add", "--", *files)
    gone = git("ls-files", "--deleted", "data/technical/public_signals.json").stdout.strip()
    if gone:
        git("add", "-A", "--", "data/technical/public_signals.json")
    st = git("status", "--porcelain", "--", "data/technical").stdout.strip()
    if not st:
        say("Nothing changed since the last publish.")
        return 0
    git("commit", "-m", "Update Technical page", "--", *files)
    say("\n4/4  Uploading...")
    git("pull", "--rebase", "--autostash", "origin", "main")
    p = git("push", "origin", "HEAD:main")
    if p.returncode != 0:
        say("Upload failed:\n" + (p.stderr or p.stdout))
        return 1
    slug = repo_slug()
    say("\nDone. GitHub rebuilds the site in about a minute." + (f"\nSite: https://{slug.split('/')[0]}.github.io/{slug.split('/')[1]}/" if slug else ""))
    return 0


if __name__ == "__main__":
    sys.exit(main())
