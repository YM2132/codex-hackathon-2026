#!/usr/bin/env bash
# One-command start for Pawse: installs Python deps, asks for your OpenAI API key once
# (saved to .env, never into the extension), and runs the local backend on 127.0.0.1:8000.
set -euo pipefail
cd "$(dirname "$0")"

if ! command -v uv >/dev/null 2>&1; then
  echo "Pawse needs uv (Python package manager). Install it, then rerun ./start.sh:"
  echo "  macOS:   brew install uv"
  echo "  any OS:  https://docs.astral.sh/uv/getting-started/installation/"
  exit 1
fi

# API key: keep an existing .env, else use $OPENAI_API_KEY, else ask (input hidden).
if ! grep -qs '^OPENAI_API_KEY=.\+' .env; then
  key="${OPENAI_API_KEY:-}"
  if [ -z "$key" ]; then
    read -rsp "Paste your OpenAI API key (input hidden): " key; echo
  fi
  [ -n "$key" ] || { echo "No key given."; exit 1; }
  umask 077; printf 'OPENAI_API_KEY=%s\n' "$key" > .env
  echo "Saved key to .env (git-ignored, readable only by you)."
fi

echo "Installing backend dependencies…"
uv sync --quiet

if lsof -iTCP:8000 -sTCP:LISTEN >/dev/null 2>&1; then
  echo "Port 8000 is already in use (is Pawse already running?). Stop that process and retry."
  exit 1
fi

cat <<EOF

Backend starting on http://127.0.0.1:8000  (Ctrl+C to stop)

Load the extension once in Chrome:
  1. Open chrome://extensions and turn on Developer mode
  2. Click "Load unpacked" and choose: $(pwd)
  3. Pin Pawse, open it, pick the child's age and set a parent PIN
  4. Reload any video tab that was already open

EOF
exec uv run uvicorn backend.app:app --host 127.0.0.1 --port 8000
