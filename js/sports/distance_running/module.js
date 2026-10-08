// Distance running form: side view (posture, foot strike, cadence, bounce, arm carriage) and
// rear/front view (pelvic drop, knee collapse, crossover, arms crossing, shrugging).
// Works on a treadmill or outside. Steps come from the shared running step detector.
import { median } from '../../engine/geom.js';
import {
  D, r1, r2, hi, lo, band, at, ang2, trunkLean, leanDeg, shinLean, ahead, legLen2, valgusDeg, cadence, legsOk,
  baseGlobals, mk, other, segAt, dotAt, LEGS, HIPS, SHOULDERS, TRUNK,
} from '../../engine/kit.js';
import { steps, runDir, bounce } from '../sprinting/module.js';

const T = (ctx) => ctx.unit.torso2;
const sk = (id) => 'dr-' + id;
const SIDE = ['side'];
const BACK = ['rear', 'front'];

function reach(p, s, ctx) {
  // horizontal ankle-to-hip distance at touchdown as a share of leg length
  return ((p.p2(s + '_ankle')[0] - p.p2('mid_hip')[0]) * ctx.dir) / (legLen2(p, s) || 1e-9);
}
function midStance(ctx, e) {
  // the middle frame of the contact (side-agnostic, works in rear/front view)
  return Math.round((e.td + e.to) / 2);
}

