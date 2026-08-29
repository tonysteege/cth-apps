// Freeze-frame annotation: telestration over a paused frame, drawn with the
// SAME element model and renderer as the Diagrams app (/diagrams/js/flat.js),
// so an arrow here looks exactly like an arrow there and every drawing can
// travel into a diagram or an export unchanged.
//
// Elements live in VIDEO pixel coordinates and are stored on the freeze
// ({ id, t, hold, elements }), which the player pauses on during playback.
//
// Rebuilt 2026-08-27 to Tony's spec. Four ideas run through the changes:
//
//  - A TOOL STAYS ARMED. Every draw used to snap back to Select, so putting
//    three arrows on a play meant re-arming twice. Escape disarms; another
//    tool replaces it; nothing else does.
//  - EVERY PLACED OBJECT IS EDITABLE. Shapes take corner handles, lines and
//    arrows take endpoint handles plus a middle one that bends the curve -
//    the same affordances the Diagrams editor has, in the same cyan.
//  - THE ANGLE TOOL IS A REAL MEASUREMENT, not a decoration: three handles,
//    and a readout that is always on screen and always the true angle.
//  - A TEXT BOX LOOKS THE SAME BEING TYPED AND BEING READ. The field and the
//    committed chip share one drawing, so committing looks like nothing
//    happened except the loss of selection.

import { drawEl, measureText, TEXT_CHIP, labelInkOn } from '/diagrams/js/flat.js';
import { toast, esc } from './ui.js';
import { uid } from './store.js';
// Side effect: every [data-tip] on the toolbar gets its near-instant tooltip.
import './tip.js';

let an = null;
const el = (id) => document.getElementById(id);

// The Diagrams cyan. Selection chrome mirrors what a drill's objects wear
// on a rink, so the two editors feel like one hand (2026-08-27).
const CYAN = '#75d8ff';

// Telestration colours: high chroma so they hold up over both white ice and
// dark boards. Red leads because it is the default (Tony's call).
// THREE PRESETS, EACH CUSTOMISABLE (2026-08-29, Tony's call). Five swatches
// were four more decisions than a coach makes mid-period; three covers home,
// away and a highlight. The values live in `settings.colorPresets` and are
// edited in Settings, so any of them can be any colour.
// They default to the SAME three the player buttons wear (2026-08-29, Tony's
// call): black, the CTH cyan, grey. Right-click any swatch to change it.
const DEFAULT_COLORS = ['#1e1e1e', '#75d8ff', '#d9d9d9'];
const colorsOf = () => prefs.colors;

const TOOLS = [
  ['select', 'Select & Move', '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-linejoin="round"><path d="M4.04 4.69a.5.5 0 0 1 .65-.65l16 6.5a.5.5 0 0 1-.06.94l-6.13 1.58a2 2 0 0 0-1.43 1.44l-1.58 6.12a.5.5 0 0 1-.95.07z"/></svg>'],
  ['pen', 'Pen', '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-linejoin="round"><path d="M21.17 6.81a2.82 2.82 0 0 0-3.98-3.99L3.84 16.17a2 2 0 0 0-.5.83l-1.32 4.35a.5.5 0 0 0 .62.63l4.36-1.32a2 2 0 0 0 .83-.5z"/></svg>'],
  // THE FIVE MOTION ARROWS, IN THE RINK EDITOR'S OWN ORDER AND ON ITS OWN
  // KEYS (2026-08-29, Tony's call): Skate A, Skate With Puck S, Skate
  // Backwards Z, Shoot X, Pass P. Icons and names are copied from
  // diagrams/js/editor.js to the letter - a coach who has learned this row on
  // a rink must not have to learn it again over film.
  ['arrow', 'Skate', '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-linejoin="round" stroke-linecap="round"><path d="M3 12h13.6"/><path d="m16.6 8.4 3.7 3.6-3.7 3.6"/></svg>'],
  ['skatepuck', 'Skate With Puck', '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-linejoin="round" stroke-linecap="round"><path d="M3 12q2.3-3.6 4.6 0t4.6 0 4.6 0"/><path d="m16.6 8.4 3.7 3.6-3.7 3.6"/></svg>'],
  ['skateback', 'Skate Backwards', '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-linejoin="round" stroke-linecap="round"><path d="M3 13.7a2.3 2.3 0 0 1 4.6 0 2.3 2.3 0 0 1 4.6 0 2.3 2.3 0 0 1 4.6 0"/><path d="m16.6 8.4 3.7 3.6-3.7 3.6"/></svg>'],
  ['shoot', 'Shoot', '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-linejoin="round" stroke-linecap="round"><path d="M3 9.8h13.4M3 14.2h13.4"/><path d="m16.6 8.4 3.7 3.6-3.7 3.6"/></svg>'],
  ['dasharrow', 'Pass', '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-linejoin="round" stroke-linecap="round"><path d="M3 12h13.6" stroke-dasharray="3.1 2.9"/><path d="m16.6 8.4 3.7 3.6-3.7 3.6"/></svg>'],
  ['box', 'Box', '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor"><rect x="4.25" y="5.25" width="15.5" height="13.5" rx="2.75"/></svg>'],
  ['circle', 'Circle', '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor"><circle cx="12" cy="12" r="7.75"/></svg>'],
  ['angle', 'Joint Angle', '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-linejoin="round" stroke-linecap="round"><path d="M5 19h15"/><path d="M5 19 16 6"/><path d="M11.5 19a7 7 0 0 0-1.3-4"/></svg>'],
  ['text', 'Text', '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-linecap="round"><path d="M4 7V5.5A1.5 1.5 0 0 1 5.5 4h13A1.5 1.5 0 0 1 20 5.5V7"/><path d="M12 4v16"/><path d="M9 20h6"/></svg>'],
  // Added 2026-08-27 on Tony's spec. Icons are drawn on the same 24 grid at
  // the same 1.9 stroke as the set above, so the row reads as one family.
  ['line', 'Line', '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-linecap="round"><path d="M4.5 19.5 19.5 4.5"/></svg>'],
  ['spotlight', 'Spotlight A Player', '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-linecap="round"><circle cx="12" cy="12" r="4.25"/><path d="M12 2.5v2.2M12 19.3v2.2M2.5 12h2.2M19.3 12h2.2"/></svg>'],
];

// `freearrow` keeps its entry so an older saved key does not dangle.
// The three player slots: home, away and neutral. A marker's colour is still
// changeable after the fact with the colour swatches, like every other mark.
// THE THREE SLOTS ARE THE DIAGRAMS TOOLBAR PRESETS (2026-08-29, Tony's
// call): black, the CTH cyan and grey, in that order. They were iOS red /
// blue / black, which meant a player dropped on film and the same player
// drawn on a rink were different objects wearing different colours. One
// vocabulary, two apps.
const PLAYER_SLOTS = ['#1e1e1e', '#75d8ff', '#d9d9d9'];
// THE HOVER MENU OF POSITIONS IS GONE (2026-08-29, Tony's call). It existed
// to choose a label before placing, and a two-character field typed straight
// onto the disc does the same job in fewer moves and without a panel opening
// under the pointer. A player button now does one thing: place a player.

// The three actions are ICON-ONLY (2026-08-29, Tony's call): three words plus
// their key badges were the widest thing in the row, and these are the three
// actions a coach already knows by position.
const ICON_CLEAR = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-linecap="round" stroke-linejoin="round"><path d="M4.5 7h15"/><path d="M9.5 7V5.4A1.4 1.4 0 0 1 10.9 4h2.2a1.4 1.4 0 0 1 1.4 1.4V7"/><path d="M6.4 7l.8 11.2A1.8 1.8 0 0 0 9 19.9h6a1.8 1.8 0 0 0 1.8-1.7L17.6 7"/></svg>';
const ICON_EXPORT = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-linecap="round" stroke-linejoin="round"><path d="M12 3.6v11"/><path d="m7.9 10.6 4.1 4.1 4.1-4.1"/><path d="M4.6 16.4v2.2a1.8 1.8 0 0 0 1.8 1.8h11.2a1.8 1.8 0 0 0 1.8-1.8v-2.2"/></svg>';
const ICON_DONE = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-linecap="round" stroke-linejoin="round"><path d="m5 12.6 4.6 4.6L19 7.2"/></svg>';

