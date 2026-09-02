// The Decks whiteboard editor. THE BOARD IS THE DOCUMENT: an infinite
// canvas holding decks, sticky notes, text, shapes, pen strokes,
// connectors, sections and media. A deck's slides are live stages that
// edit in place; "slide view" focuses one deck with a filmstrip.
//
// Rules carried in from the suite:
// - IT SAVES ITSELF (700ms debounce, flush on the way out). No Save button.
//   Every flush also writes the board as JSON into the CTH folder at
//   /cth-admin/Sidebar 1/Apps/Whiteboard/<name>.json when the folder is
//   connected (clips/js/localfs.js).
// - The canvas moves, the items do not: one transform, applied once per
//   animation frame from accumulated wheel deltas (that is the smoothness),
//   chrome scaled back out by --inv. Zoom about the pointer.
// - A MEDIA TOOL ASKS FOR ITS FILE FIRST, then a click places it - on a
//   slide if the click lands on one, otherwise on the board.
// - Every pointer resolves against what it landed on; a selection can
//   never straddle two decks.
// - Window-level pointer listeners, removed on teardown.
// - Undo/redo is a snapshot stack of `items`; every committed change
//   (drag end, edit, create, delete, reorder) pushes one.
// - SNAPPING: objects snap to other objects' edges and centres (default
//   on) and to the grid when that setting is on; slide elements snap to
//   sibling elements and the slide's edges and centre. Guides are drawn in
//   the chrome layer while a drag runs.

import {
  SLIDE_W, SLIDE_H, LAYOUTS, ANIM_STYLES, TRANSITIONS, STICKY_COLORS, DEFAULT_SETTINGS,
  DECK_FRAME_W, DECK_FRAME_H, DECK_GAP, deckWidth, deckHeight, dgmOf,
  styleOf, newSlide, newText, newShape, newImage, newVideo, newDiagram, newDeck,
  newDeckItem, newSticky, newBoardText, newBoardShape, newPen, newConnector, newSection,
  newBoardImage, newBoardVideo, newBoardDiagram, normalizeBoard, boardDecks, isBox,
} from './model.js';
import { slideHtml, itemHtml, deckHtml, hydrate, esc, paintDgm } from './render.js';
import { getDeck, putDeck, putAsset, assetUrl, uid, listDrills } from './store.js';
import * as TB from './toolbar.js';
import { iconSvg, ICON_NAMES } from './icons.js';
import * as DG from './dgm.js';
import { fsInit, fsConnected, fsConnect, fsReconnect, fsRemembered, fsRootName, fsWrite, fsSupported } from '/clips/js/localfs.js';

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

export const WHITEBOARD_DIR = '/cth-admin/Sidebar 1/Apps/Whiteboard';

export async function flush() {
  clearTimeout(saveT);
  if (!ed) return;
  try { await putDeck(ed.board); paintStatus('Saved'); }
  catch (_) { paintStatus('Could not save'); return; }
  // Mirror the board into Tony's CTH folder as JSON when it is connected.
  if (fsConnected()) {
    try {
      const name = (ed.board.name || 'Untitled Board').replace(/[\\/:*?"<>|]+/g, '-').trim() || 'Untitled Board';
      await fsWrite(`${WHITEBOARD_DIR}/${name}.json`, new Blob([JSON.stringify(ed.board)], { type: 'application/json' }));
    } catch (_) { paintStatus('Saved (folder write failed)'); }
  }
}

function paintStatus(word) { const n = $('#dkStatus'); if (n) n.textContent = word; }

const snap = () => JSON.stringify(ed.board.items);
function commit() {
  ed.hist.past.push(ed.hist.present);
  if (ed.hist.past.length > 100) ed.hist.past.shift();
  ed.hist.present = snap();
  ed.hist.future = [];
  markDirty(); paintUndo();
}
function undo() { if (!ed.hist.past.length) return; ed.hist.future.push(ed.hist.present); ed.hist.present = ed.hist.past.pop(); restore(); }
function redo() { if (!ed.hist.future.length) return; ed.hist.past.push(ed.hist.present); ed.hist.present = ed.hist.future.pop(); restore(); }
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
    board, sel: new Set(), ssel: null, sslides: new Set(), dsel: null,
    tool: 'select', place: null, view: 'board',
    focus: decks[0]?.id || null, tab: 'design', drag: null, un: [], space: false,
    bd: { x: 40, y: 40, z: 0.5 }, pend: null, raf: 0,
    hist: { past: [], present: JSON.stringify(board.items), future: [] },
    prefs: loadPrefs(),
  };
  fsInit().catch(() => {});
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

function loadPrefs() { try { return { ...JSON.parse(localStorage.getItem('cthk.prefs') || '{}') }; } catch (_) { return {}; } }
function savePrefs() { try { localStorage.setItem('cthk.prefs', JSON.stringify(ed.prefs)); } catch (_) {} }

// Slide presets are Tony's own, across boards: localStorage `cthk.presets`.
function loadPresets() { try { return JSON.parse(localStorage.getItem('cthk.presets') || '[]'); } catch (_) { return []; } }
function savePresets(list) { try { localStorage.setItem('cthk.presets', JSON.stringify(list)); } catch (_) {} }

// ------------------------------------------------------------- lookups

const item = (id) => ed.board.items.find((i) => i.id === id);
const deckOf = () => (ed.ssel ? item(ed.ssel.deck) : null);
const slideOf = () => { const d = deckOf(); return d ? d.slides[ed.ssel.i] : null; };
const selEl = () => { const s = slideOf(); return s && ed.ssel.el ? s.els.find((e) => e.id === ed.ssel.el) : null; };
const focusDeck = () => item(ed.focus) || boardDecks(ed.board)[0] || null;
const selItems = () => [...ed.sel].map(item).filter(Boolean);
const settings = () => ed.board.settings;
const snapV = (v) => (settings().snap ? Math.round(v / settings().gridSize) * settings().gridSize : Math.round(v));
const cloneSlide = (s) => { const c = JSON.parse(JSON.stringify(s)); c.id = uid(); c.els.forEach((x) => { x.id = uid(); }); if (c.dgm) c.dgm.elements.forEach((x) => { x.id = uid(); }); return c; };

// ------------------------------------------------------------- shell

function shellHtml(board) {
  return `
  <div class="dk-editor">
    <header class="dk-head">
      <button class="btn btn-ghost btn-icon" id="dkBack" aria-label="Back">${iconSvg('chevron-left')}</button>
      <input class="dk-name" id="dkName" value="${esc(board.name)}" aria-label="Board name">
      <span class="dk-status" id="dkStatus">Saved</span>
      <div class="dk-head-r">
        <div class="seg" role="group" aria-label="Undo">
          <button class="seg-btn" id="dkUndo" aria-label="Undo">${iconSvg('undo-2')}</button>
          <button class="seg-btn" id="dkRedo" aria-label="Redo">${iconSvg('redo-2')}</button>
        </div>
        <div class="seg" role="group" aria-label="View">
          <button class="seg-btn on" id="dkViewBoard" aria-label="Board view">${iconSvg('grid-2x2')}</button>
          <button class="seg-btn" id="dkViewSlide" aria-label="Slide view">${iconSvg('gallery-horizontal-end')}</button>
        </div>
        <button class="btn btn-outline" id="dkNewSlide">${iconSvg('plus')} New Slide</button>
        <button class="btn btn-outline btn-icon" id="dkSettings" aria-label="Board settings">${iconSvg('settings')}</button>
        <button class="btn btn-outline btn-icon" id="dkPanelToggle" aria-label="Toggle sidebar">${iconSvg('panel-right')}</button>
        <button class="btn btn-primary" id="dkPresent">${iconSvg('play')} Present</button>
      </div>
    </header>
    <div class="dk-main" id="dkMain"></div>
    <div class="dk-toolbar" id="dkTools"></div>
    <div id="dkSheet"></div>
  </div>`;
}

function wireShell() {
  $('#dkBack').onclick = () => { location.hash = '#/'; };
  $('#dkName').onchange = (e) => { ed.board.name = e.target.value.trim() || 'Untitled Board'; markDirty(); };
  $('#dkSettings').onclick = openSettingsSheet;
  $('#dkPanelToggle').onclick = () => { ed.prefs.panelHidden = !ed.prefs.panelHidden; savePrefs(); $('.dk-panel')?.classList.toggle('collapsed', !!ed.prefs.panelHidden); };
  $('#dkNewSlide').onclick = (e) => { const d = deckOf() || focusDeck(); if (d) layoutMenu(e, d); };
  $('#dkPresent').onclick = () => presentDeck(deckOf() || focusDeck());
  $('#dkViewSlide').onclick = () => setView('slide');
  $('#dkViewBoard').onclick = () => setView('board');
  $('#dkUndo').onclick = undo;
  $('#dkRedo').onclick = redo;
}

function presentDeck(d) { if (!d) return; flush(); location.hash = `#/present/${ed.board.id}/${d.id}`; }

function setView(v, deckId) {
  if (deckId) ed.focus = deckId;
  if (v === 'slide' && !focusDeck()) return;
  ed.view = v;
  $('#dkViewSlide').classList.toggle('on', v === 'slide');
  $('#dkViewBoard').classList.toggle('on', v === 'board');
  if (v === 'slide') { const d = focusDeck(); ed.ssel = { deck: d.id, i: Math.min(ed.ssel?.deck === d.id ? ed.ssel.i : 0, d.slides.length - 1), el: null }; }
  paintAll();
}

// ------------------------------------------------------------- paint

function paintAll() {
  const main = $('#dkMain'); if (!main) return;
  const panel = `<aside class="dk-panel ${ed.prefs.panelHidden ? 'collapsed' : ''}"><div class="tabs" id="dkTabs"></div><div class="dk-panel-body" id="dkPanel"></div></aside>`;
  if (ed.view === 'slide') {
    main.innerHTML = `
      <aside class="dk-rail" id="dkRail"></aside>
      <div class="dk-center">
        <div class="dk-stagewrap" id="dkStageWrap"></div>
        <div class="dk-notes"><textarea id="dkNotes" placeholder="Add presenter notes for this slide…" aria-label="Presenter notes" rows="2"></textarea></div>
        <div class="dk-placebar" id="dkPlace" hidden></div>
      </div>${panel}`;
    $('#dkNotes').oninput = (e) => { const s = slideOf(); if (s) { s.notes = e.target.value; markDirty(); } };
    paintRail(); paintSlideStage(); paintNotes();
  } else {
    main.innerHTML = `
      <div class="dk-center">
        <div class="wb-board" id="dkBoard"><div class="wb-canvas" id="dkCanvas"></div><div class="wb-marquee" id="dkMarquee" hidden></div></div>
        <div class="dk-placebar" id="dkPlace" hidden></div>
        <div class="wb-zoom">
          <button class="wb-zbtn" id="dkZoomOut" aria-label="Zoom out">${iconSvg('minus')}</button>
          <button class="wb-zpct" id="dkZoomPct" aria-label="Zoom level, click to fit">50%</button>
          <button class="wb-zbtn" id="dkZoomIn" aria-label="Zoom in">${iconSvg('plus')}</button>
        </div>
      </div>${panel}`;
    paintBoard();
    $('#dkZoomIn').onclick = () => zoomBy(1.25);
    $('#dkZoomOut').onclick = () => zoomBy(0.8);
    $('#dkZoomPct').onclick = fitToContent;
  }
  paintTools(); paintPanel(); paintUndo();
}

// ------------------------------------------------------------- board

function paintBoard() {
  const canvas = $('#dkCanvas'); if (!canvas) return;
  const html = ed.board.items.map((it) => (it.kind === 'deck' ? deckHtml(it, curIndex(it), selSet(it)) : isBox(it) ? itemHtml(it) : '')).join('');
  canvas.innerHTML = `<svg class="wb-conns" id="dkConns" aria-hidden="true"><defs><marker id="wbArrow" viewBox="0 0 10 10" refX="9" refY="5" markerWidth="8" markerHeight="8" orient="auto-start-reverse"><path d="M0 0 L10 5 L0 10 z" fill="context-stroke"/></marker></defs></svg>${html}<div class="wb-chrome" id="dkChrome"></div>`;
  hydrate(canvas);
  paintConns(); applyTransform(); paintChrome();
  const board = $('#dkBoard');
  board.onpointerdown = onBoardDown;
  board.addEventListener('wheel', onBoardWheel, { passive: false });
  board.ondblclick = onBoardDblClick;
  board.oncontextmenu = onBoardContext;
  $$('.wb-deck', canvas).forEach((node) => wireDeck(node, item(node.dataset.item)));
}
const curIndex = (d) => (ed.ssel?.deck === d.id ? ed.ssel.i : -1);
const selSet = (d) => (ed.ssel?.deck === d.id && ed.sslides.size ? new Set([...ed.sslides, ed.ssel.i]) : null);

function wireDeck(node, d) {
  $$('.dk-stage', node).forEach((st) => { st.addEventListener('pointerdown', onStageDown); st.addEventListener('dblclick', onStageDblClick); });
  $$('.dk-fhead', node).forEach((h) => {
    h.onpointerdown = (e) => { if (e.button !== 0) return; e.stopPropagation(); const i = +h.dataset.fhead; if (e.shiftKey && ed.ssel?.deck === d.id) { toggleSlideSel(i); return; } if (!(ed.ssel?.deck === d.id && (ed.ssel.i === i || ed.sslides.has(i)))) selectSlide(d.id, i); startSlideDrag(e, d, i, h.closest('.dk-frame')); };
    h.oncontextmenu = (e) => { e.preventDefault(); e.stopPropagation(); const i = +h.dataset.fhead; if (!(ed.ssel?.deck === d.id && ed.sslides.has(i))) selectSlide(d.id, i); slideMenu(e, d, i); };
  });
  const tab = $('[data-decktab]', node);
  if (tab) {
    tab.onpointerdown = (e) => { if (e.button !== 0 || tab.isContentEditable) return; e.stopPropagation(); if (!ed.sel.has(d.id) || ed.ssel) { ed.ssel = null; ed.sslides = new Set(); select([d.id], e.shiftKey); } startItemDrag(e, 'move'); };
    tab.ondblclick = (e) => { e.stopPropagation(); renameDeck(d, tab); };
  }
  const grip = $('[data-deckgrip]', node);
  if (grip) grip.onpointerdown = (e) => { if (e.button !== 0) return; e.stopPropagation(); ed.ssel = null; ed.sslides = new Set(); if (!ed.sel.has(d.id)) select([d.id], e.shiftKey); startItemDrag(e, 'move'); };
  $$('.dk-insert', node).forEach((b) => {
    b.onpointerdown = (e) => e.stopPropagation();
    b.onclick = (e) => {
      e.stopPropagation();
      const at = +b.dataset.insert;
      if (d.slides.length === 1) { d.orient = b.dataset.orient === 'col' ? 'col' : 'row'; }
      layoutMenu(e, d, at);
    };
  });
}

function toggleSlideSel(i) {
  if (ed.sslides.has(i)) ed.sslides.delete(i); else ed.sslides.add(i);
  ed.sslides.add(ed.ssel.i);
  paintFrameSel(); paintPanel();
}
function paintFrameSel() {
  const d = deckOf(); if (!d) return;
  const set = selSet(d) || new Set([ed.ssel.i]);
  $$(`.wb-deck[data-item="${d.id}"] .dk-frame`).forEach((f) => f.classList.toggle('on', set.has(+f.dataset.i)));
}

// Slide reorder by the head bar; neighbours shift, the drop reorders.
function startSlideDrag(e, d, from, frameNode) {
  const p = boardPoint(e);
  ed.drag = { mode: 'slide', d, from, to: from, node: frameNode, sx: p.x, sy: p.y, moved: false };
  frameNode.classList.add('dragging');
  e.preventDefault();
}
function moveSlideDrag(e) {
  const dr = ed.drag; const p = boardPoint(e);
  const col = dr.d.orient === 'col';
  const delta = col ? p.y - dr.sy : p.x - dr.sx;
  if (Math.abs(delta) > 4 / ed.bd.z) dr.moved = true;
  if (!dr.moved) return;
  const pitch = (col ? DECK_FRAME_H : DECK_FRAME_W) + DECK_GAP;
  dr.node.style.transform = col ? `translateY(${delta}px)` : `translateX(${delta}px)`;
  const to = clamp(Math.round(dr.from + delta / pitch), 0, dr.d.slides.length - 1);
  if (to !== dr.to) {
    dr.to = to;
    $$('.dk-frame', dr.node.closest('.wb-deck')).forEach((f) => {
      const i = +f.dataset.i; if (i === dr.from) return;
      f.classList.add('shifting');
      let shift = 0;
      if (dr.from < to && i > dr.from && i <= to) shift = -pitch;
      if (dr.from > to && i >= to && i < dr.from) shift = pitch;
      f.style.transform = shift ? (col ? `translateY(${shift}px)` : `translateX(${shift}px)`) : '';
    });
  }
}
function endSlideDrag(dr) {
  dr.node.classList.remove('dragging');
  if (dr.moved && dr.to !== dr.from) {
    const [sl] = dr.d.slides.splice(dr.from, 1); dr.d.slides.splice(dr.to, 0, sl);
    ed.sslides = new Set();
    commit(); repaintDeck(dr.d); selectSlide(dr.d.id, dr.to); if (ed.view === 'slide') paintRail();
  } else repaintDeck(dr.d);
}

// -- smooth transform: wheel deltas accumulate and apply once per frame.
function applyTransform() {
  const c = $('#dkCanvas'); const b = $('#dkBoard'); if (!c) return;
  const { x, y, z } = ed.bd;
  c.style.transform = `translate3d(${x}px, ${y}px, 0) scale(${z})`;
  c.style.setProperty('--inv', String(1 / z));
  const s = settings();
  b.style.background = s.bg;
  if (s.grid === 'none') b.style.backgroundImage = 'none';
  else {
    const g = s.gridSize * z;
    b.style.backgroundImage = s.grid === 'lines'
      ? 'linear-gradient(to right, rgb(0 0 0 / 0.06) 1px, transparent 1px), linear-gradient(to bottom, rgb(0 0 0 / 0.06) 1px, transparent 1px)'
      : 'radial-gradient(circle, rgb(0 0 0 / 0.14) 1px, transparent 1.2px)';
    b.style.backgroundSize = `${g}px ${g}px`; b.style.backgroundPosition = `${x}px ${y}px`;
  }
  const pct = $('#dkZoomPct'); if (pct) pct.textContent = `${Math.round(z * 100)}%`;
}
function scheduleTransform() {
  if (ed.raf) return;
  // One apply per frame; the timer is the backstop for a window the
  // compositor is not painting (the suite's hidden-pane lesson).
  const run = () => { if (!ed) return; cancelAnimationFrame(ed.raf); clearTimeout(ed.rafT); ed.raf = 0; const p = ed.pend; ed.pend = null; if (p) applyPending(p); applyTransform(); };
  ed.raf = requestAnimationFrame(run);
  ed.rafT = setTimeout(run, 40);
}
function applyPending(p) {
  const b = ed.bd;
  if (p.dx || p.dy) { b.x -= p.dx; b.y -= p.dy; }
  if (p.zf && p.zf !== 1) {
    const next = clamp(b.z * p.zf, 0.05, 4);
    b.x = p.px - (p.px - b.x) * (next / b.z); b.y = p.py - (p.py - b.y) * (next / b.z); b.z = next;
  }
}
function onBoardWheel(e) {
  e.preventDefault();
  const r = $('#dkBoard').getBoundingClientRect();
  const p = ed.pend || (ed.pend = { dx: 0, dy: 0, zf: 1, px: 0, py: 0 });
  if (e.ctrlKey || e.metaKey) {
    // Pinch: Figma-like gain, clamped per frame rather than per event so a
    // coalesced burst still lands smoothly.
    p.zf = clamp(p.zf * Math.exp(-e.deltaY * 0.01), 0.6, 1.6);
    p.px = e.clientX - r.left; p.py = e.clientY - r.top;
  } else {
    const k = e.deltaMode === 1 ? 16 : 1;
    p.dx += e.deltaX * k; p.dy += e.deltaY * k;
  }
  scheduleTransform();
}
function zoomAt(next, px, py) { const b = ed.bd; next = clamp(next, 0.05, 4); b.x = px - (px - b.x) * (next / b.z); b.y = py - (py - b.y) * (next / b.z); b.z = next; applyTransform(); }
function zoomBy(f) { const r = $('#dkBoard').getBoundingClientRect(); zoomAt(ed.bd.z * f, r.width / 2, r.height / 2); }
function fitToContent() {
  const board = $('#dkBoard'); if (!board) return;
  const boxes = ed.board.items.filter(isBox);
  if (!boxes.length) { ed.bd = { x: 40, y: 40, z: 0.5 }; applyTransform(); return; }
  const bb = union(boxes);
  const r = board.getBoundingClientRect();
  if (r.width < 100 || r.height < 100) { ed.bd = { x: 40, y: 40, z: 0.5 }; applyTransform(); setTimeout(() => { if (ed && $('#dkBoard')?.getBoundingClientRect().width >= 100) fitToContent(); }, 400); return; }
  const z = clamp(Math.min((r.width - 120) / bb.w, (r.height - 160) / bb.h), 0.05, 1.5);
  ed.bd = { z, x: (r.width - bb.w * z) / 2 - bb.x * z, y: (r.height - 60 - bb.h * z) / 2 - bb.y * z + 20 };
  applyTransform();
}
function boardPoint(e) { const r = $('#dkBoard').getBoundingClientRect(); return { x: (e.clientX - r.left - ed.bd.x) / ed.bd.z, y: (e.clientY - r.top - ed.bd.y) / ed.bd.z }; }
function union(items) {
  const x1 = Math.min(...items.map((i) => i.x)); const y1 = Math.min(...items.map((i) => i.y));
  const x2 = Math.max(...items.map((i) => i.x + i.w)); const y2 = Math.max(...items.map((i) => i.y + i.h));
  return { x: x1, y: y1, w: x2 - x1, h: y2 - y1 };
}

// -- connectors
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
  svg.innerHTML = defs + ed.board.items.filter((i) => i.kind === 'connector').map((c) => {
    const a = item(c.from); const b = item(c.to); if (!a || !b) return '';
    const p = anchor(a, b); const q = anchor(b, a);
    return `<path data-conn="${c.id}" d="M${p.x} ${p.y} L${q.x} ${q.y}" stroke="${c.color}" stroke-width="3" fill="none" ${c.head ? 'marker-end="url(#wbArrow)"' : ''} class="${ed.sel.has(c.id) ? 'on' : ''}"/><path data-connhit="${c.id}" d="M${p.x} ${p.y} L${q.x} ${q.y}" stroke="transparent" stroke-width="18" fill="none"/>`;
  }).join('');
  $$('[data-connhit]', svg).forEach((h) => { h.onpointerdown = (e) => { e.stopPropagation(); select([h.dataset.connhit], e.shiftKey); }; });
}

