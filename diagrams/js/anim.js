// CTH Diagrams - the drill animator (2026-08-27).
//
// One button turns the diagram that is already drawn into a smooth animated
// drill - no extra authoring. The intelligence is in reading what a coach
// already draws:
//
//   - Each RINK of a sequence is a PHASE. Within a phase, every arrow moves
//     something: a skating arrow moves the nearest player from its tail, a
//     pass (dashed) or shot moves a puck, Skate With Puck carries the puck
//     on the player's stick.
//   - TIMING IS CHAINED, not drawn: an arrow whose tail sits near another
//     arrow's head waits for it (skate then pass, pass then shot, give and
//     go). Everything else runs concurrently. Speeds are per motion type -
//     a shot flies, a backward skate grinds.
//   - BETWEEN RINKS the matched objects (players by label and colour, the
//     puck) glide from where phase k left them to where rink k+1 draws
//     them, so a 3-rink drawing plays as one continuous drill.
//
// Rendering reuses drawEl() from flat.js - the animation is pixel-identical
// to the exported PNG. Exports: an animated GIF (own encoder below, no
// libraries) and a WebM video, both saved into the CTH folder's /diagrams
// through localfs, with a download fallback. Nothing is stored on the
// diagram: press Animate again after any edit and the new sequence plays.

import { RINK_H, SEQ_GAP, composeRinkBg, loadImg } from './rink.js';
import { drawEl, colorOf, arrowLength, arrowPointAt, arrowPathPoints } from './flat.js';
import { toast, esc } from './ui.js';

const BAND = RINK_H + SEQ_GAP;

// Canvas units per second (3200 units = 200ft, so 16 u/ft). Tuned to read
// naturally at 1x: skating ~25 ft/s, a pass ~70, a shot ~100.
const SPEED = { skate: 400, backward: 290, puck: 355, pass: 1150, shoot: 1650 };
const MIN_DUR = 0.4;
const MAX_DUR = 4.5;
const CHAIN_R = 210;      // "tail near a head" distance for chaining
const GRAB_R = 320;       // "arrow tail near an object" pairing distance
const SETTLE = 0.55;      // hold at the end of each phase
const HANDOFF = 0.7;      // glide between rinks
const LEAD_IN = 0.5;      // hold on the opening picture

const easeInOut = (t) => (t < 0.5 ? 2 * t * t : 1 - ((-2 * t + 2) ** 2) / 2);
const easeOut = (t) => 1 - (1 - t) ** 2;

const SETTINGS_KEY = 'cthd.anim.v1';
const animSettings = () => {
  try { return { speed: 1, size: 960, fps: 15, paths: true, ...JSON.parse(localStorage.getItem(SETTINGS_KEY) || '{}') }; }
  catch (_) { return { speed: 1, size: 960, fps: 15, paths: true }; }
};
const saveAnimSettings = (patch) => {
  try { localStorage.setItem(SETTINGS_KEY, JSON.stringify({ ...animSettings(), ...patch })); } catch (_) {}
};

// ------------------------------------------------------------- timeline

const centerOf = (x) => {
  if (x.type === 'player') return { x: x.x, y: x.y };
  if (x.type === 'arrow') return { x: x.x1, y: x.y1 };
  if (x.type === 'pen') return { x: x.pts?.[0]?.[0] || 0, y: x.pts?.[0]?.[1] || 0 };
  if (x.type === 'text') return { x: x.x, y: x.y };
  return { x: (x.x || 0) + (x.w || 0) / 2, y: (x.y || 0) + (x.h || 0) / 2 };
};

const isPuckEl = (x) => x.type === 'pucks' || (x.type === 'stamp' && /puck/i.test(x.file || ''));
const dist = (a, b) => Math.hypot(a.x - b.x, a.y - b.y);

// A localized copy of an element, shifted into rink-local coordinates.
function localize(x, dy) {
  const c = { ...x };
  if (c.type === 'arrow') { c.y1 -= dy; c.y2 -= dy; c.my -= dy; }
  else if (c.type === 'pen') c.pts = (c.pts || []).map(([px, py]) => [px, py - dy]);
  else c.y = (c.y || 0) - dy;
  return c;
}

function moverPos(el) { return centerOf(el); }
function placeAt(el, x, y) {
  const c = { ...el };
  if (c.type === 'player' || c.type === 'text') { c.x = x; c.y = y; }
  else { c.x = x - (c.w || 0) / 2; c.y = y - (c.h || 0) / 2; }
  return c;
}

