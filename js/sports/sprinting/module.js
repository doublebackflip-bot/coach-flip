// Sprinting rules: block start, acceleration, max velocity. Side view (perpendicular to the lane)
// for almost everything; front view only for the arm-crossing check.
// Foot contacts come from the lowest foot points (kit.footContacts); the direction of travel from
// which way the toes/nose point. All checks are estimates from 2D pose -> BETA unless noted.
import { dist, median } from '../../engine/geom.js';
import {
  D, r1, r2, hi, lo, band, at, maxOver, minOver, ang2, joint, facing, trunkLean, leanDeg, thighBelowHorizontal, ahead,
  footContacts, completeContacts, cadence, legsOk, medianSign, baseGlobals, mk, other, mid2, dotAt, segAt, LEGS, HIPS, SHOULDERS, TRUNK,
} from '../../engine/kit.js';

const T = (ctx) => ctx.unit.torso2;
const sk = (id) => 'sp-' + id;
const LEG = (s) => [s + '_hip', s + '_knee', s + '_ankle'];
const kneeAng = (p, s) => ang2(p, s + '_hip', s + '_knee', s + '_ankle');

// ---------------------------------------------------------------- events
export function runDir(ctx) {
  // travel direction: mostly where the toes/nose point; fall back to hip displacement
  return medianSign(ctx, ['nose', 'left_foot_index', 'right_foot_index', 'left_heel', 'right_heel'], (p) => facing(p));
}
export function steps(ctx, opts = {}) {
  const { poses } = ctx;
  const N = poses.length;
  const fc = footContacts(ctx, { tol: ctx.G.contact_tol, win: 0.6, minFrames: 1, ...opts });
  ctx.contacts = fc.contacts; ctx.ground = fc.ground;
  const evs = [];
  const posedIdx = poses.map((p, i) => (p ? i : -1)).filter((i) => i >= 0);
  const first = posedIdx[0] ?? 0, last = posedIdx.at(-1) ?? N - 1;
  const raw = fc.contacts.filter((c) => c.start > first); // touchdown must be seen
  // Two touchdowns closer than 0.15 s are physically impossible (even elite sprinters need ~0.2 s
  // per step): it's tracking noise (e.g. legs hidden behind a treadmill rail), so keep only the longer of the two.
  const cs = [];
  for (const c of raw) {
    const prev = cs.at(-1);
    if (prev && c.start - prev.start < Math.max(2, ctx.sec(0.15))) { if (c.end - c.start > prev.end - prev.start) cs[cs.length - 1] = { ...c }; continue; }
    cs.push({ ...c });
  }
  cs.forEach((c, k) => {
    const next = cs.slice(k + 1).find((d) => d.side !== c.side);
    evs.push({ type: 'step', side: c.side, start: c.start, end: Math.min(N - 1, c.end), peak: c.start, td: c.start, to: c.end, mid: c.mid,
      complete: c.end < last - 1 && c.end > c.start, nextTd: next ? next.start : null, n: k + 1 });
  });
  return evs;
}
function setFrames(ctx) {
  // block "set": hands on the track (wrists near foot level), body still-ish
  const out = [];
  ctx.poses.forEach((p, i) => {
    if (!p || p.vis('left_wrist', 'right_wrist', ...HIPS, ...SHOULDERS) < 0.3) return;
    const wy = Math.max(p.p2('left_wrist')[1], p.p2('right_wrist')[1]);
    const fy = Math.max(p.p2('left_ankle')[1], p.p2('right_ankle')[1], p.p2('left_foot_index')[1], p.p2('right_foot_index')[1]);
    const handsDown = fy - wy <= 0.45 * T(ctx);
    const hipsUp = p.p2('mid_hip')[1] < p.p2('mid_shoulder')[1] + 0.35 * T(ctx); // crouched: hips at shoulder level or higher
    if (handsDown && hipsUp) out.push(i);
  });
  return out;
}

