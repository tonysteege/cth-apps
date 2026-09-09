// TELESTRATION - the drawing vocabulary, and the ONE renderer that paints it.
//
// Every mark is drawn by `drawMark` onto a 2D context, and NOTHING else in the
// app draws a mark. The live preview, the scrub overlay, the exported MP4, the
// GIF and the poster frame all call this same function, which is why an export
// can never disagree with what was on screen. (Diagrams learned this the hard
// way with drawEl/svgEl kept in step by hand; here there is only one.)
//
// GEOMETRY IS NORMALISED. Every point is `{x, y}` in 0..1 of the SOURCE frame,
// never pixels. That is what lets one mark survive a 16:9 preview, a 9:16
// reframe, a 2x zoom and a 1080p export without being re-authored, and it is
// why a project opened on an iPad draws identically to the desktop.
//
// A mark:
//   { id, kind, t0, t1, anim, color, w, pts:[{x,y}], text?, ... }
//   plus optional TRACKING: `keys: [{ t, pts:[...] }]` - two or more keyframes
//   in OUTPUT seconds, interpolated so a spotlight follows a skater without
//   being redrawn every frame. This is the single biggest time-saver in the
//   app; without it these videos are frame-by-frame work.
//
// t0/t1 are OUTPUT seconds, so a mark drawn during a freeze simply spans the
// freeze - no special case anywhere.

import { uid } from './timemap.js';

// The palette is the broadcast-telestration set the reference clips use, not
// the CTH chrome ramp. Chrome is black; content is loud on purpose.
export const COLORS = {
  red:    { base: '#ff2d2d', lo: '#b30000', hi: '#ff8a8a', ink: '#ffffff' },
  yellow: { base: '#ffd21e', lo: '#c79500', hi: '#fff3a8', ink: '#1a1400' },
  orange: { base: '#ff8c1a', lo: '#c25a00', hi: '#ffc98a', ink: '#2a1400' },
  green:  { base: '#2ecc4a', lo: '#0f7a24', hi: '#a6f5b4', ink: '#04230b' },
  cyan:   { base: '#33c9ff', lo: '#0072a8', hi: '#b3ecff', ink: '#001a26' },
  white:  { base: '#ffffff', lo: '#9aa0a6', hi: '#ffffff', ink: '#0a0a0a' },
  black:  { base: '#101010', lo: '#000000', hi: '#4a4a4a', ink: '#ffffff' },
};
export const COLOR_KEYS = Object.keys(COLORS);
const pal = (c) => COLORS[c] || COLORS.red;

export const KINDS = ['spot', 'beam', 'arrow', 'zone', 'barrier', 'label', 'pen', 'shade'];

// Default sizes, in fractions of frame height so they scale with the picture.
const DEF = { spot: 0.055, beamH: 0.28, arrowW: 0.013, penW: 0.008, label: 0.038 };

export function newMark(kind, pts, opts = {}) {
  return {
    id: uid(),
    kind,
    t0: opts.t0 ?? 0,
    t1: opts.t1 ?? (opts.t0 ?? 0) + 2,
    anim: opts.anim ?? (kind === 'arrow' || kind === 'pen' ? 'draw' : 'pop'),
    color: opts.color ?? 'red',
    w: opts.w ?? 1,
    pts: pts.map((p) => ({ x: p.x, y: p.y })),
    ...opts.extra,
  };
}

// ---- timing ----------------------------------------------------------------

export const IN_DUR = 0.26;   // how long a mark takes to arrive
const OUT_DUR = 0.2;   // and to leave

// 0 before it exists, 1 while it is fully up, easing at both ends. `draw`
// returns the same envelope but the caller reads `p.grow` to reveal geometry.
export function markPhase(m, t) {
  const t0 = m.t0 ?? 0;
  const t1 = m.t1 ?? t0 + 2;
  if (t < t0 - 1e-6 || t > t1 + 1e-6) return null;
  const inD = Math.min(IN_DUR, (t1 - t0) * 0.4) || 1e-6;
  const outD = Math.min(OUT_DUR, (t1 - t0) * 0.3) || 1e-6;
  const rise = clamp01((t - t0) / inD);
  const fall = clamp01((t1 - t) / outD);
  const grow = m.anim === 'draw' ? easeOutCubic(rise) : 1;
  const scale = m.anim === 'pop' ? 1 + 0.12 * (1 - easeOutBack(rise)) : 1;
  // A pulse never fully leaves; it breathes so the eye keeps finding it.
  const pulse = m.anim === 'pulse' ? 0.78 + 0.22 * Math.sin((t - t0) * 5.2) : 1;
  return { alpha: Math.min(easeOutCubic(rise), easeOutCubic(fall)) * pulse, grow, scale, rise };
}

