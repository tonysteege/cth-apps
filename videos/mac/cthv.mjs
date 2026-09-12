#!/usr/bin/env node
// cthv - CTH Videos from the Mac.
//
// WHY THIS EXISTS. The browser uploader is bounded by the home upstream (a
// few Mbps) and by what a browser can do to a file before sending it, which
// is nothing. This tool runs on the Mac, so it can (1) shrink a game with the
// hardware HEVC encoder in about a sixth of real time and (2) send the result
// through the same Worker API with more parts in flight, one game after
// another, while the next one is already encoding. Measured 2026-09-12 on a
// 1080p30 game at 3.8 Mbps H.264: hevc_videotoolbox q50 came out 2.5x smaller
// with no visible difference on a frame-by-frame crop; q40 was 3.7x smaller
// and very slightly softer. "Fast" is q50. "Original" sends the bytes as-is.
//
// USAGE
//   cthv upload [--original] [--fast] [--name "Title"] <file>...
//   cthv watch               process the drop folder once (launchd runs this)
//   cthv install             set up the drop folder, the launch agent, `cthv`
//   cthv list                the library
//
// THE DROP FOLDER is ~/Videos/CTH Videos. Anything dropped at its top level
// is shrunk and uploaded; anything dropped in its Original/ subfolder goes up
// untouched. Finished files move to Uploaded/ and every share link is written
// to Uploaded/links.txt (and copied to the clipboard). The launch agent fires
// on any change to the folder and this script waits until a file has stopped
// growing before it touches it, so a copy still in progress is left alone.
//
// No dependencies: Node 18+ (fetch), ffmpeg and ffprobe on the PATH, the key
// in the macOS Keychain under `cth-videos-key`.

