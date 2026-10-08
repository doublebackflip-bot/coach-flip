// Shared building blocks for sport modules: measurements in body units, drawing primitives,
// window helpers and generic event detectors (foot contacts, peaks, level changes).
// Everything works on Pose objects (see landmarks.js) and the analysis ctx (see core.js).
import { angle, dist, median, round } from './geom.js';

export const r1 = (x) => round(x, 1);
export const r2 = (x) => round(x, 2);
export const deg = (r) => (r * 180) / Math.PI;
export const hi = (v, P, k) => v - P[k];   // badness when bigger is worse
export const lo = (v, P, k) => P[k] - v;   // badness when smaller is worse
export const band = (v, P, a, b) => Math.max(P[a] - v, v - P[b]);

// ---------------------------------------------------------------- units
/** distance in torso lengths (2D image) */
export const torsos = (p, a, b, ctx) => dist(p.p2(a), p.p2(b)) / ctx.unit.torso2;
export const fists = (p, a, b, ctx) => dist(p.p2(a), p.p2(b)) / ctx.unit.fist2;
/** + = point a is LOWER in the image than ref, in fists */
export const below = (p, a, ref, ctx) => (p.p2(a)[1] - p.p2(ref)[1]) / ctx.unit.fist2;
/** + = a is lower than ref, in torso lengths */
export const belowT = (p, a, ref, ctx) => (p.p2(a)[1] - p.p2(ref)[1]) / ctx.unit.torso2;

// ---------------------------------------------------------------- angles
export const ang2 = (p, a, b, c) => angle(p.p2(a), p.p2(b), p.p2(c));
export const ang3 = (p, a, b, c) => angle(p.p3(a), p.p3(b), p.p3(c));
/** joint angle: 2D is exact for a side view (motion in the picture plane); 3D otherwise */
export const joint = (p, a, b, c, ctx) => (ctx.view === 'side' ? ang2(p, a, b, c) : ang3(p, a, b, c));
export const knee = (p, s, ctx) => joint(p, s + '_hip', s + '_knee', s + '_ankle', ctx);
export const elbow = (p, s, ctx) => joint(p, s + '_shoulder', s + '_elbow', s + '_wrist', ctx);
/** larger of the 2D/3D elbow angles: "did the arm straighten?" robust to foreshortening */
export const elbowMax = (p, s) => Math.max(ang2(p, s + '_shoulder', s + '_elbow', s + '_wrist'), ang3(p, s + '_shoulder', s + '_elbow', s + '_wrist'));

