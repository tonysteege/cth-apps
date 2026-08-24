// CTH Diagrammer - app shell. Two views on one page:
//   Library (#/)          - saved drills as cards: search, open, duplicate,
//                           delete, import (PNG or backup JSON), export all.
//   Editor  (#/drill/ID)  - the rink editor (editor.js) with autosave.

import { loadAssets, RINK_W, RINK_H, SEQ_GAP } from './rink.js';
import {
  listDrills, getDrill, putDrill, deleteDrill, uid, exportAll, importAll,
} from './store.js';
import {
  openEditor, closeEditor, saveNow, renderFlat, currentState, editorActions,
} from './editor.js';
import { pngReadDiagram, pngSetDiagram, dataUrlToBytes, bytesToBlob } from './png.js';
import { toast, esc, confirmSheet, fmtDate } from './ui.js';

const $ = (sel) => document.querySelector(sel);

const safeName = (s) => (s || 'drill').replace(/[^\w\- ]+/g, '').trim().replace(/\s+/g, '-').toLowerCase() || 'drill';

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
  await closeEditor(); // flush any pending autosave before the view swaps
  leaving = false;
  const r = route();
  if (r.view === 'editor') await showEditor(r.id);
  else await showLibrary();
}

// ------------------------------------------------------------- library

async function showLibrary() {
  document.title = 'CTH Diagrammer';
  const drills = await listDrills();
  const app = $('#app');
  app.innerHTML = `
    <header class="lib-head">
      <div class="brand">
        <img src="assets/cth-logo-black.svg" alt="CTH" class="brand-logo">
        <div class="brand-word">
          <h1>CTH <em>Diagrammer</em></h1>
          <p>Drill design for Coach Tony Hockey</p>
        </div>
      </div>
      <div class="lib-actions">
        <input id="libSearch" type="search" placeholder="Search drills…" autocomplete="off">
        <button class="btn" id="libImport" title="Open a drill PNG exported from CTH Diagrammer or CTH Film Room, or restore a backup JSON">Import</button>
        <button class="btn" id="libExport" title="Download every drill as one backup JSON file">Back Up</button>
        <button class="btn btn-ink" id="libNew">+ New Drill</button>
      </div>
    </header>
    <main class="lib-grid" id="libGrid"></main>
    <footer class="lib-foot">Drills are saved in this browser. Use <strong>Back Up</strong> for a file you can restore anywhere, or export any drill as a PNG - the PNG itself reopens fully editable here and in CTH Film Room.</footer>
    <input type="file" id="libFile" accept=".png,.json,application/json,image/png" hidden multiple>`;

  const grid = $('#libGrid');
  const paint = (q = '') => {
    const list = drills.filter((d) => !q || (d.name || '').toLowerCase().includes(q) || (d.notes || '').toLowerCase().includes(q));
    if (!drills.length) {
      grid.innerHTML = `
        <div class="lib-empty">
          <div class="lib-empty-rink"></div>
          <h2>Design your first drill</h2>
          <p>A full rink opens game-ready: nets in the creases, a goalie at each end. Players, arrows, text and rink items are one click away - and every drill autosaves as you work.</p>
          <button class="btn btn-ink" id="libNew2">+ New Drill</button>
        </div>`;
      $('#libNew2').onclick = newDrill;
      return;
    }
    if (!list.length) {
      grid.innerHTML = '<div class="lib-none">No drills match that search.</div>';
      return;
    }
    grid.innerHTML = list.map((d) => `
      <article class="card" data-id="${d.id}" tabindex="0">
        <div class="card-thumb">${d.thumb ? `<img src="${d.thumb}" alt="" loading="lazy">` : '<div class="card-thumb-blank"></div>'}</div>
        <div class="card-meta">
          <h3>${esc(d.name || 'Untitled drill')}</h3>
          <span>${fmtDate(d.updated)}</span>
        </div>
        <div class="card-tools">
          <button class="mini" data-do="dup" title="Duplicate this drill">Duplicate</button>
          <button class="mini" data-do="png" title="Download this drill as a PNG (reopens editable)">PNG</button>
          <button class="mini mini-danger" data-do="del" title="Delete this drill">Delete</button>
        </div>
      </article>`).join('');
    grid.querySelectorAll('.card').forEach((c) => {
      const id = c.dataset.id;
      const open = () => { location.hash = `#/drill/${id}`; };
      c.addEventListener('click', (e) => { if (!e.target.closest('.mini')) open(); });
      c.addEventListener('keydown', (e) => { if (e.key === 'Enter' && !e.target.closest('.mini')) open(); });
      c.querySelector('[data-do="dup"]').onclick = async () => {
        const d = await getDrill(id);
        const copy = { ...structuredClone(d), id: uid(), name: `${d.name || 'Untitled drill'} copy`, created: Date.now() };
        await putDrill(copy);
        location.hash = `#/drill/${copy.id}`;
      };
      c.querySelector('[data-do="png"]').onclick = async () => {
        const d = await getDrill(id);
        await downloadDrillPng(d);
      };
      c.querySelector('[data-do="del"]').onclick = async () => {
        const d = drills.find((z) => z.id === id);
        const ok = await confirmSheet({
          title: `Delete "${d?.name || 'Untitled drill'}"?`,
          body: 'This removes the drill from this browser. A PNG or backup export is the only way back.',
        });
        if (!ok) return;
        await deleteDrill(id);
        toast('Drill deleted');
        await showLibrary();
      };
    });
  };
  paint();

  $('#libSearch').addEventListener('input', (e) => paint(e.target.value.trim().toLowerCase()));
  $('#libNew').onclick = newDrill;
  $('#libExport').onclick = async () => {
    const payload = await exportAll();
    if (!payload.drills.length) { toast('Nothing to back up yet', true); return; }
    downloadBlob(new Blob([JSON.stringify(payload)], { type: 'application/json' }),
      `cth-drills-backup-${new Date().toISOString().slice(0, 10)}.json`);
    toast(`Backed up ${payload.drills.length} drill${payload.drills.length === 1 ? '' : 's'}`);
  };
  $('#libImport').onclick = () => $('#libFile').click();
  $('#libFile').onchange = async (e) => {
    const files = [...e.target.files];
    e.target.value = '';
    let opened = false;
    for (const f of files) {
      try {
        if (/\.json$/i.test(f.name)) {
          const n = await importAll(JSON.parse(await f.text()));
          toast(`Imported ${n} drill${n === 1 ? '' : 's'} from backup`);
        } else {
          const id = await importPng(f);
          if (id && files.length === 1) { location.hash = `#/drill/${id}`; opened = true; }
        }
      } catch (err2) {
        console.error(err2);
        toast(`${f.name}: ${err2.message || 'could not import'}`, true);
      }
    }
    if (!opened) await showLibrary();
  };
}