// ---------------------------------------------------------------- checks
const SIDE = ['side'];
const checks = [
  // ---- set position (frames; a photo of the set position works)
  mk({
    id: 'sp_set_hips', group: 'set', scope: 'frames:set', priority: 2, views: SIDE,
    kb: { skill: sk('block-start'), checkpoint: 'sp-block-start-c01', fault: null, drills: ['SP-D-BLOCK-3STEP'] },
    coach: { cue: "'Set: hips up just above the shoulders, shoulders over your hands.'", why: 'Hips slightly higher than the shoulders put both legs at effective push angles and load the hands with some weight, so the first push is horizontal (World Athletics / USATF block-start teaching).' },
    label: 'Set position: hips too low', okLabel: 'Hips above the shoulders in "set"',
    needs: [...HIPS, ...SHOULDERS],
    params: { min_rise: { value: 0.0, unit: 'x torso', label: 'Hips must be higher than the shoulders by', note: 'KB: hips slightly above shoulder height' } },
    thresholdText: (P) => `hips at least ${P.min_rise}x torso above the shoulders in the set position`,
    badness: (v, P) => lo(v, P, 'min_rise'),
    measure(p, ctx, P) {
      const v = (p.p2('mid_shoulder')[1] - p.p2('mid_hip')[1]) / T(ctx);
      return { value: v, pass: v >= P.min_rise, text: v >= P.min_rise ? 'hips above shoulders' : `hips ${r1(-v)}x torso below the shoulders`, draw: [D.line(p, 'mid_hip', 'mid_shoulder', 'hips vs shoulders'), D.level(p, 'mid_shoulder', ctx, 'shoulder height', 5)] };
    },
  }),
  mk({
    id: 'sp_set_knees', group: 'set', scope: 'frames:set', priority: 3, views: SIDE,
    kb: { skill: sk('block-start'), checkpoint: 'sp-block-start-c02', fault: null, drills: ['SP-D-BLOCK-3STEP'] },
    coach: { cue: "'Front knee about 90, back knee about 120-130.'", why: 'These knee angles in "set" let both legs push hard and fast; much smaller angles are slow to extend, much bigger ones give a short push (block-start research summarised in the KB).' },
    label: 'Set position: knee angles off', okLabel: 'Knee angles OK in "set"',
    needs: LEGS, visReason: 'Legs not visible - film from the side, whole body in frame',
    params: {
      front_min: { value: 75, unit: 'deg', label: 'Front knee at least' }, front_max: { value: 115, unit: 'deg', label: 'Front knee at most', note: 'KB: ~85-100 deg' },
      rear_min: { value: 100, unit: 'deg', label: 'Rear knee at least' }, rear_max: { value: 150, unit: 'deg', label: 'Rear knee at most', note: 'KB: ~110-135 deg' },
    },
    thresholdText: (P) => `front knee ${P.front_min}-${P.front_max} deg, rear knee ${P.rear_min}-${P.rear_max} deg`,
    badness: (v) => v,
    measure(p, ctx, P) {
      const dir = ctx.dir;
      const front = (p.p2('left_ankle')[0] - p.p2('right_ankle')[0]) * dir > 0 ? 'left' : 'right', rear = other(front);
      const f = kneeAng(p, front), r = kneeAng(p, rear);
      const bad = Math.max(P.front_min - f, f - P.front_max, P.rear_min - r, r - P.rear_max);
      return { value: bad, pass: bad <= 0, text: `front knee ${Math.round(f)}°, rear ${Math.round(r)}°`, draw: [D.ang(p, front + '_hip', front + '_knee', front + '_ankle', `front ${Math.round(f)}°`), D.ang(p, rear + '_hip', rear + '_knee', rear + '_ankle', `rear ${Math.round(r)}°`)] };
    },
  }),
  // ---- block exit + first step (event 'exit')
  mk({
    id: 'sp_exit_extension', group: 'exit', scope: 'event:exit', priority: 3, temporal: true, views: SIDE,
    kb: { skill: sk('block-start'), checkpoint: 'sp-block-start-c03', fault: 'sp-block-start-f03' },
    label: 'Incomplete push off the block', okLabel: 'Full leg extension leaving the blocks',
    needs: LEGS,
    params: { min_knee: { value: 155, unit: 'deg', label: 'Push leg knee at block exit at least', note: 'KB: near-full extension at block exit' } },
    thresholdText: (P) => `push leg extends to ${P.min_knee} deg or more leaving the blocks`,
    badness: (v, P) => lo(v, P, 'min_knee'),
    evaluate(e, ctx, P) {
      const b = maxOver(ctx, e.start, e.exitEnd, this.needs, (p) => Math.max(kneeAng(p, 'left'), kneeAng(p, 'right'))); if (!b) return null;
      const s = kneeAng(b.p, 'left') >= kneeAng(b.p, 'right') ? 'left' : 'right';
      return { value: b.v, pass: b.v >= P.min_knee, frame: b.i, text: `push knee only ${Math.round(b.v)}°`, draw: [D.ang(b.p, s + '_hip', s + '_knee', s + '_ankle', `${Math.round(b.v)}°`), D.line(b.p, s + '_ankle', 'mid_shoulder', 'push line')] };
    },
  }),
  mk({
    id: 'sp_exit_popup', group: 'exit', scope: 'event:exit', priority: 1, temporal: true, views: SIDE,
    kb: { skill: sk('block-start'), checkpoint: 'sp-acceleration-c01', fault: 'sp-block-start-f01' },
    label: 'Popping up out of the blocks', okLabel: 'Stayed low into the first step',
    needs: TRUNK,
    params: { min_lean: { value: 30, unit: 'deg', label: 'Trunk lean at the first touchdown at least', note: 'KB: ~45 deg at step 1, rising gradually' } },
    thresholdText: (P) => `trunk leans forward ${P.min_lean} deg or more at the first touchdown`,
    badness: (v, P) => lo(v, P, 'min_lean'),
    evaluate(e, ctx, P) {
      if (e.td1 == null) return null;
      const p = at(ctx, e.td1, this.needs); if (!p) return null;
      const v = trunkLean(p, ctx.dir);
      return { value: v, pass: v >= P.min_lean, frame: e.td1, text: `trunk ${Math.round(v)}° at first step`, draw: [D.line(p, 'mid_hip', 'mid_shoulder', `${Math.round(v)}° lean`), D.vert(p, 'mid_hip', ctx, 'vertical', -1.2)] };
    },
  }),
  mk({
    id: 'sp_first_step', group: 'exit', scope: 'event:exit', priority: 2, temporal: true, views: SIDE,
    kb: { skill: sk('block-start'), checkpoint: 'sp-block-start-c04', fault: 'sp-block-start-f02' },
    label: 'Reaching with the first step', okLabel: 'First step lands under/behind the hips',
    needs: [...HIPS, 'left_ankle', 'right_ankle'],
    params: { max_ahead: { value: 0.15, unit: 'x torso', label: 'First touchdown ankle may be ahead of the hips by', note: 'KB: at or behind the hip vertical' } },
    thresholdText: (P) => `first touchdown no more than ${P.max_ahead}x torso in front of the hips`,
    badness: (v, P) => hi(v, P, 'max_ahead'),
    evaluate(e, ctx, P) {
      if (e.td1 == null) return null;
      const p = at(ctx, e.td1, this.needs); if (!p) return null;
      const v = ahead(p, e.td1Side + '_ankle', 'mid_hip', ctx.dir, ctx);
      return { value: v, pass: v <= P.max_ahead, frame: e.td1, text: `foot ${r1(v)}x torso ahead of hips`, draw: [D.vert(p, 'mid_hip', ctx, 'hips', -1.4), D.dot(p, e.td1Side + '_ankle', 'touchdown')] };
    },
  }),
  // ---- acceleration (per step)
  mk({
    id: 'sp_acc_reach', group: 'accel', scope: 'event:step', priority: 1, views: SIDE,
    kb: { skill: sk('acceleration'), checkpoint: 'sp-acceleration-c03', fault: 'sp-acceleration-f01' },
    label: 'Reaching / overstriding in the drive phase', okLabel: 'Feet land under the hips',
    needs: [...HIPS, 'left_ankle', 'right_ankle'],
    params: { max_ahead: { value: 0.25, unit: 'x torso', label: 'Touchdown ankle may be ahead of the hips by', note: 'KB: at or slightly behind the hip vertical in the first 6-8 steps' } },
    thresholdText: (P) => `touchdown no more than ${P.max_ahead}x torso in front of the hips`,
    badness: (v, P) => hi(v, P, 'max_ahead'),
    evaluate(e, ctx, P) {
      const p = at(ctx, e.td, this.needs); if (!p) return null;
      const v = ahead(p, e.side + '_ankle', 'mid_hip', ctx.dir, ctx);
      return { value: v, pass: v <= P.max_ahead, frame: e.td, text: `foot ${r1(v)}x torso ahead of hips`, draw: [D.vert(p, 'mid_hip', ctx, 'hips', -1.4), D.dot(p, e.side + '_ankle', 'touchdown')] };
    },
  }),
  mk({
    id: 'sp_acc_waist', group: 'accel', scope: 'event:step', priority: 2, views: SIDE,
    kb: { skill: sk('acceleration'), checkpoint: 'sp-acceleration-c01', fault: 'sp-acceleration-f03' },
    label: 'Bent at the waist', okLabel: 'Push leg, hips and trunk in line',
    needs: [...SHOULDERS, ...HIPS, 'left_ankle', 'right_ankle'],
    params: { min_line: { value: 155, unit: 'deg', label: 'Shoulder-hip-ankle angle at toe-off at least', note: 'KB: push leg, trunk and head roughly in line' } },
    thresholdText: (P) => `shoulder-hip-ankle line ${P.min_line} deg or straighter at toe-off`,
    badness: (v, P) => lo(v, P, 'min_line'),
    evaluate(e, ctx, P) {
      if (!e.complete) return null;
      const p = at(ctx, e.to, this.needs); if (!p) return null;
      const v = ang2(p, 'mid_shoulder', 'mid_hip', e.side + '_ankle');
      return { value: v, pass: v >= P.min_line, frame: e.to, text: `body line ${Math.round(v)}°`, draw: [D.ang(p, 'mid_shoulder', 'mid_hip', e.side + '_ankle', `${Math.round(v)}°`)] };
    },
  }),
  mk({
    id: 'sp_bounce', group: 'accel', scope: 'clip', priority: 4, temporal: true, views: SIDE,
    kb: { skill: sk('acceleration'), checkpoint: 'sp-acceleration-c01', fault: 'sp-acceleration-f02' },
    label: 'Too much vertical bounce', okLabel: 'Little vertical bounce',
    needs: HIPS,
    params: { max_osc: { value: 0.25, unit: 'x torso', label: 'Hip rise and fall per step at most' } },
    thresholdText: (P) => `hips rise and fall less than ${P.max_osc}x torso per step`,
    badness: (v, P) => hi(v, P, 'max_osc'),
    evaluateClip(ctx, P) { return bounce(ctx, P, this); },
  }),
  // ---- max velocity
  mk({
    id: 'sp_mv_trunk', group: 'maxv', scope: 'frames:run', priority: 3, views: SIDE,
    kb: { skill: sk('max-velocity'), checkpoint: 'sp-max-velocity-c01', fault: null, drills: ['SP-D-WICKET'] },
    coach: { cue: "'Run tall - head over shoulders over hips.'", why: 'At top speed the trunk should be near vertical; leaning forward or back changes where the foot lands and shortens the front-side swing (KB: trunk within ~5-10 deg of vertical).' },
    label: 'Trunk not tall at top speed', okLabel: 'Tall, near-vertical trunk',
    needs: TRUNK,
    params: { min_lean: { value: -5, unit: 'deg', label: 'Trunk lean at least (negative = leaning back)' }, max_lean: { value: 15, unit: 'deg', label: 'Trunk lean at most (forward)', note: 'KB: within ~5-10 deg of vertical; margin for tracking' } },
    thresholdText: (P) => `trunk between ${P.min_lean} and ${P.max_lean} deg from vertical`,
    badness: (v, P) => band(v, P, 'min_lean', 'max_lean'),
    measure(p, ctx, P) {
      const v = trunkLean(p, ctx.dir);
      const what = v < P.min_lean ? 'leaning back' : v > P.max_lean ? 'leaning forward' : 'tall';
      return { value: v, pass: what === 'tall', text: `${what} (${Math.round(v)}°)`, draw: [D.line(p, 'mid_hip', 'mid_shoulder', `${Math.round(v)}°`), D.vert(p, 'mid_hip', ctx, 'vertical', -1.2)] };
    },
  }),
  mk({
    id: 'sp_mv_overstride', group: 'maxv', scope: 'event:step', priority: 1, views: SIDE,
    kb: { skill: sk('max-velocity'), checkpoint: 'sp-max-velocity-c02', fault: 'sp-max-velocity-f01' },
    label: 'Overstriding at top speed', okLabel: 'Foot lands close under the hips',
    needs: [...HIPS, 'left_ankle', 'right_ankle'],
    params: { max_ahead: { value: 0.7, unit: 'x torso', label: 'Touchdown ankle may be ahead of the hips by', note: 'KB: < ~30-40 cm at elite speed (~0.6-0.8 torso)' } },
    thresholdText: (P) => `touchdown no more than ${P.max_ahead}x torso in front of the hips`,
    badness: (v, P) => hi(v, P, 'max_ahead'),
    evaluate(e, ctx, P) {
      const p = at(ctx, e.td, this.needs); if (!p) return null;
      const v = ahead(p, e.side + '_ankle', 'mid_hip', ctx.dir, ctx);
      return { value: v, pass: v <= P.max_ahead, frame: e.td, text: `foot ${r1(v)}x torso ahead of hips`, draw: [D.vert(p, 'mid_hip', ctx, 'hips', -1.4), segAt(p, [p.p2('mid_hip')[0], p.p2(e.side + '_ankle')[1]], p.p2(e.side + '_ankle'), 'reach')] };
    },
  }),
  mk({
    id: 'sp_mv_hips', group: 'maxv', scope: 'event:step', priority: 2, views: SIDE,
    kb: { skill: sk('max-velocity'), checkpoint: 'sp-max-velocity-c01', fault: 'sp-max-velocity-f02' },
    label: 'Sitting (low hips) in stance', okLabel: 'Hips high at mid-stance',
    needs: LEGS,
    params: { min_knee: { value: 135, unit: 'deg', label: 'Stance knee at mid-stance at least', note: 'Proxy for hip height: a deeply bent stance knee = sitting' } },
    thresholdText: (P) => `stance knee ${P.min_knee} deg or straighter at mid-stance`,
    badness: (v, P) => lo(v, P, 'min_knee'),
    evaluate(e, ctx, P) {
      if (!e.complete) return null;
      // middle third of the stance, ignoring frames where the legs look collapsed (tracking glitch)
      const a = e.td + Math.floor((e.to - e.td) / 3), z = e.to - Math.floor((e.to - e.td) / 3);
      const vals = [];
      for (let i = a; i <= z; i++) { const p = at(ctx, i, this.needs); if (p && legsOk(ctx, i)) vals.push({ v: kneeAng(p, e.side), i, p }); }
      if (!vals.length) return null;
      vals.sort((x, y) => x.v - y.v);
      const b = vals[Math.floor(vals.length / 2)];
      return { value: b.v, pass: b.v >= P.min_knee, frame: b.i, text: `stance knee ${Math.round(b.v)}°`, draw: [D.ang(b.p, e.side + '_hip', e.side + '_knee', e.side + '_ankle', `${Math.round(b.v)}°`)] };
    },
  }),
  mk({
    id: 'sp_mv_frontside', group: 'maxv', scope: 'event:step', priority: 3, views: SIDE,
    kb: { skill: sk('max-velocity'), checkpoint: 'sp-max-velocity-c04', fault: 'sp-max-velocity-f02' },
    label: 'Low knee drive (back-side mechanics)', okLabel: 'Swing thigh comes through high',
    needs: LEGS,
    params: { max_below: { value: 40, unit: 'deg', label: 'Swing thigh at most this far below horizontal (at toe-off)', note: 'KB: swing thigh approaches horizontal at opposite toe-off' } },
    thresholdText: (P) => `swing thigh within ${P.max_below} deg of horizontal at toe-off`,
    badness: (v, P) => hi(v, P, 'max_below'),
    evaluate(e, ctx, P) {
      if (!e.complete) return null;
      const s = other(e.side);
      const b = minOver(ctx, e.to - 1, e.to + ctx.sec(0.06), this.needs, (p) => thighBelowHorizontal(p, s, ctx.dir), (i) => !legsOk(ctx, i)); if (!b) return null;
      return { value: b.v, pass: b.v <= P.max_below, frame: b.i, text: `swing thigh ${Math.round(b.v)}° below horizontal`, draw: [D.line(b.p, s + '_hip', s + '_knee', `${Math.round(b.v)}°`), D.level(b.p, s + '_hip', ctx, 'horizontal', 4)] };
    },
  }),
  mk({
    id: 'sp_mv_contact', group: 'maxv', scope: 'event:step', priority: 4, views: SIDE, minRealFps: 100,
    kb: { skill: sk('max-velocity'), checkpoint: 'sp-max-velocity-c03', fault: null, drills: ['SP-D-WICKET'] },
    coach: { cue: "'Hit and lift - the ground is hot.'", why: 'Short ground contacts with a high step rate are what top-speed sprinting looks like; long contacts usually come with reaching or sitting (KB: ~0.08-0.11 s at elite speed).' },
    label: 'Long ground contacts', okLabel: 'Short ground contacts',
    needs: ['left_ankle', 'right_ankle'],
    params: {
      max_s: { value: 0.14, unit: 's', label: 'Ground contact at most', note: 'KB: ~0.08-0.11 s elite; needs slow-mo to measure' },
      tight_tol: { value: 0.04, unit: 'x torso', label: 'Foot counts as loaded within', note: 'Stricter than the step detector so the foot rolling in/out is not counted as contact' },
    },
    thresholdText: (P) => `ground contact ${P.max_s} s or shorter`,
    badness: (v, P) => hi(v, P, 'max_s'),
    evaluate(e, ctx, P) {
      if (!e.complete) return null;
      // tighten the contact to the frames where the foot is really on the ground
      const lowY = (i) => { const p = ctx.poses[i]; if (!p) return NaN; const pts = [e.side + '_ankle', e.side + '_heel', e.side + '_foot_index'].filter((n) => p.p2(n)[2] >= 0.3); return pts.length ? Math.max(...pts.map((n) => p.p2(n)[1])) : NaN; };
      const on = [];
      for (let i = e.td; i <= e.to; i++) { const y = lowY(i); if (Number.isFinite(y) && ctx.ground?.[i] - y <= P.tight_tol * T(ctx)) on.push(i); }
      const td = on.length ? on[0] : e.td, to = on.length ? on.at(-1) : e.to;
      const v = ctx.rt(to + 1) - ctx.rt(td);
      const p = ctx.poses[e.td]; if (!p) return null;
      return { value: v, pass: v <= P.max_s, frame: e.td, text: `contact ${r2(v)} s`, draw: [D.dot(p, e.side + '_ankle', `${r2(v)} s`)] };
    },
  }),
  // ---- arms (front view)
  mk({
    id: 'sp_arms_cross', group: 'arms', scope: 'frames:run', priority: 3, views: ['front'],
    kb: { skill: sk('max-velocity'), checkpoint: 'sp-max-velocity-c05', fault: 'sp-max-velocity-f03' },
    label: 'Hands crossing the midline', okLabel: 'Arms drive straight',
    needs: ['left_wrist', 'right_wrist', ...SHOULDERS, ...HIPS],
    params: { max_cross: { value: 0.1, unit: 'x torso', label: 'Wrist may cross the body midline by' } },
    thresholdText: (P) => `wrists cross the midline by less than ${P.max_cross}x torso`,
    badness: (v, P) => hi(v, P, 'max_cross'),
    measure(p, ctx, P) {
      let worst = -Infinity, ws = 'left';
      const mx = (p.p2('mid_shoulder')[0] + p.p2('mid_hip')[0]) / 2;
      for (const s of ['left', 'right']) {
        const own = Math.sign(p.p2(s + '_shoulder')[0] - mx) || 1;
        const v = ((mx - p.p2(s + '_wrist')[0]) * own) / T(ctx);
        if (v > worst) { worst = v; ws = s; }
      }
      return { value: worst, pass: worst <= P.max_cross, text: worst > P.max_cross ? `${ws} hand crosses ${r1(worst)}x torso` : 'arms straight', draw: [D.seg([mx / p.W, p.n('mid_shoulder')[1] - 0.05], [mx / p.W, p.n('mid_hip')[1] + 0.05], 'midline'), D.dot(p, ws + '_wrist')] };
    },
  }),
];