const checks = [
  // ---------------- posture (side)
  mk({
    id: 'dr_lean_forward', group: 'posture', scope: 'frames:run', priority: 3, views: SIDE,
    kb: { skill: sk('posture'), checkpoint: 'dr-posture-c01', fault: 'dr-posture-f01' },
    label: 'Bent at the waist / too much forward lean', okLabel: 'Trunk lean OK (not bent over)',
    needs: TRUNK,
    params: { max_lean: { value: 15, unit: 'deg', label: 'Trunk lean forward at most', note: 'KB: ~5-10 deg forward; margin for arm swing / tracking' } },
    thresholdText: (P) => `trunk leans forward no more than ${P.max_lean} deg`,
    badness: (v, P) => hi(v, P, 'max_lean'),
    measure(p, ctx, P) {
      const v = trunkLean(p, ctx.dir);
      return { value: v, pass: v <= P.max_lean, text: `trunk ${Math.round(v)}° forward`, draw: [D.line(p, 'mid_hip', 'mid_shoulder', `${Math.round(v)}°`), D.vert(p, 'mid_hip', ctx, 'vertical', -1.2)] };
    },
  }),
  mk({
    id: 'dr_lean_back', group: 'posture', scope: 'frames:run', priority: 3, views: SIDE,
    kb: { skill: sk('posture'), checkpoint: 'dr-posture-c01', fault: 'dr-posture-f02' },
    label: 'Leaning back', okLabel: 'Not leaning back',
    needs: TRUNK,
    params: { min_lean: { value: -2, unit: 'deg', label: 'Trunk lean at least (negative = behind vertical)' } },
    thresholdText: (P) => `trunk not behind vertical by more than ${-P.min_lean} deg`,
    badness: (v, P) => lo(v, P, 'min_lean'),
    measure(p, ctx, P) {
      const v = trunkLean(p, ctx.dir);
      return { value: v, pass: v >= P.min_lean, text: v < 0 ? `leaning back ${Math.round(-v)}°` : `trunk ${Math.round(v)}° forward`, draw: [D.line(p, 'mid_hip', 'mid_shoulder', `${Math.round(v)}°`), D.vert(p, 'mid_hip', ctx, 'vertical', -1.2)] };
    },
  }),
  mk({
    id: 'dr_head', group: 'posture', scope: 'frames:run', priority: 5, views: SIDE,
    kb: { skill: sk('posture'), checkpoint: 'dr-posture-c02', fault: null, drills: ['DR-D-FATIGUE-CHECK'] },
    coach: { cue: "'Tall neck - ears over shoulders, eyes 20-30 m ahead.'", why: 'A head that juts forward pulls the trunk into a forward bend and tightens the neck and shoulders (KB: ear roughly over the shoulder).' },
    label: 'Head jutting forward', okLabel: 'Head neutral over the shoulders',
    needs: ['left_ear', 'right_ear', ...SHOULDERS],
    params: { max_deg: { value: 40, unit: 'deg', label: 'Shoulder-to-ear line may lean forward by', note: 'Estimate: in a side view the pose model places the shoulder point behind the ear, so ~20-35 deg is normal' } },
    thresholdText: (P) => `shoulder-to-ear line within ${P.max_deg} deg of vertical`,
    badness: (v, P) => hi(v, P, 'max_deg'),
    measure(p, ctx, P) {
      const v = leanDeg(p, 'mid_shoulder', 'mid_ear', ctx.dir);
      return { value: v, pass: v <= P.max_deg, text: `head ${Math.round(v)}° forward`, draw: [D.line(p, 'mid_shoulder', 'mid_ear', `${Math.round(v)}°`), D.vert(p, 'mid_shoulder', ctx, '', -0.6)] };
    },
  }),
  // ---------------- foot strike (side)
  mk({
    id: 'dr_overstride', group: 'strike', scope: 'event:step', priority: 1, views: SIDE,
    kb: { skill: sk('foot-strike'), checkpoint: 'dr-foot-strike-c01', fault: 'dr-foot-strike-f01' },
    label: 'Overstriding (foot lands far in front)', okLabel: 'Foot lands close under the hips',
    needs: [...HIPS, 'left_ankle', 'right_ankle', 'left_knee', 'right_knee'],
    params: { max_reach: { value: 0.25, unit: 'x leg', label: 'Touchdown ankle ahead of the hips at most', note: 'KB: < ~15-20% of leg length; margin for 30 fps touchdown timing' } },
    thresholdText: (P) => `touchdown ankle no more than ${Math.round(P.max_reach * 100)}% of leg length in front of the hips`,
    badness: (v, P) => hi(v, P, 'max_reach'),
    evaluate(e, ctx, P) {
      const p = at(ctx, e.td, this.needs); if (!p || !legsOk(ctx, e.td)) return null;
      const v = reach(p, e.side, ctx);
      return { value: v, pass: v <= P.max_reach, frame: e.td, text: `foot ${Math.round(v * 100)}% of leg length ahead`, draw: [D.vert(p, 'mid_hip', ctx, 'hips', -1.6), segAt(p, [p.p2('mid_hip')[0], p.p2(e.side + '_ankle')[1]], p.p2(e.side + '_ankle'), 'reach'), D.dot(p, e.side + '_ankle')] };
    },
  }),
  mk({
    id: 'dr_shank', group: 'strike', scope: 'event:step', priority: 2, views: SIDE,
    kb: { skill: sk('foot-strike'), checkpoint: 'dr-foot-strike-c02', fault: 'dr-foot-strike-f01' },
    label: 'Shin angled forward at touchdown (reaching)', okLabel: 'Shin near vertical at touchdown',
    needs: ['left_ankle', 'right_ankle', 'left_knee', 'right_knee'],
    params: { max_reach_deg: { value: 12, unit: 'deg', label: 'Foot may be ahead of the knee (shin tilt) by', note: 'KB: shank within ~0-10 deg of vertical' } },
    thresholdText: (P) => `shin tilted no more than ${P.max_reach_deg} deg with the foot ahead of the knee at touchdown`,
    badness: (v, P) => hi(v, P, 'max_reach_deg'),
    evaluate(e, ctx, P) {
      const p = at(ctx, e.td, this.needs); if (!p || !legsOk(ctx, e.td)) return null;
      const v = -shinLean(p, e.side, ctx.dir); // + = foot ahead of the knee
      return { value: v, pass: v <= P.max_reach_deg, frame: e.td, text: v > 0 ? `shin ${Math.round(v)}° (foot ahead of knee)` : 'shin vertical', draw: [D.line(p, e.side + '_knee', e.side + '_ankle', `${Math.round(v)}°`), D.vert(p, e.side + '_ankle', ctx, '', -0.8)] };
    },
  }),
  // ---------------- cadence & bounce
  mk({
    id: 'dr_cadence', group: 'cadence', scope: 'clip', priority: 2, temporal: true, views: SIDE,
    kb: { skill: sk('cadence'), checkpoint: 'dr-cadence-c01', fault: 'dr-cadence-f01' },
    label: 'Low cadence with overstriding', okLabel: 'Cadence OK for this stride',
    needs: ['left_ankle', 'right_ankle'],
    params: { min_spm: { value: 160, unit: 'steps/min', label: 'Flag cadence below', note: 'KB: < ~160-165 spm at easy pace AND overstriding' }, reach_for_fault: { value: 0.2, unit: 'x leg', label: '...only when the median touchdown reach is over' } },
    thresholdText: (P) => `fault only if cadence < ${P.min_spm} spm and median reach > ${Math.round(P.reach_for_fault * 100)}% of leg length`,
    badness: (v, P) => lo(v, P, 'min_spm'),
    evaluateClip(ctx, P) {
      const ev = (ctx.events || []).filter((e) => e.type === 'step');
      const cad = cadence(ctx, ev);
      if (!Number.isFinite(cad)) return { status: 'no_events', reason: 'Need 3+ steps in the clip to measure cadence' };
      const rs = ev.map((e) => { const p = at(ctx, e.td, [...HIPS, e.side + '_ankle']); return p && legsOk(ctx, e.td) ? reach(p, e.side, ctx) : NaN; }).filter(Number.isFinite);
      const r = median(rs) ?? 0;
      const low = cad < P.min_spm, over = r > P.reach_for_fault;
      const p = ctx.poses[ev[0].td];
      return { value: cad, pass: !(low && over), frame: ev[0].td, text: `${Math.round(cad)} spm${low ? (over ? ' with overstriding' : ' (no overstriding - OK)') : ''}`, summary: `${Math.round(cad)} steps/min, median reach ${Math.round(r * 100)}% of leg`, draw: p ? [D.dot(p, ev[0].side + '_ankle', `${Math.round(cad)} spm`)] : [] };
    },
  }),
  mk({
    id: 'dr_bounce', group: 'cadence', scope: 'clip', priority: 4, temporal: true, views: SIDE,
    kb: { skill: sk('cadence'), checkpoint: 'dr-cadence-c02', fault: 'dr-cadence-f01' },
    label: 'Bouncy stride (too much vertical motion)', okLabel: 'Low vertical bounce',
    needs: HIPS,
    params: { max_osc: { value: 0.22, unit: 'x torso', label: 'Hip rise and fall per step at most', note: 'KB: ~5-10 cm (torso ~50 cm -> 0.1-0.2)' } },
    thresholdText: (P) => `hips rise and fall less than ${P.max_osc}x torso per step`,
    badness: (v, P) => hi(v, P, 'max_osc'),
    evaluateClip(ctx, P) { return bounce(ctx, P, this); },
  }),
  // ---------------- arms
  mk({
    id: 'dr_elbow', group: 'arms_side', scope: 'frames:run', priority: 6, views: SIDE,
    kb: { skill: sk('arm-swing'), checkpoint: 'dr-arm-swing-c01', fault: null, drills: ['DR-D-ARM-SWING'] },
    coach: { cue: "'Elbows about 90 - swing from the shoulder, hands relaxed.'", why: 'A roughly right-angled elbow keeps the arm swing quick and balanced against the legs; very straight or very tight arms waste energy (KB: ~70-110 deg).' },
    label: 'Elbow angle far from ~90°', okLabel: 'Elbows around 90°',
    needs: SHOULDERS,
    params: { min_deg: { value: 55, unit: 'deg', label: 'Elbow at least' }, max_deg: { value: 125, unit: 'deg', label: 'Elbow at most', note: 'KB: ~70-110 deg; margin for 2D tracking' } },
    thresholdText: (P) => `elbow angle (camera-side arm) ${P.min_deg}-${P.max_deg} deg`,
    badness: (v, P) => band(v, P, 'min_deg', 'max_deg'),
    measure(p, ctx, P) {
      // the camera-side arm (the far arm is usually hidden behind the body in a side view)
      const s = p.vis('left_shoulder', 'left_elbow', 'left_wrist') >= p.vis('right_shoulder', 'right_elbow', 'right_wrist') ? 'left' : 'right';
      if (p.vis(s + '_elbow', s + '_wrist') < ctx.G.min_visibility) return null;
      const v = ang2(p, s + '_shoulder', s + '_elbow', s + '_wrist');
      return { value: v, pass: v >= P.min_deg && v <= P.max_deg, text: `elbow ${Math.round(v)}°`, draw: [D.ang(p, s + '_shoulder', s + '_elbow', s + '_wrist', `${Math.round(v)}°`)] };
    },
  }),
  mk({
    id: 'dr_arms_cross', group: 'arms_back', scope: 'frames:run', priority: 3, views: BACK,
    kb: { skill: sk('arm-swing'), checkpoint: 'dr-arm-swing-c01', fault: 'dr-arm-swing-f01' },
    label: 'Arms crossing the body', okLabel: 'Hands stay on their own side',
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
  mk({
    id: 'dr_shrug', group: 'arms_back', scope: 'frames:run', priority: 5, views: BACK,
    kb: { skill: sk('arm-swing'), checkpoint: 'dr-arm-swing-c01', fault: 'dr-arm-swing-f02' },
    label: 'Shrugged, tense shoulders', okLabel: 'Shoulders relaxed and low',
    needs: ['left_ear', 'right_ear', ...SHOULDERS],
    params: { min_neck: { value: 0.2, unit: 'x torso', label: 'Ears must sit above the shoulders by at least', note: 'Individual necks differ; compare with your relaxed standing value' } },
    thresholdText: (P) => `ears at least ${P.min_neck}x torso above the shoulders`,
    badness: (v, P) => lo(v, P, 'min_neck'),
    measure(p, ctx, P) {
      const v = (p.p2('mid_shoulder')[1] - p.p2('mid_ear')[1]) / T(ctx);
      return { value: v, pass: v >= P.min_neck, text: `neck gap ${r2(v)}x torso`, draw: [D.line(p, 'mid_ear', 'mid_shoulder', 'neck'), D.level(p, 'mid_shoulder', ctx, 'shoulders', 4)] };
    },
  }),
  // ---------------- pelvis & knee (rear / front)
  mk({
    id: 'dr_pelvic_drop', group: 'pelvis', scope: 'event:step', priority: 2, views: BACK,
    kb: { skill: sk('pelvis-knee'), checkpoint: 'dr-pelvis-knee-c01', fault: 'dr-pelvis-knee-f01' },
    label: 'Hip drops on the swing side', okLabel: 'Pelvis stays fairly level',
    needs: HIPS,
    params: { max_drop: { value: 8, unit: 'deg', label: 'Swing-side hip may drop by', note: 'KB: no fixed cutoff; track your own value over time' } },
    thresholdText: (P) => `swing-side hip drops less than ${P.max_drop} deg at mid-stance`,
    badness: (v, P) => hi(v, P, 'max_drop'),
    evaluate(e, ctx, P) {
      const i = midStance(ctx, e), p = at(ctx, i, this.needs); if (!p) return null;
      const st = p.p2(e.side + '_hip'), sw = p.p2(other(e.side) + '_hip');
      const v = (Math.atan2(sw[1] - st[1], Math.abs(sw[0] - st[0]) || 1e-9) * 180) / Math.PI; // + = swing hip lower
      return { value: v, pass: v <= P.max_drop, frame: i, text: `hip drop ${Math.round(v)}°`, draw: [D.line(p, 'left_hip', 'right_hip', `${Math.round(v)}°`), D.level(p, e.side + '_hip', ctx, 'level', 3)] };
    },
  }),
  mk({
    id: 'dr_valgus', group: 'pelvis', scope: 'event:step', priority: 2, views: BACK,
    kb: { skill: sk('pelvis-knee'), checkpoint: 'dr-pelvis-knee-c02', fault: 'dr-pelvis-knee-f01' },
    label: 'Knee collapses inward', okLabel: 'Knee tracks over the foot',
    needs: LEGS,
    params: { max_deg: { value: 10, unit: 'deg', label: 'Knee may cave inward by', note: 'KB: frontal-plane knee angle < ~10 deg' } },
    thresholdText: (P) => `stance knee caves in less than ${P.max_deg} deg at mid-stance`,
    badness: (v, P) => hi(v, P, 'max_deg'),
    evaluate(e, ctx, P) {
      const i = midStance(ctx, e), p = at(ctx, i, this.needs); if (!p) return null;
      const v = valgusDeg(p, e.side, ctx);
      return { value: v, pass: v <= P.max_deg, frame: i, text: v > 0 ? `knee caves in ${Math.round(v)}°` : 'knee over foot', draw: [D.line(p, e.side + '_hip', e.side + '_knee'), D.line(p, e.side + '_knee', e.side + '_ankle', `${Math.round(v)}°`)] };
    },
  }),
  mk({
    id: 'dr_crossover', group: 'pelvis', scope: 'event:step', priority: 3, views: BACK,
    kb: { skill: sk('pelvis-knee'), checkpoint: 'dr-pelvis-knee-c03', fault: 'dr-pelvis-knee-f02' },
    label: 'Crossover gait (feet cross the midline)', okLabel: 'Feet land on their own side',
    needs: [...HIPS, 'left_ankle', 'right_ankle'],
    params: { max_cross: { value: 0.03, unit: 'x torso', label: 'Foot may land past the midline by' } },
    thresholdText: (P) => `foot lands no more than ${P.max_cross}x torso past the body midline`,
    badness: (v, P) => hi(v, P, 'max_cross'),
    evaluate(e, ctx, P) {
      const p = at(ctx, e.td, this.needs); if (!p) return null;
      const mx = p.p2('mid_hip')[0], own = Math.sign(p.p2(e.side + '_hip')[0] - mx) || 1;
      const v = ((mx - p.p2(e.side + '_ankle')[0]) * own) / T(ctx);
      return { value: v, pass: v <= P.max_cross, frame: e.td, text: v > 0 ? `foot ${r2(v)}x torso past the midline` : 'own side', draw: [D.vert(p, 'mid_hip', ctx, 'midline', -2.2), D.dot(p, e.side + '_ankle')] };
    },
  }),
];

const distance = {
  id: 'distance_running', name: 'Distance running',
  roles: () => ({}),
  stances: null,
  views: [
    { id: 'side', label: 'Side', hint: 'Perpendicular to the runner, hip height' },
    { id: 'rear', label: 'Rear', hint: 'From behind (treadmill is ideal)' },
    { id: 'front', label: 'Front', hint: 'Runner coming toward the camera' },
  ],
  filmingTips: [
    'Treadmill is easiest: camera on a tripod at hip height, 2-3 m away, whole body in frame.',
    'Outside: side view perpendicular to the path, camera still, 8+ steps in frame; or film from behind for hips/knees.',
    'Film at your normal easy pace after a warm-up; 10-20 s is plenty. 60+ fps helps touchdown timing.',
  ],
  skills: [
    { id: 'side_form', label: 'Running form (side view)', kbSkills: [sk('posture'), sk('foot-strike'), sk('cadence'), sk('arm-swing')], kbSkill: sk('foot-strike'), checks: ['strike', 'posture', 'cadence', 'arms_side'], all: true, view: 'side', minFps: 30,
      filming: ['Side view, perpendicular to the runner, camera at hip height.', 'Whole body incl. feet in frame for 8+ steps (treadmill: 10 s).', 'A railing in front of the legs hides the feet - move the camera so the legs are clear.'] },
    { id: 'rear_form', label: 'Hips, knees & arms (rear/front)', kbSkills: [sk('pelvis-knee'), sk('arm-swing')], kbSkill: sk('pelvis-knee'), checks: ['pelvis', 'arms_back'], all: true, view: 'rear', minFps: 30,
      filming: ['From directly behind (or in front), camera at hip height, whole body in frame.', 'Treadmill from behind is ideal. Tight clothing helps the hips and knees track.'] },
  ],
  frameLabels: { run: 'running frames' },
  noFramesReason: () => 'No running frames found',
  eventLabel: (t) => ({ step: 'steps' })[t] || t,
  globals: baseGlobals({
    contact_tol: { value: 0.1, label: 'Foot counts as on the ground within', unit: 'x torso' },
  }),
  detectEvents(ctx) {
    const notes = [];
    ctx.dir = runDir(ctx);
    const posed = ctx.poses.map((p, i) => (p && (ctx.isPhoto || legsOk(ctx, i)) ? i : -1)).filter((i) => i >= 0);
    if (ctx.isPhoto) return { events: [], frameSets: { run: posed }, notes: ['Photo: posture/arm checks only. Film 10 s of running for the stride checks.'] };
    // in rear/front views the legs are not swapped and feet land side by side: no merging, shorter window
    const ev = steps(ctx, ctx.view === 'side' ? {} : { merge: false, win: 0.35 });
    if (ev.length < 3) notes.push('Fewer than 3 foot contacts found: keep both feet in frame for 8+ steps.');
    if (ctx.fps < 50) notes.push(`${Math.round(ctx.fps)} fps: touchdown is located to the nearest frame, so reach/shin values are approximate.`);
    const metrics = [];
    const cad = cadence(ctx, ev);
    if (Number.isFinite(cad)) metrics.push({ id: 'cadence', label: 'Cadence', value: Math.round(cad), unit: 'steps/min' });
    return { events: ev, frameSets: { run: posed }, notes, metrics };
  },
  keyframes(ctx, ev) {
    const k = [];
    for (const e of ev.events) { k.push({ i: e.td, label: `Touchdown ${e.side[0].toUpperCase()}` }); if (e.complete) k.push({ i: Math.round((e.td + e.to) / 2), label: `Mid-stance ${e.side[0].toUpperCase()}` }); }
    return k.length ? k.slice(0, 16) : null;
  },
  checks,
};
export default distance;
