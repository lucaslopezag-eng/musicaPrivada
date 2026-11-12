import { memo, useState } from 'react';
import { Library, Download, RefreshCw, FileText, LogOut, ListMusic } from 'lucide-react';
import ResizeHandle from './ResizeHandle.jsx';
import { NAV_ITEMS } from './navItems.js';

// Barra lateral (escritorio): navegación y "Tu Biblioteca".
function Sidebar({
  activeTab, onNavigate, playlists, activePlaylistId, songCount, currentUser, isAdmin, isCaching,
  onOpenPlaylist, onPrecache, onRefresh, onToggleLogs, onLogout,
}) {
  const [width, setWidth] = useState(300);
  return (
    <nav className="sidebar" style={{ width: `${width}px`, gridColumn: '1' }} aria-label="Navegación principal">
      <div className="sidebar-box" style={{ display: 'flex', flexDirection: 'column', gap: '8px' }}>
        {NAV_ITEMS.map(({ id, label, Icon }) => (
          <a key={id} href="#" className={`nav-item ${activeTab === id ? 'active' : ''}`} aria-current={activeTab === id ? 'page' : undefined}
            onClick={(e) => { e.preventDefault(); onNavigate(id); }}>
            <Icon size={22} /> {label}
          </a>
        ))}
      </div>
      <div className="sidebar-box" style={{ flex: 1, display: 'flex', flexDirection: 'column', gap: '12px', overflow: 'hidden' }}>
        <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', color: 'var(--text-secondary)', fontWeight: '700', padding: '4px 0' }}>
          <div style={{ display: 'flex', alignItems: 'center', gap: '8px', color: 'var(--text-primary)' }}><Library size={22} /> Tu Biblioteca</div>
          <div style={{ display: 'flex', gap: '4px' }}>
            <button onClick={onPrecache} className="sidebar-icon-btn" title={isCaching ? 'Detener descarga offline' : 'Descargar para offline'} aria-label={isCaching ? 'Detener descarga offline' : 'Descargar para offline'}><Download size={17} /></button>
            <button onClick={onRefresh} className="sidebar-icon-btn" title="Actualizar biblioteca" aria-label="Actualizar biblioteca"><RefreshCw size={17} /></button>
            <button onClick={onToggleLogs} className="sidebar-icon-btn" title={isAdmin ? 'Registros del sistema' : 'Progreso de tus descargas'} aria-label="Registros"><FileText size={17} /></button>
            <button onClick={onLogout} className="sidebar-icon-btn" title={`Cerrar sesión (${currentUser})`} aria-label="Cerrar sesión"><LogOut size={17} /></button>
          </div>
        </div>
        <div style={{ flex: 1, overflowY: 'auto', display: 'flex', flexDirection: 'column', gap: '4px', margin: '0 -8px', padding: '0 8px' }}>
          {playlists.map(p => {
            const active = activePlaylistId === p.id;
            return (
              <button key={p.id} type="button" className={`sidebar-playlist${active ? ' active' : ''}`} onClick={() => onOpenPlaylist(p)} aria-current={active ? 'true' : undefined}>
                {p.cover_url
                  ? <img src={p.cover_url} alt="" style={{ width: '32px', height: '32px', borderRadius: '4px', objectFit: 'cover' }} />
                  : <div style={{ width: '32px', height: '32px', borderRadius: '4px', background: '#333', display: 'flex', alignItems: 'center', justifyContent: 'center', flexShrink: 0 }}><ListMusic size={16} /></div>}
                <div style={{ flex: 1, minWidth: 0, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap', fontSize: '14px', fontWeight: 'bold' }}>{p.name}</div>
              </button>
            );
          })}
        </div>
        <div style={{ color: 'var(--text-secondary)', fontSize: '12px', fontWeight: '500', borderTop: '1px solid #333', paddingTop: '12px' }}>
          {songCount} {songCount === 1 ? 'canción' : 'canciones'} mostradas
        </div>
      </div>
      <ResizeHandle value={width} min={150} max={500} onChange={setWidth} />
    </nav>
  );
}

export default memo(Sidebar);
