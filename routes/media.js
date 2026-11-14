'use strict';
// ─── STREAMING, PORTADAS Y SUBTÍTULOS ────────────────────────────────────────
// AUTH-02 / AUTH-03 / MEDIA-01:
// · Todas estas rutas requieren sesión (cabecera o cookie HttpOnly).
// · /stream/:id comprueba que la canción pertenece al usuario.
// · /cover/* resuelve rutas canónicas y verifica que quedan dentro de la
//   carpeta del propio usuario; solo sirve imágenes.
// · /cover/ai/* se registra ANTES que /cover/* (antes quedaba sombreada).

const express = require('express');
const fsp = require('fs').promises;
const path = require('path');
const { HttpError, requireId } = require('../src/http');
const { streamFile } = require('../src/media/stream');
const { resolveSongFile, resolveAiFile, safeJoin, isValidUsername, isFile } = require('../src/paths');

const IMAGE_EXT_RE = /\.(jpe?g|png|webp)$/i;
const IMAGE_CACHE = 'private, max-age=86400';

// "usuario/archivo.jpg" → { owner, rest }. Sin prefijo → propietario = req.user.
function splitOwner(rawPath, currentUser) {
  const clean = String(rawPath || '').replace(/\\/g, '/').replace(/^\/+/, '');
  const slash = clean.indexOf('/');
  if (slash > 0) {
    const first = clean.slice(0, slash);
    if (isValidUsername(first)) return { owner: first, rest: clean.slice(slash + 1) };
  }
  return { owner: currentUser, rest: clean };
}

