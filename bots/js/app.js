// CTH Bots - app shell. One board of bot cards; each card opens a run
// sheet that does one job. Adding a bot means adding an object to
// registry.js - this file never needs to know what a given bot does.
//
// Board  (#/)          the widget grid: drag to reorder, resize, recolour
// Run    (#/b/<id>)    that bot's inputs, its results, its history

import { BOTS, botById, defaultsFor, ICONS } from './registry.js';
import { getConfig, putConfig, getLayout, putLayout, addRun, listRuns, deleteRun, uid } from './store.js';
import { aiText, aiVision, aiImage, parseJson, AiError } from './ai.js';
import { toast, esc } from '../../diagrams/js/ui.js';

const $ = (s, r = document) => r.querySelector(s);
const $$ = (s, r = document) => [...r.querySelectorAll(s)];
const BACK_ICON = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M19 12H5M11 18l-6-6 6-6"/></svg>';

const cfgCache = new Map();
async function cfgOf(bot) {
  if (cfgCache.has(bot.id)) return cfgCache.get(bot.id);
  const saved = (await getConfig(bot.id)) || {};
  const cfg = { ...defaultsFor(bot), ...saved };
  cfgCache.set(bot.id, cfg);
  return cfg;
}
async function saveCfg(bot, patch) {
  const cfg = { ...(await cfgOf(bot)), ...patch };
  cfgCache.set(bot.id, cfg);
  await putConfig(bot.id, cfg);
  return cfg;
}

// ------------------------------------------------------------- the board
//
// ONE PAGE (2026-08-27, Tony's call). A card is not a link to a bot - the
// card IS the bot: its inputs, its Run button, its results and its recent
// runs all live inside it. Nothing navigates away, several bots can be
// working at once, and the board is the whole app.

const DEF_LAYOUT = () => ({ order: BOTS.map((b) => b.id), size: {}, hidden: [] });

async function layout() {
  const l = (await getLayout()) || DEF_LAYOUT();
  const known = new Set(l.order || []);
  const order = [...(l.order || []).filter((id) => botById(id)), ...BOTS.filter((b) => !known.has(b.id)).map((b) => b.id)];
  return { order, size: l.size || {}, hidden: l.hidden || [] };
}

const GEAR = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="12" r="3"/><path d="M19.4 15a1.65 1.65 0 0 0 .33 1.82l.06.06a2 2 0 1 1-2.83 2.83l-.06-.06a1.65 1.65 0 0 0-1.82-.33 1.65 1.65 0 0 0-1 1.51V21a2 2 0 1 1-4 0v-.09A1.65 1.65 0 0 0 9 19.4a1.65 1.65 0 0 0-1.82.33l-.06.06a2 2 0 1 1-2.83-2.83l.06-.06A1.65 1.65 0 0 0 4.6 15a1.65 1.65 0 0 0-1.51-1H3a2 2 0 1 1 0-4h.09A1.65 1.65 0 0 0 4.6 9a1.65 1.65 0 0 0-.33-1.82l-.06-.06a2 2 0 1 1 2.83-2.83l.06.06A1.65 1.65 0 0 0 9 4.6a1.65 1.65 0 0 0 1-1.51V3a2 2 0 1 1 4 0v.09a1.65 1.65 0 0 0 1 1.51 1.65 1.65 0 0 0 1.82-.33l.06-.06a2 2 0 1 1 2.83 2.83l-.06.06A1.65 1.65 0 0 0 19.4 9c.14.35.44.6.81.71H21a2 2 0 1 1 0 4h-.09a1.65 1.65 0 0 0-1.51 1z"/></svg>';

