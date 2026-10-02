#!/usr/bin/env bash
# Put the dashboard on the public internet over HTTPS with Caddy + Let's Encrypt (all free).
#
#   bash deploy/expose.sh                                   # 1-2-3-4.sslip.io derived from the public IP (can hit LE rate limits)
#   bash deploy/expose.sh myname.duckdns.org DUCKDNS_TOKEN  # recommended: free DuckDNS name, IP kept updated every 5 min
#   bash deploy/expose.sh any.host.you.own                  # any hostname whose DNS A record points at this server
#   EMAIL=you@example.com bash deploy/expose.sh ...         # optional: enables ZeroSSL as a fallback certificate authority
#
# Requires inbound TCP 80 and 443 open in the security group. The dashboard stays bound to 127.0.0.1; Caddy terminates
# TLS and proxies to it. Re-run any time to change the hostname.
set -euo pipefail

APP_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$APP_DIR"
[[ -f .env ]] || { echo "no .env yet: run deploy/ec2-setup.sh first"; exit 1; }

PUBLIC_IP="$(curl -fsS --max-time 8 http://checkip.amazonaws.com 2>/dev/null | tr -d '[:space:]' || true)"
[[ -n "$PUBLIC_IP" ]] || PUBLIC_IP="$(curl -fsS --max-time 8 https://api.ipify.org 2>/dev/null | tr -d '[:space:]' || true)"
HOST_ARG="${1:-}"
DUCK_TOKEN="${2:-}"
if [[ -z "$HOST_ARG" ]]; then
  [[ -n "$PUBLIC_IP" ]] || { echo "could not determine the public IP; pass a hostname as the first argument"; exit 1; }
  HOST_ARG="${PUBLIC_IP//./-}.sslip.io"
  echo "NOTE: using ${HOST_ARG}. sslip.io shares one Let's Encrypt quota with everyone; if the certificate fails with"
  echo "      'too many certificates', get a free name at https://www.duckdns.org and re-run: bash deploy/expose.sh NAME.duckdns.org DUCKDNS_TOKEN"
fi
PORT="$(grep '^DASHBOARD_PORT=' .env | cut -d= -f2- || true)"; PORT="${PORT:-8787}"
TOKEN="$(grep '^DASHBOARD_TOKEN=' .env | cut -d= -f2- || true)"
[[ -n "$TOKEN" ]] || { echo "DASHBOARD_TOKEN is empty in .env; run deploy/ec2-setup.sh to generate one"; exit 1; }

# The dashboard must stay on loopback (Caddy fronts it) and must know it is behind a proxy.
setenv() { if grep -q "^$1=" .env; then sed -i "s#^$1=.*#$1=$2#" .env; else printf '%s=%s\n' "$1" "$2" >> .env; fi; }
setenv DASHBOARD_HOST 127.0.0.1
setenv DASHBOARD_TRUST_PROXY true

# DuckDNS: point the name at this server now and keep it updated (survives IP changes without an Elastic IP).
if [[ "$HOST_ARG" == *.duckdns.org && -n "$DUCK_TOKEN" ]]; then
  SUB="${HOST_ARG%.duckdns.org}"
  UPDATE_URL="https://www.duckdns.org/update?domains=${SUB}&token=${DUCK_TOKEN}&ip="
  RESULT="$(curl -fsS --max-time 10 "$UPDATE_URL" || echo "KO")"
  [[ "$RESULT" == "OK" ]] || { echo "DuckDNS update failed (${RESULT}): check the name and token"; exit 1; }
  echo "DuckDNS: ${HOST_ARG} -> ${PUBLIC_IP}"
  ( crontab -l 2>/dev/null | grep -v 'duckdns.org/update' ; echo "*/5 * * * * curl -fsS --max-time 10 '${UPDATE_URL}' >/dev/null 2>&1" ) | crontab -
  echo "DuckDNS: cron job installed to refresh the IP every 5 minutes"
fi

if ! command -v caddy >/dev/null 2>&1; then
  echo "installing Caddy..."
  export DEBIAN_FRONTEND=noninteractive
  sudo apt-get install -y -qq debian-keyring debian-archive-keyring apt-transport-https curl gnupg
  curl -1sLf 'https://dl.cloudsmith.io/public/caddy/stable/gpg.key' | sudo gpg --dearmor --yes -o /usr/share/keyrings/caddy-stable-archive-keyring.gpg
  curl -1sLf 'https://dl.cloudsmith.io/public/caddy/stable/debian.deb.txt' | sudo tee /etc/apt/sources.list.d/caddy-stable.list >/dev/null
  sudo apt-get update -qq
  sudo apt-get install -y -qq caddy
fi

GLOBAL=""
if [[ -n "${EMAIL:-}" ]]; then GLOBAL=$'{\n\temail '"${EMAIL}"$'\n}\n\n'; fi
sudo tee /etc/caddy/Caddyfile >/dev/null <<CADDY
${GLOBAL}${HOST_ARG} {
	encode zstd gzip
	header {
		Strict-Transport-Security "max-age=31536000"
		-Server
	}
	reverse_proxy 127.0.0.1:${PORT}
}
CADDY
sudo caddy validate --config /etc/caddy/Caddyfile >/dev/null
sudo systemctl enable caddy >/dev/null
sudo systemctl restart caddy
sudo systemctl restart meme-trader-dashboard 2>/dev/null || true

cat <<MSG

Caddy is serving https://${HOST_ARG}/  (certificate issued and renewed automatically)
Sign in once with the token:  ${TOKEN}

Checklist:
  1. Security group: inbound TCP 80 and 443 from 0.0.0.0/0. Port 8787 must NOT be open (the dashboard is loopback-only now).
  2. The first HTTPS request can take ~10-20 s while the certificate is issued. Problems: sudo journalctl -u caddy -n 40 --no-pager
  3. sslip.io names change if the public IP changes (stop/start): allocate an Elastic IP, or use a DuckDNS name (kept updated by cron).
MSG
