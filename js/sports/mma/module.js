// MMA: hybrid stance, strikes (boxing punch checks + boxing KB), level change for the double-leg,
// and the sprawl. Ground-and-pound and the technical stand-up are coach-checklist skills
// (two bodies on the floor / sitting positions are where single-person pose tracking breaks).
import { dist } from '../../engine/geom.js';
import {
  D, r1, r2, hi, lo, band, at, maxOver, minOver, ang2, joint, trunkLean, leanDeg, facing, medianSign, standingHipHeight,
  fillGaps, smooth1, baseGlobals, mk, LEGS, HIPS, SHOULDERS, TRUNK,
} from '../../engine/kit.js';
import { groundY } from '../shared/moves.js';
import { boxing } from '../boxing/module.js';

const T = (ctx) => ctx.unit.torso2;
const sk = (id) => 'mm-' + id;
const SIDE = ['side'];
const kneeAvg = (p, ctx) => (joint(p, 'left_hip', 'left_knee', 'left_ankle', ctx) + joint(p, 'right_hip', 'right_knee', 'right_ankle', ctx)) / 2;

/** level changes: the hips drop a lot, quickly (shot or sprawl) */
function detectLevelChanges(ctx, type) {
  const { poses, sec, G } = ctx;
  const N = poses.length, g = groundY(ctx);
  const H0 = standingHipHeight(ctx);
  if (!Number.isFinite(g) || !Number.isFinite(H0)) return [];
  const h = smooth1(fillGaps(poses.map((p) => (p && p.vis(...HIPS) >= 0.3 ? (g - p.p2('mid_hip')[1]) / H0 : NaN)), 3), 1);
  ctx.H0 = H0; ctx.hipRel = h;
  const out = [];
  let i = 0;
  while (i < N) {
    if (!(h[i] <= 1 - G.level_min_drop)) { i++; continue; }
    // dropped: find the start (last frame near standing height, within 1 s) and the bottom
    let a = i; while (a > 0 && Number.isFinite(h[a - 1]) && h[a - 1] < 0.92 && i - a < sec(1.0)) a--;
    let z = i; while (z < N - 1 && h[z + 1] <= 1 - G.level_min_drop * 0.5) z++;
    let bot = i; for (let j = i; j <= z; j++) if (h[j] < h[bot]) bot = j;
    // a real level change takes ~0.15-0.6 s and stays down for a moment (not a one-frame glitch)
    if (i - a <= sec(1.0) && bot - a >= sec(0.12) && z - i + 1 >= sec(0.12)) out.push({ type, start: a, peak: bot, end: Math.min(N - 1, z + sec(0.3)), drop: r2(1 - h[bot]), dropTime: r2((bot - a) / ctx.fps) });
    i = z + sec(0.5);
  }
  return out;
}