import { spawn, execFileSync } from 'node:child_process';
import { promises as fs, createWriteStream, existsSync, statSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const API = 'https://apps-api.coachtonyhockey.com';
const WATCH_URL = 'https://apps.coachtonyhockey.com/videos/watch.html?v=';
const APP_URL = 'https://apps.coachtonyhockey.com/videos/#/v/';
const HOME = os.homedir();
const DROP = path.join(HOME, 'Videos', 'CTH Videos');
const DROP_ORIGINAL = path.join(DROP, 'Original');
const DROP_DONE = path.join(DROP, 'Uploaded');
const DROP_FAILED = path.join(DROP, 'Failed');
const CACHE = path.join(HOME, 'Library', 'Caches', 'cth-videos');
const LOG = path.join(HOME, 'Library', 'Logs', 'cth-videos.log');
const LOCK = path.join(CACHE, 'watch.lock');
const AGENT = path.join(HOME, 'Library', 'LaunchAgents', 'com.coachtonyhockey.videos-drop.plist');
const PARALLEL = 4;
const FAST_Q = 50;             // hevc_videotoolbox constant quality, 1..100
const VIDEO_EXT = /\.(mp4|mov|m4v|mkv|webm|avi|mts|m2ts)$/i;

const log = (...a) => {
  const line = `${new Date().toISOString()} ${a.join(' ')}`;
  console.log(...a);
  try { fs.appendFile(LOG, `${line}\n`).catch(() => {}); } catch (_) { /* fine */ }
};
const fail = (msg) => { console.error(msg); process.exit(1); };
const fmtBytes = (n) => (n >= 1e9 ? `${(n / 1e9).toFixed(2)} GB` : n >= 1e6 ? `${Math.round(n / 1e6)} MB` : `${Math.round(n / 1e3)} KB`);
const fmtDur = (s) => { s = Math.round(s); return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, '0')}`; };

// ---- the key ---------------------------------------------------------------

function readKey() {
  if (process.env.CTH_VIDEOS_KEY) return process.env.CTH_VIDEOS_KEY;
  try { return execFileSync('security', ['find-generic-password', '-s', 'cth-videos-key', '-w'], { encoding: 'utf8' }).trim(); }
  catch (_) { return ''; }
}
const KEY = readKey();

async function api(p, { method = 'GET', body, headers = {} } = {}) {
  const h = { 'X-CTH-Key': KEY, ...headers };
  if (body != null && !(body instanceof Uint8Array) && typeof body !== 'string') { h['Content-Type'] = 'application/json'; body = JSON.stringify(body); }
  const r = await fetch(`${API}${p}`, { method, headers: h, body });
  let j = null;
  try { j = await r.json(); } catch (_) { j = null; }
  if (!r.ok) throw Object.assign(new Error(j?.message || `${method} ${p} failed (${r.status})`), { status: r.status });
  return j;
}

// ---- ffmpeg helpers ---------------------------------------------------------

function run(cmd, args, { onLine } = {}) {
  return new Promise((resolve, reject) => {
    const p = spawn(cmd, args, { stdio: ['ignore', 'pipe', 'pipe'] });
    let out = ''; let err = '';
    p.stdout.on('data', (d) => { out += d; });
    p.stderr.on('data', (d) => { err += d; if (onLine) onLine(String(d)); });
    p.on('error', reject);
    p.on('close', (code) => (code === 0 ? resolve(out) : reject(new Error(`${cmd} exited ${code}: ${err.slice(-400)}`))));
  });
}

async function probe(file) {
  const j = JSON.parse(await run('ffprobe', ['-v', 'error', '-show_entries', 'format=duration,size,bit_rate', '-show_streams', '-of', 'json', file]));
  const v = (j.streams || []).find((s) => s.codec_type === 'video') || {};
  return {
    duration: Number(j.format?.duration || 0),
    size: Number(j.format?.size || 0),
    bitrate: Number(j.format?.bit_rate || 0),
    width: Number(v.width || 0),
    height: Number(v.height || 0),
    codec: v.codec_name || '',
    fps: (() => { const [a, b] = String(v.r_frame_rate || '30/1').split('/'); return Number(a) / Number(b || 1); })(),
  };
}

async function poster(file, duration) {
  const at = Math.max(0.5, Math.min(duration * 0.1, Math.max(0, duration - 0.1)));
  const out = path.join(CACHE, `poster-${process.pid}-${Date.now()}.jpg`);
  await run('ffmpeg', ['-y', '-loglevel', 'error', '-ss', String(at), '-i', file, '-frames:v', '1', '-vf', 'scale=640:-2', '-q:v', '4', out]);
  const buf = await fs.readFile(out);
  await fs.unlink(out).catch(() => {});
  return buf;
}

// Shrink with the hardware HEVC encoder. Audio is copied, not re-encoded.
// `-tag:v hvc1` is what makes Safari and QuickTime recognise the file.
async function compress(file, info, onProgress) {
  await fs.mkdir(CACHE, { recursive: true });
  const out = path.join(CACHE, `${path.basename(file, path.extname(file))}.fast.mp4`);
  const total = info.duration || 0;
  await run('ffmpeg', ['-y', '-loglevel', 'error', '-stats', '-i', file,
    '-c:v', 'hevc_videotoolbox', '-q:v', String(FAST_Q), '-tag:v', 'hvc1', '-pix_fmt', 'yuv420p',
    '-c:a', 'copy', '-movflags', '+faststart', out], {
    onLine: (s) => {
      const m = /time=(\d+):(\d+):(\d+\.?\d*)/.exec(s);
      if (m && total && onProgress) onProgress(Math.min(1, (Number(m[1]) * 3600 + Number(m[2]) * 60 + Number(m[3])) / total));
    },
  });
  return out;
}

// ---- the upload -------------------------------------------------------------

async function uploadFile(file, { name, onProgress = () => {}, info }) {
  info = info || await probe(file);
  const size = statSync(file).size;
  const fileName = path.basename(file);
  const start = await api('/videos', {
    method: 'POST',
    body: { name: name || fileName.replace(/\.[a-z0-9]+$/i, '').replace(/\.fast$/, ''), fileName: fileName.replace('.fast.mp4', '.mp4'), type: 'video/mp4',
      size, duration: info.duration, width: info.width, height: info.height, codec: info.codec },
  });
  const { id, uploadId, partSize } = start;
  const total = Math.ceil(size / partSize);
  const parts = [];
  let sent = 0;
  let next = 0;
  let failed = null;
  const fh = await fs.open(file, 'r');
  async function worker() {
    while (next < total && !failed) {
      const n = next++;
      const offset = n * partSize;
      const len = Math.min(partSize, size - offset);
      const buf = Buffer.alloc(len);
      await fh.read(buf, 0, len, offset);
      let tries = 0;
      for (;;) {
        try {
          const r = await api(`/videos/${id}/part/${n + 1}?uploadId=${encodeURIComponent(uploadId)}`, { method: 'PUT', body: buf, headers: { 'Content-Type': 'application/octet-stream' } });
          parts.push({ n: n + 1, etag: r.etag });
          sent += len; onProgress(sent / size);
          break;
        } catch (e) {
          if (++tries >= 5 || (e.status && e.status < 500 && e.status !== 0)) { failed = e; return; }
          await new Promise((res) => setTimeout(res, 1500 * tries));
        }
      }
    }
  }
  try {
    await Promise.all(Array.from({ length: PARALLEL }, worker));
  } finally { await fh.close(); }
  if (failed) { await api(`/videos/${id}`, { method: 'DELETE' }).catch(() => {}); throw failed; }
  const done = await api(`/videos/${id}/complete`, { method: 'POST', body: { uploadId, parts, duration: info.duration, width: info.width, height: info.height } });
  try {
    const jpg = await poster(file, info.duration);
    await api(`/videos/${id}/poster`, { method: 'PUT', body: new Uint8Array(jpg), headers: { 'Content-Type': 'image/jpeg' } });
  } catch (_) { /* a poster is a bonus */ }
  return done.video;
}

// One file, start to finish: decide whether to shrink, shrink, upload.
async function processFile(file, { original = false, name = '' } = {}, prep = null) {
  const info = await probe(file);
  const base = path.basename(file);
  // Already HEVC, or already small for its size, is not worth re-encoding.
  const alreadyLean = info.codec === 'hevc' || (info.width <= 1920 && info.bitrate && info.bitrate < 2.2e6);
  let toSend = file;
  let tmp = null;
  if (!original && !alreadyLean) {
    const t0 = Date.now();
    tmp = prep ? await prep : await compress(file, info, (f) => bar(`Shrinking ${base}`, f));
    const after = statSync(tmp).size;
    log(`shrunk ${base}: ${fmtBytes(info.size)} -> ${fmtBytes(after)} (${(info.size / after).toFixed(1)}x) in ${Math.round((Date.now() - t0) / 1000)}s`);
    toSend = tmp;
  } else if (!original) {
    log(`${base}: already lean (${info.codec}, ${Math.round(info.bitrate / 1e3)} kbps), sending as-is`);
  }
  const sendInfo = toSend === file ? info : await probe(toSend);
  const t1 = Date.now();
  const v = await uploadFile(toSend, { name: name || base.replace(/\.[a-z0-9]+$/i, ''), info: sendInfo, onProgress: (f) => bar(`Uploading ${base}`, f) });
  process.stdout.write('\n');
  const secs = Math.round((Date.now() - t1) / 1000);
  log(`uploaded ${base}: ${fmtBytes(sendInfo.size)} in ${fmtDur(secs)} (${Math.round(sendInfo.size * 8 / 1e6 / Math.max(1, secs))} Mbps) -> ${WATCH_URL}${v.id}`);
  if (tmp) await fs.unlink(tmp).catch(() => {});
  return v;
}

let lastBar = '';
function bar(label, f) {
  if (!process.stdout.isTTY) return;
  const w = 28; const n = Math.round(f * w);
  const s = `\r${label.slice(0, 48).padEnd(48)} [${'#'.repeat(n)}${'-'.repeat(w - n)}] ${String(Math.round(f * 100)).padStart(3)}%`;
  if (s !== lastBar) { process.stdout.write(s); lastBar = s; }
}

// Several files: the next one shrinks while the current one uploads, so the
// encoder and the network are both busy the whole time.
async function processMany(files, opts) {
  const results = [];
  const mk = (f) => (opts.original ? null : probe(f).then((i) => ((i.codec === 'hevc' || (i.width <= 1920 && i.bitrate && i.bitrate < 2.2e6)) ? null : compress(f, i, () => {}))));
  let prep = files.length ? mk(files[0]) : null;
  for (let i = 0; i < files.length; i++) {
    const f = files[i];
    const thisPrep = prep;
    prep = files[i + 1] ? mk(files[i + 1]) : null;
    try {
      const resolved = thisPrep ? await thisPrep : null;
      const v = await processFile(f, opts, resolved ? Promise.resolve(resolved) : null);
      results.push({ file: f, video: v });
    } catch (e) {
      log(`FAILED ${path.basename(f)}: ${e.message}`);
      results.push({ file: f, error: e });
    }
  }
  return results;
}

// ---- the drop folder ----------------------------------------------------------

async function settled(file) {
  // A file still being copied grows; wait until two reads 3 s apart agree.
  let a = statSync(file).size;
  for (let i = 0; i < 400; i++) {
    await new Promise((r) => setTimeout(r, 3000));
    const b = statSync(file).size;
    if (a === b && b > 0) return true;
    a = b;
  }
  return false;
}

async function listDrop() {
  const pick = async (dir, original) => {
    let names = [];
    try { names = await fs.readdir(dir); } catch (_) { return []; }
    return names.filter((n) => !n.startsWith('.') && VIDEO_EXT.test(n)).sort().map((n) => ({ file: path.join(dir, n), original }));
  };
  return [...await pick(DROP, false), ...await pick(DROP_ORIGINAL, true)];
}

async function notify(title, text) {
  try { execFileSync('osascript', ['-e', `display notification ${JSON.stringify(text)} with title ${JSON.stringify(title)}`]); } catch (_) { /* fine */ }
}
function clip(text) {
  try { const p = spawn('pbcopy'); p.stdin.end(text); } catch (_) { /* fine */ }
}

async function watchOnce() {
  await fs.mkdir(CACHE, { recursive: true });
  // One runner at a time: launchd fires on every change, including our own moves.
  try {
    const st = statSync(LOCK);
    if (Date.now() - st.mtimeMs < 6 * 3600 * 1000) { process.exit(0); }
  } catch (_) { /* no lock */ }
  await fs.writeFile(LOCK, String(process.pid));
  try {
    for (;;) {
      const items = await listDrop();
      if (!items.length) break;
      const it = items[0];
      const base = path.basename(it.file);
      if (!await settled(it.file)) { log(`${base} kept changing; giving up on it for now`); break; }
      log(`drop: ${base}${it.original ? ' (original)' : ''}`);
      try {
        const v = await processFile(it.file, { original: it.original });
        await fs.mkdir(DROP_DONE, { recursive: true });
        await fs.rename(it.file, path.join(DROP_DONE, base)).catch(() => {});
        const link = `${WATCH_URL}${v.id}`;
        await fs.appendFile(path.join(DROP_DONE, 'links.txt'), `${new Date().toLocaleString()}  ${v.name}\n  share:  ${link}\n  open:   ${APP_URL}${v.id}\n\n`);
        clip(link);
        await notify('CTH Videos', `${v.name} is up. Share link copied.`);
      } catch (e) {
        log(`FAILED ${base}: ${e.message}`);
        await fs.mkdir(DROP_FAILED, { recursive: true });
        await fs.rename(it.file, path.join(DROP_FAILED, base)).catch(() => {});
        await notify('CTH Videos', `${base} failed: ${e.message.slice(0, 80)}`);
      }
    }
  } finally {
    await fs.unlink(LOCK).catch(() => {});
  }
}

// ---- install -------------------------------------------------------------------

async function install() {
  if (!KEY) fail('No key in the Keychain. Run: security add-generic-password -a "$USER" -s cth-videos-key -w "<the key>" -U');
  for (const d of [DROP, DROP_ORIGINAL, DROP_DONE, CACHE]) await fs.mkdir(d, { recursive: true });
  await fs.writeFile(path.join(DROP, 'READ ME.txt'),
    'CTH Videos drop folder\n\n'
    + 'Drop game film here. Each file is shrunk with the Mac\'s hardware encoder (no visible loss) and uploaded to CTH Videos.\n'
    + 'Drop into Original/ to upload a file exactly as it is.\n'
    + 'Finished files move to Uploaded/, and Uploaded/links.txt lists every share link. The latest link is also on your clipboard.\n'
    + 'Several files at once are fine: they go one after another, and the next one shrinks while the current one uploads.\n'
    + 'Log: ~/Library/Logs/cth-videos.log\n');
  const node = process.execPath;
  const script = new URL(import.meta.url).pathname;
  const plist = `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key><string>com.coachtonyhockey.videos-drop</string>
  <key>ProgramArguments</key>
  <array><string>${node}</string><string>${script}</string><string>watch</string></array>
  <key>EnvironmentVariables</key>
  <dict><key>PATH</key><string>/opt/homebrew/bin:/usr/local/bin:/usr/bin:/bin</string></dict>
  <key>WatchPaths</key>
  <array><string>${DROP}</string><string>${DROP_ORIGINAL}</string></array>
  <key>RunAtLoad</key><true/>
  <key>ThrottleInterval</key><integer>5</integer>
  <key>StandardOutPath</key><string>${LOG}</string>
  <key>StandardErrorPath</key><string>${LOG}</string>
