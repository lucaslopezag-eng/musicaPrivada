import { useCallback, useEffect, useRef } from 'react';
import { useLatestRef } from './useLatestRef.js';

// ─── useAiRecommendations (FASE 2) ───────────────────────────────────────────
// Modo IA (UI-02): una sola petición en vuelo, un único sondeo activo (se
// limpia al salir del modo IA o al desmontar) y el servidor rechaza
// generaciones duplicadas con 409. Se pide una tanda nueva cuando quedan pocas
// recomendaciones (LOW_WATER o menos), no solo cuando se agotan, y como mucho
// una vez cada GENERATE_COOLDOWN_MS: la cuota gratuita de Gemini es de 20
// peticiones al día y la comparte la clasificación de géneros.
// Los avisos (toast) solo salen si la cola estaba vacía.

const POLL_MS = 15000;
const POLL_TIMEOUT_MS = 5 * 60 * 1000;
const LOW_WATER = 3;
const GENERATE_COOLDOWN_MS = 10 * 60 * 1000;
const LAST_GENERATE_KEY = 'mp_ai_last_generate';

// localStorage puede fallar o estar vacío: solo es una comodidad por navegador.
function readLastGenerate() {
  try { return Number(localStorage.getItem(LAST_GENERATE_KEY)) || 0; } catch { return 0; }
}
function writeLastGenerate(ts) {
  try { localStorage.setItem(LAST_GENERATE_KEY, String(ts)); } catch { /* sin almacenamiento */ }
}

export function useAiRecommendations({ enabled, token, apiFetch, addToast, queueSize, onRecs }) {
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
      if (data.length > LOW_WATER || pollRef.current) return;
      if (Date.now() - readLastGenerate() < GENERATE_COOLDOWN_MS) return;
      const baseline = data.length;
      const gen = await apiFetch('/ai-recommendations/generate', { method: 'POST' });
      if (gen.ok) {
        writeLastGenerate(Date.now());
        if (baseline === 0) addToastRef.current('Generando recomendaciones IA… puede tardar unos minutos', 'info');
      } else if (gen.status === 409) {
        writeLastGenerate(Date.now()); // ya hay una generación en curso
      } else return;
      const startedAt = Date.now();
      pollRef.current = setInterval(async () => {
        if (Date.now() - startedAt > POLL_TIMEOUT_MS) { stopPolling(); return; }
        try {
          const r2 = await apiFetch('/ai-recommendations');
          const d2 = await r2.json().catch(() => null);
          if (r2.ok && Array.isArray(d2) && d2.length > baseline) {
            onRecsRef.current(d2);
            if (baseline === 0) addToastRef.current(`✅ ${d2.length} recomendaciones IA listas`, 'success');
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
    if (enabled && token && queueSize <= LOW_WATER) fetchRecs();
  }, [enabled, token, queueSize, fetchRecs]);

  useEffect(() => {
    if (!enabled || !token) stopPolling();
    return stopPolling;
  }, [enabled, token, stopPolling]);

  return { refresh: fetchRecs, stopPolling };
}
