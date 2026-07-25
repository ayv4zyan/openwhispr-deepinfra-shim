#!/usr/bin/env bash
# Install a macOS launcher app that starts the shim only while OpenWhispr runs.
# Also removes the old always-on LaunchAgent if present.
set -euo pipefail

ROOT="$(cd "$(dirname "$0")" && pwd)"
LABEL="com.openwhispr.deepinfra-voxtral-shim"
LAUNCHER_NAME="OpenWhispr + DeepInfra.app"
LAUNCHER_DIR="$HOME/Applications"
LAUNCHER_APP="$LAUNCHER_DIR/$LAUNCHER_NAME"
UID_NUM="$(id -u)"

if [[ ! -f "$ROOT/.env" ]]; then
  echo "Missing $ROOT/.env — copy .env.example and set DEEPINFRA_TOKEN"
  exit 1
fi

# 1) Tear down old always-on LaunchAgent (we do not want a permanent daemon)
launchctl bootout "gui/$UID_NUM/$LABEL" 2>/dev/null || true
rm -f "$HOME/Library/LaunchAgents/$LABEL.plist"

# Stop any orphan shim still bound to the port
if command -v lsof >/dev/null 2>&1; then
  pids="$(lsof -nP -iTCP:8765 -sTCP:LISTEN -t 2>/dev/null || true)"
  if [[ -n "${pids:-}" ]]; then
    echo "Stopping leftover process(es) on :8765: $pids"
    # shellcheck disable=SC2086
    kill $pids 2>/dev/null || true
    sleep 0.3
    # shellcheck disable=SC2086
    kill -9 $pids 2>/dev/null || true
  fi
fi

# 2) Build a minimal .app that runs openwhispr-with-shim.sh (no Terminal window)
mkdir -p "$LAUNCHER_APP/Contents/MacOS" "$LAUNCHER_APP/Contents/Resources"
chmod 755 "$ROOT/openwhispr-with-shim.sh"

cat > "$LAUNCHER_APP/Contents/Info.plist" <<PLIST
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>CFBundleName</key>
  <string>OpenWhispr + DeepInfra</string>
  <key>CFBundleDisplayName</key>
  <string>OpenWhispr + DeepInfra</string>
  <key>CFBundleIdentifier</key>
  <string>com.openwhispr.deepinfra-launcher</string>
  <key>CFBundleVersion</key>
  <string>1.0.0</string>
  <key>CFBundleShortVersionString</key>
  <string>1.0.0</string>
  <key>CFBundleExecutable</key>
  <string>launcher</string>
  <key>CFBundlePackageType</key>
  <string>APPL</string>
  <key>LSMinimumSystemVersion</key>
  <string>12.0</string>
  <key>LSUIElement</key>
  <true/>
  <key>NSHighResolutionCapable</key>
  <true/>
</dict>
</plist>
PLIST

# LSUIElement=true: no extra Dock icon; OpenWhispr is what you see.
cat > "$LAUNCHER_APP/Contents/MacOS/launcher" <<EOF
#!/bin/bash
exec "$ROOT/openwhispr-with-shim.sh"
EOF
chmod 755 "$LAUNCHER_APP/Contents/MacOS/launcher"

# Prefer OpenWhispr's icon if present
ICON_SRC="/Applications/OpenWhispr.app/Contents/Resources/icon.icns"
if [[ -f "$ICON_SRC" ]]; then
  cp "$ICON_SRC" "$LAUNCHER_APP/Contents/Resources/AppIcon.icns"
  /usr/libexec/PlistBuddy -c 'Add :CFBundleIconFile string AppIcon' \
    "$LAUNCHER_APP/Contents/Info.plist" 2>/dev/null \
    || /usr/libexec/PlistBuddy -c 'Set :CFBundleIconFile AppIcon' \
      "$LAUNCHER_APP/Contents/Info.plist" 2>/dev/null \
    || true
fi

# Refresh Launch Services so Spotlight/Dock see the app
if command -v lsregister >/dev/null 2>&1; then
  lsregister -f "$LAUNCHER_APP" 2>/dev/null || true
elif [[ -x /System/Library/Frameworks/CoreServices.framework/Frameworks/LaunchServices.framework/Support/lsregister ]]; then
  /System/Library/Frameworks/CoreServices.framework/Frameworks/LaunchServices.framework/Support/lsregister \
    -f "$LAUNCHER_APP" 2>/dev/null || true
fi

echo "Installed lifecycle launcher (no always-on daemon)."
echo
echo "  Launcher app: $LAUNCHER_APP"
echo "  Wrapper:      $ROOT/openwhispr-with-shim.sh"
echo "  Logs:         $ROOT/logs/shim.log"
echo
echo "How to use:"
echo "  1. Open \"OpenWhispr + DeepInfra\" from Spotlight or ~/Applications"
echo "  2. Shim starts → OpenWhispr opens → when you quit OpenWhispr, shim stops"
echo
echo "Optional: drag the launcher to your Dock and remove the stock OpenWhispr icon"
echo "so you always start through the wrapper."
echo
echo "OpenWhispr STT base URL stays: http://localhost:8765"
