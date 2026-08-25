// Freeze-frame annotation: telestration over a paused frame, drawn with the
// SAME element model and renderer as the Diagrams app (/diagrams/js/flat.js),
// so an arrow here looks exactly like an arrow there and every drawing can
// travel into a diagram or an export unchanged.
//
// Elements live in VIDEO pixel coordinates and are stored on the freeze
// ({ id, t, hold, elements }), which the player pauses on during playback.

import { drawEl, arrowCtrl, measureText, TEXT_CHIP } from '/diagrams/js/flat.js';
import { toast, esc } from './ui.js';
import { uid } from './store.js';

let an = null; // { freeze, els, tool, color, sel, drag, onDone, onExport, onSend }
const el = (id) => document.getElementById(id);

const COLORS = [
  ['ink', '#1e1e1e'],
  ['blue', '#75d8ff'],
  ['green', '#16a34a'],
  ['red', '#dc2626'],
];

const TOOLS = [
  ['select', 'Select & Move', '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-linejoin="round"><path d="M4.04 4.69a.5.5 0 0 1 .65-.65l16 6.5a.5.5 0 0 1-.06.94l-6.13 1.58a2 2 0 0 0-1.43 1.44l-1.58 6.12a.5.5 0 0 1-.95.07z"/></svg>'],
  ['pen', 'Pen', '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-linejoin="round"><path d="M21.17 6.81a2.82 2.82 0 0 0-3.98-3.99L3.84 16.17a2 2 0 0 0-.5.83l-1.32 4.35a.5.5 0 0 0 .62.63l4.36-1.32a2 2 0 0 0 .83-.5z"/></svg>'],
  ['arrow', 'Arrow', '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor"><path d="M4 19.5C6.5 12 10.5 8.2 16.5 6.4"/><path d="M13.6 4.1 19.5 5.5 17 11" stroke-linejoin="round"/></svg>'],
  ['box', 'Box', '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor"><rect x="4.25" y="5.25" width="15.5" height="13.5" rx="2.75"/></svg>'],
  ['circle', 'Circle', '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor"><circle cx="12" cy="12" r="7.75"/></svg>'],
  ['player', 'Player Ring', '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor"><circle cx="12" cy="12" r="7"/><circle cx="12" cy="12" r="2.4" fill="currentColor" stroke="none"/></svg>'],
  ['text', 'Text', '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-linecap="round"><path d="M4 7V5.5A1.5 1.5 0 0 1 5.5 4h13A1.5 1.5 0 0 1 20 5.5V7"/><path d="M12 4v16"/><path d="M9 20h6"/></svg>'],
];

const vs = () => (an ? an.vw / 1280 : 1); // element sizes scale with the video

export function annotating() { return !!an; }

// ------------------------------------------------------------- render

function canvas() { return el('anCanvas'); }
function redraw() {
  const c = canvas();
  const ctx = c.getContext('2d');
  ctx.clearRect(0, 0, c.width, c.height);
  for (const x of an.els) drawEl(ctx, x);
  if (an.sel) {
    const b = bounds(an.els.find((z) => z.id === an.sel));
    if (b) {
      ctx.strokeStyle = '#3ec1f5';
      ctx.lineWidth = 2 * vs();
      ctx.setLineDash([8 * vs(), 6 * vs()]);
      ctx.strokeRect(b.x, b.y, b.w, b.h);
      ctx.setLineDash([]);
    }
  }
}

function bounds(x) {
  if (!x) return null;
  if (x.type === 'box' || x.type === 'circle') return { x: x.x, y: x.y, w: x.w, h: x.h };
  if (x.type === 'player') return { x: x.x - x.r, y: x.y - x.r, w: x.r * 2, h: x.r * 2 };
  if (x.type === 'arrow') {
    const xs = [x.x1, x.x2, x.mx]; const ys = [x.y1, x.y2, x.my];
    const pad = (x.width || 8) * 2.5;
    return { x: Math.min(...xs) - pad, y: Math.min(...ys) - pad, w: Math.max(...xs) - Math.min(...xs) + pad * 2, h: Math.max(...ys) - Math.min(...ys) + pad * 2 };
  }
  if (x.type === 'pen') {
    const xs = x.pts.map((p) => p[0]); const ys = x.pts.map((p) => p[1]);
    return { x: Math.min(...xs), y: Math.min(...ys), w: Math.max(...xs) - Math.min(...xs), h: Math.max(...ys) - Math.min(...ys) };
  }
  if (x.type === 'text') {
    const T = TEXT_CHIP;
    const w = measureText(x);
    const padX = x.size * T.padX; const padY = x.size * T.padY;
    return { x: x.x - padX, y: x.y - x.size - padY, w: w + padX * 2, h: x.size * T.height + padY * 2 };
  }
  return null;
}

