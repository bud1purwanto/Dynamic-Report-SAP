#!/usr/bin/env bash
set -euo pipefail

project_dir="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)"
cd "$project_dir"

if [[ ! -f .env ]]; then
  echo "File .env belum ada. Salin .env.example lalu isi konfigurasinya." >&2
  exit 1
fi

if [[ ! -x .venv/bin/python || ! -x .venv/bin/uvicorn ]]; then
  echo "Virtual environment belum siap. Jalankan: python3 -m venv .venv && .venv/bin/pip install -r backend/requirements.txt" >&2
  exit 1
fi

if [[ ! -d frontend/node_modules ]] || ! command -v npm >/dev/null 2>&1; then
  echo "Dependensi frontend belum siap. Jalankan: cd frontend && npm install --include=dev" >&2
  exit 1
fi
npm --prefix frontend run build

app_host="${APP_HOST:-0.0.0.0}"
app_port="${APP_PORT:-8000}"
api_pid=""
worker_pid=""

show_urls() {
  echo
  echo "Alamat Lumina:"
  if [[ "$app_host" != "0.0.0.0" ]]; then
    echo "  http://${app_host}:${app_port}"
    return
  fi

  echo "  Lokal:     http://127.0.0.1:${app_port}"
  if command -v ip >/dev/null 2>&1; then
    while IFS= read -r lan_ip; do
      [[ -n "$lan_ip" ]] && echo "  LAN:       http://${lan_ip}:${app_port}"
    done < <(ip -4 -o addr show scope global 2>/dev/null | awk '
      $2 !~ /^(tailscale|docker|br-|veth|virbr|tun|wg)/ {
        split($4, addr, "/")
        if (addr[1] !~ /^169\.254\./) print addr[1]
      }')
  fi
  if command -v tailscale >/dev/null 2>&1; then
    tailscale_ip="$(tailscale ip -4 2>/dev/null || true)"
    if [[ "$tailscale_ip" =~ ^[0-9]+\.[0-9]+\.[0-9]+\.[0-9]+$ ]]; then
      echo "  Tailscale: http://${tailscale_ip}:${app_port}"
    fi
  fi
  echo
}

cleanup() {
  trap - EXIT INT TERM
  for pid in "$api_pid" "$worker_pid"; do
    if [[ -n "$pid" ]]; then
      kill "$pid" 2>/dev/null || true
    fi
  done
  for pid in "$api_pid" "$worker_pid"; do
    if [[ -n "$pid" ]]; then
      wait "$pid" 2>/dev/null || true
    fi
  done
}
trap cleanup EXIT
trap 'exit 130' INT
trap 'exit 143' TERM

show_urls
.venv/bin/uvicorn backend.app.main:app --host "$app_host" --port "$app_port" &
api_pid=$!
.venv/bin/python -m backend.app.worker &
worker_pid=$!

if wait -n "$api_pid" "$worker_pid"; then
  echo "Salah satu proses berhenti; Lumina dihentikan." >&2
  exit 1
else
  exit $?
fi
