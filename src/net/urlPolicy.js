'use strict';
// ─── LISTA BLANCA DE URLS PARA yt-dlp ────────────────────────────────────────
// AUTH-05: solo se aceptan URLs https de YouTube. Una URL que empiece por "-"
// nunca llega a yt-dlp como opción porque además se pasa tras "--".

const YOUTUBE_HOSTS = new Set([
  'youtube.com', 'www.youtube.com', 'm.youtube.com', 'music.youtube.com', 'youtu.be',
]);

function validateMediaUrl(raw) {
  if (typeof raw !== 'string' || raw.length > 2048) return null;
  let url;
  try { url = new URL(raw.trim()); } catch { return null; }
  if (url.protocol !== 'https:') return null;
  if (url.username || url.password || url.port) return null;
  if (!YOUTUBE_HOSTS.has(url.hostname.toLowerCase())) return null;
  return url.href;
}

const SPOTIFY_COLLECTION_RE = /^https:\/\/open\.spotify\.com\/(?:intl-[a-z]{2}(?:-[a-z]{2})?\/)?(playlist|album)\/[A-Za-z0-9]{10,40}(?:[/?#].*)?$/;

function isSpotifyCollectionUrl(text) {
  return typeof text === 'string' && SPOTIFY_COLLECTION_RE.test(text.trim());
}

// Las portadas/miniaturas pueden venir de cualquier CDN público; la protección
// real la aplica safeFetch. Aquí solo se filtran valores obviamente inválidos.
function looksLikeHttpUrl(text) {
  return typeof text === 'string' && /^https?:\/\//i.test(text.trim()) && text.length <= 2048;
}

module.exports = { validateMediaUrl, isSpotifyCollectionUrl, looksLikeHttpUrl, YOUTUBE_HOSTS };
