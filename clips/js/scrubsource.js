// The scrub source: a decoder we own, so that moving one frame costs a decode
// instead of a seek. PORTED FROM CTH FILM ROOM (renderer/js/scrubsource.js +
// main/mp4index.js, 2026-08-25) - the engine, its constants and its comments
// are carried over to the number; what changed is only where bytes come from:
//
//   Film Room (Electron)             here (browser)
//   fs.readSync on a local path  ->  File.slice() for a locally opened file,
//                                    HTTP Range requests against the Dropbox
//                                    temp link for a cloud one (the same URL
//                                    the <video> element streams from, which
//                                    is range-capable by construction).
//
// WHY (Film Room's measurement, 2026-07-31, on a 2h39m game): asking <video>
// for the very NEXT frame costs 28ms - the same as a frame two hours away -
// because every `currentTime =` re-decodes from the preceding keyframe. That
// is a hard ~30 pictures/sec ceiling with 69ms of swing, and the swing is the
// chop. A decoder we own keeps its position, so the next frame costs ~2ms.
//
// Everything here degrades to null. A file we can't index (webm, fragmented
// mp4), a codec WebCodecs won't take, a decoder that errors mid-gesture: all
// of them just mean the scrubber keeps seeking the element as before.

// ---- byte providers --------------------------------------------------------

const RANGE_MAX = 96 * 1024 * 1024;

function fileProvider(file) {
  return {
    local: true,
    size: file.size,
    async read(offset, length) {
      const end = Math.min(file.size, offset + length);
      if (offset >= end) return null;
      const buf = await file.slice(offset, end).arrayBuffer();
      return new Uint8Array(buf);
    },
  };
}

function urlProvider(url) {
  return {
    local: false,
    size: null, // learned from the first response
    async read(offset, length) {
      const r = await fetch(url, { headers: { Range: `bytes=${offset}-${offset + length - 1}` } });
      if (r.status === 206 || r.ok) {
        const cr = r.headers.get('Content-Range');
        if (cr) { const m = /\/(\d+)$/.exec(cr); if (m) this.size = Number(m[1]); }
        // A 200 means the server ignored the Range header - it would hand us
        // the whole multi-GB file. Refuse; the caller falls back.
        if (r.status !== 206) { try { r.body?.cancel(); } catch (_) { /* fine */ } return null; }
        return new Uint8Array(await r.arrayBuffer());
      }
      return null;
    },
  };
}

// ---- mp4 demuxer (mp4index.js, Buffer -> DataView) -------------------------

const CONTAINERS = new Set(['moov', 'trak', 'mdia', 'minf', 'stbl', 'edts']);
const fourcc = (dv, p) => String.fromCharCode(dv.getUint8(p), dv.getUint8(p + 1), dv.getUint8(p + 2), dv.getUint8(p + 3));

function readBoxHeader(dv, pos, limit) {
  if (pos + 8 > limit) return null;
  let size = dv.getUint32(pos);
  const type = fourcc(dv, pos + 4);
  let body = pos + 8;
  if (size === 1) {
    if (pos + 16 > limit) return null;
    size = dv.getUint32(pos + 8) * 4294967296 + dv.getUint32(pos + 12);
    body = pos + 16;
  } else if (size === 0) {
    size = limit - pos;
  }
  if (size < 8 || pos + size > limit) return null;
  return { type, start: pos, body, end: pos + size };
}

function eachChild(dv, from, to, fn) {
  let pos = from;
  while (pos < to) {
    const b = readBoxHeader(dv, pos, to);
    if (!b) break;
    fn(b);
    pos = b.end;
  }
}

// Find `moov` reading only box headers off the file. Commonly the LAST
// top-level box (a camera can't know its size until it stops), so this scans
// - and over HTTP each header is one small range request, of which a real
// file has only a handful of top-level boxes.
async function findMoov(provider) {
  let pos = 0;
  const fileSize = provider.size ?? Infinity;
  for (let hops = 0; hops < 64 && pos < fileSize; hops++) {
    const head = await provider.read(pos, 16);
    if (!head || head.length < 8) return null;
    const dv = new DataView(head.buffer, head.byteOffset, head.byteLength);
    let size = dv.getUint32(0);
    const type = fourcc(dv, 4);
    let hdr = 8;
    if (size === 1) {
      if (head.length < 16) return null;
      size = dv.getUint32(8) * 4294967296 + dv.getUint32(12);
      hdr = 16;
    } else if (size === 0) {
      size = (provider.size ?? 0) - pos;
      if (size <= 0) return null;
    }
    if (size < 8) return null;
    if (type === 'moov') {
      if (size - hdr > RANGE_MAX) return null; // a moov this big is not a moov
      return provider.read(pos + hdr, size - hdr);
    }
    pos += size;
  }
  return null;
}

