import { memo, useState } from 'react';
import { X, GripVertical, Sparkles } from 'lucide-react';
import Cover from '../common/Cover.jsx';
import ResizeHandle from '../layout/ResizeHandle.jsx';

const AUTO_QUEUE_PREVIEW = 20;
const HISTORY_PREVIEW = 10;

function MiniSong({ song, size = 32 }) {
  return (
    <>
      <Cover src={song.cover_url} size={size} radius={3} />
      <div style={{ flex: 1, minWidth: 0 }}>
        <div className="queue-song-title">{song.title}</div>
        <div className="queue-song-artist">{song.artist}</div>
      </div>
    </>
  );
}

// Cajón de la cola: reproduciendo, cola explícita (reordenable), "a
// continuación", próximas recomendaciones IA e historial reciente.
function QueuePanel({ currentSong, queue, autoQueue, aiQueue, history, shuffleMode, actions, onClose }) {
  const [width, setWidth] = useState(300);
  const [dragIndex, setDragIndex] = useState(null);

  return (
    <div className="sidebar queue-sidebar" style={{ width: `${width}px`, gridColumn: '3' }} role="complementary" aria-label="Cola de reproducción">
      <ResizeHandle value={width} min={150} max={500} invert onChange={setWidth} style={{ left: '-4px', right: 'auto' }} />
      <div className="sidebar-box" style={{ flex: 1, display: 'flex', flexDirection: 'column', gap: '16px', overflowY: 'hidden' }}>
        <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', paddingBottom: '8px', borderBottom: '1px solid #282828' }}>
          <h3 style={{ margin: 0, fontSize: '16px', fontWeight: 'bold' }}>Cola</h3>
          <button onClick={onClose} aria-label="Cerrar cola"><X size={18} /></button>
        </div>

        <div style={{ overflowY: 'auto', flex: 1, display: 'flex', flexDirection: 'column', gap: '16px' }}>
          {currentSong && (
            <div onClick={() => actions.playSong(currentSong)} style={{ cursor: 'pointer' }}>
              <div className="queue-section-title" style={{ color: 'var(--accent-color)', marginBottom: '10px' }}>Reproduciendo</div>
              <div style={{ display: 'flex', alignItems: 'center', gap: '12px', background: 'rgba(255,255,255,0.05)', padding: '10px', borderRadius: '8px' }}>
                <MiniSong song={currentSong} size={48} />
              </div>
            </div>
          )}

          {queue.length > 0 && (
            <div style={{ display: 'flex', flexDirection: 'column', gap: '8px' }}>
              <div className="queue-section-title">Siguiente en la cola</div>
              {queue.map((song, i) => (
                <div key={`q-${song.id}-${i}`} className="queue-item" draggable
                  onClick={() => actions.playFromQueue(i)}
                  onDragStart={() => setDragIndex(i)}
                  onDragOver={(e) => e.preventDefault()}
                  onDrop={() => { if (dragIndex !== null) actions.moveInQueue(dragIndex, i); setDragIndex(null); }}
                  onDragEnd={() => setDragIndex(null)}
                  style={{ background: 'rgba(255,255,255,0.02)', padding: '6px', borderRadius: '6px', opacity: dragIndex === i ? 0.5 : 1 }}>
                  <GripVertical size={14} color="#666" style={{ cursor: 'grab', flexShrink: 0 }} onClick={e => e.stopPropagation()} />
                  <MiniSong song={song} />
                  <button onClick={(e) => { e.stopPropagation(); actions.removeFromQueue(i); }} aria-label={`Quitar ${song.title} de la cola`}><X size={14} /></button>
                </div>
              ))}
            </div>
          )}

          {shuffleMode === 'ai' && aiQueue.length > 0 && (
            <div style={{ display: 'flex', flexDirection: 'column', gap: '8px' }}>
              <div className="queue-section-title" style={{ display: 'flex', alignItems: 'center', gap: '6px', color: 'var(--accent-color)' }}>
                <Sparkles size={12} /> Recomendaciones IA ({aiQueue.length})
              </div>
              {aiQueue.slice(0, 5).map(rec => (
                <div key={`ai-${rec.rec_id}`} className="queue-item" style={{ padding: '4px 0', cursor: 'default', opacity: 0.85 }}>
                  <MiniSong song={rec} />
                </div>
              ))}
            </div>
          )}

          <div style={{ display: 'flex', flexDirection: 'column', gap: '8px' }}>
            <div className="queue-section-title" style={{ color: 'var(--text-secondary)' }}>A continuación</div>
            {autoQueue.slice(0, AUTO_QUEUE_PREVIEW).map((song, i) => (
              <div key={`aq-${song.id}-${i}`} className="queue-item" onClick={() => actions.playSong(song)} style={{ gap: '10px', padding: '4px 0' }}>
                <div style={{ width: '18px', color: '#555', fontSize: '12px', flexShrink: 0 }}>{i + 1}</div>
                <MiniSong song={song} />
              </div>
            ))}
          </div>

          {history.length > 0 && (
            <div style={{ display: 'flex', flexDirection: 'column', gap: '8px' }}>
              <div className="queue-section-title" style={{ color: 'var(--text-secondary)' }}>Escuchadas recientemente</div>
              {history.slice(0, HISTORY_PREVIEW).map((song, i) => (
                <div key={`h-${song.id}-${i}`} className="queue-item" onClick={() => actions.playSong(song)} style={{ gap: '10px', padding: '4px 0', opacity: 0.7 }}>
                  <MiniSong song={song} />
                </div>
              ))}
            </div>
          )}
        </div>
      </div>
    </div>
  );
}

export default memo(QueuePanel);
