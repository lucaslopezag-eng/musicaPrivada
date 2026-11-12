import { useSyncExternalStore } from 'react';

// ─── Tiempo de reproducción como store externo ───────────────────────────────
// `timeupdate` llega ~4 veces por segundo. Antes cada evento hacía setState en
// App y re-renderizaba toda la aplicación; ahora solo se suscriben los
// componentes que muestran el tiempo (barra de progreso, letras).

export function createTimeStore() {
  let snapshot = { currentTime: 0, duration: 0 };
  const listeners = new Set();
  return {
    get: () => snapshot,
    set(patch) {
      const next = { ...snapshot, ...patch };
      if (next.currentTime === snapshot.currentTime && next.duration === snapshot.duration) return;
      snapshot = next;
      listeners.forEach(l => l());
    },
    subscribe(listener) {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
  };
}

// selector(snapshot) → valor derivado; el componente solo se re-renderiza
// cuando ese valor cambia (p. ej. el índice de la línea de letra activa).
export function usePlaybackTime(store, selector = (s) => s) {
  return useSyncExternalStore(store.subscribe, () => selector(store.get()), () => selector(store.get()));
}
