// The toolbar dock: every tool in one row at the bottom of the window,
// scrolling sideways when it outgrows the width. Tony's own layout lives
// in localStorage `cthk.toolbar`: order (with dividers), shortcut keys,
// icons (any vendored Lucide name), and custom PNG object tools with a
// default size. Drag a tool to rearrange; right-click it for its menu.

import { iconSvg, ICON_NAMES } from './icons.js';

const KEY = 'cthk.toolbar';

// The built-in tools, in their default order. `group` is only used to
// place dividers by default.
export const BUILTIN = [
  { id: 'select', name: 'Select', key: 'v', icon: 'mouse-pointer-2' },
  { id: 'hand', name: 'Hand', key: 'h', icon: 'hand' },
  { id: 'sticky', name: 'Sticky Note', key: 's', icon: 'sticky-note' },
  { id: 'text', name: 'Text', key: 't', icon: 'type' },
  { id: 'shape', name: 'Shapes', key: 'r', icon: 'square' },
  { id: 'pen', name: 'Pen', key: 'p', icon: 'pen' },
  { id: 'connector', name: 'Connector', key: 'c', icon: 'spline' },
  { id: 'section', name: 'Section', key: 'f', icon: 'frame' },
  { id: 'deck', name: 'New Deck', key: 'd', icon: 'presentation' },
  { id: 'image', name: 'Image', key: '', icon: 'image' },
  { id: 'video', name: 'Video', key: '', icon: 'video' },
  { id: 'diagram', name: 'Saved Diagram', key: '', icon: 'map' },
  { id: 'divider', name: '', divider: true },
  // Diagram tools - the Diagrams app's own row, for drawing on a slide.
  { id: 'dg-skate', name: 'Skate', key: 'a', icon: 'arrow-right', dgm: 'line', kind: 'skate' },
  { id: 'dg-skatepuck', name: 'Skate With Puck', key: '', icon: 'waypoints', dgm: 'line', kind: 'skatepuck' },
  { id: 'dg-skateback', name: 'Skate Backwards', key: 'z', icon: 'route', dgm: 'line', kind: 'skateback' },
  { id: 'dg-shoot', name: 'Shoot', key: 'x', icon: 'goal', dgm: 'line', kind: 'shoot' },
  { id: 'dg-pass', name: 'Pass', key: '', icon: 'move-horizontal', dgm: 'line', kind: 'pass' },
  { id: 'dg-box', name: 'Shaded Box', key: 'b', icon: 'square-dashed', dgm: 'box', kind: 'box' },
  { id: 'dg-circle', name: 'Shaded Circle', key: '', icon: 'circle-dashed', dgm: 'box', kind: 'circle' },
  { id: 'dg-text', name: 'Ice Text', key: '', icon: 'text', dgm: 'text' },
  { id: 'dg-pen', name: 'Ice Pen', key: 'e', icon: 'pencil-line', dgm: 'pen' },
  { id: 'dg-p0', name: 'Player (Black)', key: '1', icon: 'circle', dgm: 'player', color: 'black' },
  { id: 'dg-p1', name: 'Player (Blue)', key: '2', icon: 'circle', dgm: 'player', color: 'blue' },
  { id: 'dg-p2', name: 'Player (Grey)', key: '3', icon: 'circle', dgm: 'player', color: 'grey' },
  { id: 'dg-coach', name: 'Coach', key: '', icon: 'user-round', dgm: 'stamp', kind: 'coach' },
  { id: 'dg-net', name: 'Net', key: 'n', icon: 'goal', dgm: 'stamp', kind: 'net' },
  { id: 'dg-puck', name: 'Puck', key: 'k', icon: 'circle-dot', dgm: 'stamp', kind: 'puck' },
  { id: 'dg-pucks', name: 'Pucks', key: 'u', icon: 'circle-dot-dashed', dgm: 'stamp', kind: 'pucks' },
  { id: 'dg-cone', name: 'Cone', key: 'o', icon: 'cone', dgm: 'stamp', kind: 'cone' },
  { id: 'dg-border', name: 'Border', key: 'w', icon: 'minus', dgm: 'stamp', kind: 'border' },
];

