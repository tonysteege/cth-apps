// CTH Videos - the storage centre behind apps.coachtonyhockey.com/videos/.
//
// The bytes live in the `cth-videos` R2 bucket, untouched: what Tony uploads
// is what a player downloads, byte for byte, because a coaching video that
// has been re-encoded "for the web" is a coaching video with the puck smeared.
// The library index lives in the VIDEOS KV namespace as one JSON document per
// video plus one `index` list, the same shape the Diagrams Notion store uses.
//
// WRITES NEED THE KEY. Uploading, renaming, deleting and posters all carry
// Tony's key in the X-CTH-Key header (the VIDEOS_KEY secret). READS OF ONE
// VIDEO ARE PUBLIC by id: an id is 12 unguessable characters, the same model
// as Notion's "anyone with the link", which is exactly what a share link for
// a parent or a player has to be. The LIST is key-gated: the library is
// Tony's, the videos in it are shared one at a time.
//
// UPLOADS ARE MULTIPART THROUGH THIS WORKER, not presigned S3 URLs, so no
// access key exists anywhere. The browser cuts the file into equal parts
// (R2 requires every part but the last to be the same size), PUTs each one
// here, and this Worker streams it straight into the multipart upload. A
// 10 GB game is ~320 parts of 32 MB; nothing is ever held in memory.
//
// STREAMING HONOURS RANGE, which is the whole ballgame: the <video> element
// seeks with Range, and the scrub decoder (clips/js/scrubsource.js) reads its
// 8 MB windows with Range. A server that answered 200 to a Range request
// would hand the decoder the entire file. Content-Range is exposed over CORS
// for the same reason.

const PART_SIZE = 32 * 1024 * 1024;
const INDEX_MAX = 3000;
const NAME_MAX = 200;

const ID_RE = /^[a-z0-9]{8,16}$/;

function newId() {
  const b = new Uint8Array(9);
  crypto.getRandomValues(b);
  return btoa(String.fromCharCode(...b)).replace(/[^a-z0-9]/gi, '').toLowerCase().slice(0, 12).padEnd(12, 'x');
}

// Public responses (the file, the poster, one video's metadata) allow any
// origin: a share link is meant to be opened, embedded and played anywhere.
const PUBLIC_CORS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Methods': 'GET, HEAD, OPTIONS',
  'Access-Control-Allow-Headers': 'Range, Content-Type',
  'Access-Control-Expose-Headers': 'Content-Range, Content-Length, Accept-Ranges, ETag, Content-Type',
};

const jsonOut = (data, status, cors, extra = {}) => new Response(JSON.stringify(data), {
  status,
  headers: { 'content-type': 'application/json;charset=utf-8', ...cors, ...extra },
});

const clean = (s, max = NAME_MAX) => String(s ?? '').replace(/[\u0000-\u001f]/g, ' ').trim().slice(0, max);
const num = (v) => (Number.isFinite(Number(v)) && Number(v) >= 0 ? Number(v) : 0);

