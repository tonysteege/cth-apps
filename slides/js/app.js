// CTH Slides - turn any Notion page into a film-session slideshow.
//   Home (#/)          - paste a Notion link, recent decks, setup help.
//   Deck (#p=<id>&s=n) - the presentation: dark title slide, light content
//                        slides cut at every h2 and divider, scrubbable
//                        video, telestration on every slide, built-in
//                        screen recording.
// Content comes LIVE from the cth-present-api Worker (Notion has no
// browser CORS), so a deck is always as current as the page - no publish
// step, no webhook, no update button.

import { buildSlides, renderBlocks, richHtml, isMediaBlock } from './slides.js';
import { mountVideo, pauseAllVideos, disposeVideos, slidePlayer } from './media.js';
import {
  initTelestrate, disposeTelestrate, telestrateSetSlide, telestrateUndo,
  telestrateClear, telestrateArmed,
} from './telestrate.js';
import { toast, esc, fmtClock } from './ui.js';
import { listDecks, getDeck, putDeck, deleteDeck, newDeck, normalizeDeck } from './decks.js';
import { openEditor, closeEditor, editing, flush, slideHtml, mountSlideVideos, rehydrate } from './editor.js';

const API = 'https://apps-api.coachtonyhockey.com';
const $ = (s) => document.querySelector(s);
const BACK_ICON = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.8" stroke-linecap="round" stroke-linejoin="round"><path d="M20 12H4"/><path d="m10 18-6-6 6-6"/></svg>';
const FORMULA = '"https://apps.coachtonyhockey.com/slides/#p=" + id()';

const RECENT_KEY = 'cthp.recent.v1';
const recents = () => { try { return JSON.parse(localStorage.getItem(RECENT_KEY)) || []; } catch (_) { return []; } };
function remember(id, title) {
  const list = [{ id, title, when: Date.now() }, ...recents().filter((r) => r.id !== id)].slice(0, 12);
  localStorage.setItem(RECENT_KEY, JSON.stringify(list));
}

const pageIdFrom = (s) => (s || '').replace(/-/g, '').match(/[0-9a-f]{32}/i)?.[0]?.toLowerCase() || null;

function route() {
  const h = location.hash.slice(1);
  // Authored decks came later than the Notion route and must not disturb
  // it: `#p=<32hex>` is a public URL format and stays exactly as it was.
  const edit = h.match(/^\/d\/([a-z0-9]+)$/i);
  if (edit) return { view: 'edit', id: edit[1] };
  const present = h.match(/^\/present\/([a-z0-9]+)$/i);
  if (present) return { view: 'present', id: present[1] };
  const q = new URLSearchParams(h);
  const id = pageIdFrom(q.get('p') || '');
  return id ? { view: 'deck', id, s: Math.max(0, parseInt(q.get('s') || '0', 10) || 0) } : { view: 'home' };
}

let deck = null; // { id, page, slides, i, chromeTimer, tele, rec }

async function go() {
  const r = route();
  if (deck && r.view === 'deck' && r.id === deck.id) { show(r.s); return; }
  teardownDeck();
  if (editing()) closeEditor();
  if (r.view === 'deck') await openDeck(r.id, r.s);
  else if (r.view === 'edit') await openEditor(r.id);
  else if (r.view === 'present') await presentDeck(r.id);
  else await showHome();
}

// ------------------------------------------------------------- home

