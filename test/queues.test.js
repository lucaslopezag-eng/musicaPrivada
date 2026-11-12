'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { createSerialQueue, createTaskManager } = require('../src/services/tasks');
const { createSubtitleQueue } = require('../src/services/subtitles');

test('la cola serie no solapa trabajos y sobrevive a errores', async () => {
  const q = createSerialQueue();
  let running = 0; let maxRunning = 0; const order = [];
  const job = (i, fail) => async () => {
    running++; maxRunning = Math.max(maxRunning, running);
    await new Promise(r => setTimeout(r, 5));
    order.push(i); running--;
    if (fail) throw new Error('x');
  };
  await Promise.allSettled([q.push(job(1)), q.push(job(2, true)), q.push(job(3))]);
  assert.equal(maxRunning, 1);
  assert.deepEqual(order, [1, 2, 3]);
});

test('tareas en memoria: aislamiento por usuario y estado failed', async () => {
  const tm = createTaskManager({ log: () => {} });
  const t = tm.create('skiper', 'import');
  assert.equal(t.status, 'pending');
  await tm.runQueued(t, async () => { throw new Error('boom'); });
  assert.equal(t.status, 'failed');
  assert.throws(() => tm.update(t, { status: 'queued' }), /no válido/);
  assert.equal(tm.get('alejandro', t.id), null);
  assert.equal(tm.get('skiper', t.id), t);
  assert.match(tm.userLogText('skiper'), /boom/);
  assert.equal(tm.userLogText('alejandro'), '');
});

test('cola de subtítulos: ids opacos, rutas relativas y validación WebVTT', async () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'mp-sub-'));
  const musicDir = path.join(tmp, 'music');
  fs.mkdirSync(path.join(musicDir, 'skiper'), { recursive: true });
  const audio = path.join(musicDir, 'skiper', 'a.opus');
  fs.writeFileSync(audio, 'x');
  const q = createSubtitleQueue({ config: { musicDir, aiMusicDir: path.join(tmp, 'ai') }, log: () => {} });
  const id = q.enqueue(audio, 'music', true);
  assert.equal(q.enqueue(audio, 'music', true), id, 'deduplica');
  const job = q.next();
  assert.equal(job.relative, 'skiper/a.opus');
  assert.equal(q.findActive({ audioPath: 'skiper/a.opus' }), job);
  assert.equal(q.findActive({ jobId: 'otro' }), null);
  await assert.rejects(q.complete(job, '<html>'), /WebVTT/);
  await q.complete(job, 'WEBVTT\n\n00:00.000 --> 00:01.000\nhola\n');
  assert.ok(fs.existsSync(path.join(musicDir, 'skiper', 'a.vtt')));
  assert.equal(q.findActive({ jobId: job.id }), null);
  fs.rmSync(tmp, { recursive: true, force: true });
});
