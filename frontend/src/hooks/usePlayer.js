import { useCallback, useEffect, useLayoutEffect, useMemo, useReducer, useRef, useState } from 'react';
import { playerReducer, createInitialPlayerState, ActionTypes as T, peekNext, aiReportFor } from './playerReducer.js';
import { createTimeStore } from './usePlaybackTime.js';
import { useLatestRef } from './useLatestRef.js';
import { shuffled, randomInt } from '../lib/shuffle.js';
import { API_BASE, streamUrlFor } from '../lib/media.js';
import { safeGetItem, safeSetItem, safeGetJSON } from '../lib/storage.js';
import { isUrlCached, withParams } from '../pwa.js';

// ─── usePlayer (FASE 2) ──────────────────────────────────────────────────────
// Motor de reproducción completo, extraído de App.jsx:
// · Estado en un useReducer formal (playerReducer.js). `dispatch` aplica el
//   mismo reducer de forma síncrona sobre stateRef, de modo que las acciones
//   imperativas (cargar el <audio>, informar al servidor) se calculan a partir
//   de la transición prev → next y nunca leen estado obsoleto.
// · Las acciones expuestas tienen identidad estable (leen refs), así que los
//   efectos globales (MediaSession, teclado, watchdog) se enlazan UNA vez y los
//   componentes memorizados no se re-renderizan por ellas.
// · Contabilidad de escucha por avance real del audio (AUDIO-03), sendBeacon
//   al ocultar la página, watchdog de fin de pista, recuperación de "stalled",
//   audio silencioso keep-alive (Android/MIUI), precarga de la siguiente pista
//   y normalización con Web Audio en escritorio.

const SILENT_WAV_SAMPLES = 8000; // 1 s a 8 kHz, 8 bits, mono
const POSITION_SAVE_MS = 3000;
const PREFETCH_REMAINING_S = 20;
const isAndroid = () => typeof navigator !== 'undefined' && /Android/i.test(navigator.userAgent);
// Aviso breve en pantalla para comprobar en el móvil si la amplificación está activa.
const avisoAmplificador = (texto) => {
  try {
    const d = document.createElement('div');
    d.textContent = texto;
    d.style.cssText = 'position:fixed;left:50%;bottom:90px;transform:translateX(-50%);background:#000c;color:#fff;padding:8px 14px;border-radius:8px;font:13px sans-serif;z-index:99999;pointer-events:none';
    document.body.appendChild(d);
    setTimeout(() => d.remove(), 5000);
  } catch (_) { /* sin DOM */ }
};
const isMobile = () => typeof navigator !== 'undefined' && /iPhone|iPad|iPod|Android/i.test(navigator.userAgent);

// Volumen perceptivo: el deslizador (0..1) guarda la posición; la ganancia real
// es v³ (0,5 → -18 dB, 0,1 → -60 dB), así la primera mitad ya baja de verdad.
const perceptualVolume = (v) => Math.pow(Math.min(1, Math.max(0, v || 0)), 3);

// Igualado entre canciones con la sonoridad medida en el servidor (EBU R128).
// En móvil el objetivo es más alto para no deshacer el amplificador.
const LOUDNESS_TARGET_LUFS = () => (isMobile() ? -10 : -14);
const LOUDNESS_MAX_BOOST_DB = 6;
const LOUDNESS_MAX_CUT_DB = -12;
function loudnessGainFor(lufs) {
  if (typeof lufs !== 'number' || !Number.isFinite(lufs)) return 1; // sin medir
  const db = Math.min(LOUDNESS_MAX_BOOST_DB, Math.max(LOUDNESS_MAX_CUT_DB, LOUDNESS_TARGET_LUFS() - lufs));
  return Math.pow(10, db / 20);
}

// Limitador: con +6 dB de igualado y el amplificador, los picos no recortan en seco.
function createLimiter(ctx) {
  const l = ctx.createDynamicsCompressor();
  l.threshold.value = -2;
  l.knee.value = 0;
  l.ratio.value = 20;
  l.attack.value = 0.002;
  l.release.value = 0.1;
  return l;
}

function createSilentWavUrl() {
  const buf = new ArrayBuffer(44 + SILENT_WAV_SAMPLES);
  const view = new DataView(buf);
  const write = (off, str) => { for (let i = 0; i < str.length; i++) view.setUint8(off + i, str.charCodeAt(i)); };
  write(0, 'RIFF'); view.setUint32(4, 36 + SILENT_WAV_SAMPLES, true);
  write(8, 'WAVE'); write(12, 'fmt ');
  view.setUint32(16, 16, true); view.setUint16(20, 1, true);
  view.setUint16(22, 1, true);
  view.setUint32(24, 8000, true); view.setUint32(28, 8000, true);
  view.setUint16(32, 1, true); view.setUint16(34, 8, true);
  write(36, 'data'); view.setUint32(40, SILENT_WAV_SAMPLES, true);
  // El WAV debe llevar muestras reales (silencio = ceros): Chrome rechaza uno vacío.
  return URL.createObjectURL(new Blob([buf], { type: 'audio/wav' }));
}

