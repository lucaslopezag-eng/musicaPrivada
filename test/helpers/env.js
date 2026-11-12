'use strict';
// Utilidades compartidas por las pruebas: BD temporal (better-sqlite3 o, si no
// está instalado, node:sqlite) y stubs de dependencias npm para poder probar
// módulos que las importan sin instalarlas.
const fs = require('fs');
const os = require('os');
const path = require('path');
const crypto = require('crypto');
const Module = require('module');

function driverAvailable() {
  try { require('better-sqlite3'); return true; } catch { /* sigue */ }
  try { require('node:sqlite'); return true; } catch { return false; }
}

async function tempDb() {
  const { openDatabase } = require('../../src/db');
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'mp-test-'));
  const file = path.join(dir, 'test.sqlite');
  const db = await openDatabase(file);
  return {
    db, dir, file,
    async cleanup() {
      await db.close();
      fs.rmSync(dir, { recursive: true, force: true });
    },
  };
}

async function migratedDb(extraCtx = {}) {
  const t = await tempDb();
  const { migrate } = require('../../src/migrations');
  const musicDir = path.join(t.dir, 'music');
  const aiMusicDir = path.join(t.dir, 'ai');
  fs.mkdirSync(musicDir, { recursive: true });
  fs.mkdirSync(aiMusicDir, { recursive: true });
  await migrate(t.db, { log: () => {}, rootDir: t.dir, musicDir, aiMusicDir, legacyOwner: 'skiper', ...extraCtx });
  return { ...t, musicDir, aiMusicDir };
}

// bcrypt determinista y rápido para pruebas (formato válido para BCRYPT_RE).
const ALPHABET = './ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789';
function fakeHash(password) {
  const digest = crypto.createHash('sha512').update(String(password)).digest();
  let body = '';
  for (let i = 0; i < 53; i++) body += ALPHABET[digest[i % digest.length] % 64];
  return `$2b$12$${body}`;
}
const fakeBcrypt = {
  hashSync: (p) => fakeHash(p),
  hash: async (p) => fakeHash(p),
  compare: async (p, h) => fakeHash(p) === h,
  compareSync: (p, h) => fakeHash(p) === h,
};

// Carga `request` con algunos módulos sustituidos por stubs.
function requireWithStubs(request, stubs) {
  const origLoad = Module._load;
  Module._load = function load(name, ...rest) {
    if (Object.prototype.hasOwnProperty.call(stubs, name)) return stubs[name];
    return origLoad.call(this, name, ...rest);
  };
  try {
    return require(request);
  } finally {
    Module._load = origLoad;
  }
}

// Respuesta Express mínima para probar manejadores.
function fakeRes() {
  const res = {
    statusCode: 200, body: undefined, headers: {},
    status(code) { this.statusCode = code; return this; },
    json(body) { this.body = body; return this; },
    setHeader(k, v) { this.headers[k.toLowerCase()] = v; },
    getHeader(k) { return this.headers[k.toLowerCase()]; },
    append(k, v) {
      const key = k.toLowerCase();
      this.headers[key] = this.headers[key] ? [].concat(this.headers[key], v) : v;
      return this;
    },
  };
  return res;
}

module.exports = { driverAvailable, tempDb, migratedDb, fakeBcrypt, fakeHash, requireWithStubs, fakeRes };
