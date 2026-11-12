import { useEffect } from 'react';
import { Sparkles } from 'lucide-react';

const MODES = [
  { id: 'normal', label: 'Orden Normal' },
  { id: 'shuffle', label: 'Orden Aleatorio' },
  { id: 'ai', label: 'Modo IA' },
];

// Menú de modo de reproducción (normal / aleatorio / IA).
export default function ShuffleMenu({ mode, aiCount, onSelect, onClose }) {
  useEffect(() => {
    const close = () => onClose();
    const onKey = (e) => { if (e.key === 'Escape') onClose(); };
    window.addEventListener('click', close);
    window.addEventListener('keydown', onKey);
    return () => { window.removeEventListener('click', close); window.removeEventListener('keydown', onKey); };
  }, [onClose]);

  return (
    <div role="menu" aria-label="Modo de reproducción" className="shuffle-menu" onClick={e => e.stopPropagation()}>
      {MODES.map(m => (
        <button key={m.id} role="menuitemradio" aria-checked={mode === m.id} className="shuffle-menu-item"
          style={{ color: mode === m.id ? 'var(--accent-color)' : '#fff' }}
          onClick={() => { onSelect(m.id); onClose(); }}>
          {m.id === 'ai' && <Sparkles size={13} />}
          {m.label}{m.id === 'ai' ? (aiCount > 0 ? ` (${aiCount} listos)` : ' (sin recoms)') : ''}
        </button>
      ))}
    </div>
  );
}