// URL de reproducción: si estamos online y la canción no está en la caché
// offline, se salta el Service Worker (evita suspensiones en segundo plano).
export function playbackUrlFor(song) {
  const url = streamUrlFor(song);
  if (!url) return null;
  return navigator.onLine && !isUrlCached(url) ? withParams(url, { bypass_sw: '1' }) : url;
}

function initPlayerState() {
  return createInitialPlayerState({
    currentSong: safeGetJSON('spotify_current_song', null),
    shuffleMode: safeGetItem('spotify_shuffle_mode', 'normal'),
    repeatMode: safeGetItem('spotify_repeat_mode', 'off'),
    songsUntilRec: randomInt(1, 4),
  });
}

export function usePlayer({ songs, apiFetch, addToast, activePlaylistId }) {
  const [state, rawDispatch] = useReducer(playerReducer, undefined, initPlayerState);
  const stateRef = useRef(null);
  if (stateRef.current === null) stateRef.current = state;

  const songsRef = useLatestRef(songs);
  const apiFetchRef = useLatestRef(apiFetch);
  const addToastRef = useLatestRef(addToast);
  const playlistIdRef = useLatestRef(activePlaylistId);

  const audioRef = useRef(null);
  const nextAudioRef = useRef(null);
  const keepAliveRef = useRef(null);
  const timeStore = useMemo(() => createTimeStore(), []);
  // Generación de la fuente del <audio>: invalida reintentos de reanudación pendientes.
  const genRef = useRef(0);
  const prefetchedUrlRef = useRef('');
  const lastPosSaveRef = useRef(0);
  const lastDeviceChangeRef = useRef(0);
  const audioCtxRef = useRef(null);
  const sourceNodeRef = useRef(null);
  const normGainRef = useRef(null);
  // Igualar volumen entre canciones (preferencia persistida, activada por defecto).
  const [loudnessNorm, setLoudnessNorm] = useState(() => safeGetItem('mp_loudness_norm', '1') !== '0');
  const loudnessNormRef = useLatestRef(loudnessNorm);
  // AUDIO-03: tiempo escuchado = avance real de currentTime.
  const listenRef = useRef({ song: null, ms: 0, lastMediaTime: null, lastWall: 0 });
  const watchdogRef = useRef({ timer: null, lastKnownTime: 0, stallCount: 0 });

  // ─── Contabilidad de escucha ───────────────────────────────────────────────
  const reportListening = useCallback((song, durationMs, completed, { skipAtMs = null, beacon = false } = {}) => {
    if (!song || durationMs < 2000) return; // descartes de menos de 2 s
    const body = JSON.stringify({
      song_id: song.id,
      listen_duration_ms: Math.floor(durationMs),
      completed,
      skip_at_ms: skipAtMs === null ? null : Math.floor(skipAtMs),
      playlist_id: playlistIdRef.current || null,
    });
    // pagehide: sendBeacon sobrevive al cierre de la página (usa la cookie de sesión).
    if (beacon && navigator.sendBeacon) {
      try {
        if (navigator.sendBeacon(`${API_BASE}/stats/listen`, new Blob([body], { type: 'application/json' }))) return;
      } catch { /* se intenta con fetch keepalive */ }
    }
    apiFetchRef.current('/stats/listen', { method: 'POST', body, keepalive: true }).catch(() => {});
  }, [apiFetchRef, playlistIdRef]);

  const resetListen = useCallback((song) => {
    listenRef.current = { song, ms: 0, lastMediaTime: audioRef.current ? audioRef.current.currentTime : 0, lastWall: performance.now() };
  }, []);

  const trackListenProgress = useCallback((audio) => {
    const L = listenRef.current;
    const now = performance.now();
    const t = audio.currentTime;
    if (!audio.paused && !audio.seeking && L.lastMediaTime !== null) {
      const dMedia = t - L.lastMediaTime;
      const dWall = ((now - L.lastWall) / 1000) * (audio.playbackRate || 1);
      // Solo cuenta el avance real; un salto mayor que el tiempo transcurrido es un seek.
      if (dMedia > 0 && dMedia <= dWall + 0.75) L.ms += dMedia * 1000;
    }
    L.lastMediaTime = t;
    L.lastWall = now;
  }, []);

  const flushListen = useCallback((completed, { beacon = false } = {}) => {
    const L = listenRef.current;
    if (L.song && L.ms > 0) {
      const skipAtMs = completed ? null : (audioRef.current ? audioRef.current.currentTime * 1000 : null);
      reportListening(L.song, L.ms, completed, { skipAtMs, beacon });
    }
    L.ms = 0;
  }, [reportListening]);

  const syncListenClock = useCallback(() => {
    const a = audioRef.current;
    if (a) { listenRef.current.lastMediaTime = a.currentTime; listenRef.current.lastWall = performance.now(); }
  }, []);

  // ─── Utilidades de audio ───────────────────────────────────────────────────
  const keepAlive = useCallback((on) => {
    const k = keepAliveRef.current;
    if (!k) return;
    if (on) { if (k.paused) k.play().catch(() => {}); } else k.pause();
  }, []);

  // Volumen del deslizador (curva perceptiva) + igualado de la canción actual.
  // Con grafo Web Audio el igualado va en un GainNode (puede subir hasta +6 dB);
  // sin él solo puede bajar, multiplicado en audio.volume.
  const applyVolume = useCallback(() => {
    const audio = audioRef.current;
    if (!audio) return;
    const s = stateRef.current;
    let g = 1;
    if (loudnessNormRef.current && s.currentSong) {
      const song = s.currentSong;
      // La canción guardada o en cola puede ser anterior a la medición.
      const fresh = (songsRef.current || []).find(x => x.id === song.id && x.title === song.title) || song;
      g = loudnessGainFor(fresh.loudness_lufs);
    }
    const node = normGainRef.current;
    if (node) {
      node.gain.setTargetAtTime(g, node.context.currentTime, 0.02);
      audio.volume = perceptualVolume(s.volume);
    } else {
      audio.volume = Math.min(1, perceptualVolume(s.volume) * g);
    }
    audio.muted = s.muted;
  }, [songsRef, loudnessNormRef]);

  const setupNormalization = useCallback(() => {
    const audio = audioRef.current;
    if (!audio || sourceNodeRef.current) return; // una sola vez
    try {
      const Ctx = window.AudioContext || window.webkitAudioContext;
      if (!Ctx) { avisoAmplificador('Amplificador NO disponible: sin AudioContext'); return; }
      const ctx = new Ctx();
      audioCtxRef.current = ctx;
      const source = ctx.createMediaElementSource(audio);
      sourceNodeRef.current = source;
      const normGain = ctx.createGain();
      normGainRef.current = normGain;
      const limiter = createLimiter(ctx);
      source.connect(normGain);
      applyVolume();
      if (isMobile()) {
        // Móvil: el volumen del <audio> no pasa de 100 %, así que se amplifica ~50 % con Web Audio.
        // Un saturador suave (tanh) sube el volumen medio sin recortar de golpe los picos.
        // Si el sistema suspende el contexto, se reanuda al volver o al reproducir.
        const K = 1.8; // ganancia ~x1,9 con volumen medio; los picos se saturan suave
        const curva = new Float32Array(4097);
        for (let n = 0; n < curva.length; n++) {
          const x = (n / (curva.length - 1)) * 2 - 1;
          curva[n] = Math.tanh(K * x) / Math.tanh(K);
        }
        const saturador = ctx.createWaveShaper();
        saturador.curve = curva;
        saturador.oversample = '2x';
        normGain.connect(limiter);
        limiter.connect(saturador);
        saturador.connect(ctx.destination);
        avisoAmplificador(`Amplificador activo (${ctx.state})`);
        const reanudar = () => { if (ctx.state !== 'running') ctx.resume().catch(() => {}); };
        audio.addEventListener('play', reanudar);
        audio.addEventListener('playing', reanudar);
        document.addEventListener('visibilitychange', reanudar);
        ctx.addEventListener?.('statechange', () => { if (ctx.state === 'suspended' && !audio.paused) reanudar(); });
        return;
      }
      const compressor = ctx.createDynamicsCompressor();
      compressor.threshold.value = -18;
      compressor.knee.value = 8;
      compressor.ratio.value = 4;
      compressor.attack.value = 0.003;
      compressor.release.value = 0.25;
      const gainNode = ctx.createGain();
      gainNode.gain.value = 1.2;
      normGain.connect(compressor);
      compressor.connect(gainNode);
      gainNode.connect(limiter);
      limiter.connect(ctx.destination);
    } catch (e) {
      console.warn('Normalización de audio no disponible:', e);
      avisoAmplificador(`Amplificador NO disponible: ${e && e.message ? e.message : e}`);
    }
  }, [applyVolume]);

  const clearPrefetch = useCallback(() => {
    prefetchedUrlRef.current = '';
    const n = nextAudioRef.current;
    if (n) { n.removeAttribute('src'); n.load(); }
  }, []);

  const prefetch = useCallback((song) => {
    const n = nextAudioRef.current;
    if (!song || !n) return;
    // PWA-02: misma URL que usará la reproducción (autenticada por cookie).
    const url = playbackUrlFor(song);
    if (!url || prefetchedUrlRef.current === url) return;
    prefetchedUrlRef.current = url;
    n.src = url;
    n.volume = 0;
    n.preload = 'auto';
    n.load();
  }, []);

  // ─── dispatch síncrono + efectos imperativos derivados de la transición ────
  const transitionRef = useRef(null);
  const dispatch = useCallback((action) => {
    const prev = stateRef.current;
    const next = playerReducer(prev, action);
    if (next === prev) return prev;
    stateRef.current = next;
    rawDispatch(action);
    transitionRef.current?.(prev, next, action);
    return next;
  }, []);

  const queueContext = useCallback(() => {
    const list = songsRef.current || [];
    return { songs: list, shuffled: shuffled(list) };
  }, [songsRef]);

  const startPlayback = useCallback((gen) => {
    const audio = audioRef.current;
    if (!audio) return;
    const p = audio.play();
    if (!p || typeof p.then !== 'function') { dispatch({ type: T.AUDIO_STATE, playing: true }); return; }
    p.then(() => {
      if (genRef.current === gen) dispatch({ type: T.AUDIO_STATE, playing: true });
    }).catch((err) => {
      if (genRef.current !== gen) return; // la sustituyó otra pista (AbortError esperado)
      console.warn('Reproducción bloqueada o interrumpida:', err);
      dispatch({ type: T.AUDIO_STATE, playing: false });
      // Bloqueo de autoplay en móvil: un reintento (funciona en algunos Android).
      if (err && (err.name === 'NotAllowedError' || err.name === 'NotSupportedError')) {
        setTimeout(() => {
          if (genRef.current !== gen || stateRef.current.isPlaying || !audioRef.current) return;
          audioRef.current.play()
            .then(() => dispatch({ type: T.AUDIO_STATE, playing: true }))
            .catch(() => addToastRef.current?.('▶ Toca el botón de play para continuar', 'info'));
        }, 500);
      }
    });
  }, [dispatch, addToastRef]);

  const loadCurrent = useCallback((song) => {
    const audio = audioRef.current;
    if (!audio) return;
    // Interrumpida/saltada: se informa el tiempo realmente escuchado. Tras un
    // final natural onEnded ya lo registró como completada (ms = 0).
    flushListen(false);
    genRef.current += 1;
    clearPrefetch();
    if (!song) {
      audio.pause();
      audio.removeAttribute('src');
      audio.load();
      timeStore.set({ currentTime: 0, duration: 0 });
      listenRef.current = { song: null, ms: 0, lastMediaTime: null, lastWall: 0 };
      return;
    }
    const url = playbackUrlFor(song);
    if (!url) { dispatch({ type: T.AUDIO_STATE, playing: false }); return; }
    setupNormalization();
    if (audioCtxRef.current?.state === 'suspended') audioCtxRef.current.resume().catch(() => {});
    // Si nextAudioRef ya la precargó, la caché HTTP la sirve al instante (sin hueco).
    audio.src = url;
    resetListen(song);
    startPlayback(genRef.current);
  }, [flushListen, clearPrefetch, timeStore, dispatch, setupNormalization, resetListen, startPlayback]);

  // Primera reproducción tras restaurar la sesión: el <audio> aún no tiene fuente.
  const ensureSource = useCallback(() => {
    const audio = audioRef.current;
    const song = stateRef.current.currentSong;
    if (!audio || !song) return false;
    if (audio.getAttribute('src')) return true;
    const url = playbackUrlFor(song);
    if (!url) return false;
    genRef.current += 1;
    audio.src = url;
    audio.load();
    resetListen(song);
    // Vuelve a la posición en la que se dejó antes de cerrar la app.
    const saved = safeGetJSON('spotify_current_pos', null);
    if (saved && saved.id === song.id && saved.t > 1) {
      audio.addEventListener('loadedmetadata', () => {
        const a = audioRef.current;
        if (a && saved.t < a.duration - 2) {
          a.currentTime = saved.t;
          listenRef.current.lastMediaTime = saved.t;
        }
      }, { once: true });
    }
    // La cola no se persiste: se reconstruye para que la reproducción continúe.
    dispatch({ type: T.REBUILD_AUTO_QUEUE, ...queueContext() });
    return true;
  }, [resetListen, dispatch, queueContext]);

  // Efectos de cada transición (se ejecutan justo después del dispatch, dentro
  // del mismo gesto del usuario: imprescindible para play() en iOS/Android).
  // useLayoutEffect: queda enlazado antes de que pueda llegar ningún evento.
  useLayoutEffect(() => {
    transitionRef.current = (prev, next, action) => {
      const report = aiReportFor(prev, next, action);
      if (report) {
        apiFetchRef.current(`/ai-recommendations/${report.recId}/${report.kind}`, { method: 'POST' }).catch(() => {});
      }
      const audio = audioRef.current;
      if (next.loadSeq !== prev.loadSeq) loadCurrent(next.currentSong);
      if (next.restartSeq !== prev.restartSeq && audio) {
        audio.currentTime = 0;
        resetListen(next.currentSong);
        audio.play().catch(() => {});
      }
      if (next.seek.seq !== prev.seek.seq && audio) {
        try { audio.currentTime = next.seek.time; } catch { /* sin metadatos aún */ }
        syncListenClock();
      }
      if (audio && (next.volume !== prev.volume || next.muted !== prev.muted || next.currentSong !== prev.currentSong)) {
        applyVolume();
      }
      if (action.type === T.PAUSE && audio) {
        audio.pause();
        keepAlive(false);
      } else if (action.type === T.PLAY && audio) {
        if (ensureSource()) {
          audio.play().catch((err) => {
            console.warn('play() rechazado:', err);
            dispatch({ type: T.AUDIO_STATE, playing: false });
          });
        } else {
          dispatch({ type: T.AUDIO_STATE, playing: false });
        }
      } else if (prev.isPlaying && !next.isPlaying && action.type === T.NEXT_TRACK) {
        keepAlive(false); // fin de la cola
      }
    };
  }, [apiFetchRef, loadCurrent, resetListen, syncListenClock, keepAlive, ensureSource, dispatch, applyVolume]);

  // ─── Acciones públicas (identidad estable) ─────────────────────────────────
  const togglePlay = useCallback(() => {
    const s = stateRef.current;
    if (!audioRef.current || !s.currentSong) return;
    dispatch({ type: s.isPlaying ? T.PAUSE : T.PLAY });
  }, [dispatch]);

  const next = useCallback((natural = false, { skipAiReport = false } = {}) => {
    // AUDIO-02: estrictamente true (antes llegaba el SyntheticEvent del botón).
    dispatch({
      type: T.NEXT_TRACK, natural: natural === true, skipAiReport, ...queueContext(),
      aiGap: randomInt(2, 4), aiGapAfterReshuffle: randomInt(1, 2),
    });
  }, [dispatch, queueContext]);

  const prev = useCallback(() => {
    dispatch({ type: T.PREV_TRACK, songs: songsRef.current || [], currentTime: audioRef.current ? audioRef.current.currentTime : 0 });
  }, [dispatch, songsRef]);

  const playSong = useCallback((song, { fromQueueIndex } = {}) => {
    if (!song) return;
    const s = stateRef.current;
    if (s.currentSong && s.currentSong.id === song.id && !Number.isInteger(fromQueueIndex)) { togglePlay(); return; }
    dispatch({ type: T.SET_TRACK, song, fromQueueIndex, ...queueContext() });
  }, [dispatch, togglePlay, queueContext]);

  const finishTrack = useCallback(() => {
    // Fin detectado por el watchdog: se contabiliza como completada.
    flushListen(true);
    next(true);
  }, [flushListen, next]);

  const actions = useMemo(() => ({
    playSong,
    playFromQueue: (index) => {
      const song = stateRef.current.queue[index];
      if (song) playSong(song, { fromQueueIndex: index });
    },
    togglePlay,
    play: () => dispatch({ type: T.PLAY }),
    pause: () => dispatch({ type: T.PAUSE }),
    next: () => next(false),
    prev,
    seek: (time) => dispatch({ type: T.SEEK_TO, time }),
    seekBy: (delta) => {
      const a = audioRef.current;
      if (!a) return;
      const max = Number.isFinite(a.duration) ? a.duration : a.currentTime + Math.max(0, delta);
      dispatch({ type: T.SEEK_TO, time: Math.min(Math.max(a.currentTime + delta, 0), max) });
    },
    setVolume: (volume) => dispatch({ type: T.SET_VOLUME, volume }),
    toggleMute: () => dispatch({ type: T.TOGGLE_MUTE }),
    toggleLoudnessNorm: () => setLoudnessNorm(v => !v),
    setShuffleMode: (mode) => dispatch({ type: T.SET_SHUFFLE_MODE, mode, ...queueContext() }),
    toggleShuffle: () => dispatch({ type: T.TOGGLE_SHUFFLE, ...queueContext() }),
    cycleRepeat: () => dispatch({ type: T.CYCLE_REPEAT }),
    enqueue: (song) => dispatch({ type: T.ENQUEUE, song }),
    playNext: (song) => dispatch({ type: T.ENQUEUE_NEXT, song }),
    removeFromQueue: (index) => dispatch({ type: T.REMOVE_FROM_QUEUE, index }),
    moveInQueue: (from, to) => dispatch({ type: T.MOVE_IN_QUEUE, from, to }),
    setAiQueue: (recs) => dispatch({ type: T.SET_AI_QUEUE, recs }),
    acceptAiRec: async () => {
      const rec = stateRef.current.currentAiRec;
      if (!rec) return { ok: false };
      const r = await apiFetchRef.current(`/ai-recommendations/${rec.rec_id}/accept`, { method: 'POST' });
      if (!r.ok) {
        const d = await r.json().catch(() => ({}));
        return { ok: false, error: d.error };
      }
      if (stateRef.current.currentAiRec?.rec_id === rec.rec_id) dispatch({ type: T.CLEAR_AI_REC });
      return { ok: true };
    },
    rejectAiRec: () => {
      const rec = stateRef.current.currentAiRec;
      if (!rec) return;
      apiFetchRef.current(`/ai-recommendations/${rec.rec_id}/reject`, { method: 'POST' }).catch(() => {});
      // Ya marcada como rechazada: "siguiente" no debe enviar además un "skip".
      next(false, { skipAiReport: true });
    },
    removeSong: (id) => {
      // La canción ya no existe en el servidor: no se informa su escucha parcial.
      if (listenRef.current.song && listenRef.current.song.id === id) listenRef.current.ms = 0;
      dispatch({ type: T.REMOVE_SONG, id });
    },
    // Tras recortar la canción que suena: el <audio> seguía pidiendo rangos de la
    // URL anterior sobre un archivo distinto; se recarga con la nueva revisión.
    updateSong: (song, { reloadAt = null } = {}) => {
      const isCurrent = stateRef.current.currentSong?.id === song.id;
      dispatch({ type: T.UPDATE_SONG, song });
      const a = audioRef.current;
      if (!isCurrent || reloadAt === null || !a) return;
      const updated = stateRef.current.currentSong;
      const url = playbackUrlFor(updated);
      if (!url) return;
      const wasPlaying = !a.paused;
      genRef.current += 1;
      a.src = url;
      a.addEventListener('loadedmetadata', () => {
        if (reloadAt < a.duration - 1) a.currentTime = Math.max(0, reloadAt);
        resetListen(updated);
      }, { once: true });
      if (wasPlaying) startPlayback(genRef.current);
    },
    reset: () => {
      // Logout: primero la última escucha (aún con sesión) y después se para todo.
      flushListen(false, { beacon: true });
      keepAlive(false);
      dispatch({ type: T.RESET });
    },
    flushListen,
    getState: () => stateRef.current,
    peekNext: () => peekNext(stateRef.current, songsRef.current || []),
  }), [playSong, togglePlay, dispatch, next, prev, queueContext, apiFetchRef, resetListen, startPlayback, flushListen, keepAlive, songsRef]);

  // ─── Manejadores del <audio> principal ─────────────────────────────────────
  const audioHandlers = useMemo(() => ({
    onTimeUpdate: () => {
      const audio = audioRef.current;
      if (!audio || !audio.duration) return;
      timeStore.set({ currentTime: audio.currentTime, duration: audio.duration });
      trackListenProgress(audio);
      const s = stateRef.current;
      // Posición persistida (con límite) para retomar tras un reinicio.
      const now = Date.now();
      if (s.currentSong && now - lastPosSaveRef.current > POSITION_SAVE_MS) {
        lastPosSaveRef.current = now;
        safeSetItem('spotify_current_pos', JSON.stringify({ id: s.currentSong.id, t: audio.currentTime }));
      }
      // Precarga cuando quedan ~20 s para que no haya hueco entre pistas.
      const remaining = audio.duration - audio.currentTime;
      if (remaining <= PREFETCH_REMAINING_S && remaining > 0 && prefetchedUrlRef.current === '') {
        const upcoming = peekNext(s, songsRef.current || []);
        if (upcoming) prefetch(upcoming);
      }
    },
    onLoadedMetadata: () => {
      const audio = audioRef.current;
      if (audio) timeStore.set({ duration: Number.isFinite(audio.duration) ? audio.duration : 0, currentTime: audio.currentTime });
    },
    onSeeked: syncListenClock,
    onPlay: () => {
      dispatch({ type: T.AUDIO_STATE, playing: true });
      syncListenClock();
      if (isAndroid()) keepAlive(true);
    },
    onPause: () => {
      const audio = audioRef.current;
      // Un final natural dispara 'pause' justo ANTES de 'ended': no es una pausa
      // del sistema (reanudarla reiniciaba la canción).
      if (!audio || audio.ended) return;
      if (!stateRef.current.isPlaying) {
        // Pausa del usuario.
        keepAlive(false);
        return;
      }
      // Pausa forzada por el sistema (MIUI, llamada, bloqueo...): reintentos.
      const pauseGen = genRef.current;
      const pausedAt = Date.now();
      let attempts = 0;
      const giveUp = () => {
        dispatch({ type: T.AUDIO_STATE, playing: false });
        keepAlive(false);
      };
      const tryResume = () => {
        const a = audioRef.current;
        if (genRef.current !== pauseGen || !stateRef.current.isPlaying || !a || !a.paused) return;
        // AUDIO-03: la salida de audio cambió (auriculares/Bluetooth) → respetar la pausa.
        if (Math.abs(lastDeviceChangeRef.current - pausedAt) < 3000) { giveUp(); return; }
        attempts += 1;
        a.play()
          .then(() => keepAlive(true))
          .catch((err) => {
            if (err.name === 'AbortError' && attempts < 5) setTimeout(tryResume, 300 * attempts);
            else if (err.name === 'NotAllowedError') giveUp();
            else if (attempts < 4) setTimeout(tryResume, 400 * attempts);
            else giveUp();
          });
      };
      // 600 ms: margen para que llegue 'devicechange' si lo hubo.
      setTimeout(tryResume, 600);
    },
    onEnded: () => {
      const audio = audioRef.current;
      if (audio) trackListenProgress(audio);
      flushListen(true); // terminada de forma natural
      next(true);
    },
  }), [timeStore, trackListenProgress, songsRef, prefetch, syncListenClock, dispatch, keepAlive, flushListen, next]);

  // ─── Efectos globales (se enlazan una vez) ─────────────────────────────────

  // Volumen inicial y reproducción en segundo plano.
  useEffect(() => {
    const audio = audioRef.current;
    if (audio) applyVolume();
    if ('audioSession' in navigator) {
      try { navigator.audioSession.type = 'playback'; } catch { /* no soportado */ }
    }
  }, [applyVolume]);

  // Igualado: al cambiar la preferencia o llegar mediciones nuevas de la biblioteca.
  useEffect(() => { safeSetItem('mp_loudness_norm', loudnessNorm ? '1' : '0'); }, [loudnessNorm]);
  useEffect(() => { applyVolume(); }, [loudnessNorm, songs, applyVolume]);

  // Keep-alive silencioso (Android): MIUI/HyperOS y OneUI matan las pestañas de
  // Chrome en segundo plano si no detectan medios activos.
  useEffect(() => {
    if (!isAndroid()) return undefined;
    const url = createSilentWavUrl();
    const k = new Audio(url);
    k.loop = true;
    k.volume = 0.001;
    keepAliveRef.current = k;
    return () => {
      k.pause();
      keepAliveRef.current = null;
      URL.revokeObjectURL(url);
    };
  }, []);

  // Al volver al primer plano: sincronizar la UI con el estado real del audio.
  useEffect(() => {
    const onVisibility = () => {
      if (document.visibilityState !== 'visible') return;
      const audio = audioRef.current;
      if (!audio) return;
      const intent = stateRef.current.isPlaying;
      if (intent && audio.paused && audio.getAttribute('src')) {
        setTimeout(() => {
          const a = audioRef.current;
          if (!a || !stateRef.current.isPlaying || !a.paused) return;
          a.play().then(() => {
            dispatch({ type: T.AUDIO_STATE, playing: true });
            if (isAndroid()) keepAlive(true);
          }).catch(() => {
            // MIUI exige un gesto del usuario: se muestra como pausado.
            dispatch({ type: T.AUDIO_STATE, playing: false });
          });
        }, 500);
      } else if (!intent && !audio.paused) {
        dispatch({ type: T.AUDIO_STATE, playing: true });
      }
    };
    document.addEventListener('visibilitychange', onVisibility);
    return () => document.removeEventListener('visibilitychange', onVisibility);
  }, [dispatch, keepAlive]);

  // Watchdog de fin de pista + recuperación de 'stalled'/'waiting'.
  useEffect(() => {
    const audio = audioRef.current;
    if (!audio) return undefined;
    const wd = watchdogRef.current;
    const stop = () => {
      if (wd.timer) { clearInterval(wd.timer); wd.timer = null; }
      wd.stallCount = 0;
    };
    const onStalled = () => {
      if (!stateRef.current.isPlaying) return;
      const t = audio.currentTime;
      if (!Number.isNaN(audio.duration) && t < audio.duration - 1) {
        setTimeout(() => {
          if (audio.paused && stateRef.current.isPlaying) {
            audio.currentTime = t + 0.01; // pequeño seek que desbloquea el buffer
            audio.play().catch(() => {});
          }
        }, 1500);
      }
    };
    const start = () => {
      stop();
      wd.timer = setInterval(() => {
        const a = audioRef.current;
        if (!a) return;
        // Pausa del usuario: nada que vigilar (se reactiva en el próximo 'play').
        if (a.paused && !stateRef.current.isPlaying) { stop(); return; }
        if (!a.duration || Number.isNaN(a.duration)) return;
        if (!a.paused && !a.ended) {
          wd.lastKnownTime = a.currentTime;
          wd.stallCount = 0;
          return;
        }
        if (a.ended) {
          // ended=true pero onEnded no llegó.
          stop();
          finishTrack();
          return;
        }
        if (a.paused && stateRef.current.isPlaying) {
          // Pausa del sistema congelada cerca del final (suspensión en segundo plano).
          const remaining = a.duration - a.currentTime;
          if (remaining <= 1.0 && a.currentTime === wd.lastKnownTime) {
            wd.stallCount += 1;
            if (wd.stallCount >= 3) { wd.stallCount = 0; finishTrack(); }
          } else {
            wd.stallCount = 0;
            wd.lastKnownTime = a.currentTime;
          }
        }
      }, 500);
    };
    audio.addEventListener('stalled', onStalled);
    audio.addEventListener('waiting', onStalled);
    audio.addEventListener('play', start);
    audio.addEventListener('ended', stop);
    return () => {
      stop();
      audio.removeEventListener('stalled', onStalled);
      audio.removeEventListener('waiting', onStalled);
      audio.removeEventListener('play', start);
      audio.removeEventListener('ended', stop);
    };
  }, [finishTrack]);

  // Cambios de salida de audio (auriculares desconectados, Bluetooth...).
  useEffect(() => {
    const md = navigator.mediaDevices;
    if (!md || typeof md.addEventListener !== 'function') return undefined;
    const onDeviceChange = () => { lastDeviceChangeRef.current = Date.now(); };
    md.addEventListener('devicechange', onDeviceChange);
    return () => md.removeEventListener('devicechange', onDeviceChange);
  }, []);

  // Último tramo de escucha al cerrar/ocultar definitivamente la página.
  useEffect(() => {
    const onPageHide = () => flushListen(false, { beacon: true });
    window.addEventListener('pagehide', onPageHide);
    return () => window.removeEventListener('pagehide', onPageHide);
  }, [flushListen]);

  // Atajos de teclado.
  useEffect(() => {
    const onKey = (e) => {
      const t = e.target;
      const tag = t && t.tagName;
      if (tag === 'INPUT' || tag === 'TEXTAREA' || tag === 'SELECT' || (t && t.isContentEditable)) return;
      if (e.ctrlKey || e.metaKey || e.altKey) return;
      // Espacio sobre un botón/enlace enfocado ya lo activa el navegador: si
      // además se alternase la reproducción, el clic y el atajo se anularían.
      if (e.code === 'Space' && t && t.closest && t.closest('button, a, [role="button"], [role="menuitem"], [role="slider"], [role="tab"], [role="radio"]')) return;
      const a = audioRef.current;
      switch (e.code) {
        case 'Space': e.preventDefault(); togglePlay(); break;
        case 'ArrowRight': e.preventDefault(); next(false); break;
        case 'ArrowLeft': e.preventDefault(); prev(); break;
        case 'ArrowUp': e.preventDefault(); dispatch({ type: T.SET_VOLUME, volume: stateRef.current.volume + 0.1 }); break;
        case 'ArrowDown': e.preventDefault(); dispatch({ type: T.SET_VOLUME, volume: stateRef.current.volume - 0.1 }); break;
        case 'KeyM': if (a) dispatch({ type: T.TOGGLE_MUTE }); break;
        case 'KeyS': dispatch({ type: T.TOGGLE_SHUFFLE, ...queueContext() }); break;
        default: break;
      }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [togglePlay, next, prev, dispatch, queueContext]);

  // MediaSession: metadatos y controles de la pantalla de bloqueo.
  const currentSong = state.currentSong;
  useEffect(() => {
    if (!('mediaSession' in navigator) || !currentSong) return undefined;
    const setHandler = (action, handler) => {
      try { navigator.mediaSession.setActionHandler(action, handler); } catch { /* no soportada */ }
    };
    const updatePositionState = () => {
      const a = audioRef.current;
      if ('setPositionState' in navigator.mediaSession && a && a.duration && Number.isFinite(a.duration)) {
        try {
          navigator.mediaSession.setPositionState({ duration: a.duration, playbackRate: a.playbackRate, position: Math.min(a.currentTime, a.duration) });
        } catch { /* valores fuera de rango */ }
      }
    };
    try {
      const cover = currentSong.cover_url;
      const artworkUrl = cover ? (cover.startsWith('http') ? cover : window.location.origin + cover) : null;
      navigator.mediaSession.metadata = new window.MediaMetadata({
        title: currentSong.title,
        artist: currentSong.artist,
        album: currentSong.album || 'Biblioteca Privada',
        artwork: artworkUrl ? [96, 128, 192, 256, 384, 512].map(n => ({ src: artworkUrl, sizes: `${n}x${n}`, type: 'image/jpeg' })) : [],
      });
    } catch (e) {
      console.warn('No se pudo actualizar MediaSession:', e);
    }
    setHandler('play', () => { if (!stateRef.current.isPlaying) togglePlay(); });
    setHandler('pause', () => { if (stateRef.current.isPlaying) togglePlay(); });
    setHandler('previoustrack', () => prev());
    setHandler('nexttrack', () => next(false));
    setHandler('seekbackward', (d) => { actions.seekBy(-(d.seekOffset || 10)); updatePositionState(); });
    setHandler('seekforward', (d) => { actions.seekBy(d.seekOffset || 10); updatePositionState(); });
    setHandler('seekto', (d) => {
      const a = audioRef.current;
      if (!a) return;
      if (d.fastSeek && 'fastSeek' in a) a.fastSeek(d.seekTime);
      else dispatch({ type: T.SEEK_TO, time: d.seekTime });
      updatePositionState();
    });
    updatePositionState();
    return () => {
      ['play', 'pause', 'previoustrack', 'nexttrack', 'seekbackward', 'seekforward', 'seekto'].forEach(a => setHandler(a, null));
    };
  }, [currentSong, togglePlay, prev, next, dispatch, actions]);

  const isPlaying = state.isPlaying;
  useEffect(() => {
    if ('mediaSession' in navigator) navigator.mediaSession.playbackState = isPlaying ? 'playing' : 'paused';
  }, [isPlaying]);

  // Preferencias persistidas.
  useEffect(() => { safeSetItem('spotify_repeat_mode', state.repeatMode); }, [state.repeatMode]);
  useEffect(() => { safeSetItem('spotify_shuffle_mode', state.shuffleMode); }, [state.shuffleMode]);
  useEffect(() => { if (currentSong) safeSetItem('spotify_current_song', JSON.stringify(currentSong)); }, [currentSong]);

  // Limpieza al desmontar.
  useEffect(() => () => {
    const ctx = audioCtxRef.current;
    if (ctx && typeof ctx.close === 'function') ctx.close().catch(() => {});
  }, []);

  return { state, actions, audioRef, nextAudioRef, audioHandlers, timeStore, loudnessNorm };
}
