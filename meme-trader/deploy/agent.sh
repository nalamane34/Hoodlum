#!/usr/bin/env bash
# Remote jobs runner ("remote hands"). Installed by deploy/install-agent.sh as a systemd timer (every 2 minutes).
# Pulls the git branch and runs each new deploy/jobs/NNN-*.sh exactly once, in order, logging to data/agent/.
# A job runs as the login user with sudo available; it never re-runs even if it fails (push a new number to retry).
# Disable at any time:  sudo systemctl disable --now meme-trader-agent.timer
set -uo pipefail

APP_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
REPO_DIR="$(cd "$APP_DIR/.." && pwd)"
BRANCH="${AGENT_BRANCH:-meme-trader}"
STATE_DIR="$APP_DIR/data/agent"
mkdir -p "$STATE_DIR"
AGENT_LOG="$STATE_DIR/agent.log"
exec 9>"$STATE_DIR/lock"
flock -n 9 || exit 0

cd "$REPO_DIR"
if ! git fetch -q origin "$BRANCH" 2>>"$AGENT_LOG"; then
  echo "$(date -Is) fetch failed (is the repo still public, or is a deploy key configured?)" >> "$AGENT_LOG"
  exit 0
fi
LOCAL="$(git rev-parse HEAD)"
REMOTE="$(git rev-parse "origin/$BRANCH")"
if [[ "$LOCAL" != "$REMOTE" ]]; then
  git reset -q --hard "origin/$BRANCH"
  echo "$(date -Is) updated $(echo "$LOCAL" | cut -c1-7) -> $(echo "$REMOTE" | cut -c1-7)" >> "$AGENT_LOG"
fi

LAST_FILE="$STATE_DIR/last"
LAST="$(cat "$LAST_FILE" 2>/dev/null || echo 0)"
cd "$APP_DIR"
for job in $(ls deploy/jobs/*.sh 2>/dev/null | sort); do
  base="$(basename "$job" .sh)"
  num="${base%%-*}"
  [[ "$num" =~ ^[0-9]+$ ]] || continue
  n=$((10#$num))
  [[ "$n" -gt "$LAST" ]] || continue
  log="$STATE_DIR/$base.log"
  echo "=== $base started $(date -Is) at commit $(git rev-parse --short HEAD) ===" > "$log"
  timeout 2400 bash "$job" >> "$log" 2>&1
  rc=$?
  echo "=== $base finished $(date -Is) exit $rc ===" >> "$log"
  echo "$n" > "$LAST_FILE"
  LAST="$n"
  echo "$(date -Is) job $base exit $rc" >> "$AGENT_LOG"
done
exit 0
