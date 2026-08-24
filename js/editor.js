// The diagram editor - a port of CTH Film Room's rink diagrammer, rebuilt
// as a standalone web editor with a floating toolbar, trackpad zoom and
// pan, customizable color presets, circle shapes, per-rink names, and
// touch support.
//
// Elements on top of the background:
//   - PLAYERS: three preset circles (double-click to letter, two chars).
//   - ARROWS (A) and DASHED ARROWS (D): three anchors - drag the middle one
//     to bend the line into a curve. Heads: solid, open, stop bar, none.
//   - RINK ITEMS: net, coach, puck, pucks pyramid, cone, border pad.
//   - SHADED BOX (B) and CIRCLE (C): translucent washes, double-click to
//     put a label inside. TEXT (T): a Title chip. PEN (P). FLIP.
//
// "+ Rink" stacks another rink below (up to 5) as a drill sequence, saved
// as one image. Rinks in a sequence can be named (double-click the chip or
// the empty top of a frame with Select). Snapping to landmarks and other
// objects with guides; Cmd disables. Multi-select: marquee, shift-click,
// group move, group clipboard. Undo depth 60.
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
  INK, PALETTE, colorOf, labelInkOn, measureText, arrowCtrl, arrowEndAngle,
  drawEl, drawRinkNames, TEXT_CHIP, RINK_CHIP, shapeLabelSize,
} from './flat.js';

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

// Four color presets. Slots keep the Film Room names while at their default
// value (so files interchange cleanly); a customized slot colors elements
// with its raw hex instead.
const DEFAULT_PALETTE = PALETTE.map(([, hex]) => hex);
const SLOT_NAMES = PALETTE.map(([n]) => n);
function paletteHexes() {
  const p = settings().palette;
  return Array.isArray(p) && p.length === 4 ? p : DEFAULT_PALETTE.slice();
}
const slotColor = (i) => {
  const hex = paletteHexes()[i];
  return hex.toLowerCase() === DEFAULT_PALETTE[i].toLowerCase() ? SLOT_NAMES[i] : hex;
};

const uid = () => Date.now().toString(36) + Math.random().toString(36).slice(2, 6);

// ---------------------------------------------------------------- geometry

const scaleF = () => (cur ? cur.w / RINK_W : 1);
const onRink = () => !!cur && cur.bgKind === 'rink';

const defaults = () => {
  const s = scaleF();
  return {
    playerR: Math.max(14, Math.round(45 * s)),
    text: Math.max(16, Math.round(64 * s)),
    stroke: Math.max(2, Math.round((Number(settings().arrowPx) || 8) * s)),
    pen: Math.max(2, Math.round(8 * s)),
  };
};

function pt(e) {
  const svg = el('edSvg');
  const r = svg.getBoundingClientRect();
  return {
    x: (e.clientX - r.left) * (cur.w / r.width),
    y: (e.clientY - r.top) * (cur.h / r.height),
  };
}

// --- selection: cur.selIds is the whole selection; cur.sel the PRIMARY.
function setSel(ids) {
  if (!cur) return;
  cur.selIds = ids;
  cur.sel = ids.length ? ids[ids.length - 1] : null;
}
const selEls = () => (cur ? cur.elements.filter((z) => (cur.selIds || []).includes(z.id)) : []);

// True bounds per element - the box the user sees must CONTAIN the whole
// shape: arrow curves and heads, the player's outer ring, pen stroke width,
// the full text chip.
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
    // Sample the quadratic, then add the head's reach and half the stroke.
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
      ys.push(y2Head(x, a, head));
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
const y2Head = (x, a, head) => x.y2 - Math.sin(a) * head;

const centerOf = (x) => {
  const b = elBounds(x);
  return { x: b.x + b.w / 2, y: b.y + b.h / 2 };
};

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
    const b = elBounds(x);
    if (p.x >= b.x - pad && p.x <= b.x + b.w + pad && p.y >= b.y - pad && p.y <= b.y + b.h + pad) return x;
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

function snapshot() {
  cur.undo.push({
    elements: structuredClone(cur.elements),
    bgKind: cur.bgKind,
    bg: cur.bgKind === 'rink' ? null : cur.bgDataUrl,
    seq: cur.seq,
    rinkNames: structuredClone(cur.rinkNames),
  });
  if (cur.undo.length > 60) cur.undo.shift();
  cur.redoStack.length = 0;
}
const marker = () => ({
  elements: structuredClone(cur.elements),
  bgKind: cur.bgKind,
  bg: cur.bgKind === 'rink' ? null : cur.bgDataUrl,
  seq: cur.seq,
  rinkNames: structuredClone(cur.rinkNames),
});

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
  scheduleSave();
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

