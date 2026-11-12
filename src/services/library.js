'use strict';
// ─── SINCRONIZACIÓN DE LA BIBLIOTECA (DB-01 / DB-04) ─────────────────────────
// · Upsert NO destructivo: ON CONFLICT(file_path) DO UPDATE solo toca título,
//   artista y portada. Se conservan duration, genre, chorus_start_ms,
//   playlist_order (orden manual), discovered_via y added_at.
// · Todo el lote de un usuario va en UNA transacción.
// · fs.watch filtra por usuario y extensión: un .vtt o una descarga en staging
//   ya no disparan una resincronización completa.

const fs = require('fs');
const fsp = fs.promises;
const path = require('path');
const { ensureUserDir, AUDIO_EXTS, IMAGE_EXTS, isValidUsername } = require('../paths');

const UPSERT_SQL = `
  INSERT INTO songs (title, artist, file_path, cover_url, playlist_order, username, added_at)
  VALUES (?, ?, ?, ?, ?, ?, CURRENT_TIMESTAMP)
  ON CONFLICT(file_path) DO UPDATE SET
    title = excluded.title,
    artist = excluded.artist,
    cover_url = COALESCE(excluded.cover_url, songs.cover_url)
  WHERE songs.title IS NOT excluded.title
     OR songs.artist IS NOT excluded.artist
     OR (excluded.cover_url IS NOT NULL AND songs.cover_url IS NOT excluded.cover_url)
`;

const DEFAULT_PLAYLIST = 'Mi Biblioteca';

// "0001_Never Gonna Give You Up - Rick Astley.opus" → título/artista/orden.
function parseSongFileName(songFile) {
  const fullBaseName = path.basename(songFile, path.extname(songFile));
  const cleanName = fullBaseName.replace(/^\d+_/, '');
  let title = cleanName;
  let artist = 'Unknown Artist';
  if (cleanName.includes(' - ')) {
    const parts = cleanName.split(' - ');
    artist = parts.pop().trim();
    title = parts.join(' - ').trim();
  }
  const orderMatch = /^(\d+)_/.exec(songFile);
  const playlistOrder = orderMatch ? Number.parseInt(orderMatch[1], 10) : 9999;
  return { title, artist, playlistOrder, fullBaseName };
}

function findCover(fileNames, user, songFile, fullBaseName) {
  for (const ext of IMAGE_EXTS) {
    if (fileNames.has(fullBaseName + ext)) return `/api/cover/${user}/${encodeURIComponent(fullBaseName + ext)}`;
    if (fileNames.has(songFile + ext)) return `/api/cover/${user}/${encodeURIComponent(songFile + ext)}`;
  }
  return null;
}

