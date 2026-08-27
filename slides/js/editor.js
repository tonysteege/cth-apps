// The deck editor: a whiteboard-like canvas with slide components you can
// move, rearrange and reformat (2026-08-27, Tony's spec, after an
// inspection of Figma Slides).
//
// TWO VIEWS, the way Figma has them:
//   BOARD - every slide on one pannable, zoomable canvas. Drag a slide to
//           reorder it. This is the whiteboard.
//   SLIDE - one slide large, a numbered rail beside it, properties for
//           whatever is selected, and the tools along the bottom.
//
// THREE RULES HOLD THE WHOLE THING UP:
//
//  1. GEOMETRY IS IN SLIDE SPACE (1600x900), never in screen pixels. The
//     stage scales with the window and the zoom; the numbers never move.
//     Every pointer is mapped back through that scale on the way in.
//  2. IT SAVES ITSELF. A debounced write after every change, and a flush
//     on the way out - there is no Save button and there must never be
//     one. Diagrams learned this the same way.
//  3. AN ELEMENT IS DATA, NOT DOM. Elements render from the deck record,
//     so the same record draws the editor, a thumbnail, the board and the
//     presentation. Nothing is ever read back out of the DOM.

import {
  SLIDE_W, SLIDE_H, TEXT_ROLES, LOGOS, uid, newSlide, newText,
  getDeck, putDeck, normalizeDeck, slideLabel, putAsset, getAsset, deleteAsset,
} from './decks.js';
import { mountVideo, pauseAllVideos } from './media.js';
import { toast, esc } from './ui.js';

const $ = (s, r = document) => r.querySelector(s);
const $$ = (s, r = document) => [...r.querySelectorAll(s)];

let ed = null; // { deck, i, sel:Set, view, zoom, pan, dirty }

const BACK = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.8" stroke-linecap="round" stroke-linejoin="round"><path d="M20 12H4"/><path d="m10 18-6-6 6-6"/></svg>';

const TOOLS = [
  ['select', 'Select', 'v', '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-linejoin="round"><path d="M4.04 4.69a.5.5 0 0 1 .65-.65l16 6.5a.5.5 0 0 1-.06.94l-6.13 1.58a2 2 0 0 0-1.43 1.44l-1.58 6.12a.5.5 0 0 1-.95.07z"/></svg>'],
  ['text', 'Text', 't', '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-linecap="round"><path d="M4 7V5.5A1.5 1.5 0 0 1 5.5 4h13A1.5 1.5 0 0 1 20 5.5V7"/><path d="M12 4v16"/><path d="M9 20h6"/></svg>'],
  ['image', 'Image', 'i', '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-linejoin="round"><rect x="3" y="4" width="18" height="16" rx="2.5"/><circle cx="8.5" cy="9.5" r="1.6"/><path d="m4 17 4.5-4.5a2 2 0 0 1 2.8 0L16 17"/></svg>'],
  ['rink', 'Rink Diagram', 'r', '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor"><rect x="2.5" y="6" width="19" height="12" rx="6"/><path d="M12 6v12"/><circle cx="12" cy="12" r="2.6"/></svg>'],
  ['video', 'Video', 'm', '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-linejoin="round"><rect x="2.5" y="5" width="19" height="14" rx="2.5"/><path d="m10 9.2 5 2.8-5 2.8z"/></svg>'],
  ['shape', 'Shape', 's', '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor"><rect x="4" y="4" width="10" height="10" rx="1.6"/><circle cx="15.5" cy="15.5" r="4.6"/></svg>'],
];

const SHAPES = [['rect', 'Rectangle'], ['ellipse', 'Ellipse'], ['line', 'Line'], ['arrow', 'Arrow']];
const SWATCHES = ['#0a0a0a', '#ffffff', '#2b7fff', '#16a34a', '#e7000b', '#f97316', '#eab308', '#737373'];

// ------------------------------------------------------------- autosave
//
// No Save button, ever. The status word is the only feedback and it is
// enough: it says Saving while a write is in flight and Saved when it
// lands, which is exactly what Diagrams does.

const SAVE_MS = 700;
let saveTimer = null;

function markDirty() {
  if (!ed) return;
  ed.deck.updated = Date.now();
  status('Saving…');
  clearTimeout(saveTimer);
  saveTimer = setTimeout(() => void flush(), SAVE_MS);
}

export async function flush() {
  if (!ed) return;
  clearTimeout(saveTimer);
  saveTimer = null;
  try {
    await putDeck(ed.deck);
    status('Saved');
  } catch (e) {
    console.error(e);
    status('Not Saved');
    toast(e.message || 'Could Not Save This Deck', true);
  }
}

function status(word) {
  const el = $('#edStatus');
  if (el) el.textContent = word;
}

const slide = () => ed.deck.slides[ed.i];
const elById = (id) => slide().els.find((e) => e.id === id);

// ------------------------------------------------------------- rendering

// One element, as DOM. The SAME function draws the editor, the rail
// thumbnails, the board and the presentation - so what you arrange is
// exactly what you present.
export function elHtml(e) {
  const box = `left:${(e.x / SLIDE_W) * 100}%;top:${(e.y / SLIDE_H) * 100}%;width:${(e.w / SLIDE_W) * 100}%;height:${(e.h / SLIDE_H) * 100}%`;
  if (e.type === 'text') {
    const r = TEXT_ROLES[e.role] || TEXT_ROLES.body;
    const size = e.size || r.size;
    const st = `${box};font-size:${(size / SLIDE_H) * 100}cqh;font-weight:${e.weight || r.weight};color:${esc(e.color || r.color)};line-height:${r.line};text-align:${e.align || 'left'}`;
    const body = e.role === 'bullets'
      ? `<ul>${String(e.text || '').split('\n').filter(Boolean).map((l) => `<li>${esc(l)}</li>`).join('')}</ul>`
      : esc(e.text || '').replace(/\n/g, '<br>');
    return `<div class="de-el de-text" data-el="${e.id}" data-role="${e.role}" style="${st}"><div class="de-textin">${body}</div></div>`;
  }
  if (e.type === 'image' || e.type === 'rink') {
    return `<div class="de-el de-img" data-el="${e.id}" style="${box}"><img src="${esc(e.src || '')}" alt="" style="object-fit:${e.fit || 'contain'}"></div>`;
  }
  if (e.type === 'video') {
    return `<div class="de-el de-video" data-el="${e.id}" data-url="${esc(e.url || '')}" data-in="${e.in || 0}" data-out="${e.out || 0}" style="${box}"><div class="de-vslot"></div></div>`;
  }
  if (e.type === 'logo') {
    const l = LOGOS[e.variant] || LOGOS['icon-black'];
    return `<div class="de-el de-logo" data-el="${e.id}" style="${box}"><img src="${l.src}" alt="Coach Tony Hockey"></div>`;
  }
  if (e.type === 'shape') {
    const fill = e.fill || 'none';
    const stroke = e.stroke || '#0a0a0a';
    const sw = e.sw || 6;
    let svg;
    if (e.shape === 'ellipse') svg = `<ellipse cx="50" cy="50" rx="${50 - sw / 4}" ry="${50 - sw / 4}" fill="${fill}" stroke="${stroke}" stroke-width="${sw / 4}" vector-effect="non-scaling-stroke"/>`;
    else if (e.shape === 'line') svg = `<line x1="0" y1="50" x2="100" y2="50" stroke="${stroke}" stroke-width="${sw / 4}" vector-effect="non-scaling-stroke" stroke-linecap="round"/>`;
    else if (e.shape === 'arrow') svg = `<line x1="2" y1="50" x2="88" y2="50" stroke="${stroke}" stroke-width="${sw / 4}" vector-effect="non-scaling-stroke" stroke-linecap="round"/><polygon points="100,50 84,40 84,60" fill="${stroke}"/>`;
    else svg = `<rect x="${sw / 8}" y="${sw / 8}" width="${100 - sw / 4}" height="${100 - sw / 4}" rx="${e.r || 0}" fill="${fill}" stroke="${stroke}" stroke-width="${sw / 4}" vector-effect="non-scaling-stroke"/>`;
    return `<div class="de-el de-shape" data-el="${e.id}" style="${box}"><svg viewBox="0 0 100 100" preserveAspectRatio="none">${svg}</svg></div>`;
  }
  return '';
}

