#!/bin/bash
# TeleGift Glance — one command, auto-update like TeleFeed.
#   ./dev.sh   starts the backend (:8090), the glasses app (Vite :5173) and the Even Hub simulator,
#              then checks GitHub every 3 s and installs updates by itself:
#              backend/ changed     → backend restarts
#              app/package.json     → npm install + app restarts
#              app/ code            → the app reloads in the simulator by itself (Vite)
#   The backend lives on the TeleFeed server (https://g2.77-216-135-201.sslip.io) — the app talks to it.
#   LOCAL_BACKEND=1 ./dev.sh — run the backend on this Mac instead (+ cloudflared tunnel, if ./cloudflared is here).
# Before starting, it stops anything left over from earlier runs. Ctrl+C stops everything.
cd "$(dirname "$0")" || exit 1
ROOT=$(pwd)
PY="${PYTHON:-$HOME/TeleFeed/.venv/bin/python}"
[ -x "$PY" ] || PY=python3
BRANCH=$(git rev-parse --abbrev-ref HEAD)
BACK="" APP="" SIM="" CF=""
API="${G2_API:-https://g2.77-216-135-201.sslip.io}"
[ "${LOCAL_BACKEND:-}" = 1 ] && API=http://localhost:8090

log() { echo "$(date +%H:%M:%S) $*"; }
start_back() { [ "${LOCAL_BACKEND:-}" = 1 ] || return; (cd "$ROOT/backend" && exec "$PY" server.py) & BACK=$!; }
start_app()  { (cd "$ROOT/app" && VITE_API="$API" exec npx vite --clearScreen false) & APP=$!; }
start_sim()  { [ "${NO_SIM:-}" = 1 ] && return; (cd "$ROOT/app" && sleep 3 && exec npx evenhub-simulator http://localhost:5173 --automation-port 9898) & SIM=$!; }
start_cf() {
  [ "${LOCAL_BACKEND:-}" = 1 ] || return
  [ -x "$ROOT/cloudflared" ] || return
  "$ROOT/cloudflared" tunnel --url http://localhost:8090 > "$ROOT/cloudflared.log" 2>&1 & CF=$!
  for _ in $(seq 1 30); do
    URL=$(grep -o 'https://[a-z0-9-]*\.trycloudflare\.com' "$ROOT/cloudflared.log" | head -1)
    [ -n "$URL" ] && break; sleep 1
  done
  if [ -n "$URL" ]; then
    echo "$URL" > "$ROOT/tunnel.txt"
    log "PUBLIC ADDRESS: $URL"
  else
    log "cloudflared: no address yet — see cloudflared.log"
  fi
}
cleanup_old() {
  for port in 8090 5173; do lsof -ti tcp:$port 2>/dev/null | xargs kill 2>/dev/null; done
  pkill -f evenhub-simulator 2>/dev/null
  pkill -f "cloudflared tunnel" 2>/dev/null
  sleep 1
}
kill_tree()  { [ -n "$1" ] && pkill -P "$1" 2>/dev/null; [ -n "$1" ] && kill "$1" 2>/dev/null; }
stop_all()   { kill_tree "$CF"; kill_tree "$SIM"; kill_tree "$APP"; kill_tree "$BACK"; wait 2>/dev/null; }
trap 'log "stopping"; stop_all; exit 0' INT TERM

[ -d app/node_modules ] || (cd app && npm install --silent)
cleanup_old
start_back; start_app; start_sim; start_cf
log "backend: $API"
log "TeleGift Glance running · auto-update from GitHub every 3 s ($BRANCH)"

while true; do
  sleep 3
  REMOTE=$(git ls-remote origin "refs/heads/$BRANCH" 2>/dev/null | cut -f1)
  LOCAL=$(git rev-parse HEAD)
  if [ -n "$REMOTE" ] && [ "$REMOTE" != "$LOCAL" ]; then
    if git pull -q --ff-only 2>/dev/null; then
      NEW=$(git rev-parse HEAD)
      log "update: $(git log -1 --format=%s)"
      if ! git diff --quiet "$LOCAL" "$NEW" -- backend; then
        log "backend changed — restarting"; kill_tree "$BACK"; wait "$BACK" 2>/dev/null; start_back
      fi
      if ! git diff --quiet "$LOCAL" "$NEW" -- app/package.json app/package-lock.json app/vite.config.ts app/.env.production; then
        log "app settings changed — npm install + restart"; kill_tree "$APP"; wait "$APP" 2>/dev/null
        (cd app && npm install --silent); start_app
      fi
    else
      log "update failed (local changes?) — run: git status"
    fi
  fi
  [ "${LOCAL_BACKEND:-}" = 1 ] && ! kill -0 "$BACK" 2>/dev/null && { log "backend stopped — starting again"; start_back; }
  kill -0 "$APP" 2>/dev/null || { log "app stopped — starting again"; start_app; }
  pgrep -f evenhub-simulator >/dev/null || { [ "${NO_SIM:-}" = 1 ] || { log "simulator closed — opening again"; start_sim; }; }
done
