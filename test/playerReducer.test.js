'use strict';
// Máquina de estados del reproductor (frontend/src/hooks/playerReducer.js, ESM).
// Reproduce los escenarios de handleNext/handlePrev/playSong de la v2.0.
const test = require('node:test');
const assert = require('node:assert/strict');

let R;
test.before(async () => { R = await import('../frontend/src/hooks/playerReducer.js'); });

const songs = [1, 2, 3, 4].map(id => ({ id, title: `S${id}` }));
const rec = (n) => ({ id: `ai-${n}`, rec_id: n, title: `AI${n}` });
const ids = (list) => list.map(s => s.id);

function play(state, song, extra = {}) {
  return R.playerReducer(state, { type: 'SET_TRACK', song, songs, shuffled: [...songs].reverse(), ...extra });
}
const next = (state, natural = false, extra = {}) =>
  R.playerReducer(state, { type: 'NEXT_TRACK', natural, songs, shuffled: [...songs].reverse(), aiGap: 3, aiGapAfterReshuffle: 1, ...extra });

test('SET_TRACK carga la pista, historial y "a continuación" (orden normal)', () => {
  let s = R.createInitialPlayerState();
  s = play(s, songs[1]);
  assert.equal(s.currentSong.id, 2);
  assert.equal(s.isPlaying, true);
  assert.equal(s.loadSeq, 1);
  assert.deepEqual(ids(s.autoQueue), [3, 4]);
  s = play(s, songs[0]);
  assert.deepEqual(ids(s.history), [2]);
  assert.deepEqual(ids(s.autoQueue), [2, 3, 4]);
});

test('NEXT_TRACK: cola explícita primero, luego autoQueue, y fin de lista', () => {
  let s = play(R.createInitialPlayerState(), songs[2]); // autoQueue [4]
  s = R.playerReducer(s, { type: 'ENQUEUE', song: songs[0] });
  s = next(s);
  assert.equal(s.currentSong.id, 1, 'cola explícita');
  assert.deepEqual(s.queue, []);
  s = next(s);
  assert.equal(s.currentSong.id, 4, 'autoQueue');
  const end = next(s, true);
  assert.equal(end.currentSong.id, 4);
  assert.equal(end.isPlaying, false, 'fin natural sin repetir → se detiene');
  assert.equal(end.loadSeq, s.loadSeq);
  const manual = next(s, false);
  assert.equal(manual.currentSong.id, 1, 'salto manual al final vuelve al principio');
});

test('repetir: una (solo fin natural) y todas', () => {
  let s = play(R.createInitialPlayerState({ repeatMode: 'one' }), songs[3]);
  const restarted = next(s, true);
  assert.equal(restarted.currentSong.id, 4);
  assert.equal(restarted.restartSeq, 1);
  assert.equal(restarted.loadSeq, s.loadSeq);
  assert.equal(next(s, false).currentSong.id, 1, 'el botón siguiente sí avanza');
  s = R.playerReducer(s, { type: 'CYCLE_REPEAT' });
  assert.equal(s.repeatMode, 'off');
  s = R.playerReducer(R.playerReducer(s, { type: 'CYCLE_REPEAT' }), { type: 'NEXT_TRACK', natural: true, songs: [], shuffled: [] });
  assert.equal(s.repeatMode, 'all');
  const all = next({ ...s, autoQueue: [] }, true);
  assert.equal(all.currentSong.id, 1, 'repetir-todo vuelve al principio');
});

test('aleatorio: autoQueue barajado y rebarajado al agotarse', () => {
  let s = R.playerReducer(R.createInitialPlayerState(), { type: 'SET_SHUFFLE_MODE', mode: 'shuffle', songs, shuffled: [songs[2], songs[0], songs[3], songs[1]] });
  assert.deepEqual(ids(s.autoQueue), [3, 1, 4, 2]);
  s = play(s, songs[0]);
  assert.deepEqual(ids(s.autoQueue), [4, 3, 2], 'barajado sin la actual');
  s = { ...s, autoQueue: [] };
  assert.equal(next(s, true).isPlaying, false, 'sin repetir-todo se detiene');
  const reshuffled = next(s, false);
  assert.equal(reshuffled.currentSong.id, 4);
  assert.deepEqual(ids(reshuffled.autoQueue), [3, 2, 1]);
  assert.equal(R.playerReducer(s, { type: 'TOGGLE_SHUFFLE', songs }).shuffleMode, 'normal');
});

