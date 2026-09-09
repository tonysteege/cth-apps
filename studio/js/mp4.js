// A MINIMAL MP4 (ISO BMFF) MUXER - enough to wrap what WebCodecs gives us,
// and nothing more.
//
// WHY WRITE ONE. The alternative is a CDN script, and this repo has no build
// step, no npm and a hard rule against third-party embeds. A muxer for ONE
// H.264 track plus ONE AAC track, non-fragmented, is about three hundred lines
// of table-filling; a dependency for it would outlive its usefulness.
//
// NON-FRAGMENTED, moov LAST. Samples are buffered, then `finish()` writes
// ftyp + mdat + moov in one go. That means the whole video is in memory before
// a file exists - fine, and deliberate, because Studio exports clips measured
// in seconds, not games measured in hours. A fragmented writer would stream but
// plays worse in QuickTime and in Notion's embed, which is where these land.
//
// The tables written here (stts, stss, stsc, stsz, stco, ctts) are the ones a
// player needs to seek. Skipping ctts is what makes a B-frame export play back
// with the frames in the wrong order, so it is written whenever the encoder
// hands back a composition offset.

const MOVIE_TS = 1000; // movie timescale: milliseconds, plenty for our lengths

// ---- byte writing ----------------------------------------------------------

class Buf {
  constructor() { this.parts = []; this.len = 0; }
  push(u8) { this.parts.push(u8); this.len += u8.byteLength; return this; }
  u8(...v) { return this.push(new Uint8Array(v)); }
  u16(v) { const a = new Uint8Array(2); new DataView(a.buffer).setUint16(0, v); return this.push(a); }
  u32(v) { const a = new Uint8Array(4); new DataView(a.buffer).setUint32(0, v >>> 0); return this.push(a); }
  i32(v) { const a = new Uint8Array(4); new DataView(a.buffer).setInt32(0, v | 0); return this.push(a); }
  u64(v) {
    const a = new Uint8Array(8); const d = new DataView(a.buffer);
    d.setUint32(0, Math.floor(v / 4294967296)); d.setUint32(4, v >>> 0);
    return this.push(a);
  }
  str(s) { return this.push(new TextEncoder().encode(s)); }
  bytes() {
    const out = new Uint8Array(this.len);
    let o = 0;
    for (const p of this.parts) { out.set(p, o); o += p.byteLength; }
    return out;
  }
}

// A box is `size + type + payload`. Children are already-built Uint8Arrays.
function box(type, ...parts) {
  let len = 8;
  for (const p of parts) len += p.byteLength;
  const b = new Buf();
  b.u32(len).str(type);
  for (const p of parts) b.push(p);
  return b.bytes();
}
function fullBox(type, version, flags, ...parts) {
  const head = new Buf().u8(version).u8((flags >> 16) & 255, (flags >> 8) & 255, flags & 255).bytes();
  return box(type, head, ...parts);
}
const raw = (b) => (b instanceof Uint8Array ? b : new Uint8Array(b));

// ---- the muxer -------------------------------------------------------------

export class MP4Muxer {
  // `video` is { width, height, timescale } - timescale is the video track's
  // own clock, normally the frame rate so durations are exact integers.
  constructor(video, audio = null) {
    this.video = { ...video, samples: [], description: null };
    this.audio = audio ? { ...audio, samples: [], description: null } : null;
    this.chunks = [];
    this.offset = 0;
  }

