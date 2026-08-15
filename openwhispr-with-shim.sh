#!/usr/bin/env bash
# Start the DeepInfra Voxtral shim only while OpenWhispr is running.
# Cross-platform: macOS + Linux.
#
# When launched from a .app / desktop entry, PATH is often just /usr/bin:/bin.
# Always prepend Homebrew and other common install locations.
set -euo pipefail

export PATH="/opt/homebrew/bin:/usr/local/bin:${PATH:-/usr/bin:/bin:/usr/sbin:/sbin}"

# Desktop launches often lack nvm/fnm on PATH — prepend known Node installs.
for _node_bin in \
  "$HOME/.local/share/nvm"/v*/bin \
  "$HOME/.nvm/versions/node"/v*/bin \
  "$HOME/.local/share/fnm/node-versions"/*/installation/bin \
  "$HOME/.fnm/node-versions"/*/installation/bin; do
  if [[ -d "$_node_bin" ]]; then
    PATH="$_node_bin:$PATH"
  fi
done
unset _node_bin
export PATH

ROOT="$(cd "$(dirname "$0")" && pwd)"
PORT="${SHIM_PORT:-8765}"
PID_FILE="${XDG_RUNTIME_DIR:-${TMPDIR:-/tmp}}/openwhispr-deepinfra-shim.pid"
LOG_DIR="$ROOT/logs"
LOG_FILE="$LOG_DIR/shim.log"
LAUNCH_LOG="$LOG_DIR/launcher.log"
SHIM_JS="$ROOT/deepinfra-voxtral-shim.js"
OWNED_SHIM=0
CAPS_OWNED=0

mkdir -p "$LOG_DIR"

# Mirror stdout/stderr to a log when not attached to a TTY (Finder / .app).
if [[ ! -t 1 ]]; then
  exec >>"$LAUNCH_LOG" 2>&1
fi

log() {
  echo "[$(date '+%Y-%m-%d %H:%M:%S')] $*"
}

notify_error() {
  local msg="$1"
  log "ERROR: $msg"
  if [[ "$(uname -s)" == "Darwin" ]] && command -v osascript >/dev/null 2>&1; then
    # Visible alert when started from the Dock/Spotlight (no Terminal).
    osascript -e "display alert \"OpenWhispr + DeepInfra\" message \"${msg//\"/\\\"}\" as critical" \
      >/dev/null 2>&1 || true
  fi
}

die() {
  notify_error "$*"
  exit 1
}

resolve_bin() {
  local name="$1"
  if command -v "$name" >/dev/null 2>&1; then
    command -v "$name"
    return
  fi
  local candidate
  for candidate in \
    "/opt/homebrew/bin/$name" \
    "/usr/local/bin/$name" \
    "/usr/bin/$name"; do
    if [[ -x "$candidate" ]]; then
      echo "$candidate"
      return
    fi
  done
  return 1
}

require_files() {
  [[ -f "$SHIM_JS" ]] || die "missing $SHIM_JS"
  [[ -f "$ROOT/.env" ]] || die "missing $ROOT/.env — copy .env.example and set DEEPINFRA_TOKEN"

  NODE_BIN="$(resolve_bin node)" || die "node not found. Install Node.js 18+ (e.g. brew install node)."
  FFMPEG_BIN="$(resolve_bin ffmpeg)" || die "ffmpeg not found. Install with: brew install ffmpeg"
  log "node=$NODE_BIN"
  log "ffmpeg=$FFMPEG_BIN"
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
  # macOS app process name
  pgrep -x OpenWhispr >/dev/null 2>&1 && return 0
  # Linux package / Electron binary names
  pgrep -x open-whispr >/dev/null 2>&1 && return 0
  pgrep -x openwhispr >/dev/null 2>&1 && return 0
  pgrep -f '/opt/openwhispr/open-whispr' >/dev/null 2>&1 && return 0
  return 1
}

shim_listener_pids() {
  local pids=""
  if command -v lsof >/dev/null 2>&1; then
    pids="$(lsof -t -nP -iTCP:"$PORT" -sTCP:LISTEN 2>/dev/null || true)"
  fi
  echo "$pids"
}

