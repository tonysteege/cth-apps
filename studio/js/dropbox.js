// DROPBOX - the film source, and the one place Studio touches the network.
//
// WHY DROPBOX AND NOT THE LOCAL CTH FOLDER (Tony's call, 2026-09-08). Clips
// moved off Dropbox onto the File System Access API and was right to: a real
// File scrubs faster than HTTP ranges and nothing leaves the Mac. Studio has
// the opposite requirement. It has to run on an iPad, on a phone, and inside a
// Notion embed, and `showDirectoryPicker` exists on none of them. It also has
// to hand out a URL, because a finished video that only exists on one Mac
// cannot be embedded in Notion or sent to a player. Those are exactly the two
// things the AGENTS.md note says only Dropbox could do.
//
// AUTH IS PKCE, WITH NO SECRET ANYWHERE. A Dropbox app key for a public client
// is not a credential - it is an identifier, safe in the browser by design -
// and PKCE means the code exchange needs no app secret. So Studio adds NO
// Worker route, NO repo secret and NO server state, which is a lower bar than
// the Slides Worker already clears. The refresh token lives in this browser's
// localStorage and nowhere else; Disconnect revokes it at Dropbox.
//
// EVERYTHING DEGRADES TO A FILE PICKER. `openLocalFile` needs no account, no
// network and no setup, and it is the path on a locked-down browser, on a
// plane, and the first time anyone opens Studio. Dropbox is the library;
// the picker is the escape hatch, and neither is a second-class citizen.

const LS = {
  key: 'cths.dbx.appkey.v1',
  tok: 'cths.dbx.token.v1',
  root: 'cths.dbx.root.v1',
};

export const DEFAULT_ROOT = '/CTH-DB/Videos/Games';
export const EXPORT_ROOT = '/CTH-DB/Videos/Studio';

const API = 'https://api.dropboxapi.com/2';
const CONTENT = 'https://content.dropboxapi.com/2';

let mem = null; // { access_token, refresh_token, expires }

// ---- configuration ---------------------------------------------------------

export function appKey() { return localStorage.getItem(LS.key) || ''; }
export function setAppKey(k) {
  const v = String(k || '').trim();
  if (v) localStorage.setItem(LS.key, v); else localStorage.removeItem(LS.key);
}
export function libraryRoot() { return localStorage.getItem(LS.root) || DEFAULT_ROOT; }
export function setLibraryRoot(p) { localStorage.setItem(LS.root, normPath(p) || DEFAULT_ROOT); }

export function normPath(p) {
  let s = String(p || '').trim().replace(/\\/g, '/');
  if (!s || s === '/') return '';
  if (!s.startsWith('/')) s = `/${s}`;
  return s.replace(/\/+$/, '');
}

function loadTok() {
  if (mem) return mem;
  try { mem = JSON.parse(localStorage.getItem(LS.tok) || 'null'); } catch (_) { mem = null; }
  return mem;
}
function saveTok(t) {
  mem = t;
  if (t) localStorage.setItem(LS.tok, JSON.stringify(t)); else localStorage.removeItem(LS.tok);
}

export function connected() { const t = loadTok(); return !!(t && t.refresh_token); }

// ---- PKCE ------------------------------------------------------------------

function b64url(buf) {
  return btoa(String.fromCharCode(...new Uint8Array(buf)))
    .replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}
async function sha256(s) { return crypto.subtle.digest('SHA-256', new TextEncoder().encode(s)); }
function randomVerifier() {
  const a = new Uint8Array(64); crypto.getRandomValues(a);
  return b64url(a).slice(0, 96);
}

export function redirectUri() {
  // Dropbox matches the redirect EXACTLY, so it must be a stable, path-only
  // URL. The hash carries app state and is not sent to Dropbox anyway.
  return `${location.origin}${location.pathname}`;
}

export async function beginAuth() {
  const key = appKey();
  if (!key) throw new Error('Add your Dropbox app key in Settings first.');
  const verifier = randomVerifier();
  sessionStorage.setItem('cths.dbx.pkce', verifier);
  sessionStorage.setItem('cths.dbx.back', location.hash || '');
  const challenge = b64url(await sha256(verifier));
  const u = new URL('https://www.dropbox.com/oauth2/authorize');
  u.searchParams.set('client_id', key);
  u.searchParams.set('response_type', 'code');
  u.searchParams.set('redirect_uri', redirectUri());
  u.searchParams.set('code_challenge', challenge);
  u.searchParams.set('code_challenge_method', 'S256');
  u.searchParams.set('token_access_type', 'offline'); // gives the refresh token
  location.href = u.toString();
}

