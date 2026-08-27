// The diagram editor - a port of CTH Film Room's rink diagrammer, rebuilt
// as a standalone web editor with a floating toolbar, trackpad zoom and
// pan, customizable color presets, circle shapes, rotation, per-rink
// controls, and touch support.
//
// Elements on top of the background:
//   - PLAYERS: three color presets; hover a player button for a menu of
//     preset letters (C, LW, D1, ...); double-click a placed player to
//     retype its letters (two chars).
//   - ARROWS (A) and DASHED ARROWS (D): three anchors - drag the middle one
//     to bend the line into a curve. Heads: solid, open, stop bar, none.
//   - RINK ITEMS: net, coach, puck, pucks pyramid, cone, border pad.
//   - SHADED BOX (B) and CIRCLE (C): translucent washes, double-click to
//     label. TEXT (T): a Title chip edited in place, WYSIWYG. PEN (P).
//   - Rotation: the round handle above a selected stamp / box / circle /
//     text turns it, snapping to 15 degrees (Cmd for free rotation).
//
// "+" stacks another rink below (up to 5) as a drill sequence, saved as
// one image. Each rink wears a name chip (double-click to rename) and a
// control cluster: move up / down, copy, download, remove - the sequence
// reflows around every change. Snapping to landmarks and other objects
// with guides; Cmd disables. Multi-select: marquee, shift-click, group
// move, group clipboard. Undo depth 60.
//
// Native dblclick never fires here (pointerdown calls preventDefault, which
// suppresses the compatibility mouse events), so onDown runs its own
// double-press detection - do not rely on a dblclick listener.
//
// The live editor is SVG; exports are the same elements drawn onto a
// canvas - keep svgEl() here and drawEl() (flat.js) in step per type.

import {
  RINK_W, RINK_H, SEQ_GAP, SEQ_MAX, RINK, ITEMS,
  loadImg, shapeUrl, composeRinkBg,
} from './rink.js';
import { putDrill } from './store.js';
import { toast, esc } from './ui.js';
import {
  INK, PALETTE, SLOT_COUNT, colorOf, labelInkOn, measureText, arrowCtrl, arrowEndAngle,
  drawEl, TEXT_CHIP, shapeLabelSize, ROTATABLE,
  rotCenterOf, sliceFrames, motionPolys,
} from './flat.js';

// Editor-only breathing room in SEQUENCES: extra visual space between and
// above the rinks, where the frame label and its controls live - exactly
// like Figma's frame labels. Storage and export coordinates keep the
// canonical 60px gap (Film Room interchange), so this NEVER touches
// element coordinates; the renderer shifts each frame down visually and
// pt() maps pointer positions back.
const VGAP = 170;
const VTOP = 170;

let cur = null;
let wired = false;
let hooks = {};

const el = (id) => document.getElementById(id);

// ------------------------------------------------------------ settings
const SETTINGS_KEY = 'cthd.settings.v1';
function settings() {
  try { return JSON.parse(localStorage.getItem(SETTINGS_KEY)) || {}; } catch (_) { return {}; }
}
function saveSettings(patch) {
  localStorage.setItem(SETTINGS_KEY, JSON.stringify({ ...settings(), ...patch }));
}

// Only the first SLOT_COUNT palette entries are toolbar presets; the rest are
// retired names kept resolvable for old diagrams.
const DEFAULT_PALETTE = PALETTE.slice(0, SLOT_COUNT).map(([, hex]) => hex);
const SLOT_NAMES = PALETTE.slice(0, SLOT_COUNT).map(([n]) => n);
function paletteHexes() {
  const p = settings().palette;
  return Array.isArray(p) && p.length === 4 ? p : DEFAULT_PALETTE.slice();
}
const slotColor = (i) => {
  const hex = paletteHexes()[i];
  return hex.toLowerCase() === DEFAULT_PALETTE[i].toLowerCase() ? SLOT_NAMES[i] : hex;
};

const uid = () => Date.now().toString(36) + Math.random().toString(36).slice(2, 6);
const fileStem = (s) => (s || 'diagram').replace(/[^\w\- ]+/g, '').trim().replace(/\s+/g, '-').toLowerCase() || 'diagram';

// ---------------------------------------------------------------- geometry

const scaleF = () => (cur ? cur.w / RINK_W : 1);
const onRink = () => !!cur && cur.bgKind === 'rink';

const defaults = () => {
  const s = scaleF();
  return {
    playerR: Math.max(14, Math.round(45 * s)),
    text: Math.max(14, Math.round(48 * s)),
    stroke: Math.max(2, Math.round((Number(settings().arrowPx) || 8) * s)),
    pen: Math.max(2, Math.round(8 * s)),
  };
};

const hasVGaps = () => onRink(); // single rinks get the strip too
const vTop = () => (hasVGaps() ? VTOP : 0);
const vShiftOf = (k) => (hasVGaps() ? k * VGAP : 0);
const frameOfLY = (ly) => Math.max(0, Math.min((cur.seq || 1) - 1, Math.floor(ly / (RINK_H + SEQ_GAP))));
const vShiftOfY = (ly) => vShiftOf(frameOfLY(ly));
const totalVH = () => cur.h + (hasVGaps() ? (cur.seq - 1) * VGAP + VTOP : 0);

function pt(e) {
  const svg = el('edSvg');
  const r = svg.getBoundingClientRect();
  const scale = cur.w / r.width;
  const x = (e.clientX - r.left) * scale;
  const vy = (e.clientY - r.top) * scale - vTop();
  if (!hasVGaps()) return { x, y: vy };
  const per = RINK_H + SEQ_GAP + VGAP;
  const k = Math.max(0, Math.min(cur.seq - 1, Math.floor(vy / per)));
  const y = Math.max(k * (RINK_H + SEQ_GAP), Math.min((k + 1) * (RINK_H + SEQ_GAP) - 1, vy - k * VGAP));
  return { x, y };
}

function setSel(ids) {
  if (!cur) return;
  cur.selIds = ids;
  cur.sel = ids.length ? ids[ids.length - 1] : null;
}
const selEls = () => (cur ? cur.elements.filter((z) => (cur.selIds || []).includes(z.id)) : []);

// True bounds per element (unrotated space) - the box must CONTAIN the
// whole shape: arrow curves and heads, the player's ring, pen width, the
// full text chip. Rotated elements keep these bounds and the selection
// chrome turns with them.
function elBounds(x) {
  if (x.type === 'stamp' || x.type === 'pucks' || x.type === 'box' || x.type === 'circle') {
    return { x: x.x, y: x.y, w: x.w, h: x.h };
  }
  if (x.type === 'player') {
    const ring = Math.max(3, x.r * 0.18) / 2;
    const r = x.r + ring;
    return { x: x.x - r, y: x.y - r, w: r * 2, h: r * 2 };
  }
  if (x.type === 'text') {
    const T = TEXT_CHIP;
    const w = measureText(x);
    const padX = x.size * T.padX; const padY = x.size * T.padY;
    const bw = Math.max(1.5, x.size * T.border) / 2;
    return {
      x: x.x - padX - bw,
      y: x.y - x.size - padY - bw,
      w: w + padX * 2 + bw * 2,
      h: x.size * T.height + padY * 2 + bw * 2,
    };
  }
  if (x.type === 'arrow') {
    const { cx, cy } = arrowCtrl(x);
    const xs = []; const ys = [];
    for (let t = 0; t <= 1.0001; t += 0.1) {
      xs.push((1 - t) * (1 - t) * x.x1 + 2 * (1 - t) * t * cx + t * t * x.x2);
      ys.push((1 - t) * (1 - t) * x.y1 + 2 * (1 - t) * t * cy + t * t * x.y2);
    }
    const w = x.width || 8;
    const head = (x.head || 'triangle') === 'none' ? 0 : w * 4.3;
    const ang = arrowEndAngle(x);
    for (const a of [ang - 0.6, ang + 0.6, ang + Math.PI / 2, ang - Math.PI / 2]) {
      xs.push(x.x2 - Math.cos(a) * head);
      ys.push(x.y2 - Math.sin(a) * head);
    }
    const pad = w / 2 + 1;
    const x0 = Math.min(...xs) - pad; const y0 = Math.min(...ys) - pad;
    return { x: x0, y: y0, w: Math.max(...xs) + pad - x0, h: Math.max(...ys) + pad - y0 };
  }
  if (x.type === 'pen') {
    const pad = (x.width || 8) / 2 + 1;
    const xs = x.pts.map((p) => p[0]); const ys = x.pts.map((p) => p[1]);
    const x0 = Math.min(...xs) - pad; const y0 = Math.min(...ys) - pad;
    return { x: x0, y: y0, w: Math.max(...xs) + pad - x0, h: Math.max(...ys) + pad - y0 };
  }
  return { x: 0, y: 0, w: 0, h: 0 };
}

const centerOf = (x) => {
  const b = elBounds(x);
  return { x: b.x + b.w / 2, y: b.y + b.h / 2 };
};

// Bring a point into an element's unrotated space for hit tests.
function unrotate(p, x) {
  if (!x.rot || !ROTATABLE.has(x.type)) return p;
  const c = rotCenterOf(x);
  const a = (-x.rot * Math.PI) / 180;
  const dx = p.x - c.x; const dy = p.y - c.y;
  return { x: c.x + dx * Math.cos(a) - dy * Math.sin(a), y: c.y + dx * Math.sin(a) + dy * Math.cos(a) };
}

function hitAt(p) {
  const pad = Math.max(6, cur.w * 0.004);
  for (let i = cur.elements.length - 1; i >= 0; i--) {
    const x = cur.elements[i];
    if (x.type === 'arrow') {
      const { cx, cy } = arrowCtrl(x);
      for (let t = 0; t <= 1.001; t += 0.05) {
        const qx = (1 - t) * (1 - t) * x.x1 + 2 * (1 - t) * t * cx + t * t * x.x2;
        const qy = (1 - t) * (1 - t) * x.y1 + 2 * (1 - t) * t * cy + t * t * x.y2;
        if (Math.hypot(p.x - qx, p.y - qy) < pad + (x.width || 8)) return x;
      }
      continue;
    }
    if (x.type === 'pen') {
      for (const [px, py] of x.pts) if (Math.hypot(p.x - px, p.y - py) < pad + (x.width || 8)) return x;
      continue;
    }
    const q = unrotate(p, x);
    const b = elBounds(x);
    if (q.x >= b.x - pad && q.x <= b.x + b.w + pad && q.y >= b.y - pad && q.y <= b.y + b.h + pad) return x;
  }
  return null;
}

// ------------------------------------------------------------- snapping

function snapTargets(excludeId) {
  const xs = [];
  const ys = [];
  const excluded = (id) => (excludeId && excludeId.has ? excludeId.has(id) : id === excludeId);
  for (const z of cur.elements) {
    if (excluded(z.id)) continue;
    const c = centerOf(z);
    xs.push(c.x);
    ys.push(c.y);
  }
  if (onRink()) {
    const frames = cur.seq || 1;
    for (let k = 0; k < frames; k++) {
      const oy = k * (RINK_H + SEQ_GAP);
      xs.push(RINK.goalL, RINK.goalR, RINK.blueL, RINK.blueR, RINK.center, RINK.creaseL, RINK.creaseR, ...RINK.dotCols);
      ys.push(oy + RINK.midY, ...RINK.dotRows.map((r) => oy + r));
    }
  }
  return { xs, ys };
}

function snapCenter(cx, cy, excludeId, disabled) {
  if (disabled) return { x: cx, y: cy, guides: [] };
  const T = 16 * scaleF() + 4;
  const { xs, ys } = snapTargets(excludeId);
  const guides = [];
  let bx = cx; let by = cy; let dx = T; let dy = T;
  for (const x of xs) { const d = Math.abs(cx - x); if (d < dx) { dx = d; bx = x; } }
  for (const y of ys) { const d = Math.abs(cy - y); if (d < dy) { dy = d; by = y; } }
  if (bx !== cx || dx < T) { if (dx < T) guides.push({ v: bx }); else bx = cx; }
  if (by !== cy || dy < T) { if (dy < T) guides.push({ h: by }); else by = cy; }
  return { x: dx < T ? bx : cx, y: dy < T ? by : cy, guides };
}

