'use strict';
// ─── LECTOR DE PLAYLISTS/ÁLBUMES DE SPOTIFY SIN NAVEGADOR (FASE 2) ───────────
// Sustituye al scraper de Puppeteer, que lanzaba un Chromium completo
// (500 MB – 1 GB de RAM, OOM killer en servidores pequeños) y dependía de
// selectores `data-testid` frágiles. Ahora todo son peticiones HTTP + JSON:
//
//   1. Web API oficial con credenciales de cliente (SPOTIFY_CLIENT_ID y
//      SPOTIFY_CLIENT_SECRET, gratis en developer.spotify.com): playlists y
//      álbumes completos, paginados (100/50 por página).
//      Nota: desde nov. 2024 Spotify no expone a apps nuevas las playlists
//      editoriales/algorítmicas (las "Made for you", "Top 50"...); las de
//      usuarios y los álbumes funcionan.
//   2. Sin credenciales (o si la API responde 401/403/404): el JSON público del
//      reproductor embebido (open.spotify.com/embed/...), el mismo que usa
//      spotify-url-info. No necesita claves, pero Spotify lo limita a unas 100
//      pistas por playlist.
//
// Devuelve líneas "Título - Artista1, Artista2 | urlPortada", el formato que ya
// entendía el importador.

const API_BASE = 'https://api.spotify.com/v1';
const TOKEN_URL = 'https://accounts.spotify.com/api/token';
const EMBED_BASE = 'https://open.spotify.com/embed';
const REQUEST_TIMEOUT_MS = 15000;
const MAX_RETRIES = 3;
const DEFAULT_MAX_TRACKS = 3000;
const BROWSER_UA = 'Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0 Safari/537.36';

