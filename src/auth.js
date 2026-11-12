'use strict';
// ─── AUTENTICACIÓN Y SESIONES (AUTH-01 / AUTH-03) ────────────────────────────
// · Contraseñas con bcrypt en la tabla `users` (FASE 2; APP_USERS solo siembra).
// · Cambio de contraseña y listado/revocación de sesiones activas (FASE 2).
// · Tokens de sesión aleatorios de 256 bits; en BD solo se guarda su SHA-256.
// · Caducidad deslizante, revocación (logout) y limitador de intentos de login.
// · Cookie HttpOnly para <audio>/<img>/sendBeacon, que no pueden enviar
//   cabeceras: así ningún token viaja en la query string ni acaba en logs.

const crypto = require('crypto');
const bcrypt = require('bcryptjs');

const SESSION_COOKIE = 'mp_session';
const SLIDING_REFRESH_MS = 60 * 60 * 1000; // renovar caducidad como mucho 1 vez/hora

// POST que pueden autenticarse con cookie (navigator.sendBeacon no envía
// cabeceras). SameSite=Lax impide que un sitio externo los dispare con cookie.
const COOKIE_POST_ALLOWLIST = new Set(['/stats/listen']);

function sha256(text) {
  return crypto.createHash('sha256').update(text).digest('hex');
}

function parseCookies(header) {
  const out = {};
  if (!header) return out;
  for (const part of String(header).split(';')) {
    const idx = part.indexOf('=');
    if (idx === -1) continue;
    const key = part.slice(0, idx).trim();
    const value = part.slice(idx + 1).trim();
    if (key && !(key in out)) {
      try { out[key] = decodeURIComponent(value); } catch { out[key] = value; }
    }
  }
  return out;
}

function createLoginLimiter({ windowMs = 15 * 60 * 1000, maxPerUser = 5, maxPerIp = 20 } = {}) {
  const buckets = new Map();

  function hit(key, max) {
    const now = Date.now();
    let b = buckets.get(key);
    if (!b || now - b.first > windowMs) {
      b = { count: 0, first: now };
      buckets.set(key, b);
    }
    b.count += 1;
    return b.count > max ? Math.ceil((b.first + windowMs - now) / 1000) : 0;
  }

  function blockedFor(key, max) {
    const b = buckets.get(key);
    if (!b) return 0;
    const now = Date.now();
    if (now - b.first > windowMs) { buckets.delete(key); return 0; }
    return b.count >= max ? Math.ceil((b.first + windowMs - now) / 1000) : 0;
  }

  return {
    check(ip, user) {
      return Math.max(blockedFor(`ip:${ip}`, maxPerIp), blockedFor(`u:${ip}|${user}`, maxPerUser));
    },
    fail(ip, user) {
      hit(`ip:${ip}`, maxPerIp);
      hit(`u:${ip}|${user}`, maxPerUser);
    },
    succeed(ip, user) {
      buckets.delete(`u:${ip}|${user}`);
    },
    sweep() {
      const now = Date.now();
      for (const [k, b] of buckets) if (now - b.first > windowMs) buckets.delete(k);
    },
  };
}

// Fondo propio tal como lo ve el cliente: el nombre del archivo solo se usa como
// versión en la URL para que un fondo nuevo no salga de la caché del navegador.
function publicBackground({ file, opacity }) {
  return { url: file ? `/api/background?v=${encodeURIComponent(file)}` : null, opacity };
}

const BCRYPT_COST = 12;
const MIN_PASSWORD_LENGTH = 10;
const MAX_PASSWORD_BYTES = 72; // bcrypt ignora lo que pase de 72 bytes

function newSessionId() {
  return crypto.randomBytes(12).toString('base64url');
}

