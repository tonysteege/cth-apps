// CTH Diagrammer - app shell. Two views on one page:
//   Library (#/)            - saved diagrams as cards: search, open,
//                             duplicate, delete, import, back up.
//   Editor  (#/drill/ID)    - the rink editor (editor.js) with autosave.
// (The #/drill/ hash and the "drills" store name are frozen storage terms;
// the interface says Diagram.)

import { loadAssets, RINK_W, RINK_H, SEQ_GAP } from './rink.js';
import {
  listDrills, getDrill, putDrill, deleteDrill, uid, exportAll, importAll,
} from './store.js';
import {
  openEditor, closeEditor, saveNow, renderFlat, currentState, editorActions,
} from './editor.js';
import { renderStateFlat, sliceFrames } from './flat.js';
import { pngReadDiagram, pngSetDiagram, dataUrlToBytes, bytesToBlob } from './png.js';
import { toast, esc, confirmSheet, fmtDate } from './ui.js';

const $ = (sel) => document.querySelector(sel);

const safeName = (s) => (s || 'diagram').replace(/[^\w\- ]+/g, '').trim().replace(/\s+/g, '-').toLowerCase() || 'diagram';

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
    <main class="lib-grid" id="libGrid"></main>
    <footer class="lib-foot">Diagrams Are Saved In This Browser. Use <strong>Back Up</strong> For A File You Can Restore Anywhere. An Exported PNG Reopens Fully Editable Here And In CTH Film Room.</footer>
    <input type="file" id="libFile" accept=".png,.json,application/json,image/png" hidden multiple>`;

  const grid = $('#libGrid');
  const paint = (q = '') => {
    const list = drills.filter((d) => !q || (d.name || '').toLowerCase().includes(q) || (d.notes || '').toLowerCase().includes(q));
    if (!drills.length) {
      grid.innerHTML = `
        <div class="lib-empty">
          <div class="lib-empty-rink"></div>
          <h2>Design Your First Diagram</h2>
          <p>A full rink opens game-ready: nets in the creases, a goalie at each end. Players, arrows, text and rink items are one click away, and every diagram autosaves as you work.</p>
          <button class="btn btn-ink" id="libNew2">+ New Diagram</button>
        </div>`;
      $('#libNew2').onclick = newDrill;
      return;
    }
    if (!list.length) {
      grid.innerHTML = '<div class="lib-none">No Diagrams Match That Search.</div>';
      return;
    }
    grid.innerHTML = list.map((d) => `
      <article class="card" data-id="${d.id}" tabindex="0">
        <div class="card-thumb">${d.thumb ? `<img src="${d.thumb}" alt="" loading="lazy">` : '<div class="card-thumb-blank"></div>'}</div>
        <div class="card-meta">
          <h3>${esc(d.name || 'Untitled Diagram')}</h3>
          <span>${fmtDate(d.updated)}</span>
        </div>
        <div class="card-tools">
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
  paint();

  $('#libSearch').addEventListener('input', (e) => paint(e.target.value.trim().toLowerCase()));
  $('#libNew').onclick = newDrill;
  $('#libExport').onclick = async () => {
    const payload = await exportAll();
    if (!payload.drills.length) { toast('Nothing To Back Up Yet', true); return; }
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
          const n = await importAll(JSON.parse(await f.text()));
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
  const drill = { id: uid(), name: '', notes: '', created: Date.now(), state: null, thumb: null };
  await putDrill(drill);
  location.hash = `#/drill/${drill.id}`;
}

// Import a PNG - if it carries cthDiagram state (from here or Film Room) it
// arrives fully editable; a plain image becomes the diagram background.
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
  const drill = { id: uid(), name, notes: '', created: Date.now(), state: st, thumb: null };
  await putDrill(drill);
  toast(`Imported "${name}"${state ? ' - Fully Editable' : ''}`);
  return drill.id;
}

// ------------------------------------------------------------- editor view

let curFrames = { seq: 1, names: [] };

