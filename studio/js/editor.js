// THE EDITOR - stage, tools, inspector, timeline.
//
// THE STAGE IS A CANVAS SHOWING THE FINISHED FRAME. Not the video with an
// overlay: the actual composited output, at the actual output aspect, with the
// actual telestration. So there is no "preview mode" and no surprise at export
// time - what is on the stage IS the file, and reframing to 9:16 is something
// you watch happen rather than something you hope for.
//
// EVERY CLOCK IN HERE IS OUTPUT TIME. Marks are timed in output seconds, the
// timeline is output seconds, the playhead is output seconds. Source time
// exists in exactly one place, `map.sourceAt`, and only the frame pump reads
// it. That is what makes a freeze free: draw during it and the mark spans it,
// with no special case anywhere.

import * as store from './store.js';
import * as dbx from './dropbox.js';
import * as lfs from '../../clips/js/localfs.js';
import { ScrubEngine } from './scrub.js';
import { composite, cameraAt, buildView, formatSize, FORMATS, QUALITY } from './render.js';
import { compile, sourceAt, rateAt, holdAt, addHold, addRate, addCut, removeOp, uid } from './timemap.js';
import { newMark, drawMark, hitTest, ptsAt, COLORS, COLOR_KEYS, markPhase, IN_DUR } from './marks.js';
import { canMP4, exportMP4, exportRecorded, exportGIF, exportFrame, FPS_CHOICES } from './encode.js';
import { el, h, toast, fail, sheet, confirmSheet, promptSheet, progress, icon, ICONS, tc, safeName } from './ui.js';

let cur = null;   // the whole editing session, or null when the library is up

const TOOLS = [
  { id: 'select',  key: 'v', glyph: '↖', label: 'Select' },
  { id: 'spot',    key: '1', glyph: '◎', label: 'Spot' },
  { id: 'beam',    key: '2', glyph: '▲', label: 'Beam' },
  { id: 'arrow',   key: 'a', glyph: '↗', label: 'Arrow' },
  { id: 'pen',     key: 'e', glyph: '✎', label: 'Pen' },
  { id: 'zone',    key: 'z', glyph: '▢', label: 'Zone' },
  { id: 'barrier', key: 'b', glyph: '≡', label: 'Wall' },
  { id: 'label',   key: 't', glyph: 'T',      label: 'Label' },
  { id: 'shade',   key: 'h', glyph: '■', label: 'Focus' },
  { id: 'camera',  key: 'c', glyph: '⊕', label: 'Punch' },
];

// ---- lifecycle -------------------------------------------------------------

export function closeEditor() {
  if (!cur) return;
  saveNow();
  cur.engine?.destroy();
  window.removeEventListener('keydown', onKey, true);
  window.removeEventListener('resize', onResize);
  document.removeEventListener('visibilitychange', saveNow);
  window.removeEventListener('pagehide', saveNow);
  if (cur.objectUrl) URL.revokeObjectURL(cur.objectUrl);
  cur = null;
}

export async function openEditor(project, { onBack, topbar }) {
  closeEditor();
  cur = {
    p: structuredClone(project),
    onBack,
    tool: 'select',
    color: store.settings().defaultColor || 'red',
    sel: null,
    draft: null,
    picture: null,     // the last frame handed over by the engine
    pictureT: 0,
    map: null,
    dirty: false,
    undo: [],
    redo: [],
    tracking: false,
    objectUrl: null,
  };
  buildLayout(topbar);
  window.addEventListener('keydown', onKey, true);
  window.addEventListener('resize', onResize);
  document.addEventListener('visibilitychange', saveNow);
  window.addEventListener('pagehide', saveNow);
  await loadFilm();
}

// ---- layout ----------------------------------------------------------------

function buildLayout(topbar) {
  const stage = h('canvas', { id: 'stage' });
  const hud = h('div', { class: 'stage-hud' });
  const badge = h('div', { class: 'stage-badge', hidden: true });
  const stageWrap = h('div', { class: 'stage-wrap' }, stage, badge, hud);
  const rail = h('aside', { class: 'rail panel' });
  const ruler = h('canvas', { id: 'ruler' });
  const tlBar = h('div', { class: 'tl-bar' });
  const tl = h('div', { class: 'timeline-wrap panel' }, tlBar, h('div', { class: 'tl-scroll' }, ruler));

  const nameBtn = h('button', {
    class: 'btn ghost title', style: { fontWeight: '600' }, title: 'Rename',
    onclick: async () => { const n = await promptSheet('Rename', 'Name', cur.p.name); if (n) { mutate((p) => { p.name = n; }); nameBtn.textContent = n; } },
  }, cur.p.name);

  const root = h('div', { id: 'app' },
    topbar
      ? topbar(
        h('button', { class: 'btn ghost', onclick: () => cur.onBack() }, icon(ICONS.back), 'Library'),
        nameBtn,
        formatSeg(),
        h('button', { class: 'btn primary', onclick: exportSheet }, icon(ICONS.export), 'Export'))
      : h('header', { class: 'topbar' }),
    h('main', { class: 'editor' }, stageWrap, rail, tl));
  el('app').replaceWith(root);

  Object.assign(cur, { stage, ctx: stage.getContext('2d', { alpha: false }), hud, badge, rail, ruler, tlBar, stageWrap });
  buildHud();
  buildRail();
  buildTimelineBar();
  attachStage();
  attachRuler();
  onResize();
}

function formatSeg() {
  const seg = h('div', { class: 'seg hide-phone' });
  for (const [k, f] of Object.entries(FORMATS)) {
    seg.appendChild(h('button', {
      class: cur.p.format?.aspect === k ? 'on' : '',
      title: `${f.label} - ${f.note}`,
      onclick: () => {
        mutate((p) => { p.format = { ...p.format, aspect: k }; });
        [...seg.children].forEach((b, i) => b.classList.toggle('on', Object.keys(FORMATS)[i] === k));
        onResize();
      },
    }, k));
  }
  return seg;
}

function buildHud() {
  const play = h('button', { class: 'icon-btn', 'aria-label': 'Play', onclick: togglePlay }, icon(ICONS.play, 18));
  const time = h('span', { class: 'tcode', text: '0:00.00' });
  cur.hudPlay = play; cur.hudTime = time;
  cur.hud.replaceChildren(
    play,
    time,
    h('span', { class: 'tcode muted', id: 'hudDur', text: '' }),
    h('div', { class: 'grow' }),
    h('button', { class: 'btn mini', title: 'Freeze here (F)', onclick: doFreeze }, 'Freeze'),
    h('button', { class: 'btn mini', title: 'Slow this second (S)', onclick: doSlow }, 'Slow'),
  );
}

function buildRail() {
  const tools = h('div', { class: 'tools' });
  for (const t of TOOLS) {
    tools.appendChild(h('button', {
      class: `tool ${cur.tool === t.id ? 'on' : ''}`,
      'data-tool': t.id,
      title: `${t.label} (${t.key.toUpperCase()})`,
      onclick: () => setTool(t.id),
    }, h('span', { class: 'g', text: t.glyph }), h('span', { text: t.label })));
  }

  const colors = h('div', { class: 'swatches' });
  for (const k of COLOR_KEYS) {
    colors.appendChild(h('button', {
      class: `swatch ${cur.color === k ? 'on' : ''}`,
      'data-color': k,
      'aria-label': k,
      style: { background: COLORS[k].base },
      onclick: () => setColor(k),
    }));
  }

  cur.inspector = h('div');
  cur.rail.replaceChildren(
    tools,
    h('section', {}, h('h3', { text: 'Colour' }), colors),
    h('section', { class: 'insp' }, h('h3', { text: 'Selected' }), cur.inspector),
    h('section', {}, h('h3', { text: 'Publish' }), publishPanel()),
  );
  cur.toolsHost = tools;
  cur.colorsHost = colors;
  paintInspector();
}

