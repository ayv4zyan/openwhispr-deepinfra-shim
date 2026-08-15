#!/usr/bin/env bash
# Bind or release Caps Lock as OpenWhispr dictate (KDE Plasma 6).
# Usage: kde-caps-dictate.sh on|off
#
# Live grab via KGlobalAccel. Persist "none" when off so a reboot does not
# steal Caps Lock while OpenWhispr is closed.
set -euo pipefail

COMPONENT="openwhispr-caps-dictate.desktop"
SHORTCUT="_launch"
CAPS_QT=16777252 # Qt::Key_CapsLock

need_kde() {
  command -v dbus-send >/dev/null 2>&1 || return 1
  command -v qdbus6 >/dev/null 2>&1 || return 1
}

write_config() {
  local value="$1"
  command -v kwriteconfig6 >/dev/null 2>&1 || return 0
  kwriteconfig6 --file kglobalshortcutsrc \
    --group services --group openwhispr-caps-dictate.desktop \
    --key _launch "$value"
}

caps_on() {
  need_kde || return 0
  # Do not extra-quote this spec: dbus-send wants one token whose
  # commas split elements; spaces live inside the shell quotes.
  # --print-reply waits for KGlobalAccel; without it the bind is dropped.
  dbus-send --session --print-reply --dest=org.kde.kglobalaccel \
    /kglobalaccel org.kde.KGlobalAccel.doRegister \
    array:string:"openwhispr-caps-dictate.desktop","_launch","OpenWhispr Dictate","OpenWhispr Dictate" \
    >/dev/null
  dbus-send --session --print-reply --dest=org.kde.kglobalaccel \
    /kglobalaccel org.kde.KGlobalAccel.setShortcut \
    array:string:"openwhispr-caps-dictate.desktop","_launch","OpenWhispr Dictate","OpenWhispr Dictate" \
    array:int32:"$CAPS_QT" \
    uint32:2 >/dev/null
  # Keep the saved shortcut as none so a reboot does not steal Caps Lock.
}

caps_off() {
  need_kde || return 0
  qdbus6 org.kde.kglobalaccel /kglobalaccel org.kde.KGlobalAccel.unregister \
    "$COMPONENT" "$SHORTCUT" >/dev/null 2>&1 || true
  write_config "none,none,OpenWhispr Dictate"
}

case "${1:-}" in
  on) caps_on ;;
  off) caps_off ;;
  *)
    echo "Usage: $0 on|off" >&2
    exit 2
    ;;
esac
