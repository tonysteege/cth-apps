// THE SCRUB ENGINE - ported from CTH Clips (clips/js/player.js), which ported
// it from CTH Film Room. The constants below are tuned, not chosen; do not
// round them off.
//
// THREE LAYERS, unchanged from Clips:
//   1. `deltaSeconds` turns wheel events into media seconds - velocity based,
//      asinh knee, integrated over each event's real elapsed time. That is
//      what makes a slow finger move one frame and a fast flick cross a
//      period, with nothing sticky in between.
//   2. `motionStep` eases the PAINTED position onto the finger. `aim` is where
//      the finger is; `pos` is what we show. Without it the picture snaps to
//      every wheel event and reads as chop even when every frame is on time.
//   3. The pump asks OUR OWN DECODER (clips/js/scrubsource.js) before it asks
//      <video>. Film Room measured the difference on a 2h39m game: a decoded
//      next-frame costs ~2ms, `currentTime =` costs ~28ms whether the target
//      is one frame away or two hours, because every seek re-decodes from the
//      preceding keyframe. 28ms with 69ms of swing IS the chop.
//
// WHAT IS DIFFERENT HERE. Clips paints decoded frames onto an overlay canvas
// laid over the <video>, and has to hand the element the final frame and swap
// back. Studio's stage is ALREADY a canvas - every frame goes through
// `composite()` so the telestration is on it - so there is no overlay and no
// swap. The pump hands the caller a picture and the caller composites it. That
// removes the whole settle/overlay dance, and it means a scrubbed frame and an
// exported frame are drawn by the same code.
//
// AND: the gesture drives OUTPUT time, not source time. `sourceAt` sits in the
// middle, so scrubbing through a freeze holds the frame and scrubbing through
// a slow-motion ramp moves at the ramp's speed, for free.

import { openScrubSource, releaseScrubSource, scrubProviderFor } from '../../clips/js/scrubsource.js';

const FRAME_DUR = 1 / 30; // honest default; the browser will not report real fps
const GESTURE_IDLE_MS = 260;

export function deltaSeconds(deltaX, dtMs, sensitivity = 1, fine = false) {
  const dt = Math.max(4, Math.min(40, Number(dtMs) || 8));
  const rawV = Math.abs(Number(deltaX) || 0) / dt;
  const knee = 0.65;
  const v = knee * Math.asinh(rawV / knee);
  const scale = fine ? 0.002 : 0.015;
  return Math.sign(deltaX || 0) * v * dt * scale * Math.max(0.3, Math.min(3, sensitivity || 1));
}

export function motionStep(pos, aim, dtMs, frameRate = 30) {
  const gap = aim - pos;
  if (Math.abs(gap) < 0.5 / Math.max(10, frameRate || 30)) return aim;
  const x = Math.max(0, Math.min(1, (Math.abs(gap) - 0.08) / 1.42));
  const blend = x * x * (3 - 2 * x);
  const tau = 46 + (18 - 46) * blend;
  const alpha = 1 - Math.exp(-Math.max(4, Math.min(40, dtMs || 8)) / tau);
  return pos + gap * alpha;
}

// ---- the source ------------------------------------------------------------

export class ScrubEngine {
  // `onFrame(picture, srcT, outT)` is called with whatever should be drawn:
  // a canvas from the decoder, or the <video> element when the decoder cannot
  // serve. The caller composites it. `mapper(outT) -> srcT` is the time map.
  constructor(video, { onFrame, onTime, settings }) {
    this.video = video;
    this.onFrame = onFrame;
    this.onTime = onTime || (() => {});
    this.settings = settings || (() => ({ scrubSensitivity: 1, scrubReverse: false }));
    this.mapper = (t) => t;
    this.duration = 0;      // output duration
    this.src = null;        // the decoder, or null
    this.sourceId = '';
    this.aim = null;
    this.pos = null;
    this.raf = 0;
    this.busy = false;
    this.ourSeek = null;
    this.lastPumpAt = 0;
    this.lastPumped = null;
    this.endTimer = 0;
    this.lastWheel = 0;
    this.primeTimer = 0;
    this.playing = false;
    this.playT = 0;
    this.playRaf = 0;
    this.playClock = 0;
    this.#bindElement();
  }

