#!/usr/bin/env bash
# Desarrollo local: API en :3001 y Vite (con proxy /api) en :8084.
set -euo pipefail
cd "$(dirname "${BASH_SOURCE[0]}")"
node server.js &
API_PID=$!
trap 'kill $API_PID 2>/dev/null || true' EXIT
cd frontend && npm run dev
