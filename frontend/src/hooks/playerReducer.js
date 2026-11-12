// ─── MÁQUINA DE ESTADOS DEL REPRODUCTOR (FASE 2) ─────────────────────────────
// Reducer PURO (sin React, sin DOM, sin aleatoriedad propia: los barajados y
// los saltos aleatorios llegan en la acción) con todas las reglas de la cola:
//   cola explícita → recomendación IA (cada 2–4 canciones en modo IA)
//   → "a continuación" (autoQueue) → rebarajado / siguiente / repetir.
// Antes estas reglas vivían en handleNext/handlePrev/playSong repartidas entre
// ~15 useState y refs sincronizados a mano: casi todos los cierres obsoletos
// detectados en la auditoría venían de ahí. usePlayer.js mantiene una copia
// síncrona del estado (stateRef) aplicando este mismo reducer, de modo que dos
// pulsaciones seguidas de "siguiente" nunca leen un estado viejo.
//
// Campos de "señal" para efectos imperativos (los aplica usePlayer):
//   loadSeq   → hay que cargar state.currentSong en el <audio>.
//   restartSeq→ repetir-una: volver a 0 y reproducir.
//   seek      → { time, seq }: mover la posición.

export const SHUFFLE_MODES = ['normal', 'shuffle', 'ai'];
export const REPEAT_MODES = ['off', 'all', 'one'];
export const HISTORY_LIMIT = 50;

export const ActionTypes = Object.freeze({
  SET_TRACK: 'SET_TRACK',
  PLAY: 'PLAY',
  PAUSE: 'PAUSE',
  AUDIO_STATE: 'AUDIO_STATE',
  NEXT_TRACK: 'NEXT_TRACK',
  PREV_TRACK: 'PREV_TRACK',
  SEEK_TO: 'SEEK_TO',
  SET_VOLUME: 'SET_VOLUME',
  TOGGLE_MUTE: 'TOGGLE_MUTE',
  SET_QUEUE: 'SET_QUEUE',
  ENQUEUE: 'ENQUEUE',
  ENQUEUE_NEXT: 'ENQUEUE_NEXT',
  REMOVE_FROM_QUEUE: 'REMOVE_FROM_QUEUE',
  MOVE_IN_QUEUE: 'MOVE_IN_QUEUE',
  TOGGLE_SHUFFLE: 'TOGGLE_SHUFFLE',
  SET_SHUFFLE_MODE: 'SET_SHUFFLE_MODE',
  CYCLE_REPEAT: 'CYCLE_REPEAT',
  SET_AI_QUEUE: 'SET_AI_QUEUE',
  CLEAR_AI_REC: 'CLEAR_AI_REC',
  REBUILD_AUTO_QUEUE: 'REBUILD_AUTO_QUEUE',
  UPDATE_SONG: 'UPDATE_SONG',
  REMOVE_SONG: 'REMOVE_SONG',
  RESET: 'RESET',
});

const T = ActionTypes;

export function createInitialPlayerState({
  currentSong = null, shuffleMode = 'normal', repeatMode = 'off', volume = 1, songsUntilRec = 2,
} = {}) {
  return {
    currentSong,
    isPlaying: false,        // intención del usuario ("debería estar sonando")
    queue: [],               // cola explícita ("Siguiente en la cola")
    autoQueue: [],           // "A continuación"
    history: [],             // más reciente primero
    aiQueue: [],             // recomendaciones IA descargadas
    currentAiRec: null,      // recomendación que suena ahora
    shuffleMode: SHUFFLE_MODES.includes(shuffleMode) ? shuffleMode : 'normal',
    repeatMode: REPEAT_MODES.includes(repeatMode) ? repeatMode : 'off',
    volume: clampVolume(volume),
    muted: false,
    songsUntilRec,
    loadSeq: 0,
    restartSeq: 0,
    seek: { time: 0, seq: 0 },
  };
}

function clampVolume(v) {
  const n = Number(v);
  return Number.isFinite(n) ? Math.min(1, Math.max(0, n)) : 1;
}

const sameId = (a, b) => a != null && b != null && a.id === b.id;
const isRandomMode = (mode) => mode === 'shuffle' || mode === 'ai';

// "A continuación" a partir de una canción. null = no cambiar (canción fuera de la lista).
export function buildAutoQueue(mode, songs, song, shuffledSongs) {
  if (!song) return null;
  if (isRandomMode(mode)) {
    return (shuffledSongs || songs).filter(s => s.id !== song.id);
  }
  const idx = songs.findIndex(s => s.id === song.id);
  return idx >= 0 ? songs.slice(idx + 1) : null;
}

function withHistory(state) {
  if (!state.currentSong) return state.history;
  return [state.currentSong, ...state.history].slice(0, HISTORY_LIMIT);
}

// Carga `song` como pista actual (señal loadSeq) y apunta la anterior al historial.
function loadTrack(state, song, { fromHistory = false, aiRec = null } = {}) {
  return {
    ...state,
    history: fromHistory ? state.history : withHistory(state),
    currentSong: song,
    currentAiRec: aiRec,
    isPlaying: true,
    loadSeq: state.loadSeq + 1,
  };
}

