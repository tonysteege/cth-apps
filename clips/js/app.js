// CTH Clips - app shell. Two views:
//   Library (#/)        - videos from Dropbox /videos (folders + files),
//                         recent tagged games, local-file fallback.
//   Player  (#/v/<id>)  - the tagging workspace (player.js).
//
// Sharing is built around PERMANENT Dropbox links: every clip can become a
// Notion-embeddable player URL, an email, or a real exported video file
// landing back in Dropbox under /videos/exports.

import {
  dbxConnected, dbxAppKey, dbxBeginAuth, dbxFinishAuth, dbxDisconnect,
  dbxListFolder, dbxTempLink, dbxStreamLink, dbxUpload, dbxUploadProgress, dbxCreateFolder,
  VIDEO_ROOT, EXPORT_ROOT,
} from './dropbox.js';
import { listGames, getGame, putGame, deleteGame, getSettings, putSettings, uid } from './store.js';
import {
  openPlayer, closePlayer, playClip, recordClip, grabFrame, fmtTime, clipName,
  updateFreeze, playerGame, playerSettings, video, normTag,
} from './player.js';
import { openAnnotate } from './annotate.js';
import { toast, esc, confirmSheet, fmtDate } from './ui.js';
import { putDrill, uid as drillUid } from '/diagrams/js/store.js';

const $ = (sel) => document.querySelector(sel);
const BACK_ICON = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.8" stroke-linecap="round" stroke-linejoin="round"><path d="M20 12H4"/><path d="m10 18-6-6 6-6"/></svg>';
const stem = (s) => (s || 'clip').replace(/\.[^.]+$/, '').replace(/[^\w\- ]+/g, '').trim().replace(/\s+/g, '-').toLowerCase() || 'clip';

// Object URLs for locally opened files live only for this session.
const localUrls = new Map();

// ------------------------------------------------------------- routing

