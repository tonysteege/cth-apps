// The CTH Videos player: a <video> with the CTH scrub feel laid over it.
//
// THE SCRUB IS STUDIO'S ENGINE, IMPORTED. `studio/js/scrub.js` carries the
// Clips / Film Room curve (`deltaSeconds`, `motionStep`) and drives the
// WebCodecs decoder in `clips/js/scrubsource.js`, which reads this Worker's
// Range-capable stream in 8 MB windows. None of that is reimplemented here.
//
// WHAT IS DIFFERENT FROM STUDIO: Studio's stage is a canvas and every frame
// is composited. Here the <video> element IS the picture - it plays natively,
// full quality, on every device - and a `scrub-paint` canvas sits over it,
// shown only while the decoder is serving frames during a gesture (the Clips
// arrangement). When the gesture ends the engine seeks the element to the
// final frame and the overlay drops on `seeked`, so the picture never snaps
// back to a stale frame.
//
// Used by the library's detail view and by watch.html, so a player and a
// share link can never feel different.

import { ScrubEngine } from '../../studio/js/scrub.js';
import { h, icon, ICONS, tc } from '../../studio/js/ui.js';

const RATES = [0.25, 0.5, 1, 1.5, 2];

export function mountPlayer(host, { url, id, title = '', poster = '', autoplay = false, start = 0, onError } = {}) {
  const video = h('video', { class: 'vp-video', playsinline: true, preload: 'metadata', crossorigin: 'anonymous' });
  if (poster) video.poster = poster;
  const paint = h('canvas', { class: 'scrub-paint', 'aria-hidden': 'true' });
  const stage = h('div', { class: 'vp-stage', tabindex: '0', 'aria-label': title ? `${title} player` : 'Video player' }, video, paint);
  const big = h('button', { class: 'vp-big', 'aria-label': 'Play' }, icon(ICONS.play, 34));
  stage.appendChild(big);

  const play = h('button', { class: 'vp-btn', 'aria-label': 'Play', title: 'Play (space)' }, icon(ICONS.play, 18));
  const clock = h('span', { class: 'vp-tc', text: '0:00.00' });
  const total = h('span', { class: 'vp-tc vp-tc-dim', text: '' });
  const fill = h('div', { class: 'vp-fill' });
  const head = h('div', { class: 'vp-head' });
  const seek = h('div', { class: 'vp-seek', role: 'slider', 'aria-label': 'Seek', tabindex: '0', 'aria-valuemin': '0', 'aria-valuemax': '100' },
    h('div', { class: 'vp-track' }), fill, head);
  const rate = h('button', { class: 'vp-btn vp-rate', title: 'Speed', 'aria-label': 'Playback speed', text: '1x' });
  const full = h('button', { class: 'vp-btn', 'aria-label': 'Fullscreen', title: 'Fullscreen (f)' }, fullIcon());
  const bar = h('div', { class: 'vp-bar' }, play, clock, seek, total, rate, full);
  const root = h('div', { class: 'vp' }, stage, bar);
  host.replaceChildren(root);

  let rateIx = 2;
  let duration = 0;
  let overlayOn = false;

  const paintCtx = paint.getContext('2d', { alpha: false });
  const showPaint = (c) => {
    if (paint.width !== c.width || paint.height !== c.height) { paint.width = c.width; paint.height = c.height; }
    paintCtx.drawImage(c, 0, 0);
    if (!overlayOn) { overlayOn = true; paint.classList.add('on'); }
  };
  const hidePaint = () => { if (overlayOn) { overlayOn = false; paint.classList.remove('on'); } };

  const engine = new ScrubEngine(video, {
    onFrame: (picture) => { if (picture instanceof HTMLCanvasElement) showPaint(picture); else hidePaint(); },
    onTime: (t) => paintBar(t),
    settings: () => ({ scrubSensitivity: 1, scrubReverse: false }),
  });

  const fmt = (t) => tc(t, true);
  function paintBar(t) {
    const f = duration ? Math.min(1, Math.max(0, t / duration)) : 0;
    fill.style.width = `${f * 100}%`;
    head.style.left = `${f * 100}%`;
    clock.textContent = fmt(t);
    seek.setAttribute('aria-valuenow', String(Math.round(f * 100)));
  }
  const setPlaying = (on) => {
    play.replaceChildren(icon(on ? ICONS.pause : ICONS.play, 18));
    play.setAttribute('aria-label', on ? 'Pause' : 'Play');
    root.classList.toggle('playing', on);
  };

  video.addEventListener('loadedmetadata', () => {
    duration = Number.isFinite(video.duration) ? video.duration : 0;
    engine.setMap((t) => t, duration);
    total.textContent = fmt(duration);
    if (start) engine.seek(Math.min(start, duration), true);
    else paintBar(0);
    // The fast decoder, opened after metadata so the element has already
    // proven the file plays. Everything about it degrades to a plain seek.
    engine.attach(id || url, null, url).then((src) => {
      // Clips' own diagnostic: `window.__scrubDebug = {}` before a video opens
      // exposes the live decoder and its hit/fallback counts.
      if (window.__scrubDebug) window.__scrubDebug.src = src;
      if (video.paused) engine.seek(engine.time, true);
    }).catch(() => {});
    if (autoplay) engine.play(() => RATES[rateIx]);
  }, { once: true });
  video.addEventListener('error', () => {
    root.classList.add('broken');
    if (onError) onError(video.error);
  });
  video.addEventListener('play', () => setPlaying(true));
  video.addEventListener('pause', () => { if (!engine.playing) setPlaying(false); });

  // The engine's own clock drives playback, so pausing for a gesture and
  // resuming land where the finger left the picture.
  const togglePlay = () => {
    if (engine.playing) { engine.pause(); setPlaying(false); }
    else { engine.play(() => RATES[rateIx]); setPlaying(true); }
  };
  play.onclick = togglePlay;
  big.onclick = togglePlay;
  stage.addEventListener('click', (e) => { if (e.target === video || e.target === paint) togglePlay(); });
  rate.onclick = () => { rateIx = (rateIx + 1) % RATES.length; rate.textContent = `${RATES[rateIx]}x`; if (engine.playing) video.playbackRate = RATES[rateIx]; };
  full.onclick = () => {
    if (document.fullscreenElement) document.exitFullscreen().catch(() => {});
    else if (root.requestFullscreen) root.requestFullscreen().catch(() => {});
    else if (video.webkitEnterFullscreen) video.webkitEnterFullscreen();
  };

  // ---- the gesture: two-finger trackpad travel, or a finger on a tablet ----
  engine.attachWheel(stage);
  engine.attachDrag(stage, { shouldScrub: (e) => e.target === video || e.target === paint });

  // ---- the seek bar ----
  let dragging = false;
  const at = (e) => {
    const r = seek.getBoundingClientRect();
    return Math.min(1, Math.max(0, (e.clientX - r.left) / Math.max(1, r.width))) * duration;
  };
  seek.addEventListener('pointerdown', (e) => {
    seek.setPointerCapture(e.pointerId); dragging = true;
    if (engine.playing) { engine.pause(); setPlaying(false); }
    engine.seek(at(e));
  });
  seek.addEventListener('pointermove', (e) => { if (dragging) engine.seek(at(e)); });
  const stop = (e) => {
    if (!dragging) return; dragging = false;
    try { seek.releasePointerCapture(e.pointerId); } catch (_) { /* gone */ }
    engine.seek(at(e), true);
  };
  seek.addEventListener('pointerup', stop);
  seek.addEventListener('pointercancel', stop);

  // Keys work only while the player has focus, so an embed never steals typing
  // from the Notion page around it.
  const onKey = (e) => {
    if (e.metaKey || e.ctrlKey || e.altKey) return;
    const k = e.key;
    if (k === ' ' || k === 'k') { e.preventDefault(); togglePlay(); }
    else if (k === 'ArrowLeft') { e.preventDefault(); engine.pause(); setPlaying(false); e.shiftKey ? engine.seek(engine.time - 1, true) : engine.step(-1); }
    else if (k === 'ArrowRight') { e.preventDefault(); engine.pause(); setPlaying(false); e.shiftKey ? engine.seek(engine.time + 1, true) : engine.step(1); }
    else if (k === 'j') { e.preventDefault(); engine.seek(engine.time - 5, true); }
    else if (k === 'l') { e.preventDefault(); engine.seek(engine.time + 5, true); }
    else if (k === 'f') { e.preventDefault(); full.click(); }
    else if (k === 'Home') { e.preventDefault(); engine.seek(0, true); }
    else if (k === 'End') { e.preventDefault(); engine.seek(duration, true); }
  };
  stage.addEventListener('keydown', onKey);
  seek.addEventListener('keydown', onKey);
  stage.addEventListener('pointerdown', () => stage.focus({ preventScroll: true }));

  video.src = url;

  return {
    root,
    video,
    engine,
    get time() { return engine.time; },
    seek: (t) => engine.seek(t, true),
    destroy() { engine.destroy(); video.removeAttribute('src'); video.load(); },
  };
}

function fullIcon() {
  return icon('<path d="M3 6.5V3h3.5M13 6.5V3H9.5M3 9.5V13h3.5M13 9.5V13H9.5" stroke="currentColor" stroke-width="1.5" fill="none" stroke-linecap="round" stroke-linejoin="round"/>', 18);
}