const clamp01 = (v) => (v < 0 ? 0 : v > 1 ? 1 : v);
const easeOutCubic = (v) => 1 - Math.pow(1 - clamp01(v), 3);
const easeInOut = (v) => (v < 0.5 ? 2 * v * v : 1 - Math.pow(-2 * v + 2, 2) / 2);
function easeOutBack(v) {
  const c1 = 1.70158; const c3 = c1 + 1; const x = clamp01(v);
  return 1 + c3 * Math.pow(x - 1, 3) + c1 * Math.pow(x - 1, 2);
}

// ---- tracking --------------------------------------------------------------

// Where a mark's points are at output time `t`. With no keyframes this is just
// `m.pts`; with them, the points are interpolated between the two surrounding
// keys and held flat outside the range. Keys must carry the same point count.
export function ptsAt(m, t) {
  const keys = m.keys;
  if (!keys || keys.length < 2) return m.pts;
  if (t <= keys[0].t) return keys[0].pts;
  if (t >= keys[keys.length - 1].t) return keys[keys.length - 1].pts;
  let i = 0;
  while (i < keys.length - 2 && keys[i + 1].t < t) i++;
  const a = keys[i]; const b = keys[i + 1];
  const span = b.t - a.t;
  const f = span <= 1e-9 ? 0 : easeInOut((t - a.t) / span);
  const n = Math.min(a.pts.length, b.pts.length);
  const out = [];
  for (let k = 0; k < n; k++) {
    out.push({ x: a.pts[k].x + (b.pts[k].x - a.pts[k].x) * f, y: a.pts[k].y + (b.pts[k].y - a.pts[k].y) * f });
  }
  return out;
}

// ---- the renderer ----------------------------------------------------------

// `view` maps normalised source space to canvas pixels. It is the ONLY thing
// that knows about zoom, pan and reframing:
//   { toX(nx), toY(ny), scale }  where `scale` is canvas px per 1.0 of frame
//   height, so every stroke width below is in frame-height fractions.
export function drawMark(ctx, m, t, view, opts = {}) {
  let p = markPhase(m, t);
  // `solid` is the editor asking for the mark at full strength - a mark placed
  // at the playhead sits on the first frame of its own fade-in and is
  // legitimately invisible. Correct in the file, useless while positioning it.
  if (opts.solid) p = p ? { ...p, alpha: 1, grow: 1, scale: 1 } : { alpha: 1, grow: 1, scale: 1, rise: 1 };
  if (!p || p.alpha <= 0.002) return;
  const pts = ptsAt(m, t).map((q) => ({ x: view.toX(q.x), y: view.toY(q.y) }));
  if (!pts.length) return;
  const c = pal(m.color);
  const S = view.scale;

  ctx.save();
  ctx.globalAlpha = p.alpha;
  ctx.lineCap = 'round';
  ctx.lineJoin = 'round';

  switch (m.kind) {
    case 'spot':    drawSpot(ctx, m, pts, c, S, p); break;
    case 'beam':    drawBeam(ctx, m, pts, c, S, p); break;
    case 'arrow':   drawArrow(ctx, m, pts, c, S, p); break;
    case 'zone':    drawZone(ctx, m, pts, c, S, p); break;
    case 'barrier': drawBarrier(ctx, m, pts, c, S, p); break;
    case 'label':   drawLabel(ctx, m, pts, c, S, p); break;
    case 'pen':     drawPen(ctx, m, pts, c, S, p); break;
    case 'shade':   drawShade(ctx, m, pts, c, S, p, view); break;
    default: break;
  }
  ctx.restore();
}

