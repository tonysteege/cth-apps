// A context menu at the pointer: the panel-and-items recipe (radius 16,
// 10px padding, 10px-radius items), one open at a time, closed by a click
// anywhere else, Escape, scroll or resize. Items: { label, run, danger,
// disabled, key } or '-' for a divider.

import { h } from '../../studio/js/ui.js';

let openMenu = null;

export function closeMenu() { if (openMenu) { openMenu(); openMenu = null; } }

export function showMenu(items, { x, y, title = '' }) {
  closeMenu();
  const panel = h('div', { class: 'vmenu', role: 'menu' });
  if (title) panel.appendChild(h('div', { class: 'vmenu-title', text: title }));
  for (const it of items) {
    if (it === '-') { panel.appendChild(h('div', { class: 'vmenu-sep' })); continue; }
    const b = h('button', { class: `vmenu-item ${it.danger ? 'danger' : ''}`, role: 'menuitem', type: 'button', disabled: it.disabled || null },
      h('span', { class: 'grow', text: it.label }),
      it.key ? h('kbd', { text: it.key }) : null);
    b.addEventListener('click', (e) => { e.stopPropagation(); closeMenu(); it.run(); });
    panel.appendChild(b);
  }
  document.body.appendChild(panel);
  // Keep it on screen.
  const r = panel.getBoundingClientRect();
  const px = Math.min(x, window.innerWidth - r.width - 8);
  const py = Math.min(y, window.innerHeight - r.height - 8);
  panel.style.left = `${Math.max(8, px)}px`;
  panel.style.top = `${Math.max(8, py)}px`;
  requestAnimationFrame(() => panel.classList.add('in'));

  const onDown = (e) => { if (!panel.contains(e.target)) closeMenu(); };
  const onKey = (e) => {
    if (e.key === 'Escape') { e.stopPropagation(); closeMenu(); return; }
    if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
      e.preventDefault();
      const bs = [...panel.querySelectorAll('.vmenu-item:not([disabled])')];
      const i = bs.indexOf(document.activeElement);
      bs[(i + (e.key === 'ArrowDown' ? 1 : -1) + bs.length) % bs.length]?.focus();
    }
  };
  document.addEventListener('pointerdown', onDown, true);
  document.addEventListener('keydown', onKey, true);
  window.addEventListener('resize', closeMenu);
  window.addEventListener('scroll', closeMenu, true);
  openMenu = () => {
    document.removeEventListener('pointerdown', onDown, true);
    document.removeEventListener('keydown', onKey, true);
    window.removeEventListener('resize', closeMenu);
    window.removeEventListener('scroll', closeMenu, true);
    panel.remove();
  };
  panel.querySelector('.vmenu-item:not([disabled])')?.focus({ preventScroll: true });
  return closeMenu;
}

// Rename in place: swap a row's name span for an input. Enter commits,
// Escape reverts, clicking away commits. `commit(newName)` returns a promise.
export function inlineRename(nameEl, value, commit) {
  if (nameEl.dataset.editing) return;
  nameEl.dataset.editing = '1';
  const input = h('input', { class: 'vt-edit', value, 'aria-label': 'Name' });
  const shown = nameEl.textContent;
  nameEl.replaceChildren(input);
  input.focus();
  input.select();
  let done = false;
  const finish = async (ok) => {
    if (done) return; done = true;
    const next = input.value.trim();
    nameEl.textContent = shown;
    delete nameEl.dataset.editing;
    if (ok && next && next !== value) await commit(next);
  };
  input.addEventListener('keydown', (e) => {
    e.stopPropagation();
    if (e.key === 'Enter') { e.preventDefault(); finish(true); }
    else if (e.key === 'Escape') { e.preventDefault(); finish(false); }
  });
  input.addEventListener('blur', () => finish(true));
  input.addEventListener('click', (e) => e.stopPropagation());
  input.addEventListener('dblclick', (e) => e.stopPropagation());
  input.addEventListener('pointerdown', (e) => e.stopPropagation());
}
