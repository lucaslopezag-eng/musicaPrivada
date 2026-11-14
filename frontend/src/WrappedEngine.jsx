import React, { useState, useEffect, useRef } from 'react';
import { Clock, Headphones, Star, BarChart2, Repeat, TrendingUp, Users, Calendar, CloudLightning, Activity, Flame, Heart } from 'lucide-react';
import { useWrappedAudio } from './hooks/useWrappedAudio';
import './index.css';

const API_BASE = '/api';

export default function WrappedEngine({ wrappedData, year, onClose }) {
  const [slide, setSlide] = useState(0);
  const [isStarted, setIsStarted] = useState(false);
  const [isPaused, setIsPaused] = useState(false);
  const audioRef = useRef(null);
  const { fadeAndPlay, prefetch, stop, fadeVolume } = useWrappedAudio(audioRef);
  
  const totalSlides = 36;
  const isDemo = wrappedData?.isDemo;

  const topSongs    = wrappedData?.topSongs    || [];
  const topArtists  = wrappedData?.topArtists  || [];
  const topGenres   = wrappedData?.topGenres   || [];
  const timeStats   = wrappedData?.timeStats   || { topTimeOfDay: 'Noche', maxTimePlays: 0 };
  const skipStats   = wrappedData?.skipStats   || { completed: 0, skipped: 0, total: 0 };
  const advanced    = wrappedData?.advanced    || {};
  const totalMinutes= wrappedData?.totalMinutesListened || 0;
  
  const nightTopSong = wrappedData?.nightTopSong;
  const aiTopSong = wrappedData?.aiTopSong;

  // ─── AUDIO MAP & ORCHESTRATION ───────────────────────────────────────────────
  const slideAudioMap = useRef({});
  const currentUrlRef = useRef(null);

  useEffect(() => {
    // Build audio map once. Los datos demo usan ids negativos (DB-05): no hay
    // audio que reproducir para ellos, nunca una canción real ajena.
    const streamUrl = (id) => {
      const n = Number(id);
      return Number.isSafeInteger(n) && n > 0 ? `${API_BASE}/stream/${n}` : null;
    };
    const map = {};

    const s1 = topSongs[0];
    const s2 = topSongs[1];
    const s3 = topSongs[2];
    const artSong = topArtists[0]?.top_song_id;
    const marathon = advanced.marathonDay?.top_song_id;
    const skipped = advanced.mostSkipped;
    const genreSong = topSongs.find(s => s.genre === topGenres[0]?.genre) || topSongs[3] || s1;

    // Block 0: Intro
    if (s1) { map[0] = map[1] = map[2] = map[3] = { url: streamUrl(s1.id), start: 0, vol: 0.2, cover: s1.cover_url }; }
    // Block 1: Top Song 1
    if (s1) { map[4] = map[5] = map[6] = map[7] = { url: streamUrl(s1.id), start: s1.chorus_start_ms ? s1.chorus_start_ms / 1000 : 45, vol: 0.5, cover: s1.cover_url }; }
    // Block 2: Time of Day
    if (nightTopSong) { map[8] = map[9] = map[10] = { url: streamUrl(nightTopSong.id), start: 20, vol: 0.4, cover: nightTopSong.cover_url }; }
    // Block 3: Top Songs
    if (s2) { map[11] = map[12] = { url: streamUrl(s2.id), start: s2.chorus_start_ms ? s2.chorus_start_ms / 1000 : 30, vol: 0.45, cover: s2.cover_url }; }
    if (s3) { map[13] = map[14] = { url: streamUrl(s3.id), start: s3.chorus_start_ms ? s3.chorus_start_ms / 1000 : 30, vol: 0.45, cover: s3.cover_url }; }
    // Block 4: Genres
    if (genreSong) { map[15] = map[16] = map[17] = map[18] = { url: streamUrl(genreSong.id), start: 40, vol: 0.45, cover: genreSong.cover_url }; }
    // Block 5: Artists
    if (artSong) { map[19] = map[20] = map[21] = { url: streamUrl(artSong), start: 30, vol: 0.45, cover: topArtists[0]?.cover_url || s1?.cover_url }; }
    // Block 6: AI
    if (aiTopSong) { map[22] = map[23] = map[24] = { url: streamUrl(aiTopSong.id), start: 10, vol: 0.45, cover: aiTopSong.cover_url }; }
    // Block 7: Skips & Marathon
    if (skipped) { map[25] = map[26] = { url: streamUrl(skipped.id), start: 0, vol: 0.2, cover: skipped.cover_url }; } // Low vol for hated song
    if (marathon) { map[27] = { url: streamUrl(marathon), start: 25, vol: 0.45, cover: s1?.cover_url }; }
    // Block 8: Loyalty & End (Top song again)
    if (s1) { 
      const endMap = { url: streamUrl(s1.id), start: 90, vol: 0.6, cover: s1.cover_url };
      for (let i = 28; i <= 35; i++) map[i] = endMap;
    }

    for (const k of Object.keys(map)) if (!map[k] || !map[k].url) delete map[k];
    slideAudioMap.current = map;
  }, [wrappedData]); // eslint-disable-line react-hooks/exhaustive-deps

  // Handle Audio Changes on Slide
  useEffect(() => {
    if (!isStarted) return;
    
    const audioData = slideAudioMap.current[slide];
    if (audioData) {
      if (audioData.url !== currentUrlRef.current) {
        currentUrlRef.current = audioData.url;
        fadeAndPlay(audioData.url, audioData.start, audioData.vol);
      } else {
        // Just adjust volume if same song but different vol required
        if (audioRef.current && audioRef.current.volume !== audioData.vol) {
          fadeVolume(audioRef.current, audioRef.current.volume, audioData.vol, 500);
        }
      }
    } else {
      // No audio for this slide -> stop
      if (currentUrlRef.current) {
        stop();
        currentUrlRef.current = null;
      }
    }

    // Special logic for slide 26 (Irony: most skipped song stops abruptly)
    let ironyTimer = null;
    if (slide === 26 && audioRef.current) {
      ironyTimer = setTimeout(() => {
        // El componente puede haberse cerrado: audioRef.current sería null.
        if (audioRef.current) fadeVolume(audioRef.current, audioRef.current.volume, 0, 300);
      }, 3500);
    }
    
    // Special logic for final slide (Fade out completely)
    if (slide === 35 && audioRef.current) {
      fadeVolume(audioRef.current, audioRef.current.volume, 0, 3000);
    }

    // Prefetch next 3 slides
    const nextUrls = [slide+1, slide+2, slide+3]
      .map(i => slideAudioMap.current[i]?.url)
      .filter(Boolean)
      .filter((u, i, arr) => arr.indexOf(u) === i); // dedup
    prefetch(nextUrls);

    return () => { if (ironyTimer) clearTimeout(ironyTimer); };
  }, [slide, isStarted, fadeAndPlay, prefetch, stop, fadeVolume]);


  // ─── AUTO ADVANCE ────────────────────────────────────────────────────────────
  useEffect(() => {
    if (!isStarted || isPaused) return;
    const duration = (slide === 34 || slide === 9 || slide === 32) ? 8000 : 5000;
    const timer = setTimeout(() => {
      if (slide < totalSlides - 1) setSlide(s => s + 1);
    }, duration);
    return () => clearTimeout(timer);
  }, [slide, isStarted, isPaused]);

  const nextSlide = () => { if (slide < totalSlides - 1) setSlide(s => s + 1); };
  const prevSlide = () => { if (slide > 0) setSlide(s => s - 1); };
  
  const handleTouch = (e) => {
    if (!isStarted) return;
    const rect = e.currentTarget.getBoundingClientRect();
    if (e.clientX - rect.left < rect.width * 0.3) prevSlide();
    else nextSlide();
  };

  const handlePointerDown = () => setIsPaused(true);
  const handlePointerUp = () => setIsPaused(false);

  const handleStart = () => {
    setIsStarted(true);
    const audioData = slideAudioMap.current[0];
    if (audioData) {
      currentUrlRef.current = audioData.url;
      fadeAndPlay(audioData.url, audioData.start, audioData.vol);
    }
  };

  const handleClose = () => {
    stop();
    onClose();
  };

  if (!isStarted) {
    return (
      <div className="wrapped-engine-overlay">
        <audio ref={audioRef} />
        <div className="wrapped-slide-content anim-scale" style={{ justifyContent: 'center' }}>
          {isDemo && <div style={{background: '#ef4444', color: '#fff', padding: '4px 12px', borderRadius: '20px', fontWeight: 'bold', marginBottom: '20px'}}>DEMO MODE</div>}
          <h1 className="wrapped-huge-text" style={{ textAlign: 'center' }}>¿Listo para tu Resumen {year === 'all' ? 'Histórico' : year}?</h1>
          <button 
            onClick={handleStart}
            style={{ marginTop: '30px', padding: '16px 40px', fontSize: '20px', fontWeight: 'bold', borderRadius: '30px', border: 'none', background: 'var(--accent-color)', color: '#000', cursor: 'pointer', boxShadow: '0 0 20px rgba(29,185,84,0.4)' }}
          >
            Comenzar
          </button>
        </div>
      </div>
    );
  }

  // Persona Logic
  let personaName = 'El Especialista';
  let personaDesc = 'Tienes un gusto muy particular y te mantienes fiel a él.';
  if (skipStats.skipped > skipStats.completed * 2) {
    personaName = 'El Saltador Inquieto';
    personaDesc = 'Tu dedo está siempre listo en el botón de siguiente. Buscas constantemente el ritmo perfecto.';
  } else if (timeStats.topTimeOfDay === 'Madrugada') {
    personaName = 'El Búho Nocturno';
    personaDesc = 'La noche es tu hábitat. Mientras el mundo duerme, tu música cobra vida.';
  } else if ((advanced.discovery || []).filter(d => d.discovered_via && d.discovered_via !== 'manual').reduce((n, d) => n + (d.count || 0), 0) > 50) {
    personaName = 'El Explorador';
    personaDesc = 'Tu biblioteca es un pasaporte al mundo. No te limitas a lo conocido.';
  } else if (skipStats.completed > skipStats.skipped * 2) {
    personaName = 'El Oyente Dedicado';
    personaDesc = 'Respetas la obra y el arte. Cuando le das al play, es un compromiso asegurado.';
  }

  const getSlideContent = () => {
    if (!topSongs.length) return <TextSlide text="¡Aún no hay nada que mostrar!" />;

    switch (slide) {
      // 0: Intro
      case 0:  return <WelcomeSlide year={year} />;
      case 1:  return <StatSlide icon={<Clock size={48}/>} title="Tiempo juntos" value={totalMinutes.toLocaleString()} subtitle="Minutos escuchados" />;
      case 2:  return <TextSlide text={`Eso equivale a ${(totalMinutes / 1440).toFixed(1)} días enteros de tu vida.`} />;
      case 3:  return <PersonaSlide name={personaName} desc={personaDesc} />;
      // 1: Top Song 1
      case 4:  return <TextSlide text="Pero hubo una canción de la que no pudiste escapar..." />;
      case 5:  return <TopSongSlide song={topSongs[0]} rank={1} />;
      case 6:  return <TextSlide text={`La reprodujiste ${topSongs[0].play_count} veces. Eso no es casualidad.`} />;
      case 7:  return <LoopSlide record={advanced.loopRecord} />;
      // 2: Time
      case 8:  return <TimeOfDaySlide timeStats={timeStats} />;
      case 9:  return <HeatmapSlide hourly={advanced.hourly} weekday={advanced.weekday} peakHour={timeStats.peakHour} />;
      case 10: return <TextSlide text="Veamos el resto de tus favoritas..." />;
      // 3: Top Songs
      case 11: return topSongs[1] ? <TopSongSlide song={topSongs[1]} rank={2} /> : <TextSlide text="Aún procesando..." />;
      case 12: return <ListSlide title="Tus Himnos" items={topSongs.slice(0, 5).map(s => `${s.title} · ${s.artist}`)} />;
      case 13: return topSongs[2] ? <TopSongSlide song={topSongs[2]} rank={3} /> : <TextSlide text="..." />;
      case 14: return <StreakSlide streak={advanced.streak} counts={advanced.counts} />;
      // 4: Genres
      case 15: return <GenreBreakdownSlide topGenres={topGenres} />;
      case 16: return <SeasonalGenreSlide seasonal={advanced.seasonal} />;
      case 17: return <MonthlyVibeSlide monthly={advanced.monthlyVibe} minutes={advanced.monthlyMinutes} />;
      case 18: return <TextSlide text="Algunos artistas se convirtieron en constantes..." />;
      // 5: Artists
      case 19: return <ArtistRevealSlide artist={topArtists[0]} />;
      case 20: return <ListSlide title="Tus Reyes" items={topArtists.slice(0, 5).map(a => `${a.artist} (${Math.floor(a.total_time_ms/60000)} min)`)} />;
      case 21: return <ObsessionSlide topArtist={topArtists[0]} loopRecord={advanced.loopRecord} topSong={topSongs[0]} />;
      // 6: AI
      case 22: return <TextSlide text="La IA también te abrió puertas este año..." />;
      case 23: return <DiscoverySlide discovery={advanced.discovery} />;
      case 24: return <AITopSlide aiTopSong={aiTopSong} />;
      // 7: Skips & Marathon
      case 25: return <SkipStatSlide skipStats={skipStats} />;
      case 26: return <MostSkippedSlide skipped={advanced.mostSkipped} />;
      case 27: return <MarathonSlide marathon={advanced.marathonDay} />;
      // 8: Loyalty & End
      case 28: return <LoyaltySlide skipStats={skipStats} totalMinutes={totalMinutes} />;
      case 29: return <DiversitySlide counts={advanced.counts} topArtists={topArtists} topGenres={topGenres} totalMinutes={totalMinutes} />;
      case 30: return <TextSlide text="Tu top 5 definitivo..." />;
      case 31: return <HallOfFameSlide topSongs={topSongs} />;
      case 32: return <PersonaFinalSlide name={personaName} desc={personaDesc} topGenres={topGenres} />;
      case 33: return <SummarySlide data={wrappedData} year={year} personaName={personaName} />;
      case 34: return <SummarySlide data={wrappedData} year={year} personaName={personaName} />; // Keep summary on screen longer
      case 35: return <FinSlide />;
      
      default: return <TextSlide text="Procesando..." />;
    }
  };

  const currentCover = slideAudioMap.current[slide]?.cover;

  return (
    <div 
      className="wrapped-engine-overlay" 
      style={{
        backgroundImage: currentCover ? `url(${currentCover})` : 'none',
        backgroundSize: 'cover',
        backgroundPosition: 'center',
        backgroundBlendMode: 'overlay',
        backgroundColor: 'rgba(0, 0, 0, 0.85)'
      }}
      onPointerDown={handlePointerDown}
      onPointerUp={handlePointerUp}
      onPointerLeave={handlePointerUp}
    >
      <audio ref={audioRef} />
      <button className="wrapped-close-btn" onClick={handleClose}>✕</button>

      {/* Progress Bars */}
      <div className="wrapped-progress-container">
        {Array.from({ length: totalSlides }).map((_, i) => {
          const duration = (i === 34 || i === 9 || i === 32) ? 8000 : 5000;
          return (
            <div key={i} className="wrapped-progress-bar">
              <div
                className="wrapped-progress-fill"
                style={{
                  width: slide > i ? '100%' : '0%',
                  animation: slide === i ? `fillBar ${duration}ms linear forwards` : 'none',
                  animationPlayState: isPaused ? 'paused' : 'running'
                }}
              />
            </div>
          );
        })}
      </div>

      <div className="wrapped-touch-area" onClick={handleTouch}>
        <div style={{ filter: currentCover ? 'drop-shadow(0 0 20px rgba(0,0,0,0.8))' : 'none', height: '100%', display: 'flex', flexDirection: 'column' }}>
          {getSlideContent()}
        </div>
      </div>
    </div>
  );
}

