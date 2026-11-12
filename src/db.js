'use strict';
// ─── CAPA DE ACCESO A SQLITE (FASE 2: better-sqlite3) ────────────────────────
// · Driver síncrono: better-sqlite3. Si no está instalado (p. ej. un entorno de
//   CI sin compilador), se usa node:sqlite (Node ≥ 22.13), con la misma API.
// · Una transacción es una función SÍNCRONA ejecutada entre BEGIN IMMEDIATE y
//   COMMIT: ninguna otra petición puede intercalar sentencias dentro de ella
//   (el event loop no avanza), así que desaparecen la cola manual de promesas y
//   el aislamiento con AsyncLocalStorage de la Fase 1.
// · run/get/all/exec siguen devolviendo promesas para no reescribir las ~120
//   llamadas existentes; las variantes *Sync son las que se usan dentro de las
//   transacciones.

const fs = require('fs');
const path = require('path');

const STATEMENT_CACHE_MAX = 300;

function loadDriver(preferred) {
  const order = preferred === 'node' ? ['node', 'better'] : ['better', 'node'];
  const errors = [];
  for (const name of order) {
    try {
      if (name === 'better') {
        const Database = require('better-sqlite3');
        return {
          name: 'better-sqlite3',
          open: (file, { readonly = false } = {}) => new Database(file, { timeout: 5000, readonly, fileMustExist: readonly }),
          plainRows: false,
        };
      }
      // eslint-disable-next-line global-require
      const { DatabaseSync } = require('node:sqlite');
      return {
        name: 'node:sqlite',
        open: (file, { readonly = false } = {}) => new DatabaseSync(file, { readOnly: readonly }),
        plainRows: true,
      };
    } catch (err) {
      errors.push(`${name}: ${err.message}`);
    }
  }
  throw new Error(`No hay ningún driver SQLite disponible (instala dependencias con "npm install").\n${errors.join('\n')}`);
}

// better-sqlite3 y node:sqlite solo aceptan números, cadenas, bigint, buffers y null.
function normalizeParams(params) {
  if (params === undefined || params === null) return [];
  const list = Array.isArray(params) ? params : [params];
  return list.map((v) => {
    if (v === undefined) return null;
    if (v === true) return 1;
    if (v === false) return 0;
    if (v instanceof Date) return v.toISOString();
    return v;
  });
}

function toPlain(row) {
  return row && Object.getPrototypeOf(row) === null ? Object.assign({}, row) : row;
}

function wrap(raw, driver) {
  const cache = new Map();
  let depth = 0;

  function prepare(sql) {
    let stmt = cache.get(sql);
    if (stmt) return stmt;
    stmt = raw.prepare(sql);
    if (cache.size >= STATEMENT_CACHE_MAX) cache.delete(cache.keys().next().value);
    cache.set(sql, stmt);
    return stmt;
  }

  function runSync(sql, params) {
    const stmt = prepare(sql);
    const args = normalizeParams(params);
    // better-sqlite3 no permite run() sobre sentencias que devuelven filas.
    if (stmt.reader === true) {
      stmt.all(...args);
      return { lastID: 0, changes: 0 };
    }
    const info = stmt.run(...args);
    return { lastID: Number(info.lastInsertRowid || 0), changes: Number(info.changes || 0) };
  }

  function getSync(sql, params) {
    const row = prepare(sql).get(...normalizeParams(params));
    return driver.plainRows ? toPlain(row) : row;
  }

  function allSync(sql, params) {
    const rows = prepare(sql).all(...normalizeParams(params)) || [];
    return driver.plainRows ? rows.map(toPlain) : rows;
  }

  function execSync(sql) {
    raw.exec(sql);
  }

  const asPromise = (fn) => (...args) => {
    try {
      return Promise.resolve(fn(...args));
    } catch (err) {
      return Promise.reject(err);
    }
  };

  // Ejecuta fn() de forma atómica. fn DEBE ser síncrona: si devuelve una
  // promesa se revierte la transacción (un await dentro rompería la atomicidad).
  // Las transacciones anidadas usan SAVEPOINT.
  function transaction(fn) {
    const savepoint = `sp_${depth}`;
    if (depth === 0) raw.exec('BEGIN IMMEDIATE');
    else raw.exec(`SAVEPOINT ${savepoint}`);
    depth += 1;
    try {
      const value = fn();
      if (value && typeof value.then === 'function') {
        value.catch(() => {});
        throw new TypeError('db.transaction() requiere una función síncrona (usa runSync/getSync/allSync)');
      }
      depth -= 1;
      if (depth === 0) raw.exec('COMMIT');
      else raw.exec(`RELEASE ${savepoint}`);
      return value;
    } catch (err) {
      depth -= 1;
      try {
        if (depth === 0) raw.exec('ROLLBACK');
        else raw.exec(`ROLLBACK TO ${savepoint}; RELEASE ${savepoint}`);
      } catch { /* ya revertida */ }
      throw err;
    }
  }

  // Copia en caliente consistente (DEP-01).
  async function backup(destination) {
    fs.mkdirSync(path.dirname(path.resolve(destination)), { recursive: true });
    if (typeof raw.backup === 'function' && driver.name === 'better-sqlite3') {
      await raw.backup(destination);
      return;
    }
    // VACUUM INTO (SQLite ≥ 3.27) también produce una copia consistente.
    raw.prepare('VACUUM INTO ?').run(destination);
  }

  function close() {
    cache.clear();
    try { raw.close(); } catch { /* ya cerrada */ }
    return Promise.resolve();
  }

  return {
    raw,
    driver: driver.name,
    run: asPromise(runSync),
    get: asPromise(getSync),
    all: asPromise(allSync),
    exec: asPromise(execSync),
    runSync,
    getSync,
    allSync,
    execSync,
    transaction,
    get inTransaction() { return depth > 0; },
    backup,
    close,
  };
}

// Abre la base de datos. Se mantiene async por compatibilidad con los llamadores.
async function openDatabase(file, { driver: preferred = process.env.SQLITE_DRIVER, readonly = false } = {}) {
  const driver = loadDriver(preferred);
  const raw = driver.open(file, { readonly });
  if (!readonly) {
    // DB-04: WAL permite lecturas concurrentes durante escrituras y reduce fsyncs.
    try { raw.exec('PRAGMA journal_mode = WAL'); } catch { /* :memory: */ }
    raw.exec('PRAGMA synchronous = NORMAL; PRAGMA busy_timeout = 5000; PRAGMA foreign_keys = OFF;');
  }
  return wrap(raw, driver);
}

module.exports = { openDatabase, normalizeParams };