function scheduleSave() {
  if (!cur) return;
  cur.dirty = true;
  status('Edited');
  clearTimeout(cur.timer);
  cur.timer = setTimeout(() => void saveNow(), 1200);
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
  if (onRink()) drawRinkNames(ctx, cur.rinkNames, cur.seq);
  return c;
}

// The cthDiagram state - the same shape Film Room embeds in its PNGs, plus
// the additive rinkNames property (older readers ignore it).
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
  if (!cur || !cur.dirty) return;
  cur.dirty = false;
  status('Saving…');
  try {
    const thumbScale = Math.min(1, 480 / cur.w);
    const thumb = (await renderFlat(thumbScale)).toDataURL('image/jpeg', 0.8);
    cur.drill.state = structuredClone(currentState());
    cur.drill.thumb = thumb;
    await putDrill(cur.drill);
    status('Saved');
  } catch (e) {
    cur.dirty = true;
    status('Not Saved');
    console.error(e);
    toast('Could not save - see the browser console', true);
  }
}

// ------------------------------------------------------------- SVG render

function svgEl(x) {
  if (x.type === 'stamp') {
    const href = shapeUrl(x.name);
    const flip = x.flip ? ` transform="translate(${2 * x.x + x.w} 0) scale(-1 1)"` : '';
    return `<image data-id="${x.id}" href="${href}" x="${x.x}" y="${x.y}" width="${x.w}" height="${x.h}"${flip}></image>`;
  }
  if (x.type === 'pucks') {
    const r = Math.min(x.w, x.h) * 0.22;
    const pts = [
      [x.x + x.w * 0.3, x.y + x.h * 0.72],
      [x.x + x.w * 0.7, x.y + x.h * 0.72],
      [x.x + x.w * 0.5, x.y + x.h * 0.3],
    ];
    return `<g data-id="${x.id}">${pts.map(([px, py]) => `<circle cx="${px}" cy="${py}" r="${r}" fill="${INK}"></circle>`).join('')}</g>`;
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
      ? `<text x="${x.x + x.w / 2}" y="${x.y + x.h / 2}" fill="${INK}" font-family="Inter, sans-serif" font-weight="800" font-size="${fs}" text-anchor="middle" dominant-baseline="central">${esc(x.label)}</text>`
      : '';
    return `<g data-id="${x.id}">${shape}${label}</g>`;
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
    return `<g data-id="${x.id}">
      <path d="M ${x.x1} ${x.y1} Q ${cx} ${cy} ${tx} ${ty}" fill="none" ${stroke}${x.dash ? ` stroke-dasharray="${w * 2.4} ${w * 2}"` : ''}></path>
      ${headSvg}
    </g>`;
  }
  if (x.type === 'text') {
    const T = TEXT_CHIP;
    const w = measureText(x);
    const padX = x.size * T.padX; const padY = x.size * T.padY;
    return `<g data-id="${x.id}">
      <rect x="${x.x - padX}" y="${x.y - x.size - padY}" width="${w + padX * 2}" height="${x.size * T.height + padY * 2}" rx="${x.size * T.radius}" fill="#ffffff" stroke="${INK}" stroke-width="${Math.max(1.5, x.size * T.border)}"></rect>
      <text x="${x.x}" y="${x.y}" fill="${colorOf(x.color)}" font-family="Inter, sans-serif" font-weight="800" font-size="${x.size}">${esc(x.text || '')}</text>
    </g>`;
  }
  if (x.type === 'pen') {
    return `<polyline data-id="${x.id}" points="${x.pts.map((p) => `${p[0]},${p[1]}`).join(' ')}" fill="none" stroke="${colorOf(x.color)}" stroke-width="${x.width || 8}" stroke-linecap="round" stroke-linejoin="round"></polyline>`;
  }
  return '';
}

// Rink name chips - Title chips centred at the top of each frame. Rendered
// above elements; double-click one to rename that rink.
function framesSvg() {
  if (!onRink()) return '';
  const out = [];
  const C = RINK_CHIP;
  const T = TEXT_CHIP;
  for (let k = 0; k < (cur.seq || 1); k++) {
    const name = (cur.rinkNames?.[k] || '').trim();
    if (!name) continue;
    const w = measureText({ size: C.size, text: name });
    const padX = C.size * T.padX; const padY = C.size * T.padY;
    const x0 = C.cx - w / 2;
    const y0 = k * (RINK_H + SEQ_GAP) + C.baseline;
    out.push(`<g data-rink="${k}" class="ed-rinkchip">
      <rect x="${x0 - padX}" y="${y0 - C.size - padY}" width="${w + padX * 2}" height="${C.size * T.height + padY * 2}" rx="${C.size * T.radius}" fill="#ffffff" stroke="${INK}" stroke-width="${Math.max(1.5, C.size * T.border)}"></rect>
      <text x="${x0}" y="${y0}" fill="${INK}" font-family="Inter, sans-serif" font-weight="800" font-size="${C.size}">${esc(name)}</text>
    </g>`);
  }
  return out.join('');
}

