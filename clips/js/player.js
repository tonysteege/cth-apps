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
import { openScrubSource, releaseScrubSource, scrubProviderFor } from './scrubsource.js';
import { toast, esc } from './ui.js';
import { ctxMenu } from '/diagrams/js/ui.js';
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

// H:MM:SS, the clip log's and the transport's format (2026-08-25, Tony's
// call, mChapters' own): a game is an hour long, so minutes-only reads
// wrong past 60, and tenths are noise when you are scanning a list.
export const fmtHMS = (t) => {
  if (!isFinite(t)) return '0:00:00';
  const s = Math.max(0, Math.floor(t));
  const h = Math.floor(s / 3600);
  const m = Math.floor((s % 3600) / 60);
  return `${h}:${String(m).padStart(2, '0')}:${String(s % 60).padStart(2, '0')}`;
};

// A button label is capped at 7 characters (Tony's call): the tag column is
// slim by design and a long word either wraps it wider or gets cut mid-air.
// Cutting at source keeps every chip the same shape.
export const BTN_MAX = 7;
export const btnLabel = (s) => (s || '').slice(0, BTN_MAX);

// A tag button is a SOLID button in its own colour (2026-08-26, Tony's
// call, replacing the white chip with a colour dot). The label therefore
// sits on an arbitrary user-picked colour, so the text colour has to be
// computed rather than fixed: white on Ink, ink on Light Grey. WCAG
// relative luminance, with the usual 0.5 knee. Handed to CSS as --fg.
export function btnFg(hex) {
  const raw = String(hex || '').trim().replace('#', '');
  const v = raw.length === 3 ? raw.split('').map((c) => c + c).join('') : raw;
  if (!/^[0-9a-fA-F]{6}$/.test(v)) return '#ffffff';
  const n = parseInt(v, 16);
  const lin = [(n >> 16) & 255, (n >> 8) & 255, n & 255].map((c) => {
    const x = c / 255;
    return x <= 0.03928 ? x / 12.92 : Math.pow((x + 0.055) / 1.055, 2.4);
  });
  const L = 0.2126 * lin[0] + 0.7152 * lin[1] + 0.0722 * lin[2];
  return L > 0.5 ? '#0a0a0a' : '#ffffff';
}

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

// Everything in a tier, dividers included, in stored order (the order IS
// the display order, both here and in the editor).
function panelItems(tier) {
  return (cur?.settings.panel.buttons || []).filter((b) => b.tier === tier);
}
// Only the pressable ones - hotkeys and tag toggles skip dividers.
function panelButtons(tier) {
  return panelItems(tier).filter((b) => !b.divider);
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
  pushUndo({ kind: 'clip', id: c.id });
  setSel(c.id);
  scheduleSave();
  status('Edited');
  toast(`${b.label} Marked At ${fmtTime(t)}`);
}

function pressTagButton(b) {
  const c = selClip();
  if (!c) { toast('Select A Clip First - Tags Attach To A Clip', true); return; }
  const has = c.tags.includes(b.label);
  pushUndo({ kind: 'tags', id: c.id, tags: [...c.tags] });
  c.tags = has ? c.tags.filter((t) => t !== b.label) : [...c.tags, b.label];
  paintLog();
  drawTimeline();
  scheduleSave();
  toast(has ? `#${b.label} Removed` : `#${b.label} Added`);
}

// ------------------------------------------------------------- transport

export function seek(t, keepFreeze = false) {
  const v = video();
  abortScrub(); // an explicit seek wins over a gesture still in flight
  v.currentTime = Math.max(0, Math.min(cur?.duration || v.duration || 0, t));
  if (!keepFreeze) cancelFreezeHold();
  cur.prevTick = null;
  drawTimeline();
  paintClock();
}

// --- The scrub engine: CTH Film Room's attachScrub, whole ----------------
//
// Ported 2026-08-25 from film-room/renderer/js/player.js AND its decoder
// (scrubsource.js), because the spring alone was not enough: every element
// seek still cost ~28ms and re-decoded from the previous keyframe, and that
// unevenness is what Tony kept filming as chop. The engine has three layers:
//
//   1. scrubDeltaSeconds turns wheel events into media seconds (velocity
//      based, asinh knee, integrated over each event's real elapsed time).
//   2. scrubMotionStep eases the PAINTED position onto the finger - `aim` is
//      the raw target, `pos` is what we paint, and readouts follow `pos`.
//   3. The pump asks OUR OWN DECODER first (scrubsource.js): it paints
//      decoded frames onto an overlay canvas at display rate, so a step
//      costs ~2ms instead of a 28ms seek. Only when the decoder cannot serve
//      does the element get seeked - snapped to a keyframe when the keyframe
//      is nearer than the step being taken. On release the element takes the
//      exact final frame and the overlay drops only once it has it.
//
// The decoder is optional by design: webm, fragmented mp4, unsupported
// codecs, rotated files and range-refusing servers all just mean layer 3
// falls back to seeks - the pre-decoder behaviour, spring intact.
const FRAME_DUR = 1 / 30; // honest default; the browser will not report real fps

export function scrubDeltaSeconds(deltaX, dtMs, sensitivity = 1, fine = false) {
  const dt = Math.max(4, Math.min(40, Number(dtMs) || 8));
  const rawV = Math.abs(Number(deltaX) || 0) / dt;
  const knee = 0.65;
  const v = knee * Math.asinh(rawV / knee);
  const scale = fine ? 0.002 : 0.015;
  return Math.sign(deltaX || 0) * v * dt * scale * Math.max(0.3, Math.min(3, sensitivity || 1));
}

export function scrubMotionStep(pos, aim, dtMs, frameRate = 30) {
  const gap = aim - pos;
  if (Math.abs(gap) < 0.5 / Math.max(10, frameRate || 30)) return aim;
  const x = Math.max(0, Math.min(1, (Math.abs(gap) - 0.08) / 1.42));
  const blend = x * x * (3 - 2 * x);
  const tau = 46 + (18 - 46) * blend;
  const alpha = 1 - Math.exp(-Math.max(4, Math.min(40, dtMs || 8)) / tau);
  return pos + gap * alpha;
}

// The decoder source for the OPEN video (null = plain seeking). Owned by
// openPlayer/closePlayer; the gesture borrows it via gestureSrc.
let scrubSrc = null;
let gestureSrc = null;   // the source THIS gesture is painting from, if any
let paint = null;        // the overlay canvas while it is showing
let pctx = null;
let lastPaintT = null;   // media time of the frame the overlay shows

const seekState = {
  aim: null, pos: null, raf: 0, timer: 0,
  busy: false, ourSeekT: null, unlock: 0,
  lastPumpAt: 0, lastPumped: null,
};

// Warm the decoder wherever the playhead rests, so the next gesture starts
// with frames already decoded around it instead of walking a keyframe run
// while <video> covers. Debounced, never against playback or a live gesture.
let primeTimer = 0;
function primeSoon(delay = 350) {
  clearTimeout(primeTimer);
  primeTimer = setTimeout(() => {
    const v = video();
    if (!cur || !scrubSrc || seekState.pos != null) return;
    if (v.paused && v.readyState >= 1) scrubSrc.prime(v.currentTime);
  }, delay);
}

// The overlay lives on the stage beside the video; both are inset:0 with
// object-fit contain, so the swap between them is pixel-invisible.
function startPaint(source) {
  const v = video();
  if (v.readyState < 2) return false;
  const stage = el('vpStage');
  if (!stage) return false;
  let c = stage.querySelector(':scope > canvas.scrub-paint');
  if (!c) {
    c = document.createElement('canvas');
    c.className = 'scrub-paint';
    stage.insertBefore(c, v.nextSibling);
  }
  // THE OVERLAY IS SIZED TO THE VIDEO, NOT TO THE DECODER (2026-08-26).
  // It used to take the decoder cache's dimensions, which are capped for
  // memory - so the first thing every gesture did was copy the full-res
  // <video> frame DOWN to 1280 wide and show that. On a 1080p or 4K game
  // that is visibly softer than the file, and since the overlay is up for
  // the whole gesture and the moment after it, scrubbing looked like the
  // video itself had lost quality. Painting at native size costs one
  // full-frame buffer (8MB at 1080p) and nothing per step.
  const vw = v.videoWidth || source.width;
  const vh = v.videoHeight || source.height;
  if (c.width !== vw || c.height !== vh) { c.width = vw; c.height = vh; }
  paint = c;
  pctx = c.getContext('2d', { alpha: false });
  pctx.imageSmoothingQuality = 'high';
  try { pctx.drawImage(v, 0, 0, c.width, c.height); } catch (_) { paint = null; pctx = null; return false; }
  lastPaintT = v.currentTime;
  c.classList.add('on');
  return true;
}

