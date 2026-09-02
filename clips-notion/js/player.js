// CTH Clips Notion - the player. A video from a URL with the Clips scrub
// feel: the velocity curve and spring are IMPORTED from clips/js/player.js
// (themselves ported from CTH Film Room) - never reimplemented. One seek in
// flight, released by the video's own 'seeked' event with the 250ms safety
// timeout; precise seeks for small steps, fastSeek only over 1.5s; a
// rightward two-finger swipe (negative deltaX on macOS) moves forward.

import { scrubDeltaSeconds, scrubMotionStep } from '/clips/js/player.js';
import { iconSvg } from '/boards/js/icons.js';

const $ = (s, r) => (r || document).querySelector(s);
const clamp = (v, a, b) => Math.max(a, Math.min(b, v));
const fmt = (t) => { if (!isFinite(t)) return '0:00.0'; const m = Math.floor(t / 60); const s = Math.floor(t % 60); const d = Math.floor((t % 1) * 10); return `${m}:${String(s).padStart(2, '0')}.${d}`; };

export function mountPlayer(root, { src, start = 0, hooks = {} }) {
  root.innerHTML = `
    <div class="cn-stage is-paused" id="cnStage">
      <video id="cnVideo" playsinline preload="metadata" src="${src.replace(/"/g, '&quot;')}"></video>
      <div class="cn-big" aria-hidden="true"><span>${iconSvg('play')}</span></div>
    </div>
    <div class="cn-bar">
      <button class="cn-btn" id="cnPlay" aria-label="Play or pause">${iconSvg('play')}</button>
      <span class="cn-time" id="cnTime">0:00.0 / 0:00.0</span>
      <div class="cn-tl" id="cnTl"><div class="cn-tl-track"></div><div class="cn-tl-fill" id="cnFill"></div><div class="cn-tl-head" id="cnHead"></div></div>
      <button class="cn-btn cn-speed" id="cnSpeed" aria-label="Playback speed">1x</button>
      <button class="cn-btn" id="cnFull" aria-label="Fullscreen">${iconSvg('maximize-2')}</button>
    </div>`;
  const v = $('#cnVideo', root); const stage = $('#cnStage', root);
  const st = { aim: null, pos: null, raf: 0, timer: 0, settle: 0, busy: false, unlock: 0, speedI: 0 };
  const SPEEDS = [1, 0.5, 0.25, 2];

  const paintTime = () => { $('#cnTime', root).textContent = `${fmt(v.currentTime)} / ${fmt(v.duration)}`; const f = isFinite(v.duration) && v.duration ? v.currentTime / v.duration : 0; $('#cnFill', root).style.width = `${f * 100}%`; $('#cnHead', root).style.left = `${f * 100}%`; };
  const paintPlay = () => { $('#cnPlay', root).innerHTML = iconSvg(v.paused ? 'play' : 'pause'); stage.classList.toggle('is-paused', v.paused); hooks.onPlayState?.(v.paused); };
  v.addEventListener('timeupdate', paintTime); v.addEventListener('loadedmetadata', () => { if (start > 0) v.currentTime = start; paintTime(); hooks.onReady?.(v); });
  v.addEventListener('play', paintPlay); v.addEventListener('pause', paintPlay); v.addEventListener('seeked', () => { st.busy = false; clearTimeout(st.unlock); paintTime(); });
  v.addEventListener('error', () => { $('#cnTime', root).textContent = 'Could not load this video'; hooks.onError?.(v.error); });

  const seekTo = (t) => {
    if (st.busy) return;
    st.busy = true; clearTimeout(st.unlock); st.unlock = setTimeout(() => { st.busy = false; }, 250);
    const big = Math.abs(t - v.currentTime) > 1.5;
    if (big && v.fastSeek) v.fastSeek(t); else v.currentTime = t;
  };
  let pumpT = 0;
  const pump = () => { clearTimeout(pumpT); if (st.aim == null) return; st.pos = scrubMotionStep(st.pos, st.aim, 16); seekTo(st.pos); paintTime(); if (Math.abs(st.aim - st.pos) > 0.02) schedule(); };
  const schedule = () => { cancelAnimationFrame(st.raf); clearTimeout(pumpT); st.raf = requestAnimationFrame(pump); pumpT = setTimeout(pump, 40); };
  const scrubBy = (dt, fine = false) => {
    if (!isFinite(v.duration)) return;
    if (!v.paused) v.pause();
    if (st.aim == null) { st.aim = v.currentTime; st.pos = v.currentTime; }
    st.aim = clamp(st.aim + dt, 0, v.duration);
    schedule();
    clearTimeout(st.settle); st.settle = setTimeout(() => { st.aim = null; st.pos = null; }, 400);
  };
  stage.addEventListener('wheel', (e) => {
    if (Math.abs(e.deltaX) <= Math.abs(e.deltaY) * 1.4) return;
    e.preventDefault(); e.stopPropagation();
    scrubBy(scrubDeltaSeconds(-e.deltaX, 16, 1, e.altKey), e.altKey);
  }, { passive: false });

  const toggle = () => { if (v.paused) v.play().catch(() => {}); else v.pause(); };
  $('#cnPlay', root).onclick = toggle;
  stage.addEventListener('click', (e) => { if (e.target === v || e.target.closest('.cn-big')) { if (!hooks.armed?.()) toggle(); } });
  $('#cnSpeed', root).onclick = () => { st.speedI = (st.speedI + 1) % SPEEDS.length; v.playbackRate = SPEEDS[st.speedI]; $('#cnSpeed', root).textContent = `${SPEEDS[st.speedI]}x`; };
  $('#cnFull', root).onclick = () => { const el = document.documentElement; if (document.fullscreenElement) document.exitFullscreen(); else el.requestFullscreen?.().catch(() => {}); };

  // Timeline: click jumps, drag rides the same spring.
  const tl = $('#cnTl', root);
  const tlTime = (e) => { const r = tl.getBoundingClientRect(); return clamp((e.clientX - r.left) / r.width, 0, 1) * (v.duration || 0); };
  tl.onpointerdown = (e) => {
    if (!isFinite(v.duration)) return;
    if (!v.paused) v.pause();
    const go = (ev) => { st.aim = tlTime(ev); if (st.pos == null) st.pos = v.currentTime; schedule(); };
    go(e);
    const move = (ev) => go(ev);
    const up = () => { window.removeEventListener('pointermove', move); window.removeEventListener('pointerup', up); setTimeout(() => { st.aim = null; st.pos = null; }, 300); };
    window.addEventListener('pointermove', move); window.addEventListener('pointerup', up);
    e.preventDefault();
  };

  const step = (dt) => { if (!v.paused) v.pause(); v.currentTime = clamp(v.currentTime + dt, 0, v.duration || 0); paintTime(); };
  const onKey = (e) => {
    if (/INPUT|TEXTAREA/.test(e.target.tagName) || e.target.isContentEditable) return;
    if (e.key === ' ' || e.key === 'k') { e.preventDefault(); toggle(); }
    else if (e.key === 'ArrowLeft') { e.preventDefault(); step(e.shiftKey ? -1 : -1 / 30); }
    else if (e.key === 'ArrowRight') { e.preventDefault(); step(e.shiftKey ? 1 : 1 / 30); }
    else if (e.key === 'j') step(-5); else if (e.key === 'l') step(5);
    else if (e.key === 'f') $('#cnFull', root).click();
    else if (e.key === 'Home') step(-1e9); else if (e.key === 'End') step(1e9);
  };
  window.addEventListener('keydown', onKey);

  return { video: v, stage, pause: () => v.pause(), step, scrubBy };
}
