// CTH Clips - app shell. Two views:
//   Library (#/)        - videos from the CTH folder's /videos (folders +
//                         files), recent tagged games, one-file fallback.
//   Player  (#/v/<id>)  - the tagging workspace (player.js).
//
// The film lives in Tony's own cth folder on disk (2026-08-26, replacing
// Dropbox). Exported clips and frames land back in /videos/exports. There
// is no upload and no account: localfs.js holds one folder handle the
// browser remembers, so a video opens as a real File - which is also the
// fastest input the scrub engine has.

import {
  fsSupported, fsInit, fsConnect, fsReconnect, fsDisconnect,
  fsConnected, fsRemembered, fsRootName,
  fsListFolder, fsCreateFolder, fsGetFile, fsWrite, fsLabel,
  VIDEO_ROOT, EXPORT_ROOT,
} from './localfs.js';
import { listGames, getGame, putGame, deleteGame, getSettings, putSettings, uid } from './store.js';
import {
  openPlayer,
  closePlayer,
  playClip,
  recordClip,
  grabFrame,
  fmtTime,
  clipName,
  updateFreeze,
  playerGame,
  playerSettings,
  video,
  normTag,
  paintBar,
  playerDuration,
  playerSel,
  addFreezeHere,
  applyGrade,
  applyBtnHeights,
} from './player.js';
import { openAnnotate, annotationElements, paintIdleBar, onAnnotateIdle, applyToolStyle, setToolPrefs, onToolPrefs } from './annotate.js';
import { recordRange, deliver, fileStem, CROP_PRESETS, openMic } from './export.js';
import { openCompare, closeCompare, comparing } from './compare.js';
import { openVideoEditor } from './videoedit.js';
import { mergeRecordOpts } from './grade.js';
import { drawEl } from '/diagrams/js/flat.js';
import { toast, esc, confirmSheet, fmtDate } from './ui.js';
import { putDrill, uid as drillUid } from '/diagrams/js/store.js';

// Self-installing BoardUI control behaviour (the slider's filled track).
import '/diagrams/js/controls.js';
const $ = (sel) => document.querySelector(sel);
const BACK_ICON = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.8" stroke-linecap="round" stroke-linejoin="round"><path d="M20 12H4"/><path d="m10 18-6-6 6-6"/></svg>';
const stem = (s) => (s || 'clip').replace(/\.[^.]+$/, '').replace(/[^\w\- ]+/g, '').trim().replace(/\s+/g, '-').toLowerCase() || 'clip';

// Object URLs for locally opened files live only for this session. The File
// objects ride beside them: the scrub decoder slices frame bytes straight
// off the File, which an object URL cannot do.
const localUrls = new Map();
const localFiles = new Map();

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

// The folder trail as a BoardUI breadcrumb: every ancestor is a real
// button that jumps straight there (the old label plus the Up row made
// deep folders a climb), the current folder is quiet text at the end.
function crumbsHtml() {
  const segs = browsePath === VIDEO_ROOT ? [] : browsePath.replace(`${VIDEO_ROOT}/`, '').split('/');
  const parts = [{ label: 'videos', path: VIDEO_ROOT }];
  let acc = VIDEO_ROOT;
  for (const seg of segs) { acc += `/${seg}`; parts.push({ label: seg, path: acc }); }
  const items = parts.map((x, i) => (i === parts.length - 1
    ? `<span class="crumb crumb-cur">${esc(x.label)}</span>`
    : `<button class="crumb" data-cd="${esc(x.path)}">${esc(x.label)}</button>`));
  return `<nav class="crumbs" aria-label="Folder Path">
    <span class="crumb crumb-root">${esc(fsRootName() || 'Folder')}</span>
    ${items.join('<span class="crumb-sep" aria-hidden="true"></span>')}
  </nav>`;
}
// The library search: what to look through is a scope, because "find the
// video tagged powerplay" and "find the game with a powerplay clip in it"
// are different questions with the same word in them.
const libView = { q: '', scope: 'both' };

