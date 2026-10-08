// Jumping rules (long jump, triple jump, high jump, landing mechanics).
// Automatic: long-jump take-off, triple-jump landings, high-jump take-off, landing mechanics.
// Coach checklist: approach run, long-jump landing in the sand, high-jump bar clearance.
// The take-off is the ground contact before the longest flight in the clip. Needs a STILL camera
// (the take-off angle uses the hip path on screen).
import { median } from '../../engine/geom.js';
import {
  D, r1, r2, hi, lo, band, at, maxOver, minOver, ang2, joint, facing, trunkLean, leanDeg, shinLean, thighBelowHorizontal, ahead,
  footContacts, medianSign, legsOk, baseGlobals, mk, other, segAt, LEGS, HIPS, SHOULDERS, TRUNK,
} from '../../engine/kit.js';
import { detectFlights, detectLandings, landingChecks, groundY } from '../shared/moves.js';

const T = (ctx) => ctx.unit.torso2;
const sk = (id) => 'jp-' + id;
const SIDE = ['side'];
const knee2 = (p, s) => ang2(p, s + '_hip', s + '_knee', s + '_ankle');
const lowFoot = (p, s) => Math.max(p.p2(s + '_ankle')[1], p.p2(s + '_heel')[1], p.p2(s + '_foot_index')[1]);

/** the jump: longest flight; take-off contact (touchdown -> toe-off) and the contact before it */
function detectTakeoff(ctx) {
  const { poses, sec, G } = ctx;
  const fl = detectFlights(ctx, { air: G.air_height, ground: 0.12, minAir: 0.05 }).filter((f) => (f.e - f.s + 1) / ctx.fps >= G.min_flight_s);
  if (!fl.length) return null;
  const f = fl.reduce((a, b) => (b.e - b.s > a.e - a.s ? b : a));
  const to = f.to, p = poses[to]; if (!p) return null;
  const side = lowFoot(p, 'left') >= lowFoot(p, 'right') ? 'left' : 'right';
  const g = groundY(ctx), T2 = T(ctx);
  // walk back to the take-off touchdown (the take-off foot stays on the ground)
  let td = to;
  while (td > 0 && poses[td - 1] && (g - lowFoot(poses[td - 1], side)) / T2 <= 0.08 && to - td < sec(0.4)) td--;
  const ph = (i) => poses[i]?.p2('mid_hip')[0];
  const dir = Math.sign((ph(f.land) ?? 0) - (ph(to) ?? 0)) || medianSign(ctx, ['nose', 'left_foot_index', 'right_foot_index'], facing);
  // previous contacts (penultimate step) from the foot-contact detector
  const fc = footContacts(ctx, { tol: 0.1, win: 0.6 });
  const before = fc.contacts.filter((c) => c.end < td && c.start < td - 1);
  const pen = before.at(-1) || null, prev = before.at(-2) || null;
  return { type: 'takeoff', side, td, to, peak: to, start: Math.max(0, (pen?.start ?? td) - sec(0.2)), end: Math.min(poses.length - 1, f.e), land: f.land, dir, pen, prev, flightS: r2((f.e - f.s + 1) / ctx.fps) };
}
/** triple jump: every touchdown after a real flight (hop, step, jump landings) */
function detectBoundContacts(ctx) {
  const { G } = ctx;
  const fl = detectFlights(ctx, { air: G.air_height, ground: 0.12, minAir: 0.05 }).filter((f) => (f.e - f.s + 1) / ctx.fps >= G.min_flight_s * 0.6);
  const dir = medianSign(ctx, ['nose', 'left_foot_index', 'right_foot_index'], facing);
  ctx.dir = dir;
  // hop + step + jump = 3 flights: the last landing is in the pit (not judged); judge the hop and step landings
  ctx._pitSkipped = fl.length >= 3;
  const judged = fl.length >= 3 ? fl.slice(-3, -1) : fl;
  return judged.map((f, k) => {
    const p = ctx.poses[f.land]; if (!p) return null;
    const side = lowFoot(p, 'left') >= lowFoot(p, 'right') ? 'left' : 'right';
    return { type: 'bound', side, td: f.land, peak: f.land, start: f.to, end: Math.min(ctx.poses.length - 1, f.land + ctx.sec(0.25)), n: k + 1 };
  }).filter(Boolean);
}

