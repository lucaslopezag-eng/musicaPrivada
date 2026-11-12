// ─── URLs de medios y utilidades compartidas ────────────────────────────────
// Un único sitio construye las URLs de audio/subtítulos (antes había cuatro
// copias con variantes, una de ellas con "?token=" y otra sin token).

export const API_BASE = '/api';

export function isAiSong(song) {
  return typeof song?.id === 'string' && song.id.startsWith('ai-');
}

function aiRecId(song) {
  const raw = song.rec_id ?? String(song.id).slice(3);
  const n = Number(raw);
  return Number.isSafeInteger(n) && n > 0 ? n : null;
}

// Audio: se autentica con la cookie HttpOnly de sesión (no hay token en la URL).
// Las canciones de la biblioteca llevan ?v=<rev> para que la caché nunca sirva
// una versión anterior tras recortar o sustituir.
export function streamUrlFor(song) {
  if (!song) return null;
  if (isAiSong(song)) {
    const id = aiRecId(song);
    return id ? `${API_BASE}/stream/ai/${id}` : null;
  }
  const id = Number(song.id);
  if (!Number.isSafeInteger(id) || id <= 0) return null; // p. ej. datos demo (ids negativos)
  return `${API_BASE}/stream/${id}?v=${encodeURIComponent(song.rev ?? 0)}`;
}

export function subtitlesUrlFor(song) {
  if (!song) return null;
  if (isAiSong(song)) {
    const id = aiRecId(song);
    return id ? `${API_BASE}/subtitles/ai/${id}` : null;
  }
  const id = Number(song.id);
  return Number.isSafeInteger(id) && id > 0 ? `${API_BASE}/subtitles/${id}` : null;
}

// Parser WebVTT mínimo (cabecera, cues y texto multilínea).
export function parseVtt(text) {
  const lines = String(text || '').replace(/\r\n/g, '\n').split('\n');
  const parseTime = (tStr) => {
    const [hms, ms = '0'] = tStr.trim().split(/[.,]/);
    const parts = hms.split(':');
    const [h, m, s] = parts.length === 3 ? parts : ['0', ...parts];
    return Number(h || 0) * 3600 + Number(m || 0) * 60 + Number(s || 0) + Number(ms.padEnd(3, '0').slice(0, 3)) / 1000;
  };
  const cues = [];
  let i = 0;
  while (i < lines.length) {
    const line = lines[i].trim();
    if (line.includes('-->')) {
      const [left, right] = line.split('-->');
      const start = parseTime(left);
      const end = parseTime(right.trim().split(/\s+/)[0]);
      let text = '';
      i += 1;
      while (i < lines.length && lines[i].trim() !== '') {
        text += `${lines[i].trim()}\n`;
        i += 1;
      }
      if (Number.isFinite(start) && Number.isFinite(end)) cues.push({ start, end, text: text.trim() });
    } else {
      i += 1;
    }
  }
  return cues;
}

// Identificador único para toasts y claves (UI-04: Date.now() colisionaba).
export function uid() {
  try {
    if (typeof crypto !== 'undefined' && crypto.randomUUID) return crypto.randomUUID();
  } catch { /* contexto no seguro */ }
  return `${Date.now().toString(36)}-${Math.random().toString(36).slice(2)}`;
}
