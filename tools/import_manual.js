#!/usr/bin/env node
'use strict';
// Copia archivos de audio locales a la biblioteca de un usuario.
//   node tools/import_manual.js <usuario> <carpeta_origen>
// El servidor detecta los archivos (fs.watch) y los registra con el upsert
// normal. Antes este script insertaba en columnas inexistentes (image, url) con
// ids de texto aleatorios, y fallaba siempre.

const fs = require('fs');
const path = require('path');
const { sanitizeFileStem, isValidUsername } = require('../src/paths');

const ROOT = path.resolve(__dirname, '..');
const AUDIO = new Set(['.mp3', '.m4a', '.opus', '.wav', '.flac', '.ogg']);

const [user, sourceDir] = process.argv.slice(2);
if (!isValidUsername(user) || !sourceDir || !fs.existsSync(sourceDir)) {
  console.error('Uso: node tools/import_manual.js <usuario> <carpeta_origen>');
  process.exit(1);
}

const destDir = path.join(ROOT, process.env.MUSIC_DIR || 'music', user);
fs.mkdirSync(destDir, { recursive: true });

let order = 9000;
let copied = 0;
for (const file of fs.readdirSync(sourceDir).sort()) {
  const ext = path.extname(file).toLowerCase();
  if (!AUDIO.has(ext)) continue;
  const base = path.basename(file, ext);
  let title = base;
  let artist = 'Unknown Artist';
  if (base.includes(' - ')) {
    const [a, ...rest] = base.split(' - ');
    artist = a.trim();
    title = rest.join(' - ').trim();
  }
  const destName = `${String(order).padStart(4, '0')}_${sanitizeFileStem(`${title} - ${artist}`)}${ext}`;
  const dest = path.join(destDir, destName);
  if (fs.existsSync(dest)) continue;
  fs.copyFileSync(path.join(sourceDir, file), dest);
  order += 1;
  copied += 1;
  console.log(`[Import] ${destName}`);
}
console.log(`Copiados ${copied} archivos a ${destDir}. El servidor los registrará automáticamente.`);
