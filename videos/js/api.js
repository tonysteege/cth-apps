// The Worker behind CTH Videos (present-worker/videos.js). Everything here
// speaks to apps-api.coachtonyhockey.com and nothing else.
//
// THE KEY IS THE ONLY CREDENTIAL. It lives in this browser's localStorage
// (`cthv.key`) once Tony types it in, and travels as X-CTH-Key on every
// write. Reads of one video by id are public - that is what a share link is.

export const API = 'https://apps-api.coachtonyhockey.com';
const KEY = 'cthv.key';

let memKey = '';
export const getKey = () => { if (memKey) return memKey; try { return localStorage.getItem(KEY) || ''; } catch (_) { return ''; } };
export const setKey = (k) => { memKey = k || ''; try { if (k) localStorage.setItem(KEY, k); else localStorage.removeItem(KEY); } catch (_) { /* embeds may have no storage */ } };

class ApiError extends Error {
  constructor(status, body) {
    super(body?.message || body?.error || `Request failed (${status})`);
    this.status = status;
    this.code = body?.error || '';
  }
}

async function call(path, { method = 'GET', body, headers = {}, raw = false } = {}) {
  const h = { ...headers };
  const k = getKey();
  if (k) h['X-CTH-Key'] = k;
  if (body != null && !(body instanceof Blob) && !(body instanceof ArrayBuffer) && typeof body !== 'string') {
    h['Content-Type'] = 'application/json';
    body = JSON.stringify(body);
  }
  const r = await fetch(`${API}${path}`, { method, headers: h, body });
  if (raw) return r;
  let j = null;
  try { j = await r.json(); } catch (_) { j = null; }
  if (!r.ok) throw new ApiError(r.status, j);
  return j;
}

export const list = () => call('/videos').then((j) => j.videos || []);
export const get = (id) => call(`/videos/${id}`);
export const patch = (id, fields) => call(`/videos/${id}`, { method: 'PATCH', body: fields });
export const remove = (id) => call(`/videos/${id}`, { method: 'DELETE' });

// The three public addresses a video has. The share page is what goes to a
// parent or into a Notion embed block; the file is the bytes themselves.
export const fileUrl = (v) => `${API}/videos/${v.id}/file/${encodeURIComponent(v.fileName || 'video.mp4')}`;
export const posterUrl = (v) => (v.poster ? `${API}/videos/${v.id}/poster` : '');
export const watchUrl = (v, origin = location.origin, base = location.pathname.replace(/[^/]*$/, '')) => `${origin}${base}watch.html?v=${v.id}`;

// ---- reading a file before it goes up --------------------------------------

// Duration, size and a poster frame, read by the browser's own decoder. If it
// cannot decode the file (an HEVC iPhone clip in Chrome), the upload still
// goes ahead with what we know; the poster and duration just stay empty.
export function probe(file, { at = 0.1, width = 640 } = {}) {
  return new Promise((resolve) => {
    const url = URL.createObjectURL(file);
    const v = document.createElement('video');
    v.muted = true; v.playsInline = true; v.preload = 'metadata';
    const out = { duration: 0, width: 0, height: 0, poster: null };
    let done = false;
    const finish = () => {
      if (done) return; done = true;
      clearTimeout(timer);
      v.removeAttribute('src'); v.load();
      URL.revokeObjectURL(url);
      resolve(out);
    };
    const timer = setTimeout(finish, 12000);
    v.addEventListener('error', finish);
    v.addEventListener('loadedmetadata', () => {
      out.duration = Number.isFinite(v.duration) ? v.duration : 0;
      out.width = v.videoWidth; out.height = v.videoHeight;
      if (!out.duration || !out.width) { finish(); return; }
      v.currentTime = Math.min(Math.max(0.5, out.duration * at), Math.max(0, out.duration - 0.1));
    });
    v.addEventListener('seeked', () => {
      try {
        const c = document.createElement('canvas');
        const w = Math.min(width, v.videoWidth);
        c.width = w; c.height = Math.round(w * v.videoHeight / v.videoWidth);
        c.getContext('2d').drawImage(v, 0, 0, c.width, c.height);
        c.toBlob((b) => { out.poster = b; finish(); }, 'image/jpeg', 0.82);
      } catch (_) { finish(); }
    });
    v.src = url;
  });
}