async function showEditor(id) {
  const drill = await getDrill(id);
  if (!drill) { toast('That Diagram Is Gone', true); location.hash = '#/'; return; }
  document.title = `${drill.name || 'Untitled Diagram'} - CTH Diagrammer`;
  const app = $('#app');
  app.innerHTML = `
    <div class="ed">
      <header class="ed-head">
        <button class="btn btn-back" id="edBack" title="Back To Your Diagrams">&larr;</button>
        <input id="edTitle" class="ed-title" value="${esc(drill.name || '')}" placeholder="Name This Diagram…" autocomplete="off" spellcheck="false">
        <span class="ed-status" id="edStatus">Saved</span>
        <div class="ed-head-actions">
          <button class="btn" id="edFlip" title="Flip The Whole Picture Left-Right">Flip</button>
          <button class="btn" id="edUndo" title="Undo (Cmd+Z)">Undo</button>
          <button class="btn" id="edRedo" title="Redo (Shift+Cmd+Z)">Redo</button>
          <span class="ed-sep"></span>
          <button class="btn" id="edRinks" hidden title="Copy, Print Or Export Chosen Rinks From This Sequence">Rinks</button>
          <button class="btn" id="edCopy" title="Copy The Finished Picture To The Clipboard">Copy</button>
          <button class="btn" id="edPrint" title="Print This Diagram">Print</button>
          <button class="btn btn-ink" id="edPng" title="Download As PNG - The File Reopens Fully Editable Here And In CTH Film Room">Download PNG</button>
        </div>
      </header>
      <div class="ed-stagewrap" id="edStageWrap">
        <div class="ed-stage" id="edStage">
          <svg id="edSvg" xmlns="http://www.w3.org/2000/svg">
            <image id="edBg" x="0" y="0"></image>
            <g id="edEls"></g>
            <g id="edFrames"></g>
            <g id="edUi"></g>
          </svg>
        </div>
      </div>
      <div class="tb" id="edBar"></div>
    </div>`;

  await openEditor(drill, {
    onFrames: (info) => {
      curFrames = info;
      const b = $('#edRinks');
      if (b) b.hidden = info.seq < 2;
    },
  });

  const acts = editorActions();
  $('#edBack').onclick = () => { location.hash = '#/'; };
  $('#edFlip').onclick = () => void acts.flipH();
  $('#edUndo').onclick = () => void acts.undo();
  $('#edRedo').onclick = () => void acts.redo();

  const title = $('#edTitle');
  const commitTitle = async () => {
    drill.name = title.value.trim();
    document.title = `${drill.name || 'Untitled Diagram'} - CTH Diagrammer`;
    await putDrill(drill);
  };
  title.addEventListener('keydown', (e) => {
    e.stopPropagation();
    if (e.key === 'Enter' || e.keyCode === 13) { e.preventDefault(); title.blur(); }
    if (e.key === 'Escape') { e.preventDefault(); title.blur(); }
  });
  title.addEventListener('blur', () => void commitTitle());
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
// download exactly those frames.
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
    ['V', 'Select & Move'], ['A', 'Arrow'], ['D', 'Dashed Arrow'], ['B', 'Shaded Box'],
    ['C', 'Shaded Circle'], ['T', 'Text'], ['P', 'Pen'], ['1 / 2 / 3', 'Players'],
    ['Cmd+Z / Shift+Cmd+Z', 'Undo / Redo'], ['Cmd+C / X / V', 'Copy / Cut / Paste Selection'],
    ['Cmd+D', 'Duplicate Selection'], ['Delete', 'Remove Selection'],
    ['Arrows', 'Nudge (Shift = Larger Step)'], ['Cmd While Dragging', 'Snapping Off'],
    ['Cmd While Placing', 'Place Several In A Row'], ['Shift-Click', 'Add To Selection'],
    ['Pinch / Cmd+Scroll', 'Zoom (Cmd+0 Resets)'], ['Two-Finger Scroll', 'Pan The Canvas'],
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

// --------------------------------------------------------------- boot

window.addEventListener('hashchange', () => void go());
window.addEventListener('beforeunload', () => { void saveNow(); });

(async () => {
  try {
    await loadAssets();
  } catch (e) {
    console.error(e);
    $('#app').innerHTML = '<div class="lib-none">The Rink Art Could Not Be Loaded. Refresh To Try Again.</div>';
    return;
  }
  await go();
})();