function moveElTo(x, cx, cy) {
  const c = centerOf(x);
  const dx = cx - c.x; const dy = cy - c.y;
  if (x.type === 'stamp' || x.type === 'pucks' || x.type === 'text' || x.type === 'box' || x.type === 'circle') { x.x += dx; x.y += dy; }
  else if (x.type === 'player') { x.x += dx; x.y += dy; }
  else if (x.type === 'arrow') { x.x1 += dx; x.y1 += dy; x.x2 += dx; x.y2 += dy; x.mx += dx; x.my += dy; }
  else if (x.type === 'pen') x.pts = x.pts.map(([px, py]) => [px + dx, py + dy]);
}

// ------------------------------------------------------------ undo / save

const marker = () => ({
  elements: structuredClone(cur.elements),
  bgKind: cur.bgKind,
  bg: cur.bgKind === 'rink' ? null : cur.bgDataUrl,
  seq: cur.seq,
  rinkNames: structuredClone(cur.rinkNames),
});

function snapshot() {
  cur.undo.push(marker());
  if (cur.undo.length > 60) cur.undo.shift();
  cur.redoStack.length = 0;
}

async function restore(snap) {
  cur.elements = structuredClone(snap.elements);
  cur.seq = snap.seq || 1;
  cur.rinkNames = structuredClone(snap.rinkNames || []);
  if (snap.bgKind === 'rink') {
    if (cur.bgKind !== 'rink' || cur.seqBg !== cur.seq) setRinkBackground(cur.seq);
  } else if (snap.bg !== cur.bgDataUrl || cur.bgKind !== 'image') {
    await setImageBackground(snap.bg);
  }
  setSel([]);
  render();
  markDirty();
}

async function undo() {
  if (!cur?.undo.length) return;
  cur.redoStack.push(marker());
  await restore(cur.undo.pop());
}
async function redo() {
  if (!cur?.redoStack.length) return;
  cur.undo.push(marker());
  await restore(cur.redoStack.pop());
}

function status(msg) {
  const s = el('edStatus');
  if (s) s.textContent = msg;
}

// AUTOSAVE (Tony's call 2026-08-26, reversing the manual-save rule of
// 2026-08-24). An edit raises the dirty flag and schedules the write; the
// diagram saves itself once the edits stop. Save and Cmd+S still work and
// still save immediately - autosave is a safety net, not a replacement.
//
// DEBOUNCED, deliberately, rather than a fixed interval: every drag step
// calls markDirty, and a timer that fired mid-drag would run a full state
// clone and a thumbnail render while the hand is still moving. Waiting for
// a pause means the save lands between motions, where it costs nothing.
// The manual-save era existed because a dead IndexedDB connection made
// every write fail (hard rule 7); store.js now drops and retries that
// handle, which is what makes an automatic write safe again.
const AUTOSAVE_MS = 1000;
let autoTimer = null;

function cancelAutosave() {
  if (autoTimer) { clearTimeout(autoTimer); autoTimer = null; }
}

function scheduleAutosave() {
  cancelAutosave();
  autoTimer = setTimeout(() => {
    autoTimer = null;
    if (cur && cur.dirty) void saveNow();
  }, AUTOSAVE_MS);
}

// Every edit path calls this, so it is the single place the dirty state is
// set and the single place a save gets scheduled.
function markDirty() {
  if (!cur) return;
  cur.dirty = true;
  status('Unsaved');
  if (hooks.onDirty) hooks.onDirty(true);
  scheduleAutosave();
}

function setRinkBackground(n) {
  cur.bgKind = 'rink';
  cur.bgImg = composeRinkBg(n);
  cur.seqBg = n;
  cur.bgDataUrl = null;
  cur.w = cur.bgImg.width;
  cur.h = cur.bgImg.height;
  cur.bgHref = null;
}

async function setImageBackground(dataUrl) {
  const img = await loadImg(dataUrl);
  cur.bgKind = 'image';
  cur.bgDataUrl = dataUrl;
  cur.bgImg = img;
  cur.w = img.naturalWidth;
  cur.h = img.naturalHeight;
  cur.bgHref = dataUrl;
}

function bgHref() {
  if (cur.bgKind === 'image') return cur.bgDataUrl;
  if (!cur.bgHref) cur.bgHref = cur.bgImg.toDataURL('image/png');
  return cur.bgHref;
}

export async function renderFlat(scale = 1) {
  const c = document.createElement('canvas');
  c.width = Math.round(cur.w * scale); c.height = Math.round(cur.h * scale);
  const ctx = c.getContext('2d');
  ctx.scale(scale, scale);
  ctx.fillStyle = '#ffffff';
  ctx.fillRect(0, 0, cur.w, cur.h);
  ctx.drawImage(cur.bgImg, 0, 0, cur.w, cur.h);
  for (const x of cur.elements) drawEl(ctx, x);
  return c;
}

// The cthDiagram state - the same shape Film Room embeds in its PNGs, plus
// the additive rinkNames and rot properties (older readers ignore them).
export function currentState() {
  const st = {
    v: 1,
    w: cur.w,
    h: cur.h,
    bg: cur.bgKind === 'image' && cur.bgDataUrl.length < 2_500_000 ? cur.bgDataUrl : null,
    seq: cur.seq,
    elements: cur.elements,
  };
  if (onRink() && cur.rinkNames?.some((n) => n && n.trim())) st.rinkNames = cur.rinkNames;
  return st;
}

export function frameInfo() {
  if (!cur || !onRink()) return { seq: 1, names: [] };
  return { seq: cur.seq || 1, names: (cur.rinkNames || []).slice() };
}

export async function saveNow() {
  cancelAutosave();
  if (!cur) return;
  if (!cur.dirty) { status('Saved'); return; }
  const c = cur; // the editor may close while this runs - never re-read cur
  c.dirty = false;
  status('Saving…');
  if (hooks.onDirty) hooks.onDirty(false);
  try {
    c.drill.state = structuredClone(currentState());
    // The thumbnail is a nicety - a failure there must never block the save.
    try {
      const thumbScale = Math.min(1, 480 / c.w);
      c.drill.thumb = (await renderFlat(thumbScale)).toDataURL('image/jpeg', 0.8);
    } catch (e) {
      console.error('thumb render failed', e);
    }
    try {
      await putDrill(c.drill);
    } catch (e) {
      // One quiet retry - a transient IndexedDB hiccup should not surface.
      console.error('save retry after', e);
      await new Promise((z) => setTimeout(z, 700));
      await putDrill(c.drill);
    }
    if (cur === c) status('Saved');
  } catch (e) {
    c.dirty = true;
    if (cur === c) status('Not Saved');
    if (cur === c && hooks.onDirty) hooks.onDirty(true);
    console.error(e);
    toast(`Could Not Save (${e?.name || 'Error'}: ${e?.message || 'unknown'})`, true);
  }
}

// Does the open diagram hold edits that are not on disk? The leave prompts in
// app.js ask this before letting the page or the route go.
export function isDirty() {
  return !!(cur && cur.dirty);
}

// ------------------------------------------------------------- SVG render

const wrapRot = (x, inner) => {
  if (!x.rot || !ROTATABLE.has(x.type)) return inner;
  const c = rotCenterOf(x);
  return `<g transform="rotate(${x.rot} ${c.x} ${c.y})">${inner}</g>`;
};

function svgEl(x) {
  if (x.id === cur.hideId) return '';
  if (x.type === 'stamp') {
    const href = shapeUrl(x.name);
    const flip = x.flip ? ` transform="translate(${2 * x.x + x.w} 0) scale(-1 1)"` : '';
    return wrapRot(x, `<image data-id="${x.id}" href="${href}" x="${x.x}" y="${x.y}" width="${x.w}" height="${x.h}"${flip}></image>`);
  }
  if (x.type === 'pucks') {
    const r = Math.min(x.w, x.h) * 0.22;
    const pts = [
      [x.x + x.w * 0.3, x.y + x.h * 0.72],
      [x.x + x.w * 0.7, x.y + x.h * 0.72],
      [x.x + x.w * 0.5, x.y + x.h * 0.3],
    ];
    return wrapRot(x, `<g data-id="${x.id}">${pts.map(([px, py]) => `<circle cx="${px}" cy="${py}" r="${r}" fill="${INK}"></circle>`).join('')}</g>`);
  }
  if (x.type === 'player') {
    const fs = Math.round(x.r * (x.label && x.label.length > 1 ? 0.82 : 1.0));
    return `<g data-id="${x.id}">
      <circle cx="${x.x}" cy="${x.y}" r="${x.r}" fill="${colorOf(x.color)}" stroke="${INK}" stroke-width="${Math.max(3, x.r * 0.18)}"></circle>
      ${x.label ? `<text x="${x.x}" y="${x.y}" fill="${labelInkOn(x.color)}" font-family="Inter, sans-serif" font-weight="800" font-size="${fs}" text-anchor="middle" dominant-baseline="central">${esc(x.label)}</text>` : ''}
    </g>`;
  }
  if (x.type === 'box' || x.type === 'circle') {
    const fill = `fill="${colorOf(x.color)}" fill-opacity="${x.alpha == null ? 0.3 : x.alpha}"`;
    const shape = x.type === 'circle'
      ? `<ellipse cx="${x.x + x.w / 2}" cy="${x.y + x.h / 2}" rx="${x.w / 2}" ry="${x.h / 2}" ${fill}></ellipse>`
      : `<rect x="${x.x}" y="${x.y}" width="${x.w}" height="${x.h}" rx="${Math.min(x.w, x.h) * 0.06}" ${fill}></rect>`;
    const fs = Math.round(shapeLabelSize(x));
    const label = x.label
      ? `<text x="${x.x + x.w / 2}" y="${x.y + x.h / 2}" fill="${labelInkOn(x.color)}" font-family="Inter, sans-serif" font-weight="800" font-size="${fs}" text-anchor="middle" dominant-baseline="central">${esc(x.label)}</text>`
      : '';
    return wrapRot(x, `<g data-id="${x.id}">${shape}${label}</g>`);
  }
  if (x.type === 'arrow') {
    const { cx, cy } = arrowCtrl(x);
    const ang = arrowEndAngle(x);
    const w = x.width || 8;
    const head = w * 4.3;
    const style = x.head || 'triangle';
    const trim = style === 'triangle' ? head * 0.7 : 0;
    const tx = x.x2 - Math.cos(ang) * trim;
    const ty = x.y2 - Math.sin(ang) * trim;
    const col = colorOf(x.color);
    const stroke = `stroke="${col}" stroke-width="${w}" stroke-linecap="round"`;
    let headSvg = '';
    if (style === 'triangle') {
      const p1 = `${x.x2 - Math.cos(ang - 0.44) * head},${x.y2 - Math.sin(ang - 0.44) * head}`;
      const p2 = `${x.x2 - Math.cos(ang + 0.44) * head},${x.y2 - Math.sin(ang + 0.44) * head}`;
      headSvg = `<polygon points="${x.x2},${x.y2} ${p1} ${p2}" fill="${col}" stroke="${col}" stroke-width="${w * 0.9}" stroke-linejoin="round"></polygon>`;
    } else if (style === 'v') {
      headSvg = `<path d="M ${x.x2 - Math.cos(ang - 0.5) * head} ${x.y2 - Math.sin(ang - 0.5) * head} L ${x.x2} ${x.y2} L ${x.x2 - Math.cos(ang + 0.5) * head} ${x.y2 - Math.sin(ang + 0.5) * head}" fill="none" ${stroke}></path>`;
    } else if (style === 'bar') {
      const bx = Math.cos(ang + Math.PI / 2) * head * 0.7;
      const by = Math.sin(ang + Math.PI / 2) * head * 0.7;
      headSvg = `<path d="M ${x.x2 - bx} ${x.y2 - by} L ${x.x2 + bx} ${x.y2 + by}" fill="none" ${stroke}></path>`;
    }
    const deco = motionPolys(x, trim);
    let bodySvg;
    if (deco) {
      const bw = x.motion === 'backward' ? Math.max(2, w * 0.85) : w;
      bodySvg = deco.map((poly) => `<path d="M ${poly.map(([px, py]) => `${px} ${py}`).join(' L ')}" fill="none" stroke="${col}" stroke-width="${bw}" stroke-linecap="round" stroke-linejoin="round"></path>`).join('');
    } else {
      bodySvg = `<path d="M ${x.x1} ${x.y1} Q ${cx} ${cy} ${tx} ${ty}" fill="none" ${stroke}${x.dash ? ` stroke-dasharray="${w * 2.4} ${w * 2}"` : ''}></path>`;
    }
    return `<g data-id="${x.id}">
      ${bodySvg}
      ${headSvg}
    </g>`;
  }
  if (x.type === 'text') {
    const T = TEXT_CHIP;
    const w = measureText(x);
    const padX = x.size * T.padX; const padY = x.size * T.padY;
    return wrapRot(x, `<g data-id="${x.id}">
      <rect x="${x.x - padX}" y="${x.y - x.size - padY}" width="${w + padX * 2}" height="${x.size * T.height + padY * 2}" rx="${x.size * T.radius}" fill="#ffffff" stroke="${INK}" stroke-width="${Math.max(1.5, x.size * T.border)}"></rect>
      <text x="${x.x}" y="${x.y}" fill="${colorOf(x.color)}" font-family="Inter, sans-serif" font-weight="800" font-size="${x.size}">${esc(x.text || '')}</text>
    </g>`);
  }
  if (x.type === 'pen') {
    return `<polyline data-id="${x.id}" points="${x.pts.map((p) => `${p[0]},${p[1]}`).join(' ')}" fill="none" stroke="${colorOf(x.color)}" stroke-width="${x.width || 8}" stroke-linecap="round" stroke-linejoin="round"></polyline>`;
  }
  return '';
}

