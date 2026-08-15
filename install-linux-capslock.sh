#!/usr/bin/env bash
# Install the Caps Lock → dictate helper for KDE Plasma 6 (Wayland).
#
# Does not grab Caps Lock permanently. openwhispr-with-shim.sh binds Caps Lock
# when OpenWhispr starts and releases it when OpenWhispr quits.
set -euo pipefail

ROOT="$(cd "$(dirname "$0")" && pwd)"
APP_DIR="${XDG_DATA_HOME:-$HOME/.local/share}/applications"
DESKTOP="$APP_DIR/openwhispr-caps-dictate.desktop"
TOGGLE="$ROOT/scripts/toggle-openwhispr-dictation.sh"

if ! command -v qdbus6 >/dev/null 2>&1; then
  echo "qdbus6 not found — this binding is for KDE Plasma 6."
  exit 1
fi
if [[ "${XDG_CURRENT_DESKTOP:-}" != *KDE* ]]; then
  echo "Warning: XDG_CURRENT_DESKTOP=${XDG_CURRENT_DESKTOP:-unset} (expected KDE)."
fi

chmod 755 "$TOGGLE"
mkdir -p "$APP_DIR"

cat > "$DESKTOP" <<EOF
[Desktop Entry]
Type=Application
Name=OpenWhispr Dictate
Comment=Toggle OpenWhispr dictation (Caps Lock)
Exec=$TOGGLE
Icon=openwhispr
Terminal=false
StartupNotify=false
NoDisplay=true
Categories=Utility;AudioVideo;
X-KDE-Shortcuts=Caps Lock
EOF
chmod 644 "$DESKTOP"

chmod 755 "$ROOT/scripts/kde-caps-dictate.sh"
# Leave Caps Lock free until OpenWhispr + DeepInfra starts.
"$ROOT/scripts/kde-caps-dictate.sh" off || true

if command -v kbuildsycoca6 >/dev/null 2>&1; then
  kbuildsycoca6 --noincremental >/dev/null 2>&1 || true
fi

echo "Installed Caps Lock helper (inactive until OpenWhispr + DeepInfra runs):"
echo "  $DESKTOP"
echo "  $TOGGLE"
echo
echo "Day-to-day: open OpenWhispr + DeepInfra. Caps Lock binds on start, releases on quit."
