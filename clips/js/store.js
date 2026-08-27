// Clips storage - IndexedDB, one record per video ("game") keyed by its
// Dropbox path (or a local-file fingerprint), holding that video's clips,
// tags, and freeze-frames. Settings (tag panel, email groups, defaults) are
// one record in their own store.
//
// Same dead-connection rule the diagrammer learned the hard way: never cache
// a closed IndexedDB handle - drop it on close/versionchange and retry once
// on a closing-connection error.

const DB_NAME = 'cth-clips';
const GAMES = 'games';
const SETTINGS = 'settings';

let dbPromise = null;
const forget = (p) => { if (dbPromise === p) dbPromise = null; };

function openDb() {
  const p = new Promise((res, rej) => {
    const req = indexedDB.open(DB_NAME, 1);
    req.onupgradeneeded = () => {
      req.result.createObjectStore(GAMES, { keyPath: 'id' });
      req.result.createObjectStore(SETTINGS, { keyPath: 'id' });
    };
    req.onsuccess = () => {
      const d = req.result;
      d.onclose = () => forget(p);
      d.onversionchange = () => { try { d.close(); } catch (_) { /* gone */ } forget(p); };
      res(d);
    };
    req.onerror = () => { forget(p); rej(req.error); };
  });
  return p;
}
const db = () => { if (!dbPromise) dbPromise = openDb(); return dbPromise; };

const isClosing = (e) => !!e && (e.name === 'InvalidStateError' || e.name === 'TransactionInactiveError' || /connection is clos/i.test(e.message || ''));

function runTx(store, mode, fn) {
  return db().then((d) => new Promise((res, rej) => {
    try {
      const t = d.transaction(store, mode);
      const out = fn(t.objectStore(store));
      t.oncomplete = () => res(out && typeof out === 'object' && 'result' in out ? out.result : out);
      t.onerror = () => rej(t.error);
      t.onabort = () => rej(t.error || new DOMException('Transaction aborted', 'AbortError'));
    } catch (e) { rej(e); }
  }));
}
async function tx(store, mode, fn) {
  try {
    return await runTx(store, mode, fn);
  } catch (e) {
    if (!isClosing(e)) throw e;
    dbPromise = null;
    return runTx(store, mode, fn);
  }
}

export const uid = () => Date.now().toString(36) + Math.random().toString(36).slice(2, 8);

// ------------------------------------------------------------- games

export async function listGames() {
  const all = await tx(GAMES, 'readonly', (s) => s.getAll());
  all.sort((a, b) => (b.updated || 0) - (a.updated || 0));
  return all;
}
export const getGame = (id) => tx(GAMES, 'readonly', (s) => s.get(id));
export async function putGame(game) {
  game.updated = Date.now();
  await tx(GAMES, 'readwrite', (s) => s.put(game));
  return game;
}
export const deleteGame = (id) => tx(GAMES, 'readwrite', (s) => s.delete(id));

// ------------------------------------------------------------- settings

// The default tag panel: Tier 1 buttons make a clip at the playhead (lead
// seconds before, lag after - the Film Room model); Tier 2 buttons toggle a
// #tag on the selected clip. Everything is editable in the panel editor.
//
// A button carrying `act` RUNS SOMETHING instead of toggling a tag. Players
// is the only one today. It became a real panel button on 2026-08-27
// (Tony's call) so its place in the column, its key and its colour are
// controlled by the same drag, the same key field and the same colour
// popover as every other button, rather than by a hard-coded splice.
// Anything reading tags must skip `act` buttons: "Players" is a thing you
// press, never a tag a clip can carry.
export const playersButton = () => ({
  id: uid(), tier: 2, act: 'players', label: 'Players', key: 'p', color: '#f97316',
});

