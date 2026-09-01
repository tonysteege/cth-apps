// The Decks editor: filmstrip, 16:9 stage, Design/Animate panel, floating
// tool bar, presenter notes tray. One renderer (render.js) draws every
// surface; the editor only wires pointers and state around it.
//
// Rules carried in from the suite:
// - IT SAVES ITSELF (700ms debounce, flush on the way out). No Save button.
// - A MEDIA TOOL ASKS FOR ITS FILE FIRST, then waits for a click to place.
// - Selection chrome lives in its own layer; a drag mutates styles in
//   place and only re-renders on release, so a mounted video survives.
// - Window-level pointer listeners, removed on teardown.

import { SLIDE_W, SLIDE_H, LAYOUTS, ANIM_STYLES, TRANSITIONS, styleOf, newSlide, newText, newShape, newImage, newVideo, newDiagram, normalizeDeck } from './model.js';
import { slideHtml, hydrate, esc } from './render.js';
import { getDeck, putDeck, putAsset, uid, listDrills } from './store.js';

let ed = null;
const $ = (sel, root) => (root || document).querySelector(sel);
const $$ = (sel, root) => [...(root || document).querySelectorAll(sel)];

export const editing = () => !!ed;

// ------------------------------------------------------------- autosave

let saveT = 0;
export function markDirty() {
  if (!ed) return;
  ed.deck.updated = Date.now();
  clearTimeout(saveT);
  saveT = setTimeout(flush, 700);
  paintStatus('Unsaved');
}

export async function flush() {
  clearTimeout(saveT);
  if (!ed) return;
  try {
    await putDeck(ed.deck);
    paintStatus('Saved');
  } catch (_) {
    paintStatus('Could not save');
  }
}

function paintStatus(word) {
  const n = $('#dkStatus');
  if (n) n.textContent = word;
}

// ------------------------------------------------------------- open/close

export async function openEditor(id) {
  const deck = normalizeDeck(await getDeck(id));
  if (!deck) { location.hash = '#/'; return; }
  ed = {
    deck, i: 0, sel: null, tool: 'select', place: null, view: 'board',
    tab: 'design', drag: null, un: [],
    // THE BOARD IS A WHITEBOARD (the proven Slides rule): slides sit at
    // fixed lefts and only the canvas transforms. Pan on two-finger swipe,
    // zoom about the pointer on pinch (ctrl+wheel).
    bd: { x: 60, y: 80, z: 0.55 },
  };
  const app = $('#app');
  app.innerHTML = shellHtml(deck);
  wireShell();
  paintAll();
  const onMove = (e) => onPointerMove(e);
  const onUp = (e) => onPointerUp(e);
  const onKey = (e) => onKeyDown(e);
  const onFlush = () => flush();
  window.addEventListener('pointermove', onMove);
  window.addEventListener('pointerup', onUp);
  window.addEventListener('keydown', onKey);
  window.addEventListener('pagehide', onFlush);
  document.addEventListener('visibilitychange', onFlush);
  ed.un.push(() => window.removeEventListener('pointermove', onMove));
  ed.un.push(() => window.removeEventListener('pointerup', onUp));
  ed.un.push(() => window.removeEventListener('keydown', onKey));
  ed.un.push(() => window.removeEventListener('pagehide', onFlush));
  ed.un.push(() => document.removeEventListener('visibilitychange', onFlush));
}

export function closeEditor() {
  if (!ed) return;
  flush();
  for (const fn of ed.un) { try { fn(); } catch (_) {} }
  ed = null;
}

// ------------------------------------------------------------- shell

function shellHtml(deck) {
  return `
  <div class="dk-editor">
    <header class="dk-head">
      <button class="btn btn-ghost btn-icon" id="dkBack" data-tip="Back to decks" aria-label="Back">${I.back}</button>
      <input class="dk-name" id="dkName" value="${esc(deck.name)}" aria-label="Deck name">
      <span class="dk-status" id="dkStatus">Saved</span>
      <div class="dk-head-r">
        <div class="seg" role="tablist" aria-label="View">
          <button class="seg-btn on" id="dkViewBoard" data-tip="Board view" aria-label="Board view">${I.grid}</button>
          <button class="seg-btn" id="dkViewSlide" data-tip="Slide view" aria-label="Slide view">${I.film}</button>
        </div>
        <button class="btn btn-outline" id="dkTheme">${I.palette} Theme</button>
        <button class="btn btn-primary" id="dkPresent">${I.play} Present</button>
      </div>
    </header>
    <div class="dk-main">
      <aside class="dk-rail" id="dkRail"></aside>
      <div class="dk-center">
        <div class="dk-stagewrap" id="dkStageWrap"></div>
        <div class="dk-notes"><textarea id="dkNotes" placeholder="Add presenter notes for this slide…" aria-label="Presenter notes" rows="2"></textarea></div>
        <div class="dk-toolbar" id="dkTools"></div>
        <div class="dk-placebar" id="dkPlace" hidden></div>
      </div>
      <aside class="dk-panel">
        <div class="tabs">
          <button class="tab on" data-tab="design">Design</button>
          <button class="tab" data-tab="animate">Animate</button>
        </div>
        <div class="dk-panel-body" id="dkPanel"></div>
      </aside>
    </div>
    <div id="dkSheet"></div>
  </div>`;
}

