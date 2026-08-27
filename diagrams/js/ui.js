// Small shared UI pieces: escaping, toasts, confirm dialog.

export const esc = (s) => String(s ?? '')
  .replaceAll('&', '&amp;').replaceAll('<', '&lt;').replaceAll('>', '&gt;')
  .replaceAll('"', '&quot;').replaceAll("'", '&#39;');

let toastTimer = null;
export function toast(msg, isErr = false) {
  let t = document.getElementById('toast');
  if (!t) {
    t = document.createElement('div');
    t.id = 'toast';
    document.body.appendChild(t);
  }
  t.textContent = msg;
  t.classList.toggle('err', !!isErr);
  t.classList.add('show');
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => t.classList.remove('show'), 2600);
}

// A promise-based confirm sheet - returns true only on the primary action.
export function confirmSheet({ title, body, action = 'Delete', danger = true }) {
  return new Promise((res) => {
    const wrap = document.createElement('div');
    wrap.className = 'sheet-veil';
    wrap.innerHTML = `
      <div class="sheet" role="dialog" aria-modal="true">
        <h3>${esc(title)}</h3>
        ${body ? `<p>${esc(body)}</p>` : ''}
        <div class="sheet-row">
          <button class="btn" data-x="cancel">Cancel</button>
          <button class="btn ${danger ? 'btn-danger' : 'btn-ink'}" data-x="go">${esc(action)}</button>
        </div>
      </div>`;
    const done = (v) => { wrap.remove(); window.removeEventListener('keydown', onEsc, true); res(v); };
    const onEsc = (e) => { if (e.key === 'Escape') { e.preventDefault(); e.stopPropagation(); done(false); } };
    wrap.addEventListener('mousedown', (e) => { if (e.target === wrap) done(false); });
    wrap.querySelector('[data-x="cancel"]').onclick = () => done(false);
    wrap.querySelector('[data-x="go"]').onclick = () => done(true);
    window.addEventListener('keydown', onEsc, true);
    document.body.appendChild(wrap);
    wrap.querySelector('[data-x="go"]').focus();
  });
}

// The unsaved-work prompt. Saving is manual, so leaving is the one moment
// work can actually be lost - this is the only thing standing in front of it.
// Returns 'save', 'discard' or 'cancel'. Deliberately NOT confirmSheet: that
// one is a yes/no and this genuinely has three answers.
export function leaveSheet(name) {
  return new Promise((res) => {
    const wrap = document.createElement('div');
    wrap.className = 'sheet-veil';
    wrap.innerHTML = `
      <div class="sheet" role="dialog" aria-modal="true">
        <h3>Save Before Leaving?</h3>
        <p>${esc(name ? `"${name}"` : 'This diagram')} has changes that are not saved yet.</p>
        <div class="sheet-row">
          <button class="btn" data-x="cancel">Cancel</button>
          <button class="btn btn-danger" data-x="discard">Discard</button>
          <button class="btn btn-ink" data-x="save">Save</button>
        </div>
      </div>`;
    const done = (v) => { wrap.remove(); window.removeEventListener('keydown', onEsc, true); res(v); };
    const onEsc = (e) => { if (e.key === 'Escape') { e.preventDefault(); e.stopPropagation(); done('cancel'); } };
    wrap.addEventListener('mousedown', (e) => { if (e.target === wrap) done('cancel'); });
    wrap.querySelector('[data-x="cancel"]').onclick = () => done('cancel');
    wrap.querySelector('[data-x="discard"]').onclick = () => done('discard');
    wrap.querySelector('[data-x="save"]').onclick = () => done('save');
    window.addEventListener('keydown', onEsc, true);
    document.body.appendChild(wrap);
    wrap.querySelector('[data-x="save"]').focus();
  });
}

export function fmtDate(ts) {
  if (!ts) return '';
  const d = new Date(ts);
  const today = new Date();
  const sameDay = d.toDateString() === today.toDateString();
  if (sameDay) return `Today ${d.toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' })}`;
  return d.toLocaleDateString([], { month: 'short', day: 'numeric', year: d.getFullYear() === today.getFullYear() ? undefined : 'numeric' });
}

// A right-click menu. Shared from here (2026-08-27) because Clips grew one
// too - it lived inside diagrams/js/app.js, which cannot be imported
// without running the whole Diagrams app. `.move-menu` and `.ctx-danger`
// are already in the shared stylesheet.
// items: [label, onPick, isDanger?][]
export function ctxMenu(x, y, items) {
  document.querySelector('.move-menu')?.remove();
  const m = document.createElement('div');
  m.className = 'move-menu';
  m.innerHTML = items.map(([label, , danger], i) => `<button data-i="${i}"${danger ? ' class="ctx-danger"' : ''}>${label}</button>`).join('');
  document.body.appendChild(m);
  m.style.left = `${Math.max(8, Math.min(window.innerWidth - m.offsetWidth - 8, x))}px`;
  m.style.top = `${Math.max(8, Math.min(window.innerHeight - m.offsetHeight - 8, y))}px`;
  const close = () => { m.remove(); window.removeEventListener('pointerdown', away, true); };
  const away = (e) => { if (!m.contains(e.target)) close(); };
  window.addEventListener('pointerdown', away, true);
  m.querySelectorAll('[data-i]').forEach((b) => { b.onclick = () => { close(); items[Number(b.dataset.i)][1](); }; });
}
