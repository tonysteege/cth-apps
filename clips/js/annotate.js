// Freeze-frame annotation: telestration over a paused frame, drawn with the
// SAME element model and renderer as the Diagrams app (/diagrams/js/flat.js),
// so an arrow here looks exactly like an arrow there and every drawing can
// travel into a diagram or an export unchanged.
//
// Elements live in VIDEO pixel coordinates and are stored on the freeze
// ({ id, t, hold, elements }), which the player pauses on during playback.
//
// Rebuilt 2026-08-27 to Tony's spec. Four ideas run through the changes:
//
//  - A TOOL STAYS ARMED. Every draw used to snap back to Select, so putting
//    three arrows on a play meant re-arming twice. Escape disarms; another
//    tool replaces it; nothing else does.
//  - EVERY PLACED OBJECT IS EDITABLE. Shapes take corner handles, lines and
//    arrows take endpoint handles plus a middle one that bends the curve -
//    the same affordances the Diagrams editor has, in the same cyan.
//  - THE ANGLE TOOL IS A REAL MEASUREMENT, not a decoration: three handles,
//    and a readout that is always on screen and always the true angle.
//  - A TEXT BOX LOOKS THE SAME BEING TYPED AND BEING READ. The field and the
//    committed chip share one drawing, so committing looks like nothing
//    happened except the loss of selection.

import { drawEl, measureText, TEXT_CHIP } from '/diagrams/js/flat.js';
import { toast, esc } from './ui.js';
import { uid } from './store.js';

let an = null;
const el = (id) => document.getElementById(id);

// The Diagrams cyan. Selection chrome mirrors what a drill's objects wear
// on a rink, so the two editors feel like one hand (2026-08-27).
const CYAN = '#75d8ff';

// Telestration colours: high chroma so they hold up over both white ice and
// dark boards. Red leads because it is the default (Tony's call).
const COLORS = [
  ['red', '#ff3b30'],
  ['yellow', '#ffd60a'],
  ['blue', '#0a84ff'],
  ['green', '#34c759'],
  ['ink', '#1e1e1e'],
];

const TOOLS = [
  ['select', 'Select & Move', '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-linejoin="round"><path d="M4.04 4.69a.5.5 0 0 1 .65-.65l16 6.5a.5.5 0 0 1-.06.94l-6.13 1.58a2 2 0 0 0-1.43 1.44l-1.58 6.12a.5.5 0 0 1-.95.07z"/></svg>'],
  ['pen', 'Pen', '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-linejoin="round"><path d="M21.17 6.81a2.82 2.82 0 0 0-3.98-3.99L3.84 16.17a2 2 0 0 0-.5.83l-1.32 4.35a.5.5 0 0 0 .62.63l4.36-1.32a2 2 0 0 0 .83-.5z"/></svg>'],
  ['arrow', 'Arrow', '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-linejoin="round" stroke-linecap="round"><path d="M3 12h13.6"/><path d="m16.6 8.4 3.7 3.6-3.7 3.6"/></svg>'],
  ['box', 'Box', '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor"><rect x="4.25" y="5.25" width="15.5" height="13.5" rx="2.75"/></svg>'],
  ['circle', 'Circle', '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor"><circle cx="12" cy="12" r="7.75"/></svg>'],
  ['angle', 'Joint Angle', '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-linejoin="round" stroke-linecap="round"><path d="M5 19h15"/><path d="M5 19 16 6"/><path d="M11.5 19a7 7 0 0 0-1.3-4"/></svg>'],
  ['text', 'Text', '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-linecap="round"><path d="M4 7V5.5A1.5 1.5 0 0 1 5.5 4h13A1.5 1.5 0 0 1 20 5.5V7"/><path d="M12 4v16"/><path d="M9 20h6"/></svg>'],
  // Added 2026-08-27 on Tony's spec. Icons are drawn on the same 24 grid at
  // the same 1.9 stroke as the set above, so the row reads as one family.
  ['line', 'Line', '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-linecap="round"><path d="M4.5 19.5 19.5 4.5"/></svg>'],
  ['freearrow', 'Freeform Arrow', '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-linecap="round" stroke-linejoin="round"><path d="M3 17c3.5 0 5-9 9-9 2.6 0 3.6 4 6.4 4.6"/><path d="m15.9 9.9 3.6 2.7-2.4 3.2"/></svg>'],
  ['spotlight', 'Spotlight A Player', '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-linecap="round"><circle cx="12" cy="12" r="4.25"/><path d="M12 2.5v2.2M12 19.3v2.2M2.5 12h2.2M19.3 12h2.2"/></svg>'],
];

const POS_ICON = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="10.5" r="3.1"/><path d="M12 2.6a7.9 7.9 0 0 0-7.9 7.9c0 5.5 7.9 10.9 7.9 10.9s7.9-5.4 7.9-10.9A7.9 7.9 0 0 0 12 2.6Z"/></svg>';

const DEFAULT_KEYS = { select: 'v', pen: 'd', arrow: 'a', box: 'b', circle: 'c', angle: 'g', text: 't', line: 'n', freearrow: 'w', spotlight: 'r' };
const ACT_KEYS = { clear: 'x', export: 'e' };

