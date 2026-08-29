// CTH Clips - the video editor.
//
// Rebuilt 2026-08-27 on Tony's "instant or remove it". The first version
// re-encoded the whole file through MediaRecorder in real time, so a 90
// minute game cost 90 minutes and came back lossy. Nothing is re-encoded
// now: the edit is a GRADE on the game record (see grade.js), applied at
// playback, on a frozen frame and in every export. Apply and Revert are one
// IndexedDB write each, which is why they are instant rather than merely
// fast.
//
// THE EDITOR IS A PREVIEW OF THE GRADE, nothing more. Every control writes
// into `ed.g` and repaints through the same `gradeCss` the player uses, so
// what is on screen here is exactly what the player and the exports produce.
// There is no second rendering path to drift.
//
// THERE IS NO APPLY BUTTON, on purpose: there is nothing to wait for. A
// change is written straight onto the record and the player behind the sheet
// moves with it.

import { toast, esc } from './ui.js';
import { putGame } from './store.js';
import {
  emptyGrade, normalizeGrade, isNeutral, gradeCss,
  NEUTRAL, ENHANCE, FULL_CROP,
} from './grade.js';

let ed = null;

export function editing() { return !!ed; }

// Aspect presets set the SHAPE and centre it; the box is then dragged. A
// starting point, not the six fixed crops this used to offer.
const ASPECTS = [
  ['Free', null],
  ['16:9', 16 / 9],
  ['4:3', 4 / 3],
  ['1:1', 1],
  ['9:16', 9 / 16],
];

