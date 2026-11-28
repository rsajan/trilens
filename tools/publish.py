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
    # get the latest Trilens code first, so this run already uses it
    if have("git") and (ROOT / ".git").exists():
        p = git("pull", "--rebase", "--autostash", "origin", "main")
        if p.returncode != 0:
            say("Could not download the latest Trilens code (continuing with what is here):\n" + (p.stderr or p.stdout).strip())
            if "ermission denied" in (p.stderr or "") + (p.stdout or ""):
                say('Windows is blocking writes to the hidden .git folder, so the upload will fail too. Fix it once in Command Prompt:\n  cd /d "%s"\n  icacls .git /grant "%%USERNAME%%":(OI)(CI)F /T /Q' % ROOT)
                return 1
            git("rebase", "--abort")
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
    files = [f for f in ("data/technical/bundle.json", "data/technical/prices.json", "data/technical/meta.json", "data/technical/public_signals.json") if (ROOT / f).exists()]
    git("add", "--", *files)
    if (ROOT / "data" / "technical" / "prices").exists() or git("ls-files", "data/technical/prices").stdout.strip():
        git("add", "-A", "--", "data/technical/prices")   # new, changed and removed history pieces
        files.append("data/technical/prices")
    gone = git("ls-files", "--deleted", "data/technical/public_signals.json").stdout.strip()
    if gone:
        git("add", "-A", "--", "data/technical/public_signals.json")
    st = git("status", "--porcelain", "--", "data/technical").stdout.strip()
    if not st:
        say("Nothing changed since the last publish.")
        return 0
    c = git("commit", "-m", "Update Technical page", "--", *files)
    if c.returncode != 0:
        say("Could not save the new files in this folder's history, so nothing was uploaded:\n" + (c.stderr or c.stdout).strip())
        if "ermission denied" in (c.stderr or "") + (c.stdout or ""):
            say('Windows is blocking writes to the hidden .git folder. Fix it once in Command Prompt:\n  cd /d "%s"\n  icacls .git /grant "%%USERNAME%%":(OI)(CI)F /T /Q' % ROOT)
        return 1
    say("\n4/4  Uploading...")
    pl = git("pull", "--rebase", "--autostash", "origin", "main")
    if pl.returncode != 0:
        say("Could not merge the latest GitHub changes before uploading:\n" + (pl.stderr or pl.stdout).strip())
        git("rebase", "--abort")
        return 1
    p = git("push", "origin", "HEAD:main")
    if p.returncode != 0:
        say("Upload failed:\n" + (p.stderr or p.stdout))
        return 1
    # confirm GitHub really has this commit, so "Done" is never shown for an upload that did not happen
    git("fetch", "origin", "main")
    ahead = git("rev-list", "--count", "origin/main..HEAD").stdout.strip()
    if ahead not in ("", "0"):
        say(f"Upload did not complete: {ahead} saved update(s) are still only on this PC. Run PUBLISH again; if it repeats, send this message.")
        return 1
    slug = repo_slug()
    say("\nDone. GitHub rebuilds the site in about a minute." + (f"\nSite: https://{slug.split('/')[0]}.github.io/{slug.split('/')[1]}/" if slug else ""))
    return 0


if __name__ == "__main__":
    sys.exit(main())
