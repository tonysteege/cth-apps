// CTH Clips exports: Freeze, Pull and Record.
//
// Three rules from Tony's spec run through all of it (2026-08-27):
//
//  - A FILE LANDS BESIDE ITS SOURCE. Exports used to go to /videos/exports;
//    they now go into the folder the source video itself lives in, which is
//    where anyone looking for them would look first.
//  - EXPORTING IS SILENT. No progress bar, no sheet, no "done" toast. The
//    file simply appears. Only a FAILURE says anything, because a failure is
//    the only outcome you cannot see for yourself.
//  - THE NAME CARRIES THE MEANING: clip name, its tags in log order, its
//    timecode. The pattern is Tony's to change in Settings.
//
// EVERYTHING IS COMPOSITED THROUGH A CANVAS rather than captured off the
// video element. That is what lets an annotation appear in the file at all -
// `video.captureStream()` gives you the picture and nothing drawn over it.
// The canvas is sized to the video's own pixels so the export looks like the
// file, which is the same rule the scrub engine had to learn.

import { fsConnected, fsWrite, fsLabel } from './localfs.js';
import { toast } from './ui.js';

const pad2 = (n) => String(n).padStart(2, '0');

export function hhmmss(t) {
  const s = Math.max(0, Math.floor(t || 0));
  return `${pad2(Math.floor(s / 3600))}${pad2(Math.floor((s % 3600) / 60))}${pad2(s % 60)}`;
}

