// CTH Diagrams Notion - the Diagrams editor, made for Notion embeds.
//
// ONE DIAGRAM PER EMBED (Tony's call 2026-09-01). The embed URL
//   #/e/<id>            static for everyone (players on a shared page)
//   #/e/<id>?t=<token>  editable: the token edits THIS diagram only
// carries its own edit token when Tony wants to edit inside Notion, so no
// key has to be typed, and Notion's desktop app (whose embeds cannot keep
// storage at all) works exactly like Chrome. The master edit key still
// unlocks any embed (the small key in the corner) and runs the home page.
//
// No header inside the embed: the rink fills the frame with the toolbar
// underneath and never scrolls, and nothing above it changes size while
// editing. A single corner cluster holds: publish status, Duplicate (a new
// embed with this drawing, edit link copied - paste it below to continue a
// sequence), and the key.
//
// The editor, renderer and rink art are imported from /diagrams/ - never
// copied. Rink names, per-rink icons, Add Rink and Duplicate Rink are hidden
// here by CSS; the drill state stays the Film Room interchange format.

import { openEditor, closeEditor, editorActions, currentState, isDirty } from '/diagrams/js/editor.js';
import { renderStateFlat } from '/diagrams/js/flat.js';
import { loadAssets } from '/diagrams/js/rink.js';
import { esc, toast, confirmSheet } from '/diagrams/js/ui.js';

const API = 'https://apps-api.coachtonyhockey.com';
const KEY = 'cthdn.key';
const $ = (s, r) => (r || document).querySelector(s);
const $$ = (s, r) => [...(r || document).querySelectorAll(s)];
const uid = () => Math.random().toString(36).slice(2, 10) + Date.now().toString(36).slice(-4);
const embedded = () => { try { return window.top !== window.self; } catch (_) { return true; } };

// The key lives in memory for the session and in localStorage where the
// embed is allowed storage (Chrome partitions it per site; Notion's desktop
// app blocks it outright - the memory copy is what keeps that working).
let memKey = '';
const editKey = () => { if (memKey) return memKey; try { return localStorage.getItem(KEY) || ''; } catch (_) { return ''; } };
const setKey = (k) => { memKey = k || ''; try { if (k) localStorage.setItem(KEY, k); else localStorage.removeItem(KEY); } catch (_) {} };
let urlToken = '';
const viewUrl = (id) => `${location.origin}${location.pathname}#/e/${id}`;
const editUrl = (id, token) => `${viewUrl(id)}?t=${encodeURIComponent(token)}`;