function route() {
  const m = (location.hash || '#/').match(/^#\/v\/(.+)$/);
  return m ? { view: 'player', id: decodeURIComponent(m[1]) } : { view: 'library' };
}

let leaving = false;
async function go() {
  if (leaving) return;
  leaving = true;
  await closePlayer();
  leaving = false;
  const r = route();
  if (r.view === 'player') await showPlayer(r.id);
  else await showLibrary();
}

// ------------------------------------------------------------- library

let browsePath = VIDEO_ROOT;
// The library search: what to look through is a scope, because "find the
// video tagged powerplay" and "find the game with a powerplay clip in it"
// are different questions with the same word in them.
const libView = { q: '', scope: 'both' };

// A file tree row needs a game record before a tag can land on it; opening a
// video makes one anyway, so tagging just makes it a little earlier.
async function ensureGame(path, name) {
  let g = await getGame(path);
  if (!g) {
    g = { id: path, name: name.replace(/\.[^.]+$/, ''), path, source: 'dropbox', clips: [], freezes: [] };
    await putGame(g);
  }
  return g;
}

async function showLibrary() {
  document.title = 'CTH Clips';
  const app = $('#app');
  const games = await listGames();
  app.innerHTML = `
    <header class="lib-head">
      <div class="brand">
        <button class="btn btn-back" id="libHome" title="Back To CTH Apps">${BACK_ICON}</button>
        <img src="../diagrams/assets/cth-icon-black.svg" alt="CTH" class="brand-logo">
        <div class="brand-word">
          <h1>CTH Clips</h1>
        </div>
      </div>
      <div class="lib-actions">
        <button class="btn" id="libLocal" title="Open A Video File From This Device (Marks Still Save)">Open File</button>
        ${dbxConnected() ? '<button class="btn" id="libUpload" title="Upload A Clip To Dropbox - As-Is Or Compressed">Upload</button>' : ''}
        ${dbxConnected() ? '<button class="btn" id="libDbxOut" title="Disconnect Dropbox">Dropbox Connected</button>' : ''}
      </div>
    </header>
    <main class="clib">
      ${games.length ? `
        <div class="clib-title">Recent</div>
        <div class="clib-recents">
          ${games.slice(0, 8).map((g) => `
            <button class="recent-card" data-open="${esc(g.id)}">
              <span class="recent-name">${esc(g.name)}</span>
              <span class="recent-meta">${g.clips?.length || 0} Clip${(g.clips?.length || 0) === 1 ? '' : 's'} &middot; ${fmtDate(g.updated)}</span>
              <span class="recent-del" data-forget="${esc(g.id)}" title="Forget This Video's Marks">&times;</span>
            </button>`).join('')}
        </div>` : ''}
      <div class="clib-title">Dropbox &middot; ${esc(browsePath === VIDEO_ROOT ? 'videos' : browsePath.replace(VIDEO_ROOT + '/', 'videos/'))}</div>
      ${dbxConnected() ? `
      <div class="clib-tools">
        <input id="clibSearch" type="search" placeholder="Search Videos, Tags, Clips…" value="${esc(libView.q)}" autocomplete="off">
        <select id="clibScope" title="What The Search Looks Through">
          <option value="both"${libView.scope === 'both' ? ' selected' : ''}>Tags + Clips</option>
          <option value="tags"${libView.scope === 'tags' ? ' selected' : ''}>Tags Only</option>
          <option value="clips"${libView.scope === 'clips' ? ' selected' : ''}>Clips Only</option>
        </select>
        <button class="mini" id="clibNewFolder" title="Create A Folder Here - It Is A Real Dropbox Folder">New Folder</button>
      </div>` : ''}
      <div id="clibBrowser" class="clib-browser"><div class="clib-note">Loading…</div></div>
    </main>
    <input type="file" id="libFile" accept="video/mp4,video/quicktime,video/webm,.mp4,.mov,.m4v,.webm" hidden>`;

  $('#libHome').onclick = () => { location.href = '../'; };
  $('#libLocal').onclick = () => $('#libFile').click();
  const up = $('#libUpload');
  if (up) up.onclick = () => openUploadSheet();
  const search = $('#clibSearch');
  if (search) {
    search.addEventListener('input', () => { libView.q = search.value; void paintBrowser(); });
    $('#clibScope').onchange = (e) => { libView.scope = e.target.value; void paintBrowser(); };
    $('#clibNewFolder').onclick = async () => {
      const raw = prompt('New Folder Name');
      if (raw == null) return;
      const name = raw.trim().replace(/[/\\]+/g, '-');
      if (!name) return;
      try {
        await dbxCreateFolder(`${browsePath}/${name}`);
        toast(`Folder Created: ${name}`);
        await paintBrowser();
      } catch (e) { toast(e.message || 'Could Not Create The Folder', true); }
    };
  }
  $('#libFile').onchange = (e) => { const f = e.target.files[0]; if (f) openLocal(f); e.target.value = ''; };
  const out = $('#libDbxOut');
  if (out) {
    out.onclick = async () => {
      if (await confirmSheet({ title: 'Disconnect Dropbox?', body: 'Your marks stay saved here. Reconnect any time.', action: 'Disconnect' })) {
        dbxDisconnect();
        await showLibrary();
      }
    };
  }
  document.querySelectorAll('[data-open]').forEach((b) => {
    b.addEventListener('click', (e) => {
      if (e.target.closest('[data-forget]')) return;
      location.hash = `#/v/${encodeURIComponent(b.dataset.open)}`;
    });
  });
  document.querySelectorAll('[data-forget]').forEach((x) => {
    x.addEventListener('click', async () => {
      const g = games.find((z) => z.id === x.dataset.forget);
      if (await confirmSheet({ title: `Forget "${g?.name}"?`, body: 'Deletes its clips, tags and freezes from this browser. The video itself is untouched.' })) {
        await deleteGame(x.dataset.forget);
        await showLibrary();
      }
    });
  });

  await paintBrowser();
}

async function paintBrowser() {
  const box = $('#clibBrowser');
  if (!box) return;
  if (!dbxConnected()) {
    box.innerHTML = `
      <div class="dbx-card">
        <h2>Connect Dropbox</h2>
        <p>Clips reads your game film from the <strong>videos</strong> folder of your Dropbox and writes exports to <strong>videos/exports</strong>. One-time setup:</p>
        <ol>
          <li>Create a (free) Dropbox app at <a href="https://www.dropbox.com/developers/apps/create" target="_blank" rel="noopener">dropbox.com/developers/apps</a>: choose Scoped Access, Full Dropbox, any name.</li>
          <li>On the app's Settings tab, add both Redirect URIs:<br><code>https://apps.coachtonyhockey.com/clips/</code><br><code>http://localhost:8642/clips/</code></li>
          <li>On the Permissions tab, tick: files.metadata.read, files.content.read, files.content.write, sharing.read, sharing.write. Submit.</li>
          <li>Paste the App key below and press Connect.</li>
        </ol>
        <div class="dbx-row">
          <input id="dbxKey" placeholder="Dropbox App Key" value="${esc(dbxAppKey())}" autocomplete="off">
          <button class="btn btn-ink" id="dbxGo">Connect Dropbox</button>
        </div>
      </div>`;
    $('#dbxGo').onclick = () => {
      const k = $('#dbxKey').value.trim();
      if (!k) { toast('Paste The App Key First', true); return; }
      void dbxBeginAuth(k);
    };
    return;
  }
  try {
    const [{ folders, files, missing }, games] = await Promise.all([dbxListFolder(browsePath), listGames()]);
    if (missing) {
      box.innerHTML = '<div class="clib-note">No "videos" Folder In Your Dropbox Yet - Create One And Drop Game Film In It.</div>';
      return;
    }
    const byPath = new Map(games.map((g) => [g.id, g]));
    const q = libView.q.trim().toLowerCase();
    const has = (s) => (s || '').toLowerCase().includes(q);
    // Whether a game record answers the search, under the chosen scope.
    const gameHit = (g) => {
      if (!g || !q) return false;
      const tagsHit = (g.videoTags || []).some(has);
      const clipsHit = (g.clips || []).some((c) => has(c.name) || has(c.label) || (c.tags || []).some(has));
      return libView.scope === 'tags' ? tagsHit : libView.scope === 'clips' ? clipsHit : tagsHit || clipsHit;
    };
    const shownFolders = q ? folders.filter((f) => has(f.name)) : folders;
    const shownFiles = q ? files.filter((f) => has(f.name) || gameHit(byPath.get(f.path))) : files;
    // Search reaches the whole LIBRARY, not just the open folder: a tagged
    // game in another folder answers from its own records without a
    // recursive Dropbox walk. Only tagged/opened videos can match here,
    // because those are the only ones the library has records for.
    const herePaths = new Set(files.map((f) => f.path));
    const elsewhere = q
      ? games.filter((g) => g.source === 'dropbox' && !herePaths.has(g.id) && (has(g.name) || gameHit(g)))
      : [];
    const allTags = [...new Set(games.flatMap((g) => g.videoTags || []))];
    const chipRow = (g, path, name) => `
      <span class="clib-tags">
        ${(g?.videoTags || []).map((t) => `
          <span class="tag-chip" data-qtag="${esc(t)}" title="Search #${esc(t)}">#${esc(t)}<button data-rmtag="${esc(t)}" data-path="${esc(path)}" data-name="${esc(name)}" title="Remove #${esc(t)}">&times;</button></span>`).join('')}
        <input class="clib-tagin" data-tagin="${esc(path)}" data-name="${esc(name)}" list="clibTagOpts" placeholder="+ Tag" autocomplete="off"
          title="Type A Tag And Press Enter - It Lands On This Video">
      </span>`;
    const videoRow = (f, opts = {}) => {
      const g = byPath.get(f.path);
      const n = g?.clips?.length || 0;
      return `
      <div class="clib-row clib-video" data-vrow="${esc(f.path)}" data-name="${esc(f.name)}" role="button" tabindex="0">
        <svg class="clib-ic" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8"><rect x="3" y="5" width="18" height="14" rx="3"/><path d="m10 9 5 3-5 3z" fill="currentColor" stroke="none"/></svg>
        <span class="clib-name">${esc(f.name)}</span>
        ${chipRow(g, f.path, f.name)}
        ${n ? `<span class="clib-count">${n} Clip${n === 1 ? '' : 's'}</span>` : ''}
        ${opts.where ? `<span class="clib-size">${esc(opts.where)}</span>`
    : `<span class="clib-size">${(f.size / 1e9) >= 1 ? `${(f.size / 1e9).toFixed(1)} GB` : `${Math.round(f.size / 1e6)} MB`}</span>`}
      </div>`;
    };
    box.innerHTML = `
      <datalist id="clibTagOpts">${allTags.map((t) => `<option value="${esc(t)}">`).join('')}</datalist>
      ${browsePath !== VIDEO_ROOT ? '<button class="clib-row clib-up" data-up>&larr; Up</button>' : ''}
      ${shownFolders.map((f) => `
        <button class="clib-row" data-cd="${esc(f.path)}">
          <svg class="clib-ic" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8"><path d="M3 7a2 2 0 0 1 2-2h4l2 2h8a2 2 0 0 1 2 2v9a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2z"/></svg>
          <span>${esc(f.name)}</span>
        </button>`).join('')}
      ${shownFiles.map((f) => videoRow(f)).join('')}
      ${!shownFolders.length && !shownFiles.length ? `<div class="clib-note">${q ? 'Nothing In This Folder Matches.' : 'This Folder Is Empty.'}</div>` : ''}
      ${elsewhere.length ? `
        <div class="clib-title">Matches Elsewhere In Your Library</div>
        ${elsewhere.map((g) => videoRow({ path: g.id, name: g.name, size: 0 }, { where: 'Library' })).join('')}` : ''}`;
    box.querySelector('[data-up]')?.addEventListener('click', () => {
      browsePath = browsePath.split('/').slice(0, -1).join('/') || VIDEO_ROOT;
      void showLibrary();
    });
    box.querySelectorAll('[data-cd]').forEach((b) => b.addEventListener('click', () => { browsePath = b.dataset.cd; void showLibrary(); }));
    box.querySelectorAll('[data-vrow]').forEach((row) => {
      const open = async () => {
        await ensureGame(row.dataset.vrow, row.dataset.name);
        location.hash = `#/v/${encodeURIComponent(row.dataset.vrow)}`;
      };
      row.addEventListener('click', (e) => {
        if (e.target.closest('.tag-chip') || e.target.closest('.clib-tagin')) return;
        void open();
      });
      row.addEventListener('keydown', (e) => {
        if (e.target === row && (e.key === 'Enter' || e.key === ' ')) { e.preventDefault(); void open(); }
      });
    });
    // Tag chips: the x removes the tag; the chip itself searches for it.
    box.querySelectorAll('[data-rmtag]').forEach((x) => {
      x.addEventListener('click', async () => {
        const g = await ensureGame(x.dataset.path, x.dataset.name);
        g.videoTags = (g.videoTags || []).filter((t) => t !== x.dataset.rmtag);
        await putGame(g);
        await paintBrowser();
      });
    });
    box.querySelectorAll('[data-qtag]').forEach((chip) => {
      chip.addEventListener('click', (e) => {
        if (e.target.closest('[data-rmtag]')) return;
        libView.q = chip.dataset.qtag;
        const s = $('#clibSearch');
        if (s) s.value = libView.q;
        void paintBrowser();
      });
    });
    box.querySelectorAll('.clib-tagin').forEach((tin) => {
      tin.addEventListener('keydown', async (e) => {
        e.stopPropagation();
        if (e.key !== 'Enter' && e.key !== ',') return;
        e.preventDefault();
        const t = normTag(tin.value);
        if (!t) return;
        const g = await ensureGame(tin.dataset.tagin, tin.dataset.name);
        if (!(g.videoTags || []).includes(t)) g.videoTags = [...(g.videoTags || []), t];
        await putGame(g);
        await paintBrowser();
        // Keep the caret in the same row so a second tag is one keystroke away.
        box.querySelector(`.clib-tagin[data-tagin="${CSS.escape(tin.dataset.tagin)}"]`)?.focus();
      });
    });
  } catch (e) {
    console.error(e);
    box.innerHTML = `<div class="clib-note">Dropbox Error: ${esc(e.message || 'Unknown')}. <button class="mini" id="dbxRetry">Retry</button></div>`;
    $('#dbxRetry').onclick = () => void paintBrowser();
  }
}