function wireShell() {
  $('#dkBack').onclick = () => { location.hash = '#/'; };
  $('#dkName').onchange = (e) => { ed.deck.name = e.target.value.trim() || 'Untitled Deck'; markDirty(); };
  $('#dkTheme').onclick = openThemeSheet;
  $('#dkPresent').onclick = () => { flush(); location.hash = `#/present/${ed.deck.id}`; };
  $('#dkViewSlide').onclick = () => setView('slide');
  $('#dkViewBoard').onclick = () => setView('board');
  $('#dkNotes').oninput = (e) => { slide().notes = e.target.value; markDirty(); };
  $$('.tab').forEach((t) => { t.onclick = () => { ed.tab = t.dataset.tab; $$('.tab').forEach((x) => x.classList.toggle('on', x === t)); paintPanel(); }; });
}

function setView(v) {
  ed.view = v;
  $('#dkViewSlide').classList.toggle('on', v === 'slide');
  $('#dkViewBoard').classList.toggle('on', v === 'board');
  paintStage();
}

const slide = () => ed.deck.slides[ed.i];
const selEl = () => (ed.sel ? slide().els.find((e) => e.id === ed.sel) : null);

// ------------------------------------------------------------- painting

function paintAll() { paintRail(); paintStage(); paintTools(); paintPanel(); paintNotes(); }

function paintNotes() { const n = $('#dkNotes'); if (n) n.value = slide().notes || ''; }

function paintRail() {
  const rail = $('#dkRail');
  rail.innerHTML = ed.deck.slides.map((s, i) => `
    <div class="dk-thumb ${i === ed.i ? 'on' : ''} ${s.skip ? 'skip' : ''}" data-i="${i}" role="button" tabindex="0" aria-label="Slide ${i + 1}${s.skip ? ', skipped' : ''}" aria-current="${i === ed.i ? 'true' : 'false'}">
      <span class="dk-thumb-n">${i + 1}</span>
      <div class="dk-thumb-box">${slideHtml(s, ed.deck.theme)}</div>
      ${s.skip ? `<span class="dk-thumb-skip" data-tip="Skipped in present">${I.eyeOff}</span>` : ''}
    </div>`).join('') + `
    <button class="btn btn-outline dk-add" id="dkAddSlide">${I.plus} New Slide</button>`;
  hydrate(rail);
  $$('.dk-thumb', rail).forEach((t) => {
    t.onclick = () => { ed.i = +t.dataset.i; ed.sel = null; paintAll(); };
    t.onkeydown = (e) => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); ed.i = +t.dataset.i; ed.sel = null; paintAll(); } };
    t.oncontextmenu = (e) => { e.preventDefault(); slideMenu(e, +t.dataset.i); };
    t.onpointerdown = (e) => startThumbDrag(e, t);
  });
  $('#dkAddSlide').onclick = (e) => layoutMenu(e);
}

// Frames sit at FIXED lefts; only the canvas transforms. Chrome inside the
// canvas is scaled back out by --inv (1/zoom) or it vanishes when zoomed
// out - both rules proven on the Slides board.
const FRAME_W = 960;
const FRAME_GAP = 60;

function paintStage() {
  const wrap = $('#dkStageWrap');
  if (ed.view === 'board') {
    const b = ed.bd;
    wrap.innerHTML = `<div class="dk-board" id="dkBoard"><div class="dk-canvas" id="dkCanvas">${ed.deck.slides.map((s, i) => `
      <div class="dk-frame ${i === ed.i ? 'on' : ''}" data-i="${i}" style="left:${i * (FRAME_W + FRAME_GAP)}px;top:0;width:${FRAME_W}px">
        <button class="dk-fnum" data-tip="Slide ${i + 1}" aria-label="Select slide ${i + 1}">${i + 1}</button>
        ${slideHtml(s, ed.deck.theme)}
        <div class="dk-chrome" data-chrome="${i}"></div>
      </div>`).join('')}</div></div>`;
    hydrate(wrap);
    applyBoardTransform();
    const board = $('#dkBoard');
    board.addEventListener('wheel', onBoardWheel, { passive: false });
    $$('.dk-stage', wrap).forEach((st) => {
      st.addEventListener('pointerdown', onStageDown);
      st.addEventListener('dblclick', onStageDblClick);
    });
    $$('.dk-fnum', wrap).forEach((n) => { n.onclick = () => { setCurrent(+n.closest('.dk-frame').dataset.i); }; });
    board.addEventListener('pointerdown', (e) => { if (e.target === board || e.target.id === 'dkCanvas') { ed.sel = null; paintChrome(); paintPanel(); } });
    // Double-click the empty board to fit the row back into view.
    board.addEventListener('dblclick', (e) => { if (e.target === board || e.target.id === 'dkCanvas') { ed.bd = { x: 60, y: 80, z: 0.55 }; applyBoardTransform(); } });
    paintChrome();
    return;
  }
  wrap.innerHTML = `<div class="dk-stagebox">${slideHtml(slide(), ed.deck.theme)}<div class="dk-chrome" data-chrome="${ed.i}"></div></div>`;
  hydrate(wrap);
  const stage = $('.dk-stage', wrap);
  stage.addEventListener('pointerdown', onStageDown);
  stage.addEventListener('dblclick', onStageDblClick);
  paintChrome();
}

