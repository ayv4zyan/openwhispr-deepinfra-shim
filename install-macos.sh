#!/usr/bin/env bash
# Install / reinstall the LaunchAgent so the shim starts at login.
set -euo pipefail

ROOT="$(cd "$(dirname "$0")" && pwd)"
LABEL="com.openwhispr.deepinfra-voxtral-shim"
PLIST_DIR="$HOME/Library/LaunchAgents"
PLIST="$PLIST_DIR/$LABEL.plist"
PYTHON3="$(command -v python3)"
FFMPEG_DIR="$(dirname "$(command -v ffmpeg)")"
LOG_DIR="$ROOT/logs"
mkdir -p "$LOG_DIR" "$PLIST_DIR"

if [[ ! -f "$ROOT/.env" ]]; then
  echo "Missing $ROOT/.env — copy .env.example and set DEEPINFRA_TOKEN"
  exit 1
fi

cat > "$PLIST" <<PLIST
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key>
  <string>$LABEL</string>
  <key>ProgramArguments</key>
  <array>
    <string>$PYTHON3</string>
    <string>$ROOT/deepinfra-voxtral-shim.py</string>
  </array>
  <key>EnvironmentVariables</key>
  <dict>
    <key>PATH</key>
    <string>$FFMPEG_DIR:/opt/homebrew/bin:/usr/local/bin:/usr/bin:/bin</string>
  </dict>
  <key>RunAtLoad</key>
  <true/>
  <key>KeepAlive</key>
  <true/>
  <key>StandardOutPath</key>
  <string>$LOG_DIR/shim.log</string>
  <key>StandardErrorPath</key>
  <string>$LOG_DIR/shim.log</string>
  <key>WorkingDirectory</key>
  <string>$ROOT</string>
</dict>
</plist>
PLIST

UID_NUM="$(id -u)"
launchctl bootout "gui/$UID_NUM/$LABEL" 2>/dev/null || true
launchctl bootstrap "gui/$UID_NUM" "$PLIST"
echo "Installed and started: $LABEL"
echo "  Script: $ROOT/deepinfra-voxtral-shim.py"
echo "  Logs:   $LOG_DIR/shim.log"
echo "  Port:   127.0.0.1:8765"
echo
echo "OpenWhispr custom STT base URL should be: http://localhost:8765"
