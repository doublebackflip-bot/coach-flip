// On-device pose tracking with MediaPipe Tasks Vision PoseLandmarker (vendored, works offline).
// Produces the same {meta, frames:[{t, lm, wlm}]} format as tools/extract_landmarks.py.
import { FilesetResolver, PoseLandmarker } from '../vendor/mediapipe/vision_bundle.mjs';

import { boxOf, matchCandidate, pickAthlete, updateRef, nextRoi, uncrop, cleanTrack, trackQuality, torsoHist, histDist } from './engine/tracking.js';

const BASE = new URL('..', import.meta.url).href;
let filesetPromise = null;
const cache = {};
export const MODELS = ['lite', 'full', 'heavy'];
// Confidence thresholds (tuned on the benchmark in bench/): a slightly lower detection bar finds small or
// partly hidden athletes; tracking confidence stays at 0.5 so a lost track re-detects instead of drifting.
export const CONF = { det: 0.4, pres: 0.4, track: 0.5 };

/** PoseLandmarker per (mode, model, numPoses, thresholds, delegate). GPU first, CPU if the GPU path fails. */
async function getLandmarker(mode, model, { numPoses = 1, conf = CONF, delegate = 'auto', seg = false } = {}) {
  const key = [mode, model, numPoses, conf.det, conf.pres, conf.track, delegate, seg].join(':');
  if (cache[key]) return cache[key];
  filesetPromise ??= FilesetResolver.forVisionTasks(BASE + 'vendor/mediapipe/wasm');
  const fileset = await filesetPromise;
  const make = (d) => PoseLandmarker.createFromOptions(fileset, {
    baseOptions: { modelAssetPath: `${BASE}models/pose_landmarker_${model}.task`, delegate: d },
    runningMode: mode, numPoses, outputSegmentationMasks: seg,
    minPoseDetectionConfidence: conf.det, minPosePresenceConfidence: conf.pres, minTrackingConfidence: conf.track,
  });
  let lmk;
  if (delegate === 'CPU') { lmk = await make('CPU'); lmk._delegate = 'CPU'; }
  else {
    try { lmk = await make('GPU'); lmk._delegate = 'GPU'; }
    catch (e) { if (delegate === 'GPU') throw e; console.warn('GPU delegate failed, using CPU', e); lmk = await make('CPU'); lmk._delegate = 'CPU'; }
  }
  cache[key] = lmk;
  return lmk;
}
/** the selected model, or 'full' if it can't be loaded (e.g. heavy not downloaded yet and the phone is offline) */
async function landmarkerWithFallback(mode, model, opts, debug) {
  try { return { lmk: await getLandmarker(mode, model, opts), model }; }
  catch (e) {
    if (model === 'full') throw e;
    debug.modelFallback = `${model} failed (${e.message || e}); using full`;
    return { lmk: await getLandmarker(mode, 'full', opts), model: 'full' };
  }
}

// MediaPipe VIDEO mode needs strictly increasing timestamps for the lifetime of the (cached) landmarker, across
// clips too. Restarting at 0 for a 2nd clip (or after switching to play-through) makes the graph reject every
// frame, so the 2nd analysis of a session silently found no athlete. Keep one clock for all landmarkers.
let videoClock = 0;
const tick = () => (videoClock += 34);
const r4 = (v) => Math.round(v * 10000) / 10000;
const pack = (arr) => arr.map((p) => [r4(p.x), r4(p.y), r4(p.z), r4(p.visibility ?? 0)]);
const people = (res) => (res.landmarks || []).map((lms, i) => { const lm = pack(lms); return { lm, wlm: pack(res.worldLandmarks[i]), box: boxOf(lm) }; });

function waitEvent(el, ev, ms = 4000) {
  return new Promise((resolve) => {
    const t = setTimeout(() => { el.removeEventListener(ev, h); resolve(false); }, ms);
    const h = () => { clearTimeout(t); resolve(true); };
    el.addEventListener(ev, h, { once: true });
  });
}
/** wait for the first of several events (or a timeout): resolves with the event name, or null on timeout */
function waitAny(el, evs, ms) {
  return new Promise((resolve) => {
    const hs = {}; const done = (v) => { clearTimeout(t); for (const e of evs) el.removeEventListener(e, hs[e]); resolve(v); };
    const t = setTimeout(() => done(null), ms);
    for (const e of evs) { hs[e] = () => done(e); el.addEventListener(e, hs[e]); }
  });
}

