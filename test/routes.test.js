'use strict';
// Routers reales (songs, playlists, stats, ai, importer, auth) con la
// validación de esquemas y una BD SQLite real; Express sustituido por un stub.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const { driverAvailable, migratedDb, requireWithStubs, fakeBcrypt, fakeHash } = require('./helpers/env');
const { createExpressStub, call } = require('./helpers/router');
const { createUserStore } = require('../src/users');
const { createTaskManager } = require('../src/services/tasks');

const skip = !driverAvailable() && 'sin driver SQLite (npm install)';

// Ruta relativa a la raíz del proyecto ("routes/songs"); siempre recién cargado.
function load(rel, stubs) {
  const abs = path.resolve(__dirname, '..', rel);
  delete require.cache[require.resolve(abs)];
  return requireWithStubs(abs, stubs);
}

async function setup() {
  const t = await migratedDb();
  const users = createUserStore({ db: t.db });
  users.create('skiper', fakeHash('clave-de-skiper'), 'admin');
  users.create('alejandro', fakeHash('clave-de-alejandro'), 'user');
  const { express, routers } = createExpressStub();
  const bumps = [];
  const library = {
    bumpVersion: () => bumps.push(1),
    get version() { return 42; },
    withUserLock: (u, fn) => fn(),
    syncUser: async () => ({ changed: false }),
  };
  const songIds = [];
  for (let i = 1; i <= 3; i++) {
    const userDir = path.join(t.musicDir, 'skiper');
    fs.mkdirSync(userDir, { recursive: true });
    fs.writeFileSync(path.join(userDir, `000${i}_S${i} - A.opus`), 'x');
    const { lastID } = await t.db.run('INSERT INTO songs (title, artist, file_path, username, duration, playlist_order) VALUES (?,?,?,?,?,?)',
      [`S${i}`, 'A', `skiper/000${i}_S${i} - A.opus`, 'skiper', 180000, i]);
    songIds.push(lastID);
  }
  const { lastID: foreignSong } = await t.db.run("INSERT INTO songs (title, artist, file_path, username) VALUES ('X','Y','alejandro/x.opus','alejandro')");
  const { lastID: playlistId } = await t.db.run("INSERT INTO playlists (name, username) VALUES ('Mi Biblioteca', 'skiper')");
  const { lastID: foreignPlaylist } = await t.db.run("INSERT INTO playlists (name, username) VALUES ('Ajena', 'alejandro')");
  const config = { musicDir: t.musicDir, aiMusicDir: t.aiMusicDir, rootDir: t.dir, sessionTtlMs: 3600e3, cookieSecure: false };
  const ctx = {
    db: t.db, config, log: () => {}, logger: { tail: async () => 'log del sistema' }, users, library,
    genres: { isRunning: () => false, classifyGenres: () => {} },
    subtitles: { enqueue: () => {}, cancelByPath: () => {} },
    probeDurationMs: async () => 180000, ffmpegPath: 'ffmpeg', runBackfill: () => {},
  };
  return { ...t, express, routers, ctx, bumps, songIds, foreignSong, playlistId, foreignPlaylist };
}