let cfg = null;
export function config() {
  if (cfg) return cfg;
  try { cfg = JSON.parse(localStorage.getItem(KEY) || 'null'); } catch (_) { cfg = null; }
  if (!cfg || !Array.isArray(cfg.order)) cfg = { order: BUILTIN.map((t) => t.id), keys: {}, icons: {}, custom: [] };
  cfg.keys ||= {}; cfg.icons ||= {}; cfg.custom ||= []; cfg.styles ||= {};
  // A tool added after the order was saved lands beside its neighbour.
  const known = new Set(cfg.order);
  BUILTIN.forEach((t, i) => {
    if (known.has(t.id)) return;
    const prev = BUILTIN.slice(0, i).reverse().find((p) => known.has(p.id));
    const at = prev ? cfg.order.indexOf(prev.id) + 1 : cfg.order.length;
    cfg.order.splice(at, 0, t.id); known.add(t.id);
  });
  return cfg;
}
export function save() { try { localStorage.setItem(KEY, JSON.stringify(cfg)); } catch (_) {} }
export function reset() { cfg = null; try { localStorage.removeItem(KEY); } catch (_) {} return config(); }

// Every tool the dock can show, resolved with Tony's overrides.
export function toolById(id) {
  const c = config();
  if (id === 'divider' || id.startsWith('divider-')) return { id, divider: true };
  const base = BUILTIN.find((t) => t.id === id) || c.custom.find((t) => t.id === id);
  if (!base) return null;
  return { ...base, key: c.keys[id] ?? base.key ?? '', icon: c.icons[id] || base.icon || 'image' };
}
export function tools() { return config().order.map(toolById).filter(Boolean); }
export function toolForKey(k) { return tools().find((t) => !t.divider && t.key && t.key === k) || null; }
export function setKey(id, key) {
  const c = config();
  for (const other of Object.keys(c.keys)) if (c.keys[other] === key && other !== id) c.keys[other] = '';
  for (const t of BUILTIN) if (t.id !== id && (c.keys[t.id] ?? t.key) === key) c.keys[t.id] = '';
  for (const t of c.custom) if (t.id !== id && (c.keys[t.id] ?? t.key) === key) c.keys[t.id] = '';
  c.keys[id] = key; save();
}
export function setIcon(id, icon) { config().icons[id] = icon; save(); }

