// CTH Clips Notion - YouTube adapter. The visible controls and scrub input
// stay in this origin while YouTube supplies the video inside its iframe.
// The scrub curve remains imported from Clips, never copied.

import { scrubDeltaSeconds, scrubMotionStep } from '/clips/js/player.js';
import { iconSvg } from '/boards/js/icons.js';

const $ = (s, r) => (r || document).querySelector(s);
const clamp = (v, a, b) => Math.max(a, Math.min(b, v));
const fmt = (t) => {
  if (!isFinite(t)) return '0:00.0';
  const h = Math.floor(t / 3600), m = Math.floor((t % 3600) / 60), s = Math.floor(t % 60), d = Math.floor((t % 1) * 10);
  return `${h ? `${h}:` : ''}${h ? String(m).padStart(2, '0') : m}:${String(s).padStart(2, '0')}.${d}`;
};

export function youtubeId(src) {
  try {
    const u = new URL(src); const host = u.hostname.replace(/^www\./, '').replace(/^m\./, '');
    if (host === 'youtu.be') return u.pathname.split('/').filter(Boolean)[0] || '';
    if (host === 'youtube.com' || host === 'youtube-nocookie.com') {
      if (u.pathname === '/watch') return u.searchParams.get('v') || '';
      const p = u.pathname.split('/').filter(Boolean);
      if (['embed', 'shorts', 'live'].includes(p[0])) return p[1] || '';
    }
  } catch (_) {}
  return '';
}
export const isYouTubeUrl = (src) => !!youtubeId(src);

let apiPromise;
function loadYouTubeApi() {
  if (window.YT?.Player) return Promise.resolve(window.YT);
  if (apiPromise) return apiPromise;
  apiPromise = new Promise((resolve, reject) => {
    const prior = window.onYouTubeIframeAPIReady;
    window.onYouTubeIframeAPIReady = () => { prior?.(); resolve(window.YT); };
    const script = document.createElement('script');
    script.src = 'https://www.youtube.com/iframe_api'; script.async = true;
    script.onerror = () => reject(new Error('YouTube could not be reached.'));
    document.head.appendChild(script);
    setTimeout(() => reject(new Error('YouTube took too long to load.')), 15000);
  });
  return apiPromise;
}