function hitAt(p) {
  for (let i = an.els.length - 1; i >= 0; i--) {
    const b = bounds(an.els[i]);
    if (b && p.x >= b.x - 8 && p.x <= b.x + b.w + 8 && p.y >= b.y - 8 && p.y <= b.y + b.h + 8) return an.els[i];
  }
  return null;
}

function pt(e) {
  const r = canvas().getBoundingClientRect();
  return { x: ((e.clientX - r.left) / r.width) * an.vw, y: ((e.clientY - r.top) / r.height) * an.vh };
}

// ------------------------------------------------------------- pointer

function onDown(e) {
  if (!an) return;
  e.preventDefault();
  const p = pt(e);
  const s = vs();
  if (an.tool === 'select') {
    const x = hitAt(p);
    an.sel = x?.id || null;
    an.drag = x ? { id: x.id, start: p, orig: structuredClone(x) } : null;
    redraw();
    return;
  }
  if (an.tool === 'pen') {
    const x = { id: uid(), type: 'pen', pts: [[p.x, p.y]], color: an.color, width: 8 * s };
    an.els.push(x);
    an.drag = { id: x.id, kind: 'pen' };
    return;
  }
  if (an.tool === 'arrow') {
    const x = { id: uid(), type: 'arrow', x1: p.x, y1: p.y, x2: p.x, y2: p.y, mx: p.x, my: p.y, color: an.color, width: 8 * s, head: 'triangle' };
    an.els.push(x);
    an.drag = { id: x.id, kind: 'arrow' };
    return;
  }
  if (an.tool === 'box' || an.tool === 'circle') {
    const x = { id: uid(), type: an.tool, x: p.x, y: p.y, w: 0, h: 0, color: an.color, alpha: 0.3 };
    an.els.push(x);
    an.drag = { id: x.id, kind: 'shape', start: p };
    return;
  }
  if (an.tool === 'player') {
    an.els.push({ id: uid(), type: 'circle', x: p.x - 60 * s, y: p.y - 60 * s, w: 120 * s, h: 120 * s, color: an.color, alpha: 0.35 });
    an.tool = 'select';
    paintBar();
    redraw();
    markDirty();
    return;
  }
  if (an.tool === 'text') {
    openTextInput(p);
  }
}

function onMove(e) {
  if (!an?.drag) return;
  const p = pt(e);
  const d = an.drag;
  const x = an.els.find((z) => z.id === d.id);
  if (!x) return;
  if (d.kind === 'pen') {
    const last = x.pts[x.pts.length - 1];
    if (Math.hypot(p.x - last[0], p.y - last[1]) > 3) x.pts.push([p.x, p.y]);
  } else if (d.kind === 'arrow') {
    x.x2 = p.x; x.y2 = p.y; x.mx = (x.x1 + x.x2) / 2; x.my = (x.y1 + x.y2) / 2;
  } else if (d.kind === 'shape') {
    x.x = Math.min(d.start.x, p.x); x.y = Math.min(d.start.y, p.y);
    x.w = Math.abs(p.x - d.start.x); x.h = Math.abs(p.y - d.start.y);
  } else {
    // select-move
    const dx = p.x - d.start.x; const dy = p.y - d.start.y;
    const o = d.orig;
    if (x.type === 'pen') x.pts = o.pts.map(([px, py]) => [px + dx, py + dy]);
    else if (x.type === 'arrow') { x.x1 = o.x1 + dx; x.y1 = o.y1 + dy; x.x2 = o.x2 + dx; x.y2 = o.y2 + dy; x.mx = o.mx + dx; x.my = o.my + dy; }
    else { x.x = o.x + dx; x.y = o.y + dy; }
  }
  redraw();
}

function onUp() {
  if (!an?.drag) return;
  const d = an.drag;
  an.drag = null;
  const x = an.els.find((z) => z.id === d.id);
  if (x && d.kind === 'shape' && (x.w < 12 || x.h < 12)) an.els = an.els.filter((z) => z.id !== d.id);
  if (d.kind !== undefined) markDirty();
  if (d.kind === 'pen' || d.kind === 'arrow' || d.kind === 'shape') { an.tool = 'select'; an.sel = x?.id || null; paintBar(); }
  redraw();
}

function openTextInput(p) {
  const root = el('anRoot');
  const r = canvas().getBoundingClientRect();
  const rootR = root.getBoundingClientRect();
  const scale = r.width / an.vw;
  const size = 56 * vs();
  const input = document.createElement('input');
  input.className = 'an-textinput';
  input.style.left = `${r.left - rootR.left + p.x * scale}px`;
  input.style.top = `${r.top - rootR.top + p.y * scale}px`;
  input.style.fontSize = `${Math.max(12, size * scale)}px`;
  root.appendChild(input);
  const finish = (keep) => {
    const v = input.value.trim();
    input.remove();
    if (keep && v) {
      an.els.push({ id: uid(), type: 'text', x: p.x, y: p.y, text: v, size, color: an.color });
      markDirty();
    }
    an.tool = 'select';
    paintBar();
    redraw();
  };
  input.onkeydown = (e) => {
    e.stopPropagation();
    if (e.key === 'Enter' || e.keyCode === 13) { e.preventDefault(); finish(true); }
    if (e.key === 'Escape') { e.preventDefault(); finish(false); }
  };
  input.onblur = () => finish(true);
  requestAnimationFrame(() => input.focus());
}

