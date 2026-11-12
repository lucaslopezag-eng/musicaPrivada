'use strict';
// ─── COLA DE GENERACIÓN DE SUBTÍTULOS (.vtt) ─────────────────────────────────
// El worker remoto (Whisper en el PC) consulta la cola, descarga el audio y sube
// el .vtt. Cambios (AUTH-06 / AUTH-02):
// · Los trabajos se identifican con un id opaco; ya no se exponen rutas
//   absolutas del servidor.
// · La descarga/subida solo es posible para trabajos activos.
// · El .vtt se valida y se escribe de forma atómica (tmp + rename).

const fsp = require('fs').promises;
const path = require('path');
const crypto = require('crypto');
const { toPosix } = require('../paths');

const JOB_TIMEOUT_MS = 30 * 60 * 1000;
const MAX_QUEUE = 2000;
const MAX_VTT_BYTES = 2 * 1024 * 1024;

// `local` (opcional): transcriptor local (transcriber.js). Si existe, recibe
// los trabajos en lugar de la cola del worker remoto.
function createSubtitleQueue({ config, log, local = null }) {
  const queue = [];            // trabajos pendientes
  const active = new Map();    // id → { job, startedAt }
  const byPath = new Map();    // ruta absoluta → id (deduplicación)

  function rootFor(kind) {
    return kind === 'ai' ? config.aiMusicDir : config.musicDir;
  }

  function enqueue(absPath, kind = 'music', priority = false) {
    if (local) {
      local.enqueue(absPath, kind, priority)
        .catch(err => log(`[Transcripción] No se pudo encolar ${path.basename(absPath)}: ${err.message}`));
      return absPath;
    }
    if (byPath.has(absPath)) return byPath.get(absPath);
    if (queue.length >= MAX_QUEUE) return null;
    const id = crypto.randomBytes(9).toString('base64url');
    const relative = toPosix(path.relative(rootFor(kind), absPath));
    const job = { id, kind, absPath, relative };
    byPath.set(absPath, id);
    if (priority) queue.unshift(job); else queue.push(job);
    log(`[Subtítulos] En cola ${path.basename(absPath)} (pendientes: ${queue.length})`);
    return id;
  }

  function requeueExpired() {
    const now = Date.now();
    for (const [id, entry] of active) {
      if (now - entry.startedAt > JOB_TIMEOUT_MS) {
        log(`[Subtítulos] Trabajo caducado, se reencola: ${path.basename(entry.job.absPath)}`);
        active.delete(id);
        queue.unshift(entry.job);
      }
    }
  }

  function next() {
    requeueExpired();
    const job = queue.shift();
    if (!job) return null;
    active.set(job.id, { job, startedAt: Date.now() });
    return job;
  }

  // Busca un trabajo activo por id o (compatibilidad) por ruta relativa.
  function findActive({ jobId, audioPath }) {
    if (jobId && active.has(jobId)) return active.get(jobId).job;
    if (audioPath) {
      for (const { job } of active.values()) {
        if (job.relative === audioPath || job.id === audioPath) return job;
      }
    }
    return null;
  }

  async function complete(job, vttContent) {
    const text = typeof vttContent === 'string' ? vttContent : '';
    if (Buffer.byteLength(text) > MAX_VTT_BYTES) throw Object.assign(new Error('VTT demasiado grande'), { status: 413 });
    if (!/^﻿?WEBVTT/.test(text)) throw Object.assign(new Error('El contenido no es un WebVTT válido'), { status: 400 });
    const vttPath = job.absPath.replace(/\.[^/.\\]+$/, '.vtt');
    const tmp = `${vttPath}.${crypto.randomBytes(4).toString('hex')}.tmp`;
    await fsp.writeFile(tmp, text, 'utf8');
    await fsp.rename(tmp, vttPath);
    active.delete(job.id);
    byPath.delete(job.absPath);
    log(`[Subtítulos] Recibidos y guardados para ${path.basename(job.absPath)}`);
  }

  // Descarta trabajos (pendientes o activos) de un audio que se ha recortado,
  // sustituido o borrado: su .vtt ya no corresponde al archivo.
  function cancelByPath(absPath) {
    if (local) {
      local.cancelByPath(absPath)
        .catch(err => log(`[Transcripción] No se pudo cancelar ${path.basename(absPath)}: ${err.message}`));
    }
    const id = byPath.get(absPath);
    if (!id) return false;
    byPath.delete(absPath);
    active.delete(id);
    const idx = queue.findIndex(j => j.id === id);
    if (idx !== -1) queue.splice(idx, 1);
    return true;
  }

  function stats() {
    return { pending: queue.length, active: active.size };
  }

  return { enqueue, next, findActive, complete, cancelByPath, stats };
}

module.exports = { createSubtitleQueue, MAX_VTT_BYTES };
