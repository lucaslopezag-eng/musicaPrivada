'use strict';
// ─── CLASIFICACIÓN DE GÉNEROS: MusicBrainz → Gemini ──────────────────────────
// Igual que antes, pero: un único proceso por usuario a la vez, timeouts en
// todas las peticiones y la clave de Gemini en cabecera (no en la URL).

const GENRE_LIST = [
  'Pop', 'Pop Latino', 'Indie Pop', 'Rock', 'Indie Rock', 'Alternative',
  'Hip Hop', 'Rap', 'R&B', 'Reggaeton', 'Electronic', 'Dance', 'Trap',
  'Classical', 'Jazz', 'Metal', 'Punk', 'Country', 'Anime OST',
  'Soundtrack', 'Flamenco', 'Folk', 'K-Pop', 'Latin Urban', 'J-Pop',
];

const TAG_MAP = {
  'pop': 'Pop', 'latin pop': 'Pop Latino', 'spanish pop': 'Pop Latino', 'pop latino': 'Pop Latino',
  'musica latina': 'Pop Latino', 'indie pop': 'Indie Pop', 'indie': 'Indie Pop', 'rock': 'Rock',
  'indie rock': 'Indie Rock', 'alternative rock': 'Alternative', 'alternative': 'Alternative',
  'hip hop': 'Hip Hop', 'hip-hop': 'Hip Hop', 'rap': 'Rap', 'trap': 'Trap', 'r&b': 'R&B', 'rnb': 'R&B',
  'rhythm and blues': 'R&B', 'reggaeton': 'Reggaeton', 'electronic': 'Electronic', 'electronica': 'Electronic',
  'dance': 'Dance', 'dance pop': 'Dance', 'edm': 'Electronic', 'classical': 'Classical', 'jazz': 'Jazz',
  'metal': 'Metal', 'heavy metal': 'Metal', 'punk': 'Punk', 'country': 'Country', 'anime': 'Anime OST',
  'anime ost': 'Anime OST', 'j-pop': 'J-Pop', 'jpop': 'J-Pop', 'k-pop': 'K-Pop', 'kpop': 'K-Pop',
  'soundtrack': 'Soundtrack', 'ost': 'Soundtrack', 'film score': 'Soundtrack', 'flamenco': 'Flamenco',
  'folk': 'Folk', 'urban': 'Latin Urban', 'latin urban': 'Latin Urban', 'urbano': 'Latin Urban',
  'urban latino': 'Latin Urban',
};

function mapTagToGenre(tag) {
  const t = String(tag || '').toLowerCase().trim();
  if (!t) return null;
  if (TAG_MAP[t]) return TAG_MAP[t];
  for (const [key, val] of Object.entries(TAG_MAP)) {
    // La comparación inversa (la etiqueta es parte de una clave) exige 4 letras:
    // "us", "la" o "in" acababan en "Pop Latino" por estar dentro de otra clave.
    if (t.includes(key) || (t.length >= 4 && key.includes(t))) return val;
  }
  return null;
}

async function fetchJson(fetch, url, options = {}, timeoutMs = 15000) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const res = await fetch(url, { ...options, signal: controller.signal });
    const data = await res.json().catch(() => null);
    return { ok: res.ok, status: res.status, data };
  } finally {
    clearTimeout(timer);
  }
}

// Extrae un array JSON de la respuesta de un LLM, rescatando JSON truncado.
function parseJsonArray(text) {
  const clean = String(text || '').replace(/```json\n?/g, '').replace(/```\n?/g, '').trim();
  try {
    const parsed = JSON.parse(clean);
    return Array.isArray(parsed) ? parsed : [];
  } catch {
    const lastBrace = clean.lastIndexOf('}');
    if (lastBrace === -1) return [];
    try {
      const parsed = JSON.parse(clean.substring(0, lastBrace + 1) + ']');
      return Array.isArray(parsed) ? parsed : [];
    } catch {
      return [];
    }
  }
}

// Si el modelo está saturado (429/5xx) se reintenta con espera creciente y, al final, se prueba un modelo de reserva.
const GEMINI_ESPERAS_MS = [2000, 5000, 10000];
const GEMINI_RESERVA = ['gemini-3.5-flash', 'gemini-3.7-flash'];