const URL_RE = /^https:\/\/open\.spotify\.com\/(?:intl-[a-z]{2}(?:-[a-z]{2})?\/)?(playlist|album)\/([A-Za-z0-9]{10,40})(?:[/?#].*)?$/;

class SpotifyError extends Error {
  constructor(message, status) {
    super(message);
    this.status = status;
  }
}

function parseSpotifyUrl(text) {
  const m = URL_RE.exec(String(text || '').trim());
  return m ? { type: m[1], id: m[2] } : null;
}

const clean = (s) => String(s || '').replace(/ /g, ' ').replace(/\s+/g, ' ').trim();

// Elige la imagen más cercana a 300 px (las portadas de 640 px pesan sin aportar).
function pickImage(images) {
  if (!Array.isArray(images) || images.length === 0) return '';
  const withUrl = images.filter(i => i && typeof i.url === 'string');
  if (withUrl.length === 0) return '';
  const sorted = [...withUrl].sort((a, b) => Math.abs((a.width || 300) - 300) - Math.abs((b.width || 300) - 300));
  return sorted[0].url;
}

function formatLine({ title, artists, image }) {
  const t = clean(title);
  const a = clean(artists);
  if (!t) return null;
  const base = a ? `${t} - ${a}` : t;
  return image && /^https:\/\//.test(image) ? `${base} | ${image}` : base;
}

// Extrae el JSON de Next.js de la página embebida.
function parseEmbedHtml(html) {
  const m = /<script[^>]+id="__NEXT_DATA__"[^>]*>([\s\S]*?)<\/script>/.exec(String(html || ''));
  if (!m) throw new SpotifyError('La página embebida de Spotify no contiene datos (¿ha cambiado el formato?)');
  let data;
  try { data = JSON.parse(m[1]); } catch { throw new SpotifyError('JSON de la página embebida no válido'); }
  const entity = data?.props?.pageProps?.state?.data?.entity;
  if (!entity || !Array.isArray(entity.trackList)) {
    throw new SpotifyError('La página embebida no incluye la lista de pistas (¿playlist privada o eliminada?)', 404);
  }
  const collectionImage = pickImage(entity.coverArt?.sources || entity.images || []);
  const tracks = entity.trackList
    .filter(t => t && typeof t.title === 'string' && (t.entityType === undefined || t.entityType === 'track'))
    .map(t => ({
      title: t.title,
      artists: t.subtitle,
      image: pickImage(t.coverArt?.sources || t.images || []) || collectionImage,
    }));
  return { name: clean(entity.name || entity.title || ''), tracks };
}

function createSpotifyClient({ clientId = '', clientSecret = '', market = 'ES', fetch: fetchImpl = globalThis.fetch, log = () => {}, maxTracks = DEFAULT_MAX_TRACKS } = {}) {
  if (typeof fetchImpl !== 'function') throw new Error('fetch no disponible (se necesita Node ≥ 18)');
  let token = null;
  let tokenExpiresAt = 0;
  const hasCredentials = Boolean(clientId && clientSecret);

  async function request(url, init = {}, attempt = 0) {
    let res;
    try {
      res = await fetchImpl(url, { ...init, signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS) });
    } catch (err) {
      if (attempt < MAX_RETRIES - 1) return request(url, init, attempt + 1);
      throw new SpotifyError(`No se pudo contactar con Spotify: ${err.message}`);
    }
    // 429/5xx: se respeta Retry-After (máx. 10 s) y se reintenta.
    if ((res.status === 429 || res.status >= 500) && attempt < MAX_RETRIES - 1) {
      const retryAfter = Math.min(10, Number(res.headers.get('retry-after')) || 2 ** attempt);
      await new Promise(r => setTimeout(r, retryAfter * 1000));
      return request(url, init, attempt + 1);
    }
    return res;
  }

  async function getToken() {
    if (token && Date.now() < tokenExpiresAt - 60000) return token;
    const res = await request(TOKEN_URL, {
      method: 'POST',
      headers: {
        Authorization: `Basic ${Buffer.from(`${clientId}:${clientSecret}`).toString('base64')}`,
        'Content-Type': 'application/x-www-form-urlencoded',
      },
      body: 'grant_type=client_credentials',
    });
    if (!res.ok) throw new SpotifyError(`Spotify rechazó las credenciales de cliente (HTTP ${res.status})`, res.status);
    const data = await res.json();
    if (!data || typeof data.access_token !== 'string') throw new SpotifyError('Respuesta de token de Spotify no válida');
    token = data.access_token;
    tokenExpiresAt = Date.now() + (Number(data.expires_in) || 3600) * 1000;
    return token;
  }

  async function apiGet(url) {
    const res = await request(url, { headers: { Authorization: `Bearer ${await getToken()}`, Accept: 'application/json' } });
    if (res.status === 401) { token = null; }
    if (!res.ok) throw new SpotifyError(`La Web API de Spotify respondió HTTP ${res.status}`, res.status);
    return res.json();
  }

  async function fromWebApi({ type, id }) {
    const tracks = [];
    let name = '';
    if (type === 'playlist') {
      const meta = await apiGet(`${API_BASE}/playlists/${id}?fields=name&market=${market}`);
      name = clean(meta && meta.name);
      const fields = 'next,items(track(name,type,is_local,artists(name),album(images)))';
      let next = `${API_BASE}/playlists/${id}/tracks?limit=100&offset=0&market=${market}&fields=${encodeURIComponent(fields)}`;
      while (next && tracks.length < maxTracks) {
        const page = await apiGet(next);
        for (const item of (page && page.items) || []) {
          const t = item && item.track;
          if (!t || (t.type && t.type !== 'track')) continue; // episodios de podcast, pistas eliminadas
          tracks.push({ title: t.name, artists: (t.artists || []).map(a => a && a.name).filter(Boolean).join(', '), image: pickImage(t.album && t.album.images) });
        }
        next = page && typeof page.next === 'string' && page.next.startsWith(API_BASE) ? page.next : null;
      }
    } else {
      const album = await apiGet(`${API_BASE}/albums/${id}?market=${market}`);
      name = clean(album && album.name);
      const image = pickImage(album && album.images);
      let page = album && album.tracks;
      for (;;) {
        for (const t of (page && page.items) || []) {
          if (!t) continue;
          tracks.push({ title: t.name, artists: (t.artists || []).map(a => a && a.name).filter(Boolean).join(', '), image });
        }
        const next = page && typeof page.next === 'string' && page.next.startsWith(API_BASE) ? page.next : null;
        if (!next || tracks.length >= maxTracks) break;
        page = await apiGet(next);
      }
    }
    return { name, tracks, source: 'web-api' };
  }

  async function fromEmbed({ type, id }) {
    const res = await request(`${EMBED_BASE}/${type}/${id}`, {
      headers: { 'User-Agent': BROWSER_UA, Accept: 'text/html', 'Accept-Language': 'es-ES,es;q=0.9,en;q=0.8' },
    });
    if (!res.ok) throw new SpotifyError(`Spotify respondió HTTP ${res.status} a la página embebida`, res.status);
    const html = await res.text();
    return { ...parseEmbedHtml(html), source: 'embed' };
  }

  // Devuelve { name, source, lines: ["Título - Artista | portada", ...] }.
  async function fetchCollection(url) {
    const ref = parseSpotifyUrl(url);
    if (!ref) throw new SpotifyError('Solo se admiten URLs de playlists/álbumes de open.spotify.com', 400);
    let result = null;
    if (hasCredentials) {
      try {
        result = await fromWebApi(ref);
      } catch (err) {
        // 401/403/404 → p. ej. playlist editorial no disponible para apps nuevas.
        log(`[Spotify] Web API no disponible para ${ref.type}/${ref.id} (${err.message}); se usa la página embebida.`);
      }
    }
    if (!result) result = await fromEmbed(ref);
    const seen = new Set();
    const lines = [];
    for (const track of result.tracks) {
      const line = formatLine(track);
      if (!line) continue;
      const key = line.split(' | ')[0].toLowerCase();
      if (seen.has(key)) continue;
      seen.add(key);
      lines.push(line);
      if (lines.length >= maxTracks) break;
    }
    if (lines.length === 0) throw new SpotifyError('No se encontró ninguna canción en esa URL de Spotify', 404);
    if (result.source === 'embed' && ref.type === 'playlist' && lines.length >= 100) {
      log('[Spotify] Aviso: la página embebida limita las playlists a ~100 pistas. Configura SPOTIFY_CLIENT_ID/SECRET para importarlas completas.');
    }
    return { name: result.name, source: result.source, lines };
  }

  return { fetchCollection, hasCredentials };
}

module.exports = { createSpotifyClient, parseSpotifyUrl, parseEmbedHtml, pickImage, formatLine, SpotifyError };
