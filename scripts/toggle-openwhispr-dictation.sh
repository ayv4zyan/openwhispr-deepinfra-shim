#!/usr/bin/env bash
# Invoke OpenWhispr's registered KDE "dictation" action (tap-to-toggle).
set -euo pipefail
exec qdbus6 org.kde.kglobalaccel /component/openwhispr \
  org.kde.kglobalaccel.Component.invokeShortcut dictation
