// Athlete lock, landmark clean-up and tracking-quality measures. Pure functions (browser + Node tests).
// Landmark arrays are MediaPipe's 33 x [x, y, z, visibility] (x, y normalised to the frame).
import { median } from './geom.js';

export const CORE4 = [11, 12, 23, 24];                       // shoulders + hips: barely move frame to frame
export const BODY12 = [11, 12, 13, 14, 15, 16, 23, 24, 25, 26, 27, 28];
export const BONES = [['upper arm L', 11, 13], ['forearm L', 13, 15], ['upper arm R', 12, 14], ['forearm R', 14, 16],
  ['thigh L', 23, 25], ['shin L', 25, 27], ['thigh R', 24, 26], ['shin R', 26, 28]];
const LR = [[1, 4], [2, 5], [3, 6], [7, 8], [9, 10], [11, 12], [13, 14], [15, 16], [17, 18], [19, 20], [21, 22], [23, 24], [25, 26], [27, 28], [29, 30], [31, 32]];
const GROUPS = {
  body: { pairs: LR, test: [[11, 12], [23, 24], [13, 14], [25, 26]] },
  arms: { pairs: [[13, 14], [15, 16], [17, 18], [19, 20], [21, 22]], test: [[13, 14], [15, 16]] },
  legs: { pairs: [[25, 26], [27, 28], [29, 30], [31, 32]], test: [[25, 26], [27, 28]] },
};
// hands and feet move fast (punches, kicks): they get less smoothing and a looser spike test
const FAST = new Set([15, 16, 17, 18, 19, 20, 21, 22, 27, 28, 29, 30, 31, 32]);
const MID = new Set([13, 14, 25, 26]);
const DISTAL = { 13: 15, 14: 16, 25: 27, 26: 28, 11: 13, 12: 14, 23: 25, 24: 26 };

// q flags per landmark: 0 measured, 1 L/R swap fixed, 2 filled by interpolation, 3 rejected (implausible), 4 not seen
export const Q = { OK: 0, SWAPPED: 1, FILLED: 2, REJECTED: 3, MISSING: 4 };
export const VIS_FILLED = 0.35;   // below the checks' 0.5 visibility bar, above the 0.3 bar for event series
export const VIS_REJECTED = 0.05;

const hyp = Math.hypot;

// ---------------------------------------------------------------- boxes and identity
export function boxOf(lm, minVis = 0.3) {
  let x0 = Infinity, y0 = Infinity, x1 = -Infinity, y1 = -Infinity, n = 0;
  const add = (p) => { x0 = Math.min(x0, p[0]); y0 = Math.min(y0, p[1]); x1 = Math.max(x1, p[0]); y1 = Math.max(y1, p[1]); n++; };
  for (const p of lm) if ((p[3] ?? 1) >= minVis) add(p);
  if (n < 4) { n = 0; for (const p of lm) add(p); }
  return { x0, y0, x1, y1, cx: (x0 + x1) / 2, cy: (y0 + y1) / 2, w: x1 - x0, h: y1 - y0 };
}
export function iou(a, b) {
  const ix = Math.max(0, Math.min(a.x1, b.x1) - Math.max(a.x0, b.x0)), iy = Math.max(0, Math.min(a.y1, b.y1) - Math.max(a.y0, b.y0));
  const I = ix * iy, U = a.w * a.h + b.w * b.h - I;
  return U > 0 ? I / U : 0;
}
const shift = (b, dx, dy) => ({ ...b, x0: b.x0 + dx, x1: b.x1 + dx, y0: b.y0 + dy, y1: b.y1 + dy, cx: b.cx + dx, cy: b.cy + dy });
/** pose-shape difference (0 = same shape): body joints relative to the box centre, in box heights */
export function shapeDist(a, b, W = 1, H = 1) {
  const ba = boxOf(a), bb = boxOf(b);
  const sa = Math.max(1e-6, ba.h * H), sb = Math.max(1e-6, bb.h * H);
  let s = 0, n = 0;
  for (const k of BODY12) {
    if (a[k][3] < 0.3 || b[k][3] < 0.3) continue;
    s += hyp(((a[k][0] - ba.cx) * W) / sa - ((b[k][0] - bb.cx) * W) / sb, ((a[k][1] - ba.cy) * H) / sa - ((b[k][1] - bb.cy) * H) / sb); n++;
  }
  return n >= 4 ? s / n : 0.3;
}
const meanVis = (lm, idx = BODY12) => idx.reduce((s, k) => s + lm[k][3], 0) / idx.length;

