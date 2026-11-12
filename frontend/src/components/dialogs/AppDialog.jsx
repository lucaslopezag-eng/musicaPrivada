import { useEffect, useRef, useState } from 'react';
import { createPortal } from 'react-dom';

// Diálogo modal accesible (UI-04: sustituye a prompt()/confirm(), que bloquean
// el hilo principal y en algunas PWA instaladas ni siquiera se muestran).
// Escape cancela; el foco va al campo (prompt) o al botón principal (confirm).
export default function AppDialog({ dialog, onClose }) {
  const [value, setValue] = useState(dialog.defaultValue || '');
  const focusRef = useRef(null);
  const cancelValue = dialog.type === 'prompt' ? null : false;

  useEffect(() => { focusRef.current?.focus(); }, []);
  useEffect(() => {
    const onKey = (e) => { if (e.key === 'Escape') onClose(cancelValue); };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [onClose, cancelValue]);

  const submit = (e) => {
    e.preventDefault();
    onClose(dialog.type === 'prompt' ? value : true);
  };

  return createPortal(
    <div role="dialog" aria-modal="true" aria-labelledby="app-dialog-title" className="app-dialog-backdrop" onClick={() => onClose(cancelValue)}>
      <form onSubmit={submit} onClick={e => e.stopPropagation()} className="app-dialog">
        <h3 id="app-dialog-title" style={{ margin: 0, fontSize: '18px' }}>{dialog.title}</h3>
        {dialog.message && <p style={{ margin: 0, color: 'var(--text-secondary)', fontSize: '14px' }}>{dialog.message}</p>}
        {dialog.type === 'prompt' && (
          <input ref={focusRef} value={value} maxLength={100} aria-label={dialog.title} onChange={e => setValue(e.target.value)} className="app-input" />
        )}
        <div style={{ display: 'flex', gap: '10px', justifyContent: 'flex-end' }}>
          <button type="button" className="btn-outline" onClick={() => onClose(cancelValue)}>Cancelar</button>
          <button type="submit" ref={dialog.type === 'confirm' ? focusRef : undefined}
            className={dialog.danger ? 'btn-danger' : 'btn-primary'}>
            {dialog.confirmLabel || 'Aceptar'}
          </button>
        </div>
      </form>
    </div>,
    document.body
  );
}
