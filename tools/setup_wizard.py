"""One-time setup. Safe to run again: it only fills in what is missing.

Does, in order:
  1. checks git and the GitHub command line tool (gh) are installed and signed in
  2. asks for the Technical page password and your SEC contact (saved only on this PC)
  3. creates the GitHub repository, turns on GitHub Pages, stores the secrets
  4. builds and uploads the encrypted Technical page
  5. starts the first data refresh and prints your phone address
"""
from __future__ import annotations

import json
import re
import secrets
import sys
import time

from _util import ROOT, ask, git, have, read_local, repo_slug, run, say, write_local, yes

WORDS = ("harbour anchor lantern copper maple cobalt tundra violet ember saffron meadow quartz falcon juniper marble orchid pepper "
         "raven summit thistle willow zephyr amber basil cedar delta fjord garnet heron ivory kestrel lagoon mosaic nectar onyx").split()


def passphrase() -> str:
    return "-".join(secrets.choice(WORDS) for _ in range(4)) + "-" + str(secrets.randbelow(90) + 10)


def step(n: int, title: str) -> None:
    say(f"\n[{n}] {title}")


def need_tools() -> bool:
    ok = True
    if not have("git"):
        say("Git is not installed. Install it from https://git-scm.com/download/win (accept the defaults), then run this again.")
        ok = False
    if not have("gh"):
        say("The GitHub command line tool is not installed. In a new Command Prompt run:  winget install --id GitHub.cli")
        say("Then close and reopen this window, and run this setup again.")
        ok = False
    return ok


def main() -> int:
    say("Trilens setup\n=============")
    if not need_tools():
        return 1
    step(1, "Sign in to GitHub")
    if run(["gh", "auth", "status"]).returncode != 0:
        say("A browser window will open. Sign in with your GitHub account (it is free to create one at github.com) and approve the request.")
        if run(["gh", "auth", "login", "--hostname", "github.com", "--git-protocol", "https", "--web"], capture=False).returncode != 0:
            say("Sign-in did not finish. Run this setup again.")
            return 1
    run(["gh", "auth", "setup-git"])
    user = run(["gh", "api", "user", "--jq", ".login"]).stdout.strip()
    if not user:
        say("Could not read your GitHub name. Run:  gh auth login")
        return 1
    say(f"Signed in as {user}.")

    loc = read_local()
    step(2, "Your private settings (saved only on this PC)")
    if not loc.get("technical_password"):
        say("The Technical page holds your strategies. It is encrypted, and this password is the only key.")
        say("Press Enter to get a generated passphrase (easy to type on a phone), or type your own (at least 10 characters).")
        while True:
            pw = ask("Technical page password", "")
            if not pw:
                pw = passphrase()
                say(f"\n  Your password is:  {pw}\n  Write it down or save it in a password manager now. It cannot be recovered.\n")
                input("  Press Enter once you have saved it...")
                break
            if len(pw) < 10:
                say("Please use at least 10 characters.")
                continue
            if ask("Type it again", "", secret=True) != pw:
                say("They did not match. Try again.")
                continue
            break
        loc["technical_password"] = pw
    if not loc.get("sec_user_agent"):
        say("\nThe US government's EDGAR site (insider trades, filings) asks every visitor to give a name and email.")
        who = ask("Your name and email, for example  Jane Doe jane@example.com", "")
        if "@" in who:
            loc["sec_user_agent"] = who
    write_local(loc)

    cfg_path = ROOT / "config" / "technical_sources.json"
    cfg = json.loads(cfg_path.read_text(encoding="utf-8"))
    if "publish_public_signals" not in loc:
        say("\nOptional: let the public Fundamentals page show a small badge on tickers your scanners flag (symbols and BUY or WATCH only).")
        loc["publish_public_signals"] = yes("Show the badges?", False)
        write_local(loc)
    cfg["publish_public_signals"] = bool(loc.get("publish_public_signals"))
    cfg_path.write_text(json.dumps(cfg, indent=2), encoding="utf-8")

    step(3, "Create the GitHub repository and website")
    if not (ROOT / ".git").exists():
        git("init", "-q", "-b", "main", check=True)
    git("config", "user.name", user)
    git("config", "user.email", f"{user}@users.noreply.github.com")
    slug = repo_slug()
    if not slug:
        name = ask("Repository name", "trilens")
        slug = f"{user}/{name}"
        git("add", "-A")
        git("commit", "-q", "-m", "Trilens")
        r = run(["gh", "repo", "create", slug, "--public", "--source", ".", "--remote", "origin", "--push", "--description", "Personal market desk"])
        if r.returncode != 0 and "already exists" in (r.stderr or ""):
            git("remote", "add", "origin", f"https://github.com/{slug}.git")
            r = git("push", "-u", "origin", "HEAD:main", "--force-with-lease")
        if r.returncode != 0:
            say("Could not create the repository:\n" + (r.stderr or r.stdout))
            return 1
    else:
        say(f"Using the repository {slug}.")
    pages = run(["gh", "api", "-X", "POST", f"repos/{slug}/pages", "-f", "build_type=workflow"])
    if pages.returncode != 0:
        run(["gh", "api", "-X", "PUT", f"repos/{slug}/pages", "-f", "build_type=workflow"])
    if loc.get("sec_user_agent"):
        run(["gh", "secret", "set", "SEC_USER_AGENT", "--repo", slug], input_text=loc["sec_user_agent"])
    for k in ("REDDIT_CLIENT_ID", "REDDIT_CLIENT_SECRET", "YOUTUBE_API_KEY", "BSKY_HANDLE", "BSKY_APP_PASSWORD"):
        if loc.get(k):
            run(["gh", "secret", "set", k, "--repo", slug], input_text=loc[k])
    say("Repository ready and GitHub Pages is on.")

    step(4, "Build and upload the encrypted Technical page")
    r = run([sys.executable, str(ROOT / "tools" / "publish.py")], capture=False)
    if r.returncode != 0:
        say("The Technical page was not uploaded. Check the message above, then run PUBLISH.bat.")

    step(5, "Start the first data refresh")
    time.sleep(3)
    run(["gh", "workflow", "run", "site.yml", "--repo", slug, "-f", "jobs=all"])
    owner, repo = slug.split("/")
    url = f"https://{owner}.github.io/{repo}/"
    say(f"""
All set.

  Your site:   {url}
  Progress:    https://github.com/{slug}/actions   (the first run takes about 10 minutes)

On your Android phone:
  1. Open Chrome and go to {url}
  2. Tap the three dots, then "Add to Home screen" (or "Install app").
  3. Open Technical and enter your password once. Tick "Remember on this device".

Every day after this, GitHub refreshes prices, filings and sentiment by itself.
Run PUBLISH.bat after your scans finish, or SCHEDULE_PUBLISH.bat once to do that automatically.
""")
    return 0


if __name__ == "__main__":
    try:
        sys.exit(main())
    except KeyboardInterrupt:
        say("\nStopped.")
        sys.exit(1)