  #bindElement() {
    const v = this.video;
    v.addEventListener('seeked', () => {
      this.busy = false;
      // An outside seek while a gesture runs means somebody else moved the
      // playhead; let go rather than fighting them for it.
      if (this.ourSeek != null && Math.abs(v.currentTime - this.ourSeek) > 0.5) this.aim = null;
      this.ourSeek = null;
      if (this.pos == null && !this.playing) this.#emit(v.currentTime);
    });
  }

  // Open the fast decoder for this file. Everything degrades to null: a webm,
  // a fragmented mp4, a rotated file, a codec WebCodecs will not take, a server
  // that refuses Range - all of them just mean the element gets seeked, which
  // is what every other video tool does anyway.
  async attach(id, file, url) {
    this.detach();
    this.sourceId = id;
    const provider = scrubProviderFor(file || null, url || null);
    if (!provider) return null;
    try {
      this.src = await openScrubSource(id, provider);
    } catch (_) { this.src = null; }
    return this.src;
  }

  detach() {
    if (this.sourceId) releaseScrubSource(this.sourceId);
    this.src = null;
    this.sourceId = '';
    clearTimeout(this.primeTimer);
  }

  setMap(mapper, duration) { this.mapper = mapper; this.duration = duration; }

  // ---- position ------------------------------------------------------------

  get time() { return this.pos != null ? this.pos : (this.playing ? this.playT : this.lastOut ?? 0); }

  #emit(srcT) {
    const out = this.lastOut ?? 0;
    this.onFrame(this.video, srcT, out);
    this.onTime(out, srcT);
  }

  // Move to an OUTPUT time without a gesture - a timeline click, a keyboard
  // step, an inspector edit. `hard` skips the easing and lands exactly.
  seek(outT, hard = false) {
    const t = clamp(outT, 0, this.duration);
    this.lastOut = t;
    if (hard) {
      this.stopGesture();
      this.pos = null; this.aim = null;
      const s = this.mapper(t);
      this.busy = true; this.ourSeek = s;
      if (Math.abs(this.video.currentTime - s) > 1e-4) this.video.currentTime = s;
      else { this.busy = false; this.ourSeek = null; this.#emit(s); }
      this.onTime(t, s);
      this.#primeSoon();
      return;
    }
    this.aim = t;
    if (this.pos == null) this.pos = t;
    this.#schedule();
  }

  // Step by whole frames - the arrow keys, and the only way to land on a
  // specific frame with confidence.
  step(frames) {
    const dt = frames * FRAME_DUR;
    this.seek((this.pos != null ? this.pos : this.time) + dt, true);
  }

  // ---- the gesture ---------------------------------------------------------

  // Attach to the stage. Horizontal two-finger travel scrubs; vertical is left
  // alone so the page can still scroll, and ctrl+wheel is a pinch, which the
  // caller may want for zoom.
  attachWheel(node, { onPinch } = {}) {
    node.addEventListener('wheel', (e) => {
      if (e.ctrlKey) { if (onPinch) { e.preventDefault(); onPinch(e); } return; }
      if (Math.abs(e.deltaX) <= Math.abs(e.deltaY)) return; // vertical = page scroll
      e.preventDefault();
      const now = performance.now();
      const dt = this.lastWheel ? now - this.lastWheel : 8;
      this.lastWheel = now;
      const s = this.settings();
      // A trackpad reports NEGATIVE deltaX for a rightward swipe, so the sign
      // is inverted; scrubReverse flips it back for classic scrolling.
      const dir = s.scrubReverse ? 1 : -1;
      const step = deltaSeconds(e.deltaX, dt, s.scrubSensitivity || 1, e.shiftKey);
      this.pause();
      this.aim = clamp((this.aim == null ? this.time : this.aim) + dir * step, 0, this.duration);
      if (this.pos == null) { this.pos = this.time; this.#beginGesture(); }
      this.#schedule();
      clearTimeout(this.endTimer);
      this.endTimer = setTimeout(() => this.stopGesture(), GESTURE_IDLE_MS);
    }, { passive: false });
  }

  // Touch and pen: a horizontal drag on the stage scrubs, which is how an iPad
  // gets the same gesture. The threshold keeps a tap-to-draw from scrubbing.
  attachDrag(node, { shouldScrub }) {
    let id = null; let x0 = 0; let t0 = 0; let live = false; let last = 0;
    node.addEventListener('pointerdown', (e) => {
      if (e.pointerType === 'mouse') return;
      if (shouldScrub && !shouldScrub(e)) return;
      id = e.pointerId; x0 = e.clientX; t0 = this.time; live = false; last = performance.now();
    });
    node.addEventListener('pointermove', (e) => {
      if (e.pointerId !== id) return;
      const dx = e.clientX - x0;
      if (!live) { if (Math.abs(dx) < 12) return; live = true; this.pause(); this.pos = this.time; this.#beginGesture(); }
      e.preventDefault();
      const now = performance.now();
      const s = this.settings();
      // Pixels of finger travel map to a fraction of the timeline, so a swipe
      // across the stage covers the clip whatever its length.
      const per = Math.max(0.6, this.duration) / Math.max(240, node.clientWidth * 0.9);
      this.aim = clamp(t0 + dx * per * (s.scrubSensitivity || 1), 0, this.duration);
      last = now;
      this.#schedule();
    });
    const end = (e) => {
      if (e.pointerId !== id) return;
      id = null;
      if (live) this.stopGesture();
      live = false;
    };
    node.addEventListener('pointerup', end);
    node.addEventListener('pointercancel', end);
  }

  #beginGesture() {
    // Nothing to set up beyond the decoder already being open; the stage is a
    // canvas, so there is no overlay to raise.
    clearTimeout(this.primeTimer);
  }

  stopGesture() {
    clearTimeout(this.endTimer);
    if (this.pos == null) return;
    const final = this.aim != null ? this.aim : this.pos;
    this.pos = null; this.aim = null;
    cancelAnimationFrame(this.raf); this.raf = 0;
    this.seek(final, true);
  }

  #schedule() {
    if (this.raf) return;
    this.raf = requestAnimationFrame(() => this.#pump());
  }

  // One refresh of work: ease toward the finger, ask the decoder, fall back to
  // an element seek only when it cannot serve.
  #pump() {
    this.raf = 0;
    if (this.pos == null || this.aim == null) return;
    const v = this.video;
    const now = performance.now();
    const dt = Math.max(4, now - (this.lastPumpAt || now - 8));
    this.pos = motionStep(this.pos, this.aim, dt, 1 / FRAME_DUR);
    const travel = Math.abs(this.pos - (this.lastPumped == null ? this.pos : this.lastPumped));
    // Demand in video-frames per SECOND: per-refresh would read differently on
    // a 120Hz panel than a 60Hz one, and the decoder's throughput is the same.
    const speed = (travel / FRAME_DUR) / (dt / 1000);
    this.lastPumped = this.pos;
    this.lastPumpAt = now;
    this.lastOut = this.pos;

    const srcT = this.mapper(this.pos);
    let served = false;
    if (this.src) {
      // A served frame may sit a hair off the finger while the decoder catches
      // up - a little over one refresh of travel, so the error is always
      // smaller than the motion itself.
      const tol = Math.max(FRAME_DUR * 1.5, travel * 1.25);
      const r = this.src.request(srcT, speed, tol);
      if (r) { this.onFrame(r.c, r.t, this.pos); served = true; }
    }
    if (!served) {
      this.onFrame(v, v.currentTime, this.pos);
      if (!this.busy && Math.abs(srcT - v.currentTime) >= FRAME_DUR / 2) {
        // Snap to a keyframe only when it is nearer than the step being taken -
        // the error is then smaller than the motion, and the seek costs a
        // fraction as much.
        let t = srcT;
        if (this.src) { const kt = this.src.keyTimeBelow(srcT); if (kt != null && srcT - kt <= travel) t = kt; }
        this.busy = true; this.ourSeek = t;
        v.currentTime = t;
      }
    }
    this.onTime(this.pos, srcT);
    if (Math.abs(this.aim - this.pos) > 1e-4) this.#schedule();
    else { this.pos = this.aim; }
  }

  // Warm the decoder wherever the playhead rests, so the next gesture starts
  // with frames already decoded around it instead of walking a keyframe run.
  #primeSoon(delay = 350) {
    clearTimeout(this.primeTimer);
    this.primeTimer = setTimeout(() => {
      if (!this.src || this.pos != null || this.playing) return;
      if (this.video.paused && this.video.readyState >= 1) this.src.prime(this.video.currentTime);
    }, delay);
  }

  // ---- playback ------------------------------------------------------------

  // Playback runs on OUR clock, not the element's, because output time and
  // source time are different things: a freeze must hold while the clock runs
  // on, and a slow ramp must run the element at a fraction of speed. The
  // element is told the rate; we tell it the position when it drifts.
  play(rateFor) {
    if (this.playing) return;
    this.stopGesture();
    this.playing = true;
    this.playT = this.time >= this.duration - 0.02 ? 0 : this.time;
    this.playClock = performance.now();
    const v = this.video;
    const tick = () => {
      if (!this.playing) return;
      const now = performance.now();
      const dt = Math.min(0.25, (now - this.playClock) / 1000);
      this.playClock = now;
      this.playT = this.playT + dt;
      if (this.playT >= this.duration) { this.playT = this.duration; this.pause(); this.seek(this.duration, true); return; }
      this.lastOut = this.playT;
      const srcT = this.mapper(this.playT);
      const rate = rateFor ? rateFor(this.playT) : 1;
      if (rate === 0) {
        if (!v.paused) v.pause();
        if (Math.abs(v.currentTime - srcT) > 0.02) { v.currentTime = srcT; }
      } else {
        v.playbackRate = clamp(rate, 0.0625, 4);
        if (v.paused) v.play().catch(() => {});
        // Only correct real drift: nudging every frame fights the element's
        // own clock and produces the stutter this is meant to avoid.
        if (Math.abs(v.currentTime - srcT) > 0.24) v.currentTime = srcT;
      }
      this.onFrame(v, v.currentTime, this.playT);
      this.onTime(this.playT, srcT);
      this.playRaf = requestAnimationFrame(tick);
    };
    this.playRaf = requestAnimationFrame(tick);
  }

  pause() {
    if (!this.playing) return;
    this.playing = false;
    cancelAnimationFrame(this.playRaf);
    this.playRaf = 0;
    this.video.pause();
    this.video.playbackRate = 1;
    this.lastOut = this.playT;
    this.#primeSoon();
  }

  toggle(rateFor) { if (this.playing) this.pause(); else this.play(rateFor); }

  destroy() {
    this.pause();
    this.stopGesture();
    this.detach();
    cancelAnimationFrame(this.raf);
  }
}

const clamp = (v, lo, hi) => (v < lo ? lo : v > hi ? hi : v);
