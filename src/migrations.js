'use strict';
// ─── ESQUEMA Y MIGRACIONES IDEMPOTENTES ──────────────────────────────────────
// · Las columnas se añaden comprobando PRAGMA table_info (sin errores ignorados).
// · Las migraciones de datos se registran en schema_migrations y se ejecutan
//   UNA sola vez (DB-03: la migración de rutas ya no reasigna canciones de
//   otros usuarios en cada arranque).

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { isInside, toPosix, isValidUsername } = require('./paths');

function columnExists(db, table, column) {
  return db.allSync(`PRAGMA table_info(${table})`).some(r => r.name === column);
}

function addColumn(db, table, column, definition) {
  if (!columnExists(db, table, column)) {
    db.runSync(`ALTER TABLE ${table} ADD COLUMN ${column} ${definition}`);
  }
}

function createBaseSchema(db) {
  db.execSync(`
    CREATE TABLE IF NOT EXISTS songs (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      title TEXT, artist TEXT, album TEXT, duration INTEGER,
      file_path TEXT UNIQUE, cover_url TEXT, playlist_order INTEGER DEFAULT 0,
      genre TEXT DEFAULT 'Unknown',
      username TEXT DEFAULT 'skiper'
    );
    CREATE TABLE IF NOT EXISTS play_history (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      song_id INTEGER,
      played_at DATETIME DEFAULT CURRENT_TIMESTAMP,
      listen_duration_ms INTEGER DEFAULT 0,
      completed BOOLEAN DEFAULT 0,
      username TEXT DEFAULT 'skiper'
    );
    CREATE TABLE IF NOT EXISTS playlists (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      name TEXT,
      username TEXT,
      cover_url TEXT,
      created_at DATETIME DEFAULT CURRENT_TIMESTAMP
    );
    CREATE TABLE IF NOT EXISTS playlist_songs (
      playlist_id INTEGER,
      song_id INTEGER,
      playlist_order INTEGER DEFAULT 0,
      PRIMARY KEY (playlist_id, song_id)
    );
    CREATE TABLE IF NOT EXISTS listening_sessions (
      id TEXT PRIMARY KEY, username TEXT NOT NULL,
      started_at DATETIME DEFAULT CURRENT_TIMESTAMP,
      ended_at DATETIME DEFAULT NULL,
      total_songs INTEGER DEFAULT 0, total_ms INTEGER DEFAULT 0,
      weekday INTEGER DEFAULT NULL, hour_of_day INTEGER DEFAULT NULL
    );
    CREATE TABLE IF NOT EXISTS ai_recommendations (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      title TEXT,
      artist TEXT,
      query TEXT,
      song_id INTEGER,
      status TEXT DEFAULT 'pending',
      created_at TEXT DEFAULT (datetime('now')),
      username TEXT DEFAULT 'skiper'
    );
    CREATE TABLE IF NOT EXISTS sessions (
      token_hash TEXT PRIMARY KEY,
      username TEXT NOT NULL,
      created_at INTEGER NOT NULL,
      expires_at INTEGER NOT NULL,
      last_seen_at INTEGER NOT NULL,
      user_agent TEXT
    );
    CREATE TABLE IF NOT EXISTS schema_migrations (
      id TEXT PRIMARY KEY,
      applied_at DATETIME DEFAULT CURRENT_TIMESTAMP
    );
    -- FASE 2 · Usuarios en BD (antes solo APP_USERS en .env).
    CREATE TABLE IF NOT EXISTS users (
      username TEXT PRIMARY KEY,
      password_hash TEXT NOT NULL,
      role TEXT NOT NULL DEFAULT 'user' CHECK (role IN ('admin', 'user')),
      created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
      updated_at DATETIME DEFAULT CURRENT_TIMESTAMP,
      password_updated_at DATETIME DEFAULT CURRENT_TIMESTAMP
    );
    -- FASE 2 · Cola de trabajos persistente (importaciones y descargas).
    CREATE TABLE IF NOT EXISTS jobs (
      id TEXT PRIMARY KEY,
      username TEXT NOT NULL,
      type TEXT NOT NULL,
      status TEXT NOT NULL,
      progress INTEGER DEFAULT 0,
      payload TEXT,
      result TEXT,
      error_message TEXT,
      created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
      updated_at DATETIME DEFAULT CURRENT_TIMESTAMP
    );
    -- Transcripciones locales con Whisper (src/services/transcriber.js). Clave:
    -- ruta absoluta del audio; segments = JSON [{start, end, text}] en segundos.
    CREATE TABLE IF NOT EXISTS transcriptions (
      file_path TEXT PRIMARY KEY,
      kind TEXT NOT NULL DEFAULT 'music',
      status TEXT NOT NULL DEFAULT 'pending' CHECK (status IN ('pending', 'processing', 'done', 'error')),
      priority INTEGER NOT NULL DEFAULT 0,
      attempts INTEGER NOT NULL DEFAULT 0,
      language TEXT,
      language_probability REAL,
      text TEXT,
      segments TEXT,
      model TEXT,
      audio_duration_ms INTEGER,
      processing_ms INTEGER,
      error TEXT,
      created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
      updated_at DATETIME DEFAULT CURRENT_TIMESTAMP
    );
  `);

  // Columnas añadidas a lo largo del tiempo.
  addColumn(db, 'songs', 'genre', "TEXT DEFAULT 'Unknown'");
  addColumn(db, 'songs', 'username', "TEXT DEFAULT 'skiper'");
  addColumn(db, 'songs', 'discovered_via', "TEXT DEFAULT 'manual'");
  // SQLite no permite DEFAULT CURRENT_TIMESTAMP en ALTER TABLE ADD COLUMN: la
  // migración original fallaba en silencio y la columna nunca existía. Ahora se
  // crea sin default y el upsert de la biblioteca la rellena al insertar.
  addColumn(db, 'songs', 'added_at', 'DATETIME DEFAULT NULL');
  addColumn(db, 'songs', 'chorus_start_ms', 'INTEGER DEFAULT NULL');
  // Revisión del archivo: se incrementa al recortar/sustituir. Versiona las URLs
  // de streaming para que la caché HTTP/SW nunca sirva audio obsoleto.
  addColumn(db, 'songs', 'rev', 'INTEGER NOT NULL DEFAULT 0');
  // Sonoridad integrada EBU R128 (LUFS), medida en segundo plano (services/loudness.js).
  addColumn(db, 'songs', 'loudness_lufs', 'REAL DEFAULT NULL');
  // Último intento de clasificar el género, haya o no resultado: evita repetir
  // MusicBrainz y Gemini con las mismas canciones en cada arranque (IA-1).
  addColumn(db, 'songs', 'genre_checked_at', 'TEXT DEFAULT NULL');
  // Último fallo al medir la sonoridad (archivo ausente, ffmpeg): no se reintenta en bucle (SRV-1).
  addColumn(db, 'songs', 'loudness_failed_at', 'TEXT DEFAULT NULL');

  addColumn(db, 'play_history', 'username', "TEXT DEFAULT 'skiper'");
  addColumn(db, 'play_history', 'session_id', 'TEXT DEFAULT NULL');
  addColumn(db, 'play_history', 'source', "TEXT DEFAULT 'manual'");
  addColumn(db, 'play_history', 'skip_at_ms', 'INTEGER DEFAULT NULL');
  addColumn(db, 'play_history', 'context_playlist_id', 'INTEGER DEFAULT NULL');
  // DB-05: las escuchas de recomendaciones IA ya no se guardan como song_id
  // numérico (colisionaban con canciones reales).
  addColumn(db, 'play_history', 'is_ai', 'INTEGER NOT NULL DEFAULT 0');
  addColumn(db, 'play_history', 'ai_rec_id', 'INTEGER DEFAULT NULL');

  addColumn(db, 'ai_recommendations', 'file_path', 'TEXT');
  addColumn(db, 'ai_recommendations', 'cover_url', 'TEXT');
  addColumn(db, 'ai_recommendations', 'username', "TEXT DEFAULT 'skiper'");
  addColumn(db, 'ai_recommendations', 'source', 'TEXT DEFAULT NULL');
  addColumn(db, 'ai_recommendations', 'archived_at', 'TEXT DEFAULT NULL');
  // Canción de la biblioteca en la que se convirtió una recomendación aceptada (IA-2).
  addColumn(db, 'ai_recommendations', 'song_id', 'INTEGER DEFAULT NULL');

  // Sesiones: identificador público (no derivado del token) para listarlas y
  // revocarlas desde /api/auth/sessions sin exponer el hash.
  addColumn(db, 'sessions', 'id', 'TEXT DEFAULT NULL');
  const missingIds = db.allSync('SELECT token_hash FROM sessions WHERE id IS NULL');
  for (const row of missingIds) {
    db.runSync('UPDATE sessions SET id = ? WHERE token_hash = ?', [crypto.randomBytes(12).toString('base64url'), row.token_hash]);
  }

  // Trabajos: reintentos tras un reinicio y log persistido.
  addColumn(db, 'jobs', 'attempts', 'INTEGER NOT NULL DEFAULT 0');
  addColumn(db, 'jobs', 'log', 'TEXT DEFAULT NULL');

  db.execSync(`
    CREATE INDEX IF NOT EXISTS ix_songs_username ON songs(username);
    CREATE INDEX IF NOT EXISTS ix_play_history_user_time ON play_history(username, played_at);
    CREATE INDEX IF NOT EXISTS ix_play_history_song ON play_history(song_id);
    CREATE INDEX IF NOT EXISTS ix_playlist_songs_song ON playlist_songs(song_id);
    CREATE INDEX IF NOT EXISTS ix_playlists_username ON playlists(username);
    CREATE INDEX IF NOT EXISTS ix_sessions_expires ON sessions(expires_at);
    CREATE INDEX IF NOT EXISTS ix_ai_recs_user_status ON ai_recommendations(username, status);
    CREATE UNIQUE INDEX IF NOT EXISTS ux_sessions_id ON sessions(id);
    CREATE INDEX IF NOT EXISTS ix_sessions_username ON sessions(username);
    CREATE INDEX IF NOT EXISTS idx_jobs_user_status ON jobs(username, status);
    CREATE INDEX IF NOT EXISTS ix_jobs_status ON jobs(status);
    CREATE INDEX IF NOT EXISTS ix_transcriptions_status ON transcriptions(status, priority);
  `);
}

