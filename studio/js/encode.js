// EXPORT - turning a project into a file somebody else can watch.
//
// THREE PATHS, chosen by what the browser actually has, never by user-agent
// sniffing:
//
//   mp4  VideoEncoder + our muxer. Faster than real time, exact frame timing,
//        and the only path that can encode a 40-second clip in a few seconds.
//   webm MediaRecorder on a canvas stream. Real time, so a 40s clip takes 40s,
//        but it exists everywhere and it captures audio for free. This is the
//        iPad and older-Safari path.
//   gif  Our own GIF89a writer. Silent, small, loops, and drops into Notion
//        or a text message where a video player is overkill.
//
// EVERY PATH DRAWS THROUGH `composite()`. There is no second renderer, so an
// export cannot look different from the preview - the failure that makes
// telestration tools untrustworthy.
//
// FRAMES COME FROM A SEEK-AND-WAIT LOOP over a plain <video>. It is slower than
// decoding through WebCodecs would be, but it is correct for every container
// the browser can play, and export runs once per video while scrubbing runs
// continuously - so the fast decoder is spent where it is felt.

import { MP4Muxer } from './mp4.js';
import { composite, formatSize } from './render.js';
import { compile, sourceAt, rateAt } from './timemap.js';

export function canMP4() { return typeof VideoEncoder !== 'undefined' && typeof VideoFrame !== 'undefined'; }
export function canAAC() { return typeof AudioEncoder !== 'undefined'; }

export const FPS_CHOICES = [24, 30, 60];

// A bitrate that looks right rather than a number pulled from the air: roughly
// 0.11 bits per pixel per frame, which holds up on the high-motion wide shots
// these clips are made of, then clamped so a square 480 export is not starved
// and a 1080p one is not absurd.
function bitrateFor(w, h, fps) {
  return Math.round(Math.min(16e6, Math.max(1.6e6, w * h * fps * 0.11)));
}

// ---- the frame pump --------------------------------------------------------

// Seek a <video> to `t` and resolve once the picture is really there.
//
// IT RESOLVES ON `seeked`, NOT ON `requestVideoFrameCallback`. rVFC is the
// better signal in principle - it means a frame was PRESENTED - but Studio's
// film element is deliberately offscreen and opacity 0 (the stage is a canvas;
// the element only decodes and holds a position), and a video that is never
// composited never presents a frame, so rVFC never fires. Measured: every
// exported frame waited out the 2000ms safety timeout, three seconds a frame.
// After `seeked` the frame at `currentTime` is decoded and `drawImage` returns
// it, which is all the exporter needs.
//
// AND NOTHING IN THIS LOOP WAITS ON requestAnimationFrame. A backgrounded tab
// stops running rAF callbacks entirely, so an export that waited on one simply
// stopped the moment the user switched tabs - and switching away from a
// minute-long export is the normal thing to do. Timers keep running; rAF does
// not. Every wait here is a timer or an event.
function seekTo(video, t) {
  // ALREADY THERE IS AN IMMEDIATE RETURN, and this is not a micro-optimisation.
  // `requestVideoFrameCallback` fires when a NEW frame is presented, so asking
  // for one on a picture that is not going to change never resolves - it waits
  // out the timeout below. Every frame of a freeze is the same source time, so
  // a 1.2s freeze at 30fps was 36 frames x 2s = 72 seconds of an export doing
  // nothing at all. Half a frame is the threshold because that is the most a
  // seek could move the picture without changing which frame is shown.
  if (Math.abs(video.currentTime - t) < 1 / 120) return Promise.resolve();

  return new Promise((resolve) => {
    let done = false;
    const finish = () => { if (done) return; done = true; cleanup(); resolve(); };
    const onSeeked = () => setTimeout(finish, 0);
    const cleanup = () => { video.removeEventListener('seeked', onSeeked); clearTimeout(timer); };
    // A seek to a time the file cannot resolve must not hang the export. This
    // is a backstop for a broken file, not part of the normal path, so it is
    // short: a seek that has not landed in 700ms is not going to.
    const timer = setTimeout(finish, 700);
    video.addEventListener('seeked', onSeeked, { once: true });
    video.currentTime = t;
  });
}

// ---- MP4 -------------------------------------------------------------------