const version = (dv, b) => dv.getUint8(b.body);

function parseRotation(dv, b) {
  try {
    const off = b.body + (version(dv, b) === 1 ? 52 : 40);
    const ONE = 65536;
    const a = dv.getInt32(off);
    const bb = dv.getInt32(off + 4);
    const c = dv.getInt32(off + 12);
    const d = dv.getInt32(off + 16);
    if (bb === ONE && c === -ONE) return 90;
    if (a === -ONE && d === -ONE) return 180;
    if (bb === -ONE && c === ONE) return 270;
    return 0;
  } catch (_) {
    return 0;
  }
}

function parseMdhd(dv, b) {
  const v = version(dv, b);
  let p = b.body + 4;
  if (v === 1) { p += 16; return { timescale: dv.getUint32(p), duration: Number(dv.getBigUint64(p + 4)) }; }
  p += 8;
  return { timescale: dv.getUint32(p), duration: dv.getUint32(p + 4) };
}

function parseElst(dv, b, mediaTimescale, movieTimescale) {
  const v = version(dv, b);
  const n = dv.getUint32(b.body + 4);
  let p = b.body + 8;
  let shift = 0;
  let mediaStart = 0;
  let seenReal = false;
  for (let i = 0; i < n && p < b.end; i++) {
    let dur; let mt;
    if (v === 1) { dur = Number(dv.getBigUint64(p)); mt = Number(dv.getBigInt64(p + 8)); p += 20; }
    else { dur = dv.getUint32(p); mt = dv.getInt32(p + 4); p += 12; }
    if (mt < 0) { shift += dur / (movieTimescale || 1); continue; }
    if (!seenReal) { mediaStart = mt / mediaTimescale; seenReal = true; }
  }
  return shift - mediaStart;
}

const hexByte = (n) => n.toString(16).padStart(2, '0');
const avcCodec = (cfg) => `avc1.${hexByte(cfg[1])}${hexByte(cfg[2])}${hexByte(cfg[3])}`;
function hevcCodec(cfg) {
  const b1 = cfg[1];
  const space = ['', 'A', 'B', 'C'][(b1 >> 6) & 3];
  const tier = ((b1 >> 5) & 1) ? 'H' : 'L';
  const profile = b1 & 31;
  let compat = 0;
  for (let i = 0; i < 4; i++) compat = (compat >>> 0) | (((cfg[2 + i] >>> 0) & 0xff) << (i * 8));
  let rev = 0;
  for (let i = 0; i < 32; i++) rev = ((rev << 1) | ((compat >>> i) & 1)) >>> 0;
  const constraints = [];
  for (let i = 11; i >= 6; i--) { if (cfg[i] || constraints.length) constraints.unshift(hexByte(cfg[i])); }
  return `hvc1.${space}${profile}.${(rev >>> 0).toString(16)}.${tier}${cfg[12]}${constraints.length ? '.' + constraints.join('.') : ''}`;
}

function parseStsd(dv, bytes, b) {
  const p = b.body + 8;
  const e = readBoxHeader(dv, p, b.end);
  if (!e) return null;
  const out = {
    format: e.type,
    width: dv.getUint16(e.start + 32),
    height: dv.getUint16(e.start + 34),
    codec: null,
    description: null,
  };
  eachChild(dv, e.start + 86, e.end, (c) => {
    if (c.type === 'avcC' || c.type === 'hvcC') {
      const cfg = bytes.subarray(c.body, c.end);
      out.description = Uint8Array.from(cfg);
      out.codec = c.type === 'avcC' ? avcCodec(cfg) : hevcCodec(cfg);
    }
  });
  return out;
}

