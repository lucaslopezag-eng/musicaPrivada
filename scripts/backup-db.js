#!/usr/bin/env node
'use strict';
// ─── COPIA DE SEGURIDAD EN CALIENTE DE SQLITE (DEP-01) ───────────────────────
// Usa la API de backup de SQLite: la copia es consistente aunque el servidor
// esté escribiendo (WAL). Sustituye al "cp database.sqlite" del antiguo bajar.sh.
//
//   npm run backup                  → backups/database-AAAAMMDD-HHMMSS.sqlite
//   node scripts/backup-db.js <destino.sqlite>
// Conserva las últimas BACKUP_KEEP copias (por defecto 10).

require('dotenv').config();
const fs = require('fs');
const path = require('path');
const { openDatabase } = require('../src/db');

const ROOT = path.resolve(__dirname, '..');

async function main() {
  const source = path.resolve(ROOT, process.env.DB_PATH || 'database.sqlite');
  if (!fs.existsSync(source)) {
    console.error(`No existe la base de datos: ${source}`);
    process.exit(1);
  }
  const backupsDir = path.join(ROOT, 'backups');
  const stamp = new Date().toISOString().replace(/[-:]/g, '').replace('T', '-').slice(0, 15);
  const dest = process.argv[2] ? path.resolve(process.argv[2]) : path.join(backupsDir, `database-${stamp}.sqlite`);
  fs.mkdirSync(path.dirname(dest), { recursive: true });
  if (fs.existsSync(dest)) {
    console.error(`El destino ya existe: ${dest}`);
    process.exit(1);
  }

  const db = await openDatabase(source);
  try {
    await db.backup(dest);
    // Solo lectura: verificar la copia no debe modificarla (p. ej. pasarla a WAL).
    const check = await openDatabase(dest, { readonly: true });
    const row = await check.get('PRAGMA integrity_check');
    await check.close();
    if (!row || row.integrity_check !== 'ok') throw new Error(`integrity_check: ${JSON.stringify(row)}`);
  } finally {
    await db.close();
  }
  console.log(`Copia creada: ${dest}`);

  if (!process.argv[2]) {
    const keep = Math.max(1, Number.parseInt(process.env.BACKUP_KEEP || '10', 10) || 10);
    const files = fs.readdirSync(backupsDir).filter(f => /^database-\d{8}-\d{6}\.sqlite$/.test(f)).sort();
    for (const old of files.slice(0, Math.max(0, files.length - keep))) {
      fs.rmSync(path.join(backupsDir, old), { force: true });
    }
  }
}

main().catch((err) => {
  console.error(`Error en la copia de seguridad: ${err.message}`);
  process.exit(1);
});
