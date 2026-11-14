// ─── MusicaPrivada · Service Worker ──────────────────────────────────────────
// Cambios (PWA-01 / PWA-02 / PWA-03):
// · Las peticiones que no son GET NUNCA se interceptan: sin 503 sintéticos ni
//   timeouts de 4 s en recortes, importaciones, etc.
// · Cachés separadas por usuario: la API se cachea según la cabecera
//   X-MP-User que envía el cliente; audio y portadas según el usuario activo
//   que la app comunica con SET_USER. Al cerrar sesión se purgan.
// · Respuestas 206 Partial Content sintetizadas desde la caché: Safari/iOS
//   reproduce offline y Chromium permite buscar (seek).
// · La precarga offline ya no corre aquí dentro de waitUntil (el navegador
//   mataba el SW): la hace la propia app por lotes (src/pwa.js).
const SW_VERSION = 'v26';
const SHELL_CACHE = `mp-shell-${SW_VERSION}`;
const META_CACHE = 'mp-meta';
const SONGS_PREFIX = 'mp-songs-u:';
const API_PREFIX = `mp-api-${SW_VERSION}-u:`;
const USER_RE = /^[a-z0-9_-]{1,32}$/;
const USER_KEY = '/__mp/user';

const SHELL_ASSETS = ['/', '/index.html', '/manifest.json', '/install-prompt.js'];
// Endpoints que nunca deben servirse desde caché.
const NO_CACHE_API = ['/api/login', '/api/logout', '/api/session', '/api/auth/', '/api/logs', '/api/tasks', '/api/subtitles/worker', '/api/songs/version', '/api/themes/', '/api/background', '/api/ai-recommendations'];

let currentUser = null;
let userLoaded = false;

async function getUser() {
  if (userLoaded) return currentUser;
  try {
    const meta = await caches.open(META_CACHE);
    const res = await meta.match(USER_KEY);
    const value = res ? (await res.text()).trim() : '';
    currentUser = USER_RE.test(value) ? value : null;
  } catch {
    currentUser = null;
  }
  userLoaded = true;
  return currentUser;
}

async function setUser(user) {
  currentUser = USER_RE.test(user || '') ? user : null;
  userLoaded = true;
  const meta = await caches.open(META_CACHE);
  if (currentUser) await meta.put(USER_KEY, new Response(currentUser));
  else await meta.delete(USER_KEY);
}

// Clave de caché: ruta + query sin los parámetros de control del cliente.
function cacheKeyFor(input) {
  const u = new URL(typeof input === 'string' ? input : input.url, self.location.origin);
  u.searchParams.delete('bypass_sw');
  u.searchParams.delete('precache');
  return u.pathname + u.search;
}

// ─── INSTALL / ACTIVATE ──────────────────────────────────────────────────────
self.addEventListener('install', (event) => {
  self.skipWaiting();
  event.waitUntil(
    caches.open(SHELL_CACHE)
      .then(cache => cache.addAll(SHELL_ASSETS))
      .catch(err => console.warn('[SW] Error cacheando el shell (no fatal):', err))
  );
});

self.addEventListener('activate', (event) => {
  event.waitUntil((async () => {
    const keys = await caches.keys();
    await Promise.all(keys.map((k) => {
      const keep = k === SHELL_CACHE || k === META_CACHE || k.startsWith(SONGS_PREFIX) || k.startsWith(API_PREFIX);
      return keep ? null : caches.delete(k);
    }));
    await self.clients.claim();
  })());
});

// ─── FETCH ───────────────────────────────────────────────────────────────────
self.addEventListener('fetch', (event) => {
  const request = event.request;
  const url = new URL(request.url);
  if (url.origin !== self.location.origin) return;
  if (request.method !== 'GET') return; // PWA-01: mutaciones directas a la red

  if (url.pathname.startsWith('/api/')) {
    if (url.pathname.startsWith('/api/stream/')) {
      // URL construida con URLSearchParams en el cliente (PWA-02): bypass_sw
      // ahora se detecta siempre y el stream va directo a la red.
      if (url.searchParams.has('bypass_sw')) return;
      event.respondWith(cacheFirstSong(request));
      return;
    }
    if (url.pathname.startsWith('/api/cover/')) {
      event.respondWith(cacheFirstCover(request));
      return;
    }
    if (NO_CACHE_API.some(p => url.pathname.startsWith(p))) return;
    event.respondWith(networkFirstApi(request));
    return;
  }

  event.respondWith(networkFirstShell(request));
});

// ─── AUDIO: cache-first con soporte de Range ─────────────────────────────────
function parseRange(header, size) {
  const m = /^bytes=(\d*)-(\d*)$/.exec(String(header || '').trim());
  if (!m || (m[1] === '' && m[2] === '')) return null;
  let start;
  let end;
  if (m[1] === '') {
    const suffix = Number(m[2]);
    if (!suffix) return null;
    start = Math.max(0, size - suffix);
    end = size - 1;
  } else {
    start = Number(m[1]);
    end = m[2] === '' ? size - 1 : Math.min(Number(m[2]), size - 1);
  }
  if (!Number.isFinite(start) || !Number.isFinite(end) || start >= size || start > end) return null;
  return { start, end };
}

