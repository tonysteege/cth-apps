# CTH Apps

The home for Coach Tony Hockey's web apps, live at
https://apps.coachtonyhockey.com/. The repo root is the hub page; each app
lives in a subfolder and serves at its own path.

## Apps

- **Diagrams** (`/diagrams/`) - hockey diagram design: drills and plays on
  a full rink, saved in the browser, exported as game-ready images that
  stay editable.

## What It Does

- Full rink opens game-ready: nets in both creases, a goalie at each end.
- Players (three color presets), curved and dashed arrows with four head
  styles, shaded boxes AND circles (double-click to label them), Title-chip
  text labels, freehand pen, flip.
- Rink items: net, coach, puck, puck pile, cone, border pad. One-click 5v5
  centre-ice faceoff.
- The "+ Add Rink" bar under the bottom rink stacks up to five rinks as a
  sequence, saved as one image. Each rink of a sequence gets a Figma-style
  frame label (click to rename) and minimal controls above it: move up or
  down, copy, download, remove - with the whole sequence reflowing. The
  extra spacing between rinks is editor-only; exports keep the canonical
  layout.
- Four customizable color presets (double-click or right-click a swatch).
- Trackpad pinch to zoom (Cmd+scroll works too, Cmd+0 resets), two-finger
  scroll to pan. Touch support for tablet and phone.
- Snapping to rink landmarks and other objects with alignment guides (Cmd
  disables). Multi-select, group move, copy / cut / paste / duplicate,
  undo depth 60, customizable keyboard shortcuts (right-click any tool).
- Diagram library with manual save, search, duplicate, delete, thumbnails.
- Export: PNG download, clipboard copy, print - the whole diagram or any
  chosen rinks of a sequence - plus one-file JSON backup and restore.

## The PNG Format

An exported PNG carries its full editable state in a `tEXt` chunk with the
keyword `cthDiagram` (base64 JSON) - the exact format CTH Film Room uses.
A diagram PNG made here reopens fully editable both here and in Film Room,
and a Film Room diagram PNG imports here fully editable.

State shape: `{ v: 1, w, h, bg, seq, elements, rinkNames? }` where `bg` is
null for standard rink layouts (rebuilt from `assets/rink.png`) or a data
URL, `seq` is the number of stacked rinks, `rinkNames` is the optional
per-rink labels, and `elements` is the array of players, arrows, stamps,
boxes, circles, text, and pen strokes.

## Stack

No build step, no framework, no dependencies. Static HTML + ES modules,
deployed by GitHub Pages straight from `main`. Diagrams persist in the
browser's IndexedDB. Inter is the only typeface: 500 for content, 800 for
titles, headings, and labels.

```
index.html        app shell
css/app.css       all styling (CTH greyscale design system)
js/app.js         routing, library view, editor shell, import/export
js/editor.js      the diagram editor (interaction, SVG render, toolbar)
js/flat.js        pure canvas rendering of elements (exports, thumbnails)
js/rink.js        rink geometry, landmark coordinates, asset loading
js/store.js       IndexedDB storage
js/png.js         PNG tEXt chunk read/write (cthDiagram state)
js/ui.js          toasts, confirm sheet, helpers
assets/           rink art and shape images
```

## Development

Serve the folder with any static server and open it:

```
python3 -m http.server 8080
```

There is no test suite; verify changes by loading the app and exercising
the editor. See `AGENTS.md` for the rules AI contributors follow.
