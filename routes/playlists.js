'use strict';
// ─── PLAYLISTS (AUTH-04: sin IDOR) ───────────────────────────────────────────
// Cada operación verifica que la playlist (y la canción) pertenezcan a req.user.

const express = require('express');
const { requireOwnedPlaylist, requireOwnedSong, publicSong } = require('../src/http');
const { schemas, validate } = require('../src/validation');

function sanitizeName(name) {
  const clean = String(name || '').replace(/[\u0000-\u001f\u007f]/g, '').trim().slice(0, 100);
  return clean || 'Nueva Playlist';
}

// Solo portadas internas o https: evita URLs arbitrarias (javascript:, http interno...).
function sanitizeCoverUrl(url) {
  if (typeof url !== 'string' || url === '') return null;
  if (url.startsWith('/api/cover/')) return url.slice(0, 1000);
  if (/^https:\/\/[^\s]+$/i.test(url)) return url.slice(0, 1000);
  return null;
}

module.exports = function playlistsRouter({ db, library }) {
  const router = express.Router();

  router.get('/playlists', async (req, res) => {
    const rows = await db.all('SELECT * FROM playlists WHERE username = ? ORDER BY created_at ASC, id ASC', [req.user]);
    res.json(rows);
  });

  router.post('/playlists', validate({ body: schemas.playlistCreate }), async (req, res) => {
    const { name, cover_url: coverUrl } = req.body;
    const { lastID } = await db.run('INSERT INTO playlists (name, username, cover_url) VALUES (?, ?, ?)',
      [sanitizeName(name), req.user, sanitizeCoverUrl(coverUrl)]);
    res.status(201).json(await db.get('SELECT * FROM playlists WHERE id = ?', [lastID]));
  });

  router.delete('/playlists/:id', validate({ params: schemas.idParams }), async (req, res) => {
    const playlist = await requireOwnedPlaylist(db, req.params.id, req.user);
    // Antes se borraban las canciones de la playlist aunque el DELETE de la
    // playlist no afectase a ninguna fila (playlist ajena).
    db.transaction(() => {
      db.runSync('DELETE FROM playlist_songs WHERE playlist_id = ?', [playlist.id]);
      db.runSync('DELETE FROM playlists WHERE id = ? AND username = ?', [playlist.id, req.user]);
    });
    library.bumpVersion(req.user);
    res.json({ success: true });
  });

  router.get('/playlists/:id/songs', validate({ params: schemas.idParams }), async (req, res) => {
    const playlist = await requireOwnedPlaylist(db, req.params.id, req.user);
    const rows = await db.all(`
      SELECT songs.*, ps.playlist_order AS current_playlist_order
      FROM songs
      JOIN playlist_songs ps ON songs.id = ps.song_id
      WHERE ps.playlist_id = ? AND songs.username = ?
      ORDER BY ps.playlist_order ASC, songs.id ASC
    `, [playlist.id, req.user]);
    res.json(rows.map(publicSong));
  });

  router.post('/playlists/:id/songs', validate({ params: schemas.idParams, body: schemas.playlistAddSong }), async (req, res) => {
    const playlist = await requireOwnedPlaylist(db, req.valid.params.id, req.user);
    const song = await requireOwnedSong(db, String(req.body.songId), req.user, 'id');
    await db.run(`
      INSERT OR IGNORE INTO playlist_songs (playlist_id, song_id, playlist_order)
      VALUES (?, ?, (SELECT COALESCE(MAX(playlist_order), 0) + 1 FROM playlist_songs WHERE playlist_id = ?))
    `, [playlist.id, song.id, playlist.id]);
    library.bumpVersion(req.user);
    res.json({ success: true });
  });

  router.delete('/playlists/:playlistId/songs/:songId', validate({ params: schemas.playlistSongParams }), async (req, res) => {
    const playlist = await requireOwnedPlaylist(db, req.valid.params.playlistId, req.user);
    const { songId } = req.valid.params;
    await db.run('DELETE FROM playlist_songs WHERE playlist_id = ? AND song_id = ?', [playlist.id, songId]);
    library.bumpVersion(req.user);
    res.json({ success: true });
  });

  router.post('/playlists/:id/reorder', validate({ params: schemas.idParams, body: schemas.reorder }), async (req, res) => {
    const playlist = await requireOwnedPlaylist(db, req.valid.params.id, req.user);
    const { orderedIds } = req.body;
    db.transaction(() => {
      for (let idx = 0; idx < orderedIds.length; idx++) {
        db.runSync('UPDATE playlist_songs SET playlist_order = ? WHERE playlist_id = ? AND song_id = ?',
          [idx, playlist.id, orderedIds[idx]]);
      }
    });
    library.bumpVersion(req.user);
    res.json({ success: true });
  });

  return router;
};
