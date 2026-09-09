// CTH STUDIO - the shell, the library, and the routing between them.
//
// WHAT THIS APP IS FOR. Clips logs film: it tags, clips and exports what
// happened. Studio PRODUCES: it takes one clip and turns it into the thing you
// actually send - freeze on the read, arrow on the seam, beam on the four
// players in the box, punch in, slow it down, name it, publish it. Two jobs,
// two apps, one folder.
//
// ROUTES are hashes, so a project is a link that survives a reload and can be
// pasted anywhere:
//   #/           the library
//   #/p/<id>     a project
//   #/new?path=  a new project on a Dropbox path

import * as dbx from './dropbox.js';
import * as lfs from '../../clips/js/localfs.js';
import * as store from './store.js';
import { el, h, toast, fail, sheet, confirmSheet, promptSheet, icon, ICONS, bytes, tc } from './ui.js';
import { openEditor, closeEditor } from './editor.js';

const app = () => el('app');
let booted = false;

// ---- boot ------------------------------------------------------------------

async function boot() {
  if (booted) return;
  booted = true;
  // The local CTH folder is a File System Access handle remembered in
  // IndexedDB, on the SAME origin as Clips - so a folder connected in either
  // app is already live here, and film browses without a second pick. This
  // never prompts; a lapsed permission just shows a Reconnect button.
  try { await lfs.fsInit(); } catch (_) {}
  try {
    if (await dbx.finishAuth()) toast('Dropbox connected.', 'ok');
  } catch (e) { fail(e); }
  window.addEventListener('hashchange', route);
  route();
}