  // `chunk` is an EncodedVideoChunk / EncodedAudioChunk; `meta` its metadata,
  // whose `decoderConfig.description` carries avcC / AudioSpecificConfig. The
  // encoder emits that ONCE, on the first chunk, so it must be kept.
  addVideo(chunk, meta) { this.#add(this.video, chunk, meta); }
  addAudio(chunk, meta) { if (this.audio) this.#add(this.audio, chunk, meta); }

  #add(track, chunk, meta) {
    const desc = meta?.decoderConfig?.description;
    if (desc && !track.description) track.description = raw(desc);
    const data = new Uint8Array(chunk.byteLength);
    chunk.copyTo(data);
    this.chunks.push(data);
    track.samples.push({
      offsetIndex: this.chunks.length - 1,
      size: data.byteLength,
      // WebCodecs timestamps are microseconds; convert into the track clock.
      dts: Math.round((chunk.timestamp / 1e6) * track.timescale),
      cts: Math.round((chunk.timestamp / 1e6) * track.timescale),
      dur: Math.max(1, Math.round(((chunk.duration || 0) / 1e6) * track.timescale)),
      key: chunk.type === 'key',
    });
    this.offset += data.byteLength;
  }

  finish() {
    const tracks = [this.video, this.audio].filter((t) => t && t.samples.length);
    if (!tracks.length) throw new Error('Nothing was encoded.');
    for (const t of tracks) fixDurations(t);

    // mdat payload order = the order chunks arrived, which is the order the
    // sample tables index. Interleaving video and audio properly would need a
    // second pass; at these lengths a player buffers the lot regardless.
    let mdatSize = 0;
    for (const c of this.chunks) mdatSize += c.byteLength;
    const large = mdatSize + 8 > 0xfffffff0;

    const ftyp = box('ftyp', new Buf().str('isom').u32(512).str('isomiso2avc1mp41').bytes());
    const mdatHeader = large
      ? new Buf().u32(1).str('mdat').u64(mdatSize + 16).bytes()
      : new Buf().u32(mdatSize + 8).str('mdat').bytes();

    // Chunk offsets are absolute file positions, so they depend on where mdat
    // starts - which is known only now, and is why the tables are built last.
    const base = ftyp.byteLength + mdatHeader.byteLength;
    const at = [];
    let o = base;
    for (const c of this.chunks) { at.push(o); o += c.byteLength; }

    const longest = Math.max(...tracks.map((t) => trackSeconds(t)));
    const moov = box(
      'moov',
      mvhd(longest, tracks.length + 1),
      ...tracks.map((t, i) => trak(t, i + 1, at, longest)),
    );

    const out = new Uint8Array(base + mdatSize + moov.byteLength);
    out.set(ftyp, 0);
    out.set(mdatHeader, ftyp.byteLength);
    let p = base;
    for (const c of this.chunks) { out.set(c, p); p += c.byteLength; }
    out.set(moov, p);
    return new Blob([out], { type: 'video/mp4' });
  }
}

// The last sample has no successor to measure against, and an encoder often
// reports no duration at all. Derive each from the next sample's timestamp and
// give the tail the median of the rest, so the file's length is honest.
function fixDurations(track) {
  const s = track.samples;
  for (let i = 0; i < s.length - 1; i++) s[i].dur = Math.max(1, s[i + 1].dts - s[i].dts);
  if (s.length > 1) {
    const mid = s.slice(0, -1).map((x) => x.dur).sort((a, b) => a - b)[Math.floor((s.length - 1) / 2)];
    s[s.length - 1].dur = Math.max(1, mid || s[s.length - 1].dur);
  }
}
function trackSeconds(t) {
  const s = t.samples;
  return s.length ? (s[s.length - 1].dts + s[s.length - 1].dur) / t.timescale : 0;
}

// ---- moov ------------------------------------------------------------------

function mvhd(seconds, nextTrack) {
  return fullBox('mvhd', 0, 0, new Buf()
    .u32(0).u32(0)                                  // created, modified
    .u32(MOVIE_TS).u32(Math.round(seconds * MOVIE_TS))
    .u32(0x00010000).u16(0x0100).u16(0)             // rate 1.0, volume 1.0
    .u32(0).u32(0)                                  // reserved
    .push(UNITY_MATRIX)
    .u32(0).u32(0).u32(0).u32(0).u32(0).u32(0)      // predefined
    .u32(nextTrack)
    .bytes());
}

const UNITY_MATRIX = new Buf()
  .u32(0x00010000).u32(0).u32(0)
  .u32(0).u32(0x00010000).u32(0)
  .u32(0).u32(0).u32(0x40000000)
  .bytes();

function trak(t, id, at, movieSeconds) {
  const isVideo = t.kind !== 'audio';
  return box('trak', tkhd(t, id, movieSeconds, isVideo), mdia(t, at, isVideo));
}

function tkhd(t, id, movieSeconds, isVideo) {
  return fullBox('tkhd', 0, 3, new Buf()   // flags 3 = enabled + in movie
    .u32(0).u32(0).u32(id).u32(0)
    .u32(Math.round(movieSeconds * MOVIE_TS))
    .u32(0).u32(0)
    .u16(0).u16(0)                          // layer, alternate group
    .u16(isVideo ? 0 : 0x0100).u16(0)       // volume
    .push(UNITY_MATRIX)
    .u32(isVideo ? (t.width << 16) : 0)
    .u32(isVideo ? (t.height << 16) : 0)
    .bytes());
}

function mdia(t, at, isVideo) {
  const mdhd = fullBox('mdhd', 0, 0, new Buf()
    .u32(0).u32(0).u32(t.timescale)
    .u32(Math.round(trackSeconds(t) * t.timescale))
    .u16(0x55c4).u16(0)                     // language 'und'
    .bytes());
  const hdlr = fullBox('hdlr', 0, 0, new Buf()
    .u32(0).str(isVideo ? 'vide' : 'soun').u32(0).u32(0).u32(0)
    .str(isVideo ? 'VideoHandler\0' : 'SoundHandler\0')
    .bytes());
  return box('mdia', mdhd, hdlr, minf(t, at, isVideo));
}

function minf(t, at, isVideo) {
  const header = isVideo
    ? fullBox('vmhd', 0, 1, new Buf().u16(0).u16(0).u16(0).u16(0).bytes())
    : fullBox('smhd', 0, 0, new Buf().u16(0).u16(0).bytes());
  const dinf = box('dinf', fullBox('dref', 0, 0, new Buf().u32(1).bytes(), fullBox('url ', 0, 1)));
  return box('minf', header, dinf, stbl(t, at, isVideo));
}

function stbl(t, at, isVideo) {
  const s = t.samples;
  const entry = isVideo ? avc1(t) : mp4a(t);
  const stsd = fullBox('stsd', 0, 0, new Buf().u32(1).bytes(), entry);

  // stts: runs of equal duration.
  const runs = [];
  for (const x of s) {
    const last = runs[runs.length - 1];
    if (last && last.dur === x.dur) last.n++; else runs.push({ n: 1, dur: x.dur });
  }
  const sttsB = new Buf().u32(runs.length);
  for (const r of runs) sttsB.u32(r.n).u32(r.dur);
  const stts = fullBox('stts', 0, 0, sttsB.bytes());

  // ctts: only if any sample's composition time differs from its decode time.
  const anyOffset = s.some((x) => x.cts !== x.dts);
  let ctts = null;
  if (anyOffset) {
    const cb = new Buf().u32(s.length);
    for (const x of s) cb.u32(1).i32(x.cts - x.dts);
    ctts = fullBox('ctts', 1, 0, cb.bytes());
  }

  // stss: sync samples. Omitted entirely when every frame is a keyframe, which
  // is what "all frames are sync" means to a player.
  const keys = [];
  s.forEach((x, i) => { if (x.key) keys.push(i + 1); });
  const stss = (isVideo && keys.length && keys.length !== s.length)
    ? fullBox('stss', 0, 0, (() => { const b = new Buf().u32(keys.length); for (const k of keys) b.u32(k); return b.bytes(); })())
    : null;

  // One sample per chunk keeps stsc trivial and stco exact; the file is a
  // little larger in table bytes and correct in every player.
  const stsc = fullBox('stsc', 0, 0, new Buf().u32(1).u32(1).u32(1).u32(1).bytes());
  const szB = new Buf().u32(0).u32(s.length);
  for (const x of s) szB.u32(x.size);
  const stsz = fullBox('stsz', 0, 0, szB.bytes());

  const offsets = s.map((x) => at[x.offsetIndex]);
  const big = offsets.some((x) => x > 0xfffffff0);
  const coB = new Buf().u32(offsets.length);
  for (const x of offsets) { if (big) coB.u64(x); else coB.u32(x); }
  const stco = fullBox(big ? 'co64' : 'stco', 0, 0, coB.bytes());

  return box('stbl', ...[stsd, stts, ctts, stss, stsc, stsz, stco].filter(Boolean));
}

function avc1(t) {
  if (!t.description) throw new Error('The encoder never sent its H.264 configuration.');
  const avcC = box('avcC', t.description);
  const body = new Buf()
    .u32(0).u16(0).u16(1)                   // reserved, data ref index
    .u16(0).u16(0).u32(0).u32(0).u32(0)     // predefined / reserved
    .u16(t.width).u16(t.height)
    .u32(0x00480000).u32(0x00480000)        // 72dpi
    .u32(0).u16(1)
    .push(new Uint8Array(32))               // compressor name
    .u16(0x0018).u16(0xffff)                // depth 24, predefined -1
    .bytes();
  return box('avc1', body, avcC);
}

function mp4a(t) {
  const body = new Buf()
    .u32(0).u16(0).u16(1)
    .u32(0).u32(0)
    .u16(t.channels || 2).u16(16).u16(0).u16(0)
    .u32((t.sampleRate || 48000) << 16)
    .bytes();
  return box('mp4a', body, esds(t));
}

// The esds box: an MPEG-4 descriptor tree wrapping the AudioSpecificConfig.
// Every length here is a single byte because our config is a handful of bytes;
// a longer one would need the multi-byte form, which AAC-LC never reaches.
function esds(t) {
  const asc = t.description || new Uint8Array([0x11, 0x90]); // AAC-LC 48k stereo
  const dec = new Buf()
    .u8(0x04).u8(13 + 2 + asc.byteLength)
    .u8(0x40).u8(0x15)                       // MPEG-4 audio, stream type
    .u8(0).u16(0).u32(0).u32(0)              // buffer size, bitrates
    .u8(0x05).u8(asc.byteLength).push(asc)
    .bytes();
  const es = new Buf()
    .u8(0x03).u8(3 + dec.byteLength + 3)
    .u16(1).u8(0)
    .push(dec)
    .u8(0x06).u8(1).u8(0x02)
    .bytes();
  return fullBox('esds', 0, 0, es);
}