// The frame strip: a Figma-style label plus minimal ghost controls in the
// clear space ABOVE each rink of a sequence. Editor chrome only - never in
// exports, never on the ice.
const RCTL_GLYPHS = {
  up: '<path d="M48 70V28M30 46 48 28l18 18"/>',
  down: '<path d="M48 26v42M30 50l18 18 18-18"/>',
  copy: '<rect x="36" y="36" width="32" height="32" rx="8"/><rect x="24" y="24" width="32" height="32" rx="8"/>',
  link: '<path d="M41 55a11 11 0 0 0 15.6.9l7-7a11 11 0 0 0-15.6-15.5l-3.5 3.4M55 41a11 11 0 0 0-15.6-.9l-7 7a11 11 0 0 0 15.6 15.5l3.5-3.4"/>',
  dl: '<path d="M48 26v26M35 41l13 13 13-13M28 70h40"/>',
  del: '<path d="M33 33l30 30M63 33 33 63"/>',
};
const RCTL_TIPS = {
  up: 'Move This Rink Up', down: 'Move This Rink Down', copy: 'Copy This Rink To The Clipboard',
  dl: 'Download This Rink As PNG', link: 'Copy A Notion Embed Link For This Rink',
  del: 'Remove This Rink',
};
const FLABEL = { size: 46, x: 24, gapAbove: 56 };
function frameStripsSvg() {
  if (!hasVGaps()) return '';
  const out = [];
  const B = 68; const GAP = 14;
  for (let k = 0; k < (cur.seq || 1); k++) {
    const topV = k * (RINK_H + SEQ_GAP) + vShiftOf(k); // visual frame top
    const baseline = topV - FLABEL.gapAbove + FLABEL.size * 0.85;
    const name = (cur.rinkNames?.[k] || '').trim() || `Rink ${k + 1}`;
    // While the label is being renamed the SVG text stands down, so the
    // input is the only thing on screen - no doubled letters.
    if (cur.editLabel !== k) {
      out.push(`<g class="ed-flabelwrap" data-rframe="${k}"><rect x="${FLABEL.x - 10}" y="${topV - FLABEL.gapAbove - 14}" width="${Math.max(320, name.length * FLABEL.size * 0.62) + 40}" height="${FLABEL.size + 34}" fill="transparent"></rect><text class="ed-flabel" x="${FLABEL.x}" y="${baseline}" font-family="Inter, sans-serif" font-weight="800" font-size="${FLABEL.size}">${esc(name)}<title>Click To Rename This Rink</title></text></g>`);
    }
    const acts = [];
    if (k > 0) acts.push('up');
    if (k < (cur.seq || 1) - 1) acts.push('down');
    acts.push('copy', 'dl', 'link');
    if ((cur.seq || 1) > 1) acts.push('del');
    let x0 = RINK_W - acts.length * (B + GAP);
    const by = topV - FLABEL.gapAbove - (B - FLABEL.size) / 2 - 4;
    for (const a of acts) {
      out.push(`<g class="ed-rctl" data-rctl="${a}" data-frame="${k}">
        <title>${RCTL_TIPS[a]}</title>
        <rect x="${x0}" y="${by}" width="${B}" height="${B}" rx="15"></rect>
        <g transform="translate(${x0} ${by}) scale(${B / 96})">${RCTL_GLYPHS[a]}</g>
      </g>`);
      x0 += B + GAP;
    }
  }
  return out.join('');
}

// Wrap rendered markup with the frame's editor-only vertical shift.
const vWrap = (y, inner) => {
  const dy = vShiftOfY(y);
  return dy ? `<g transform="translate(0 ${dy})">${inner}</g>` : inner;
};

function uiSvg() {
  const out = [];
  const hs = Math.max(8, cur.w * 0.0065);
  const sel = selEls();
  const primary = cur.elements.find((z) => z.id === cur.sel);
  if (sel.length === 1 && primary && primary.type === 'arrow') {
    const x = primary;
    for (const [ax, ay, kind] of [[x.x1, x.y1, 'a1'], [x.mx, x.my, 'mid'], [x.x2, x.y2, 'a2']]) {
      out.push(vWrap(centerOf(x).y, `<circle class="ed-anchor${kind === 'mid' ? ' mid' : ''}" data-h="${kind}" cx="${ax}" cy="${ay}" r="${hs}" vector-effect="non-scaling-stroke"></circle>`));
    }
  } else {
    for (const z of sel) {
      const b = elBounds(z);
      out.push(vWrap(centerOf(z).y, wrapRot(z, `<rect class="ed-selbox" x="${b.x}" y="${b.y}" width="${Math.max(b.w, 2)}" height="${Math.max(b.h, 2)}" rx="${hs * 0.4}" vector-effect="non-scaling-stroke"></rect>`)));
    }
    if (sel.length === 1 && primary
      && ['stamp', 'pucks', 'player', 'text', 'box', 'circle'].includes(primary.type)) {
      const b = elBounds(primary);
      let chrome = `<rect class="ed-grip" data-h="se" x="${b.x + b.w - hs}" y="${b.y + b.h - hs}" width="${hs * 2}" height="${hs * 2}" rx="${hs * 0.35}" vector-effect="non-scaling-stroke"></rect>`;
      if (ROTATABLE.has(primary.type)) {
        const cx = b.x + b.w / 2;
        chrome += `<line class="ed-rotstem" x1="${cx}" y1="${b.y}" x2="${cx}" y2="${b.y - hs * 2.6}" vector-effect="non-scaling-stroke"></line>
          <circle class="ed-rot" data-h="rot" cx="${cx}" cy="${b.y - hs * 3.4}" r="${hs}" vector-effect="non-scaling-stroke"></circle>`;
      }
      out.push(vWrap(centerOf(primary).y, wrapRot(primary, chrome)));
    }
  }
  if (cur.band) {
    const b = cur.band;
    const x0 = Math.min(b.x1, b.x2);
    const y1 = Math.min(b.y1, b.y2) + vShiftOfY(Math.min(b.y1, b.y2));
    const y2 = Math.max(b.y1, b.y2) + vShiftOfY(Math.max(b.y1, b.y2));
    out.push(`<rect class="ed-band" x="${x0}" y="${y1}" width="${Math.abs(b.x2 - b.x1)}" height="${Math.max(2, y2 - y1)}" vector-effect="non-scaling-stroke"></rect>`);
  }
  for (const g of (cur.guides || [])) {
    if (g.v != null) out.push(`<line class="ed-guide" x1="${g.v}" y1="${-vTop()}" x2="${g.v}" y2="${totalVH() - vTop()}" vector-effect="non-scaling-stroke"></line>`);
    if (g.h != null) out.push(`<line class="ed-guide" x1="0" y1="${g.h + vShiftOfY(g.h)}" x2="${cur.w}" y2="${g.h + vShiftOfY(g.h)}" vector-effect="non-scaling-stroke"></line>`);
  }
  out.push(frameStripsSvg());
  return out.join('');
}

let rinkHrefCache = null;
function rinkHref() {
  if (!rinkHrefCache) rinkHrefCache = composeRinkBg(1).toDataURL('image/png');
  return rinkHrefCache;
}

let toolsSig = '';
export function render() {
  const svg = el('edSvg');
  if (!svg || !cur) return;
  svg.setAttribute('viewBox', `0 ${-vTop()} ${cur.w} ${totalVH()}`);
  const stageEl = el('edStage');
  if (stageEl) stageEl.style.aspectRatio = `${cur.w} / ${totalVH()}`;
  const bgG = svg.querySelector('#edBgG');
  if (onRink()) {
    bgG.innerHTML = Array.from({ length: cur.seq || 1 }, (_, k) =>
      `<image href="${rinkHref()}" x="0" y="${k * (RINK_H + SEQ_GAP) + vShiftOf(k)}" width="${RINK_W}" height="${RINK_H}"></image>`).join('');
  } else {
    bgG.innerHTML = `<image href="${bgHref()}" x="0" y="0" width="${cur.w}" height="${cur.h}"></image>`;
  }
  svg.querySelector('#edEls').innerHTML = cur.elements.map((x) => vWrap(centerOf(x).y, svgEl(x))).join('');
  svg.querySelector('#edUi').innerHTML = uiSvg();
  // Head and line weight left the toolbar for their own popup (2026-08-27),
  // so neither belongs in this signature any more: keeping them here would
  // repaint the bar - and close the popup - on every choice made inside it.
  const sig = `${cur.tool}|${cur.color}|${cur.seq}|${paletteHexes().join()}`;
  if (sig !== toolsSig) { toolsSig = sig; paintTools(); }
}

// ---------------------------------------------------------------- toolbar