// -- chrome
function paintChrome() {
  const chrome = $('#dkChrome'); if (!chrome) return;
  $$('.dk-chrome').forEach((c) => { c.innerHTML = ''; });
  chrome.innerHTML = '';
  $$('.wb-deck').forEach((n) => n.classList.toggle('on', ed.sel.has(n.dataset.item) && !(ed.ssel && ed.ssel.deck === n.dataset.item)));
  const el = selEl();
  if (el && ed.ssel) {
    const c = $(`.dk-chrome[data-chrome="${ed.ssel.deck}:${ed.ssel.i}"]`);
    if (c) {
      c.innerHTML = `<div class="dk-selbox" style="left:${(el.x / SLIDE_W) * 100}%;top:${(el.y / SLIDE_H) * 100}%;width:${(el.w / SLIDE_W) * 100}%;height:${(el.h / SLIDE_H) * 100}%"><span class="dk-grip" data-g="nw"></span><span class="dk-grip" data-g="ne"></span><span class="dk-grip" data-g="sw"></span><span class="dk-grip" data-g="se"></span></div>`;
      $$('.dk-grip', c).forEach((g) => { g.onpointerdown = (ev) => { ev.stopPropagation(); startElDrag(ev, 'resize', g.dataset.g); }; });
      $('.dk-selbox', c).onpointerdown = (ev) => { ev.stopPropagation(); startElDrag(ev, 'move'); };
    }
  }
  if (ed.dsel && ed.ssel) {
    const c = $(`.dk-chrome[data-chrome="${ed.ssel.deck}:${ed.ssel.i}"]`);
    const s = slideOf(); const x = s && dgmOf(s).elements.find((q) => q.id === ed.dsel);
    if (c && x) {
      const b = DG.bbox(x); const mode = s.bgImage?.mode || 'none';
      const p1 = DG.fromUnits({ x: b.x, y: b.y }, mode); const p2 = DG.fromUnits({ x: b.x + b.w, y: b.y + b.h }, mode);
      c.innerHTML += `<div class="dk-dgmsel" style="left:${(p1.x / SLIDE_W) * 100}%;top:${(p1.y / SLIDE_H) * 100}%;width:${((p2.x - p1.x) / SLIDE_W) * 100}%;height:${((p2.y - p1.y) / SLIDE_H) * 100}%"></div>`;
    }
  }
  const items = selItems().filter((it) => isBox(it) && it.kind !== 'deck');
  if (!items.length) return;
  const single = items.length === 1 ? items[0] : null;
  chrome.innerHTML = items.map((it) => `<div class="wb-selbox ${single ? '' : 'multi'}" data-selbox="${it.id}" style="left:${it.x}px;top:${it.y}px;width:${it.w}px;height:${it.h}px">${single && !it.locked ? '<span class="dk-grip" data-g="nw"></span><span class="dk-grip" data-g="ne"></span><span class="dk-grip" data-g="sw"></span><span class="dk-grip" data-g="se"></span>' : ''}</div>`).join('')
    + (single ? '' : (() => { const u = union(items); return `<div class="wb-selunion" style="left:${u.x}px;top:${u.y}px;width:${u.w}px;height:${u.h}px"></div>`; })());
  $$('.dk-grip', chrome).forEach((g) => { g.onpointerdown = (ev) => { ev.stopPropagation(); startItemDrag(ev, 'resize', g.dataset.g); }; });
  $$('.wb-selbox, .wb-selunion', chrome).forEach((b) => { b.onpointerdown = (ev) => { if (ev.button !== 0) return; ev.stopPropagation(); startItemDrag(ev, 'move'); }; });
}
function paintGuides(guides, scope) {
  // scope: 'board' -> #dkChrome in board px; { stage } -> the frame chrome in %
  if (scope === 'board') {
    const chrome = $('#dkChrome'); if (!chrome) return;
    $$('.wb-guide', chrome).forEach((g) => g.remove());
    chrome.insertAdjacentHTML('beforeend', guides.map((g) => (g.v != null ? `<div class="wb-guide v" style="left:${g.v}px;top:${g.from}px;height:${g.to - g.from}px"></div>` : `<div class="wb-guide h" style="top:${g.h}px;left:${g.from}px;width:${g.to - g.from}px"></div>`)).join(''));
  } else {
    const c = $(`.dk-chrome[data-chrome="${ed.ssel.deck}:${ed.ssel.i}"]`); if (!c) return;
    $$('.dk-guide', c).forEach((g) => g.remove());
    c.insertAdjacentHTML('beforeend', guides.map((g) => (g.v != null ? `<div class="dk-guide v" style="left:${(g.v / SLIDE_W) * 100}%"></div>` : `<div class="dk-guide h" style="top:${(g.h / SLIDE_H) * 100}%"></div>`)).join(''));
  }
}

// -- snapping: the moving box against candidate edges/centres.
function snapBox(box, cands, thr) {
  const guides = []; let dx = 0; let dy = 0; let bestX = thr + 1; let bestY = thr + 1;
  const mx = [box.x, box.x + box.w / 2, box.x + box.w]; const my = [box.y, box.y + box.h / 2, box.y + box.h];
  for (const c of cands) {
    const cx = [c.x, c.x + c.w / 2, c.x + c.w]; const cy = [c.y, c.y + c.h / 2, c.y + c.h];
    for (const a of mx) for (const b of cx) { const d = Math.abs(a - b); if (d < bestX) { bestX = d; dx = b - a; guides.length && guides.splice(0, guides.length, ...guides.filter((g) => g.v == null)); guides.push({ v: b, from: Math.min(box.y, c.y), to: Math.max(box.y + box.h, c.y + c.h) }); } }
    for (const a of my) for (const b of cy) { const d = Math.abs(a - b); if (d < bestY) { bestY = d; dy = b - a; guides.splice(0, guides.length, ...guides.filter((g) => g.h == null)); guides.push({ h: b, from: Math.min(box.x, c.x), to: Math.max(box.x + box.w, c.x + c.w) }); } }
  }
  if (bestX > thr) { dx = 0; guides.splice(0, guides.length, ...guides.filter((g) => g.v == null)); }
  if (bestY > thr) { dy = 0; guides.splice(0, guides.length, ...guides.filter((g) => g.h == null)); }
  return { dx, dy, guides };
}

// ------------------------------------------------------------- selection

function select(ids, add = false) {
  if (!add) ed.sel = new Set();
  for (const id of ids) { if (add && ed.sel.has(id)) ed.sel.delete(id); else ed.sel.add(id); }
  if (ids.length && !ids.every((id) => item(id)?.kind === 'deck')) { ed.ssel = null; ed.sslides = new Set(); ed.dsel = null; }
  paintChrome(); paintPanel(); paintConns();
}
function clearSel() { ed.sel = new Set(); ed.ssel = null; ed.sslides = new Set(); ed.dsel = null; $$('.dk-frame.on').forEach((f) => f.classList.remove('on')); paintChrome(); paintPanel(); paintConns(); }
function selectSlide(deckId, i, elId = null) {
  if (!(ed.ssel && ed.ssel.deck === deckId && ed.ssel.i === i)) ed.sslides = new Set();
  ed.ssel = { deck: deckId, i, el: elId };
  ed.dsel = null;
  ed.focus = deckId;
  ed.sel = new Set([deckId]);
  $$('.dk-frame').forEach((f) => { const d = f.closest('.wb-deck')?.dataset.item; f.classList.toggle('on', d === deckId && (+f.dataset.i === i || ed.sslides.has(+f.dataset.i))); });
  paintChrome(); paintPanel(); paintNotes(); paintConns();
}

