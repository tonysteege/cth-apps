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

// ONE GRID, ONE STROKE, ONE OPTICAL SIZE (2026-08-27, redrawn). The first
// set was assembled from whatever was to hand: mixed stroke widths, some
// paths filling their 24-box and others floating in the middle of it, which
// at 20px reads as a row of different-sized marks. Every glyph below is
// drawn on the same 24 grid, sits inside the same 3..21 optical box, and
// carries the same 1.9 stroke - so the row reads as one set.
const TOOLS = [
  ['select', 'Select', 'v', '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.9" stroke-linejoin="round"><path d="M5.2 3.6a.6.6 0 0 1 .82-.55l13.5 5.6a.6.6 0 0 1-.05 1.12l-5.1 1.45a2 2 0 0 0-1.38 1.38l-1.45 5.1a.6.6 0 0 1-1.12.05z"/></svg>'],
  ['text', 'Text', 't', '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.9" stroke-linecap="round" stroke-linejoin="round"><path d="M4 6.6V4.6h16v2"/><path d="M12 4.6v14.8"/><path d="M8.6 19.4h6.8"/></svg>'],
  ['image', 'Image', 'i', '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.9" stroke-linejoin="round"><rect x="3" y="4.5" width="18" height="15" rx="2.6"/><circle cx="8.6" cy="10" r="1.7"/><path d="m3.6 17.4 4.6-4.6a2 2 0 0 1 2.83 0l4.6 4.6"/><path d="m14.4 14.6 1.6-1.6a2 2 0 0 1 2.83 0l1.6 1.6"/></svg>'],
  ['rink', 'Rink', 'r', '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.9" stroke-linejoin="round"><rect x="3" y="6" width="18" height="12" rx="6"/><path d="M12 6v12"/><circle cx="12" cy="12" r="2.7"/></svg>'],
  ['video', 'Video', 'm', '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.9" stroke-linejoin="round"><rect x="3" y="5" width="18" height="14" rx="2.6"/><path d="M10.4 9.3v5.4l4.6-2.7z"/></svg>'],
  ['shape', 'Shape', 's', '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.9" stroke-linejoin="round"><rect x="3" y="3" width="10.5" height="10.5" rx="2"/><circle cx="15.6" cy="15.6" r="5.4"/></svg>'],
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
// Always resolve against the stage the selection lives on - on the board
// that is whichever frame was last touched, not slide `ed.i`.
const elById = (id) => (slideOf(activeStage()) || slide()).els.find((e) => e.id === id);

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
    // A CORNER RADIUS IS IN SLIDE UNITS, not in the 0..100 viewBox, or it
    // would stretch with the shape and stop being a radius. The rect is
    // therefore drawn in the element's own pixel space.
    const r = Math.max(0, Math.min(Math.min(e.w, e.h) / 2, e.r || 0));
    let svg;
    if (e.shape === 'ellipse') svg = `<ellipse cx="${e.w / 2}" cy="${e.h / 2}" rx="${Math.max(1, e.w / 2 - sw / 2)}" ry="${Math.max(1, e.h / 2 - sw / 2)}" fill="${fill}" stroke="${stroke}" stroke-width="${sw}"/>`;
    else if (e.shape === 'line') svg = `<line x1="${sw / 2}" y1="${e.h / 2}" x2="${e.w - sw / 2}" y2="${e.h / 2}" stroke="${stroke}" stroke-width="${sw}" stroke-linecap="round"/>`;
    else if (e.shape === 'arrow') svg = `<line x1="${sw / 2}" y1="${e.h / 2}" x2="${e.w - sw * 2.6}" y2="${e.h / 2}" stroke="${stroke}" stroke-width="${sw}" stroke-linecap="round"/><polygon points="${e.w},${e.h / 2} ${e.w - sw * 3},${e.h / 2 - sw * 1.7} ${e.w - sw * 3},${e.h / 2 + sw * 1.7}" fill="${stroke}"/>`;
    else svg = `<rect x="${sw / 2}" y="${sw / 2}" width="${Math.max(1, e.w - sw)}" height="${Math.max(1, e.h - sw)}" rx="${r}" fill="${fill}" stroke="${stroke}" stroke-width="${sw}"/>`;
    // TEXT LIVES INSIDE THE SHAPE (2026-08-27, Tony's call): a box with a
    // label in it is one object to move, not two to keep together.
    const t = String(e.text || '');
    const tc = e.tcolor || (fill !== 'none' && isDark(fill) ? '#ffffff' : '#0a0a0a');
    const tsize = e.tsize || 34;
    const label = `<div class="de-shapetext" style="font-size:${(tsize / SLIDE_H) * 100}cqh;color:${esc(tc)}"><div class="de-textin">${esc(t).replace(/\n/g, '<br>')}</div></div>`;
    return `<div class="de-el de-shape" data-el="${e.id}" style="${box}">`
      + `<svg viewBox="0 0 ${e.w} ${e.h}" preserveAspectRatio="none">${svg}</svg>${label}</div>`;
  }
  return '';
}

