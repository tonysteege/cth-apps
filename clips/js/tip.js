// CTH Clips - one tooltip for the whole app.
//
// WHY THIS IS NOT `title` (2026-08-29, Tony's call). Half the chrome in this
// app is now icon-only: the log's five filters, the search glyph, the sort
// button, the timecode toggle, every tool and swatch on the annotation bar.
// A native `title` takes about a second to appear, which is long enough that
// a coach has already clicked and found out the hard way - and it is drawn by
// the OS, so it is the one thing on screen that is not BoardUI. This is the
// BoardUI Tooltip recipe, on an 80ms delay, so the label arrives about as
// fast as the pointer stops.
//
// IT WIRES ITSELF. Every bar here is built as an HTML string and dropped into
// the DOM long after load, so anything needing a per-element call would be
// forgotten by the next bar somebody adds. Delegated listeners on the
// document cover every `[data-tip]` that will ever exist. Importing this
// module for its side effect is the whole API.
//
// `data-tip`, never `title`, on the same element: a `title` alongside it
// would still raise the OS tooltip a second later, under this one.

const DELAY = 80;

let node = null;
let timer = null;
let current = null;

function ensure() {
  if (!node) {
    node = document.createElement('div');
    node.className = 'cs-tip';
    document.body.appendChild(node);
  }
  return node;
}

/** Place the tip against `anchor` and show it. Exported for the few callers
 *  that open one from something other than a hover. */
export function showTip(anchor) {
  const text = anchor?.dataset?.tip;
  if (!text) return;
  const t = ensure();
  t.textContent = text;
  t.classList.add('on');
  current = anchor;
  // Park it at the origin BEFORE measuring, so the measurement is of THIS
  // text at THIS width. Reading the rect while the node still sits at its
  // last position returns the PREVIOUS tip's height, which is what once put
  // one of these 12px off the top of the screen.
  t.style.left = '0px';
  t.style.top = '0px';
  const a = anchor.getBoundingClientRect();
  const r = t.getBoundingClientRect();
  const pad = 8;
  const clamp = (v, max) => Math.max(pad, Math.min(v, max - pad));
  // Above by default, below when there is no room - then CLAMPED on both
  // axes, so no arithmetic mistake can put it off screen.
  const above = a.top - r.height - 10;
  t.style.top = `${clamp(above > pad ? above : a.bottom + 10, window.innerHeight - r.height)}px`;
  t.style.left = `${clamp(a.left + a.width / 2 - r.width / 2, window.innerWidth - r.width)}px`;
}

export function hideTip() {
  clearTimeout(timer);
  timer = null;
  current = null;
  node?.classList.remove('on');
}

const target = (e) => e.target?.closest?.('[data-tip]');

document.addEventListener('pointerover', (e) => {
  const el = target(e);
  if (!el || el === current) return;
  clearTimeout(timer);
  timer = setTimeout(() => showTip(el), DELAY);
});
document.addEventListener('pointerout', (e) => {
  const el = target(e);
  if (!el) return;
  // Moving between children of the same anchor is not leaving it.
  if (e.relatedTarget && el.contains(e.relatedTarget)) return;
  hideTip();
});
// Keyboard reaches it too: a tip that is mouse-only is a tip half the people
// using this app never see.
document.addEventListener('focusin', (e) => {
  const el = target(e);
  if (el) showTip(el);
});
document.addEventListener('focusout', hideTip);
// Anything that moves the anchor invalidates the position, and a stale tip
// pointing at nothing is worse than none.
document.addEventListener('pointerdown', hideTip, true);
document.addEventListener('keydown', hideTip, true);
window.addEventListener('scroll', hideTip, true);
window.addEventListener('blur', hideTip);