test('modo IA: intercala recomendaciones y las informa correctamente', () => {
  let s = R.createInitialPlayerState({ shuffleMode: 'ai', songsUntilRec: 2 });
  s = play(s, songs[0]);
  s = R.playerReducer(s, { type: 'SET_AI_QUEUE', recs: [rec(7), rec(8)] });
  s = next(s);
  assert.equal(s.currentAiRec, null, 'primera: canción normal');
  assert.equal(s.songsUntilRec, 1);
  const before = s;
  s = next(s);
  assert.equal(s.currentSong.id, 'ai-7');
  assert.equal(s.currentAiRec.rec_id, 7);
  assert.equal(s.songsUntilRec, 3, 'nuevo intervalo de la acción');
  assert.deepEqual(s.aiQueue.map(r => r.rec_id), [8]);
  assert.equal(R.aiReportFor(before, s, { type: 'NEXT_TRACK' }), null);

  // La que suena no se re-encola aunque el servidor la siga listando.
  const refreshed = R.playerReducer(s, { type: 'SET_AI_QUEUE', recs: [rec(7), rec(9)] });
  assert.deepEqual(refreshed.aiQueue.map(r => r.rec_id), [9]);

  const skipped = next(s, false);
  assert.deepEqual(R.aiReportFor(s, skipped, { type: 'NEXT_TRACK', natural: false }), { recId: 7, kind: 'skip' });
  const ended = next(s, true);
  assert.deepEqual(R.aiReportFor(s, ended, { type: 'NEXT_TRACK', natural: true }), { recId: 7, kind: 'played' });
  assert.equal(R.aiReportFor(s, skipped, { type: 'NEXT_TRACK', skipAiReport: true }), null, 'pulgar abajo ya informó');
  const back = R.playerReducer(s, { type: 'PREV_TRACK', songs, currentTime: 10 });
  assert.equal(back.currentAiRec, null);
  assert.equal(R.aiReportFor(s, back, { type: 'PREV_TRACK' }), null, 'volver atrás no es un rechazo');
  const picked = play(s, songs[3]);
  assert.deepEqual(R.aiReportFor(s, picked, { type: 'SET_TRACK' }), { recId: 7, kind: 'skip' });
});

test('PREV_TRACK: historial, reinicio si > 3 s y canción anterior', () => {
  let s = play(R.createInitialPlayerState(), songs[1]);
  s = play(s, songs[2]);
  const fromHistory = R.playerReducer(s, { type: 'PREV_TRACK', songs, currentTime: 50 });
  assert.equal(fromHistory.currentSong.id, 2);
  assert.deepEqual(fromHistory.history, [], 'no se vuelve a apuntar al historial');
  const fresh = { ...s, history: [] };
  const restart = R.playerReducer(fresh, { type: 'PREV_TRACK', songs, currentTime: 12 });
  assert.equal(restart.currentSong.id, 3);
  assert.equal(restart.seek.seq, 1);
  assert.equal(restart.seek.time, 0);
  const prev = R.playerReducer(fresh, { type: 'PREV_TRACK', songs, currentTime: 1 });
  assert.equal(prev.currentSong.id, 2);
  const wrap = R.playerReducer({ ...fresh, currentSong: songs[0] }, { type: 'PREV_TRACK', songs, currentTime: 0 });
  assert.equal(wrap.currentSong.id, 4);
});

test('cola: añadir, siguiente, mover, quitar y reproducir desde la cola', () => {
  let s = R.createInitialPlayerState();
  s = R.playerReducer(s, { type: 'ENQUEUE', song: songs[0] });
  s = R.playerReducer(s, { type: 'ENQUEUE', song: songs[1] });
  s = R.playerReducer(s, { type: 'ENQUEUE_NEXT', song: songs[2] });
  assert.deepEqual(ids(s.queue), [3, 1, 2]);
  s = R.playerReducer(s, { type: 'MOVE_IN_QUEUE', from: 0, to: 2 });
  assert.deepEqual(ids(s.queue), [1, 2, 3]);
  assert.equal(R.playerReducer(s, { type: 'MOVE_IN_QUEUE', from: 0, to: 9 }), s);
  s = R.playerReducer(s, { type: 'REMOVE_FROM_QUEUE', index: 1 });
  assert.deepEqual(ids(s.queue), [1, 3]);
  s = play(s, songs[2], { fromQueueIndex: 1 });
  assert.equal(s.currentSong.id, 3);
  assert.deepEqual(ids(s.queue), [1], 'la que suena sale de la cola (antes sonaba dos veces)');
});

