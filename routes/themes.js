'use strict';
// ─── IMÁGENES DE TEMAS VISUALES ──────────────────────────────────────────────
// Los recursos de cada tema viven en frontend/dist/themes/<tema>/ y solo se
// sirven por aquí (server.js corta el acceso estático a /themes). Así un tema
// vetado a un usuario (users.hidden_themes) tampoco se puede descargar con la
// URL directa. La cookie de sesión (Path=/api) autentica los url() del CSS.

const express = require('express');
const path = require('path');
const { THEME_ID_RE } = require('../src/users');

const FILE_RE = /^[A-Za-z0-9_-]{1,64}\.(webp|png|jpe?g|gif|svg)$/;

function themesRouter({ config, users }) {
  const router = express.Router();
  const root = path.join(config.distDir, 'themes');

  router.get('/themes/:theme/:file', (req, res) => {
    const { theme, file } = req.params;
    if (!THEME_ID_RE.test(theme) || !FILE_RE.test(file)) return res.status(404).json({ error: 'No encontrado' });
    if (users.hiddenThemes(req.user).includes(theme)) return res.status(403).json({ error: 'Tema no disponible' });
    res.setHeader('Cache-Control', 'private, max-age=86400');
    return res.sendFile(path.join(root, theme, file), (err) => {
      if (err && !res.headersSent) res.status(404).json({ error: 'No encontrado' });
    });
  });

  return router;
}

module.exports = themesRouter;
