// The Decks whiteboard editor. THE BOARD IS THE DOCUMENT: an infinite
// canvas holding decks, sticky notes, text, shapes, pen strokes,
// connectors, sections and media. A deck's slides are live stages that
// edit in place; "slide view" focuses one deck with a filmstrip.
//
// Rules carried in from the suite:
// - IT SAVES ITSELF (700ms debounce, flush on the way out). No Save button.
// - The canvas moves, the items do not: one transform, chrome scaled back
//   out by --inv. Zoom about the pointer with the Clips per-event clamp.
// - A MEDIA TOOL ASKS FOR ITS FILE FIRST, then a click places it - on a
//   slide if the click lands on one, otherwise on the board.
// - Every pointer resolves against what it landed on; a selection can
//   never straddle two slides.
// - Window-level pointer listeners, removed on teardown.
// - Undo/redo is a snapshot stack of `items`; every committed change
//   (drag end, edit, create, delete, reorder) pushes one.

import {
  SLIDE_W, SLIDE_H, LAYOUTS, ANIM_STYLES, TRANSITIONS, STICKY_COLORS, DEFAULT_SETTINGS,
  DECK_FRAME_W, DECK_FRAME_H, DECK_GAP, DECK_HEAD, deckWidth, deckHeight,
  styleOf, newSlide, newText, newShape, newImage, newVideo, newDiagram, newDeck,
  newDeckItem, newSticky, newBoardText, newBoardShape, newPen, newConnector, newSection,
  newBoardImage, newBoardVideo, newBoardDiagram, normalizeBoard, boardDecks, isBox,
} from './model.js';
import { slideHtml, itemHtml, deckHtml, hydrate, esc } from './render.js';
import { getDeck, putDeck, putAsset, uid, listDrills } from './store.js';

let ed = null;
const $ = (sel, root) => (root || document).querySelector(sel);
const $$ = (sel, root) => [...(root || document).querySelectorAll(sel)];
const clamp = (v, a, b) => Math.max(a, Math.min(b, v));

export const editing = () => !!ed;

// ------------------------------------------------------------- autosave + history

let saveT = 0;
export function markDirty() {
  if (!ed) return;
  ed.board.updated = Date.now();
  clearTimeout(saveT);
  saveT = setTimeout(flush, 700);
  paintStatus('Unsaved');
}

export async function flush() {
  clearTimeout(saveT);
  if (!ed) return;
  try { await putDeck(ed.board); paintStatus('Saved'); }
  catch (_) { paintStatus('Could not save'); }
}

function paintStatus(word) { const n = $('#dkStatus'); if (n) n.textContent = word; }

const snap = () => JSON.stringify(ed.board.items);
function commit() {
  ed.hist.past.push(ed.hist.present);
  if (ed.hist.past.length > 100) ed.hist.past.shift();
  ed.hist.present = snap();
  ed.hist.future = [];
  markDirty();
  paintUndo();
}
function undo() {
  if (!ed.hist.past.length) return;
  ed.hist.future.push(ed.hist.present);
  ed.hist.present = ed.hist.past.pop();
  restore();
}
function redo() {
  if (!ed.hist.future.length) return;
  ed.hist.past.push(ed.hist.present);
  ed.hist.present = ed.hist.future.pop();
  restore();
}
function restore() {
  ed.board.items = JSON.parse(ed.hist.present);
  normalizeBoard(ed.board);
  ed.sel = new Set([...ed.sel].filter((id) => item(id)));
  if (ed.ssel && !item(ed.ssel.deck)) ed.ssel = null;
  markDirty(); paintAll(); paintUndo();
}
function paintUndo() {
  const u = $('#dkUndo'); const r = $('#dkRedo');
  if (u) u.disabled = !ed.hist.past.length;
  if (r) r.disabled = !ed.hist.future.length;
}

// ------------------------------------------------------------- open/close

export async function openEditor(id) {
  const board = normalizeBoard(await getDeck(id));
  if (!board) { location.hash = '#/'; return; }
  const decks = boardDecks(board);
  ed = {
    board, sel: new Set(), ssel: null, tool: 'select', place: null, view: 'board',
    focus: decks[0]?.id || null, tab: 'design', drag: null, un: [], space: false,
    bd: { x: 40, y: 40, z: 0.5 },
    hist: { past: [], present: JSON.stringify(board.items), future: [] },
    prefs: loadPrefs(),
  };
  $('#app').innerHTML = shellHtml(board);
  wireShell();
  paintAll();
  fitToContent();
  const onMove = (e) => onPointerMove(e);
  const onUp = (e) => onPointerUp(e);
  const onKey = (e) => onKeyDown(e);
  const onKeyUp = (e) => { if (e.key === ' ') { ed.space = false; $('#dkBoard')?.classList.remove('is-hand'); } };
  const onFlush = () => flush();
  window.addEventListener('pointermove', onMove);
  window.addEventListener('pointerup', onUp);
  window.addEventListener('keydown', onKey);
  window.addEventListener('keyup', onKeyUp);
  window.addEventListener('pagehide', onFlush);
  document.addEventListener('visibilitychange', onFlush);
  ed.un.push(() => window.removeEventListener('pointermove', onMove));
  ed.un.push(() => window.removeEventListener('pointerup', onUp));
  ed.un.push(() => window.removeEventListener('keydown', onKey));
  ed.un.push(() => window.removeEventListener('keyup', onKeyUp));
  ed.un.push(() => window.removeEventListener('pagehide', onFlush));
  ed.un.push(() => document.removeEventListener('visibilitychange', onFlush));
}

export function closeEditor() {
  if (!ed) return;
  flush();
  for (const fn of ed.un) { try { fn(); } catch (_) {} }
  ed = null;
}

function loadPrefs() {
  try { return { ...JSON.parse(localStorage.getItem('cthk.prefs') || '{}') }; } catch (_) { return {}; }
}

// ------------------------------------------------------------- lookups

const item = (id) => ed.board.items.find((i) => i.id === id);
const deckOf = () => (ed.ssel ? item(ed.ssel.deck) : null);
const slideOf = () => { const d = deckOf(); return d ? d.slides[ed.ssel.i] : null; };
const selEl = () => { const s = slideOf(); return s && ed.ssel.el ? s.els.find((e) => e.id === ed.ssel.el) : null; };
const focusDeck = () => item(ed.focus) || boardDecks(ed.board)[0] || null;
const selItems = () => [...ed.sel].map(item).filter(Boolean);
const settings = () => ed.board.settings;
const snapV = (v) => (settings().snap ? Math.round(v / settings().gridSize) * settings().gridSize : Math.round(v));

// ------------------------------------------------------------- shell

function shellHtml(board) {
  return `
  <div class="dk-editor">
    <header class="dk-head">
      <button class="btn btn-ghost btn-icon" id="dkBack" data-tip="Back to boards" aria-label="Back">${I.back}</button>
      <input class="dk-name" id="dkName" value="${esc(board.name)}" aria-label="Board name">
      <span class="dk-status" id="dkStatus">Saved</span>
      <div class="dk-head-r">
        <div class="seg" role="group" aria-label="Undo">
          <button class="seg-btn" id="dkUndo" data-tip="Undo (⌘Z)" aria-label="Undo">${I.undo}</button>
          <button class="seg-btn" id="dkRedo" data-tip="Redo (⇧⌘Z)" aria-label="Redo">${I.redo}</button>
        </div>
        <div class="seg" role="group" aria-label="View">
          <button class="seg-btn on" id="dkViewBoard" data-tip="Board" aria-label="Board view">${I.grid}</button>
          <button class="seg-btn" id="dkViewSlide" data-tip="Slide view" aria-label="Slide view">${I.film}</button>
        </div>
        <button class="btn btn-outline" id="dkNewSlide">${I.plus} New Slide</button>
        <button class="btn btn-outline btn-icon" id="dkSettings" data-tip="Board settings" aria-label="Board settings">${I.gear}</button>
        <button class="btn btn-primary" id="dkPresent">${I.play} Present</button>
      </div>
    </header>
    <div class="dk-main" id="dkMain"></div>
    <div id="dkSheet"></div>
  </div>`;
}

function wireShell() {
  $('#dkBack').onclick = () => { location.hash = '#/'; };
  $('#dkName').onchange = (e) => { ed.board.name = e.target.value.trim() || 'Untitled Board'; markDirty(); };
  $('#dkSettings').onclick = openSettingsSheet;
  $('#dkNewSlide').onclick = (e) => { const d = deckOf() || focusDeck(); if (d) layoutMenu(e, d); };
  $('#dkPresent').onclick = () => presentDeck(deckOf() || focusDeck());
  $('#dkViewSlide').onclick = () => setView('slide');
  $('#dkViewBoard').onclick = () => setView('board');
  $('#dkUndo').onclick = undo;
  $('#dkRedo').onclick = redo;
}

function presentDeck(d) {
  if (!d) return;
  flush();
  location.hash = `#/present/${ed.board.id}/${d.id}`;
}

function setView(v, deckId) {
  if (deckId) ed.focus = deckId;
  if (v === 'slide' && !focusDeck()) return;
  ed.view = v;
  $('#dkViewSlide').classList.toggle('on', v === 'slide');
  $('#dkViewBoard').classList.toggle('on', v === 'board');
  if (v === 'slide') {
    const d = focusDeck();
    ed.ssel = { deck: d.id, i: Math.min(ed.ssel?.deck === d.id ? ed.ssel.i : 0, d.slides.length - 1), el: null };
  }
  paintAll();
}

// ------------------------------------------------------------- paint

function paintAll() {
  const main = $('#dkMain');
  if (!main) return;
  if (ed.view === 'slide') {
    main.innerHTML = `
      <aside class="dk-rail" id="dkRail"></aside>
      <div class="dk-center">
        <div class="dk-stagewrap" id="dkStageWrap"></div>
        <div class="dk-notes"><textarea id="dkNotes" placeholder="Add presenter notes for this slide…" aria-label="Presenter notes" rows="2"></textarea></div>
        <div class="dk-toolbar" id="dkTools"></div>
        <div class="dk-placebar" id="dkPlace" hidden></div>
      </div>
      <aside class="dk-panel"><div class="tabs" id="dkTabs"></div><div class="dk-panel-body" id="dkPanel"></div></aside>`;
    $('#dkNotes').oninput = (e) => { const s = slideOf(); if (s) { s.notes = e.target.value; markDirty(); } };
    paintRail(); paintSlideStage(); paintNotes();
  } else {
    main.innerHTML = `
      <div class="dk-center">
        <div class="wb-board" id="dkBoard"><div class="wb-canvas" id="dkCanvas"></div><div class="wb-marquee" id="dkMarquee" hidden></div></div>
        <div class="dk-toolbar" id="dkTools"></div>
        <div class="dk-placebar" id="dkPlace" hidden></div>
        <div class="wb-zoom">
          <button class="wb-zbtn" id="dkZoomOut" data-tip="Zoom out (⌘−)" aria-label="Zoom out">${I.minus}</button>
          <button class="wb-zpct" id="dkZoomPct" data-tip="Zoom to fit (⌘0)" aria-label="Zoom level, click to fit">50%</button>
          <button class="wb-zbtn" id="dkZoomIn" data-tip="Zoom in (⌘+)" aria-label="Zoom in">${I.plus}</button>
        </div>
      </div>
      <aside class="dk-panel"><div class="tabs" id="dkTabs"></div><div class="dk-panel-body" id="dkPanel"></div></aside>`;
    paintBoard();
    $('#dkZoomIn').onclick = () => zoomBy(1.25);
    $('#dkZoomOut').onclick = () => zoomBy(0.8);
    $('#dkZoomPct').onclick = fitToContent;
  }
  paintTools(); paintPanel(); paintUndo();
}

// ------------------------------------------------------------- board

function paintBoard() {
  const canvas = $('#dkCanvas');
  if (!canvas) return;
  const items = ed.board.items;
  const html = items.map((it) => (it.kind === 'deck' ? deckHtml(it, ed.ssel?.deck === it.id ? ed.ssel.i : -1) : isBox(it) ? itemHtml(it) : '')).join('');
  canvas.innerHTML = `<svg class="wb-conns" id="dkConns" aria-hidden="true"><defs><marker id="wbArrow" viewBox="0 0 10 10" refX="9" refY="5" markerWidth="8" markerHeight="8" orient="auto-start-reverse"><path d="M0 0 L10 5 L0 10 z" fill="context-stroke"/></marker></defs></svg>${html}<div class="wb-chrome" id="dkChrome"></div>`;
  hydrate(canvas);
  paintConns();
  applyTransform();
  paintChrome();
  const board = $('#dkBoard');
  board.onpointerdown = onBoardDown;
  board.addEventListener('wheel', onBoardWheel, { passive: false });
  board.ondblclick = onBoardDblClick;
  board.oncontextmenu = onBoardContext;
  $$('.wb-deck', canvas).forEach((node) => wireDeck(node, item(node.dataset.item)));
}

