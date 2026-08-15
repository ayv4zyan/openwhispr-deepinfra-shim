#!/usr/bin/env bash
# Wayland auto-paste: ydotool + ydotoold + input group + user service.
# OpenWhispr shows "Wayland Paste Setup" until this is done and you re-login.
set -euo pipefail

need_root() {
  if [[ "$(id -u)" -eq 0 ]]; then
    "$@"
  elif command -v pkexec >/dev/null 2>&1; then
    pkexec "$@"
  else
    sudo "$@"
  fi
}

if ! command -v ydotool >/dev/null 2>&1 || ! command -v ydotoold >/dev/null 2>&1; then
  if command -v pacman >/dev/null 2>&1; then
    need_root pacman -S --noconfirm --needed ydotool
  else
    echo "Install the ydotool package (must include ydotoold), then re-run."
    exit 1
  fi
fi

need_root /bin/bash -c '
set -euo pipefail
modprobe uinput || true
usermod -aG input "'"$USER"'"
if [[ ! -f /etc/udev/rules.d/70-uinput.rules ]]; then
  printf "%s\n" "KERNEL==\"uinput\", GROUP=\"input\", MODE=\"0660\", TAG+=\"uaccess\"" \
    > /etc/udev/rules.d/70-uinput.rules
fi
udevadm control --reload-rules
udevadm trigger /dev/uinput || true
'

systemctl --user daemon-reload
if [[ -f /usr/lib/systemd/user/ydotool.service ]]; then
  systemctl --user enable --now ydotool.service
elif [[ -f /usr/lib/systemd/user/ydotoold.service ]]; then
  systemctl --user enable --now ydotoold.service
else
  echo "ydotool user unit not found; start ydotoold yourself."
  exit 1
fi

echo "ydotool installed; daemon: $(systemctl --user is-active ydotool.service 2>/dev/null || systemctl --user is-active ydotoold.service)"
echo
echo "Log out and back in so \`groups\` includes input (OpenWhispr checks that)."
echo "Then restart OpenWhispr + DeepInfra."