const ljChecks = [
  mk({
    id: 'lj_reach', group: 'lj', scope: 'event:takeoff', priority: 1, views: SIDE,
    kb: { skill: sk('lj-takeoff'), checkpoint: 'jp-lj-takeoff-c03', fault: 'jp-lj-takeoff-f01' },
    label: 'Reaching for the board (braking plant)', okLabel: 'Active plant, shin not reaching',
    needs: LEGS,
    params: { max_tilt: { value: 25, unit: 'deg', label: 'Take-off shin may tilt with the foot ahead of the knee by', note: 'KB: shin slightly behind vertical at touchdown; a big tilt = reaching' } },
    thresholdText: (P) => `take-off shin tilted less than ${P.max_tilt} deg (foot ahead of knee) at touchdown`,
    badness: (v, P) => hi(v, P, 'max_tilt'),
    evaluate(e, ctx, P) {
      const p = at(ctx, e.td, this.needs); if (!p) return null;
      const v = -shinLean(p, e.side, e.dir);
      return { value: v, pass: v <= P.max_tilt, frame: e.td, text: `shin ${Math.round(v)}° reaching`, draw: [D.line(p, e.side + '_knee', e.side + '_ankle', `${Math.round(v)}°`), D.vert(p, e.side + '_ankle', ctx, 'vertical', -0.9)] };
    },
  }),
  mk({
    id: 'lj_angle', group: 'lj', scope: 'event:takeoff', priority: 2, views: SIDE, temporal: true,
    kb: { skill: sk('lj-takeoff'), checkpoint: 'jp-lj-takeoff-c04', fault: 'jp-lj-takeoff-f03' },
    label: 'Take-off too steep', okLabel: 'Take-off angle not too steep',
    needs: HIPS,
    params: { max_deg: { value: 30, unit: 'deg', label: 'Hip path angle just after take-off at most', note: 'KB: ~18-25 deg typical; still camera needed' }, window_s: { value: 0.1, unit: 's', label: 'Measured over the first' } },
    thresholdText: (P) => `hip path rises at ${P.max_deg} deg or less in the first ${P.window_s} s after take-off`,
    badness: (v, P) => hi(v, P, 'max_deg'),
    evaluate(e, ctx, P) {
      const a = at(ctx, e.to, this.needs), j = Math.min(e.end, e.to + ctx.sec(P.window_s)), b = at(ctx, j, this.needs); if (!a || !b || j <= e.to) return null;
      const dx = (b.p2('mid_hip')[0] - a.p2('mid_hip')[0]) * e.dir, dy = a.p2('mid_hip')[1] - b.p2('mid_hip')[1];
      if (dx <= 0) return null;
      const v = (Math.atan2(dy, dx) * 180) / Math.PI;
      return { value: v, pass: v <= P.max_deg, frame: j, text: `take-off angle ~${Math.round(v)}°`, draw: [segAt(b, a.p2('mid_hip'), b.p2('mid_hip'), `${Math.round(v)}°`), D.level(a, 'mid_hip', ctx, 'horizontal', 5)] };
    },
  }),
  mk({
    id: 'lj_toeoff_leg', group: 'lj', scope: 'event:takeoff', priority: 3, views: SIDE,
    kb: { skill: sk('lj-takeoff'), checkpoint: 'jp-lj-takeoff-c05', fault: null, drills: ['JP-D-SHORTAPP'] },
    coach: { cue: "'Finish tall off the board - drive through the take-off leg.'", why: 'Full extension of the take-off leg at toe-off means the push was completed; a bent leg leaves distance on the board (KB: take-off knee ~170-180 deg).' },
    label: 'Take-off leg not fully extended', okLabel: 'Take-off leg extended at toe-off',
    needs: LEGS,
    params: { min_knee: { value: 160, unit: 'deg', label: 'Take-off knee at toe-off at least', note: 'KB: ~170-180 deg' } },
    thresholdText: (P) => `take-off knee ${P.min_knee} deg or straighter at toe-off`,
    badness: (v, P) => lo(v, P, 'min_knee'),
    evaluate(e, ctx, P) {
      const b = maxOver(ctx, e.to - 1, e.to + 1, this.needs, (p) => knee2(p, e.side)); if (!b) return null;
      return { value: b.v, pass: b.v >= P.min_knee, frame: b.i, text: `take-off knee ${Math.round(b.v)}°`, draw: [D.ang(b.p, e.side + '_hip', e.side + '_knee', e.side + '_ankle', `${Math.round(b.v)}°`)] };
    },
  }),
  mk({
    id: 'lj_free_thigh', group: 'lj', scope: 'event:takeoff', priority: 4, views: SIDE,
    kb: { skill: sk('lj-takeoff'), checkpoint: 'jp-lj-takeoff-c05', fault: null, drills: ['JP-D-SHORTAPP'] },
    coach: { cue: "'Knee up - drive the free thigh to horizontal.'", why: 'Driving the free thigh up to horizontal adds lift and keeps the body from rotating forward in the air (KB: free thigh near horizontal at toe-off).' },
    label: 'Low free knee at take-off', okLabel: 'Free thigh driven up',
    needs: LEGS,
    params: { max_below: { value: 30, unit: 'deg', label: 'Free thigh at most this far below horizontal', note: 'KB: near horizontal' } },
    thresholdText: (P) => `free thigh within ${P.max_below} deg of horizontal at toe-off`,
    badness: (v, P) => hi(v, P, 'max_below'),
    evaluate(e, ctx, P) {
      const s = other(e.side);
      const b = minOver(ctx, e.to - 1, e.to + 2, this.needs, (p) => thighBelowHorizontal(p, s, e.dir)); if (!b) return null;
      return { value: b.v, pass: b.v <= P.max_below, frame: b.i, text: `free thigh ${Math.round(b.v)}° below horizontal`, draw: [D.line(b.p, s + '_hip', s + '_knee', `${Math.round(b.v)}°`), D.level(b.p, s + '_hip', ctx, 'horizontal', 4)] };
    },
  }),
  mk({
    id: 'lj_trunk', group: 'lj', scope: 'event:takeoff', priority: 3, views: SIDE,
    kb: { skill: sk('lj-takeoff'), checkpoint: 'jp-lj-takeoff-c05', fault: null, drills: ['JP-D-SHORTAPP'] },
    coach: { cue: "'Chest up, eyes forward off the board.'", why: 'An upright trunk at take-off keeps the body from pitching forward in the flight and sets up a good landing (KB: trunk within ~10 deg of vertical).' },
    label: 'Trunk not upright at take-off', okLabel: 'Upright trunk at take-off',
    needs: TRUNK,
    params: { min_lean: { value: -12, unit: 'deg', label: 'Trunk lean at least (negative = back)' }, max_lean: { value: 15, unit: 'deg', label: 'Trunk lean forward at most', note: 'KB: within ~10 deg of vertical' } },
    thresholdText: (P) => `trunk between ${P.min_lean} and ${P.max_lean} deg at toe-off`,
    badness: (v, P) => band(v, P, 'min_lean', 'max_lean'),
    evaluate(e, ctx, P) {
      const p = at(ctx, e.to, this.needs); if (!p) return null;
      const v = trunkLean(p, e.dir);
      return { value: v, pass: v >= P.min_lean && v <= P.max_lean, frame: e.to, text: `trunk ${Math.round(v)}°`, draw: [D.line(p, 'mid_hip', 'mid_shoulder', `${Math.round(v)}°`), D.vert(p, 'mid_hip', ctx, 'vertical', -1.2)] };
    },
  }),
  mk({
    id: 'lj_penultimate', group: 'lj', scope: 'event:takeoff', priority: 4, views: SIDE, temporal: true,
    kb: { skill: sk('lj-takeoff'), checkpoint: 'jp-lj-takeoff-c02', fault: 'jp-lj-takeoff-f02' },
    label: 'No lowering on the penultimate step', okLabel: 'Hips lowered on the penultimate step',
    needs: HIPS,
    params: { min_drop: { value: 0.03, unit: 'x torso', label: 'Hips lower on the penultimate step than the step before by at least', note: 'KB: hip height dips a few cm; needs 3 steps before the board in frame' } },
    thresholdText: (P) => `hips ${P.min_drop}x torso lower on the penultimate contact than on the one before`,
    badness: (v, P) => lo(v, P, 'min_drop'),
    evaluate(e, ctx, P) {
      if (!e.pen || !e.prev) return null;
      const g = groundY(ctx);
      const hh = (c) => { const vals = []; for (let i = c.start; i <= c.end; i++) { const p = at(ctx, i, this.needs); if (p) vals.push(g - p.p2('mid_hip')[1]); } return vals.length ? Math.min(...vals) : NaN; };
      const v = (hh(e.prev) - hh(e.pen)) / T(ctx);
      if (!Number.isFinite(v)) return null;
      const p = ctx.poses[e.pen.mid ?? e.pen.start];
      return { value: v, pass: v >= P.min_drop, frame: e.pen.mid ?? e.pen.start, text: v >= P.min_drop ? 'hips lowered' : 'no lowering on the penultimate', draw: p ? [D.level(p, 'mid_hip', ctx, 'hip height', 5)] : [] };
    },
  }),
];

