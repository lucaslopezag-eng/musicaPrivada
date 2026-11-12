import { Plus } from 'lucide-react';
import PlaylistGrid from '../library/PlaylistGrid.jsx';
import ImportPanel from '../library/ImportPanel.jsx';
import { getDynamicGreeting } from '../../lib/format.js';

// Inicio: saludo, cuadrícula de playlists e importación.
export default function HomeView({ playlists, defaultPlaylist, onOpenPlaylist, onCreatePlaylist, importPlaylistId, onImportPlaylistChange, onImport, showLogs, logs }) {
  return (
    <div>
      <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginBottom: '32px', gap: '12px', flexWrap: 'wrap' }}>
        <div>
          <h2 style={{ fontSize: '28px', fontWeight: '800', margin: 0 }}>{getDynamicGreeting()}</h2>
          <p style={{ margin: '4px 0 0', color: 'var(--text-secondary)', fontSize: '14px' }}>Elige una playlist para escuchar</p>
        </div>
        <button onClick={onCreatePlaylist} className="btn-primary" style={{ borderRadius: '30px', padding: '10px 20px', fontSize: '14px' }}>
          <Plus size={18} /> Nueva Playlist
        </button>
      </div>
      <PlaylistGrid playlists={playlists} onOpen={onOpenPlaylist} />
      <ImportPanel playlists={playlists} defaultPlaylist={defaultPlaylist} playlistId={importPlaylistId} onPlaylistChange={onImportPlaylistChange}
        onImport={onImport} showLogs={showLogs} logs={logs} />
    </div>
  );
}
