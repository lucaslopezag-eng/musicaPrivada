'use strict';
// ─── SONORIDAD POR CANCIÓN (EBU R128) ────────────────────────────────────────
// · Mide la sonoridad integrada (LUFS) de cada canción con el filtro ebur128 de
//   ffmpeg y la guarda en songs.loudness_lufs. El reproductor la usa para
//   igualar el volumen entre canciones (ganancia = -14 LUFS - medida).
// · UNA canción cada vez, con `nice`, en un proceso aparte: no bloquea Node.
// · Reanudable: solo procesa filas con loudness_lufs NULL. Recortar o sustituir
//   un archivo pone la columna a NULL y el sondeo periódico la vuelve a medir.
// · Los fallos (archivo ausente, ffmpeg) se recuerdan en memoria para no
//   reintentarlos en bucle hasta el próximo reinicio.

const { spawn } = require('child_process');
const { resolveSongFile } = require('../paths');

const START_DELAY_MS = 60 * 1000;      // deja arrancar el servidor
const POLL_MS = 15 * 60 * 1000;        // recoge canciones nuevas o recortadas
const BATCH = 50;                      // avisa a los clientes cada N canciones
const ANALYSIS_TIMEOUT_MS = 5 * 60 * 1000;
const RETRY_FAILED_DAYS = 7;           // un fallo guardado se reintenta pasada una semana

function measureLufs(ffmpeg, file) {
  return new Promise((resolve, reject) => {
    const args = ['-n', '19', ffmpeg, '-nostdin', '-hide_banner', '-nostats',
      '-i', file, '-map', '0:a:0', '-vn', '-af', 'ebur128=framelog=quiet', '-f', 'null', '-'];
    const child = spawn('nice', args, { windowsHide: true });
    let stderr = '';
    child.stderr.on('data', d => { stderr = (stderr + d).slice(-4000); });
    const timer = setTimeout(() => child.kill('SIGKILL'), ANALYSIS_TIMEOUT_MS);
    child.on('error', (err) => { clearTimeout(timer); reject(err); });
    child.on('close', (code) => {
      clearTimeout(timer);
      // El resumen final trae "I: -9.8 LUFS" (sonoridad integrada).
      const m = /Integrated loudness:\s*I:\s*(-?[\d.]+|-inf)\s*LUFS/.exec(stderr);
      if (code === 0 && m) return resolve(m[1] === '-inf' ? -70 : Number(m[1]));
      reject(new Error(`ffmpeg código ${code}: ${stderr.split('\n').slice(-3).join(' | ')}`));
    });
  });
}

function createLoudnessAnalyzer({ db, config, log, ffmpeg = 'ffmpeg', onUpdated = () => {} }) {
  const failed = new Set();
  let running = null;
  let stopped = false;
  let pollTimer = null;
  let startTimer = null;

  async function run() {
    let done = 0;
    let pendingNotify = 0;
    while (!stopped) {
      const exclude = [...failed];
      const rows = await db.all(
        `SELECT id, file_path, username FROM songs WHERE loudness_lufs IS NULL
         AND (loudness_failed_at IS NULL OR loudness_failed_at < datetime('now', '-${RETRY_FAILED_DAYS} days'))
         ${exclude.length ? `AND id NOT IN (${exclude.map(() => '?').join(',')})` : ''}
         ORDER BY id DESC LIMIT ${BATCH}`, exclude);
      if (rows.length === 0) break;
      if (done === 0) {
        const { n } = await db.get(`SELECT COUNT(*) AS n FROM songs WHERE loudness_lufs IS NULL
          AND (loudness_failed_at IS NULL OR loudness_failed_at < datetime('now', '-${RETRY_FAILED_DAYS} days'))`);
        log(`[Sonoridad] ${n} canciones sin medir. Analizando...`);
      }
      for (const row of rows) {
        if (stopped) break;
        try {
          const file = await resolveSongFile(config.musicDir, row);
          if (!file) throw new Error('archivo no encontrado');
          const lufs = await measureLufs(ffmpeg, file);
          // Solo si nadie ha sustituido el archivo mientras tanto.
          await db.run('UPDATE songs SET loudness_lufs = ?, loudness_failed_at = NULL WHERE id = ? AND file_path = ? AND loudness_lufs IS NULL',
            [Math.round(lufs * 10) / 10, row.id, row.file_path]);
          done += 1;
          pendingNotify += 1;
        } catch (err) {
          failed.add(row.id);
          log(`[Sonoridad] Canción ${row.id}: ${err.message}`);
          // El fallo se guarda: no se reintenta (ni llena el log) en cada reinicio.
          await db.run("UPDATE songs SET loudness_failed_at = datetime('now') WHERE id = ?", [row.id])
            .catch(e => log(`[Sonoridad] No se pudo guardar el fallo de la canción ${row.id}: ${e.message}`));
        }
      }
      if (pendingNotify > 0) { onUpdated(); pendingNotify = 0; }
      log(`[Sonoridad] Progreso: ${done} medidas en esta pasada.`);
    }
    if (done > 0) log(`[Sonoridad] Completado: ${done} canciones medidas.`);
    return done;
  }

  // Si ya hay una pasada en curso, se devuelve esa misma promesa.
  function kick() {
    if (stopped) return Promise.resolve(0);
    if (!running) {
      running = run()
        .catch(err => { log(`[Sonoridad] Error: ${err.message}`); return 0; })
        .finally(() => { running = null; });
    }
    return running;
  }

  function start() {
    startTimer = setTimeout(kick, START_DELAY_MS);
    startTimer.unref();
    pollTimer = setInterval(kick, POLL_MS);
    pollTimer.unref();
  }

  function stop() {
    stopped = true;
    clearTimeout(startTimer);
    clearInterval(pollTimer);
  }

  return { start, stop, kick };
}

module.exports = { createLoudnessAnalyzer, measureLufs };