function applyBoardTransform() {
  const c = $('#dkCanvas');
  if (!c) return;
  const b = ed.bd;
  c.style.transform = `translate(${b.x}px, ${b.y}px) scale(${b.z})`;
  c.style.setProperty('--inv', String(1 / b.z));
}

function onBoardWheel(e) {
  e.preventDefault();
  const b = ed.bd;
  if (e.ctrlKey) {
    // Zoom about the pointer: pan = p - (p - pan) * (next/current).
    const rect = $('#dkBoard').getBoundingClientRect();
    const px = e.clientX - rect.left; const py = e.clientY - rect.top;
    // The same gain and per-event clamp the Clips pinch uses - without the
    // clamp a coalesced wheel burst teleports the whole board.
    const factor = Math.max(0.8, Math.min(1.25, Math.exp(-e.deltaY * 0.012)));
    const next = Math.max(0.12, Math.min(2.5, b.z * factor));
    b.x = px - (px - b.x) * (next / b.z);
    b.y = py - (py - b.y) * (next / b.z);
    b.z = next;
  } else {
    b.x -= e.deltaX;
    b.y -= e.deltaY;
  }
  applyBoardTransform();
}

// THE VARIABLE THAT DECIDES WHERE AN EDIT GOES IS THE STAGE, NOT AN INDEX
// (the Slides board rule): every pointer resolves against the stage it
// landed on, so a selection can never straddle two slides.
function setCurrent(i) {
  if (i === ed.i) return;
  ed.i = i;
  ed.sel = null;
  $$('.dk-frame').forEach((f) => f.classList.toggle('on', +f.dataset.i === i));
  $$('.dk-thumb').forEach((t) => t.classList.toggle('on', +t.dataset.i === i));
  paintChrome(); paintPanel(); paintNotes();
}

function paintChrome() {
  $$('.dk-chrome').forEach((c) => { if (+c.dataset.chrome !== ed.i) c.innerHTML = ''; });
  const chrome = $(`.dk-chrome[data-chrome="${ed.i}"]`);
  if (!chrome) return;
  const e = selEl();
  if (!e) { chrome.innerHTML = ''; return; }
  const l = (e.x / SLIDE_W) * 100; const t = (e.y / SLIDE_H) * 100;
  const w = (e.w / SLIDE_W) * 100; const h = (e.h / SLIDE_H) * 100;
  chrome.innerHTML = `<div class="dk-selbox" style="left:${l}%;top:${t}%;width:${w}%;height:${h}%">
    <span class="dk-grip" data-g="nw"></span><span class="dk-grip" data-g="ne"></span>
    <span class="dk-grip" data-g="sw"></span><span class="dk-grip" data-g="se"></span>
  </div>`;
  $$('.dk-grip', chrome).forEach((g) => {
    g.onpointerdown = (ev) => { ev.stopPropagation(); startDrag(ev, 'resize', g.dataset.g); };
  });
  $('.dk-selbox', chrome).onpointerdown = (ev) => { ev.stopPropagation(); startDrag(ev, 'move'); };
}

// ------------------------------------------------------------- toolbar

const TOOLS = [
  { id: 'select', tip: 'Select (V)', icon: () => I.cursor },
  { id: 'text', tip: 'Text (T)', icon: () => I.text, menu: textMenu },
  { id: 'shape', tip: 'Shapes (R)', icon: () => I.shapes, menu: shapeMenu },
  { id: 'image', tip: 'Image', icon: () => I.image, pick: () => pickMedia('image') },
  { id: 'video', tip: 'Video', icon: () => I.video, pick: () => pickMedia('video') },
  { id: 'diagram', tip: 'Rink diagram', icon: () => I.rink, pick: openDrillPicker },
];

function paintTools() {
  const bar = $('#dkTools');
  bar.innerHTML = TOOLS.map((t) => `<button class="dk-tool ${ed.tool === t.id ? 'on' : ''}" data-tool="${t.id}" data-tip="${t.tip}" aria-label="${t.tip}" aria-pressed="${ed.tool === t.id}">${t.icon()}</button>`).join('');
  $$('.dk-tool', bar).forEach((b) => {
    const t = TOOLS.find((x) => x.id === b.dataset.tool);
    b.onclick = (e) => {
      if (t.menu) { t.menu(e); return; }
      if (t.pick) { t.pick(); return; }
      armTool(t.id);
    };
  });
}

function armTool(id, place = null) {
  ed.tool = id;
  ed.place = place;
  // A selection's own chrome sits above the stage and would swallow the
  // placement click - an armed placement drops the selection first.
  if (place && ed.sel) { ed.sel = null; paintChrome(); }
  paintTools();
  const bar = $('#dkPlace');
  if (place) { bar.hidden = false; bar.textContent = place.hint; }
  else bar.hidden = true;
}

// ------------------------------------------------------------- menus