function createAuth({ db, config, log, users }) {
  // Hash ficticio: se compara igualmente cuando el usuario no existe para que el
  // tiempo de respuesta no revele qué usuarios existen.
  const dummyHash = bcrypt.hashSync(crypto.randomBytes(16).toString('hex'), 10);
  const limiter = createLoginLimiter();
  const sweepTimer = setInterval(() => {
    limiter.sweep();
    db.run('DELETE FROM sessions WHERE expires_at < ?', [Date.now()]).catch(() => {});
  }, 10 * 60 * 1000);
  sweepTimer.unref();

  async function verifyCredentials(username, password) {
    const name = String(username || '').trim().toLowerCase();
    const row = users.get(name);
    const hash = row ? row.password_hash : null;
    const ok = await bcrypt.compare(String(password || ''), hash || dummyHash);
    return ok && hash ? name : null;
  }

  async function createSession(username, userAgent = '') {
    const token = crypto.randomBytes(32).toString('base64url');
    const id = newSessionId();
    const now = Date.now();
    const expiresAt = now + config.sessionTtlMs;
    await db.run(
      'INSERT INTO sessions (token_hash, id, username, created_at, expires_at, last_seen_at, user_agent) VALUES (?,?,?,?,?,?,?)',
      [sha256(token), id, username, now, expiresAt, now, String(userAgent).slice(0, 200)]
    );
    return { token, id, expiresAt };
  }

  // Devuelve { username, id } o null.
  async function resolveSession(token) {
    if (typeof token !== 'string' || token.length < 20 || token.length > 200) return null;
    const hash = sha256(token);
    const row = await db.get('SELECT id, username, expires_at, last_seen_at FROM sessions WHERE token_hash = ?', [hash]);
    if (!row) return null;
    const now = Date.now();
    if (row.expires_at < now) {
      await db.run('DELETE FROM sessions WHERE token_hash = ?', [hash]).catch(() => {});
      return null;
    }
    // Usuario eliminado de la tabla users → su sesión deja de valer.
    if (!users.has(row.username)) return null;
    if (now - row.last_seen_at > SLIDING_REFRESH_MS) {
      db.run('UPDATE sessions SET last_seen_at = ?, expires_at = ? WHERE token_hash = ?',
        [now, now + config.sessionTtlMs, hash]).catch(() => {});
    }
    return { username: row.username, id: row.id };
  }

  async function revokeSession(token) {
    if (typeof token !== 'string') return;
    await db.run('DELETE FROM sessions WHERE token_hash = ?', [sha256(token)]);
  }

  function extractToken(req, { allowCookie }) {
    const header = req.headers.authorization;
    if (header) {
      const m = /^Bearer\s+(.+)$/i.exec(header);
      return { token: (m ? m[1] : header).trim(), viaCookie: false };
    }
    if (allowCookie) {
      const token = parseCookies(req.headers.cookie)[SESSION_COOKIE];
      if (token) return { token, viaCookie: true };
    }
    return { token: null, viaCookie: false };
  }

  function cookieIsSecure(req) {
    return config.cookieSecure === 'auto' ? Boolean(req.secure) : config.cookieSecure;
  }

  function setSessionCookie(req, res, token, expiresAt) {
    const maxAge = Math.max(0, Math.floor((expiresAt - Date.now()) / 1000));
    const parts = [
      `${SESSION_COOKIE}=${encodeURIComponent(token)}`,
      'Path=/api', 'HttpOnly', 'SameSite=Lax', `Max-Age=${maxAge}`,
    ];
    if (cookieIsSecure(req)) parts.push('Secure');
    res.append('Set-Cookie', parts.join('; '));
  }

  function clearSessionCookie(req, res) {
    const parts = [`${SESSION_COOKIE}=`, 'Path=/api', 'HttpOnly', 'SameSite=Lax', 'Max-Age=0'];
    if (cookieIsSecure(req)) parts.push('Secure');
    res.append('Set-Cookie', parts.join('; '));
  }

  // Middleware principal: valida la sesión y fija req.user (siempre un usuario
  // existente y con nombre validado, nunca texto arbitrario del cliente).
  async function requireAuth(req, res, next) {
    try {
      const safeMethod = req.method === 'GET' || req.method === 'HEAD';
      const allowCookie = safeMethod || COOKIE_POST_ALLOWLIST.has(req.path);
      const { token, viaCookie } = extractToken(req, { allowCookie });
      const session = token ? await resolveSession(token) : null;
      if (!session) return res.status(401).json({ error: 'No autorizado' });
      const user = session.username;
      req.user = user;
      req.isAdmin = users.isAdmin(user);
      req.sessionToken = token;
      req.sessionId = session.id;
      req.authViaCookie = viaCookie;
      return next();
    } catch (err) {
      return next(err);
    }
  }

  function requireAdmin(req, res, next) {
    if (!req.isAdmin) return res.status(403).json({ error: 'Solo administradores' });
    return next();
  }

  function clientIp(req) {
    return req.ip || req.socket?.remoteAddress || 'desconocida';
  }

  async function login(req, res) {
    const { username, password } = req.body;
    const name = String(username || '').trim().toLowerCase().slice(0, 64);
    const ip = clientIp(req);
    const wait = limiter.check(ip, name);
    if (wait > 0) {
      res.setHeader('Retry-After', String(wait));
      return res.status(429).json({ error: `Demasiados intentos. Espera ${Math.ceil(wait / 60)} min.` });
    }
    const user = await verifyCredentials(name, password);
    if (!user) {
      limiter.fail(ip, name);
      log(`[Auth] Login fallido para "${name.replace(/[^\w.-]/g, '?')}" desde ${ip}`);
      return res.status(401).json({ error: 'Credenciales incorrectas' });
    }
    limiter.succeed(ip, name);
    const { token, expiresAt } = await createSession(user, req.headers['user-agent']);
    setSessionCookie(req, res, token, expiresAt);
    log(`[Auth] Sesión iniciada: ${user}`);
    return res.json({ token, user, isAdmin: users.isAdmin(user), hiddenThemes: users.hiddenThemes(user), defaultPlaylist: users.defaultPlaylist(user), background: publicBackground(users.background(user)), expiresAt });
  }

  async function logout(req, res) {
    await revokeSession(req.sessionToken);
    clearSessionCookie(req, res);
    return res.json({ success: true });
  }

  // Devuelve el usuario actual y (re)emite la cookie si se llegó por cabecera:
  // así los clientes que ya tenían token recuperan el acceso a /stream y /cover.
  async function session(req, res) {
    if (!req.authViaCookie) {
      setSessionCookie(req, res, req.sessionToken, Date.now() + config.sessionTtlMs);
    }
    return res.json({ user: req.user, isAdmin: req.isAdmin, hiddenThemes: users.hiddenThemes(req.user), defaultPlaylist: users.defaultPlaylist(req.user), background: publicBackground(users.background(req.user)) });
  }

  // ─── FASE 2: cambio de contraseña y gestión de sesiones ─────────────────────

  function passwordProblem(password) {
    if (typeof password !== 'string' || password.length < MIN_PASSWORD_LENGTH) {
      return `La contraseña debe tener al menos ${MIN_PASSWORD_LENGTH} caracteres`;
    }
    if (Buffer.byteLength(password, 'utf8') > MAX_PASSWORD_BYTES) {
      return `La contraseña no puede superar ${MAX_PASSWORD_BYTES} bytes`;
    }
    return null;
  }

  // POST /api/auth/change-password { currentPassword, newPassword, revokeOtherSessions? }
  async function changePassword(req, res) {
    const { currentPassword, newPassword, revokeOtherSessions = true } = req.body;
    const ip = clientIp(req);
    const wait = limiter.check(ip, req.user);
    if (wait > 0) {
      res.setHeader('Retry-After', String(wait));
      return res.status(429).json({ error: `Demasiados intentos. Espera ${Math.ceil(wait / 60)} min.` });
    }
    const ok = await verifyCredentials(req.user, currentPassword);
    if (!ok) {
      limiter.fail(ip, req.user);
      log(`[Auth] Cambio de contraseña rechazado para ${req.user} (contraseña actual incorrecta) desde ${ip}`);
      return res.status(403).json({ error: 'La contraseña actual no es correcta' });
    }
    const problem = passwordProblem(newPassword);
    if (problem) return res.status(400).json({ error: problem });
    if (newPassword === currentPassword) return res.status(400).json({ error: 'La nueva contraseña debe ser distinta de la actual' });

    limiter.succeed(ip, req.user);
    const hash = await bcrypt.hash(newPassword, BCRYPT_COST);
    // Cambio de hash y revocación del resto de sesiones en una sola transacción.
    const revoked = db.transaction(() => {
      users.setPasswordHash(req.user, hash);
      if (!revokeOtherSessions) return 0;
      return db.runSync('DELETE FROM sessions WHERE username = ? AND id IS NOT ?', [req.user, req.sessionId]).changes;
    });
    log(`[Auth] Contraseña cambiada: ${req.user} (${revoked} sesiones revocadas)`);
    return res.json({ success: true, revokedSessions: revoked });
  }

  // GET /api/auth/sessions → sesiones activas del usuario (nunca el token ni su hash).
  async function listSessions(req, res) {
    const rows = await db.all(
      'SELECT id, created_at, last_seen_at, expires_at, user_agent FROM sessions WHERE username = ? AND expires_at >= ? ORDER BY last_seen_at DESC',
      [req.user, Date.now()]
    );
    return res.json(rows.map(r => ({
      id: r.id,
      createdAt: r.created_at,
      lastSeenAt: r.last_seen_at,
      expiresAt: r.expires_at,
      userAgent: r.user_agent || '',
      current: r.id === req.sessionId,
    })));
  }

  // DELETE /api/auth/sessions/:id → revoca UNA sesión propia.
  async function revokeSessionById(req, res) {
    const { id } = req.params;
    const { changes } = await db.run('DELETE FROM sessions WHERE id = ? AND username = ?', [id, req.user]);
    if (changes !== 1) return res.status(404).json({ error: 'Sesión no encontrada' });
    const current = id === req.sessionId;
    if (current) clearSessionCookie(req, res);
    log(`[Auth] Sesión revocada por ${req.user}${current ? ' (la actual)' : ''}`);
    return res.json({ success: true, current });
  }

  // DELETE /api/auth/sessions → revoca todas las sesiones propias salvo la actual.
  async function revokeOtherSessions(req, res) {
    const { changes } = await db.run('DELETE FROM sessions WHERE username = ? AND id IS NOT ?', [req.user, req.sessionId]);
    log(`[Auth] ${req.user} cerró ${changes} sesiones en otros dispositivos`);
    return res.json({ success: true, revokedSessions: changes });
  }

  function close() {
    clearInterval(sweepTimer);
  }

  return {
    requireAuth, requireAdmin, login, logout, session,
    changePassword, listSessions, revokeSessionById, revokeOtherSessions, passwordProblem,
    verifyCredentials, createSession, resolveSession, revokeSession, close,
  };
}

module.exports = { createAuth, publicBackground, createLoginLimiter, parseCookies, SESSION_COOKIE, MIN_PASSWORD_LENGTH, BCRYPT_COST };