/** facing / travel direction in the image for a side view: +1 = athlete faces image right */
export function facing(p) {
  const toes = ['left', 'right'].map((s) => p.p2(s + '_foot_index')[0] - p.p2(s + '_heel')[0]);
  const nose = p.p2('nose')[0] - p.p2('mid_ear')[0];
  const v = toes[0] + toes[1] + 2 * nose;
  return v >= 0 ? 1 : -1;
}
/** signed lean of the segment from -> to vs. vertical (deg); + = top leans toward `dir` (image x sign) */
export function leanDeg(p, from, to, dir) {
  const a = p.p2(from), b = p.p2(to);
  return deg(Math.atan2((b[0] - a[0]) * dir, a[1] - b[1]));
}
/** trunk lean from vertical, + = forward (toward dir) */
export const trunkLean = (p, dir) => leanDeg(p, 'mid_hip', 'mid_shoulder', dir);
/** shin lean: knee relative to ankle; + = knee ahead of the ankle (toward dir) */
export const shinLean = (p, s, dir) => leanDeg(p, s + '_ankle', s + '_knee', dir);
/** thigh angle below horizontal (deg): 0 = thigh horizontal in front, 90 = hanging straight down */
export function thighBelowHorizontal(p, s, dir) {
  const h = p.p2(s + '_hip'), k = p.p2(s + '_knee');
  return deg(Math.atan2(k[1] - h[1], Math.abs(k[0] - h[0]) * (Math.sign((k[0] - h[0]) * dir) || 1)));
}
/** horizontal distance (torso lengths) of a point ahead of another along dir */
export const ahead = (p, a, ref, dir, ctx) => ((p.p2(a)[0] - p.p2(ref)[0]) * dir) / ctx.unit.torso2;
/** leg length in px (hip-knee-ankle) */
export const legLen2 = (p, s) => dist(p.p2(s + '_hip'), p.p2(s + '_knee')) + dist(p.p2(s + '_knee'), p.p2(s + '_ankle'));
/** apparent width of a body line (2D) relative to the torso: shrinks as the line turns toward the camera */
export const width2 = (p, a, b, ctx) => dist(p.p2(a), p.p2(b)) / ctx.unit.torso2;
/** 2D rotation estimate (deg) of a line from its apparent-width ratio vs a reference width */
export const turnFromWidth = (w, w0) => deg(Math.acos(Math.max(0, Math.min(1, w / (w0 || 1e-9)))));
/** knee valgus (front/rear view): how far (deg) the knee caves inward from the hip-ankle line */
export function valgusDeg(p, s, ctx) {
  const h = p.p2(s + '_hip'), k = p.p2(s + '_knee'), a = p.p2(s + '_ankle');
  const mid = p.p2('mid_hip');
  const inward = Math.sign(mid[0] - h[0]) || 1; // direction of the body midline from this hip
  // signed horizontal offset of the knee from the hip-ankle line at the knee's height
  const t = (k[1] - h[1]) / ((a[1] - h[1]) || 1e-9);
  const lineX = h[0] + (a[0] - h[0]) * t;
  const off = (k[0] - lineX) * inward;
  const ang = 180 - angle(h, k, a);
  return off > 0 ? ang : -ang;
}

// ---------------------------------------------------------------- drawing (normalised coords)
export const D = {
  line: (p, a, b, text) => ({ k: 'line', a: p.n(a), b: p.n(b), text }),
  zone: (p, c, rf, ctx, text) => ({ k: 'circle', c: p.n(c), r: (rf * ctx.unit.fist2) / ctx.meta.width, text }),
  ang: (p, a, b, c, text) => ({ k: 'angle', a: p.n(a), b: p.n(b), c: p.n(c), text }),
  level: (p, a, ctx, text, w = 3) => ({ k: 'hline', x: p.n(a)[0], y: p.n(a)[1], w: (w * ctx.unit.fist2) / ctx.meta.width, text }),
  vert: (p, a, ctx, text, h = 1.2) => ({ k: 'vline', x: p.n(a)[0], y: p.n(a)[1], h: (h * ctx.unit.torso2) / ctx.meta.height, text }),
  dot: (p, a, text) => ({ k: 'dot', c: p.n(a), text }),
  seg: (a, b, text) => ({ k: 'line', a, b, text }), // raw normalised points
};