// ------------------------------------------------------------- pointers (board)

function onBoardDown(e) {
  if (e.button === 1 || ed.space || ed.tool === 'hand') { startPan(e); return; }
  if (e.button !== 0) return;
  const p = boardPoint(e); const target = e.target;
  if (ed.place) { placeOnBoard(p); return; }
  const tool = ed.tool;
  if (['sticky', 'text', 'section', 'shape', 'deck'].includes(tool)) { startCreate(e, p); return; }
  if (tool === 'pen') { startPen(e, p); return; }
  if (tool === 'connector') { startConnector(e, target); return; }
  if (tool.startsWith('dg-')) return; // diagram tools only act on a slide
  const node = target.closest('.wb-item');
  if (!node) { clearSel(); startMarquee(e); return; }
  const it = item(node.dataset.item); if (!it) return;
  if (it.kind === 'deck') { clearSel(); startMarquee(e); return; }
  if (!ed.sel.has(it.id)) select([it.id], e.shiftKey);
  else if (e.shiftKey) { select([it.id], true); return; }
  if (!it.locked) startItemDrag(e, 'move');
}
function startPan(e) { ed.drag = { mode: 'pan', sx: e.clientX, sy: e.clientY, ox: ed.bd.x, oy: ed.bd.y }; $('#dkBoard').classList.add('is-panning'); e.preventDefault(); }
function startMarquee(e) { const p = boardPoint(e); ed.drag = { mode: 'marquee', sx: p.x, sy: p.y, moved: false }; }
function startItemDrag(e, mode, grip) {
  const items = selItems().filter((i) => isBox(i) && !i.locked); if (!items.length) return;
  const p = boardPoint(e);
  const carried = [];
  for (const s of items) if (s.kind === 'section') for (const it of ed.board.items) if (isBox(it) && it.kind !== 'section' && !ed.sel.has(it.id) && inside(it, s)) carried.push(it);
  ed.drag = { mode: mode === 'move' ? 'items' : 'resize', grip, sx: p.x, sy: p.y, moved: false, start: [...items, ...carried].map((it) => ({ it, x: it.x, y: it.y, w: it.w, h: it.h, pts: it.points ? it.points.map((q) => [...q]) : null })) };
  e.preventDefault();
}
const inside = (it, s) => it.x + it.w / 2 >= s.x && it.x + it.w / 2 <= s.x + s.w && it.y + it.h / 2 >= s.y && it.y + it.h / 2 <= s.y + s.h;
function startCreate(e, p) { ed.drag = { mode: 'create', sx: p.x, sy: p.y, moved: false }; e.preventDefault(); }
function startPen(e, p) {
  const ts = TB.styleOf('pen');
  const it = newPen({ x: p.x, y: p.y, points: [[0, 0]], color: ts.color, width: ts.width });
  ed.board.items.push(it);
  $('#dkChrome').insertAdjacentHTML('beforebegin', itemHtml(it));
  ed.drag = { mode: 'pen', it, node: $(`.wb-item[data-item="${it.id}"]`, $('#dkCanvas')), minx: 0, miny: 0, maxx: 0, maxy: 0 };
  e.preventDefault();
}
function startConnector(e, target) {
  const node = target.closest('.wb-item'); if (!node) return;
  const from = item(node.dataset.item); const p = boardPoint(e);
  $('#dkConns').insertAdjacentHTML('beforeend', `<path id="dkConnDraft" d="M${p.x} ${p.y} L${p.x} ${p.y}" stroke="#3392ff" stroke-width="3" stroke-dasharray="8 6" fill="none"/>`);
  ed.drag = { mode: 'conn', from, sx: p.x, sy: p.y };
  e.preventDefault();
}

function onPointerMove(e) {
  if (!ed || !ed.drag) return;
  const d = ed.drag;
  if (d.mode === 'pan') { ed.bd.x = d.ox + (e.clientX - d.sx); ed.bd.y = d.oy + (e.clientY - d.sy); scheduleTransform(); return; }
  if (d.mode === 'el') { moveEl(e); return; }
  if (d.mode === 'dgm') { moveDgm(e); return; }
  if (d.mode === 'dgline' || d.mode === 'dgpen') { drawDgm(e); return; }
  if (d.mode === 'slide') { moveSlideDrag(e); return; }
  if (!$('#dkBoard')) return;
  const p = boardPoint(e); const dx = p.x - d.sx; const dy = p.y - d.sy;
  if (Math.abs(dx) + Math.abs(dy) > 2 / ed.bd.z) d.moved = true;
  if (d.mode === 'marquee' || d.mode === 'create') {
    const m = $('#dkMarquee');
    const x1 = Math.min(d.sx, p.x); const y1 = Math.min(d.sy, p.y); const w = Math.abs(dx); const h = Math.abs(dy);
    m.hidden = !d.moved;
    Object.assign(m.style, { left: `${x1 * ed.bd.z + ed.bd.x}px`, top: `${y1 * ed.bd.z + ed.bd.y}px`, width: `${w * ed.bd.z}px`, height: `${h * ed.bd.z}px` });
    d.rect = { x: x1, y: y1, w, h };
    return;
  }
  if (d.mode === 'items') {
    let sdx = Math.round(dx); let sdy = Math.round(dy);
    if (settings().snap) { sdx = snapV(d.start[0].x + dx) - d.start[0].x; sdy = snapV(d.start[0].y + dy) - d.start[0].y; }
    let guides = [];
    if (settings().snapObjects !== false) {
      const moving = new Set(d.start.map((s) => s.it.id));
      const u = union(d.start.map((s) => ({ x: s.x + sdx, y: s.y + sdy, w: s.w, h: s.h })));
      const cands = ed.board.items.filter((it) => isBox(it) && !moving.has(it.id));
      const r = snapBox(u, cands, 8 / ed.bd.z);
      sdx += r.dx; sdy += r.dy; guides = r.guides;
    }
    for (const s of d.start) { s.it.x = s.x + sdx; s.it.y = s.y + sdy; placeNode(s.it); }
    paintChrome(); paintGuides(guides, 'board'); paintConns();
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
    placeNode(it, true); paintChrome(); paintConns();
    return;
  }
  if (d.mode === 'pen') {
    const it = d.it; const lx = p.x - it.x; const ly = p.y - it.y;
    it.points.push([lx, ly]);
    d.minx = Math.min(d.minx, lx); d.miny = Math.min(d.miny, ly); d.maxx = Math.max(d.maxx, lx); d.maxy = Math.max(d.maxy, ly);
    $('path', d.node).setAttribute('d', it.points.map((q, i) => `${i ? 'L' : 'M'}${q[0]} ${q[1]}`).join(' '));
    return;
  }
  if (d.mode === 'conn') { const draft = $('#dkConnDraft'); if (draft) draft.setAttribute('d', `M${d.sx} ${d.sy} L${p.x} ${p.y}`); }
}
function placeNode(it, resized = false) {
  const n = $(`.wb-item[data-item="${it.id}"]`, $('#dkCanvas')); if (!n) return;
  n.style.left = `${it.x}px`; n.style.top = `${it.y}px`;
  if (resized) {
    n.style.width = `${it.w}px`; n.style.height = `${it.h}px`;
    if (it.kind === 'pen') { const svg = $('svg', n); svg.setAttribute('width', it.w); svg.setAttribute('height', it.h); svg.setAttribute('viewBox', `0 0 ${it.w} ${it.h}`); $('path', svg).setAttribute('d', it.points.map((q, i) => `${i ? 'L' : 'M'}${q[0]} ${q[1]}`).join(' ')); }
  }
}

function onPointerUp(e) {
  if (!ed || !ed.drag) return;
  const d = ed.drag; ed.drag = null;
  if (d.mode === 'pan') { $('#dkBoard')?.classList.remove('is-panning'); return; }
  if (d.mode === 'el') { paintGuides([], 'slide'); if (d.moved) { commit(); paintPanel(); paintRailSoon(); } else if (d.wasSel && d.el.type === 'text') { const node = $(`.dk-el[data-el="${d.el.id}"]`, d.stage); if (node) editSlideText(node, deckOf(), ed.ssel.i, d.el, e); } return; }
  if (d.mode === 'dgm') { if (d.moved) commit(); return; }
  if (d.mode === 'dgline' || d.mode === 'dgpen') { endDgmDraw(d); return; }
  if (d.mode === 'slide') { endSlideDrag(d); return; }
  if (d.mode === 'marquee') {
    const m = $('#dkMarquee'); if (m) m.hidden = true;
    if (d.moved && d.rect) {
      const r = d.rect;
      const hitR = (it) => it.x < r.x + r.w && it.x + it.w > r.x && it.y < r.y + r.h && it.y + it.h > r.y;
      // Frames inside one deck: a rubber band over slides selects those slides.
      const frameHits = [];
      for (const dk of boardDecks(ed.board)) dk.slides.forEach((s, i) => { const fb = frameBox(dk, i); if (hitR(fb)) frameHits.push({ dk, i }); });
      if (frameHits.length && frameHits.every((h) => h.dk === frameHits[0].dk)) {
        const dk = frameHits[0].dk;
        // selectSlide resets the multi-set when the slide changes, so set
        // the set AFTER it.
        selectSlide(dk.id, frameHits[0].i);
        ed.sslides = new Set(frameHits.map((h) => h.i));
        paintFrameSel(); paintPanel();
        return;
      }
      select(ed.board.items.filter((it) => isBox(it) && it.kind !== 'deck' && hitR(it)).map((it) => it.id), e.shiftKey);
    }
    return;
  }
  if (d.mode === 'items' || d.mode === 'resize') { paintGuides([], 'board'); if (d.moved) commit(); paintPanel(); return; }
  if (d.mode === 'create') {
    const m = $('#dkMarquee'); if (m) m.hidden = true;
    const r = d.moved && d.rect && d.rect.w > 12 ? d.rect : null;
    createAt(ed.tool, r ? r.x : d.sx, r ? r.y : d.sy, r);
    return;
  }
  if (d.mode === 'pen') {
    const it = d.it;
    if (it.points.length < 2) { ed.board.items = ed.board.items.filter((x) => x !== it); paintBoard(); return; }
    const pad = it.width; const ox = d.minx - pad; const oy = d.miny - pad;
    it.x += ox; it.y += oy; it.points = it.points.map(([px, py]) => [px - ox, py - oy]);
    it.w = Math.max(1, d.maxx - d.minx + pad * 2); it.h = Math.max(1, d.maxy - d.miny + pad * 2);
    commit(); paintBoard();
    return;
  }
  if (d.mode === 'conn') {
    $('#dkConnDraft')?.remove();
    const node = document.elementFromPoint(e.clientX, e.clientY)?.closest('.wb-item');
    const to = node ? item(node.dataset.item) : null;
    if (to && to.id !== d.from.id) { const cs = TB.styleOf('connector'); const c = newConnector(d.from.id, to.id, { color: cs.color, head: cs.head !== false }); ed.board.items.push(c); commit(); paintConns(); select([c.id]); }
  }
}
const frameBox = (dk, i) => (dk.orient === 'col' ? { x: dk.x, y: dk.y + i * (DECK_FRAME_H + DECK_GAP), w: DECK_FRAME_W, h: DECK_FRAME_H } : { x: dk.x + i * (DECK_FRAME_W + DECK_GAP), y: dk.y, w: DECK_FRAME_W, h: DECK_FRAME_H });

function createAt(tool, x, y, rect) {
  const s = settings(); let it = null;
  const sx = snapV(x); const sy = snapV(y);
  const size = rect ? { w: Math.round(rect.w), h: Math.round(rect.h) } : {};
  const ts = TB.styleOf(tool);
  if (tool === 'sticky') it = newSticky({ x: sx, y: sy, color: ts.color || ed.prefs.stickyColor || s.stickyColor, w: ts.w, h: ts.h, ...size });
  else if (tool === 'text') it = newBoardText({ x: sx, y: sy, size: ts.size, color: ts.color, ...size });
  else if (tool === 'section') it = newSection({ x: sx, y: sy, color: ts.color, w: ts.w, h: ts.h, ...size });
  else if (tool === 'shape') it = newBoardShape(ed.shape || 'rect', { x: sx, y: sy, fill: ts.outline ? 'transparent' : ts.fill, stroke: ts.stroke, sw: ts.width, alpha: ts.alpha, radius: ts.radius, w: ts.w, h: ts.h, ...size });
  else if (tool === 'deck') it = newDeckItem(newDeck('Untitled Deck'), { x: sx, y: sy });
  if (!it) return;
  if (it.kind === 'section') ed.board.items.unshift(it); else ed.board.items.push(it);
  commit(); paintBoard(); select([it.id]);
  if (it.kind === 'sticky' || it.kind === 'text') editItemText(it);
  if (it.kind === 'deck') selectSlide(it.id, 0);
  if (tool !== 'shape' && tool !== 'sticky') armTool('select');
}

function placeOnBoard(p) {
  const pl = ed.place; let it = null;
  if (pl.kind === 'image') { const w = pl.w || TB.styleOf('image').w || 480; const h = pl.h || Math.round(w * 0.625); it = newBoardImage(pl.asset, { x: snapV(p.x - w / 2), y: snapV(p.y - h / 2), w, h }); }
  if (pl.kind === 'video') it = newBoardVideo(pl.asset, { x: snapV(p.x - 320), y: snapV(p.y - 180) });
  if (pl.kind === 'diagram') it = newBoardDiagram(pl.drill, { x: snapV(p.x - 320), y: snapV(p.y - 160) });
  if (pl.kind === 'text') it = newBoardText({ x: snapV(p.x), y: snapV(p.y) });
  if (pl.kind === 'shape') { const ts = TB.styleOf('shape'); it = newBoardShape(pl.shape, { x: snapV(p.x - ts.w / 2), y: snapV(p.y - ts.h / 2), fill: ts.outline ? 'transparent' : ts.fill, stroke: ts.stroke, sw: ts.width, alpha: ts.alpha, radius: ts.radius, w: ts.w, h: ts.h }); }
  if (!it) { armTool('select'); return; }
  ed.board.items.push(it);
  if (!pl.sticky) armTool('select');
  commit(); paintBoard(); select([it.id]);
}

