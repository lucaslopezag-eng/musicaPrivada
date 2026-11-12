'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { validateMediaUrl, isSpotifyCollectionUrl } = require('../src/net/urlPolicy');

test('solo YouTube https', () => {
  assert.ok(validateMediaUrl('https://youtube.com/watch?v=dQw4w9WgXcQ'));
  assert.ok(validateMediaUrl('https://www.youtube.com/watch?v=dQw4w9WgXcQ'));
  assert.ok(validateMediaUrl('https://youtu.be/dQw4w9WgXcQ'));
  for (const u of ['--exec=rm -rf /', '-o/tmp/x', 'http://youtube.com/watch?v=x', 'https://evil.com/youtube.com',
    'https://youtube.com.evil.com/', 'https://127.0.0.1/', 'file:///etc/passwd', 'https://user:p@youtube.com/', 'https://youtube.com:8443/', 123, null]) {
    assert.equal(validateMediaUrl(u), null, String(u));
  }
});

test('URLs de Spotify', () => {
  assert.ok(isSpotifyCollectionUrl('https://open.spotify.com/playlist/37i9dQZF1DXcBWIGoYBM5M'));
  assert.ok(isSpotifyCollectionUrl('https://open.spotify.com/intl-es/album/4aawyAB9vmqN3uQ7FjRGTy?si=abc'));
  assert.equal(isSpotifyCollectionUrl('https://open.spotify.com.evil.com/playlist/37i9dQZF1DXcBWIGoYBM5M'), false);
  assert.equal(isSpotifyCollectionUrl('http://localhost/playlist/abc'), false);
});
