'use strict';
// ─── USUARIOS EN BASE DE DATOS (FASE 2) ──────────────────────────────────────
// Las credenciales viven en la tabla `users` (hash bcrypt + rol). APP_USERS y
// ADMIN_USERS del .env solo SIEMBRAN la tabla:
//   · Un usuario de APP_USERS que no exista se crea con su hash del .env.
//   · Un usuario que ya exista NO se sobrescribe: si cambió su contraseña con
//     /api/auth/change-password, el hash antiguo del .env no la revierte.
//   · El rol de los usuarios listados en APP_USERS/ADMIN_USERS se sincroniza con
//     ADMIN_USERS en cada arranque (el .env sigue mandando sobre quién es admin).
// Sin caché en memoria: las consultas son síncronas y preparadas (µs), y así un
// alta/baja hecha con `npm run user` se aplica sin reiniciar el servidor.

const { USERNAME_RE } = require('./config');

const BCRYPT_RE = /^\$2[aby]\$\d{2}\$[./A-Za-z0-9]{53}$/;
const ROLES = new Set(['admin', 'user']);
const THEME_ID_RE = /^[a-z0-9-]{1,32}$/;
const BG_FILE_RE = /^[a-z0-9_-]{1,32}-\d{10,16}\.(jpg|png|webp)$/;
const DEFAULT_BG_OPACITY = 60;

class UserStoreError extends Error {}

