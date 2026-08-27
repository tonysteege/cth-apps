// Side by side: two videos on one stage, each with its own scrub and its
// own timeline (2026-08-27, Tony's spec).
//
// WHY THIS IS A PLAYER MODE AND NOT A DRAWING TOOL. Tony listed it beside
// the annotation tools, but it needs two video elements, two timelines and
// two transports - none of which belong to a tool that draws on one frame.
// It lives in the header with Freeze, Pull and Record, which is where the
// other things that act on the whole player already are.
//
// Each pane is self-contained: its own element, its own eased scrub, its own
// timeline. The SCRUB MATHS ARE IMPORTED, not reimplemented - the velocity
// curve and the spring in player.js were tuned against Film Room and are the
// one thing here that must not drift.

import { scrubDeltaSeconds, scrubMotionStep, fmtHMS } from './player.js';
import { fsConnected, fsListFolder, fsGetFile, VIDEO_ROOT } from './localfs.js';
import { toast, esc } from './ui.js';

let live = null;

export function comparing() { return !!live; }

// One pane. Returns a controller so the linker can drive both at once.
function makePane(root, { label, src, name, onClose }) {
  root.innerHTML = `
    <div class="cmp-head">
      <span class="cmp-name" title="${esc(name)}">${esc(name)}</span>
      <span class="vp-flex"></span>
      <span class="cmp-clock">0:00:00</span>
      ${onClose ? '<button class="mini" data-x="swap">Change</button>' : ''}
    </div>
    <div class="cmp-stage"><video class="cmp-video" playsinline preload="auto"></video></div>
    <canvas class="cmp-tl"></canvas>
    <div class="cmp-bar">
      <button class="mini" data-a="back">&laquo;</button>
      <button class="mini" data-a="step-">&lsaquo;</button>
      <button class="mini cmp-play" data-a="play">Play</button>
      <button class="mini" data-a="step+">&rsaquo;</button>
      <button class="mini" data-a="fwd">&raquo;</button>
    </div>`;
  const v = root.querySelector('.cmp-video');
  v.src = src;
  const tl = root.querySelector('.cmp-tl');
  const clock = root.querySelector('.cmp-clock');
  const playBtn = root.querySelector('.cmp-play');

  const draw = () => {
    const dpr = window.devicePixelRatio || 1;
    const W = tl.clientWidth;
    const H = 22;
    if (tl.width !== W * dpr || tl.height !== H * dpr) { tl.width = W * dpr; tl.height = H * dpr; }
    const ctx = tl.getContext('2d');
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    ctx.clearRect(0, 0, W, H);
    const d = Math.max(0.001, v.duration || 0);
    ctx.fillStyle = '#ebebeb';
    ctx.fillRect(0, 6, W, 10);
    ctx.fillStyle = '#d9d9d9';
    for (let m = 60; m < d; m += 60) ctx.fillRect((m / d) * W, 6, 1, 10);
    const x = (Math.min(v.currentTime, d) / d) * W;
    ctx.fillStyle = '#1a1a1a';
    ctx.fillRect(x - 1, 3, 2, 16);
    clock.textContent = fmtHMS(v.currentTime || 0);
  };

  // The same two-stage scrub the main stage uses: a raw aim that follows the
  // finger, and a painted position eased onto it.
  let aim = 0;
  let pos = 0;
  let raf = 0;
  let last = 0;
  const settle = () => {
    const now = performance.now();
    const dt = Math.max(4, Math.min(40, now - last));
    last = now;
    pos = scrubMotionStep(pos, aim, dt);
    if (Math.abs(pos - v.currentTime) > 0.008) v.currentTime = pos;
    draw();
    if (Math.abs(aim - pos) > 0.004) raf = requestAnimationFrame(settle);
    else raf = 0;
  };
  const onWheel = (e) => {
    if (!v.duration) return;
    e.preventDefault();
    if (!raf) { pos = v.currentTime; aim = v.currentTime; last = performance.now(); }
    v.pause();
    aim = Math.max(0, Math.min(v.duration, aim - scrubDeltaSeconds(e.deltaX || e.deltaY, 8, 1, e.shiftKey)));
    if (!raf) raf = requestAnimationFrame(settle);
    api.onSeek?.(aim);
  };
  root.querySelector('.cmp-stage').addEventListener('wheel', onWheel, { passive: false });

  tl.addEventListener('pointerdown', (e) => {
    const r = tl.getBoundingClientRect();
    const go = (ev) => {
      const t = ((ev.clientX - r.left) / r.width) * (v.duration || 0);
      v.currentTime = Math.max(0, Math.min(v.duration || 0, t));
      aim = v.currentTime; pos = v.currentTime;
      draw();
      api.onSeek?.(v.currentTime);
    };
    go(e);
    const mv = (ev) => go(ev);
    const up = () => { window.removeEventListener('pointermove', mv); window.removeEventListener('pointerup', up); };
    window.addEventListener('pointermove', mv);
    window.addEventListener('pointerup', up);
  });

  const act = {
    play: () => { if (v.paused) void v.play(); else v.pause(); },
    'step-': () => { v.pause(); v.currentTime = Math.max(0, v.currentTime - 1 / 30); },
    'step+': () => { v.pause(); v.currentTime = Math.min(v.duration || 0, v.currentTime + 1 / 30); },
    back: () => { v.currentTime = Math.max(0, v.currentTime - 5); },
    fwd: () => { v.currentTime = Math.min(v.duration || 0, v.currentTime + 5); },
  };
  root.querySelectorAll('[data-a]').forEach((b) => {
    b.onclick = () => { act[b.dataset.a](); api.onSeek?.(v.currentTime); };
  });
  root.querySelector('[data-x="swap"]')?.addEventListener('click', () => onClose?.());
  v.addEventListener('timeupdate', draw);
  v.addEventListener('loadedmetadata', draw);
  v.addEventListener('play', () => { playBtn.textContent = 'Pause'; });
  v.addEventListener('pause', () => { playBtn.textContent = 'Play'; });

  const api = {
    label,
    video: v,
    draw,
    onSeek: null,
    seekTo: (t) => { v.currentTime = Math.max(0, Math.min(v.duration || 0, t)); aim = v.currentTime; pos = v.currentTime; draw(); },
    play: () => v.play().catch(() => {}),
    pause: () => v.pause(),
    destroy: () => { cancelAnimationFrame(raf); v.pause(); v.removeAttribute('src'); v.load(); },
  };
  return api;
}