async function respondFromCache(request, cached) {
  const rangeHeader = request.headers.get('range');
  const blob = await cached.blob();
  const type = cached.headers.get('Content-Type') || blob.type || 'audio/ogg';
  if (!rangeHeader) {
    return new Response(blob, {
      status: 200,
      headers: { 'Content-Type': type, 'Content-Length': String(blob.size), 'Accept-Ranges': 'bytes' },
    });
  }
  const range = parseRange(rangeHeader, blob.size);
  if (!range) {
    return new Response(null, { status: 416, headers: { 'Content-Range': `bytes */${blob.size}` } });
  }
  const body = blob.slice(range.start, range.end + 1, type);
  return new Response(body, {
    status: 206,
    statusText: 'Partial Content',
    headers: {
      'Content-Type': type,
      'Content-Length': String(range.end - range.start + 1),
      'Content-Range': `bytes ${range.start}-${range.end}/${blob.size}`,
      'Accept-Ranges': 'bytes',
    },
  });
}

async function cacheFirstSong(request) {
  const user = await getUser();
  if (user) {
    try {
      const cache = await caches.open(SONGS_PREFIX + user);
      const cached = await cache.match(cacheKeyFor(request));
      if (cached) return await respondFromCache(request, cached);
    } catch (err) {
      console.warn('[SW] Error leyendo audio de caché:', err);
    }
  }
  try {
    // Sin cachear al vuelo: las respuestas 206 parciales no se pueden guardar y
    // acaparaban conexiones. La caché offline la llena src/pwa.js.
    return await fetch(request);
  } catch {
    return new Response('Audio no disponible sin conexión', { status: 503 });
  }
}

// ─── PORTADAS: cache-first en la caché del usuario ───────────────────────────
async function cacheFirstCover(request) {
  const user = await getUser();
  const key = cacheKeyFor(request);
  const cache = user ? await caches.open(SONGS_PREFIX + user) : null;
  if (cache) {
    const cached = await cache.match(key);
    if (cached) return cached;
  }
  try {
    const response = await fetch(request);
    if (cache && response.ok) cache.put(key, response.clone()).catch(() => {});
    return response;
  } catch {
    return new Response('', { status: 503 });
  }
}

// ─── API GET: network-first, caché por usuario ───────────────────────────────
async function networkFirstApi(request) {
  const headerUser = request.headers.get('X-MP-User');
  const user = USER_RE.test(headerUser || '') ? headerUser : null;
  const key = cacheKeyFor(request);
  try {
    const response = await fetch(request);
    if (user && response.ok) {
      const cache = await caches.open(API_PREFIX + user);
      cache.put(key, response.clone()).catch(() => {});
    }
    return response;
  } catch {
    if (user) {
      const cache = await caches.open(API_PREFIX + user);
      const cached = await cache.match(key);
      if (cached) return cached;
    }
    return new Response(JSON.stringify({ error: 'Offline', offline: true }), {
      status: 503,
      headers: { 'Content-Type': 'application/json' },
    });
  }
}

// ─── SHELL: network-first; tras 3 s usa la caché si existe, si no espera ─────
// FE-7: cada compilación deja un index-<hash>.js/.css nuevo y los anteriores
// se quedaban en la caché hasta el siguiente cambio de SW_VERSION. Tras guardar
// un index.html nuevo se borran los "index-*" que ya no referencia. Solo esos:
// el resto de /assets/ (fuentes, imágenes) no se toca.
async function pruneOldBundles(cache, indexResponse) {
  const html = await indexResponse.text();
  const wanted = new Set(html.match(/\/assets\/index-[A-Za-z0-9_-]+\.(?:js|css)/g) || []);
  if (wanted.size === 0) return; // no parece el index de la app: no se borra nada
  for (const req of await cache.keys()) {
    const { pathname } = new URL(req.url);
    if (/^\/assets\/index-[A-Za-z0-9_-]+\.(?:js|css)$/.test(pathname) && !wanted.has(pathname)) await cache.delete(req);
  }
}

async function networkFirstShell(request) {
  const cache = await caches.open(SHELL_CACHE);
  const network = fetch(request).then((response) => {
    if (response.ok) {
      const saved = cache.put(request, response.clone()).catch(() => {});
      if (request.mode === 'navigate') {
        const copy = response.clone();
        saved.then(() => pruneOldBundles(cache, copy)).catch(() => {});
      }
    }
    return response;
  });
  const first = await Promise.race([
    network.catch(() => null),
    new Promise(resolve => setTimeout(resolve, 3000, null)),
  ]);
  if (first) return first;
  const cached = (await cache.match(request)) || (request.mode === 'navigate' ? await cache.match('/index.html') : null);
  if (cached) return cached;
  try {
    return await network;
  } catch {
    return new Response('App offline', { status: 503 });
  }
}

// ─── MENSAJES DESDE LA APP ───────────────────────────────────────────────────
self.addEventListener('message', (event) => {
  const data = event.data || {};
  if (data.type === 'SET_USER') {
    event.waitUntil(setUser(data.user).then(() => {
      if (event.source) event.source.postMessage({ type: 'USER_SET', user: currentUser });
    }));
  }
  if (data.type === 'CLEAR_USER_CACHES') {
    const user = USER_RE.test(data.user || '') ? data.user : null;
    event.waitUntil((async () => {
      if (user) {
        await caches.delete(API_PREFIX + user);
        if (data.includeSongs) await caches.delete(SONGS_PREFIX + user);
      }
      await setUser(null);
      if (event.source) event.source.postMessage({ type: 'CACHE_CLEARED' });
    })());
  }
  if (data.type === 'GET_VERSION' && event.source) {
    event.source.postMessage({ type: 'SW_VERSION', version: SW_VERSION });
  }
});
