import { useMemo, useState } from 'react';
import { Play, Search, X } from 'lucide-react';
import SongList from '../library/SongList.jsx';

// Vista de una playlist: cabecera, buscador instantáneo y lista virtualizada.
export default function PlaylistView({ playlist, songs, currentSongId, isPlaying, onBack, onPlaySong, onDelete, onMenu, onReorder }) {
  const [query, setQuery] = useState('');
  const filtered = useMemo(() => {
    const q = query.trim().toLowerCase();
    if (!q) return songs;
    return songs.filter(s => s.title?.toLowerCase().includes(q) || s.artist?.toLowerCase().includes(q));
  }, [songs, query]);
  const canReorder = !query.trim();

  return (
    <>
      <div style={{ display: 'flex', alignItems: 'center', gap: '16px', marginBottom: '24px', flexWrap: 'wrap' }}>
        <button onClick={onBack} aria-label="Volver" className="round-btn">&#8592;</button>
        <h1 style={{ margin: 0, fontSize: '28px', fontWeight: '800', flex: 1 }}>{playlist.name}</h1>
        <span style={{ fontSize: '13px', color: 'var(--text-secondary)' }}>{songs.length} canciones</span>
        <button onClick={() => { if (songs.length > 0) onPlaySong(songs[0]); }} className="btn-primary" style={{ borderRadius: '30px', padding: '10px 20px' }}>
          <Play size={16} fill="black" /> Reproducir
        </button>
        <button onClick={onDelete} style={{ background: 'transparent', border: '1px solid #ff5555', color: '#ff5555', padding: '8px 16px', borderRadius: '20px', cursor: 'pointer', fontSize: '13px' }}>Eliminar</button>
      </div>

      <div className="playlist-search-sticky">
      <div className="search-bar" style={{ marginBottom: 0 }}>
        <Search size={16} color="var(--text-secondary)" />
        <input type="text" placeholder="Buscar en la playlist..." aria-label="Buscar en la playlist" value={query} onChange={e => setQuery(e.target.value)} />
        {query && (
          <button onClick={() => setQuery('')} aria-label="Borrar búsqueda" style={{ color: 'var(--text-secondary)', flexShrink: 0 }}>
            <X size={14} />
          </button>
        )}
      </div>
      </div>

      <SongList songs={filtered} searchQuery={query} currentSongId={currentSongId} isPlaying={isPlaying}
        canReorder={canReorder} onPlay={onPlaySong} onMenu={onMenu} onReorder={onReorder} />
    </>
  );
}
