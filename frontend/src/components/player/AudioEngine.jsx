// Elementos <audio> persistentes (AUDIO-01). Se montan SIEMPRE, también en la
// pantalla de login y en la misma posición del árbol, para que el keep-alive,
// el watchdog y la recuperación de "stalled" (enlazados una sola vez) nunca
// encuentren el elemento a null.
export default function AudioEngine({ audioRef, nextAudioRef, handlers }) {
  return (
    <>
      {/* Precarga silenciosa de la siguiente pista (reproducción sin huecos). */}
      <audio ref={nextAudioRef} preload="auto" style={{ display: 'none' }} />
      <audio
        ref={audioRef}
        preload="auto"
        onTimeUpdate={handlers.onTimeUpdate}
        onLoadedMetadata={handlers.onLoadedMetadata}
        onSeeked={handlers.onSeeked}
        onPlay={handlers.onPlay}
        onPause={handlers.onPause}
        onEnded={handlers.onEnded}
      />
    </>
  );
}