function buildTimelineBar() {
  cur.tlBar.replaceChildren(
    h('button', { class: 'btn mini', title: 'Trim start to playhead', onclick: () => trimHere('in') }, 'Trim in'),
    h('button', { class: 'btn mini', title: 'Trim end to playhead', onclick: () => trimHere('out') }, 'Trim out'),
    h('span', { class: 'chip', id: 'tlLen', text: '' }),
    h('div', { class: 'grow' }),
    h('button', { class: 'btn mini', title: 'Undo (Cmd+Z)', onclick: undo }, 'Undo'),
    h('button', { class: 'btn mini', title: 'Add a camera key here (C)', onclick: addCameraKey }, 'Punch key'),
    h('button', { class: 'btn mini danger', title: 'Remove the effect under the playhead', onclick: removeOpHere }, 'Clear fx'),
  );
}

// ---- film ------------------------------------------------------------------

async function loadFilm() {
  const v = el('film');
  const s = cur.p.source;
  if (!s) { toast('This video has no film attached.', 'warn'); return; }
  setBadge('Loading film', false);

  let url = '';
  let file = null;
  try {
    if (s.kind === 'local') {
      const mod = await import('./app.js');
      file = mod.takeFile(cur.p.id);
      if (!file) {
        setBadge('Film not loaded', true);
        const pick = await confirmSheet('Find the film again',
          'This project points at a file on this device. Browsers cannot reopen a picked file after a reload, so it has to be chosen again. The telestration is safe.',
          { ok: 'Choose file' });
        if (!pick) return;
        file = await dbx.openLocalFile();
        if (!file) return;
      }
      url = URL.createObjectURL(file);
      cur.objectUrl = url;
    } else if (s.kind === 'folder') {
      // A file in the local CTH folder. Unlike a picked file this DOES survive
      // a reload - the directory handle is remembered in IndexedDB - but the
      // browser can still let the grant lapse after a restart, so ask for it
      // back from a click rather than failing.
      if (!lfs.fsVideosReady()) {
        setBadge('Film not loaded', true);
        const ok = await confirmSheet('Reconnect your film folder',
          'This project points at a file in your local CTH folder. After a restart the browser needs you to grant access again from a click. The telestration is safe.',
          { ok: 'Reconnect' });
        if (!ok) return;
        if (lfs.fsVideoNeedsReconnect()) await lfs.fsReconnectVideoFolder();
        else await lfs.fsReconnect();
        if (!lfs.fsVideosReady()) { setBadge('Film unavailable', true); return; }
      }
      file = await lfs.fsGetFile(s.path);
      url = URL.createObjectURL(file);
      cur.objectUrl = url;
    } else if (s.kind === 'url') {
      // A plain URL: something already hosted, a Clips export, a share link.
      // It needs CORS and Range to scrub well, and degrades to seeking if not.
      url = s.url;
    } else {
      url = await dbx.tempLink(s.path);
    }
  } catch (e) { setBadge('Film unavailable', true); fail(e); return; }

  // THE RESOLVED ADDRESS IS SESSION STATE, NEVER PROJECT STATE. `source.url`
  // means one thing only: the durable address of a `kind:'url'` source, which
  // MUST persist. A Dropbox temp link expires in four hours and an objectURL
  // dies with the page; writing either into the same field is how a saved
  // project came back pointing at "undefined". They live here instead.
  cur.mediaUrl = url;
  cur.mediaFile = file || null;
  v.src = url;

  await new Promise((res, rej) => {
    const ok = () => { v.removeEventListener('error', bad); res(); };
    const bad = () => { v.removeEventListener('loadedmetadata', ok); rej(new Error('That file would not open.')); };
    v.addEventListener('loadedmetadata', ok, { once: true });
    v.addEventListener('error', bad, { once: true });
  }).catch((e) => { setBadge('Film unavailable', true); fail(e); });

  // WAIT FOR PICTURE, NOT JUST FOR METADATA. `loadedmetadata` means the
  // duration and dimensions are known; `drawImage` still draws NOTHING until
  // readyState reaches HAVE_CURRENT_DATA. Painting the first frame in that
  // window leaves a black stage that only a later repaint clears - which on a
  // desktop happens by accident and on a phone does not happen at all.
  if (v.readyState < 2) {
    await new Promise((res) => {
      const done = () => { v.removeEventListener('loadeddata', done); clearTimeout(t); res(); };
      const t = setTimeout(done, 4000);
      v.addEventListener('loadeddata', done, { once: true });
    });
  }

  if (!v.videoWidth) return;
  mutate((p) => {
    p.source = { ...p.source, w: v.videoWidth, h: v.videoHeight, duration: v.duration };
    if (p.timeline.out == null) p.timeline.out = v.duration;
  }, { quiet: true });

  cur.engine = new ScrubEngine(v, {
    onFrame: (pic, srcT) => { cur.picture = pic; cur.pictureT = srcT; paint(); },
    onTime: (outT) => { paintClock(outT); drawRuler(); },
    settings: () => store.settings(),
  });
  recompile();
  cur.engine.attachWheel(cur.stage, { onPinch: pinchZoom });
  cur.engine.attachDrag(cur.stage, { shouldScrub: () => cur.tool === 'select' && !cur.sel });

  v.addEventListener('loadeddata', () => { if (cur) { cur.picture = v; paint(); } }, { once: true });

  setBadge('', false);
  // The decoder is the difference between a scrub that reads as film and one
  // that reads as a slideshow; it is opened in the background because it needs
  // to index the file first, and the app must be usable while it does.
  cur.engine.attach(`studio:${cur.p.id}`, file, (s.kind === 'local' || s.kind === 'folder') ? null : url)
    .then((src) => { if (src) setBadge('Fast scrub', false, 1400); })
    .catch(() => {});

  onResize();
  cur.engine.seek(0, true);
}

function setBadge(text, hot, hideAfter = 0) {
  if (!cur?.badge) return;
  cur.badge.hidden = !text;
  cur.badge.textContent = text;
  cur.badge.classList.toggle('hot', !!hot);
  if (text && hideAfter) setTimeout(() => { if (cur?.badge && cur.badge.textContent === text) cur.badge.hidden = true; }, hideAfter);
}

// ---- the frame -------------------------------------------------------------

function recompile() {
  cur.map = compile(cur.p.timeline, cur.p.source?.duration || 0);
  cur.engine?.setMap((t) => sourceAt(cur.map, t), cur.map.duration);
  const len = el('tlLen');
  if (len) len.textContent = `${tc(cur.map.duration, false)} out`;
  const dur = el('hudDur');
  if (dur) dur.textContent = `/ ${tc(cur.map.duration)}`;
  drawRuler();
}

