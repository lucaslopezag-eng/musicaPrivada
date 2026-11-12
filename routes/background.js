'use strict';
// ─── FONDO DE PANTALLA PROPIO (POR USUARIO) ──────────────────────────────────
// Cada usuario puede subir UNA imagen de fondo y elegir su opacidad (0-100).
// · La imagen se guarda en backgrounds/<usuario>-<marca>.<ext> (fuera de dist y
//   del repositorio); la marca de tiempo hace de versión en la URL.
// · Solo se aceptan JPEG/PNG/WebP comprobando los bytes iniciales, no solo el
//   Content-Type. El cliente ya la reduce antes de subirla (máx. ~2560 px).
// · GET /api/background sirve la del usuario de la sesión (cookie Path=/api),
//   así que nunca se puede pedir el fondo de otro usuario.

const express = require('express');
const fs = require('fs');
const fsp = fs.promises;
const path = require('path');
const { publicBackground } = require('../src/auth');
const { BG_FILE_RE } = require('../src/users');
const { schemas, validate } = require('../src/validation');

const MAX_BYTES = 8 * 1024 * 1024;
const UPLOAD_TYPES = ['image/jpeg', 'image/png', 'image/webp'];

// Tipo real según la firma del archivo.
function sniffImage(buf) {
  if (buf.length >= 3 && buf[0] === 0xff && buf[1] === 0xd8 && buf[2] === 0xff) return 'jpg';
  if (buf.length >= 8 && buf.subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]))) return 'png';
  if (buf.length >= 12 && buf.toString('ascii', 0, 4) === 'RIFF' && buf.toString('ascii', 8, 12) === 'WEBP') return 'webp';
  return null;
}

function backgroundRouter({ config, users, log }) {
  const router = express.Router();
  const dir = path.join(config.rootDir, 'backgrounds');

  async function removeFile(file) {
    if (!file || !BG_FILE_RE.test(file)) return;
    await fsp.unlink(path.join(dir, file)).catch(() => {});
  }

  router.get('/background', (req, res) => {
    const { file } = users.background(req.user);
    if (!file) return res.status(404).json({ error: 'Sin fondo' });
    res.setHeader('Cache-Control', 'private, max-age=31536000, immutable');
    return res.sendFile(path.join(dir, file), (err) => {
      if (err && !res.headersSent) res.status(404).json({ error: 'No encontrado' });
    });
  });

  router.put('/background', express.raw({ type: UPLOAD_TYPES, limit: MAX_BYTES }), async (req, res, next) => {
    try {
      if (!Buffer.isBuffer(req.body) || !req.body.length) return res.status(400).json({ error: 'Envía una imagen JPEG, PNG o WebP' });
      const ext = sniffImage(req.body);
      if (!ext) return res.status(415).json({ error: 'Formato no admitido (JPEG, PNG o WebP)' });
      await fsp.mkdir(dir, { recursive: true });
      const file = `${req.user}-${Date.now()}.${ext}`;
      const tmp = path.join(dir, `.${file}.tmp`);
      await fsp.writeFile(tmp, req.body);
      await fsp.rename(tmp, path.join(dir, file));
      const previous = users.background(req.user).file;
      users.setBackgroundFile(req.user, file);
      if (previous && previous !== file) await removeFile(previous);
      log(`[Fondo] ${req.user} subió un fondo (${Math.round(req.body.length / 1024)} KB)`);
      return res.json({ background: publicBackground(users.background(req.user)) });
    } catch (err) {
      return next(err);
    }
  });

  router.patch('/background', validate({ body: schemas.backgroundOpacity }), (req, res) => {
    users.setBackgroundOpacity(req.user, req.body.opacity);
    return res.json({ background: publicBackground(users.background(req.user)) });
  });

  router.delete('/background', async (req, res, next) => {
    try {
      const previous = users.background(req.user).file;
      users.setBackgroundFile(req.user, null);
      await removeFile(previous);
      return res.json({ background: publicBackground(users.background(req.user)) });
    } catch (err) {
      return next(err);
    }
  });

  return router;
}

module.exports = backgroundRouter;
module.exports.sniffImage = sniffImage;