// ---------------------------------------------------------------- appearance (clothing colour) signature
/**
 * Colour histogram of the torso (shoulders-hips box, shrunk a little) from RGBA pixels `data` of a w x h image whose
 * landmarks `lm` are normalised to that image. Bins: chromaticity r,g (6 x 6) x brightness (4) = 144, L1-normalised.
 * Clothing colour tells the athlete from a coach / partner / passer-by even when their boxes overlap.
 */
export const HIST_BINS = 4 * 4 * 3;
export function torsoHist(data, w, h, lm) {
  const T = [11, 12, 23, 24].filter((k) => lm[k][3] > 0.3);
  if (T.length < 3) return null;
  let x0 = Math.min(...T.map((k) => lm[k][0])), x1 = Math.max(...T.map((k) => lm[k][0]));
  let y0 = Math.min(...T.map((k) => lm[k][1])), y1 = Math.max(...T.map((k) => lm[k][1]));
  const sx = (x1 - x0) * 0.15, sy = (y1 - y0) * 0.12;
  x0 = Math.max(0, Math.floor((x0 + sx) * w)); x1 = Math.min(w - 1, Math.ceil((x1 - sx) * w));
  y0 = Math.max(0, Math.floor((y0 + sy) * h)); y1 = Math.min(h - 1, Math.ceil((y1 - sy) * h));
  if (x1 - x0 < 3 || y1 - y0 < 3) return null;
  // soft (trilinear) binning: chromaticity r, g (4 x 4) x brightness (3), so small exposure / scaling differences
  // don't flip whole bins
  const hist = new Float32Array(HIST_BINS), step = Math.max(1, Math.floor(Math.sqrt(((x1 - x0) * (y1 - y0)) / 400)));
  const soft = (v, n) => { const f = Math.max(0, Math.min(n - 1, v * n - 0.5)), i = Math.min(n - 2, Math.floor(f)); return [i, f - i]; };
  let n = 0;
  for (let y = y0; y <= y1; y += step) for (let x = x0; x <= x1; x += step) {
    const i = (y * w + x) * 4, r = data[i], g = data[i + 1], b = data[i + 2], sum = r + g + b + 1;
    const [bi, bf] = soft(sum / 766, 3), [ri, rf] = soft(Math.min(1, (1.5 * r) / sum), 4), [gi, gf] = soft(Math.min(1, (1.5 * g) / sum), 4);
    for (let db = 0; db < 2; db++) for (let dr = 0; dr < 2; dr++) for (let dg = 0; dg < 2; dg++) {
      const wgt = (db ? bf : 1 - bf) * (dr ? rf : 1 - rf) * (dg ? gf : 1 - gf);
      if (wgt > 0) hist[((bi + db) * 4 + ri + dr) * 4 + gi + dg] += wgt;
    }
    n++;
  }
  if (n < 9) return null;
  for (let k = 0; k < HIST_BINS; k++) hist[k] /= n;
  return hist;
}
/** Hellinger / Bhattacharyya distance between two histograms: 0 = same colours, 1 = nothing in common */
export function histDist(a, b) {
  if (!a || !b) return null;
  let bc = 0; for (let k = 0; k < a.length; k++) bc += Math.sqrt(a[k] * b[k]);
  return Math.sqrt(Math.max(0, 1 - bc));
}

/**
 * Which candidate is the athlete we are following? `ref` = {box, lm, vx, vy} from the last frame we had him.
 * Score = overlap with where he should be now - distance - size change - pose-shape change. Candidates too far
 * away are rejected outright (that is someone else), with a gate that widens while he is lost.
 * Returns {i, score, iou, d, sh} or null.
 */
export const COLOUR_REJECT = 0.58;
export const LONG_LOSS = 10, REACQUIRE_COLOUR = 0.35;

