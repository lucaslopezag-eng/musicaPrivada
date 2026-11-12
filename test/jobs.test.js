'use strict';
// Cola de trabajos persistente (FASE 2): estado en la tabla `jobs`,
// recuperación tras reinicio e idempotencia de los reintentos.
const test = require('node:test');
const assert = require('node:assert/strict');
const { driverAvailable, migratedDb } = require('./helpers/env');
const { createTaskManager } = require('../src/services/tasks');

const skip = !driverAvailable() && 'sin driver SQLite (npm install)';
const row = (db, id) => db.getSync('SELECT * FROM jobs WHERE id = ?', [id]);

test('el estado, el progreso y el log se guardan en SQLite', { skip }, async () => {
  const t = await migratedDb();
  try {
    const tm = createTaskManager({ log: () => {}, db: t.db });
    tm.registerHandler('import', async (task, payload) => {
      assert.deepEqual(payload, { tracksText: 'a - b', playlistId: null });
      tm.update(task, { total: 2 });
      tm.bump(task, 'done');
      tm.bump(task, 'skipped');
      tm.appendLog(task, 'hecho');
    });
    const task = tm.enqueue('skiper', 'import', { tracksText: 'a - b', playlistId: null }, { playlistId: null });
    assert.equal(row(t.db, task.id).status, 'pending');
    assert.match(row(t.db, task.id).payload, /tracksText/);
    await tm.downloadQueue.push(async () => {}); // espera a que termine
    tm.flush();
    const r = row(t.db, task.id);
    assert.equal(r.status, 'completed');
    assert.equal(r.progress, 100);
    assert.equal(r.payload, null, 'el payload se descarta al terminar');
    assert.equal(r.attempts, 1);
    assert.deepEqual(JSON.parse(r.result), { meta: { playlistId: null }, total: 2, done: 1, skipped: 1, failed: 0 });
    assert.match(r.log, /hecho/);

    // Un gestor nuevo (otro proceso) lee la tarea de la BD.
    const tm2 = createTaskManager({ log: () => {}, db: t.db });
    const loaded = tm2.get('skiper', task.id);
    assert.equal(loaded.status, 'completed');
    assert.equal(tm2.get('alejandro', task.id), null, 'aislamiento por usuario');
    assert.equal(tm2.list('skiper').length, 1);
    assert.match(tm2.userLogText('skiper'), /hecho/);
    assert.equal(tm2.serialize(loaded).progress, 100);
    assert.equal('payload' in tm2.serialize(loaded), false);
  } finally {
    await t.cleanup();
  }
});

test('los fallos se registran con su mensaje', { skip }, async () => {
  const t = await migratedDb();
  try {
    const tm = createTaskManager({ log: () => {}, db: t.db });
    tm.registerHandler('download', async () => { throw new Error('yt-dlp caído'); });
    const task = tm.enqueue('skiper', 'download', { mediaUrl: 'x' });
    await tm.downloadQueue.push(async () => {});
    const r = row(t.db, task.id);
    assert.equal(r.status, 'failed');
    assert.equal(r.error_message, 'yt-dlp caído');
    // Tipo sin manejador.
    const orphan = tm.create('skiper', 'desconocido', {}, {});
    await tm.runQueued(orphan);
    assert.equal(row(t.db, orphan.id).status, 'failed');
  } finally {
    await t.cleanup();
  }
});

test('recover(): reanuda lo interrumpido, falla lo irrecuperable y respeta el máximo de intentos', { skip }, async () => {
  const t = await migratedDb();
  try {
    // "Proceso 1": tareas que quedan a medias por un reinicio.
    const tm1 = createTaskManager({ log: () => {}, db: t.db, maxAttempts: 2 });
    const running = tm1.create('skiper', 'import', {}, { tracksText: 'x - y' });
    tm1.update(running, { status: 'running', attempts: 1 });
    const pending = tm1.create('skiper', 'download', {}, { mediaUrl: 'u' });
    const noPayload = tm1.create('skiper', 'import', {}, null);
    const exhausted = tm1.create('skiper', 'import', {}, { tracksText: 'z' });
    tm1.update(exhausted, { status: 'running', attempts: 2 });
    const unknownType = tm1.create('skiper', 'scrape', {}, { url: 'x' });
    const done = tm1.create('skiper', 'import', {}, { tracksText: 'ok' });
    tm1.update(done, { status: 'completed' });
    tm1.flush();

    // "Proceso 2" tras el reinicio.
    const seen = [];
    const logs = [];
    const tm2 = createTaskManager({ log: m => logs.push(m), db: t.db, maxAttempts: 2 });
    tm2.registerHandler('import', async (task, payload) => { seen.push([task.id, payload.tracksText]); });
    tm2.registerHandler('download', async (task, payload) => { seen.push([task.id, payload.mediaUrl]); });
    const summary = tm2.recover();
    assert.deepEqual(summary, { resumed: 2, failed: 3 });
    await tm2.downloadQueue.push(async () => {});
    tm2.flush();

    assert.deepEqual(seen, [[running.id, 'x - y'], [pending.id, 'u']], 'se reanudan en orden de creación');
    assert.equal(row(t.db, running.id).status, 'completed');
    assert.equal(row(t.db, running.id).attempts, 2);
    assert.match(row(t.db, running.id).log, /Reanudada tras un reinicio/);
    assert.equal(row(t.db, pending.id).status, 'completed');
    for (const id of [noPayload.id, exhausted.id, unknownType.id]) {
      assert.equal(row(t.db, id).status, 'failed', id);
      assert.match(row(t.db, id).error_message, /Interrumpida/);
    }
    assert.equal(row(t.db, done.id).status, 'completed', 'lo terminado no se toca');
    assert.ok(logs.some(l => /2 reanudadas, 3 marcadas como fallidas/.test(l)));
    // Una segunda recuperación no hace nada.
    assert.deepEqual(createTaskManager({ log: () => {}, db: t.db }).recover(), { resumed: 0, failed: 0 });
  } finally {
    await t.cleanup();
  }
});

test('purga: se conservan como mucho 50 tareas terminadas por usuario', { skip }, async () => {
  const t = await migratedDb();
  try {
    const tm = createTaskManager({ log: () => {}, db: t.db });
    for (let i = 0; i < 55; i++) {
      const task = tm.create('skiper', 'import', {}, null);
      tm.update(task, { status: 'completed' });
    }
    tm.create('skiper', 'import', {}, null);
    assert.ok(t.db.getSync("SELECT COUNT(*) AS n FROM jobs WHERE username = 'skiper'").n <= 51);
  } finally {
    await t.cleanup();
  }
});
