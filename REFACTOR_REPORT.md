# Informe de refactorización — trazabilidad con `AUDIT_GRAPH_EN.md`

Cada nodo del grafo de auditoría, con el cambio aplicado y dónde vive. Verificación: `npm test` (34 pruebas sin dependencias externas), `npm run check`; migraciones, sincronización, Resumen, `/stats/listen`, sesiones/limitador, rutas de portadas y el flujo de sustitución atómica (con un yt-dlp simulado) ejecutados contra una copia de la `database.sqlite` real; análisis estático del frontend (parseo JSX + comprobación de identificadores) y revisión independiente cuyos hallazgos se corrigieron (ver `FUTURE_IMPROVEMENTS_AND_RECOMMENDATIONS.md` §1, puntos 34–43).

## Fase 0 — Secretos

| Nodo | Cambio | Archivos |
|---|---|---|
| SEC-00 (C-4) | Eliminados `token` y `nya`. Credenciales (usuarios, Gemini, Last.fm, GitHub, SSH) solo vía `.env` con `dotenv`; plantilla `.env.example` y asistente `npm run setup`. `.gitignore` cubre `.env`, BD, WAL, backups. Scripts de despliegue con contraseña SSH y `AutoAddPolicy` sustituidos por `tools/remote_ops.py` (clave SSH + `RejectPolicy`). `bajar.sh` ya no mete el token en la URL del remoto; `update.sh` aborta si la URL contiene credenciales. `subir.sh`/`auto_commit.bat` se niegan a subir secretos versionados. La clave de Gemini viaja en cabecera `x-goog-api-key`, no en la URL. | `src/config.js`, `.env.example`, `scripts/setup-env.js`, `tools/remote_ops.py`, `deploy/update.sh`, `src/services/genres.js` |

**Pendiente del propietario** (no automatizable): rotar todas las credenciales expuestas y purgar el historial de git (ver README).

## Fase 1 — Autenticación y autorización

| Nodo | Cambio | Archivos |
|---|---|---|
| AUTH-01 (C-1) | Token estático sustituido por sesiones aleatorias de 256 bits (`crypto.randomBytes`), guardadas como SHA-256 en la tabla `sessions`, con caducidad deslizante y logout (revocación). Contraseñas bcrypt (comparación de tiempo constante con hash ficticio si el usuario no existe). `req.user` solo procede de una sesión válida de un usuario existente; nombres validados con `^[a-z0-9_-]{1,32}$`. Limitador de login por IP y por IP+usuario (429 + `Retry-After`). El cliente ya no decodifica el usuario del token. | `src/auth.js`, `src/config.js`, `routes/auth.js`, `App.jsx` |
| AUTH-02 (C-2) | `/api/cover/*` exige sesión, resuelve la ruta canónica con `path.resolve` y comprueba contención estricta (`path.relative`, sin falsos positivos por prefijo tipo `music_backup/`), solo dentro de la carpeta del propio usuario y solo extensiones de imagen. Descarga del worker restringida a trabajos activos. | `src/paths.js`, `routes/media.js`, `routes/subtitleWorker.js` |
| AUTH-03 (A-1) | `/api/stream/:id` y `/api/stream/ai/:id` exigen sesión y propiedad (`WHERE id = ? AND username = ?`). `<audio>`/`<img>`/`sendBeacon` se autentican con cookie `HttpOnly; SameSite=Lax; Path=/api`, aceptada solo en GET/HEAD y en `POST /stats/listen`: desaparece `?token=` de las URLs y de los logs. Eliminada la resolución `path.join(__dirname, file_path)` que podía salir de `music/`. | `src/auth.js`, `routes/media.js` |
| AUTH-04 (A-2) | Todas las rutas de playlists verifican propiedad de la playlist y de la canción. `DELETE /playlists/:id` borra en transacción solo si la playlist es del usuario. `playlistId` de `/import` y `/download-single` validado antes de encolar. | `routes/playlists.js`, `src/http.js`, `routes/importer.js` |
| AUTH-05 (A-8) | yt-dlp se ejecuta con `spawn` y el objetivo siempre tras `--`. Lista blanca https de YouTube para `/download-single`; Spotify solo `open.spotify.com/(playlist|album)/…`. Portadas descargadas con `safeFetch`: bloqueo de RFC 1918, loopback, link-local, CGNAT/Tailscale (100.64/10), ULA IPv6, IPv4 mapeada, validación también en el `lookup` del socket (anti DNS rebinding), redirecciones revalidadas, timeout 10 s y límite 5 MB. Eliminado `--no-check-certificate`. | `src/services/ytdlp.js`, `src/net/urlPolicy.js`, `src/net/ssrf.js` |
| AUTH-06 (M-5d, B-7) | Worker de subtítulos protegido con `SUBTITLE_WORKER_TOKEN` (comparación en tiempo constante); sin token solo se acepta loopback y únicamente si `HOST` es loopback. El cuerpo se parsea después de autenticar (límite 2 MB, antes 50 MB pre-auth), se valida `WEBVTT` y se escribe de forma atómica. Ya no se exponen rutas absolutas (ids opacos). `/api/logs`: log del sistema solo para `ADMIN_USERS`; el resto ve el progreso de sus propias tareas. Logger asíncrono con rotación por tamaño. | `routes/subtitleWorker.js`, `src/services/subtitles.js`, `src/logger.js`, `routes/importer.js`, `tools/pc_subtitle_worker.py` |