// Everything in the cth folder that looks like film, flat enough to pick
// from without building a second file browser.
async function libraryChoices() {
  if (!fsConnected()) return [];
  const out = [];
  const walk = async (path, depth) => {
    if (depth > 2 || out.length > 200) return;
    let listing;
    try { listing = await fsListFolder(path); } catch (_) { return; }
    for (const f of listing.files || []) out.push({ name: f.name, path: f.path || `${path}/${f.name}` });
    for (const d of listing.folders || []) await walk(d.path, depth + 1);
  };
  await walk(VIDEO_ROOT, 0);
  return out;
}

async function pickVideo() {
  const choices = await libraryChoices();
  return new Promise((res) => {
    const veil = document.createElement('div');
    veil.className = 'sheet-veil';
    veil.innerHTML = `
      <div class="sheet sheet-wide" role="dialog" aria-modal="true" aria-label="Choose A Video">
        <h3>Compare With</h3>
        <p>Pick a video from your cth folder, or choose a file from anywhere.</p>
        <div class="cmp-list">${choices.map((c, i) => `<button class="cmp-pick" data-i="${i}">${esc(c.name)}</button>`).join('')
          || '<p class="bs-empty">No videos found in your cth folder. Choose a file instead.</p>'}</div>
        <div class="sheet-row">
          <button class="btn" data-x="file">Choose File…</button>
          <span class="vp-flex"></span>
          <button class="btn" data-x="cancel">Cancel</button>
        </div>
        <input type="file" accept="video/*,.mp4,.mov,.m4v,.webm" hidden>
      </div>`;
    document.body.appendChild(veil);
    const done = (val) => { veil.remove(); res(val); };
    veil.addEventListener('mousedown', (e) => { if (e.target === veil) done(null); });
    veil.querySelector('[data-x="cancel"]').onclick = () => done(null);
    const input = veil.querySelector('input[type="file"]');
    veil.querySelector('[data-x="file"]').onclick = () => input.click();
    input.onchange = () => {
      const f = input.files?.[0];
      if (f) done({ name: f.name, url: URL.createObjectURL(f) });
    };
    veil.querySelectorAll('[data-i]').forEach((b) => {
      b.onclick = async () => {
        const c = choices[Number(b.dataset.i)];
        try {
          const file = await fsGetFile(c.path);
          done({ name: c.name, url: URL.createObjectURL(file) });
        } catch (e) {
          toast(e.message || 'Could Not Open That Video', true);
          done(null);
        }
      };
    });
  });
}

