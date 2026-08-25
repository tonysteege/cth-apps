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

// THE CONNECTION CAN DIE UNDER US. A browser closes an IndexedDB connection
// on its own: it reclaims one in a backgrounded tab, another tab opening the
// database at a new version fires `versionchange`, and the page starting to
// unload closes it too. Once that has happened every transaction on that
// handle throws `InvalidStateError: The database connection is closing.`
//
// The handle used to be cached forever, so ONE closed connection poisoned
// every later save for the whole session - which is exactly what the
// "Could Not Save" toast was. Retrying could not help, because the retry
// reused the same dead handle. So: drop the cache the moment a connection
// closes, and reopen on the next call.
function forget(p) {
  if (dbPromise === p) dbPromise = null;
}

function openDb() {
  const p = new Promise((res, rej) => {
    const req = indexedDB.open(DB_NAME, 1);
    req.onupgradeneeded = () => {
      req.result.createObjectStore(STORE, { keyPath: 'id' });
    };
    req.onsuccess = () => {
      const d = req.result;
      d.onclose = () => forget(p);
      d.onversionchange = () => {
        try { d.close(); } catch (_) { /* already gone */ }
        forget(p);
      };
      res(d);
    };
    req.onerror = () => { forget(p); rej(req.error); };
  });
  return p;
}

function db() {
  if (!dbPromise) dbPromise = openDb();
  return dbPromise;
}

// A dead-connection failure, as opposed to a real data error. Only these are
// worth reopening for; anything else is a genuine problem and must surface.
const isClosing = (e) => !!e && (
  e.name === 'InvalidStateError'
  || e.name === 'TransactionInactiveError'
  || /connection is clos/i.test(e.message || '')
);

function runTx(mode, fn) {
  return db().then((d) => new Promise((res, rej) => {
    // `d.transaction()` THROWS synchronously on a closing connection rather
    // than rejecting, so the whole body has to sit inside try/catch.
    try {
      const t = d.transaction(STORE, mode);
      const out = fn(t.objectStore(STORE));
      t.oncomplete = () => res(out && typeof out === 'object' && 'result' in out ? out.result : out);
      t.onerror = () => rej(t.error);
      t.onabort = () => rej(t.error || new DOMException('Transaction aborted', 'AbortError'));
    } catch (e) {
      rej(e);
    }
  }));
}

async function tx(mode, fn) {
  try {
    return await runTx(mode, fn);
  } catch (e) {
    if (!isClosing(e)) throw e;
    dbPromise = null;
    return runTx(mode, fn);
  }
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