## Fase 2 — Base de datos

| Nodo | Cambio | Archivos |
|---|---|---|
| DB-01 (A-3) | `INSERT OR REPLACE` sustituido por `INSERT … ON CONFLICT(file_path) DO UPDATE` que solo toca título, artista y portada (con `WHERE` para no escribir si no cambia nada). Se conservan `duration`, `genre`, `chorus_start_ms`, `playlist_order`, `discovered_via`, `added_at`. `fs.watch` filtra por usuario, extensión y excluye `.staging`; resincroniza solo al usuario afectado con debounce. Verificado: dos sincronizaciones seguidas → `changed:false` y metadatos intactos. | `src/services/library.js` |
| DB-02 (C-3, M-12) | `exec()` con interpolación eliminado. Duración con `music-metadata` (cabeceras), fallback `ffprobe` vía `execFile` y `ffmpeg -i` sin decodificar. Backfill sin ejecuciones solapadas y solo para canciones nuevas/sin duración. | `src/media/duration.js`, `jobs/durationBackfill.js` |
| DB-03 (A-4) | La migración de rutas se ejecuta una vez (`schema_migrations`), solo normaliza rutas sin prefijo respetando el propietario de la fila y tolera `file_path` NULL. | `src/migrations.js` |
| DB-04 (M-11) | `PRAGMA journal_mode=WAL; synchronous=NORMAL; busy_timeout`. Transacciones serializadas con cola de promesas (`db.transaction`) — no más "transaction within a transaction" — y las escrituras externas esperan a que terminen (no quedan atrapadas en un ROLLBACK ajeno). Sincronización y reordenaciones en una sola transacción. | `src/db.js`, `src/migrations.js` |
| DB-05 (A-10) | Escuchas IA con `is_ai=1`, `ai_rec_id` y `song_id NULL`. Resumen filtrado estrictamente por `username = ?` (también en los JOIN). `discovered_via` seleccionado; `aiTopSong` solo si existe una canción descubierta por IA. Datos demo con ids negativos y sin audio. | `routes/stats.js`, `routes/wrapped.js`, `WrappedEngine.jsx` |

## Fase 3 — Pipeline multimedia

| Nodo | Cambio | Archivos |
|---|---|---|
| MEDIA-01 (M-1) | `/cover/ai/*` registrada antes que `/cover/*`; además `sendFile` con `dotfiles:'allow'` (la ruta `.ai_music` devolvía 404 aunque el orden fuera correcto). | `routes/media.js` |
| MEDIA-02 (M-3, M-4) | Parser Range RFC 9110 (sufijos, 416 con `Content-Range: bytes */size`), `If-Range`, `ETag`/304, `pipeline()` con manejo de errores y cierre. Throttle global eliminado (opcional con `STREAM_THROTTLE_KBPS`, nunca en precarga, sin fugas de temporizadores). Caché: `private, max-age=31536000, immutable` solo para URLs versionadas `?v=rev` (columna `songs.rev`); sin versión, `private, no-cache`. Se usa `private` y no `public` porque el contenido es autenticado. | `src/media/range.js`, `src/media/stream.js` |
| MEDIA-03 (A-7) | Sustituir: descarga a staging, cerrojo de biblioteca, original apartado como copia, misma fila actualizada (conserva id, playlists e historial), rollback completo si falla. Rechazar/saltar IA archiva en `.archive` (purga nocturna tras `AI_ARCHIVE_RETENTION_DAYS`); "siguiente" ya no es destructivo. Recortar: re-codificación con corte preciso, sustitución atómica con copia de seguridad, `.vtt` desplazado, duración/estribillo/`rev` actualizados. | `routes/importer.js`, `routes/songs.js`, `src/services/recommendations.js`, `src/media/vtt.js` |
| MEDIA-04 (M-13, M-14) | `/import` y `/download-single` devuelven `202 {taskId}`; `GET /api/tasks/:id`. Cola serie única para yt-dlp. Archivo del scraper por tarea, timeout 5 min, navegador siempre cerrado. Orden de importación tras el mayor prefijo existente (sin colisiones). JSON con límite configurable y 413 explícito. Errores no capturados → parada ordenada y reinicio por PM2. | `src/services/tasks.js`, `routes/importer.js`, `scraper/scrape.js`, `server.js`, `ecosystem.config.js` |

## Fase 4 — Service Worker / PWA

