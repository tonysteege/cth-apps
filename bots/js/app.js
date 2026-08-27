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

const DEF_LAYOUT = () => ({ order: BOTS.map((b) => b.id), size: {}, hidden: [] });

async function layout() {
  const l = (await getLayout()) || DEF_LAYOUT();
  // A bot added to the registry later still appears, at the end.
  const known = new Set(l.order || []);
  const order = [...(l.order || []).filter((id) => botById(id)), ...BOTS.filter((b) => !known.has(b.id)).map((b) => b.id)];
  return { order, size: l.size || {}, hidden: l.hidden || [] };
}

async function showBoard() {
  document.title = 'CTH Bots';
  const l = await layout();
  const cfgs = new Map();
  for (const b of BOTS) cfgs.set(b.id, await cfgOf(b));

  const card = (id) => {
    const b = botById(id);
    if (!b) return '';
    const c = cfgs.get(id);
    const sz = l.size[id] || { w: 1, h: 1 };
    const hidden = l.hidden.includes(id);
    return `
      <article class="bot-card${hidden ? ' is-hidden' : ''}" data-bot="${id}" data-w="${sz.w}" data-h="${sz.h}"
               style="--bot:${esc(c.color || b.color)}" draggable="true" tabindex="0">
        <span class="bot-grip" title="Drag To Rearrange" aria-hidden="true"></span>
        <span class="bot-ic">${b.icon}</span>
        <h2 class="bot-name">${esc(b.name)}</h2>
        <p class="bot-blurb">${esc(b.blurb)}</p>
        <div class="bot-foot">
          <button class="btn btn-ink bot-run" data-run="${id}">Open</button>
          <button class="mini" data-cfg="${id}" title="Bot Settings">Settings</button>
          <span class="bot-flex"></span>
          <button class="mini bot-eye" data-hide="${id}" title="${hidden ? 'Show On The Board' : 'Hide From The Board'}" aria-label="Hide">${hidden ? 'Show' : 'Hide'}</button>
        </div>
        <span class="bot-resize" title="Drag To Resize" aria-hidden="true"></span>
      </article>`;
  };

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
    <main class="bot-board" id="botBoard">${l.order.map(card).join('')}</main>`;

  $('#botHome').onclick = () => { location.href = '../'; };
  $('#botSetup').onclick = () => showSetup();
  $('#botShowAll').onclick = async () => { await putLayout({ ...l, hidden: [] }); showBoard(); };
  $('#botReset').onclick = async () => { await putLayout(DEF_LAYOUT()); showBoard(); };

  const board = $('#botBoard');
  board.querySelectorAll('[data-run]').forEach((b) => { b.onclick = () => { location.hash = `#/b/${b.dataset.run}`; }; });
  board.querySelectorAll('[data-cfg]').forEach((b) => { b.onclick = () => showSettings(botById(b.dataset.cfg)); });
  board.querySelectorAll('[data-hide]').forEach((b) => {
    b.onclick = async () => {
      const id = b.dataset.hide;
      const hidden = l.hidden.includes(id) ? l.hidden.filter((x) => x !== id) : [...l.hidden, id];
      await putLayout({ ...l, hidden });
      showBoard();
    };
  });
  board.querySelectorAll('.bot-card').forEach((el) => {
    el.addEventListener('dblclick', (e) => { if (!e.target.closest('button')) location.hash = `#/b/${el.dataset.bot}`; });
    el.addEventListener('keydown', (e) => { if (e.key === 'Enter') location.hash = `#/b/${el.dataset.bot}`; });
  });

  wireDrag(board, l);
  wireResize(board, l);
}

