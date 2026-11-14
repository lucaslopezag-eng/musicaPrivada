'use strict';
// Auditoría 2: géneros (IA-1, SRV-8), limitador de login (SEG-3), yt-dlp con
// segundo intento (IA-4), carriles de tareas (SRV-2), versión de biblioteca por
// usuario (SRV-5) y rutas de IA / subtítulos (IA-2, IA-3, SRV-6).
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { driverAvailable, migratedDb, requireWithStubs, fakeBcrypt } = require('./helpers/env');
const { createExpressStub, call } = require('./helpers/router');
const { createGenreClassifier, mapTagToGenre } = require('../src/services/genres');
const { createTaskManager } = require('../src/services/tasks');
const { createLibrary } = require('../src/services/library');
const { createYtDlp, cleanSearchQuery } = require('../src/services/ytdlp');

const skip = !driverAvailable() && 'sin driver SQLite (npm install)';

function load(rel, stubs) {
  const abs = path.resolve(__dirname, '..', rel);
  delete require.cache[require.resolve(abs)];
  return requireWithStubs(abs, stubs);
}

test('SRV-8: una etiqueta corta ya no se clasifica por ser parte de otra clave', () => {
  for (const tag of ['us', 'la', 'in', 'r']) assert.equal(mapTagToGenre(tag), null, tag);
  assert.equal(mapTagToGenre('pop'), 'Pop');
  assert.equal(mapTagToGenre('hard rock'), 'Rock');
  assert.equal(mapTagToGenre('synthpop'), 'Pop');
  assert.equal(mapTagToGenre('latin'), 'Pop Latino', 'la inversa sigue valiendo con 4 letras o más');
  assert.equal(mapTagToGenre('electro'), 'Electronic');
});

test('IA-1: una canción no reconocida no se vuelve a preguntar hasta pasados los días configurados', { skip }, async () => {
  const s = await migratedDb();
  try {
    const { lastID: id } = await s.db.run("INSERT INTO songs (title, artist, file_path, username) VALUES ('Rara', 'Nadie', 'skiper/rara.opus', 'skiper')");
    let musicBrainz = 0;
    let geminiCalls = 0;
    let geminiAnswer = '[]';
    const make = (limit = 6) => createGenreClassifier({
      db: s.db,
      config: { genreRecheckDays: 30, genreGeminiDailyLimit: limit },
      fetch: async () => { musicBrainz += 1; return { ok: true, status: 200, json: async () => ({ recordings: [] }) }; },
      log: () => {},
      gemini: async () => { geminiCalls += 1; return geminiAnswer; },
    });
    const genres = make();

    assert.equal(await genres.classifyGenres('skiper'), 0);
    assert.deepEqual([musicBrainz, geminiCalls], [1, 1]);
    assert.ok((await s.db.get('SELECT genre_checked_at AS t FROM songs WHERE id = ?', [id])).t, 'se apunta el intento');

    // Segundo arranque, otra descarga...: ni MusicBrainz ni Gemini se repiten.
    assert.equal(await genres.classifyGenres('skiper'), 0);
    assert.equal(await make().classifyGenres('skiper'), 0);
    assert.deepEqual([musicBrainz, geminiCalls], [1, 1]);

    // El botón "arreglar géneros" sí lo reintenta, y esta vez Gemini la reconoce.
    geminiAnswer = '[{"index":0,"genre":"Rock"}]';
    assert.equal(await genres.classifyGenres('skiper', { force: true }), 1);
    assert.deepEqual([musicBrainz, geminiCalls], [2, 2]);
    assert.equal((await s.db.get('SELECT genre FROM songs WHERE id = ?', [id])).genre, 'Rock');

    // Pasado el plazo, una canción sin género se vuelve a intentar.
    await s.db.run("UPDATE songs SET genre = 'Unknown', genre_checked_at = datetime('now', '-31 days') WHERE id = ?", [id]);
    assert.equal(await genres.classifyGenres('skiper'), 1);

    // Tope diario de Gemini para géneros: sin hueco no se llama, y se reintenta al día siguiente.
    await s.db.run("UPDATE songs SET genre = 'Unknown', genre_checked_at = NULL WHERE id = ?", [id]);
    const before = geminiCalls;
    assert.equal(await make(0).classifyGenres('skiper'), 0);
    assert.equal(geminiCalls, before, 'con tope 0 no se llama a Gemini');
    const due = await s.db.get("SELECT genre_checked_at < datetime('now', '-28 days') AS soon FROM songs WHERE id = ?", [id]);
    assert.equal(due.soon, 1, 'queda para reintentar al día siguiente, no en 30 días');
  } finally {
    await s.cleanup();
  }
});

