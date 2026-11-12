'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const http = require('http');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { streamFile } = require('../src/media/stream');

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'mp-stream-'));
const file = path.join(tmp, 'a.opus');
fs.writeFileSync(file, Buffer.alloc(1000, 7));

function serve(opts = {}) {
  return http.createServer((req, res) => {
    req.query = Object.fromEntries(new URL(req.url, 'http://x').searchParams);
    res.status = (c) => { res.statusCode = c; return res; };
    res.send = (b) => res.end(b);
    streamFile(req, res, req.url.startsWith('/missing') ? path.join(tmp, 'nope') : file, opts);
  });
}

async function request(server, headers = {}, urlPath = '/') {
  await new Promise(r => server.listen(0, r));
  const { port } = server.address();
  try {
    return await new Promise((resolve, reject) => {
      http.get({ port, path: urlPath, headers }, (res) => {
        const chunks = [];
        res.on('data', c => chunks.push(c));
        res.on('end', () => resolve({ status: res.statusCode, headers: res.headers, body: Buffer.concat(chunks) }));
      }).on('error', reject);
    });
  } finally {
    server.close();
  }
}

test('200 completo con Accept-Ranges y caché privada', async () => {
  const r = await request(serve());
  assert.equal(r.status, 200);
  assert.equal(r.body.length, 1000);
  assert.equal(r.headers['accept-ranges'], 'bytes');
  assert.match(r.headers['cache-control'], /^private/);
});

test('206 con sufijo', async () => {
  const r = await request(serve(), { Range: 'bytes=-100' });
  assert.equal(r.status, 206);
  assert.equal(r.body.length, 100);
  assert.equal(r.headers['content-range'], 'bytes 900-999/1000');
});

test('416 en rango inválido (antes colgaba)', async () => {
  for (const range of ['bytes=abc', 'bytes=5000-']) {
    const r = await request(serve(), { Range: range });
    assert.equal(r.status, 416, range);
    assert.equal(r.headers['content-range'], 'bytes */1000');
  }
});

test('304 con If-None-Match', async () => {
  const first = await request(serve());
  const r = await request(serve(), { 'If-None-Match': first.headers.etag });
  assert.equal(r.status, 304);
});

test('inmutable solo si se pide', async () => {
  const r = await request(serve({ immutable: true }));
  assert.match(r.headers['cache-control'], /immutable/);
});

test('404 si falta el archivo', async () => {
  const r = await request(serve(), {}, '/missing');
  assert.equal(r.status, 404);
});

test('throttle opcional entrega el contenido completo', async () => {
  const r = await request(serve({ throttleBps: 50 * 1024 }));
  assert.equal(r.body.length, 1000);
});

test.after(() => fs.rmSync(tmp, { recursive: true, force: true }));
