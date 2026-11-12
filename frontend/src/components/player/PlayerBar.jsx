import { memo, useCallback, useState } from 'react';
import { Play, Pause, SkipForward, SkipBack, Shuffle, Repeat, Repeat1, Sparkles, ThumbsUp, ThumbsDown, Mic2, ListMusic, Gauge } from 'lucide-react';
import Cover from '../common/Cover.jsx';
import ProgressBar from './ProgressBar.jsx';
import VolumeControl from './VolumeControl.jsx';
import ShuffleMenu from './ShuffleMenu.jsx';

const REPEAT_LABEL = { off: 'desactivado', all: 'todas', one: 'una' };

// Barra de reproducción persistente: carátula, título/artista, controles,
// progreso, volumen, letras y cola. No depende del tiempo de reproducción
// (eso lo pinta ProgressBar), así que solo se re-renderiza al cambiar de
// canción, de estado o de modo.
function PlayerBar({
  currentSong, isPlaying, shuffleMode, repeatMode, volume, muted, loudnessNorm, currentAiRec, aiCount,
  playerHeight, showSubtitles, showQueue, timeStore, actions, onToggleSubtitles, onToggleQueue, onAcceptAi, onRejectAi,
}) {
  const [menuOpen, setMenuOpen] = useState(false);
  const closeMenu = useCallback(() => setMenuOpen(false), []);
  const sizeClass = `${playerHeight > 140 ? ' player-bar-expanded' : ''}${playerHeight < 75 ? ' player-bar-compact' : ''}`;

  return (
    <div className={`player-bar${sizeClass}`} role="region" aria-label="Reproductor">
      <div className="player-song-info" style={{ width: '30%', display: 'flex', alignItems: 'center', gap: '12px' }}>
        {currentSong && <>
          <Cover src={currentSong.cover_url} size={56} />
          <div style={{ minWidth: 0, flex: 1 }}>
            {currentAiRec && <div style={{ fontSize: '10px', color: 'var(--accent-color)', fontWeight: 'bold', display: 'flex', alignItems: 'center', gap: '4px', marginBottom: '2px' }}><Sparkles size={10} /> Recomendación IA</div>}
            <div style={{ fontWeight: 'bold', fontSize: '14px', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{currentSong.title}</div>
            <div style={{ color: 'var(--text-secondary)', fontSize: '12px', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{currentSong.artist}</div>
          </div>
          {currentAiRec && <div className="player-ai-actions" style={{ display: 'flex', gap: '4px', flexShrink: 0 }}>
            <button onClick={onAcceptAi} title="Añadir a Biblioteca" aria-label="Añadir a la biblioteca" className="ai-action-btn" style={{ background: 'var(--accent-color)', color: '#000' }}><ThumbsUp size={14} /></button>
            <button onClick={onRejectAi} title="Eliminar" aria-label="Rechazar recomendación" className="ai-action-btn" style={{ background: '#ff4444', color: '#fff' }}><ThumbsDown size={14} /></button>
          </div>}
        </>}
      </div>

      <div className="player-controls" style={{ flex: 1, display: 'flex', flexDirection: 'column', alignItems: 'center', gap: '8px', position: 'relative' }}>
        {menuOpen && <ShuffleMenu mode={shuffleMode} aiCount={aiCount} onSelect={actions.setShuffleMode} onClose={closeMenu} />}
        <div style={{ display: 'flex', gap: '24px', alignItems: 'center', color: 'var(--text-secondary)' }}>
          <button onClick={(e) => { e.stopPropagation(); setMenuOpen(o => !o); }} title="Modo Aleatorio (S)" aria-label="Modo de reproducción" aria-haspopup="menu" aria-expanded={menuOpen}>
            <Shuffle size={20} className={shuffleMode !== 'normal' ? 'ctrl-btn-active' : ''} color={shuffleMode !== 'normal' ? 'var(--accent-color)' : 'var(--text-secondary)'} />
          </button>
          <button onClick={actions.prev} title="Anterior (←)" aria-label="Anterior"><SkipBack size={24} /></button>
          <button className="main-play-btn" onClick={actions.togglePlay} title="Reproducir/Pausar (Espacio)" aria-label={isPlaying ? 'Pausar' : 'Reproducir'}>
            {isPlaying ? <Pause size={20} className="play-icon-fill" /> : <Play size={20} className="play-icon-fill" />}
          </button>
          <button onClick={actions.next} title="Siguiente (→)" aria-label="Siguiente"><SkipForward size={24} /></button>
          <button onClick={actions.cycleRepeat} title={`Repetir: ${repeatMode}`} aria-label={`Repetir: ${REPEAT_LABEL[repeatMode]}`}
            className={repeatMode !== 'off' ? 'ctrl-btn-active' : ''}
            style={{ color: repeatMode !== 'off' ? 'var(--accent-color)' : 'var(--text-secondary)', position: 'relative' }}>
            {repeatMode === 'one' ? <Repeat1 size={20} /> : <Repeat size={20} />}
          </button>
        </div>
        <ProgressBar timeStore={timeStore} onSeek={actions.seek} />
      </div>

      <div className="player-volume" style={{ width: '30%', display: 'flex', justifyContent: 'flex-end', alignItems: 'center', gap: '16px', color: 'var(--text-secondary)' }}>
        <button onClick={onToggleSubtitles} style={{ color: showSubtitles ? 'var(--accent-color)' : 'var(--text-secondary)' }} title="Letras" aria-label="Letras" aria-pressed={showSubtitles}><Mic2 size={20} /></button>
        <button onClick={onToggleQueue} style={{ color: showQueue ? 'var(--accent-color)' : 'var(--text-secondary)' }} title="Cola" aria-label="Cola" aria-pressed={showQueue}><ListMusic size={20} /></button>
        <button onClick={actions.toggleLoudnessNorm} style={{ color: loudnessNorm ? 'var(--accent-color)' : 'var(--text-secondary)' }} title={loudnessNorm ? 'Igualar volumen entre canciones: activado' : 'Igualar volumen entre canciones: desactivado'} aria-label="Igualar volumen entre canciones" aria-pressed={loudnessNorm}><Gauge size={20} /></button>
        <VolumeControl volume={volume} muted={muted} onChange={actions.setVolume} onToggleMute={actions.toggleMute} />
      </div>
    </div>
  );
}

export default memo(PlayerBar);
