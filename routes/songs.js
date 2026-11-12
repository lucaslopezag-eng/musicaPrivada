'use strict';
// ─── CANCIONES DE LA BIBLIOTECA ──────────────────────────────────────────────

const express = require('express');
const fsp = require('fs').promises;
const path = require('path');
const crypto = require('crypto');
const { spawn } = require('child_process');
const { HttpError, requireOwnedSong, publicSong } = require('../src/http');
const { resolveSongFile, companionImagePaths, isFile } = require('../src/paths');
const { shiftVtt } = require('../src/media/vtt');
const { schemas, validate } = require('../src/validation');

// Códec por extensión: el recorte se re-codifica para cortar con precisión de
// muestra (con "-c copy" Opus solo puede cortar en páginas/keyframes).
const TRIM_CODECS = {
  '.opus': ['-c:a', 'libopus', '-b:a', '160k'],
  '.webm': ['-c:a', 'libopus', '-b:a', '160k'],
  '.ogg': ['-c:a', 'libvorbis', '-q:a', '6'],
  '.mp3': ['-c:a', 'libmp3lame', '-q:a', '2'],
  '.m4a': ['-c:a', 'aac', '-b:a', '192k'],
  '.flac': ['-c:a', 'flac'],
  '.wav': ['-c:a', 'pcm_s16le'],
};

function runFfmpeg(ffmpegPath, args, log) {
  return new Promise((resolve, reject) => {
    const child = spawn(ffmpegPath, args, { windowsHide: true });
    let stderr = '';
    child.stderr.on('data', d => { stderr = (stderr + d).slice(-20000); });
    const timer = setTimeout(() => child.kill('SIGKILL'), 10 * 60 * 1000);
    child.on('error', (err) => { clearTimeout(timer); reject(err); });
    child.on('close', (code) => {
      clearTimeout(timer);
      if (code === 0) return resolve();
      log(`[FFmpeg] ${stderr.split('\n').slice(-5).join(' | ')}`);
      reject(new Error(`FFmpeg terminó con código ${code}`));
    });
  });
}