const tjChecks = [
  mk({
    id: 'tj_trunk', group: 'tj', scope: 'event:bound', priority: 1, views: SIDE,
    kb: { skill: sk('triple'), checkpoint: 'jp-triple-c03', fault: 'jp-triple-f02' },
    label: 'Leaning forward on the landings', okLabel: 'Upright trunk on each landing',
    needs: TRUNK,
    params: { max_lean: { value: 15, unit: 'deg', label: 'Trunk lean forward at touchdown at most', note: 'KB: within ~10-15 deg of vertical' } },
    thresholdText: (P) => `trunk leans forward ${P.max_lean} deg or less at each touchdown`,
    badness: (v, P) => hi(v, P, 'max_lean'),
    evaluate(e, ctx, P) {
      const p = at(ctx, e.td, this.needs); if (!p) return null;
      const v = trunkLean(p, ctx.dir);
      return { value: v, pass: v <= P.max_lean, frame: e.td, text: `trunk ${Math.round(v)}° forward`, draw: [D.line(p, 'mid_hip', 'mid_shoulder', `${Math.round(v)}°`), D.vert(p, 'mid_hip', ctx, 'vertical', -1.2)] };
    },
  }),
  mk({
    id: 'tj_paw', group: 'tj', scope: 'event:bound', priority: 2, views: SIDE,
    kb: { skill: sk('triple'), checkpoint: 'jp-triple-c03', fault: null, drills: ['JP-D-BOUNDS'] },
    coach: { cue: "'Paw the ground back under you - land active, not out in front.'", why: 'Landing with the foot close under the hips and moving backward keeps horizontal speed for the next phase; reaching out in front brakes (KB: touchdown foot close to below the hip).' },
    label: 'Landing foot far in front (braking)', okLabel: 'Active landings under the hips',
    needs: [...HIPS, 'left_ankle', 'right_ankle'],
    params: { max_ahead: { value: 0.8, unit: 'x torso', label: 'Touchdown ankle ahead of the hips at most' } },
    thresholdText: (P) => `touchdown ankle no more than ${P.max_ahead}x torso ahead of the hips`,
    badness: (v, P) => hi(v, P, 'max_ahead'),
    evaluate(e, ctx, P) {
      const p = at(ctx, e.td, this.needs); if (!p) return null;
      const v = ahead(p, e.side + '_ankle', 'mid_hip', ctx.dir, ctx);
      return { value: v, pass: v <= P.max_ahead, frame: e.td, text: `foot ${r1(v)}x torso ahead`, draw: [D.vert(p, 'mid_hip', ctx, 'hips', -1.6), D.dot(p, e.side + '_ankle')] };
    },
  }),
];