// The synthetic puck: drills rarely draw one, but a pass with nothing to
// send is a dead animation, so the animator conjures a standard puck dot.
let puckSeq = 0;
const syntheticPuck = () => ({ id: `anim-puck-${puckSeq++}`, type: 'pucks', x: 0, y: 0, w: 34, h: 34, color: 'black', count: 1 });

export function buildTimeline(state) {
  const onRink = !state.bg;
  const seq = onRink ? (state.seq || 1) : 1;
  const bandH = onRink ? RINK_H : (state.h || RINK_H);
  const bandW = onRink ? 3200 : (state.w || 3200);

  // Split elements into per-rink frames, localized.
  const frames = Array.from({ length: seq }, () => []);
  for (const el of state.elements || []) {
    const k = onRink ? Math.max(0, Math.min(seq - 1, Math.floor(centerOf(el).y / BAND))) : 0;
    frames[k].push(localize(el, onRink ? k * BAND : 0));
  }

  const phases = frames.map((els) => {
    const arrows = els.filter((x) => x.type === 'arrow');
    const others = els.filter((x) => x.type !== 'arrow');
    const players = others.filter((x) => x.type === 'player');
    const pucks = others.filter(isPuckEl);
    const claimed = new Set();
    const claimedPuck = new Set();

    // Pair each arrow with what it moves.
    const moves = arrows.map((a) => {
      const start = { x: a.x1, y: a.y1 };
      const motion = a.dash ? 'pass' : (a.motion || 'skate');
      const movesPuck = motion === 'pass' || motion === 'shoot';
      let subject = null;
      const pool = movesPuck ? pucks.filter((p) => !claimedPuck.has(p.id)) : players.filter((p) => !claimed.has(p.id));
      let best = Infinity;
      for (const p of pool) {
        const d = dist(moverPos(p), start);
        if (d < best && d < GRAB_R) { best = d; subject = p; }
      }
      if (subject) (movesPuck ? claimedPuck : claimed).add(subject.id);
      if (!subject && movesPuck) subject = syntheticPuck();
      if (!subject) return null;
      // A carried puck rides along: nearest unclaimed puck, or a conjured one.
      let carried = null;
      if (motion === 'puck') {
        let bd = Infinity;
        for (const p of pucks) {
          if (claimedPuck.has(p.id)) continue;
          const d = dist(moverPos(p), start);
          if (d < bd && d < GRAB_R) { bd = d; carried = p; }
        }
        if (carried) claimedPuck.add(carried.id);
        else carried = syntheticPuck();
      }
      const dur = Math.max(MIN_DUR, Math.min(MAX_DUR, arrowLength(a) / (SPEED[motion] || SPEED.skate)));
      return { arrow: a, motion, subject, carried, dur, delay: 0 };
    }).filter(Boolean);

    // THE PUCK FLOWS THROUGH THE CHAIN: a pass or shot that had to conjure
    // a puck first looks for one arriving at its tail - the puck a player
    // just carried in, or one a previous pass delivered - and sends THAT
    // instead, so a carry-pass-shoot sequence is one puck, not three.
    for (const m of moves) {
      if (!(m.motion === 'pass' || m.motion === 'shoot')) continue;
      if (m.subject && !String(m.subject.id).startsWith('anim-puck')) continue;
      for (const o of moves) {
        if (o === m) continue;
        if (dist({ x: o.arrow.x2, y: o.arrow.y2 }, { x: m.arrow.x1, y: m.arrow.y1 }) >= CHAIN_R) continue;
        const incoming = o.carried || (o.subject && isPuckEl(o.subject) ? o.subject : null);
        if (incoming) { m.subject = incoming; break; }
      }
    }

    // Chain: an arrow whose tail sits near another's head starts after it.
    for (let pass = 0; pass < moves.length; pass++) {
      let changed = false;
      for (const m of moves) {
        for (const o of moves) {
          if (o === m) continue;
          if (dist({ x: o.arrow.x2, y: o.arrow.y2 }, { x: m.arrow.x1, y: m.arrow.y1 }) < CHAIN_R) {
            const need = o.delay + o.dur;
            if (m.delay < need) { m.delay = need; changed = true; }
          }
        }
      }
      if (!changed) break;
    }

    const movedIds = new Set(moves.flatMap((m) => [m.subject?.id, m.carried?.id]).filter(Boolean));
    const statics = others.filter((x) => !movedIds.has(x.id));
    const span = moves.length ? Math.max(...moves.map((m) => m.delay + m.dur)) : 0.8;
    return { arrows, moves, statics, others, span: span + SETTLE, bandH, bandW };
  });

  // End-of-phase positions, then the glide into the next rink's drawing.
  const segments = [];
  let t = LEAD_IN;
  segments.push({ kind: 'hold', phase: 0, from: 0, len: LEAD_IN });
  phases.forEach((ph, k) => {
    segments.push({ kind: 'play', phase: k, from: t, len: ph.span });
    t += ph.span;
    if (k < phases.length - 1) {
      segments.push({ kind: 'handoff', phase: k, from: t, len: HANDOFF });
      t += HANDOFF;
    }
  });
  const hasMotion = phases.some((p) => p.moves.length);
  return { phases, segments, total: t, bandH, bandW, onRink, hasMotion };
}

