import { memo } from 'react';
import { Play, MoreHorizontal, GripVertical } from 'lucide-react';
import Cover from '../common/Cover.jsx';
import { formatDurationMs } from '../../lib/format.js';

// Fila de canción memorizada: solo se re-renderiza si cambian SUS props (la
// fila activa al pausar, la arrastrada...). Las acciones llegan en un objeto
// estable, así que nunca capturan estado obsoleto (UI-01).
function SongRow({ song, index, top, isActive, isPlaying, isDragged, isDragOver, canReorder, actions, measureRef }) {
  const className = `song-row virtual-row${isActive ? ' active-row' : ''}${isDragged ? ' dragging' : ''}${isDragOver ? ' drag-over' : ''}`;
  return (
    <div
      ref={measureRef}
      data-song-index={index}
      className={className}
      style={{ top: `${top}px` }}
      tabIndex={0}
      aria-current={isActive ? 'true' : undefined}
      draggable={canReorder}
      onDragStart={(e) => { e.dataTransfer.effectAllowed = 'move'; actions.dragStart(index); }}
      onDragOver={(e) => e.preventDefault()}
      onDragEnter={() => actions.dragEnter(index)}
      onDragEnd={() => actions.drop()}
      onClick={() => actions.play(song)}
      onKeyDown={(e) => {
        if (e.target !== e.currentTarget) return;
        if (e.key === 'Enter') { e.preventDefault(); actions.play(song); }
        if (e.key === 'ContextMenu' || (e.shiftKey && e.key === 'F10')) {
          e.preventDefault();
          const r = e.currentTarget.getBoundingClientRect();
          actions.openMenu(song, r.right - 40, r.top + r.height / 2);
        }
      }}
    >
      <div className="track-number">{index + 1}</div>
      {isActive ? (
        <div className="play-icon-overlay" style={{ opacity: 1 }}>
          <div className={`now-playing-bars ${isPlaying ? 'playing' : 'paused'}`}><span /><span /><span /></div>
        </div>
      ) : (
        <div className="play-icon-overlay"><Play size={16} fill="white" /></div>
      )}
      <Cover src={song.cover_url} size={40} style={{ marginRight: '16px', pointerEvents: 'none' }} />
      <div style={{ flex: 1, minWidth: 0, pointerEvents: 'none' }}>
        <div className={`song-row-title${isActive ? ' song-title-active' : ''}`}>{song.title}</div>
        <div className="song-row-artist">{song.artist}</div>
      </div>
      <div className="song-duration" style={{ pointerEvents: 'none' }}>{formatDurationMs(song.duration)}</div>
      {canReorder && (
        <span className="reorder-handle" aria-label="Arrastrar para reordenar"
          onPointerDown={(e) => actions.pointerReorder(e, index)}
          onClick={(e) => e.stopPropagation()}>
          <GripVertical size={16} />
        </span>
      )}
      <button aria-label={`Más acciones para ${song.title}`} onClick={(e) => { e.stopPropagation(); actions.openMenu(song, e.clientX, e.clientY); }}
        style={{ color: 'var(--text-secondary)', padding: '4px', opacity: 0.7 }}>
        <MoreHorizontal size={18} />
      </button>
    </div>
  );
}

export default memo(SongRow);