const mstance = [
  mk({
    id: 'mm_knees', group: 'mstance', scope: 'guard', priority: 1,
    kb: { skill: sk('stance'), checkpoint: 'mm-stance-c01', fault: 'mm-stance-f01' },
    label: 'Too upright (knees nearly straight)', okLabel: 'Knees bent, ready to sprawl or shoot',
    needs: LEGS, visReason: 'Legs not visible - film head to toe',
    params: { max_knee: { value: 165, unit: 'deg', label: 'Average knee angle at most', note: 'KB: knee angle ~130-160 deg' }, min_knee: { value: 110, unit: 'deg', label: 'Average knee angle at least (not squatting)' } },
    thresholdText: (P) => `average knee angle ${P.min_knee}-${P.max_knee} deg between strikes`,
    badness: (v, P) => band(v, P, 'min_knee', 'max_knee'),
    measure(p, ctx, P) {
      const v = kneeAvg(p, ctx);
      return { value: v, pass: v >= P.min_knee && v <= P.max_knee, text: `knees ${Math.round(v)}°`, draw: [D.ang(p, 'left_hip', 'left_knee', 'left_ankle', `${Math.round(joint(p, 'left_hip', 'left_knee', 'left_ankle', ctx))}°`), D.ang(p, 'right_hip', 'right_knee', 'right_ankle', `${Math.round(joint(p, 'right_hip', 'right_knee', 'right_ankle', ctx))}°`)] };
    },
  }),
  mk({
    id: 'mm_waist', group: 'mstance', scope: 'guard', priority: 2, views: SIDE,
    kb: { skill: sk('stance'), checkpoint: 'mm-stance-c02', fault: 'mm-stance-f02' },
    label: 'Bending at the waist', okLabel: 'Back straight, chest over the knees',
    needs: TRUNK,
    params: { max_lean: { value: 30, unit: 'deg', label: 'Trunk lean forward at most', note: 'KB: head above hips, back straight' } },
    thresholdText: (P) => `trunk leans forward ${P.max_lean} deg or less`,
    badness: (v, P) => hi(v, P, 'max_lean'),
    measure(p, ctx, P) {
      const v = Math.abs(leanDeg(p, 'mid_hip', 'mid_shoulder', 1));
      return { value: v, pass: v <= P.max_lean, text: `trunk ${Math.round(v)}°`, draw: [D.line(p, 'mid_hip', 'mid_shoulder', `${Math.round(v)}°`), D.vert(p, 'mid_hip', ctx, 'vertical', -1.2)] };
    },
  }),
  mk({
    id: 'mm_width', group: 'mstance', scope: 'guard', priority: 3, views: ['front'],
    kb: { skill: sk('stance'), checkpoint: 'mm-stance-c01', fault: 'mm-stance-f01' },
    label: 'Narrow / crossed feet', okLabel: 'Feet wide enough for takedown defence',
    needs: ['left_ankle', 'right_ankle', ...SHOULDERS], visReason: 'Feet not visible - film head to toe',
    params: { min_ratio: { value: 0.9, unit: 'x shoulders', label: 'Feet apart (side to side) at least', note: 'KB: slightly wider than boxing' } },
    thresholdText: (P) => `ankles at least ${P.min_ratio}x shoulder width apart`,
    badness: (v, P) => lo(v, P, 'min_ratio'),
    measure(p, ctx, P) {
      const v = Math.abs(p.p2('left_ankle')[0] - p.p2('right_ankle')[0]) / (dist(p.p2('left_shoulder'), p.p2('right_shoulder')) || 1e-9);
      return { value: v, pass: v >= P.min_ratio, text: `feet ${r1(v)}x shoulders`, draw: [D.line(p, 'left_ankle', 'right_ankle', `${r1(v)}x`), D.line(p, 'left_shoulder', 'right_shoulder')] };
    },
  }),
];