// Drag to reorder: the same drop-before-or-after the Clips tag panel uses.
function wireDrag(board, l) {
  let dragEl = null;
  board.querySelectorAll('.bot-card').forEach((el) => {
    el.addEventListener('dragstart', (e) => {
      if (e.target.closest('button')) { e.preventDefault(); return; }
      dragEl = el;
      el.classList.add('dragging');
      e.dataTransfer.effectAllowed = 'move';
      e.dataTransfer.setData('text/plain', el.dataset.bot);
    });
    el.addEventListener('dragend', async () => {
      el.classList.remove('dragging');
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

// Resize: drag the corner. Cards snap to a 1-2 column by 1-2 row span, so
// the board stays a grid instead of becoming a pile of arbitrary boxes.
function wireResize(board, l) {
  board.querySelectorAll('.bot-resize').forEach((h) => {
    h.addEventListener('pointerdown', (e) => {
      e.preventDefault();
      e.stopPropagation();
      const card = h.closest('.bot-card');
      const r = card.getBoundingClientRect();
      const colW = r.width / Number(card.dataset.w || 1);
      const rowH = r.height / Number(card.dataset.h || 1);
      h.setPointerCapture(e.pointerId);
      const move = (ev) => {
        const w = Math.max(1, Math.min(2, Math.round((ev.clientX - r.left) / colW)));
        const hh = Math.max(1, Math.min(2, Math.round((ev.clientY - r.top) / rowH)));
        card.dataset.w = String(w);
        card.dataset.h = String(hh);
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
    if (!location.hash.startsWith('#/b/')) showBoard();
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
    if (location.hash.startsWith('#/b/')) showRunner(bot.id); else showBoard();
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
      <p>The bots call models through the CTH Worker you already run for Slides, at <code>apps-api.coachtonyhockey.com</code>. The provider keys live there as Worker secrets, never in the site and never in this browser.</p>
      <p>One-time setup, from the repo:</p>
      <div class="ph-formula"><code>cd present-worker &amp;&amp; npx wrangler secret put ANTHROPIC_API_KEY</code></div>
      <div class="ph-formula"><code>npx wrangler secret put OPENAI_API_KEY</code></div>
      <div class="ph-formula"><code>npx wrangler deploy</code></div>
      <p class="bs-note">The first key powers the text bots and reading a style from a screenshot. The second powers image generation. Add only the one you need; a bot that has no key says so plainly instead of failing quietly.</p>
      <div class="sheet-row"><button class="btn btn-ink" data-x="ok">Got It</button></div>
    </div>`;
  document.body.appendChild(veil);
  const close = () => veil.remove();
  veil.addEventListener('mousedown', (e) => { if (e.target === veil) close(); });
  veil.querySelector('[data-x="ok"]').onclick = close;
}

// ------------------------------------------------------------- the runner

let running = null;

async function showRunner(id) {
  const bot = botById(id);
  if (!bot) { location.hash = '#/'; return; }
  const cfg = await cfgOf(bot);
  document.title = `${bot.name} - CTH Bots`;
  const styles = cfg.styles || [];

  $('#app').innerHTML = `
    <header class="lib-head">
      <div class="brand">
        <button class="btn btn-back" id="runBack" title="Back To The Board">${BACK_ICON}</button>
        <span class="run-ic" style="--bot:${esc(cfg.color || bot.color)}">${bot.icon}</span>
        <div class="brand-word"><h1>${esc(bot.name)}</h1></div>
      </div>
      <div class="lib-actions">
        <button class="mini" id="runCfg">Settings</button>
      </div>
    </header>
    <main class="run-wrap">
      <section class="run-form">
        ${(bot.inputs || []).map((f) => `
          <label class="run-field">
            <span>${esc(f.label)}</span>
            ${f.type === 'textarea'
              ? `<textarea data-in="${f.key}" rows="4" placeholder="${esc(f.placeholder || '')}"></textarea>`
              : `<input type="${f.type === 'url' ? 'url' : 'text'}" data-in="${f.key}" placeholder="${esc(f.placeholder || '')}">`}
          </label>`).join('')}
        ${bot.kind === 'image' && styles.length ? `
          <div class="run-field">
            <span>Style</span>
            <div class="run-styles" id="runStyles">
              <button class="style-chip on" data-style="best" title="Let the bot pick the strongest style for this subject">${ICONS.sparkle}Best</button>
              ${styles.map((s) => `<button class="style-chip" data-style="${esc(s.id)}">${esc(s.name)}</button>`).join('')}
            </div>
          </div>` : ''}
        <div class="run-go">
          <button class="btn btn-ink" id="runGo">Run ${esc(bot.name.replace(/ Bot$/, ''))}</button>
          <span class="run-status" id="runStatus" aria-live="polite"></span>
          <span class="bot-flex"></span>
          <button class="mini" id="runStop" hidden>Stop</button>
        </div>
      </section>
      <section class="run-out" id="runOut"></section>
      <section class="run-hist" id="runHist"></section>
    </main>`;

  $('#runBack').onclick = () => { location.hash = '#/'; };
  $('#runCfg').onclick = () => showSettings(bot);
  let style = 'best';
  $$('#runStyles .style-chip').forEach((b) => {
    b.onclick = () => {
      style = b.dataset.style;
      $$('#runStyles .style-chip').forEach((o) => o.classList.toggle('on', o === b));
    };
  });

  const status = $('#runStatus');
  const say = (m) => { status.textContent = m; };
  const go = $('#runGo');
  const stop = $('#runStop');

  go.onclick = async () => {
    const vals = {};
    for (const f of bot.inputs || []) vals[f.key] = $(`[data-in="${f.key}"]`)?.value.trim() || '';
    const first = bot.inputs?.[0];
    if (first && !vals[first.key]) { toast(`${first.label} Is Empty`, true); return; }
    const ctrl = new AbortController();
    running = ctrl;
    go.disabled = true;
    stop.hidden = false;
    stop.onclick = () => ctrl.abort();
    try {
      if (bot.kind === 'text') await runText(bot, cfg, vals, say, ctrl.signal);
      else await runImage(bot, cfg, vals, style, say, ctrl.signal);
    } catch (e) {
      // A failed run must not leave its loading bones on screen.
      if (e.name === 'AbortError') { say('Stopped'); $('#runOut').innerHTML = ''; }
      else {
        console.error(e);
        say('');
        paintError(e);
        toast(e.message || 'That Run Failed', true);
      }
    }
    go.disabled = false;
    stop.hidden = true;
    running = null;
  };

  await paintHistory(bot);
}

// The run failed. Say what went wrong and, where the cause is setup rather
// than a bad prompt, give the button that fixes it.
function paintError(e) {
  const out = $('#runOut');
  if (!out) return;
  const setup = e.code === 'missing' || e.code === 'nokey';
  out.innerHTML = `
    <div class="run-error">
      <span class="run-error-ic" aria-hidden="true"></span>
      <div>
        <p class="run-error-t">${esc(e.message || 'That run did not finish')}</p>
        <p class="run-error-b">${setup
          ? 'The bots call models through your CTH Worker. It needs one deploy and its keys set before any bot can run.'
          : 'Nothing was saved. Adjust the input and run it again.'}</p>
      </div>
      ${setup ? '<button class="btn" data-setup>Open Setup</button>' : ''}
    </div>`;
  out.querySelector('[data-setup]')?.addEventListener('click', () => showSetup());
}

async function runText(bot, cfg, vals, say, signal) {
  say('Thinking…');
  const out = $('#runOut');
  out.innerHTML = `<div class="run-skel">${'<div class="skel-line"></div>'.repeat(Math.min(6, cfg.count || 5))}</div>`;
  const text = await aiText(cfg.system || bot.system, bot.prompt(vals, cfg), signal);
  const parsed = parseJson(text);
  const items = Array.isArray(parsed) ? parsed
    : (parsed && Array.isArray(parsed.cues) ? parsed.cues
      : String(text).split('\n').map((l) => l.replace(/^\s*[-*\d.)]+\s*/, '').trim()).filter(Boolean).map((c) => ({ cue: c })));
  say('');
  const run = { id: uid(), bot: bot.id, at: Date.now(), kind: 'text', input: vals, items };
  await addRun(run);
  paintText(bot, run);
  await paintHistory(bot);
}

function paintText(bot, run) {
  const out = $('#runOut');
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

async function runImage(bot, cfg, vals, styleId, say, signal, extra = '') {
  const n = Math.max(1, Math.min(4, Number(cfg.count) || 3));
  const out = $('#runOut');
  out.innerHTML = `<div class="img-grid">${`<div class="img-skel"></div>`.repeat(n)}</div>`;

  // "Best" asks the text model to choose and write the strongest style for
  // this subject; a named style uses its own description directly.
  let style = (cfg.styles || []).find((s) => s.id === styleId) || null;
  if (styleId === 'best') {
    say('Choosing A Style…');
    try {
      const names = (cfg.styles || []).map((s) => `${s.name}: ${s.prompt}`).join('\n');
      const pick = await aiText(
        cfg.system || bot.system,
        `Subject: ${vals.brief}\n\nCandidate styles:\n${names}\n\nChoose the single most effective style for this subject - or invent a better one. Return JSON: {"name":"...","prompt":"the full style description"}`,
        signal,
      );
      const got = parseJson(pick);
      if (got?.prompt) style = { id: 'best', name: got.name || 'Best', prompt: got.prompt };
    } catch (e) {
      if (e.name === 'AbortError') throw e;
      // A missing text key must not block image generation.
      console.error(e);
    }
  }
  say(`Generating ${n} Option${n > 1 ? 's' : ''}…`);
  const prompt = `${bot.prompt(vals, cfg, style)}${extra ? `\n${extra}` : ''}`;
  const images = await aiImage(prompt, ASPECTS[cfg.aspect] || '16:9', n, signal);
  say('');
  const run = {
    id: uid(), bot: bot.id, at: Date.now(), kind: 'image',
    input: vals, style: style ? style.name : 'Best', prompt, images,
  };
  await addRun(run);
  paintImages(bot, cfg, run);
  await paintHistory(bot);
}

function paintImages(bot, cfg, run) {
  const out = $('#runOut');
  if (!out) return;
  out.innerHTML = `
    <div class="run-head"><span class="pe-title">Results</span>
      <span class="chip-neutral">${esc(run.style)}</span>
      <span class="bot-flex"></span>
      <button class="mini" data-saveall>Save All To ${esc(cfg.folder)}</button></div>
    <div class="img-grid">
      ${run.images.map((src, i) => `
        <figure class="img-card" data-i="${i}">
          <img src="${src}" alt="Option ${i + 1}">
          <figcaption>
            <button class="mini" data-save="${i}">Save</button>
            <button class="mini" data-regen="${i}">Refine</button>
            <span class="bot-flex"></span>
            <span class="img-n">${i + 1}</span>
          </figcaption>
        </figure>`).join('')}
    </div>`;

  out.querySelectorAll('[data-save]').forEach((b) => {
    b.onclick = () => saveImage(cfg, run, Number(b.dataset.save));
  });
  out.querySelector('[data-saveall]').onclick = async () => {
    for (let i = 0; i < run.images.length; i++) await saveImage(cfg, run, i, true);
    toast(`Saved ${run.images.length} To ${cfg.folder}`);
  };
  out.querySelectorAll('[data-regen]').forEach((b) => {
    b.onclick = () => openRefine(bot, cfg, run, Number(b.dataset.regen));
  });
}

// Refine: mark a region on the option and say what to change. The box is
// turned into words for the prompt, which is what an image model can act
// on - it keeps the "point at it" feel without pretending to inpaint.
function openRefine(bot, cfg, run, i) {
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
    const say = (m) => { const s = $('#runStatus'); if (s) s.textContent = m; };
    try {
      await runImage(bot, cfg, run.input, 'best', say, undefined,
        `Keep the overall composition of the previous version. ${where}${note ? `Change: ${note}` : 'Produce a stronger variation.'}`);
    } catch (e) { toast(e.message || 'Refine Failed', true); }
  };
}

async function saveImage(cfg, run, i, quiet = false) {
  try {
    const res = await fetch(run.images[i]);
    const blob = await res.blob();
    const stem = `${run.bot}-${new Date(run.at).toISOString().slice(0, 10)}-${run.id}-${i + 1}`;
    const fs = await import('../../clips/js/localfs.js');
    if (fs.fsSupported() && (fs.fsConnected() || fs.fsRemembered())) {
      if (!fs.fsConnected()) await fs.fsReconnect();
      const path = `${cfg.folder || '/visuals'}/${stem}.png`;
      await fs.fsWrite(path, blob);
      if (!quiet) toast(`Saved To ${fs.fsLabel(path)}`);
      return;
    }
    const a = document.createElement('a');
    a.href = URL.createObjectURL(blob);
    a.download = `${stem}.png`;
    a.click();
    if (!quiet) toast('Downloaded');
  } catch (e) {
    console.error(e);
    toast(e.message || 'Could Not Save That Image', true);
  }
}

async function paintHistory(bot) {
  const box = $('#runHist');
  if (!box) return;
  const runs = (await listRuns()).filter((r) => r.bot === bot.id).slice(0, 8);
  if (!runs.length) { box.innerHTML = ''; return; }
  box.innerHTML = `
    <div class="run-head"><span class="pe-title">Recent Runs</span></div>
    <div class="hist-list">
      ${runs.map((r) => `
        <button class="hist-row" data-open="${r.id}">
          <span class="hist-when">${new Date(r.at).toLocaleString([], { month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' })}</span>
          <span class="hist-what">${esc(String(Object.values(r.input || {})[0] || '').slice(0, 80))}</span>
          <span class="chip-neutral">${r.kind === 'image' ? `${r.images?.length || 0} images` : `${r.items?.length || 0} cues`}</span>
          <span class="hist-del" data-del="${r.id}" title="Remove">&times;</span>
        </button>`).join('')}
    </div>`;
  box.querySelectorAll('[data-open]').forEach((b) => {
    b.onclick = async (e) => {
      if (e.target.closest('[data-del]')) {
        await deleteRun(e.target.dataset.del);
        await paintHistory(bot);
        return;
      }
      const r = runs.find((x) => x.id === b.dataset.open);
      if (!r) return;
      if (r.kind === 'image') paintImages(bot, await cfgOf(bot), r); else paintText(bot, r);
    };
  });
}

// ------------------------------------------------------------- routing

async function go() {
  running?.abort();
  running = null;
  const h = location.hash || '#/';
  if (h.startsWith('#/b/')) await showRunner(h.slice(4));
  else await showBoard();
}

window.addEventListener('hashchange', () => void go());
void go();
