'use strict';
// ─── CONFIGURACIÓN CENTRALIZADA ──────────────────────────────────────────────
// Toda la configuración sensible llega por variables de entorno (.env).
// Nunca se deben escribir credenciales en el código fuente (SEC-00).

const fs = require('fs');
const path = require('path');

const ROOT_DIR = path.resolve(__dirname, '..');
const USERNAME_RE = /^[a-z0-9_-]{1,32}$/;
const BCRYPT_RE = /^\$2[aby]\$\d{2}\$[./A-Za-z0-9]{53}$/;

class ConfigError extends Error {}

function parseUsers(raw) {
  const users = new Map();
  const entries = String(raw || '').split(',').map(s => s.trim()).filter(Boolean);
  for (const entry of entries) {
    const idx = entry.indexOf(':');
    if (idx <= 0) throw new ConfigError('APP_USERS mal formado: se esperaba "usuario:hashBcrypt,..."');
    const name = entry.slice(0, idx).trim().toLowerCase();
    const hash = entry.slice(idx + 1).trim();
    if (!USERNAME_RE.test(name)) {
      throw new ConfigError(`Nombre de usuario no válido en APP_USERS: "${name}" (solo a-z, 0-9, "_" y "-")`);
    }
    if (!BCRYPT_RE.test(hash)) {
      throw new ConfigError(`El usuario "${name}" no tiene un hash bcrypt válido. Genera uno con: npm run hash-password`);
    }
    users.set(name, hash);
  }
  return users;
}

function parseList(raw) {
  return String(raw || '').split(',').map(s => s.trim()).filter(Boolean);
}

function parseIntEnv(value, fallback, { min = -Infinity, max = Infinity } = {}) {
  const n = Number.parseInt(value, 10);
  if (!Number.isFinite(n)) return fallback;
  return Math.min(max, Math.max(min, n));
}

function parseTrustProxy(raw) {
  if (raw === undefined || raw === '') return 'loopback';
  if (raw === 'true') return true;
  if (raw === 'false') return false;
  if (/^\d+$/.test(raw)) return Number.parseInt(raw, 10);
  return raw; // lista de subredes/IPs aceptada por Express
}

function parseCookieSecure(raw) {
  if (raw === 'true') return true;
  if (raw === 'false') return false;
  return 'auto';
}