test('SEG-3: el intento se reserva antes de comprobar la contraseña', () => {
  const { createLoginLimiter } = requireWithStubs(path.resolve(__dirname, '..', 'src', 'auth'), { bcryptjs: fakeBcrypt });
  const limiter = createLoginLimiter({ maxPerUser: 5, maxPerIp: 20 });
  // 200 peticiones simultáneas: solo 5 llegan a comprobar la contraseña.
  let allowed = 0;
  for (let i = 0; i < 200; i++) if (limiter.attempt('1.2.3.4', 'skiper') === 0) allowed += 1;
  assert.equal(allowed, 5);
  assert.ok(limiter.attempt('1.2.3.4', 'skiper') > 0);
  // Otro usuario desde la misma IP sigue pudiendo, hasta el tope por IP.
  assert.equal(limiter.attempt('1.2.3.4', 'alejandro'), 0);
  // Un login correcto no deja el intento apuntado.
  const ok = createLoginLimiter({ maxPerUser: 5, maxPerIp: 20 });
  for (let i = 0; i < 50; i++) {
    assert.equal(ok.attempt('5.6.7.8', 'skiper'), 0, `login correcto ${i}`);
    ok.succeed('5.6.7.8', 'skiper');
  }
});

test('IA-4: yt-dlp reintenta con otra búsqueda y acepta la salida 101 de --max-downloads', async () => {
  assert.equal(cleanSearchQuery('Song (Remastered 2011) [Official Video] - Artist'), 'Song - Artist');
  assert.equal(cleanSearchQuery('(solo paréntesis)'), '(solo paréntesis)');
  if (process.platform === 'win32') return; // el binario simulado es un script de shell
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'mp-ytdlp-'));
  try {
    // yt-dlp simulado: apunta sus argumentos; "ytsearch1" falla, "ytsearch3" crea el audio y sale con 101.
    const fake = path.join(dir, 'yt-dlp-falso.sh');
    fs.writeFileSync(fake, `#!/bin/sh
echo "$@" >> "${dir}/llamadas.log"
out=""; prev=""
for a in "$@"; do [ "$prev" = "--output" ] && out="$a"; prev="$a"; done
case "$prev" in
  ytsearch1:*) echo "ERROR: Video unavailable" >&2; exit 1 ;;
  ytsearch3:*) printf audio > "$out"; exit 101 ;;
esac
exit 2
`, { mode: 0o755 });
    // En sistemas con /tmp montado como noexec el script simulado no se puede lanzar.
    if (require('child_process').spawnSync(fake, ['--version']).error) return;
    fs.rmSync(path.join(dir, 'llamadas.log'), { force: true });
    const logs = [];
    const ytdlp = createYtDlp({ config: { ytdlpPath: fake }, ffmpegPath: 'ffmpeg', log: m => logs.push(m) });
    const dest = path.join(dir, 'dest');
    fs.mkdirSync(dest);
    const staging = await ytdlp.downloadSearchToStaging({ query: 'Song (Live) - Artist audio', altQuery: 'Song - Artist', destDir: dest, baseName: '0001_Song - Artist', matchFilter: 'duration < 600' });
    const { audioPath } = await staging.commit(dest, '0001_Song - Artist');
    assert.equal(fs.readFileSync(audioPath, 'utf8'), 'audio');
    const calls = fs.readFileSync(path.join(dir, 'llamadas.log'), 'utf8').trim().split('\n');
    assert.equal(calls.length, 2);
    assert.match(calls[0], /player_client=android/);
    assert.doesNotMatch(calls[0], /--max-downloads/);
    assert.match(calls[0], /-- ytsearch1:Song \(Live\) - Artist audio$/);
    assert.doesNotMatch(calls[1], /player_client/);
    assert.match(calls[1], /--max-downloads 1 --match-filter duration < 600 -- ytsearch3:Song - Artist$/);
    assert.equal(logs.filter(l => /Primer intento fallido/.test(l)).length, 1);
    assert.deepEqual(fs.readdirSync(path.join(dest, '.staging')), [], 'el staging queda limpio');
    // Si el segundo intento también falla, el error llega a quien llama.
    fs.writeFileSync(fake, '#!/bin/sh\nexit 1\n', { mode: 0o755 });
    await assert.rejects(ytdlp.downloadSearchToStaging({ query: 'x', destDir: dest, baseName: 'x' }), /código 1/);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('SRV-2: una importación larga no bloquea las descargas sueltas', async () => {
  const tm = createTaskManager({ log: () => {} });
  let releaseImport;
  const order = [];
  tm.registerHandler('import', () => new Promise((resolve) => { releaseImport = () => { order.push('import'); resolve(); }; }));
  tm.registerHandler('download', async () => { order.push('download'); });
  tm.registerHandler('replace', async () => { order.push('replace'); });
  const imp = tm.enqueue('skiper', 'import', {});
  const single = tm.enqueue('skiper', 'download', {});
  const replace = tm.enqueue('skiper', 'replace', {});
  await tm.downloadQueue.push(async () => {});
  assert.deepEqual(order, ['download', 'replace'], 'las sueltas terminan con la importación aún en marcha');
  assert.equal(imp.status, 'running');
  assert.equal(single.status, 'completed');
  assert.equal(replace.status, 'completed');
  releaseImport();
  await tm.idle();
  assert.equal(imp.status, 'completed');
  assert.deepEqual(tm.stats(), { running: 0, pending: 0, queued: 0 });
});

test('SRV-5: la versión de la biblioteca es por usuario', () => {
  const library = createLibrary({ db: {}, config: {}, log: () => {}, users: { list: () => [], has: () => true, defaultPlaylist: () => null } });
  const a0 = library.versionFor('skiper');
  const b0 = library.versionFor('alejandro');
  library.bumpVersion('skiper');
  assert.ok(library.versionFor('skiper') > a0);
  assert.equal(library.versionFor('alejandro'), b0, 'el cambio de otro usuario no le afecta');
  library.bumpVersion();
  assert.ok(library.versionFor('alejandro') > b0, 'un cambio global llega a todos');
  assert.ok(library.versionFor('skiper') >= library.versionFor('alejandro'));
});

test('rutas: espera de generación (IA-3), aceptar devuelve la canción (IA-2) y subtítulos fallidos (SRV-6)', { skip }, async () => {
  const s = await migratedDb();
  try {
    const { express } = createExpressStub();
    let cooldown = 120;
    let generating = false;
    const bumps = [];
    const recs = {
      generationCooldown: () => cooldown,
      isGenerating: () => generating,
      generate: () => true,
      accept: async () => ({ ok: true, song: { id: 7, title: 'T' } }),
    };
    const ai = load('routes/ai', { express })({ recs, library: { bumpVersion: u => bumps.push(u) } });
    let r = await call(ai, 'POST', '/ai-recommendations/generate', { body: {} });
    assert.equal(r.statusCode, 429);
    assert.equal(r.getHeader('Retry-After'), '120');
    generating = true; // con una generación en curso manda el 409 de siempre
    cooldown = 0;
    r = await call(ai, 'POST', '/ai-recommendations/generate', { body: {} });
    assert.equal(r.statusCode, 202);
    r = await call(ai, 'POST', '/ai-recommendations/5/accept');
    assert.deepEqual(r.body.song, { id: 7, title: 'T' });
    assert.deepEqual(bumps, ['skiper'], 'solo recarga la biblioteca de quien acepta');

    // Subtítulos: transcripción local en error → no se anuncia como "en cola".
    const userDir = path.join(s.musicDir, 'skiper');
    fs.mkdirSync(userDir, { recursive: true });
    fs.writeFileSync(path.join(userDir, 'a.opus'), 'x');
    const { lastID: songId } = await s.db.run("INSERT INTO songs (title, artist, file_path, username) VALUES ('A','B','skiper/a.opus','skiper')");
    let status = 'error';
    const enqueued = [];
    const media = load('routes/media', { express })({
      db: s.db, config: { musicDir: s.musicDir, aiMusicDir: s.aiMusicDir }, log: () => {},
      subtitles: { enqueue: f => enqueued.push(f) },
      transcriber: { get: async () => ({ status }) },
    });
    r = await call(media, 'GET', `/subtitles/${songId}`);
    assert.equal(r.statusCode, 404);
    assert.equal(r.body.queued, false);
    assert.equal(enqueued.length, 0);
    status = 'pending';
    r = await call(media, 'GET', `/subtitles/${songId}`);
    assert.equal(r.body.queued, true);
    assert.equal(enqueued.length, 1);
  } finally {
    await s.cleanup();
  }
});
