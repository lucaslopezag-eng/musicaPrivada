import { useCallback, useEffect, useRef, useState } from 'react';
import { useLatestRef } from './useLatestRef.js';

// ─── useLibrary (FASE 2) ─────────────────────────────────────────────────────
// Canciones y playlists del usuario:
// · Carga inicial, sondeo de /songs/version cada 60 s (refresca solo si cambió).
// · Las respuestas tardías de otra playlist se descartan (número de secuencia +
//   playlist activa), así que cambiar rápido de playlist no mezcla listas.
// · Mutaciones optimistas con reversión: reordenar y borrar.

const VERSION_POLL_MS = 60000;

export function useLibrary({ token, apiFetch, addToast }) {
  const [songs, setSongs] = useState([]);
  const [playlists, setPlaylists] = useState([]);
  const [activePlaylist, setActivePlaylistState] = useState(null);
  const activeRef = useLatestRef(activePlaylist);
  const songsRef = useLatestRef(songs);
  const tokenRef = useLatestRef(token);
  const addToastRef = useLatestRef(addToast);
  const versionRef = useRef(null);
  const requestSeq = useRef(0);

  const fetchSongs = useCallback(async (playlistId = activeRef.current ? activeRef.current.id : null) => {
    if (!tokenRef.current) return;
    const seq = ++requestSeq.current;
    try {
      const r = await apiFetch(playlistId ? `/playlists/${playlistId}/songs` : '/songs');
      const data = await r.json();
      const currentActiveId = activeRef.current ? activeRef.current.id : null;
      // 401 → apiFetch ya cierra la sesión de forma centralizada.
      if (r.ok && Array.isArray(data) && playlistId === currentActiveId && seq === requestSeq.current) setSongs(data);
    } catch { /* sin red: se conserva la lista */ }
  }, [apiFetch, activeRef, tokenRef]);

  const fetchPlaylists = useCallback(async () => {
    if (!tokenRef.current) return;
    try {
      const r = await apiFetch('/playlists');
      const data = await r.json();
      if (r.ok && Array.isArray(data)) setPlaylists(data);
    } catch { /* sin red */ }
  }, [apiFetch, tokenRef]);

  const refresh = useCallback(() => {
    fetchPlaylists();
    fetchSongs();
  }, [fetchPlaylists, fetchSongs]);

  const setActivePlaylist = useCallback((playlist) => {
    activeRef.current = playlist; // inmediato: fetchSongs lo usa para descartar respuestas viejas
    setActivePlaylistState(playlist);
    setSongs([]);
    if (tokenRef.current) fetchSongs(playlist ? playlist.id : null);
  }, [activeRef, tokenRef, fetchSongs]);

  // Carga inicial y sondeo de versión.
  useEffect(() => {
    if (!token) return undefined;
    fetchPlaylists();
    fetchSongs();
    const checkVersion = async () => {
      try {
        const r = await apiFetch('/songs/version');
        if (!r.ok) return;
        const d = await r.json();
        if (versionRef.current !== d.version) {
          versionRef.current = d.version;
          fetchSongs();
        }
      } catch { /* sin red */ }
    };
    const interval = setInterval(checkVersion, VERSION_POLL_MS);
    return () => clearInterval(interval);
  }, [token, apiFetch, fetchPlaylists, fetchSongs]);

  const reset = useCallback(() => {
    requestSeq.current += 1;
    activeRef.current = null;
    versionRef.current = null;
    setSongs([]);
    setPlaylists([]);
    setActivePlaylistState(null);
  }, [activeRef]);

  // ─── Mutaciones ────────────────────────────────────────────────────────────
  const createPlaylist = useCallback(async (name) => {
    try {
      const r = await apiFetch('/playlists', { method: 'POST', body: JSON.stringify({ name }) });
      if (!r.ok) throw new Error();
      fetchPlaylists();
      return true;
    } catch {
      addToastRef.current('No se pudo crear la playlist', 'error');
      return false;
    }
  }, [apiFetch, fetchPlaylists, addToastRef]);

  const deletePlaylist = useCallback(async (playlist) => {
    try {
      const r = await apiFetch(`/playlists/${playlist.id}`, { method: 'DELETE' });
      if (!r.ok) throw new Error();
      if (activeRef.current && activeRef.current.id === playlist.id) setActivePlaylist(null);
      fetchPlaylists();
      return true;
    } catch {
      addToastRef.current('No se pudo eliminar la playlist', 'error');
      return false;
    }
  }, [apiFetch, activeRef, setActivePlaylist, fetchPlaylists, addToastRef]);

  const addSongToPlaylist = useCallback(async (playlist, song) => {
    try {
      const r = await apiFetch(`/playlists/${playlist.id}/songs`, { method: 'POST', body: JSON.stringify({ songId: song.id }) });
      addToastRef.current(r.ok ? `Añadida a ${playlist.name}` : 'No se pudo añadir a la playlist', r.ok ? 'success' : 'error');
    } catch {
      addToastRef.current('Error de red', 'error');
    }
  }, [apiFetch, addToastRef]);

  const removeSongFromActivePlaylist = useCallback(async (song) => {
    const playlist = activeRef.current;
    if (!playlist) return;
    try {
      const r = await apiFetch(`/playlists/${playlist.id}/songs/${song.id}`, { method: 'DELETE' });
      addToastRef.current(r.ok ? 'Quitada de la playlist' : 'No se pudo quitar de la playlist', r.ok ? 'info' : 'error');
      fetchSongs(playlist.id);
    } catch {
      addToastRef.current('Error de red', 'error');
    }
  }, [apiFetch, activeRef, fetchSongs, addToastRef]);

  // Reordenación optimista por ids (UI-01); si el servidor falla, se recarga.
  const reorderSongs = useCallback((fromId, toId) => {
    const prev = songsRef.current;
    const fromIdx = prev.findIndex(s => s.id === fromId);
    const toIdx = prev.findIndex(s => s.id === toId);
    if (fromIdx === -1 || toIdx === -1 || fromIdx === toIdx) return;
    const next = [...prev];
    const [item] = next.splice(fromIdx, 1);
    next.splice(toIdx, 0, item);
    songsRef.current = next; // dos arrastres seguidos parten del orden ya movido
    setSongs(next);
    const playlist = activeRef.current;
    const endpoint = playlist ? `/playlists/${playlist.id}/reorder` : '/playlist/reorder';
    apiFetch(endpoint, { method: 'POST', body: JSON.stringify({ orderedIds: next.map(s => s.id) }) })
      .then((r) => { if (!r.ok) throw new Error(`HTTP ${r.status}`); })
      .catch(() => {
        addToastRef.current('No se pudo guardar el nuevo orden', 'error');
        fetchSongs();
      });
  }, [apiFetch, activeRef, songsRef, fetchSongs, addToastRef]);

  // Borrado optimista; devuelve true si el servidor lo confirmó.
  const deleteSong = useCallback(async (song) => {
    setSongs(prev => prev.filter(s => s.id !== song.id));
    try {
      const r = await apiFetch(`/songs/${song.id}`, { method: 'DELETE' });
      if (!r.ok) throw new Error(`HTTP ${r.status}`);
      return true;
    } catch {
      addToastRef.current('No se pudo eliminar la canción', 'error');
      fetchSongs();
      return false;
    }
  }, [apiFetch, fetchSongs, addToastRef]);

  return {
    songs, playlists, activePlaylist, setActivePlaylist,
    fetchSongs, fetchPlaylists, refresh, reset,
    createPlaylist, deletePlaylist, addSongToPlaylist, removeSongFromActivePlaylist, reorderSongs, deleteSong,
  };
}