// Call once at boot. Returns true if it consumed an auth code, in which case
// the caller should re-render as connected.
export async function finishAuth() {
  const q = new URLSearchParams(location.search);
  const code = q.get('code');
  if (!code) return false;
  const verifier = sessionStorage.getItem('cths.dbx.pkce');
  const back = sessionStorage.getItem('cths.dbx.back') || '';
  sessionStorage.removeItem('cths.dbx.pkce');
  sessionStorage.removeItem('cths.dbx.back');
  // Clean the URL before anything can fail, so a bad code is not replayed.
  history.replaceState(null, '', `${location.pathname}${back}`);
  if (!verifier) throw new Error('That sign-in did not start here. Try Connect again.');

  const body = new URLSearchParams({
    code,
    grant_type: 'authorization_code',
    client_id: appKey(),
    code_verifier: verifier,
    redirect_uri: redirectUri(),
  });
  const r = await fetch('https://api.dropboxapi.com/oauth2/token', {
    method: 'POST', headers: { 'Content-Type': 'application/x-www-form-urlencoded' }, body,
  });
  if (!r.ok) throw new Error(`Dropbox refused the sign-in (${r.status}).`);
  const j = await r.json();
  saveTok({
    access_token: j.access_token,
    refresh_token: j.refresh_token,
    expires: Date.now() + (j.expires_in || 14400) * 1000 - 60000,
  });
  return true;
}

async function token() {
  const t = loadTok();
  if (!t || !t.refresh_token) throw new Error('NOT_CONNECTED');
  if (t.access_token && Date.now() < t.expires) return t.access_token;
  const body = new URLSearchParams({
    grant_type: 'refresh_token', refresh_token: t.refresh_token, client_id: appKey(),
  });
  const r = await fetch('https://api.dropboxapi.com/oauth2/token', {
    method: 'POST', headers: { 'Content-Type': 'application/x-www-form-urlencoded' }, body,
  });
  if (!r.ok) { saveTok(null); throw new Error('NOT_CONNECTED'); }
  const j = await r.json();
  const next = {
    ...t, access_token: j.access_token, expires: Date.now() + (j.expires_in || 14400) * 1000 - 60000,
  };
  saveTok(next);
  return next.access_token;
}

export async function disconnect() {
  try { await rpc('/auth/token/revoke', null); } catch (_) { /* revoking a dead token is fine */ }
  saveTok(null);
}

// ---- calls -----------------------------------------------------------------