function uiSvg() {
  const out = [];
  const hs = Math.max(8, cur.w * 0.0065);
  const sel = selEls();
  const primary = cur.elements.find((z) => z.id === cur.sel);
  if (sel.length === 1 && primary && primary.type === 'arrow') {
    const x = primary;
    for (const [ax, ay, kind] of [[x.x1, x.y1, 'a1'], [x.mx, x.my, 'mid'], [x.x2, x.y2, 'a2']]) {
      out.push(`<circle class="ed-anchor${kind === 'mid' ? ' mid' : ''}" data-h="${kind}" cx="${ax}" cy="${ay}" r="${hs}" vector-effect="non-scaling-stroke"></circle>`);
    }
  } else {
    for (const z of sel) {
      const b = elBounds(z);
      out.push(`<rect class="ed-selbox" x="${b.x}" y="${b.y}" width="${Math.max(b.w, 2)}" height="${Math.max(b.h, 2)}" rx="${hs * 0.4}" vector-effect="non-scaling-stroke"></rect>`);
    }
    if (sel.length === 1 && primary
      && ['stamp', 'pucks', 'player', 'text', 'box', 'circle'].includes(primary.type)) {
      const b = elBounds(primary);
      out.push(`<rect class="ed-grip" data-h="se" x="${b.x + b.w - hs}" y="${b.y + b.h - hs}" width="${hs * 2}" height="${hs * 2}" rx="${hs * 0.35}" vector-effect="non-scaling-stroke"></rect>`);
    }
  }
  if (cur.band) {
    const b = cur.band;
    out.push(`<rect class="ed-band" x="${Math.min(b.x1, b.x2)}" y="${Math.min(b.y1, b.y2)}" width="${Math.abs(b.x2 - b.x1)}" height="${Math.abs(b.y2 - b.y1)}" vector-effect="non-scaling-stroke"></rect>`);
  }
  for (const g of (cur.guides || [])) {
    if (g.v != null) out.push(`<line class="ed-guide" x1="${g.v}" y1="0" x2="${g.v}" y2="${cur.h}" vector-effect="non-scaling-stroke"></line>`);
    if (g.h != null) out.push(`<line class="ed-guide" x1="0" y1="${g.h}" x2="${cur.w}" y2="${g.h}" vector-effect="non-scaling-stroke"></line>`);
  }
  return out.join('');
}

let toolsSig = '';
export function render() {
  const svg = el('edSvg');
  if (!svg || !cur) return;
  svg.setAttribute('viewBox', `0 0 ${cur.w} ${cur.h}`);
  const stageEl = el('edStage');
  if (stageEl) stageEl.style.aspectRatio = `${cur.w} / ${cur.h}`;
  const bg = svg.querySelector('#edBg');
  bg.setAttribute('href', bgHref());
  bg.setAttribute('width', cur.w);
  bg.setAttribute('height', cur.h);
  svg.querySelector('#edEls').innerHTML = cur.elements.map(svgEl).join('');
  svg.querySelector('#edFrames').innerHTML = framesSvg();
  svg.querySelector('#edUi').innerHTML = uiSvg();
  const lines = cur.tool === 'arrow' || cur.tool === 'dasharrow' || cur.tool === 'pen'
    || selEls().some((z) => z.type === 'arrow' || z.type === 'pen');
  const sig = `${cur.tool}|${cur.color}|${cur.head}|${cur.seq}|${settings().arrowPx || 8}|${paletteHexes().join()}|${lines}`;
  if (sig !== toolsSig) { toolsSig = sig; paintTools(); }
}

// ---------------------------------------------------------------- toolbar