const ICON = {
  select: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-linejoin="round"><path d="M4.04 4.69a.5.5 0 0 1 .65-.65l16 6.5a.5.5 0 0 1-.06.94l-6.13 1.58a2 2 0 0 0-1.43 1.44l-1.58 6.12a.5.5 0 0 1-.95.07z"/></svg>',
  // The five movement arrows, all drawn on the same lower-left to
  // upper-right diagonal with the same head, so the row reads as one
  // family and only the LINE says what the movement is.
  arrow: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-linejoin="round" stroke-linecap="round"><path d="M4.5 19.5 18 6"/><path d="M10.5 5.5H19V14"/></svg>',
  dasharrow: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-linejoin="round" stroke-linecap="round"><path d="M4.5 19.5 18 6" stroke-dasharray="3.2 3"/><path d="M10.5 5.5H19V14"/></svg>',
  skatepuck: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-linejoin="round" stroke-linecap="round"><path d="M4 19.5c1.9-1.1 1.2-3.4 3.1-4.5s2.6 1.2 4.5.1 1.2-3.4 3.1-4.5 2.6 1.2 4.5.1"/><path d="M12.5 5.2H19v6.5"/></svg>',
  skateback: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-linejoin="round" stroke-linecap="round"><path d="M4 19.5a2 2 0 1 0 2.9-2.8 2 2 0 1 1 2.9-2.9 2 2 0 1 0 2.9-2.8 2 2 0 1 1 2.9-2.9"/><path d="M12.5 5.2H19v6.5"/></svg>',
  shoot: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-linejoin="round" stroke-linecap="round"><path d="M3.2 18.1 16.6 4.7"/><path d="M5.9 20.8 19.3 7.4"/><path d="M11.6 4.2h8.2v8.2"/></svg>',
  box: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor"><rect x="4.25" y="5.25" width="15.5" height="13.5" rx="2.75"/></svg>',
  circle: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor"><circle cx="12" cy="12" r="7.75"/></svg>',
  text: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-linecap="round"><path d="M4 7V5.5A1.5 1.5 0 0 1 5.5 4h13A1.5 1.5 0 0 1 20 5.5V7"/><path d="M12 4v16"/><path d="M9 20h6"/></svg>',
  pen: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-linejoin="round"><path d="M21.17 6.81a2.82 2.82 0 0 0-3.98-3.99L3.84 16.17a2 2 0 0 0-.5.83l-1.32 4.35a.5.5 0 0 0 .62.63l4.36-1.32a2 2 0 0 0 .83-.5z"/><path d="m14.5 5.5 4 4"/></svg>',
  pucks: '<svg viewBox="0 0 24 24" fill="currentColor" stroke="none"><circle cx="8" cy="16" r="3.4"/><circle cx="16" cy="16" r="3.4"/><circle cx="12" cy="8.5" r="3.4"/></svg>',
  puck: '<svg viewBox="0 0 24 24" fill="currentColor" stroke="none"><circle cx="12" cy="12" r="3.2"/></svg>',
};
const HEAD_ICONS = {
  triangle: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor"><path d="M3 12h11"/><path d="M14 7.5 21 12l-7 4.5z" fill="currentColor" stroke="none"/></svg>',
  v: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor"><path d="M3 12h17"/><path d="M14.5 6.5 21 12l-6.5 5.5"/></svg>',
  bar: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor"><path d="M3 12h17"/><path d="M20 5.5v13"/></svg>',
  none: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor"><path d="M3 12h18"/></svg>',
};
const HEADS = [
  ['triangle', 'Solid Arrowhead'],
  ['v', 'Open Arrowhead'],
  ['bar', 'Stop Bar'],
  ['none', 'Plain Line'],
];

// Each movement is its OWN TOOL (2026-08-27, Tony's call): arm it and
// draw, the way icehockeysystems does it. `motion` is still what gets
// stored on the element, so the drawing and the animator are unchanged -
// the tool just decides which value to stamp.
const TOOLS = [
  ['select', 'Select & Move'],
  ['arrow', 'Skate'],
  ['skatepuck', 'Skate With Puck'],
  ['skateback', 'Skate Backwards'],
  ['shoot', 'Shoot'],
  ['dasharrow', 'Pass'],
  ['box', 'Shaded Box'],
  ['circle', 'Shaded Circle'],
  ['text', 'Text'],
  ['pen', 'Pen'],
];

// tool -> what the element carries. A pass is the dashed line; the rest
// are solid lines wearing a motion.
const LINE_SPEC = {
  arrow: { dash: false, motion: null },
  skatepuck: { dash: false, motion: 'puck' },
  skateback: { dash: false, motion: 'backward' },
  shoot: { dash: false, motion: 'shoot' },
  dasharrow: { dash: true, motion: null },
};
const PLAYER_SLOTS = [0, 1, 2];
const ITEM_ORDER = ['coach', 'net', 'puck', 'pucks', 'cone', 'border'];
// The preset letters a player can arrive wearing (hover a player button).
const PLAYER_LABELS = ['1', '2', '3', '4', '5', 'C', 'D1', 'D2', 'F1', 'F2', 'F3', 'G', 'LD', 'LW', 'O', 'RD', 'RW', 'X'];

// P is Pass (Tony's call 2026-08-27), so the pen moved to E and the pucks
// stamp moved off S. Any key Tony has already customized still wins.
const DEFAULT_KEYS = {
  select: 'v', arrow: 'a', skatepuck: 's', skateback: 'z', shoot: 'x', dasharrow: 'p',
  box: 'b', circle: 'c', text: 't', pen: 'e',
  'p-0': '1', 'p-1': '2', 'p-2': '3',
  faceoff: 'f',
  'i-coach': 'h', 'i-net': 'n', 'i-puck': 'k', 'i-pucks': 'u', 'i-cone': 'o', 'i-border': 'w',
  'c-0': '6', 'c-1': '7', 'c-2': '8', 'c-3': '9',
};
const customKeys = () => settings().diagramKeys || {};
function keyFor(toolId) {
  const c = customKeys();
  if (c[toolId]) return String(c[toolId]);
  const d = DEFAULT_KEYS[toolId];
  if (!d) return '';
  const stolen = Object.entries(c).some(([t, k]) => t !== toolId && String(k).toLowerCase() === d);
  return stolen ? '' : d;
}
function effectiveKeys() {
  const map = {};
  for (const [t, k] of Object.entries(DEFAULT_KEYS)) map[k] = t;
  const c = customKeys();
  for (const t of Object.keys(c)) {
    for (const key of Object.keys(map)) if (map[key] === t) delete map[key];
  }
  for (const [t, k] of Object.entries(c)) if (k) map[String(k).toLowerCase()] = t;
  return map;
}
const keyBadge = (toolId) => {
  const k = keyFor(toolId);
  return k ? `<span class="tb-key">${esc(k.toUpperCase())}</span>` : '';
};
let capturing = null;

function toolLabel(toolId) {
  const t = TOOLS.find(([id]) => id === toolId);
  if (t) return t[1];
  if (toolId.startsWith('p-')) return `Player ${Number(toolId.slice(2)) + 1}`;
  if (toolId.startsWith('i-')) return ITEMS[toolId.slice(2)]?.label || toolId;
  if (toolId.startsWith('c-')) return `Color Preset ${Number(toolId.slice(2)) + 1}`;
  if (toolId === 'faceoff') return '5v5 Faceoff';
  return toolId;
}

function itemIcon(key) {
  if (key === 'pucks') return ICON.pucks;
  if (key === 'puck') return ICON.puck;
  const u = shapeUrl(ITEMS[key].file);
  return u ? `<img class="ic-${key}" src="${u}" alt="">` : ITEMS[key].label;
}

const sep = '<span class="tb-sep"></span>';

// ---- player preset menu --------------------------------------------------

let pmenuEl = null;
let pmenuTimer = null;
function hidePlayerMenu(soon = false) {
  clearTimeout(pmenuTimer);
  if (soon) { pmenuTimer = setTimeout(() => hidePlayerMenu(), 250); return; }
  pmenuEl?.remove();
  pmenuEl = null;
}
function showPlayerMenu(slot, btn) {
  clearTimeout(pmenuTimer);
  if (pmenuEl?.dataset.slot === String(slot)) return;
  hidePlayerMenu();
  const c = colorOf(slotColor(slot));
  const ink = labelInkOn(slotColor(slot));
  pmenuEl = document.createElement('div');
  pmenuEl.className = 'pmenu';
  pmenuEl.dataset.slot = String(slot);
  pmenuEl.innerHTML = `
    <button class="pmenu-chip pmenu-blank" data-label="">Blank</button>
    ${PLAYER_LABELS.map((l) => `<button class="pmenu-chip" data-label="${l}" style="--c:${c};--i:${ink}">${l}</button>`).join('')}`;
  document.body.appendChild(pmenuEl);
  const r = btn.getBoundingClientRect();
  const mw = pmenuEl.offsetWidth;
  pmenuEl.style.left = `${Math.max(8, Math.min(window.innerWidth - mw - 8, r.left + r.width / 2 - mw / 2))}px`;
  pmenuEl.style.top = `${r.top - pmenuEl.offsetHeight - 10}px`;
  pmenuEl.addEventListener('pointerenter', () => clearTimeout(pmenuTimer));
  pmenuEl.addEventListener('pointerleave', () => hidePlayerMenu(true));
  pmenuEl.querySelectorAll('[data-label]').forEach((b) => {
    b.onclick = () => {
      cur.pendingLabel = b.dataset.label;
      setTool(`p-${slot}`);
      hidePlayerMenu();
      toast(b.dataset.label ? `Placing A "${b.dataset.label}" Player - Click The Ice` : 'Placing A Blank Player - Click The Ice');
    };
  });
}

// ---- line options menu (arrow head + line weight) ------------------------
//
// These used to APPEND to the toolbar whenever a line tool was armed or a
// line was selected, so the bar grew by seven buttons and every tool under
// the pointer shifted sideways (Tony's call 2026-08-27). They now live in a
// popup that opens the same way the player letters do: hover for the mouse,
// a second press on the armed button for touch.

const WEIGHTS = [[4, 'Fine Lines'], [8, 'Standard Lines'], [14, 'Bold Lines']];
const LINE_TOOLS = new Set(['arrow', 'skatepuck', 'skateback', 'shoot', 'dasharrow', 'pen']);

let lmenuEl = null;
let lmenuTimer = null;
function hideLineMenu(soon = false) {
  clearTimeout(lmenuTimer);
  if (soon) { lmenuTimer = setTimeout(() => hideLineMenu(), 250); return; }
  lmenuEl?.remove();
  lmenuEl = null;
}
function showLineMenu(tool, btn) {
  clearTimeout(lmenuTimer);
  if (lmenuEl?.dataset.tool === tool) return;
  hideLineMenu();
  const headNow = cur.head || 'triangle';
  const weight = Number(settings().arrowPx) || 8;
  // The pen draws freehand strokes, which have no arrowhead - offering one
  // there would be a control that does nothing.
  const wantsHead = tool !== 'pen';
  lmenuEl = document.createElement('div');
  lmenuEl.className = 'pmenu lmenu';
  lmenuEl.dataset.tool = tool;
  lmenuEl.innerHTML = `
    ${wantsHead ? `<span class="lmenu-label">Head</span>
    ${HEADS.map(([h, label]) => `<button class="tb-btn tb-small${headNow === h ? ' on' : ''}" data-head="${h}" aria-label="${label}" title="${label}">${HEAD_ICONS[h]}</button>`).join('')}
    <span class="tb-sep"></span>` : ''}
    <span class="lmenu-label">Line</span>
    ${WEIGHTS.map(([wpx, label], i) => `<button class="tb-btn tb-small${weight === wpx ? ' on' : ''}" data-weight="${wpx}" aria-label="${label}" title="${label}"><svg viewBox="0 0 24 24"><path d="M4 12h16" stroke="currentColor" stroke-linecap="round" stroke-width="${1.4 + i * 1.8}"/></svg></button>`).join('')}`;
  document.body.appendChild(lmenuEl);
  const r = btn.getBoundingClientRect();
  const mw = lmenuEl.offsetWidth;
  lmenuEl.style.left = `${Math.max(8, Math.min(window.innerWidth - mw - 8, r.left + r.width / 2 - mw / 2))}px`;
  lmenuEl.style.top = `${r.top - lmenuEl.offsetHeight - 10}px`;
  lmenuEl.addEventListener('pointerenter', () => clearTimeout(lmenuTimer));
  lmenuEl.addEventListener('pointerleave', () => hideLineMenu(true));

  // The choices apply to what is selected as well as to what is drawn next,
  // exactly as the toolbar row did. The popup updates its own active states
  // rather than repainting the bar, so it stays open for a second choice.
  const mark = (attr, val) => lmenuEl?.querySelectorAll(`[data-${attr}]`).forEach((o) => {
    o.classList.toggle('on', o.dataset[attr] === String(val));
  });
  lmenuEl.querySelectorAll('[data-head]').forEach((b) => {
    b.onclick = () => {
      cur.head = b.dataset.head;
      saveSettings({ arrowHead: cur.head });
      const arrows = selEls().filter((z) => z.type === 'arrow');
      if (arrows.length) { snapshot(); arrows.forEach((z) => { z.head = cur.head; }); markDirty(); }
      mark('head', cur.head);
      render();
    };
  });
  lmenuEl.querySelectorAll('[data-weight]').forEach((b) => {
    b.onclick = () => {
      const wpx = Number(b.dataset.weight);
      saveSettings({ arrowPx: wpx });
      const lines = selEls().filter((z) => z.type === 'arrow' || z.type === 'pen');
      if (lines.length) {
        snapshot();
        lines.forEach((z) => { z.width = Math.max(2, Math.round(wpx * scaleF())); });
        markDirty();
      }
      mark('weight', wpx);
      render();
    };
  });
}

