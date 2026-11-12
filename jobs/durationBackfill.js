'use strict';
// ─── RELLENO DE DURACIONES (DB-02) ───────────────────────────────────────────
// Antes: exec() con interpolación en shell (inyección de comandos) y decodificado
// completo de cada archivo en cada arranque. Ahora: lectura de cabeceras sin
// shell, nunca concurrente consigo mismo y solo para canciones sin duración.

const { resolveSongFile } = require('../src/paths');

let running = null;

async function backfill({ db, musicDir, probeDurationMs, log }) {
  const songs = await db.all('SELECT id, file_path, username FROM songs WHERE duration IS NULL OR duration = 0');
  if (songs.length === 0) return 0;
  log(`[Backfill] ${songs.length} canciones sin duración. Procesando...`);

  let processed = 0;
  for (const song of songs) {
    const file = await resolveSongFile(musicDir, song);
    if (!file) continue;
    const durationMs = await probeDurationMs(file).catch(() => null);
    if (durationMs) {
      // El estribillo por defecto (30 %) solo se fija si no había uno.
      await db.run(
        'UPDATE songs SET duration = ?, chorus_start_ms = COALESCE(chorus_start_ms, ?) WHERE id = ?',
        [durationMs, Math.floor(durationMs * 0.3), song.id]
      );
      processed += 1;
      if (processed % 25 === 0) log(`[Backfill] Progreso: ${processed}/${songs.length}`);
    }
    // Pequeña pausa para no saturar la CPU de una Raspberry/VPS.
    await new Promise(r => setTimeout(r, 25));
  }
  log(`[Backfill] Completado: ${processed} canciones actualizadas.`);
  return processed;
}

// Si ya hay una ejecución en curso, se devuelve esa misma promesa.
module.exports = function runDurationBackfill(deps) {
  if (!running) {
    running = backfill(deps)
      .catch(err => { deps.log(`[Backfill] Error: ${err.message}`); return 0; })
      .finally(() => { running = null; });
  }
  return running;
};