// Anything a file system will not take, plus runs of dashes.
const safe = (s) => String(s || '')
  .trim()
  .replace(/[\\/:*?"<>|]+/g, '')
  .replace(/\s+/g, '-')
  .replace(/-{2,}/g, '-')
  .replace(/^-|-$/g, '');

// The name pattern, filled in. An empty token collapses without leaving the
// dash that joined it, so a clip with no tags is "Goal-001240", not
// "Goal--001240".
export function fileStem(pattern, { name, tags, t, label, suffix = '' }) {
  const map = {
    '{name}': safe(name || label || 'clip'),
    '{tags}': (tags || []).map(safe).filter(Boolean).join('-'),
    '{hhmmss}': hhmmss(t),
    '{label}': safe(label || ''),
    '{date}': new Date().toISOString().slice(0, 10),
  };
  let out = String(pattern || '{name}-{tags}-{hhmmss}');
  for (const [k, v] of Object.entries(map)) out = out.split(k).join(v);
  out = out.replace(/-{2,}/g, '-').replace(/^-|-$/g, '');
  return (out || 'clip') + suffix;
}

// The folder the source video lives in - not an exports bin.
export function sourceFolder(game) {
  const p = String(game?.path || '');
  if (!p.includes('/')) return null;
  return p.slice(0, p.lastIndexOf('/')) || '/videos';
}

// Silent on success, loud only on failure - and the failure says WHERE it
// was trying to write, because "export failed" alone is not actionable.
export async function deliver(game, blob, filename) {
  const dir = sourceFolder(game);
  if (game.source !== 'local' && dir && fsConnected()) {
    try {
      await fsWrite(`${dir}/${filename}`, blob);
      return { ok: true, where: `${fsLabel(dir)}/${filename}` };
    } catch (e) {
      console.error(e);
      toast(`Could Not Write ${filename} To ${fsLabel(dir)} - ${e.message || 'Check The Folder'}`, true);
      return { ok: false };
    }
  }
  // A one-off file picked from the disk has no folder to write back into.
  try {
    const a = document.createElement('a');
    a.href = URL.createObjectURL(blob);
    a.download = filename;
    a.click();
    setTimeout(() => URL.revokeObjectURL(a.href), 10_000);
    return { ok: true, where: 'Downloads' };
  } catch (e) {
    toast(`Could Not Save ${filename}`, true);
    return { ok: false };
  }
}

function pickMime() {
  return ['video/mp4;codecs=avc1', 'video/mp4', 'video/webm;codecs=vp9', 'video/webm']
    .find((m) => MediaRecorder.isTypeSupported(m)) || 'video/webm';
}

// ------------------------------------------------------------- the recorder
//
// One engine behind all three exports. It runs the video in real time and
// paints every frame into a canvas, so whatever `paint` adds - annotations,
// a cursor ring - is IN the file. `hold` freezes the clock at `holdAt` for a
// stretch, which is the whole point of a Freeze export.

export async function recordRange(video, {
  from, to, holdAt = null, hold = 0, crop = null,
  paint = null, audio = 'video', mic = null, onFrame = null,
  filter = null, scale = 1, bitrate = 12_000_000,
} = {}) {
  if (!video.captureStream) throw new Error('This Browser Cannot Record - Use Chrome');

  const vw = video.videoWidth || 1280;
  const vh = video.videoHeight || 720;
  const c = crop || { x: 0, y: 0, w: 1, h: 1 };
  // `scale` shrinks the output frame, which is the only compression lever
  // that actually changes what the encoder is given rather than how hard it
  // squeezes. Bitrate does the rest.
  const cw = Math.max(2, Math.round(vw * c.w * scale));
  const ch = Math.max(2, Math.round(vh * c.h * scale));
  const cv = document.createElement('canvas');
  // Even dimensions: some H.264 encoders refuse an odd one.
  cv.width = cw - (cw % 2);
  cv.height = ch - (ch % 2);
  const ctx = cv.getContext('2d', { alpha: false });

  const stream = cv.captureStream(30);
  // Audio comes from the file for a clip, from the microphone for a
  // recording, and both are optional.
  const srcStream = audio === 'video' ? video.captureStream?.() : null;
  for (const t of srcStream?.getAudioTracks() || []) stream.addTrack(t);
  for (const t of mic?.getAudioTracks() || []) stream.addTrack(t);

  const mime = pickMime();
  const rec = new MediaRecorder(stream, { mimeType: mime, videoBitsPerSecond: bitrate });
  const parts = [];
  rec.ondataavailable = (e) => { if (e.data.size) parts.push(e.data); };

  const sx = c.x * vw;
  const sy = c.y * vh;
  const sw = c.w * vw;
  const sh = c.h * vh;
  let stop = false;
  let frozenUntil = 0;

  const drawFrame = () => {
    // The colour filter has to be set BEFORE the frame is drawn - it applies
    // to the draw, not to what is already on the canvas - and cleared after,
    // or every overlay `paint` adds would be filtered too.
    if (filter) ctx.filter = filter;
    ctx.drawImage(video, sx, sy, sw, sh, 0, 0, cv.width, cv.height);
    ctx.filter = 'none';
    paint?.(ctx, cv, { sx, sy, sw, sh });
  };

  if (from != null) {
    video.currentTime = Math.max(0, from);
    await new Promise((res) => {
      const done = () => { video.removeEventListener('seeked', done); res(); };
      video.addEventListener('seeked', done);
      setTimeout(done, 2000);
    });
  }

  rec.start(400);
  await video.play().catch(() => {});

  // A timer, not rAF: a background tab stops painting with rAF and the
  // export would silently come out short. This is the same lesson the
  // preview harness taught.
  await new Promise((res) => {
    const tick = () => {
      if (stop) return res();
      const now = performance.now();
      if (frozenUntil && now < frozenUntil) {
        drawFrame();
        onFrame?.(video.currentTime);
        setTimeout(tick, 33);
        return;
      }
      if (frozenUntil && now >= frozenUntil) {
        frozenUntil = 0;
        void video.play().catch(() => {});
      }
      if (holdAt != null && !frozenUntil && video.currentTime >= holdAt) {
        holdAt = null;
        video.pause();
        frozenUntil = now + hold * 1000;
        drawFrame();
        setTimeout(tick, 33);
        return;
      }
      drawFrame();
      onFrame?.(video.currentTime);
      if (to != null && video.currentTime >= to) return res();
      if (video.ended) return res();
      setTimeout(tick, 33);
    };
    tick();
  });

  video.pause();
  rec.stop();
  await new Promise((res) => { rec.onstop = res; });
  for (const t of srcStream?.getTracks() || []) t.stop();
  return { blob: new Blob(parts, { type: mime }), ext: mime.includes('mp4') ? 'mp4' : 'webm' };
}

// ------------------------------------------------------------- crop presets

// Record captures a REGION OF THE VIDEO, not of the desktop. That is a
// deliberate reading of the spec and it is the better one here: compositing
// from the video means the cursor ring and every annotation are already in
// the frame, the toolbar can never be, no screen-picker interrupts the take,
// and the region can be remembered across sessions - none of which a
// getDisplayMedia grab of the whole screen can do.
export const CROP_PRESETS = [
  ['Full Frame', { x: 0, y: 0, w: 1, h: 1 }],
  ['Left Half', { x: 0, y: 0, w: 0.5, h: 1 }],
  ['Right Half', { x: 0.5, y: 0, w: 0.5, h: 1 }],
  ['Middle', { x: 0.25, y: 0.08, w: 0.5, h: 0.84 }],
  ['Top Half', { x: 0, y: 0, w: 1, h: 0.5 }],
  ['Bottom Half', { x: 0, y: 0.5, w: 1, h: 0.5 }],
];

export async function openMic() {
  try {
    return await navigator.mediaDevices.getUserMedia({ audio: true });
  } catch (e) {
    toast('No Microphone - Recording Without Your Voice', true);
    return null;
  }
}
