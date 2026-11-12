import { useCallback, useEffect, useRef, useState } from 'react';
import { Scissors, X, Play, Pause } from 'lucide-react';
import Cover from '../common/Cover.jsx';
import { streamUrlFor } from '../../lib/media.js';
import { withParams } from '../../pwa.js';
import { useLatestRef } from '../../hooks/useLatestRef.js';
import { formatTrimTime } from '../../lib/format.js';

const MIN_LENGTH = 0.5;

function disposeAudio(audio) {
  if (!audio) return;
  try { audio.pause(); audio.removeAttribute('src'); audio.load(); } catch { /* ya liberado */ }
}

// Editor visual de recorte. Carga los metadatos con un <audio> propio que se
// libera siempre al cerrar (UI-03: antes quedaba huérfano y podía reabrir el
// editor). Si el navegador no puede leer la duración, se pide al servidor.
export default function TrimEditor({ song, apiFetch, onClose, onSaved, addToast }) {
  const [duration, setDuration] = useState(null);
  const [range, setRange] = useState({ start: 0, end: 0 });
  const [previewing, setPreviewing] = useState(false);
  const [previewTime, setPreviewTime] = useState(0);
  const [saving, setSaving] = useState(false);
  const audioRef = useRef(null);
  const rafRef = useRef(0);
  const rangeRef = useLatestRef(range);

  useEffect(() => {
    const url = streamUrlFor(song);
    if (!url) { onClose(); return undefined; }
    let cancelled = false;
    const audio = new Audio(withParams(url, { bypass_sw: '1' }));
    audio.preload = 'metadata';
    audioRef.current = audio;
    const ready = (dur) => {
      if (cancelled) return;
      setDuration(dur);
      setRange({ start: 0, end: dur });
    };
    const onMeta = () => ready(audio.duration);
    const onError = () => {
      if (cancelled) return;
      apiFetch(`/songs/${song.id}/duration`)
        .then(r => (r.ok ? r.json() : null))
        .then(d => ready((d && d.duration) || 180))
        .catch(() => { if (!cancelled) { addToast('No se pudo cargar la canción para recortar', 'error'); onClose(); } });
    };
    audio.addEventListener('loadedmetadata', onMeta);
    audio.addEventListener('error', onError);
    audio.load();
    return () => {
      cancelled = true;
      audio.removeEventListener('loadedmetadata', onMeta);
      audio.removeEventListener('error', onError);
      if (rafRef.current) cancelAnimationFrame(rafRef.current);
      disposeAudio(audio);
      audioRef.current = null;
    };
  }, [song, apiFetch, addToast, onClose]);

  useEffect(() => {
    const onKey = (e) => { if (e.key === 'Escape') onClose(); };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [onClose]);

  const stopPreview = useCallback(() => {
    if (rafRef.current) { cancelAnimationFrame(rafRef.current); rafRef.current = 0; }
    audioRef.current?.pause();
    setPreviewing(false);
  }, []);

  const togglePreview = () => {
    const audio = audioRef.current;
    if (!audio || duration === null) return;
    if (previewing) { stopPreview(); return; }
    audio.currentTime = range.start;
    audio.play().catch(() => setPreviewing(false));
    setPreviewing(true);
    const tick = () => {
      const a = audioRef.current;
      if (!a) return;
      setPreviewTime(a.currentTime);
      if (a.currentTime >= rangeRef.current.end || a.paused) { stopPreview(); return; }
      rafRef.current = requestAnimationFrame(tick);
    };
    rafRef.current = requestAnimationFrame(tick);
  };

  // Arrastre de los tiradores con eventos pointer (ratón y táctil).
  const startDrag = (e, handle) => {
    e.preventDefault();
    const bar = e.currentTarget.closest('[data-trim-bar]');
    if (!bar || duration === null) return;
    const move = (ev) => {
      const rect = bar.getBoundingClientRect();
      const t = Math.max(0, Math.min(1, (ev.clientX - rect.left) / rect.width)) * duration;
      setRange(prev => (handle === 'start'
        ? { ...prev, start: Math.min(t, prev.end - MIN_LENGTH) }
        : { ...prev, end: Math.max(t, prev.start + MIN_LENGTH) }));
    };
    const stop = () => {
      window.removeEventListener('pointermove', move);
      window.removeEventListener('pointerup', stop);
      window.removeEventListener('pointercancel', stop);
    };
    window.addEventListener('pointermove', move);
    window.addEventListener('pointerup', stop);
    window.addEventListener('pointercancel', stop);
    move(e);
  };

  // Teclado: flechas mueven el tirador enfocado 0,1 s (Shift: 1 s).
  const onHandleKey = (e, handle) => {
    if (duration === null || (e.key !== 'ArrowLeft' && e.key !== 'ArrowRight')) return;
    e.preventDefault();
    const step = (e.shiftKey ? 1 : 0.1) * (e.key === 'ArrowLeft' ? -1 : 1);
    setRange(prev => (handle === 'start'
      ? { ...prev, start: Math.max(0, Math.min(prev.start + step, prev.end - MIN_LENGTH)) }
      : { ...prev, end: Math.min(duration, Math.max(prev.end + step, prev.start + MIN_LENGTH)) }));
  };

  const save = async () => {
    if (duration === null || saving) return;
    setSaving(true);
    stopPreview();
    try {
      const r = await apiFetch(`/songs/${song.id}/trim`, {
        method: 'POST',
        body: JSON.stringify({ startTime: range.start, endTime: range.end, rev: song.rev ?? 0 }),
      });
      const d = await r.json().catch(() => ({}));
      if (r.ok) {
        addToast('Canción recortada correctamente', 'success');
        onSaved(song, d, range.start);
        onClose();
      } else {
        addToast(`Error al recortar: ${d.error || 'Trim failed'}`, 'error');
      }
    } catch (err) {
      addToast(`Error al recortar: ${err.message}`, 'error');
    } finally {
      setSaving(false);
    }
  };

  const loaded = duration !== null && duration > 0;
  const pct = (t) => `${loaded ? (t / duration) * 100 : 0}%`;
  const removedStart = range.start;
  const removedEnd = loaded ? duration - range.end : 0;
  const unchanged = removedStart < 0.1 && removedEnd < 0.1;

  return (
    <div className="modal-backdrop" style={{ zIndex: 20000 }} onClick={onClose}>
      <div role="dialog" aria-modal="true" aria-labelledby="trim-title" className="trim-editor" onClick={e => e.stopPropagation()}>
        <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginBottom: '24px' }}>
          <div style={{ display: 'flex', alignItems: 'center', gap: '12px' }}>
            <Scissors size={20} color="var(--accent-color)" />
            <h3 id="trim-title" style={{ margin: 0, fontSize: '18px' }}>Trim Song</h3>
          </div>
          <button onClick={onClose} aria-label="Cerrar" style={{ color: '#aaa' }}><X size={20} /></button>
        </div>

        <div style={{ display: 'flex', alignItems: 'center', gap: '12px', marginBottom: '24px', background: '#282828', padding: '12px', borderRadius: '8px' }}>
          <Cover src={song.cover_url} size={48} />
          <div>
            <div style={{ fontWeight: 'bold', fontSize: '14px' }}>{song.title}</div>
            <div style={{ color: 'var(--text-secondary)', fontSize: '12px' }}>{song.artist}</div>
          </div>
        </div>

        {!loaded ? (
          <div style={{ padding: '32px', textAlign: 'center', color: 'var(--text-secondary)' }}>Cargando la canción…</div>
        ) : (
          <>
            <div style={{ marginBottom: '16px' }}>
              <div style={{ display: 'flex', justifyContent: 'space-between', fontSize: '11px', color: 'var(--text-secondary)', marginBottom: '8px' }}>
                <span>0:00</span>
                <span>{formatTrimTime(duration)}</span>
              </div>
              <div data-trim-bar className="trim-bar">
                <div className="trim-removed" style={{ left: 0, width: pct(range.start) }} />
                <div className="trim-removed" style={{ right: 0, width: pct(duration - range.end) }} />
                <div className="trim-kept" style={{ left: pct(range.start), width: pct(range.end - range.start) }} />
                {previewing && <div className="trim-playhead" style={{ left: pct(previewTime) }} />}
                <div role="slider" tabIndex={0} aria-label="Inicio del recorte" aria-valuemin={0} aria-valuemax={Math.round(duration)}
                  aria-valuenow={Math.round(range.start)} aria-valuetext={formatTrimTime(range.start)}
                  className="trim-handle" style={{ left: pct(range.start) }}
                  onPointerDown={e => startDrag(e, 'start')} onKeyDown={e => onHandleKey(e, 'start')}>
                  <div className="trim-handle-grip" style={{ background: '#1db954', boxShadow: '0 0 6px rgba(29,185,84,0.5)' }} />
                </div>
                <div role="slider" tabIndex={0} aria-label="Fin del recorte" aria-valuemin={0} aria-valuemax={Math.round(duration)}
                  aria-valuenow={Math.round(range.end)} aria-valuetext={formatTrimTime(range.end)}
                  className="trim-handle" style={{ left: pct(range.end) }}
                  onPointerDown={e => startDrag(e, 'end')} onKeyDown={e => onHandleKey(e, 'end')}>
                  <div className="trim-handle-grip" style={{ background: '#ff4444', boxShadow: '0 0 6px rgba(255,68,68,0.5)' }} />
                </div>
              </div>
              <div style={{ display: 'flex', justifyContent: 'space-between', fontSize: '12px', marginTop: '8px', color: '#ccc' }}>
                <span style={{ color: '#1db954' }}>Start: {formatTrimTime(range.start)}</span>
                <span>Duration: {formatTrimTime(range.end - range.start)}</span>
                <span style={{ color: '#ff4444' }}>End: {formatTrimTime(range.end)}</span>
              </div>
            </div>
            {!unchanged && (
              <div style={{ fontSize: '12px', color: 'var(--text-secondary)', marginBottom: '16px', padding: '8px 12px', background: '#282828', borderRadius: '6px' }}>
                {removedStart > 0.1 && <span>Removing <strong style={{ color: '#ff6666' }}>{formatTrimTime(removedStart)}</strong> from the start. </span>}
                {removedEnd > 0.1 && <span>Removing <strong style={{ color: '#ff6666' }}>{formatTrimTime(removedEnd)}</strong> from the end.</span>}
              </div>
            )}
          </>
        )}

        <div style={{ display: 'flex', gap: '12px', justifyContent: 'flex-end', flexWrap: 'wrap' }}>
          <button onClick={togglePreview} disabled={!loaded} className="btn-secondary">
            {previewing ? <><Pause size={14} /> Stop</> : <><Play size={14} /> Preview</>}
          </button>
          <button onClick={onClose} className="btn-outline">Cancel</button>
          <button onClick={save} disabled={!loaded || saving || unchanged} className="btn-primary">
            <Scissors size={14} /> {saving ? 'Trimming...' : 'Trim & Save'}
          </button>
        </div>
      </div>
    </div>
  );
}