// The five arrows take the rink editor's keys exactly; the pen keeps `d`
// here because Clips never moved it to `e`.
const DEFAULT_KEYS = {
  select: 'v', pen: 'd', arrow: 'a', skatepuck: 's', skateback: 'z', shoot: 'x', dasharrow: 'p',
  box: 'b', circle: 'c', angle: 'g', text: 't', line: 'n', spotlight: 'r',
};
// What each arrow tool stamps. A pass IS the dashed line; the rest are solid
// lines wearing a `motion`. Same table as LINE_SPEC in diagrams/js/editor.js -
// change one, change both.
const LINE_SPEC = {
  arrow: { dash: false, motion: null },
  skatepuck: { dash: false, motion: 'puck' },
  skateback: { dash: false, motion: 'backward' },
  shoot: { dash: false, motion: 'shoot' },
  dasharrow: { dash: true, motion: null },
};
const ACT_KEYS = { clear: 'x', export: 'e' };

// Every tool's default look, overridden by settings.toolStyle. Widths are in
// 1280-wide video units and are scaled by vs() at the moment of drawing.
const DEFAULT_STYLE = {
  pen: { color: '#ff3b30', width: 8, dash: false },
  arrow: { color: '#ff3b30', width: 8, dash: false },
  line: { color: '#ff3b30', width: 8, dash: false },
  freearrow: { color: '#ff3b30', width: 8, dash: false },
  box: { color: '#ffd60a', width: 9, dash: false },
  circle: { color: '#ffd60a', width: 9, dash: false },
  spotlight: { color: '#ffd60a', width: 6, dash: false },
  pos: { color: '#0a84ff', width: 8, dash: false },
};
// The four extra arrows share the plain arrow's style: they are the same
// stroke wearing a different motion, and giving each its own width would mean
// a pass and a shot drawn back to back came out different weights.
for (const t of ['skatepuck', 'skateback', 'shoot', 'dasharrow']) DEFAULT_STYLE[t] = { ...DEFAULT_STYLE.arrow };

// EVERY TOOL PREFERENCE LIVES IN ONE PLACE (2026-08-29). The toolbar is on
// screen before a freeze exists, so anything edited from the idle bar has no
// `an` to live on - and a second copy hanging off `an` is exactly how a
// colour picked in Settings and a colour picked on the bar drift apart.
// `prefs` is the single reader for keys, per-tool style, the three swatches,
// the tool order and the shape style, in BOTH states, and `savePrefs` is the
// single writer: it updates the reader and hands the same settings-shaped
// patch to the app to persist.
const DEFAULT_ORDER = TOOLS.map(([t]) => t);
let prefs = {
  keys: { ...DEFAULT_KEYS },
  style: { ...DEFAULT_STYLE },
  colors: DEFAULT_COLORS,
  order: DEFAULT_ORDER,
  shapeStyle: 'fill',
  shapeAlpha: 0.3,
  arrowHead: 'triangle',
  actKeys: { ...ACT_KEYS },
};
let prefsHook = null;

// A tool added after an order was saved is never dropped - and it lands
// BESIDE THE TOOL IT BELONGS WITH rather than at the end of the row. The four
// motion arrows are the case that proved it matters: appended, Pass and Shoot
// would sit past the spotlight instead of next to Skate, which is the one
// place a coach would look for them.
function orderList(list) {
  const known = new Set(DEFAULT_ORDER);
  const seen = new Set();
  const out = [];
  for (const t of list || []) if (known.has(t) && !seen.has(t)) { seen.add(t); out.push(t); }
  for (let i = 0; i < DEFAULT_ORDER.length; i++) {
    const t = DEFAULT_ORDER[i];
    if (seen.has(t)) continue;
    // Insert after the nearest earlier tool the saved order already has;
    // failing that, at the front, which is where it sits by default.
    let at = 0;
    for (let j = i - 1; j >= 0; j--) {
      const prev = out.indexOf(DEFAULT_ORDER[j]);
      if (prev >= 0) { at = prev + 1; break; }
    }
    out.splice(at, 0, t);
    seen.add(t);
  }
  return out;
}

/** Take whatever a settings record carries. Every field is optional, so a
 *  record written before any of these existed reads exactly as it did. */
export function setToolPrefs(p = {}) {
  if (p.toolKeys) prefs.keys = { ...DEFAULT_KEYS, ...p.toolKeys };
  if (p.toolStyle) prefs.style = { ...DEFAULT_STYLE, ...p.toolStyle };
  if (p.colorPresets && p.colorPresets.length === 3) prefs.colors = p.colorPresets;
  if (p.toolOrder) prefs.order = orderList(p.toolOrder);
  if (p.shapeStyle) prefs.shapeStyle = p.shapeStyle;
  if (p.shapeAlpha != null) prefs.shapeAlpha = Math.max(0.05, Math.min(1, Number(p.shapeAlpha) || 0.3));
  if (p.arrowHead) prefs.arrowHead = p.arrowHead;
  if (p.actKeys) prefs.actKeys = { ...ACT_KEYS, ...p.actKeys };
}
export function onToolPrefs(fn) { prefsHook = fn; }
function savePrefs(patch) {
  setToolPrefs(patch);
  prefsHook?.(patch);
}
const orderedTools = () => prefs.order.map((t) => TOOLS.find((x) => x[0] === t)).filter(Boolean);

const vs = () => (an ? an.vw / 1280 : 1); // element sizes scale with the video
// `??`, NOT `||`: a key deliberately CLEARED is the empty string, and falling
// back to the default there would quietly hand the tool its old letter back -
// which is the duplicate the takeover just resolved.
const keyFor = (t) => (prefs.keys[t] ?? DEFAULT_KEYS[t] ?? '');

// THE STYLE IS RESOLVED ONTO THE ELEMENT AS IT IS CREATED, never read back
// at render time. A freeze saved today keeps the look it was drawn with even
// if the tool's defaults change tomorrow, which is the same additive promise
// every other stored record here makes.
function styleFor(t) {
  const d = DEFAULT_STYLE[t] || DEFAULT_STYLE.pen;
  const st = { ...d, ...(prefs.style[t] || {}) };
  // THE SWATCH IS THE COLOUR FOR EVERY COLOURABLE TOOL (2026-08-29, Tony's
  // call). It used to be a live override for the ACTIVE tool only, cleared
  // the moment another tool was picked, so drawing a red arrow and then a
  // box gave a yellow box - the swatch looked like a global choice and
  // behaved like a per-tool one. It is global and sticky now: pick a colour,
  // everything you draw is that colour until you pick another.
  //   TWO EXCEPTIONS, both because their colour means something. `pos` is a
  //   player and takes its home/away/neutral slot. `text` is forced to ink at
  //   creation, because the chip is a white pill.
  //   A tool's OWN colour, set in Settings or by right-clicking it, is the
  //   fallback until a swatch is picked - and picking one in either place
  //   sets the global colour too, so the two never disagree.
  const color = (an && an.colorSet && t !== 'pos') ? an.color : st.color;
  return { color, width: (st.width ?? d.width) * vs(), dash: !!st.dash };
}

export function annotating() { return !!an; }

// THE IDLE BAR. The toolbar is on screen whether or not a freeze is open, so
// something has to occupy it while nothing is being annotated. It shows the
// same tools in the same order - a row that changed shape when you froze a
// frame would be a different toolbar, not the same one waiting - and picking
// any of them freezes the current frame and arms that tool in one gesture.
export function paintIdleBar(onPick) {
  const bar = el('anBar');
  if (!bar || an) return;
  bar.innerHTML = barHtml(false);
  for (const b of bar.querySelectorAll('[data-idle]')) {
    b.onclick = () => onPick?.(b.dataset.idle);
  }
  // A PLAYER BUTTON ARMS THE BAR TOO (2026-08-29, Tony's call). It used to be
  // the one control on the idle strip that was disabled, so the row of
  // circles that most looks like a thing to press did nothing until you had
  // already frozen a frame some other way.
  for (const b of bar.querySelectorAll('[data-idleslot]')) {
    const slot = Number(b.dataset.idleslot);
    b.onclick = () => { pendingPos = { color: PLAYER_SLOTS[slot], label: '' }; onPick?.('pos'); };
  }
  for (const b of bar.querySelectorAll('[data-idle]')) {
    b.oncontextmenu = (ev) => { ev.preventDefault(); openToolMenu(b.dataset.idle, b); };
  }
  wireToolDrag(bar);
  wireSwatches(bar, false);
  wireHold();
}

// The choice made on the idle bar, held across the freeze. `openAnnotator`
// reads it once and clears it.
let pendingPos = null;

