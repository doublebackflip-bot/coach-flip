// Brazilian jiu-jitsu. Honest scope: the pose tracker follows ONE person and was trained mostly
// on upright people, so partner positions on the mat are unreliable. Automatic (BETA) checks only
// where one athlete is clearly visible: closed-guard posture (top player, photo friendly) and the
// solo hip-escape (shrimp) drill. Everything else is a coach checklist with KB cues and drills.
import {
  D, r1, hi, lo, at, maxOver, minOver, leanDeg, fillGaps, smooth1, peaks, baseGlobals, mk, HIPS, SHOULDERS, TRUNK,
} from '../../engine/kit.js';

const T = (ctx) => ctx.unit.torso2;
const sk = (id) => 'bj-' + id;

/** shrimps: the hips slide along the mat (2D x) by a good distance within ~1.2 s */
function detectShrimps(ctx) {
  const { poses, sec, G } = ctx;
  const N = poses.length;
  const hx = smooth1(fillGaps(poses.map((p) => (p && p.vis(...HIPS) >= 0.3 ? p.p2('mid_hip')[0] / T(ctx) : NaN)), 3), 1);
  const out = [];
  const W = sec(1.2);
  let i = 0;
  while (i < N - 1) {
    let best = null;
    for (let j = i + 1; j <= Math.min(N - 1, i + W); j++) {
      if (!Number.isFinite(hx[i]) || !Number.isFinite(hx[j])) continue;
      const d = Math.abs(hx[j] - hx[i]);
      if (d >= G.shrimp_min_move && (!best || d > best.d)) best = { j, d };
    }
    if (best) { out.push({ type: 'shrimp', start: i, peak: best.j, end: Math.min(N - 1, best.j + sec(0.3)), dir: Math.sign(hx[best.j] - hx[i]) }); i = best.j + sec(0.4); }
    else i++;
  }
  return out;
}

const posture = [
  mk({
    id: 'cg_trunk', group: 'posture', scope: 'frames:all', priority: 1, views: ['side'],
    kb: { skill: sk('closed-guard-posture'), checkpoint: 'bj-closed-guard-posture-c01', fault: 'bj-closed-guard-posture-f01' },
    label: 'Posture broken (leaning forward)', okLabel: 'Spine upright in the guard',
    needs: TRUNK,
    params: { max_lean: { value: 30, unit: 'deg', label: 'Trunk within this of vertical', note: 'KB: trunk within ~30 deg of vertical' } },
    thresholdText: (P) => `trunk within ${P.max_lean} deg of vertical`,
    badness: (v, P) => hi(v, P, 'max_lean'),
    measure(p, ctx, P) {
      const v = Math.abs(leanDeg(p, 'mid_hip', 'mid_shoulder', 1));
      return { value: v, pass: v <= P.max_lean, text: `trunk ${Math.round(v)}° from vertical`, draw: [D.line(p, 'mid_hip', 'mid_shoulder', `${Math.round(v)}°`), D.vert(p, 'mid_hip', ctx, 'vertical', -1.2)] };
    },
  }),
  mk({
    id: 'cg_head', group: 'posture', scope: 'frames:all', priority: 1,
    kb: { skill: sk('closed-guard-posture'), checkpoint: 'bj-closed-guard-posture-c01', fault: 'bj-closed-guard-posture-f01' },
    label: 'Head pulled down (below the shoulders)', okLabel: 'Head up above the hips',
    needs: ['nose', ...SHOULDERS, ...HIPS],
    params: { min_above: { value: 0.0, unit: 'x torso', label: 'Nose above the shoulder line by at least' } },
    thresholdText: (P) => `nose at least ${P.min_above}x torso above the shoulders`,
    badness: (v, P) => lo(v, P, 'min_above'),
    measure(p, ctx, P) {
      const v = (p.p2('mid_shoulder')[1] - p.p2('nose')[1]) / T(ctx);
      return { value: v, pass: v >= P.min_above, text: v >= P.min_above ? 'head up' : `head ${r1(-v)}x torso below shoulders`, draw: [D.level(p, 'mid_shoulder', ctx, 'shoulders', 4), D.dot(p, 'nose', 'head')] };
    },
  }),
];