const shot = [
  mk({
    id: 'dl_drop', group: 'double_leg', scope: 'event:shot', priority: 2, views: SIDE,
    kb: { skill: sk('double-leg'), checkpoint: 'mm-double-leg-c01', fault: 'mm-double-leg-f02' },
    label: 'Shallow level change', okLabel: 'Big level change (hips dropped)',
    needs: HIPS,
    params: { min_drop: { value: 0.25, unit: 'of hip height', label: 'Hips drop at least', note: 'KB: > ~20-30% of standing hip height' } },
    thresholdText: (P) => `hips drop ${Math.round(P.min_drop * 100)}% of standing hip height or more`,
    badness: (v, P) => lo(v, P, 'min_drop'),
    evaluate(e, ctx, P) {
      const p = at(ctx, e.peak, this.needs); if (!p) return null;
      return { value: e.drop, pass: e.drop >= P.min_drop, frame: e.peak, text: `hips dropped ${Math.round(e.drop * 100)}%`, draw: [D.level(p, 'mid_hip', ctx, 'hips', 5)] };
    },
  }),
  mk({
    id: 'dl_waist', group: 'double_leg', scope: 'event:shot', priority: 1, views: SIDE,
    kb: { skill: sk('double-leg'), checkpoint: 'mm-double-leg-c01', fault: 'mm-double-leg-f01' },
    label: 'Bending at the waist (reaching shot)', okLabel: 'Level change with the legs, back straight',
    needs: TRUNK,
    params: { max_lean: { value: 45, unit: 'deg', label: 'Trunk lean from vertical at the bottom at most', note: 'KB: < ~45 deg' } },
    thresholdText: (P) => `trunk within ${P.max_lean} deg of vertical at the bottom of the level change`,
    badness: (v, P) => hi(v, P, 'max_lean'),
    evaluate(e, ctx, P) {
      const p = at(ctx, e.peak, this.needs); if (!p) return null;
      const v = Math.abs(leanDeg(p, 'mid_hip', 'mid_shoulder', 1));
      return { value: v, pass: v <= P.max_lean, frame: e.peak, text: `trunk ${Math.round(v)}° from vertical`, draw: [D.line(p, 'mid_hip', 'mid_shoulder', `${Math.round(v)}°`), D.vert(p, 'mid_hip', ctx, 'vertical', -1.2)] };
    },
  }),
  mk({
    id: 'dl_head', group: 'double_leg', scope: 'event:shot', priority: 2, views: SIDE,
    kb: { skill: sk('double-leg'), checkpoint: 'mm-double-leg-c01', fault: null, drills: ['MM-D-PEN-STEP'] },
    coach: { cue: "'Head up, eyes on his chest.'", why: 'Keeping the head up keeps the back straight and the hips under you, so you drive through instead of falling onto your knees; a dropped head invites the front headlock (KB: head above the shoulders).' },
    label: 'Head down on the shot', okLabel: 'Head up on the shot',
    needs: ['nose', ...SHOULDERS],
    params: { max_below: { value: 0.1, unit: 'x torso', label: 'Nose may dip below the shoulder line by' } },
    thresholdText: (P) => `nose no more than ${P.max_below}x torso below the shoulders at the bottom`,
    badness: (v, P) => hi(v, P, 'max_below'),
    evaluate(e, ctx, P) {
      const p = at(ctx, e.peak, this.needs); if (!p) return null;
      const v = (p.p2('nose')[1] - p.p2('mid_shoulder')[1]) / T(ctx);
      return { value: v, pass: v <= P.max_below, frame: e.peak, text: v > 0 ? `head ${r1(v)}x torso below shoulders` : 'head up', draw: [D.level(p, 'mid_shoulder', ctx, 'shoulders', 4), D.dot(p, 'nose', 'head')] };
    },
  }),
  mk({
    id: 'dl_knee', group: 'double_leg', scope: 'event:shot', priority: 3, views: SIDE,
    kb: { skill: sk('double-leg'), checkpoint: 'mm-double-leg-c02', fault: 'mm-double-leg-f02' },
    label: 'Shallow penetration step (knee stays high)', okLabel: 'Deep step, lead knee near the mat',
    needs: ['left_knee', 'right_knee'],
    params: { max_up: { value: 0.4, unit: 'x torso', label: 'Lowest knee at most this far off the floor' } },
    thresholdText: (P) => `lowest knee within ${P.max_up}x torso of the floor at the bottom of the shot`,
    badness: (v, P) => hi(v, P, 'max_up'),
    evaluate(e, ctx, P) {
      const g = groundY(ctx);
      const b = minOver(ctx, e.start, e.end, this.needs, (p) => (g - Math.max(p.p2('left_knee')[1], p.p2('right_knee')[1])) / T(ctx)); if (!b) return null;
      const k = b.p.p2('left_knee')[1] >= b.p.p2('right_knee')[1] ? 'left' : 'right';
      return { value: b.v, pass: b.v <= P.max_up, frame: b.i, text: `knee ${r1(b.v)}x torso off the mat`, draw: [D.dot(b.p, k + '_knee', 'lead knee'), D.level(b.p, k + '_ankle', ctx, 'mat', 5)] };
    },
  }),
];