// Every tool's default look, overridden by settings.toolStyle. Widths are in
// 1280-wide video units and are scaled by vs() at the moment of drawing.
const DEFAULT_STYLE = {
  pen: { color: '#ff3b30', width: 8, dash: false },
  arrow: { color: '#ff3b30', width: 8, dash: false },
  line: { color: '#ff3b30', width: 8, dash: false },
  freearrow: { color: '#ff3b30', width: 8, dash: false },
  box: { color: '#ffd60a', width: 9, dash: false },
  circle: { color: '#ffd60a', width: 9, dash: false },
  spotlight: { color: '#ffd60a', width: 6, dash: false },
  pos: { color: '#0a84ff', width: 8, dash: false },
};

const vs = () => (an ? an.vw / 1280 : 1); // element sizes scale with the video
const keyFor = (t) => (an?.keys?.[t] || DEFAULT_KEYS[t] || '');

// THE STYLE IS RESOLVED ONTO THE ELEMENT AS IT IS CREATED, never read back
// at render time. A freeze saved today keeps the look it was drawn with even
// if the tool's defaults change tomorrow, which is the same additive promise
// every other stored record here makes.
function styleFor(t) {
  const d = DEFAULT_STYLE[t] || DEFAULT_STYLE.pen;
  const st = { ...d, ...((an?.style || {})[t] || {}) };
  // The colour swatch on the bar is a live override for the active tool, so
  // picking red then drawing does what it looks like it will do.
  const color = (an && an.tool === t && an.colorSet) ? an.color : st.color;
  return { color, width: (st.width ?? d.width) * vs(), dash: !!st.dash };
}

export function annotating() { return !!an; }

// THE IDLE BAR. The toolbar is on screen whether or not a freeze is open, so
// something has to occupy it while nothing is being annotated. It shows the
// same tools in the same order - a row that changed shape when you froze a
// frame would be a different toolbar, not the same one waiting - and picking
// any of them freezes the current frame and arms that tool in one gesture.
export function paintIdleBar(onPick) {
  const bar = el('anBar');
  if (!bar || an) return;
  bar.innerHTML = toolbarHtml({ live: false });
  for (const b of bar.querySelectorAll('[data-idle]')) {
    b.onclick = () => onPick?.(b.dataset.idle);
  }
  // The two popover buttons freeze first as well: picking a colour or a
  // marker is picking a tool, and the row must behave the same in both states.
  for (const b of bar.querySelectorAll('[data-pop]')) {
    b.onclick = () => onPick?.(b.dataset.pop === 'pos' ? 'pos' : 'pen');
  }
}


// Diagnostic tap, the Film Room idiom: only meaningful to someone who went
// looking for it, and free at runtime.
export function annotateDebug() {
  if (!an) return null;
  return { tool: an.tool, sel: [...an.sel], count: an.els.length, drag: an.drag && { ...an.drag, orig: undefined }, vs: vs(), handleR: 12 * vs() };
}

// ------------------------------------------------------------- drawing

// drawEl knows every Diagrams element. The joint angle is ours alone, so it
// is drawn here rather than pushed into the shared renderer - flat.js is an
// interchange contract with Film Room and must not grow a Clips-only type.
function drawAngle(ctx, x) {
  const s = x.width || 8;
  const deg = angleOf(x);
  ctx.save();
  ctx.strokeStyle = x.color;
  ctx.lineWidth = s;
  ctx.lineCap = 'round';
  ctx.lineJoin = 'round';
  ctx.beginPath();
  ctx.moveTo(x.ax, x.ay);
  ctx.lineTo(x.vx, x.vy);
  ctx.lineTo(x.bx, x.by);
  ctx.stroke();
  // The sweep, drawn at a radius that stays inside the shorter leg.
  const la = Math.hypot(x.ax - x.vx, x.ay - x.vy);
  const lb = Math.hypot(x.bx - x.vx, x.by - x.vy);
  const r = Math.max(s * 3, Math.min(la, lb) * 0.34);
  const a0 = Math.atan2(x.ay - x.vy, x.ax - x.vx);
  const a1 = Math.atan2(x.by - x.vy, x.bx - x.vx);
  let d = a1 - a0;
  while (d <= -Math.PI) d += Math.PI * 2;
  while (d > Math.PI) d -= Math.PI * 2;
  ctx.beginPath();
  ctx.lineWidth = s * 0.62;
  ctx.arc(x.vx, x.vy, r, a0, a0 + d, d < 0);
  ctx.stroke();
  // The readout. Always on screen, always the true angle - a measurement
  // you have to hover for is not a measurement.
  const mid = a0 + d / 2;
  const lx = x.vx + Math.cos(mid) * (r + s * 4.2);
  const ly = x.vy + Math.sin(mid) * (r + s * 4.2);
  const label = `${Math.round(deg)}°`;
  ctx.font = `700 ${s * 4.4}px Inter, sans-serif`;
  ctx.textAlign = 'center';
  ctx.textBaseline = 'middle';
  const w = ctx.measureText(label).width;
  const padX = s * 1.5;
  const padY = s * 1.05;
  roundRect(ctx, lx - w / 2 - padX, ly - s * 2.2 - padY, w + padX * 2, s * 4.4 + padY * 2, s * 1.4);
  ctx.fillStyle = 'rgba(255,255,255,0.94)';
  ctx.fill();
  ctx.fillStyle = x.color;
  ctx.fillText(label, lx, ly);
  ctx.restore();
}

export function angleOf(x) {
  const a0 = Math.atan2(x.ay - x.vy, x.ax - x.vx);
  const a1 = Math.atan2(x.by - x.vy, x.bx - x.vx);
  let d = Math.abs(a1 - a0) * (180 / Math.PI);
  if (d > 180) d = 360 - d;
  return d;
}

