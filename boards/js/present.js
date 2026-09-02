// Present mode. One projector for everything on a slide: transitions,
// object builds, scrubbable video and live drill animations.
//
// - The VIDEO SCRUB imports the Clips curve (scrubDeltaSeconds /
//   scrubMotionStep, themselves ported from CTH Film Room) rather than
//   reimplementing it - that feel is tuned and must not drift. One seek in
//   flight, released by the video's own 'seeked' event; small steps seek
//   precisely, fastSeek only for jumps over 1.5s.
// - DRILL ANIMATIONS play through diagrams/js/anim.js (buildTimeline +
//   makePainter), so the moving drill is pixel-identical to the PNG.

import { presentable, normalizeBoard, boardDecks } from './model.js';
import { slideHtml, hydrate } from './render.js';
import { getDeck, getDrill } from './store.js';
import { scrubDeltaSeconds, scrubMotionStep } from '/clips/js/player.js';
import { buildTimeline, makePainter } from '/diagrams/js/anim.js';
import { loadAssets } from '/diagrams/js/rink.js';

let pr = null;
const $ = (sel, root) => (root || document).querySelector(sel);
const $$ = (sel, root) => [...(root || document).querySelectorAll(sel)];

export const presenting = () => !!pr;

// Presents one deck ON a board: #/present/<boardId>/<deckItemId>. The
// old #/present/<id> form still works and presents the board's first deck.
export async function openPresent(boardId, deckId) {
  const board = normalizeBoard(await getDeck(boardId));
  if (!board) { location.hash = '#/'; return; }
  const decks = boardDecks(board);
  const deck = decks.find((d) => d.id === deckId) || decks[0];
  if (!deck) { location.hash = `#/d/${boardId}`; return; }
  const slides = presentable(deck);
  if (!slides.length) { location.hash = `#/d/${boardId}`; return; }
  pr = { board, deck, slides, i: 0, step: 0, un: [], anims: new Map(), notes: false };
  // The rink art is served from the Diagrams app; load it once so a drill
  // animation never paints on a blank rink.
  loadAssets('/diagrams/assets').catch(() => {});
  const app = $('#app');
  app.innerHTML = `
    <div class="dk-present" id="dkPresent">
      <div class="dk-proj" id="dkProj"></div>
      <div class="dk-pnotes" id="dkPNotes" hidden></div>
      <div class="dk-pbar">
        <button class="dk-pbtn" id="dkPExit" data-tip="Exit (Esc)">Esc</button>
        <span class="dk-pcount" id="dkPCount"></span>
        <button class="dk-pbtn" id="dkPNotesBtn" data-tip="Notes (N)">Notes</button>
      </div>
    </div>`;
  $('#dkPExit').onclick = exit;
  $('#dkPNotesBtn').onclick = toggleNotes;
  const onKey = (e) => {
    if (e.key === 'Escape') { exit(); return; }
    if (e.key === 'ArrowRight' || e.key === ' ' || e.key === 'Enter') { e.preventDefault(); next(); }
    if (e.key === 'ArrowLeft') { e.preventDefault(); prev(); }
    if (e.key === 'n' || e.key === 'N') toggleNotes();
  };
  window.addEventListener('keydown', onKey);
  pr.un.push(() => window.removeEventListener('keydown', onKey));
  await showSlide(0, null);
}

export function closePresent() {
  if (!pr) return;
  for (const stop of pr.anims.values()) stop();
  for (const fn of pr.un) { try { fn(); } catch (_) {} }
  pr = null;
}

function exit() { const id = pr.board.id; closePresent(); location.hash = `#/d/${id}`; }

function toggleNotes() {
  pr.notes = !pr.notes;
  const n = $('#dkPNotes');
  n.hidden = !pr.notes;
  paintNotes();
}

function paintNotes() {
  if (!pr.notes) return;
  $('#dkPNotes').textContent = pr.slides[pr.i].notes || 'No notes for this slide.';
}

// ------------------------------------------------------------- steps

// Build steps are the distinct animation orders on the slide, ascending.
const orders = (s) => [...new Set(s.els.filter((e) => e.anim).map((e) => e.anim.order || 1))].sort((a, b) => a - b);

function next() {
  const s = pr.slides[pr.i];
  const os = orders(s);
  if (pr.step < os.length) { runStep(os[pr.step]); pr.step += 1; return; }
  if (pr.i < pr.slides.length - 1) showSlide(pr.i + 1, s.transition || pr.slides[pr.i + 1].transition);
}

function prev() {
  if (pr.i > 0) showSlide(pr.i - 1, null, true);
}

function runStep(order) {
  const stage = $('.dk-stage', $('#dkProj'));
  for (const e of pr.slides[pr.i].els) {
    if (!e.anim || (e.anim.order || 1) !== order) continue;
    const node = $(`.dk-el[data-el="${e.id}"]`, stage);
    if (!node) continue;
    node.style.setProperty('--adur', `${e.anim.durMs || 600}ms`);
    if (e.anim.io === 'out') {
      node.classList.add(`dk-out-${e.anim.style}`);
    } else {
      node.classList.remove('dk-hidden');
      node.classList.add(`dk-in-${e.anim.style}`);
      const anim = pr.anims.get(e.id);
      if (anim) anim.onReveal?.();
    }
  }
}

// ------------------------------------------------------------- slides