function cardHtml(bot, cfg, sz, hidden) {
  const styles = cfg.styles || [];
  return `
    <article class="bot-card${hidden ? ' is-hidden' : ''}" data-bot="${bot.id}" data-w="${sz.w}" data-h="${sz.h}"
             style="--bot:${esc(cfg.color || bot.color)}">
      <header class="bc-head">
        <span class="bot-ic">${bot.icon}</span>
        <h2 class="bot-name">${esc(bot.name)}</h2>
        <span class="bot-flex"></span>
        <button class="bc-icon" data-cfg title="Bot Settings" aria-label="Bot Settings">${GEAR}</button>
        <span class="bot-grip" title="Drag To Rearrange" aria-hidden="true"></span>
      </header>
      <p class="bot-blurb">${esc(bot.blurb)}</p>
      <div class="bc-form">
        ${(bot.inputs || []).map((f) => `
          <label class="run-field">
            <span>${esc(f.label)}</span>
            ${f.type === 'textarea'
              ? `<textarea data-in="${f.key}" rows="3" placeholder="${esc(f.placeholder || '')}"></textarea>`
              : `<input type="${f.type === 'url' ? 'url' : 'text'}" data-in="${f.key}" placeholder="${esc(f.placeholder || '')}">`}
          </label>`).join('')}
        ${bot.kind === 'image' && styles.length ? `
          <div class="run-field">
            <span>Style</span>
            <div class="run-styles" data-styles>
              <button class="style-chip on" data-style="best" title="Let the bot pick the strongest style for this subject">${ICONS.sparkle}Best</button>
              ${styles.map((st) => `<button class="style-chip" data-style="${esc(st.id)}">${esc(st.name)}</button>`).join('')}
            </div>
          </div>` : ''}
        <div class="bc-go">
          <button class="btn btn-ink" data-run>${esc(bot.kind === 'image' ? 'Generate' : 'Run')}</button>
          <span class="run-status" data-status aria-live="polite"></span>
          <span class="bot-flex"></span>
          <button class="mini" data-stop hidden>Stop</button>
          <button class="mini" data-hide title="${hidden ? 'Show' : 'Hide'} This Bot">${hidden ? 'Show' : 'Hide'}</button>
        </div>
      </div>
      <div class="bc-out" data-out></div>
      <div class="bc-hist" data-hist></div>
      <span class="bot-resize" title="Drag To Resize" aria-hidden="true"></span>
    </article>`;
}

async function showBoard() {
  document.title = 'CTH Bots';
  const l = await layout();
  const cfgs = new Map();
  for (const b of BOTS) cfgs.set(b.id, await cfgOf(b));

  $('#app').innerHTML = `
    <header class="lib-head">
      <div class="brand">
        <button class="btn btn-back" id="botHome" title="Back To CTH Apps">${BACK_ICON}</button>
        <img class="brand-logo" src="../diagrams/assets/cth-icon-black.svg" alt="CTH">
        <div class="brand-word"><h1>CTH Bots</h1></div>
      </div>
      <div class="lib-actions">
        <button class="mini" id="botShowAll">Show All</button>
        <button class="mini" id="botReset">Reset Layout</button>
        <button class="btn" id="botSetup">Setup</button>
      </div>
    </header>
    <main class="bot-board" id="botBoard">
      ${l.order.map((id) => {
        const b = botById(id);
        return b ? cardHtml(b, cfgs.get(id), l.size[id] || { w: 1, h: 1 }, l.hidden.includes(id)) : '';
      }).join('')}
    </main>`;

  $('#botHome').onclick = () => { location.href = '../'; };
  $('#botSetup').onclick = () => showSetup();
  $('#botShowAll').onclick = async () => { await putLayout({ ...l, hidden: [] }); showBoard(); };
  $('#botReset').onclick = async () => { await putLayout(DEF_LAYOUT()); showBoard(); };

  const board = $('#botBoard');
  for (const el of board.querySelectorAll('.bot-card')) await wireCard(el, l);
  wireDrag(board, l);
  wireResize(board, l);
}

