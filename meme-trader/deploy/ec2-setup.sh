#!/usr/bin/env bash
# One-shot setup for Ubuntu 22.04 / 24.04 on EC2 or any VPS. Run from inside the cloned repo as your login user:
#   bash deploy/ec2-setup.sh
# Installs Node 22 if missing, builds the bot, creates .env from .env.example if absent, installs a systemd service
# that restarts on crash and starts on boot. It never touches your .env contents and never needs root for the bot itself.
set -euo pipefail

APP_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
SERVICE="meme-trader"
RUN_USER="${SUDO_USER:-$USER}"

sudo apt-get update -y -qq
if ! command -v node >/dev/null 2>&1 || [[ "$(node -v | sed 's/^v//' | cut -d. -f1)" -lt 22 ]]; then
  echo "installing Node.js 22..."
  curl -fsSL https://deb.nodesource.com/setup_22.x | sudo -E bash -
  sudo apt-get install -y nodejs
fi
command -v git >/dev/null 2>&1 || sudo apt-get install -y git

cd "$APP_DIR"
echo "building in $APP_DIR"
npm ci
npm run build

if [[ ! -f .env ]]; then
  cp .env.example .env
  chmod 600 .env
  echo "created .env from .env.example (paper mode). Edit it before starting the service."
else
  chmod 600 .env
fi
mkdir -p data
if ! grep -q '^DASHBOARD_TOKEN=.\+' .env; then
  TOKEN="$(openssl rand -hex 12 2>/dev/null || head -c 24 /dev/urandom | od -An -tx1 | tr -d ' \n')"
  if grep -q '^DASHBOARD_TOKEN=' .env; then sed -i "s#^DASHBOARD_TOKEN=.*#DASHBOARD_TOKEN=${TOKEN}#" .env; else printf '\nDASHBOARD_TOKEN=%s\n' "${TOKEN}" >> .env; fi
fi
DASH_TOKEN="$(grep '^DASHBOARD_TOKEN=' .env | cut -d= -f2-)"
DASH_PORT="$(grep '^DASHBOARD_PORT=' .env | cut -d= -f2- || true)"; DASH_PORT="${DASH_PORT:-8787}"

NODE_BIN="$(command -v node)"
sudo tee "/etc/systemd/system/${SERVICE}.service" >/dev/null <<UNIT
[Unit]
Description=meme-trader autonomous Solana meme coin trader
After=network-online.target
Wants=network-online.target

[Service]
Type=simple
User=${RUN_USER}
WorkingDirectory=${APP_DIR}
ExecStart=${NODE_BIN} dist/index.js
Restart=always
RestartSec=5
# SIGINT lets the bot flush its state file; open positions resume on the next start.
KillSignal=SIGINT
TimeoutStopSec=20
LimitNOFILE=65536
Environment=NODE_ENV=production
StandardOutput=journal
StandardError=journal

[Install]
WantedBy=multi-user.target
UNIT

sudo tee "/etc/systemd/system/${SERVICE}-dashboard.service" >/dev/null <<UNIT
[Unit]
Description=meme-trader read-only dashboard
After=network-online.target
Wants=network-online.target

[Service]
Type=simple
User=${RUN_USER}
WorkingDirectory=${APP_DIR}
ExecStart=${NODE_BIN} dist/tools/dashboard.js
Restart=always
RestartSec=5
Environment=NODE_ENV=production
StandardOutput=journal
StandardError=journal

[Install]
WantedBy=multi-user.target
UNIT

sudo systemctl daemon-reload
sudo systemctl enable "${SERVICE}" >/dev/null
sudo systemctl enable "${SERVICE}-dashboard" >/dev/null
if systemctl is-active --quiet "${SERVICE}"; then sudo systemctl restart "${SERVICE}"; fi
sudo systemctl restart "${SERVICE}-dashboard"

cat <<MSG

Installed. Next steps:
  1. nano ${APP_DIR}/.env          # RPC_URL (your Helius URL), risk limits; leave MODE=paper for now
  2. npm run smoke                   # read-only check against your RPC
  3. sudo systemctl start ${SERVICE}
  4. journalctl -u ${SERVICE} -f     # live logs (Ctrl+C stops the viewer, not the bot)

Dashboard (service ${SERVICE}-dashboard, already started):
  - tunnel:  ssh -i YOUR.pem -L ${DASH_PORT}:127.0.0.1:${DASH_PORT} ubuntu@THIS_SERVER   then open http://localhost:${DASH_PORT}/
  - public:  set DASHBOARD_HOST=0.0.0.0 in .env, open port ${DASH_PORT} in the security group, restart ${SERVICE}-dashboard,
             then open http://THIS_SERVER_IP:${DASH_PORT}/?token=${DASH_TOKEN}

Useful:
  sudo systemctl restart ${SERVICE}  # after editing .env
  sudo systemctl stop ${SERVICE}     # stop the bot (positions resume on start)
  npm run status                     # positions and PnL
  npm run panic -- --liquidate       # emergency: sell everything, open nothing new
  git pull && npm ci && npm run build && sudo systemctl restart ${SERVICE}   # update
MSG
