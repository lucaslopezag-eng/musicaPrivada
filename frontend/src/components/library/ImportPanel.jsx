import { useState } from 'react';
import PlaylistSelect from './PlaylistSelect.jsx';

// Importación: URL de Spotify (sin navegador en el servidor desde la Fase 2),
// lista "Canción - Artista", lista numerada o JSON.
export default function ImportPanel({ playlists, defaultPlaylist, playlistId, onPlaylistChange, onImport, showLogs, logs }) {
  const [text, setText] = useState('');
  const [busy, setBusy] = useState(false);

  const submit = async (e) => {
    e.preventDefault();
    if (!text.trim() || busy) return;
    setBusy(true);
    const ok = await onImport(text, playlistId);
    setBusy(false);
    if (ok) setText('');
  };

  return (
    <div style={{ marginTop: '40px', background: 'var(--bg-highlight)', padding: '16px', borderRadius: '8px' }}>
      <h3 style={{ margin: '0 0 4px 0' }}>Importar Canciones</h3>
      <p style={{ margin: '0 0 12px 0', fontSize: '12px', color: 'var(--text-secondary)', lineHeight: '1.5' }}>
        URL de Spotify, lista Canción - Artista, lista numerada o JSON.
      </p>
      <form onSubmit={submit} style={{ display: 'flex', flexDirection: 'column', gap: '8px' }}>
        <textarea value={text} onChange={e => setText(e.target.value)} aria-label="Canciones a importar"
          placeholder={'https://open.spotify.com/playlist/...\n\n— o —\n\nCanción - Artista'}
          style={{ flex: 1, padding: '12px', borderRadius: '4px', border: 'none', background: '#333', color: '#fff', minHeight: '80px', resize: 'vertical', fontFamily: 'inherit', fontSize: '13px' }} />
        <div style={{ display: 'flex', gap: '8px', alignItems: 'center' }}>
          <PlaylistSelect playlists={playlists} defaultName={defaultPlaylist} value={playlistId} onChange={onPlaylistChange}
            style={{ flex: 1, padding: '12px', borderRadius: '4px' }} />
          <button type="submit" disabled={busy} className="btn-primary" style={{ padding: '12px 24px' }}>
            {busy ? '...' : 'Importar'}
          </button>
        </div>
      </form>
      {showLogs && (
        <div style={{ marginTop: '12px', background: '#1a1a1a', border: '1px solid #333', padding: '12px', borderRadius: '8px' }}>
          <pre style={{ fontSize: '11px', color: '#aaa', overflowY: 'auto', maxHeight: '120px', whiteSpace: 'pre-wrap', margin: 0 }}>{logs || 'No logs.'}</pre>
        </div>
      )}
    </div>
  );
}
