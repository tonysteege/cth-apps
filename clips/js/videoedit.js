// CTH Clips - the video editor (2026-08-27, Tony's spec).
//
// Trim, crop, colour, patch out a watermark, compress. Finish and the file in
// videos/ IS the edited video, with the original kept so it can be put back.
//
// WHAT THIS IS AND IS NOT, because the honest limits shape every decision
// below. Clips is a zero-build, fully client-side app: there is no server to
// hand a file to and no ffmpeg. Everything here is done by painting frames
// into a canvas and recording that canvas, which means:
//
//   - EDITING IS INSTANT, RENDERING IS REAL TIME. Every control previews live
//     off CSS filters and a transform, so the whole edit is free to design.
//     Only Apply costs anything, and it costs one second per second of
//     footage, because MediaRecorder captures a playing video. TRIM FIRST:
//     it is the one control that makes every other one cheaper.
//   - THE RESULT IS RE-ENCODED, so it is lossy. That is the price of not
//     having ffmpeg, and it is why the original is always kept.
//   - "ENHANCE" IS A FILTER PRESET, not AI upscaling. It lifts contrast,
//     saturation and brightness the way a camera profile would. Nothing in a
//     browser can invent detail that is not in the source.
//   - "REMOVE WATERMARK" PATCHES, it does not inpaint. A blur or a solid
//     block over the region. Real inpainting needs a model and a server.
//
// THE ONE THING THAT MUST NOT BE GOT WRONG: trimming the front of a video
// shifts every timecode in the game. Clips, freezes and the timeline all
// store absolute seconds, so a 30 second trim moves all of them 30 seconds.
// `shiftGame` does that in the same transaction as the swap.

import { fsWrite, fsGetFile, fsExists, fsCreateFolder, fsConnected, fsLabel } from './localfs.js';
import { recordRange, deliver } from './export.js';
import { toast, esc } from './ui.js';
import { putGame } from './store.js';

// Originals live beside the videos in one folder, not scattered as
// `name.original.mp4` siblings: a folder can be ignored at a glance and a
// suffix cannot.
const ORIGINALS = '/videos/.originals';

let ed = null;

export function editing() { return !!ed; }

// ---------------------------------------------------------------- the look
//
// Colour is a CSS filter string, which is the same grammar the canvas takes.
// One expression drives the live preview AND the render, so what is on screen
// is what lands in the file - there is no second code path to drift.
export function filterString(c) {
  const p = [];
  if (c.brightness !== 100) p.push(`brightness(${c.brightness}%)`);
  if (c.contrast !== 100) p.push(`contrast(${c.contrast}%)`);
  if (c.saturate !== 100) p.push(`saturate(${c.saturate}%)`);
  // Temperature is faked with sepia plus a hue turn: warm adds sepia and
  // rotates back toward orange, cool rotates toward blue. A real white
  // balance needs per-channel gain, which CSS filters do not expose.
  if (c.temp > 0) p.push(`sepia(${c.temp}%) saturate(${100 + c.temp}%)`);
  if (c.temp < 0) p.push(`hue-rotate(${c.temp * 0.6}deg) saturate(${100 - c.temp * 0.3}%)`);
  return p.length ? p.join(' ') : 'none';
}

export const NEUTRAL = { brightness: 100, contrast: 100, saturate: 100, temp: 0 };
// Measured to be a lift, not a look: enough to cut through arena lighting
// without turning white ice grey-blue.
export const ENHANCE = { brightness: 104, contrast: 112, saturate: 115, temp: 4 };

const QUALITY = [
  ['Original', { scale: 1, bitrate: 16_000_000 }],
  ['High', { scale: 1, bitrate: 8_000_000 }],
  ['Medium', { scale: 0.75, bitrate: 4_000_000 }],
  ['Small', { scale: 0.5, bitrate: 2_000_000 }],
];

