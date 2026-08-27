// CTH Bots storage. One IndexedDB, `cth-bots`, three stores:
//   configs  one record per bot id: its settings, instruction and colour
//   board    one record, key 'layout': card order and per-card size
//   runs     output history, newest first, capped
//
// Storage shapes are ADDITIVE-ONLY, like every other CTH app: never rename
// or remove a field, and read old records with a fallback.

const DB = 'cth-bots';
const VER = 1;
let dbP = null;

function open() {
  if (dbP) return dbP;
  dbP = new Promise((res, rej) => {
    const r = indexedDB.open(DB, VER);
    r.onupgradeneeded = () => {
      const d = r.result;
      if (!d.objectStoreNames.contains('configs')) d.createObjectStore('configs');
      if (!d.objectStoreNames.contains('board')) d.createObjectStore('board');
      if (!d.objectStoreNames.contains('runs')) d.createObjectStore('runs', { keyPath: 'id' });
    };
    r.onsuccess = () => {
      const d = r.result;
      // Never cache a dead connection (the rule Diagrams learned the hard way).
      d.onclose = () => { dbP = null; };
      d.onversionchange = () => { try { d.close(); } catch (_) {} dbP = null; };
      res(d);
    };
    r.onerror = () => { dbP = null; rej(r.error); };
  });
  return dbP;
}

async function tx(store, mode, fn) {
  let d;
  try { d = await open(); } catch (e) { dbP = null; throw e; }
  try {
    return await new Promise((res, rej) => {
      const t = d.transaction(store, mode);
      const s = t.objectStore(store);
      let out;
      const rq = fn(s);
      if (rq) rq.onsuccess = () => { out = rq.result; };
      t.oncomplete = () => res(out);
      t.onerror = () => rej(t.error);
      t.onabort = () => rej(t.error);
    });
  } catch (e) {
    if (/clos/i.test(e?.message || '')) { dbP = null; return tx(store, mode, fn); }
    throw e;
  }
}

// A get on a missing key returns undefined, never the raw request.
export const getConfig = (id) => tx('configs', 'readonly', (s) => s.get(id)).then((v) => (v === undefined ? undefined : v));
export const putConfig = (id, cfg) => tx('configs', 'readwrite', (s) => s.put(cfg, id));
export const getLayout = () => tx('board', 'readonly', (s) => s.get('layout')).then((v) => (v === undefined ? undefined : v));
export const putLayout = (l) => tx('board', 'readwrite', (s) => s.put(l, 'layout'));

const RUN_CAP = 60;
export async function addRun(run) {
  await tx('runs', 'readwrite', (s) => s.put(run));
  const all = await listRuns();
  for (const old of all.slice(RUN_CAP)) await tx('runs', 'readwrite', (s) => s.delete(old.id));
}
export const listRuns = () => tx('runs', 'readonly', (s) => s.getAll())
  .then((v) => (v || []).sort((a, b) => (b.at || 0) - (a.at || 0)));
export const deleteRun = (id) => tx('runs', 'readwrite', (s) => s.delete(id));

export const uid = () => Math.random().toString(36).slice(2, 10) + Date.now().toString(36).slice(-4);