</dict>
</plist>
`;
  await fs.mkdir(path.dirname(AGENT), { recursive: true });
  try { execFileSync('launchctl', ['unload', AGENT], { stdio: 'ignore' }); } catch (_) { /* not loaded */ }
  await fs.writeFile(AGENT, plist);
  execFileSync('launchctl', ['load', AGENT]);
  for (const dir of ['/usr/local/bin', path.join(HOME, '.local', 'bin'), path.join(HOME, 'bin')]) {
    try {
      await fs.mkdir(dir, { recursive: true });
      const link = path.join(dir, 'cthv');
      await fs.rm(link, { force: true });
      await fs.symlink(script, link);
      console.log(`cthv is on the PATH at ${link}`);
      break;
    } catch (_) { /* try the next */ }
  }
  console.log(`Drop folder: ${DROP}`);
  console.log('Drag that folder into the Finder sidebar so it is one click away. Anything dropped there goes up on its own.');
}

// ---- main ---------------------------------------------------------------------

async function main() {
  const [cmd, ...rest] = process.argv.slice(2);
  if (cmd === 'install') return install();
  if (cmd === 'watch') return watchOnce();
  if (!KEY) fail('No key found. Put it in the Keychain: security add-generic-password -a "$USER" -s cth-videos-key -w "<the key>" -U');
  if (cmd === 'list') {
    const { videos } = await api('/videos');
    for (const v of videos) console.log(`${v.id}  ${fmtBytes(v.size).padStart(8)}  ${fmtDur(v.duration || 0).padStart(6)}  ${v.name}`);
    return;
  }
  if (cmd === 'upload') {
    const opts = { original: false, name: '' };
    const files = [];
    for (let i = 0; i < rest.length; i++) {
      const a = rest[i];
      if (a === '--original') opts.original = true;
      else if (a === '--fast') opts.original = false;
      else if (a === '--name') opts.name = rest[++i] || '';
      else files.push(path.resolve(a));
    }
    if (!files.length) fail('Give it at least one video file.');
    for (const f of files) if (!existsSync(f)) fail(`Not found: ${f}`);
    await fs.mkdir(CACHE, { recursive: true });
    const results = await processMany(files, opts);
    console.log('');
    for (const r of results) {
      if (r.video) console.log(`${r.video.name}\n  share:  ${WATCH_URL}${r.video.id}\n  open:   ${APP_URL}${r.video.id}`);
      else console.log(`${path.basename(r.file)}: FAILED - ${r.error.message}`);
    }
    if (results.length === 1 && results[0].video) clip(`${WATCH_URL}${results[0].video.id}`);
    return;
  }
  console.log('cthv upload [--original] [--name "Title"] <file>...\ncthv watch\ncthv install\ncthv list');
}

main().catch((e) => { console.error(e.message || e); process.exit(1); });