// ---- upload ------------------------------------------------------------------

// XHR rather than fetch for the parts, because only XHR reports upload
// progress, and a progress bar that moves once per 32 MB is a frozen bar.
function putPart(url, blob, { onProgress, signal }) {
  return new Promise((resolve, reject) => {
    const x = new XMLHttpRequest();
    x.open('PUT', url);
    const k = getKey();
    if (k) x.setRequestHeader('X-CTH-Key', k);
    x.upload.onprogress = (e) => { if (onProgress) onProgress(e.loaded); };
    x.onload = () => {
      let j = null;
      try { j = JSON.parse(x.responseText); } catch (_) { j = null; }
      if (x.status >= 200 && x.status < 300 && j && j.etag) resolve(j);
      else reject(new ApiError(x.status, j));
    };
    x.onerror = () => reject(new Error('The network dropped during the upload.'));
    x.onabort = () => reject(Object.assign(new Error('cancelled'), { name: 'AbortError' }));
    if (signal) signal.addEventListener('abort', () => x.abort(), { once: true });
    x.send(blob);
  });
}

// Upload one file. `onProgress(fraction, note)`. Resolves to the finished
// video record. Parts go up three at a time, each retried three times, so a
// blip on rink wifi costs one part, not the whole game.
export async function upload(file, { name, onProgress = () => {}, signal } = {}) {
  onProgress(0, 'Reading');
  const info = await probe(file);
  if (signal?.aborted) throw Object.assign(new Error('cancelled'), { name: 'AbortError' });

  const start = await call('/videos', {
    method: 'POST',
    body: {
      name: name || file.name.replace(/\.[a-z0-9]+$/i, ''),
      fileName: file.name,
      type: file.type || 'video/mp4',
      size: file.size,
      duration: info.duration, width: info.width, height: info.height,
    },
  });
  const { id, uploadId, partSize } = start;
  const total = Math.max(1, Math.ceil(file.size / partSize));
  const sent = new Array(total).fill(0);
  const parts = [];
  const tick = () => onProgress(Math.min(0.995, sent.reduce((a, b) => a + b, 0) / file.size), 'Uploading');

  let failed = null;
  let next = 0;
  async function worker() {
    while (next < total && !failed) {
      const n = next++;
      const blob = file.slice(n * partSize, Math.min(file.size, (n + 1) * partSize));
      let tries = 0;
      for (;;) {
        try {
          const r = await putPart(`${API}/videos/${id}/part/${n + 1}?uploadId=${encodeURIComponent(uploadId)}`, blob, {
            signal,
            onProgress: (loaded) => { sent[n] = loaded; tick(); },
          });
          sent[n] = blob.size; tick();
          parts.push({ n: n + 1, etag: r.etag });
          break;
        } catch (e) {
          if (e.name === 'AbortError' || ++tries >= 3 || (e.status && e.status !== 500 && e.status !== 502 && e.status !== 503 && e.status !== 504 && e.status !== 0)) { failed = e; return; }
          await new Promise((res) => setTimeout(res, 800 * tries));
        }
      }
    }
  }
  await Promise.all([worker(), worker(), worker()]);
  if (failed) {
    try { await remove(id); } catch (_) { /* best effort */ }
    throw failed;
  }

  onProgress(0.995, 'Finishing');
  const done = await call(`/videos/${id}/complete`, {
    method: 'POST',
    body: { uploadId, parts, duration: info.duration, width: info.width, height: info.height },
  });
  if (info.poster) {
    try { await call(`/videos/${id}/poster`, { method: 'PUT', body: info.poster, headers: { 'Content-Type': 'image/jpeg' } }); done.video.poster = true; }
    catch (_) { /* a poster is a bonus */ }
  }
  onProgress(1, 'Done');
  return done.video;
}

// Regenerate a poster for a video that already lives in the library (a file
// the browser could not decode at upload time, or one Tony wants re-framed).
export async function setPoster(id, blob) {
  await call(`/videos/${id}/poster`, { method: 'PUT', body: blob, headers: { 'Content-Type': 'image/jpeg' } });
}

export const isAuthError = (e) => e && e.status === 401;