test('playlists: validación, propiedad (IDOR) y reordenación atómica', { skip }, async () => {
  const s = await setup();
  try {
    const router = load('routes/playlists', { express: s.express })(s.ctx);
    let r = await call(router, 'POST', '/playlists', { body: { name: 'Rock', cover_url: 'javascript:alert(1)', hack: 1 } });
    assert.equal(r.statusCode, 201);
    assert.equal(r.body.name, 'Rock');
    assert.equal(r.body.cover_url, null, 'URL de portada saneada');
    r = await call(router, 'POST', '/playlists', { body: { name: 42 } });
    assert.equal(r.statusCode, 400);

    r = await call(router, 'POST', `/playlists/${s.playlistId}/songs`, { body: { songId: String(s.songIds[0]) } });
    assert.deepEqual(r.body, { success: true });
    r = await call(router, 'POST', `/playlists/${s.playlistId}/songs`, { body: { songId: 'abc' } });
    assert.equal(r.statusCode, 400);
    assert.equal(r.body.error, 'Identificador no válido');
    r = await call(router, 'POST', `/playlists/${s.playlistId}/songs`, { body: { songId: s.foreignSong } });
    assert.equal(r.statusCode, 404, 'canción ajena');
    r = await call(router, 'POST', `/playlists/${s.foreignPlaylist}/songs`, { body: { songId: s.songIds[0] } });
    assert.equal(r.statusCode, 404, 'playlist ajena');
    r = await call(router, 'GET', '/playlists/abc/songs');
    assert.equal(r.statusCode, 400);

    for (const id of s.songIds.slice(1)) await call(router, 'POST', `/playlists/${s.playlistId}/songs`, { body: { songId: id } });
    const reversed = [...s.songIds].reverse();
    r = await call(router, 'POST', `/playlists/${s.playlistId}/reorder`, { body: { orderedIds: reversed } });
    assert.deepEqual(r.body, { success: true });
    r = await call(router, 'GET', `/playlists/${s.playlistId}/songs`);
    assert.deepEqual(r.body.map(x => x.id), reversed);
    assert.ok(r.body.every(x => !('file_path' in x)), 'sin rutas de disco');
    r = await call(router, 'POST', `/playlists/${s.playlistId}/reorder`, { body: { orderedIds: [1, 'x'] } });
    assert.equal(r.statusCode, 400);

    r = await call(router, 'DELETE', `/playlists/${s.playlistId}/songs/${s.songIds[0]}`);
    assert.deepEqual(r.body, { success: true });
    r = await call(router, 'DELETE', `/playlists/${s.foreignPlaylist}`);
    assert.equal(r.statusCode, 404);
    r = await call(router, 'DELETE', `/playlists/${s.playlistId}`);
    assert.deepEqual(r.body, { success: true });
    assert.equal(s.db.getSync('SELECT COUNT(*) AS n FROM playlist_songs WHERE playlist_id = ?', [s.playlistId]).n, 0);
  } finally {
    await s.cleanup();
  }
});

test('canciones: listado, reordenación, borrado y validación del recorte', { skip }, async () => {
  const s = await setup();
  try {
    const router = load('routes/songs', { express: s.express })(s.ctx);
    let r = await call(router, 'GET', '/songs');
    assert.equal(r.body.length, 3);
    r = await call(router, 'POST', '/playlist/reorder', { body: { orderedIds: [s.songIds[2], s.songIds[0], s.songIds[1]] } });
    assert.deepEqual(r.body, { success: true });
    assert.equal(s.db.getSync('SELECT playlist_order FROM songs WHERE id = ?', [s.songIds[2]]).playlist_order, 0);
    r = await call(router, 'POST', '/playlist/reorder', { body: {} });
    assert.equal(r.statusCode, 400);

    r = await call(router, 'POST', `/songs/${s.songIds[0]}/trim`, { body: { startTime: 5, endTime: 5.2 } });
    assert.equal(r.statusCode, 400);
    assert.match(r.body.error, /mínimo 0,5 s/);
    r = await call(router, 'POST', `/songs/${s.foreignSong}/trim`, { body: { startTime: 0, endTime: 10 } });
    assert.equal(r.statusCode, 404);
    r = await call(router, 'POST', `/songs/${s.songIds[0]}/trim`, { body: { startTime: 0, endTime: 10, rev: 7 } });
    assert.equal(r.statusCode, 409, 'revisión distinta');

    r = await call(router, 'DELETE', `/songs/${s.foreignSong}`);
    assert.equal(r.statusCode, 404);
    r = await call(router, 'DELETE', '/songs/0');
    assert.equal(r.statusCode, 400);
    r = await call(router, 'DELETE', `/songs/${s.songIds[1]}`);
    assert.deepEqual(r.body, { message: 'Deleted' });
    assert.equal(s.db.getSync('SELECT COUNT(*) AS n FROM songs WHERE id = ?', [s.songIds[1]]).n, 0);
    assert.equal(fs.existsSync(path.join(s.musicDir, 'skiper', '0002_S2 - A.opus')), false);
    r = await call(router, 'GET', '/songs/version');
    assert.deepEqual(r.body, { version: 42 });
  } finally {
    await s.cleanup();
  }
});

