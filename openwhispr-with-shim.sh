#!/usr/bin/env bash
# Start the DeepInfra Voxtral shim only while OpenWhispr is running.
# Cross-platform: macOS + Linux.
set -euo pipefail

ROOT="$(cd "$(dirname "$0")" && pwd)"
PORT="${SHIM_PORT:-8765}"
PID_FILE="${XDG_RUNTIME_DIR:-${TMPDIR:-/tmp}}/openwhispr-deepinfra-shim.pid"
LOG_DIR="$ROOT/logs"
LOG_FILE="$LOG_DIR/shim.log"
SHIM_JS="$ROOT/deepinfra-voxtral-shim.js"
OWNED_SHIM=0

mkdir -p "$LOG_DIR"

die() {
  echo "error: $*" >&2
  exit 1
}

require_files() {
  [[ -f "$SHIM_JS" ]] || die "missing $SHIM_JS"
  [[ -f "$ROOT/.env" ]] || die "missing $ROOT/.env — copy .env.example and set DEEPINFRA_TOKEN"
  command -v node >/dev/null || die "node not found (need Node.js 18+)"
  command -v ffmpeg >/dev/null || die "ffmpeg not found (e.g. brew install ffmpeg)"
}

port_in_use() {
  if command -v lsof >/dev/null 2>&1; then
    lsof -nP -iTCP:"$PORT" -sTCP:LISTEN >/dev/null 2>&1
  elif command -v ss >/dev/null 2>&1; then
    ss -ltn "sport = :$PORT" 2>/dev/null | grep -q LISTEN
  else
    return 1
  fi
}

openwhispr_running() {
  if [[ "$(uname -s)" == "Darwin" ]]; then
    pgrep -f '/OpenWhispr\.app/Contents/MacOS/OpenWhispr' >/dev/null 2>&1
  else
    pgrep -f '[Oo]pen[Ww]hispr' >/dev/null 2>&1
  fi
}

start_shim() {
  if port_in_use; then
    echo "Shim already listening on :$PORT — reusing it (will not stop it on exit)."
    OWNED_SHIM=0
    return
  fi

  echo "Starting DeepInfra shim on :$PORT ..."
  # shellcheck disable=SC2094
  nohup node "$SHIM_JS" >>"$LOG_FILE" 2>&1 &
  local pid=$!
  echo "$pid" >"$PID_FILE"
  OWNED_SHIM=1

  # Wait until port is open (or process dies)
  for _ in $(seq 1 50); do
    if port_in_use; then
      echo "Shim ready (pid $pid)."
      return
    fi
    if ! kill -0 "$pid" 2>/dev/null; then
      die "shim exited early — see $LOG_FILE"
    fi
    sleep 0.1
  done
  die "shim did not bind :$PORT in time — see $LOG_FILE"
}

stop_shim() {
  if [[ "$OWNED_SHIM" != "1" ]]; then
    return
  fi
  local pid=""
  if [[ -f "$PID_FILE" ]]; then
    pid="$(cat "$PID_FILE" 2>/dev/null || true)"
  fi
  if [[ -n "${pid:-}" ]] && kill -0 "$pid" 2>/dev/null; then
    echo "Stopping shim (pid $pid)..."
    kill "$pid" 2>/dev/null || true
    for _ in $(seq 1 30); do
      kill -0 "$pid" 2>/dev/null || break
      sleep 0.1
    done
    kill -9 "$pid" 2>/dev/null || true
  fi
  rm -f "$PID_FILE"
  OWNED_SHIM=0
}

launch_openwhispr() {
  if [[ "$(uname -s)" == "Darwin" ]]; then
    if [[ ! -d "/Applications/OpenWhispr.app" ]]; then
      die "OpenWhispr.app not found in /Applications"
    fi
    # -W: wait until the app quits. If already open, waits for that session.
    open -W -a OpenWhispr
    return
  fi

  # Linux: try common names / PATH
  local bin=""
  for candidate in openwhispr OpenWhispr open-whispr; do
    if command -v "$candidate" >/dev/null 2>&1; then
      bin="$(command -v "$candidate")"
      break
    fi
  done
  if [[ -z "$bin" ]]; then
    die "OpenWhispr binary not found on PATH (tried openwhispr, OpenWhispr, open-whispr)"
  fi
  "$bin" &
  local app_pid=$!
  wait "$app_pid" || true
}

cleanup() {
  stop_shim
}
trap cleanup EXIT INT TERM

require_files
start_shim
echo "Launching OpenWhispr (shim stays up until it quits)..."
launch_openwhispr
echo "OpenWhispr closed."
# trap runs stop_shim
