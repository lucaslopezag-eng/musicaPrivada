#!/usr/bin/env node
'use strict';
// Elimina de la BD las canciones cuyo archivo ya no existe (y sus filas en
// playlist_songs). Hace una copia de seguridad antes. Ejecutar con el servidor
// parado o en un momento sin actividad:  node tools/clean.js [--dry-run]

require('dotenv').config({ path: require('path').resolve(__dirname, '..', '.env') });
const path = require('path');
const { openDatabase } = require('../src/db');
const { resolveSongFile } = require('../src/paths');

const ROOT = path.resolve(__dirname, '..');
const dryRun = process.argv.includes('--dry-run');

(async () => {
  const db = await openDatabase(path.resolve(ROOT, process.env.DB_PATH || 'database.sqlite'));
  const musicDir = path.resolve(ROOT, process.env.MUSIC_DIR || 'music');
  try {
    const rows = await db.all('SELECT id, file_path, username FROM songs');
    const ghosts = [];
    for (const row of rows) {
      if (!(await resolveSongFile(musicDir, row))) ghosts.push(row);
    }
    console.log(`${ghosts.length} canciones sin archivo de ${rows.length}.`);
    if (dryRun || ghosts.length === 0) return;
    const backup = path.join(ROOT, 'backups', `before-clean-${Date.now()}.sqlite`);
    require('fs').mkdirSync(path.dirname(backup), { recursive: true });
    await db.backup(backup);
    console.log(`Copia de seguridad: ${backup}`);
    db.transaction(() => {
      for (const g of ghosts) {
        db.runSync('DELETE FROM playlist_songs WHERE song_id = ?', [g.id]);
        db.runSync('DELETE FROM songs WHERE id = ?', [g.id]);
        console.log(`Eliminada canción fantasma ${g.id}: ${g.file_path}`);
      }
    });
  } finally {
    await db.close();
  }
})().catch((err) => { console.error(err); process.exit(1); });