async function openLocal(file) {
  const id = `local:${file.name}:${file.size}`;
  localUrls.set(id, URL.createObjectURL(file));
  let g = await getGame(id);
  if (!g) {
    g = { id, name: file.name.replace(/\.[^.]+$/, ''), path: file.name, source: 'local', clips: [], freezes: [] };
    await putGame(g);
  }
  location.hash = `#/v/${encodeURIComponent(id)}`;
}

// ------------------------------------------------------------- player view

async function showPlayer(id) {
  const game = await getGame(id);
  if (!game) { toast('That Video Is Not In The Library', true); location.hash = '#/'; return; }
  document.title = `${game.name} - CTH Clips`;

  let src = null;
  if (game.source === 'local') {
    src = localUrls.get(id);
    if (!src) {
      // A local file cannot be reopened without the user - ask for it again.
      $('#app').innerHTML = `
        <div class="reopen">
          <h2>Re-Open "${esc(game.name)}"</h2>
          <p>Local files need re-picking after a reload (browsers forget them). Your ${game.clips.length} clip${game.clips.length === 1 ? '' : 's'} are safe.</p>
          <button class="btn btn-ink" id="reopenGo">Choose The File</button>
          <button class="btn" id="reopenBack">Back To Library</button>
          <input type="file" id="reopenFile" accept="video/*,.mp4,.mov,.m4v,.webm" hidden>
        </div>`;
      $('#reopenBack').onclick = () => { location.hash = '#/'; };
      $('#reopenGo').onclick = () => $('#reopenFile').click();
      $('#reopenFile').onchange = (e) => {
        const f = e.target.files[0];
        if (!f) return;
        localUrls.set(id, URL.createObjectURL(f));
        void showPlayer(id);
      };
      return;
    }
  } else {
    try {
      src = await dbxTempLink(game.path);
    } catch (e) {
      console.error(e);
      toast(`Could Not Open From Dropbox: ${e.message || ''}`, true);
      location.hash = '#/';
      return;
    }
  }

  $('#app').innerHTML = `
    <div class="vp">
      <header class="ed-head">
        <button class="btn btn-back" id="vpBack" title="Back To The Library">${BACK_ICON}</button>
        <div class="vp-title">${esc(game.name)}</div>
        <span class="ed-status" id="vpStatus">Saved</span>
        <div class="ed-head-actions">
          <button class="btn" id="vpFreeze" title="Freeze This Frame And Draw On It (F)">Freeze</button>
          <button class="btn" id="vpEmail" title="Email Clips To A Group">Email</button>
          <button class="btn" id="vpLogBtn" title="Show Or Hide The Clip Log">Clips</button>
        </div>
      </header>
      <div class="vp-main">
        <div class="vp-stagecol">
          <div class="vp-stage" id="vpStage">
            <video id="vpVideo" playsinline crossorigin="anonymous"></video>
            <canvas id="vpOverlay" style="display:none"></canvas>
            <div id="anRoot" class="an-root" hidden>
              <canvas id="anFrame" class="an-frame"></canvas>
              <canvas id="anCanvas" class="an-canvas"></canvas>
              <div class="tb an-tb" id="anBar"></div>
            </div>
          </div>
          <div class="vp-transport">
            <button class="tbtn" id="vpBack5" title="Back 5s (Left Arrow)"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M11 17l-5-5 5-5"/><path d="M18 17l-5-5 5-5"/></svg></button>
            <button class="tbtn" id="vpFrameB" title="Previous Frame (,)"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M14 17l-5-5 5-5"/><path d="M6 6v12"/></svg></button>
            <button class="tbtn tbtn-play" id="vpPlay" title="Play / Pause (Space)"><svg viewBox="0 0 24 24" fill="currentColor" stroke="none"><path d="M7 4.5v15l13-7.5z"/></svg></button>
            <button class="tbtn" id="vpFrameF" title="Next Frame (.)"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M10 17l5-5-5-5"/><path d="M18 6v12"/></svg></button>
            <button class="tbtn" id="vpFwd5" title="Forward 5s (Right Arrow)"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M13 17l5-5-5-5"/><path d="M6 17l5-5-5-5"/></svg></button>
            <button class="tbtn tbtn-word" id="vpSpeed" title="Playback Speed (J Slower / L Faster)">1x</button>
            <span class="vp-clock" id="vpClock">0:00 / 0:00</span>
            <span class="vp-hintkeys">Two-Finger Swipe Scrubs (Shift = Fine) &middot; I/O Trim &middot; F Freeze</span>
          </div>
          <canvas id="vpTimeline" class="vp-timeline"></canvas>
          <div class="vp-split" id="vpSplit" title="Drag To Resize The Clip Log - Double-Click Resets"><span></span></div>
          <section class="vp-log" id="vpLog"></section>
        </div>
        <aside class="vp-side" id="vpSide"></aside>
      </div>
    </div>`;

  $('#vpBack').onclick = () => { location.hash = '#/'; };
  $('#vpLogBtn').onclick = () => { document.querySelector('.vp').classList.toggle('log-hidden'); };
  $('#vpEmail').onclick = () => openEmailSheet(game);
  wireLogSplit();

  await openPlayer(game, src, {
    onShare: (clip, anchor) => openShareMenu(game, clip, anchor),
    onAnnotate: (freeze) => {
      openAnnotate(freeze, grabFrame(), {
        onDone: (f) => { updateFreeze(f); toast('Freeze Saved - Playback Pauses Here'); },
        onExport: (canvas, f) => void exportFrame(game, canvas, f),
        onSend: (canvas) => void sendFrameToDiagrams(game, canvas),
      });
    },
  });
}

