import { useCallback, useEffect, useRef } from 'react';

function fadeVolume(audio, from, to, ms) {
  return new Promise(resolve => {
    if (!audio) { resolve(); return; }
    if (audio._fadeTimer) clearInterval(audio._fadeTimer);
    const steps = 20;
    const interval = ms / steps;
    const delta = (to - from) / steps;
    let step = 0;
    audio._fadeTimer = setInterval(() => {
      step++;
      const nextVol = from + delta * step;
      audio.volume = Math.max(0, Math.min(1, nextVol));
      if (step >= steps) {
        clearInterval(audio._fadeTimer);
        audio._fadeTimer = null;
        resolve();
      }
    }, interval);
  });
}

const MAX_PREFETCH = 4;
const absolute = (url) => new URL(url, window.location.href).href;

export function useWrappedAudio(audioRef) {
  const currentPlayPromise = useRef(null);
  // Elementos de precarga acotados y liberados (antes se creaba un Audio nuevo
  // por URL en cada diapositiva y nunca se liberaba).
  const prefetchPool = useRef(new Map());

  const releasePrefetch = (url) => {
    const a = prefetchPool.current.get(url);
    if (a) {
      try { a.removeAttribute('src'); a.load(); } catch { /* ya liberado */ }
      prefetchPool.current.delete(url);
    }
  };

  const fadeAndPlay = useCallback(async (url, startSec = 0, volumeTarget = 0.5) => {
    if (!audioRef.current || !url) return;
    const audio = audioRef.current;

    // 1. Fade out current audio if it's playing
    if (!audio.paused && audio.src) {
      await fadeVolume(audio, audio.volume, 0, 400);
      try { audio.pause(); } catch { /* ignorar */ }
    }

    // 2. Load new URL (audio.src es absoluta: se compara normalizada)
    if (audio.src !== absolute(url)) {
      audio.src = url;
    }
    try { audio.currentTime = startSec; } catch { /* metadatos aún no cargados */ }

    // 3. Play and fade in
    audio.volume = 0;
    try {
      const playPromise = audio.play();
      if (playPromise !== undefined) {
        currentPlayPromise.current = playPromise;
        await playPromise;
      }
      fadeVolume(audio, 0, volumeTarget, 600);
    } catch (e) {
      if (e.name !== 'AbortError') {
        console.warn('[WrappedAudio] Autoplay prevented or error', e);
      }
    }
  }, [audioRef]);

  const prefetch = useCallback((urls) => {
    const wanted = new Set(urls.filter(Boolean));
    for (const url of [...prefetchPool.current.keys()]) {
      if (!wanted.has(url)) releasePrefetch(url);
    }
    for (const url of wanted) {
      if (prefetchPool.current.has(url) || prefetchPool.current.size >= MAX_PREFETCH) continue;
      const a = new Audio();
      a.preload = 'metadata'; // Range request para cabeceras y primeros bytes
      a.src = url;
      prefetchPool.current.set(url, a);
    }
  }, []);

  const stop = useCallback(async () => {
    if (!audioRef.current) return;
    const audio = audioRef.current;
    if (!audio.paused) {
      await fadeVolume(audio, audio.volume, 0, 600);
      try { audio.pause(); } catch { /* ignorar */ }
    }
  }, [audioRef]);

  // Limpieza al cerrar el Resumen: temporizadores de fundido y precargas.
  useEffect(() => {
    const pool = prefetchPool.current;
    const audioEl = audioRef.current;
    return () => {
      if (audioEl && audioEl._fadeTimer) clearInterval(audioEl._fadeTimer);
      for (const a of pool.values()) {
        try { a.removeAttribute('src'); a.load(); } catch { /* ignorar */ }
      }
      pool.clear();
    };
  }, [audioRef]);

  return { fadeAndPlay, prefetch, stop, fadeVolume };
}
