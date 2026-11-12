'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { createSecurityHeaders, buildCsp, helmetOptions } = require('../src/security');
const { createLogger, inferLevel } = require('../src/logger');
const { fakeRes } = require('./helpers/env');

test('CSP estricta compatible con la PWA', () => {
  const csp = buildCsp();
  assert.match(csp, /default-src 'self'/);
  assert.match(csp, /script-src 'self'(;|$)/, 'sin unsafe-inline ni eval en scripts');
  assert.doesNotMatch(csp, /unsafe-eval/);
  assert.match(csp, /frame-ancestors 'none'/);
  assert.match(csp, /object-src 'none'/);
  assert.match(csp, /media-src 'self' blob:/);
  assert.match(csp, /worker-src 'self'/);
  assert.doesNotMatch(csp, /upgrade-insecure-requests/, 'rompería el acceso http en la LAN');
});

test('sin helmet: cabeceras equivalentes', () => {
  const logs = [];
  const mw = createSecurityHeaders({ helmetModule: null, log: m => logs.push(m) });
  const res = fakeRes();
  let next = false;
  mw({}, res, () => { next = true; });
  assert.equal(next, true);
  assert.equal(res.headers['x-frame-options'], 'DENY');
  assert.equal(res.headers['x-content-type-options'], 'nosniff');
  assert.equal(res.headers['referrer-policy'], 'same-origin');
  assert.match(res.headers['content-security-policy'], /default-src 'self'/);
  assert.match(res.headers['permissions-policy'], /camera=\(\)/);
  assert.ok(logs.some(l => /helmet/.test(l)));
  const ro = fakeRes();
  createSecurityHeaders({ helmetModule: null, reportOnly: true })({}, ro, () => {});
  assert.ok(ro.headers['content-security-policy-report-only']);
});

test('con helmet: se le pasan las directivas y se añade Permissions-Policy', () => {
  let received;
  const fakeHelmet = (opts) => { received = opts; return (req, res, next) => { res.setHeader('X-From-Helmet', '1'); next(); }; };
  const res = fakeRes();
  createSecurityHeaders({ helmetModule: fakeHelmet })({}, res, () => {});
  assert.equal(res.headers['x-from-helmet'], '1');
  assert.ok(res.headers['permissions-policy']);
  assert.deepEqual(received, helmetOptions());
  assert.equal(received.contentSecurityPolicy.directives.scriptSrc[0], "'self'");
  assert.equal(received.xFrameOptions.action, 'deny');
  assert.equal(received.crossOriginEmbedderPolicy, false);
});

test('logger: niveles, formato JSON, hijos y clasificación de mensajes heredados', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'mp-log-'));
  const file = path.join(dir, 'app.log');
  const logger = createLogger({ file, level: 'info', format: 'json', console: false });
  logger.debug('no debe aparecer');
  logger.info('hola', { user: 'skiper' });
  logger.child({ reqId: 'r1' }).warn('cuidado');
  logger.log('[Biblioteca] Error sincronizando skiper');
  logger.log('Servidor escuchando');
  await logger.close();
  const lines = fs.readFileSync(file, 'utf8').trim().split('\n').map(l => JSON.parse(l));
  assert.deepEqual(lines.map(l => l.level), ['info', 'warn', 'error', 'info']);
  assert.equal(lines[0].user, 'skiper');
  assert.equal(lines[1].reqId, 'r1');
  assert.ok(lines.every(l => typeof l.ts === 'string'));
  assert.equal(inferLevel('[Auth] Login fallido para "x"'), 'warn');
  assert.equal(inferLevel('Conectado a SQLite.'), 'info');
  fs.rmSync(dir, { recursive: true, force: true });
});

test('logger: rotación por tamaño y tail()', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'mp-log-'));
  const file = path.join(dir, 'app.log');
  const logger = createLogger({ file, maxBytes: 64 * 1024, maxFiles: 2, console: false });
  for (let i = 0; i < 1500; i++) logger.info(`línea ${i} ${'x'.repeat(60)}`);
  await new Promise(r => setTimeout(r, 200));
  assert.match(await logger.tail(1), /línea 1499/);
  await logger.close();
  assert.ok(fs.existsSync(`${file}.1`), 'rotado');
  assert.equal(fs.existsSync(`${file}.3`), false, 'respeta maxFiles');
  fs.rmSync(dir, { recursive: true, force: true });
});
