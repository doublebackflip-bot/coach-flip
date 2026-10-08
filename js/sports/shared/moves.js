// Shared movement helpers used by several sports: "foot became still" (plant), landings after a
// jump (soccer cut/land, jumping landing mechanics), and ballistic flights (take-offs).
import { dist, median } from '../../engine/geom.js';
import { D, at, maxOver, minOver, joint, valgusDeg, hi, lo, mk, LEGS } from '../../engine/kit.js';

/** first frame of the last "still" stretch of a named point before frame i (plant / foot contact) */
export function stillBefore(ctx, name, i, back, thr = 1.0) {
  const { poses } = ctx;
  const T = ctx.unit.torso2;
  let j = i;
  const v = (k) => { const p = poses[k], q = poses[k - 1]; return p && q && p.vis(name) >= 0.3 && q.vis(name) >= 0.3 ? (dist(p.p2(name), q.p2(name)) / T) * ctx.fps : NaN; };
  // walk back while the point is still (speed under thr torso/s)
  while (j > Math.max(1, i - back) && v(j) < thr) j--;
  if (j === i) {
    // point is moving at i: find the most recent still stretch
    let k = i;
    while (k > Math.max(1, i - back) && !(v(k) < thr)) k--;
    if (k <= Math.max(1, i - back)) return null;
    j = k;
    while (j > Math.max(1, i - back) && v(j) < thr) j--;
  }
  return j;
}

/** ground line (y px) = a high percentile of the lowest foot points over the clip (still camera) */
export function groundY(ctx) {
  if (ctx._groundY !== undefined) return ctx._groundY;
  const ys = [];
  let posed = 0;
  ctx.poses.forEach((p) => {
    if (!p) return; posed++;
    if (p.vis('left_ankle', 'right_ankle') >= 0.5) ys.push(Math.max(...['left_heel', 'right_heel', 'left_foot_index', 'right_foot_index', 'left_ankle', 'right_ankle'].map((n) => p.p2(n)[1])));
  });
  ys.sort((a, b) => a - b);
  // feet must be clearly visible in a good share of the clip, otherwise there is no floor reference
  return (ctx._groundY = ys.length >= Math.max(1, posed * 0.3) ? ys[Math.floor(ys.length * 0.9)] : NaN);
}
const footLow = (p) => Math.max(...['left_heel', 'right_heel', 'left_foot_index', 'right_foot_index', 'left_ankle', 'right_ankle'].map((n) => p.p2(n)[1]));

/** jumps in the clip: airborne stretches (both feet clearly above the ground line) with the
 * take-off (last ground frame before) and landing (first ground frame after) */
export function detectFlights(ctx, { air = 0.2, ground = 0.1, minAir = 0.08 } = {}) {
  const { poses, sec } = ctx;
  const T = ctx.unit.torso2, g = groundY(ctx);
  if (!Number.isFinite(g)) return [];
  const up = poses.map((p) => (p && p.vis('left_ankle', 'right_ankle') >= 0.3 ? (g - footLow(p)) / T : NaN));
  const out = [];
  let s = -1;
  for (let i = 0; i <= poses.length; i++) {
    const a = i < poses.length && up[i] > air;
    if (a && s < 0) s = i;
    if (!a && s >= 0) {
      const e = i - 1;
      if (e - s + 1 >= Math.max(1, sec(minAir))) {
        let to = s - 1; while (to > 0 && !(up[to] <= ground) && s - to < sec(0.3)) to--;
        let land = i; while (land < poses.length - 1 && !(up[land] <= ground) && land - e < sec(0.3)) land++;
        if (to >= 0 && land < poses.length && up[to] <= ground + 0.05 && up[land] <= ground + 0.05) out.push({ to, s, e, land, peakUp: Math.max(...up.slice(s, e + 1).filter(Number.isFinite)) });
      }
      s = -1;
    }
  }
  return out;
}