// A spotlight is an ELLIPSE, not a circle, because the ice is seen in
// perspective: a ring around a skater's feet is squashed, and how squashed
// depends on how far up the frame it sits. Modelling that from the y position
// is what stops these reading as stickers pasted on a photo.
function ellipseFor(m, pt, S, mul = 1) {
  const r = (m.r ?? DEF.spot) * S * (m.w || 1) * mul;
  const ny = m.tilt != null ? m.tilt : clamp01(pt.yN ?? 0.5);
  const squash = 0.3 + 0.28 * clamp01(ny); // flatter high in frame, rounder low
  return { rx: r, ry: r * squash };
}

function drawSpot(ctx, m, pts, c, S, p) {
  const pt = pts[0];
  pt.yN = m.tilt != null ? m.tilt : (m.pts[0]?.y ?? 0.5);
  const { rx, ry } = ellipseFor(m, pt, S, p.scale);
  const lw = Math.max(1.5, 0.009 * S * (m.w || 1));

  // A soft pool inside, so the ring sits ON the ice rather than floating.
  const g = ctx.createRadialGradient(pt.x, pt.y, 0, pt.x, pt.y, rx);
  g.addColorStop(0, hexA(c.base, 0.32));
  g.addColorStop(0.72, hexA(c.base, 0.14));
  g.addColorStop(1, hexA(c.base, 0));
  ctx.save();
  ctx.translate(pt.x, pt.y); ctx.scale(1, ry / rx); ctx.translate(-pt.x, -pt.y);
  ctx.fillStyle = g;
  ctx.beginPath(); ctx.arc(pt.x, pt.y, rx, 0, Math.PI * 2); ctx.fill();
  ctx.restore();

  // The ring: a dark liner under a bright stroke, which is how broadcast
  // graphics stay legible over both white ice and dark boards.
  ctx.beginPath(); ctx.ellipse(pt.x, pt.y, rx, ry, 0, 0, Math.PI * 2);
  ctx.lineWidth = lw * 2.1; ctx.strokeStyle = hexA('#000000', 0.35); ctx.stroke();
  ctx.lineWidth = lw; ctx.strokeStyle = c.base; ctx.stroke();

  if (m.text) chip(ctx, m.text, pt.x, pt.y + ry + 0.028 * S, c, S, 0.85);
}

function drawBeam(ctx, m, pts, c, S, p) {
  const pt = pts[0];
  pt.yN = m.tilt != null ? m.tilt : (m.pts[0]?.y ?? 0.5);
  const { rx, ry } = ellipseFor(m, pt, S, p.scale);
  const h = (m.h ?? DEF.beamH) * S * p.grow;

  // The column. It is a flat quad, not a cone: the reference clips use a
  // near-parallel shaft that fades out at the top, and a cone reads as a
  // spotlight from above rather than a marker rising off the ice.
  const g = ctx.createLinearGradient(0, pt.y - h, 0, pt.y);
  g.addColorStop(0, hexA(c.base, 0));
  g.addColorStop(0.55, hexA(c.base, 0.16));
  g.addColorStop(1, hexA(c.base, 0.34));
  ctx.fillStyle = g;
  ctx.beginPath();
  ctx.moveTo(pt.x - rx * 0.82, pt.y);
  ctx.lineTo(pt.x - rx * 0.62, pt.y - h);
  ctx.lineTo(pt.x + rx * 0.62, pt.y - h);
  ctx.lineTo(pt.x + rx * 0.82, pt.y);
  ctx.closePath();
  ctx.fill();

  drawSpot(ctx, { ...m, text: null }, pts, c, S, p);
  if (m.text) chip(ctx, m.text, pt.x, pt.y - h - 0.012 * S, c, S, 0.9);
}

