#!/usr/bin/env node
'use strict';
// ─── RELLENO DE TRANSCRIPCIONES PARA CANCIONES EXISTENTES ────────────────────
// Solo ENCOLA (tabla transcriptions, estado pending); las procesa una a una el
// worker local del servidor (TRANSCRIBE_LOCAL), que revisa la cola cada minuto.
//
//   node scripts/transcribe-backfill.js --limite 2              → 2 canciones sin transcribir
//   node scripts/transcribe-backfill.js --ids 12,40             → canciones concretas
//   node scripts/transcribe-backfill.js --todas                 → toda la biblioteca
// Opciones: --usuario <nombre>, --solo-sin-letra (sin .vtt), --reintentar-errores,
//           --simular (no escribe nada), --estado (resumen de la cola).
// Una de --limite, --ids o --todas es obligatoria: así nunca se encola toda la
// biblioteca por accidente (~45 s de CPU por canción con el modelo small).

require('dotenv').config();
const path = require('path');
const { openDatabase } = require('../src/db');
const { resolveSongFile, isFile } = require('../src/paths');

const ROOT = path.resolve(__dirname, '..');

function parseArgs(argv) {
  const args = { limit: null, ids: null, all: false, user: null, onlyMissing: false, retry: false, dryRun: false, status: false };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--limite') args.limit = Number(argv[++i]);
    else if (a === '--ids') args.ids = String(argv[++i] || '').split(',').map(Number).filter(Number.isInteger);
    else if (a === '--todas') args.all = true;
    else if (a === '--usuario') args.user = argv[++i];
    else if (a === '--solo-sin-letra') args.onlyMissing = true;
    else if (a === '--reintentar-errores') args.retry = true;
    else if (a === '--simular') args.dryRun = true;
    else if (a === '--estado') args.status = true;
    else throw new Error(`Opción desconocida: ${a}`);
  }
  if (!args.status && !args.all && !args.ids && !(args.limit > 0)) {
    throw new Error('Indica --limite N, --ids a,b o --todas');
  }
  return args;
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  const db = await openDatabase(path.resolve(ROOT, process.env.DB_PATH || 'database.sqlite'));
  try {
    const table = await db.get("SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'transcriptions'");
    if (!table) throw new Error('No existe la tabla transcriptions: arranca antes el servidor para que migre la BD');

    if (args.status) {
      const rows = await db.all('SELECT status, COUNT(*) AS n FROM transcriptions GROUP BY status');
      console.log(rows.length ? rows.map(r => `${r.status}: ${r.n}`).join('\n') : 'Cola vacía');
      return;
    }

    const musicDir = path.resolve(ROOT, process.env.MUSIC_DIR || 'music');
    const where = [];
    const params = [];
    if (args.user) { where.push('username = ?'); params.push(args.user); }
    if (args.ids) { where.push(`id IN (${args.ids.map(() => '?').join(',')})`); params.push(...args.ids); }
    const songs = await db.all(`SELECT id, title, artist, file_path, username FROM songs ${where.length ? `WHERE ${where.join(' AND ')}` : ''} ORDER BY id`, params);

    let queued = 0;
    for (const song of songs) {
      if (args.limit > 0 && queued >= args.limit) break;
      const file = await resolveSongFile(musicDir, song);
      if (!file) continue;
      if (args.onlyMissing && await isFile(file.replace(/\.[^/.\\]+$/, '.vtt'))) continue;
      const existing = await db.get('SELECT status FROM transcriptions WHERE file_path = ?', [file]);
      if (existing && !(args.retry && existing.status === 'error')) continue;
      console.log(`${args.dryRun ? '[simulación] ' : ''}En cola #${song.id} ${song.artist || ''} - ${song.title || path.basename(file)}`);
      if (!args.dryRun) {
        await db.run(
          `INSERT INTO transcriptions (file_path, kind, status) VALUES (?, 'music', 'pending')
           ON CONFLICT(file_path) DO UPDATE SET status = 'pending', error = NULL, updated_at = datetime('now')`,
          [file],
        );
      }
      queued += 1;
    }
    console.log(`${queued} canción(es) ${args.dryRun ? 'se encolarían' : 'encoladas'}. El worker del servidor las procesa una a una.`);
  } finally {
    await db.close();
  }
}

main().catch((err) => {
  console.error(err.message);
  process.exit(1);
});
