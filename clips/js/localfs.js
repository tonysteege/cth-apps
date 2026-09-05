// CTH Local Files - the file backend for every CTH app (2026-08-26,
// Tony's call, replacing Dropbox).
//
// Tony picks his `cth` folder ONCE. The browser hands back a directory
// handle, that handle is remembered in IndexedDB, and every path the apps
// use is relative to it:
//
//   /videos             -> <cth>/videos          (game film)
//   /videos/exports     -> <cth>/videos/exports  (exported clips + frames)
//   /videos/recordings  -> <cth>/videos/recordings (Slides screen recordings)
//   /diagrams           -> <cth>/diagrams        (diagram PNGs)
//
// Those are the SAME path strings the Dropbox build stored on every game
// record, which is why a library saved under Dropbox still resolves here
// with no migration: '/videos/games/x.mp4' just means a different disk.
//
// THE VIDEO FOLDER CAN BE MOVED (2026-09-04, Tony's call). '/videos' is a
// MOUNT, not a fixed location: normally it resolves to <cth>/videos, but
// Tony can point it at any folder on disk and that choice is remembered in
// the same IndexedDB, under its own key, so it survives every reload and
// can be changed or reset at any time. Only the RESOLUTION changes - every
// stored path string is still '/videos/...', so no game record, export
// path or clip is rewritten, and resetting to the default makes an old
// library resolve exactly as it did before.
//
// This uses the File System Access API. It is a real browser capability,
// not a server: nothing is uploaded anywhere, and the app still makes no
// network calls of its own. Chrome and Edge support it; Safari and Firefox
// do not expose a directory picker, so those fall back to the one-file
// picker the app already had (see fsSupported).

export const VIDEO_ROOT = '/videos';
export const EXPORT_ROOT = '/videos/exports';
export const RECORDING_ROOT = '/videos/recordings';
export const DIAGRAM_ROOT = '/diagrams';

const VIDEO_EXT = /\.(mp4|mov|m4v|webm|mkv|avi)$/i;

// ------------------------------------------------------- handle storage
// A two-line IndexedDB, separate from the app stores, holding one thing:
// the directory handle. Handles are structured-cloneable, so IndexedDB can
// keep them across reloads - localStorage cannot.

const DB = 'cth-files';
const STORE = 'handles';
const KEY = 'root';
// The optional custom video folder. A separate key, so choosing one never
// disturbs the CTH root that Diagrams and Slides also write through.
const VKEY = 'videos';

function idb() {
  return new Promise((res, rej) => {
    const r = indexedDB.open(DB, 1);
    r.onupgradeneeded = () => { r.result.createObjectStore(STORE); };
    r.onsuccess = () => res(r.result);
    r.onerror = () => rej(r.error);
  });
}

async function idbGet(key) {
  const db = await idb();
  return new Promise((res, rej) => {
    const r = db.transaction(STORE, 'readonly').objectStore(STORE).get(key);
    // A get on a missing key must resolve undefined, never the raw request.
    r.onsuccess = () => res(r.result === undefined ? undefined : r.result);
    r.onerror = () => rej(r.error);
  });
}

async function idbPut(key, val) {
  const db = await idb();
  return new Promise((res, rej) => {
    const tx = db.transaction(STORE, 'readwrite');
    tx.objectStore(STORE).put(val, key);
    tx.oncomplete = () => res();
    tx.onerror = () => rej(tx.error);
  });
}

async function idbDel(key) {
  const db = await idb();
  return new Promise((res, rej) => {
    const tx = db.transaction(STORE, 'readwrite');
    tx.objectStore(STORE).delete(key);
    tx.oncomplete = () => res();
    tx.onerror = () => rej(tx.error);
  });
}

// ------------------------------------------------------------- the root

let root = null;      // FileSystemDirectoryHandle or null
let granted = false;  // does the handle currently hold readwrite permission

// The custom video folder, when one has been chosen. Null means '/videos'
// resolves the default way, inside the CTH root.
let vroot = null;
let vgranted = false;

export function fsSupported() {
  return typeof window !== 'undefined' && typeof window.showDirectoryPicker === 'function';
}