// Everything one card needs, scoped to that card - so two bots can run at
// the same time without touching each other's state.
async function wireCard(card, l) {
  const bot = botById(card.dataset.bot);
  if (!bot) return;
  const cfg = await cfgOf(bot);
  const q = (sel) => card.querySelector(sel);
  const status = q('[data-status]');
  const say = (m) => { status.textContent = m; };
  let style = 'best';
  let ctrl = null;

  card.querySelectorAll('[data-style]').forEach((b) => {
    b.onclick = () => {
      style = b.dataset.style;
      card.querySelectorAll('[data-style]').forEach((o) => o.classList.toggle('on', o === b));
    };
  });
  q('[data-cfg]').onclick = () => showSettings(bot);
  q('[data-hide]').onclick = async () => {
    const id = bot.id;
    const hidden = l.hidden.includes(id) ? l.hidden.filter((x) => x !== id) : [...l.hidden, id];
    await putLayout({ ...l, hidden });
    showBoard();
  };

  const go = q('[data-run]');
  const stop = q('[data-stop]');
  go.onclick = async () => {
    const vals = {};
    for (const f of bot.inputs || []) vals[f.key] = q(`[data-in="${f.key}"]`)?.value.trim() || '';
    const first = bot.inputs?.[0];
    if (first && !vals[first.key]) { toast(`${first.label} Is Empty`, true); q(`[data-in="${first.key}"]`)?.focus(); return; }
    ctrl = new AbortController();
    go.disabled = true;
    stop.hidden = false;
    stop.onclick = () => ctrl.abort();
    card.classList.add('is-busy');
    try {
      const fresh = await cfgOf(bot);
      if (bot.kind === 'text') await runText(card, bot, fresh, vals, say, ctrl.signal);
      else await runImage(card, bot, fresh, vals, style, say, ctrl.signal);
    } catch (e) {
      if (e.name === 'AbortError') { say('Stopped'); q('[data-out]').innerHTML = ''; }
      else { console.error(e); say(''); paintError(card, e); toast(e.message || 'That Run Failed', true); }
    }
    go.disabled = false;
    stop.hidden = true;
    card.classList.remove('is-busy');
    ctrl = null;
  };

  await paintHistory(card, bot);
}

// Drag by the grip only: the card is full of text fields now, and a
// draggable card steals every selection and caret drag inside it.
function wireDrag(board, l) {
  let dragEl = null;
  board.querySelectorAll('.bot-card').forEach((el) => {
    const grip = el.querySelector('.bot-grip');
    grip.addEventListener('pointerdown', () => { el.draggable = true; });
    grip.addEventListener('pointerup', () => { el.draggable = false; });
    el.addEventListener('dragstart', (e) => {
      if (!el.draggable) { e.preventDefault(); return; }
      dragEl = el;
      el.classList.add('dragging');
      e.dataTransfer.effectAllowed = 'move';
      e.dataTransfer.setData('text/plain', el.dataset.bot);
    });
    el.addEventListener('dragend', async () => {
      el.classList.remove('dragging');
      el.draggable = false;
      dragEl = null;
      await putLayout({ ...l, order: [...board.querySelectorAll('.bot-card')].map((c) => c.dataset.bot) });
    });
    el.addEventListener('dragover', (e) => {
      if (!dragEl || dragEl === el) return;
      e.preventDefault();
      const r = el.getBoundingClientRect();
      board.insertBefore(dragEl, e.clientX < r.left + r.width / 2 ? el : el.nextSibling);
    });
  });
}

// Resize: width snaps to 1 or 2 columns; height sets how tall the results
// area is allowed to grow before it scrolls inside the card.
function wireResize(board, l) {
  board.querySelectorAll('.bot-resize').forEach((h) => {
    h.addEventListener('pointerdown', (e) => {
      e.preventDefault();
      e.stopPropagation();
      const card = h.closest('.bot-card');
      const r = card.getBoundingClientRect();
      const colW = r.width / Number(card.dataset.w || 1);
      h.setPointerCapture(e.pointerId);
      const move = (ev) => {
        card.dataset.w = String(Math.max(1, Math.min(2, Math.round((ev.clientX - r.left) / colW))));
        card.dataset.h = String((ev.clientY - r.top) > r.height * 1.15 ? 2 : 1);
      };
      const up = async () => {
        h.removeEventListener('pointermove', move);
        h.removeEventListener('pointerup', up);
        const size = { ...l.size, [card.dataset.bot]: { w: Number(card.dataset.w), h: Number(card.dataset.h) } };
        l.size = size;
        await putLayout({ ...l, size });
      };
      h.addEventListener('pointermove', move);
      h.addEventListener('pointerup', up);
    });
  });
}

// ------------------------------------------------------------- settings

const SWATCHES = ['#0a0a0a', '#2b7fff', '#16a34a', '#e7000b', '#f97316', '#eab308', '#7c3aed', '#0ea5e9', '#737373'];