function nextTrack(state, action) {
  const natural = action.natural === true;
  const songs = action.songs || [];
  // Repetir-una solo aplica al final natural (el botón "siguiente" sí avanza).
  if (state.repeatMode === 'one' && natural && state.currentSong) {
    return { ...state, isPlaying: true, restartSeq: state.restartSeq + 1 };
  }
  let s = { ...state, currentAiRec: null };

  if (s.queue.length > 0) {
    const [next, ...rest] = s.queue;
    return loadTrack({ ...s, queue: rest }, next);
  }

  if (s.autoQueue.length > 0) {
    if (s.shuffleMode === 'ai' && s.aiQueue.length > 0) {
      const left = s.songsUntilRec - 1;
      if (left <= 0) {
        const [rec, ...restRecs] = s.aiQueue;
        return loadTrack({ ...s, aiQueue: restRecs, songsUntilRec: action.aiGap ?? 3 }, rec, { aiRec: rec });
      }
      s = { ...s, songsUntilRec: left };
    }
    const [next, ...rest] = s.autoQueue;
    return loadTrack({ ...s, autoQueue: rest }, next);
  }

  // Sin "a continuación": en aleatorio se rebaraja (si repetir-todo o salto manual).
  if (isRandomMode(s.shuffleMode)) {
    const pool = action.shuffled && action.shuffled.length ? action.shuffled : songs;
    if (pool.length > 0 && (s.repeatMode === 'all' || !natural)) {
      const [next, ...rest] = pool;
      const songsUntilRec = s.shuffleMode === 'ai' ? (action.aiGapAfterReshuffle ?? 1) : s.songsUntilRec;
      return loadTrack({ ...s, autoQueue: rest, songsUntilRec }, next);
    }
    return natural ? { ...s, isPlaying: false } : s;
  }

  // Orden normal.
  const idx = songs.findIndex(x => sameId(x, s.currentSong));
  if (idx >= 0 && idx < songs.length - 1) return loadTrack(s, songs[idx + 1]);
  if (songs.length > 0 && (s.repeatMode === 'all' || !natural)) return loadTrack(s, songs[0]);
  return natural ? { ...s, isPlaying: false } : s;
}

function prevTrack(state, action) {
  const songs = action.songs || [];
  // Volver atrás NO cuenta como rechazo de una recomendación IA.
  const s = { ...state, currentAiRec: null };
  if (s.history.length > 0) {
    const [last, ...rest] = s.history;
    return loadTrack({ ...s, history: rest }, last, { fromHistory: true });
  }
  if (!s.currentSong || songs.length === 0) return s;
  if ((action.currentTime || 0) > 3) return { ...s, seek: { time: 0, seq: s.seek.seq + 1 } };
  const idx = songs.findIndex(x => sameId(x, s.currentSong));
  return loadTrack(s, idx > 0 ? songs[idx - 1] : songs[songs.length - 1]);
}

function setShuffleMode(state, mode, action) {
  const songs = action.songs || [];
  let autoQueue = state.autoQueue;
  if (isRandomMode(mode)) {
    autoQueue = (action.shuffled || songs).filter(x => !sameId(x, state.currentSong));
  } else {
    const idx = songs.findIndex(x => sameId(x, state.currentSong));
    autoQueue = idx !== -1 ? songs.slice(idx + 1) : songs;
  }
  return { ...state, shuffleMode: mode, autoQueue };
}