const hjChecks = [
  mk({
    id: 'hj_plant', group: 'hj', scope: 'event:takeoff', priority: 2, views: SIDE,
    kb: { skill: sk('hj-approach-takeoff'), checkpoint: 'jp-hj-approach-takeoff-c03', fault: 'jp-hj-approach-takeoff-f02' },
    label: 'Take-off step too long (or foot not ahead)', okLabel: 'Take-off foot planted ahead of the hips',
    needs: [...HIPS, 'left_ankle', 'right_ankle'],
    params: { min_ahead: { value: 0.2, unit: 'x torso', label: 'Take-off foot ahead of the hips at least' }, max_ahead: { value: 1.3, unit: 'x torso', label: 'Take-off foot ahead of the hips at most' } },
    thresholdText: (P) => `take-off foot ${P.min_ahead}-${P.max_ahead}x torso ahead of the hips at touchdown`,
    badness: (v, P) => band(v, P, 'min_ahead', 'max_ahead'),
    evaluate(e, ctx, P) {
      const p = at(ctx, e.td, this.needs); if (!p) return null;
      const v = ahead(p, e.side + '_ankle', 'mid_hip', e.dir, ctx);
      return { value: v, pass: v >= P.min_ahead && v <= P.max_ahead, frame: e.td, text: `foot ${r1(v)}x torso ahead`, draw: [D.vert(p, 'mid_hip', ctx, 'hips', -1.6), D.dot(p, e.side + '_ankle', 'plant')] };
    },
  }),
  mk({
    id: 'hj_drive', group: 'hj', scope: 'event:takeoff', priority: 3, views: SIDE,
    kb: { skill: sk('hj-approach-takeoff'), checkpoint: 'jp-hj-approach-takeoff-c05', fault: null, drills: ['JP-D-CIRCLE'] },
    coach: { cue: "'Knee and arms up - punch them to the sky.'", why: 'A fast, high drive of the free knee and both arms at take-off adds vertical lift (KB: free thigh near horizontal, arms above shoulder height at toe-off).' },
    label: 'Weak knee/arm drive at take-off', okLabel: 'Knee and arms driven up',
    needs: [...LEGS, 'left_wrist', 'right_wrist', ...SHOULDERS],
    params: { max_below: { value: 30, unit: 'deg', label: 'Free thigh at most this far below horizontal' }, min_arm: { value: 0, unit: 'x torso', label: 'Higher wrist above the shoulders by at least' } },
    thresholdText: (P) => `free thigh within ${P.max_below} deg of horizontal and a wrist at/above shoulder height around toe-off`,
    badness: (v) => v,
    evaluate(e, ctx, P) {
      const s = other(e.side);
      const b = minOver(ctx, e.to - 1, e.to + 3, this.needs, (p) => {
        const th = thighBelowHorizontal(p, s, e.dir) - P.max_below;
        const arm = P.min_arm - (p.p2('mid_shoulder')[1] - Math.min(p.p2('left_wrist')[1], p.p2('right_wrist')[1])) / T(ctx);
        return Math.max(th / 30, arm);
      }); if (!b) return null;
      return { value: b.v, pass: b.v <= 0, frame: b.i, text: b.v <= 0 ? 'good drive' : 'knee/arms low', draw: [D.line(b.p, s + '_hip', s + '_knee', 'free knee'), D.level(b.p, 'mid_shoulder', ctx, 'shoulders', 5)] };
    },
  }),
  mk({
    id: 'hj_lean_in', group: 'hj', scope: 'event:takeoff', priority: 1, views: ['front'],
    kb: { skill: sk('hj-approach-takeoff'), checkpoint: 'jp-hj-approach-takeoff-c02', fault: 'jp-hj-approach-takeoff-f03' },
    label: 'Leaning into the bar at take-off', okLabel: 'Body near vertical at take-off',
    needs: TRUNK,
    params: { max_deg: { value: 12, unit: 'deg', label: 'Sideways trunk lean at toe-off at most', note: 'KB: inward lean on the curve, near vertical at toe-off' } },
    thresholdText: (P) => `trunk within ${P.max_deg} deg of vertical (sideways) at toe-off`,
    badness: (v, P) => hi(v, P, 'max_deg'),
    evaluate(e, ctx, P) {
      const p = at(ctx, e.to, this.needs); if (!p) return null;
      const v = Math.abs(leanDeg(p, 'mid_hip', 'mid_shoulder', 1));
      return { value: v, pass: v <= P.max_deg, frame: e.to, text: `leaning ${Math.round(v)}°`, draw: [D.line(p, 'mid_hip', 'mid_shoulder', `${Math.round(v)}°`), D.vert(p, 'mid_hip', ctx, 'vertical', -1.2)] };
    },
  }),
];

