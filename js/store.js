// Drill storage - IndexedDB, so saved drills survive restarts and can hold
// image-backed drills without hitting localStorage's 5MB wall.
//
// A drill record:
//   { id, name, notes, created, updated, thumb,           // card metadata
//     state: { v:1, w, h, bg, seq, elements } }           // cthDiagram state
// bg is null for standard rink layouts (rebuilt from assets/rink.png) and a
// dataUrl for custom/cropped backgrounds - same convention as Film Room.

const DB_NAME = 'cth-diagrammer';
const STORE = 'drills';

let dbPromise = null;

function db() {
  if (!dbPromise) {
    dbPromise = new Promise((res, rej) => {
      const req = indexedDB.open(DB_NAME, 1);
      req.onupgradeneeded = () => {
        req.result.createObjectStore(STORE, { keyPath: 'id' });
      };
      req.onsuccess = () => res(req.result);
      req.onerror = () => rej(req.error);
    });
  }
  return dbPromise;
}

function tx(mode, fn) {
  return db().then((d) => new Promise((res, rej) => {
    const t = d.transaction(STORE, mode);
    const out = fn(t.objectStore(STORE));
    t.oncomplete = () => res(out.result !== undefined ? out.result : out);
    t.onerror = () => rej(t.error);
  }));
}

export const uid = () => Date.now().toString(36) + Math.random().toString(36).slice(2, 8);

export async function listDrills() {
  const all = await tx('readonly', (s) => s.getAll());
  all.sort((a, b) => (b.updated || 0) - (a.updated || 0));
  return all;
}

export async function getDrill(id) {
  return tx('readonly', (s) => s.get(id));
}

export async function putDrill(drill) {
  drill.updated = Date.now();
  await tx('readwrite', (s) => s.put(drill));
  return drill;
}

export async function deleteDrill(id) {
  await tx('readwrite', (s) => s.delete(id));
}

export async function exportAll() {
  const drills = await listDrills();
  // Thumbs are derivable - drop them from the backup to keep it small.
  return { app: 'cth-diagrammer', v: 1, exported: new Date().toISOString(), drills: drills.map(({ thumb, ...d }) => d) };
}

export async function importAll(payload, { replaceIds = false } = {}) {
  if (!payload || !Array.isArray(payload.drills)) throw new Error('Not a CTH Diagrammer backup file');
  let n = 0;
  for (const d of payload.drills) {
    if (!d.state || !Array.isArray(d.state.elements)) continue;
    const drill = { ...d };
    if (!replaceIds || !drill.id) drill.id = uid();
    drill.updated = Date.now();
    await tx('readwrite', (s) => s.put(drill));
    n++;
  }
  return n;
}