async function newDrill() {
  const drill = { id: uid(), name: '', notes: '', created: Date.now(), state: null, thumb: null };
  await putDrill(drill);
  location.hash = `#/drill/${drill.id}`;
}

// Import a PNG - if it carries cthDiagram state (from here or Film Room) it
// arrives fully editable; a plain image becomes the drill background.
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
      // Standard rink layouts rebuild from our own rink art; anything else
      // keeps the flat PNG as its background.
      const seq = st.seq || 1;
      const rinkShaped = st.w === RINK_W && st.h === seq * RINK_H + (seq - 1) * SEQ_GAP;
      if (!rinkShaped) st = { ...st, bg: dataUrl, elements: [] };
    }
  } else {
    st = { v: 1, w: 0, h: 0, bg: dataUrl, seq: 1, elements: [] };
  }
  const drill = { id: uid(), name, notes: '', created: Date.now(), state: st, thumb: null };
  await putDrill(drill);
  toast(`Imported "${name}"${state ? ' - fully editable' : ''}`);
  return drill.id;
}

// ------------------------------------------------------------- editor view

async function showEditor(id) {
  const drill = await getDrill(id);
  if (!drill) { toast('That drill is gone', true); location.hash = '#/'; return; }
  document.title = `${drill.name || 'Untitled drill'} - CTH Diagrammer`;
  const app = $('#app');
  app.innerHTML = `
    <div class="ed">
      <header class="ed-head">
        <button class="btn btn-back" id="edBack" title="Back to your drills">&larr; Drills</button>
        <input id="edTitle" class="ed-title" value="${esc(drill.name || '')}" placeholder="Name this drill…" autocomplete="off" spellcheck="false">
        <span class="ed-status" id="edStatus">Saved</span>
        <div class="ed-head-actions">
          <button class="btn" id="edFlip" title="Flip the whole picture left-right">Flip</button>
          <button class="btn" id="edUndo" title="Undo (Cmd+Z)">Undo</button>
          <button class="btn" id="edRedo" title="Redo (Shift+Cmd+Z)">Redo</button>
          <span class="ed-sep"></span>
          <button class="btn" id="edCopy" title="Copy the finished picture to the clipboard">Copy</button>
          <button class="btn" id="edPrint" title="Print this drill">Print</button>
          <button class="btn btn-ink" id="edPng" title="Download as PNG - the file reopens fully editable here and in CTH Film Room">Download PNG</button>
        </div>
      </header>
      <div class="ed-body">
        <aside class="ed-rail" id="edRail"></aside>
        <div class="ed-stagewrap" id="edStageWrap">
          <div class="ed-stage" id="edStage">
            <svg id="edSvg" xmlns="http://www.w3.org/2000/svg">
              <image id="edBg" x="0" y="0"></image>
              <g id="edEls"></g>
              <g id="edUi"></g>
            </svg>
          </div>
          <p class="ed-hint">Double-click a player to letter it &middot; drag an arrow's middle anchor to curve it &middot; hold Cmd to place several items or drag snap-free &middot; press <kbd>?</kbd> for shortcuts</p>
        </div>
      </div>
    </div>`;

  await openEditor(drill, {});

  const acts = editorActions();
  $('#edBack').onclick = () => { location.hash = '#/'; };
  $('#edFlip').onclick = () => void acts.flipH();
  $('#edUndo').onclick = () => void acts.undo();
  $('#edRedo').onclick = () => void acts.redo();

  const title = $('#edTitle');
  const commitTitle = async () => {
    drill.name = title.value.trim();
    document.title = `${drill.name || 'Untitled drill'} - CTH Diagrammer`;
    await putDrill(drill);
  };
  title.addEventListener('keydown', (e) => {
    e.stopPropagation();
    if (e.key === 'Enter') { e.preventDefault(); title.blur(); }
    if (e.key === 'Escape') { e.preventDefault(); title.blur(); }
  });
  title.addEventListener('blur', () => void commitTitle());
  if (!drill.name) { title.focus(); }

  $('#edPng').onclick = async () => {
    await downloadCurrentPng(drill);
  };
  $('#edCopy').onclick = async () => {
    try {
      const canvas = await renderFlat();
      const blob = await new Promise((res) => canvas.toBlob(res, 'image/png'));
      await navigator.clipboard.write([new ClipboardItem({ 'image/png': blob })]);
      toast('Picture copied - paste it anywhere');
    } catch (e) {
      console.error(e);
      toast('Copy needs clipboard permission - use Download PNG instead', true);
    }
  };
  $('#edPrint').onclick = async () => {
    await saveNow();
    const canvas = await renderFlat();
    const w = window.open('', '_blank');
    if (!w) { toast('Allow pop-ups to print', true); return; }
    w.document.write(`<!doctype html><title>${esc(drill.name || 'Drill')}</title>
      <style>body{margin:0;display:grid;place-items:center;}img{max-width:100%;max-height:100vh;}@media print{img{width:100%;}}</style>
      <img src="${canvas.toDataURL('image/png')}" onload="setTimeout(()=>{print();},80)">`);
    w.document.close();
  };

  document.addEventListener('cthd:shortcuts', showShortcuts);
}