// ---------------------------------------------------------------- windows
export const at = (ctx, i, needs, minVis) => { const p = ctx.poses[i]; return p && p.vis(...needs) >= (minVis ?? ctx.G.min_visibility) ? p : null; };
/** max of fn over frames a..b (skip(i) excludes frames) -> {v, i, p} */
export function maxOver(ctx, a, b, needs, fn, skip) {
  let best = null;
  for (let i = Math.max(0, a); i <= Math.min(ctx.poses.length - 1, b); i++) {
    if (skip && skip(i)) continue;
    const p = ctx.poses[i];
    if (!p || p.vis(...needs) < ctx.G.min_visibility) continue;
    const v = fn(p, i);
    if (Number.isFinite(v) && (!best || v > best.v)) best = { v, i, p };
  }
  return best;
}
export function minOver(ctx, a, b, needs, fn, skip) {
  const r = maxOver(ctx, a, b, needs, (p, i) => -fn(p, i), skip);
  return r && { ...r, v: -r.v };
}
/** per-frame series (NaN where landmarks are not visible enough) */
export const series = (ctx, needs, fn, minVis = 0.3) => ctx.poses.map((p, i) => (p && p.vis(...needs) >= minVis ? fn(p, i) : NaN));
/** fill short NaN gaps by linear interpolation (tracking dropouts) */
export function fillGaps(x, maxGap = 3) {
  const y = x.slice();
  let last = -1;
  for (let i = 0; i < y.length; i++) {
    if (Number.isFinite(y[i])) {
      if (last >= 0 && i - last > 1 && i - last <= maxGap + 1) for (let j = last + 1; j < i; j++) y[j] = y[last] + ((y[i] - y[last]) * (j - last)) / (i - last);
      last = i;
    }
  }
  return y;
}
export function smooth1(x, w = 1) {
  return x.map((v, i) => {
    let s = 0, n = 0;
    for (let j = i - w; j <= i + w; j++) if (Number.isFinite(x[j])) { s += x[j]; n++; }
    return n && Number.isFinite(v) ? s / n : v;
  });
}
/** local maxima of a series with prominence (vs the lowest value in the preceding window) */
export function peaks(x, { min = -Infinity, prom = 0, win = 5, back = 15, gap = 1 } = {}) {
  const out = [];
  for (let i = 0; i < x.length; i++) {
    const v = x[i];
    if (!(v >= min)) continue;
    let isMax = true;
    for (let j = Math.max(0, i - win); j <= Math.min(x.length - 1, i + win); j++) if (x[j] > v || (x[j] === v && j < i)) { isMax = false; break; }
    if (!isMax) continue;
    let lowest = Infinity;
    for (let j = Math.max(0, i - back); j < i; j++) if (Number.isFinite(x[j])) lowest = Math.min(lowest, x[j]);
    if (!(v - lowest >= prom)) continue;
    if (out.length && i - out.at(-1) < gap) { if (x[out.at(-1)] < v) out[out.length - 1] = i; continue; }
    out.push(i);
  }
  return out;
}
/** speed series (torso lengths per real second) of a 2D point */
export function speed(ctx, name, needs = [name]) {
  const { poses, fps } = ctx;
  const T = ctx.unit.torso2;
  return poses.map((p, i) => {
    const q = poses[i - 1], r = poses[i + 1];
    if (!p || !q || !r || p.vis(...needs) < 0.3 || q.vis(...needs) < 0.3 || r.vis(...needs) < 0.3) return NaN;
    return dist(r.p2(name), q.p2(name)) / 2 / T * fps;
  });
}

// ---------------------------------------------------------------- generic detectors
/**
 * Foot contacts from the lowest point of each foot (works from side, front and rear views):
 * a foot is on the ground when its lowest point is within `tol` of the local ground line
 * (rolling max of both feet's lowest points) and it's not moving up/down much.
 * Returns contacts [{side, start, end, peak(=mid-stance), td, to}] sorted by start.
 */
