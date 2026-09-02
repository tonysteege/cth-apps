// CTH Diagrams Notion - the Diagrams editor, made for Notion embeds.
//
// One diagram (or a stacked sequence of rinks with captions) lives at
//   #/e/<id>
// and that URL is what goes into a Notion embed block. The SAME embed is
// editable for Tony and static for everyone else:
//   - the diagram is stored on the CTH Worker (apps-api, KV namespace DG),
//     public to READ so a shared Notion page can load it for players;
//   - WRITES need the edit key (a Worker secret). Tony enters it once per
//     browser through the small key in the embed's corner; it is kept in
//     localStorage, which Chrome partitions per top-level site - so the key
//     entered inside Notion stays inside Notion, and never rides in a URL.
// With the key the embed runs the real Diagrams editor (toolbar and all,
// which is what stays live during a Notion presentation); without it the
// embed renders the rinks flat, stacked, captioned and scrollable.
//
// The drill state is the Diagrams app's own state (the Film Room
// interchange format, unchanged) - `editor.js` is imported from /diagrams/,
// never copied. No animation here, by design.

import { openEditor, closeEditor, editorActions, currentState, isDirty } from '/diagrams/js/editor.js';
import { renderStateFlat, sliceFrames } from '/diagrams/js/flat.js';
import { loadAssets } from '/diagrams/js/rink.js';
import { esc, toast, confirmSheet } from '/diagrams/js/ui.js';

const API = 'https://apps-api.coachtonyhockey.com';
const KEY = 'cthdn.key';
const $ = (s, r) => (r || document).querySelector(s);
const $$ = (s, r) => [...(r || document).querySelectorAll(s)];
const uid = () => Math.random().toString(36).slice(2, 10) + Date.now().toString(36).slice(-4);
const embedded = () => { try { return window.top !== window.self; } catch (_) { return true; } };
const editKey = () => { try { return localStorage.getItem(KEY) || ''; } catch (_) { return ''; } };
const setKey = (k) => { try { if (k) localStorage.setItem(KEY, k); else localStorage.removeItem(KEY); } catch (_) {} };
const embedUrl = (id) => `${location.origin}${location.pathname}#/e/${id}`;

async function api(path, opts = {}) {
  const headers = { 'content-type': 'application/json', ...(opts.headers || {}) };
  if (editKey()) headers['X-DG-Key'] = editKey();
  const r = await fetch(API + path, { ...opts, headers });
  let body = null;
  try { body = await r.json(); } catch (_) {}
  if (!r.ok) { const err = new Error(body?.message || `Request failed (${r.status})`); err.status = r.status; err.code = body?.error; throw err; }
  return body;
}

let assetsP = null;
const assets = () => (assetsP ||= loadAssets('/diagrams/assets'));

// ------------------------------------------------------------- routing