export async function openCompare({ name, url, startAt = 0 }) {
  if (live) { closeCompare(); return; }
  const other = await pickVideo();
  if (!other) return;

  const root = document.createElement('div');
  root.className = 'cmp-root';
  root.innerHTML = `
    <div class="cmp-panes"><div class="cmp-pane" data-p="a"></div><div class="cmp-pane" data-p="b"></div></div>
    <div class="cmp-foot">
      <button class="mini" id="cmpLink" title="Scrub And Play Both Together">Link</button>
      <button class="mini" id="cmpSync" title="Set The Other Video To This Timecode">Match Time</button>
      <span class="vp-flex"></span>
      <button class="btn btn-ink" id="cmpDone">Done</button>
    </div>`;
  document.getElementById('vpStage')?.appendChild(root);

  const a = makePane(root.querySelector('[data-p="a"]'), { label: 'a', src: url, name });
  const b = makePane(root.querySelector('[data-p="b"]'), {
    label: 'b', src: other.url, name: other.name,
    onClose: async () => { const n = await pickVideo(); if (n) { b.video.src = n.url; root.querySelector('[data-p="b"] .cmp-name').textContent = n.name; } },
  });
  a.seekTo(startAt);

  // LINKED is the mode that makes a comparison a comparison: an offset is
  // captured when it is switched on, so two clips that start at different
  // timecodes still move together.
  let linked = false;
  let offset = 0;
  const linkBtn = root.querySelector('#cmpLink');
  const relay = (from, to) => (t) => { if (linked) to.seekTo(t + (from === a ? offset : -offset)); };
  a.onSeek = relay(a, b);
  b.onSeek = relay(b, a);
  linkBtn.onclick = () => {
    linked = !linked;
    offset = b.video.currentTime - a.video.currentTime;
    linkBtn.classList.toggle('on', linked);
    linkBtn.textContent = linked ? 'Linked' : 'Link';
  };
  root.querySelector('#cmpSync').onclick = () => { b.seekTo(a.video.currentTime); offset = 0; };
  root.querySelector('#cmpDone').onclick = () => closeCompare();

  const onKey = (e) => {
    if (e.key !== 'Escape') return;
    e.preventDefault();
    e.stopPropagation();
    closeCompare();
  };
  document.addEventListener('keydown', onKey, true);
  live = { root, a, b, onKey, revoke: other.url.startsWith('blob:') ? other.url : null };
}

export function closeCompare() {
  if (!live) return;
  document.removeEventListener('keydown', live.onKey, true);
  live.a.destroy();
  live.b.destroy();
  if (live.revoke) URL.revokeObjectURL(live.revoke);
  live.root.remove();
  live = null;
}