function onResize() {
  if (!cur) return;
  const { w, h: hh } = formatSize(cur.p.format?.aspect || '16:9', 'hd');
  const box = cur.stageWrap.getBoundingClientRect();
  const pad = 18;
  const k = Math.min((box.width - pad * 2) / w, (box.height - pad * 2) / hh, 1.6);
  const dpr = Math.min(2, window.devicePixelRatio || 1);
  const cssW = Math.max(120, Math.floor(w * k));
  const cssH = Math.max(80, Math.floor(hh * k));
  cur.stage.style.width = `${cssW}px`;
  cur.stage.style.height = `${cssH}px`;
  // The backing store is the OUTPUT resolution capped by what the screen can
  // show. Painting at full 1080 into a 500px box costs four times the pixels
  // and shows none of them.
  const bw = Math.min(w, Math.round(cssW * dpr));
  const bh = Math.round(bw * (hh / w));
  if (cur.stage.width !== bw || cur.stage.height !== bh) { cur.stage.width = bw; cur.stage.height = bh; }
  sizeRuler();
  paint();
}

function paint() {
  if (!cur || !cur.map) return;
  const t = cur.engine ? cur.engine.time : 0;
  const src = cur.picture;
  const sw = src === el('film') ? (el('film').videoWidth || 16) : (src?.width || cur.p.source?.w || 16);
  const sh = src === el('film') ? (el('film').videoHeight || 9) : (src?.height || cur.p.source?.h || 9);
  const view = composite(cur.ctx, src, sw, sh, cur.p, t, { grade: cur.p.grade || 0, emphasize: cur.sel, skip: cur.draft ? new Set([cur.draft.id]) : null });
  cur.view = view;
  if (cur.draft) drawMark(cur.ctx, cur.draft, t, view, { solid: true });
  if (cur.sel) drawSelection(view, t);
  const hold = holdAt(cur.map, t);
  if (hold && !cur.badge.textContent) setBadge('Frozen', true);
  else if (cur.badge.textContent === 'Frozen') setBadge('', false);
}

function drawSelection(view, t) {
  const m = cur.p.marks.find((x) => x.id === cur.sel);
  if (!m) return;
  const ctx = cur.ctx;
  const pts = ptsAt(m, t).map((q) => ({ x: view.toX(q.x), y: view.toY(q.y) }));
  const r = Math.max(4, cur.stage.width * 0.007);
  ctx.save();
  ctx.strokeStyle = '#75d8ff';
  ctx.fillStyle = '#75d8ff';
  ctx.lineWidth = Math.max(1, cur.stage.width * 0.0018);
  for (const p of pts) {
    ctx.beginPath(); ctx.arc(p.x, p.y, r, 0, Math.PI * 2);
    ctx.fillStyle = '#0a0a0a'; ctx.fill();
    ctx.fillStyle = '#75d8ff'; ctx.beginPath(); ctx.arc(p.x, p.y, r * 0.62, 0, Math.PI * 2); ctx.fill();
  }
  if (m.keys && m.keys.length > 1) {
    // Show the track: where this mark travels across its life. Without it,
    // tracking is invisible until you scrub, which makes it feel broken.
    ctx.beginPath();
    ctx.setLineDash([r, r]);
    m.keys.forEach((k, i) => {
      const p = k.pts[0]; if (!p) return;
      const x = view.toX(p.x); const y = view.toY(p.y);
      if (i === 0) ctx.moveTo(x, y); else ctx.lineTo(x, y);
    });
    ctx.strokeStyle = 'rgba(117,216,255,.75)';
    ctx.stroke();
  }
  ctx.restore();
}

function paintClock(t) {
  if (cur?.hudTime) cur.hudTime.textContent = tc(t);
}

// ---- stage input -----------------------------------------------------------

function stagePoint(e) {
  const r = cur.stage.getBoundingClientRect();
  const px = ((e.clientX - r.left) / r.width) * cur.stage.width;
  const py = ((e.clientY - r.top) / r.height) * cur.stage.height;
  const v = cur.view || buildView(16 / 9, cur.stage.width, cur.stage.height, { cx: 0.5, cy: 0.5, zoom: 1 });
  return { px, py, x: v.fromX(px), y: v.fromY(py) };
}

function attachStage() {
  const s = cur.stage;
  let drag = null;

  s.addEventListener('pointerdown', (e) => {
    if (e.button === 2) return;
    const t = cur.engine ? cur.engine.time : 0;
    const pt = stagePoint(e);

    if (cur.tool === 'camera') { s.setPointerCapture(e.pointerId); drag = { kind: 'camera', pt, cam: cameraAt(cur.p.camera, t), t }; return; }

    if (cur.tool === 'select') {
      // Topmost first, so a label over a zone selects the label.
      const live = cur.p.marks.filter((m) => markPhase(m, t));
      const hit = [...live].reverse().find((m) => hitTest(m, t, cur.view, pt.px, pt.py));
      if (hit) {
        s.setPointerCapture(e.pointerId);
        cur.sel = hit.id;
        const handle = nearestHandle(hit, t, pt);
        drag = { kind: 'move', m: hit, handle, start: pt, from: ptsAt(hit, t).map((q) => ({ ...q })), t, moved: false };
        paintInspector(); paint();
        return;
      }
      cur.sel = null; paintInspector(); paint();
      return;
    }

    // A drawing tool.
    s.setPointerCapture(e.pointerId);
    const span = spanForNewMark(t);
    const kind = cur.tool;
    const m = newMark(kind, seedPoints(kind, pt), { t0: span.t0, t1: span.t1, color: cur.color });
    cur.draft = m;
    drag = { kind: 'draw', m, start: pt, t };
    paint();
  });

  s.addEventListener('pointermove', (e) => {
    if (!drag) return;
    const pt = stagePoint(e);
    if (drag.kind === 'camera') {
      const c = drag.cam;
      const dx = (pt.x - drag.pt.x); const dy = (pt.y - drag.pt.y);
      cur.liveCam = { cx: c.cx - dx, cy: c.cy - dy, zoom: c.zoom };
      applyCameraPreview();
      return;
    }
    if (drag.kind === 'draw') {
      shapePoints(drag.m, drag.start, pt);
      paint();
      return;
    }
    if (drag.kind === 'move') {
      drag.moved = true;
      const dx = pt.x - drag.start.x; const dy = pt.y - drag.start.y;
      const next = drag.from.map((q, i) => (
        drag.handle == null || drag.handle === i
          ? { x: clamp01(q.x + dx), y: clamp01(q.y + dy) }
          : { ...q }));
      writePoints(drag.m, next, drag.t);
      paint();
    }
  });

  const finish = (e) => {
    if (!drag) return;
    try { s.releasePointerCapture(e.pointerId); } catch (_) { /* already released */ }
    if (drag.kind === 'camera') {
      if (cur.liveCam) { const c = cur.liveCam; cur.liveCam = null; setCameraKey(drag.t, c); }
    } else if (drag.kind === 'draw') {
      const m = cur.draft;
      cur.draft = null;
      if (validMark(m, drag.start)) {
        if (m.kind === 'label') {
          promptSheet('Label', 'Text', '', { placeholder: 'CHIP OUT', ok: 'Add' }).then((text) => {
            if (!text) { paint(); return; }
            m.text = text;
            mutate((p) => p.marks.push(m));
            cur.sel = m.id; paintInspector(); paint(); drawRuler();
          });
        } else {
          mutate((p) => p.marks.push(m));
          cur.sel = m.id;
          paintInspector(); drawRuler();
        }
      }
      paint();
    } else if (drag.kind === 'move' && drag.moved) {
      commit();
      drawRuler();
    }
    drag = null;
  };
  s.addEventListener('pointerup', finish);
  s.addEventListener('pointercancel', finish);
  s.addEventListener('dblclick', async () => {
    const m = cur.p.marks.find((x) => x.id === cur.sel);
    if (!m) return;
    const text = await promptSheet('Label this', 'Text', m.text || '', { placeholder: 'DOUBLE SCREEN' });
    if (text === null) return;
    mutate((p) => { const q = p.marks.find((x) => x.id === m.id); q.text = text; });
    paint();
  });
  s.addEventListener('contextmenu', (e) => { e.preventDefault(); if (cur.sel) markMenu(); });
}