/** A friendly error that also carries debug details for the "Debug info" box. */
export class VideoError extends Error {
  constructor(message, details = {}) { super(message); this.name = 'VideoError'; this.details = details; }
}
const MEDIA_ERR = { 1: 'MEDIA_ERR_ABORTED', 2: 'MEDIA_ERR_NETWORK', 3: 'MEDIA_ERR_DECODE', 4: 'MEDIA_ERR_SRC_NOT_SUPPORTED' };
export const videoInfo = (v) => v ? { width: v.videoWidth, height: v.videoHeight, duration: v.duration, readyState: v.readyState,
  error: v.error ? `${MEDIA_ERR[v.error.code] || v.error.code} ${v.error.message || ''}`.trim() : null } : null;

// iOS Safari often won't decode, seek, or draw a <video> that isn't in the document. Keep the
// working videos in a tiny, almost-transparent box in the page (not display:none, which has the same problem).
function holder() {
  let h = document.getElementById('video-holder');
  if (!h) {
    h = document.createElement('div'); h.id = 'video-holder'; h.setAttribute('aria-hidden', 'true');
    h.style.cssText = 'position:fixed;left:0;bottom:0;width:2px;height:2px;overflow:hidden;opacity:0.01;pointer-events:none;z-index:-1';
    document.body.appendChild(h);
  }
  return h;
}
export function releaseVideo(v) {
  if (!v) return;
  try { v.pause(); v.removeAttribute('src'); v.load(); } catch (_) { /* ignore */ }
  v.remove();
}

/**
 * Open a video URL (usually a blob: URL from the camera, the file picker or the in-app recorder).
 * `durationHint` (seconds) is used when the container has no duration (MediaRecorder WebM reports Infinity).
 */
export async function loadVideo(url, { durationHint = null, retry = true } = {}) {
  const video = document.createElement('video');
  video.muted = true; video.defaultMuted = true; video.playsInline = true; video.preload = 'auto';
  video.setAttribute('muted', ''); video.setAttribute('playsinline', ''); video.setAttribute('webkit-playsinline', '');
  // crossOrigin on a blob:/data: URL can stop Safari from loading it; only needed for real cross-origin URLs
  if (!/^(blob|data):/.test(url) && new URL(url, location.href).origin !== location.origin) video.crossOrigin = 'anonymous';
  // no tiny CSS size on the video itself: WebKit then hands drawImage() a black frame. The 2px holder clips it instead.
  holder().appendChild(video);
  video.src = url;
  video.load();
  if (video.readyState < 1) {
    const ev = await waitAny(video, ['loadedmetadata', 'error'], 20000);
    if (ev !== 'loadedmetadata' && video.readyState < 1) {
      const info = videoInfo(video); releaseVideo(video);
      // the previous decoder (e.g. a big 4K one) may not be freed yet: retry once with a fresh element
      if (retry && ev === 'error') { await new Promise((r) => setTimeout(r, 600)); return loadVideo(url, { durationHint, retry: false }); }
      throw new VideoError(ev === 'error'
        ? "This phone can't open this video format. On iPhone: Settings → Camera → Formats → Most Compatible, or use the in-app Record button."
        : 'The video did not open (timed out). Try a shorter clip or the in-app Record button.', { stage: 'loadedmetadata', event: ev || 'timeout', video: info });
    }
  }
  if (!video.videoWidth) {
    // some browsers report the size only after the first frame
    await waitAny(video, ['loadeddata', 'error'], 5000);
    if (!video.videoWidth) { const info = videoInfo(video); releaseVideo(video); throw new VideoError("This video has no picture this phone can decode (unsupported format, e.g. HEVC on some Androids). Try the in-app Record button.", { stage: 'videoWidth', video: info }); }
  }
  // MediaRecorder WebM has no duration in its header (Infinity). Use the recording time, or seek far past
  // the end so the browser scans the file and learns the real duration.
  if (!Number.isFinite(video.duration) || video.duration <= 0) {
    if (durationHint > 0) video._duration = durationHint;
    else {
      video.currentTime = 1e7;
      await waitAny(video, ['durationchange', 'seeked', 'timeupdate'], 4000);
      if (!Number.isFinite(video.duration) || video.duration <= 0) await waitAny(video, ['durationchange', 'seeked'], 3000);
      video._duration = Number.isFinite(video.duration) && video.duration > 0 ? video.duration : null;
      video.currentTime = 0; await waitEvent(video, 'seeked', 3000);
    }
  }
  if (Number.isFinite(video.duration) && video.duration > 0) video._duration = video.duration;
  if (!video._duration) { const info = videoInfo(video); releaseVideo(video); throw new VideoError("Couldn't read how long this video is. Try recording again with the in-app Record button.", { stage: 'duration', video: info }); }
  // iOS Safari only decodes frames for seeking after the video has played once
  try { await video.play(); video.pause(); } catch (_) { /* autoplay blocked is fine */ }
  return video;
}

