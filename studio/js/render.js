// THE COMPOSITOR - source picture + camera + marks -> one output frame.
//
// `composite()` is the only function that paints a finished frame, and the
// preview, the poster, the GIF and every frame of an exported MP4 all go
// through it. Give it a source (a <video>, a VideoFrame or an ImageBitmap) and
// an output time, and it produces the picture. That single path is why the
// export cannot drift from the preview.
//
// TWO TRANSFORMS STACK, in this order:
//
//   1. THE FORMAT CROP. The source is 16:9; the output may be 9:16 or 1:1. The
//      crop is a window on the source, and its CENTRE is keyframed, so a
//      vertical cut can follow the play up the ice instead of sitting on the
//      middle of a wide shot and missing everything.
//   2. THE CAMERA. Zoom and pan inside that window - the punch-in on a battle
//      in the corner. Also keyframed, also eased.
//
// Both collapse into one `view`, which is what marks.js draws through. A mark
// is stored in normalised SOURCE space, so it stays glued to the ice through
// any crop, any zoom and any output size, at no cost to the author.

import { drawMark } from './marks.js';

export const FORMATS = {
  '16:9': { w: 1920, h: 1080, label: 'Landscape', note: 'YouTube, courses' },
  '9:16': { w: 1080, h: 1920, label: 'Vertical',  note: 'Reels, TikTok, Shorts' },
  '1:1':  { w: 1080, h: 1080, label: 'Square',    note: 'Instagram feed' },
  '4:5':  { w: 1080, h: 1350, label: 'Portrait',  note: 'Instagram tall' },
};

// Output sizes. QUALITY IS A PRESET, NOT A HEIGHT: "720" on a vertical video
// means 720 WIDE (720x1280), which is what every platform means by it. Keying
// this off a single height gave 406x720 for 9:16 - a legal file that no one
// asked for. Sizes are even numbers because H.264 requires it.
export const QUALITY = {
  sd:  { label: 'SD',    note: 'fast, small' },
  hd:  { label: '720p',  note: 'the default' },
  fhd: { label: '1080p', note: 'upscaled from 720p film' },
};
const SIZES = {
  '16:9': { sd: [854, 480],  hd: [1280, 720],  fhd: [1920, 1080] },
  '9:16': { sd: [480, 854],  hd: [720, 1280],  fhd: [1080, 1920] },
  '1:1':  { sd: [480, 480],  hd: [720, 720],   fhd: [1080, 1080] },
  '4:5':  { sd: [480, 600],  hd: [720, 900],   fhd: [1080, 1350] },
};

export function formatSize(aspect, quality = 'hd') {
  const row = SIZES[aspect] || SIZES['16:9'];
  const [w, h] = row[quality] || row.hd;
  return { w, h };
}

// ---- keyframes -------------------------------------------------------------

const clamp01 = (v) => (v < 0 ? 0 : v > 1 ? 1 : v);
const easeInOut = (v) => (v < 0.5 ? 2 * v * v : 1 - Math.pow(-2 * v + 2, 2) / 2);

// Camera keys are `{ t, cx, cy, zoom }` in OUTPUT seconds, cx/cy normalised
// source coords, zoom >= 1. No keys means a static, full, centred frame.
export function cameraAt(keys, t) {
  const k = (keys || []).slice().sort((a, b) => a.t - b.t);
  const flat = { cx: 0.5, cy: 0.5, zoom: 1 };
  if (!k.length) return flat;
  if (k.length === 1 || t <= k[0].t) return { ...flat, ...k[0] };
  if (t >= k[k.length - 1].t) return { ...flat, ...k[k.length - 1] };
  let i = 0;
  while (i < k.length - 2 && k[i + 1].t < t) i++;
  const a = k[i]; const b = k[i + 1];
  const span = b.t - a.t;
  const f = span <= 1e-9 ? 0 : (b.ease === 'linear' ? clamp01((t - a.t) / span) : easeInOut((t - a.t) / span));
  const lerp = (p, q, d) => (p ?? d) + ((q ?? d) - (p ?? d)) * f;
  return { cx: lerp(a.cx, b.cx, 0.5), cy: lerp(a.cy, b.cy, 0.5), zoom: lerp(a.zoom, b.zoom, 1) };
}

// ---- the view --------------------------------------------------------------

// Work out where normalised source point (0..1, 0..1) lands on the output
// canvas. `srcAR` is the source's own aspect (w/h); `outW/outH` the canvas.
//
// The crop window is the largest region of the source with the OUTPUT's aspect
// that fits inside it, divided by zoom, centred on (cx, cy) and then pushed
// back inside the source so a pan can never expose a black edge. That last
// clamp is the difference between a reframe tool you can use fast and one that
// punishes every drag.
export function buildView(srcAR, outW, outH, cam) {
  const outAR = outW / outH;
  const zoom = Math.max(1, cam.zoom || 1);

  // Crop size in normalised source units.
  let cw; let ch;
  if (outAR <= srcAR) { ch = 1; cw = (outAR / srcAR); }   // taller output: crop the sides
  else { cw = 1; ch = (srcAR / outAR); }                   // wider output: crop top/bottom
  cw /= zoom; ch /= zoom;

  const half = { x: cw / 2, y: ch / 2 };
  const cx = Math.min(1 - half.x, Math.max(half.x, cam.cx ?? 0.5));
  const cy = Math.min(1 - half.y, Math.max(half.y, cam.cy ?? 0.5));
  const x0n = cx - half.x; const y0n = cy - half.y;

  const sx = outW / cw;   // output px per 1.0 of normalised source width
  const sy = outH / ch;

  return {
    // marks.js draws through these three.
    toX: (nx) => (nx - x0n) * sx,
    toY: (ny) => (ny - y0n) * sy,
    scale: sy,            // px per 1.0 of frame HEIGHT: every stroke width unit
    // the output rect, for full-frame effects like `shade`
    x0: 0, y0: 0, w: outW, h: outH,
    // the crop, for the exporter's drawImage and for the editor's handles
    crop: { x: x0n, y: y0n, w: cw, h: ch },
    // canvas px -> normalised source, for pointer input
    fromX: (px) => x0n + px / sx,
    fromY: (py) => y0n + py / sy,
  };
}