// Hand the real video the final position and only then drop the overlay -
// hiding it first would flash whatever frame the element was left on.
// `external` = an outside seek is already in flight: keep the overlay until
// IT lands, and never counter-seek it.
function settle(finalPos, external = false) {
  if (!paint) return;
  const v = video();
  const c = paint;
  paint = null; pctx = null;
  let tid = null;
  const done = () => { v.removeEventListener('seeked', done); clearTimeout(tid); c.classList.remove('on'); };
  if (external) {
    v.addEventListener('seeked', done);
    tid = setTimeout(done, 700);
    return;
  }
  if (finalPos == null || Math.abs(v.currentTime - finalPos) < FRAME_DUR / 2) { done(); return; }
  v.addEventListener('seeked', done);
  tid = setTimeout(done, 700); // a seek that never lands must not strand it
  v.currentTime = finalPos;
}

// One refresh of work: ease toward the finger, ask the decoder, fall back to
// an element seek only when it cannot serve.
function pump() {
  seekState.raf = 0;
  clearTimeout(seekState.timer);
  seekState.timer = 0;
  if (!cur || seekState.pos == null || seekState.aim == null) return;
  const v = video();
  const now = performance.now();
  const dt = Math.max(4, now - (seekState.lastPumpAt || now - 8));
  seekState.pos = scrubMotionStep(seekState.pos, seekState.aim, dt, 1 / FRAME_DUR);
  const travel = Math.abs(seekState.pos - (seekState.lastPumped == null ? seekState.pos : seekState.lastPumped));
  // Demand in video-frames per SECOND: per-refresh would read differently on
  // a 120Hz panel than a 60Hz one and the decoder's throughput is the same.
  const speed = (travel / FRAME_DUR) / (dt / 1000);
  seekState.lastPumped = seekState.pos;
  seekState.lastPumpAt = now;
  drawTimeline();
  paintClock();

  let served = false;
  if (gestureSrc && paint) {
    // A served frame may sit a hair off the finger while the decoder catches
    // up - a little over one refresh of travel, so the error is always
    // smaller than the motion itself.
    const tol = Math.max(FRAME_DUR * 1.5, travel * 1.25);
    const r = gestureSrc.request(seekState.pos, speed, tol);
    if (r) { pctx.drawImage(r.c, 0, 0, paint.width, paint.height); lastPaintT = r.t; served = true; }
  }
  if (window.__scrubTrace) {
    const st = gestureSrc && gestureSrc.stats;
    window.__scrubTrace.push({ at: now, aim: seekState.aim, pos: seekState.pos, shown: lastPaintT, served, speed,
      hit: st && st.hit, near: st && st.near, fb: st && st.fallback, dec: st && st.decoded, rs: st && st.reseed });
  }

  if (!served && !seekState.busy && Math.abs(seekState.pos - v.currentTime) >= FRAME_DUR / 2) {
    // Snap to a keyframe only when it is nearer than the step being taken -
    // the error is then smaller than the motion, and the seek costs a
    // fraction as much.
    let t = seekState.pos;
    if (gestureSrc) { const kt = gestureSrc.keyTimeBelow(seekState.pos); if (kt != null && seekState.pos - kt <= travel) t = kt; }
    seekState.busy = true;
    seekState.ourSeekT = t;
    v.currentTime = t;
    clearTimeout(seekState.unlock);
    seekState.unlock = setTimeout(() => { seekState.busy = false; }, 250);
  }
  scheduleScrub();
}
function scheduleScrub() {
  if (seekState.pos == null) return;
  if (!seekState.raf) seekState.raf = requestAnimationFrame(pump);
  // rAF stops in hidden or occluded windows; the timer backstop keeps a
  // gesture from stranding there.
  if (!seekState.timer) seekState.timer = setTimeout(pump, 33);
}

function clearGestureState() {
  seekState.aim = null;
  seekState.pos = null;
  seekState.lastPumped = null;
  seekState.lastPumpAt = 0;
  seekState.busy = false;
  seekState.ourSeekT = null;
  clearTimeout(seekState.unlock);
  clearTimeout(scrubEndTimer);
  if (seekState.raf) { cancelAnimationFrame(seekState.raf); seekState.raf = 0; }
  clearTimeout(seekState.timer);
  seekState.timer = 0;
}

// The gesture is over: hand the element the exact final frame. `external`
// means an outside seek owns the playhead - let it stand.
function endScrubGesture(external = false) {
  const finalPos = seekState.aim;
  clearGestureState();
  settle(finalPos, external);
  if (!external && cur && finalPos != null && !paint) {
    const v = video();
    if (Math.abs(v.currentTime - finalPos) >= FRAME_DUR / 2) v.currentTime = finalPos;
  }
  if (cur) cur.prevTick = null;
  if (gestureSrc) { gestureSrc.rest(); gestureSrc = null; }
  primeSoon();
}

// Begin a gesture from the current playhead (shared by the trackpad and the
// timeline drag).
function beginGesture() {
  const v = video();
  if (!v.paused) v.pause();
  cancelFreezeHold();
  seekState.aim = seekState.pos = v.currentTime;
  seekState.lastPumped = seekState.pos;
  seekState.lastPumpAt = 0;
  gestureSrc = (scrubSrc && startPaint(scrubSrc)) ? scrubSrc : null;
}

// Drive the engine from something that is not a wheel event - the timeline
// drag, which hands an absolute time rather than a delta.
function scrubTo(t, start = false) {
  if (!cur) return;
  if (start || seekState.pos == null) beginGesture();
  seekState.aim = Math.max(0, Math.min(cur.duration || video().duration || 0, t));
  scheduleScrub();
}

// Drop a live gesture WITHOUT settling it: an explicit seek elsewhere is
// where the user is going, and settling would yank the playhead back.
function abortScrub() {
  clearGestureState();
  if (paint) { const c = paint; paint = null; pctx = null; c.classList.remove('on'); }
  if (gestureSrc) { gestureSrc.rest(); gestureSrc = null; }
}

// While a gesture runs the UI tracks the eased picture position, so the
// playhead and clock never freeze mid-scrub and then leap.
function headTime() { return seekState.pos ?? video().currentTime; }

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

// The wheel handler, ported from Film Room's `attachScrub`. A gesture is a
// stream of wheel events; it ends when they stop for a beat (260ms there,
// kept here - shorter and momentum's own gaps end the gesture early).
//
// Direction: swipe RIGHT advances. macOS natural scrolling delivers a
// NEGATIVE deltaX for a rightward swipe, so the sign is inverted; the
// scrubReverse setting flips it back for anyone on classic scrolling.
const GESTURE_IDLE_MS = 260;
let scrubEndTimer = 0;
let lastWheelAt = 0;

