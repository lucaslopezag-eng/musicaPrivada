'use strict';
// ─── TAREAS ASÍNCRONAS PERSISTENTES Y COLA SERIE ─────────────────────────────
// MEDIA-04: /api/import y /api/download-single devuelven un taskId y el estado
// se consulta en /api/tasks/:id. Todas las descargas de yt-dlp pasan por una
// única cola serie (evita 429 de YouTube y carreras de nombres de archivo).
//
// FASE 2 · Cola persistente en SQLite (tabla `jobs`):
// · Cada tarea se guarda al crearse (status 'pending') con el `payload` necesario
//   para volver a ejecutarla; cambios de estado, progreso y log se persisten
//   (el log y los contadores con un pequeño retardo para agrupar escrituras).
// · Al arrancar, recover() reanuda las tareas 'pending'/'running' que el
//   reinicio dejó a medias (hasta JOB_MAX_ATTEMPTS intentos). Las que no tienen
//   manejador registrado, ni payload, o agotaron los intentos se marcan
//   'failed' con un mensaje claro: nunca quedan "en curso" para siempre.
// · Los manejadores son idempotentes: una importación reanudada omite lo ya
//   descargado y una descarga individual detecta el archivo existente.
// · Sin `db` (pruebas) el gestor funciona solo en memoria, como antes.

const crypto = require('crypto');

const MAX_LOG_LINES = 400;
const TASK_TTL_MS = 7 * 24 * 60 * 60 * 1000;
const MAX_TASKS_PER_USER = 50;
const PERSIST_DELAY_MS = 1000;
const STATUSES = new Set(['pending', 'running', 'completed', 'failed']);
const FINISHED = new Set(['completed', 'failed']);

function createSerialQueue() {
  let tail = Promise.resolve();
  let pending = 0;
  return {
    push(fn) {
      pending += 1;
      const run = tail.then(fn).finally(() => { pending -= 1; });
      tail = run.catch(() => {});
      return run;
    },
    get size() { return pending; },
  };
}

function safeJson(value) {
  if (value === undefined || value === null) return null;
  try { return JSON.stringify(value); } catch { return null; }
}

function parseJson(text, fallback = null) {
  if (typeof text !== 'string' || text === '') return fallback;
  try { return JSON.parse(text); } catch { return fallback; }
}

function sqliteTimeToMs(value) {
  if (typeof value === 'number') return value;
  if (typeof value !== 'string') return Date.now();
  // CURRENT_TIMESTAMP de SQLite: "AAAA-MM-DD HH:MM:SS" en UTC.
  const ms = Date.parse(`${value.replace(' ', 'T')}Z`);
  return Number.isFinite(ms) ? ms : Date.now();
}

