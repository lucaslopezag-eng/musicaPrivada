'use strict';
// Recomendaciones IA (auditoría R1/R2): recuperación de las 'pending' al
// arrancar y reintento de filas antiguas que nunca se descargaron.
// Auditoría 2 (IA-2/IA-3): el estado de una recomendación no retrocede, aceptar
// es idempotente y enlaza la canción creada, y espera tras una generación vacía.
// Sin red: Last.fm desactivado (sin clave), Gemini y yt-dlp simulados.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const { driverAvailable, migratedDb } = require('./helpers/env');
const { createRecommendations } = require('../src/services/recommendations');
const { createSerialQueue } = require('../src/services/tasks');

const skip = !driverAvailable() && 'sin driver SQLite (npm install)';

async function setup({ geminiRecs = [] } = {}) {
  const s = await migratedDb();
  const downloads = [];
  const prompts = [];
  const ytdlp = {
    async downloadSearchToStaging({ query }) {
      downloads.push(query);
      if (query.includes('FALLA')) throw new Error('yt-dlp simulado: sin resultados');
      return { commit: async (dir, stem) => { fs.writeFileSync(path.join(dir, `${stem}.opus`), 'audio'); } };
    },
  };
  // Biblioteca mínima: registra en `songs` los audios que haya en music/<usuario>/.
  const library = {
    async syncUser(user) {
      const dir = path.join(s.musicDir, user);
      for (const file of fs.existsSync(dir) ? fs.readdirSync(dir) : []) {
        if (!file.endsWith('.opus')) continue;
        await s.db.run("INSERT INTO songs (title, artist, file_path, username) VALUES (?, 'Artista', ?, ?) ON CONFLICT(file_path) DO NOTHING",
          [file, `${user}/${file}`, user]);
      }
    },
  };
  const recs = createRecommendations({
    db: s.db,
    config: {
      aiMusicDir: s.aiMusicDir, musicDir: s.musicDir, lastfmApiKey: '',
      aiArchiveRetentionDays: 7, aiPendingMaxAgeDays: 3, aiRetryAfterDays: 14, aiEmptyCooldownMinutes: 60,
    },
    fetch: async () => { throw new Error('las pruebas no usan la red'); },
    log: () => {},
    gemini: async (prompt) => { prompts.push(prompt); return JSON.stringify(geminiRecs); },
    ytdlp,
    downloadQueue: createSerialQueue(),
    library,
    users: { list: () => ['skiper'] },
  });
  const insert = async (title, status, age, user = 'skiper') => {
    const { lastID } = await s.db.run(
      "INSERT INTO ai_recommendations (title, artist, query, status, username, created_at) VALUES (?, 'Artista', ?, ?, ?, datetime('now', ?))",
      [title, `${title} - Artista`, status, user, age]
    );
    return lastID;
  };
  const row = (id) => s.db.get('SELECT * FROM ai_recommendations WHERE id = ?', [id]);
  const count = async (where = '1=1') => (await s.db.get(`SELECT COUNT(*) AS n FROM ai_recommendations WHERE ${where}`)).n;
  return { ...s, recs, downloads, prompts, insert, row, count };
}

async function waitFor(check, what) {
  const deadline = Date.now() + 5000;
  while (Date.now() < deadline) {
    if (await check()) return;
    await new Promise(r => setTimeout(r, 10));
  }
  throw new Error(`tiempo agotado esperando: ${what}`);
}

test("R1: al arrancar, las 'pending' antiguas caducan y las recientes se reanudan", { skip }, async () => {
  const t = await setup();
  try {
    const old = await t.insert('Antigua', 'pending', '-10 days');
    const recent = await t.insert('Reciente', 'pending', '-1 hours');
    const failing = await t.insert('FALLA', 'pending', '-1 hours');
    const orphan = await t.insert('Huerfana', 'pending', '-1 hours', 'fantasma');
    const done = await t.insert('Lista', 'downloaded', '-10 days');
    const total = await t.count();

    assert.deepEqual(await t.recs.recoverPending(), { expired: 2, resumed: 2 });
    await waitFor(async () => (await t.count("status = 'pending'")) === 0, 'fin de las descargas reanudadas');

    assert.equal((await t.row(old)).status, 'failed', 'antigua: caduca sin descargarse');
    assert.equal((await t.row(orphan)).status, 'failed', 'usuario inexistente: no se descarga');
    assert.equal((await t.row(failing)).status, 'failed', 'descarga fallida');
    assert.equal((await t.row(done)).status, 'downloaded', 'las ya descargadas no se tocan');
    const resumed = await t.row(recent);
    assert.equal(resumed.status, 'downloaded');
    assert.equal(resumed.file_path, 'skiper/ai_Reciente - Artista.opus');
    assert.equal(fs.existsSync(path.join(t.aiMusicDir, resumed.file_path)), true);
    assert.deepEqual(t.downloads, ['Reciente - Artista', 'FALLA - Artista']);
    assert.equal(await t.count(), total, 'no se borra ninguna fila');

    // Segunda pasada: no queda nada que recuperar.
    assert.deepEqual(await t.recs.recoverPending(), { expired: 0, resumed: 0 });
  } finally {
    await t.cleanup();
  }
});