// A deck row's own controls: stages edit in place, the frame head selects
// and drags a slide along the row, the tab selects/renames the deck, the
// grip drags the whole row, the dots insert.
function wireDeck(node, d) {
  $$('.dk-stage', node).forEach((st) => { st.addEventListener('pointerdown', onStageDown); st.addEventListener('dblclick', onStageDblClick); });
  $$('.dk-fhead', node).forEach((h) => {
    h.onpointerdown = (e) => { if (e.button !== 0) return; e.stopPropagation(); const i = +h.dataset.fhead; selectSlide(d.id, i); startSlideDrag(e, d, i, h.closest('.dk-frame')); };
    h.oncontextmenu = (e) => { e.preventDefault(); e.stopPropagation(); const i = +h.dataset.fhead; selectSlide(d.id, i); slideMenu(e, d, i); };
  });
  const tab = $('[data-decktab]', node);
  if (tab) {
    tab.onpointerdown = (e) => { if (e.button !== 0 || tab.isContentEditable) return; e.stopPropagation(); if (!ed.sel.has(d.id) || ed.ssel) { ed.ssel = null; select([d.id], e.shiftKey); } startItemDrag(e, 'move'); };
    tab.ondblclick = (e) => { e.stopPropagation(); renameDeck(d, tab); };
  }
  const grip = $('[data-deckgrip]', node);
  if (grip) grip.onpointerdown = (e) => { if (e.button !== 0) return; e.stopPropagation(); ed.ssel = null; if (!ed.sel.has(d.id)) select([d.id], e.shiftKey); startItemDrag(e, 'move'); };
  $$('.dk-insert', node).forEach((b) => {
    b.onpointerdown = (e) => e.stopPropagation();
    b.onclick = (e) => { e.stopPropagation(); const at = +b.dataset.insert; d.slides.splice(at, 0, newSlide('blank')); commit(); repaintDeck(d); selectSlide(d.id, at); if (ed.view === 'slide') paintRail(); };
  });
  const addrow = $('[data-addrow]', node);
  if (addrow) {
    addrow.onpointerdown = (e) => e.stopPropagation();
    addrow.onclick = (e) => {
      e.stopPropagation();
      const deck = newDeck('Untitled Deck'); deck.slides = [newSlide('blank')];
      const it = newDeckItem(deck, { x: d.x, y: d.y + d.h + 140 });
      ed.board.items.push(it); commit(); paintBoard(); selectSlide(it.id, 0);
    };
  }
}

// Drag a slide along its row by the head bar; the neighbours shift out of
// the way and the drop reorders. A press without movement is a select.
function startSlideDrag(e, d, from, frameNode) {
  const p = boardPoint(e);
  ed.drag = { mode: 'slide', d, from, to: from, node: frameNode, sx: p.x, moved: false };
  frameNode.classList.add('dragging');
  e.preventDefault();
}
function moveSlideDrag(e) {
  const dr = ed.drag; const p = boardPoint(e);
  const dx = p.x - dr.sx;
  if (Math.abs(dx) > 4 / ed.bd.z) dr.moved = true;
  if (!dr.moved) return;
  const pitch = DECK_FRAME_W + DECK_GAP;
  dr.node.style.transform = `translateX(${dx}px)`;
  const to = clamp(Math.round(dr.from + dx / pitch), 0, dr.d.slides.length - 1);
  if (to !== dr.to) {
    dr.to = to;
    const deckNode = dr.node.closest('.wb-deck');
    $$('.dk-frame', deckNode).forEach((f) => {
      const i = +f.dataset.i;
      if (i === dr.from) return;
      f.classList.add('shifting');
      let shift = 0;
      if (dr.from < to && i > dr.from && i <= to) shift = -pitch;
      if (dr.from > to && i >= to && i < dr.from) shift = pitch;
      f.style.transform = shift ? `translateX(${shift}px)` : '';
    });
  }
}
function endSlideDrag(dr) {
  dr.node.classList.remove('dragging');
  if (dr.moved && dr.to !== dr.from) {
    const [sl] = dr.d.slides.splice(dr.from, 1);
    dr.d.slides.splice(dr.to, 0, sl);
    commit(); repaintDeck(dr.d); selectSlide(dr.d.id, dr.to); if (ed.view === 'slide') paintRail();
  } else {
    repaintDeck(dr.d);
  }
}

function applyTransform() {
  const c = $('#dkCanvas'); const b = $('#dkBoard');
  if (!c) return;
  const { x, y, z } = ed.bd;
  c.style.transform = `translate(${x}px, ${y}px) scale(${z})`;
  c.style.setProperty('--inv', String(1 / z));
  const s = settings();
  b.style.background = s.bg;
  if (s.grid === 'none') b.style.backgroundImage = 'none';
  else {
    const g = s.gridSize * z;
    b.style.backgroundImage = s.grid === 'lines'
      ? 'linear-gradient(to right, rgb(0 0 0 / 0.06) 1px, transparent 1px), linear-gradient(to bottom, rgb(0 0 0 / 0.06) 1px, transparent 1px)'
      : 'radial-gradient(circle, rgb(0 0 0 / 0.14) 1px, transparent 1.2px)';
    b.style.backgroundSize = `${g}px ${g}px`;
    b.style.backgroundPosition = `${x}px ${y}px`;
  }
  const pct = $('#dkZoomPct'); if (pct) pct.textContent = `${Math.round(z * 100)}%`;
}

function zoomAt(next, px, py) {
  const b = ed.bd;
  next = clamp(next, 0.05, 4);
  b.x = px - (px - b.x) * (next / b.z);
  b.y = py - (py - b.y) * (next / b.z);
  b.z = next;
  applyTransform();
}
function zoomBy(f) {
  const r = $('#dkBoard').getBoundingClientRect();
  zoomAt(ed.bd.z * f, r.width / 2, r.height / 2);
}
function fitToContent() {
  const board = $('#dkBoard'); if (!board) return;
  const boxes = ed.board.items.filter(isBox);
  if (!boxes.length) { ed.bd = { x: 40, y: 40, z: 0.5 }; applyTransform(); return; }
  const bb = union(boxes);
  const r = board.getBoundingClientRect();
  // A board measured before layout (or in a hidden tab) reads 0x0; never
  // fit against that - keep the default and try once more shortly.
  if (r.width < 100 || r.height < 100) { ed.bd = { x: 40, y: 40, z: 0.5 }; applyTransform(); setTimeout(() => { if (ed && $('#dkBoard')?.getBoundingClientRect().width >= 100) fitToContent(); }, 400); return; }
  const z = clamp(Math.min((r.width - 120) / bb.w, (r.height - 120) / bb.h), 0.05, 1.5);
  ed.bd = { z, x: (r.width - bb.w * z) / 2 - bb.x * z, y: (r.height - bb.h * z) / 2 - bb.y * z };
  applyTransform();
}

function onBoardWheel(e) {
  e.preventDefault();
  const b = ed.bd;
  if (e.ctrlKey || e.metaKey) {
    const r = $('#dkBoard').getBoundingClientRect();
    const factor = clamp(Math.exp(-e.deltaY * 0.012), 0.8, 1.25);
    zoomAt(b.z * factor, e.clientX - r.left, e.clientY - r.top);
  } else {
    b.x -= e.deltaX; b.y -= e.deltaY;
    applyTransform();
  }
}

// Board-space point from a client point.
function boardPoint(e) {
  const r = $('#dkBoard').getBoundingClientRect();
  return { x: (e.clientX - r.left - ed.bd.x) / ed.bd.z, y: (e.clientY - r.top - ed.bd.y) / ed.bd.z };
}

function union(items) {
  const x1 = Math.min(...items.map((i) => i.x)); const y1 = Math.min(...items.map((i) => i.y));
  const x2 = Math.max(...items.map((i) => i.x + i.w)); const y2 = Math.max(...items.map((i) => i.y + i.h));
  return { x: x1, y: y1, w: x2 - x1, h: y2 - y1 };
}

// Connectors: a line between the two items' nearest box edges.
function anchor(a, b) {
  const ac = { x: a.x + a.w / 2, y: a.y + a.h / 2 }; const bc = { x: b.x + b.w / 2, y: b.y + b.h / 2 };
  const dx = bc.x - ac.x; const dy = bc.y - ac.y;
  const sx = dx ? (a.w / 2) / Math.abs(dx) : Infinity; const sy = dy ? (a.h / 2) / Math.abs(dy) : Infinity;
  const t = Math.min(sx, sy, 1);
  return { x: ac.x + dx * t, y: ac.y + dy * t };
}
function paintConns() {
  const svg = $('#dkConns'); if (!svg) return;
  const defs = svg.querySelector('defs').outerHTML;
  const lines = ed.board.items.filter((i) => i.kind === 'connector').map((c) => {
    const a = item(c.from); const b = item(c.to);
    if (!a || !b) return '';
    const p = anchor(a, b); const q = anchor(b, a);
    return `<path data-conn="${c.id}" d="M${p.x} ${p.y} L${q.x} ${q.y}" stroke="${c.color}" stroke-width="3" fill="none" ${c.head ? 'marker-end="url(#wbArrow)"' : ''} class="${ed.sel.has(c.id) ? 'on' : ''}"/>
            <path data-connhit="${c.id}" d="M${p.x} ${p.y} L${q.x} ${q.y}" stroke="transparent" stroke-width="18" fill="none"/>`;
  }).join('');
  svg.innerHTML = defs + lines;
  $$('[data-connhit]', svg).forEach((h) => {
    h.onpointerdown = (e) => { e.stopPropagation(); select([h.dataset.connhit], e.shiftKey); };
  });
}

function paintChrome() {
  const chrome = $('#dkChrome'); if (!chrome) return;
  $$('.dk-chrome').forEach((c) => { c.innerHTML = ''; });
  chrome.innerHTML = '';
  $$('.wb-deck').forEach((n) => n.classList.toggle('on', ed.sel.has(n.dataset.item) && !(ed.ssel && ed.ssel.deck === n.dataset.item)));
  // Slide-level element selection lives in the frame's own chrome layer.
  const el = selEl();
  if (el && ed.ssel) {
    const c = $(`.dk-chrome[data-chrome="${ed.ssel.deck}:${ed.ssel.i}"]`) || $(`.dk-chrome[data-chrome="${ed.ssel.deck}:${ed.ssel.i}"]`, $('#dkStageWrap'));
    if (c) {
      c.innerHTML = `<div class="dk-selbox" style="left:${(el.x / SLIDE_W) * 100}%;top:${(el.y / SLIDE_H) * 100}%;width:${(el.w / SLIDE_W) * 100}%;height:${(el.h / SLIDE_H) * 100}%">
        <span class="dk-grip" data-g="nw"></span><span class="dk-grip" data-g="ne"></span><span class="dk-grip" data-g="sw"></span><span class="dk-grip" data-g="se"></span></div>`;
      $$('.dk-grip', c).forEach((g) => { g.onpointerdown = (ev) => { ev.stopPropagation(); startElDrag(ev, 'resize', g.dataset.g); }; });
      $('.dk-selbox', c).onpointerdown = (ev) => { ev.stopPropagation(); startElDrag(ev, 'move'); };
    }
  }
  // A deck whose slide is being edited shows the frame outline, not a
  // second box around the whole deck.
  const items = selItems().filter((it) => isBox(it) && it.kind !== 'deck');
  if (!items.length) return;
  const single = items.length === 1 ? items[0] : null;
  chrome.innerHTML = items.map((it) => `<div class="wb-selbox ${single ? '' : 'multi'}" data-selbox="${it.id}" style="left:${it.x}px;top:${it.y}px;width:${it.w}px;height:${it.h}px">
    ${single && !it.locked && it.kind !== 'deck' ? '<span class="dk-grip" data-g="nw"></span><span class="dk-grip" data-g="ne"></span><span class="dk-grip" data-g="sw"></span><span class="dk-grip" data-g="se"></span>' : ''}
  </div>`).join('') + (single ? '' : (() => { const u = union(items); return `<div class="wb-selunion" style="left:${u.x}px;top:${u.y}px;width:${u.w}px;height:${u.h}px"></div>`; })());
  $$('.dk-grip', chrome).forEach((g) => { g.onpointerdown = (ev) => { ev.stopPropagation(); startItemDrag(ev, 'resize', g.dataset.g); }; });
  $$('.wb-selbox', chrome).forEach((b) => { b.onpointerdown = (ev) => { if (ev.button !== 0) return; ev.stopPropagation(); startItemDrag(ev, 'move'); }; });
}

// ------------------------------------------------------------- selection