// Per-tool settings (colour, thickness, outline, default size…), edited
// from the tool's right-click menu and read when the tool creates a thing.
export const STYLE_SCHEMA = {
  sticky:      { color: { t: 'color', l: 'Color', d: '#fef08a' }, w: { t: 'num', l: 'Default width', d: 220 }, h: { t: 'num', l: 'Default height', d: 220 } },
  text:        { size: { t: 'num', l: 'Font size', d: 24 }, color: { t: 'color', l: 'Color', d: '#0a0a0a' } },
  shape:       { fill: { t: 'color', l: 'Fill', d: '#ffffff' }, stroke: { t: 'color', l: 'Stroke', d: '#0a0a0a' }, width: { t: 'num', l: 'Stroke width', d: 2 }, outline: { t: 'bool', l: 'Outline only (no fill)', d: false }, alpha: { t: 'range', l: 'Opacity', d: 1, min: 0.1, max: 1, step: 0.05 }, radius: { t: 'num', l: 'Corner radius', d: 12 }, w: { t: 'num', l: 'Default width', d: 240 }, h: { t: 'num', l: 'Default height', d: 160 } },
  pen:         { color: { t: 'color', l: 'Color', d: '#0a0a0a' }, width: { t: 'range', l: 'Thickness', d: 4, min: 1, max: 24, step: 1 } },
  connector:   { color: { t: 'color', l: 'Color', d: '#0a0a0a' }, head: { t: 'bool', l: 'Arrowhead', d: true } },
  section:     { color: { t: 'color', l: 'Color', d: '#e0f2fe' }, w: { t: 'num', l: 'Default width', d: 1400 }, h: { t: 'num', l: 'Default height', d: 900 } },
  image:       { w: { t: 'num', l: 'Default width', d: 480 } },
  video:       { w: { t: 'num', l: 'Default width', d: 640 } },
  'dg-line':   { color: { t: 'dcolor', l: 'Color', d: 'black' }, width: { t: 'range', l: 'Thickness', d: 8, min: 2, max: 24, step: 1 } },
  'dg-box':    { color: { t: 'dcolor', l: 'Color', d: 'black' }, outline: { t: 'bool', l: 'Outline (no wash)', d: false }, alpha: { t: 'range', l: 'Wash opacity', d: 0.3, min: 0.1, max: 1, step: 0.05 }, w: { t: 'num', l: 'Default width', d: 400 }, h: { t: 'num', l: 'Default height', d: 300 } },
  'dg-text':   { color: { t: 'dcolor', l: 'Color', d: 'black' }, size: { t: 'num', l: 'Size', d: 48 } },
  'dg-pen':    { color: { t: 'dcolor', l: 'Color', d: 'black' }, width: { t: 'range', l: 'Thickness', d: 8, min: 2, max: 24, step: 1 } },
  'dg-player': { r: { t: 'num', l: 'Radius', d: 45 }, label: { t: 'text', l: 'Default label', d: '' } },
  'dg-stamp':  { scale: { t: 'range', l: 'Size', d: 1, min: 0.5, max: 2, step: 0.1 } },
  png:         { w: { t: 'num', l: 'Default width', d: 240 }, h: { t: 'num', l: 'Default height', d: 240 } },
};
export function schemaFor(t) {
  if (!t) return null;
  if (t.png) return STYLE_SCHEMA.png;
  if (t.dgm === 'line') return STYLE_SCHEMA['dg-line'];
  if (t.dgm === 'box') return STYLE_SCHEMA['dg-box'];
  if (t.dgm === 'text') return STYLE_SCHEMA['dg-text'];
  if (t.dgm === 'pen') return STYLE_SCHEMA['dg-pen'];
  if (t.dgm === 'player') return STYLE_SCHEMA['dg-player'];
  if (t.dgm === 'stamp') return STYLE_SCHEMA['dg-stamp'];
  return STYLE_SCHEMA[t.id] || null;
}
export function styleOf(id) {
  const c = config(); c.styles ||= {};
  const t = toolById(id); const schema = schemaFor(t) || {};
  const out = {};
  for (const k of Object.keys(schema)) out[k] = c.styles[id]?.[k] ?? schema[k].d;
  if (t && t.png) { out.w = c.styles[id]?.w ?? t.w; out.h = c.styles[id]?.h ?? t.h; }
  return out;
}
export function setStyle(id, patch) { const c = config(); c.styles ||= {}; c.styles[id] = { ...(c.styles[id] || {}), ...patch }; save(); }
export function addDividerAfter(id) { const c = config(); const at = c.order.indexOf(id); c.order.splice(at + 1, 0, `divider-${Date.now().toString(36)}`); save(); }
export function removeFromOrder(id) { const c = config(); c.order = c.order.filter((x) => x !== id); c.custom = c.custom.filter((t) => t.id !== id); save(); }
export function addCustom(tool) { const c = config(); c.custom.push(tool); c.order.push(tool.id); save(); }
export function updateCustom(id, patch) { const c = config(); const t = c.custom.find((x) => x.id === id); if (t) Object.assign(t, patch); save(); }
export function moveTool(id, toIndex) {
  const c = config(); const from = c.order.indexOf(id); if (from < 0) return;
  c.order.splice(from, 1); c.order.splice(Math.max(0, Math.min(c.order.length, toIndex)), 0, id); save();
}

