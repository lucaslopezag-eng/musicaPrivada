'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { loadConfig, ConfigError } = require('../src/config');

const HASH = '$2b$12$' + 'a'.repeat(53);

test('APP_USERS es opcional (usuarios en BD) pero, si existe, exige hash bcrypt', () => {
  const cfg = loadConfig({});
  assert.equal(cfg.users.size, 0);
  assert.equal(cfg.legacyOwner, '');
  assert.throws(() => loadConfig({ APP_USERS: 'skiper:texto-plano-no-valido' }), /bcrypt/);
  assert.throws(() => loadConfig({ APP_USERS: `../x:${HASH}` }), ConfigError);
});

test('carga usuarios, admins y valores por defecto', () => {
  const cfg = loadConfig({ APP_USERS: `skiper:${HASH},Alejandro:${HASH}`, ADMIN_USERS: 'skiper' });
  assert.deepEqual([...cfg.users.keys()], ['skiper', 'alejandro']);
  assert.equal(cfg.admins.has('skiper'), true);
  assert.equal(cfg.admins.has('alejandro'), false);
  assert.equal(cfg.streamThrottleBps, 0);
  assert.equal(cfg.legacyOwner, 'skiper');
  // ADMIN_USERS puede nombrar usuarios que solo existen en la BD (se avisa al sembrar).
  assert.equal(loadConfig({ APP_USERS: `skiper:${HASH}`, ADMIN_USERS: 'nadie' }).admins.has('nadie'), true);
  assert.throws(() => loadConfig({ ADMIN_USERS: '../root' }), ConfigError);
  assert.throws(() => loadConfig({ APP_USERS: `skiper:${HASH}`, SUBTITLE_WORKER_TOKEN: 'corto' }), ConfigError);
});

test('opciones de la Fase 2', () => {
  const cfg = loadConfig({ LOG_LEVEL: 'WARN', LOG_FORMAT: 'json', SPOTIFY_CLIENT_ID: 'a', SPOTIFY_MARKET: 'xx', JOB_MAX_ATTEMPTS: '99' });
  assert.equal(cfg.logLevel, 'warn');
  assert.equal(cfg.logFormat, 'json');
  assert.equal(cfg.spotifyClientId, 'a');
  assert.equal(cfg.spotifyMarket, 'ES');
  assert.equal(cfg.jobMaxAttempts, 10);
  assert.equal(loadConfig({ LOG_LEVEL: 'verbose' }).logLevel, 'info');
});