function select(ids, add = false) {
  if (!add) ed.sel = new Set();
  for (const id of ids) { if (add && ed.sel.has(id)) ed.sel.delete(id); else ed.sel.add(id); }
  if (ids.length && !ids.every((id) => item(id)?.kind === 'deck')) ed.ssel = ed.ssel && ed.sel.has(ed.ssel.deck) ? ed.ssel : null;
  paintChrome(); paintPanel(); paintConns();
}
function clearSel() { ed.sel = new Set(); ed.ssel = ed.ssel ? { ...ed.ssel, el: null } : null; paintChrome(); paintPanel(); paintConns(); }
function selectSlide(deckId, i, elId = null) {
  ed.ssel = { deck: deckId, i, el: elId };
  ed.focus = deckId;
  ed.sel = new Set([deckId]);
  $$('.dk-frame').forEach((f) => { const d = f.closest('.wb-deck')?.dataset.item; f.classList.toggle('on', d === deckId && +f.dataset.i === i); });
  paintChrome(); paintPanel(); paintNotes(); paintConns();
}

// ------------------------------------------------------------- pointers (board)

function onBoardDown(e) {
  if (e.button === 1 || ed.space || ed.tool === 'hand') { startPan(e); return; }
  if (e.button !== 0) return;
  const p = boardPoint(e);
  const target = e.target;
  if (ed.place) { placeOnBoard(p); return; }
  const tool = ed.tool;
  if (tool === 'sticky' || tool === 'text' || tool === 'section' || tool === 'shape' || tool === 'deck') { startCreate(e, p); return; }
  if (tool === 'pen') { startPen(e, p); return; }
  if (tool === 'connector') { startConnector(e, target); return; }
  // Select tool.
  const node = target.closest('.wb-item');
  if (!node) { clearSel(); startMarquee(e); return; }
  const it = item(node.dataset.item);
  if (!it) return;
  if (it.kind === 'deck') {
    // Anything on a deck that is not a stage, head, tab or grip: select it.
    ed.ssel = null;
    select([it.id], e.shiftKey);
    return;
  }
  if (!ed.sel.has(it.id)) select([it.id], e.shiftKey);
  else if (e.shiftKey) { select([it.id], true); return; }
  if (!it.locked) startItemDrag(e, 'move');
}

function startPan(e) {
  ed.drag = { mode: 'pan', sx: e.clientX, sy: e.clientY, ox: ed.bd.x, oy: ed.bd.y };
  $('#dkBoard').classList.add('is-panning');
  e.preventDefault();
}

function startMarquee(e) {
  const p = boardPoint(e);
  ed.drag = { mode: 'marquee', sx: p.x, sy: p.y, moved: false };
}

function startItemDrag(e, mode, grip) {
  const items = selItems().filter((i) => isBox(i) && !i.locked);
  if (!items.length) return;
  const p = boardPoint(e);
  // A section drags what sits inside it.
  const carried = [];
  for (const s of items) if (s.kind === 'section') {
    for (const it of ed.board.items) if (isBox(it) && it.kind !== 'section' && !ed.sel.has(it.id) && inside(it, s)) carried.push(it);
  }
  ed.drag = {
    mode: mode === 'move' ? 'items' : 'resize', grip, sx: p.x, sy: p.y, moved: false,
    start: [...items, ...carried].map((it) => ({ it, x: it.x, y: it.y, w: it.w, h: it.h, pts: it.points ? it.points.map((q) => [...q]) : null })),
  };
  e.preventDefault();
}
const inside = (it, s) => it.x + it.w / 2 >= s.x && it.x + it.w / 2 <= s.x + s.w && it.y + it.h / 2 >= s.y && it.y + it.h / 2 <= s.y + s.h;

function startCreate(e, p) {
  ed.drag = { mode: 'create', sx: p.x, sy: p.y, moved: false };
  e.preventDefault();
}

function startPen(e, p) {
  const s = settings();
  const it = newPen({ x: p.x, y: p.y, points: [[0, 0]], color: ed.prefs.penColor || s.penColor, width: ed.prefs.penWidth || s.penWidth });
  ed.board.items.push(it);
  const canvas = $('#dkCanvas');
  const chrome = $('#dkChrome');
  chrome.insertAdjacentHTML('beforebegin', itemHtml(it));
  ed.drag = { mode: 'pen', it, node: $(`.wb-item[data-item="${it.id}"]`, canvas), minx: 0, miny: 0, maxx: 0, maxy: 0 };
  e.preventDefault();
}

function startConnector(e, target) {
  const node = target.closest('.wb-item');
  if (!node) return;
  const from = item(node.dataset.item);
  const p = boardPoint(e);
  const svg = $('#dkConns');
  svg.insertAdjacentHTML('beforeend', `<path id="dkConnDraft" d="M${p.x} ${p.y} L${p.x} ${p.y}" stroke="#3392ff" stroke-width="3" stroke-dasharray="8 6" fill="none"/>`);
  ed.drag = { mode: 'conn', from, sx: p.x, sy: p.y };
  e.preventDefault();
}

function onPointerMove(e) {
  if (!ed || !ed.drag) return;
  const d = ed.drag;
  if (d.mode === 'pan') { ed.bd.x = d.ox + (e.clientX - d.sx); ed.bd.y = d.oy + (e.clientY - d.sy); applyTransform(); return; }
  if (d.mode === 'el') { moveEl(e); return; }
  if (d.mode === 'slide') { moveSlideDrag(e); return; }
  if (!$('#dkBoard')) return;
  const p = boardPoint(e);
  const dx = p.x - d.sx; const dy = p.y - d.sy;
  if (Math.abs(dx) + Math.abs(dy) > 2 / ed.bd.z) d.moved = true;
  if (d.mode === 'marquee') {
    const m = $('#dkMarquee');
    const r = $('#dkBoard').getBoundingClientRect();
    const x1 = Math.min(d.sx, p.x); const y1 = Math.min(d.sy, p.y); const w = Math.abs(dx); const h = Math.abs(dy);
    m.hidden = !d.moved;
    Object.assign(m.style, { left: `${x1 * ed.bd.z + ed.bd.x}px`, top: `${y1 * ed.bd.z + ed.bd.y}px`, width: `${w * ed.bd.z}px`, height: `${h * ed.bd.z}px` });
    d.rect = { x: x1, y: y1, w, h };
    void r;
    return;
  }
  if (d.mode === 'items') {
    const sdx = settings().snap ? snapV(d.start[0].x + dx) - d.start[0].x : Math.round(dx);
    const sdy = settings().snap ? snapV(d.start[0].y + dy) - d.start[0].y : Math.round(dy);
    for (const s of d.start) { s.it.x = s.x + sdx; s.it.y = s.y + sdy; placeNode(s.it); }
    paintChrome(); paintConns();
    return;
  }
  if (d.mode === 'resize') {
    const s = d.start[0]; const it = s.it; const g = d.grip;
    let { x, y, w, h } = s;
    if (g.includes('e')) w = Math.max(24, s.w + dx);
    if (g.includes('s')) h = Math.max(24, s.h + dy);
    if (g.includes('w')) { w = Math.max(24, s.w - dx); x = s.x + (s.w - w); }
    if (g.includes('n')) { h = Math.max(24, s.h - dy); y = s.y + (s.h - h); }
    it.x = Math.round(x); it.y = Math.round(y); it.w = Math.round(w); it.h = Math.round(h);
    if (it.kind === 'pen' && s.pts) it.points = s.pts.map(([px, py]) => [px * (w / s.w), py * (h / s.h)]);
    placeNode(it, true);
    paintChrome(); paintConns();
    return;
  }
  if (d.mode === 'create') {
    let m = $('#dkMarquee');
    m.hidden = !d.moved;
    const x1 = Math.min(d.sx, p.x); const y1 = Math.min(d.sy, p.y);
    Object.assign(m.style, { left: `${x1 * ed.bd.z + ed.bd.x}px`, top: `${y1 * ed.bd.z + ed.bd.y}px`, width: `${Math.abs(dx) * ed.bd.z}px`, height: `${Math.abs(dy) * ed.bd.z}px` });
    d.rect = { x: x1, y: y1, w: Math.abs(dx), h: Math.abs(dy) };
    return;
  }
  if (d.mode === 'pen') {
    const it = d.it;
    const lx = p.x - it.x; const ly = p.y - it.y;
    it.points.push([lx, ly]);
    d.minx = Math.min(d.minx, lx); d.miny = Math.min(d.miny, ly); d.maxx = Math.max(d.maxx, lx); d.maxy = Math.max(d.maxy, ly);
    const path = $('path', d.node);
    path.setAttribute('d', it.points.map((q, i) => `${i ? 'L' : 'M'}${q[0]} ${q[1]}`).join(' '));
    return;
  }
  if (d.mode === 'conn') {
    const draft = $('#dkConnDraft'); if (draft) draft.setAttribute('d', `M${d.sx} ${d.sy} L${p.x} ${p.y}`);
  }
}

function placeNode(it, resized = false) {
  const n = $(`.wb-item[data-item="${it.id}"]`, $('#dkCanvas'));
  if (!n) return;
  n.style.left = `${it.x}px`; n.style.top = `${it.y}px`;
  if (resized) {
    n.style.width = `${it.w}px`; n.style.height = `${it.h}px`;
    if (it.kind === 'pen') { const svg = $('svg', n); svg.setAttribute('width', it.w); svg.setAttribute('height', it.h); svg.setAttribute('viewBox', `0 0 ${it.w} ${it.h}`); $('path', svg).setAttribute('d', it.points.map((q, i) => `${i ? 'L' : 'M'}${q[0]} ${q[1]}`).join(' ')); }
  }
}

function onPointerUp(e) {
  if (!ed || !ed.drag) return;
  const d = ed.drag;
  ed.drag = null;
  if (d.mode === 'pan') { $('#dkBoard')?.classList.remove('is-panning'); return; }
  if (d.mode === 'el') { if (d.moved) { commit(); paintPanel(); paintRailSoon(); } return; }
  if (d.mode === 'slide') { endSlideDrag(d); return; }
  if (d.mode === 'marquee') {
    const m = $('#dkMarquee'); if (m) m.hidden = true;
    if (d.moved && d.rect) {
      const r = d.rect;
      const hit = ed.board.items.filter((it) => isBox(it) && it.x < r.x + r.w && it.x + it.w > r.x && it.y < r.y + r.h && it.y + it.h > r.y).map((it) => it.id);
      select(hit, e.shiftKey);
    }
    return;
  }
  if (d.mode === 'items' || d.mode === 'resize') { if (d.moved) commit(); paintPanel(); return; }
  if (d.mode === 'create') {
    const m = $('#dkMarquee'); if (m) m.hidden = true;
    const r = d.moved && d.rect && d.rect.w > 12 ? d.rect : null;
    createAt(ed.tool, r ? r.x : d.sx, r ? r.y : d.sy, r);
    return;
  }
  if (d.mode === 'pen') {
    const it = d.it;
    if (it.points.length < 2) { ed.board.items = ed.board.items.filter((x) => x !== it); paintBoard(); return; }
    // Normalize the bbox so the item's box is the stroke's extent.
    const pad = it.width;
    const ox = d.minx - pad; const oy = d.miny - pad;
    it.x += ox; it.y += oy;
    it.points = it.points.map(([px, py]) => [px - ox, py - oy]);
    it.w = Math.max(1, d.maxx - d.minx + pad * 2); it.h = Math.max(1, d.maxy - d.miny + pad * 2);
    commit(); paintBoard();
    return;
  }
  if (d.mode === 'conn') {
    $('#dkConnDraft')?.remove();
    const node = document.elementFromPoint(e.clientX, e.clientY)?.closest('.wb-item');
    const to = node ? item(node.dataset.item) : null;
    if (to && to.id !== d.from.id) {
      const c = newConnector(d.from.id, to.id, { color: ed.prefs.penColor || settings().penColor });
      ed.board.items.push(c);
      commit(); paintConns(); select([c.id]);
    }
  }
}

function createAt(tool, x, y, rect) {
  const s = settings();
  let it = null;
  const sx = snapV(x); const sy = snapV(y);
  if (tool === 'sticky') it = newSticky({ x: sx, y: sy, color: ed.prefs.stickyColor || s.stickyColor, ...(rect ? { w: Math.round(rect.w), h: Math.round(rect.h) } : {}) });
  else if (tool === 'text') it = newBoardText({ x: sx, y: sy, ...(rect ? { w: Math.round(rect.w), h: Math.round(rect.h) } : {}) });
  else if (tool === 'section') it = newSection({ x: sx, y: sy, ...(rect ? { w: Math.round(rect.w), h: Math.round(rect.h) } : {}) });
  else if (tool === 'shape') it = newBoardShape(ed.shape || 'rect', { x: sx, y: sy, ...(rect ? { w: Math.round(rect.w), h: Math.round(rect.h) } : {}) });
  else if (tool === 'deck') it = newDeckItem(newDeck('Untitled Deck'), { x: sx, y: sy });
  if (!it) return;
  if (it.kind === 'section') ed.board.items.unshift(it); else ed.board.items.push(it);
  commit(); paintBoard();
  select([it.id]);
  if (it.kind === 'sticky' || it.kind === 'text') editItemText(it);
  if (it.kind === 'deck') selectSlide(it.id, 0);
  if (tool !== 'shape' && tool !== 'sticky') armTool('select');
}