async function downloadCurrentPng(drill) {
  await saveNow();
  const canvas = await renderFlat();
  const bytes = await dataUrlToBytes(canvas.toDataURL('image/png'));
  const withState = pngSetDiagram(bytes, currentState());
  downloadBlob(bytesToBlob(withState), `${safeName(drill.name)}.png`);
  toast('PNG downloaded - that file reopens fully editable');
}

// PNG export from a library card, without opening the editor: rebuild the
// flat image from the stored state via a temporary editor pass is heavy, so
// use the stored thumb's big brother - re-render through an offscreen open.
async function downloadDrillPng(drill) {
  const prevHash = location.hash;
  if (!drill.state) { toast('Open the drill once before exporting', true); return; }
  // Open silently in the live editor only if we are already elsewhere would
  // disturb the view - instead render from state directly.
  const { renderStateFlat } = await import('./flat.js');
  const canvas = await renderStateFlat(drill.state);
  const bytes = await dataUrlToBytes(canvas.toDataURL('image/png'));
  const withState = pngSetDiagram(bytes, drill.state);
  downloadBlob(bytesToBlob(withState), `${safeName(drill.name)}.png`);
  toast('PNG downloaded - that file reopens fully editable');
  void prevHash;
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
    ['V', 'Select & move'], ['A', 'Arrow'], ['D', 'Dashed arrow'], ['B', 'Shaded box'],
    ['T', 'Text'], ['P', 'Pen'], ['C', 'Crop'], ['1 / 2 / 3', 'Black / blue / grey player'],
    ['Cmd+Z / Shift+Cmd+Z', 'Undo / redo'], ['Cmd+C / X / V', 'Copy / cut / paste selection'],
    ['Cmd+D', 'Duplicate selection'], ['Delete', 'Remove selection'],
    ['Arrows', 'Nudge (Shift = larger step)'], ['Cmd while dragging', 'Snapping off'],
    ['Cmd while placing', 'Place several in a row'], ['Shift-click', 'Add to selection'],
    ['Right-click a tool', 'Set your own shortcut key'],
  ];
  const wrap = document.createElement('div');
  wrap.className = 'sheet-veil';
  wrap.innerHTML = `
    <div class="sheet sheet-wide" role="dialog" aria-modal="true">
      <h3>Keyboard shortcuts</h3>
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

// --------------------------------------------------------------- boot

window.addEventListener('hashchange', () => void go());
window.addEventListener('beforeunload', () => { void saveNow(); });

(async () => {
  try {
    await loadAssets();
  } catch (e) {
    console.error(e);
    $('#app').innerHTML = '<div class="lib-none">The rink art could not be loaded. Refresh to try again.</div>';
    return;
  }
  await go();
})();
