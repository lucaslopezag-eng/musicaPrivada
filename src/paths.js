'use strict';
// ─── RUTAS SEGURAS EN DISCO ──────────────────────────────────────────────────
// Toda ruta derivada de datos del usuario (URL, BD, nombre de archivo) pasa por
// aquí. Nunca se sirve ni se crea nada fuera del directorio base (AUTH-01/02).

const fs = require('fs');
const fsp = fs.promises;
const path = require('path');
const { USERNAME_RE } = require('./config');

function isValidUsername(user) {
  return typeof user === 'string' && USERNAME_RE.test(user);
}

// true si `target` está estrictamente dentro de `base` (no es base, no escapa).
function isInside(base, target) {
  const rel = path.relative(path.resolve(base), path.resolve(target));
  return rel !== '' && !rel.startsWith('..') && !path.isAbsolute(rel);
}

// Une segmentos y devuelve la ruta absoluta solo si queda dentro de base.
function safeJoin(base, ...segments) {
  if (segments.some(s => typeof s !== 'string' || s.includes('\0'))) return null;
  const target = path.resolve(base, ...segments);
  return isInside(base, target) ? target : null;
}

function ensureUserDir(root, user) {
  if (!isValidUsername(user)) throw new Error(`Usuario no válido: ${String(user).slice(0, 40)}`);
  const dir = path.join(root, user);
  fs.mkdirSync(dir, { recursive: true });
  return dir;
}

function toPosix(p) {
  return p.split(path.sep).join('/');
}

// Limpia un texto para usarlo como nombre de archivo (sin separadores, sin
// comodines, sin caracteres de control, sin "." / "-" iniciales).
function sanitizeFileStem(text, maxLength = 100) {
  const clean = String(text || '')
    .replace(/[/\\?%*:|"<>]/g, '')
    // eslint-disable-next-line no-control-regex
    .replace(/[\u0000-\u001f\u007f]/g, '')
    .replace(/^[.\s-]+/, '')
    .trim()
    .slice(0, maxLength)
    .trim();
  return clean || 'pista';
}

async function isFile(p) {
  try { return (await fsp.stat(p)).isFile(); } catch { return false; }
}

// Resuelve el archivo de audio de una fila de `songs` dentro de musicDir.
// Acepta rutas relativas ("usuario/archivo.opus") y absolutas heredadas.
async function resolveSongFile(musicDir, row) {
  if (!row || typeof row.file_path !== 'string' || !row.file_path) return null;
  const candidates = [];
  if (path.isAbsolute(row.file_path)) {
    if (isInside(musicDir, row.file_path)) candidates.push(path.resolve(row.file_path));
  } else {
    candidates.push(safeJoin(musicDir, row.file_path));
  }
  if (isValidUsername(row.username)) {
    candidates.push(safeJoin(musicDir, row.username, path.basename(row.file_path)));
  }
  for (const c of candidates) {
    if (c && await isFile(c)) return c;
  }
  return null;
}

// Igual que resolveSongFile pero para recomendaciones IA (.ai_music).
async function resolveAiFile(aiMusicDir, row) {
  if (!row || typeof row.file_path !== 'string' || !row.file_path) return null;
  const base = path.basename(row.file_path);
  const candidates = [];
  if (path.isAbsolute(row.file_path)) {
    if (isInside(aiMusicDir, row.file_path)) candidates.push(path.resolve(row.file_path));
  } else {
    candidates.push(safeJoin(aiMusicDir, row.file_path));
  }
  if (isValidUsername(row.username)) {
    candidates.push(safeJoin(aiMusicDir, row.username, base));
    candidates.push(safeJoin(aiMusicDir, row.username, '.archive', base));
  }
  for (const c of candidates) {
    if (c && await isFile(c)) return c;
  }
  return null;
}

// Devuelve un nombre libre en `dir` añadiendo " (2)", " (3)"... si hace falta.
async function uniqueFileName(dir, stem, ext) {
  let name = `${stem}${ext}`;
  for (let i = 2; await isFile(path.join(dir, name)); i++) {
    name = `${stem} (${i})${ext}`;
    if (i > 500) throw new Error('No se encontró un nombre de archivo libre');
  }
  return name;
}

const IMAGE_EXTS = ['.jpg', '.webp', '.png', '.jpeg'];
const AUDIO_EXTS = new Set(['.opus', '.mp3', '.m4a', '.flac', '.wav', '.webm', '.ogg']);

// Lista las portadas asociadas a un audio: "base.jpg" y "base.opus.jpg".
function companionImagePaths(audioPath) {
  const dir = path.dirname(audioPath);
  const full = path.basename(audioPath);
  const base = path.basename(audioPath, path.extname(audioPath));
  const out = [];
  for (const ext of IMAGE_EXTS) {
    out.push(path.join(dir, base + ext));
    out.push(path.join(dir, full + ext));
  }
  return out;
}

module.exports = {
  isValidUsername,
  isInside,
  safeJoin,
  ensureUserDir,
  toPosix,
  sanitizeFileStem,
  isFile,
  resolveSongFile,
  resolveAiFile,
  uniqueFileName,
  companionImagePaths,
  IMAGE_EXTS,
  AUDIO_EXTS,
};