function placeOnBoard(p) {
  const pl = ed.place;
  let it = null;
  if (pl.kind === 'image') it = newBoardImage(pl.asset, { x: snapV(p.x - 240), y: snapV(p.y - 150) });
  if (pl.kind === 'video') it = newBoardVideo(pl.asset, { x: snapV(p.x - 320), y: snapV(p.y - 180) });
  if (pl.kind === 'diagram') it = newBoardDiagram(pl.drill, { x: snapV(p.x - 320), y: snapV(p.y - 160) });
  if (pl.kind === 'text') it = newBoardText({ x: snapV(p.x), y: snapV(p.y) });
  if (pl.kind === 'shape') it = newBoardShape(pl.shape, { x: snapV(p.x - 120), y: snapV(p.y - 80) });
  if (!it) { armTool('select'); return; }
  ed.board.items.push(it);
  armTool('select');
  commit(); paintBoard(); select([it.id]);
}

function onBoardDblClick(e) {
  const node = e.target.closest('.wb-item');
  if (!node) { fitToContent(); return; }
  const it = item(node.dataset.item);
  if (!it || it.locked) return;
  if (e.target.closest('[data-decktab]')) { renameDeck(it, e.target.closest('[data-decktab]')); return; }
  if (it.kind === 'sticky' || it.kind === 'text' || it.kind === 'shape' || it.kind === 'section') editItemText(it);
}

function editItemText(it) {
  const node = $(`.wb-item[data-item="${it.id}"]`, $('#dkCanvas'));
  if (!node) return;
  let body = $('.wb-sticky-text, .wb-text-body, .wb-shape-label, .wb-section-title', node);
  if (!body && it.kind === 'shape') { node.insertAdjacentHTML('beforeend', '<div class="wb-shape-label"></div>'); body = $('.wb-shape-label', node); }
  if (!body) return;
  body.contentEditable = 'plaintext-only';
  body.focus();
  const range = document.createRange(); range.selectNodeContents(body); range.collapse(false);
  const s = getSelection(); s.removeAllRanges(); s.addRange(range);
  const done = () => {
    body.contentEditable = 'false';
    const v = body.innerText.replace(/\n$/, '');
    if (it.kind === 'section') it.title = v; else it.text = v;
    commit(); paintBoard(); paintChrome(); paintPanel();
  };
  body.onblur = done;
  body.onkeydown = (ev) => { ev.stopPropagation(); if (ev.key === 'Escape' || (ev.key === 'Enter' && !ev.shiftKey && it.kind !== 'sticky' && it.kind !== 'text')) { ev.preventDefault(); body.blur(); } };
}

function renameDeck(it, nameEl) {
  nameEl.contentEditable = 'plaintext-only'; nameEl.focus();
  const done = () => { nameEl.contentEditable = 'false'; it.name = nameEl.innerText.trim() || 'Untitled Deck'; commit(); paintBoard(); };
  nameEl.onblur = done;
  nameEl.onkeydown = (ev) => { ev.stopPropagation(); if (ev.key === 'Enter' || ev.key === 'Escape') { ev.preventDefault(); nameEl.blur(); } };
}

function onBoardContext(e) {
  const node = e.target.closest('.wb-item');
  e.preventDefault();
  if (!node) { menuAt(e, [
    { label: 'Paste Here', run: () => pasteAt(boardPoint(e)) },
    { label: 'Zoom to Fit', run: fitToContent },
    { label: 'Board Settings…', run: openSettingsSheet },
  ]); return; }
  const it = item(node.dataset.item);
  if (!ed.sel.has(it.id)) select([it.id]);
  itemMenu(e, it);
}

function itemMenu(e, it) {
  const many = ed.sel.size > 1;
  const items = [
    { label: 'Duplicate', run: duplicateSel },
    { label: 'Copy', run: copySel },
    '-',
    { label: 'Bring to Front', run: () => reorder('front') },
    { label: 'Bring Forward', run: () => reorder('up') },
    { label: 'Send Backward', run: () => reorder('down') },
    { label: 'Send to Back', run: () => reorder('back') },
    '-',
    { label: it.locked ? 'Unlock' : 'Lock', run: () => { for (const s of selItems()) s.locked = !it.locked; commit(); paintBoard(); paintChrome(); } },
  ];
  if (it.kind === 'deck' && !many) items.push('-', { label: 'New Slide', run: (ev) => layoutMenu(ev || e, it) }, { label: 'Open in Slide View', run: () => setView('slide', it.id) }, { label: 'Present', run: () => presentDeck(it) });
  items.push('-', { label: 'Delete', run: deleteSel });
  menuAt(e, items);
}

function reorder(how) {
  const ids = ed.sel;
  const arr = ed.board.items;
  const picked = arr.filter((i) => ids.has(i.id));
  const rest = arr.filter((i) => !ids.has(i.id));
  if (how === 'front') ed.board.items = [...rest, ...picked];
  else if (how === 'back') ed.board.items = [...picked, ...rest];
  else {
    for (const it of picked) {
      const i = arr.indexOf(it);
      const j = how === 'up' ? Math.min(arr.length - 1, i + 1) : Math.max(0, i - 1);
      arr.splice(i, 1); arr.splice(j, 0, it);
    }
  }
  commit(); paintBoard(); paintChrome();
}

function deleteSel() {
  if (!ed.sel.size) return;
  const ids = ed.sel;
  ed.board.items = ed.board.items.filter((i) => !ids.has(i.id) && !(i.kind === 'connector' && (ids.has(i.from) || ids.has(i.to))));
  ed.sel = new Set(); ed.ssel = null;
  commit(); paintBoard(); paintPanel();
}

let clipboard = null;
function copySel() { clipboard = JSON.parse(JSON.stringify(selItems().filter(isBox))); }
function pasteAt(p) {
  if (!clipboard || !clipboard.length) return;
  const u = union(clipboard);
  const ids = [];
  for (const src of clipboard) {
    const c = JSON.parse(JSON.stringify(src)); c.id = uid();
    if (c.kind === 'deck') { c.slides.forEach((s) => { s.id = uid(); s.els.forEach((x) => { x.id = uid(); }); }); }
    c.x = p ? p.x + (src.x - u.x) : src.x + 40; c.y = p ? p.y + (src.y - u.y) : src.y + 40;
    ed.board.items.push(c); ids.push(c.id);
  }
  commit(); paintBoard(); select(ids);
}
function duplicateSel() { copySel(); pasteAt(null); }

// ------------------------------------------------------------- pointers (slides)

function stagePoint(e, stage) {
  const r = stage.getBoundingClientRect();
  return { x: ((e.clientX - r.left) / r.width) * SLIDE_W, y: ((e.clientY - r.top) / r.height) * SLIDE_H };
}
function currentStage() {
  if (!ed.ssel) return null;
  return $(`.wb-deck[data-item="${ed.ssel.deck}"] .dk-frame[data-i="${ed.ssel.i}"] .dk-stage`) || $('.dk-stagebox > .dk-stage');
}

function onStageDown(e) {
  if (e.button !== 0 || ed.space || ed.tool === 'hand') return;
  const stage = e.currentTarget;
  const frame = stage.closest('.dk-frame');
  const deckNode = stage.closest('.wb-deck');
  const deckId = deckNode ? deckNode.dataset.item : ed.focus;
  const i = frame ? +frame.dataset.i : ed.ssel.i;
  const d = item(deckId);
  if (d?.locked) return;
  // Board tools other than select and placements fall through to the board.
  if (ed.tool !== 'select' && !ed.place) return;
  e.stopPropagation();
  const p = stagePoint(e, stage);
  if (ed.place) { placeInSlide(d, i, p); return; }
  const elNode = e.target.closest('.dk-el');
  selectSlide(deckId, i, elNode ? elNode.dataset.el : null);
  if (elNode) startElDrag(e, 'move');
}

function placeInSlide(d, i, p) {
  const pl = ed.place; const s = d.slides[i];
  let el = null;
  if (pl.kind === 'text') el = newText(pl.role, { x: p.x, y: p.y - 40 });
  else if (pl.kind === 'shape') el = newShape(pl.shape, { x: p.x - 200, y: p.y - 120, ...(pl.shape === 'line' || pl.shape === 'arrow' ? { w: 400, h: 40, y: p.y - 20 } : {}) });
  else if (pl.kind === 'image') el = newImage(pl.asset, { x: p.x - 400, y: p.y - 250 });
  else if (pl.kind === 'video') el = newVideo(pl.asset, { x: p.x - 560, y: p.y - 315 });
  else if (pl.kind === 'diagram') el = newDiagram(pl.drill, { x: p.x - 480, y: p.y - 240 });
  if (!el) return;
  el.x = clamp(el.x, 0, SLIDE_W - el.w); el.y = clamp(el.y, 0, SLIDE_H - el.h);
  s.els.push(el);
  armTool('select');
  commit();
  repaintDeck(d); selectSlide(d.id, i, el.id); paintRailSoon();
}

function startElDrag(e, mode, grip) {
  const el = selEl(); const stage = currentStage();
  if (!el || !stage) return;
  const p = stagePoint(e, stage);
  ed.drag = { mode: 'el', sub: mode, grip, stage, sx: p.x, sy: p.y, ox: el.x, oy: el.y, ow: el.w, oh: el.h, moved: false };
  e.preventDefault();
}

function moveEl(e) {
  const d = ed.drag; const el = selEl();
  if (!el) { ed.drag = null; return; }
  const p = stagePoint(e, d.stage);
  const dx = p.x - d.sx; const dy = p.y - d.sy;
  if (Math.abs(dx) + Math.abs(dy) > 2) d.moved = true;
  if (d.sub === 'move') { el.x = Math.round(d.ox + dx); el.y = Math.round(d.oy + dy); }
  else {
    const g = d.grip; let { ox: x, oy: y, ow: w, oh: h } = d;
    if (g.includes('e')) w = Math.max(24, d.ow + dx);
    if (g.includes('s')) h = Math.max(24, d.oh + dy);
    if (g.includes('w')) { w = Math.max(24, d.ow - dx); x = d.ox + (d.ow - w); }
    if (g.includes('n')) { h = Math.max(24, d.oh - dy); y = d.oy + (d.oh - h); }
    el.x = Math.round(x); el.y = Math.round(y); el.w = Math.round(w); el.h = Math.round(h);
  }
  const node = $(`.dk-el[data-el="${el.id}"]`, d.stage);
  if (node) { node.style.left = `${(el.x / SLIDE_W) * 100}%`; node.style.top = `${(el.y / SLIDE_H) * 100}%`; node.style.width = `${(el.w / SLIDE_W) * 100}%`; node.style.height = `${(el.h / SLIDE_H) * 100}%`; }
  paintChrome();
}

// Re-render one deck in place on the board (or the focused stage).
function repaintDeck(d) {
  if (ed.view === 'slide') { paintSlideStage(); return; }
  const node = $(`.wb-deck[data-item="${d.id}"]`, $('#dkCanvas'));
  if (!node) { paintBoard(); return; }
  d.w = deckWidth(d); d.h = deckHeight();
  node.outerHTML = deckHtml(d, ed.ssel?.deck === d.id ? ed.ssel.i : -1);
  const fresh = $(`.wb-deck[data-item="${d.id}"]`, $('#dkCanvas'));
  hydrate(fresh);
  wireDeck(fresh, d);
  paintConns(); paintChrome();
}

function onStageDblClick(e) {
  const node = e.target.closest('.dk-el-text');
  if (!node) return;
  const stage = node.closest('.dk-stage');
  const frame = stage.closest('.dk-frame'); const deckNode = stage.closest('.wb-deck');
  const deckId = deckNode ? deckNode.dataset.item : ed.focus; const i = frame ? +frame.dataset.i : ed.ssel.i;
  const d = item(deckId); const el = d.slides[i].els.find((x) => x.id === node.dataset.el);
  if (!el || d.locked) return;
  e.stopPropagation();
  selectSlide(deckId, i, el.id);
  editSlideText(node, d, i, el);
}

