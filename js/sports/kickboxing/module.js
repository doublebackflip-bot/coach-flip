// Kickboxing: the boxing punch/guard checks (same KB checkpoints, boxing KB loaded alongside) plus
// kicks: roundhouse, low kick, teep, and the shin check. A "kick" = one foot lifted well off the
// ground and back down; the skill you pick says which kick it is (no kick classifier).
import { dist } from '../../engine/geom.js';
import {
  D, r1, hi, lo, at, maxOver, minOver, ang2, joint, leanDeg, fists, yawSeries, series, fillGaps, smooth1, peaks, medianSign, facing,
  baseGlobals, mk, other, LEGS, HIPS, SHOULDERS, TRUNK,
} from '../../engine/kit.js';
import { boxing } from '../boxing/module.js';

const T = (ctx) => ctx.unit.torso2;
const sk = (id) => 'kb-' + id;
const lowFoot = (p, s) => Math.max(p.p2(s + '_ankle')[1], p.p2(s + '_heel')[1], p.p2(s + '_foot_index')[1]);
const FIST = (s) => [s + '_wrist', s + '_index', s + '_pinky'];

/** kicks / leg lifts: one ankle rises to within ~1 torso of hip height (standing: ~1.8 below).
 * Measured against the hip, not the floor, so it still works when the feet are cut off at the
 * bottom of the picture while standing (common in handheld gym clips). */
export function detectKicks(ctx, type = 'kick') {
  const { poses, sec, G } = ctx;
  const N = poses.length;
  const out = [];
  const below = (p, s) => (p.p2(s + '_ankle')[1] - p.p2('mid_hip')[1]) / T(ctx);
  for (const s of ['left', 'right']) {
    // "height" of the foot: larger = higher. NaN while the ankle is not seen.
    const h = smooth1(fillGaps(poses.map((p) => (p && p.vis(s + '_ankle', s + '_knee') >= 0.5 ? -below(p, s) : NaN)), 2), 1);
    // a check only needs the knee up (the shin hangs), so the ankle rises less than in a kick
    const thr = -(G.kick_max_below_hip + (type === 'check' ? 0.4 : 0));
    for (const i of peaks(h, { min: thr, prom: 0.4, win: sec(0.25), back: sec(0.8), gap: sec(0.5) })) {
      let a = i; while (a > 0 && (h[a - 1] > thr - 0.5 || !Number.isFinite(h[a - 1])) && i - a < sec(0.6)) a--;
      let z = i; while (z < N - 1 && (h[z + 1] > thr - 0.5 || !Number.isFinite(h[z + 1])) && z - i < sec(0.8)) z++;
      const p = poses[i]; if (!p) continue;
      // the other foot must not be up near hip height too (a jump/tuck, or the tracker swapping legs).
      // Only trusted when that ankle is clearly seen: with the shins cut off by the frame, a low-confidence
      // ankle is often placed near the knees, which used to hide real kicks.
      const o = other(s);
      if (p.vis(o + '_ankle') >= 0.7 && below(p, o) < 0.6) continue;
      out.push({ type, side: s, start: a, peak: i, end: z, height: r1(h[i]) });
    }
  }
  out.sort((x, y) => x.peak - y.peak);
  return out;
}
/** worst distance (fists) of the non-kicking-side fist from the chin during a kick */
const oppHand = (ctx, e, needs) => {
  const h = other(e.side);
  return maxOver(ctx, e.start, e.end, needs, (p) => (p.vis(...FIST(h)) >= ctx.G.min_visibility ? fists(p, h + '_fist', 'chin', ctx) : NaN));
};