// ------------------------------------------------------------- upload

// The CTH Compressor, in the browser (2026-08-25, Tony's ask). The Mac
// droplet's recipe is H.264, capped at 1080p, ~4 Mbps, AAC audio; this
// mirrors those numbers with what a browser has: the clip plays once
// through a scaled canvas into MediaRecorder, so compression runs in real
// time (a 30s clip takes ~30s). Original skips all of that and uploads the
// file as-is, chunked with real progress for big film.
const UP_QUALITY = {
  1080: { maxW: 1920, vbps: 4_000_000 },
  720: { maxW: 1280, vbps: 2_500_000 },
};

async function compressVideo(file, { maxW, vbps }, onProgress) {
  const url = URL.createObjectURL(file);
  const v = document.createElement('video');
  v.src = url;
  v.playsInline = true;
  await new Promise((res, rej) => {
    v.onloadedmetadata = res;
    v.onerror = () => rej(new Error('Could Not Read That Video File'));
  });
  const scale = Math.min(1, maxW / (v.videoWidth || maxW));
  const W = Math.max(2, Math.round((v.videoWidth * scale) / 2) * 2);
  const H = Math.max(2, Math.round((v.videoHeight * scale) / 2) * 2);
  const canvas = document.createElement('canvas');
  canvas.width = W; canvas.height = H;
  const ctx = canvas.getContext('2d');
  const stream = canvas.captureStream(30);
  // Audio rides through WebAudio and is NOT connected to the speakers, so
  // the clip compresses silently but keeps its sound.
  let ac = null;
  try {
    ac = new AudioContext();
    const src = ac.createMediaElementSource(v);
    const dest = ac.createMediaStreamDestination();
    src.connect(dest);
    const at = dest.stream.getAudioTracks()[0];
    if (at) stream.addTrack(at);
  } catch (_) { /* no audio track is fine */ }
  const mime = ['video/mp4', 'video/webm;codecs=vp9', 'video/webm'].find((m) => MediaRecorder.isTypeSupported(m));
  const rec = new MediaRecorder(stream, { mimeType: mime, videoBitsPerSecond: vbps, audioBitsPerSecond: 128_000 });
  const parts = [];
  rec.ondataavailable = (e) => { if (e.data.size) parts.push(e.data); };
  let raf = 0;
  const draw = () => {
    ctx.drawImage(v, 0, 0, W, H);
    if (onProgress && v.duration) onProgress(Math.min(1, v.currentTime / v.duration));
    raf = requestAnimationFrame(draw);
  };
  await v.play();
  rec.start(500);
  draw();
  await new Promise((res) => { v.onended = res; });
  cancelAnimationFrame(raf);
  rec.stop();
  await new Promise((res) => { rec.onstop = res; });
  try { await ac?.close(); } catch (_) { /* already closed */ }
  URL.revokeObjectURL(url);
  return { blob: new Blob(parts, { type: mime }), ext: mime.includes('mp4') ? 'mp4' : 'webm' };
}

