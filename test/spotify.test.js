'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { createSpotifyClient, parseSpotifyUrl, parseEmbedHtml, pickImage, formatLine } = require('../src/services/spotify');

const PL = 'https://open.spotify.com/intl-es/playlist/37i9dQZF1DXcBWIGoYBM5M?si=1';

function response(status, body, headers = {}) {
  const text = typeof body === 'string' ? body : JSON.stringify(body);
  return {
    ok: status >= 200 && status < 300,
    status,
    headers: { get: (k) => headers[k.toLowerCase()] ?? null },
    json: async () => JSON.parse(text),
    text: async () => text,
  };
}

function embedHtml(entity) {
  return `<html><body><script id="__NEXT_DATA__" type="application/json">${JSON.stringify({ props: { pageProps: { state: { data: { entity } } } } })}</script></body></html>`;
}

test('URLs de Spotify', () => {
  assert.deepEqual(parseSpotifyUrl(PL), { type: 'playlist', id: '37i9dQZF1DXcBWIGoYBM5M' });
  assert.deepEqual(parseSpotifyUrl('https://open.spotify.com/album/4aawyAB9vmqN3uQ7FjRGTy'), { type: 'album', id: '4aawyAB9vmqN3uQ7FjRGTy' });
  for (const bad of ['https://open.spotify.com/track/4aawyAB9vmqN3uQ7FjRGTy', 'https://evil.com/playlist/37i9dQZF1DXcBWIGoYBM5M', 'http://open.spotify.com/playlist/37i9dQZF1DXcBWIGoYBM5M', '']) {
    assert.equal(parseSpotifyUrl(bad), null, bad);
  }
});

test('utilidades de formato', () => {
  assert.equal(pickImage([{ url: 'https://a/640', width: 640 }, { url: 'https://a/300', width: 300 }, { url: 'https://a/64', width: 64 }]), 'https://a/300');
  assert.equal(pickImage([]), '');
  assert.equal(formatLine({ title: ' Song A ', artists: 'X, Y', image: 'https://i/1' }), 'Song A - X, Y | https://i/1');
  assert.equal(formatLine({ title: 'S', artists: '', image: 'javascript:x' }), 'S');
  assert.equal(formatLine({ title: '' }), null);
});

test('JSON del reproductor embebido', () => {
  const html = embedHtml({
    name: 'Mi lista',
    coverArt: { sources: [{ url: 'https://img/cover', width: 300 }] },
    trackList: [
      { title: 'Uno', subtitle: 'Artista A', entityType: 'track' },
      { title: 'Episodio', subtitle: 'Pod', entityType: 'episode' },
      { title: 'Dos', subtitle: 'B, C' },
    ],
  });
  const parsed = parseEmbedHtml(html);
  assert.equal(parsed.name, 'Mi lista');
  assert.deepEqual(parsed.tracks.map(t => t.title), ['Uno', 'Dos']);
  assert.equal(parsed.tracks[0].image, 'https://img/cover');
  assert.throws(() => parseEmbedHtml('<html></html>'), /no contiene datos/);
});

test('sin credenciales: usa el reproductor embebido y deduplica', async () => {
  const calls = [];
  const fetch = async (url) => {
    calls.push(url);
    return response(200, embedHtml({ name: 'L', trackList: [{ title: 'A', subtitle: 'X' }, { title: 'a', subtitle: 'x' }, { title: 'B', subtitle: 'Y' }] }));
  };
  const client = createSpotifyClient({ fetch });
  const out = await client.fetchCollection(PL);
  assert.equal(client.hasCredentials, false);
  assert.equal(out.source, 'embed');
  assert.deepEqual(out.lines, ['A - X', 'B - Y']);
  assert.deepEqual(calls, ['https://open.spotify.com/embed/playlist/37i9dQZF1DXcBWIGoYBM5M']);
});

test('con credenciales: Web API paginada, token reutilizado, episodios descartados', async () => {
  const calls = [];
  const page2 = 'https://api.spotify.com/v1/playlists/37i9dQZF1DXcBWIGoYBM5M/tracks?offset=100&limit=100';
  const fetch = async (url, init = {}) => {
    calls.push([url, init.method || 'GET', init.headers && init.headers.Authorization]);
    if (url === 'https://accounts.spotify.com/api/token') {
      assert.equal(init.body, 'grant_type=client_credentials');
      assert.equal(init.headers.Authorization, `Basic ${Buffer.from('id:secret').toString('base64')}`);
      return response(200, { access_token: 'tok', expires_in: 3600 });
    }
    assert.equal(init.headers.Authorization, 'Bearer tok');
    if (url.includes('?fields=name')) return response(200, { name: 'Lista API' });
    if (url === page2) return response(200, { next: null, items: [{ track: { name: 'T3', type: 'track', artists: [{ name: 'C' }], album: { images: [] } } }] });
    return response(200, {
      next: page2,
      items: [
        { track: { name: 'T1', type: 'track', artists: [{ name: 'A' }, { name: 'B' }], album: { images: [{ url: 'https://img/1', width: 300 }] } } },
        { track: { name: 'Ep', type: 'episode', artists: [] } },
        { track: null },
      ],
    });
  };
  const client = createSpotifyClient({ clientId: 'id', clientSecret: 'secret', fetch });
  const out = await client.fetchCollection(PL);
  assert.equal(out.source, 'web-api');
  assert.equal(out.name, 'Lista API');
  assert.deepEqual(out.lines, ['T1 - A, B | https://img/1', 'T3 - C']);
  await client.fetchCollection(PL);
  assert.equal(calls.filter(c => c[0].includes('accounts.spotify.com')).length, 1, 'token en caché');
});

test('álbum por Web API y caída al embebido si la API devuelve 404', async () => {
  const fetch = async (url) => {
    if (url.includes('accounts.spotify.com')) return response(200, { access_token: 't', expires_in: 3600 });
    if (url.includes('/v1/albums/')) {
      return response(200, { name: 'Disco', images: [{ url: 'https://img/a', width: 300 }], tracks: { next: null, items: [{ name: 'Pista', artists: [{ name: 'Z' }] }] } });
    }
    if (url.includes('/v1/playlists/')) return response(404, { error: { status: 404 } });
    return response(200, embedHtml({ name: 'Embed', trackList: [{ title: 'E', subtitle: 'F' }] }));
  };
  const logs = [];
  const client = createSpotifyClient({ clientId: 'a', clientSecret: 'b', fetch, log: m => logs.push(m) });
  const album = await client.fetchCollection('https://open.spotify.com/album/4aawyAB9vmqN3uQ7FjRGTy');
  assert.deepEqual(album.lines, ['Pista - Z | https://img/a']);
  const pl = await client.fetchCollection(PL);
  assert.equal(pl.source, 'embed');
  assert.ok(logs.some(l => /se usa la página embebida/.test(l)));
  await assert.rejects(client.fetchCollection('https://open.spotify.com/track/xyzxyzxyzxyz'), /Solo se admiten/);
});

test('reintenta 429 respetando Retry-After', async () => {
  let n = 0;
  const fetch = async () => {
    n += 1;
    if (n === 1) return response(429, '', { 'retry-after': '0' });
    return response(200, embedHtml({ name: 'L', trackList: [{ title: 'A', subtitle: 'B' }] }));
  };
  const out = await createSpotifyClient({ fetch }).fetchCollection(PL);
  assert.equal(n, 2);
  assert.deepEqual(out.lines, ['A - B']);
});
