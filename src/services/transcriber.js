'use strict';
// ─── TRANSCRIPCIÓN LOCAL CON WHISPER ─────────────────────────────────────────
// Sustituye al worker remoto del PC cuando TRANSCRIBE_LOCAL está activo:
// · Cola persistente en la tabla `transcriptions` (clave: ruta absoluta del
//   audio). Estados: pending → processing → done | error.
// · Procesa UNA canción cada vez lanzando whisper/transcribe.py (faster-whisper)
//   con `nice`, en un proceso aparte: el servidor Node no se bloquea.
// · Guarda texto, segmentos con marcas de tiempo (JSON) e idioma, y escribe el
//   .vtt junto al audio si no existe (lo usa el panel de letras).
// · Tras un reinicio, lo que quedó en "processing" vuelve a "pending".

const fsp = require('fs').promises;
const path = require('path');
const crypto = require('crypto');
const { spawn } = require('child_process');
const { isFile } = require('../paths');

const POLL_MS = 60 * 1000;          // recoge lo encolado desde fuera (script de relleno)
const START_DELAY_MS = 15 * 1000;   // deja arrancar el servidor antes de cargar el modelo
const MAX_STDOUT_BYTES = 8 * 1024 * 1024;

function vttTime(sec) {
  const ms = Math.max(0, Math.round(sec * 1000));
  const h = String(Math.floor(ms / 3600000)).padStart(2, '0');
  const m = String(Math.floor(ms / 60000) % 60).padStart(2, '0');
  const s = String(Math.floor(ms / 1000) % 60).padStart(2, '0');
  return `${h}:${m}:${s}.${String(ms % 1000).padStart(3, '0')}`;
}

function segmentsToVtt(segments) {
  const cues = segments.map(s => `${vttTime(s.start)} --> ${vttTime(s.end)}\n${s.text}`);
  return `WEBVTT\n\n${cues.join('\n\n')}\n`;
}