const ICON = {
  select: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor"><path d="M4 3l7 18 2.5-7.5L21 11z" stroke-linejoin="round"/></svg>',
  arrow: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor"><path d="M4 20 C 8 10, 14 8, 19 6"/><path d="M14.5 5.2 20 5.5l-1.4 5.3" stroke-linejoin="round"/></svg>',
  dasharrow: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor"><path d="M4 20 C 8 10, 14 8, 19 6" stroke-dasharray="3.2 3"/><path d="M14.5 5.2 20 5.5l-1.4 5.3" stroke-linejoin="round"/></svg>',
  box: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor"><rect x="4" y="6" width="16" height="12" rx="2" fill="currentColor" fill-opacity="0.22"/></svg>',
  circle: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor"><ellipse cx="12" cy="12" rx="8.5" ry="6.5" fill="currentColor" fill-opacity="0.22"/></svg>',
  text: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor"><path d="M5 6V4h14v2"/><path d="M12 4v16"/><path d="M9 20h6"/></svg>',
  pen: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor"><path d="M12 19l7-7 3 3-7 7-3-3z"/><path d="M18 13l-1.5-7.5L2 2l3.5 14.5L13 18l5-5z"/><path d="M2 2l7.586 7.586"/><circle cx="11" cy="11" r="2"/></svg>',
  pucks: '<svg viewBox="0 0 24 24" fill="currentColor" stroke="none"><circle cx="8" cy="16" r="3.4"/><circle cx="16" cy="16" r="3.4"/><circle cx="12" cy="8.5" r="3.4"/></svg>',
  puck: '<svg viewBox="0 0 24 24" fill="currentColor" stroke="none"><circle cx="12" cy="12" r="3.2"/></svg>',
  faceoff: '<svg viewBox="0 0 24 24" fill="currentColor" stroke="none"><circle cx="12" cy="12" r="2.6"/><circle cx="5" cy="6" r="2.2"/><circle cx="19" cy="6" r="2.2"/><circle cx="5" cy="18" r="2.2"/><circle cx="19" cy="18" r="2.2"/></svg>',
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

const TOOLS = [
  ['select', 'Select & Move'],
  ['arrow', 'Arrow'],
  ['dasharrow', 'Dashed Arrow'],
  ['box', 'Shaded Box'],
  ['circle', 'Shaded Circle'],
  ['text', 'Text'],
  ['pen', 'Pen'],
];
const PLAYER_SLOTS = [0, 1, 2]; // palette slots used for the player chips
const ITEM_ORDER = ['coach', 'net', 'puck', 'pucks', 'cone', 'border'];

const DEFAULT_KEYS = {
  select: 'v', arrow: 'a', dasharrow: 'd', box: 'b', circle: 'c', text: 't', pen: 'p',
  'p-0': '1', 'p-1': '2', 'p-2': '3',
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
  return toolId;
}

function itemIcon(key) {
  if (key === 'pucks') return ICON.pucks;
  if (key === 'puck') return ICON.puck;
  const u = shapeUrl(ITEMS[key].file);
  return u ? `<img src="${u}" alt="">` : ITEMS[key].label;
}

const sep = '<span class="tb-sep"></span>';

function paintTools() {
  const bar = el('edBar');
  if (!bar || !cur) return;
  const headNow = cur.head || 'triangle';
  const hexes = paletteHexes();
  const weight = Number(settings().arrowPx) || 8;
  const lineCtx = cur.tool === 'arrow' || cur.tool === 'dasharrow' || cur.tool === 'pen'
    || selEls().some((z) => z.type === 'arrow' || z.type === 'pen');
  const kb = (t) => (keyFor(t) ? ` (${keyFor(t).toUpperCase()})` : '');

  bar.innerHTML = `
    ${TOOLS.map(([t, label]) => `<button class="tb-btn${cur.tool === t ? ' on' : ''}" data-tool="${t}" title="${label}${kb(t)}" aria-label="${label}">${ICON[t]}${keyBadge(t)}</button>`).join('')}
    ${sep}
    ${PLAYER_SLOTS.map((i) => `<button class="tb-player${cur.tool === `p-${i}` ? ' on' : ''}" data-tool="p-${i}" title="Player${kb(`p-${i}`)} - Double-Click A Placed Player To Letter It" style="--c:${colorOf(slotColor(i))}"></button>`).join('')}
    ${onRink() ? `<button class="tb-btn" data-act="faceoff" title="Place A 5v5 Centre-Ice Faceoff">${ICON.faceoff}</button>` : ''}
    ${sep}
    ${ITEM_ORDER.map((k) => `<button class="tb-btn${cur.tool === `i-${k}` ? ' on' : ''}" data-tool="i-${k}" title="${ITEMS[k].label}${kb(`i-${k}`)} - Hold Cmd To Place Several">${itemIcon(k)}${keyBadge(`i-${k}`)}</button>`).join('')}
    ${sep}
    ${hexes.map((hex, i) => `<button class="tb-swatch${cur.color === slotColor(i) ? ' on' : ''}" data-slot="${i}" style="--c:${hex}" title="Color Preset ${i + 1} - Double-Click To Customize"></button>`).join('')}
    ${lineCtx ? `${sep}
      ${HEADS.map(([h, label]) => `<button class="tb-btn tb-small${headNow === h ? ' on' : ''}" data-head="${h}" title="${label}">${HEAD_ICONS[h]}</button>`).join('')}
      ${[4, 8, 14].map((wpx, i) => `<button class="tb-btn tb-small${weight === wpx ? ' on' : ''}" data-weight="${wpx}" title="${['Fine', 'Standard', 'Bold'][i]} Lines"><svg viewBox="0 0 24 24"><path d="M4 12h16" stroke="currentColor" stroke-linecap="round" stroke-width="${1.4 + i * 1.8}"/></svg></button>`).join('')}` : ''}
    ${onRink() ? `${sep}
      <button class="tb-btn tb-word" data-act="addRink" ${(cur.seq || 1) >= SEQ_MAX ? 'disabled' : ''} title="Add Another Rink Below (Up To ${SEQ_MAX}) - A Sequence Saved As One Image">+ Rink</button>
      ${(cur.seq || 1) > 1 ? `<button class="tb-btn tb-word" data-act="delRink" title="Remove The Bottom Rink">&minus; Rink</button>` : ''}` : ''}`;

  bar.querySelectorAll('[data-tool]').forEach((b) => {
    b.onclick = () => setTool(b.dataset.tool);
    b.oncontextmenu = (e) => {
      e.preventDefault();
      const toolId = b.dataset.tool;
      capturing = { toolId, label: toolLabel(toolId) };
      toast(`Press A Key For ${toolLabel(toolId)} (Esc Cancels)`);
    };
  });
  bar.querySelectorAll('[data-slot]').forEach((b) => {
    const i = Number(b.dataset.slot);
    b.onclick = () => {
      cur.color = slotColor(i);
      const styled = selEls().filter((z) => 'color' in z);
      if (styled.length) { snapshot(); styled.forEach((z) => { z.color = cur.color; }); scheduleSave(); }
      toolsSig = '';
      render();
    };
    const customize = (e) => {
      e.preventDefault();
      const input = document.createElement('input');
      input.type = 'color';
      input.value = paletteHexes()[i];
      input.style.cssText = 'position:fixed;left:-100px;top:0;opacity:0;';
      document.body.appendChild(input);
      input.oninput = () => {
        const p = paletteHexes();
        p[i] = input.value;
        saveSettings({ palette: p });
        cur.color = slotColor(i);
        const styled = selEls().filter((z) => 'color' in z);
        if (styled.length) styled.forEach((z) => { z.color = cur.color; });
        toolsSig = '';
        render();
      };
      input.onchange = () => { input.remove(); scheduleSave(); };
      input.click();
    };
    b.ondblclick = customize;
    b.oncontextmenu = customize;
  });
  bar.querySelectorAll('[data-head]').forEach((b) => {
    b.onclick = () => {
      cur.head = b.dataset.head;
      saveSettings({ arrowHead: cur.head });
      const arrows = selEls().filter((z) => z.type === 'arrow');
      if (arrows.length) { snapshot(); arrows.forEach((z) => { z.head = cur.head; }); scheduleSave(); }
      toolsSig = '';
      render();
    };
  });
  bar.querySelectorAll('[data-weight]').forEach((b) => {
    b.onclick = () => {
      const wpx = Number(b.dataset.weight);
      saveSettings({ arrowPx: wpx });
      const lines = selEls().filter((z) => z.type === 'arrow' || z.type === 'pen');
      if (lines.length) {
        snapshot();
        lines.forEach((z) => { z.width = Math.max(2, Math.round(wpx * scaleF())); });
        scheduleSave();
      }
      toolsSig = '';
      render();
    };
  });
  const act = (name, fn) => { const b = bar.querySelector(`[data-act="${name}"]`); if (b) b.onclick = fn; };
  act('addRink', () => void addRink());
  act('delRink', () => void removeRink());
  act('faceoff', () => placeFaceoff());
  if (hooks.onFrames) hooks.onFrames(frameInfo());
}

function setTool(t) {
  cur.tool = t;
  render();
}

// ------------------------------------------------------------ zoom / pan

function applyZoom() {
  const st = el('edStage');
  if (st) st.style.width = `${cur.view.zoom * 100}%`;
}

function zoomAt(clientX, clientY, factor) {
  const wrap = el('edStageWrap');
  const st = el('edStage');
  if (!wrap || !st) return;
  const zoom0 = cur.view.zoom;
  const zoom = Math.min(8, Math.max(0.35, zoom0 * factor));
  if (zoom === zoom0) return;
  const r = st.getBoundingClientRect();
  const px = (clientX - r.left) / r.width;
  const py = (clientY - r.top) / r.height;
  cur.view.zoom = zoom;
  applyZoom();
  const r2 = st.getBoundingClientRect();
  wrap.scrollLeft += (px * r2.width + r2.left) - clientX;
  wrap.scrollTop += (py * r2.height + r2.top) - clientY;
}

function onWheel(e) {
  if (!cur) return;
  if (e.ctrlKey || e.metaKey) {
    e.preventDefault();
    zoomAt(e.clientX, e.clientY, Math.exp(-e.deltaY * 0.012));
  }
  // Plain wheel / two-finger scroll: the wrap scrolls natively.
}

// Safari trackpad pinch.
let gestureZoom0 = 1;
function onGestureStart(e) { if (!cur) return; e.preventDefault(); gestureZoom0 = cur.view.zoom; }
function onGestureChange(e) {
  if (!cur) return;
  e.preventDefault();
  const factor = (gestureZoom0 * e.scale) / cur.view.zoom;
  zoomAt(e.clientX, e.clientY, factor);
}

// ------------------------------------------------------------- image ops

async function flipH() {
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
  const W = cur.w;
  for (const x of cur.elements) {
    if (x.type === 'stamp') { x.x = W - x.x - x.w; x.flip = !x.flip; }
    else if (x.type === 'pucks' || x.type === 'box' || x.type === 'circle') x.x = W - x.x - x.w;
    else if (x.type === 'player') x.x = W - x.x;
    else if (x.type === 'text') x.x = W - x.x - measureText(x);
    else if (x.type === 'arrow') { x.x1 = W - x.x1; x.x2 = W - x.x2; x.mx = W - x.mx; }
    else if (x.type === 'pen') x.pts = x.pts.map(([px, py]) => [W - px, py]);
  }
  render();
  scheduleSave();
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
  scheduleSave();
  render();
  toast('5v5 Faceoff Placed - Black Left, Blue Right');
}

function frameOf(x) {
  return Math.max(0, Math.floor(centerOf(x).y / (RINK_H + SEQ_GAP)));
}

async function addRink() {
  if (!onRink() || (cur.seq || 1) >= SEQ_MAX) return;
  snapshot();
  const n = (cur.seq || 1) + 1;
  if (!cur.rinkNames?.length) cur.rinkNames = ['Rink 1'];
  cur.rinkNames[n - 1] = `Rink ${n}`;
  cur.seq = n;
  setRinkBackground(n);
  const shift = RINK_H + SEQ_GAP;
  const above = cur.elements.filter((x) => frameOf(x) === n - 2);
  const clones = above.map((x) => {
    const z = structuredClone(x);
    z.id = uid();
    moveElTo(z, centerOf(z).x, centerOf(z).y + shift);
    return z;
  });
  cur.elements.push(...(clones.length ? clones : rinkFurniture((n - 1) * shift)));
  render();
  scheduleSave();
  toast(`Rink ${n} Of ${SEQ_MAX} Added - Double-Click Its Name Chip To Rename`);
}

async function removeRink() {
  if (!onRink() || (cur.seq || 1) <= 1) return;
  snapshot();
  const n = (cur.seq || 1) - 1;
  cur.seq = n;
  if (cur.rinkNames) cur.rinkNames = cur.rinkNames.slice(0, n);
  setRinkBackground(n);
  cur.elements = cur.elements.filter((x) => frameOf(x) < n);
  setSel([]);
  render();
  scheduleSave();
  toast(`Bottom Rink Removed - ${n} Left. Cmd+Z Brings It Back`);
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
    scheduleSave();
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
  scheduleSave();
  render();
}

// ------------------------------------------------------------ interaction

let drag = null;
const pointers = new Map(); // pointerId -> {x, y}
let gesture = null;         // two-finger pan / pinch on touch

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
    cur.elements.push({ id, type: 'player', color: slotColor(Number(kind.slice(2))), x: snapped.x, y: snapped.y, r: d.playerR, label: '' });
  } else {
    const key = kind.slice(2);
    const it = ITEMS[key];
    const w = it.w * s; const h = it.h * s;
    if (key === 'pucks') cur.elements.push({ id, type: 'pucks', x: snapped.x - w / 2, y: snapped.y - h / 2, w, h });
    else cur.elements.push({ id, type: 'stamp', name: it.file, flip: false, x: snapped.x - w / 2, y: snapped.y - h / 2, w, h });
  }
  setSel([id]);
  if (!e?.metaKey && !e?.ctrlKey) cur.tool = 'select';
  scheduleSave();
  render();
}