const sprawl = [
  mk({
    id: 'sp_legs', group: 'sprawl', scope: 'event:sprawl', priority: 1, views: SIDE,
    kb: { skill: sk('sprawl'), checkpoint: 'mm-sprawl-c01', fault: 'mm-sprawl-f01' },
    label: 'Legs not kicked back', okLabel: 'Legs kicked back straight',
    needs: LEGS,
    params: { min_knee: { value: 145, unit: 'deg', label: 'Average knee angle at the bottom at least', note: 'KB: legs extend behind, knee > ~150 deg' } },
    thresholdText: (P) => `knees ${P.min_knee} deg or straighter at the bottom of the sprawl`,
    badness: (v, P) => lo(v, P, 'min_knee'),
    evaluate(e, ctx, P) {
      const b = maxOver(ctx, e.peak - ctx.sec(0.1), Math.min(e.end, e.peak + ctx.sec(0.3)), this.needs, (p) => (ang2(p, 'left_hip', 'left_knee', 'left_ankle') + ang2(p, 'right_hip', 'right_knee', 'right_ankle')) / 2); if (!b) return null;
      return { value: b.v, pass: b.v >= P.min_knee, frame: b.i, text: `knees ${Math.round(b.v)}°`, draw: [D.ang(b.p, 'left_hip', 'left_knee', 'left_ankle'), D.ang(b.p, 'right_hip', 'right_knee', 'right_ankle', `${Math.round(b.v)}°`)] };
    },
  }),
  mk({
    id: 'sp_hips', group: 'sprawl', scope: 'event:sprawl', priority: 2, views: SIDE,
    kb: { skill: sk('sprawl'), checkpoint: 'mm-sprawl-c01', fault: 'mm-sprawl-f01' },
    label: 'Hips not dropped (sprawl too high)', okLabel: 'Hips dropped heavy',
    needs: HIPS,
    params: { min_drop: { value: 0.45, unit: 'of hip height', label: 'Hips drop at least', note: 'Hips should land heavy on the attacker - well below half standing height' } },
    thresholdText: (P) => `hips drop ${Math.round(P.min_drop * 100)}% of standing hip height or more`,
    badness: (v, P) => lo(v, P, 'min_drop'),
    evaluate(e, ctx, P) {
      const p = at(ctx, e.peak, this.needs); if (!p) return null;
      return { value: e.drop, pass: e.drop >= P.min_drop, frame: e.peak, text: `hips dropped ${Math.round(e.drop * 100)}%`, draw: [D.level(p, 'mid_hip', ctx, 'hips', 5)] };
    },
  }),
  mk({
    id: 'sp_head', group: 'sprawl', scope: 'event:sprawl', priority: 1, views: SIDE,
    kb: { skill: sk('sprawl'), checkpoint: 'mm-sprawl-c01', fault: 'mm-sprawl-f02' },
    label: 'Head down in the sprawl', okLabel: 'Head up, above the hips',
    needs: ['nose', ...HIPS],
    params: { min_above: { value: 0.2, unit: 'x torso', label: 'Head above the hips by at least' } },
    thresholdText: (P) => `nose at least ${P.min_above}x torso above the hips at the bottom`,
    badness: (v, P) => lo(v, P, 'min_above'),
    evaluate(e, ctx, P) {
      const p = at(ctx, e.peak, this.needs); if (!p) return null;
      const v = (p.p2('mid_hip')[1] - p.p2('nose')[1]) / T(ctx);
      return { value: v, pass: v >= P.min_above, frame: e.peak, text: v >= P.min_above ? 'head up' : `head ${r1(-v)}x torso below the hips`, draw: [D.level(p, 'mid_hip', ctx, 'hips', 5), D.dot(p, 'nose', 'head')] };
    },
  }),
];

