// THE TIME MAP - the one idea the whole app turns on.
//
// A finished analysis video is not the source clip. It is the source clip with
// time bent: trimmed at both ends, frozen where a point is being made, slowed
// where the detail lives, and sometimes cut in the middle. Everything else in
// Studio - the player, the scrub, the annotation clock, the exporter - reads
// the picture through ONE function, `sourceAt(outT)`, so there is exactly one
// place that knows how output time relates to source time.
//
// WHY IT IS A PURE MODULE: the exporter runs this thousands of times with no
// DOM anywhere, and `tests/studio-timemap.html` runs it with no app at all. If
// a bug ever puts the annotation clock and the exported frame out of step, it
// is in here, and it is findable.
//
// A project's `timeline` is `{ in, out, ops }` where ops are anchored in
// SOURCE seconds and sorted. Three kinds, all additive - a reader that does
// not know a kind must skip it rather than guess:
//
//   { kind: 'hold', at, dur }        freeze at `at` for `dur` OUTPUT seconds
//   { kind: 'rate', from, to, rate } play [from,to) at `rate` (0.25 = quarter)
//   { kind: 'cut',  from, to }       remove [from,to) from the source entirely
//
// Ops never overlap; `normalizeOps` is what guarantees that, and every mutation
// goes through it. Out of that falls a list of SPANS, which is the compiled
// form everything reads:
//
//   { o0, o1, s0, s1, kind, rate, op }
//
// covering output time end to end with no gaps.

export const MIN_RATE = 0.05;
export const MAX_RATE = 8;

const clamp = (v, lo, hi) => (v < lo ? lo : v > hi ? hi : v);
const near = (a, b, eps = 1e-6) => Math.abs(a - b) < eps;

// ---- op normalisation ------------------------------------------------------

// Sort, clamp into [in,out], drop the degenerate, and resolve overlaps by
// letting the EARLIER op win the contested ground. Holds are points and never
// conflict with each other; a rate and a cut that overlap are trimmed.
export function normalizeOps(ops, tIn, tOut) {
  const lo = Math.min(tIn, tOut);
  const hi = Math.max(tIn, tOut);
  const holds = [];
  const ranges = [];

  for (const raw of ops || []) {
    if (!raw || typeof raw !== 'object') continue;
    if (raw.kind === 'hold') {
      const at = clamp(Number(raw.at) || 0, lo, hi);
      const dur = Math.max(0, Number(raw.dur) || 0);
      if (dur <= 0) continue;
      holds.push({ ...raw, kind: 'hold', at, dur });
    } else if (raw.kind === 'rate' || raw.kind === 'cut') {
      let from = clamp(Number(raw.from) || 0, lo, hi);
      let to = clamp(Number(raw.to) || 0, lo, hi);
      if (to < from) { const t = from; from = to; to = t; }
      if (near(from, to)) continue;
      const op = { ...raw, from, to };
      if (raw.kind === 'rate') {
        op.rate = clamp(Number(raw.rate) || 1, MIN_RATE, MAX_RATE);
        if (near(op.rate, 1)) continue; // a rate of 1 is not an effect
      }
      ranges.push(op);
    }
  }

  ranges.sort((a, b) => a.from - b.from || a.to - b.to);
  const kept = [];
  let edge = lo;
  for (const op of ranges) {
    const from = Math.max(op.from, edge);
    if (from >= op.to - 1e-6) continue; // fully swallowed by an earlier op
    kept.push({ ...op, from });
    edge = op.to;
  }

  holds.sort((a, b) => a.at - b.at);
  return { holds, ranges: kept };
}

// ---- compilation -----------------------------------------------------------

// Walk the source once, emitting spans in output order. A hold is emitted as a
// zero-source-width span at the moment it sits on, which is exactly what makes
// a freeze fall out of the same machinery as everything else: `sourceAt` in a
// hold span returns a constant.
export function compile(timeline, duration = 0) {
  const dur = Math.max(0, Number(duration) || 0);
  const tIn = clamp(Number(timeline?.in) || 0, 0, dur || Infinity);
  const rawOut = timeline?.out == null ? dur : Number(timeline.out);
  const tOut = clamp(rawOut, tIn, dur || Infinity);

  const { holds, ranges } = normalizeOps(timeline?.ops, tIn, tOut);
  const spans = [];
  let s = tIn;
  let o = 0;
  let hi = 0;
  let ri = 0;

  const emitPlain = (s0, s1) => {
    if (s1 - s0 <= 1e-9) return;
    const d = s1 - s0;
    spans.push({ o0: o, o1: o + d, s0, s1, kind: 'play', rate: 1, op: null });
    o += d;
  };
  const emitHold = (at, d) => {
    spans.push({ o0: o, o1: o + d, s0: at, s1: at, kind: 'hold', rate: 0, op: holds[hi] });
    o += d;
  };

  // Holds that sit exactly on the in point fire before any picture rolls.
  while (hi < holds.length && holds[hi].at <= s + 1e-9) { emitHold(holds[hi].at, holds[hi].dur); hi++; }

  while (s < tOut - 1e-9) {
    const nextRange = ranges[ri] || null;
    const nextHold = hi < holds.length ? holds[hi].at : Infinity;
    // The next thing that interrupts plain playback.
    const stop = Math.min(nextRange ? nextRange.from : Infinity, nextHold, tOut);

    if (stop > s + 1e-9) { emitPlain(s, stop); s = stop; continue; }

    if (nextHold <= s + 1e-9) { emitHold(holds[hi].at, holds[hi].dur); hi++; continue; }

    // A range starts here.
    const op = nextRange;
    if (op.kind === 'cut') {
      s = op.to;
      // Holds inside a cut are gone with it.
      while (hi < holds.length && holds[hi].at < s - 1e-9) hi++;
      ri++;
      continue;
    }
    // A rate span. Holds inside it still fire, splitting it.
    let cur = op.from;
    while (cur < op.to - 1e-9) {
      const h = hi < holds.length && holds[hi].at < op.to ? holds[hi].at : Infinity;
      const seg = Math.min(h, op.to);
      if (seg > cur + 1e-9) {
        const d = (seg - cur) / op.rate;
        spans.push({ o0: o, o1: o + d, s0: cur, s1: seg, kind: 'rate', rate: op.rate, op });
        o += d;
        cur = seg;
      }
      if (h < op.to) { emitHold(holds[hi].at, holds[hi].dur); hi++; } else break;
    }
    s = op.to;
    ri++;
  }

  // Trailing holds parked on the out point.
  while (hi < holds.length && holds[hi].at <= tOut + 1e-9) { emitHold(holds[hi].at, holds[hi].dur); hi++; }

  if (!spans.length) spans.push({ o0: 0, o1: 0, s0: tIn, s1: tIn, kind: 'play', rate: 1, op: null });
  return { spans, duration: o, in: tIn, out: tOut };
}

