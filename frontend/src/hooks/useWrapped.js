import { useCallback, useState } from 'react';

// Estadísticas del Resumen (Wrapped v2) por año.
export function useWrapped({ apiFetch, token }) {
  const [year, setYear] = useState('all');
  const [data, setData] = useState(null);
  const [loading, setLoading] = useState(false);

  const load = useCallback(async (y = year) => {
    if (!token) return;
    setYear(y);
    setLoading(true);
    try {
      const r = await apiFetch(`/stats/wrapped-v2?year=${encodeURIComponent(y)}`);
      const d = await r.json();
      if (r.ok) setData(d);
    } catch { /* sin red */ }
    setLoading(false);
  }, [apiFetch, token, year]);

  const reset = useCallback(() => { setData(null); setYear('all'); }, []);
  return { year, data, loading, load, reset };
}