function onBoardDblClick(e) {
  const node = e.target.closest('.wb-item');
  if (!node) { fitToContent(); return; }
  const it = item(node.dataset.item); if (!it || it.locked) return;
  if (e.target.closest('[data-decktab]')) { renameDeck(it, e.target.closest('[data-decktab]')); return; }
  if (['sticky', 'text', 'shape', 'section'].includes(it.kind)) editItemText(it);
}
function editItemText(it) {
  const node = $(`.wb-item[data-item="${it.id}"]`, $('#dkCanvas')); if (!node) return;
  let body = $('.wb-sticky-text, .wb-text-body, .wb-shape-label, .wb-section-title', node);
  if (!body && it.kind === 'shape') { node.insertAdjacentHTML('beforeend', '<div class="wb-shape-label"></div>'); body = $('.wb-shape-label', node); }
  if (!body) return;
  body.contentEditable = 'plaintext-only'; body.focus();
  const range = document.createRange(); range.selectNodeContents(body);
  const s = getSelection(); s.removeAllRanges(); s.addRange(range);
  let done = false;
  const finish = () => { if (done) return; done = true; body.contentEditable = 'false'; const v = body.innerText.replace(/\n$/, ''); if (it.kind === 'section') it.title = v; else it.text = v; commit(); paintBoard(); paintChrome(); paintPanel(); };
  body.onblur = finish;
  body.onkeydown = (ev) => { ev.stopPropagation(); if (ev.key === 'Escape' || (ev.key === 'Enter' && !ev.shiftKey && it.kind !== 'sticky' && it.kind !== 'text')) { ev.preventDefault(); body.blur(); } };
}
function renameDeck(it, nameEl) {
  nameEl.contentEditable = 'plaintext-only'; nameEl.focus();
  const range = document.createRange(); range.selectNodeContents(nameEl); const s = getSelection(); s.removeAllRanges(); s.addRange(range);
  const done = () => { nameEl.contentEditable = 'false'; it.name = nameEl.innerText.trim() || 'Untitled Deck'; commit(); paintBoard(); };
  nameEl.onblur = done;
  nameEl.onkeydown = (ev) => { ev.stopPropagation(); if (ev.key === 'Enter' || ev.key === 'Escape') { ev.preventDefault(); nameEl.blur(); } };
}

function onBoardContext(e) {
  const node = e.target.closest('.wb-item'); e.preventDefault();
  if (!node) { menuAt(e, [{ label: 'Paste Here', run: () => pasteAt(boardPoint(e)) }, { label: 'Zoom to Fit', run: fitToContent }, { label: 'Board Settings…', run: openSettingsSheet }]); return; }
  const it = item(node.dataset.item);
  if (!ed.sel.has(it.id)) select([it.id]);
  itemMenu(e, it);
}
function itemMenu(e, it) {
  const many = ed.sel.size > 1;
  const items = [
    { label: 'Duplicate', run: duplicateSel }, { label: 'Copy', run: copySel }, '-',
    { label: 'Bring to Front', run: () => reorder('front') }, { label: 'Bring Forward', run: () => reorder('up') },
    { label: 'Send Backward', run: () => reorder('down') }, { label: 'Send to Back', run: () => reorder('back') }, '-',
    { label: it.locked ? 'Unlock' : 'Lock', run: () => { for (const s of selItems()) s.locked = !it.locked; commit(); paintBoard(); paintChrome(); } },
  ];
  if (it.kind === 'deck' && !many) items.push('-', { label: 'New Slide', run: (ev) => layoutMenu(ev || e, it) }, { label: it.orient === 'col' ? 'Lay Out as a Row' : 'Lay Out as a Column', run: () => { it.orient = it.orient === 'col' ? 'row' : 'col'; normalizeBoard(ed.board); commit(); paintBoard(); } }, { label: 'Open in Slide View', run: () => setView('slide', it.id) }, { label: 'Present', run: () => presentDeck(it) });
  items.push('-', { label: 'Delete', run: deleteSel });
  menuAt(e, items);
}
function reorder(how) {
  const ids = ed.sel; const arr = ed.board.items;
  const picked = arr.filter((i) => ids.has(i.id)); const rest = arr.filter((i) => !ids.has(i.id));
  if (how === 'front') ed.board.items = [...rest, ...picked];
  else if (how === 'back') ed.board.items = [...picked, ...rest];
  else for (const it of picked) { const i = arr.indexOf(it); const j = how === 'up' ? Math.min(arr.length - 1, i + 1) : Math.max(0, i - 1); arr.splice(i, 1); arr.splice(j, 0, it); }
  commit(); paintBoard(); paintChrome();
}
function deleteSel() {
  if (!ed.sel.size) return;
  const ids = ed.sel;
  ed.board.items = ed.board.items.filter((i) => !ids.has(i.id) && !(i.kind === 'connector' && (ids.has(i.from) || ids.has(i.to))));
  ed.sel = new Set(); ed.ssel = null; ed.sslides = new Set();
  commit(); paintBoard(); paintPanel();
}
let clipboard = null;
function copySel() { if (ed.ssel && !selEl() && ed.sel.size === 1) { clipboard = { slides: selectedSlides().map(cloneSlide) }; return; } clipboard = { items: JSON.parse(JSON.stringify(selItems().filter(isBox))) }; }
function pasteAt(p) {
  if (!clipboard) return;
  if (clipboard.slides) { const d = deckOf() || focusDeck(); if (!d) return; const at = ed.ssel?.deck === d.id ? Math.max(ed.ssel.i, ...ed.sslides) + 1 : d.slides.length; const cs = clipboard.slides.map(cloneSlide); d.slides.splice(at, 0, ...cs); commit(); repaintDeck(d); selectSlide(d.id, at); return; }
  const list = clipboard.items; if (!list || !list.length) return;
  const u = union(list); const ids = [];
  for (const src of list) {
    const c = JSON.parse(JSON.stringify(src)); c.id = uid();
    if (c.kind === 'deck') c.slides = c.slides.map(cloneSlide);
    c.x = p ? p.x + (src.x - u.x) : src.x + 40; c.y = p ? p.y + (src.y - u.y) : src.y + 40;
    ed.board.items.push(c); ids.push(c.id);
  }
  commit(); paintBoard(); select(ids);
}
function duplicateSel() { copySel(); pasteAt(null); }
const selectedSlides = () => { const d = deckOf(); if (!d) return []; const set = selSet(d) || new Set([ed.ssel.i]); return [...set].sort((a, b) => a - b).map((i) => d.slides[i]).filter(Boolean); };
function duplicateSlides() {
  const d = deckOf(); if (!d) return;
  const idx = [...(selSet(d) || new Set([ed.ssel.i]))].sort((a, b) => a - b);
  const copies = idx.map((i) => cloneSlide(d.slides[i]));
  const at = idx[idx.length - 1] + 1;
  d.slides.splice(at, 0, ...copies);
  ed.sslides = new Set(copies.map((_, k) => at + k));
  commit(); repaintDeck(d); selectSlide(d.id, at); ed.sslides = new Set(copies.map((_, k) => at + k)); paintFrameSel(); if (ed.view === 'slide') paintRail();
}
function deleteSlides() {
  const d = deckOf(); if (!d) return;
  const idx = [...(selSet(d) || new Set([ed.ssel.i]))].sort((a, b) => b - a);
  if (d.slides.length - idx.length < 1) idx.pop();
  for (const i of idx) d.slides.splice(i, 1);
  const at = Math.min(Math.min(...idx, d.slides.length - 1), d.slides.length - 1);
  ed.sslides = new Set();
  commit(); repaintDeck(d); selectSlide(d.id, Math.max(0, at)); if (ed.view === 'slide') paintRail();
}

// ------------------------------------------------------------- pointers (slides)

function stagePoint(e, stage) { const r = stage.getBoundingClientRect(); return { x: ((e.clientX - r.left) / r.width) * SLIDE_W, y: ((e.clientY - r.top) / r.height) * SLIDE_H }; }
function currentStage() { if (!ed.ssel) return null; return $(`.wb-deck[data-item="${ed.ssel.deck}"] .dk-frame[data-i="${ed.ssel.i}"] .dk-stage`) || $('.dk-stagebox > .dk-stage'); }

function onStageDown(e) {
  if (e.button !== 0 || ed.space || ed.tool === 'hand') return;
  const stage = e.currentTarget; const frame = stage.closest('.dk-frame'); const deckNode = stage.closest('.wb-deck');
  const deckId = deckNode ? deckNode.dataset.item : ed.focus; const i = frame ? +frame.dataset.i : ed.ssel.i;
  const d = item(deckId); if (d?.locked) return;
  const p = stagePoint(e, stage);
  if (ed.place) { e.stopPropagation(); placeInSlide(d, i, p); return; }
  if (ed.tool.startsWith('dg-')) { e.stopPropagation(); startDgmTool(e, d, i, p, stage); return; }
  if (ed.tool !== 'select') return;
  e.stopPropagation();
  const elNode = e.target.closest('.dk-el');
  const s = d.slides[i];
  if (!elNode && s.dgm && s.dgm.elements.length) {
    const u = DG.toUnits(p, s.bgImage?.mode || 'none');
    const hitEl = DG.hit(s.dgm.elements, u);
    if (hitEl) { selectSlide(deckId, i); ed.dsel = hitEl.id; paintChrome(); paintPanel(); ed.drag = { mode: 'dgm', d, i, el: hitEl, stage, last: u, moved: false }; e.preventDefault(); return; }
  }
  const wasSel = !!(elNode && ed.ssel && ed.ssel.deck === deckId && ed.ssel.i === i && ed.ssel.el === elNode.dataset.el);
  selectSlide(deckId, i, elNode ? elNode.dataset.el : null);
  if (elNode) startElDrag(e, 'move', null, wasSel);
}

function placeInSlide(d, i, p) {
  const pl = ed.place; const s = d.slides[i]; let el = null;
  if (pl.kind === 'text') el = newText(pl.role, { x: p.x, y: p.y - 40 });
  else if (pl.kind === 'shape') el = newShape(pl.shape, { x: p.x - 200, y: p.y - 120, ...(pl.shape === 'line' || pl.shape === 'arrow' ? { w: 400, h: 40, y: p.y - 20 } : {}) });
  else if (pl.kind === 'image') { const w = pl.w ? pl.w * 1.667 : 800; const h = pl.h ? pl.h * 1.667 : 500; el = newImage(pl.asset, { x: p.x - w / 2, y: p.y - h / 2, w: Math.round(w), h: Math.round(h) }); }
  else if (pl.kind === 'video') el = newVideo(pl.asset, { x: p.x - 560, y: p.y - 315 });
  else if (pl.kind === 'diagram') el = newDiagram(pl.drill, { x: p.x - 480, y: p.y - 240 });
  if (!el) return;
  el.x = clamp(el.x, 0, SLIDE_W - el.w); el.y = clamp(el.y, 0, SLIDE_H - el.h);
  s.els.push(el);
  if (!pl.sticky) armTool('select');
  commit(); repaintDeck(d); selectSlide(d.id, i, el.id); paintRailSoon();
}

function startElDrag(e, mode, grip, wasSel = false) {
  const el = selEl(); const stage = currentStage(); if (!el || !stage) return;
  const p = stagePoint(e, stage);
  ed.drag = { mode: 'el', sub: mode, grip, stage, el, wasSel, sx: p.x, sy: p.y, ox: el.x, oy: el.y, ow: el.w, oh: el.h, moved: false };
  e.preventDefault();
}
function moveEl(e) {
  const d = ed.drag; const el = selEl(); if (!el) { ed.drag = null; return; }
  const p = stagePoint(e, d.stage); const dx = p.x - d.sx; const dy = p.y - d.sy;
  if (Math.abs(dx) + Math.abs(dy) > 2) d.moved = true;
  if (!d.moved) return;
  let guides = [];
  if (d.sub === 'move') {
    let x = Math.round(d.ox + dx); let y = Math.round(d.oy + dy);
    if (settings().snapObjects !== false) {
      const s = slideOf();
      const cands = s.els.filter((q) => q.id !== el.id).map((q) => ({ x: q.x, y: q.y, w: q.w, h: q.h }));
      cands.push({ x: 0, y: 0, w: SLIDE_W, h: SLIDE_H });
      const r = snapBox({ x, y, w: el.w, h: el.h }, cands, 10);
      x += r.dx; y += r.dy; guides = r.guides;
    }
    el.x = x; el.y = y;
  } else {
    const g = d.grip; let { ox: x, oy: y, ow: w, oh: h } = d;
    if (g.includes('e')) w = Math.max(24, d.ow + dx);
    if (g.includes('s')) h = Math.max(24, d.oh + dy);
    if (g.includes('w')) { w = Math.max(24, d.ow - dx); x = d.ox + (d.ow - w); }
    if (g.includes('n')) { h = Math.max(24, d.oh - dy); y = d.oy + (d.oh - h); }
    el.x = Math.round(x); el.y = Math.round(y); el.w = Math.round(w); el.h = Math.round(h);
  }
  const node = $(`.dk-el[data-el="${el.id}"]`, d.stage);
  if (node) { node.style.left = `${(el.x / SLIDE_W) * 100}%`; node.style.top = `${(el.y / SLIDE_H) * 100}%`; node.style.width = `${(el.w / SLIDE_W) * 100}%`; node.style.height = `${(el.h / SLIDE_H) * 100}%`; }
  paintChrome(); paintGuides(guides, 'slide');
}

