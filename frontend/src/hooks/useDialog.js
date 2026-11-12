import { useCallback, useState } from 'react';

// Diálogos asíncronos: const nombre = await askDialog({ type: 'prompt', ... })
// (UI-04: sustituyen a prompt()/confirm(), que bloquean el hilo principal).
export function useDialog() {
  const [dialog, setDialog] = useState(null);
  const askDialog = useCallback((options) => new Promise((resolve) => setDialog({ ...options, resolve })), []);
  const closeDialog = useCallback((result) => {
    setDialog(d => { d?.resolve(result); return null; });
  }, []);
  return { dialog, askDialog, closeDialog };
}
