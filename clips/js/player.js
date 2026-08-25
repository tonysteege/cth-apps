// The tagging workspace: video stage with QuickTime-style trackpad scrub,
// a canvas timeline, the two-tier tag bar (Tier 1 buttons cut a clip at the
// playhead with each button's lead/lag; Tier 2 buttons toggle #tags on the
// selected clip), the filterable clip log, and live freeze-frames that
// pause playback and paint their annotation before rolling on - the CTH
// Film Room workflow, rebuilt for the web.
//
// Marks autosave: tagging happens at game speed and can never stop for a
// Save button. Only metadata is written (clips, tags, freezes) - the video
// itself is never touched.

import { getSettings, putSettings, putGame, uid } from './store.js';
import { toast, esc } from './ui.js';
import { drawEl } from '/diagrams/js/flat.js';

let cur = null;
let wired = false;
let hooks = {};
const el = (id) => document.getElementById(id);

export const fmtTime = (t, withTenths = false) => {
  if (!isFinite(t)) return '0:00';
  const s = Math.max(0, t);
  const m = Math.floor(s / 60);
  const sec = Math.floor(s % 60);
  const base = `${m}:${String(sec).padStart(2, '0')}`;
  return withTenths ? `${base}.${Math.floor((s % 1) * 10)}` : base;
};

export const video = () => el('vpVideo');

export function clipName(c) {
  const n = c.name || c.label;
  return c.tags?.length ? `${n} - ${c.tags.map((t) => `#${t}`).join(' ')}` : n;
}

// ------------------------------------------------------------- save

function scheduleSave() {
  if (!cur) return;
  clearTimeout(cur.timer);
  cur.timer = setTimeout(() => void saveNow(), 800);
}
async function saveNow() {
  if (!cur) return;
  clearTimeout(cur.timer);
  try {
    await putGame(cur.game);
    status('Saved');
  } catch (e) {
    console.error(e);
    toast(`Could Not Save Marks (${e?.name || 'Error'})`, true);
  }
}
function status(msg) { const s = el('vpStatus'); if (s) s.textContent = msg; }

// ------------------------------------------------------------- selection

function selClip() { return cur?.game.clips.find((c) => c.id === cur.sel) || null; }
function setSel(id) {
  if (!cur) return;
  cur.sel = id;
  if (cur.clipMode && cur.clipMode.id !== id) cur.clipMode = null;
  paintLog();
  paintBar();
  drawTimeline();
}

// ------------------------------------------------------------- tagging

function panelButtons(tier) {
  return (cur?.settings.panel.buttons || []).filter((b) => b.tier === tier);
}

function pressClipButton(b) {
  const v = video();
  const t = v.currentTime;
  const c = {
    id: uid(),
    label: b.label,
    color: b.color,
    in: Math.max(0, t - (b.lead ?? 8)),
    out: Math.min(cur.duration || t + 9999, t + (b.lag ?? 4)),
    tags: [],
    note: '',
    created: Date.now(),
  };
  cur.game.clips.push(c);
  setSel(c.id);
  scheduleSave();
  status('Edited');
  toast(`${b.label} Marked At ${fmtTime(t)}`);
}

function pressTagButton(b) {
  const c = selClip();
  if (!c) { toast('Select A Clip First - Tags Attach To A Clip', true); return; }
  const has = c.tags.includes(b.label);
  c.tags = has ? c.tags.filter((t) => t !== b.label) : [...c.tags, b.label];
  paintLog();
  drawTimeline();
  scheduleSave();
  toast(has ? `#${b.label} Removed` : `#${b.label} Added`);
}

// ------------------------------------------------------------- transport

export function seek(t, keepFreeze = false) {
  const v = video();
  seekState.target = null;
  v.currentTime = Math.max(0, Math.min(cur?.duration || v.duration || 0, t));
  if (!keepFreeze) cancelFreezeHold();
  cur.prevTick = null;
  drawTimeline();
  paintClock();
}

// --- Batched seeking: the core of the QuickTime feel -----------------------
//
// A trackpad burst (or a fast timeline drag) emits events far faster than a
// video element can seek, and the old code seeked on every one, reading
// `currentTime` back between them. A read mid-seek returns the in-flight
// landing, so each event fought the last and the picture stuttered while the
// playhead barely moved. The fix is the CTH Skills Academy film player's
// model, ported whole: a TARGET is the single authority while the gesture
// runs, at most one seek is in the pipe at a time (applied on animation
// frames, `fastSeek` where the browser has it for cheap keyframe landings),
// and one precise `currentTime` seek settles the frame when the gesture ends.
const seekState = { target: null, raf: 0, timer: 0 };

