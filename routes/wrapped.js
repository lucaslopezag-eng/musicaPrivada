'use strict';
// ─── ESTADÍSTICAS "RESUMEN" (WRAPPED v2) ─────────────────────────────────────
// DB-05:
// · Todas las consultas filtran estrictamente por el usuario autenticado
//   (antes se mezclaba el historial de 'skiper' y filas sin usuario).
// · Las escuchas de recomendaciones IA tienen song_id NULL + is_ai=1, así que
//   ya no se atribuyen a la canción con el mismo número.
// · topSongs incluye discovered_via y genre (aiTopSong y el audio del bloque de
//   géneros los necesitaban).
// · Datos demo con ids NEGATIVOS: nunca colisionan con canciones reales.
// · Se añade skipStats (el frontend lo usaba y v2 no lo devolvía).

const express = require('express');

module.exports = function wrappedRouter({ db }) {
  const router = express.Router();

  router.get('/wrapped-v2', async (req, res) => {
    const rawYear = String(req.query.year || new Date().getFullYear());
    const year = rawYear === 'all' ? 'all' : (/^\d{4}$/.test(rawYear) ? rawYear : String(new Date().getFullYear()));
    const user = req.user;

    const yearCond = year === 'all' ? '' : " AND strftime('%Y', p.played_at) = ?";
    const baseParams = year === 'all' ? [user] : [user, year];

    const countRow = await db.get(`SELECT COUNT(*) AS cnt FROM play_history p WHERE p.username = ?${yearCond}`, baseParams);
    const availableYears = (await db.all(
      "SELECT DISTINCT strftime('%Y', played_at) AS year FROM play_history WHERE username = ? AND played_at IS NOT NULL ORDER BY year DESC",
      [user]
    )).map(r => r.year).filter(Boolean);

    if (!countRow || countRow.cnt < 10) {
      return res.json({ ...getDemoData(year), availableYears });
    }

    const condition = `p.username = ? AND p.listen_duration_ms > 10000${yearCond}`;
    const anyCondition = `p.username = ?${yearCond}`;
    const params = baseParams;

    const seasonalQuery = `
      WITH seasonal_plays AS (
        SELECT s.genre, p.listen_duration_ms,
          CASE
            WHEN CAST(strftime('%m', p.played_at) AS INTEGER) IN (12,1,2) THEN 'Invierno'
            WHEN CAST(strftime('%m', p.played_at) AS INTEGER) IN (3,4,5)  THEN 'Primavera'
            WHEN CAST(strftime('%m', p.played_at) AS INTEGER) IN (6,7,8)  THEN 'Verano'
            ELSE 'Otoño'
          END AS season
        FROM play_history p JOIN songs s ON p.song_id = s.id AND s.username = p.username
        WHERE ${condition}
      ),
      season_genre_totals AS (
        SELECT season, genre, SUM(listen_duration_ms) AS total_ms FROM seasonal_plays GROUP BY season, genre
      ),
      ranked AS (
        SELECT *, ROW_NUMBER() OVER (PARTITION BY season ORDER BY total_ms DESC) AS rank FROM season_genre_totals
      )
      SELECT season, genre AS dominant_genre, ROUND(total_ms/60000.0,1) AS minutes
      FROM ranked WHERE rank = 1
      ORDER BY CASE season WHEN 'Primavera' THEN 1 WHEN 'Verano' THEN 2 WHEN 'Otoño' THEN 3 ELSE 4 END`;

    const loopQuery = `
      WITH consecutive_plays AS (
        SELECT p.id AS pid, p.song_id, p.played_at, s.title, s.artist, s.id AS stream_id,
          LAG(p.song_id) OVER (ORDER BY p.played_at, p.id) AS prev_song,
          (julianday(p.played_at) - julianday(LAG(p.played_at) OVER (ORDER BY p.played_at, p.id))) * 1440 AS mins_since_last
        FROM play_history p JOIN songs s ON p.song_id = s.id AND s.username = p.username
        WHERE ${anyCondition}
      ),
      loop_groups AS (
        SELECT *, CASE WHEN prev_song = song_id AND mins_since_last < 10 THEN 0 ELSE 1 END AS is_new_group
        FROM consecutive_plays
      ),
      grouped AS (
        SELECT *, SUM(is_new_group) OVER (ORDER BY played_at, pid ROWS UNBOUNDED PRECEDING) AS group_id FROM loop_groups
      )
      SELECT title, artist, stream_id AS id, COUNT(*) AS consecutive_plays
      FROM grouped GROUP BY group_id, song_id
      ORDER BY consecutive_plays DESC LIMIT 1`;

    const marathonQuery = `
      WITH days AS (
        SELECT date(p.played_at) AS day, COUNT(p.id) AS total_plays,
          ROUND(SUM(p.listen_duration_ms)/60000.0,1) AS total_minutes,
          COUNT(DISTINCT COALESCE(p.song_id, -p.ai_rec_id)) AS distinct_songs
        FROM play_history p WHERE ${condition}
        GROUP BY day ORDER BY total_minutes DESC LIMIT 1
      )
      SELECT d.*, (
        SELECT p2.song_id FROM play_history p2
        WHERE p2.username = ? AND p2.song_id IS NOT NULL AND date(p2.played_at) = d.day
        GROUP BY p2.song_id ORDER BY SUM(p2.listen_duration_ms) DESC LIMIT 1
      ) AS top_song_id
      FROM days d`;

    const discoveryQuery = `
      WITH first_plays AS (
        SELECT p.song_id, MIN(p.played_at) AS first_heard
        FROM play_history p WHERE ${anyCondition} AND p.song_id IS NOT NULL
        GROUP BY p.song_id
      )
      SELECT COALESCE(s.discovered_via, 'manual') AS discovered_via, COUNT(DISTINCT fp.song_id) AS count
      FROM first_plays fp JOIN songs s ON fp.song_id = s.id AND s.username = ?
      GROUP BY COALESCE(s.discovered_via, 'manual')`;

    const monthlyQuery = `
      WITH monthly_genres AS (
        SELECT strftime('%m', p.played_at) AS month, s.genre, SUM(p.listen_duration_ms) AS total_ms
        FROM play_history p JOIN songs s ON p.song_id = s.id AND s.username = p.username
        WHERE ${condition}
        GROUP BY month, s.genre
      ),
      ranked AS (SELECT *, ROW_NUMBER() OVER (PARTITION BY month ORDER BY total_ms DESC) AS rank FROM monthly_genres)
      SELECT month, genre AS dominant_genre, total_ms FROM ranked WHERE rank = 1 ORDER BY month`;

    // Reproducciones crudas: la hora/día se calculan en JS con zona Europe/Madrid
    // (played_at se guarda en UTC; agrupar en SQL desplazaba las franjas 1-2 h).
    const playsQuery = `
      SELECT p.played_at, p.song_id, p.listen_duration_ms AS ms
      FROM play_history p WHERE ${condition}`;

    const countsQuery = `
      SELECT COUNT(DISTINCT s.id) AS songs, COUNT(DISTINCT s.artist) AS artists,
        COUNT(DISTINCT NULLIF(TRIM(s.genre), '')) AS genres, COUNT(p.id) AS plays
      FROM play_history p JOIN songs s ON p.song_id = s.id AND s.username = p.username
      WHERE ${condition}`;

    const newArtistsQuery = `
      WITH first_artist AS (
        SELECT s.artist, MIN(p.played_at) AS first_heard
        FROM play_history p JOIN songs s ON p.song_id = s.id AND s.username = p.username
        WHERE p.username = ? AND p.listen_duration_ms > 10000 GROUP BY s.artist
      )
      SELECT COUNT(*) AS n FROM first_artist WHERE 1=1${year === 'all' ? '' : " AND strftime('%Y', first_heard) = ?"}`;

    const skipQuery = `
      SELECT s.title, s.artist, s.cover_url, s.id,
        COUNT(p.id) AS total_plays,
        SUM(CASE WHEN p.completed = 0 THEN 1 ELSE 0 END) AS skips,
        ROUND(100.0 * SUM(CASE WHEN p.completed = 0 THEN 1 ELSE 0 END) / COUNT(p.id), 0) AS skip_rate,
        AVG(NULLIF(p.skip_at_ms, 0)) / 1000 AS avg_skip_at_seconds
      FROM play_history p JOIN songs s ON p.song_id = s.id AND s.username = p.username
      WHERE ${anyCondition}
      GROUP BY p.song_id HAVING total_plays >= 3
      ORDER BY skip_rate DESC LIMIT 1`;

    const skipStatsQuery = `SELECT completed, COUNT(p.id) AS count FROM play_history p WHERE ${anyCondition} GROUP BY completed`;

    const topSongsQuery = `
      SELECT s.id, s.title, s.artist, s.cover_url, s.genre, s.discovered_via, s.chorus_start_ms, s.rev,
        COUNT(p.id) AS play_count, SUM(p.listen_duration_ms) AS total_time_ms
      FROM play_history p JOIN songs s ON p.song_id = s.id AND s.username = p.username
      WHERE ${condition} GROUP BY p.song_id ORDER BY total_time_ms DESC LIMIT 10`;
    const topArtistsQuery = `
      SELECT s.artist, SUM(p.listen_duration_ms) AS total_time_ms, MIN(s.id) AS top_song_id
      FROM play_history p JOIN songs s ON p.song_id = s.id AND s.username = p.username
      WHERE ${condition} GROUP BY s.artist ORDER BY total_time_ms DESC LIMIT 10`;
    const topGenresQuery = `
      SELECT s.genre, SUM(p.listen_duration_ms) AS total_time_ms
      FROM play_history p JOIN songs s ON p.song_id = s.id AND s.username = p.username
      WHERE ${condition} GROUP BY s.genre ORDER BY total_time_ms DESC LIMIT 10`;
    const totalQuery = `SELECT SUM(p.listen_duration_ms) AS total_ms FROM play_history p WHERE ${anyCondition}`;

    const [
      seasonal, loop, marathon, discovery, monthly, plays, mostSkipped, skipRows,
      topSongs, topArtists, topGenres, totalRow, counts, newArtistsRow, monthlyMinutes,
    ] = await Promise.all([
      db.all(seasonalQuery, params),
      db.get(loopQuery, params),
      db.get(marathonQuery, [...params, user]),
      db.all(discoveryQuery, [...params, user]),
      db.all(monthlyQuery, params),
      db.all(playsQuery, params),
      db.get(skipQuery, params),
      db.all(skipStatsQuery, params),
      db.all(topSongsQuery, params),
      db.all(topArtistsQuery, params),
      db.all(topGenresQuery, params),
      db.get(totalQuery, params),
      db.get(countsQuery, params),
      db.get(newArtistsQuery, params),
      db.all(`SELECT strftime('%m', p.played_at) AS month, ROUND(SUM(p.listen_duration_ms)/60000.0) AS minutes
        FROM play_history p WHERE ${anyCondition} GROUP BY month ORDER BY month`, params),
    ]);

    // Para el artista nº1, la canción más escuchada de ese artista.
    for (const artist of topArtists) {
      const best = topSongs.find(s => s.artist === artist.artist);
      if (best) artist.top_song_id = best.id;
    }

    const t = analyzePlays(plays, topSongs);
    const { morning, afternoon, evening, night } = t.buckets;
    let topTimeOfDay = 'Noche';
    let maxTimePlays = evening;
    if (morning > maxTimePlays) { topTimeOfDay = 'Mañana'; maxTimePlays = morning; }
    if (afternoon > maxTimePlays) { topTimeOfDay = 'Tarde'; maxTimePlays = afternoon; }
    if (night > maxTimePlays) { topTimeOfDay = 'Madrugada'; maxTimePlays = night; }
    const bucketKey = { 'Mañana': 'morning', 'Tarde': 'afternoon', 'Noche': 'evening', 'Madrugada': 'night' }[topTimeOfDay];
    const nightTopSong = t.topSongByBucket[bucketKey] || topSongs[0] || null;

    let completed = 0; let skipped = 0;
    for (const r of skipRows) {
      if (r.completed) completed += r.count; else skipped += r.count;
    }

    res.json({
      isDemo: false,
      availableYears,
      topSongs,
      topArtists,
      topGenres,
      timeStats: { morning, afternoon, evening, night, topTimeOfDay, maxTimePlays, peakHour: t.peakHour },
      skipStats: { completed, skipped, total: completed + skipped },
      totalMinutesListened: totalRow && totalRow.total_ms ? Math.floor(totalRow.total_ms / 60000) : 0,
      advanced: {
        seasonal,
        loopRecord: loop || null,
        marathonDay: marathon || null,
        discovery,
        monthlyVibe: monthly,
        heatmap: t.heatmap,
        hourly: t.hourly,
        weekday: t.weekday,
        streak: t.streak,
        monthlyMinutes,
        counts: { ...counts, newArtists: newArtistsRow ? newArtistsRow.n : 0, activeDays: t.activeDays, totalPlays: plays.length },
        mostSkipped: mostSkipped || null,
      },
      nightTopSong,
      // Solo una canción realmente descubierta por IA (antes se falseaba con topSongs[4]).
      aiTopSong: topSongs.find(s => s.discovered_via && s.discovered_via !== 'manual') || null,
    });
  });

  return router;
};

