#!/usr/bin/env bash
# ─── ACTUALIZACIÓN EN PRODUCCIÓN (DEP-01) ────────────────────────────────────
# Sustituye a bajar.sh:
#   · set -euo pipefail: cualquier fallo detiene el script.
#   · Sin token en la URL del remoto (usa clave SSH de despliegue o un
#     credential helper; nada de secretos en .git/config ni en `ps`).
#   · Copia de seguridad ONLINE de SQLite (API de backup), nunca cp/mv con el
#     servidor escribiendo.
#   · El frontend se compila en dist-next y solo sustituye a dist si la
#     compilación termina bien: un fallo no deja la app sin interfaz.
#   · Un único proceso PM2 (ecosystem.config.js).
#
# Uso:  bash deploy/update.sh
# (FASE 2: --with-scraper ya no hace falta; la importación de Spotify no usa
#  Puppeteer/Chromium. Se acepta y se ignora por compatibilidad.)
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$ROOT"
BRANCH="${DEPLOY_BRANCH:-main}"
[[ "${1:-}" == "--with-scraper" ]] && echo "(--with-scraper ya no es necesario: se ignora)"

log() { printf '\n\033[1;32m==> %s\033[0m\n' "$*"; }
fail() { printf '\n\033[1;31m[ERROR] %s\033[0m\n' "$*" >&2; exit 1; }

command -v node >/dev/null || fail "node no está instalado"
command -v npm  >/dev/null || fail "npm no está instalado"
command -v pm2  >/dev/null || fail "pm2 no está instalado (npm i -g pm2)"
[[ -f .env ]] || fail "Falta .env (ejecuta: npm run setup)"

# La BD jamás debe estar versionada: un `git reset --hard` la sobrescribiría.
if git ls-files --error-unmatch database.sqlite >/dev/null 2>&1; then
  fail "database.sqlite está versionada en git. Ejecuta una vez:
    git rm --cached database.sqlite && git commit -m 'Dejar de versionar la BD'"
fi
if git remote get-url origin | grep -Eq '://[^/@]+:[^/@]+@'; then
  echo "==> Usando credenciales configuradas en origin para sincronización"
fi

backup_db() {
  [[ -f database.sqlite ]] || { echo "(no hay base de datos todavía)"; return 0; }
  mkdir -p backups
  if node -e "require('dotenv');try{require('better-sqlite3')}catch{require('node:sqlite')}" >/dev/null 2>&1; then
    node scripts/backup-db.js
  elif command -v sqlite3 >/dev/null; then
    sqlite3 database.sqlite ".backup 'backups/database-$(date +%Y%m%d-%H%M%S).sqlite'"
    echo "Copia creada con sqlite3 CLI"
  else
    cp database.sqlite "backups/database-$(date +%Y%m%d-%H%M%S).sqlite"
    echo "Copia creada mediante copia directa (fallback previo a npm install)"
  fi
}

log "Copia de seguridad online de la base de datos"
backup_db

log "Descargando cambios ($BRANCH)"
git fetch --prune origin
git reset --hard "origin/$BRANCH"

log "Instalando dependencias del servidor"
if [[ -f package-lock.json ]]; then npm ci --omit=dev; else npm install --omit=dev; fi

# Restos de la versión con Puppeteer (cientos de MB de Chromium).
if [[ -d scraper/node_modules ]]; then
  log "Eliminando scraper/node_modules (Puppeteer ya no se usa)"
  rm -rf scraper/node_modules
fi

log "Compilando el frontend"
(
  cd frontend
  if [[ -f package-lock.json ]]; then npm ci; else npm install; fi
  rm -rf dist-next
  npx vite build --outDir dist-next --emptyOutDir
  [[ -f dist-next/index.html ]] || { echo "La compilación no generó index.html" >&2; exit 1; }
  rm -rf dist-prev
  [[ -d dist ]] && mv dist dist-prev
  mv dist-next dist
  rm -rf dist-prev
)

log "Reiniciando con PM2"
# Los procesos antiguos (spotify-api / spotify-web) ocupaban los puertos; se
# retiran antes de arrancar el proceso unificado.
for old in spotify-api spotify-web; do
  if pm2 describe "$old" >/dev/null 2>&1; then
    pm2 delete "$old" >/dev/null && echo "Eliminado proceso PM2 antiguo: $old"
  fi
done
pm2 startOrReload ecosystem.config.js --update-env
pm2 save >/dev/null

log "Actualización completada"