function buildSamples(dv, tables, timescale, ptsOffset) {
  const { stts, ctts, stss, stsc, stsz, stco, co64 } = tables;
  if (!stts || !stsc || !stsz || !(stco || co64)) return null;

  const sizeConst = dv.getUint32(stsz.body + 4);
  const count = dv.getUint32(stsz.body + 8);
  if (!count) return null;
  const size = new Uint32Array(count);
  if (sizeConst) size.fill(sizeConst);
  else for (let i = 0; i < count; i++) size[i] = dv.getUint32(stsz.body + 12 + i * 4);

  const dts = new Float64Array(count);
  {
    const n = dv.getUint32(stts.body + 4);
    let p = stts.body + 8; let i = 0; let t = 0;
    for (let e = 0; e < n && i < count; e++) {
      const c = dv.getUint32(p); const d = dv.getUint32(p + 4); p += 8;
      for (let k = 0; k < c && i < count; k++) { dts[i++] = t; t += d; }
    }
    if (i < count) { const d = i > 1 ? dts[i - 1] - dts[i - 2] : timescale / 30; for (; i < count; i++) { dts[i] = t; t += d; } }
  }

  const pts = new Float64Array(count);
  if (ctts) {
    const v = version(dv, ctts);
    const n = dv.getUint32(ctts.body + 4);
    let p = ctts.body + 8; let i = 0;
    for (let e = 0; e < n && i < count; e++) {
      const c = dv.getUint32(p);
      const o = v === 1 ? dv.getInt32(p + 4) : dv.getUint32(p + 4);
      p += 8;
      for (let k = 0; k < c && i < count; k++) { pts[i] = dts[i] + o; i++; }
    }
    for (; i < count; i++) pts[i] = dts[i];
  } else {
    pts.set(dts);
  }
  for (let i = 0; i < count; i++) pts[i] = pts[i] / timescale + ptsOffset;
  for (let i = 0; i < count; i++) dts[i] = dts[i] / timescale + ptsOffset;

  const key = new Uint8Array(count);
  if (stss) {
    const n = dv.getUint32(stss.body + 4);
    for (let e = 0; e < n; e++) {
      const s = dv.getUint32(stss.body + 8 + e * 4) - 1;
      if (s >= 0 && s < count) key[s] = 1;
    }
  } else {
    key.fill(1);
  }
  key[0] = 1;

  const off = new Float64Array(count);
  {
    const chunkBox = co64 || stco;
    const chunkCount = dv.getUint32(chunkBox.body + 4);
    const chunkOff = (i) => (co64
      ? Number(dv.getBigUint64(co64.body + 8 + i * 8))
      : dv.getUint32(stco.body + 8 + i * 4));
    const runs = dv.getUint32(stsc.body + 4);
    let s = 0;
    for (let r = 0; r < runs && s < count; r++) {
      const first = dv.getUint32(stsc.body + 8 + r * 12) - 1;
      const per = dv.getUint32(stsc.body + 8 + r * 12 + 4);
      const lastChunk = r + 1 < runs ? dv.getUint32(stsc.body + 8 + (r + 1) * 12) - 1 : chunkCount;
      for (let c = first; c < lastChunk && s < count; c++) {
        let at = chunkOff(c);
        for (let k = 0; k < per && s < count; k++) { off[s] = at; at += size[s]; s++; }
      }
    }
    if (s < count) return null;
  }

  const order = new Int32Array(count);
  for (let i = 0; i < count; i++) order[i] = i;
  let sorted = true;
  for (let i = 1; i < count; i++) if (pts[i] < pts[i - 1]) { sorted = false; break; }
  if (!sorted) order.sort((a, b) => pts[a] - pts[b]);

  let reorder = 0;
  if (!sorted) {
    const WINDOW = 32;
    for (let i = 0; i < count; i++) {
      const lim = Math.min(count, i + WINDOW + 1);
      for (let j = i + 1; j < lim; j++) if (pts[j] < pts[i] && j - i > reorder) reorder = j - i;
    }
  }

  return { count, reorder, pts, dts, off, size, key, order };
}

