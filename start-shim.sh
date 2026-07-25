#!/usr/bin/env bash
# Start the shim only (for when OpenWhispr is already open without it).
set -euo pipefail
ROOT="$(cd "$(dirname "$0")" && pwd)"
export PATH="/opt/homebrew/bin:/usr/local/bin:${PATH:-/usr/bin:/bin}"
PORT="${SHIM_PORT:-8765}"
LOG_DIR="$ROOT/logs"
mkdir -p "$LOG_DIR"

if lsof -nP -iTCP:"$PORT" -sTCP:LISTEN >/dev/null 2>&1; then
  echo "Shim already listening on :$PORT"
  curl -sS "http://127.0.0.1:$PORT/health" || true
  echo
  exit 0
fi

if [[ ! -f "$ROOT/.env" ]]; then
  echo "Missing $ROOT/.env"
  exit 1
fi

nohup node "$ROOT/deepinfra-voxtral-shim.js" >>"$LOG_DIR/shim.log" 2>&1 &
echo $! >"${XDG_RUNTIME_DIR:-${TMPDIR:-/tmp}}/openwhispr-deepinfra-shim.pid"
sleep 0.5
if lsof -nP -iTCP:"$PORT" -sTCP:LISTEN >/dev/null 2>&1; then
  echo "Shim started on :$PORT (pid $(cat "${XDG_RUNTIME_DIR:-${TMPDIR:-/tmp}}/openwhispr-deepinfra-shim.pid"))"
  curl -sS "http://127.0.0.1:$PORT/health"
  echo
else
  echo "Shim failed to start — see $LOG_DIR/shim.log"
  exit 1
fi