// ─── Migraciones de datos (una sola vez) ─────────────────────────────────────

const DATA_MIGRATIONS = [
  {
    // Sustituye a la migración que se ejecutaba en cada arranque y forzaba
    // username='skiper' para cualquier ruta que no empezase por skiper/ o
    // alejandro/ (DB-03). Ahora solo normaliza rutas heredadas sin prefijo y
    // respeta el propietario que ya tuviera la fila.
    id: '2026-10-normalize-song-paths',
    up(db, ctx) {
      const rows = db.allSync('SELECT id, file_path, cover_url, username FROM songs');
      for (const row of rows) {
        if (typeof row.file_path !== 'string' || row.file_path === '') continue;
        let rel = null;
        if (path.isAbsolute(row.file_path)) {
          if (isInside(ctx.musicDir, row.file_path)) rel = toPosix(path.relative(ctx.musicDir, row.file_path));
        } else if (!row.file_path.includes('/') && !row.file_path.includes('\\')) {
          const owner = isValidUsername(row.username) ? row.username : ctx.legacyOwner;
          rel = `${owner}/${row.file_path}`;
        }
        if (!rel || rel === row.file_path) continue;
        const owner = rel.split('/')[0];
        if (!isValidUsername(owner)) continue;
        const clash = db.getSync('SELECT id FROM songs WHERE file_path = ? AND id <> ?', [rel, row.id]);
        if (clash) {
          // Fila heredada duplicada (la vieja migración fallaba en silencio por
          // UNIQUE en cada arranque). Se fusiona en la fila canónica: playlists,
          // historial y metadatos que falten; después se elimina.
          db.runSync('UPDATE OR IGNORE playlist_songs SET song_id = ? WHERE song_id = ?', [clash.id, row.id]);
          db.runSync('DELETE FROM playlist_songs WHERE song_id = ?', [row.id]);
          db.runSync('UPDATE play_history SET song_id = ? WHERE song_id = ?', [clash.id, row.id]);
          db.runSync(`
            UPDATE songs SET
              genre = CASE WHEN genre IS NULL OR genre IN ('', 'Unknown') THEN (SELECT genre FROM songs WHERE id = ?) ELSE genre END,
              duration = COALESCE(duration, (SELECT duration FROM songs WHERE id = ?)),
              chorus_start_ms = COALESCE(chorus_start_ms, (SELECT chorus_start_ms FROM songs WHERE id = ?))
            WHERE id = ?`, [row.id, row.id, row.id, clash.id]);
          db.runSync('DELETE FROM songs WHERE id = ?', [row.id]);
          ctx.log(`[Migración] Fila duplicada ${row.id} fusionada en ${clash.id}: ${rel}`);
          continue;
        }
        let cover = row.cover_url;
        if (typeof cover === 'string' && cover.startsWith('/api/cover/') && !cover.startsWith('/api/cover/ai/')) {
          const tail = cover.slice('/api/cover/'.length);
          const decoded = safeDecode(tail);
          if (!decoded.includes('/')) cover = `/api/cover/${owner}/${tail}`;
        }
        db.runSync('UPDATE songs SET file_path = ?, username = COALESCE(username, ?), cover_url = ? WHERE id = ?',
          [rel, owner, cover, row.id]);
      }
    },
  },
  {
    // Archivos sueltos en la raíz de music/ o .ai_music/ (versión monousuario).
    // Se asignan UNA vez a LEGACY_OWNER y se actualizan las rutas en BD (antes se
    // movían en cada arranque sin actualizar ai_recommendations.file_path).
    id: '2026-10-move-root-files-to-owner',
    up(db, ctx) {
      const owner = ctx.legacyOwner;
      for (const [root, isAi] of [[ctx.musicDir, false], [ctx.aiMusicDir, true]]) {
        if (!fs.existsSync(root)) continue;
        const ownerDir = path.join(root, owner);
        fs.mkdirSync(ownerDir, { recursive: true });
        for (const entry of fs.readdirSync(root, { withFileTypes: true })) {
          if (!entry.isFile() || entry.name.startsWith('.')) continue;
          const dest = path.join(ownerDir, entry.name);
          if (fs.existsSync(dest)) continue;
          fs.renameSync(path.join(root, entry.name), dest);
          if (isAi && entry.name.endsWith('.opus')) {
            db.runSync(
              "UPDATE ai_recommendations SET file_path = ? WHERE username = ? AND (file_path = ? OR file_path LIKE ?)",
              [`${owner}/${entry.name}`, owner, entry.name, `%${entry.name}`]
            );
          }
        }
      }
      const oldHistory = path.join(ctx.rootDir, 'ai_history.txt');
      const newHistory = path.join(ctx.aiMusicDir, owner, 'ai_history.txt');
      if (fs.existsSync(oldHistory) && !fs.existsSync(newHistory)) {
        fs.mkdirSync(path.dirname(newHistory), { recursive: true });
        fs.renameSync(oldHistory, newHistory);
      }
    },
  },
  {
    // Rutas de recomendaciones IA: absolutas → relativas a .ai_music.
    id: '2026-10-ai-relative-paths',
    up(db) {
      const rows = db.allSync('SELECT id, file_path, username FROM ai_recommendations WHERE file_path IS NOT NULL');
      for (const row of rows) {
        if (!isValidUsername(row.username)) continue;
        const base = path.basename(String(row.file_path).replace(/\\/g, '/'));
        const rel = `${row.username}/${base}`;
        if (rel !== row.file_path) {
          db.runSync('UPDATE ai_recommendations SET file_path = ? WHERE id = ?', [rel, row.id]);
        }
      }
      db.runSync("UPDATE ai_recommendations SET cover_url = REPLACE(cover_url, 'http://localhost:3001', '') WHERE cover_url LIKE 'http://localhost:3001%'");
    },
  },
  {
    // UI-02: se eliminan los grupos duplicados y se crea un índice UNIQUE para
    // que INSERT OR IGNORE realmente ignore recomendaciones repetidas.
    id: '2026-10-ai-dedupe-unique',
    up(db) {
      db.runSync(`
        DELETE FROM ai_recommendations
        WHERE id NOT IN (
          SELECT id FROM (
            SELECT id, ROW_NUMBER() OVER (
              PARTITION BY username, title COLLATE NOCASE, artist COLLATE NOCASE
              ORDER BY CASE status WHEN 'accepted' THEN 0 WHEN 'downloaded' THEN 1 WHEN 'pending' THEN 2 ELSE 3 END, id
            ) AS rn
            FROM ai_recommendations
          ) WHERE rn = 1
        )
      `);
      db.runSync(`CREATE UNIQUE INDEX IF NOT EXISTS ux_ai_recs_user_title_artist
                    ON ai_recommendations(username, title COLLATE NOCASE, artist COLLATE NOCASE)`);
    },
  },
  {
    // Las canciones borradas dejaban filas huérfanas en playlist_songs.
    id: '2026-10-orphan-playlist-songs',
    up(db) {
      db.runSync('DELETE FROM playlist_songs WHERE song_id NOT IN (SELECT id FROM songs)');
      db.runSync('DELETE FROM playlist_songs WHERE playlist_id NOT IN (SELECT id FROM playlists)');
    },
  },
  {
    // Temas visuales vetados por usuario (lista separada por comas; ver routes/themes.js).
    id: '2026-10-user-hidden-themes',
    up(db) {
      const cols = db.allSync('PRAGMA table_info(users)').map(c => c.name);
      if (!cols.includes('hidden_themes')) db.runSync("ALTER TABLE users ADD COLUMN hidden_themes TEXT NOT NULL DEFAULT ''");
    },
  },
  {
    // Playlist por defecto por usuario (NULL = "Mi Biblioteca"; ver services/library.js).
    id: '2026-10-user-default-playlist',
    up(db) {
      const cols = db.allSync('PRAGMA table_info(users)').map(c => c.name);
      if (!cols.includes('default_playlist')) db.runSync('ALTER TABLE users ADD COLUMN default_playlist TEXT');
    },
  },
  {
    // Fondo de pantalla propio por usuario (ver routes/background.js).
    id: '2026-10-user-background',
    up(db) {
      const cols = db.allSync('PRAGMA table_info(users)').map(c => c.name);
      if (!cols.includes('background_file')) db.runSync('ALTER TABLE users ADD COLUMN background_file TEXT');
      if (!cols.includes('background_opacity')) db.runSync('ALTER TABLE users ADD COLUMN background_opacity INTEGER NOT NULL DEFAULT 60');
    },
  },
];

function safeDecode(text) {
  try { return decodeURIComponent(text); } catch { return text; }
}

async function migrate(db, ctx) {
  // DB-04: WAL permite lecturas concurrentes durante escrituras y reduce fsyncs.
  db.execSync('PRAGMA journal_mode = WAL; PRAGMA synchronous = NORMAL; PRAGMA busy_timeout = 5000;');
  db.transaction(() => createBaseSchema(db));

  const applied = new Set(db.allSync('SELECT id FROM schema_migrations').map(r => r.id));
  for (const migration of DATA_MIGRATIONS) {
    if (applied.has(migration.id)) continue;
    // Transacción síncrona: la migración y su registro se confirman juntos.
    db.transaction(() => {
      migration.up(db, ctx);
      db.runSync('INSERT INTO schema_migrations (id) VALUES (?)', [migration.id]);
    });
    ctx.log(`[Migración] Aplicada ${migration.id}`);
  }
}

module.exports = { migrate, DATA_MIGRATIONS };
