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

export function fmtDate(ts) {
  if (!ts) return '';
  const d = new Date(ts);
  const today = new Date();
  const sameDay = d.toDateString() === today.toDateString();
  if (sameDay) return `Today ${d.toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' })}`;
  return d.toLocaleDateString([], { month: 'short', day: 'numeric', year: d.getFullYear() === today.getFullYear() ? undefined : 'numeric' });
}
