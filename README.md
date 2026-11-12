# MusicaPrivada

![Node](https://img.shields.io/badge/Node.js-%E2%89%A520-339933?logo=node.js&logoColor=white)
![Express](https://img.shields.io/badge/Express-5-000000?logo=express)
![React](https://img.shields.io/badge/React-19-61dafb?logo=react&logoColor=black)
![Vite](https://img.shields.io/badge/Vite-8-646cff?logo=vite&logoColor=white)
![SQLite](https://img.shields.io/badge/SQLite-better--sqlite3-003b57?logo=sqlite)
![PWA](https://img.shields.io/badge/PWA-offline_ready-5a0fc8)

**A self-hosted, Spotify-style music library for you and your friends.**

MusicaPrivada is a private streaming server: an Express 5 + SQLite API that serves a React 19 Progressive Web App. Your library lives on your own machine. You get background playback on phones, synced lyrics generated locally with Whisper, AI-powered recommendations, playlist import, per-user themes, and a yearly "Wrapped" recap of your listening.

---

## Table of contents

- [Highlights](#highlights)
- [Architecture](#architecture)
- [Tech stack](#tech-stack)
- [Getting started](#getting-started)
- [Configuration](#configuration)
- [Day-to-day operations](#day-to-day-operations)
- [Synced lyrics with Whisper](#synced-lyrics-with-whisper)
- [Security model](#security-model)
- [Project structure](#project-structure)
- [Testing](#testing)
- [Legal notice](#legal-notice)

---

## Highlights

### 🎧 Player
- Background playback with lock-screen controls through the Media Session API.
- A queue panel, smart shuffle modes, and playback position that survives a restart.
- **Loudness normalization**: tracks are levelled so volume does not jump between songs, and the volume slider follows a perceptual curve.
- Optional mobile boost (about ×1.9) through a Web Audio gain stage with a soft saturator instead of a hard limiter. The screen shows when it is on.
- HTTP range streaming (RFC 9110), so seeking is instant and the server can throttle bandwidth.

### 📚 Library
- Multiple users, each with their own songs, playlists and history.
- **Playlist import**: read playlists over plain HTTP with no headless browser. Add Spotify API credentials to import playlists longer than about 100 tracks.
- A persistent job queue for downloads and imports. Jobs survive restarts and retry automatically.
- A virtualized song list that stays smooth with thousands of tracks.
- A trim editor to cut silence or intros from a track.

### ✨ Smart features
- **AI recommendations** from Last.fm similarity data, falling back to Google Gemini. Duplicates are filtered out, and rejected suggestions are archived.
- **Automatic genre classification**.
- **Wrapped**: a yearly recap with top songs and artists, listening streaks, peak hour, monthly vibe and fun facts. It uses your own time zone.
- **Synced lyrics** (`.vtt`) transcribed locally with faster-whisper, highlighted line by line while the song plays.

### 📱 App experience
- An installable PWA with an offline cache, easy install on iPhone, and safe-area margins.
- Per-user visual themes, custom wallpapers with transparency, and the option to hide themes per user.
- A sticky search bar, a mobile navigation bar and a resizable desktop sidebar.

## Architecture

```
        ┌────────────────────────── Browser / installed PWA ───────────────────────────┐
        │  React 19 · hooks (usePlayer, useLibrary, useSubtitles, useOfflineCache, …)  │
        │  Service worker: offline cache, versioned updates                            │
        └──────────────────────────────────────┬───────────────────────────────────────┘
                                               │ HTTPS · session cookie (HttpOnly)
┌──────────────────────────────────────────────▼─────────────────────────────────────────────┐
│ Express 5 API (server.js)                                                                   │
│  helmet CSP · rate limiting · validation schemas · SSRF guard · safe path resolution        │
│  routes/: auth · songs · playlists · media · importer · ai · stats · wrapped · themes · …   │
│                                                                                             │
│  services/: library · job queue · yt-dlp · subtitles/transcriber · genres · recommendations │
│             · loudness · spotify reader                                                     │
└───────────────┬──────────────────────────────┬──────────────────────────────┬───────────────┘
                │                              │                              │
         SQLite (better-sqlite3)         music/ on disk          faster-whisper (local)
         users · songs · jobs ·          audio + .vtt lyrics     or a remote worker over
         sessions · history                                      HTTP with a shared token
```

When the server starts it runs these steps in order: **config → database and migrations → users → routes → background tasks → listen**. Migrations are idempotent, so upgrading means pulling the code and restarting.

## Tech stack

| Layer | Technology |
|---|---|
| Backend | Node.js ≥ 20, Express 5, better-sqlite3 (falls back to `node:sqlite` on Node ≥ 22.13), bcryptjs, helmet |
| Frontend | React 19, Vite, service worker (PWA) |
| Media | yt-dlp, ffprobe, Web Audio API |
| AI / data | Last.fm API, Google Gemini, faster-whisper |
| Ops | PM2, structured logging with rotation, online SQLite backups |

## Getting started

### Requirements
- **Node.js ≥ 20** and **PM2** (`npm i -g pm2`).
- **ffmpeg / ffprobe** and **yt-dlp** on your `PATH`, or set `FFPROBE_PATH` / `YTDLP_PATH`.
- Optional: Python 3 for local Whisper transcription.

### Install

```bash
git clone https://github.com/lucaslopezag-eng/musicaPrivada.git
cd musicaPrivada
npm install                 # server dependencies
npm run setup               # interactive: creates .env, users (bcrypt), worker token, API keys
npm run build               # builds the PWA into frontend/dist
pm2 startOrReload ecosystem.config.js && pm2 save
```

Open `http://<your-host>:3001` and sign in with a user you created during setup.

### Local development

```bash
bash dev.sh   # API on :3001 + Vite dev server on :8084, which proxies /api
```

## Configuration

Copy `.env.example` to `.env` (or run `npm run setup`). The main variables:

| Variable | Purpose |
|---|---|
| `PORT`, `HOST` | Where the API listens. Defaults: `3001`, `0.0.0.0`. |
| `TRUST_PROXY` | Set it when running behind a reverse proxy or tunnel (`loopback` or a hop count). |
| `APP_USERS` | First users to create, as `user:bcryptHash`. Generate entries with `npm run hash-password -- <user>`. |
| `ADMIN_USERS` | Users who may read the full system log. |
| `SESSION_TTL_DAYS` | How long a session lasts. Every use extends it. |
| `SPOTIFY_CLIENT_ID` / `SPOTIFY_CLIENT_SECRET` | Optional. Needed to import full playlists. |
| `GEMINI_API_KEY`, `LASTFM_API_KEY` | Optional. Turn on AI recommendations and genre classification. |
| `SUBTITLE_WORKER_TOKEN` | Shared secret for a remote Whisper worker. |
| `MUSIC_DIR`, `AI_MUSIC_DIR`, `DB_PATH` | Storage paths, relative to the project root. |
| `LOG_LEVEL`, `LOG_FORMAT` | `debug`/`info`/`warn`/`error` and `text`/`json`. |
| `STREAM_THROTTLE_KBPS` | Per-stream bandwidth cap. `0` means unlimited. |

`.env.example` documents every option. **Never commit your `.env`.**

## Day-to-day operations

| Task | Command |
|---|---|
| Hot backup of the database | `npm run backup` (written to `backups/`, keeps `BACKUP_KEEP` copies) |
| Run the tests | `npm test` |
| Syntax check | `npm run check` |
| Manage users | `npm run user -- list \| add <u> [--admin] \| passwd <u> \| role <u> admin\|user \| remove <u>` |
| Change your own password or log out of other devices | In the app: **Install App → Account** |
| Verbose logs | `LOG_LEVEL=debug` (every request gets an `X-Request-Id`). Use `LOG_FORMAT=json` for jq or Loki. |
| Update a running install | `bash deploy/update.sh` |
| Production logs | `pm2 logs musica-privada` |

## Synced lyrics with Whisper

The app turns each song's audio into WebVTT lyrics that the player highlights while the song plays. There are two ways to run it:

1. **Local (recommended).** The server runs this automatically when `whisper/.venv` exists:
   ```bash
   python3 -m venv whisper/.venv
   whisper/.venv/bin/pip install faster-whisper
   node scripts/transcribe-backfill.js --limite 50   # transcribe songs you already have
   ```
   You can tune it with `WHISPER_MODEL` (`small`, or `base` on weaker machines), `WHISPER_COMPUTE_TYPE`, `WHISPER_THREADS` and `WHISPER_NICE`.
2. **Remote worker.** Run `tools/pc_subtitle_worker.py` on a machine with a GPU. It authenticates with `SUBTITLE_WORKER_TOKEN`.

## Security model

- **Authentication:** bcrypt password hashes in SQLite, HttpOnly session cookies (`Secure` set automatically behind HTTPS), sliding expiry, and login rate limiting.
- **Authorization:** every playlist and song route checks that the item belongs to the user. Admin-only routes check the user's role.
- **Hardening:** a strict Content-Security-Policy, HSTS, X-Frame-Options and Permissions-Policy through helmet.
- **Input:** validation schemas on every route that changes data, and safe path resolution against path traversal.
- **Outbound requests:** an SSRF guard blocks private and reserved address ranges, and an allow-list limits which URLs yt-dlp may fetch.
- **Secrets:** configuration is read only from `.env`, and nothing sensitive is stored in the repository.

## Project structure

```
server.js              Bootstrap (config → DB → users → routes → tasks → listen)
src/
  config.js            Validated environment configuration
  auth.js, users.js    Sessions, bcrypt, rate limiting, user store
  db.js, migrations.js SQLite access, transactions, online backup, idempotent schema migrations
  security.js          helmet / CSP setup
  schema.js, validation.js  Request validation
  paths.js, http.js    Safe path resolution, id and ownership helpers
  logger.js            Leveled, rotating structured logger
  media/               Range requests, streaming, duration probing, WebVTT
  net/                 SSRF protection and yt-dlp URL policy
  services/            Library, job queue, yt-dlp, subtitles, transcriber, genres,
                       recommendations, loudness, Spotify reader
routes/                HTTP endpoints grouped by domain
jobs/                  Background maintenance jobs
scripts/               setup, user management, hash-password, backup, syntax check, backfills
deploy/update.sh       Production update script
tools/                 Maintenance utilities and the remote subtitle worker
whisper/               Local transcription script (faster-whisper)
test/                  node:test suites (no external test framework)
frontend/              React 19 PWA (Vite)
  src/hooks/           usePlayer, useAuth, useLibrary, useSubtitles, useOfflineCache, …
  src/components/      auth · layout · library · player · dialogs · views · pwa
```

More background is in `CHANGELOG_PHASE2.md` and `REFACTOR_REPORT.md`, which are written in Spanish.

## Testing

```bash
npm test
```

The suites use the built-in `node:test` runner and cover authentication, configuration, the database and migrations, the job queue, path safety, routes, security headers, SSRF protection and user management.

## Legal notice

MusicaPrivada is a personal media server. Only add, download or stream content that you own or have the right to use. You are responsible for following copyright law and the terms of service of any platform you import from. The project ships no music.
