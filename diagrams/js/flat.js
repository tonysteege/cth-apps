// Pure canvas rendering of diagram elements - shared by the live editor
// (editor.js) and headless exports from the library. Keep drawEl() in step
// with editor.js svgEl() per element type.
//
// Colors: an element's `color` is either a slot NAME (black / blue / grey /
// red - the Film Room palette, stable for interchange) or a raw hex string
// from a customized preset. colorOf() resolves both.

import { composeRinkBg, loadImg, shapeImg, RINK_H, SEQ_GAP } from './rink.js';

export const INK = '#1e1e1e';
// The first SLOT_COUNT entries are the toolbar's four default presets. Every
// entry, default or not, stays resolvable by colorOf() forever: an element's
// stored `color` may name any of them, and the names are shared with CTH Film
// Room. Never remove a name from this list - it would silently repaint saved
// diagrams black.
export const SLOT_COUNT = 4;
export const PALETTE = [
  ['black', INK],
  ['blue', '#75d8ff'],
  ['grey', '#d9d9d9'],
  ['green', '#16a34a'],
  // `red` stopped being the fourth default preset on 2026-08-24 (Tony swapped
  // it for green). It is still listed because diagrams saved before that date,
  // and anything arriving from Film Room, store color: 'red'.
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

// ---- motion arrows (2026-08-27) -------------------------------------------
//
// An arrow may carry an optional `motion` property naming what the movement
// IS: 'puck' (skate with puck), 'backward' (skate backwards), 'shoot'.
// Absent means plain skating; a pass stays `dash: true` as it always was.
// The property is ADDITIVE on the stored shape - old consumers (Film Room)
// simply draw a plain arrow. It matters twice: the body is DECORATED so the
// printed diagram reads like a real drill sheet (squiggle = carrying,
// c-cuts = backwards, doubled line = shot), and the animator reads it for
// speed and for whether the puck travels with the player.
//
// The decoration geometry is computed HERE, once, as polylines both
// renderers consume - it is the only way drawEl and svgEl stay identical.

export function arrowPathPoints(a, trim, n = 64) {
  const { cx, cy } = arrowCtrl(a);
  const pts = [];
  for (let i = 0; i <= n; i++) {
    const t = i / n;
    const u = 1 - t;
    pts.push([
      u * u * a.x1 + 2 * u * t * cx + t * t * a.x2,
      u * u * a.y1 + 2 * u * t * cy + t * t * a.y2,
    ]);
  }
  // Cut `trim` of arc length off the tail so the body stops short of the
  // arrowhead exactly like the plain Q-path with its endpoint pulled back.
  if (trim > 0) {
    let cut = trim;
    while (pts.length > 2 && cut > 0) {
      const [x1, y1] = pts[pts.length - 2];
      const [x2, y2] = pts[pts.length - 1];
      const seg = Math.hypot(x2 - x1, y2 - y1);
      if (seg <= cut) { pts.pop(); cut -= seg; } else {
        const f = (seg - cut) / seg;
        pts[pts.length - 1] = [x1 + (x2 - x1) * f, y1 + (y2 - y1) * f];
        cut = 0;
      }
    }
  }
  return pts;
}

export function arrowLength(a) {
  const pts = arrowPathPoints(a, 0, 48);
  let L = 0;
  for (let i = 1; i < pts.length; i++) L += Math.hypot(pts[i][0] - pts[i - 1][0], pts[i][1] - pts[i - 1][1]);
  return L;
}

// A point (and tangent angle) at arc-length fraction f of the arrow body.
export function arrowPointAt(a, f) {
  const pts = arrowPathPoints(a, 0, 64);
  const segs = [];
  let L = 0;
  for (let i = 1; i < pts.length; i++) {
    const d = Math.hypot(pts[i][0] - pts[i - 1][0], pts[i][1] - pts[i - 1][1]);
    segs.push(d);
    L += d;
  }
  let want = Math.max(0, Math.min(1, f)) * L;
  for (let i = 0; i < segs.length; i++) {
    if (want <= segs[i] || i === segs.length - 1) {
      const t = segs[i] ? want / segs[i] : 0;
      const [x1, y1] = pts[i];
      const [x2, y2] = pts[i + 1];
      return { x: x1 + (x2 - x1) * t, y: y1 + (y2 - y1) * t, ang: Math.atan2(y2 - y1, x2 - x1) };
    }
    want -= segs[i];
  }
  const last = pts[pts.length - 1];
  return { x: last[0], y: last[1], ang: arrowEndAngle(a) };
}

// The decorated body for a motion arrow, as polylines. Null means "draw the
// plain body" (skating, and every pass).
export function motionPolys(a, trim) {
  const m = a.motion;
  if (!m || m === 'skate' || a.dash) return null;
  const w = a.width || 8;
  const pts = arrowPathPoints(a, trim);
  const withNormals = pts.map((p, i) => {
    const q = pts[Math.min(i + 1, pts.length - 1)];
    const r = pts[Math.max(i - 1, 0)];
    const ang = Math.atan2(q[1] - r[1], q[0] - r[0]);
    return { x: p[0], y: p[1], nx: -Math.sin(ang), ny: Math.cos(ang), ang };
  });
  const total = pts.reduce((acc, p, i) => (i ? acc + Math.hypot(p[0] - pts[i - 1][0], p[1] - pts[i - 1][1]) : 0), 0);
  if (m === 'shoot') {
    // A shot is the classic doubled line.
    const off = w * 1.05;
    return [
      withNormals.map((p) => [p.x + p.nx * off, p.y + p.ny * off]),
      withNormals.map((p) => [p.x - p.nx * off, p.y - p.ny * off]),
    ];
  }
  if (m === 'puck') {
    // Carrying the puck: a squiggle. The amplitude eases in and fades out
    // near the head so the wave lands cleanly on the arrowhead.
    const amp = w * 1.9;
    const wave = Math.max(w * 7, 40);
    let dist = 0;
    return [withNormals.map((p, i) => {
      if (i) dist += Math.hypot(p.x - withNormals[i - 1].x, p.y - withNormals[i - 1].y);
      const fade = Math.min(1, dist / (wave * 0.6)) * Math.min(1, (total - dist) / (wave * 0.8));
      const off = Math.sin((dist / wave) * Math.PI * 2) * amp * Math.max(0, fade);
      return [p.x + p.nx * off, p.y + p.ny * off];
    })];
  }
  if (m === 'backward') {
    // Backwards skating: repeated c-cuts along the route, no spine - the
    // standard drill-book drawing. Each c is a short arc facing travel.
    const gap = Math.max(w * 5.2, 34);
    const r = Math.max(w * 1.7, 11);
    const polys = [];
    let dist = 0;
    let next = gap * 0.5;
    for (let i = 1; i < withNormals.length; i++) {
      const p = withNormals[i];
      dist += Math.hypot(p.x - withNormals[i - 1].x, p.y - withNormals[i - 1].y);
      if (dist >= next && dist < total - gap * 0.35) {
        next += gap;
        const arc = [];
        for (let k = 0; k <= 8; k++) {
          const th = p.ang + Math.PI / 2 + (Math.PI * 1.15) * (k / 8) - Math.PI * 0.075;
          arc.push([p.x + Math.cos(th) * r, p.y + Math.sin(th) * r]);
        }
        polys.push(arc);
      }
    }
    // A very short arrow still shows one cut.
    if (!polys.length) {
      const p = withNormals[Math.floor(withNormals.length / 2)];
      const arc = [];
      for (let k = 0; k <= 8; k++) {
        const th = p.ang + Math.PI / 2 + (Math.PI * 1.15) * (k / 8) - Math.PI * 0.075;
        arc.push([p.x + Math.cos(th) * r, p.y + Math.sin(th) * r]);
      }
      polys.push(arc);
    }
    return polys;
  }
  return null;
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
    ctx.strokeStyle = colorOf(x.color);
    ctx.lineWidth = w;
    ctx.lineCap = 'round';
    ctx.lineJoin = 'round';
    const deco = motionPolys(x, trim);
    if (deco) {
      // A motion-decorated body (squiggle / c-cuts / doubled line). The
      // backward c-cuts draw slightly lighter so they read as edgework.
      if (x.motion === 'backward') ctx.lineWidth = Math.max(2, w * 0.85);
      for (const poly of deco) {
        ctx.beginPath();
        poly.forEach(([px, py], i) => (i ? ctx.lineTo(px, py) : ctx.moveTo(px, py)));
        ctx.stroke();
      }
      ctx.lineWidth = w;
    } else {
      ctx.beginPath();
      ctx.moveTo(x.x1, x.y1);
      ctx.quadraticCurveTo(cx, cy, x.x2 - Math.cos(ang) * trim, x.y2 - Math.sin(ang) * trim);
      if (x.dash) ctx.setLineDash([w * 2.4, w * 2]);
      ctx.stroke();
      ctx.setLineDash([]);
    }
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