async function showHome() {
  const decks = await listDecks();
  document.title = 'CTH Slides';
  document.body.classList.remove('dark');
  $('#app').innerHTML = `
    <header class="lib-head">
      <div class="brand">
        <button class="btn btn-back" id="prHome" title="Back To CTH Apps">${BACK_ICON}</button>
        <img src="../diagrams/assets/cth-icon-black.svg" alt="CTH" class="brand-logo">
        <div class="brand-word">
          <h1>CTH Slides</h1>
        </div>
      </div>
    </header>
    <main class="ph">
      <div class="ph-open">
        <input id="phUrl" placeholder="Paste A Notion Page Link (Or Its Slides URL)…" autocomplete="off">
        <button class="btn btn-ink" id="phGo">Open Slides</button>
      </div>
      <div class="ph-title">Your Decks</div>
      <div class="ph-decks">
        <button class="deck-new" id="phNewDeck">+ New Deck</button>
        ${decks.map((d) => `
          <button class="deck-card" data-deck="${esc(d.id)}">
            <span class="deck-thumb">${slideHtml(normalizeDeck(d).slides[0] || { els: [] })}</span>
            <span class="deck-name">${esc(d.name)}</span>
            <span class="deck-meta">${d.slides.length} Slide${d.slides.length === 1 ? '' : 's'} &middot; ${new Date(d.updated || d.created).toLocaleDateString([], { month: 'short', day: 'numeric' })}</span>
          </button>`).join('')}
      </div>
      ${recents().length ? `
        <div class="ph-title">Recent</div>
        <div class="ph-recents">
          ${recents().map((r) => `<button class="recent-card" data-open="${r.id}"><span class="recent-name">${esc(r.title || 'Untitled')}</span><span class="recent-meta">${new Date(r.when).toLocaleDateString([], { month: 'short', day: 'numeric' })}</span></button>`).join('')}
        </div>` : ''}
      <div class="ph-title">Give A Database Slide Links</div>
      <div class="ph-card">
        <p>Add one formula property (name it <strong>Slides</strong>) to any database, and every row gets its own always-current slide link - new rows included, nothing to sync or update:</p>
        <div class="ph-formula"><code>${esc(FORMULA)}</code><button class="mini" id="phCopy">Copy</button></div>
        <p>Slides come straight from the page: the title makes the dark cover slide, every <strong>H2 heading</strong> starts a slide, and every <strong>divider</strong> cuts a new one. Videos on the page (Clips embeds, uploaded files, or any video link) become scrubbable players, and you can draw on any slide while presenting.</p>
        <p class="ph-note">If a page will not open, share its database with the CTH Notion integration (page menu &rarr; Connections).</p>
      </div>
    </main>`;
  $('#prHome').onclick = () => { location.href = '../'; };
  const open = () => {
    const id = pageIdFrom($('#phUrl').value);
    if (!id) { toast('That Does Not Look Like A Notion Page Link', true); return; }
    location.hash = `p=${id}`;
  };
  $('#phGo').onclick = open;
  $('#phUrl').addEventListener('keydown', (e) => { e.stopPropagation(); if (e.key === 'Enter' || e.keyCode === 13) open(); });
  $('#phCopy').onclick = async () => { await navigator.clipboard.writeText(FORMULA); toast('Formula Copied - Paste It Into A New Formula Property'); };
  document.querySelectorAll('[data-open]').forEach((b) => { b.onclick = () => { location.hash = `p=${b.dataset.open}`; }; });
  $('#phNewDeck').onclick = async () => {
    const d = newDeck();
    await putDeck(d);
    location.hash = `/d/${d.id}`;
  };
  document.querySelectorAll('[data-deck]').forEach((b) => {
    b.onclick = () => { location.hash = `/d/${b.dataset.deck}`; };
    b.oncontextmenu = async (e) => {
      e.preventDefault();
      const d = await getDeck(b.dataset.deck);
      if (!d) return;
      if (!window.confirm(`Delete "${d.name}"? This cannot be undone.`)) return;
      await deleteDeck(d.id);
      void showHome();
    };
  });
}

// ------------------------------------------------------------- deck

async function fetchPage(id, fresh = false) {
  const r = await fetch(`${API}/notion/page/${id}${fresh ? '?fresh=1' : ''}`);
  const j = await r.json().catch(() => ({}));
  if (!r.ok) {
    const msg = j.error === 'no_access'
      ? 'The CTH Notion Integration Cannot See This Page - Share It Via The Page Menu &rarr; Connections'
      : j.error === 'setup' ? 'The Slides API Is Not Set Up Yet' : `Could Not Load The Page (${esc(j.error || r.status)})`;
    throw new Error(msg);
  }
  return j;
}