is_our_shim_pid() {
  local pid="$1"
  local cmd=""
  [[ -r "/proc/$pid/cmdline" ]] || return 1
  cmd="$(tr '\0' ' ' <"/proc/$pid/cmdline")"
  [[ "$cmd" == *deepinfra-voxtral-shim.js* ]]
}

start_shim() {
  local existing
  existing="$(shim_listener_pids)"
  if [[ -n "$existing" ]]; then
    log "Shim already listening on :$PORT (pid $existing) — taking it for this session."
    echo "$existing" >"$PID_FILE"
    OWNED_SHIM=1
    return
  fi

  log "Starting DeepInfra shim on :$PORT ..."
  nohup "$NODE_BIN" "$SHIM_JS" >>"$LOG_FILE" 2>&1 &
  local pid=$!
  echo "$pid" >"$PID_FILE"
  OWNED_SHIM=1

  for _ in $(seq 1 50); do
    if port_in_use; then
      log "Shim ready (pid $pid)."
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
  local pid=""
  if [[ -f "$PID_FILE" ]]; then
    pid="$(cat "$PID_FILE" 2>/dev/null || true)"
  fi
  if [[ -z "${pid:-}" ]]; then
    pid="$(shim_listener_pids)"
  fi

  local p
  for p in $pid; do
    if [[ -n "$p" ]] && kill -0 "$p" 2>/dev/null && is_our_shim_pid "$p"; then
      log "Stopping shim (pid $p)..."
      kill "$p" 2>/dev/null || true
      for _ in $(seq 1 30); do
        kill -0 "$p" 2>/dev/null || break
        sleep 0.1
      done
      kill -9 "$p" 2>/dev/null || true
    fi
  done
  rm -f "$PID_FILE"
  OWNED_SHIM=0
}

enable_caps_dictate() {
  [[ "$(uname -s)" == "Linux" ]] || return 0
  local helper="$ROOT/scripts/kde-caps-dictate.sh"
  [[ -x "$helper" ]] || return 0
  if "$helper" on; then
    CAPS_OWNED=1
    log "Caps Lock bound to OpenWhispr dictate."
  else
    log "Could not bind Caps Lock (non-fatal)."
  fi
}

disable_caps_dictate() {
  [[ "$CAPS_OWNED" == "1" ]] || return 0
  local helper="$ROOT/scripts/kde-caps-dictate.sh"
  if [[ -x "$helper" ]]; then
    "$helper" off || true
    log "Caps Lock released."
  fi
  CAPS_OWNED=0
}

launch_openwhispr() {
  if [[ "$(uname -s)" == "Darwin" ]]; then
    if [[ ! -d "/Applications/OpenWhispr.app" ]]; then
      die "OpenWhispr.app not found in /Applications"
    fi
    log "Opening OpenWhispr (waiting until it quits)..."
    # -W waits until the app quits. If already open, waits for that session.
    if (($#)); then
      open -W -a OpenWhispr --args "$@"
    else
      open -W -a OpenWhispr
    fi
    return
  fi

  local bin=""
  local candidate
  for candidate in openwhispr OpenWhispr open-whispr; do
    if bin="$(resolve_bin "$candidate" 2>/dev/null)"; then
      break
    fi
    bin=""
  done
  if [[ -z "$bin" ]]; then
    die "OpenWhispr binary not found on PATH (tried openwhispr, OpenWhispr, open-whispr)"
  fi
  log "Starting $bin $* ..."
  "$bin" "$@" &
  local app_pid=$!
  wait "$app_pid" || true
}

cleanup() {
  disable_caps_dictate
  stop_shim
  log "Done."
}
trap cleanup EXIT INT TERM

log "=== launch begin (PATH=$PATH) ==="
require_files

# If OpenWhispr is already open without a shim (stock app, or shim was killed),
# start the shim and wait for quit instead of launching a second instance.
if openwhispr_running; then
  log "OpenWhispr already running — ensuring shim is up and waiting for quit..."
  start_shim
  enable_caps_dictate
  while openwhispr_running; do sleep 1; done
  log "OpenWhispr closed."
  exit 0
fi

start_shim
enable_caps_dictate
log "Launching OpenWhispr (shim + Caps Lock stay up until it quits)..."
launch_openwhispr "$@"
log "OpenWhispr closed."
