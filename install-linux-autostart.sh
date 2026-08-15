#!/usr/bin/env bash
# Login start: OpenWhispr + DeepInfra (shim + Caps Lock), not stock OpenWhispr.
#
# OpenWhispr's own "start on login" writes ~/.config/autostart/open-whispr.desktop
# and skips the shim. This removes that entry and installs ours instead.
# Leave the in-app toggle OFF — turning it on recreates the stock file.
set -euo pipefail

ROOT="$(cd "$(dirname "$0")" && pwd)"
AUTO="${XDG_CONFIG_HOME:-$HOME/.config}/autostart"
STOCK="$AUTO/open-whispr.desktop"
OURS="$AUTO/openwhispr-deepinfra.desktop"
WRAPPER="$ROOT/openwhispr-with-shim.sh"

if [[ ! -f "$ROOT/.env" ]]; then
  echo "Missing $ROOT/.env — copy .env.example and set DEEPINFRA_TOKEN"
  exit 1
fi

chmod 755 "$WRAPPER"
mkdir -p "$AUTO"

if [[ -f "$STOCK" ]]; then
  rm -f "$STOCK"
  echo "Removed stock OpenWhispr login item: $STOCK"
fi

# --hidden matches OpenWhispr's own autostart (tray, no control panel).
cat > "$OURS" <<EOF
[Desktop Entry]
Type=Application
Name=OpenWhispr + DeepInfra
Comment=OpenWhispr with DeepInfra shim (starts with session)
Exec=$WRAPPER --hidden
Path=$ROOT
Terminal=false
Icon=openwhispr
Categories=Utility;AudioVideo;
StartupNotify=false
X-GNOME-Autostart-enabled=true
X-KDE-autostart-phase=2
EOF
chmod 644 "$OURS"

echo "Installed login start:"
echo "  $OURS"
echo
echo "Leave OpenWhispr Settings → start on login OFF."
echo "Next login launches OpenWhispr + DeepInfra (shim + Caps Lock)."