// Diagnostic tap, the Film Room idiom: only meaningful to someone who went
// looking for it, and free at runtime.
export function annotateDebug() {
  if (!an) return null;
  return { tool: an.tool, sel: [...an.sel], count: an.els.length, drag: an.drag && { ...an.drag, orig: undefined }, vs: vs(), handleR: 12 * vs() };
}

// ------------------------------------------------------------- drawing

// drawEl knows every Diagrams element. The joint angle is ours alone, so it
// is drawn here rather than pushed into the shared renderer - flat.js is an
// interchange contract with Film Room and must not grow a Clips-only type.
function drawAngle(ctx, x) {
  const s = x.width || 8;
  const deg = angleOf(x);
  ctx.save();
  ctx.strokeStyle = x.color;
  ctx.lineWidth = s;
  ctx.lineCap = 'round';
  ctx.lineJoin = 'round';
  ctx.beginPath();
  ctx.moveTo(x.ax, x.ay);
  ctx.lineTo(x.vx, x.vy);
  ctx.lineTo(x.bx, x.by);
  ctx.stroke();
  // The sweep, drawn at a radius that stays inside the shorter leg.
  const la = Math.hypot(x.ax - x.vx, x.ay - x.vy);
  const lb = Math.hypot(x.bx - x.vx, x.by - x.vy);
  const r = Math.max(s * 3, Math.min(la, lb) * 0.34);
  const a0 = Math.atan2(x.ay - x.vy, x.ax - x.vx);
  const a1 = Math.atan2(x.by - x.vy, x.bx - x.vx);
  let d = a1 - a0;
  while (d <= -Math.PI) d += Math.PI * 2;
  while (d > Math.PI) d -= Math.PI * 2;
  ctx.beginPath();
  ctx.lineWidth = s * 0.62;
  ctx.arc(x.vx, x.vy, r, a0, a0 + d, d < 0);
  ctx.stroke();
  // The readout. Always on screen, always the true angle - a measurement
  // you have to hover for is not a measurement.
  const mid = a0 + d / 2;
  const lx = x.vx + Math.cos(mid) * (r + s * 4.2);
  const ly = x.vy + Math.sin(mid) * (r + s * 4.2);
  const label = `${Math.round(deg)}°`;
  ctx.font = `700 ${s * 4.4}px Inter, sans-serif`;
  ctx.textAlign = 'center';
  ctx.textBaseline = 'middle';
  const w = ctx.measureText(label).width;
  const padX = s * 1.5;
  const padY = s * 1.05;
  roundRect(ctx, lx - w / 2 - padX, ly - s * 2.2 - padY, w + padX * 2, s * 4.4 + padY * 2, s * 1.4);
  ctx.fillStyle = 'rgba(255,255,255,0.94)';
  ctx.fill();
  ctx.fillStyle = x.color;
  ctx.fillText(label, lx, ly);
  ctx.restore();
}

export function angleOf(x) {
  const a0 = Math.atan2(x.ay - x.vy, x.ax - x.vx);
  const a1 = Math.atan2(x.by - x.vy, x.bx - x.vx);
  let d = Math.abs(a1 - a0) * (180 / Math.PI);
  if (d > 180) d = 360 - d;
  return d;
}

function roundRect(ctx, x, y, w, h, r) {
  ctx.beginPath();
  ctx.moveTo(x + r, y);
  ctx.arcTo(x + w, y, x + w, y + h, r);
  ctx.arcTo(x + w, y + h, x, y + h, r);
  ctx.arcTo(x, y + h, x, y, r);
  ctx.arcTo(x, y, x + w, y, r);
  ctx.closePath();
}

function drawAny(ctx, x) {
  if (x.type === 'angle') drawAngle(ctx, x);
  else drawEl(ctx, x);
}

function canvas() { return el('anCanvas'); }

function redraw() {
  const c = canvas();
  const ctx = c.getContext('2d');
  ctx.clearRect(0, 0, c.width, c.height);
  for (const x of an.els) drawAny(ctx, x);
  const s = vs();
  // Selection chrome, in the Diagrams cyan.
  for (const id of an.sel) {
    const x = an.els.find((z) => z.id === id);
    const b = bounds(x);
    if (!b) continue;
    ctx.strokeStyle = CYAN;
    ctx.lineWidth = 2 * s;
    ctx.setLineDash([8 * s, 6 * s]);
    ctx.strokeRect(b.x, b.y, b.w, b.h);
    ctx.setLineDash([]);
  }
  // Handles appear only on a single selection: on two objects they would be
  // a field of dots with no clear owner.
  if (an.sel.size === 1) {
    const x = an.els.find((z) => z.id === [...an.sel][0]);
    for (const h of handlesOf(x)) {
      ctx.beginPath();
      ctx.arc(h.x, h.y, 7 * s, 0, Math.PI * 2);
      ctx.fillStyle = '#fff';
      ctx.fill();
      ctx.lineWidth = 2.5 * s;
      ctx.strokeStyle = CYAN;
      ctx.stroke();
    }
  }
  if (an.band) {
    ctx.strokeStyle = CYAN;
    ctx.fillStyle = 'rgba(117, 216, 255, 0.16)';
    ctx.lineWidth = 1.5 * s;
    const b = an.band;
    const r = { x: Math.min(b.x0, b.x1), y: Math.min(b.y0, b.y1), w: Math.abs(b.x1 - b.x0), h: Math.abs(b.y1 - b.y0) };
    ctx.fillRect(r.x, r.y, r.w, r.h);
    ctx.strokeRect(r.x, r.y, r.w, r.h);
  }
}

// A handle is { x, y, k } where k names what dragging it changes.
function handlesOf(x) {
  if (!x) return [];
  if (x.type === 'box' || x.type === 'circle') {
    return [
      { x: x.x, y: x.y, k: 'nw' },
      { x: x.x + x.w, y: x.y, k: 'ne' },
      { x: x.x, y: x.y + x.h, k: 'sw' },
      { x: x.x + x.w, y: x.y + x.h, k: 'se' },
    ];
  }
  if (x.type === 'arrow') {
    return [
      { x: x.x1, y: x.y1, k: 'p1' },
      { x: x.mx, y: x.my, k: 'curve' },
      { x: x.x2, y: x.y2, k: 'p2' },
    ];
  }
  if (x.type === 'angle') {
    return [
      { x: x.ax, y: x.ay, k: 'a' },
      { x: x.vx, y: x.vy, k: 'v' },
      { x: x.bx, y: x.by, k: 'b' },
    ];
  }
  return [];
}

function bounds(x) {
  if (!x) return null;
  if (x.type === 'box' || x.type === 'circle') return { x: x.x, y: x.y, w: x.w, h: x.h };
  if (x.type === 'arrow') {
    const xs = [x.x1, x.x2, x.mx]; const ys = [x.y1, x.y2, x.my];
    const pad = (x.width || 8) * 2.5;
    return { x: Math.min(...xs) - pad, y: Math.min(...ys) - pad, w: Math.max(...xs) - Math.min(...xs) + pad * 2, h: Math.max(...ys) - Math.min(...ys) + pad * 2 };
  }
  if (x.type === 'angle') {
    const xs = [x.ax, x.vx, x.bx]; const ys = [x.ay, x.vy, x.by];
    const pad = (x.width || 8) * 3;
    return { x: Math.min(...xs) - pad, y: Math.min(...ys) - pad, w: Math.max(...xs) - Math.min(...xs) + pad * 2, h: Math.max(...ys) - Math.min(...ys) + pad * 2 };
  }
  if (x.type === 'pen' || x.type === 'freearrow') {
    const xs = x.pts.map((p) => p[0]); const ys = x.pts.map((p) => p[1]);
    // A freehand arrow's head sticks out past the last point, so its box has
    // to allow for it or the head sits outside its own selection.
    const pad = x.type === 'freearrow' ? (x.width || 8) * 6.45 : 0;
    return { x: Math.min(...xs) - pad, y: Math.min(...ys) - pad, w: Math.max(...xs) - Math.min(...xs) + pad * 2, h: Math.max(...ys) - Math.min(...ys) + pad * 2 };
  }
  // A ring's box is its own square, so dragging a corner grows the radius.
  if (x.type === 'spotlight') {
    const r = Math.max(2, x.r || 0) + (x.width || 6) * 1.5;
    return { x: x.x - r, y: x.y - r, w: r * 2, h: r * 2 };
  }
  if (x.type === 'player') {
    const r = (x.r || 26) + 2;
    return { x: x.x - r, y: x.y - r, w: r * 2, h: r * 2 };
  }
  if (x.type === 'text') {
    const T = TEXT_CHIP;
    const w = measureText(x);
    const padX = x.size * T.padX; const padY = x.size * T.padY;
    return { x: x.x - padX, y: x.y - x.size - padY, w: w + padX * 2, h: x.size * T.height + padY * 2 };
  }
  return null;
}

