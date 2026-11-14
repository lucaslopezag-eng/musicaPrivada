'use strict';
// ─── MusicaPrivada · servidor ────────────────────────────────────────────────
// Punto de entrada. Toda la lógica vive en src/ (servicios) y routes/ (HTTP).
// Orden de arranque: configuración → BD + migraciones → usuarios (siembra
// desde .env) → rutas → sincronización de biblioteca → recuperación de
// trabajos interrumpidos → tareas en segundo plano → escuchar.

require('dotenv').config();

const path = require('path');
const fs = require('fs');
const crypto = require('crypto');
const express = require('express');
const fetch = require('node-fetch');
const ffmpegPath = require('ffmpeg-static');

const { loadConfig, ConfigError } = require('./src/config');
const { createLogger } = require('./src/logger');
const { openDatabase } = require('./src/db');
const { migrate } = require('./src/migrations');
const { createAuth } = require('./src/auth');
const { createUserStore } = require('./src/users');
const { createSecurityHeaders } = require('./src/security');
const { createSpotifyClient } = require('./src/services/spotify');
const { createLibrary } = require('./src/services/library');
const { createTaskManager, createSerialQueue } = require('./src/services/tasks');
const { createYtDlp } = require('./src/services/ytdlp');
const { createSubtitleQueue } = require('./src/services/subtitles');
const { createTranscriber } = require('./src/services/transcriber');
const { createLoudnessAnalyzer } = require('./src/services/loudness');
const { createGenreClassifier, createGemini } = require('./src/services/genres');
const { createRecommendations } = require('./src/services/recommendations');
const { createDurationProbe } = require('./src/media/duration');
const runDurationBackfill = require('./jobs/durationBackfill');

const { publicAuthRouter, privateAuthRouter } = require('./routes/auth');
const subtitleWorkerRouter = require('./routes/subtitleWorker');
const songsRouter = require('./routes/songs');
const playlistsRouter = require('./routes/playlists');
const mediaRouter = require('./routes/media');
const statsRouter = require('./routes/stats');
const wrappedRouter = require('./routes/wrapped');
const importerRouter = require('./routes/importer');
const aiRouter = require('./routes/ai');
const themesRouter = require('./routes/themes');
const backgroundRouter = require('./routes/background');