async function openDeck(id, startAt = 0) {
  document.title = 'Loading… - CTH Slides';
  $('#app').innerHTML = '<div class="boot">Opening Slides…</div>';
  let page;
  try {
    page = await fetchPage(id);
  } catch (e) {
    $('#app').innerHTML = `
      <div class="reopen">
        <h2>Cannot Open These Slides</h2>
        <p>${e.message}</p>
        <button class="btn btn-ink" id="prBackHome">Back To Slides</button>
      </div>`;
    $('#prBackHome').onclick = () => { location.hash = ''; };
    return;
  }
  buildDeck(page, startAt);
}

function buildDeck(page, startAt) {
  const slides = buildSlides(page);
  document.title = `${page.title} - CTH Slides`;
  remember(page.id, page.title);
  document.body.classList.add('dark');
  $('#app').innerHTML = `
    <div class="pr" id="pr">
      <div class="pr-chrome" id="prChrome">
        <button class="btn btn-back" id="prBack" title="Leave Slides">${BACK_ICON}</button>
        <span class="pr-title">${esc(page.title)}</span>
        <span class="pr-flex"></span>
        <button class="btn" id="prRefresh" title="Pull The Latest Content From Notion">Refresh</button>
        <button class="btn" id="prRec" title="Record The Screen (R)">Record</button>
        <button class="btn" id="prGridBtn" title="All Slides (G)">Grid</button>
        <button class="btn" id="prFull" title="Fullscreen (F)">Fullscreen</button>
      </div>
      <div class="pr-stagebox" id="prStageBox">
        <div class="pr-stage" id="prStage"></div>
      </div>
      <div class="pr-rail" id="prRail"></div>
      <div class="pr-progress"><div id="prProgressFill"></div></div>
      <div class="pr-counter" id="prCounter"></div>
      <div class="pr-black" id="prBlack" hidden></div>
      <div class="pr-grid" id="prGrid" hidden></div>
    </div>`;

  const stage = $('#prStage');
  // Every content slide wears the name of the section it sits under; with no
  // heading_1 above it, the deck's own title does that job.
  const deckTitle = slides[0]?.title || '';
  const slideEls = slides.map((s, i) => {
    const el = document.createElement('div');
    el.className = `pr-slide ${s.kind === 'content' ? 'light' : 'darkslide'}`;
    el.dataset.i = i;
    const mediaSlots = [];
    if (s.kind === 'title') {
      el.innerHTML = `
        <div class="sl-cover"${s.cover ? ` style="background-image:linear-gradient(rgba(10,10,10,.80),rgba(10,10,10,.88)),url('${esc(s.cover)}')"` : ''}>
          <img class="sl-cover-logo" src="cth-horizontal-white.svg" alt="Coach Tony Hockey">
          <div class="sl-cover-body">
            ${s.icon ? `<div class="sl-icon">${esc(s.icon)}</div>` : ''}
            <h1 class="sl-cover-title">${esc(s.title)}</h1>
            ${s.subtitle ? `<p class="sl-cover-sub">${esc(s.subtitle)}</p>` : ''}
          </div>
          <span class="sl-copy">&copy; Coach Tony Hockey</span>
        </div>`;
    } else if (s.kind === 'section') {
      el.innerHTML = `
        <div class="sl-cover sl-cover--section">
          <img class="sl-cover-logo" src="cth-horizontal-white.svg" alt="">
          <div class="sl-cover-body">
            <h1 class="sl-cover-title">${richHtml(s.header.rich)}</h1>
          </div>
          <span class="sl-copy">&copy; Coach Tony Hockey</span>
        </div>`;
    } else {
      const media = s.blocks.filter(isMediaBlock);
      const rest = s.blocks.filter((b) => !isMediaBlock(b));
      // Split layout: one media block beside the text; otherwise flow.
      const eyebrow = s.section || deckTitle;
      const head = `
          <header class="sl-head">
            ${eyebrow ? `<span class="sl-eyebrow">${esc(eyebrow)}</span>` : ''}
            ${s.header ? `<h2 class="sl-h">${richHtml(s.header.rich)}</h2>` : ''}
          </header>`;
      const foot = `
          <span class="sl-num">${i + 1}</span>
          <img class="sl-mark" src="cth-logo-black.svg" alt="">`;
      if (media.length === 1 && rest.length) {
        const slots2 = [];
        el.innerHTML = `${head}
          <div class="sl-split">
            <div class="sl-text">${renderBlocks(rest, slots2)}</div>
            <div class="sl-media">${renderBlocks(media, slots2)}</div>
          </div>${foot}`;
        el._slots = slots2;
      } else {
        el.innerHTML = `${head}
          <div class="sl-flow${media.length && !rest.length ? ' sl-onlymedia' : ''}">${renderBlocks(s.blocks, mediaSlots)}</div>${foot}`;
        el._slots = mediaSlots;
      }
    }
    stage.appendChild(el);
    return el;
  });

  // RINK DIAGRAMS READ HORIZONTALLY (2026-08-26, Tony's call). A rink drawn
  // portrait wastes a 16:9 slide: it lands as a narrow strip with the ice
  // tiny in the middle. A rink is 2:1, so a portrait one is ~0.5 wide-to-
  // tall; anything in that band is turned a quarter turn and its box is
  // swapped, which fills the media column properly. The window is
  // deliberately narrow so an ordinary portrait photo (0.66 upward) is left
  // exactly as it was shot.
  stage.querySelectorAll('.sl-img img').forEach((img) => {
    const orient = () => {
      const w = img.naturalWidth;
      const h = img.naturalHeight;
      if (!w || !h) return;
      const ratio = w / h;
      img.closest('.sl-img')?.classList.toggle('sl-img--turned', ratio > 0.38 && ratio < 0.62);
    };
    if (img.complete) orient(); else img.addEventListener('load', orient, { once: true });
  });

  // Mount the scrubbable players into their slots.
  for (const el of slideEls) {
    (el._slots || []).forEach((spec, k) => {
      const slot = el.querySelector(`[data-video-slot="${k}"]`);
      if (slot) mountVideo(slot, spec);
    });
  }

  deck = { id: page.id, page, slides, els: slideEls, i: -1, tele: null, rec: null };
  deck.tele = initTelestrate(stage, $('#prRail'));
  wireDeck();
  show(Math.min(startAt, slides.length - 1));
}

