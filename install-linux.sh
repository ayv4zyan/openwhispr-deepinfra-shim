#!/usr/bin/env bash
# Install a .desktop launcher that starts the shim only while OpenWhispr runs.
set -euo pipefail

ROOT="$(cd "$(dirname "$0")" && pwd)"
APP_DIR="${XDG_DATA_HOME:-$HOME/.local/share}/applications"
DESKTOP="$APP_DIR/openwhispr-deepinfra.desktop"

if [[ ! -f "$ROOT/.env" ]]; then
  echo "Missing $ROOT/.env — copy .env.example and set DEEPINFRA_TOKEN"
  exit 1
fi

chmod 755 "$ROOT/openwhispr-with-shim.sh"
mkdir -p "$APP_DIR"

cat > "$DESKTOP" <<EOF
[Desktop Entry]
Type=Application
Name=OpenWhispr + DeepInfra
Comment=OpenWhispr with DeepInfra Voxtral STT shim
Exec=$ROOT/openwhispr-with-shim.sh
Path=$ROOT
Terminal=false
Categories=Utility;AudioVideo;
StartupNotify=true
EOF

chmod 644 "$DESKTOP"
if command -v update-desktop-database >/dev/null 2>&1; then
  update-desktop-database "$APP_DIR" 2>/dev/null || true
fi

echo "Installed Linux desktop entry:"
echo "  $DESKTOP"
echo
echo "Launch \"OpenWhispr + DeepInfra\" from your app menu."
echo "Shim starts with OpenWhispr and stops when it quits."