export function slideHtml(s) {
  return `<div class="de-slide" style="background:${esc(s.bg || '#ffffff')}">${(s.els || []).map(elHtml).join('')}</div>`;
}

// Videos are mounted after paint, through the SAME player the Notion decks
// use - that is what "the same video features the slides have now" means.
export function mountSlideVideos(root) {
  for (const box of $$('.de-video', root)) {
    const slot = box.querySelector('.de-vslot');
    if (!slot || slot.dataset.mounted) continue;
    slot.dataset.mounted = '1';
    const url = box.dataset.url;
    if (!url) { slot.innerHTML = '<span class="de-vempty">No Video</span>'; continue; }
    mountVideo(slot, { url, in: Number(box.dataset.in) || 0, out: Number(box.dataset.out) || 0 });
  }
}

// ------------------------------------------------------------- the shell

export async function openEditor(id) {
  const raw = await getDeck(id);
  if (!raw) { toast('That Deck Is Gone', true); location.hash = ''; return; }
  ed = { deck: normalizeDeck(raw), i: 0, sel: new Set(), view: 'slide', zoom: 1, pan: null, tool: 'select' };
  document.title = `${ed.deck.name} - CTH Slides`;
  document.body.classList.remove('dark');
  paintShell();
  window.addEventListener('keydown', onKey);
  window.addEventListener('beforeunload', beforeUnload);
}

export function closeEditor() {
  if (!ed) return;
  void flush();
  window.removeEventListener('keydown', onKey);
  window.removeEventListener('beforeunload', beforeUnload);
  pauseAllVideos();
  ed = null;
}

function beforeUnload(e) {
  if (!saveTimer) return;
  void flush();
  e.preventDefault();
  e.returnValue = '';
}

export const editing = () => !!ed;
export const currentDeck = () => ed?.deck || null;

function paintShell() {
  $('#app').innerHTML = `
    <div class="de">
      <header class="de-head">
        <button class="btn btn-back" id="edBack" title="Back To Slides">${BACK}</button>
        <input id="edName" class="de-name" value="${esc(ed.deck.name)}" spellcheck="false" aria-label="Deck Name">
        <span class="ed-status" id="edStatus">Saved</span>
        <span class="de-flex"></span>
        <div class="de-views">
          <button class="btn de-viewbtn" data-view="slide" title="One Slide">Slide</button>
          <button class="btn de-viewbtn" data-view="board" title="All Slides On One Canvas (G)">Board</button>
        </div>
        <button class="btn btn-ink" id="edPresent" title="Present This Deck">Present</button>
      </header>
      <div class="de-body" id="edBody"></div>
      <input type="file" id="edFile" accept="image/*,video/*" hidden>
    </div>`;
  $('#edBack').onclick = () => { location.hash = ''; };
  $('#edName').oninput = (e) => { ed.deck.name = e.target.value; document.title = `${e.target.value} - CTH Slides`; markDirty(); };
  $('#edName').onkeydown = (e) => e.stopPropagation();
  $$('.de-viewbtn').forEach((b) => { b.onclick = () => setView(b.dataset.view); });
  $('#edPresent').onclick = () => { void flush(); location.hash = `#/present/${ed.deck.id}`; };
  paintBody();
}

function setView(v) {
  ed.view = v;
  ed.sel.clear();
  paintBody();
}

function paintBody() {
  $$('.de-viewbtn').forEach((b) => b.classList.toggle('on', b.dataset.view === ed.view));
  if (ed.view === 'board') paintBoard();
  else paintSlideView();
}

// ------------------------------------------------------------- board view

// THE BOARD IS A WHITEBOARD (2026-08-27, second pass): an unbounded canvas
// that pans and zooms under the trackpad, with the slides laid out in a row
// exactly as Figma lays them out. Two-finger swipe pans, pinch zooms about
// the pointer, and the zoom reading sits with the view controls. Before
// this it was a CSS grid, which is a contact sheet, not a canvas.
const GAP = 140;                       // between slides, in slide units
const MIN_Z = 0.05;
const MAX_Z = 2.5;

function boardExtent() {
  return { w: ed.deck.slides.length * (SLIDE_W + GAP) - GAP, h: SLIDE_H };
}

