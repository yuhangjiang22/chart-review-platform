#!/usr/bin/env bash
# Stop the concur dev stack started by _dev-up.sh.
#     bash scripts/_dev-down.sh
for port in 3002 5174 18080 18090; do
  pids=$(lsof -ti tcp:$port 2>/dev/null || true)
  if [ -n "$pids" ]; then
    echo "  killing port $port (pid $pids)"; kill $pids 2>/dev/null || true
  else
    echo "  port $port already free"
  fi
done