function seedPoints(kind, pt) {
  const p = { x: pt.x, y: pt.y };
  if (kind === 'spot' || kind === 'beam' || kind === 'label') return [p];
  return [p, { ...p }];
}

function shapePoints(m, a, b) {
  if (m.kind === 'spot' || m.kind === 'beam') {
    // Drag away from a spot to size it rather than move it - placing and
    // sizing in one gesture is what makes four beams take four seconds.
    m.pts = [{ x: a.x, y: a.y }];
    m.r = Math.max(0.02, Math.hypot(b.x - a.x, (b.y - a.y) * 1.9)) || 0.055;
    m.tilt = a.y;
    return;
  }
  if (m.kind === 'label') { m.pts = [{ x: b.x, y: b.y }, { x: a.x, y: a.y }]; return; }
  if (m.kind === 'pen') {
    const last = m.pts[m.pts.length - 1];
    if (!last || Math.hypot(b.x - last.x, b.y - last.y) > 0.004) m.pts.push({ x: b.x, y: b.y });
    return;
  }
  m.pts = [{ x: a.x, y: a.y }, { x: b.x, y: b.y }];
}

function validMark(m, start) {
  if (!m) return false;
  if (m.kind === 'spot' || m.kind === 'beam' || m.kind === 'label') return true;
  if (m.kind === 'pen') return m.pts.length > 2;
  const last = m.pts[m.pts.length - 1];
  return Math.hypot(last.x - start.x, last.y - start.y) > 0.012;
}

function nearestHandle(m, t, pt) {
  const pts = ptsAt(m, t);
  let best = null; let bd = Infinity;
  pts.forEach((q, i) => {
    const d = Math.hypot(cur.view.toX(q.x) - pt.px, cur.view.toY(q.y) - pt.py);
    if (d < bd) { bd = d; best = i; }
  });
  return bd < Math.max(12, cur.stage.width * 0.02) ? best : null;
}

// Writing a mark's points either moves it outright, or - when tracking is on -
// lays down a keyframe at this moment so the mark travels. Tracking is the
// single feature that turns "redraw the spotlight every eight frames" into
// "click the player twice".
function writePoints(m, pts, t) {
  if (!cur.tracking && !(m.keys && m.keys.length)) { m.pts = pts; return; }
  const keys = (m.keys && m.keys.length ? m.keys : [{ t: m.t0, pts: m.pts.map((q) => ({ ...q })) }]).slice();
  const i = keys.findIndex((k) => Math.abs(k.t - t) < 0.05);
  if (i >= 0) keys[i] = { t, pts };
  else { keys.push({ t, pts }); keys.sort((a, b) => a.t - b.t); }
  m.keys = keys;
  m.pts = keys[0].pts;
  // A tracked mark that ends before its last key would freeze mid-travel.
  if (m.t1 < keys[keys.length - 1].t) m.t1 = keys[keys.length - 1].t;
}

// A mark drawn while the picture is frozen should last exactly as long as the
// freeze - that is what the freeze was for. Otherwise it gets a sensible two
// seconds, clipped to the end of the video.
function spanForNewMark(t) {
  const hold = holdAt(cur.map, t);
  if (hold) return { t0: hold.o0, t1: hold.o1 };
  // IT STARTS ONE ANIMATION BEFORE THE PLAYHEAD, so it is fully ARRIVED at the
  // moment it was drawn. Starting it exactly at the playhead is the same thing
  // as drawing it at zero opacity: correct in the file, and it makes the second
  // and third mark of a set vanish as you place them.
  return { t0: Math.max(0, t - IN_DUR), t1: Math.min(cur.map.duration, t + 2) };
}

// ---- camera ----------------------------------------------------------------

function applyCameraPreview() {
  const t = cur.engine.time;
  const saved = cur.p.camera;
  cur.p.camera = [{ t: 0, ...cur.liveCam }];
  paint();
  cur.p.camera = saved;
}

function pinchZoom(e) {
  const t = cur.engine.time;
  const c = cameraAt(cur.p.camera, t);
  const zoom = Math.max(1, Math.min(5, c.zoom * (1 - e.deltaY * 0.004)));
  setCameraKey(t, { ...c, zoom });
}

function setCameraKey(t, camera) {
  mutate((p) => {
    const keys = [...(p.camera || [])];
    const i = keys.findIndex((k) => Math.abs(k.t - t) < 0.06);
    const next = { t, cx: clamp01(camera.cx), cy: clamp01(camera.cy), zoom: Math.max(1, camera.zoom) };
    if (i >= 0) keys[i] = next; else keys.push(next);
    keys.sort((a, b) => a.t - b.t);
    p.camera = keys;
  });
  paint(); drawRuler();
}

function addCameraKey() {
  const t = cur.engine.time;
  setCameraKey(t, cameraAt(cur.p.camera, t));
  toast('Camera key added. Drag with the Punch tool to move it.', 'ok');
}

// ---- time effects ----------------------------------------------------------

function doFreeze() {
  const t = cur.engine.time;
  const existing = holdAt(cur.map, t);
  if (existing) { mutate((p) => { p.timeline = removeOp(p.timeline, existing.op.id); }); recompile(); toast('Freeze removed.'); return; }
  const at = sourceAt(cur.map, t);
  mutate((p) => { p.timeline = addHold(p.timeline, at, store.settings().holdDur); });
  recompile();
  cur.engine.seek(t + 0.02, true);
  toast('Frozen. Draw on it - marks made here last exactly as long as the freeze.', 'ok', 4200);
}

function doSlow() {
  const t = cur.engine.time;
  const s = sourceAt(cur.map, t);
  const dur = Math.min(1.2, Math.max(0.3, (cur.p.source?.duration || 2) - s));
  mutate((p) => { p.timeline = addRate(p.timeline, s, s + dur, store.settings().slowRate); });
  recompile();
  toast(`Slowed to ${Math.round(store.settings().slowRate * 100)}% for ${dur.toFixed(1)}s.`, 'ok');
}

function trimHere(which) {
  const t = cur.engine.time;
  const s = sourceAt(cur.map, t);
  mutate((p) => {
    if (which === 'in') p.timeline = { ...p.timeline, in: s };
    else p.timeline = { ...p.timeline, out: s };
  });
  recompile();
  cur.engine.seek(which === 'in' ? 0 : cur.map.duration, true);
}

function removeOpHere() {
  const t = cur.engine.time;
  const hold = holdAt(cur.map, t);
  const sp = cur.map.spans.find((x) => t >= x.o0 && t <= x.o1);
  const op = hold?.op || sp?.op;
  if (!op) { toast('No effect under the playhead.'); return; }
  mutate((p) => { p.timeline = removeOp(p.timeline, op.id); });
  recompile();
  toast('Removed.');
}

// ---- inspector -------------------------------------------------------------

