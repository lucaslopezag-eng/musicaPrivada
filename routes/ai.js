'use strict';
// ─── RECOMENDACIONES IA ──────────────────────────────────────────────────────

const express = require('express');
const { HttpError } = require('../src/http');
const { schemas, validate } = require('../src/validation');

const byId = validate({ params: schemas.idParams });

module.exports = function aiRouter({ recs, library }) {
  const router = express.Router();

  router.get('/ai-recommendations', async (req, res) => {
    res.json(await recs.listDownloaded(req.user));
  });

  router.get('/ai-recommendations/status', async (req, res) => {
    res.json({ generating: recs.isGenerating(req.user), counts: await recs.statusCounts(req.user) });
  });

  router.post('/ai-recommendations/generate', validate({ body: schemas.aiGenerate }), (req, res) => {
    // IA-3: si la última generación no trajo nada nuevo, se espera antes de repetir.
    const wait = typeof recs.generationCooldown === 'function' ? recs.generationCooldown(req.user) : 0;
    if (wait > 0 && !recs.isGenerating(req.user)) {
      res.setHeader('Retry-After', String(wait));
      return res.status(429).json({ error: 'La última generación no encontró recomendaciones nuevas. Se volverá a intentar más tarde.', retryAfter: wait });
    }
    const started = recs.generate(req.user, req.body.count);
    if (!started) return res.status(409).json({ error: 'Ya hay una generación de recomendaciones en curso', generating: true });
    return res.status(202).json({ message: 'AI recommendation generation started...', generating: true });
  });

  router.post('/ai-recommendations/:id/accept', byId, async (req, res) => {
    const result = await recs.accept(req.user, req.valid.params.id);
    if (!result) throw new HttpError(404, 'Recomendación no encontrada');
    if (result.error) throw new HttpError(410, result.error);
    library.bumpVersion(req.user);
    // song: la canción de la biblioteca en la que se ha convertido (IA-2).
    res.json({ message: 'Accepted. Song moved to library.', song: result.song || null });
  });

  // Pulgar abajo: se archiva (no se borra al instante; se purga más tarde).
  router.post('/ai-recommendations/:id/reject', byId, async (req, res) => {
    const result = await recs.archive(req.user, req.valid.params.id, 'rejected');
    if (!result) throw new HttpError(404, 'Recomendación no encontrada');
    res.json({ message: 'Rejected.' });
  });

  // Botón "siguiente" sobre una recomendación: no es un rechazo explícito.
  router.post('/ai-recommendations/:id/skip', byId, async (req, res) => {
    const result = await recs.archive(req.user, req.valid.params.id, 'skipped');
    if (!result) throw new HttpError(404, 'Recomendación no encontrada');
    res.json({ message: 'Skipped.' });
  });

  // Escuchada hasta el final: deja de ofrecerse (y cuenta para el refresco
  // nocturno), pero se conserva archivada hasta la purga.
  router.post('/ai-recommendations/:id/played', byId, async (req, res) => {
    const result = await recs.archive(req.user, req.valid.params.id, 'played');
    if (!result) throw new HttpError(404, 'Recomendación no encontrada');
    res.json({ message: 'Played.' });
  });

  return router;
};