export const DEFAULT_PANEL = () => ({
  buttons: [
    { id: uid(), tier: 1, label: 'Goal', key: 'g', color: '#16a34a', lead: 10, lag: 4 },
    { id: uid(), tier: 1, label: 'Shot', key: 's', color: '#3b82f6', lead: 6, lag: 3 },
    { id: uid(), tier: 1, label: 'Chance', key: 'c', color: '#0ea5e9', lead: 8, lag: 3 },
    { id: uid(), tier: 1, label: 'Turnover', key: 't', color: '#dc2626', lead: 6, lag: 3 },
    { id: uid(), tier: 1, label: 'Breakout', key: 'b', color: '#7c3aed', lead: 5, lag: 6 },
    { id: uid(), tier: 1, label: 'Forecheck', key: 'r', color: '#f97316', lead: 5, lag: 5 },
    { id: uid(), tier: 1, label: 'Faceoff', key: 'w', color: '#64748b', lead: 2, lag: 6 },
    { id: uid(), tier: 1, label: 'Highlight', key: 'h', color: '#eab308', lead: 8, lag: 5 },
    { id: uid(), tier: 2, label: 'good', key: 'u', color: '#16a34a' },
    { id: uid(), tier: 2, label: 'bad', key: 'd', color: '#dc2626', },
    { id: uid(), tier: 2, label: 'star', key: 'x', color: '#eab308' },
    playersButton(),
    { id: uid(), tier: 2, label: 'ozone', key: '', color: '#0ea5e9' },
    { id: uid(), tier: 2, label: 'dzone', key: '', color: '#6366f1' },
    { id: uid(), tier: 2, label: 'special-teams', key: '', color: '#d946ef' },
  ],
});

// Everything below `panel` was added on 2026-08-27 for the Clips rebuild.
// Storage is ADDITIVE-ONLY: getSettings merges these over whatever is
// saved, so an older record simply grows the new fields.
//
//   players     the roster the Players dialogue lists, each with a
//               single-key shortcut: { id, num, first, last, key }
//   naming      the export file-name pattern. Tokens: {name} {tags}
//               {hhmmss} {label} {date}
//   freezeBuf   the in/out buffer around the playhead a Freeze export
//               carries, in seconds. pullBuf is the same for Pull.
//   holdSec     how long the frozen frame is held in a Freeze export
//   cursorHi    the recording's cursor highlight
//   toolKeys    one-key shortcuts for the annotation tools, editable
//               from a right-click on the tool itself
//   recordArea  the last capture rectangle, remembered across sessions
const DEFAULT_SETTINGS = () => ({
  id: 'main',
  panel: DEFAULT_PANEL(),
  groups: { Team: '', Parents: '' },   // name -> comma-separated emails
  scrubReverse: false,
  players: [],
  naming: '{name}-{tags}-{hhmmss}',
  freezeBuf: { before: 5, after: 10 },
  pullBuf: { before: 5, after: 10 },
  holdSec: 3,
  cursorHi: { on: true, color: '#ef4444', size: 46, opacity: 0.32 },
  toolKeys: { select: 'v', pen: 'd', arrow: 'a', box: 'b', circle: 'c', text: 't', angle: 'g' },
  recordArea: null,
});

// A panel saved before Players became a real button gets one inserted where
// the hard-coded version used to draw it: directly under the last rating.
// It is added, never moved, so a panel that already has one - anywhere the
// user dragged it to - is returned untouched. Additive-only, like every
// other field here.
function withPlayers(panel) {
  const list = panel?.buttons;
  if (!Array.isArray(list) || list.some((b) => b.act === 'players')) return panel;
  const ratings = new Set(['good', 'bad', 'star']);
  let cut = -1;
  list.forEach((b, n) => { if (b.tier === 2 && !b.divider && ratings.has(String(b.label).toLowerCase())) cut = n; });
  // No ratings left in the panel: sit at the top of the tag tier instead, so
  // the button always lands somewhere visible rather than being appended
  // past a scroll of situation tags.
  if (cut < 0) cut = list.findIndex((b) => b.tier === 2) - 1;
  const out = [...list];
  out.splice(cut + 1, 0, playersButton());
  return { ...panel, buttons: out };
}

export async function getSettings() {
  const s = await tx(SETTINGS, 'readonly', (st) => st.get('main'));
  if (s) {
    // Older records grow new fields without losing anything.
    const d = DEFAULT_SETTINGS();
    return {
      ...d,
      ...s,
      panel: withPlayers(s.panel) || d.panel,
      groups: { ...d.groups, ...(s.groups || {}) },
      players: s.players || d.players,
      freezeBuf: { ...d.freezeBuf, ...(s.freezeBuf || {}) },
      pullBuf: { ...d.pullBuf, ...(s.pullBuf || {}) },
      cursorHi: { ...d.cursorHi, ...(s.cursorHi || {}) },
      toolKeys: { ...d.toolKeys, ...(s.toolKeys || {}) },
    };
  }
  return DEFAULT_SETTINGS();
}
export async function putSettings(s) {
  s.id = 'main';
  await tx(SETTINGS, 'readwrite', (st) => st.put(s));
  return s;
}
