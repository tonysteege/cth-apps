// One renderer for every surface: the editor stage, filmstrip thumbs, home
// cards and the projector all draw a slide through slideHtml(). Geometry is
// slide space (1600x900); the stage is a size container and text is sized
// in cqw so one record lays out identically at every scale.

import { SLIDE_W, SLIDE_H, styleOf, LOGOS } from './model.js';
import { assetUrl, getDrill } from './store.js';
import { renderStateFlat } from '/diagrams/js/flat.js';
import { loadAssets } from '/diagrams/js/rink.js';

// Standard-rink diagrams composite over the Diagrams app's own rink art;
// load it once, from the Diagrams app's folder, before the first render.
let assetsP = null;
const rinkReady = () => (assetsP ||= loadAssets('/diagrams/assets'));

export const esc = (s) => String(s ?? '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');

const pct = (v, of) => `${(v / of) * 100}%`;
// Font size in cqw: size slide-units out of 1600 wide.
const fs = (size) => `${(size / SLIDE_W) * 100}cqw`;

export function elHtml(e, theme) {
  const box = `left:${pct(e.x, SLIDE_W)};top:${pct(e.y, SLIDE_H)};width:${pct(e.w, SLIDE_W)};height:${pct(e.h, SLIDE_H)}`;
  if (e.type === 'text') {
    const st = styleOf(theme, e.role);
    const size = e.size || st.size;
    const color = e.color || st.color;
    const sty = `${box};font-size:${fs(size)};font-weight:${e.weight || st.weight};color:${color};line-height:${st.line};text-align:${e.align || 'left'}`;
    return `<div class="dk-el dk-el-text" data-el="${e.id}" style="${sty}">${esc(e.text).replace(/\n/g, '<br>')}</div>`;
  }
  if (e.type === 'shape') {
    const fill = e.fill || '#0a0a0a';
    const alpha = e.alpha == null ? 1 : e.alpha;
    const inner =
      e.shape === 'ellipse' ? `<div class="dk-shape" style="background:${fill};opacity:${alpha};border-radius:50%"></div>` :
      e.shape === 'line' ? `<div class="dk-shape dk-line" style="background:${fill};opacity:${alpha}"></div>` :
      e.shape === 'arrow' ? `<svg class="dk-shape" viewBox="0 0 100 100" preserveAspectRatio="none" style="opacity:${alpha}"><line x1="2" y1="50" x2="86" y2="50" stroke="${fill}" stroke-width="8" vector-effect="non-scaling-stroke"/><path d="M84 38 L98 50 L84 62 Z" fill="${fill}"/></svg>` :
      `<div class="dk-shape" style="background:${fill};opacity:${alpha};border-radius:${(e.radius || 0) / 8}cqw"></div>`;
    const label = e.text ? `<div class="dk-shape-label" style="font-size:${fs(30)}">${esc(e.text)}</div>` : '';
    return `<div class="dk-el dk-el-shape" data-el="${e.id}" style="${box}">${inner}${label}</div>`;
  }
  if (e.type === 'image') {
    return `<div class="dk-el dk-el-image" data-el="${e.id}" style="${box}"><img data-asset="${esc(e.asset)}" alt=""></div>`;
  }
  if (e.type === 'logo') {
    const l = LOGOS[e.variant] || LOGOS['icon-black'];
    return `<div class="dk-el dk-el-logo" data-el="${e.id}" style="${box}"><img src="${l.src}" alt="CTH" draggable="false"></div>`;
  }
  if (e.type === 'video') {
    return `<div class="dk-el dk-el-video" data-el="${e.id}" style="${box}"><video data-asset="${esc(e.asset)}" playsinline preload="metadata"></video><div class="dk-vbadge">video</div></div>`;
  }
  if (e.type === 'diagram') {
    return `<div class="dk-el dk-el-diagram" data-el="${e.id}" style="${box}"><canvas data-drill="${esc(e.drill)}"></canvas></div>`;
  }
  return '';
}

export function slideHtml(s, theme) {
  const els = (s.els || []).map((e) => elHtml(e, theme)).join('');
  const bg = s.bgImage && s.bgImage.src
    ? `<div class="dk-bgimg dk-bgimg--${esc(s.bgImage.mode || 'full')}" aria-hidden="true"><img src="${esc(s.bgImage.src)}" alt="" draggable="false"></div>`
    : '';
  const dgm = s.dgm && s.dgm.elements && s.dgm.elements.length
    ? `<canvas class="dk-dgm" data-dgm="${esc(JSON.stringify({ els: s.dgm.elements, mode: s.bgImage?.mode || 'none' }))}" aria-hidden="true"></canvas>`
    : '';
  return `<div class="dk-stage" data-slide="${s.id}" style="background:${s.bg || '#ffffff'}">${bg}${dgm}${els}</div>`;
}