/** landing events: touchdown after a flight, absorption window, deepest knee bend */
export function detectLandings(ctx) {
  const ev = [];
  for (const f of detectFlights(ctx)) {
    const a = f.land, z = Math.min(ctx.poses.length - 1, f.land + ctx.sec(0.5));
    const deep = minOver(ctx, a, z, LEGS, (p) => Math.min(joint(p, 'left_hip', 'left_knee', 'left_ankle', ctx), joint(p, 'right_hip', 'right_knee', 'right_ankle', ctx)));
    ev.push({ type: 'landing', start: f.to, peak: a, land: a, end: z, deep: deep ? deep.i : a, takeoff: f.to, airFrames: f.e - f.s + 1 });
  }
  return ev;
}

/** knee valgus and knee bend checks on landings (front view / side view) */
export function landingChecks({ group, skill, cpValgus, cpFlex, fault, fault2, minFlexDefault = 45, valgusDefault = 12, note = '' }) {
  return [
    mk({
      id: group + '_valgus', group, scope: 'event:landing', priority: 1, views: ['front', 'rear'],
      kb: { skill, checkpoint: cpValgus, fault },
      label: 'Knee caves inward on landing', okLabel: 'Knees track over the toes on landing',
      needs: LEGS, visReason: 'Legs not visible - film from the front, whole body in frame',
      params: { max_deg: { value: valgusDefault, unit: 'deg', label: 'Knee may cave inward by', note: 'KB: frontal-plane knee angle < ~10-15 deg' } },
      thresholdText: (P) => `knees cave in less than ${P.max_deg} deg while absorbing the landing`,
      badness: (v, P) => hi(v, P, 'max_deg'),
      evaluate(e, ctx, P) {
        const b = maxOver(ctx, e.land, e.end, this.needs, (p) => Math.max(valgusDeg(p, 'left', ctx), valgusDeg(p, 'right', ctx))); if (!b) return null;
        const s = valgusDeg(b.p, 'left', ctx) >= valgusDeg(b.p, 'right', ctx) ? 'left' : 'right';
        return { value: b.v, pass: b.v <= P.max_deg, frame: b.i, text: `${s} knee caves in ${Math.round(b.v)}°`, draw: [D.line(b.p, s + '_hip', s + '_knee'), D.line(b.p, s + '_knee', s + '_ankle', `${Math.round(b.v)}°`), D.line(b.p, s + '_hip', s + '_ankle', 'hip-ankle line')] };
      },
    }),
    mk({
      id: group + '_flex', group, scope: 'event:landing', priority: 2,
      kb: { skill, checkpoint: cpFlex, fault: fault2 || fault },
      label: 'Stiff landing (little knee bend)', okLabel: 'Soft landing with knee bend',
      needs: LEGS, visReason: 'Legs not visible - film the whole body',
      params: { min_flex: { value: minFlexDefault, unit: 'deg', label: 'Knee flexion while absorbing at least', note: note || 'KB: knee flexion > ~45-60 deg (knee angle < ~120-135 deg)' } },
      thresholdText: (P) => `knees bend at least ${P.min_flex} deg (angle under ${180 - P.min_flex} deg) after touchdown`,
      badness: (v, P) => lo(v, P, 'min_flex'),
      evaluate(e, ctx, P) {
        const b = minOver(ctx, e.land, e.end, this.needs, (p) => Math.min(joint(p, 'left_hip', 'left_knee', 'left_ankle', ctx), joint(p, 'right_hip', 'right_knee', 'right_ankle', ctx))); if (!b) return null;
        const s = joint(b.p, 'left_hip', 'left_knee', 'left_ankle', ctx) <= joint(b.p, 'right_hip', 'right_knee', 'right_ankle', ctx) ? 'left' : 'right';
        const flex = 180 - b.v;
        return { value: flex, pass: flex >= P.min_flex, frame: b.i, text: `knees bend only ${Math.round(flex)}°`, draw: [D.ang(b.p, s + '_hip', s + '_knee', s + '_ankle', `${Math.round(b.v)}°`)] };
      },
    }),
  ];
}
