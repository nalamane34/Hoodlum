#!/usr/bin/env bash
# Job 001: rebuild with the latest code (login page, retention, dashboard) and put the dashboard on HTTPS via Caddy.
# Hostname: NAME.duckdns.org if DUCKDNS_DOMAIN and DUCKDNS_TOKEN are set in .env, otherwise <ip>.sslip.io.
set -euo pipefail
cd "$(dirname "${BASH_SOURCE[0]}")/../.."
bash deploy/ec2-setup.sh
DUCK_DOMAIN="$(grep '^DUCKDNS_DOMAIN=' .env 2>/dev/null | cut -d= -f2- || true)"
DUCK_TOKEN="$(grep '^DUCKDNS_TOKEN=' .env 2>/dev/null | cut -d= -f2- || true)"
if [[ -n "$DUCK_DOMAIN" && -n "$DUCK_TOKEN" ]]; then
  bash deploy/expose.sh "$DUCK_DOMAIN" "$DUCK_TOKEN"
else
  bash deploy/expose.sh
fi
echo "job 001 done"