// ---------------------------------------------------------- context menus
//
// One small popup serves both right-click menus: the object menu on the ice
// and the customize menu on a colour preset. It closes on Escape, on any
// press outside it, and as soon as an item runs.

let ctxEl = null;

function onMenuAway(e) { if (ctxEl && !ctxEl.contains(e.target)) closeMenu(); }
function onMenuKey(e) {
  if (e.key !== 'Escape') return;
  e.preventDefault();
  e.stopPropagation();
  closeMenu();
}
function closeMenu() {
  if (!ctxEl) return;
  window.removeEventListener('pointerdown', onMenuAway, true);
  window.removeEventListener('keydown', onMenuKey, true);
  ctxEl.remove();
  ctxEl = null;
}

// `items` are { label, hint?, swatch?, run } objects, or the string 'sep'.
function showMenu(items, clientX, clientY) {
  closeMenu();
  ctxEl = document.createElement('div');
  ctxEl.className = 'ctxmenu';
  ctxEl.innerHTML = items.map((it, i) => (it === 'sep'
    ? '<div class="ctx-sep"></div>'
    : `<button class="ctx-item" data-i="${i}">`
      + (it.swatch ? `<span class="ctx-dot" style="--c:${it.swatch}"></span>` : '')
      + `<span class="ctx-label">${esc(it.label)}</span>`
      + (it.hint ? `<span class="ctx-hint">${esc(it.hint)}</span>` : '')
      + '</button>')).join('');
  document.body.appendChild(ctxEl);
  // Clamp into the viewport. The toolbar sits at the bottom of the window, so
  // a menu opened from a preset would otherwise hang off the bottom edge.
  const w = ctxEl.offsetWidth;
  const h = ctxEl.offsetHeight;
  ctxEl.style.left = `${Math.max(8, Math.min(window.innerWidth - w - 8, clientX))}px`;
  ctxEl.style.top = `${Math.max(8, Math.min(window.innerHeight - h - 8, clientY))}px`;
  ctxEl.querySelectorAll('[data-i]').forEach((b) => {
    b.onclick = () => {
      const it = items[Number(b.dataset.i)];
      closeMenu();
      it.run();
    };
  });
  // Deferred so the press that opened the menu does not immediately close it.
  setTimeout(() => {
    if (!ctxEl) return;
    window.addEventListener('pointerdown', onMenuAway, true);
    window.addEventListener('keydown', onMenuKey, true);
  }, 0);
}

function deleteSel() {
  if (!cur) return;
  const ids = new Set(cur.selIds || []);
  if (!ids.size) return;
  snapshot();
  cur.elements = cur.elements.filter((z) => !ids.has(z.id));
  setSel([]);
  render();
  markDirty();
}

// Right-click on the ice. Over an object it opens the object menu; over empty
// ice it is left alone so the browser's own menu still works.
function onCanvasMenu(e) {
  if (!cur) return;
  const hit = e.target.closest?.('[data-id]');
  const x = hit ? cur.elements.find((z) => z.id === hit.dataset.id) : hitAt(pt(e));
  if (!x) return;
  e.preventDefault();
  if (!(cur.selIds || []).includes(x.id)) { setSel([x.id]); render(); }
  const n = (cur.selIds || []).length;
  showMenu([
    { label: 'Bring To Front', hint: ']', run: () => stackSel(true) },
    { label: 'Send To Back', hint: '[', run: () => stackSel(false) },
    'sep',
    { label: 'Flip Selection', hint: 'Flip', run: () => void flipH() },
    { label: 'Duplicate', hint: 'Cmd D', run: () => { pasteCount = 0; pasteEls(selEls()); } },
    'sep',
    { label: n > 1 ? `Delete ${n} Objects` : 'Delete', hint: 'Del', run: () => deleteSel() },
  ], e.clientX, e.clientY);
}

// The colour choices offered on a preset. Black, blue, grey, green and red are
// the named palette slots that travel to Film Room; the rest are raw hexes,
// which the storage format allows on any element.
const PRESET_CHOICES = [
  ['Black', INK],
  ['Blue', '#75d8ff'],
  ['Grey', '#d9d9d9'],
  ['Green', '#16a34a'],
  ['Red', '#dc2626'],
  ['Orange', '#f59e0b'],
  ['Purple', '#8b5cf6'],
  ['White', '#ffffff'],
];

function applySlotHex(i, hex) {
  const pal = paletteHexes();
  pal[i] = hex;
  saveSettings({ palette: pal });
  cur.color = slotColor(i);
  // Text is skipped here for the same reason it is skipped everywhere: text
  // chips are always black.
  const styled = selEls().filter((z) => 'color' in z && z.type !== 'text');
  if (styled.length) { snapshot(); styled.forEach((z) => { z.color = cur.color; }); markDirty(); }
  toolsSig = '';
  render();
}

function pickCustomColor(i) {
  const input = document.createElement('input');
  input.type = 'color';
  input.value = paletteHexes()[i];
  input.style.cssText = 'position:fixed;left:12px;bottom:12px;width:1px;height:1px;opacity:0;';
  document.body.appendChild(input);
  input.oninput = () => applySlotHex(i, input.value);
  input.onchange = () => input.remove();
  input.click();
}

function showSwatchMenu(i, btn, clientX, clientY) {
  const now = paletteHexes()[i].toLowerCase();
  const items = PRESET_CHOICES.map(([name, hex]) => ({
    label: now === hex.toLowerCase() ? `${name} (Current)` : name,
    swatch: hex,
    run: () => applySlotHex(i, hex),
  }));
  items.push('sep');
  items.push({ label: 'Custom Color…', run: () => pickCustomColor(i) });
  items.push({ label: 'Reset To Default', swatch: DEFAULT_PALETTE[i], run: () => applySlotHex(i, DEFAULT_PALETTE[i]) });
  const r = btn.getBoundingClientRect();
  showMenu(items, clientX ?? r.left, clientY ?? r.top);
}

function paintTools() {
  const bar = el('edBar');
  if (!bar || !cur) return;
  hidePlayerMenu();
  hideLineMenu();
  const hexes = paletteHexes();

  bar.innerHTML = `
    ${TOOLS.map(([t, label]) => `<button class="tb-btn${cur.tool === t ? ' on' : ''}" data-tool="${t}" aria-label="${label}">${ICON[t]}${keyBadge(t)}</button>`).join('')}
    ${sep}
    ${PLAYER_SLOTS.map((i) => `<button class="tb-player${cur.tool === `p-${i}` ? ' on' : ''}" data-tool="p-${i}" data-slot-menu="${i}" aria-label="Player ${i + 1}" style="--c:${colorOf(slotColor(i))}"></button>`).join('')}
    <button class="tb-btn tb-word" data-act="faceoff" aria-label="5v5 Faceoff">5v5${keyBadge('faceoff')}</button>
    ${sep}
    ${ITEM_ORDER.map((k) => `<button class="tb-btn${cur.tool === `i-${k}` ? ' on' : ''}" data-tool="i-${k}" aria-label="${ITEMS[k].label}">${itemIcon(k)}${keyBadge(`i-${k}`)}</button>`).join('')}
    ${sep}
    ${hexes.map((hex, i) => `<button class="tb-swatch${cur.color === slotColor(i) ? ' on' : ''}" data-slot="${i}" style="--c:${hex}" aria-label="Color Preset ${i + 1}"></button>`).join('')}`;

  bar.querySelectorAll('[data-tool]').forEach((b) => {
    b.onclick = () => {
      if (b.dataset.tool.startsWith('p-')) {
        // A second click on the armed player button opens the letter menu -
        // the touch path to it (hover covers the mouse path).
        if (cur.tool === b.dataset.tool) { showPlayerMenu(Number(b.dataset.tool.slice(2)), b); return; }
        cur.pendingLabel = null;
      }
      // Same for the line tools and their head / weight options.
      if (LINE_TOOLS.has(b.dataset.tool) && cur.tool === b.dataset.tool) {
        showLineMenu(b.dataset.tool, b);
        return;
      }
      setTool(b.dataset.tool);
    };
    b.oncontextmenu = (e) => {
      e.preventDefault();
      const toolId = b.dataset.tool;
      capturing = { toolId, label: toolLabel(toolId) };
      toast(`Press A Key For ${toolLabel(toolId)} (Esc Cancels)`);
    };
  });
  bar.querySelectorAll('[data-slot-menu]').forEach((b) => {
    const i = Number(b.dataset.slotMenu);
    b.addEventListener('pointerenter', (e) => { if (e.pointerType === 'mouse') showPlayerMenu(i, b); });
    b.addEventListener('pointerleave', () => hidePlayerMenu(true));
  });
  bar.querySelectorAll('[data-tool]').forEach((b) => {
    if (!LINE_TOOLS.has(b.dataset.tool)) return;
    b.addEventListener('pointerenter', (e) => { if (e.pointerType === 'mouse') showLineMenu(b.dataset.tool, b); });
    b.addEventListener('pointerleave', () => hideLineMenu(true));
  });
  bar.querySelectorAll('[data-slot]').forEach((b) => {
    const i = Number(b.dataset.slot);
    b.onclick = () => chooseSlot(i);
    // Right-click (or double-click) a preset to change what colour it holds.
    const customize = (e) => {
      e.preventDefault();
      showSwatchMenu(i, b, e.clientX, e.clientY);
    };
    b.ondblclick = customize;
    b.oncontextmenu = customize;
  });
  const act = (name, fn) => { const b = bar.querySelector(`[data-act="${name}"]`); if (b) b.onclick = fn; };
  act('faceoff', () => placeFaceoff());
  // The "+ Add Rink" bar sits under the bottom rink, not in the toolbar.
  const ab = el('edAddBar');
  const db2 = el('edDupBar');
  const canAdd = onRink() && (cur.seq || 1) < SEQ_MAX;
  if (ab) { ab.hidden = !canAdd; ab.onclick = () => void addRink(false); }
  if (db2) { db2.hidden = !canAdd; db2.onclick = () => void addRink(true); }
  sizeStage();
  if (hooks.onFrames) hooks.onFrames(frameInfo());
}

function chooseSlot(i) {
  cur.color = slotColor(i);
  const styled = selEls().filter((z) => 'color' in z && z.type !== 'text');
  if (styled.length) { snapshot(); styled.forEach((z) => { z.color = cur.color; }); markDirty(); }
  toolsSig = '';
  render();
}

function setTool(t) {
  cur.tool = t;
  render();
}

// ------------------------------------------------------------ zoom / pan

// No zoom, on purpose (Tony 2026-08-24): the canvas sits at one optimal
// size per window so a whole rink and its controls are always visible.
// Sequences scroll vertically; nothing pans or scales under the trackpad.
function sizeStage() {
  const wrap = el('edStageWrap');
  const z = el('edZoom');
  if (!wrap || !z || !cur) return;
  // clientWidth INCLUDES the wrap's padding, and that padding is a clamp()
  // that reaches 40px per side - so the old flat "- 40" undercounted by up
  // to 40px and, with sideways scrolling now clipped, cut the rink's right
  // edge off whenever the width branch won. Measure the real padding.
  const cs = getComputedStyle(wrap);
  const pad = (parseFloat(cs.paddingLeft) || 0) + (parseFloat(cs.paddingRight) || 0);
  const availW = Math.max(280, wrap.clientWidth - pad - 2);
  const availH = Math.max(300, wrap.clientHeight - 110);
  const unit = onRink() ? VTOP + RINK_H + 70 : totalVH();
  const w = Math.min(availW, (availH / unit) * cur.w);
  // The 360px floor guards tiny windows, but must never exceed what fits.
  z.style.width = `${Math.round(Math.max(Math.min(360, availW), w))}px`;
}

