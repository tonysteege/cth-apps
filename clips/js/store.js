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
export const DEFAULT_PANEL = () => ({
  buttons: [
    { id: uid(), tier: 1, label: 'Goal', key: 'g', color: '#16a34a', lead: 10, lag: 4 },
    { id: uid(), tier: 1, label: 'Shot', key: 's', color: '#3b82f6', lead: 6, lag: 3 },
    { id: uid(), tier: 1, label: 'Chance', key: 'c', color: '#0ea5e9', lead: 8, lag: 3 },
    { id: uid(), tier: 1, label: 'Turnover', key: 't', color: '#dc2626', lead: 6, lag: 3 },
    { id: uid(), tier: 1, label: 'Breakout', key: 'b', color: '#7c3aed', lead: 5, lag: 6 },
    { id: uid(), tier: 1, label: 'Forecheck', key: 'r', color: '#f97316', lead: 5, lag: 5 },
    { id: uid(), tier: 1, label: 'Faceoff', key: 'w', color: '#78716c', lead: 2, lag: 6 },
    { id: uid(), tier: 1, label: 'Highlight', key: 'h', color: '#eab308', lead: 8, lag: 5 },
    { id: uid(), tier: 2, label: 'good', key: 'u', color: '#16a34a' },
    { id: uid(), tier: 2, label: 'bad', key: 'd', color: '#dc2626', },
    { id: uid(), tier: 2, label: 'star', key: 'x', color: '#eab308' },
    { id: uid(), tier: 2, label: 'ozone', key: '', color: '#0ea5e9' },
    { id: uid(), tier: 2, label: 'dzone', key: '', color: '#6366f1' },
    { id: uid(), tier: 2, label: 'special-teams', key: '', color: '#d946ef' },
  ],
});

const DEFAULT_SETTINGS = () => ({
  id: 'main',
  panel: DEFAULT_PANEL(),
  groups: { Team: '', Parents: '' },   // name -> comma-separated emails
  scrubReverse: false,
});

export async function getSettings() {
  const s = await tx(SETTINGS, 'readonly', (st) => st.get('main'));
  if (s) {
    // Older records grow new fields without losing anything.
    const d = DEFAULT_SETTINGS();
    return { ...d, ...s, panel: s.panel || d.panel, groups: { ...d.groups, ...(s.groups || {}) } };
  }
  return DEFAULT_SETTINGS();
}
export async function putSettings(s) {
  s.id = 'main';
  await tx(SETTINGS, 'readwrite', (st) => st.put(s));
  return s;
}
