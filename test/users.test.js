'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { driverAvailable, migratedDb, fakeHash } = require('./helpers/env');
const { createUserStore } = require('../src/users');

const skip = !driverAvailable() && 'sin driver SQLite (npm install)';

test('siembra desde .env sin sobrescribir contraseñas cambiadas y sincroniza roles', { skip }, async () => {
  const t = await migratedDb();
  const logs = [];
  const users = createUserStore({ db: t.db, log: m => logs.push(m) });
  try {
    const env = new Map([['skiper', fakeHash('a')], ['alejandro', fakeHash('b')]]);
    const first = users.seedFromConfig({ users: env, admins: new Set(['skiper']) });
    assert.deepEqual(first.created, ['skiper', 'alejandro']);
    assert.equal(users.isAdmin('skiper'), true);
    assert.equal(users.isAdmin('alejandro'), false);
    assert.deepEqual(users.list(), ['skiper', 'alejandro']);

    // El usuario cambia su contraseña: un nuevo arranque con el .env antiguo no la revierte.
    users.setPasswordHash('skiper', fakeHash('nueva'));
    const second = users.seedFromConfig({ users: env, admins: new Set(['alejandro', 'fantasma']) });
    assert.deepEqual(second.created, []);
    assert.equal(users.get('skiper').password_hash, fakeHash('nueva'));
    // Roles: ADMIN_USERS manda para los usuarios del .env.
    assert.equal(users.isAdmin('alejandro'), true);
    assert.equal(users.isAdmin('skiper'), false);
    assert.deepEqual(second.unknownAdmins, ['fantasma']);
    assert.ok(logs.some(l => /fantasma/.test(l)));

    // APP_USERS vacío: los usuarios siguen en BD.
    users.seedFromConfig({ users: new Map(), admins: new Set() });
    assert.equal(users.count(), 2);
  } finally {
    await t.cleanup();
  }
});

test('alta, rol, borrado y validaciones', { skip }, async () => {
  const t = await migratedDb();
  const users = createUserStore({ db: t.db });
  try {
    users.create('maria', fakeHash('x'), 'admin');
    assert.throws(() => users.create('maria', fakeHash('x')), /ya existe/);
    assert.throws(() => users.create('../evil', fakeHash('x')), /no válido/);
    assert.throws(() => users.create('pepe', 'texto-plano'), /bcrypt/);
    assert.throws(() => users.setRole('maria', 'root'), /Rol/);
    users.setRole('maria', 'user');
    assert.equal(users.isAdmin('maria'), false);
    t.db.runSync("INSERT INTO sessions (token_hash, id, username, created_at, expires_at, last_seen_at) VALUES ('h', 'sid000000001', 'maria', 1, 2, 1)");
    assert.equal(users.remove('maria'), true);
    assert.equal(users.has('maria'), false);
    assert.equal(t.db.getSync("SELECT COUNT(*) AS n FROM sessions WHERE username = 'maria'").n, 0);
    assert.equal(users.get('../x'), null);
  } finally {
    await t.cleanup();
  }
});
