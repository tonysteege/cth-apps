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
  dbxListFolder, dbxTempLink, dbxStreamLink, dbxUpload, VIDEO_ROOT, EXPORT_ROOT,
} from './dropbox.js';
import { listGames, getGame, putGame, deleteGame, getSettings, putSettings, uid } from './store.js';
import {
  openPlayer, closePlayer, playClip, recordClip, grabFrame, fmtTime, clipName,
  updateFreeze, playerGame, playerSettings, video,
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
      <div id="clibBrowser" class="clib-browser"><div class="clib-note">Loading…</div></div>
    </main>
    <input type="file" id="libFile" accept="video/mp4,video/quicktime,video/webm,.mp4,.mov,.m4v,.webm" hidden>`;

  $('#libHome').onclick = () => { location.href = '../'; };
  $('#libLocal').onclick = () => $('#libFile').click();
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
    const { folders, files, missing } = await dbxListFolder(browsePath);
    if (missing) {
      box.innerHTML = '<div class="clib-note">No "videos" Folder In Your Dropbox Yet - Create One And Drop Game Film In It.</div>';
      return;
    }
    box.innerHTML = `
      ${browsePath !== VIDEO_ROOT ? '<button class="clib-row clib-up" data-up>&larr; Up</button>' : ''}
      ${folders.map((f) => `
        <button class="clib-row" data-cd="${esc(f.path)}">
          <svg class="clib-ic" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8"><path d="M3 7a2 2 0 0 1 2-2h4l2 2h8a2 2 0 0 1 2 2v9a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2z"/></svg>
          <span>${esc(f.name)}</span>
        </button>`).join('')}
      ${files.map((f) => `
        <button class="clib-row clib-video" data-video="${esc(f.path)}" data-name="${esc(f.name)}">
          <svg class="clib-ic" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8"><rect x="3" y="5" width="18" height="14" rx="3"/><path d="m10 9 5 3-5 3z" fill="currentColor" stroke="none"/></svg>
          <span>${esc(f.name)}</span>
          <span class="clib-size">${(f.size / 1e9) >= 1 ? `${(f.size / 1e9).toFixed(1)} GB` : `${Math.round(f.size / 1e6)} MB`}</span>
        </button>`).join('')}
      ${!folders.length && !files.length ? '<div class="clib-note">This Folder Is Empty.</div>' : ''}`;
    box.querySelector('[data-up]')?.addEventListener('click', () => {
      browsePath = browsePath.split('/').slice(0, -1).join('/') || VIDEO_ROOT;
      void showLibrary();
    });
    box.querySelectorAll('[data-cd]').forEach((b) => b.addEventListener('click', () => { browsePath = b.dataset.cd; void showLibrary(); }));
    box.querySelectorAll('[data-video]').forEach((b) => b.addEventListener('click', async () => {
      const id = b.dataset.video;
      let g = await getGame(id);
      if (!g) {
        g = { id, name: b.dataset.name.replace(/\.[^.]+$/, ''), path: id, source: 'dropbox', clips: [], freezes: [] };
        await putGame(g);
      }
      location.hash = `#/v/${encodeURIComponent(id)}`;
    }));
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
            <span class="vp-hintkeys">Two-Finger Swipe Scrubs &middot; I/O Trim &middot; F Freeze</span>
          </div>
          <canvas id="vpTimeline" class="vp-timeline"></canvas>
          <div class="vp-tagbar" id="vpTagBar"></div>
        </div>
        <aside class="vp-log" id="vpLog"></aside>
      </div>
    </div>`;

  $('#vpBack').onclick = () => { location.hash = '#/'; };
  $('#vpLogBtn').onclick = () => { document.querySelector('.vp').classList.toggle('log-open'); };
  $('#vpEmail').onclick = () => openEmailSheet(game);

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
      await dbxUpload(`${EXPORT_ROOT}/${name}`, blob);
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