function onStageWheel(e) {
  if (!cur) return;
  if (Math.abs(e.deltaX) <= Math.abs(e.deltaY)) return; // vertical = page scroll
  if (e.ctrlKey) return;                                // pinch-zoom, not a scrub
  e.preventDefault();
  const v = video();
  if (!v.duration) return;
  if (seekState.pos == null) { beginGesture(); lastWheelAt = 0; }
  // Swipe RIGHT advances: macOS natural scrolling reports that as negative
  // deltaX, so the delta is negated; scrubReverse flips it back.
  const dir = cur.settings.scrubReverse ? 1 : -1;
  const sens = cur.settings.scrubSensitivity || 1;
  const at = performance.now();
  const eventDt = lastWheelAt ? at - lastWheelAt : 8;
  lastWheelAt = at;
  const step = scrubDeltaSeconds(e.deltaX, eventDt, sens, e.shiftKey);
  seekState.aim = Math.min(cur.duration || v.duration, Math.max(0, seekState.aim + dir * step));
  scheduleScrub();
  clearTimeout(scrubEndTimer);
  scrubEndTimer = setTimeout(endScrubGesture, GESTURE_IDLE_MS);
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

// SLIM TIMELINE (2026-08-25, Tony's call, mChapters as the reference): the
// old 66px canvas plus a separate 40px transport row spent ~106px of height
// on chrome. This is 30px: the clip lane IS the scrub bar, freeze marks ride
// its bottom edge, and the two timecodes sit on top of the ends rather than
// on a row of their own.
const TL = { h: 30, top: 5, lane: 17, tagY: 24 };

// THE TIMELINE ZOOMS AND SCROLLS (2026-08-27, Tony's call). `view0` is the
// first second on screen and `span` is how many seconds it shows; at zoom 1
// the span is the whole file. A trackpad pinch (ctrl+wheel) or a vertical
// wheel zooms about the pointer, so the frame under the finger stays put;
// a horizontal two-finger swipe scrolls.
const tl = { view0: 0, span: 0 };
function tlSpan() { return tl.span > 0 ? tl.span : Math.max(0.001, cur.duration); }
function tlClamp() {
  const d = Math.max(0.001, cur.duration);
  // span 0 MEANS "fit", and stays 0 until something zooms. The first paint
  // can run before the file's duration is known, and clamping then pinned
  // the span at the 2-second floor - so the timeline opened zoomed into the
  // first two seconds of every video (caught 2026-08-27 in testing).
  if (!tl.span || tl.span >= d) { tl.span = 0; tl.view0 = 0; return; }
  tl.span = Math.max(2, tl.span);
  tl.view0 = Math.min(d - tl.span, Math.max(0, tl.view0));
}
export function tlZoomedIn() { return tl.span > 0 && tl.span < (cur?.duration || 0) - 0.01; }

function tlCanvas() { return el('vpTimeline'); }
function tlScale() {
  const c = tlCanvas();
  return c.clientWidth / tlSpan();
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
  tlClamp();
  const span = tlSpan();
  const px = (t) => ((t - tl.view0) / span) * W;

  // ground + ticks. The tick spacing follows the zoom, so a zoomed-in view
  // does not either vanish its grid or turn it into a solid bar.
  ctx.fillStyle = '#f2f2f2';
  ctx.fillRect(0, TL.top, W, TL.lane);
  ctx.fillStyle = '#d9d9d9';
  const step = [1, 2, 5, 10, 15, 30, 60, 120, 300, 600].find((sTick) => (sTick / span) * W >= 42) || 900;
  for (let m = Math.ceil(tl.view0 / step) * step; m < tl.view0 + span; m += step) {
    const tx = px(m);
    if (tx > 0 && tx < W) ctx.fillRect(tx, TL.top, 1, TL.lane);
  }

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

  // A MARKER PER TAGGED CLIP, not per freeze (2026-08-27, Tony's call).
  // Freezes are exports now, so a freeze mark pointed at nothing; a tag
  // mark points at a moment worth going back to, and clicking it goes.
  tlMarks = [];
  for (const cl of cur.game.clips) {
    if (!(cl.tags || []).length) continue;
    const x = px(cl.in);
    if (x < -6 || x > W + 6) continue;
    tlMarks.push({ x, t: cl.in, id: cl.id });
    ctx.fillStyle = RATING_COLOR(cl.tags);
    ctx.beginPath();
    ctx.moveTo(x - 4, TL.tagY + 5);
    ctx.lineTo(x + 4, TL.tagY + 5);
    ctx.lineTo(x, TL.tagY);
    ctx.closePath();
    ctx.fill();
  }

  // playhead (tracks the gesture target while a scrub or drag runs)
  const x = px(headTime());
  ctx.fillStyle = '#1a1a1a';
  ctx.fillRect(x - 1, TL.top - 3, 2, TL.lane + 6);
  ctx.beginPath();
  ctx.arc(x, TL.top - 3, 3.4, 0, Math.PI * 2);
  ctx.fill();
}

let tlDrag = null; // {kind:'seek'|'in'|'out', id}
function tlPointT(e) {
  const r = tlCanvas().getBoundingClientRect();
  return tl.view0 + ((e.clientX - r.left) / r.width) * tlSpan();
}

let tlMarks = [];
// A tagged clip's colour comes from its rating, so the lane reads at a
// glance: green good, red bad, blue star, grey everything else.
function RATING_COLOR(tags) {
  if (tags.includes('star')) return '#2b7fff';
  if (tags.includes('bad')) return '#dc2626';
  if (tags.includes('good')) return '#16a34a';
  return '#a3a3a3';
}
function tlMarkAt(e) {
  const r = tlCanvas().getBoundingClientRect();
  const x = e.clientX - r.left;
  const y = e.clientY - r.top;
  if (y < TL.tagY - 4) return null;
  return tlMarks.find((m) => Math.abs(m.x - x) <= 7) || null;
}

// Trackpad: pinch or wheel to zoom about the pointer, swipe to scroll.
export function wireTimelineZoom() {
  const c = tlCanvas();
  if (!c || c.dataset.zoomWired) return;
  c.dataset.zoomWired = '1';
  c.addEventListener('wheel', (e) => {
    if (!cur) return;
    const d = Math.max(0.001, cur.duration);
    const r = c.getBoundingClientRect();
    const frac = (e.clientX - r.left) / r.width;
    if (e.ctrlKey || Math.abs(e.deltaY) > Math.abs(e.deltaX)) {
      e.preventDefault();
      const at = tl.view0 + frac * tlSpan();
      const next = Math.min(d, Math.max(2, tlSpan() * (1 + e.deltaY * 0.0035)));
      tl.span = next;
      tl.view0 = at - frac * next;   // the frame under the finger stays put
    } else {
      e.preventDefault();
      tl.view0 += (e.deltaX / r.width) * tlSpan();
    }
    tlClamp();
    drawTimeline();
  }, { passive: false });
  c.addEventListener('dblclick', () => { tl.span = 0; tl.view0 = 0; drawTimeline(); });
}
function onTlDown(e) {
  if (!cur) return;
  e.preventDefault();
  // A tag marker is a jump target first: clicking one goes there and
  // selects its clip, which is the whole reason the marks are drawn.
  const mark = tlMarkAt(e);
  if (mark) {
    setSel(mark.id);
    seek(mark.t);
    return;
  }
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
    scrubTo(t, true);
  }
  tlCanvas().setPointerCapture?.(e.pointerId);
}
function onTlMove(e) {
  if (!tlDrag || !cur) return;
  const t = tlPointT(e);
  // The same eased pipe the trackpad scrub uses: a fast drag emits pointer
  // events quicker than the video can seek, so per-event seeks stutter here
  // for exactly the same reason they did on the stage.
  if (tlDrag.kind === 'seek') { scrubTo(t); return; }
  const c = cur.game.clips.find((x) => x.id === tlDrag.id);
  if (!c) return;
  if (tlDrag.kind === 'in') c.in = Math.max(0, Math.min(c.out - 0.3, t));
  else c.out = Math.min(cur.duration, Math.max(c.in + 0.3, t));
  drawTimeline();
  paintLog();
}
function onTlUp() {
  if (!tlDrag) return;
  if (tlDrag.kind === 'seek') endScrubGesture();
  else scheduleSave();
  tlDrag = null;
}

// ------------------------------------------------------------- tag bar

function keyBadge(k) { return k ? `<span class="tag-key">${esc(k.toUpperCase())}</span>` : ''; }

