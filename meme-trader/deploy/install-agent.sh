#!/usr/bin/env bash
# Installs the remote jobs runner (deploy/agent.sh) as a systemd timer and runs it once right away.
#   bash deploy/install-agent.sh
#   SKIP_JOBS_THROUGH=5 bash deploy/install-agent.sh   # jobs 001-005 were already run by hand: start with 006
# Security note: whoever can push to this repository's branch can then run commands on this server as this user.
# Keep the repository's push access to yourself. Disable with: sudo systemctl disable --now meme-trader-agent.timer
set -euo pipefail
APP_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
RUN_USER="${SUDO_USER:-$USER}"
BASH_BIN="$(command -v bash)"
sudo tee /etc/systemd/system/meme-trader-agent.service >/dev/null <<UNIT
[Unit]
Description=meme-trader remote jobs runner (pulls the git branch, runs new deploy/jobs/*.sh)
After=network-online.target
Wants=network-online.target

[Service]
Type=oneshot
User=${RUN_USER}
WorkingDirectory=${APP_DIR}
ExecStart=${BASH_BIN} ${APP_DIR}/deploy/agent.sh
Environment=HOME=/home/${RUN_USER}
UNIT
sudo tee /etc/systemd/system/meme-trader-agent.timer >/dev/null <<UNIT
[Unit]
Description=run meme-trader remote jobs every 2 minutes

[Timer]
OnBootSec=1min
OnUnitActiveSec=2min
AccuracySec=15s

[Install]
WantedBy=timers.target
UNIT
if [[ -n "${SKIP_JOBS_THROUGH:-}" ]]; then
  mkdir -p "${APP_DIR}/data/agent"
  CUR="$(cat "${APP_DIR}/data/agent/last" 2>/dev/null || echo 0)"
  if (( 10#${SKIP_JOBS_THROUGH} > 10#${CUR} )); then echo "$((10#${SKIP_JOBS_THROUGH}))" > "${APP_DIR}/data/agent/last"; fi
  echo "jobs up to ${SKIP_JOBS_THROUGH} marked as already run"
fi
sudo systemctl daemon-reload
sudo systemctl enable --now meme-trader-agent.timer >/dev/null
echo "remote jobs runner installed (every 2 minutes). Running pending jobs now; this can take a few minutes..."
sudo systemctl start meme-trader-agent.service || true
echo
echo "--- agent log ---"
tail -n 20 "${APP_DIR}/data/agent/agent.log" 2>/dev/null || true
for f in $(ls -t "${APP_DIR}"/data/agent/[0-9]*.log 2>/dev/null | head -1); do echo "--- $(basename "$f") (last 25 lines) ---"; tail -n 25 "$f"; done
echo
echo "Dashboard token (you will need it to sign in):  $(grep '^DASHBOARD_TOKEN=' "${APP_DIR}/.env" 2>/dev/null | cut -d= -f2-)"
HOSTLINE="$(grep -m1 -oE '^[^#{ ]+\.[a-z0-9.-]+ \{' /etc/caddy/Caddyfile 2>/dev/null | sed 's/ {//' || true)"
[[ -n "$HOSTLINE" ]] && echo "Dashboard URL:  https://${HOSTLINE}/"
