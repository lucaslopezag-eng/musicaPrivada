import { useCallback, useMemo, useRef, useState } from 'react';
import SongRow from './SongRow.jsx';
import { useVirtualList } from '../../hooks/useVirtualList.js';
import { useLatestRef, useStableCallback } from '../../hooks/useLatestRef.js';

const ROW_GAP = 2;
const AUTO_SCROLL_EDGE = 56;
const AUTO_SCROLL_STEP = 14;

// Lista de canciones VIRTUALIZADA (FASE 2): con 500+ canciones solo están en el
// DOM las filas visibles más un margen → scroll fluido y poca memoria en móvil.
// Reordenación (UI-01):
// · Con un filtro de búsqueda activo se desactiva (los índices filtrados no
//   corresponden al orden real).
// · HTML5 drag & drop en escritorio y asa ⋮⋮ con eventos pointer en táctil,
//   con desplazamiento automático al acercarse a los bordes.
// · Los índices se traducen a ids antes de mover.
export default function SongList({ songs, searchQuery = '', currentSongId, isPlaying, canReorder, onPlay, onMenu, onReorder }) {
  const [dragFrom, setDragFrom] = useState(null);
  const [dragOver, setDragOver] = useState(null);
  const dragRef = useRef({ from: null, over: null });
  const autoScrollRef = useRef({ frame: 0, dy: 0 });
  const { listRef, measureRef, range, stride, totalHeight, scrollParentRef } = useVirtualList({
    count: songs.length, estimatedRowHeight: 56, gap: ROW_GAP,
  });

  const songsRef = useLatestRef(songs);

  const markFrom = useCallback((index) => { dragRef.current.from = index; setDragFrom(index); }, []);
  const markOver = useCallback((index) => {
    if (dragRef.current.over === index) return;
    dragRef.current.over = index;
    setDragOver(index);
  }, []);

  const drop = useStableCallback(() => {
    const auto = autoScrollRef.current;
    if (auto.frame) cancelAnimationFrame(auto.frame);
    auto.frame = 0;
    auto.dy = 0;
    const { from, over } = dragRef.current;
    dragRef.current = { from: null, over: null };
    setDragFrom(null);
    setDragOver(null);
    if (!canReorder || from === null || over === null || from === over) return;
    const list = songsRef.current;
    const fromId = list[from]?.id;
    const toId = list[over]?.id;
    if (fromId !== undefined && toId !== undefined) onReorder(fromId, toId);
  });

  const play = useStableCallback((song) => onPlay(song));
  const openMenu = useStableCallback((song, x, y) => onMenu(song, x, y));

  // Reordenación táctil con el asa (pointer events).
  const pointerReorder = useStableCallback((e, index) => {
    if (!canReorder) return;
    e.preventDefault();
    e.stopPropagation();
    markFrom(index);
    markOver(index);
    const parent = scrollParentRef.current;
    const scroller = parent && parent !== window ? parent : null;
    const auto = autoScrollRef.current;
    let lastPoint = { x: e.clientX, y: e.clientY };
    const hitTest = () => {
      const el = document.elementFromPoint(lastPoint.x, lastPoint.y)?.closest('[data-song-index]');
      if (el) markOver(Number(el.getAttribute('data-song-index')));
    };
    const step = () => {
      auto.frame = 0;
      if (!scroller || auto.dy === 0) return;
      scroller.scrollTop += auto.dy;
      hitTest();
      auto.frame = requestAnimationFrame(step);
    };
    const onMove = (ev) => {
      lastPoint = { x: ev.clientX, y: ev.clientY };
      hitTest();
      if (scroller) {
        const r = scroller.getBoundingClientRect();
        auto.dy = ev.clientY < r.top + AUTO_SCROLL_EDGE ? -AUTO_SCROLL_STEP : ev.clientY > r.bottom - AUTO_SCROLL_EDGE ? AUTO_SCROLL_STEP : 0;
        if (auto.dy !== 0 && !auto.frame) auto.frame = requestAnimationFrame(step);
      }
    };
    const onUp = () => {
      window.removeEventListener('pointermove', onMove);
      window.removeEventListener('pointerup', onUp);
      window.removeEventListener('pointercancel', onUp);
      drop();
    };
    window.addEventListener('pointermove', onMove);
    window.addEventListener('pointerup', onUp);
    window.addEventListener('pointercancel', onUp);
  });

  const actions = useMemo(() => ({
    play, openMenu, drop, pointerReorder, dragStart: markFrom, dragEnter: markOver,
  }), [play, openMenu, drop, pointerReorder, markFrom, markOver]);

  if (songs.length === 0) {
    return searchQuery ? (
      <div style={{ color: 'var(--text-secondary)', padding: '24px 16px', textAlign: 'center', fontSize: '14px' }}>
        Sin resultados para &quot;{searchQuery}&quot;
      </div>
    ) : null;
  }

  // Filas visibles + la que se arrastra (si se desmontara, el navegador
  // cancelaría el drag & drop sin dispatchar dragend).
  const indices = [];
  for (let i = range.start; i <= range.end; i++) indices.push(i);
  if (dragFrom !== null && (dragFrom < range.start || dragFrom > range.end) && dragFrom < songs.length) indices.push(dragFrom);

  return (
    <div ref={listRef} className="song-list-virtual" role="list" aria-rowcount={songs.length}
      style={{ height: `${totalHeight}px` }}
      onDragOver={(e) => e.preventDefault()}
      onDrop={(e) => { e.preventDefault(); drop(); }}>
      {indices.map((i, n) => {
        const song = songs[i];
        if (!song) return null;
        const isActive = song.id === currentSongId;
        return (
          <SongRow
            key={song.id}
            song={song}
            index={i}
            top={i * stride}
            isActive={isActive}
            isPlaying={isActive && isPlaying}
            isDragged={dragFrom === i}
            isDragOver={dragOver === i}
            canReorder={canReorder}
            actions={actions}
            measureRef={n === 0 ? measureRef : undefined}
          />
        );
      })}
    </div>
  );
}
