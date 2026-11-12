// ─── Acceso defensivo a localStorage (UI-04) ────────────────────────────────
// En modo privado, con almacenamiento bloqueado o con la cuota llena,
// localStorage lanza excepciones que antes rompían el renderizado.

export const safeGetItem = (key, defaultValue = null) => {
  try {
    const value = localStorage.getItem(key);
    return value === null ? defaultValue : value;
  } catch {
    return defaultValue;
  }
};

export const safeSetItem = (key, value) => {
  try {
    localStorage.setItem(key, value);
  } catch (e) {
    console.warn('localStorage.setItem falló', e);
  }
};

export const safeRemoveItem = (key) => {
  try {
    localStorage.removeItem(key);
  } catch (e) {
    console.warn('localStorage.removeItem falló', e);
  }
};

export const safeGetJSON = (key, defaultValue = null) => {
  const raw = safeGetItem(key);
  if (raw === null) return defaultValue;
  try {
    return JSON.parse(raw);
  } catch {
    return defaultValue;
  }
};