function guardDuringKick(id, group, kb, label, coach) {
  return mk({
    id, group, scope: 'event:kick', priority: 1, basis: 'estimated', kb, coach,
    label, okLabel: 'Opposite hand stayed at the face',
    needs: ['nose', 'mouth_left', 'mouth_right'],
    params: { max_fists: { value: 2.0, unit: 'fists', label: 'Opposite fist may leave the chin by', note: 'KB: within ~1 fist of the face; margin for tracking during fast kicks' } },
    thresholdText: (P) => `the hand opposite the kicking leg stays within ${P.max_fists} fists of the chin`,
    badness: (v, P) => hi(v, P, 'max_fists'),
    evaluate(e, ctx, P) {
      const b = oppHand(ctx, e, this.needs); if (!b) return null;
      const h = other(e.side) + '_fist';
      return { value: b.v, pass: b.v <= P.max_fists, frame: b.i, text: `${other(e.side)} hand ${r1(b.v)} fists off the chin`, draw: [D.zone(b.p, 'chin', P.max_fists, ctx), D.line(b.p, h, 'chin', `${r1(b.v)} fists`)] };
    },
  });
}
function pivotCheck(id, group, kb) {
  return mk({
    id, group, scope: 'event:kick', priority: 2, kb,
    label: 'Flat support foot (no pivot)', okLabel: 'Support heel up and turning',
    needs: [], visReason: 'Support foot not visible - film the whole body',
    params: { min_lift: { value: 0.3, unit: 'fists', label: 'Support heel rises at least', note: 'KB: support heel lifts and rotates' }, min_turn: { value: 40, unit: 'deg', label: '...or the support foot turns at least' } },
    thresholdText: (P) => `support heel rises ${P.min_lift} fist or the support foot turns ${P.min_turn} deg by the kick`,
    badness: (v) => -v,
    evaluate(e, ctx, P) {
      const s = other(e.side), need = [s + '_heel', s + '_foot_index'];
      const p0 = at(ctx, e.start, need), p1 = at(ctx, e.peak, need); if (!p0 || !p1) return null;
      const lift = ((p0.p2(s + '_heel')[1] - p0.p2(s + '_foot_index')[1]) - (p1.p2(s + '_heel')[1] - p1.p2(s + '_foot_index')[1])) / ctx.unit.fist2;
      const ang = (p) => Math.atan2(p.p3(s + '_foot_index')[2] - p.p3(s + '_heel')[2], p.p3(s + '_foot_index')[0] - p.p3(s + '_heel')[0]) * 180 / Math.PI;
      let turn = Math.abs(ang(p1) - ang(p0)); if (turn > 180) turn = 360 - turn;
      const score = Math.max(lift / P.min_lift, turn / P.min_turn) - 1; // >= 0 passes
      return { value: score, pass: score >= 0, frame: e.peak, text: score >= 0 ? 'pivoted' : `heel up ${r1(lift)} fist, foot turned ${Math.round(turn)}°`, draw: [D.line(p1, s + '_heel', s + '_foot_index', 'support foot'), D.dot(p1, s + '_heel')] };
    },
  });
}
function hipTurnCheck(id, group, kb, minDeg = 30) {
  return mk({
    id, group, scope: 'event:kick', priority: 2, kb, temporal: true,
    label: 'No hip turnover (snapping from the knee)', okLabel: 'Hips turned over into the kick',
    needs: HIPS,
    params: { min_deg: { value: minDeg, unit: 'deg', label: 'Hips rotate at least (start to impact)', note: '3D estimate (pose model under-reads rotation); KB ~80-180 deg' } },
    thresholdText: (P) => `hip line rotates ${P.min_deg} deg or more from the start of the kick to its peak`,
    badness: (v, P) => lo(v, P, 'min_deg'),
    evaluate(e, ctx, P) {
      const y = ctx.yawH ??= yawSeries(ctx, 'left_hip', 'right_hip');
      let v = 0;
      for (let i = e.start; i <= Math.min(e.end, e.peak + 2); i++) if (Number.isFinite(y[i]) && Number.isFinite(y[e.start])) v = Math.max(v, Math.abs(y[i] - y[e.start]));
      const p = at(ctx, e.peak, this.needs); if (!p) return null;
      return { value: v, pass: v >= P.min_deg, frame: e.peak, text: `hips turned ~${Math.round(v)}°`, draw: [D.line(p, 'left_hip', 'right_hip', `hips ~${Math.round(v)}°`)] };
    },
  });
}