const mma = {
  ...boxing,
  id: 'mma', name: 'MMA', kbFile: undefined,
  filmingTips: [
    'Whole body in frame, head to toe (the level change and sprawl need the feet and knees).',
    'Side view for stance depth, shots and sprawls; front view for punches and stance width.',
    'One athlete in frame for automatic checks (partner drills confuse the single-person tracker - use the checklist).',
  ],
  skills: [
    { id: 'stance', label: 'MMA stance', kbSkill: sk('stance'), checks: ['mstance', 'guard'], all: true, view: 'side', beta: true,
      filming: ['Side view, whole body, moving in stance (shadow footwork) for 10 s. A photo works too.'] },
    { id: 'strikes', label: 'Strikes (jab/cross/hook)', kbSkill: 'bx-jab', kbSkills: ['bx-jab', 'bx-cross', 'bx-hook'], checks: ['jab', 'cross', 'hook', 'guard'], all: true, view: 'front' },
    { id: 'double_leg', label: 'Level change / double-leg', kbSkill: sk('double-leg'), checks: ['double_leg'], all: true, view: 'side', beta: true, minFps: 30,
      filming: ['Side view, whole body, 4-5 m away. Shadow shots or on a dummy/partner (partner may confuse the tracker).', 'Include the stance before the shot and the drive after.'] },
    { id: 'sprawl', label: 'Sprawl', kbSkill: sk('sprawl'), checks: ['sprawl'], all: true, view: 'side', beta: true, minFps: 30,
      filming: ['Side view, whole body, solo sprawls on a call (partner shots may confuse the tracker).'] },
    { id: 'gnp', label: 'Ground & pound (top guard)', kbSkill: sk('gnp-guard'), checks: [], mode: 'checklist', view: 'side',
      checklistWhy: 'two bodies tangled on the floor; single-person tracking can\'t separate them reliably',
      filming: ['Side view, low camera, both athletes in frame.'] },
    { id: 'standup', label: 'Technical stand-up', kbSkill: sk('tech-standup'), checks: [], mode: 'checklist', view: 'side',
      checklistWhy: 'seated/posting positions are tracked poorly and the 3-point base needs hand-on-floor detail',
      filming: ['Side view, whole body, 3-5 reps each side.'] },
  ],
  eventLabel: (t) => ({ shot: 'level changes', sprawl: 'sprawls' })[t] || boxing.eventLabel(t),
  globals: {
    ...boxing.globals,
    level_min_drop: { value: 0.18, label: 'Level change: hips drop at least', unit: 'of hip height' },
  },
  detectEvents(ctx) {
    const id = ctx.skill.id;
    if (id === 'double_leg' || id === 'sprawl') {
      if (ctx.isPhoto) return { events: [], notes: ['Level changes need a video.'] };
      const type = id === 'double_leg' ? 'shot' : 'sprawl';
      const ev = detectLevelChanges(ctx, type);
      const notes = ev.length ? [] : [`No ${id === 'sprawl' ? 'sprawl' : 'level change'} found: keep the whole body (feet too) in frame and the camera still.`];
      return { events: ev, notes };
    }
    const b = boxing.detectEvents(ctx);
    if (id === 'stance') {
      // don't judge the stance while the athlete is down in a level change
      const lc = ctx.isPhoto ? [] : detectLevelChanges(ctx, 'shot');
      const busy = (i) => lc.some((e) => i >= e.start && i <= e.end);
      return { ...b, guardFrames: b.guardFrames.filter((i) => !busy(i)) };
    }
    return b;
  },
  keyframes(ctx, ev) {
    const k = [];
    for (const e of ev.events) {
      if (e.type === 'shot' || e.type === 'sprawl') k.push({ i: e.start, label: 'Stance' }, { i: e.peak, label: e.type === 'shot' ? 'Bottom of the shot' : 'Bottom of the sprawl' }, { i: e.end, label: 'After' });
      else k.push({ i: e.peak, label: boxing.eventLabel(e.type).replace(/s$/, '') });
    }
    return k.length ? k.slice(0, 18) : null;
  },
  checks: [...boxing.checks.filter((c) => c.group !== 'stance'), ...mstance, ...shot, ...sprawl],
};
export default mma;
