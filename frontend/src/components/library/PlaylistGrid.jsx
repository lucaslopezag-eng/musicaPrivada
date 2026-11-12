import { memo } from 'react';
import { ListMusic } from 'lucide-react';

// Cuadrícula de playlists del usuario.
function PlaylistGrid({ playlists, onOpen }) {
  return (
    <div className="playlist-grid">
      {playlists.length === 0 && (
        <div style={{ gridColumn: '1 / -1', padding: '40px', textAlign: 'center', color: 'var(--text-secondary)' }}>
          <ListMusic size={48} style={{ marginBottom: '16px', opacity: 0.3 }} />
          <p style={{ margin: 0 }}>Crea tu primera playlist con el botón de arriba</p>
        </div>
      )}
      {playlists.map(p => (
        <button key={p.id} type="button" className="playlist-card" onClick={() => onOpen(p)} aria-label={`Abrir playlist ${p.name}`}>
          <div className="playlist-card-cover">
            {p.cover_url
              ? <img src={p.cover_url} alt="" loading="lazy" style={{ width: '100%', height: '100%', objectFit: 'cover', borderRadius: '6px' }} />
              : <ListMusic size={44} color="var(--accent-color)" style={{ opacity: 0.6 }} />}
          </div>
          <div className="playlist-card-name">{p.name}</div>
          <div style={{ fontSize: '12px', color: 'var(--text-secondary)', marginTop: '4px' }}>Playlist</div>
        </button>
      ))}
    </div>
  );
}

export default memo(PlaylistGrid);
