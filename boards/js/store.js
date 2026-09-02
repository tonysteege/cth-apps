// CTH Decks storage - IndexedDB `cth-decks`, additive-only like every CTH
// store. `decks` holds the deck records; `assets` holds media Blobs keyed
// by id, never base64 on the record, so autosave can rewrite a deck on
// every nudge (the Slides authored-deck rule).

const DB = 'cth-decks';
const VER = 1;
let dbP = null;

function open() {
  if (dbP) return dbP;
  dbP = new Promise((res, rej) => {
    const r = indexedDB.open(DB, VER);
    r.onupgradeneeded = () => {
      const d = r.result;
      if (!d.objectStoreNames.contains('decks')) d.createObjectStore('decks', { keyPath: 'id' });
      if (!d.objectStoreNames.contains('assets')) d.createObjectStore('assets');
    };
    r.onsuccess = () => {
      const d = r.result;
      // Never cache a dead connection - the rule Diagrams learned the hard
      // way and every CTH store follows.
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

export const uid = () => Math.random().toString(36).slice(2, 10) + Date.now().toString(36).slice(-4);

export const listDecks = () => tx('decks', 'readonly', (s) => s.getAll()).then((v) => (v || []).sort((a, b) => (b.updated || 0) - (a.updated || 0)));
export const getDeck = (id) => tx('decks', 'readonly', (s) => s.get(id)).then((v) => (v === undefined ? undefined : v));
export const putDeck = (d) => tx('decks', 'readwrite', (s) => s.put(d)).then(() => d);
export const deleteDeck = (id) => tx('decks', 'readwrite', (s) => s.delete(id));

export const putAsset = (id, blob) => tx('assets', 'readwrite', (s) => s.put(blob, id));
export const getAsset = (id) => tx('assets', 'readonly', (s) => s.get(id)).then((v) => (v === undefined ? undefined : v));
export const deleteAsset = (id) => tx('assets', 'readwrite', (s) => s.delete(id));

// Object URLs die with the page: rebuild them for every asset-backed
// element before anything renders (the Slides rehydrate rule).
const urls = new Map();
export async function assetUrl(id) {
  if (!id) return '';
  if (urls.has(id)) return urls.get(id);
  const blob = await getAsset(id);
  if (!blob) return '';
  const u = URL.createObjectURL(blob);
  urls.set(id, u);
  return u;
}

// Read-only peek into the Diagrams library (cth-diagrammer/drills) so a
// slide can carry a live rink diagram. Never written from here.
export function listDrills() {
  return new Promise((res) => {
    const r = indexedDB.open('cth-diagrammer');
    r.onupgradeneeded = () => { try { r.transaction.abort(); } catch (_) {} res([]); };
    r.onsuccess = () => {
      const d = r.result;
      if (!d.objectStoreNames.contains('drills')) { d.close(); res([]); return; }
      const t = d.transaction('drills', 'readonly');
      const rq = t.objectStore('drills').getAll();
      rq.onsuccess = () => { d.close(); res((rq.result || []).sort((a, b) => (b.updated || 0) - (a.updated || 0))); };
      rq.onerror = () => { d.close(); res([]); };
    };
    r.onerror = () => res([]);
  });
}

export function getDrill(id) {
  return new Promise((res) => {
    const r = indexedDB.open('cth-diagrammer');
    r.onsuccess = () => {
      const d = r.result;
      if (!d.objectStoreNames.contains('drills')) { d.close(); res(undefined); return; }
      const rq = d.transaction('drills', 'readonly').objectStore('drills').get(id);
      rq.onsuccess = () => { d.close(); res(rq.result); };
      rq.onerror = () => { d.close(); res(undefined); };
    };
    r.onerror = () => res(undefined);
  });
}
