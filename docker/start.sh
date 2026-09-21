#!/usr/bin/env bash
# Boots a virtual display + VNC bridge so the browser is visible through /vnc,
# then starts the control plane. With HEADLESS=true only the app starts.
set -euo pipefail

# A Railway volume announces where it is mounted; the app uses that path automatically.
DATA_DIR="${RAILWAY_VOLUME_MOUNT_PATH:-${DATA_DIR:-/data}}"
mkdir -p "$DATA_DIR"

if [ "${HEADLESS:-false}" != "true" ]; then
  export DISPLAY="${DISPLAY:-:99}"
  Xvfb "$DISPLAY" -screen 0 "${SCREEN_GEOMETRY:-1600x1000x24}" -nolisten tcp >/dev/null 2>&1 &
  for _ in $(seq 1 30); do
    if xdpyinfo -display "$DISPLAY" >/dev/null 2>&1; then break; fi
    sleep 0.2
  done
  fluxbox >/dev/null 2>&1 &
  x11vnc -display "$DISPLAY" -forever -shared -nopw -rfbport 5900 -localhost -quiet -noxdamage >/dev/null 2>&1 &
  websockify --web /usr/share/novnc 127.0.0.1:6080 127.0.0.1:5900 >/dev/null 2>&1 &
  echo "[start] virtual display + noVNC bridge up on 127.0.0.1:6080"
fi

exec node dist/bootstrap.js