// ------------------------------------------------------------- image ops

// Mirror one element about the vertical line at `twoA / 2`. Pulled out of
// flipH so a selection flip and a whole-diagram flip run identical maths: a
// point px maps to (twoA - px).
function mirrorEl(x, twoA) {
  if (x.type === 'stamp') { x.x = twoA - x.x - x.w; x.flip = !x.flip; }
  else if (x.type === 'pucks' || x.type === 'box' || x.type === 'circle') x.x = twoA - x.x - x.w;
  else if (x.type === 'player') x.x = twoA - x.x;
  else if (x.type === 'text') x.x = twoA - x.x - measureText(x);
  else if (x.type === 'arrow') { x.x1 = twoA - x.x1; x.x2 = twoA - x.x2; x.mx = twoA - x.mx; }
  else if (x.type === 'pen') x.pts = x.pts.map(([px, py]) => [twoA - px, py]);
  if (x.rot) x.rot = -x.rot;
}

async function flipH() {
  // WITH A SELECTION, FLIP ONLY THAT (Tony's call 2026-08-24), mirrored about
  // the selection's own centre so it turns in place instead of jumping across
  // the ice. The rink art is never touched on this path.
  const sel = selEls();
  if (sel.length) {
    snapshot();
    let x0 = Infinity; let x1 = -Infinity;
    for (const z of sel) {
      const b = elBounds(z);
      x0 = Math.min(x0, b.x);
      x1 = Math.max(x1, b.x + b.w);
    }
    for (const z of sel) mirrorEl(z, x0 + x1);
    render();
    markDirty();
    return;
  }
  snapshot();
  if (cur.bgKind === 'image') {
    const c = document.createElement('canvas');
    c.width = cur.w; c.height = cur.h;
    const ctx = c.getContext('2d');
    ctx.translate(cur.w, 0);
    ctx.scale(-1, 1);
    ctx.drawImage(cur.bgImg, 0, 0);
    await setImageBackground(c.toDataURL('image/png'));
  }
  for (const x of cur.elements) mirrorEl(x, cur.w);
  render();
  markDirty();
}

// ------------------------------------------------------------- stacking
//
// Z-ORDER IS ARRAY ORDER. Both renderers walk cur.elements back to front, so
// "bring to front" is simply "move to the end". Relative order inside the
// selection is preserved, so sending a group forward twice is a no-op.
function stackSel(toFront) {
  if (!cur) return;
  const ids = new Set(cur.selIds || []);
  if (!ids.size) return;
  const picked = cur.elements.filter((z) => ids.has(z.id));
  const rest = cur.elements.filter((z) => !ids.has(z.id));
  const next = toFront ? [...rest, ...picked] : [...picked, ...rest];
  if (next.every((z, i) => z === cur.elements[i])) return; // already there
  snapshot();
  cur.elements = next;
  render();
  markDirty();
}

function rinkFurniture(yOff = 0) {
  const d = defaults();
  const net = ITEMS.net;
  return [
    { id: uid(), type: 'stamp', name: 'net', flip: false, x: RINK.goalL - net.w, y: yOff + RINK.midY - net.h / 2, w: net.w, h: net.h },
    { id: uid(), type: 'stamp', name: 'net', flip: true, x: RINK.goalR, y: yOff + RINK.midY - net.h / 2, w: net.w, h: net.h },
    { id: uid(), type: 'player', color: 'black', label: 'G', x: RINK.creaseL + 20, y: yOff + RINK.midY, r: d.playerR },
    { id: uid(), type: 'player', color: 'blue', label: 'G', x: RINK.creaseR - 20, y: yOff + RINK.midY, r: d.playerR },
  ];
}

function placeFaceoff() {
  if (!onRink()) return;
  const d = defaults();
  const yOff = ((cur.seq || 1) - 1) * (RINK_H + SEQ_GAP);
  const C = RINK.center; const MY = RINK.midY;
  const spots = [
    [-62, 0, 'C'],
    [-70, -330, 'LW'],
    [-70, 330, 'RW'],
    [-370, -180, 'LD'],
    [-370, 180, 'RD'],
  ];
  snapshot();
  for (const [dx, dy, label] of spots) {
    cur.elements.push({ id: uid(), type: 'player', color: 'black', label, x: C + dx, y: yOff + MY + dy, r: d.playerR });
  }
  for (const [dx, dy] of spots) {
    cur.elements.push({ id: uid(), type: 'player', color: 'blue', label: '', x: C - dx, y: yOff + MY + dy, r: d.playerR });
  }
  markDirty();
  render();
  toast('5v5 Faceoff Placed - Black Left, Blue Right');
}

function frameOf(x) {
  return Math.max(0, Math.floor(centerOf(x).y / (RINK_H + SEQ_GAP)));
}

async function addRink(duplicate = false) {
  if (!onRink() || (cur.seq || 1) >= SEQ_MAX) return;
  snapshot();
  const n = (cur.seq || 1) + 1;
  if (!cur.rinkNames?.length) cur.rinkNames = ['Rink 1'];
  cur.rinkNames[n - 1] = `Rink ${n}`;
  cur.seq = n;
  setRinkBackground(n);
  const shift = RINK_H + SEQ_GAP;
  if (duplicate) {
    const above = cur.elements.filter((x) => frameOf(x) === n - 2);
    const clones = above.map((x) => {
      const z = structuredClone(x);
      z.id = uid();
      moveElTo(z, centerOf(z).x, centerOf(z).y + shift);
      return z;
    });
    cur.elements.push(...(clones.length ? clones : rinkFurniture((n - 1) * shift)));
  } else {
    cur.elements.push(...rinkFurniture((n - 1) * shift));
  }
  render();
  sizeStage();
  markDirty();
  toast(duplicate ? `Rink ${n} Added - A Copy Of The One Above` : `Rink ${n} Added - Blank And Game-Ready`);
}

// Remove ANY rink of a sequence; the ones below slide up.
function removeFrame(k) {
  if (!onRink() || (cur.seq || 1) <= 1 || k < 0 || k >= cur.seq) return;
  snapshot();
  const shift = RINK_H + SEQ_GAP;
  cur.elements = cur.elements.filter((x) => frameOf(x) !== k);
  for (const x of cur.elements) {
    if (frameOf(x) > k) moveElTo(x, centerOf(x).x, centerOf(x).y - shift);
  }
  if (cur.rinkNames) cur.rinkNames.splice(k, 1);
  cur.seq -= 1;
  if (cur.seq === 1) cur.rinkNames = [];
  setRinkBackground(cur.seq);
  setSel([]);
  render();
  markDirty();
  toast(`Rink Removed - ${cur.seq} Left. Cmd+Z Brings It Back`);
}

// Swap a rink with its neighbour - everything on both frames rides along.
function moveFrame(k, dir) {
  const j = k + dir;
  if (!onRink() || j < 0 || j >= (cur.seq || 1)) return;
  snapshot();
  const shift = (RINK_H + SEQ_GAP) * dir;
  for (const x of cur.elements) {
    const f = frameOf(x);
    if (f === k) moveElTo(x, centerOf(x).x, centerOf(x).y + shift);
    else if (f === j) moveElTo(x, centerOf(x).x, centerOf(x).y - shift);
  }
  if (cur.rinkNames) {
    const t = cur.rinkNames[k];
    cur.rinkNames[k] = cur.rinkNames[j];
    cur.rinkNames[j] = t;
  }
  setSel([]);
  render();
  markDirty();
  toast(`Rink Moved ${dir < 0 ? 'Up' : 'Down'}`);
}

async function frameCanvas(k) {
  await saveNow();
  const full = await renderFlat();
  return sliceFrames(full, [k]);
}

async function copyFrame(k) {
  try {
    const c = await frameCanvas(k);
    const blob = await new Promise((res) => c.toBlob(res, 'image/png'));
    await navigator.clipboard.write([new ClipboardItem({ 'image/png': blob })]);
    toast(`${(cur.rinkNames?.[k] || `Rink ${k + 1}`)} Copied - Paste It Anywhere`);
  } catch (e) {
    console.error(e);
    toast('Copy Needs Clipboard Permission - Use Download Instead', true);
  }
}

async function downloadFrame(k) {
  const c = await frameCanvas(k);
  const a = document.createElement('a');
  a.href = c.toDataURL('image/png');
  a.download = `${fileStem(cur.drill.name)}-${fileStem(cur.rinkNames?.[k] || `rink-${k + 1}`)}.png`;
  a.click();
  toast('Rink PNG Downloaded');
}

// ---------------------------------------------------- element clipboard

let clipboardEls = null;
let pasteCount = 0;

function copySel(cut = false) {
  const list = selEls();
  if (!list.length) return false;
  clipboardEls = structuredClone(list);
  pasteCount = 0;
  if (cut) {
    snapshot();
    const ids = new Set(list.map((z) => z.id));
    cur.elements = cur.elements.filter((z) => !ids.has(z.id));
    setSel([]);
    markDirty();
    render();
  }
  return true;
}

function pasteEls(clones) {
  if (!cur || !clones?.length) return;
  snapshot();
  pasteCount += 1;
  const off = 30 * scaleF() * pasteCount;
  const ids = [];
  for (const clone of clones) {
    const x = structuredClone(clone);
    x.id = uid();
    moveElTo(x, centerOf(x).x + off, centerOf(x).y + off);
    cur.elements.push(x);
    ids.push(x.id);
  }
  setSel(ids);
  markDirty();
  render();
}

// ------------------------------------------------------------ interaction

let drag = null;
const pointers = new Map();
let gesture = null;
let lastDown = { t: 0, x: 0, y: 0 };

function placeItem(kind, p, e) {
  const d = defaults();
  const s = scaleF();
  if (kind.startsWith('p-')) {
    const hit = hitAt(p);
    if (hit && hit.type === 'player' && Math.hypot(p.x - hit.x, p.y - hit.y) <= hit.r) {
      setTool('select');
      setSel([hit.id]);
      render();
      return;
    }
  }
  snapshot();
  const snapped = snapCenter(p.x, p.y, null, false);
  const id = uid();
  if (kind.startsWith('p-')) {
    const label = (cur.pendingLabel || '').slice(0, 2);
    cur.elements.push({ id, type: 'player', color: slotColor(Number(kind.slice(2))), x: snapped.x, y: snapped.y, r: d.playerR, label });
  } else {
    const key = kind.slice(2);
    const it = ITEMS[key];
    const w = it.w * s; const h = it.h * s;
    if (key === 'pucks') cur.elements.push({ id, type: 'pucks', x: snapped.x - w / 2, y: snapped.y - h / 2, w, h });
    else cur.elements.push({ id, type: 'stamp', name: it.file, flip: false, x: snapped.x - w / 2, y: snapped.y - h / 2, w, h });
  }
  setSel([id]);
  if (!e?.metaKey && !e?.ctrlKey) { cur.tool = 'select'; cur.pendingLabel = null; }
  markDirty();
  render();
}

// Double-press editing: text chips retype, players re-letter, shapes label,
// rink chips rename.
function handleDouble(e) {
  const hitEl = e.target.closest?.('[data-id]');
  const x = hitEl ? cur.elements.find((z) => z.id === hitEl.dataset.id) : hitAt(pt(e));
  if (!x) return;
  if (x.type === 'player') {
    setSel([x.id]);
    render();
    openTextInput({
      p: { x: x.x, y: x.y },
      initial: x.label || '',
      size: Math.round(x.r * 0.9),
      maxLen: 2,
      centered: true,
      commit: (text) => {
        snapshot();
        x.label = text.trim().slice(0, 2).toUpperCase();
        markDirty();
        render();
      },
    });
    return;
  }
  if (x.type === 'box' || x.type === 'circle') {
    setSel([x.id]);
    render();
    openTextInput({
      p: rotCenterOf(x),
      initial: x.label || '',
      size: shapeLabelSize(x),
      centered: true,
      commit: (text) => {
        snapshot();
        x.label = text.trim();
        markDirty();
        render();
      },
    });
    return;
  }
  if (x.type === 'text') {
    setSel([x.id]);
    cur.hideId = x.id;
    render();
    openChipInput({
      baseline: { x: x.x, y: x.y },
      initial: x.text || '',
      size: x.size,
      color: x.color,
      commit: (text) => {
        snapshot();
        if (!text.trim()) cur.elements = cur.elements.filter((z) => z.id !== x.id);
        else x.text = text.trim();
        markDirty();
      },
      onClose: () => { cur.hideId = null; render(); },
    });
  }
}

