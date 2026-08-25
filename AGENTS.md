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
IndexedDB store are frozen storage terms - do not rename them.

The old address diagrammer.coachtonyhockey.com is a Cloudflare Worker
(`redirect-worker/`, deployed with wrangler, not part of the Pages site):
it 301-redirects everything to the new home and serves `/export`, the
one-time storage-migration bridge the app calls on first load at the new
origin. Its DNS record must stay proxied or the Worker route never runs.

## How to work here

- Plain HTML, CSS, and ES-module JavaScript only. No frameworks, no npm, no
  build tooling, no TypeScript. Keep it that way - zero-build is what lets
  any AI edit this app safely.
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
  are storage formats - additive changes only.
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
