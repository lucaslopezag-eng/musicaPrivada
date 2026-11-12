'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { driverAvailable, tempDb, migratedDb } = require('./helpers/env');
const { normalizeParams } = require('../src/db');

const skip = !driverAvailable() && 'sin driver SQLite (npm install)';

test('normaliza parámetros (booleanos, undefined, fechas)', () => {
  assert.deepEqual(normalizeParams([true, false, undefined, null, 3, 'x']), [1, 0, null, null, 3, 'x']);
  assert.deepEqual(normalizeParams(undefined), []);
  assert.deepEqual(normalizeParams(7), [7]);
});

test('API async compatible y transacciones síncronas atómicas', { skip }, async () => {
  const t = await tempDb();
  const { db } = t;
  try {
    await db.exec('CREATE TABLE t (id INTEGER PRIMARY KEY, v TEXT)');
    const { lastID, changes } = await db.run('INSERT INTO t (v) VALUES (?)', ['a']);
    assert.equal(lastID, 1);
    assert.equal(changes, 1);
    assert.deepEqual(await db.get('SELECT v FROM t WHERE id = ?', [1]), { v: 'a' });
    assert.deepEqual(await db.all('SELECT v FROM t'), [{ v: 'a' }]);
    assert.equal(await db.get('SELECT v FROM t WHERE id = 99'), undefined);
    // Errores SQL → promesa rechazada (no excepción síncrona).
    await assert.rejects(db.run('INSERT INTO nope VALUES (1)'));

    // Rollback completo si la función lanza.
    assert.throws(() => db.transaction(() => {
      db.runSync('INSERT INTO t (v) VALUES (?)', ['b']);
      throw new Error('boom');
    }), /boom/);
    assert.equal(db.getSync('SELECT COUNT(*) AS n FROM t').n, 1);

    // Las funciones async se rechazan (romperían la atomicidad) y no dejan cambios.
    assert.throws(() => db.transaction(async () => { db.runSync("INSERT INTO t (v) VALUES ('c')"); }), /síncrona/);
    assert.equal(db.getSync('SELECT COUNT(*) AS n FROM t').n, 1);
    assert.equal(db.inTransaction, false);

    // Anidadas: SAVEPOINT; un fallo interno capturado no revierte el exterior.
    const value = db.transaction(() => {
      db.runSync("INSERT INTO t (v) VALUES ('outer')");
      try {
        db.transaction(() => { db.runSync("INSERT INTO t (v) VALUES ('inner')"); throw new Error('x'); });
      } catch { /* esperado */ }
      return 42;
    });
    assert.equal(value, 42);
    assert.deepEqual(db.allSync('SELECT v FROM t ORDER BY id').map(r => r.v), ['a', 'outer']);

    // run() sobre una sentencia que devuelve filas no falla (better-sqlite3 lo prohíbe).
    assert.doesNotThrow(() => db.runSync('SELECT 1'));
    assert.equal(db.getSync('PRAGMA journal_mode').journal_mode, 'wal');
  } finally {
    await t.cleanup();
  }
});

test('copia de seguridad consistente', { skip }, async () => {
  const t = await tempDb();
  try {
    await t.db.exec("CREATE TABLE x (v); INSERT INTO x VALUES ('hola');");
    const dest = require('path').join(t.dir, 'bk', 'copy.sqlite');
    await t.db.backup(dest);
    const { openDatabase } = require('../src/db');
    const copy = await openDatabase(dest);
    assert.equal((await copy.get('PRAGMA integrity_check')).integrity_check, 'ok');
    assert.equal((await copy.get('SELECT v FROM x')).v, 'hola');
    await copy.close();
  } finally {
    await t.cleanup();
  }
});

test('migraciones: tablas de Fase 2, idempotencia e ids de sesión heredadas', { skip }, async () => {
  const t = await tempDb();
  const { migrate } = require('../src/migrations');
  const fs = require('fs');
  const path = require('path');
  const ctx = { log: () => {}, rootDir: t.dir, musicDir: path.join(t.dir, 'm'), aiMusicDir: path.join(t.dir, 'a'), legacyOwner: 'skiper' };
  fs.mkdirSync(ctx.musicDir); fs.mkdirSync(ctx.aiMusicDir);
  try {
    // Esquema "v2.0": sesiones sin columna id.
    await t.db.exec(`CREATE TABLE sessions (token_hash TEXT PRIMARY KEY, username TEXT NOT NULL, created_at INTEGER NOT NULL,
      expires_at INTEGER NOT NULL, last_seen_at INTEGER NOT NULL, user_agent TEXT);
      INSERT INTO sessions VALUES ('h1', 'skiper', 1, 9999999999999, 1, 'ua');`);
    await migrate(t.db, ctx);
    await migrate(t.db, ctx); // idempotente
    const tables = t.db.allSync("SELECT name FROM sqlite_master WHERE type='table'").map(r => r.name);
    for (const name of ['songs', 'users', 'jobs', 'sessions', 'schema_migrations']) assert.ok(tables.includes(name), name);
    const jobCols = t.db.allSync('PRAGMA table_info(jobs)').map(c => c.name);
    for (const c of ['id', 'username', 'type', 'status', 'progress', 'payload', 'result', 'error_message', 'created_at', 'updated_at', 'attempts', 'log']) {
      assert.ok(jobCols.includes(c), c);
    }
    const userCols = t.db.allSync('PRAGMA table_info(users)').map(c => c.name);
    for (const c of ['username', 'password_hash', 'role', 'created_at', 'updated_at', 'password_updated_at']) assert.ok(userCols.includes(c), c);
    const indexes = t.db.allSync("SELECT name FROM sqlite_master WHERE type='index'").map(r => r.name);
    assert.ok(indexes.includes('idx_jobs_user_status'));
    assert.ok(indexes.includes('ux_sessions_id'));
    const s = t.db.getSync("SELECT id FROM sessions WHERE token_hash = 'h1'");
    assert.match(s.id, /^[A-Za-z0-9_-]{16}$/);
    assert.throws(() => t.db.runSync("INSERT INTO users (username, password_hash, role) VALUES ('x', 'h', 'root')"), /CHECK/i);
  } finally {
    await t.cleanup();
  }
});

test('migratedDb helper', { skip }, async () => {
  const t = await migratedDb();
  assert.equal(t.db.getSync('SELECT COUNT(*) AS n FROM users').n, 0);
  await t.cleanup();
});
