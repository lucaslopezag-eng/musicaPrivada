#!/usr/bin/env node
'use strict';
// ─── LECTOR DE PLAYLISTS DE SPOTIFY (CLI, sin navegador) ─────────────────────
// FASE 2: ya no usa Puppeteer/Chromium. Es un envoltorio de línea de comandos
// sobre src/services/spotify.js (peticiones HTTP + JSON, unos pocos MB de RAM).
// El servidor ya no lo lanza como proceso hijo: importa el servicio directamente.
//
// Uso: node scraper/scrape.js <url_playlist_o_album> [archivo_salida]
// Lee SPOTIFY_CLIENT_ID / SPOTIFY_CLIENT_SECRET del .env si existen.

const fs = require('fs');
const path = require('path');

try {
  require('dotenv').config({ path: path.resolve(__dirname, '..', '.env') });
} catch { /* dotenv opcional para el CLI */ }

const { createSpotifyClient, parseSpotifyUrl } = require('../src/services/spotify');

(async () => {
  const url = process.argv[2];
  const outFile = process.argv[3] ? path.resolve(process.argv[3]) : path.join(__dirname, 'canciones.txt');
  if (!url || !parseSpotifyUrl(url)) {
    console.error('Uso: node scraper/scrape.js <url_playlist_o_album_de_open.spotify.com> [archivo_salida]');
    process.exit(1);
  }
  try {
    const client = createSpotifyClient({
      clientId: process.env.SPOTIFY_CLIENT_ID || '',
      clientSecret: process.env.SPOTIFY_CLIENT_SECRET || '',
      market: process.env.SPOTIFY_MARKET || 'ES',
      log: (m) => console.log(m),
    });
    const { name, source, lines } = await client.fetchCollection(url);
    fs.mkdirSync(path.dirname(outFile), { recursive: true });
    fs.writeFileSync(outFile, lines.join('\n'), 'utf-8');
    console.log(`"${name || 'Sin nombre'}": ${lines.length} canciones (${source}). Guardadas en ${path.basename(outFile)}`);
  } catch (err) {
    console.error(`Error leyendo Spotify: ${err.message}`);
    process.exitCode = 1;
  }
})();