export function matchCandidate(cands, ref, { W = 1, H = 1, lost = 0, why = null } = {}) {
  if (!ref || !cands?.length) return null;
  // predict where the athlete is now; extrapolate at most a few frames (a long loss must not fling the box off-screen)
  const steps = Math.min(lost + 1, 4);
  const pb = shift(ref.box, (ref.vx || 0) * steps, (ref.vy || 0) * steps);
  // lost for a while (10+ frames): position and size are stale, so re-acquire by clothing colour alone
  const long = lost >= LONG_LOSS;
  const diag = hyp(pb.w * W, pb.h * H) || 1;
  const gate = lost ? Math.min(2.5, 0.6 + 0.2 * lost) : 0.6;
  let best = null;
  cands.forEach((c, i) => {
    const io = iou(c.box, pb);
    const d = hyp((c.box.cx - pb.cx) * W, (c.box.cy - pb.cy) * H) / diag;
    const sz = Math.abs(Math.log((c.box.w * c.box.h + 1e-6) / (pb.w * pb.h + 1e-6)));
    const sh = ref.lm ? shapeDist(c.lm, ref.lm, W, H) : 0;
    const col = ref.hist && c.hist ? histDist(c.hist, ref.hist) : null;   // clothing colour
    if (why) why.push({ lost, io: +io.toFixed(2), d: +d.toFixed(2), gate: +gate.toFixed(2), sz: +sz.toFixed(2), col: col === null ? null : +col.toFixed(2), vx: +(ref.vx || 0).toFixed(4), vy: +(ref.vy || 0).toFixed(4) });
    if (long) {
      if (col === null ? cands.length > 1 : col > REACQUIRE_COLOUR) return;   // only a clear clothing match (or the only person)
      const score = -2 * (col ?? 0.2) - 0.1 * Math.min(d, 3) - 0.1 * sz;
      if (!best || score > best.score) best = { i, score, iou: io, d, sh, col, reacquire: true };
      return;
    }
    if (io < 0.15 && d > gate) return;
    if (sz > (lost ? 1.2 : 1.1)) return;
    if (col !== null && col > COLOUR_REJECT) return;                     // clearly different clothes = someone else
    const score = io - 0.8 * d - 0.25 * sz - 0.6 * sh - (col ?? 0.2) * 1.0;
    if (!best || score > best.score) best = { i, score, iou: io, d, sh, col };
  });
  return best;
}

/** Choose the athlete among the people in a frame: the one tapped, else the biggest, most central, clearest. */
export function pickAthlete(cands, { tap = null, W = 1, H = 1 } = {}) {
  if (!cands?.length) return -1;
  let best = -1, bs = -Infinity;
  cands.forEach((c, i) => {
    const b = c.box;
    let s;
    if (tap) {
      const pad = 0.03, inside = tap[0] >= b.x0 - pad && tap[0] <= b.x1 + pad && tap[1] >= b.y0 - pad && tap[1] <= b.y1 + pad;
      s = (inside ? 10 : 0) - hyp((tap[0] - b.cx) * W, (tap[1] - b.cy) * H) / (hyp(b.w * W, b.h * H) || 1) - (inside ? b.w * b.h : 0);
    } else {
      const off = Math.min(1, hyp(b.cx - 0.5, b.cy - 0.5) / 0.5);
      s = b.w * b.h * (1 - 0.6 * off) * meanVis(c.lm);
    }
    if (s > bs) { bs = s; best = i; }
  });
  return best;
}