async function showSettings(bot) {
  if (!bot) return;
  const cfg = await cfgOf(bot);
  const veil = document.createElement('div');
  veil.className = 'sheet-veil';
  const field = (s) => {
    const v = cfg[s.key];
    if (s.type === 'number') return `<label class="bs-row"><span>${esc(s.label)}</span><input type="number" data-k="${s.key}" min="${s.min ?? 1}" max="${s.max ?? 20}" value="${esc(String(v))}"></label>`;
    if (s.type === 'select') return `<label class="bs-row"><span>${esc(s.label)}</span><select data-k="${s.key}">${s.options.map((o) => `<option${o === v ? ' selected' : ''}>${esc(o)}</option>`).join('')}</select></label>`;
    if (s.type === 'folder') return `<label class="bs-row"><span>${esc(s.label)}</span><input type="text" data-k="${s.key}" value="${esc(String(v))}" placeholder="/visuals"></label>`;
    if (s.type === 'styles') return `
      <div class="bs-block">
        <div class="bs-head"><span>${esc(s.label)}</span>
          <span class="bot-flex"></span>
          <button class="mini" data-addstyle>+ Style</button>
          <button class="mini" data-fromimg>Add From Image</button>
        </div>
        <div class="bs-styles" data-styles>${(v || []).map(styleRow).join('')}</div>
        <p class="bs-note">Add From Image reads a screenshot and writes the style description for you.</p>
      </div>`;
    return `<label class="bs-row"><span>${esc(s.label)}</span><input type="text" data-k="${s.key}" value="${esc(String(v ?? ''))}"></label>`;
  };
  veil.innerHTML = `
    <div class="sheet sheet-pe" role="dialog" aria-modal="true">
      <div class="pe-top">
        <h3>${esc(bot.name)} Settings</h3>
        <p>${esc(bot.blurb)}</p>
      </div>
      <div class="pe-body">
        <section class="pe-section">
          <div class="pe-title">Card</div>
          <div class="bs-row"><span>Colour</span>
            <span class="bs-swatches">${SWATCHES.map((h) => `<button type="button" class="pe-sw${(cfg.color || bot.color).toLowerCase() === h ? ' on' : ''}" data-color="${h}" style="--c:${h}" aria-label="${h}"></button>`).join('')}</span>
          </div>
        </section>
        <section class="pe-section">
          <div class="pe-title">Behaviour</div>
          ${(bot.settings || []).map(field).join('')}
        </section>
        <section class="pe-section">
          <div class="pe-title">Instructions</div>
          <textarea class="bs-system" data-k="system" rows="6" spellcheck="false">${esc(cfg.system || bot.system)}</textarea>
          <p class="bs-note">This is what the model is told before every run of this bot. Clear it to fall back to the built-in instruction.</p>
        </section>
      </div>
      <div class="sheet-row pe-foot">
        <button class="btn" data-x="reset">Reset To Defaults</button>
        <span class="bot-flex"></span>
        <button class="btn" data-x="cancel">Cancel</button>
        <button class="btn btn-ink" data-x="save">Save Settings</button>
      </div>
    </div>`;
  document.body.appendChild(veil);
  const close = () => veil.remove();
  veil.addEventListener('mousedown', (e) => { if (e.target === veil) close(); });
  veil.querySelector('[data-x="cancel"]').onclick = close;

  let color = cfg.color || bot.color;
  veil.querySelectorAll('[data-color]').forEach((b) => {
    b.onclick = () => {
      color = b.dataset.color;
      veil.querySelectorAll('[data-color]').forEach((o) => o.classList.toggle('on', o === b));
    };
  });

  // ---- style list editing -------------------------------------------
  const stylesBox = veil.querySelector('[data-styles]');
  const wireStyles = () => {
    stylesBox?.querySelectorAll('[data-del]').forEach((b) => { b.onclick = () => b.closest('.bs-style').remove(); });
  };
  wireStyles();
  veil.querySelector('[data-addstyle]')?.addEventListener('click', () => {
    stylesBox.insertAdjacentHTML('beforeend', styleRow({ id: uid(), name: 'New Style', prompt: '' }));
    wireStyles();
  });
  veil.querySelector('[data-fromimg]')?.addEventListener('click', () => {
    const inp = document.createElement('input');
    inp.type = 'file';
    inp.accept = 'image/*';
    inp.onchange = async () => {
      const f = inp.files?.[0];
      if (!f) return;
      const btn = veil.querySelector('[data-fromimg]');
      btn.textContent = 'Reading…';
      try {
        const dataUrl = await new Promise((res, rej) => {
          const fr = new FileReader();
          fr.onload = () => res(fr.result);
          fr.onerror = rej;
          fr.readAsDataURL(f);
        });
        const text = await aiVision(
          'Describe this image AS A REUSABLE STYLE for generating new images. Do not describe the specific subject. Cover layout, colour, type treatment, lighting and mood in one dense sentence. Then on a new line give a 2 to 4 word name for the style. Return JSON: {"name":"...","prompt":"..."}',
          dataUrl,
        );
        const got = parseJson(text) || {};
        stylesBox.insertAdjacentHTML('beforeend', styleRow({
          id: uid(),
          name: got.name || 'From Image',
          prompt: got.prompt || String(text || '').slice(0, 400),
        }));
        wireStyles();
        toast('Style Added From The Image');
      } catch (e) {
        toast(e.message || 'Could Not Read That Image', true);
      }
      btn.textContent = 'Add From Image';
    };
    inp.click();
  });

  veil.querySelector('[data-x="reset"]').onclick = async () => {
    cfgCache.delete(bot.id);
    await putConfig(bot.id, {});
    cfgCache.delete(bot.id);
    close();
    toast('Settings Reset');
    showBoard();
  };
  veil.querySelector('[data-x="save"]').onclick = async () => {
    const patch = { color };
    veil.querySelectorAll('[data-k]').forEach((el) => {
      const key = el.dataset.k;
      patch[key] = el.type === 'number' ? Number(el.value) : el.value;
    });
    if (!String(patch.system || '').trim()) patch.system = bot.system;
    if (stylesBox) {
      patch.styles = [...stylesBox.querySelectorAll('.bs-style')].map((row) => ({
        id: row.dataset.id,
        name: row.querySelector('[data-sname]').value.trim() || 'Style',
        prompt: row.querySelector('[data-sprompt]').value.trim(),
      })).filter((x) => x.prompt);
    }
    await saveCfg(bot, patch);
    close();
    toast('Settings Saved');
    showBoard();
  };
}

