// Camera angle from the body itself (v0.5). MediaPipe's world landmarks are hip-centred metres with x to the
// image right, y down and z AWAY from the camera, so the direction the chest faces and which shoulder is nearer
// the camera can be read from any single frame. Used by sports that don't read the view from the movement
// (boxing reads it from the punches) to switch to the view that was really filmed, or to mark view-dependent
// checks "not clear enough to judge" when the camera is behind the athlete or at a 3/4 angle.
import { median } from './geom.js';

const D = 180 / Math.PI;
const okTorso = (p, minVis = 0.5) => p && p.p3('left_shoulder') && p.vis('left_shoulder', 'right_shoulder', 'left_hip', 'right_hip') >= minVis;

/** body yaw in degrees: 0 = chest to the camera, ±90 = profile (+ = facing image right), ±180 = back to the camera */
export function bodyYaw(p) {
  if (!okTorso(p)) return NaN;
  const L = p.p3('left_shoulder'), R = p.p3('right_shoulder'), LH = p.p3('left_hip'), RH = p.p3('right_hip');
  const a = [0, 1, 2].map((k) => (L[k] - R[k]) + 0.5 * (LH[k] - RH[k]));             // across the body (right -> left)
  const up = [0, 1, 2].map((k) => (L[k] + R[k] - LH[k] - RH[k]) / 2);                 // hips -> shoulders
  const n = [a[1] * up[2] - a[2] * up[1], a[2] * up[0] - a[0] * up[2], a[0] * up[1] - a[1] * up[0]];   // chest normal
  return Math.atan2(n[0], -n[2]) * D;
}

/** angle (deg) of the line a -> b out of the picture plane: 0 = across the picture, +90 = b straight away from
 *  the camera, -90 = b straight toward the camera */
export function lineDepthAngle(p, a, b) {
  const A = p?.p3(a), B = p?.p3(b); if (!A || !B) return NaN;
  return Math.atan2(B[2] - A[2], Math.abs(B[0] - A[0])) * D;
}

/** generic camera view from the chest direction: 'front' (chest to camera), 'side' (profile), 'rear' (back to the
 *  camera) or 'angled' (3/4). Needs a clear majority of frames; otherwise class = null (leave the user's pick). */
export function bodyView(ctx, { from = 0, to = ctx.poses.length - 1, share = 0.6 } = {}) {
  const ys = [];
  for (let i = Math.max(0, from); i <= Math.min(ctx.poses.length - 1, to); i++) { const y = bodyYaw(ctx.poses[i]); if (Number.isFinite(y)) ys.push(Math.abs(y)); }
  if (ys.length < 5) return null;
  const cls = (a) => (a <= 30 ? 'front' : a >= 60 && a <= 120 ? 'side' : a >= 150 ? 'rear' : 'angled');
  const count = {}; for (const a of ys) count[cls(a)] = (count[cls(a)] || 0) + 1;
  const [best, n] = Object.entries(count).sort((x, y) => y[1] - x[1])[0];
  const yaw = median(ys);
  // degrees off the nearest square-on view (front 0, side 90, rear 180)
  const off = Math.round(Math.min(Math.abs(yaw), Math.abs(yaw - 90), Math.abs(180 - yaw)));
  return { yaw: Math.round(yaw), angle: off, class: n / ys.length >= share ? best : null, share: Math.round((100 * n) / ys.length) / 100, n: ys.length, basis: 'body' };
}
