// CTH Diagrammer - app shell. Two views on one page:
//   Library (#/)            - folder tree + saved diagrams as cards:
//                             search, open, move, duplicate, delete,
//                             import, back up.
//   Editor  (#/drill/ID)    - the rink editor (editor.js). Saving is MANUAL:
//                             an edit only marks the diagram dirty, and the
//                             leave guards below are what stop work being lost.
// (The #/drill/ hash and the "drills" store name are frozen storage terms;
// the interface says Diagram.)

import { loadAssets, RINK_W, RINK_H, SEQ_GAP } from './rink.js';
import {
  listDrills, getDrill, putDrill, deleteDrill, uid, exportAll, importAll,
} from './store.js';
import {
  openEditor, closeEditor, saveNow, isDirty, renderFlat, currentState, editorActions,
} from './editor.js';
import { renderStateFlat, sliceFrames } from './flat.js';
import { pngReadDiagram, pngSetDiagram, dataUrlToBytes, bytesToBlob } from './png.js';
import { toast, esc, confirmSheet, leaveSheet, fmtDate } from './ui.js';

const $ = (sel) => document.querySelector(sel);

const safeName = (s) => (s || 'diagram').replace(/[^\w\- ]+/g, '').trim().replace(/\s+/g, '-').toLowerCase() || 'diagram';

const BACK_ICON = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.8" stroke-linecap="round" stroke-linejoin="round"><path d="M20 12H4"/><path d="m10 18-6-6 6-6"/></svg>';
const TREE_ICON = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.9" stroke-linecap="round"><rect x="3" y="4" width="18" height="16" rx="2.5"/><path d="M9.5 4v16"/></svg>';
const FOLDER_ICON = '<svg class="fic" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8"><path d="M3 7a2 2 0 0 1 2-2h4l2 2h8a2 2 0 0 1 2 2v9a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2z"/></svg>';

// ------------------------------------------------------------- folders

const FOLDERS_KEY = 'cthd.folders.v1';
function folders() {
  try { return JSON.parse(localStorage.getItem(FOLDERS_KEY)) || []; } catch (_) { return []; }
}
function saveFolders(list) {
  localStorage.setItem(FOLDERS_KEY, JSON.stringify(list));
}

// ------------------------------------------------------------- routing