// ------------------------------------------------------------- board items
//
// Every non-deck object on the whiteboard. Positions are board px at zoom
// 1, written as absolute left/top/width/height on the item's wrapper.

const boxStyle = (it) => `left:${it.x}px;top:${it.y}px;width:${it.w}px;height:${it.h}px${it.rot ? `;transform:rotate(${it.rot}deg)` : ''}`;

export function itemHtml(it) {
  const lock = it.locked ? ' wb-locked' : '';
  if (it.kind === 'sticky') {
    return `<div class="wb-item wb-sticky${lock}" data-item="${it.id}" style="${boxStyle(it)};background:${it.color}"><div class="wb-sticky-text">${esc(it.text).replace(/\n/g, '<br>')}</div></div>`;
  }
  if (it.kind === 'text') {
    return `<div class="wb-item wb-text${lock}" data-item="${it.id}" style="${boxStyle(it)};font-size:${it.size || 24}px;color:${it.color || '#0a0a0a'};text-align:${it.align || 'left'}"><div class="wb-text-body">${esc(it.text).replace(/\n/g, '<br>')}</div></div>`;
  }
  if (it.kind === 'shape') {
    const fill = it.fill || '#ffffff'; const stroke = it.stroke || '#0a0a0a';
    const alpha = it.alpha == null ? 1 : it.alpha;
    let body;
    const sw = it.sw || 2;
    if (it.shape === 'ellipse') body = `<div class="wb-shape-body" style="background:${fill};border:${sw}px solid ${stroke};border-radius:50%;opacity:${alpha}"></div>`;
    else if (it.shape === 'diamond') body = `<svg class="wb-shape-body" viewBox="0 0 100 100" preserveAspectRatio="none" style="opacity:${alpha}"><path d="M50 2 L98 50 L50 98 L2 50 Z" fill="${fill}" stroke="${stroke}" stroke-width="${sw}" vector-effect="non-scaling-stroke"/></svg>`;
    else if (it.shape === 'line') body = `<div class="wb-shape-body wb-shape-line" style="background:${stroke};opacity:${alpha}"></div>`;
    else if (it.shape === 'arrow') body = `<svg class="wb-shape-body" viewBox="0 0 100 100" preserveAspectRatio="none" style="opacity:${alpha}"><line x1="2" y1="50" x2="86" y2="50" stroke="${stroke}" stroke-width="3" vector-effect="non-scaling-stroke"/><path d="M84 38 L98 50 L84 62 Z" fill="${stroke}"/></svg>`;
    else body = `<div class="wb-shape-body" style="background:${fill};border:${sw}px solid ${stroke};border-radius:${it.radius || 0}px;opacity:${alpha}"></div>`;
    const label = it.text ? `<div class="wb-shape-label">${esc(it.text).replace(/\n/g, '<br>')}</div>` : '';
    return `<div class="wb-item wb-shape${lock}" data-item="${it.id}" style="${boxStyle(it)}">${body}${label}</div>`;
  }
  if (it.kind === 'pen') {
    const d = (it.points || []).map((p, i) => `${i ? 'L' : 'M'}${p[0]} ${p[1]}`).join(' ');
    return `<div class="wb-item wb-pen${lock}" data-item="${it.id}" style="${boxStyle(it)}"><svg width="${it.w}" height="${it.h}" viewBox="0 0 ${it.w} ${it.h}" overflow="visible"><path d="${d}" fill="none" stroke="${it.color}" stroke-width="${it.width}" stroke-linecap="round" stroke-linejoin="round"/></svg></div>`;
  }
  if (it.kind === 'section') {
    return `<div class="wb-item wb-section${lock}" data-item="${it.id}" style="${boxStyle(it)};background:${it.color}"><div class="wb-section-title">${esc(it.title || 'Section')}</div></div>`;
  }
  if (it.kind === 'image') return `<div class="wb-item wb-image${lock}" data-item="${it.id}" style="${boxStyle(it)}"><img data-asset="${esc(it.asset)}" alt="" decoding="async"></div>`;
  if (it.kind === 'video') return `<div class="wb-item wb-video${lock}" data-item="${it.id}" style="${boxStyle(it)}"><video data-asset="${esc(it.asset)}" playsinline preload="metadata" controls></video></div>`;
  if (it.kind === 'diagram') return `<div class="wb-item wb-diagram${lock}" data-item="${it.id}" style="${boxStyle(it)}"><canvas data-drill="${esc(it.drill)}"></canvas></div>`;
  return '';
}