/** true when a drawn frame is (almost) all black/transparent: the video didn't really decode */
function blankFrame(src) {
  const c = document.createElement('canvas'); c.width = 16; c.height = 16;
  const g = c.getContext('2d', { willReadFrequently: true });
  try { g.drawImage(src, 0, 0, 16, 16); } catch (_) { return true; }
  const d = g.getImageData(0, 0, 16, 16).data; let s = 0;
  for (let i = 0; i < d.length; i += 4) s += d[i] + d[i + 1] + d[i + 2];
  return s / (d.length / 4) < 6;
}

/** draw the square crop `roi` (source px) of `src` into an S x S canvas; parts outside the picture stay black */
function drawCrop(g, src, roi, S, SW, SH) {
  g.fillStyle = '#000'; g.fillRect(0, 0, S, S);
  const x0 = Math.max(0, roi.x), y0 = Math.max(0, roi.y), x1 = Math.min(SW, roi.x + roi.s), y1 = Math.min(SH, roi.y + roi.s);
  if (x1 - x0 < 2 || y1 - y0 < 2) return;
  const k = S / roi.s;
  g.drawImage(src, x0, y0, x1 - x0, y1 - y0, (x0 - roi.x) * k, (y0 - roi.y) * k, (x1 - x0) * k, (y1 - y0) * k);
}
/** mean brightness (0-255) of a canvas, sampled */
function lumaOf(g, w, h) {
  const d = g.getImageData(0, 0, w, h).data; let s = 0, n = 0;
  for (let i = 0; i < d.length; i += 4 * 37) { s += 0.299 * d[i] + 0.587 * d[i + 1] + 0.114 * d[i + 2]; n++; }
  return n ? s / n : 128;
}
/** stretch the crop's brightness to the full range (auto-levels); only when it is clearly flat or dark */
function autoLevels(g, S) {
  const img = g.getImageData(0, 0, S, S), d = img.data, hist = new Uint32Array(256);
  for (let i = 0; i < d.length; i += 16) hist[(0.299 * d[i] + 0.587 * d[i + 1] + 0.114 * d[i + 2]) | 0]++;
  const n = d.length / 16; let lo = 0, hi = 255, c = 0;
  for (; lo < 255; lo++) { c += hist[lo]; if (c > n * 0.01) break; }
  c = 0; for (; hi > 0; hi--) { c += hist[hi]; if (c > n * 0.01) break; }
  if (hi - lo > 200 || hi <= lo) return false;
  const k = 255 / (hi - lo);
  for (let i = 0; i < d.length; i += 4) for (let j = 0; j < 3; j++) d[i + j] = (d[i + j] - lo) * k;
  g.putImageData(img, 0, 0);
  return true;
}

/**
 * People in one frame (for the "tap your athlete" screen): {canvas, t, people:[{box, lm}]}.
 * Tries a few moments near the start until someone is found.
 */