// ---- lookups ---------------------------------------------------------------

function spanAt(map, outT) {
  const spans = map.spans;
  let lo = 0;
  let hi = spans.length - 1;
  const t = clamp(outT, 0, map.duration);
  while (lo < hi) {
    const mid = (lo + hi) >> 1;
    if (t < spans[mid].o1 - 1e-9) hi = mid; else lo = mid + 1;
  }
  return spans[lo];
}

// Output seconds -> source seconds. The function everything else calls.
export function sourceAt(map, outT) {
  const sp = spanAt(map, outT);
  if (!sp) return 0;
  if (sp.kind === 'hold') return sp.s0;
  const span = sp.o1 - sp.o0;
  if (span <= 1e-9) return sp.s0;
  const f = clamp((outT - sp.o0) / span, 0, 1);
  return sp.s0 + (sp.s1 - sp.s0) * f;
}

// Source seconds -> output seconds. Ambiguous by nature: a frozen frame owns a
// whole stretch of output. We answer with the FIRST output moment showing it,
// which is what "scroll the timeline to this frame" wants.
export function outputAt(map, srcT) {
  const t = Number(srcT) || 0;
  for (const sp of map.spans) {
    const lo = Math.min(sp.s0, sp.s1);
    const hi = Math.max(sp.s0, sp.s1);
    if (t < lo - 1e-9) return sp.o0;
    if (t <= hi + 1e-9) {
      if (sp.kind === 'hold' || hi - lo <= 1e-9) return sp.o0;
      return sp.o0 + ((t - sp.s0) / (sp.s1 - sp.s0)) * (sp.o1 - sp.o0);
    }
  }
  return map.duration;
}

// How fast the picture is moving at this output moment: 0 in a freeze, 0.25 in
// a quarter-speed ramp, 1 in plain play. The player uses it to set
// `playbackRate`; the exporter uses it to retime audio.
export function rateAt(map, outT) {
  const sp = spanAt(map, outT);
  if (!sp) return 1;
  return sp.kind === 'hold' ? 0 : sp.rate;
}

// Is this output moment inside a freeze? The editor lights the Freeze button
// and parks the decoder when it is.
export function holdAt(map, outT) {
  const sp = spanAt(map, outT);
  return sp && sp.kind === 'hold' ? sp : null;
}

// ---- editing helpers -------------------------------------------------------

// Add a freeze at a source moment, merging with one already there rather than
// stacking two holds on the same frame.
export function addHold(timeline, at, dur = 1.6) {
  const ops = [...(timeline.ops || [])];
  const i = ops.findIndex((o) => o.kind === 'hold' && Math.abs(o.at - at) < 0.04);
  if (i >= 0) ops[i] = { ...ops[i], dur: Math.max(0.1, ops[i].dur + dur) };
  else ops.push({ kind: 'hold', at, dur, id: uid() });
  return { ...timeline, ops };
}

export function addRate(timeline, from, to, rate) {
  const ops = [...(timeline.ops || [])].filter(
    (o) => !(o.kind === 'rate' && o.from < to - 1e-6 && o.to > from + 1e-6),
  );
  ops.push({ kind: 'rate', from, to, rate, id: uid() });
  return { ...timeline, ops };
}

export function addCut(timeline, from, to) {
  const ops = [...(timeline.ops || []), { kind: 'cut', from, to, id: uid() }];
  return { ...timeline, ops };
}

export function removeOp(timeline, id) {
  return { ...timeline, ops: (timeline.ops || []).filter((o) => o.id !== id) };
}

export function updateOp(timeline, id, patch) {
  return { ...timeline, ops: (timeline.ops || []).map((o) => (o.id === id ? { ...o, ...patch } : o)) };
}

let seq = 0;
export function uid() {
  seq += 1;
  return `${Date.now().toString(36)}${seq.toString(36)}`;
}