function createTaskManager({ log, db = null, maxAttempts = 3 } = {}) {
  const tasks = new Map();     // id → tarea viva (creada o reanudada en este proceso)
  const handlers = new Map();  // tipo → async (task, payload) => {}
  // Dos carriles (SRV-2): una importación larga ya no bloquea durante horas las
  // descargas sueltas ni las sustituciones.
  const downloadQueue = createSerialQueue();
  const importQueue = createSerialQueue();
  const queueFor = (task) => (task.type === 'import' ? importQueue : downloadQueue);
  // Se resuelve cuando lo encolado hasta ahora en ambos carriles ha terminado.
  const idle = () => Promise.all([downloadQueue.push(async () => {}), importQueue.push(async () => {})]).then(() => {});
  const dirty = new Set();
  let persistTimer = null;

  // ─── Persistencia ──────────────────────────────────────────────────────────
  function progressOf(task) {
    if (task.status === 'completed') return 100;
    if (!task.total) return 0;
    return Math.min(100, Math.round(((task.done + task.skipped + task.failed) / task.total) * 100));
  }

  function resultOf(task) {
    return { meta: task.meta, total: task.total, done: task.done, skipped: task.skipped, failed: task.failed };
  }

  function insertRow(task) {
    if (!db) return;
    db.runSync(
      `INSERT INTO jobs (id, username, type, status, progress, payload, result, error_message, attempts, log)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      [task.id, task.user, task.type, task.status, progressOf(task), safeJson(task.payload), safeJson(resultOf(task)),
        task.error, task.attempts, task.logs.join('\n')]
    );
  }

  function writeRow(task) {
    if (!db) return;
    try {
      // El payload (p. ej. 2 MB de texto de importación) se descarta al terminar.
      const payload = FINISHED.has(task.status) ? null : safeJson(task.payload);
      db.runSync(
        `UPDATE jobs SET status = ?, progress = ?, payload = ?, result = ?, error_message = ?, attempts = ?, log = ?,
                         updated_at = CURRENT_TIMESTAMP
         WHERE id = ?`,
        [task.status, progressOf(task), payload, safeJson(resultOf(task)), task.error, task.attempts,
          task.logs.join('\n'), task.id]
      );
    } catch (err) {
      log(`[Tareas] Error guardando la tarea ${task.id}: ${err.message}`);
    }
  }

  function flush() {
    if (persistTimer) { clearTimeout(persistTimer); persistTimer = null; }
    for (const id of dirty) {
      const task = tasks.get(id);
      if (task) writeRow(task);
    }
    dirty.clear();
  }

  function markDirty(task, { immediate = false } = {}) {
    if (!db) return;
    if (immediate) {
      dirty.delete(task.id);
      writeRow(task);
      return;
    }
    dirty.add(task.id);
    if (!persistTimer) {
      persistTimer = setTimeout(flush, PERSIST_DELAY_MS);
      if (persistTimer.unref) persistTimer.unref();
    }
  }

  // ─── API ───────────────────────────────────────────────────────────────────
  function create(user, type, meta = {}, payload = null) {
    const id = crypto.randomBytes(8).toString('hex');
    const task = {
      id, user, type, meta,
      status: 'pending',
      createdAt: Date.now(),
      updatedAt: Date.now(),
      total: 0, done: 0, skipped: 0, failed: 0,
      error: null,
      attempts: 0,
      logs: [],
      payload,
    };
    tasks.set(id, task);
    insertRow(task);
    prune(user);
    return task;
  }

  function appendLog(task, message) {
    const line = `[${new Date().toISOString()}] ${message}`;
    task.logs.push(line);
    if (task.logs.length > MAX_LOG_LINES) task.logs.splice(0, task.logs.length - MAX_LOG_LINES);
    task.updatedAt = Date.now();
    log(`[Task ${task.id}/${task.user}] ${message}`);
    markDirty(task);
  }

  function update(task, patch) {
    if (patch.status !== undefined && !STATUSES.has(patch.status)) throw new Error(`Estado de tarea no válido: ${patch.status}`);
    const statusChanged = patch.status !== undefined && patch.status !== task.status;
    Object.assign(task, patch, { updatedAt: Date.now() });
    markDirty(task, { immediate: statusChanged });
  }

  // Contadores (done/skipped/failed): se persisten con el siguiente volcado.
  function bump(task, field, by = 1) {
    task[field] += by;
    task.updatedAt = Date.now();
    markDirty(task);
  }

  // Ejecuta fn(task, payload) en la cola serie; nunca deja una promesa
  // rechazada suelta. Si no se pasa fn, usa el manejador registrado del tipo.
  function runQueued(task, fn) {
    const run = fn || handlers.get(task.type);
    if (typeof run !== 'function') {
      update(task, { status: 'failed', error: `No hay manejador para tareas de tipo "${task.type}"` });
      return Promise.resolve();
    }
    return queueFor(task).push(async () => {
      update(task, { status: 'running', attempts: task.attempts + 1 });
      try {
        await run(task, task.payload);
        update(task, { status: 'completed', error: null });
      } catch (err) {
        appendLog(task, `ERROR: ${err.message || err}`);
        update(task, { status: 'failed', error: err.message || String(err) });
      }
    }).catch(() => {});
  }

  function registerHandler(type, fn) {
    handlers.set(type, fn);
  }

  // Crea la tarea y la encola con el manejador de su tipo.
  function enqueue(user, type, payload, meta = {}) {
    const task = create(user, type, meta, payload);
    runQueued(task);
    return task;
  }

  function hydrate(row) {
    const result = parseJson(row.result, {}) || {};
    return {
      id: row.id,
      user: row.username,
      type: row.type,
      meta: result.meta || {},
      status: STATUSES.has(row.status) ? row.status : 'failed',
      createdAt: sqliteTimeToMs(row.created_at),
      updatedAt: sqliteTimeToMs(row.updated_at),
      total: result.total || 0,
      done: result.done || 0,
      skipped: result.skipped || 0,
      failed: result.failed || 0,
      error: row.error_message || null,
      attempts: row.attempts || 0,
      logs: typeof row.log === 'string' && row.log ? row.log.split('\n') : [],
      payload: parseJson(row.payload, null),
    };
  }

  // Al arrancar: reanuda o cierra las tareas que el reinicio dejó a medias.
  function recover() {
    if (!db) return { resumed: 0, failed: 0 };
    const rows = db.allSync("SELECT * FROM jobs WHERE status IN ('pending', 'running') ORDER BY created_at ASC, rowid ASC");
    let resumed = 0;
    let failed = 0;
    for (const row of rows) {
      const task = hydrate(row);
      tasks.set(task.id, task);
      const handler = handlers.get(task.type);
      if (!handler || task.payload === null) {
        appendLog(task, 'Interrumpida por un reinicio del servidor y no se puede reanudar.');
        update(task, { status: 'failed', error: 'Interrumpida por un reinicio del servidor' });
        failed += 1;
        continue;
      }
      if (task.attempts >= maxAttempts) {
        appendLog(task, `Interrumpida por un reinicio del servidor tras ${task.attempts} intentos; se da por fallida.`);
        update(task, { status: 'failed', error: `Interrumpida tras ${task.attempts} intentos` });
        failed += 1;
        continue;
      }
      // Los contadores se reinician: lo ya descargado aparecerá como "omitido".
      Object.assign(task, { total: 0, done: 0, skipped: 0, failed: 0, error: null });
      appendLog(task, `Reanudada tras un reinicio del servidor (intento ${task.attempts + 1}/${maxAttempts}).`);
      update(task, { status: 'pending' });
      runQueued(task);
      resumed += 1;
    }
    if (resumed || failed) log(`[Tareas] Recuperación tras reinicio: ${resumed} reanudadas, ${failed} marcadas como fallidas.`);
    return { resumed, failed };
  }

  function serialize(task, { withLogs = false } = {}) {
    const { logs, payload: _payload, ...rest } = task;
    const out = { ...rest, progress: progressOf(task) };
    return withLogs ? { ...out, logs } : out;
  }

  function get(user, id) {
    const task = tasks.get(id);
    if (task) return task.user === user ? task : null;
    if (!db) return null;
    const row = db.getSync('SELECT * FROM jobs WHERE id = ? AND username = ?', [id, user]);
    return row ? hydrate(row) : null;
  }

  function list(user) {
    const byId = new Map();
    if (db) {
      const rows = db.allSync('SELECT * FROM jobs WHERE username = ? ORDER BY created_at DESC, rowid DESC LIMIT ?', [user, MAX_TASKS_PER_USER]);
      for (const row of rows) byId.set(row.id, hydrate(row));
    }
    for (const t of tasks.values()) if (t.user === user) byId.set(t.id, t); // la versión viva manda
    return [...byId.values()].sort((a, b) => b.createdAt - a.createdAt);
  }

  // Líneas de log de las tareas recientes del usuario (para usuarios no admin).
  function userLogText(user, maxLines = 200) {
    const lines = list(user).slice(0, 5).reverse().flatMap(t => t.logs);
    return lines.slice(-maxLines).join('\n');
  }

  function prune(user) {
    const now = Date.now();
    for (const [id, t] of tasks) {
      if (FINISHED.has(t.status) && now - t.updatedAt > TASK_TTL_MS) tasks.delete(id);
    }
    const mineInMemory = [...tasks.values()].filter(t => t.user === user).sort((a, b) => b.createdAt - a.createdAt);
    for (const t of mineInMemory.slice(MAX_TASKS_PER_USER)) {
      if (FINISHED.has(t.status)) tasks.delete(t.id);
    }
    if (!db) return;
    try {
      db.runSync(`DELETE FROM jobs WHERE status IN ('completed', 'failed') AND updated_at < datetime('now', '-7 days')`);
      db.runSync(`
        DELETE FROM jobs WHERE username = ? AND status IN ('completed', 'failed') AND id NOT IN (
          SELECT id FROM jobs WHERE username = ? ORDER BY created_at DESC, rowid DESC LIMIT ?
        )`, [user, user, MAX_TASKS_PER_USER]);
    } catch (err) {
      log(`[Tareas] Error purgando tareas antiguas: ${err.message}`);
    }
  }

  function stats() {
    let running = 0;
    let pending = 0;
    for (const t of tasks.values()) {
      if (t.status === 'running') running += 1;
      else if (t.status === 'pending') pending += 1;
    }
    return { running, pending, queued: downloadQueue.size + importQueue.size };
  }

  return {
    create, appendLog, update, bump, runQueued, registerHandler, enqueue, recover,
    serialize, get, list, userLogText, flush, stats, downloadQueue, importQueue, idle,
  };
}

module.exports = { createTaskManager, createSerialQueue };