// PRESENTING AN AUTHORED DECK REUSES EVERYTHING (2026-08-27). The chrome,
// the rail, the counter, the keyboard, the telestration, the screen
// recording and the video player are all already here and already tuned;
// only the slide elements come from a different place. Building a second
// presenter would have been two things to keep in step forever.
async function presentDeck(id) {
  const raw = await getDeck(id);
  if (!raw) { toast('That Deck Is Gone', true); location.hash = ''; return; }
  const d = await rehydrate(normalizeDeck(raw));
  document.title = `${d.name} - CTH Slides`;
  document.body.classList.add('dark');
  $('#app').innerHTML = `
    <div class="pr" id="pr">
      <div class="pr-chrome" id="prChrome">
        <button class="btn btn-back" id="prBack" title="Back To The Editor">${BACK_ICON}</button>
        <span class="pr-title">${esc(d.name)}</span>
        <span class="pr-flex"></span>
        <button class="btn" id="prEdit" title="Edit This Deck">Edit</button>
        <button class="btn" id="prRec" title="Record The Screen (R)">Record</button>
        <button class="btn" id="prGridBtn" title="All Slides (G)">Grid</button>
        <button class="btn" id="prFull" title="Fullscreen (F)">Fullscreen</button>
      </div>
      <div class="pr-stagebox" id="prStageBox">
        <div class="pr-stage" id="prStage"></div>
      </div>
      <div class="pr-rail" id="prRail"></div>
      <div class="pr-progress"><div id="prProgressFill"></div></div>
      <div class="pr-counter" id="prCounter"></div>
      <div class="pr-black" id="prBlack" hidden></div>
      <div class="pr-grid" id="prGrid" hidden></div>
    </div>`;
  const stage = $('#prStage');
  const slideEls = d.slides.map((sl, i) => {
    const el = document.createElement('div');
    el.className = 'pr-slide de-pres';
    el.dataset.i = i;
    el.innerHTML = slideHtml(sl);
    stage.appendChild(el);
    return el;
  });
  mountSlideVideos(stage);
  deck = { kind: 'authored', id: d.id, page: { title: d.name }, slides: d.slides, els: slideEls, i: -1, tele: null, rec: null };
  deck.tele = initTelestrate(stage, $('#prRail'));
  wireDeck();
  $('#prEdit').onclick = () => { location.hash = `/d/${d.id}`; };
  show(0);
}

