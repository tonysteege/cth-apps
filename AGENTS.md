# AGENTS.md - cth-diagrammer

Operating rules for ANY AI editing this repo (Claude Code, Codex, Notion AI,
GitHub-connected agents). Read this fully before changing anything.

## What this is

CTH Apps - Tony's web app hub, live at https://apps.coachtonyhockey.com/.
The repo root `index.html` is the hub (a launcher page listing every app);
each app lives in its own subfolder and serves at its path. Today there
are three apps: **Diagrams** at `/diagrams/` (the hockey diagram editor),
**Clips** at `/clips/` (video tagging and clipping over Tony's own folder), and
**Slides** at `/slides/` (Notion pages as film-session slideshows). `/present/`
is a compatibility redirect that preserves existing `#p=...&s=...` links. Static
site, no build step: GitHub Pages serves the `main` branch as-is. **Merging
to `main` IS the deploy** - the live site updates within about a minute.
The interface says "Diagram"; the `#/drill/` hash and the `drills`
IndexedDB store are frozen storage terms - do not rename them. Diagrams has
a HOME PAGE at `#/` again (2026-08-25, Tony's call, reversing 2026-08-24):
a library landing page like Clips and Slides - recent cards, a searchable
folder-grouped list, Import, Back Up and + New Diagram. The editor keeps
the sidebar file tree (folders, drag and drop, right-click menu); the
editor's Back button goes to the home page, and the home page's Back goes
to the hub. There is NO canvas zoom, on purpose - the stage sizes itself
to the window. Folders show a folder glyph (`.fic`) in the tree and on the
home page, matching the Clips tree.
Diagram "Save PNG" buttons write the diagram (or one rink) into the CTH
folder at `/diagrams/<name>-<full|rink-n>.png`, replacing the same file on
every re-save (2026-08-26). This replaced a Dropbox upload that returned a
public link: a file on disk has no URL, so there is nothing to paste into
Notion - the file itself is the deliverable.

**FILES LIVE IN TONY'S OWN `cth` FOLDER, NOT DROPBOX** (2026-08-26, Tony's
call). `clips/js/localfs.js` is the one file backend for all three apps.
It uses the File System Access API: Tony picks his `cth` folder once, the
handle is remembered in the `cth-files` IndexedDB (store `handles`, key
`root`), and every path stays relative to it -

  /videos, /videos/exports, /videos/recordings, /diagrams

which are the SAME path strings the Dropbox build stored on each game
record, so an existing library keeps resolving with no migration. Nothing
is uploaded and no network call is made. Two things only Dropbox could do
are gone and cannot be rebuilt locally: PUBLIC LINKS for Notion embeds and
emailed clips (a local file has no URL - `clipEmbedUrl` now throws a
plain-words error unless the record carries an external URL), and access
from any machine other than this Mac. `showDirectoryPicker` is Chrome and
Edge only; Safari and Firefox fall back to the one-file picker the app
already had (`fsSupported()` gates this). Permission is re-checked at boot
with `queryPermission`; when it reads `prompt` the app shows a Reconnect
Folder button, because `requestPermission` only runs from a click.

The old address diagrammer.coachtonyhockey.com is a Cloudflare Worker
(`redirect-worker/`, deployed with wrangler, not part of the Pages site):
it 301-redirects everything to the new home and serves `/export`, the
one-time storage-migration bridge the app calls on first load at the new
origin. Its DNS record must stay proxied or the Worker route never runs.

## How to work here

- Plain HTML, CSS, and ES-module JavaScript only. No frameworks, no npm, no
  build tooling, no TypeScript. Keep it that way - zero-build is what lets
  any AI edit this app safely.
- **Keep this file current in the same commit.** Any change that adds an
  app, or alters a storage format, URL, Worker, rule, or workflow, must
  update this AGENTS.md in the same change. Every AI session (including the
  cth-apps skill) reads this file as the live source of truth for the whole
  hub - a stale line here misleads every future edit. A brand new app also
  gets: its own subfolder, a hub card on the root index.html, a unique black
  line-icon favicon matching its hub card icon, and its own rules section in
  this file.
- Working from GitHub only (Notion AI or similar): branch, commit, open a
  pull request, merge. Small, focused changes; say in the PR exactly what
  the user asked for and what changed.
- File map is in README.md. Styling lives in `css/app.css` on the BoardUI
  design system (2026-08-26, Tony's call, replacing the greyscale-only
  system): a neutral ramp (`--n-50`..`--n-950`, white surfaces, `#f7f7f7`
  page background, `#ebebeb` hairlines) plus ONE accent, the BoardUI blue
  ramp (`--a-50`..`--a-800`, CTA gradient 500->600). Inter 400 body / 500
  labels / 600 headings for chrome; the accent is for primary buttons,
  focus rings, and selected states only. DIAGRAM CONTENT rendering
  (on-ice text at weight 800, the PALETTE colors, exported PNGs) is a
  storage/interchange contract and did NOT change with the retheme - the
  `.ed-input*` fields mirror committed content and keep weight 800. The
  hub `index.html` carries a copy of the same tokens inline. No emojis,
  no em dashes in UI copy. Do not invent colors outside the two ramps.
  The four toolbar presets default to black / blue `#75d8ff` /
  grey `#d9d9d9` / green `#16a34a` (green replaced red as the fourth
  preset on 2026-08-24). `red` `#dc2626` is no longer a default preset but
  stays in `PALETTE` forever, because saved diagrams and CTH Film Room
  still store `color: 'red'`. Tony can point any preset at any colour by
  right-clicking it, which writes a raw hex into `cthd.settings.v1`.

## Hard rules

1. **Never break saved diagrams.** They live in users' IndexedDB as
   `{ id, name, notes, folder?, created, updated, thumb, state }` where
   `state` is `{ v: 1, w, h, bg, seq, elements, rinkNames? }` and elements
   may carry an optional `rot` (degrees). Element shapes (player,
   arrow, stamp, pucks, box, circle, text, pen) and their property names
   are a storage format AND an interchange format with CTH Film Room -
   never rename or remove a property. Adding optional properties is fine
   with a fallback for old records. An element's `color` is either a slot
   name (black / blue / grey / red) or a raw hex from a customized preset.
2. **Never change the PNG embedding.** `js/png.js` writes the editable
   state into exported PNGs under the `tEXt` keyword `cthDiagram`
   (base64 JSON), byte-compatible with CTH Film Room. Same rule as above:
   additive changes only.
3. **Keep `drawEl()` (js/flat.js) and `svgEl()` (js/editor.js) in step** -
   the live SVG editor and the exported flat PNG must render every element
   identically.
4. **Rink geometry is measured, not designed.** The landmark coordinates in
   `js/rink.js` are measured off `assets/rink.png` (3200x1600) and match
   Film Room exactly. Do not adjust them or swap the rink art casually.
5. Do not add analytics, external services, accounts, or network calls.
   The app is fully client-side and private by design.
6. **Diagrams AUTOSAVES** (Tony's call 2026-08-26, reversing the
   manual-save rule of 2026-08-24). An edit calls `markDirty()`, which
   raises the flag and schedules the write; `saveNow()` runs once the edits
   stop. The timer is DEBOUNCED (`AUTOSAVE_MS`, 1000ms in `js/editor.js`)
   and must stay that way - every drag step calls `markDirty`, so a fixed
   interval would run a state clone and a thumbnail render mid-motion. Save
   and Cmd+S still write immediately. Because the debounce leaves a window,
   three guards flush or catch it and must not be removed: the
   `visibilitychange` and `pagehide` handlers (both save) and the
   `beforeunload` handler, all in `js/app.js`. The hashchange leave sheet
   stays as well. This reversal is only safe because of rule 7.
7. **Never cache a dead IndexedDB connection.** `js/store.js` drops its cached
   handle on `close`/`versionchange` and retries once on a closing-connection
   error. Without that, one closed connection makes every later save fail with
   `InvalidStateError: The database connection is closing.` - which is exactly
   the bug that made manual save necessary in the first place.

## Clips (/clips/) rules

- Clips reads game film from `/videos` inside the chosen CTH folder and
  writes exports to `/videos/exports`, through `clips/js/localfs.js`. There
  is no server, no account and no upload. A video opens as a real `File`,
  which is also the scrub decoder's fast path (`File.slice` rather than
  HTTP range requests), so local film scrubs better than Dropbox film did.
  The legacy `cthc.dbx.v1` localStorage key is dead but is left alone.
