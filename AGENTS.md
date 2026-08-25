# AGENTS.md - cth-diagrammer

Operating rules for ANY AI editing this repo (Claude Code, Codex, Notion AI,
GitHub-connected agents). Read this fully before changing anything.

## What this is

CTH Diagrammer, Tony's hockey diagram design web app, live at
https://diagrammer.coachtonyhockey.com/ (GitHub Pages custom domain; also
https://tonysteege.github.io/cth-diagrammer/). Static site, no build step:
GitHub Pages serves the `main` branch as-is. **Merging to `main` IS the
deploy** - the live app updates within about a minute. The interface says
"Diagram"; the `#/drill/` hash and the `drills` IndexedDB store are frozen
storage terms - do not rename them.

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

## Verifying a change

There is no CI test suite. Before opening a PR, reason through: does the
change touch the storage format, the PNG format, or the render pair
(drawEl/svgEl)? If yes, re-read rules 1-3. If you can run a browser, load
the app, create a drill, place a few elements, press Save, reload (the
saved work must survive), and export a PNG.