function route() {
  const h = location.hash || '#/';
  const m = h.match(/^#\/drill\/([\w-]+)/);
  return m ? { view: 'editor', id: m[1] } : { view: 'home' };
}

// The home page is back (2026-08-25, Tony's call, reversing 2026-08-24):
// `#/` is a library landing page like Clips and Slides have. The editor
// keeps its sidebar file tree; the home page is where the app OPENS.
const LAST_KEY = 'cthd.lastdrill.v1';
async function resolveDefaultDrill() {
  const last = localStorage.getItem(LAST_KEY);
  if (last && await getDrill(last)) return last;
  const all = await listDrills();
  if (all.length) return all[0].id;
  const d = { id: uid(), name: '', notes: '', folder: '', created: Date.now(), state: null, thumb: null };
  await putDrill(d);
  return d.id;
}

let leaving = false;
async function go() {
  if (leaving) return;
  leaving = true;
  await closeEditor();
  leaving = false;
  const r = route();
  if (r.view === 'editor') { await showEditor(r.id); return; }
  await showHome();
}

async function newDrill(folder = '') {
  const drill = { id: uid(), name: '', notes: '', folder, created: Date.now(), state: null, thumb: null };
  await putDrill(drill);
  location.hash = `#/drill/${drill.id}`;
}

async function importPng(file) {
  const bytes = new Uint8Array(await file.arrayBuffer());
  const state = pngReadDiagram(bytes);
  const dataUrl = await new Promise((res) => {
    const fr = new FileReader();
    fr.onload = () => res(fr.result);
    fr.readAsDataURL(file);
  });
  const name = file.name.replace(/\.[^.]+$/, '');
  let st;
  if (state && Array.isArray(state.elements)) {
    st = state;
    if (!st.bg) {
      const seq = st.seq || 1;
      const rinkShaped = st.w === RINK_W && st.h === seq * RINK_H + (seq - 1) * SEQ_GAP;
      if (!rinkShaped) st = { ...st, bg: dataUrl, elements: [] };
    }
  } else {
    st = { v: 1, w: 0, h: 0, bg: dataUrl, seq: 1, elements: [] };
  }
  const drill = { id: uid(), name, notes: '', folder: '', created: Date.now(), state: st, thumb: null };
  await putDrill(drill);
  toast(`Imported "${name}"${state ? ' - Fully Editable' : ''}`);
  return drill.id;
}

// ------------------------------------------------------------- home view

// Back up and import serve both the home page and the editor tree, so the
// bodies live here once.
async function backupAll() {
  const payload = await exportAll();
  if (!payload.drills.length) { toast('Nothing To Back Up Yet', true); return; }
  payload.folders = folders();
  downloadBlob(new Blob([JSON.stringify(payload)], { type: 'application/json' }),
    `cth-diagrams-backup-${new Date().toISOString().slice(0, 10)}.json`);
  toast(`Backed Up ${payload.drills.length} Diagram${payload.drills.length === 1 ? '' : 's'}`);
}
async function importFiles(files) {
  for (const f of files) {
    try {
      if (/\.json$/i.test(f.name)) {
        const payload = JSON.parse(await f.text());
        const n = await importAll(payload);
        if (Array.isArray(payload.folders)) saveFolders([...new Set([...folders(), ...payload.folders])]);
        toast(`Imported ${n} Diagram${n === 1 ? '' : 's'} From Backup`);
      } else {
        const nid = await importPng(f);
        if (nid && files.length === 1) { location.hash = `#/drill/${nid}`; return true; }
      }
    } catch (err2) {
      console.error(err2);
      toast(`${f.name}: ${err2.message || 'Could Not Import'}`, true);
    }
  }
  return false;
}

async function showHome() {
  document.title = 'CTH Diagrams';
  const drills = await listDrills();
  const known = new Set(folders());
  for (const d of drills) if (d.folder && !known.has(d.folder)) known.add(d.folder);
  const folderList = [...folders(), ...[...known].filter((f) => !folders().includes(f))];
  const recent = drills.slice(0, 8); // listDrills sorts by updated desc
  const row = (d) => `
    <button class="dlib-row" data-open="${d.id}">
      <span class="dlib-thumb">${d.thumb ? `<img src="${d.thumb}" alt="">` : ''}</span>
      <span class="dlib-name">${esc(d.name || 'Untitled Diagram')}</span>
      <span class="dlib-date">${fmtDate(d.updated || d.created)}</span>
    </button>`;
  const loose = drills.filter((d) => !(d.folder || ''));
  $('#app').innerHTML = `
    <header class="lib-head">
      <div class="brand">
        <button class="btn btn-back" id="dlibHome" title="Back To CTH Apps">${BACK_ICON}</button>
        <img src="assets/cth-icon-black.svg" alt="CTH" class="brand-logo">
        <div class="brand-word">
          <h1>CTH Diagrams</h1>
        </div>
      </div>
      <div class="lib-actions">
        <button class="btn" id="dlibImport" title="Open A Diagram PNG Or Restore A Backup JSON">Import</button>
        <button class="btn" id="dlibBackup" title="Download Every Diagram As One Backup JSON">Back Up</button>
        <button class="btn btn-ink" id="dlibNew">+ New Diagram</button>
      </div>
    </header>
    <main class="dlib">
      ${recent.length ? `
        <div class="dlib-title">Recent</div>
        <div class="dlib-recents">
          ${recent.map((d) => `
            <button class="dlib-card" data-open="${d.id}">
              <span class="dlib-card-thumb">${d.thumb ? `<img src="${d.thumb}" alt="">` : ''}</span>
              <span class="dlib-card-name">${esc(d.name || 'Untitled Diagram')}</span>
            </button>`).join('')}
        </div>` : ''}
      <div class="dlib-title">All Diagrams</div>
      <input id="dlibSearch" type="search" placeholder="Search Diagrams…" autocomplete="off">
      <div class="dlib-list">
        <div data-sec>
          ${loose.map(row).join('')}
        </div>
        ${folderList.map((f) => `
          <div data-sec>
            <div class="dlib-folder">${FOLDER_ICON}${esc(f)}<span class="eside-count">${drills.filter((d) => (d.folder || '') === f).length}</span></div>
            ${drills.filter((d) => (d.folder || '') === f).map(row).join('') || '<div class="dlib-note">Empty</div>'}
          </div>`).join('')}
        ${!drills.length ? '<div class="dlib-note">No Diagrams Yet - Press + New Diagram To Draw Your First.</div>' : ''}
      </div>
    </main>
    <input type="file" id="dlibFile" accept=".png,.json,application/json,image/png" hidden multiple>`;
  $('#dlibHome').onclick = () => { location.href = '../'; };
  $('#dlibNew').onclick = () => void newDrill('');
  $('#dlibImport').onclick = () => $('#dlibFile').click();
  $('#dlibBackup').onclick = () => void backupAll();
  $('#dlibFile').onchange = async (e) => {
    const files = [...e.target.files];
    e.target.value = '';
    const opened = await importFiles(files);
    if (!opened) await showHome();
  };
  document.querySelectorAll('[data-open]').forEach((b) => {
    b.addEventListener('click', () => { location.hash = `#/drill/${b.dataset.open}`; });
  });
  const search = $('#dlibSearch');
  search.addEventListener('keydown', (e) => e.stopPropagation());
  search.addEventListener('input', () => {
    const q = search.value.trim().toLowerCase();
    document.querySelectorAll('.dlib-row').forEach((r) => {
      r.hidden = !!q && !r.querySelector('.dlib-name').textContent.toLowerCase().includes(q);
    });
    document.querySelectorAll('.dlib-folder').forEach((h) => { h.hidden = !!q; });
  });
}

// ------------------------------------------------------------- editor view

let curFrames = { seq: 1, names: [] };
const EDSIDE_KEY = 'cthd.edside.v1';

// The file tree: the app's whole library, living beside the canvas.
// Folders collapse, rows drag into folders, and a right-click menu covers
// rename, duplicate, move, and delete for both files and folders.
const COLLAPSE_KEY = 'cthd.sidecollapse.v1';
const collapsed = () => { try { return new Set(JSON.parse(localStorage.getItem(COLLAPSE_KEY)) || []); } catch (_) { return new Set(); } };
const saveCollapsed = (set) => localStorage.setItem(COLLAPSE_KEY, JSON.stringify([...set]));

function ctxMenu(x, y, items) {
  document.querySelector('.move-menu')?.remove();
  const m = document.createElement('div');
  m.className = 'move-menu';
  m.innerHTML = items.map(([label, , danger], i) => `<button data-i="${i}"${danger ? ' class="ctx-danger"' : ''}>${label}</button>`).join('');
  document.body.appendChild(m);
  m.style.left = `${Math.max(8, Math.min(window.innerWidth - m.offsetWidth - 8, x))}px`;
  m.style.top = `${Math.max(8, Math.min(window.innerHeight - m.offsetHeight - 8, y))}px`;
  const close = () => { m.remove(); window.removeEventListener('pointerdown', away, true); };
  const away = (e) => { if (!m.contains(e.target)) close(); };
  window.addEventListener('pointerdown', away, true);
  m.querySelectorAll('[data-i]').forEach((b) => { b.onclick = () => { close(); items[Number(b.dataset.i)][1](); }; });
}

// Inline rename: swap a row's name for an input, commit on Enter or blur.
function inlineRename(nameEl, initial, commit) {
  const input = document.createElement('input');
  input.className = 'side-input';
  input.value = initial;
  input.maxLength = 60;
  nameEl.replaceWith(input);
  let done = false;
  const finish = (keep) => {
    if (done) return;
    done = true;
    const v = input.value.trim();
    commit(keep && v ? v : null);
  };
  input.onkeydown = (e) => {
    e.stopPropagation();
    if (e.key === 'Enter' || e.keyCode === 13) { e.preventDefault(); finish(true); }
    if (e.key === 'Escape') { e.preventDefault(); finish(false); }
  };
  input.onblur = () => finish(true);
  requestAnimationFrame(() => { input.focus(); input.select(); });
}

async function moveDrillTo(id, folder) {
  const d = await getDrill(id);
  if (!d) return;
  d.folder = folder;
  await putDrill(d);
}

async function duplicateDrill(id) {
  const d = await getDrill(id);
  if (!d) return null;
  const copy = { ...structuredClone(d), id: uid(), name: `${d.name || 'Untitled Diagram'} Copy`, created: Date.now() };
  await putDrill(copy);
  return copy.id;
}

async function deleteDrillAndReroute(id, currentId) {
  const d = await getDrill(id);
  const ok = await confirmSheet({
    title: `Delete "${d?.name || 'Untitled Diagram'}"?`,
    body: 'This removes the diagram from this browser. A PNG or backup export is the only way back.',
  });
  if (!ok) return;
  await deleteDrill(id);
  if (id === currentId) {
    localStorage.removeItem(LAST_KEY);
    const next = await resolveDefaultDrill();
    location.hash = `#/drill/${next}`;
  } else {
    await paintEdSide(currentId);
  }
  toast('Diagram Deleted');
}

async function paintEdSide(currentId) {
  const side = $('#edSide');
  if (!side) return;
  const drills = await listDrills();
  const known = new Set(folders());
  for (const d of drills) if (d.folder && !known.has(d.folder)) known.add(d.folder);
  const folderList = [...folders(), ...[...known].filter((f) => !folders().includes(f))];
  const closedSet = collapsed();

  // Every diagram row leads with a small rink glyph: rows of bare text gave
  // the eye nothing to land on, and the glyph also separates a diagram from
  // a folder at a glance (2026-08-27, Tony's call).
  const DOC_ICON = '<svg class="eside-doc" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" aria-hidden="true"><rect x="3" y="6.5" width="18" height="11" rx="5"/><path d="M12 6.5v11"/></svg>';
  const row = (d) => `
    <div class="eside-row${d.id === currentId ? ' on' : ''}" data-open="${d.id}" draggable="true" tabindex="0">
      ${DOC_ICON}<span class="eside-name">${esc(d.name || 'Untitled Diagram')}</span>
    </div>`;
  const loose = drills.filter((d) => !(d.folder || ''));
  side.innerHTML = `
    <input id="esideSearch" type="search" placeholder="Search Diagrams…" autocomplete="off">
    <div class="eside-actions">
      <button class="eside-new" id="esideNew">+ New Diagram</button>
      <button class="eside-new" id="esideNewF" title="Folders Organize The Tree - Drag Diagrams Onto Them">+ Folder</button>
    </div>
    <div class="eside-list" id="esideList">
      <div class="eside-folder eside-root" data-root>Diagrams</div>
      <div data-rootrows>${loose.map(row).join('') || '<div class="eside-empty">None Yet</div>'}</div>
      ${folderList.map((f) => `
        <div class="eside-folder${closedSet.has(f) ? ' closed' : ''}" data-folder="${esc(f)}" draggable="true">
          <svg class="eside-caret" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.4"><path d="m9 6 6 6-6 6"/></svg>
          ${FOLDER_ICON}${esc(f)}<span class="eside-count">${drills.filter((d) => (d.folder || '') === f).length}</span>
        </div>
        <div data-rows="${esc(f)}"${closedSet.has(f) ? ' hidden' : ''}>
          ${drills.filter((d) => (d.folder || '') === f).map(row).join('') || '<div class="eside-empty">Empty - Drag Diagrams Here</div>'}
        </div>`).join('')}
    </div>
    <div class="eside-foot">
      <button class="mini" id="esideImport" title="Open A Diagram PNG Or Restore A Backup JSON">Import</button>
      <button class="mini" id="esideBackup" title="Download Every Diagram As One Backup JSON">Back Up</button>
    </div>
    <input type="file" id="esideFile" accept=".png,.json,application/json,image/png" hidden multiple>`;

  const refresh = () => paintEdSide(currentId);

  // Rows: open, drag, rename, context menu.
  side.querySelectorAll('[data-open]').forEach((r) => {
    const id = r.dataset.open;
    const open = () => { if (id !== currentId) location.hash = `#/drill/${id}`; };
    r.addEventListener('click', open);
    r.addEventListener('keydown', (e) => { if (e.key === 'Enter') open(); });
    r.addEventListener('dragstart', (e) => {
      e.dataTransfer.setData('text/x-cthd-drill', id);
      e.dataTransfer.effectAllowed = 'move';
    });
    r.addEventListener('dblclick', () => startRename(r, id));
    r.addEventListener('contextmenu', async (e) => {
      e.preventDefault();
      const moveItems = [['Move To: Diagrams', async () => { await moveDrillTo(id, ''); refresh(); }],
        ...folderList.map((f) => [`Move To: ${esc(f)}`, async () => { await moveDrillTo(id, f); refresh(); }])];
      ctxMenu(e.clientX, e.clientY, [
        ['Open', open],
        ['Rename', () => startRename(r, id)],
        ['Duplicate', async () => { const nid = await duplicateDrill(id); if (nid) location.hash = `#/drill/${nid}`; }],
        ...moveItems,
        ['Delete', () => void deleteDrillAndReroute(id, currentId), true],
      ]);
    });
  });

  function startRename(r, id) {
    inlineRename(r.querySelector('.eside-name'), r.textContent.trim(), async (v) => {
      if (v != null) {
        const d = await getDrill(id);
        d.name = v === 'Untitled Diagram' ? d.name : v;
        await putDrill(d);
        if (id === currentId) {
          const t = $('#edTitle');
          if (t) t.value = d.name;
          document.title = `${d.name || 'Untitled Diagram'} - CTH Diagrams`;
        }
      }
      refresh();
    });
  }

  // Folder headers: collapse, drop target, reorder, context menu.
  const wireDrop = (elm, folder) => {
    elm.addEventListener('dragover', (e) => {
      if (![...e.dataTransfer.types].includes('text/x-cthd-drill')) return;
      e.preventDefault();
      elm.classList.add('side-drop');
    });
    elm.addEventListener('dragleave', () => elm.classList.remove('side-drop'));
    elm.addEventListener('drop', async (e) => {
      e.preventDefault();
      elm.classList.remove('side-drop');
      const id = e.dataTransfer.getData('text/x-cthd-drill');
      if (!id) return;
      await moveDrillTo(id, folder);
      refresh();
      toast(folder ? `Moved To "${folder}"` : 'Moved To Diagrams');
    });
  };
  wireDrop(side.querySelector('[data-root]'), '');
  side.querySelectorAll('[data-folder]').forEach((h) => {
    const f = h.dataset.folder;
    wireDrop(h, f);
    h.addEventListener('click', () => {
      const set = collapsed();
      if (set.has(f)) set.delete(f); else set.add(f);
      saveCollapsed(set);
      refresh();
    });
    h.addEventListener('dragstart', (e) => {
      e.dataTransfer.setData('text/x-cthd-folder', f);
      e.dataTransfer.effectAllowed = 'move';
    });
    // Dropping a folder on a folder reorders the folder list.
    h.addEventListener('drop', (e) => {
      const from = e.dataTransfer.getData('text/x-cthd-folder');
      if (!from || from === f) return;
      const list = folders().filter((x) => x !== from);
      list.splice(list.indexOf(f) + 1, 0, from);
      saveFolders(list);
      refresh();
    });
    h.addEventListener('contextmenu', (e) => {
      e.preventDefault();
      e.stopPropagation();
      ctxMenu(e.clientX, e.clientY, [
        ['New Diagram Here', () => void newDrill(f)],
        ['Rename Folder', () => {
          inlineRename(h, f, async (v) => {
            if (v && v !== f && !folders().includes(v)) {
              saveFolders(folders().map((x) => (x === f ? v : x)));
              for (const d of drills) if ((d.folder || '') === f) { d.folder = v; await putDrill(d); }
            }
            refresh();
          });
        }],
        ['Delete Folder (Keeps Diagrams)', async () => {
          saveFolders(folders().filter((x) => x !== f));
          for (const d of drills) if ((d.folder || '') === f) { d.folder = ''; await putDrill(d); }
          refresh();
        }, true],
      ]);
    });
  });

  // Blank-space context menu.
  side.querySelector('#esideList').addEventListener('contextmenu', (e) => {
    if (e.target.closest('[data-open], [data-folder]')) return;
    e.preventDefault();
    ctxMenu(e.clientX, e.clientY, [
      ['New Diagram', () => void newDrill('')],
      ['New Folder', () => $('#esideNewF').click()],
      ['Import', () => $('#esideFile').click()],
      ['Back Up All', () => $('#esideBackup').click()],
    ]);
  });

  $('#esideNew').onclick = () => void newDrill('');
  $('#esideNewF').onclick = () => {
    const list = side.querySelector('#esideList');
    const rowEl = document.createElement('div');
    rowEl.className = 'eside-folder';
    list.appendChild(rowEl);
    inlineRename(rowEl, '', (v) => {
      if (v && !folders().includes(v)) saveFolders([...folders(), v]);
      refresh();
    });
  };
  $('#esideImport').onclick = () => $('#esideFile').click();
  $('#esideBackup').onclick = () => void backupAll();
  $('#esideFile').onchange = async (e) => {
    const files = [...e.target.files];
    e.target.value = '';
    const opened = await importFiles(files);
    if (!opened) refresh();
  };
  $('#esideSearch').addEventListener('keydown', (e) => e.stopPropagation());
  $('#esideSearch').addEventListener('input', (e) => {
    const q = e.target.value.trim().toLowerCase();
    side.querySelectorAll('[data-open]').forEach((r) => {
      r.hidden = !!q && !r.textContent.toLowerCase().includes(q);
    });
    side.querySelectorAll('.eside-folder:not(.eside-root)').forEach((h) => { h.hidden = !!q; });
    side.querySelectorAll('[data-rows]').forEach((g) => { if (q) g.hidden = false; });
  });
}

async function showEditor(id) {
  const drill = await getDrill(id);
  if (!drill) { toast('That Diagram Is Gone', true); location.hash = '#/'; return; }
  document.title = `${drill.name || 'Untitled Diagram'} - CTH Diagrams`;
  const app = $('#app');
  app.innerHTML = `
    <div class="ed">
      <header class="ed-head">
        <button class="btn btn-back" id="edBack" title="Back To Your Diagrams" aria-label="Back To Your Diagrams">${BACK_ICON}</button>
        <button class="btn btn-back" id="edTree" title="Show Or Hide Your Diagrams" aria-label="Diagrams Sidebar">${TREE_ICON}</button>
        <input id="edTitle" class="ed-title" value="${esc(drill.name || '')}" placeholder="Name This Diagram…" autocomplete="off" spellcheck="false">
        <span class="ed-status" id="edStatus">Saved</span>
        <div class="ed-head-actions">
          <button class="btn" id="edSave" title="Save This Diagram (Cmd+S)">Save</button>
          <span class="ed-sep"></span>
          <button class="btn" id="edFlip" title="Flip The Selected Objects - Or The Whole Picture When Nothing Is Selected">Flip</button>
          <button class="btn" id="edUndo" title="Undo (Cmd+Z)">Undo</button>
          <button class="btn" id="edRedo" title="Redo (Shift+Cmd+Z)">Redo</button>
          <span class="ed-sep"></span>
          <button class="btn" id="edRinks" hidden title="Copy, Print Or Export Chosen Rinks From This Sequence">Rinks</button>
          <button class="btn" id="edAnim" title="Animate The Drill - Players And Pucks Follow Your Arrows (Then Save A GIF Or Video)">Animate</button>
          <button class="btn" id="edSaveImg" title="Save This Diagram As A PNG In Your cth/diagrams Folder">Save PNG</button>
          <button class="btn" id="edCopy" title="Copy The Finished Picture To The Clipboard">Copy</button>
          <button class="btn" id="edPrint" title="Print This Diagram">Print</button>
          <button class="btn btn-ink" id="edPng" title="Download As PNG - The File Reopens Fully Editable Here And In CTH Film Room">Download PNG</button>
        </div>
      </header>
      <div class="ed-main">
        <aside class="ed-side" id="edSide" hidden></aside>
        <div class="ed-stagewrap" id="edStageWrap">
          <div class="ed-zoom" id="edZoom">
            <div class="ed-stage" id="edStage">
              <svg id="edSvg" xmlns="http://www.w3.org/2000/svg">
                <g id="edBgG"></g>
                <g id="edEls"></g>
                <g id="edUi"></g>
              </svg>
            </div>
            <div class="ed-addrow">
              <button class="ed-addbar" id="edAddBar" hidden>+ Add Rink</button>
              <button class="ed-addbar" id="edDupBar" hidden title="Add A New Rink That Copies The One Above And Everything On It">Duplicate Rink</button>
            </div>
          </div>
        </div>
      </div>
      <div class="tb" id="edBar"></div>
    </div>`;

  await paintEdSide(id);
  const sideEl = $('#edSide');
  const applySideState = () => {
    sideEl.hidden = localStorage.getItem(EDSIDE_KEY) !== 'open';
  };
  if (localStorage.getItem(EDSIDE_KEY) == null) {
    // Open by default everywhere except phones.
    localStorage.setItem(EDSIDE_KEY, window.innerWidth >= 700 ? 'open' : 'closed');
  }
  applySideState();
  $('#edTree').onclick = () => {
    localStorage.setItem(EDSIDE_KEY, sideEl.hidden ? 'open' : 'closed');
    applySideState();
  };

  localStorage.setItem(LAST_KEY, id);
  await openEditor(drill, {
    onFrames: (info) => {
      curFrames = info;
      const b = $('#edRinks');
      if (b) b.hidden = info.seq < 2;
    },
    onRinkLink: (k) => void savePngToFolder(drill, k),
    // Autosave writes on its own, but the Save button still lights while
    // there is something outstanding - on narrow screens the status word is
    // hidden, so this is the only cue that a write is still pending.
    onDirty: (dirty) => {
      const b = $('#edSave');
      if (b) b.classList.toggle('btn-ink', dirty);
    },
  });

  const acts = editorActions();
  $('#edSave').onclick = async () => { await saveNow(); void paintEdSide(id); };
  // Back goes to the app's own home page now, not the hub; the hashchange
  // guard still runs, so unsaved work still gets the leave sheet.
  $('#edBack').onclick = () => { location.hash = '#/'; };
  $('#edFlip').onclick = () => void acts.flipH();
  $('#edUndo').onclick = () => void acts.undo();
  $('#edRedo').onclick = () => void acts.redo();

  const title = $('#edTitle');
  const commitTitle = () => {
    if (drill.name === title.value.trim()) return;
    drill.name = title.value.trim();
    document.title = `${drill.name || 'Untitled Diagram'} - CTH Diagrams`;
    // Marked dirty rather than written straight through, so the name follows
    // the same one Save rule as everything else on the diagram.
    acts.markDirty();
  };
  title.addEventListener('keydown', (e) => {
    e.stopPropagation();
    if (e.key === 'Enter' || e.keyCode === 13) { e.preventDefault(); title.blur(); }
    if (e.key === 'Escape') { e.preventDefault(); title.blur(); }
  });
  title.addEventListener('blur', commitTitle);
  if (!drill.name) title.focus();

  $('#edPng').onclick = async () => {
    await saveNow();
    const canvas = await renderFlat();
    const bytes = await dataUrlToBytes(canvas.toDataURL('image/png'));
    downloadBlob(bytesToBlob(pngSetDiagram(bytes, currentState())), `${safeName(drill.name)}.png`);
    toast('PNG Downloaded - That File Reopens Fully Editable');
  };
  $('#edCopy').onclick = async () => { await copyCanvas(await renderFlat()); };
  $('#edPrint').onclick = async () => {
    await saveNow();
    printCanvas(await renderFlat(), drill.name);
  };
  $('#edRinks').onclick = () => showRinksSheet(drill);
  $('#edSaveImg').onclick = () => void savePngToFolder(drill, null);
  $('#edAnim').onclick = async () => {
    try {
      await saveNow();
      const st = currentState();
      const { openAnimator } = await import('./anim.js');
      await openAnimator({ state: st, name: drill.name, rinkNames: st.rinkNames });
    } catch (e) {
      console.error(e);
      toast(`Could Not Start The Animation (${e.message || 'Error'})`, true);
    }
  };

  document.addEventListener('cthd:shortcuts', showShortcuts);
}

async function copyCanvas(canvas) {
  try {
    const blob = await new Promise((res) => canvas.toBlob(res, 'image/png'));
    await navigator.clipboard.write([new ClipboardItem({ 'image/png': blob })]);
    toast('Picture Copied - Paste It Anywhere');
  } catch (e) {
    console.error(e);
    toast('Copy Needs Clipboard Permission - Use Download PNG Instead', true);
  }
}

function printCanvas(canvas, name) {
  const w = window.open('', '_blank');
  if (!w) { toast('Allow Pop-Ups To Print', true); return; }
  w.document.write(`<!doctype html><title>${esc(name || 'Diagram')}</title>
    <style>body{margin:0;display:grid;place-items:center;}img{max-width:100%;max-height:100vh;}@media print{img{width:100%;}}</style>
    <img src="${canvas.toDataURL('image/png')}" onload="setTimeout(()=>{print();},80)">`);
  w.document.close();
}

// The diagram (or one rink) rendered to PNG and written into Tony's own
// cth/diagrams folder at a STABLE name, so re-saving replaces the same file
// and anything already pointing at it picks up the new version.
// (2026-08-26: this replaced a Dropbox upload that returned a public link.
// A file on disk has no public URL, so there is no link to copy - use the
// file itself.)
async function savePngToFolder(drill, k) {
  let fs;
  try {
    fs = await import('../../clips/js/localfs.js');
  } catch (e) { toast('Could Not Load The Files Module', true); return; }
  if (!fs.fsSupported()) {
    toast('This Browser Cannot Write To A Folder - Use Download PNG Instead', true);
    return;
  }
  try {
    if (!fs.fsConnected()) {
      // Needs a click, and this handler is one.
      await (fs.fsRemembered() ? fs.fsReconnect() : fs.fsConnect());
    }
    await saveNow();
    const full = await renderFlat();
    const canvas = k == null ? full : sliceFrames(full, [k]);
    const blob = await new Promise((res) => canvas.toBlob(res, 'image/png'));
    const tag = k == null ? 'full' : `rink-${k + 1}`;
    const slug = (drill.name || 'diagram').toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '') || 'diagram';
    const path = `${fs.DIAGRAM_ROOT}/${slug}-${tag}.png`;
    await fs.fsWrite(path, blob);
    toast(`Saved To ${fs.fsLabel(path)}`);
  } catch (e) {
    if (e && e.name === 'AbortError') return;
    console.error(e);
    toast(`Could Not Save The PNG (${e.message || 'Error'})`, true);
  }
}