function paintBoard() {
  const body = $('#edBody');
  body.innerHTML = `
    <div class="de-board" id="edBoard">
      <div class="de-canvas" id="edCanvas"></div>
      <div class="de-zoom">
        <button class="mini" data-z="out">&minus;</button>
        <button class="mini" id="edZoomVal" title="Fit The Whole Deck (Shift+1)">100%</button>
        <button class="mini" data-z="in">+</button>
      </div>
    </div>`;
  const canvas = $('#edCanvas');
  canvas.innerHTML = ed.deck.slides.map((sl, i) => `
    <div class="de-frame" data-slide="${sl.id}" data-i="${i}">
      <span class="de-framen">${i + 1}</span>
      <div class="de-framebox">${slideHtml(sl)}</div>
    </div>`).join('') + '<button class="de-frameadd" id="edBoardAdd" title="New Slide">+</button>';

  if (!ed.pan) fitBoard(false);
  applyBoardTransform();
  mountSlideVideos(canvas);

  $('#edBoardAdd').onclick = () => addSlide();
  for (const f of $$('.de-frame', canvas)) {
    f.addEventListener('pointerdown', (e) => onFrameDown(e, f));
    f.addEventListener('dblclick', () => { ed.i = Number(f.dataset.i); setView('slide'); });
    f.oncontextmenu = (e) => { e.preventDefault(); slideMenu(e.clientX, e.clientY, Number(f.dataset.i)); };
  }
  const board = $('#edBoard');
  board.addEventListener('wheel', onBoardWheel, { passive: false });
  board.addEventListener('pointerdown', (e) => {
    if (e.target.closest('.de-frame') || e.target.closest('.de-zoom')) return;
    ed.sel.clear();
    paintBoardSel();
    startPan(e);
  });
  $$('[data-z]', board).forEach((b) => {
    b.onclick = () => zoomAbout(b.dataset.z === 'in' ? 1.25 : 0.8, null);
  });
  $('#edZoomVal').onclick = () => fitBoard(true);
  paintBoardSel();
}

// Every slide lives at a fixed spot on the canvas; the CANVAS moves, not
// the slides. That is what makes panning free and keeps the geometry the
// same numbers the editor uses.
function applyBoardTransform() {
  const canvas = $('#edCanvas');
  if (!canvas) return;
  canvas.style.transform = `translate(${ed.pan.x}px, ${ed.pan.y}px) scale(${ed.zoom})`;
  for (const f of $$('.de-frame', canvas)) {
    const i = Number(f.dataset.i);
    f.style.left = `${i * (SLIDE_W + GAP)}px`;
  }
  const add = $('#edBoardAdd');
  if (add) add.style.left = `${ed.deck.slides.length * (SLIDE_W + GAP)}px`;
  const val = $('#edZoomVal');
  if (val) val.textContent = `${Math.round(ed.zoom * 100)}%`;
  // The number chips and the selection ring must not shrink with the
  // canvas, or they vanish at 20% - so they are scaled back out.
  canvas.style.setProperty('--inv', String(1 / ed.zoom));
}

function fitBoard(animate) {
  const board = $('#edBoard');
  if (!board) return;
  const r = board.getBoundingClientRect();
  const ext = boardExtent();
  const pad = 90;
  ed.zoom = Math.max(MIN_Z, Math.min(MAX_Z, Math.min((r.width - pad * 2) / ext.w, (r.height - pad * 2) / ext.h)));
  ed.pan = { x: (r.width - ext.w * ed.zoom) / 2, y: (r.height - ext.h * ed.zoom) / 2 };
  if (animate) {
    const canvas = $('#edCanvas');
    canvas.style.transition = 'transform 220ms cubic-bezier(.2,.7,.3,1)';
    setTimeout(() => { canvas.style.transition = ''; }, 260);
  }
  applyBoardTransform();
}

function onBoardWheel(e) {
  e.preventDefault();
  // A pinch arrives as ctrl+wheel; a two-finger swipe as plain deltas.
  if (e.ctrlKey || e.metaKey) zoomAbout(Math.exp(-e.deltaY * 0.01), e);
  else {
    ed.pan.x -= e.deltaX;
    ed.pan.y -= e.deltaY;
    applyBoardTransform();
  }
}

// Zoom about a point, so whatever is under the pointer stays under it.
function zoomAbout(factor, e) {
  const board = $('#edBoard');
  const r = board.getBoundingClientRect();
  const px = e ? e.clientX - r.left : r.width / 2;
  const py = e ? e.clientY - r.top : r.height / 2;
  const next = Math.max(MIN_Z, Math.min(MAX_Z, ed.zoom * factor));
  const k = next / ed.zoom;
  ed.pan.x = px - (px - ed.pan.x) * k;
  ed.pan.y = py - (py - ed.pan.y) * k;
  ed.zoom = next;
  applyBoardTransform();
}

function startPan(e) {
  const from = { x: e.clientX, y: e.clientY };
  const at = { ...ed.pan };
  const board = $('#edBoard');
  board.classList.add('panning');
  const move = (ev) => {
    ed.pan = { x: at.x + (ev.clientX - from.x), y: at.y + (ev.clientY - from.y) };
    applyBoardTransform();
  };
  const up = () => {
    window.removeEventListener('pointermove', move);
    window.removeEventListener('pointerup', up);
    board.classList.remove('panning');
  };
  window.addEventListener('pointermove', move);
  window.addEventListener('pointerup', up);
}

// A slide drags to reorder along the row; a click just selects it.
function onFrameDown(e, frame) {
  if (e.button !== 0) return;
  const i = Number(frame.dataset.i);
  ed.i = i;
  ed.sel.clear();
  ed.sel.add(ed.deck.slides[i].id);
  paintBoardSel();
  const from = { x: e.clientX, y: e.clientY };
  let moved = false;
  const move = (ev) => {
    if (!moved && Math.abs(ev.clientX - from.x) < 8) return;
    moved = true;
    frame.classList.add('dragging');
    const dx = (ev.clientX - from.x) / ed.zoom;
    frame.style.transform = `translateX(${dx}px)`;
    const slot = Math.max(0, Math.min(ed.deck.slides.length - 1, Math.round(i + dx / (SLIDE_W + GAP))));
    frame.dataset.slot = String(slot);
  };
  const up = () => {
    window.removeEventListener('pointermove', move);
    window.removeEventListener('pointerup', up);
    frame.classList.remove('dragging');
    frame.style.transform = '';
    if (!moved) return;
    const slot = Number(frame.dataset.slot);
    if (slot !== i) {
      const [s0] = ed.deck.slides.splice(i, 1);
      ed.deck.slides.splice(slot, 0, s0);
      ed.i = slot;
      markDirty();
    }
    paintBoard();
  };
  window.addEventListener('pointermove', move);
  window.addEventListener('pointerup', up);
}

function paintBoardSel() {
  for (const f of $$('.de-frame')) {
    f.classList.toggle('on', ed.sel.has(f.dataset.slide));
  }
}

// ------------------------------------------------------------- slide view

function paintSlideView() {
  const body = $('#edBody');
  body.innerHTML = `
    <aside class="de-rail" id="edRail"></aside>
    <div class="de-main">
      <div class="de-stagewrap" id="edStageWrap">
        <div class="de-stage" id="edStage"></div>
      </div>
      <div class="de-notes"><textarea id="edNotes" placeholder="Presenter notes…" spellcheck="false"></textarea></div>
      <div class="de-tools" id="edTools"></div>
    </div>
    <aside class="de-props" id="edProps"></aside>`;
  paintRail();
  paintStage();
  paintTools();
  paintProps();
  const notes = $('#edNotes');
  notes.value = slide().notes || '';
  notes.oninput = () => { slide().notes = notes.value; markDirty(); };
  notes.onkeydown = (e) => e.stopPropagation();
}

