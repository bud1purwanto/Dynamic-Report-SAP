#!/bin/sh
set -e

APP_HOST="${APP_HOST:-0.0.0.0}"
APP_PORT="${APP_PORT:-8000}"

# Graceful termination handling
cleanup() {
  echo "Menghentikan layanan Lumina..."
  if [ -n "$WORKER_PID" ]; then kill -TERM "$WORKER_PID" 2>/dev/null || true; fi
  if [ -n "$UVICORN_PID" ]; then kill -TERM "$UVICORN_PID" 2>/dev/null || true; fi
  wait
  exit 0
}

trap cleanup INT TERM

echo "Memulai Lumina Scheduler Worker..."
python -m backend.app.worker &
WORKER_PID=$!

echo "Memulai Lumina FastAPI Server pada port ${APP_PORT}..."
uvicorn backend.app.main:app --host "${APP_HOST}" --port "${APP_PORT}" &
UVICORN_PID=$!

# Wait for both background processes
wait -n "$WORKER_PID" "$UVICORN_PID"
cleanup

