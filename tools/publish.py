"""Build the encrypted Technical page from your scanner folders and push it. Run through PUBLISH.bat."""
from __future__ import annotations

import sys

from _util import ROOT, git, have, read_local, repo_slug, run, say

sys.path.insert(0, str(ROOT))


def backup_copy() -> None:
    """Also send what was just published to your private backup repository (config
    "backup_remote"), on its own branch (config "backup_branch", default "latest"), so the backup's
    main branch and anything you uploaded there are never touched, and nothing from the backup can
    flow back into the public repository. A failure here never stops the publish."""
    import json
    import os
    import subprocess

    try:
        cfg = json.loads((ROOT / "config" / "technical_sources.json").read_text(encoding="utf-8"))
    except Exception:
        return
    url, branch = cfg.get("backup_remote"), cfg.get("backup_branch") or "latest"
    if not url or not str(url).startswith(("https://", "file://")):
        return
    quiet = "/quiet" in sys.argv
    say("\nBackup  Copying to your private backup repository...")
    env = dict(os.environ)
    if quiet:  # scheduled run: nobody can answer a sign-in window, so fail instead of waiting
        env.update(GIT_TERMINAL_PROMPT="0", GCM_INTERACTIVE="never")
    for force in (False, True):  # the branch only ever mirrors what PUBLISH sent; replace it if it differs
        try:
            r = subprocess.run(["git", "push", *(["--force"] if force else []), url, f"HEAD:refs/heads/{branch}"], cwd=str(ROOT),
                               text=True, capture_output=True, encoding="utf-8", errors="replace", env=env, timeout=600)
        except subprocess.TimeoutExpired:
            say("Backup copy skipped: GitHub did not answer within 10 minutes. The site itself was published.")
            return
        if r.returncode == 0:
            say(f"Backup copy updated (branch {branch}).")
            return
        if "rejected" not in (r.stderr or ""):
            break
    msg = (r.stderr or r.stdout or "").strip().splitlines()[-1:] or [""]
    if quiet:
        say("Backup copy skipped (sign-in needed or not allowed). Run PUBLISH.bat by hand once and sign in to the backup account. " + msg[0])
    else:
        say("Backup copy failed (the site itself was published): " + msg[0] + "\nIf a sign-in window appeared, sign in to the backup account and run PUBLISH again.")


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
    backup_copy()
    slug = repo_slug()
    say("\nDone. GitHub rebuilds the site in about a minute." + (f"\nSite: https://{slug.split('/')[0]}.github.io/{slug.split('/')[1]}/" if slug else ""))
    return 0


if __name__ == "__main__":
    sys.exit(main())
