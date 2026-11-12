#!/usr/bin/env bash
# ─── ARRANQUE EN PRODUCCIÓN (DEP-01) ─────────────────────────────────────────
# Un único proceso PM2: Express sirve la API y el frontend compilado.
# (Antes se lanzaba el servidor de desarrollo de Vite con nohup.)
# Para desarrollo local usa:  bash dev.sh
set -euo pipefail
cd "$(dirname "${BASH_SOURCE[0]}")"

[[ -f .env ]] || { echo "Falta .env. Ejecuta: npm install && npm run setup" >&2; exit 1; }
if [[ ! -f frontend/dist/index.html ]]; then
  echo "-> Compilando el frontend (no existe frontend/dist)"
  (cd frontend && if [[ -f package-lock.json ]]; then npm ci; else npm install; fi && npm run build)
fi

if command -v pm2 >/dev/null; then
  pm2 startOrReload ecosystem.config.js --update-env
  pm2 save >/dev/null
  echo "MusicaPrivada en marcha con PM2 (pm2 logs musica-privada)."
else
  echo "PM2 no está instalado; arrancando en primer plano."
  exec node server.js
fi
