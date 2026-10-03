#!/usr/bin/env bash
# Job 002: move the websocket trade feed to the public endpoint (Helius free tier was returning 429 on reconnects),
# use a realistic paper network fee, rebuild with the hardened websocket client, restart the bot.
set -euo pipefail
cd "$(dirname "${BASH_SOURCE[0]}")/../.."
setenv() { if grep -q "^$1=" .env; then sed -i "s#^$1=.*#$1=$2#" .env; else printf '%s=%s\n' "$1" "$2" >> .env; fi; }
setenv RPC_WS_URL wss://api.mainnet-beta.solana.com
setenv PAPER_FEE_SOL 0.0005
npm ci && npm run build && npm prune --omit=dev
sudo systemctl restart meme-trader
sleep 20
journalctl -u meme-trader -n 15 --no-pager
echo "job 002 done"