export function mountYouTubePlayer(root, { src, start = 0, hooks = {} }) {
  const id = youtubeId(src);
  root.innerHTML = `
    <div class="cn-stage cn-youtube-stage is-paused is-loading" id="cnStage" tabindex="0" aria-label="Video player">
      <div class="cn-youtube"><iframe id="cnYoutube" src="https://www.youtube-nocookie.com/embed/${id}?enablejsapi=1&controls=0&disablekb=1&fs=0&playsinline=1&rel=0&modestbranding=1&origin=${encodeURIComponent(location.origin)}&start=${Math.max(0, Math.floor(start))}" title="YouTube video player" allow="autoplay; encrypted-media; picture-in-picture" allowfullscreen></iframe></div>
      <div class="cn-input" id="cnInput" aria-label="Video surface. Two-finger swipe horizontally to scrub."></div>
      <div class="cn-loading" id="cnLoading" role="status"><span class="cn-spinner" aria-hidden="true"></span><span>Loading video</span></div>
      <div class="cn-scrub-hud" id="cnScrubHud" aria-hidden="true">0:00.0</div>
      <div class="cn-big" aria-hidden="true"><span>${iconSvg('play')}</span></div>
    </div>
    <div class="cn-bar">
      <button class="cn-btn" id="cnPlay" aria-label="Play or pause">${iconSvg('play')}</button>
      <span class="cn-time" id="cnTime">0:00.0 / 0:00.0</span>
      <div class="cn-tl" id="cnTl" role="slider" tabindex="0" aria-label="Video position" aria-valuemin="0" aria-valuemax="0" aria-valuenow="0"><div class="cn-tl-track"></div><div class="cn-tl-fill" id="cnFill"></div><div class="cn-tl-head" id="cnHead"></div></div>
      <button class="cn-btn cn-speed" id="cnSpeed" aria-label="Playback speed">1x</button>
      <a class="cn-btn" id="cnOpen" aria-label="Open in YouTube" href="${src.replace(/"/g, '&quot;')}" target="_blank" rel="noopener">${iconSvg('external-link')}</a>
      <button class="cn-btn" id="cnFull" aria-label="Fullscreen">${iconSvg('maximize-2')}</button>
    </div>`;

  const stage = $('#cnStage', root), input = $('#cnInput', root), tl = $('#cnTl', root), hud = $('#cnScrubHud', root);
  const adapter = new EventTarget();
  const state = { player: null, ready: false, current: 0, duration: 0, paused: true, rate: 1, speedI: 0, aim: null, pos: null, raf: 0, pumpTimer: 0, settle: 0, lastSeekAt: 0, lastWheelAt: 0 };
  const SPEEDS = [1, 0.5, 0.25, 2];
  Object.defineProperties(adapter, {
    currentTime: { get: () => state.current, set: (t) => commitSeek(t, true) },
    duration: { get: () => state.duration }, paused: { get: () => state.paused },
    playbackRate: { get: () => state.rate, set: (n) => { state.rate = n; state.player?.setPlaybackRate(n); } },
    videoWidth: { get: () => 16 }, videoHeight: { get: () => 9 }
  });
  adapter.play = () => { state.player?.playVideo(); return Promise.resolve(); };
  adapter.pause = () => state.player?.pauseVideo();

  function paintAt(t = state.current) {
    const safe = isFinite(t) ? clamp(t, 0, state.duration || 0) : 0, f = state.duration ? safe / state.duration : 0;
    $('#cnTime', root).textContent = `${fmt(safe)} / ${fmt(state.duration)}`;
    $('#cnFill', root).style.width = `${f * 100}%`; $('#cnHead', root).style.left = `${f * 100}%`;
    tl.setAttribute('aria-valuemax', String(Math.round(state.duration || 0)));
    tl.setAttribute('aria-valuenow', String(Math.round(safe)));
    tl.setAttribute('aria-valuetext', `${fmt(safe)} of ${fmt(state.duration)}`);
  }
  function paintPlay() {
    $('#cnPlay', root).innerHTML = iconSvg(state.paused ? 'play' : 'pause');
    stage.classList.toggle('is-paused', state.paused); hooks.onPlayState?.(state.paused);
  }
  function fail(message) {
    stage.classList.remove('is-loading'); stage.classList.add('has-error');
    $('#cnLoading', root).innerHTML = `<strong>Video unavailable</strong><span>${message}</span>`;
    hooks.onError?.(new Error(message));
  }
  function commitSeek(t, allowSeekAhead) {
    if (!state.ready || !isFinite(state.duration)) return;
    const next = clamp(Number(t) || 0, 0, state.duration);
    state.current = next; state.player.seekTo(next, !!allowSeekAhead); paintAt(next);
  }
  function schedule() {
    cancelAnimationFrame(state.raf); clearTimeout(state.pumpTimer);
    state.raf = requestAnimationFrame(pump); state.pumpTimer = setTimeout(pump, 40);
  }
  function pump() {
    clearTimeout(state.pumpTimer); if (state.aim == null) return;
    state.pos = scrubMotionStep(state.pos, state.aim, 16); paintAt(state.pos); hud.textContent = fmt(state.pos); stage.classList.add('is-scrubbing');
    const now = performance.now();
    if (now - state.lastSeekAt >= 70) { state.lastSeekAt = now; commitSeek(state.pos, false); }
    if (Math.abs(state.aim - state.pos) > 0.02) schedule();
  }
  function finishScrub() {
    clearTimeout(state.settle);
    const target = state.aim ?? state.pos ?? state.current;
    commitSeek(target, true); state.current = target; state.aim = null; state.pos = null;
    stage.classList.remove('is-scrubbing'); paintAt(target);
  }
  function scrubBy(dt) {
    if (!state.ready || !state.duration) return;
    if (!state.paused) adapter.pause();
    if (state.aim == null) { state.aim = state.current; state.pos = state.current; }
    state.aim = clamp(state.aim + dt, 0, state.duration); schedule();
    clearTimeout(state.settle); state.settle = setTimeout(finishScrub, 180);
  }

  input.addEventListener('wheel', (e) => {
    if (Math.abs(e.deltaX) <= Math.abs(e.deltaY) * 1.15) return;
    e.preventDefault(); e.stopPropagation();
    const now = e.timeStamp, elapsed = state.lastWheelAt ? clamp(now - state.lastWheelAt, 4, 40) : 16;
    state.lastWheelAt = now; scrubBy(scrubDeltaSeconds(-e.deltaX, elapsed, 1, e.altKey));
  }, { passive: false });

  const toggle = () => { if (!state.ready) return; if (state.paused) adapter.play(); else adapter.pause(); };
  $('#cnPlay', root).onclick = toggle; input.onclick = toggle; input.ondblclick = () => $('#cnFull', root).click();
  stage.addEventListener('pointerdown', () => stage.focus({ preventScroll: true }));
  $('#cnSpeed', root).onclick = () => { state.speedI = (state.speedI + 1) % SPEEDS.length; adapter.playbackRate = SPEEDS[state.speedI]; $('#cnSpeed', root).textContent = `${SPEEDS[state.speedI]}x`; };
  $('#cnFull', root).onclick = () => { if (document.fullscreenElement) document.exitFullscreen(); else document.documentElement.requestFullscreen?.().catch(() => {}); };

  const tlTime = (e) => { const r = tl.getBoundingClientRect(); return clamp((e.clientX - r.left) / r.width, 0, 1) * (state.duration || 0); };
  tl.onpointerdown = (e) => {
    if (!state.ready) return; if (!state.paused) adapter.pause();
    const go = (ev) => { state.aim = tlTime(ev); if (state.pos == null) state.pos = state.current; schedule(); };
    go(e);
    const move = (ev) => go(ev), up = () => { window.removeEventListener('pointermove', move); window.removeEventListener('pointerup', up); finishScrub(); };
    window.addEventListener('pointermove', move); window.addEventListener('pointerup', up); e.preventDefault();
  };
  const step = (dt) => { if (!state.ready) return; if (!state.paused) adapter.pause(); commitSeek(state.current + dt, true); };
  window.addEventListener('keydown', (e) => {
    if (/INPUT|TEXTAREA/.test(e.target.tagName) || e.target.isContentEditable) return;
    const key = e.key.toLowerCase();
    if (e.key === ' ' || key === 'k') { e.preventDefault(); toggle(); }
    else if (e.key === 'ArrowLeft') { e.preventDefault(); step(e.shiftKey ? -1 : -1 / 30); }
    else if (e.key === 'ArrowRight') { e.preventDefault(); step(e.shiftKey ? 1 : 1 / 30); }
    else if (key === 'j') step(-5); else if (key === 'l') step(5);
    else if (key === 'f') $('#cnFull', root).click(); else if (e.key === 'Home') commitSeek(0, true); else if (e.key === 'End') commitSeek(state.duration, true);
  });

  loadYouTubeApi().then((YT) => {
    state.player = new YT.Player(document.getElementById('cnYoutube'), { events: {
      onReady: (event) => {
        state.ready = true; state.duration = Number(event.target.getDuration()) || 0; state.current = clamp(start || 0, 0, state.duration || 0);
        if (state.current) event.target.seekTo(state.current, true);
        stage.classList.remove('is-loading'); adapter.dispatchEvent(new Event('loadedmetadata')); hooks.onReady?.(adapter); paintAt(); paintPlay();
        setInterval(() => { if (!state.ready || state.aim != null) return; state.current = Number(state.player.getCurrentTime()) || 0; adapter.dispatchEvent(new Event('timeupdate')); paintAt(); }, 100);
      },
      onStateChange: (event) => {
        const wasPaused = state.paused; state.paused = event.data !== YT.PlayerState.PLAYING; state.current = Number(state.player.getCurrentTime()) || state.current;
        if (event.data === YT.PlayerState.PLAYING) adapter.dispatchEvent(new Event('play'));
        else if (!wasPaused || event.data === YT.PlayerState.PAUSED) adapter.dispatchEvent(new Event('pause'));
        if (event.data === YT.PlayerState.PAUSED || event.data === YT.PlayerState.CUED) adapter.dispatchEvent(new Event('seeked'));
        paintPlay(); paintAt();
      },
      onError: (event) => {
        const messages = { 2: 'The YouTube link is invalid.', 5: 'This video cannot play in the embedded player.', 100: 'This video was removed or is private.', 101: 'The owner has disabled embedded playback.', 150: 'The owner has disabled embedded playback.', 153: 'YouTube could not verify this embedded player.' };
        fail(messages[event.data] || 'YouTube could not play this video.');
      }
    }});
  }).catch((error) => fail(error.message));
  return { video: adapter, stage, pause: () => adapter.pause(), step, scrubBy };
}
