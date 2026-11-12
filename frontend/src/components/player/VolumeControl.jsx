import { useRef, useState } from 'react';
import { Volume2, VolumeX } from 'lucide-react';

const fraction = (e, el) => {
  const r = el.getBoundingClientRect();
  return Math.max(0, Math.min(1, (e.clientX - r.left) / r.width));
};

export default function VolumeControl({ volume, muted, onChange, onToggleMute }) {
  const [dragging, setDragging] = useState(false);
  const draggingRef = useRef(false);
  const shown = muted ? 0 : volume;
  return (
    <>
      <button onClick={onToggleMute} aria-label={muted ? 'Activar sonido' : 'Silenciar (M)'} title={muted ? 'Activar sonido' : 'Silenciar (M)'} style={{ flexShrink: 0, display: 'flex' }}>
        {muted || volume === 0 ? <VolumeX size={20} /> : <Volume2 size={20} />}
      </button>
      <div className="volume-bar-container" style={{ touchAction: 'none' }}
        role="slider" tabIndex={0} aria-label="Volumen" aria-valuemin={0} aria-valuemax={100} aria-valuenow={Math.round(shown * 100)}
        onKeyDown={(e) => {
          if (e.key === 'ArrowLeft' || e.key === 'ArrowDown') { e.preventDefault(); e.stopPropagation(); onChange(volume - 0.05); }
          if (e.key === 'ArrowRight' || e.key === 'ArrowUp') { e.preventDefault(); e.stopPropagation(); onChange(volume + 0.05); }
        }}
        onPointerDown={(e) => { e.currentTarget.setPointerCapture(e.pointerId); draggingRef.current = true; setDragging(true); onChange(fraction(e, e.currentTarget)); }}
        onPointerMove={(e) => { if (draggingRef.current) onChange(fraction(e, e.currentTarget)); }}
        onPointerUp={(e) => { e.currentTarget.releasePointerCapture(e.pointerId); draggingRef.current = false; setDragging(false); }}
        onPointerCancel={() => { draggingRef.current = false; setDragging(false); }}
      >
        <div className="volume-bar-track"><div className="volume-bar-fill" style={{ width: `${shown * 100}%` }} /></div>
        <div className="volume-bar-thumb" style={{ left: `${shown * 100}%`, opacity: dragging ? 1 : undefined }} />
      </div>
    </>
  );
}
