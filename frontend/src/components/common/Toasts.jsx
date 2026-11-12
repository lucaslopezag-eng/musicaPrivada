export default function Toasts({ toasts }) {
  return (
    <div className="toast-container" role="status" aria-live="polite">
      {toasts.map(t => (
        <div key={t.id} className={`toast toast-${t.type}`}>
          {t.type === 'error' ? '✖' : t.type === 'info' ? 'ℹ' : '✔'} {t.message}
        </div>
      ))}
    </div>
  );
}