async function indexVideo(provider) {
  try {
    const moovBytes = await findMoov(provider);
    if (!moovBytes) return null;
    const dv = new DataView(moovBytes.buffer, moovBytes.byteOffset, moovBytes.byteLength);
    const len = moovBytes.byteLength;

    let movieTimescale = 0;
    eachChild(dv, 0, len, (b) => {
      if (b.type !== 'mvhd') return;
      movieTimescale = version(dv, b) === 1 ? dv.getUint32(b.body + 20) : dv.getUint32(b.body + 12);
    });
    movieTimescale = movieTimescale || 1000;

    let found = null;
    eachChild(dv, 0, len, (trak) => {
      if (found || trak.type !== 'trak') return;
      const tables = {};
      let isVideo = false; let timescale = 0; let mediaDur = 0; let stsd = null; let elst = null; let tkhd = null;
      const walk = (from, to, parent) => eachChild(dv, from, to, (b) => {
        if (CONTAINERS.has(b.type)) { walk(b.body, b.end, b.type); return; }
        if (b.type === 'tkhd' && parent === 'trak') { tkhd = b; return; }
        // ONLY mdia's own hdlr says what kind of track this is; a .MOV's minf
        // carries a second hdlr ('alis') that must not answer.
        if (b.type === 'hdlr' && parent === 'mdia') isVideo = fourcc(dv, b.body + 8) === 'vide';
        else if (b.type === 'mdhd') { const m = parseMdhd(dv, b); timescale = m.timescale; mediaDur = m.duration; }
        else if (b.type === 'stsd') stsd = b;
        else if (b.type === 'elst') elst = b;
        else if (['stts', 'ctts', 'stss', 'stsc', 'stsz', 'stz2', 'stco', 'co64'].includes(b.type)) tables[b.type] = b;
      });
      walk(trak.body, trak.end, 'trak');
      if (!isVideo || !timescale || !stsd) return;
      if (tables.stz2 && !tables.stsz) return;
      const desc = parseStsd(dv, moovBytes, stsd);
      if (!desc || !desc.codec || !desc.description) return;
      const ptsOffset = elst ? parseElst(dv, elst, timescale, movieTimescale) : 0;
      const s = buildSamples(dv, tables, timescale, ptsOffset);
      if (!s) return;
      found = {
        codec: desc.codec,
        description: desc.description,
        width: desc.width,
        height: desc.height,
        rotation: tkhd ? parseRotation(dv, tkhd) : 0,
        duration: mediaDur / timescale,
        ...s,
      };
    });
    return found;
  } catch (_) {
    return null;
  }
}

// ---- the source engine (Film Room's makeSource, byte layer swapped) --------
// The constants and every hard-won rule in request() are Film Room's,
// measured there on real game film; see that repo's scrubsource.js for the
// full measurement history. One browser adjustment: the byte window is 8MB
// over the network (a Dropbox range request) against 32MB for a local file,
// so the first read lands in a fraction of a second on rink wifi.

const CACHE_BYTES = 640 * 1024 * 1024;
// Decoded frames are cached at up to this width. Raised 1280 -> 1920 on
// 2026-08-26: game film is 1080p, and capping at 1280 meant every scrubbed
// frame was a downscale of the source. The byte budget below is unchanged,
// so a 1080p file now caches ~77 frames instead of ~173 - still far more
// than a gesture needs, and each one is now pixel-for-pixel the source.
// 4K still caps here on purpose; caching 33MB frames would buy 19 of them.
const CACHE_MAX_W = 1920;
const MAX_LAG = 900;
const WINDOW_FRAMES = 480;
const QUEUE_DEPTH = 48;
const FEED_MAX_CALL = 192;
const PREFETCH_AHEAD = 96;
const FAST_FPS = 1600;
const COARSE_RESEED_MS = 60;
const FWD_THROUGH = 90;
const RESEED_MS = 180;
const RESEED_MISS_MS = 25;
const LOOKAHEAD = 4;
const SOFT_TOL = 1.5;
const IDLE_DROP_MS = 60000;

const open = new Map(); // id -> source (Clips has one player; keep 1)

export function releaseScrubSource(id) {
  const s = open.get(id);
  if (s) { open.delete(id); s.destroy(); }
}