async function showSlide(i, transition, backward = false) {
  for (const stop of pr.anims.values()) stop();
  pr.anims.clear();
  pr.i = i; pr.step = 0;
  const proj = $('#dkProj');
  const s = pr.slides[i];
  const wrap = document.createElement('div');
  wrap.className = 'dk-projslide';
  wrap.innerHTML = slideHtml(s, pr.deck.theme);
  const old = $('.dk-projslide', proj);
  proj.appendChild(wrap);
  await hydrate(wrap);
  // Elements that build IN start hidden; going backward shows everything.
  if (!backward) {
    for (const e of s.els) {
      if (e.anim && e.anim.io !== 'out') $(`.dk-el[data-el="${e.id}"]`, wrap)?.classList.add('dk-hidden');
    }
  } else {
    pr.step = orders(s).length;
  }
  wireMedia(wrap, s);
  const style = transition?.style || 'none';
  const dur = transition?.durMs || 300;
  if (old && style !== 'none') {
    wrap.style.setProperty('--tdur', `${dur}ms`);
    old.style.setProperty('--tdur', `${dur}ms`);
    wrap.classList.add(`dk-tr-${style}-in`);
    old.classList.add(`dk-tr-${style}-out`);
    setTimeout(() => { old.remove(); wrap.classList.remove(`dk-tr-${style}-in`); }, dur + 60);
  } else if (old) {
    old.remove();
  }
  $('#dkPCount').textContent = `${i + 1} / ${pr.slides.length}`;
  paintNotes();
}

// ------------------------------------------------------------- media

function wireMedia(root, s) {
  for (const e of s.els) {
    const node = $(`.dk-el[data-el="${e.id}"]`, root);
    if (!node) continue;
    if (e.type === 'video') wireVideo(node);
    if (e.type === 'diagram' && e.animate) wireDrill(node, e);
  }
}

// -- video: click to play, two-finger swipe to scrub (the Clips engine) --

function wireVideo(node) {
  const v = $('video', node);
  if (!v) return;
  v.controls = false;
  node.addEventListener('click', (e) => {
    e.stopPropagation();
    if (v.paused) v.play(); else v.pause();
  });
  const st = { aim: null, pos: null, raf: 0, settle: 0, busy: false, unlock: 0 };
  const seekTo = (t) => {
    if (st.busy) return;
    st.busy = true;
    // The 'seeked' release is load-bearing, and the 250ms timeout is the
    // Clips safety net for a seek the browser never answers.
    clearTimeout(st.unlock);
    st.unlock = setTimeout(() => { st.busy = false; }, 250);
    const big = Math.abs(t - v.currentTime) > 1.5;
    // Precise seeks for small steps; fastSeek snaps to keyframes and reads
    // as stick-then-teleport on a slow scrub.
    if (big && v.fastSeek) v.fastSeek(t); else v.currentTime = t;
  };
  v.addEventListener('seeked', () => { st.busy = false; clearTimeout(st.unlock); });
  // rAF drives the spring; the timer is the backstop for a window the
  // compositor is not painting (the suite's hidden-pane lesson).
  let pumpT = 0;
  const pump = () => {
    clearTimeout(pumpT);
    if (st.aim == null) return;
    st.pos = scrubMotionStep(st.pos, st.aim, 16);
    seekTo(st.pos);
    if (Math.abs(st.aim - st.pos) > 0.02) schedulePump();
  };
  const schedulePump = () => {
    cancelAnimationFrame(st.raf);
    clearTimeout(pumpT);
    st.raf = requestAnimationFrame(pump);
    pumpT = setTimeout(pump, 40);
  };
  node.addEventListener('wheel', (e) => {
    if (!isFinite(v.duration)) return;
    if (Math.abs(e.deltaX) <= Math.abs(e.deltaY) * 1.4) return;
    e.preventDefault();
    e.stopPropagation();
    if (!v.paused) v.pause();
    if (st.aim == null) { st.aim = v.currentTime; st.pos = v.currentTime; }
    // macOS natural scrolling reports a rightward swipe as negative deltaX;
    // forward-on-right means negating it (the Clips rule).
    st.aim = Math.max(0, Math.min(v.duration, st.aim + scrubDeltaSeconds(-e.deltaX, 16, 1, e.altKey)));
    schedulePump();
    clearTimeout(st.settle);
    st.settle = setTimeout(() => { st.aim = null; st.pos = null; }, 400);
  }, { passive: false });
}

// -- diagram: play the drill through the Diagrams animator --

async function wireDrill(node, e) {
  const canvas = $('canvas', node);
  const rec = await getDrill(e.drill);
  if (!rec || !rec.state || !canvas) return;
  let raf = 0; let timer = 0; let playing = false;
  const stop = () => { playing = false; cancelAnimationFrame(raf); clearTimeout(timer); };
  pr.anims.set(e.id, Object.assign(stop, { onReveal: () => play() }));
  let painter = null; let tl = null; let scale = 1;
  async function ready() {
    if (painter) return;
    tl = buildTimeline(rec.state);
    painter = makePainter(tl, { bgUrl: rec.state.bg || undefined, rinkNames: rec.state.rinkNames });
    await painter.ready;
    scale = Math.min(1280 / tl.bandW, 1);
    canvas.width = Math.round(tl.bandW * scale);
    canvas.height = Math.round(tl.bandH * scale);
  }
  const total = () => tl.total || 0.5;
  async function play() {
    await ready();
    stop();
    playing = true;
    const t0 = performance.now();
    const ctx = canvas.getContext('2d');
    const tick = () => {
      if (!playing) return;
      clearTimeout(timer);
      const t = Math.min((performance.now() - t0) / 1000, total());
      painter.paint(ctx, t, scale);
      if (t < total()) {
        raf = requestAnimationFrame(tick);
        // Timer backstop: keep painting when rAF is starved.
        timer = setTimeout(tick, 66);
      } else playing = false;
    };
    tick();
  }
  node.addEventListener('click', (ev) => { ev.stopPropagation(); play(); });
  // A diagram that never builds in plays as soon as the slide shows.
  if (!e.anim || e.anim.io === 'out') play();
}