function armApply() {
  if (seekState.raf) return;
  seekState.raf = requestAnimationFrame(applyQueuedSeek);
  // rAF stops when the tab is hidden or occluded (same reason the freeze
  // tick also rides timeupdate); the timer backstop keeps a queued seek
  // from stranding there.
  clearTimeout(seekState.timer);
  seekState.timer = setTimeout(applyQueuedSeek, 64);
}
function queueSeek(t) {
  if (!cur) return;
  seekState.target = Math.max(0, Math.min(cur.duration || 0, t));
  armApply();
}
function applyQueuedSeek() {
  cancelAnimationFrame(seekState.raf);
  clearTimeout(seekState.timer);
  seekState.raf = 0;
  seekState.timer = 0;
  if (!cur || seekState.target == null) return;
  const v = video();
  // One seek in flight at a time: wait a beat rather than piling on.
  if (v.seeking) { armApply(); return; }
  if (typeof v.fastSeek === 'function') v.fastSeek(seekState.target);
  else v.currentTime = seekState.target;
  cur.prevTick = null;
}
function settleSeek() {
  if (!cur || seekState.target == null) return;
  const t = seekState.target;
  cancelAnimationFrame(seekState.raf);
  clearTimeout(seekState.timer);
  seekState.raf = 0;
  seekState.timer = 0;
  seekState.target = null;
  video().currentTime = t; // the one precise, non-fast seek
  cur.prevTick = null;
}
// While a gesture runs the UI tracks the finger, not the decoder: the
// playhead and clock read the target so they stay glued to the gesture even
// when a between-keyframes landing is still decoding.
function headTime() { return seekState.target ?? video().currentTime; }

function togglePlay() {
  const v = video();
  cancelFreezeHold();
  if (v.paused) void v.play(); else v.pause();
}

function frameStep(dir) {
  const v = video();
  v.pause();
  cancelFreezeHold();
  seek(v.currentTime + dir * (1 / 30));
}

const SPEEDS = [0.25, 0.5, 1, 1.5, 2, 4];
function setSpeed(s) {
  video().playbackRate = s;
  const b = el('vpSpeed');
  if (b) b.textContent = `${s}x`;
}

// QuickTime-style two-finger scrub on the stage. Three rules, all from the
// CTH Skills Academy film player where this feel was tuned and shipped:
//
// 1. The rate is proportional to the video, not a constant. A full ~900px
//    swipe crosses the whole file, bounded at both ends (a 3s clip stays
//    aimable, an hour of game film is not crossed by accident - the ceiling
//    binds from about four minutes up). The old constant 0.012s/px was drawn
//    for nothing in particular: on a 60-minute period a full swipe moved the
//    playhead 11 seconds, which read as "hardly moves at all".
// 2. A gesture is CLAIMED once and kept. The old per-event axis test dropped
//    every event where the finger drifted a little vertical, so a swipe
//    stuttered in and out of scrubbing - the "super jumpy" half of the bug.
//    Vertical scrolls are still never stolen: only a clearly-horizontal
//    motion starts a gesture (1.4 margin, because trackpads leak a little of
//    the other axis on every gesture).
// 3. Seeks batch through queueSeek above - never one per wheel event.
//
// Shift is the fine pass: eight times slower, for finding the frame where
// stick meets puck rather than the shift it happened on.
const SCRUB_TRAVEL_PX = 900;
const MIN_SEC_PER_PX = 0.004;
const MAX_SEC_PER_PX = 0.25;
const FINE_DIVISOR = 8;
const SCRUB_END_MS = 140;

function secPerPx(duration) {
  if (!isFinite(duration) || duration <= 0) return MIN_SEC_PER_PX;
  return Math.min(Math.max(duration / SCRUB_TRAVEL_PX, MIN_SEC_PER_PX), MAX_SEC_PER_PX);
}
const isScrubGesture = (dx, dy) => Math.abs(dx) > Math.abs(dy) * 1.4 && Math.abs(dx) > 0.5;

let scrub = null; // { endTimer } - target lives in seekState
function onStageWheel(e) {
  if (!cur) return;
  if (!scrub && !isScrubGesture(e.deltaX, e.deltaY)) return; // vertical = page scroll
  e.preventDefault();
  const v = video();
  if (!scrub) {
    if (!v.paused) v.pause();
    cancelFreezeHold();
    scrub = { endTimer: 0 };
    seekState.target = v.currentTime;
  }
  const dir = cur.settings.scrubReverse ? -1 : 1;
  const rate = secPerPx(cur.duration) / (e.shiftKey ? FINE_DIVISOR : 1);
  queueSeek(seekState.target + dir * e.deltaX * rate);
  clearTimeout(scrub.endTimer);
  scrub.endTimer = setTimeout(() => { scrub = null; settleSeek(); }, SCRUB_END_MS);
}

// ------------------------------------------------------------- clip mode

