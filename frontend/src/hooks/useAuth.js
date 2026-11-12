import { useCallback, useEffect, useRef, useState } from 'react';
import { API_BASE } from '../lib/media.js';
import { safeGetItem, safeSetItem, safeRemoveItem } from '../lib/storage.js';
import { useLatestRef } from './useLatestRef.js';

// ─── useAuth (FASE 2) ────────────────────────────────────────────────────────
// Sesión: token Bearer (localStorage) + cookie HttpOnly que emite el servidor
// para <audio>/<img>/sendBeacon. El usuario lo devuelve el servidor (nunca se
// decodifica del token).
// · apiFetch tiene identidad estable: los efectos que dependen de él no se
//   re-ejecutan en cada render.
// · Un 401 cierra la sesión de forma centralizada.
// · onBeforeLogout/onAfterLogout permiten a los demás hooks limpiar su estado
//   (enviar la última escucha ANTES de revocar, purgar cachés, etc.).

export function useAuth({ onBeforeLogout, onAfterLogout } = {}) {
  const [token, setToken] = useState(() => safeGetItem('spotify_token', ''));
  const [currentUser, setCurrentUser] = useState(() => safeGetItem('spotify_user', ''));
  const [isAdmin, setIsAdmin] = useState(false);
  // Temas vetados por el servidor para este usuario (también bloquea sus imágenes).
  const [hiddenThemes, setHiddenThemes] = useState([]);
  const [defaultPlaylist, setDefaultPlaylist] = useState(null);
  // Fondo de pantalla propio: { url, opacity } (url null = sin imagen).
  const [background, setBackground] = useState(null);

  const tokenRef = useLatestRef(token);
  const userRef = useLatestRef(currentUser);
  const beforeRef = useLatestRef(onBeforeLogout);
  const afterRef = useLatestRef(onAfterLogout);
  const loggingOutRef = useRef(false);

  const logout = useCallback(async ({ callServer = true } = {}) => {
    if (loggingOutRef.current) return;
    loggingOutRef.current = true;
    const user = userRef.current;
    const currentToken = tokenRef.current;
    try {
      // Primero se envía la última escucha (aún con sesión válida) y después se revoca.
      beforeRef.current?.(user);
      if (callServer && currentToken) {
        try {
          await fetch(`${API_BASE}/logout`, { method: 'POST', headers: { Authorization: `Bearer ${currentToken}` } });
        } catch { /* sin red */ }
      }
      safeRemoveItem('spotify_token');
      safeRemoveItem('spotify_user');
      safeRemoveItem('spotify_current_song');
      safeRemoveItem('spotify_current_pos');
      afterRef.current?.(user);
      setCurrentUser('');
      setIsAdmin(false);
      setHiddenThemes([]);
      setDefaultPlaylist(null);
      setBackground(null);
      setToken('');
    } finally {
      loggingOutRef.current = false;
    }
  }, [userRef, tokenRef, beforeRef, afterRef]);

  const apiFetch = useCallback(async (path, options = {}) => {
    const currentToken = tokenRef.current;
    const headers = { 'Content-Type': 'application/json', ...options.headers, Authorization: `Bearer ${currentToken}` };
    // El SW usa esta cabecera para separar la caché offline por usuario.
    if (userRef.current) headers['X-MP-User'] = userRef.current;
    const res = await fetch(`${API_BASE}${path}`, { ...options, headers });
    if (res.status === 401 && currentToken && tokenRef.current === currentToken) logout({ callServer: false });
    return res;
  }, [tokenRef, userRef, logout]);

  const login = useCallback(async (username, password) => {
    try {
      const r = await fetch(`${API_BASE}/login`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ username, password }),
      });
      const d = await r.json().catch(() => ({}));
      if (!r.ok || !d.token) return { ok: false, error: d.error || 'Autenticación fallida' };
      safeSetItem('spotify_token', d.token);
      safeSetItem('spotify_user', d.user);
      setCurrentUser(d.user);
      setIsAdmin(Boolean(d.isAdmin));
      setHiddenThemes(Array.isArray(d.hiddenThemes) ? d.hiddenThemes : []);
      setDefaultPlaylist(d.defaultPlaylist || null);
      setBackground(d.background || null);
      setToken(d.token);
      return { ok: true };
    } catch {
      return { ok: false, error: 'Error de red' };
    }
  }, []);

  // Sesión restaurada: valida el token, obtiene el usuario y renueva la cookie
  // HttpOnly que autentica <audio>, portadas y sendBeacon.
  useEffect(() => {
    if (!token) return undefined;
    let cancelled = false;
    fetch(`${API_BASE}/session`, { headers: { Authorization: `Bearer ${token}` } })
      .then(async (r) => {
        if (cancelled) return;
        if (r.status === 401) { logout({ callServer: false }); return; }
        if (!r.ok) return; // sin red: se mantiene la sesión local (modo offline)
        const d = await r.json();
        if (cancelled || !d.user) return;
        safeSetItem('spotify_user', d.user);
        setCurrentUser(d.user);
        setIsAdmin(Boolean(d.isAdmin));
        setHiddenThemes(Array.isArray(d.hiddenThemes) ? d.hiddenThemes : []);
        setDefaultPlaylist(d.defaultPlaylist || null);
        setBackground(d.background || null);
      })
      .catch(() => {});
    return () => { cancelled = true; };
  }, [token, logout]);

  return { token, currentUser, isAdmin, hiddenThemes, defaultPlaylist, background, setBackground, login, logout, apiFetch };
}
