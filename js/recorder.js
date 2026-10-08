// In-app video recorder: live camera preview (getUserMedia) + MediaRecorder. Works the same on iOS Safari
// (incl. home-screen mode) and Android Chrome, and avoids the native camera-app round trip, which on Android
// can kill and reload the page (losing the clip) and which some browsers ignore (`capture`).

export class CameraError extends Error {
  constructor(kind, message, details = {}) { super(message); this.name = 'CameraError'; this.kind = kind; this.details = details; }
}

export const isIOS = () => /iP(hone|ad|od)/.test(navigator.userAgent) || (navigator.platform === 'MacIntel' && navigator.maxTouchPoints > 1);
const isSafari = () => /^((?!chrome|android|crios|fxios|edg).)*safari/i.test(navigator.userAgent);

export function cameraSupport() {
  return {
    secureContext: !!window.isSecureContext,
    getUserMedia: !!navigator.mediaDevices?.getUserMedia,
    mediaRecorder: typeof MediaRecorder !== 'undefined',
    mime: pickMime(),
  };
}
export const canRecordInApp = () => { const s = cameraSupport(); return s.secureContext && s.getUserMedia && s.mediaRecorder; };

/** MP4 (H.264) on iOS/Safari, WebM on Chrome/Android; '' = let the browser pick; null = no MediaRecorder */
export function pickMime() {
  if (typeof MediaRecorder === 'undefined') return null;
  const mp4 = ['video/mp4;codecs=avc1.42E01E', 'video/mp4;codecs=avc1', 'video/mp4'];
  const webm = ['video/webm;codecs=vp8', 'video/webm;codecs=vp9', 'video/webm'];
  const order = isIOS() || isSafari() ? [...mp4, ...webm] : [...webm, ...mp4];
  for (const m of order) { try { if (MediaRecorder.isTypeSupported?.(m)) return m; } catch (_) { /* ignore */ } }
  return '';
}

const MESSAGES = {
  denied: () => isIOS()
    ? 'Camera access was blocked. Open Settings → Safari → Camera → Allow (or tap "aA" → Website Settings → Camera), then try again. You can also use the phone camera app below.'
    : 'Camera access was blocked. Tap the lock icon next to the address → Permissions → Camera → Allow, then try again. You can also use the phone camera app below.',
  nocamera: () => 'No camera was found on this device.',
  busy: () => 'The camera is being used by another app (or a video call). Close it and try again.',
  insecure: () => 'The camera only works on the secure (https://) address of the app.',
  unsupported: () => "This browser can't record inside the app. Use the phone camera app or upload a video instead.",
};
function mapError(e) {
  const n = e?.name || '';
  const kind = /NotAllowed|Security|PermissionDenied/.test(n) ? 'denied' : /NotFound|DevicesNotFound|Overconstrained/.test(n) ? 'nocamera'
    : /NotReadable|TrackStart|Abort/.test(n) ? 'busy' : 'unsupported';
  return new CameraError(kind, MESSAGES[kind](), { errorName: n, errorMessage: e?.message || String(e) });
}

/** open the camera (back camera by default) at up to 1280x720, up to 60 fps */
export async function openCamera(facing = 'environment') {
  if (!window.isSecureContext) throw new CameraError('insecure', MESSAGES.insecure());
  if (!navigator.mediaDevices?.getUserMedia) throw new CameraError('unsupported', MESSAGES.unsupported(), { reason: 'no getUserMedia' });
  const ideal = { facingMode: { ideal: facing }, width: { ideal: 1280 }, height: { ideal: 720 }, frameRate: { ideal: 60, max: 60 } };
  try {
    return await navigator.mediaDevices.getUserMedia({ video: ideal, audio: false });
  } catch (e) {
    if (/Overconstrained|ConstraintNotSatisfied|TypeError/.test(e?.name || '')) {
      try { return await navigator.mediaDevices.getUserMedia({ video: { facingMode: facing }, audio: false }); } catch (e2) { throw mapError(e2); }
    }
    throw mapError(e);
  }
}
export function stopStream(stream) { stream?.getTracks().forEach((t) => t.stop()); }

/**
 * Record from `stream`. Returns a controller: { stop(), done: Promise<{file, seconds, mime}> }.
 * `onTick(seconds)` runs ~10x/s; recording stops by itself at `maxSeconds`.
 */
export function startRecording(stream, { maxSeconds = 20, onTick } = {}) {
  if (typeof MediaRecorder === 'undefined') throw new CameraError('unsupported', MESSAGES.unsupported(), { reason: 'no MediaRecorder' });
  const mime = pickMime();
  let rec;
  try { rec = new MediaRecorder(stream, { ...(mime ? { mimeType: mime } : {}), videoBitsPerSecond: 5_000_000 }); }
  catch (_) { try { rec = new MediaRecorder(stream); } catch (e) { throw new CameraError('unsupported', MESSAGES.unsupported(), { reason: 'MediaRecorder failed', errorMessage: e?.message, mime }); } }
  const chunks = []; const t0 = performance.now(); let timer = 0;
  const seconds = () => (performance.now() - t0) / 1000;
  const done = new Promise((resolve, reject) => {
    rec.ondataavailable = (e) => { if (e.data && e.data.size) chunks.push(e.data); };
    rec.onerror = (e) => { clearInterval(timer); reject(new CameraError('unsupported', 'Recording failed on this phone. Try the phone camera app instead.', { errorMessage: e?.error?.message || String(e?.error || e), mime })); };
    rec.onstop = () => {
      clearInterval(timer);
      const type = (rec.mimeType || mime || 'video/webm').split(';')[0];
      const blob = new Blob(chunks, { type });
      const secs = Math.min(seconds(), maxSeconds + 0.5);
      if (!blob.size) { reject(new CameraError('unsupported', 'The recording came out empty. Try again, or use the phone camera app.', { mime: rec.mimeType || mime })); return; }
      const ext = type.includes('mp4') ? 'mp4' : type.includes('quicktime') ? 'mov' : 'webm';
      const file = new File([blob], `recording-${new Date().toISOString().replace(/[:.]/g, '-')}.${ext}`, { type });
      resolve({ file, seconds: secs, mime: rec.mimeType || mime || type });
    };
  });
  rec.start(1000);
  timer = setInterval(() => { const s = seconds(); onTick?.(s); if (s >= maxSeconds && rec.state === 'recording') rec.stop(); }, 100);
  return { stop: () => { if (rec.state === 'recording') { try { rec.requestData?.(); } catch (_) { /* ignore */ } rec.stop(); } }, done, recorder: rec, mime };
}
