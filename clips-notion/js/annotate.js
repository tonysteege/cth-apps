// CTH Clips Notion - the annotation toolbar. Telestration over the paused
// picture with the DIAGRAMS renderer (flat.js drawEl): the same marks a
// coach draws on a rink - motion arrows, shaded box and circle, text,
// players, pen - in 1280-wide VIDEO UNITS mapped onto the letterboxed
// picture (the Clips viewBox rule: object-fit: contain means the element
// box is not the picture). Marks persist per video URL in localStorage so a
// Notion reload mid-presentation does not lose them; Clear wipes them.

import { drawEl, colorOf } from '/diagrams/js/flat.js';
import { iconSvg } from '/boards/js/icons.js';

const $ = (s, r) => (r || document).querySelector(s);
const $$ = (s, r) => [...(r || document).querySelectorAll(s)];
const uid = () => Math.random().toString(36).slice(2, 10);
const UNIT_W = 1280;
const KEY = 'cthcn.marks.v1';

const TOOLS = [
  { id: 'select', name: 'Select', key: 'v', icon: 'mouse-pointer-2' },
  { id: 'pen', name: 'Pen', key: 'e', icon: 'pen' },
  { id: 'arrow', name: 'Skate', key: 'a', icon: 'arrow-right', line: {} },
  { id: 'skatepuck', name: 'Skate With Puck', key: 's', icon: 'waypoints', line: { motion: 'puck' } },
  { id: 'skateback', name: 'Skate Backwards', key: 'z', icon: 'route', line: { motion: 'backward' } },
  { id: 'shoot', name: 'Shoot', key: 'x', icon: 'goal', line: { motion: 'shoot' } },
  { id: 'pass', name: 'Pass', key: 'p', icon: 'move-horizontal', line: { dash: true } },
  { id: 'box', name: 'Shaded Box', key: 'b', icon: 'square-dashed', shape: 'box' },
  { id: 'circle', name: 'Shaded Circle', key: 'c', icon: 'circle-dashed', shape: 'circle' },
  { id: 'text', name: 'Text', key: 't', icon: 'type' },
];
const COLORS = ['black', 'blue', 'grey', 'green'];
const PLAYERS = [['black', '#1e1e1e'], ['blue', '#75d8ff'], ['grey', '#d9d9d9']];
const SIZES = { stroke: 8, pen: 8, text: 34, playerR: 30 };

