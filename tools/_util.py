"""Small helpers shared by the setup and publish tools."""
from __future__ import annotations

import json
import shutil
import subprocess
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
LOCAL = ROOT / "config" / "local.json"


def read_local() -> dict:
    try:
        return json.loads(LOCAL.read_text(encoding="utf-8"))
    except Exception:
        return {}


def write_local(d: dict) -> None:
    LOCAL.parent.mkdir(parents=True, exist_ok=True)
    LOCAL.write_text(json.dumps(d, indent=2), encoding="utf-8")


def run(cmd: list[str], check: bool = False, capture: bool = True, cwd: Path | None = None, input_text: str | None = None):
    """Run a command; never raises unless check=True. Returns CompletedProcess (stdout/stderr as text)."""
    try:
        r = subprocess.run(cmd, cwd=str(cwd or ROOT), text=True, capture_output=capture, input=input_text, encoding="utf-8", errors="replace")
    except FileNotFoundError:
        r = subprocess.CompletedProcess(cmd, 127, "", f"{cmd[0]} not found")
    if check and r.returncode != 0:
        raise SystemExit(f"Command failed: {' '.join(cmd)}\n{(r.stderr or r.stdout or '').strip()}")
    return r


def have(tool: str) -> bool:
    return shutil.which(tool) is not None


def git(*args: str, check: bool = False):
    return run(["git", *args], check=check)


def say(msg: str = "") -> None:
    print(msg, flush=True)


def ask(prompt: str, default: str = "", secret: bool = False) -> str:
    import getpass

    suffix = f" [{default}]" if default else ""
    s = (getpass.getpass if secret else input)(f"{prompt}{suffix}: ").strip()
    return s or default


def yes(prompt: str, default: bool = False) -> bool:
    d = "Y/n" if default else "y/N"
    s = input(f"{prompt} ({d}): ").strip().lower()
    return default if not s else s.startswith("y")


def repo_slug() -> str | None:
    r = git("remote", "get-url", "origin")
    if r.returncode != 0:
        return None
    url = r.stdout.strip()
    for p in ("https://github.com/", "git@github.com:"):
        if url.startswith(p):
            return url[len(p):].removesuffix(".git")
    return None
