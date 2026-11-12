import { memo, useCallback, useEffect, useMemo, useRef } from 'react';
import { usePlaybackTime } from '../../hooks/usePlaybackTime.js';
import { findActiveCue } from '../../hooks/useSubtitles.js';
import { formatVerses } from '../../lib/format.js';

const EMPTY_MESSAGES = {
  loading: '♪ Cargando letras...',
  queued: '♪ Generando la letra… aparecerá sola en cuanto esté',
  error: '♪ No se pudo cargar la letra, reintentando...',
  not_found: '♪ No hay letras disponibles aún...',
};

// Letras sincronizadas a pantalla completa (WebVTT). Se suscribe al tiempo de
// reproducción pero solo se re-renderiza cuando cambia la línea activa.
function LyricsView({ song, cues, status, timeStore, onSeek }) {
  const activeRef = useRef(null);
  const containerRef = useRef(null);

  const selector = useCallback((snap) => {
    const t = snap.currentTime;
    const active = findActiveCue(cues, t);
    let passed = 0;
    while (passed < cues.length && cues[passed].end < t) passed += 1;
    return `${active}|${passed}`;
  }, [cues]);
  const key = usePlaybackTime(timeStore, selector);
  const [activeIndex, passedCount] = key.split('|').map(Number);

  const verses = useMemo(() => cues.map(c => formatVerses(c.text)), [cues]);

  useEffect(() => {
    const el = activeRef.current;
    const container = containerRef.current;
    if (!el || !container) return;
    const targetTop = el.offsetTop - container.clientHeight / 2 + el.clientHeight / 2;
    container.scrollTo({ top: Math.max(0, targetTop), behavior: 'smooth' });
  }, [activeIndex]);

  const background = song?.cover_url
    ? `url("${String(song.cover_url).replace(/"/g, '%22')}") center/cover no-repeat`
    : 'linear-gradient(135deg, #1a1a2e 0%, #16213e 50%, #0f3460 100%)';

  return (
    <section className="lyrics-view" aria-label="Letras">
      <div className="lyrics-bg" style={{ background }} />
      <div className="lyrics-shade" />
      <div ref={containerRef} className="lyrics-scroll">
        {song && (
          <div className="lyrics-header">
            {song.cover_url && <img src={song.cover_url} alt="" style={{ width: '56px', height: '56px', borderRadius: '6px', objectFit: 'cover', boxShadow: '0 4px 12px rgba(0,0,0,0.4)' }} />}
            <div style={{ minWidth: 0 }}>
              <div className="lyrics-title">{song.title}</div>
              <div className="lyrics-artist">{song.artist}</div>
            </div>
          </div>
        )}
        {status !== 'ready' || cues.length === 0 ? (
          <div className="lyrics-empty">
            {EMPTY_MESSAGES[status] || EMPTY_MESSAGES.not_found}
          </div>
        ) : (
          <div style={{ display: 'flex', flexDirection: 'column', gap: '28px', maxWidth: '680px' }} aria-live="off">
            {cues.map((cue, i) => {
              const isActive = activeIndex === i;
              const isPassed = !isActive && i < passedCount;
              return (
                <div key={`${i}-${cue.start}`} ref={isActive ? activeRef : null}
                  className={`lyrics-line${isActive ? ' active' : ''}${isPassed ? ' passed' : ''}`}
                  role="button" tabIndex={0}
                  onClick={() => onSeek(cue.start)}
                  onKeyDown={(e) => { if (e.key === 'Enter') onSeek(cue.start); }}>
                  {verses[i]}
                </div>
              );
            })}
          </div>
        )}
      </div>
    </section>
  );
}

export default memo(LyricsView);