// A deck on the board is a Figma-style SECTION ROW: a name tab above the
// row, a grip pill on the left edge that drags the whole row, a head bar
// over each frame (the number at rest, a blue drag bar when selected) and
// a + dot in every gap to insert a slide there. No header bar.
export function deckHtml(it, cur = -1, sel = null) {
  const n = it.slides.length;
  const col = it.orient === 'col';
  const PLUS = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" aria-hidden="true"><path d="M12 6v12M6 12h12"/></svg>';
  const frames = it.slides.map((s, i) => {
    const on = sel ? sel.has(i) : i === cur;
    const left = col ? 0 : i * (960 + 60); const top = col ? i * (540 + 60) : 0;
    const dots = [];
    // The dot(s) after this frame: along the deck's axis, and on a
    // single-slide deck both ways so the first + decides the orientation.
    if (!col || n === 1) dots.push(`<button class="dk-insert dk-insert-right" data-insert="${i + 1}" data-orient="row" aria-label="Insert slide to the right">${PLUS}</button>`);
    if (col || n === 1) dots.push(`<button class="dk-insert dk-insert-below" data-insert="${i + 1}" data-orient="col" aria-label="Insert slide below">${PLUS}</button>`);
    return `
    <div class="dk-frame ${on ? 'on' : ''} ${s.skip ? 'skip' : ''}" data-i="${i}" style="left:${left}px;top:${top}px;width:960px">
      <div class="dk-fhead" data-fhead="${i}" role="button" tabindex="-1" aria-label="Slide ${i + 1}, drag to reorder"><span class="dk-fnum">${i + 1}</span></div>
      ${slideHtml(s, it.theme)}
      <div class="dk-chrome" data-chrome="${it.id}:${i}"></div>
      ${dots.join('')}
    </div>`;
  }).join('');
  return `<div class="wb-item wb-deck wb-deck--${col ? 'col' : 'row'}${it.locked ? ' wb-locked' : ''}" data-item="${it.id}" style="${boxStyle(it)}">
    <div class="wb-deck-line" aria-hidden="true"></div>
    <button class="wb-deck-tab" data-decktab aria-label="Deck ${esc(it.name || 'Untitled Deck')}">${esc(it.name || 'Untitled Deck')}</button>
    <button class="wb-deck-grip" data-deckgrip aria-label="Drag deck"></button>
    ${frames}
  </div>`;
}

// Async pass after innerHTML: point images and videos at their object URLs
// and paint diagram canvases through the Diagrams renderer, so a rink on a
// slide is pixel-identical to the PNG the editor exports.
export async function hydrate(root) {
  for (const img of root.querySelectorAll('img[data-asset]')) {
    img.src = await assetUrl(img.dataset.asset);
  }
  for (const v of root.querySelectorAll('video[data-asset]')) {
    if (!v.src) v.src = await assetUrl(v.dataset.asset);
  }
  for (const c of root.querySelectorAll('canvas[data-drill]')) {
    paintDiagram(c, c.dataset.drill);
  }
  for (const c of root.querySelectorAll('canvas.dk-dgm[data-dgm]')) {
    try { const d = JSON.parse(c.dataset.dgm); paintDgm(c, d.els, d.mode); } catch (_) {}
  }
}

// The slide diagram layer: rink-unit elements drawn through flat.js onto a
// canvas that covers the slide's diagram box (see dgm.js for the box).
export async function paintDgm(canvas, els, mode) {
  await rinkReady();
  const { dgmBox, paintElements } = await import('./dgm.js');
  const box = dgmBox(mode);
  canvas.style.left = `${box.left}%`; canvas.style.top = `${box.top}%`;
  canvas.style.width = `${box.width}%`; canvas.style.height = `${box.height}%`;
  paintElements(canvas, els, mode);
}

const drillCache = new Map();
export async function paintDiagram(canvas, drillId) {
  try {
    let flat = drillCache.get(drillId);
    if (!flat) {
      await rinkReady();
      const rec = await getDrill(drillId);
      if (!rec || !rec.state) { paintMissing(canvas); return; }
      flat = await renderStateFlat(rec.state, 0.5);
      drillCache.set(drillId, flat);
    }
    canvas.width = flat.width;
    canvas.height = flat.height;
    canvas.getContext('2d').drawImage(flat, 0, 0);
  } catch (_) {
    paintMissing(canvas);
  }
}

function paintMissing(canvas) {
  canvas.width = 320; canvas.height = 160;
  const ctx = canvas.getContext('2d');
  ctx.fillStyle = '#f5f5f5'; ctx.fillRect(0, 0, 320, 160);
  ctx.fillStyle = '#a3a3a3'; ctx.font = '500 14px Inter, system-ui, sans-serif';
  ctx.textAlign = 'center'; ctx.fillText('Diagram not found', 160, 84);
}

export { SLIDE_W, SLIDE_H };