// ═══════════════════════════════════════════════════════════════════════════════
// SLIDE COMPONENTS
// ═══════════════════════════════════════════════════════════════════════════════

function WelcomeSlide({ year }) {
  return (
    <div className="wrapped-slide-content anim-scale">
      <h1 className="wrapped-huge-text" style={{ background: 'linear-gradient(45deg, var(--accent-color), #ff77ff)', WebkitBackgroundClip: 'text', color: 'transparent' }}>
        Tu Resumen {year === 'all' ? 'Histórico' : year}
      </h1>
      <p className="wrapped-sub-text">El momento de la verdad ha llegado.</p>
    </div>
  );
}

function StatSlide({ title, value, subtitle, icon }) {
  return (
    <div className="wrapped-slide-content anim-slide-up">
      <div style={{ color: 'var(--accent-color)', marginBottom: '20px' }}>{icon}</div>
      <h2 style={{ fontSize: 'clamp(18px,5vw,24px)', opacity: 0.8 }}>{title}</h2>
      <h1 style={{ fontSize: 'clamp(40px,10vw,64px)', fontWeight: 900, margin: '10px 0', color: 'var(--accent-color)', textAlign: 'center' }}>{value}</h1>
      {subtitle && <p style={{ fontSize: 'clamp(14px,4vw,18px)', opacity: 0.6 }}>{subtitle}</p>}
    </div>
  );
}

