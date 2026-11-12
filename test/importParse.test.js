'use strict';
// parseTrackList vive en routes/importer.js, que requiere dependencias npm;
// se carga con stubs mínimos para probar solo el parser.
const test = require('node:test');
const assert = require('node:assert/strict');
const Module = require('module');

const stubs = { express: { Router: () => ({ post() {}, get() {} }) }, 'yt-search': () => ({}), 'node-fetch': () => {} };
const origLoad = Module._load;
Module._load = function load(request, ...rest) {
  if (Object.prototype.hasOwnProperty.call(stubs, request)) return stubs[request];
  return origLoad.call(this, request, ...rest);
};
const { parseTrackList } = require('../routes/importer');
Module._load = origLoad;

test('texto plano', () => {
  assert.deepEqual(parseTrackList('A - B\n\n C - D \n'), ['A - B', 'C - D']);
});

test('lista markdown numerada', () => {
  assert.deepEqual(parseTrackList('1. **Song** – Artist\n2) Otra - Persona'), ['Song - Artist', 'Otra - Persona']);
});

test('JSON con imágenes (solo http/https)', () => {
  const json = JSON.stringify({ a: { title: 'T', artist: 'A', image: 'https://x/y.jpg' }, b: { title: 'U', artist: 'B', image: 'javascript:alert(1)' }, c: null });
  assert.deepEqual(parseTrackList(json), ['T - A | https://x/y.jpg', 'U - B']);
  assert.throws(() => parseTrackList('{no json}'));
});