// Where every mover of phase k ends up when the phase finishes.
function phaseEndState(ph) {
  const out = new Map();
  for (const m of [...ph.moves].sort((a, b) => a.delay - b.delay)) {
    const end = arrowPointAt(m.arrow, 1);
    if (m.subject) out.set(m.subject.id, { el: m.subject, x: end.x, y: end.y });
    if (m.carried) out.set(m.carried.id, { el: m.carried, x: end.x, y: end.y });
  }
  return out;
}

const playerKey = (p) => `p:${(p.label || '').toLowerCase()}|${p.color}`;

// ------------------------------------------------------------- painting

export function makePainter(tl, opts = {}) {
  const bg = tl.onRink ? composeRinkBg(1) : null;
  let customBg = null;
  const ready = tl.onRink ? Promise.resolve() : loadImg(opts.bgUrl).then((img) => { customBg = img; });

  function drawGuides(ctx, ph, alpha) {
    if (!opts.paths || !alpha) return;
    ctx.save();
    ctx.globalAlpha = alpha;
    for (const a of ph.arrows) drawEl(ctx, a);
    ctx.restore();
  }

  // The travelled part of an active arrow, drawn as a solid trail.
  function drawTrail(ctx, m, frac) {
    if (frac <= 0.02) return;
    const pts = arrowPathPoints(m.arrow, 0, 64);
    const upto = Math.max(2, Math.round(pts.length * frac));
    ctx.save();
    ctx.globalAlpha = 0.5;
    ctx.strokeStyle = colorOf(m.arrow.color);
    ctx.lineWidth = (m.arrow.width || 8) * 0.9;
    ctx.lineCap = 'round';
    if (m.motion === 'pass') ctx.setLineDash([(m.arrow.width || 8) * 2.4, (m.arrow.width || 8) * 2]);
    ctx.beginPath();
    pts.slice(0, upto).forEach(([px, py], i) => (i ? ctx.lineTo(px, py) : ctx.moveTo(px, py)));
    ctx.stroke();
    ctx.restore();
  }

  function drawPhaseAt(ctx, k, sec) {
    const ph = tl.phases[k];
    drawGuides(ctx, ph, 0.22);
    for (const el of ph.statics) drawEl(ctx, el);
    // An element can ride several moves in one phase (carried in, then
    // passed on). Resolve ONE position per element: the latest move that
    // has started owns it; before anything starts, the first one does.
    const spots = new Map();
    const put = (el, x, y, order) => {
      const prev = spots.get(el.id);
      if (!prev || order >= prev.order) spots.set(el.id, { el, x, y, order });
    };
    const sorted = [...ph.moves].sort((a, b) => a.delay - b.delay);
    for (const m of sorted) {
      const local = Math.max(0, Math.min(1, (sec - m.delay) / m.dur));
      const eased = (m.motion === 'pass' || m.motion === 'shoot') ? easeOut(local) : easeInOut(local);
      const p = arrowPointAt(m.arrow, eased);
      drawTrail(ctx, m, eased);
      const started = sec >= m.delay;
      const order = started ? m.delay + 1e4 : m.delay;
      if (m.subject) put(m.subject, p.x, p.y, order);
      if (m.carried) {
        const r = (m.subject && m.subject.type === 'player' ? m.subject.r || 52 : 40) + 26;
        put(m.carried, p.x + Math.cos(p.ang) * r, p.y + Math.sin(p.ang) * r, order);
      }
    }
    for (const [, sp] of spots) drawEl(ctx, placeAt(sp.el, sp.x, sp.y));
  }

  function drawHandoff(ctx, k, frac) {
    const from = tl.phases[k];
    const to = tl.phases[k + 1];
    const endState = phaseEndState(from);
    // Where each mover STARTS in the next rink, matched by identity.
    const startOf = new Map();
    const usedTo = new Set();
    const claim = (fromEl, candidates) => {
      let best = null; let bd = Infinity;
      const fromEnd = endState.get(fromEl.id);
      for (const c of candidates) {
        if (usedTo.has(c.id)) continue;
        const d = fromEnd ? dist(moverPos(c), fromEnd) : 0;
        if (d < bd) { bd = d; best = c; }
      }
      if (best) usedTo.add(best.id);
      return best;
    };
    const toPlayers = to.others.filter((x) => x.type === 'player');
    const toPucks = to.others.filter(isPuckEl);
    const pairs = [];
    for (const [, st] of endState) {
      const el = st.el;
      let target = null;
      if (el.type === 'player') {
        target = claim(el, toPlayers.filter((p) => playerKey(p) === playerKey(el))) || claim(el, toPlayers);
      } else if (isPuckEl(el)) {
        target = claim(el, toPucks);
      }
      if (target) pairs.push({ el, from: st, to: moverPos(target), targetId: target.id });
    }
    const e = easeInOut(frac);
    // The next rink's picture fades in beneath the gliding objects.
    ctx.save();
    ctx.globalAlpha = 1 - e;
    for (const el of from.statics) drawEl(ctx, el);
    ctx.restore();
    ctx.save();
    ctx.globalAlpha = e;
    drawGuides(ctx, to, 0.22 * e);
    const carriedIds = new Set(pairs.map((p) => p.targetId));
    for (const el of to.others) if (!carriedIds.has(el.id)) drawEl(ctx, el);
    ctx.restore();
    for (const p of pairs) {
      drawEl(ctx, placeAt(p.el, p.from.x + (p.to.x - p.from.x) * e, p.from.y + (p.to.y - p.from.y) * e));
    }
  }

  function paint(ctx, t, scale) {
    ctx.save();
    ctx.scale(scale, scale);
    ctx.fillStyle = '#ffffff';
    ctx.fillRect(0, 0, tl.bandW, tl.bandH);
    const art = tl.onRink ? bg : customBg;
    if (art) ctx.drawImage(art, 0, 0, tl.bandW, tl.bandH);
    let seg = tl.segments[tl.segments.length - 1];
    for (const sg of tl.segments) if (t < sg.from + sg.len) { seg = sg; break; }
    if (seg.kind === 'handoff') drawHandoff(ctx, seg.phase, (t - seg.from) / seg.len);
    else if (seg.kind === 'hold') drawPhaseAt(ctx, seg.phase, 0);
    else drawPhaseAt(ctx, seg.phase, Math.min(t - seg.from, tl.phases[seg.phase].span));
    // The rink's name, when the sequence carries one.
    const name = opts.rinkNames?.[seg.phase >= 0 ? seg.phase : 0];
    if (name && name.trim()) {
      ctx.font = '600 54px Inter, sans-serif';
      ctx.fillStyle = 'rgba(30,30,30,0.55)';
      ctx.textAlign = 'left';
      ctx.textBaseline = 'top';
      ctx.fillText(name.trim(), 56, 40);
    }
    ctx.restore();
  }

  return { paint, ready };
}