function paintInspector() {
  const host = cur.inspector;
  const m = cur.p.marks.find((x) => x.id === cur.sel);
  if (!m) {
    host.replaceChildren(h('p', { class: 'tiny muted', text: 'Nothing selected. Pick a tool and draw on the picture, or press V and click a mark.' }));
    return;
  }
  const rows = [];

  const timing = h('div', { class: 'row', style: { marginBottom: '8px' } },
    h('span', { class: 'chip', text: `${tc(m.t0, false)} - ${tc(m.t1, false)}` }),
    h('button', { class: 'btn mini', title: 'Start here', onclick: () => { mutate((p) => { find(p, m).t0 = cur.engine.time; }); paint(); drawRuler(); paintInspector(); } }, 'In'),
    h('button', { class: 'btn mini', title: 'End here', onclick: () => { mutate((p) => { find(p, m).t1 = Math.max(cur.engine.time, m.t0 + 0.2); }); paint(); drawRuler(); paintInspector(); } }, 'Out'));
  rows.push(timing);

  const anim = h('select', { class: 'input', onchange: (e) => { mutate((p) => { find(p, m).anim = e.target.value; }); paint(); } });
  for (const a of ['draw', 'pop', 'fade', 'pulse']) anim.appendChild(h('option', { value: a, selected: m.anim === a || null, text: a }));
  rows.push(h('label', { class: 'field' }, h('span', { text: 'Animation' }), anim));

  const wgt = h('input', { class: 'slider', type: 'range', min: '0.4', max: '2.6', step: '0.05', value: String(m.w || 1) });
  wgt.addEventListener('input', () => { mutate((p) => { find(p, m).w = Number(wgt.value); }, { quiet: true }); paint(); });
  wgt.addEventListener('change', commit);
  rows.push(h('label', { class: 'field' }, h('span', { text: 'Size' }), wgt));

  if (m.kind === 'arrow') {
    const curve = h('input', { class: 'slider', type: 'range', min: '-0.6', max: '0.6', step: '0.02', value: String(m.curve || 0) });
    curve.addEventListener('input', () => { mutate((p) => { find(p, m).curve = Number(curve.value); }, { quiet: true }); paint(); });
    curve.addEventListener('change', commit);
    rows.push(h('label', { class: 'field' }, h('span', { text: 'Curve' }), curve));
  }
  if (['arrow', 'pen', 'zone'].includes(m.kind)) {
    const dash = h('input', { type: 'checkbox', checked: m.dash || null });
    dash.addEventListener('change', () => { mutate((p) => { find(p, m).dash = dash.checked; }); paint(); });
    rows.push(h('label', { class: 'row', style: { marginBottom: '10px' } }, dash, h('span', { class: 'small', text: 'Dashed' })));
  }

  const track = h('button', {
    class: `btn mini ${cur.tracking ? 'primary' : ''}`,
    title: 'With tracking on, dragging this mark at a new time lays down a keyframe so it follows the player.',
    onclick: () => { cur.tracking = !cur.tracking; paintInspector(); toast(cur.tracking ? 'Tracking on. Scrub, then drag the mark onto the player.' : 'Tracking off.', 'ok'); },
  }, cur.tracking ? 'Tracking on' : 'Track player');
  const clearKeys = m.keys?.length
    ? h('button', { class: 'btn mini', onclick: () => { mutate((p) => { const q = find(p, m); q.pts = ptsAt(q, cur.engine.time); delete q.keys; }); paint(); paintInspector(); } }, 'Clear track')
    : null;
  rows.push(h('div', { class: 'row wrap', style: { marginBottom: '8px' } }, track, clearKeys));

  rows.push(h('div', { class: 'row wrap' },
    h('button', { class: 'btn mini', onclick: () => duplicateMark(m) }, 'Duplicate'),
    h('button', { class: 'btn mini danger', onclick: () => deleteMark(m) }, 'Delete')));

  host.replaceChildren(...rows);
}

const find = (p, m) => p.marks.find((x) => x.id === m.id);

function duplicateMark(m) {
  const copy = structuredClone(m);
  copy.id = uid();
  copy.pts = copy.pts.map((q) => ({ x: clamp01(q.x + 0.03), y: clamp01(q.y + 0.03) }));
  if (copy.keys) copy.keys = copy.keys.map((k) => ({ ...k, pts: k.pts.map((q) => ({ x: clamp01(q.x + 0.03), y: clamp01(q.y + 0.03) })) }));
  mutate((p) => p.marks.push(copy));
  cur.sel = copy.id;
  paintInspector(); paint(); drawRuler();
}

function deleteMark(m) {
  mutate((p) => { p.marks = p.marks.filter((x) => x.id !== m.id); });
  cur.sel = null;
  paintInspector(); paint(); drawRuler();
}

async function markMenu() {
  const m = cur.p.marks.find((x) => x.id === cur.sel);
  if (!m) return;
  const what = await sheet('Mark', (body, close) => {
    const b = (label, kind, danger) => h('button', { class: `btn ${danger ? 'danger' : ''}`, style: { width: '100%', justifyContent: 'flex-start', marginBottom: '6px' }, onclick: () => close(kind) }, label);
    body.appendChild(b('Label this', 'label'));
    body.appendChild(b('Duplicate', 'dup'));
    body.appendChild(b('Send to back', 'back'));
    body.appendChild(b('Delete', 'del', true));
  });
  if (what === 'dup') duplicateMark(m);
  if (what === 'del') deleteMark(m);
  if (what === 'back') { mutate((p) => { p.marks = [m, ...p.marks.filter((x) => x.id !== m.id)]; }); paint(); }
  if (what === 'label') {
    const text = await promptSheet('Label', 'Text', m.text || '');
    if (text !== null) { mutate((p) => { find(p, m).text = text; }); paint(); }
  }
}

// ---- publish panel ---------------------------------------------------------

function publishPanel() {
  const wrap = h('div');
  const p = cur.p.publish || {};
  const field = (key, label, ph) => {
    const i = h('input', { class: 'input', value: p[key] || '', placeholder: ph || '' });
    i.addEventListener('change', () => { mutate((q) => { q.publish = { ...q.publish, [key]: i.value }; }); });
    return h('label', { class: 'field' }, h('span', { text: label }), i);
  };
  wrap.appendChild(field('hook', 'Hook', 'We caught it ...'));
  wrap.appendChild(h('div', { class: 'row' }, field('league', 'League', 'KHL'), field('season', 'Season', '2025-2026')));
  wrap.appendChild(h('div', { class: 'row' }, field('teamA', 'Team A', 'LOK'), field('teamB', 'Team B', 'AKB')));
  wrap.appendChild(field('tag', 'What it shows', 'AKB POWER PLAY SETUP'));

  const title = h('input', { class: 'input', value: cur.p.brand?.title || '', placeholder: 'Opening card (blank for none)' });
  title.addEventListener('change', () => { mutate((q) => { q.brand = { ...q.brand, title: title.value }; }); paint(); });
  wrap.appendChild(h('label', { class: 'field' }, h('span', { text: 'Title card' }), title));

  wrap.appendChild(h('button', {
    class: 'btn mini', style: { width: '100%' },
    onclick: () => {
      const q = cur.p.publish || {};
      mutate((z) => { z.brand = { ...z.brand, title: q.tag || z.name, subtitle: [q.teamA, q.teamB].filter(Boolean).join(' vs ') }; });
      title.value = cur.p.brand.title;
      paint();
      toast('Title card filled from the fields above.', 'ok');
    },
  }, 'Build title from fields'));
  return wrap;
}