// Rough luminance, for deciding whether a filled shape wants light text.
function isDark(hex) {
  const h = String(hex).replace('#', '');
  if (h.length < 6) return false;
  const [r, g, b] = [0, 2, 4].map((i) => parseInt(h.slice(i, i + 2), 16) / 255);
  return (0.2126 * r + 0.7152 * g + 0.0722 * b) < 0.55;
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
      <div class="de-tools" id="edTools"></div>
      <div class="de-place" id="edPlace" hidden></div>
      <input type="file" id="edFile" accept="image/*,video/*" hidden>
    </div>`;
  $('#edBack').onclick = () => { location.hash = ''; };
  $('#edName').oninput = (e) => { ed.deck.name = e.target.value; document.title = `${e.target.value} - CTH Slides`; markDirty(); };
  $('#edName').onkeydown = (e) => e.stopPropagation();
  $$('.de-viewbtn').forEach((b) => { b.onclick = () => setView(b.dataset.view); });
  $('#edPresent').onclick = () => { void flush(); location.hash = `#/present/${ed.deck.id}`; };
  paintBody();
  // THE TOOL BAR BELONGS TO THE APP, NOT TO ONE VIEW (2026-08-27, Tony's
  // call). It used to be built inside the slide view, so the board - the
  // view he actually works in - simply had no tools at all.
  paintTools();
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
  // A frame IS a stage: its slide renders live and its elements are the
  // same interactive elements the slide view has. Editing on the board was
  // the point of the board (2026-08-27, Tony's call).
  canvas.innerHTML = ed.deck.slides.map((sl, i) => `
    <div class="de-frame" data-slide="${sl.id}" data-i="${i}">
      <span class="de-framen">${i + 1}</span>
      <div class="de-framebox de-stagebox" data-stage="${i}">${slideHtml(sl)}<div class="de-guides"></div></div>
    </div>`).join('')
    // A "+" between every pair, and one at each end: inserting a slide
    // where it belongs beats making it last and dragging it back.
    + ed.deck.slides.map((_, i) => `<button class="de-insert" data-at="${i}" title="Insert A Slide Here">+</button>`).join('')
    + `<button class="de-insert de-insert-end" data-at="${ed.deck.slides.length}" title="New Slide">+</button>`;

  if (!ed.pan) fitBoard(false);
  applyBoardTransform();
  mountSlideVideos(canvas);
  paintHandles();

  $$('[data-at]', canvas).forEach((b) => {
    b.onclick = (e) => { e.stopPropagation(); addSlide('header', Number(b.dataset.at)); };
  });
  for (const f of $$('.de-frame', canvas)) {
    const i = Number(f.dataset.i);
    // The NUMBER is the slide's own grab handle - dragging the frame body
    // would fight with dragging the elements on it.
    f.querySelector('.de-framen').addEventListener('pointerdown', (e) => onFrameDown(e, f));
    f.querySelector('.de-framen').addEventListener('dblclick', () => { ed.i = i; setView('slide'); });
    f.oncontextmenu = (e) => {
      if (e.target.closest('.de-el')) return;
      e.preventDefault();
      slideMenu(e.clientX, e.clientY, i);
    };
    wireStage(f.querySelector('.de-stagebox'), i);
  }
  const board = $('#edBoard');
  board.addEventListener('wheel', onBoardWheel, { passive: false });
  board.addEventListener('pointerdown', (e) => {
    if (e.target.closest('.de-frame') || e.target.closest('.de-zoom') || e.target.closest('.de-insert')) return;
    ed.sel.clear();
    paintBoardSel();
    paintProps();
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
  for (const b of $$('.de-insert', canvas)) {
    const at = Number(b.dataset.at);
    // Centred in the gap before slide `at`; the end one sits past the last.
    b.style.left = `${at * (SLIDE_W + GAP) - GAP / 2}px`;
  }
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
  for (const f of $$('.de-frame')) f.classList.toggle('on', ed.frameSel === f.dataset.slide);
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
    </div>
    <aside class="de-props" id="edProps"></aside>`;
  paintRail();
  paintStage();
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
  ed.stage = stage;
  const s = slide();
  stage.style.background = s.bg || '#ffffff';
  stage.innerHTML = `${(s.els || []).map(elHtml).join('')}<div class="de-guides"></div>`;
  mountSlideVideos(stage);
  wireStage(stage, ed.i);
  paintHandles();
}

// ONE STAGE IMPLEMENTATION, USED BY BOTH VIEWS. The slide view has one; the
// board has one per frame. `si` says which slide the stage is showing, so a
// pointer on the board edits the slide it is actually over.
function wireStage(stage, si) {
  if (!stage || stage.dataset.wired) return;
  stage.dataset.wired = '1';
  stage.dataset.si = String(si);
  for (const el of $$('.de-el', stage)) {
    const id = el.dataset.el;
    el.addEventListener('pointerdown', (e) => onElDown(e, id, stage));
    el.addEventListener('dblclick', (e) => {
      const x = elAt(stage, id);
      if (x?.type === 'text' || x?.type === 'shape') { e.stopPropagation(); editText(id, stage); }
    });
  }
  stage.addEventListener('pointerdown', (e) => onStageDown(e, stage));
}

const siOf = (stage) => Number(stage.dataset.si || ed.i);
const slideOf = (stage) => ed.deck.slides[siOf(stage)];
const elAt = (stage, id) => slideOf(stage).els.find((e) => e.id === id);
// The stage the selection currently lives on.
const activeStage = () => (ed.stage && ed.stage.isConnected ? ed.stage : $('#edStage'));

// Selection chrome and handles live in their own layer, so a repaint of
// the selection never re-creates the elements underneath it (which would
// tear down a mounted video mid-drag).
function paintHandles() {
  $$('.de-handles').forEach((h) => h.remove());
  const stage = activeStage();
  if (!stage || !ed.sel.size) return;
  const sl = slideOf(stage);
  const layer = document.createElement('div');
  layer.className = 'de-handles';
  const pc = (v, total) => `${(v / total) * 100}%`;
  const find = (id) => sl.els.find((e) => e.id === id);
  for (const id of ed.sel) {
    const e = find(id);
    if (!e) continue;
    layer.insertAdjacentHTML('beforeend',
      `<div class="de-ring" style="left:${pc(e.x, SLIDE_W)};top:${pc(e.y, SLIDE_H)};width:${pc(e.w, SLIDE_W)};height:${pc(e.h, SLIDE_H)}"></div>`);
  }
  if (ed.sel.size === 1) {
    const e = find([...ed.sel][0]);
    if (e) {
      for (const k of ['nw', 'ne', 'sw', 'se', 'n', 's', 'w', 'e']) {
        const hx = k.includes('w') ? e.x : k.includes('e') ? e.x + e.w : e.x + e.w / 2;
        const hy = k.includes('n') ? e.y : k.includes('s') ? e.y + e.h : e.y + e.h / 2;
        layer.insertAdjacentHTML('beforeend',
          `<span class="de-h" data-h="${k}" style="left:${pc(hx, SLIDE_W)};top:${pc(hy, SLIDE_H)}"></span>`);
      }
      // A ROUNDING HANDLE, the way every vector editor does it: one dot
      // inside the top-left corner that only a rectangle gets.
      if (e.type === 'shape' && (e.shape || 'rect') === 'rect') {
        const inset = Math.max(18, Math.min(Math.min(e.w, e.h) / 2, (e.r || 0) + 18));
        layer.insertAdjacentHTML('beforeend',
          `<span class="de-h de-hr" data-h="radius" title="Round The Corners" style="left:${pc(e.x + inset, SLIDE_W)};top:${pc(e.y + inset, SLIDE_H)}"></span>`);
      }
      // MINDMAP ARROWS (2026-08-27, Tony's call): four buttons just off a
      // shape's edges. Pressing one drops a matching shape in that
      // direction and joins the two with a connector - the FigJam gesture,
      // and the whole point is that it takes one click, not five.
      if (e.type === 'shape') {
        const off = 26;
        const spots = {
          n: [e.x + e.w / 2, e.y - off], s: [e.x + e.w / 2, e.y + e.h + off],
          w: [e.x - off, e.y + e.h / 2], e: [e.x + e.w + off, e.y + e.h / 2],
        };
        for (const [dir, [ax, ay]] of Object.entries(spots)) {
          layer.insertAdjacentHTML('beforeend',
            `<button class="de-spawn de-spawn-${dir}" data-spawn="${dir}" title="Add A Connected Shape" style="left:${pc(ax, SLIDE_W)};top:${pc(ay, SLIDE_H)}"></button>`);
        }
      }
    }
  }
  stage.appendChild(layer);
  for (const h of $$('.de-h', layer)) h.addEventListener('pointerdown', (ev) => onHandleDown(ev, h.dataset.h, stage));
  for (const b of $$('[data-spawn]', layer)) {
    b.addEventListener('pointerdown', (ev) => ev.stopPropagation());
    b.addEventListener('click', (ev) => { ev.stopPropagation(); spawnConnected(b.dataset.spawn, stage); });
  }
}

// Screen pixels to slide units, for whichever stage was hit. The stage
// scales; the geometry does not.
function toSlide(e, stage) {
  const r = (stage || activeStage()).getBoundingClientRect();
  return { x: ((e.clientX - r.left) / r.width) * SLIDE_W, y: ((e.clientY - r.top) / r.height) * SLIDE_H };
}

let drag = null;

function onStageDown(e, stage) {
  if (e.target.closest('.de-el') || e.target.closest('.de-h') || e.target.closest('[data-spawn]')) return;
  e.stopPropagation();
  ed.stage = stage;
  ed.i = siOf(stage);
  ed.frameSel = slideOf(stage).id;
  if (ed.tool !== 'select') { placeTool(toSlide(e, stage), stage); return; }
  const p = toSlide(e, stage);
  ed.sel.clear();
  drag = { kind: 'band', stage, from: p, to: p };
  paintHandles();
  paintProps();
  paintBoardSel();
}

function onElDown(e, id, stage) {
  if (ed.tool !== 'select') return;
  e.stopPropagation();
  // Selection cannot straddle two slides: landing on a new stage starts a
  // new selection there.
  if (ed.stage !== stage) { ed.sel.clear(); ed.stage = stage; ed.i = siOf(stage); ed.frameSel = slideOf(stage).id; }
  const p = toSlide(e, stage);
  if (e.shiftKey) ed.sel.has(id) ? ed.sel.delete(id) : ed.sel.add(id);
  else if (!ed.sel.has(id)) { ed.sel.clear(); ed.sel.add(id); }
  drag = {
    kind: 'move', stage, from: p,
    origs: [...ed.sel].map((z) => ({ ...elAt(stage, z) })).filter((z) => z.id),
  };
  paintHandles();
  paintProps();
  paintBoardSel();
}

function onHandleDown(e, k, stage) {
  e.stopPropagation();
  const id = [...ed.sel][0];
  drag = { kind: k === 'radius' ? 'radius' : 'resize', h: k, stage, from: toSlide(e, stage), orig: { ...elAt(stage, id) } };
}

function onMove(e) {
  if (!drag || !ed) return;
  const stage = drag.stage || activeStage();
  const p = toSlide(e, stage);
  if (drag.kind === 'band') {
    drag.to = p;
    const r = { x: Math.min(drag.from.x, p.x), y: Math.min(drag.from.y, p.y), w: Math.abs(p.x - drag.from.x), h: Math.abs(p.y - drag.from.y) };
    ed.sel.clear();
    for (const z of slideOf(stage).els) {
      if (z.x < r.x + r.w && z.x + z.w > r.x && z.y < r.y + r.h && z.y + z.h > r.y) ed.sel.add(z.id);
    }
    paintBand(r, stage);
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
      const snapped = snap(o, dx, dy, stage);
      dx = snapped.dx; dy = snapped.dy;
      showGuides(snapped.guides, stage);
    }
    for (const o of drag.origs) {
      const x = elAt(stage, o.id);
      if (!x) continue;
      x.x = Math.round(o.x + dx);
      x.y = Math.round(o.y + dy);
    }
    repaintGeometry(stage);
    return;
  }
  if (drag.kind === 'radius') {
    const o = drag.orig;
    const x = elAt(stage, o.id);
    if (!x) return;
    // The handle's distance from the corner IS the radius.
    x.r = Math.round(Math.max(0, Math.min(Math.min(o.w, o.h) / 2, Math.max(p.x - o.x, p.y - o.y) - 18)));
    repaintShape(stage, x);
    return;
  }
  if (drag.kind === 'resize') {
    const o = drag.orig;
    const x = elAt(stage, o.id);
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
    repaintGeometry(stage);
    if (x.type === 'shape') repaintShape(stage, x);
  }
}

// A shape's svg is drawn in its own pixel space, so a resize or a radius
// change has to redraw it - the box alone is not enough.
function repaintShape(stage, x) {
  const host = stage.querySelector(`.de-el[data-el="${x.id}"]`);
  if (!host) return;
  const tmp = document.createElement('div');
  tmp.innerHTML = elHtml(x);
  host.innerHTML = tmp.firstElementChild.innerHTML;
  paintHandles();
}

function onUp() {
  if (!drag) return;
  const was = drag.kind;
  const stage = drag.stage;
  drag = null;
  $$('.de-band').forEach((b) => b.remove());
  showGuides([], stage);
  if (was !== 'band') { markDirty(); paintRailIfOpen(); }
  paintHandles();
  paintProps();
}

const paintRailIfOpen = () => { if (ed.view === 'slide') paintRail(); };

// Move and resize only change numbers, so only the boxes need updating -
// re-rendering the slide would tear down a mounted video on every frame.
function repaintGeometry(stage = activeStage()) {
  for (const el of $$('.de-el', stage)) {
    const e = elAt(stage, el.dataset.el);
    if (!e) continue;
    el.style.left = `${(e.x / SLIDE_W) * 100}%`;
    el.style.top = `${(e.y / SLIDE_H) * 100}%`;
    el.style.width = `${(e.w / SLIDE_W) * 100}%`;
    el.style.height = `${(e.h / SLIDE_H) * 100}%`;
  }
  paintHandles();
}

function paintBand(r, stage = activeStage()) {
  let b = stage.querySelector('.de-band');
  if (!b) {
    b = document.createElement('div');
    b.className = 'de-band';
    stage.appendChild(b);
  }
  b.style.cssText = `left:${(r.x / SLIDE_W) * 100}%;top:${(r.y / SLIDE_H) * 100}%;width:${(r.w / SLIDE_W) * 100}%;height:${(r.h / SLIDE_H) * 100}%`;
}

// Snapping: the slide's own centre and edges, plus every other element's
// edges. 10 slide units is about 6 screen pixels at a normal stage size -
// tight enough to feel deliberate, loose enough to catch.
const SNAP = 10;
function snap(o, dx, dy, stage = activeStage()) {
  const guides = [];
  const others = slideOf(stage).els.filter((z) => z.id !== o.id);
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

function showGuides(list, stage = activeStage()) {
  const g = stage?.querySelector('.de-guides');
  if (!g) return;
  g.innerHTML = (list || []).map((z) => (z.axis === 'x'
    ? `<i class="de-gv" style="left:${(z.at / SLIDE_W) * 100}%"></i>`
    : `<i class="de-gh" style="top:${(z.at / SLIDE_H) * 100}%"></i>`)).join('');
}

// ------------------------------------------------------------- text edit

// Editing happens IN PLACE, in the element itself, so the type never jumps
// between a field and the committed slide - the same rule the Clips text
// tool follows.
function editText(id, stage = activeStage()) {
  const e = elAt(stage, id);
  const host = stage.querySelector(`.de-el[data-el="${id}"] .de-textin`);
  if (!e || !host) return;
  host.contentEditable = 'plaintext-only';
  host.classList.add('editing');
  if (e.role === 'bullets') host.textContent = e.text || '';
  host.focus();
  document.getSelection()?.selectAllChildren(host);
  let done = false;
  const finish = () => {
    if (done) return;
    done = true;
    host.contentEditable = 'false';
    host.classList.remove('editing');
    e.text = host.innerText.replace(/\n{3,}/g, '\n\n').trim();
    markDirty();
    // Redraw only this element - repainting the stage would tear down a
    // mounted video and, on the board, everything else on the canvas.
    const el = stage.querySelector(`.de-el[data-el="${id}"]`);
    if (el) {
      const tmp = document.createElement('div');
      tmp.innerHTML = elHtml(e);
      el.innerHTML = tmp.firstElementChild.innerHTML;
      el.setAttribute('style', tmp.firstElementChild.getAttribute('style'));
    }
    paintHandles();
    paintProps();
    paintRailIfOpen();
  };
  host.onblur = finish;
  host.onkeydown = (ev) => {
    ev.stopPropagation();
    if (ev.key === 'Escape') { ev.preventDefault(); host.blur(); }
    if (ev.key === 'Enter' && (ev.metaKey || ev.ctrlKey)) { ev.preventDefault(); host.blur(); }
  };
}

// A shape spawns a matching sibling in a direction and joins the two with a
// connector. One click; the FigJam gesture.
function spawnConnected(dir, stage) {
  const src = elAt(stage, [...ed.sel][0]);
  if (!src) return;
  const GAP2 = 90;
  const d = {
    n: { x: src.x, y: src.y - src.h - GAP2 },
    s: { x: src.x, y: src.y + src.h + GAP2 },
    w: { x: src.x - src.w - GAP2, y: src.y },
    e: { x: src.x + src.w + GAP2, y: src.y },
  }[dir];
  const next = { ...structuredClone(src), id: uid(), x: Math.round(d.x), y: Math.round(d.y), text: '' };
  clampInto(next);
  // The connector spans the gap between the two, along the axis it grew on.
  const vertical = dir === 'n' || dir === 's';
  const from = dir === 's' ? src.y + src.h : dir === 'n' ? next.y + next.h : src.x + src.w;
  const to = dir === 's' ? next.y : dir === 'n' ? src.y : dir === 'w' ? src.x : next.x;
  const link = {
    id: uid(), type: 'shape', shape: 'arrow',
    stroke: src.stroke || '#0a0a0a', sw: Math.max(4, (src.sw || 6) - 1), fill: 'none',
    x: vertical ? src.x + src.w / 2 - 6 : Math.min(from, to),
    y: vertical ? Math.min(from, to) : src.y + src.h / 2 - 6,
    w: vertical ? 12 : Math.abs(to - from),
    h: vertical ? Math.abs(to - from) : 12,
    rot: vertical ? (dir === 's' ? 90 : 270) : (dir === 'w' ? 180 : 0),
  };
  const sl = slideOf(stage);
  sl.els.push(link, next);
  ed.sel.clear();
  ed.sel.add(next.id);
  markDirty();
  redrawStage(stage);
  paintHandles();
  paintProps();
  paintRailIfOpen();
  setTimeout(() => editText(next.id, stage), 40);
}

// Redraw one stage in place, keeping its wiring.
function redrawStage(stage) {
  const sl = slideOf(stage);
  stage.style.background = sl.bg || '#ffffff';
  stage.innerHTML = `${(sl.els || []).map(elHtml).join('')}<div class="de-guides"></div>`;
  delete stage.dataset.wired;
  mountSlideVideos(stage);
  wireStage(stage, siOf(stage));
}

// ------------------------------------------------------------- tools

function paintTools() {
  const bar = $('#edTools');
  bar.innerHTML = `
    ${TOOLS.map(([t, label, key, icon]) => `<button class="tb-btn${ed.tool === t ? ' on' : ''}" data-tool="${t}" title="${label} (${key.toUpperCase()})">${icon}<span class="tb-key">${key.toUpperCase()}</span></button>`).join('')}
    <span class="tb-sep"></span>
    <button class="tb-btn tb-word" data-act="layout" title="Replace This Slide's Layout">Layout</button>
    <button class="tb-btn tb-word" data-act="dupe" title="Duplicate This Slide">Duplicate</button>`;
  for (const b of $$('[data-tool]', bar)) b.onclick = () => armTool(b.dataset.tool);
  bar.querySelector('[data-act="layout"]').onclick = (e) => layoutMenu(e.clientX, e.clientY);
  bar.querySelector('[data-act="dupe"]').onclick = () => dupeSlide(ed.i);
}

// ARMING A MEDIA TOOL ASKS FOR THE FILE FIRST, then waits for a click to
// place it - Figma's order, and the reason the old flow was unusable: it
// asked for a click first and only then opened a picker, so by the time the
// file came back the intent had gone stale and nothing appeared to happen.
async function armTool(t) {
  if (t === 'image' || t === 'video') {
    const got = await askFile(t);
    if (!got) { ed.tool = 'select'; paintTools(); return; }
    ed.pending = got;
    showPlaceBar(got.name);
  } else if (t === 'rink') {
    const got = await askRink();
    if (!got) { ed.tool = 'select'; paintTools(); return; }
    ed.pending = got;
    showPlaceBar(got.name);
  } else {
    ed.pending = null;
    hidePlaceBar();
  }
  ed.tool = t;
  paintTools();
  setCursor();
}

function setCursor() {
  for (const st of $$('.de-stagebox, #edStage')) st.style.cursor = ed.tool === 'select' ? 'default' : 'crosshair';
}

// The strip that says what is about to be placed, straight out of Figma.
function showPlaceBar(name) {
  const bar = $('#edPlace');
  bar.hidden = false;
  bar.innerHTML = `<span>Click A Slide To Place <b>${esc(name)}</b></span><button class="mini" data-x="cancel">Cancel</button>`;
  bar.querySelector('[data-x="cancel"]').onclick = () => { ed.pending = null; ed.tool = 'select'; paintTools(); setCursor(); hidePlaceBar(); };
}
function hidePlaceBar() { const b = $('#edPlace'); if (b) { b.hidden = true; b.innerHTML = ''; } }

// A tool click drops its element at the pointer and hands the pointer
// straight back to Select - placing three boxes in a row is not the common
// case; adjusting the one you just placed is.
function placeTool(p, stage = activeStage()) {
  const t = ed.tool;
  ed.stage = stage;
  const at = (w, h) => ({ x: Math.round(Math.max(0, Math.min(SLIDE_W - w, p.x - w / 2))), y: Math.round(Math.max(0, Math.min(SLIDE_H - h, p.y - h / 2))), w, h });
  if (t === 'text') {
    const e = { ...newText('body'), ...at(620, 96), text: 'Text' };
    slideOf(stage).els.push(e);
    commitPlace(e.id, stage);
    // A text box you have to click again to type into is a text box that
    // does not work. The redraw has to land first, hence the frame wait.
    requestAnimationFrame(() => editText(e.id, stage));
    return;
  }
  if (t === 'shape') {
    const e = { id: uid(), type: 'shape', shape: 'rect', ...at(420, 240), fill: '#ffffff', stroke: '#0a0a0a', sw: 6, r: 16, text: '' };
    slideOf(stage).els.push(e);
    commitPlace(e.id, stage);
    return;
  }
  const got = ed.pending;
  if (!got) { ed.tool = 'select'; paintTools(); return; }
  ed.pending = null;
  hidePlaceBar();
  if (got.kind === 'video') {
    const e = { id: uid(), type: 'video', asset: got.asset, url: got.url, name: got.name, ...at(880, 495), in: 0, out: 0 };
    slideOf(stage).els.push(e);
    commitPlace(e.id, stage);
    return;
  }
  const w = got.kind === 'rink' ? 760 : 700;
  const h = Math.round(w / (got.ratio || 1.6));
  const e = { id: uid(), type: got.kind === 'rink' ? 'rink' : 'image', asset: got.asset, src: got.url, ...at(w, h), fit: 'contain' };
  slideOf(stage).els.push(e);
  commitPlace(e.id, stage);
}

function commitPlace(id, stage = activeStage()) {
  ed.tool = 'select';
  ed.sel.clear();
  ed.sel.add(id);
  ed.stage = stage;
  markDirty();
  paintTools();
  setCursor();
  redrawStage(stage);
  paintHandles();
  paintProps();
  paintRailIfOpen();
}

// An image or a video is stored as a BLOB in its own store and referenced
// by an object URL. Base64 on the deck record would rewrite the whole deck
// on every nudge and blow past what IndexedDB will happily hold.
//
// These ASK for a file and hand it back; the caller decides where it goes.
// The old pair placed the element themselves, which is why the media tools
// only worked from the slide view and only at a position chosen before the
// picker had even opened.
function askFile(kind) {
  return new Promise((res) => {
    const inp = $('#edFile');
    inp.accept = kind === 'video' ? 'video/*' : 'image/*';
    inp.value = '';
    let settled = false;
    const done = (v) => { if (!settled) { settled = true; res(v); } };
    inp.onchange = async () => {
      const f = inp.files?.[0];
      inp.value = '';
      if (!f) return done(null);
      const asset = uid();
      await putAsset(asset, f);
      const url = URL.createObjectURL(f);
      if (kind === 'video') return done({ kind: 'video', asset, url, name: f.name });
      // Size an image to its own aspect so it lands looking right.
      const img = new Image();
      img.onload = () => done({ kind: 'image', asset, url, name: f.name, ratio: img.naturalWidth / Math.max(1, img.naturalHeight) });
      img.onerror = () => done({ kind: 'image', asset, url, name: f.name, ratio: 1.6 });
      img.src = url;
    };
    // A cancelled picker fires no event at all; the window regaining focus
    // is the only signal there is.
    window.addEventListener('focus', () => setTimeout(() => { if (!inp.files?.length) done(null); }, 400), { once: true });
    inp.click();
  });
}

// Rink diagrams come from the cth folder the other apps already write to,
// so a PNG saved out of Diagrams is one click from a slide.
async function askRink() {
  let files = [];
  try {
    const fs = await import('../../clips/js/localfs.js');
    if (fs.fsSupported() && (fs.fsConnected() || fs.fsRemembered())) {
      if (!fs.fsConnected()) await fs.fsReconnect();
      const listing = await fs.fsListFolder('/diagrams');
      files = (listing.files || []).filter((f) => /\.(png|jpe?g|webp)$/i.test(f.name));
    }
  } catch (e) { console.warn('rink listing failed', e.message); }

  return new Promise((res) => {
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
    const close = (v) => { veil.remove(); res(v); };
    veil.addEventListener('mousedown', (e) => { if (e.target === veil) close(null); });
    veil.querySelector('[data-x="cancel"]').onclick = () => close(null);
    veil.querySelector('[data-x="file"]').onclick = async () => { veil.remove(); res(await askFile('image')); };
    for (const b of veil.querySelectorAll('[data-i]')) {
      b.onclick = async () => {
        try {
          const fs = await import('../../clips/js/localfs.js');
          const file = await fs.fsGetFile(files[Number(b.dataset.i)].path);
          const asset = uid();
          await putAsset(asset, file);
          // A rink is 2:1 - the geometry rink.js is measured against.
          close({ kind: 'rink', asset, url: URL.createObjectURL(file), name: file.name, ratio: 2 });
        } catch (err) {
          toast(err.message || 'Could Not Open That Diagram', true);
          close(null);
        }
      };
    }
  });
}

function clampInto(e) {
  e.x = Math.max(0, Math.min(SLIDE_W - e.w, e.x));
  e.y = Math.max(0, Math.min(SLIDE_H - e.h, e.y));
}

// ------------------------------------------------------------- properties

function paintProps() {
  const box = $('#edProps');
  if (!box) return;
  const ids = [...ed.sel];
  if (!ids.length) {
    const s = slideOf(activeStage());
    box.innerHTML = `
      <div class="pe-title">Slide ${siOf(activeStage()) + 1}</div>
      <label class="bs-row"><span>Background</span>
        <span class="de-sw">${SWATCHES.map((h) => `<button class="de-swatch${(s.bg || '').toLowerCase() === h ? ' on' : ''}" data-bg="${h}" style="--c:${h}"></button>`).join('')}</span>
      </label>
      <p class="bs-note">Click a tool below and then the slide to place something. Double-click any text to edit it.</p>`;
    for (const b of $$('[data-bg]', box)) {
      b.onclick = () => { s.bg = b.dataset.bg; markDirty(); redrawStage(activeStage()); paintHandles(); paintRailIfOpen(); paintProps(); };
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
    if ((e.shape || 'rect') === 'rect') rows.push(`<label class="bs-row"><span>Corners</span><input type="number" data-k="r" min="0" max="400" value="${e.r || 0}"></label>`);
    rows.push(`<label class="bs-row"><span>Label Size</span><input type="number" data-k="tsize" min="12" max="160" value="${e.tsize || 34}"></label>`);
    rows.push(`<label class="bs-row"><span>Stroke</span><span class="de-sw">${SWATCHES.map((h) => `<button class="de-swatch${(e.stroke || '').toLowerCase() === h ? ' on' : ''}" data-stroke="${h}" style="--c:${h}"></button>`).join('')}</span></label>`);
    rows.push(`<label class="bs-row"><span>Fill</span><span class="de-sw"><button class="de-swatch de-none${(e.fill || 'none') === 'none' ? ' on' : ''}" data-fill="none"></button>${SWATCHES.map((h) => `<button class="de-swatch${(e.fill || '').toLowerCase() === h ? ' on' : ''}" data-fill="${h}" style="--c:${h}"></button>`).join('')}</span></label>`);
  }
  if (e.type === 'image' || e.type === 'rink') {
    rows.push(`<label class="bs-row"><span>Fit</span>
      <select data-k="fit">${['contain', 'cover'].map((f) => `<option${(e.fit || 'contain') === f ? ' selected' : ''}>${f}</option>`).join('')}</select></label>`);
  }
  if (e.type === 'logo') {
    rows.push(`<label class="bs-row"><span>Mark</span>
      <select data-k="variant">${Object.keys(LOGOS).map((v) => `<option value="${v}"${e.variant === v ? ' selected' : ''}>${v.replace('-', ' ')}</option>`).join('')}</select></label>`);
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
      redrawStage(activeStage());
      paintHandles();
      paintRailIfOpen();
      if (['role', 'shape'].includes(k)) paintProps();
    };
    f.onchange = commit;
    f.onkeydown = (ev) => { ev.stopPropagation(); if (ev.key === 'Enter') commit(); };
  }
  for (const [attr, key] of [['data-color', 'color'], ['data-stroke', 'stroke'], ['data-fill', 'fill']]) {
    for (const b of $$(`[${attr}]`, box)) {
      b.onclick = () => {
        for (const id of ed.sel) { const t = elById(id); if (t) t[key] = b.getAttribute(attr); }
        markDirty(); redrawStage(activeStage()); paintHandles(); paintRailIfOpen(); paintProps();
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
    markDirty(); redrawStage(activeStage()); paintRailIfOpen(); paintHandles();
  });
  act('del', () => deleteSelection());
}

function reorderEls(where) {
  const s = slideOf(activeStage());
  const picked = s.els.filter((e) => ed.sel.has(e.id));
  s.els = s.els.filter((e) => !ed.sel.has(e.id));
  if (where === 'front') s.els.push(...picked); else s.els.unshift(...picked);
  markDirty();
  redrawStage(activeStage());
  paintHandles();
  paintRailIfOpen();
}

function deleteSelection() {
  const s = slideOf(activeStage());
  for (const e of s.els) if (ed.sel.has(e.id) && e.asset) void deleteAsset(e.asset);
  s.els = s.els.filter((e) => !ed.sel.has(e.id));
  ed.sel.clear();
  markDirty();
  redrawStage(activeStage());
  paintRailIfOpen();
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
  if (e.key === 'Escape') { e.preventDefault(); if (ed.tool !== 'select') { ed.tool = 'select'; paintTools(); } else { ed.sel.clear(); paintHandles(); paintProps(); } return; }
  if ((e.key === 'Backspace' || e.key === 'Delete') && ed.sel.size) { e.preventDefault(); deleteSelection(); return; }
  if (e.key === 'Enter' && ed.sel.size === 1) {
    const x = elById([...ed.sel][0]);
    if (x?.type === 'text' || x?.type === 'shape') { e.preventDefault(); editText(x.id, activeStage()); return; }
  }
  // Arrows nudge; shift makes it a stride.
  const step = e.shiftKey ? 20 : 2;
  const nudge = { ArrowLeft: [-step, 0], ArrowRight: [step, 0], ArrowUp: [0, -step], ArrowDown: [0, step] }[e.key];
  if (nudge && ed.sel.size) {
    e.preventDefault();
    for (const id of ed.sel) { const x = elById(id); if (x) { x.x += nudge[0]; x.y += nudge[1]; } }
    markDirty();
    repaintGeometry(activeStage());
    return;
  }
  if (e.key === 'PageDown' || (e.key === 'ArrowRight' && !ed.sel.size)) { e.preventDefault(); if (ed.i < ed.deck.slides.length - 1) { ed.i++; ed.sel.clear(); paintSlideView(); } return; }
  if (e.key === 'PageUp' || (e.key === 'ArrowLeft' && !ed.sel.size)) { e.preventDefault(); if (ed.i > 0) { ed.i--; ed.sel.clear(); paintSlideView(); } return; }
  const tool = TOOLS.find(([, , key]) => key === k);
  if (tool) { e.preventDefault(); void armTool(tool[0]); }
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
