#!/usr/bin/env bash
# One-shot setup on a new Mac after cloning this repo.
set -euo pipefail

ROOT="$(cd "$(dirname "$0")" && pwd)"
cd "$ROOT"

echo "==> OpenWhispr ↔ DeepInfra shim — macOS setup"
echo "    Project: $ROOT"
echo

need() {
  if ! command -v "$1" >/dev/null 2>&1; then
    echo "Missing: $1"
    echo "  $2"
    exit 1
  fi
}

# --- prerequisites (cannot live inside the repo) ---
need node "Install Node.js 18+ (e.g. brew install node)"
need ffmpeg "Install ffmpeg (e.g. brew install ffmpeg)"
need npm "Install npm (comes with Node.js)"

NODE_MAJOR="$(node -p "process.versions.node.split('.')[0]")"
if [[ "$NODE_MAJOR" -lt 18 ]]; then
  echo "Need Node.js 18+, found $(node -v)"
  exit 1
fi

if [[ ! -d "/Applications/OpenWhispr.app" ]]; then
  echo "OpenWhispr.app not found in /Applications."
  echo "  Install from https://openwhispr.com (or GitHub releases), then re-run:"
  echo "  $0"
  exit 1
fi

# --- secrets ---
if [[ ! -f "$ROOT/.env" ]]; then
  cp "$ROOT/.env.example" "$ROOT/.env"
  chmod 600 "$ROOT/.env"
  echo "Created .env from .env.example"
  echo
  echo "Edit .env and set DEEPINFRA_TOKEN, then re-run:"
  echo "  $0"
  echo
  echo "Token: https://deepinfra.com/dash/api_keys"
  if command -v open >/dev/null 2>&1; then
    open -e "$ROOT/.env" 2>/dev/null || true
  fi
  exit 2
fi

if ! grep -qE '^DEEPINFRA_TOKEN=.+' "$ROOT/.env" || grep -qE '^DEEPINFRA_TOKEN=your_deepinfra' "$ROOT/.env"; then
  echo "DEEPINFRA_TOKEN is missing or still a placeholder in .env"
  echo "  Edit $ROOT/.env and re-run: $0"
  exit 2
fi

chmod 755 \
  "$ROOT/openwhispr-with-shim.sh" \
  "$ROOT/deepinfra-voxtral-shim.js" \
  "$ROOT/install-macos.sh" \
  "$ROOT/uninstall-macos.sh" \
  "$ROOT/apply-openwhispr-settings.sh" \
  "$ROOT/apply-openwhispr-settings.mjs" \
  "$ROOT/setup-macos.sh" 2>/dev/null || true

# --- launcher app ---
echo "==> Installing lifecycle launcher"
"$ROOT/install-macos.sh"
echo

# --- OpenWhispr settings ---
OW_LEVELDB="$HOME/Library/Application Support/open-whispr/Local Storage/leveldb"
if [[ ! -d "$OW_LEVELDB" ]]; then
  echo "==> OpenWhispr has never been launched on this Mac (no settings DB yet)."
  echo "    1. Open stock OpenWhispr once (finish any first-run screens)."
  echo "    2. Quit OpenWhispr completely."
  echo "    3. Run:  $ROOT/apply-openwhispr-settings.sh"
  echo "    4. Day-to-day: open \"OpenWhispr + DeepInfra\" from Spotlight / ~/Applications"
  echo
  echo "Partial setup complete (launcher + .env). Settings still need step 3."
  exit 0
fi

if pgrep -x OpenWhispr >/dev/null 2>&1; then
  echo "==> OpenWhispr is running — quit it so settings can be written."
  echo "    Then run:  $ROOT/apply-openwhispr-settings.sh"
  exit 0
fi

echo "==> Applying OpenWhispr STT + cleanup settings"
if ! node "$ROOT/apply-openwhispr-settings.mjs"; then
  echo "Settings apply failed. You can set them manually (see README)."
  exit 1
fi

echo
echo "==> Setup complete"
echo
echo "Daily use:"
echo "  Open \"OpenWhispr + DeepInfra\" (not stock OpenWhispr in /Applications)"
echo
echo "Stack:"
echo "  STT:     mistralai/Voxtral-Mini-3B-2507  via localhost:8765"
echo "  Cleanup: google/gemma-4-E4B-it            via localhost:8765"
echo "  Token:   $ROOT/.env"
echo
echo "Logs: $ROOT/logs/"