test('volumen, búsqueda, borrado de canción, reinicio y precarga', () => {
  let s = play(R.createInitialPlayerState(), songs[0]);
  assert.equal(R.playerReducer(s, { type: 'SET_VOLUME', volume: 7 }).volume, 1);
  assert.equal(R.playerReducer(s, { type: 'SET_VOLUME', volume: -1 }).volume, 0);
  assert.equal(R.playerReducer(s, { type: 'TOGGLE_MUTE' }).muted, true);
  assert.equal(R.playerReducer(s, { type: 'SEEK_TO', time: 42 }).seek.time, 42);
  assert.equal(R.playerReducer(s, { type: 'SEEK_TO', time: NaN }), s);
  assert.equal(R.peekNext(s, songs).id, 2);
  const removed = R.playerReducer(s, { type: 'REMOVE_SONG', id: 1 });
  assert.equal(removed.currentSong, null);
  assert.equal(removed.isPlaying, false);
  assert.equal(removed.loadSeq, s.loadSeq + 1);
  const otherRemoved = R.playerReducer(s, { type: 'REMOVE_SONG', id: 2 });
  assert.deepEqual(ids(otherRemoved.autoQueue), [3, 4]);
  const updated = R.playerReducer(s, { type: 'UPDATE_SONG', song: { id: 1, rev: 5 } });
  assert.equal(updated.currentSong.rev, 5);
  assert.equal(updated.currentSong.title, 'S1');
  const reset = R.playerReducer({ ...s, repeatMode: 'all' }, { type: 'RESET' });
  assert.equal(reset.currentSong, null);
  assert.equal(reset.repeatMode, 'all', 'las preferencias se conservan');
  assert.deepEqual(reset.queue, []);
  // Reconstrucción tras restaurar la sesión (la cola no se persiste).
  const restored = R.createInitialPlayerState({ currentSong: songs[1] });
  assert.deepEqual(ids(R.playerReducer(restored, { type: 'REBUILD_AUTO_QUEUE', songs }).autoQueue), [3, 4]);
  assert.equal(R.playerReducer({ ...s, isPlaying: false }, { type: 'PLAY' }).isPlaying, true);
  assert.equal(R.playerReducer(R.createInitialPlayerState(), { type: 'PLAY' }).isPlaying, false, 'sin canción no hay play');
});

test('el reducer es puro: no muta el estado de entrada', () => {
  const s = Object.freeze(play(R.createInitialPlayerState(), songs[0]));
  Object.freeze(s.queue); Object.freeze(s.autoQueue); Object.freeze(s.history);
  for (const a of [{ type: 'NEXT_TRACK', songs }, { type: 'PREV_TRACK', songs }, { type: 'ENQUEUE', song: songs[2] },
    { type: 'SET_SHUFFLE_MODE', mode: 'ai', songs }, { type: 'REMOVE_SONG', id: 2 }, { type: 'CYCLE_REPEAT' }]) {
    assert.doesNotThrow(() => R.playerReducer(s, a), a.type);
  }
});

// ─── Botones 👍/👎 de la IA (auditoría B1/B2) ────────────────────────────────
// currentAiRec se deduce de la propia canción (id "ai-<n>"), así que no depende
// de cómo se llegó a ella.

test('IA: al restaurar la sesión con una recomendación sonando se conservan los botones', () => {
  const restored = R.createInitialPlayerState({ currentSong: rec(7), shuffleMode: 'ai' });
  assert.equal(restored.currentAiRec.rec_id, 7);
  // Una canción IA guardada sin rec_id lo recupera de su id.
  assert.equal(R.createInitialPlayerState({ currentSong: { id: 'ai-9', title: 'AI9' } }).currentAiRec.rec_id, 9);
  // Una canción normal o un id IA no válido no llevan botones.
  assert.equal(R.createInitialPlayerState({ currentSong: songs[0] }).currentAiRec, null);
  assert.equal(R.createInitialPlayerState({ currentSong: { id: 'ai-x' } }).currentAiRec, null);
  assert.equal(R.createInitialPlayerState().currentAiRec, null);

  // El servidor la sigue listando como "downloaded": no se vuelve a encolar.
  const withQueue = R.playerReducer(restored, { type: 'SET_AI_QUEUE', recs: [rec(7), rec(8)] });
  assert.deepEqual(withQueue.aiQueue.map(r => r.rec_id), [8]);

  // Y al terminar o saltarla ya se informa al servidor (antes se quedaba "downloaded").
  const s = R.playerReducer(restored, { type: 'REBUILD_AUTO_QUEUE', songs, shuffled: songs });
  const ended = next(s, true);
  assert.deepEqual(R.aiReportFor(s, ended, { type: 'NEXT_TRACK', natural: true }), { recId: 7, kind: 'played' });
  const skipped = next(s, false);
  assert.equal(skipped.currentAiRec, null);
  assert.deepEqual(R.aiReportFor(s, skipped, { type: 'NEXT_TRACK', natural: false }), { recId: 7, kind: 'skip' });
});

