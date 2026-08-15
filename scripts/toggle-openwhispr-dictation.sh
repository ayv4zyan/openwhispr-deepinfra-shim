#!/usr/bin/env bash
# Invoke OpenWhispr's registered KDE "dictation" action (tap-to-toggle).
# No-op if OpenWhispr is not running (component missing).
set -euo pipefail
qdbus6 org.kde.kglobalaccel /component/openwhispr \
  org.kde.kglobalaccel.Component.invokeShortcut dictation >/dev/null 2>&1 || exit 0