function roundRect(ctx, x, y, w, h, r) {
  ctx.beginPath();
  ctx.moveTo(x + r, y);
  ctx.arcTo(x + w, y, x + w, y + h, r);
  ctx.arcTo(x + w, y + h, x, y + h, r);
  ctx.arcTo(x, y + h, x, y, r);
  ctx.arcTo(x, y, x + w, y, r);
  ctx.closePath();
}

function drawAny(ctx, x) {
  if (x.type === 'angle') drawAngle(ctx, x);
  else drawEl(ctx, x);
}

function canvas() { return el('anCanvas'); }

function redraw() {
  const c = canvas();
  const ctx = c.getContext('2d');
  ctx.clearRect(0, 0, c.width, c.height);
  for (const x of an.els) drawAny(ctx, x);
  const s = vs();
  // Selection chrome, in the Diagrams cyan.
  for (const id of an.sel) {
    const x = an.els.find((z) => z.id === id);
    const b = bounds(x);
    if (!b) continue;
    ctx.strokeStyle = CYAN;
    ctx.lineWidth = 2 * s;
    ctx.setLineDash([8 * s, 6 * s]);
    ctx.strokeRect(b.x, b.y, b.w, b.h);
    ctx.setLineDash([]);
  }
  // Handles appear only on a single selection: on two objects they would be
  // a field of dots with no clear owner.
  if (an.sel.size === 1) {
    const x = an.els.find((z) => z.id === [...an.sel][0]);
    for (const h of handlesOf(x)) {
      ctx.beginPath();
      ctx.arc(h.x, h.y, 7 * s, 0, Math.PI * 2);
      ctx.fillStyle = '#fff';
      ctx.fill();
      ctx.lineWidth = 2.5 * s;
      ctx.strokeStyle = CYAN;
      ctx.stroke();
    }
  }
  if (an.band) {
    ctx.strokeStyle = CYAN;
    ctx.fillStyle = 'rgba(117, 216, 255, 0.16)';
    ctx.lineWidth = 1.5 * s;
    const b = an.band;
    const r = { x: Math.min(b.x0, b.x1), y: Math.min(b.y0, b.y1), w: Math.abs(b.x1 - b.x0), h: Math.abs(b.y1 - b.y0) };
    ctx.fillRect(r.x, r.y, r.w, r.h);
    ctx.strokeRect(r.x, r.y, r.w, r.h);
  }
}

// A handle is { x, y, k } where k names what dragging it changes.
function handlesOf(x) {
  if (!x) return [];
  if (x.type === 'box' || x.type === 'circle') {
    return [
      { x: x.x, y: x.y, k: 'nw' },
      { x: x.x + x.w, y: x.y, k: 'ne' },
      { x: x.x, y: x.y + x.h, k: 'sw' },
      { x: x.x + x.w, y: x.y + x.h, k: 'se' },
    ];
  }
  if (x.type === 'arrow') {
    return [
      { x: x.x1, y: x.y1, k: 'p1' },
      { x: x.mx, y: x.my, k: 'curve' },
      { x: x.x2, y: x.y2, k: 'p2' },
    ];
  }
  if (x.type === 'angle') {
    return [
      { x: x.ax, y: x.ay, k: 'a' },
      { x: x.vx, y: x.vy, k: 'v' },
      { x: x.bx, y: x.by, k: 'b' },
    ];
  }
  return [];
}

