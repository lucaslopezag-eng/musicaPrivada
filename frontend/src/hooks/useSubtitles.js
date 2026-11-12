import { useEffect, useState } from 'react';
import { parseVtt, subtitlesUrlFor } from '../lib/media.js';

// ─── useSubtitles (FASE 2) ───────────────────────────────────────────────────
// Letras sincronizadas WebVTT de la canción actual (UI-03):
// · AbortController: una respuesta tardía de la canción anterior nunca
//   sobrescribe las letras de la actual.
// · 404 = el servidor la ha puesto en cola de Whisper → estado "queued" y se
//   sigue preguntando (10 s, 20 s, 40 s… hasta 1 min) mientras la vista esté
//   abierta: la letra aparece sola cuando termina la transcripción.
// · Cada intento tiene un tiempo máximo: una petición colgada (iOS al volver
//   de segundo plano, SW recién actualizado) ya no deja "Cargando letras"
//   para siempre. Un AbortError que no hemos provocado cuenta como fallo.
// · Al volver a la app se reintenta al momento si aún no hay letra.
// · Se identifica la canción por id (y revisión): un objeto nuevo con el
//   mismo id no recarga.
// La línea activa la calcula quien pinta (LyricsView) a partir del tiempo.

const ATTEMPT_TIMEOUT_MS = 20000;
const MAX_QUEUED_ATTEMPTS = 60; // ~1 h preguntando cada minuto como mucho
const MAX_ERROR_ATTEMPTS = 6;
const retryDelay = (attempt) => Math.min(60000, 10000 * 2 ** Math.max(0, attempt - 1));

export function findActiveCue(cues, time) {
  // Búsqueda binaria: las cues de un VTT vienen ordenadas por inicio.
  let lo = 0;
  let hi = cues.length - 1;
  let found = -1;
  while (lo <= hi) {
    const mid = (lo + hi) >> 1;
    if (cues[mid].start <= time) { found = mid; lo = mid + 1; } else hi = mid - 1;
  }
  if (found === -1) return -1;
  // Varias cues pueden solaparse: se busca hacia atrás la que contiene `time`.
  for (let i = found; i >= 0 && i >= found - 3; i--) {
    if (time >= cues[i].start && time <= cues[i].end) return i;
  }
  return -1;
}

export function useSubtitles({ song, enabled, token }) {
  const [result, setResult] = useState({ key: null, cues: [], status: 'idle' });
  const songId = song ? song.id : null;
  const rev = song ? song.rev ?? 0 : 0;
  const url = songId != null ? subtitlesUrlFor({ id: songId, rev }) : null;
  const key = enabled && token && url ? `${songId}:${rev}` : null;

  useEffect(() => {
    if (!key) return undefined;
    const controller = new AbortController();
    let queuedAttempts = 0;
    let errorAttempts = 0;
    let retryTimer = null;
    let inFlight = false;
    let done = false;

    const schedule = (delay) => {
      if (retryTimer) clearTimeout(retryTimer);
      retryTimer = setTimeout(load, delay);
    };

    async function load() {
      if (controller.signal.aborted || inFlight || done) return;
      retryTimer = null;
      inFlight = true;
      const attempt = new AbortController();
      const onAbort = () => attempt.abort();
      controller.signal.addEventListener('abort', onAbort);
      const timeout = setTimeout(() => attempt.abort(), ATTEMPT_TIMEOUT_MS);
      let status = 'error';
      try {
        const res = await fetch(url, { headers: { Authorization: `Bearer ${token}` }, signal: attempt.signal });
        if (res.ok) {
          const cues = parseVtt(await res.text());
          if (controller.signal.aborted) return;
          done = true;
          setResult({ key, cues, status: cues.length > 0 ? 'ready' : 'not_found' });
          return;
        }
        if (res.status === 404) {
          const body = await res.json().catch(() => ({}));
          status = body && body.queued ? 'queued' : 'not_found';
        }
      } catch {
        // Red caída, tiempo agotado o AbortError ajeno: se reintenta.
      } finally {
        clearTimeout(timeout);
        controller.signal.removeEventListener('abort', onAbort);
        inFlight = false;
      }
      if (controller.signal.aborted) return;
      setResult({ key, cues: [], status });
      if (status === 'queued' && ++queuedAttempts < MAX_QUEUED_ATTEMPTS) schedule(retryDelay(queuedAttempts));
      else if (status === 'error' && ++errorAttempts < MAX_ERROR_ATTEMPTS) schedule(retryDelay(errorAttempts));
    }

    const onVisible = () => {
      if (document.visibilityState === 'visible' && !done) schedule(0);
    };
    document.addEventListener('visibilitychange', onVisible);
    load();
    return () => {
      controller.abort();
      if (retryTimer) clearTimeout(retryTimer);
      document.removeEventListener('visibilitychange', onVisible);
    };
  }, [key, url, token]);

  // Resultado de otra canción (o desactivado) → nada que mostrar. Sin URL
  // posible (datos de demostración) no hay letras.
  if (enabled && token && songId != null && !url) return { cues: [], status: 'not_found' };
  if (!key) return { cues: [], status: 'idle' };
  if (result.key !== key) return { cues: [], status: 'loading' };
  return { cues: result.cues, status: result.status };
}
