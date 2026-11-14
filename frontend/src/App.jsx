import { useCallback, useEffect, useMemo, useState } from 'react';
import { ListMusic } from 'lucide-react';
import './index.css';
import WrappedEngine from './WrappedEngine';
import { streamUrlFor } from './lib/media.js';
import { safeGetItem, safeSetItem } from './lib/storage.js';

import { useAuth } from './hooks/useAuth.js';
import { useLibrary } from './hooks/useLibrary.js';
import { usePlayer } from './hooks/usePlayer.js';
import { useSubtitles } from './hooks/useSubtitles.js';
import { useOfflineCache } from './hooks/useOfflineCache.js';
import { useAiRecommendations } from './hooks/useAiRecommendations.js';
import { useTaskLogs } from './hooks/useTaskLogs.js';
import { useWrapped } from './hooks/useWrapped.js';
import { useToasts } from './hooks/useToasts.js';
import { useDialog } from './hooks/useDialog.js';
import { useBackground } from './hooks/useBackground.js';

import LoginScreen from './components/auth/LoginScreen.jsx';
import Sidebar from './components/layout/Sidebar.jsx';
import MobileNav from './components/layout/MobileNav.jsx';
import ResizeHandle from './components/layout/ResizeHandle.jsx';
import AudioEngine from './components/player/AudioEngine.jsx';
import PlayerBar from './components/player/PlayerBar.jsx';
import QueuePanel from './components/player/QueuePanel.jsx';
import AppDialog from './components/dialogs/AppDialog.jsx';
import ContextMenu from './components/dialogs/ContextMenu.jsx';
import TrimEditor from './components/dialogs/TrimEditor.jsx';
import HomeView from './components/views/HomeView.jsx';
import PlaylistView from './components/views/PlaylistView.jsx';
import SearchTab from './components/views/SearchTab.jsx';
import ThemesTab from './components/views/ThemesTab.jsx';
import WrappedTab from './components/views/WrappedTab.jsx';
import InstallTab from './components/views/InstallTab.jsx';
import LyricsView from './components/views/LyricsView.jsx';
import Toasts from './components/common/Toasts.jsx';
import ErrorBoundary from './components/common/ErrorBoundary.jsx';
import PwaOverlays from './components/pwa/PwaOverlays.jsx';
import IosInstallHint from './components/pwa/IosInstallHint.jsx';

// ─── App (FASE 2) ────────────────────────────────────────────────────────────
// Antes: ~2.900 líneas que mezclaban motor de audio, autenticación, API y
// renderizado. Ahora solo compone hooks (estado y efectos) y componentes
// (presentación). Ver hooks/ y components/.

function initialPlayerHeight() {
  const saved = Number.parseInt(safeGetItem('player_height', ''), 10);
  return Number.isFinite(saved) && saved >= 60 ? saved : 90;
}

