// PROJECT STORAGE - IndexedDB, in this browser, no account.
//
// A project is small: a pointer at a Dropbox path plus some marks and ops. The
// FILM is never stored here, only the path, so a library of two hundred videos
// is a few megabytes and a browser will never evict it for size.
//
// THE PROJECT SHAPE IS A STORAGE FORMAT - additive changes only, the same rule
// Diagrams and Clips live under. A field may be added with a fallback; a field
// may never be renamed or removed, because a project made today has to open in
// a year.
//
//   { id, name, created, updated, thumb,
//     source: { kind:'dropbox'|'folder'|'url'|'local', path, url, name, w, h, duration },
//     format: { aspect },
//     timeline: { in, out, ops[] },
//     camera: [{ t, cx, cy, zoom }],
//     marks: [ ... see marks.js ... ],
//     brand: { title, subtitle, corner, titleDur, on },
//     grade, publish: { league, season, teamA, teamB, tag, hook } }
//
// NEVER CACHE A DEAD CONNECTION. Clips learned this the expensive way: one
// closed connection made every later save fail with "The database connection is
// closing." The cached handle is dropped on `close` and `versionchange`, and a
// closing-connection error is retried once.

const DB = 'cth-studio';
const VER = 1;
const STORE = 'projects';

let cached = null;

function open() {
  if (cached) return Promise.resolve(cached);
  return new Promise((resolve, reject) => {
    const req = indexedDB.open(DB, VER);
    req.onupgradeneeded = () => {
      const db = req.result;
      if (!db.objectStoreNames.contains(STORE)) {
        const s = db.createObjectStore(STORE, { keyPath: 'id' });
        s.createIndex('updated', 'updated');
      }
    };
    req.onsuccess = () => {
      const db = req.result;
      db.onclose = () => { if (cached === db) cached = null; };
      db.onversionchange = () => { try { db.close(); } finally { if (cached === db) cached = null; } };
      cached = db;
      resolve(db);
    };
    req.onerror = () => reject(req.error);
  });
}

async function tx(mode, fn) {
  const run = async () => {
    const db = await open();
    return new Promise((resolve, reject) => {
      const t = db.transaction(STORE, mode);
      const store = t.objectStore(STORE);
      let result;
      try { result = fn(store); } catch (e) { reject(e); return; }
      t.oncomplete = () => resolve(result && result.__req ? result.__req.result : result);
      t.onerror = () => reject(t.error);
      t.onabort = () => reject(t.error);
    });
  };
  try {
    return await run();
  } catch (e) {
    if (/closing|InvalidStateError/i.test(String(e && e.name) + String(e && e.message))) {
      cached = null;
      return run();
    }
    throw e;
  }
}

const wrap = (req) => ({ __req: req });

export function blankProject(patch = {}) {
  const now = Date.now();
  return {
    id: `p${now.toString(36)}${Math.random().toString(36).slice(2, 7)}`,
    name: 'Untitled clip',
    created: now,
    updated: now,
    thumb: null,
    source: null,
    format: { aspect: '16:9' },
    timeline: { in: 0, out: null, ops: [] },
    camera: [],
    marks: [],
    brand: { title: '', subtitle: '', corner: 'coachtonyhockey.com', titleDur: 2.2, on: true },
    grade: 0,
    publish: { league: '', season: '', teamA: '', teamB: '', tag: '', hook: 'We caught it ...' },
    ...patch,
  };
}

export async function put(project) {
  const p = { ...project, updated: Date.now() };
  await tx('readwrite', (s) => s.put(p));
  return p;
}

export async function get(id) { return tx('readonly', (s) => wrap(s.get(id))); }

export async function all() {
  const list = await tx('readonly', (s) => wrap(s.getAll()));
  return (list || []).sort((a, b) => b.updated - a.updated);
}

export async function remove(id) { return tx('readwrite', (s) => s.delete(id)); }

export async function duplicate(id) {
  const p = await get(id);
  if (!p) return null;
  const copy = { ...structuredClone(p), id: blankProject().id, name: `${p.name} copy`, created: Date.now() };
  return put(copy);
}

// ---- backup ----------------------------------------------------------------

// One file, every project. A browser's IndexedDB is not a backup - clearing
// site data takes the lot - so this is the only thing standing between a bad
// afternoon and starting over.
export async function exportAll() {
  const list = await all();
  return new Blob([JSON.stringify({ app: 'cth-studio', v: 1, exported: Date.now(), projects: list }, null, 2)],
    { type: 'application/json' });
}

export async function importAll(file, { replace = false } = {}) {
  const text = await file.text();
  const data = JSON.parse(text);
  if (!data || data.app !== 'cth-studio' || !Array.isArray(data.projects)) {
    throw new Error('That is not a Studio backup file.');
  }
  const existing = new Set((await all()).map((p) => p.id));
  let added = 0;
  for (const p of data.projects) {
    if (!p || !p.id) continue;
    if (existing.has(p.id) && !replace) {
      // Never silently overwrite work: an id clash lands as a new project.
      await put({ ...p, id: blankProject().id, name: `${p.name} (imported)` });
    } else {
      await put(p);
    }
    added++;
  }
  return added;
}

// ---- settings --------------------------------------------------------------

const SET = 'cths.settings.v1';
const DEFAULTS = {
  scrubSensitivity: 1,
  scrubReverse: false,
  fps: 30,
  quality: 'hd',
  audio: true,
  saveTo: 'dropbox',      // 'dropbox' | 'download'
  filmSource: 'folder',   // 'folder' | 'dropbox' - which browser the library shows
  namePattern: '{hook} - {league} {season} - {teamA} - {teamB} - {tag}',
  defaultColor: 'red',
  holdDur: 1.6,
  slowRate: 0.35,
  shortcuts: {},
};

export function settings() {
  try { return { ...DEFAULTS, ...JSON.parse(localStorage.getItem(SET) || '{}') }; }
  catch (_) { return { ...DEFAULTS }; }
}
export function saveSettings(patch) {
  const next = { ...settings(), ...patch };
  localStorage.setItem(SET, JSON.stringify(next));
  return next;
}
export { DEFAULTS as SETTING_DEFAULTS };