function openUploadSheet() {
  document.querySelector('.sheet-veil')?.remove();
  const wrap = document.createElement('div');
  wrap.className = 'sheet-veil';
  const destLabel = browsePath === VIDEO_ROOT ? 'videos' : browsePath.replace(`${VIDEO_ROOT}/`, 'videos/');
  wrap.innerHTML = `
    <div class="sheet" role="dialog" aria-modal="true">
      <h3>Upload A Clip</h3>
      <p>Lands in Dropbox <strong>${esc(destLabel)}</strong> - the folder open in the tree. Compressed matches the CTH Compressor: H.264, 1080p, about 4 Mbps.</p>
      <div class="up-row">
        <button class="btn" id="upPick">Choose Video…</button>
        <span class="up-name" id="upName">No File Chosen</span>
      </div>
      <div class="up-row">
        <label class="up-label" for="upQ">Quality</label>
        <select id="upQ">
          <option value="original">Original (No Compression)</option>
          <option value="1080" selected>Compressed - 1080p (CTH Compressor)</option>
          <option value="720">Compressed - 720p (Smallest)</option>
        </select>
      </div>
      <p class="em-note" id="upNote">Compression plays the clip through once in real time. Leave this tab front and center until it finishes.</p>
      <div class="up-bar" hidden id="upBar"><span id="upFill"></span></div>
      <div class="up-status" id="upStatus"></div>
      <div class="sheet-row">
        <button class="btn" data-x="cancel">Cancel</button>
        <button class="btn btn-ink" id="upGo" disabled>Upload</button>
      </div>
      <input type="file" id="upFile" accept="video/*,.mp4,.mov,.m4v,.webm" hidden>
    </div>`;
  document.body.appendChild(wrap);
  let file = null;
  let busy = false;
  const done = () => { if (!busy) wrap.remove(); };
  wrap.addEventListener('mousedown', (e) => { if (e.target === wrap) done(); });
  wrap.querySelector('[data-x="cancel"]').onclick = done;
  wrap.querySelector('#upPick').onclick = () => wrap.querySelector('#upFile').click();
  wrap.querySelector('#upFile').onchange = (e) => {
    file = e.target.files[0] || null;
    wrap.querySelector('#upName').textContent = file
      ? `${file.name} (${file.size >= 1e9 ? `${(file.size / 1e9).toFixed(1)} GB` : `${Math.round(file.size / 1e6)} MB`})`
      : 'No File Chosen';
    wrap.querySelector('#upGo').disabled = !file;
  };
  const bar = wrap.querySelector('#upBar');
  const fill = wrap.querySelector('#upFill');
  const say = (msg) => { wrap.querySelector('#upStatus').textContent = msg; };
  const pct = (p) => { fill.style.width = `${Math.round(p * 100)}%`; };
  wrap.querySelector('#upGo').onclick = async () => {
    if (!file || busy) return;
    busy = true;
    wrap.querySelector('#upGo').disabled = true;
    wrap.querySelector('[data-x="cancel"]').disabled = true;
    bar.hidden = false;
    try {
      const q = wrap.querySelector('#upQ').value;
      let blob = file;
      let name = file.name;
      if (q !== 'original') {
        say('Compressing - Keep This Tab In Front…');
        const out = await compressVideo(file, UP_QUALITY[q], (p) => { pct(p * 0.7); say(`Compressing… ${Math.round(p * 100)}%`); });
        blob = out.blob;
        name = `${stem(file.name)}-${q}p.${out.ext}`;
        say(`Compressed To ${blob.size >= 1e9 ? `${(blob.size / 1e9).toFixed(1)} GB` : `${Math.round(blob.size / 1e6)} MB`} - Uploading…`);
      }
      const base = q === 'original' ? 0 : 0.7;
      const span = 1 - base;
      await dbxUploadProgress(`${browsePath}/${name}`, blob, (p) => { pct(base + p * span); say(`Uploading… ${Math.round(p * 100)}%`); });
      pct(1);
      toast(`Uploaded: ${destLabel}/${name}`);
      busy = false;
      wrap.remove();
      await paintBrowser();
    } catch (e) {
      console.error(e);
      busy = false;
      say(e.message || 'Upload Failed');
      wrap.querySelector('#upGo').disabled = false;
      wrap.querySelector('[data-x="cancel"]').disabled = false;
    }
  };
}