/** follow-me state: last box + velocity (normalised units per frame) */
export function updateRef(ref, lm, gap = 1, hist = null) {
  const box = boxOf(lm);
  if (!ref) return { box, lm, vx: 0, vy: 0, hist, nHist: hist ? 1 : 0 };
  // the colour signature adapts slowly (lighting changes), only from confident matches
  let h = ref.hist || hist;
  // fast at first (average of the first ~10 looks: one frame with gloves over the shirt doesn't define him), then slow
  const nH = (ref.nHist || (ref.hist ? 1 : 0)) + (hist ? 1 : 0);
  if (ref.hist && hist && histDist(ref.hist, hist) < 0.5) { const a = nH <= 10 ? 1 / nH : 0.08; h = new Float32Array(ref.hist.length); for (let k = 0; k < h.length; k++) h[k] = (1 - a) * ref.hist[k] + a * hist[k]; }
  const g = Math.max(1, gap);
  const vx = ((box.cx - ref.box.cx) / g) * 0.5 + (ref.vx || 0) * 0.5, vy = ((box.cy - ref.box.cy) / g) * 0.5 + (ref.vy || 0) * 0.5;
  return { box, lm, vx: Math.max(-0.05, Math.min(0.05, vx)), vy: Math.max(-0.05, Math.min(0.05, vy)), hist: h, nHist: nH };
}

/**
 * Square crop (in source pixels) around the athlete for the next frame: the box grown by `margin`, at least
 * `minFrac` of the short side, smoothed so the crop doesn't jitter. Returns {x, y, s}.
 */
export function nextRoi(prevRoi, ref, SW, SH, { margin = 1.45, minFrac = 0.3, alpha = 0.6, lost = 0 } = {}) {
  const b = ref.box;
  const cx = (b.cx + (ref.vx || 0)) * SW, cy = (b.cy + (ref.vy || 0)) * SH;
  let s = Math.max(b.w * SW, b.h * SH) * margin * (1 + 0.25 * Math.min(lost, 4));
  s = Math.max(s, minFrac * Math.min(SW, SH));
  s = Math.min(s, Math.max(SW, SH) * 1.2);
  let x = cx - s / 2, y = cy - s / 2;
  if (prevRoi && !lost) {
    // smooth, but never let the athlete slip out of the crop
    s = prevRoi.s * (1 - alpha) + s * alpha;
    x = prevRoi.x * (1 - alpha) + (cx - s / 2) * alpha; y = prevRoi.y * (1 - alpha) + (cy - s / 2) * alpha;
  }
  return { x, y, s };
}
/** map landmarks found in a crop back to full-frame normalised coordinates */
export function uncrop(lm, roi, SW, SH) {
  return lm.map((p) => [(roi.x + p[0] * roi.s) / SW, (roi.y + p[1] * roi.s) / SH, (p[2] * roi.s) / SW, p[3]]);
}

// ---------------------------------------------------------------- clean-up
const torsoPx = (lm, W, H) => hyp(((lm[11][0] + lm[12][0]) / 2 - (lm[23][0] + lm[24][0]) / 2) * W, ((lm[11][1] + lm[12][1]) / 2 - (lm[23][1] + lm[24][1]) / 2) * H);
const d2 = (a, b, W, H) => hyp((a[0] - b[0]) * W, (a[1] - b[1]) * H);
const d3 = (a, b) => hyp(a[0] - b[0], a[1] - b[1], a[2] - b[2]);

export function clipTorso(frames, W, H) {
  return median(frames.filter((f) => f.lm && CORE4.every((k) => f.lm[k][3] > 0.5)).map((f) => torsoPx(f.lm, W, H))) || 0;
}

function swapPairs(f, pairs) {
  for (const key of ['lm', 'wlm']) if (f[key]) for (const [a, b] of pairs) { const t = f[key][a]; f[key][a] = f[key][b]; f[key][b] = t; }
  if (f.q) for (const [a, b] of pairs) f.q[a] = f.q[b] = Math.max(f.q[a], f.q[b], Q.SWAPPED);
}
/** does frame b look left/right swapped vs frame a (for this group)? */
function looksSwapped(a, b, test, W, H, T) {
  let direct = 0, crossed = 0;
  for (const [l, r] of test) {
    if (Math.min(a.lm[l][3], a.lm[r][3], b.lm[l][3], b.lm[r][3]) < 0.2) return false;
    direct += d2(a.lm[l], b.lm[l], W, H) + d2(a.lm[r], b.lm[r], W, H);
    crossed += d2(a.lm[l], b.lm[r], W, H) + d2(a.lm[r], b.lm[l], W, H);
  }
  return crossed < 0.5 * direct && direct / (2 * test.length) > 0.12 * T;
}
/**
 * The model sometimes flips left/right for a few frames (legs in a side view, the whole body when it can't tell
 * front from back). Fix flips that flip back within `maxLen` frames; a flip that persists is left alone.
 */