export function footContacts(ctx, { tol = 0.07, win = 0.8, minFrames = 1, merge = true, mergeGap = 0.25, mergeDist = 0.35 } = {}) {
  const { poses, sec } = ctx;
  const N = poses.length, T = ctx.unit.torso2;
  const low = {}; const contacts = [];
  for (const s of ['left', 'right']) {
    low[s] = fillGaps(poses.map((p) => {
      if (!p) return NaN;
      const pts = [s + '_ankle', s + '_heel', s + '_foot_index'].filter((n) => p.p2(n)[2] >= 0.3);
      if (!pts.length) return NaN;
      return Math.max(...pts.map((n) => p.p2(n)[1]));
    }), 2);
  }
  const W = sec(win);
  const ground = [];
  for (let i = 0; i < N; i++) {
    let g = -Infinity;
    for (let j = Math.max(0, i - W); j <= Math.min(N - 1, i + W); j++) for (const s of ['left', 'right']) if (Number.isFinite(low[s][j])) g = Math.max(g, low[s][j]);
    ground.push(g);
  }
  for (const s of ['left', 'right']) {
    let start = -1;
    for (let i = 0; i <= N; i++) {
      const on = i < N && Number.isFinite(low[s][i]) && ground[i] - low[s][i] <= tol * T;
      if (on && start < 0) start = i;
      if (!on && start >= 0) {
        const end = i - 1;
        if (end - start + 1 >= minFrames) contacts.push({ side: s, start, end, td: start, to: end });
        start = -1;
      }
    }
  }
  contacts.sort((a, b) => a.start - b.start);
  // The pose model often swaps left/right legs in a side view, which splits one stance into
  // two short "contacts" with different labels, or one leg's stance into pieces. Merge contacts
  // that are (almost) back-to-back with the grounded foot in the same place.
  if (merge) {
    // foot position relative to the hips, so a panning camera (which moves everything) doesn't matter:
    // one stance split in two keeps the foot where it was; a new step lands well ahead of the old toe-off.
    const fx = (c, i) => { const p = poses[i]; return p ? p.p2(c.side + '_ankle')[0] - p.p2('mid_hip')[0] : NaN; };
    for (let k = 0; k + 1 < contacts.length;) {
      const a = contacts[k], b = contacts[k + 1];
      const gapOk = b.start - a.end <= Math.max(1, sec(mergeGap)) + 1;
      const near = Math.abs(fx(b, b.start) - fx(a, a.end)) <= mergeDist * T;
      if (gapOk && near) {
        const keep = (a.end - a.start) >= (b.end - b.start) ? a : b;
        contacts.splice(k, 2, { side: keep.side, start: a.start, end: Math.max(a.end, b.end), td: a.start, to: Math.max(a.end, b.end) });
      } else k++;
    }
  }
  // mid-stance: frame in the contact where the hip is closest to above the ankle (side view) or the middle
  for (const c of contacts) {
    let best = Math.round((c.start + c.end) / 2), bd = Infinity;
    for (let i = c.start; i <= c.end; i++) {
      const p = poses[i]; if (!p) continue;
      const d = Math.abs(p.p2('mid_hip')[0] - p.p2(c.side + '_ankle')[0]);
      if (d < bd) { bd = d; best = i; }
    }
    c.peak = best; c.mid = best;
  }
  return { contacts, ground, low };
}
/** contacts that start and end inside the clip (complete steps), dropping the ones cut by the clip edges */
export const completeContacts = (cs, N) => cs.filter((c) => c.start > 0 && c.end < N - 1);

/** step rate from contacts (steps per minute, real time) */
export function cadence(ctx, contacts) {
  if (contacts.length < 3) return NaN;
  const t = contacts.map((c) => ctx.rt(c.td));
  const dt = median(t.slice(1).map((x, i) => x - t[i]));
  return dt > 0 ? 60 / dt : NaN;
}

/** frames where the athlete is mostly still (pose change below thr torso lengths / s) */
export function stillFrames(ctx, thr = 0.6) {
  const { poses, fps } = ctx;
  const T = ctx.unit.torso2;
  const out = [];
  for (let i = 0; i < poses.length; i++) {
    const p = poses[i], q = poses[i - 1] || poses[i + 1];
    if (!p) continue;
    if (!q) { out.push(i); continue; }
    let s = 0; for (let k = 11; k <= 28; k++) s = Math.max(s, Math.hypot((p.raw.lm[k][0] - q.raw.lm[k][0]) * p.W, (p.raw.lm[k][1] - q.raw.lm[k][1]) * p.H));
    if ((s / T) * fps < thr) out.push(i);
  }
  return out;
}
/** standing hip height (px above the feet) from the most upright frames */
export function standingHipHeight(ctx) {
  const hs = ctx.poses.map((p) => p && p.vis('left_hip', 'right_hip', 'left_ankle', 'right_ankle') > 0.3 ? p.p2('mid_ankle')[1] - p.p2('mid_hip')[1] : NaN).filter(Number.isFinite).sort((a, b) => b - a);
  return hs.length ? hs[Math.floor(hs.length * 0.1)] : NaN;
}

export const LEGS = ['left_hip', 'right_hip', 'left_knee', 'right_knee', 'left_ankle', 'right_ankle'];
export const HIPS = ['left_hip', 'right_hip'];
export const SHOULDERS = ['left_shoulder', 'right_shoulder'];
export const TRUNK = [...HIPS, ...SHOULDERS];
export const ARM = (s) => [s + '_shoulder', s + '_elbow', s + '_wrist'];
export const LEG = (s) => [s + '_hip', s + '_knee', s + '_ankle'];
export const FOOT = (s) => [s + '_ankle', s + '_heel', s + '_foot_index'];
export const other = (s) => (s === 'left' ? 'right' : 'left');

