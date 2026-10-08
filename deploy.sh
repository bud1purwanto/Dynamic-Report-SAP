#!/usr/bin/env bash
set -Eeuo pipefail

APP_DIR="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)"
cd "$APP_DIR"

echo "=== [Lumina Dynamic Report] Deploying Production Container ==="
if [[ ! -f .env ]]; then
  echo "Error: File .env tidak ditemukan di $APP_DIR" >&2
  exit 1
fi

echo "[1/3] Building production Docker image..."
docker compose build

echo "[2/3] Recreating and launching container..."
docker compose up -d --remove-orphans

echo "[3/3] Verifying container health..."
sleep 3
if docker ps --filter "name=lumina-dynamic-report" --filter "status=running" | grep -q lumina-dynamic-report; then
  echo "Container lumina-dynamic-report aktif dan berjalan normal!"
  docker ps --filter "name=lumina-dynamic-report"
else
  echo "Error: Container gagal berjalan. Cek log:" >&2
  docker logs --tail 50 lumina-dynamic-report
  exit 1
fi
echo "=== Deployment Selesai ==="
