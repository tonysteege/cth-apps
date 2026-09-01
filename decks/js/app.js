// CTH Decks - routing and the home library.
//   #/            the library
//   #/d/<id>      the editor
//   #/present/<id> the projector

import { listDecks, putDeck, deleteDeck, uid } from './store.js';
import { newDeck, normalizeDeck } from './model.js';
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
  if ((m = h.match(/^#\/present\/([\w-]+)/))) { await openPresent(m[1]); return; }
  await showHome();
}

async function showHome() {
  const decks = await listDecks();
  const app = $('#app');
  app.innerHTML = `
    <div class="dk-home">
      <header class="dk-home-head">
        <a class="btn btn-ghost btn-icon" href="/" data-tip="Back to the hub" aria-label="Hub">${I.back}</a>
        <h1>Decks</h1>
        <div class="dk-head-r">
          <input class="input dk-search" id="dkSearch" type="search" placeholder="Search decks">
          <button class="btn btn-primary" id="dkNew">${I.plus} New Deck</button>
        </div>
      </header>
      ${decks.length ? `<div class="dk-cards" id="dkCards"></div>` : `
        <div class="dk-empty-home">
          <p>Build a deck the way Figma Slides works - plus scrubbable film and live rink diagrams.</p>
          <button class="btn btn-primary" id="dkNewEmpty">${I.plus} New Deck</button>
        </div>`}
    </div>`;
  const paint = (list) => {
    const host = $('#dkCards');
    if (!host) return;
    host.innerHTML = list.map((d) => {
      const dd = normalizeDeck(d);
      return `
      <div class="card dk-card" data-id="${esc(d.id)}">
        <div class="dk-card-thumb"><div class="dk-thumb-box">${slideHtml(dd.slides[0], dd.theme)}</div></div>
        <div class="dk-card-meta">
          <span class="dk-card-name">${esc(d.name)}</span>
          <span class="dk-card-sub">${dd.slides.length} slide${dd.slides.length === 1 ? '' : 's'} - ${new Date(d.updated || d.created).toLocaleDateString()}</span>
        </div>
        <div class="dk-card-acts">
          <button class="btn btn-ghost btn-icon btn-sm" data-act="dup" data-tip="Duplicate">${I.copy}</button>
          <button class="btn btn-ghost btn-icon btn-sm" data-act="del" data-tip="Delete">${I.trash}</button>
        </div>
      </div>`;
    }).join('');
    hydrate(host);
    $$('.dk-card', host).forEach((c) => {
      c.onclick = (e) => {
        const act = e.target.closest('[data-act]');
        const d = decks.find((x) => x.id === c.dataset.id);
        if (!act) { location.hash = `#/d/${c.dataset.id}`; return; }
        if (act.dataset.act === 'dup') {
          const copy = JSON.parse(JSON.stringify(d));
          copy.id = uid(); copy.name = `${d.name} Copy`; copy.created = copy.updated = Date.now();
          putDeck(copy).then(showHome);
        }
        if (act.dataset.act === 'del') {
          if (confirm(`Delete "${d.name}"? This cannot be undone.`)) deleteDeck(d.id).then(showHome);
        }
      };
    });
  };
  paint(decks);
  const search = $('#dkSearch');
  if (search) search.oninput = () => {
    const q = search.value.trim().toLowerCase();
    paint(q ? decks.filter((d) => (d.name || '').toLowerCase().includes(q)) : decks);
  };
  const make = async () => {
    const d = newDeck();
    await putDeck(d);
    location.hash = `#/d/${d.id}`;
  };
  const nb = $('#dkNew'); if (nb) nb.onclick = make;
  const ne = $('#dkNewEmpty'); if (ne) ne.onclick = make;
}

// Two glyphs only the home page needs.
const svg = (d) => `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.75" stroke-linecap="round" stroke-linejoin="round">${d}</svg>`;
I.copy = svg('<rect x="9" y="9" width="12" height="12" rx="2"/><path d="M5 15V5a2 2 0 0 1 2-2h10"/>');
I.trash = svg('<path d="M3 6h18M8 6V4a1 1 0 0 1 1-1h6a1 1 0 0 1 1 1v2M19 6l-1 14a2 2 0 0 1-2 2H8a2 2 0 0 1-2-2L5 6"/>');

window.addEventListener('hashchange', route);
route();
