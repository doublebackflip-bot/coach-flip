// Soccer rules. Automatic: instep drive (shooting) and cutting/landing (FIFA 11+ jump-landing).
// Coach checklist: inside pass, first touch, dribbling/feints, heading - these depend on the ball,
// the opponent or the head-ball contact, which pose tracking alone can't see.
import { dist } from '../../engine/geom.js';
import {
  D, r1, hi, lo, band, at, maxOver, minOver, ang2, ang3, joint, trunkLean, ahead, speed, smooth1, fillGaps, peaks, medianSign,
  baseGlobals, mk, LEGS, HIPS, SHOULDERS, TRUNK,
} from '../../engine/kit.js';
import { stillBefore, detectLandings, landingChecks } from '../shared/moves.js';

const T = (ctx) => ctx.unit.torso2;
const sk = (id) => 'so-' + id;
const KLEG = ['kick_hip', 'kick_knee', 'kick_ankle'];
const SLEG = ['support_hip', 'support_knee', 'support_ankle'];

function detectKicks(ctx) {
  const { poses, sec, G } = ctx;
  const N = poses.length;
  const v = smooth1(fillGaps(speed(ctx, 'kick_ankle'), 2), 1);
  const out = [];
  for (const i of peaks(v, { min: G.kick_min_speed, prom: G.kick_min_speed * 0.5, win: sec(0.25), back: sec(0.6), gap: sec(1.2) })) {
    const p = poses[i], q = poses[Math.max(0, i - 2)];
    if (!p || !q || p.vis(...KLEG, ...SLEG) < 0.3) continue;
    // a kick swings the foot low and forward past the support foot (not a step or a knee lift)
    if (p.p2('kick_ankle')[1] < p.p2('support_knee')[1]) continue;
    const dir = Math.sign(p.p2('kick_ankle')[0] - q.p2('kick_ankle')[0]) || 1;
    const plant = stillBefore(ctx, 'support_ankle', i, sec(0.6)) ?? Math.max(0, i - sec(0.15));
    const bs = minOver(ctx, Math.max(0, plant - sec(0.3)), i, KLEG, (pp) => ang2(pp, 'kick_hip', 'kick_knee', 'kick_ankle'));
    out.push({ type: 'kick', side: 'kick', start: Math.max(0, plant - sec(0.4)), plant, backswing: bs ? bs.i : plant, peak: i, end: Math.min(N - 1, i + sec(0.5)), dir });
  }
  return out;
}

