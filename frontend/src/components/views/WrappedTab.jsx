// Resumen / estadísticas: selector de año y acceso a la historia inmersiva.
export default function WrappedTab({ year, data, loading, onSelectYear, onPlayStory }) {
  return (
    <div style={{ padding: '8px 0', maxWidth: '800px', margin: '0 auto' }}>
      <h2 style={{ fontSize: '36px', fontWeight: '800', marginBottom: '8px', background: 'linear-gradient(135deg, #1ed760, #4a9ff5)', WebkitBackgroundClip: 'text', WebkitTextFillColor: 'transparent' }}>Tu Resumen</h2>
      <p style={{ color: 'var(--text-secondary)', marginBottom: '24px' }}>Tus estadísticas de escucha en el tiempo.</p>
      <div style={{ display: 'flex', gap: '12px', marginBottom: '32px', overflowX: 'auto', paddingBottom: '8px' }} role="tablist" aria-label="Periodo">
        {['all', ...(data?.availableYears || [])].map(y => (
          <button key={y} role="tab" aria-selected={year === y} onClick={() => onSelectYear(y)} className="year-chip"
            style={{ background: year === y ? 'var(--accent-color)' : 'var(--bg-highlight)', color: year === y ? '#000' : 'var(--text-primary)' }}>
            {y === 'all' ? 'Histórico' : y}
          </button>
        ))}
      </div>
      {loading ? (
        <div style={{ textAlign: 'center', padding: '40px', color: 'var(--text-secondary)' }}>Cargando estadísticas...</div>
      ) : data ? (
        <div style={{ animation: 'slide-up 0.4s ease', textAlign: 'center', background: 'var(--bg-highlight)', padding: 'clamp(24px, 6vw, 60px)', borderRadius: '16px', border: '1px solid rgba(30,215,96,0.2)' }}>
          <h3 style={{ fontSize: '32px', fontWeight: '800', marginBottom: '20px', color: 'var(--accent-color)' }}>Datos Listos</h3>
          <p style={{ color: 'var(--text-secondary)', marginBottom: '40px', fontSize: '18px' }}>Experimenta tu Resumen {year === 'all' ? 'Histórico' : year} en una historia inmersiva.</p>
          <button onClick={onPlayStory} className="big-cta">▶ Reproducir Resumen</button>
        </div>
      ) : (
        <div style={{ textAlign: 'center', padding: '40px', color: 'var(--text-secondary)' }}>No hay estadísticas disponibles.</div>
      )}
    </div>
  );
}
