// ─── PWA: registro del Service Worker y gestión de la caché offline ─────────
// PWA-01 / PWA-03:
// · Cachés por usuario (mp-songs-u:<usuario>), coherentes con public/sw.js.
// · La precarga de canciones se hace desde la app, en segundo plano y por
//   lotes; ya no depende de navigator.serviceWorker.controller (fallaba en la
//   primera visita) ni de un waitUntil eterno que el navegador cortaba.
// · Ante QuotaExceededError se aborta el lote completo y se informa.

let swRegistration = null;
let installPromptEvent = null;
let activeUser = null;
let cachedSongKeys = new Set();

const USER_RE = /^[a-z0-9_-]{1,32}$/;
const SONGS_PREFIX = 'mp-songs-u:';
const messageListeners = new Set();

export function addSWMessageListener(fn) {
  messageListeners.add(fn);
  return () => messageListeners.delete(fn);
}

export const songsCacheName = (user) => `${SONGS_PREFIX}${user}`;
const cachesAvailable = () => typeof window !== 'undefined' && 'caches' in window;

// Misma normalización que el SW: ruta + query sin parámetros de control.
export function cacheKeyFor(url) {
  const u = new URL(url, window.location.origin);
  u.searchParams.delete('bypass_sw');
  u.searchParams.delete('precache');
  return u.pathname + u.search;
}

// Añade parámetros con URLSearchParams (PWA-02: antes se concatenaba "?" y se
// generaban URLs con dos "?").
export function withParams(url, params) {
  const u = new URL(url, window.location.origin);
  for (const [k, v] of Object.entries(params)) u.searchParams.set(k, v);
  return u.pathname + u.search;
}

// ─── Registro ────────────────────────────────────────────────────────────────
export async function registerPWA() {
  if (!('serviceWorker' in navigator)) return false;
  try {
    swRegistration = await navigator.serviceWorker.register('/sw.js', { scope: '/', updateViaCache: 'none' });
    // Navegadores/políticas que bloquean los Service Workers devuelven undefined.
    if (!swRegistration) return false;
    swRegistration.addEventListener('updatefound', () => {
      const newWorker = swRegistration.installing;
      newWorker?.addEventListener('statechange', () => {
        if (newWorker.state === 'installed' && navigator.serviceWorker.controller) {
          // Nunca recargar en mitad de la reproducción: se aplica en la próxima apertura.
          console.log('[PWA] Nueva versión del Service Worker disponible.');
        }
      });
    });
    navigator.serviceWorker.addEventListener('message', (event) => {
      messageListeners.forEach(fn => fn(event.data));
    });
    // Un SW nuevo que toma el control recibe de nuevo el usuario activo.
    navigator.serviceWorker.addEventListener('controllerchange', () => {
      if (activeUser) postToSW({ type: 'SET_USER', user: activeUser });
    });
    return true;
  } catch (err) {
    console.error('[PWA] Error registrando el Service Worker:', err);
    return false;
  }
}

async function postToSW(message) {
  if (!('serviceWorker' in navigator)) return false;
  try {
    const reg = await Promise.race([
      navigator.serviceWorker.ready,
      new Promise(resolve => setTimeout(resolve, 5000, null)),
    ]);
    const target = navigator.serviceWorker.controller || reg?.active;
    if (!target) return false;
    target.postMessage(message);
    return true;
  } catch {
    return false;
  }
}

// ─── Usuario activo ──────────────────────────────────────────────────────────
export async function setPWAUser(user) {
  activeUser = USER_RE.test(user || '') ? user : null;
  await postToSW({ type: 'SET_USER', user: activeUser });
  await refreshCacheStatus();
}

// Al cerrar sesión: purga la caché de API del usuario (y opcionalmente el audio).
export async function clearUserCaches(user, { includeSongs = false } = {}) {
  if (USER_RE.test(user || '') && cachesAvailable()) {
    const keys = await caches.keys();
    await Promise.all(keys
      .filter(k => k.endsWith(`-u:${user}`) && (includeSongs || !k.startsWith(SONGS_PREFIX)))
      .map(k => caches.delete(k)));
  }
  await postToSW({ type: 'CLEAR_USER_CACHES', user, includeSongs });
  activeUser = null;
  cachedSongKeys = new Set();
}

// ─── Estado de la caché ──────────────────────────────────────────────────────
export async function refreshCacheStatus() {
  if (!activeUser || !cachesAvailable()) {
    cachedSongKeys = new Set();
    return { cachedSongs: 0 };
  }
  try {
    const cache = await caches.open(songsCacheName(activeUser));
    const keys = await cache.keys();
    cachedSongKeys = new Set(keys.map(r => cacheKeyFor(r.url)).filter(k => k.startsWith('/api/stream/')));
  } catch {
    cachedSongKeys = new Set();
  }
  return { cachedSongs: cachedSongKeys.size };
}

export function isUrlCached(url) {
  return Boolean(url) && cachedSongKeys.has(cacheKeyFor(url));
}

