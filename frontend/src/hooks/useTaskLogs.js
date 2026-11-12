import { useCallback, useEffect, useState } from 'react';

// Log de importaciones/descargas: sistema completo para admins, progreso de
// las tareas propias para el resto (AUTH-06). Sondeo cada 10 s mientras se ve.
export function useTaskLogs({ apiFetch, token, visible }) {
  const [logs, setLogs] = useState('');
  const refresh = useCallback(async () => {
    if (!token) return;
    try {
      const r = await apiFetch('/logs');
      if (!r.ok) return;
      const d = await r.json();
      setLogs(d.logs || '');
    } catch { /* sin red */ }
  }, [apiFetch, token]);

  useEffect(() => {
    if (!visible) return undefined;
    refresh();
    const id = setInterval(refresh, 10000);
    return () => clearInterval(id);
  }, [visible, refresh]);

  return { logs, refresh };
}
