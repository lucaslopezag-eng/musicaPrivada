import { Component } from 'react';

// ─── ErrorBoundary (auditoría 2, FE-3) ───────────────────────────────────────
// Una excepción al pintar un componente desmontaba toda la app: pantalla en
// blanco y música cortada. Ahora se muestra un aviso con un botón para volver.
// · Sin `inline`: límite global; el botón recarga la página.
// · Con `inline`: rodea las vistas; el reproductor sigue sonando y el aviso se
//   quita solo al cambiar de pestaña (prop resetKey).
export default class ErrorBoundary extends Component {
  constructor(props) {
    super(props);
    this.state = { error: null };
  }

  static getDerivedStateFromError(error) {
    return { error };
  }

  componentDidCatch(error, info) {
    console.error('[ErrorBoundary]', error, info && info.componentStack);
  }

  componentDidUpdate(prevProps) {
    if (this.state.error && prevProps.resetKey !== this.props.resetKey) this.setState({ error: null });
  }

  render() {
    if (!this.state.error) return this.props.children;
    const { inline } = this.props;
    const retry = () => (inline ? this.setState({ error: null }) : window.location.reload());
    return (
      <div role="alert" style={{ padding: '32px 24px', textAlign: 'center', color: 'var(--text-primary, #fff)', ...(inline ? {} : { minHeight: '100vh', display: 'flex', flexDirection: 'column', justifyContent: 'center', background: 'var(--bg-color, #121212)' }) }}>
        <h2 style={{ marginBottom: '8px' }}>Algo ha fallado al mostrar esta pantalla</h2>
        <p style={{ opacity: 0.7, marginBottom: '16px' }}>{inline ? 'La música sigue sonando. Puedes reintentarlo o cambiar de pestaña.' : 'Recarga la aplicación para continuar.'}</p>
        <button className="round-btn" style={{ width: 'auto', padding: '8px 20px', borderRadius: '20px' }} onClick={retry}>
          {inline ? 'Reintentar' : 'Recargar'}
        </button>
      </div>
    );
  }
}