function menuAt(e, items) {
  closeMenu();
  const m = document.createElement('div');
  m.className = 'menu';
  m.innerHTML = items.map((it, i) => (it === '-' ? '<div class="menu-sep"></div>' : `<button class="menu-item" data-i="${i}">${esc(it.label)}</button>`)).join('');
  document.body.appendChild(m);
  const r = (e.currentTarget || e.target).getBoundingClientRect();
  const x = Math.min(e.clientX || r.left, innerWidth - 240);
  const y = Math.min((e.clientY || r.bottom) + 4, innerHeight - m.offsetHeight - 8);
  m.style.left = `${x}px`; m.style.top = `${y}px`;
  $$('.menu-item', m).forEach((b) => { b.onclick = () => { const it = items[+b.dataset.i]; closeMenu(); it.run(); }; });
  setTimeout(() => document.addEventListener('pointerdown', menuAway, { once: true }));
}
function menuAway(e) { if (!e.target.closest('.menu')) closeMenu(); else setTimeout(() => document.addEventListener('pointerdown', menuAway, { once: true })); }
function closeMenu() { $$('.menu').forEach((m) => m.remove()); }

function textMenu(e) {
  menuAt(e, Object.entries(ed.deck.theme.styles).map(([role, st]) => ({
    label: st.label || role,
    run: () => armTool('text', { kind: 'text', role, hint: 'Click the slide to place the text' }),
  })));
}

function shapeMenu(e) {
  menuAt(e, [
    { label: 'Rectangle', run: () => armTool('shape', { kind: 'shape', shape: 'rect', hint: 'Click the slide to place a rectangle' }) },
    { label: 'Ellipse', run: () => armTool('shape', { kind: 'shape', shape: 'ellipse', hint: 'Click the slide to place an ellipse' }) },
    { label: 'Line', run: () => armTool('shape', { kind: 'shape', shape: 'line', hint: 'Click the slide to place a line' }) },
    { label: 'Arrow', run: () => armTool('shape', { kind: 'shape', shape: 'arrow', hint: 'Click the slide to place an arrow' }) },
  ]);
}

function layoutMenu(e) {
  menuAt(e, Object.entries(LAYOUTS).map(([k, v]) => ({
    label: v.label,
    run: () => { ed.deck.slides.splice(ed.i + 1, 0, newSlide(k)); ed.i += 1; ed.sel = null; markDirty(); paintAll(); },
  })));
}

function slideMenu(e, i) {
  const s = ed.deck.slides[i];
  menuAt(e, [
    { label: 'Duplicate', run: () => { const c = JSON.parse(JSON.stringify(s)); c.id = uid(); c.els.forEach((x) => { x.id = uid(); }); ed.deck.slides.splice(i + 1, 0, c); markDirty(); paintAll(); } },
    { label: s.skip ? 'Include in present' : 'Skip slide', run: () => { s.skip = !s.skip; markDirty(); paintRail(); } },
    '-',
    { label: 'Delete', run: () => { if (ed.deck.slides.length <= 1) return; if (!confirm(`Delete slide ${i + 1}? This cannot be undone.`)) return; ed.deck.slides.splice(i, 1); ed.i = Math.min(ed.i, ed.deck.slides.length - 1); ed.sel = null; markDirty(); paintAll(); } },
  ]);
}

// ------------------------------------------------------------- media in

// ASK FOR THE FILE FIRST, then a click places it (the Slides rule - the
// reverse order made the tools read as broken).
function pickMedia(kind) {
  const inp = document.createElement('input');
  inp.type = 'file';
  inp.accept = kind === 'image' ? 'image/*' : 'video/*';
  inp.onchange = async () => {
    const f = inp.files && inp.files[0];
    if (!f) return;
    const id = uid();
    await putAsset(id, f);
    armTool(kind, { kind, asset: id, hint: `Click the slide to place ${f.name}` });
  };
  inp.click();
}

async function openDrillPicker() {
  const drills = await listDrills();
  const host = $('#dkSheet');
  if (!drills.length) {
    host.innerHTML = sheetHtml('Rink Diagrams', '<p class="dk-empty">No saved diagrams yet. Draw one in the Diagrams app and it will appear here.</p>');
  } else {
    host.innerHTML = sheetHtml('Rink Diagrams', `<div class="dk-drills">${drills.map((d) => `
      <button class="dk-drill" data-id="${esc(d.id)}">${d.thumb ? `<img src="${esc(d.thumb)}" alt="" decoding="async">` : '<span class="dk-drill-blank" aria-hidden="true"></span>'}<span>${esc(d.name || 'Untitled')}</span></button>`).join('')}</div>`);
    $$('.dk-drill', host).forEach((b) => {
      b.onclick = () => { closeSheet(); armTool('diagram', { kind: 'diagram', drill: b.dataset.id, hint: 'Click the slide to place the diagram' }); };
    });
  }
  wireSheet();
}

// ------------------------------------------------------------- pointers

function stagePoint(e, stageEl) {
  const stage = stageEl || $(`.dk-frame[data-i="${ed.i}"] .dk-stage`) || $('.dk-stage', $('#dkStageWrap'));
  const r = stage.getBoundingClientRect();
  return {
    x: ((e.clientX - r.left) / r.width) * SLIDE_W,
    y: ((e.clientY - r.top) / r.height) * SLIDE_H,
    scale: r.width / SLIDE_W,
  };
}

function onStageDown(e) {
  const stage = e.currentTarget;
  const frame = stage.closest('.dk-frame');
  if (frame) setCurrent(+frame.dataset.i);
  const p = stagePoint(e, stage);
  if (ed.place) { placeAt(p); return; }
  const elNode = e.target.closest('.dk-el');
  if (!elNode) { ed.sel = null; paintChrome(); paintPanel(); return; }
  ed.sel = elNode.dataset.el;
  paintChrome(); paintPanel();
  startDrag(e, 'move');
}

