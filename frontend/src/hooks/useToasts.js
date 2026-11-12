import { useCallback, useEffect, useRef, useState } from 'react';
import { uid } from '../lib/media.js';

export function useToasts(durationMs = 3000) {
  const [toasts, setToasts] = useState([]);
  const timers = useRef(new Set());
  useEffect(() => {
    const pending = timers.current;
    return () => { pending.forEach(clearTimeout); pending.clear(); };
  }, []);
  const addToast = useCallback((message, type = 'success') => {
    const id = uid();
    setToasts(p => [...p, { id, message, type }]);
    const timer = setTimeout(() => {
      timers.current.delete(timer);
      setToasts(p => p.filter(t => t.id !== id));
    }, durationMs);
    timers.current.add(timer);
  }, [durationMs]);
  return { toasts, addToast };
}
