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

// Render the sidebar. `state` = { folders: [...], videos: [...], current }.
// `on` = { select(path), newFolder(parent), rename(path), remove(path),
//          drop(videoIds, path), menu(path, event) }.
export function renderTree(host, state, on) {
  const open = readOpen();
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
    const r = h('div', {
      class: `eside-folder vt-row ${on2 ? 'on' : ''}`, role: 'treeitem', tabindex: '0', 'aria-selected': on2 ? 'true' : 'false',
      'aria-expanded': kids.length ? String(isOpen) : null, 'data-path': path, style: { paddingLeft: `${6 + depth * 14}px` },
    },
      chev,
      icon(isOpen && kids.length ? FOLDER_OPEN : glyph, 15),
      h('span', { class: 'eside-name', text: label }),
      deep.get(path) ? h('span', { class: 'vt-count', text: String(deep.get(path)) }) : null);
    r.querySelector('svg:nth-of-type(2)')?.classList.add('fic');
    chev.addEventListener('click', (e) => {
      e.stopPropagation();
      if (!kids.length) return;
      if (open.has(path)) open.delete(path); else open.add(path);
      writeOpen(open);
      renderTree(host, state, on);
    });
    r.addEventListener('click', () => on.select(path));
    r.addEventListener('dblclick', () => { if (kids.length) { if (open.has(path)) open.delete(path); else open.add(path); writeOpen(open); renderTree(host, state, on); } });
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
    // Drop a card (or several) on a folder to move it there.
    r.addEventListener('dragover', (e) => { if (e.dataTransfer.types.includes('text/x-cthv-ids')) { e.preventDefault(); e.dataTransfer.dropEffect = 'move'; r.classList.add('drop'); } });
    r.addEventListener('dragleave', () => r.classList.remove('drop'));
    r.addEventListener('drop', (e) => {
      r.classList.remove('drop');
      const ids = (e.dataTransfer.getData('text/x-cthv-ids') || '').split(',').filter(Boolean);
      if (ids.length) { e.preventDefault(); on.drop(ids, path); }
    });
    list.appendChild(r);
    if (isOpen) for (const k of kids) row(k.name, k.path, { depth: depth + 1, kids: k.kids });
  };
  row('All videos', '', { glyph: ALL, kids: [] });
  for (const k of tree.kids) row(k.name, k.path, { depth: 0, kids: k.kids });
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