function editSlideText(node, d, i, el) {
  if (node.isContentEditable) return;
  node.contentEditable = 'plaintext-only'; node.focus();
  const range = document.createRange(); range.selectNodeContents(node);
  const s = getSelection(); s.removeAllRanges(); s.addRange(range);
  let finished = false;
  const done = () => {
    if (finished) return; finished = true;
    node.contentEditable = 'false';
    el.text = node.innerText.replace(/\n$/, '');
    commit(); repaintDeck(d); selectSlide(d.id, i, el.id); paintRailSoon();
  };
  node.onblur = done;
  node.onkeydown = (ev) => { ev.stopPropagation(); if (ev.key === 'Escape') { ev.preventDefault(); node.blur(); } };
}

// ------------------------------------------------------------- toolbar + tools

const TOOLS = [
  { id: 'select', tip: 'Select (V)', icon: () => I.cursor, board: true },
  { id: 'hand', tip: 'Hand (H)', icon: () => I.hand, board: true },
  { id: 'sticky', tip: 'Sticky note (S)', icon: () => I.sticky, board: true },
  { id: 'text', tip: 'Text (T)', icon: () => I.text, menu: (e) => textMenu(e) },
  { id: 'shape', tip: 'Shapes (R)', icon: () => I.shapes, menu: (e) => shapeMenu(e) },
  { id: 'pen', tip: 'Pen (P)', icon: () => I.pen, board: true },
  { id: 'connector', tip: 'Connector (C)', icon: () => I.connector, board: true },
  { id: 'section', tip: 'Section (F)', icon: () => I.section, board: true },
  { id: 'image', tip: 'Image', icon: () => I.image, pick: () => pickMedia('image') },
  { id: 'video', tip: 'Video', icon: () => I.video, pick: () => pickMedia('video') },
  { id: 'diagram', tip: 'Rink diagram', icon: () => I.rink, pick: openDrillPicker },
  { id: 'deck', tip: 'New deck (D)', icon: () => I.deck, board: true },
];

function paintTools() {
  const bar = $('#dkTools'); if (!bar) return;
  const list = ed.view === 'slide' ? TOOLS.filter((t) => ['select', 'text', 'shape', 'image', 'video', 'diagram'].includes(t.id)) : TOOLS;
  bar.innerHTML = list.map((t) => `<button class="dk-tool ${ed.tool === t.id ? 'on' : ''}" data-tool="${t.id}" data-tip="${t.tip}" aria-label="${t.tip}" aria-pressed="${ed.tool === t.id}">${t.icon()}</button>`).join('');
  $$('.dk-tool', bar).forEach((b) => {
    const t = TOOLS.find((x) => x.id === b.dataset.tool);
    b.onclick = (e) => { if (t.menu) { t.menu(e); return; } if (t.pick) { t.pick(); return; } armTool(t.id); };
  });
}

function armTool(id, place = null) {
  ed.tool = id; ed.place = place;
  if ((place || id !== 'select') && (ed.sel.size || ed.ssel?.el)) { ed.sel = new Set(); if (ed.ssel) ed.ssel.el = null; paintChrome(); }
  paintTools();
  const bar = $('#dkPlace');
  if (bar) { bar.hidden = !place; if (place) bar.textContent = place.hint; }
  $('#dkBoard')?.classList.toggle('is-hand', id === 'hand');
  $('#dkBoard')?.classList.toggle('is-draw', ['pen', 'sticky', 'text', 'section', 'shape', 'deck', 'connector'].includes(id) || !!place);
}

// ------------------------------------------------------------- menus

function menuAt(e, items) {
  closeMenu();
  const m = document.createElement('div');
  m.className = 'menu'; m.setAttribute('role', 'menu');
  m.innerHTML = items.map((it, i) => (it === '-' ? '<div class="menu-sep"></div>' : `<button class="menu-item" role="menuitem" data-i="${i}">${esc(it.label)}</button>`)).join('');
  document.body.appendChild(m);
  const r = (e.currentTarget || e.target)?.getBoundingClientRect?.() || { left: e.clientX, bottom: e.clientY };
  const x = Math.min(e.clientX || r.left, innerWidth - 240);
  const y = Math.min((e.clientY || r.bottom) + 4, innerHeight - m.offsetHeight - 8);
  m.style.left = `${x}px`; m.style.top = `${y}px`;
  $$('.menu-item', m).forEach((b) => { b.onclick = (ev) => { const it = items[+b.dataset.i]; closeMenu(); it.run(ev); }; });
  $('.menu-item', m)?.focus();
  setTimeout(() => document.addEventListener('pointerdown', menuAway, { once: true }));
}
function menuAway(e) { if (!e.target.closest('.menu')) closeMenu(); else setTimeout(() => document.addEventListener('pointerdown', menuAway, { once: true })); }
function closeMenu() { $$('.menu').forEach((m) => m.remove()); }

function textMenu(e) {
  const d = deckOf() || focusDeck();
  const roles = d ? Object.entries(d.theme.styles) : [];
  menuAt(e, [
    { label: 'Board Text', run: () => armTool('text', { kind: 'text', hint: 'Click the board to place text' }) },
    ...(roles.length ? ['-'] : []),
    ...roles.map(([role, st]) => ({ label: `Slide: ${st.label || role}`, run: () => armTool('text', { kind: 'text', role, hint: 'Click a slide to place the text' }) })),
  ]);
}

function shapeMenu(e) {
  const mk = (shape, label) => ({ label, run: () => { ed.shape = shape; armTool('shape', { kind: 'shape', shape, hint: `Click a slide or the board to place ${label.toLowerCase()}` }); } });
  menuAt(e, [mk('rect', 'Rectangle'), mk('ellipse', 'Ellipse'), mk('diamond', 'Diamond'), mk('line', 'Line'), mk('arrow', 'Arrow')]);
}

function layoutMenu(e, d) {
  menuAt(e, Object.entries(LAYOUTS).map(([k, v]) => ({
    label: v.label,
    run: () => {
      const at = ed.ssel?.deck === d.id ? ed.ssel.i + 1 : d.slides.length;
      d.slides.splice(at, 0, newSlide(k));
      commit(); repaintDeck(d); selectSlide(d.id, at); paintRail();
    },
  })));
}

function slideMenu(e, d, i) {
  const s = d.slides[i];
  menuAt(e, [
    { label: 'Duplicate Slide', run: () => { const c = JSON.parse(JSON.stringify(s)); c.id = uid(); c.els.forEach((x) => { x.id = uid(); }); d.slides.splice(i + 1, 0, c); commit(); repaintDeck(d); paintRail(); } },
    { label: s.skip ? 'Include in Present' : 'Skip Slide', run: () => { s.skip = !s.skip; commit(); repaintDeck(d); paintRail(); } },
    '-',
    { label: 'Delete Slide', run: () => deleteSlide(d, i) },
  ]);
}

function deleteSlide(d, i) {
  if (!d || d.slides.length <= 1) return;
  d.slides.splice(i, 1);
  const at = Math.min(i, d.slides.length - 1);
  commit(); repaintDeck(d); selectSlide(d.id, at); if (ed.view === 'slide') paintRail();
}

// ------------------------------------------------------------- media in

function pickMedia(kind) {
  const inp = document.createElement('input');
  inp.type = 'file'; inp.accept = kind === 'image' ? 'image/*' : 'video/*';
  inp.onchange = async () => {
    const f = inp.files && inp.files[0]; if (!f) return;
    const id = uid(); await putAsset(id, f);
    armTool(kind, { kind, asset: id, hint: `Click a slide or the board to place ${f.name}` });
  };
  inp.click();
}

async function openDrillPicker() {
  const drills = await listDrills();
  const host = $('#dkSheet');
  if (!drills.length) host.innerHTML = sheetHtml('Rink Diagrams', '<p class="dk-empty">No saved diagrams yet. Draw one in the Diagrams app and it will appear here.</p>');
  else {
    host.innerHTML = sheetHtml('Rink Diagrams', `<div class="dk-drills">${drills.map((d) => `
      <button class="dk-drill" data-id="${esc(d.id)}">${d.thumb ? `<img src="${esc(d.thumb)}" alt="" decoding="async">` : '<span class="dk-drill-blank" aria-hidden="true"></span>'}<span>${esc(d.name || 'Untitled')}</span></button>`).join('')}</div>`);
    $$('.dk-drill', host).forEach((b) => { b.onclick = () => { closeSheet(); armTool('diagram', { kind: 'diagram', drill: b.dataset.id, hint: 'Click a slide or the board to place the diagram' }); }; });
  }
  wireSheet();
}

// ------------------------------------------------------------- panel

function paintPanel() {
  const host = $('#dkPanel'); const tabs = $('#dkTabs');
  if (!host) return;
  const el = selEl(); const s = slideOf();
  const slideLevel = !!(ed.ssel && (el || ed.view === 'slide' || (ed.sel.size === 1 && deckOf() && ed.sel.has(deckOf().id))));
  tabs.innerHTML = slideLevel ? `<button class="tab ${ed.tab === 'design' ? 'on' : ''}" data-tab="design">Design</button><button class="tab ${ed.tab === 'animate' ? 'on' : ''}" data-tab="animate">Animate</button>` : '';
  $$('.tab', tabs).forEach((t) => { t.onclick = () => { ed.tab = t.dataset.tab; paintPanel(); }; });
  if (slideLevel && ed.tab === 'animate') { paintAnimate(host); return; }
  if (el) { host.innerHTML = elPanelHtml(el); wireElPanel(host, el); return; }
  const items = selItems();
  if (items.length > 1) { host.innerHTML = multiPanelHtml(items); wireMultiPanel(host); return; }
  if (items.length === 1 && items[0].kind !== 'deck') { host.innerHTML = itemPanelHtml(items[0]); wireItemPanel(host, items[0]); return; }
  if (s) { host.innerHTML = slidePanelHtml(deckOf(), s); wireSlidePanel(host, deckOf(), s); return; }
  host.innerHTML = boardPanelHtml();
  wireBoardPanel(host);
}

const field = (label, inner) => `<label class="fld"><span>${label}</span>${inner}</label>`;
const swatches = (colors, value, extra = true) => `<div class="dk-colors">${colors.map((c) => `<button class="dk-swatch ${c === value ? 'on' : ''}" data-c="${c}" style="background:${c}" aria-label="${c}"></button>`).join('')}${extra ? `<input type="color" class="dk-cwell" value="${/^#[0-9a-f]{6}$/i.test(value || '') ? value : '#0a0a0a'}" aria-label="Custom color">` : ''}</div>`;
const colorRow = (value) => swatches(deckOf()?.theme?.colors || DEFAULT_BOARD_COLORS, value);
const DEFAULT_BOARD_COLORS = ['#0a0a0a', '#404040', '#737373', '#a3a3a3', '#ffffff', '#75d8ff', '#16a34a', '#dc2626'];

function wireColors(host, apply) {
  $$('.dk-colors', host).forEach((row) => {
    $$('.dk-swatch', row).forEach((b) => { b.onclick = () => apply(b.dataset.c); });
    const w = $('.dk-cwell', row); if (w) w.oninput = (e) => apply(e.target.value);
  });
}

function boardPanelHtml() {
  const b = ed.board; const n = (k) => b.items.filter((i) => i.kind === k).length;
  return `<div class="dk-sect"><h3>Board</h3>
    <p class="dk-hint">${b.items.length} object${b.items.length === 1 ? '' : 's'}: ${n('deck')} deck${n('deck') === 1 ? '' : 's'}, ${n('sticky')} stick${n('sticky') === 1 ? 'y' : 'ies'}, ${n('shape')} shape${n('shape') === 1 ? '' : 's'}, ${n('connector')} connector${n('connector') === 1 ? '' : 's'}.</p>
    <div class="dk-btnrow"><button class="btn btn-outline btn-sm" id="dkFit">Zoom to Fit</button><button class="btn btn-outline btn-sm" id="dkOpenSettings">Settings</button></div>
    <h3>Shortcuts</h3>
    <dl class="dk-keys">
      <dt>V H S T R P C F D</dt><dd>Tools</dd>
      <dt>Space + drag</dt><dd>Pan</dd>
      <dt>⌘ + scroll</dt><dd>Zoom</dd>
      <dt>⌘Z / ⇧⌘Z</dt><dd>Undo / redo</dd>
      <dt>⌘D</dt><dd>Duplicate</dd>
      <dt>[ ]</dt><dd>Send back / bring forward</dd>
      <dt>⌘0</dt><dd>Zoom to fit</dd>
    </dl>
  </div>`;
}
function wireBoardPanel(host) {
  $('#dkFit', host).onclick = fitToContent;
  $('#dkOpenSettings', host).onclick = openSettingsSheet;
}

