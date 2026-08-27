// STAGE ZOOM: pinch the trackpad to magnify the picture, drag to move around
// inside it (2026-08-27, Tony's call). Ported from CTH Film Room's
// `renderer/js/stage.js`, which is where the feel was tuned, for the same
// reason the scrub engine was ported: a coach should not have to learn two
// gestures for two apps that show the same game.
//
// What is different here, and why:
//
//  - FILM ROOM TRANSFORMS A WRAPPER sized to the picture. Clips stacks the
//    video, the scrub overlay and the annotation canvases as siblings, all
//    `inset: 0` with `object-fit: contain`, so they already share one box and
//    one letterbox. ONE transform, published as the `--vz` custom property on
//    the stage, moves every layer identically - which is what keeps a drawn
//    arrow on the play it marks and keeps the scrub overlay registered with
//    the video underneath it. Anything new that paints on the stage must join
//    the `--vz` rule in app.css or it will slide off everything else.
//  - THE PAN IS CLAMPED TO THE PICTURE, NOT TO THE STAGE. The stage is
//    whatever the window leaves over, so a 16:9 game inside it is usually
//    letterboxed. Clamping by the stage box let the picture's own edge travel
//    into the middle of the frame with black beside it. The limit here is
//    half the PICTURE's growth, which means every part of the picture can be
//    reached and nothing past it can.
//  - PAN IS A PLAIN DRAG, not Film Room's Option-drag. A click on the video
//    is play/pause, so a drag that actually moved swallows the click that
//    follows it (`SLOP` px of travel is the test). Option-drag still works
//    and is the ONLY pan while the freeze editor is open, where a plain drag
//    belongs to whatever tool is armed.
//
// A two-finger swipe is the SCRUB and stays the scrub at every zoom level -
// horizontal to scrub, pinch to zoom, drag to pan, and no gesture means two
// things at once. Vertical swipe is deliberately left doing nothing rather
// than made into a pan: a real trackpad swipe is never purely vertical, so
// it would scrub a little every time it panned.
//
// Zoom is a VIEWING aid, like Film Room's flip. It is not on the game record,
// it does not survive closing the video, and it never reaches an export or a
// recording - those composite from the video's own pixels (export.js).

const el = (id) => document.getElementById(id);

const MAX_ZOOM = 5;
const SLOP = 4;          // px of travel before a drag stops being a click
const CLICK_EAT_MS = 320; // how long a finished pan swallows the click it caused

let z = 1;
let tx = 0;
let ty = 0;
let panEndedAt = 0;

export const stageZoom = () => z;
export const stageZoomed = () => z > 1.001;

// The picture's unzoomed size on screen: the stage box narrowed to the
// video's aspect, the same sum `object-fit: contain` does internally.
function picSize() {
  const stage = el('vpStage');
  const v = el('vpVideo');
  if (!stage) return { w: 0, h: 0 };
  const sw = stage.clientWidth;
  const sh = stage.clientHeight;
  const ar = (v && v.videoWidth && v.videoHeight) ? v.videoWidth / v.videoHeight : 16 / 9;
  let w = sw;
  let h = sw / ar;
  if (h > sh) { h = sh; w = sh * ar; }
  return { w, h };
}

function apply() {
  const stage = el('vpStage');
  if (!stage) return;
  const p = picSize();
  const maxX = (p.w * (z - 1)) / 2;
  const maxY = (p.h * (z - 1)) / 2;
  tx = Math.max(-maxX, Math.min(maxX, tx));
  ty = Math.max(-maxY, Math.min(maxY, ty));
  const on = stageZoomed();
  // `none` at 1x, never `scale(1)`: an identity transform still hands the
  // video to the compositor as its own scaled layer, and this app has already
  // learned once (the scrub overlay, 2026-08-26) that a needless resample
  // reads as "the video quality is terrible".
  stage.style.setProperty('--vz', on ? `translate(${tx.toFixed(2)}px, ${ty.toFixed(2)}px) scale(${z})` : 'none');
  stage.classList.toggle('zoomed', on);
  paintChip();
}

function paintChip() {
  const stage = el('vpStage');
  if (!stage) return;
  let chip = stage.querySelector(':scope > .vz-chip');
  if (!stageZoomed()) { chip?.remove(); return; }
  if (!chip) {
    chip = document.createElement('button');
    chip.className = 'vz-chip';
    chip.title = 'Back To 1x';
    chip.onclick = () => resetStageZoom();
    stage.appendChild(chip);
  }
  chip.textContent = `${z.toFixed(1).replace(/\.0$/, '')}x`;
}

