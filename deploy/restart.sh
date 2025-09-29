#!/usr/bin/env bash
set -euo pipefail

APP_NAME="teledown"
APP_DIR="${APP_DIR:-/opt/teledown}"
FOLLOW=0
RELOAD_NGINX=0

usage() {
  cat <<EOF
Usage: $0 [--path DIR] [--follow|-f] [--reload-nginx|-n]

Options:
  --path DIR         Path to app directory (default: /opt/teledown)
  --follow, -f       Follow logs after restart
  --reload-nginx, -n Reload Nginx after restart (config test first)
  -h, --help         Show this help

Detects systemd/PM2/Docker automatically and restarts the app accordingly.
EOF
}

while [[ $# -gt 0 ]]; do
  case "$1" in
    --path) APP_DIR="$2"; shift 2 ;;
    --follow|-f) FOLLOW=1; shift ;;
    --reload-nginx|-n) RELOAD_NGINX=1; shift ;;
    -h|--help) usage; exit 0 ;;
    *) echo "Unknown option: $1"; usage; exit 1 ;;
  esac
done

# use sudo if available and not already root
SUDO=""
if [[ $(id -u) -ne 0 ]] && command -v sudo >/dev/null 2>&1; then
  SUDO="sudo"
fi

echo "[i] App name: $APP_NAME"
echo "[i] App dir : $APP_DIR"

restart_systemd() {
  if ! command -v systemctl >/dev/null 2>&1; then return 1; fi
  if ! $SUDO systemctl status "$APP_NAME" >/dev/null 2>&1; then return 1; fi
  echo "[i] Detected systemd unit: $APP_NAME.service"
  $SUDO systemctl daemon-reload || true
  $SUDO systemctl restart "$APP_NAME"
  $SUDO systemctl status "$APP_NAME" --no-pager -l | sed -n '1,40p' || true
  if [[ $FOLLOW -eq 1 ]]; then
    exec $SUDO journalctl -u "$APP_NAME" -f
  fi
  return 0
}

restart_pm2() {
  if ! command -v pm2 >/dev/null 2>&1; then return 1; fi
  echo "[i] Using PM2"
  if pm2 list | grep -q "\b$APP_NAME\b"; then
    pm2 restart "$APP_NAME"
  else
    pm2 start "$APP_DIR/backend/server.js" --name "$APP_NAME"
  fi
  if [[ $FOLLOW -eq 1 ]]; then
    exec pm2 logs "$APP_NAME"
  fi
  return 0
}

restart_docker() {
  if ! command -v docker >/dev/null 2>&1; then return 1; fi
  if ! $SUDO docker ps --format '{{.Names}}' | grep -q "^$APP_NAME$"; then return 1; fi
  echo "[i] Restarting Docker container: $APP_NAME"
  $SUDO docker restart "$APP_NAME"
  if [[ $FOLLOW -eq 1 ]]; then
    exec $SUDO docker logs -f "$APP_NAME"
  fi
  return 0
}

restart_raw_node() {
  echo "[i] Falling back to raw Node process"
  if pgrep -f "node .*backend/server.js" >/dev/null 2>&1; then
    $SUDO pkill -f "node .*backend/server.js" || true
    sleep 1
  fi
  cd "$APP_DIR"
  # Ensure log dir exists
  $SUDO mkdir -p /var/log || true
  echo "[i] Starting: node backend/server.js (logs: /var/log/teledown.out)"
  nohup node backend/server.js >> /var/log/teledown.out 2>&1 &
  if [[ $FOLLOW -eq 1 ]]; then
    exec tail -f /var/log/teledown.out
  fi
}

reload_nginx() {
  [[ $RELOAD_NGINX -eq 1 ]] || return 0
  if ! command -v nginx >/dev/null 2>&1; then
    echo "[w] nginx not installed; skip reload"
    return 0
  fi
  echo "[i] Testing nginx config"
  if $SUDO nginx -t; then
    if command -v systemctl >/dev/null 2>&1; then
      $SUDO systemctl reload nginx || $SUDO nginx -s reload || true
    else
      $SUDO nginx -s reload || true
    fi
  else
    echo "[!] nginx config test failed; not reloading"
  fi
}

# Try in order: systemd -> PM2 -> Docker -> raw node
restart_systemd || restart_pm2 || restart_docker || restart_raw_node

reload_nginx

echo "[✓] Done"