function onDown(e) {
  if (!cur) return;
  pointers.set(e.pointerId, { x: e.clientX, y: e.clientY });
  // A second finger turns the interaction into pan / zoom.
  if (pointers.size === 2) {
    if (drag) { onUp(e); }
    const [a, b] = [...pointers.values()];
    const wrap = el('edStageWrap');
    gesture = {
      d0: Math.hypot(a.x - b.x, a.y - b.y),
      mid0: { x: (a.x + b.x) / 2, y: (a.y + b.y) / 2 },
      zoom0: cur.view.zoom,
      sl0: wrap.scrollLeft,
      st0: wrap.scrollTop,
    };
    e.preventDefault();
    return;
  }
  if (gesture) return;
  if (e.pointerType === 'mouse' && e.button !== 0) return;
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

  if (cur.tool === 'arrow' || cur.tool === 'dasharrow') {
    snapshot();
    const d = defaults();
    const a = {
      id: uid(), type: 'arrow', x1: p.x, y1: p.y, x2: p.x, y2: p.y, mx: p.x, my: p.y,
      color: cur.color, width: d.stroke, dash: cur.tool === 'dasharrow',
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
    const d = defaults();
    openTextInput(p, '', d.text, (text) => {
      if (!text.trim()) return;
      snapshot();
      const id = uid();
      cur.elements.push({ id, type: 'text', x: p.x, y: p.y, text: text.trim(), size: d.text, color: cur.color });
      setSel([id]);
      cur.tool = 'select';
      scheduleSave();
      render();
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
  if (gesture && pointers.size >= 2) {
    const [a, b] = [...pointers.values()];
    const d = Math.hypot(a.x - b.x, a.y - b.y);
    const mid = { x: (a.x + b.x) / 2, y: (a.y + b.y) / 2 };
    const factor = (gesture.zoom0 * (d / gesture.d0)) / cur.view.zoom;
    zoomAt(mid.x, mid.y, factor);
    const wrap = el('edStageWrap');
    wrap.scrollLeft -= mid.x - gesture.mid0.x;
    wrap.scrollTop -= mid.y - gesture.mid0.y;
    gesture.mid0 = mid;
    return;
  }
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
  else if (drag.kind === 'h:se' && x) {
    const o = drag.orig;
    if (x.type === 'box' || x.type === 'circle') {
      x.w = Math.max(24, o.w + dx);
      x.h = Math.max(24, o.h + dy);
    } else if (x.type === 'stamp' || x.type === 'pucks') {
      const sc = Math.max(0.2, Math.max((o.w + dx) / o.w, (o.h + dy) / o.h));
      x.w = o.w * sc; x.h = o.h * sc;
    } else if (x.type === 'player') {
      x.r = Math.max(8, o.r + Math.max(dx, dy) / 2);
    } else if (x.type === 'text') {
      x.size = Math.max(10, o.size + dy);
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
    scheduleSave();
  } else if (drag.kind === 'newBox' && x && (!drag.moved || x.w < 12 * scaleF() || x.h < 12 * scaleF())) {
    cur.elements = cur.elements.filter((z) => z.id !== x.id);
    cur.undo.pop();
  } else if (drag.kind === 'newBox' && x) {
    setSel([x.id]);
    cur.tool = 'select';
    scheduleSave();
  } else if ((drag.kind === 'move' || drag.kind.startsWith('h:')) && !drag.moved) {
    cur.undo.pop();
  } else {
    if (drag.kind === 'pen' && !e?.metaKey && !e?.ctrlKey) cur.tool = 'select';
    scheduleSave();
  }
  drag = null;
  render();
}

function onDblClick(e) {
  if (!cur) return;
  // Rename a rink by double-clicking its name chip.
  const chip = e.target.closest?.('[data-rink]');
  if (chip) {
    const k = Number(chip.dataset.rink);
    const s = scaleF();
    openTextInput({ x: RINK_CHIP.cx, y: k * (RINK_H + SEQ_GAP) + RINK_CHIP.baseline - RINK_CHIP.size / 2 }, cur.rinkNames?.[k] || '', RINK_CHIP.size * s, (text) => {
      snapshot();
      if (!cur.rinkNames) cur.rinkNames = [];
      cur.rinkNames[k] = text.trim();
      scheduleSave();
      render();
    }, 0, true);
    return;
  }
  const hitEl = e.target.closest?.('[data-id]');
  const x = hitEl ? cur.elements.find((z) => z.id === hitEl.dataset.id) : hitAt(pt(e));
  if (!x) return;
  if (x.type === 'player') {
    setSel([x.id]);
    openTextInput({ x: x.x, y: x.y }, x.label || '', Math.round(x.r * 0.9), (text) => {
      snapshot();
      x.label = text.trim().slice(0, 2).toUpperCase();
      scheduleSave();
      render();
    }, 2);
    return;
  }
  if (x.type === 'box' || x.type === 'circle') {
    setSel([x.id]);
    openTextInput({ x: x.x + x.w / 2, y: x.y + x.h / 2 }, x.label || '', shapeLabelSize(x), (text) => {
      snapshot();
      x.label = text.trim();
      scheduleSave();
      render();
    }, 0, true);
    return;
  }
  if (x.type === 'text') {
    setSel([x.id]);
    openTextInput({ x: x.x, y: x.y - x.size / 2 }, x.text || '', x.size, (text) => {
      snapshot();
      if (!text.trim()) cur.elements = cur.elements.filter((z) => z.id !== x.id);
      else x.text = text.trim();
      scheduleSave();
      render();
    });
  }
}

// The in-canvas text field. `centered` centres the field on the point
// (players, shape labels, rink chips); otherwise it sits on the text
// baseline like the chip it becomes.
function openTextInput(p, initial, sizePx, commit, maxLen = 0, centered = false) {
  document.getElementById('edInput')?.remove();
  const body = el('edStageWrap');
  const svg = el('edSvg');
  const r = svg.getBoundingClientRect();
  const br = body.getBoundingClientRect();
  const scale = r.width / cur.w;
  const input = document.createElement('input');
  input.id = 'edInput';
  input.className = 'ed-input';
  input.value = initial;
  if (maxLen) input.maxLength = maxLen;
  input.style.left = `${r.left - br.left + body.scrollLeft + p.x * scale}px`;
  input.style.top = `${r.top - br.top + body.scrollTop + p.y * scale}px`;
  const fpx = Math.max(11, sizePx * scale);
  input.style.fontSize = `${fpx}px`;
  if (centered || maxLen === 2) {
    input.classList.add('ed-input-center');
    if (maxLen === 2) input.style.width = `${Math.max(30, Math.round(fpx * 2.4))}px`;
  }
  body.appendChild(input);
  let done = false;
  const finish = (keep) => {
    if (done) return;
    done = true;
    const v = input.value;
    input.remove();
    if (keep) commit(v);
  };
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
    if (k === '0') { stop(); cur.view.zoom = 1; applyZoom(); return; }
    return;
  }
  if (e.key === 'Escape') {
    e.preventDefault();
    if (cur.tool !== 'select') { setTool('select'); return; }
    if (cur.sel) { setSel([]); render(); return; }
    return;
  }
  if (e.key === '?') {
    e.preventDefault();
    document.dispatchEvent(new CustomEvent('cthd:shortcuts'));
    return;
  }
  if ((e.key === 'Backspace' || e.key === 'Delete') && cur.sel) {
    e.preventDefault();
    snapshot();
    const ids = new Set(cur.selIds || []);
    cur.elements = cur.elements.filter((z) => !ids.has(z.id));
    setSel([]);
    scheduleSave();
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
      scheduleSave();
      render();
    }
    return;
  }
  const k = e.key.toLowerCase();
  const keys = effectiveKeys();
  if (keys[k]) {
    e.preventDefault();
    setTool(keys[k]);
  }
}

// ------------------------------------------------------------- open/close

export function editorActions() {
  return { flipH, undo, redo, renderFlat, currentState };
}

export async function closeEditor() {
  if (!cur) return;
  const c = cur;
  clearTimeout(c.timer);
  await saveNow();
  cur = null;
  hooks = {};
  pointers.clear();
  gesture = null;
  drag = null;
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
    head: settings().arrowHead || 'triangle',
    guides: [],
    seq: 1,
    rinkNames: [],
    view: { zoom: 1 },
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
    // A sequence always shows name chips - default them so renaming is one
    // double-click away even on diagrams made before names existed.
    if (cur.seq > 1 && !cur.rinkNames.length) {
      cur.rinkNames = Array.from({ length: cur.seq }, (_, k) => `Rink ${k + 1}`);
    }
    setRinkBackground(cur.seq);
    cur.elements = structuredClone(st.elements);
  } else {
    // Brand new: game-ready rink - nets in both creases, a goalie in each.
    setRinkBackground(1);
    cur.elements = rinkFurniture(0);
    cur.dirty = true;
    scheduleSave();
  }
  toolsSig = '';
  applyZoom();
  render();
  status(cur.dirty ? 'Saving…' : 'Saved');
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
  svg.addEventListener('dblclick', onDblClick);
  const wrap = el('edStageWrap');
  wrap.addEventListener('wheel', onWheel, { passive: false });
  wrap.addEventListener('gesturestart', onGestureStart);
  wrap.addEventListener('gesturechange', onGestureChange);
}
