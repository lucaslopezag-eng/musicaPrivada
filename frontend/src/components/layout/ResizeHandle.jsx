import { useState } from 'react';

// Asa de redimensionado con pointer events (barras laterales y reproductor).
// axis 'x' usa clientX, 'y' clientY; invert para los paneles anclados al
// lado contrario (la cola a la derecha, el reproductor abajo).
export default function ResizeHandle({ value, min, max, onChange, onEnd, axis = 'x', invert = false, className = 'sidebar-resize-handle', style }) {
  const [active, setActive] = useState(false);
  const onPointerDown = (e) => {
    e.preventDefault();
    e.currentTarget.setPointerCapture?.(e.pointerId);
    setActive(true);
    const start = axis === 'x' ? e.clientX : e.clientY;
    const startValue = value;
    const limit = typeof max === 'function' ? max() : max;
    let last = startValue;
    const onMove = (ev) => {
      const delta = (axis === 'x' ? ev.clientX : ev.clientY) - start;
      last = Math.max(min, Math.min(limit, startValue + (invert ? -delta : delta)));
      onChange(last);
    };
    const onUp = () => {
      setActive(false);
      window.removeEventListener('pointermove', onMove);
      window.removeEventListener('pointerup', onUp);
      window.removeEventListener('pointercancel', onUp);
      onEnd?.(last);
    };
    window.addEventListener('pointermove', onMove);
    window.addEventListener('pointerup', onUp);
    window.addEventListener('pointercancel', onUp);
  };
  return (
    <div className={`${className}${active ? ' active' : ''}`} style={style} onPointerDown={onPointerDown}
      role="separator" aria-orientation={axis === 'x' ? 'vertical' : 'horizontal'} aria-valuenow={Math.round(value)} aria-valuemin={min} />
  );
}