const shrimp = [
  mk({
    id: 'sh_hips_move', group: 'shrimp', scope: 'event:shrimp', priority: 1, views: ['side'],
    kb: { skill: sk('guard-retention'), checkpoint: 'bj-guard-retention-c02', fault: 'bj-guard-retention-f02' },
    label: 'Hips not escaping (shoulders move with them)', okLabel: 'Hips drive away while the shoulders stay',
    needs: [...HIPS, ...SHOULDERS],
    params: { min_lead: { value: 0.3, unit: 'x torso', label: 'Hips move further than the shoulders by at least', note: 'KB: hips move > ~1 hip width while the shoulders stay roughly in place' } },
    thresholdText: (P) => `hips travel ${P.min_lead}x torso more than the shoulders`,
    badness: (v, P) => lo(v, P, 'min_lead'),
    evaluate(e, ctx, P) {
      const a = at(ctx, e.start, this.needs), b = at(ctx, e.peak, this.needs); if (!a || !b) return null;
      const dh = Math.abs(b.p2('mid_hip')[0] - a.p2('mid_hip')[0]), ds = Math.abs(b.p2('mid_shoulder')[0] - a.p2('mid_shoulder')[0]);
      const v = (dh - ds) / T(ctx);
      return { value: v, pass: v >= P.min_lead, frame: e.peak, text: `hips ${r1(dh / T(ctx))}, shoulders ${r1(ds / T(ctx))} torso`, draw: [D.line(b, 'mid_shoulder', 'mid_hip', 'trunk'), D.dot(b, 'mid_hip', 'hips')] };
    },
  }),
  mk({
    id: 'sh_on_side', group: 'shrimp', scope: 'event:shrimp', priority: 2,
    kb: { skill: sk('guard-retention'), checkpoint: 'bj-guard-retention-c01', fault: 'bj-guard-retention-f01' },
    label: 'Flat on the back while escaping', okLabel: 'Turned on the side to escape',
    needs: SHOULDERS,
    params: { min_tilt: { value: 40, unit: 'deg', label: 'Shoulder line tilted from the mat at least', note: 'KB: > ~45 deg (on your side); 3D estimate' } },
    thresholdText: (P) => `shoulder line ${P.min_tilt} deg or more from flat during the escape`,
    badness: (v, P) => lo(v, P, 'min_tilt'),
    evaluate(e, ctx, P) {
      const b = maxOver(ctx, e.start, e.peak, this.needs, (p) => {
        const L = p.p3('left_shoulder'), R = p.p3('right_shoulder');
        return (Math.atan2(Math.abs(L[1] - R[1]), Math.hypot(L[0] - R[0], L[2] - R[2])) * 180) / Math.PI;
      }); if (!b) return null;
      return { value: b.v, pass: b.v >= P.min_tilt, frame: b.i, text: `shoulders ${Math.round(b.v)}° off the mat`, draw: [D.line(b.p, 'left_shoulder', 'right_shoulder', `${Math.round(b.v)}°`)] };
    },
  }),
];

const bjj = {
  id: 'bjj', name: 'Jiu-jitsu',
  roles: () => ({}),
  stances: null,
  views: [
    { id: 'side', label: 'Side', hint: 'Camera low at mat level, perpendicular to the athlete' },
    { id: 'front', label: 'Front', hint: 'Facing the athlete' },
  ],
  filmingTips: [
    'Camera low (mat level to waist height), 3-4 m away, whole body in frame.',
    'Automatic checks follow ONE person: solo drills or photos of the top player work best. Partner drills -> coach checklist.',
    'Slow drilling reps are easier to judge than live rolling.',
  ],
  skills: [
    { id: 'cg_posture', label: 'Closed guard posture (top)', kbSkill: sk('closed-guard-posture'), checks: ['posture'], all: true, view: 'side', beta: true,
      filming: ['Side view of the top player, camera low. A photo works.', 'If the tracker locks onto the bottom player, film a solo "posture up" drill or use the checklist.'] },
    { id: 'shrimp', label: 'Hip escape (solo shrimp drill)', kbSkill: sk('guard-retention'), checks: ['shrimp'], all: true, view: 'side', beta: true,
      filming: ['Side view, camera at mat level, solo shrimping across the mat (3-5 reps each side).', 'Keep the whole body in frame; avoid baggy kit if possible.'] },
    { id: 'guard_retention', label: 'Guard retention (with partner)', kbSkill: sk('guard-retention'), checks: [], mode: 'checklist', view: 'side',
      checklistWhy: 'two bodies overlap; frames and knee/shin re-insertion need both athletes tracked',
      filming: ['Side view, low camera, both athletes in frame.'] },
    { id: 'mount_escape', label: 'Mount escape (trap & roll)', kbSkill: sk('mount-escape'), checks: [], mode: 'checklist', view: 'side',
      checklistWhy: 'the bottom player is mostly hidden under the mount',
      filming: ['Side view from the trapped-arm side, low camera.'] },
    { id: 'armbar', label: 'Armbar from guard', kbSkill: sk('armbar-guard'), checks: [], mode: 'checklist', view: 'side',
      checklistWhy: 'hip angle relative to the partner and arm control need both athletes tracked',
      filming: ['Side view, low camera, both athletes in frame. Slow drilling reps.'] },
    { id: 'triangle', label: 'Triangle choke', kbSkill: sk('triangle'), checks: [], mode: 'checklist', view: 'side',
      checklistWhy: 'leg position behind the neck and the angle need both athletes tracked',
      filming: ['Side view or top view if you can get the camera high.'] },
    { id: 'standup', label: 'Technical stand-up', kbSkill: sk('tech-standup'), checks: [], mode: 'checklist', view: 'side',
      checklistWhy: 'seated and posting positions are tracked poorly',
      filming: ['Side view, whole body, 3-5 reps each side.'] },
  ],
  frameLabels: { all: 'frames' },
  noFramesReason: () => 'No athlete found',
  eventLabel: (t) => ({ shrimp: 'hip escapes' })[t] || t,
  globals: baseGlobals({
    shrimp_min_move: { value: 0.6, label: 'Hip escape: hips slide along the mat at least', unit: 'x torso' },
  }),
  detectEvents(ctx) {
    const all = ctx.poses.map((p, i) => (p ? i : -1)).filter((i) => i >= 0);
    const notes = ['The tracker follows one person; with a partner in frame it may jump between you. Check the skeleton on the video.'];
    if (ctx.skill.id === 'shrimp') {
      if (ctx.isPhoto) return { events: [], frameSets: { all }, notes: ['Hip escapes need a video.'] };
      const ev = detectShrimps(ctx);
      if (!ev.length) notes.push('No hip escape found: shrimp across the frame (side view) so the hips travel along the mat.');
      return { events: ev, frameSets: { all }, notes };
    }
    return { events: [], frameSets: { all }, notes };
  },
  keyframes(ctx, ev) {
    const k = [];
    for (const e of ev.events) k.push({ i: e.start, label: 'Start' }, { i: e.peak, label: 'Hips out' });
    return k.length ? k : null;
  },
  checks: [...posture, ...shrimp],
};
export default bjj;
