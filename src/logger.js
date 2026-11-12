'use strict';
// ─── LOGGER ESTRUCTURADO CON NIVELES Y ROTACIÓN ──────────────────────────────
// FASE 2:
// · Niveles debug < info < warn < error (LOG_LEVEL). Lo que queda por debajo
//   del nivel configurado no se escribe ni en consola ni en archivo.
// · Formato "text" (legible, por defecto) o "json" (una línea JSON por evento,
//   apto para jq/Loki): LOG_FORMAT=json.
// · Campos estructurados: logger.info('mensaje', { reqId, user, ... }) y
//   loggers hijos con campos fijos: logger.child({ reqId }).
// · Rotación por tamaño (LOG_MAX_BYTES / LOG_MAX_FILES), escritura asíncrona.
// · Compatibilidad: log('texto') sigue funcionando; su nivel se deduce del
//   contenido ("error", "aviso", "rechazado"...), así los ~200 mensajes
//   existentes quedan clasificados sin reescribirlos.

const fs = require('fs');
const fsp = fs.promises;

const LEVELS = { debug: 10, info: 20, warn: 30, error: 40 };
const ERROR_RE = /\b(error|errores|exception|fatal|uncaught|unhandled)\b|\[HTTP 5\d\d\]/i;
const WARN_RE = /\b(aviso|warn(ing)?|rechazad[oa]s?|fallid[oa]s?|fall[oó]|omitid[oa]|caducad[oa]|denegad[oa]|interrumpid[oa])\b/i;

function inferLevel(msg) {
  const text = String(msg);
  if (ERROR_RE.test(text)) return 'error';
  if (WARN_RE.test(text)) return 'warn';
  return 'info';
}

function serializeFields(fields) {
  if (!fields) return null;
  const out = {};
  for (const [k, v] of Object.entries(fields)) {
    if (v === undefined) continue;
    out[k] = v instanceof Error ? { message: v.message, stack: v.stack } : v;
  }
  return Object.keys(out).length ? out : null;
}

function createLogger({ file, maxBytes = 5 * 1024 * 1024, maxFiles = 3, level = 'info', format = 'text', console: useConsole = true } = {}) {
  const threshold = LEVELS[level] || LEVELS.info;
  let size = 0;
  try { size = file ? fs.statSync(file).size : 0; } catch { size = 0; }

  let stream = file ? openStream() : null;
  let rotating = false;
  let pending = [];

  function openStream() {
    const s = fs.createWriteStream(file, { flags: 'a' });
    s.on('error', (err) => console.error(`[Logger] Error escribiendo ${file}: ${err.message}`));
    return s;
  }

  function rotate() {
    rotating = true;
    const old = stream;
    old.end(() => {
      try {
        for (let i = maxFiles - 1; i >= 1; i--) {
          const src = `${file}.${i}`;
          const dst = `${file}.${i + 1}`;
          if (fs.existsSync(src)) {
            fs.rmSync(dst, { force: true });
            fs.renameSync(src, dst);
          }
        }
        fs.rmSync(`${file}.1`, { force: true });
        fs.renameSync(file, `${file}.1`);
        fs.rmSync(`${file}.${maxFiles + 1}`, { force: true });
      } catch (err) {
        console.error(`[Logger] Fallo al rotar el log: ${err.message}`);
      }
      stream = openStream();
      size = 0;
      rotating = false;
      const queued = pending;
      pending = [];
      for (const chunk of queued) write(chunk);
    });
  }

  function write(chunk) {
    if (!stream) return;
    if (rotating) { pending.push(chunk); return; }
    size += Buffer.byteLength(chunk);
    stream.write(chunk);
    if (size >= maxBytes) rotate();
  }

  function format_(lvl, msg, fields) {
    const ts = new Date().toISOString();
    if (format === 'json') return JSON.stringify({ ts, level: lvl, msg: String(msg), ...(fields || {}) });
    const extra = fields ? ` ${JSON.stringify(fields)}` : '';
    // Texto: "[ts] LEVEL mensaje {campos}". El nivel info se omite para que
    // /api/logs siga mostrando las mismas líneas que antes.
    return `[${ts}] ${lvl === 'info' ? '' : `${lvl.toUpperCase()} `}${msg}${extra}`;
  }

  function emit(lvl, msg, fields, baseFields) {
    if ((LEVELS[lvl] || LEVELS.info) < threshold) return;
    const merged = serializeFields({ ...(baseFields || {}), ...(fields || {}) });
    const line = format_(lvl, msg, merged);
    if (useConsole) {
      if (lvl === 'error') console.error(line);
      else if (lvl === 'warn') console.warn(line);
      else console.log(line);
    }
    write(`${line}\n`);
  }

  function makeApi(baseFields) {
    const api = {
      debug: (msg, fields) => emit('debug', msg, fields, baseFields),
      info: (msg, fields) => emit('info', msg, fields, baseFields),
      warn: (msg, fields) => emit('warn', msg, fields, baseFields),
      error: (msg, fields) => emit('error', msg, fields, baseFields),
      // Compatibilidad con la API anterior: nivel deducido del texto.
      log: (msg, fields) => emit(inferLevel(msg), msg, fields, baseFields),
      child: (fields) => makeApi({ ...(baseFields || {}), ...(fields || {}) }),
      isLevelEnabled: (lvl) => (LEVELS[lvl] || 0) >= threshold,
    };
    return api;
  }

  const root = makeApi(null);

  // Devuelve las últimas `maxLines` líneas leyendo solo el final del archivo.
  async function tail(maxLines = 200, maxBytesToRead = 128 * 1024) {
    if (!file) return '';
    let handle;
    try {
      handle = await fsp.open(file, 'r');
      const { size: fileSize } = await handle.stat();
      const length = Math.min(fileSize, maxBytesToRead);
      const buffer = Buffer.alloc(length);
      await handle.read(buffer, 0, length, fileSize - length);
      let lines = buffer.toString('utf8').split('\n');
      if (length < fileSize) lines = lines.slice(1); // primera línea posiblemente truncada
      return lines.filter(Boolean).slice(-maxLines).join('\n');
    } catch (err) {
      if (err.code === 'ENOENT') return '';
      throw err;
    } finally {
      if (handle) await handle.close().catch(() => {});
    }
  }

  function close() {
    if (!stream) return Promise.resolve();
    return new Promise((resolve) => stream.end(resolve));
  }

  return { ...root, tail, close, level, format };
}

module.exports = { createLogger, inferLevel, LEVELS };