function placeAt(p) {
  const pl = ed.place;
  let el = null;
  if (pl.kind === 'text') el = newText(pl.role, { x: p.x, y: p.y - 40 });
  else if (pl.kind === 'shape') el = newShape(pl.shape, { x: p.x - 200, y: p.y - 120, ...(pl.shape === 'line' || pl.shape === 'arrow' ? { w: 400, h: 40, y: p.y - 20 } : {}) });
  else if (pl.kind === 'image') el = newImage(pl.asset, { x: p.x - 400, y: p.y - 250 });
  else if (pl.kind === 'video') el = newVideo(pl.asset, { x: p.x - 560, y: p.y - 315 });
  else if (pl.kind === 'diagram') el = newDiagram(pl.drill, { x: p.x - 480, y: p.y - 240 });
  if (!el) return;
  el.x = Math.max(0, Math.min(SLIDE_W - el.w, el.x));
  el.y = Math.max(0, Math.min(SLIDE_H - el.h, el.y));
  slide().els.push(el);
  ed.sel = el.id;
  armTool('select');
  markDirty();
  paintStage(); paintPanel(); paintRailSoon();
}

function startDrag(e, mode, grip) {
  const el = selEl();
  if (!el) return;
  const p = stagePoint(e);
  ed.drag = { mode, grip, sx: p.x, sy: p.y, ox: el.x, oy: el.y, ow: el.w, oh: el.h, moved: false };
  e.preventDefault();
}

function onPointerMove(e) {
  if (!ed || !ed.drag) return;
  const el = selEl();
  if (!el) { ed.drag = null; return; }
  const p = stagePoint(e);
  const dx = p.x - ed.drag.sx; const dy = p.y - ed.drag.sy;
  if (Math.abs(dx) + Math.abs(dy) > 2) ed.drag.moved = true;
  if (ed.drag.mode === 'move') {
    el.x = Math.round(ed.drag.ox + dx);
    el.y = Math.round(ed.drag.oy + dy);
  } else {
    const g = ed.drag.grip;
    let { ox: x, oy: y, ow: w, oh: h } = ed.drag;
    if (g.includes('e')) w = Math.max(24, ed.drag.ow + dx);
    if (g.includes('s')) h = Math.max(24, ed.drag.oh + dy);
    if (g.includes('w')) { w = Math.max(24, ed.drag.ow - dx); x = ed.drag.ox + (ed.drag.ow - w); }
    if (g.includes('n')) { h = Math.max(24, ed.drag.oh - dy); y = ed.drag.oy + (ed.drag.oh - h); }
    el.x = Math.round(x); el.y = Math.round(y); el.w = Math.round(w); el.h = Math.round(h);
  }
  // Mutate in place - re-rendering mid-drag tears down a mounted video.
  const node = $(`.dk-el[data-el="${el.id}"]`, $('#dkStageWrap'));
  if (node) {
    node.style.left = `${(el.x / SLIDE_W) * 100}%`;
    node.style.top = `${(el.y / SLIDE_H) * 100}%`;
    node.style.width = `${(el.w / SLIDE_W) * 100}%`;
    node.style.height = `${(el.h / SLIDE_H) * 100}%`;
  }
  paintChrome();
}

function onPointerUp() {
  if (!ed || !ed.drag) return;
  const moved = ed.drag.moved;
  ed.drag = null;
  if (moved) { markDirty(); paintPanel(); paintRailSoon(); }
}

let railT = 0;
function paintRailSoon() { clearTimeout(railT); railT = setTimeout(paintRail, 600); }

function onStageDblClick(e) {
  const node = e.target.closest('.dk-el-text');
  if (!node) return;
  const el = slide().els.find((x) => x.id === node.dataset.el);
  if (!el) return;
  ed.sel = el.id;
  node.contentEditable = 'plaintext-only';
  node.focus();
  const range = document.createRange();
  range.selectNodeContents(node); range.collapse(false);
  const s = getSelection(); s.removeAllRanges(); s.addRange(range);
  const done = () => {
    node.contentEditable = 'false';
    el.text = node.innerText.replace(/\n$/, '');
    markDirty(); paintStage(); paintPanel(); paintRailSoon();
  };
  node.onblur = done;
  node.onkeydown = (ev) => { if (ev.key === 'Escape') { ev.stopPropagation(); node.blur(); } };
}