export function fileStem(project) {
  const s = store.settings();
  const p = project.publish || {};
  const map = {
    '{hook}': p.hook || '', '{league}': p.league || '', '{season}': p.season || '',
    '{teamA}': p.teamA || '', '{teamB}': p.teamB || '', '{tag}': p.tag || '',
    '{name}': project.name || 'clip', '{date}': new Date().toISOString().slice(0, 10),
  };
  // AN EMPTY TOKEN COLLAPSES WITHOUT THE DASH THAT JOINED IT - the same rule
  // Clips exports follow, so a clip with no league is not
  // "We caught it ...  -  - LOK".
  //
  // THE PATTERN IS SPLIT BEFORE SUBSTITUTION, not after. Two reasons, and both
  // were bugs first. Splitting the FILLED string on a bare dash tears
  // "2025-2026" into "2025 - 2026"; and splitting it on " - " misses the case
  // where two empty segments in a row leave the separators sharing a space
  // (" - - "), which no single split can unpick. Splitting the pattern means
  // an empty segment is simply a segment that came out empty.
  const pattern = s.namePattern || '{name}';
  const out = pattern
    .split(' - ')
    .map((seg) => {
      let t = seg;
      for (const [k, v] of Object.entries(map)) t = t.split(k).join(v);
      return t.replace(/\s+/g, ' ').trim();
    })
    .filter(Boolean)
    .join(' - ');
  return safeName(out) || safeName(project.name) || 'clip';
}

// ---- timeline --------------------------------------------------------------

function sizeRuler() {
  const r = cur.ruler;
  const box = r.parentElement.getBoundingClientRect();
  const dpr = Math.min(2, window.devicePixelRatio || 1);
  r.style.width = '100%';
  r.style.height = `${Math.max(60, box.height)}px`;
  const w = Math.max(200, Math.floor(box.width * dpr));
  const hh = Math.max(60, Math.floor(box.height * dpr));
  if (r.width !== w || r.height !== hh) { r.width = w; r.height = hh; }
  drawRuler();
}

const TL_PAD = 10;
function tlX(t) { const w = cur.ruler.width - TL_PAD * 2; return TL_PAD + (t / Math.max(0.01, cur.map.duration)) * w; }
function tlT(x) { const w = cur.ruler.width - TL_PAD * 2; return ((x - TL_PAD) / w) * cur.map.duration; }

function drawRuler() {
  if (!cur || !cur.map || !cur.ruler) return;
  const c = cur.ruler;
  const ctx = c.getContext('2d');
  const W = c.width; const H = c.height;
  const dpr = Math.min(2, window.devicePixelRatio || 1);
  ctx.clearRect(0, 0, W, H);
  ctx.fillStyle = '#141414'; ctx.fillRect(0, 0, W, H);

  const laneTop = 30 * dpr;
  const fxH = 22 * dpr;
  const markTop = laneTop + fxH + 6 * dpr;
  const markH = Math.max(8 * dpr, Math.min(16 * dpr, (H - markTop - 8 * dpr) / Math.max(1, Math.min(6, cur.p.marks.length || 1))));

  // seconds
  ctx.font = `${10 * dpr}px Inter, sans-serif`;
  ctx.fillStyle = '#6a6a6a';
  ctx.textBaseline = 'top';
  const dur = cur.map.duration;
  const step = dur > 60 ? 10 : dur > 24 ? 5 : dur > 8 ? 2 : 1;
  for (let s = 0; s <= dur + 0.001; s += step) {
    const x = tlX(s);
    ctx.fillRect(x, 6 * dpr, 1, 8 * dpr);
    ctx.fillText(tc(s, false), x + 3 * dpr, 5 * dpr);
  }

  // the effect lane: what time is doing
  ctx.fillStyle = '#1e1e1e';
  ctx.fillRect(TL_PAD, laneTop, W - TL_PAD * 2, fxH);
  for (const sp of cur.map.spans) {
    if (sp.kind === 'play') continue;
    const x0 = tlX(sp.o0); const x1 = tlX(sp.o1);
    ctx.fillStyle = sp.kind === 'hold' ? 'rgba(117,216,255,.85)' : 'rgba(255,210,30,.8)';
    ctx.fillRect(x0, laneTop, Math.max(2 * dpr, x1 - x0), fxH);
    if (x1 - x0 > 34 * dpr) {
      ctx.fillStyle = '#0a0a0a';
      ctx.font = `800 ${9 * dpr}px Inter, sans-serif`;
      ctx.fillText(sp.kind === 'hold' ? 'FREEZE' : `${Math.round(sp.rate * 100)}%`, x0 + 4 * dpr, laneTop + 6 * dpr);
      ctx.font = `${10 * dpr}px Inter, sans-serif`;
    }
  }
  // camera keys ride on the same lane, as pips
  for (const k of cur.p.camera || []) {
    const x = tlX(k.t);
    ctx.fillStyle = '#ff8c1a';
    ctx.beginPath();
    ctx.moveTo(x, laneTop - 4 * dpr); ctx.lineTo(x + 4 * dpr, laneTop); ctx.lineTo(x - 4 * dpr, laneTop);
    ctx.closePath(); ctx.fill();
  }

  // mark bars
  cur.p.marks.forEach((m, i) => {
    const row = i % Math.max(1, Math.floor((H - markTop - 6 * dpr) / (markH + 3 * dpr)));
    const y = markTop + row * (markH + 3 * dpr);
    const x0 = tlX(m.t0); const x1 = tlX(m.t1);
    const col = COLORS[m.color] || COLORS.red;
    ctx.fillStyle = m.id === cur.sel ? '#75d8ff' : col.base;
    ctx.globalAlpha = m.id === cur.sel ? 1 : 0.8;
    roundBar(ctx, x0, y, Math.max(4 * dpr, x1 - x0), markH, 3 * dpr);
    ctx.globalAlpha = 1;
    if (m.keys?.length > 1) {
      ctx.fillStyle = '#0a0a0a';
      for (const k of m.keys) ctx.fillRect(tlX(k.t) - dpr, y, 2 * dpr, markH);
    }
  });

  // playhead
  const x = tlX(cur.engine ? cur.engine.time : 0);
  ctx.fillStyle = '#ffffff';
  ctx.fillRect(x - dpr, 0, 2 * dpr, H);
  ctx.beginPath();
  ctx.moveTo(x - 5 * dpr, 0); ctx.lineTo(x + 5 * dpr, 0); ctx.lineTo(x, 7 * dpr);
  ctx.closePath(); ctx.fill();
}

function roundBar(ctx, x, y, w, h, r) {
  const rr = Math.min(r, w / 2, h / 2);
  ctx.beginPath();
  ctx.moveTo(x + rr, y);
  ctx.arcTo(x + w, y, x + w, y + h, rr);
  ctx.arcTo(x + w, y + h, x, y + h, rr);
  ctx.arcTo(x, y + h, x, y, rr);
  ctx.arcTo(x, y, x + w, y, rr);
  ctx.closePath();
  ctx.fill();
}

function attachRuler() {
  const c = cur.ruler;
  let dragging = false;
  const at = (e) => {
    const r = c.getBoundingClientRect();
    return tlT(((e.clientX - r.left) / r.width) * c.width);
  };
  c.addEventListener('pointerdown', (e) => {
    c.setPointerCapture(e.pointerId);
    dragging = true;
    cur.engine?.pause();
    cur.engine?.seek(clamp(at(e), 0, cur.map.duration), true);
  });
  c.addEventListener('pointermove', (e) => { if (dragging) cur.engine?.seek(clamp(at(e), 0, cur.map.duration)); });
  const stop = (e) => { if (!dragging) return; dragging = false; try { c.releasePointerCapture(e.pointerId); } catch (_) { /* fine */ } cur.engine?.stopGesture(); };
  c.addEventListener('pointerup', stop);
  c.addEventListener('pointercancel', stop);
}

