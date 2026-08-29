// Shared control behaviour for the BoardUI recipes in diagrams/css/app.css.
//
// Today that is one job: a native <input type="range"> cannot paint its own
// filled track, so the CSS reads the filled width from a `--p` custom
// property and this keeps that property in step with the value.
//
// IT WIRES ITSELF. Sliders in this suite appear inside sheets that are built
// as HTML strings and dropped into the DOM long after load - the video
// editor, the animator, Settings - so anything requiring a per-slider call
// would be forgotten by the next sheet somebody adds. A delegated listener
// plus one observer covers every slider that will ever exist, including ones
// nobody has written yet.
//
// Importing this module for its side effect is the whole API. A page that
// forgets to import it still renders a usable slider, just with an empty
// track, because `--p` falls back to 0% in the stylesheet.

const paint = (el) => {
  const min = Number(el.min) || 0;
  const max = Number(el.max === '' ? 100 : el.max);
  const span = max - min;
  const p = span > 0 ? ((Number(el.value) - min) / span) * 100 : 0;
  el.style.setProperty('--p', `${Math.max(0, Math.min(100, p))}%`);
};

const isRange = (n) => n instanceof HTMLInputElement && n.type === 'range';

/** Paint every slider under `root`. Called for you; exported for a repaint
 *  after code changes a value directly, which fires no input event. */
export function paintRanges(root = document) {
  for (const el of root.querySelectorAll('input[type="range"]')) paint(el);
}

// Capture phase, so a handler that stops propagation cannot leave the track
// showing a stale position.
document.addEventListener('input', (e) => { if (isRange(e.target)) paint(e.target); }, true);
document.addEventListener('change', (e) => { if (isRange(e.target)) paint(e.target); }, true);

// A sheet arrives as a subtree, so catch the whole subtree rather than the
// node itself.
new MutationObserver((records) => {
  for (const r of records) {
    for (const n of r.addedNodes) {
      if (n.nodeType !== 1) continue;
      if (isRange(n)) paint(n);
      else paintRanges(n);
    }
  }
}).observe(document.documentElement, { childList: true, subtree: true });

paintRanges();