function paintRail() {
  const rail = $('#edRail');
  rail.innerHTML = `
    <div class="de-railtop"><button class="mini" id="edNewSlide">+ Slide</button></div>
    <div class="de-raillist" id="edRailList">
      ${ed.deck.slides.map((s, i) => `
        <div class="de-thumb${i === ed.i ? ' on' : ''}" data-slide="${s.id}" data-i="${i}">
          <span class="de-thumbn">${i + 1}</span>
          <div class="de-thumbbox">${slideHtml(s)}</div>
        </div>`).join('')}
    </div>`;
  $('#edNewSlide').onclick = () => addSlide();
  for (const t of $$('.de-thumb', rail)) {
    t.onclick = () => { ed.i = Number(t.dataset.i); ed.sel.clear(); paintSlideView(); };
    t.oncontextmenu = (e) => { e.preventDefault(); slideMenu(e.clientX, e.clientY, Number(t.dataset.i)); };
  }
  sortable($('#edRailList'), '.de-thumb', (order) => {
    const openId = slide().id;
    ed.deck.slides = order.map((c) => ed.deck.slides.find((s) => s.id === c.dataset.slide));
    ed.i = ed.deck.slides.findIndex((s) => s.id === openId);
    markDirty();
    paintSlideView();
  });
}

function paintStage() {
  const stage = $('#edStage');
  const s = slide();
  stage.style.background = s.bg || '#ffffff';
  stage.innerHTML = `${(s.els || []).map(elHtml).join('')}<div class="de-guides" id="edGuides"></div>`;
  mountSlideVideos(stage);
  for (const el of $$('.de-el', stage)) {
    const id = el.dataset.el;
    if (ed.sel.has(id)) el.classList.add('sel');
    el.addEventListener('pointerdown', (e) => onElDown(e, id));
    el.addEventListener('dblclick', (e) => {
      const x = elById(id);
      if (x?.type === 'text') { e.stopPropagation(); editText(id); }
    });
  }
  paintHandles();
  stage.addEventListener('pointerdown', onStageDown);
}

// Selection chrome and handles live in their own layer, so a repaint of
// the selection never re-creates the elements underneath it (which would
// tear down a mounted video mid-drag).
function paintHandles() {
  const stage = $('#edStage');
  $('#edHandles')?.remove();
  if (!ed.sel.size) return;
  const layer = document.createElement('div');
  layer.className = 'de-handles';
  layer.id = 'edHandles';
  const pc = (v, total) => `${(v / total) * 100}%`;
  for (const id of ed.sel) {
    const e = elById(id);
    if (!e) continue;
    layer.insertAdjacentHTML('beforeend',
      `<div class="de-ring" style="left:${pc(e.x, SLIDE_W)};top:${pc(e.y, SLIDE_H)};width:${pc(e.w, SLIDE_W)};height:${pc(e.h, SLIDE_H)}"></div>`);
  }
  if (ed.sel.size === 1) {
    const e = elById([...ed.sel][0]);
    if (e) {
      for (const k of ['nw', 'ne', 'sw', 'se', 'n', 's', 'w', 'e']) {
        const hx = k.includes('w') ? e.x : k.includes('e') ? e.x + e.w : e.x + e.w / 2;
        const hy = k.includes('n') ? e.y : k.includes('s') ? e.y + e.h : e.y + e.h / 2;
        layer.insertAdjacentHTML('beforeend',
          `<span class="de-h" data-h="${k}" style="left:${pc(hx, SLIDE_W)};top:${pc(hy, SLIDE_H)}"></span>`);
      }
    }
  }
  stage.appendChild(layer);
  for (const h of $$('.de-h', layer)) {
    h.addEventListener('pointerdown', (ev) => onHandleDown(ev, h.dataset.h));
  }
}

// Screen pixels to slide units. Everything that reads a pointer goes
// through here - the stage scales, the geometry does not.
function toSlide(e) {
  const r = $('#edStage').getBoundingClientRect();
  return { x: ((e.clientX - r.left) / r.width) * SLIDE_W, y: ((e.clientY - r.top) / r.height) * SLIDE_H };
}

let drag = null;

function onStageDown(e) {
  if (e.target.closest('.de-el') || e.target.closest('.de-h')) return;
  if (ed.tool !== 'select') { placeTool(toSlide(e)); return; }
  // Rubber band on empty slide.
  const p = toSlide(e);
  ed.sel.clear();
  drag = { kind: 'band', from: p, to: p };
  paintHandles();
  paintProps();
}

function onElDown(e, id) {
  if (ed.tool !== 'select') return;
  e.stopPropagation();
  const p = toSlide(e);
  if (e.shiftKey) ed.sel.has(id) ? ed.sel.delete(id) : ed.sel.add(id);
  else if (!ed.sel.has(id)) { ed.sel.clear(); ed.sel.add(id); }
  drag = {
    kind: 'move', from: p,
    origs: [...ed.sel].map((z) => ({ ...elById(z) })).filter((z) => z.id),
  };
  paintHandles();
  paintProps();
}

function onHandleDown(e, k) {
  e.stopPropagation();
  const id = [...ed.sel][0];
  drag = { kind: 'resize', h: k, from: toSlide(e), orig: { ...elById(id) } };
}

function onMove(e) {
  if (!drag || !ed || ed.view !== 'slide') return;
  const p = toSlide(e);
  if (drag.kind === 'band') {
    drag.to = p;
    const r = { x: Math.min(drag.from.x, p.x), y: Math.min(drag.from.y, p.y), w: Math.abs(p.x - drag.from.x), h: Math.abs(p.y - drag.from.y) };
    ed.sel.clear();
    for (const z of slide().els) {
      if (z.x < r.x + r.w && z.x + z.w > r.x && z.y < r.y + r.h && z.y + z.h > r.y) ed.sel.add(z.id);
    }
    paintBand(r);
    paintHandles();
    return;
  }
  if (drag.kind === 'move') {
    let dx = p.x - drag.from.x;
    let dy = p.y - drag.from.y;
    // Snap the FIRST selected element's edges and centre, and carry the
    // rest by the same delta, so a multi-selection keeps its shape.
    if (drag.origs.length === 1) {
      const o = drag.origs[0];
      const snapped = snap(o, dx, dy);
      dx = snapped.dx; dy = snapped.dy;
      showGuides(snapped.guides);
    }
    for (const o of drag.origs) {
      const x = elById(o.id);
      if (!x) continue;
      x.x = Math.round(o.x + dx);
      x.y = Math.round(o.y + dy);
    }
    repaintGeometry();
    return;
  }
  if (drag.kind === 'resize') {
    const o = drag.orig;
    const x = elById(o.id);
    if (!x) return;
    const k = drag.h;
    let left = o.x; let top = o.y; let right = o.x + o.w; let bottom = o.y + o.h;
    if (k.includes('w')) left = p.x;
    if (k.includes('e')) right = p.x;
    if (k.includes('n')) top = p.y;
    if (k.includes('s')) bottom = p.y;
    x.x = Math.round(Math.min(left, right));
    x.y = Math.round(Math.min(top, bottom));
    x.w = Math.max(40, Math.round(Math.abs(right - left)));
    x.h = Math.max(30, Math.round(Math.abs(bottom - top)));
    repaintGeometry();
  }
}

