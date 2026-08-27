# AGENTS.md - cth-diagrammer

Operating rules for ANY AI editing this repo (Claude Code, Codex, Notion AI,
GitHub-connected agents). Read this fully before changing anything.

## What this is

CTH Apps - Tony's web app hub, live at https://apps.coachtonyhockey.com/.
The repo root `index.html` is the hub (a launcher page listing every app);
each app lives in its own subfolder and serves at its path. Today there
are four apps: **Diagrams** at `/diagrams/` (the hockey diagram editor),
**Clips** at `/clips/` (video tagging and clipping over Tony's own folder), and
**Slides** at `/slides/` (Notion pages as film-session slideshows), and
**Bots** at `/bots/` (a board of small single-purpose AI helpers). `/present/`
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
5. Do not add analytics, accounts, or third-party embeds; there is no
   sign-in anywhere and no telemetry, ever. Diagrams and Clips remain
   FULLY CLIENT-SIDE - they must never gain a network call. Network access
   is confined to the two apps that cannot work without it, and only
   through the CTH Worker in `present-worker/`: Slides fetches Notion, and
   Bots (2026-08-27, Tony's call) calls the model providers. Provider keys
   are WORKER SECRETS and never touch this repo or the browser. Adding a
   third destination to that Worker needs the same bar: Tony's ask, a
   locked CORS origin list, no stored state, no logged prompts.
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

- **Toolbar popups, never a growing toolbar** (2026-08-27, Tony's call).
  Arrow head and line weight used to APPEND to the toolbar whenever a line
  tool was armed or a line was selected, so the bar grew by seven buttons
  and every tool under the pointer shifted sideways. They now live in
  `showLineMenu()` - the same `.pmenu` panel the player letters use, opened
  on hover for a mouse and on a second press of the armed button for touch,
  closed on Escape, on leaving, and by `paintTools`/`closeEditor`. The pen's
  menu omits Head, because a freehand stroke has no arrowhead. The choices
  still apply to the current selection as well as to the next line drawn.
  Two rules keep this working: `cur.head` and `arrowPx` must stay OUT of the
  `toolsSig` render signature (otherwise choosing inside the popup repaints
  the bar and closes it), and the popup updates its own `.on` states rather
  than repainting. Any future contextual control belongs in a popup too -
  the toolbar's width is fixed by design.

- **MOTION ARROWS ARE FIVE TOOLBAR TOOLS** (2026-08-27, Tony's call,
  second pass): Skate `A`, Skate With Puck `S`, Skate Backwards `Z`,
  Shoot `X`, Pass `P`. `LINE_SPEC` in editor.js maps each tool to the
  `dash` / `motion` it stamps - the popup's old Type row is gone, the
  tool IS the type. P became Pass, so the PEN MOVED TO `E` and the pucks
  stamp moved off S to `U`; any key Tony has customized still wins.
  An arrow may carry an optional ADDITIVE `motion` property: 'puck'
  (a smooth open wave, about one cycle per 130 units), 'backward' (ONE
  CONTINUOUS scalloped line of half-circles - it must never go back to
  detached letter shapes, which read as text on the ice), 'shoot' (a
  doubled line). Absent means plain skating; a pass stays `dash: true`. Old consumers (Film
  Room) draw a plain arrow - additive contract preserved. The decoration
  geometry lives ONCE in flat.js (`motionPolys`, `arrowPathPoints`,
  `arrowPointAt`, `arrowLength`) and both renderers consume it - that is
  what keeps drawEl and svgEl identical; never inline the math into one
  side. The arrow tool's popup gained a Type row (arrow tool only - a pass
  IS the dashed tool, a pen stroke is a drawing); the chosen type persists
  in `cthd.settings.v1` as `arrowMotion` and retypes selected solid arrows
  like head and weight do.
- **THE DRILL ANIMATOR** (`js/anim.js`, 2026-08-27). The Animate button in
  the editor header turns the drawn diagram into a smooth animation with
  no extra authoring: each rink of a sequence is a phase; every arrow
  moves the nearest thing at its tail (skating arrows move players, a
  pass/shot moves a puck, Skate With Puck carries it); an arrow whose tail
  sits near another's head WAITS for it (chained timing - skate, pass,
  shoot); a pass with no drawn puck conjures one, and a puck arriving at a
  pass's tail is reused so one puck flows through the chain; between rinks
  the matched objects (players by label+colour, pucks) glide from where
  the phase left them to where the next rink draws them. Rendering reuses
  `drawEl` so the animation is pixel-identical to the PNG. Exports: GIF
  (own dependency-free GIF89a encoder in anim.js - 216-cube + grey-ramp
  palette, LZW) and WebM (MediaRecorder, real-time), both saved to the CTH
  folder's `/diagrams/<name>-drill.gif|.webm` via localfs with a download
  fallback. NOTHING is stored on the diagram - edit, press Animate again,
  the new sequence plays. Viewer prefs (speed, size, fps, routes) live in
  localStorage `cthd.anim.v1`, not on the drill record.
- **Colour hotkeys recolor the selection**: keys 6/7/8/9 arm colour
  presets 1-4 AND recolor every selected element that has a colour
  (`chooseSlot`), in bulk. This predates the animator; do not break it.

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
  - **SCRUB MUST LOOK LIKE THE FILE** (2026-08-26). Two things were quietly
    downscaling the picture during every gesture, which read as "the video
    quality is terrible" even though playback itself was untouched: the
    overlay canvas took the DECODER's dimensions rather than the video's, so
    the first act of every gesture was copying the full-res frame down to
    1280 wide; and `CACHE_MAX_W` capped decoded frames at 1280 on 1080p
    film. The overlay is now sized to `videoWidth`/`videoHeight` and the
    cache cap is 1920. Keep both: sizing the overlay off the decoder again
    reintroduces the exact complaint.
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

## Clips rebuild (2026-08-27)

Tony specified a 45-item rebuild in one message; `clips/REBUILD.md` tracked
it and every item is shipped. The rules worth keeping:

- **EXPORTS LAND BESIDE THEIR SOURCE**, in the folder the video itself is
  in - not `/videos/exports`, which is where they used to go. Names come
  from a pattern in Settings (`{name} {tags} {hhmmss} {label} {date}`) and
  a missing token collapses WITHOUT the dash that joined it, so a clip
  with no tags is `Goal-1-001240` and never `Goal-1--001240`.
- **EXPORTING IS SILENT.** No progress bar, no sheet, no success toast -
  the file appearing is the report. Only a failure speaks, and it names
  the file AND the folder it could not write to, because "export failed"
  alone is not actionable.
- **EVERYTHING IS COMPOSITED THROUGH A CANVAS** (`clips/js/export.js`),
  never captured off the video element. `video.captureStream()` hands you
  the picture and nothing drawn over it, so an annotation could not
  otherwise reach the file. The canvas takes the video's own pixels - the
  same "look like the file" rule the scrub engine had to learn.
- **FREEZE EXPORTS, IT DOES NOT SAVE.** Done exports the window around the
  playhead with the frame held and the drawings baked into the HELD FRAMES
  ONLY; an annotation floating over live action reads as a glitch. Nothing
  is written to the Clip Log. Right-click Freeze or Pull to set its
  buffer; both default to 5s before, 10s after.
- **RECORD CAPTURES A REGION OF THE VIDEO, NOT THE DESKTOP.** That is a
  deliberate reading of "record the screen" and the better one here:
  compositing from the video means the cursor ring and the annotations are
  already in frame, the toolbar can never be, no screen-picker interrupts
  the take, and the region is remembered across sessions. `getDisplayMedia`
  can do none of those. Do not "upgrade" this to a screen grab.
- **THE ANNOTATION POINTER MAPS TO THE PICTURE, NOT THE ELEMENT.**
  `object-fit: contain` letterboxes the bitmap inside the canvas box, so
  `getBoundingClientRect()` is not the picture. Mapping against it put
  every click off by the letterbox offset (a handle click landed 18 video
  pixels high). `viewBox()` in annotate.js is the fix; anything that turns
  a pointer into video coordinates must go through it.
- **A TOOL STAYS ARMED** until Escape or another tool. Escape disarms
  first and only closes once nothing is armed, so a stray Escape
  mid-drawing cannot throw the session away.
- The joint angle is drawn in `annotate.js`, NOT in `flat.js`: flat.js is
  an interchange contract with Film Room and must not grow a Clips-only
  element type. `drawAny()` routes it and delegates everything else.
- **TIMELINE**: a marker per TAGGED CLIP, coloured by its rating, that
  jumps there when clicked. Freeze marks are gone - freezes are exports
  now and those marks pointed at nothing. Pinch/wheel zooms about the
  pointer, swipe scrolls, double-click fits. `tl.span === 0` MEANS FIT and
  must stay 0 until something zooms: clamping a span before the file's
  duration is known pinned it at the 2-second floor and opened every
  video zoomed into its first two seconds.
- **CLIP LOG**: tags are one editable line, not pills; three rating dots
  (good/bad/star) are the only colour on a row; search is an icon;
  Clips/Tags are multi-select menus with counts, and ticking two tags
  WIDENS the view; the table headers sort; rows carry checkboxes for bulk
  Pull, Tag, Rename and Delete; right-click gives the full suite; Cmd+Z
  undoes the last tag or clip and must sit ABOVE onKey's modifier bail
  and BELOW its input guard.
- **PLAYERS** (`p`) pauses and opens the roster from Settings. Every
  player's key is printed on its row - a shortcut nobody can see is not a
  shortcut. The tag is the player's FIRST name through `normTag`.
- Email is gone; exported clips get mailed from the Finder.
- Side by side (`compare.js`) is a PLAYER MODE, not a drawing tool: two
  elements, two timelines, two transports. It imports `scrubDeltaSeconds`
  and `scrubMotionStep` rather than reimplementing them - that curve was
  tuned against Film Room and is the one thing here that must not drift.

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
  Two additions on 2026-08-26, both from the CTH slide template: a LEAD
  PARAGRAPH (a paragraph before any heading) becomes the cover's SUBTITLE
  and no longer opens the first content slide, and every content slide
  carries the name of the section it sits under (the last heading_1, or the
  deck title when there is none) as the small eyebrow above its header.
  Nothing new has to be written on a page for either.
- **Slide design follows the CTH template** (2026-08-26, Tony's call): the
  cover is left-aligned with the mark top left, the title on the lower
  third, the subtitle under it, the credit bottom right and an accent
  hairline along the foot. Content slides are eyebrow + header, then the
  body, with one media block sitting in a 4:6 split beside the text.
- **Rink diagrams read HORIZONTALLY.** A rink is 2:1, so a portrait one is
  about 0.5 wide-to-tall; any image landing between 0.38 and 0.62 is turned
  a quarter turn into a landscape box (`.sl-img--turned`, applied from
  `app.js` once natural dimensions are known). The window is deliberately
  narrow so an ordinary portrait photo, which starts around 0.66, is never
  touched. `transform` does not change layout, so the figure keeps its own
  2:1 box and the image is placed inside it - do not "simplify" that to a
  bare rotate, the tall footprint comes straight back.
- Slide links come from a Notion FORMULA property (name: Slides):
  `"https://apps.coachtonyhockey.com/slides/#p=" + id()` - the app also
  accepts any pasted Notion URL. The #p=<id>&s=<n> hash format is public.
- Clips embed URLs, uploaded video files and external video URLs all render
  as the scrubbable in-slide player (media.js); telestration reuses
  /diagrams/js/flat.js. Screen recordings save into the CTH folder at
  `/videos/recordings` through ../clips/js/localfs.js (same origin, same
  folder handle), with Download always offered alongside.

## Slides: authored decks (2026-08-27)

Slides has rendered Notion pages since it was built. It now ALSO has decks
Tony makes himself, on a whiteboard-like canvas modelled on Figma Slides
after a live inspection of it. The two live side by side.

- **THE NOTION ROUTE IS A PUBLIC URL FORMAT AND DID NOT MOVE.** `#p=<32hex>`
  and `&s=<n>` parse exactly as before; authored decks took the new shapes
  `#/d/<id>` to edit and `#/present/<id>` to present.
- **EVERY COORDINATE IS IN SLIDE SPACE - 1600x900**, the same numbers
  telestrate.js uses, never screen pixels; text is sized in `cqh` against
  the stage's container query. That one rule is why ONE record draws the
  editor, the rail thumbnails, the board, a deck card and the projector
  with no second layout anywhere. Anything reading a pointer maps back
  through the stage rect on the way in.
- **PRESENTING AN AUTHORED DECK REUSES THE WHOLE PRESENTER** - chrome,
  rail, counter, keyboard, telestration, screen recording and the video
  player. Only the slide elements come from elsewhere. Do not build a
  second presenter; two would have to be kept in step forever.
- **VIDEO ON AN AUTHORED SLIDE IS `mountVideo` FROM media.js**, the same
  player the Notion decks use, so a clip behaves identically either way.
- **MEDIA IS A BLOB IN THE `assets` STORE, referenced by an id** - never
  base64 on the deck record. A deck with an image and a clip on it stays
  about 1KB, so autosave can rewrite it on every nudge. Object URLs die
  with the page, so `rehydrate()` rebuilds them before anything renders.
- **IT SAVES ITSELF** (700ms debounce, flush on the way out). There is no
  Save button and there must never be one.
- Selection chrome lives in its OWN layer over the stage: redrawing it
  must never re-create the elements underneath, which would tear down a
  mounted video mid-drag. Move and resize only rewrite the boxes for the
  same reason.
- A dark layout carries its own text colour. The role defaults are ink,
  which is right on the white layouts and invisible on a black cover -
  the first thing a new deck showed was a black title on a black slide.
- **THE TYPE RAMP AND MARGINS ARE MEASURED, NOT CHOSEN** (2026-08-27,
  second pass, from a screen recording of Tony's own Figma template). The
  method is worth repeating for any future retheme: a slide's width on
  screen IS 1920 units, so one image pixel converts, and a glyph's cap
  height over Inter's 0.727 cap ratio gives the font size. The guessed
  ramp that preceded it ran small at every step - the subtitle worst, 44
  against a measured 66. Do not "tidy" these to round numbers.
- **THE BOARD IS A WHITEBOARD**: an unbounded canvas that pans on a
  two-finger swipe and zooms ABOUT THE POINTER on a pinch, with the slides
  in a row. THE CANVAS MOVES, THE SLIDES DO NOT - each frame sits at a
  fixed `left` and only the canvas is transformed, which keeps panning free
  and the geometry in the same units the editor uses. Number chips and the
  selection ring are scaled back out by `--inv` (1/zoom) or they vanish at
  20%. It was a CSS grid first, which is a contact sheet, not a canvas.
- **THE LOGOS COME FROM `cth/logos`**, copied into `slides/logos/` - the
  canonical files, never redrawn. The horizontal lockup is 1000x286
  (3.5:1), the icon square. Both the authored layouts and the Notion
  renderer point at these; the two older one-off copies that used to sit
  loose in `slides/` are gone.

## Design system rules (suite-wide)

- **Component recipes are BoardUI's own** (2026-08-26, full-fidelity pass,
  taken from the cth-boardui-starter source, not eyeballed):
  - INPUTS ARE FILLED, never outlined: n-200 surface (`--field`), no
    border, a 2px inset ring - transparent at rest, n-300 on hover, n-400
    on focus (`.bui-field` recipe / the per-field copies of it). Search
    fields are fully rounded pills. The ACCENT ring is reserved for
    keyboard `:focus-visible`; BoardUI does not focus inputs in blue.
  - SELECTED NAV is the accent gradient pill: `--grad-primary` fill, white
    text/glyph, `--shadow-nav` (0 0 0 1px accent-500 + inset white top
    highlight). Used by `.eside-row.on`, `.tb-btn.on`, `.log-row.on`.
  - SIDEBARS FLOAT: the editor tree (`.ed-side`) is a rounded-24 n-100
    panel with a 1px white border and `--shadow-side` (the Figma
    "Background/Sidebar Elevation" shadow, copied 1:1), except under 860px
    where the overlay drawer flattens it.
  - PANELS AND MENUS are radius 16 with 10px padding and 10px-radius
    items; sheets are radius 20; cards and list containers are radius 16.
  - TABLE HEADERS (`.log-cols`) are the BoardUI th: n-100 surface,
    hairline top and bottom, quiet 500-weight text in n-400, no uppercase.
  - Buttons: medium is 36px / radius 10 / shadow-card; secondary hovers to
    n-100 bg + n-300 border, active n-200 + n-400, press scale(0.98).
- **Pro components in service** (2026-08-26, after Tony bought BoardUI
  Pro; recipes from the updated cth-boardui-starter):
  - TOASTS are the notification card: white radius-16 surface, dropdown
    elevation, and a leading status disc (blue info pair; rose error pair
    for `.err`) drawn with masked inline SVGs - no assets, no network.
  - CHECKBOXES (`.rink-row input`, used by the Rinks sheet and Email
    sheet) are the BoardUI checkbox: white bordered box, and the accent
    gradient with the checkbox-selected inner highlight when checked.
    Radios get the round variant automatically.
  - The Add Video sheet leads with the FILE-UPLOAD dropzone (`.up-drop`):
    rounded-2xl n-100 surface, dashed perimeter that answers hover and
    drag-over, upload-icon disc on the quaternary tokens, real
    drag-and-drop wired in `showUpload` (`setFile`).
  - The Clips library folder trail is a BREADCRUMB (`crumbsHtml()` in
    app.js): every ancestor is a clickable jump, the current folder is
    quiet text, chevron separators are masked SVGs.
  - COUNTS (`.clib-count`, `.log-count`, `.eside-count`) are neutral
    chips: n-200 surface, n-500 medium text, radius 6.
- **The hub lists apps ALPHABETICALLY, always** (2026-08-27, Tony's call),
  as compact tiles: icon, name, arrow. No descriptions - a short board
  beats a tall one. A new app is inserted in alphabetical order, never
  appended.
- **SECTION LABELS ARE TITLE CASE, INK, BOLD** (2026-08-27, Tony's call),
  suite-wide: `font-size: 15px; font-weight: 700; text-transform: none;
  letter-spacing: -0.01em; color: var(--ink)`. This replaced the 11px
  uppercase-grey label every app used - the markup already carried Title
  Case text, the caps were the css. The same values are written into
  `.pe-title` and `.clib-title` (clips), `.dlib-title` (diagrams) and
  `.ph-title` (slides); keep the four in step. On a CARD the same label
  steps down to 13px (`.run-head .pe-title`) - 15px dominates a 268px
  column - but keeps the case, colour and weight. Table column headers
  (`.pe-head`, `.log-cols`) and micro column labels (`.side-label`) are a
  different thing and stay as they are.
- **Type ramp.** Chrome tops out at 600 (400 body / 500 labels / 600
  headings), except the section label above at 700. 700 is used only for SLIDE CONTENT, which is read across a
  room. 800 is NOT in the BoardUI ramp and survives in exactly four places,
  all of which mirror committed DIAGRAM CONTENT so the editing field
  matches what `flat.js` draws: `.ed-input`, `.ed-input-chip`,
  `.ed-input-flabel` and `.pmenu-chip` (plus `.an-textinput` in Clips).
  Do not "tidy" those to 600. (A 15px/800 Bots section label existed for
  one afternoon on 2026-08-27; Tony asked for 700 instead, which is now
  the suite-wide section label - see above. Nothing else may reach 800
  without his call.)
- **Colour.** The neutral ramp plus ONE accent. Danger is `--danger` /
  `--danger-soft`; no raw `#dc2626` or `rgba(180, 35, 24, ...)`.
- **Motion.** `var(--dur)` (150ms), never loose `.12s` / `.15s` values.
- **EVERY CLASS THE JS EMITS MUST HAVE A RULE.** Four separate dialogs
  shipped unstyled because `player.js` and `app.js` emitted class names no
  stylesheet defined: the panel editor, the Add Video sheet (its progress
  bar was literally invisible), the Email sheet, and three Slides
  renderers plus the video play button, whose `.playing` class styled
  nothing so the button never changed while a clip played. Before shipping
  UI, diff the classes the JS emits against the classes the CSS defines -
  a missing rule is silent, and the browser just renders raw inputs.
- Pages with their own inline `<style>` (`index.html`, `clips/embed.html`,
  `present/index.html`) carry a copy of the few tokens they need. Keep them
  in step with `diagrams/css/app.css` by hand.

## Bots (/bots/) rules

- Bots is a BOARD of small single-purpose helpers, not a chat app. Cards
  drag to reorder, resize across a 1-2 column by 1-2 row grid, take a
  per-bot colour and hide from the board; the layout lives in the
  `cth-bots` IndexedDB under `board`/`layout`.
- **ADDING A BOT IS ADDING ONE OBJECT** to `BOTS` in `js/registry.js`:
  id, name, blurb, icon, colour, kind ('text' or 'image'), its `inputs`,
  its `settings` schema and its `system` instruction plus a `prompt()`
  builder. Nothing else needs editing - the board, the runner, the
  settings sheet and the history all read that shape. Never rename an
  existing bot `id`: it is the key its saved settings live under.
- Per-bot settings (counts, style lists, save folder, and the INSTRUCTION
  itself) live in the `configs` store keyed by bot id, merged over the
  registry defaults. Storage is additive-only like every other CTH app.
- Image bots carry an editable STYLE list. Add From Image sends a
  screenshot to `/ai/vision` and saves the style description it reads
  back, which is how a style seen on YouTube becomes a reusable option.
  Best asks the text model to pick or invent the strongest style for that
  subject before generating - and if its pick matches one of Tony's own
  styles by name, it INHERITS that style's examples, otherwise choosing
  Best would quietly discard the references he attached.
- **VISUAL AID BOT'S STYLES ARE TONY'S OWN CATALOGUE** (2026-08-27): the
  52 formats from his "Visual Aid Types" page in Notion, read through the
  Worker and kept in `bots/js/visualtypes.js`, plus the three generic
  looks. A TYPE IS A STRUCTURE (Funnel, Iceberg, Fishbone), not a look -
  the prompt each one generates describes LAYOUT and leaves the rendering
  to the bot's instruction, which is what stops 52 options becoming 52
  different-looking images. A card shows at most `CHIP_MAX` chips and puts
  the rest behind a grouped, searchable picker; a row of 52 chips is a
  wall, not a control. The page also names Information is Beautiful as its
  quality bar - a text-to-image model cannot browse it, so that travels as
  `QUALITY_CLAUSE`, a described standard rather than a pretended lookup.
- **THE WORKER READS NOTION TABLES** (added 2026-08-27). `table` was not in
  the recursion whitelist and `table_row` had no case, so every table came
  back empty: Slides rendered nothing for them and a knowledge file made
  of tables looked blank. `cells` is now `rich[][]` per row.
- **A STYLE NAME IS ONE WORD** (2026-08-27, Tony's call) unless a second
  is load-bearing: Diagram, Sketchnote, Photo, Bold, Minimal - but Split
  Screen keeps two, because "Split" alone says nothing. The chips sit
  four to a card, so a two-word name wraps. Renaming the DEFAULTS needs a
  migration (`migrateStyles`), because a saved config carries its own
  copy of the list; it renames only where the saved name still equals the
  old default exactly - a name Tony typed is his.
- **A STYLE CARRIES UP TO 3 GOLD-STANDARD EXAMPLE FILES** (2026-08-27).
  Images, video or text. THE BYTES LIVE IN THEIR OWN `examples` STORE
  (IndexedDB VER 2, additive) keyed by the example's uid; the config
  keeps only `{ id, name, mime, kind, note }`. Blobs on the config would
  be read by every `cfgOf` - which runs for each bot at boot - so a few
  reference videos would make the board's first paint read hundreds of
  megabytes. Previews load lazily in the settings sheet and every object
  URL is revoked when it closes.
  HOW AN EXAMPLE ACTUALLY REACHES THE MODEL: as WORDS. These image
  models are text-to-image, with no reference-image input, so each file
  is READ ONCE WHEN ATTACHED - an image through `/ai/vision`, a video
  through a frame a third of the way in, a text file as its own excerpt -
  and the description is stored as `note`. `exampleLines()` folds those
  notes into the prompt at run time, so a run costs no extra vision
  calls. Never imply to Tony that the picture itself is being sent.
  Uploads are not committed until Save: Cancel deletes what it added,
  and removals only become permanent on Save.
- **KNOWLEDGE FILES ARE A BOT'S PRIMARY SOURCES** (2026-08-27, Tony's
  call): up to 6 Notion pages or text files it treats as authoritative,
  above whatever the model happens to know. They live on the config as
  `knowledge: [{id, kind, name, url?, text, at}]`; a file's bytes go in
  the same `examples` store. Two rules make this behave. A NOTION PAGE IS
  RE-READ ON EVERY RUN through the Worker's `/notion/page/<id>` (60-second
  edge cache), falling back to the snapshot taken when it was added if the
  fetch fails - a source that goes stale the day it is attached is not a
  source, and a page that cannot be reached must not take the bot down
  with it. And IT IS BUDGETED: the Worker caps a prompt at 8000
  characters, so the block is capped at 4200 and split evenly between
  sources rather than letting the first one eat the room. It is injected
  into the SYSTEM message. Because an image model here is text-to-image, a
  bot that HAS knowledge runs one extra fast text call that rewrites the
  brief through it first; a bot with none skips that entirely and runs
  exactly as fast as before.
- SETTINGS SECTION ORDER IS Card, Behaviour, Instructions, Knowledge
  Files, Styles
  (2026-08-27, Tony's call). Styles goes LAST because it is by far the
  tallest section once examples are attached, and the global instruction
  everything inherits belongs above it, not past a scroll of style rows.
  A style's instruction is a TEXTAREA that grows with its text (64px to
  320px, `resize: vertical`) - it was a 32px input showing six words of a
  forty-word description. Style rows REORDER by their grip, and that order
  is the order of the chips on the card. Settings fields use
  `--field-soft` (n-100 with an n-200 hairline), not `--field`: the sheet
  stacks big slabs of field where a card shows one small input, and n-200
  reads far heavier at that size.
- **REORDERING IS `js/sortable.js`, NEVER HTML5 DRAG-AND-DROP** (both the
  board and the style list). HTML5 DnD drags a translucent SNAPSHOT while
  the element stays put, then plays its own un-cancellable snap-back on
  drop - that jump was the bug. The pointer sortable moves the real
  element, FLIP-animates its neighbours as the order changes, and lands
  the card into its new slot. Two things in it are load-bearing: every
  frame CLEARS the transform, re-measures the layout box and re-derives
  the transform, because re-inserting the element mid-drag moves its
  layout position and the same transform would jump it; and the move/up
  listeners live on the WINDOW, not the grip - relying on pointer capture
  means a lost capture never fires `end`, and `is-sorting` (which sets
  `pointer-events: none` on every other card) sticks until a reload.
- A NUMBER SETTING IS CLAMPED ON SAVE, not just in the input's min/max.
  An empty or unparseable field used to persist 0 or NaN straight into
  the prompt ("Give exactly NaN cue options") and stay there.
- Results save into the CTH folder through `clips/js/localfs.js` at each
  bot's configured folder (`/visuals`, `/thumbnails`), download fallback.
  Refine re-runs with a region hint derived from a box drawn on the
  option - it is prompt text, not inpainting, and must not claim to be.
- The model calls go to the SAME Worker Slides uses: `/ai/text`,
  `/ai/vision`, `/ai/image` on apps-api.coachtonyhockey.com. Setup is ONE
  `wrangler deploy` and NO secret - see the Workers AI rule below; the
  ANTHROPIC_API_KEY / OPENAI_API_KEY line that stood here described the
  proxy that lived in this Worker for a few hours and is long gone. An
  undeployed Worker must surface as a plain-words error with a Setup
  button - never a silent failure or a dead spinner.
- **EVERY ERROR THE WORKER RETURNS CARRIES A `message`.** A 400 answering
  `{error:'bad_image'}` alone reached Tony as a toast reading literally
  "bad_image" (measured live 2026-08-27), because `ai.js` falls back to
  the machine code when there is no sentence. A code is a dead end; say
  what to do instead. The vision path also DOWNSCALES in the browser
  first (`visionDataUrl`, 1600px JPEG), which serves the speed rule and
  puts the size cap out of reach rather than explaining it.
- **ONE RUN LOCK PER CARD, AND EVERY RUN GOES THROUGH IT.** `withRun` in
  app.js owns the AbortController, the disabled Run button, the `is-busy`
  class and the error painting; it hangs on the card as `card.__run` so
  Refine uses the same lock. Refine used to bypass it: Run stayed live, a
  refine could not be stopped, and a failure only toasted - leaving the
  skeleton grid it had already painted spinning forever. Any future way
  to start a run goes through `card.__run`, never straight to `runImage`.
- **NOTHING REBUILDS THE BOARD WHILE A BOT IS RUNNING.** `showBoard()`
  replaces `#app.innerHTML`, which detaches the card a run is painting
  into, so the finished result lands off-page and reads as a lost
  generation - and an image run is 20 to 60 seconds of open window. Hide,
  Show All, Reset Layout and both settings buttons go through
  `rerender()`, which refuses while `.bot-card.is-busy` exists and says
  why. Settings still SAVE mid-run; only the repaint waits.
- **AN INPUT THAT FEEDS NOTHING IS A BUG.** Visual Aid Bot's "Notion Page
  Link" was declared in `inputs` and read by nobody, so pasting a page
  changed the prompt not at all. A field may now carry `reads: 'notion'`:
  the runner fetches that page through the Worker's existing
  `/notion/page/<id>` endpoint before the run and hands `prompt()` a
  `<key>Text` value. A page it cannot read warns and runs on the brief
  alone - never kills a run the brief alone could do. Before adding an
  input, check `prompt()` actually consumes it.
- **THE RUN BUTTON IS ALWAYS CALLED "RUN"** (2026-08-27, Tony's call) -
  for these bots and every future one. Not Generate, not Create.
- Cards carry NO description text: the board packs four or more columns
  across a normal window (`minmax(268px, 1fr)`) and vertical space is
  worth more than a blurb. A bot's `blurb` still exists in the registry
  for the settings sheet.
- STYLE CHIPS ARE TAGS, NOT ACTIONS: small, flat, no shadow, and selected
  with a soft tint of THAT BOT'S OWN COLOUR (`color-mix` on `--bot`), so
  the only strong button on a card is Run and a chip never fights it or
  shows the wrong bot's colour.
- **ONE PAGE** (2026-08-27, Tony's call). A card is not a link to a bot:
  the card IS the bot, holding its own inputs, Run button, results and
  recent runs. There is no second route in this app and no `location.hash`
  handling - do not reintroduce a detail page. Renderers take the CARD as
  their root so two bots can run at once without crossing state, and the
  drag handle is the grip alone (a draggable card steals every caret drag
  inside its own text fields).
- **THE MODELS ARE WORKERS AI**, through the `AI` binding on the same
  Worker (`[ai] binding = "AI"` in wrangler.toml). THERE IS NO API KEY -
  inference bills to the Cloudflare account the Worker already runs on,
  which is also why the bots work with the laptop shut: the work happens
  at the edge, not on the Mac. Setup is one `wrangler deploy`, no secret.
  THREE THINGS THE FIRST LIVE CALLS TAUGHT (2026-08-27, all fixed in
  `present-worker/worker.js` - do not regress them):
  1. A text run's shape varies. `.response` is not always a string, and
     WHEN THE MODEL ANSWERS WITH VALID JSON, WORKERS AI PARSES IT FOR YOU -
     so `response` arrives as an array of objects. `pickText`/`textOut`
     hand a parsed payload back as JSON text for the app's own parser,
     join real content blocks, and fall through an empty candidate to the
     OpenAI-style `choices`. Never call `.trim()` on `.response` directly.
  2. FLUX returns JPEG BYTES, not PNG, and hands them back as
     `{ image: base64 }`. The mime is sniffed from the magic number
     (`sniffB64` / `sniffMime`) and the app takes its file extension from
     the blob type - a hardcoded `.png` writes mislabelled files.
  3. Workers AI runs a safety filter that answers `3030 flagged` on
     innocuous wording. That is surfaced as a 422 with "reword the brief",
     not as a raw model error.
  `{ debug: true }` on `/ai/text` echoes the raw model response - the
  fastest way to see a shape rather than guess at one.
  Speed is the tie-break: images use the four-step FLUX.2 klein models
  (`flux-2-klein-4b` fast, `-9b` on `quality: true`), text uses the fast
  Llama build, vision uses llama-4-scout, and a run's options generate in
  parallel. Do not swap in a slower default model. Anything on Tony's Mac
  (an MCP server, a local agent) CANNOT serve this app - it fails the
  laptop-shut requirement - and a consumer Claude.ai subscription has no
  API to call, so neither is an option however convenient it sounds.

## Diagrams file tree

- A FILE ROW CARRIES NO ICON (2026-08-27, Tony's call); only folders do,
  the way Finder and Obsidian draw a tree. Rows and folder rows share one
  24px rhythm so the column scans, folders sort above loose diagrams, and
  a folder's children indent behind a 1px rail under a rotating caret.
  Density is the point: do not add per-row glyphs, padding or badges.

## Verifying a change

There is no CI test suite. Before opening a PR, reason through: does the
change touch the storage format, the PNG format, or the render pair
(drawEl/svgEl)? If yes, re-read rules 1-3. If you can run a browser, load
the app, create a drill, place a few elements, wait a second for autosave
(the status word goes Unsaved then Saved), reload (the saved work must
survive), and export a PNG. Check the editor at a narrow window too: the
rink stage scrolls vertically only, and a sideways scrollbar anywhere is a
bug (`.ed-stagewrap` is `overflow-x: hidden`, `html, body` are capped).
`sizeStage()` (editor.js) must subtract the wrap's REAL computed padding -
clientWidth includes it, and the old flat "- 40" undercounted by up to
40px, which clipped the rink's right edge once sideways overflow stopped
scrolling. Its 360px floor is capped to availW for the same reason.