async function rpc(path, arg) {
  const t = await token();
  const r = await fetch(API + path, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${t}`,
      ...(arg === null ? {} : { 'Content-Type': 'application/json' }),
    },
    body: arg === null ? null : JSON.stringify(arg),
  });
  if (!r.ok) {
    const text = await r.text().catch(() => '');
    if (r.status === 401) { saveTok(null); throw new Error('NOT_CONNECTED'); }
    throw new Error(dbxMessage(r.status, text));
  }
  return r.status === 204 ? null : r.json();
}

// Dropbox error bodies are JSON tag soup. Turn the handful that actually
// happen into a sentence, and never show the raw tag.
function dbxMessage(status, text) {
  if (/not_found/.test(text)) return 'That folder or file is not in Dropbox any more.';
  if (/insufficient_space/.test(text)) return 'Your Dropbox is full.';
  if (/too_many_requests|rate_limit/.test(text)) return 'Dropbox is rate limiting. Wait a moment and try again.';
  if (/invalid_access_token|expired_access_token/.test(text)) return 'NOT_CONNECTED';
  if (status === 409) return 'Dropbox would not accept that path.';
  return `Dropbox error ${status}.`;
}

export async function account() {
  const j = await rpc('/users/get_current_account', null);
  return { name: j?.name?.display_name || '', email: j?.email || '' };
}

const VIDEO_RE = /\.(mp4|m4v|mov|webm)$/i;

// One folder's children, folders first, each entry carrying just what the
// library tree needs. Pagination is followed to the end - a season folder with
// 400 games is normal and a half-listed library is a bug that looks like a
// missing file.
export async function list(path = libraryRoot()) {
  const p = normPath(path);
  let res = await rpc('/files/list_folder', { path: p, limit: 500, include_non_downloadable_files: false });
  const out = [...(res.entries || [])];
  while (res.has_more) {
    res = await rpc('/files/list_folder/continue', { cursor: res.cursor });
    out.push(...(res.entries || []));
  }
  return out
    .map((e) => ({
      dir: e['.tag'] === 'folder',
      name: e.name,
      path: e.path_lower || e.path_display,
      display: e.path_display,
      size: e.size || 0,
      rev: e.rev || '',
      modified: e.server_modified || '',
    }))
    .filter((e) => e.dir || VIDEO_RE.test(e.name))
    .sort((a, b) => (a.dir === b.dir
      ? a.name.localeCompare(b.name, undefined, { numeric: true })
      : (a.dir ? -1 : 1)));
}

export async function search(query, path = libraryRoot()) {
  const j = await rpc('/files/search_v2', {
    query: String(query || '').slice(0, 200),
    options: {
      path: normPath(path) || undefined, max_results: 100, file_status: 'active', filename_only: true,
    },
  });
  return (j.matches || [])
    .map((m) => m.metadata?.metadata)
    .filter((e) => e && e['.tag'] === 'file' && VIDEO_RE.test(e.name))
    .map((e) => ({ dir: false, name: e.name, path: e.path_lower, display: e.path_display, size: e.size || 0 }));
}

// A 4-hour direct URL that honours HTTP Range. Both the <video> element and
// the scrub decoder stream from this same URL, which is the whole reason the
// decoder's range path exists.
const linkCache = new Map();
export async function tempLink(path) {
  const p = normPath(path);
  const hit = linkCache.get(p);
  if (hit && Date.now() < hit.until) return hit.url;
  const j = await rpc('/files/get_temporary_link', { path: p });
  const url = j.link;
  linkCache.set(p, { url, until: Date.now() + 3.2 * 3600 * 1000 });
  return url;
}
export function forgetLink(path) { linkCache.delete(normPath(path)); }

export async function ensureFolder(path) {
  const p = normPath(path);
  if (!p) return;
  try {
    await rpc('/files/create_folder_v2', { path: p, autorename: false });
  } catch (_) { /* it already exists, which is the only outcome we wanted */ }
}

// Upload. Dropbox caps a single-shot PUT at 150MB, so anything larger goes
// through an append session. Exports are seconds long and never hit that, but
// a source file copied in might.
const CHUNK = 8 * 1024 * 1024;
export async function upload(path, blob, onProgress) {
  const t = await token();
  const p = normPath(path);
  const commit = { path: p, mode: 'overwrite', autorename: false, mute: true };

  if (blob.size <= 140 * 1024 * 1024) {
    const r = await fetch(`${CONTENT}/files/upload`, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${t}`,
        'Content-Type': 'application/octet-stream',
        'Dropbox-API-Arg': apiArg(commit),
      },
      body: blob,
    });
    if (!r.ok) throw new Error(dbxMessage(r.status, await r.text().catch(() => '')));
    onProgress?.(1);
    return r.json();
  }

  let offset = 0;
  let sessionId = '';
  while (offset < blob.size) {
    const end = Math.min(blob.size, offset + CHUNK);
    const part = blob.slice(offset, end);
    const last = end >= blob.size;
    let url; let arg;
    if (!sessionId) {
      url = `${CONTENT}/files/upload_session/start`; arg = { close: false };
    } else if (!last) {
      url = `${CONTENT}/files/upload_session/append_v2`;
      arg = { cursor: { session_id: sessionId, offset }, close: false };
    } else {
      url = `${CONTENT}/files/upload_session/finish`;
      arg = { cursor: { session_id: sessionId, offset }, commit };
    }
    const r = await fetch(url, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${t}`,
        'Content-Type': 'application/octet-stream',
        'Dropbox-API-Arg': apiArg(arg),
      },
      body: part,
    });
    if (!r.ok) throw new Error(dbxMessage(r.status, await r.text().catch(() => '')));
    if (!sessionId) sessionId = (await r.json()).session_id;
    else if (last) { onProgress?.(1); return r.json(); }
    offset = end;
    onProgress?.(offset / blob.size);
  }
  return null;
}

// Dropbox-API-Arg must be HTTP-header-safe ASCII; anything above 0x7f has to be
// escaped or the whole request is rejected. A Cyrillic team name in a file name
// is routine here, so this is not a corner case.
const NON_ASCII = new RegExp('[\\u007f-\\uffff]', 'g');
function apiArg(o) {
  return JSON.stringify(o).replace(NON_ASCII, (c) => `\\u${c.charCodeAt(0).toString(16).padStart(4, '0')}`);
}

// A permanent public link, rewritten to the raw form so it PLAYS in a Notion
// embed instead of opening Dropbox's preview page.
export async function shareLink(path) {
  const p = normPath(path);
  let url = '';
  try {
    const j = await rpc('/sharing/create_shared_link_with_settings', {
      path: p, settings: { audience: 'public', access: 'viewer' },
    });
    url = j.url;
  } catch (_) {
    const j = await rpc('/sharing/list_shared_links', { path: p, direct_only: true });
    url = j?.links?.[0]?.url || '';
  }
  if (!url) throw new Error('Dropbox would not make a link for that file.');
  return url.replace(/[?&]dl=\d/, '').replace('www.dropbox.com', 'dl.dropboxusercontent.com');
}

export async function del(path) { return rpc('/files/delete_v2', { path: normPath(path) }); }

// ---- the escape hatch ------------------------------------------------------

// No account, no network, no setup. Also the ONLY path on iOS Safari before a
// Dropbox app key is configured, so it is never hidden behind a "connect first"
// wall.
export function openLocalFile(accept = 'video/*') {
  return new Promise((resolve) => {
    const i = document.createElement('input');
    i.type = 'file';
    i.accept = accept;
    i.onchange = () => resolve(i.files?.[0] || null);
    // Safari drops the change event if the input is not in the document.
    i.style.cssText = 'position:fixed;left:-9999px';
    document.body.appendChild(i);
    i.click();
    setTimeout(() => i.remove(), 60000);
  });
}

// A file the browser can save straight to disk, for when Dropbox is not where
// this one is going.
export function download(blob, name) {
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url; a.download = name;
  document.body.appendChild(a);
  a.click();
  setTimeout(() => { a.remove(); URL.revokeObjectURL(url); }, 4000);
}
