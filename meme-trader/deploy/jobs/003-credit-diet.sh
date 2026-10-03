#!/usr/bin/env bash
# Job 003: background RPC reads on the public endpoint, no outcome sampling for pre-rejected launches, creator history
# only for candidates that pass the free signals. Rebuild and restart.
set -euo pipefail
cd "$(dirname "${BASH_SOURCE[0]}")/../.."
setenv() { if grep -q "^$1=" .env; then sed -i "s#^$1=.*#$1=$2#" .env; else printf '%s=%s\n' "$1" "$2" >> .env; fi; }
setenv RPC_BACKGROUND_URL https://api.mainnet-beta.solana.com
setenv SHADOW_PREFILTERED false
npm ci && npm run build && npm prune --omit=dev
sudo systemctl restart meme-trader
sleep 15
journalctl -u meme-trader -n 8 --no-pager
echo "job 003 done"