export function bounce(ctx, P, chk) {
  // hip height range between consecutive touchdowns, median over the clip
  const cs = (ctx.contacts || []).filter((c) => c.start > 0);
  if (cs.length < 3) return { status: 'no_events', reason: 'Need 3+ steps in the clip to measure bounce' };
  const vals = [];
  let worst = null;
  for (let k = 0; k + 1 < cs.length; k++) {
    const a = cs[k].start, b = cs[k + 1].start;
    const hs = [];
    for (let i = a; i <= b; i++) { const p = at(ctx, i, chk.needs); if (p) hs.push(ctx.ground[i] - p.p2('mid_hip')[1]); }
    if (hs.length < 3) continue;
    const v = (Math.max(...hs) - Math.min(...hs)) / T(ctx);
    vals.push(v);
    if (!worst || v > worst.v) worst = { v, i: a };
  }
  if (!vals.length) return null;
  const v = median(vals), p = ctx.poses[worst.i];
  return { value: v, pass: v <= P.max_osc, frame: worst.i, text: `hips move ${r2(v)}x torso up/down per step`, summary: `median ${r2(v)}x torso over ${vals.length} steps`, draw: p ? [D.level(p, 'mid_hip', ctx, 'hip height', 4)] : [] };
}

const sprinting = {
  id: 'sprinting', name: 'Sprinting',
  roles: () => ({}),
  stances: null,
  bodyView: true,   // v0.5: camera angle read from the chest direction (js/engine/view.js)
  views: [
    { id: 'side', label: 'Side', hint: 'Perpendicular to the lane, level with the athlete' },
    { id: 'front', label: 'Front', hint: 'Straight down the lane (arm action only)' },
  ],
  filmingTips: [
    'Side view, perpendicular to the lane, camera at hip height, 8-15 m away. Pan smoothly or keep the camera still and let the athlete run through.',
    'Whole body in frame including the feet. Landscape works best for sprints.',
    'Slow-mo (120-240 fps) makes contact times and touchdowns much more accurate; 30 fps is enough for posture.',
  ],
  skills: [
    { id: 'block_start', label: 'Block start', kbSkill: sk('block-start'), checks: ['set', 'exit'], all: true, view: 'side', minFps: 30,
      filming: ['Side view level with the blocks, 5-8 m away, camera still.', 'Start in frame in the "set" position and keep the first 3-4 steps in frame.', 'A photo of the set position checks the set only.', 'Slow-mo helps for the first touchdown.'] },
    { id: 'acceleration', label: 'Acceleration (drive phase)', kbSkill: sk('acceleration'), checks: ['accel'], all: true, view: 'side', minFps: 30,
      filming: ['Side view of steps ~2-10 (first 5-20 m), camera still or panning smoothly.', 'At least 4 steps fully in frame. Slow-mo if available.'] },
    { id: 'max_velocity', label: 'Max velocity (top speed)', kbSkill: sk('max-velocity'), checks: ['maxv', 'arms'], all: true, view: 'side', minFps: 30,
      filming: ['Side view at the fastest part of the run (30-60 m in a flying sprint).', 'At least 4 steps in frame. Slow-mo 120+ fps unlocks the contact-time check.', 'Front view (down the lane) checks arm crossing.'] },
  ],
  frameLabels: { set: 'set-position frames', run: 'running frames' },
  noFramesReason: (set) => (set === 'set' ? 'No "set" position found (hands on the track, hips up). Start the clip in the blocks.' : 'No running frames found'),
  eventLabel: (t) => ({ step: 'steps', exit: 'block exits' })[t] || t,
  globals: baseGlobals({
    contact_tol: { value: 0.1, label: 'Foot counts as on the ground within', unit: 'x torso', note: 'Height above the lowest foot point nearby' },
  }),
  detectEvents(ctx) {
    const notes = [], skill = ctx.skill.id;
    ctx.dir = runDir(ctx);
    const posed = ctx.poses.map((p, i) => (p && (ctx.isPhoto || legsOk(ctx, i)) ? i : -1)).filter((i) => i >= 0);
    if (ctx.isPhoto) {
      if (skill === 'block_start') return { events: [], frameSets: { set: setFrames(ctx) }, notes: ['Photo: set-position checks only.'] };
      return { events: [], frameSets: { run: posed }, notes: ['Photo: posture only. Film a few steps for the stride checks.'] };
    }
    if (ctx.view !== 'side') return { events: [], frameSets: { run: posed }, notes };
    const ev = steps(ctx);
    if (ev.length < 2) notes.push('Fewer than 2 foot contacts found: keep the feet in frame and film at least 4 steps.');
    if (ctx.fps < 60) notes.push(`${Math.round(ctx.fps)} fps: touchdown frames are approximate (contacts last only a few frames). Slow-mo helps.`);
    const metrics = [];
    const cad = cadence(ctx, ev.filter((e) => e.complete || true));
    if (Number.isFinite(cad)) metrics.push({ id: 'step_rate', label: 'Step rate', value: Math.round(cad), unit: 'steps/min', note: `${r1(cad / 60)} steps/s` });
    if (skill === 'block_start') {
      const set = setFrames(ctx);
      const events = [];
      if (set.length) {
        const lastSet = set.at(-1);
        const after = ev.filter((e) => e.td > lastSet + 1);
        const first = after[0];
        events.push({ type: 'exit', start: lastSet, peak: first ? first.td : Math.min(ctx.poses.length - 1, lastSet + ctx.sec(0.4)), exitEnd: first ? first.td : Math.min(ctx.poses.length - 1, lastSet + ctx.sec(0.4)), td1: first ? first.td : null, td1Side: first?.side });
      } else notes.push('No "set" position found: start the clip with the athlete in the blocks.');
      return { events: [...events, ...ev], frameSets: { set }, notes, metrics };
    }
    return { events: ev, frameSets: { run: posed }, notes, metrics };
  },
  keyframes(ctx, ev) {
    const k = [];
    for (const e of ev.events) {
      if (e.type === 'exit') { k.push({ i: e.start, label: 'Set' }); if (e.td1 != null) k.push({ i: e.td1, label: 'First touchdown' }); }
      else if (e.type === 'step') { k.push({ i: e.td, label: `Touchdown ${e.side[0].toUpperCase()}` }); if (e.complete) k.push({ i: e.to, label: `Toe-off ${e.side[0].toUpperCase()}` }); }
    }
    return k.length ? k.slice(0, 16) : null;
  },
  checks,
};
export default sprinting;