function bounds(x) {
  if (!x) return null;
  if (x.type === 'box' || x.type === 'circle') return { x: x.x, y: x.y, w: x.w, h: x.h };
  if (x.type === 'arrow') {
    const xs = [x.x1, x.x2, x.mx]; const ys = [x.y1, x.y2, x.my];
    const pad = (x.width || 8) * 2.5;
    return { x: Math.min(...xs) - pad, y: Math.min(...ys) - pad, w: Math.max(...xs) - Math.min(...xs) + pad * 2, h: Math.max(...ys) - Math.min(...ys) + pad * 2 };
  }
  if (x.type === 'angle') {
    const xs = [x.ax, x.vx, x.bx]; const ys = [x.ay, x.vy, x.by];
    const pad = (x.width || 8) * 3;
    return { x: Math.min(...xs) - pad, y: Math.min(...ys) - pad, w: Math.max(...xs) - Math.min(...xs) + pad * 2, h: Math.max(...ys) - Math.min(...ys) + pad * 2 };
  }
  if (x.type === 'pen' || x.type === 'freearrow') {
    const xs = x.pts.map((p) => p[0]); const ys = x.pts.map((p) => p[1]);
    // A freehand arrow's head sticks out past the last point, so its box has
    // to allow for it or the head sits outside its own selection.
    const pad = x.type === 'freearrow' ? (x.width || 8) * 6.45 : 0;
    return { x: Math.min(...xs) - pad, y: Math.min(...ys) - pad, w: Math.max(...xs) - Math.min(...xs) + pad * 2, h: Math.max(...ys) - Math.min(...ys) + pad * 2 };
  }
  // A ring's box is its own square, so dragging a corner grows the radius.
  if (x.type === 'spotlight') {
    const r = Math.max(2, x.r || 0) + (x.width || 6) * 1.5;
    return { x: x.x - r, y: x.y - r, w: r * 2, h: r * 2 };
  }
  if (x.type === 'player') {
    const r = (x.r || 26) + 2;
    return { x: x.x - r, y: x.y - r, w: r * 2, h: r * 2 };
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

function handleAt(p) {
  if (an.sel.size !== 1) return null;
  const x = an.els.find((z) => z.id === [...an.sel][0]);
  const r = 12 * vs();
  for (const h of handlesOf(x)) {
    if (Math.hypot(p.x - h.x, p.y - h.y) <= r) return { el: x, h };
  }
  return null;
}

// WHERE THE PICTURE ACTUALLY IS. `object-fit: contain` letterboxes the
// bitmap inside the element box, so getBoundingClientRect() returns the BOX
// and not the picture. Mapping a pointer against the box puts every click
// off by the letterbox offset the moment the stage stops matching the
// video's aspect - which is most of the time, since the stage is whatever
// the window leaves over. Found 2026-08-27: a click on a corner handle was
// landing 18 video pixels above it.
function viewBox() {
  const r = canvas().getBoundingClientRect();
  const scale = Math.min(r.width / an.vw, r.height / an.vh);
  const w = an.vw * scale;
  const h = an.vh * scale;
  return { scale, left: r.left + (r.width - w) / 2, top: r.top + (r.height - h) / 2, w, h };
}

function pt(e) {
  const v = viewBox();
  return { x: (e.clientX - v.left) / v.scale, y: (e.clientY - v.top) / v.scale };
}

// ------------------------------------------------------------- pointer

function onDown(e) {
  if (!an) return;
  e.preventDefault();
  const p = pt(e);
  const s = vs();

  if (an.tool === 'select') {
    const grab = handleAt(p);
    if (grab) {
      an.drag = { kind: 'handle', id: grab.el.id, h: grab.h.k, orig: structuredClone(grab.el) };
      return;
    }
    const x = hitAt(p);
    if (!x) {
      // Rubber band: drag on empty frame to gather several objects.
      an.sel.clear();
      an.band = { x0: p.x, y0: p.y, x1: p.x, y1: p.y };
      an.drag = { kind: 'band' };
      redraw();
      return;
    }
    if (e.shiftKey) an.sel.has(x.id) ? an.sel.delete(x.id) : an.sel.add(x.id);
    else if (!an.sel.has(x.id)) { an.sel.clear(); an.sel.add(x.id); }
    an.drag = {
      kind: 'move',
      start: p,
      origs: [...an.sel].map((id) => structuredClone(an.els.find((z) => z.id === id))),
    };
    redraw();
    return;
  }

  // A position chip is placed, not dragged: one click drops D1 or C where
  // the player is. It is a `player` element, the type Diagrams already draws
  // as a labelled disc, so it needs no new renderer and it lands in a saved
  // freeze looking exactly like a rink diagram's player.
  if (an.tool === 'pos') {
    const st = styleFor('pos');
    const x = {
      id: uid(), type: 'player', x: p.x, y: p.y,
      r: 26 * s, color: st.color, label: an.posLabel || 'D1',
    };
    an.els.push(x);
    an.sel = new Set([x.id]);
    markDirty(); redraw();
    return;
  }
  if (an.tool === 'pen' || an.tool === 'freearrow') {
    const st = styleFor(an.tool);
    const x = {
      id: uid(), type: an.tool === 'pen' ? 'pen' : 'freearrow',
      pts: [[p.x, p.y]], color: st.color, width: st.width, ...(st.dash ? { dash: true } : {}),
    };
    an.els.push(x);
    an.drag = { id: x.id, kind: 'pen' };
    return;
  }
  // Line is an arrow with no head. Same record, same curve, same drag, same
  // hit test - only the head style differs, and both renderers already treat
  // an unknown head as "draw nothing", so this needed no drawing code.
  if (an.tool === 'arrow' || an.tool === 'line') {
    const st = styleFor(an.tool);
    const x = {
      id: uid(), type: 'arrow', x1: p.x, y1: p.y, x2: p.x, y2: p.y, mx: p.x, my: p.y,
      color: st.color, width: st.width, head: an.tool === 'line' ? 'none' : 'triangle',
      ...(st.dash ? { dash: true } : {}),
    };
    an.els.push(x);
    an.drag = { id: x.id, kind: 'arrow' };
    return;
  }
  if (an.tool === 'spotlight') {
    const st = styleFor('spotlight');
    const x = { id: uid(), type: 'spotlight', x: p.x, y: p.y, r: 0, color: st.color, width: st.width, ...(st.dash ? { dash: true } : {}) };
    an.els.push(x);
    an.drag = { id: x.id, kind: 'spot', start: p };
    return;
  }
  if (an.tool === 'box' || an.tool === 'circle') {
    // Fill or outline, whichever the bar is set to. A wash reads well over
    // plain ice and hides the play over a busy frame; an outline is the
    // opposite, so both have to be one click away (2026-08-27, Tony).
    const solid = an.shapeStyle === 'outline';
    const st = styleFor(an.tool);
    const x = {
      id: uid(), type: an.tool, x: p.x, y: p.y, w: 0, h: 0, color: st.color,
      alpha: solid ? 1 : 0.3, ...(solid ? { outline: true, width: st.width } : {}),
      ...(st.dash ? { dash: true } : {}),
    };
    an.els.push(x);
    an.drag = { id: x.id, kind: 'shape', start: p };
    return;
  }
  if (an.tool === 'angle') {
    // Drawn in one gesture: press at the first limb, drag to the vertex.
    // The second limb lands opposite and is then dragged into place.
    const x = { id: uid(), type: 'angle', ax: p.x, ay: p.y, vx: p.x, vy: p.y, bx: p.x, by: p.y, color: an.color, width: 8 * s };
    an.els.push(x);
    an.drag = { id: x.id, kind: 'angle', start: p };
    return;
  }
  if (an.tool === 'text') openTextInput(p);
}

function onMove(e) {
  if (!an?.drag) return;
  const p = pt(e);
  const d = an.drag;

  if (d.kind === 'band') {
    an.band.x1 = p.x;
    an.band.y1 = p.y;
    const r = {
      x: Math.min(an.band.x0, p.x), y: Math.min(an.band.y0, p.y),
      w: Math.abs(p.x - an.band.x0), h: Math.abs(p.y - an.band.y0),
    };
    an.sel.clear();
    for (const z of an.els) {
      const b = bounds(z);
      if (b && b.x < r.x + r.w && b.x + b.w > r.x && b.y < r.y + r.h && b.y + b.h > r.y) an.sel.add(z.id);
    }
    redraw();
    return;
  }

  if (d.kind === 'move') {
    const dx = p.x - d.start.x;
    const dy = p.y - d.start.y;
    for (const o of d.origs) {
      const x = an.els.find((z) => z.id === o.id);
      if (!x) continue;
      if (x.type === 'pen' || x.type === 'freearrow') x.pts = o.pts.map(([px, py]) => [px + dx, py + dy]);
      else if (x.type === 'arrow') { x.x1 = o.x1 + dx; x.y1 = o.y1 + dy; x.x2 = o.x2 + dx; x.y2 = o.y2 + dy; x.mx = o.mx + dx; x.my = o.my + dy; }
      else if (x.type === 'angle') { x.ax = o.ax + dx; x.ay = o.ay + dy; x.vx = o.vx + dx; x.vy = o.vy + dy; x.bx = o.bx + dx; x.by = o.by + dy; }
      else { x.x = o.x + dx; x.y = o.y + dy; }
    }
    redraw();
    return;
  }

  const x = an.els.find((z) => z.id === d.id);
  if (!x) return;

  if (d.kind === 'handle') {
    const o = d.orig;
    if (d.h === 'p1') { x.x1 = p.x; x.y1 = p.y; }
    else if (d.h === 'p2') { x.x2 = p.x; x.y2 = p.y; }
    else if (d.h === 'curve') { x.mx = p.x; x.my = p.y; }
    else if (d.h === 'a') { x.ax = p.x; x.ay = p.y; }
    else if (d.h === 'v') { x.vx = p.x; x.vy = p.y; }
    else if (d.h === 'b') { x.bx = p.x; x.by = p.y; }
    else {
      // A corner drags against the OPPOSITE corner, which is what keeps a
      // box anchored while it is resized.
      const right = d.h === 'ne' || d.h === 'se';
      const bottom = d.h === 'sw' || d.h === 'se';
      const fx = right ? o.x : o.x + o.w;
      const fy = bottom ? o.y : o.y + o.h;
      let w = Math.abs(p.x - fx);
      let h = Math.abs(p.y - fy);
      // A circle is always a circle (Tony's call): the larger side wins, so
      // a drag never quietly makes an ellipse.
      if (x.type === 'circle') { const m = Math.max(w, h); w = m; h = m; }
      x.x = right ? fx : fx - w;
      x.y = bottom ? fy : fy - h;
      x.w = w;
      x.h = h;
    }
    redraw();
    return;
  }

  if (d.kind === 'pen') {
    const last = x.pts[x.pts.length - 1];
    if (Math.hypot(p.x - last[0], p.y - last[1]) > 3) x.pts.push([p.x, p.y]);
  } else if (d.kind === 'arrow') {
    x.x2 = p.x; x.y2 = p.y; x.mx = (x.x1 + x.x2) / 2; x.my = (x.y1 + x.y2) / 2;
  } else if (d.kind === 'shape') {
    let w = Math.abs(p.x - d.start.x);
    let h = Math.abs(p.y - d.start.y);
    if (an.tool === 'circle') { const m = Math.max(w, h); w = m; h = m; }
    x.x = p.x < d.start.x ? d.start.x - w : d.start.x;
    x.y = p.y < d.start.y ? d.start.y - h : d.start.y;
    x.w = w; x.h = h;
  } else if (d.kind === 'spot') {
    // Press on the player, drag out to the ring you want.
    x.r = Math.hypot(p.x - d.start.x, p.y - d.start.y);
  } else if (d.kind === 'angle') {
    // The drag sets the vertex; the far limb mirrors it until it is moved.
    x.vx = p.x; x.vy = p.y;
    x.bx = p.x + (p.x - x.ax) * 0.85;
    x.by = p.y - Math.abs(p.y - x.ay) * 0.85;
  }
  redraw();
}

function onUp() {
  if (!an?.drag) return;
  const d = an.drag;
  an.drag = null;
  an.band = null;
  const x = an.els.find((z) => z.id === d.id);
  if (x && d.kind === 'shape' && (x.w < 12 || x.h < 12)) an.els = an.els.filter((z) => z.id !== d.id);
  if (x && d.kind === 'angle' && Math.hypot(x.vx - x.ax, x.vy - x.ay) < 20) an.els = an.els.filter((z) => z.id !== d.id);
  // A ring too small to see is a stray click, not a spotlight. A bare click
  // still gets one, at a sensible default size, so tapping a player works.
  if (x && d.kind === 'spot' && x.r < 10) x.r = 44 * vs();
  if (d.kind !== 'band') markDirty();
  // THE TOOL STAYS ARMED (2026-08-27, Tony's call). Every draw used to snap
  // back to Select, so three arrows on one play meant re-arming twice.
  // Escape disarms; another tool replaces it; nothing else does.
  if (['pen', 'arrow', 'shape', 'angle', 'spot'].includes(d.kind) && an.els.some((z) => z.id === d.id)) {
    an.sel.clear();
    an.sel.add(d.id);
  }
  redraw();
}

// ------------------------------------------------------------- text

// The field and the committed chip share ONE drawing, so committing looks
// like nothing happened except the loss of selection (Tony's call). The
// numbers below are the same ones flat.js uses to render the chip.
const TEXT_SIZE = 42; // was 56 - 25% smaller, per spec

function openTextInput(p, existing = null) {
  const root = el('anRoot');
  const v = viewBox();
  const rootR = root.getBoundingClientRect();
  const scale = v.scale;
  const size = existing ? existing.size : TEXT_SIZE * vs();
  const T = TEXT_CHIP;
  const input = document.createElement('input');
  input.className = 'an-textinput';
  input.value = existing ? existing.text : '';
  const fpx = Math.max(11, size * scale);
  input.style.left = `${v.left - rootR.left + p.x * scale}px`;
  input.style.top = `${v.top - rootR.top + p.y * scale}px`;
  input.style.fontSize = `${fpx}px`;
  input.style.padding = `${size * T.padY * scale}px ${size * T.padX * scale}px`;
  input.style.borderRadius = `${size * 0.22 * scale}px`;
  input.style.color = existing ? existing.color : an.color;
  root.appendChild(input);
  if (existing) an.els = an.els.filter((z) => z.id !== existing.id);
  redraw();

  const finish = (keep) => {
    const v = input.value.trim();
    input.remove();
    if (keep && v) {
      const x = { id: existing?.id || uid(), type: 'text', x: p.x, y: p.y, text: v, size, color: existing ? existing.color : an.color };
      an.els.push(x);
      an.sel.clear();
      an.sel.add(x.id);
      markDirty();
    } else if (existing) {
      an.els.push(existing);
    }
    redraw();
  };
  input.onkeydown = (e) => {
    e.stopPropagation();
    if (e.key === 'Enter') { e.preventDefault(); finish(true); }
    if (e.key === 'Escape') { e.preventDefault(); finish(false); }
  };
  input.onblur = () => finish(true);
  setTimeout(() => input.focus(), 0);
}

// ------------------------------------------------------------- keys

function onKey(e) {
  if (!an) return;
  const t = e.target;
  if (t && (t.tagName === 'INPUT' || t.tagName === 'TEXTAREA')) return;
  if (e.metaKey || e.ctrlKey || e.altKey) return;
  const k = e.key.toLowerCase();

  if ((e.key === 'Backspace' || e.key === 'Delete') && an.sel.size) {
    e.preventDefault();
    an.els = an.els.filter((z) => !an.sel.has(z.id));
    an.sel.clear();
    markDirty();
    redraw();
    return;
  }
  // Escape disarms a tool first, and only closes once nothing is armed -
  // otherwise a stray Escape mid-drawing throws away the whole session.
  if (e.key === 'Escape') {
    e.preventDefault();
    if (an.tool !== 'select') { an.tool = 'select'; an.sel.clear(); paintBar(); redraw(); return; }
    if (an.sel.size) { an.sel.clear(); redraw(); return; }
    done();
    return;
  }
  if (e.key === 'Enter') { e.preventDefault(); done(); return; }

  for (const [tool] of TOOLS) {
    if (k && k === keyFor(tool)) { e.preventDefault(); setTool(tool); return; }
  }
  if (k === (an.actKeys.clear || ACT_KEYS.clear)) { e.preventDefault(); clearAll(); return; }
  if (k === (an.actKeys.export || ACT_KEYS.export)) { e.preventDefault(); an.onExport?.(composite(), an.freeze); }
}

let dirty = false;
const markDirty = () => { dirty = true; };

function setTool(t) {
  closePop();
  an.tool = t;
  // Switching tools drops the swatch override and shows the new tool's own
  // colour, so the bar always tells the truth about what will be drawn.
  an.colorSet = false;
  const st = { ...DEFAULT_STYLE[t], ...((an.style || {})[t] || {}) };
  if (st.color) an.color = st.color;
  if (t !== 'select') an.sel.clear();
  paintBar();
  redraw();
  canvas().style.cursor = t === 'select' ? 'default' : 'crosshair';
}

function clearAll() {
  an.els = [];
  an.sel.clear();
  markDirty();
  redraw();
}

// ------------------------------------------------------------- toolbar

// ONE ROW, ALWAYS (2026-08-29, Tony's call). The bar carried ten tools, five
// swatches, a Fill/Outline pair, eight position chips, a Hold field and three
// actions - twenty-seven controls, which wrapped onto two rows and pushed the
// video up. Two groups moved into POPOVERS, which is the rule the Diagrams
// toolbar already follows: the toolbar's width is fixed by design, and a
// contextual control belongs in a popup rather than in the row.
//
//   colour   one swatch showing the current colour, opening the five presets
//            AND the Fill/Outline pair - both are "how the next mark looks"
//   position one tool button opening D1..F3, which also ARMS the tool, so
//            dropping a marker is still a single decision
//
// The idle bar draws the SAME row so the toolbar never changes shape; the
// actions are simply disabled until there is a frozen frame to act on.
function toolbarHtml({ live }) {
  const key = (k) => (k ? `<span class="tb-key">${k.toUpperCase()}</span>` : '');
  const tool = (t, label, icon) => {
    const on = live && an.tool === t;
    const k = live ? keyFor(t) : '';
    return `<button class="tb-btn${on ? ' on' : ''}" data-${live ? 'tool' : 'idle'}="${t}" title="${label}${k ? ` (${k.toUpperCase()})` : ''}${live ? ' - Right-Click To Change The Key' : ' - Freezes This Frame'}" aria-label="${label}">${icon}${key(k)}</button>`;
  };
  const colour = live ? an.color : '#ff3b30';
  const posOn = live && an.tool === 'pos';
  const acts = live
    ? `<button class="tb-btn tb-word" data-act="clear" title="Remove Every Drawing (${(an.actKeys.clear || ACT_KEYS.clear).toUpperCase()})">Clear${key(an.actKeys.clear || ACT_KEYS.clear)}</button>
       <button class="tb-btn tb-word" data-act="export" title="Save The Annotated Frame As A PNG (${(an.actKeys.export || ACT_KEYS.export).toUpperCase()})">Export${key(an.actKeys.export || ACT_KEYS.export)}</button>
       <button class="tb-btn tb-word on" data-act="done" title="Finish (Return)">Done<span class="tb-key">&crarr;</span></button>`
    : `<button class="tb-btn tb-word" disabled title="Pick A Tool First">Clear</button>
       <button class="tb-btn tb-word" disabled title="Pick A Tool First">Export</button>
       <button class="tb-btn tb-word" disabled title="Pick A Tool First">Done</button>`;
  return `
    ${TOOLS.map(([t, label, icon]) => tool(t, label, icon)).join('')}
    <button class="tb-btn${posOn ? ' on' : ''}" data-pop="pos" title="Position Markers - D1, C, W2 And The Rest" aria-label="Position Markers">${POS_ICON}<span class="tb-caret"></span></button>
    <span class="tb-sep"></span>
    <button class="tb-btn tb-colour" data-pop="colour" title="Colour And Shape Style" aria-label="Colour And Shape Style"><span class="tb-swatchdot" style="--c:${colour}"></span><span class="tb-caret"></span></button>
    <span class="tb-sep"></span>
    <label class="an-hold" title="How Long The Exported Clip Holds On This Frame">Hold <input id="anHold" type="number" min="0" max="30" value="${live ? (an.freeze.hold ?? 3) : 3}"${live ? '' : ' disabled'}>s</label>
    <span class="tb-sep"></span>
    ${acts}`;
}

// Picking a colour is a live override for the ACTIVE tool only, so choosing
// red for an arrow does not silently repaint the box tool too; it also
// recolours the current selection, so a colour can be changed after the fact.
function pickColour(hex) {
  an.color = hex;
  an.colorSet = true;
  for (const id of an.sel) {
    const x = an.els.find((z) => z.id === id);
    if (x) { x.color = hex; markDirty(); }
  }
  redraw();
}

// Fill or outline, applied to the selection as well as to the next shape.
function restyleSelection() {
  const solid = an.shapeStyle === 'outline';
  for (const id of an.sel) {
    const x = an.els.find((z) => z.id === id);
    if (!x || (x.type !== 'box' && x.type !== 'circle')) continue;
    if (solid) { x.outline = true; x.alpha = 1; x.width = x.width || 9 * vs(); }
    else { delete x.outline; x.alpha = 0.3; }
    markDirty();
  }
  redraw();
}

// The two popovers. Built on demand and dismissed on Escape, an outside
// press, or a scroll - the same shape the Diagrams line menu uses.
function closePop() { el('anBar')?.querySelector('.tb-pop')?.remove(); }

function openPop(kind, anchor) {
  const bar = el('anBar');
  const existing = bar.querySelector('.tb-pop');
  const same = existing?.dataset.kind === kind;
  closePop();
  if (same) return;
  const pop = document.createElement('div');
  pop.className = 'tb-pop';
  pop.dataset.kind = kind;
  if (kind === 'colour') {
    pop.innerHTML = `
      <div class="tb-poprow">
        ${COLORS.map(([name, hex]) => `<button class="tb-swatch${an.color === hex ? ' on' : ''}" data-color="${hex}" style="--c:${hex}" title="${name}" aria-label="${name}"></button>`).join('')}
      </div>
      <div class="tb-poplabel">Boxes And Circles</div>
      <span class="an-seg" role="group" aria-label="Shape Style">
        <button class="an-segbtn${an.shapeStyle !== 'outline' ? ' on' : ''}" data-shape="fill">Fill</button>
        <button class="an-segbtn${an.shapeStyle === 'outline' ? ' on' : ''}" data-shape="outline">Outline</button>
      </span>`;
  } else {
    pop.innerHTML = `
      <div class="tb-poplabel">Drop A Marker</div>
      <div class="tb-posgrid">
        ${(an.positions || []).map((lab) => `<button class="tb-posbtn${an.tool === 'pos' && an.posLabel === lab ? ' on' : ''}" data-pos="${esc(lab)}">${esc(lab)}</button>`).join('')}
      </div>`;
  }
  bar.appendChild(pop);
  // Anchored to its own button, and nudged back inside the bar when the
  // button sits near an edge.
  const b = anchor.getBoundingClientRect();
  const r = bar.getBoundingClientRect();
  pop.style.left = `${Math.max(4, Math.min(b.left - r.left + b.width / 2 - pop.offsetWidth / 2, r.width - pop.offsetWidth - 4))}px`;
  wirePop(pop);
}

function wirePop(pop) {
  for (const b of pop.querySelectorAll('[data-color]')) {
    b.onclick = () => { pickColour(b.dataset.color); closePop(); paintBar(); };
  }
  for (const b of pop.querySelectorAll('[data-shape]')) {
    b.onclick = () => { an.shapeStyle = b.dataset.shape; restyleSelection(); closePop(); paintBar(); };
  }
  for (const b of pop.querySelectorAll('[data-pos]')) {
    b.onclick = () => { an.posLabel = b.dataset.pos; setTool('pos'); closePop(); };
  }
}

function paintBar() {
  const bar = el('anBar');
  bar.innerHTML = toolbarHtml({ live: true });
  bar.querySelectorAll('[data-tool]').forEach((b) => {
    b.onclick = () => setTool(b.dataset.tool);
    // Right-click a tool to rebind its key - the same idea the Diagrams
    // toolbar uses for its colour presets.
    b.oncontextmenu = (ev) => {
      ev.preventDefault();
      const cur = keyFor(b.dataset.tool);
      const next = prompt(`One key for ${b.dataset.tool}`, cur);
      if (next == null) return;
      const k = next.trim().toLowerCase().slice(0, 1);
      an.keys[b.dataset.tool] = k;
      an.onKeys?.({ ...an.keys });
      paintBar();
    };
  });
  bar.querySelectorAll('[data-pop]').forEach((b) => {
    b.onclick = (ev) => { ev.stopPropagation(); openPop(b.dataset.pop, b); };
  });
  el('anHold').onchange = (e) => { an.freeze.hold = Math.max(0, Number(e.target.value) || 0); markDirty(); };
  el('anHold').onkeydown = (e) => e.stopPropagation();
  const act = (n, f) => { const b = bar.querySelector(`[data-act="${n}"]`); if (b) b.onclick = f; };
  act('clear', clearAll);
  act('export', () => an.onExport?.(composite(), an.freeze));
  act('done', done);
}

// The frame with the drawing burned in - for exports and the Diagrams handoff.
export function composite() {
  const c = document.createElement('canvas');
  c.width = an.vw; c.height = an.vh;
  const ctx = c.getContext('2d');
  ctx.drawImage(an.frame, 0, 0);
  for (const x of an.els) drawAny(ctx, x);
  return c;
}

// Everything drawn, for a recording that has to composite it live.
export function annotationElements() { return an ? an.els : []; }
export function annotationSize() { return an ? { w: an.vw, h: an.vh } : null; }
export function paintAnnotations(ctx) { if (an) for (const x of an.els) drawAny(ctx, x); }

function done() {
  an.freeze.elements = an.els;
  const cb = an.onDone;
  const f = an.freeze;
  const wasDirty = dirty;
  teardown();
  if (cb) cb(f, wasDirty);
}

function teardown() {
  closePop();
  el('anRoot').hidden = true;
  an = null;
  dirty = false;
  // The bar is always on screen, so closing a freeze hands it back to the
  // idle row rather than leaving the last session's controls sitting there
  // with nothing behind them.
  idleHook?.();
}

// Set once by the app so teardown can restore the idle bar without annotate
// needing to know how a freeze is started.
let idleHook = null;
export function onAnnotateIdle(fn) { idleHook = fn; }

// Saving Settings while a freeze is open pushes the new styles straight into
// it. Without this a colour change would look ignored until the next freeze,
// which reads as a bug rather than as a scoping rule.
export function applyToolStyle(style, positions) {
  if (!an) return;
  if (style) an.style = { ...DEFAULT_STYLE, ...style };
  if (positions) an.positions = positions;
  an.colorSet = false;
  const st = { ...DEFAULT_STYLE[an.tool], ...((an.style || {})[an.tool] || {}) };
  if (st.color) an.color = st.color;
  paintBar();
}

// ------------------------------------------------------------- open

let wired = false;
export function openAnnotate(freeze, frameCanvas, { onDone, onExport, keys, actKeys, onKeys, style, positions, armTool } = {}) {
  const root = el('anRoot');
  root.hidden = false;
  an = {
    freeze,
    els: structuredClone(freeze.elements || []),
    tool: freeze.elements?.length ? 'select' : 'pen',
    color: COLORS[0][1],
    sel: new Set(),
    drag: null,
    band: null,
    shapeStyle: 'fill',
    style: { ...DEFAULT_STYLE, ...(style || {}) },
    positions: positions || ['D1', 'D2', 'C', 'W1', 'W2', 'F1', 'F2', 'F3'],
    posLabel: 'D1',
    colorSet: false,
    keys: { ...DEFAULT_KEYS, ...(keys || {}) },
    actKeys: { ...ACT_KEYS, ...(actKeys || {}) },
    onKeys,
    vw: frameCanvas.width,
    vh: frameCanvas.height,
    frame: frameCanvas,
    onDone,
    onExport,
  };
  const c = canvas();
  c.width = an.vw; c.height = an.vh;
  const f = el('anFrame');
  f.width = an.vw;
  f.height = an.vh;
  f.getContext('2d').drawImage(frameCanvas, 0, 0);
  if (!wired) {
    wired = true;
    c.addEventListener('pointerdown', onDown);
    c.addEventListener('dblclick', (e) => {
      if (!an) return;
      const x = hitAt(pt(e));
      if (x?.type === 'text') openTextInput({ x: x.x, y: x.y }, x);
    });
    window.addEventListener('pointermove', onMove);
    window.addEventListener('pointerup', onUp);
    window.addEventListener('keydown', onKey, true);
    // An outside press closes a popover; the bar's own clicks stop
    // propagation, so this only ever fires for a genuine outside press.
    window.addEventListener('pointerdown', () => closePop(), true);
  }
  setTool(armTool || an.tool);
  redraw();
  void toast;
}