function itemPanelHtml(it) {
  const head = { sticky: 'Sticky Note', text: 'Text', shape: 'Shape', pen: 'Pen Stroke', section: 'Section', image: 'Image', video: 'Video', diagram: 'Rink Diagram', connector: 'Connector' }[it.kind] || 'Object';
  let body = '';
  if (it.kind === 'sticky') body = field('Color', swatches(STICKY_COLORS, it.color, false));
  if (it.kind === 'text') body = field('Size', `<input type="number" id="dkISize" value="${it.size || 24}" min="8" max="400">`) + field('Align', `<div class="seg" id="dkIAlign">${['left', 'center', 'right'].map((a) => `<button class="seg-btn ${(it.align || 'left') === a ? 'on' : ''}" data-a="${a}" aria-label="Align ${a}">${I[a]}</button>`).join('')}</div>`) + field('Color', colorRow(it.color));
  if (it.kind === 'shape') body = field('Fill', colorRow(it.fill)) + field('Stroke', `<div class="dk-colors" data-role="stroke">${DEFAULT_BOARD_COLORS.map((c) => `<button class="dk-swatch ${c === it.stroke ? 'on' : ''}" data-c="${c}" style="background:${c}" aria-label="${c}"></button>`).join('')}</div>`) + field('Opacity', `<input type="range" id="dkIAlpha" min="0.1" max="1" step="0.05" value="${it.alpha == null ? 1 : it.alpha}">`) + (it.shape === 'rect' ? field('Corner radius', `<input type="number" id="dkIRadius" value="${it.radius || 0}" min="0" max="200">`) : '') + field('Label', `<input type="text" id="dkIText" value="${esc(it.text || '')}">`);
  if (it.kind === 'pen') body = field('Color', colorRow(it.color)) + field('Width', `<input type="range" id="dkIWidth" min="1" max="24" step="1" value="${it.width || 4}">`);
  if (it.kind === 'section') body = field('Title', `<input type="text" id="dkIText" value="${esc(it.title || '')}">`) + field('Color', swatches(['#e0f2fe', '#fef3c7', '#dcfce7', '#fce7f3', '#ede9fe', '#f5f5f4'], it.color, false));
  if (it.kind === 'connector') body = field('Color', colorRow(it.color)) + `<label class="fld-check"><input type="checkbox" id="dkIHead" ${it.head ? 'checked' : ''}> Arrowhead</label>`;
  if (it.kind === 'diagram') body = `<label class="fld-check"><input type="checkbox" id="dkIAnimate" ${it.animate ? 'checked' : ''}> Play drill animation on click</label>`;
  return `<div class="dk-sect"><h3>${head}</h3>${body}
    <label class="fld-check"><input type="checkbox" id="dkILock" ${it.locked ? 'checked' : ''}> Locked</label>
    <div class="dk-btnrow"><button class="btn btn-outline btn-sm" id="dkIDup">Duplicate</button><button class="btn btn-outline btn-sm" id="dkIDel">Delete</button></div>
  </div>`;
}
function wireItemPanel(host, it) {
  const rerender = () => { commit(); paintBoard(); paintChrome(); paintPanel(); };
  wireColors(host, (c) => {
    const strokeRow = $('.dk-colors[data-role="stroke"]', host);
    const fromStroke = strokeRow && strokeRow.contains(document.activeElement);
    if (it.kind === 'shape' && fromStroke) it.stroke = c;
    else if (it.kind === 'shape') it.fill = c;
    else if (it.kind === 'sticky' || it.kind === 'section') it.color = c;
    else it.color = c;
    rerender();
  });
  const strokeRow = $('.dk-colors[data-role="stroke"]', host);
  if (strokeRow) $$('.dk-swatch', strokeRow).forEach((b) => { b.onclick = () => { it.stroke = b.dataset.c; rerender(); }; });
  const on = (id, ev, fn) => { const n = $(id, host); if (n) n[ev] = fn; };
  on('#dkISize', 'onchange', (e) => { it.size = clamp(+e.target.value || 24, 8, 400); rerender(); });
  $$('#dkIAlign .seg-btn', host).forEach((b) => { b.onclick = () => { it.align = b.dataset.a; rerender(); }; });
  on('#dkIAlpha', 'oninput', (e) => { it.alpha = +e.target.value; placeStyle(it); });
  on('#dkIAlpha', 'onchange', () => rerender());
  on('#dkIRadius', 'onchange', (e) => { it.radius = Math.max(0, +e.target.value || 0); rerender(); });
  on('#dkIText', 'onchange', (e) => { if (it.kind === 'section') it.title = e.target.value; else it.text = e.target.value; rerender(); });
  on('#dkIWidth', 'onchange', (e) => { it.width = +e.target.value; rerender(); });
  on('#dkIHead', 'onchange', (e) => { it.head = e.target.checked; rerender(); });
  on('#dkIAnimate', 'onchange', (e) => { it.animate = e.target.checked; commit(); });
  on('#dkILock', 'onchange', (e) => { it.locked = e.target.checked; rerender(); });
  on('#dkIDup', 'onclick', duplicateSel);
  on('#dkIDel', 'onclick', deleteSel);
}
function placeStyle(it) { const n = $(`.wb-item[data-item="${it.id}"] .wb-shape-body`, $('#dkCanvas')); if (n) n.style.opacity = it.alpha; }

function multiPanelHtml(items) {
  return `<div class="dk-sect"><h3>${items.length} objects</h3>
    <h4 class="dk-sub">Align</h4>
    <div class="dk-btngrid">${[['left', 'Left'], ['hcenter', 'Center'], ['right', 'Right'], ['top', 'Top'], ['vcenter', 'Middle'], ['bottom', 'Bottom']].map(([k, l]) => `<button class="btn btn-outline btn-sm" data-align="${k}">${l}</button>`).join('')}</div>
    <h4 class="dk-sub">Distribute</h4>
    <div class="dk-btngrid"><button class="btn btn-outline btn-sm" data-dist="h">Horizontally</button><button class="btn btn-outline btn-sm" data-dist="v">Vertically</button></div>
    <div class="dk-btnrow"><button class="btn btn-outline btn-sm" id="dkIDup">Duplicate</button><button class="btn btn-outline btn-sm" id="dkIDel">Delete</button></div>
  </div>`;
}
function wireMultiPanel(host) {
  $$('[data-align]', host).forEach((b) => { b.onclick = () => alignSel(b.dataset.align); });
  $$('[data-dist]', host).forEach((b) => { b.onclick = () => distributeSel(b.dataset.dist); });
  $('#dkIDup', host).onclick = duplicateSel;
  $('#dkIDel', host).onclick = deleteSel;
}
function alignSel(how) {
  const items = selItems().filter((i) => isBox(i) && !i.locked);
  if (items.length < 2) return;
  const u = union(items);
  for (const it of items) {
    if (how === 'left') it.x = u.x; if (how === 'right') it.x = u.x + u.w - it.w; if (how === 'hcenter') it.x = Math.round(u.x + (u.w - it.w) / 2);
    if (how === 'top') it.y = u.y; if (how === 'bottom') it.y = u.y + u.h - it.h; if (how === 'vcenter') it.y = Math.round(u.y + (u.h - it.h) / 2);
  }
  commit(); paintBoard(); paintChrome();
}
function distributeSel(axis) {
  const items = selItems().filter((i) => isBox(i) && !i.locked).sort((a, b) => (axis === 'h' ? a.x - b.x : a.y - b.y));
  if (items.length < 3) return;
  const first = items[0]; const last = items[items.length - 1];
  const total = axis === 'h' ? (last.x + last.w) - first.x : (last.y + last.h) - first.y;
  const sum = items.reduce((t, i) => t + (axis === 'h' ? i.w : i.h), 0);
  const gap = (total - sum) / (items.length - 1);
  let cur = axis === 'h' ? first.x : first.y;
  for (const it of items) { if (axis === 'h') { it.x = Math.round(cur); cur += it.w + gap; } else { it.y = Math.round(cur); cur += it.h + gap; } }
  commit(); paintBoard(); paintChrome();
}

function slidePanelHtml(d, s) {
  const i = ed.ssel.i;
  return `<div class="dk-sect"><h3>${esc(d.name)} · Slide ${i + 1}</h3>
    ${field('Background', swatches(d.theme.colors, s.bg))}
    <label class="fld-check"><input type="checkbox" id="dkSkip" ${s.skip ? 'checked' : ''}> Skip in present</label>
    <div class="dk-btnrow"><button class="btn btn-outline btn-sm" id="dkThemeBtn">${I.palette} Theme</button><button class="btn btn-outline btn-sm" id="dkNewSlideBtn">${I.plus} New Slide</button></div>
  </div>`;
}
function wireSlidePanel(host, d, s) {
  wireColors(host, (c) => { s.bg = c; commit(); repaintDeck(d); paintRailSoon(); paintPanel(); });
  $('#dkSkip', host).onchange = (e) => { s.skip = e.target.checked; commit(); repaintDeck(d); paintRail(); };
  $('#dkThemeBtn', host).onclick = () => openThemeSheet(d);
  $('#dkNewSlideBtn', host).onclick = (e) => layoutMenu(e, d);
}

function elPanelHtml(el) {
  const d = deckOf();
  if (el.type === 'text') {
    const st = styleOf(d.theme, el.role);
    return `<div class="dk-sect"><h3>Text</h3>
      ${field('Style', `<select id="dkRole">${Object.entries(d.theme.styles).map(([r, s]) => `<option value="${r}" ${r === el.role ? 'selected' : ''}>${esc(s.label || r)}</option>`).join('')}</select>`)}
      ${field('Size', `<input type="number" id="dkSize" value="${el.size || st.size}" min="8" max="400">`)}
      ${field('Align', `<div class="seg" id="dkAlign">${['left', 'center', 'right'].map((a) => `<button class="seg-btn ${(el.align || 'left') === a ? 'on' : ''}" data-a="${a}" aria-label="Align ${a}">${I[a]}</button>`).join('')}</div>`)}
      ${field('Color', colorRow(el.color || st.color))}
    </div>`;
  }
  if (el.type === 'shape') {
    return `<div class="dk-sect"><h3>Shape</h3>
      ${field('Fill', colorRow(el.fill))}
      ${field('Opacity', `<input type="range" id="dkAlpha" min="0.1" max="1" step="0.05" value="${el.alpha == null ? 1 : el.alpha}">`)}
      ${el.shape === 'rect' ? field('Corner radius', `<input type="number" id="dkRadius" value="${el.radius || 0}" min="0" max="200">`) : ''}
      ${field('Label', `<input type="text" id="dkShapeText" value="${esc(el.text || '')}">`)}
    </div>`;
  }
  if (el.type === 'diagram') return `<div class="dk-sect"><h3>Rink Diagram</h3><label class="fld-check"><input type="checkbox" id="dkAnimate" ${el.animate ? 'checked' : ''}> Play drill animation in present</label><p class="dk-hint">Drawn in the Diagrams app; rendered live through the same renderer as the exported PNG.</p></div>`;
  if (el.type === 'video') return `<div class="dk-sect"><h3>Video</h3><p class="dk-hint">In present mode a two-finger swipe scrubs the film - the Clips scrub engine, same feel.</p></div>`;
  return `<div class="dk-sect"><h3>${el.type === 'image' ? 'Image' : 'Object'}</h3></div>`;
}
function wireElPanel(host, el) {
  const d = deckOf(); const i = ed.ssel.i;
  const re = () => { commit(); repaintDeck(d); selectSlide(d.id, i, el.id); };
  wireColors(host, (c) => { if (el.type === 'text') el.color = c; else el.fill = c; re(); });
  const on = (id, ev, fn) => { const n = $(id, host); if (n) n[ev] = fn; };
  on('#dkRole', 'onchange', (e) => { el.role = e.target.value; el.size = null; el.color = null; re(); });
  on('#dkSize', 'onchange', (e) => { el.size = clamp(+e.target.value || 36, 8, 400); re(); });
  $$('#dkAlign .seg-btn', host).forEach((b) => { b.onclick = () => { el.align = b.dataset.a; re(); }; });
  on('#dkAlpha', 'onchange', (e) => { el.alpha = +e.target.value; re(); });
  on('#dkRadius', 'onchange', (e) => { el.radius = Math.max(0, +e.target.value || 0); re(); });
  on('#dkShapeText', 'onchange', (e) => { el.text = e.target.value; re(); });
  on('#dkAnimate', 'onchange', (e) => { el.animate = e.target.checked; commit(); });
}

// ------------------------------------------------------------- animate