const kickChecks = [
  mk({
    id: 'so_plant', group: 'instep', scope: 'event:kick', priority: 1, views: ['side'],
    kb: { skill: sk('instep-drive'), checkpoint: 'so-instep-drive-c02', fault: 'so-instep-drive-f01' },
    label: 'Support foot planted too far behind the ball', okLabel: 'Support foot planted beside the ball',
    needs: ['support_ankle', 'kick_ankle'], visReason: 'Feet not visible - film from the side, whole body in frame',
    params: { max_behind: { value: 0.6, unit: 'x torso', label: 'At contact the kicking foot may be ahead of the support foot by', note: 'Ball position estimated from the kicking foot at contact; KB: support foot beside / slightly behind the ball' } },
    thresholdText: (P) => `kicking foot no more than ${P.max_behind}x torso ahead of the support foot at contact`,
    badness: (v, P) => hi(v, P, 'max_behind'),
    evaluate(e, ctx, P) {
      const p = at(ctx, e.peak, this.needs); if (!p) return null;
      const v = ((p.p2('kick_ankle')[0] - p.p2('support_ankle')[0]) * e.dir) / T(ctx);
      return { value: v, pass: v <= P.max_behind, frame: e.peak, text: `plant ${r1(v)}x torso behind the ball`, draw: [D.line(p, 'support_ankle', 'kick_ankle', 'plant to ball'), D.dot(p, 'support_ankle', 'plant')] };
    },
  }),
  mk({
    id: 'so_lean_back', group: 'instep', scope: 'event:kick', priority: 2, views: ['side'],
    kb: { skill: sk('instep-drive'), checkpoint: 'so-instep-drive-c05', fault: 'so-instep-drive-f02' },
    label: 'Leaning back at contact', okLabel: 'Body over the ball at contact',
    needs: TRUNK,
    params: { min_lean: { value: -8, unit: 'deg', label: 'Trunk lean at contact at least (negative = leaning back)', note: 'KB: shoulders over or ahead of the ball for a low drive' } },
    thresholdText: (P) => `trunk no further back than ${-P.min_lean} deg at contact`,
    badness: (v, P) => lo(v, P, 'min_lean'),
    evaluate(e, ctx, P) {
      const p = at(ctx, e.peak, this.needs); if (!p) return null;
      const v = trunkLean(p, e.dir);
      return { value: v, pass: v >= P.min_lean, frame: e.peak, text: v < 0 ? `leaning back ${Math.round(-v)}°` : `trunk ${Math.round(v)}° forward`, draw: [D.line(p, 'mid_hip', 'mid_shoulder', `${Math.round(v)}°`), D.vert(p, 'mid_hip', ctx, 'vertical', -1.2)] };
    },
  }),
  mk({
    id: 'so_support_knee', group: 'instep', scope: 'event:kick', priority: 4, views: ['side'],
    kb: { skill: sk('instep-drive'), checkpoint: 'so-instep-drive-c03', fault: null, drills: ['SO-D-PLANT'] },
    coach: { cue: "'Land on a soft support knee, then drive up through the ball.'", why: 'A flexed support knee at plant absorbs the approach and gives a stable base; a locked knee blocks the hip turn and makes the shot inaccurate (KB: ~20-40 deg flexion at plant).' },
    label: 'Support leg locked at plant', okLabel: 'Support knee flexed at plant',
    needs: SLEG,
    params: { max_angle: { value: 168, unit: 'deg', label: 'Support knee angle at plant at most', note: 'KB: knee flexion ~20-40 deg (angle ~140-160)' } },
    thresholdText: (P) => `support knee ${P.max_angle} deg or more bent between plant and contact`,
    badness: (v, P) => hi(v, P, 'max_angle'),
    evaluate(e, ctx, P) {
      const b = minOver(ctx, e.plant, e.peak, this.needs, (p) => ang2(p, 'support_hip', 'support_knee', 'support_ankle')); if (!b) return null;
      return { value: b.v, pass: b.v <= P.max_angle, frame: b.i, text: `support knee ${Math.round(b.v)}°`, draw: [D.ang(b.p, 'support_hip', 'support_knee', 'support_ankle', `${Math.round(b.v)}°`)] };
    },
  }),
  mk({
    id: 'so_backswing', group: 'instep', scope: 'event:kick', priority: 3, views: ['side'],
    kb: { skill: sk('instep-drive'), checkpoint: 'so-instep-drive-c04', fault: 'so-instep-drive-f04' },
    label: 'Short backswing (little knee bend)', okLabel: 'Full backswing (knee cocked)',
    needs: KLEG,
    params: { max_angle: { value: 110, unit: 'deg', label: 'Kicking knee angle at the end of the backswing at most', note: 'KB: max knee flexion ~90-110 deg at the end of the backswing' } },
    thresholdText: (P) => `kicking knee bends to ${P.max_angle} deg or less in the backswing`,
    badness: (v, P) => hi(v, P, 'max_angle'),
    evaluate(e, ctx, P) {
      const b = minOver(ctx, Math.max(0, e.plant - ctx.sec(0.3)), e.peak, this.needs, (p) => ang2(p, 'kick_hip', 'kick_knee', 'kick_ankle')); if (!b) return null;
      return { value: b.v, pass: b.v <= P.max_angle, frame: b.i, text: `knee only bent to ${Math.round(b.v)}°`, draw: [D.ang(b.p, 'kick_hip', 'kick_knee', 'kick_ankle', `${Math.round(b.v)}°`)] };
    },
  }),
  mk({
    id: 'so_ankle_lock', group: 'instep', scope: 'event:kick', priority: 3, views: ['side'],
    kb: { skill: sk('instep-drive'), checkpoint: 'so-instep-drive-c05', fault: 'so-instep-drive-f03' },
    label: 'Toe up / floppy ankle at contact', okLabel: 'Toes pointed (ankle locked) at contact',
    needs: ['kick_knee', 'kick_ankle', 'kick_foot_index'], visReason: 'Kicking foot not clear enough - film from the side, close enough to see the foot',
    params: { min_angle: { value: 125, unit: 'deg', label: 'Knee-ankle-toe angle at contact at least', note: 'Estimate: pointed foot ~140-170 deg, flexed (toe up) ~90-110 deg' } },
    thresholdText: (P) => `knee-ankle-toe angle ${P.min_angle} deg or more at contact (foot pointed)`,
    badness: (v, P) => lo(v, P, 'min_angle'),
    evaluate(e, ctx, P) {
      const b = maxOver(ctx, e.peak - 1, e.peak + 1, this.needs, (p) => ang2(p, 'kick_knee', 'kick_ankle', 'kick_foot_index')); if (!b) return null;
      return { value: b.v, pass: b.v >= P.min_angle, frame: b.i, text: `foot angle ${Math.round(b.v)}°`, draw: [D.ang(b.p, 'kick_knee', 'kick_ankle', 'kick_foot_index', `${Math.round(b.v)}°`)] };
    },
  }),
  mk({
    id: 'so_arm_out', group: 'instep', scope: 'event:kick', priority: 5, views: ['front'],
    kb: { skill: sk('instep-drive'), checkpoint: 'so-instep-drive-c06', fault: null, drills: ['SO-D-WALL-STRIKE'] },
    coach: { cue: "'Opposite arm out wide for balance.'", why: 'Swinging the non-kicking arm out and back balances the leg swing and lets the trunk add to the kick (KB: non-kicking arm abducted during the swing).' },
    label: 'Non-kicking arm tucked in', okLabel: 'Opposite arm out for balance',
    needs: ['support_wrist', 'support_shoulder', ...HIPS],
    params: { min_out: { value: 0.45, unit: 'x torso', label: 'Opposite wrist out from the shoulder at least' } },
    thresholdText: (P) => `non-kicking-side wrist at least ${P.min_out}x torso out from the shoulder at contact`,
    badness: (v, P) => lo(v, P, 'min_out'),
    evaluate(e, ctx, P) {
      const b = maxOver(ctx, e.peak - ctx.sec(0.2), e.peak + 1, this.needs, (p) => {
        const mx = p.p2('mid_hip')[0], own = Math.sign(p.p2('support_shoulder')[0] - mx) || 1;
        return ((p.p2('support_wrist')[0] - p.p2('support_shoulder')[0]) * own) / T(ctx);
      }); if (!b) return null;
      return { value: b.v, pass: b.v >= P.min_out, frame: b.i, text: `arm ${r1(b.v)}x torso out`, draw: [D.line(b.p, 'support_shoulder', 'support_wrist', 'balance arm')] };
    },
  }),
];