function onUp() {
  if (!drag) return;
  const was = drag.kind;
  drag = null;
  $('#edBandBox')?.remove();
  showGuides([]);
  if (was !== 'band') markDirty();
  paintHandles();
  paintProps();
}

// Move and resize only change numbers, so only the boxes need updating -
// re-rendering the slide would tear down a mounted video on every frame.
function repaintGeometry() {
  const stage = $('#edStage');
  for (const el of $$('.de-el', stage)) {
    const e = elById(el.dataset.el);
    if (!e) continue;
    el.style.left = `${(e.x / SLIDE_W) * 100}%`;
    el.style.top = `${(e.y / SLIDE_H) * 100}%`;
    el.style.width = `${(e.w / SLIDE_W) * 100}%`;
    el.style.height = `${(e.h / SLIDE_H) * 100}%`;
  }
  paintHandles();
}

function paintBand(r) {
  let b = $('#edBandBox');
  if (!b) {
    b = document.createElement('div');
    b.id = 'edBandBox';
    b.className = 'de-band';
    $('#edStage').appendChild(b);
  }
  b.style.cssText = `left:${(r.x / SLIDE_W) * 100}%;top:${(r.y / SLIDE_H) * 100}%;width:${(r.w / SLIDE_W) * 100}%;height:${(r.h / SLIDE_H) * 100}%`;
}

// Snapping: the slide's own centre and edges, plus every other element's
// edges. 10 slide units is about 6 screen pixels at a normal stage size -
// tight enough to feel deliberate, loose enough to catch.
const SNAP = 10;
function snap(o, dx, dy) {
  const guides = [];
  const others = slide().els.filter((z) => z.id !== o.id);
  const vx = [0, SLIDE_W / 2, SLIDE_W, ...others.flatMap((z) => [z.x, z.x + z.w / 2, z.x + z.w])];
  const vy = [0, SLIDE_H / 2, SLIDE_H, ...others.flatMap((z) => [z.y, z.y + z.h / 2, z.y + z.h])];
  const tryAxis = (edges, cands, delta) => {
    let best = null;
    for (const e of edges) {
      for (const c of cands) {
        const d = c - (e + delta);
        if (Math.abs(d) < SNAP && (!best || Math.abs(d) < Math.abs(best.d))) best = { d, at: c };
      }
    }
    return best;
  };
  const bx = tryAxis([o.x, o.x + o.w / 2, o.x + o.w], vx, dx);
  const by = tryAxis([o.y, o.y + o.h / 2, o.y + o.h], vy, dy);
  if (bx) { dx += bx.d; guides.push({ axis: 'x', at: bx.at }); }
  if (by) { dy += by.d; guides.push({ axis: 'y', at: by.at }); }
  return { dx, dy, guides };
}

function showGuides(list) {
  const g = $('#edGuides');
  if (!g) return;
  g.innerHTML = (list || []).map((z) => (z.axis === 'x'
    ? `<i class="de-gv" style="left:${(z.at / SLIDE_W) * 100}%"></i>`
    : `<i class="de-gh" style="top:${(z.at / SLIDE_H) * 100}%"></i>`)).join('');
}

// ------------------------------------------------------------- text edit

// Editing happens IN PLACE, in the element itself, so the type never jumps
// between a field and the committed slide - the same rule the Clips text
// tool follows.
function editText(id) {
  const e = elById(id);
  const host = $(`.de-el[data-el="${id}"] .de-textin`, $('#edStage'));
  if (!e || !host) return;
  host.contentEditable = 'plaintext-only';
  host.classList.add('editing');
  if (e.role === 'bullets') host.textContent = e.text || '';
  host.focus();
  document.getSelection()?.selectAllChildren(host);
  const finish = () => {
    host.contentEditable = 'false';
    host.classList.remove('editing');
    e.text = host.innerText.replace(/\n{3,}/g, '\n\n').trim();
    markDirty();
    paintStage();
    paintProps();
  };
  host.onblur = finish;
  host.onkeydown = (ev) => {
    ev.stopPropagation();
    if (ev.key === 'Escape') { ev.preventDefault(); host.blur(); }
    if (ev.key === 'Enter' && (ev.metaKey || ev.ctrlKey)) { ev.preventDefault(); host.blur(); }
  };
}

// ------------------------------------------------------------- tools

function paintTools() {
  const bar = $('#edTools');
  bar.innerHTML = `
    ${TOOLS.map(([t, label, key, icon]) => `<button class="tb-btn${ed.tool === t ? ' on' : ''}" data-tool="${t}" title="${label} (${key.toUpperCase()})">${icon}<span class="tb-key">${key.toUpperCase()}</span></button>`).join('')}
    <span class="tb-sep"></span>
    <button class="tb-btn tb-word" data-act="layout" title="Replace This Slide's Layout">Layout</button>
    <button class="tb-btn tb-word" data-act="dupe" title="Duplicate This Slide">Duplicate</button>`;
  for (const b of $$('[data-tool]', bar)) {
    b.onclick = () => { ed.tool = b.dataset.tool; paintTools(); $('#edStage').style.cursor = ed.tool === 'select' ? 'default' : 'crosshair'; };
  }
  bar.querySelector('[data-act="layout"]').onclick = (e) => layoutMenu(e.clientX, e.clientY);
  bar.querySelector('[data-act="dupe"]').onclick = () => dupeSlide(ed.i);
}