const CROPS = [
  ['Full', { x: 0, y: 0, w: 1, h: 1 }],
  ['16:9 Tight', { x: 0.06, y: 0.06, w: 0.88, h: 0.88 }],
  ['Left Half', { x: 0, y: 0, w: 0.5, h: 1 }],
  ['Right Half', { x: 0.5, y: 0, w: 0.5, h: 1 }],
  ['Top Half', { x: 0, y: 0, w: 1, h: 0.5 }],
  ['Bottom Half', { x: 0, y: 0.5, w: 1, h: 0.5 }],
];

const fmt = (t) => {
  const s = Math.max(0, Math.floor(t || 0));
  return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, '0')}`;
};

// ---------------------------------------------------------------- the sheet

export async function openVideoEditor({ game, video, src, onReplaced }) {
  if (ed) return;
  const dur = video.duration || 0;
  if (!dur) { toast('The Video Is Still Loading', true); return; }
  video.pause();

  ed = {
    game,
    video,
    src,
    onReplaced,
    trim: { in: 0, out: dur },
    crop: { x: 0, y: 0, w: 1, h: 1 },
    color: { ...NEUTRAL },
    patches: [],
    quality: 0,
    rendering: false,
  };

  const veil = document.createElement('div');
  veil.className = 'sheet-veil ve-veil';
  veil.innerHTML = `
    <div class="sheet ve-sheet" role="dialog" aria-modal="true" aria-label="Edit Video">
      <div class="ve-top">
        <h3>Edit ${esc(game.name)}</h3>
        <button class="mini" data-x="close" title="Close Without Changing Anything">Close</button>
      </div>

      <div class="ve-stage">
        <div class="ve-frame" id="veFrame">
          <video id="veVideo" playsinline muted></video>
          <div class="ve-patches" id="vePatches"></div>
        </div>
        <div class="ve-scrub">
          <button class="mini" data-x="play">Play</button>
          <input type="range" id="veSeek" min="0" max="${dur}" step="0.05" value="0">
          <span class="ve-tc" id="veTc">0:00</span>
        </div>
      </div>

      <div class="ve-panel">
        <section class="ve-sec">
          <div class="ve-title">Trim</div>
          <p class="ve-note">Rendering runs in real time, so trimming first is what makes everything else quick.</p>
          <p class="ve-warn" id="veStranded" hidden></p>
          <label class="ve-row"><span>Start</span>
            <input type="range" id="veIn" min="0" max="${dur}" step="0.1" value="0">
            <em id="veInTc">0:00</em>
            <button class="mini" data-x="inHere" title="Set The Start To Where The Preview Is">Set Here</button>
          </label>
          <label class="ve-row"><span>End</span>
            <input type="range" id="veOut" min="0" max="${dur}" step="0.1" value="${dur}">
            <em id="veOutTc">${fmt(dur)}</em>
            <button class="mini" data-x="outHere" title="Set The End To Where The Preview Is">Set Here</button>
          </label>
        </section>

        <section class="ve-sec">
          <div class="ve-title">Crop</div>
          <div class="an-seg ve-seg" id="veCrops" role="group" aria-label="Crop">
            ${CROPS.map(([n], i) => `<button class="an-segbtn${i === 0 ? ' on' : ''}" data-crop="${i}">${n}</button>`).join('')}
          </div>
        </section>

        <section class="ve-sec">
          <div class="ve-title">Colour</div>
          <div class="ve-chips">
            <button class="mini" data-x="enhance" title="A Contrast And Saturation Lift - Not AI Upscaling">Enhance</button>
            <button class="mini" data-x="neutral">Reset</button>
          </div>
          ${[['brightness', 'Brightness', 50, 150], ['contrast', 'Contrast', 50, 200],
             ['saturate', 'Saturation', 0, 200], ['temp', 'Warmth', -60, 60]].map(([k, label, lo, hi]) => `
            <label class="ve-row"><span>${label}</span>
              <input type="range" data-c="${k}" min="${lo}" max="${hi}" step="1" value="${NEUTRAL[k]}">
              <em data-cv="${k}">${NEUTRAL[k]}</em>
            </label>`).join('')}
        </section>

        <section class="ve-sec">
          <div class="ve-title">Patch Out A Watermark</div>
          <p class="ve-note">Drag a box over the logo. It is covered with a blur or a solid block - the pixels underneath cannot be recovered, so this hides a mark rather than removing it.</p>
          <div class="ve-chips">
            <button class="mini" data-x="addPatch">+ Box</button>
            <span class="an-seg" role="group" aria-label="Patch Style">
              <button class="an-segbtn" data-x="patchBlur">Blur</button>
              <button class="an-segbtn on" data-x="patchSolid">Solid</button>
            </span>
          </div>
          <div class="ve-patchlist" id="vePatchList"></div>
        </section>

        <section class="ve-sec">
          <div class="ve-title">Quality And Size</div>
          <div class="an-seg ve-seg" id="veQual" role="group" aria-label="Quality">
            ${QUALITY.map(([n], i) => `<button class="an-segbtn${i === 0 ? ' on' : ''}" data-q="${i}">${n}</button>`).join('')}
          </div>
          <p class="ve-note" id="veEstimate"></p>
        </section>
      </div>

      <div class="sheet-row ve-foot">
        <button class="btn" data-x="revert" id="veRevert" hidden title="Put The Original File Back">Revert To Original</button>
        <span class="vp-flex"></span>
        <span class="ve-progress" id="veProgress" hidden></span>
        <button class="btn" data-x="close">Cancel</button>
        <button class="btn btn-ink" data-x="apply">Apply And Replace</button>
      </div>
    </div>`;
  document.body.appendChild(veil);
  ed.veil = veil;

  const v = veil.querySelector('#veVideo');
  v.src = src;
  const seek = veil.querySelector('#veSeek');
  const tc = veil.querySelector('#veTc');
  const frame = veil.querySelector('#veFrame');

  // The preview is CSS only, so every control is instant and nothing is
  // encoded until Apply.
  const paintPreview = () => {
    v.style.filter = filterString(ed.color);
    const c = ed.crop;
    // Crop is shown by scaling the video up and shifting it, so the frame
    // element becomes the viewport onto the kept region.
    v.style.transform = `scale(${1 / c.w}) translate(${-c.x * 100}%, ${-c.y * 100}%)`;
    v.style.transformOrigin = 'top left';
    paintPatches();
    paintEstimate();
  };

  const paintPatches = () => {
    const box = veil.querySelector('#vePatches');
    box.innerHTML = ed.patches.map((p, i) => `
      <div class="ve-patch${p.blur ? ' blur' : ''}" data-p="${i}"
        style="left:${p.x * 100}%;top:${p.y * 100}%;width:${p.w * 100}%;height:${p.h * 100}%">
        <button class="ve-patchdel" data-delp="${i}" title="Remove This Box">&times;</button>
      </div>`).join('');
    veil.querySelector('#vePatchList').innerHTML = ed.patches.length
      ? ed.patches.map((p, i) => `<span class="ve-chip ve-chip--static">Box ${i + 1} &middot; ${p.blur ? 'Blur' : 'Solid'}</span>`).join('')
      : '<span class="ve-note">No boxes yet.</span>';
    box.querySelectorAll('[data-delp]').forEach((b) => {
      b.onclick = (e) => { e.stopPropagation(); ed.patches.splice(Number(b.dataset.delp), 1); paintPreview(); };
    });
    wirePatchDrag(box);
  };

  const paintEstimate = () => {
    const len = Math.max(0, ed.trim.out - ed.trim.in);
    const q = QUALITY[ed.quality][1];
    const mb = (q.bitrate / 8) * len / 1_000_000;
    veil.querySelector('#veEstimate').textContent =
      `About ${mb < 1024 ? `${Math.round(mb)} MB` : `${(mb / 1024).toFixed(1)} GB`}, and about ${fmt(len)} to render because it encodes in real time.`;
    // Stranded tags are named, not silently moved. Which clips matter is the
    // coach's call; this only makes sure the call is an informed one.
    const out = clipsOutside(ed.game, ed.trim.in, ed.trim.out);
    const warn = veil.querySelector('#veStranded');
    const bits = [];
    if (out.clips) bits.push(`${out.clips} clip${out.clips === 1 ? '' : 's'}`);
    if (out.freezes) bits.push(`${out.freezes} freeze${out.freezes === 1 ? '' : 's'}`);
    warn.hidden = !bits.length;
    warn.textContent = bits.length
      ? `${bits.join(' and ')} sit outside this trim and will point at footage that is gone. Reverting puts them back exactly.`
      : '';
  };

  // ---- preview transport
  veil.querySelector('[data-x="play"]').onclick = (e) => {
    if (v.paused) { void v.play(); e.target.textContent = 'Pause'; }
    else { v.pause(); e.target.textContent = 'Play'; }
  };
  seek.oninput = () => { v.currentTime = Number(seek.value); };
  v.addEventListener('timeupdate', () => {
    seek.value = v.currentTime;
    tc.textContent = fmt(v.currentTime);
  });
  v.addEventListener('loadedmetadata', paintPreview);

  // ---- trim
  const inR = veil.querySelector('#veIn');
  const outR = veil.querySelector('#veOut');
  const syncTrim = () => {
    // The handles cannot cross. Half a second apart is the floor, which is
    // still shorter than any clip anyone would keep.
    if (ed.trim.in > ed.trim.out - 0.5) ed.trim.in = Math.max(0, ed.trim.out - 0.5);
    inR.value = ed.trim.in; outR.value = ed.trim.out;
    veil.querySelector('#veInTc').textContent = fmt(ed.trim.in);
    veil.querySelector('#veOutTc').textContent = fmt(ed.trim.out);
    paintEstimate();
  };
  inR.oninput = () => { ed.trim.in = Number(inR.value); syncTrim(); v.currentTime = ed.trim.in; };
  outR.oninput = () => { ed.trim.out = Number(outR.value); syncTrim(); v.currentTime = ed.trim.out; };
  veil.querySelector('[data-x="inHere"]').onclick = () => { ed.trim.in = v.currentTime; syncTrim(); };
  veil.querySelector('[data-x="outHere"]').onclick = () => { ed.trim.out = v.currentTime; syncTrim(); };

  // ---- crop
  veil.querySelectorAll('[data-crop]').forEach((b) => {
    b.onclick = () => {
      ed.crop = { ...CROPS[Number(b.dataset.crop)][1] };
      veil.querySelectorAll('[data-crop]').forEach((o) => o.classList.toggle('on', o === b));
      paintPreview();
    };
  });

  // ---- colour
  const syncColor = () => {
    veil.querySelectorAll('[data-c]').forEach((i) => {
      i.value = ed.color[i.dataset.c];
      veil.querySelector(`[data-cv="${i.dataset.c}"]`).textContent = ed.color[i.dataset.c];
    });
    paintPreview();
  };
  veil.querySelectorAll('[data-c]').forEach((i) => {
    i.oninput = () => { ed.color[i.dataset.c] = Number(i.value); syncColor(); };
  });
  veil.querySelector('[data-x="enhance"]').onclick = () => { ed.color = { ...ENHANCE }; syncColor(); };
  veil.querySelector('[data-x="neutral"]').onclick = () => { ed.color = { ...NEUTRAL }; syncColor(); };

  // ---- patches
  let patchBlur = false;
  veil.querySelector('[data-x="patchBlur"]').onclick = (e) => {
    patchBlur = true;
    e.target.classList.add('on');
    veil.querySelector('[data-x="patchSolid"]').classList.remove('on');
  };
  veil.querySelector('[data-x="patchSolid"]').onclick = (e) => {
    patchBlur = false;
    e.target.classList.add('on');
    veil.querySelector('[data-x="patchBlur"]').classList.remove('on');
  };
  veil.querySelector('[data-x="addPatch"]').onclick = () => {
    // Lands bottom right, because that is where a broadcast bug almost
    // always is, and is then dragged anywhere.
    ed.patches.push({ x: 0.72, y: 0.8, w: 0.24, h: 0.14, blur: patchBlur });
    paintPreview();
  };

  function wirePatchDrag(box) {
    box.querySelectorAll('.ve-patch').forEach((elm) => {
      elm.onpointerdown = (e) => {
        if (e.target.dataset.delp != null) return;
        e.preventDefault();
        const p = ed.patches[Number(elm.dataset.p)];
        const r = frame.getBoundingClientRect();
        const ox = e.clientX / r.width - p.x;
        const oy = e.clientY / r.height - p.y;
        const rx = r.left / r.width;
        const ry = r.top / r.height;
        const mv = (ev) => {
          p.x = Math.max(0, Math.min(1 - p.w, ev.clientX / r.width - ox - rx));
          p.y = Math.max(0, Math.min(1 - p.h, ev.clientY / r.height - oy - ry));
          elm.style.left = `${p.x * 100}%`;
          elm.style.top = `${p.y * 100}%`;
        };
        const up = () => {
          window.removeEventListener('pointermove', mv);
          window.removeEventListener('pointerup', up);
        };
        window.addEventListener('pointermove', mv);
        window.addEventListener('pointerup', up);
      };
    });
  }

  // ---- quality
  veil.querySelectorAll('[data-q]').forEach((b) => {
    b.onclick = () => {
      ed.quality = Number(b.dataset.q);
      veil.querySelectorAll('[data-q]').forEach((o) => o.classList.toggle('on', o === b));
      paintEstimate();
    };
  });

  // ---- revert, only offered when an original is actually on disk
  const origPath = `${ORIGINALS}/${game.name}`;
  if (fsConnected()) {
    try {
      if (await fsExists(origPath)) {
        const rb = veil.querySelector('#veRevert');
        rb.hidden = false;
        rb.onclick = () => void revertToOriginal(game, origPath, onReplaced);
      }
    } catch (_) { /* no originals folder yet is the normal case */ }
  }

  veil.querySelectorAll('[data-x="close"]').forEach((b) => { b.onclick = () => closeEditor(); });
  veil.addEventListener('mousedown', (e) => { if (e.target === veil && !ed.rendering) closeEditor(); });
  veil.querySelector('[data-x="apply"]').onclick = () => void applyEdit();

  syncTrim();
  syncColor();
  paintPatches();
}

export function closeEditor() {
  if (!ed) return;
  if (ed.rendering) { toast('Still Rendering - Let It Finish', true); return; }
  ed.veil.remove();
  ed = null;
}

// ------------------------------------------------------------------ render

async function applyEdit() {
  if (!ed || ed.rendering) return;
  const { game, video, trim, crop, color, patches } = ed;
  const q = QUALITY[ed.quality][1];
  const len = Math.max(0, trim.out - trim.in);
  if (len < 0.5) { toast('Nothing To Render - Check The Trim', true); return; }

  if (game.source === 'local') {
    toast('This Video Was Opened As A One-Off File - The Edit Will Download Instead Of Replacing It', true);
  }

  ed.rendering = true;
  const prog = ed.veil.querySelector('#veProgress');
  prog.hidden = false;
  const apply = ed.veil.querySelector('[data-x="apply"]');
  apply.disabled = true;

  // The patches are painted in OUTPUT pixels, after the frame is drawn and
  // after the filter has been cleared, so a blur box blurs the picture rather
  // than the picture plus its own edge.
  const paint = (ctx, cv) => {
    for (const p of patches) {
      const px = p.x * cv.width; const py = p.y * cv.height;
      const pw = p.w * cv.width; const ph = p.h * cv.height;
      if (p.blur) {
        ctx.save();
        ctx.beginPath();
        ctx.rect(px, py, pw, ph);
        ctx.clip();
        ctx.filter = `blur(${Math.max(6, Math.round(pw * 0.08))}px)`;
        ctx.drawImage(cv, 0, 0);
        ctx.restore();
      } else {
        ctx.fillStyle = '#000';
        ctx.fillRect(px, py, pw, ph);
      }
    }
  };

  const started = Date.now();
  try {
    const { blob, ext } = await recordRange(video, {
      from: trim.in,
      to: trim.out,
      crop,
      filter: filterString(color),
      scale: q.scale,
      bitrate: q.bitrate,
      paint: patches.length ? paint : null,
      audio: 'video',
      onFrame: (t) => {
        const done = Math.max(0, t - trim.in);
        prog.textContent = `Rendering ${Math.round((done / len) * 100)}%  (${fmt(done)} of ${fmt(len)})`;
      },
    });
    prog.textContent = 'Saving…';
    await swapInEdited(game, blob, ext, trim.in, ed.onReplaced);
    toast(`Edited In ${fmt((Date.now() - started) / 1000)}`);
    closeEditorForce();
  } catch (e) {
    console.error(e);
    toast(e.message || 'The Render Failed', true);
    ed.rendering = false;
    prog.hidden = true;
    apply.disabled = false;
  }
}

function closeEditorForce() {
  if (!ed) return;
  ed.rendering = false;
  ed.veil.remove();
  ed = null;
}

// ------------------------------------------------------------------ the swap
//
// The original is copied aside BEFORE anything is overwritten, and only once:
// a second edit must not overwrite the untouched original with an already
// edited one, or Revert would put back the first edit instead of the source.

async function swapInEdited(game, blob, ext, trimIn, onReplaced) {
  if (game.source === 'local' || !fsConnected()) {
    await deliver(game, blob, `${game.name.replace(/\.[^.]+$/, '')}-edited.${ext}`);
    return;
  }
  const path = game.path;
  try { await fsCreateFolder(ORIGINALS); } catch (_) { /* already there */ }
  const orig = `${ORIGINALS}/${game.name}`;
  if (!(await fsExists(orig))) {
    const src = await fsGetFile(path);
    await fsWrite(orig, src);
  }
  await fsWrite(path, blob);
  await shiftGame(game, trimIn);
  onReplaced?.();
}

export async function revertToOriginal(game, origPath, onReplaced) {
  try {
    const orig = await fsGetFile(origPath);
    await fsWrite(game.path, orig);
    // Everything shifted by the trims is put back in one step, which is why
    // the total is carried on the record rather than each edit separately.
    await shiftGame(game, -(game.editShift || 0));
    game.editShift = 0;
    game.edited = false;
    await putGame(game);
    toast(`Original Put Back From ${fsLabel(origPath)}`);
    closeEditorForce();
    onReplaced?.();
  } catch (e) {
    console.error(e);
    toast(e.message || 'Could Not Put The Original Back', true);
  }
}

// EVERY TIMECODE IN THE GAME MOVES WITH A TRIM. Clips, freezes and the log all
// store absolute seconds into the file, so cutting 30 seconds off the front
// silently moves all of them unless this runs.
//
// THE SHIFT IS A PURE OFFSET AND IS NEVER CLAMPED. Clamping was the first
// version and it destroyed data: a clip at 5s trimmed by 30 became 0, and
// reverting added the 30 back to give 30 - the original 5 was gone. Keeping
// the arithmetic lossless means revert is exact for every clip, including the
// ones that fall outside the kept footage. A negative in-point is handled at
// playback, where seeking already clamps to zero, and `clipsOutside` warns
// before an edit rather than silently mangling anything.
export async function shiftGame(game, seconds) {
  if (!seconds) return;
  for (const c of game.clips || []) {
    c.in = (c.in || 0) - seconds;
    c.out = (c.out || 0) - seconds;
  }
  for (const f of game.freezes || []) f.t = (f.t || 0) - seconds;
  game.editShift = (game.editShift || 0) + seconds;
  game.edited = true;
  await putGame(game);
}

// How many tags a trim would strand. Reported before Apply, never fixed
// silently: which clips matter is the coach's call, not this file's.
export function clipsOutside(game, from, to) {
  const c = (game.clips || []).filter((x) => x.out <= from || x.in >= to).length;
  const f = (game.freezes || []).filter((x) => x.t < from || x.t > to).length;
  return { clips: c, freezes: f };
}
