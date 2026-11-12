'use strict';
// ─── ENVÍO DE AUDIO CON SOPORTE DE RANGOS ────────────────────────────────────
// MEDIA-02: parser RFC con 416, sin throttle global (opcional por entorno y con
// limpieza de temporizadores), manejo de errores del stream y caché HTTP.

const fs = require('fs');
const fsp = fs.promises;
const path = require('path');
const { Transform, pipeline } = require('stream');
const { parseRange } = require('./range');

const MIME_TYPES = {
  '.opus': 'audio/ogg; codecs=opus',
  '.ogg': 'audio/ogg',
  '.mp3': 'audio/mpeg',
  '.m4a': 'audio/mp4',
  '.flac': 'audio/flac',
  '.wav': 'audio/wav',
  '.webm': 'audio/webm',
};

// Limitador de ancho de banda opcional (STREAM_THROTTLE_KBPS). A diferencia del
// original, cancela su temporizador cuando el cliente aborta la descarga.
class Throttle extends Transform {
  constructor(bytesPerSecond) {
    super();
    this.bytesPerSecond = bytesPerSecond;
    this.timer = null;
  }

  _transform(chunk, _encoding, callback) {
    this.push(chunk);
    const delay = (chunk.length / this.bytesPerSecond) * 1000;
    this.timer = setTimeout(() => { this.timer = null; callback(); }, delay);
  }

  _destroy(err, callback) {
    if (this.timer) clearTimeout(this.timer);
    this.timer = null;
    callback(err);
  }
}

function etagFor(stat) {
  return `"${stat.size.toString(16)}-${Math.floor(stat.mtimeMs).toString(16)}"`;
}

/**
 * Envía un archivo de audio respetando Range / If-Range / If-None-Match.
 * @param {object} opts
 * @param {boolean} opts.immutable  URL versionada (?v=rev): se puede cachear un año.
 * @param {number}  opts.throttleBps  0 = sin límite.
 */
async function streamFile(req, res, filePath, { immutable = false, throttleBps = 0, log = () => {} } = {}) {
  let stat;
  try {
    stat = await fsp.stat(filePath);
  } catch {
    return res.status(404).send('Archivo no encontrado');
  }
  if (!stat.isFile()) return res.status(404).send('Archivo no encontrado');

  const size = stat.size;
  const etag = etagFor(stat);
  const mime = MIME_TYPES[path.extname(filePath).toLowerCase()] || 'application/octet-stream';

  res.setHeader('Accept-Ranges', 'bytes');
  res.setHeader('Content-Type', mime);
  res.setHeader('ETag', etag);
  res.setHeader('Last-Modified', stat.mtime.toUTCString());
  // "private": el contenido depende del usuario autenticado; ningún proxy
  // intermedio (túnel/CDN) debe almacenarlo.
  res.setHeader('Cache-Control', immutable ? 'private, max-age=31536000, immutable' : 'private, no-cache');

  let rangeHeader = req.headers.range;
  if (!rangeHeader && req.headers['if-none-match'] === etag) {
    return res.status(304).end();
  }
  const ifRange = req.headers['if-range'];
  if (rangeHeader && ifRange && ifRange !== etag) rangeHeader = undefined;

  const range = parseRange(rangeHeader, size);
  if (range && range.unsatisfiable) {
    res.setHeader('Content-Range', `bytes */${size}`);
    return res.status(416).end();
  }

  let start = 0;
  let end = size - 1;
  if (range) {
    ({ start, end } = range);
    res.status(206);
    res.setHeader('Content-Range', `bytes ${start}-${end}/${size}`);
  } else {
    res.status(200);
  }
  res.setHeader('Content-Length', size === 0 ? 0 : end - start + 1);

  if (req.method === 'HEAD' || size === 0) return res.end();

  const source = fs.createReadStream(filePath, { start, end });
  const stages = [source];
  if (throttleBps > 0 && !req.query.precache) stages.push(new Throttle(throttleBps));
  stages.push(res);

  // pipeline() destruye todos los streams si el cliente cierra la conexión,
  // y captura errores de lectura (antes colgaban la petición).
  pipeline(...stages, (err) => {
    if (err && err.code !== 'ERR_STREAM_PREMATURE_CLOSE') {
      log(`[Stream] Error enviando ${path.basename(filePath)}: ${err.message}`);
      if (!res.headersSent) res.status(500).end();
    }
  });
}

module.exports = { streamFile, Throttle, MIME_TYPES };