// A tool click drops its element at the pointer and hands the pointer
// straight back to Select - placing three boxes in a row is not the common
// case; adjusting the one you just placed is.
function placeTool(p) {
  const t = ed.tool;
  const at = (w, h) => ({ x: Math.round(Math.max(0, Math.min(SLIDE_W - w, p.x - w / 2))), y: Math.round(Math.max(0, Math.min(SLIDE_H - h, p.y - h / 2))), w, h });
  if (t === 'text') {
    const e = { ...newText('body'), ...at(620, 90), text: 'Text' };
    slide().els.push(e);
    commitPlace(e.id);
    setTimeout(() => editText(e.id), 30);
    return;
  }
  if (t === 'shape') {
    const e = { id: uid(), type: 'shape', shape: 'rect', ...at(420, 260), fill: 'none', stroke: '#0a0a0a', sw: 6 };
    slide().els.push(e);
    commitPlace(e.id);
    return;
  }
  if (t === 'image' || t === 'video') { pickFile(t, p); return; }
  if (t === 'rink') { pickRink(p); return; }
}

function commitPlace(id) {
  ed.tool = 'select';
  ed.sel.clear();
  ed.sel.add(id);
  markDirty();
  paintTools();
  paintStage();
  paintProps();
}

// An image or a video is stored as a BLOB in its own store and referenced
// by an object URL. Base64 on the deck record would rewrite the whole deck
// on every nudge and blow past what IndexedDB will happily hold.
function pickFile(kind, p) {
  const inp = $('#edFile');
  inp.accept = kind === 'video' ? 'video/*' : 'image/*';
  inp.onchange = async () => {
    const f = inp.files?.[0];
    inp.value = '';
    if (!f) return;
    const aid = uid();
    await putAsset(aid, f);
    const url = URL.createObjectURL(f);
    if (kind === 'video') {
      const e = { id: uid(), type: 'video', asset: aid, url, name: f.name, x: Math.round(p.x - 400), y: Math.round(p.y - 225), w: 800, h: 450, in: 0, out: 0 };
      clampInto(e);
      slide().els.push(e);
      commitPlace(e.id);
      return;
    }
    // Size an image to its own aspect, so it lands looking right.
    const img = new Image();
    img.onload = () => {
      const ratio = img.naturalWidth / Math.max(1, img.naturalHeight);
      const w = 700;
      const e = { id: uid(), type: 'image', asset: aid, src: url, x: Math.round(p.x - w / 2), y: Math.round(p.y - (w / ratio) / 2), w, h: Math.round(w / ratio), fit: 'contain' };
      clampInto(e);
      slide().els.push(e);
      commitPlace(e.id);
    };
    img.src = url;
  };
  inp.click();
}

function clampInto(e) {
  e.x = Math.max(0, Math.min(SLIDE_W - e.w, e.x));
  e.y = Math.max(0, Math.min(SLIDE_H - e.h, e.y));
}

// Rink diagrams come from the cth folder the other apps already write to,
// so a PNG saved out of Diagrams is one click from a slide.
async function pickRink(p) {
  let files = [];
  try {
    const fs = await import('../../clips/js/localfs.js');
    if (fs.fsSupported() && (fs.fsConnected() || fs.fsRemembered())) {
      if (!fs.fsConnected()) await fs.fsReconnect();
      const listing = await fs.fsListFolder('/diagrams');
      files = (listing.files || []).filter((f) => /\.(png|jpe?g|webp)$/i.test(f.name));
    }
  } catch (e) { console.warn('rink listing failed', e.message); }

  const veil = document.createElement('div');
  veil.className = 'sheet-veil';
  veil.innerHTML = `
    <div class="sheet sheet-wide" role="dialog" aria-modal="true">
      <h3>Add A Rink Diagram</h3>
      <p>${files.length ? 'From your cth/diagrams folder.' : 'No cth folder connected - choose a file instead.'}</p>
      <div class="de-rinks">${files.map((f, i) => `<button class="de-rinkpick" data-i="${i}">${esc(f.name)}</button>`).join('')}</div>
      <div class="sheet-row">
        <button class="btn" data-x="file">Choose File…</button>
        <span class="de-flex"></span>
        <button class="btn" data-x="cancel">Cancel</button>
      </div>
    </div>`;
  document.body.appendChild(veil);
  const close = () => veil.remove();
  veil.addEventListener('mousedown', (e) => { if (e.target === veil) close(); });
  veil.querySelector('[data-x="cancel"]').onclick = close;
  veil.querySelector('[data-x="file"]').onclick = () => { close(); ed.tool = 'image'; pickFile('image', p); };
  for (const b of veil.querySelectorAll('[data-i]')) {
    b.onclick = async () => {
      close();
      try {
        const fs = await import('../../clips/js/localfs.js');
        const file = await fs.fsGetFile(files[Number(b.dataset.i)].path);
        const aid = uid();
        await putAsset(aid, file);
        const url = URL.createObjectURL(file);
        // A rink is 2:1 - the geometry rink.js is measured against.
        const w = 760;
        const e = { id: uid(), type: 'rink', asset: aid, src: url, x: Math.round(p.x - w / 2), y: Math.round(p.y - w / 4), w, h: Math.round(w / 2), fit: 'contain' };
        clampInto(e);
        slide().els.push(e);
        commitPlace(e.id);
      } catch (err) {
        toast(err.message || 'Could Not Open That Diagram', true);
      }
    };
  }
}

// ------------------------------------------------------------- properties