// ------------------------------------------------------------- GIF encoder
//
// A minimal, dependency-free GIF89a writer: one global 256-colour table
// (the 216-value colour cube plus a 39-step grey ramp - flat drill art and
// the rink's antialiasing both survive it), standard LZW, infinite loop.

function buildPalette() {
  const pal = new Uint8Array(256 * 3);
  let i = 0;
  for (let r = 0; r < 6; r++) for (let g = 0; g < 6; g++) for (let b = 0; b < 6; b++) {
    pal[i * 3] = r * 51; pal[i * 3 + 1] = g * 51; pal[i * 3 + 2] = b * 51; i++;
  }
  for (let g = 0; g < 39; g++) {
    const v = Math.round(6.5 + g * 6.35);
    pal[i * 3] = v; pal[i * 3 + 1] = v; pal[i * 3 + 2] = v; i++;
  }
  pal[255 * 3] = 255; pal[255 * 3 + 1] = 255; pal[255 * 3 + 2] = 255;
  return pal;
}

function quantize(data, out) {
  for (let p = 0, q = 0; q < out.length; p += 4, q++) {
    const r = data[p]; const g = data[p + 1]; const b = data[p + 2];
    const mx = Math.max(r, g, b); const mn = Math.min(r, g, b);
    if (mx - mn < 12) {
      // A grey: the ramp holds far more steps than the cube's six.
      const v = (r + g + b) / 3;
      if (v > 250) { out[q] = 255; continue; }
      out[q] = 216 + Math.max(0, Math.min(38, Math.round((v - 6.5) / 6.35)));
    } else {
      out[q] = 36 * Math.round(r / 51) + 6 * Math.round(g / 51) + Math.round(b / 51);
    }
  }
}