const fmt = (t) => {
  const s = Math.max(0, Math.floor(t || 0));
  return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, '0')}`;
};

const clamp01 = (v) => Math.max(0, Math.min(1, v));

export async function openVideoEditor({ game, video, src, onApplied }) {
  if (ed) return;
  const dur = video.duration || 0;
  if (!dur) { toast('The Video Is Still Loading', true); return; }
  const wasPlaying = !video.paused;
  video.pause();

  ed = {
    game,
    video,
    onApplied,
    g: normalizeGrade(game.grade) || emptyGrade(),
    aspect: null,
    patchBlur: false,
    wasPlaying,
  };

  const veil = document.createElement('div');
  veil.className = 'sheet-veil ve-veil';
  veil.innerHTML = `
    <div class="sheet ve-sheet" role="dialog" aria-modal="true" aria-label="Edit Video">
      <div class="ve-top">
        <h3>Edit ${esc(game.name)}</h3>
        <span class="ve-live">Changes apply instantly - nothing is re-encoded</span>
        <button class="mini" data-x="close" title="Close">Close</button>
      </div>

      <div class="ve-stage">
        <div class="ve-frame" id="veFrame">
          <div class="ve-fit" id="veFit">
            <video id="veVideo" playsinline muted></video>
            <div class="ve-patches" id="vePatches"></div>
            <div class="ve-croplay" id="veCropLay" hidden>
              <div class="ve-cropbox" id="veCropBox">
                ${['nw', 'ne', 'sw', 'se', 'n', 's', 'w', 'e'].map((h) => `<i class="ve-h ve-h--${h}" data-h="${h}"></i>`).join('')}
              </div>
            </div>
          </div>
        </div>
        <div class="ve-scrub">
          <button class="mini" data-x="play">Play</button>
          <input type="range" id="veSeek" min="0" max="${dur}" step="0.05" value="0" aria-label="Position">
          <span class="ve-tc" id="veTc">0:00</span>
        </div>
      </div>

      <div class="ve-panel">
        <section class="ve-sec">
          <div class="ve-title">Crop</div>
          <div class="ve-chips">
            <span class="an-seg ve-seg" id="veAspect" role="group" aria-label="Aspect">
              ${ASPECTS.map(([n], i) => `<button class="an-segbtn${i === 0 ? ' on' : ''}" data-asp="${i}">${n}</button>`).join('')}
            </span>
          </div>
          <div class="ve-chips">
            <button class="mini" data-x="cropOn">Draw A Crop</button>
            <button class="mini" data-x="cropOff">Full Frame</button>
          </div>
          <p class="ve-note" id="veCropNote">Full frame.</p>
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
              <input type="range" data-c="${k}" min="${lo}" max="${hi}" step="1" value="${NEUTRAL[k]}" aria-label="${label}">
              <em data-cv="${k}">${NEUTRAL[k]}</em>
            </label>`).join('')}
        </section>

        <section class="ve-sec">
          <div class="ve-title">Cover A Watermark</div>
          <p class="ve-note">Drag a box over the logo. It is covered, not removed - the pixels underneath cannot be recovered.</p>
          <div class="ve-chips">
            <button class="mini" data-x="addPatch">+ Box</button>
            <span class="an-seg" role="group" aria-label="Patch Style">
              <button class="an-segbtn" data-x="patchBlur">Blur</button>
              <button class="an-segbtn on" data-x="patchSolid">Solid</button>
            </span>
          </div>
          <div class="ve-patchlist" id="vePatchList"></div>
        </section>
      </div>

      <div class="sheet-row ve-foot">
        <button class="btn" data-x="revert" id="veRevert">Remove All Edits</button>
        <span class="vp-flex"></span>
        <span class="ve-state" id="veState"></span>
        <button class="btn btn-ink" data-x="close">Done</button>
      </div>
    </div>`;
  document.body.appendChild(veil);
  ed.veil = veil;

  const v = veil.querySelector('#veVideo');
  v.src = src;
  const fit = veil.querySelector('#veFit');
  const seek = veil.querySelector('#veSeek');
  const cropLay = veil.querySelector('#veCropLay');
  const cropBox = veil.querySelector('#veCropBox');

  // -------------------------------------------------------------- painting

  const paint = () => {
    const css = gradeCss(ed.g);
    v.style.filter = css.filter;
    // While the crop overlay is open the picture stays UNCROPPED, because the
    // box is drawn on the full frame - cropping the preview under a crop tool
    // would move the thing being aimed at.
    v.style.transform = cropLay.hidden ? css.transform : 'none';
    v.style.transformOrigin = 'top left';
    paintPatches();
    paintCropBox();
    paintState();
  };

  const paintCropBox = () => {
    const c = ed.g.crop;
    cropBox.style.left = `${c.x * 100}%`;
    cropBox.style.top = `${c.y * 100}%`;
    cropBox.style.width = `${c.w * 100}%`;
    cropBox.style.height = `${c.h * 100}%`;
    const full = c.x === 0 && c.y === 0 && c.w === 1 && c.h === 1;
    veil.querySelector('#veCropNote').textContent = full
      ? 'Full frame.'
      : `Keeping ${Math.round(c.w * 100)}% by ${Math.round(c.h * 100)}% of the frame.`;
  };

  const paintPatches = () => {
    const box = veil.querySelector('#vePatches');
    box.innerHTML = ed.g.patches.map((p, i) => `
      <div class="ve-patch${p.blur ? ' blur' : ''}" data-p="${i}"
        style="left:${p.x * 100}%;top:${p.y * 100}%;width:${p.w * 100}%;height:${p.h * 100}%">
        <button class="ve-patchdel" data-delp="${i}" title="Remove This Box">&times;</button>
      </div>`).join('');
    veil.querySelector('#vePatchList').innerHTML = ed.g.patches.length
      ? ed.g.patches.map((p, i) => `<span class="ve-chip ve-chip--static">Box ${i + 1} &middot; ${p.blur ? 'Blur' : 'Solid'}</span>`).join('')
      : '<span class="ve-note">No boxes yet.</span>';
    for (const b of box.querySelectorAll('[data-delp]')) {
      b.onclick = (e) => { e.stopPropagation(); ed.g.patches.splice(Number(b.dataset.delp), 1); commit(); };
    }
    wirePatchDrag(box);
  };

  const paintState = () => {
    const s = veil.querySelector('#veState');
    s.textContent = isNeutral(ed.g) ? 'No edits' : 'Applied';
    s.classList.toggle('on', !isNeutral(ed.g));
    veil.querySelector('#veRevert').disabled = isNeutral(ed.g);
  };

  // The write is debounced only so a slider drag is one save rather than
  // sixty; the PREVIEW is never debounced, so the picture is always live.
  let saveTimer = 0;
  const commit = () => {
    paint();
    clearTimeout(saveTimer);
    saveTimer = setTimeout(async () => {
      ed.game.grade = isNeutral(ed.g) ? null : ed.g;
      await putGame(ed.game);
      ed.onApplied?.(ed.game.grade);
    }, 180);
  };

  // -------------------------------------------------------------- transport

  veil.querySelector('[data-x="play"]').onclick = (e) => {
    if (v.paused) { void v.play(); e.target.textContent = 'Pause'; }
    else { v.pause(); e.target.textContent = 'Play'; }
  };
  seek.oninput = () => { v.currentTime = Number(seek.value); };
  v.addEventListener('timeupdate', () => {
    seek.value = v.currentTime;
    veil.querySelector('#veTc').textContent = fmt(v.currentTime);
  });
  v.addEventListener('loadedmetadata', () => {
    v.currentTime = Math.min(video.currentTime, v.duration || 0);
    paint();
  });

  // ------------------------------------------------------------ custom crop

  const setAspect = (a) => {
    ed.aspect = a;
    if (!a) return;
    const c = ed.g.crop;
    const boxW = fit.clientWidth * c.w;
    const boxH = fit.clientHeight * c.h;
    let w = c.w;
    let h = c.h;
    if (boxW / boxH > a) w = (boxH * a) / fit.clientWidth;
    else h = (boxW / a) / fit.clientHeight;
    w = Math.min(1, w); h = Math.min(1, h);
    ed.g.crop = {
      x: clamp01(Math.min(c.x + (c.w - w) / 2, 1 - w)),
      y: clamp01(Math.min(c.y + (c.h - h) / 2, 1 - h)),
      w, h,
    };
    commit();
  };

  for (const b of veil.querySelectorAll('[data-asp]')) {
    b.onclick = () => {
      for (const o of veil.querySelectorAll('[data-asp]')) o.classList.toggle('on', o === b);
      cropLay.hidden = false;
      if (ed.g.crop.w === 1 && ed.g.crop.h === 1) ed.g.crop = { x: 0.1, y: 0.1, w: 0.8, h: 0.8 };
      setAspect(ASPECTS[Number(b.dataset.asp)][1]);
      paint();
    };
  }
  veil.querySelector('[data-x="cropOn"]').onclick = () => {
    cropLay.hidden = false;
    if (ed.g.crop.w === 1 && ed.g.crop.h === 1) ed.g.crop = { x: 0.1, y: 0.1, w: 0.8, h: 0.8 };
    commit();
  };
  veil.querySelector('[data-x="cropOff"]').onclick = () => {
    cropLay.hidden = true;
    ed.g.crop = { ...FULL_CROP };
    commit();
  };

  // Drag the box to move it; drag a handle to resize. Both clamp to the
  // frame, and an aspect lock drives the other axis.
  cropBox.addEventListener('pointerdown', (e) => {
    e.preventDefault();
    e.stopPropagation();
    const handle = e.target.dataset?.h || null;
    const r = fit.getBoundingClientRect();
    const start = { ...ed.g.crop };
    const px = (ev) => clamp01((ev.clientX - r.left) / r.width);
    const py = (ev) => clamp01((ev.clientY - r.top) / r.height);
    const ox = px(e) - start.x;
    const oy = py(e) - start.y;

    const move = (ev) => {
      let c = { ...start };
      if (!handle) {
        c.x = clamp01(Math.min(px(ev) - ox, 1 - start.w));
        c.y = clamp01(Math.min(py(ev) - oy, 1 - start.h));
      } else {
        const mx = px(ev);
        const my = py(ev);
        const right = start.x + start.w;
        const bottom = start.y + start.h;
        if (handle.includes('w')) { c.x = Math.min(mx, right - 0.05); c.w = right - c.x; }
        if (handle.includes('e')) { c.w = Math.max(0.05, mx - start.x); }
        if (handle.includes('n')) { c.y = Math.min(my, bottom - 0.05); c.h = bottom - c.y; }
        if (handle.includes('s')) { c.h = Math.max(0.05, my - start.y); }
        if (ed.aspect) {
          if (handle === 'n' || handle === 's') {
            c.w = Math.min(1 - c.x, (c.h * r.height * ed.aspect) / r.width);
          } else {
            c.h = Math.min(1 - c.y, (c.w * r.width) / ed.aspect / r.height);
          }
        }
      }
      ed.g.crop = {
        x: clamp01(c.x),
        y: clamp01(c.y),
        w: Math.max(0.05, Math.min(c.w, 1 - clamp01(c.x))),
        h: Math.max(0.05, Math.min(c.h, 1 - clamp01(c.y))),
      };
      paint();
    };
    const up = () => {
      window.removeEventListener('pointermove', move);
      window.removeEventListener('pointerup', up);
      commit();
    };
    window.addEventListener('pointermove', move);
    window.addEventListener('pointerup', up);
  });

  // ---------------------------------------------------------------- colour

  const syncColor = () => {
    for (const i of veil.querySelectorAll('[data-c]')) {
      i.value = ed.g.color[i.dataset.c];
      i.dispatchEvent(new Event('input', { bubbles: true }));
      veil.querySelector(`[data-cv="${i.dataset.c}"]`).textContent = ed.g.color[i.dataset.c];
    }
  };
  for (const i of veil.querySelectorAll('[data-c]')) {
    i.addEventListener('input', () => {
      ed.g.color[i.dataset.c] = Number(i.value);
      veil.querySelector(`[data-cv="${i.dataset.c}"]`).textContent = i.value;
      commit();
    });
  }
  veil.querySelector('[data-x="enhance"]').onclick = () => { ed.g.color = { ...ENHANCE }; syncColor(); commit(); };
  veil.querySelector('[data-x="neutral"]').onclick = () => { ed.g.color = { ...NEUTRAL }; syncColor(); commit(); };

  // --------------------------------------------------------------- patches

  veil.querySelector('[data-x="patchBlur"]').onclick = (e) => {
    ed.patchBlur = true;
    e.target.classList.add('on');
    veil.querySelector('[data-x="patchSolid"]').classList.remove('on');
  };
  veil.querySelector('[data-x="patchSolid"]').onclick = (e) => {
    ed.patchBlur = false;
    e.target.classList.add('on');
    veil.querySelector('[data-x="patchBlur"]').classList.remove('on');
  };
  veil.querySelector('[data-x="addPatch"]').onclick = () => {
    // Bottom right, because that is where a broadcast bug almost always is.
    ed.g.patches.push({ x: 0.72, y: 0.8, w: 0.24, h: 0.14, blur: ed.patchBlur });
    commit();
  };

  function wirePatchDrag(box) {
    for (const elm of box.querySelectorAll('.ve-patch')) {
      elm.onpointerdown = (e) => {
        if (e.target.dataset.delp != null) return;
        e.preventDefault();
        const p = ed.g.patches[Number(elm.dataset.p)];
        const r = fit.getBoundingClientRect();
        const ox = (e.clientX - r.left) / r.width - p.x;
        const oy = (e.clientY - r.top) / r.height - p.y;
        const mv = (ev) => {
          p.x = Math.max(0, Math.min(1 - p.w, (ev.clientX - r.left) / r.width - ox));
          p.y = Math.max(0, Math.min(1 - p.h, (ev.clientY - r.top) / r.height - oy));
          elm.style.left = `${p.x * 100}%`;
          elm.style.top = `${p.y * 100}%`;
        };
        const up = () => {
          window.removeEventListener('pointermove', mv);
          window.removeEventListener('pointerup', up);
          commit();
        };
        window.addEventListener('pointermove', mv);
        window.addEventListener('pointerup', up);
      };
    }
  }

  // ------------------------------------------------------------------ exit

  veil.querySelector('[data-x="revert"]').onclick = () => {
    ed.g = emptyGrade();
    ed.aspect = null;
    cropLay.hidden = true;
    for (const o of veil.querySelectorAll('[data-asp]')) o.classList.toggle('on', o.dataset.asp === '0');
    syncColor();
    commit();
    toast('Edits Removed');
  };
  for (const b of veil.querySelectorAll('[data-x="close"]')) b.onclick = () => closeEditor();
  veil.addEventListener('mousedown', (e) => { if (e.target === veil) closeEditor(); });

  syncColor();
  paint();
}

export function closeEditor() {
  if (!ed) return;
  const { video, wasPlaying, veil } = ed;
  veil.remove();
  ed = null;
  if (wasPlaying) void video.play().catch(() => {});
}
