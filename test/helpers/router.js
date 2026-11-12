'use strict';
// Sustituto mínimo de express.Router para probar los routers reales sin
// instalar Express: registra la cadena de middlewares de cada ruta y permite
// invocarla con una petición simulada (incluye el comportamiento de Express 5
// de capturar los errores de los manejadores async).
const { fakeRes } = require('./env');

function compile(pattern) {
  if (pattern instanceof RegExp) return { re: pattern, keys: null };
  const keys = [];
  const re = new RegExp(`^${pattern.replace(/:([A-Za-z_]+)/g, (_, k) => { keys.push(k); return '([^/]+)'; })}$`);
  return { re, keys };
}

function createExpressStub() {
  const routers = [];
  function Router() {
    const routes = [];
    const add = (method) => (path, ...handlers) => { routes.push({ method, ...compile(path), handlers }); };
    const router = { routes, get: add('GET'), post: add('POST'), delete: add('DELETE'), put: add('PUT'), use: () => {} };
    routers.push(router);
    return router;
  }
  const passthrough = () => (req, res, next) => next();
  const express = Object.assign(() => ({}), { Router, json: passthrough, text: passthrough, static: passthrough });
  return { express, routers };
}

async function call(router, method, url, { body, user = 'skiper', isAdmin = false, query = {} } = {}) {
  const path = url.split('?')[0];
  for (const route of router.routes) {
    if (route.method !== method) continue;
    const m = route.re.exec(path);
    if (!m) continue;
    const params = {};
    if (route.keys) route.keys.forEach((k, i) => { params[k] = decodeURIComponent(m[i + 1]); });
    const req = { method, path, originalUrl: url, params, query, body, user, isAdmin, headers: {}, get: () => undefined, ip: '127.0.0.1', socket: {} };
    const res = fakeRes();
    let i = 0;
    const next = async (err) => {
      if (err) throw err;
      const h = route.handlers[i++];
      if (h) await h(req, res, next);
    };
    try {
      await next();
    } catch (err) {
      // Manejador de errores de server.js (HttpError → status y mensaje).
      res.status(Number.isInteger(err.status) ? err.status : 500).json({ error: err.message });
    }
    return res;
  }
  throw new Error(`Ruta no registrada: ${method} ${path}`);
}

module.exports = { createExpressStub, call };
