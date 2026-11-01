#!/usr/bin/env bash
cd "$(dirname "$0")"
bash start.sh
status=$?
if [ "$status" -ne 0 ]; then read -r -p "Press Return to close…"; fi
exit "$status"
