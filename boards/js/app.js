// CTH Decks - routing and the home library.
//   #/                          the library of boards
//   #/d/<boardId>               the whiteboard editor
//   #/present/<boardId>/<deck>  the projector for one deck on a board
//   #/present/<boardId>         (legacy) the board's first deck

import { listDecks, putDeck, deleteDeck, uid } from './store.js';
import { newBoard, normalizeBoard, boardDecks } from './model.js';
import { slideHtml, hydrate, esc } from './render.js';
import { openEditor, closeEditor, editing, I } from './editor.js';
import { openPresent, closePresent, presenting } from './present.js';

const $ = (sel, root) => (root || document).querySelector(sel);
const $$ = (sel, root) => [...(root || document).querySelectorAll(sel)];

async function route() {
  if (editing()) closeEditor();
  if (presenting()) closePresent();
  const h = location.hash || '#/';
  let m;
  if ((m = h.match(/^#\/d\/([\w-]+)/))) { await openEditor(m[1]); return; }
  if ((m = h.match(/^#\/present\/([\w-]+)(?:\/([\w-]+))?/))) { await openPresent(m[1], m[2]); return; }
  await showHome();
}

async function showHome() {
  const boards = await listDecks();
  const app = $('#app');
  app.innerHTML = `
    <div class="dk-home">
      <header class="dk-home-head">
        <a class="btn btn-ghost btn-icon" href="/" data-tip="Back to the hub" aria-label="Hub">${I.back}</a>
        <h1>Boards</h1>
        <div class="dk-head-r">
          <input class="input dk-search" id="dkSearch" type="search" name="q" placeholder="Search boards…" autocomplete="off" spellcheck="false">
          <button class="btn btn-primary" id="dkNew">${I.plus} New Board</button>
        </div>
      </header>
      ${boards.length ? `<div class="dk-cards" id="dkCards"></div>` : `
        <div class="dk-empty-home">
          <p>A whiteboard for coaching: slide decks, sticky notes, drills and film on one canvas.</p>
          <button class="btn btn-primary" id="dkNewEmpty">${I.plus} New Board</button>
        </div>`}
    </div>`;
  const paint = (list) => {
    const host = $('#dkCards');
    if (!host) return;
    if (!list.length) { host.innerHTML = '<p class="dk-nores">No boards match that search.</p>'; return; }
    host.innerHTML = list.map((b) => {
      const bb = normalizeBoard(b);
      const decks = boardDecks(bb);
      const first = decks[0];
      const counts = `${decks.length} deck${decks.length === 1 ? '' : 's'} · ${bb.items.length} object${bb.items.length === 1 ? '' : 's'}`;
      return `
      <div class="card dk-card" data-id="${esc(b.id)}">
        <a class="dk-card-link" href="#/d/${esc(b.id)}" aria-label="Open ${esc(b.name)}">
          <div class="dk-card-thumb">${first ? `<div class="dk-thumb-box">${slideHtml(first.slides[0], first.theme)}</div>` : '<div class="dk-card-blank"></div>'}</div>
          <div class="dk-card-meta">
            <span class="dk-card-name">${esc(b.name)}</span>
            <span class="dk-card-sub">${counts} · ${new Date(b.updated || b.created).toLocaleDateString()}</span>
          </div>
        </a>
        <div class="dk-card-acts">
          <button class="btn btn-ghost btn-icon btn-sm" data-act="dup" data-tip="Duplicate" aria-label="Duplicate ${esc(b.name)}">${I.copy}</button>
          <button class="btn btn-ghost btn-icon btn-sm" data-act="del" data-tip="Delete" aria-label="Delete ${esc(b.name)}">${I.trash}</button>
        </div>
      </div>`;
    }).join('');
    hydrate(host);
    $$('.dk-card', host).forEach((c) => {
      c.onclick = (e) => {
        const act = e.target.closest('[data-act]');
        if (!act) return;
        const b = boards.find((x) => x.id === c.dataset.id);
        if (act.dataset.act === 'dup') {
          const copy = JSON.parse(JSON.stringify(b));
          copy.id = uid(); copy.name = `${b.name} Copy`; copy.created = copy.updated = Date.now();
          putDeck(copy).then(showHome);
        }
        if (act.dataset.act === 'del') {
          if (confirm(`Delete "${b.name}"? This cannot be undone.`)) deleteDeck(b.id).then(showHome);
        }
      };
    });
  };
  paint(boards);
  const search = $('#dkSearch');
  if (search) search.oninput = () => {
    const q = search.value.trim().toLowerCase();
    paint(q ? boards.filter((b) => (b.name || '').toLowerCase().includes(q)) : boards);
  };
  const make = async () => {
    const b = newBoard();
    await putDeck(b);
    location.hash = `#/d/${b.id}`;
  };
  const nb = $('#dkNew'); if (nb) nb.onclick = make;
  const ne = $('#dkNewEmpty'); if (ne) ne.onclick = make;
}

window.addEventListener('hashchange', route);
route();