const styleRow = (s) => `
  <div class="bs-style" data-id="${esc(s.id)}">
    <input data-sname value="${esc(s.name)}" placeholder="Name">
    <input data-sprompt value="${esc(s.prompt)}" placeholder="How it should look">
    <button class="mini mini-danger" data-del aria-label="Remove">&times;</button>
  </div>`;

// ------------------------------------------------------------- setup

function showSetup() {
  const veil = document.createElement('div');
  veil.className = 'sheet-veil';
  veil.innerHTML = `
    <div class="sheet sheet-wide" role="dialog" aria-modal="true">
      <h3>How CTH Bots Runs</h3>
      <p>The bots run on <strong>Workers AI</strong>, inside the same Cloudflare Worker that already serves Slides. There is <strong>no API key to create and nothing to paste</strong> - inference is billed to the Cloudflare account this Worker runs on.</p>
      <p>Because it runs at Cloudflare's edge rather than on your Mac, the bots work with your laptop shut.</p>
      <p>One command, once:</p>
      <div class="ph-formula"><code>cd ~/cth/work/cth-apps/present-worker &amp;&amp; npx wrangler deploy</code></div>
      <p class="bs-note">Speed is the tie-break everywhere: images use the four-step FLUX.2 klein models and text uses the fast Llama build, with the options for a run generated in parallel. The free allowance is 10,000 Neurons a day, then about a penny per thousand.</p>
      <div class="sheet-row"><button class="btn btn-ink" data-x="ok">Got It</button></div>
    </div>`;
  document.body.appendChild(veil);
  const close = () => veil.remove();
  veil.addEventListener('mousedown', (e) => { if (e.target === veil) close(); });
  veil.querySelector('[data-x="ok"]').onclick = close;
}

// ------------------------------------------------------- running a card
//
// Every renderer takes the CARD as its root, so two bots running at once
// never write into each other's results.

