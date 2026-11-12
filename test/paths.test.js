'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('path');
const fs = require('fs');
const os = require('os');
const { safeJoin, isInside, sanitizeFileStem, isValidUsername, resolveSongFile, resolveAiFile } = require('../src/paths');

const base = path.resolve('/srv/app/music');

test('safeJoin bloquea traversal', () => {
  assert.equal(safeJoin(base, '../../etc/passwd'), null);
  assert.equal(safeJoin(base, 'skiper/../../database.sqlite'), null);
  assert.equal(safeJoin(base, '/etc/passwd'), null);
  assert.equal(safeJoin(base, ''), null);
  assert.equal(safeJoin(base, 'a\0b'), null);
  assert.equal(safeJoin(base, 'skiper/x.jpg'), path.join(base, 'skiper/x.jpg'));
});

test('isInside no acepta directorios hermanos con el mismo prefijo', () => {
  assert.equal(isInside(base, path.resolve('/srv/app/music_backup/x')), false);
  assert.equal(isInside(base, path.join(base, 'x')), true);
});

test('validación de usuario', () => {
  assert.equal(isValidUsername('skiper'), true);
  for (const u of ['../x', 'a/b', '', 'ADMIN', 'x'.repeat(33), null, 'a b']) assert.equal(isValidUsername(u), false, String(u));
});

test('sanitizeFileStem', () => {
  assert.equal(sanitizeFileStem('a/b\\c?d%e*f:g|h"i<j>k'), 'abcdefghijk');
  assert.equal(sanitizeFileStem('..-hidden'), 'hidden');
  assert.equal(sanitizeFileStem('  '), 'pista');
  assert.equal(sanitizeFileStem('x'.repeat(300)).length, 100);
});

test('resolveSongFile / resolveAiFile no escapan de su raíz', async () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'mp-'));
  const music = path.join(tmp, 'music');
  const ai = path.join(tmp, '.ai_music');
  fs.mkdirSync(path.join(music, 'skiper'), { recursive: true });
  fs.mkdirSync(path.join(ai, 'skiper', '.archive'), { recursive: true });
  fs.writeFileSync(path.join(music, 'skiper', 'a.opus'), 'x');
  fs.writeFileSync(path.join(ai, 'skiper', '.archive', 'ai_b.opus'), 'x');
  fs.writeFileSync(path.join(tmp, 'secret.txt'), 'x');
  assert.equal(await resolveSongFile(music, { file_path: 'skiper/a.opus', username: 'skiper' }), path.join(music, 'skiper', 'a.opus'));
  assert.equal(await resolveSongFile(music, { file_path: '../secret.txt', username: 'skiper' }), null);
  assert.equal(await resolveSongFile(music, { file_path: path.join(tmp, 'secret.txt'), username: 'skiper' }), null);
  assert.equal(await resolveSongFile(music, { file_path: null, username: 'skiper' }), null);
  // Ruta absoluta heredada de otra máquina → se resuelve por nombre en la carpeta del usuario.
  assert.equal(await resolveAiFile(ai, { file_path: '/home/otro/.ai_music/ai_b.opus', username: 'skiper' }), path.join(ai, 'skiper', '.archive', 'ai_b.opus'));
  fs.rmSync(tmp, { recursive: true, force: true });
});
