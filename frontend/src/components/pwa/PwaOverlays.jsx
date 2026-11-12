import { Smartphone, X, Download, WifiOff } from 'lucide-react';

// Banner de instalación, progreso de la descarga offline e indicador sin conexión.
export default function PwaOverlays({ showInstall, onInstall, onDismissInstall, cacheProgress, isOffline, cachedSongCount }) {
  return (
    <>
      {showInstall && (
        <div className="pwa-install-banner" onClick={onInstall} role="button" tabIndex={0} onKeyDown={(e) => { if (e.key === 'Enter') onInstall(); }}>
          <div className="pwa-install-content">
            <Smartphone size={20} />
            <div>
              <div style={{ fontWeight: 'bold', fontSize: '14px' }}>Instalar app</div>
              <div style={{ fontSize: '12px', opacity: 0.8 }}>Escucha offline, sin navegador</div>
            </div>
          </div>
          <button className="pwa-install-btn">Instalar</button>
          <button className="pwa-install-close" aria-label="No volver a mostrar" onClick={(e) => { e.stopPropagation(); onDismissInstall(); }}><X size={14} /></button>
        </div>
      )}
      {cacheProgress && (
        <div className="pwa-cache-progress" role="status">
          <Download size={16} />
          <div style={{ flex: 1, minWidth: 0 }}>
            <div style={{ fontSize: '12px', fontWeight: 'bold', marginBottom: '4px' }}>Descargando para offline ({cacheProgress.current}/{cacheProgress.total})</div>
            <div style={{ fontSize: '11px', opacity: 0.7, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{cacheProgress.songTitle}</div>
            <div style={{ marginTop: '6px', background: 'rgba(255,255,255,0.15)', borderRadius: '4px', height: '4px' }}>
              <div style={{ width: `${cacheProgress.total ? (cacheProgress.current / cacheProgress.total) * 100 : 0}%`, background: 'var(--accent-color)', height: '100%', borderRadius: '4px', transition: 'width 0.3s ease' }} />
            </div>
          </div>
        </div>
      )}
      {isOffline && (
        <div className="pwa-offline-pill" role="status">
          <WifiOff size={14} />
          <span>Sin conexión</span>
          {cachedSongCount > 0 && <span className="pwa-cached-count">{cachedSongCount} offline</span>}
        </div>
      )}
    </>
  );
}
