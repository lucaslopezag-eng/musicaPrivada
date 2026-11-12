'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { shiftVtt, parseTimestamp } = require('../src/media/vtt');

const VTT = `WEBVTT

00:00:01.000 --> 00:00:04.000
Intro

00:00:10.500 --> 00:00:12.000 align:start
Verso

00:01:00.000 --> 00:01:05.000
Final`;

test('desplaza y descarta cues fuera del recorte', () => {
  const out = shiftVtt(VTT, 5, 50);
  assert.match(out, /^WEBVTT/);
  assert.doesNotMatch(out, /Intro/);
  assert.match(out, /00:00:05\.500 --> 00:00:07\.000 align:start\nVerso/);
  assert.doesNotMatch(out, /Final/);
});

test('cue que empieza antes del corte se recorta a 0', () => {
  const out = shiftVtt(VTT, 2, 100);
  assert.match(out, /00:00:00\.000 --> 00:00:02\.000\nIntro/);
});

test('parseTimestamp', () => {
  assert.equal(parseTimestamp('01:02.500'), 62.5);
  assert.equal(parseTimestamp('01:00:00.000'), 3600);
  assert.equal(parseTimestamp('nope'), null);
});