const esc = (s) => String(s ?? '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');

// Paint the dock. `active` is the armed tool id; `on(tool, e)` handles a
// press, `onContext(tool, e)` the right-click, `onPlus(e)` the + at the end.
export function paint(host, { active, on, onContext, onPlus, customUrl }) {
  const list = tools();
  host.innerHTML = `<div class="dk-dockrow" role="toolbar" aria-label="Tools">${list.map((t) => {
    if (t.divider) return `<span class="dk-dockdiv" data-tool="${t.id}" aria-hidden="true"></span>`;
    const glyph = t.png && customUrl ? `<img class="dk-toolpng" src="${esc(customUrl(t))}" alt="">` : (t.dgm === 'player' ? playerGlyph(t.color) : iconSvg(t.icon));
    const key = t.key ? `<kbd class="dk-toolkey">${esc(keyLabel(t.key))}</kbd>` : '';
    return `<button class="dk-tool ${active === t.id ? 'on' : ''}" data-tool="${t.id}" aria-label="${esc(t.name)}" aria-pressed="${active === t.id}">${glyph}${key}</button>`;
  }).join('')}<button class="dk-tool dk-dockplus" data-plus aria-label="Customize toolbar">${iconSvg('plus')}</button></div>`;
  host.querySelectorAll('.dk-tool[data-tool]').forEach((b) => {
    const t = toolById(b.dataset.tool);
    b.onclick = (e) => on(t, e);
    b.oncontextmenu = (e) => { e.preventDefault(); onContext(t, e); };
    b.onpointerdown = (e) => startToolDrag(e, b, host, () => paint(host, { active, on, onContext, onPlus, customUrl }));
  });
  host.querySelectorAll('.dk-dockdiv').forEach((d) => { d.oncontextmenu = (e) => { e.preventDefault(); onContext(toolById(d.dataset.tool), e); }; });
  host.querySelector('[data-plus]').onclick = onPlus;
}

const playerGlyph = (color) => {
  const fill = { black: '#1e1e1e', blue: '#75d8ff', grey: '#d9d9d9' }[color] || '#1e1e1e';
  return `<svg viewBox="0 0 24 24" aria-hidden="true"><circle cx="12" cy="12" r="8.5" fill="${fill}" stroke="#1e1e1e" stroke-width="1.75"/></svg>`;
};
export const keyLabel = (k) => (k && k.length === 1 && k !== k.toLowerCase() ? `⇧${k}` : (k || '').toUpperCase());

// Pointer-driven rearrange: the real button moves with the pointer, the
// drop index is where the pointer sits over the row. No HTML5 DnD.
function startToolDrag(e, btn, host, repaint) {
  if (e.button !== 0) return;
  const sx = e.clientX; let started = false;
  const row = host.querySelector('.dk-dockrow');
  const move = (ev) => {
    if (!started && Math.abs(ev.clientX - sx) > 8) { started = true; btn.classList.add('dragging'); row.classList.add('sorting'); }
    if (!started) return;
    const items = [...row.querySelectorAll('.dk-tool[data-tool], .dk-dockdiv')].filter((x) => x !== btn);
    let target = null;
    for (const it of items) { const r = it.getBoundingClientRect(); if (ev.clientX < r.left + r.width / 2) { target = it; break; } }
    if (target) row.insertBefore(btn, target); else row.insertBefore(btn, row.querySelector('[data-plus]'));
  };
  const up = () => {
    window.removeEventListener('pointermove', move); window.removeEventListener('pointerup', up);
    if (!started) return;
    btn.classList.remove('dragging'); row.classList.remove('sorting');
    const order = [...row.querySelectorAll('[data-tool]')].map((x) => x.dataset.tool);
    config().order = order; save(); repaint();
  };
  window.addEventListener('pointermove', move); window.addEventListener('pointerup', up);
}

export { ICON_NAMES, iconSvg };