// ---- keyboard --------------------------------------------------------------

function onKey(e) {
  if (!cur) return;
  const tag = (e.target.tagName || '').toLowerCase();
  if (tag === 'input' || tag === 'textarea' || tag === 'select' || e.target.isContentEditable) return;
  const mod = e.metaKey || e.ctrlKey;

  if (mod && e.key.toLowerCase() === 'z') { e.preventDefault(); if (e.shiftKey) redo(); else undo(); return; }
  if (mod && e.key.toLowerCase() === 's') { e.preventDefault(); saveNow(); toast('Saved.', 'ok'); return; }
  if (mod && e.key.toLowerCase() === 'e') { e.preventDefault(); exportSheet(); return; }
  if (mod) return;

  switch (e.key) {
    case ' ': e.preventDefault(); togglePlay(); return;
    case 'ArrowLeft': e.preventDefault(); cur.engine?.step(e.shiftKey ? -10 : -1); return;
    case 'ArrowRight': e.preventDefault(); cur.engine?.step(e.shiftKey ? 10 : 1); return;
    case 'Home': e.preventDefault(); cur.engine?.seek(0, true); return;
    case 'End': e.preventDefault(); cur.engine?.seek(cur.map.duration, true); return;
    case 'Escape': cur.sel = null; cur.draft = null; setTool('select'); paintInspector(); paint(); return;
    case 'Backspace': case 'Delete': {
      const m = cur.p.marks.find((x) => x.id === cur.sel);
      if (m) { e.preventDefault(); deleteMark(m); }
      return;
    }
    case 'f': case 'F': e.preventDefault(); doFreeze(); return;
    case 's': case 'S': e.preventDefault(); doSlow(); return;
    case 'k': case 'K': e.preventDefault(); addCameraKey(); return;
    default: break;
  }
  const tool = TOOLS.find((t) => t.key === e.key.toLowerCase());
  if (tool) { e.preventDefault(); setTool(tool.id); }
}

function togglePlay() {
  if (!cur.engine) return;
  cur.engine.toggle((t) => rateAt(cur.map, t));
  cur.hudPlay.replaceChildren(icon(cur.engine.playing ? ICONS.pause : ICONS.play, 18));
}

function setTool(id) {
  cur.tool = id;
  if (id !== 'select') { cur.sel = null; paintInspector(); }
  for (const b of cur.toolsHost.children) b.classList.toggle('on', b.dataset.tool === id);
  cur.stage.classList.toggle('panning', id === 'camera');
  cur.stage.classList.toggle('idle', id === 'select');
  paint();
}

function setColor(k) {
  cur.color = k;
  store.saveSettings({ defaultColor: k });
  for (const b of cur.colorsHost.children) b.classList.toggle('on', b.dataset.color === k);
  const m = cur.p.marks.find((x) => x.id === cur.sel);
  if (m) { mutate((p) => { find(p, m).color = k; }); paint(); drawRuler(); }
}

// ---- undo and save ---------------------------------------------------------

// A snapshot before each mutation, depth 60 - the same depth Diagrams uses, and
// deep enough that an afternoon's telestration is recoverable.
function mutate(fn, { quiet = false } = {}) {
  if (!quiet) {
    cur.undo.push(snapshot());
    if (cur.undo.length > 60) cur.undo.shift();
    cur.redo.length = 0;
  }
  fn(cur.p);
  cur.dirty = true;
  scheduleSave();
}
function commit() { cur.dirty = true; scheduleSave(); }

function snapshot() { return JSON.stringify(cur.p); }
function restore(json) {
  cur.p = JSON.parse(json);
  recompile();
  paintInspector();
  paint();
  drawRuler();
  commit();
}

function undo() {
  if (!cur.undo.length) { toast('Nothing to undo.'); return; }
  cur.redo.push(snapshot());
  restore(cur.undo.pop());
}
function redo() {
  if (!cur.redo.length) return;
  cur.undo.push(snapshot());
  restore(cur.redo.pop());
}

// Autosave, debounced. A coach telestrating does not stop for a Save button,
// and the three guards below catch the window the debounce leaves: a tab
// switch, a page hide, and closing the editor.
let saveTimer = 0;
function scheduleSave() {
  clearTimeout(saveTimer);
  saveTimer = setTimeout(saveNow, 900);
}
function saveNow() {
  if (!cur || !cur.dirty) return;
  clearTimeout(saveTimer);
  cur.dirty = false;
  store.put(cur.p).catch(fail);
}

// ---- export ----------------------------------------------------------------

async function exportSheet() {
  saveNow();
  const s = store.settings();
  const stem = fileStem(cur.p);

  const what = await sheet('Export', (body, close) => {
    body.appendChild(h('p', { class: 'small muted' }, 'Saved as ', h('b', { text: stem })));

    const kind = h('div', { class: 'seg', style: { marginBottom: '12px' } });
    let picked = canMP4() ? 'mp4' : 'webm';
    const opts = [
      ['mp4', 'MP4', canMP4()],
      ['webm', 'Recorded', true],
      ['gif', 'GIF', true],
      ['png', 'Still', true],
    ];
    for (const [id, label, ok] of opts) {
      if (!ok) continue;
      kind.appendChild(h('button', {
        class: picked === id ? 'on' : '',
        onclick: (e) => { picked = id; [...kind.children].forEach((b) => b.classList.remove('on')); e.currentTarget.classList.add('on'); },
      }, label));
    }
    body.appendChild(h('label', { class: 'field' }, h('span', { text: 'Format' }), kind));

    const q = h('select', { class: 'input' });
    for (const [k, v] of Object.entries(QUALITY)) {
      const size = formatSize(cur.p.format?.aspect || '16:9', k);
      q.appendChild(h('option', { value: k, selected: s.quality === k || null, text: `${v.label} - ${size.w}x${size.h}` }));
    }
    body.appendChild(h('label', { class: 'field' }, h('span', { text: 'Size' }), q));

    const fps = h('select', { class: 'input' });
    for (const f of FPS_CHOICES) fps.appendChild(h('option', { value: f, selected: s.fps === f || null, text: `${f} fps` }));
    body.appendChild(h('label', { class: 'field' }, h('span', { text: 'Frame rate' }), fps));

    const aud = h('input', { type: 'checkbox', checked: s.audio || null });
    body.appendChild(h('label', { class: 'row', style: { marginBottom: '10px' } }, aud, h('span', { class: 'small', text: 'Keep the source audio (freezes go silent)' })));

    const dest = h('select', { class: 'input' },
      h('option', { value: 'dropbox', selected: s.saveTo === 'dropbox' || null, disabled: !dbx.connected() || null, text: dbx.connected() ? `Dropbox ${dbx.EXPORT_ROOT}` : 'Dropbox (not connected)' }),
      h('option', { value: 'videos', selected: s.saveTo === 'videos' || null, text: 'CTH Videos (share link)' }),
      h('option', { value: 'download', selected: s.saveTo === 'download' || !dbx.connected() || null, text: 'Download to this device' }));
    body.appendChild(h('label', { class: 'field' }, h('span', { text: 'Save to' }), dest));

    body.appendChild(h('div', { class: 'row end' },
      h('button', { class: 'btn', onclick: () => close(null) }, 'Cancel'),
      h('button', {
        class: 'btn primary',
        onclick: () => close({ kind: picked, quality: q.value, fps: Number(fps.value), audio: aud.checked, dest: dest.value }),
      }, 'Export')));
  });
  if (!what) return;

  store.saveSettings({ quality: what.quality, fps: what.fps, audio: what.audio, saveTo: what.dest });
  cur.engine.pause();
  const v = el('film');
  const bar = progress('Exporting');
  const opts = { ...what, media: cur.mediaFile || cur.mediaUrl, signal: bar.signal, onProgress: (f, note) => bar.set(f, note) };

  try {
    let blob; let ext;
    if (what.kind === 'mp4') { blob = await exportMP4(cur.p, v, opts); ext = 'mp4'; }
    else if (what.kind === 'webm') { blob = await exportRecorded(cur.p, v, opts); ext = blob.type.includes('mp4') ? 'mp4' : 'webm'; }
    else if (what.kind === 'gif') { blob = await exportGIF(cur.p, v, opts); ext = 'gif'; }
    else { blob = await exportFrame(cur.p, v, cur.engine.time, opts); ext = 'png'; }
    bar.close();

    const name = `${stem}.${ext}`;
    if (what.dest === 'videos' && what.kind !== 'gif' && what.kind !== 'png') {
      // CTH Videos is the storage centre (2026-09-12): the export goes up
      // untouched and comes back as a share link that plays with the same
      // scrub feel. GIFs and stills are not videos and still download.
      await saveToVideos(blob, name);
    } else if (what.dest === 'dropbox' && dbx.connected()) {
      const up = progress('Saving to Dropbox');
      try {
        await dbx.ensureFolder(dbx.EXPORT_ROOT);
        await dbx.upload(`${dbx.EXPORT_ROOT}/${name}`, blob, (f) => up.set(f, 'Uploading'));
        up.close();
        await afterUpload(`${dbx.EXPORT_ROOT}/${name}`, name);
      } catch (e) { up.close(); fail(e); dbx.download(blob, name); }
    } else {
      dbx.download(blob, name);
      toast(`${name} saved.`, 'ok');
    }
    // The first frame becomes the library card, so a project is recognisable
    // at a glance rather than by its name alone.
    makeThumb(v).catch(() => {});
  } catch (e) {
    bar.close();
    fail(e);
  } finally {
    cur.engine.seek(cur.engine.time, true);
  }
}

