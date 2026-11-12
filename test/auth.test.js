'use strict';
// Flujos de sesión de la Fase 2 sobre una BD real: login, sesiones con id
// público, listado/revocación y cambio de contraseña. bcryptjs se sustituye
// por un stub determinista para no depender de su instalación ni de su coste.
const test = require('node:test');
const assert = require('node:assert/strict');
const { driverAvailable, migratedDb, fakeBcrypt, fakeHash, requireWithStubs, fakeRes } = require('./helpers/env');
const { createUserStore } = require('../src/users');

const skip = !driverAvailable() && 'sin driver SQLite (npm install)';
const { createAuth, parseCookies } = requireWithStubs('../../src/auth', { bcryptjs: fakeBcrypt });

const config = { sessionTtlMs: 60 * 60 * 1000, cookieSecure: false };

async function setup() {
  const t = await migratedDb();
  const users = createUserStore({ db: t.db });
  users.create('skiper', fakeHash('contraseña-vieja'), 'admin');
  users.create('alejandro', fakeHash('otra-clave-123'), 'user');
  const logs = [];
  const auth = createAuth({ db: t.db, config, log: m => logs.push(m), users });
  return { ...t, users, auth, logs };
}

function req({ body = {}, params = {}, headers = {}, method = 'POST', path = '/x', ip = '1.2.3.4' } = {}) {
  return { body, params, headers, method, path, ip, socket: { remoteAddress: ip }, get: (h) => headers[h.toLowerCase()] };
}

async function loginAs(auth, username, password, ua = 'UA') {
  const res = fakeRes();
  await auth.login(req({ body: { username, password }, headers: { 'user-agent': ua } }), res);
  return res;
}

async function authed(auth, token, extra = {}) {
  const r = req({ ...extra, headers: { authorization: `Bearer ${token}`, ...(extra.headers || {}) } });
  const res = fakeRes();
  let nextCalled = false;
  await auth.requireAuth(r, res, () => { nextCalled = true; });
  assert.equal(nextCalled, true, 'requireAuth debería aceptar el token');
  return r;
}

test('login con usuarios de la BD, cookie HttpOnly y sesión con id', { skip }, async () => {
  const s = await setup();
  try {
    const bad = await loginAs(s.auth, 'skiper', 'mal');
    assert.equal(bad.statusCode, 401);
    const ok = await loginAs(s.auth, 'SKIPER ', 'contraseña-vieja');
    assert.equal(ok.statusCode, 200);
    assert.equal(ok.body.user, 'skiper');
    assert.equal(ok.body.isAdmin, true);
    assert.match(String(ok.headers['set-cookie']), /mp_session=.*HttpOnly; SameSite=Lax/);
    const r = await authed(s.auth, ok.body.token);
    assert.equal(r.user, 'skiper');
    assert.equal(r.isAdmin, true);
    assert.match(r.sessionId, /^[A-Za-z0-9_-]{16}$/);
    // Usuario eliminado → su sesión deja de valer.
    s.users.remove('skiper');
    assert.equal(await s.auth.resolveSession(ok.body.token), null);
  } finally {
    s.auth.close();
    await s.cleanup();
  }
});