// The arrow is the workhorse and the hardest to make look professional. Three
// things do it: a TAPER (fat at the tail, narrow into the head), a BEVEL (a
// light edge on top, dark underneath, so it reads as a solid object) and a
// DROP SHADOW. A flat stroked line with a triangle on the end looks like a
// draw tool; this looks like a broadcast.
function drawArrow(ctx, m, pts, c, S, p) {
  const path = curvePoints(pts, m.curve ?? 0);
  const grown = takeFraction(path, p.grow);
  if (grown.length < 2) return;
  const w = (m.aw ?? DEF.arrowW) * S * (m.w || 1);
  const headL = w * 3.4;
  const total = pathLength(grown);
  if (total < headL * 1.05) return;

  const body = trimEnd(grown, headL * 0.82);
  const tip = grown[grown.length - 1];
  const before = grown[grown.length - 2] || body[body.length - 1];
  const ang = Math.atan2(tip.y - before.y, tip.x - before.x);

  const drawBody = (offY, style, widen = 0) => {
    ctx.save();
    ctx.translate(0, offY);
    ctx.strokeStyle = style;
    if (m.dash) { ctx.setLineDash([w * 1.9, w * 1.35]); ctx.lineDashOffset = 0; }
    // Taper by stroking in segments of falling width.
    const n = body.length - 1;
    for (let i = 0; i < n; i++) {
      const f = i / Math.max(1, n - 1);
      ctx.beginPath();
      ctx.moveTo(body[i].x, body[i].y);
      ctx.lineTo(body[i + 1].x, body[i + 1].y);
      ctx.lineWidth = (w * (1.18 - 0.3 * f)) + widen;
      ctx.stroke();
    }
    ctx.restore();
  };

  const head = (offY, style, widen = 0) => {
    ctx.save();
    ctx.translate(tip.x, tip.y + offY);
    ctx.rotate(ang);
    ctx.fillStyle = style;
    ctx.beginPath();
    ctx.moveTo(headL * 0.34 + widen, 0);
    ctx.lineTo(-headL * 0.72 - widen * 0.4, -w * 1.5 - widen);
    ctx.lineTo(-headL * 0.44, 0);
    ctx.lineTo(-headL * 0.72 - widen * 0.4, w * 1.5 + widen);
    ctx.closePath();
    ctx.fill();
    ctx.restore();
  };

  drawBody(w * 0.55, hexA('#000000', 0.3), w * 0.25);  // shadow
  head(w * 0.55, hexA('#000000', 0.3), w * 0.2);
  drawBody(0, c.lo, w * 0.34);                          // dark edge
  head(0, c.lo, w * 0.22);
  drawBody(0, c.base);                                  // body
  head(0, c.base);
  drawBody(-w * 0.22, hexA(c.hi, 0.55), -w * 0.5);      // top bevel highlight

  if (m.text) chip(ctx, m.text, body[0].x, body[0].y - w * 2.2, c, S, 0.85);
}

function drawZone(ctx, m, pts, c, S, p) {
  if (pts.length < 2) return;
  ctx.beginPath();
  if (m.shape === 'ellipse' && pts.length >= 2) {
    const cx = (pts[0].x + pts[1].x) / 2; const cy = (pts[0].y + pts[1].y) / 2;
    ctx.ellipse(cx, cy, Math.abs(pts[1].x - pts[0].x) / 2, Math.abs(pts[1].y - pts[0].y) / 2, 0, 0, Math.PI * 2);
  } else if (pts.length === 2) {
    ctx.rect(Math.min(pts[0].x, pts[1].x), Math.min(pts[0].y, pts[1].y),
             Math.abs(pts[1].x - pts[0].x), Math.abs(pts[1].y - pts[0].y));
  } else {
    ctx.moveTo(pts[0].x, pts[0].y);
    for (let i = 1; i < pts.length; i++) ctx.lineTo(pts[i].x, pts[i].y);
    ctx.closePath();
  }
  ctx.fillStyle = hexA(c.base, 0.2 * p.grow);
  ctx.fill();
  ctx.lineWidth = Math.max(1.5, 0.007 * S * (m.w || 1));
  ctx.strokeStyle = hexA('#000000', 0.3); ctx.lineWidth *= 2; ctx.stroke();
  ctx.lineWidth = Math.max(1.5, 0.007 * S * (m.w || 1));
  ctx.strokeStyle = c.base;
  if (m.dash) ctx.setLineDash([0.018 * S, 0.012 * S]);
  ctx.stroke();
  if (m.text) {
    const cx = pts.reduce((a, q) => a + q.x, 0) / pts.length;
    const cy = pts.reduce((a, q) => a + q.y, 0) / pts.length;
    chip(ctx, m.text, cx, cy, c, S, 0.9);
  }
}

