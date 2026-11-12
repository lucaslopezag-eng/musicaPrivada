import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'

// https://vite.dev/config/
export default defineConfig({
  plugins: [react()],
  server: {
    host: true,
    port: 8084,
    allowedHosts: ['music.skiptools.org'],
    // IMPORTANT: this server is used as the real app (behind a tunnel, on phones).
    // Vite's HMR client force-reloads the whole page whenever its websocket drops and
    // reconnects (phone goes to background, tunnel hiccup, server restart...), which is
    // the "app reloads/resets by itself" bug. HMR is useless here, so turn it off.
    hmr: false,
    headers: {
      'Service-Worker-Allowed': '/',
    },
    proxy: {
      '/api': {
        target: 'http://localhost:3001',
        changeOrigin: true,
        // Reenvía X-Forwarded-For: sin él, todas las peticiones llegarían al
        // backend como 127.0.0.1 (limitador de login y worker de subtítulos).
        xfwd: true,
      }
    }
  },
})
