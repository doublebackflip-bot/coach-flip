// On-device pose tracking with MediaPipe Tasks Vision PoseLandmarker (vendored, works offline).
// Produces the same {meta, frames:[{t, lm, wlm}]} format as tools/extract_landmarks.py.
import { FilesetResolver, PoseLandmarker } from '../vendor/mediapipe/vision_bundle.mjs';

const BASE = new URL('..', import.meta.url).href;
let filesetPromise = null;
const cache = {};

async function getLandmarker(mode, model) {
  const key = mode + ':' + model;
  if (cache[key]) return cache[key];
  filesetPromise ??= FilesetResolver.forVisionTasks(BASE + 'vendor/mediapipe/wasm');
  const fileset = await filesetPromise;
  const make = (delegate) => PoseLandmarker.createFromOptions(fileset, {
    baseOptions: { modelAssetPath: `${BASE}models/pose_landmarker_${model}.task`, delegate },
    runningMode: mode, numPoses: 2,
    minPoseDetectionConfidence: 0.5, minPosePresenceConfidence: 0.5, minTrackingConfidence: 0.5,
  });
  let lmk;
  try { lmk = await make('GPU'); lmk._delegate = 'GPU'; } catch (e) { console.warn('GPU delegate failed, using CPU', e); lmk = await make('CPU'); lmk._delegate = 'CPU'; }
  cache[key] = lmk;
  return lmk;
}

// MediaPipe VIDEO mode needs strictly increasing timestamps for the lifetime of the (cached) landmarker, across
// clips too. Restarting at 0 for a 2nd clip (or after switching to play-through) makes the graph reject every
// frame, so the 2nd analysis of a session silently found no athlete. Keep one clock per landmarker.
let videoClock = 0;
const r4 = (v) => Math.round(v * 10000) / 10000;
const pack = (arr) => arr.map((p) => [r4(p.x), r4(p.y), r4(p.z), r4(p.visibility ?? 0)]);

function bbox(lms) {
  const v = lms.filter((p) => (p.visibility ?? 0) > 0.3);
  if (v.length < 4) return { area: 0, c: [0.5, 0.5] };
  const xs = v.map((p) => p.x), ys = v.map((p) => p.y);
  const [x0, x1, y0, y1] = [Math.min(...xs), Math.max(...xs), Math.min(...ys), Math.max(...ys)];
  return { area: (x1 - x0) * (y1 - y0), c: [(x0 + x1) / 2, (y0 + y1) / 2] };
}
/** pick the main athlete: biggest person, weighted toward whoever we tracked last frame */
function pick(res, prevC) {
  let best = null;
  (res.landmarks || []).forEach((lms, i) => {
    const b = bbox(lms);
    let score = b.area;
    if (prevC) score /= 1 + 8 * Math.hypot(b.c[0] - prevC[0], b.c[1] - prevC[1]);
    if (!best || score > best.score) best = { score, i, c: b.c };
  });
  return best;
}

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

export async function trackVideo(url, { fps = 20, maxSeconds = 20, model = 'lite', maxWidth = 960, onProgress, signal, durationHint = null, debug = {} } = {}) {
  const video = await loadVideo(url, { durationHint });
  debug.video = videoInfo(video); debug.duration = video._duration;
  try {
    const lmk = await getLandmarker('VIDEO', model);
    // downscale big phone video (4K) before the pose model: faster and less memory
    const scale = Math.min(1, maxWidth / video.videoWidth);
    const W = Math.round(video.videoWidth * scale), H = Math.round(video.videoHeight * scale);
    const canvas = document.createElement('canvas'); canvas.width = W; canvas.height = H;
    const g = canvas.getContext('2d', { willReadFrequently: false });
    const total = video._duration;
    const duration = Math.min(total, maxSeconds);
    const n = Math.max(1, Math.floor(duration * fps));
    const frames = new Array(n).fill(null); let prevC = null; let blanks = 0, seen = 0;
    let tsBase = videoClock + 1000; // ms; this clip's frame times are offset from here
    const t0 = performance.now();
    const detect = (k) => {
      const t = k / fps;
      g.drawImage(video, 0, 0, W, H);
      const ts = Math.max(tsBase + Math.round(t * 1000), videoClock + 1); videoClock = ts;
      const res = lmk.detectForVideo(canvas, ts);
      const best = pick(res, prevC);
      const tt = Math.round(t * 1000) / 1000;
      if (best) { prevC = best.c; frames[k] = { t: tt, lm: pack(res.landmarks[best.i]), wlm: pack(res.worldLandmarks[best.i]) }; }
      else frames[k] = { t: tt, lm: null, wlm: null };
      seen++; onProgress?.(seen / n, seen, n);
    };
    // 1) seek frame by frame (exact timing). Give up and switch to play-through if seeks hang or frames come out blank.
    let mode = 'seek', k = 0, timeouts = 0;
    for (; k < n; k++) {
      if (signal?.aborted) throw new DOMException('Cancelled', 'AbortError');
      video.currentTime = Math.min(k / fps, Math.max(0, total - 0.001));
      let ok = await waitEvent(video, 'seeked', 3000);
      // still seeking = slow decoder (4K, far from a keyframe), not a broken one: give it more time
      if (!ok && video.seeking) ok = await waitEvent(video, 'seeked', 8000);
      if (!ok) timeouts++;
      if (k < 4 && blankFrame(video)) blanks++;
      if ((timeouts >= 2 && timeouts > k / 4) || (k === 3 && blanks >= 3)) { mode = 'playthrough'; break; }
      detect(k);
    }
    // 2) play-through capture: play slowly and grab frames as they are shown (requestVideoFrameCallback, else rAF).
    if (mode === 'playthrough') {
      debug.fallback = `seek failed (timeouts ${timeouts}, blank ${blanks}) -> play-through`;
      for (let j = 0; j < n; j++) frames[j] = null; seen = 0; prevC = null; tsBase = videoClock + 1000;
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
      for (let j = 0; j < n; j++) frames[j] ??= { t: Math.round((j / fps) * 1000) / 1000, lm: null, wlm: null };
    }
    debug.mode = mode;
    return {
      meta: { width: W, height: H, fps, duration: total, analyzedSeconds: duration, truncated: total > maxSeconds + 0.05, capture: mode,
        sourceWidth: video.videoWidth, sourceHeight: video.videoHeight,
        model: `pose_landmarker_${model}`, delegate: lmk._delegate, extractor: 'mediapipe-tasks-vision (browser)', ms: Math.round(performance.now() - t0) },
      frames,
    };
  } finally {
    releaseVideo(video);
  }
}

export async function trackImage(url, { model = 'lite', maxWidth = 1280 } = {}) {
  const img = new Image(); img.src = url; await img.decode();
  const lmk = await getLandmarker('IMAGE', model);
  const scale = Math.min(1, maxWidth / img.naturalWidth);
  const W = Math.round(img.naturalWidth * scale), H = Math.round(img.naturalHeight * scale);
  const canvas = document.createElement('canvas'); canvas.width = W; canvas.height = H;
  canvas.getContext('2d').drawImage(img, 0, 0, W, H);
  const res = lmk.detect(canvas);
  const best = pick(res, null);
  return {
    meta: { width: W, height: H, fps: 1, model: `pose_landmarker_${model}`, delegate: lmk._delegate, extractor: 'mediapipe-tasks-vision (browser)' },
    frames: [best ? { t: 0, lm: pack(res.landmarks[best.i]), wlm: pack(res.worldLandmarks[best.i]) } : { t: 0, lm: null, wlm: null }],
  };
}