// The candy-stripe bar: "this lane is closed". A hatched quad between two
// points, with the stripes running across it.
function drawBarrier(ctx, m, pts, c, S, p) {
  if (pts.length < 2) return;
  const a = pts[0]; const b = pts[1];
  const ang = Math.atan2(b.y - a.y, b.x - a.x);
  const len = Math.hypot(b.x - a.x, b.y - a.y) * p.grow;
  const th = (m.th ?? 0.032) * S * (m.w || 1);
  if (len < 2) return;

  ctx.save();
  ctx.translate(a.x, a.y);
  ctx.rotate(ang);
  ctx.beginPath();
  ctx.rect(0, -th / 2, len, th);
  ctx.save();
  ctx.clip();
  ctx.fillStyle = hexA(c.base, 0.9);
  ctx.fillRect(0, -th / 2, len, th);
  const step = th * 0.66;
  ctx.fillStyle = hexA(m.alt ? (COLORS[m.alt] || COLORS.yellow).base : '#ffe14d', 0.95);
  for (let x = -th; x < len + th; x += step * 2) {
    ctx.beginPath();
    ctx.moveTo(x, th / 2); ctx.lineTo(x + step, th / 2);
    ctx.lineTo(x + step + th, -th / 2); ctx.lineTo(x + th, -th / 2);
    ctx.closePath(); ctx.fill();
  }
  ctx.restore();
  ctx.lineWidth = Math.max(1.2, 0.004 * S);
  ctx.strokeStyle = hexA('#000000', 0.45);
  ctx.stroke();
  ctx.restore();
  if (m.text) chip(ctx, m.text, (a.x + b.x) / 2, (a.y + b.y) / 2 - th, c, S, 0.85);
}

function drawLabel(ctx, m, pts, c, S, p) {
  const pt = pts[0];
  if (pts.length > 1) {
    // Leader line back to whatever the label is naming.
    const to = pts[1];
    ctx.beginPath(); ctx.moveTo(pt.x, pt.y); ctx.lineTo(to.x, to.y);
    ctx.lineWidth = Math.max(1.5, 0.005 * S); ctx.strokeStyle = hexA('#000000', 0.4); ctx.stroke();
    ctx.lineWidth = Math.max(1, 0.003 * S); ctx.strokeStyle = c.base; ctx.stroke();
  }
  chip(ctx, m.text || 'LABEL', pt.x, pt.y, c, S, p.scale, m.solid !== false);
}

function drawPen(ctx, m, pts, c, S, p) {
  const path = takeFraction(pts, p.grow);
  if (path.length < 2) return;
  const w = (m.aw ?? DEF.penW) * S * (m.w || 1);
  ctx.beginPath();
  ctx.moveTo(path[0].x, path[0].y);
  for (let i = 1; i < path.length; i++) ctx.lineTo(path[i].x, path[i].y);
  if (m.dash) ctx.setLineDash([w * 2.2, w * 1.6]);
  ctx.lineWidth = w * 2.2; ctx.strokeStyle = hexA('#000000', 0.32); ctx.stroke();
  ctx.lineWidth = w; ctx.strokeStyle = c.base; ctx.stroke();
}

// Darken everything EXCEPT a chosen region - the "look here, ignore the rest"
// move. Two points make a rectangle; more make a polygon.
function drawShade(ctx, m, pts, c, S, p, view) {
  ctx.save();
  ctx.fillStyle = hexA('#000000', (m.amount ?? 0.55) * p.grow);
  ctx.beginPath();
  ctx.rect(view.x0, view.y0, view.w, view.h);
  if (pts.length === 2) {
    const x = Math.min(pts[0].x, pts[1].x); const y = Math.min(pts[0].y, pts[1].y);
    const w = Math.abs(pts[1].x - pts[0].x); const h = Math.abs(pts[1].y - pts[0].y);
    if (m.shape === 'ellipse') {
      ctx.ellipse(x + w / 2, y + h / 2, w / 2, h / 2, 0, 0, Math.PI * 2, true);
    } else {
      ctx.moveTo(x, y); ctx.lineTo(x, y + h); ctx.lineTo(x + w, y + h); ctx.lineTo(x + w, y); ctx.closePath();
    }
  } else if (pts.length > 2) {
    ctx.moveTo(pts[0].x, pts[0].y);
    for (let i = pts.length - 1; i >= 1; i--) ctx.lineTo(pts[i].x, pts[i].y);
    ctx.closePath();
  }
  ctx.fill('evenodd');
  ctx.restore();
}