function onDown(e) {
  if (!cur) return;
  // A press anywhere outside an open text field commits it first -
  // preventDefault below stops the browser's own focus transfer, so the
  // blur that would normally close it never fires on its own.
  if (activeFinish && e.target?.id !== 'edInput') {
    const f = activeFinish;
    activeFinish = null;
    f(true);
  }
  pointers.set(e.pointerId, { x: e.clientX, y: e.clientY });
  if (pointers.size === 2) {
    // A second finger cancels the drag; two-finger motion just scrolls.
    if (drag) { onUp(e); }
    gesture = true;
    return;
  }
  if (gesture) return;
  if (e.pointerType === 'mouse' && e.button !== 0) return;

  // Rink control cluster - single click, never a drag.
  const rctl = e.target.closest?.('[data-rctl]');
  if (rctl) {
    e.preventDefault();
    const k = Number(rctl.dataset.frame);
    const a = rctl.dataset.rctl;
    if (a === 'up') moveFrame(k, -1);
    else if (a === 'down') moveFrame(k, 1);
    else if (a === 'copy') void copyFrame(k);
    else if (a === 'dl') void downloadFrame(k);
    else if (a === 'link') hooks.onRinkLink?.(k);
    else if (a === 'del') removeFrame(k);
    return;
  }

  // The frame label renames on a single click, Figma-style.
  const flab = e.target.closest?.('[data-rframe]');
  if (flab) {
    e.preventDefault();
    openFrameLabelInput(Number(flab.dataset.rframe));
    return;
  }

  // Native dblclick is suppressed by preventDefault on pointerdown, so
  // detect the double press here.
  const now = performance.now();
  const isDouble = now - lastDown.t < 400 && Math.hypot(e.clientX - lastDown.x, e.clientY - lastDown.y) < 14;
  lastDown = { t: now, x: e.clientX, y: e.clientY };
  if (isDouble && (cur.tool === 'select' || cur.tool.startsWith('p-'))) {
    lastDown.t = 0;
    drag = null;
    e.preventDefault();
    handleDouble(e);
    return;
  }

  const p = pt(e);
  const handle = e.target.closest?.('[data-h]');

  if (handle && cur.sel) {
    const x = cur.elements.find((z) => z.id === cur.sel);
    if (x) {
      snapshot();
      drag = { kind: `h:${handle.dataset.h}`, id: x.id, start: p, orig: structuredClone(x), moved: false };
      e.preventDefault();
      return;
    }
  }

  if (cur.tool === 'select') {
    const hitEl = e.target.closest?.('[data-id]');
    const x = hitEl ? cur.elements.find((z) => z.id === hitEl.dataset.id) : hitAt(p);
    if (x) {
      const inSel = (cur.selIds || []).includes(x.id);
      if (e.shiftKey) {
        setSel(inSel ? cur.selIds.filter((i) => i !== x.id) : [...cur.selIds, x.id]);
        render();
        e.preventDefault();
        return;
      }
      if (!inSel) setSel([x.id]);
      else cur.sel = x.id;
      snapshot();
      const origs = new Map(selEls().map((z) => [z.id, structuredClone(z)]));
      drag = { kind: 'move', id: x.id, start: p, orig: structuredClone(x), origs, moved: false };
    } else {
      setSel([]);
      cur.band = { x1: p.x, y1: p.y, x2: p.x, y2: p.y };
      drag = { kind: 'band', start: p, moved: false };
    }
    render();
    e.preventDefault();
    return;
  }

  if (LINE_SPEC[cur.tool]) {
    snapshot();
    const d = defaults();
    const a = {
      id: uid(), type: 'arrow', x1: p.x, y1: p.y, x2: p.x, y2: p.y, mx: p.x, my: p.y,
      color: cur.color, width: d.stroke, dash: !!LINE_SPEC[cur.tool]?.dash,
      ...(LINE_SPEC[cur.tool]?.motion ? { motion: LINE_SPEC[cur.tool].motion } : {}),
      head: cur.head || 'triangle',
    };
    cur.elements.push(a);
    drag = { kind: 'newArrow', id: a.id, start: p, moved: false };
    e.preventDefault();
    return;
  }

  if (cur.tool === 'box' || cur.tool === 'circle') {
    snapshot();
    const b = { id: uid(), type: cur.tool, x: p.x, y: p.y, w: 0, h: 0, color: cur.color, alpha: 0.3 };
    cur.elements.push(b);
    drag = { kind: 'newBox', id: b.id, start: p, moved: false };
    e.preventDefault();
    return;
  }

  if (cur.tool.startsWith('p-') || cur.tool.startsWith('i-')) {
    placeItem(cur.tool, p, e);
    return;
  }

  if (cur.tool === 'text') {
    // Drop an empty Title chip with the caret inside - typing grows it, and
    // it looks exactly as it will once committed.
    const d = defaults();
    openChipInput({
      baseline: p,
      initial: '',
      size: d.text,
      color: cur.color,
      commit: (text) => {
        if (!text.trim()) return;
        snapshot();
        const id = uid();
        // Text chips are ALWAYS black (Tony's call 2026-08-24). The `color`
        // property stays on the element because it is part of the stored and
        // Film Room interchange format - it is just never set to anything else.
        cur.elements.push({ id, type: 'text', x: p.x, y: p.y, text: text.trim(), size: d.text, color: 'black' });
        setSel([id]);
        markDirty();
      },
      onClose: () => { cur.tool = 'select'; render(); },
    });
    return;
  }

  if (cur.tool === 'pen') {
    snapshot();
    const d = defaults();
    const pen = { id: uid(), type: 'pen', pts: [[p.x, p.y]], color: cur.color, width: d.pen };
    cur.elements.push(pen);
    drag = { kind: 'pen', id: pen.id, start: p, moved: false };
    e.preventDefault();
  }
}

function onMove(e) {
  if (!cur) return;
  if (pointers.has(e.pointerId)) pointers.set(e.pointerId, { x: e.clientX, y: e.clientY });
  if (gesture && pointers.size >= 2) return;
  if (!drag) return;
  if (e.pointerType === 'mouse' && !(e.buttons & 1)) { onUp(e); return; }
  const p = pt(e);
  const dx = p.x - drag.start.x;
  const dy = p.y - drag.start.y;
  drag.moved = drag.moved || Math.hypot(dx, dy) > 2;
  const x = drag.id ? cur.elements.find((z) => z.id === drag.id) : null;
  cur.guides = [];

  if (drag.kind === 'move' && x) {
    const origCopy = structuredClone(drag.orig);
    const c0 = centerOf(origCopy);
    const groupIds = new Set([...(drag.origs?.keys() || [x.id])]);
    const snapped = snapCenter(c0.x + dx, c0.y + dy, groupIds, e.metaKey || e.ctrlKey);
    const adx = snapped.x - c0.x;
    const ady = snapped.y - c0.y;
    for (const [id, orig] of (drag.origs || new Map([[x.id, drag.orig]]))) {
      const z = cur.elements.find((q) => q.id === id);
      if (!z) continue;
      Object.assign(z, structuredClone(orig));
      const oc = centerOf(orig);
      moveElTo(z, oc.x + adx, oc.y + ady);
    }
    cur.guides = snapped.guides;
  } else if (drag.kind === 'band') {
    cur.band.x2 = p.x;
    cur.band.y2 = p.y;
    const bx1 = Math.min(cur.band.x1, cur.band.x2);
    const bx2 = Math.max(cur.band.x1, cur.band.x2);
    const by1 = Math.min(cur.band.y1, cur.band.y2);
    const by2 = Math.max(cur.band.y1, cur.band.y2);
    setSel(cur.elements.filter((z) => {
      const b = elBounds(z);
      return b.x + b.w > bx1 && b.x < bx2 && b.y + b.h > by1 && b.y < by2;
    }).map((z) => z.id));
  } else if (drag.kind === 'newBox' && x) {
    x.x = Math.min(drag.start.x, p.x);
    x.y = Math.min(drag.start.y, p.y);
    x.w = Math.abs(p.x - drag.start.x);
    x.h = Math.abs(p.y - drag.start.y);
  } else if (drag.kind === 'newArrow' && x) {
    x.x2 = p.x; x.y2 = p.y;
    x.mx = (x.x1 + x.x2) / 2; x.my = (x.y1 + x.y2) / 2;
  } else if (drag.kind === 'h:a1' && x) { x.x1 = p.x; x.y1 = p.y; }
  else if (drag.kind === 'h:a2' && x) { x.x2 = p.x; x.y2 = p.y; }
  else if (drag.kind === 'h:mid' && x) { x.mx = p.x; x.my = p.y; }
  else if (drag.kind === 'h:rot' && x) {
    const c = rotCenterOf(drag.orig);
    let deg = (Math.atan2(p.y - c.y, p.x - c.x) * 180) / Math.PI + 90;
    if (!e.metaKey && !e.ctrlKey) deg = Math.round(deg / 15) * 15;
    deg = ((deg % 360) + 360) % 360;
    x.rot = deg === 0 ? undefined : deg;
    if (x.rot === undefined) delete x.rot;
  } else if (drag.kind === 'h:se' && x) {
    const o = drag.orig;
    // Resize in the element's own (rotated) space.
    const rad = (-(o.rot || 0) * Math.PI) / 180;
    const ldx = dx * Math.cos(rad) - dy * Math.sin(rad);
    const ldy = dx * Math.sin(rad) + dy * Math.cos(rad);
    if (x.type === 'box' || x.type === 'circle') {
      x.w = Math.max(24, o.w + ldx);
      x.h = Math.max(24, o.h + ldy);
    } else if (x.type === 'stamp' || x.type === 'pucks') {
      const sc = Math.max(0.2, Math.max((o.w + ldx) / o.w, (o.h + ldy) / o.h));
      x.w = o.w * sc; x.h = o.h * sc;
    } else if (x.type === 'player') {
      x.r = Math.max(8, o.r + Math.max(ldx, ldy) / 2);
    } else if (x.type === 'text') {
      x.size = Math.max(10, o.size + ldy);
    }
  } else if (drag.kind === 'pen' && x) {
    const last = x.pts[x.pts.length - 1];
    if (Math.hypot(p.x - last[0], p.y - last[1]) > 3) x.pts.push([p.x, p.y]);
  }
  render();
}

function onUp(e) {
  if (e) pointers.delete(e.pointerId);
  if (gesture && pointers.size < 2) gesture = null;
  if (!cur || !drag) return;
  const x = drag.id ? cur.elements.find((z) => z.id === drag.id) : null;
  cur.guides = [];
  if (drag.kind === 'band') {
    cur.band = null;
  } else if (drag.kind === 'newArrow' && x && !drag.moved) {
    cur.elements = cur.elements.filter((z) => z.id !== x.id);
    cur.undo.pop();
  } else if (drag.kind === 'newArrow' && x) {
    setSel([x.id]);
    cur.tool = 'select';
    markDirty();
  } else if (drag.kind === 'newBox' && x && (!drag.moved || x.w < 12 * scaleF() || x.h < 12 * scaleF())) {
    cur.elements = cur.elements.filter((z) => z.id !== x.id);
    cur.undo.pop();
  } else if (drag.kind === 'newBox' && x) {
    setSel([x.id]);
    cur.tool = 'select';
    markDirty();
  } else if ((drag.kind === 'move' || drag.kind.startsWith('h:')) && !drag.moved) {
    cur.undo.pop();
  } else {
    if (drag.kind === 'pen' && !e?.metaKey && !e?.ctrlKey) cur.tool = 'select';
    markDirty();
  }
  drag = null;
  render();
}