// Pick one, several, or all rinks of a sequence, then copy / print /
// download exactly those. (Each rink also has its own one-click controls
// right on the canvas.)
function showRinksSheet(drill) {
  if (document.querySelector('.sheet-veil')) return;
  const { seq, names } = curFrames;
  const wrap = document.createElement('div');
  wrap.className = 'sheet-veil';
  wrap.innerHTML = `
    <div class="sheet" role="dialog" aria-modal="true">
      <h3>Export Rinks</h3>
      <p>Choose which rinks of this sequence to copy, print, or download.</p>
      <div class="rink-list">
        ${Array.from({ length: seq }, (_, k) => `
          <label class="rink-row"><input type="checkbox" data-k="${k}" checked> ${esc((names[k] || '').trim() || `Rink ${k + 1}`)}</label>`).join('')}
      </div>
      <div class="sheet-row">
        <button class="btn" data-x="copy">Copy</button>
        <button class="btn" data-x="print">Print</button>
        <button class="btn btn-ink" data-x="png">Download PNG</button>
      </div>
    </div>`;
  const done = () => { wrap.remove(); window.removeEventListener('keydown', onEsc, true); };
  const onEsc = (e) => { if (e.key === 'Escape') { e.preventDefault(); e.stopPropagation(); done(); } };
  wrap.addEventListener('mousedown', (e) => { if (e.target === wrap) done(); });
  window.addEventListener('keydown', onEsc, true);
  const picked = () => [...wrap.querySelectorAll('input:checked')].map((i) => Number(i.dataset.k));
  const buildCanvas = async () => {
    const frames = picked();
    if (!frames.length) { toast('Pick At Least One Rink', true); return null; }
    await saveNow();
    const full = await renderFlat();
    return frames.length === curFrames.seq ? full : sliceFrames(full, frames);
  };
  wrap.querySelector('[data-x="copy"]').onclick = async () => {
    const c = await buildCanvas();
    if (c) { done(); await copyCanvas(c); }
  };
  wrap.querySelector('[data-x="print"]').onclick = async () => {
    const c = await buildCanvas();
    if (c) { done(); printCanvas(c, drill.name); }
  };
  wrap.querySelector('[data-x="png"]').onclick = async () => {
    const frames = picked();
    const c = await buildCanvas();
    if (!c) return;
    done();
    if (frames.length === curFrames.seq) {
      const bytes = await dataUrlToBytes(c.toDataURL('image/png'));
      downloadBlob(bytesToBlob(pngSetDiagram(bytes, currentState())), `${safeName(drill.name)}.png`);
    } else {
      const tag = frames.map((k) => k + 1).join('-');
      downloadBlob(bytesToBlob(await dataUrlToBytes(c.toDataURL('image/png'))), `${safeName(drill.name)}-rink-${tag}.png`);
    }
    toast('PNG Downloaded');
  };
  document.body.appendChild(wrap);
}

