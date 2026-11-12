import { Smartphone, Download, LogOut } from 'lucide-react';
import AccountPanel from './AccountPanel.jsx';

// Instalar la PWA, descarga offline y cuenta (contraseña y sesiones).
export default function InstallTab({ canInstall, onInstall, onPrecache, isCaching, cachedSongCount, currentUser, onLogout, apiFetch, addToast }) {
  return (
    <div style={{ padding: '40px 20px', maxWidth: '800px', margin: '0 auto', textAlign: 'center' }}>
      <h2 style={{ fontSize: '36px', fontWeight: '800', marginBottom: '40px', color: 'var(--accent-color)' }}>Instalar Aplicación</h2>
      <div style={{ display: 'flex', flexDirection: 'column', gap: '24px', alignItems: 'center' }}>
        <button onClick={() => (canInstall ? onInstall() : addToast('Abre el menú de tu navegador y selecciona "Añadir a la pantalla de inicio" o "Instalar"', 'info'))}
          className="big-cta" style={{ display: 'flex', alignItems: 'center', gap: '12px' }}>
          <Smartphone size={24} /> Instalar Ahora
        </button>

        <div className="divider" />

        <h3 style={{ fontSize: '20px', margin: 0, color: '#fff' }}>Música Offline</h3>
        <p style={{ color: 'var(--text-secondary)', fontSize: '14px', maxWidth: '400px', margin: '0 0 16px 0' }}>Descarga tu biblioteca al dispositivo para escucharla sin conexión.</p>
        <button onClick={onPrecache} className="outline-cta">
          <Download size={20} /> {isCaching ? 'Detener descarga' : 'Descargar Canciones'}
        </button>
        {cachedSongCount > 0 && <p style={{ color: 'var(--text-secondary)', fontSize: '13px', margin: 0 }}>{cachedSongCount} canciones disponibles sin conexión</p>}

        <div className="divider" />

        <h3 style={{ fontSize: '20px', margin: 0, color: '#fff' }}>Cuenta</h3>
        <p style={{ color: 'var(--text-secondary)', fontSize: '14px', margin: 0 }}>Sesión iniciada como <strong>{currentUser || '—'}</strong></p>
        <AccountPanel apiFetch={apiFetch} addToast={addToast} onLoggedOut={() => onLogout({ confirm: false, callServer: false })} />
        <button onClick={() => onLogout({ confirm: true })} className="logout-btn">
          <LogOut size={18} /> Cerrar sesión
        </button>
      </div>
    </div>
  );
}
