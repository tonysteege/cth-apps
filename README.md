# CTH Apps

The home for Coach Tony Hockey's web apps, live at
https://apps.coachtonyhockey.com/. The repo root is the hub page; each app
lives in a subfolder and serves at its own path.

## Apps

- **Diagrams** (`/diagrams/`) - hockey diagram design: drills and plays on
  a full rink, saved in the browser, exported as game-ready images that
  stay editable.
- **Slides** (`/slides/`) - any Notion page as a film-session slideshow:
  dark logo cover, light slides cut at every H2 and divider, scrubbable
  in-slide video (Clips embeds, uploads, external links), telestration on
  every slide, overview grid, blackout, built-in screen recording saved
  into the CTH folder. Links come from one Notion formula property; content is always
  live, so nothing ever needs republishing.
- `/present/` remains a compatibility redirect that preserves existing slide links.
- **Studio** (`/studio/`) - game film into the finished analysis video:
  telestration that animates (spotlights, light beams, tapered arrows,
  hatched walls, zone shading, label chips), freeze frames, slow motion,
  punch-in camera moves, and reframing to 9:16 or 1:1 with a keyframed
  crop that follows the play. Marks can TRACK a player from two clicks.
  Exports a real MP4 in the browser, plus GIF and stills, straight into
  Dropbox with a link ready for Notion. Reads film from Dropbox, a file
  on the device, or any video URL.
- **Videos** (`/videos/`) - the video storage centre: upload any size
  at full quality (multipart into Cloudflare R2 through the API Worker,
  nothing re-encoded), a library with posters, a player with the Studio
  scrub feel (WebCodecs decoder over a Range-capable stream), share links
  for players and parents that also embed in Notion (`watch.html?v=<id>`),
  a direct file link, and one-click hand-off into Studio and Clips Notion.
  Studio can export straight into it.
- **Clips** (`/clips/`) - video tagging and clipping: game film read
  straight from the CTH folder's `videos` (pick the folder once), two-tier
  tag buttons with hotkeys and lead/lag, trackpad scrubbing, a filterable
  clip log, live freeze-frames with diagram-style annotation, and real
  video exports back into `videos/exports`. Nothing is uploaded anywhere.

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

## Studio's File Map

```
studio/index.html      app shell
studio/embed.html      the Notion / Obsidian embed player (public URL format)
studio/css/app.css     all styling (CTH tokens, dark where the film is)
studio/js/app.js       shell, library, Dropbox browser, settings
studio/js/editor.js    stage, tools, inspector, timeline, export flow
studio/js/timemap.js   output time <-> source time: freeze, slow, cut, trim
studio/js/marks.js     the telestration vocabulary and its ONE renderer
studio/js/render.js    the compositor: picture + camera + marks -> a frame
studio/js/scrub.js     the Clips/Film Room scrub curve over the time map
studio/js/encode.js    MP4 / WebM / GIF / PNG export, retimed audio
studio/js/mp4.js       a minimal ISO BMFF muxer (no dependency)
studio/js/dropbox.js   PKCE auth, browse, temp links, upload, share links
studio/js/store.js     IndexedDB projects, settings, backup
studio/js/ui.js        toasts, sheets, progress, icons
```

## Videos' File Map

```
videos/index.html      app shell (library, upload, one video with its links)
videos/watch.html      the public share / Notion embed player (public URL format)
videos/css/app.css     what Videos adds on top of studio/css/app.css
videos/js/app.js       routes, library, upload sheet, detail view, settings
videos/js/player.js    the player: <video> plus the Studio scrub engine overlay
videos/js/api.js       the Worker client: key, list, multipart upload, links
videos/js/watch.js     the share page
present-worker/videos.js   the API: R2 multipart, Range streaming, KV index
```

## Development

Serve the folder with any static server and open it:

```
python3 -m http.server 8080
```

There is no test suite; verify changes by loading the app and exercising
the editor. See `AGENTS.md` for the rules AI contributors follow.