// One source per game. `provider` comes from scrubProviderFor below. Returns
// null for anything we can't drive - callers treat null as "seek the element
// the way you always did".
export async function openScrubSource(id, provider) {
  if (!id || !provider || typeof VideoDecoder === 'undefined') return null;
  if (open.has(id)) return open.get(id);

  const ix = await indexVideo(provider).catch(() => null);
  if (!ix || !ix.count || !ix.codec || !ix.description) return null;
  // Rotation lives in the container, not the pixels: the overlay would paint
  // sideways while <video> shows the file upright. Fall back to seeking.
  if (ix.rotation) return null;

  const config = {
    codec: ix.codec,
    description: ix.description,
    codedWidth: ix.width,
    codedHeight: ix.height,
    hardwareAcceleration: 'prefer-hardware',
    // Without this the decoder sits on finished frames waiting for a flush,
    // and flushing forbids the next chunk being a delta frame - throwing away
    // the decoder position this whole file exists to keep.
    optimizeForLatency: true,
  };
  let ok = false;
  try { ok = (await VideoDecoder.isConfigSupported(config)).supported; } catch (_) { ok = false; }
  if (!ok) return null;

  const src = makeSource(id, provider, ix, config);
  for (const [k, v] of open) { open.delete(k); v.destroy(); }
  open.set(id, src);
  return src;
}

