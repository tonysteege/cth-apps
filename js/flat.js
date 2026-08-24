// Pure canvas rendering of diagram elements - shared by the live editor
// (editor.js) and headless exports from the library. Keep drawEl() in step
// with editor.js svgEl() per element type.
//
// Colors: an element's `color` is either a slot NAME (black / blue / grey /
// red - the Film Room palette, stable for interchange) or a raw hex string
// from a customized preset. colorOf() resolves both.

import { composeRinkBg, loadImg, shapeImg, RINK_H, SEQ_GAP } from './rink.js';

export const INK = '#1e1e1e';
export const PALETTE = [
  ['black', INK],
  ['blue', '#75d8ff'],
  ['grey', '#d9d9d9'],
  ['red', '#dc2626'],
];
export const colorOf = (c) => {
  if (typeof c === 'string' && c.startsWith('#')) return c;
  return (PALETTE.find(([n]) => n === c) || PALETTE[0])[1];
};

function luminance(hex) {
  const m = /^#?([0-9a-f]{2})([0-9a-f]{2})([0-9a-f]{2})/i.exec(hex);
  if (!m) return 0;
  const [r, g, b] = [m[1], m[2], m[3]].map((h) => parseInt(h, 16) / 255);
  return 0.2126 * r + 0.7152 * g + 0.0722 * b;
}
export const labelInkOn = (c) => (luminance(colorOf(c)) > 0.55 ? INK : '#ffffff');

// Text chips are drawn like Figma's Title chip: white fill, ink border,
// extra-bold text. These ratios are shared by draw, SVG, and hit bounds.
// The border ratio lands the default chip border at the same drawn weight
// as the default player ring (Tony 2026-08-24).
export const TEXT_CHIP = { padX: 0.5, padY: 0.3, height: 1.3, radius: 0.32, border: 0.17 };

// Elements that can carry a `rot` (degrees, clockwise, about their centre).
export const ROTATABLE = new Set(['stamp', 'pucks', 'box', 'circle', 'text']);

// The centre a rotated element turns about - shared by canvas, SVG and hit
// testing so all three agree.
export function rotCenterOf(x) {
  if (x.type === 'text') {
    const T = TEXT_CHIP;
    const w = measureText(x);
    const padX = x.size * T.padX; const padY = x.size * T.padY;
    return { x: x.x - padX + (w + padX * 2) / 2, y: x.y - x.size - padY + (x.size * T.height + padY * 2) / 2 };
  }
  return { x: x.x + x.w / 2, y: x.y + x.h / 2 };
}

let measureCtx = null;
export function measureText(x) {
  if (!measureCtx) measureCtx = document.createElement('canvas').getContext('2d');
  measureCtx.font = `800 ${x.size}px Inter, 'Helvetica Neue', sans-serif`;
  return measureCtx.measureText(x.text || '').width;
}

export const arrowCtrl = (a) => ({
  cx: 2 * a.mx - (a.x1 + a.x2) / 2,
  cy: 2 * a.my - (a.y1 + a.y2) / 2,
});

export function arrowEndAngle(a) {
  const { cx, cy } = arrowCtrl(a);
  return Math.atan2(a.y2 - cy, a.x2 - cx);
}

export const shapeLabelSize = (x) => Math.max(18, Math.min(x.w, x.h) * 0.3);

function drawPucksInto(ctx, x) {
  const r = Math.min(x.w, x.h) * 0.22;
  const pts = [
    [x.x + x.w * 0.3, x.y + x.h * 0.72],
    [x.x + x.w * 0.7, x.y + x.h * 0.72],
    [x.x + x.w * 0.5, x.y + x.h * 0.3],
  ];
  ctx.fillStyle = INK;
  for (const [px, py] of pts) {
    ctx.beginPath();
    ctx.arc(px, py, r, 0, Math.PI * 2);
    ctx.fill();
  }
}