function paintError(card, e) {
  const out = card.querySelector('[data-out]');
  if (!out) return;
  const setup = e.code === 'missing' || e.code === 'nokey';
  out.innerHTML = `
    <div class="run-error">
      <span class="run-error-ic" aria-hidden="true"></span>
      <div>
        <p class="run-error-t">${esc(e.message || 'That run did not finish')}</p>
        <p class="run-error-b">${setup
          ? 'The bots run on Workers AI through your CTH Worker. It needs one deploy before any bot can run.'
          : 'Nothing was saved. Adjust the input and run it again.'}</p>
      </div>
      ${setup ? '<button class="btn" data-setup>Open Setup</button>' : ''}
    </div>`;
  out.querySelector('[data-setup]')?.addEventListener('click', () => showSetup());
}

async function runText(card, bot, cfg, vals, say, signal) {
  say('Thinking…');
  const out = card.querySelector('[data-out]');
  out.innerHTML = `<div class="run-skel">${'<div class="skel-line"></div>'.repeat(Math.min(5, cfg.count || 5))}</div>`;
  const text = await aiText(cfg.system || bot.system, bot.prompt(vals, cfg), signal);
  const parsed = parseJson(text);
  const items = Array.isArray(parsed) ? parsed
    : (parsed && Array.isArray(parsed.cues) ? parsed.cues
      : String(text).split('\n').map((l) => l.replace(/^\s*[-*\d.)]+\s*/, '').trim()).filter(Boolean).map((c) => ({ cue: c })));
  say('');
  const run = { id: uid(), bot: bot.id, at: Date.now(), kind: 'text', input: vals, items };
  await addRun(run);
  paintText(card, run);
  await paintHistory(card, bot);
}

function paintText(card, run) {
  const out = card.querySelector('[data-out]');
  if (!out) return;
  out.innerHTML = `
    <div class="run-head"><span class="pe-title">Results</span><span class="bot-flex"></span>
      <button class="mini" data-copyall>Copy All</button></div>
    <ol class="cue-list">
      ${run.items.map((it, i) => `
        <li class="cue-item">
          <span class="cue-n">${i + 1}</span>
          <div class="cue-body">
            <p class="cue-text">${esc(it.cue || it.text || '')}</p>
            ${it.why ? `<p class="cue-why">${esc(it.why)}</p>` : ''}
          </div>
          <button class="mini" data-copy="${esc(it.cue || it.text || '')}">Copy</button>
        </li>`).join('')}
    </ol>`;
  out.querySelectorAll('[data-copy]').forEach((b) => {
    b.onclick = async () => { await navigator.clipboard.writeText(b.dataset.copy); toast('Copied'); };
  });
  out.querySelector('[data-copyall]').onclick = async () => {
    await navigator.clipboard.writeText(run.items.map((i) => i.cue || i.text).join('\n'));
    toast('All Copied');
  };
}

const ASPECTS = { 'Landscape 16:9': '16:9', 'Square 1:1': '1:1', 'Portrait 4:5': '4:5' };

async function runImage(card, bot, cfg, vals, styleId, say, signal, extra = '') {
  const n = Math.max(1, Math.min(4, Number(cfg.count) || 3));
  const out = card.querySelector('[data-out]');
  out.innerHTML = `<div class="img-grid">${'<div class="img-skel"></div>'.repeat(n)}</div>`;

  let style = (cfg.styles || []).find((st) => st.id === styleId) || null;
  if (styleId === 'best') {
    say('Choosing A Style…');
    try {
      const names = (cfg.styles || []).map((st) => `${st.name}: ${st.prompt}`).join('\n');
      const pick = await aiText(
        cfg.system || bot.system,
        `Subject: ${vals.brief}\n\nCandidate styles:\n${names}\n\nChoose the single most effective style for this subject - or invent a better one. Return JSON: {"name":"...","prompt":"the full style description"}`,
        signal,
      );
      const got = parseJson(pick);
      if (got?.prompt) style = { id: 'best', name: got.name || 'Best', prompt: got.prompt };
    } catch (e) {
      if (e.name === 'AbortError') throw e;
      console.error(e);
    }
  }
  say(`Generating ${n}…`);
  const prompt = `${bot.prompt(vals, cfg, style)}${extra ? `\n${extra}` : ''}`;
  const images = await aiImage(prompt, ASPECTS[cfg.aspect] || '16:9', n, signal);
  say('');
  const run = {
    id: uid(), bot: bot.id, at: Date.now(), kind: 'image',
    input: vals, style: style ? style.name : 'Best', prompt, images,
  };
  await addRun(run);
  paintImages(card, bot, cfg, run);
  await paintHistory(card, bot);
}

