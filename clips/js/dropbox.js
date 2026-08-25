// Dropbox from the browser - no server anywhere. OAuth 2 with PKCE (the
// flow made for exactly this: a public client that can hold no secret),
// refresh token kept in localStorage, and the handful of API calls Clips
// needs: list the videos folder, stream a file, upload an export, and mint
// permanent shared links for Notion embeds.
//
// One-time setup (Tony): create a Dropbox app at dropbox.com/developers/apps
// - Scoped access, Full Dropbox - add the app's URLs as redirect URIs
// (https://apps.coachtonyhockey.com/clips/ and http://localhost:8642/clips/),
// enable the scopes below under Permissions, then paste the App key into
// Clips' connect screen. The key is a public identifier - safe to store.

import { toast } from './ui.js';

const AUTH_KEY = 'cthc.dbx.v1';
export const VIDEO_ROOT = '/videos';
export const EXPORT_ROOT = '/videos/exports';
const SCOPES = 'files.metadata.read files.content.read files.content.write sharing.read sharing.write account_info.read';

function authState() {
  try { return JSON.parse(localStorage.getItem(AUTH_KEY)) || {}; } catch (_) { return {}; }
}
function saveAuth(patch) {
  localStorage.setItem(AUTH_KEY, JSON.stringify({ ...authState(), ...patch }));
}
export function dbxConnected() {
  const a = authState();
  return !!(a.appKey && a.refreshToken);
}
export function dbxAppKey() { return authState().appKey || ''; }
export function dbxDisconnect() { localStorage.removeItem(AUTH_KEY); }

// ------------------------------------------------------------- PKCE flow

const b64url = (buf) => btoa(String.fromCharCode(...new Uint8Array(buf)))
  .replaceAll('+', '-').replaceAll('/', '_').replaceAll('=', '');

async function sha256(str) {
  return b64url(await crypto.subtle.digest('SHA-256', new TextEncoder().encode(str)));
}

const redirectUri = () => location.origin + location.pathname;

export async function dbxBeginAuth(appKey) {
  const verifier = b64url(crypto.getRandomValues(new Uint8Array(48)));
  sessionStorage.setItem('cthc.pkce', verifier);
  saveAuth({ appKey });
  const u = new URL('https://www.dropbox.com/oauth2/authorize');
  u.searchParams.set('client_id', appKey);
  u.searchParams.set('response_type', 'code');
  u.searchParams.set('code_challenge', await sha256(verifier));
  u.searchParams.set('code_challenge_method', 'S256');
  u.searchParams.set('token_access_type', 'offline');
  u.searchParams.set('redirect_uri', redirectUri());
  u.searchParams.set('scope', SCOPES);
  location.href = u.toString();
}

// Call on boot: if we are returning from Dropbox with ?code=, finish the
// handshake. Returns true when a connection was just completed.
export async function dbxFinishAuth() {
  const code = new URLSearchParams(location.search).get('code');
  if (!code) return false;
  const verifier = sessionStorage.getItem('cthc.pkce');
  history.replaceState(null, '', location.pathname + location.hash);
  if (!verifier) return false;
  const body = new URLSearchParams({
    code,
    grant_type: 'authorization_code',
    code_verifier: verifier,
    client_id: authState().appKey,
    redirect_uri: redirectUri(),
  });
  const r = await fetch('https://api.dropboxapi.com/oauth2/token', { method: 'POST', body });
  if (!r.ok) { toast('Dropbox Connection Failed - Try Again', true); return false; }
  const j = await r.json();
  saveAuth({ refreshToken: j.refresh_token, accessToken: j.access_token, tokenAt: Date.now() });
  sessionStorage.removeItem('cthc.pkce');
  return true;
}

let refreshing = null;
async function accessToken() {
  const a = authState();
  if (a.accessToken && Date.now() - (a.tokenAt || 0) < 3.5 * 3600 * 1000) return a.accessToken;
  if (!refreshing) {
    refreshing = (async () => {
      const body = new URLSearchParams({
        grant_type: 'refresh_token',
        refresh_token: a.refreshToken,
        client_id: a.appKey,
      });
      const r = await fetch('https://api.dropboxapi.com/oauth2/token', { method: 'POST', body });
      if (!r.ok) throw new Error('Dropbox sign-in expired - reconnect from the library');
      const j = await r.json();
      saveAuth({ accessToken: j.access_token, tokenAt: Date.now() });
      return j.access_token;
    })().finally(() => { refreshing = null; });
  }
  return refreshing;
}

// ------------------------------------------------------------- API calls