function onKey(e) {
  if (!an) return;
  const t = e.target;
  if (t && (t.tagName === 'INPUT' || t.tagName === 'TEXTAREA')) return;
  if ((e.key === 'Backspace' || e.key === 'Delete') && an.sel) {
    e.preventDefault();
    an.els = an.els.filter((z) => z.id !== an.sel);
    an.sel = null;
    markDirty();
    redraw();
  }
  if (e.key === 'Escape') { e.preventDefault(); done(); }
}

let dirty = false;
const markDirty = () => { dirty = true; };

// ------------------------------------------------------------- toolbar

function paintBar() {
  const bar = el('anBar');
  bar.innerHTML = `
    ${TOOLS.map(([t, label, icon]) => `<button class="tb-btn${an.tool === t ? ' on' : ''}" data-tool="${t}" aria-label="${label}">${icon}</button>`).join('')}
    <span class="tb-sep"></span>
    ${COLORS.map(([, hex]) => `<button class="tb-swatch${an.color === hex ? ' on' : ''}" data-color="${hex}" style="--c:${hex}"></button>`).join('')}
    <span class="tb-sep"></span>
    <label class="an-hold" title="How Long Playback Pauses On This Freeze">Hold <input id="anHold" type="number" min="0" max="30" value="${an.freeze.hold ?? 3}">s</label>
    <span class="tb-sep"></span>
    <button class="tb-btn tb-word" data-act="clear" title="Remove Every Drawing On This Freeze">Clear</button>
    <button class="tb-btn tb-word" data-act="export" title="Save The Annotated Frame As A PNG">Export</button>
    <button class="tb-btn tb-word" data-act="diagram" title="Open This Frame In The Diagrams App">Diagram</button>
    <button class="tb-btn tb-word on" data-act="done">Done</button>`;
  bar.querySelectorAll('[data-tool]').forEach((b) => { b.onclick = () => { an.tool = b.dataset.tool; an.sel = null; paintBar(); redraw(); }; });
  bar.querySelectorAll('[data-color]').forEach((b) => { b.onclick = () => { an.color = b.dataset.color; paintBar(); }; });
  el('anHold').onchange = (e) => { an.freeze.hold = Math.max(0, Number(e.target.value) || 0); markDirty(); };
  el('anHold').onkeydown = (e) => e.stopPropagation();
  const act = (n, f) => { bar.querySelector(`[data-act="${n}"]`).onclick = f; };
  act('clear', () => { an.els = []; an.sel = null; markDirty(); redraw(); });
  act('export', () => an.onExport?.(composite(), an.freeze));
  act('diagram', () => an.onSend?.(composite(), an.freeze));
  act('done', done);
}

// The frame with the drawing burned in - for exports and Diagrams handoff.
export function composite() {
  const c = document.createElement('canvas');
  c.width = an.vw; c.height = an.vh;
  const ctx = c.getContext('2d');
  ctx.drawImage(an.frame, 0, 0);
  for (const x of an.els) drawEl(ctx, x);
  return c;
}

function done() {
  an.freeze.elements = an.els;
  const cb = an.onDone;
  const f = an.freeze;
  const wasDirty = dirty;
  teardown();
  if (cb) cb(f, wasDirty);
}

function teardown() {
  el('anRoot').hidden = true;
  an = null;
  dirty = false;
}

// ------------------------------------------------------------- open

let wired = false;
export function openAnnotate(freeze, frameCanvas, { onDone, onExport, onSend } = {}) {
  const root = el('anRoot');
  root.hidden = false;
  an = {
    freeze,
    els: structuredClone(freeze.elements || []),
    tool: freeze.elements?.length ? 'select' : 'pen',
    color: '#dc2626',
    sel: null,
    drag: null,
    vw: frameCanvas.width,
    vh: frameCanvas.height,
    frame: frameCanvas,
    onDone,
    onExport,
    onSend,
  };
  const c = canvas();
  c.width = an.vw; c.height = an.vh;
  el('anFrame').getContext('2d').canvas.width = an.vw;
  el('anFrame').height = an.vh;
  el('anFrame').getContext('2d').drawImage(frameCanvas, 0, 0);
  if (!wired) {
    wired = true;
    c.addEventListener('pointerdown', onDown);
    window.addEventListener('pointermove', onMove);
    window.addEventListener('pointerup', onUp);
    window.addEventListener('keydown', onKey, true);
  }
  paintBar();
  redraw();
  toast('Draw On The Frame - Done Saves It As A Freeze', false);
  void esc; void arrowCtrl;
}
