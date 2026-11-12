#!/usr/bin/env node
'use strict';
// Sincroniza archivos cambiados desde GitHub (cuando git no está disponible).
// SEC-00: el token se lee de GITHUB_TOKEN (.env), ya no del archivo "token".
//   node tools/sync_repo.js <commit_base>

require('dotenv').config({ path: require('path').resolve(__dirname, '..', '.env') });
const fs = require('fs');
const path = require('path');

const ROOT = path.resolve(__dirname, '..');
const token = process.env.GITHUB_TOKEN;
const repo = process.env.GITHUB_REPO; // "propietario/repositorio"
const base = process.argv[2];

if (!token || !repo || !/^[\w.-]+\/[\w.-]+$/.test(repo) || !base || !/^[0-9a-f]{7,40}$/i.test(base)) {
  console.error('Configura GITHUB_TOKEN y GITHUB_REPO en .env.  Uso: node tools/sync_repo.js <commit_base>');
  process.exit(1);
}

const headers = { 'User-Agent': 'MusicaPrivada-sync', Authorization: `Bearer ${token}` };

async function download(url, extraHeaders = {}, retries = 5) {
  for (let attempt = 1; attempt <= retries; attempt++) {
    try {
      const res = await fetch(url, { headers: { ...headers, ...extraHeaders } });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      return Buffer.from(await res.arrayBuffer());
    } catch (err) {
      if (attempt === retries) throw err;
      await new Promise(r => setTimeout(r, 2000));
    }
  }
  return null;
}

(async () => {
  const res = await fetch(`https://api.github.com/repos/${repo}/compare/${base}...main`, { headers });
  const data = await res.json();
  const files = data.files || [];
  console.log(`Archivos cambiados: ${files.length}`);
  for (const [i, f] of files.entries()) {
    const target = path.resolve(ROOT, f.filename);
    // Nunca escribir fuera del proyecto ni sobre datos/secretos locales.
    if (!target.startsWith(ROOT + path.sep) || /(^|\/)(\.env|database\.sqlite|music|\.ai_music)(\/|$)/.test(f.filename)) {
      console.log(`[${i + 1}] Omitido por seguridad: ${f.filename}`);
      continue;
    }
    if (f.status === 'removed') {
      fs.rmSync(target, { force: true });
      console.log(`[${i + 1}] Eliminado: ${f.filename}`);
      continue;
    }
    fs.mkdirSync(path.dirname(target), { recursive: true });
    const buf = await download(`https://api.github.com/repos/${repo}/contents/${f.filename.split('/').map(encodeURIComponent).join('/')}?ref=main`,
      { Accept: 'application/vnd.github.v3.raw' });
    fs.writeFileSync(target, buf);
    console.log(`[${i + 1}] Actualizado: ${f.filename}`);
  }
})().catch((err) => { console.error(err.message); process.exit(1); });