// The tag buttons live in a slim vertical side panel (moved from a two-row
// bar under the timeline, 2026-08-25, Tony's call): the rows were the widest
// thing under the video and the height they took came straight out of the
// picture. A narrow column costs the stage almost nothing and scrolls when
// the button list grows. The panel resizes by its own drag bar, collapses
// from the header Tags button, and its buttons drag to reorder (within
// their own section - a clip button and a tag button are different things).
export function paintBar() {
  const bar = el('vpSide');
  if (!bar || !cur) return;
  const c = selClip();
  const item = (b) => {
    if (b.divider) return `<div class="side-div" data-drag="${b.id}" draggable="true" title="Divider - Drag To Move"><span></span></div>`;
    return b.tier === 1 ? `
    <button class="tag-btn" draggable="true" data-drag="${b.id}" data-clipbtn="${b.id}" style="--c:${b.color};--fg:${btnFg(b.color)}" title="${esc(b.label)}: Clip ${b.lead}s Before To ${b.lag}s After The Playhead. Drag To Reorder">
      <span class="tag-btn-word">${esc(btnLabel(b.label))}</span>${keyBadge(b.key)}
    </button>` : `
    <button class="tag-btn tag-btn-tag${c?.tags.includes(b.label) ? ' on' : ''}" draggable="true" data-drag="${b.id}" data-tagbtn="${b.id}" style="--c:${b.color};--fg:${btnFg(b.color)}" title="Toggle #${esc(b.label)} On The Selected Clip. Drag To Reorder">
      <span class="tag-btn-word">${esc(btnLabel(b.label))}</span>${keyBadge(b.key)}
    </button>`;
  };
  bar.innerHTML = `
    <div class="side-label">Clips</div>
    ${panelItems(1).map(item).join('')}
    <div class="side-label">Tags</div>
    ${panelItems(2).map(item).join('')}
    <div class="side-label">Players</div>
    <button class="tag-btn tag-btn-players" data-act="players" style="--c:#f97316;--fg:#fff" title="Tag The Players In This Clip (P)">
      <span class="tag-btn-word">Players</span><span class="tag-key">P</span>
    </button>
    ${cur.clipMode ? `<button class="tag-btn tag-btn-mode on" data-act="exitClip">Playing Clip - Esc Exits</button>` : ''}
    <button class="tag-btn tag-edit" data-act="editPanel" title="Edit Buttons, Keys, Colors, Lead And Lag">Edit Buttons</button>`;
  bar.querySelector('[data-act="players"]').onclick = () => openPlayers();
  bar.querySelectorAll('[data-clipbtn]').forEach((b) => {
    b.onclick = () => pressClipButton(cur.settings.panel.buttons.find((x) => x.id === b.dataset.clipbtn));
  });
  bar.querySelectorAll('[data-tagbtn]').forEach((b) => {
    b.onclick = () => pressTagButton(cur.settings.panel.buttons.find((x) => x.id === b.dataset.tagbtn));
  });
  // Reorder by drag, same tier only: dropping on an item inserts before it.
  let dragId = null;
  const reorder = async (fromId, toId) => {
    if (!fromId || !toId || fromId === toId) return;
    const list = cur.settings.panel.buttons;
    const from = list.find((x) => x.id === fromId);
    const to = list.find((x) => x.id === toId);
    if (!from || !to || from.tier !== to.tier) return;
    const without = list.filter((x) => x.id !== fromId);
    without.splice(without.indexOf(to), 0, from);
    cur.settings.panel.buttons = without;
    await putSettings(cur.settings);
    paintBar();
  };
  bar.querySelectorAll('[data-drag]').forEach((elm) => {
    elm.addEventListener('dragstart', (e) => {
      dragId = elm.dataset.drag;
      e.dataTransfer.effectAllowed = 'move';
      e.dataTransfer.setData('text/plain', dragId);
    });
    elm.addEventListener('dragover', (e) => { e.preventDefault(); elm.classList.add('drag-over'); });
    elm.addEventListener('dragleave', () => elm.classList.remove('drag-over'));
    elm.addEventListener('drop', (e) => {
      e.preventDefault();
      elm.classList.remove('drag-over');
      void reorder(dragId, elm.dataset.drag);
      dragId = null;
    });
  });
  const ep = bar.querySelector('[data-act="editPanel"]');
  if (ep) ep.onclick = () => openPanelEditor();
  const ec = bar.querySelector('[data-act="exitClip"]');
  if (ec) ec.onclick = () => { cur.clipMode = null; paintBar(); };
}

// ------------------------------------------------------------- clip log

// The log's view state. `labels` and `tags` are ARRAYS now - filtering is
// multi-select (2026-08-27) - and sorting comes from the table header
// rather than a button, so it carries a column and a direction.
const view = {
  search: '', searchOpen: false,
  labels: [], tags: [],
  sortBy: 'time', sortDir: 'desc',
  playlist: false,
};

const SEARCH_ICON = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"><circle cx="11" cy="11" r="7"/><path d="m20 20-3.5-3.5"/></svg>';

// ---- undo -----------------------------------------------------------
// Cmd+Z takes back the last tag or clip. One shallow stack, capped: this
// is a safety net for a mis-hit key at game speed, not a document history.
const undoStack = [];
const UNDO_CAP = 40;
export function pushUndo(entry) {
  undoStack.push(entry);
  if (undoStack.length > UNDO_CAP) undoStack.shift();
}
export function undoLast() {
  const u = undoStack.pop();
  if (!u) { toast('Nothing To Undo'); return; }
  if (u.kind === 'clip') {
    cur.game.clips = cur.game.clips.filter((c) => c.id !== u.id);
    if (cur.sel === u.id) cur.sel = null;
    toast('Clip Undone');
  } else if (u.kind === 'tags') {
    const c = cur.game.clips.find((x) => x.id === u.id);
    if (c) c.tags = u.tags;
    toast('Tags Undone');
  } else if (u.kind === 'delete') {
    cur.game.clips = [...cur.game.clips, ...u.clips];
    toast(`${u.clips.length} Restored`);
  } else if (u.kind === 'rename') {
    const c = cur.game.clips.find((x) => x.id === u.id);
    if (c) c.name = u.name;
    toast('Rename Undone');
  }
  scheduleSave();
  paintLog();
  drawTimeline();
}