function lzwEncode(indices, minCode, push) {
  const CLEAR = 1 << minCode;
  const EOI = CLEAR + 1;
  let dictSize = EOI + 1;
  let codeLen = minCode + 1;
  let dict = new Map();
  let acc = 0; let accBits = 0;
  const emit = (code) => {
    acc |= code << accBits;
    accBits += codeLen;
    while (accBits >= 8) { push(acc & 255); acc >>= 8; accBits -= 8; }
  };
  emit(CLEAR);
  let cur = indices[0];
  for (let i = 1; i < indices.length; i++) {
    const nxt = indices[i];
    const key = (cur << 8) | nxt;
    const hit = dict.get(key);
    if (hit !== undefined) { cur = hit; continue; }
    emit(cur);
    dict.set(key, dictSize++);
    if (dictSize === (1 << codeLen) + 1 && codeLen < 12) codeLen++;
    if (dictSize >= 4096) {
      emit(CLEAR);
      dict = new Map();
      dictSize = EOI + 1;
      codeLen = minCode + 1;
    }
    cur = nxt;
  }
  emit(cur);
  emit(EOI);
  if (accBits > 0) push(acc & 255);
}

export function encodeGif(framesIdx, w, h, delayCs, pal) {
  const bytes = [];
  const push = (b) => bytes.push(b);
  const pushStr = (s) => { for (const ch of s) push(ch.charCodeAt(0)); };
  const push16 = (v) => { push(v & 255); push((v >> 8) & 255); };
  pushStr('GIF89a');
  push16(w); push16(h);
  push(0xF7); push(0); push(0);              // global table, 256 colours
  for (const v of pal) push(v);
  pushStr('!'); push(0xFF); push(11); pushStr('NETSCAPE2.0');
  push(3); push(1); push16(0); push(0);      // loop forever
  for (const idx of framesIdx) {
    pushStr('!'); push(0xF9); push(4); push(0); push16(delayCs); push(0); push(0);
    pushStr(','); push16(0); push16(0); push16(w); push16(h); push(0);
    push(8);                                  // LZW min code size
    const sub = [];
    lzwEncode(idx, 8, (b) => {
      sub.push(b);
      if (sub.length === 255) { push(255); for (const x of sub) push(x); sub.length = 0; }
    });
    if (sub.length) { push(sub.length); for (const x of sub) push(x); }
    push(0);
  }
  pushStr(';');
  return new Uint8Array(bytes);
}

// ------------------------------------------------------------- the overlay

let veil = null;