test('listado y revocación de sesiones propias', { skip }, async () => {
  const s = await setup();
  try {
    const a = (await loginAs(s.auth, 'skiper', 'contraseña-vieja', 'Movil')).body.token;
    const b = (await loginAs(s.auth, 'skiper', 'contraseña-vieja', 'PC')).body.token;
    const other = (await loginAs(s.auth, 'alejandro', 'otra-clave-123')).body.token;

    const ra = await authed(s.auth, a, { method: 'GET' });
    const list = fakeRes();
    await s.auth.listSessions(ra, list);
    assert.equal(list.body.length, 2, 'solo las sesiones propias');
    assert.equal(list.body.filter(x => x.current).length, 1);
    assert.ok(list.body.every(x => !('token' in x) && !('token_hash' in x)));
    const pcSession = list.body.find(x => x.userAgent === 'PC');

    // No se puede revocar la sesión de otro usuario.
    const ro = await authed(s.auth, other);
    const forbidden = fakeRes();
    await s.auth.revokeSessionById({ ...ro, params: { id: pcSession.id } }, forbidden);
    assert.equal(forbidden.statusCode, 404);

    const del = fakeRes();
    await s.auth.revokeSessionById({ ...ra, params: { id: pcSession.id } }, del);
    assert.deepEqual(del.body, { success: true, current: false });
    assert.equal(await s.auth.resolveSession(b), null);
    assert.ok(await s.auth.resolveSession(a));

    // Revocar la sesión actual borra la cookie.
    const self = fakeRes();
    await s.auth.revokeSessionById({ ...ra, params: { id: ra.sessionId } }, self);
    assert.equal(self.body.current, true);
    assert.match(String(self.headers['set-cookie']), /Max-Age=0/);
    assert.equal(await s.auth.resolveSession(a), null);
  } finally {
    s.auth.close();
    await s.cleanup();
  }
});

test('cambio de contraseña: verificación, longitud, revocación del resto de sesiones', { skip }, async () => {
  const s = await setup();
  try {
    const a = (await loginAs(s.auth, 'skiper', 'contraseña-vieja', 'A')).body.token;
    const b = (await loginAs(s.auth, 'skiper', 'contraseña-vieja', 'B')).body.token;
    const ra = await authed(s.auth, a);

    const wrong = fakeRes();
    await s.auth.changePassword({ ...ra, body: { currentPassword: 'no', newPassword: 'nueva-clave-segura' } }, wrong);
    assert.equal(wrong.statusCode, 403);

    const short = fakeRes();
    await s.auth.changePassword({ ...ra, body: { currentPassword: 'contraseña-vieja', newPassword: 'corta' } }, short);
    assert.equal(short.statusCode, 400);
    const long = fakeRes();
    await s.auth.changePassword({ ...ra, body: { currentPassword: 'contraseña-vieja', newPassword: 'ñ'.repeat(40) } }, long);
    assert.equal(long.statusCode, 400, '> 72 bytes');

    const ok = fakeRes();
    await s.auth.changePassword({ ...ra, body: { currentPassword: 'contraseña-vieja', newPassword: 'nueva-clave-segura' } }, ok);
    assert.equal(ok.statusCode, 200);
    assert.equal(ok.body.revokedSessions, 1);
    assert.ok(await s.auth.resolveSession(a), 'la sesión actual sigue activa');
    assert.equal(await s.auth.resolveSession(b), null, 'las demás se revocan');
    assert.equal((await loginAs(s.auth, 'skiper', 'contraseña-vieja')).statusCode, 401);
    assert.equal((await loginAs(s.auth, 'skiper', 'nueva-clave-segura')).statusCode, 200);
    assert.ok(s.users.get('skiper').password_updated_at);
    assert.ok(s.logs.some(l => /Contraseña cambiada: skiper/.test(l)));
  } finally {
    s.auth.close();
    await s.cleanup();
  }
});

test('limitador de intentos en el cambio de contraseña', { skip }, async () => {
  const s = await setup();
  try {
    const a = (await loginAs(s.auth, 'skiper', 'contraseña-vieja')).body.token;
    const ra = await authed(s.auth, a);
    let last;
    for (let i = 0; i < 6; i++) {
      last = fakeRes();
      await s.auth.changePassword({ ...ra, body: { currentPassword: `mal-${i}`, newPassword: 'nueva-clave-segura' } }, last);
    }
    assert.equal(last.statusCode, 429);
    assert.ok(last.headers['retry-after']);
  } finally {
    s.auth.close();
    await s.cleanup();
  }
});

test('parseCookies', () => {
  assert.deepEqual(parseCookies('a=1; mp_session=x%20y; a=2'), { a: '1', mp_session: 'x y' });
});