export async function scanPeople(url, { model = 'full', durationHint = null, times = [0.4, 1.2, 0, 2.5], maxWidth = 720, delegate = 'auto' } = {}) {
  const video = await loadVideo(url, { durationHint });
  try {
    const { lmk } = await landmarkerWithFallback('IMAGE', model === 'heavy' ? 'full' : model, { numPoses: 4, delegate }, {});
    const scale = Math.min(1, maxWidth / video.videoWidth);
    const canvas = document.createElement('canvas');
    canvas.width = Math.round(video.videoWidth * scale); canvas.height = Math.round(video.videoHeight * scale);
    const g = canvas.getContext('2d');
    let out = null;
    for (const t0 of times) {
      const t = Math.min(t0, Math.max(0, video._duration - 0.05));
      video.currentTime = t; await waitEvent(video, 'seeked', 4000);
      g.drawImage(video, 0, 0, canvas.width, canvas.height);
      const ps = people(lmk.detect(canvas)).filter((p) => p.box.h > 0.08);
      out = { canvas, t, people: ps, width: video.videoWidth, height: video.videoHeight };
      if (ps.length) break;
    }
    return out;
  } finally { releaseVideo(video); }
}

/**
 * Track the athlete through a video. Pipeline (v0.4):
 *  1. find everyone in the frame, lock onto the athlete (the one tapped = `athlete.box` at `athlete.t`, else the
 *     biggest, most central person);
 *  2. every frame, crop a square around where he is (from the full-resolution video), scale it up and run the pose
 *     model on the crop only: small athletes get many more pixels and background people/clutter are cut away;
 *  3. accept only the person who matches the athlete (box overlap + distance + pose shape); if he is lost, search
 *     the full frame again with a widening gate - never jump to someone else;
 *  4. clean the track (left/right flips, implausible points, short gaps, zero-phase One Euro smoothing).
 * Returns {meta, frames (clean), raw (as detected), quality}.
 */
