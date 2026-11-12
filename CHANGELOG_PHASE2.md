# Changelog — Phase 2 (v2.1.0)

Architectural refactor of MusicaPrivada following `PHASE2_REFACTOR_SPEC.md`. No feature was removed: Range streaming, offline PWA, dark themes, synced WebVTT lyrics, AI mode, Wrapped, import and trim all keep working.

## Frontend: `App.jsx` modularized (2,914 → ~400 lines)

- **Hooks** (`frontend/src/hooks/`):
  - `usePlayer`: the playback engine.
  - `playerReducer`: a pure `useReducer` state machine.
  - `useAuth`, `useLibrary`, `useSubtitles`, `useOfflineCache`, `useAiRecommendations`, `useVirtualList`.
  - Small helpers: `useTaskLogs`, `useWrapped`, `useToasts`, `useDialog`, `useLatestRef`/`useStableCallback`, `usePlaybackTime`.
- **Components** (`frontend/src/components/`):
  - `auth/LoginScreen`
  - `layout/Sidebar`, `MobileNav`, `ResizeHandle`
  - `library/SongList`, `SongRow` (`React.memo`), `PlaylistGrid`, `ImportPanel`
  - `player/PlayerBar`, `ProgressBar`, `VolumeControl`, `ShuffleMenu`, `QueuePanel`, `AudioEngine`
  - `dialogs/AppDialog`, `TrimEditor`, `ContextMenu`
  - `views/SearchTab`, `ThemesTab`, `LyricsView`, `HomeView`, `PlaylistView`, `WrappedTab`, `InstallTab`, `AccountPanel`
  - `pwa/PwaOverlays`
- **Player state machine.** About 15 `useState` + hand-synced refs were replaced by one reducer with explicit actions:
  - `SET_TRACK`, `PLAY`, `PAUSE`, `NEXT_TRACK`, `PREV_TRACK`, `SEEK_TO`, `SET_VOLUME`, `SET_QUEUE`, `TOGGLE_SHUFFLE`, `CYCLE_REPEAT`, plus queue, AI and reset actions.
  - The hook applies the same reducer synchronously to a ref, so two quick clicks on "next" never read stale state.
  - Audio side effects (loading `<audio>`, AI skip/played reports) are derived from each prev → next transition.
  - Actions keep a stable identity, so MediaSession, keyboard shortcuts and the watchdog are bound once.
- **Virtualized song list** (custom, no dependency). Only the visible rows (~20 of 600) are mounted. The dragged row stays mounted, and touch reordering auto-scrolls near the edges.
- **Playback time is an external store.** `timeupdate` no longer re-renders the whole app; only the progress bar and lyrics view subscribe to it.
- **New UI:**
  - Account panel: change password; list and revoke active sessions.
  - Queue panel: history and upcoming AI recommendations.
  - Instant library matches in Search.
- **Accessibility:** ARIA roles and labels, keyboard support for sliders, trim handles and menus, Escape closes dialogs. New `S` shortcut toggles shuffle.
- **Bug fixed along the way:** pressing Space on a focused button no longer toggles playback twice.
- **CSP:** the inline `<script>` in `index.html` moved to `public/install-prompt.js`, so the page works under `script-src 'self'`. Service worker bumped to v13.

## Backend

- **better-sqlite3** replaces `sqlite3`.
  - Transactions are synchronous and truly atomic, with nested SAVEPOINTs; an async callback is rejected.
  - WAL and `synchronous=NORMAL` are kept.
  - If the native module is missing, it falls back automatically to Node's built-in `node:sqlite`.
- **Persistent job queue** (`jobs` table).
  - Imports, downloads and replacements are stored with their payload, progress and log.
  - On restart, `recover()` resumes interrupted jobs (up to `JOB_MAX_ATTEMPTS`) or marks them `failed` with a clear reason.
  - A replacement cut off mid-swap restores the original file and keeps the DB row consistent.