// ----------------------------------------------------------- text inputs

// Screen offset (px, within the scroll body) for a LOGICAL point - applies
// the frame's visual shift and the sequence headroom.
function screenPos(p, useVisualY = false) {
  const body = el('edStageWrap');
  const svg = el('edSvg');
  const r = svg.getBoundingClientRect();
  const br = body.getBoundingClientRect();
  const scale = r.width / cur.w;
  const vy = useVisualY ? p.y : p.y + vShiftOfY(p.y);
  return {
    left: r.left - br.left + body.scrollLeft + p.x * scale,
    top: r.top - br.top + body.scrollTop + (vy + vTop()) * scale,
    scale,
  };
}

// A plain centred field (player letters, shape labels).
function openTextInput({ p, initial, size, commit, maxLen = 0, centered = false, onClose = null }) {
  document.getElementById('edInput')?.remove();
  const body = el('edStageWrap');
  const pos = screenPos(p);
  const input = document.createElement('input');
  input.id = 'edInput';
  input.className = 'ed-input';
  input.value = initial;
  if (maxLen) input.maxLength = maxLen;
  input.style.left = `${pos.left}px`;
  input.style.top = `${pos.top}px`;
  const fpx = Math.max(11, size * pos.scale);
  input.style.fontSize = `${fpx}px`;
  if (centered || maxLen === 2) {
    input.classList.add('ed-input-center');
    if (maxLen === 2) input.style.width = `${Math.max(30, Math.round(fpx * 2.4))}px`;
  }
  body.appendChild(input);
  wireInput(input, commit, onClose);
}

// Rename a rink from its frame label (single click, Figma-style).
function openFrameLabelInput(k) {
  document.getElementById('edInput')?.remove();
  cur.editLabel = k;
  render();
  const body = el('edStageWrap');
  const topV = k * (RINK_H + SEQ_GAP) + vShiftOf(k);
  const pos = screenPos({ x: FLABEL.x, y: topV - FLABEL.gapAbove }, true);
  const input = document.createElement('input');
  input.id = 'edInput';
  input.className = 'ed-input ed-input-flabel';
  input.value = (cur.rinkNames?.[k] || '').trim() || `Rink ${k + 1}`;
  input.maxLength = 40;
  input.style.left = `${pos.left}px`;
  input.style.top = `${pos.top}px`;
  input.style.fontSize = `${Math.max(11, FLABEL.size * pos.scale)}px`;
  body.appendChild(input);
  wireInput(input, (text) => {
    snapshot();
    if (!cur.rinkNames) cur.rinkNames = [];
    cur.rinkNames[k] = text.trim();
    markDirty();
  }, () => { if (cur) cur.editLabel = null; });
}

// The WYSIWYG Title-chip field: identical styling to the committed chip, so
// there is no jump between typing and clicking away. Grows as you type.
function openChipInput({ baseline, initial, size, color, commit, onClose = null }) {
  document.getElementById('edInput')?.remove();
  const body = el('edStageWrap');
  const T = TEXT_CHIP;
  // Frame shift comes from the BASELINE (safely inside the frame), not the
  // chip top, which can poke past the frame boundary.
  const pos = screenPos({ x: baseline.x - size * T.padX, y: baseline.y - size - size * T.padY + vShiftOfY(baseline.y) }, true);
  const scale = pos.scale;
  const fpx = Math.max(11, size * scale);
  const padX = fpx * T.padX;
  const padY = fpx * T.padY;
  const bw = Math.max(1.5, fpx * T.border);
  const input = document.createElement('input');
  input.id = 'edInput';
  input.className = 'ed-input-chip';
  input.value = initial;
  input.style.left = `${pos.left - bw / 2}px`;
  input.style.top = `${pos.top - bw / 2}px`;
  input.style.fontSize = `${fpx}px`;
  input.style.padding = `${padY}px ${padX}px`;
  input.style.borderWidth = `${bw}px`;
  input.style.borderRadius = `${fpx * T.radius}px`;
  input.style.height = `${fpx * T.height + padY * 2 + bw * 2}px`;
  input.style.color = colorOf(color);
  const grow = () => {
    const w = measureText({ size: fpx, text: input.value || ' ' });
    input.style.width = `${w + padX * 2 + bw * 2 + 3}px`;
  };
  input.addEventListener('input', grow);
  body.appendChild(input);
  grow();
  wireInput(input, commit, onClose);
}

let activeFinish = null; // onDown flushes this when a press lands elsewhere

function wireInput(input, commit, onClose) {
  let done = false;
  const finish = (keep) => {
    if (done) return;
    done = true;
    if (activeFinish === finish) activeFinish = null;
    const v = input.value;
    input.remove();
    if (keep) commit(v);
    if (onClose) onClose();
    render();
  };
  activeFinish = finish;
  input.onkeydown = (e) => {
    e.stopPropagation();
    if (e.key === 'Enter' || e.keyCode === 13) { e.preventDefault(); finish(true); }
    if (e.key === 'Escape') { e.preventDefault(); finish(false); }
  };
  input.onblur = () => finish(true);
  requestAnimationFrame(() => { input.focus(); input.select(); });
}

// ---------------------------------------------------------------- keyboard

function onKey(e) {
  if (!cur) return;
  const t = e.target;
  if (t && (t.tagName === 'INPUT' || t.tagName === 'TEXTAREA' || t.isContentEditable)) return;
  if (capturing) {
    e.preventDefault();
    e.stopPropagation();
    const { toolId, label } = capturing;
    capturing = null;
    if (e.key === 'Escape') { toast('Shortcut Unchanged'); return; }
    if (e.key.length !== 1 || e.metaKey || e.ctrlKey || e.altKey || e.key === ' ') {
      toast('Single Letter Or Number Keys Only', true);
      return;
    }
    const k = e.key.toLowerCase();
    const all = { ...customKeys() };
    for (const id of Object.keys(all)) if (String(all[id]).toLowerCase() === k) delete all[id];
    all[toolId] = k;
    saveSettings({ diagramKeys: all });
    toolsSig = '';
    render();
    toast(`${toolLabel(toolId)}: Now ${k.toUpperCase()}`);
    return;
  }
  if (e.metaKey || e.ctrlKey) {
    const k = e.key.toLowerCase();
    const stop = () => { e.preventDefault(); e.stopPropagation(); };
    if (k === 'z' && e.shiftKey) { stop(); void redo(); return; }
    if (k === 'z') { stop(); void undo(); return; }
    if (k === 'c' && cur.sel) { stop(); copySel(false); return; }
    if (k === 'x' && cur.sel) { stop(); copySel(true); return; }
    if (k === 'v' && clipboardEls?.length) { stop(); pasteEls(clipboardEls); return; }
    if (k === 'd' && cur.sel) {
      stop();
      pasteCount = 0;
      pasteEls(selEls());
      return;
    }
    // Cmd/Ctrl+S saves. The browser's own Save Page dialog is not something
    // Tony ever wants here, so it is preventDefaulted whether dirty or not.
    if (k === 's') { stop(); void saveNow(); return; }
    return;
  }
  if (e.key === 'Escape') {
    e.preventDefault();
    // An open popup is the innermost thing Escape should close.
    if (lmenuEl || pmenuEl) { hideLineMenu(); hidePlayerMenu(); return; }
    if (cur.tool !== 'select') { setTool('select'); return; }
    if (cur.sel) { setSel([]); render(); return; }
    return;
  }
  if (e.key === '?') {
    e.preventDefault();
    document.dispatchEvent(new CustomEvent('cthd:shortcuts'));
    return;
  }
  if (e.key === ']') { e.preventDefault(); stackSel(true); return; }
  if (e.key === '[') { e.preventDefault(); stackSel(false); return; }
  if (e.key === '+' || e.key === '=') { e.preventDefault(); void addRink(false); return; }
  if (e.key === '-' || e.key === '_') { e.preventDefault(); removeFrame((cur.seq || 1) - 1); return; }
  if ((e.key === 'Backspace' || e.key === 'Delete') && cur.sel) {
    e.preventDefault();
    snapshot();
    const ids = new Set(cur.selIds || []);
    cur.elements = cur.elements.filter((z) => !ids.has(z.id));
    setSel([]);
    markDirty();
    render();
    return;
  }
  const nud = { ArrowLeft: [-1, 0], ArrowRight: [1, 0], ArrowUp: [0, -1], ArrowDown: [0, 1] }[e.key];
  if (nud && cur.sel) {
    e.preventDefault();
    const step = (e.shiftKey ? 10 : 2) * (cur.w / 1000);
    const list = selEls();
    if (list.length) {
      snapshot();
      for (const x of list) {
        const c = centerOf(x);
        moveElTo(x, c.x + nud[0] * step, c.y + nud[1] * step);
      }
      markDirty();
      render();
    }
    return;
  }
  const k = e.key.toLowerCase();
  const id = effectiveKeys()[k];
  if (id) {
    e.preventDefault();
    if (id === 'faceoff') placeFaceoff();
    else if (id.startsWith('c-')) chooseSlot(Number(id.slice(2)));
    else {
      if (id.startsWith('p-')) cur.pendingLabel = null;
      setTool(id);
    }
  }
}

// ------------------------------------------------------------- open/close

export function editorActions() {
  return { flipH, undo, redo, renderFlat, currentState, markDirty };
}

export async function closeEditor() {
  if (!cur) return;
  const c = cur;
  clearTimeout(c.timer);
  // Drop any pending autosave. NO implicit save here: app.js has already
  // asked Tony what to do with unsaved work before routing away, and
  // writing anyway would make "Discard" a lie.
  cancelAutosave();
  cur = null;
  hooks = {};
  pointers.clear();
  gesture = null;
  drag = null;
  activeFinish = null;
  hidePlayerMenu();
  hideLineMenu();
  document.getElementById('edInput')?.remove();
}

export async function openEditor(drill, h = {}) {
  wireOnce();
  if (cur) await closeEditor();
  hooks = h || {};
  cur = {
    drill,
    elements: [],
    sel: null,
    selIds: [],
    band: null,
    tool: 'select',
    color: 'black',
    pendingLabel: null,
    hideId: null,
    head: settings().arrowHead || 'triangle',
    guides: [],
    seq: 1,
    rinkNames: [],
    editLabel: null,
    undo: [],
    redoStack: [],
    dirty: false,
    timer: null,
  };
  const st = drill.state;
  if (st && st.bg) {
    await setImageBackground(st.bg);
    cur.elements = structuredClone(st.elements || []);
    cur.seq = st.seq || 1;
  } else if (st && Array.isArray(st.elements)) {
    cur.seq = st.seq || 1;
    cur.rinkNames = structuredClone(st.rinkNames || []);
    if (cur.seq > 1 && !cur.rinkNames.length) {
      cur.rinkNames = Array.from({ length: cur.seq }, (_, k) => `Rink ${k + 1}`);
    }
    setRinkBackground(cur.seq);
    cur.elements = structuredClone(st.elements);
  } else {
    setRinkBackground(1);
    cur.elements = rinkFurniture(0);
    cur.dirty = true;
    markDirty();
  }
  toolsSig = '';
  render();
  sizeStage();
  status(cur.dirty ? 'Unsaved' : 'Saved');
}

// Window-level listeners attach once; the svg and wrap are rebuilt on every
// editor open, so their listeners re-attach each time to the fresh nodes.
function wireOnce() {
  if (!wired) {
    wired = true;
    window.addEventListener('pointermove', onMove);
    window.addEventListener('pointerup', onUp);
    window.addEventListener('pointercancel', onUp);
    window.addEventListener('keydown', onKey, true);
  }
  const svg = el('edSvg');
  svg.addEventListener('pointerdown', onDown);
  svg.addEventListener('contextmenu', onCanvasMenu);
  if (!sizeWired) {
    sizeWired = true;
    window.addEventListener('resize', () => sizeStage());
  }
}
let sizeWired = false;