// The text chip: a dark rounded plate with bold light text. It is the one
// element that must stay readable at phone size on a busy rink, which is why
// it is a solid plate rather than a stroked outline.
function chip(ctx, text, x, y, c, S, scale = 1, solid = true) {
  const size = Math.max(9, DEF.label * S * 0.42 * scale);
  ctx.save();
  ctx.font = `800 ${size}px Inter, -apple-system, "Helvetica Neue", sans-serif`;
  ctx.textAlign = 'center';
  ctx.textBaseline = 'middle';
  const str = String(text).toUpperCase();
  const w = ctx.measureText(str).width;
  const padX = size * 0.55; const padY = size * 0.38;
  const bw = w + padX * 2; const bh = size + padY * 2;
  const r = bh * 0.32;
  if (solid) {
    ctx.beginPath();
    roundRect(ctx, x - bw / 2, y - bh / 2, bw, bh, r);
    ctx.fillStyle = hexA('#000000', 0.86);
    ctx.shadowColor = hexA('#000000', 0.5); ctx.shadowBlur = size * 0.5; ctx.shadowOffsetY = size * 0.12;
    ctx.fill();
    ctx.shadowColor = 'transparent'; ctx.shadowBlur = 0; ctx.shadowOffsetY = 0;
    ctx.lineWidth = Math.max(1, size * 0.075);
    ctx.strokeStyle = hexA(c.base, 0.9);
    ctx.stroke();
  }
  ctx.fillStyle = solid ? c.base : '#ffffff';
  if (!solid) { ctx.shadowColor = hexA('#000000', 0.8); ctx.shadowBlur = size * 0.55; }
  ctx.fillText(str, x, y);
  ctx.restore();
}

function roundRect(ctx, x, y, w, h, r) {
  const rr = Math.min(r, w / 2, h / 2);
  ctx.moveTo(x + rr, y);
  ctx.arcTo(x + w, y, x + w, y + h, rr);
  ctx.arcTo(x + w, y + h, x, y + h, rr);
  ctx.arcTo(x, y + h, x, y, rr);
  ctx.arcTo(x, y, x + w, y, rr);
  ctx.closePath();
}

// ---- path maths ------------------------------------------------------------

// Two points plus a curve amount become a quadratic; three or more are already
// a path and are smoothed through their own points. `curve` is a fraction of
// the chord, signed, so dragging an arrow's middle handle bends it.
export function curvePoints(pts, curve = 0, steps = 34) {
  if (pts.length < 2) return pts;
  if (pts.length === 2) {
    const [a, b] = pts;
    if (!curve) return [a, b];
    const mx = (a.x + b.x) / 2; const my = (a.y + b.y) / 2;
    const dx = b.x - a.x; const dy = b.y - a.y;
    const cx = mx - dy * curve; const cy = my + dx * curve;
    const out = [];
    for (let i = 0; i <= steps; i++) {
      const t = i / steps; const u = 1 - t;
      out.push({ x: u * u * a.x + 2 * u * t * cx + t * t * b.x, y: u * u * a.y + 2 * u * t * cy + t * t * b.y });
    }
    return out;
  }
  // Catmull-Rom through the points, so a three-point arrow bends smoothly.
  const out = [];
  const P = [pts[0], ...pts, pts[pts.length - 1]];
  for (let i = 1; i < P.length - 2; i++) {
    for (let j = 0; j < steps; j++) {
      const t = j / steps; const t2 = t * t; const t3 = t2 * t;
      out.push({
        x: 0.5 * ((2 * P[i].x) + (-P[i - 1].x + P[i + 1].x) * t + (2 * P[i - 1].x - 5 * P[i].x + 4 * P[i + 1].x - P[i + 2].x) * t2 + (-P[i - 1].x + 3 * P[i].x - 3 * P[i + 1].x + P[i + 2].x) * t3),
        y: 0.5 * ((2 * P[i].y) + (-P[i - 1].y + P[i + 1].y) * t + (2 * P[i - 1].y - 5 * P[i].y + 4 * P[i + 1].y - P[i + 2].y) * t2 + (-P[i - 1].y + 3 * P[i].y - 3 * P[i + 1].y + P[i + 2].y) * t3),
      });
    }
  }
  out.push(pts[pts.length - 1]);
  return out;
}