function paintProps() {
  const box = $('#edProps');
  if (!box) return;
  const ids = [...ed.sel];
  if (!ids.length) {
    const s = slide();
    box.innerHTML = `
      <div class="pe-title">Slide ${ed.i + 1}</div>
      <label class="bs-row"><span>Background</span>
        <span class="de-sw">${SWATCHES.map((h) => `<button class="de-swatch${(s.bg || '').toLowerCase() === h ? ' on' : ''}" data-bg="${h}" style="--c:${h}"></button>`).join('')}</span>
      </label>
      <p class="bs-note">Click a tool below and then the slide to place something. Double-click any text to edit it.</p>`;
    for (const b of $$('[data-bg]', box)) {
      b.onclick = () => { s.bg = b.dataset.bg; markDirty(); paintStage(); paintRail(); paintProps(); };
    }
    return;
  }
  const e = elById(ids[0]);
  if (!e) { box.innerHTML = ''; return; }
  const rows = [];
  if (e.type === 'text') {
    rows.push(`<label class="bs-row"><span>Style</span>
      <select data-k="role">${Object.entries(TEXT_ROLES).map(([k, r]) => `<option value="${k}"${e.role === k ? ' selected' : ''}>${r.label}</option>`).join('')}</select></label>`);
    rows.push(`<label class="bs-row"><span>Align</span>
      <select data-k="align">${['left', 'center', 'right'].map((a) => `<option${(e.align || 'left') === a ? ' selected' : ''}>${a}</option>`).join('')}</select></label>`);
    rows.push(`<label class="bs-row"><span>Size</span><input type="number" data-k="size" min="12" max="200" value="${e.size || TEXT_ROLES[e.role].size}"></label>`);
    rows.push(`<label class="bs-row"><span>Colour</span><span class="de-sw">${SWATCHES.map((h) => `<button class="de-swatch${(e.color || TEXT_ROLES[e.role].color).toLowerCase() === h ? ' on' : ''}" data-color="${h}" style="--c:${h}"></button>`).join('')}</span></label>`);
  }
  if (e.type === 'shape') {
    rows.push(`<label class="bs-row"><span>Shape</span>
      <select data-k="shape">${SHAPES.map(([k, l]) => `<option value="${k}"${e.shape === k ? ' selected' : ''}>${l}</option>`).join('')}</select></label>`);
    rows.push(`<label class="bs-row"><span>Line</span><input type="number" data-k="sw" min="1" max="40" value="${e.sw || 6}"></label>`);
    rows.push(`<label class="bs-row"><span>Stroke</span><span class="de-sw">${SWATCHES.map((h) => `<button class="de-swatch${(e.stroke || '').toLowerCase() === h ? ' on' : ''}" data-stroke="${h}" style="--c:${h}"></button>`).join('')}</span></label>`);
    rows.push(`<label class="bs-row"><span>Fill</span><span class="de-sw"><button class="de-swatch de-none${(e.fill || 'none') === 'none' ? ' on' : ''}" data-fill="none"></button>${SWATCHES.map((h) => `<button class="de-swatch${(e.fill || '').toLowerCase() === h ? ' on' : ''}" data-fill="${h}" style="--c:${h}"></button>`).join('')}</span></label>`);
  }
  if (e.type === 'image' || e.type === 'rink') {
    rows.push(`<label class="bs-row"><span>Fit</span>
      <select data-k="fit">${['contain', 'cover'].map((f) => `<option${(e.fit || 'contain') === f ? ' selected' : ''}>${f}</option>`).join('')}</select></label>`);
  }
  if (e.type === 'video') {
    rows.push(`<label class="bs-row"><span>Start</span><input type="number" data-k="in" min="0" step="0.1" value="${e.in || 0}"></label>`);
    rows.push(`<label class="bs-row"><span>End</span><input type="number" data-k="out" min="0" step="0.1" value="${e.out || 0}"></label>`);
    rows.push('<p class="bs-note">Leave End at 0 to play to the end. The player is the same one the Notion decks use: click to play, drag the strip to seek.</p>');
  }
  box.innerHTML = `
    <div class="pe-title">${e.type === 'rink' ? 'Rink' : e.type[0].toUpperCase() + e.type.slice(1)}</div>
    ${rows.join('')}
    <div class="bs-row"><span>Position</span>
      <span class="de-xy"><input type="number" data-k="x" value="${e.x}"><input type="number" data-k="y" value="${e.y}"></span></div>
    <div class="bs-row"><span>Size</span>
      <span class="de-xy"><input type="number" data-k="w" value="${e.w}"><input type="number" data-k="h" value="${e.h}"></span></div>
    <div class="de-proprow">
      <button class="mini" data-a="front">Front</button>
      <button class="mini" data-a="back">Back</button>
      <button class="mini" data-a="center">Centre</button>
      <button class="mini mini-danger" data-a="del">Delete</button>
    </div>`;
  for (const f of $$('[data-k]', box)) {
    const commit = () => {
      const k = f.dataset.k;
      const v = f.type === 'number' ? Number(f.value) : f.value;
      for (const id of ed.sel) {
        const t = elById(id);
        if (t) t[k] = v;
      }
      markDirty();
      paintStage();
      paintRail();
      if (['role', 'shape'].includes(k)) paintProps();
    };
    f.onchange = commit;
    f.onkeydown = (ev) => { ev.stopPropagation(); if (ev.key === 'Enter') commit(); };
  }
  for (const [attr, key] of [['data-color', 'color'], ['data-stroke', 'stroke'], ['data-fill', 'fill']]) {
    for (const b of $$(`[${attr}]`, box)) {
      b.onclick = () => {
        for (const id of ed.sel) { const t = elById(id); if (t) t[key] = b.getAttribute(attr); }
        markDirty(); paintStage(); paintRail(); paintProps();
      };
    }
  }
  const act = (n, fn) => { const b = box.querySelector(`[data-a="${n}"]`); if (b) b.onclick = fn; };
  act('front', () => { reorderEls('front'); });
  act('back', () => { reorderEls('back'); });
  act('center', () => {
    for (const id of ed.sel) {
      const t = elById(id);
      if (t) { t.x = Math.round((SLIDE_W - t.w) / 2); }
    }
    markDirty(); paintStage(); paintRail(); paintHandles();
  });
  act('del', () => deleteSelection());
}

function reorderEls(where) {
  const s = slide();
  const picked = s.els.filter((e) => ed.sel.has(e.id));
  s.els = s.els.filter((e) => !ed.sel.has(e.id));
  if (where === 'front') s.els.push(...picked); else s.els.unshift(...picked);
  markDirty();
  paintStage();
  paintRail();
}

function deleteSelection() {
  const s = slide();
  for (const e of s.els) if (ed.sel.has(e.id) && e.asset) void deleteAsset(e.asset);
  s.els = s.els.filter((e) => !ed.sel.has(e.id));
  ed.sel.clear();
  markDirty();
  paintStage();
  paintRail();
  paintProps();
}

// ------------------------------------------------------------- slides

function addSlide(layout = 'header', at = null) {
  const s = newSlide(layout);
  const idx = at == null ? ed.deck.slides.length : at;
  ed.deck.slides.splice(idx, 0, s);
  ed.i = idx;
  ed.sel.clear();
  markDirty();
  if (ed.view === 'board') paintBoard(); else paintSlideView();
}

function dupeSlide(i) {
  const copy = structuredClone(ed.deck.slides[i]);
  copy.id = uid();
  copy.els = copy.els.map((e) => ({ ...e, id: uid() }));
  ed.deck.slides.splice(i + 1, 0, copy);
  ed.i = i + 1;
  markDirty();
  if (ed.view === 'board') paintBoard(); else paintSlideView();
}

function removeSlide(i) {
  if (ed.deck.slides.length === 1) { toast('A Deck Needs One Slide', true); return; }
  ed.deck.slides.splice(i, 1);
  ed.i = Math.max(0, Math.min(ed.deck.slides.length - 1, i));
  ed.sel.clear();
  markDirty();
  if (ed.view === 'board') paintBoard(); else paintSlideView();
}

function slideMenu(x, y, i) {
  menu(x, y, [
    ['Open', () => { ed.i = i; setView('slide'); }],
    ['Duplicate', () => dupeSlide(i)],
    ['New Slide After', () => addSlide('header', i + 1)],
    ['Delete', () => removeSlide(i), true],
  ]);
}

