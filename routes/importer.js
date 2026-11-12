'use strict';
// ─── IMPORTACIÓN, DESCARGA INDIVIDUAL, BÚSQUEDA, TAREAS Y LOGS ───────────────
// MEDIA-03 / MEDIA-04 / AUTH-04 / AUTH-05 / AUTH-06.

const express = require('express');
const fsp = require('fs').promises;
const path = require('path');
const ytSearch = require('yt-search');
const { HttpError, requireOwnedPlaylist, requireOwnedSong } = require('../src/http');
const { schemas, validate } = require('../src/validation');
const { ensureUserDir, sanitizeFileStem, resolveSongFile, companionImagePaths, isFile, uniqueFileName, AUDIO_EXTS } = require('../src/paths');
const { validateMediaUrl, isSpotifyCollectionUrl, looksLikeHttpUrl } = require('../src/net/urlPolicy');
const { safeFetch } = require('../src/net/ssrf');
const { describeYtDlpError, SONG_MATCH_FILTER } = require('../src/services/ytdlp');
const { parseSongFileName } = require('../src/services/library');

const MAX_IMPORT_CHARS = 2 * 1024 * 1024;
const MAX_IMPORT_TRACKS = 3000;
const MARKDOWN_NUM_RE = /^\d+[.)]\s+\*{1,2}(.+?)\*{1,2}\s*[–\-—]+\s*(.+)$/;

const normalizeStr = (s) => String(s).toLowerCase().trim().replace(/\s+/g, ' ');

function parseTrackList(text) {
  const trimmed = text.trim();
  if (trimmed.startsWith('{') && trimmed.endsWith('}')) {
    let parsed;
    try { parsed = JSON.parse(trimmed); } catch { throw new Error('Formato JSON no válido'); }
    return Object.values(parsed).map(song => {
      if (!song || typeof song.title !== 'string' || typeof song.artist !== 'string') return null;
      const base = `${song.title} - ${song.artist}`;
      return typeof song.image === 'string' && looksLikeHttpUrl(song.image) ? `${base} | ${song.image}` : base;
    }).filter(Boolean);
  }
  const lines = text.split('\n').map(l => l.trim()).filter(Boolean);
  if (lines.some(l => MARKDOWN_NUM_RE.test(l))) {
    return lines.map(line => {
      const m = MARKDOWN_NUM_RE.exec(line);
      if (m) return `${m[1].trim()} - ${m[2].trim()}`;
      const plain = /^\d+[.)]\s+(.+)$/.exec(line);
      return plain ? plain[1].trim() : null;
    }).filter(Boolean);
  }
  return lines;
}

async function nextOrderPrefix(userDir) {
  let max = 0;
  for (const name of await fsp.readdir(userDir)) {
    const m = /^(\d+)_/.exec(name);
    if (m) {
      const n = Number(m[1]);
      if (n < 9000 && n > max) max = n;
    }
  }
  return max + 1;
}

async function findCoverUrl(user, dir, stem) {
  for (const ext of ['.jpg', '.webp', '.png', '.jpeg']) {
    for (const name of [`${stem}${ext}`, `${stem}.opus${ext}`]) {
      if (await isFile(path.join(dir, name))) return `/api/cover/${user}/${encodeURIComponent(name)}`;
    }
  }
  return null;
}