let leaving = null;
async function route() {
  if (leaving) { await leaving(); leaving = null; }
  const h = location.hash || '#/';
  const m = h.match(/^#\/e\/([\w-]+)(\?.*)?$/);
  if (m) { await showEmbed(m[1], (m[2] || '').includes('static')); return; }
  await showHome();
}

// ------------------------------------------------------------- home

async function showHome() {
  const app = $('#app');
  if (!editKey()) {
    app.innerHTML = `<div class="dn"><div class="dn-signin"><h1>CTH Diagrams Notion</h1><p>Diagrams that live inside your Notion pages: editable for you, static for the players you share them with.</p><button class="btn btn-ink" id="dnSignIn">Enter Edit Key</button></div></div>`;
    $('#dnSignIn').onclick = signIn;
    return;
  }
  app.innerHTML = `<div class="dn"><div class="dn-home"><header class="dn-home-head"><a class="btn btn-back" href="/" aria-label="Hub">Hub</a><h1>Diagrams Notion</h1><button class="btn" id="dnSignOut">Sign Out</button><button class="btn btn-ink" id="dnNew">+ New Diagram</button></header><div class="dn-cards" id="dnCards"><p class="dn-empty">Loading…</p></div></div></div>`;
  $('#dnNew').onclick = newDiagram;
  $('#dnSignOut').onclick = () => { setKey(''); route(); };
  let list;
  try { list = (await api('/dg/')).diagrams || []; }
  catch (e) { if (e.status === 401) { setKey(''); toast('That edit key was refused', true); route(); return; } $('#dnCards').innerHTML = `<p class="dn-empty">${esc(e.message)}</p>`; return; }
  const host = $('#dnCards');
  if (!list.length) { host.innerHTML = '<p class="dn-empty">No diagrams yet. Make one, then paste its link into a Notion embed block.</p>'; return; }
  host.innerHTML = list.map((d) => `
    <div class="dn-card" data-id="${esc(d.id)}">
      <div class="dn-card-thumb"><img data-thumb="${esc(d.id)}" alt=""></div>
      <div class="dn-card-meta"><span class="dn-card-name">${esc(d.name || 'Untitled Diagram')}</span><span class="dn-card-sub">${d.seq > 1 ? `${d.seq} rinks` : '1 rink'} · ${new Date(d.updated).toLocaleDateString()}</span></div>
      <div class="dn-card-acts"><button class="btn mini" data-link>Copy Embed Link</button><button class="btn mini" data-del>Delete</button></div>
    </div>`).join('');
  $$('.dn-card', host).forEach((c) => {
    const id = c.dataset.id;
    c.onclick = (e) => { if (e.target.closest('button')) return; location.hash = `#/e/${id}`; };
    $('[data-link]', c).onclick = () => copyLink(id);
    $('[data-del]', c).onclick = async () => { const d = list.find((x) => x.id === id); if (!(await confirmSheet({ title: `Delete "${d.name || 'Untitled Diagram'}"?`, body: 'Any Notion page embedding it will show "That diagram does not exist."' }))) return; await api(`/dg/${id}`, { method: 'DELETE' }); c.remove(); };
  });
  // Thumbnails render from the live state, small.
  for (const d of list) {
    try { const doc = await api(`/dg/${d.id}`); if (doc.state) { await assets(); const c = await renderStateFlat(doc.state, 0.15); const img = $(`img[data-thumb="${d.id}"]`); if (img) img.src = c.toDataURL('image/jpeg', 0.8); } } catch (_) {}
  }
}

async function signIn() {
  const k = prompt('Edit key (from your CTH Diagrams Notion setup)');
  if (!k) return;
  setKey(k.trim());
  try { await api('/dg/'); } catch (e) { setKey(''); toast(e.status === 401 ? 'That edit key was refused' : e.message, true); return; }
  route();
}

async function newDiagram() {
  const id = uid();
  try { await api(`/dg/${id}`, { method: 'PUT', body: JSON.stringify({ name: '', state: null }) }); }
  catch (e) { toast(e.message, true); return; }
  location.hash = `#/e/${id}`;
}

function copyLink(id) {
  const url = embedUrl(id);
  navigator.clipboard?.writeText(url).then(() => toast('Embed link copied - paste it into a Notion /embed block'), () => prompt('Embed link', url));
}

// ------------------------------------------------------------- embed

async function showEmbed(id, forceStatic) {
  const app = $('#app');
  app.innerHTML = '<div class="dn"><p class="dn-empty">Loading…</p></div>';
  let doc;
  try { doc = await api(`/dg/${id}`); }
  catch (e) { app.innerHTML = `<div class="dn"><p class="dn-empty">${esc(e.message)}</p></div>`; return; }
  document.title = `${doc.name || 'Diagram'} - CTH Diagrams Notion`;
  if (editKey() && !forceStatic) { await showEditor(doc); return; }
  await showStatic(doc);
}

// The players' view: every rink of the sequence, flat, with its caption.
async function showStatic(doc) {
  const app = $('#app');
  const st = doc.state;
  const KEY_ICON = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><circle cx="7.5" cy="15.5" r="4.5"/><path d="M10.7 12.3 21 2M15 8l3 3M18 5l3 3"/></svg>';
  if (!st || !Array.isArray(st.elements)) {
    app.innerHTML = `<div class="dn"><div class="dn-view"><p class="dn-empty">${esc(doc.name || 'This diagram')} has not been drawn yet.</p></div><button class="dn-lock" id="dnLock" aria-label="Coach sign-in">${KEY_ICON}</button></div>`;
    $('#dnLock').onclick = unlock;
    return;
  }
  await assets();
  const full = await renderStateFlat(st, 0.5);
  const seq = st.bg ? 1 : (st.seq || 1);
  const names = st.rinkNames || [];
  const rinks = [];
  for (let k = 0; k < seq; k++) {
    const c = seq > 1 ? sliceFrames(full, [k]) : full;
    rinks.push({ src: c.toDataURL('image/png'), cap: names[k] || '' });
  }
  app.innerHTML = `<div class="dn"><div class="dn-view">${doc.name ? `<h2>${esc(doc.name)}</h2>` : ''}${rinks.map((r) => `<figure class="dn-rink">${r.cap ? `<figcaption class="dn-rink-cap">${esc(r.cap)}</figcaption>` : ''}<img src="${r.src}" alt="${esc(r.cap || doc.name || 'Rink diagram')}"></figure>`).join('')}</div><button class="dn-lock" id="dnLock" aria-label="Coach sign-in">${KEY_ICON}</button></div>`;
  $('#dnLock').onclick = unlock;
}

async function unlock() {
  const k = prompt('Edit key');
  if (!k) return;
  setKey(k.trim());
  try { await api('/dg/'); } catch (e) { setKey(''); toast(e.status === 401 ? 'That edit key was refused' : e.message, true); return; }
  route();
}

// Tony's view: the Diagrams editor itself, publishing to the Worker as he
// draws. The editor's own autosave still writes its local copy (harmless);
// the Worker copy is what the embed shows everyone else.
async function showEditor(doc) {
  const app = $('#app');
  const drill = { id: doc.id, name: doc.name || '', state: doc.state || undefined, created: doc.updated, updated: doc.updated };
  app.innerHTML = `
    <div class="dn ed">
      <header class="ed-head">
        ${embedded() ? '' : '<button class="btn btn-back" id="dnBack" aria-label="Back To Your Diagrams">Back</button>'}
        <input id="edTitle" class="ed-title" value="${esc(drill.name)}" placeholder="Name This Diagram…" autocomplete="off" spellcheck="false">
        <span class="ed-status" id="edStatus" hidden>Saved</span>
        <span class="dn-pub" id="dnPub">Published</span>
        <div class="ed-head-actions">
          <button class="btn" id="edFlip" title="Flip">Flip</button>
          <button class="btn" id="edUndo" title="Undo (Cmd+Z)">Undo</button>
          <button class="btn" id="edRedo" title="Redo (Shift+Cmd+Z)">Redo</button>
          <span class="ed-sep"></span>
          <button class="btn" id="dnLink" title="Copy the embed link for Notion">Copy Link</button>
          <button class="btn" id="dnView" title="See what players see">View</button>
          <button class="btn" id="dnOut" title="Sign out of editing on this browser">Sign Out</button>
        </div>
      </header>
      <div class="ed-main">
        <div class="ed-stagewrap" id="edStageWrap">
          <div class="ed-zoom" id="edZoom">
            <div class="ed-stage" id="edStage">
              <svg id="edSvg" xmlns="http://www.w3.org/2000/svg"><g id="edBgG"></g><g id="edEls"></g><g id="edUi"></g></svg>
            </div>
            <div class="ed-addrow">
              <button class="ed-addbar" id="edAddBar" hidden>+ Add Rink</button>
              <button class="ed-addbar" id="edDupBar" hidden>Duplicate Rink</button>
            </div>
          </div>
        </div>
      </div>
      <div class="tb" id="edBar"></div>
    </div>`;
  await assets();
  let pubT = 0; let inflight = null; let pending = false;
  const pub = $('#dnPub');
  const setPub = (t, cls = '') => { if (pub) { pub.textContent = t; pub.className = `dn-pub ${cls}`; } };
  const publish = async (keepalive = false) => {
    clearTimeout(pubT);
    if (inflight) { pending = true; return; }
    setPub('Publishing…');
    inflight = api(`/dg/${doc.id}`, { method: 'PUT', keepalive, body: JSON.stringify({ name: drill.name, state: currentState() }) })
      .then(() => setPub('Published', 'on'))
      .catch((e) => { setPub(e.status === 401 ? 'Edit key refused' : 'Not published', 'err'); if (e.status === 401) toast('Your edit key was refused - sign in again', true); })
      .finally(() => { inflight = null; if (pending) { pending = false; publish(); } });
    await inflight;
  };
  const schedule = () => { clearTimeout(pubT); pubT = setTimeout(publish, 1200); setPub('Unpublished changes'); };
  await openEditor(drill, {
    onDirty: (dirty) => { if (dirty) schedule(); },
    onFrames: () => {},
  });
  const acts = editorActions();
  $('#edFlip').onclick = () => void acts.flipH();
  $('#edUndo').onclick = () => void acts.undo();
  $('#edRedo').onclick = () => void acts.redo();
  $('#dnLink').onclick = () => copyLink(doc.id);
  $('#dnView').onclick = () => { location.hash = `#/e/${doc.id}?static`; };
  $('#dnOut').onclick = () => { setKey(''); route(); };
  const back = $('#dnBack'); if (back) back.onclick = () => { location.hash = '#/'; };
  const title = $('#edTitle');
  const commitTitle = () => { if (drill.name === title.value.trim()) return; drill.name = title.value.trim(); document.title = `${drill.name || 'Diagram'} - CTH Diagrams Notion`; acts.markDirty(); };
  title.addEventListener('keydown', (e) => { e.stopPropagation(); if (e.key === 'Enter' || e.key === 'Escape') { e.preventDefault(); title.blur(); } });
  title.addEventListener('blur', commitTitle);
  // Leaving: publish what is pending first.
  leaving = async () => { clearTimeout(pubT); if (isDirty() || pending || pub?.textContent === 'Unpublished changes') await publish(); await closeEditor(); };
  const onHide = () => { if (pub?.textContent === 'Unpublished changes') { clearTimeout(pubT); publish(true); } };
  window.addEventListener('pagehide', onHide, { once: true });
}

window.addEventListener('hashchange', route);
route();