// A file tree row needs a game record before a tag can land on it; opening a
// video makes one anyway, so tagging just makes it a little earlier.
async function ensureGame(path, name) {
  let g = await getGame(path);
  if (!g) {
    // 'folder' joins 'dropbox' and 'local' as a source value; readers treat
    // anything that is not 'local' as "resolve by path inside the folder",
    // so libraries saved by the Dropbox build keep opening unchanged.
    g = { id: path, name: name.replace(/\.[^.]+$/, ''), path, source: 'folder', clips: [], freezes: [] };
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
        ${fsConnected() ? '<button class="btn" id="libUpload" title="Copy A Video Into This Folder - As-Is Or Compressed">Add Video</button>' : ''}
        ${fsConnected() ? `<button class="btn" id="libDbxOut" title="Choose A Different Folder">${esc(fsRootName())}</button>` : ''}
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
      ${crumbsHtml()}
      ${fsConnected() ? `
      <div class="clib-tools">
        <input id="clibSearch" type="search" placeholder="Search Videos, Tags, Clips…" value="${esc(libView.q)}" autocomplete="off">
        <select id="clibScope" title="What The Search Looks Through">
          <option value="both"${libView.scope === 'both' ? ' selected' : ''}>Tags + Clips</option>
          <option value="tags"${libView.scope === 'tags' ? ' selected' : ''}>Tags Only</option>
          <option value="clips"${libView.scope === 'clips' ? ' selected' : ''}>Clips Only</option>
        </select>
        <button class="mini" id="clibNewFolder" title="Create A Real Folder Here On Disk">New Folder</button>
      </div>` : ''}
      <div id="clibBrowser" class="clib-browser"><div class="clib-note">Loading…</div></div>
    </main>
    <input type="file" id="libFile" accept="video/mp4,video/quicktime,video/webm,.mp4,.mov,.m4v,.webm" hidden>`;

  $('#libHome').onclick = () => { location.href = '../'; };
  document.querySelectorAll('.crumbs [data-cd]').forEach((b) => {
    b.onclick = () => { browsePath = b.dataset.cd; void showLibrary(); };
  });
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
        await fsCreateFolder(`${browsePath}/${name}`);
        toast(`Folder Created: ${name}`);
        await paintBrowser();
      } catch (e) { toast(e.message || 'Could Not Create The Folder', true); }
    };
  }
  $('#libFile').onchange = (e) => { const f = e.target.files[0]; if (f) openLocal(f); e.target.value = ''; };
  const out = $('#libDbxOut');
  if (out) {
    out.onclick = async () => {
      if (await confirmSheet({ title: 'Forget This Folder?', body: 'Your clips and tags stay saved here. You can choose a folder again any time.', action: 'Forget' })) {
        void fsDisconnect().then(() => go());
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
  if (!fsConnected()) {
    const noApi = !fsSupported();
    box.innerHTML = `
      <div class="dbx-card">
        <h2>${noApi ? 'Open Videos One At A Time' : (fsRemembered() ? 'Reconnect Your CTH Folder' : 'Choose Your CTH Folder')}</h2>
        ${noApi ? `
          <p>This browser cannot open a whole folder, so Clips will ask for one video at a time. Your clips and tags still save normally.</p>
          <p class="ph-note">Chrome or Edge can open the folder once and remember it.</p>
          <div class="dbx-row">
            <button class="btn btn-ink" id="dbxGo">Open A Video</button>
          </div>` : `
          <p>Clips reads your game film straight from your own <strong>cth</strong> folder and writes exports back to <strong>videos/exports</strong>. Nothing is uploaded and nothing leaves this Mac.</p>
          <ol>
            <li>Press the button below.</li>
            <li>Pick the <code>cth</code> folder in your home folder (the one holding <code>videos</code> and <code>diagrams</code>).</li>
            <li>Choose Allow, and tick "allow on every visit" so it stays open.</li>
          </ol>
          <div class="dbx-row">
            <button class="btn btn-ink" id="dbxGo">${fsRemembered() ? 'Reconnect Folder' : 'Choose Folder'}</button>
            ${fsRemembered() ? '<button class="btn" id="dbxOther">Pick A Different Folder</button>' : ''}
          </div>`}
      </div>`;
    $('#dbxGo').onclick = async () => {
      if (noApi) { $('#libOpen')?.click(); return; }
      try {
        await (fsRemembered() ? fsReconnect() : fsConnect());
        await go();
      } catch (e) {
        if (e && e.name === 'AbortError') return;
        toast(e.message || 'Could Not Open That Folder', true);
      }
    };
    const other = $('#dbxOther');
    if (other) other.onclick = async () => {
      try { await fsConnect(); await go(); }
      catch (e) { if (e && e.name !== 'AbortError') toast(e.message || 'Could Not Open That Folder', true); }
    };
    return;
  }
  try {
    const [{ folders, files, missing }, games] = await Promise.all([fsListFolder(browsePath), listGames()]);
    if (missing) {
      box.innerHTML = `<div class="clib-note">No "videos" Folder In ${esc(fsRootName())} Yet - Create One And Drop Game Film In It.</div>`;
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
    // recursive folder walk. Only tagged/opened videos can match here,
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
    box.innerHTML = `<div class="clib-note">Folder Error: ${esc(e.message || 'Unknown')}. <button class="mini" id="dbxRetry">Retry</button></div>`;
    $('#dbxRetry').onclick = () => void paintBrowser();
  }
}

async function openLocal(file) {
  const id = `local:${file.name}:${file.size}`;
  localUrls.set(id, URL.createObjectURL(file));
  localFiles.set(id, file);
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
        localFiles.set(id, f);
        void showPlayer(id);
      };
      return;
    }
  } else {
    try {
      // A real File, so scrubsource.js reads frames with File.slice - its
      // fast path - instead of range requests over the network.
      const f = await fsGetFile(game.path);
      localFiles.set(id, f);
      src = URL.createObjectURL(f);
      localUrls.set(id, src);
    } catch (e) {
      console.error(e);
      toast(`Could Not Open That Video: ${e.message || ''}`, true);
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
          <button class="btn" id="vpPull" title="Export The Clip Around The Playhead (Right-Click To Set The Buffer)">Pull</button>
          <button class="btn" id="vpRecord" title="Record The Player With Your Voice And Drawings">Record</button>
          <button class="btn" id="vpCompare" title="Put A Second Video Beside This One">Compare</button>
          <label class="vp-hold" title="How Long An Exported Freeze Holds On The Frame, In Seconds. Active While A Freeze Is Open">
            Hold <input id="vpHold" type="number" min="0" max="30" value="3" disabled>s
          </label>
          <span class="ed-sep"></span>
          <button class="btn" id="vpSettings" title="Clips Settings">Settings</button>
          <button class="btn" id="vpLogBtn" title="Show Or Hide The Clip Log">Clips</button>
          <button class="btn" id="vpSideBtn" title="Show Or Hide The Tag Panel">Tags</button>
          <button class="btn" id="vpRailBtn" title="Show Or Hide The Player Rail">Players</button>
        </div>
      </header>
      <div class="vp-main">
        <section class="vp-log" id="vpLog"></section>
        <div class="vp-grip" id="vpGripLog" title="Drag To Resize - Double-Click Resets"><span></span></div>
        <aside class="vp-side" id="vpSide"></aside>
        <div class="vp-grip" id="vpGripSide" title="Drag To Resize - Double-Click Resets"><span></span></div>
        <aside class="vp-prail" id="vpPRail"></aside>
        <div class="vp-grip" id="vpGripRail" title="Drag To Resize - Double-Click Resets"><span></span></div>
        <div class="vp-stagecol">
          <div class="vp-stage" id="vpStage">
            <video id="vpVideo" playsinline crossorigin="anonymous"></video>
            <canvas id="vpOverlay" style="display:none"></canvas>
            <div id="anRoot" class="an-root" hidden>
              <canvas id="anFrame" class="an-frame"></canvas>
              <canvas id="anCanvas" class="an-canvas"></canvas>
            </div>
          </div>
          <!-- THE TOOLBAR LIVES HERE NOW (2026-08-27, Tony's call), in the
               strip the timeline used to own, and it is always on screen. It
               used to sit inside #anRoot, which meant it only existed once a
               freeze was already open - so the tools were invisible exactly
               when you were deciding whether to draw. -->
          <div class="vp-tlwrap">
            <div class="tb an-tb" id="anBar"></div>
          </div>
          <div class="vp-transport">
            <span class="vp-tc" id="vpClock">0:00:00</span>
            <span class="vp-tbtns">
              <button class="tbtn" id="vpBack5" title="Back 5s"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M11 17l-5-5 5-5"/><path d="M18 17l-5-5 5-5"/></svg></button>
              <button class="tbtn" id="vpFrameB" title="Previous Frame"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M14 17l-5-5 5-5"/><path d="M6 6v12"/></svg></button>
              <button class="tbtn tbtn-play" id="vpPlay" title="Play / Pause"><svg viewBox="0 0 24 24" fill="currentColor" stroke="none"><path d="M7 4.5v15l13-7.5z"/></svg></button>
              <button class="tbtn" id="vpFrameF" title="Next Frame"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M10 17l5-5-5-5"/><path d="M18 6v12"/></svg></button>
              <button class="tbtn" id="vpFwd5" title="Forward 5s"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M13 17l5-5-5-5"/><path d="M6 17l5-5-5-5"/></svg></button>
              <button class="tbtn tbtn-word" id="vpSpeed" title="Playback Speed">1x</button>
              <button class="tbtn tbtn-word" id="vpEdit" title="Crop, Colour And Cover A Watermark - Applies Instantly">Edit</button>
            </span>
            <!-- The timeline moved INTO the transport bar, which is where a
                 scrubber belongs anyway: the clock, the transport and the
                 position you are scrubbing to are now one control instead of
                 two stacked strips. -->
            <canvas id="vpTimeline" class="vp-timeline"></canvas>
            <span class="vp-tc vp-tc--r" id="vpTotal">0:00:00</span>
          </div>
        </div>
      </div>
    </div>`;

  $('#vpBack').onclick = () => { location.hash = '#/'; };
  $('#vpLogBtn').onclick = () => { document.querySelector('.vp').classList.toggle('log-hidden'); };
  $('#vpSideBtn').onclick = () => { document.querySelector('.vp').classList.toggle('side-hidden'); };
  $('#vpRailBtn').onclick = async () => {
    const vp = document.querySelector('.vp');
    vp.classList.toggle('rail-hidden');
    const st = playerSettings() || await getSettings();
    st.railOpen = !vp.classList.contains('rail-hidden');
    await putSettings(st);
  };
  $('#vpSettings').onclick = () => openClipSettings();
  $('#vpPull').onclick = () => void runPull(game, video().currentTime);
  $('#vpPull').oncontextmenu = (e) => { e.preventDefault(); void editBuffer('pullBuf', 'Pull'); };
  $('#vpFreeze').oncontextmenu = (e) => { e.preventDefault(); void editBuffer('freezeBuf', 'Freeze'); };
  $('#vpRecord').onclick = () => void openRecord(game);
  $('#vpCompare').onclick = () => void openCompare({ name: game.name, url: src, startAt: video().currentTime });
  // Nothing on disk changes, so there is nothing to reload: the grade is
  // handed straight to the player, which puts it on the video element.
  $('#vpEdit').onclick = () => void openVideoEditor({
    game,
    video: video(),
    src,
    onApplied: (grade) => applyGrade(grade),
  });
  wirePanels();

  // The toolbar is on screen from the moment the player is, so it needs a
  // resting state and a way back to it. Picking a tool from the idle row
  // freezes the current frame and arms that tool in one gesture.
  // The toolbar reads its keys, styles, swatches, order and shape style from
  // one module-level record, so it can be edited before a freeze exists. Seed
  // it from settings here, and write any change on the bar straight back -
  // the same round trip a rebound key has always had, now covering all six.
  const bootSt = playerSettings() || await getSettings();
  setToolPrefs(bootSt);
  onToolPrefs(async (patch) => {
    const live = playerSettings();
    if (live) Object.assign(live, patch);
    await putSettings({ ...(live || (await getSettings())), ...patch });
  });
  const showIdleBar = () => paintIdleBar((tool) => addFreezeHere(tool));
  onAnnotateIdle(showIdleBar);
  showIdleBar();

  await openPlayer(game, src, {
    onSettings: (focus) => openClipSettings(focus),
    // Every video now arrives as a real File, so the decoder always takes
    // its fast path: bytes sliced straight off the file, no range requests.
    scrubFile: localFiles.get(id) || null,
    onShare: (clip, anchor) => openShareMenu(game, clip, anchor),
    onBulkPull: (clips) => void runBulkPull(game, clips),
    onAnnotate: async (freeze, armTool = null) => {
      const st = playerSettings() || await getSettings();
      openAnnotate(freeze, grabFrame(), {
        style: st.toolStyle,
        positions: st.positions,
        armTool,
        keys: st.toolKeys,
        // The hold field lives in the player header now, so a change to it
        // has to reach the game record itself rather than waiting for some
        // other edit to trigger an autosave.
        onFreeze: (f) => updateFreeze(f),
        toolOrder: st.toolOrder,
        shapeStyle: st.shapeStyle,
        autoSelect: st.autoSelect !== false,
        colorPresets: st.colorPresets,
        textSize: st.textSize,
        // THE VIDEO STAYS PAUSED through all of it (2026-08-29, Tony's
        // call): after a draw, and after Done, Export or Clear. Coming
        // back to a moving picture loses the play that was being marked.
        onDraw: () => video().pause(),
        // DONE FINISHES, IT DOES NOT EXPORT. Nothing leaves this app
        // unless Export is pressed - the 2026-08-27 rule where Done was
        // the export is reversed.
        onDone: () => video().pause(),
        // Export writes whichever deliverable Settings names: the held
        // clip (the default, and what Done used to produce) or a PNG of
        // the annotated frame.
        onExport: (canvas, f) => {
          video().pause();
          const live = playerSettings() || st;
          if ((live.exportKind || 'clip') === 'png') void exportFrame(game, canvas, f);
          else void runFreezeExport(game, f, f.elements || []);
        },
      });
    },
  });
}

// BOTH PANELS RESIZE AND COLLAPSE (2026-08-25, Tony's ask). Each has a grip
// and each goes properly narrow: the log to 150px (a timecode plus a short
// name), the tag column to 58px, where the buttons are 7-character chips.
// Either collapses to nothing from its header button, which is the real
// "out of the way" - a drag can only ever get small, never disappear.
const LOG_W_DEFAULT = 300;
const LOG_W_MIN = 150;
const SIDE_W_DEFAULT = 124;
// The buttons no longer shrink with the column (2026-08-26, Tony's call), so
// the column can only go as narrow as a whole button: 7 characters, its key
// badge and the padding either side. Below this it would clip them.
// 68px is a whole tag button at its new padding - about 35% under the old
// 104px floor (2026-08-27, Tony's call). The buttons themselves still do
// not resize with the column; see the css note on .vp-side.
const SIDE_W_MIN = 68;
// The roster column resizes and collapses exactly like the other two
// (2026-08-29, Tony's call). 116 is where it has always drawn - the width of
// the longest label it carries - and 76 is a number plus a short first name,
// below which every name ellipsises.
const RAIL_W_DEFAULT = 116;
const RAIL_W_MIN = 76;

function wireResize({ grip, panel, key, def, min, max }) {
  const h = $(grip);
  const el = $(panel);
  const main = document.querySelector('.vp-main');
  if (!h || !el) return;
  // The ceiling is only meaningful once the row has a width. At init the
  // panel is often measured before layout settles (main.clientWidth is 0),
  // and clamping against that collapsed both panels to their minimums on
  // every load - so the ceiling applies only when there is one to apply.
  const clampW = (w) => {
    const room = main.clientWidth ? Math.min(max, main.clientWidth - 280) : max;
    return Math.max(min, Math.min(Math.max(min, room), w));
  };
  void (async () => {
    const s = await getSettings();
    el.style.width = `${clampW(s[key] || def)}px`;
  })();
  let drag = null;
  h.addEventListener('pointerdown', (e) => {
    e.preventDefault();
    drag = { startX: e.clientX, startW: el.getBoundingClientRect().width };
    // A pointer id can vanish between down and capture (and a synthetic
    // event has none); capture is an optimization, never a requirement.
    try { h.setPointerCapture?.(e.pointerId); } catch (_) { /* fine */ }
  });
  h.addEventListener('pointermove', (e) => {
    if (!drag) return;
    el.style.width = `${clampW(drag.startW + (e.clientX - drag.startX))}px`;
  });
  const done = async () => {
    if (!drag) return;
    drag = null;
    const s = await getSettings();
    s[key] = Math.round(el.getBoundingClientRect().width);
    await putSettings(s);
  };
  h.addEventListener('pointerup', done);
  h.addEventListener('pointercancel', done);
  h.addEventListener('dblclick', async () => {
    el.style.width = `${def}px`;
    const s = await getSettings();
    s[key] = def;
    await putSettings(s);
  });
}

function wirePanels() {
  wireResize({ grip: '#vpGripLog', panel: '#vpLog', key: 'logW', def: LOG_W_DEFAULT, min: LOG_W_MIN, max: 560 });
  wireResize({ grip: '#vpGripSide', panel: '#vpSide', key: 'sideW', def: SIDE_W_DEFAULT, min: SIDE_W_MIN, max: 240 });
  wireResize({ grip: '#vpGripRail', panel: '#vpPRail', key: 'railW', def: RAIL_W_DEFAULT, min: RAIL_W_MIN, max: 260 });
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
      <h3>Add A Video</h3>
      <p>Lands in <strong>${esc(destLabel)}</strong> - the folder open in the tree. Compressed matches the CTH Compressor: H.264, 1080p, about 4 Mbps.</p>
      <button type="button" class="up-drop" id="upDrop" aria-label="Choose Or Drop A Video">
        <span class="up-drop-ic" aria-hidden="true"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M12 16V5.5"/><path d="m7.5 9.5 4.5-4.5 4.5 4.5"/><path d="M4.5 16.5v1.75A1.75 1.75 0 0 0 6.25 20h11.5a1.75 1.75 0 0 0 1.75-1.75V16.5"/></svg></span>
        <span class="up-drop-main" id="upName">Drop A Video Here, Or Click To Choose</span>
        <span class="up-drop-sub" id="upSub">MP4, MOV, M4V or WebM</span>
      </button>
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
  const drop = wrap.querySelector('#upDrop');
  const setFile = (f) => {
    file = f || null;
    wrap.querySelector('#upName').textContent = file
      ? file.name
      : 'Drop A Video Here, Or Click To Choose';
    wrap.querySelector('#upSub').textContent = file
      ? (file.size >= 1e9 ? `${(file.size / 1e9).toFixed(1)} GB` : `${Math.round(file.size / 1e6)} MB`)
      : 'MP4, MOV, M4V or WebM';
    drop.classList.toggle('has-file', !!file);
    wrap.querySelector('#upGo').disabled = !file;
  };
  drop.onclick = () => wrap.querySelector('#upFile').click();
  drop.addEventListener('dragover', (e) => { e.preventDefault(); drop.classList.add('over'); });
  drop.addEventListener('dragleave', () => drop.classList.remove('over'));
  drop.addEventListener('drop', (e) => {
    e.preventDefault();
    drop.classList.remove('over');
    const f = e.dataTransfer.files?.[0];
    if (f && /\.(mp4|mov|m4v|webm)$/i.test(f.name)) setFile(f);
    else if (f) toast('That Is Not A Video File', true);
  });
  wrap.querySelector('#upFile').onchange = (e) => setFile(e.target.files[0]);
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
      await fsWrite(`${browsePath}/${name}`, blob, { onProgress: (p) => { pct(base + p * span); say(`Saving… ${Math.round(p * 100)}%`); } });
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

// A shareable link needs a URL other people's browsers can reach. A file in
// Tony's own folder has none, so link sharing is only possible for a video
// that already sits at a public URL (an external link saved on the record).
async function clipEmbedUrl(game, clip) {
  const stream = game.streamUrl || (/^https?:/i.test(game.path || '') ? game.path : '');
  if (!stream) throw new Error('Local Files Cannot Be Linked - Export The Clip And Send The File');
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
    ['Export Video To Folder', () => void exportClipVideo(game, clip)],
  ]);
}

