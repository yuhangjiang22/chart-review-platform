#!/usr/bin/env bash
# Start the concur dev stack detached, so it survives independently of any
# agent turn / terminal session. Run this in YOUR OWN terminal:
#     bash scripts/_dev-up.sh
# Logs go to var/dev-logs/. Stop everything with: bash scripts/_dev-down.sh
set -euo pipefail
ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$ROOT"
LOG="$ROOT/var/dev-logs"; mkdir -p "$LOG"

start() { # name  logfile  cmd...
  local name="$1" logf="$2"; shift 2
  nohup "$@" >"$LOG/$logf" 2>&1 &
  echo "  started $name (pid $!) → $LOG/$logf"
}

echo "Starting concur dev stack (detached)…"
start "API :3002"   api.log   node node_modules/tsx/dist/cli.mjs watch server/index.ts
start "Vite :5174"  vite.log  node node_modules/vite/dist/node/cli.js --config config/vite.config.ts
( cd "$ROOT/vendor/bso-ad-sdk" && \
  nohup env -u ANTHROPIC_API_KEY .venv/bin/uvicorn claude_proxy.proxy:app --host 127.0.0.1 --port 18080 \
    >"$LOG/proxy.log" 2>&1 & echo "  started proxy :18080 (pid $!) → $LOG/proxy.log" )

echo "Waiting for ports…"
for i in $(seq 1 40); do
  a=$(curl -s -o /dev/null -w '%{http_code}' http://127.0.0.1:3002/api/v2/healthz 2>/dev/null || echo 000)
  v=$(curl -s -o /dev/null -w '%{http_code}' http://127.0.0.1:5174/ 2>/dev/null || echo 000)
  p=$(curl -s -o /dev/null -w '%{http_code}' http://127.0.0.1:18080/ 2>/dev/null || echo 000)
  [ "$a" = 200 ] && [ "$v" = 200 ] && [ "$p" != 000 ] && break
  sleep 1
done
echo "  API:$a  Vite:$v  proxy:$p"
echo "Open http://localhost:5174   (workbench :18090 auto-starts on VALIDATE)"
