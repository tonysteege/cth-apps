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

// ------------------------------------------------------------- folders

const FOLDERS_KEY = 'cthd.folders.v1';
function folders() {
  try { return JSON.parse(localStorage.getItem(FOLDERS_KEY)) || []; } catch (_) { return []; }
}
function saveFolders(list) {
  localStorage.setItem(FOLDERS_KEY, JSON.stringify(list));
}
let libView = ''; // '' = All Diagrams, else a folder name

// ------------------------------------------------------------- routing

function route() {
  const h = location.hash || '#/';
  const m = h.match(/^#\/drill\/([\w-]+)/);
  return m ? { view: 'editor', id: m[1] } : { view: 'library' };
}

let leaving = false;
async function go() {
  if (leaving) return;
  leaving = true;
  await closeEditor();
  leaving = false;
  const r = route();
  if (r.view === 'editor') await showEditor(r.id);
  else await showLibrary();
}

// ------------------------------------------------------------- library

async function showLibrary() {
  document.title = 'CTH Diagrammer';
  const drills = await listDrills();
  // A folder that vanished from the list still shows if diagrams point at
  // it - nothing silently disappears.
  const known = new Set(folders());
  for (const d of drills) if (d.folder && !known.has(d.folder)) { known.add(d.folder); }
  const folderList = [...folders(), ...[...known].filter((f) => !folders().includes(f))];
  if (libView && !folderList.includes(libView)) libView = '';

  const app = $('#app');
  app.innerHTML = `
    <header class="lib-head">
      <div class="brand">
        <button class="btn btn-back" id="libHome" title="Back To CTH Apps" aria-label="Back To CTH Apps">${BACK_ICON}</button>
        <img src="assets/cth-logo-black.svg" alt="CTH" class="brand-logo">
        <div class="brand-word">
          <h1>CTH Diagrammer</h1>
          <p>Diagram Design For Coach Tony Hockey</p>
        </div>
      </div>
      <div class="lib-actions">
        <input id="libSearch" type="search" placeholder="Search Diagrams…" autocomplete="off">
        <button class="btn" id="libImport" title="Open A Diagram PNG From CTH Diagrammer Or CTH Film Room, Or Restore A Backup JSON">Import</button>
        <button class="btn" id="libExport" title="Download Every Diagram As One Backup JSON File">Back Up</button>
        <button class="btn btn-ink" id="libNew">+ New Diagram</button>
      </div>
    </header>
    <div class="lib-body">
      <aside class="lib-side" id="libSide"></aside>
      <main class="lib-grid" id="libGrid"></main>
    </div>
    <footer class="lib-foot">Diagrams Are Saved In This Browser. Use <strong>Back Up</strong> For A File You Can Restore Anywhere. An Exported PNG Reopens Fully Editable Here And In CTH Film Room.</footer>
    <input type="file" id="libFile" accept=".png,.json,application/json,image/png" hidden multiple>`;

  const side = $('#libSide');
  const grid = $('#libGrid');

  const countIn = (f) => drills.filter((d) => (f === '' ? true : (d.folder || '') === f)).length;

  const paintSide = () => {
    side.innerHTML = `
      <div class="side-title">Folders</div>
      <button class="side-row${libView === '' ? ' on' : ''}" data-folder="">
        <span class="side-name">All Diagrams</span><span class="side-count">${countIn('')}</span>
      </button>
      ${folderList.map((f) => `
        <button class="side-row${libView === f ? ' on' : ''}" data-folder="${esc(f)}">
          <svg class="side-ic" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8"><path d="M3 7a2 2 0 0 1 2-2h4l2 2h8a2 2 0 0 1 2 2v9a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2z"/></svg>
          <span class="side-name">${esc(f)}</span><span class="side-count">${countIn(f)}</span>
          <span class="side-tools">
            <span class="side-act" data-ren="${esc(f)}" title="Rename Folder"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8"><path d="M17 3a2.8 2.8 0 1 1 4 4L7.5 20.5 2 22l1.5-5.5z"/></svg></span>
            <span class="side-act" data-delf="${esc(f)}" title="Delete Folder (Diagrams Move To All)"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8"><path d="M18 6 6 18M6 6l12 12"/></svg></span>
          </span>
        </button>`).join('')}
      <button class="side-new" id="sideNew">+ New Folder</button>`;

    side.querySelectorAll('[data-folder]').forEach((b) => {
      b.addEventListener('click', (e) => {
        if (e.target.closest('.side-act')) return;
        libView = b.dataset.folder;
        paintSide();
        paintGrid($('#libSearch').value.trim().toLowerCase());
      });
      // Drop a diagram card onto a folder (or onto All to unfile it).
      b.addEventListener('dragover', (e) => {
        if (![...e.dataTransfer.types].includes('text/x-cthd-drill')) return;
        e.preventDefault();
        b.classList.add('side-drop');
      });
      b.addEventListener('dragleave', () => b.classList.remove('side-drop'));
      b.addEventListener('drop', async (e) => {
        e.preventDefault();
        b.classList.remove('side-drop');
        const id = e.dataTransfer.getData('text/x-cthd-drill');
        if (!id) return;
        const d = await getDrill(id);
        if (!d) return;
        d.folder = b.dataset.folder;
        await putDrill(d);
        await showLibrary();
        toast(b.dataset.folder ? `Moved To "${b.dataset.folder}"` : 'Moved To All Diagrams');
      });
    });
    side.querySelectorAll('[data-ren]').forEach((s) => {
      s.onclick = () => renameFolder(s.dataset.ren);
    });
    side.querySelectorAll('[data-delf]').forEach((s) => {
      s.onclick = async () => {
        const f = s.dataset.delf;
        const n = countIn(f);
        const ok = await confirmSheet({
          title: `Delete Folder "${f}"?`,
          body: n ? `Its ${n} diagram${n === 1 ? '' : 's'} move to All Diagrams - nothing is deleted.` : 'The folder is empty.',
          action: 'Delete Folder',
        });
        if (!ok) return;
        saveFolders(folders().filter((x) => x !== f));
        for (const d of drills) {
          if ((d.folder || '') === f) { d.folder = ''; await putDrill(d); }
        }
        if (libView === f) libView = '';
        await showLibrary();
      };
    });
    $('#sideNew').onclick = () => {
      const row = document.createElement('div');
      row.className = 'side-row side-editing';
      row.innerHTML = '<input class="side-input" placeholder="Folder Name…" maxlength="40">';
      side.insertBefore(row, $('#sideNew'));
      const input = row.querySelector('input');
      const commit = () => {
        const name = input.value.trim();
        row.remove();
        if (!name || folders().includes(name)) { if (name) toast('That Folder Already Exists', true); return; }
        saveFolders([...folders(), name]);
        libView = name;
        void showLibrary();
      };
      input.onkeydown = (e) => {
        e.stopPropagation();
        if (e.key === 'Enter' || e.keyCode === 13) { e.preventDefault(); commit(); }
        if (e.key === 'Escape') { e.preventDefault(); row.remove(); }
      };
      input.onblur = commit;
      input.focus();
    };
  };

  const renameFolder = (f) => {
    const row = side.querySelector(`[data-folder="${CSS.escape(f)}"]`);
    if (!row) return;
    const name = row.querySelector('.side-name');
    const input = document.createElement('input');
    input.className = 'side-input';
    input.value = f;
    input.maxLength = 40;
    name.replaceWith(input);
    const commit = async () => {
      const to = input.value.trim();
      if (!to || to === f) { paintSide(); return; }
      if (folders().includes(to)) { toast('That Folder Already Exists', true); paintSide(); return; }
      saveFolders(folders().map((x) => (x === f ? to : x)));
      for (const d of drills) {
        if ((d.folder || '') === f) { d.folder = to; await putDrill(d); }
      }
      if (libView === f) libView = to;
      await showLibrary();
    };
    input.onkeydown = (e) => {
      e.stopPropagation();
      if (e.key === 'Enter' || e.keyCode === 13) { e.preventDefault(); void commit(); }
      if (e.key === 'Escape') { e.preventDefault(); paintSide(); }
    };
    input.onblur = () => void commit();
    input.focus();
    input.select();
  };

  const paintGrid = (q = '') => {
    const inView = drills.filter((d) => (libView === '' ? true : (d.folder || '') === libView));
    const list = inView.filter((d) => !q || (d.name || '').toLowerCase().includes(q) || (d.notes || '').toLowerCase().includes(q));
    if (!drills.length) {
      grid.innerHTML = `
        <div class="lib-empty">
          <div class="lib-empty-rink"></div>
          <h2>Design Your First Diagram</h2>
          <p>A full rink opens game-ready: nets in the creases, a goalie at each end. Players, arrows, text and rink items are one click away. Press Save (or Cmd+S) when you want to keep your work.</p>
          <button class="btn btn-ink" id="libNew2">+ New Diagram</button>
        </div>`;
      $('#libNew2').onclick = newDrill;
      return;
    }
    if (!list.length) {
      grid.innerHTML = `<div class="lib-none">${q ? 'No Diagrams Match That Search.' : 'This Folder Is Empty - Drag A Diagram Onto It, Or Use Move On A Card.'}</div>`;
      return;
    }
    grid.innerHTML = list.map((d) => `
      <article class="card" data-id="${d.id}" tabindex="0" draggable="true">
        <div class="card-thumb">${d.thumb ? `<img src="${d.thumb}" alt="" loading="lazy">` : '<div class="card-thumb-blank"></div>'}</div>
        <div class="card-meta">
          <h3>${esc(d.name || 'Untitled Diagram')}</h3>
          <span>${fmtDate(d.updated)}</span>
        </div>
        <div class="card-tools">
          <button class="mini" data-do="move" title="Move To A Folder">Move</button>
          <button class="mini" data-do="dup" title="Duplicate This Diagram">Duplicate</button>
          <button class="mini" data-do="png" title="Download This Diagram As A PNG (Reopens Editable)">PNG</button>
          <button class="mini mini-danger" data-do="del" title="Delete This Diagram">Delete</button>
        </div>
      </article>`).join('');
    grid.querySelectorAll('.card').forEach((c) => {
      const id = c.dataset.id;
      const open = () => { location.hash = `#/drill/${id}`; };
      c.addEventListener('click', (e) => { if (!e.target.closest('.mini')) open(); });
      c.addEventListener('keydown', (e) => { if (e.key === 'Enter' && !e.target.closest('.mini')) open(); });
      c.addEventListener('dragstart', (e) => {
        e.dataTransfer.setData('text/x-cthd-drill', id);
        e.dataTransfer.effectAllowed = 'move';
      });
      c.querySelector('[data-do="move"]').onclick = (e) => showMoveMenu(e.currentTarget, id);
      c.querySelector('[data-do="dup"]').onclick = async () => {
        const d = await getDrill(id);
        const copy = { ...structuredClone(d), id: uid(), name: `${d.name || 'Untitled Diagram'} Copy`, created: Date.now() };
        await putDrill(copy);
        location.hash = `#/drill/${copy.id}`;
      };
      c.querySelector('[data-do="png"]').onclick = async () => {
        const d = await getDrill(id);
        if (!d.state) { toast('Open The Diagram Once Before Exporting', true); return; }
        const canvas = await renderStateFlat(d.state);
        const bytes = await dataUrlToBytes(canvas.toDataURL('image/png'));
        downloadBlob(bytesToBlob(pngSetDiagram(bytes, d.state)), `${safeName(d.name)}.png`);
        toast('PNG Downloaded - That File Reopens Fully Editable');
      };
      c.querySelector('[data-do="del"]').onclick = async () => {
        const d = drills.find((z) => z.id === id);
        const ok = await confirmSheet({
          title: `Delete "${d?.name || 'Untitled Diagram'}"?`,
          body: 'This removes the diagram from this browser. A PNG or backup export is the only way back.',
        });
        if (!ok) return;
        await deleteDrill(id);
        toast('Diagram Deleted');
        await showLibrary();
      };
    });
  };

  const showMoveMenu = (btn, id) => {
    document.querySelector('.move-menu')?.remove();
    const menu = document.createElement('div');
    menu.className = 'move-menu';
    menu.innerHTML = `
      <button data-f="">All Diagrams (No Folder)</button>
      ${folderList.map((f) => `<button data-f="${esc(f)}">${esc(f)}</button>`).join('')}`;
    document.body.appendChild(menu);
    const r = btn.getBoundingClientRect();
    menu.style.left = `${Math.min(window.innerWidth - menu.offsetWidth - 8, r.left)}px`;
    menu.style.top = `${r.bottom + 6}px`;
    const close = () => { menu.remove(); window.removeEventListener('pointerdown', onAway, true); };
    const onAway = (e) => { if (!menu.contains(e.target)) close(); };
    window.addEventListener('pointerdown', onAway, true);
    menu.querySelectorAll('[data-f]').forEach((b) => {
      b.onclick = async () => {
        close();
        const d = await getDrill(id);
        d.folder = b.dataset.f;
        await putDrill(d);
        await showLibrary();
        toast(b.dataset.f ? `Moved To "${b.dataset.f}"` : 'Moved To All Diagrams');
      };
    });
  };

  paintSide();
  paintGrid();

  $('#libHome').onclick = () => { location.href = '../'; };
  $('#libSearch').addEventListener('input', (e) => paintGrid(e.target.value.trim().toLowerCase()));
  $('#libNew').onclick = newDrill;
  $('#libExport').onclick = async () => {
    const payload = await exportAll();
    if (!payload.drills.length) { toast('Nothing To Back Up Yet', true); return; }
    payload.folders = folders();
    downloadBlob(new Blob([JSON.stringify(payload)], { type: 'application/json' }),
      `cth-diagrams-backup-${new Date().toISOString().slice(0, 10)}.json`);
    toast(`Backed Up ${payload.drills.length} Diagram${payload.drills.length === 1 ? '' : 's'}`);
  };
  $('#libImport').onclick = () => $('#libFile').click();
  $('#libFile').onchange = async (e) => {
    const files = [...e.target.files];
    e.target.value = '';
    let opened = false;
    for (const f of files) {
      try {
        if (/\.json$/i.test(f.name)) {
          const payload = JSON.parse(await f.text());
          const n = await importAll(payload);
          if (Array.isArray(payload.folders)) {
            saveFolders([...new Set([...folders(), ...payload.folders])]);
          }
          toast(`Imported ${n} Diagram${n === 1 ? '' : 's'} From Backup`);
        } else {
          const id = await importPng(f);
          if (id && files.length === 1) { location.hash = `#/drill/${id}`; opened = true; }
        }
      } catch (err2) {
        console.error(err2);
        toast(`${f.name}: ${err2.message || 'Could Not Import'}`, true);
      }
    }
    if (!opened) await showLibrary();
  };
}

async function newDrill() {
  const drill = { id: uid(), name: '', notes: '', folder: libView || '', created: Date.now(), state: null, thumb: null };
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
  const drill = { id: uid(), name, notes: '', folder: libView || '', created: Date.now(), state: st, thumb: null };
  await putDrill(drill);
  toast(`Imported "${name}"${state ? ' - Fully Editable' : ''}`);
  return drill.id;
}

// ------------------------------------------------------------- editor view

let curFrames = { seq: 1, names: [] };
const EDSIDE_KEY = 'cthd.edside.v1';

// The diagram tree inside the editor: folders and diagrams, current one
// highlighted, one click to switch (the unsaved-work guard still runs).
async function paintEdSide(currentId) {
  const side = $('#edSide');
  if (!side) return;
  const drills = await listDrills();
  const known = new Set(folders());
  for (const d of drills) if (d.folder && !known.has(d.folder)) known.add(d.folder);
  const folderList = [...folders(), ...[...known].filter((f) => !folders().includes(f))];
  const row = (d) => `
    <button class="eside-row${d.id === currentId ? ' on' : ''}" data-open="${d.id}">
      <span class="eside-name">${esc(d.name || 'Untitled Diagram')}</span>
    </button>`;
  const loose = drills.filter((d) => !(d.folder || ''));
  side.innerHTML = `
    <input id="esideSearch" type="search" placeholder="Search…" autocomplete="off">
    <button class="eside-new" id="esideNew">+ New Diagram</button>
    <div class="eside-list" id="esideList">
      ${loose.map(row).join('')}
      ${folderList.map((f) => {
    const inF = drills.filter((d) => (d.folder || '') === f);
    return inF.length || true ? `
        <div class="eside-folder">${esc(f)}</div>
        ${inF.map(row).join('') || '<div class="eside-empty">Empty</div>'}` : '';
  }).join('')}
    </div>`;
  const wire = () => {
    side.querySelectorAll('[data-open]').forEach((b) => {
      b.onclick = () => {
        const id = b.dataset.open;
        if (id === currentId) return;
        location.hash = `#/drill/${id}`;
      };
    });
  };
  wire();
  $('#esideNew').onclick = () => void newDrill();
  $('#esideSearch').addEventListener('input', (e) => {
    const q = e.target.value.trim().toLowerCase();
    const list = $('#esideList');
    list.innerHTML = drills
      .filter((d) => !q || (d.name || 'untitled diagram').toLowerCase().includes(q))
      .map(row).join('') || '<div class="eside-empty">No Matches</div>';
    wire();
  });
  $('#esideSearch').addEventListener('keydown', (e) => e.stopPropagation());
}

async function showEditor(id) {
  const drill = await getDrill(id);
  if (!drill) { toast('That Diagram Is Gone', true); location.hash = '#/'; return; }
  document.title = `${drill.name || 'Untitled Diagram'} - CTH Diagrammer`;
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
            <button class="ed-addbar" id="edAddBar" hidden>+ Add Rink</button>
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
    localStorage.setItem(EDSIDE_KEY, window.innerWidth >= 1100 ? 'open' : 'closed');
  }
  applySideState();
  $('#edTree').onclick = () => {
    localStorage.setItem(EDSIDE_KEY, sideEl.hidden ? 'open' : 'closed');
    applySideState();
  };

  await openEditor(drill, {
    onFrames: (info) => {
      curFrames = info;
      const b = $('#edRinks');
      if (b) b.hidden = info.seq < 2;
    },
    // Saving is manual, so the Save button has to SHOW there is something to
    // save. Without that the only cue would be the small status word, which
    // is hidden entirely on narrow screens.
    onDirty: (dirty) => {
      const b = $('#edSave');
      if (b) b.classList.toggle('btn-ink', dirty);
    },
  });

  const acts = editorActions();
  $('#edSave').onclick = () => void saveNow();
  $('#edBack').onclick = () => { location.hash = '#/'; };
  $('#edFlip').onclick = () => void acts.flipH();
  $('#edUndo').onclick = () => void acts.undo();
  $('#edRedo').onclick = () => void acts.redo();

  const title = $('#edTitle');
  const commitTitle = () => {
    if (drill.name === title.value.trim()) return;
    drill.name = title.value.trim();
    document.title = `${drill.name || 'Untitled Diagram'} - CTH Diagrammer`;
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
    ['Pinch / Cmd+Scroll', 'Zoom (Cmd+0 Resets)'], ['Two-Finger Scroll', 'Pan The Canvas'],
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

// The browser's own prompt. It cannot be worded or given a Save button - the
// spec only allows a generic dialog - so the in-app sheet above is the one
// that does the real work. This is the backstop for closing the tab.
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
