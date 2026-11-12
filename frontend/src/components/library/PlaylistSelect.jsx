// Selector de playlist destino (importación y búsqueda online).
export default function PlaylistSelect({ playlists, value, onChange, style, defaultName }) {
  const def = defaultName || 'Mi Biblioteca';
  return (
    <select value={value} onChange={e => onChange(e.target.value)} aria-label="Playlist de destino"
      style={{ background: '#333', color: '#fff', border: 'none', ...style }}>
      <option value="">{def} (Por defecto)</option>
      {playlists.filter(p => p.name !== def).map(p => (
        <option key={p.id} value={p.id}>{p.name}</option>
      ))}
    </select>
  );
}