// ─── ANÁLISIS HORARIO (Europe/Madrid) ────────────────────────────────────────
const MADRID = new Intl.DateTimeFormat('en-CA', {
  timeZone: 'Europe/Madrid', hourCycle: 'h23',
  year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', weekday: 'short',
});
const WEEKDAYS = { Mon: 0, Tue: 1, Wed: 2, Thu: 3, Fri: 4, Sat: 5, Sun: 6 };

function analyzePlays(plays, topSongs) {
  const blank = n => Array.from({ length: n }, () => ({ plays: 0, minutes: 0 }));
  const hourly = blank(24);
  const weekday = blank(7);
  const hm = { weekday: blank(24), weekend: blank(24) };
  const buckets = { morning: 0, afternoon: 0, evening: 0, night: 0 };
  const perBucketSong = { morning: new Map(), afternoon: new Map(), evening: new Map(), night: new Map() };
  const days = new Set();
  const cache = new Map();

  for (const p of plays) {
    if (!p.played_at) continue;
    let c = cache.get(p.played_at);
    if (!c) {
      const parts = {};
      for (const x of MADRID.formatToParts(new Date(`${p.played_at.replace(' ', 'T')}Z`))) parts[x.type] = x.value;
      c = { hour: Number(parts.hour) % 24, wd: WEEKDAYS[parts.weekday], day: `${parts.year}-${parts.month}-${parts.day}` };
      cache.set(p.played_at, c);
    }
    const min = (p.ms || 0) / 60000;
    hourly[c.hour].plays++; hourly[c.hour].minutes += min;
    weekday[c.wd].plays++; weekday[c.wd].minutes += min;
    const g = c.wd >= 5 ? hm.weekend : hm.weekday;
    g[c.hour].plays++; g[c.hour].minutes += min;
    days.add(c.day);
    const b = c.hour >= 6 && c.hour < 13 ? 'morning' : c.hour >= 13 && c.hour < 19 ? 'afternoon' : c.hour >= 19 ? 'evening' : 'night';
    buckets[b]++;
    if (p.song_id) perBucketSong[b].set(p.song_id, (perBucketSong[b].get(p.song_id) || 0) + (p.ms || 0));
  }

  // Canción más escuchada de cada franja (determinista, entre las del top).
  const byId = new Map(topSongs.map(s => [s.id, s]));
  const topSongByBucket = {};
  for (const [b, m] of Object.entries(perBucketSong)) {
    let best = null; let bestMs = -1;
    for (const [id, ms] of m) if (ms > bestMs && byId.has(id)) { best = byId.get(id); bestMs = ms; }
    topSongByBucket[b] = best;
  }

  let peakHour = 0;
  for (let h = 1; h < 24; h++) if (hourly[h].plays > hourly[peakHour].plays) peakHour = h;

  // Rachas de días consecutivos con escucha.
  const sorted = [...days].sort();
  let longest = 0; let run = 0; let prev = null; let longestEnd = null;
  for (const d of sorted) {
    const t = Date.UTC(+d.slice(0, 4), +d.slice(5, 7) - 1, +d.slice(8, 10));
    run = prev !== null && t - prev === 86400000 ? run + 1 : 1;
    if (run > longest) { longest = run; longestEnd = d; }
    prev = t;
  }

  const heatmap = [];
  for (const type of ['weekday', 'weekend']) {
    hm[type].forEach((v, h) => {
      if (v.plays) heatmap.push({ day_type: type, hour: String(h).padStart(2, '0'), plays: v.plays, minutes: Math.round(v.minutes * 10) / 10 });
    });
  }
  const round = a => a.map(v => ({ plays: v.plays, minutes: Math.round(v.minutes) }));
  return {
    buckets, topSongByBucket, peakHour, heatmap, hourly: round(hourly), weekday: round(weekday),
    activeDays: days.size, streak: { longest, endDay: longestEnd },
  };
}