export function fixSwaps(F, W, H, T, maxLen = 10, stats = {}) {
  stats.swapsFixed ??= 0;
  for (const [name, g] of Object.entries(GROUPS)) {
    let i = 0;
    while (i < F.length) {
      if (!F[i].lm) { i++; continue; }
      let j = i + 1; while (j < F.length && !F[j].lm) j++;
      if (j >= F.length || j - i > 3 || !looksSwapped(F[i], F[j], g.test, W, H, T)) { i = j; continue; }
      // flip at j: look for the flip back
      let k = j, last = j, back = -1;
      for (let m = j + 1; m < F.length && m - j <= maxLen; m++) {
        if (!F[m].lm) continue;
        if (looksSwapped(F[last], F[m], g.test, W, H, T)) { back = m; break; }
        last = m;
      }
      if (back < 0) { i = j; continue; }
      for (k = j; k < back; k++) if (F[k].lm) { swapPairs(F[k], g.pairs); stats.swapsFixed++; }
      stats[name + 'Swaps'] = (stats[name + 'Swaps'] || 0) + 1;
      i = back;
    }
  }
}

/**
 * Mark implausible landmarks (q = REJECTED): limbs whose 3D length is far from this athlete's usual length,
 * limbs stretched in the picture beyond what that length allows, and one-frame jumps far from both neighbours
 * that also come with low confidence or a broken limb. Real fast punches/kicks keep their limb lengths, so
 * they survive.
 */
export function rejectOutliers(F, W, H, T, stats = {}, { boneTol = 0.4 } = {}) {
  stats.rejected ??= 0;
  const med3 = {}, scale = [];
  for (const [name, a, b] of BONES) med3[name] = median(F.filter((f) => f.wlm && f.lm && f.lm[a][3] > 0.5 && f.lm[b][3] > 0.5).map((f) => d3(f.wlm[a], f.wlm[b])));
  // px per metre from the torso (2D torso px / 3D torso m), per clip
  for (const f of F) if (f.lm && f.wlm && CORE4.every((k) => f.lm[k][3] > 0.5)) {
    const t3 = hyp(...[0, 1, 2].map((d) => (f.wlm[11][d] + f.wlm[12][d]) / 2 - (f.wlm[23][d] + f.wlm[24][d]) / 2));
    if (t3 > 0) scale.push(torsoPx(f.lm, W, H) / t3);
  }
  const pxPerM = median(scale);
  const reject = (f, k) => { if (f.q[k] !== Q.REJECTED) { f.q[k] = Q.REJECTED; stats.rejected++; } };
  F.forEach((f, i) => {
    if (!f.lm) return;
    for (const [name, a, b] of BONES) {
      const m = med3[name]; if (!m || Math.min(f.lm[a][3], f.lm[b][3]) < 0.3) continue;
      const bad3 = f.wlm && Math.abs(d3(f.wlm[a], f.wlm[b]) - m) / m > boneTol;
      const bad2 = pxPerM && d2(f.lm[a], f.lm[b], W, H) > (1 + boneTol) * m * pxPerM;
      if (bad3 || bad2) reject(f, f.lm[b][3] <= f.lm[a][3] || DISTAL[a] === b ? b : a);
    }
    // isolated spikes
    const p = F[i - 1], n = F[i + 1];
    if (!p?.lm || !n?.lm) return;
    for (let k = 0; k < 33; k++) {
      if (f.lm[k][3] < 0.3) continue;
      const mid = [(p.lm[k][0] + n.lm[k][0]) / 2, (p.lm[k][1] + n.lm[k][1]) / 2];
      const dev = d2(f.lm[k], mid, W, H) / T, span = d2(p.lm[k], n.lm[k], W, H) / T;
      const lim = FAST.has(k) ? 0.6 : MID.has(k) ? 0.4 : 0.25;
      if (dev > lim && dev > 2 * span && (f.lm[k][3] < 0.65 || f.q[k] === Q.REJECTED || !FAST.has(k))) reject(f, k);
    }
  });
  // hands follow their wrist: a rejected wrist takes its hand points with it
  for (const f of F) if (f.q) for (const [w, hs] of [[15, [17, 19, 21]], [16, [18, 20, 22]], [27, [29, 31]], [28, [30, 32]]]) if (f.q[w] === Q.REJECTED) for (const h of hs) reject(f, h);
}

