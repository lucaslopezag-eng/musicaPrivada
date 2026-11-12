'use strict';
// Utilidades HTTP compartidas por las rutas.

class HttpError extends Error {
  constructor(status, message) {
    super(message);
    this.status = status;
  }
}

// Entero positivo seguro o null.
function parseId(value) {
  if (typeof value === 'number') return Number.isSafeInteger(value) && value > 0 ? value : null;
  if (typeof value !== 'string' || !/^\d{1,15}$/.test(value)) return null;
  const n = Number(value);
  return Number.isSafeInteger(n) && n > 0 ? n : null;
}

function requireId(value, name = 'id') {
  const id = parseId(value);
  if (!id) throw new HttpError(400, `Parámetro "${name}" no válido`);
  return id;
}

function parseIdList(value, max = 20000) {
  if (!Array.isArray(value) || value.length > max) return null;
  const ids = [];
  for (const v of value) {
    const id = parseId(typeof v === 'number' ? v : String(v));
    if (!id) return null;
    ids.push(id);
  }
  return ids;
}

// Comprueba que la playlist pertenece al usuario (AUTH-04).
async function requireOwnedPlaylist(db, playlistId, user) {
  const id = parseId(typeof playlistId === 'number' ? playlistId : String(playlistId ?? ''));
  if (!id) throw new HttpError(400, 'Playlist no válida');
  const row = await db.get('SELECT id, name FROM playlists WHERE id = ? AND username = ?', [id, user]);
  if (!row) throw new HttpError(404, 'Playlist no encontrada');
  return row;
}

async function requireOwnedSong(db, songId, user, columns = '*') {
  const id = requireId(String(songId ?? ''), 'songId');
  const row = await db.get(`SELECT ${columns} FROM songs WHERE id = ? AND username = ?`, [id, user]);
  if (!row) throw new HttpError(404, 'Canción no encontrada');
  return row;
}

// Elimina campos internos (rutas de disco) antes de enviar una canción al cliente.
function publicSong(row) {
  if (!row) return row;
  const { file_path: _filePath, ...rest } = row;
  // La portada se versiona con la revisión: tras sustituir una canción con el
  // mismo nombre de archivo, ninguna caché sirve la portada anterior.
  if (rest.rev > 0 && typeof rest.cover_url === 'string' && rest.cover_url.startsWith('/api/cover/') && !rest.cover_url.includes('?')) {
    rest.cover_url = `${rest.cover_url}?v=${rest.rev}`;
  }
  return rest;
}

module.exports = { HttpError, parseId, requireId, parseIdList, requireOwnedPlaylist, requireOwnedSong, publicSong };
