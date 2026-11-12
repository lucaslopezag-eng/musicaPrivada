'use strict';
// ─── RECOMENDACIONES IA (Last.fm → Gemini) ───────────────────────────────────
// UI-02 / MEDIA-03:
// · Cerrojo por usuario: varios clics seguidos ya no lanzan N llamadas al LLM.
// · Índice UNIQUE (username, title, artist): una recomendación repetida se
//   ignora y no se vuelve a descargar.
// · ai_history.txt se limita a las últimas 100 entradas.
// · Rechazar/saltar ARCHIVA el archivo (.archive) en lugar de borrarlo; una
//   tarea nocturna purga lo archivado tras AI_ARCHIVE_RETENTION_DAYS.

const fs = require('fs');
const fsp = fs.promises;
const path = require('path');
const { ensureUserDir, sanitizeFileStem, resolveAiFile, companionImagePaths, isFile, uniqueFileName, toPosix } = require('../paths');
const { fetchJson, parseJsonArray } = require('./genres');

const HISTORY_LIMIT = 100;
const LASTFM_BASE = 'https://ws.audioscrobbler.com/2.0/?format=json';

function createRecommendations({ db, config, fetch, log, gemini, ytdlp, downloadQueue, library, users }) {
  const generating = new Set();

  // ─── Historial (archivo acotado) ───────────────────────────────────────────
  async function readHistory(user) {
    const file = path.join(ensureUserDir(config.aiMusicDir, user), 'ai_history.txt');
    try {
      const lines = (await fsp.readFile(file, 'utf8')).split('\n').filter(Boolean);
      return lines.slice(-HISTORY_LIMIT);
    } catch {
      return [];
    }
  }

  async function appendHistory(user, entries) {
    if (entries.length === 0) return;
    const file = path.join(ensureUserDir(config.aiMusicDir, user), 'ai_history.txt');
    const merged = [...await readHistory(user), ...entries].slice(-HISTORY_LIMIT);
    const tmp = `${file}.tmp`;
    await fsp.writeFile(tmp, merged.join('\n') + '\n', 'utf8');
    await fsp.rename(tmp, file);
  }

  // ─── Last.fm ───────────────────────────────────────────────────────────────
  async function lastfm(method, params) {
    if (!config.lastfmApiKey) return null;
    const qs = new URLSearchParams({ method, api_key: config.lastfmApiKey, ...params });
    const { data } = await fetchJson(fetch, `${LASTFM_BASE}&${qs}`, { headers: { 'User-Agent': 'MusicaPrivada/2.0' } });
    return data;
  }

  async function getLastFmRecommendations(libraryTitles, count, historyTitles) {
    if (!config.lastfmApiKey) return [];
    try {
      const known = new Set([...libraryTitles, ...historyTitles].map(t => t.toLowerCase()));
      const artists = [...new Set(libraryTitles
        .map(t => { const p = t.split(' - '); return p.length >= 2 ? p.slice(1).join(' - ').trim() : null; })
        .filter(Boolean))].slice(0, 15);
      if (artists.length === 0) return [];

      const similar = new Map();
      for (const artist of artists) {
        try {
          const data = await lastfm('artist.getSimilar', { artist, limit: '8' });
          for (const a of data?.similarartists?.artist || []) {
            const score = Number.parseFloat(a.match) || 0;
            if (!similar.has(a.name) || similar.get(a.name) < score) similar.set(a.name, score);
          }
        } catch { /* se ignora este artista */ }
      }
      const topSimilar = [...similar.entries()].sort((a, b) => b[1] - a[1]).slice(0, 12).map(([n]) => n);

      const recs = [];
      const addTracksFrom = async (artist, limit) => {
        const data = await lastfm('artist.getTopTracks', { artist, limit: String(limit) });
        for (const track of data?.toptracks?.track || []) {
          const key = `${track.name} - ${artist}`.toLowerCase();
          if (!known.has(key)) { known.add(key); recs.push({ title: track.name, artist }); }
        }
      };
      for (const artist of topSimilar) {
        if (recs.length >= count * 2) break;
        try { await addTracksFrom(artist, 5); } catch { /* ignorar */ }
      }
      for (const artist of artists.slice(0, 5)) {
        if (recs.length >= count * 2) break;
        try { await addTracksFrom(artist, 8); } catch { /* ignorar */ }
      }
      for (let i = recs.length - 1; i > 0; i--) {
        const j = Math.floor(Math.random() * (i + 1));
        [recs[i], recs[j]] = [recs[j], recs[i]];
      }
      return recs.slice(0, count);
    } catch (err) {
      log(`[LastFM] Error: ${err.message}`);
      return [];
    }
  }

  async function getGeminiRecommendations(libraryTitles, count, historyTitles) {
    const prompt = `You are a music recommendation system. Based on this user's music library, recommend exactly ${count} songs they would love.

User's library:
${libraryTitles.map((t, i) => `${i + 1}. ${t}`).join('\n')}

Previously recommended songs (DO NOT RECOMMEND THESE AGAIN):
${historyTitles.map((t, i) => `${i + 1}. ${t}`).join('\n')}

Rules:
- Do NOT recommend any song title that is already in the user's library or in the previously recommended list, even if it's a different remix or version.
- Provide a balanced mix: recommend some new songs from the artists already present in the user's library, AND recommend songs from completely new artists that the user might like.
- Recommend songs similar in style, genre and mood to the user's library.
- Respond ONLY with a JSON array. No markdown, no explanation. Example format:
[{"title":"Song Name","artist":"Artist Name"},...]
- Be very precise with artist names and song titles for accurate downloading.
- Recommend exactly ${count} songs.`;
    const text = await gemini(prompt, { temperature: 0.9, maxOutputTokens: 4096, responseMimeType: 'application/json' });
    return parseJsonArray(text)
      .filter(r => r && typeof r.title === 'string' && typeof r.artist === 'string')
      .map(r => ({ title: r.title.trim().slice(0, 200), artist: r.artist.trim().slice(0, 200) }))
      .filter(r => r.title && r.artist);
  }

  // ─── Descarga ──────────────────────────────────────────────────────────────
  async function downloadOne(user, rec) {
    const userAiDir = ensureUserDir(config.aiMusicDir, user);
    const stem = `ai_${sanitizeFileStem(`${rec.title} - ${rec.artist}`)}`;
    const finalAudio = path.join(userAiDir, `${stem}.opus`);
    if (!(await isFile(finalAudio))) {
      const staging = await ytdlp.downloadToStaging({
        target: `ytsearch1:${rec.title} - ${rec.artist}`,
        destDir: userAiDir,
        baseName: stem,
        isUrl: false,
      });
      await staging.commit(userAiDir, stem);
    }
    let coverUrl = null;
    for (const name of [`${stem}.jpg`, `${stem}.opus.jpg`]) {
      if (await isFile(path.join(userAiDir, name))) { coverUrl = `/api/cover/ai/${user}/${encodeURIComponent(name)}`; break; }
    }
    await db.run("UPDATE ai_recommendations SET status = 'downloaded', file_path = ?, cover_url = ? WHERE id = ? AND username = ?",
      [`${user}/${stem}.opus`, coverUrl, rec.id, user]);
  }

  async function downloadPending(user, recs) {
    log(`[IA] Descargando ${recs.length} recomendaciones para ${user}...`);
    for (const rec of recs) {
      await downloadQueue.push(async () => {
        try {
          await downloadOne(user, rec);
          log(`[IA] Descargada: ${rec.title} - ${rec.artist}`);
        } catch (err) {
          log(`[IA] Fallo al descargar "${rec.title}": ${err.message}`);
          await db.run("UPDATE ai_recommendations SET status = 'failed' WHERE id = ?", [rec.id]).catch(() => {});
        }
      });
    }
    log('[IA] Descarga de recomendaciones terminada.');
  }

  async function generateFor(user, count) {
    const songs = await db.all('SELECT title, artist FROM songs WHERE username = ?', [user]);
    const libraryTitles = songs.map(s => `${s.title} - ${s.artist}`);
    // Todo lo ya recomendado a este usuario (cualquier estado): evita que Last.fm
    // devuelva siempre las mismas pistas, que el índice UNIQUE descartaría en silencio.
    const known = await db.all('SELECT title, artist FROM ai_recommendations WHERE username = ?', [user]);
    const knownKeys = new Set(known.map(r => `${r.title} - ${r.artist}`.toLowerCase()));
    const historyTitles = [...new Set([...await readHistory(user), ...known.map(r => `${r.title} - ${r.artist}`)])];
    const isNew = (r) => !knownKeys.has(`${r.title} - ${r.artist}`.toLowerCase());

    let source = 'lastfm';
    let recs = (await getLastFmRecommendations(libraryTitles, count, historyTitles)).filter(isNew);
    if (recs.length < 5) {
      log(`[IA] Last.fm devolvió ${recs.length} nuevas; se usa Gemini.`);
      source = 'gemini';
      recs = (await getGeminiRecommendations(libraryTitles, count, historyTitles.slice(-300))).filter(isNew);
    }
    log(`[IA] ${recs.length} recomendaciones (${source}) para ${user}.`);
    await appendHistory(user, recs.map(r => `${r.title} - ${r.artist}`));

    const fresh = [];
    for (const rec of recs) {
      const query = `${rec.title} - ${rec.artist}`;
      const { changes, lastID } = await db.run(
        "INSERT OR IGNORE INTO ai_recommendations (title, artist, query, status, username, source) VALUES (?,?,?,'pending',?,?)",
        [rec.title, rec.artist, query, user, source]
      );
      if (changes > 0) fresh.push({ ...rec, id: lastID });
    }
    if (fresh.length < recs.length) log(`[IA] ${recs.length - fresh.length} recomendaciones ya existían y se omiten.`);
    await downloadPending(user, fresh);
    return fresh.length;
  }

  // Devuelve false si ya había una generación en curso para el usuario.
  function generate(user, count = 20) {
    if (generating.has(user)) return false;
    generating.add(user);
    const safeCount = Math.min(50, Math.max(1, Number.parseInt(count, 10) || 20));
    generateFor(user, safeCount)
      .catch(err => log(`[IA] Error generando para ${user}: ${err.message}`))
      .finally(() => generating.delete(user));
    return true;
  }

  // ─── Listado / aceptar / archivar ──────────────────────────────────────────
  async function listDownloaded(user) {
    const rows = await db.all(
      "SELECT id AS rec_id, title, artist, status, file_path, cover_url, username FROM ai_recommendations WHERE status = 'downloaded' AND username = ? ORDER BY created_at ASC",
      [user]
    );
    const valid = [];
    await Promise.all(rows.map(async (row) => {
      const file = await resolveAiFile(config.aiMusicDir, row);
      if (file) valid.push(row);
      else await db.run("UPDATE ai_recommendations SET status = 'missing' WHERE id = ?", [row.rec_id]).catch(() => {});
    }));
    valid.sort((a, b) => a.rec_id - b.rec_id);
    // Nunca se envían rutas de disco al cliente.
    return valid.map(({ file_path, username, ...r }) => ({ ...r, id: `ai-${r.rec_id}` }));
  }

  async function accept(user, recId) {
    const row = await db.get('SELECT * FROM ai_recommendations WHERE id = ? AND username = ?', [recId, user]);
    if (!row) return null;
    const source = await resolveAiFile(config.aiMusicDir, row);
    if (!source) return { error: 'El archivo de la recomendación ya no existe' };

    const userMusicDir = ensureUserDir(config.musicDir, user);
    const stem = `9999_${sanitizeFileStem(`${row.title} - ${row.artist}`)}`;
    const finalName = await uniqueFileName(userMusicDir, stem, '.opus');
    const finalStem = finalName.slice(0, -'.opus'.length);
    const finalPath = path.join(userMusicDir, finalName);

    // Portada primero; el audio al final (el sincronizador detecta el audio).
    for (const img of companionImagePaths(source)) {
      if (!(await isFile(img))) continue;
      await fsp.rename(img, path.join(userMusicDir, finalStem + path.extname(img))).catch(() => {});
      break;
    }
    await fsp.rename(source, finalPath);

    await db.run("UPDATE ai_recommendations SET status = 'accepted', file_path = NULL WHERE id = ?", [recId]);
    await library.syncUser(user);
    await db.run('UPDATE songs SET discovered_via = ? WHERE file_path = ? AND username = ?',
      [row.source || 'ai', `${user}/${finalName}`, user]);
    log(`[IA] Recomendación ${recId} aceptada → ${finalName}`);
    return { ok: true };
  }

  // status: 'rejected' (pulgar abajo) o 'skipped' (botón siguiente).
  async function archive(user, recId, status) {
    const row = await db.get('SELECT * FROM ai_recommendations WHERE id = ? AND username = ?', [recId, user]);
    if (!row) return null;
    const source = await resolveAiFile(config.aiMusicDir, row);
    let newRel = row.file_path;
    if (source && !source.includes(`${path.sep}.archive${path.sep}`)) {
      const archiveDir = path.join(ensureUserDir(config.aiMusicDir, user), '.archive');
      await fsp.mkdir(archiveDir, { recursive: true });
      for (const img of companionImagePaths(source)) {
        if (await isFile(img)) await fsp.rename(img, path.join(archiveDir, path.basename(img))).catch(() => {});
      }
      const dest = path.join(archiveDir, path.basename(source));
      await fsp.rename(source, dest);
      newRel = toPosix(path.relative(config.aiMusicDir, dest));
    }
    await db.run("UPDATE ai_recommendations SET status = ?, file_path = ?, archived_at = datetime('now') WHERE id = ?",
      [status, newRel, recId]);
    return { ok: true };
  }

  async function purgeArchive() {
    const days = config.aiArchiveRetentionDays;
    const rows = await db.all(
      "SELECT id, file_path, username FROM ai_recommendations WHERE archived_at IS NOT NULL AND file_path IS NOT NULL AND archived_at < datetime('now', ?)",
      [`-${days} days`]
    );
    for (const row of rows) {
      const file = await resolveAiFile(config.aiMusicDir, row);
      if (file) {
        for (const img of companionImagePaths(file)) await fsp.rm(img, { force: true }).catch(() => {});
        await fsp.rm(file, { force: true }).catch(() => {});
        const vtt = file.replace(/\.[^/.\\]+$/, '.vtt');
        await fsp.rm(vtt, { force: true }).catch(() => {});
      }
      await db.run('UPDATE ai_recommendations SET file_path = NULL WHERE id = ?', [row.id]);
    }
    if (rows.length) log(`[IA] Purgadas ${rows.length} recomendaciones archivadas.`);
  }

  // ─── Refresco nocturno (3:00) ──────────────────────────────────────────────
  let nightlyTimer = null;
  function scheduleNightly() {
    const now = new Date();
    const next = new Date(now);
    next.setHours(3, 0, 0, 0);
    if (next <= now) next.setDate(next.getDate() + 1);
    nightlyTimer = setTimeout(async () => {
      try {
        await purgeArchive();
        for (const user of users.list()) {
          const row = await db.get("SELECT COUNT(*) AS cnt FROM ai_recommendations WHERE status = 'downloaded' AND username = ?", [user]);
          if ((row?.cnt || 0) < 15) generate(user, 20);
        }
      } catch (err) {
        log(`[IA] Error en el refresco nocturno: ${err.message}`);
      }
      scheduleNightly();
    }, next - now);
    nightlyTimer.unref?.();
    log(`[IA] Refresco nocturno programado en ${Math.round((next - now) / 60000)} minutos.`);
  }

  function stop() {
    if (nightlyTimer) clearTimeout(nightlyTimer);
  }

  async function statusCounts(user) {
    return db.all('SELECT status, COUNT(*) AS count FROM ai_recommendations WHERE username = ? GROUP BY status', [user]);
  }

  return {
    generate, isGenerating: (u) => generating.has(u), listDownloaded, accept, archive,
    purgeArchive, scheduleNightly, stop, statusCounts,
  };
}

module.exports = { createRecommendations };