- Marks (clips, tags, freezes) AUTOSAVE to the `cth-clips` IndexedDB - a
  coach tagging at game speed cannot stop for a Save button. Do not copy
  the Diagrams manual-save rule here; they are different by design.
- The game record shape `{ id, name, path, source, duration, clips,
  freezes }` and the clip shape `{ id, label, color, in, out, tags, note }`
  are storage formats - additive changes only. `source` is `'local'` (a
  one-off picked file) or `'folder'` (resolve `path` inside the CTH
  folder); records written by the Dropbox build say `'dropbox'` and must
  keep working - readers treat anything that is not `'local'` as
  folder-backed. `videoTags` (2026-08-25) is
  an optional array of strings on the game record: the VIDEO's own tags,
  shown and edited in the library file tree, distinct from a clip's `tags`.
  Settings gained optional `logW` / `sideW` (the clip log's and tag
  column's widths in px) and `scrubSensitivity`.
- **The library file tree is full-width and tag-aware** (2026-08-25). Video
  rows carry their `videoTags` as chips with a write-in box (Enter adds,
  the chip's x removes, clicking a chip searches it); the search bar above
  the tree has a scope select (Tags + Clips / Tags Only / Clips Only) that
  matches file names, video tags, and the clips inside each game record,
  plus a "Matches Elsewhere In Your Library" section for tagged games
  outside the open folder (records only - it never walks the folder tree
  recursively). New Folder creates a real folder on disk via
  `fsCreateFolder`. Exporting a clip also writes a library record
  for the exported file carrying the clip's label and tags, so exports
  arrive in the tree already tagged.
- **The scrub engine is PORTED FROM CTH FILM ROOM** (2026-08-25), from
  `film-room/renderer/js/player.js`, which is where that feel was tuned.
  `scrubDeltaSeconds` and `scrubMotionStep` are copied to the number - do
  not "simplify" them into a constant rate:
  - The rate is VELOCITY based (px per millisecond) with an asinh knee that
    compresses only the fast tail, then integrated over each event's real
    elapsed time. That integration is why light and coalesced gestures land
    in the same place: macOS reports trackpad force as bigger deltas AND may
    fold the same travel into fewer events, so anything counting per-event
    measures the reporting, not the finger. Verified: 4px/8ms, 8px/16ms and
    16px/32ms all give 6.91 s/sec.
  - `scrubMotionStep` is a time-based spring easing the PAINTED position
    onto the finger, and it is the smoothness. Two positions are kept apart:
    `aim` (raw, jumpy) and `pos` (eased). Readouts follow `pos`.
  - Steps under half a frame are not seeked; one seek is in flight at a
    time, released by the video's own `seeked` event. That listener is
    load-bearing: without it every gesture fires one seek and then waits out
    the 250ms safety timeout, which is a scrub that moves in lurches.
  - Swipe RIGHT advances (macOS sends negative deltaX; `scrubReverse`
    flips it). The timeline drag rides the same engine via `scrubTo`.
  - THE DECODER IS PORTED TOO (2026-08-25, second pass): `scrubsource.js`
    is Film Room's WebCodecs engine plus its mp4 demuxer, whole - the moov
    sample tables are parsed in the browser (DataView instead of Buffer)
    and frame bytes come from `File.slice` - which every video now takes,
    since they all open as real files (the HTTP Range path against a remote
    URL is still in the code for externally linked media; a server
    answering 200 to a Range request is refused and the engine falls back). While a gesture runs, decoded
    frames paint onto a `.scrub-paint` overlay canvas over the video, so a
    step costs ~2ms instead of a ~28ms element seek; on release the element
    takes the exact final frame and the overlay drops only once it has it.
    Verified in-browser: a 30-minute 54,000-sample H.264 file indexed in
    ~200ms local / ~830ms over ranges, and 77 of 80 scrub requests served
    exact decoded frames. Degrades to plain seeking for webm, fragmented
    mp4, rotated files, unsupported codecs and range-refusing servers.
    Debugging: create `window.__scrubDebug = {}` before a video opens to
    get the live source (`.src.stats`), and `window.__scrubTrace = []` to
    record per-refresh pump decisions - Film Room's own diagnostics.
  - History worth keeping: a duration-proportional rate (a swipe crosses the
    file) ran 7-50 s/sec on game film and was far too fast; a fixed 0.005
    s/px was then too slow and still choppy because `fastSeek` was snapping
    every small step to a keyframe. Do not reintroduce either.
- **The player layout is mChapters-shaped** (2026-08-25, Tony's call):
  left to right, Clip Log, tag column, video. The log is a striped table
  (sticky TIME | CLIP header, alternating rows, H:MM:SS via `fmtHMS`, ink
  selection); the tag column is slim with 7-character buttons (`btnLabel`,
  `BTN_MAX`) that are SOLID in their own colour. Both panels have a grip
  (log minimum 150px, tags 104px - one whole button) and both collapse from their header
  button, which is what gives the video the whole window. Widths persist in
  `settings.logW` / `settings.sideW`. The timeline is a 26px lane on ink
  with the two timecodes in the transport row beneath it, and there is no
  permanent hint text on screen.
- **Tag and clip buttons are SOLID COLOURED buttons** (2026-08-26, Tony's
  call, replacing the white chip with a colour dot). Each one is the
  BoardUI primary-button recipe at small size, tinted with the button's
  own assigned colour: a 180deg gradient from the colour to a darker stop,
  a 1px darker edge, an inset white top highlight, `--r-sm`, 4px/8px
  padding, 11.5px semibold. The colour IS the button, so the dot is gone.
  Because the colour is user-picked, the LABEL COLOUR IS COMPUTED, not
  fixed: `btnFg()` in `player.js` takes WCAG relative luminance and returns
  ink or white, handed to CSS as `--fg` beside `--c`. Without it the
  Light Grey preset (which is the default for a new button) would be white
  on near-white. An applied tag shows an inset ring in `--fg`.
- **The tag buttons do not resize with the column** (2026-08-26, Tony's
  call). A container query used to shrink their type and padding under
  96px, so they moved about while the grip was dragged. That query is
  gone; the buttons are one fixed size and `SIDE_W_MIN` (app.js) is 104px
  instead of 58px, which is the narrowest column that holds a whole
  button. Do not reintroduce a size-reactive rule here.
- **The tag panel reorders and the editor builds it** (2026-08-25): its own
  vertical drag handle (width persists in `settings.sideW`, double-click
  resets, 104px minimum - see the fixed-size rule above), a header Tags
  button to collapse it, and drag-to-reorder within a tier. The panel editor has preset swatches (light grey
  included, and it is the DEFAULT for a new button), a colour well for
  anything else, Copy to duplicate a button (never its hotkey), dividers,
  and drag-to-reorder. A divider is `{id, tier, divider: true}` in the same
  `panel.buttons` array - anything reading that array must skip dividers
  (`panelButtons` does; `panelItems` keeps them for rendering).
- **The panel editor is a real form** (2026-08-26, Tony's call). Every
  `.pe-` class it uses was referenced by `player.js` and defined in NO
  stylesheet, so the dialog rendered as a wrapping stack of raw inputs with
  the twelve preset swatches showing as bare dashes, and its Save button
  fell off the bottom of the screen where it could not be reached. It is
  now: one CSS grid shared by a column header and its rows (the actions
  column is a FIXED 78px - as `auto` the empty header cell collapsed and
  pushed every heading off its field), a scrolling body between a fixed
  title and a fixed footer, and ONE colour well per row opening a single
  shared popover instead of twelve swatches printed on every row. The
  hidden `.pe-color` input stays in each row, so the save reader is
  unchanged. Keep `.pe-label`, `.pe-key`, `.pe-color` and `.pe-num` on
  their inputs - the reader finds the values by those class names.
- Freeze-frame drawings use the DIAGRAMS element model and renderer
  (`/diagrams/js/flat.js` is imported cross-app); keep that import working.
- `clips/embed.html` is the Notion-embeddable single-clip player; its hash
  parameters (v, in, out, t) are a public URL format - never break them.
- IndexedDB helpers in both apps' store.js: a `get` on a missing key must
  return undefined, never the raw IDBRequest (that bug shipped once).

## Slides (/slides/) rules

- Slides renders a LIVE Notion page as slides through the Worker in
  `present-worker/` (cth-present-api on apps-api.coachtonyhockey.com,
  deployed with wrangler; secret NOTION_TOKEN). Notion has no browser CORS,
  so the Worker is required; it exposes ONLY /notion/page/<32-hex id>, no
  search or listing, CORS locked to the CTH Apps origins. Content is always
  current - never add a publish step, webhook, or content cache beyond the
  Worker's 60-second edge cache.
- The slide grammar is a contract with how Tony writes pages: page title =
  dark cover slide, every heading_2 starts a slide, every divider cuts a
  slide (keeping the current header), heading_1 makes a dark section slide.
- Slide links come from a Notion FORMULA property (name: Slides):
  `"https://apps.coachtonyhockey.com/slides/#p=" + id()` - the app also
  accepts any pasted Notion URL. The #p=<id>&s=<n> hash format is public.
- Clips embed URLs, uploaded video files and external video URLs all render
  as the scrubbable in-slide player (media.js); telestration reuses
  /diagrams/js/flat.js. Screen recordings save into the CTH folder at
  `/videos/recordings` through ../clips/js/localfs.js (same origin, same
  folder handle), with Download always offered alongside.

## Verifying a change

There is no CI test suite. Before opening a PR, reason through: does the
change touch the storage format, the PNG format, or the render pair
(drawEl/svgEl)? If yes, re-read rules 1-3. If you can run a browser, load
the app, create a drill, place a few elements, wait a second for autosave
(the status word goes Unsaved then Saved), reload (the saved work must
survive), and export a PNG. Check the editor at a narrow window too: the
rink stage scrolls vertically only, and a sideways scrollbar anywhere is a
bug (`.ed-stagewrap` is `overflow-x: hidden`, `html, body` are capped).