test('IA: "anterior" hasta una recomendación del historial recupera los botones', () => {
  let s = play(R.createInitialPlayerState({ shuffleMode: 'ai' }), rec(7)); // suena la recomendación
  assert.equal(s.currentAiRec.rec_id, 7);
  s = next(s); // pasa a una canción normal; la recomendación queda en el historial
  assert.equal(s.currentAiRec, null);
  assert.equal(s.history[0].id, 'ai-7');
  const back = R.playerReducer(s, { type: 'PREV_TRACK', songs, currentTime: 1 });
  assert.equal(back.currentSong.id, 'ai-7');
  assert.equal(back.currentAiRec.rec_id, 7);
  assert.equal(R.aiReportFor(s, back, { type: 'PREV_TRACK' }), null);

  // Salir de la recomendación con "anterior" quita los botones y no es un rechazo.
  const withHistory = play(play(R.createInitialPlayerState(), songs[0]), rec(7));
  const left = R.playerReducer(withHistory, { type: 'PREV_TRACK', songs, currentTime: 1 });
  assert.equal(left.currentSong.id, 1);
  assert.equal(left.currentAiRec, null);
  assert.equal(R.aiReportFor(withHistory, left, { type: 'PREV_TRACK' }), null);
});

test('IA: elegir una recomendación desde el historial (SET_TRACK) muestra los botones', () => {
  let s = play(R.createInitialPlayerState(), songs[0]);
  s = play(s, rec(7)); // p. ej. clic en el historial del panel de cola
  assert.equal(s.currentSong.id, 'ai-7');
  assert.equal(s.currentAiRec.rec_id, 7);
  assert.equal(s.loadSeq, 2);
  // Volver a pulsar la misma no la informa como saltada…
  const again = play(s, rec(7));
  assert.equal(R.aiReportFor(s, again, { type: 'SET_TRACK' }), null);
  // …y elegir otra canción sí ("skip", archivada y recuperable).
  const other = play(s, songs[2]);
  assert.equal(other.currentAiRec, null);
  assert.deepEqual(R.aiReportFor(s, other, { type: 'SET_TRACK' }), { recId: 7, kind: 'skip' });
});

test('IA: "anterior" pasados 3 s reinicia la pista y mantiene los botones', () => {
  const s = R.createInitialPlayerState({ currentSong: rec(7), shuffleMode: 'ai' }); // sin historial
  const restart = R.playerReducer(s, { type: 'PREV_TRACK', songs, currentTime: 10 });
  assert.equal(restart.currentSong.id, 'ai-7');
  assert.equal(restart.currentAiRec.rec_id, 7, 'los botones siguen');
  assert.equal(restart.seek.seq, s.seek.seq + 1);
  assert.equal(restart.seek.time, 0);
  assert.equal(restart.loadSeq, s.loadSeq, 'no se recarga la pista');
  assert.equal(R.aiReportFor(s, restart, { type: 'PREV_TRACK' }), null);
});

test('IA: una recomendación aceptada se sustituye por su canción de la biblioteca sin recargar el audio', () => {
  let s = play(R.createInitialPlayerState({ shuffleMode: 'ai' }), songs[0]);
  s = play(s, rec(7));
  const accepted = { id: 99, title: 'AI7', rev: 0 };
  const swapped = R.playerReducer(s, { type: 'REPLACE_SONG', fromId: 'ai-7', song: accepted });
  assert.equal(swapped.currentSong.id, 99);
  assert.equal(swapped.currentAiRec, null, 'ya no lleva botones');
  assert.equal(swapped.loadSeq, s.loadSeq, 'el audio no se recarga');
  assert.equal(swapped.isPlaying, s.isPlaying);
  // Al pasar de canción ya no se informa nada sobre la recomendación.
  const after = next(swapped);
  assert.equal(R.aiReportFor(swapped, after, { type: 'NEXT_TRACK', natural: false }), null);
  // Y al volver con "anterior" es una canción normal, sin botones.
  const back = R.playerReducer(after, { type: 'PREV_TRACK', songs, currentTime: 1 });
  assert.equal(back.currentSong.id, 99);
  assert.equal(back.currentAiRec, null);

  // Si ya no es la actual, se sustituye en el historial y no toca lo que suena.
  const moved = next(s); // la recomendación pasa al historial
  const inHistory = R.playerReducer(moved, { type: 'REPLACE_SONG', fromId: 'ai-7', song: accepted });
  assert.equal(inHistory.history[0].id, 99);
  assert.equal(inHistory.currentSong, moved.currentSong);
  assert.equal(R.playerReducer(s, { type: 'REPLACE_SONG', fromId: 'ai-7' }), s, 'sin canción no hace nada');
});