// -- diagram tools on a slide
function startDgmTool(e, d, i, p, stage) {
  const t = TB.toolById(ed.tool); if (!t || !t.dgm) return;
  selectSlide(d.id, i);
  const s = d.slides[i]; const mode = s.bgImage?.mode || 'none'; const u = DG.toUnits(p, mode);
  const dgm = dgmOf(s); const id = uid(); const ts = TB.styleOf(t.id); const color = ts.color || 'black';
  const done = () => { ed.dsel = id; commit(); repaintDeck(d); selectSlide(d.id, i); ed.dsel = id; paintChrome(); paintPanel(); };
  if (t.dgm === 'player') { const pl = DG.newPlayer(t.color, ts.label || '', u, id); pl.r = ts.r || pl.r; dgm.elements.push(pl); done(); return; }
  if (t.dgm === 'stamp') { const st = DG.newStamp(t.kind, u, id); if (st) { const sc = ts.scale || 1; st.w = Math.round(st.w * sc); st.h = Math.round(st.h * sc); st.x = u.x - st.w / 2; st.y = u.y - st.h / 2; dgm.elements.push(st); done(); } return; }
  if (t.dgm === 'text') { const txt = prompt('Ice text'); if (!txt) return; const tx = DG.newDText(u, id, txt, color); tx.size = ts.size || tx.size; dgm.elements.push(tx); commit(); repaintDeck(d); selectSlide(d.id, i); return; }
  if (t.dgm === 'box') { const b = DG.newBox(t.kind, u, id, color); b.w = ts.w || b.w; b.h = ts.h || b.h; if (ts.outline) b.outline = true; if (ts.alpha != null) b.alpha = ts.alpha; dgm.elements.push(b); ed.drag = { mode: 'dgline', d, i, el: b, stage, bg: mode, u0: u, box: true }; e.preventDefault(); return; }
  if (t.dgm === 'line') { const a = DG.newLine(t.kind, u, id, color); a.width = ts.width || a.width; dgm.elements.push(a); ed.drag = { mode: 'dgline', d, i, el: a, stage, bg: mode, u0: u }; e.preventDefault(); return; }
  if (t.dgm === 'pen') { const pen = DG.newDPen(u, id, color); pen.width = ts.width || pen.width; dgm.elements.push(pen); ed.drag = { mode: 'dgpen', d, i, el: pen, stage, bg: mode }; e.preventDefault(); return; }
}
function drawDgm(e) {
  const d = ed.drag; const p = stagePoint(e, d.stage); const u = DG.toUnits(p, d.bg);
  const el = d.el;
  if (d.mode === 'dgpen' || el.type === 'pen') el.pts.push([u.x, u.y]);
  else if (el.type === 'arrow') { el.x2 = u.x; el.y2 = u.y; el.mx = (el.x1 + u.x) / 2; el.my = (el.y1 + u.y) / 2; }
  else { el.x = Math.min(d.u0.x, u.x); el.y = Math.min(d.u0.y, u.y); el.w = Math.max(20, Math.abs(u.x - d.u0.x)); el.h = Math.max(20, Math.abs(u.y - d.u0.y)); }
  repaintDgmCanvas(d.d, d.i, d.stage);
}
function endDgmDraw(d) {
  const el = d.el; const s = d.d.slides[d.i]; const dgm = dgmOf(s);
  const tiny = el.type === 'arrow' ? Math.hypot(el.x2 - el.x1, el.y2 - el.y1) < 30 : el.type === 'pen' ? el.pts.length < 3 : false;
  if (tiny) { dgm.elements = dgm.elements.filter((x) => x !== el); repaintDeck(d.d); selectSlide(d.d.id, d.i); return; }
  ed.dsel = el.id; commit(); repaintDeck(d.d); selectSlide(d.d.id, d.i); ed.dsel = el.id; paintChrome(); paintPanel();
}
function moveDgm(e) {
  const d = ed.drag; const p = stagePoint(e, d.stage); const s = d.d.slides[d.i]; const u = DG.toUnits(p, s.bgImage?.mode || 'none');
  const dx = u.x - d.last.x; const dy = u.y - d.last.y; d.last = u;
  if (Math.abs(dx) + Math.abs(dy) > 0) d.moved = true;
  DG.moveBy(d.el, dx, dy);
  repaintDgmCanvas(d.d, d.i, d.stage); paintChrome();
}
function repaintDgmCanvas(d, i, stage) {
  const s = d.slides[i]; let c = $('canvas.dk-dgm', stage);
  if (!c) { stage.insertAdjacentHTML('afterbegin', '<canvas class="dk-dgm" aria-hidden="true"></canvas>'); c = $('canvas.dk-dgm', stage); const bg = $('.dk-bgimg', stage); if (bg) bg.after(c); }
  paintDgm(c, dgmOf(s).elements, s.bgImage?.mode || 'none');
}

function repaintDeck(d) {
  if (ed.view === 'slide') { paintSlideStage(); return; }
  const node = $(`.wb-deck[data-item="${d.id}"]`, $('#dkCanvas')); if (!node) { paintBoard(); return; }
  d.w = deckWidth(d); d.h = deckHeight(d);
  node.outerHTML = deckHtml(d, curIndex(d), selSet(d));
  const fresh = $(`.wb-deck[data-item="${d.id}"]`, $('#dkCanvas'));
  hydrate(fresh); wireDeck(fresh, d); paintConns(); paintChrome();
}

function onStageDblClick(e) {
  const node = e.target.closest('.dk-el-text'); if (!node) return;
  const stage = node.closest('.dk-stage'); const frame = stage.closest('.dk-frame'); const deckNode = stage.closest('.wb-deck');
  const deckId = deckNode ? deckNode.dataset.item : ed.focus; const i = frame ? +frame.dataset.i : ed.ssel.i;
  const d = item(deckId); const el = d.slides[i].els.find((x) => x.id === node.dataset.el);
  if (!el || d.locked) return;
  e.stopPropagation();
  selectSlide(deckId, i, el.id);
  editSlideText(node, d, i, el);
}
// Click a selected box to edit at the caret; double-click or Enter selects all.
function editSlideText(node, d, i, el, clickEvent = null) {
  if (node.isContentEditable) return;
  node.contentEditable = 'plaintext-only'; node.classList.add('editing'); node.focus();
  const s = getSelection(); s.removeAllRanges();
  let range = null;
  if (clickEvent && document.caretRangeFromPoint) range = document.caretRangeFromPoint(clickEvent.clientX, clickEvent.clientY);
  if (!range || !node.contains(range.startContainer)) { range = document.createRange(); range.selectNodeContents(node); }
  s.addRange(range);
  let finished = false;
  const done = () => { if (finished) return; finished = true; node.contentEditable = 'false'; node.classList.remove('editing'); el.text = node.innerText.replace(/\n$/, ''); commit(); repaintDeck(d); selectSlide(d.id, i, el.id); paintRailSoon(); };
  node.onblur = done;
  node.onkeydown = (ev) => { ev.stopPropagation(); if (ev.key === 'Escape') { ev.preventDefault(); node.blur(); } };
}

// ------------------------------------------------------------- toolbar

function paintTools() {
  const host = $('#dkTools'); if (!host) return;
  TB.paint(host, {
    active: ed.tool,
    on: (t, e) => onTool(t, e),
    onContext: (t, e) => toolMenu(t, e),
    onPlus: (e) => menuAt(e, [
      { label: 'Add PNG Object…', run: addPngTool },
      { label: 'Add Divider', run: () => { TB.addDividerAfter(TB.config().order[TB.config().order.length - 1]); paintTools(); } },
      '-', { label: 'Reset Toolbar', run: () => { TB.reset(); paintTools(); } },
    ]),
    customUrl: (t) => t.pngUrl || '',
  });
  // Resolve custom PNG previews once.
  for (const t of TB.config().custom) if (!t.pngUrl) assetUrl(t.asset).then((u) => { t.pngUrl = u; const b = $(`.dk-tool[data-tool="${t.id}"] img`, host); if (b) b.src = u; });
}
function onTool(t, e) {
  if (t.id === 'text') { textMenu(e); return; }
  if (t.id === 'shape') { shapeMenu(e); return; }
  if (t.id === 'image') { pickMedia('image'); return; }
  if (t.id === 'video') { pickMedia('video'); return; }
  if (t.id === 'diagram') { openDrillPicker(); return; }
  if (t.png) { armTool(t.id, { kind: 'image', asset: t.asset, w: t.w, h: t.h, sticky: true, hint: `Click a slide or the board to place ${t.name}` }); return; }
  armTool(t.id);
}
function armTool(id, place = null) {
  ed.tool = id; ed.place = place;
  if ((place || id !== 'select') && (ed.sel.size || ed.ssel?.el)) { ed.sel = new Set(); if (ed.ssel) ed.ssel.el = null; ed.dsel = null; paintChrome(); }
  paintTools();
  const bar = $('#dkPlace'); if (bar) { bar.hidden = !place; if (place) bar.textContent = place.hint; }
  $('#dkBoard')?.classList.toggle('is-hand', id === 'hand');
  $('#dkBoard')?.classList.toggle('is-draw', (id !== 'select' && id !== 'hand') || !!place);
}
function toolMenu(t, e) {
  if (t.divider) { menuAt(e, [{ label: 'Remove Divider', run: () => { TB.removeFromOrder(t.id); paintTools(); } }]); return; }
  const items = [
    ...(TB.schemaFor(t) ? [{ label: 'Tool Settings…', run: () => openToolSettings(t) }] : []),
    { label: `Shortcut… (${t.key ? TB.keyLabel(t.key) : 'none'})`, run: () => { const k = prompt(`Shortcut key for ${t.name} (one character; blank to clear)`, t.key || ''); if (k === null) return; TB.setKey(t.id, k.trim().slice(0, 1)); paintTools(); } },
    { label: 'Change Icon…', run: () => openIconPicker(t) },
    { label: 'Add Divider After', run: () => { TB.addDividerAfter(t.id); paintTools(); } },
  ];
  if (t.png) items.push('-', { label: `Default Size… (${t.w}×${t.h})`, run: () => { const v = prompt('Default size on the board, width x height in px', `${t.w}x${t.h}`); if (!v) return; const m = v.match(/(\d+)\s*[x×,]\s*(\d+)/); if (m) { TB.updateCustom(t.id, { w: +m[1], h: +m[2] }); paintTools(); } } }, { label: 'Rename…', run: () => { const n = prompt('Tool name', t.name); if (n) { TB.updateCustom(t.id, { name: n }); paintTools(); } } }, { label: 'Remove Tool', run: () => { TB.removeFromOrder(t.id); paintTools(); } });
  menuAt(e, items);
}
const DG_COLORS = ['black', 'blue', 'grey', 'green', 'red'];
function openToolSettings(t) {
  const schema = TB.schemaFor(t); const st = TB.styleOf(t.id);
  const rows = Object.entries(schema).map(([k, f]) => {
    if (f.t === 'color') return field(f.l, swatches(DEFAULT_BOARD_COLORS.concat(k === 'color' && t.id === 'sticky' ? STICKY_COLORS : []), st[k]).replace('class="dk-colors"', `class="dk-colors" data-k="${k}"`));
    if (f.t === 'dcolor') return field(f.l, `<div class="dk-colors" data-k="${k}">${DG_COLORS.map((c) => `<button class="dk-swatch ${c === st[k] ? 'on' : ''}" data-c="${c}" style="background:${DG.colorOf(c)}" aria-label="${c}"></button>`).join('')}</div>`);
    if (f.t === 'bool') return `<label class="fld-check"><input type="checkbox" data-k="${k}" ${st[k] ? 'checked' : ''}> ${f.l}</label>`;
    if (f.t === 'range') return field(`${f.l} (${st[k]})`, `<input type="range" data-k="${k}" min="${f.min}" max="${f.max}" step="${f.step}" value="${st[k]}">`);
    if (f.t === 'text') return field(f.l, `<input type="text" data-k="${k}" value="${esc(st[k] || '')}">`);
    return field(f.l, `<input type="number" data-k="${k}" value="${st[k]}" min="1">`);
  }).join('');
  $('#dkSheet').innerHTML = sheetHtml(`${t.name} Settings`, `${rows}<div class="dk-btnrow"><button class="btn btn-outline btn-sm" id="dkToolReset">Reset to Defaults</button></div><p class="dk-hint">These are the defaults the tool uses for the next thing it makes; existing objects keep their own.</p>`);
  wireSheet();
  const host = $('#dkSheet');
  $$('.dk-colors[data-k]', host).forEach((row) => {
    $$('.dk-swatch', row).forEach((b) => { b.onclick = () => { TB.setStyle(t.id, { [row.dataset.k]: b.dataset.c }); $$('.dk-swatch', row).forEach((x) => x.classList.toggle('on', x === b)); }; });
    const w = $('.dk-cwell', row); if (w) w.oninput = (e) => TB.setStyle(t.id, { [row.dataset.k]: e.target.value });
  });
  $$('input[data-k]', host).forEach((inp) => {
    inp.onchange = () => { const f = schema[inp.dataset.k]; const v = f.t === 'bool' ? inp.checked : f.t === 'text' ? inp.value : +inp.value; TB.setStyle(t.id, { [inp.dataset.k]: v }); if (f.t === 'range') inp.closest('.fld').querySelector('span').textContent = `${f.l} (${v})`; if (t.png && (inp.dataset.k === 'w' || inp.dataset.k === 'h')) TB.updateCustom(t.id, { [inp.dataset.k]: v }); };
  });
  $('#dkToolReset', host).onclick = () => { TB.setStyle(t.id, Object.fromEntries(Object.keys(schema).map((k) => [k, undefined]))); closeSheet(); openToolSettings(t); };
}
function addPngTool() {
  const inp = document.createElement('input'); inp.type = 'file'; inp.accept = 'image/png,image/svg+xml,image/webp,image/jpeg';
  inp.onchange = async () => {
    const f = inp.files && inp.files[0]; if (!f) return;
    const id = uid(); await putAsset(id, f);
    const url = URL.createObjectURL(f);
    const size = await new Promise((res) => { const im = new Image(); im.onload = () => res({ w: im.naturalWidth, h: im.naturalHeight }); im.onerror = () => res({ w: 240, h: 240 }); im.src = url; });
    const scale = Math.min(1, 240 / Math.max(size.w, size.h, 1));
    TB.addCustom({ id: `png-${id}`, name: f.name.replace(/\.[^.]+$/, ''), png: true, asset: id, w: Math.round(size.w * scale), h: Math.round(size.h * scale), icon: 'image', key: '', pngUrl: url });
    paintTools();
  };
  inp.click();
}
function openIconPicker(t) {
  const host = $('#dkSheet');
  host.innerHTML = sheetHtml(`Icon for ${t.name}`, `<input class="input dk-iconsearch" id="dkIconQ" type="search" placeholder="Search ${ICON_NAMES.length} icons…" autocomplete="off"><div class="dk-icongrid" id="dkIconGrid"></div>`);
  wireSheet();
  const grid = $('#dkIconGrid');
  const paintGrid = (q) => { grid.innerHTML = ICON_NAMES.filter((n) => !q || n.includes(q)).map((n) => `<button class="dk-iconbtn ${n === t.icon ? 'on' : ''}" data-icon="${n}" aria-label="${n}">${iconSvg(n)}</button>`).join(''); $$('.dk-iconbtn', grid).forEach((b) => { b.onclick = () => { TB.setIcon(t.id, b.dataset.icon); closeSheet(); paintTools(); }; }); };
  paintGrid('');
  $('#dkIconQ').oninput = (e) => paintGrid(e.target.value.trim().toLowerCase());
  $('#dkIconQ').focus();
}

// ------------------------------------------------------------- menus

function menuAt(e, items) {
  closeMenu();
  const m = document.createElement('div'); m.className = 'menu'; m.setAttribute('role', 'menu');
  m.innerHTML = items.map((it, i) => (it === '-' ? '<div class="menu-sep"></div>' : it.sub ? `<div class="dk-menu-sub">${esc(it.sub)}</div>` : `<button class="menu-item" role="menuitem" data-i="${i}">${esc(it.label)}</button>`)).join('');
  document.body.appendChild(m);
  const r = (e.currentTarget || e.target)?.getBoundingClientRect?.() || { left: e.clientX, bottom: e.clientY, top: e.clientY };
  const x = Math.min(e.clientX || r.left, innerWidth - 240);
  let y = (e.clientY || r.bottom) + 4;
  if (y + m.offsetHeight > innerHeight - 8) y = Math.max(8, (e.clientY || r.top) - m.offsetHeight - 4);
  m.style.left = `${x}px`; m.style.top = `${y}px`;
  $$('.menu-item', m).forEach((b) => { b.onclick = (ev) => { const it = items[+b.dataset.i]; closeMenu(); it.run(ev); }; });
  setTimeout(() => document.addEventListener('pointerdown', menuAway, { once: true }));
}
function menuAway(e) { if (!e.target.closest('.menu')) closeMenu(); else setTimeout(() => document.addEventListener('pointerdown', menuAway, { once: true })); }
function closeMenu() { $$('.menu').forEach((m) => m.remove()); }