function loadConfig(env = process.env) {
  // FASE 2: los usuarios viven en la tabla `users`. APP_USERS es opcional y solo
  // siembra la BD en el arranque (src/users.js); si la BD está vacía y no hay
  // APP_USERS, el servidor se niega a arrancar (server.js).
  const users = parseUsers(env.APP_USERS);
  const admins = new Set(parseList(env.ADMIN_USERS).map(u => u.toLowerCase()));
  for (const admin of admins) {
    if (!USERNAME_RE.test(admin)) throw new ConfigError(`ADMIN_USERS contiene un nombre no válido: "${admin}"`);
  }

  const legacyOwner = (env.LEGACY_OWNER || [...users.keys()][0] || '').toLowerCase();
  if (legacyOwner && !USERNAME_RE.test(legacyOwner)) throw new ConfigError('LEGACY_OWNER no es un nombre de usuario válido');

  const workerToken = env.SUBTITLE_WORKER_TOKEN || '';
  if (workerToken && workerToken.length < 24) {
    throw new ConfigError('SUBTITLE_WORKER_TOKEN debe tener al menos 24 caracteres');
  }

  return Object.freeze({
    rootDir: ROOT_DIR,
    port: parseIntEnv(env.PORT, 3001, { min: 1, max: 65535 }),
    host: env.HOST || '0.0.0.0',
    trustProxy: parseTrustProxy(env.TRUST_PROXY),
    corsOrigins: parseList(env.CORS_ORIGINS),

    users,
    admins,
    sessionTtlMs: parseIntEnv(env.SESSION_TTL_DAYS, 30, { min: 1, max: 365 }) * 24 * 60 * 60 * 1000,
    cookieSecure: parseCookieSecure(env.COOKIE_SECURE),
    workerToken,

    geminiApiKey: env.GEMINI_API_KEY || '',
    geminiModel: env.GEMINI_MODEL || 'gemini-2.5-flash',
    lastfmApiKey: env.LASTFM_API_KEY || '',

    musicDir: path.resolve(ROOT_DIR, env.MUSIC_DIR || 'music'),
    aiMusicDir: path.resolve(ROOT_DIR, env.AI_MUSIC_DIR || '.ai_music'),
    dbPath: path.resolve(ROOT_DIR, env.DB_PATH || 'database.sqlite'),
    distDir: path.resolve(ROOT_DIR, 'frontend', 'dist'),
    logFile: path.resolve(ROOT_DIR, env.LOG_FILE || 'downloads.log'),
    logMaxBytes: parseIntEnv(env.LOG_MAX_BYTES, 5 * 1024 * 1024, { min: 64 * 1024 }),
    logMaxFiles: parseIntEnv(env.LOG_MAX_FILES, 3, { min: 1, max: 20 }),

    legacyOwner,

    // Transcripción local con faster-whisper (src/services/transcriber.js).
    // Activa por defecto si existe el venv; TRANSCRIBE_LOCAL=0 vuelve al worker
    // remoto del PC (/api/subtitles/worker).
    transcribe: (() => {
      const python = path.resolve(ROOT_DIR, env.WHISPER_PYTHON || 'whisper/.venv/bin/python');
      return Object.freeze({
        enabled: env.TRANSCRIBE_LOCAL === '1' || (env.TRANSCRIBE_LOCAL !== '0' && fs.existsSync(python)),
        python,
        script: path.resolve(ROOT_DIR, 'whisper', 'transcribe.py'),
        model: env.WHISPER_MODEL || 'small',
        computeType: env.WHISPER_COMPUTE_TYPE || 'int8',
        threads: parseIntEnv(env.WHISPER_THREADS, 3, { min: 1, max: 64 }),
        nice: parseIntEnv(env.WHISPER_NICE, 19, { min: 0, max: 19 }),
        timeoutMs: parseIntEnv(env.WHISPER_TIMEOUT_MS, 20 * 60 * 1000, { min: 60 * 1000 }),
      });
    })(),
    streamThrottleBps: parseIntEnv(env.STREAM_THROTTLE_KBPS, 0, { min: 0 }) * 1024,
    ytdlpPath: env.YTDLP_PATH || '',
    ffprobePath: env.FFPROBE_PATH || '',
    aiArchiveRetentionDays: parseIntEnv(env.AI_ARCHIVE_RETENTION_DAYS, 7, { min: 0, max: 365 }),
    aiPendingMaxAgeDays: parseIntEnv(env.AI_PENDING_MAX_AGE_DAYS, 3, { min: 1, max: 365 }),
    aiRetryAfterDays: parseIntEnv(env.AI_RETRY_AFTER_DAYS, 14, { min: 1, max: 3650 }),
    // Espera tras una generación que no trajo nada nuevo (IA-3).
    aiEmptyCooldownMinutes: parseIntEnv(env.AI_EMPTY_COOLDOWN_MINUTES, 60, { min: 1, max: 1440 }),
    // Géneros (IA-1): días hasta volver a intentar una canción no reconocida y
    // tope diario de peticiones a Gemini para clasificar (la cuota es compartida).
    genreRecheckDays: parseIntEnv(env.GENRE_RECHECK_DAYS, 30, { min: 1, max: 3650 }),
    genreGeminiDailyLimit: parseIntEnv(env.GENRE_GEMINI_DAILY_LIMIT, 6, { min: 0, max: 1000 }),
    jsonLimit: env.JSON_LIMIT || '10mb',

    // Importación de Spotify sin navegador (FASE 2). Con credenciales de la Web
    // API oficial se leen playlists/álbumes completos; sin ellas se usa el JSON
    // público del reproductor embebido (limitado a ~100 pistas por playlist).
    spotifyClientId: env.SPOTIFY_CLIENT_ID || '',
    spotifyClientSecret: env.SPOTIFY_CLIENT_SECRET || '',
    spotifyMarket: /^[A-Z]{2}$/.test(env.SPOTIFY_MARKET || '') ? env.SPOTIFY_MARKET : 'ES',

    // Logs estructurados (FASE 2): debug | info | warn | error; formato text | json.
    logLevel: ['debug', 'info', 'warn', 'error'].includes(String(env.LOG_LEVEL).toLowerCase()) ? String(env.LOG_LEVEL).toLowerCase() : 'info',
    logFormat: String(env.LOG_FORMAT).toLowerCase() === 'json' ? 'json' : 'text',

    // Cabeceras de seguridad (FASE 2). CSP_REPORT_ONLY=true para probar una CSP
    // más estricta sin bloquear nada.
    cspReportOnly: env.CSP_REPORT_ONLY === 'true',
    // Reintentos de un trabajo interrumpido por un reinicio antes de darlo por fallido.
    jobMaxAttempts: parseIntEnv(env.JOB_MAX_ATTEMPTS, 3, { min: 1, max: 10 }),
  });
}

module.exports = { loadConfig, ConfigError, USERNAME_RE, BCRYPT_RE, parseUsers };