test('estadísticas: escucha propia, IA y canción ajena', { skip }, async () => {
  const s = await setup();
  try {
    const router = load('routes/stats', { express: s.express })(s.ctx);
    let r = await call(router, 'POST', '/stats/listen', { body: { song_id: s.songIds[0], listen_duration_ms: 999999999, completed: true, playlist_id: s.foreignPlaylist } });
    assert.equal(r.statusCode, 200);
    const row = s.db.getSync('SELECT * FROM play_history ORDER BY id DESC LIMIT 1');
    assert.equal(row.listen_duration_ms, 185000, 'limitado a duración + 5 s');
    assert.equal(row.context_playlist_id, null, 'playlist ajena descartada');
    r = await call(router, 'POST', '/stats/listen', { body: { song_id: s.foreignSong, listen_duration_ms: 5000 } });
    assert.equal(r.statusCode, 404);
    r = await call(router, 'POST', '/stats/listen', { body: { song_id: 'ai-999' } });
    assert.equal(r.statusCode, 404);
    r = await call(router, 'POST', '/stats/listen', { body: { listen_duration_ms: 5 } });
    assert.equal(r.statusCode, 400);
    const { lastID: recId } = await s.db.run("INSERT INTO ai_recommendations (title, artist, username, status) VALUES ('T','A','skiper','downloaded')");
    r = await call(router, 'POST', '/stats/listen', { body: { song_id: `ai-${recId}`, listen_duration_ms: 4000, completed: false } });
    assert.equal(r.statusCode, 200);
    assert.equal(s.db.getSync('SELECT is_ai, ai_rec_id FROM play_history ORDER BY id DESC LIMIT 1').ai_rec_id, recId);
  } finally {
    await s.cleanup();
  }
});

test('IA: ids validados y conflicto de generación', { skip }, async () => {
  const s = await setup();
  try {
    let generating = false;
    s.ctx.recs = {
      listDownloaded: async () => [], isGenerating: () => generating, statusCounts: async () => ({}),
      generate: (u, count) => { if (generating) return false; generating = count || true; return true; },
      accept: async (u, id) => (id === 5 ? { ok: true } : null),
      archive: async (u, id, kind) => (id === 5 ? { kind } : null),
    };
    const router = load('routes/ai', { express: s.express })(s.ctx);
    let r = await call(router, 'POST', '/ai-recommendations/generate', { body: { count: '10' } });
    assert.equal(r.statusCode, 202);
    assert.equal(generating, 10);
    r = await call(router, 'POST', '/ai-recommendations/generate', { body: {} });
    assert.equal(r.statusCode, 409);
    r = await call(router, 'POST', '/ai-recommendations/generate', { body: { count: 999 } });
    assert.equal(r.statusCode, 400);
    r = await call(router, 'POST', '/ai-recommendations/abc/skip');
    assert.equal(r.statusCode, 400);
    r = await call(router, 'POST', '/ai-recommendations/5/played');
    assert.deepEqual(r.body, { message: 'Played.' });
    r = await call(router, 'POST', '/ai-recommendations/6/reject');
    assert.equal(r.statusCode, 404);
  } finally {
    await s.cleanup();
  }
});

