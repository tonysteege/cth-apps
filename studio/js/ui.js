// Shared chrome: toasts, sheets, prompts, and the small helpers every view
// wants. Same shapes as Clips and Diagrams so the suite reads as one app.

export const el = (id) => document.getElementById(id);
export const $ = (sel, root = document) => root.querySelector(sel);
export const $$ = (sel, root = document) => [...root.querySelectorAll(sel)];

export function h(tag, attrs = {}, ...kids) {
  const n = document.createElement(tag);
  for (const [k, v] of Object.entries(attrs || {})) {
    if (v == null || v === false) continue;
    if (k === 'class') n.className = v;
    else if (k === 'html') n.innerHTML = v;
    else if (k === 'text') n.textContent = v;
    else if (k.startsWith('on') && typeof v === 'function') n.addEventListener(k.slice(2), v);
    else if (k === 'style' && typeof v === 'object') Object.assign(n.style, v);
    else n.setAttribute(k, v === true ? '' : v);
  }
  for (const kid of kids.flat()) {
    if (kid == null || kid === false) continue;
    n.appendChild(typeof kid === 'string' || typeof kid === 'number' ? document.createTextNode(String(kid)) : kid);
  }
  return n;
}

export const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => (
  { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

// ---- toasts ----------------------------------------------------------------

let toastHost = null;
export function toast(message, kind = 'info', ms = 3200) {
  if (!toastHost) {
    toastHost = h('div', { class: 'toasts', role: 'status', 'aria-live': 'polite' });
    document.body.appendChild(toastHost);
  }
  const t = h('div', { class: `toast ${kind}` }, h('span', { class: 'dot' }), h('span', { text: String(message) }));
  toastHost.appendChild(t);
  requestAnimationFrame(() => t.classList.add('in'));
  const kill = () => { t.classList.remove('in'); setTimeout(() => t.remove(), 220); };
  t.addEventListener('click', kill);
  if (ms) setTimeout(kill, ms);
  return kill;
}

// An error the user can act on. Anything thrown gets funnelled here rather than
// to the console, because a silent failure in an export is indistinguishable
// from a slow one.
export function fail(e) {
  const msg = String(e?.message || e || 'Something went wrong.');
  if (msg === 'NOT_CONNECTED') { toast('Dropbox needs reconnecting.', 'warn', 5000); return; }
  if (/AbortError|cancelled/i.test(msg)) return;
  toast(msg, 'error', 6000);
}

// ---- sheet -----------------------------------------------------------------

let openSheet = null;

// A modal panel. Returns a promise resolving to whatever `close(value)` is
// given, or null on dismissal. One at a time, escapable, and it restores focus.
export function sheet(title, build, { wide = false } = {}) {
  return new Promise((resolve) => {
    openSheet?.();
    const focused = document.activeElement;
    const body = h('div', { class: 'sheet-body' });
    const card = h('div', { class: `sheet ${wide ? 'wide' : ''}`, role: 'dialog', 'aria-modal': 'true', 'aria-label': title },
      h('div', { class: 'sheet-head' },
        h('h2', { text: title }),
        h('button', { class: 'icon-btn', 'aria-label': 'Close', onclick: () => close(null) }, xIcon())),
      body);
    const scrim = h('div', { class: 'scrim' }, card);
    scrim.addEventListener('pointerdown', (e) => { if (e.target === scrim) close(null); });

    const onKey = (e) => {
      if (e.key === 'Escape') { e.stopPropagation(); close(null); }
      if (e.key === 'Tab') trapFocus(e, card);
    };
    function close(v) {
      if (openSheet !== close) return;
      openSheet = null;
      document.removeEventListener('keydown', onKey, true);
      scrim.classList.remove('in');
      setTimeout(() => scrim.remove(), 180);
      try { focused?.focus?.(); } catch (_) { /* the element may be gone */ }
      resolve(v);
    }
    openSheet = close;
    document.addEventListener('keydown', onKey, true);
    document.body.appendChild(scrim);
    build(body, close);
    requestAnimationFrame(() => {
      scrim.classList.add('in');
      (card.querySelector('[autofocus]') || card.querySelector('input,select,textarea,button:not(.icon-btn)') || card).focus?.();
    });
  });
}

function trapFocus(e, root) {
  const f = [...root.querySelectorAll('a[href],button:not([disabled]),input:not([disabled]),select,textarea,[tabindex]:not([tabindex="-1"])')]
    .filter((n) => n.offsetParent !== null);
  if (!f.length) return;
  const first = f[0]; const last = f[f.length - 1];
  if (e.shiftKey && document.activeElement === first) { e.preventDefault(); last.focus(); }
  else if (!e.shiftKey && document.activeElement === last) { e.preventDefault(); first.focus(); }
}

export function confirmSheet(title, message, { danger = false, ok = 'Confirm' } = {}) {
  return sheet(title, (body, close) => {
    body.appendChild(h('p', { class: 'muted', text: message }));
    body.appendChild(h('div', { class: 'row end' },
      h('button', { class: 'btn', onclick: () => close(false) }, 'Cancel'),
      h('button', { class: `btn ${danger ? 'danger' : 'primary'}`, autofocus: true, onclick: () => close(true) }, ok)));
  });
}

export function promptSheet(title, label, value = '', { ok = 'Save', placeholder = '' } = {}) {
  return sheet(title, (body, close) => {
    const input = h('input', { class: 'input', value, placeholder, autofocus: true });
    input.addEventListener('keydown', (e) => { if (e.key === 'Enter') close(input.value.trim()); });
    body.appendChild(h('label', { class: 'field' }, h('span', { text: label }), input));
    body.appendChild(h('div', { class: 'row end' },
      h('button', { class: 'btn', onclick: () => close(null) }, 'Cancel'),
      h('button', { class: 'btn primary', onclick: () => close(input.value.trim()) }, ok)));
  });
}

// ---- progress --------------------------------------------------------------

// A blocking progress panel with a working Cancel. Export is the only thing
// slow enough to need one, and an export you cannot stop is a trap.
export function progress(title) {
  const bar = h('div', { class: 'bar-fill' });
  const label = h('div', { class: 'muted small', text: 'Starting' });
  const controller = new AbortController();
  let done = false;
  const card = h('div', { class: 'sheet', role: 'dialog', 'aria-modal': 'true', 'aria-label': title },
    h('div', { class: 'sheet-head' }, h('h2', { text: title })),
    h('div', { class: 'sheet-body' },
      h('div', { class: 'bar' }, bar),
      label,
      h('div', { class: 'row end' },
        h('button', { class: 'btn', onclick: () => { controller.abort(); close(); } }, 'Cancel'))));
  const scrim = h('div', { class: 'scrim' }, card);
  document.body.appendChild(scrim);
  requestAnimationFrame(() => scrim.classList.add('in'));
  function close() {
    if (done) return; done = true;
    scrim.classList.remove('in');
    setTimeout(() => scrim.remove(), 180);
  }
  return {
    signal: controller.signal,
    set(frac, note) {
      bar.style.width = `${Math.max(0, Math.min(1, frac)) * 100}%`;
      if (note) label.textContent = `${note} ${Math.round(frac * 100)}%`;
    },
    close,
  };
}

// ---- small pieces ----------------------------------------------------------

function xIcon() {
  const s = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
  s.setAttribute('viewBox', '0 0 16 16'); s.setAttribute('width', '16'); s.setAttribute('height', '16');
  s.innerHTML = '<path d="M4 4l8 8M12 4l-8 8" stroke="currentColor" stroke-width="1.6" fill="none" stroke-linecap="round"/>';
  return s;
}

export function icon(path, size = 16) {
  const s = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
  s.setAttribute('viewBox', '0 0 16 16');
  s.setAttribute('width', size); s.setAttribute('height', size);
  s.setAttribute('aria-hidden', 'true');
  s.innerHTML = path;
  return s;
}

export const ICONS = {
  play: '<path d="M5 3.5v9l7.5-4.5z" fill="currentColor"/>',
  pause: '<path d="M5 3.5h2.2v9H5zM8.8 3.5H11v9H8.8z" fill="currentColor"/>',
  back: '<path d="M9.5 3L5 8l4.5 5" stroke="currentColor" stroke-width="1.6" fill="none" stroke-linecap="round" stroke-linejoin="round"/>',
  folder: '<path d="M2 4.5A1.5 1.5 0 013.5 3h2.2l1.2 1.4h5.6A1.5 1.5 0 0114 5.9v5.6a1.5 1.5 0 01-1.5 1.5h-9A1.5 1.5 0 012 11.5z" fill="currentColor"/>',
  film: '<rect x="2" y="3" width="12" height="10" rx="1.5" stroke="currentColor" stroke-width="1.4" fill="none"/><path d="M5 3v10M11 3v10" stroke="currentColor" stroke-width="1.2"/>',
  plus: '<path d="M8 3.5v9M3.5 8h9" stroke="currentColor" stroke-width="1.7" stroke-linecap="round"/>',
  trash: '<path d="M3.5 4.5h9M6.5 4.5V3h3v1.5M5 4.5l.6 8h4.8l.6-8" stroke="currentColor" stroke-width="1.4" fill="none" stroke-linecap="round" stroke-linejoin="round"/>',
  gear: '<path d="M8 10.2a2.2 2.2 0 100-4.4 2.2 2.2 0 000 4.4z" stroke="currentColor" stroke-width="1.3" fill="none"/><path d="M13 8a5 5 0 00-.1-1l1.2-.9-1.3-2.2-1.4.6a5 5 0 00-1.7-1L9.5 2h-3l-.2 1.5a5 5 0 00-1.7 1l-1.4-.6L1.9 6.1 3.1 7a5 5 0 000 2l-1.2.9 1.3 2.2 1.4-.6a5 5 0 001.7 1l.2 1.5h3l.2-1.5a5 5 0 001.7-1l1.4.6 1.3-2.2-1.2-.9c.07-.33.1-.66.1-1z" stroke="currentColor" stroke-width="1.2" fill="none" stroke-linejoin="round"/>',
  freeze: '<path d="M8 2v12M3 4.5l10 7M13 4.5l-10 7" stroke="currentColor" stroke-width="1.4" stroke-linecap="round"/>',
  slow: '<circle cx="8" cy="8" r="5.4" stroke="currentColor" stroke-width="1.4" fill="none"/><path d="M8 5v3.2l2.2 1.3" stroke="currentColor" stroke-width="1.4" fill="none" stroke-linecap="round"/>',
  zoom: '<circle cx="7" cy="7" r="4.2" stroke="currentColor" stroke-width="1.4" fill="none"/><path d="M10.2 10.2L14 14" stroke="currentColor" stroke-width="1.6" stroke-linecap="round"/>',
  export: '<path d="M8 10.5V2.5M5 5.2L8 2.2l3 3" stroke="currentColor" stroke-width="1.5" fill="none" stroke-linecap="round" stroke-linejoin="round"/><path d="M3 10v2.5A1.5 1.5 0 004.5 14h7a1.5 1.5 0 001.5-1.5V10" stroke="currentColor" stroke-width="1.5" fill="none" stroke-linecap="round"/>',
  copy: '<rect x="5.5" y="5.5" width="8" height="8" rx="1.4" stroke="currentColor" stroke-width="1.4" fill="none"/><path d="M10.5 5.5v-1A1.5 1.5 0 009 3H4a1.5 1.5 0 00-1.5 1.5V10A1.5 1.5 0 004 11.5h1" stroke="currentColor" stroke-width="1.4" fill="none"/>',
  undo: '<path d="M4 7h6.2a3 3 0 010 6H7" stroke="currentColor" stroke-width="1.5" fill="none" stroke-linecap="round"/><path d="M6.2 4.4L3.6 7l2.6 2.6" stroke="currentColor" stroke-width="1.5" fill="none" stroke-linecap="round" stroke-linejoin="round"/>',
};

// A number that reads as a timecode. Frames matter here: "1.2s" is not a place
// on a timeline, "0:01.06" is.
export function tc(t, withFrames = true, fps = 30) {
  const s = Math.max(0, Number(t) || 0);
  const m = Math.floor(s / 60);
  const sec = Math.floor(s % 60);
  if (!withFrames) return `${m}:${String(sec).padStart(2, '0')}`;
  const f = Math.floor((s % 1) * fps);
  return `${m}:${String(sec).padStart(2, '0')}.${String(f).padStart(2, '0')}`;
}

export function bytes(n) {
  if (!n) return '';
  const u = ['B', 'KB', 'MB', 'GB'];
  let i = 0; let v = n;
  while (v >= 1024 && i < u.length - 1) { v /= 1024; i++; }
  return `${v >= 10 || i === 0 ? Math.round(v) : v.toFixed(1)} ${u[i]}`;
}

// Anything a file system will not take, plus runs of dashes. Lifted from Clips
// so an export from either app lands with the same name.
export const safeName = (s) => String(s || '')
  .trim()
  .replace(/[\\/:*?"<>|]+/g, '')
  .replace(/\s+/g, ' ')
  .replace(/-{2,}/g, '-')
  .replace(/^-|-$/g, '');
