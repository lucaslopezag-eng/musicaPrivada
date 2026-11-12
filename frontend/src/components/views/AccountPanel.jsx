import { useCallback, useEffect, useState } from 'react';
import { KeyRound, MonitorSmartphone, X } from 'lucide-react';
import { describeUserAgent, formatRelative } from '../../lib/format.js';

const MIN_PASSWORD = 10;

// Cuenta (FASE 2): cambio de contraseña y sesiones activas con revocación.
export default function AccountPanel({ apiFetch, addToast, onLoggedOut }) {
  const [sessions, setSessions] = useState(null);
  const [form, setForm] = useState({ current: '', next: '', repeat: '' });
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState('');

  const loadSessions = useCallback(async () => {
    try {
      const r = await apiFetch('/auth/sessions');
      if (r.ok) setSessions(await r.json());
    } catch { /* sin red */ }
  }, [apiFetch]);

  useEffect(() => { loadSessions(); }, [loadSessions]);

  const changePassword = async (e) => {
    e.preventDefault();
    setError('');
    if (form.next.length < MIN_PASSWORD) { setError(`La nueva contraseña debe tener al menos ${MIN_PASSWORD} caracteres`); return; }
    if (form.next !== form.repeat) { setError('Las contraseñas nuevas no coinciden'); return; }
    setSaving(true);
    try {
      const r = await apiFetch('/auth/change-password', {
        method: 'POST',
        body: JSON.stringify({ currentPassword: form.current, newPassword: form.next, revokeOtherSessions: true }),
      });
      const d = await r.json().catch(() => ({}));
      if (!r.ok) { setError(d.error || 'No se pudo cambiar la contraseña'); return; }
      setForm({ current: '', next: '', repeat: '' });
      addToast(`Contraseña actualizada${d.revokedSessions ? ` · ${d.revokedSessions} sesiones cerradas` : ''}`, 'success');
      loadSessions();
    } catch {
      setError('Error de red');
    } finally {
      setSaving(false);
    }
  };

  const revoke = async (session) => {
    try {
      const r = await apiFetch(`/auth/sessions/${encodeURIComponent(session.id)}`, { method: 'DELETE' });
      if (!r.ok) throw new Error();
      if (session.current) { onLoggedOut(); return; }
      addToast('Sesión cerrada en ese dispositivo', 'info');
      loadSessions();
    } catch {
      addToast('No se pudo cerrar la sesión', 'error');
    }
  };

  const revokeOthers = async () => {
    try {
      const r = await apiFetch('/auth/sessions', { method: 'DELETE' });
      const d = await r.json().catch(() => ({}));
      if (!r.ok) throw new Error();
      addToast(`${d.revokedSessions || 0} sesiones cerradas`, 'info');
      loadSessions();
    } catch {
      addToast('No se pudieron cerrar las sesiones', 'error');
    }
  };

  const others = sessions ? sessions.filter(s => !s.current).length : 0;

  return (
    <div className="account-panel">
      <form onSubmit={changePassword} className="account-card" aria-labelledby="pw-title">
        <h4 id="pw-title"><KeyRound size={16} /> Cambiar contraseña</h4>
        <input type="password" autoComplete="current-password" placeholder="Contraseña actual" aria-label="Contraseña actual"
          value={form.current} onChange={e => setForm(f => ({ ...f, current: e.target.value }))} className="app-input" required />
        <input type="password" autoComplete="new-password" placeholder={`Nueva contraseña (mín. ${MIN_PASSWORD})`} aria-label="Nueva contraseña"
          value={form.next} onChange={e => setForm(f => ({ ...f, next: e.target.value }))} className="app-input" required minLength={MIN_PASSWORD} />
        <input type="password" autoComplete="new-password" placeholder="Repite la nueva contraseña" aria-label="Repite la nueva contraseña"
          value={form.repeat} onChange={e => setForm(f => ({ ...f, repeat: e.target.value }))} className="app-input" required />
        {error && <div role="alert" style={{ color: '#ff5555', fontSize: '13px' }}>{error}</div>}
        <p className="account-hint">Al cambiarla se cierran tus sesiones en los demás dispositivos.</p>
        <button type="submit" disabled={saving} className="btn-primary">{saving ? 'Guardando…' : 'Cambiar contraseña'}</button>
      </form>

      <div className="account-card" aria-labelledby="sessions-title">
        <h4 id="sessions-title"><MonitorSmartphone size={16} /> Sesiones activas</h4>
        {sessions === null && <div className="account-hint">Cargando…</div>}
        {sessions && sessions.length === 0 && <div className="account-hint">No hay sesiones activas.</div>}
        <ul className="session-list">
          {(sessions || []).map(s => (
            <li key={s.id} className="session-item">
              <div style={{ minWidth: 0, flex: 1 }}>
                <div style={{ fontWeight: 600, fontSize: '13px' }}>
                  {describeUserAgent(s.userAgent)} {s.current && <span className="session-current">este dispositivo</span>}
                </div>
                <div className="account-hint">Activa {formatRelative(s.lastSeenAt)} · iniciada {formatRelative(s.createdAt)}</div>
              </div>
              <button onClick={() => revoke(s)} aria-label={s.current ? 'Cerrar esta sesión' : 'Cerrar la sesión de ese dispositivo'} title="Cerrar sesión" className="session-revoke">
                <X size={14} />
              </button>
            </li>
          ))}
        </ul>
        {others > 0 && <button onClick={revokeOthers} className="btn-outline" style={{ alignSelf: 'flex-start' }}>Cerrar las otras {others} sesiones</button>}
      </div>
    </div>
  );
}