const soccer = {
  id: 'soccer', name: 'Soccer',
  roles: (st) => (st === 'left' ? { kick: 'left', support: 'right' } : { kick: 'right', support: 'left' }),
  stanceLabel: 'Kicking foot',
  stances: [
    { id: 'right', label: 'Right-footed', hint: 'kicks with the right foot' },
    { id: 'left', label: 'Left-footed', hint: 'kicks with the left foot' },
  ],
  views: [
    { id: 'side', label: 'Side', hint: 'Perpendicular to the shot, kicking-foot side' },
    { id: 'front', label: 'Front', hint: 'From the target (goal) or straight at the player' },
  ],
  filmingTips: [
    'Phone on a tripod or a cone at hip height, 4-6 m away, whole body and the ball in frame.',
    'One player in frame. 3-5 reps per clip.',
  ],
  skills: [
    { id: 'instep', label: 'Instep drive (shooting)', kbSkill: sk('instep-drive'), checks: ['instep'], all: true, view: 'side', minFps: 30,
      filming: ['Side view from the kicking-foot side, 4-6 m away, level with the ball.', 'Include the last 2-3 approach steps and the follow-through.', 'Slow-mo (120+ fps) helps: contact lasts ~0.01 s. At 30 fps "contact" = fastest foot frame.', 'Front view (from the goal) checks the balance arm.'] },
    { id: 'cut_land', label: 'Cutting & landing (11+)', kbSkill: sk('cut-land'), checks: ['landing'], all: true, view: 'front', minFps: 30,
      filming: ['Front view, camera at knee-hip height, 3-5 m away, whole body in frame.', 'Jump-landings (FIFA 11+ jumps, drop jumps, hops): 3-5 reps per clip.', 'Planted cuts without a jump are not detected automatically - use the checklist for those.'] },
    { id: 'inside_pass', label: 'Inside-of-foot pass', kbSkill: sk('inside-pass'), checks: [], mode: 'checklist', view: 'front',
      checklistWhy: 'foot turn-out and ball contact need foot/ball detail that body tracking does not give',
      filming: ['Front or behind view along the pass line, whole body and ball in frame.', 'Pass against a wall or partner, 5 reps.'] },
    { id: 'first_touch', label: 'First touch / receiving', kbSkill: sk('first-touch'), checks: [], mode: 'checklist', view: 'side',
      checklistWhy: 'body shape vs the incoming pass and where the ball goes need the ball and the field',
      filming: ['High angle if possible (top view shows body shape best), or side view.', 'Include the 2 s before the ball arrives (scanning) and the first touch.'] },
    { id: 'dribble', label: 'Dribbling & 1v1 feints', kbSkill: sk('dribble-1v1'), checks: [], mode: 'checklist', view: 'front',
      checklistWhy: 'ball distance and beating the defender need ball and opponent tracking',
      filming: ['Front view of the dribbler coming toward the camera, whole body in frame.'] },
    { id: 'heading', label: 'Heading (age 11+ only)', kbSkill: sk('heading'), checks: [], mode: 'checklist', view: 'side',
      checklistWhy: 'forehead contact and open eyes are too small to judge from pose landmarks',
      filming: ['Side view, close enough to see the head clearly. Light balls, low volume (follow your federation\'s heading guidance).'] },
  ],
  eventLabel: (t) => ({ kick: 'kicks', landing: 'landings' })[t] || t,
  globals: baseGlobals({
    kick_min_speed: { value: 6, label: 'Kick: kicking foot faster than', unit: 'torso/s' },
  }),
  detectEvents(ctx) {
    const notes = [];
    if (ctx.isPhoto) return { events: [], notes: ['This skill needs a video (a kick or a landing is a movement). Use the coach checklist with photos.'] };
    if (ctx.skill.id === 'instep') {
      const ev = detectKicks(ctx);
      if (!ev.length) notes.push('No kick found: keep the whole body and the kicking foot in frame, and check the kicking-foot setting.');
      if (ctx.fps < 60) notes.push(`${Math.round(ctx.fps)} fps: contact is estimated as the fastest-foot frame. Slow-mo makes the contact frame exact.`);
      return { events: ev, notes };
    }
    const ev = detectLandings(ctx);
    if (!ev.length) notes.push('No jump landing found (both feet must leave the ground). Use the checklist for planted cuts.');
    return { events: ev, notes };
  },
  keyframes(ctx, ev) {
    const k = [];
    for (const e of ev.events) {
      if (e.type === 'kick') k.push({ i: e.backswing, label: 'Backswing' }, { i: e.plant, label: 'Plant' }, { i: e.peak, label: 'Contact' }, { i: e.end, label: 'Follow-through' });
      else k.push({ i: e.takeoff, label: 'Take-off' }, { i: e.land, label: 'Touchdown' }, { i: e.deep, label: 'Deepest' });
    }
    return k.length ? k.sort((a, b) => a.i - b.i) : null;
  },
  checks: [
    ...kickChecks,
    ...landingChecks({ group: 'landing', skill: sk('cut-land'), cpValgus: 'so-cut-land-c01', cpFlex: 'so-cut-land-c02', fault: 'so-cut-land-f01', fault2: 'so-cut-land-f02', minFlexDefault: 45, valgusDefault: 12 }),
  ],
};
export default soccer;
