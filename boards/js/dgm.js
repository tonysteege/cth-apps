// The slide DIAGRAM LAYER: Diagrams-app elements on a slide.
//
// Elements are the Film Room interchange shapes, untouched (player, arrow
// with dash/motion, box, circle, text, pen, stamp, pucks) in RINK UNITS
// (3200x1600, the Diagrams coordinate space), so a drill drawn here is the
// same record a Diagrams drill holds and prints through the same drawEl().
//
// Where they land on the slide is the DIAGRAM BOX: the burned-in rink's
// box on a rink layout (half-right shows x 0..1600), or the whole slide
// otherwise (3200 x 1800 units, so the space keeps the rink's scale).

import { drawEl, colorOf, arrowPathPoints } from '/diagrams/js/flat.js';
import { ITEMS } from '/diagrams/js/rink.js';

export const DGM_W = 3200;
export const DGM_H = 1600;

// The box in slide percent, and the unit space it shows.
export function dgmBox(mode) {
  if (mode === 'half-right') return { left: 54, top: 12, width: 42.75, height: 76, uw: 1600, uh: 1600 };
  if (mode === 'full-right') return { left: 36, top: 22, width: 60, height: 56, uw: 3200, uh: 1600 };
  if (mode === 'full') return { left: 5, top: 8, width: 90, height: 84, uw: 3200, uh: 1600 };
  return { left: 0, top: 0, width: 100, height: 100, uw: 3200, uh: 1800 };
}

// Sized for slide diagramming: a shade under the Diagrams defaults, which
// were tuned for a rink filling a window.
export const SIZES = { playerR: 45, text: 48, stroke: 8, pen: 8 };

export function paintElements(canvas, els, mode) {
  const box = dgmBox(mode);
  const scale = 0.5; // 3200 units -> 1600px canvas, crisp at every slide zoom
  canvas.width = Math.round(box.uw * scale);
  canvas.height = Math.round(box.uh * scale);
  const ctx = canvas.getContext('2d');
  ctx.clearRect(0, 0, canvas.width, canvas.height);
  ctx.save();
  ctx.scale(scale, scale);
  for (const x of els || []) { try { drawEl(ctx, x); } catch (_) {} }
  ctx.restore();
}

// Pointer (slide units) -> diagram units, and back.
export function toUnits(p, mode) {
  const b = dgmBox(mode);
  const x = ((p.x / 1600) * 100 - b.left) / b.width * b.uw;
  const y = ((p.y / 900) * 100 - b.top) / b.height * b.uh;
  return { x, y };
}
export function fromUnits(u, mode) {
  const b = dgmBox(mode);
  return { x: ((b.left + (u.x / b.uw) * b.width) / 100) * 1600, y: ((b.top + (u.y / b.uh) * b.height) / 100) * 900 };
}

// Element constructors (the Diagrams shapes, with slide-tuned sizes).
export const newPlayer = (color, label, u, id) => ({ id, type: 'player', color, label: label || '', x: u.x, y: u.y, r: SIZES.playerR });
export const newLine = (kind, u, id, color) => {
  const spec = { skate: { dash: false }, skatepuck: { dash: false, motion: 'puck' }, skateback: { dash: false, motion: 'backward' }, shoot: { dash: false, motion: 'shoot' }, pass: { dash: true } }[kind] || {};
  const a = { id, type: 'arrow', x1: u.x, y1: u.y, x2: u.x, y2: u.y, mx: u.x, my: u.y, width: SIZES.stroke, color: color || 'black', head: 'triangle', dash: !!spec.dash };
  if (spec.motion) a.motion = spec.motion;
  return a;
};
export const newBox = (kind, u, id, color) => ({ id, type: kind, x: u.x, y: u.y, w: 400, h: 300, color: color || 'black' });
export const newDText = (u, id, text, color) => ({ id, type: 'text', x: u.x, y: u.y, text: text || 'Text', size: SIZES.text, color: color || 'black' });
export const newDPen = (u, id, color) => ({ id, type: 'pen', pts: [[u.x, u.y]], color: color || 'black', width: SIZES.pen });
export const newStamp = (key, u, id) => {
  const it = ITEMS[key];
  if (!it) return null;
  if (key === 'pucks') return { id, type: 'pucks', x: u.x - it.w / 2, y: u.y - it.h / 2, w: it.w, h: it.h };
  return { id, type: 'stamp', name: it.file, flip: false, x: u.x - it.w / 2, y: u.y - it.h / 2, w: it.w, h: it.h };
};

// Bounding box in units, for hit-testing and moving.
export function bbox(x) {
  if (x.type === 'player') return { x: x.x - x.r, y: x.y - x.r, w: x.r * 2, h: x.r * 2 };
  if (x.type === 'arrow') {
    const pts = arrowPathPoints(x, 0, 24);
    const xs = pts.map((p) => p[0]); const ys = pts.map((p) => p[1]);
    const pad = (x.width || 8) * 2;
    return { x: Math.min(...xs) - pad, y: Math.min(...ys) - pad, w: Math.max(...xs) - Math.min(...xs) + pad * 2, h: Math.max(...ys) - Math.min(...ys) + pad * 2 };
  }
  if (x.type === 'text') { const w = (x.text || '').length * (x.size || 48) * 0.6 + 40; return { x: x.x - 20, y: x.y - (x.size || 48) * 0.7, w, h: (x.size || 48) * 1.4 }; }
  if (x.type === 'pen') {
    const xs = x.pts.map((p) => p[0]); const ys = x.pts.map((p) => p[1]); const pad = (x.width || 8) * 2;
    return { x: Math.min(...xs) - pad, y: Math.min(...ys) - pad, w: Math.max(...xs) - Math.min(...xs) + pad * 2, h: Math.max(...ys) - Math.min(...ys) + pad * 2 };
  }
  return { x: x.x, y: x.y, w: x.w, h: x.h };
}

export function hit(els, u) {
  for (let i = els.length - 1; i >= 0; i--) {
    const b = bbox(els[i]);
    if (u.x >= b.x && u.x <= b.x + b.w && u.y >= b.y && u.y <= b.y + b.h) return els[i];
  }
  return null;
}

export function moveBy(x, dx, dy) {
  if (x.type === 'arrow') { x.x1 += dx; x.y1 += dy; x.x2 += dx; x.y2 += dy; x.mx += dx; x.my += dy; return; }
  if (x.type === 'pen') { x.pts = x.pts.map(([px, py]) => [px + dx, py + dy]); return; }
  x.x += dx; x.y += dy;
}

export { colorOf };