/** fill short gaps (missing frames, rejected points) by linear interpolation; longer gaps stay empty */
export function fillGaps(F, maxGap, stats = {}) {
  stats.filled ??= 0; stats.framesFilled ??= 0;
  const good = (f, k) => f.lm && f.q[k] !== Q.REJECTED && f.q[k] !== Q.MISSING;
  for (let k = 0; k < 33; k++) {
    let last = -1;
    for (let i = 0; i < F.length; i++) {
      if (!good(F[i], k)) continue;
      if (last >= 0 && i - last > 1 && i - last - 1 <= maxGap) {
        const A = F[last], B = F[i];
        for (let j = last + 1; j < i; j++) {
          const u = (j - last) / (i - last), f = F[j];
          if (!f.lm) { f.lm = A.lm.map((p) => [p[0], p[1], p[2], 0]); f.wlm = A.wlm ? A.wlm.map((p) => p.slice()) : null; f.q = new Array(33).fill(Q.MISSING); f.filledFrame = true; stats.framesFilled++; }
          f.lm[k] = [0, 1, 2].map((d) => A.lm[k][d] + (B.lm[k][d] - A.lm[k][d]) * u).concat(Math.min(VIS_FILLED, A.lm[k][3], B.lm[k][3]));
          if (f.wlm && A.wlm && B.wlm) f.wlm[k] = [0, 1, 2].map((d) => A.wlm[k][d] + (B.wlm[k][d] - A.wlm[k][d]) * u).concat(f.lm[k][3]);
          f.q[k] = Q.FILLED; stats.filled++;
        }
      }
      last = i;
    }
  }
  for (const f of F) if (f.lm) for (let k = 0; k < 33; k++) {
    if (f.q[k] === Q.REJECTED) { f.lm[k][3] = Math.min(f.lm[k][3], VIS_REJECTED); if (f.wlm) f.wlm[k][3] = f.lm[k][3]; }
    if (f.q[k] === Q.MISSING) f.lm[k][3] = 0;
  }
}

/** One Euro filter (Casiez et al. 2012) over a series sampled at fps; xs may contain NaN breaks */
function oneEuro(xs, fps, { minCutoff, beta, dCutoff = 1.0 }, weights) {
  const out = xs.slice(), te = 1 / fps;
  const alpha = (c) => 1 / (1 + 1 / (2 * Math.PI * c * te));
  let px = NaN, pdx = 0;
  for (let i = 0; i < xs.length; i++) {
    const x = xs[i];
    if (!Number.isFinite(x)) { px = NaN; pdx = 0; continue; }
    if (!Number.isFinite(px)) { px = x; pdx = 0; out[i] = x; continue; }
    const dx = (x - px) * fps, ad = alpha(dCutoff), edx = ad * dx + (1 - ad) * pdx;
    const cut = (minCutoff + beta * Math.abs(edx)) * (weights ? 0.4 + 0.6 * weights[i] : 1);
    const a = alpha(cut), y = a * x + (1 - a) * px;
    out[i] = y; px = y; pdx = edx;
  }
  return out;
}
export const EURO = {
  core: { minCutoff: 1.4, beta: 0.6 },   // shoulders, hips, face
  mid: { minCutoff: 2.2, beta: 1.0 },    // elbows, knees
  fast: { minCutoff: 4.5, beta: 5.0 },   // wrists, hands, ankles, feet: punches and kicks must not lag
};
/** forward + backward One Euro = no lag (zero phase), possible because the analysis is offline */
export function smoothZeroPhase(F, W, H, T, fps, params = EURO) {
  for (let k = 0; k < 33; k++) {
    const P = FAST.has(k) ? params.fast : MID.has(k) ? params.mid : params.core;
    const vis = F.map((f) => (f.lm ? Math.max(0, Math.min(1, f.lm[k][3])) : 0));
    const run = (key, d, unit) => {
      const xs = F.map((f) => (f[key] ? f[key][k][d] / unit : NaN));
      const fw = oneEuro(xs, fps, P, vis);
      const bw = oneEuro(fw.slice().reverse(), fps, P, vis.slice().reverse()).reverse();
      F.forEach((f, i) => { if (f[key] && Number.isFinite(bw[i])) f[key][k][d] = bw[i] * unit; });
    };
    // positions in torso lengths so the speed-adaptive part works at any zoom
    run('lm', 0, T / W); run('lm', 1, T / H); run('lm', 2, T / W);
    run('wlm', 0, 0.5); run('wlm', 1, 0.5); run('wlm', 2, 0.5);
  }
}

