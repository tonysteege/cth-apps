// The folder tree: a Finder-style sidebar for the library.
//
// FOLDERS ARE PATHS. A folder is 'Jr. Ducks 12BB 2026/Games'; the tree is
// built from the folder list plus every video's own `folder`, so a folder
// with videos in it exists even if nobody added it to the list. Disclosure
// state and the collapsed sidebar live in localStorage, because where you
// were in the tree is a per-browser convenience, not library data.
//
// The rows are the Diagrams tree recipe (`.eside-folder`, `.fic`, the
// accent pill for the selected row) so the sidebar reads as the same tree
// Clips and Diagrams already draw.

import { h, icon } from '../../studio/js/ui.js';

const LS_OPEN = 'cthv.tree.open';
const LS_HIDDEN = 'cthv.tree.hidden';

const readOpen = () => { try { return new Set(JSON.parse(localStorage.getItem(LS_OPEN) || '[]')); } catch (_) { return new Set(); } };
const writeOpen = (set) => { try { localStorage.setItem(LS_OPEN, JSON.stringify([...set])); } catch (_) { /* fine */ } };
export const treeHidden = () => { try { return localStorage.getItem(LS_HIDDEN) === '1'; } catch (_) { return false; } };
export const setTreeHidden = (v) => { try { localStorage.setItem(LS_HIDDEN, v ? '1' : '0'); } catch (_) { /* fine */ } };

const FOLDER = '<path d="M2 4.5A1.5 1.5 0 013.5 3h2.2l1.2 1.4h5.6A1.5 1.5 0 0114 5.9v5.6a1.5 1.5 0 01-1.5 1.5h-9A1.5 1.5 0 012 11.5z" fill="currentColor"/>';
const FOLDER_OPEN = '<path d="M2 4.5A1.5 1.5 0 013.5 3h2.2l1.2 1.4h5.6A1.5 1.5 0 0114 5.9V7H4.2a1.5 1.5 0 00-1.4 1L2 10.2z" fill="currentColor" opacity=".55"/><path d="M2.6 13h9.9a1.5 1.5 0 001.4-1l1.6-4.5H4.6a1.5 1.5 0 00-1.4 1L1.6 12a.75.75 0 00.7 1z" fill="currentColor"/>';
const ALL = '<rect x="2" y="3" width="12" height="10" rx="1.5" stroke="currentColor" stroke-width="1.4" fill="none"/><path d="M5 3v10M11 3v10" stroke="currentColor" stroke-width="1.2"/>';
const CHEV = '<path d="M6 4l4 4-4 4" stroke="currentColor" stroke-width="1.6" fill="none" stroke-linecap="round" stroke-linejoin="round"/>';
const FILM = '<rect x="2" y="3" width="12" height="10" rx="1.5" stroke="currentColor" stroke-width="1.3" fill="none"/><path d="m6.6 5.9 3.6 2.1-3.6 2.1z" fill="currentColor"/>';

// Build { name, path, kids[] } from a flat list of paths.
export function buildTree(paths) {
  const root = { name: '', path: '', kids: new Map() };
  for (const p of paths) {
    if (!p) continue;
    let node = root;
    const parts = p.split('/');
    for (let i = 0; i < parts.length; i++) {
      const path = parts.slice(0, i + 1).join('/');
      if (!node.kids.has(parts[i])) node.kids.set(parts[i], { name: parts[i], path, kids: new Map() });
      node = node.kids.get(parts[i]);
    }
  }
  const finish = (n) => ({ name: n.name, path: n.path, kids: [...n.kids.values()].sort((a, b) => a.name.localeCompare(b.name, undefined, { numeric: true })).map(finish) });
  return finish(root);
}

export const parentOf = (p) => (p.includes('/') ? p.slice(0, p.lastIndexOf('/')) : '');
export const isUnder = (p, folder) => p === folder || p.startsWith(`${folder}/`);