/** check factory defaults so modules stay short */
export function mk(def) {
  return { priority: 5, basis: 'estimated', params: {}, ...def };
}

/** 2D midpoint of two named points -> [x, y, vis] */
export const mid2 = (p, a, b) => { const A = p.p2(a), B = p.p2(b); return [(A[0] + B[0]) / 2, (A[1] + B[1]) / 2, Math.min(A[2], B[2])]; };
/** dot / segment at raw 2D pixel points */
export const dotAt = (p, pt, text) => ({ k: 'dot', c: [pt[0] / p.W, pt[1] / p.H], text });
export const segAt = (p, a, b, text) => ({ k: 'line', a: [a[0] / p.W, a[1] / p.H], b: [b[0] / p.W, b[1] / p.H], text });
/** median sign of fn over posed frames (e.g. which way the athlete faces) */
export function medianSign(ctx, needs, fn, idx) {
  const v = [];
  for (const i of idx ?? ctx.poses.keys()) { const p = ctx.poses[i]; if (p && p.vis(...needs) >= 0.3) v.push(fn(p)); }
  return (median(v) || 0) >= 0 ? 1 : -1;
}

/** detection/aggregation settings shared by every sport (all editable in Settings > Advanced) */
export function baseGlobals(extra = {}) {
  return {
    fist_torso_ratio: { value: 0.2, label: '1 fist = this x torso length', unit: 'x', note: 'Adult fist ~10 cm, torso ~50 cm' },
    min_visibility: { value: 0.5, label: 'Min landmark visibility', unit: '0-1' },
    smoothing_frames: { value: 3, label: 'Smoothing window', unit: 'frames' },
    guard_fail_fraction: { value: 0.3, label: 'Position fault if failing this share of the frames checked', unit: '0-1' },
    min_fault_duration_s: { value: 0.2, label: 'Position fault needs at least this much failing time', unit: 's' },
    episode_gap_s: { value: 0.25, label: 'Merge fault moments closer than', unit: 's' },
    event_fail_fraction: { value: 0.25, label: 'Rep fault if failing this share of reps (swings, steps, kicks...)', unit: '0-1' },
    event_flag_halfwidth: { value: 2, label: 'Frames highlighted around a rep fault', unit: 'frames' },
    ...extra,
  };
}

/** false for frames where the legs look collapsed (a common pose-model glitch in side views):
 * both 2D leg lengths far shorter than the clip's typical leg length */
export function legsOk(ctx, i) {
  if (!ctx._legMed) {
    const v = [];
    ctx.poses.forEach((p) => { if (p && p.vis('left_hip', 'left_knee', 'left_ankle', 'right_hip', 'right_knee', 'right_ankle') >= 0.3) v.push(Math.max(legLen2(p, 'left'), legLen2(p, 'right'))); });
    ctx._legMed = median(v) || 1;
  }
  const p = ctx.poses[i]; if (!p) return false;
  return Math.max(legLen2(p, 'left'), legLen2(p, 'right')) >= 0.75 * ctx._legMed;
}

/** body-line yaw (deg) around the vertical axis from MediaPipe world coordinates; works from any camera angle */
export function yawSeries(ctx, a, b) {
  const out = ctx.poses.map((p) => (p && p.vis(a, b) >= 0.3 ? (Math.atan2(p.p3(b)[2] - p.p3(a)[2], p.p3(b)[0] - p.p3(a)[0]) * 180) / Math.PI : NaN));
  // unwrap
  let off = 0, prev = NaN;
  for (let i = 0; i < out.length; i++) {
    if (!Number.isFinite(out[i])) continue;
    if (Number.isFinite(prev)) { const d = out[i] + off - prev; if (d > 180) off -= 360; else if (d < -180) off += 360; }
    out[i] += off; prev = out[i];
  }
  return smooth1(fillGaps(out, 3), 1);
}