function show(i) {
  if (!deck) return;
  i = Math.max(0, Math.min(deck.slides.length - 1, i));
  if (i === deck.i) return;
  deck.i = i;
  pauseAllVideos();
  deck.els.forEach((el, k) => el.classList.toggle('on', k === i));
  telestrateSetSlide(i);
  $('#prCounter').textContent = `${i + 1} / ${deck.slides.length}`;
  $('#prProgressFill').style.width = `${((i + 1) / deck.slides.length) * 100}%`;
  if (deck.kind === 'authored') {
    // An authored deck's URL is its own; it has no Notion page id to carry.
    history.replaceState(null, '', `#/present/${deck.id}`);
  } else {
    const q = new URLSearchParams(location.hash.slice(1));
    q.set('p', deck.id);
    q.set('s', String(i));
    history.replaceState(null, '', `#${q.toString()}`);
  }
}

const next = () => show(deck.i + 1);
const prev = () => show(deck.i - 1);

function toggleGrid(force) {
  const g = $('#prGrid');
  const on = force != null ? force : g.hidden;
  if (on) {
    g.innerHTML = deck.slides.map((s, i) => `
      <button class="prg-card${i === deck.i ? ' on' : ''}" data-g="${i}">
        <span class="prg-n">${i + 1}</span>
        <span class="prg-t">${s.kind === 'title' ? esc(deck.page.title) : s.kind === 'section' ? richHtml(s.header.rich) : (s.header ? richHtml(s.header.rich) : 'Slide')}</span>
      </button>`).join('');
    g.querySelectorAll('[data-g]').forEach((b) => { b.onclick = () => { toggleGrid(false); show(Number(b.dataset.g)); }; });
  }
  g.hidden = !on;
}

function wireDeck() {
  $('#prBack').onclick = () => { location.hash = deck?.kind === 'authored' ? `/d/${deck.id}` : ''; };
  // Refresh only exists on a Notion deck - an authored one has no page to
  // pull from, so the button is not rendered and must not be wired.
  if ($('#prRefresh')) $('#prRefresh').onclick = async () => {
    try {
      const at = deck.i;
      const page = await fetchPage(deck.id, true);
      teardownDeck(true);
      buildDeck(page, at);
      toast('Refreshed From Notion');
    } catch (e) { toast(e.message, true); }
  };
  $('#prGridBtn').onclick = () => toggleGrid();
  $('#prFull').onclick = () => {
    if (document.fullscreenElement) void document.exitFullscreen();
    else void document.documentElement.requestFullscreen?.();
  };
  $('#prRec').onclick = () => void toggleRecord();
  $('#prBlack').addEventListener('click', () => { $('#prBlack').hidden = true; });

  const stage = $('#prStageBox');
  stage.addEventListener('click', (e) => {
    if (telestrateArmed()) return;
    if (e.target.closest('.pv, a, button, audio, iframe, .sl-embed')) return;
    const r = stage.getBoundingClientRect();
    if ((e.clientX - r.left) / r.width < 0.25) prev(); else next();
  });
  // Touch swipe.
  let swipe = null;
  stage.addEventListener('pointerdown', (e) => {
    if (e.pointerType !== 'touch' || telestrateArmed() || e.target.closest('.pv')) return;
    swipe = { x: e.clientX, y: e.clientY };
  });
  stage.addEventListener('pointerup', (e) => {
    if (!swipe) return;
    const dx = e.clientX - swipe.x;
    const dy = e.clientY - swipe.y;
    swipe = null;
    if (Math.abs(dx) > 60 && Math.abs(dx) > Math.abs(dy) * 1.5) { if (dx < 0) next(); else prev(); }
  });

  // The chrome hides itself while presenting; a nudge brings it back.
  let chromeTimer = null;
  const wake = () => {
    $('#prChrome').classList.remove('hidden');
    $('#prRail').classList.remove('hidden');
    clearTimeout(chromeTimer);
    chromeTimer = setTimeout(() => {
      if (deck?.rec?.recording) return; // keep controls up while recording is being set up
      $('#prChrome').classList.add('hidden');
    }, 2600);
  };
  window.addEventListener('pointermove', wake);
  wake();
}

