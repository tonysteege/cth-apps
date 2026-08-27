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
} from './player.js';
import { openAnnotate } from './annotate.js';
import { toast, esc, confirmSheet, fmtDate } from './ui.js';
import { putDrill, uid as drillUid } from '/diagrams/js/store.js';

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
          <span class="ed-sep"></span>
          <button class="btn" id="vpSettings" title="Clips Settings">Settings</button>
          <button class="btn" id="vpLogBtn" title="Show Or Hide The Clip Log">Clips</button>
          <button class="btn" id="vpSideBtn" title="Show Or Hide The Tag Panel">Tags</button>
        </div>
      </header>
      <div class="vp-main">
        <section class="vp-log" id="vpLog"></section>
        <div class="vp-grip" id="vpGripLog" title="Drag To Resize - Double-Click Resets"><span></span></div>
        <aside class="vp-side" id="vpSide"></aside>
        <div class="vp-grip" id="vpGripSide" title="Drag To Resize - Double-Click Resets"><span></span></div>
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
          <div class="vp-tlwrap">
            <canvas id="vpTimeline" class="vp-timeline"></canvas>
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
            </span>
            <span class="vp-tc vp-tc--r" id="vpTotal">0:00:00</span>
          </div>
        </div>
      </div>
    </div>`;

  $('#vpBack').onclick = () => { location.hash = '#/'; };
  $('#vpLogBtn').onclick = () => { document.querySelector('.vp').classList.toggle('log-hidden'); };
  $('#vpSideBtn').onclick = () => { document.querySelector('.vp').classList.toggle('side-hidden'); };
  $('#vpSettings').onclick = () => openClipSettings();
  // Wired for real in the export phase. A button that silently does
  // nothing is the dead control this suite keeps learning not to ship.
  $('#vpPull').onclick = () => toast('Pull Export Lands In The Next Phase', true);
  $('#vpRecord').onclick = () => toast('Record Lands In The Next Phase', true);
  wirePanels();

  await openPlayer(game, src, {
    onSettings: (focus) => openClipSettings(focus),
    // Every video now arrives as a real File, so the decoder always takes
    // its fast path: bytes sliced straight off the file, no range requests.
    scrubFile: localFiles.get(id) || null,
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


const status = null; // recordClip progress hook placeholder

// ------------------------------------------------------------- boot

window.addEventListener('hashchange', () => void go());

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

export async function openClipSettings(focus = null) {
  const s = playerSettings() || await getSettings();
  document.querySelector('.sheet-veil')?.remove();
  const veil = document.createElement('div');
  veil.className = 'sheet-veil';
  const num = (k, label, v, min, max, hint = '') => `
    <label class="bs-row"><span>${label}</span>
      <input type="number" data-k="${k}" value="${v}" min="${min}" max="${max}">
      ${hint ? `<em class="cs-hint">${hint}</em>` : ''}
    </label>`;
  veil.innerHTML = `
    <div class="sheet sheet-pe cs-sheet" role="dialog" aria-modal="true">
      <div class="pe-top">
        <h3>Clips Settings</h3>
        <p>Everything here is remembered with this library, not with one video.</p>
      </div>
      <div class="pe-body">
        <section class="pe-section">
          <div class="pe-title">Players</div>
          <div class="cs-players" data-players></div>
          <div class="bs-styleadd"><button class="mini" data-addplayer>+ Player</button></div>
          <p class="bs-note">A player's FIRST name becomes the tag. The key is one character, pressed inside the Players dialogue.</p>
        </section>
        <section class="pe-section">
          <div class="pe-title">Export</div>
          <label class="bs-row"><span>File Name</span>
            <input type="text" data-k="naming" value="${esc(s.naming)}" spellcheck="false">
          </label>
          <p class="bs-note">${NAME_TOKENS.map(([t, w]) => `<code>${t}</code> ${w}`).join(' &middot; ')}</p>
          ${num('freezeBuf.before', 'Freeze In', s.freezeBuf.before, 0, 60, 'seconds before the playhead')}
          ${num('freezeBuf.after', 'Freeze Out', s.freezeBuf.after, 1, 120, 'seconds after')}
          ${num('holdSec', 'Freeze Hold', s.holdSec, 1, 15, 'how long the frame holds')}
          ${num('pullBuf.before', 'Pull In', s.pullBuf.before, 0, 60, 'seconds before the playhead')}
          ${num('pullBuf.after', 'Pull Out', s.pullBuf.after, 1, 120, 'seconds after')}
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

  // ---- roster
  const box = veil.querySelector('[data-players]');
  let roster = (s.players || []).map((p) => ({ ...p }));
  const paintRoster = () => {
    box.innerHTML = roster.map((p) => `
      <div class="cs-player" data-pid="${esc(p.id)}">
        <input data-f="num" value="${esc(p.num || '')}" placeholder="#" maxlength="3" aria-label="Number">
        <input data-f="first" value="${esc(p.first || '')}" placeholder="First" aria-label="First Name">
        <input data-f="last" value="${esc(p.last || '')}" placeholder="Last" aria-label="Last Name">
        <input data-f="key" value="${esc(p.key || '')}" placeholder="Key" maxlength="1" aria-label="Shortcut Key">
        <button class="mini mini-danger" data-rm aria-label="Remove">&times;</button>
      </div>`).join('') || '<p class="bs-empty">No players yet.</p>';
    box.querySelectorAll('.cs-player').forEach((row) => {
      const p = roster.find((x) => x.id === row.dataset.pid);
      row.querySelectorAll('[data-f]').forEach((i) => {
        i.oninput = () => { p[i.dataset.f] = i.dataset.f === 'key' ? i.value.toLowerCase() : i.value; };
      });
      row.querySelector('[data-rm]').onclick = () => { roster = roster.filter((x) => x.id !== p.id); paintRoster(); };
    });
  };
  paintRoster();
  veil.querySelector('[data-addplayer]').onclick = () => {
    roster.push({ id: uid(), num: '', first: '', last: '', key: '' });
    paintRoster();
    box.querySelector('.cs-player:last-child [data-f="num"]')?.focus();
  };
  if (focus === 'players') box.scrollIntoView({ block: 'nearest' });

  const close = () => veil.remove();
  veil.addEventListener('mousedown', (e) => { if (e.target === veil) close(); });
  veil.querySelector('[data-x="cancel"]').onclick = close;
  veil.querySelector('[data-x="save"]').onclick = async () => {
    const next = { ...s };
    veil.querySelectorAll('[data-k]').forEach((i) => {
      const raw = i.type === 'checkbox' ? i.checked
        : i.type === 'number' ? Math.max(Number(i.min), Math.min(Number(i.max), Number(i.value) || Number(i.min)))
        : i.value;
      // Dotted keys write into their nested object.
      const path = i.dataset.k.split('.');
      let node = next;
      while (path.length > 1) { const k = path.shift(); node[k] = { ...(node[k] || {}) }; node = node[k]; }
      node[path[0]] = raw;
    });
    // A player with no first name is nothing to tag with.
    next.players = roster.filter((p) => (p.first || '').trim());
    await putSettings(next);
    const live = playerSettings();
    if (live) Object.assign(live, next);
    close();
    toast('Settings Saved');
    paintBar();
  };
}

(async () => {
  await fsInit().catch(() => false);
  await go();
})();