function enterClipMode(id, { loop = false } = {}) {
  const c = cur.game.clips.find((x) => x.id === id);
  if (!c) return;
  cur.sel = id;
  cur.clipMode = { id, loop };
  seek(c.in);
  void video().play();
  paintLog();
  paintBar();
}
export function playClip(id) { enterClipMode(id, { loop: false }); }

function clipModeTick() {
  const cm = cur.clipMode;
  if (!cm) return;
  const c = cur.game.clips.find((x) => x.id === cm.id);
  if (!c) { cur.clipMode = null; return; }
  const v = video();
  if (v.currentTime >= c.out - 0.02) {
    if (cm.loop) { seek(c.in, true); void v.play(); } else { v.pause(); cur.clipMode = null; paintBar(); }
  }
}

// ------------------------------------------------------------- freezes

// A freeze: { id, t, hold, elements } - crossing it during real playback
// pauses on the frame, paints the drawing, waits, rolls on. A seek or scrub
// never fires the freezes it flew over (tick gap rule from Film Room).
function activeFreezes() { return cur?.game.freezes || []; }

let freezeHold = null;
function cancelFreezeHold() {
  if (!freezeHold) return;
  clearTimeout(freezeHold.timer);
  freezeHold = null;
  clearOverlay();
}
function freezeTick() {
  const v = video();
  const t = v.currentTime;
  const prev = cur.prevTick;
  cur.prevTick = t;
  if (freezeHold || v.paused || prev == null) return;
  if (t - prev <= 0 || t - prev > 0.75) return; // a jump, not playback
  const hit = activeFreezes().find((f) => f.t > prev && f.t <= t && f.id !== cur.lastFreeze);
  if (!hit) return;
  cur.lastFreeze = hit.id;
  v.pause();
  v.currentTime = hit.t;
  drawFreezeOverlay(hit);
  freezeHold = {
    id: hit.id,
    timer: setTimeout(() => {
      const was = freezeHold;
      freezeHold = null;
      clearOverlay();
      if (was) void v.play();
    }, (hit.hold || 3) * 1000),
  };
}

function overlayCtx() {
  const c = el('vpOverlay');
  const v = video();
  if (c.width !== v.videoWidth || c.height !== v.videoHeight) {
    c.width = v.videoWidth || 1280;
    c.height = v.videoHeight || 720;
  }
  return c.getContext('2d');
}
function clearOverlay() {
  const c = el('vpOverlay');
  c.getContext('2d').clearRect(0, 0, c.width, c.height);
  c.style.display = 'none';
}
function drawFreezeOverlay(f) {
  const c = el('vpOverlay');
  const ctx = overlayCtx();
  ctx.clearRect(0, 0, c.width, c.height);
  for (const x of f.elements || []) drawEl(ctx, x);
  c.style.display = 'block';
}

function addFreezeHere() {
  const v = video();
  v.pause();
  cancelFreezeHold();
  const f = { id: uid(), t: v.currentTime, hold: 3, elements: [] };
  cur.game.freezes.push(f);
  scheduleSave();
  drawTimeline();
  if (hooks.onAnnotate) hooks.onAnnotate(f);
}

export function updateFreeze(f) {
  const i = cur.game.freezes.findIndex((x) => x.id === f.id);
  if (i >= 0) cur.game.freezes[i] = f;
  scheduleSave();
  drawTimeline();
}
export function removeFreeze(id) {
  cur.game.freezes = cur.game.freezes.filter((f) => f.id !== id);
  scheduleSave();
  drawTimeline();
}

// ------------------------------------------------------------- timeline

const TL = { h: 66, top: 8, lane: 26, freezeY: 46 };

function tlCanvas() { return el('vpTimeline'); }
function tlScale() {
  const c = tlCanvas();
  return c.clientWidth / Math.max(0.001, cur.duration);
}

