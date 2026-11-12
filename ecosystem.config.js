// ─── PM2 · un único proceso (DEP-01) ─────────────────────────────────────────
// Express sirve la API y el frontend compilado (frontend/dist). Ya no hace
// falta el proceso "spotify-web" con el servidor de desarrollo de Vite.
//   pm2 startOrReload ecosystem.config.js && pm2 save
module.exports = {
  apps: [
    {
      name: 'musica-privada',
      script: 'server.js',
      cwd: __dirname,
      instances: 1,            // SQLite (un escritor) + watcher de la biblioteca: una sola instancia
      exec_mode: 'fork',
      autorestart: true,
      max_restarts: 20,
      min_uptime: '10s',
      restart_delay: 2000,
      kill_timeout: 10000,     // deja tiempo a la parada ordenada (SIGTERM)
      max_memory_restart: '600M',
      env: { NODE_ENV: 'production' },
    },
  ],
};
