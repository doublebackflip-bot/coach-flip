// Small vector helpers. Points are arrays; the last element (visibility) is ignored.
export const sub = (a, b) => a.slice(0, -1).map((v, i) => v - b[i]);
export const len = (v) => Math.hypot(...v);
export const dist = (a, b) => len(sub(a, b));
export const dot = (u, v) => u.reduce((s, x, i) => s + x * v[i], 0);
export const deg = (r) => (r * 180) / Math.PI;

/** angle ABC in degrees (works for 2D and 3D points) */
export function angle(a, b, c) {
  const u = sub(a, b), v = sub(c, b);
  const d = len(u) * len(v);
  if (!d) return NaN;
  return deg(Math.acos(Math.max(-1, Math.min(1, dot(u, v) / d))));
}

/** yaw (deg) of the line a->b in the horizontal plane of MediaPipe world coords (x, z) */
export const yaw = (a, b) => deg(Math.atan2(b[2] - a[2], b[0] - a[0]));

/** smallest signed difference between two angles in degrees */
export const angDiff = (a, b) => ((((b - a) % 360) + 540) % 360) - 180;

export const median = (xs) => {
  const s = xs.filter((x) => Number.isFinite(x)).sort((a, b) => a - b);
  if (!s.length) return NaN;
  const m = s.length >> 1;
  return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2;
};
export const mean = (xs) => { const s = xs.filter(Number.isFinite); return s.length ? s.reduce((a, b) => a + b, 0) / s.length : NaN; };
export const round = (x, d = 1) => (Number.isFinite(x) ? Math.round(x * 10 ** d) / 10 ** d : x);

/** signed perpendicular distance of p from line a->b (2D); positive = "above" in image (smaller y) side */
export function perpOffset2(p, a, b) {
  const dx = b[0] - a[0], dy = b[1] - a[1];
  const L = Math.hypot(dx, dy) || 1;
  // cross product z of (b-a) x (p-a)
  const cr = (dx * (p[1] - a[1]) - dy * (p[0] - a[0])) / L;
  // orient so positive means p lies above the line in the image (y up)
  return dx >= 0 ? -cr : cr;
}