async function main() {
  let config;
  try {
    config = loadConfig();
  } catch (err) {
    if (err instanceof ConfigError) {
      console.error(`\n[Config] ${err.message}\n`);
      process.exit(1);
    }
    throw err;
  }

  const logger = createLogger({
    file: config.logFile, maxBytes: config.logMaxBytes, maxFiles: config.logMaxFiles,
    level: config.logLevel, format: config.logFormat,
  });
  const log = logger.log;

  fs.mkdirSync(config.musicDir, { recursive: true });
  fs.mkdirSync(config.aiMusicDir, { recursive: true });

  const db = await openDatabase(config.dbPath);
  logger.info(`Conectado a SQLite (${db.driver}).`);

  // FASE 2: usuarios en BD. APP_USERS/ADMIN_USERS solo siembran la tabla.
  // Las migraciones de esquema van primero (crean `users`); LEGACY_OWNER se
  // resuelve después si el .env ya no tiene APP_USERS.
  const users = createUserStore({ db, log });
  const migrationCtx = {
    log,
    rootDir: config.rootDir,
    musicDir: config.musicDir,
    aiMusicDir: config.aiMusicDir,
    get legacyOwner() { return config.legacyOwner || users.list()[0] || 'skiper'; },
  };
  await migrate(db, migrationCtx);
  users.seedFromConfig({ users: config.users, admins: config.admins });
  if (users.count() === 0) {
    console.error('\n[Config] No hay usuarios: ni en la base de datos ni en APP_USERS. Ejecuta "npm run setup" o "npm run user -- add <usuario>".\n');
    process.exit(1);
  }

  // ─── Servicios ─────────────────────────────────────────────────────────────
  const probeDurationMs = createDurationProbe({ ffmpegPath, ffprobePath: config.ffprobePath });
  const runBackfill = () => runDurationBackfill({ db, musicDir: config.musicDir, probeDurationMs, log });
  let backfillTimer = null;
  const scheduleBackfill = () => {
    if (backfillTimer) clearTimeout(backfillTimer);
    backfillTimer = setTimeout(() => { backfillTimer = null; runBackfill(); }, 5000);
  };

  const auth = createAuth({ db, config, log, users });
  const tasks = createTaskManager({ log, db, maxAttempts: config.jobMaxAttempts });
  const ytdlp = createYtDlp({ config, ffmpegPath, log });
  const transcriber = config.transcribe.enabled ? createTranscriber({ db, config, log }) : null;
  const subtitles = createSubtitleQueue({ config, log, local: transcriber });
  const gemini = createGemini({ config, fetch, log });
  let library;
  // SRV-4: mismo ffmpeg que el resto del proyecto (ffmpeg-static), no el del sistema.
  const loudness = createLoudnessAnalyzer({ db, config, log, ffmpeg: ffmpegPath, onUpdated: () => library.bumpVersion() });
  const genres = createGenreClassifier({ db, config, fetch, log, gemini, onUpdated: (user) => library.bumpVersion(user) });
  library = createLibrary({
    db, config, log, users,
    onSongsAdded: (user) => { scheduleBackfill(); genres.classifyGenres(user); loudness.kick(); },
  });
  // SRV-2: las recomendaciones IA descargan por su propia cola, sin esperar a las
  // importaciones ni a las descargas de los usuarios.
  const recs = createRecommendations({ db, config, fetch, log, gemini, ytdlp, downloadQueue: createSerialQueue(), library, users });
  const spotify = createSpotifyClient({
    clientId: config.spotifyClientId, clientSecret: config.spotifyClientSecret, market: config.spotifyMarket, log,
  });
  if (!spotify.hasCredentials) {
    logger.info('[Spotify] Sin SPOTIFY_CLIENT_ID/SECRET: las importaciones usarán el reproductor embebido (máx. ~100 pistas por playlist).');
  }

  const ctx = {
    db, config, log, logger, auth, users, tasks, ytdlp, subtitles, transcriber, genres, recs, library, spotify,
    probeDurationMs, ffmpegPath, runBackfill,
  };

  // ─── Aplicación Express ────────────────────────────────────────────────────
  const app = express();
  app.disable('x-powered-by');
  app.set('trust proxy', config.trustProxy);

  if (config.corsOrigins.length > 0) {
    const cors = require('cors');
    app.use('/api', cors({ origin: config.corsOrigins, credentials: true }));
  }

  // FASE 2: helmet (CSP estricta, X-Frame-Options DENY, nosniff, HSTS...) y
  // un identificador por petición para correlacionar logs (X-Request-Id).
  app.use(createSecurityHeaders({ reportOnly: config.cspReportOnly, log }));
  app.use((req, res, next) => {
    const incoming = req.get('x-request-id');
    req.id = incoming && /^[A-Za-z0-9._-]{1,64}$/.test(incoming) ? incoming : crypto.randomBytes(6).toString('hex');
    res.setHeader('X-Request-Id', req.id);
    if (logger.isLevelEnabled('debug') && req.path.startsWith('/api')) {
      const started = process.hrtime.bigint();
      res.on('finish', () => {
        const ms = Number(process.hrtime.bigint() - started) / 1e6;
        logger.debug(`${req.method} ${req.originalUrl.split('?')[0]} ${res.statusCode}`, {
          reqId: req.id, user: req.user, ms: Math.round(ms),
        });
      });
    }
    next();
  });

  // Rutas públicas: login y worker de subtítulos (con su propio secreto).
  app.use('/api', publicAuthRouter(ctx));
  app.use('/api/subtitles/worker', subtitleWorkerRouter(ctx));

  // A partir de aquí todo /api exige sesión. El body JSON se parsea DESPUÉS de
  // autenticar, con límite explícito (MEDIA-04).
  app.use('/api', auth.requireAuth);
  app.use('/api', express.json({ limit: config.jsonLimit }));
  app.use('/api', privateAuthRouter(ctx));
  app.use('/api', mediaRouter(ctx));
  app.use('/api', songsRouter(ctx));
  app.use('/api', playlistsRouter(ctx));
  app.use('/api', statsRouter(ctx));
  app.use('/api/stats', wrappedRouter(ctx));
  app.use('/api', importerRouter(ctx));
  app.use('/api', aiRouter(ctx));
  app.use('/api', themesRouter(ctx));
  app.use('/api', backgroundRouter(ctx));

  app.use('/api', (req, res) => res.status(404).json({ error: 'Ruta no encontrada' }));

  // ─── Frontend compilado ────────────────────────────────────────────────────
  if (fs.existsSync(config.distDir)) {
    app.get('/sw.js', (req, res) => {
      res.setHeader('Content-Type', 'application/javascript');
      res.setHeader('Service-Worker-Allowed', '/');
      res.setHeader('Cache-Control', 'no-cache, no-store, must-revalidate');
      res.sendFile(path.join(config.distDir, 'sw.js'));
    });
    // Las imágenes de temas solo salen por /api/themes (con control por usuario).
    app.use('/themes', (req, res) => res.status(404).end());
    app.use(express.static(config.distDir, { index: false }));
    app.use((req, res, next) => {
      if (req.method === 'GET' && !req.path.startsWith('/api')) {
        res.setHeader('Cache-Control', 'no-cache');
        return res.sendFile(path.join(config.distDir, 'index.html'));
      }
      return next();
    });
    log('Sirviendo el frontend desde frontend/dist');
  } else {
    log('Aviso: no existe frontend/dist. Ejecuta "npm run build" antes de producción.');
  }

  // ─── Manejador de errores ──────────────────────────────────────────────────
  // eslint-disable-next-line no-unused-vars
  app.use((err, req, res, next) => {
    if (err && err.type === 'entity.too.large') {
      return res.status(413).json({ error: 'La petición es demasiado grande', limit: config.jsonLimit });
    }
    if (err && err.type === 'entity.parse.failed') {
      return res.status(400).json({ error: 'JSON no válido' });
    }
    const status = err && Number.isInteger(err.status) && err.status >= 400 && err.status < 600 ? err.status : 500;
    if (status >= 500) {
      logger.error(`[HTTP ${status}] ${req.method} ${req.originalUrl.split('?')[0]}: ${err && err.message ? err.message : err}`, {
        reqId: req.id, user: req.user, stack: err && err.stack,
      });
    }
    if (res.headersSent) return res.end();
    return res.status(status).json({ error: status >= 500 ? 'Error interno del servidor' : err.message });
  });

  // ─── Arranque de tareas ────────────────────────────────────────────────────
  await library.syncAll();
  library.startWatcher();
  // FASE 2: los trabajos que un reinicio dejó a medias se reanudan o se cierran.
  tasks.recover();
  // R1: las recomendaciones IA que un reinicio dejó en 'pending' se reanudan o caducan.
  await recs.recoverPending().catch(err => log(`[IA] Error al recuperar recomendaciones pendientes: ${err.stack || err.message}`));
  scheduleBackfill();
  recs.scheduleNightly();
  // Refresco manual completo (pm2 sendSignal SIGUSR2 musica-privada): genera una tanda para quien tenga menos de 20 listas.
  process.on("SIGUSR2", async () => {
    // SRV-3: un fallo aquí acababa como unhandledRejection y cerraba el servidor.
    try {
      for (const u of users.list()) {
        const row = await db.get("SELECT COUNT(*) AS cnt FROM ai_recommendations WHERE status = 'downloaded' AND username = ?", [u]);
        if ((row?.cnt || 0) >= 20) { logger.info(`[IA] Refresco manual: ${u} ya tiene ${row.cnt} listas, se omite.`); continue; }
        logger.info(`[IA] Refresco manual para ${u}: ${recs.generate(u, 25) ? "iniciado" : "ya había una generación en curso"}.`);
      }
    } catch (err) {
      logger.error(`[IA] Error en el refresco manual: ${err && err.stack ? err.stack : err}`);
    }
  });
  // Clasificación de géneros 30 s después de arrancar (MusicBrainz 1 req/s).
  const genresTimer = setTimeout(async () => {
    for (const user of users.list()) {
      await genres.classifyGenres(user);
    }
  }, 30000);
  genresTimer.unref();

  const server = app.listen(config.port, config.host, () => {
    log(`Servidor escuchando en http://${config.host}:${config.port}`);
  });
  if (transcriber) transcriber.start();
  loudness.start();

  // ─── Parada ordenada (MEDIA-04) ────────────────────────────────────────────
  // Ante un error no capturado el proceso queda en estado indeterminado: se
  // registra, se cierra lo posible y se sale con código 1 para que PM2 reinicie.
  let shuttingDown = false;
  async function shutdown(reason, code) {
    if (shuttingDown) return;
    shuttingDown = true;
    log(`[Proceso] Cerrando (${reason})...`);
    const force = setTimeout(() => process.exit(code), 8000);
    force.unref();
    try {
      library.stopWatcher();
      if (transcriber) transcriber.stop();
      loudness.stop();
      recs.stop();
      auth.close();
      tasks.flush();
      await new Promise((resolve) => server.close(() => resolve()));
      await db.close();
      await logger.close();
    } catch (err) {
      console.error('[Proceso] Error durante el cierre:', err);
    }
    process.exit(code);
  }

  process.on('SIGTERM', () => shutdown('SIGTERM', 0));
  process.on('SIGINT', () => shutdown('SIGINT', 0));
  process.on('uncaughtException', (err) => {
    log(`[uncaughtException] ${err && err.stack ? err.stack : err}`);
    shutdown('uncaughtException', 1);
  });
  process.on('unhandledRejection', (reason) => {
    log(`[unhandledRejection] ${reason && reason.stack ? reason.stack : reason}`);
    shutdown('unhandledRejection', 1);
  });
}

main().catch((err) => {
  console.error('[Arranque] Error fatal:', err);
  process.exit(1);
});
