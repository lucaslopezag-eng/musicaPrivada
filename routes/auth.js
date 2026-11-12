'use strict';
// Rutas de sesión. /login es la única ruta de /api accesible sin autenticar
// (aparte del worker de subtítulos, que tiene su propio secreto).
// FASE 2: cambio de contraseña y gestión de sesiones activas en /api/auth/*.

const express = require('express');
const { schemas, validate } = require('../src/validation');

function publicAuthRouter({ auth }) {
  const router = express.Router();
  router.post('/login', express.json({ limit: '10kb' }), validate({ body: schemas.login }), auth.login);
  // Alias con el prefijo nuevo.
  router.post('/auth/login', express.json({ limit: '10kb' }), validate({ body: schemas.login }), auth.login);
  return router;
}

function privateAuthRouter({ auth }) {
  const router = express.Router();
  router.get('/session', auth.session);
  router.post('/logout', auth.logout);
  router.get('/auth/session', auth.session);
  router.post('/auth/logout', auth.logout);

  router.post('/auth/change-password', validate({ body: schemas.changePassword }), auth.changePassword);
  router.get('/auth/sessions', auth.listSessions);
  router.delete('/auth/sessions', auth.revokeOtherSessions);
  router.delete('/auth/sessions/:id', validate({ params: schemas.sessionIdParams }), auth.revokeSessionById);
  return router;
}

module.exports = { publicAuthRouter, privateAuthRouter };