// ASCII-only version of a file name for Content-Disposition, plus the RFC
// 5987 UTF-8 form so a name with an accent still downloads with its name.
function disposition(name, inline) {
  const ascii = name.replace(/[^\x20-\x7e]/g, '_').replace(/["\\]/g, '_');
  return `${inline ? 'inline' : 'attachment'}; filename="${ascii}"; filename*=UTF-8''${encodeURIComponent(name)}`;
}

async function readIndex(env) { return (await env.VIDEOS.get('index', 'json')) || []; }
async function writeIndex(env, idx) { await env.VIDEOS.put('index', JSON.stringify(idx.slice(0, INDEX_MAX))); }
const summary = (v) => ({
  id: v.id, name: v.name, size: v.size, type: v.type, duration: v.duration, width: v.width, height: v.height,
  created: v.created, updated: v.updated, poster: !!v.poster, fileName: v.fileName, status: v.status,
  folder: v.folder || '',
  tags: v.tags || [],
});

// Tags: short labels, no leading '#', unique case-insensitively, at most 40.
function cleanTags(list) {
  const out = []; const seen = new Set();
  for (const t of Array.isArray(list) ? list : []) {
    const c = clean(String(t).replace(/^#+/, ''), 40).replace(/\s+/g, ' ');
    if (!c || seen.has(c.toLowerCase())) continue;
    seen.add(c.toLowerCase()); out.push(c);
    if (out.length >= 40) break;
  }
  return out;
}

// A folder path: segments joined by '/', no leading or trailing slash, no
// empty or dot-only segments. '' is the root.
const cleanFolder = (f) => String(f ?? '').split('/').map((x) => clean(x, 80)).filter((x) => x && x !== '.' && x !== '..').join('/');
async function readFolders(env) { return (await env.VIDEOS.get('folders', 'json')) || []; }
async function writeFolders(env, list) {
  const set = new Set();
  for (const f of list) { const c = cleanFolder(f); if (c) { const parts = c.split('/'); for (let i = 1; i <= parts.length; i++) set.add(parts.slice(0, i).join('/')); } }
  const out = [...set].sort((a, b) => a.localeCompare(b)).slice(0, 2000);
  await env.VIDEOS.put('folders', JSON.stringify(out));
  return out;
}

async function upsertIndex(env, v) {
  const idx = (await readIndex(env)).filter((x) => x.id !== v.id);
  idx.unshift(summary(v));
  idx.sort((a, b) => (b.created || 0) - (a.created || 0));
  await writeIndex(env, idx);
}

// ---- the file: Range-capable streaming out of R2 ---------------------------

// A Range header, parsed here rather than handed to R2 as a Headers object:
// R2 then reports the served range in a shape this code cannot rely on, and
// Content-Range has to be exact or the <video> element and the scrub decoder
// both stall. Returns null for no header, false for one we cannot serve.
function parseRange(header, size) {
  if (!header) return null;
  const m = /^bytes=(\d*)-(\d*)$/.exec(header.trim());
  if (!m) return false;
  const [, a, b] = m;
  if (a === '' && b === '') return false;
  let offset; let end;
  if (a === '') { const n = Math.min(size, Number(b)); offset = size - n; end = size - 1; }
  else { offset = Number(a); end = b === '' ? size - 1 : Math.min(size - 1, Number(b)); }
  if (!Number.isFinite(offset) || offset < 0 || offset >= size || end < offset) return false;
  return { offset, length: end - offset + 1 };
}

async function serveObject(request, env, key, { name, type, cache }) {
  const head = request.method === 'HEAD';
  const base = new Headers(PUBLIC_CORS);
  base.set('accept-ranges', 'bytes');
  base.set('cache-control', cache || 'public, max-age=3600');
  if (name) base.set('content-disposition', disposition(name, true));

  const meta = await env.VIDEOS_BUCKET.head(key);
  if (!meta) return new Response('Not found', { status: 404, headers: base });
  const size = meta.size;
  const fill = (h, obj) => { obj.writeHttpMetadata(h); if (type) h.set('content-type', type); h.set('etag', obj.httpEtag); };

  const range = parseRange(request.headers.get('range'), size);
  if (range === false) {
    fill(base, meta);
    base.set('content-range', `bytes */${size}`);
    return new Response(null, { status: 416, headers: base });
  }

  if (head) {
    fill(base, meta);
    if (range) { base.set('content-range', `bytes ${range.offset}-${range.offset + range.length - 1}/${size}`); base.set('content-length', String(range.length)); }
    else base.set('content-length', String(size));
    return new Response(null, { status: range ? 206 : 200, headers: base });
  }

  // The browser already has it: an If-None-Match that matches comes back as
  // an R2Object with no body.
  const obj = await env.VIDEOS_BUCKET.get(key, { onlyIf: request.headers, ...(range ? { range } : {}) });
  if (!obj) return new Response('Not found', { status: 404, headers: base });
  fill(base, obj);
  if (!('body' in obj) || obj.body == null) return new Response(null, { status: 304, headers: base });

  if (range) {
    base.set('content-range', `bytes ${range.offset}-${range.offset + range.length - 1}/${size}`);
    base.set('content-length', String(range.length));
    return new Response(obj.body, { status: 206, headers: base });
  }
  base.set('content-length', String(size));
  return new Response(obj.body, { status: 200, headers: base });
}

// ---- the router --------------------------------------------------------------

export async function handleVideos(request, env, url, cors) {
  if (!env.VIDEOS || !env.VIDEOS_BUCKET) {
    return jsonOut({ error: 'setup', message: 'The VIDEOS KV namespace or the cth-videos bucket is not bound on this Worker.' }, 503, cors);
  }
  const key = request.headers.get('X-CTH-Key') || '';
  const authed = !!env.VIDEOS_KEY && key === env.VIDEOS_KEY;
  const deny = () => jsonOut({ error: 'auth', message: 'The key is wrong or missing.' }, 401, cors);
  // The folder list (key-gated): explicit folders, so an empty one exists.
  if (url.pathname === '/videos/folders') {
    if (!authed) return deny();
    if (request.method === 'GET') return jsonOut({ folders: await readFolders(env) }, 200, cors, { 'cache-control': 'no-store' });
    if (request.method === 'PUT') {
      let body;
      try { body = await request.json(); } catch (_) { return jsonOut({ error: 'bad_json', message: 'The body must be JSON.' }, 400, cors); }
      return jsonOut({ folders: await writeFolders(env, Array.isArray(body.folders) ? body.folders : []) }, 200, cors);
    }
    return jsonOut({ error: 'not_found' }, 404, cors);
  }
  const m = url.pathname.match(/^\/videos(?:\/([a-z0-9]{8,16}))?(?:\/(part|complete|poster|file|duplicate))?(?:\/(\d+))?(?:\/[^/]*)?$/);
  if (!m) return jsonOut({ error: 'not_found' }, 404, cors);
  const [, id, action, partNo] = m;

  // -- the library (key-gated) and a new upload
  if (!id) {
    if (!authed) return deny();
    if (request.method === 'GET') return jsonOut({ videos: await readIndex(env) }, 200, cors, { 'cache-control': 'no-store' });
    if (request.method === 'POST') {
      let body;
      try { body = await request.json(); } catch (_) { return jsonOut({ error: 'bad_json', message: 'The body must be JSON.' }, 400, cors); }
      const nid = newId();
      const fileName = clean(body.fileName || body.name || 'video.mp4', 255) || 'video.mp4';
      const type = /^video\/[a-z0-9.+-]+$/i.test(body.type || '') ? body.type : 'video/mp4';
      const doc = {
        id: nid,
        name: clean(body.name || fileName.replace(/\.[a-z0-9]+$/i, '')) || 'Untitled',
        fileName,
        type,
        size: num(body.size),
        duration: num(body.duration),
        width: num(body.width),
        height: num(body.height),
        codec: clean(body.codec || '', 64),
        folder: cleanFolder(body.folder),
        tags: cleanTags(body.tags),
        notes: '',
        created: Date.now(),
        updated: Date.now(),
        status: 'uploading',
        poster: false,
      };
      const mp = await env.VIDEOS_BUCKET.createMultipartUpload(`${nid}/original`, {
        httpMetadata: { contentType: type, contentDisposition: disposition(fileName, true) },
        customMetadata: { name: doc.name.slice(0, 120), fileName: fileName.slice(0, 120) },
      });
      doc.uploadId = mp.uploadId;
      await env.VIDEOS.put(`v:${nid}`, JSON.stringify(doc));
      if (doc.folder) { const fl = await readFolders(env); if (!fl.includes(doc.folder)) await writeFolders(env, [...fl, doc.folder]); }
      return jsonOut({ id: nid, uploadId: mp.uploadId, partSize: PART_SIZE }, 200, cors);
    }
    return jsonOut({ error: 'not_found' }, 404, cors);
  }

  if (!ID_RE.test(id)) return jsonOut({ error: 'not_found' }, 404, cors);
  const doc = await env.VIDEOS.get(`v:${id}`, 'json');

  // -- public reads: the file, the poster, the metadata
  if (action === 'file' && (request.method === 'GET' || request.method === 'HEAD')) {
    if (!doc || doc.status !== 'ready') return new Response('Not found', { status: 404, headers: PUBLIC_CORS });
    return serveObject(request, env, `${id}/original`, { name: doc.fileName, type: doc.type, cache: 'public, max-age=86400' });
  }
  if (action === 'poster' && (request.method === 'GET' || request.method === 'HEAD')) {
    if (!doc) return new Response('Not found', { status: 404, headers: PUBLIC_CORS });
    return serveObject(request, env, `${id}/poster.jpg`, { type: 'image/jpeg', cache: 'public, max-age=86400' });
  }
  if (!action && request.method === 'GET') {
    if (!doc || (doc.status !== 'ready' && !authed)) return jsonOut({ error: 'not_found', message: 'That video does not exist.' }, 404, PUBLIC_CORS);
    const { uploadId, ...pub } = doc;
    return jsonOut(pub, 200, PUBLIC_CORS, { 'cache-control': 'no-store' });
  }

  // -- everything below writes
  if (!authed) return deny();
  if (!doc) return jsonOut({ error: 'not_found', message: 'That video does not exist.' }, 404, cors);

  if (action === 'part' && request.method === 'PUT') {
    const n = Number(partNo);
    const uploadId = url.searchParams.get('uploadId') || doc.uploadId;
    if (!n || n < 1 || n > 10000 || !uploadId) return jsonOut({ error: 'bad_part', message: 'Part number or upload id missing.' }, 400, cors);
    const len = Number(request.headers.get('content-length') || 0);
    if (!len || !request.body) return jsonOut({ error: 'empty', message: 'The part has no body.' }, 400, cors);
    try {
      const mp = env.VIDEOS_BUCKET.resumeMultipartUpload(`${id}/original`, uploadId);
      const part = await mp.uploadPart(n, request.body);
      return jsonOut({ n: part.partNumber, etag: part.etag }, 200, cors);
    } catch (e) {
      return jsonOut({ error: 'part_failed', message: String(e && e.message || e).slice(0, 300) }, 500, cors);
    }
  }

  if (action === 'complete' && request.method === 'POST') {
    let body;
    try { body = await request.json(); } catch (_) { return jsonOut({ error: 'bad_json', message: 'The body must be JSON.' }, 400, cors); }
    const uploadId = body.uploadId || doc.uploadId;
    const parts = (body.parts || []).map((p) => ({ partNumber: Number(p.n ?? p.partNumber), etag: String(p.etag || '') }))
      .filter((p) => p.partNumber > 0 && p.etag).sort((a, b) => a.partNumber - b.partNumber);
    if (!uploadId || !parts.length) return jsonOut({ error: 'bad_parts', message: 'No parts to complete.' }, 400, cors);
    try {
      const mp = env.VIDEOS_BUCKET.resumeMultipartUpload(`${id}/original`, uploadId);
      const obj = await mp.complete(parts);
      const next = { ...doc, size: obj.size, status: 'ready', updated: Date.now() };
      delete next.uploadId;
      if (body.duration) next.duration = num(body.duration);
      if (body.width) next.width = num(body.width);
      if (body.height) next.height = num(body.height);
      await env.VIDEOS.put(`v:${id}`, JSON.stringify(next));
      await upsertIndex(env, next);
      return jsonOut({ ok: true, video: next }, 200, cors);
    } catch (e) {
      return jsonOut({ error: 'complete_failed', message: String(e && e.message || e).slice(0, 300) }, 500, cors);
    }
  }

  // Duplicate: a byte copy inside R2 (the object streams from the bucket
  // back into it, never through the browser) under a new id, same folder.
  if (action === 'duplicate' && request.method === 'POST') {
    if (doc.status !== 'ready') return jsonOut({ error: 'not_ready', message: 'That video has not finished uploading.' }, 409, cors);
    const src = await env.VIDEOS_BUCKET.get(`${id}/original`);
    if (!src) return jsonOut({ error: 'not_found', message: 'The file is missing.' }, 404, cors);
    if (src.size > 4.9 * 1024 * 1024 * 1024) return jsonOut({ error: 'too_big', message: 'Files over 4.9 GB cannot be duplicated in place yet; download and re-upload instead.' }, 413, cors);
    const nid = newId();
    const meta = new Headers(); src.writeHttpMetadata(meta);
    await env.VIDEOS_BUCKET.put(`${nid}/original`, src.body, { httpMetadata: src.httpMetadata, customMetadata: src.customMetadata });
    const poster = doc.poster ? await env.VIDEOS_BUCKET.get(`${id}/poster.jpg`) : null;
    if (poster) await env.VIDEOS_BUCKET.put(`${nid}/poster.jpg`, poster.body, { httpMetadata: poster.httpMetadata });
    let body = {};
    try { body = await request.json(); } catch (_) { body = {}; }
    const next = { ...doc, id: nid, name: clean(body.name) || `${doc.name} copy`, created: Date.now(), updated: Date.now(), poster: !!poster };
    if (body.folder != null) next.folder = cleanFolder(body.folder);
    delete next.uploadId;
    await env.VIDEOS.put(`v:${nid}`, JSON.stringify(next));
    await upsertIndex(env, next);
    return jsonOut({ ok: true, video: next }, 200, cors);
  }

  if (action === 'poster' && request.method === 'PUT') {
    const bytes = await request.arrayBuffer();
    if (!bytes.byteLength || bytes.byteLength > 2_000_000) return jsonOut({ error: 'bad_poster', message: 'A poster is a JPEG under 2 MB.' }, 400, cors);
    await env.VIDEOS_BUCKET.put(`${id}/poster.jpg`, bytes, { httpMetadata: { contentType: 'image/jpeg', cacheControl: 'public, max-age=86400' } });
    const next = { ...doc, poster: true, updated: Date.now() };
    await env.VIDEOS.put(`v:${id}`, JSON.stringify(next));
    if (next.status === 'ready') await upsertIndex(env, next);
    return jsonOut({ ok: true }, 200, cors);
  }

  if (!action && request.method === 'PATCH') {
    let body;
    try { body = await request.json(); } catch (_) { return jsonOut({ error: 'bad_json', message: 'The body must be JSON.' }, 400, cors); }
    const next = { ...doc, updated: Date.now() };
    if (body.name != null) next.name = clean(body.name) || doc.name;
    if (body.notes != null) next.notes = clean(body.notes, 4000);
    if (body.tags != null) next.tags = cleanTags(body.tags);
    if (body.folder != null) {
      next.folder = cleanFolder(body.folder);
      if (next.folder) { const fl = await readFolders(env); if (!fl.includes(next.folder)) await writeFolders(env, [...fl, next.folder]); }
    }
    await env.VIDEOS.put(`v:${id}`, JSON.stringify(next));
    if (next.status === 'ready') await upsertIndex(env, next);
    return jsonOut({ ok: true, video: next }, 200, cors);
  }

  if (!action && request.method === 'DELETE') {
    // An unfinished upload is aborted so R2 does not keep its parts around;
    // a finished one loses its object, its poster and its index entry.
    if (doc.uploadId) {
      try { await env.VIDEOS_BUCKET.resumeMultipartUpload(`${id}/original`, doc.uploadId).abort(); } catch (_) { /* already gone */ }
    }
    await env.VIDEOS_BUCKET.delete([`${id}/original`, `${id}/poster.jpg`]);
    await env.VIDEOS.delete(`v:${id}`);
    await writeIndex(env, (await readIndex(env)).filter((x) => x.id !== id));
    return jsonOut({ ok: true }, 200, cors);
  }

  return jsonOut({ error: 'not_found' }, 404, cors);
}