export async function exportMP4(project, video, opts = {}) {
  const { quality = 'hd', fps = 30, audio = true, signal } = opts;
  const onProgress = opts.onProgress || (() => {});
  const { w, h } = formatSize(project.format?.aspect || '16:9', quality);
  const map = compile(project.timeline || {}, video.duration || 0);
  const total = Math.max(0.04, map.duration);
  const frames = Math.max(1, Math.round(total * fps));

  const canvas = new OffscreenCanvas(w, h);
  const ctx = canvas.getContext('2d', { alpha: false, desynchronized: true });

  const muxer = new MP4Muxer(
    { kind: 'video', width: w, height: h, timescale: fps * 1000 },
    null,
  );

  let encError = null;
  const encoder = new VideoEncoder({
    output: (chunk, meta) => { try { muxer.addVideo(chunk, meta); } catch (e) { encError = e; } },
    error: (e) => { encError = e; },
  });

  // avc1.4d = Main profile, which every phone, every browser and every social
  // platform decodes. High profile buys a little size and loses old Androids.
  const level = h >= 1080 ? '0028' : h >= 720 ? '001f' : '001e';
  const config = {
    codec: `avc1.4d${level}`,
    width: w,
    height: h,
    bitrate: bitrateFor(w, h, fps),
    framerate: fps,
    latencyMode: 'quality',
    avc: { format: 'avc' }, // avcC in the description, not Annex-B in the stream
  };
  const support = await VideoEncoder.isConfigSupported(config).catch(() => null);
  if (!support || !support.supported) throw new Error('This browser cannot encode H.264. Export as WebM instead.');
  encoder.configure(config);

  const wasMuted = video.muted;
  video.pause();
  video.muted = true;

  try {
    for (let i = 0; i < frames; i++) {
      if (signal?.aborted) throw new DOMException('Export cancelled', 'AbortError');
      if (encError) throw encError;
      const outT = (i / fps);
      await seekTo(video, clamp(sourceAt(map, outT), 0, Math.max(0, (video.duration || 0) - 1e-3)));
      composite(ctx, video, video.videoWidth, video.videoHeight, project, outT, { grade: project.grade || 0 });

      const frame = new VideoFrame(canvas, {
        timestamp: Math.round((i / fps) * 1e6),
        duration: Math.round((1 / fps) * 1e6),
      });
      // A keyframe every two seconds: enough for a platform to scrub and
      // transcode cleanly without inflating the file.
      encoder.encode(frame, { keyFrame: i % (fps * 2) === 0 });
      frame.close();

      // Do not let the encoder queue grow without bound - on a long export it
      // is the difference between steady memory and a tab that is killed.
      if (encoder.encodeQueueSize > 12) {
        // eslint-disable-next-line no-await-in-loop
        await new Promise((r) => { const check = () => (encoder.encodeQueueSize <= 4 ? r() : setTimeout(check, 8)); check(); });
      }
      onProgress((i + 1) / frames * (audio ? 0.82 : 0.96), 'Rendering');
    }

    await encoder.flush();
    encoder.close();
    if (encError) throw encError;

    let audioTrack = null;
    if (audio && canAAC()) {
      onProgress(0.86, 'Audio');
      audioTrack = await encodeAudio(opts.media, map, total, signal).catch(() => null);
    }
    if (audioTrack) {
      muxer.audio = audioTrack.track;
      // Appended one at a time, not spread: a two-minute AAC track is ~5600
      // chunks and `push(...arr)` at that length overflows the argument stack.
      const base = muxer.chunks.length;
      for (const c of audioTrack.chunks) muxer.chunks.push(c);
      // Re-point the audio samples at the chunk slots they actually landed in.
      muxer.audio.samples.forEach((s, i) => { s.offsetIndex = base + i; });
    }

    onProgress(0.97, 'Writing');
    const blob = muxer.finish();
    onProgress(1, 'Done');
    return blob;
  } finally {
    try { if (encoder.state !== 'closed') encoder.close(); } catch (_) { /* already closed */ }
    video.muted = wasMuted;
  }
}

// ---- audio, retimed --------------------------------------------------------