export async function openAnimator({ state, name, rinkNames }) {
  if (veil) { veil.remove(); veil = null; }
  const tl = buildTimeline(state);
  if (!tl.hasMotion) {
    toast('Nothing To Animate Yet - Draw Arrows From Your Players And Pucks First', true);
    return;
  }
  const s = animSettings();
  const painter = makePainter(tl, { paths: s.paths, rinkNames, bgUrl: state.bg || null });
  await painter.ready;

  veil = document.createElement('div');
  veil.className = 'anim-veil';
  const ratio = tl.bandH / tl.bandW;
  veil.innerHTML = `
    <div class="anim-panel" role="dialog" aria-modal="true" aria-label="Drill Animation">
      <div class="anim-stage"><canvas class="anim-canvas"></canvas></div>
      <div class="anim-bar">
        <button class="tb-btn anim-play" data-a="play" aria-label="Play Or Pause">
          <svg class="anim-ic-pause" viewBox="0 0 24 24" fill="currentColor"><rect x="6" y="5" width="4" height="14" rx="1.2"/><rect x="14" y="5" width="4" height="14" rx="1.2"/></svg>
          <svg class="anim-ic-play" viewBox="0 0 24 24" fill="currentColor"><path d="M8 5.4v13.2a.8.8 0 0 0 1.22.68l10.34-6.6a.8.8 0 0 0 0-1.36L9.22 4.72A.8.8 0 0 0 8 5.4z"/></svg>
        </button>
        <input class="anim-scrub" type="range" min="0" max="1000" value="0" aria-label="Timeline">
        <span class="anim-clock">0.0s</span>
      </div>
      <div class="anim-opts">
        <label>Speed
          <select data-set="speed">${[0.75, 1, 1.25, 1.5].map((v) => `<option value="${v}"${s.speed === v ? ' selected' : ''}>${v}x</option>`).join('')}</select>
        </label>
        <label>Size
          <select data-set="size">${[720, 960, 1280].map((v) => `<option value="${v}"${s.size === v ? ' selected' : ''}>${v}px</option>`).join('')}</select>
        </label>
        <label>GIF Rate
          <select data-set="fps">${[12, 15, 20].map((v) => `<option value="${v}"${s.fps === v ? ' selected' : ''}>${v} fps</option>`).join('')}</select>
        </label>
        <label class="anim-check"><input type="checkbox" data-set="paths"${s.paths ? ' checked' : ''}> Show Routes</label>
        <span class="anim-flex"></span>
        <span class="anim-status" aria-live="polite"></span>
        <button class="btn" data-a="webm">Save Video</button>
        <button class="btn btn-ink" data-a="gif">Save GIF</button>
        <button class="btn" data-a="close">Close</button>
      </div>
    </div>`;
  document.body.appendChild(veil);

  const canvas = veil.querySelector('.anim-canvas');
  const ctx = canvas.getContext('2d');
  const scrub = veil.querySelector('.anim-scrub');
  const clock = veil.querySelector('.anim-clock');
  const status = veil.querySelector('.anim-status');
  const playBtn = veil.querySelector('.anim-play');
  const say = (msg) => { status.textContent = msg; };

  let opts = { ...s };
  let playing = true;
  let t = 0;
  let last = performance.now();
  let raf = 0;
  let busy = false;

  const fit = () => {
    const box = veil.querySelector('.anim-stage').getBoundingClientRect();
    const w = Math.min(box.width, box.height / ratio);
    canvas.width = Math.round(w * devicePixelRatio);
    canvas.height = Math.round(w * ratio * devicePixelRatio);
    canvas.style.width = `${Math.round(w)}px`;
  };
  fit();
  window.addEventListener('resize', fit);

  const repaint = () => {
    painter.paint(ctx, t, canvas.width / tl.bandW);
    scrub.value = String(Math.round((t / tl.total) * 1000));
    clock.textContent = `${t.toFixed(1)}s / ${tl.total.toFixed(1)}s`;
    playBtn.classList.toggle('paused', !playing);
  };
  const tick = (now) => {
    raf = requestAnimationFrame(tick);
    if (playing && !busy) {
      t += ((now - last) / 1000) * opts.speed;
      if (t >= tl.total) t = 0;
    }
    last = now;
    repaint();
  };
  raf = requestAnimationFrame(tick);

  const close = () => {
    cancelAnimationFrame(raf);
    window.removeEventListener('resize', fit);
    document.removeEventListener('keydown', onKey, true);
    veil.remove();
    veil = null;
  };
  const onKey = (e) => {
    if (e.key === 'Escape') { e.preventDefault(); e.stopPropagation(); if (!busy) close(); }
    if (e.key === ' ') { e.preventDefault(); e.stopPropagation(); playing = !playing; }
  };
  document.addEventListener('keydown', onKey, true);
  veil.addEventListener('mousedown', (e) => { if (e.target === veil && !busy) close(); });
  veil.querySelector('[data-a="close"]').onclick = () => { if (!busy) close(); };
  veil.querySelector('[data-a="play"]').onclick = () => { playing = !playing; };
  scrub.oninput = () => { playing = false; t = (Number(scrub.value) / 1000) * tl.total; };
  veil.querySelectorAll('[data-set]').forEach((el) => {
    el.onchange = () => {
      const key = el.dataset.set;
      const val = el.type === 'checkbox' ? el.checked : Number(el.value);
      opts[key] = val;
      saveAnimSettings({ [key]: val });
      if (key === 'paths') {
        // Rebuild the painter with routes on or off.
        Object.assign(painter, makePainter(tl, { paths: val, rinkNames, bgUrl: state.bg || null }));
      }
    };
  });

  const slug = (name || 'drill').toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '') || 'drill';

  // Save into the CTH folder when it is connected; download otherwise.
  async function deliver(blob, ext) {
    try {
      const fs = await import('../../clips/js/localfs.js');
      if (fs.fsSupported() && (fs.fsConnected() || fs.fsRemembered())) {
        if (!fs.fsConnected()) await fs.fsReconnect();
        const path = `${fs.DIAGRAM_ROOT}/${slug}-drill.${ext}`;
        await fs.fsWrite(path, blob);
        toast(`Saved To ${fs.fsLabel(path)} - Drag It Into Notion To Embed`);
        return;
      }
    } catch (e) { console.error(e); }
    const a = document.createElement('a');
    a.href = URL.createObjectURL(blob);
    a.download = `${slug}-drill.${ext}`;
    a.click();
    toast(`${ext.toUpperCase()} Downloaded`);
  }

  // ---- GIF: rendered offline frame by frame, then encoded ----------------
  veil.querySelector('[data-a="gif"]').onclick = async () => {
    if (busy) return;
    busy = true;
    playing = false;
    try {
      const fps = opts.fps;
      const w = Math.round(opts.size);
      const h = Math.round(w * ratio);
      const off = document.createElement('canvas');
      off.width = w; off.height = h;
      const octx = off.getContext('2d', { willReadFrequently: true });
      const frameCount = Math.ceil((tl.total / opts.speed) * fps);
      const pal = buildPalette();
      const framesIdx = [];
      for (let i = 0; i < frameCount; i++) {
        painter.paint(octx, (i / fps) * opts.speed, w / tl.bandW);
        const data = octx.getImageData(0, 0, w, h).data;
        const idx = new Uint8Array(w * h);
        quantize(data, idx);
        framesIdx.push(idx);
        if (i % 10 === 0) {
          say(`Rendering… ${Math.round((i / frameCount) * 100)}%`);
          await new Promise((r) => setTimeout(r, 0));
        }
      }
      say('Encoding GIF…');
      await new Promise((r) => setTimeout(r, 0));
      const gif = encodeGif(framesIdx, w, h, Math.round(100 / fps), pal);
      say('');
      await deliver(new Blob([gif], { type: 'image/gif' }), 'gif');
    } catch (e) {
      console.error(e);
      toast(`Could Not Make The GIF (${e.message || 'Error'})`, true);
      say('');
    }
    busy = false;
  };

  // ---- WebM: recorded from a real-time playthrough -----------------------
  veil.querySelector('[data-a="webm"]').onclick = async () => {
    if (busy) return;
    if (typeof MediaRecorder === 'undefined') { toast('This Browser Cannot Record Video - Use Save GIF', true); return; }
    busy = true;
    try {
      const w = Math.round(opts.size * 1.5);      // video can afford more pixels
      const h = Math.round(w * ratio);
      const off = document.createElement('canvas');
      off.width = w; off.height = h;
      const octx = off.getContext('2d');
      const stream = off.captureStream(60);
      const mime = MediaRecorder.isTypeSupported('video/webm;codecs=vp9') ? 'video/webm;codecs=vp9' : 'video/webm';
      const rec = new MediaRecorder(stream, { mimeType: mime, videoBitsPerSecond: 6_000_000 });
      const chunks = [];
      rec.ondataavailable = (e) => { if (e.data.size) chunks.push(e.data); };
      const doneRec = new Promise((res) => { rec.onstop = res; });
      rec.start();
      const runSecs = tl.total / opts.speed;
      const t0 = performance.now();
      say('Recording… Keep This Tab In Front');
      await new Promise((res) => {
        const step = (now) => {
          const el = (now - t0) / 1000;
          if (el >= runSecs + 0.3) { res(); return; }
          painter.paint(octx, Math.min(el * opts.speed, tl.total - 0.001), w / tl.bandW);
          requestAnimationFrame(step);
        };
        requestAnimationFrame(step);
      });
      rec.stop();
      await doneRec;
      say('');
      await deliver(new Blob(chunks, { type: 'video/webm' }), 'webm');
    } catch (e) {
      console.error(e);
      toast(`Could Not Record The Video (${e.message || 'Error'})`, true);
      say('');
    }
    busy = false;
  };
}