function drawTimeline() {
  const c = tlCanvas();
  if (!c || !cur) return;
  const dpr = window.devicePixelRatio || 1;
  const W = c.clientWidth; const H = TL.h;
  if (c.width !== W * dpr || c.height !== H * dpr) { c.width = W * dpr; c.height = H * dpr; }
  const ctx = c.getContext('2d');
  ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  ctx.clearRect(0, 0, W, H);
  const px = (t) => (t / Math.max(0.001, cur.duration)) * W;

  // ground + minute ticks
  ctx.fillStyle = '#f2f2f2';
  ctx.fillRect(0, TL.top, W, TL.lane);
  ctx.fillStyle = '#d9d9d9';
  for (let m = 60; m < cur.duration; m += 60) ctx.fillRect(px(m), TL.top, 1, TL.lane);

  // clip spans
  for (const cl of cur.game.clips) {
    const x = px(cl.in); const w = Math.max(2, px(cl.out) - x);
    ctx.fillStyle = cl.color || '#3b82f6';
    ctx.globalAlpha = cl.id === cur.sel ? 0.95 : 0.55;
    ctx.beginPath();
    ctx.roundRect(x, TL.top + 2, w, TL.lane - 4, 4);
    ctx.fill();
    ctx.globalAlpha = 1;
    if (cl.id === cur.sel) {
      ctx.strokeStyle = '#1a1a1a';
      ctx.lineWidth = 1.5;
      ctx.stroke();
      // trim handles
      ctx.fillStyle = '#1a1a1a';
      ctx.fillRect(x - 2, TL.top, 4, TL.lane);
      ctx.fillRect(x + w - 2, TL.top, 4, TL.lane);
    }
  }

  // freezes
  for (const f of activeFreezes()) {
    const x = px(f.t);
    ctx.fillStyle = '#0ea5e9';
    ctx.beginPath();
    ctx.moveTo(x, TL.freezeY);
    ctx.lineTo(x + 5, TL.freezeY + 6);
    ctx.lineTo(x, TL.freezeY + 12);
    ctx.lineTo(x - 5, TL.freezeY + 6);
    ctx.closePath();
    ctx.fill();
  }

  // playhead (tracks the gesture target while a scrub or drag runs)
  const x = px(headTime());
  ctx.fillStyle = '#1a1a1a';
  ctx.fillRect(x - 1, 0, 2, H);
  ctx.beginPath();
  ctx.moveTo(x - 6, 0); ctx.lineTo(x + 6, 0); ctx.lineTo(x, 7);
  ctx.closePath();
  ctx.fill();
}

let tlDrag = null; // {kind:'seek'|'in'|'out', id}
function tlPointT(e) {
  const r = tlCanvas().getBoundingClientRect();
  return ((e.clientX - r.left) / r.width) * cur.duration;
}
function onTlDown(e) {
  if (!cur) return;
  e.preventDefault();
  const t = tlPointT(e);
  const c = selClip();
  const tol = 6 / tlScale();
  if (c && Math.abs(t - c.in) < tol) tlDrag = { kind: 'in', id: c.id };
  else if (c && Math.abs(t - c.out) < tol) tlDrag = { kind: 'out', id: c.id };
  else {
    // click inside a clip selects it; anywhere seeks
    const hit = [...cur.game.clips].reverse().find((x) => t >= x.in && t <= x.out);
    if (hit && hit.id !== cur.sel) setSel(hit.id);
    tlDrag = { kind: 'seek' };
    cancelFreezeHold();
    queueSeek(t);
  }
  tlCanvas().setPointerCapture?.(e.pointerId);
}
function onTlMove(e) {
  if (!tlDrag || !cur) return;
  const t = tlPointT(e);
  // Same batched pipe the trackpad scrub uses: a fast drag emits pointer
  // events quicker than the video can seek, so per-event seeks stutter here
  // for exactly the same reason they did on the stage.
  if (tlDrag.kind === 'seek') { queueSeek(t); return; }
  const c = cur.game.clips.find((x) => x.id === tlDrag.id);
  if (!c) return;
  if (tlDrag.kind === 'in') c.in = Math.max(0, Math.min(c.out - 0.3, t));
  else c.out = Math.min(cur.duration, Math.max(c.in + 0.3, t));
  drawTimeline();
  paintLog();
}
function onTlUp() {
  if (!tlDrag) return;
  if (tlDrag.kind === 'seek') settleSeek();
  else scheduleSave();
  tlDrag = null;
}

// ------------------------------------------------------------- tag bar

function keyBadge(k) { return k ? `<span class="tag-key">${esc(k.toUpperCase())}</span>` : ''; }

// The tag buttons live in a slim vertical side panel (moved from a two-row
// bar under the timeline, 2026-08-25, Tony's call): the rows were the widest
// thing under the video and the height they took came straight out of the
// picture. A narrow column costs the stage almost nothing and scrolls when
// the button list grows.
function paintBar() {
  const bar = el('vpSide');
  if (!bar || !cur) return;
  const c = selClip();
  const t1 = panelButtons(1).map((b) => `
    <button class="tag-btn" data-clipbtn="${b.id}" style="--c:${b.color}" title="${esc(b.label)}: Clip ${b.lead}s Before To ${b.lag}s After The Playhead">
      <span class="tag-btn-word">${esc(b.label)}</span>${keyBadge(b.key)}
    </button>`).join('');
  const t2 = panelButtons(2).map((b) => `
    <button class="tag-btn tag-btn-tag${c?.tags.includes(b.label) ? ' on' : ''}" data-tagbtn="${b.id}" style="--c:${b.color}" title="Toggle #${esc(b.label)} On The Selected Clip">
      <span class="tag-btn-word">#${esc(b.label)}</span>${keyBadge(b.key)}
    </button>`).join('');
  bar.innerHTML = `
    <div class="side-label">Clip Buttons</div>
    ${t1}
    <div class="side-label">Tags</div>
    ${t2}
    ${cur.clipMode ? `<button class="tag-btn tag-btn-mode on" data-act="exitClip">Playing Clip - Esc Exits</button>` : ''}
    <button class="tag-btn tag-edit" data-act="editPanel" title="Edit Buttons, Keys, Colors, Lead And Lag">Edit Buttons</button>`;
  bar.querySelectorAll('[data-clipbtn]').forEach((b) => {
    b.onclick = () => pressClipButton(cur.settings.panel.buttons.find((x) => x.id === b.dataset.clipbtn));
  });
  bar.querySelectorAll('[data-tagbtn]').forEach((b) => {
    b.onclick = () => pressTagButton(cur.settings.panel.buttons.find((x) => x.id === b.dataset.tagbtn));
  });
  const ep = bar.querySelector('[data-act="editPanel"]');
  if (ep) ep.onclick = () => openPanelEditor();
  const ec = bar.querySelector('[data-act="exitClip"]');
  if (ec) ec.onclick = () => { cur.clipMode = null; paintBar(); };
}