// Called once at boot. Loads the remembered folder and checks - without
// prompting - whether permission is still live. Chrome returns 'granted'
// straight away when the user allowed the folder on every visit; otherwise
// it returns 'prompt' and the app shows a Reconnect button, because
// requestPermission is only allowed to run from a click.
export async function fsInit() {
  if (!fsSupported()) return false;
  try {
    root = (await idbGet(KEY)) || null;
  } catch (_) { root = null; }
  // The custom video folder is loaded on the same pass and checked the same
  // way. It is INDEPENDENT of the root: either one can be live while the
  // other needs a click, so each carries its own granted flag.
  try {
    vroot = (await idbGet(VKEY)) || null;
  } catch (_) { vroot = null; }
  if (vroot) {
    try {
      vgranted = (await vroot.queryPermission({ mode: 'readwrite' })) === 'granted';
    } catch (_) { vgranted = false; }
  }
  if (!root) return false;
  try {
    granted = (await root.queryPermission({ mode: 'readwrite' })) === 'granted';
  } catch (_) { granted = false; }
  return granted;
}

// Is a folder remembered at all (whether or not permission is live)?
export function fsRemembered() { return !!root; }
// Is the app able to read and write right now?
export function fsConnected() { return !!root && granted; }
export function fsRootName() { return root ? root.name : ''; }

// The picker. Must be called from a user gesture.
export async function fsConnect() {
  if (!fsSupported()) throw new Error('This Browser Cannot Open A Folder - Use Chrome Or Edge');
  const h = await window.showDirectoryPicker({ id: 'cth-root', mode: 'readwrite', startIn: 'documents' });
  const p = await h.requestPermission({ mode: 'readwrite' });
  if (p !== 'granted') throw new Error('Folder Permission Was Not Granted');
  root = h;
  granted = true;
  await idbPut(KEY, h);
  return h.name;
}

// Re-ask for a folder we already remember. Must be called from a gesture.
export async function fsReconnect() {
  if (!root) return fsConnect();
  const p = await root.requestPermission({ mode: 'readwrite' });
  granted = p === 'granted';
  if (!granted) throw new Error('Folder Permission Was Not Granted');
  return root.name;
}

export async function fsDisconnect() {
  root = null;
  granted = false;
  try { await idbDel(KEY); } catch (_) {}
}

// --------------------------------------------------- the video folder

// Has Tony pointed '/videos' somewhere of his own?
export function fsVideoCustom() { return !!vroot; }
// Its name, for the breadcrumb and the sheet. Empty when the default is in use.
export function fsVideoName() { return vroot ? vroot.name : ''; }
// A custom folder that is remembered but whose permission has lapsed. Chrome
// only lets requestPermission run from a click, so the app shows a button.
export function fsVideoNeedsReconnect() { return !!vroot && !vgranted; }

// Can '/videos' be read and written right now? This is the gate every video
// path should test, NOT fsConnected: with a custom video folder the CTH root
// is not on the way to the film at all, so a Clips session can run on the
// video folder alone.
export function fsVideosReady() { return vroot ? vgranted : (!!root && granted); }

// Pick a folder to use as '/videos'. Must be called from a user gesture.
// Any folder on disk will do - inside the CTH folder or on another drive.
export async function fsPickVideoFolder() {
  if (!fsSupported()) throw new Error('This Browser Cannot Open A Folder - Use Chrome Or Edge');
  const h = await window.showDirectoryPicker({ id: 'cth-videos', mode: 'readwrite', startIn: 'videos' });
  const p = await h.requestPermission({ mode: 'readwrite' });
  if (p !== 'granted') throw new Error('Folder Permission Was Not Granted');
  vroot = h;
  vgranted = true;
  await idbPut(VKEY, h);
  return h.name;
}

// Re-ask for the custom folder already remembered. Must be called from a gesture.
export async function fsReconnectVideoFolder() {
  if (!vroot) return fsPickVideoFolder();
  vgranted = (await vroot.requestPermission({ mode: 'readwrite' })) === 'granted';
  if (!vgranted) throw new Error('Folder Permission Was Not Granted');
  return vroot.name;
}

// Back to the default: '/videos' inside the CTH folder. Nothing stored is
// rewritten, so an older library resolves exactly as it always did.
export async function fsResetVideoFolder() {
  vroot = null;
  vgranted = false;
  try { await idbDel(VKEY); } catch (_) {}
}

// ------------------------------------------------------------- walking

function parts(path) {
  return String(path || '').split('/').filter(Boolean);
}

function need() {
  if (!root) throw new Error('No Folder Chosen Yet - Pick Your CTH Folder First');
  if (!granted) throw new Error('Folder Access Expired - Press Reconnect Folder');
  return root;
}

// Where a path starts. This is the ONE place the video mount is applied: a
// path whose first segment is 'videos' resolves inside the custom folder
// when there is one, and inside the CTH root when there is not. Nothing
// else in any app knows the difference, which is why no stored path had to
// change. A '/videos' path does not need the root at all while a custom
// folder is live, so a lapsed root cannot block film that lives elsewhere.
function baseFor(seg) {
  if (vroot && seg[0] === 'videos') {
    if (!vgranted) throw new Error('Video Folder Access Expired - Press Reconnect Video Folder');
    return { base: vroot, rest: seg.slice(1) };
  }
  return { base: need(), rest: seg };
}