// The drag bar between the video and the clip log: pulling it up grows the
// log, pulling it down grows the picture. The height persists in settings so
// the split lands where Tony left it; double-click resets to the default.
const LOG_H_DEFAULT = 210;
function wireLogSplit() {
  const split = $('#vpSplit');
  const log = $('#vpLog');
  const col = document.querySelector('.vp-stagecol');
  if (!split || !log) return;
  const clampH = (h) => Math.max(96, Math.min(col.clientHeight - 260, h));
  void (async () => {
    const s = await getSettings();
    log.style.height = `${clampH(s.logH || LOG_H_DEFAULT)}px`;
  })();
  let drag = null;
  split.addEventListener('pointerdown', (e) => {
    e.preventDefault();
    drag = { startY: e.clientY, startH: log.getBoundingClientRect().height };
    split.setPointerCapture?.(e.pointerId);
  });
  split.addEventListener('pointermove', (e) => {
    if (!drag) return;
    log.style.height = `${clampH(drag.startH + (drag.startY - e.clientY))}px`;
  });
  const done = async () => {
    if (!drag) return;
    drag = null;
    const s = await getSettings();
    s.logH = Math.round(log.getBoundingClientRect().height);
    await putSettings(s);
  };
  split.addEventListener('pointerup', done);
  split.addEventListener('pointercancel', done);
  split.addEventListener('dblclick', async () => {
    log.style.height = `${LOG_H_DEFAULT}px`;
    const s = await getSettings();
    s.logH = LOG_H_DEFAULT;
    await putSettings(s);
  });
}

