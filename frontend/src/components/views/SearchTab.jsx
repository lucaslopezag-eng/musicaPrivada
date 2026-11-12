import { useMemo, useState } from 'react';
import { Search, Plus } from 'lucide-react';
import PlaylistSelect from '../library/PlaylistSelect.jsx';
import Cover from '../common/Cover.jsx';

// Búsqueda: filtro instantáneo de la biblioteca + búsqueda en YouTube para
// descargar (o sustituir una canción existente).
export default function SearchTab({ apiFetch, addToast, librarySongs, playlists, defaultPlaylist, importPlaylistId, onImportPlaylistChange, songToReplace, onCancelReplace, onReplaceQueued, onPlaySong }) {
  const [query, setQuery] = useState('');
  const [results, setResults] = useState([]);
  const [searching, setSearching] = useState(false);
  const [downloading, setDownloading] = useState({});

  const localMatches = useMemo(() => {
    const q = query.trim().toLowerCase();
    if (q.length < 2) return [];
    return librarySongs.filter(s => s.title?.toLowerCase().includes(q) || s.artist?.toLowerCase().includes(q)).slice(0, 8);
  }, [librarySongs, query]);

  const search = async (e) => {
    e.preventDefault();
    if (!query.trim()) return;
    setSearching(true);
    try {
      const r = await apiFetch(`/search?q=${encodeURIComponent(query)}`);
      if (r.ok) setResults(await r.json());
      else addToast('La búsqueda ha fallado', 'error');
    } catch {
      addToast('Search failed', 'error');
    } finally {
      setSearching(false);
    }
  };

  const download = async (song) => {
    if (downloading[song.url]) return;
    setDownloading(p => ({ ...p, [song.url]: true }));
    addToast(`Download started: ${song.title}`, 'info');
    try {
      const payload = { ...song };
      if (songToReplace) payload.replaceId = songToReplace.id;
      if (importPlaylistId) payload.playlistId = importPlaylistId;
      const r = await apiFetch('/download-single', { method: 'POST', body: JSON.stringify(payload) });
      if (r.ok) {
        // La sincronización por versión de la biblioteca recoge la canción al terminar.
        addToast(songToReplace ? 'Sustitución en cola — la canción original se conserva hasta que termine' : 'Descarga iniciada — aparecerá en breve', 'success');
        if (songToReplace) onReplaceQueued();
      } else {
        const d = await r.json().catch(() => ({}));
        addToast(d.error || 'No se pudo iniciar la descarga', 'error');
      }
    } catch {
      addToast('Error downloading', 'error');
    } finally {
      setDownloading(p => { const n = { ...p }; delete n[song.url]; return n; });
    }
  };

  return (
    <div style={{ padding: '8px 0' }}>
      <h2 style={{ fontSize: '32px', fontWeight: '800', marginBottom: '24px' }}>Búsqueda Online</h2>

      {songToReplace && (
        <div className="replace-banner">
          <div style={{ fontSize: '14px' }}>
            <strong style={{ color: '#ff4444' }}>Modo Sustitución:</strong> Vas a reemplazar <em>{songToReplace.title}</em>
          </div>
          <button onClick={onCancelReplace} style={{ color: '#fff', textDecoration: 'underline', fontSize: '14px' }}>Cancelar</button>
        </div>
      )}

      <form onSubmit={search} className="search-bar" style={{ marginBottom: '24px', flexWrap: 'wrap' }} role="search">
        <Search size={16} color="var(--text-secondary)" />
        <input type="text" placeholder="Buscar en Youtube..." aria-label="Buscar en YouTube" value={query} onChange={e => setQuery(e.target.value)} style={{ minWidth: '150px' }} />
        <PlaylistSelect playlists={playlists} defaultName={defaultPlaylist} value={importPlaylistId} onChange={onImportPlaylistChange}
          style={{ padding: '8px', borderRadius: '16px', marginLeft: '8px' }} />
        <button type="submit" disabled={searching} className="btn-primary" style={{ padding: '8px 16px', borderRadius: '16px', marginLeft: '8px' }}>
          {searching ? 'Buscando...' : 'Buscar'}
        </button>
      </form>

      {!songToReplace && localMatches.length > 0 && (
        <div style={{ marginBottom: '24px' }}>
          <div className="queue-section-title" style={{ color: 'var(--text-secondary)', marginBottom: '8px' }}>En tu biblioteca</div>
          <div style={{ display: 'flex', flexDirection: 'column', gap: '4px' }}>
            {localMatches.map(song => (
              <button key={song.id} type="button" className="song-row" onClick={() => onPlaySong(song)} style={{ width: '100%', textAlign: 'left', gap: '12px' }}>
                <Cover src={song.cover_url} size={36} />
                <div style={{ flex: 1, minWidth: 0 }}>
                  <div className="song-row-title">{song.title}</div>
                  <div className="song-row-artist">{song.artist}</div>
                </div>
              </button>
            ))}
          </div>
        </div>
      )}

      <div style={{ display: 'flex', flexDirection: 'column', gap: '8px' }}>
        {results.map((song, i) => (
          <div key={song.id || song.url || i} className="song-row" style={{ display: 'flex', alignItems: 'center', padding: '8px', background: 'var(--bg-highlight)', borderRadius: '8px' }}>
            <Cover src={song.coverUrl} size={48} alt={song.title} style={{ marginRight: '16px' }} />
            <div style={{ flex: 1, minWidth: 0 }}>
              <div style={{ fontWeight: 'bold', fontSize: '14px', whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' }}>{song.title}</div>
              <div style={{ color: 'var(--text-secondary)', fontSize: '12px' }}>{song.artist}</div>
            </div>
            <div style={{ marginRight: '16px', color: 'var(--text-secondary)', fontSize: '12px' }}>{song.duration}</div>
            <button onClick={() => download(song)} disabled={downloading[song.url]} className="download-btn"
              style={{ background: downloading[song.url] ? '#555' : 'transparent', color: downloading[song.url] ? '#aaa' : 'var(--accent-color)' }}>
              {downloading[song.url] ? 'Descargando...' : <><Plus size={16} /> Añadir</>}
            </button>
          </div>
        ))}
      </div>
    </div>
  );
}
