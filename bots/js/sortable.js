// Pointer-driven reordering, used by the bot board and the style list.
//
// This replaces HTML5 drag-and-drop, which was the source of the jump
// Tony saw (2026-08-27): the browser drags a translucent SNAPSHOT of the
// element while the element itself stays where it was, and on drop it
// plays its own snap-back animation from the cursor to the origin before
// the reorder is applied. None of that is stylable or cancellable.
//
// Here the real element moves under the finger, its neighbours slide with
// a FLIP animation as the order changes, and on release the card animates
// from wherever it was drawn into its new slot - so there is never a frame
// where anything is in the wrong place.
//
// The one subtlety worth keeping: when the dragged element is re-inserted
// mid-drag its LAYOUT position changes, so the same transform would move
// it. Every frame therefore clears the transform, measures the new layout
// box, and re-derives the transform from the position it should be drawn
// at. That is what makes a reorder invisible while the drag continues.

const EASE = 'cubic-bezier(.2,.7,.3,1)';
const SLIDE = 180;
const LAND = 200;

export function sortable(list, {
  item,            // css selector for the sortable children
  handle = null,   // css selector for the grab handle, or null for whole item
  axis = 'grid',   // 'y' for a stacked list, 'grid' for a wrapping board
  onEnd = null,    // called with the new order of item elements
} = {}) {
  const items = () => [...list.querySelectorAll(item)];

  for (const el of items()) {
    const grip = handle ? el.querySelector(handle) : el;
    if (!grip || grip.dataset.sortWired) continue;
    grip.dataset.sortWired = '1';
    grip.style.touchAction = 'none';
    grip.addEventListener('pointerdown', (e) => begin(e, el, grip));
  }

  function begin(e, el, grip) {
    if (e.button !== 0) return;
    e.preventDefault();
    const start = el.getBoundingClientRect();
    const grabX = start.left;
    const grabY = start.top;
    const ox = e.clientX;
    const oy = e.clientY;
    let moved = false;
    try { grip.setPointerCapture(e.pointerId); } catch (_) { /* fine */ }

    // Where the element should be PAINTED, in viewport coordinates.
    let vx = grabX;
    let vy = grabY;

    const paint = () => {
      el.style.transform = 'none';
      const box = el.getBoundingClientRect();
      el.style.transform = `translate(${vx - box.left}px, ${vy - box.top}px)`;
    };

    const reorder = () => {
      const cx = vx + start.width / 2;
      const cy = vy + start.height / 2;
      const others = items().filter((o) => o !== el);
      if (!others.length) return;
      let best = null;
      let bestD = Infinity;
      let after = false;
      for (const o of others) {
        const r = o.getBoundingClientRect();
        const mx = r.left + r.width / 2;
        const my = r.top + r.height / 2;
        const d = Math.hypot(cx - mx, cy - my);
        if (d >= bestD) continue;
        bestD = d;
        best = o;
        // A stacked list only cares about up/down. A wrapping board reads
        // left/right within a row and falls back to up/down across rows.
        after = axis === 'y' ? cy > my
          : (Math.abs(cy - my) > r.height * 0.5 ? cy > my : cx > mx);
      }
      const target = after ? best.nextElementSibling : best;
      if (target === el || (after && best === el)) return;
      const wasAt = el.nextElementSibling;
      if (target === wasAt && !after) return;

      const before = new Map(others.map((o) => [o, o.getBoundingClientRect()]));
      list.insertBefore(el, target === el ? el.nextElementSibling : target);
      for (const o of others) {
        const b = before.get(o);
        const a = o.getBoundingClientRect();
        const dx = b.left - a.left;
        const dy = b.top - a.top;
        if (!dx && !dy) continue;
        o.animate(
          [{ transform: `translate(${dx}px, ${dy}px)` }, { transform: 'none' }],
          { duration: SLIDE, easing: EASE },
        );
      }
      paint();
    };

    const move = (ev) => {
      const dx = ev.clientX - ox;
      const dy = ev.clientY - oy;
      if (!moved) {
        if (Math.hypot(dx, dy) < 4) return;
        moved = true;
        list.classList.add('is-sorting');
        el.classList.add('is-dragging');
        el.style.zIndex = '30';
        el.style.willChange = 'transform';
      }
      vx = grabX + dx;
      vy = grabY + dy;
      paint();
      reorder();
    };

    const end = () => {
      // THE MOVE AND UP LISTENERS LIVE ON THE WINDOW, not on the grip.
      // Listening on the grip relies on pointer capture surviving, and
      // when capture fails - or the pointer leaves the window, or another
      // element steals it - the up event never arrives, `end` never runs,
      // and `is-sorting` (which sets pointer-events: none on every other
      // card) sticks. That leaves the board dead until a reload.
      window.removeEventListener('pointermove', move);
      window.removeEventListener('pointerup', end);
      window.removeEventListener('pointercancel', end);
      window.removeEventListener('blur', end);
      try { grip.releasePointerCapture(e.pointerId); } catch (_) { /* fine */ }
      if (!moved) {
        el.style.transform = '';
        el.classList.remove('is-dragging');
        list.classList.remove('is-sorting');
        return;
      }
      // Land it: animate from where it is drawn into where it now belongs,
      // instead of letting it teleport.
      const drawn = el.getBoundingClientRect();
      el.style.transform = '';
      el.style.zIndex = '';
      el.style.willChange = '';
      const slot = el.getBoundingClientRect();
      const anim = el.animate(
        [{ transform: `translate(${drawn.left - slot.left}px, ${drawn.top - slot.top}px)` }, { transform: 'none' }],
        { duration: LAND, easing: EASE },
      );
      list.classList.remove('is-sorting');
      const settle = () => el.classList.remove('is-dragging');
      anim.addEventListener('finish', settle);
      anim.addEventListener('cancel', settle);
      setTimeout(settle, LAND + 80);   // belt and braces
      onEnd?.(items());
    };

    window.addEventListener('pointermove', move);
    window.addEventListener('pointerup', end);
    window.addEventListener('pointercancel', end);
    window.addEventListener('blur', end);
  }
}