// ------------------------------------------------------------- share

function menu(anchor, items) {
  document.querySelector('.move-menu')?.remove();
  const m = document.createElement('div');
  m.className = 'move-menu';
  m.innerHTML = items.map(([label], i) => `<button data-i="${i}">${esc(label)}</button>`).join('');
  document.body.appendChild(m);
  const r = anchor.getBoundingClientRect();
  m.style.left = `${Math.max(8, Math.min(window.innerWidth - m.offsetWidth - 8, r.right - m.offsetWidth))}px`;
  m.style.top = `${Math.min(window.innerHeight - m.offsetHeight - 8, r.bottom + 6)}px`;
  const close = () => { m.remove(); window.removeEventListener('pointerdown', away, true); };
  const away = (e) => { if (!m.contains(e.target)) close(); };
  window.addEventListener('pointerdown', away, true);
  m.querySelectorAll('[data-i]').forEach((b) => { b.onclick = () => { close(); items[Number(b.dataset.i)][1](); }; });
}

async function clipEmbedUrl(game, clip) {
  if (game.source !== 'dropbox') throw new Error('Sharing Needs The Video In Dropbox');
  const stream = await dbxStreamLink(game.path);
  const u = new URL('embed.html', location.href);
  u.hash = `v=${encodeURIComponent(stream)}&in=${clip.in.toFixed(2)}&out=${clip.out.toFixed(2)}&t=${encodeURIComponent(clip.name || clip.label)}`;
  return u.toString();
}

async function copyText(text, note) {
  await navigator.clipboard.writeText(text);
  toast(note);
}

function openShareMenu(game, clip, anchor) {
  playClip; // (kept near: share menu sits beside play in the log)
  menu(anchor, [
    ['Copy Notion Embed', async () => {
      try {
        await copyText(await clipEmbedUrl(game, clip), 'Embed Link Copied - In Notion: Paste, Then Choose Embed');
      } catch (e) { toast(e.message, true); }
    }],
    ['Copy Clip Link', async () => {
      try {
        await copyText(await clipEmbedUrl(game, clip), 'Clip Link Copied - It Plays Just This Clip');
      } catch (e) { toast(e.message, true); }
    }],
    ['Email This Clip', () => openEmailSheet(game, [clip.id])],
    ['Export Video To Dropbox', () => void exportClipVideo(game, clip)],
  ]);
}

async function exportClipVideo(game, clip) {
  try {
    toast('Recording The Clip In Real Time - Leave This Tab Front And Center');
    const { blob, ext } = await recordClip(clip, (p) => status?.(p));
    const name = `${stem(game.name)}-${stem(clip.name || clip.label)}-${fmtTime(clip.in).replace(':', 'm')}s.${ext}`;
    if (game.source === 'dropbox') {
      const meta = await dbxUpload(`${EXPORT_ROOT}/${name}`, blob);
      // The exported file gets its own library record carrying the clip's
      // tags (plus its label), so the file tree shows what the export IS
      // without opening it. path_lower is the id the tree rows use.
      const eg = await ensureGame(meta.path_lower, meta.name || name);
      eg.videoTags = [...new Set([...(eg.videoTags || []), normTag(clip.label), ...clip.tags.map(normTag)])].filter(Boolean);
      await putGame(eg);
      toast(`Exported To Dropbox: videos/exports/${name}`);
    } else {
      const a = document.createElement('a');
      a.href = URL.createObjectURL(blob);
      a.download = name;
      a.click();
      toast('Clip Downloaded');
    }
  } catch (e) {
    console.error(e);
    toast(e.message || 'Export Failed', true);
  }
}

async function exportFrame(game, canvas, freeze) {
  const blob = await new Promise((res) => canvas.toBlob(res, 'image/png'));
  const name = `${stem(game.name)}-frame-${fmtTime(freeze.t).replace(':', 'm')}s.png`;
  if (game.source === 'dropbox' && dbxConnected()) {
    try {
      await dbxUpload(`${EXPORT_ROOT}/${name}`, blob);
      toast(`Frame Saved To Dropbox: videos/exports/${name}`);
      return;
    } catch (e) { console.error(e); }
  }
  const a = document.createElement('a');
  a.href = URL.createObjectURL(blob);
  a.download = name;
  a.click();
  toast('Frame Downloaded');
}

