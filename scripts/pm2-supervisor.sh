#!/usr/bin/env bash
# User systemd service keeps the PM2 daemon available without relying on pm2.pid.
set -u
cd /home/oem/workflow-builder || exit 1
export PATH="/home/oem/.npm-global/bin:/usr/local/bin:/usr/bin:/bin:$PATH"
mkdir -p .data
while true; do
  flock --close -n .data/deploy.lock bash -c '
    pm2 ping >/dev/null &&
    { pm2 describe workflow-builder >/dev/null 2>&1 || pm2 resurrect; }
  ' || true
  sleep 30
done