export function mountAnnotate(host, player, { src }) {
  const stage = player.stage; const v = player.video;
  const canvas = document.createElement('canvas'); canvas.className = 'cn-marks'; stage.appendChild(canvas);
  const an = { tool: 'select', color: 'black', els: loadMarks(src), sel: null, drag: null, player: null, field: null };

  // -- geometry: the letterboxed picture inside the stage
  function viewBox() {
    const r = stage.getBoundingClientRect(); const vw = v.videoWidth || 16; const vh = v.videoHeight || 9;
    const s = Math.min(r.width / vw, r.height / vh); const w = vw * s; const h = vh * s;
    return { left: (r.width - w) / 2, top: (r.height - h) / 2, w, h, scale: w / UNIT_W, unitH: (vh / vw) * UNIT_W, rect: r };
  }
  function layout() { const b = viewBox(); canvas.style.left = `${b.left}px`; canvas.style.top = `${b.top}px`; canvas.style.width = `${b.w}px`; canvas.style.height = `${b.h}px`; canvas.width = Math.round(UNIT_W * 2); canvas.height = Math.round(b.unitH * 2); paint(); }
  const toUnits = (e) => { const b = viewBox(); return { x: (e.clientX - b.rect.left - b.left) / b.scale, y: (e.clientY - b.rect.top - b.top) / b.scale }; };
  function paint() {
    const ctx = canvas.getContext('2d'); ctx.clearRect(0, 0, canvas.width, canvas.height); ctx.save(); ctx.scale(2, 2);
    for (const x of an.els) { try { drawEl(ctx, x); } catch (_) {} }
    if (an.sel) { const b = bbox(an.sel); ctx.save(); ctx.strokeStyle = '#75d8ff'; ctx.lineWidth = 2; ctx.setLineDash([6, 4]); ctx.strokeRect(b.x, b.y, b.w, b.h); ctx.restore(); }
    ctx.restore();
    stage.classList.toggle('has-marks', an.els.length > 0);
  }
  new ResizeObserver(layout).observe(stage); v.addEventListener('loadedmetadata', layout);

  // -- toolbar
  host.innerHTML = `<div class="row">${TOOLS.map((t) => `<button class="cn-tool ${t.id === an.tool ? 'on' : ''}" data-tool="${t.id}" aria-label="${t.name}">${iconSvg(t.icon)}<span class="cn-key">${t.key.toUpperCase()}</span></button>`).join('')}
    <span class="cn-div"></span>
    ${COLORS.map((c) => `<button class="cn-swatch ${c === an.color ? 'on' : ''}" data-color="${c}" style="background:${colorOf(c)}" aria-label="${c}"></button>`).join('')}
    <span class="cn-div"></span>
    ${PLAYERS.map(([c, hex], i) => `<button class="cn-player" data-player="${c}" style="background:${hex}" aria-label="Player ${c}"><span class="cn-key">${i + 1}</span></button>`).join('')}
    <span class="cn-div"></span>
    <button class="cn-tool" data-act="undo" aria-label="Undo last mark">${iconSvg('undo-2')}</button>
    <button class="cn-tool danger" data-act="clear" aria-label="Clear marks">${iconSvg('trash-2')}</button>
  </div>`;
  const paintBar = () => { $$('[data-tool]', host).forEach((b) => b.classList.toggle('on', b.dataset.tool === an.tool)); $$('[data-color]', host).forEach((b) => b.classList.toggle('on', b.dataset.color === an.color)); $$('[data-player]', host).forEach((b) => b.classList.toggle('on', an.tool === 'player' && an.player === b.dataset.player)); stage.classList.toggle('is-armed', an.tool !== 'select'); stage.classList.toggle('is-select', an.tool === 'select'); };
  const arm = (id, color) => { an.tool = id; an.player = color || null; an.sel = null; paintBar(); paint(); };
  $$('[data-tool]', host).forEach((b) => { b.onclick = () => arm(b.dataset.tool); });
  $$('[data-color]', host).forEach((b) => { b.onclick = () => { an.color = b.dataset.color; if (an.sel && an.sel.type !== 'player') { an.sel.color = an.color; save(); paint(); } paintBar(); }; });
  $$('[data-player]', host).forEach((b) => { b.onclick = () => arm('player', b.dataset.player); });
  $('[data-act="undo"]', host).onclick = () => { an.els.pop(); an.sel = null; save(); paint(); };
  $('[data-act="clear"]', host).onclick = () => { an.els = []; an.sel = null; save(); paint(); };

  // -- drawing
  canvas.addEventListener('pointerdown', (e) => {
    if (e.button !== 0) return;
    const u = toUnits(e); const t = TOOLS.find((x) => x.id === an.tool);
    if (!v.paused) v.pause();
    if (an.tool === 'select') { const hit = hitTest(u); an.sel = hit; paint(); if (hit) an.drag = { el: hit, last: u, moved: false }; e.preventDefault(); return; }
    if (an.tool === 'player') { an.els.push({ id: uid(), type: 'player', color: an.player, label: '', x: u.x, y: u.y, r: SIZES.playerR }); save(); paint(); return; }
    if (an.tool === 'text') { openTextField(e, u); return; }
    let el;
    if (an.tool === 'pen') el = { id: uid(), type: 'pen', pts: [[u.x, u.y]], color: an.color, width: SIZES.pen };
    else if (t.line) { el = { id: uid(), type: 'arrow', x1: u.x, y1: u.y, x2: u.x, y2: u.y, mx: u.x, my: u.y, width: SIZES.stroke, color: an.color, head: 'triangle', dash: !!t.line.dash }; if (t.line.motion) el.motion = t.line.motion; }
    else if (t.shape) el = { id: uid(), type: t.shape, x: u.x, y: u.y, w: 10, h: 10, color: an.color };
    if (!el) return;
    an.els.push(el); an.drag = { el, u0: u, draw: true }; stage.classList.add('is-drawing'); e.preventDefault();
  });
  window.addEventListener('pointermove', (e) => {
    const d = an.drag; if (!d) return; const u = toUnits(e); const el = d.el;
    if (!d.draw) { const dx = u.x - d.last.x; const dy = u.y - d.last.y; d.last = u; d.moved = true; moveBy(el, dx, dy); paint(); return; }
    if (el.type === 'pen') el.pts.push([u.x, u.y]);
    else if (el.type === 'arrow') { el.x2 = u.x; el.y2 = u.y; el.mx = (el.x1 + u.x) / 2; el.my = (el.y1 + u.y) / 2; }
    else { el.x = Math.min(d.u0.x, u.x); el.y = Math.min(d.u0.y, u.y); el.w = Math.max(10, Math.abs(u.x - d.u0.x)); el.h = Math.max(10, Math.abs(u.y - d.u0.y)); }
    paint();
  });
  window.addEventListener('pointerup', () => {
    const d = an.drag; if (!d) return; an.drag = null; stage.classList.remove('is-drawing');
    if (d.draw) { const el = d.el; const tiny = el.type === 'arrow' ? Math.hypot(el.x2 - el.x1, el.y2 - el.y1) < 12 : el.type === 'pen' ? el.pts.length < 3 : (el.w < 12 && el.h < 12); if (tiny) an.els = an.els.filter((x) => x !== el); }
    save(); paint();
  });
  function openTextField(e, u) {
    if (an.field) return;
    const f = document.createElement('input'); f.className = 'cn-text-field'; f.placeholder = 'Type…';
    f.style.left = `${e.clientX - stage.getBoundingClientRect().left}px`; f.style.top = `${e.clientY - stage.getBoundingClientRect().top - 18}px`;
    stage.appendChild(f); an.field = f; f.focus();
    const done = (keep) => { if (!an.field) return; an.field = null; const val = f.value.trim(); f.remove(); if (keep && val) { an.els.push({ id: uid(), type: 'text', x: u.x, y: u.y + SIZES.text * 0.4, text: val, size: SIZES.text, color: an.color }); save(); paint(); } };
    f.onkeydown = (ev) => { ev.stopPropagation(); if (ev.key === 'Enter') done(true); if (ev.key === 'Escape') done(false); };
    f.onblur = () => done(true);
  }
  function hitTest(u) { for (let i = an.els.length - 1; i >= 0; i--) { const b = bbox(an.els[i]); if (u.x >= b.x && u.x <= b.x + b.w && u.y >= b.y && u.y <= b.y + b.h) return an.els[i]; } return null; }
  function bbox(x) {
    if (x.type === 'player') return { x: x.x - x.r, y: x.y - x.r, w: x.r * 2, h: x.r * 2 };
    if (x.type === 'arrow') { const xs = [x.x1, x.x2, x.mx]; const ys = [x.y1, x.y2, x.my]; const p = 16; return { x: Math.min(...xs) - p, y: Math.min(...ys) - p, w: Math.max(...xs) - Math.min(...xs) + p * 2, h: Math.max(...ys) - Math.min(...ys) + p * 2 }; }
    if (x.type === 'pen') { const xs = x.pts.map((q) => q[0]); const ys = x.pts.map((q) => q[1]); const p = 10; return { x: Math.min(...xs) - p, y: Math.min(...ys) - p, w: Math.max(...xs) - Math.min(...xs) + p * 2, h: Math.max(...ys) - Math.min(...ys) + p * 2 }; }
    if (x.type === 'text') { const w = (x.text || '').length * x.size * 0.6 + 30; return { x: x.x - 12, y: x.y - x.size - 10, w, h: x.size * 1.6 }; }
    return { x: x.x, y: x.y, w: x.w, h: x.h };
  }
  function moveBy(x, dx, dy) { if (x.type === 'arrow') { x.x1 += dx; x.x2 += dx; x.mx += dx; x.y1 += dy; x.y2 += dy; x.my += dy; } else if (x.type === 'pen') x.pts = x.pts.map(([a, b]) => [a + dx, b + dy]); else { x.x += dx; x.y += dy; } }
  function save() { try { const all = JSON.parse(localStorage.getItem(KEY) || '{}'); all[src] = an.els; localStorage.setItem(KEY, JSON.stringify(all)); } catch (_) {} }

  // -- keys: tools, colours, players, delete, escape
  window.addEventListener('keydown', (e) => {
    if (/INPUT|TEXTAREA/.test(e.target.tagName) || e.target.isContentEditable) return;
    const k = e.key.toLowerCase();
    const t = TOOLS.find((x) => x.key === k); if (t && !e.metaKey && !e.ctrlKey) { arm(t.id); return; }
    if (k === '1' || k === '2' || k === '3') { arm('player', PLAYERS[+k - 1][0]); return; }
    if ((e.metaKey || e.ctrlKey) && k === 'z') { e.preventDefault(); an.els.pop(); an.sel = null; save(); paint(); return; }
    if ((e.key === 'Delete' || e.key === 'Backspace') && an.sel) { an.els = an.els.filter((x) => x !== an.sel); an.sel = null; save(); paint(); return; }
    if (e.key === 'Escape') { if (an.sel) { an.sel = null; paint(); } else arm('select'); }
  });
  paintBar(); layout();
  return { armed: () => an.tool !== 'select' };
}
function loadMarks(src) { try { return JSON.parse(localStorage.getItem(KEY) || '{}')[src] || []; } catch (_) { return []; } }

// View mode: draw saved marks only, no toolbar, no input.
export function mountViewer(player, { src }) {
  const els = loadMarks(src); if (!els.length) return;
  const stage = player.stage; const v = player.video;
  const canvas = document.createElement('canvas'); canvas.className = 'cn-marks'; stage.appendChild(canvas);
  const layout = () => { const r = stage.getBoundingClientRect(); const vw = v.videoWidth || 16; const vh = v.videoHeight || 9; const s = Math.min(r.width / vw, r.height / vh); const w = vw * s; const h = vh * s; canvas.style.left = `${(r.width - w) / 2}px`; canvas.style.top = `${(r.height - h) / 2}px`; canvas.style.width = `${w}px`; canvas.style.height = `${h}px`; canvas.width = UNIT_W * 2; canvas.height = Math.round((vh / vw) * UNIT_W * 2); const ctx = canvas.getContext('2d'); ctx.save(); ctx.scale(2, 2); for (const x of els) { try { drawEl(ctx, x); } catch (_) {} } ctx.restore(); };
  new ResizeObserver(layout).observe(stage); v.addEventListener('loadedmetadata', layout);
}