function hitAt(p) {
  for (let i = an.els.length - 1; i >= 0; i--) {
    const b = bounds(an.els[i]);
    if (b && p.x >= b.x - 8 && p.x <= b.x + b.w + 8 && p.y >= b.y - 8 && p.y <= b.y + b.h + 8) return an.els[i];
  }
  return null;
}

function handleAt(p) {
  if (an.sel.size !== 1) return null;
  const x = an.els.find((z) => z.id === [...an.sel][0]);
  const r = 12 * vs();
  for (const h of handlesOf(x)) {
    if (Math.hypot(p.x - h.x, p.y - h.y) <= r) return { el: x, h };
  }
  return null;
}

// WHERE THE PICTURE ACTUALLY IS. `object-fit: contain` letterboxes the
// bitmap inside the element box, so getBoundingClientRect() returns the BOX
// and not the picture. Mapping a pointer against the box puts every click
// off by the letterbox offset the moment the stage stops matching the
// video's aspect - which is most of the time, since the stage is whatever
// the window leaves over. Found 2026-08-27: a click on a corner handle was
// landing 18 video pixels above it.
function viewBox() {
  const r = canvas().getBoundingClientRect();
  const scale = Math.min(r.width / an.vw, r.height / an.vh);
  const w = an.vw * scale;
  const h = an.vh * scale;
  return { scale, left: r.left + (r.width - w) / 2, top: r.top + (r.height - h) / 2, w, h };
}

function pt(e) {
  const v = viewBox();
  return { x: (e.clientX - v.left) / v.scale, y: (e.clientY - v.top) / v.scale };
}

// ------------------------------------------------------------- pointer

function onDown(e) {
  if (!an) return;
  // A CLICK OFF AN OPEN FIELD CLOSES IT AND DOES NOTHING ELSE (2026-08-29,
  // Tony's call). Two things were in the way. This handler preventDefaults
  // every pointerdown, which suppresses the browser's own focus change, so a
  // field never blurred on its own - closing it here directly rather than
  // through blur() is what makes the click actually land. And the click is
  // SWALLOWED: letting it fall through would place a second text box, or
  // select whatever sits under the pointer, on the way out.
  if (activeField) { e.preventDefault(); activeField.finish(true); return; }
  e.preventDefault();
  const p = pt(e);
  const s = vs();

  if (an.tool === 'select') {
    const grab = handleAt(p);
    if (grab) {
      an.drag = { kind: 'handle', id: grab.el.id, h: grab.h.k, orig: structuredClone(grab.el) };
      return;
    }
    const x = hitAt(p);
    if (!x) {
      // Rubber band: drag on empty frame to gather several objects.
      an.sel.clear();
      an.band = { x0: p.x, y0: p.y, x1: p.x, y1: p.y };
      an.drag = { kind: 'band' };
      redraw();
      return;
    }
    if (e.shiftKey) an.sel.has(x.id) ? an.sel.delete(x.id) : an.sel.add(x.id);
    else if (!an.sel.has(x.id)) { an.sel.clear(); an.sel.add(x.id); }
    an.drag = {
      kind: 'move',
      start: p,
      origs: [...an.sel].map((id) => structuredClone(an.els.find((z) => z.id === id))),
    };
    redraw();
    return;
  }

  // A position chip is placed, not dragged: one click drops D1 or C where
  // the player is. It is a `player` element, the type Diagrams already draws
  // as a labelled disc, so it needs no new renderer and it lands in a saved
  // freeze looking exactly like a rink diagram's player.
  if (an.tool === 'pos') {
    const x = {
      id: uid(), type: 'player', x: p.x, y: p.y,
      r: 26 * s, color: an.posColor || PLAYER_SLOTS[0], label: an.posLabel ?? '',
    };
    an.els.push(x);
    an.sel = new Set([x.id]);
    markDirty();
    an.onDraw?.();
    if (an.autoSelect) setTool('select');
    redraw();
    // A BLANK PLAYER OPENS ITS OWN LABEL FIELD (2026-08-29, Tony's call). The
    // default used to be a hardcoded 'C', which meant every unnamed marker on
    // a clip claimed to be the centre. Blank plus a two-character field drawn
    // ON the disc is the same gesture as typing into the shape.
    if (!x.label) openPlayerLabelInput(x);
    return;
  }
  if (an.tool === 'pen' || an.tool === 'freearrow') {
    const st = styleFor(an.tool);
    const x = {
      id: uid(), type: an.tool === 'pen' ? 'pen' : 'freearrow',
      pts: [[p.x, p.y]], color: st.color, width: st.width, ...(st.dash ? { dash: true } : {}),
    };
    an.els.push(x);
    an.drag = { id: x.id, kind: 'pen' };
    return;
  }
  // Line is an arrow with no head. Same record, same curve, same drag, same
  // hit test - only the head style differs, and both renderers already treat
  // an unknown head as "draw nothing", so this needed no drawing code.
  if (LINE_SPEC[an.tool] || an.tool === 'line') {
    const st = styleFor(an.tool);
    const spec = LINE_SPEC[an.tool] || { dash: false, motion: null };
    const x = {
      id: uid(), type: 'arrow', x1: p.x, y1: p.y, x2: p.x, y2: p.y, mx: p.x, my: p.y,
      color: st.color, width: st.width,
      // A line has no head; every arrow takes the head shape from Settings.
      head: an.tool === 'line' ? 'none' : (prefs.arrowHead || 'triangle'),
      // `motion` is ADDITIVE and only written when there is one, so a plain
      // skate arrow is byte-identical to every one saved before today.
      ...(spec.motion ? { motion: spec.motion } : {}),
      ...(spec.dash || st.dash ? { dash: true } : {}),
    };
    an.els.push(x);
    an.drag = { id: x.id, kind: 'arrow' };
    return;
  }
  if (an.tool === 'spotlight') {
    const st = styleFor('spotlight');
    const x = { id: uid(), type: 'spotlight', x: p.x, y: p.y, r: 0, color: st.color, width: st.width, ...(st.dash ? { dash: true } : {}) };
    an.els.push(x);
    an.drag = { id: x.id, kind: 'spot', start: p };
    return;
  }
  if (an.tool === 'box' || an.tool === 'circle') {
    // FILL OR OUTLINE IS A SETTING NOW (2026-08-29, Tony's call), not a
    // segmented control on the bar. A wash reads well over plain ice and an
    // outline reads better over a busy frame, but it is a decision made once
    // for how a coach draws, not one made between two marks - and it was the
    // only text control in a row of glyphs.
    const solid = prefs.shapeStyle === 'outline';
    const st = styleFor(an.tool);
    const x = {
      id: uid(), type: an.tool, x: p.x, y: p.y, w: 0, h: 0, color: st.color,
      // THE WASH'S STRENGTH IS A SETTING (2026-08-29, Tony's call). 0.3 was
      // hardcoded, which is right over plain ice and far too heavy over a
      // crowded frame. It is resolved onto the element as it is drawn, like
      // every other style here, so changing it tomorrow leaves today's
      // freezes exactly as they were drawn.
      alpha: solid ? 1 : prefs.shapeAlpha, ...(solid ? { outline: true, width: st.width } : {}),
      ...(st.dash ? { dash: true } : {}),
    };
    an.els.push(x);
    an.drag = { id: x.id, kind: 'shape', start: p };
    return;
  }
  if (an.tool === 'angle') {
    // Drawn in one gesture: press at the first limb, drag to the vertex.
    // The second limb lands opposite and is then dragged into place.
    const x = { id: uid(), type: 'angle', ax: p.x, ay: p.y, vx: p.x, vy: p.y, bx: p.x, by: p.y, color: an.color, width: 8 * s };
    an.els.push(x);
    an.drag = { id: x.id, kind: 'angle', start: p };
    return;
  }
  if (an.tool === 'text') openTextInput(p);
}