function downloadBlob(blob, filename) {
  const a = document.createElement('a');
  a.href = URL.createObjectURL(blob);
  a.download = filename;
  a.click();
  setTimeout(() => URL.revokeObjectURL(a.href), 4000);
}

// ------------------------------------------------------------- shortcuts

function showShortcuts() {
  if (document.querySelector('.sheet-veil')) return;
  const rows = [
    ['V', 'Select & Move'], ['A / D', 'Arrow / Dashed Arrow'], ['B / C', 'Shaded Box / Circle'],
    ['T / P', 'Text / Pen'], ['1 / 2 / 3', 'Players (Hover A Player Button For Preset Letters)'],
    ['F', '5v5 Faceoff'], ['H / N / K / S / O / W', 'Coach / Net / Puck / Pucks / Cone / Border'],
    ['6 / 7 / 8 / 9', 'Color Presets'], ['+ / -', 'Add / Remove A Rink'],
    ['Cmd+Z / Shift+Cmd+Z', 'Undo / Redo'], ['Cmd+C / X / V', 'Copy / Cut / Paste Selection'],
    ['Cmd+D', 'Duplicate Selection'], ['Delete', 'Remove Selection'],
    ['Arrows', 'Nudge (Shift = Larger Step)'], ['Cmd While Dragging', 'Snapping Off'],
    ['Cmd While Placing', 'Place Several In A Row'], ['Shift-Click', 'Add To Selection'],
    ['Round Handle', 'Rotate The Selected Item (Snaps To 15 Degrees, Cmd = Free)'],
    ['Double-Click', 'Edit Text, Letter A Player, Label A Shape, Rename A Rink'],
    ['Right-Click A Tool', 'Set Your Own Shortcut Key'],
  ];
  const wrap = document.createElement('div');
  wrap.className = 'sheet-veil';
  wrap.innerHTML = `
    <div class="sheet sheet-wide" role="dialog" aria-modal="true">
      <h3>Keyboard Shortcuts</h3>
      <div class="keys-grid">${rows.map(([k, v]) => `<div class="keys-k">${esc(k)}</div><div class="keys-v">${esc(v)}</div>`).join('')}</div>
      <div class="sheet-row"><button class="btn btn-ink" data-x="ok">Done</button></div>
    </div>`;
  const done = () => { wrap.remove(); window.removeEventListener('keydown', onEsc, true); };
  const onEsc = (e) => { if (e.key === 'Escape' || e.key === '?') { e.preventDefault(); e.stopPropagation(); done(); } };
  wrap.addEventListener('mousedown', (e) => { if (e.target === wrap) done(); });
  wrap.querySelector('[data-x="ok"]').onclick = done;
  window.addEventListener('keydown', onEsc, true);
  document.body.appendChild(wrap);
}