/**
 * Full clean-up. frames: [{t, lm, wlm}] -> {frames (clean copy with q flags), stats}.
 * Order: L/R flips, implausible points, gap filling, zero-phase One Euro smoothing.
 */
export function cleanTrack(frames, meta, opt = {}) {
  const W = meta.width, H = meta.height, fps = meta.fps || 20;
  const o = { maxGapS: 0.3, swapMaxS: 0.5, boneTol: 0.4, smooth: true, euro: EURO, ...opt };
  const F = frames.map((f) => ({ t: f.t, lm: f.lm ? f.lm.map((p) => p.slice()) : null, wlm: f.wlm ? f.wlm.map((p) => p.slice()) : null, q: f.lm ? new Array(33).fill(Q.OK) : null }));
  const T = clipTorso(F, W, H);
  const stats = { torsoPx: Math.round(T) };
  if (!T) return { frames: F, stats };
  fixSwaps(F, W, H, T, Math.max(2, Math.round(o.swapMaxS * fps)), stats);
  rejectOutliers(F, W, H, T, stats, { boneTol: o.boneTol });
  fillGaps(F, Math.max(1, Math.round(o.maxGapS * fps)), stats);
  if (o.smooth) smoothZeroPhase(F, W, H, T, fps, o.euro);
  const round = (v) => Math.round(v * 10000) / 10000;
  for (const f of F) {
    if (f.lm) f.lm = f.lm.map((p) => p.map(round));
    if (f.wlm) f.wlm = f.wlm.map((p) => p.map(round));
    if (f.q) f.q = f.q.join('');   // compact: '0000200...'
    delete f.filledFrame;
  }
  return { frames: F, stats };
}

// ---------------------------------------------------------------- measures (no ground truth needed)
/**
 * jitter: mean |frame-to-frame acceleration| of shoulders/hips, % of torso length (lower = steadier);
 * boneCV: mean coefficient of variation of the 8 limb lengths in 3D (lower = more consistent skeleton);
 * swaps: frames that look left/right flipped vs the previous frame; jumps: frames where the hips jump more
 * than 0.6 torso in one frame (usually a switch to another person); found: share of frames with the athlete.
 */
