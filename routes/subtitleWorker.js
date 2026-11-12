'use strict';
// ─── API DEL WORKER DE SUBTÍTULOS (AUTH-06) ──────────────────────────────────
// Protegida por SUBTITLE_WORKER_TOKEN (cabecera "X-Worker-Token" o
// "Authorization: Bearer"). Si no hay token configurado, solo se aceptan
// peticiones locales y únicamente cuando HOST es loopback.
// La subida usa su propio parser con límite de 2 MB y DESPUÉS de autenticar.

const express = require('express');
const crypto = require('crypto');
const path = require('path');
const { MAX_VTT_BYTES } = require('../src/services/subtitles');
const { schemas, validate } = require('../src/validation');

const jobQuery = validate({ query: schemas.workerJobQuery });

function timingSafeEqualStr(a, b) {
  const ha = crypto.createHash('sha256').update(String(a)).digest();
  const hb = crypto.createHash('sha256').update(String(b)).digest();
  return crypto.timingSafeEqual(ha, hb);
}

const LOOPBACK_HOSTS = new Set(['127.0.0.1', '::1', 'localhost']);

function isLoopback(req) {
  const addr = req.socket.remoteAddress || '';
  const local = addr === '127.0.0.1' || addr === '::1' || addr === '::ffff:127.0.0.1';
  return local && !req.headers['x-forwarded-for'] && !req.headers['forwarded'];
}

module.exports = function subtitleWorkerRouter({ config, subtitles, log }) {
  const router = express.Router();

  router.use((req, res, next) => {
    if (config.workerToken) {
      const header = req.get('x-worker-token') || (/^Bearer\s+(.+)$/i.exec(req.get('authorization') || '') || [])[1];
      if (header && timingSafeEqualStr(header.trim(), config.workerToken)) return next();
      log(`[Subtítulos] Acceso de worker rechazado desde ${req.ip}`);
      return res.status(401).json({ error: 'Worker no autorizado' });
    }
    // Sin token, solo si el servidor escucha exclusivamente en loopback: un
    // proxy local que no envíe X-Forwarded-For (p. ej. el de Vite) haría que
    // peticiones de internet parecieran locales.
    if (LOOPBACK_HOSTS.has(config.host) && isLoopback(req)) return next();
    return res.status(403).json({ error: 'Configura SUBTITLE_WORKER_TOKEN para usar el worker de subtítulos' });
  });

  router.get('/queue', (req, res) => {
    const job = subtitles.next();
    if (!job) return res.json({ job: null });
    res.json({
      job: {
        id: job.id,
        // Ruta relativa (compatibilidad con el worker anterior, que la devuelve
        // en la subida). Ya no se revelan rutas absolutas del servidor.
        audioPath: job.relative,
        fileName: path.basename(job.absPath),
        downloadUrl: `/api/subtitles/worker/download?job=${encodeURIComponent(job.id)}`,
        uploadUrl: `/api/subtitles/worker/upload?job=${encodeURIComponent(job.id)}`,
      },
    });
  });

  router.get('/download', jobQuery, (req, res) => {
    const job = subtitles.findActive({ jobId: req.valid.query.job, audioPath: req.valid.query.file });
    if (!job) return res.status(404).send('Trabajo no encontrado o caducado');
    res.download(job.absPath, path.basename(job.absPath), { dotfiles: 'allow' });
  });

  router.post('/upload', jobQuery, express.text({ limit: MAX_VTT_BYTES, type: () => true }), async (req, res) => {
    const job = subtitles.findActive({ jobId: req.valid.query.job, audioPath: req.valid.query.audioPath });
    if (!job) return res.status(400).json({ error: 'Trabajo no válido o caducado' });
    await subtitles.complete(job, req.body);
    res.json({ success: true });
  });

  return router;
};
