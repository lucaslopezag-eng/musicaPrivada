#!/usr/bin/env node
'use strict';
// ─── GESTIÓN DE USUARIOS EN LA BASE DE DATOS (FASE 2) ────────────────────────
// Los usuarios viven en la tabla `users`. Este script permite administrarlos
// sin tocar el .env (APP_USERS solo siembra la tabla en el primer arranque).
//
//   npm run user -- list
//   npm run user -- add <usuario> [--admin]      (contraseña por stdin)
//   npm run user -- passwd <usuario>             (contraseña por stdin; revoca sus sesiones)
//   npm run user -- role <usuario> admin|user
//   npm run user -- remove <usuario>             (sus canciones y estadísticas se conservan)
//   npm run user -- revoke-sessions <usuario>
//   npm run user -- hide-themes <usuario> <tema,tema|->   ("-" quita el veto)
//   npm run user -- default-playlist <usuario> <nombre|->  ("-" = "Mi Biblioteca")
//
// Puede ejecutarse con el servidor en marcha (SQLite en modo WAL): los cambios
// se aplican en la siguiente petición, sin reiniciar.

require('dotenv').config({ path: require('path').resolve(__dirname, '..', '.env') });
const path = require('path');
const bcrypt = require('bcryptjs');
const { openDatabase } = require('../src/db');
const { migrate } = require('../src/migrations');
const { createUserStore } = require('../src/users');
const { MIN_PASSWORD_LENGTH, BCRYPT_COST } = require('../src/auth');

const ROOT = path.resolve(__dirname, '..');
const USAGE = `Uso:
  npm run user -- list
  npm run user -- add <usuario> [--admin]
  npm run user -- passwd <usuario>
  npm run user -- role <usuario> admin|user
  npm run user -- remove <usuario>
  npm run user -- revoke-sessions <usuario>
  npm run user -- hide-themes <usuario> <tema,tema|->
  npm run user -- default-playlist <usuario> <nombre|->`;

function readPassword(prompt) {
  return new Promise((resolve) => {
    let input = '';
    process.stdin.setEncoding('utf8');
    if (process.stdin.isTTY) process.stderr.write(prompt);
    const onData = (chunk) => {
      input += chunk;
      if (process.stdin.isTTY && input.includes('\n')) finish();
    };
    const finish = () => {
      process.stdin.off('data', onData);
      process.stdin.pause();
      resolve(input.split('\n')[0].replace(/\r$/, ''));
    };
    process.stdin.on('data', onData);
    process.stdin.once('end', finish);
  });
}

async function newHash() {
  const password = await readPassword(`Contraseña (mín. ${MIN_PASSWORD_LENGTH} caracteres, Enter para terminar): `);
  if (password.length < MIN_PASSWORD_LENGTH) throw new Error(`La contraseña debe tener al menos ${MIN_PASSWORD_LENGTH} caracteres.`);
  if (Buffer.byteLength(password, 'utf8') > 72) throw new Error('La contraseña no puede superar 72 bytes.');
  return bcrypt.hashSync(password, BCRYPT_COST);
}

async function main() {
  const [command, username, extra] = process.argv.slice(2);
  if (!command) { console.error(USAGE); process.exit(1); }
  const name = (username || '').toLowerCase();

  const db = await openDatabase(path.resolve(ROOT, process.env.DB_PATH || 'database.sqlite'));
  try {
    await migrate(db, {
      log: () => {}, rootDir: ROOT,
      musicDir: path.resolve(ROOT, process.env.MUSIC_DIR || 'music'),
      aiMusicDir: path.resolve(ROOT, process.env.AI_MUSIC_DIR || '.ai_music'),
      legacyOwner: (process.env.LEGACY_OWNER || name || 'skiper').toLowerCase(),
    });
    const users = createUserStore({ db });

    switch (command) {
      case 'list': {
        const rows = users.describe();
        if (rows.length === 0) console.log('No hay usuarios en la base de datos.');
        for (const r of rows) console.log(`${r.username.padEnd(20)} ${r.role.padEnd(6)} creado ${r.created_at} · contraseña ${r.password_updated_at}`);
        break;
      }
      case 'add': {
        if (!name) throw new Error(USAGE);
        if (users.has(name)) throw new Error(`El usuario "${name}" ya existe.`);
        const role = process.argv.includes('--admin') ? 'admin' : 'user';
        users.create(name, await newHash(), role);
        console.log(`\nUsuario "${name}" creado (${role}).`);
        break;
      }
      case 'passwd': {
        if (!users.has(name)) throw new Error(`El usuario "${name}" no existe.`);
        const hash = await newHash();
        const revoked = db.transaction(() => {
          users.setPasswordHash(name, hash);
          return db.runSync('DELETE FROM sessions WHERE username = ?', [name]).changes;
        });
        console.log(`\nContraseña de "${name}" actualizada; ${revoked} sesiones cerradas.`);
        break;
      }
      case 'role': {
        if (!['admin', 'user'].includes(extra)) throw new Error(USAGE);
        users.setRole(name, extra);
        console.log(`"${name}" ahora es ${extra}.`);
        if (process.env.ADMIN_USERS) console.log('Nota: ADMIN_USERS del .env vuelve a aplicarse en cada arranque a los usuarios que figuran en APP_USERS.');
        break;
      }
      case 'remove': {
        if (!users.remove(name)) throw new Error(`El usuario "${name}" no existe.`);
        console.log(`Usuario "${name}" eliminado (sus archivos y estadísticas se conservan).`);
        if (String(process.env.APP_USERS || '').split(',').some(e => e.trim().toLowerCase().startsWith(`${name}:`))) {
          console.log('Aviso: sigue en APP_USERS del .env y se volverá a crear en el próximo arranque. Quítalo de ahí.');
        }
        break;
      }
      case 'revoke-sessions': {
        const { changes } = db.runSync('DELETE FROM sessions WHERE username = ?', [name]);
        console.log(`${changes} sesiones de "${name}" cerradas.`);
        break;
      }
      case 'hide-themes': {
        if (!extra) throw new Error(USAGE);
        const list = users.setHiddenThemes(name, extra === '-' ? [] : extra.split(','));
        console.log(`Temas vetados para "${name}": ${list.length ? list.join(', ') : '(ninguno)'}`);
        break;
      }
      case 'default-playlist': {
        const value = process.argv.slice(4).join(' ').trim();
        if (!value) throw new Error(USAGE);
        const set = users.setDefaultPlaylist(name, value === '-' ? null : value);
        console.log(`Playlist por defecto de "${name}": ${set || 'Mi Biblioteca'}`);
        break;
      }
      default:
        throw new Error(USAGE);
    }
  } finally {
    await db.close();
  }
}

main().catch((err) => {
  console.error(err.message || err);
  process.exit(1);
});