// Hand the export to CTH Videos (../videos/js/api.js does the multipart
// upload) and show the links it comes back with. A missing key falls back to
// a download rather than losing the export.
async function saveToVideos(blob, name) {
  const api = await import('../../videos/js/api.js');
  if (!api.getKey()) {
    const k = await promptSheet('CTH Videos key', 'Key', '', { ok: 'Save', placeholder: 'Paste the key from Videos settings' });
    if (!k) { dbx.download(blob, name); toast(`${name} downloaded instead.`, 'warn'); return; }
    api.setKey(k);
  }
  const up = progress('Saving to CTH Videos');
  try {
    const file = new File([blob], name, { type: blob.type || 'video/mp4' });
    const v = await api.upload(file, { name: cur.p.name, signal: up.signal, onProgress: (f, note) => up.set(f, note) });
    up.close();
    const base = `${location.origin}${location.pathname.replace(/[^/]*$/, '')}../videos/`;
    const share = `${base}watch.html?v=${v.id}`;
    const field = (label, value, note) => {
      const i = h('input', { class: 'input', value, readonly: true });
      i.addEventListener('focus', () => i.select());
      const copy = h('button', {
        class: 'btn mini',
        onclick: async () => {
          try { await navigator.clipboard.writeText(value); toast('Copied.', 'ok'); }
          catch (_) { i.focus(); }
        },
      }, 'Copy');
      return h('div', { style: { marginBottom: '12px' } },
        h('div', { class: 'small', style: { fontWeight: '600', marginBottom: '4px' }, text: label }),
        h('div', { class: 'tiny muted', style: { marginBottom: '5px' }, text: note }),
        h('div', { class: 'row' }, i, copy));
    };
    await sheet('Saved to CTH Videos', (body, close) => {
      body.appendChild(field('Share link', share, 'For players, parents and a Notion embed block. Plays with the CTH scrub.'));
      body.appendChild(field('Direct link', api.fileUrl(v), 'The file itself. Plays in a browser, sends in a message.'));
      body.appendChild(h('div', { class: 'row end' },
        h('a', { class: 'btn', href: `${base}#/v/${v.id}`, target: '_blank', rel: 'noopener' }, 'Open in Videos'),
        h('button', { class: 'btn primary', onclick: () => close(null) }, 'Done')));
    });
  } catch (e) {
    up.close();
    if (e.name !== 'AbortError') { fail(e); dbx.download(blob, name); }
  }
}

// A finished video that only lives in Dropbox is half a deliverable; the link
// is what goes into Notion, a message or a course page.
async function afterUpload(path, name) {
  toast(`${name} saved to Dropbox.`, 'ok');
  try {
    const link = await dbx.shareLink(path);
    // TWO LINKS, because they are for two different places. The direct link is
    // the file - it plays in a browser, downloads, and attaches to a message.
    // The embed link wraps it in Studio's player, which is what goes into a
    // Notion embed block or an Obsidian web viewer: same scrub feel as the app,
    // and it does not hand the whole Dropbox page to whoever opens it.
    const embed = `${location.origin}${location.pathname.replace(/[^/]*$/, '')}embed.html`
      + `#v=${encodeURIComponent(link)}&title=${encodeURIComponent(cur.p.name)}`;
    const field = (label, value, note) => {
      const i = h('input', { class: 'input', value, readonly: true });
      i.addEventListener('focus', () => i.select());
      const copy = h('button', {
        class: 'btn mini',
        onclick: async () => {
          try { await navigator.clipboard.writeText(value); toast('Copied.', 'ok'); }
          catch (_) { i.focus(); }  // a blocked clipboard still leaves it selectable
        },
      }, 'Copy');
      return h('div', { style: { marginBottom: '12px' } },
        h('div', { class: 'small', style: { fontWeight: '600', marginBottom: '4px' }, text: label }),
        h('div', { class: 'tiny muted', style: { marginBottom: '5px' }, text: note }),
        h('div', { class: 'row' }, i, copy));
    };
    await sheet('Saved', (body, close) => {
      body.appendChild(field('Embed link', embed, 'For a Notion embed block or Obsidian. Paste it and choose Embed.'));
      body.appendChild(field('Direct link', link, 'The file itself. Plays in a browser, sends in a message.'));
      body.appendChild(h('div', { class: 'row end' },
        h('button', { class: 'btn primary', onclick: () => close(null) }, 'Done')));
    });
  } catch (_) { /* the file is saved; a link is a bonus */ }
}

async function makeThumb(v) {
  const c = document.createElement('canvas');
  const aspect = formatSize(cur.p.format?.aspect || '16:9', 'sd');
  c.width = 320; c.height = Math.round((320 * aspect.h) / aspect.w);
  const ctx = c.getContext('2d');
  composite(ctx, cur.picture || v, v.videoWidth || 16, v.videoHeight || 9, cur.p, cur.engine.time, {});
  mutate((p) => { p.thumb = c.toDataURL('image/jpeg', 0.7); }, { quiet: true });
  saveNow();
}

const clamp = (v, lo, hi) => (v < lo ? lo : v > hi ? hi : v);
const clamp01 = (v) => clamp(v, 0, 1);
