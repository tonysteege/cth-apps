// CTH Clips - the grade: one non-destructive edit carried on a game record.
//
// WHY THIS REPLACED A RENDER (2026-08-27, Tony's call: "instant or remove
// it"). The first video editor re-encoded the whole file through
// MediaRecorder, which runs in REAL TIME - a 90 minute game cost 90 minutes
// and came back lossy. That is the wrong trade for every edit it offered,
// because crop, colour and a watermark patch are not changes to the footage.
// They are changes to how the footage is SHOWN.
//
// So nothing is re-encoded, ever. The edit is a small record, and it is
// applied in the three places the picture is actually produced:
//
//   1. LIVE PLAYBACK - a CSS filter and transform on the video element.
//   2. A FROZEN FRAME - baked into the canvas `grabFrame` returns, so an
//      annotation is drawn on the graded picture and not on the raw one.
//   3. EVERY EXPORT - handed to `recordRange`, which already composites
//      through a canvas, so a clip lands graded with no extra work.
//
// What that buys, beyond the speed: applying is instant, reverting is
// instant, the master file in videos/ is never touched, there is no
// generation loss, and TRIM NO LONGER SHIFTS EVERY TIMECODE - the whole
// class of bug that made `shiftGame` necessary simply cannot happen, because
// the file's own clock never moves.
//
// THE TRADE, stated plainly: the file on disk stays ungraded. Anything that
// leaves Clips leaves through an export, and exports are graded, so this only
// matters if Tony hands someone the raw game file - and a raw master is the
// right thing to hand over anyway.
//
// STORAGE IS ADDITIVE. `game.grade` absent means no edit, which is what every
// record written before today says.

export const NEUTRAL = { brightness: 100, contrast: 100, saturate: 100, temp: 0 };

// A lift, not a look: enough to cut through arena lighting without turning
// white ice grey-blue.
export const ENHANCE = { brightness: 104, contrast: 112, saturate: 115, temp: 4 };

export const FULL_CROP = { x: 0, y: 0, w: 1, h: 1 };

export const emptyGrade = () => ({
  crop: { ...FULL_CROP },
  color: { ...NEUTRAL },
  patches: [],
  trim: null,          // { in, out } - a view window, never a cut
});

// A grade that would change nothing is stored as nothing, so a game that has
// been opened in the editor and left alone is byte-identical to one that has
// not.
export function isNeutral(g) {
  if (!g) return true;
  const c = g.crop || FULL_CROP;
  const cropped = c.x !== 0 || c.y !== 0 || c.w !== 1 || c.h !== 1;
  const col = g.color || NEUTRAL;
  const coloured = Object.keys(NEUTRAL).some((k) => (col[k] ?? NEUTRAL[k]) !== NEUTRAL[k]);
  return !cropped && !coloured && !(g.patches || []).length && !g.trim;
}

export function normalizeGrade(g) {
  if (!g) return null;
  return {
    ...emptyGrade(),
    ...g,
    crop: { ...FULL_CROP, ...(g.crop || {}) },
    color: { ...NEUTRAL, ...(g.color || {}) },
    patches: (g.patches || []).map((p) => ({ blur: false, ...p })),
  };
}

// ------------------------------------------------------------------ colour
//
// ONE FILTER STRING drives the live preview, the frozen frame and the export.
// Three code paths would drift; one cannot.

export function filterString(c = NEUTRAL) {
  const p = [];
  if (c.brightness !== 100) p.push(`brightness(${c.brightness}%)`);
  if (c.contrast !== 100) p.push(`contrast(${c.contrast}%)`);
  if (c.saturate !== 100) p.push(`saturate(${c.saturate}%)`);
  // Temperature is faked with sepia plus a hue turn - warm adds sepia and
  // pulls back toward orange, cool rotates toward blue. A real white balance
  // needs per-channel gain, which CSS filters do not expose.
  if (c.temp > 0) p.push(`sepia(${c.temp}%) saturate(${100 + c.temp}%)`);
  if (c.temp < 0) p.push(`hue-rotate(${c.temp * 0.6}deg) saturate(${100 - c.temp * 0.3}%)`);
  return p.length ? p.join(' ') : 'none';
}

// ------------------------------------------------------------------ patches
//
// Painted in OUTPUT pixels, after the frame is drawn and after the filter has
// been cleared, so a blur box blurs the picture rather than the picture plus
// its own edge.

export function paintPatches(ctx, cv, patches) {
  for (const p of patches || []) {
    const x = p.x * cv.width;
    const y = p.y * cv.height;
    const w = p.w * cv.width;
    const h = p.h * cv.height;
    if (p.blur) {
      ctx.save();
      ctx.beginPath();
      ctx.rect(x, y, w, h);
      ctx.clip();
      ctx.filter = `blur(${Math.max(6, Math.round(w * 0.08))}px)`;
      ctx.drawImage(cv, 0, 0);
      ctx.restore();
    } else {
      ctx.fillStyle = '#000';
      ctx.fillRect(x, y, w, h);
    }
  }
}