function onKey(e) {
  if (!deck) return;
  const t = e.target;
  if (t && (t.tagName === 'INPUT' || t.tagName === 'TEXTAREA')) return;
  const k = e.key;
  if ((e.metaKey || e.ctrlKey) && k.toLowerCase() === 'z') { e.preventDefault(); telestrateUndo(); return; }
  if (e.metaKey || e.ctrlKey) return;
  if (k === 'ArrowRight' || k === 'PageDown' || (k === ' ' && !e.shiftKey)) { e.preventDefault(); next(); return; }
  if (k === 'ArrowLeft' || k === 'PageUp' || (k === ' ' && e.shiftKey)) { e.preventDefault(); prev(); return; }
  if (k === 'Home') { e.preventDefault(); show(0); return; }
  if (k === 'End') { e.preventDefault(); show(deck.slides.length - 1); return; }
  const lower = k.toLowerCase();
  if (lower === 'g') { e.preventDefault(); toggleGrid(); return; }
  if (lower === 'b') { e.preventDefault(); $('#prBlack').hidden = !$('#prBlack').hidden; return; }
  if (lower === 'f') { e.preventDefault(); $('#prFull').click(); return; }
  if (lower === 'd') { e.preventDefault(); deck.tele.toggle(); return; }
  if (lower === 'x') { e.preventDefault(); telestrateClear(); return; }
  if (lower === 'r') { e.preventDefault(); void toggleRecord(); return; }
  if (k === ',' || k === '.') {
    const p = slidePlayer(deck.els[deck.i]);
    if (p) { e.preventDefault(); p.frameStep(k === ',' ? -1 : 1); }
    return;
  }
  if (k === 'Escape') {
    if (!$('#prGrid').hidden) { toggleGrid(false); return; }
    if (!$('#prBlack').hidden) { $('#prBlack').hidden = true; return; }
    if (telestrateArmed()) deck.tele.disarm();
  }
}

// ------------------------------------------------------------- recording

async function toggleRecord() {
  if (deck.rec?.recording) { stopRecord(); return; }
  try {
    const display = await navigator.mediaDevices.getDisplayMedia({ video: { frameRate: 30 }, audio: true });
    let mic = null;
    try { mic = await navigator.mediaDevices.getUserMedia({ audio: true }); } catch (_) { /* no mic is fine */ }
    let stream = display;
    let ac = null;
    if (mic) {
      ac = new AudioContext();
      const dest = ac.createMediaStreamDestination();
      if (display.getAudioTracks().length) ac.createMediaStreamSource(new MediaStream(display.getAudioTracks())).connect(dest);
      ac.createMediaStreamSource(mic).connect(dest);
      stream = new MediaStream([...display.getVideoTracks(), ...dest.stream.getAudioTracks()]);
    }
    const mime = ['video/mp4', 'video/webm;codecs=vp9', 'video/webm'].find((m) => MediaRecorder.isTypeSupported(m));
    const rec = new MediaRecorder(stream, { mimeType: mime, videoBitsPerSecond: 8_000_000 });
    const parts = [];
    rec.ondataavailable = (ev) => { if (ev.data.size) parts.push(ev.data); };
    display.getVideoTracks()[0].addEventListener('ended', () => { if (deck.rec?.recording) stopRecord(); });
    rec.start(1000);
    deck.rec = { rec, parts, display, mic, ac, mime, recording: true };
    $('#prRec').textContent = 'Stop';
    $('#prRec').classList.add('btn-rec');
    toast('Recording Slides. R Or Stop Ends It');
  } catch (e) {
    console.error(e);
    toast('Recording Did Not Start - Allow Screen Sharing And Try Again', true);
  }
}