- **Users in the database** (`users` table).
  - `APP_USERS`/`ADMIN_USERS` seed it on boot and never overwrite a changed password.
  - New endpoints:
    - `POST /api/auth/change-password` (bcrypt, rate-limited, revokes other sessions)
    - `GET /api/auth/sessions`
    - `DELETE /api/auth/sessions/:id`
    - `DELETE /api/auth/sessions` (all except the current one)
  - Sessions get a public opaque `id`; existing sessions are backfilled and stay valid.
  - New CLI: `npm run user -- list|add|passwd|role|remove|revoke-sessions`.
- **Scraper without Chromium.** Puppeteer was removed.
  - `src/services/spotify.js` reads playlists and albums over HTTP: the official Web API with client credentials (paginated, full lists, 429 retry), falling back to the public embed JSON.
  - It runs in-process (a few MB instead of 500 MB–1 GB).
  - `scraper/scrape.js` remains as a dependency-free CLI.
- **Security headers:** `helmet` with a strict CSP.
  - Policy: `script-src 'self'`, `frame-ancestors 'none'`, `object-src 'none'`, `worker-src 'self'`, `media-src 'self' blob:`, and no `upgrade-insecure-requests`, so LAN http keeps working.
  - Also sends X-Frame-Options DENY, nosniff, HSTS (no subdomains), COOP/CORP and Permissions-Policy.
  - Equivalent headers are sent even if helmet is not installed.
- **Schema validation on every mutation endpoint** (`src/schema.js` + `src/validation.js`, dependency-free, zod-like API). Invalid input gets a 400 with a precise message, and unknown fields are stripped.
- **Structured logging.**
  - Levels `debug|info|warn|error` (`LOG_LEVEL`), `text` or `json` output (`LOG_FORMAT`), child loggers, and size-based rotation.
  - Each request has an `X-Request-Id`; at debug level there is a per-request access log.
  - Legacy `log()` calls are auto-classified by keyword.

## Tests and tooling

- `npm test`: **82 tests** (was 34). New coverage:
  - DB layer and migrations, users, auth/session flows, persistent jobs and recovery.
  - Validation, Spotify client, security headers, logger.
  - Player reducer (9 scenarios).
  - Route-level tests of the real routers.
- `npm run check`: 69/69 files.
- Removed: `scraper/package.json` (Puppeteer) and the stale root `package-lock.json`; `npm install` regenerates the lock.
- `deploy/update.sh` drops the Puppeteer install and removes the leftover `scraper/node_modules`.

## Configuration (all optional)

`SPOTIFY_CLIENT_ID`, `SPOTIFY_CLIENT_SECRET`, `SPOTIFY_MARKET`, `LOG_LEVEL`, `LOG_FORMAT`, `CSP_REPORT_ONLY`, `JOB_MAX_ATTEMPTS`, `SQLITE_DRIVER`. See `.env.example`.

## Upgrade notes

- After the first boot on 2.1, passwords live in the DB. Editing `APP_USERS` no longer changes an existing user's password; use the app or `npm run user -- passwd <user>`.
- Task statuses are now `pending | running | completed | failed` (were `queued | running | done | failed`).
- Without Spotify credentials, playlist imports are capped at about 100 tracks by Spotify's embed endpoint. Albums are not affected by this limit.

## Verification performed

The build sandbox had no access to the npm registry, so dependencies could not be installed there.

- `npm test` and `npm run check` were run for real and pass.
  - DB tests ran on the `node:sqlite` fallback; Express and bcrypt were stubbed in tests.
- The frontend was bundled with esbuild against React 19.2 and linted with ESLint 10 core rules (no errors in new code).
- A headless-Chromium smoke test against a mock API sending the production CSP passed **44/44 checks**:
  - login, 600-row virtualization, playback and natural track end with the listen report;
  - next/prev/queue, lyrics sync, repeat and shuffle/AI modes, search filter, drag-reorder;
  - trim editor, online search/download, themes;
  - account (password and sessions), Wrapped, logout, mobile layout;
  - service worker registered, zero console errors, zero CSP violations.

**Please run once on your machine:**

```
npm install && npm test && npm run check && npm run build
```

That confirms the real `vite build` and the native better-sqlite3 build.
