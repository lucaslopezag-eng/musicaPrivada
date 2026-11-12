import { useCallback, useEffect, useLayoutEffect, useRef, useState } from 'react';

// ─── Virtualizador ligero de listas (FASE 2) ─────────────────────────────────
// Monta solo las filas visibles (+ un margen) de una lista de altura fija, que
// puede estar en medio de un contenedor con scroll (la cabecera de la playlist,
// el buscador...). Sustituye a montar las 500+ filas en el DOM.
// · El contenedor de scroll se detecta solo (el ancestro con overflow-y auto).
// · La altura de fila se mide de la primera fila real (cambia en móvil).
// · `pinned`: índices que deben seguir montados aunque salgan de la vista
//   (la fila que se está arrastrando: si se desmontara, el navegador cancela
//   el drag & drop HTML5 sin disparar dragend).

function findScrollParent(el) {
  let node = el ? el.parentElement : null;
  while (node && node !== document.body) {
    const { overflowY } = getComputedStyle(node);
    if (overflowY === 'auto' || overflowY === 'scroll' || overflowY === 'overlay') return node;
    node = node.parentElement;
  }
  return window;
}

export function computeRange({ count, rowHeight, scrollTop, viewportHeight, listOffset, overscan }) {
  if (count === 0 || rowHeight <= 0) return { start: 0, end: -1 };
  const top = scrollTop - listOffset;
  const bottom = top + viewportHeight;
  const start = Math.max(0, Math.floor(top / rowHeight) - overscan);
  const end = Math.min(count - 1, Math.ceil(bottom / rowHeight) + overscan);
  return end < start ? { start: 0, end: -1 } : { start, end };
}

export function useVirtualList({ count, estimatedRowHeight = 58, overscan = 8, gap = 0 }) {
  const listRef = useRef(null);
  const scrollParentRef = useRef(null);
  const frame = useRef(0);
  const [rowHeight, setRowHeight] = useState(estimatedRowHeight);
  const stride = rowHeight + gap;
  // Primer pintado: se muestran las ~30 primeras filas hasta poder medir.
  const [range, setRange] = useState({ start: 0, end: Math.min(count, 30) - 1 });

  const recompute = useCallback(() => {
    frame.current = 0;
    const list = listRef.current;
    if (!list) return;
    const parent = scrollParentRef.current || window;
    const listRect = list.getBoundingClientRect();
    let scrollTop;
    let viewportHeight;
    let listOffset;
    if (parent === window) {
      scrollTop = window.scrollY;
      viewportHeight = window.innerHeight;
      listOffset = listRect.top + window.scrollY;
    } else {
      const parentRect = parent.getBoundingClientRect();
      scrollTop = parent.scrollTop;
      viewportHeight = parent.clientHeight;
      listOffset = listRect.top - parentRect.top + parent.scrollTop;
    }
    const next = computeRange({ count, rowHeight: stride, scrollTop, viewportHeight, listOffset, overscan });
    setRange(prev => (prev.start === next.start && prev.end === next.end ? prev : next));
  }, [count, stride, overscan]);

  const schedule = useCallback(() => {
    if (!frame.current) frame.current = requestAnimationFrame(recompute);
  }, [recompute]);

  useLayoutEffect(() => {
    scrollParentRef.current = findScrollParent(listRef.current);
    recompute();
  }, [recompute]);

  useEffect(() => {
    const parent = scrollParentRef.current || window;
    parent.addEventListener('scroll', schedule, { passive: true });
    window.addEventListener('resize', schedule);
    let ro = null;
    if (typeof ResizeObserver !== 'undefined') {
      ro = new ResizeObserver(schedule);
      if (parent !== window) ro.observe(parent);
      if (listRef.current) ro.observe(listRef.current);
    }
    return () => {
      parent.removeEventListener('scroll', schedule);
      window.removeEventListener('resize', schedule);
      if (ro) ro.disconnect();
      if (frame.current) { cancelAnimationFrame(frame.current); frame.current = 0; }
    };
  }, [schedule]);

  // Mide la altura real de una fila (ref de la primera fila montada).
  const measureRef = useCallback((node) => {
    if (!node) return;
    const h = node.offsetHeight;
    if (h > 0) setRowHeight(prev => (Math.abs(prev - h) >= 1 ? h : prev));
  }, []);

  const scrollToIndex = useCallback((index, align = 'center') => {
    const list = listRef.current;
    const parent = scrollParentRef.current;
    if (!list || !parent || parent === window) return;
    const listOffset = list.getBoundingClientRect().top - parent.getBoundingClientRect().top + parent.scrollTop;
    const rowTop = listOffset + index * stride;
    const target = align === 'center' ? rowTop - parent.clientHeight / 2 + stride / 2 : rowTop;
    parent.scrollTo({ top: Math.max(0, target) });
  }, [stride]);

  return { listRef, measureRef, scrollParentRef, range, stride, rowHeight, totalHeight: Math.max(0, count * stride - (count > 0 ? gap : 0)), scrollToIndex };
}
