import { useCallback, useEffect, useRef, useState } from 'react';

// ─── useBackground ───────────────────────────────────────────────────────────
// Fondo de pantalla propio del usuario (servidor: routes/background.js).
// · La imagen se reduce en el navegador antes de subirla (lado mayor ≤ 2560 px,
//   JPEG) para que las fotos del móvil no pesen 10 MB.
// · La opacidad se aplica al instante mientras se arrastra el control y se
//   guarda en el servidor cuando el usuario deja de moverlo.

const MAX_SIDE = 2560;
const SAVE_DELAY_MS = 500;

async function shrinkImage(file) {
  const url = URL.createObjectURL(file);
  try {
    const img = await new Promise((resolve, reject) => {
      const el = new Image();
      el.onload = () => resolve(el);
      el.onerror = () => reject(new Error('No se pudo leer la imagen'));
      el.src = url;
    });
    const scale = Math.min(1, MAX_SIDE / Math.max(img.naturalWidth, img.naturalHeight));
    const canvas = document.createElement('canvas');
    canvas.width = Math.max(1, Math.round(img.naturalWidth * scale));
    canvas.height = Math.max(1, Math.round(img.naturalHeight * scale));
    canvas.getContext('2d').drawImage(img, 0, 0, canvas.width, canvas.height);
    const blob = await new Promise(resolve => canvas.toBlob(resolve, 'image/jpeg', 0.85));
    if (!blob) throw new Error('No se pudo procesar la imagen');
    return blob;
  } finally {
    URL.revokeObjectURL(url);
  }
}

export function useBackground({ background, setBackground, apiFetch, addToast }) {
  const [opacity, setOpacityState] = useState(background?.opacity ?? 60);
  const [busy, setBusy] = useState(false);
  const saveTimer = useRef(null);

  // Valor del servidor (login / sesión restaurada) → control deslizante.
  useEffect(() => {
    if (background) setOpacityState(background.opacity);
  }, [background]);

  useEffect(() => () => clearTimeout(saveTimer.current), []);

  const upload = useCallback(async (file) => {
    if (!file) return;
    if (!file.type.startsWith('image/')) { addToast('Elige un archivo de imagen', 'error'); return; }
    setBusy(true);
    try {
      const blob = await shrinkImage(file);
      const res = await apiFetch('/background', { method: 'PUT', headers: { 'Content-Type': 'image/jpeg' }, body: blob });
      const d = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error(d.error || 'No se pudo subir el fondo');
      setBackground(d.background);
      addToast('Fondo actualizado', 'success');
    } catch (err) {
      addToast(err.message || 'No se pudo subir el fondo', 'error');
    } finally {
      setBusy(false);
    }
  }, [apiFetch, setBackground, addToast]);

  const remove = useCallback(async () => {
    setBusy(true);
    try {
      const res = await apiFetch('/background', { method: 'DELETE' });
      const d = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error(d.error || 'No se pudo quitar el fondo');
      setBackground(d.background);
    } catch (err) {
      addToast(err.message || 'No se pudo quitar el fondo', 'error');
    } finally {
      setBusy(false);
    }
  }, [apiFetch, setBackground, addToast]);

  const setOpacity = useCallback((value) => {
    const v = Math.max(0, Math.min(100, Math.round(Number(value))));
    setOpacityState(v);
    clearTimeout(saveTimer.current);
    saveTimer.current = setTimeout(async () => {
      try {
        const res = await apiFetch('/background', { method: 'PATCH', body: JSON.stringify({ opacity: v }) });
        if (!res.ok) throw new Error();
      } catch {
        addToast('No se pudo guardar la transparencia', 'error');
      }
    }, SAVE_DELAY_MS);
  }, [apiFetch, addToast]);

  return { url: background?.url || null, opacity, busy, upload, remove, setOpacity };
}
