#!/usr/bin/env bash
# Bind Caps Lock → OpenWhispr dictate on KDE Plasma 6 (Wayland).
#
# OpenWhispr's KDE backend cannot register CapsLock (missing Qt key). This
# installs a hidden .desktop + kglobalaccel shortcut that invokes the same
# "dictation" action OpenWhispr already registered.
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

if command -v kwriteconfig6 >/dev/null 2>&1; then
  kwriteconfig6 --file kglobalshortcutsrc \
    --group services --group openwhispr-caps-dictate.desktop \
    --key _launch "Caps Lock,none,OpenWhispr Dictate"
fi
if command -v kbuildsycoca6 >/dev/null 2>&1; then
  kbuildsycoca6 --noincremental >/dev/null 2>&1 || true
fi
if command -v qdbus6 >/dev/null 2>&1; then
  qdbus6 org.kde.KWin /KWin org.kde.KWin.reconfigure >/dev/null 2>&1 || true
fi

echo "Installed Caps Lock → dictate:"
echo "  $DESKTOP"
echo "  $TOGGLE"
echo
echo "OpenWhispr must be running. Tap Caps Lock to start/stop dictation."
echo "The Caps Lock LED / case-lock may still toggle; that is the key's OS lock."
echo
echo "If Caps Lock does nothing: confirm OpenWhispr is open, then:"
echo "  $TOGGLE"