function TextSlide({ text }) {
  return (
    <div className="wrapped-slide-content anim-fade-in">
      <h1 style={{ fontSize: 'clamp(28px,8vw,48px)', fontWeight: 800, lineHeight: 1.2, textAlign: 'center', padding: '0 20px' }}>{text}</h1>
    </div>
  );
}

function TopSongSlide({ song, rank }) {
  return (
    <div className="wrapped-slide-content anim-pop">
      <h2 style={{ fontSize: 'clamp(18px,5vw,24px)', opacity: 0.8, marginBottom: '20px', letterSpacing: '3px', textTransform: 'uppercase' }}>Tu Canción #{rank}</h2>
      <img src={song?.cover_url || '/placeholder.jpg'} style={{ width: 'min(60vw,250px)', height: 'min(60vw,250px)', borderRadius: '12px', boxShadow: '0 20px 50px rgba(0,0,0,0.6)', objectFit: 'cover' }} alt="Cover" />
      <h1 style={{ fontSize: 'clamp(26px,7vw,42px)', fontWeight: 900, marginTop: '20px', textAlign: 'center' }}>{song?.title}</h1>
      <h2 style={{ fontSize: 'clamp(16px,5vw,24px)', opacity: 0.7, textAlign: 'center' }}>{song?.artist}</h2>
      {song?.play_count ? <p style={{ fontSize: '14px', opacity: 0.6, marginTop: '6px' }}>{song.play_count} reproducciones · {Math.floor((song.total_time_ms || 0) / 60000)} min</p> : null}
    </div>
  );
}

