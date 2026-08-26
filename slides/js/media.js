// The in-slide video player: native <video> with the same two-finger
// trackpad scrub as CTH Clips, honoring a clip's in/out bounds so a slide
// can carry exactly one moment of film. Click toggles play; the strip under
// the picture seeks; , . step frames while presenting.

import { fmtClock } from './ui.js';

const players = new Set();

export function mountVideo(slotEl, spec) {
  const { url, title } = spec;
  const IN = spec.in || 0;
  const OUT = spec.out || 0;
  slotEl.classList.add('pv');
  slotEl.innerHTML = `
    <video preload="metadata" playsinline src="${url.replace(/"/g, '&quot;')}"></video>
    <div class="pv-bar">
      <button class="pv-play" title="Play / Pause">
        <svg viewBox="0 0 24 24" fill="currentColor"><path d="M7 4.5v15l13-7.5z"/></svg>
      </button>
      <div class="pv-strip"><div class="pv-fill"></div></div>
      <span class="pv-clock">0:00</span>
      ${title ? `<span class="pv-title">${title.replace(/</g, '&lt;')}</span>` : ''}
    </div>`;
  const v = slotEl.querySelector('video');
  const playBtn = slotEl.querySelector('.pv-play');
  const strip = slotEl.querySelector('.pv-strip');
  const fill = slotEl.querySelector('.pv-fill');
  const clock = slotEl.querySelector('.pv-clock');

  const start = () => IN;
  const end = () => (OUT > IN ? OUT : (v.duration || 0));
  const span = () => Math.max(0.01, end() - start());

  v.addEventListener('loadedmetadata', () => { if (IN) v.currentTime = IN; paint(); });
  const paint = () => {
    fill.style.width = `${Math.max(0, Math.min(1, (v.currentTime - start()) / span())) * 100}%`;
    clock.textContent = fmtClock(Math.max(0, v.currentTime - start()));
    playBtn.classList.toggle('playing', !v.paused);
  };
  v.addEventListener('timeupdate', () => {
    if (OUT > IN && v.currentTime >= OUT - 0.02 && !v.paused) v.pause();
    paint();
  });
  v.addEventListener('play', () => {
    if (OUT > IN && (v.currentTime >= OUT - 0.05 || v.currentTime < IN - 0.5)) v.currentTime = IN;
  });
  v.addEventListener('pause', paint);

  const toggle = () => { if (v.paused) void v.play(); else v.pause(); };
  v.addEventListener('click', (e) => { e.stopPropagation(); toggle(); });
  playBtn.addEventListener('click', (e) => { e.stopPropagation(); toggle(); });

  const seekTo = (frac) => { v.currentTime = start() + Math.max(0, Math.min(1, frac)) * span(); paint(); };
  strip.addEventListener('pointerdown', (e) => {
    e.stopPropagation();
    const r = strip.getBoundingClientRect();
    const move = (ev) => seekTo((ev.clientX - r.left) / r.width);
    move(e);
    const up = () => { window.removeEventListener('pointermove', move); window.removeEventListener('pointerup', up); };
    window.addEventListener('pointermove', move);
    window.addEventListener('pointerup', up);
  });

  // The trackpad scrub: horizontal two-finger motion over the video drags
  // the playhead, exactly like Clips and Film Room.
  slotEl.addEventListener('wheel', (e) => {
    if (Math.abs(e.deltaX) <= Math.abs(e.deltaY)) return;
    e.preventDefault();
    e.stopPropagation();
    if (!v.paused) v.pause();
    v.currentTime = Math.max(start(), Math.min(end(), v.currentTime + e.deltaX * 0.012));
    paint();
  }, { passive: false });

  const player = {
    el: slotEl,
    video: v,
    frameStep: (dir) => { v.pause(); v.currentTime = Math.max(start(), Math.min(end(), v.currentTime + dir / 30)); paint(); },
    toggle,
    stop: () => v.pause(),
  };
  players.add(player);
  return player;
}

export function pauseAllVideos() {
  for (const p of players) { try { p.video.pause(); } catch (_) { /* detached */ } }
}

// The player on the CURRENT slide, if any - keyboard frame-stepping goes here.
export function slidePlayer(slideEl) {
  for (const p of players) if (slideEl.contains(p.el)) return p;
  return null;
}

export function disposeVideos() {
  for (const p of players) {
    try { p.video.pause(); p.video.removeAttribute('src'); p.video.load(); } catch (_) { /* gone */ }
  }
  players.clear();
}
