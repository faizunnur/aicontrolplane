#!/usr/bin/env bash
# Boots a virtual display + VNC bridge so the browser is visible through /vnc,
# then starts the control plane. With HEADLESS=true only the app starts.
set -euo pipefail

# A Railway volume announces where it is mounted; the app uses that path automatically.
DATA_DIR="${RAILWAY_VOLUME_MOUNT_PATH:-${DATA_DIR:-/data}}"

# Chrome must not run as root: root cannot start the user-namespace sandbox that keeps one
# workspace's pages away from another's cookies. When the container boots as root, it only
# claims the data volume (mounted root-owned on most platforms) for pwuser, then re-runs
# itself unprivileged. Everything below the drop - Xvfb, x11vnc, websockify, node - is pwuser.
if [ "$(id -u)" = "0" ]; then
  mkdir -p "$DATA_DIR"
  if [ "$(stat -c %u "$DATA_DIR")" != "$(id -u pwuser)" ]; then
    chown -R pwuser:pwuser "$DATA_DIR" || echo "[start] warning: could not hand $DATA_DIR to pwuser"
  fi
  exec gosu pwuser bash "$0" "$@"
fi

mkdir -p "$DATA_DIR"

if [ "${HEADLESS:-false}" != "true" ]; then
  export DISPLAY="${DISPLAY:-:99}"
  Xvfb "$DISPLAY" -screen 0 "${SCREEN_GEOMETRY:-1600x1000x24}" -nolisten tcp >/dev/null 2>&1 &
  for _ in $(seq 1 30); do
    if xdpyinfo -display "$DISPLAY" >/dev/null 2>&1; then break; fi
    sleep 0.2
  done
  # No window manager on purpose: Chromium then sits at 0,0 and fills the whole screen.
  # VNC_BIND=0.0.0.0 lets a separate api container proxy /vnc to this worker (split mode).
  VNC_BIND="${VNC_BIND:-127.0.0.1}"
  x11vnc -display "$DISPLAY" -forever -shared -nopw -rfbport 5900 -localhost -quiet -noxdamage >/dev/null 2>&1 &
  websockify --web /usr/share/novnc "$VNC_BIND":6080 127.0.0.1:5900 >/dev/null 2>&1 &
  echo "[start] virtual display + noVNC bridge up on $VNC_BIND:6080"
fi

exec node dist/src/bootstrap.js
