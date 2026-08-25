# AGENTS.md - cth-diagrammer

Operating rules for ANY AI editing this repo (Claude Code, Codex, Notion AI,
GitHub-connected agents). Read this fully before changing anything.

## What this is

CTH Apps - Tony's web app hub, live at https://apps.coachtonyhockey.com/.
The repo root `index.html` is the hub (a launcher page listing every app);
each app lives in its own subfolder and serves at its path. Today there
are three apps: **Diagrams** at `/diagrams/` (the hockey diagram editor),
**Clips** at `/clips/` (video tagging and clipping over Dropbox), and
**Present** at `/present/` (Notion pages as film-session slideshows). Static
site, no build step: GitHub Pages serves the `main` branch as-is. **Merging
to `main` IS the deploy** - the live site updates within about a minute.
The interface says "Diagram"; the `#/drill/` hash and the `drills`
IndexedDB store are frozen storage terms - do not rename them. Diagrams has
a HOME PAGE at `#/` again (2026-08-25, Tony's call, reversing 2026-08-24):
a library landing page like Clips and Present - recent cards, a searchable
folder-grouped list, Import, Back Up and + New Diagram. The editor keeps
the sidebar file tree (folders, drag and drop, right-click menu); the
editor's Back button goes to the home page, and the home page's Back goes
to the hub. There is NO canvas zoom, on purpose - the stage sizes itself
to the window. Folders show a folder glyph (`.fic`) in the tree and on the
home page, matching the Clips tree.
Diagram "Link" buttons upload a PNG to Dropbox at a stable overwrite path
(/apps/diagrams/<id>-*.png via ../clips/js/dropbox.js) so a link pasted in
Notion updates in place on every re-copy.

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
- File map is in README.md. Styling lives in `css/app.css` on the CTH
  greyscale system (ink `#1a1a1a` on white, hairline `#e3e3e3` borders,
  no color accents, no emojis, no em dashes in UI copy). Do not invent new
  colors. The four toolbar presets default to black / blue `#75d8ff` /
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
6. **Saving is manual and must stay that way** (Tony's call 2026-08-24).
   An edit calls `markDirty()`; nothing writes to IndexedDB until Tony presses
   Save, hits Cmd+S, or answers the leave prompt. Do not reintroduce an
   autosave timer. Two guards make that safe and must not be removed: the
   hashchange prompt and the `beforeunload` handler, both in `js/app.js`.
7. **Never cache a dead IndexedDB connection.** `js/store.js` drops its cached
   handle on `close`/`versionchange` and retries once on a closing-connection
   error. Without that, one closed connection makes every later save fail with
   `InvalidStateError: The database connection is closing.` - which is exactly
   the bug that made manual save necessary in the first place.

## Clips (/clips/) rules

- Clips reads game film from the user's Dropbox `/videos` folder and writes
  exports to `/videos/exports`, straight from the browser via OAuth PKCE
  (`clips/js/dropbox.js`). There is no server. The Dropbox app key is a
  public identifier; tokens live only in the user's localStorage.
- Marks (clips, tags, freezes) AUTOSAVE to the `cth-clips` IndexedDB - a
  coach tagging at game speed cannot stop for a Save button. Do not copy
  the Diagrams manual-save rule here; they are different by design.
- The game record shape `{ id, name, path, source, duration, clips,
  freezes }` and the clip shape `{ id, label, color, in, out, tags, note }`
  are storage formats - additive changes only. `videoTags` (2026-08-25) is
  an optional array of strings on the game record: the VIDEO's own tags,
  shown and edited in the library file tree, distinct from a clip's `tags`.
  Settings gained optional `logH` (the clip log's height in px) and
  `sideW` (the tag panel's width in px).
- **The library file tree is full-width and tag-aware** (2026-08-25). Video
  rows carry their `videoTags` as chips with a write-in box (Enter adds,
  the chip's x removes, clicking a chip searches it); the search bar above
  the tree has a scope select (Tags + Clips / Tags Only / Clips Only) that
  matches file names, video tags, and the clips inside each game record,
  plus a "Matches Elsewhere In Your Library" section for tagged games
  outside the open folder (records only - it never walks Dropbox
  recursively). New Folder creates a real Dropbox folder via
  `files/create_folder_v2`. Exporting a clip also writes a library record
  for the exported file carrying the clip's label and tags, so exports
  arrive in the tree already tagged.
- **The player layout** (2026-08-25): tag buttons live in a slim vertical
  side panel on the right (a horizontal strip below 900px); the clip log
  sits full-width UNDER the video, split from it by a drag bar (height
  persists in `settings.logH`, double-click resets); the header Clips
  button hides the log entirely for a full-height picture. Log rows are one
  line with tag chips and a write-in tag box per clip.
- **Upload lives on the library header** (2026-08-25, Tony's ask): a sheet
  uploads a picked video into the folder open in the tree, either Original
  (as-is) or Compressed. Compression is the CTH Compressor's recipe done
  with browser parts (canvas + MediaRecorder at 1080p ~4 Mbps or 720p
  ~2.5 Mbps, audio kept via a silent WebAudio route), so it plays the clip
  through once in REAL TIME - right for clips, wrong for whole games; the
  Mac droplet stays the tool for those. Uploads go through
  `dbxUploadProgress` (XHR for real progress; upload sessions chunk
  anything past 24MB, so big film works), always `autorename` - an upload
  must never overwrite film already there.
- **Scrubbing is batched, never per-event, and CALIBRATED TO QUICKTIME**
  (2026-08-25). A gesture accumulates into a target; at most one seek is in
  flight, one precise seek settles on gesture end, and the playhead and
  clock read the TARGET while a gesture runs. Steps under 1.5s seek
  PRECISELY (fastSeek would snap them to keyframes, which reads as sticking
  then teleporting on sparse-keyframe game film); bigger jumps take the
  cheap keyframe landing and the settle seek finishes them.
  **The rate is a FIXED 0.005 s/px, NOT duration-proportional.** The first
  cut scaled it to duration and ran 7-50 s of video per second of swiping
  on a 30-minute file; measured frame-by-frame off Tony's own screen
  recordings of QuickTime scrubbing the same file, QuickTime moves 2-4 s
  per second of swiping and barely accelerates. So: 0.005 s/px, a weak 1.4x
  flick multiplier that only starts past 20px per event, Shift 8x finer.
  Crossing a long file is the TIMELINE's job, not the swipe's.
  **Swiping right moves forward**: macOS natural scrolling reports that as
  negative deltaX, so the delta is negated (`scrubReverse` flips it back).
  A gesture is claimed once and kept so vertical finger drift cannot
  stutter it. The timeline drag rides the same pipe. Do not go back to
  seeking per wheel or pointer event, and do not reintroduce
  duration-scaling.
- **The timeline is SLIM and carries its own timecodes** (2026-08-25,
  mChapters as the reference): a 30px canvas where the clip lane is the
  scrub bar, freeze marks tuck under it, and the current/total codes sit on
  its ends instead of on a row of their own. With the tightened transport
  row that returned ~76px of height to the picture.
- **The tag panel resizes, collapses, and reorders** (2026-08-25): its own
  vertical drag handle (width persists in `settings.sideW`, double-click
  resets, 96px minimum where a container query switches the buttons to a
  compact drawing), a header Tags button to collapse it, and drag-to-
  reorder within a tier. Buttons wear their assigned colour as a 12%
  `color-mix` wash. The panel editor has preset swatches (light grey
  included, and it is the DEFAULT for a new button), a colour well for
  anything else, Copy to duplicate a button (never its hotkey), dividers,
  and drag-to-reorder. A divider is `{id, tier, divider: true}` in the same
  `panel.buttons` array - anything reading that array must skip dividers
  (`panelButtons` does; `panelItems` keeps them for rendering).
- Freeze-frame drawings use the DIAGRAMS element model and renderer
  (`/diagrams/js/flat.js` is imported cross-app); keep that import working.
- `clips/embed.html` is the Notion-embeddable single-clip player; its hash
  parameters (v, in, out, t) are a public URL format - never break them.
- IndexedDB helpers in both apps' store.js: a `get` on a missing key must
  return undefined, never the raw IDBRequest (that bug shipped once).

## Present (/present/) rules

- Present renders a LIVE Notion page as slides through the Worker in
  `present-worker/` (cth-present-api on apps-api.coachtonyhockey.com,
  deployed with wrangler; secret NOTION_TOKEN). Notion has no browser CORS,
  so the Worker is required; it exposes ONLY /notion/page/<32-hex id>, no
  search or listing, CORS locked to the CTH Apps origins. Content is always
  current - never add a publish step, webhook, or content cache beyond the
  Worker's 60-second edge cache.
- The slide grammar is a contract with how Tony writes pages: page title =
  dark cover slide, every heading_2 starts a slide, every divider cuts a
  slide (keeping the current header), heading_1 makes a dark section slide.
- Presentation links come from a Notion FORMULA property (name: Presentation):
  `"https://apps.coachtonyhockey.com/present/#p=" + id()` - the app also
  accepts any pasted Notion URL. The #p=<id>&s=<n> hash format is public.
- Clips embed URLs, Dropbox links, uploaded video files and external video
  URLs all render as the scrubbable in-slide player (media.js); telestration
  reuses /diagrams/js/flat.js. Screen recording and the Dropbox upload of
  recordings reuse ../clips/js/dropbox.js (same origin, same tokens).

## Verifying a change

There is no CI test suite. Before opening a PR, reason through: does the
change touch the storage format, the PNG format, or the render pair
(drawEl/svgEl)? If yes, re-read rules 1-3. If you can run a browser, load
the app, create a drill, place a few elements, press Save, reload (the
saved work must survive), and export a PNG.
