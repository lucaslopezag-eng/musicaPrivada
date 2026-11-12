'use strict';
// ─── REGISTRO DE ESCUCHAS ────────────────────────────────────────────────────
// DB-05 / AUDIO-03:
// · Recomendaciones IA ("ai-12") → is_ai=1, ai_rec_id=12, song_id NULL.
// · La canción debe pertenecer al usuario.
// · listen_duration_ms se limita a la duración real + 5 s (el servidor ya no
//   confía ciegamente en el cliente).
// · Acepta navigator.sendBeacon (cookie de sesión) para no perder el último
//   tramo al cerrar la app (pagehide).

const express = require('express');
const { HttpError } = require('../src/http');
const { schemas, validate } = require('../src/validation');

const MAX_UNKNOWN_DURATION_MS = 30 * 60 * 1000;

function clampInt(value, min, max) {
  const n = Number(value);
  if (!Number.isFinite(n)) return null;
  return Math.min(max, Math.max(min, Math.round(n)));
}

module.exports = function statsRouter({ db }) {
  const router = express.Router();

  router.post('/stats/listen', validate({ body: schemas.listen }), async (req, res) => {
    const body = req.body;
    const rawId = body.song_id;

    const completed = body.completed ? 1 : 0;
    let listenMs = clampInt(body.listen_duration_ms, 0, Number.MAX_SAFE_INTEGER) || 0;

    const aiMatch = /^ai-(\d{1,15})$/.exec(String(rawId));
    if (aiMatch) {
      const recId = Number(aiMatch[1]);
      const rec = await db.get('SELECT id FROM ai_recommendations WHERE id = ? AND username = ?', [recId, req.user]);
      if (!rec) throw new HttpError(404, 'Recomendación no encontrada');
      listenMs = Math.min(listenMs, MAX_UNKNOWN_DURATION_MS);
      await db.run(
        "INSERT INTO play_history (song_id, listen_duration_ms, completed, username, is_ai, ai_rec_id, source) VALUES (NULL, ?, ?, ?, 1, ?, 'ai')",
        [listenMs, completed, req.user, recId]
      );
      return res.json({ message: 'Listening stats recorded' });
    }

    const songId = rawId; // número validado por el esquema
    const song = await db.get('SELECT id, duration FROM songs WHERE id = ? AND username = ?', [songId, req.user]);
    if (!song) throw new HttpError(404, 'Canción no encontrada');

    const maxMs = song.duration > 0 ? song.duration + 5000 : MAX_UNKNOWN_DURATION_MS;
    listenMs = Math.min(listenMs, maxMs);
    const skipAt = completed ? null : clampInt(body.skip_at_ms, 0, maxMs);
    const playlistId = body.playlist_id;
    let contextPlaylist = null;
    if (playlistId) {
      const pl = await db.get('SELECT id FROM playlists WHERE id = ? AND username = ?', [playlistId, req.user]);
      contextPlaylist = pl ? pl.id : null;
    }

    await db.run(
      'INSERT INTO play_history (song_id, listen_duration_ms, completed, username, skip_at_ms, context_playlist_id) VALUES (?,?,?,?,?,?)',
      [song.id, listenMs, completed, req.user, skipAt, contextPlaylist]
    );
    res.json({ message: 'Listening stats recorded' });
  });

  return router;
};