function ListSlide({ title, items }) {
  return (
    <div className="wrapped-slide-content anim-slide-up" style={{ alignItems: 'flex-start', padding: '0 20px', width: '100%', maxWidth: '500px' }}>
      <h1 style={{ fontSize: 'clamp(24px,6vw,36px)', fontWeight: 900, marginBottom: '20px', color: 'var(--accent-color)' }}>{title}</h1>
      <div style={{ display: 'flex', flexDirection: 'column', gap: '14px', width: '100%' }}>
        {items.map((item, i) => (
          <div key={i} style={{ display: 'flex', alignItems: 'center', gap: '16px', borderBottom: '1px solid rgba(255,255,255,0.1)', paddingBottom: '10px' }}>
            <span style={{ fontSize: 'clamp(18px,5vw,22px)', fontWeight: 900, width: '30px', color: 'var(--accent-color)' }}>#{i + 1}</span>
            <span style={{ fontSize: 'clamp(15px,5vw,20px)', fontWeight: 600, whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' }}>{item}</span>
          </div>
        ))}
      </div>
    </div>
  );
}

function LoopSlide({ record }) {
  if (!record) return <TextSlide text="No hay récords de bucles este año." />;
  return (
    <div className="wrapped-slide-content anim-pop">
      <Repeat size={48} color="#ff77ff" style={{ marginBottom: '20px' }} />
      <h2 style={{ fontSize: 'clamp(18px,5vw,24px)', opacity: 0.8, textAlign: 'center' }}>Y en un momento dado...</h2>
      <h1 style={{ fontSize: 'clamp(24px,6vw,32px)', fontWeight: 900, marginTop: '20px', textAlign: 'center', color: '#ff77ff' }}>Llegaste a escucharla {record.consecutive_plays} veces seguidas.</h1>
    </div>
  );
}

function TimeOfDaySlide({ timeStats }) {
  return (
    <div className="wrapped-slide-content anim-fade-in">
      <h2 style={{ fontSize: 'clamp(14px,4vw,20px)', opacity: 0.8, textTransform: 'uppercase', letterSpacing: '2px', textAlign: 'center' }}>Tu ecosistema natural</h2>
      <h1 style={{ fontSize: 'clamp(40px,12vw,70px)', fontWeight: 900, margin: '20px 0', color: 'var(--accent-color)', textShadow: '0 0 40px rgba(29,185,84,0.5)', textTransform: 'uppercase' }}>
        {timeStats.topTimeOfDay}
      </h1>
      <p style={{ fontSize: 'clamp(16px,5vw,22px)', opacity: 0.9, maxWidth: '400px', textAlign: 'center' }}>
        Con <strong>{timeStats.maxTimePlays} reproducciones</strong>, la música acompaña el ritmo de tus {timeStats.topTimeOfDay.toLowerCase()}s.
      </p>
    </div>
  );
}

const MONTHS = ['Ene', 'Feb', 'Mar', 'Abr', 'May', 'Jun', 'Jul', 'Ago', 'Sep', 'Oct', 'Nov', 'Dic'];
const MONTHS_LONG = ['enero', 'febrero', 'marzo', 'abril', 'mayo', 'junio', 'julio', 'agosto', 'septiembre', 'octubre', 'noviembre', 'diciembre'];
const DAYS_ES = ['Lun', 'Mar', 'Mié', 'Jue', 'Vie', 'Sáb', 'Dom'];
const fmtHour = (h) => `${String(h).padStart(2, '0')}:00`;
const fmtDay = (iso) => {
  const m = /^(\d{4})-(\d{2})-(\d{2})/.exec(iso || '');
  return m ? `${Number(m[3])} de ${MONTHS_LONG[Number(m[2]) - 1]} de ${m[1]}` : iso;
};

function HeatmapSlide({ hourly, weekday, peakHour }) {
  if (!hourly || !hourly.some(h => h.plays)) return <TextSlide text="Buscando patrones horarios..." />;
  const maxH = Math.max(...hourly.map(h => h.plays), 1);
  const ph = Number.isInteger(peakHour) ? peakHour : hourly.reduce((best, h, i) => (h.plays > hourly[best].plays ? i : best), 0);
  const wd = weekday || [];
  const maxD = Math.max(...wd.map(d => d.plays), 1);
  const topDay = wd.length ? wd.reduce((best, d, i) => (d.plays > wd[best].plays ? i : best), 0) : null;
  return (
    <div className="wrapped-slide-content anim-scale" style={{ width: '100%', maxWidth: '520px', padding: '0 20px' }}>
      <h2 style={{ fontSize: '14px', opacity: 0.8, letterSpacing: '2px', textTransform: 'uppercase', textAlign: 'center' }}>Tu hora punta</h2>
      <h1 style={{ fontSize: 'clamp(40px,12vw,64px)', fontWeight: 900, margin: '8px 0 18px', color: '#f59e0b', textAlign: 'center' }}>{fmtHour(ph)}</h1>
      <div style={{ display: 'flex', alignItems: 'flex-end', gap: '3px', height: '110px', width: '100%' }} aria-label="Reproducciones por hora">
        {hourly.map((h, i) => (
          <div key={i} style={{ flex: 1, height: `${Math.max(4, (h.plays / maxH) * 100)}%`, background: i === ph ? '#f59e0b' : 'rgba(245,158,11,0.35)', borderRadius: '3px 3px 0 0' }} />
        ))}
      </div>
      <div style={{ display: 'flex', justifyContent: 'space-between', fontSize: '11px', opacity: 0.6, marginTop: '4px', width: '100%' }}>
        <span>0h</span><span>6h</span><span>12h</span><span>18h</span><span>23h</span>
      </div>
      {wd.length === 7 && (
        <>
          <div style={{ display: 'flex', alignItems: 'flex-end', gap: '8px', height: '60px', width: '100%', marginTop: '22px' }}>
            {wd.map((d, i) => (
              <div key={i} style={{ flex: 1, height: `${Math.max(6, (d.plays / maxD) * 100)}%`, background: i === topDay ? 'var(--accent-color)' : 'rgba(255,255,255,0.2)', borderRadius: '4px' }} />
            ))}
          </div>
          <div style={{ display: 'flex', gap: '8px', fontSize: '11px', opacity: 0.7, marginTop: '4px', width: '100%' }}>
            {DAYS_ES.map(d => <span key={d} style={{ flex: 1, textAlign: 'center' }}>{d}</span>)}
          </div>
          <p style={{ textAlign: 'center', opacity: 0.85, marginTop: '14px', fontSize: '15px' }}>Tu día favorito: <strong>{DAYS_ES[topDay]}</strong>.</p>
        </>
      )}
    </div>
  );
}

function StreakSlide({ streak, counts }) {
  if (!streak || !streak.longest) return <TextSlide text="La constancia también cuenta..." />;
  return (
    <div className="wrapped-slide-content anim-pop">
      <Flame size={56} color="#f59e0b" style={{ marginBottom: '16px' }} />
      <h2 style={{ fontSize: '16px', opacity: 0.8, letterSpacing: '2px', textTransform: 'uppercase', textAlign: 'center' }}>Tu mejor racha</h2>
      <h1 style={{ fontSize: 'clamp(48px,14vw,88px)', fontWeight: 900, margin: '10px 0', color: '#f59e0b', textAlign: 'center' }}>
        {streak.longest} {streak.longest === 1 ? 'día' : 'días'}
      </h1>
      <p style={{ fontSize: '18px', opacity: 0.85, textAlign: 'center', maxWidth: '420px' }}>
        escuchando música sin faltar ni uno{streak.endDay ? `, hasta el ${fmtDay(streak.endDay)}` : ''}.
        {counts?.activeDays ? ` En total, ${counts.activeDays} días con música.` : ''}
      </p>
    </div>
  );
}

function GenreBreakdownSlide({ topGenres }) {
  const shown = topGenres.slice(0, 5);
  const maxMs = shown[0]?.total_time_ms || 1;
  const colors = ['var(--accent-color)', '#ff77ff', '#4a9ff5', '#f59e0b', '#ef4444'];
  return (
    <div className="wrapped-slide-content anim-slide-up" style={{ alignItems: 'flex-start', padding: '0 24px', width: '100%', maxWidth: '500px' }}>
      <div style={{ display: 'flex', alignItems: 'center', gap: '10px', marginBottom: '24px' }}>
        <BarChart2 size={28} color="var(--accent-color)" />
        <h1 style={{ fontSize: 'clamp(22px,6vw,32px)', fontWeight: 900, margin: 0 }}>Tu ADN Musical</h1>
      </div>
      <div style={{ display: 'flex', flexDirection: 'column', gap: '14px', width: '100%' }}>
        {shown.map((g, i) => {
          const pct = Math.round((g.total_time_ms / maxMs) * 100);
          return (
            <div key={i}>
              <div style={{ display: 'flex', justifyContent: 'space-between', marginBottom: '4px' }}>
                <span style={{ fontWeight: 700, fontSize: 'clamp(14px,4vw,18px)', color: colors[i] }}>{g.genre}</span>
                <span style={{ opacity: 0.6, fontSize: '13px' }}>{Math.floor(g.total_time_ms / 60000)} min</span>
              </div>
              <div style={{ height: '8px', background: 'rgba(255,255,255,0.1)', borderRadius: '4px', overflow: 'hidden' }}>
                <div style={{ height: '100%', width: `${pct}%`, background: colors[i], borderRadius: '4px' }} />
              </div>
            </div>
          );
        })}
      </div>
    </div>
  );
}

function SeasonalGenreSlide({ seasonal }) {
  if (!seasonal || !seasonal.length) return <TextSlide text="Tu música evolucionó a lo largo del año..." />;
  const icons = { 'Primavera': '🌸', 'Verano': '☀️', 'Otoño': '🍂', 'Invierno': '❄️' };
  return (
    <div className="wrapped-slide-content anim-fade-in" style={{ width: '100%', maxWidth: '500px' }}>
      <h1 style={{ fontSize: 'clamp(24px,7vw,32px)', fontWeight: 900, marginBottom: '30px', textAlign: 'center' }}>Cambio de Estaciones</h1>
      <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: '16px' }}>
        {seasonal.map((s, i) => (
          <div key={i} style={{ background: 'rgba(255,255,255,0.05)', padding: '20px', borderRadius: '16px', textAlign: 'center' }}>
            <div style={{ fontSize: '32px', marginBottom: '10px' }}>{icons[s.season]}</div>
            <div style={{ fontSize: '14px', opacity: 0.6, textTransform: 'uppercase' }}>{s.season}</div>
            <div style={{ fontSize: '18px', fontWeight: 900, color: '#fff', marginTop: '4px' }}>{s.dominant_genre}</div>
          </div>
        ))}
      </div>
    </div>
  );
}