function textMenu(e) {
  const d = deckOf() || focusDeck(); const roles = d ? Object.entries(d.theme.styles) : [];
  menuAt(e, [{ label: 'Board Text', run: () => armTool('text', { kind: 'text', hint: 'Click the board to place text' }) }, ...(roles.length ? ['-'] : []), ...roles.map(([role, st]) => ({ label: `Slide: ${st.label || role}`, run: () => armTool('text', { kind: 'text', role, hint: 'Click a slide to place the text' }) }))]);
}
function shapeMenu(e) {
  const mk = (shape, label) => ({ label, run: () => { ed.shape = shape; armTool('shape', { kind: 'shape', shape, hint: `Click a slide or the board to place ${label.toLowerCase()}` }); } });
  menuAt(e, [mk('rect', 'Rectangle'), mk('ellipse', 'Ellipse'), mk('diamond', 'Diamond'), mk('line', 'Line'), mk('arrow', 'Arrow')]);
}
// New slide: the built-in layouts and Tony's own presets.
function layoutMenu(e, d, at = null) {
  const presets = loadPresets();
  const insert = (slide) => {
    const where = at != null ? at : (ed.ssel?.deck === d.id ? ed.ssel.i + 1 : d.slides.length);
    d.slides.splice(where, 0, slide); ed.sslides = new Set();
    commit(); repaintDeck(d); selectSlide(d.id, where); if (ed.view === 'slide') paintRail();
  };
  menuAt(e, [
    { sub: 'Layouts' },
    ...Object.entries(LAYOUTS).map(([k, v]) => ({ label: v.label, run: () => insert(newSlide(k)) })),
    ...(presets.length ? [{ sub: 'Presets' }, ...presets.map((p) => ({ label: p.name, run: () => insert(cloneSlide(p.slide)) }))] : []),
  ]);
}
function slideMenu(e, d, i) {
  const s = d.slides[i]; const presets = loadPresets(); const many = (selSet(d)?.size || 1) > 1;
  menuAt(e, [
    { label: many ? 'Duplicate Slides' : 'Duplicate Slide', run: duplicateSlides },
    { label: 'Insert Slide After…', run: (ev) => layoutMenu(ev || e, d, i + 1) },
    { label: s.skip ? 'Include in Present' : 'Skip Slide', run: () => { s.skip = !s.skip; commit(); repaintDeck(d); if (ed.view === 'slide') paintRail(); } },
    '-',
    { label: 'Save as Preset…', run: () => { const name = prompt('Preset name', s.els.find((x) => x.type === 'text')?.text || 'My Slide'); if (!name) return; const list = loadPresets(); list.push({ id: uid(), name, slide: cloneSlide(s) }); savePresets(list); } },
    ...(presets.length ? [{ label: 'Update a Preset…', run: (ev) => menuAt(ev || e, presets.map((p) => ({ label: `Overwrite "${p.name}"`, run: () => { const list = loadPresets(); const t = list.find((x) => x.id === p.id); if (t) { t.slide = cloneSlide(s); savePresets(list); } } }))) }] : []),
    '-',
    { label: many ? 'Delete Slides' : 'Delete Slide', run: deleteSlides },
  ]);
}

// ------------------------------------------------------------- media in

function pickMedia(kind) {
  const inp = document.createElement('input'); inp.type = 'file'; inp.accept = kind === 'image' ? 'image/*' : 'video/*';
  inp.onchange = async () => { const f = inp.files && inp.files[0]; if (!f) return; const id = uid(); await putAsset(id, f); armTool(kind, { kind, asset: id, hint: `Click a slide or the board to place ${f.name}` }); };
  inp.click();
}
async function openDrillPicker() {
  const drills = await listDrills(); const host = $('#dkSheet');
  if (!drills.length) host.innerHTML = sheetHtml('Saved Diagrams', '<p class="dk-empty">No saved diagrams yet. Draw one in the Diagrams app and it will appear here.</p>');
  else {
    host.innerHTML = sheetHtml('Saved Diagrams', `<div class="dk-drills">${drills.map((d) => `<button class="dk-drill" data-id="${esc(d.id)}">${d.thumb ? `<img src="${esc(d.thumb)}" alt="" decoding="async">` : '<span class="dk-drill-blank" aria-hidden="true"></span>'}<span>${esc(d.name || 'Untitled')}</span></button>`).join('')}</div>`);
    $$('.dk-drill', host).forEach((b) => { b.onclick = () => { closeSheet(); armTool('diagram', { kind: 'diagram', drill: b.dataset.id, hint: 'Click a slide or the board to place the diagram' }); }; });
  }
  wireSheet();
}

// ------------------------------------------------------------- panel

function paintPanel() {
  const host = $('#dkPanel'); const tabs = $('#dkTabs'); if (!host) return;
  const el = selEl(); const s = slideOf();
  const slideLevel = !!(ed.ssel && (el || ed.view === 'slide' || (ed.sel.size === 1 && deckOf() && ed.sel.has(deckOf().id))));
  tabs.innerHTML = slideLevel ? `<button class="tab ${ed.tab === 'design' ? 'on' : ''}" data-tab="design">Design</button><button class="tab ${ed.tab === 'animate' ? 'on' : ''}" data-tab="animate">Animate</button>` : '';
  $$('.tab', tabs).forEach((t) => { t.onclick = () => { ed.tab = t.dataset.tab; paintPanel(); }; });
  if (slideLevel && ed.tab === 'animate') { paintAnimate(host); return; }
  if (el) { host.innerHTML = elPanelHtml(el); wireElPanel(host, el); return; }
  if (ed.dsel && s) { const x = dgmOf(s).elements.find((q) => q.id === ed.dsel); if (x) { host.innerHTML = dgmPanelHtml(x); wireDgmPanel(host, x); return; } }
  const items = selItems();
  if (items.length > 1) { host.innerHTML = multiPanelHtml(items); wireMultiPanel(host); return; }
  if (items.length === 1 && items[0].kind !== 'deck') { host.innerHTML = itemPanelHtml(items[0]); wireItemPanel(host, items[0]); return; }
  if (s) { host.innerHTML = slidePanelHtml(deckOf(), s); wireSlidePanel(host, deckOf(), s); return; }
  host.innerHTML = boardPanelHtml(); wireBoardPanel(host);
}
const field = (label, inner) => `<label class="fld"><span>${label}</span>${inner}</label>`;
const swatches = (colors, value, extra = true) => `<div class="dk-colors">${colors.map((c) => `<button class="dk-swatch ${c === value ? 'on' : ''}" data-c="${c}" style="background:${c}" aria-label="${c}"></button>`).join('')}${extra ? `<input type="color" class="dk-cwell" value="${/^#[0-9a-f]{6}$/i.test(value || '') ? value : '#0a0a0a'}" aria-label="Custom color">` : ''}</div>`;
const DEFAULT_BOARD_COLORS = ['#0a0a0a', '#404040', '#737373', '#a3a3a3', '#ffffff', '#75d8ff', '#16a34a', '#dc2626'];
const colorRow = (value) => swatches(deckOf()?.theme?.colors || DEFAULT_BOARD_COLORS, value);
function wireColors(host, apply) { $$('.dk-colors', host).forEach((row) => { $$('.dk-swatch', row).forEach((b) => { b.onclick = () => apply(b.dataset.c, row); }); const w = $('.dk-cwell', row); if (w) w.oninput = (e) => apply(e.target.value, row); }); }

function boardPanelHtml() {
  const b = ed.board; const n = (k) => b.items.filter((i) => i.kind === k).length;
  return `<div class="dk-sect"><h3>Board</h3>
    <p class="dk-hint">${b.items.length} object${b.items.length === 1 ? '' : 's'}: ${n('deck')} deck${n('deck') === 1 ? '' : 's'}, ${n('sticky')} stick${n('sticky') === 1 ? 'y' : 'ies'}, ${n('shape')} shape${n('shape') === 1 ? '' : 's'}, ${n('connector')} connector${n('connector') === 1 ? '' : 's'}.</p>
    <div class="dk-btnrow"><button class="btn btn-outline btn-sm" id="dkFit">Zoom to Fit</button><button class="btn btn-outline btn-sm" id="dkOpenSettings">Settings</button></div>
    <h3>Shortcuts</h3>
    <dl class="dk-keys"><dt>Space + drag</dt><dd>Pan</dd><dt>⌘ + scroll</dt><dd>Zoom</dd><dt>⌘Z / ⇧⌘Z</dt><dd>Undo / redo</dd><dt>⌘D</dt><dd>Duplicate</dd><dt>[ ]</dt><dd>Send back / bring forward</dd><dt>⌘0</dt><dd>Zoom to fit</dd><dt>Right-click a tool</dt><dd>Shortcut, icon, dividers</dd></dl>
  </div>`;
}
function wireBoardPanel(host) { $('#dkFit', host).onclick = fitToContent; $('#dkOpenSettings', host).onclick = openSettingsSheet; }