// ------------------------------------------------- one-time migration
// The app used to live at diagrammer.coachtonyhockey.com, and browser
// storage is per-origin - so on first load at the new address, pull
// whatever the old origin still holds through its /export bridge (a tiny
// Cloudflare Worker page that posts the data over).

const MIG_KEY = 'cthd.migrated.v1';
const OLD_ORIGIN = 'https://diagrammer.coachtonyhockey.com';

async function migrateFromOldOrigin() {
  if (location.hostname !== 'apps.coachtonyhockey.com') return;
  if (localStorage.getItem(MIG_KEY)) return;
  await new Promise((done) => {
    const iframe = document.createElement('iframe');
    iframe.style.display = 'none';
    iframe.src = `${OLD_ORIGIN}/export`;
    const cleanup = () => {
      clearTimeout(timer);
      window.removeEventListener('message', onMsg);
      iframe.remove();
      done();
    };
    const timer = setTimeout(cleanup, 8000);
    const onMsg = async (e) => {
      if (e.origin !== OLD_ORIGIN) return;
      const d = e.data;
      if (!d || d.app !== 'cthd-migrate') return;
      try {
        let n = 0;
        if (Array.isArray(d.drills) && d.drills.length) {
          n = await importAll({ drills: d.drills }, { replaceIds: true });
        }
        if (Array.isArray(d.folders) && d.folders.length) {
          saveFolders([...new Set([...folders(), ...d.folders])]);
        }
        for (const [k, v] of Object.entries(d.locals || {})) {
          if (k.startsWith('cthd.') && localStorage.getItem(k) == null) localStorage.setItem(k, v);
        }
        localStorage.setItem(MIG_KEY, '1');
        if (n) toast(`Moved ${n} Diagram${n === 1 ? '' : 's'} Over From The Old Address`);
      } catch (err) {
        console.error('migration failed', err);
      }
      cleanup();
    };
    window.addEventListener('message', onMsg);
    document.body.appendChild(iframe);
  });
}

