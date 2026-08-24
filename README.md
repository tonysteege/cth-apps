# CTH Diagrammer

Hockey drill diagramming for Coach Tony Hockey. A standalone web app: design
drills on a full rink, save them in the browser, and export game-ready
images that stay editable.

**Live app:** https://tonysteege.github.io/cth-diagrammer/

## What it does

- Full rink opens game-ready: nets in both creases, a goalie at each end.
- Players (black / blue / grey), curved and dashed arrows with four head
  styles, shaded zone boxes, text labels, freehand pen, crop, flip.
- Rink items: net, coach, puck, puck pile, cone, border pad. One-click 5v5
  centre-ice faceoff.
- "+ Rink" stacks up to five rinks below as a drill sequence, saved as one
  image, each new frame copying the one above it.
- Snapping to rink landmarks (goal lines, blue lines, centre, dots, creases)
  and to other objects, with alignment guides. Cmd disables it.
- Multi-select (marquee, shift-click), group move, copy / cut / paste /
  duplicate, undo depth 60, keyboard shortcuts with user-set custom keys
  (right-click any tool).
- Drill library with autosave, search, duplicate, delete, thumbnails.
- Export: PNG download, clipboard copy, print, one-file JSON backup and
  restore.

## The PNG format

An exported PNG carries its full editable state in a `tEXt` chunk with the
keyword `cthDiagram` (base64 JSON) - the exact format CTH Film Room uses.
A drill PNG made here reopens fully editable both here and in Film Room,
and a Film Room diagram PNG imports here fully editable.

State shape: `{ v: 1, w, h, bg, seq, elements }` where `bg` is null for
standard rink layouts (rebuilt from `assets/rink.png`) or a data URL, `seq`
is the number of stacked rinks, and `elements` is the array of players,
arrows, stamps, boxes, text, and pen strokes.

## Stack

No build step, no framework, no dependencies. Static HTML + ES modules,
deployed by GitHub Pages straight from `main`. Drills persist in the
browser's IndexedDB.

```
index.html        app shell
css/app.css       all styling (CTH greyscale design system)
js/app.js         routing, library view, editor shell, import/export
js/editor.js      the drill editor (interaction, SVG render, toolbar)
js/flat.js        pure canvas rendering of elements (exports, thumbnails)
js/rink.js        rink geometry, landmark coordinates, asset loading
js/store.js       IndexedDB drill storage
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