function createLibrary({ db, config, log, users: userStore, onSongsAdded = () => {} }) {
  // FASE 2: la lista de usuarios sale de la tabla `users` en cada uso.
  const listUsers = () => userStore.list();
  const defaultPlaylistOf = (user) => userStore.defaultPlaylist(user) || DEFAULT_PLAYLIST;
  const userExists = (user) => isValidUsername(user) && userStore.has(user);
  let version = Date.now();
  const locks = new Map();
  let watcher = null;
  let debounceTimer = null;
  const pendingUsers = new Set();

  function bumpVersion() {
    version = Math.max(Date.now(), version + 1);
    return version;
  }

  async function scanUser(user) {
    const dir = ensureUserDir(config.musicDir, user);
    const entries = await fsp.readdir(dir, { withFileTypes: true });
    const fileNames = new Set(entries.filter(e => e.isFile()).map(e => e.name));
    const audioFiles = [...fileNames].filter(f => !f.startsWith('.') && AUDIO_EXTS.has(path.extname(f).toLowerCase()));

    let changed = false;
    let inserted = 0;
    db.transaction(() => {
      for (const songFile of audioFiles) {
        const { title, artist, playlistOrder, fullBaseName } = parseSongFileName(songFile);
        const coverUrl = findCover(fileNames, user, songFile, fullBaseName);
        const relativePath = `${user}/${songFile}`;
        const before = db.getSync('SELECT id FROM songs WHERE file_path = ?', [relativePath]);
        const { changes } = db.runSync(UPSERT_SQL, [title, artist, relativePath, coverUrl, playlistOrder, user]);
        if (changes > 0) {
          changed = true;
          if (!before) inserted += 1;
        }
      }
      // Canciones sin ninguna playlist → playlist por defecto de su propietario ("Mi Biblioteca" salvo ajuste).
      const defaultName = defaultPlaylistOf(user);
      const { changes } = db.runSync(`
        INSERT OR IGNORE INTO playlist_songs (playlist_id, song_id, playlist_order)
        SELECT p.id, s.id, s.playlist_order
        FROM songs s
        JOIN playlists p ON p.username = s.username AND p.name = ?
        WHERE s.username = ?
          AND p.id = (SELECT MIN(id) FROM playlists WHERE username = s.username AND name = ?)
          AND NOT EXISTS (SELECT 1 FROM playlist_songs ps WHERE ps.song_id = s.id)
      `, [defaultName, user, defaultName]);
      if (changes > 0) changed = true;
    });

    if (changed) bumpVersion();
    if (inserted > 0) onSongsAdded(user, inserted);
    return { changed, inserted, total: audioFiles.length };
  }

  // Ejecuta fn con el cerrojo de biblioteca del usuario: ninguna sincronización
  // puede intercalarse (se usa al sustituir/recortar archivos).
  function withUserLock(user, fn) {
    if (!userExists(user)) return Promise.reject(new Error('Usuario no válido'));
    const previous = locks.get(user) || Promise.resolve();
    const next = previous.then(fn);
    locks.set(user, next.catch(() => {}));
    return next;
  }

  // Serializa las sincronizaciones de un mismo usuario.
  function syncUser(user) {
    if (!userExists(user)) return Promise.resolve(null);
    return withUserLock(user, () => scanUser(user));
  }

  async function ensureDefaultPlaylists() {
    for (const user of listUsers()) {
      const hasSongs = await db.get('SELECT 1 AS x FROM songs WHERE username = ? LIMIT 1', [user]);
      if (!hasSongs) continue;
      const hasPlaylist = await db.get('SELECT id FROM playlists WHERE username = ? LIMIT 1', [user]);
      if (!hasPlaylist) {
        const name = defaultPlaylistOf(user);
        await db.run('INSERT INTO playlists (name, username) VALUES (?, ?)', [name, user]);
        log(`[Biblioteca] Creada la playlist "${name}" para ${user}`);
      }
    }
  }

  // Restos de descargas interrumpidas por un reinicio (más de 6 h).
  async function cleanupStaging() {
    const limit = Date.now() - 6 * 60 * 60 * 1000;
    for (const root of [config.musicDir, config.aiMusicDir]) {
      for (const user of listUsers()) {
        const staging = path.join(root, user, '.staging');
        let entries = [];
        try { entries = await fsp.readdir(staging); } catch { continue; }
        for (const name of entries) {
          const full = path.join(staging, name);
          try {
            const st = await fsp.stat(full);
            if (st.mtimeMs < limit) await fsp.rm(full, { recursive: true, force: true });
          } catch { /* ya eliminado */ }
        }
      }
    }
  }

  async function syncAll() {
    await cleanupStaging().catch(err => log(`[Biblioteca] Limpieza de staging: ${err.message}`));
    for (const user of listUsers()) {
      try {
        await syncUser(user);
      } catch (err) {
        log(`[Biblioteca] Error sincronizando ${user}: ${err.message}`);
      }
    }
    await ensureDefaultPlaylists();
    // Segunda pasada: asigna a "Mi Biblioteca" recién creada.
    for (const user of listUsers()) await syncUser(user).catch(() => {});
  }

  function scheduleSync(user) {
    pendingUsers.add(user);
    if (debounceTimer) clearTimeout(debounceTimer);
    debounceTimer = setTimeout(() => {
      debounceTimer = null;
      const batch = [...pendingUsers];
      pendingUsers.clear();
      for (const u of batch) {
        syncUser(u).catch(err => log(`[Biblioteca] Error sincronizando ${u}: ${err.message}`));
      }
    }, 2000);
  }

  function relevantChange(relPath) {
    const parts = relPath.split(/[\\/]/).filter(Boolean);
    if (parts.length !== 2) return null; // solo archivos directos de music/<usuario>/
    const [user, file] = parts;
    if (!userExists(user) || file.startsWith('.')) return null;
    const ext = path.extname(file).toLowerCase();
    if (!AUDIO_EXTS.has(ext) && !IMAGE_EXTS.includes(ext)) return null;
    return user;
  }

  function startWatcher() {
    for (const user of listUsers()) ensureUserDir(config.musicDir, user);
    const onEvent = (prefix) => (_event, filename) => {
      if (!filename) { listUsers().forEach(scheduleSync); return; }
      const user = relevantChange(prefix ? `${prefix}/${filename}` : String(filename));
      if (user) scheduleSync(user);
    };
    try {
      watcher = fs.watch(config.musicDir, { recursive: true }, onEvent(null));
      watcher.on('error', err => log(`[Watcher] Error: ${err.message}`));
    } catch (err) {
      // Plataformas sin soporte recursivo: un watcher por usuario.
      log(`[Watcher] Recursivo no disponible (${err.code || err.message}); vigilando carpetas de usuario.`);
      watcher = listUsers().map(user => {
        const w = fs.watch(path.join(config.musicDir, user), onEvent(user));
        w.on('error', e => log(`[Watcher] Error (${user}): ${e.message}`));
        return w;
      });
    }
  }

  function stopWatcher() {
    if (debounceTimer) clearTimeout(debounceTimer);
    const list = Array.isArray(watcher) ? watcher : (watcher ? [watcher] : []);
    list.forEach(w => { try { w.close(); } catch { /* ya cerrado */ } });
    watcher = null;
  }

  return {
    syncUser, syncAll, withUserLock, ensureDefaultPlaylists, startWatcher, stopWatcher, bumpVersion,
    get version() { return version; },
  };
}

module.exports = { createLibrary, parseSongFileName, DEFAULT_PLAYLIST };
