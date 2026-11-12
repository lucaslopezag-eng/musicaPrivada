'use strict';
// ─── INVOCACIÓN SEGURA DE yt-dlp ─────────────────────────────────────────────
// AUTH-05 / MEDIA-03:
// · El binario se ejecuta con spawn y argumentos en array (sin shell).
// · El objetivo (URL o "ytsearch1:...") va SIEMPRE detrás de "--", por lo que un
//   valor que empiece por "-" nunca se interpreta como opción.
// · Se elimina --no-check-certificate: la verificación TLS queda activa.
// · Las descargas se hacen en un directorio de staging y solo se mueven al
//   destino final cuando han terminado bien (escritura atómica por rename).

const fs = require('fs');
const fsp = fs.promises;
const path = require('path');
const crypto = require('crypto');
const { spawn } = require('child_process');

const DEFAULT_TIMEOUT_MS = 15 * 60 * 1000;
const SONG_MATCH_FILTER = "!is_live & duration < 600 & title !~= '(?i)(reaction|reacts|review|1 hour|10 hours|podcast|interview|gameplay|trailer)'";

function resolveYtDlpBinary(configuredPath) {
  if (configuredPath) return configuredPath;
  try {
    const ydl = require('youtube-dl-exec');
    if (ydl && ydl.constants && ydl.constants.YOUTUBE_DL_PATH) return ydl.constants.YOUTUBE_DL_PATH;
  } catch { /* se intenta la ruta por convención */ }
  try {
    const main = require.resolve('youtube-dl-exec');
    const bin = process.platform === 'win32' ? 'yt-dlp.exe' : 'yt-dlp';
    const candidate = path.join(path.dirname(main), '..', 'bin', bin);
    if (fs.existsSync(candidate)) return candidate;
  } catch { /* no instalado */ }
  return process.platform === 'win32' ? 'yt-dlp.exe' : 'yt-dlp';
}

function createYtDlp({ config, ffmpegPath, log }) {
  const binary = resolveYtDlpBinary(config.ytdlpPath);

  function run(target, flags, { timeoutMs = DEFAULT_TIMEOUT_MS } = {}) {
    if (typeof target !== 'string' || target.length === 0 || target.length > 2048) {
      return Promise.reject(new Error('Objetivo de yt-dlp no válido'));
    }
    return new Promise((resolve, reject) => {
      const child = spawn(binary, [...flags, '--', target], { stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true });
      let stdout = '';
      let stderr = '';
      const cap = (s) => (s.length > 200000 ? s.slice(-100000) : s);
      child.stdout.on('data', d => { stdout = cap(stdout + d); });
      child.stderr.on('data', d => { stderr = cap(stderr + d); });
      const timer = setTimeout(() => {
        log(`[yt-dlp] Tiempo agotado (${Math.round(timeoutMs / 1000)}s), proceso terminado.`);
        child.kill('SIGKILL');
      }, timeoutMs);
      child.on('error', (err) => { clearTimeout(timer); reject(err); });
      child.on('close', (code, signal) => {
        clearTimeout(timer);
        if (code === 0) return resolve({ stdout, stderr });
        const err = new Error(`yt-dlp terminó con código ${code}${signal ? ` (${signal})` : ''}`);
        err.stderr = stderr;
        return reject(err);
      });
    });
  }

  function audioFlags(output, { matchFilter = null, isUrl = false } = {}) {
    const flags = [
      '--extract-audio', '--audio-format', 'opus',
      '--output', output,
      '--write-thumbnail', '--convert-thumbnails', 'jpg',
      '--ffmpeg-location', ffmpegPath,
      '--no-warnings', '--quiet', '--no-progress',
      '--extractor-args', 'youtube:player_client=android',
    ];
    if (isUrl) flags.push('--no-playlist');
    if (matchFilter) flags.push('--match-filter', matchFilter);
    return flags;
  }

  /**
   * Descarga a <destDir>/.staging/<id>/<baseName>.opus. Devuelve un objeto
   * staging con commit(destDir) / discard(). Si falla, limpia y lanza.
   */
  async function downloadToStaging({ target, destDir, baseName, isUrl, matchFilter, coverBuffer }) {
    const jobDir = path.join(destDir, '.staging', crypto.randomBytes(6).toString('hex'));
    await fsp.mkdir(jobDir, { recursive: true });
    const discard = () => fsp.rm(jobDir, { recursive: true, force: true }).catch(() => {});
    try {
      if (coverBuffer) await fsp.writeFile(path.join(jobDir, `${baseName}.jpg`), coverBuffer);
      const output = path.join(jobDir, `${baseName}.opus`);
      await run(target, audioFlags(output, { matchFilter, isUrl }));

      const files = await fsp.readdir(jobDir);
      let audio = files.includes(`${baseName}.opus`) ? `${baseName}.opus` : null;
      if (!audio) audio = files.find(f => f.endsWith('.opus')) || null;
      if (!audio) throw new Error('yt-dlp no produjo ningún archivo de audio');
      const { size } = await fsp.stat(path.join(jobDir, audio));
      if (size === 0) throw new Error('El archivo descargado está vacío');

      return {
        jobDir,
        audioName: audio,
        files,
        discard,
        // Mueve los archivos al destino. Primero imágenes, el audio al final, para
        // que el sincronizador vea la portada al detectar la canción.
        async commit(finalDir, finalStem = baseName) {
          const moved = [];
          const images = files.filter(f => f !== audio && /\.(jpe?g|webp|png)$/i.test(f));
          const ordered = [...images, audio];
          for (const name of ordered) {
            if (!name.startsWith(baseName)) continue;
            const finalName = finalStem + name.slice(baseName.length);
            await fsp.rename(path.join(jobDir, name), path.join(finalDir, finalName));
            moved.push(finalName);
          }
          await discard();
          return { audioPath: path.join(finalDir, finalStem + audio.slice(baseName.length)), moved };
        },
      };
    } catch (err) {
      await discard();
      throw err;
    }
  }

  return { run, audioFlags, downloadToStaging, binary };
}

// Clasifica errores de yt-dlp para mensajes de log comprensibles.
function describeYtDlpError(err) {
  const msg = String((err && (err.stderr || err.message)) || err);
  if (/Sign in|age|inappropriate/i.test(msg)) return 'restringido por edad';
  if (/No video formats|not available|unavailable/i.test(msg)) return 'no disponible';
  if (/does not pass filter|skipping/i.test(msg)) return 'descartado por el filtro (directo/reacción/duración)';
  return msg.split('\n').filter(Boolean).slice(-1)[0]?.slice(0, 200) || 'error desconocido';
}

module.exports = { createYtDlp, describeYtDlpError, SONG_MATCH_FILTER, resolveYtDlpBinary };