test("R2: las 'pending'/'failed' antiguas se pueden volver a recomendar y se reintentan", { skip }, async () => {
  const t = await setup({
    geminiRecs: [
      { title: 'VIEJA', artist: 'Artista' },      // failed hace 60 días → se reintenta (sin distinguir mayúsculas)
      { title: 'Atascada', artist: 'Artista' },   // pending hace 60 días → se reintenta
      { title: 'Reciente', artist: 'Artista' },   // failed ayer → sigue descartada
      { title: 'Bajada', artist: 'Artista' },     // downloaded → sigue descartada
      { title: 'Nueva', artist: 'Artista' },      // nunca recomendada → fila nueva
    ],
  });
  try {
    const oldFailed = await t.insert('Vieja', 'failed', '-60 days');
    const oldPending = await t.insert('Atascada', 'pending', '-60 days');
    const recentFailed = await t.insert('Reciente', 'failed', '-1 days');
    const downloaded = await t.insert('Bajada', 'downloaded', '-60 days');

    assert.equal(t.recs.generate('skiper', 5), true);
    assert.equal(t.recs.generate('skiper', 5), false, 'cerrojo por usuario');
    await waitFor(() => !t.recs.isGenerating('skiper'), 'fin de la generación');

    for (const id of [oldFailed, oldPending]) {
      const r = await t.row(id);
      assert.equal(r.status, 'downloaded', 'se reintenta sobre la misma fila');
      assert.equal(r.source, 'gemini');
      assert.equal(await t.count(`id = ${id} AND created_at > datetime('now', '-1 hours')`), 1, 'la fecha se renueva');
    }
    assert.equal((await t.row(recentFailed)).status, 'failed');
    assert.equal((await t.row(downloaded)).status, 'downloaded');
    assert.equal(await t.count("title = 'Nueva' AND status = 'downloaded'"), 1);
    assert.equal(await t.count(), 5, 'sin filas duplicadas');
    assert.deepEqual(t.downloads, ['VIEJA - Artista', 'Atascada - Artista', 'Nueva - Artista']);

    // A Gemini se le pide no repetir solo lo que de verdad cuenta como recomendado.
    assert.equal(t.prompts.length, 1);
    const avoid = t.prompts[0].split('Previously recommended songs')[1];
    assert.match(avoid, /Reciente - Artista/);
    assert.match(avoid, /Bajada - Artista/);
    assert.doesNotMatch(avoid, /Vieja - Artista/);
    assert.doesNotMatch(avoid, /Atascada - Artista/);
  } finally {
    await t.cleanup();
  }
});

test('IA-2: aceptar enlaza la canción creada, es idempotente y el estado no retrocede', { skip }, async () => {
  const t = await setup();
  try {
    const id = await t.insert('Buena', 'pending', '-1 hours');
    await t.recs.recoverPending();
    await waitFor(async () => (await t.count("status = 'downloaded'")) === 1, 'descarga');

    const first = await t.recs.accept('skiper', id);
    assert.equal(first.ok, true);
    assert.equal(first.song.file_path, undefined, 'nunca se envían rutas de disco');
    const song = await t.db.get("SELECT id, file_path, discovered_via FROM songs WHERE username = 'skiper'");
    assert.equal(first.song.id, song.id);
    assert.match(song.file_path, /^skiper\/9999_Buena - Artista\.opus$/);
    assert.equal(fs.existsSync(path.join(t.musicDir, song.file_path)), true, 'el audio está en la biblioteca');
    let row = await t.row(id);
    assert.equal(row.status, 'accepted');
    assert.equal(row.song_id, song.id, 'la recomendación queda enlazada a su canción');

    // Volver a aceptarla (botón tras "anterior" o historial) no es un error.
    const again = await t.recs.accept('skiper', id);
    assert.equal(again.ok, true);
    assert.equal(again.already, true);
    assert.equal(again.song.id, song.id);

    // Salir de ella con "siguiente", que termine o rechazarla no cambia su estado.
    for (const status of ['skipped', 'played', 'rejected']) {
      assert.deepEqual(await t.recs.archive('skiper', id, status), { ok: true, unchanged: true });
      assert.equal((await t.row(id)).status, 'accepted');
    }

    // Una rechazada no pasa a saltada/escuchada; una saltada sí puede rechazarse.
    const rejected = await t.insert('Mala', 'rejected', '-1 days');
    await t.recs.archive('skiper', rejected, 'skipped');
    assert.equal((await t.row(rejected)).status, 'rejected');
    const skipped = await t.insert('Regular', 'skipped', '-1 days');
    await t.recs.archive('skiper', skipped, 'rejected');
    assert.equal((await t.row(skipped)).status, 'rejected');

    assert.equal(await t.recs.accept('skiper', 99999), null, 'inexistente');
    assert.equal(await t.recs.accept('alejandro', id), null, 'de otro usuario');
  } finally {
    await t.cleanup();
  }
});

test('IA-3: tras una generación sin nada nuevo hay espera; con resultados, no', { skip }, async () => {
  const empty = await setup({ geminiRecs: [] });
  try {
    assert.equal(empty.recs.generationCooldown('skiper'), 0, 'sin generaciones previas no hay espera');
    assert.equal(empty.recs.generate('skiper', 5), true);
    await waitFor(() => !empty.recs.isGenerating('skiper'), 'fin de la generación vacía');
    const wait = empty.recs.generationCooldown('skiper');
    assert.ok(wait > 3500 && wait <= 3600, `espera de ~1 h (${wait} s)`);
    assert.equal(empty.recs.generationCooldown('alejandro'), 0, 'la espera es por usuario');
  } finally {
    await empty.cleanup();
  }
  const full = await setup({ geminiRecs: [{ title: 'Nueva', artist: 'Artista' }] });
  try {
    full.recs.generate('skiper', 5);
    await waitFor(() => !full.recs.isGenerating('skiper'), 'fin de la generación con resultados');
    assert.equal(full.recs.generationCooldown('skiper'), 0);
  } finally {
    await full.cleanup();
  }
});