// The source audio has to be bent the same way the picture was, or a freeze
// runs the commentary on over a still frame. An OfflineAudioContext rebuilds
// it: plain stretches are copied, a slow-motion ramp is a resampled read, and
// a freeze is SILENCE rather than a held buzz - which is also what broadcast
// does, and it makes the freeze land.
async function encodeAudio(media, map, totalSeconds, signal) {
  // The caller hands us the media: a File when the film was picked locally, a
  // URL otherwise. It is deliberately NOT read off the project - a project
  // stores where its film lives, not a handle to it.
  const src = media;
  if (!src) return null;
  // decodeAudioData needs the WHOLE file, so a two-hour game would be pulled
  // down entirely to lift forty seconds of crowd noise. Above the cap the
  // export is silent and says so, rather than quietly stalling on a download.
  const AUDIO_CAP = 320 * 1024 * 1024;
  if (src instanceof Blob && src.size > AUDIO_CAP) return null;
  let buf;
  if (src instanceof Blob) buf = await src.arrayBuffer();
  else {
    const r = await fetch(src, { signal });
    const len = Number(r.headers.get('Content-Length') || 0);
    if (len > AUDIO_CAP) { try { r.body?.cancel(); } catch (_) { /* fine */ } return null; }
    buf = await r.arrayBuffer();
  }
  const tmp = new (window.AudioContext || window.webkitAudioContext)();
  const decoded = await tmp.decodeAudioData(buf).catch(() => null);
  tmp.close();
  if (!decoded) return null;

  const rate = 48000;
  const ch = Math.min(2, decoded.numberOfChannels);
  const off = new OfflineAudioContext(ch, Math.ceil(totalSeconds * rate), rate);
  for (const sp of map.spans) {
    if (sp.kind === 'hold') continue;                 // a freeze is silent
    const dur = sp.o1 - sp.o0;
    if (dur <= 1e-4) continue;
    const node = off.createBufferSource();
    node.buffer = decoded;
    node.playbackRate.value = Math.max(0.06, sp.rate || 1);
    // A slow ramp gains loudness the way a stretched tape does; pull it back.
    const g = off.createGain();
    g.gain.value = sp.rate < 0.9 ? 0.75 : 1;
    node.connect(g).connect(off.destination);
    node.start(sp.o0, sp.s0, Math.max(0.001, sp.s1 - sp.s0));
  }
  const rendered = await off.startRendering();
  if (signal?.aborted) return null;

  const track = { kind: 'audio', timescale: rate, sampleRate: rate, channels: ch, samples: [], description: null };
  const chunks = [];
  let err = null;
  const enc = new AudioEncoder({
    output: (chunk, meta) => {
      const d = meta?.decoderConfig?.description;
      if (d && !track.description) track.description = new Uint8Array(d);
      const data = new Uint8Array(chunk.byteLength);
      chunk.copyTo(data);
      chunks.push(data);
      track.samples.push({
        offsetIndex: 0,
        size: data.byteLength,
        dts: Math.round((chunk.timestamp / 1e6) * rate),
        cts: Math.round((chunk.timestamp / 1e6) * rate),
        dur: Math.max(1, Math.round(((chunk.duration || 0) / 1e6) * rate)),
        key: true,
      });
    },
    error: (e) => { err = e; },
  });
  const acfg = { codec: 'mp4a.40.2', sampleRate: rate, numberOfChannels: ch, bitrate: 128000 };
  const ok = await AudioEncoder.isConfigSupported(acfg).catch(() => null);
  if (!ok || !ok.supported) return null;
  enc.configure(acfg);

  const BLOCK = 4096;
  const planes = [];
  for (let c = 0; c < ch; c++) planes.push(rendered.getChannelData(c));
  for (let i = 0; i < rendered.length; i += BLOCK) {
    const n = Math.min(BLOCK, rendered.length - i);
    // AudioData wants interleaved f32 for 'f32' format when planes > 1 is not
    // used; interleaving here keeps one code path for mono and stereo.
    const inter = new Float32Array(n * ch);
    for (let s = 0; s < n; s++) for (let c = 0; c < ch; c++) inter[s * ch + c] = planes[c][i + s];
    const ad = new AudioData({
      format: 'f32', sampleRate: rate, numberOfFrames: n, numberOfChannels: ch,
      timestamp: Math.round((i / rate) * 1e6), data: inter,
    });
    enc.encode(ad);
    ad.close();
  }
  await enc.flush();
  enc.close();
  if (err || !track.samples.length) return null;
  return { track, samples: [], chunks };
}

