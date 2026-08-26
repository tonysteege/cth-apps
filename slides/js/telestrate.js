// The presenting pen: a drawing layer over every slide, using the same
// element model and renderer as Diagrams and Clips (/diagrams/js/flat.js).
// Drawings are session scratch, kept PER SLIDE while the deck is open, so
// flipping back to a slide brings its telestration back. Cmd+Z undoes.
//
// Coordinates live in a fixed 1600x900 slide space; the stage letterboxes
// slides to 16:9, so drawings survive every resize.

import { drawEl } from '/diagrams/js/flat.js';

export const SLIDE_W = 1600;
export const SLIDE_H = 900;

const COLORS = [['#dc2626', 'Red'], ['#1e1e1e', 'Ink'], ['#75d8ff', 'Blue'], ['#16a34a', 'Green']];
const TOOLS = [
  ['pen', 'Pen (1)', '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-linejoin="round"><path d="M21.17 6.81a2.82 2.82 0 0 0-3.98-3.99L3.84 16.17a2 2 0 0 0-.5.83l-1.32 4.35a.5.5 0 0 0 .62.63l4.36-1.32a2 2 0 0 0 .83-.5z"/><path d="m14.5 5.5 4 4"/></svg>'],
  ['arrow', 'Arrow (2)', '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor"><path d="M4 19.5C6.5 12 10.5 8.2 16.5 6.4"/><path d="M13.6 4.1 19.5 5.5 17 11" stroke-linejoin="round"/></svg>'],
  ['box', 'Box (3)', '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor"><rect x="4.25" y="5.25" width="15.5" height="13.5" rx="2.75"/></svg>'],
  ['circle', 'Circle (4)', '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor"><circle cx="12" cy="12" r="7.75"/></svg>'],
];

let T = null; // { canvas, rail, perSlide: Map, slide, tool, color, armed, drag }
const uid = () => Date.now().toString(36) + Math.random().toString(36).slice(2, 5);

function els() { return T.perSlide.get(T.slide) || []; }
function setEls(list) { T.perSlide.set(T.slide, list); }

function redraw() {
  const c = T.canvas;
  const ctx = c.getContext('2d');
  ctx.setTransform(1, 0, 0, 1, 0, 0);
  ctx.clearRect(0, 0, c.width, c.height);
  ctx.scale(c.width / SLIDE_W, c.height / SLIDE_H);
  for (const x of els()) drawEl(ctx, x);
}

function sizeCanvas() {
  const r = T.canvas.parentElement.getBoundingClientRect();
  const dpr = window.devicePixelRatio || 1;
  T.canvas.width = Math.round(r.width * dpr);
  T.canvas.height = Math.round(r.height * dpr);
  redraw();
}

function pt(e) {
  const r = T.canvas.getBoundingClientRect();
  return { x: ((e.clientX - r.left) / r.width) * SLIDE_W, y: ((e.clientY - r.top) / r.height) * SLIDE_H };
}

function onDown(e) {
  if (!T?.armed) return;
  e.preventDefault();
  e.stopPropagation();
  const p = pt(e);
  const list = els();
  let x;
  if (T.tool === 'pen') x = { id: uid(), type: 'pen', pts: [[p.x, p.y]], color: T.color, width: 7 };
  else if (T.tool === 'arrow') x = { id: uid(), type: 'arrow', x1: p.x, y1: p.y, x2: p.x, y2: p.y, mx: p.x, my: p.y, color: T.color, width: 7, head: 'triangle' };
  else x = { id: uid(), type: T.tool, x: p.x, y: p.y, w: 0, h: 0, color: T.color, alpha: 0.3 };
  list.push(x);
  setEls(list);
  T.drag = { x, start: p };
}

function onMove(e) {
  if (!T?.drag) return;
  const p = pt(e);
  const { x, start } = T.drag;
  if (x.type === 'pen') {
    const last = x.pts[x.pts.length - 1];
    if (Math.hypot(p.x - last[0], p.y - last[1]) > 2) x.pts.push([p.x, p.y]);
  } else if (x.type === 'arrow') {
    x.x2 = p.x; x.y2 = p.y; x.mx = (x.x1 + x.x2) / 2; x.my = (x.y1 + x.y2) / 2;
  } else {
    x.x = Math.min(start.x, p.x); x.y = Math.min(start.y, p.y);
    x.w = Math.abs(p.x - start.x); x.h = Math.abs(p.y - start.y);
  }
  redraw();
}

