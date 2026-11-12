import { useCallback, useEffect, useRef, useState } from 'react';
import {
  registerPWA, setupInstallPrompt, promptInstall, precacheSongs, refreshCacheStatus, setPWAUser,
  clearUserCaches, invalidateCachedUrls, isInstalledPWA, isOnline,
} from '../pwa.js';
import { streamUrlFor } from '../lib/media.js';
import { safeGetItem, safeSetItem } from '../lib/storage.js';
import { useLatestRef } from './useLatestRef.js';

// ─── useOfflineCache (FASE 2) ────────────────────────────────────────────────
// Interfaz con el Service Worker y Cache Storage:
// · Registro del SW, aviso de instalación de la PWA, estado online/offline.
// · Cachés por usuario (PWA-01): se informa al SW del usuario activo.
// · Descarga offline (PWA-03) desde la app, abortable, que se detiene en seco
//   si el dispositivo se queda sin cuota.

export function useOfflineCache({ token, currentUser, addToast }) {
  const [canInstall, setCanInstall] = useState(false);
  const [isOffline, setIsOffline] = useState(() => !isOnline());
  const [cacheProgress, setCacheProgress] = useState(null); // { current, total, cached, songTitle }
  const [cachedSongCount, setCachedSongCount] = useState(0);
  const abortRef = useRef(null);
  const addToastRef = useLatestRef(addToast);
  const isPWA = isInstalledPWA();

  useEffect(() => {
    registerPWA();
    const removeInstallListeners = setupInstallPrompt((canShow) => {
      if (!safeGetItem('hideInstallBanner')) setCanInstall(canShow);
    });
    const onOnline = () => { setIsOffline(false); addToastRef.current('Conexión restaurada', 'success'); };
    const onOffline = () => { setIsOffline(true); addToastRef.current('Sin conexión — reproduciendo desde caché', 'info'); };
    window.addEventListener('online', onOnline);
    window.addEventListener('offline', onOffline);
    return () => {
      window.removeEventListener('online', onOnline);
      window.removeEventListener('offline', onOffline);
      removeInstallListeners();
      if (abortRef.current) abortRef.current.abort();
    };
  }, [addToastRef]);

  // PWA-01: el SW separa cachés por usuario; se le comunica el usuario activo.
  useEffect(() => {
    if (!token || !currentUser) return undefined;
    let cancelled = false;
    setPWAUser(currentUser)
      .then(() => refreshCacheStatus())
      .then(({ cachedSongs }) => { if (!cancelled) setCachedSongCount(cachedSongs); })
      .catch(() => {});
    return () => { cancelled = true; };
  }, [token, currentUser]);

  const startPrecache = useCallback(async (list) => {
    if (abortRef.current) {
      abortRef.current.abort();
      abortRef.current = null;
      setCacheProgress(null);
      addToastRef.current('Descarga offline detenida', 'info');
      return;
    }
    if (!list || !list.length) { addToastRef.current('No hay canciones que descargar', 'info'); return; }
    const controller = new AbortController();
    abortRef.current = controller;
    setCacheProgress({ current: 0, total: list.length, cached: 0, songTitle: '' });
    try {
      const result = await precacheSongs(list, { streamUrlFor, signal: controller.signal, onProgress: (p) => setCacheProgress(p) });
      const { cachedSongs } = await refreshCacheStatus();
      setCachedSongCount(cachedSongs);
      if (result.quotaExceeded) addToastRef.current('Sin espacio en el dispositivo: descarga offline interrumpida', 'error');
      else if (!result.aborted) {
        addToastRef.current(`✅ ${result.cached} nuevas, ${result.skipped} ya estaban${result.failed ? `, ${result.failed} con error` : ''}`, result.failed ? 'info' : 'success');
      }
    } catch (err) {
      addToastRef.current(err.message || 'No se pudo descargar para offline', 'error');
    } finally {
      if (abortRef.current === controller) abortRef.current = null;
      setCacheProgress(null);
    }
  }, [addToastRef]);

  const install = useCallback(async () => {
    const ok = await promptInstall();
    setCanInstall(false);
    return ok;
  }, []);

  const dismissInstall = useCallback(() => {
    setCanInstall(false);
    safeSetItem('hideInstallBanner', 'true');
  }, []);

  // Logout: detener descargas y purgar la caché de API del usuario.
  const clearForUser = useCallback((user) => {
    if (abortRef.current) { abortRef.current.abort(); abortRef.current = null; }
    setCacheProgress(null);
    if (user) clearUserCaches(user).catch(() => {});
  }, []);

  const invalidate = useCallback((urls) => invalidateCachedUrls(urls).catch(() => {}), []);

  return {
    canInstall, isPWA, isOffline, cacheProgress, cachedSongCount,
    startPrecache, install, dismissInstall, clearForUser, invalidate,
  };
}