function itemPanelHtml(it) {
  const head = { sticky: 'Sticky Note', text: 'Text', shape: 'Shape', pen: 'Pen Stroke', section: 'Section', image: 'Image', video: 'Video', diagram: 'Saved Diagram', connector: 'Connector' }[it.kind] || 'Object';
  let body = '';
  if (it.kind === 'sticky') body = field('Color', swatches(STICKY_COLORS, it.color, false));
  if (it.kind === 'text') body = field('Size', `<input type="number" id="dkISize" value="${it.size || 24}" min="8" max="400">`) + field('Align', `<div class="seg" id="dkIAlign">${['left', 'center', 'right'].map((a) => `<button class="seg-btn ${(it.align || 'left') === a ? 'on' : ''}" data-a="${a}" aria-label="Align ${a}">${iconSvg(`align-${a}`)}</button>`).join('')}</div>`) + field('Color', colorRow(it.color));
  if (it.kind === 'shape') body = field('Fill', colorRow(it.fill)) + field('Stroke', `<div class="dk-colors" data-role="stroke">${DEFAULT_BOARD_COLORS.map((c) => `<button class="dk-swatch ${c === it.stroke ? 'on' : ''}" data-c="${c}" style="background:${c}" aria-label="${c}"></button>`).join('')}</div>`) + field('Opacity', `<input type="range" id="dkIAlpha" min="0.1" max="1" step="0.05" value="${it.alpha == null ? 1 : it.alpha}">`) + (it.shape === 'rect' ? field('Corner radius', `<input type="number" id="dkIRadius" value="${it.radius || 0}" min="0" max="200">`) : '') + field('Label', `<input type="text" id="dkIText" value="${esc(it.text || '')}">`);
  if (it.kind === 'pen') body = field('Color', colorRow(it.color)) + field('Width', `<input type="range" id="dkIWidth" min="1" max="24" step="1" value="${it.width || 4}">`);
  if (it.kind === 'section') body = field('Title', `<input type="text" id="dkIText" value="${esc(it.title || '')}">`) + field('Color', swatches(['#e0f2fe', '#fef3c7', '#dcfce7', '#fce7f3', '#ede9fe', '#f5f5f4'], it.color, false));
  if (it.kind === 'connector') body = field('Color', colorRow(it.color)) + `<label class="fld-check"><input type="checkbox" id="dkIHead" ${it.head ? 'checked' : ''}> Arrowhead</label>`;
  if (it.kind === 'diagram') body = `<label class="fld-check"><input type="checkbox" id="dkIAnimate" ${it.animate ? 'checked' : ''}> Play drill animation on click</label>`;
  if (it.kind === 'image') body = field('Size', `<div class="dk-btnrow"><input type="number" id="dkIW" value="${it.w}" min="16" style="width:90px"><input type="number" id="dkIH" value="${it.h}" min="16" style="width:90px"></div>`);
  return `<div class="dk-sect"><h3>${head}</h3>${body}<label class="fld-check"><input type="checkbox" id="dkILock" ${it.locked ? 'checked' : ''}> Locked</label><div class="dk-btnrow"><button class="btn btn-outline btn-sm" id="dkIDup">Duplicate</button><button class="btn btn-outline btn-sm" id="dkIDel">Delete</button></div></div>`;
}
function wireItemPanel(host, it) {
  const rerender = () => { commit(); paintBoard(); paintChrome(); paintPanel(); };
  wireColors(host, (c, row) => { if (it.kind === 'shape' && row.dataset.role === 'stroke') it.stroke = c; else if (it.kind === 'shape') it.fill = c; else it.color = c; rerender(); });
  const on = (id, ev, fn) => { const n = $(id, host); if (n) n[ev] = fn; };
  on('#dkISize', 'onchange', (e) => { it.size = clamp(+e.target.value || 24, 8, 400); rerender(); });
  $$('#dkIAlign .seg-btn', host).forEach((b) => { b.onclick = () => { it.align = b.dataset.a; rerender(); }; });
  on('#dkIAlpha', 'onchange', (e) => { it.alpha = +e.target.value; rerender(); });
  on('#dkIRadius', 'onchange', (e) => { it.radius = Math.max(0, +e.target.value || 0); rerender(); });
  on('#dkIText', 'onchange', (e) => { if (it.kind === 'section') it.title = e.target.value; else it.text = e.target.value; rerender(); });
  on('#dkIWidth', 'onchange', (e) => { it.width = +e.target.value; rerender(); });
  on('#dkIHead', 'onchange', (e) => { it.head = e.target.checked; rerender(); });
  on('#dkIAnimate', 'onchange', (e) => { it.animate = e.target.checked; commit(); });
  on('#dkIW', 'onchange', (e) => { it.w = Math.max(16, +e.target.value || it.w); rerender(); });
  on('#dkIH', 'onchange', (e) => { it.h = Math.max(16, +e.target.value || it.h); rerender(); });
  on('#dkILock', 'onchange', (e) => { it.locked = e.target.checked; rerender(); });
  on('#dkIDup', 'onclick', duplicateSel); on('#dkIDel', 'onclick', deleteSel);
}
function multiPanelHtml(items) {
  return `<div class="dk-sect"><h3>${items.length} objects</h3><h4 class="dk-sub">Align</h4><div class="dk-btngrid">${[['left', 'Left'], ['hcenter', 'Center'], ['right', 'Right'], ['top', 'Top'], ['vcenter', 'Middle'], ['bottom', 'Bottom']].map(([k, l]) => `<button class="btn btn-outline btn-sm" data-align="${k}">${l}</button>`).join('')}</div><h4 class="dk-sub">Distribute</h4><div class="dk-btngrid"><button class="btn btn-outline btn-sm" data-dist="h">Horizontally</button><button class="btn btn-outline btn-sm" data-dist="v">Vertically</button></div><div class="dk-btnrow"><button class="btn btn-outline btn-sm" id="dkIDup">Duplicate</button><button class="btn btn-outline btn-sm" id="dkIDel">Delete</button></div></div>`;
}
function wireMultiPanel(host) {
  $$('[data-align]', host).forEach((b) => { b.onclick = () => alignSel(b.dataset.align); });
  $$('[data-dist]', host).forEach((b) => { b.onclick = () => distributeSel(b.dataset.dist); });
  $('#dkIDup', host).onclick = duplicateSel; $('#dkIDel', host).onclick = deleteSel;
}
function alignSel(how) {
  const items = selItems().filter((i) => isBox(i) && !i.locked); if (items.length < 2) return;
  const u = union(items);
  for (const it of items) { if (how === 'left') it.x = u.x; if (how === 'right') it.x = u.x + u.w - it.w; if (how === 'hcenter') it.x = Math.round(u.x + (u.w - it.w) / 2); if (how === 'top') it.y = u.y; if (how === 'bottom') it.y = u.y + u.h - it.h; if (how === 'vcenter') it.y = Math.round(u.y + (u.h - it.h) / 2); }
  commit(); paintBoard(); paintChrome();
}
function distributeSel(axis) {
  const items = selItems().filter((i) => isBox(i) && !i.locked).sort((a, b) => (axis === 'h' ? a.x - b.x : a.y - b.y)); if (items.length < 3) return;
  const first = items[0]; const last = items[items.length - 1];
  const total = axis === 'h' ? (last.x + last.w) - first.x : (last.y + last.h) - first.y;
  const sum = items.reduce((t, i) => t + (axis === 'h' ? i.w : i.h), 0); const gap = (total - sum) / (items.length - 1);
  let cur = axis === 'h' ? first.x : first.y;
  for (const it of items) { if (axis === 'h') { it.x = Math.round(cur); cur += it.w + gap; } else { it.y = Math.round(cur); cur += it.h + gap; } }
  commit(); paintBoard(); paintChrome();
}
function slidePanelHtml(d, s) {
  const n = selSet(d)?.size || 1;
  return `<div class="dk-sect"><h3>${esc(d.name)} · ${n > 1 ? `${n} slides` : `Slide ${ed.ssel.i + 1}`}</h3>
    ${field('Background', swatches(d.theme.colors, s.bg))}
    <label class="fld-check"><input type="checkbox" id="dkSkip" ${s.skip ? 'checked' : ''}> Skip in present</label>
    <div class="dk-btnrow"><button class="btn btn-outline btn-sm" id="dkThemeBtn">${iconSvg('palette')} Theme</button><button class="btn btn-outline btn-sm" id="dkNewSlideBtn">${iconSvg('plus')} New Slide</button><button class="btn btn-outline btn-sm" id="dkDupSlideBtn">Duplicate</button></div>
    <p class="dk-hint">⌘D duplicates, Delete removes, drag the blue bar to reorder, shift-click or rubber-band to select several.</p>
  </div>`;
}
function wireSlidePanel(host, d, s) {
  wireColors(host, (c) => { for (const sl of selectedSlides()) sl.bg = c; commit(); repaintDeck(d); paintRailSoon(); paintPanel(); });
  $('#dkSkip', host).onchange = (e) => { for (const sl of selectedSlides()) sl.skip = e.target.checked; commit(); repaintDeck(d); if (ed.view === 'slide') paintRail(); };
  $('#dkThemeBtn', host).onclick = () => openThemeSheet(d);
  $('#dkNewSlideBtn', host).onclick = (e) => layoutMenu(e, d);
  $('#dkDupSlideBtn', host).onclick = duplicateSlides;
}
function elPanelHtml(el) {
  const d = deckOf();
  if (el.type === 'text') { const st = styleOf(d.theme, el.role); return `<div class="dk-sect"><h3>Text</h3>${field('Style', `<select id="dkRole">${Object.entries(d.theme.styles).map(([r, s]) => `<option value="${r}" ${r === el.role ? 'selected' : ''}>${esc(s.label || r)}</option>`).join('')}</select>`)}${field('Size', `<input type="number" id="dkSize" value="${el.size || st.size}" min="8" max="400">`)}${field('Align', `<div class="seg" id="dkAlign">${['left', 'center', 'right'].map((a) => `<button class="seg-btn ${(el.align || 'left') === a ? 'on' : ''}" data-a="${a}" aria-label="Align ${a}">${iconSvg(`align-${a}`)}</button>`).join('')}</div>`)}${field('Color', colorRow(el.color || st.color))}</div>`; }
  if (el.type === 'shape') return `<div class="dk-sect"><h3>Shape</h3>${field('Fill', colorRow(el.fill))}${field('Opacity', `<input type="range" id="dkAlpha" min="0.1" max="1" step="0.05" value="${el.alpha == null ? 1 : el.alpha}">`)}${el.shape === 'rect' ? field('Corner radius', `<input type="number" id="dkRadius" value="${el.radius || 0}" min="0" max="200">`) : ''}${field('Label', `<input type="text" id="dkShapeText" value="${esc(el.text || '')}">`)}</div>`;
  if (el.type === 'diagram') return `<div class="dk-sect"><h3>Saved Diagram</h3><label class="fld-check"><input type="checkbox" id="dkAnimate" ${el.animate ? 'checked' : ''}> Play drill animation in present</label></div>`;
  if (el.type === 'video') return `<div class="dk-sect"><h3>Video</h3><p class="dk-hint">In present mode a two-finger swipe scrubs the film.</p></div>`;
  return `<div class="dk-sect"><h3>${el.type === 'image' ? 'Image' : el.type === 'logo' ? 'Logo' : 'Object'}</h3></div>`;
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
function dgmPanelHtml(x) {
  const name = { player: 'Player', arrow: 'Arrow', box: 'Shaded Box', circle: 'Shaded Circle', text: 'Ice Text', pen: 'Ice Pen', stamp: 'Item', pucks: 'Pucks' }[x.type] || 'Diagram Element';
  const colors = ['black', 'blue', 'grey', 'green', 'red'];
  let body = '';
  if (x.type === 'player') body = field('Label', `<input type="text" id="dkDLabel" value="${esc(x.label || '')}" maxlength="3">`);
  if (x.type === 'text') body = field('Text', `<input type="text" id="dkDText" value="${esc(x.text || '')}">`);
  if (['player', 'arrow', 'box', 'circle', 'text', 'pen'].includes(x.type)) body += field('Color', `<div class="dk-colors" id="dkDColor">${colors.map((c) => `<button class="dk-swatch ${c === x.color ? 'on' : ''}" data-c="${c}" style="background:${DG.colorOf(c)}" aria-label="${c}"></button>`).join('')}</div>`);
  if (x.type === 'stamp') body += `<label class="fld-check"><input type="checkbox" id="dkDFlip" ${x.flip ? 'checked' : ''}> Flip</label>`;
  return `<div class="dk-sect"><h3>${name}</h3>${body}<div class="dk-btnrow"><button class="btn btn-outline btn-sm" id="dkDDel">Delete</button></div><p class="dk-hint">Drawn with the Diagrams renderer, in rink units, on this slide.</p></div>`;
}
function wireDgmPanel(host, x) {
  const d = deckOf(); const i = ed.ssel.i; const s = slideOf();
  const re = () => { commit(); repaintDeck(d); selectSlide(d.id, i); ed.dsel = x.id; paintChrome(); paintPanel(); };
  const on = (id, ev, fn) => { const n = $(id, host); if (n) n[ev] = fn; };
  on('#dkDLabel', 'onchange', (e) => { x.label = e.target.value.slice(0, 3); re(); });
  on('#dkDText', 'onchange', (e) => { x.text = e.target.value; re(); });
  $$('#dkDColor .dk-swatch', host).forEach((b) => { b.onclick = () => { x.color = b.dataset.c; ed.dgColor = b.dataset.c; re(); }; });
  on('#dkDFlip', 'onchange', (e) => { x.flip = e.target.checked; re(); });
  on('#dkDDel', 'onclick', () => { dgmOf(s).elements = dgmOf(s).elements.filter((q) => q.id !== x.id); ed.dsel = null; commit(); repaintDeck(d); selectSlide(d.id, i); });
}

// ------------------------------------------------------------- animate

function paintAnimate(host) {
  const d = deckOf(); const s = slideOf(); if (!d || !s) { host.innerHTML = ''; return; }
  const tr = s.transition || { style: 'none', durMs: 300 }; const el = selEl();
  const animated = s.els.filter((x) => x.anim).sort((a, b) => (a.anim.order || 0) - (b.anim.order || 0));
  host.innerHTML = `<div class="dk-sect"><h3>Slide transition</h3>${field('Style', `<select id="dkTrStyle">${TRANSITIONS.map((t) => `<option value="${t}" ${t === tr.style ? 'selected' : ''}>${t[0].toUpperCase() + t.slice(1)}</option>`).join('')}</select>`)}${field('Duration ms', `<input type="number" id="dkTrDur" value="${tr.durMs || 300}" min="100" max="2000" step="50">`)}<button class="btn btn-outline btn-sm" id="dkTrAll">Apply to All Slides</button></div>
    <div class="dk-sect"><h3>Object animations</h3>${el ? (el.anim ? animEditorHtml(el) : `<button class="btn btn-outline btn-sm" id="dkAnimAdd">${iconSvg('plus')} Animate Selected Object</button>`) : '<p class="dk-hint">Select an object on the slide to animate it.</p>'}${animated.length ? `<div class="dk-animlist">${animated.map((x, n) => `<button class="dk-animrow ${x.id === ed.ssel.el ? 'on' : ''}" data-el="${x.id}"><span class="dk-animn">${n + 1}</span><span>${animLabel(x)}</span><span class="dk-animx" data-x="${x.id}">${iconSvg('x')}</span></button>`).join('')}</div>` : ''}</div>`;
  $('#dkTrStyle', host).onchange = (e) => { s.transition = { ...tr, style: e.target.value }; commit(); };
  $('#dkTrDur', host).onchange = (e) => { s.transition = { ...tr, durMs: Math.max(100, +e.target.value || 300) }; commit(); };
  $('#dkTrAll', host).onclick = () => { for (const sl of d.slides) sl.transition = { ...(s.transition || tr) }; commit(); };
  const add = $('#dkAnimAdd', host); if (add) add.onclick = () => { const max = Math.max(0, ...s.els.filter((x) => x.anim).map((x) => x.anim.order || 0)); el.anim = { io: 'in', style: 'fade', durMs: 600, order: max + 1 }; commit(); paintAnimate(host); };
  if (el && el.anim) wireAnimEditor(host, el);
  $$('.dk-animrow', host).forEach((r) => { r.onclick = (ev) => { if (ev.target.closest('.dk-animx')) return; ed.ssel.el = r.dataset.el; paintChrome(); paintAnimate(host); }; });
  $$('.dk-animx', host).forEach((x) => { x.onclick = () => { const t = s.els.find((y) => y.id === x.dataset.x); if (t) delete t.anim; commit(); paintAnimate(host); }; });
}
const animLabel = (x) => `${x.type === 'text' ? (x.text || 'Text').slice(0, 14) : x.type} - ${x.anim.style}, ${x.anim.durMs}ms ${x.anim.io}`;
function animEditorHtml(el) { const a = el.anim; return `<div class="dk-animedit">${field('Style', `<select id="dkAStyle">${ANIM_STYLES.map((t) => `<option value="${t}" ${t === a.style ? 'selected' : ''}>${t.replace('-', ' ')}</option>`).join('')}</select>`)}${field('Animate', `<div class="seg" id="dkAIO"><button class="seg-btn ${a.io === 'in' ? 'on' : ''}" data-io="in">In</button><button class="seg-btn ${a.io === 'out' ? 'on' : ''}" data-io="out">Out</button></div>`)}${field('Duration ms', `<input type="number" id="dkADur" value="${a.durMs}" min="100" max="3000" step="50">`)}${field('Order', `<input type="number" id="dkAOrder" value="${a.order || 1}" min="1" max="99">`)}<button class="btn btn-outline btn-sm" id="dkARemove">Remove Animation</button></div>`; }
function wireAnimEditor(host, el) {
  $('#dkAStyle', host).onchange = (e) => { el.anim.style = e.target.value; commit(); };
  $$('#dkAIO .seg-btn', host).forEach((b) => { b.onclick = () => { el.anim.io = b.dataset.io; commit(); paintAnimate(host); }; });
  $('#dkADur', host).onchange = (e) => { el.anim.durMs = Math.max(100, +e.target.value || 600); commit(); };
  $('#dkAOrder', host).onchange = (e) => { el.anim.order = Math.max(1, +e.target.value || 1); commit(); paintAnimate(host); };
  $('#dkARemove', host).onclick = () => { delete el.anim; commit(); paintAnimate(host); };
}

// ------------------------------------------------------------- sheets

const sheetHtml = (title, body) => `<div class="sheet-veil"><div class="sheet" role="dialog" aria-modal="true" aria-label="${esc(title)}"><header><h2>${esc(title)}</h2><button class="btn btn-ghost btn-icon" data-close aria-label="Close">${iconSvg('x')}</button></header><div class="sheet-body">${body}</div></div></div>`;
function wireSheet() { const veil = $('.sheet-veil'); if (!veil) return; veil.onclick = (e) => { if (e.target === veil || e.target.closest('[data-close]')) closeSheet(); }; }
export function closeSheet() { const v = $('.sheet-veil'); if (v) v.remove(); }

function openThemeSheet(d) {
  const t = d.theme;
  const rows = Object.entries(t.styles).map(([r, s]) => `<div class="dk-trow" data-role="${r}"><span class="dk-trole">${esc(s.label || r)}</span><input type="number" class="dk-tsize" value="${s.size}" min="8" max="400" aria-label="${esc(s.label || r)} size"><select class="dk-tweight" aria-label="${esc(s.label || r)} weight">${[400, 500, 600, 700, 800].map((w) => `<option ${w === s.weight ? 'selected' : ''}>${w}</option>`).join('')}</select><input type="color" class="dk-tcolor" value="${s.color}" aria-label="${esc(s.label || r)} color"></div>`).join('');
  $('#dkSheet').innerHTML = sheetHtml(`Theme · ${d.name}`, `<h4>Text styles</h4><div class="dk-theme-rows">${rows}</div><h4>Colors</h4><div class="dk-colors dk-theme-colors">${t.colors.map((c, i) => `<input type="color" class="dk-cwell" data-i="${i}" value="${c}" aria-label="Palette color ${i + 1}">`).join('')}</div>`);
  wireSheet();
  const themed = () => { commit(); repaintDeck(d); paintRailSoon(); };
  $$('.dk-trow').forEach((row) => { const st = t.styles[row.dataset.role]; $('.dk-tsize', row).onchange = (e) => { st.size = Math.max(8, +e.target.value || st.size); themed(); }; $('.dk-tweight', row).onchange = (e) => { st.weight = +e.target.value; themed(); }; $('.dk-tcolor', row).oninput = (e) => { st.color = e.target.value; themed(); }; });
  $$('.dk-theme-colors .dk-cwell').forEach((w) => { w.oninput = (e) => { t.colors[+w.dataset.i] = e.target.value; themed(); }; });
}

function openSettingsSheet() {
  const s = settings(); const p = ed.prefs; const presets = loadPresets();
  const fsRow = !fsSupported() ? '<p class="dk-hint">This browser cannot open a folder. Use Chrome or Edge.</p>'
    : fsConnected() ? `<p class="dk-hint">Saving to <b>${esc(fsRootName())}${WHITEBOARD_DIR}</b> on every change.</p><div class="dk-btnrow"><button class="btn btn-outline btn-sm" id="dkFsSaveNow">Save Now</button></div>`
    : `<div class="dk-btnrow"><button class="btn btn-outline btn-sm" id="dkFsConnect">${fsRemembered() ? 'Reconnect CTH Folder' : 'Connect CTH Folder'}</button></div><p class="dk-hint">Boards also save as JSON to ${WHITEBOARD_DIR} inside your CTH folder once it is connected.</p>`;
  $('#dkSheet').innerHTML = sheetHtml('Board Settings', `
    <h4>Snapping</h4>
    <label class="fld-check"><input type="checkbox" id="dkSSnapObj" ${s.snapObjects !== false ? 'checked' : ''}> Snap to objects and slide edges</label>
    <label class="fld-check"><input type="checkbox" id="dkSSnap" ${s.snap ? 'checked' : ''}> Snap to grid</label>
    ${field('Grid size', `<input type="number" id="dkSGridSize" value="${s.gridSize}" min="8" max="200" step="4">`)}
    ${field('Show grid', `<div class="seg" id="dkSGrid">${[['none', 'Off'], ['dots', 'Dots'], ['lines', 'Lines']].map(([k, l]) => `<button class="seg-btn ${s.grid === k ? 'on' : ''}" data-g="${k}">${l}</button>`).join('')}</div>`)}
    <h4>Canvas</h4>
    ${field('Background', swatches(['#f5f5f4', '#ffffff', '#fafaf9', '#e7e5e4', '#f0f9ff', '#1c1917'], s.bg))}
    <h4>Defaults</h4>
    ${field('Sticky color', swatches(STICKY_COLORS, p.stickyColor || s.stickyColor, false))}
    ${field('Pen color', `<div class="dk-colors" data-role="pen">${DEFAULT_BOARD_COLORS.map((c) => `<button class="dk-swatch ${c === (p.penColor || s.penColor) ? 'on' : ''}" data-c="${c}" style="background:${c}" aria-label="${c}"></button>`).join('')}</div>`)}
    ${field('Pen width', `<input type="range" id="dkSPenW" min="1" max="24" step="1" value="${p.penWidth || s.penWidth}">`)}
    <h4>Slide Presets</h4>
    <div class="dk-presets" id="dkPresets">${presets.length ? presets.map((pr) => `<div class="dk-preset" data-id="${pr.id}"><div class="dk-thumb-box">${slideHtml(pr.slide, (deckOf() || focusDeck())?.theme)}</div><input type="text" value="${esc(pr.name)}" aria-label="Preset name"><button class="btn btn-outline btn-sm" data-use>Insert</button><button class="btn btn-ghost btn-sm" data-del>Delete</button></div>`).join('') : '<p class="dk-hint">Right-click a slide and choose Save as Preset to add one.</p>'}</div>
    <div class="dk-btnrow"><button class="btn btn-outline btn-sm" id="dkPresetFromSel" ${slideOf() ? '' : 'disabled'}>Save Selected Slide as Preset</button></div>
    <h4>Saving</h4>${fsRow}`);
  wireSheet();
  const host = $('#dkSheet');
  $('#dkSSnapObj', host).onchange = (e) => { s.snapObjects = e.target.checked; markDirty(); };
  $('#dkSSnap', host).onchange = (e) => { s.snap = e.target.checked; markDirty(); };
  $('#dkSGridSize', host).onchange = (e) => { s.gridSize = clamp(+e.target.value || 40, 8, 200); markDirty(); applyTransform(); };
  $$('#dkSGrid .seg-btn', host).forEach((b) => { b.onclick = () => { s.grid = b.dataset.g; $$('#dkSGrid .seg-btn', host).forEach((x) => x.classList.toggle('on', x === b)); markDirty(); applyTransform(); }; });
  const rows = $$('.sheet-body > .fld .dk-colors', host);
  const mark = (row, b) => $$('.dk-swatch', row).forEach((x) => x.classList.toggle('on', x === b));
  $$('.dk-swatch', rows[0]).forEach((b) => { b.onclick = () => { s.bg = b.dataset.c; markDirty(); applyTransform(); mark(rows[0], b); }; });
  const well = $('.dk-cwell', rows[0]); if (well) well.oninput = (e) => { s.bg = e.target.value; markDirty(); applyTransform(); };
  $$('.dk-swatch', rows[1]).forEach((b) => { b.onclick = () => { p.stickyColor = b.dataset.c; savePrefs(); mark(rows[1], b); }; });
  $$('.dk-swatch', rows[2]).forEach((b) => { b.onclick = () => { p.penColor = b.dataset.c; savePrefs(); mark(rows[2], b); }; });
  $('#dkSPenW', host).onchange = (e) => { p.penWidth = +e.target.value; savePrefs(); };
  $$('.dk-preset', host).forEach((row) => {
    const id = row.dataset.id;
    $('input', row).onchange = (e) => { const list = loadPresets(); const t = list.find((x) => x.id === id); if (t) { t.name = e.target.value.trim() || t.name; savePresets(list); } };
    $('[data-use]', row).onclick = () => { const d = deckOf() || focusDeck(); const pr = loadPresets().find((x) => x.id === id); if (!d || !pr) return; const at = ed.ssel?.deck === d.id ? ed.ssel.i + 1 : d.slides.length; d.slides.splice(at, 0, cloneSlide(pr.slide)); commit(); closeSheet(); repaintDeck(d); selectSlide(d.id, at); };
    $('[data-del]', row).onclick = () => { savePresets(loadPresets().filter((x) => x.id !== id)); row.remove(); };
  });
  const fromSel = $('#dkPresetFromSel', host); if (fromSel) fromSel.onclick = () => { const sl = slideOf(); if (!sl) return; const name = prompt('Preset name', 'My Slide'); if (!name) return; const list = loadPresets(); list.push({ id: uid(), name, slide: cloneSlide(sl) }); savePresets(list); closeSheet(); openSettingsSheet(); };
  const con = $('#dkFsConnect', host); if (con) con.onclick = async () => { try { if (fsRemembered()) await fsReconnect(); else await fsConnect(); await flush(); closeSheet(); openSettingsSheet(); } catch (err) { alert(err.message || 'Could not connect the folder'); } };
  const now = $('#dkFsSaveNow', host); if (now) now.onclick = () => flush();
}

// ------------------------------------------------------------- slide view

function paintRail() {
  const rail = $('#dkRail'); const d = focusDeck(); if (!rail || !d) return;
  const cur = ed.ssel?.deck === d.id ? ed.ssel.i : 0;
  rail.innerHTML = `<div class="dk-rail-head"><select id="dkRailDeck" aria-label="Deck">${boardDecks(ed.board).map((x) => `<option value="${x.id}" ${x.id === d.id ? 'selected' : ''}>${esc(x.name)}</option>`).join('')}</select></div>` +
    d.slides.map((s, i) => `<div class="dk-thumb ${i === cur ? 'on' : ''} ${s.skip ? 'skip' : ''}" data-i="${i}" role="button" tabindex="0" aria-label="Slide ${i + 1}${s.skip ? ', skipped' : ''}" aria-current="${i === cur}"><span class="dk-thumb-n">${i + 1}</span><div class="dk-thumb-box">${slideHtml(s, d.theme)}</div>${s.skip ? `<span class="dk-thumb-skip">${iconSvg('eye-off')}</span>` : ''}</div>`).join('') + `<button class="btn btn-outline dk-add" id="dkAddSlide">${iconSvg('plus')} New Slide</button>`;
  hydrate(rail);
  $('#dkRailDeck').onchange = (e) => setView('slide', e.target.value);
  $$('.dk-thumb', rail).forEach((t) => {
    const go = () => { ed.ssel = { deck: d.id, i: +t.dataset.i, el: null }; ed.sslides = new Set(); paintRail(); paintSlideStage(); paintNotes(); paintPanel(); };
    t.onclick = go; t.onkeydown = (e) => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); go(); } };
    t.oncontextmenu = (e) => { e.preventDefault(); slideMenu(e, d, +t.dataset.i); };
    t.onpointerdown = (e) => startThumbDrag(e, t, d);
  });
  $('#dkAddSlide').onclick = (e) => layoutMenu(e, d);
}
let railT = 0;
function paintRailSoon() { clearTimeout(railT); railT = setTimeout(() => { if (ed?.view === 'slide') paintRail(); }, 600); }
function paintNotes() { const n = $('#dkNotes'); const s = slideOf(); if (n) n.value = s?.notes || ''; }
function paintSlideStage() {
  const wrap = $('#dkStageWrap'); const d = focusDeck(); if (!wrap || !d) return;
  if (!ed.ssel || ed.ssel.deck !== d.id) ed.ssel = { deck: d.id, i: 0, el: null };
  const s = d.slides[ed.ssel.i];
  wrap.innerHTML = `<div class="dk-stagebox">${slideHtml(s, d.theme)}<div class="dk-chrome" data-chrome="${d.id}:${ed.ssel.i}"></div></div>`;
  hydrate(wrap);
  const stage = $('.dk-stage', wrap);
  stage.addEventListener('pointerdown', onStageDown); stage.addEventListener('dblclick', onStageDblClick);
  paintChrome();
}
function startThumbDrag(e, node, d) {
  if (e.button !== 0) return;
  const from = +node.dataset.i; let started = false; const sy = e.clientY;
  const move = (ev) => { if (!started && Math.abs(ev.clientY - sy) > 6) { started = true; node.classList.add('dragging'); } if (!started) return; const over = document.elementFromPoint(ev.clientX, ev.clientY)?.closest('.dk-thumb'); $$('.dk-thumb').forEach((t) => t.classList.remove('drop')); if (over && over !== node) over.classList.add('drop'); };
  const up = (ev) => { window.removeEventListener('pointermove', move); window.removeEventListener('pointerup', up); if (!started) return; const over = document.elementFromPoint(ev.clientX, ev.clientY)?.closest('.dk-thumb'); node.classList.remove('dragging'); if (over && over !== node) { const to = +over.dataset.i; const [s] = d.slides.splice(from, 1); d.slides.splice(to, 0, s); ed.ssel.i = to; commit(); } paintAll(); };
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
    if (ed.dsel) { ed.dsel = null; paintChrome(); paintPanel(); return; }
    if (ed.ssel?.el) { ed.ssel.el = null; paintChrome(); paintPanel(); return; }
    if (ed.sel.size || ed.ssel) clearSel();
    return;
  }
  if (inField) return;
  const mod = e.metaKey || e.ctrlKey;
  if (mod && e.key.toLowerCase() === 'z') { e.preventDefault(); if (e.shiftKey) redo(); else undo(); return; }
  if (mod && e.key === '0') { e.preventDefault(); fitToContent(); return; }
  if (mod && (e.key === '=' || e.key === '+')) { e.preventDefault(); zoomBy(1.25); return; }
  if (mod && e.key === '-') { e.preventDefault(); zoomBy(0.8); return; }
  if (mod && e.key.toLowerCase() === 'a' && ed.view === 'board') { e.preventDefault(); if (ed.ssel && !selEl()) { const d = deckOf(); ed.sslides = new Set(d.slides.map((_, i) => i)); paintFrameSel(); paintPanel(); } else select(ed.board.items.filter((i) => isBox(i) && i.kind !== 'deck').map((i) => i.id)); return; }
  if (mod && e.key.toLowerCase() === 'c') { if (ed.sel.size || ed.ssel) { copySel(); e.preventDefault(); } return; }
  if (mod && e.key.toLowerCase() === 'v') { if (clipboard) { pasteAt(null); e.preventDefault(); } return; }
  const el = selEl();
  if (mod && e.key.toLowerCase() === 'd') {
    e.preventDefault();
    if (el) { const d = deckOf(); const c = JSON.parse(JSON.stringify(el)); c.id = uid(); c.x += 24; c.y += 24; slideOf().els.push(c); commit(); repaintDeck(d); selectSlide(d.id, ed.ssel.i, c.id); }
    else if (ed.ssel && slideOf()) duplicateSlides();
    else if (ed.sel.size) duplicateSel();
    return;
  }
  if (e.key === 'Delete' || e.key === 'Backspace') {
    if (el) { const d = deckOf(); slideOf().els = slideOf().els.filter((x) => x.id !== el.id); ed.ssel.el = null; commit(); repaintDeck(d); paintPanel(); paintRailSoon(); e.preventDefault(); return; }
    if (ed.dsel && slideOf()) { const s = slideOf(); dgmOf(s).elements = dgmOf(s).elements.filter((q) => q.id !== ed.dsel); ed.dsel = null; const d = deckOf(); commit(); repaintDeck(d); selectSlide(d.id, ed.ssel.i); e.preventDefault(); return; }
    if (ed.ssel && slideOf()) { deleteSlides(); e.preventDefault(); return; }
    if (ed.sel.size) { deleteSel(); e.preventDefault(); }
    return;
  }
  if (e.key === 'Enter' && el && el.type === 'text') { const node = $(`.dk-el[data-el="${el.id}"]`, currentStage()); if (node) { e.preventDefault(); editSlideText(node, deckOf(), ed.ssel.i, el); } return; }
  if (['ArrowUp', 'ArrowDown', 'ArrowLeft', 'ArrowRight'].includes(e.key)) {
    const step = e.shiftKey ? 10 : 1;
    const dx = e.key === 'ArrowLeft' ? -step : e.key === 'ArrowRight' ? step : 0; const dy = e.key === 'ArrowUp' ? -step : e.key === 'ArrowDown' ? step : 0;
    if (el) { el.x += dx; el.y += dy; commit(); repaintDeck(deckOf()); selectSlide(ed.ssel.deck, ed.ssel.i, el.id); e.preventDefault(); return; }
    if (ed.sel.size && ed.view === 'board' && !ed.ssel) { for (const it of selItems()) if (isBox(it) && !it.locked) { it.x += dx; it.y += dy; placeNode(it); } commit(); paintChrome(); paintConns(); e.preventDefault(); return; }
    if (ed.ssel && (dx || dy) && !el) { const d = deckOf(); const to = ed.ssel.i + (dx || dy > 0 ? 1 : 0) - (dy < 0 ? 1 : 0); const t2 = clamp(dx ? ed.ssel.i + Math.sign(dx) : to, 0, d.slides.length - 1); if (ed.view === 'slide') { ed.ssel = { deck: d.id, i: t2, el: null }; paintAll(); } else selectSlide(d.id, t2); e.preventDefault(); }
    return;
  }
  if (e.key === '[' || e.key === ']') { if (ed.sel.size && !ed.ssel) reorder(e.key === ']' ? 'up' : 'down'); return; }
  if (e.key === ' ' && ed.view === 'board') { ed.space = true; $('#dkBoard')?.classList.add('is-hand'); e.preventDefault(); return; }
  if (mod) return;
  // Tony's tool shortcuts (toolbar.js), then the built-in ones.
  const t = TB.toolForKey(e.key);
  if (t) { onTool(t, { clientX: innerWidth / 2 - 100, clientY: innerHeight - 260, target: $('#dkTools') }); return; }
}

// ------------------------------------------------------------- icons for the home page

export const I = {
  back: iconSvg('chevron-left'), plus: iconSvg('plus'), copy: iconSvg('copy'), trash: iconSvg('trash-2'),
};
