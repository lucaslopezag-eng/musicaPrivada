'use strict';
// ─── LECTURA DE DURACIÓN SIN DECODIFICAR (DB-02) ─────────────────────────────
// 1) music-metadata lee la duración de las cabeceras del contenedor.
// 2) ffprobe (si existe) mediante execFile con argumentos en array.
// 3) "ffmpeg -i archivo" (sin "-f null -": no decodifica todo el audio).
// Ningún paso usa una shell, así que nombres como "x $(rm -rf ~).opus" son
// inofensivos.

const path = require('path');
const { execFile, spawn } = require('child_process');

let musicMetadataPromise = null;
function loadMusicMetadata() {
  if (!musicMetadataPromise) {
    musicMetadataPromise = import('music-metadata')
      .then(mod => mod.parseFile || (mod.default && mod.default.parseFile) || null)
      .catch(() => null);
  }
  return musicMetadataPromise;
}

function parseFfmpegDuration(text) {
  const m = /Duration:\s*(\d+):(\d{2}):(\d{2}(?:\.\d+)?)/.exec(String(text || ''));
  if (!m) return null;
  const seconds = Number(m[1]) * 3600 + Number(m[2]) * 60 + Number(m[3]);
  return Number.isFinite(seconds) && seconds > 0 ? Math.round(seconds * 1000) : null;
}

function viaFfprobe(ffprobePath, file) {
  return new Promise((resolve) => {
    execFile(ffprobePath, ['-v', 'error', '-show_entries', 'format=duration', '-of', 'default=noprint_wrappers=1:nokey=1', file],
      { timeout: 20000, windowsHide: true }, (err, stdout) => {
        if (err) return resolve(null);
        const secs = Number.parseFloat(String(stdout).trim());
        resolve(Number.isFinite(secs) && secs > 0 ? Math.round(secs * 1000) : null);
      });
  });
}

function viaFfmpeg(ffmpegPath, file) {
  return new Promise((resolve) => {
    if (!ffmpegPath) return resolve(null);
    const child = spawn(ffmpegPath, ['-hide_banner', '-nostdin', '-i', file], { windowsHide: true });
    let stderr = '';
    const timer = setTimeout(() => child.kill('SIGKILL'), 20000);
    child.stderr.on('data', d => { if (stderr.length < 65536) stderr += d; });
    child.on('error', () => { clearTimeout(timer); resolve(null); });
    // ffmpeg sale con código 1 porque no hay salida: es lo esperado.
    child.on('close', () => { clearTimeout(timer); resolve(parseFfmpegDuration(stderr)); });
  });
}

function createDurationProbe({ ffmpegPath, ffprobePath }) {
  return async function probeDurationMs(file) {
    if (!path.isAbsolute(file)) throw new Error('probeDurationMs requiere una ruta absoluta');
    const parseFile = await loadMusicMetadata();
    if (parseFile) {
      try {
        const meta = await parseFile(file, { duration: true, skipCovers: true });
        const secs = meta && meta.format && meta.format.duration;
        if (Number.isFinite(secs) && secs > 0) return Math.round(secs * 1000);
      } catch { /* se prueba el siguiente método */ }
    }
    const fromProbe = await viaFfprobe(ffprobePath || 'ffprobe', file);
    if (fromProbe) return fromProbe;
    return viaFfmpeg(ffmpegPath, file);
  };
}

module.exports = { createDurationProbe, parseFfmpegDuration };