function MonthlyVibeSlide({ monthly, minutes }) {
  const byMonth = {};
  (monthly || []).forEach(m => { byMonth[Number(m.month)] = m.dominant_genre; });
  const mins = {};
  (minutes || []).forEach(m => { mins[Number(m.month)] = m.minutes || 0; });
  const maxMin = Math.max(...Object.values(mins), 1);
  const present = Object.keys({ ...byMonth, ...mins }).map(Number).sort((a, b) => a - b);
  if (!present.length) return <TextSlide text="Tu año tuvo muchas bandas sonoras..." />;
  const best = present.reduce((b, m) => ((mins[m] || 0) > (mins[b] || 0) ? m : b), present[0]);
  return (
    <div className="wrapped-slide-content anim-slide-up" style={{ width: '100%', maxWidth: '460px', padding: '0 20px' }}>
      <div style={{ display: 'flex', alignItems: 'center', gap: '10px', marginBottom: '8px' }}>
        <Calendar size={28} color="#f59e0b" />
        <h1 style={{ fontSize: 'clamp(22px,6vw,30px)', fontWeight: 900, color: '#f59e0b', margin: 0 }}>Tu Vibe por Mes</h1>
      </div>
      <p style={{ opacity: 0.75, fontSize: '14px', marginBottom: '14px' }}>Tu mes más intenso fue {MONTHS_LONG[best - 1]}.</p>
      <div style={{ display: 'flex', flexDirection: 'column', gap: '6px', width: '100%' }}>
        {present.map(m => (
          <div key={m} style={{ display: 'flex', alignItems: 'center', gap: '8px', fontSize: '13px' }}>
            <span style={{ width: '30px', opacity: 0.7 }}>{MONTHS[m - 1]}</span>
            <div style={{ flex: 1, height: '14px', background: 'rgba(255,255,255,0.08)', borderRadius: '7px', overflow: 'hidden' }}>
              <div style={{ height: '100%', width: `${Math.max(3, ((mins[m] || 0) / maxMin) * 100)}%`, background: m === best ? '#f59e0b' : 'rgba(245,158,11,0.45)' }} />
            </div>
            <span style={{ width: '38%', textAlign: 'right', fontWeight: 700, whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' }}>{byMonth[m] || '—'}</span>
          </div>
        ))}
      </div>
    </div>
  );
}

function ArtistRevealSlide({ artist }) {
  if (!artist) return <TextSlide text="No hay artistas suficientes" />;
  return (
    <div className="wrapped-slide-content anim-pop">
      <Star size={48} color="#ff77ff" style={{ marginBottom: '20px' }} />
      <h2 style={{ fontSize: '16px', opacity: 0.8, letterSpacing: '2px', textTransform: 'uppercase' }}>Tu Artista Número 1</h2>
      <h1 style={{ fontSize: 'clamp(36px,10vw,70px)', fontWeight: 900, margin: '20px 0', color: '#ff77ff', textAlign: 'center', textShadow: '0 0 30px rgba(255,119,255,0.4)' }}>
        {artist.artist}
      </h1>
      <p style={{ fontSize: '18px', opacity: 0.8 }}>Le dedicaste {(artist.total_time_ms / 3600000).toFixed(1)} horas.</p>
    </div>
  );
}

function ObsessionSlide({ topArtist, loopRecord, topSong }) {
  return (
    <div className="wrapped-slide-content anim-scale" style={{ width: '100%', maxWidth: '420px' }}>
      <div style={{ display: 'flex', alignItems: 'center', gap: '10px', marginBottom: '24px' }}>
        <Users size={28} color="#ff77ff" />
        <h2 style={{ fontSize: 'clamp(18px,5vw,26px)', fontWeight: 900, margin: 0, color: '#ff77ff' }}>Tu Obsesión</h2>
      </div>
      <div style={{ display: 'flex', flexDirection: 'column', gap: '16px', width: '100%' }}>
        {topArtist && (
          <div style={{ background: 'rgba(255,119,255,0.08)', border: '1px solid rgba(255,119,255,0.25)', borderRadius: '14px', padding: '16px 20px' }}>
            <div style={{ fontSize: '11px', opacity: 0.6, textTransform: 'uppercase', letterSpacing: '1px' }}>Artista dominante</div>
            <div style={{ fontSize: 'clamp(20px,6vw,28px)', fontWeight: 900, color: '#ff77ff', marginTop: '4px' }}>{topArtist.artist}</div>
          </div>
        )}
        {loopRecord && (
          <div style={{ background: 'rgba(29,185,84,0.08)', border: '1px solid rgba(29,185,84,0.25)', borderRadius: '14px', padding: '16px 20px' }}>
            <div style={{ fontSize: '11px', opacity: 0.6, textTransform: 'uppercase', letterSpacing: '1px' }}>En bucle consecutivo</div>
            <div style={{ fontSize: 'clamp(16px,5vw,22px)', fontWeight: 900, color: 'var(--accent-color)', marginTop: '4px' }}>{loopRecord.title}</div>
            <div style={{ fontSize: '13px', opacity: 0.7, marginTop: '4px' }}>{loopRecord.consecutive_plays} veces seguidas</div>
          </div>
        )}
        {topSong && (
          <div style={{ background: 'rgba(74,159,245,0.08)', border: '1px solid rgba(74,159,245,0.25)', borderRadius: '14px', padding: '16px 20px' }}>
            <div style={{ fontSize: '11px', opacity: 0.6, textTransform: 'uppercase', letterSpacing: '1px' }}>Más reproducida</div>
            <div style={{ fontSize: 'clamp(16px,5vw,22px)', fontWeight: 900, color: '#4a9ff5', marginTop: '4px' }}>{topSong.title}</div>
            <div style={{ fontSize: '13px', opacity: 0.7, marginTop: '4px' }}>{topSong.play_count} reproducciones</div>
          </div>
        )}
      </div>
    </div>
  );
}

function DiscoverySlide({ discovery }) {
  if (!discovery || !discovery.length) return <TextSlide text="Analizando descubrimientos..." />;
  // Cualquier origen distinto de 'manual' (gemini, lastfm, ai) cuenta como IA.
  const gemini = discovery.filter(d => d.discovered_via && d.discovered_via !== 'manual').reduce((n, d) => n + (d.count || 0), 0);
  return (
    <div className="wrapped-slide-content anim-pop">
      <CloudLightning size={48} color="#4a9ff5" style={{ marginBottom: '20px' }} />
      <h2 style={{ fontSize: '16px', opacity: 0.8, letterSpacing: '2px', textTransform: 'uppercase', textAlign: 'center' }}>Descubrimiento IA</h2>
      <h1 style={{ fontSize: 'clamp(28px,8vw,48px)', fontWeight: 900, margin: '20px 0', color: '#4a9ff5', textAlign: 'center' }}>
        La IA te trajo {gemini} canciones
      </h1>
      <p style={{ fontSize: '18px', opacity: 0.8, textAlign: 'center' }}>Nuevos horizontes musicales generados para ti.</p>
    </div>
  );
}

function AITopSlide({ aiTopSong }) {
  if (!aiTopSong) return <TextSlide text="La IA sigue aprendiendo de tus gustos..." />;
  return (
    <div className="wrapped-slide-content anim-scale">
      <div style={{ background: 'linear-gradient(45deg, #4a9ff5, #ff77ff)', padding: '6px 16px', borderRadius: '20px', fontWeight: 'bold', fontSize: '14px', marginBottom: '20px' }}>DESCUBIERTA POR IA</div>
      <img src={aiTopSong.cover_url || '/placeholder.jpg'} style={{ width: 'min(50vw,200px)', height: 'min(50vw,200px)', borderRadius: '12px', boxShadow: '0 20px 50px rgba(0,0,0,0.6)', objectFit: 'cover' }} alt="Cover" />
      <h1 style={{ fontSize: 'clamp(22px,6vw,36px)', fontWeight: 900, marginTop: '20px', textAlign: 'center' }}>{aiTopSong.title}</h1>
      <h2 style={{ fontSize: '16px', opacity: 0.7, textAlign: 'center' }}>{aiTopSong.artist}</h2>
    </div>
  );
}

function SkipStatSlide({ skipStats }) {
  const skipPercent = skipStats.total > 0 ? Math.round((skipStats.skipped / skipStats.total) * 100) : 0;
  return (
    <div className="wrapped-slide-content anim-pop">
      <h2 style={{ fontSize: '16px', opacity: 0.8, letterSpacing: '2px', textTransform: 'uppercase', textAlign: 'center' }}>Tasa de Salto</h2>
      <div style={{ padding: '20px', border: '5px solid #ff77ff', borderRadius: '50%', width: '160px', height: '160px', display: 'flex', alignItems: 'center', justifyContent: 'center', margin: '30px auto', boxShadow: '0 0 60px rgba(255,119,255,0.4)', background: 'rgba(0,0,0,0.5)' }}>
        <span style={{ fontSize: '48px', fontWeight: 900, textShadow: '0 0 10px #ff77ff' }}>{skipPercent}%</span>
      </div>
      <p style={{ fontSize: '18px', opacity: 0.9, maxWidth: '400px', textAlign: 'center' }}>
        Saltaste el {skipPercent}% de las canciones. {skipPercent > 40 ? 'Impaciente, buscando siempre oro.' : 'Fiel al tracklist. Te quedas hasta que la nota muere.'}
      </p>
    </div>
  );
}

function MostSkippedSlide({ skipped }) {
  if (!skipped) return <TextSlide text="No hay suficientes datos de skips." />;
  return (
    <div className="wrapped-slide-content anim-fade-in">
      <h2 style={{ fontSize: '16px', opacity: 0.8, letterSpacing: '2px', textTransform: 'uppercase', textAlign: 'center', color: '#ef4444' }}>La más odiada</h2>
      <img src={skipped.cover_url || '/placeholder.jpg'} style={{ width: 'min(40vw,150px)', height: 'min(40vw,150px)', borderRadius: '12px', marginTop: '20px', filter: 'grayscale(100%) blur(2px)' }} alt="Cover" />
      <h1 style={{ fontSize: 'clamp(20px,6vw,28px)', fontWeight: 900, marginTop: '20px', textAlign: 'center' }}>{skipped.title}</h1>
      <p style={{ fontSize: '16px', opacity: 0.8, textAlign: 'center', marginTop: '10px' }}>La saltabas en promedio a los {Math.round(skipped.avg_skip_at_seconds)} segundos.</p>
    </div>
  );
}

function MarathonSlide({ marathon }) {
  if (!marathon) return <TextSlide text="Aún no hay maratones." />;
  return (
    <div className="wrapped-slide-content anim-scale">
      <Flame size={64} color="#f59e0b" style={{ marginBottom: '20px' }} />
      <h2 style={{ fontSize: '16px', opacity: 0.8, letterSpacing: '2px', textTransform: 'uppercase', textAlign: 'center' }}>El Día del Maratón</h2>
      <h1 style={{ fontSize: 'clamp(32px,8vw,56px)', fontWeight: 900, margin: '20px 0', color: '#f59e0b', textAlign: 'center' }}>
        {fmtDay(marathon.day)}
      </h1>
      <p style={{ fontSize: '18px', opacity: 0.9, textAlign: 'center' }}>Ese día escuchaste {Math.floor(marathon.total_minutes / 60)} h {Math.round(marathon.total_minutes % 60)} min de música{marathon.distinct_songs ? `, con ${marathon.distinct_songs} canciones distintas` : ''}.</p>
    </div>
  );
}

function LoyaltySlide({ skipStats, totalMinutes }) {
  const avgSecs = skipStats.total > 0 ? Math.round(((totalMinutes * 60000) / skipStats.total) / 1000) : 0;
  let level = 'Alto', color = 'var(--accent-color)', emoji = '💚';
  if (avgSecs < 60) { level = 'Muy bajo'; color = '#ef4444'; emoji = '⚡'; }
  else if (avgSecs < 120) { level = 'Bajo'; color = '#f59e0b'; emoji = '🟡'; }
  else if (avgSecs < 180) { level = 'Medio'; color = '#4a9ff5'; emoji = '💙'; }

  return (
    <div className="wrapped-slide-content anim-pop">
      <Repeat size={32} color={color} style={{ marginBottom: '10px' }} />
      <h2 style={{ fontSize: '16px', fontWeight: 900, color }}>Tu Nivel de Lealtad</h2>
      <div style={{ fontSize: '64px', margin: '10px 0' }}>{emoji}</div>
      <h1 style={{ fontSize: 'clamp(36px,10vw,60px)', fontWeight: 900, color, textShadow: `0 0 30px ${color}66` }}>{level}</h1>
      <p style={{ fontSize: '18px', opacity: 0.85, textAlign: 'center', marginTop: '12px' }}>
        Aguantas en promedio <strong>{avgSecs} segundos</strong> por canción.
      </p>
    </div>
  );
}

function DiversitySlide({ counts, topArtists, topGenres, totalMinutes }) {
  const movies = Math.round(totalMinutes / 100);
  const rows = [
    ['🎤', 'Artistas distintos', counts?.artists ?? `${topArtists.length}+`],
    ['🎵', 'Canciones distintas', counts?.songs],
    ['🎸', 'Géneros explorados', counts?.genres ?? topGenres.length],
    ['✨', 'Artistas nuevos descubiertos', counts?.newArtists],
    ['🎬', 'Equivale a ver', `${movies.toLocaleString()} películas`],
  ].filter(r => r[2] !== undefined && r[2] !== null);
  return (
    <div className="wrapped-slide-content anim-fade-in" style={{ width: '100%', maxWidth: '420px', padding: '0 20px' }}>
      <div style={{ display: 'flex', alignItems: 'center', gap: '10px', marginBottom: '20px' }}>
        <TrendingUp size={32} color="#f59e0b" />
        <h2 style={{ fontSize: '22px', fontWeight: 900, color: '#f59e0b' }}>Datos curiosos</h2>
      </div>
      <div style={{ display: 'flex', flexDirection: 'column', gap: '12px', width: '100%' }}>
        {rows.map(([icon, label, value]) => (
          <div key={label} style={{ display: 'flex', alignItems: 'center', gap: '16px', background: 'rgba(255,255,255,0.05)', borderRadius: '12px', padding: '12px 16px' }}>
            <span style={{ fontSize: '28px' }}>{icon}</span>
            <div><div style={{ fontSize: '12px', opacity: 0.6, textTransform: 'uppercase' }}>{label}</div><div style={{ fontSize: '20px', fontWeight: 900 }}>{typeof value === 'number' ? value.toLocaleString() : value}</div></div>
          </div>
        ))}
      </div>
    </div>
  );
}

function HallOfFameSlide({ topSongs }) {
  const songs = topSongs.slice(0, 5);
  return (
    <div className="wrapped-slide-content anim-slide-up" style={{ width: '100%', maxWidth: '600px' }}>
      <h1 style={{ fontSize: 'clamp(24px,7vw,32px)', fontWeight: 900, marginBottom: '30px', textAlign: 'center' }}>Tu Hall of Fame</h1>
      <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(100px, 1fr))', gap: '12px', width: '100%' }}>
        {songs.map((s, i) => (
          <div key={i} style={{ textAlign: 'center' }}>
            <img src={s.cover_url || '/placeholder.jpg'} style={{ width: '100%', aspectRatio: '1', borderRadius: '8px', objectFit: 'cover', boxShadow: '0 10px 20px rgba(0,0,0,0.5)' }} alt="Cover" />
            <div style={{ fontSize: '14px', fontWeight: 'bold', marginTop: '8px' }}>#{i+1}</div>
            <div style={{ fontSize: '12px', fontWeight: 600, whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' }}>{s.title}</div>
            <div style={{ fontSize: '11px', opacity: 0.6, whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' }}>{s.artist}</div>
          </div>
        ))}
      </div>
    </div>
  );
}

function PersonaSlide({ name, desc }) {
  return (
    <div className="wrapped-slide-content anim-scale">
      <div style={{ padding: '20px', background: 'var(--accent-color)', borderRadius: '50%', color: '#000', marginBottom: '20px' }}>
        <Headphones size={48} />
      </div>
      <h2 style={{ fontSize: '16px', opacity: 0.8, textTransform: 'uppercase', letterSpacing: '2px' }}>Tu Identidad Sonora</h2>
      <h1 style={{ fontSize: 'clamp(32px,9vw,64px)', fontWeight: 900, margin: '10px 0', color: '#ff77ff', textTransform: 'uppercase', textAlign: 'center' }}>{name}</h1>
      <p style={{ fontSize: '18px', opacity: 0.9, maxWidth: '500px', textAlign: 'center', marginTop: '20px' }}>{desc}</p>
    </div>
  );
}

function PersonaFinalSlide({ name, desc, topGenres }) {
  return (
    <div className="wrapped-slide-content anim-pop">
      <Heart size={48} color="#ff77ff" style={{ marginBottom: '20px' }} />
      <h1 style={{ fontSize: 'clamp(32px,9vw,56px)', fontWeight: 900, color: '#ff77ff', textAlign: 'center' }}>{name}</h1>
      <p style={{ fontSize: '18px', opacity: 0.9, maxWidth: '500px', textAlign: 'center', marginTop: '10px' }}>{desc}</p>
      <div style={{ marginTop: '30px', display: 'flex', gap: '10px', flexWrap: 'wrap', justifyContent: 'center' }}>
        {topGenres.slice(0, 3).map((g, i) => (
          <span key={i} style={{ background: 'rgba(255,255,255,0.1)', padding: '6px 16px', borderRadius: '20px', fontSize: '14px', fontWeight: 'bold' }}>{g.genre}</span>
        ))}
      </div>
    </div>
  );
}

function SummarySlide({ data, year, personaName }) {
  return (
    <div className="wrapped-slide-content anim-fade-in" style={{ padding: 'clamp(20px,5vw,40px)', background: 'linear-gradient(135deg,#1A0B2E,#111827)', borderRadius: '24px', boxShadow: '0 0 100px rgba(0,0,0,0.8)', border: '2px solid rgba(255,119,255,0.2)', width: 'min(90vw,800px)', overflowY: 'auto', maxHeight: '90vh' }}>
      <h2 style={{ fontSize: 'clamp(24px,7vw,32px)', fontWeight: 900, textAlign: 'center', marginBottom: '10px', color: '#fff', textTransform: 'uppercase' }}>Resumen {year === 'all' ? 'Histórico' : year}</h2>
      <div style={{ textAlign: 'center', color: '#ff77ff', fontWeight: 'bold', letterSpacing: 'clamp(1px,1vw,3px)', marginBottom: '30px', fontSize: 'clamp(14px,4vw,18px)', textTransform: 'uppercase' }}>{personaName}</div>

      <div style={{ display: 'flex', flexWrap: 'wrap', gap: '20px', width: '100%', justifyContent: 'center' }}>
        <div style={{ flex: '1 1 200px', minWidth: 0 }}>
          <h3 style={{ color: 'var(--accent-color)', fontSize: '14px', textTransform: 'uppercase', borderBottom: '1px solid rgba(29,185,84,0.3)', paddingBottom: '8px' }}>Top Artistas</h3>
          <div style={{ marginTop: '16px' }}>
            {data.topArtists?.slice(0, 5).map((a, i) => (
              <div key={i} style={{ fontSize: 'clamp(14px,4vw,18px)', fontWeight: i === 0 ? 900 : 600, margin: '14px 0', whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis', color: i === 0 ? '#fff' : '#ccc' }}>{i + 1}. {a.artist}</div>
            ))}
          </div>
        </div>
        <div style={{ flex: '1 1 200px', minWidth: 0 }}>
          <h3 style={{ color: '#ff77ff', fontSize: '14px', textTransform: 'uppercase', borderBottom: '1px solid rgba(255,119,255,0.3)', paddingBottom: '8px' }}>Top Canciones</h3>
          <div style={{ marginTop: '16px' }}>
            {data.topSongs?.slice(0, 5).map((s, i) => (
              <div key={i} style={{ fontSize: 'clamp(14px,4vw,18px)', fontWeight: i === 0 ? 900 : 600, margin: '14px 0', whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis', color: i === 0 ? '#fff' : '#ccc' }}>{i + 1}. {s.title}</div>
            ))}
          </div>
        </div>
      </div>

      <div style={{ marginTop: '30px', paddingTop: '20px', borderTop: '1px solid rgba(255,255,255,0.1)', display: 'flex', flexWrap: 'wrap', gap: '20px', justifyContent: 'center', textAlign: 'center' }}>
        <div style={{ flex: '1 1 120px' }}>
          <h3 style={{ color: 'var(--text-secondary)', fontSize: '12px', textTransform: 'uppercase', letterSpacing: '1px' }}>Minutos escuchados</h3>
          <div style={{ fontSize: 'clamp(24px,8vw,36px)', fontWeight: 900, color: '#fff' }}>{data.totalMinutesListened?.toLocaleString()}</div>
        </div>
        <div style={{ flex: '1 1 120px' }}>
          <h3 style={{ color: 'var(--text-secondary)', fontSize: '12px', textTransform: 'uppercase', letterSpacing: '1px' }}>Franja dominante</h3>
          <div style={{ fontSize: 'clamp(24px,8vw,36px)', fontWeight: 900, color: 'var(--accent-color)' }}>{data.timeStats?.topTimeOfDay.toUpperCase()}</div>
        </div>
        <div style={{ flex: '1 1 120px' }}>
          <h3 style={{ color: 'var(--text-secondary)', fontSize: '12px', textTransform: 'uppercase', letterSpacing: '1px' }}>Género rey</h3>
          <div style={{ fontSize: 'clamp(20px,6vw,28px)', fontWeight: 900, color: '#ff77ff' }}>{data.topGenres?.[0]?.genre || '—'}</div>
        </div>
      </div>
    </div>
  );
}

function FinSlide() {
  return (
    <div className="wrapped-slide-content anim-fade-in">
      <h1 style={{ fontSize: 'clamp(32px,8vw,56px)', fontWeight: 900, textAlign: 'center', color: 'var(--text-secondary)' }}>Gracias por escuchar.</h1>
      <h2 style={{ fontSize: '20px', opacity: 0.6, marginTop: '20px' }}>Hasta el próximo año.</h2>
    </div>
  );
}