module.exports = function importerRouter(ctx) {
  const { db, config, log, logger, tasks, ytdlp, library, subtitles, genres, runBackfill, spotify } = ctx;
  const router = express.Router();

  // Una tarea pudo esperar (o reanudarse tras un reinicio): la playlist destino
  // se vuelve a comprobar en el momento de usarla.
  function ownedPlaylistId(user, playlistId) {
    if (!playlistId) return null;
    const row = db.getSync('SELECT id FROM playlists WHERE id = ? AND username = ?', [playlistId, user]);
    return row ? row.id : null;
  }

  async function fetchCover(url, task) {
    if (!url || !looksLikeHttpUrl(url)) return null;
    try {
      const { buffer } = await safeFetch(url, { accept: /^image\//, maxBytes: 5 * 1024 * 1024, timeoutMs: 10000 });
      return buffer;
    } catch (err) {
      if (task) tasks.appendLog(task, `Portada omitida (${err.message})`);
      return null;
    }
  }

  // Registra la canción y la enlaza a la playlist con el siguiente orden.
  async function assignToPlaylist(user, playlistId, fileName) {
    if (!playlistId) return;
    const relativePath = `${user}/${fileName}`;
    const { title, artist, playlistOrder } = parseSongFileName(fileName);
    db.transaction(() => {
      db.runSync(`INSERT INTO songs (title, artist, file_path, username, playlist_order, added_at)
                    VALUES (?, ?, ?, ?, ?, CURRENT_TIMESTAMP) ON CONFLICT(file_path) DO NOTHING`,
      [title, artist, relativePath, user, playlistOrder]);
      const song = db.getSync('SELECT id FROM songs WHERE file_path = ? AND username = ?', [relativePath, user]);
      if (!song) return;
      db.runSync(`INSERT OR IGNORE INTO playlist_songs (playlist_id, song_id, playlist_order)
                    VALUES (?, ?, (SELECT COALESCE(MAX(playlist_order), 0) + 1 FROM playlist_songs WHERE playlist_id = ?))`,
      [playlistId, song.id, playlistId]);
    });
  }

  async function afterDownloads(user) {
    await library.syncUser(user).catch(err => log(`[Biblioteca] ${err.message}`));
    runBackfill();
    genres.classifyGenres(user);
  }

  // ─── Manejadores de trabajos persistentes (FASE 2) ─────────────────────────
  // Se registran en el gestor de tareas para poder reanudarlos tras un reinicio.

  // Importación: { tracksText, playlistId }
  tasks.registerHandler('import', async (task, { tracksText, playlistId }) => {
    const user = task.user;
    const userDir = ensureUserDir(config.musicDir, user);
    const targetPlaylist = ownedPlaylistId(user, playlistId);
    let rawLines;
    const trimmed = tracksText.trim();
    if (isSpotifyCollectionUrl(trimmed)) {
      tasks.appendLog(task, 'URL de Spotify detectada. Leyendo la lista (sin navegador)...');
      const { name, source, lines } = await spotify.fetchCollection(trimmed);
      tasks.appendLog(task, `"${name || 'Sin nombre'}": ${lines.length} canciones leídas (${source === 'web-api' ? 'Web API' : 'reproductor embebido'}).`);
      rawLines = lines;
    } else if (/^https?:\/\//i.test(trimmed) && !trimmed.includes('\n')) {
      throw new Error('Solo se admiten URLs de playlists/álbumes de open.spotify.com');
    } else {
      rawLines = parseTrackList(tracksText);
    }
    rawLines = rawLines.slice(0, MAX_IMPORT_TRACKS);
    tasks.update(task, { total: rawLines.length });
    tasks.appendLog(task, `${rawLines.length} canciones para procesar.`);

    // Deduplicación contra BD y disco (ignorando el prefijo de orden).
    const dbSongs = await db.all('SELECT id, title, artist FROM songs WHERE username = ?', [user]);
    const known = new Set(dbSongs.map(s => normalizeStr(`${s.title} - ${s.artist}`)));
    // Las ya existentes también se añaden a la playlist destino (si no, quedaba incompleta).
    const songIdByNorm = new Map(dbSongs.map(s => [normalizeStr(`${s.title} - ${s.artist}`), s.id]));
    for (const f of await fsp.readdir(userDir)) {
      known.add(normalizeStr(path.basename(f, path.extname(f)).replace(/^\d+_/, '')));
    }

    // El orden continúa tras el mayor prefijo existente: importaciones
    // concurrentes o sucesivas ya no colisionan en "0001_...".
    let order = await nextOrderPrefix(userDir);
    for (let i = 0; i < rawLines.length; i++) {
      let queryText = rawLines[i];
      let coverUrl = '';
      if (queryText.includes(' | ')) {
        const parts = queryText.split(' | ');
        queryText = parts[0].trim();
        coverUrl = parts[1].trim();
      }
      const label = `[${i + 1}/${rawLines.length}]`;
      const norm = normalizeStr(queryText);
      // Nombre tal como queda en disco/BD (sin ':', '$'...): evita duplicados por caracteres saneados.
      const savedNorm = normalizeStr(sanitizeFileStem(queryText));
      if (!queryText || known.has(norm) || known.has(savedNorm)) {
        tasks.bump(task, 'skipped');
        tasks.appendLog(task, `${label} Omitida (ya está en la biblioteca): "${queryText}"`);
        const existingId = songIdByNorm.get(norm) ?? songIdByNorm.get(savedNorm);
        if (targetPlaylist && existingId) {
          db.runSync(`INSERT OR IGNORE INTO playlist_songs (playlist_id, song_id, playlist_order)
                        VALUES (?, ?, (SELECT COALESCE(MAX(playlist_order), 0) + 1 FROM playlist_songs WHERE playlist_id = ?))`,
          [targetPlaylist, existingId, targetPlaylist]);
        }
        continue;
      }
      const stem = `${String(order).padStart(4, '0')}_${sanitizeFileStem(queryText)}`;
      tasks.appendLog(task, `${label} Buscando: "${queryText}"`);
      try {
        const coverBuffer = await fetchCover(coverUrl, task);
        const staging = await ytdlp.downloadToStaging({
          target: `ytsearch1:${queryText} audio`,
          destDir: userDir,
          baseName: stem,
          isUrl: false,
          matchFilter: SONG_MATCH_FILTER,
          coverBuffer,
        });
        const { audioPath } = await staging.commit(userDir, stem);
        known.add(norm);
        known.add(savedNorm);
        order += 1;
        tasks.bump(task, 'done');
        tasks.appendLog(task, `${label} Descargada: ${path.basename(audioPath)}`);
        subtitles.enqueue(audioPath, 'music', false);
        await assignToPlaylist(user, targetPlaylist, path.basename(audioPath));
      } catch (err) {
        tasks.bump(task, 'failed');
        tasks.appendLog(task, `${label} OMITIDA (${describeYtDlpError(err)}): ${queryText}`);
      }
    }
    tasks.appendLog(task, `Terminado: ${task.done} descargadas, ${task.skipped} omitidas, ${task.failed} con error.`);
    await afterDownloads(user);
  });

  // Descarga individual: { mediaUrl, title, artist, coverUrl, playlistId, safeName }
  tasks.registerHandler('download', async (task, { mediaUrl, coverUrl, playlistId, safeName }) => {
    const user = task.user;
    const userDir = ensureUserDir(config.musicDir, user);
    const targetPlaylist = ownedPlaylistId(user, playlistId);
    tasks.update(task, { total: 1 });
    const stem = `9999_${safeName}`;
    if (await isFile(path.join(userDir, `${stem}.opus`))) {
      tasks.appendLog(task, `Ya existía: ${stem}.opus`);
      await assignToPlaylist(user, targetPlaylist, `${stem}.opus`);
      tasks.bump(task, 'skipped');
    } else {
      const staging = await ytdlp.downloadToStaging({
        target: mediaUrl, destDir: userDir, baseName: stem, isUrl: true, coverBuffer: await fetchCover(coverUrl, task),
      });
      const { audioPath } = await staging.commit(userDir, stem);
      subtitles.enqueue(audioPath, 'music', false);
      await assignToPlaylist(user, targetPlaylist, path.basename(audioPath));
      tasks.bump(task, 'done');
      tasks.appendLog(task, `Descargada: ${path.basename(audioPath)}`);
    }
    await afterDownloads(user);
  });

  // Sustitución: { replaceId, mediaUrl, coverUrl, safeName }
  tasks.registerHandler('replace', async (task, { replaceId, mediaUrl, coverUrl, safeName }) => {
    const user = task.user;
    const userDir = ensureUserDir(config.musicDir, user);
    tasks.update(task, { total: 1 });
    // Si un reinicio cortó una sustitución anterior a medias, el original
    // apartado en .staging/replace-<id>-* vuelve a su sitio antes de reintentar.
    await restoreInterruptedReplace(userDir, replaceId, task);
    await replaceSong({ task, user, userDir, songId: replaceId, mediaUrl, coverUrl, safeName });
    await afterDownloads(user);
  });

  async function restoreInterruptedReplace(userDir, songId, task) {
    const stagingRoot = path.join(userDir, '.staging');
    let entries = [];
    try { entries = await fsp.readdir(stagingRoot); } catch { return; }
    const backups = entries.filter(n => n.startsWith(`replace-${songId}-`));
    if (backups.length === 0) return;
    const user = task.user;
    await library.withUserLock(user, async () => {
      const row = await db.get('SELECT id, file_path, username FROM songs WHERE id = ? AND username = ?', [songId, user]);
      const current = row ? await resolveSongFile(config.musicDir, row) : null;
      for (const name of backups) {
        const dir = path.join(stagingRoot, name);
        // La sustitución llegó a completarse: la copia del original sobra.
        if (current) {
          await fsp.rm(dir, { recursive: true, force: true }).catch(() => {});
          continue;
        }
        let restoredAudio = null;
        for (const file of await fsp.readdir(dir).catch(() => [])) {
          const dest = path.join(userDir, file);
          if (await isFile(dest)) continue;
          await fsp.rename(path.join(dir, file), dest).catch(() => {});
          if (AUDIO_EXTS.has(path.extname(file).toLowerCase())) restoredAudio = file;
          tasks.appendLog(task, `Restaurado ${file} de una sustitución interrumpida.`);
        }
        // La fila pudo quedar apuntando al archivo nuevo que nunca llegó.
        if (row && restoredAudio) {
          await db.run('UPDATE songs SET file_path = ?, rev = rev + 1, loudness_lufs = NULL WHERE id = ?', [`${user}/${restoredAudio}`, row.id]);
        }
        await fsp.rm(dir, { recursive: true, force: true }).catch(() => {});
      }
    });
  }

  // ─── /api/import ───────────────────────────────────────────────────────────
  router.post('/import', validate({ body: schemas.import }), async (req, res) => {
    const { tracksText, playlistId } = req.body;
    if (tracksText.length > MAX_IMPORT_CHARS) throw new HttpError(413, 'El texto de importación es demasiado grande');
    const playlist = playlistId ? await requireOwnedPlaylist(db, playlistId, req.user) : null;
    const task = tasks.enqueue(req.user, 'import', { tracksText, playlistId: playlist ? playlist.id : null },
      { playlistId: playlist ? playlist.id : null });
    tasks.appendLog(task, 'Importación recibida y en cola.');
    res.status(202).json({ message: 'Importación en cola', taskId: task.id });
  });

  // ─── /api/download-single (con sustitución atómica) ────────────────────────
  router.post('/download-single', validate({ body: schemas.downloadSingle }), async (req, res) => {
    const { url, title, artist: artistText, coverUrl, replaceId, playlistId } = req.body;
    const mediaUrl = validateMediaUrl(url);
    if (!mediaUrl) throw new HttpError(400, 'Solo se admiten URLs https de YouTube');
    const playlist = playlistId ? await requireOwnedPlaylist(db, playlistId, req.user) : null;
    const oldSong = replaceId ? await requireOwnedSong(db, String(replaceId), req.user, 'id') : null;
    const safeName = sanitizeFileStem(`${title} - ${artistText}`);
    const cover = typeof coverUrl === 'string' && looksLikeHttpUrl(coverUrl) ? coverUrl : null;

    const task = oldSong
      ? tasks.enqueue(req.user, 'replace', { replaceId: oldSong.id, mediaUrl, coverUrl: cover, safeName }, { title, replaceId: oldSong.id })
      : tasks.enqueue(req.user, 'download', { mediaUrl, coverUrl: cover, playlistId: playlist ? playlist.id : null, safeName }, { title, replaceId: null });
    tasks.appendLog(task, `Solicitud: ${title} - ${artistText}${oldSong ? ` (sustituye a ${oldSong.id})` : ''}`);
    res.status(202).json({ message: 'Download queued', taskId: task.id });
  });

  // MEDIA-03: antes se borraba la canción ANTES de descargar la nueva; si la
  // descarga fallaba se perdía para siempre. Ahora:
  //   1) se descarga en staging;
  //   2) con el cerrojo de biblioteca, se aparta el original a una copia,
  //      se actualiza la MISMA fila (conserva id, playlists e historial) y se
  //      mueve la nueva versión a su sitio;
  //   3) si algo falla, se restaura el original.
  async function replaceSong({ task, user, userDir, songId, mediaUrl, coverUrl, safeName }) {
    const staging = await ytdlp.downloadToStaging({
      target: mediaUrl, destDir: userDir, baseName: 'nueva', isUrl: true, coverBuffer: await fetchCover(coverUrl, task),
    });

    await library.withUserLock(user, async () => {
      // La tarea pudo esperar minutos en la cola: se relee la fila DENTRO del
      // cerrojo (otra sustitución o un borrado pueden haberla cambiado).
      const oldSong = await db.get(
        'SELECT id, file_path, username, playlist_order, title, artist, cover_url FROM songs WHERE id = ? AND username = ?',
        [songId, user]
      );
      if (!oldSong) {
        await staging.discard();
        throw new Error('La canción a sustituir ya no existe');
      }
      const order = Number.isFinite(oldSong.playlist_order) && oldSong.playlist_order >= 0 ? oldSong.playlist_order : 9999;
      const desiredStem = `${String(order).padStart(4, '0')}_${safeName}`;
      const oldFile = await resolveSongFile(config.musicDir, oldSong);
      const backupDir = path.join(userDir, '.staging', `replace-${oldSong.id}-${Date.now()}`);
      await fsp.mkdir(backupDir, { recursive: true });
      const movedOld = [];
      const restoreOld = async () => {
        for (const { from, to } of movedOld.reverse()) await fsp.rename(to, from).catch(() => {});
      };
      try {
        if (oldFile) {
          const extras = [...companionImagePaths(oldFile), oldFile.replace(/\.[^/.\\]+$/, '.vtt')];
          for (const p of [oldFile, ...extras]) {
            if (await isFile(p)) {
              const to = path.join(backupDir, path.basename(p));
              await fsp.rename(p, to);
              movedOld.push({ from: p, to });
            }
          }
        }
        const finalName = await uniqueFileName(userDir, desiredStem, '.opus');
        const finalStem = finalName.slice(0, -'.opus'.length);
        const { title: newTitle, artist: newArtist } = parseSongFileName(finalName);

        const { changes } = await db.run(`UPDATE songs SET file_path = ?, title = ?, artist = ?, cover_url = NULL,
                        duration = NULL, chorus_start_ms = NULL, genre = 'Unknown', rev = rev + 1, loudness_lufs = NULL
                      WHERE id = ? AND username = ?`,
        [`${user}/${finalName}`, newTitle, newArtist, oldSong.id, user]);
        if (changes !== 1) throw new Error('No se pudo actualizar la canción a sustituir');
        try {
          const { audioPath } = await staging.commit(userDir, finalStem);
          if (path.basename(audioPath) !== finalName) {
            throw new Error(`yt-dlp generó un nombre inesperado: ${path.basename(audioPath)}`);
          }
        } catch (err) {
          await db.run('UPDATE songs SET file_path = ?, title = ?, artist = ?, cover_url = ?, rev = rev + 1, loudness_lufs = NULL WHERE id = ?',
            [oldSong.file_path, oldSong.title, oldSong.artist, oldSong.cover_url, oldSong.id]);
          throw err;
        }
        const cover = await findCoverUrl(user, userDir, finalStem);
        if (cover) await db.run('UPDATE songs SET cover_url = ? WHERE id = ?', [cover, oldSong.id]);
        await fsp.rm(backupDir, { recursive: true, force: true });
        if (oldFile) subtitles.cancelByPath(oldFile);
        subtitles.enqueue(path.join(userDir, finalName), 'music', false);
        tasks.bump(task, 'done');
        tasks.appendLog(task, `Canción ${oldSong.id} sustituida por ${finalName}`);
      } catch (err) {
        await restoreOld();
        await fsp.rm(backupDir, { recursive: true, force: true }).catch(() => {});
        await staging.discard();
        throw err;
      }
    });
    library.bumpVersion();
  }

  // ─── /api/search ───────────────────────────────────────────────────────────
  router.get('/search', validate({ query: schemas.searchQuery }), async (req, res) => {
    const query = req.valid.query.q;
    try {
      const results = await Promise.race([
        ytSearch(query),
        new Promise((_, reject) => setTimeout(() => reject(new Error('Tiempo de búsqueda agotado')), 20000)),
      ]);
      const videos = (results && results.videos ? results.videos : []).slice(0, 10).map(v => ({
        id: v.videoId,
        title: v.title,
        artist: v.author ? v.author.name : '',
        duration: v.timestamp,
        durationMs: v.duration && Number.isFinite(v.duration.seconds) ? v.duration.seconds * 1000 : null,
        coverUrl: v.image || v.thumbnail || null,
        url: v.url,
      }));
      res.json(videos);
    } catch (err) {
      log(`[Búsqueda] Error: ${err.message}`);
      throw new HttpError(502, 'La búsqueda ha fallado');
    }
  });

  // ─── Tareas y logs ─────────────────────────────────────────────────────────
  router.get('/tasks', (req, res) => {
    res.json(tasks.list(req.user).map(t => tasks.serialize(t)));
  });

  router.get('/tasks/:id', validate({ params: schemas.taskIdParams }), (req, res) => {
    const task = tasks.get(req.user, req.valid.params.id);
    if (!task) throw new HttpError(404, 'Tarea no encontrada');
    res.json(tasks.serialize(task, { withLogs: true }));
  });

  // AUTH-06: el log completo del sistema solo para administradores; el resto
  // ve únicamente el progreso de sus propias tareas.
  router.get('/logs', async (req, res) => {
    if (req.isAdmin) return res.json({ logs: (await logger.tail(200)) || 'No logs yet.', scope: 'system' });
    return res.json({ logs: tasks.userLogText(req.user) || 'Sin actividad reciente.', scope: 'user' });
  });

  return router;
};

module.exports.parseTrackList = parseTrackList;