function onMove(e) {
  if (!an?.drag) return;
  const p = pt(e);
  const d = an.drag;

  if (d.kind === 'band') {
    an.band.x1 = p.x;
    an.band.y1 = p.y;
    const r = {
      x: Math.min(an.band.x0, p.x), y: Math.min(an.band.y0, p.y),
      w: Math.abs(p.x - an.band.x0), h: Math.abs(p.y - an.band.y0),
    };
    an.sel.clear();
    for (const z of an.els) {
      const b = bounds(z);
      if (b && b.x < r.x + r.w && b.x + b.w > r.x && b.y < r.y + r.h && b.y + b.h > r.y) an.sel.add(z.id);
    }
    redraw();
    return;
  }

  if (d.kind === 'move') {
    const dx = p.x - d.start.x;
    const dy = p.y - d.start.y;
    for (const o of d.origs) {
      const x = an.els.find((z) => z.id === o.id);
      if (!x) continue;
      if (x.type === 'pen' || x.type === 'freearrow') x.pts = o.pts.map(([px, py]) => [px + dx, py + dy]);
      else if (x.type === 'arrow') { x.x1 = o.x1 + dx; x.y1 = o.y1 + dy; x.x2 = o.x2 + dx; x.y2 = o.y2 + dy; x.mx = o.mx + dx; x.my = o.my + dy; }
      else if (x.type === 'angle') { x.ax = o.ax + dx; x.ay = o.ay + dy; x.vx = o.vx + dx; x.vy = o.vy + dy; x.bx = o.bx + dx; x.by = o.by + dy; }
      else { x.x = o.x + dx; x.y = o.y + dy; }
    }
    redraw();
    return;
  }

  const x = an.els.find((z) => z.id === d.id);
  if (!x) return;

  if (d.kind === 'handle') {
    const o = d.orig;
    if (d.h === 'p1') { x.x1 = p.x; x.y1 = p.y; }
    else if (d.h === 'p2') { x.x2 = p.x; x.y2 = p.y; }
    else if (d.h === 'curve') { x.mx = p.x; x.my = p.y; }
    else if (d.h === 'a') { x.ax = p.x; x.ay = p.y; }
    else if (d.h === 'v') { x.vx = p.x; x.vy = p.y; }
    else if (d.h === 'b') { x.bx = p.x; x.by = p.y; }
    else {
      // A corner drags against the OPPOSITE corner, which is what keeps a
      // box anchored while it is resized.
      const right = d.h === 'ne' || d.h === 'se';
      const bottom = d.h === 'sw' || d.h === 'se';
      const fx = right ? o.x : o.x + o.w;
      const fy = bottom ? o.y : o.y + o.h;
      let w = Math.abs(p.x - fx);
      let h = Math.abs(p.y - fy);
      // A circle is always a circle (Tony's call): the larger side wins, so
      // a drag never quietly makes an ellipse.
      if (x.type === 'circle') { const m = Math.max(w, h); w = m; h = m; }
      x.x = right ? fx : fx - w;
      x.y = bottom ? fy : fy - h;
      x.w = w;
      x.h = h;
    }
    redraw();
    return;
  }

  if (d.kind === 'pen') {
    const last = x.pts[x.pts.length - 1];
    if (Math.hypot(p.x - last[0], p.y - last[1]) > 3) x.pts.push([p.x, p.y]);
  } else if (d.kind === 'arrow') {
    x.x2 = p.x; x.y2 = p.y; x.mx = (x.x1 + x.x2) / 2; x.my = (x.y1 + x.y2) / 2;
  } else if (d.kind === 'shape') {
    let w = Math.abs(p.x - d.start.x);
    let h = Math.abs(p.y - d.start.y);
    if (an.tool === 'circle') { const m = Math.max(w, h); w = m; h = m; }
    x.x = p.x < d.start.x ? d.start.x - w : d.start.x;
    x.y = p.y < d.start.y ? d.start.y - h : d.start.y;
    x.w = w; x.h = h;
  } else if (d.kind === 'spot') {
    // Press on the player, drag out to the ring you want.
    x.r = Math.hypot(p.x - d.start.x, p.y - d.start.y);
  } else if (d.kind === 'angle') {
    // The drag sets the vertex; the far limb mirrors it until it is moved.
    x.vx = p.x; x.vy = p.y;
    x.bx = p.x + (p.x - x.ax) * 0.85;
    x.by = p.y - Math.abs(p.y - x.ay) * 0.85;
  }
  redraw();
}

function onUp() {
  if (!an?.drag) return;
  const d = an.drag;
  an.drag = null;
  an.band = null;
  const x = an.els.find((z) => z.id === d.id);
  if (x && d.kind === 'shape' && (x.w < 12 || x.h < 12)) an.els = an.els.filter((z) => z.id !== d.id);
  if (x && d.kind === 'angle' && Math.hypot(x.vx - x.ax, x.vy - x.ay) < 20) an.els = an.els.filter((z) => z.id !== d.id);
  // A ring too small to see is a stray click, not a spotlight. A bare click
  // still gets one, at a sensible default size, so tapping a player works.
  if (x && d.kind === 'spot' && x.r < 10) x.r = 44 * vs();
  if (d.kind !== 'band') markDirty();
  // A DRAW REVERTS TO SELECT (2026-08-29, Tony's call), so the thing just
  // drawn can be moved without re-arming - which is what anyone does next.
  // `settings.autoSelect` turns it off for the old behaviour, where the tool
  // stayed armed and three arrows on one play cost no re-arming.
  if (['pen', 'arrow', 'shape', 'angle', 'spot'].includes(d.kind) && an.els.some((z) => z.id === d.id)) {
    an.sel.clear();
    an.sel.add(d.id);
    an.onDraw?.();
    if (an.autoSelect) { setTool('select'); an.sel.clear(); an.sel.add(d.id); }
  }
  redraw();
}

// ------------------------------------------------------------- text

// The field and the committed chip share ONE drawing, so committing looks
// like nothing happened except the loss of selection (Tony's call). The
// numbers below are the same ones flat.js uses to render the chip.
// 34, down 20% from 42 (2026-08-29, Tony's call); `settings.textSize` moves
// it. A caption on game film competes with the play behind it, and the size
// that reads on a laptop is bigger than the one that reads on a projector.
const TEXT_SIZE = 34;
// TEXT IS ALWAYS INK, never the tool colour (2026-08-29, Tony's call). The
// text chip is a WHITE PILL with a dark border - flat.js draws it that way -
// so orange-on-white was the one mark in the app that had to be read rather
// than seen. The colour swatches still recolour every other kind of mark.
const TEXT_INK = '#1e1e1e';

// THE EDITOR IS THE TEXT BOX (2026-08-29, Tony's call). It used to be a
// shadowed white slab of its own, offset by `translate(-4px, -1.1em)`, in the
// tool's colour - so committing a caption made it jump, shrink, change colour
// and grow a border. Every number below is read from the SAME `TEXT_CHIP`
// geometry flat.js commits with, converted into screen pixels, so what is on
// screen while typing is the mark that lands: white fill, ink border at
// `size * 0.17`, radius `size * 0.32`, `padX 0.5 / padY 0.3` of padding, 800
// weight at the element's own size, and ALWAYS INK TEXT - the chip is a white
// pill, so a coloured caption is the one mark that has to be read rather than
// seen. The field grows with the text through the same `measureText` the chip
// is sized by, which is the last thing that could still make it jump.
//
// The canvas strokes ON the rect path, straddling it, so the CSS box is
// pulled out by half a border width to put the two outer edges in one place.
function openTextInput(p, existing = null) {
  const root = el('anRoot');
  const v = viewBox();
  const rootR = root.getBoundingClientRect();
  const scale = v.scale;
  const size = existing ? existing.size : (an.textSize || TEXT_SIZE) * vs();
  const T = TEXT_CHIP;
  const padX = size * T.padX;
  const padY = size * T.padY;
  const bw = Math.max(1.5, size * T.border);
  const input = document.createElement('input');
  input.className = 'an-textinput';
  input.value = existing ? existing.text : '';
  input.style.left = `${v.left - rootR.left + (p.x - padX - bw / 2) * scale}px`;
  input.style.top = `${v.top - rootR.top + (p.y - size - padY - bw / 2) * scale}px`;
  input.style.height = `${size * T.height * scale}px`;
  input.style.lineHeight = `${size * T.height * scale}px`;
  input.style.fontSize = `${size * scale}px`;
  input.style.padding = `${padY * scale}px ${padX * scale}px`;
  input.style.borderWidth = `${bw * scale}px`;
  input.style.borderRadius = `${size * T.radius * scale}px`;
  input.style.color = TEXT_INK;
  const fit = () => {
    const w = measureText({ size, text: input.value });
    input.style.width = `${Math.max(w, size * 0.9) * scale}px`;
  };
  fit();
  root.appendChild(input);
  if (existing) an.els = an.els.filter((z) => z.id !== existing.id);
  redraw();

  let done = false;
  const finish = (keep) => {
    if (done) return;
    done = true;
    activeField = null;
    const val = input.value.trim();
    input.remove();
    if (keep && val) {
      const x = { id: existing?.id || uid(), type: 'text', x: p.x, y: p.y, text: val, size, color: TEXT_INK };
      an.els.push(x);
      markDirty();
    } else if (existing) {
      an.els.push(existing);
    }
    // Nothing else happens: no selection chrome is left on the caption and
    // the select tool is armed, so the next click is whatever you meant it
    // to be rather than a second text box.
    an.sel.clear();
    setTool('select');
    redraw();
  };
  activeField = { finish };
  input.oninput = fit;
  input.onkeydown = (e) => {
    e.stopPropagation();
    if (e.key === 'Enter') { e.preventDefault(); finish(true); }
    if (e.key === 'Escape') { e.preventDefault(); finish(false); }
  };
  input.onblur = () => finish(true);
  setTimeout(() => input.focus(), 0);
}