export async function trackVideo(url, opts = {}) {
  const { fps = 20, maxSeconds = 20, model = 'full', maxWidth = 960, onProgress, signal, durationHint = null, debug = {},
    athlete = null, roi: useRoi = true, cropSize = 384, preprocess = false, numPoses = 4, cropPoses = 1, cropMode = 'VIDEO',
    conf = CONF, delegate = 'auto', clean = true, keepRawWorld = false, cleanOpts = {} } = opts;
  const video = await loadVideo(url, { durationHint });
  debug.video = videoInfo(video); debug.duration = video._duration;
  try {
    const fullModel = model === 'heavy' ? 'full' : model;
    const full = await landmarkerWithFallback(useRoi ? 'IMAGE' : 'VIDEO', fullModel, { numPoses, conf, delegate }, debug);
    const crop = useRoi ? await landmarkerWithFallback(cropMode, model, { numPoses: cropPoses, conf, delegate }, debug) : null;
    const usedModel = crop ? crop.model : full.model;
    const SW = video.videoWidth, SH = video.videoHeight;
    // full frame (for finding people) is downscaled; the crop is taken from the full-resolution video
    const scale = Math.min(1, maxWidth / SW);
    const W = Math.round(SW * scale), H = Math.round(SH * scale);
    const canvas = document.createElement('canvas'); canvas.width = W; canvas.height = H;
    const g = canvas.getContext('2d', { willReadFrequently: true });
    const cc = document.createElement('canvas'); cc.width = cc.height = cropSize;
    const cg = cc.getContext('2d', { willReadFrequently: true });
    const total = video._duration;
    const duration = Math.min(total, maxSeconds);
    const n = Math.max(1, Math.floor(duration * fps));
    const frames = new Array(n).fill(null);
    const st = { ref: null, roi: null, lost: 0, lastK: null, seed: athlete?.box || null, crowd: [], luma: [], viaCrop: 0, viaFull: 0, reacquired: 0, rejectedOthers: 0 };
    let blanks = 0, seen = 0;
    const t0 = performance.now();
    const fullDetect = () => {
      g.drawImage(video, 0, 0, W, H);
      const res = useRoi ? full.lmk.detect(canvas) : full.lmk.detectForVideo(canvas, tick());
      if (st.luma.length < 40 && seen % 5 === 0) st.luma.push(lumaOf(g, W, H));
      return withHist(people(res), g, W, H);
    };
    // clothing-colour signature of each candidate (tells the athlete from a coach / partner walking through)
    const withHist = (cands, ctx, w, h, pixels = null) => {
      if (!cands.length) return cands;
      let data = pixels; try { data ??= ctx.getImageData(0, 0, w, h).data; } catch (_) { return cands; }
      for (const c of cands) c.hist = torsoHist(data, w, h, c.lm);
      return cands;
    };
    const detect = (k) => {
      const t = Math.round((k / fps) * 1000) / 1000;
      let found = null;
      // a) crop around the athlete
      if (useRoi && st.ref) {
        st.roi = nextRoi(st.roi, st.ref, SW, SH, { lost: st.lost });
        drawCrop(cg, video, st.roi, cropSize, SW, SH);
        // colours are read before auto-levels so they compare with the (unlevelled) whole-frame colours
        let pixels = null;
        if (preprocess) { try { pixels = cg.getImageData(0, 0, cropSize, cropSize).data; } catch (_) { /* ignore */ } autoLevels(cg, cropSize); }
        const res = cropMode === 'VIDEO' ? crop.lmk.detectForVideo(cc, tick()) : crop.lmk.detect(cc);
        const cands = withHist(people(res), cg, cropSize, cropSize, pixels).map((c) => { const lm = uncrop(c.lm, st.roi, SW, SH); return { lm, wlm: c.wlm, box: boxOf(lm), hist: c.hist }; });
        if (debug.cols && st.ref?.hist) for (const c of cands) if (c.hist && debug.cols.length < 600) debug.cols.push(+histDist(c.hist, st.ref.hist).toFixed(3));
        const m = matchCandidate(cands, st.ref, { W: SW, H: SH, lost: st.lost });
        if (m) { found = cands[m.i]; st.viaCrop++; if (cands.length > 1) st.rejectedOthers += cands.length - 1; }
      }
      // b) whole frame: first lock, re-acquire after a loss, or the no-crop mode
      if (!found) {
        const cands = fullDetect();
        st.crowd.push(cands.length);
        if (!st.ref) {
          let i = -1;
          if (st.seed) { let bi = 0; cands.forEach((c, j) => { const v = iouN(c.box, st.seed); if (v > bi) { bi = v; i = j; } }); if (bi < 0.1) i = st.lastK === null && seen > fps ? pickAthlete(cands, { W, H }) : -1; }
          else i = pickAthlete(cands, { W, H });
          if (i >= 0) found = cands[i];
        } else {
          const m = matchCandidate(cands, st.ref, { W, H, lost: st.lost });
          if (m) { found = cands[m.i]; if (st.lost) st.reacquired++; if (cands.length > 1) st.rejectedOthers += cands.length - 1; }
        }
        if (found) st.viaFull++;
        if (useRoi) st.roi = null;   // fresh crop around the new position
      }
      if (found) {
        frames[k] = { t, lm: found.lm, wlm: found.wlm };
        st.ref = updateRef(st.ref, found.lm, st.lastK === null ? 1 : Math.abs(k - st.lastK), found.hist);
        st.lost = 0; st.lastK = k;
      } else { frames[k] = { t, lm: null, wlm: null }; st.lost++; }
      seen++; onProgress?.(seen / n, seen, n);
    };
    // nobody tapped: look at a few moments (not just frame 0, where someone may be hidden) and lock onto the
    // biggest / most central person seen; start tracking from that moment
    let seedT = athlete?.t;
    if (!athlete && useRoi) {
      let best = null;
      for (const ts of [0, 0.6, 1.2, 2.0, 3.0]) {
        if (ts > duration - 0.05) break;
        video.currentTime = ts; if (!(await waitEvent(video, 'seeked', 3000))) break;
        const cands = fullDetect();
        const i = pickAthlete(cands, { W, H });
        if (i < 0) continue;
        const b = cands[i].box, off = Math.min(1, Math.hypot(b.cx - 0.5, b.cy - 0.5) / 0.5);
        const vis = cands[i].lm.reduce((a, p) => a + p[3], 0) / cands[i].lm.length;
        const score = b.w * b.h * (1 - 0.6 * off) * vis;
        if (!best || score > best.score) best = { score, box: b, t: ts };
      }
      st.luma = []; st.crowd = [];
      if (best) { st.seed = best.box; seedT = best.t; debug.autoPick = { t: best.t, box: best.box }; }
    }
    // processing order: from the frame where the athlete was picked to the end, then back to the start
    const k0 = seedT != null ? Math.max(0, Math.min(n - 1, Math.round(seedT * fps))) : 0;
    const order = []; for (let k = k0; k < n; k++) order.push(k); for (let k = k0 - 1; k >= 0; k--) order.push(k);
    let firstFound = null;   // athlete state nearest the picked frame, to restart the backward pass from
    // 1) seek frame by frame (exact timing). Give up and switch to play-through if seeks hang or frames come out blank.
    let mode = 'seek', timeouts = 0, step = 0;
    for (; step < order.length; step++) {
      const k = order[step];
      if (signal?.aborted) throw new DOMException('Cancelled', 'AbortError');
      if (k === k0 - 1) { st.ref = firstFound?.ref || st.ref; st.lastK = firstFound?.k ?? st.lastK; st.roi = null; st.lost = 0; }
      video.currentTime = Math.min(k / fps, Math.max(0, total - 0.001));
      let ok = await waitEvent(video, 'seeked', 3000);
      // still seeking = slow decoder (4K, far from a keyframe), not a broken one: give it more time
      if (!ok && video.seeking) ok = await waitEvent(video, 'seeked', 8000);
      if (!ok) timeouts++;
      if (step < 4 && blankFrame(video)) blanks++;
      if ((timeouts >= 2 && timeouts > step / 4) || (step === 3 && blanks >= 3)) { mode = 'playthrough'; break; }
      detect(k);
      if (!firstFound && frames[k]?.lm) firstFound = { ref: st.ref, k };
    }
    // 2) play-through capture: play slowly and grab frames as they are shown (requestVideoFrameCallback, else rAF).
    if (mode === 'playthrough') {
      debug.fallback = `seek failed (timeouts ${timeouts}, blank ${blanks}) -> play-through`;
      for (let j = 0; j < n; j++) frames[j] = null;
      seen = 0; st.ref = null; st.roi = null; st.lost = 0; st.lastK = null;
      video.currentTime = 0; await waitEvent(video, 'seeked', 3000);
      video.playbackRate = 0.5;
      let maxT = 0, lastProgress = performance.now();
      await new Promise((resolve, reject) => {
        let done = false; let next = 0; let avg = 0;
        const finish = () => { if (!done) { done = true; video.pause(); resolve(); } };
        const onFrame = (mediaTime) => {
          if (done) return;
          if (signal?.aborted) { done = true; video.pause(); reject(new DOMException('Cancelled', 'AbortError')); return; }
          if (mediaTime > maxT + 1e-3) { maxT = mediaTime; lastProgress = performance.now(); }
          const idx = Math.round(mediaTime * fps);
          if (idx >= next && idx < n) {
            const d0 = performance.now(); detect(idx); next = idx + 1;
            // slow phone: slow the video down so the tracker still sees (almost) every frame
            avg = avg ? avg * 0.8 + (performance.now() - d0) * 0.2 : performance.now() - d0;
            const rate = Math.max(0.1, Math.min(0.5, (0.9 / fps) / (avg / 1000)));
            if (Math.abs(rate - video.playbackRate) > 0.05) { try { video.playbackRate = rate; } catch (_) { /* ignore */ } }
          }
          if (mediaTime >= duration - 0.5 / fps || video.ended) { finish(); return; }
          schedule();
        };
        const schedule = () => video.requestVideoFrameCallback
          ? video.requestVideoFrameCallback((_, m) => onFrame(m.mediaTime))
          : requestAnimationFrame(() => onFrame(video.currentTime));
        video.addEventListener('ended', finish, { once: true });
        // safety: never hang longer than the clip at the slowest speed + 30 s
        setTimeout(finish, (duration / 0.1) * 1000 + 30000);
        // stall watchdog: the video stopped advancing (decoder stuck) -> stop waiting
        const watch = setInterval(() => { if (done) clearInterval(watch); else if (performance.now() - lastProgress > 8000) { clearInterval(watch); finish(); } }, 1000);
        video.play().then(schedule).catch((e) => { done = true; reject(new VideoError('This phone would not play the video for tracking.', { stage: 'play', error: String(e) })); });
      });
      maxT = Math.max(maxT, video.currentTime || 0);
      if (maxT < Math.min(1, duration * 0.5)) throw new VideoError("This phone couldn't step through this video for tracking (it stalls). Use the in-app Record button, or on iPhone set Settings → Camera → Formats → Most Compatible.", { stage: 'playthrough-stalled', reachedSeconds: maxT, video: videoInfo(video) });
      if (blankFrame(video)) throw new VideoError("The video plays but this phone shows a black picture to the app (can't read its frames). Try the in-app Record button.", { stage: 'blank-frames', video: videoInfo(video) });
    }
    for (let j = 0; j < n; j++) frames[j] ??= { t: Math.round((j / fps) * 1000) / 1000, lm: null, wlm: null };
    debug.mode = mode;
    const crowd = st.crowd.slice().sort((a, b) => a - b);
    const meta = { width: W, height: H, fps, duration: total, analyzedSeconds: duration, truncated: total > maxSeconds + 0.05, capture: mode,
      sourceWidth: SW, sourceHeight: SH, model: `pose_landmarker_${usedModel}`, delegate: (crop || full).lmk._delegate,
      extractor: 'mediapipe-tasks-vision (browser)', pipeline: useRoi ? 'v4-roi' : 'v4-lock', preprocess: !!preprocess,
      people: crowd.length ? crowd[crowd.length >> 1] : null, maxPeople: crowd.length ? crowd[crowd.length - 1] : null,
      luma: st.luma.length ? Math.round(st.luma.reduce((a, b) => a + b, 0) / st.luma.length) : null,
      lock: { viaCrop: st.viaCrop, viaFull: st.viaFull, reacquired: st.reacquired, othersIgnored: st.rejectedOthers, seeded: !!athlete, autoPick: debug.autoPick || null, cols: debug.cols || undefined },
      ms: Math.round(performance.now() - t0) };
    const raw = frames.map((f) => ({ t: f.t, lm: f.lm, ...(keepRawWorld ? { wlm: f.wlm } : {}) }));
    if (!clean) return { meta, frames, raw };
    const c = cleanTrack(frames, meta, cleanOpts);
    meta.cleaned = true; meta.clean = c.stats;
    const quality = trackQuality(c.frames, meta, { people: meta.people, luma: meta.luma });
    meta.quality = quality;
    return { meta, frames: c.frames, raw, quality };
  } finally {
    releaseVideo(video);
  }
}
const iouN = (a, b) => {
  const ix = Math.max(0, Math.min(a.x1, b.x1) - Math.max(a.x0, b.x0)), iy = Math.max(0, Math.min(a.y1, b.y1) - Math.max(a.y0, b.y0));
  const I = ix * iy, U = (a.x1 - a.x0) * (a.y1 - a.y0) + (b.x1 - b.x0) * (b.y1 - b.y0) - I;
  return U > 0 ? I / U : 0;
};