function paintAnimate(host) {
  const d = deckOf(); const s = slideOf(); if (!d || !s) { host.innerHTML = ''; return; }
  const tr = s.transition || { style: 'none', durMs: 300 };
  const el = selEl();
  const animated = s.els.filter((x) => x.anim).sort((a, b) => (a.anim.order || 0) - (b.anim.order || 0));
  host.innerHTML = `
    <div class="dk-sect"><h3>Slide transition</h3>
      ${field('Style', `<select id="dkTrStyle">${TRANSITIONS.map((t) => `<option value="${t}" ${t === tr.style ? 'selected' : ''}>${t[0].toUpperCase() + t.slice(1)}</option>`).join('')}</select>`)}
      ${field('Duration ms', `<input type="number" id="dkTrDur" value="${tr.durMs || 300}" min="100" max="2000" step="50">`)}
      <button class="btn btn-outline btn-sm" id="dkTrAll">Apply to All Slides</button>
    </div>
    <div class="dk-sect"><h3>Object animations</h3>
      ${el ? (el.anim ? animEditorHtml(el) : `<button class="btn btn-outline btn-sm" id="dkAnimAdd">${I.plus} Animate Selected Object</button>`) : '<p class="dk-hint">Select an object on the slide to animate it.</p>'}
      ${animated.length ? `<div class="dk-animlist">${animated.map((x, n) => `<button class="dk-animrow ${x.id === ed.ssel.el ? 'on' : ''}" data-el="${x.id}"><span class="dk-animn">${n + 1}</span><span>${animLabel(x)}</span><span class="dk-animx" data-x="${x.id}">${I.x}</span></button>`).join('')}</div>` : ''}
    </div>`;
  $('#dkTrStyle', host).onchange = (e) => { s.transition = { ...tr, style: e.target.value }; commit(); };
  $('#dkTrDur', host).onchange = (e) => { s.transition = { ...tr, durMs: Math.max(100, +e.target.value || 300) }; commit(); };
  $('#dkTrAll', host).onclick = () => { for (const sl of d.slides) sl.transition = { ...(s.transition || tr) }; commit(); };
  const add = $('#dkAnimAdd', host);
  if (add) add.onclick = () => { const max = Math.max(0, ...s.els.filter((x) => x.anim).map((x) => x.anim.order || 0)); el.anim = { io: 'in', style: 'fade', durMs: 600, order: max + 1 }; commit(); paintAnimate(host); };
  if (el && el.anim) wireAnimEditor(host, el);
  $$('.dk-animrow', host).forEach((r) => { r.onclick = (ev) => { if (ev.target.closest('.dk-animx')) return; ed.ssel.el = r.dataset.el; paintChrome(); paintAnimate(host); }; });
  $$('.dk-animx', host).forEach((x) => { x.onclick = () => { const t = s.els.find((y) => y.id === x.dataset.x); if (t) delete t.anim; commit(); paintAnimate(host); }; });
}
const animLabel = (x) => `${x.type === 'text' ? (x.text || 'Text').slice(0, 14) : x.type} - ${x.anim.style}, ${x.anim.durMs}ms ${x.anim.io}`;
function animEditorHtml(el) {
  const a = el.anim;
  return `<div class="dk-animedit">
    ${field('Style', `<select id="dkAStyle">${ANIM_STYLES.map((t) => `<option value="${t}" ${t === a.style ? 'selected' : ''}>${t.replace('-', ' ')}</option>`).join('')}</select>`)}
    ${field('Animate', `<div class="seg" id="dkAIO"><button class="seg-btn ${a.io === 'in' ? 'on' : ''}" data-io="in">In</button><button class="seg-btn ${a.io === 'out' ? 'on' : ''}" data-io="out">Out</button></div>`)}
    ${field('Duration ms', `<input type="number" id="dkADur" value="${a.durMs}" min="100" max="3000" step="50">`)}
    ${field('Order', `<input type="number" id="dkAOrder" value="${a.order || 1}" min="1" max="99">`)}
    <button class="btn btn-outline btn-sm" id="dkARemove">Remove Animation</button>
  </div>`;
}
function wireAnimEditor(host, el) {
  $('#dkAStyle', host).onchange = (e) => { el.anim.style = e.target.value; commit(); };
  $$('#dkAIO .seg-btn', host).forEach((b) => { b.onclick = () => { el.anim.io = b.dataset.io; commit(); paintAnimate(host); }; });
  $('#dkADur', host).onchange = (e) => { el.anim.durMs = Math.max(100, +e.target.value || 600); commit(); };
  $('#dkAOrder', host).onchange = (e) => { el.anim.order = Math.max(1, +e.target.value || 1); commit(); paintAnimate(host); };
  $('#dkARemove', host).onclick = () => { delete el.anim; commit(); paintAnimate(host); };
}

// ------------------------------------------------------------- sheets

const sheetHtml = (title, body) => `<div class="sheet-veil"><div class="sheet" role="dialog" aria-modal="true" aria-label="${esc(title)}"><header><h2>${esc(title)}</h2><button class="btn btn-ghost btn-icon" data-close aria-label="Close">${I.x}</button></header><div class="sheet-body">${body}</div></div></div>`;
function wireSheet() { const veil = $('.sheet-veil'); if (!veil) return; veil.onclick = (e) => { if (e.target === veil || e.target.closest('[data-close]')) closeSheet(); }; }
export function closeSheet() { const v = $('.sheet-veil'); if (v) v.remove(); }

function openThemeSheet(d) {
  const t = d.theme;
  const rows = Object.entries(t.styles).map(([r, s]) => `
    <div class="dk-trow" data-role="${r}"><span class="dk-trole">${esc(s.label || r)}</span>
      <input type="number" class="dk-tsize" value="${s.size}" min="8" max="400" data-tip="Size" aria-label="${esc(s.label || r)} size">
      <select class="dk-tweight" data-tip="Weight" aria-label="${esc(s.label || r)} weight">${[400, 500, 600, 700, 800].map((w) => `<option ${w === s.weight ? 'selected' : ''}>${w}</option>`).join('')}</select>
      <input type="color" class="dk-tcolor" value="${s.color}" data-tip="Color" aria-label="${esc(s.label || r)} color"></div>`).join('');
  $('#dkSheet').innerHTML = sheetHtml(`Theme · ${d.name}`, `<h4>Text styles</h4><div class="dk-theme-rows">${rows}</div><h4>Colors</h4><div class="dk-colors dk-theme-colors">${t.colors.map((c, i) => `<input type="color" class="dk-cwell" data-i="${i}" value="${c}" aria-label="Palette color ${i + 1}">`).join('')}</div><p class="dk-hint">Styles cascade: every text element using a style updates when the style changes.</p>`);
  wireSheet();
  const themed = () => { commit(); repaintDeck(d); paintRailSoon(); };
  $$('.dk-trow').forEach((row) => {
    const st = t.styles[row.dataset.role];
    $('.dk-tsize', row).onchange = (e) => { st.size = Math.max(8, +e.target.value || st.size); themed(); };
    $('.dk-tweight', row).onchange = (e) => { st.weight = +e.target.value; themed(); };
    $('.dk-tcolor', row).oninput = (e) => { st.color = e.target.value; themed(); };
  });
  $$('.dk-theme-colors .dk-cwell').forEach((w) => { w.oninput = (e) => { t.colors[+w.dataset.i] = e.target.value; themed(); }; });
}

function openSettingsSheet() {
  const s = settings(); const p = ed.prefs;
  $('#dkSheet').innerHTML = sheetHtml('Board Settings', `
    <h4>Canvas</h4>
    ${field('Grid', `<div class="seg" id="dkSGrid">${[['dots', 'Dots'], ['lines', 'Lines'], ['none', 'None']].map(([k, l]) => `<button class="seg-btn ${s.grid === k ? 'on' : ''}" data-g="${k}">${l}</button>`).join('')}</div>`)}
    ${field('Grid size', `<input type="number" id="dkSGridSize" value="${s.gridSize}" min="8" max="200" step="4">`)}
    <label class="fld-check"><input type="checkbox" id="dkSSnap" ${s.snap ? 'checked' : ''}> Snap objects to grid</label>
    ${field('Background', swatches(['#f5f5f4', '#ffffff', '#fafaf9', '#e7e5e4', '#f0f9ff', '#1c1917'], s.bg))}
    <h4>Defaults</h4>
    ${field('Sticky color', swatches(STICKY_COLORS, p.stickyColor || s.stickyColor, false))}
    ${field('Pen color', `<div class="dk-colors" data-role="pen">${DEFAULT_BOARD_COLORS.map((c) => `<button class="dk-swatch ${c === (p.penColor || s.penColor) ? 'on' : ''}" data-c="${c}" style="background:${c}" aria-label="${c}"></button>`).join('')}</div>`)}
    ${field('Pen width', `<input type="range" id="dkSPenW" min="1" max="24" step="1" value="${p.penWidth || s.penWidth}">`)}
    <p class="dk-hint">Canvas settings save with the board. Defaults are yours, on this Mac.</p>`);
  wireSheet();
  const host = $('#dkSheet');
  $$('#dkSGrid .seg-btn', host).forEach((b) => { b.onclick = () => { s.grid = b.dataset.g; $$('#dkSGrid .seg-btn', host).forEach((x) => x.classList.toggle('on', x === b)); markDirty(); applyTransform(); }; });
  $('#dkSGridSize', host).onchange = (e) => { s.gridSize = clamp(+e.target.value || 40, 8, 200); markDirty(); applyTransform(); };
  $('#dkSSnap', host).onchange = (e) => { s.snap = e.target.checked; markDirty(); };
  const rows = $$('.dk-colors', host);
  $$('.dk-swatch', rows[0]).forEach((b) => { b.onclick = () => { s.bg = b.dataset.c; markDirty(); applyTransform(); mark(rows[0], b); }; });
  $('.dk-cwell', rows[0]).oninput = (e) => { s.bg = e.target.value; markDirty(); applyTransform(); };
  $$('.dk-swatch', rows[1]).forEach((b) => { b.onclick = () => { p.stickyColor = b.dataset.c; savePrefs(); mark(rows[1], b); }; });
  $$('.dk-swatch', rows[2]).forEach((b) => { b.onclick = () => { p.penColor = b.dataset.c; savePrefs(); mark(rows[2], b); }; });
  $('#dkSPenW', host).onchange = (e) => { p.penWidth = +e.target.value; savePrefs(); };
  function mark(row, b) { $$('.dk-swatch', row).forEach((x) => x.classList.toggle('on', x === b)); }
}
function savePrefs() { try { localStorage.setItem('cthk.prefs', JSON.stringify(ed.prefs)); } catch (_) {} }

// ------------------------------------------------------------- slide view

function paintRail() {
  const rail = $('#dkRail'); const d = focusDeck();
  if (!rail || !d) return;
  const cur = ed.ssel?.deck === d.id ? ed.ssel.i : 0;
  rail.innerHTML = `<div class="dk-rail-head"><select id="dkRailDeck" aria-label="Deck">${boardDecks(ed.board).map((x) => `<option value="${x.id}" ${x.id === d.id ? 'selected' : ''}>${esc(x.name)}</option>`).join('')}</select></div>` +
    d.slides.map((s, i) => `
    <div class="dk-thumb ${i === cur ? 'on' : ''} ${s.skip ? 'skip' : ''}" data-i="${i}" role="button" tabindex="0" aria-label="Slide ${i + 1}${s.skip ? ', skipped' : ''}" aria-current="${i === cur}">
      <span class="dk-thumb-n">${i + 1}</span><div class="dk-thumb-box">${slideHtml(s, d.theme)}</div>
      ${s.skip ? `<span class="dk-thumb-skip" data-tip="Skipped in present">${I.eyeOff}</span>` : ''}
    </div>`).join('') + `<button class="btn btn-outline dk-add" id="dkAddSlide">${I.plus} New Slide</button>`;
  hydrate(rail);
  $('#dkRailDeck').onchange = (e) => setView('slide', e.target.value);
  $$('.dk-thumb', rail).forEach((t) => {
    const go = () => { ed.ssel = { deck: d.id, i: +t.dataset.i, el: null }; paintRail(); paintSlideStage(); paintNotes(); paintPanel(); };
    t.onclick = go;
    t.onkeydown = (e) => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); go(); } };
    t.oncontextmenu = (e) => { e.preventDefault(); slideMenu(e, d, +t.dataset.i); };
    t.onpointerdown = (e) => startThumbDrag(e, t, d);
  });
  $('#dkAddSlide').onclick = (e) => layoutMenu(e, d);
}
let railT = 0;
function paintRailSoon() { clearTimeout(railT); railT = setTimeout(() => { if (ed?.view === 'slide') paintRail(); }, 600); }
function paintNotes() { const n = $('#dkNotes'); const s = slideOf(); if (n) n.value = s?.notes || ''; }

function paintSlideStage() {
  const wrap = $('#dkStageWrap'); const d = focusDeck();
  if (!wrap || !d) return;
  if (!ed.ssel || ed.ssel.deck !== d.id) ed.ssel = { deck: d.id, i: 0, el: null };
  const s = d.slides[ed.ssel.i];
  wrap.innerHTML = `<div class="dk-stagebox">${slideHtml(s, d.theme)}<div class="dk-chrome" data-chrome="${d.id}:${ed.ssel.i}"></div></div>`;
  hydrate(wrap);
  const stage = $('.dk-stage', wrap);
  stage.addEventListener('pointerdown', onStageDown);
  stage.addEventListener('dblclick', onStageDblClick);
  paintChrome();
}