export default function App() {
  const { toasts, addToast } = useToasts();
  const { dialog, askDialog, closeDialog } = useDialog();

  const [activeTab, setActiveTab] = useState('home');
  const [theme, setTheme] = useState(() => safeGetItem('spotify_theme') || 'classic');
  const [showQueue, setShowQueue] = useState(false);
  const [showSubtitles, setShowSubtitles] = useState(() => safeGetItem('spotify_subtitles', 'false') === 'true');
  const [showLogs, setShowLogs] = useState(false);
  const [contextMenu, setContextMenu] = useState(null);
  const [trimSong, setTrimSong] = useState(null);
  const [songToReplace, setSongToReplace] = useState(null);
  const [importPlaylistId, setImportPlaylistId] = useState('');
  const [showWrappedStory, setShowWrappedStory] = useState(false);
  const [playerHeight, setPlayerHeight] = useState(initialPlayerHeight);

  // Los callbacks de logout se ejecutan más tarde, cuando todos los hooks ya existen.
  const auth = useAuth({
    // Primero la última escucha (con la sesión aún válida) y parar el audio.
    onBeforeLogout: () => player.actions.reset(),
    onAfterLogout: (user) => {
      offline.clearForUser(user); // PWA-01: la caché de API del usuario no queda disponible para otro
      library.reset();
      wrapped.reset();
      setContextMenu(null);
      setTrimSong(null);
      setSongToReplace(null);
      setShowWrappedStory(false);
      setShowLogs(false);
    },
  });
  const { token, currentUser, isAdmin, hiddenThemes, defaultPlaylist, apiFetch, logout } = auth;
  const background = useBackground({ background: auth.background, setBackground: auth.setBackground, apiFetch, addToast });

  const library = useLibrary({ token, apiFetch, addToast });
  const player = usePlayer({ songs: library.songs, apiFetch, addToast, activePlaylistId: library.activePlaylist?.id ?? null });
  const { state: playerState, actions: playerActions } = player;
  const { currentSong } = playerState;
  const subtitles = useSubtitles({ song: currentSong, enabled: showSubtitles, token });
  const offline = useOfflineCache({ token, currentUser, addToast });
  const taskLogs = useTaskLogs({ apiFetch, token, visible: showLogs });
  const wrapped = useWrapped({ apiFetch, token });
  useAiRecommendations({
    enabled: playerState.shuffleMode === 'ai',
    token,
    apiFetch,
    addToast,
    queueSize: playerState.aiQueue.length,
    onRecs: playerActions.setAiQueue,
  });

  // ─── Preferencias de interfaz ──────────────────────────────────────────────
  useEffect(() => {
    let meta = document.querySelector('meta[name="viewport"]');
    if (!meta) {
      meta = document.createElement('meta');
      meta.name = 'viewport';
      document.head.appendChild(meta);
    }
    meta.content = 'width=device-width, initial-scale=1, maximum-scale=1, user-scalable=no, viewport-fit=cover';
  }, []);

  useEffect(() => {
    if (theme === 'classic') document.body.removeAttribute('data-theme');
    else document.body.setAttribute('data-theme', theme);
    safeSetItem('spotify_theme', theme);
  }, [theme]);

  // Un tema vetado para este usuario (p. ej. guardado por otro en este dispositivo) se descarta.
  useEffect(() => {
    if (hiddenThemes.includes(theme)) setTheme('classic');
  }, [hiddenThemes, theme]);

  // Fondo propio: la clase vuelve translúcidos los paneles para que se vea.
  const hasBackground = Boolean(token && background.url);
  useEffect(() => {
    document.body.classList.toggle('has-user-bg', hasBackground);
  }, [hasBackground]);

  useEffect(() => { safeSetItem('spotify_subtitles', String(showSubtitles)); }, [showSubtitles]);

  // ─── Navegación ────────────────────────────────────────────────────────────
  const { load: loadWrapped } = wrapped;
  const navigate = useCallback((tab) => {
    setActiveTab(tab);
    if (tab === 'wrapped') loadWrapped();
  }, [loadWrapped]);

  const { setActivePlaylist } = library;
  const openPlaylist = useCallback((p) => {
    setActiveTab('home');
    setActivePlaylist(p);
  }, [setActivePlaylist]);

  const toggleQueue = useCallback(() => setShowQueue(q => !q), []);
  const toggleSubtitles = useCallback(() => setShowSubtitles(s => !s), []);

  // ─── Acciones con confirmación ─────────────────────────────────────────────
  const createPlaylist = async () => {
    const name = await askDialog({ type: 'prompt', title: 'Nueva playlist', message: 'Nombre de la nueva playlist:', confirmLabel: 'Crear' });
    if (name && name.trim()) library.createPlaylist(name.trim());
  };

  const deleteActivePlaylist = async () => {
    const p = library.activePlaylist;
    if (!p) return;
    const ok = await askDialog({ type: 'confirm', title: 'Eliminar playlist', message: `¿Eliminar la playlist "${p.name}"? Las canciones no se borran de la biblioteca.`, confirmLabel: 'Eliminar', danger: true });
    if (ok) library.deletePlaylist(p);
  };

  const requestLogout = useCallback(async ({ confirm = true, callServer = true } = {}) => {
    if (confirm) {
      const ok = await askDialog({ type: 'confirm', title: 'Cerrar sesión', message: `Se cerrará la sesión de ${currentUser || 'este usuario'} en este dispositivo.`, confirmLabel: 'Cerrar sesión' });
      if (!ok) return;
    }
    logout({ callServer });
  }, [askDialog, currentUser, logout]);

  const handleImport = async (tracksText, playlistId) => {
    try {
      // MEDIA-04: 202 con taskId; los errores (413, playlist ajena, formato) se muestran.
      const r = await apiFetch('/import', { method: 'POST', body: JSON.stringify({ tracksText, playlistId: playlistId || null }) });
      const d = await r.json().catch(() => ({}));
      if (!r.ok) {
        addToast(r.status === 413 ? 'La lista es demasiado grande para importarla de una vez' : (d.error || 'No se pudo iniciar la importación'), 'error');
        return false;
      }
      addToast('Importación en cola', 'info');
      setShowLogs(true);
      taskLogs.refresh();
      return true;
    } catch {
      addToast('Error de red al importar', 'error');
      return false;
    }
  };

  const removeSong = async (song) => {
    const ok = await askDialog({ type: 'confirm', title: 'Eliminar canción', message: `¿Eliminar "${song.title}" de la biblioteca y del disco?`, confirmLabel: 'Eliminar', danger: true });
    if (!ok) return;
    if (await library.deleteSong(song)) {
      offline.invalidate([streamUrlFor(song)]);
      playerActions.removeSong(song.id);
    }
  };

  const menuActions = {
    enqueue: playerActions.enqueue,
    playNext: playerActions.playNext,
    trim: (song) => setTrimSong(song),
    replace: (song) => { setSongToReplace(song); setActiveTab('search'); },
    addToPlaylist: library.addSongToPlaylist,
    removeFromPlaylist: library.removeSongFromActivePlaylist,
    remove: removeSong,
  };

  const openMenu = useCallback((song, x, y) => setContextMenu({ song, x, y }), []);
  const closeMenu = useCallback(() => setContextMenu(null), []);
  const closeTrim = useCallback(() => setTrimSong(null), []);

  const { invalidate } = offline;
  const { fetchSongs } = library;
  const onTrimSaved = useCallback((song, result, trimStart) => {
    // La URL de la versión anterior (?v=rev) deja de ser válida en la caché offline.
    invalidate([streamUrlFor(song)]);
    if (typeof result.rev === 'number') {
      const position = player.timeStore.get().currentTime - trimStart;
      playerActions.updateSong({ id: song.id, rev: result.rev, duration: result.duration }, { reloadAt: Math.max(0, position) });
    }
    fetchSongs();
  }, [invalidate, player.timeStore, playerActions, fetchSongs]);

  const acceptAiRec = useCallback(async () => {
    try {
      const res = await playerActions.acceptAiRec();
      if (!res.ok) { addToast(res.error || 'No se pudo añadir a la biblioteca', 'error'); return; }
      addToast('Añadida a tu biblioteca', 'success');
      fetchSongs();
    } catch {
      addToast('Error de red', 'error');
    }
  }, [playerActions, addToast, fetchSongs]);

  const { refresh: refreshLogs } = taskLogs;
  const toggleLogs = useCallback(() => { setShowLogs(l => !l); refreshLogs(); }, [refreshLogs]);
  const { startPrecache } = offline;
  const librarySongs = library.songs;
  const precacheCurrent = useCallback(() => startPrecache(librarySongs), [startPrecache, librarySongs]);

  const audioEngine = useMemo(() => (
    <AudioEngine audioRef={player.audioRef} nextAudioRef={player.nextAudioRef} handlers={player.audioHandlers} />
  ), [player.audioRef, player.nextAudioRef, player.audioHandlers]);

  if (!token) {
    return (
      <>
        {audioEngine}
        <LoginScreen onLogin={auth.login} />
        <IosInstallHint />
        <Toasts toasts={toasts} />
      </>
    );
  }

  const activePlaylist = library.activePlaylist;

  return (
    <>
      {audioEngine}
      {hasBackground && (
        <div className="user-background" aria-hidden="true"
          style={{ backgroundImage: `url("${background.url}")`, opacity: background.opacity / 100 }} />
      )}
      <div className="spotify-layout" style={{ '--player-h': `${playerHeight}px` }}>
        <Sidebar
          activeTab={activeTab}
          onNavigate={navigate}
          playlists={library.playlists}
          activePlaylistId={activePlaylist?.id}
          songCount={library.songs.length}
          currentUser={currentUser}
          isAdmin={isAdmin}
          isCaching={Boolean(offline.cacheProgress)}
          onOpenPlaylist={openPlaylist}
          onPrecache={precacheCurrent}
          onRefresh={library.refresh}
          onToggleLogs={toggleLogs}
          onLogout={requestLogout}
        />

        {showSubtitles && (
          <LyricsView song={currentSong} cues={subtitles.cues} status={subtitles.status} timeStore={player.timeStore} onSeek={playerActions.seek} />
        )}

        <main className="main-view" style={{ flex: 1, minWidth: 0, gridColumn: '2', display: showSubtitles ? 'none' : 'block' }}>
          <div className="main-view-header desktop-only-header">
            <div style={{ display: 'flex', gap: '8px' }}>
              <button className="round-btn" aria-label="Atrás" disabled={!activePlaylist || activeTab !== 'home'} onClick={() => setActivePlaylist(null)}>{'<'}</button>
            </div>
            <button onClick={toggleQueue} className={`queue-toggle${showQueue ? ' active' : ''}`} aria-pressed={showQueue}>
              <ListMusic size={18} /> Cola
            </button>
          </div>

          <div style={{ padding: '24px', position: 'relative' }}>
            {/* FE-3: si una vista falla al pintarse, el reproductor sigue funcionando. */}
            <ErrorBoundary inline resetKey={`${activeTab}:${activePlaylist?.id ?? ''}`}>
            {activeTab === 'home' && !activePlaylist && (
              <HomeView
                defaultPlaylist={defaultPlaylist}
                playlists={library.playlists}
                onOpenPlaylist={openPlaylist}
                onCreatePlaylist={createPlaylist}
                importPlaylistId={importPlaylistId}
                onImportPlaylistChange={setImportPlaylistId}
                onImport={handleImport}
                showLogs={showLogs}
                logs={taskLogs.logs}
              />
            )}
            {activeTab === 'home' && activePlaylist && (
              <PlaylistView
                playlist={activePlaylist}
                songs={library.songs}
                currentSongId={currentSong?.id}
                isPlaying={playerState.isPlaying}
                onBack={() => setActivePlaylist(null)}
                onPlaySong={playerActions.playSong}
                onDelete={deleteActivePlaylist}
                onMenu={openMenu}
                onReorder={library.reorderSongs}
              />
            )}
            {activeTab === 'search' && (
              <SearchTab
                defaultPlaylist={defaultPlaylist}
                apiFetch={apiFetch}
                addToast={addToast}
                librarySongs={library.songs}
                playlists={library.playlists}
                importPlaylistId={importPlaylistId}
                onImportPlaylistChange={setImportPlaylistId}
                songToReplace={songToReplace}
                onCancelReplace={() => setSongToReplace(null)}
                onReplaceQueued={() => setSongToReplace(null)}
                onPlaySong={playerActions.playSong}
              />
            )}
            {activeTab === 'themes' && <ThemesTab theme={theme} onSelect={setTheme} hiddenThemes={hiddenThemes} background={background} />}
            {activeTab === 'wrapped' && (
              <WrappedTab year={wrapped.year} data={wrapped.data} loading={wrapped.loading}
                onSelectYear={(y) => wrapped.load(y)} onPlayStory={() => setShowWrappedStory(true)} />
            )}
            {activeTab === 'install' && (
              <InstallTab
                canInstall={offline.canInstall}
                onInstall={() => offline.install().then(ok => { if (ok) addToast('App instalada', 'success'); })}
                onPrecache={precacheCurrent}
                isCaching={Boolean(offline.cacheProgress)}
                cachedSongCount={offline.cachedSongCount}
                currentUser={currentUser}
                onLogout={requestLogout}
                apiFetch={apiFetch}
                addToast={addToast}
              />
            )}
            </ErrorBoundary>
          </div>
        </main>

        {contextMenu && (
          <ContextMenu menu={contextMenu} playlists={library.playlists} activePlaylist={activePlaylist} onClose={closeMenu} actions={menuActions} />
        )}
        {trimSong && (
          <TrimEditor song={trimSong} apiFetch={apiFetch} addToast={addToast} onClose={closeTrim} onSaved={onTrimSaved} />
        )}

        {showQueue && (
          <QueuePanel
            currentSong={currentSong}
            queue={playerState.queue}
            autoQueue={playerState.autoQueue}
            aiQueue={playerState.aiQueue}
            history={playerState.history}
            shuffleMode={playerState.shuffleMode}
            actions={playerActions}
            onClose={toggleQueue}
          />
        )}

        <ResizeHandle className="player-resize-handle" axis="y" invert value={playerHeight} min={60}
          max={() => window.innerHeight * 0.8} onChange={setPlayerHeight}
          onEnd={(h) => safeSetItem('player_height', String(Math.round(h)))} />
        <PlayerBar
          currentSong={currentSong}
          isPlaying={playerState.isPlaying}
          shuffleMode={playerState.shuffleMode}
          repeatMode={playerState.repeatMode}
          volume={playerState.volume}
          muted={playerState.muted}
          loudnessNorm={player.loudnessNorm}
          currentAiRec={playerState.currentAiRec}
          aiCount={playerState.aiQueue.length}
          playerHeight={playerHeight}
          showSubtitles={showSubtitles}
          showQueue={showQueue}
          timeStore={player.timeStore}
          actions={playerActions}
          onToggleSubtitles={toggleSubtitles}
          onToggleQueue={toggleQueue}
          onAcceptAi={acceptAiRec}
          onRejectAi={playerActions.rejectAiRec}
        />

        {dialog && <AppDialog dialog={dialog} onClose={closeDialog} />}
        <Toasts toasts={toasts} />
        <PwaOverlays
          showInstall={offline.canInstall && !offline.isPWA}
          onInstall={() => offline.install().then(ok => { if (ok) addToast('App instalada correctamente', 'success'); })}
          onDismissInstall={offline.dismissInstall}
          cacheProgress={offline.cacheProgress}
          isOffline={offline.isOffline}
          cachedSongCount={offline.cachedSongCount}
        />
      </div>

      <IosInstallHint />
      <MobileNav activeTab={activeTab} onNavigate={navigate} showQueue={showQueue} onToggleQueue={toggleQueue} />

      {showWrappedStory && (
        <WrappedEngine wrappedData={wrapped.data} year={wrapped.year} onClose={() => setShowWrappedStory(false)} />
      )}
    </>
  );
}
