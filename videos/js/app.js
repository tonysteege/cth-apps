// CTH Videos - the shell. A library of everything Tony has uploaded, an
// upload sheet that takes a 10 GB game as happily as a 10 second clip, and a
// detail view that plays with the CTH scrub feel and hands out the links.
//
// ROUTES are hashes: `#/` is the library, `#/v/<id>` is one video. The public
// share page is watch.html, not a route here, so a link sent to a parent
// never opens the library chrome.

import * as api from './api.js';
import { mountPlayer } from './player.js';
import { h, el, toast, sheet, confirmSheet, promptSheet, progress, icon, ICONS, bytes, tc } from '../../studio/js/ui.js';

const STUDIO = '../studio/';
const CLIPS_NOTION = '../clips-notion/embed.html';

const app = () => el('app');
const go = (hash) => { location.hash = hash; };

let cache = null;      // the index, once fetched
let player = null;     // the mounted player in the detail view

boot();

function boot() {
  window.addEventListener('hashchange', route);
  route();
}

function route() {
  if (player) { player.destroy(); player = null; }
  const hash = location.hash.replace(/^#\/?/, '');
  const m = hash.match(/^v\/([a-z0-9]{8,16})/);
  if (m) { renderDetail(m[1]); return; }
  renderLibrary();
}

// ---- chrome ----------------------------------------------------------------

function topbar(...extra) {
  return h('header', { class: 'topbar' },
    h('a', { class: 'brand', href: '../', title: 'CTH Apps' },
      h('img', { src: 'favicon.png', alt: '' }),
      h('span', { text: 'Videos' })),
    h('div', { class: 'grow' }),
    ...extra,
    h('button', { class: 'icon-btn', title: 'Settings', 'aria-label': 'Settings', onclick: settingsSheet }, icon(ICONS.gear)));
}

// The key is asked for once, the first time a write is refused, and kept.
async function needKey(message = 'Enter your CTH Videos key to manage the library.') {
  const k = await promptSheet('Videos key', 'Key', api.getKey(), { ok: 'Save', placeholder: 'Paste the key' });
  if (k) { api.setKey(k); toast('Key saved.', 'ok'); return true; }
  if (message) toast(message, 'warn');
  return false;
}

async function guarded(fn) {
  try { return await fn(); } catch (e) {
    if (api.isAuthError(e)) { if (await needKey()) return guarded(fn); return null; }
    toast(e.message || 'Something went wrong.', 'error', 6000);
    return null;
  }
}

// ---- library ---------------------------------------------------------------

async function renderLibrary() {
  const main = h('div', { class: 'lib-main' });
  const search = h('input', { class: 'input vl-search', type: 'search', placeholder: 'Search videos', 'aria-label': 'Search videos' });
  const root = h('div', { id: 'app' },
    topbar(
      search,
      h('button', { class: 'btn primary', onclick: () => uploadSheet() }, icon(ICONS.export), 'Upload')),
    h('div', { class: 'lib vl-lib' }, main));
  app().replaceWith(root);

  const drop = makeDropTarget(root);
  root.appendChild(drop);

  if (!cache) {
    main.appendChild(h('div', { class: 'empty-state', text: 'Loading' }));
    cache = await guarded(api.list);
    if (!cache) {
      cache = null;
      main.replaceChildren(h('div', { class: 'empty-state' },
        h('h2', { text: 'The library needs your key' }),
        h('p', { text: 'CTH Videos is private. Enter the key once and this browser keeps it.' }),
        h('button', { class: 'btn primary', onclick: async () => { if (await needKey('')) { cache = null; renderLibrary(); } } }, 'Enter key')));
      return;
    }
  }
  const paint = () => renderCards(main, filterList(cache, search.value));
  search.addEventListener('input', paint);
  paint();
}

function filterList(list, q) {
  const s = (q || '').trim().toLowerCase();
  if (!s) return list;
  return list.filter((v) => `${v.name} ${v.fileName || ''}`.toLowerCase().includes(s));
}

function renderCards(host, list) {
  host.replaceChildren();
  host.appendChild(h('div', { class: 'row', style: { marginBottom: '12px' } },
    h('h1', { text: 'Your videos' }),
    h('span', { class: 'vl-count', text: String(list.length) }),
    h('div', { class: 'grow' })));
  if (!list.length) {
    host.appendChild(h('div', { class: 'empty-state' },
      h('h2', { text: cache && cache.length ? 'No matches' : 'Nothing here yet' }),
      h('p', { text: cache && cache.length ? 'Try a different search.' : 'Drop a video anywhere on this page, or press Upload. Files go up untouched, at full quality, however large they are.' })));
    return;
  }
  const grid = h('div', { class: 'cards' });
  for (const v of list) {
    const card = h('button', { class: 'card', onclick: () => go(`#/v/${v.id}`) },
      v.poster
        ? h('img', { class: 'thumb', src: api.posterUrl(v), alt: '', loading: 'lazy' })
        : h('div', { class: 'thumb empty' }, icon(ICONS.film, 26)),
      v.duration ? h('span', { class: 'vl-dur', text: tc(v.duration, false) }) : null,
      h('div', { class: 'meta' },
        h('b', { text: v.name }),
        h('div', { class: 'small muted', text: [bytes(v.size), v.width ? `${v.width}x${v.height}` : '', new Date(v.created).toLocaleDateString()].filter(Boolean).join(' · ') })));
    card.addEventListener('contextmenu', (e) => { e.preventDefault(); videoMenu(v); });
    grid.appendChild(card);
  }
  host.appendChild(grid);
}

async function videoMenu(v) {
  const what = await sheet(v.name, (body, close) => {
    const item = (label, kind, danger) => h('button', {
      class: `btn ${danger ? 'danger' : ''}`, style: { width: '100%', justifyContent: 'flex-start', marginBottom: '6px' }, onclick: () => close(kind),
    }, label);
    body.appendChild(item('Open', 'open'));
    body.appendChild(item('Copy share link', 'share'));
    body.appendChild(item('Rename', 'rename'));
    body.appendChild(item('Delete', 'del', true));
  });
  if (what === 'open') go(`#/v/${v.id}`);
  if (what === 'share') copy(api.watchUrl(v), 'Share link copied.');
  if (what === 'rename') await rename(v);
  if (what === 'del') await destroy(v);
}

async function rename(v) {
  const name = await promptSheet('Rename', 'Name', v.name);
  if (!name || name === v.name) return false;
  const r = await guarded(() => api.patch(v.id, { name }));
  if (!r) return false;
  v.name = name;
  if (cache) { const i = cache.find((x) => x.id === v.id); if (i) i.name = name; }
  toast('Renamed.', 'ok');
  return true;
}

async function destroy(v) {
  const ok = await confirmSheet('Delete this video?', `"${v.name}" and its share links stop working for everyone. This cannot be undone.`, { danger: true, ok: 'Delete' });
  if (!ok) return false;
  const r = await guarded(() => api.remove(v.id));
  if (!r) return false;
  if (cache) cache = cache.filter((x) => x.id !== v.id);
  toast('Deleted.');
  if (location.hash.includes(v.id)) go('#/'); else route();
  return true;
}

async function copy(text, note = 'Copied.') {
  try { await navigator.clipboard.writeText(text); toast(note, 'ok'); }
  catch (_) { await promptSheet('Copy this link', 'Link', text, { ok: 'Done' }); }
}

// ---- upload ----------------------------------------------------------------

// A whole-page drop target: the library is a place you throw film at.
function makeDropTarget(root) {
  const veil = h('div', { class: 'vl-dropveil', 'aria-hidden': 'true' }, h('div', { class: 'vl-dropcard' }, icon(ICONS.export, 28), h('b', { text: 'Drop to upload' })));
  let depth = 0;
  root.addEventListener('dragenter', (e) => { if (!hasFiles(e)) return; e.preventDefault(); depth++; veil.classList.add('on'); });
  root.addEventListener('dragover', (e) => { if (!hasFiles(e)) return; e.preventDefault(); });
  root.addEventListener('dragleave', (e) => { if (!hasFiles(e)) return; depth = Math.max(0, depth - 1); if (!depth) veil.classList.remove('on'); });
  root.addEventListener('drop', (e) => {
    if (!hasFiles(e)) return;
    e.preventDefault(); depth = 0; veil.classList.remove('on');
    const files = [...e.dataTransfer.files].filter(isVideo);
    if (!files.length) { toast('That is not a video file.', 'warn'); return; }
    uploadSheet(files);
  });
  return veil;
}
const hasFiles = (e) => [...(e.dataTransfer?.types || [])].includes('Files');
const isVideo = (f) => /^video\//.test(f.type) || /\.(mp4|mov|m4v|webm|mkv)$/i.test(f.name);

async function uploadSheet(preset = []) {
  if (!api.getKey() && !(await needKey())) return;
  let files = [...preset];
  await sheet('Upload videos', (body, close) => {
    const input = h('input', { type: 'file', accept: 'video/*,.mp4,.mov,.m4v,.webm', multiple: true, hidden: true });
    const list = h('div', { class: 'vl-files' });
    const drop = h('button', { class: 'up-drop', type: 'button', onclick: () => input.click() },
      h('span', { class: 'up-drop-ic' }, icon(ICONS.export, 20)),
      h('span', { class: 'up-drop-main', text: 'Choose videos or drop them here' }),
      h('span', { class: 'up-drop-sub', text: 'Any size. The file is stored exactly as it is, no re-encoding.' }));
    drop.addEventListener('dragover', (e) => { e.preventDefault(); drop.classList.add('over'); });
    drop.addEventListener('dragleave', () => drop.classList.remove('over'));
    drop.addEventListener('drop', (e) => { e.preventDefault(); drop.classList.remove('over'); add([...e.dataTransfer.files]); });
    input.addEventListener('change', () => { add([...input.files]); input.value = ''; });
    const paintList = () => {
      list.replaceChildren(...files.map((f, i) => h('div', { class: 'vl-file' },
        h('span', { class: 'grow', text: f.name }),
        h('span', { class: 'small muted', text: bytes(f.size) }),
        h('button', { class: 'icon-btn', 'aria-label': 'Remove', onclick: () => { files.splice(i, 1); paintList(); } }, '×'))));
      drop.classList.toggle('has-file', files.length > 0);
      startBtn.disabled = !files.length;
    };
    const add = (fs) => { for (const f of fs) if (isVideo(f) && !files.some((x) => x.name === f.name && x.size === f.size)) files.push(f); paintList(); };
    const startBtn = h('button', { class: 'btn primary', onclick: () => close(true) }, 'Upload');
    body.append(drop, input, list,
      h('p', { class: 'tiny muted', style: { marginTop: '10px' }, text: 'Keep this tab open until the upload finishes. A 5 GB file takes as long as your connection allows; nothing is lost if one part has to retry.' }),
      h('div', { class: 'row end' }, h('button', { class: 'btn', onclick: () => close(false) }, 'Cancel'), startBtn));
    paintList();
  }).then(async (go2) => {
    if (!go2 || !files.length) return;
    await runUploads(files);
  });
}

async function runUploads(files) {
  const bar = progress(files.length === 1 ? `Uploading ${files[0].name}` : `Uploading ${files.length} videos`);
  const doneSize = files.reduce((a, f) => a + f.size, 0);
  let before = 0;
  let last = null;
  try {
    for (const f of files) {
      if (bar.signal.aborted) break;
      const v = await api.upload(f, {
        signal: bar.signal,
        onProgress: (frac, note) => bar.set((before + frac * f.size) / doneSize, files.length === 1 ? note : `${note} ${f.name}`),
      });
      before += f.size;
      last = v;
      if (cache) { cache = cache.filter((x) => x.id !== v.id); cache.unshift(v); }
    }
    bar.close();
    if (last) {
      toast(files.length === 1 ? 'Uploaded.' : `${files.length} videos uploaded.`, 'ok');
      cache = null;
      if (files.length === 1) go(`#/v/${last.id}`); else renderLibrary();
    }
  } catch (e) {
    bar.close();
    if (e.name === 'AbortError') { toast('Upload cancelled.'); cache = null; renderLibrary(); return; }
    if (api.isAuthError(e)) { if (await needKey()) return runUploads(files); return; }
    toast(e.message || 'The upload failed.', 'error', 7000);
    cache = null; renderLibrary();
  }
}

// ---- one video -------------------------------------------------------------

async function renderDetail(id) {
  const stageHost = h('div', { class: 'vd-player' });
  const side = h('aside', { class: 'vd-side' });
  const title = h('span', { class: 'title', text: '' });
  const root = h('div', { id: 'app' },
    topbar(),
    h('div', { class: 'vd' }, stageHost, side));
  const bar = root.querySelector('.topbar');
  bar.insertBefore(h('button', { class: 'btn ghost', onclick: () => go('#/') }, icon(ICONS.back), 'Library'), bar.children[1]);
  bar.insertBefore(title, bar.children[2]);
  app().replaceWith(root);

  let v = cache?.find((x) => x.id === id) || null;
  try { v = await api.get(id); } catch (e) {
    if (!v) { toast('That video is not in the library.', 'warn'); go('#/'); return; }
  }
  title.textContent = v.name;
  document.title = `${v.name} - CTH Videos`;

  player = mountPlayer(stageHost, {
    url: api.fileUrl(v), id: v.id, title: v.name, poster: api.posterUrl(v),
    onError: () => toast('This browser cannot play that file. HEVC files need a browser with hardware HEVC support (Safari, and Chrome on most recent machines).', 'warn', 8000),
  });

  const share = api.watchUrl(v);
  const file = api.fileUrl(v);
  const studio = `${STUDIO}#/new?url=${encodeURIComponent(file)}&name=${encodeURIComponent(v.name)}`;
  const clips = `${CLIPS_NOTION}#src=${encodeURIComponent(file)}&mode=edit`;

  const linkRow = (label, value, note) => {
    const i = h('input', { class: 'input', value, readonly: true });
    i.addEventListener('focus', () => i.select());
    return h('div', { class: 'vd-link' },
      h('div', { class: 'small', style: { fontWeight: '600', marginBottom: '2px' }, text: label }),
      h('div', { class: 'tiny muted', style: { marginBottom: '5px' }, text: note }),
      h('div', { class: 'row' }, i, h('button', { class: 'btn mini', onclick: () => copy(value) }, 'Copy')));
  };

  side.replaceChildren(
    h('section', {},
      h('h3', { text: 'Share' }),
      linkRow('Share link', share, 'For players and parents, and for a Notion embed block. Opens the player, nothing else.'),
      linkRow('Direct file', file, 'The video itself. Plays in a browser, attaches to a message, downloads.'),
      h('div', { class: 'row wrap', style: { marginTop: '6px' } },
        h('button', { class: 'btn primary', onclick: () => copy(share, 'Share link copied.') }, icon(ICONS.copy), 'Copy share link'),
        h('a', { class: 'btn', href: file, download: v.fileName || '', target: '_blank', rel: 'noopener' }, 'Download'))),
    h('section', {},
      h('h3', { text: 'Work on it' }),
      h('div', { class: 'row wrap' },
        h('a', { class: 'btn', href: studio, target: '_blank', rel: 'noopener' }, 'Open in Studio'),
        h('a', { class: 'btn', href: clips, target: '_blank', rel: 'noopener' }, 'Open in Clips Notion')),
      h('p', { class: 'tiny muted', style: { marginTop: '8px' }, text: 'Studio makes a telestrated analysis video from this file. Clips Notion tags and marks it up in the browser. Both read the file from here; nothing is copied.' })),
    h('section', {},
      h('h3', { text: 'Details' }),
      details(v),
      h('div', { class: 'row wrap', style: { marginTop: '10px' } },
        h('button', { class: 'btn', onclick: async () => { if (await rename(v)) { title.textContent = v.name; side.querySelector('.vd-name').textContent = v.name; } } }, 'Rename'),
        h('button', { class: 'btn', onclick: () => refreshPoster(v) }, 'Set poster from this frame'),
        h('button', { class: 'btn danger', onclick: () => destroy(v) }, icon(ICONS.trash), 'Delete'))),
    h('section', {},
      h('h3', { text: 'Scrub' }),
      h('p', { class: 'tiny muted', text: 'Two fingers left and right on the trackpad scrubs, frame by frame when slow and across minutes when fast. On a tablet, drag on the picture. Arrow keys step one frame; Shift steps one second; J and L jump five seconds; space plays.' })));
}

function details(v) {
  const rows = [
    ['Name', v.name, 'vd-name'],
    ['File', v.fileName || ''],
    ['Size', bytes(v.size)],
    ['Length', v.duration ? tc(v.duration, false) : 'Unknown'],
    ['Frame', v.width ? `${v.width}x${v.height}` : 'Unknown'],
    ['Type', v.type || ''],
    ['Added', new Date(v.created).toLocaleString()],
  ];
  return h('dl', { class: 'vd-dl' }, ...rows.map(([k, val, cls]) => [h('dt', { text: k }), h('dd', { class: cls || '', text: val })]).flat());
}

// The current frame of the player becomes the card image.
async function refreshPoster(v) {
  if (!player) return;
  const vid = player.video;
  if (!vid.videoWidth) { toast('The picture has not loaded yet.', 'warn'); return; }
  try {
    const c = document.createElement('canvas');
    const w = Math.min(640, vid.videoWidth);
    c.width = w; c.height = Math.round(w * vid.videoHeight / vid.videoWidth);
    c.getContext('2d').drawImage(vid, 0, 0, c.width, c.height);
    const blob = await new Promise((res) => c.toBlob(res, 'image/jpeg', 0.82));
    const ok = await guarded(() => api.setPoster(v.id, blob));
    if (ok !== null) { v.poster = true; cache = null; toast('Poster updated.', 'ok'); }
  } catch (e) {
    toast('Could not read the frame. Try after the video has played once.', 'warn');
  }
}

// ---- settings --------------------------------------------------------------

async function settingsSheet() {
  await sheet('Settings', (body, close) => {
    const keyInput = h('input', { class: 'input', type: 'password', value: api.getKey(), placeholder: 'The CTH Videos key' });
    body.appendChild(h('label', { class: 'field' }, h('span', { text: 'Videos key' }), keyInput));
    body.appendChild(h('p', { class: 'tiny muted' }, 'The key lets this browser upload, rename and delete. Share links and the player never need it. It is the VIDEOS_KEY secret on the cth-present-api Worker.'));
    body.appendChild(h('p', { class: 'tiny muted' }, 'Storage: Cloudflare R2, bucket cth-videos. Files are kept byte for byte; nothing is re-encoded.'));
    body.appendChild(h('div', { class: 'row end' },
      h('button', { class: 'btn', onclick: () => close(null) }, 'Cancel'),
      h('button', { class: 'btn primary', onclick: () => { api.setKey(keyInput.value.trim()); cache = null; close(true); toast('Saved.', 'ok'); route(); } }, 'Save')));
  });
}
