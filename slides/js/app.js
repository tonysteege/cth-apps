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
  const q = new URLSearchParams(location.hash.slice(1));
  const id = pageIdFrom(q.get('p') || '');
  return id ? { view: 'deck', id, s: Math.max(0, parseInt(q.get('s') || '0', 10) || 0) } : { view: 'home' };
}

let deck = null; // { id, page, slides, i, chromeTimer, tele, rec }

async function go() {
  const r = route();
  if (deck && r.view === 'deck' && r.id === deck.id) { show(r.s); return; }
  teardownDeck();
  if (r.view === 'deck') await openDeck(r.id, r.s);
  else showHome();
}

// ------------------------------------------------------------- home

function showHome() {
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
      ${recents().length ? `
        <div class="ph-title">Recent</div>
        <div class="ph-recents">
          ${recents().map((r) => `<button class="recent-card" data-open="${r.id}"><span class="recent-name">${esc(r.title || 'Untitled')}</span><span class="recent-meta">${new Date(r.when).toLocaleDateString([], { month: 'short', day: 'numeric' })}</span></button>`).join('')}
        </div>` : ''}
      <div class="ph-title">Give A Database Slide Links</div>
      <div class="ph-card">
        <p>Add one formula property (name it <strong>Slides</strong>) to any database, and every row gets its own always-current slide link - new rows included, nothing to sync or update:</p>
        <div class="ph-formula"><code>${esc(FORMULA)}</code><button class="mini" id="phCopy">Copy</button></div>
        <p>Slides come straight from the page: the title makes the dark cover slide, every <strong>H2 heading</strong> starts a slide, and every <strong>divider</strong> cuts a new one. Videos on the page (Clips embeds, Dropbox links, or uploaded files) become scrubbable players, and you can draw on any slide while presenting.</p>
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
  const slideEls = slides.map((s, i) => {
    const el = document.createElement('div');
    el.className = `pr-slide ${s.kind === 'content' ? 'light' : 'darkslide'}`;
    el.dataset.i = i;
    const mediaSlots = [];
    if (s.kind === 'title') {
      el.innerHTML = `
        <div class="sl-titlewrap"${s.cover ? ` style="background-image:linear-gradient(rgba(10,10,10,.82),rgba(10,10,10,.86)),url('${esc(s.cover)}')"` : ''}>
          ${s.icon ? `<div class="sl-icon">${esc(s.icon)}</div>` : ''}
          <h1>${esc(s.title)}</h1>
          <img class="sl-logo" src="cth-horizontal-white.svg" alt="Coach Tony Hockey">
        </div>`;
    } else if (s.kind === 'section') {
      el.innerHTML = `<div class="sl-titlewrap"><h1>${richHtml(s.header.rich)}</h1><img class="sl-logo" src="cth-horizontal-white.svg" alt=""></div>`;
    } else {
      const media = s.blocks.filter(isMediaBlock);
      const rest = s.blocks.filter((b) => !isMediaBlock(b));
      // Split layout: one media block beside the text; otherwise flow.
      if (media.length === 1 && rest.length) {
        const slots2 = [];
        el.innerHTML = `
          ${s.header ? `<h2 class="sl-h">${richHtml(s.header.rich)}</h2>` : ''}
          <div class="sl-split">
            <div class="sl-text">${renderBlocks(rest, slots2)}</div>
            <div class="sl-media">${renderBlocks(media, slots2)}</div>
          </div>
          <span class="sl-num">${i + 1}</span>
          <img class="sl-mark" src="cth-logo-black.svg" alt="">`;
        el._slots = slots2;
      } else {
        el.innerHTML = `
          ${s.header ? `<h2 class="sl-h">${richHtml(s.header.rich)}</h2>` : ''}
          <div class="sl-flow${media.length && !rest.length ? ' sl-onlymedia' : ''}">${renderBlocks(s.blocks, mediaSlots)}</div>
          <span class="sl-num">${i + 1}</span>
          <img class="sl-mark" src="cth-logo-black.svg" alt="">`;
        el._slots = mediaSlots;
      }
    }
    stage.appendChild(el);
    return el;
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
  const q = new URLSearchParams(location.hash.slice(1));
  q.set('p', deck.id);
  q.set('s', String(i));
  history.replaceState(null, '', `#${q.toString()}`);
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
  $('#prBack').onclick = () => { location.hash = ''; };
  $('#prRefresh').onclick = async () => {
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
  let dbx = null;
  try {
    dbx = await import('../../clips/js/dropbox.js');
    if (!dbx.dbxConnected()) dbx = null;
  } catch (_) { dbx = null; }
  const wrap = document.createElement('div');
  wrap.className = 'sheet-veil';
  wrap.innerHTML = `
    <div class="sheet" role="dialog" aria-modal="true">
      <h3>Recording Ready</h3>
      <p>${esc(name)} (about ${mins} MB). ${dbx ? 'Save it to Dropbox for the team, or download it.' : 'Download it below.'}</p>
      <div class="sheet-row">
        <button class="btn" data-x="dl">Download</button>
        ${dbx ? '<button class="btn btn-ink" data-x="dbx">Save To Dropbox</button>' : ''}
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
      up.textContent = 'Uploading…';
      try {
        await dbx.dbxUpload(`/videos/recordings/${name}`, blob);
        toast('Saved To Dropbox: videos/recordings');
        done();
      } catch (e) {
        console.error(e);
        toast('Upload Failed - Downloading Instead', true);
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