export function trackMetrics(frames, meta) {
  const W = meta.width, H = meta.height;
  const T = clipTorso(frames, W, H) || 1;
  const acc = [];
  for (let i = 1; i + 1 < frames.length; i++) {
    const a = frames[i - 1].lm, b = frames[i].lm, c = frames[i + 1].lm;
    if (!a || !b || !c) continue;
    for (const k of CORE4) {
      if (Math.min(a[k][3], b[k][3], c[k][3]) < 0.5) continue;
      acc.push(hyp((a[k][0] - 2 * b[k][0] + c[k][0]) * W, (a[k][1] - 2 * b[k][1] + c[k][1]) * H) / T);
    }
  }
  const cvs = [];
  for (const [, a, b] of BONES) {
    const L = frames.filter((f) => f.wlm && f.lm && f.lm[a][3] > 0.5 && f.lm[b][3] > 0.5).map((f) => d3(f.wlm[a], f.wlm[b]));
    if (L.length < 5) continue;
    const m = L.reduce((s, x) => s + x, 0) / L.length;
    cvs.push(Math.sqrt(L.reduce((s, x) => s + (x - m) ** 2, 0) / L.length) / m);
  }
  let swaps = 0, jumps = 0;
  for (let i = 1; i < frames.length; i++) {
    const a = frames[i - 1], b = frames[i];
    if (!a.lm || !b.lm) continue;
    if (['arms', 'legs', 'body'].some((g) => looksSwapped(a, b, GROUPS[g].test, W, H, T))) swaps++;
    const ha = [(a.lm[23][0] + a.lm[24][0]) / 2, (a.lm[23][1] + a.lm[24][1]) / 2], hb = [(b.lm[23][0] + b.lm[24][0]) / 2, (b.lm[23][1] + b.lm[24][1]) / 2];
    if (d2(ha, hb, W, H) > 0.6 * T) jumps++;
  }
  const found = frames.filter((f) => f.lm).length;
  return {
    found: found / Math.max(1, frames.length),
    jitter: acc.length ? (100 * acc.reduce((s, x) => s + x, 0)) / acc.length : NaN,
    boneCV: cvs.length ? (100 * cvs.reduce((s, x) => s + x, 0)) / cvs.length : NaN,
    swaps, jumps,
    vis: found ? frames.filter((f) => f.lm).reduce((s, f) => s + meanVis(f.lm), 0) / found : 0,
  };
}

/**
 * Tracking quality 0-100 for the coach + filming tips. Uses the clean track's flags and the raw detections.
 * extra: {people: median number of people seen, luma: mean brightness 0-255}
 */
export function trackQuality(clean, meta, extra = {}) {
  const N = Math.max(1, clean.length), H = meta.height, W = meta.width;
  const withLm = clean.filter((f) => f.lm);
  const measured = withLm.filter((f) => !f.q || BODY12.filter((k) => f.q[k] === '0' || f.q[k] === '1').length >= 8);
  const coverage = measured.length / N;
  const vis = withLm.length ? withLm.reduce((s, f) => s + meanVis(f.lm), 0) / withLm.length : 0;
  let fixed = 0, total = 0;
  for (const f of withLm) if (f.q) for (const k of BODY12) { total++; if (f.q[k] === '2' || f.q[k] === '3') fixed++; }
  const fixFrac = total ? fixed / total : 0;
  const heights = withLm.map((f) => boxOf(f.lm).h).sort((a, b) => a - b);
  const size = heights.length ? heights[heights.length >> 1] : 0;
  const legs = withLm.length ? withLm.filter((f) => Math.min(f.lm[27][3], f.lm[28][3]) > 0.5).length / withLm.length : 0;
  const sizeF = Math.min(1, Math.sqrt(size / 0.4));
  const score = Math.round(100 * Math.pow(coverage, 0.7) * Math.min(1, vis / 0.85) * (1 - Math.min(0.5, 2 * fixFrac)) * (0.6 + 0.4 * sizeF));
  const tips = [];
  if (coverage < 0.85) tips.push('Keep the athlete in the picture for the whole clip (the app lost them in ' + Math.round(100 * (1 - coverage)) + '% of it).');
  if (size && size < 0.35) tips.push('Move closer: the athlete should fill at least half the height of the picture.');
  if (legs < 0.6 && size > 0) tips.push('Film head to toe: the feet were out of the picture or hidden much of the time.');
  if (vis < 0.75) tips.push('More light helps, and fitted clothes; avoid filming into a window or bright light.');
  if (extra.luma != null && extra.luma < 60) tips.push('The video is dark: turn on more lights or film facing away from the windows.');
  if (fixFrac > 0.06) tips.push('Keep the phone still (lean it on something) and film from 3-5 m away so the joints are easy to track.');
  if (extra.people > 1.5) tips.push('Other people were in the picture: a plain background helps, and tap your athlete when asked.');
  const level = score >= 80 ? 'good' : score >= 60 ? 'ok' : 'low';
  return { score, level, coverage: +coverage.toFixed(2), vis: +vis.toFixed(2), fixed: +fixFrac.toFixed(3), size: +size.toFixed(2), legs: +legs.toFixed(2), people: extra.people ?? null, luma: extra.luma ?? null, tips };
}
