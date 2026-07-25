#!/usr/bin/env bash
set -euo pipefail
LABEL="com.openwhispr.deepinfra-voxtral-shim"
UID_NUM="$(id -u)"
launchctl bootout "gui/$UID_NUM/$LABEL" 2>/dev/null || true
rm -f "$HOME/Library/LaunchAgents/$LABEL.plist"
echo "Removed LaunchAgent $LABEL"
