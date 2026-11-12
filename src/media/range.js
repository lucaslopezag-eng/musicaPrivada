'use strict';
// ─── PARSER DE CABECERA Range (RFC 9110 §14) ─────────────────────────────────
// Corrige MEDIA-02: "bytes=-500" (sufijo) es válido, "bytes=abc" o un inicio
// mayor que el tamaño devuelven 416 en lugar de colgar la petición.
//
// Devuelve:
//   null                       → no hay Range utilizable: responder 200 completo
//   { unsatisfiable: true }    → responder 416 + "Content-Range: bytes */size"
//   { start, end }             → responder 206 con ese intervalo (inclusivo)

function toSafeInt(str) {
  if (!/^\d+$/.test(str)) return NaN;
  const n = Number(str);
  return Number.isSafeInteger(n) ? n : NaN;
}

function parseRange(header, size) {
  if (header === undefined || header === null) return null;
  const value = String(header).trim();
  if (value === '') return null;

  const eq = value.indexOf('=');
  if (eq === -1) return { unsatisfiable: true };
  const unit = value.slice(0, eq).trim().toLowerCase();
  // Unidades desconocidas se ignoran (RFC 9110): se sirve el recurso completo.
  if (unit !== 'bytes') return null;

  const spec = value.slice(eq + 1).trim();
  // No se soportan rangos múltiples (los reproductores nunca los piden).
  const m = /^(\d*)\s*-\s*(\d*)$/.exec(spec);
  if (!m) return { unsatisfiable: true };
  const [, rawStart, rawEnd] = m;
  if (rawStart === '' && rawEnd === '') return { unsatisfiable: true };
  if (!Number.isSafeInteger(size) || size <= 0) return { unsatisfiable: true };

  let start;
  let end;
  if (rawStart === '') {
    const suffix = toSafeInt(rawEnd);
    if (!Number.isFinite(suffix) || suffix === 0) return { unsatisfiable: true };
    start = Math.max(0, size - suffix);
    end = size - 1;
  } else {
    start = toSafeInt(rawStart);
    if (!Number.isFinite(start)) return { unsatisfiable: true };
    if (rawEnd === '') {
      end = size - 1;
    } else {
      const requestedEnd = toSafeInt(rawEnd);
      if (!Number.isFinite(requestedEnd) || requestedEnd < start) return { unsatisfiable: true };
      end = Math.min(requestedEnd, size - 1);
    }
  }

  if (start >= size || start > end) return { unsatisfiable: true };
  return { start, end };
}

module.exports = { parseRange };
