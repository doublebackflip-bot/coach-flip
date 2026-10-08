// MediaPipe Pose (33 landmarks) names + role mapping (lead/rear, mid points, chin, fist).
// Sport-agnostic: role prefixes come from the sport module (e.g. boxing lead/rear,
// softball throw/glove); the KB uses the same role-prefixed names.

export const MP_INDEX = {
  nose: 0, left_eye_inner: 1, left_eye: 2, left_eye_outer: 3, right_eye_inner: 4, right_eye: 5,
  right_eye_outer: 6, left_ear: 7, right_ear: 8, mouth_left: 9, mouth_right: 10,
  left_shoulder: 11, right_shoulder: 12, left_elbow: 13, right_elbow: 14, left_wrist: 15,
  right_wrist: 16, left_pinky: 17, right_pinky: 18, left_index: 19, right_index: 20,
  left_thumb: 21, right_thumb: 22, left_hip: 23, right_hip: 24, left_knee: 25, right_knee: 26,
  left_ankle: 27, right_ankle: 28, left_heel: 29, right_heel: 30, left_foot_index: 31,
  right_foot_index: 32,
};

export const SKELETON = [
  [11, 12], [11, 13], [13, 15], [12, 14], [14, 16], [11, 23], [12, 24], [23, 24],
  [23, 25], [25, 27], [24, 26], [26, 28], [27, 29], [29, 31], [27, 31], [28, 30], [30, 32], [28, 32],
  [15, 19], [15, 17], [17, 19], [16, 20], [16, 18], [18, 20], [9, 10],
];

const avg = (pts) => {
  const n = pts.length, d = pts[0].length, out = new Array(d).fill(0);
  for (const p of pts) for (let i = 0; i < d; i++) out[i] += p[i] / n;
  out[d - 1] = Math.min(...pts.map((p) => p[d - 1])); // visibility = weakest link
  return out;
};

/**
 * Wrap one frame of raw landmarks so rules can ask for role names like
 * 'lead_wrist', 'rear_heel', 'mid_hip', 'chin', 'lead_fist'.
 *   raw.lm  : 33 x [x, y, z, visibility] normalised image coords
 *   raw.wlm : 33 x [x, y, z, visibility] world coords (metres, hip-centred)
 * p2() returns [xPx, yPx, vis] in an isotropic pixel space (x*W, y*H) so
 * distances/angles are not distorted by the aspect ratio.
 * p3() returns [x, y, z, vis] world metres (y down, like MediaPipe).
 */
export class Pose {
  constructor(raw, meta, roles) {
    this.raw = raw; this.W = meta.width; this.H = meta.height; this.roles = roles; this.t = raw.t;
    this._c2 = {}; this._c3 = {};
  }
  get ok() { return !!this.raw.lm; }
  _side(name) {
    // role prefix -> left/right
    for (const [role, side] of Object.entries(this.roles)) {
      if (name.startsWith(role + '_')) return side + name.slice(role.length);
    }
    return name;
  }
  _get(arr, name, is2) {
    const n = this._side(name);
    if (n in MP_INDEX) {
      const p = arr[MP_INDEX[n]];
      return is2 ? [p[0] * this.W, p[1] * this.H, p[3]] : [p[0], p[1], p[2], p[3]];
    }
    const g = (x) => this._get(arr, x, is2);
    const side = n.startsWith('left_') ? 'left' : n.startsWith('right_') ? 'right' : null;
    const base = side ? n.slice(side.length + 1) : n;
    switch (base) {
      case 'mid_hip': return avg([g('left_hip'), g('right_hip')]);
      case 'mid_shoulder': return avg([g('left_shoulder'), g('right_shoulder')]);
      case 'mid_ankle': return avg([g('left_ankle'), g('right_ankle')]);
      case 'mid_ear': return avg([g('left_ear'), g('right_ear')]);
      case 'mouth': return avg([g('mouth_left'), g('mouth_right')]);
      case 'chin': {
        // chin is not a MediaPipe point: extrapolate from nose -> mouth (mouth-to-chin ~1.2x nose-to-mouth)
        const m = g('mouth'), no = g('nose');
        const c = m.map((v, i) => (i === m.length - 1 ? Math.min(m[i], no[i]) : v + (v - no[i]) * 1.2));
        // sanity: a "chin" far below where the eyes put it (or below the shoulder line) means the mouth/nose
        // points were guessed (face covered by a glove/arm, or turned away) -> keep the point, but mark it unsure
        const sh = g('mid_shoulder'), hp = g('mid_hip');
        const torso = Math.hypot(sh[0] - hp[0], sh[1] - hp[1]);
        // eyes are rarely covered by the gloves; eyes-to-chin is ~0.22 torso lengths
        const ey = (g('left_eye')[1] + g('right_eye')[1]) / 2;
        if (torso > 0 && (c[1] - (ey + 0.22 * torso) > 0.12 * torso || c[1] > sh[1] + 0.02 * torso)) c[c.length - 1] = Math.min(c[c.length - 1], 0.3);
        return c;
      }
      case 'fist': {
        // glove/fist centre = halfway between wrist and knuckles (index/pinky points)
        const w = g(side + '_wrist'), k = avg([g(side + '_index'), g(side + '_pinky')]);
        return w.map((v, i) => (i === w.length - 1 ? Math.min(w[i], k[i]) : (v + k[i]) / 2));
      }
      default: throw new Error('Unknown landmark ' + name);
    }
  }
  p2(name) { return this._c2[name] ??= this._get(this.raw.lm, name, true); }
  p3(name) {
    if (!this.raw.wlm) return null;
    return this._c3[name] ??= this._get(this.raw.wlm, name, false);
  }
  /** normalised [0..1] image coords for drawing */
  n(name) { const p = this.p2(name); return [p[0] / this.W, p[1] / this.H]; }
  vis(...names) { return Math.min(...names.map((n) => this.p2(n).at(-1))); }
}

/** Light temporal smoothing (centred moving average) - reduces landmark jitter. */
export function smoothFrames(frames, win) {
  if (!win || win < 2) return frames;
  const h = Math.floor(win / 2);
  return frames.map((f, i) => {
    if (!f.lm) return f;
    const nb = [];
    for (let j = Math.max(0, i - h); j <= Math.min(frames.length - 1, i + h); j++) if (frames[j].lm) nb.push(frames[j]);
    const sm = (key) => f[key] && f[key].map((p, k) => {
      const out = [0, 0, 0, p[3]]; let n = 0;
      for (const o of nb) { if (!o[key]) continue; n++; for (let d = 0; d < 3; d++) out[d] += o[key][k][d]; }
      for (let d = 0; d < 3; d++) out[d] /= n;
      return out;
    });
    return { ...f, lm: sm('lm'), wlm: sm('wlm') };
  });
}