const jumping = {
  id: 'jumping', name: 'Jumping',
  roles: () => ({}),
  stances: null,
  bodyView: true,   // v0.5: camera angle read from the chest direction (js/engine/view.js)
  views: [
    { id: 'side', label: 'Side', hint: 'Perpendicular to the runway at the board / take-off spot' },
    { id: 'front', label: 'Front', hint: 'Facing the jumper (landings, high-jump lean)' },
  ],
  filmingTips: [
    'Camera STILL (tripod or propped up), never panning: take-off angle uses the hip path on screen.',
    'Side view 8-12 m from the board, so the last 3 steps and the first part of the flight are in frame.',
    'Slow-mo 120-240 fps if your phone has it: the take-off contact lasts ~0.12 s.',
  ],
  skills: [
    { id: 'lj_takeoff', label: 'Long jump take-off', kbSkill: sk('lj-takeoff'), checks: ['lj'], all: true, view: 'side', minFps: 30, beta: true,
      filming: ['Side view, camera still, level with the board, 8-12 m away.', 'Last 3 steps + take-off + first 0.3 s of flight in frame.', 'Slow-mo 120+ fps strongly recommended.'] },
    { id: 'triple', label: 'Triple jump (landings)', kbSkill: sk('triple'), checks: ['tj'], all: true, view: 'side', minFps: 30, beta: true,
      filming: ['Side view from far enough back (15+ m) to see hop, step and jump; camera still.', 'Phase distances need a measuring tape - use the checklist for those.'] },
    { id: 'hj_takeoff', label: 'High jump take-off', kbSkill: sk('hj-approach-takeoff'), checks: ['hj'], all: true, view: 'side', minFps: 30, beta: true,
      filming: ['Side view perpendicular to the last strides for plant and drive; front view (behind the bar\'s far upright) for lean at take-off.', 'Camera still. Include the last 3 strides and take-off.'] },
    { id: 'landing', label: 'Landing mechanics (plyo)', kbSkill: sk('landing-mech'), checks: ['land'], all: true, view: 'front', minFps: 30,
      filming: ['Front view for knees caving in; side view for knee bend.', 'Camera at knee-hip height, 3-4 m away, whole body in frame. Box jumps, drop jumps, broad-jump sticks.'] },
    { id: 'approach', label: 'Approach run', kbSkill: sk('approach'), checks: [], mode: 'checklist', view: 'side',
      checklistWhy: 'step-pattern consistency needs check marks and several trials, not one clip',
      filming: ['Side view of the last 6 strides; film 3 trials to compare.'] },
    { id: 'lj_landing', label: 'Long jump landing', kbSkill: sk('lj-landing'), checks: [], mode: 'checklist', view: 'side',
      checklistWhy: 'feet and hips disappear into the sand and the pit edge is unknown',
      filming: ['Side view of the pit, camera still, whole flight and landing in frame.'] },
    { id: 'hj_clearance', label: 'High jump bar clearance', kbSkill: sk('hj-clearance'), checks: [], mode: 'checklist', view: 'side',
      checklistWhy: 'the body is horizontal and rotating over the bar, where pose tracking is unreliable',
      filming: ['Side view in line with the bar, camera still, include take-off to landing.'] },
  ],
  eventLabel: (t) => ({ takeoff: 'take-offs', bound: 'landings', landing: 'landings' })[t] || t,
  globals: baseGlobals({
    air_height: { value: 0.25, label: 'Airborne when both feet are above the ground by', unit: 'x torso' },
    min_flight_s: { value: 0.25, label: 'A jump has a flight of at least', unit: 's' },
  }),
  detectEvents(ctx) {
    const notes = [], id = ctx.skill.id;
    if (ctx.isPhoto) return { events: [], notes: ['Jumps need a video. Use the coach checklist for photos.'] };
    if (ctx.fps < 60) notes.push(`${Math.round(ctx.fps)} fps: touchdown/toe-off are located to the nearest frame. Slow-mo makes take-off checks much more precise.`);
    if (id === 'landing') {
      const ev = detectLandings(ctx);
      if (!ev.length) notes.push('No landing found: both feet must leave the ground and land in frame.');
      return { events: ev, notes };
    }
    if (id === 'triple') {
      const ev = detectBoundContacts(ctx);
      if (!ev.length) notes.push('No hop/step/jump landings found: keep the camera still and the jumper in frame.');
      else if (ctx._pitSkipped) notes.push('Judged the hop and step landings; the final landing in the pit is not checked.');
      else notes.push('Fewer than 3 flights seen: every landing in the clip is judged. Film hop, step and jump for the full picture.');
      return { events: ev, notes };
    }
    const e = detectTakeoff(ctx);
    if (!e) { notes.push('No take-off found (no flight longer than ' + ctx.G.min_flight_s + ' s). Keep the camera still and the take-off in frame.'); return { events: [], notes }; }
    ctx.dir = e.dir;
    return { events: [e], notes, metrics: [{ id: 'flight', label: 'Flight time seen', value: e.flightS, unit: 's' }] };
  },
  keyframes(ctx, ev) {
    const k = [];
    for (const e of ev.events) {
      if (e.type === 'takeoff') { if (e.pen) k.push({ i: e.pen.start, label: 'Penultimate' }); k.push({ i: e.td, label: 'Plant' }, { i: e.to, label: 'Toe-off' }, { i: Math.min(e.end, e.to + ctx.sec(0.15)), label: 'Flight' }); }
      else if (e.type === 'bound') k.push({ i: e.td, label: `Landing ${e.n}` });
      else k.push({ i: e.takeoff, label: 'Take-off' }, { i: e.land, label: 'Touchdown' }, { i: e.deep, label: 'Deepest' });
    }
    return k.length ? k : null;
  },
  checks: [
    ...ljChecks, ...tjChecks, ...hjChecks,
    ...landingChecks({ group: 'land', skill: sk('landing-mech'), cpValgus: 'jp-landing-mech-c01', cpFlex: 'jp-landing-mech-c01', fault: 'jp-landing-mech-f01', minFlexDefault: 60, valgusDefault: 12, note: 'KB: knee flexion > ~60 deg during absorption' }),
  ],
};
export default jumping;