function stopRecord() {
  const r = deck.rec;
  if (!r) return;
  r.recording = false;
  r.rec.onstop = async () => {
    r.display.getTracks().forEach((t) => t.stop());
    r.mic?.getTracks().forEach((t) => t.stop());
    r.ac?.close();
    const blob = new Blob(r.parts, { type: r.mime });
    const ext = r.mime.includes('mp4') ? 'mp4' : 'webm';
    const name = `${(deck.page.title || 'slides').replace(/[^\w\- ]+/g, '').trim().replace(/\s+/g, '-').toLowerCase()}-${new Date().toISOString().slice(0, 10)}.${ext}`;
    await offerRecording(blob, name);
    deck.rec = null;
  };
  r.rec.stop();
  $('#prRec').textContent = 'Record';
  $('#prRec').classList.remove('btn-rec');
}

async function offerRecording(blob, name) {
  const mins = Math.round(blob.size / 1e6);
  let fs = null;
  try {
    fs = await import('../../clips/js/localfs.js');
    if (!fs.fsSupported()) fs = null;
  } catch (_) { fs = null; }
  const wrap = document.createElement('div');
  wrap.className = 'sheet-veil';
  wrap.innerHTML = `
    <div class="sheet" role="dialog" aria-modal="true">
      <h3>Recording Ready</h3>
      <p>${esc(name)} (about ${mins} MB). ${fs ? 'Save it into your cth folder under videos/recordings, or download it.' : 'Download it below.'}</p>
      <div class="sheet-row">
        <button class="btn" data-x="dl">Download</button>
        ${fs ? '<button class="btn btn-ink" data-x="dbx">Save To Folder</button>' : ''}
      </div>
    </div>`;
  document.body.appendChild(wrap);
  const done = () => wrap.remove();
  wrap.addEventListener('mousedown', (e) => { if (e.target === wrap) done(); });
  wrap.querySelector('[data-x="dl"]').onclick = () => {
    const a = document.createElement('a');
    a.href = URL.createObjectURL(blob);
    a.download = name;
    a.click();
    done();
  };
  const up = wrap.querySelector('[data-x="dbx"]');
  if (up) {
    up.onclick = async () => {
      up.textContent = 'Saving…';
      try {
        if (!fs.fsConnected()) await (fs.fsRemembered() ? fs.fsReconnect() : fs.fsConnect());
        await fs.fsWrite(`${fs.RECORDING_ROOT}/${name}`, blob);
        toast(`Saved To ${fs.fsLabel(fs.RECORDING_ROOT)}`);
        done();
      } catch (e) {
        if (e && e.name === 'AbortError') { up.textContent = 'Save To Folder'; return; }
        console.error(e);
        toast('Could Not Save - Downloading Instead', true);
        wrap.querySelector('[data-x="dl"]').click();
      }
    };
  }
}

function teardownDeck(keepClass = false) {
  if (!deck) return;
  if (deck.rec?.recording) stopRecord();
  disposeVideos();
  disposeTelestrate();
  deck = null;
  if (!keepClass) document.body.classList.remove('dark');
}

// ------------------------------------------------------------- boot

window.addEventListener('hashchange', () => void go());
window.addEventListener('keydown', onKey);
void fmtClock;
void go();