function onUp() {
  if (!T?.drag) return;
  const { x } = T.drag;
  T.drag = null;
  if ((x.type === 'box' || x.type === 'circle') && (x.w < 8 || x.h < 8)) setEls(els().filter((z) => z.id !== x.id));
  redraw();
}

export function telestrateUndo() {
  if (!T) return;
  const list = els();
  list.pop();
  setEls(list);
  redraw();
}
export function telestrateClear() {
  if (!T) return;
  setEls([]);
  redraw();
}
export function telestrateArmed() { return !!T?.armed; }
export function telestrateTool(t) {
  if (!T) return;
  T.tool = t;
  T.armed = true;
  paintRail();
}

function setArmed(on) {
  T.armed = on;
  T.canvas.style.pointerEvents = on ? 'auto' : 'none';
  T.canvas.style.cursor = on ? 'crosshair' : 'default';
  paintRail();
}

function paintRail() {
  const r = T.rail;
  r.innerHTML = `
    <button class="tl-btn tl-master${T.armed ? ' on' : ''}" data-master title="Draw On The Slide (D Toggles)">
      <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-linejoin="round"><path d="M21.17 6.81a2.82 2.82 0 0 0-3.98-3.99L3.84 16.17a2 2 0 0 0-.5.83l-1.32 4.35a.5.5 0 0 0 .62.63l4.36-1.32a2 2 0 0 0 .83-.5z"/></svg>
    </button>
    <div class="tl-body"${T.armed ? '' : ' hidden'}>
      ${TOOLS.map(([t, label, ic]) => `<button class="tl-btn${T.tool === t && T.armed ? ' on' : ''}" data-tool="${t}" title="${label}">${ic}</button>`).join('')}
      <span class="tl-sep"></span>
      ${COLORS.map(([hex, name]) => `<button class="tl-swatch${T.color === hex ? ' on' : ''}" data-color="${hex}" style="--c:${hex}" title="${name}"></button>`).join('')}
      <span class="tl-sep"></span>
      <button class="tl-btn" data-act="undo" title="Undo Last Stroke (Cmd+Z)"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor"><path d="M9 14 4 9l5-5"/><path d="M4 9h10a6 6 0 0 1 0 12h-3"/></svg></button>
      <button class="tl-btn" data-act="clear" title="Clear This Slide's Drawing (X)"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor"><path d="M18 6 6 18M6 6l12 12"/></svg></button>
    </div>`;
  r.querySelector('[data-master]').onclick = () => setArmed(!T.armed);
  r.querySelectorAll('[data-tool]').forEach((b) => { b.onclick = () => { T.tool = b.dataset.tool; setArmed(true); }; });
  r.querySelectorAll('[data-color]').forEach((b) => { b.onclick = () => { T.color = b.dataset.color; paintRail(); }; });
  const act = (n, f) => { r.querySelector(`[data-act="${n}"]`).onclick = f; };
  act('undo', telestrateUndo);
  act('clear', telestrateClear);
}

export function telestrateSetSlide(i) {
  if (!T) return;
  T.slide = i;
  redraw();
}

export function initTelestrate(stageEl, railEl) {
  const canvas = document.createElement('canvas');
  canvas.className = 'tl-canvas';
  canvas.style.pointerEvents = 'none';
  stageEl.appendChild(canvas);
  T = { canvas, rail: railEl, perSlide: new Map(), slide: 0, tool: 'pen', color: '#dc2626', armed: false, drag: null };
  canvas.addEventListener('pointerdown', onDown);
  window.addEventListener('pointermove', onMove);
  window.addEventListener('pointerup', onUp);
  window.addEventListener('resize', sizeCanvas);
  // The stage can measure 0 during the first layout pass (hidden tabs,
  // orientation changes) - the observer re-sizes the canvas whenever the
  // stage gets its real box.
  T.ro = new ResizeObserver(sizeCanvas);
  T.ro.observe(stageEl);
  sizeCanvas();
  paintRail();
  return {
    toggle: () => setArmed(!T.armed),
    disarm: () => setArmed(false),
  };
}

export function disposeTelestrate() {
  if (!T) return;
  window.removeEventListener('resize', sizeCanvas);
  T.ro?.disconnect();
  T.canvas.remove();
  T = null;
}