export function playerReducer(state, action) {
  switch (action.type) {
    case T.SET_TRACK: {
      if (!action.song) return state;
      let s = state;
      if (Number.isInteger(action.fromQueueIndex)) {
        s = { ...s, queue: s.queue.filter((_, i) => i !== action.fromQueueIndex) };
      }
      s = loadTrack(s, action.song);
      const auto = buildAutoQueue(s.shuffleMode, action.songs || [], action.song, action.shuffled);
      return auto ? { ...s, autoQueue: auto } : s;
    }
    case T.PLAY:
      return state.currentSong ? { ...state, isPlaying: true } : state;
    case T.PAUSE:
      return state.isPlaying ? { ...state, isPlaying: false } : state;
    case T.AUDIO_STATE:
      return state.isPlaying === Boolean(action.playing) ? state : { ...state, isPlaying: Boolean(action.playing) };
    case T.NEXT_TRACK:
      return nextTrack(state, action);
    case T.PREV_TRACK:
      return prevTrack(state, action);
    case T.SEEK_TO: {
      const time = Number(action.time);
      if (!Number.isFinite(time) || time < 0) return state;
      return { ...state, seek: { time, seq: state.seek.seq + 1 } };
    }
    case T.SET_VOLUME: {
      const volume = clampVolume(action.volume);
      return { ...state, volume, muted: volume === 0 ? state.muted : false };
    }
    case T.TOGGLE_MUTE:
      return { ...state, muted: !state.muted };
    case T.SET_QUEUE:
      return { ...state, queue: Array.isArray(action.queue) ? action.queue : [] };
    case T.ENQUEUE:
      return action.song ? { ...state, queue: [...state.queue, action.song] } : state;
    case T.ENQUEUE_NEXT:
      return action.song ? { ...state, queue: [action.song, ...state.queue] } : state;
    case T.REMOVE_FROM_QUEUE:
      return { ...state, queue: state.queue.filter((_, i) => i !== action.index) };
    case T.MOVE_IN_QUEUE: {
      const { from, to } = action;
      if (from === to || from < 0 || to < 0 || from >= state.queue.length || to >= state.queue.length) return state;
      const queue = [...state.queue];
      const [moved] = queue.splice(from, 1);
      queue.splice(to, 0, moved);
      return { ...state, queue };
    }
    case T.TOGGLE_SHUFFLE:
      return setShuffleMode(state, state.shuffleMode === 'normal' ? 'shuffle' : 'normal', action);
    case T.SET_SHUFFLE_MODE:
      return SHUFFLE_MODES.includes(action.mode) ? setShuffleMode(state, action.mode, action) : state;
    case T.CYCLE_REPEAT: {
      const i = REPEAT_MODES.indexOf(state.repeatMode);
      return { ...state, repeatMode: REPEAT_MODES[(i + 1) % REPEAT_MODES.length] };
    }
    case T.SET_AI_QUEUE: {
      const recs = Array.isArray(action.recs) ? action.recs : [];
      const playing = state.currentAiRec;
      // La que está sonando sigue "downloaded" en el servidor: no re-encolarla.
      return { ...state, aiQueue: playing ? recs.filter(r => r.rec_id !== playing.rec_id) : recs };
    }
    case T.CLEAR_AI_REC:
      return state.currentAiRec ? { ...state, currentAiRec: null } : state;
    case T.REBUILD_AUTO_QUEUE: {
      if (state.queue.length > 0 || state.autoQueue.length > 0 || !state.currentSong) return state;
      const auto = buildAutoQueue(state.shuffleMode, action.songs || [], state.currentSong, action.shuffled);
      return auto ? { ...state, autoQueue: auto } : state;
    }
    case T.UPDATE_SONG: {
      if (!action.song) return state;
      const patch = (x) => (sameId(x, action.song) ? { ...x, ...action.song } : x);
      return {
        ...state,
        currentSong: sameId(state.currentSong, action.song) ? { ...state.currentSong, ...action.song } : state.currentSong,
        queue: state.queue.map(patch),
        autoQueue: state.autoQueue.map(patch),
      };
    }
    case T.REMOVE_SONG: {
      const keep = (x) => x.id !== action.id;
      const removingCurrent = state.currentSong && state.currentSong.id === action.id;
      return {
        ...state,
        queue: state.queue.filter(keep),
        autoQueue: state.autoQueue.filter(keep),
        history: state.history.filter(keep),
        ...(removingCurrent ? { currentSong: null, isPlaying: false, loadSeq: state.loadSeq + 1 } : {}),
      };
    }
    case T.RESET:
      return {
        ...createInitialPlayerState({
          shuffleMode: state.shuffleMode, repeatMode: state.repeatMode, volume: state.volume, songsUntilRec: state.songsUntilRec,
        }),
        loadSeq: state.loadSeq + 1,
        restartSeq: state.restartSeq,
        seek: state.seek,
      };
    default:
      return state;
  }
}

// Lo que sonaría a continuación SIN avanzar (para precargar la siguiente pista).
export function peekNext(state, songs = []) {
  if (state.queue.length > 0) return state.queue[0];
  if (state.autoQueue.length > 0) {
    if (state.shuffleMode === 'ai' && state.aiQueue.length > 0 && state.songsUntilRec - 1 <= 0) return state.aiQueue[0];
    return state.autoQueue[0];
  }
  if (isRandomMode(state.shuffleMode)) return null; // rebarajado: impredecible
  if (state.repeatMode === 'one' || !state.currentSong || songs.length === 0) return null;
  const idx = songs.findIndex(x => sameId(x, state.currentSong));
  if (idx >= 0 && idx < songs.length - 1) return songs[idx + 1];
  return state.repeatMode === 'all' ? songs[0] : null;
}

// Qué informar al servidor sobre la recomendación IA que deja de sonar.
// · siguiente (manual) o elegir otra canción → "skip" (archivada, recuperable)
// · terminó de forma natural → "played"
// · volver atrás / aceptar / rechazar → nada (se gestionan aparte)
export function aiReportFor(prev, next, action) {
  const rec = prev.currentAiRec;
  if (!rec) return null;
  if (next.currentAiRec && next.currentAiRec.rec_id === rec.rec_id) return null;
  if (action.type === T.NEXT_TRACK) {
    if (action.skipAiReport) return null;
    return { recId: rec.rec_id, kind: action.natural === true ? 'played' : 'skip' };
  }
  if (action.type === T.SET_TRACK) return { recId: rec.rec_id, kind: 'skip' };
  return null;
}