test('importador: tareas persistentes, validación y URLs', { skip }, async () => {
  const s = await setup();
  try {
    const tasks = createTaskManager({ log: () => {}, db: s.db });
    const fetched = [];
    s.ctx.tasks = tasks;
    s.ctx.spotify = { fetchCollection: async (url) => { fetched.push(url); return { name: 'L', source: 'embed', lines: ['S1 - A', 'Nueva - B'] }; } };
    const downloads = [];
    const staged = (target) => {
      downloads.push(target);
      return {
        commit: async (dir, stem) => { const p = path.join(dir, `${stem}.opus`); fs.writeFileSync(p, 'x'); return { audioPath: p }; },
        discard: async () => {},
      };
    };
    s.ctx.ytdlp = {
      downloadToStaging: async ({ target }) => staged(target),
      // Las importaciones buscan con segundo intento (IA-4); aquí basta el primero.
      downloadSearchToStaging: async ({ query }) => staged(`ytsearch1:${query}`),
    };
    const router = load('routes/importer', { express: s.express, 'yt-search': async () => ({ videos: [] }), 'node-fetch': () => {} })(s.ctx);

    let r = await call(router, 'POST', '/import', { body: { tracksText: '   ' } });
    assert.equal(r.statusCode, 400);
    r = await call(router, 'POST', '/import', { body: { tracksText: 'a - b', playlistId: s.foreignPlaylist } });
    assert.equal(r.statusCode, 404, 'playlist ajena');
    r = await call(router, 'POST', '/import', { body: { tracksText: 'x'.repeat(2 * 1024 * 1024 + 1) } });
    assert.equal(r.statusCode, 413);

    r = await call(router, 'POST', '/import', { body: { tracksText: 'https://open.spotify.com/playlist/37i9dQZF1DXcBWIGoYBM5M', playlistId: String(s.playlistId) } });
    assert.equal(r.statusCode, 202);
    const { taskId } = r.body;
    assert.match(taskId, /^[a-f0-9]{16}$/);
    assert.equal(s.db.getSync('SELECT type FROM jobs WHERE id = ?', [taskId]).type, 'import');
    await tasks.idle();
    tasks.flush();
    const job = s.db.getSync('SELECT * FROM jobs WHERE id = ?', [taskId]);
    assert.equal(job.status, 'completed', job.error_message || '');
    assert.deepEqual(fetched, ['https://open.spotify.com/playlist/37i9dQZF1DXcBWIGoYBM5M']);
    assert.deepEqual(downloads, ['ytsearch1:Nueva - B audio'], 'S1 - A ya estaba: se omite');
    assert.deepEqual(JSON.parse(job.result), { meta: { playlistId: s.playlistId }, total: 2, done: 1, skipped: 1, failed: 0 });
    const linked = s.db.getSync("SELECT COUNT(*) AS n FROM playlist_songs ps JOIN songs ON songs.id = ps.song_id WHERE ps.playlist_id = ? AND songs.title = 'Nueva'", [s.playlistId]);
    assert.equal(linked.n, 1, 'asignada a la playlist');

    r = await call(router, 'GET', `/tasks/${taskId}`);
    assert.equal(r.body.status, 'completed');
    assert.ok(Array.isArray(r.body.logs));
    r = await call(router, 'GET', `/tasks/${taskId}`, { user: 'alejandro' });
    assert.equal(r.statusCode, 404);
    r = await call(router, 'GET', '/tasks/NOT-A-TASK');
    assert.equal(r.statusCode, 400);

    r = await call(router, 'POST', '/download-single', { body: { url: 'https://evil.example/x', title: 'T' } });
    assert.equal(r.statusCode, 400);
    r = await call(router, 'POST', '/download-single', { body: { url: 'https://www.youtube.com/watch?v=abc', title: '' } });
    assert.equal(r.statusCode, 400);
    r = await call(router, 'POST', '/download-single', { body: { url: 'https://www.youtube.com/watch?v=abc', title: 'T', artist: 'A', replaceId: s.foreignSong } });
    assert.equal(r.statusCode, 404, 'sustituir canción ajena');
    r = await call(router, 'POST', '/download-single', { body: { id: 'yt', url: 'https://www.youtube.com/watch?v=abc', title: 'Tema', artist: 'Grupo', coverUrl: null, durationMs: 1 } });
    assert.equal(r.statusCode, 202);
    const dl = s.db.getSync('SELECT type, payload FROM jobs WHERE id = ?', [r.body.taskId]);
    assert.equal(dl.type, 'download');
    assert.equal(JSON.parse(dl.payload).safeName, 'Tema - Grupo');

    r = await call(router, 'GET', '/search', { query: {} });
    assert.equal(r.statusCode, 400);
    r = await call(router, 'GET', '/logs', { isAdmin: true });
    assert.equal(r.body.scope, 'system');
    r = await call(router, 'GET', '/logs');
    assert.equal(r.body.scope, 'user');
  } finally {
    await s.cleanup();
  }
});

test('auth: rutas de la Fase 2 registradas con validación', { skip }, async () => {
  const s = await setup();
  try {
    const { createAuth } = load('src/auth', { bcryptjs: fakeBcrypt });
    const auth = createAuth({ db: s.db, config: s.ctx.config, log: () => {}, users: s.ctx.users });
    const { publicAuthRouter, privateAuthRouter } = load('routes/auth', { express: s.express });
    const pub = publicAuthRouter({ auth });
    const priv = privateAuthRouter({ auth });
    let r = await call(pub, 'POST', '/login', { body: { username: 'skiper' } });
    assert.equal(r.statusCode, 400);
    assert.equal(r.body.error, 'Falta la contraseña');
    r = await call(pub, 'POST', '/auth/login', { body: { username: 'skiper', password: 'clave-de-skiper' } });
    assert.equal(r.statusCode, 200);
    r = await call(priv, 'POST', '/auth/change-password', { body: { newPassword: 'x' } });
    assert.equal(r.statusCode, 400);
    r = await call(priv, 'DELETE', '/auth/sessions/..%2F..');
    assert.equal(r.statusCode, 400);
    auth.close();
  } finally {
    await s.cleanup();
  }
});