// --------------------------------------------------------------- boot

// LEAVING IS WHERE MANUAL SAVE CAN BITE. Two exits need guarding: the hash
// route (the Back button and any in-app link) and the browser itself.
let routeHash = location.hash;
let restoringHash = false;

window.addEventListener('hashchange', async () => {
  if (restoringHash) { restoringHash = false; routeHash = location.hash; return; }
  const from = routeHash;
  if (from.startsWith('#/drill/') && isDirty()) {
    const choice = await leaveSheet(document.querySelector('#edTitle')?.value?.trim());
    if (choice === 'cancel') {
      restoringHash = true;
      location.hash = from;   // puts the address bar back; the editor never moved
      return;
    }
    if (choice === 'save') await saveNow();
  }
  routeHash = location.hash;
  await go();
});

// Autosave is debounced, so a tab going away inside that window still has
// work in memory. Hiding the tab (app switch, tab switch, phone lock) is the
// last reliable moment to write, and pagehide covers the close itself.
document.addEventListener('visibilitychange', () => {
  if (document.hidden && isDirty()) void saveNow();
});
window.addEventListener('pagehide', () => { if (isDirty()) void saveNow(); });

// The browser's own prompt, kept as a final backstop for the rare case where
// a save is still in flight as the tab closes. It cannot be worded or given
// a Save button - the spec only allows a generic dialog.
window.addEventListener('beforeunload', (e) => {
  if (!isDirty()) return;
  e.preventDefault();
  e.returnValue = '';
});

(async () => {
  await migrateFromOldOrigin().catch(() => {});
  try {
    await loadAssets();
  } catch (e) {
    console.error(e);
    $('#app').innerHTML = '<div class="lib-none">The Rink Art Could Not Be Loaded. Refresh To Try Again.</div>';
    return;
  }
  await go();
})();