| Nodo | Cambio | Archivos |
|---|---|---|
| PWA-01 (A-9) | Las peticiones no-GET nunca se interceptan (sin timeout de 4 s ni 503 sintético en mutaciones). Caché de API por usuario según la cabecera `X-MP-User`; audio y portadas en `mp-songs-u:<usuario>`; logout purga la caché de API. Endpoints sensibles (`/logs`, `/session`, `/tasks`) nunca se cachean. | `public/sw.js`, `src/pwa.js`, `App.jsx` |
| PWA-02 (M-2) | URLs construidas con `URL`/`URLSearchParams` (`withParams`), sin token en la query; la precarga de pistas IA se autentica por cookie. | `src/lib/media.js`, `src/pwa.js` |
| PWA-03 (M-10) | Respuestas `206 Partial Content` sintetizadas desde el blob cacheado (y 416). Precarga desde la app (no en `waitUntil`), concurrencia 2, abortable, se detiene ante `QuotaExceededError`, no depende de `controller`. Revisiones antiguas eliminadas de la caché. El shell ya no devuelve 503 en cargas lentas sin caché. | `public/sw.js`, `src/pwa.js` |

## Fase 5 — Motor de audio

| Nodo | Cambio | Archivos |
|---|---|---|
| AUDIO-01 (A-5) | Los `<audio>` se montan siempre (también en el login), en la misma posición del árbol: keep-alive, watchdog y recuperación de `stalled` quedan enlazados tras iniciar sesión. | `App.jsx` (`audioElements`) |
| AUDIO-02 (A-6) | `onClick={() => handleNext(false)}` y `isNaturalEnd === true` estricto dentro de `handleNext`. | `App.jsx` |
| AUDIO-03 (M-9, B-8) | Tiempo escuchado = avance real de `currentTime` (descarta pausas, buffering y seeks). `pagehide` → `sendBeacon`. Servidor limita a duración + 5 s. Fin detectado por watchdog contabilizado como completado. Si la salida de audio cambia (`devicechange`) alrededor de una pausa del sistema, no se reanuda. | `App.jsx`, `routes/stats.js` |

## Fase 6 — Estado y UI

| Nodo | Cambio | Archivos |
|---|---|---|
| UI-01 (M-6, M-7) | Arrastre desactivado con filtro activo; índices traducidos a ids. Asa táctil con eventos pointer (`@media (pointer: coarse)`). Filas memorizadas llaman a acciones vía `rowActionsRef` (sin cierres obsoletos). Errores al guardar el orden → aviso y recarga. | `App.jsx`, `index.css` |
| UI-02 (M-8) | Una petición en vuelo, un único intervalo de sondeo limpiado al salir del modo IA/desmontar, `409` del servidor si ya hay generación, índice UNIQUE + deduplicación (42 grupos duplicados eliminados en la migración), historial limitado a 100. | `App.jsx`, `src/services/recommendations.js`, `src/migrations.js` |
| UI-03 (M-5a-c, B-4) | Subtítulos con `AbortController`, 3 reintentos (15/30/60 s) y soporte para pistas IA (`/subtitles/ai/:id`). Audio del editor de recorte liberado si se cierra antes de cargar. `.catch()` en todas las cadenas `fetch`. | `App.jsx`, `routes/media.js` |
| UI-04 (B-1..B-6) | `localStorage` siempre vía `lib/storage.js`. Claves estables (ids). Toasts con `crypto.randomUUID`. `prompt()`/`confirm()` → `AppDialog`. Watchdog parado en pausa de usuario. Eliminados `smartShuffle` (`/api/ai-shuffle` inexistente), `getTracks`/`spotify-url-info`, `ffprobePath`, ruta `/api/stats/wrapped` v1, `multer`, estados sin uso. `/api/songs` sin rutas absolutas y con comprobación asíncrona. | `App.jsx`, `src/lib/*`, `routes/songs.js`, `src/http.js` |

## Fase 7 — Despliegue

| Nodo | Cambio | Archivos |
|---|---|---|
| DEP-01 (M-15) | Un único proceso PM2 (`ecosystem.config.js`) que sirve API + `dist`. `deploy/update.sh` con `set -euo pipefail`: copia online (API de backup de SQLite, verificada con `integrity_check`), aborta si la BD está versionada o el remoto lleva credenciales, `npm ci`, compila en `dist-next` y solo entonces sustituye `dist`, retira los procesos antiguos antes de arrancar. `start.sh` de producción, `dev.sh` para desarrollo, `bajar.sh` delega en `update.sh`. | `deploy/update.sh`, `scripts/backup-db.js`, `ecosystem.config.js`, `start.sh`, `dev.sh` |

## Notas de compatibilidad

- `package-lock.json` del servidor se eliminó porque las dependencias cambiaron; `npm install` lo regenera (conviene versionarlo después).
- `GET /api/ai-recommendations/status` devuelve ahora `{ generating, counts }`.
- `POST /api/ai-recommendations/:id/skip` (botón siguiente) y `/played` (escuchada entera) son nuevos.
- `POST /api/songs/:id/trim` acepta `rev` opcional (409 si la canción cambió).
- Borrar una canción pide confirmación.