// ------------------------------------------------------------- clip log

const view = { search: '', sort: 'timedesc', label: '', tag: '' };

function filteredClips() {
  let list = [...cur.game.clips];
  if (view.search) {
    const q = view.search.toLowerCase();
    list = list.filter((c) => clipName(c).toLowerCase().includes(q) || (c.note || '').toLowerCase().includes(q));
  }
  if (view.label) list = list.filter((c) => c.label === view.label);
  if (view.tag) list = list.filter((c) => c.tags.includes(view.tag));
  list.sort((a, b) => (view.sort === 'timedesc' ? b.in - a.in : a.in - b.in));
  return list;
}

// A write-in tag, normalized to the style the defaults use: no leading #,
// no spaces (they become dashes), never empty.
export const normTag = (raw) => (raw || '').trim().replace(/^#+/, '').replace(/\s+/g, '-').toLowerCase();

// The log lives full-width under the video (moved from a 300px right rail,
// 2026-08-25, Tony's call), so a row has real horizontal room: name and time
// on the left, then the clip's tags as chips with a write-in box, actions on
// the right. The rail's stacked two-line rows wasted the one thing tags
// need, which is width.
export function paintLog() {
  const log = el('vpLog');
  if (!log || !cur) return;
  const labels = [...new Set(cur.game.clips.map((c) => c.label))];
  const tags = [...new Set(cur.game.clips.flatMap((c) => c.tags))];
  const tagOpts = [...new Set([...panelButtons(2).map((b) => b.label), ...tags])];
  const list = filteredClips();
  // Keep the caret alive across a repaint, for the search box and for
  // whichever row's write-in box is being typed in.
  const ae = document.activeElement;
  const keepSearch = ae === el('vpLogSearch') ? ae.selectionStart : null;
  const keepTagRow = ae?.dataset?.tagrow || null;
  const keepTagVal = keepTagRow ? ae.value : '';
  log.innerHTML = `
    <div class="log-head">
      <input id="vpLogSearch" type="search" placeholder="Search Clips…" value="${esc(view.search)}" autocomplete="off">
      <select id="vpLogLabel" title="Filter By Clip Button">
        <option value="">All Clips</option>
        ${labels.map((l) => `<option${view.label === l ? ' selected' : ''}>${esc(l)}</option>`).join('')}
      </select>
      <select id="vpLogTag" title="Filter By Tag">
        <option value="">All Tags</option>
        ${tags.map((t) => `<option${view.tag === t ? ' selected' : ''}>${esc(t)}</option>`).join('')}
      </select>
      <button class="mini" id="vpLogSort" title="Flip Sort Order">${view.sort === 'timedesc' ? 'Newest' : 'Timeline'}</button>
      <div class="log-count">${list.length} Of ${cur.game.clips.length} Clip${cur.game.clips.length === 1 ? '' : 's'}</div>
    </div>
    <datalist id="vpTagOpts">${tagOpts.map((t) => `<option value="${esc(t)}">`).join('')}</datalist>
    <div class="log-list">
      ${list.map((c) => `
        <div class="log-row${c.id === cur.sel ? ' on' : ''}" data-id="${c.id}">
          <span class="log-dot" style="--c:${c.color || '#3b82f6'}"></span>
          <span class="log-name" title="Double-Click To Rename">${esc(c.name || c.label)}</span>
          <span class="log-time">${fmtTime(c.in)} - ${fmtTime(c.out)}</span>
          <span class="log-tags">
            ${c.tags.map((t) => `<span class="tag-chip">#${esc(t)}<button data-rmtag="${esc(t)}" title="Remove #${esc(t)}">&times;</button></span>`).join('')}
            <input class="log-tagin" data-tagrow="${c.id}" list="vpTagOpts" placeholder="+ Tag" autocomplete="off"
              title="Type A Tag And Press Enter - It Lands On This Clip">
          </span>
          <span class="log-acts">
            <button class="mini" data-do="play" title="Play This Clip">Play</button>
            <button class="mini" data-do="share" title="Share, Export, Embed, Email">Share</button>
            <button class="mini mini-danger" data-do="del" title="Delete This Clip">&times;</button>
          </span>
        </div>`).join('') || '<div class="log-empty">No Clips Yet - Press A Tag Button (Or Its Key) While The Video Plays.</div>'}
    </div>`;
  el('vpLogSearch').addEventListener('input', (e) => { view.search = e.target.value; paintLog(); });
  el('vpLogSearch').addEventListener('keydown', (e) => e.stopPropagation());
  if (keepSearch != null) { const s = el('vpLogSearch'); s.focus(); s.setSelectionRange(keepSearch, keepSearch); }
  el('vpLogLabel').onchange = (e) => { view.label = e.target.value; paintLog(); };
  el('vpLogTag').onchange = (e) => { view.tag = e.target.value; paintLog(); };
  el('vpLogSort').onclick = () => { view.sort = view.sort === 'timedesc' ? 'timeline' : 'timedesc'; paintLog(); };
  log.querySelectorAll('.log-row').forEach((row) => {
    const id = row.dataset.id;
    const clip = () => cur.game.clips.find((x) => x.id === id);
    row.addEventListener('click', (e) => {
      if (e.target.closest('.mini') || e.target.closest('.tag-chip') || e.target.closest('.log-tagin')) return;
      const c = clip();
      setSel(id);
      seek(c.in);
    });
    row.addEventListener('dblclick', (e) => {
      if (e.target.closest('.mini') || e.target.closest('.tag-chip') || e.target.closest('.log-tagin')) return;
      const c = clip();
      const name = prompt('Clip Name', c.name || c.label);
      if (name != null) { c.name = name.trim(); scheduleSave(); paintLog(); }
    });
    row.querySelectorAll('[data-rmtag]').forEach((x) => {
      x.onclick = () => {
        const c = clip();
        c.tags = c.tags.filter((t) => t !== x.dataset.rmtag);
        scheduleSave(); paintLog(); drawTimeline();
      };
    });
    const tin = row.querySelector('.log-tagin');
    tin.addEventListener('keydown', (e) => {
      e.stopPropagation();
      if (e.key !== 'Enter' && e.key !== ',') return;
      e.preventDefault();
      const t = normTag(tin.value);
      if (!t) return;
      const c = clip();
      if (!c.tags.includes(t)) c.tags = [...c.tags, t];
      tin.value = '';
      scheduleSave(); paintLog(); drawTimeline();
    });
    if (keepTagRow === id) { tin.focus(); tin.value = keepTagVal; }
    row.querySelector('[data-do="play"]').onclick = () => enterClipMode(id, { loop: false });
    row.querySelector('[data-do="share"]').onclick = (e) => {
      if (hooks.onShare) hooks.onShare(clip(), e.currentTarget);
    };
    row.querySelector('[data-do="del"]').onclick = () => {
      cur.game.clips = cur.game.clips.filter((x) => x.id !== id);
      if (cur.sel === id) cur.sel = null;
      scheduleSave();
      paintLog();
      drawTimeline();
      toast('Clip Deleted');
    };
  });
}

// ------------------------------------------------------------- panel editor

function openPanelEditor() {
  document.querySelector('.sheet-veil')?.remove();
  const wrap = document.createElement('div');
  wrap.className = 'sheet-veil';
  const row = (b) => `
    <div class="pe-row" data-id="${b.id}">
      <input class="pe-color" type="color" value="${b.color}" title="Button Color">
      <input class="pe-label" value="${esc(b.label)}" placeholder="Label">
      <input class="pe-key" value="${esc(b.key || '')}" maxlength="1" placeholder="Key" title="Hotkey">
      ${b.tier === 1 ? `
        <input class="pe-num" type="number" value="${b.lead ?? 8}" min="0" max="120" title="Seconds Before The Playhead">
        <input class="pe-num" type="number" value="${b.lag ?? 4}" min="0" max="120" title="Seconds After The Playhead">` : '<span class="pe-spacer"></span>'}
      <button class="mini mini-danger" data-del title="Remove">&times;</button>
    </div>`;
  wrap.innerHTML = `
    <div class="sheet sheet-wide" role="dialog" aria-modal="true">
      <h3>Tag Buttons</h3>
      <p>Clip Buttons mark a clip at the playhead (lead seconds before, lag after). Tag Buttons toggle a #tag on the selected clip. Keys are one letter.</p>
      <div class="pe-title">Clip Buttons <span class="pe-cols">Color &middot; Label &middot; Key &middot; Lead &middot; Lag</span></div>
      <div id="peT1">${panelButtons(1).map(row).join('')}</div>
      <button class="mini" id="peAdd1">+ Clip Button</button>
      <div class="pe-title">Tag Buttons</div>
      <div id="peT2">${panelButtons(2).map(row).join('')}</div>
      <button class="mini" id="peAdd2">+ Tag Button</button>
      <div class="sheet-row">
        <button class="btn" data-x="cancel">Cancel</button>
        <button class="btn btn-ink" data-x="save">Save Buttons</button>
      </div>
    </div>`;
  document.body.appendChild(wrap);
  wrap.querySelector('#peAdd1').onclick = () => {
    wrap.querySelector('#peT1').insertAdjacentHTML('beforeend', row({ id: uid(), tier: 1, label: 'New', key: '', color: '#3b82f6', lead: 8, lag: 4 }));
  };
  wrap.querySelector('#peAdd2').onclick = () => {
    wrap.querySelector('#peT2').insertAdjacentHTML('beforeend', row({ id: uid(), tier: 2, label: 'new-tag', key: '', color: '#0ea5e9' }));
  };
  wrap.addEventListener('click', (e) => {
    if (e.target.closest('[data-del]')) e.target.closest('.pe-row').remove();
    if (e.target === wrap) wrap.remove();
  });
  wrap.querySelector('[data-x="cancel"]').onclick = () => wrap.remove();
  wrap.querySelector('[data-x="save"]').onclick = async () => {
    const read = (root, tier) => [...root.querySelectorAll('.pe-row')].map((r) => {
      const nums = r.querySelectorAll('.pe-num');
      return {
        id: r.dataset.id,
        tier,
        label: r.querySelector('.pe-label').value.trim() || 'Untitled',
        key: r.querySelector('.pe-key').value.trim().toLowerCase(),
        color: r.querySelector('.pe-color').value,
        ...(tier === 1 ? { lead: Number(nums[0].value) || 0, lag: Number(nums[1].value) || 0 } : {}),
      };
    });
    cur.settings.panel.buttons = [...read(wrap.querySelector('#peT1'), 1), ...read(wrap.querySelector('#peT2'), 2)];
    await putSettings(cur.settings);
    wrap.remove();
    paintBar();
    toast('Buttons Saved');
  };
}

// ------------------------------------------------------------- keyboard

function onKey(e) {
  if (!cur) return;
  const t = e.target;
  if (t && (t.tagName === 'INPUT' || t.tagName === 'TEXTAREA' || t.tagName === 'SELECT' || t.isContentEditable)) return;
  if (document.querySelector('.sheet-veil') || document.querySelector('.an-root:not([hidden])')) return;
  if (e.metaKey || e.ctrlKey) return;
  const k = e.key.toLowerCase();
  const stop = () => e.preventDefault();

  if (e.key === ' ') { stop(); togglePlay(); return; }
  if (e.key === 'ArrowLeft') { stop(); seek(video().currentTime - (e.shiftKey ? 15 : 5)); return; }
  if (e.key === 'ArrowRight') { stop(); seek(video().currentTime + (e.shiftKey ? 15 : 5)); return; }
  if (e.key === ',') { stop(); frameStep(-1); return; }
  if (e.key === '.') { stop(); frameStep(1); return; }
  if (k === 'j') { stop(); setSpeed(Math.max(0.25, SPEEDS[Math.max(0, SPEEDS.indexOf(video().playbackRate) - 1)] || 0.5)); return; }
  if (k === 'k') { stop(); togglePlay(); return; }
  if (k === 'l') { stop(); setSpeed(SPEEDS[Math.min(SPEEDS.length - 1, SPEEDS.indexOf(video().playbackRate) + 1)] || 1.5); return; }
  if (k === 'i' && selClip()) { stop(); const c = selClip(); c.in = Math.min(video().currentTime, c.out - 0.3); scheduleSave(); drawTimeline(); paintLog(); toast('Clip In Set'); return; }
  if (k === 'o' && selClip()) { stop(); const c = selClip(); c.out = Math.max(video().currentTime, c.in + 0.3); scheduleSave(); drawTimeline(); paintLog(); toast('Clip Out Set'); return; }
  if (k === 'f') { stop(); addFreezeHere(); return; }
  if ((e.key === 'Backspace' || e.key === 'Delete') && selClip()) {
    stop();
    cur.game.clips = cur.game.clips.filter((x) => x.id !== cur.sel);
    cur.sel = null;
    scheduleSave(); paintLog(); drawTimeline();
    toast('Clip Deleted');
    return;
  }
  if (e.key === 'Escape') {
    stop();
    if (cur.clipMode) { cur.clipMode = null; paintBar(); return; }
    if (cur.sel) setSel(null);
    return;
  }
  const btn = cur.settings.panel.buttons.find((b) => b.key && b.key === k);
  if (btn) {
    stop();
    if (btn.tier === 1) pressClipButton(btn); else pressTagButton(btn);
  }
}

// ------------------------------------------------------------- clock/loop

function paintClock() {
  const c = el('vpClock');
  if (c && cur) c.textContent = `${fmtTime(headTime(), true)} / ${fmtTime(cur.duration)}`;
}

function raf() {
  if (!cur) return;
  freezeTick();
  clipModeTick();
  drawTimeline();
  paintClock();
  cur.raf = requestAnimationFrame(raf);
}

// ------------------------------------------------------------- export

// Record a clip's segment in real time off the element - a genuine video
// file with audio, no dependencies. A 30s clip takes 30s to render.
export async function recordClip(c, onProgress) {
  const v = video();
  if (!v.captureStream) throw new Error('This Browser Cannot Record Video - Use Chrome');
  v.pause();
  cancelFreezeHold();
  const stream = v.captureStream();
  const mime = ['video/mp4', 'video/webm;codecs=vp9', 'video/webm'].find((m) => MediaRecorder.isTypeSupported(m));
  const rec = new MediaRecorder(stream, { mimeType: mime, videoBitsPerSecond: 8_000_000 });
  const parts = [];
  rec.ondataavailable = (e) => { if (e.data.size) parts.push(e.data); };
  seek(c.in, true);
  await new Promise((res) => { v.onseeked = res; });
  await v.play();
  rec.start(500);
  await new Promise((res) => {
    const iv = setInterval(() => {
      if (onProgress) onProgress(Math.min(1, (v.currentTime - c.in) / (c.out - c.in)));
      if (v.currentTime >= c.out || v.paused) { clearInterval(iv); res(); }
    }, 120);
  });
  v.pause();
  rec.stop();
  await new Promise((res) => { rec.onstop = res; });
  return { blob: new Blob(parts, { type: mime }), ext: mime.includes('mp4') ? 'mp4' : 'webm' };
}

// A poster + composite for annotated frame export.
export function grabFrame() {
  const v = video();
  const c = document.createElement('canvas');
  c.width = v.videoWidth; c.height = v.videoHeight;
  c.getContext('2d').drawImage(v, 0, 0);
  return c;
}

// ------------------------------------------------------------- open/close

export function playerGame() { return cur?.game || null; }
export function playerSettings() { return cur?.settings || null; }

export async function openPlayer(game, videoUrl, h = {}) {
  hooks = h || {};
  cur = {
    game,
    settings: await getSettings(),
    sel: null,
    clipMode: null,
    duration: game.duration || 0,
    prevTick: null,
    lastFreeze: null,
    timer: null,
    raf: 0,
  };
  game.clips = game.clips || [];
  game.freezes = game.freezes || [];
  const v = video();
  v.src = videoUrl;
  v.addEventListener('loadedmetadata', () => {
    cur.duration = v.duration;
    if (game.duration !== v.duration) { game.duration = v.duration; scheduleSave(); }
    drawTimeline();
    paintClock();
  }, { once: true });
  wireOnce();
  paintBar();
  paintLog();
  status('Saved');
  raf();
}

export async function closePlayer() {
  if (!cur) return;
  cancelAnimationFrame(cur.raf);
  cancelFreezeHold();
  await saveNow();
  const v = el('vpVideo');
  if (v) { v.pause(); v.removeAttribute('src'); v.load(); }
  cur = null;
}

function wireOnce() {
  const stage = el('vpStage');
  stage.addEventListener('wheel', onStageWheel, { passive: false });
  el('vpVideo').addEventListener('click', togglePlay);
  // rAF stops in background tabs; the media clock does not. timeupdate keeps
  // freezes and clip bounds firing even when the tab is not compositing.
  el('vpVideo').addEventListener('timeupdate', () => { if (cur) { freezeTick(); clipModeTick(); } });
  const tl = tlCanvas();
  tl.addEventListener('pointerdown', onTlDown);
  tl.addEventListener('pointermove', onTlMove);
  window.addEventListener('pointerup', onTlUp);
  el('vpPlay').onclick = togglePlay;
  el('vpBack5').onclick = () => seek(video().currentTime - 5);
  el('vpFwd5').onclick = () => seek(video().currentTime + 5);
  el('vpFrameB').onclick = () => frameStep(-1);
  el('vpFrameF').onclick = () => frameStep(1);
  el('vpSpeed').onclick = () => setSpeed(SPEEDS[(SPEEDS.indexOf(video().playbackRate) + 1) % SPEEDS.length]);
  el('vpFreeze').onclick = addFreezeHere;
  if (!wired) {
    wired = true;
    window.addEventListener('keydown', onKey);
    window.addEventListener('resize', () => drawTimeline());
  }
}
