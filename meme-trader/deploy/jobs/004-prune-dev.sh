#!/usr/bin/env bash
# Job 004: rebuild with updated dependencies and remove development-only packages from the server.
set -euo pipefail
cd "$(dirname "${BASH_SOURCE[0]}")/../.."
npm ci && npm run build && npm prune --omit=dev
sudo systemctl restart meme-trader
sudo systemctl restart meme-trader-dashboard 2>/dev/null || true
echo "job 004 done"