const kickChecks = [
  // roundhouse
  guardDuringKick('rh_guard', 'roundhouse', { skill: sk('roundhouse'), checkpoint: 'kb-roundhouse-c04', fault: 'kb-roundhouse-f03' }, 'Guard dropped during the kick'),
  pivotCheck('rh_pivot', 'roundhouse', { skill: sk('roundhouse'), checkpoint: 'kb-roundhouse-c02', fault: 'kb-roundhouse-f01' }),
  hipTurnCheck('rh_hips', 'roundhouse', { skill: sk('roundhouse'), checkpoint: 'kb-roundhouse-c03', fault: 'kb-roundhouse-f02' }),
  // low kick
  guardDuringKick('lk_guard', 'low_kick', { skill: sk('low-kick'), checkpoint: 'kb-low-kick-c02', fault: null, drills: ['KB-D-COMBO'] }, 'Hands drop on the low kick',
    { cue: "'Kick low, hands high - the far hand stays on your jaw.'", why: 'The low kick puts you in punching range: a dropped hand during the kick is an open target for the counter punch (KB: opposite wrist at the face during the kick).' }),
  pivotCheck('lk_pivot', 'low_kick', { skill: sk('roundhouse'), checkpoint: 'kb-roundhouse-c02', fault: 'kb-roundhouse-f01' }),
  hipTurnCheck('lk_hips', 'low_kick', { skill: sk('low-kick'), checkpoint: 'kb-low-kick-c01', fault: 'kb-roundhouse-f02' }, 25),
  // teep
  mk({
    id: 'teep_chamber', group: 'teep', scope: 'event:kick', priority: 1, views: ['side'],
    kb: { skill: sk('teep'), checkpoint: 'kb-teep-c01', fault: 'kb-teep-f01' },
    label: 'No chamber (knee not lifted first)', okLabel: 'Knee chambered to hip height',
    needs: LEGS,
    params: { max_below: { value: 0.35, unit: 'x torso', label: 'Kicking knee may stay below the hip by', note: 'KB: knee rises to roughly hip height before extension' } },
    thresholdText: (P) => `kicking knee rises to within ${P.max_below}x torso of hip height`,
    badness: (v, P) => hi(v, P, 'max_below'),
    evaluate(e, ctx, P) {
      // the chamber = the most bent kicking knee before the extension; the knee must be up THEN
      const c = minOver(ctx, e.start, e.peak, this.needs, (p) => ang2(p, e.side + '_hip', e.side + '_knee', e.side + '_ankle')); if (!c) return null;
      const v = (c.p.p2(e.side + '_knee')[1] - c.p.p2(e.side + '_hip')[1]) / T(ctx);
      return { value: v, pass: v <= P.max_below, frame: c.i, text: `knee ${r1(v)}x torso below the hip in the chamber`, draw: [D.level(c.p, e.side + '_hip', ctx, 'hip height', 4), D.dot(c.p, e.side + '_knee', 'knee')] };
    },
  }),
  mk({
    id: 'teep_lean', group: 'teep', scope: 'event:kick', priority: 2, views: ['side'],
    kb: { skill: sk('teep'), checkpoint: 'kb-teep-c01', fault: 'kb-teep-f01' },
    label: 'Leaning far back on the teep', okLabel: 'Trunk balanced on the teep',
    needs: [...TRUNK, 'left_ankle', 'right_ankle'],
    params: { max_back: { value: 25, unit: 'deg', label: 'Trunk may lean back (away from the kick) by' } },
    thresholdText: (P) => `trunk leans back less than ${P.max_back} deg at full extension`,
    badness: (v, P) => hi(v, P, 'max_back'),
    evaluate(e, ctx, P) {
      const p = at(ctx, e.peak, this.needs); if (!p) return null;
      const dir = Math.sign(p.p2(e.side + '_ankle')[0] - p.p2('mid_hip')[0]) || 1;
      const v = -leanDeg(p, 'mid_hip', 'mid_shoulder', dir);
      return { value: v, pass: v <= P.max_back, frame: e.peak, text: v > 0 ? `leaning back ${Math.round(v)}°` : 'upright', draw: [D.line(p, 'mid_hip', 'mid_shoulder', `${Math.round(v)}°`), D.vert(p, 'mid_hip', ctx, 'vertical', -1.2)] };
    },
  }),
  mk({
    id: 'teep_retract', group: 'teep', scope: 'event:kick', priority: 3, temporal: true,
    kb: { skill: sk('teep'), checkpoint: 'kb-teep-c02', fault: null, drills: ['KB-D-TEEP-PAD'] },
    coach: { cue: "'Snap it back - kick, retract, stance.'", why: 'Pulling the foot straight back after the teep stops the opponent catching the leg and resets the stance for the next attack (KB: foot back < ~0.5 s after impact).' },
    label: 'Slow to retract the leg', okLabel: 'Leg retracted quickly',
    needs: [],
    params: { max_s: { value: 0.6, unit: 's', label: 'Foot back on the ground within', note: 'KB: < ~0.5 s after impact' } },
    thresholdText: (P) => `foot back down within ${P.max_s} s of full extension`,
    badness: (v, P) => hi(v, P, 'max_s'),
    evaluate(e, ctx, P) {
      const v = ctx.rt(e.end) - ctx.rt(e.peak);
      const p = ctx.poses[e.end]; if (!p) return null;
      return { value: v, pass: v <= P.max_s, frame: e.end, text: `${v.toFixed(2)} s to retract`, draw: [D.dot(p, e.side + '_ankle', `${v.toFixed(2)} s`)] };
    },
  }),
  guardDuringKick('teep_guard', 'teep', { skill: sk('teep'), checkpoint: 'kb-teep-c01', fault: null, drills: ['KB-D-TEEP-PAD'] }, 'Hands drop on the teep',
    { cue: "'Hands stay home while the foot goes out.'", why: 'The teep keeps distance, but dropping the hands while balancing on one leg gives the opponent a free counter (KB: keep the hands up through chamber and extension).' }),
  // check
  mk({
    id: 'check_knee', group: 'check', scope: 'event:check', priority: 1,
    kb: { skill: sk('check'), checkpoint: 'kb-check-c01', fault: 'kb-check-f01' },
    label: 'Check too low (knee not lifted)', okLabel: 'Checking knee up near hip height',
    needs: LEGS,
    params: { max_below: { value: 0.4, unit: 'x torso', label: 'Checking knee may stay below the hip by', note: 'KB: knee lifts to ~hip height' } },
    thresholdText: (P) => `checking knee within ${P.max_below}x torso of hip height`,
    badness: (v, P) => hi(v, P, 'max_below'),
    evaluate(e, ctx, P) {
      const b = minOver(ctx, e.start, e.end, this.needs, (p) => (p.p2(e.side + '_knee')[1] - p.p2(e.side + '_hip')[1]) / T(ctx)); if (!b) return null;
      return { value: b.v, pass: b.v <= P.max_below, frame: b.i, text: `knee ${r1(b.v)}x torso below the hip`, draw: [D.level(b.p, e.side + '_hip', ctx, 'hip height', 4), D.dot(b.p, e.side + '_knee')] };
    },
  }),
  mk({
    id: 'check_guard', group: 'check', scope: 'event:check', priority: 1,
    kb: { skill: sk('check'), checkpoint: 'kb-check-c01', fault: 'kb-check-f01' },
    label: 'Guard dropped while checking', okLabel: 'Both hands at the face on the check',
    needs: [...FIST('left'), ...FIST('right'), 'nose', 'mouth_left', 'mouth_right'],
    params: { max_fists: { value: 2.0, unit: 'fists', label: 'Each fist within this of the chin' } },
    thresholdText: (P) => `both fists within ${P.max_fists} fists of the chin during the check`,
    badness: (v, P) => hi(v, P, 'max_fists'),
    evaluate(e, ctx, P) {
      const b = maxOver(ctx, e.start, e.end, this.needs, (p) => Math.max(fists(p, 'left_fist', 'chin', ctx), fists(p, 'right_fist', 'chin', ctx))); if (!b) return null;
      const h = fists(b.p, 'left_fist', 'chin', ctx) >= fists(b.p, 'right_fist', 'chin', ctx) ? 'left' : 'right';
      return { value: b.v, pass: b.v <= P.max_fists, frame: b.i, text: `${h} hand ${r1(b.v)} fists off`, draw: [D.zone(b.p, 'chin', P.max_fists, ctx), D.line(b.p, h + '_fist', 'chin')] };
    },
  }),
  mk({
    id: 'check_support', group: 'check', scope: 'event:check', priority: 2,
    kb: { skill: sk('check'), checkpoint: 'kb-check-c02', fault: 'kb-check-f01' },
    label: 'Straight (locked) support leg', okLabel: 'Support leg slightly bent',
    needs: LEGS,
    params: { max_knee: { value: 170, unit: 'deg', label: 'Support knee angle at most', note: 'KB: < ~170 deg' } },
    thresholdText: (P) => `support knee under ${P.max_knee} deg during the check`,
    badness: (v, P) => hi(v, P, 'max_knee'),
    evaluate(e, ctx, P) {
      const s = other(e.side);
      const p = at(ctx, e.peak, this.needs); if (!p) return null;
      const v = joint(p, s + '_hip', s + '_knee', s + '_ankle', ctx);
      return { value: v, pass: v <= P.max_knee, frame: e.peak, text: `support knee ${Math.round(v)}°`, draw: [D.ang(p, s + '_hip', s + '_knee', s + '_ankle', `${Math.round(v)}°`)] };
    },
  }),
];

