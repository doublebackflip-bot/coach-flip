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

export async function loadVideo(url) {
  const video = document.createElement('video');
  video.muted = true; video.playsInline = true; video.preload = 'auto'; video.crossOrigin = 'anonymous';
  video.src = url;
  if (video.readyState < 1) await waitEvent(video, 'loadedmetadata', 15000);
  if (!video.videoWidth) throw new Error('Could not open this video on this phone. Try recording again.');
  // iOS Safari only decodes frames for seeking after the video has played once
  try { await video.play(); video.pause(); } catch (_) { /* autoplay blocked is fine */ }
  return video;
}

export async function trackVideo(url, { fps = 20, maxSeconds = 20, model = 'lite', maxWidth = 960, onProgress, signal } = {}) {
  const video = await loadVideo(url);
  const lmk = await getLandmarker('VIDEO', model);
  const scale = Math.min(1, maxWidth / video.videoWidth);
  const W = Math.round(video.videoWidth * scale), H = Math.round(video.videoHeight * scale);
  const canvas = document.createElement('canvas'); canvas.width = W; canvas.height = H;
  const g = canvas.getContext('2d', { willReadFrequently: false });
  const duration = Math.min(video.duration || 0, maxSeconds);
  const n = Math.max(1, Math.floor(duration * fps));
  const frames = []; let prevC = null; let lastTs = -1;
  const t0 = performance.now();
  for (let k = 0; k < n; k++) {
    if (signal?.aborted) throw new DOMException('Cancelled', 'AbortError');
    const t = k / fps;
    video.currentTime = Math.min(t, Math.max(0, video.duration - 0.001));
    await waitEvent(video, 'seeked');
    g.drawImage(video, 0, 0, W, H);
    const ts = Math.max(Math.round(t * 1000), lastTs + 1); lastTs = ts;
    const res = lmk.detectForVideo(canvas, ts);
    const best = pick(res, prevC);
    if (best) {
      prevC = best.c;
      frames.push({ t: Math.round(t * 1000) / 1000, lm: pack(res.landmarks[best.i]), wlm: pack(res.worldLandmarks[best.i]) });
    } else frames.push({ t: Math.round(t * 1000) / 1000, lm: null, wlm: null });
    onProgress?.((k + 1) / n, k + 1, n);
  }
  return {
    meta: { width: W, height: H, fps, duration: video.duration, analyzedSeconds: duration, truncated: video.duration > maxSeconds + 0.05,
      model: `pose_landmarker_${model}`, delegate: lmk._delegate, extractor: 'mediapipe-tasks-vision (browser)', ms: Math.round(performance.now() - t0) },
    frames,
  };
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