async function exportClipVideo(game, clip) {
  try {
    toast('Recording The Clip In Real Time - Leave This Tab Front And Center');
    const { blob, ext } = await recordClip(clip, (p) => status?.(p));
    const name = `${stem(game.name)}-${stem(clip.name || clip.label)}-${fmtTime(clip.in).replace(':', 'm')}s.${ext}`;
    if (game.source !== 'local') {
      const meta = await fsWrite(`${EXPORT_ROOT}/${name}`, blob);
      // The exported file gets its own library record carrying the clip's
      // tags (plus its label), so the file tree shows what the export IS
      // without opening it. path_lower is the id the tree rows use.
      const eg = await ensureGame(meta.path, meta.name || name);
      eg.videoTags = [...new Set([...(eg.videoTags || []), normTag(clip.label), ...clip.tags.map(normTag)])].filter(Boolean);
      await putGame(eg);
      toast(`Exported To ${fsLabel(EXPORT_ROOT)}/${name}`);
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
  if (game.source !== 'local' && fsConnected()) {
    try {
      await fsWrite(`${EXPORT_ROOT}/${name}`, blob);
      toast(`Frame Saved To ${fsLabel(EXPORT_ROOT)}/${name}`);
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


const status = null; // recordClip progress hook placeholder

// ------------------------------------------------------------- boot

window.addEventListener('hashchange', () => void go());

// ------------------------------------------------------- freeze/pull/record
//
// Three buttons, one engine (export.js). Freeze bakes a held, annotated
// frame into the middle of a clip; Pull takes the same window with nothing
// added; Record composites the player with a cursor ring and your voice.
// None of them writes to the Clip Log and none of them reports success -
// the file appearing beside its source IS the report.

const bufOf = (s, which) => ({ before: 5, after: 10, ...(s?.[which] || {}) });

function clipWindow(t, buf, duration) {
  return {
    from: Math.max(0, t - buf.before),
    to: Math.min(duration || t + buf.after, t + buf.after),
  };
}

// Right-click Freeze or Pull to change its buffer. Written straight to
// settings, so it holds for every later export.
async function editBuffer(which, label) {
  const st = playerSettings() || await getSettings();
  const cur = bufOf(st, which);
  const before = Number(prompt(`${label}: seconds BEFORE the playhead`, cur.before));
  if (!Number.isFinite(before)) return;
  const after = Number(prompt(`${label}: seconds AFTER the playhead`, cur.after));
  if (!Number.isFinite(after)) return;
  const next = { before: Math.max(0, before), after: Math.max(1, after) };
  st[which] = next;
  await putSettings(st);
  toast(`${label} Buffer: ${next.before}s / ${next.after}s`);
}

// The clip a Freeze or Pull is named after: whichever row is selected, else
// the play itself at this timecode.
function namingFor(game, t) {
  const sel = (playerGame()?.clips || []).find((c) => c.id === playerSel());
  if (sel && t >= sel.in - 0.5 && t <= sel.out + 0.5) {
    return { name: sel.name || sel.label, tags: sel.tags || [], label: sel.label, t: sel.in };
  }
  return { name: game.name, tags: [], label: '', t };
}

async function runFreezeExport(game, freeze, elements) {
  const st = playerSettings() || await getSettings();
  const v = video();
  const buf = bufOf(st, 'freezeBuf');
  const w = clipWindow(freeze.t, buf, playerDuration());
  const meta = namingFor(game, freeze.t);
  const stemName = fileStem(st.naming, { ...meta, suffix: '-freeze' });
  try {
    const { blob, ext } = await recordRange(v, mergeRecordOpts(game.grade, {
      from: w.from,
      to: w.to,
      holdAt: freeze.t,
      hold: Math.max(0, Number(freeze.hold ?? st.holdSec) || 0),
      // The drawings are painted into every frame OF THE HOLD only: an
      // annotation that floats over the live action before and after the
      // freeze reads as a glitch, not as a note.
      paint: (ctx, cv) => {
        if (!v.paused) return;
        ctx.save();
        ctx.scale(cv.width / (v.videoWidth || cv.width), cv.height / (v.videoHeight || cv.height));
        for (const el2 of elements || []) drawEl(ctx, el2);
        ctx.restore();
      },
    }));
    await deliver(game, blob, `${stemName}.${ext}`);
  } catch (e) {
    console.error(e);
    toast(e.message || 'Freeze Export Failed', true);
  }
}

async function runPull(game, t, nameMeta = null) {
  const st = playerSettings() || await getSettings();
  const v = video();
  const buf = bufOf(st, 'pullBuf');
  const w = clipWindow(t, buf, playerDuration());
  const meta = nameMeta || namingFor(game, t);
  try {
    const { blob, ext } = await recordRange(v, mergeRecordOpts(game.grade, { from: w.from, to: w.to }));
    await deliver(game, blob, `${fileStem(st.naming, meta)}.${ext}`);
  } catch (e) {
    console.error(e);
    toast(e.message || 'Pull Export Failed', true);
  }
}

// Several rows at once, each its own file. Sequential on purpose: they all
// drive the one video element.
async function runBulkPull(game, clips) {
  for (const c of clips) {
    await runPull(game, c.in + Math.min(1, (c.out - c.in) / 2), {
      name: c.name || c.label, tags: c.tags || [], label: c.label, t: c.in,
    });
  }
  toast(`${clips.length} Clips Pulled`);
}

// ---- record ----------------------------------------------------------
//
// The capture region is a rectangle OF THE VIDEO. See the note in
// export.js for why that beats a desktop grab here.

let recording = null;

async function openRecord(game) {
  if (recording) { stopRecord(); return; }
  const st = playerSettings() || await getSettings();
  const area = st.recordArea || { x: 0, y: 0, w: 1, h: 1 };
  const veil = document.createElement('div');
  veil.className = 'sheet-veil';
  veil.innerHTML = `
    <div class="sheet sheet-wide" role="dialog" aria-modal="true" aria-label="Record">
      <h3>Record</h3>
      <p>Drag the box to choose what is recorded. Your microphone and the cursor ring are included; the toolbar never is.</p>
      <div class="rec-stage"><canvas class="rec-shot"></canvas><div class="rec-box"></div></div>
      <div class="rec-presets">${CROP_PRESETS.map(([n], i) => `<button class="mini" data-preset="${i}">${n}</button>`).join('')}</div>
      <div class="sheet-row">
        <span class="vp-flex"></span>
        <button class="btn" data-x="cancel">Cancel</button>
        <button class="btn btn-ink" data-x="go">Start (Return)</button>
      </div>
    </div>`;
  document.body.appendChild(veil);

  const shot = veil.querySelector('.rec-shot');
  const v = video();
  shot.width = v.videoWidth || 1280;
  shot.height = v.videoHeight || 720;
  shot.getContext('2d').drawImage(v, 0, 0);
  const boxEl = veil.querySelector('.rec-box');
  let crop = { ...area };
  const place = () => {
    boxEl.style.left = `${crop.x * 100}%`;
    boxEl.style.top = `${crop.y * 100}%`;
    boxEl.style.width = `${crop.w * 100}%`;
    boxEl.style.height = `${crop.h * 100}%`;
  };
  place();
  // Drag anywhere on the frame to draw a new region.
  const stage = veil.querySelector('.rec-stage');
  stage.addEventListener('pointerdown', (e) => {
    const r = stage.getBoundingClientRect();
    const x0 = (e.clientX - r.left) / r.width;
    const y0 = (e.clientY - r.top) / r.height;
    const move = (ev) => {
      const x1 = Math.min(1, Math.max(0, (ev.clientX - r.left) / r.width));
      const y1 = Math.min(1, Math.max(0, (ev.clientY - r.top) / r.height));
      crop = { x: Math.min(x0, x1), y: Math.min(y0, y1), w: Math.abs(x1 - x0), h: Math.abs(y1 - y0) };
      place();
    };
    const up = () => {
      window.removeEventListener('pointermove', move);
      window.removeEventListener('pointerup', up);
      if (crop.w < 0.05 || crop.h < 0.05) { crop = { ...area }; place(); }
    };
    window.addEventListener('pointermove', move);
    window.addEventListener('pointerup', up);
  });
  veil.querySelectorAll('[data-preset]').forEach((b) => {
    b.onclick = () => { crop = { ...CROP_PRESETS[Number(b.dataset.preset)][1] }; place(); };
  });

  const close = () => { document.removeEventListener('keydown', onk, true); veil.remove(); };
  const start = async () => {
    close();
    st.recordArea = crop;
    await putSettings(st);
    void startRecord(game, crop, st);
  };
  function onk(e) {
    if (e.key === 'Enter') { e.preventDefault(); e.stopPropagation(); start(); }
    if (e.key === 'Escape') { e.preventDefault(); e.stopPropagation(); close(); }
  }
  document.addEventListener('keydown', onk, true);
  veil.addEventListener('mousedown', (e) => { if (e.target === veil) close(); });
  veil.querySelector('[data-x="cancel"]').onclick = close;
  veil.querySelector('[data-x="go"]').onclick = start;
}

async function startRecord(game, crop, st) {
  const v = video();
  const mic = await openMic();
  // The annotation toolbar opens over the take. Its drawings are painted
  // into the file; the toolbar itself never can be, because the file is
  // composited from the video, not grabbed off the screen.
  const freeze = { id: uid(), t: v.currentTime, hold: 0, elements: [] };
  openAnnotate(freeze, grabFrame(), {
    keys: st.toolKeys,
    onDone: () => stopRecord(),
    onExport: (canvas) => void deliverFrame(game, canvas),
  });
  // Where the pointer is, in video coordinates, for the ring.
  let cursor = null;
  const track = (e) => {
    const c = document.getElementById('anCanvas');
    if (!c) return;
    const r = c.getBoundingClientRect();
    const sc = Math.min(r.width / (v.videoWidth || 1), r.height / (v.videoHeight || 1));
    const ox = r.left + (r.width - (v.videoWidth || 1) * sc) / 2;
    const oy = r.top + (r.height - (v.videoHeight || 1) * sc) / 2;
    cursor = { x: (e.clientX - ox) / sc, y: (e.clientY - oy) / sc };
  };
  window.addEventListener('pointermove', track);

  const hi = st.cursorHi || {};
  const paint = (ctx, cv, box) => {
    ctx.save();
    ctx.translate(-box.sx * (cv.width / box.sw), -box.sy * (cv.height / box.sh));
    ctx.scale(cv.width / box.sw, cv.height / box.sh);
    for (const el2 of annotationElements()) drawEl(ctx, el2);
    if (hi.on !== false && cursor) {
      ctx.beginPath();
      ctx.arc(cursor.x, cursor.y, (hi.size || 46) / 2, 0, Math.PI * 2);
      ctx.fillStyle = hi.color || '#ef4444';
      ctx.globalAlpha = hi.opacity ?? 0.32;
      ctx.fill();
      ctx.globalAlpha = 1;
    }
    ctx.restore();
  };

  recording = { cancel: null, cleanup: () => window.removeEventListener('pointermove', track) };
  try {
    const { blob, ext } = await recordRange(v, mergeRecordOpts(game.grade, {
      from: null,
      to: null,
      crop,
      paint,
      audio: 'video',
      mic,
      onFrame: () => { if (recording?.stopRequested) throw 0; },
    }));
    await deliver(game, blob, `${fileStem(st.naming, namingFor(game, v.currentTime))}-analysis.${ext}`);
  } catch (e) {
    if (e) { console.error(e); toast(e.message || 'Recording Failed', true); }
  }
  for (const t of mic?.getTracks() || []) t.stop();
  recording?.cleanup();
  recording = null;
}

function stopRecord() {
  if (!recording) return;
  recording.stopRequested = true;
  video().pause();
}

async function deliverFrame(game, canvas) {
  const st = playerSettings() || await getSettings();
  const blob = await new Promise((res) => canvas.toBlob(res, 'image/png'));
  await deliver(game, blob, `${fileStem(st.naming, namingFor(game, video().currentTime))}-frame.png`);
}

// ------------------------------------------------------------- settings
//
// One sheet for everything the app lets Tony set. It writes the SAME
// settings record the panel editor uses (store.js, additive only), so a
// field added here is a field every future session inherits.

const NAME_TOKENS = [
  ['{name}', 'the clip name'],
  ['{tags}', 'its tags, in log order, joined by -'],
  ['{hhmmss}', 'its timecode'],
  ['{label}', 'the button that made it'],
  ['{date}', "today's date"],
];

// ONE tooltip node for the whole app, positioned in the viewport and clamped
// so it is always fully on screen. A pseudo-element could not be: the
// settings body scrolls, so anything inside it is cropped at the edges.
let csTip = null;
function showTip(anchor) {
  if (!csTip) {
    csTip = document.createElement('div');
    csTip.className = 'cs-tip';
    document.body.appendChild(csTip);
  }
  csTip.textContent = anchor.dataset.tip || '';
  csTip.classList.add('on');
  // Park it at the origin first so the measurement is of THIS text at THIS
  // width - reading the rect while the node still sits at its last position
  // gives the previous tip's height, which is what put one of these 12px off
  // the top of the screen.
  csTip.style.left = '0px';
  csTip.style.top = '0px';
  const a = anchor.getBoundingClientRect();
  const t = csTip.getBoundingClientRect();
  const pad = 8;
  const clamp = (v, max) => Math.max(pad, Math.min(v, max - pad));
  // Above by default, below when there is no room - then CLAMPED either way,
  // so no arithmetic mistake can put it off screen.
  const above = a.top - t.height - 10;
  csTip.style.top = `${clamp(above > pad ? above : a.bottom + 10, window.innerHeight - t.height)}px`;
  csTip.style.left = `${clamp(a.left + a.width / 2 - t.width / 2, window.innerWidth - t.width)}px`;
}
function hideTip() { csTip?.classList.remove('on'); }

const INFO_ICON = '<svg viewBox="0 0 24 24" width="13" height="13" fill="none" stroke="currentColor" stroke-width="1.9" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><circle cx="12" cy="12" r="8.5"/><path d="M12 11.2v5"/><path d="M12 7.9h.01"/></svg>';

const DEFAULT_POSITIONS = ['D1', 'D2', 'C', 'W1', 'W2', 'F1', 'F2', 'F3'];

// Every tool that carries a look, in toolbar order.
const TOOL_STYLE_ROWS = [
  ['pen', 'Pen'],
  ['arrow', 'Arrow'],
  ['line', 'Line'],
  ['freearrow', 'Freeform Arrow'],
  ['box', 'Box'],
  ['circle', 'Circle'],
  ['spotlight', 'Spotlight'],
  ['pos', 'Position Chip'],
];

export async function openClipSettings(focus = null) {
  const s = playerSettings() || await getSettings();
  document.querySelector('.sheet-veil')?.remove();
  const veil = document.createElement('div');
  veil.className = 'sheet-veil';
  // EVERY DESCRIPTION IS A HOVER TOOLTIP (2026-08-29, Tony's call). A settings
  // sheet that prints its own explanations is twice as tall and reads as
  // documentation; the glyph keeps the sheet scannable and the words one
  // hover away.
  const info = (t) => (t ? `<span class="cs-info" tabindex="0" role="note" aria-label="${esc(t)}" data-tip="${esc(t)}">${INFO_ICON}</span>` : '');
  const num = (k, label, v, min, max, hint = '') => `
    <label class="bs-row"><span>${label}${info(hint)}</span>
      <input type="number" data-k="${k}" value="${v}" min="${min}" max="${max}">
    </label>`;
  const check = (k, label, on, hint = '') => `
    <label class="bs-row"><span>${label}${info(hint)}</span>
      <input type="checkbox" data-k="${k}"${on ? ' checked' : ''}>
    </label>`;
  const seg = (k, label, opts, cur, hint = '') => `
    <label class="bs-row"><span>${label}${info(hint)}</span>
      <span class="an-seg" role="group">${opts.map(([val, txt]) =>
        `<button type="button" class="an-segbtn${cur === val ? ' on' : ''}" data-seg="${k}" data-val="${val}">${txt}</button>`).join('')}</span>
    </label>`;
  veil.innerHTML = `
    <div class="sheet sheet-pe cs-sheet" role="dialog" aria-modal="true">
      <div class="pe-top">
        <h3>Clips Settings</h3>
        <p>Everything here is remembered with this library, not with one video.</p>
      </div>
      <div class="pe-body">
        <section class="pe-section">
          <div class="pe-title">Export</div>
          <label class="bs-row"><span>File Name${info(`Tokens: ${NAME_TOKENS.map(([t, w]) => `${t} is the ${w}`).join(', ')}. An empty token collapses without leaving the dash that joined it.`)}</span>
            <input type="text" data-k="naming" value="${esc(s.naming)}" spellcheck="false">
          </label>
          ${num('freezeBuf.before', 'Freeze In', s.freezeBuf.before, 0, 60, 'seconds before the playhead')}
          ${num('freezeBuf.after', 'Freeze Out', s.freezeBuf.after, 1, 120, 'seconds after')}
          ${num('holdSec', 'Freeze Hold', s.holdSec, 1, 15, 'how long the frame holds')}
          ${num('pullBuf.before', 'Pull In', s.pullBuf.before, 0, 60, 'seconds before the playhead')}
          ${num('pullBuf.after', 'Pull Out', s.pullBuf.after, 1, 120, 'seconds after')}
        </section>
        <section class="pe-section">
          <div class="pe-title">Drawing</div>
          ${check('autoSelect', 'Back To Select After Drawing', s.autoSelect !== false,
            'After you draw or place something, the Select tool arms again so you can move it. Turn this off to keep the tool armed for repeated marks.')}
          ${seg('exportKind', 'Export Button Writes', [['clip', 'Clip'], ['png', 'PNG']], s.exportKind || 'clip',
            'What the toolbar Export button produces: the held video clip, or a PNG of the annotated frame. Nothing is ever written until you press Export.')}
          ${num('holdSec', 'Default Hold', s.holdSec, 1, 15, 'How long an exported freeze holds on the frame, in seconds.')}
          ${seg('shapeStyle', 'Boxes And Circles', [['fill', 'Fill'], ['outline', 'Outline']], s.shapeStyle || 'fill',
            'A light wash reads well over plain ice; a solid outline reads better over a busy frame. This used to be a pair of buttons on the toolbar, which was the only text control in a row of glyphs.')}
          ${num('textSize', 'Caption Size', s.textSize ?? 34, 14, 90, 'Telestration text size, measured on a 1280-wide frame so it looks the same on any clip.')}
          <label class="bs-row"><span>Colour Presets${info('The three swatches on the annotation toolbar. Any of them can be any colour, here or by right-clicking the swatch itself.')}</span>
            <span class="cs-swatches">${(s.colorPresets || ['#1e1e1e', '#75d8ff', '#d9d9d9']).map((hex, i) =>
              `<input type="color" data-k="colorPresets.${i}" value="${esc(hex)}" aria-label="Colour ${i + 1}">`).join('')}</span>
          </label>
        </section>
        <section class="pe-section">
          <div class="pe-title">Panels${info('One height each, because a dense tag column and a comfortable roster are different decisions.')}</div>
          ${num('btnH.clip', 'Clip Buttons', (s.btnH || {}).clip ?? 28, 20, 48, 'pixels tall')}
          ${num('btnH.tag', 'Tag Buttons', (s.btnH || {}).tag ?? 28, 20, 48, 'pixels tall')}
          ${num('btnH.player', 'Player Buttons', (s.btnH || {}).player ?? 28, 20, 48, 'pixels tall')}
          
        </section>
        <section class="pe-section">
          <div class="pe-title">Telestration Tools${info('Thickness is measured on a 1280-wide frame and scales with the video, so 8 looks the same on any clip. A style applies to NEW drawings; anything already drawn keeps the look it was drawn with.')}</div>
          <div class="cs-toolhead"><span></span><span>Colour</span><span>Thickness</span><span>Dashed</span></div>
          ${TOOL_STYLE_ROWS.map(([k, label]) => {
            const t = (s.toolStyle || {})[k] || {};
            return `<label class="bs-row cs-toolrow"><span>${label}</span>
              <input type="color" data-k="toolStyle.${k}.color" value="${esc(t.color || '#ff3b30')}" aria-label="${label} Colour">
              <input type="number" data-k="toolStyle.${k}.width" value="${t.width ?? 8}" min="1" max="40" aria-label="${label} Thickness">
              <input type="checkbox" data-k="toolStyle.${k}.dash"${t.dash ? ' checked' : ''} aria-label="${label} Dashed">
            </label>`;
          }).join('')}
          <label class="bs-row"><span>Position Chips</span>
            <input type="text" data-k="positionsCsv" value="${esc((s.positions || []).join(', '))}" spellcheck="false">
          </label>
          
        </section>
        <section class="pe-section">
          <div class="pe-title">Recording</div>
          <label class="bs-row"><span>Highlight Cursor</span>
            <input type="checkbox" data-k="cursorHi.on"${s.cursorHi.on ? ' checked' : ''}>
          </label>
          <label class="bs-row"><span>Highlight Colour</span>
            <input type="color" data-k="cursorHi.color" value="${esc(s.cursorHi.color)}">
          </label>
          ${num('cursorHi.size', 'Highlight Size', s.cursorHi.size, 16, 120, 'pixels across')}
        </section>
        <section class="pe-section">
          <div class="pe-title">Scrubbing</div>
          ${num('scrubSensitivity', 'Sensitivity', s.scrubSensitivity || 1, 1, 400, 'percent of normal, 100 is default')}
          <label class="bs-row"><span>Reverse Direction</span>
            <input type="checkbox" data-k="scrubReverse"${s.scrubReverse ? ' checked' : ''}>
          </label>
        </section>
      </div>
      <div class="sheet-row pe-foot">
        <span class="vp-flex"></span>
        <button class="btn" data-x="cancel">Cancel</button>
        <button class="btn btn-ink" data-x="save">Save Settings</button>
      </div>
    </div>`;
  document.body.appendChild(veil);

  // THE ROSTER IS NOT EDITED HERE ANY MORE (2026-08-29, Tony's call): it
  // moved to an Edit Players button at the foot of the Players column, beside
  // the thing it edits. `next` spreads the current settings, so `players`
  // carries through this sheet untouched.

  const close = () => { hideTip(); veil.remove(); };
  veil.addEventListener('mousedown', (e) => { if (e.target === veil) close(); });
  veil.querySelector('[data-x="cancel"]').onclick = close;
  for (const i of veil.querySelectorAll('.cs-info')) {
    i.onpointerenter = () => showTip(i);
    i.onfocus = () => showTip(i);
    i.onpointerleave = hideTip;
    i.onblur = hideTip;
  }
  // Segmented rows carry their value on the pressed button.
  const segVals = {};
  for (const b of veil.querySelectorAll('[data-seg]')) {
    b.onclick = () => {
      segVals[b.dataset.seg] = b.dataset.val;
      for (const o of veil.querySelectorAll(`[data-seg="${b.dataset.seg}"]`)) o.classList.toggle('on', o === b);
    };
  }
  veil.querySelector('[data-x="save"]').onclick = async () => {
    const next = { ...s };
    veil.querySelectorAll('[data-k]').forEach((i) => {
      const raw = i.type === 'checkbox' ? i.checked
        : i.type === 'number' ? Math.max(Number(i.min), Math.min(Number(i.max), Number(i.value) || Number(i.min)))
        : i.value;
      // Dotted keys write into their nested object.
      const path = i.dataset.k.split('.');
      // An array index must not turn its array into an object, which the
      // generic `{ ...node[k] }` spread below would do.
      if (path[0] === 'colorPresets') {
        next.colorPresets = [...(next.colorPresets || ['#ff3b30', '#ffd60a', '#0a84ff'])];
        next.colorPresets[Number(path[1])] = raw;
        return;
      }
      let node = next;
      while (path.length > 1) { const k = path.shift(); node[k] = { ...(node[k] || {}) }; node = node[k]; }
      node[path[0]] = raw;
    });
    // A player with no first name is nothing to tag with.
    Object.assign(next, segVals);
    // The position chips arrive as one comma-separated field; store the list
    // and drop the scratch key so it never lands in the record.
    if (next.positionsCsv != null) {
      const list = String(next.positionsCsv).split(',').map((x) => x.trim()).filter(Boolean).slice(0, 12);
      next.positions = list.length ? list : DEFAULT_POSITIONS;
      delete next.positionsCsv;
    }
    await putSettings(next);
    const live = playerSettings();
    if (live) Object.assign(live, next);
    close();
    toast('Settings Saved');
    paintBar();
    // A freeze open behind the sheet takes the new styles immediately.
    applyToolStyle(next);
    applyBtnHeights(next.btnH);
  };
}

(async () => {
  await fsInit().catch(() => false);
  await go();
})();