function layoutMenu(x, y) {
  menu(x, y, [
    ['Title Slide', () => replaceLayout('title')],
    ['Section Break', () => replaceLayout('section')],
    ['Header And Bullets', () => replaceLayout('header')],
    ['Split - Text And Media', () => replaceLayout('split')],
    ['Blank', () => replaceLayout('blank')],
  ]);
}

// Replacing a layout keeps whatever is NOT text - a rink diagram or a clip
// you have already placed survives a change of wording.
function replaceLayout(kind) {
  const s = slide();
  const keep = s.els.filter((e) => e.type !== 'text');
  const fresh = newSlide(kind);
  s.bg = fresh.bg;
  s.els = [...fresh.els, ...keep];
  ed.sel.clear();
  markDirty();
  paintSlideView();
}

function menu(x, y, items) {
  document.querySelector('.move-menu')?.remove();
  const m = document.createElement('div');
  m.className = 'move-menu';
  m.innerHTML = items.map(([label, , danger], i) => `<button data-i="${i}"${danger ? ' class="ctx-danger"' : ''}>${label}</button>`).join('');
  document.body.appendChild(m);
  m.style.left = `${Math.max(8, Math.min(window.innerWidth - m.offsetWidth - 8, x))}px`;
  m.style.top = `${Math.max(8, Math.min(window.innerHeight - m.offsetHeight - 8, y))}px`;
  const close = () => { m.remove(); window.removeEventListener('pointerdown', away, true); };
  const away = (e) => { if (!m.contains(e.target)) close(); };
  window.addEventListener('pointerdown', away, true);
  for (const b of m.querySelectorAll('[data-i]')) b.onclick = () => { close(); items[Number(b.dataset.i)][1](); };
}

// ------------------------------------------------------------- reorder

// Pointer-driven, the same approach the Bots board uses: HTML5 drag drags a
// snapshot and plays an un-cancellable snap-back on drop.
function sortable(list, itemSel, onEnd) {
  for (const el of list.querySelectorAll(itemSel)) {
    el.addEventListener('pointerdown', (e) => {
      if (e.button !== 0 || e.target.closest('input, textarea, button')) return;
      const start = { x: e.clientX, y: e.clientY };
      let moved = false;
      const move = (ev) => {
        if (!moved && Math.hypot(ev.clientX - start.x, ev.clientY - start.y) < 6) return;
        if (!moved) { moved = true; el.classList.add('dragging'); }
        const items = [...list.querySelectorAll(itemSel)].filter((o) => o !== el);
        let best = null; let bestD = Infinity; let after = false;
        for (const o of items) {
          const r = o.getBoundingClientRect();
          const d = Math.hypot(ev.clientX - (r.left + r.width / 2), ev.clientY - (r.top + r.height / 2));
          if (d < bestD) { bestD = d; best = o; after = ev.clientX > r.left + r.width / 2 || ev.clientY > r.top + r.height / 2; }
        }
        if (best) list.insertBefore(el, after ? best.nextElementSibling : best);
      };
      const up = () => {
        window.removeEventListener('pointermove', move);
        window.removeEventListener('pointerup', up);
        el.classList.remove('dragging');
        if (moved) onEnd([...list.querySelectorAll(itemSel)]);
      };
      window.addEventListener('pointermove', move);
      window.addEventListener('pointerup', up);
    });
  }
}

// ------------------------------------------------------------- keys

function onKey(e) {
  if (!ed) return;
  const t = e.target;
  if (t && (t.tagName === 'INPUT' || t.tagName === 'TEXTAREA' || t.isContentEditable)) return;
  if (document.querySelector('.sheet-veil')) return;
  const k = e.key.toLowerCase();

  if ((e.metaKey || e.ctrlKey) && k === 's') { e.preventDefault(); void flush(); toast('Saved'); return; }
  if (e.metaKey || e.ctrlKey) return;

  if (k === 'g') { e.preventDefault(); setView(ed.view === 'board' ? 'slide' : 'board'); return; }
  if (ed.view === 'board') {
    if (e.key === '1' || e.key === '!') { e.preventDefault(); fitBoard(true); return; }
    if (e.key === 'Enter' && ed.sel.size) { e.preventDefault(); setView('slide'); return; }
  }
  if (ed.view !== 'slide') return;

  if (e.key === 'Escape') { e.preventDefault(); if (ed.tool !== 'select') { ed.tool = 'select'; paintTools(); } else { ed.sel.clear(); paintHandles(); paintProps(); } return; }
  if ((e.key === 'Backspace' || e.key === 'Delete') && ed.sel.size) { e.preventDefault(); deleteSelection(); return; }
  if (e.key === 'Enter' && ed.sel.size === 1) {
    const x = elById([...ed.sel][0]);
    if (x?.type === 'text') { e.preventDefault(); editText(x.id); return; }
  }
  // Arrows nudge; shift makes it a stride.
  const step = e.shiftKey ? 20 : 2;
  const nudge = { ArrowLeft: [-step, 0], ArrowRight: [step, 0], ArrowUp: [0, -step], ArrowDown: [0, step] }[e.key];
  if (nudge && ed.sel.size) {
    e.preventDefault();
    for (const id of ed.sel) { const x = elById(id); if (x) { x.x += nudge[0]; x.y += nudge[1]; } }
    markDirty();
    repaintGeometry();
    return;
  }
  if (e.key === 'PageDown' || (e.key === 'ArrowRight' && !ed.sel.size)) { e.preventDefault(); if (ed.i < ed.deck.slides.length - 1) { ed.i++; ed.sel.clear(); paintSlideView(); } return; }
  if (e.key === 'PageUp' || (e.key === 'ArrowLeft' && !ed.sel.size)) { e.preventDefault(); if (ed.i > 0) { ed.i--; ed.sel.clear(); paintSlideView(); } return; }
  const tool = TOOLS.find(([, , key]) => key === k);
  if (tool) { e.preventDefault(); ed.tool = tool[0]; paintTools(); $('#edStage').style.cursor = ed.tool === 'select' ? 'default' : 'crosshair'; }
}

window.addEventListener('pointermove', onMove);
window.addEventListener('pointerup', onUp);

// Object URLs die with the page, so a deck reopened in a new session has to
// rebuild them from the asset store before anything renders.
export async function rehydrate(deck) {
  for (const s of deck.slides || []) {
    for (const e of s.els || []) {
      if (!e.asset) continue;
      const blob = await getAsset(e.asset);
      if (blob) e.src = e.url = URL.createObjectURL(blob);
    }
  }
  return deck;
}
