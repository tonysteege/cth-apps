// Pure canvas rendering of diagram elements - shared by the live editor
// (editor.js) and headless exports from the library. Keep drawEl() in step
// with editor.js svgEl() per element type.

import { composeRinkBg, loadImg, shapeImg } from './rink.js';

export const INK = '#1e1e1e';
export const PALETTE = [
  ['black', INK],
  ['blue', '#75d8ff'],
  ['grey', '#d9d9d9'],
  ['red', '#dc2626'],
];
export const colorOf = (name) => (PALETTE.find(([n]) => n === name) || PALETTE[0])[1];
export const labelInkOn = (name) => (name === 'black' || name === 'red' ? '#ffffff' : INK);

let measureCtx = null;
export function measureText(x) {
  if (!measureCtx) measureCtx = document.createElement('canvas').getContext('2d');
  measureCtx.font = `600 ${x.size}px Inter, 'Helvetica Neue', sans-serif`;
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

export function drawEl(ctx, x) {
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
  if (x.type === 'box') {
    ctx.save();
    ctx.globalAlpha = x.alpha == null ? 0.3 : x.alpha;
    ctx.fillStyle = colorOf(x.color);
    ctx.beginPath();
    ctx.roundRect(x.x, x.y, x.w, x.h, Math.min(x.w, x.h) * 0.06);
    ctx.fill();
    ctx.restore();
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
    ctx.font = `600 ${x.size}px Inter, 'Helvetica Neue', sans-serif`;
    ctx.textAlign = 'left';
    ctx.textBaseline = 'alphabetic';
    const w = measureText(x);
    const padX = x.size * 0.32; const padY = x.size * 0.2;
    ctx.save();
    ctx.shadowColor = 'rgba(26,26,26,0.20)';
    ctx.shadowBlur = x.size * 0.38;
    ctx.shadowOffsetY = x.size * 0.10;
    ctx.fillStyle = 'rgba(255,255,255,0.97)';
    ctx.beginPath();
    ctx.roundRect(x.x - padX, x.y - x.size - padY, w + padX * 2, x.size * 1.25 + padY * 2, x.size * 0.22);
    ctx.fill();
    ctx.shadowColor = 'transparent';
    ctx.strokeStyle = 'rgba(26,26,26,0.15)';
    ctx.lineWidth = Math.max(1, x.size * 0.05);
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
