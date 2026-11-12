import { memo } from 'react';

const TRANSPARENT_GIF = 'data:image/gif;base64,R0lGODlhAQABAIAAAAAAAP///yH5BAEAAAAALAAAAAABAAEAAAIBRAA7';

// Carátula con hueco gris si no hay imagen o falla la carga.
function Cover({ src, size = 40, radius = 4, className, style, alt = '' }) {
  const box = { width: `${size}px`, height: `${size}px`, borderRadius: `${radius}px`, flexShrink: 0, ...style };
  if (!src) return <div className={className} style={{ ...box, background: '#333' }} />;
  return (
    <img src={src} alt={alt} loading="lazy" decoding="async" className={className}
      onError={(e) => { e.currentTarget.onerror = null; e.currentTarget.src = TRANSPARENT_GIF; e.currentTarget.style.background = '#333'; }}
      style={{ ...box, objectFit: 'cover' }} />
  );
}

export default memo(Cover);