// ---- WebM (the everywhere path) --------------------------------------------

// MediaRecorder records in REAL TIME, so this plays the project through once
// while capturing the canvas. Slower, but it needs no WebCodecs and it takes
// the audio straight off the video element, so it is the honest fallback
// rather than a degraded one.
export async function exportRecorded(project, video, opts = {}) {
  const { quality = 'hd', fps = 30, audio = true, signal } = opts;
  const onProgress = opts.onProgress || (() => {});
  const { w, h } = formatSize(project.format?.aspect || '16:9', quality);
  const map = compile(project.timeline || {}, video.duration || 0);
  const total = Math.max(0.1, map.duration);

  const canvas = document.createElement('canvas');
  canvas.width = w; canvas.height = h;
  const ctx = canvas.getContext('2d', { alpha: false });

  const stream = canvas.captureStream(fps);
  let actx = null;
  if (audio) {
    try {
      actx = new (window.AudioContext || window.webkitAudioContext)();
      const src = actx.createMediaElementSource(video);
      const dest = actx.createMediaStreamDestination();
      src.connect(dest);
      src.connect(actx.destination);
      for (const t of dest.stream.getAudioTracks()) stream.addTrack(t);
    } catch (_) { /* no audio route; record the picture */ }
  }

  const mime = ['video/mp4;codecs=avc1', 'video/webm;codecs=vp9', 'video/webm;codecs=vp8', 'video/webm']
    .find((m) => MediaRecorder.isTypeSupported(m));
  if (!mime) throw new Error('This browser cannot record video.');

  const rec = new MediaRecorder(stream, { mimeType: mime, videoBitsPerSecond: bitrateFor(w, h, fps) });
  const parts = [];
  rec.ondataavailable = (e) => { if (e.data.size) parts.push(e.data); };
  const done = new Promise((res) => { rec.onstop = res; });

  video.muted = !audio;
  rec.start(200);

  const t0 = performance.now();
  let raf = 0;
  await new Promise((resolve) => {
    const step = async () => {
      const outT = (performance.now() - t0) / 1000;
      if (signal?.aborted || outT >= total) { resolve(); return; }
      const want = sourceAt(map, outT);
      const r = rateAt(map, outT);
      // Let the element run at the right speed rather than seeking every frame:
      // a seek-per-frame in real time is what makes recorded exports stutter.
      if (r === 0) { if (!video.paused) video.pause(); video.currentTime = want; }
      else {
        if (video.paused) await video.play().catch(() => {});
        video.playbackRate = Math.max(0.0625, Math.min(4, r));
        if (Math.abs(video.currentTime - want) > 0.22) video.currentTime = want;
      }
      composite(ctx, video, video.videoWidth, video.videoHeight, project, outT, { grade: project.grade || 0 });
      onProgress(Math.min(0.98, outT / total), 'Recording');
      raf = requestAnimationFrame(step);
    };
    raf = requestAnimationFrame(step);
  });

  cancelAnimationFrame(raf);
  video.pause();
  video.playbackRate = 1;
  rec.stop();
  await done;
  try { actx?.close(); } catch (_) { /* closing a closed context is fine */ }
  onProgress(1, 'Done');
  return new Blob(parts, { type: mime.split(';')[0] });
}

// ---- GIF -------------------------------------------------------------------