module.exports = function mediaRouter({ db, config, log, subtitles, transcriber }) {
  const router = express.Router();

  async function sendImage(res, candidates) {
    for (const candidate of candidates) {
      if (candidate && IMAGE_EXT_RE.test(candidate) && await isFile(candidate)) {
        return res.sendFile(candidate, { dotfiles: 'allow', headers: { 'Cache-Control': IMAGE_CACHE } });
      }
    }
    return res.status(404).send('Not found');
  }

  // ─── Audio ─────────────────────────────────────────────────────────────────
  router.get('/stream/ai/:id', async (req, res) => {
    const id = requireId(req.params.id);
    const row = await db.get('SELECT id, file_path, username, song_id FROM ai_recommendations WHERE id = ? AND username = ?', [id, req.user]);
    if (!row) throw new HttpError(404, 'Canción no encontrada');
    let file = await resolveAiFile(config.aiMusicDir, row);
    let immutable = true;
    if (!file && row.song_id) {
      // IA-2: recomendación aceptada. Su archivo se movió a la biblioteca; la
      // canción que ya estaba sonando (o guardada en el cliente) sigue funcionando.
      const song = await db.get('SELECT id, file_path, username FROM songs WHERE id = ? AND username = ?', [row.song_id, req.user]);
      file = song ? await resolveSongFile(config.musicDir, song) : null;
      immutable = false; // la canción de la biblioteca se puede recortar o sustituir
    }
    if (!file) throw new HttpError(404, 'Archivo no encontrado');
    await streamFile(req, res, file, { immutable, throttleBps: config.streamThrottleBps, log });
  });

  router.get('/stream/:id', async (req, res) => {
    const id = requireId(req.params.id);
    const row = await db.get('SELECT id, file_path, username, rev FROM songs WHERE id = ? AND username = ?', [id, req.user]);
    if (!row) throw new HttpError(404, 'Canción no encontrada');
    const file = await resolveSongFile(config.musicDir, row);
    if (!file) {
      log(`[Stream] Falta el archivo de la canción ${id} (${req.user})`);
      throw new HttpError(404, 'Archivo no encontrado');
    }
    // URL versionada con la revisión actual → se puede cachear como inmutable.
    const immutable = req.query.v !== undefined && String(req.query.v) === String(row.rev || 0);
    await streamFile(req, res, file, { immutable, throttleBps: config.streamThrottleBps, log });
  });

  // ─── Portadas (orden importante: la ruta IA va primero) ────────────────────
  router.get(/^\/cover\/ai\/(.+)$/, async (req, res) => {
    const { owner, rest } = splitOwner(req.params[0], req.user);
    if (owner !== req.user) return res.status(404).send('Not found');
    const userDir = path.join(config.aiMusicDir, owner);
    const base = rest.replace(/\.jpg$/i, '');
    const candidates = [
      safeJoin(userDir, rest),
      safeJoin(userDir, `${base.replace(/\.opus$/i, '')}.jpg`),
      safeJoin(userDir, `${base}.jpg`),
      safeJoin(userDir, '.archive', rest),
    ];
    return sendImage(res, candidates);
  });

  router.get(/^\/cover\/(.+)$/, async (req, res) => {
    const { owner, rest } = splitOwner(req.params[0], req.user);
    if (owner !== req.user) return res.status(404).send('Not found');
    return sendImage(res, [safeJoin(path.join(config.musicDir, owner), rest)]);
  });

  // ─── Subtítulos ────────────────────────────────────────────────────────────
  async function sendOrEnqueueVtt(res, audioFile, kind) {
    const vttPath = audioFile.replace(/\.[^/.\\]+$/, '.vtt');
    if (await isFile(vttPath)) {
      res.setHeader('Content-Type', 'text/vtt; charset=utf-8');
      res.setHeader('Cache-Control', 'private, no-cache');
      return res.send(await fsp.readFile(vttPath, 'utf8'));
    }
    // SRV-6: una transcripción local que terminó en error no se vuelve a encolar
    // sola, así que no se anuncia como "en cola" (el cliente dejaba de avanzar).
    if (transcriber) {
      const t = await transcriber.get(audioFile);
      if (t && t.status === 'error') {
        return res.status(404).json({ error: 'Subtitles not found', queued: false, reason: 'transcription_failed' });
      }
    }
    subtitles.enqueue(audioFile, kind, true);
    return res.status(404).json({ error: 'Subtitles not found', queued: true });
  }

  router.get('/subtitles/ai/:id', async (req, res) => {
    const id = requireId(req.params.id);
    const row = await db.get('SELECT id, file_path, username FROM ai_recommendations WHERE id = ? AND username = ?', [id, req.user]);
    if (!row) throw new HttpError(404, 'Canción no encontrada');
    const file = await resolveAiFile(config.aiMusicDir, row);
    if (!file) throw new HttpError(404, 'Archivo no encontrado');
    return sendOrEnqueueVtt(res, file, 'ai');
  });

  // ─── Transcripción (Whisper local) ───────────────────────────────────────
  // Texto, idioma y segmentos con marcas de tiempo. Sin fila → 404 con
  // status "none" (GET /subtitles/:id la encola si tampoco hay .vtt).
  router.get('/transcription/:id', async (req, res) => {
    const id = requireId(req.params.id);
    if (!transcriber) throw new HttpError(503, 'Transcripción local desactivada');
    const row = await db.get('SELECT id, file_path, username FROM songs WHERE id = ? AND username = ?', [id, req.user]);
    if (!row) throw new HttpError(404, 'Canción no encontrada');
    const file = await resolveSongFile(config.musicDir, row);
    if (!file) throw new HttpError(404, 'Archivo no encontrado');
    const t = await transcriber.get(file);
    res.setHeader('Cache-Control', 'private, no-cache');
    if (!t) return res.status(404).json({ songId: id, status: 'none' });
    let segments = [];
    try { segments = t.segments ? JSON.parse(t.segments) : []; } catch { segments = []; }
    return res.json({
      songId: id,
      status: t.status,
      language: t.language,
      languageProbability: t.language_probability,
      model: t.model,
      text: t.text,
      segments,
      audioDurationMs: t.audio_duration_ms,
      processingMs: t.processing_ms,
      error: t.error,
      updatedAt: t.updated_at,
    });
  });

  router.get('/subtitles/:id', async (req, res) => {
    const id = requireId(req.params.id);
    const row = await db.get('SELECT id, file_path, username FROM songs WHERE id = ? AND username = ?', [id, req.user]);
    if (!row) throw new HttpError(404, 'Canción no encontrada');
    const file = await resolveSongFile(config.musicDir, row);
    if (!file) throw new HttpError(404, 'Archivo no encontrado');
    return sendOrEnqueueVtt(res, file, 'music');
  });

  return router;
};
