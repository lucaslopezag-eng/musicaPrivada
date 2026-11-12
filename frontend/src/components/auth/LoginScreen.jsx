import { useState } from 'react';

// Pantalla de inicio de sesión (tema oscuro), con estados de envío y error.
export default function LoginScreen({ onLogin }) {
  const [user, setUser] = useState('');
  const [pass, setPass] = useState('');
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);

  const submit = async (e) => {
    e.preventDefault();
    if (busy) return;
    setBusy(true);
    setError('');
    const result = await onLogin(user, pass);
    setBusy(false);
    if (!result.ok) {
      setPass('');
      setError(result.error || 'Autenticación fallida');
    }
  };

  return (
    <div className="login-screen">
      <form onSubmit={submit} className="login-card" aria-busy={busy}>
        <h2 style={{ margin: 0, marginBottom: '16px', fontSize: '24px', fontWeight: 'bold' }}>Iniciar Sesión</h2>
        {error && <div role="alert" style={{ color: '#ff5555', fontSize: '14px', width: '100%', textAlign: 'center' }}>{error}</div>}
        <input type="text" placeholder="Usuario" autoComplete="username" autoCapitalize="none" aria-label="Usuario"
          value={user} onChange={e => setUser(e.target.value)} className="app-input" style={{ width: '100%' }} />
        <input type="password" placeholder="Contraseña" autoComplete="current-password" aria-label="Contraseña"
          value={pass} onChange={e => setPass(e.target.value)} className="app-input" style={{ width: '100%' }} />
        <button type="submit" disabled={busy} className="btn-primary" style={{ width: '100%', marginTop: '8px', padding: '12px' }}>
          {busy ? 'Entrando…' : 'Entrar'}
        </button>
      </form>
    </div>
  );
}
