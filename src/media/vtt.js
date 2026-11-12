'use strict';
// ─── UTILIDADES WebVTT ───────────────────────────────────────────────────────
// MEDIA-03: al recortar una canción, los subtítulos se desplazan para seguir
// sincronizados en lugar de quedar desfasados.

function parseTimestamp(ts) {
  const m = /^(?:(\d+):)?(\d{1,2}):(\d{2})[.,](\d{1,3})$/.exec(ts.trim());
  if (!m) return null;
  const [, h = '0', mm, ss, ms] = m;
  return Number(h) * 3600 + Number(mm) * 60 + Number(ss) + Number(ms.padEnd(3, '0')) / 1000;
}

function formatTimestamp(seconds) {
  const total = Math.max(0, Math.round(seconds * 1000));
  const h = Math.floor(total / 3600000);
  const m = Math.floor((total % 3600000) / 60000);
  const s = Math.floor((total % 60000) / 1000);
  const ms = total % 1000;
  return `${String(h).padStart(2, '0')}:${String(m).padStart(2, '0')}:${String(s).padStart(2, '0')}.${String(ms).padStart(3, '0')}`;
}

/**
 * Desplaza todas las marcas de tiempo `offsetSec` hacia atrás y descarta las
 * entradas que quedan fuera de [0, maxDurationSec].
 */
function shiftVtt(text, offsetSec, maxDurationSec = Infinity) {
  const blocks = String(text).replace(/\r\n/g, '\n').split(/\n{2,}/);
  const out = [];
  for (const block of blocks) {
    const lines = block.split('\n');
    const cueIdx = lines.findIndex(l => l.includes('-->'));
    if (cueIdx === -1) { out.push(block); continue; } // cabecera, NOTE, STYLE
    const [left, rightWithSettings] = lines[cueIdx].split('-->');
    const right = rightWithSettings.trim().split(/\s+/);
    const start = parseTimestamp(left);
    const end = parseTimestamp(right[0]);
    if (start === null || end === null) { out.push(block); continue; }
    const newStart = start - offsetSec;
    const newEnd = Math.min(end - offsetSec, maxDurationSec);
    if (newEnd <= 0 || newStart >= maxDurationSec) continue;
    const settings = right.slice(1).join(' ');
    lines[cueIdx] = `${formatTimestamp(Math.max(0, newStart))} --> ${formatTimestamp(newEnd)}${settings ? ` ${settings}` : ''}`;
    out.push(lines.join('\n'));
  }
  return out.join('\n\n').trimEnd() + '\n';
}

module.exports = { shiftVtt, parseTimestamp, formatTimestamp };