// Render the sidebar. `state` = { folders, videos, current, currentVideo }.
// `on` = { select(path), open(videoId), newFolder(parent), rename(path),
//          remove(path), drop(videoIds, path), menu(path, event),
//          videoMenu(video, event) }.
// VIDEOS ARE ROWS TOO (2026-09-12, Tony's ask): under every open folder its
// videos are listed as film rows, so the tree is the whole library and a
// video can be opened from it while another is playing.
export function renderTree(host, state, on) {
  const open = readOpen();
  // The selected folder is always reachable: its ancestors open, as Finder
  // reveals a selection.
  const reveal = state.currentVideo ? (state.videos.find((v) => v.id === state.currentVideo)?.folder || '') : parentOf(state.current || '');
  if (reveal) { let p = reveal; while (p) { open.add(p); p = parentOf(p); } writeOpen(open); }
  const counts = new Map();   // direct count per folder, plus '' for root
  const deep = new Map();     // count including subfolders
  for (const v of state.videos) {
    const f = v.folder || '';
    counts.set(f, (counts.get(f) || 0) + 1);
    let p = f;
    for (;;) { deep.set(p, (deep.get(p) || 0) + 1); if (!p) break; p = parentOf(p); }
  }
  const tree = buildTree([...new Set([...state.folders, ...state.videos.map((v) => v.folder || '')])]);

  const list = h('div', { class: 'vt-list', role: 'tree' });
  const row = (label, path, { depth = 0, glyph = FOLDER, kids = [] } = {}) => {
    const isOpen = open.has(path) || path === '';
    const on2 = state.current === path;
    const chev = h('span', { class: `vt-chev ${kids.length ? '' : 'empty'} ${isOpen ? 'open' : ''}` }, icon(CHEV, 12));
    const nameEl = h('span', { class: 'eside-name', text: label });
    const r = h('div', {
      class: `eside-folder vt-row ${on2 ? 'on' : ''}`, role: 'treeitem', tabindex: '0', 'aria-selected': on2 ? 'true' : 'false',
      'aria-expanded': kids.length ? String(isOpen) : null, 'data-path': path, draggable: path ? 'true' : null,
      style: { paddingLeft: `${6 + depth * 14}px` },
    },
      chev,
      icon(isOpen && kids.length ? FOLDER_OPEN : glyph, 15),
      nameEl,
      deep.get(path) ? h('span', { class: 'vt-count', text: String(deep.get(path)) }) : null);
    r.querySelector('svg:nth-of-type(2)')?.classList.add('fic');
    chev.addEventListener('click', (e) => {
      e.stopPropagation();
      if (!kids.length) return;
      if (open.has(path)) open.delete(path); else open.add(path);
      writeOpen(open);
      renderTree(host, state, on);
    });
    r.addEventListener('click', () => { if (!nameEl.dataset.editing) on.select(path); });
    // Double-click renames in place, as Finder does. The root cannot be renamed.
    r.addEventListener('dblclick', (e) => { e.preventDefault(); if (path && on.renameInline) on.renameInline(path, nameEl); });
    if (path) {
      r.addEventListener('dragstart', (e) => { e.dataTransfer.setData('text/x-cthv-folder', path); e.dataTransfer.effectAllowed = 'move'; r.classList.add('dragging'); });
      r.addEventListener('dragend', () => r.classList.remove('dragging'));
    }
    r.addEventListener('keydown', (e) => {
      if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); on.select(path); }
      else if (e.key === 'ArrowRight' && kids.length && !open.has(path)) { open.add(path); writeOpen(open); renderTree(host, state, on); }
      else if (e.key === 'ArrowLeft' && open.has(path)) { open.delete(path); writeOpen(open); renderTree(host, state, on); }
      else if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
        e.preventDefault();
        const rows = [...list.querySelectorAll('.vt-row')];
        const i = rows.indexOf(r) + (e.key === 'ArrowDown' ? 1 : -1);
        rows[i]?.focus();
      }
    });
    r.addEventListener('contextmenu', (e) => { e.preventDefault(); on.menu(path, e); });
    // Drop a video (or several) or a whole folder on a folder to move it there.
    const accepts = (e) => e.dataTransfer.types.includes('text/x-cthv-ids') || e.dataTransfer.types.includes('text/x-cthv-folder');
    let hoverTimer = 0;
    r.addEventListener('dragenter', () => {
      // Hovering a closed folder springs it open, so a drag can reach inside.
      if (kids.length && !isOpen) { clearTimeout(hoverTimer); hoverTimer = setTimeout(() => { open.add(path); writeOpen(open); renderTree(host, state, on); }, 700); }
    });
    r.addEventListener('dragover', (e) => { if (accepts(e)) { e.preventDefault(); e.dataTransfer.dropEffect = 'move'; r.classList.add('drop'); } });
    r.addEventListener('dragleave', () => { r.classList.remove('drop'); clearTimeout(hoverTimer); });
    r.addEventListener('drop', (e) => {
      r.classList.remove('drop'); clearTimeout(hoverTimer);
      const ids = (e.dataTransfer.getData('text/x-cthv-ids') || '').split(',').filter(Boolean);
      const folder = e.dataTransfer.getData('text/x-cthv-folder') || '';
      if (ids.length) { e.preventDefault(); on.drop(ids, path); }
      else if (folder && on.dropFolder) { e.preventDefault(); on.dropFolder(folder, path); }
    });
    list.appendChild(r);
    if (isOpen) {
      for (const k of kids) row(k.name, k.path, { depth: depth + 1, kids: k.kids });
      if (path) for (const v of byFolder.get(path) || []) fileRow(v, depth + 1);
    }
  };
  const fileRow = (v, depth) => {
    const on2 = state.currentVideo === v.id;
    const r = h('div', {
      class: `vt-row vt-file ${on2 ? 'on' : ''}`, role: 'treeitem', tabindex: '0', 'aria-selected': on2 ? 'true' : 'false',
      'data-video': v.id, draggable: 'true', title: v.name, style: { paddingLeft: `${6 + depth * 14 + 16}px` },
    },
      icon(FILM, 15),
      h('span', { class: 'eside-name', text: v.name }),
      v.duration ? h('span', { class: 'vt-dur', text: fmtDur(v.duration) }) : null);
    r.querySelector('svg').classList.add('fic');
    const nameEl = r.querySelector('.eside-name');
    r.addEventListener('click', () => { if (!nameEl.dataset.editing) on.open(v.id); });
    r.addEventListener('dblclick', (e) => { e.preventDefault(); if (on.renameVideoInline) on.renameVideoInline(v, nameEl); });
    r.addEventListener('keydown', (e) => {
      if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); on.open(v.id); }
      else if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
        e.preventDefault();
        const rows = [...list.querySelectorAll('.vt-row')];
        rows[rows.indexOf(r) + (e.key === 'ArrowDown' ? 1 : -1)]?.focus();
      }
    });
    r.addEventListener('contextmenu', (e) => { e.preventDefault(); if (on.videoMenu) on.videoMenu(v, e); });
    r.addEventListener('dragstart', (e) => { e.dataTransfer.setData('text/x-cthv-ids', v.id); e.dataTransfer.effectAllowed = 'move'; r.classList.add('dragging'); });
    r.addEventListener('dragend', () => r.classList.remove('dragging'));
    list.appendChild(r);
  };
  const byFolder = new Map();
  for (const v of [...state.videos].sort((a, b) => a.name.localeCompare(b.name, undefined, { numeric: true }))) {
    const f = v.folder || '';
    if (!byFolder.has(f)) byFolder.set(f, []);
    byFolder.get(f).push(v);
  }
  const fmtDur = (t) => { const s2 = Math.round(t); return `${Math.floor(s2 / 60)}:${String(s2 % 60).padStart(2, '0')}`; };
  row('All videos', '', { glyph: ALL, kids: [] });
  for (const k of tree.kids) row(k.name, k.path, { depth: 0, kids: k.kids });
  for (const v of byFolder.get('') || []) fileRow(v, 0);
  // Every folder row below the root: the root row above shows ALL, so its
  // count is every video. Top-level folders start at depth 0 too, indented
  // one step by their chevron.

  host.replaceChildren(
    h('div', { class: 'vt-head' },
      h('span', { class: 'vt-title', text: 'Folders' }),
      h('button', { class: 'icon-btn vt-add', title: 'New folder', 'aria-label': 'New folder', onclick: () => on.newFolder(state.current) },
        icon('<path d="M8 3.5v9M3.5 8h9" stroke="currentColor" stroke-width="1.7" stroke-linecap="round"/>', 14))),
    list);
}
