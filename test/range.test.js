'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { parseRange } = require('../src/media/range');

test('sin cabecera Range → null (200 completo)', () => {
  assert.equal(parseRange(undefined, 1000), null);
  assert.equal(parseRange('', 1000), null);
});

test('rangos válidos', () => {
  assert.deepEqual(parseRange('bytes=0-499', 1000), { start: 0, end: 499 });
  assert.deepEqual(parseRange('bytes=500-', 1000), { start: 500, end: 999 });
  assert.deepEqual(parseRange('bytes=-500', 1000), { start: 500, end: 999 });   // sufijo (antes NaN)
  assert.deepEqual(parseRange('bytes=-5000', 1000), { start: 0, end: 999 });
  assert.deepEqual(parseRange('bytes=900-5000', 1000), { start: 900, end: 999 }); // fin recortado
  assert.deepEqual(parseRange('bytes=999-999', 1000), { start: 999, end: 999 });
});

test('rangos no satisfacibles → 416', () => {
  for (const h of ['bytes=abc', 'bytes=1000-', 'bytes=5000-6000', 'bytes=500-100', 'bytes=-0', 'bytes=-', 'bytes=0-1,5-6', 'bytes']) {
    assert.deepEqual(parseRange(h, 1000), { unsatisfiable: true }, h);
  }
  assert.deepEqual(parseRange('bytes=0-', 0), { unsatisfiable: true });
  assert.deepEqual(parseRange('bytes=99999999999999999999-', 1000), { unsatisfiable: true });
});

test('unidad desconocida se ignora', () => {
  assert.equal(parseRange('items=0-5', 1000), null);
});