function createUserStore({ db, log = () => {} }) {
  function get(username) {
    if (typeof username !== 'string' || !USERNAME_RE.test(username)) return null;
    return db.getSync('SELECT username, password_hash, role, created_at, updated_at, password_updated_at, hidden_themes, default_playlist, background_file, background_opacity FROM users WHERE username = ?', [username]) || null;
  }

  // Temas visuales que este usuario no puede ver ni descargar.
  function hiddenThemes(username) {
    const row = get(username);
    return row && row.hidden_themes ? row.hidden_themes.split(',').filter(Boolean) : [];
  }

  function setHiddenThemes(username, themes) {
    assertValid(username);
    const list = [...new Set(themes.map(t => String(t).trim().toLowerCase()).filter(Boolean))];
    if (list.some(t => !THEME_ID_RE.test(t))) throw new UserStoreError('Tema no válido (a-z, 0-9 y "-")');
    const { changes } = db.runSync('UPDATE users SET hidden_themes = ?, updated_at = CURRENT_TIMESTAMP WHERE username = ?', [list.join(','), username]);
    if (changes !== 1) throw new UserStoreError(`El usuario "${username}" no existe`);
    return list;
  }

  function has(username) {
    return Boolean(get(username));
  }

  function isAdmin(username) {
    const row = get(username);
    return Boolean(row && row.role === 'admin');
  }

  function list() {
    return db.allSync('SELECT username FROM users ORDER BY rowid ASC').map(r => r.username);
  }

  function describe() {
    return db.allSync('SELECT username, role, created_at, password_updated_at FROM users ORDER BY rowid ASC');
  }

  function count() {
    return db.getSync('SELECT COUNT(*) AS n FROM users').n;
  }

  function assertValid(username, hash, role) {
    if (typeof username !== 'string' || !USERNAME_RE.test(username)) throw new UserStoreError('Nombre de usuario no válido (a-z, 0-9, "_" y "-", máx. 32)');
    if (hash !== undefined && !BCRYPT_RE.test(String(hash))) throw new UserStoreError('El hash de la contraseña no es un bcrypt válido');
    if (role !== undefined && !ROLES.has(role)) throw new UserStoreError('Rol no válido (admin | user)');
  }

  function create(username, passwordHash, role = 'user') {
    assertValid(username, passwordHash, role);
    const { changes } = db.runSync(
      'INSERT INTO users (username, password_hash, role) VALUES (?, ?, ?) ON CONFLICT(username) DO NOTHING',
      [username, passwordHash, role]
    );
    if (changes !== 1) throw new UserStoreError(`El usuario "${username}" ya existe`);
  }

  function setPasswordHash(username, passwordHash) {
    assertValid(username, passwordHash);
    const { changes } = db.runSync(
      "UPDATE users SET password_hash = ?, password_updated_at = CURRENT_TIMESTAMP, updated_at = CURRENT_TIMESTAMP WHERE username = ?",
      [passwordHash, username]
    );
    if (changes !== 1) throw new UserStoreError(`El usuario "${username}" no existe`);
  }

  function setRole(username, role) {
    assertValid(username, undefined, role);
    const { changes } = db.runSync('UPDATE users SET role = ?, updated_at = CURRENT_TIMESTAMP WHERE username = ?', [role, username]);
    if (changes !== 1) throw new UserStoreError(`El usuario "${username}" no existe`);
  }

  // Elimina el usuario y sus sesiones (sus canciones y estadísticas se conservan).
  function remove(username) {
    assertValid(username);
    return db.transaction(() => {
      db.runSync('DELETE FROM sessions WHERE username = ?', [username]);
      return db.runSync('DELETE FROM users WHERE username = ?', [username]).changes === 1;
    });
  }

  // Siembra desde el .env (idempotente). Devuelve un resumen para el log.
  function seedFromConfig({ users: envUsers = new Map(), admins = new Set() } = {}) {
    const summary = { created: [], promoted: [], demoted: [], unknownAdmins: [] };
    db.transaction(() => {
      for (const [username, hash] of envUsers) {
        const role = admins.has(username) ? 'admin' : 'user';
        const existing = get(username);
        if (!existing) {
          db.runSync('INSERT INTO users (username, password_hash, role) VALUES (?, ?, ?)', [username, hash, role]);
          summary.created.push(username);
        } else if (existing.role !== role) {
          db.runSync('UPDATE users SET role = ?, updated_at = CURRENT_TIMESTAMP WHERE username = ?', [role, username]);
          (role === 'admin' ? summary.promoted : summary.demoted).push(username);
        }
      }
      // Administradores que solo existen en BD (APP_USERS ya vaciado).
      for (const username of admins) {
        if (envUsers.has(username)) continue;
        const existing = get(username);
        if (!existing) summary.unknownAdmins.push(username);
        else if (existing.role !== 'admin') {
          db.runSync("UPDATE users SET role = 'admin', updated_at = CURRENT_TIMESTAMP WHERE username = ?", [username]);
          summary.promoted.push(username);
        }
      }
    });
    if (summary.created.length) log(`[Usuarios] Sembrados desde .env: ${summary.created.join(', ')}`);
    if (summary.promoted.length) log(`[Usuarios] Rol admin (ADMIN_USERS): ${summary.promoted.join(', ')}`);
    if (summary.demoted.length) log(`[Usuarios] Rol user (fuera de ADMIN_USERS): ${summary.demoted.join(', ')}`);
    if (summary.unknownAdmins.length) log(`[Usuarios] Aviso: ADMIN_USERS contiene usuarios inexistentes: ${summary.unknownAdmins.join(', ')}`);
    return summary;
  }

  // Nombre de la playlist donde caen sus canciones sin lista (null = la general).
  function defaultPlaylist(username) {
    const row = get(username);
    return row && row.default_playlist ? row.default_playlist : null;
  }

  function setDefaultPlaylist(username, name) {
    assertValid(username);
    const value = name ? String(name).trim().slice(0, 100) : '';
    const { changes } = db.runSync('UPDATE users SET default_playlist = ?, updated_at = CURRENT_TIMESTAMP WHERE username = ?', [value || null, username]);
    if (changes !== 1) throw new UserStoreError(`El usuario "${username}" no existe`);
    return value || null;
  }

  // Fondo de pantalla propio: archivo en backgrounds/ (ver routes/background.js) y
  // opacidad de la imagen 0-100. file = null → sin imagen.
  function background(username) {
    const row = get(username);
    if (!row) return { file: null, opacity: DEFAULT_BG_OPACITY };
    return { file: row.background_file || null, opacity: row.background_opacity ?? DEFAULT_BG_OPACITY };
  }

  function setBackgroundFile(username, file) {
    assertValid(username);
    if (file !== null && !BG_FILE_RE.test(file)) throw new UserStoreError('Archivo de fondo no válido');
    const { changes } = db.runSync('UPDATE users SET background_file = ?, updated_at = CURRENT_TIMESTAMP WHERE username = ?', [file, username]);
    if (changes !== 1) throw new UserStoreError(`El usuario "${username}" no existe`);
  }

  function setBackgroundOpacity(username, opacity) {
    assertValid(username);
    const value = Math.round(Number(opacity));
    if (!Number.isInteger(value) || value < 0 || value > 100) throw new UserStoreError('Opacidad no válida (0-100)');
    const { changes } = db.runSync('UPDATE users SET background_opacity = ?, updated_at = CURRENT_TIMESTAMP WHERE username = ?', [value, username]);
    if (changes !== 1) throw new UserStoreError(`El usuario "${username}" no existe`);
    return value;
  }

  return { get, has, isAdmin, list, describe, count, create, setPasswordHash, setRole, remove, seedFromConfig, hiddenThemes, setHiddenThemes, defaultPlaylist, setDefaultPlaylist, background, setBackgroundFile, setBackgroundOpacity };
}

module.exports = { createUserStore, UserStoreError, BCRYPT_RE, THEME_ID_RE, BG_FILE_RE };
