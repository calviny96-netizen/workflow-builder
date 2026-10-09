#!/usr/bin/env bash
# Deploy the existing stack, then restore and persist its PM2 supervisor.
set -euo pipefail
cd /home/oem/workflow-builder
export PATH="/home/oem/.npm-global/bin:/usr/local/bin:/usr/bin:/bin:$PATH"
mkdir -p .data
exec 9>.data/deploy.lock
flock -w 300 9
restore_supervisor() {
  pm2 startOrRestart ecosystem.config.cjs --only workflow-builder
  pm2 save
}
trap restore_supervisor EXIT
pm2 stop workflow-builder || true
docker compose up -d --build server web
for attempt in {1..30}; do
  if curl --fail --silent --max-time 5 http://127.0.0.1:5173/api/health >/dev/null; then
    echo 'Deploy selesai; web dan API sehat.'
    exit 0
  fi
  sleep 2
done
echo 'Deploy belum sehat; periksa docker compose logs.' >&2
exit 1
