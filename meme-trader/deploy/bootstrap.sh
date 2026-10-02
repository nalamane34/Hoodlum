#!/usr/bin/env bash
# First-run bootstrap for a fresh Ubuntu server. Clones (or updates) the repo and runs deploy/ec2-setup.sh.
#   curl -fsSL https://raw.githubusercontent.com/nalamane34/Hoodlum/meme-trader/meme-trader/deploy/bootstrap.sh | bash
# For a private repo, clone manually first and run `bash deploy/ec2-setup.sh` instead.
set -euo pipefail
REPO_URL="${REPO_URL:-https://github.com/nalamane34/Hoodlum.git}"
BRANCH="${BRANCH:-meme-trader}"
TARGET="${TARGET:-$HOME/Hoodlum}"

export DEBIAN_FRONTEND=noninteractive
sudo apt-get update -y -qq
sudo apt-get install -y -qq git curl ca-certificates

if [[ -d "$TARGET/.git" ]]; then
  git -C "$TARGET" pull --ff-only
else
  GIT_TERMINAL_PROMPT=0 git clone -b "$BRANCH" "$REPO_URL" "$TARGET"
fi
cd "$TARGET/meme-trader"
bash deploy/ec2-setup.sh