const KICK_SKILL = { roundhouse: 'roundhouse', low_kick: 'low_kick', teep: 'teep', check: 'check' };
const kickboxing = {
  ...boxing,
  id: 'kickboxing', name: 'Kickboxing', kbFile: undefined,
  filmingTips: [
    'Phone at chest height, 3-4 m away, WHOLE body in frame including the feet (kicks need the feet).',
    'Front view (like the opponent sees you) for the guard and the check; side view for the teep and roundhouse pivot.',
    'Bag work or shadow, 5-10 kicks per clip. 60 fps or slow-mo helps for fast kicks.',
  ],
  skills: [
    { id: 'guard', label: 'Stance & guard', kbSkill: sk('stance'), kbSkills: [sk('stance'), 'bx-stance-guard'], checks: ['guard', 'stance'], view: 'front' },
    { id: 'jab', label: 'Jab', kbSkill: 'bx-jab', checks: ['jab', 'guard'], view: 'front' },
    { id: 'cross', label: 'Cross', kbSkill: 'bx-cross', checks: ['cross', 'guard'], view: 'front' },
    { id: 'roundhouse', label: 'Roundhouse kick', kbSkill: sk('roundhouse'), checks: ['roundhouse', 'guard'], view: 'front', beta: true, minFps: 30,
      filming: ['Front or 45° view, whole body incl. feet, 3-4 m away.', 'Bag or pads; 5+ kicks per clip. Slow-mo or 60 fps helps.'] },
    { id: 'low_kick', label: 'Low kick', kbSkill: sk('low-kick'), checks: ['low_kick', 'guard'], view: 'front', beta: true, minFps: 30,
      filming: ['Front or 45° view, whole body incl. feet.', 'Thigh-height bag or a partner with a thigh pad.'] },
    { id: 'teep', label: 'Teep (push kick)', kbSkill: sk('teep'), checks: ['teep', 'guard'], view: 'side', beta: true, minFps: 30,
      filming: ['Side view, perpendicular to the kick, whole body in frame.'] },
    { id: 'check', label: 'Shin check', kbSkill: sk('check'), checks: ['check'], view: 'front', beta: true, minFps: 30,
      filming: ['Front view, whole body in frame. Partner throws light low kicks, or shadow the check on a call.'] },
    { id: 'shadow', label: 'Shadow / bag (all)', kbSkill: null, kbSkills: [sk('stance'), 'bx-jab', 'bx-cross', sk('roundhouse'), sk('teep')], all: true, checks: ['guard', 'stance', 'jab', 'cross', 'hook', 'roundhouse'], view: 'front' },
  ],
  eventLabel: (t) => ({ kick: 'kicks', check: 'checks' })[t] || boxing.eventLabel(t),
  globals: {
    ...boxing.globals,
    kick_max_below_hip: { value: 1.0, label: 'Kick: ankle rises to within this of hip height', unit: 'x torso', note: 'Standing, the ankle is ~1.8 torso lengths below the hip' },
  },
  detectEvents(ctx) {
    const b = boxing.detectEvents(ctx);
    const id = ctx.skill.id;
    const wantKicks = ['roundhouse', 'low_kick', 'teep', 'check', 'shadow'].includes(id);
    if (!wantKicks || ctx.isPhoto) return b;
    const kicks = detectKicks(ctx, id === 'check' ? 'check' : 'kick');
    // kicks are not punches and the guard during a kick is judged by the kick checks
    const pad = ctx.sec(0.15);
    const busy = (i) => kicks.some((k) => i >= k.start - pad && i <= k.end + pad);
    const events = [...b.events.filter((e) => !busy(e.peak)), ...kicks].sort((x, y) => x.peak - y.peak);
    const notes = (b.notes || []).filter((n) => !/punches were found/.test(n));
    if (!kicks.length) notes.push(`No ${id === 'check' ? 'checks' : 'kicks'} found: keep the feet in frame (the foot must lift well off the floor).`);
    return { ...b, events, guardFrames: b.guardFrames.filter((i) => !busy(i)), notes };
  },
  keyframes(ctx, ev) {
    const k = [];
    for (const e of ev.events) {
      if (e.type === 'kick' || e.type === 'check') k.push({ i: e.start, label: 'Start' }, { i: e.peak, label: e.type === 'check' ? 'Check' : 'Kick' }, { i: e.end, label: 'Back down' });
      else k.push({ i: e.peak, label: e.type.replace('_straight', ' punch').replace('lead_hook', 'Hook').replace(/^lead/, 'Lead').replace(/^rear/, 'Rear') });
    }
    return k.length ? k.slice(0, 18) : null;
  },
  checks: [...boxing.checks, ...kickChecks],
};
export default kickboxing;
