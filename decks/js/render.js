// One renderer for every surface: the editor stage, filmstrip thumbs, home
// cards and the projector all draw a slide through slideHtml(). Geometry is
// slide space (1600x900); the stage is a size container and text is sized
// in cqw so one record lays out identically at every scale.

import { SLIDE_W, SLIDE_H, styleOf } from './model.js';
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
  return `<div class="dk-stage" data-slide="${s.id}" style="background:${s.bg || '#ffffff'}">${els}</div>`;
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