function createTranscriber({ db, config, log }) {
  const opts = config.transcribe;
  let current = null;      // { filePath, child, cancelled }
  let stopped = false;
  let pollTimer = null;

  async function enqueue(absPath, kind = 'music', priority = false) {
    // Una fila existente (hecha, en curso o con error) no se toca: los errores
    // se reintentan a mano con el script de relleno (--reintentar-errores).
    await db.run(
      `INSERT INTO transcriptions (file_path, kind, status, priority) VALUES (?, ?, 'pending', ?)
       ON CONFLICT(file_path) DO UPDATE SET priority = MAX(priority, excluded.priority)
       WHERE status = 'pending'`,
      [absPath, kind, priority ? 1 : 0],
    );
    kick();
    return absPath;
  }

  // El audio se ha recortado, sustituido o borrado: la transcripción ya no le
  // corresponde (es un dato derivado y se regenera al volver a encolar).
  async function cancelByPath(absPath) {
    if (current && current.filePath === absPath) {
      current.cancelled = true;
      current.child.kill('SIGTERM');
    }
    const { changes } = await db.run('DELETE FROM transcriptions WHERE file_path = ?', [absPath]);
    return changes > 0;
  }

  function get(absPath) {
    return db.get('SELECT * FROM transcriptions WHERE file_path = ?', [absPath]);
  }

  async function stats() {
    const rows = await db.all('SELECT status, COUNT(*) AS n FROM transcriptions GROUP BY status');
    return Object.fromEntries(rows.map(r => [r.status, r.n]));
  }

  function runWhisper(filePath) {
    return new Promise((resolve, reject) => {
      const env = {
        ...process.env,
        WHISPER_MODEL: opts.model,
        WHISPER_COMPUTE_TYPE: opts.computeType,
        WHISPER_THREADS: String(opts.threads),
        HF_HUB_DISABLE_TELEMETRY: '1',
      };
      const child = spawn('nice', ['-n', String(opts.nice), opts.python, opts.script, filePath], {
        env, stdio: ['ignore', 'pipe', 'pipe'],
      });
      const job = { filePath, child, cancelled: false };
      current = job;
      const out = [];
      let outBytes = 0;
      let errTail = '';
      child.stdout.on('data', (d) => {
        outBytes += d.length;
        if (outBytes <= MAX_STDOUT_BYTES) out.push(d);
      });
      child.stderr.on('data', (d) => { errTail = (errTail + d.toString()).slice(-2000); });
      const timer = setTimeout(() => child.kill('SIGKILL'), opts.timeoutMs);
      child.on('error', (err) => { clearTimeout(timer); reject(err); });
      child.on('close', (code, signal) => {
        clearTimeout(timer);
        if (job.cancelled) return reject(Object.assign(new Error('cancelada'), { cancelled: true }));
        if (code !== 0) {
          const last = errTail.trim().split('\n').pop() || '';
          return reject(new Error(`whisper terminó con ${signal || `código ${code}`}: ${last}`.slice(0, 500)));
        }
        try {
          resolve(JSON.parse(Buffer.concat(out).toString('utf8')));
        } catch (err) {
          reject(new Error(`salida JSON no válida: ${err.message}`));
        }
      });
    });
  }

  async function writeVttIfMissing(filePath, segments) {
    if (segments.length === 0) return false;
    const vttPath = filePath.replace(/\.[^/.\\]+$/, '.vtt');
    if (await isFile(vttPath)) return false;
    const tmp = `${vttPath}.${crypto.randomBytes(4).toString('hex')}.tmp`;
    await fsp.writeFile(tmp, segmentsToVtt(segments), 'utf8');
    await fsp.rename(tmp, vttPath);
    return true;
  }

  async function processOne(filePath) {
    const name = path.basename(filePath);
    const { changes } = await db.run(
      "UPDATE transcriptions SET status = 'processing', attempts = attempts + 1, error = NULL, updated_at = datetime('now') WHERE file_path = ? AND status = 'pending'",
      [filePath],
    );
    if (changes === 0) return;
    if (!(await isFile(filePath))) {
      await db.run("UPDATE transcriptions SET status = 'error', error = 'archivo no encontrado', updated_at = datetime('now') WHERE file_path = ?", [filePath]);
      return;
    }
    log(`[Transcripción] Empieza ${name} (modelo ${opts.model})`);
    const started = Date.now();
    try {
      const result = await runWhisper(filePath);
      const segments = Array.isArray(result.segments) ? result.segments : [];
      const elapsed = Date.now() - started;
      const { changes: saved } = await db.run(
        `UPDATE transcriptions SET status = 'done', language = ?, language_probability = ?, text = ?, segments = ?,
           model = ?, audio_duration_ms = ?, processing_ms = ?, error = NULL, updated_at = datetime('now')
         WHERE file_path = ? AND status = 'processing'`,
        [result.language || null, result.language_probability ?? null, result.text || '', JSON.stringify(segments),
          result.model || opts.model, Math.round((result.duration || 0) * 1000), elapsed, filePath],
      );
      // Si la fila se borró mientras tanto (canción cancelada) no se escribe el .vtt.
      const wroteVtt = saved > 0 && await writeVttIfMissing(filePath, segments);
      log(`[Transcripción] Hecha ${name}: ${segments.length} segmentos, idioma ${result.language}, ${(elapsed / 1000).toFixed(1)} s${wroteVtt ? ', .vtt creado' : ''}`);
    } catch (err) {
      if (err.cancelled) {
        log(`[Transcripción] Cancelada ${name}`);
        return;
      }
      log(`[Transcripción] Error en ${name}: ${err.message}`);
      await db.run("UPDATE transcriptions SET status = 'error', error = ?, updated_at = datetime('now') WHERE file_path = ? AND status = 'processing'",
        [String(err.message).slice(0, 500), filePath]);
    }
  }

  let looping = false;
  async function loop() {
    if (looping || stopped) return;
    looping = true;
    try {
      while (!stopped) {
        const row = await db.get("SELECT file_path FROM transcriptions WHERE status = 'pending' ORDER BY priority DESC, created_at, rowid LIMIT 1");
        if (!row) break;
        await processOne(row.file_path);
        current = null;
      }
    } catch (err) {
      log(`[Transcripción] Error en el bucle: ${err.message}`);
    } finally {
      current = null;
      looping = false;
    }
  }

  function kick() {
    if (!stopped) setImmediate(loop);
  }

  async function start() {
    const { changes } = await db.run("UPDATE transcriptions SET status = 'pending' WHERE status = 'processing'");
    if (changes > 0) log(`[Transcripción] ${changes} transcripción(es) interrumpidas vuelven a la cola`);
    setTimeout(kick, START_DELAY_MS).unref();
    pollTimer = setInterval(kick, POLL_MS);
    pollTimer.unref();
    log(`[Transcripción] Worker local activo (modelo ${opts.model}, ${opts.computeType}, ${opts.threads} hilos, nice ${opts.nice})`);
  }

  function stop() {
    stopped = true;
    if (pollTimer) clearInterval(pollTimer);
    if (current) {
      current.cancelled = true;
      current.child.kill('SIGTERM');
    }
  }

  return { enqueue, cancelByPath, get, stats, start, stop };
}

module.exports = { createTranscriber, segmentsToVtt };