// A PLAYER'S LABEL IS TYPED ON THE DISC. The field is transparent, centred
// and sized off the disc's own radius through the same `r * 0.82 / 1.0`
// ratio flat.js draws the label at, so what is typed sits exactly where the
// committed label will. The element's own label is NOT updated as you type -
// the canvas would draw it under the field and every glyph would double.
// The one field open on the picture at a time, whichever kind it is. It is
// held here rather than found in the DOM because `onDown` has to CLOSE it,
// not just detect it, and a hidden or unfocused field never fires blur.
let activeField = null;

function openPlayerLabelInput(x) {
  const root = el('anRoot');
  activeField?.finish(true);
  root.querySelector('.an-poslabel')?.remove();
  const v = viewBox();
  const rootR = root.getBoundingClientRect();
  const scale = v.scale;
  const d = x.r * 2 * scale;
  const input = document.createElement('input');
  input.className = 'an-poslabel';
  input.maxLength = 2;
  input.value = x.label || '';
  input.style.left = `${v.left - rootR.left + x.x * scale - d / 2}px`;
  input.style.top = `${v.top - rootR.top + x.y * scale - d / 2}px`;
  input.style.width = `${d}px`;
  input.style.height = `${d}px`;
  input.style.lineHeight = `${d}px`;
  input.style.color = labelInkOn(x.color);
  const size = () => {
    const n = input.value.trim().length;
    input.style.fontSize = `${Math.max(9, x.r * (n > 1 ? 0.82 : 1.0) * scale)}px`;
  };
  size();
  // Hide the committed label while the field is open, so the disc under it
  // is blank and only one set of glyphs is ever on screen.
  const was = x.label;
  x.label = '';
  root.appendChild(input);
  redraw();

  let done = false;
  const finish = (keep) => {
    if (done) return;
    done = true;
    activeField = null;
    const val = keep ? input.value.trim().toUpperCase().slice(0, 2) : was;
    input.remove();
    x.label = val;
    if (val !== was) markDirty();
    // Return, Escape and a click off the disc all mean the same thing: this
    // marker is finished. Drop the selection so no chrome is left on it and
    // arm select, which is what anyone does next.
    an.sel.clear();
    setTool('select');
    redraw();
  };
  activeField = { finish };
  input.oninput = size;
  input.onkeydown = (e) => {
    e.stopPropagation();
    if (e.key === 'Enter') { e.preventDefault(); finish(true); }
    if (e.key === 'Escape') { e.preventDefault(); finish(false); }
  };
  input.onblur = () => finish(true);
  setTimeout(() => { input.focus(); input.select(); }, 0);
}

// ------------------------------------------------------------- keys

function onKey(e) {
  if (toolMenuEl && e.key === 'Escape') { e.preventDefault(); e.stopPropagation(); closeToolMenu(); return; }
  if (!an) return;
  const t = e.target;
  if (t && (t.tagName === 'INPUT' || t.tagName === 'TEXTAREA')) return;
  if (e.metaKey || e.ctrlKey || e.altKey) return;
  const k = e.key.toLowerCase();

  if ((e.key === 'Backspace' || e.key === 'Delete') && an.sel.size) {
    e.preventDefault();
    an.els = an.els.filter((z) => !an.sel.has(z.id));
    an.sel.clear();
    markDirty();
    redraw();
    return;
  }
  // Escape disarms a tool first, and only closes once nothing is armed -
  // otherwise a stray Escape mid-drawing throws away the whole session.
  if (e.key === 'Escape') {
    e.preventDefault();
    if (an.tool !== 'select') { an.tool = 'select'; an.sel.clear(); paintBar(); redraw(); return; }
    if (an.sel.size) { an.sel.clear(); redraw(); return; }
    done();
    return;
  }
  if (e.key === 'Enter') { e.preventDefault(); done(); return; }

  for (const [tool] of TOOLS) {
    if (k && k === keyFor(tool)) { e.preventDefault(); setTool(tool); return; }
  }
  if (k === (prefs.actKeys.clear || ACT_KEYS.clear)) { e.preventDefault(); clearAll(); return; }
  if (k === (prefs.actKeys.export || ACT_KEYS.export)) { e.preventDefault(); an.onExport?.(composite(), an.freeze); }
}

let dirty = false;
const markDirty = () => { dirty = true; };

function setTool(t) {
  an.tool = t;
  // Switching tools drops the swatch override and shows the new tool's own
  // colour, so the bar always tells the truth about what will be drawn.
  // The swatch survives a tool change now - that is what makes it global.
  // Until one is picked, the bar still shows the armed tool's own colour.
  const st = { ...DEFAULT_STYLE[t], ...(prefs.style[t] || {}) };
  if (!an.colorSet && st.color) an.color = st.color;
  if (t !== 'select') an.sel.clear();
  paintBar();
  redraw();
  canvas().style.cursor = t === 'select' ? 'default' : 'crosshair';
}

function clearAll() {
  an.els = [];
  an.sel.clear();
  markDirty();
  an.onDraw?.();   // the video stays paused through Clear too
  redraw();
}

// ------------------------------------------------------------- toolbar

// THE BAR IS ALWAYS FULLY EXPANDED (2026-08-29, Tony's call). It used to
// collapse to a row of tool icons whenever no freeze was open, so the colours,
// the shape style, the position markers and the actions appeared and vanished
// under the pointer. One builder draws both states now: idle differs only in
// that the tools carry `data-idle` (picking one freezes the frame and arms it)
// and the actions are disabled, because there is nothing yet to act on.
// THE PLAYER BUTTONS ARE THE DIAGRAMS PLAYER BUTTONS (2026-08-29, Tony's
// call): three coloured circles, each opening the same hover menu of position
// labels the rink editor uses. Eight fixed chips (D1..F3) were a row of text
// buttons that looked nothing like the thing they placed; a circle that looks
// like the marker is its own label. The .tb-player and .pmenu recipes come
// from diagrams/css/app.css, which Clips already imports - one recipe, two
// apps, no copy.
//
// NOTE FOR ANYONE EDITING THE TEMPLATE BELOW: it is one long template
// literal, so an HTML comment inside it is still STRING CONTENT and a
// backtick in that comment ENDS THE STRING. That is exactly how this line
// first shipped broken. Keep prose in JS comments, out here.
function barHtml(live) {
  const key = (k) => (k ? `<span class="tb-key">${k.toUpperCase()}</span>` : '');
  const dis = live ? '' : ' disabled';
  return `
    ${orderedTools().map(([t, label, icon]) => {
      const on = live && an.tool === t;
      const k = keyFor(t);
      const attr = live ? `data-tool="${t}"` : `data-idle="${t}"`;
      const tip = live
        ? `${label} (${k.toUpperCase()}) - Right-Click For Its Settings, Drag To Reorder`
        : `${label} - Freezes This Frame And Starts Drawing. Right-Click For Its Settings, Drag To Reorder`;
      return `<button class="tb-btn${on ? ' on' : ''}" ${attr} data-toolid="${t}" draggable="true" data-tip="${tip}" aria-label="${label}">${icon}${key(k)}</button>`;
    }).join('')}
    <span class="tb-sep"></span>
    ${colorsOf().map((hex, i) => `<button class="tb-swatch${live && an.color === hex ? ' on' : ''}" data-color="${hex}" data-preset="${i}" style="--c:${hex}" data-tip="Colour ${i + 1}${live ? '' : ' (Pick A Tool First)'} - Right-Click To Change It" aria-label="Colour ${i + 1}"></button>`).join('')}
    <span class="tb-sep"></span>
    ${PLAYER_SLOTS.map((c, i) => `<button class="tb-player${live && an.tool === 'pos' && an.posColor === c ? ' on' : ''}" ${live ? `data-slot="${i}"` : `data-idleslot="${i}"`} style="--c:${c}" data-tip="${live ? 'Place A Player - Type Two Letters On It' : 'Place A Player - Freezes This Frame And Starts Drawing'}" aria-label="Player ${i + 1}"></button>`).join('')}
    <span class="tb-sep"></span>
    <button class="tb-btn" data-act="clear" data-tip="Clear Every Drawing (${prefs.actKeys.clear.toUpperCase()})" aria-label="Clear"${dis}>${ICON_CLEAR}${key(prefs.actKeys.clear)}</button>
    <button class="tb-btn" data-act="export" data-tip="Export This Freeze - Nothing Leaves This App Until You Press It (${prefs.actKeys.export.toUpperCase()})" aria-label="Export"${dis}>${ICON_EXPORT}${key(prefs.actKeys.export)}</button>
    <button class="tb-btn tb-done${live ? ' on' : ''}" data-act="done" data-tip="Finish Without Exporting (Return Or Escape)" aria-label="Done"${dis}>${ICON_DONE}</button>`;
}