function onKeyDown(e) {
  if (!ed) return;
  const inField = /INPUT|TEXTAREA|SELECT/.test(e.target.tagName) || e.target.isContentEditable;
  if (e.key === 'Escape') {
    closeMenu();
    if ($('.sheet-veil')) { closeSheet(); return; }
    if (inField) return;
    if (ed.place) { armTool('select'); return; }
    if (ed.sel) { ed.sel = null; paintChrome(); paintPanel(); return; }
    return;
  }
  if (inField) return;
  const el = selEl();
  if ((e.key === 'Delete' || e.key === 'Backspace') && el) {
    slide().els = slide().els.filter((x) => x.id !== el.id);
    ed.sel = null; markDirty(); paintStage(); paintPanel(); paintRailSoon();
    e.preventDefault(); return;
  }
  if (e.metaKey && e.key === 'd' && el) {
    const c = JSON.parse(JSON.stringify(el));
    c.id = uid(); c.x += 24; c.y += 24;
    slide().els.push(c); ed.sel = c.id;
    markDirty(); paintStage(); paintPanel();
    e.preventDefault(); return;
  }
  if (!el && (e.key === 'ArrowLeft' || e.key === 'ArrowRight')) {
    const to = ed.i + (e.key === 'ArrowRight' ? 1 : -1);
    if (to >= 0 && to < ed.deck.slides.length) { ed.i = to; ed.sel = null; paintAll(); }
    e.preventDefault(); return;
  }
  if (el && ['ArrowUp', 'ArrowDown', 'ArrowLeft', 'ArrowRight'].includes(e.key)) {
    const step = e.shiftKey ? 10 : 1;
    if (e.key === 'ArrowUp') el.y -= step;
    if (e.key === 'ArrowDown') el.y += step;
    if (e.key === 'ArrowLeft') el.x -= step;
    if (e.key === 'ArrowRight') el.x += step;
    markDirty(); paintStage(); e.preventDefault(); return;
  }
  if (e.key === 'v') armTool('select');
  if (e.key === 't') textMenu({ clientX: innerWidth / 2 - 100, clientY: innerHeight - 260, target: $('#dkTools') });
}

// ------------------------------------------------------------- panel

function paintPanel() {
  const host = $('#dkPanel');
  if (ed.tab === 'animate') { paintAnimate(host); return; }
  const el = selEl();
  if (!el) { host.innerHTML = slidePanelHtml(); wireSlidePanel(host); return; }
  host.innerHTML = elPanelHtml(el);
  wireElPanel(host, el);
}

const field = (label, inner) => `<label class="fld"><span>${label}</span>${inner}</label>`;
const colorRow = (id, value) => `<div class="dk-colors" data-for="${id}">${ed.deck.theme.colors.map((c) => `<button class="dk-swatch ${c === value ? 'on' : ''}" data-c="${c}" style="background:${c}"></button>`).join('')}<input type="color" class="dk-cwell" value="${/^#([0-9a-f]{6})$/i.test(value || '') ? value : '#0a0a0a'}"></div>`;

function slidePanelHtml() {
  const s = slide();
  return `<div class="dk-sect"><h3>Slide ${ed.i + 1}</h3>
    ${field('Background', colorRow('bg', s.bg))}
    <label class="fld-check"><input type="checkbox" id="dkSkip" ${s.skip ? 'checked' : ''}> Skip in present</label>
  </div>`;
}

function wireSlidePanel(host) {
  wireColors(host, (c) => { slide().bg = c; markDirty(); paintStage(); paintRailSoon(); paintPanel(); });
  $('#dkSkip', host).onchange = (e) => { slide().skip = e.target.checked; markDirty(); paintRail(); };
}

function elPanelHtml(el) {
  if (el.type === 'text') {
    const st = styleOf(ed.deck.theme, el.role);
    return `<div class="dk-sect"><h3>Text</h3>
      ${field('Style', `<select id="dkRole">${Object.entries(ed.deck.theme.styles).map(([r, s]) => `<option value="${r}" ${r === el.role ? 'selected' : ''}>${esc(s.label || r)}</option>`).join('')}</select>`)}
      ${field('Size', `<input type="number" id="dkSize" value="${el.size || st.size}" min="8" max="400">`)}
      ${field('Align', `<div class="seg" id="dkAlign">${['left', 'center', 'right'].map((a) => `<button class="seg-btn ${(el.align || 'left') === a ? 'on' : ''}" data-a="${a}" aria-label="Align ${a}">${I[a]}</button>`).join('')}</div>`)}
      ${field('Color', colorRow('color', el.color || st.color))}
    </div>`;
  }
  if (el.type === 'shape') {
    return `<div class="dk-sect"><h3>Shape</h3>
      ${field('Fill', colorRow('fill', el.fill))}
      ${field('Opacity', `<input type="range" id="dkAlpha" min="0.1" max="1" step="0.05" value="${el.alpha == null ? 1 : el.alpha}">`)}
      ${el.shape === 'rect' ? field('Corner radius', `<input type="number" id="dkRadius" value="${el.radius || 0}" min="0" max="200">`) : ''}
      ${field('Label', `<input type="text" id="dkShapeText" value="${esc(el.text || '')}">`)}
    </div>`;
  }
  if (el.type === 'diagram') {
    return `<div class="dk-sect"><h3>Rink Diagram</h3>
      <label class="fld-check"><input type="checkbox" id="dkAnimate" ${el.animate ? 'checked' : ''}> Play drill animation in present</label>
      <p class="dk-hint">Drawn in the Diagrams app; this slide renders it live through the same renderer as the exported PNG.</p>
    </div>`;
  }
  if (el.type === 'video') {
    return `<div class="dk-sect"><h3>Video</h3>
      <p class="dk-hint">In present mode a two-finger swipe scrubs the film - the Clips scrub engine, same feel.</p>
    </div>`;
  }
  return `<div class="dk-sect"><h3>${el.type === 'image' ? 'Image' : 'Object'}</h3></div>`;
}

