'use strict';
// Recomendaciones IA (auditoría R1/R2): recuperación de las 'pending' al
// arrancar y reintento de filas antiguas que nunca se descargaron.
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
    async downloadToStaging({ target }) {
      downloads.push(target);
      if (target.includes('FALLA')) throw new Error('yt-dlp simulado: sin resultados');
      return { commit: async (dir, stem) => { fs.writeFileSync(path.join(dir, `${stem}.opus`), 'audio'); } };
    },
  };
  const recs = createRecommendations({
    db: s.db,
    config: {
      aiMusicDir: s.aiMusicDir, musicDir: s.musicDir, lastfmApiKey: '',
      aiArchiveRetentionDays: 7, aiPendingMaxAgeDays: 3, aiRetryAfterDays: 14,
    },
    fetch: async () => { throw new Error('las pruebas no usan la red'); },
    log: () => {},
    gemini: async (prompt) => { prompts.push(prompt); return JSON.stringify(geminiRecs); },
    ytdlp,
    downloadQueue: createSerialQueue(),
    library: { syncUser: async () => {} },
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
    assert.deepEqual(t.downloads, ['ytsearch1:Reciente - Artista', 'ytsearch1:FALLA - Artista']);
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
    assert.deepEqual(t.downloads, ['ytsearch1:VIEJA - Artista', 'ytsearch1:Atascada - Artista', 'ytsearch1:Nueva - Artista']);

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
