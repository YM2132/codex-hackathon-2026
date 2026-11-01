#!/usr/bin/env bash
set -euo pipefail
cd "$(dirname "$0")"
for candidate in python3 python; do
  if command -v "$candidate" >/dev/null 2>&1 && "$candidate" -c 'import sys; sys.exit(sys.version_info < (3,11))' 2>/dev/null; then
    exec "$candidate" start.py
  fi
done
echo "Install Python 3.11+ from https://www.python.org/downloads/ and rerun this launcher."
exit 1