function startThumbDrag(e, node, d) {
  if (e.button !== 0) return;
  const from = +node.dataset.i; let started = false; const sy = e.clientY;
  const move = (ev) => {
    if (!started && Math.abs(ev.clientY - sy) > 6) { started = true; node.classList.add('dragging'); }
    if (!started) return;
    const over = document.elementFromPoint(ev.clientX, ev.clientY)?.closest('.dk-thumb');
    $$('.dk-thumb').forEach((t) => t.classList.remove('drop'));
    if (over && over !== node) over.classList.add('drop');
  };
  const up = (ev) => {
    window.removeEventListener('pointermove', move); window.removeEventListener('pointerup', up);
    if (!started) return;
    const over = document.elementFromPoint(ev.clientX, ev.clientY)?.closest('.dk-thumb');
    node.classList.remove('dragging');
    if (over && over !== node) { const to = +over.dataset.i; const [s] = d.slides.splice(from, 1); d.slides.splice(to, 0, s); ed.ssel.i = to; commit(); }
    paintAll();
  };
  window.addEventListener('pointermove', move); window.addEventListener('pointerup', up);
}

// ------------------------------------------------------------- keyboard

function onKeyDown(e) {
  if (!ed) return;
  const inField = /INPUT|TEXTAREA|SELECT/.test(e.target.tagName) || e.target.isContentEditable;
  if (e.key === 'Escape') {
    closeMenu();
    if ($('.sheet-veil')) { closeSheet(); return; }
    if (inField) return;
    if (ed.place) { armTool('select'); return; }
    if (ed.tool !== 'select') { armTool('select'); return; }
    if (ed.ssel?.el) { ed.ssel.el = null; paintChrome(); paintPanel(); return; }
    if (ed.sel.size || ed.ssel) { clearSel(); ed.ssel = null; paintChrome(); paintPanel(); }
    return;
  }
  if (inField) return;
  const mod = e.metaKey || e.ctrlKey;
  if (mod && e.key.toLowerCase() === 'z') { e.preventDefault(); if (e.shiftKey) redo(); else undo(); return; }
  if (mod && e.key === '0') { e.preventDefault(); fitToContent(); return; }
  if (mod && (e.key === '=' || e.key === '+')) { e.preventDefault(); zoomBy(1.25); return; }
  if (mod && e.key === '-') { e.preventDefault(); zoomBy(0.8); return; }
  if (mod && e.key.toLowerCase() === 'a' && ed.view === 'board') { e.preventDefault(); select(ed.board.items.filter(isBox).map((i) => i.id)); return; }
  if (mod && e.key.toLowerCase() === 'c') { if (ed.sel.size) { copySel(); e.preventDefault(); } return; }
  if (mod && e.key.toLowerCase() === 'v') { if (clipboard) { pasteAt(null); e.preventDefault(); } return; }
  const el = selEl();
  if (mod && e.key.toLowerCase() === 'd') {
    e.preventDefault();
    if (el) { const d = deckOf(); const c = JSON.parse(JSON.stringify(el)); c.id = uid(); c.x += 24; c.y += 24; slideOf().els.push(c); commit(); repaintDeck(d); selectSlide(d.id, ed.ssel.i, c.id); }
    else if (ed.sel.size) duplicateSel();
    return;
  }
  if (e.key === 'Delete' || e.key === 'Backspace') {
    if (el) { const d = deckOf(); slideOf().els = slideOf().els.filter((x) => x.id !== el.id); ed.ssel.el = null; commit(); repaintDeck(d); paintPanel(); paintRailSoon(); e.preventDefault(); return; }
    if (ed.ssel && slideOf()) { deleteSlide(deckOf(), ed.ssel.i); e.preventDefault(); return; }
    if (ed.sel.size) { deleteSel(); e.preventDefault(); }
    return;
  }
  if (e.key === 'Enter' && el && el.type === 'text') {
    const node = $(`.dk-el[data-el="${el.id}"]`, currentStage());
    if (node) { e.preventDefault(); editSlideText(node, deckOf(), ed.ssel.i, el); }
    return;
  }
  if (['ArrowUp', 'ArrowDown', 'ArrowLeft', 'ArrowRight'].includes(e.key)) {
    const step = e.shiftKey ? 10 : 1;
    const dx = e.key === 'ArrowLeft' ? -step : e.key === 'ArrowRight' ? step : 0;
    const dy = e.key === 'ArrowUp' ? -step : e.key === 'ArrowDown' ? step : 0;
    if (el) { el.x += dx; el.y += dy; commit(); repaintDeck(deckOf()); selectSlide(ed.ssel.deck, ed.ssel.i, el.id); e.preventDefault(); return; }
    if (ed.sel.size && ed.view === 'board') { for (const it of selItems()) if (isBox(it) && !it.locked) { it.x += dx; it.y += dy; placeNode(it); } commit(); paintChrome(); paintConns(); e.preventDefault(); return; }
    if (ed.view === 'slide' && ed.ssel && dx) { const d = focusDeck(); const to = ed.ssel.i + Math.sign(dx); if (to >= 0 && to < d.slides.length) { ed.ssel = { deck: d.id, i: to, el: null }; paintAll(); } e.preventDefault(); }
    return;
  }
  if (e.key === '[' || e.key === ']') { if (ed.sel.size) reorder(e.key === ']' ? 'up' : 'down'); return; }
  if (e.key === ' ' && ed.view === 'board') { ed.space = true; $('#dkBoard')?.classList.add('is-hand'); e.preventDefault(); return; }
  if (mod) return;
  const k = e.key.toLowerCase();
  if (ed.view === 'board') {
    if (k === 'v') armTool('select'); if (k === 'h') armTool('hand'); if (k === 's') armTool('sticky'); if (k === 'p') armTool('pen');
    if (k === 'c') armTool('connector'); if (k === 'f') armTool('section'); if (k === 'd') armTool('deck');
    if (k === 'r') { ed.shape = ed.shape || 'rect'; armTool('shape'); }
    if (k === 't') armTool('text', { kind: 'text', hint: 'Click a slide or the board to place text' });
  } else {
    if (k === 'v') armTool('select');
    if (k === 't') textMenu({ clientX: innerWidth / 2 - 100, clientY: innerHeight - 260, target: $('#dkTools') });
  }
}

// ------------------------------------------------------------- icons
// Lucide-style glyphs at 1.75 stroke on a 24 grid - the icon set shadcn ships with.

const svg = (d) => `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.75" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">${d}</svg>`;
export const I = {
  back: svg('<path d="M15 18l-6-6 6-6"/>'),
  plus: svg('<path d="M12 5v14M5 12h14"/>'),
  minus: svg('<path d="M5 12h14"/>'),
  play: svg('<path d="M6 4l14 8-14 8z"/>'),
  film: svg('<rect x="3" y="5" width="12" height="14" rx="2"/><path d="M19 7v10"/><path d="M22 9v6"/>'),
  grid: svg('<rect x="3" y="3" width="7" height="7" rx="1.5"/><rect x="14" y="3" width="7" height="7" rx="1.5"/><rect x="3" y="14" width="7" height="7" rx="1.5"/><rect x="14" y="14" width="7" height="7" rx="1.5"/>'),
  palette: svg('<circle cx="12" cy="12" r="9"/><circle cx="8.5" cy="10" r="1"/><circle cx="12" cy="7.5" r="1"/><circle cx="15.5" cy="10" r="1"/><path d="M12 21a3 3 0 0 0 0-6h-1a2 2 0 0 1 0-4"/>'),
  cursor: svg('<path d="M4 3l7.5 18 2.2-7.3L21 11.5z"/>'),
  hand: svg('<path d="M18 11V6a2 2 0 0 0-4 0v5"/><path d="M14 10V4a2 2 0 0 0-4 0v6"/><path d="M10 10.5V6a2 2 0 0 0-4 0v8"/><path d="M18 8a2 2 0 1 1 4 0v6a8 8 0 0 1-8 8h-2c-2.8 0-4.5-.9-5.8-2.4L3.4 15.6a2 2 0 0 1 3.2-2.4L8 15"/>'),
  sticky: svg('<path d="M15.5 3H5a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h14a2 2 0 0 0 2-2V8.5z"/><path d="M15 3v5a1 1 0 0 0 1 1h5"/>'),
  text: svg('<path d="M4 6V4h16v2"/><path d="M12 4v16"/><path d="M9 20h6"/>'),
  shapes: svg('<rect x="3" y="13" width="8" height="8" rx="1.5"/><circle cx="16.5" cy="7.5" r="4.5"/>'),
  pen: svg('<path d="M17 3a2.8 2.8 0 1 1 4 4L7.5 20.5 2 22l1.5-5.5z"/><path d="M15 5l4 4"/>'),
  connector: svg('<circle cx="5" cy="19" r="2"/><circle cx="19" cy="5" r="2"/><path d="M6.5 17.5L17.5 6.5"/>'),
  section: svg('<rect x="3" y="5" width="18" height="15" rx="2"/><path d="M3 9h18"/>'),
  image: svg('<rect x="3" y="4" width="18" height="16" rx="2"/><circle cx="9" cy="10" r="1.6"/><path d="M4 19l6-6 4 4 3-3 3 3"/>'),
  video: svg('<rect x="3" y="6" width="13" height="12" rx="2"/><path d="M16 10.5l5-3v9l-5-3"/>'),
  rink: svg('<rect x="2.5" y="6" width="19" height="12" rx="5"/><path d="M12 6v12"/><circle cx="12" cy="12" r="1.6"/>'),
  deck: svg('<rect x="3" y="6.5" width="14.5" height="11" rx="2"/><path d="M20.5 9v6"/><path d="M8.6 10l4.6 2.5-4.6 2.5z"/>'),
  gear: svg('<circle cx="12" cy="12" r="3"/><path d="M19.4 15a1.7 1.7 0 0 0 .3 1.8l.1.1a2 2 0 1 1-2.8 2.8l-.1-.1a1.7 1.7 0 0 0-1.8-.3 1.7 1.7 0 0 0-1 1.5V21a2 2 0 1 1-4 0v-.1a1.7 1.7 0 0 0-1.1-1.5 1.7 1.7 0 0 0-1.8.3l-.1.1a2 2 0 1 1-2.8-2.8l.1-.1a1.7 1.7 0 0 0 .3-1.8 1.7 1.7 0 0 0-1.5-1H3a2 2 0 1 1 0-4h.1a1.7 1.7 0 0 0 1.5-1.1 1.7 1.7 0 0 0-.3-1.8l-.1-.1a2 2 0 1 1 2.8-2.8l.1.1a1.7 1.7 0 0 0 1.8.3H9a1.7 1.7 0 0 0 1-1.5V3a2 2 0 1 1 4 0v.1a1.7 1.7 0 0 0 1 1.5 1.7 1.7 0 0 0 1.8-.3l.1-.1a2 2 0 1 1 2.8 2.8l-.1.1a1.7 1.7 0 0 0-.3 1.8V9a1.7 1.7 0 0 0 1.5 1H21a2 2 0 1 1 0 4h-.1a1.7 1.7 0 0 0-1.5 1z"/>'),
  undo: svg('<path d="M3 7v6h6"/><path d="M21 17a9 9 0 0 0-15-6.7L3 13"/>'),
  redo: svg('<path d="M21 7v6h-6"/><path d="M3 17a9 9 0 0 1 15-6.7L21 13"/>'),
  eyeOff: svg('<path d="M3 3l18 18"/><path d="M10.6 5.1A9.8 9.8 0 0 1 12 5c7 0 10 7 10 7a17 17 0 0 1-3.2 4.2M6.6 6.6A16.9 16.9 0 0 0 2 12s3 7 10 7a9.7 9.7 0 0 0 5.4-1.6"/>'),
  x: svg('<path d="M18 6L6 18M6 6l12 12"/>'),
  left: svg('<path d="M4 6h16M4 12h10M4 18h13"/>'),
  center: svg('<path d="M4 6h16M7 12h10M6 18h12"/>'),
  right: svg('<path d="M4 6h16M10 12h10M7 18h13"/>'),
  copy: svg('<rect x="9" y="9" width="12" height="12" rx="2"/><path d="M5 15V5a2 2 0 0 1 2-2h10"/>'),
  trash: svg('<path d="M3 6h18M8 6V4a1 1 0 0 1 1-1h6a1 1 0 0 1 1 1v2M19 6l-1 14a2 2 0 0 1-2 2H8a2 2 0 0 1-2-2L5 6"/>'),
};