function wireElPanel(host, el) {
  wireColors(host, (c) => {
    if (el.type === 'text') el.color = c; else el.fill = c;
    markDirty(); paintStage(); paintPanel();
  });
  const role = $('#dkRole', host); if (role) role.onchange = (e) => { el.role = e.target.value; el.size = null; el.color = null; markDirty(); paintStage(); paintPanel(); };
  const size = $('#dkSize', host); if (size) size.onchange = (e) => { el.size = Math.max(8, Math.min(400, +e.target.value || 36)); markDirty(); paintStage(); };
  const align = $('#dkAlign', host); if (align) $$('.seg-btn', align).forEach((b) => { b.onclick = () => { el.align = b.dataset.a; markDirty(); paintStage(); paintPanel(); }; });
  const alpha = $('#dkAlpha', host); if (alpha) alpha.oninput = (e) => { el.alpha = +e.target.value; markDirty(); paintStage(); };
  const rad = $('#dkRadius', host); if (rad) rad.onchange = (e) => { el.radius = Math.max(0, +e.target.value || 0); markDirty(); paintStage(); };
  const stext = $('#dkShapeText', host); if (stext) stext.onchange = (e) => { el.text = e.target.value; markDirty(); paintStage(); };
  const anim = $('#dkAnimate', host); if (anim) anim.onchange = (e) => { el.animate = e.target.checked; markDirty(); };
}

function wireColors(host, apply) {
  $$('.dk-colors', host).forEach((row) => {
    $$('.dk-swatch', row).forEach((b) => { b.onclick = () => apply(b.dataset.c); });
    $('.dk-cwell', row).oninput = (e) => apply(e.target.value);
  });
}

// ------------------------------------------------------------- animate