// Borra entradas concretas (p. ej. tras recortar o borrar una canción).
export async function invalidateCachedUrls(urls) {
  if (!activeUser || !cachesAvailable()) return;
  const cache = await caches.open(songsCacheName(activeUser));
  await Promise.all(urls.filter(Boolean).map(async (url) => {
    const key = cacheKeyFor(url);
    cachedSongKeys.delete(key);
    await cache.delete(key);
  }));
}

// ─── Precarga offline ────────────────────────────────────────────────────────
/**
 * Descarga canciones (y portadas) a la caché del usuario activo.
 * @param {Array} songs
 * @param {{ streamUrlFor: Function, onProgress?: Function, signal?: AbortSignal, concurrency?: number }} opts
 * @returns {Promise<{cached:number, skipped:number, failed:number, total:number, aborted:boolean, quotaExceeded:boolean}>}
 */
export async function precacheSongs(songs, { streamUrlFor, onProgress, signal, concurrency = 2 } = {}) {
  const result = { cached: 0, skipped: 0, failed: 0, total: songs.length, aborted: false, quotaExceeded: false };
  if (!activeUser) throw new Error('No hay sesión activa');
  if (!cachesAvailable()) throw new Error('Este navegador no permite la caché offline (¿HTTP sin TLS?)');

  const cache = await caches.open(songsCacheName(activeUser));
  const existing = new Set((await cache.keys()).map(r => cacheKeyFor(r.url)));

  // Elimina revisiones antiguas de canciones recortadas/sustituidas.
  const wanted = new Map();
  for (const song of songs) {
    const url = streamUrlFor(song);
    if (url) wanted.set(new URL(url, window.location.origin).pathname, cacheKeyFor(url));
  }
  for (const key of existing) {
    const pathOnly = key.split('?')[0];
    if (wanted.has(pathOnly) && wanted.get(pathOnly) !== key) {
      await cache.delete(key);
      existing.delete(key);
    }
  }

  const controller = new AbortController();
  const onAbort = () => controller.abort();
  signal?.addEventListener('abort', onAbort);

  let index = 0;
  let done = 0;
  const worker = async () => {
    while (index < songs.length && !controller.signal.aborted) {
      const song = songs[index++];
      const url = streamUrlFor(song);
      try {
        if (!url) { result.failed += 1; continue; }
        const key = cacheKeyFor(url);
        if (existing.has(key)) {
          result.skipped += 1;
        } else {
          const response = await fetch(withParams(url, { bypass_sw: '1', precache: '1' }), {
            credentials: 'same-origin',
            signal: controller.signal,
          });
          if (response.status === 200) {
            await cache.put(key, response);
            existing.add(key);
            result.cached += 1;
          } else {
            result.failed += 1;
          }
        }
        const cover = song.cover_url;
        if (cover && cover.startsWith('/api/cover/')) {
          const coverKey = cacheKeyFor(cover);
          if (!existing.has(coverKey)) {
            const coverRes = await fetch(cover, { credentials: 'same-origin', signal: controller.signal });
            if (coverRes.ok) { await cache.put(coverKey, coverRes); existing.add(coverKey); }
          }
        }
      } catch (err) {
        if (err && err.name === 'QuotaExceededError') {
          result.quotaExceeded = true;
          controller.abort();
          break;
        }
        if (err && err.name === 'AbortError') break;
        result.failed += 1;
      } finally {
        done += 1;
        onProgress?.({ current: Math.min(done, songs.length), total: songs.length, cached: result.cached, songTitle: song?.title || '' });
      }
    }
  };

  try {
    await Promise.all(Array.from({ length: Math.max(1, concurrency) }, worker));
  } finally {
    signal?.removeEventListener('abort', onAbort);
  }
  result.aborted = controller.signal.aborted;
  await refreshCacheStatus();
  return result;
}

// ─── Instalación ─────────────────────────────────────────────────────────────
export function setupInstallPrompt(onPromptReady) {
  if (window.__deferredInstallPrompt) {
    installPromptEvent = window.__deferredInstallPrompt;
    onPromptReady(true);
  }
  const onBeforeInstall = (e) => {
    e.preventDefault();
    installPromptEvent = e;
    window.__deferredInstallPrompt = e;
    onPromptReady(true);
  };
  const onInstalled = () => {
    installPromptEvent = null;
    window.__deferredInstallPrompt = null;
    onPromptReady(false);
  };
  window.addEventListener('beforeinstallprompt', onBeforeInstall);
  window.addEventListener('appinstalled', onInstalled);
  return () => {
    window.removeEventListener('beforeinstallprompt', onBeforeInstall);
    window.removeEventListener('appinstalled', onInstalled);
  };
}

export async function promptInstall() {
  if (!installPromptEvent) return false;
  installPromptEvent.prompt();
  const { outcome } = await installPromptEvent.userChoice;
  installPromptEvent = null;
  return outcome === 'accepted';
}

export function isInstalledPWA() {
  return window.matchMedia('(display-mode: standalone)').matches || window.navigator.standalone === true;
}

export function isOnline() {
  return navigator.onLine;
}
