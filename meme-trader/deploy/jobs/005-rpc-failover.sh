#!/usr/bin/env bash
# Job 005: RPC failover. The Helius free credits ran out ("429 Too Many Requests: max usage reached") and the bot
# crash-looped at startup. This build keeps running on RPC_FALLBACK_URL (the public RPC) whenever the primary is out of
# credits, rejects the key or keeps failing, and moves back by itself once the primary answers again.
#
# Optional: HELIUS_KEY=<new key> bash deploy/jobs/005-rpc-failover.sh   puts a fresh Helius key into .env (never into git).
set -euo pipefail
cd "$(dirname "${BASH_SOURCE[0]}")/../.."
setenv() { if grep -q "^$1=" .env; then sed -i "s#^$1=.*#$1=$2#" .env; else printf '%s=%s\n' "$1" "$2" >> .env; fi; }
if [[ -n "${HELIUS_KEY:-}" ]]; then
  setenv RPC_URL "https://mainnet.helius-rpc.com/?api-key=${HELIUS_KEY}"
  echo "RPC_URL now uses the new Helius key"
fi
# Everything except the trading path stays on the public endpoint so the paid credits last the month.
setenv RPC_WS_URL wss://api.mainnet-beta.solana.com
setenv RPC_BACKGROUND_URL https://api.mainnet-beta.solana.com
setenv RPC_FALLBACK_URL https://api.mainnet-beta.solana.com
npm ci && npm run build && npm prune --omit=dev
sudo systemctl reset-failed meme-trader 2>/dev/null || true
sudo systemctl restart meme-trader
sleep 25
journalctl -u meme-trader -n 12 --no-pager
echo "job 005 done"