// ---------------------------------------------------------- the tool menu
//
// RIGHT-CLICK A TOOL FOR ITS SETTINGS (2026-08-29, Tony's call). Right-click
// used to raise a bare `prompt()` for the key and nothing else, so the colour,
// thickness and dash of a tool could only be reached through the Settings
// sheet - four clicks away from the tool you were already pointing at. This
// edits the SAME `settings.toolStyle` and `settings.toolKeys` records, so
// there is one source of truth and Settings still shows what was set here.
let toolMenuEl = null;
function closeToolMenu() { toolMenuEl?.remove(); toolMenuEl = null; }

// It closes on a click anywhere else and on Escape. Both listeners are
// installed once, at module level, because the panel outlives every repaint
// of the bar that opened it - it is parented to the body for exactly that
// reason, and a listener rebound per repaint would leak one per paint.
document.addEventListener('pointerdown', (e) => {
  if (!toolMenuEl) return;
  if (e.target.closest?.('.tmenu')) return;
  closeToolMenu();
}, true);
document.addEventListener('keydown', (e) => {
  if (!toolMenuEl || e.key !== 'Escape') return;
  e.preventDefault();
  e.stopPropagation();
  closeToolMenu();
}, true);

function openToolMenu(tool, btn) {
  closeToolMenu();
  const meta = TOOLS.find((x) => x[0] === tool);
  const styled = !!DEFAULT_STYLE[tool];
  const st = { ...DEFAULT_STYLE[tool], ...(prefs.style[tool] || {}) };
  const m = document.createElement('div');
  m.className = 'tmenu';
  m.innerHTML = `
    <div class="tmenu-head">${meta ? meta[1] : tool}</div>
    <label class="tmenu-row"><span>Shortcut</span>
      <input class="tmenu-key" maxlength="1" value="${keyFor(tool)}" spellcheck="false" aria-label="Shortcut"></label>
    ${styled ? `
    <label class="tmenu-row"><span>Colour</span>
      <input class="tmenu-color" type="color" value="${st.color}" aria-label="Colour"></label>
    <label class="tmenu-row"><span>Thickness</span>
      <input class="tmenu-width" type="number" min="1" max="40" value="${st.width}" aria-label="Thickness"></label>
    <label class="tmenu-row"><span>Dashed</span>
      <input class="tmenu-dash" type="checkbox"${st.dash ? ' checked' : ''} aria-label="Dashed"></label>` : ''}`;
  document.body.appendChild(m);
  toolMenuEl = m;
  const r = btn.getBoundingClientRect();
  m.style.left = `${Math.max(8, Math.min(window.innerWidth - m.offsetWidth - 8, r.left + r.width / 2 - m.offsetWidth / 2))}px`;
  m.style.top = `${Math.max(8, r.top - m.offsetHeight - 10)}px`;

  const q = (c) => m.querySelector(c);
  // A key another tool holds is TAKEN, and the loser is cleared - the same
  // rule the tag panel's editor follows, for the same reason: a shortcut
  // that silently never fires is invisible until the moment it is needed.
  q('.tmenu-key').oninput = (e) => {
    const k = (e.target.value || '').trim().slice(0, 1).toLowerCase();
    e.target.value = k;
    const keys = { ...prefs.keys };
    let lost = null;
    if (k) for (const [t2, k2] of Object.entries(keys)) if (t2 !== tool && k2 === k) { keys[t2] = ''; lost = t2; }
    keys[tool] = k;
    savePrefs({ toolKeys: keys });
    if (lost) toast(`${k.toUpperCase()} Moved To ${meta ? meta[1] : tool} - ${TOOLS.find((x) => x[0] === lost)?.[1] || lost} Has No Key Now`, true);
    repaintBar();
  };
  const setStyle = (patch) => {
    const style = { ...prefs.style, [tool]: { ...st, ...patch } };
    savePrefs({ toolStyle: style });
    Object.assign(st, patch);
    // A tool already armed takes the change immediately, or it reads as
    // ignored until the next time it is picked.
    if (an && an.tool === tool && patch.color) { an.color = patch.color; an.colorSet = true; }
    repaintBar();
  };
  q('.tmenu-key').onkeydown = (e) => e.stopPropagation();
  if (styled) {
    q('.tmenu-color').oninput = (e) => setStyle({ color: e.target.value });
    q('.tmenu-width').onchange = (e) => setStyle({ width: Math.max(1, Math.min(40, Number(e.target.value) || 1)) });
    q('.tmenu-width').onkeydown = (e) => e.stopPropagation();
    q('.tmenu-dash').onchange = (e) => setStyle({ dash: e.target.checked });
  }
  setTimeout(() => q('.tmenu-key').focus(), 0);
}

// The bar repaints in whichever state it is in. A menu open over it must
// survive that repaint, so it lives on document.body and is never rebuilt.
function repaintBar() {
  if (an) paintBar();
  else idleHook?.();
}

// DRAG TO REARRANGE (2026-08-29, Tony's call). The order is a settings record
// like everything else here, so it holds across sessions and across freezes.
function wireToolDrag(bar) {
  let from = null;
  for (const b of bar.querySelectorAll('[data-toolid]')) {
    b.addEventListener('dragstart', (e) => {
      from = b.dataset.toolid;
      e.dataTransfer.effectAllowed = 'move';
      e.dataTransfer.setData('text/plain', from);
      b.classList.add('tb-dragging');
    });
    b.addEventListener('dragend', () => b.classList.remove('tb-dragging'));
    b.addEventListener('dragover', (e) => { e.preventDefault(); b.classList.add('tb-over'); });
    b.addEventListener('dragleave', () => b.classList.remove('tb-over'));
    b.addEventListener('drop', (e) => {
      e.preventDefault();
      b.classList.remove('tb-over');
      const to = b.dataset.toolid;
      if (!from || from === to) return;
      const next = prefs.order.filter((t) => t !== from);
      next.splice(next.indexOf(to), 0, from);
      savePrefs({ toolOrder: next });
      from = null;
      repaintBar();
    });
  }
}

// Right-click a swatch to change it. Left-click still arms it for the tool in
// hand, which is done a hundred times a session; changing a preset is done
// twice a year, so it lives behind the second button. The picker opens in the
// SAME `.tmenu` panel the tools use rather than as a hidden native input
// triggered by script - one panel recipe on this bar, and a control the eye
// can find before it is clicked.
function openSwatchMenu(i, btn) {
  closeToolMenu();
  const m = document.createElement('div');
  m.className = 'tmenu';
  m.innerHTML = `
    <div class="tmenu-head">Colour ${i + 1}</div>
    <label class="tmenu-row"><span>Colour</span>
      <input class="tmenu-color" type="color" value="${colorsOf()[i]}" aria-label="Colour ${i + 1}"></label>`;
  document.body.appendChild(m);
  toolMenuEl = m;
  const r = btn.getBoundingClientRect();
  m.style.left = `${Math.max(8, Math.min(window.innerWidth - m.offsetWidth - 8, r.left + r.width / 2 - m.offsetWidth / 2))}px`;
  m.style.top = `${Math.max(8, r.top - m.offsetHeight - 10)}px`;
  m.querySelector('.tmenu-color').oninput = (e) => {
    const next = [...colorsOf()];
    next[i] = e.target.value;
    savePrefs({ colorPresets: next });
    // The swatch under the pointer updates without rebuilding the bar, which
    // would tear this panel's own anchor out from under it.
    btn.style.setProperty('--c', e.target.value);
    btn.dataset.color = e.target.value;
  };
}