function paintImages(card, bot, cfg, run) {
  const out = card.querySelector('[data-out]');
  if (!out) return;
  out.innerHTML = `
    <div class="run-head"><span class="pe-title">Results</span>
      <span class="chip-neutral">${esc(run.style)}</span>
      <span class="bot-flex"></span>
      <button class="mini" data-saveall>Save All</button></div>
    <div class="img-grid">
      ${run.images.map((src, i) => `
        <figure class="img-card" data-i="${i}">
          <img src="${src}" alt="Option ${i + 1}" loading="lazy">
          <figcaption>
            <button class="mini" data-save="${i}">Save</button>
            <button class="mini" data-regen="${i}">Refine</button>
            <span class="bot-flex"></span>
            <span class="img-n">${i + 1}</span>
          </figcaption>
        </figure>`).join('')}
    </div>`;
  out.querySelectorAll('[data-save]').forEach((b) => { b.onclick = () => saveImage(cfg, run, Number(b.dataset.save)); });
  out.querySelector('[data-saveall]').onclick = async () => {
    for (let i = 0; i < run.images.length; i++) await saveImage(cfg, run, i, true);
    toast(`Saved ${run.images.length} To ${cfg.folder}`);
  };
  out.querySelectorAll('[data-regen]').forEach((b) => {
    b.onclick = () => openRefine(card, bot, cfg, run, Number(b.dataset.regen));
  });
}

// Refine: mark a region on the option and say what to change. The box is
// turned into words for the prompt, which is what an image model can act
// on - it keeps the "point at it" feel without pretending to inpaint.
function openRefine(card, bot, cfg, run, i) {
  const veil = document.createElement('div');
  veil.className = 'sheet-veil';
  veil.innerHTML = `
    <div class="sheet sheet-wide" role="dialog" aria-modal="true">
      <h3>Refine Option ${i + 1}</h3>
      <p>Drag a box on the image to point at what should change, then say what you want. Leave the box off to change the whole image.</p>
      <div class="refine-stage"><img src="${run.images[i]}" alt=""><canvas class="refine-box"></canvas></div>
      <label class="run-field"><span>What Should Change</span>
        <textarea id="refineNote" rows="3" placeholder="e.g. make the arrow thicker and move the title to the top left"></textarea></label>
      <div class="sheet-row">
        <button class="btn" data-x="clear">Clear Box</button>
        <span class="bot-flex"></span>
        <button class="btn" data-x="cancel">Cancel</button>
        <button class="btn btn-ink" data-x="go">Generate Again</button>
      </div>
    </div>`;
  document.body.appendChild(veil);
  const close = () => veil.remove();
  veil.addEventListener('mousedown', (e) => { if (e.target === veil) close(); });
  veil.querySelector('[data-x="cancel"]').onclick = close;

  const stage = veil.querySelector('.refine-stage');
  const img = stage.querySelector('img');
  const cv = stage.querySelector('canvas');
  let box = null;
  const sync = () => {
    cv.width = img.clientWidth;
    cv.height = img.clientHeight;
    const ctx = cv.getContext('2d');
    ctx.clearRect(0, 0, cv.width, cv.height);
    if (!box) return;
    ctx.strokeStyle = '#2b7fff';
    ctx.lineWidth = 2;
    ctx.setLineDash([6, 4]);
    ctx.strokeRect(box.x, box.y, box.w, box.h);
    ctx.fillStyle = 'rgba(43,127,255,0.12)';
    ctx.fillRect(box.x, box.y, box.w, box.h);
  };
  img.onload = sync;
  if (img.complete) sync();
  cv.addEventListener('pointerdown', (e) => {
    const r = cv.getBoundingClientRect();
    const sx = e.clientX - r.left;
    const sy = e.clientY - r.top;
    cv.setPointerCapture(e.pointerId);
    const move = (ev) => {
      box = { x: Math.min(sx, ev.clientX - r.left), y: Math.min(sy, ev.clientY - r.top), w: Math.abs(ev.clientX - r.left - sx), h: Math.abs(ev.clientY - r.top - sy) };
      sync();
    };
    const up = () => { cv.removeEventListener('pointermove', move); cv.removeEventListener('pointerup', up); };
    cv.addEventListener('pointermove', move);
    cv.addEventListener('pointerup', up);
  });
  veil.querySelector('[data-x="clear"]').onclick = () => { box = null; sync(); };
  veil.querySelector('[data-x="go"]').onclick = async () => {
    const note = veil.querySelector('#refineNote').value.trim();
    let where = '';
    if (box && box.w > 6 && box.h > 6) {
      const cx = (box.x + box.w / 2) / cv.width;
      const cy = (box.y + box.h / 2) / cv.height;
      const col = cx < 0.34 ? 'left' : cx > 0.66 ? 'right' : 'centre';
      const row = cy < 0.34 ? 'top' : cy > 0.66 ? 'bottom' : 'middle';
      where = `Focus the change on the ${row} ${col} area of the image. `;
    }
    close();
    const say = (m) => { const st = card.querySelector('[data-status]'); if (st) st.textContent = m; };
    try {
      await runImage(card, bot, cfg, run.input, 'best', say, undefined,
        `Keep the overall composition of the previous version. ${where}${note ? `Change: ${note}` : 'Produce a stronger variation.'}`);
    } catch (e) { toast(e.message || 'Refine Failed', true); }
  };
}