// The freeze-frame lands in the Diagrams app as a new diagram whose
// background is the frame - same origin, same IndexedDB, zero export steps.
async function sendFrameToDiagrams(game, canvas) {
  const scale = Math.min(1, 1920 / canvas.width);
  let out = canvas;
  if (scale < 1) {
    out = document.createElement('canvas');
    out.width = Math.round(canvas.width * scale);
    out.height = Math.round(canvas.height * scale);
    out.getContext('2d').drawImage(canvas, 0, 0, out.width, out.height);
  }
  const bg = out.toDataURL('image/jpeg', 0.92);
  const drill = {
    id: drillUid(),
    name: `${game.name} Frame`,
    notes: '',
    folder: '',
    created: Date.now(),
    state: { v: 1, w: out.width, h: out.height, bg, seq: 1, elements: [] },
    thumb: null,
  };
  await putDrill(drill);
  window.open(`../diagrams/#/drill/${drill.id}`, '_blank');
  toast('Opened In Diagrams - The Frame Is The Background');
}

// ------------------------------------------------------------- email

async function openEmailSheet(game, preselect = null) {
  const settings = playerSettings() || await getSettings();
  const clips = (playerGame() || game).clips || [];
  if (!clips.length) { toast('No Clips To Email Yet', true); return; }
  document.querySelector('.sheet-veil')?.remove();
  const wrap = document.createElement('div');
  wrap.className = 'sheet-veil';
  const picked = new Set(preselect || clips.map((c) => c.id));
  wrap.innerHTML = `
    <div class="sheet sheet-wide" role="dialog" aria-modal="true">
      <h3>Email Clips</h3>
      <div class="em-groups">
        ${Object.keys(settings.groups).map((gn) => `<button class="mini em-group" data-g="${esc(gn)}">${esc(gn)}</button>`).join('')}
        <button class="mini" data-editgroups title="Edit The Saved Address Groups">Edit Groups</button>
      </div>
      <input id="emTo" placeholder="To: parent@email.com, parent2@email.com" value="">
      <div class="rink-list em-list">
        ${clips.map((c) => `<label class="rink-row"><input type="checkbox" data-c="${c.id}" ${picked.has(c.id) ? 'checked' : ''}> ${esc(clipName(c))} <span class="em-time">${fmtTime(c.in)}</span></label>`).join('')}
      </div>
      <p class="em-note">Each picked clip becomes a link that plays just that clip. Opens your mail app with everything filled in.</p>
      <div class="sheet-row">
        <button class="btn" data-x="cancel">Cancel</button>
        <button class="btn btn-ink" data-x="send">Open Email</button>
      </div>
    </div>`;
  document.body.appendChild(wrap);
  const done = () => wrap.remove();
  wrap.addEventListener('mousedown', (e) => { if (e.target === wrap) done(); });
  wrap.querySelector('[data-x="cancel"]').onclick = done;
  wrap.querySelectorAll('.em-group').forEach((b) => {
    b.onclick = () => {
      const cur = $('#emTo').value.trim();
      const add = settings.groups[b.dataset.g] || '';
      if (!add.trim()) { toast(`The "${b.dataset.g}" Group Is Empty - Use Edit Groups`, true); return; }
      $('#emTo').value = cur ? `${cur}, ${add}` : add;
    };
  });
  wrap.querySelector('[data-editgroups]').onclick = async () => {
    for (const gn of Object.keys(settings.groups)) {
      const v = prompt(`${gn} Emails (Comma-Separated)`, settings.groups[gn] || '');
      if (v != null) settings.groups[gn] = v.trim();
    }
    await putSettings(settings);
    toast('Groups Saved');
  };
  wrap.querySelector('[data-x="send"]').onclick = async () => {
    const to = $('#emTo').value.trim();
    const ids = [...wrap.querySelectorAll('[data-c]:checked')].map((i) => i.dataset.c);
    if (!ids.length) { toast('Pick At Least One Clip', true); return; }
    try {
      const lines = [`Clips From ${game.name}:`, ''];
      for (const cid of ids) {
        const c = clips.find((x) => x.id === cid);
        lines.push(`${clipName(c)} (${fmtTime(c.in)})`);
        lines.push(await clipEmbedUrl(game, c));
        lines.push('');
      }
      lines.push('- Coach Tony');
      const mail = `mailto:${encodeURIComponent(to)}?subject=${encodeURIComponent(`${game.name} - Clips`)}&body=${encodeURIComponent(lines.join('\n'))}`;
      done();
      location.href = mail;
    } catch (e) {
      toast(e.message || 'Could Not Build The Links', true);
    }
  };
}

const status = null; // recordClip progress hook placeholder

// ------------------------------------------------------------- boot

window.addEventListener('hashchange', () => void go());

(async () => {
  const justConnected = await dbxFinishAuth().catch(() => false);
  if (justConnected) toast('Dropbox Connected');
  await go();
})();
