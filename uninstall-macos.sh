#!/usr/bin/env bash
# Remove always-on LaunchAgent (legacy) and the lifecycle launcher app.
set -euo pipefail

LABEL="com.openwhispr.deepinfra-voxtral-shim"
LAUNCHER_APP="$HOME/Applications/OpenWhispr + DeepInfra.app"
UID_NUM="$(id -u)"

launchctl bootout "gui/$UID_NUM/$LABEL" 2>/dev/null || true
rm -f "$HOME/Library/LaunchAgents/$LABEL.plist"
echo "Removed LaunchAgent $LABEL (if it existed)"

if [[ -d "$LAUNCHER_APP" ]]; then
  rm -rf "$LAUNCHER_APP"
  echo "Removed $LAUNCHER_APP"
fi

# Stop shim if we still own the port
if command -v lsof >/dev/null 2>&1; then
  pids="$(lsof -nP -iTCP:8765 -sTCP:LISTEN -t 2>/dev/null || true)"
  if [[ -n "${pids:-}" ]]; then
    # shellcheck disable=SC2086
    kill $pids 2>/dev/null || true
    echo "Stopped process(es) on :8765"
  fi
fi

echo "Done. Stock OpenWhispr.app is unchanged."
