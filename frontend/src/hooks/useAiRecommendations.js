import { useCallback, useEffect, useRef } from 'react';
import { useLatestRef } from './useLatestRef.js';

// ─── useAiRecommendations (FASE 2) ───────────────────────────────────────────
// Modo IA (UI-02): una sola petición en vuelo, un único sondeo activo (se
// limpia al salir del modo IA o al desmontar) y el servidor rechaza
// generaciones duplicadas con 409. Cuando la cola de recomendaciones se agota
// se pide una tanda nueva.

const POLL_MS = 15000;
const POLL_TIMEOUT_MS = 5 * 60 * 1000;

export function useAiRecommendations({ enabled, token, apiFetch, addToast, queueEmpty, onRecs }) {
  const pollRef = useRef(null);
  const inFlightRef = useRef(false);
  const onRecsRef = useLatestRef(onRecs);
  const addToastRef = useLatestRef(addToast);

  const stopPolling = useCallback(() => {
    if (pollRef.current) { clearInterval(pollRef.current); pollRef.current = null; }
  }, []);

  const fetchRecs = useCallback(async () => {
    if (inFlightRef.current) return;
    inFlightRef.current = true;
    try {
      const r = await apiFetch('/ai-recommendations');
      const data = await r.json().catch(() => null);
      if (!r.ok || !Array.isArray(data)) return;
      onRecsRef.current(data);
      if (data.length > 0 || pollRef.current) return;
      const gen = await apiFetch('/ai-recommendations/generate', { method: 'POST' });
      if (gen.ok) addToastRef.current('Generando recomendaciones IA… puede tardar unos minutos', 'info');
      else if (gen.status !== 409) return;
      const startedAt = Date.now();
      pollRef.current = setInterval(async () => {
        if (Date.now() - startedAt > POLL_TIMEOUT_MS) { stopPolling(); return; }
        try {
          const r2 = await apiFetch('/ai-recommendations');
          const d2 = await r2.json().catch(() => null);
          if (r2.ok && Array.isArray(d2) && d2.length > 0) {
            onRecsRef.current(d2);
            addToastRef.current(`✅ ${d2.length} recomendaciones IA listas`, 'success');
            stopPolling();
          }
        } catch { stopPolling(); }
      }, POLL_MS);
    } catch {
      /* sin red */
    } finally {
      inFlightRef.current = false;
    }
  }, [apiFetch, onRecsRef, addToastRef, stopPolling]);

  useEffect(() => {
    if (enabled && token && queueEmpty) fetchRecs();
  }, [enabled, token, queueEmpty, fetchRecs]);

  useEffect(() => {
    if (!enabled || !token) stopPolling();
    return stopPolling;
  }, [enabled, token, stopPolling]);

  return { refresh: fetchRecs, stopPolling };
}