function filteredClips() {
  let list = [...cur.game.clips];
  if (view.search) {
    const q = view.search.toLowerCase();
    list = list.filter((c) => clipName(c).toLowerCase().includes(q) || (c.note || '').toLowerCase().includes(q));
  }
  if (view.labels.length) list = list.filter((c) => view.labels.includes(c.label));
  // A clip matching ANY ticked tag stays: ticking two tags widens the view
  // rather than narrowing it to clips carrying both, which is what a coach
  // scanning for "good or star" actually wants.
  if (view.tags.length) list = list.filter((c) => (c.tags || []).some((t) => view.tags.includes(t)));
  const dir = view.sortDir === 'asc' ? 1 : -1;
  list.sort((a, b) => (view.sortBy === 'name'
    ? String(a.name || a.label).localeCompare(String(b.name || b.label)) * dir
    : (a.in - b.in) * dir));
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
// ---- players ---------------------------------------------------------
//
// P pauses the video and opens the roster. A player is tagged by clicking
// the name or by pressing the single key assigned to them in Settings -
// every key is shown on its row, because a shortcut nobody can see is not
// a shortcut. The tag is the player's FIRST name, lowercased through
// normTag, so it behaves like every other tag in the log.
//
// Closing resumes whatever the video was doing when it opened: the point
// is to tag without losing the run of play.

export function openPlayers() {
  if (document.getElementById('vpPlayers')) return;
  const c = selClip();
  if (!c) { toast('Select A Clip First - Players Tag A Clip', true); return; }
  const v = video();
  const wasPlaying = !v.paused;
  v.pause();

  const roster = (cur.settings.players || []).filter((p) => p.first);
  const veil = document.createElement('div');
  veil.id = 'vpPlayers';
  veil.className = 'sheet-veil';
  const row = (p) => {
    const tag = normTag(p.first);
    return `<button class="pl-row${(c.tags || []).includes(tag) ? ' on' : ''}" data-pid="${esc(p.id)}">
      <span class="pl-num">${esc(p.num || '')}</span>
      <span class="pl-who"><b>${esc(p.first)}</b>${p.last ? ` ${esc(p.last)}` : ''}</span>
      ${p.key ? `<span class="pl-key">${esc(String(p.key).toUpperCase())}</span>` : ''}
    </button>`;
  };
  veil.innerHTML = `
    <div class="sheet sheet-wide" role="dialog" aria-modal="true" aria-label="Tag Players">
      <h3>Players</h3>
      <p>Click a name or press its key. Return, Escape or Done saves and plays on.</p>
      <div class="pl-grid">${roster.map(row).join('')
        || '<p class="pl-empty">No players yet. Add them in Settings - number, first name, last name and a single key each.</p>'}</div>
      <div class="sheet-row">
        <button class="btn" data-x="settings">Edit Roster</button>
        <span class="vp-flex"></span>
        <button class="btn btn-ink" data-x="done">Done</button>
      </div>
    </div>`;
  document.body.appendChild(veil);

  const toggle = (p) => {
    const tag = normTag(p.first);
    if (!tag) return;
    pushUndo({ kind: 'tags', id: c.id, tags: [...(c.tags || [])] });
    c.tags = (c.tags || []).includes(tag)
      ? c.tags.filter((t) => t !== tag)
      : [...(c.tags || []), tag];
    veil.querySelector(`[data-pid="${p.id}"]`)?.classList.toggle('on', c.tags.includes(tag));
    scheduleSave();
    paintLog();
    drawTimeline();
  };
  veil.querySelectorAll('[data-pid]').forEach((b) => {
    b.onclick = () => toggle(roster.find((p) => p.id === b.dataset.pid));
  });

  const close = (openSettings = false) => {
    document.removeEventListener('keydown', onPlayerKey, true);
    veil.remove();
    paintBar();
    if (openSettings) { if (hooks.onSettings) hooks.onSettings('players'); return; }
    if (wasPlaying) v.play().catch(() => {});
  };
  function onPlayerKey(e) {
    if (e.key === 'Escape' || e.key === 'Enter') { e.preventDefault(); e.stopPropagation(); close(); return; }
    if (e.metaKey || e.ctrlKey || e.altKey) return;
    const p = roster.find((x) => x.key && x.key.toLowerCase() === e.key.toLowerCase());
    if (!p) return;
    e.preventDefault();
    e.stopPropagation();
    toggle(p);
  }
  document.addEventListener('keydown', onPlayerKey, true);
  veil.addEventListener('mousedown', (e) => { if (e.target === veil) close(); });
  veil.querySelector('[data-x="done"]').onclick = () => close();
  veil.querySelector('[data-x="settings"]').onclick = () => close(true);
}

// ---- filter menus ---------------------------------------------------
// Multi-select with a count beside every option, so the menu doubles as a
// summary of what the game holds.
function openFilterMenu(btn, countMap, kind) {
  document.getElementById('vpFilterMenu')?.remove();
  const chosen = kind === 'label' ? view.labels : view.tags;
  const opts = [...countMap.entries()].sort((a, b) => b[1] - a[1]);
  const box = document.createElement('div');
  box.id = 'vpFilterMenu';
  box.className = 'filter-menu';
  box.innerHTML = `
    <div class="fm-list">
      ${opts.map(([name, n]) => `
        <label class="fm-row">
          <input type="checkbox" value="${esc(name)}"${chosen.includes(name) ? ' checked' : ''}>
          <span class="fm-name">${esc(name)}</span>
          <span class="chip-neutral">${n}</span>
        </label>`).join('') || '<p class="fm-empty">Nothing To Filter Yet</p>'}
    </div>
    ${opts.length ? '<div class="fm-foot"><button class="mini" data-fm="none">Clear</button><button class="mini" data-fm="all">All</button></div>' : ''}`;
  document.body.appendChild(box);
  const r = btn.getBoundingClientRect();
  box.style.left = `${Math.min(r.left, window.innerWidth - box.offsetWidth - 10)}px`;
  box.style.top = `${Math.min(r.bottom + 6, window.innerHeight - box.offsetHeight - 10)}px`;
  const apply = (next) => {
    if (kind === 'label') view.labels = next; else view.tags = next;
    paintLog();
  };
  box.querySelectorAll('input').forEach((cb) => {
    cb.onchange = () => apply([...box.querySelectorAll('input')].filter((x) => x.checked).map((x) => x.value));
  });
  box.querySelector('[data-fm="none"]')?.addEventListener('click', () => { apply([]); box.remove(); });
  box.querySelector('[data-fm="all"]')?.addEventListener('click', () => { apply(opts.map((o) => o[0])); box.remove(); });
  const away = (e) => {
    if (box.contains(e.target) || e.target === btn) return;
    box.remove();
    document.removeEventListener('mousedown', away);
  };
  setTimeout(() => document.addEventListener('mousedown', away), 0);
}

// ---- right-click on a clip ------------------------------------------
function openClipMenu(x, y, c) {
  if (!c) return;
  ctxMenu(x, y, [
    ['Play This Clip', () => enterClipMode(c.id, { loop: false })],
    ['Loop This Clip', () => enterClipMode(c.id, { loop: true })],
    ['Rename…', () => renameClip(c)],
    ['Edit Timecodes…', () => editTimes(c)],
    ['Set In At Playhead', () => {
      c.in = Math.min(video().currentTime, c.out - 0.3);
      scheduleSave(); paintLog(); drawTimeline(); toast('Clip In Set');
    }],
    ['Set Out At Playhead', () => {
      c.out = Math.max(video().currentTime, c.in + 0.3);
      scheduleSave(); paintLog(); drawTimeline(); toast('Clip Out Set');
    }],
    ['Duplicate', () => {
      const copy = { ...c, id: uid(), name: `${c.name || c.label} Copy`, tags: [...(c.tags || [])] };
      cur.game.clips = [...cur.game.clips, copy];
      pushUndo({ kind: 'clip', id: copy.id });
      scheduleSave(); paintLog(); drawTimeline();
    }],
    ['Copy Timecode', async () => {
      await navigator.clipboard.writeText(fmtHMS(c.in));
      toast('Timecode Copied');
    }],
    ['Delete', () => {
      pushUndo({ kind: 'delete', clips: [c] });
      cur.game.clips = cur.game.clips.filter((x) => x.id !== c.id);
      if (cur.sel === c.id) cur.sel = null;
      selection.delete(c.id);
      scheduleSave(); paintLog(); drawTimeline(); toast('Clip Deleted');
    }, true],
  ]);
}

function renameClip(c) {
  const name = prompt('Clip Name', c.name || c.label);
  if (name == null) return;
  pushUndo({ kind: 'rename', id: c.id, name: c.name });
  c.name = name.trim();
  scheduleSave();
  paintLog();
}

// In and out as timecodes, so a clip can be nudged without scrubbing to it.
function editTimes(c) {
  const parse = (v, fallback) => {
    if (v == null) return fallback;
    const p = v.trim().split(':').map(Number);
    if (p.some(Number.isNaN)) return fallback;
    return p.length === 3 ? p[0] * 3600 + p[1] * 60 + p[2]
      : p.length === 2 ? p[0] * 60 + p[1] : p[0];
  };
  const i = parse(prompt('Clip In (H:MM:SS)', fmtHMS(c.in)), c.in);
  const o = parse(prompt('Clip Out (H:MM:SS)', fmtHMS(c.out)), c.out);
  c.in = Math.max(0, Math.min(i, o - 0.3));
  c.out = Math.max(c.in + 0.3, o);
  scheduleSave();
  paintLog();
  drawTimeline();
  toast('Timecodes Updated');
}

// ---- bulk ------------------------------------------------------------
function pickedClips() {
  return cur.game.clips.filter((c) => selection.has(c.id));
}
function bulkAction(kind) {
  const picked = pickedClips();
  if (!picked.length) return;
  if (kind === 'none') { selection.clear(); paintLog(); return; }
  if (kind === 'del') {
    pushUndo({ kind: 'delete', clips: picked.map((c) => ({ ...c })) });
    const gone = new Set(picked.map((c) => c.id));
    cur.game.clips = cur.game.clips.filter((c) => !gone.has(c.id));
    if (gone.has(cur.sel)) cur.sel = null;
    selection.clear();
    scheduleSave(); paintLog(); drawTimeline();
    toast(`${picked.length} Clips Deleted`);
    return;
  }
  if (kind === 'rename') {
    const base = prompt(`Rename ${picked.length} Clips To (a number is appended)`, picked[0].name || picked[0].label);
    if (base == null) return;
    picked.forEach((c, i) => { c.name = `${base.trim()} ${i + 1}`; });
    scheduleSave(); paintLog();
    toast(`${picked.length} Clips Renamed`);
    return;
  }
  if (kind === 'tag') {
    const raw = prompt(`Add Tags To ${picked.length} Clips (space separated)`, '');
    if (!raw) return;
    const add = raw.split(/[\s,]+/).map(normTag).filter(Boolean);
    for (const c of picked) c.tags = [...new Set([...(c.tags || []), ...add])];
    scheduleSave(); paintLog(); drawTimeline();
    toast(`Tagged ${picked.length} Clips`);
    return;
  }
  if (kind === 'pull') {
    if (hooks.onBulkPull) hooks.onBulkPull(picked);
    else toast('Pull Export Is Not Wired Yet', true);
  }
}

// ---- playlist --------------------------------------------------------
// Plays every clip currently shown, back to back, with a persistent
// indicator on the player. Filter first, then press Playlist.
function togglePlaylist() {
  view.playlist = !view.playlist;
  if (!view.playlist) { exitPlaylist(); paintLog(); return; }
  const list = filteredClips();
  if (!list.length) { view.playlist = false; toast('Nothing To Play', true); return; }
  playlistQueue = list.map((c) => c.id);
  playlistAt = -1;
  paintLog();
  playlistNext();
}
let playlistQueue = [];
let playlistAt = -1;
function playlistNext() {
  playlistAt += 1;
  if (playlistAt >= playlistQueue.length) { view.playlist = false; exitPlaylist(); paintLog(); toast('Playlist Finished'); return; }
  const id = playlistQueue[playlistAt];
  const c = cur.game.clips.find((x) => x.id === id);
  if (!c) { playlistNext(); return; }
  setSel(id);
  enterClipMode(id, { loop: false });
  paintPlaylistBadge(c);
}
function paintPlaylistBadge(c) {
  let b = document.getElementById('vpPlaylistBadge');
  if (!b) {
    b = document.createElement('div');
    b.id = 'vpPlaylistBadge';
    b.className = 'pl-badge';
    el('vpStage')?.appendChild(b);
  }
  b.innerHTML = `<span class="pl-n">${playlistAt + 1}/${playlistQueue.length}</span><span class="pl-name">${esc(c.name || c.label)}</span><button class="pl-skip" title="Next Clip">&rsaquo;</button>`;
  b.querySelector('.pl-skip').onclick = () => playlistNext();
}
function exitPlaylist() {
  playlistQueue = [];
  playlistAt = -1;
  document.getElementById('vpPlaylistBadge')?.remove();
}
export function playlistRunning() { return view.playlist; }
export function playlistAdvance() { if (view.playlist) playlistNext(); }

// RATING DOTS: three grey dots that light when good / bad / star is on.
// Only those three ever colour a row (2026-08-27, Tony's call) - a per
// clip-button colour told you nothing you could not read from the name.
const RATINGS = [
  { tag: 'good', color: '#16a34a' },
  { tag: 'bad', color: '#dc2626' },
  { tag: 'star', color: '#2b7fff' },
];

// A clip's tags as ONE editable line rather than a row of pills: pills ate
// the width the log has least of. Typing commits on Enter or blur, and the
// whole set is replaced by what is in the field, so removing a tag is
// deleting its word.
const tagLine = (c) => (c.tags || []).join(' ');

export const selection = new Set();   // clip ids ticked for a bulk action

export function paintLog() {
  const log = el('vpLog');
  if (!log || !cur) return;
  const all = cur.game.clips;
  const counts = (get) => {
    const m = new Map();
    for (const c of all) for (const v of [].concat(get(c) ?? [])) if (v) m.set(v, (m.get(v) || 0) + 1);
    return m;
  };
  const labelCounts = counts((c) => c.label);
  const tagCounts = counts((c) => c.tags);
  const list = filteredClips();
  const tagOpts = [...new Set([...panelButtons(2).map((b) => b.label), ...tagCounts.keys()])];
  // Keep the caret alive across a repaint.
  const ae = document.activeElement;
  const keepSearch = ae === el('vpLogSearch') ? ae.selectionStart : null;
  const keepTagRow = ae?.dataset?.tagrow || null;
  const keepTagVal = keepTagRow ? ae.value : '';
  const keepTagSel = keepTagRow ? ae.selectionStart : null;
  for (const id of [...selection]) if (!all.some((c) => c.id === id)) selection.delete(id);
  const ticked = list.filter((c) => selection.has(c.id)).length;
  const arrow = (col) => (view.sortBy !== col ? '' : view.sortDir === 'asc' ? ' ▲' : ' ▼');

  log.innerHTML = `
    <div class="log-head">
      <button class="log-iconbtn${view.search ? ' on' : ''}" id="vpLogSearchBtn" title="Search Clips" aria-label="Search Clips">${SEARCH_ICON}</button>
      <input id="vpLogSearch" type="search" placeholder="Search Clips…" value="${esc(view.search)}" autocomplete="off"${view.searchOpen || view.search ? '' : ' hidden'}>
      <div class="log-filters"${view.searchOpen ? ' hidden' : ''}>
        <button class="log-filter${view.labels.length ? ' on' : ''}" data-menu="label">Clips${view.labels.length ? ` (${view.labels.length})` : ''}</button>
        <button class="log-filter${view.tags.length ? ' on' : ''}" data-menu="tag">Tags${view.tags.length ? ` (${view.tags.length})` : ''}</button>
        <button class="log-filter${view.playlist ? ' on' : ''}" id="vpPlaylist" title="Play Every Clip Below, Back To Back">Playlist</button>
      </div>
    </div>
    <div class="log-cols">
      <span class="c-check"><input type="checkbox" id="vpAllCheck" title="Select Every Clip Below"${ticked && ticked === list.length ? ' checked' : ''}></span>
      <button class="c-time c-sort${view.sortBy === 'time' ? ' on' : ''}" data-sort="time">Time${arrow('time')}</button>
      <button class="c-sort c-grow${view.sortBy === 'name' ? ' on' : ''}" data-sort="name">Clip${arrow('name')}</button>
      <span class="log-count">${list.length} Of ${all.length}</span>
    </div>
    ${ticked ? `<div class="log-bulk">
      <span class="log-bulkn">${ticked} Selected</span>
      <span class="vp-flex"></span>
      <button class="mini" data-bulk="pull">Pull</button>
      <button class="mini" data-bulk="tag">Tag</button>
      <button class="mini" data-bulk="rename">Rename</button>
      <button class="mini mini-danger" data-bulk="del">Delete</button>
      <button class="mini" data-bulk="none">Clear</button>
    </div>` : ''}
    <datalist id="vpTagOpts">${tagOpts.map((t) => `<option value="${esc(t)}">`).join('')}</datalist>
    <div class="log-list">
      ${list.map((c) => `
        <div class="log-row${c.id === cur.sel ? ' on' : ''}${selection.has(c.id) ? ' picked' : ''}" data-id="${c.id}">
          <span class="c-check"><input type="checkbox" data-pick="${c.id}"${selection.has(c.id) ? ' checked' : ''} aria-label="Select ${esc(c.name || c.label)}"></span>
          <span class="log-time">${fmtHMS(c.in)}</span>
          <span class="log-rate">${RATINGS.map((r) => `<i class="rate-dot${(c.tags || []).includes(r.tag) ? ' on' : ''}" style="--c:${r.color}" title="${r.tag}"></i>`).join('')}</span>
          <span class="log-name">${esc(c.name || c.label)}</span>
          <input class="log-tagline" data-tagrow="${c.id}" list="vpTagOpts" value="${esc(tagLine(c))}" placeholder="tags" autocomplete="off" spellcheck="false">
        </div>`).join('') || '<div class="log-empty">No Clips Yet - Press A Tag Button (Or Its Key) While The Video Plays.</div>'}
    </div>`;

  // ---- head
  const sBtn = el('vpLogSearchBtn');
  const sIn = el('vpLogSearch');
  sBtn.onclick = () => { view.searchOpen = !view.searchOpen; paintLog(); if (view.searchOpen) el('vpLogSearch')?.focus(); };
  sIn.addEventListener('input', (e) => { view.search = e.target.value; paintLog(); });
  sIn.addEventListener('keydown', (e) => {
    e.stopPropagation();
    if (e.key === 'Escape') { view.search = ''; view.searchOpen = false; paintLog(); }
  });
  if (keepSearch != null) { sIn.focus(); sIn.setSelectionRange(keepSearch, keepSearch); }
  log.querySelectorAll('[data-menu]').forEach((b) => {
    b.onclick = () => openFilterMenu(b, b.dataset.menu === 'label' ? labelCounts : tagCounts, b.dataset.menu);
  });
  el('vpPlaylist').onclick = () => togglePlaylist();

  // ---- column sort
  log.querySelectorAll('[data-sort]').forEach((b) => {
    b.onclick = () => {
      const col = b.dataset.sort;
      if (view.sortBy === col) view.sortDir = view.sortDir === 'asc' ? 'desc' : 'asc';
      else { view.sortBy = col; view.sortDir = col === 'time' ? 'asc' : 'asc'; }
      paintLog();
    };
  });

  // ---- selection
  el('vpAllCheck').onchange = (e) => {
    for (const c of list) if (e.target.checked) selection.add(c.id); else selection.delete(c.id);
    paintLog();
  };
  log.querySelectorAll('[data-pick]').forEach((cb) => {
    cb.onclick = (e) => e.stopPropagation();
    cb.onchange = () => {
      if (cb.checked) selection.add(cb.dataset.pick); else selection.delete(cb.dataset.pick);
      paintLog();
    };
  });
  log.querySelectorAll('[data-bulk]').forEach((b) => { b.onclick = () => bulkAction(b.dataset.bulk); });

  // ---- rows
  log.querySelectorAll('.log-row').forEach((row) => {
    const id = row.dataset.id;
    const clip = () => cur.game.clips.find((x) => x.id === id);
    row.addEventListener('click', (e) => {
      if (e.target.closest('input')) return;
      setSel(id);
      seek(clip().in);
    });
    row.addEventListener('contextmenu', (e) => {
      e.preventDefault();
      openClipMenu(e.clientX, e.clientY, clip());
    });
    const tin = row.querySelector('.log-tagline');
    const commit = () => {
      const c = clip();
      if (!c) return;
      const next = tin.value.split(/[\s,]+/).map(normTag).filter(Boolean);
      const uniq = [...new Set(next)];
      if (uniq.join(' ') === (c.tags || []).join(' ')) return;
      pushUndo({ kind: 'tags', id, tags: [...(c.tags || [])] });
      c.tags = uniq;
      scheduleSave();
      paintLog();
      drawTimeline();
    };
    tin.addEventListener('click', (e) => e.stopPropagation());
    tin.addEventListener('blur', commit);
    tin.addEventListener('keydown', (e) => {
      e.stopPropagation();
      if (e.key === 'Enter') { e.preventDefault(); commit(); tin.blur(); }
      if (e.key === 'Escape') { tin.value = tagLine(clip()); tin.blur(); }
    });
    if (keepTagRow === id) {
      tin.focus();
      tin.value = keepTagVal;
      if (keepTagSel != null) tin.setSelectionRange(keepTagSel, keepTagSel);
    }
  });
}

// ------------------------------------------------------------- panel editor

// The preset swatches in the editor. Light grey is deliberately in the set
// (Tony's ask): a neutral button is how a tag stays quiet beside the loud
// ones. Any other colour is still reachable from the colour well beside them.
const NEW_BTN_COLOR = '#d9d9d9';
const PRESET_COLORS = [
  ['#1a1a1a', 'Ink'], ['#d9d9d9', 'Light Grey'], ['#64748b', 'Steel'],
  ['#16a34a', 'Green'], ['#dc2626', 'Red'], ['#3b82f6', 'Blue'],
  ['#0ea5e9', 'Sky'], ['#eab308', 'Yellow'], ['#f97316', 'Orange'],
  ['#7c3aed', 'Violet'], ['#d946ef', 'Magenta'], ['#6366f1', 'Indigo'],
];

function openPanelEditor() {
  document.querySelector('.sheet-veil')?.remove();
  const wrap = document.createElement('div');
  wrap.className = 'sheet-veil';
  // A row is either a button or a divider; both drag to reorder within
  // their own section, and both carry the same delete and duplicate.
  const GRIP = '<svg viewBox="0 0 16 16" width="11" height="11" aria-hidden="true"><circle cx="6" cy="3.5" r="1.25"/><circle cx="10" cy="3.5" r="1.25"/><circle cx="6" cy="8" r="1.25"/><circle cx="10" cy="8" r="1.25"/><circle cx="6" cy="12.5" r="1.25"/><circle cx="10" cy="12.5" r="1.25"/></svg>';
  const acts = (what) => `
      <span class="pe-acts">
        <button class="mini" data-dup title="Duplicate ${what}">Copy</button>
        <button class="mini mini-danger" data-del title="Remove ${what}" aria-label="Remove ${what}">&times;</button>
      </span>`;
  // A row is either a button or a divider; both drag to reorder within
  // their own section, and both carry the same delete and duplicate.
  //
  // The twelve preset swatches used to be printed INSIDE every row, which
  // is what made this dialog unreadable: eight rows meant ninety-six
  // swatches. The colour now lives behind one well per row that opens a
  // single shared popover. The hidden `.pe-color` input stays exactly
  // where it was so the save reader below is untouched.
  const row = (b) => (b.divider ? `
    <div class="pe-row pe-row--div" data-id="${b.id}" data-divider="1" draggable="true">
      <span class="pe-grip" title="Drag To Reorder">${GRIP}</span>
      <span class="pe-divword">Divider</span>
      ${acts('This Divider')}
    </div>` : `
    <div class="pe-row" data-id="${b.id}" draggable="true">
      <span class="pe-grip" title="Drag To Reorder">${GRIP}</span>
      <button type="button" class="pe-well" data-colorbtn style="--c:${b.color}" title="Button Colour" aria-label="Button Colour"></button>
      <input class="pe-color" type="color" value="${b.color}" hidden>
      <input class="pe-label" value="${esc(b.label)}" placeholder="${b.tier === 1 ? 'Label' : 'tag-name'}" aria-label="Label">
      <input class="pe-key" value="${esc(b.key || '')}" maxlength="1" placeholder="-" aria-label="Hotkey">
      ${b.tier === 1 ? `
        <input class="pe-num" type="number" value="${b.lead ?? 8}" min="0" max="120" aria-label="Seconds Before The Playhead">
        <input class="pe-num" type="number" value="${b.lag ?? 4}" min="0" max="120" aria-label="Seconds After The Playhead">` : ''}
      ${acts('This Button')}
    </div>`);
  const head = (tier) => `
    <div class="pe-head pe-head--${tier === 1 ? 'clip' : 'tag'}">
      <span></span><span></span><span>Label</span><span>Key</span>
      ${tier === 1 ? '<span>Lead</span><span>Lag</span>' : ''}<span></span>
    </div>`;
  wrap.innerHTML = `
    <div class="sheet sheet-pe" role="dialog" aria-modal="true" aria-labelledby="peTitle">
      <div class="pe-top">
        <h3 id="peTitle">Tag Buttons</h3>
        <p>Clip Buttons mark a clip at the playhead - Lead is seconds before it, Lag is seconds after. Tag Buttons toggle a #tag on the selected clip. A key is one letter. Drag a row by its handle to reorder it, and use a divider to group buttons in the side panel.</p>
      </div>
      <div class="pe-body">
        <section class="pe-section">
          <div class="pe-title">Clip Buttons</div>
          ${head(1)}
          <div id="peT1" class="pe-list pe-list--clip">${panelItems(1).map(row).join('')}</div>
          <div class="pe-adds">
            <button class="mini" id="peAdd1">+ Clip Button</button>
            <button class="mini" id="peDiv1">+ Divider</button>
          </div>
        </section>
        <section class="pe-section">
          <div class="pe-title">Tag Buttons</div>
          ${head(2)}
          <div id="peT2" class="pe-list pe-list--tag">${panelItems(2).map(row).join('')}</div>
          <div class="pe-adds">
            <button class="mini" id="peAdd2">+ Tag Button</button>
            <button class="mini" id="peDiv2">+ Divider</button>
          </div>
        </section>
      </div>
      <div class="sheet-row pe-foot">
        <button class="btn" data-x="cancel">Cancel</button>
        <button class="btn btn-ink" data-x="save">Save Buttons</button>
      </div>
    </div>`;
  document.body.appendChild(wrap);

  // ---- the one shared colour popover -------------------------------
  const pop = document.createElement('div');
  pop.className = 'pe-pop';
  pop.hidden = true;
  pop.innerHTML = `
    <div class="pe-pop-grid">
      ${PRESET_COLORS.map(([hex, name]) => `<button type="button" class="pe-sw" data-sw="${hex}" style="--c:${hex}" title="${name}" aria-label="${name}"></button>`).join('')}
    </div>
    <label class="pe-pop-custom">Any Other Colour<input type="color" class="pe-pop-color"></label>`;
  wrap.querySelector('.sheet-pe').appendChild(pop);
  let popRow = null;

  const syncWell = (r) => {
    const hex = r.querySelector('.pe-color').value;
    r.querySelector('.pe-well').style.setProperty('--c', hex);
  };
  const closePop = () => { pop.hidden = true; popRow = null; };
  const openPop = (btn) => {
    popRow = btn.closest('.pe-row');
    const hex = popRow.querySelector('.pe-color').value.toLowerCase();
    pop.querySelectorAll('[data-sw]').forEach((o) => o.classList.toggle('on', o.dataset.sw === hex));
    pop.querySelector('.pe-pop-color').value = hex;
    pop.hidden = false;
    // Fixed, and measured after it is visible, so a row near the bottom of
    // the scrolling list still shows the whole popover.
    const b = btn.getBoundingClientRect();
    const h = pop.offsetHeight;
    const top = b.bottom + 6 + h > window.innerHeight ? Math.max(8, b.top - 6 - h) : b.bottom + 6;
    pop.style.top = `${top}px`;
    pop.style.left = `${Math.max(8, Math.min(b.left, window.innerWidth - pop.offsetWidth - 8))}px`;
  };
  const applyColor = (hex) => {
    if (!popRow) return;
    popRow.querySelector('.pe-color').value = hex;
    syncWell(popRow);
  };
  pop.querySelectorAll('[data-sw]').forEach((sw) => {
    sw.onclick = () => {
      applyColor(sw.dataset.sw);
      pop.querySelectorAll('[data-sw]').forEach((o) => o.classList.toggle('on', o === sw));
      closePop();
    };
  });
  pop.querySelector('.pe-pop-color').oninput = (e) => {
    applyColor(e.target.value);
    pop.querySelectorAll('[data-sw]').forEach((o) => o.classList.toggle('on', o.dataset.sw === e.target.value));
  };

  const wireRow = (r) => {
    r.addEventListener('dragstart', (e) => {
      r.classList.add('dragging');
      e.dataTransfer.effectAllowed = 'move';
      e.dataTransfer.setData('text/plain', r.dataset.id);
    });
    r.addEventListener('dragend', () => r.classList.remove('dragging'));
    r.addEventListener('dragover', (e) => {
      const src = wrap.querySelector('.pe-row.dragging');
      if (!src || src === r || src.parentElement !== r.parentElement) return;
      e.preventDefault();
      const box = r.getBoundingClientRect();
      r.parentElement.insertBefore(src, e.clientY < box.top + box.height / 2 ? r : r.nextSibling);
    });
    const well = r.querySelector('[data-colorbtn]');
    if (well) well.onclick = (e) => { e.stopPropagation(); if (popRow === r) closePop(); else openPop(well); };
  };
  wrap.querySelectorAll('.pe-row').forEach(wireRow);
  wrap.addEventListener('scroll', closePop, true);
  document.addEventListener('keydown', (e) => { if (e.key === 'Escape' && !pop.hidden) closePop(); });

  const add = (listId, b) => {
    const list = wrap.querySelector(listId);
    list.insertAdjacentHTML('beforeend', row(b));
    wireRow(list.lastElementChild);
  };
  // New buttons start LIGHT GREY (Tony's call): a new button is unassigned
  // until he colours it, and grey is what unassigned looks like.
  wrap.querySelector('#peAdd1').onclick = () => add('#peT1', { id: uid(), tier: 1, label: 'New', key: '', color: NEW_BTN_COLOR, lead: 8, lag: 4 });
  wrap.querySelector('#peAdd2').onclick = () => add('#peT2', { id: uid(), tier: 2, label: 'new-tag', key: '', color: NEW_BTN_COLOR });
  wrap.querySelector('#peDiv1').onclick = () => add('#peT1', { id: uid(), tier: 1, divider: true });
  wrap.querySelector('#peDiv2').onclick = () => add('#peT2', { id: uid(), tier: 2, divider: true });

  wrap.addEventListener('click', (e) => {
    if (!pop.hidden && !pop.contains(e.target) && !e.target.closest('[data-colorbtn]')) closePop();
    const dup = e.target.closest('[data-dup]');
    if (dup) {
      const r = dup.closest('.pe-row');
      const isDiv = !!r.dataset.divider;
      const copy = isDiv
        ? { id: uid(), divider: true }
        : {
          id: uid(),
          tier: r.parentElement.id === 'peT1' ? 1 : 2,
          label: r.querySelector('.pe-label').value,
          key: '', // a duplicate must not steal the original's hotkey
          color: r.querySelector('.pe-color').value,
          lead: Number(r.querySelectorAll('.pe-num')[0]?.value ?? 8),
          lag: Number(r.querySelectorAll('.pe-num')[1]?.value ?? 4),
        };
      r.insertAdjacentHTML('afterend', row(copy));
      wireRow(r.nextElementSibling);
      return;
    }
    if (e.target.closest('[data-del]')) e.target.closest('.pe-row').remove();
    if (e.target === wrap) wrap.remove();
  });
  wrap.querySelector('[data-x="cancel"]').onclick = () => wrap.remove();
  wrap.querySelector('[data-x="save"]').onclick = async () => {
    const read = (root, tier) => [...root.querySelectorAll('.pe-row')].map((r) => {
      if (r.dataset.divider) return { id: r.dataset.id, tier, divider: true };
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
  // Cmd+Z takes back the last tag or clip - a mis-hit key at game speed
  // should cost one keystroke, not a hunt through the log. It has to sit
  // ABOVE the modifier bail below, which otherwise swallows it; the input
  // guard above still stands, so Cmd+Z inside a field is the browser's own
  // text undo, which is what anyone typing expects.
  if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === 'z') { e.preventDefault(); undoLast(); return; }
  if (e.metaKey || e.ctrlKey) return;
  // P opens the roster. It sits above the panel's own key lookup so a tag
  // button can never quietly claim the key.
  if (e.key.toLowerCase() === 'p') { e.preventDefault(); openPlayers(); return; }
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

// Two timecodes now, sitting on the ends of the slim timeline instead of on
// a row of their own: current on the left, total on the right.
function paintClock() {
  if (!cur) return;
  const c = el('vpClock');
  if (c) c.textContent = fmtHMS(headTime());
  const t = el('vpTotal');
  if (t) t.textContent = fmtHMS(cur.duration);
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
export function playerDuration() { return cur?.duration || video()?.duration || 0; }
export function playerSel() { return cur?.sel || null; }
export function playerSettings() { return cur?.settings || null; }

export async function openPlayer(game, videoUrl, h = {}) {
  hooks = h || {};
  // The decoder source (scrubsource.js): built in the background so the
  // player never waits on indexing. Until it lands - or if this file cannot
  // be driven (webm, fragmented mp4, rotated, no ranges) - gestures seek the
  // element exactly as before.
  scrubSrc = null;
  const provider = scrubProviderFor(h.scrubFile || null, videoUrl);
  if (provider) {
    void openScrubSource(game.id, provider).then((s) => {
      if (cur && cur.game === game) {
        scrubSrc = s;
        if (s) primeSoon();
        // Diagnostic tap, Film Room's idiom: only populated when a debugger
        // created the object first. How "is the decoder driving this file"
        // gets answered without guessing.
        if (window.__scrubDebug) window.__scrubDebug.src = s;
      }
      else if (s) releaseScrubSource(game.id);
    });
  }
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
  abortScrub();
  clearTimeout(primeTimer);
  releaseScrubSource(cur.game.id);
  scrubSrc = null;
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
  // THE PUMP'S RELEASE VALVE. One seek is allowed in flight at a time, and
  // this is what says the last one landed. Without it every gesture fires a
  // single seek, waits out the 250ms safety timeout, fires another - which
  // is a scrub that moves in lurches. Film Room learned the same lesson.
  el('vpVideo').addEventListener('seeked', () => {
    clearTimeout(seekState.unlock);
    seekState.busy = false;
    seekState.ourSeekT = null;
    // While the overlay is up, copy a landed seek across - but only if it is
    // at least as close to the finger as what the overlay already shows: a
    // seek takes 2-3 refreshes to land, and painting its older frame over a
    // newer decoder frame made the picture jump backward then forward on
    // every engine handoff (Film Room's "jumping around" of 2026-08-06).
    const v = el('vpVideo');
    if (paint && seekState.pos != null && v.readyState >= 2) {
      const closer = lastPaintT == null
        || Math.abs(v.currentTime - seekState.pos) <= Math.abs(lastPaintT - seekState.pos);
      if (closer) {
        try { pctx.drawImage(v, 0, 0, paint.width, paint.height); lastPaintT = v.currentTime; } catch (_) { /* not decodable yet */ }
      }
    }
    if (seekState.pos == null) primeSoon();
  });
  // An OUTSIDE seek (timeline click landing elsewhere, a frame step, play)
  // ends the gesture and stands: a stale scrub target must never yank the
  // playhead back. Our own pump seeks are told apart by their exact target.
  el('vpVideo').addEventListener('seeking', () => {
    if (seekState.pos == null) return;
    const v = el('vpVideo');
    const ours = seekState.busy && seekState.ourSeekT != null && Math.abs(v.currentTime - seekState.ourSeekT) < 0.001;
    if (!ours) endScrubGesture(true);
  });
  el('vpVideo').addEventListener('play', () => { if (seekState.pos != null) endScrubGesture(); });
  el('vpVideo').addEventListener('emptied', () => { abortScrub(); });
  el('vpVideo').addEventListener('loadeddata', () => primeSoon(800));
  el('vpVideo').addEventListener('pause', () => primeSoon());
  // Named tlEl, not tl: the module-level `tl` is the zoom state and a local
  // shadow of that name here is a trap for whoever reads it next.
  const tlEl = tlCanvas();
  tlEl.addEventListener('pointerdown', onTlDown);
  wireTimelineZoom();
  tlEl.addEventListener('pointermove', onTlMove);
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