function drawShapeLabel(ctx, x) {
  if (!x.label) return;
  const fs = shapeLabelSize(x);
  ctx.fillStyle = labelInkOn(x.color);
  ctx.font = `800 ${Math.round(fs)}px Inter, 'Helvetica Neue', sans-serif`;
  ctx.textAlign = 'center';
  ctx.textBaseline = 'middle';
  ctx.fillText(x.label, x.x + x.w / 2, x.y + x.h / 2);
}

export function drawEl(ctx, x) {
  if (x.rot && ROTATABLE.has(x.type)) {
    const c = rotCenterOf(x);
    ctx.save();
    ctx.translate(c.x, c.y);
    ctx.rotate((x.rot * Math.PI) / 180);
    ctx.translate(-c.x, -c.y);
    drawElInner(ctx, x);
    ctx.restore();
    return;
  }
  drawElInner(ctx, x);
}

function drawElInner(ctx, x) {
  if (x.type === 'stamp') {
    const img = shapeImg(x.name);
    if (!img) return;
    if (x.flip) {
      ctx.save();
      ctx.translate(x.x + x.w, x.y);
      ctx.scale(-1, 1);
      ctx.drawImage(img, 0, 0, x.w, x.h);
      ctx.restore();
    } else {
      ctx.drawImage(img, x.x, x.y, x.w, x.h);
    }
    return;
  }
  if (x.type === 'pucks') { drawPucksInto(ctx, x); return; }
  if (x.type === 'box' || x.type === 'circle') {
    ctx.save();
    ctx.globalAlpha = x.alpha == null ? 0.3 : x.alpha;
    ctx.fillStyle = colorOf(x.color);
    ctx.beginPath();
    if (x.type === 'circle') ctx.ellipse(x.x + x.w / 2, x.y + x.h / 2, x.w / 2, x.h / 2, 0, 0, Math.PI * 2);
    else ctx.roundRect(x.x, x.y, x.w, x.h, Math.min(x.w, x.h) * 0.06);
    ctx.fill();
    ctx.restore();
    drawShapeLabel(ctx, x);
    return;
  }
  if (x.type === 'player') {
    ctx.beginPath();
    ctx.arc(x.x, x.y, x.r, 0, Math.PI * 2);
    ctx.fillStyle = colorOf(x.color);
    ctx.fill();
    ctx.lineWidth = Math.max(3, x.r * 0.18);
    ctx.strokeStyle = INK;
    ctx.stroke();
    if (x.label) {
      ctx.fillStyle = labelInkOn(x.color);
      ctx.font = `800 ${Math.round(x.r * (x.label.length > 1 ? 0.82 : 1.0))}px Inter, 'Helvetica Neue', sans-serif`;
      ctx.textAlign = 'center';
      ctx.textBaseline = 'middle';
      ctx.fillText(x.label, x.x, x.y + x.r * 0.05);
    }
    return;
  }
  if (x.type === 'arrow') {
    const { cx, cy } = arrowCtrl(x);
    const ang = arrowEndAngle(x);
    const w = x.width || 8;
    const head = w * 4.3;
    const style = x.head || 'triangle';
    const trim = style === 'triangle' ? head * 0.7 : 0;
    ctx.beginPath();
    ctx.moveTo(x.x1, x.y1);
    ctx.quadraticCurveTo(cx, cy, x.x2 - Math.cos(ang) * trim, x.y2 - Math.sin(ang) * trim);
    ctx.strokeStyle = colorOf(x.color);
    ctx.lineWidth = w;
    ctx.lineCap = 'round';
    if (x.dash) ctx.setLineDash([w * 2.4, w * 2]);
    ctx.stroke();
    ctx.setLineDash([]);
    if (style === 'triangle') {
      ctx.beginPath();
      ctx.moveTo(x.x2, x.y2);
      ctx.lineTo(x.x2 - Math.cos(ang - 0.44) * head, x.y2 - Math.sin(ang - 0.44) * head);
      ctx.lineTo(x.x2 - Math.cos(ang + 0.44) * head, x.y2 - Math.sin(ang + 0.44) * head);
      ctx.closePath();
      ctx.fillStyle = colorOf(x.color);
      ctx.fill();
      ctx.lineJoin = 'round';
      ctx.lineWidth = w * 0.9;
      ctx.strokeStyle = colorOf(x.color);
      ctx.stroke();
    } else if (style === 'v') {
      ctx.beginPath();
      ctx.moveTo(x.x2 - Math.cos(ang - 0.5) * head, x.y2 - Math.sin(ang - 0.5) * head);
      ctx.lineTo(x.x2, x.y2);
      ctx.lineTo(x.x2 - Math.cos(ang + 0.5) * head, x.y2 - Math.sin(ang + 0.5) * head);
      ctx.stroke();
    } else if (style === 'bar') {
      const bx = Math.cos(ang + Math.PI / 2) * head * 0.7;
      const by = Math.sin(ang + Math.PI / 2) * head * 0.7;
      ctx.beginPath();
      ctx.moveTo(x.x2 - bx, x.y2 - by);
      ctx.lineTo(x.x2 + bx, x.y2 + by);
      ctx.stroke();
    }
    return;
  }
  if (x.type === 'text') {
    const T = TEXT_CHIP;
    ctx.font = `800 ${x.size}px Inter, 'Helvetica Neue', sans-serif`;
    ctx.textAlign = 'left';
    ctx.textBaseline = 'alphabetic';
    const w = measureText(x);
    const padX = x.size * T.padX; const padY = x.size * T.padY;
    ctx.save();
    ctx.fillStyle = '#ffffff';
    ctx.beginPath();
    ctx.roundRect(x.x - padX, x.y - x.size - padY, w + padX * 2, x.size * T.height + padY * 2, x.size * T.radius);
    ctx.fill();
    ctx.strokeStyle = INK;
    ctx.lineWidth = Math.max(1.5, x.size * T.border);
    ctx.stroke();
    ctx.restore();
    ctx.fillStyle = colorOf(x.color);
    ctx.fillText(x.text || '', x.x, x.y);
    return;
  }
  if (x.type === 'pen') {
    if (x.pts.length < 2) return;
    ctx.beginPath();
    ctx.moveTo(x.pts[0][0], x.pts[0][1]);
    for (const [px, py] of x.pts.slice(1)) ctx.lineTo(px, py);
    ctx.strokeStyle = colorOf(x.color);
    ctx.lineWidth = x.width || 8;
    ctx.lineCap = 'round';
    ctx.lineJoin = 'round';
    ctx.stroke();
  }
}