// A GIF89a writer. The palette is built by median cut over a handful of sampled
// frames rather than per frame, because a per-frame palette makes the colours
// crawl - and on white ice with one red arrow, crawl is all you see.
export async function exportGIF(project, video, opts = {}) {
  const { quality = 'sd', fps = 12, signal } = opts;
  const onProgress = opts.onProgress || (() => {});
  const size = formatSize(project.format?.aspect || '16:9', quality);
  // GIF is indexed colour and gets large fast; cap the long edge.
  const cap = opts.maxEdge || 480;
  const k = Math.min(1, cap / Math.max(size.w, size.h));
  const w = Math.max(2, Math.round(size.w * k / 2) * 2);
  const h = Math.max(2, Math.round(size.h * k / 2) * 2);

  const map = compile(project.timeline || {}, video.duration || 0);
  const total = Math.max(0.1, map.duration);
  const frames = Math.max(1, Math.min(400, Math.round(total * fps)));
  const delay = Math.max(2, Math.round(100 / fps)); // GIF delay is 1/100 s

  const canvas = document.createElement('canvas');
  canvas.width = w; canvas.height = h;
  const ctx = canvas.getContext('2d', { alpha: false, willReadFrequently: true });

  const shots = [];
  video.pause();
  for (let i = 0; i < frames; i++) {
    if (signal?.aborted) throw new DOMException('Export cancelled', 'AbortError');
    const outT = i / fps;
    await seekTo(video, clamp(sourceAt(map, outT), 0, Math.max(0, (video.duration || 0) - 1e-3)));
    composite(ctx, video, video.videoWidth, video.videoHeight, project, outT, { grade: project.grade || 0 });
    shots.push(ctx.getImageData(0, 0, w, h).data);
    onProgress((i / frames) * 0.7, 'Rendering');
  }

  onProgress(0.72, 'Colours');
  const palette = medianCut(shots, 256);
  const lookup = new Map();
  const bytes = [];
  writeGifHeader(bytes, w, h, palette);
  for (let i = 0; i < shots.length; i++) {
    if (signal?.aborted) throw new DOMException('Export cancelled', 'AbortError');
    const idx = quantize(shots[i], palette, lookup);
    writeGifFrame(bytes, w, h, idx, delay);
    onProgress(0.72 + (i / shots.length) * 0.26, 'Packing');
    if (i % 12 === 0) await new Promise((r) => setTimeout(r, 0)); // keep the tab alive
  }
  bytes.push(0x3b);
  onProgress(1, 'Done');
  return new Blob([new Uint8Array(bytes)], { type: 'image/gif' });
}

function medianCut(shots, want) {
  // Sample rather than read every pixel of every frame: a few thousand points
  // describe a hockey frame's colour distribution perfectly well.
  const pts = [];
  const stride = Math.max(4, Math.floor((shots[0].length / 4) / 3000)) * 4;
  for (const s of shots) for (let i = 0; i < s.length; i += stride) pts.push([s[i], s[i + 1], s[i + 2]]);
  let boxes = [pts];
  while (boxes.length < want) {
    boxes.sort((a, b) => spread(b) - spread(a));
    const big = boxes.shift();
    if (!big || big.length < 2 || spread(big) === 0) { if (big) boxes.push(big); break; }
    const ch = widestChannel(big);
    big.sort((a, b) => a[ch] - b[ch]);
    const mid = big.length >> 1;
    boxes.push(big.slice(0, mid), big.slice(mid));
  }
  return boxes.map((b) => {
    const n = b.length || 1;
    let r = 0; let g = 0; let bl = 0;
    for (const p of b) { r += p[0]; g += p[1]; bl += p[2]; }
    return [Math.round(r / n), Math.round(g / n), Math.round(bl / n)];
  });
}
function widestChannel(b) {
  let best = 0; let bestSpan = -1;
  for (let c = 0; c < 3; c++) {
    let lo = 255; let hi = 0;
    for (const p of b) { if (p[c] < lo) lo = p[c]; if (p[c] > hi) hi = p[c]; }
    if (hi - lo > bestSpan) { bestSpan = hi - lo; best = c; }
  }
  return best;
}
function spread(b) {
  let lo = [255, 255, 255]; let hi = [0, 0, 0];
  for (const p of b) for (let c = 0; c < 3; c++) { if (p[c] < lo[c]) lo[c] = p[c]; if (p[c] > hi[c]) hi[c] = p[c]; }
  return (hi[0] - lo[0]) + (hi[1] - lo[1]) + (hi[2] - lo[2]);
}
function quantize(data, palette, cache) {
  const out = new Uint8Array(data.length / 4);
  for (let i = 0, p = 0; i < data.length; i += 4, p++) {
    // 5 bits per channel is a fine cache key: it collapses the search by ~30x
    // and the error is below what an indexed GIF could show anyway.
    const key = ((data[i] >> 3) << 10) | ((data[i + 1] >> 3) << 5) | (data[i + 2] >> 3);
    let hit = cache.get(key);
    if (hit === undefined) {
      let best = 0; let bd = Infinity;
      for (let k = 0; k < palette.length; k++) {
        const dr = data[i] - palette[k][0]; const dg = data[i + 1] - palette[k][1]; const db = data[i + 2] - palette[k][2];
        const d = dr * dr * 0.3 + dg * dg * 0.59 + db * db * 0.11; // luma-weighted
        if (d < bd) { bd = d; best = k; }
      }
      hit = best; cache.set(key, hit);
    }
    out[p] = hit;
  }
  return out;
}