export function pathLength(pts) {
  let n = 0;
  for (let i = 1; i < pts.length; i++) n += Math.hypot(pts[i].x - pts[i - 1].x, pts[i].y - pts[i - 1].y);
  return n;
}

// The first `f` of a path by LENGTH, not by point count - an arrow must draw on
// at an even speed whatever its point spacing.
function takeFraction(pts, f) {
  if (f >= 1 || pts.length < 2) return pts;
  if (f <= 0) return [];
  const want = pathLength(pts) * f;
  const out = [pts[0]];
  let acc = 0;
  for (let i = 1; i < pts.length; i++) {
    const d = Math.hypot(pts[i].x - pts[i - 1].x, pts[i].y - pts[i - 1].y);
    if (acc + d >= want) {
      const r = (want - acc) / (d || 1);
      out.push({ x: pts[i - 1].x + (pts[i].x - pts[i - 1].x) * r, y: pts[i - 1].y + (pts[i].y - pts[i - 1].y) * r });
      return out;
    }
    acc += d; out.push(pts[i]);
  }
  return out;
}

function trimEnd(pts, by) {
  const total = pathLength(pts);
  return takeFraction(pts, total <= by ? 0 : (total - by) / total);
}

export function hexA(hex, a) {
  const h = hex.replace('#', '');
  const n = parseInt(h.length === 3 ? h.split('').map((x) => x + x).join('') : h, 16);
  return `rgba(${(n >> 16) & 255}, ${(n >> 8) & 255}, ${n & 255}, ${a})`;
}

// ---- hit testing (the editor's side of the same geometry) ------------------

export function hitTest(m, t, view, px, py, slop = 10) {
  const pts = ptsAt(m, t).map((q) => ({ x: view.toX(q.x), y: view.toY(q.y) }));
  if (!pts.length) return false;
  const S = view.scale;
  if (m.kind === 'spot' || m.kind === 'beam') {
    const pt = { ...pts[0], yN: m.tilt ?? m.pts[0].y };
    const { rx, ry } = ellipseFor(m, pt, S);
    const dx = (px - pt.x) / (rx + slop); const dy = (py - pt.y) / (ry + slop);
    if (dx * dx + dy * dy <= 1) return true;
    if (m.kind === 'beam') {
      const h = (m.h ?? DEF.beamH) * S;
      return px > pt.x - rx && px < pt.x + rx && py < pt.y && py > pt.y - h;
    }
    return false;
  }
  if (m.kind === 'label') return Math.hypot(px - pts[0].x, py - pts[0].y) < 0.05 * S;
  if (m.kind === 'zone' || m.kind === 'shade') {
    if (pts.length === 2) {
      return px > Math.min(pts[0].x, pts[1].x) - slop && px < Math.max(pts[0].x, pts[1].x) + slop
          && py > Math.min(pts[0].y, pts[1].y) - slop && py < Math.max(pts[0].y, pts[1].y) + slop;
    }
    return pointInPoly(px, py, pts);
  }
  const path = m.kind === 'arrow' ? curvePoints(pts, m.curve ?? 0) : pts;
  const w = ((m.kind === 'barrier' ? (m.th ?? 0.032) : (m.aw ?? DEF.arrowW)) * S) / 2 + slop;
  for (let i = 1; i < path.length; i++) if (distToSeg(px, py, path[i - 1], path[i]) < w) return true;
  return false;
}

function distToSeg(px, py, a, b) {
  const dx = b.x - a.x; const dy = b.y - a.y;
  const l2 = dx * dx + dy * dy;
  const t = l2 ? Math.max(0, Math.min(1, ((px - a.x) * dx + (py - a.y) * dy) / l2)) : 0;
  return Math.hypot(px - (a.x + t * dx), py - (a.y + t * dy));
}

function pointInPoly(px, py, pts) {
  let inside = false;
  for (let i = 0, j = pts.length - 1; i < pts.length; j = i++) {
    if ((pts[i].y > py) !== (pts[j].y > py)
      && px < ((pts[j].x - pts[i].x) * (py - pts[i].y)) / (pts[j].y - pts[i].y) + pts[i].x) inside = !inside;
  }
  return inside;
}