async function rpc(path, arg) {
  const tok = await accessToken();
  const r = await fetch(`https://api.dropboxapi.com/2/${path}`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${tok}`, 'Content-Type': 'application/json' },
    body: JSON.stringify(arg),
  });
  if (!r.ok) {
    const text = await r.text();
    const e = new Error(`Dropbox ${path}: ${text.slice(0, 200)}`);
    e.body = text;
    e.status = r.status;
    throw e;
  }
  return r.json();
}

const VIDEO_EXT = /\.(mp4|mov|m4v|webm)$/i;

// List one folder level under /videos: subfolders plus video files.
export async function dbxListFolder(path = VIDEO_ROOT) {
  let entries = [];
  try {
    let j = await rpc('files/list_folder', { path: path === '/' ? '' : path, limit: 500 });
    entries = j.entries;
    while (j.has_more) {
      j = await rpc('files/list_folder/continue', { cursor: j.cursor });
      entries = entries.concat(j.entries);
    }
  } catch (e) {
    // A missing /videos folder is a first-run state, not an error.
    if (/not_found/.test(e.body || '')) return { folders: [], files: [], missing: true };
    throw e;
  }
  const folders = entries.filter((x) => x['.tag'] === 'folder')
    .map((x) => ({ name: x.name, path: x.path_lower }))
    .sort((a, b) => a.name.localeCompare(b.name));
  const files = entries.filter((x) => x['.tag'] === 'file' && VIDEO_EXT.test(x.name))
    .map((x) => ({ name: x.name, path: x.path_lower, size: x.size, modified: x.server_modified }))
    .sort((a, b) => (b.modified || '').localeCompare(a.modified || ''));
  return { folders, files };
}

// Create a real Dropbox folder (the library's New Folder button). Conflict
// on an existing name is surfaced as a plain-words error, not swallowed:
// the user asked for a folder and has to know they already have it.
export async function dbxCreateFolder(path) {
  try {
    return await rpc('files/create_folder_v2', { path, autorename: false });
  } catch (e) {
    if (/conflict/.test(e.body || '')) throw new Error('A Folder With That Name Already Exists');
    throw e;
  }
}

// A direct, range-request-capable URL for <video src> - valid about 4 hours.
export async function dbxTempLink(path) {
  const j = await rpc('files/get_temporary_link', { path });
  return j.link;
}

// A PERMANENT direct-stream URL (for Notion embeds): shared link converted
// to its raw form.
export async function dbxStreamLink(path) {
  let url;
  try {
    const j = await rpc('sharing/create_shared_link_with_settings', { path });
    url = j.url;
  } catch (e) {
    if (!/shared_link_already_exists/.test(e.body || '')) throw e;
    const j = await rpc('sharing/list_shared_links', { path, direct_only: true });
    url = j.links?.[0]?.url;
    if (!url) throw e;
  }
  const u = new URL(url);
  u.hostname = 'dl.dropboxusercontent.com';
  u.searchParams.delete('dl');
  return u.toString();
}

// Upload with real progress, chunking big files through an upload session
// (the single-call endpoint tops out at 150MB and game film sails past it).
// XHR rather than fetch because fetch has no upload progress events.
const SESSION_CHUNK = 24 * 1024 * 1024;

function xhrPost(url, headers, body, onProgress) {
  return new Promise((res, rej) => {
    const x = new XMLHttpRequest();
    x.open('POST', url);
    for (const [k, v] of Object.entries(headers)) x.setRequestHeader(k, v);
    if (onProgress) x.upload.onprogress = (e) => { if (e.lengthComputable) onProgress(e.loaded, e.total); };
    x.onload = () => {
      if (x.status >= 200 && x.status < 300) { try { res(JSON.parse(x.responseText)); } catch (_) { res({}); } }
      else rej(new Error(`Dropbox Upload Failed: ${String(x.responseText).slice(0, 160)}`));
    };
    x.onerror = () => rej(new Error('Dropbox Upload Failed - Check Your Connection'));
    x.send(body);
  });
}

// onProgress gets 0..1 across the WHOLE blob, chunked or not. autorename is
// on: an upload must never overwrite film that is already there.
export async function dbxUploadProgress(path, blob, onProgress = () => {}) {
  const tok = await accessToken();
  const arg = JSON.stringify;
  const H = (extra) => ({ Authorization: `Bearer ${tok}`, 'Content-Type': 'application/octet-stream', ...extra });
  if (blob.size <= SESSION_CHUNK) {
    return xhrPost('https://content.dropboxapi.com/2/files/upload',
      H({ 'Dropbox-API-Arg': arg({ path, mode: 'add', autorename: true, mute: true }) }),
      blob, (l, t) => onProgress(l / t));
  }
  const first = blob.slice(0, SESSION_CHUNK);
  const start = await xhrPost('https://content.dropboxapi.com/2/files/upload_session/start',
    H({ 'Dropbox-API-Arg': arg({ close: false }) }),
    first, (l) => onProgress(l / blob.size));
  let off = first.size;
  while (blob.size - off > SESSION_CHUNK) {
    const part = blob.slice(off, off + SESSION_CHUNK);
    const base = off;
    await xhrPost('https://content.dropboxapi.com/2/files/upload_session/append_v2',
      H({ 'Dropbox-API-Arg': arg({ cursor: { session_id: start.session_id, offset: base }, close: false }) }),
      part, (l) => onProgress((base + l) / blob.size));
    off += part.size;
  }
  const base = off;
  return xhrPost('https://content.dropboxapi.com/2/files/upload_session/finish',
    H({ 'Dropbox-API-Arg': arg({ cursor: { session_id: start.session_id, offset: base }, commit: { path, mode: 'add', autorename: true, mute: true } }) }),
    blob.slice(off), (l) => onProgress((base + l) / blob.size));
}

// Upload a Blob (exports, annotated frames). 150MB single-call limit is far
// beyond a PNG or a clip recording; session-chunking can come when needed.
// mode 'overwrite' keeps a STABLE path - the Diagrams embed links rely on
// that so a re-copied link updates the image already pasted in Notion.
export async function dbxUpload(path, blob, { mode = 'add' } = {}) {
  const tok = await accessToken();
  const r = await fetch('https://content.dropboxapi.com/2/files/upload', {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${tok}`,
      'Content-Type': 'application/octet-stream',
      'Dropbox-API-Arg': JSON.stringify({ path, mode, autorename: mode === 'add', mute: true }),
    },
    body: blob,
  });
  if (!r.ok) throw new Error(`Dropbox Upload Failed: ${(await r.text()).slice(0, 160)}`);
  return r.json();
}