// Walk to a directory. create:true makes every missing level on the way.
async function dirFor(path, { create = false } = {}) {
  const { base, rest } = baseFor(parts(path));
  let d = base;
  for (const name of rest) {
    d = await d.getDirectoryHandle(name, { create });
  }
  return d;
}

async function fileHandleFor(path, { create = false } = {}) {
  const seg = parts(path);
  const name = seg.pop();
  if (!name) throw new Error('Bad File Path');
  const dir = await dirFor(seg.join('/'), { create });
  return dir.getFileHandle(name, { create });
}

function isMissing(e) {
  return e && (e.name === 'NotFoundError' || /not found|could not be found/i.test(e.message || ''));
}

// ------------------------------------------------------------- reading

// Same shape the library browser already consumes: folders, files, and a
// `missing` flag so a folder that does not exist yet reads as a first-run
// state rather than an error.
export async function fsListFolder(path = VIDEO_ROOT) {
  let dir;
  try {
    dir = await dirFor(path);
  } catch (e) {
    if (isMissing(e)) return { folders: [], files: [], missing: true };
    throw e;
  }
  const folders = [];
  const files = [];
  for await (const [name, handle] of dir.entries()) {
    if (name.startsWith('.')) continue;
    if (handle.kind === 'directory') {
      folders.push({ name, path: `${path === '/' ? '' : path}/${name}` });
    } else if (VIDEO_EXT.test(name)) {
      let size = 0;
      let modified = '';
      try {
        const f = await handle.getFile();
        size = f.size;
        modified = new Date(f.lastModified).toISOString();
      } catch (_) {}
      files.push({ name, path: `${path === '/' ? '' : path}/${name}`, size, modified });
    }
  }
  folders.sort((a, b) => a.name.localeCompare(b.name));
  files.sort((a, b) => (b.modified || '').localeCompare(a.modified || ''));
  return { folders, files };
}

export async function fsCreateFolder(path) {
  const seg = parts(path);
  const name = seg.pop();
  const parent = await dirFor(seg.join('/'), { create: true });
  try {
    await parent.getDirectoryHandle(name);
    throw new Error('A Folder With That Name Already Exists');
  } catch (e) {
    if (!isMissing(e)) throw e;
  }
  await parent.getDirectoryHandle(name, { create: true });
  return { path };
}

// The real File. This is the best thing about working locally: the scrub
// engine reads frame bytes with File.slice instead of HTTP range requests,
// which is the faster of its two paths and cannot be refused by a server.
export async function fsGetFile(path) {
  const fh = await fileHandleFor(path);
  return fh.getFile();
}

export async function fsExists(path) {
  try { await fileHandleFor(path); return true; } catch (_) { return false; }
}

// A URL for <video src>. Object URLs are per-file and revoked when the same
// path is opened again, so a long session does not leak them.
const urls = new Map();
export async function fsFileUrl(path) {
  const f = await fsGetFile(path);
  const old = urls.get(path);
  if (old) URL.revokeObjectURL(old);
  const u = URL.createObjectURL(f);
  urls.set(path, u);
  return u;
}

// ------------------------------------------------------------- writing

// Written in chunks so a long export reports real progress. The default
// writable truncates, which is the overwrite behaviour the callers want.
const CHUNK = 8 * 1024 * 1024;

export async function fsWrite(path, blob, { onProgress = null } = {}) {
  const fh = await fileHandleFor(path, { create: true });
  const w = await fh.createWritable();
  try {
    if (!onProgress || blob.size <= CHUNK) {
      await w.write(blob);
      onProgress?.(1);
    } else {
      let off = 0;
      while (off < blob.size) {
        const end = Math.min(off + CHUNK, blob.size);
        await w.write(blob.slice(off, end));
        off = end;
        onProgress(off / blob.size);
      }
    }
    await w.close();
  } catch (e) {
    try { await w.abort(); } catch (_) {}
    throw e;
  }
  const seg = parts(path);
  return { path, name: seg[seg.length - 1] };
}

// A human label for a path, for toasts: '/videos/exports/x.mp4' reads as
// 'videos/exports/x.mp4' under the chosen folder. With a custom video
// folder the leading 'videos' is swapped for that folder's real name, so a
// toast names the place the file actually landed.
export function fsLabel(path) {
  const seg = parts(path);
  if (vroot && seg[0] === 'videos') seg[0] = vroot.name;
  return seg.join('/');
}
