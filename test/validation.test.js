'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { schemas, validate } = require('../src/validation');
const { s } = require('../src/schema');
const { fakeRes } = require('./helpers/env');

function run(spec, req) {
  const res = fakeRes();
  let next = false;
  validate(spec)(req, res, () => { next = true; });
  return { res, next, req };
}

test('mini-librería de esquemas', () => {
  const sch = s.object({
    a: s.string().min(2).max(4),
    b: s.number().int().min(0).optional(),
    c: s.array(s.string()).max(2).nullish(),
    d: s.union([s.literal('x'), s.boolean()]).default('x'),
  });
  assert.deepEqual(sch.parse({ a: 'abc', extra: 1 }), { a: 'abc', d: 'x' }, 'descarta claves desconocidas y aplica default');
  assert.equal(sch.safeParse({ a: 'a' }).success, false);
  assert.deepEqual(sch.safeParse({ a: 'abc', b: 1.5 }).error.issues[0].path, ['b']);
  assert.equal(sch.safeParse({ a: 'abc', c: ['1', '2', '3'] }).success, false);
  assert.equal(sch.safeParse({ a: 'abc', c: null, d: true }).success, true);
  assert.equal(sch.safeParse('no-objeto').success, false);
  assert.equal(sch.safeParse([]).success, false);
  assert.throws(() => sch.parse({}), /obligatorio/);
});

test('ids y listas: números o cadenas de dígitos, nunca otra cosa', () => {
  assert.deepEqual(schemas.idParams.parse({ id: '42' }), { id: 42 });
  for (const bad of ['0', '-1', '1e3', 'abc', '', '9'.repeat(16), 1.5, null, true]) {
    assert.equal(schemas.idParams.safeParse({ id: bad }).success, false, String(bad));
  }
  assert.deepEqual(schemas.reorder.parse({ orderedIds: [3, '2', 1] }), { orderedIds: [3, 2, 1] });
  assert.equal(schemas.reorder.safeParse({ orderedIds: 'x' }).success, false);
  assert.equal(schemas.reorder.safeParse({ orderedIds: new Array(20001).fill(1) }).success, false);
});

test('esquemas de los endpoints de mutación', () => {
  assert.equal(schemas.trim.safeParse({ startTime: 1, endTime: 1.2 }).success, false);
  assert.equal(schemas.trim.safeParse({ startTime: -1, endTime: 5 }).success, false);
  assert.deepEqual(schemas.trim.parse({ startTime: '1', endTime: 3, rev: 2 }), { startTime: 1, endTime: 3, rev: 2 });
  assert.deepEqual(schemas.listen.parse({ song_id: 'ai-7', completed: 1 }), { song_id: 'ai-7', completed: true, playlist_id: null });
  assert.equal(schemas.listen.parse({ song_id: '9', playlist_id: '' }).song_id, 9);
  assert.equal(schemas.listen.safeParse({ song_id: 'ai-x' }).success, false);
  assert.equal(schemas.listen.safeParse({}).success, false);
  assert.equal(schemas.import.safeParse({ tracksText: '   ' }).success, false);
  assert.deepEqual(schemas.import.parse({ tracksText: 'a', playlistId: '3' }), { tracksText: 'a', playlistId: 3 });
  const dl = schemas.downloadSingle.parse({ url: 'https://youtu.be/x', title: 'T', id: 'yt', durationMs: 1, playlistId: '' });
  assert.deepEqual(dl, { url: 'https://youtu.be/x', title: 'T', artist: '', replaceId: null, playlistId: null });
  assert.equal(schemas.downloadSingle.safeParse({ url: 'https://youtu.be/x', title: 'x'.repeat(301) }).success, false);
  assert.equal(schemas.playlistCreate.parse({ name: 'Rock', cover_url: null }).name, 'Rock');
  assert.equal(schemas.playlistCreate.safeParse({ name: 5 }).success, false);
  assert.equal(schemas.changePassword.safeParse({ currentPassword: 'a', newPassword: 'b', revokeOtherSessions: 'yes' }).success, false);
  assert.equal(schemas.sessionIdParams.safeParse({ id: '../../etc' }).success, false);
  assert.equal(schemas.aiGenerate.safeParse({ count: 500 }).success, false);
  assert.equal(schemas.searchQuery.parse({ q: `  ${'a'.repeat(300)}` }).q.length, 200);
});

test('middleware: 400 con mensaje claro y cuerpo saneado', () => {
  const bad = run({ body: schemas.playlistAddSong }, { body: { songId: 'x' } });
  assert.equal(bad.next, false);
  assert.equal(bad.res.statusCode, 400);
  assert.equal(bad.res.body.error, 'Identificador no válido');
  assert.equal(bad.res.body.details[0].path, 'songId');

  const arr = run({ body: schemas.playlistCreate }, { body: [1, 2] });
  assert.equal(arr.res.statusCode, 400);

  const empty = run({ body: schemas.playlistCreate }, { body: undefined });
  assert.equal(empty.next, true, 'cuerpo vacío = objeto vacío');

  const ok = run({ params: schemas.playlistSongParams, body: schemas.reorder }, {
    params: { playlistId: '5', songId: '6' }, body: { orderedIds: ['1'], hack: true },
  });
  assert.equal(ok.next, true);
  assert.deepEqual(ok.req.valid.params, { playlistId: 5, songId: 6 });
  assert.deepEqual(ok.req.body, { orderedIds: [1] });
  assert.deepEqual(ok.req.params, { playlistId: '5', songId: '6' }, 'req.params intacto');
});