function makeSource(id, provider, ix, config) {
  const { count, pts, key, off, size, order } = ix;
  const frameSec = (ix.duration && count) ? ix.duration / count : 1 / 30;
  const WINDOW_BYTES = provider.local ? 32 * 1024 * 1024 : 8 * 1024 * 1024;

  const cw = Math.min(CACHE_MAX_W, ix.width || CACHE_MAX_W);
  const ch = Math.max(1, Math.round(cw * (ix.height || 1) / (ix.width || 1)));
  const budget = Math.max(8, Math.floor(CACHE_BYTES / (cw * ch * 4)));
  const cache = new Map();
  const pool = [];
  let lastServed = -1;
  let lastDir = 0;
  let stride = 1;

  const takeCanvas = () => {
    if (pool.length) return pool.pop();
    const c = document.createElement('canvas');
    c.width = cw; c.height = ch;
    return { c, ctx: c.getContext('2d', { alpha: false }) };
  };
  const evict = () => {
    if (cache.size <= budget) return;
    const fwd = (lastDir < 0 ? 12 : Math.round(budget * 0.6)) * stride;
    const back = (lastDir < 0 ? Math.round(budget * 0.55) : 24) * stride;
    for (const k of cache.keys()) {
      if (cache.size <= budget) break;
      if (lastServed >= 0 && k >= lastServed - back && k <= lastServed + fwd) continue;
      pool.push(cache.get(k));
      cache.delete(k);
    }
    while (cache.size > budget) {
      const k = cache.keys().next().value;
      pool.push(cache.get(k));
      cache.delete(k);
    }
  };
  const dropCache = () => { for (const v of cache.values()) pool.push(v); cache.clear(); };

  const ptsAt = (j) => pts[order[j]];
  function presFor(t) {
    let lo = 0; let hi = count - 1; let ans = -1;
    while (lo <= hi) { const m = (lo + hi) >> 1; if (ptsAt(m) <= t) { ans = m; lo = m + 1; } else hi = m - 1; }
    return ans;
  }
  const keyAtOrBefore = (i) => { while (i > 0 && !key[i]) i--; return i; };
  const presOf = new Int32Array(count);
  for (let j = 0; j < count; j++) presOf[order[j]] = j;

  function nearest(j, below, above) {
    const nb = Math.max(0, Math.round(below / frameSec));
    const na = Math.max(0, Math.round(above / frameSec));
    for (let d = 1; d <= Math.max(nb, na); d++) {
      if (d <= nb) { const s = cache.get(j - d); if (s) { stats.near++; lastServed = j - d; return { c: s.c, t: ptsAt(j - d) }; } }
      if (d <= na) { const s = cache.get(j + d); if (s) { stats.near++; lastServed = j + d; return { c: s.c, t: ptsAt(j + d) }; } }
    }
    return null;
  }

  function keyTimeBelow(t) {
    const j = presFor(t);
    if (j < 0) return null;
    return pts[keyAtOrBefore(order[j])];
  }

  // Two byte windows plus edge prefetch, so the read for the next stretch is
  // landing while the current one decodes (what keeps a network file from
  // stalling the walk).
  const wins = [];
  const winFor = (i) => wins.find((w) => i >= w.from && i < w.to);
  let reading = false;

  async function loadWindow(from) {
    if (reading || dead || from < 0 || from >= count) return false;
    reading = true;
    try {
      let to = Math.min(count, from + WINDOW_FRAMES);
      let bytes = (off[to - 1] + size[to - 1]) - off[from];
      while (to > from + 1 && bytes > WINDOW_BYTES) { to = from + Math.max(1, ((to - from) >> 1)); bytes = (off[to - 1] + size[to - 1]) - off[from]; }
      const buf = await provider.read(off[from], bytes);
      if (dead || !buf) return false;
      wins.push({ from, to, bytes: buf });
      while (wins.length > 2) {
        const olds = wins.slice(0, -1);
        const drop = olds.find((w) => !(fedTo + 1 >= w.from && fedTo + 1 < w.to)) || olds[0];
        wins.splice(wins.indexOf(drop), 1);
      }
      return true;
    } catch (_) {
      return false;
    } finally {
      reading = false;
    }
  }

  let dec = null;
  let fedTo = -1;
  let positioned = false;
  let seedAt = Infinity;
  let fillGoal = null;
  let seeding = false;
  let lastReseed = 0;
  let missing = false;
  let lastReqT = null;
  let idleTimer = null;
  let dead = false;
  const stats = { hit: 0, near: 0, decoded: 0, fallback: 0, reseed: 0, err: '' };

  const teardown = () => {
    if (dec) { try { dec.close(); } catch (_) { /* already closed */ } }
    dec = null; fedTo = -1; positioned = false; seedAt = Infinity; fillGoal = null;
  };

  function onFrame(f) {
    const t = f.timestamp / 1e6;
    let lo = 0; let hi = count - 1; let j = -1;
    while (lo <= hi) { const m = (lo + hi) >> 1; if (ptsAt(m) <= t + 1e-6) { j = m; lo = m + 1; } else hi = m - 1; }
    const wanted = stride === 1 || j % stride === 0 || key[order[j]] === 1;
    if (j >= 0 && wanted && !cache.has(j)) {
      const slot = takeCanvas();
      slot.ctx.drawImage(f, 0, 0, cw, ch);
      cache.set(j, slot);
      stats.decoded++;
      evict();
    }
    f.close();
  }

  function newDecoder() {
    teardown();
    dec = new VideoDecoder({
      output: onFrame,
      error: (e) => { stats.err = String(e && e.message || e); teardown(); },
    });
    dec.configure(config);
  }

  const chunkFor = (i, w) => new EncodedVideoChunk({
    type: key[i] ? 'key' : 'delta',
    timestamp: Math.round(pts[i] * 1e6),
    data: w.bytes.subarray(off[i] - off[w.from], off[i] - off[w.from] + size[i]),
  });

  function feed(need, cap = FEED_MAX_CALL, gate = true) {
    if (!dec || dec.state !== 'configured') return;
    let fed = 0;
    while (fedTo < need && fed < cap) {
      if (gate && dec.decodeQueueSize >= QUEUE_DEPTH) break;
      const i = fedTo + 1;
      const w = winFor(i);
      if (!w) { void loadWindow(i); break; }
      try { dec.decode(chunkFor(i, w)); } catch (_) { teardown(); return; }
      fedTo = i; fed++;
      if (fedTo + PREFETCH_AHEAD >= w.to && w.to < count && !winFor(w.to)) void loadWindow(w.to);
    }
  }

  async function reseed(atDecodeIdx) {
    if (seeding || dead) return;
    seeding = true;
    stats.reseed++;
    try {
      const k = keyAtOrBefore(Math.max(0, atDecodeIdx));
      if (!winFor(k)) { if (!await loadWindow(k)) return; }
      if (dead) return;
      newDecoder();
      fedTo = k - 1;
      seedAt = k;
      positioned = true;
    } catch (_) {
      teardown();
    } finally {
      seeding = false;
    }
  }

  const reseedOk = (now) => now - lastReseed > (missing ? RESEED_MISS_MS : RESEED_MS);

  function request(t, speed = 0, tol = 0) {
    if (dead) return null;
    clearTimeout(idleTimer);
    const j = presFor(t);
    if (j < 0) return null;
    const want = Math.max(1, Math.min(8, Math.round(speed / 144)));
    stride += Math.sign(want - stride);
    const dir = lastReqT == null ? 0 : (t > lastReqT + 1e-4 ? 1 : (t < lastReqT - 1e-4 ? -1 : lastDir));
    lastDir = dir;
    lastReqT = t;
    const target = order[j];

    if (speed > FAST_FPS) {
      const exact = cache.get(j);
      if (exact) { stats.hit++; lastServed = j; missing = false; return { c: exact.c, t: ptsAt(j) }; }
      const kIdx = keyAtOrBefore(target);
      const kJ = presOf[kIdx];
      const kSlot = cache.get(kJ);
      if (!kSlot) {
        const standing = dec && dec.state === 'configured' && positioned && seedAt === kIdx;
        if (standing) {
          feed(Math.min(count - 1, kIdx + LOOKAHEAD + 2));
        } else if (!seeding) {
          const now = performance.now();
          if (now - lastReseed > COARSE_RESEED_MS) { lastReseed = now; fillGoal = null; void reseed(kIdx); }
        }
      }
      const gopBack = Math.max(0, t - ptsAt(kJ));
      const near = nearest(j, gopBack + frameSec, frameSec * 4);
      if (near) { missing = false; return near; }
      if (kSlot) { stats.hit++; lastServed = kJ; missing = false; return { c: kSlot.c, t: ptsAt(kJ) }; }
      stats.fallback++;
      missing = true;
      return null;
    }

    const warm = dec && dec.state === 'configured' && positioned;
    if (fillGoal != null && warm) {
      feed(fillGoal);
      if (fedTo >= fillGoal) fillGoal = null;
    } else {
      const walkThrough = warm && target >= fedTo && target - fedTo <= FWD_THROUGH;
      const reachable = warm && target >= seedAt
        && (walkThrough || keyAtOrBefore(target) <= fedTo + 1)
        && target - fedTo <= MAX_LAG;
      if (reachable) {
        const ahead = Math.min(Math.round(budget * 0.5), Math.round(speed * 0.025) + LOOKAHEAD + 8);
        feed(Math.min(count - 1, target + ahead));
      } else if (!seeding && !(warm && seedAt === keyAtOrBefore(target))) {
        const now = performance.now();
        if (reseedOk(now)) { lastReseed = now; fillGoal = null; void reseed(target); }
      }
    }

    const slot = cache.get(j);
    if (slot) { stats.hit++; lastServed = j; missing = false; return { c: slot.c, t: ptsAt(j) }; }

    const catching = seeding || fillGoal != null
      || (warm && target - fedTo > LOOKAHEAD + 2);
    const latt = stride * frameSec * 1.5;
    const range = Math.min(SOFT_TOL, Math.max(tol, latt, catching ? SOFT_TOL : 0));
    if (range > 0) {
      const near = nearest(j, range, range);
      if (near) { missing = false; return near; }
    }
    const inRun = warm && !seeding && seedAt === keyAtOrBefore(target);
    if (!inRun && !seeding) {
      const now = performance.now();
      if (reseedOk(now)) { lastReseed = now; fillGoal = null; void reseed(target); }
    }
    stats.fallback++;
    missing = true;
    return null;
  }

  function prime(t) {
    if (dead || seeding) return;
    const j = presFor(t);
    if (j < 0) return;
    const target = order[j];
    if (dec && dec.state === 'configured' && positioned
      && target >= seedAt && keyAtOrBefore(target) <= fedTo + 1 && target >= fedTo) {
      feed(Math.min(count - 1, target + LOOKAHEAD), 4096, false);
      return;
    }
    reseed(target).then(() => {
      if (dead || !dec || dec.state !== 'configured') return;
      feed(Math.min(count - 1, target + LOOKAHEAD), 4096, false);
    });
  }

  return {
    id,
    width: cw,
    height: ch,
    duration: ix.duration,
    stats,
    request,
    keyTimeBelow,
    prime,
    rest() {
      teardown();
      clearTimeout(idleTimer);
      idleTimer = setTimeout(() => { dropCache(); wins.length = 0; }, IDLE_DROP_MS);
    },
    destroy() { dead = true; clearTimeout(idleTimer); teardown(); dropCache(); wins.length = 0; },
  };
}

// Build the byte provider for a game: the File itself when it was opened
// locally (zero-copy slices), the Dropbox temp link otherwise (the same
// range-capable URL the <video> element streams from).
export function scrubProviderFor(file, url) {
  if (file) return fileProvider(file);
  if (url && /^https?:/.test(url)) return urlProvider(url);
  return null;
}