function createGemini({ config, fetch, log }) {
  const urlDe = (modelo) => `https://generativelanguage.googleapis.com/v1beta/models/${encodeURIComponent(modelo)}:generateContent`;

  async function intentar(modelo, prompt, generationConfig) {
    for (let i = 0; ; i++) {
      const res = await fetchJson(fetch, urlDe(modelo), {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'x-goog-api-key': config.geminiApiKey },
        body: JSON.stringify({ contents: [{ parts: [{ text: prompt }] }], generationConfig }),
      }, 60000);
      const { ok, status, data } = res;
      if (ok && data && !data.error) return { texto: data.candidates?.[0]?.content?.parts?.[0]?.text || null };
      const motivo = data && data.error ? (data.error.message || JSON.stringify(data.error)) : 'respuesta vacía';
      const reintentable = status === 429 || status >= 500;
      if (!reintentable || i >= GEMINI_ESPERAS_MS.length) return { error: `Error ${status}: ${motivo}`, reintentable };
      await new Promise((r) => setTimeout(r, GEMINI_ESPERAS_MS[i]));
    }
  }

  return async function generate(prompt, generationConfig) {
    if (!config.geminiApiKey) {
      log('[Gemini] GEMINI_API_KEY no configurada: se omite la llamada.');
      return null;
    }
    let r = await intentar(config.geminiModel, prompt, generationConfig);
    if (r.error && r.reintentable) {
      const alt = GEMINI_RESERVA.find((m) => m !== config.geminiModel);
      if (alt) {
        log(`[Gemini] ${r.error} Se prueba con el modelo de reserva ${alt}.`);
        r = await intentar(alt, prompt, generationConfig);
      }
    }
    if (r.error) {
      log(`[Gemini] ${r.error}`);
      return null;
    }
    return r.texto;
  };
}