async function saveImage(cfg, run, i, quiet = false) {
  try {
    const res = await fetch(run.images[i]);
    const blob = await res.blob();
    // The extension follows the ACTUAL bytes: FLUX hands back JPEG, so a
    // hardcoded .png wrote mislabelled files.
    const ext = (blob.type || '').includes('jpeg') ? 'jpg'
      : (blob.type || '').includes('webp') ? 'webp' : 'png';
    const stem = `${run.bot}-${new Date(run.at).toISOString().slice(0, 10)}-${run.id}-${i + 1}`;
    const fs = await import('../../clips/js/localfs.js');
    if (fs.fsSupported() && (fs.fsConnected() || fs.fsRemembered())) {
      if (!fs.fsConnected()) await fs.fsReconnect();
      const path = `${cfg.folder || '/visuals'}/${stem}.${ext}`;
      await fs.fsWrite(path, blob);
      if (!quiet) toast(`Saved To ${fs.fsLabel(path)}`);
      return;
    }
    const a = document.createElement('a');
    a.href = URL.createObjectURL(blob);
    a.download = `${stem}.${ext}`;
    a.click();
    if (!quiet) toast('Downloaded');
  } catch (e) {
    console.error(e);
    toast(e.message || 'Could Not Save That Image', true);
  }
}

async function paintHistory(card, bot) {
  const box = card.querySelector('[data-hist]');
  if (!box) return;
  const runs = (await listRuns()).filter((r) => r.bot === bot.id).slice(0, 5);
  if (!runs.length) { box.innerHTML = ''; return; }
  box.innerHTML = `
    <div class="run-head"><span class="pe-title">Recent</span></div>
    <div class="hist-list">
      ${runs.map((r) => `
        <button class="hist-row" data-open="${r.id}">
          <span class="hist-when">${new Date(r.at).toLocaleString([], { month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' })}</span>
          <span class="hist-what">${esc(String(Object.values(r.input || {})[0] || '').slice(0, 60))}</span>
          <span class="chip-neutral">${r.kind === 'image' ? `${r.images?.length || 0}` : `${r.items?.length || 0}`}</span>
          <span class="hist-del" data-del="${r.id}" title="Remove">&times;</span>
        </button>`).join('')}
    </div>`;
  box.querySelectorAll('[data-open]').forEach((b) => {
    b.onclick = async (e) => {
      if (e.target.closest('[data-del]')) {
        await deleteRun(e.target.dataset.del);
        await paintHistory(card, bot);
        return;
      }
      const r = runs.find((x) => x.id === b.dataset.open);
      if (!r) return;
      if (r.kind === 'image') paintImages(card, bot, await cfgOf(bot), r); else paintText(card, r);
    };
  });
}

// ------------------------------------------------------------- start
// One page: there is no route but the board.
void showBoard();
