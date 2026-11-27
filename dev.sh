#!/bin/bash
# TeleGift Glance: run the backend and keep it up to date with GitHub.
# Every 15 s: git pull; if backend/ changed — restart the backend.
# The glasses app (npm run dev) reloads app/ changes by itself.
cd "$(dirname "$0")" || exit 1
PY="${PYTHON:-$HOME/TeleFeed/.venv/bin/python}"
[ -x "$PY" ] || PY=python3
PID=""

start() {
  (cd backend && exec "$PY" server.py) &
  PID=$!
}
stop() { [ -n "$PID" ] && kill "$PID" 2>/dev/null; wait "$PID" 2>/dev/null; PID=""; }
trap 'stop; exit 0' INT TERM

start
while true; do
  sleep 15
  OLD=$(git rev-parse HEAD)
  git pull -q --ff-only 2>/dev/null || continue
  NEW=$(git rev-parse HEAD)
  if [ "$OLD" != "$NEW" ]; then
    echo "$(date +%H:%M:%S) update: $(git log -1 --format=%s)"
    if ! git diff --quiet "$OLD" "$NEW" -- backend; then
      echo "$(date +%H:%M:%S) backend changed — restarting"
      stop; start
    fi
  fi
  kill -0 "$PID" 2>/dev/null || { echo "$(date +%H:%M:%S) backend stopped — starting again"; start; }
done
