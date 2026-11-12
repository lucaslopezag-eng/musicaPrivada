import { useRef } from 'react';
import { THEMES } from '../../lib/themes.js';

// Selector de fondos/acentos visuales + fondo de pantalla propio del usuario.
export default function ThemesTab({ theme, onSelect, hiddenThemes = [], background }) {
  return (
    <div style={{ padding: '8px 0' }}>
      <h2 style={{ fontSize: '32px', fontWeight: '800', marginBottom: '24px' }}>Temas</h2>
      <p style={{ color: 'var(--text-secondary)', marginBottom: '24px' }}>Personaliza tu experiencia auditiva.</p>
      <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fill, minmax(200px, 1fr))', gap: '20px' }} role="radiogroup" aria-label="Tema visual">
        {THEMES.filter(t => !hiddenThemes.includes(t.id)).map(t => (
          <button key={t.id} type="button" role="radio" aria-checked={theme === t.id} onClick={() => onSelect(t.id)} className="theme-card"
            style={{ border: theme === t.id ? `2px solid ${t.color}` : '2px solid transparent' }}>
            <div style={{ width: '60px', height: '60px', borderRadius: '50%', background: t.color, opacity: theme === t.id ? 1 : 0.5 }} />
            <h3 style={{ margin: 0, fontSize: '16px', fontWeight: 'bold' }}>{t.name}</h3>
          </button>
        ))}
      </div>
      {background && <BackgroundSettings background={background} />}
    </div>
  );
}

function BackgroundSettings({ background }) {
  const inputRef = useRef(null);
  const { url, opacity, busy, upload, remove, setOpacity } = background;

  return (
    <section className="bg-settings" aria-labelledby="bg-settings-title">
      <h3 id="bg-settings-title" style={{ fontSize: '22px', fontWeight: '800', margin: '0 0 8px' }}>Fondo de pantalla</h3>
      <p style={{ color: 'var(--text-secondary)', margin: '0 0 16px' }}>Pon una imagen tuya de fondo y ajusta cuánto se ve. Solo la ves tú.</p>
      <div className="bg-settings-row">
        <div className="bg-settings-preview" aria-hidden="true">
          {url
            ? <div style={{ backgroundImage: `url("${url}")`, opacity: opacity / 100 }} />
            : <span>Sin imagen</span>}
        </div>
        <div className="bg-settings-controls">
          <input ref={inputRef} type="file" accept="image/*" hidden
            onChange={(e) => { const f = e.target.files?.[0]; e.target.value = ''; upload(f); }} />
          <div style={{ display: 'flex', gap: '8px', flexWrap: 'wrap' }}>
            <button type="button" className="btn-primary" disabled={busy} onClick={() => inputRef.current?.click()}>
              {busy ? 'Subiendo…' : url ? 'Cambiar imagen' : 'Elegir imagen'}
            </button>
            {url && <button type="button" className="btn-outline" disabled={busy} onClick={remove}>Quitar</button>}
          </div>
          <label className="bg-settings-slider">
            <span>Visibilidad de la imagen: <strong>{opacity}%</strong></span>
            <input type="range" min="0" max="100" step="1" value={opacity} disabled={!url}
              onChange={(e) => setOpacity(e.target.value)} aria-label="Visibilidad de la imagen de fondo" />
            <small style={{ color: 'var(--text-secondary)' }}>0% = invisible · 100% = imagen sin transparencia</small>
          </label>
        </div>
      </div>
    </section>
  );
}
