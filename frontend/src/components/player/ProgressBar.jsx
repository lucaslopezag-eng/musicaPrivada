import { useRef, useState } from 'react';
import { usePlaybackTime } from '../../hooks/usePlaybackTime.js';
import { formatSeconds } from '../../lib/format.js';

const fraction = (e, el) => {
  const r = el.getBoundingClientRect();
  return Math.max(0, Math.min(1, (e.clientX - r.left) / r.width));
};

// Barra de progreso interactiva. Se suscribe por su cuenta al tiempo de
// reproducción: el resto de la app no se re-renderiza en cada timeupdate.
export default function ProgressBar({ timeStore, onSeek }) {
  const { currentTime, duration } = usePlaybackTime(timeStore);
  const [dragFraction, setDragFraction] = useState(null);
  const dragging = useRef(false);
  const hasDuration = duration > 0 && Number.isFinite(duration);
  const shown = dragFraction !== null ? dragFraction : (hasDuration ? currentTime / duration : 0);
  const shownTime = dragFraction !== null && hasDuration ? dragFraction * duration : currentTime;

  return (
    <div className="player-progress" style={{ width: '100%', maxWidth: '600px', display: 'flex', alignItems: 'center', gap: '8px' }}>
      <span style={{ fontSize: '12px', color: 'var(--text-secondary)', width: '40px', textAlign: 'right' }}>{formatSeconds(shownTime)}</span>
      <div className="progress-bar-container" style={{ touchAction: 'none' }}
        role="slider" tabIndex={0} aria-label="Posición" aria-valuemin={0} aria-valuemax={Math.round(duration || 0)}
        aria-valuenow={Math.round(currentTime || 0)} aria-valuetext={`${formatSeconds(currentTime)} de ${formatSeconds(duration)}`}
        onKeyDown={(e) => {
          if (!hasDuration) return;
          if (e.key === 'ArrowLeft') { e.preventDefault(); e.stopPropagation(); onSeek(Math.max(0, currentTime - 5)); }
          if (e.key === 'ArrowRight') { e.preventDefault(); e.stopPropagation(); onSeek(Math.min(duration, currentTime + 5)); }
        }}
        onPointerDown={(e) => {
          if (!hasDuration) return;
          e.currentTarget.setPointerCapture(e.pointerId);
          dragging.current = true;
          setDragFraction(fraction(e, e.currentTarget));
        }}
        onPointerMove={(e) => {
          if (!dragging.current) return;
          setDragFraction(fraction(e, e.currentTarget));
        }}
        onPointerUp={(e) => {
          if (!dragging.current) return;
          dragging.current = false;
          e.currentTarget.releasePointerCapture(e.pointerId);
          const f = fraction(e, e.currentTarget);
          setDragFraction(null);
          if (hasDuration) onSeek(f * duration);
        }}
        onPointerCancel={() => { dragging.current = false; setDragFraction(null); }}
      >
        <div className="progress-bar-track">
          <div className="progress-bar-fill" style={{ width: `${shown * 100}%` }}>
            <div className="progress-bar-thumb" />
          </div>
        </div>
      </div>
      <span style={{ fontSize: '12px', color: 'var(--text-secondary)', width: '40px' }}>{formatSeconds(duration)}</span>
    </div>
  );
}
