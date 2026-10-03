#!/usr/bin/env bash
# Job 006: finish the website. Same as job 001 (rebuild, then HTTPS dashboard via Caddy + Let's Encrypt), for servers
# that applied jobs 002-005 by hand and install the runner with SKIP_JOBS_THROUGH=5.
# Needs inbound TCP 80 and 443 open in the security group before it runs (the certificate request fails otherwise;
# re-run with a new job number after opening them).
set -euo pipefail
cd "$(dirname "${BASH_SOURCE[0]}")/../.."
bash deploy/jobs/001-https-dashboard.sh
echo "job 006 done"