// ---- one frame -------------------------------------------------------------

// `src` is anything drawImage takes: HTMLVideoElement, VideoFrame, ImageBitmap,
// or a canvas. `srcW/srcH` must be the picture's real pixels - a <video>'s
// videoWidth, not its CSS box.
export function composite(ctx, src, srcW, srcH, project, outT, opts = {}) {
  const outW = ctx.canvas.width;
  const outH = ctx.canvas.height;
  const cam = opts.camera || cameraAt(project.camera, outT);
  const view = buildView(srcW / srcH, outW, outH, cam);

  ctx.save();
  ctx.imageSmoothingEnabled = true;
  ctx.imageSmoothingQuality = 'high';
  ctx.fillStyle = '#000';
  ctx.fillRect(0, 0, outW, outH);

  if (src) {
    const c = view.crop;
    ctx.drawImage(src, c.x * srcW, c.y * srcH, c.w * srcW, c.h * srcH, 0, 0, outW, outH);
  }

  if (opts.grade) applyGrade(ctx, outW, outH, opts.grade);

  const marks = project.marks || [];
  for (const m of marks) {
    if (opts.skip && opts.skip.has(m.id)) continue;
    // THE SELECTED MARK IS DRAWN AT FULL STRENGTH, in the editor only. A mark
    // placed at the playhead sits on the first frame of its own fade-in, so it
    // is legitimately invisible - correct in the file, useless while you are
    // positioning it. `emphasize` is never passed by the exporter.
    drawMark(ctx, m, outT, view, { solid: opts.emphasize === m.id });
  }

  if (project.brand && project.brand.on !== false) drawBrand(ctx, project, outW, outH, outT);
  ctx.restore();
  return view;
}

// A gentle contrast lift so telestration colour separates from white ice. Off
// by default; it is a look, not a fix.
function applyGrade(ctx, w, h, amount) {
  const a = Math.max(0, Math.min(1, amount));
  if (!a) return;
  ctx.save();
  ctx.globalCompositeOperation = 'multiply';
  const g = ctx.createLinearGradient(0, 0, 0, h);
  g.addColorStop(0, `rgba(255,255,255,1)`);
  g.addColorStop(1, `rgba(${255 - 30 * a},${255 - 26 * a},${255 - 18 * a},1)`);
  ctx.fillStyle = g;
  ctx.fillRect(0, 0, w, h);
  ctx.restore();
}

// The title card and the corner mark. The reference clips carry their identity
// in the FILE NAME and in a burned-in lower-third, and both matter: one gets
// the click, the other survives a re-upload by somebody else.
function drawBrand(ctx, project, w, h, t) {
  const b = project.brand || {};
  const S = h;

  // Opening title: a full-frame card that wipes off in the first seconds.
  const titleDur = b.titleDur ?? 2.2;
  if (b.title && t < titleDur) {
    const f = t / titleDur;
    const out = f > 0.78 ? (f - 0.78) / 0.22 : 0;
    ctx.save();
    ctx.globalAlpha = 1 - out;
    ctx.fillStyle = 'rgba(0,0,0,0.62)';
    ctx.fillRect(0, 0, w, h);
    const big = Math.max(16, S * 0.075);
    ctx.textAlign = 'center'; ctx.textBaseline = 'middle';
    ctx.fillStyle = '#ffffff';
    ctx.font = `800 ${big}px Inter, -apple-system, sans-serif`;
    wrapText(ctx, String(b.title).toUpperCase(), w / 2, h / 2 - big * 0.1, w * 0.86, big * 1.16);
    if (b.subtitle) {
      ctx.font = `600 ${big * 0.42}px Inter, -apple-system, sans-serif`;
      ctx.fillStyle = 'rgba(255,255,255,0.72)';
      ctx.fillText(String(b.subtitle), w / 2, h / 2 + big * 0.95);
    }
    ctx.restore();
  }

  if (b.corner) {
    const size = Math.max(9, S * 0.026);
    ctx.save();
    ctx.font = `700 ${size}px Inter, -apple-system, sans-serif`;
    ctx.textAlign = 'right'; ctx.textBaseline = 'bottom';
    ctx.fillStyle = 'rgba(0,0,0,0.5)';
    ctx.fillText(b.corner, w - size * 0.9 + 1, h - size * 0.8 + 1);
    ctx.fillStyle = 'rgba(255,255,255,0.9)';
    ctx.fillText(b.corner, w - size * 0.9, h - size * 0.8);
    ctx.restore();
  }
}

function wrapText(ctx, text, x, y, maxW, lineH) {
  const words = String(text).split(/\s+/);
  const lines = []; let line = '';
  for (const word of words) {
    const test = line ? `${line} ${word}` : word;
    if (ctx.measureText(test).width > maxW && line) { lines.push(line); line = word; } else line = test;
  }
  if (line) lines.push(line);
  const start = y - ((lines.length - 1) * lineH) / 2;
  lines.forEach((l, i) => ctx.fillText(l, x, start + i * lineH));
}