export async function trackImage(url, { model = 'full', maxWidth = 1280, tap = null, delegate = 'auto' } = {}) {
  const img = new Image(); img.src = url; await img.decode();
  const debug = {};
  const { lmk, model: used } = await landmarkerWithFallback('IMAGE', model, { numPoses: 4, delegate }, debug);
  const SW = img.naturalWidth, SH = img.naturalHeight;
  const scale = Math.min(1, maxWidth / SW);
  const W = Math.round(SW * scale), H = Math.round(SH * scale);
  const canvas = document.createElement('canvas'); canvas.width = W; canvas.height = H;
  canvas.getContext('2d').drawImage(img, 0, 0, W, H);
  const cands = people(lmk.detect(canvas));
  const i = pickAthlete(cands, { tap, W, H });
  let best = i >= 0 ? cands[i] : null;
  if (best) {
    // second look at a full-resolution crop around the athlete
    const ref = updateRef(null, best.lm);
    const roi = nextRoi(null, ref, SW, SH, { margin: 1.35 });
    const S = 512, cc = document.createElement('canvas'); cc.width = cc.height = S;
    drawCrop(cc.getContext('2d'), img, roi, S, SW, SH);
    const cs = people(lmk.detect(cc)).map((c) => { const lm = uncrop(c.lm, roi, SW, SH); return { lm, wlm: c.wlm, box: boxOf(lm) }; });
    const m = matchCandidate(cs, ref, { W: SW, H: SH });
    if (m) best = cs[m.i];
  }
  return {
    meta: { width: W, height: H, fps: 1, model: `pose_landmarker_${used}`, delegate: lmk._delegate, extractor: 'mediapipe-tasks-vision (browser)', people: cands.length, pipeline: 'v4-roi' },
    frames: [best ? { t: 0, lm: best.lm, wlm: best.wlm } : { t: 0, lm: null, wlm: null }],
  };
}