async function api(path, opts = {}) {
  const headers = { 'content-type': 'application/json', ...(opts.headers || {}) };
  if (editKey()) headers['X-DG-Key'] = editKey();
  if (urlToken) headers['X-DG-Token'] = urlToken;
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
  const m = h.match(/^#\/e\/([\w-]+)(?:\?(.*))?$/);
  if (m) {
    const q = new URLSearchParams(m[2] || '');
    urlToken = q.get('t') || '';
    await showEmbed(m[1], q.has('static'));
    return;
  }
  urlToken = '';
  await showHome();
}

// ------------------------------------------------------------- home

async function showHome() {
  const app = $('#app');
  if (!editKey()) {
    app.innerHTML = `<div class="dn"><div class="dn-signin"><h1>CTH Diagrams Notion</h1><p>Diagrams that live inside your Notion pages: editable for you, static for the players you share them with.</p><button class="btn btn-ink" id="dnSignIn">Enter Edit Key</button></div></div>`;
    $('#dnSignIn').onclick = () => keyForm($('.dn-signin'), route);
    return;
  }
  app.innerHTML = `<div class="dn"><div class="dn-home"><header class="dn-home-head"><a class="btn btn-back" href="/" aria-label="Hub">Hub</a><h1>Diagrams Notion</h1><button class="btn" id="dnSignOut">Sign Out</button><button class="btn btn-ink" id="dnNew">+ New Diagram</button></header><p class="dn-hint">Paste a diagram's <b>edit link</b> into a Notion embed to draw on it there; the same embed is static for anyone you share the page with unless they have the link's token. The plain link is always static.</p><div class="dn-cards" id="dnCards"><p class="dn-empty">Loading…</p></div></div></div>`;
  $('#dnNew').onclick = newDiagram;
  $('#dnSignOut').onclick = () => { setKey(''); route(); };
  let list;
  try { list = (await api('/dg/')).diagrams || []; }
  catch (e) { if (e.status === 401) { setKey(''); toast('That edit key was refused', true); route(); return; } $('#dnCards').innerHTML = `<p class="dn-empty">${esc(e.message)}</p>`; return; }
  const host = $('#dnCards');
  if (!list.length) { host.innerHTML = '<p class="dn-empty">No diagrams yet. Make one, then paste its edit link into a Notion embed block.</p>'; return; }
  host.innerHTML = list.map((d) => `
    <div class="dn-card" data-id="${esc(d.id)}">
      <div class="dn-card-thumb"><img data-thumb="${esc(d.id)}" alt=""></div>
      <div class="dn-card-meta"><span class="dn-card-name">${esc(d.name || 'Untitled Diagram')}</span><span class="dn-card-sub">${new Date(d.updated).toLocaleDateString()}</span></div>
      <div class="dn-card-acts"><button class="btn mini" data-edit>Copy Edit Link</button><button class="btn mini" data-link>Copy View Link</button><button class="btn mini" data-del>Delete</button></div>
    </div>`).join('');
  $$('.dn-card', host).forEach((c) => {
    const id = c.dataset.id;
    c.onclick = (e) => { if (e.target.closest('button')) return; location.hash = `#/e/${id}`; };
    $('[data-link]', c).onclick = () => showLink(viewUrl(id), 'View link');
    $('[data-edit]', c).onclick = async () => { try { const doc = await api(`/dg/${id}`); showLink(editUrl(id, doc.token), 'Edit link'); } catch (e) { toast(e.message, true); } };
    $('[data-del]', c).onclick = async () => { const d = list.find((x) => x.id === id); if (!(await confirmSheet({ title: `Delete "${d.name || 'Untitled Diagram'}"?`, body: 'Any Notion page embedding it will show "That diagram does not exist."' }))) return; await api(`/dg/${id}`, { method: 'DELETE' }); c.remove(); };
  });
  for (const d of list) {
    try { const doc = await api(`/dg/${d.id}`); if (doc.state) { await assets(); const c = await renderStateFlat(doc.state, 0.15); const img = $(`img[data-thumb="${d.id}"]`); if (img) img.src = c.toDataURL('image/jpeg', 0.8); } } catch (_) {}
  }
}

async function newDiagram() {
  const id = uid();
  try { await api(`/dg/${id}`, { method: 'PUT', body: JSON.stringify({ name: '', state: null }) }); }
  catch (e) { toast(e.message, true); return; }
  location.hash = `#/e/${id}`;
}

// Links and keys are shown in an in-page panel - a dialog is blocked
// inside a cross-site iframe (a Notion embed), and so is the clipboard at
// times, so the link is always selectable as text too.
function panel(html) { $('.dn-panel')?.remove(); const f = document.createElement('div'); f.className = 'dn-panel'; f.innerHTML = html; document.body.appendChild(f); f.addEventListener('keydown', (e) => { e.stopPropagation(); if (e.key === 'Escape') f.remove(); }); return f; }
function showLink(url, label) {
  const f = panel(`<label>${esc(label)}<input type="text" readonly value="${esc(url)}"></label><div class="dn-panel-acts"><button type="button" class="btn" data-cancel>Close</button><button type="button" class="btn btn-ink" data-copy>Copy</button></div><p class="dn-panel-msg" hidden></p>`);
  const inp = $('input', f); inp.focus(); inp.select();
  const msg = $('.dn-panel-msg', f);
  const copy = () => { const done = () => { msg.hidden = false; msg.textContent = 'Copied - paste it into a Notion /embed block.'; }; navigator.clipboard?.writeText(url).then(done, () => { inp.select(); msg.hidden = false; msg.textContent = 'Select the link and press ⌘C.'; }); };
  $('[data-copy]', f).onclick = copy;
  $('[data-cancel]', f).onclick = () => f.remove();
  copy();
}
function keyForm(anchor, onDone) {
  const f = panel('<label>Edit key<input type="password" name="key" autocomplete="current-password" spellcheck="false" placeholder="Paste your edit key"></label><div class="dn-panel-acts"><button type="button" class="btn" data-cancel>Cancel</button><button type="button" class="btn btn-ink" data-ok>Unlock</button></div><p class="dn-panel-msg" hidden></p>');
  if (anchor) { f.classList.add('dn-panel--inline'); anchor.appendChild(f); }
  const inp = $('input', f); const msg = $('.dn-panel-msg', f); inp.focus();
  const go = async () => {
    const k = inp.value.trim(); if (!k) return;
    setKey(k);
    try { await api('/dg/'); } catch (ex) { setKey(''); msg.hidden = false; msg.textContent = ex.status === 401 ? 'That edit key was refused.' : ex.message; return; }
    f.remove(); onDone();
  };
  $('[data-ok]', f).onclick = go;
  inp.addEventListener('keydown', (e) => { if (e.key === 'Enter') { e.preventDefault(); go(); } });
  $('[data-cancel]', f).onclick = () => f.remove();
}

// ------------------------------------------------------------- embed

async function showEmbed(id, forceStatic) {
  const app = $('#app');
  app.innerHTML = '<div class="dn"><p class="dn-empty">Loading…</p></div>';
  let doc;
  try { doc = await api(`/dg/${id}`); }
  catch (e) { app.innerHTML = `<div class="dn"><p class="dn-empty">${esc(e.message)}</p></div>`; return; }
  document.title = `${doc.name || 'Diagram'} - CTH Diagrams Notion`;
  // The Worker only returns `token` to an authorised caller: that is the
  // proof this browser may edit.
  if (doc.token && !forceStatic) { await showEditor(doc); return; }
  await showStatic(doc);
}

const CHEV_ICON = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="m9 18 6-6-6-6"/></svg>';
const DOWN_ICON = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="m6 9 6 6 6-6"/></svg>';
const KEY_ICON = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><circle cx="7.5" cy="15.5" r="4.5"/><path d="M10.7 12.3 21 2M15 8l3 3M18 5l3 3"/></svg>';
const DUP_ICON = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><rect x="9" y="9" width="12" height="12" rx="2"/><path d="M5 15V5a2 2 0 0 1 2-2h10"/></svg>';

// THE MINIMAL RAIL (2026-09-03, Tony's call). The shared toolbar paints ~25
// buttons; at 44px wide in a Notion embed that is a scrolling column taller
// than the rink. These are the ones that stay out: everything else folds
// behind More. Chosen as what a drill actually needs - a select, a skate, a
// pass, the three player colours, a puck - not as a category.
const CORE_TOOLS = new Set(['select', 'arrow', 'dasharrow', 'p-0', 'p-1', 'p-2', 'i-puck']);

async function showStatic(doc) {
  const app = $('#app');
  const st = doc.state;
  let body = `<p class="dn-empty">${esc(doc.name || 'This diagram')} has not been drawn yet.</p>`;
  if (st && Array.isArray(st.elements)) {
    await assets();
    const c = await renderStateFlat({ ...st, seq: 1 }, 0.5);
    body = `<img class="dn-still" src="${c.toDataURL('image/png')}" alt="${esc(doc.name || 'Rink diagram')}">`;
  }
  app.innerHTML = `<div class="dn dn-static"><div class="dn-view">${body}</div><div class="dn-cluster"><button class="dn-cbtn" id="dnLock" aria-label="Coach sign-in">${KEY_ICON}</button></div></div>`;
  $('#dnLock').onclick = () => { if ($('.dn-panel')) { $('.dn-panel').remove(); return; } keyForm(null, route); };
}

async function showEditor(doc) {
  const app = $('#app');
  const drill = { id: doc.id, name: doc.name || '', state: doc.state || undefined, created: doc.updated, updated: doc.updated };
  // Duplicate, the key and the publish dot USED TO FLOAT OVER THE RINK in a
  // bottom-left cluster. They sit in the rail's foot now (Tony, 2026-09-03):
  // nothing overlaps the ice, and the two of them are where every other
  // control already is. The foot is a sibling of #edBar because paintTools()
  // rewrites that element's innerHTML whenever the armed tool changes.
  app.innerHTML = `
    <div class="dn ed dn-edit" id="dnRoot" tabindex="-1">
      <span class="ed-status" id="edStatus" hidden></span>
      <div class="ed-main">
        <div class="ed-stagewrap" id="edStageWrap">
          <div class="ed-zoom" id="edZoom">
            <div class="ed-stage" id="edStage">
              <svg id="edSvg" xmlns="http://www.w3.org/2000/svg"><g id="edBgG"></g><g id="edEls"></g><g id="edUi"></g></svg>
            </div>
            <div class="ed-addrow" hidden><button class="ed-addbar" id="edAddBar" hidden>+ Add Rink</button><button class="ed-addbar" id="edDupBar" hidden>Duplicate Rink</button></div>
          </div>
        </div>
        <div class="dn-rail" id="dnRail">
          <div class="tb" id="edBar"></div>
          <div class="dn-foot">
            <button class="dn-fbtn" id="dnMore" aria-label="More tools" aria-expanded="false" title="More Tools">${DOWN_ICON}</button>
            <div class="dn-swatch" id="dnSwatch"></div>
            <span class="dn-rule"></span>
            <button class="dn-fbtn" id="dnDup" aria-label="Duplicate into a new embed" title="Duplicate Into A New Embed">${DUP_ICON}</button>
            <button class="dn-fbtn" id="dnLock" aria-label="Edit key" title="Edit Key">${KEY_ICON}</button>
            <span class="dn-dot on" id="dnPub" aria-label="Published"></span>
          </div>
        </div>
      </div>
      <button class="dn-tbtoggle" id="dnTb" aria-label="Hide tools" aria-expanded="true">${CHEV_ICON}</button>
      ${embedded() ? '' : '<div class="dn-cluster"><button class="dn-cbtn" id="dnBack" aria-label="Back to your diagrams">Back</button></div>'}
    </div>`;
  await assets();
  const root = $('#dnRoot');
  let pubT = 0; let inflight = null; let pending = false;
  const pub = $('#dnPub');
  const setPub = (state, label) => { if (pub) { pub.className = `dn-dot ${state}`; pub.setAttribute('aria-label', label); } };
  const publish = async (keepalive = false) => {
    clearTimeout(pubT);
    if (inflight) { pending = true; return; }
    setPub('busy', 'Publishing');
    inflight = api(`/dg/${doc.id}`, { method: 'PUT', keepalive, body: JSON.stringify({ name: drill.name, state: currentState() }) })
      .then(() => setPub('on', 'Published'))
      .catch((e) => { setPub('err', 'Not published'); if (e.status === 401) toast('Your edit key was refused - sign in again', true); })
      .finally(() => { inflight = null; if (pending) { pending = false; publish(); } });
    await inflight;
  };
  let dirty = false;
  const schedule = () => { dirty = true; clearTimeout(pubT); pubT = setTimeout(() => { dirty = false; publish(); }, 1200); setPub('wait', 'Unpublished changes'); };
  await openEditor(drill, { onDirty: (d) => { if (d) schedule(); }, onFrames: () => {} });

  $('#dnDup').onclick = async () => {
    try {
      await publish();
      const r = await api(`/dg/${doc.id}/duplicate`, { method: 'POST' });
      showLink(editUrl(r.id, r.token), 'New embed (edit link)');
    } catch (e) { toast(e.message, true); }
  };
  $('#dnLock').onclick = () => { if ($('.dn-panel')) { $('.dn-panel').remove(); return; } const f = panel(`<p class="dn-panel-msg">Editing is unlocked here.</p><div class="dn-panel-acts"><button type="button" class="btn" data-cancel>Close</button><button type="button" class="btn" data-out>Sign Out</button></div>`); $('[data-cancel]', f).onclick = () => f.remove(); $('[data-out]', f).onclick = () => { setKey(''); urlToken = ''; f.remove(); route(); }; };
  const back = $('#dnBack'); if (back) back.onclick = () => { location.hash = '#/'; };
  leaving = async () => { clearTimeout(pubT); if (dirty || isDirty() || pending) await publish(); await closeEditor(); };
  window.addEventListener('pagehide', () => { if (dirty) { clearTimeout(pubT); publish(true); } }, { once: true });

  // Keep the rink fitted and hard against the TOP of the frame. The editor's
  // SVG keeps a 170-unit label strip above the rink (out of 1600 + 240) even
  // with the label hidden; pulling the stage up by that strip is what closes
  // the blank margin Tony saw between the frame edge and the ice. The WIDTH
  // is not set here: the editor's own sizeStage() re-runs on every toolbar
  // click and used to shrink the rink to the frame height (the "rink jumps"
  // bug), so the stylesheet pins `.ed-zoom` to 100% with !important and the
  // inline width is ignored. Width always wins; the frame height follows.
  const fit = () => {
    const z = $('#edZoom'); const st = $('#edStage'); if (!z || !st) return;
    const w = z.clientWidth;
    st.style.marginTop = `${-(w * 170 / 3200)}px`;
    st.style.marginBottom = `${-(w * 70 / 3200)}px`;
  };
  new ResizeObserver(fit).observe($('#edZoom'));
  fit(); setTimeout(fit, 50);

  // ------------------------------------------------- rail: collapse + More
  const tbtn = $('#dnTb'); const mbtn = $('#dnMore');
  // Assigned further down, once the bar exists; setMore runs before then.
  let reflow = () => {};
  const readFlag = (k, dflt) => { try { const v = localStorage.getItem(k); return v === null ? dflt : v === '1'; } catch (_) { return dflt; } };
  const writeFlag = (k, v) => { try { localStorage.setItem(k, v ? '1' : '0'); } catch (_) { /* embeds may have no storage */ } };
  const setTb = (open) => {
    root.classList.toggle('dn-tbhide', !open);
    tbtn.setAttribute('aria-expanded', String(open));
    tbtn.setAttribute('aria-label', open ? 'Hide tools' : 'Show tools');
    writeFlag('cthdn.tb', open);
  };
  const setMore = (open) => {
    root.classList.toggle('dn-more', open);
    mbtn.setAttribute('aria-expanded', String(open));
    mbtn.setAttribute('aria-label', open ? 'Fewer tools' : 'More tools');
    writeFlag('cthdn.more', open);
    reflow();
  };
  setTb(readFlag('cthdn.tb', true));
  setMore(readFlag('cthdn.more', false));
  tbtn.onclick = () => { setTb(root.classList.contains('dn-tbhide')); focusDiagram(); };
  mbtn.onclick = () => { setMore(!root.classList.contains('dn-more')); focusDiagram(); };

  // Tag the folded-away buttons after every repaint. paintTools() replaces
  // the bar wholesale on each tool change, so this has to re-run then - and
  // it must not react to its own class writes, hence the attribute filter.
  const bar = $('#edBar');
  const swatchHost = $('#dnSwatch');
  const decorate = () => {
    // The colour presets move bodily into the foot. paintTools() rebuilds
    // them (with the right one marked .on) on every repaint, so the old set
    // is dropped and the new one re-homed each time; the click handlers it
    // bound travel with the nodes.
    const swatches = [...bar.querySelectorAll('.tb-swatch')];
    if (swatches.length) { swatchHost.replaceChildren(...swatches); }
    let armedHidden = false;
    for (const b of bar.children) {
      if (b.classList.contains('tb-sep')) continue;
      const id = b.dataset.tool || (b.dataset.slot !== undefined ? `c-${b.dataset.slot}` : b.dataset.act || '');
      const core = CORE_TOOLS.has(id) || id.startsWith('c-');
      b.classList.toggle('dn-x', !core);
      if (!core && b.classList.contains('on')) armedHidden = true;
    }
    // A SHORTCUT MUST NEVER ARM AN INVISIBLE TOOL. Pressing the key for
    // something behind More opens More, so the rail always shows what is
    // actually armed.
    if (armedHidden && !root.classList.contains('dn-more')) setMore(true);
  };
  // A HALF-VISIBLE TOOL READS AS BROKEN. Rather than scroll or clip when the
  // embed is short, the rail widens into a second (or third) column. The
  // wrap itself is CSS; the width is not - a column-wrapping flex box
  // reports its single-column width to the parent, so the rail would stay
  // 46px and simply hide column two. Hence the explicit count.
  const rail = $('#dnRail');
  const BTN = 30; const MAXW = 112; // three columns' worth of rail, at most
  reflow = () => {
    if (bar.clientHeight <= 0) return;
    const cs = getComputedStyle(bar);
    // Padding and borders are MEASURED, not assumed: guessing them left
    // column two three pixels short and clipped every time.
    const chrome = (rail.offsetWidth - bar.offsetWidth) + (bar.offsetWidth - bar.clientWidth)
      + parseFloat(cs.paddingLeft) + parseFloat(cs.paddingRight);
    // Open the rail to its widest, let the browser wrap where it likes, then
    // shrink to what the buttons actually occupy. The rail has to be sized
    // in JS at all because a column-wrapping flex box reports only its
    // SINGLE-column width to its parent: left to itself the rail stays 46px
    // wide and simply hides column two. Wrapping in a column depends on
    // height alone, so the block measured at the widest setting still holds
    // once the width comes back down.
    // Clear the scrolling fallback BEFORE probing: with overflow-y on, the
    // bar scrolls instead of wrapping, so a rail that fell back once on a
    // short frame would never widen again when the frame was pulled taller.
    bar.style.flexWrap = 'wrap';
    bar.style.overflowY = '';
    rail.style.width = `${chrome + MAXW}px`;
    // MEASURE the block the buttons actually occupy - do not rebuild it from
    // a button width. The player swatches carry side margins, so a column is
    // wider than a button, and every arithmetic guess at this clipped
    // column two by a few pixels.
    let lo = Infinity; let hi = -Infinity;
    for (const b of bar.children) {
      if (b.offsetParent === null) continue;
      const m = getComputedStyle(b);
      lo = Math.min(lo, b.offsetLeft - parseFloat(m.marginLeft));
      hi = Math.max(hi, b.offsetLeft + b.offsetWidth + parseFloat(m.marginRight));
    }
    if (!Number.isFinite(lo)) return;
    const span = Math.ceil(hi - lo);
    if (span > MAXW) {
      // Shorter than even the widest rail can hold: one plain scrolling
      // column, which at least never shows half a button.
      bar.style.flexWrap = 'nowrap';
      bar.style.overflowY = 'auto';
      rail.style.width = `${chrome + BTN}px`;
      return;
    }
    bar.style.overflowY = '';
    rail.style.width = `${chrome + span}px`;
  };
  // Every trigger measures TWICE: once next frame, once after the layout has
  // certainly landed. A ResizeObserver fires before the new size has settled,
  // so a single pass read the old bar height and left the rail at a width the
  // frame could no longer hold. reflow() is idempotent, so the second pass
  // costs nothing when the first was already right.
  let rafId = 0; let lateId = 0;
  const reflowSoon = () => {
    cancelAnimationFrame(rafId); clearTimeout(lateId);
    rafId = requestAnimationFrame(() => reflow());
    lateId = setTimeout(() => reflow(), 120);
  };
  decorate(); reflow();
  new MutationObserver(() => { decorate(); reflowSoon(); }).observe(bar, { childList: true });
  new ResizeObserver(reflowSoon).observe($('.ed-main'));
  window.addEventListener('resize', reflowSoon);

  // ------------------------------------- back to Select after every place
  // The shared editor deliberately KEEPS a tool armed (2026-08-30) so five
  // players drop in a row without re-picking. In an embed Tony wants the
  // opposite: draw one thing, get the cursor back, because the next action
  // is almost always moving what was just placed. Escape is the editor's own
  // "step out" key, so this reuses it rather than reaching into its state.
  // Counted off the RENDERED elements, not currentState(): #edEls holds one
  // node per element and is always there to read, which currentState() is
  // not mid-gesture.
  const count = () => document.getElementById('edEls')?.childElementCount ?? -1;
  let before = -1;
  window.addEventListener('pointerdown', () => { before = count(); }, true);
  window.addEventListener('pointerup', () => {
    // A popup open means the press was a menu choice, and Escape would close
    // the menu instead of disarming - leave those alone.
    if (document.querySelector('.pmenu, .lmenu')) return;
    if (document.getElementById('edInput')) return; // text is still being typed
    if (before < 0 || count() <= before) return;
    before = -1;
    window.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
  });

  // ------------------------------------------------------------- keyboard
  // THE KEYS ARE THE DIAGRAM'S, NOT THE NOTION PAGE'S. The editor listens on
  // this iframe's window, and a cross-origin iframe only receives keys while
  // it holds focus - otherwise every letter goes to Notion and starts
  // editing the page behind the embed. So: take focus on any pointer down,
  // keep it on a toolbar click (buttons would otherwise steal it and swallow
  // the next shortcut), and show a ring while we hold it.
  const focusDiagram = () => { try { window.focus(); } catch (_) {} root.focus({ preventScroll: true }); };
  root.addEventListener('pointerdown', focusDiagram, true);
  root.addEventListener('mouseup', () => { if (!root.contains(document.activeElement)) focusDiagram(); });
  const mark = () => root.classList.toggle('dn-focus', document.hasFocus());
  window.addEventListener('focus', mark); window.addEventListener('blur', mark);
  mark();
  if (!embedded()) focusDiagram();

  // The editor drops its tool popups ABOVE the button (a bottom bar habit).
  // Beside a right-hand rail that lands off the top of the frame, so move
  // each popup to the left of the rail, level with its button.
  new MutationObserver((muts) => {
    for (const m of muts) for (const n of m.addedNodes) {
      if (!(n instanceof HTMLElement) || !n.classList.contains('pmenu')) continue;
      const b = $('#edBar'); if (!b) continue;
      const br = b.getBoundingClientRect(); const h = n.offsetHeight; const mw = n.offsetWidth;
      const btnTop = (parseFloat(n.style.top) || 0) + h + 10;
      n.style.left = `${Math.max(4, br.left - mw - 6)}px`;
      n.style.top = `${Math.max(4, Math.min(window.innerHeight - h - 4, btnTop + 16 - h / 2))}px`;
    }
  }).observe(document.body, { childList: true });
}

window.addEventListener('hashchange', route);
route();