function writeGifHeader(out, w, h, palette) {
  for (const c of 'GIF89a') out.push(c.charCodeAt(0));
  out.push(w & 255, w >> 8, h & 255, h >> 8);
  const bits = Math.max(1, Math.ceil(Math.log2(Math.max(2, palette.length))));
  const size = 1 << bits;
  out.push(0x80 | ((bits - 1) & 7), 0, 0);
  for (let i = 0; i < size; i++) {
    const c = palette[i] || [0, 0, 0];
    out.push(c[0], c[1], c[2]);
  }
  // NETSCAPE2.0: loop forever. Without it a GIF plays once, which is not what
  // anyone means by a looping clip.
  out.push(0x21, 0xff, 11);
  for (const c of 'NETSCAPE2.0') out.push(c.charCodeAt(0));
  out.push(3, 1, 0, 0, 0);
}

function writeGifFrame(out, w, h, idx, delay) {
  out.push(0x21, 0xf9, 4, 0, delay & 255, delay >> 8, 0, 0);
  out.push(0x2c, 0, 0, 0, 0, w & 255, w >> 8, h & 255, h >> 8, 0);
  lzw(out, idx, 8);
}

// LZW as GIF specifies it: variable code width, a clear code at the start and
// whenever the table fills, and the output packed LSB-first into 255-byte
// sub-blocks.
function lzw(out, data, minCode) {
  const clear = 1 << minCode;
  const eoi = clear + 1;
  out.push(minCode);

  let dict = new Map();
  let width = minCode + 1;
  let next = eoi + 1;
  const reset = () => { dict = new Map(); width = minCode + 1; next = eoi + 1; };

  let acc = 0; let bits = 0;
  const block = [];
  const flush = () => {
    while (block.length) {
      const n = Math.min(255, block.length);
      out.push(n);
      for (let i = 0; i < n; i++) out.push(block[i]);
      block.splice(0, n);
    }
  };
  const emit = (code) => {
    acc |= code << bits;
    bits += width;
    while (bits >= 8) { block.push(acc & 255); acc >>= 8; bits -= 8; if (block.length >= 255) flush(); }
  };

  emit(clear);
  let prev = data[0];
  for (let i = 1; i < data.length; i++) {
    const c = data[i];
    const key = prev * 4096 + c;
    const found = dict.get(key);
    if (found !== undefined) { prev = found; continue; }
    emit(prev);
    dict.set(key, next);
    next++;
    if (next > (1 << width)) {
      if (width < 12) width++;
      else { emit(clear); reset(); }
    }
    prev = c;
  }
  emit(prev);
  emit(eoi);
  if (bits > 0) { block.push(acc & 255); if (block.length >= 255) flush(); }
  flush();
  out.push(0);
}

// ---- poster ----------------------------------------------------------------

// A single frame as a PNG - the thumbnail for a Notion card, the still for a
// slide, the image that goes in a text message.
export async function exportFrame(project, video, outT, opts = {}) {
  const { quality = 'fhd' } = opts;
  const { w, h } = formatSize(project.format?.aspect || '16:9', quality);
  const canvas = document.createElement('canvas');
  canvas.width = w; canvas.height = h;
  const ctx = canvas.getContext('2d', { alpha: false });
  video.pause();
  await seekTo(video, clamp(sourceAt(compile(project.timeline || {}, video.duration || 0), outT), 0, video.duration || 0));
  composite(ctx, video, video.videoWidth, video.videoHeight, project, outT, { grade: project.grade || 0 });
  return new Promise((res) => canvas.toBlob(res, 'image/png'));
}

const clamp = (v, lo, hi) => (v < lo ? lo : v > hi ? hi : v);