// --------------------------------------------------------------- the three
//                                                                  consumers

/** Live playback. The crop is an `object-view-box` inset, NOT a transform.
 *
 *  THE FIRST VERSION USED A TRANSFORM AND IT WAS WRONG TWICE. The player
 *  already has exactly one transform - `--vz`, the stage zoom - and every
 *  picture layer shares it; setting `transform` inline on the video beat that
 *  rule and broke zoom. And a transform on the video does nothing for the
 *  SCRUB OVERLAY, the canvas the decoder paints onto during a gesture, so the
 *  picture flipped between graded and ungraded as it played.
 *
 *  `object-view-box` crops a replaced element's own source box, so it touches
 *  no transform, needs no origin, and applies identically to a <video> and to
 *  a <canvas>. Both layers now inherit the same two custom properties. */
export function gradeCss(g) {
  const gr = normalizeGrade(g);
  if (!gr) return { filter: 'none', viewBox: 'none' };
  const c = gr.crop;
  const cropped = c.x !== 0 || c.y !== 0 || c.w !== 1 || c.h !== 1;
  const pc = (n) => `${(n * 100).toFixed(4)}%`;
  return {
    filter: filterString(gr.color),
    // inset(top right bottom left), measured in from each edge.
    viewBox: cropped
      ? `inset(${pc(c.y)} ${pc(1 - (c.x + c.w))} ${pc(1 - (c.y + c.h))} ${pc(c.x)})`
      : 'none',
  };
}

/** Exports: the options `recordRange` already understands. */
export function gradeForRecord(g) {
  const gr = normalizeGrade(g);
  if (!gr) return {};
  return {
    crop: gr.crop,
    filter: filterString(gr.color),
    paint: gr.patches.length ? (ctx, cv) => paintPatches(ctx, cv, gr.patches) : null,
  };
}

/** A frozen frame: return a NEW canvas carrying the graded picture, so the
 *  annotation editor draws on what the coach can see. */
export function gradeFrame(src, g) {
  const gr = normalizeGrade(g);
  if (!gr || isNeutral(gr)) return src;
  const c = gr.crop;
  const sx = c.x * src.width;
  const sy = c.y * src.height;
  const sw = c.w * src.width;
  const sh = c.h * src.height;
  const out = document.createElement('canvas');
  out.width = Math.max(2, Math.round(sw));
  out.height = Math.max(2, Math.round(sh));
  const ctx = out.getContext('2d');
  ctx.filter = filterString(gr.color);
  ctx.drawImage(src, sx, sy, sw, sh, 0, 0, out.width, out.height);
  ctx.filter = 'none';
  paintPatches(ctx, out, gr.patches);
  return out;
}

// -------------------------------------------------------------- composing
//
// Two export paths already pass a crop and a paint of their own - Record has
// a region rectangle, Freeze has the annotation drawings - so the grade has
// to COMPOSE with them rather than replace them.

/** `inner` is expressed in `outer`'s coordinate space; the result is in the
 *  full frame's. Record's region is chosen on the graded picture, so this is
 *  the order that makes the region land where it was drawn. */
export function composeCrop(outer, inner) {
  const o = { ...FULL_CROP, ...(outer || {}) };
  const i = { ...FULL_CROP, ...(inner || {}) };
  return {
    x: o.x + i.x * o.w,
    y: o.y + i.y * o.h,
    w: o.w * i.w,
    h: o.h * i.h,
  };
}

/** Fold a grade into the options `recordRange` takes, preserving whatever the
 *  caller already set. Patches are REMAPPED into the final output rectangle:
 *  they are stored as full-frame fractions, and the canvas being painted is
 *  the cropped region, so an unmapped patch would sit in the wrong place the
 *  moment a crop or a record region is in play. */
export function mergeRecordOpts(grade, opts = {}) {
  const gr = normalizeGrade(grade);
  if (!gr || isNeutral(gr)) return opts;
  const crop = composeCrop(gr.crop, opts.crop);
  const mapped = gr.patches.map((p) => ({
    ...p,
    x: (p.x - crop.x) / crop.w,
    y: (p.y - crop.y) / crop.h,
    w: p.w / crop.w,
    h: p.h / crop.h,
  })).filter((p) => p.x + p.w > 0 && p.y + p.h > 0 && p.x < 1 && p.y < 1);
  const theirs = opts.paint;
  return {
    ...opts,
    crop,
    filter: filterString(gr.color),
    // Grade patches go down FIRST, so an annotation drawn over a covered
    // watermark still reads on top of it.
    paint: (ctx, cv, info) => {
      if (mapped.length) paintPatches(ctx, cv, mapped);
      theirs?.(ctx, cv, info);
    },
  };
}