function createGenreClassifier({ db, config, fetch, log, gemini, onUpdated = () => {} }) {
  const running = new Map();
  const recheckDays = config.genreRecheckDays ?? 30;
  const geminiDailyLimit = config.genreGeminiDailyLimit ?? 6;
  // Presupuesto diario de Gemini para géneros (en memoria): deja cuota a las recomendaciones.
  const budget = { day: '', used: 0 };
  function takeGeminiSlot() {
    const today = new Date().toISOString().slice(0, 10);
    if (budget.day !== today) { budget.day = today; budget.used = 0; }
    if (budget.used >= geminiDailyLimit) return false;
    budget.used += 1;
    return true;
  }

  async function getMusicBrainzGenre(title, artist) {
    try {
      const esc = (s) => String(s || '').replace(/"/g, '');
      const query = encodeURIComponent(`recording:"${esc(title)}" AND artist:"${esc(artist)}"`);
      const { ok, data } = await fetchJson(fetch, `https://musicbrainz.org/ws/2/recording/?query=${query}&fmt=json&limit=3`, {
        headers: { 'User-Agent': 'MusicaPrivada/2.0 (aplicación personal)', Accept: 'application/json' },
      });
      if (!ok || !data) return null;
      const tags = (data.recordings || []).slice(0, 3).flatMap(r => r.tags || []);
      tags.sort((a, b) => (b.count || 0) - (a.count || 0));
      for (const tag of tags) {
        const genre = mapTagToGenre(tag.name);
        if (genre) return genre;
      }
      return null;
    } catch {
      return null;
    }
  }

  // Devuelve { results: {id: género}, answered: Set(ids de lotes que Gemini contestó) }.
  async function classifyWithGemini(songs) {
    const results = {};
    const answered = new Set();
    const BATCH = 50;
    for (let i = 0; i < songs.length; i += BATCH) {
      const batch = songs.slice(i, i + BATCH);
      const prompt = `You are a music genre classifier. For each song, assign exactly ONE genre from this list:
${GENRE_LIST.join(', ')}.

Rules:
- Use only genres from the list above.
- Spanish indie/pop artists like Noan, Walls, Morat, Charlie USG → Pop Latino or Indie Pop.
- Kenshi Yonezu, Anime songs → Anime OST or J-Pop.
- Cyclo, Zarcort, Almacor → Rap or Hip Hop.
- Respond ONLY with a valid JSON array. No markdown.

Format: [{"index":0,"genre":"Pop"},{"index":1,"genre":"Rock"},...]

Songs:
${batch.map((s, idx) => `${idx}. "${s.title}" - ${s.artist}`).join('\n')}`;
      if (!takeGeminiSlot()) {
        log(`[Géneros] Tope diario de Gemini para géneros alcanzado (${geminiDailyLimit}); el resto se intentará mañana.`);
        break;
      }
      try {
        const text = await gemini(prompt, { temperature: 0.1, maxOutputTokens: 2048 });
        if (text) batch.forEach(s => answered.add(s.id));
        for (const item of parseJsonArray(text)) {
          const song = batch[item.index];
          if (song && item.genre && GENRE_LIST.includes(item.genre)) results[song.id] = item.genre;
        }
      } catch (err) {
        log(`[Géneros] Lote Gemini ${Math.floor(i / BATCH) + 1} falló: ${err.message}`);
      }
      if (i + BATCH < songs.length) await new Promise(r => setTimeout(r, 800));
    }
    return { results, answered };
  }

  // force (botón "arreglar géneros"): también reintenta las ya intentadas hace poco.
  async function classify(user, { force = false } = {}) {
    const songs = await db.all(
      `SELECT id, title, artist FROM songs
        WHERE username = ? AND (genre IS NULL OR genre = 'Unknown' OR genre = '')
          AND (? = 1 OR genre_checked_at IS NULL OR genre_checked_at < datetime('now', ?))`,
      [user, force ? 1 : 0, `-${recheckDays} days`]
    );
    if (songs.length === 0) return 0;
    log(`[Géneros] Clasificando ${songs.length} canciones de ${user} (MusicBrainz)...`);

    let total = 0;
    const pending = [];
    for (let i = 0; i < songs.length; i++) {
      if (i > 0) await new Promise(r => setTimeout(r, 1050)); // MusicBrainz: 1 req/s
      const song = songs[i];
      const genre = await getMusicBrainzGenre(song.title, song.artist);
      if (genre) {
        await db.run("UPDATE songs SET genre = ?, genre_checked_at = datetime('now') WHERE id = ? AND username = ?", [genre, song.id, user]);
        total += 1;
      } else {
        pending.push(song);
      }
      if ((i + 1) % 25 === 0) log(`[Géneros] Progreso MusicBrainz: ${i + 1}/${songs.length}, ${total} clasificadas.`);
    }

    if (pending.length > 0) {
      log(`[Géneros] Gemini para ${pending.length} canciones no reconocidas...`);
      const { results: geminiResults, answered } = await classifyWithGemini(pending);
      for (const [songId, genre] of Object.entries(geminiResults)) {
        await db.run('UPDATE songs SET genre = ? WHERE id = ? AND username = ?', [genre, Number(songId), user]);
        total += 1;
      }
      // Se apunta el intento de todas (IA-1). Si Gemini contestó, no se repite en
      // recheckDays; si no llegó a contestar (cuota, red), se reintenta al día siguiente.
      for (const song of pending) {
        const offset = answered.has(song.id) ? '+0 days' : `-${Math.max(0, recheckDays - 1)} days`;
        await db.run("UPDATE songs SET genre_checked_at = datetime('now', ?) WHERE id = ? AND username = ?", [offset, song.id, user]);
      }
    }
    log(`[Géneros] Terminado: ${total}/${songs.length} canciones actualizadas para ${user}.`);
    if (total > 0) onUpdated(user);
    return total;
  }

  // Evita ejecuciones solapadas (botón, importación y arranque a la vez).
  function classifyGenres(user, options) {
    if (running.has(user)) return running.get(user);
    const p = classify(user, options)
      .catch(err => { log(`[Géneros] Error: ${err.message}`); return 0; })
      .finally(() => running.delete(user));
    running.set(user, p);
    return p;
  }

  return { classifyGenres, isRunning: (user) => running.has(user) };
}

module.exports = { createGenreClassifier, createGemini, mapTagToGenre, parseJsonArray, fetchJson, GENRE_LIST };