// Zoom about a screen point, so the frame under the fingers stays under them.
// THE PAN HAS TO COME OUT OF THE ANCHOR. The stage itself is never
// transformed - its children are - so its rect gives the picture's centre AT
// REST; the picture's centre right now is that plus the pan. Measuring
// against the resting centre alone is the bug Film Room hit on 2026-08-21:
// the picture slid away from the cursor on every pinch after the first.
function zoomAbout(clientX, clientY, factor) {
  const stage = el('vpStage');
  if (!stage) return;
  const next = Math.max(1, Math.min(MAX_ZOOM, z * factor));
  if (next === z) return;
  const r = stage.getBoundingClientRect();
  // `contain` centres the picture in the stage, and the transform's origin is
  // that same centre, so one offset serves both.
  const cx = clientX - (r.left + r.width / 2) - tx;
  const cy = clientY - (r.top + r.height / 2) - ty;
  tx -= cx * (next / z - 1);
  ty -= cy * (next / z - 1);
  z = next;
  if (z <= 1.001) { z = 1; tx = 0; ty = 0; }
  apply();
}

export function resetStageZoom() {
  z = 1; tx = 0; ty = 0;
  apply();
}

function onWheel(e) {
  // Only a pinch. A plain two-finger swipe is the scrubber's gesture
  // (player.js onStageWheel) and must pass straight through.
  if (!e.ctrlKey) return;
  if (e.target.closest('.cmp-root')) return; // side by side has its own pictures
  e.preventDefault();
  // A real trackpad pinch arrives as dozens of SMALL fractional ctrl-wheel
  // ticks, so the per-tick gain has to be strong enough that one physical
  // pinch visibly zooms (Film Room, Tony 2026-08-13: at 0.012 a full pinch
  // topped out near 1.5x and read as "pinch does nothing"). A ctrl-held MOUSE
  // wheel sends 100-plus per notch, so the per-event factor is clamped or one
  // notch would teleport the picture. Copied to the number.
  const factor = Math.max(0.8, Math.min(1.25, Math.exp(-e.deltaY * 0.028)));
  zoomAbout(e.clientX, e.clientY, factor);
}

// Safari sends its own pinch events instead of ctrl+wheel. Chrome and Edge
// have no GestureEvent, so this listener never fires there.
let gestureScale = 1;
function onGestureStart(e) { e.preventDefault(); gestureScale = e.scale || 1; }
function onGestureChange(e) {
  e.preventDefault();
  const s = e.scale || 1;
  if (!gestureScale) { gestureScale = s; return; }
  zoomAbout(e.clientX, e.clientY, s / gestureScale);
  gestureScale = s;
}

// Drag to move around inside a zoomed picture. Capture phase, because the
// annotation canvas sits on top of the video and would otherwise take an
// Option-drag as a stroke.
function onDown(e) {
  if (!stageZoomed() || e.button !== 0) return;
  if (e.target.closest('.vz-chip, .an-tb, .cmp-root, .pl-badge, button')) return;
  const drawing = !el('anRoot')?.hidden;
  if (drawing && !e.altKey) return; // the freeze editor owns a plain drag
  const stage = el('vpStage');
  const x0 = e.clientX;
  const y0 = e.clientY;
  const sx = x0 - tx;
  const sy = y0 - ty;
  let moved = false;
  e.stopPropagation();
  const move = (me) => {
    if (!moved && Math.abs(me.clientX - x0) + Math.abs(me.clientY - y0) < SLOP) return;
    moved = true;
    stage?.classList.add('panning');
    tx = me.clientX - sx;
    ty = me.clientY - sy;
    apply();
  };
  const up = () => {
    window.removeEventListener('pointermove', move, true);
    window.removeEventListener('pointerup', up, true);
    window.removeEventListener('pointercancel', up, true);
    stage?.classList.remove('panning');
    if (moved) panEndedAt = performance.now();
  };
  window.addEventListener('pointermove', move, true);
  window.addEventListener('pointerup', up, true);
  window.addEventListener('pointercancel', up, true);
}

// A pan that moved must not also toggle play. Timestamped rather than a
// one-shot listener, which would eat the next click when a pan produced none.
function onClick(e) {
  if (performance.now() - panEndedAt > CLICK_EAT_MS) return;
  e.stopPropagation();
  e.preventDefault();
}

// The player view is rebuilt from innerHTML every time a video opens, so the
// guard is on the ELEMENT, not the module - a module flag would leave every
// stage after the first with no zoom at all. Same idiom as wireTimelineZoom.
export function wireStageZoom() {
  const stage = el('vpStage');
  if (!stage || stage.dataset.vzWired) return;
  stage.dataset.vzWired = '1';
  stage.addEventListener('wheel', onWheel, { passive: false });
  stage.addEventListener('pointerdown', onDown, true);
  stage.addEventListener('click', onClick, true);
  if ('ongesturechange' in window) {
    stage.addEventListener('gesturestart', onGestureStart, { passive: false });
    stage.addEventListener('gesturechange', onGestureChange, { passive: false });
  }
  // The clamp is a function of the picture's size, so a window resize or a
  // panel grip has to re-run it or a pan can be left outside its own limit.
  new ResizeObserver(() => { if (stageZoomed()) apply(); }).observe(stage);
  el('vpVideo')?.addEventListener('loadedmetadata', () => { if (stageZoomed()) apply(); });
}