function wireSwatches(bar, live) {
  for (const b of bar.querySelectorAll('[data-preset]')) {
    const i = Number(b.dataset.preset);
    b.oncontextmenu = (e) => { e.preventDefault(); openSwatchMenu(i, b); };
    if (!live) b.onclick = () => toast('Pick A Tool First - The Swatch Colours What You Draw');
  }
}

function paintBar() {
  const bar = el('anBar');
  bar.innerHTML = barHtml(true);
  bar.querySelectorAll('[data-tool]').forEach((b) => {
    b.onclick = () => setTool(b.dataset.tool);
    b.oncontextmenu = (ev) => { ev.preventDefault(); openToolMenu(b.dataset.tool, b); };
  });
  for (const b of bar.querySelectorAll('[data-slot]')) {
    const slot = Number(b.dataset.slot);
    // No hover menu any more: a player button places a player, and its label
    // is typed on the disc.
    b.onclick = () => { an.posColor = PLAYER_SLOTS[slot]; an.posLabel = ''; setTool('pos'); };
  }
  wireToolDrag(bar);
  wireSwatches(bar, true);
  bar.querySelectorAll('[data-color]').forEach((b) => {
    b.onclick = () => {
      an.color = b.dataset.color;
      // The swatch is a live override for the ACTIVE tool only, so picking
      // red and drawing an arrow does not silently repaint the box tool too.
      an.colorSet = true;
      // Recolour whatever is selected, so a colour can be changed after the
      // fact instead of only before.
      for (const id of an.sel) {
        const x = an.els.find((z) => z.id === id);
        if (x) { x.color = an.color; markDirty(); }
      }
      paintBar();
      redraw();
    };
  });
  wireHold();
  const act = (n, f) => { bar.querySelector(`[data-act="${n}"]`).onclick = f; };
  act('clear', clearAll);
  act('export', () => an.onExport?.(composite(), an.freeze));
  act('done', done);
}

// The frame with the drawing burned in - for exports and the Diagrams handoff.
export function composite() {
  const c = document.createElement('canvas');
  c.width = an.vw; c.height = an.vh;
  const ctx = c.getContext('2d');
  ctx.drawImage(an.frame, 0, 0);
  for (const x of an.els) drawAny(ctx, x);
  return c;
}

// Everything drawn, for a recording that has to composite it live.
export function annotationElements() { return an ? an.els : []; }
export function annotationSize() { return an ? { w: an.vw, h: an.vh } : null; }
export function paintAnnotations(ctx) { if (an) for (const x of an.els) drawAny(ctx, x); }

// DONE FINISHES, IT DOES NOT EXPORT (2026-08-29, Tony's call, reversing the
// 2026-08-27 rule where Done was the export). Nothing leaves this app unless
// Export is pressed. `onDone` still fires so the app can pause and tidy up -
// it just no longer writes a file.
function done() {
  an.freeze.elements = an.els;
  const cb = an.onDone;
  const f = an.freeze;
  const wasDirty = dirty;
  teardown();
  if (cb) cb(f, wasDirty);
}

// THE HOLD FIELD MOVED TO THE TOP BAR (2026-08-29, Tony's call). It is the
// one control on the annotation strip that is not a drawing decision - it
// sizes the export - and a number field in a row of glyphs was the widest
// thing there. It lives in the player header now and is disabled until a
// freeze is open, because a hold with nothing to hold on is meaningless.
function wireHold() {
  const h = el('vpHold');
  if (!h) return;
  h.disabled = !an;
  h.value = an ? (an.freeze.hold ?? 3) : (h.value || 3);
  // The hold is written back to the GAME RECORD, not just to the live
  // session. It never was: the field used to sit on the annotation bar and
  // only set `an.freeze.hold`, so the number survived only if the game
  // happened to autosave for some other reason before Done. Moving the
  // control somewhere permanent made that visible.
  h.onchange = () => {
    if (!an) return;
    an.freeze.hold = Math.max(0, Number(h.value) || 0);
    markDirty();
    an.onFreeze?.(an.freeze);
  };
  h.onkeydown = (e) => e.stopPropagation();
}

function teardown() {
  closeToolMenu();
  el('anRoot').hidden = true;
  an = null;
  dirty = false;
  // The bar is always on screen, so closing a freeze hands it back to the
  // idle row rather than leaving the last session's controls sitting there
  // with nothing behind them.
  idleHook?.();
}

// Set once by the app so teardown can restore the idle bar without annotate
// needing to know how a freeze is started.
let idleHook = null;
export function onAnnotateIdle(fn) { idleHook = fn; }

// Saving Settings pushes the whole record back into `prefs` and repaints
// whichever bar is on screen. Without this a colour change would look ignored
// until the next freeze, which reads as a bug rather than as a scoping rule.
// It takes the SETTINGS OBJECT now, not two loose arguments, because there
// are six fields the bar reads and they all arrive together.
export function applyToolStyle(settings = {}) {
  setToolPrefs(settings);
  if (!an) { idleHook?.(); return; }
  if (settings.positions) an.positions = settings.positions;
  // The armed tool's colour becomes the global one, so a colour changed in
  // Settings is visible immediately rather than looking ignored.
  const st = { ...DEFAULT_STYLE[an.tool], ...(prefs.style[an.tool] || {}) };
  if (st.color) { an.color = st.color; an.colorSet = true; }
  paintBar();
  redraw();
}

// ------------------------------------------------------------- open

let wired = false;
export function openAnnotate(freeze, frameCanvas, { onDone, onExport, onFreeze, keys, actKeys, style, positions, armTool, autoSelect = true, onDraw, colorPresets, textSize, toolOrder, shapeStyle, shapeAlpha, arrowHead } = {}) {
  const root = el('anRoot');
  root.hidden = false;
  // Preferences are module state, not per-freeze state: the bar is on screen
  // before any freeze exists and has to read the same values then.
  setToolPrefs({ toolKeys: keys, toolStyle: style, colorPresets, toolOrder, shapeStyle, shapeAlpha, arrowHead, actKeys });
  an = {
    freeze,
    els: structuredClone(freeze.elements || []),
    tool: freeze.elements?.length ? 'select' : 'pen',
    color: prefs.colors[0],
    sel: new Set(),
    drag: null,
    band: null,
    positions: positions || ['D1', 'D2', 'C', 'W1', 'W2', 'F1', 'F2', 'F3'],
    posLabel: pendingPos?.label ?? '',
    // Selected from the start: the first swatch IS the current colour, and
    // every colourable tool takes it.
    colorSet: true,
    autoSelect,
    onDraw,
    textSize: textSize || TEXT_SIZE,
    posColor: pendingPos?.color || PLAYER_SLOTS[0],
    actKeys: { ...ACT_KEYS, ...(actKeys || {}) },
    vw: frameCanvas.width,
    vh: frameCanvas.height,
    frame: frameCanvas,
    onDone,
    onExport,
    onFreeze,
  };
  // Read once: a parked choice belongs to the freeze it opened, not to the
  // next one.
  pendingPos = null;
  const c = canvas();
  c.width = an.vw; c.height = an.vh;
  const f = el('anFrame');
  f.width = an.vw;
  f.height = an.vh;
  f.getContext('2d').drawImage(frameCanvas, 0, 0);
  if (!wired) {
    wired = true;
    c.addEventListener('pointerdown', onDown);
    c.addEventListener('dblclick', (e) => {
      if (!an) return;
      const x = hitAt(pt(e));
      if (x?.type === 'text') openTextInput({ x: x.x, y: x.y }, x);
      else if (x?.type === 'player') openPlayerLabelInput(x);
    });
    window.addEventListener('pointermove', onMove);
    window.addEventListener('pointerup', onUp);
    window.addEventListener('keydown', onKey, true);
  }
  setTool(armTool || an.tool);
  redraw();
  void toast;
}
