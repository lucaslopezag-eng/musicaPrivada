// Formateo de tiempos y textos compartido por los componentes.

export function formatSeconds(t) {
  if (!t || Number.isNaN(t) || !Number.isFinite(t)) return '0:00';
  return `${Math.floor(t / 60)}:${Math.floor(t % 60).toString().padStart(2, '0')}`;
}

// Duración almacenada en ms (o en s si es pequeña, datos heredados).
export function formatDurationMs(ms) {
  if (!ms) return '';
  if (typeof ms === 'string') return ms;
  const num = Number(ms);
  if (Number.isNaN(num) || num <= 0) return '';
  const totalSecs = num > 1000 ? Math.round(num / 1000) : Math.round(num);
  const mins = Math.floor(totalSecs / 60);
  const secs = totalSecs % 60;
  if (mins >= 60) {
    const hrs = Math.floor(mins / 60);
    return `${hrs}:${String(mins % 60).padStart(2, '0')}:${String(secs).padStart(2, '0')}`;
  }
  return `${mins}:${String(secs).padStart(2, '0')}`;
}

// m:ss.d para el editor de recorte.
export function formatTrimTime(t) {
  const m = Math.floor(t / 60);
  const s = Math.floor(t % 60).toString().padStart(2, '0');
  const ds = Math.floor((t % 1) * 10);
  return `${m}:${s}.${ds}`;
}

export function getDynamicGreeting(date = new Date()) {
  const h = date.getHours();
  if (h >= 5 && h < 12) return 'Buenos días';
  if (h >= 12 && h < 20) return 'Buenas tardes';
  return 'Buenas noches';
}

// Parte las letras en versos de ≤ 38 caracteres para la vista de letras.
export function formatVerses(text) {
  if (!text || typeof text !== 'string') return '';
  const formatted = text.replace(/([a-z,])\s+([A-Z¿¡])/g, '$1\n$2');
  const finalLines = [];
  for (const line of formatted.split('\n')) {
    if (line.length <= 38) { finalLines.push(line); continue; }
    let curr = [];
    let currLen = 0;
    for (const w of line.split(' ')) {
      if (currLen + w.length > 38 && curr.length > 0) {
        finalLines.push(curr.join(' '));
        curr = [w];
        currLen = w.length;
      } else {
        curr.push(w);
        currLen += w.length + 1;
      }
    }
    if (curr.length > 0) finalLines.push(curr.join(' '));
  }
  return finalLines.join('\n');
}

// Fecha relativa corta ("hace 5 min") para la lista de sesiones.
export function formatRelative(ms, now = Date.now()) {
  const diff = Math.max(0, now - Number(ms));
  const min = Math.round(diff / 60000);
  if (min < 1) return 'ahora mismo';
  if (min < 60) return `hace ${min} min`;
  const h = Math.round(min / 60);
  if (h < 24) return `hace ${h} h`;
  const d = Math.round(h / 24);
  return `hace ${d} ${d === 1 ? 'día' : 'días'}`;
}

// "Chrome en Android" a partir del User-Agent.
export function describeUserAgent(ua = '') {
  const browser = /Edg\//.test(ua) ? 'Edge' : /OPR\//.test(ua) ? 'Opera' : /Firefox\//.test(ua) ? 'Firefox'
    : /Chrome\//.test(ua) ? 'Chrome' : /Safari\//.test(ua) ? 'Safari' : 'Navegador';
  const os = /Android/.test(ua) ? 'Android' : /iPhone|iPad|iPod/.test(ua) ? 'iOS' : /Windows/.test(ua) ? 'Windows'
    : /Mac OS X/.test(ua) ? 'macOS' : /Linux/.test(ua) ? 'Linux' : '';
  return os ? `${browser} en ${os}` : browser;
}
