import { useEffect, useState } from 'react';
import { createPortal } from 'react-dom';
import { Plus, SkipForward, Scissors, RefreshCw, ListMusic, X, Trash2, ChevronRight } from 'lucide-react';

const MENU_WIDTH = 200;
const MENU_HEIGHT = 240;
const MARGIN = 8;

// Coloca el menú junto al punto de toque, volteándolo si se saldría de la pantalla.
function placeMenu(x, y) {
  const vw = window.innerWidth;
  const vh = window.innerHeight;
  let left = x;
  let top = y + 4;
  if (left + MENU_WIDTH + MARGIN > vw) left = x - MENU_WIDTH;
  if (top + MENU_HEIGHT + MARGIN > vh) top = y - MENU_HEIGHT - 4;
  return { left: Math.max(MARGIN, left), top: Math.max(MARGIN, top) };
}

// Menú contextual de una canción: cola, recortar, sustituir, playlists, borrar.
// Se cierra con un clic fuera, Escape, scroll o al elegir una opción.
export default function ContextMenu({ menu, playlists, activePlaylist, onClose, actions }) {
  const [showPlaylists, setShowPlaylists] = useState(false);

  useEffect(() => {
    const close = () => onClose();
    const onKey = (e) => { if (e.key === 'Escape') onClose(); };
    window.addEventListener('click', close);
    window.addEventListener('keydown', onKey);
    window.addEventListener('resize', close);
    return () => {
      window.removeEventListener('click', close);
      window.removeEventListener('keydown', onKey);
      window.removeEventListener('resize', close);
    };
  }, [onClose]);

  const { song } = menu;
  const { left, top } = placeMenu(menu.x, menu.y);
  const others = playlists.filter(p => p.id !== activePlaylist?.id);
  const run = (fn) => () => { onClose(); fn(song); };

  return createPortal(
    <div role="menu" aria-label={`Acciones para ${song.title}`} className="context-menu" style={{ left, top, minWidth: `${MENU_WIDTH}px` }}
      onClick={e => e.stopPropagation()}>
      <button role="menuitem" className="context-item" onClick={run(actions.enqueue)}><Plus size={16} /> Añadir a la cola</button>
      <button role="menuitem" className="context-item" onClick={run(actions.playNext)}><SkipForward size={16} /> Reproducir siguiente</button>
      <button role="menuitem" className="context-item" onClick={run(actions.trim)}><Scissors size={16} /> Recortar / Editar</button>
      <button role="menuitem" className="context-item" onClick={run(actions.replace)}><RefreshCw size={16} /> Sustituir</button>
      <div className="context-item-wrap" onMouseEnter={() => setShowPlaylists(true)} onMouseLeave={() => setShowPlaylists(false)}>
        <button role="menuitem" aria-haspopup="true" aria-expanded={showPlaylists} className="context-item" onClick={() => setShowPlaylists(v => !v)}>
          <ListMusic size={16} /> Añadir a Playlist... <ChevronRight size={14} style={{ marginLeft: 'auto', opacity: 0.6 }} />
        </button>
        {showPlaylists && (
          <div role="menu" className="context-submenu">
            <div className="context-submenu-title">PLAYLISTS</div>
            {others.length === 0 && <div style={{ padding: '10px 16px', color: '#666' }}>No hay otras playlists</div>}
            {others.map(p => (
              <button key={p.id} role="menuitem" className="context-item context-subitem" onClick={() => { onClose(); actions.addToPlaylist(p, song); }}>
                {p.name}
              </button>
            ))}
          </div>
        )}
      </div>
      {activePlaylist && (
        <button role="menuitem" className="context-item" style={{ color: '#ffaa00' }} onClick={run(actions.removeFromPlaylist)}>
          <X size={16} /> Quitar de Playlist
        </button>
      )}
      <div style={{ borderTop: '1px solid #444', margin: '4px 0' }} />
      <button role="menuitem" className="context-item" style={{ color: '#ff5555' }} onClick={run(actions.remove)}>
        <Trash2 size={16} /> Eliminar de Biblioteca
      </button>
    </div>,
    document.body
  );
}