function route() {
  const hash = location.hash.replace(/^#\/?/, '');
  const [head, ...rest] = hash.split('/');
  closeEditor();
  if (head === 'p' && rest[0]) { openProject(rest[0]); return; }
  if (head === 'new') { newFromQuery(hash); return; }
  renderLibrary();
}

const go = (h2) => { location.hash = h2; };

// ---- chrome ----------------------------------------------------------------

function topbar(...extra) {
  return h('header', { class: 'topbar' },
    h('a', { class: 'brand', href: '../', title: 'CTH Apps' },
      h('img', { src: 'favicon.png', alt: '' }),
      h('span', { text: 'Studio' })),
    h('div', { class: 'grow' }),
    ...extra,
    h('button', { class: 'icon-btn', title: 'Settings', 'aria-label': 'Settings', onclick: settingsSheet }, icon(ICONS.gear)));
}

// ---- library ---------------------------------------------------------------

let browsePath = null;

async function renderLibrary() {
  const main = h('div', { class: 'lib-main' });
  const side = h('aside', { class: 'lib-side' });
  const root = h('div', { id: 'app' },
    topbar(
      h('button', { class: 'btn', onclick: openLocal }, icon(ICONS.film), 'Open a file'),
      h('button', { class: 'btn hide-phone', onclick: openByUrl }, 'Open a link'),
      h('button', { class: 'btn primary', onclick: () => { browsePath = null; renderLibrary(); side.scrollIntoView({ behavior: 'smooth' }); } },
        icon(ICONS.plus), 'New from film')),
    h('div', { class: 'lib' }, main, side));
  app().replaceWith(root);

  await Promise.all([renderProjects(main), renderBrowser(side)]);
}

async function renderProjects(host) {
  host.replaceChildren(h('div', { class: 'row', style: { marginBottom: '12px' } },
    h('h1', { text: 'Your videos' }),
    h('div', { class: 'grow' })));

  let list = [];
  try { list = await store.all(); } catch (e) { fail(e); }

  if (!list.length) {
    host.appendChild(h('div', { class: 'empty-state' },
      h('h2', { text: 'Nothing here yet' }),
      h('p', { text: 'Pick a game from the panel to the right, or open a file from this device. Studio never uploads your film; it reads it where it already lives.' })));
    return;
  }

  const grid = h('div', { class: 'cards' });
  for (const p of list) {
    const card = h('button', { class: 'card', onclick: () => go(`#/p/${p.id}`) },
      p.thumb
        ? h('img', { class: 'thumb', src: p.thumb, alt: '', loading: 'lazy' })
        : h('div', { class: 'thumb empty' }, icon(ICONS.film, 26)),
      h('div', { class: 'meta' },
        h('b', { text: p.name }),
        h('div', { class: 'small muted', text: `${p.format?.aspect || '16:9'} · ${p.marks?.length || 0} marks · ${new Date(p.updated).toLocaleDateString()}` })));
    card.addEventListener('contextmenu', (e) => { e.preventDefault(); projectMenu(p); });
    grid.appendChild(card);
  }
  host.appendChild(grid);
}

async function projectMenu(p) {
  const what = await sheet(p.name, (body, close) => {
    const item = (label, kind, danger) => h('button', {
      class: `btn ${danger ? 'danger' : ''}`, style: { width: '100%', justifyContent: 'flex-start', marginBottom: '6px' }, onclick: () => close(kind),
    }, label);
    body.appendChild(item('Open', 'open'));
    body.appendChild(item('Rename', 'rename'));
    body.appendChild(item('Duplicate', 'dup'));
    body.appendChild(item('Delete', 'del', true));
  });
  if (what === 'open') go(`#/p/${p.id}`);
  if (what === 'rename') {
    const name = await promptSheet('Rename', 'Name', p.name);
    if (name) { await store.put({ ...p, name }); renderLibrary(); }
  }
  if (what === 'dup') { await store.duplicate(p.id); renderLibrary(); toast('Duplicated.', 'ok'); }
  if (what === 'del') {
    if (await confirmSheet('Delete this video?', `"${p.name}" and its telestration go for good. The film in Dropbox is untouched.`, { danger: true, ok: 'Delete' })) {
      await store.remove(p.id); renderLibrary(); toast('Deleted.');
    }
  }
}

// ---- the film browser ------------------------------------------------------
//
// TWO SOURCES, ONE FOLDER OF FILM. The local folder (File System Access,
// desktop Chrome/Edge) and Dropbox point at the SAME games, because Tony's
// local CTH/Videos mirrors Dropbox CTH-DB/Videos. Folder is the fast path on
// the Mac - real File bytes, no four-hour temp link - and Dropbox stays for
// the iPad, the phone and inside a Notion embed, where no folder picker
// exists. The toggle only appears where the folder API does.

async function renderBrowser(host) {
  host.replaceChildren();
  const supported = lfs.fsSupported();
  let mode = store.settings().filmSource || (supported ? 'folder' : 'dropbox');
  if (mode === 'folder' && !supported) mode = 'dropbox';

  const head = h('div', { class: 'row', style: { marginBottom: '10px' } }, h('h2', { text: 'Game film' }), h('div', { class: 'grow' }));
  if (supported) {
    const seg = h('div', { class: 'seg' });
    const tab = (id, label) => h('button', {
      class: id === mode ? 'on' : '',
      onclick: () => { if (id !== mode) { store.saveSettings({ filmSource: id }); renderBrowser(host); } },
    }, label);
    seg.append(tab('folder', 'Folder'), tab('dropbox', 'Dropbox'));
    head.appendChild(seg);
  }
  host.appendChild(head);

  if (mode === 'folder') return renderFolderBrowser(host);
  return renderDropboxBrowser(host);
}

// ---- the local folder browser ----------------------------------------------

let folderPath = null;

async function reconnectFolder() {
  if (lfs.fsVideoNeedsReconnect()) return lfs.fsReconnectVideoFolder();
  return lfs.fsReconnect();
}

async function renderFolderBrowser(host) {
  if (!lfs.fsSupported()) {
    host.appendChild(h('p', { class: 'small muted', text: 'This browser cannot open a folder. Use Chrome or Edge on a computer, or switch to Dropbox above.' }));
    return;
  }
  if (!lfs.fsVideosReady()) {
    const remembered = lfs.fsRemembered() || lfs.fsVideoCustom();
    host.appendChild(h('p', { class: 'small muted', text: remembered
      ? 'Reconnect your CTH folder to browse game film from this Mac.'
      : 'Connect your local CTH folder to browse game film from this Mac. It mirrors your Dropbox games folder, and nothing is uploaded.' }));
    host.appendChild(h('button', {
      class: 'btn primary', style: { width: '100%', marginBottom: '8px' },
      onclick: async () => {
        try { remembered ? await reconnectFolder() : await lfs.fsConnect(); renderLibrary(); }
        catch (e) { fail(e); }
      },
    }, remembered ? 'Reconnect folder' : 'Connect CTH folder'));
    host.appendChild(h('button', { class: 'btn', style: { width: '100%' }, onclick: openLocal }, 'Open a file instead'));
    return;
  }

  const path = folderPath ?? lfs.VIDEO_ROOT;
  const parts = String(path).split('/').filter(Boolean); // e.g. ['videos','Games']
  const crumbs = h('div', { class: 'crumbs' });
  crumbs.appendChild(h('button', { text: lfs.fsVideoName() || 'Videos', onclick: () => { folderPath = lfs.VIDEO_ROOT; renderFolderBrowser(host); } }));
  parts.slice(1).forEach((seg, i) => {
    crumbs.appendChild(h('span', { class: 'tiny muted', text: '/' }));
    const to = `/${parts.slice(0, i + 2).join('/')}`;
    if (i === parts.length - 2) crumbs.appendChild(h('b', { text: seg }));
    else crumbs.appendChild(h('button', { text: seg, onclick: () => { folderPath = to; renderFolderBrowser(host); } }));
  });
  host.appendChild(crumbs);

  const filter = h('input', { class: 'input', placeholder: 'Filter this folder', style: { marginBottom: '10px' } });
  host.appendChild(filter);
  const tree = h('div', { class: 'tree' }, h('div', { class: 'small muted', text: 'Loading' }));
  host.appendChild(tree);

  let data;
  try { data = await lfs.fsListFolder(path); }
  catch (e) { tree.replaceChildren(h('div', { class: 'small muted', style: { padding: '10px 8px' }, text: String(e.message) })); return; }

  function paint() {
    const q = filter.value.trim().toLowerCase();
    tree.replaceChildren();
    if (path !== lfs.VIDEO_ROOT && parts.length) {
      tree.appendChild(h('button', {
        class: 'tree-row', onclick: () => { folderPath = `/${parts.slice(0, -1).join('/')}`; renderFolderBrowser(host); },
      }, icon(ICONS.back), h('span', { class: 'nm muted', text: 'Up' })));
    }
    const folders = data.folders.filter((f) => !q || f.name.toLowerCase().includes(q));
    const files = data.files.filter((f) => !q || f.name.toLowerCase().includes(q));
    if (data.missing) { tree.appendChild(h('div', { class: 'small muted', style: { padding: '10px 8px' }, text: 'That folder is not here yet.' })); return; }
    if (!folders.length && !files.length) { tree.appendChild(h('div', { class: 'small muted', style: { padding: '10px 8px' }, text: 'Nothing here.' })); return; }
    for (const f of folders) {
      tree.appendChild(h('button', { class: 'tree-row', onclick: () => { folderPath = f.path; renderFolderBrowser(host); } },
        icon(ICONS.folder), h('span', { class: 'nm', text: f.name })));
    }
    for (const f of files) {
      tree.appendChild(h('button', { class: 'tree-row', onclick: () => startFolderProject(f) },
        icon(ICONS.film), h('span', { class: 'nm', text: f.name }), h('span', { class: 'tiny muted', text: bytes(f.size) })));
    }
  }
  filter.addEventListener('input', paint);
  paint();
}

async function startFolderProject(entry) {
  const p = store.blankProject({
    name: entry.name.replace(/\.[a-z0-9]+$/i, ''),
    source: { kind: 'folder', path: entry.path, name: entry.name, size: entry.size },
    publish: guessPublish(entry.name),
  });
  await store.put(p);
  go(`#/p/${p.id}`);
}

// ---- the Dropbox browser ---------------------------------------------------

async function renderDropboxBrowser(host) {
  if (!dbx.appKey()) {
    host.appendChild(h('p', { class: 'small muted', text: 'Connect Dropbox to browse your game folder from any device, including this iPad and inside a Notion embed. Or just open a file from this device.' }));
    host.appendChild(h('button', { class: 'btn primary', style: { width: '100%', marginBottom: '8px' }, onclick: settingsSheet }, 'Set up Dropbox'));
    host.appendChild(h('button', { class: 'btn', style: { width: '100%' }, onclick: openLocal }, 'Open a file instead'));
    return;
  }
  if (!dbx.connected()) {
    host.appendChild(h('p', { class: 'small muted', text: 'Sign in to Dropbox to see your games.' }));
    host.appendChild(h('button', {
      class: 'btn primary',
      style: { width: '100%' },
      onclick: () => dbx.beginAuth().catch(fail),
    }, 'Connect Dropbox'));
    return;
  }

  const path = browsePath ?? dbx.libraryRoot();
  const crumbs = h('div', { class: 'crumbs' });
  const parts = dbx.normPath(path).split('/').filter(Boolean);
  crumbs.appendChild(h('button', { text: 'Dropbox', onclick: () => { browsePath = ''; renderBrowser(host); } }));
  parts.forEach((seg, i) => {
    crumbs.appendChild(h('span', { class: 'tiny muted', text: '/' }));
    const to = `/${parts.slice(0, i + 1).join('/')}`;
    if (i === parts.length - 1) crumbs.appendChild(h('b', { text: seg }));
    else crumbs.appendChild(h('button', { text: seg, onclick: () => { browsePath = to; renderBrowser(host); } }));
  });
  host.appendChild(crumbs);

  const search = h('input', { class: 'input', placeholder: 'Search film', style: { marginBottom: '10px' } });
  let timer = 0;
  search.addEventListener('input', () => {
    clearTimeout(timer);
    timer = setTimeout(async () => {
      const q = search.value.trim();
      tree.replaceChildren(h('div', { class: 'small muted', text: 'Searching' }));
      try { paint(q ? await dbx.search(q) : await dbx.list(path)); } catch (e) { fail(e); }
    }, 260);
  });
  host.appendChild(search);

  const tree = h('div', { class: 'tree' }, h('div', { class: 'small muted', text: 'Loading' }));
  host.appendChild(tree);

  function paint(entries) {
    tree.replaceChildren();
    if (browsePath && parts.length) {
      tree.appendChild(h('button', {
        class: 'tree-row', onclick: () => { browsePath = `/${parts.slice(0, -1).join('/')}`; renderBrowser(host); },
      }, icon(ICONS.back), h('span', { class: 'nm muted', text: 'Up' })));
    }
    if (!entries.length) { tree.appendChild(h('div', { class: 'small muted', style: { padding: '10px 8px' }, text: 'Nothing here.' })); return; }
    for (const e of entries) {
      tree.appendChild(h('button', {
        class: 'tree-row',
        onclick: () => (e.dir ? (browsePath = e.path, renderBrowser(host)) : startProject(e)),
      },
      icon(e.dir ? ICONS.folder : ICONS.film),
      h('span', { class: 'nm', text: e.name }),
      !e.dir && h('span', { class: 'tiny muted', text: bytes(e.size) })));
    }
  }

  try { paint(await dbx.list(path)); }
  catch (e) { tree.replaceChildren(h('div', { class: 'small muted', style: { padding: '10px 8px' }, text: String(e.message) })); }
}

// ---- creating --------------------------------------------------------------

// The publish fields are guessed from the FILE NAME, because the convention
// already carries them: "... - KHL 2025-2026 - LOK - AKB - AKB POWER PLAY".
// Guessing wrong costs one edit; not guessing costs five fields every time.
export function guessPublish(name) {
  const stem = String(name || '').replace(/\.[a-z0-9]+$/i, '');
  const parts = stem.split(/\s+-\s+/).map((s) => s.trim()).filter(Boolean);
  const out = { league: '', season: '', teamA: '', teamB: '', tag: '', hook: 'We caught it ...' };
  if (parts.length >= 4) {
    const lead = parts[parts.length - 4];
    const m = /^(.*?)\s*(\d{4}(?:\s*[-/]\s*\d{2,4})?)$/.exec(lead);
    if (m) { out.league = m[1].trim(); out.season = m[2].replace(/\s+/g, ''); } else out.league = lead;
    out.teamA = parts[parts.length - 3];
    out.teamB = parts[parts.length - 2];
    out.tag = parts[parts.length - 1];
    if (parts.length >= 5) out.hook = parts[0];
  } else if (parts.length) {
    out.tag = parts[parts.length - 1];
  }
  return out;
}

async function startProject(entry) {
  const p = store.blankProject({
    name: entry.name.replace(/\.[a-z0-9]+$/i, ''),
    source: { kind: 'dropbox', path: entry.path, name: entry.name, size: entry.size },
    publish: guessPublish(entry.name),
  });
  await store.put(p);
  go(`#/p/${p.id}`);
}

async function openLocal() {
  const file = await dbx.openLocalFile();
  if (!file) return;
  const p = store.blankProject({
    name: file.name.replace(/\.[a-z0-9]+$/i, ''),
    source: { kind: 'local', name: file.name, size: file.size },
    publish: guessPublish(file.name),
  });
  // A picked File cannot be re-opened after a reload - the browser gives no
  // durable handle - so it is held in memory for this session and the project
  // asks for it again next time. Saying so beats a broken project later.
  await store.put(p);
  handOff(p.id, file);
  go(`#/p/${p.id}`);
}

// Film that already has a URL: a Clips export, a Dropbox share link somebody
// sent, anything hosted. Unlike a picked File this SURVIVES A RELOAD, so it is
// the sturdiest source of the three - provided the host allows cross-origin
// reads, which a Dropbox raw link and any same-origin file both do.
async function openByUrl() {
  const url = await promptSheet('Open a link', 'Video URL', '', { placeholder: 'https://...', ok: 'Open' });
  if (!url) return;
  let name = 'clip';
  try { name = decodeURIComponent(new URL(url, location.href).pathname.split('/').pop() || 'clip'); }
  catch (_) { toast('That does not look like a URL.', 'warn'); return; }
  const p = store.blankProject({
    name: name.replace(/\.[a-z0-9]+$/i, ''),
    source: { kind: 'url', url, name },
    publish: guessPublish(name),
  });
  await store.put(p);
  go(`#/p/${p.id}`);
}

// A File picked in one view has to reach the editor in another without going
// through storage, which cannot hold it.
const pending = new Map();
export function handOff(id, file) { pending.set(id, file); }
export function takeFile(id) { const f = pending.get(id); return f || null; }

async function newFromQuery(hash) {
  const q = new URLSearchParams(hash.split('?')[1] || '');
  const path = q.get('path');
  if (!path) { go('#/'); return; }
  await startProject({ path, name: path.split('/').pop() || 'clip', size: 0, dir: false });
}

async function openProject(id) {
  let p = null;
  try { p = await store.get(id); } catch (e) { fail(e); }
  if (!p) { toast('That video is not in this browser.', 'warn'); go('#/'); return; }
  openEditor(p, { onBack: () => go('#/'), topbar });
}

// ---- settings --------------------------------------------------------------

async function settingsSheet() {
  await sheet('Settings', (body, close) => {
    const s = store.settings();

    // -- Dropbox
    body.appendChild(h('h3', { class: 'small', style: { margin: '0 0 8px', fontWeight: '800' }, text: 'Dropbox' }));
    const keyInput = h('input', { class: 'input', value: dbx.appKey(), placeholder: 'App key from dropbox.com/developers' });
    body.appendChild(h('label', { class: 'field' }, h('span', { text: 'App key' }), keyInput));
    body.appendChild(h('p', { class: 'tiny muted' },
      'Create an app at ',
      h('a', { href: 'https://www.dropbox.com/developers/apps', target: '_blank', rel: 'noopener', text: 'dropbox.com/developers/apps' }),
      ' (Scoped access, Full Dropbox). Add this exact redirect URI: ',
      h('code', { text: dbx.redirectUri() }),
      '. Give it the permissions files.metadata.read, files.content.read, files.content.write and sharing.write. The app key is not a secret; there is no app secret here and nothing is stored on a server.'));

    const rootInput = h('input', { class: 'input', value: dbx.libraryRoot() });
    body.appendChild(h('label', { class: 'field' }, h('span', { text: 'Film folder' }), rootInput));

    const status = h('div', { class: 'row', style: { marginBottom: '14px' } });
    if (dbx.connected()) {
      status.appendChild(h('span', { class: 'small muted', text: 'Connected.' }));
      status.appendChild(h('div', { class: 'grow' }));
      status.appendChild(h('button', {
        class: 'btn mini', onclick: async () => { await dbx.disconnect(); toast('Disconnected.'); close(null); renderLibrary(); },
      }, 'Disconnect'));
    } else {
      status.appendChild(h('button', {
        class: 'btn mini primary',
        onclick: () => { dbx.setAppKey(keyInput.value); dbx.beginAuth().catch(fail); },
      }, 'Connect'));
    }
    body.appendChild(status);

    // -- Local folder
    body.appendChild(h('h3', { class: 'small', style: { margin: '4px 0 8px', fontWeight: '800' }, text: 'Local folder' }));
    if (!lfs.fsSupported()) {
      body.appendChild(h('p', { class: 'tiny muted', style: { marginBottom: '14px' }, text: 'This browser cannot open a folder. Chrome or Edge on a computer can browse your CTH folder directly; on iPad, phone or inside a Notion embed, use Dropbox above.' }));
    } else {
      body.appendChild(h('p', { class: 'tiny muted', text: 'Browse game film straight from your CTH folder on this Mac. It mirrors your Dropbox games folder, reads faster, and never uploads anything. The same folder is shared with Clips.' }));
      const fstatus = h('div', { class: 'row', style: { marginBottom: '14px' } });
      if (lfs.fsVideosReady()) {
        fstatus.appendChild(h('span', { class: 'small muted', text: `Connected: ${lfs.fsVideoName() || lfs.fsRootName()}` }));
        fstatus.appendChild(h('div', { class: 'grow' }));
        fstatus.appendChild(h('button', {
          class: 'btn mini', onclick: async () => { await lfs.fsDisconnect(); toast('Folder disconnected.'); close(null); renderLibrary(); },
        }, 'Disconnect'));
      } else if (lfs.fsRemembered() || lfs.fsVideoCustom()) {
        fstatus.appendChild(h('span', { class: 'small muted', text: 'Folder access expired.' }));
        fstatus.appendChild(h('div', { class: 'grow' }));
        fstatus.appendChild(h('button', {
          class: 'btn mini primary', onclick: async () => { try { await reconnectFolder(); toast('Folder reconnected.', 'ok'); close(null); renderLibrary(); } catch (e) { fail(e); } },
        }, 'Reconnect'));
      } else {
        fstatus.appendChild(h('button', {
          class: 'btn mini primary', onclick: async () => { try { await lfs.fsConnect(); toast('Folder connected.', 'ok'); close(null); renderLibrary(); } catch (e) { fail(e); } },
        }, 'Connect CTH folder'));
      }
      body.appendChild(fstatus);
    }

    // -- Scrub
    body.appendChild(h('h3', { class: 'small', style: { margin: '4px 0 8px', fontWeight: '800' }, text: 'Scrubbing' }));
    const sens = h('input', { class: 'slider', type: 'range', min: '0.3', max: '3', step: '0.05', value: String(s.scrubSensitivity) });
    const sensOut = h('span', { class: 'tiny muted', text: `${Number(s.scrubSensitivity).toFixed(2)}x` });
    sens.addEventListener('input', () => { sensOut.textContent = `${Number(sens.value).toFixed(2)}x`; });
    body.appendChild(h('label', { class: 'field' }, h('span', {}, 'Trackpad sensitivity ', sensOut), sens));
    const rev = h('input', { type: 'checkbox', checked: s.scrubReverse || null });
    body.appendChild(h('label', { class: 'row', style: { marginBottom: '14px' } }, rev,
      h('span', { class: 'small', text: 'Reverse scrub direction (classic scrolling)' })));

    // -- Export
    body.appendChild(h('h3', { class: 'small', style: { margin: '4px 0 8px', fontWeight: '800' }, text: 'Export' }));
    const pat = h('input', { class: 'input', value: s.namePattern });
    body.appendChild(h('label', { class: 'field' }, h('span', { text: 'File name pattern' }), pat));
    body.appendChild(h('p', { class: 'tiny muted', text: 'Tokens: {hook} {league} {season} {teamA} {teamB} {tag} {name} {date}' }));

    const saveTo = h('select', { class: 'input' },
      h('option', { value: 'dropbox', selected: s.saveTo === 'dropbox' || null, text: 'Save into Dropbox' }),
      h('option', { value: 'download', selected: s.saveTo === 'download' || null, text: 'Download to this device' }));
    body.appendChild(h('label', { class: 'field' }, h('span', { text: 'Where exports go' }), saveTo));

    // -- Backup
    body.appendChild(h('h3', { class: 'small', style: { margin: '4px 0 8px', fontWeight: '800' }, text: 'Backup' }));
    body.appendChild(h('p', { class: 'tiny muted', text: 'Projects live in this browser only. Clearing site data deletes them; this file is the way back.' }));
    body.appendChild(h('div', { class: 'row', style: { marginBottom: '4px' } },
      h('button', {
        class: 'btn mini',
        onclick: async () => {
          dbx.download(await store.exportAll(), `cth-studio-backup-${new Date().toISOString().slice(0, 10)}.json`);
        },
      }, 'Export all'),
      h('button', {
        class: 'btn mini',
        onclick: async () => {
          const f = await dbx.openLocalFile('application/json');
          if (!f) return;
          try { toast(`Imported ${await store.importAll(f)} videos.`, 'ok'); close(null); renderLibrary(); }
          catch (e) { fail(e); }
        },
      }, 'Import')));

    body.appendChild(h('div', { class: 'row end' },
      h('button', { class: 'btn', onclick: () => close(null) }, 'Cancel'),
      h('button', {
        class: 'btn primary',
        onclick: () => {
          dbx.setAppKey(keyInput.value);
          dbx.setLibraryRoot(rootInput.value);
          store.saveSettings({
            scrubSensitivity: Number(sens.value),
            scrubReverse: rev.checked,
            namePattern: pat.value,
            saveTo: saveTo.value,
          });
          close(true);
          toast('Saved.', 'ok');
          if (!location.hash.startsWith('#/p/')) renderLibrary();
        },
      }, 'Save')));
  }, { wide: true });
}

export { settingsSheet, renderLibrary };

boot();
