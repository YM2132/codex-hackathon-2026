"""Start Pawse locally without Git, uv, Node or ffmpeg. Python 3.11+ required."""
from __future__ import annotations

import getpass
import hashlib
import json
import os
import re
from pathlib import Path
import socket
import subprocess
import sys
import urllib.request
import venv

ROOT = Path(__file__).resolve().parent
RUNTIME = ROOT / ".pawse-runtime"


def save_key(path: Path, key: str) -> None:
    """Update just the API key, preserving other .env settings."""
    if not key.strip() or any(c in key for c in "\r\n'\"\\") or key.strip() in {"sk-...", "your-key-here"}:
        raise ValueError("Enter an actual API key, not the example placeholder.")
    lines = path.read_text().splitlines() if path.exists() else []
    kept = [line for line in lines if not re.match(r"^\s*(?:export\s+)?OPENAI_API_KEY\s*=", line)]
    descriptor = os.open(path, os.O_CREAT | os.O_WRONLY | os.O_TRUNC, 0o600)
    if os.name != "nt":
        os.fchmod(descriptor, 0o600)
    with os.fdopen(descriptor, "w") as stream:
        stream.write("\n".join([*kept, f"OPENAI_API_KEY='{key.strip()}'"]) + "\n")


def existing_server() -> str | None:
    with socket.socket() as probe:
        if probe.connect_ex(("127.0.0.1", 8000)) != 0:
            return None
    try:
        with urllib.request.urlopen("http://127.0.0.1:8000/health", timeout=2) as response:
            health = json.load(response)
        if health.get("service") == "pawse" and health.get("ok"):
            return "Pawse is already running. Leave its terminal open and load the extension."
    except (OSError, ValueError):
        pass
    return "Port 8000 is occupied. Stop the previous backend (Ctrl+C in its terminal), then retry."


def prepare_runtime() -> Path:
    python = RUNTIME / ("Scripts/python.exe" if os.name == "nt" else "bin/python")
    usable = python.exists() and subprocess.run(
        [str(python), "-m", "pip", "--version"], stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL
    ).returncode == 0
    if not usable:
        print("Preparing Pawse’s local Python environment…", flush=True)
        venv.EnvBuilder(with_pip=True, symlinks=os.name != "nt", clear=True).create(RUNTIME)
    requirements = ROOT / "requirements-runtime.txt"
    digest = hashlib.sha256(requirements.read_bytes()).hexdigest()
    marker = RUNTIME / "requirements.sha256"
    if not marker.exists() or marker.read_text() != digest:
        print("Installing backend packages (first launch needs internet)…", flush=True)
        subprocess.run([str(python), "-m", "pip", "install", "--disable-pip-version-check", "-r", str(requirements)], check=True)
        marker.write_text(digest)
    return python


def main() -> int:
    if sys.version_info < (3, 11):
        print("Install Python 3.11 or newer from https://www.python.org/downloads/ and try again.")
        return 1
    os.chdir(ROOT)
    extension = ROOT / "extension" if (ROOT / "extension/manifest.json").exists() else ROOT
    print(f"\nPawse · hackathon setup\nChrome → chrome://extensions → Load unpacked → {extension}\n", flush=True)
    running = existing_server()
    if running:
        print(running)
        return 0 if running.startswith("Pawse is already") else 1
    python = prepare_runtime()
    check = subprocess.run([str(python), "-c", "from dotenv import load_dotenv; import os,sys; load_dotenv('.env'); k=os.getenv('OPENAI_API_KEY','').strip(); sys.exit(0 if k and k not in ('sk-...','your-key-here') else 1)"], check=False)
    if check.returncode:
        if not sys.stdin.isatty():
            print("Set OPENAI_API_KEY in .env or run this launcher from an interactive terminal.")
            return 1
        key = getpass.getpass("OpenAI API key with Decisions access (hidden): ").strip()
        save_key(ROOT / ".env", key)
        os.environ["OPENAI_API_KEY"] = key
        print("Saved locally to .env. The extension does not receive your key.")
    print("\nKeep this terminal open. Open Pawse, set an age and parent PIN, then refresh the video tab.\nCtrl+C stops the backend.\n", flush=True)
    return subprocess.call([str(python), "-m", "uvicorn", "backend.app:app", "--host", "127.0.0.1", "--port", "8000"])


if __name__ == "__main__":
    try:
        sys.exit(main())
    except KeyboardInterrupt:
        print("\nPawse backend stopped.")
    except (OSError, ValueError, subprocess.CalledProcessError) as exc:
        print(f"Setup could not finish: {exc}\nSee INSTALL.md for troubleshooting.", file=sys.stderr)
        sys.exit(1)