// ─── DATOS DEMO (ids negativos: no corresponden a ninguna canción real) ──────
function getDemoData(year) {
  return {
    isDemo: true,
    totalMinutesListened: 145320,
    timeStats: { morning: 1500, afternoon: 2400, evening: 5600, night: 8900, topTimeOfDay: 'Madrugada', maxTimePlays: 8900 },
    topSongs: [
      { id: -101, title: 'Midnight City', artist: 'M83', play_count: 342, total_time_ms: 342 * 240000, cover_url: 'https://i.scdn.co/image/ab67616d0000b273d42c3f713e310024d353ec22' },
      { id: -102, title: 'Blinding Lights', artist: 'The Weeknd', play_count: 215, total_time_ms: 215 * 200000, cover_url: 'https://i.scdn.co/image/ab67616d0000b2738863bc11d2aa12b54f5aeb36' },
      { id: -103, title: 'Space Song', artist: 'Beach House', play_count: 189, total_time_ms: 189 * 320000, cover_url: 'https://i.scdn.co/image/ab67616d0000b273c52e61a6c421715454641e72' },
      { id: -104, title: 'Resonance', artist: 'HOME', play_count: 145, total_time_ms: 145 * 212000, cover_url: 'https://i.scdn.co/image/ab67616d0000b2733d7ebc5a92a353cb5f23bb6d' },
      { id: -105, title: 'Goth', artist: 'Sidewalks and Skeletons', play_count: 120, total_time_ms: 120 * 180000, cover_url: 'https://i.scdn.co/image/ab67616d0000b2732a32501ab1a1dd1d9b32c694' },
    ],
    topArtists: [
      { artist: 'M83', total_time_ms: 8000000, top_song_id: -101 },
      { artist: 'The Weeknd', total_time_ms: 6500000, top_song_id: -102 },
      { artist: 'Beach House', total_time_ms: 5000000, top_song_id: -103 },
      { artist: 'Crystal Castles', total_time_ms: 4000000, top_song_id: -106 },
      { artist: 'Deftones', total_time_ms: 3800000, top_song_id: -107 },
    ],
    topGenres: [
      { genre: 'Synthwave', total_time_ms: 15000000 },
      { genre: 'Dream Pop', total_time_ms: 12000000 },
      { genre: 'Darkwave', total_time_ms: 8000000 },
      { genre: 'Shoegaze', total_time_ms: 6000000 },
      { genre: 'Alternative Metal', total_time_ms: 5000000 },
    ],
    skipStats: { completed: 12400, skipped: 8200, total: 20600 },
    advanced: {
      seasonal: [
        { season: 'Primavera', dominant_genre: 'Dream Pop', minutes: 3400 },
        { season: 'Verano', dominant_genre: 'Synthwave', minutes: 5600 },
        { season: 'Otoño', dominant_genre: 'Shoegaze', minutes: 2800 },
        { season: 'Invierno', dominant_genre: 'Darkwave', minutes: 6100 },
      ],
      loopRecord: { title: 'Midnight City', artist: 'M83', id: -101, consecutive_plays: 14 },
      marathonDay: { day: `${year === 'all' ? '2026' : year}-08-14`, total_plays: 245, total_minutes: 860, distinct_songs: 80, top_song_id: null },
      discovery: [
        { discovered_via: 'manual', count: 450 },
        { discovered_via: 'gemini', count: 125 },
        { discovered_via: 'lastfm', count: 34 },
      ],
      monthlyVibe: ['Darkwave', 'Darkwave', 'Dream Pop', 'Dream Pop', 'Dream Pop', 'Synthwave', 'Synthwave', 'Synthwave', 'Shoegaze', 'Shoegaze', 'Shoegaze', 'Darkwave']
        .map((g, i) => ({ month: String(i + 1).padStart(2, '0'), dominant_genre: g })),
      heatmap: [],
      hourly: [1,0,0,0,0,0,1,2,2,3,3,4,5,4,4,5,6,7,8,9,9,8,5,2].map(n => ({ plays: n * 10, minutes: n * 40 })),
      weekday: [20, 22, 25, 24, 30, 40, 45].map(n => ({ plays: n * 10, minutes: n * 40 })),
      streak: { longest: 21, endDay: '2026-08-30' },
      monthlyMinutes: Array.from({ length: 12 }, (_, i) => ({ month: String(i + 1).padStart(2, '0'), minutes: 1500 + ((i * 937) % 2500) })),
      counts: { songs: 640, artists: 210, genres: 38, plays: 20600, newArtists: 87, activeDays: 280, totalPlays: 20600 },
      mostSkipped: { title: 'Dance Monkey', artist: 'Tones and I', id: -999, skip_rate: 94, avg_skip_at_seconds: 12, cover_url: 'https://i.scdn.co/image/ab67616d0000b273c52e61a6c421715454641e72' },
    },
    nightTopSong: { id: -105, title: 'Goth', artist: 'Sidewalks and Skeletons' },
    aiTopSong: { id: -104, title: 'Resonance', artist: 'HOME', discovered_via: 'gemini' },
  };
}

module.exports.getDemoData = getDemoData;