// Render a stored cthDiagram state to a flat canvas, no live editor needed.
export async function renderStateFlat(state, scale = 1) {
  const bg = state.bg ? await loadImg(state.bg) : composeRinkBg(state.seq || 1);
  const w = state.w || bg.width || bg.naturalWidth;
  const h = state.h || bg.height || bg.naturalHeight;
  const c = document.createElement('canvas');
  c.width = Math.round(w * scale);
  c.height = Math.round(h * scale);
  const ctx = c.getContext('2d');
  ctx.scale(scale, scale);
  ctx.fillStyle = '#ffffff';
  ctx.fillRect(0, 0, w, h);
  ctx.drawImage(bg, 0, 0, w, h);
  for (const x of state.elements || []) drawEl(ctx, x);
  return c;
}

// Cut chosen frames (0-based) out of a full-height rink render and restack
// them with the standard white gap - the single-rink / multi-rink export.
export function sliceFrames(fullCanvas, frames) {
  const scale = fullCanvas.width / 3200;
  const H = Math.round(RINK_H * scale);
  const G = Math.round(SEQ_GAP * scale);
  const c = document.createElement('canvas');
  c.width = fullCanvas.width;
  c.height = frames.length * H + (frames.length - 1) * G;
  const ctx = c.getContext('2d');
  ctx.fillStyle = '#ffffff';
  ctx.fillRect(0, 0, c.width, c.height);
  frames.forEach((f, i) => {
    ctx.drawImage(fullCanvas, 0, f * (H + G), c.width, H, 0, i * (H + G), c.width, H);
  });
  return c;
}
