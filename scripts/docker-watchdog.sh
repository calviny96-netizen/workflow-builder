#!/usr/bin/env bash
# PM2 mengawasi proses ini; aplikasi tetap berjalan dalam Docker.
set -u
cd /home/oem/workflow-builder || exit 1
export PATH="/usr/local/bin:/usr/bin:/bin:$PATH"
while true; do
  if docker info >/dev/null 2>&1; then
    if ! docker compose up -d --no-build >/dev/null 2>&1; then
      echo "$(date -Is) Docker Compose belum siap; mencoba lagi dalam 30 detik"
    else
      for service in postgres server; do
        container=$(docker compose ps -q "$service")
        health=$(docker inspect --format '{{if .State.Health}}{{.State.Health.Status}}{{end}}' "$container" 2>/dev/null || true)
        if [ "$health" = unhealthy ]; then
          echo "$(date -Is) Restart service $service yang unhealthy"
          docker compose restart "$service" >/dev/null 2>&1 || true
        fi
      done
      if ! curl --fail --silent --max-time 10 http://127.0.0.1:5173/api/health >/dev/null; then
        echo "$(date -Is) Web tidak merespons; restart proxy web"
        docker compose restart web >/dev/null 2>&1 || true
      fi
    fi
  else
    echo "$(date -Is) Menunggu Docker tersedia"
  fi
  sleep 30
done