function paintAnimate(host) {
  const s = slide();
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
      ${animated.length ? `<div class="dk-animlist">${animated.map((x, n) => `
        <button class="dk-animrow ${x.id === ed.sel ? 'on' : ''}" data-el="${x.id}">
          <span class="dk-animn">${n + 1}</span><span>${animLabel(x)}</span><span class="dk-animx" data-x="${x.id}">${I.x}</span>
        </button>`).join('')}</div>` : ''}
    </div>`;
  $('#dkTrStyle', host).onchange = (e) => { s.transition = { ...tr, style: e.target.value }; markDirty(); };
  $('#dkTrDur', host).onchange = (e) => { s.transition = { ...tr, durMs: Math.max(100, +e.target.value || 300) }; markDirty(); };
  $('#dkTrAll', host).onclick = () => { for (const sl of ed.deck.slides) sl.transition = { ...(s.transition || tr) }; markDirty(); };
  const add = $('#dkAnimAdd', host);
  if (add) add.onclick = () => {
    const max = Math.max(0, ...s.els.filter((x) => x.anim).map((x) => x.anim.order || 0));
    el.anim = { io: 'in', style: 'fade', durMs: 600, order: max + 1 };
    markDirty(); paintAnimate(host);
  };
  if (el && el.anim) wireAnimEditor(host, el);
  $$('.dk-animrow', host).forEach((r) => { r.onclick = (ev) => { if (ev.target.closest('.dk-animx')) return; ed.sel = r.dataset.el; paintChrome(); paintAnimate(host); }; });
  $$('.dk-animx', host).forEach((x) => { x.onclick = () => { const t = s.els.find((y) => y.id === x.dataset.x); if (t) delete t.anim; markDirty(); paintAnimate(host); }; });
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
  $('#dkAStyle', host).onchange = (e) => { el.anim.style = e.target.value; markDirty(); };
  $$('#dkAIO .seg-btn', host).forEach((b) => { b.onclick = () => { el.anim.io = b.dataset.io; markDirty(); paintAnimate(host); }; });
  $('#dkADur', host).onchange = (e) => { el.anim.durMs = Math.max(100, +e.target.value || 600); markDirty(); };
  $('#dkAOrder', host).onchange = (e) => { el.anim.order = Math.max(1, +e.target.value || 1); markDirty(); paintAnimate(host); };
  $('#dkARemove', host).onclick = () => { delete el.anim; markDirty(); paintAnimate(host); };
}

// ------------------------------------------------------------- theme

function openThemeSheet() {
  const t = ed.deck.theme;
  const rows = Object.entries(t.styles).map(([r, s]) => `
    <div class="dk-trow" data-role="${r}">
      <span class="dk-trole">${esc(s.label || r)}</span>
      <input type="number" class="dk-tsize" value="${s.size}" min="8" max="400" data-tip="Size">
      <select class="dk-tweight" data-tip="Weight">${[400, 500, 600, 700, 800].map((w) => `<option ${w === s.weight ? 'selected' : ''}>${w}</option>`).join('')}</select>
      <input type="color" class="dk-tcolor" value="${s.color}" data-tip="Color">
    </div>`).join('');
  const colors = `<div class="dk-colors dk-theme-colors">${t.colors.map((c, i) => `<input type="color" class="dk-cwell" data-i="${i}" value="${c}">`).join('')}</div>`;
  $('#dkSheet').innerHTML = sheetHtml('Theme', `
    <h4>Text styles</h4><div class="dk-theme-rows">${rows}</div>
    <h4>Colors</h4>${colors}
    <p class="dk-hint">Styles cascade: every text element using a style updates when the style changes.</p>`);
  wireSheet();
  $$('.dk-trow').forEach((row) => {
    const st = t.styles[row.dataset.role];
    $('.dk-tsize', row).onchange = (e) => { st.size = Math.max(8, +e.target.value || st.size); themed(); };
    $('.dk-tweight', row).onchange = (e) => { st.weight = +e.target.value; themed(); };
    $('.dk-tcolor', row).oninput = (e) => { st.color = e.target.value; themed(); };
  });
  $$('.dk-theme-colors .dk-cwell').forEach((w) => { w.oninput = (e) => { t.colors[+w.dataset.i] = e.target.value; themed(); }; });
}

function themed() { markDirty(); paintStage(); paintRailSoon(); }

// ------------------------------------------------------------- sheet

const sheetHtml = (title, body) => `
  <div class="sheet-veil"><div class="sheet">
    <header><h2>${esc(title)}</h2><button class="btn btn-ghost btn-icon" data-close aria-label="Close">${I.x}</button></header>
    <div class="sheet-body">${body}</div>
  </div></div>`;

function wireSheet() {
  const veil = $('.sheet-veil');
  if (!veil) return;
  veil.onclick = (e) => { if (e.target === veil || e.target.closest('[data-close]')) closeSheet(); };
}
export function closeSheet() { const v = $('.sheet-veil'); if (v) v.remove(); }

// ------------------------------------------------------------- filmstrip drag

function startThumbDrag(e, node) {
  if (e.button !== 0) return;
  const from = +node.dataset.i;
  let started = false;
  const sy = e.clientY;
  const move = (ev) => {
    if (!started && Math.abs(ev.clientY - sy) > 6) { started = true; node.classList.add('dragging'); }
    if (!started) return;
    const over = document.elementFromPoint(ev.clientX, ev.clientY)?.closest('.dk-thumb');
    $$('.dk-thumb').forEach((t) => t.classList.remove('drop'));
    if (over && over !== node) over.classList.add('drop');
  };
  const up = (ev) => {
    window.removeEventListener('pointermove', move);
    window.removeEventListener('pointerup', up);
    if (!started) return;
    const over = document.elementFromPoint(ev.clientX, ev.clientY)?.closest('.dk-thumb');
    node.classList.remove('dragging');
    if (over && over !== node) {
      const to = +over.dataset.i;
      const [s] = ed.deck.slides.splice(from, 1);
      ed.deck.slides.splice(to, 0, s);
      ed.i = to;
      markDirty();
    }
    paintAll();
  };
  window.addEventListener('pointermove', move);
  window.addEventListener('pointerup', up);
}

// ------------------------------------------------------------- icons
// Inline SVG glyphs (lucide-style, the icon set shadcn ships with), drawn
// at 1.75 stroke on a 24 grid.

const svg = (d) => `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.75" stroke-linecap="round" stroke-linejoin="round">${d}</svg>`;
export const I = {
  back: svg('<path d="M15 18l-6-6 6-6"/>'),
  plus: svg('<path d="M12 5v14M5 12h14"/>'),
  play: svg('<path d="M6 4l14 8-14 8z"/>'),
  film: svg('<rect x="3" y="5" width="12" height="14" rx="2"/><path d="M19 7v10"/><path d="M22 9v6"/>'),
  grid: svg('<rect x="3" y="3" width="7" height="7" rx="1.5"/><rect x="14" y="3" width="7" height="7" rx="1.5"/><rect x="3" y="14" width="7" height="7" rx="1.5"/><rect x="14" y="14" width="7" height="7" rx="1.5"/>'),
  palette: svg('<circle cx="12" cy="12" r="9"/><circle cx="8.5" cy="10" r="1"/><circle cx="12" cy="7.5" r="1"/><circle cx="15.5" cy="10" r="1"/><path d="M12 21a3 3 0 0 0 0-6h-1a2 2 0 0 1 0-4"/>'),
  cursor: svg('<path d="M4 3l7.5 18 2.2-7.3L21 11.5z"/>'),
  text: svg('<path d="M4 6V4h16v2"/><path d="M12 4v16"/><path d="M9 20h6"/>'),
  shapes: svg('<rect x="3" y="13" width="8" height="8" rx="1.5"/><circle cx="16.5" cy="7.5" r="4.5"/>'),
  image: svg('<rect x="3" y="4" width="18" height="16" rx="2"/><circle cx="9" cy="10" r="1.6"/><path d="M4 19l6-6 4 4 3-3 3 3"/>'),
  video: svg('<rect x="3" y="6" width="13" height="12" rx="2"/><path d="M16 10.5l5-3v9l-5-3"/>'),
  rink: svg('<rect x="2.5" y="6" width="19" height="12" rx="5"/><path d="M12 6v12"/><circle cx="12" cy="12" r="1.6"/>'),
  eyeOff: svg('<path d="M3 3l18 18"/><path d="M10.6 5.1A9.8 9.8 0 0 1 12 5c7 0 10 7 10 7a17 17 0 0 1-3.2 4.2M6.6 6.6A16.9 16.9 0 0 0 2 12s3 7 10 7a9.7 9.7 0 0 0 5.4-1.6"/>'),
  x: svg('<path d="M18 6L6 18M6 6l12 12"/>'),
  left: svg('<path d="M4 6h16M4 12h10M4 18h13"/>'),
  center: svg('<path d="M4 6h16M7 12h10M6 18h12"/>'),
  right: svg('<path d="M4 6h16M10 12h10M7 18h13"/>'),
};