module.exports = function songsRouter({ db, config, log, library, genres, subtitles, probeDurationMs, ffmpegPath, runBackfill }) {
  const router = express.Router();
  const busySongs = new Set();

  router.get('/songs/version', (req, res) => {
    res.json({ version: library.version });
  });

  router.get('/songs', async (req, res) => {
    const rows = await db.all('SELECT * FROM songs WHERE username = ? ORDER BY playlist_order ASC, id ASC', [req.user]);
    // Comprobación asíncrona en paralelo (antes: existsSync en bucle) y sin
    // enviar rutas absolutas del servidor al cliente (UI-04).
    const present = await Promise.all(rows.map(row => resolveSongFile(config.musicDir, row)));
    const missing = present.filter(p => !p).length;
    if (missing > 0) log(`[Canciones] ${missing} canciones de ${req.user} no tienen archivo en disco.`);
    res.json(rows.filter((_, i) => present[i]).map(publicSong));
  });

  router.post('/playlist/reorder', validate({ body: schemas.reorder }), async (req, res) => {
    const { orderedIds } = req.body;
    db.transaction(() => {
      for (let index = 0; index < orderedIds.length; index++) {
        db.runSync('UPDATE songs SET playlist_order = ? WHERE id = ? AND username = ?', [index, orderedIds[index], req.user]);
      }
    });
    library.bumpVersion();
    res.json({ success: true });
  });

  router.delete('/songs/:id', validate({ params: schemas.idParams }), async (req, res) => {
    const row = await requireOwnedSong(db, req.params.id, req.user, 'id, file_path, username');
    await library.withUserLock(req.user, async () => {
      const file = await resolveSongFile(config.musicDir, row);
      if (file) {
        // Si el audio no se puede borrar, no se toca la BD (volvería a aparecer).
        await fsp.unlink(file);
        subtitles.cancelByPath(file);
        const extras = [...companionImagePaths(file), file.replace(/\.[^/.\\]+$/, '.vtt')];
        await Promise.all(extras.map(p => fsp.rm(p, { force: true }).catch(() => {})));
      }
      db.transaction(() => {
        db.runSync('DELETE FROM playlist_songs WHERE song_id = ?', [row.id]);
        db.runSync('DELETE FROM songs WHERE id = ? AND username = ?', [row.id, req.user]);
      });
    });
    library.bumpVersion();
    log(`[Borrar] Canción ${row.id} eliminada de la BD y del disco (${req.user}).`);
    res.json({ message: 'Deleted' });
  });

  // ─── Recorte atómico (MEDIA-03) ────────────────────────────────────────────
  router.post('/songs/:id/trim', validate({ params: schemas.idParams, body: schemas.trim }), async (req, res) => {
    const { startTime, endTime, rev: expectedRev } = req.body;
    const { id: songId } = await requireOwnedSong(db, req.params.id, req.user, 'id');
    if (busySongs.has(songId)) throw new HttpError(409, 'Ya hay una operación en curso sobre esta canción');
    busySongs.add(songId);
    try {
      const result = await library.withUserLock(req.user, async () => {
        // Se relee dentro del cerrojo: una sustitución pudo cambiar el archivo
        // mientras el usuario elegía los puntos de corte.
        const row = await db.get('SELECT id, file_path, username, chorus_start_ms, rev FROM songs WHERE id = ? AND username = ?', [songId, req.user]);
        if (!row) throw new HttpError(404, 'Canción no encontrada');
        if (expectedRev !== undefined && expectedRev !== null && Number(expectedRev) !== Number(row.rev || 0)) {
          throw new HttpError(409, 'La canción ha cambiado desde que abriste el editor; vuelve a abrirlo');
        }
        const file = await resolveSongFile(config.musicDir, row);
        if (!file) throw new HttpError(404, 'Archivo no encontrado');
        const ext = path.extname(file).toLowerCase();
        const codec = TRIM_CODECS[ext];
        if (!codec) throw new HttpError(415, `Formato no soportado para recorte: ${ext}`);

        const dir = path.dirname(file);
        const tag = crypto.randomBytes(4).toString('hex');
        const tmpOut = path.join(dir, `.trim-${tag}${ext}`);
        const backup = path.join(dir, `.backup-${tag}${ext}`);
        const duration = endTime - startTime;

        log(`[Recorte] Canción ${row.id}: ${startTime}s → ${endTime}s`);
        try {
          await runFfmpeg(ffmpegPath, [
            '-hide_banner', '-nostdin', '-y', '-i', file,
            '-ss', startTime.toFixed(3), '-t', duration.toFixed(3),
            '-vn', '-map_metadata', '0', ...codec, tmpOut,
          ], log);
          const { size } = await fsp.stat(tmpOut);
          if (size === 0) throw new Error('El archivo recortado está vacío');
        } catch (err) {
          await fsp.rm(tmpOut, { force: true }).catch(() => {});
          throw err;
        }

        // Sustitución atómica: original → copia de seguridad, recorte → original.
        await fsp.rename(file, backup);
        try {
          await fsp.rename(tmpOut, file);
        } catch (err) {
          await fsp.rename(backup, file).catch(() => {});
          await fsp.rm(tmpOut, { force: true }).catch(() => {});
          throw err;
        }
        await fsp.rm(backup, { force: true }).catch(() => {});
        subtitles.cancelByPath(file);

        // Subtítulos: se desplazan para seguir sincronizados.
        const vttPath = file.replace(/\.[^/.\\]+$/, '.vtt');
        if (await isFile(vttPath)) {
          try {
            const shifted = shiftVtt(await fsp.readFile(vttPath, 'utf8'), startTime, duration);
            const tmpVtt = `${vttPath}.${tag}.tmp`;
            await fsp.writeFile(tmpVtt, shifted, 'utf8');
            await fsp.rename(tmpVtt, vttPath);
          } catch (err) {
            log(`[Recorte] No se pudieron ajustar los subtítulos: ${err.message}`);
          }
        }

        const newDurationMs = (await probeDurationMs(file).catch(() => null)) || Math.round(duration * 1000);
        let chorus = row.chorus_start_ms;
        if (Number.isFinite(chorus)) {
          chorus = chorus - Math.round(startTime * 1000);
          if (chorus < 0 || chorus >= newDurationMs) chorus = Math.floor(newDurationMs * 0.3);
        }
        await db.run('UPDATE songs SET duration = ?, chorus_start_ms = ?, rev = rev + 1, loudness_lufs = NULL WHERE id = ?',
          [newDurationMs, Number.isFinite(chorus) ? chorus : null, row.id]);
        return db.get('SELECT rev, duration FROM songs WHERE id = ?', [row.id]);
      });
      library.bumpVersion();
      log(`[Recorte] Canción ${songId} recortada correctamente.`);
      res.json({ message: 'Song trimmed successfully.', rev: result.rev, duration: result.duration });
    } finally {
      busySongs.delete(songId);
    }
  });

  router.get('/songs/:id/duration', validate({ params: schemas.idParams }), async (req, res) => {
    const row = await requireOwnedSong(db, req.params.id, req.user, 'id, file_path, username, duration');
    const file = await resolveSongFile(config.musicDir, row);
    if (!file) throw new HttpError(404, 'Archivo no encontrado');
    const ms = (await probeDurationMs(file).catch(() => null)) || row.duration || 0;
    res.json({ duration: ms / 1000 });
  });

  router.post('/songs/fix-genres', (req, res) => {
    const alreadyRunning = genres.isRunning(req.user);
    genres.classifyGenres(req.user);
    res.json({ message: alreadyRunning ? 'La clasificación ya está en curso.' : 'Clasificación de géneros iniciada.' });
  });

  router.post('/sync', async (req, res) => {
    const result = await library.syncUser(req.user);
    runBackfill();
    res.json({ message: 'Sync completed.', ...(result || {}) });
  });

  return router;
};
