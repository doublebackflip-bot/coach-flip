// Boxing rules: turns KB checkpoints (data/boxing.json) into measurable checks.
// Every check links back to a KB checkpoint (what good looks like) and, where one
// exists, a KB fault (cue, why it matters, drills). Thresholds are configurable;
// basis 'estimated' => shown as BETA in the UI.
import { angle, dist, yaw, angDiff, perpOffset2, round } from '../../engine/geom.js';

const r1 = (x) => round(x, 1);
const fists = (p, a, b, ctx) => dist(p.p2(a), p.p2(b)) / ctx.unit.fist2;
const below = (p, a, ref, ctx) => (p.p2(a)[1] - p.p2(ref)[1]) / ctx.unit.fist2; // + = a is lower than ref
const elbow3 = (p, s) => angle(p.p3(s + '_shoulder'), p.p3(s + '_elbow'), p.p3(s + '_wrist'));
const elbow2 = (p, s) => angle(p.p2(s + '_shoulder'), p.p2(s + '_elbow'), p.p2(s + '_wrist'));
// MediaPipe's single-camera 3D compresses elbow angles (a straight arm reads ~145 deg, a tight
// guard ~110 deg); 2D is exact for motion across the image but blind to motion toward the
// camera. For "did the arm straighten?" we take the larger of the two.
const elbowExt = (p, s) => Math.max(elbow2(p, s), elbow3(p, s));
/** Elbow straightness with the more trustworthy source: 2D when the arm lies across the
 * image (little foreshortening), else 3D (punch toward the camera) with its own threshold. */
const straightness = (p, s, ctx, P) => {
  const len2 = dist(p.p2(s + '_shoulder'), p.p2(s + '_elbow')) + dist(p.p2(s + '_elbow'), p.p2(s + '_wrist'));
  const spread = len2 / (ctx.unit.torso2 * ctx.G.arm_torso_ratio);
  return spread >= ctx.G.min_arm_spread_2d
    ? { v: elbowExt(p, s), src: '2D', ok: (v) => v >= P.min_angle }
    : { v: elbow3(p, s), src: '3D', ok: (v) => v >= P.min_angle_3d };
};
const extRatio = (p, s, k) => {
  const sh = p[k](s + '_shoulder'), el = p[k](s + '_elbow'), wr = p[k](s + '_wrist');
  return dist(sh, wr) / (dist(sh, el) + dist(el, wr));
};
// arm extension (1 = straight): blend of 2D and 3D so punches toward the camera still register
const ext3 = (p, s) => (extRatio(p, s, 'p2') + extRatio(p, s, 'p3')) / 2;
const hipYaw = (p) => yaw(p.p3('left_hip'), p.p3('right_hip'));
const shoulderYaw = (p) => yaw(p.p3('left_shoulder'), p.p3('right_shoulder'));
const noseAbove = (p, ctx) => (p.p2('mid_shoulder')[1] - p.p2('nose')[1]) / ctx.unit.fist2;
const heelLift = (p, ctx) => (p.p2('rear_foot_index')[1] - p.p2('rear_heel')[1]) / ctx.unit.fist2;
const outward = (p, s, ctx) => {
  const sh = p.p2(s + '_shoulder'), el = p.p2(s + '_elbow'), mid = p.p2('mid_shoulder');
  return ((el[0] - sh[0]) * Math.sign(sh[0] - mid[0] || 1)) / ctx.unit.fist2;
};
/** fraction of the way from rear ankle to lead ankle where the hip centre sits (0 = over rear foot) */
const hipAlongStance = (p, ctx) => {
  if (ctx.view === 'side') {
    const ra = p.p2('rear_ankle'), la = p.p2('lead_ankle'), h = p.p2('mid_hip');
    return (h[0] - ra[0]) / (la[0] - ra[0]);
  }
  const ra = p.p3('rear_ankle'), la = p.p3('lead_ankle'), h = p.p3('mid_hip');
  const f = [la[0] - ra[0], la[2] - ra[2]], L2 = f[0] ** 2 + f[1] ** 2;
  return ((h[0] - ra[0]) * f[0] + (h[2] - ra[2]) * f[1]) / L2;
};
/** how far (fists) the nose is past the lead knee in the punching direction */
const nosePastKnee = (p, ctx) => {
  if (ctx.view === 'side') {
    const dir = Math.sign(p.p2('lead_ankle')[0] - p.p2('rear_ankle')[0]) || 1;
    return ((p.p2('nose')[0] - p.p2('lead_knee')[0]) * dir) / ctx.unit.fist2;
  }
  const ra = p.p3('rear_ankle'), la = p.p3('lead_ankle'), n = p.p3('nose'), k = p.p3('lead_knee');
  const f = [la[0] - ra[0], la[2] - ra[2]], L = Math.hypot(...f) || 1;
  return ((n[0] - k[0]) * f[0] + (n[2] - k[2]) * f[1]) / L / ctx.unit.fist3;
};

// drawing primitives (normalised image coords; renderer scales to the canvas)
const D = {
  line: (p, a, b, text) => ({ k: 'line', a: p.n(a), b: p.n(b), text }),
  zone: (p, c, rf, ctx, text) => ({ k: 'circle', c: p.n(c), r: (rf * ctx.unit.fist2) / ctx.meta.width, text }),
  ang: (p, a, b, c, text) => ({ k: 'angle', a: p.n(a), b: p.n(b), c: p.n(c), text }),
  level: (p, a, ctx, text) => ({ k: 'hline', x: p.n(a)[0], y: p.n(a)[1], w: (3 * ctx.unit.fist2) / ctx.meta.width, text }),
  dot: (p, a, text) => ({ k: 'dot', c: p.n(a), text }),
};

// generic "max of a per-frame value over an event window"
function maxOver(ctx, a, b, needs, fn, skip) {
  let best = null;
  for (let i = Math.max(0, a); i <= Math.min(ctx.poses.length - 1, b); i++) {
    if (skip && skip(i)) continue;
    const p = ctx.poses[i];
    if (!p || p.vis(...needs) < ctx.G.min_visibility) continue;
    const v = fn(p, i);
    if (Number.isFinite(v) && (!best || v > best.v)) best = { v, i, p };
  }
  return best;
}
/** true while that hand is itself throwing a punch (so "hand left the chin" is expected) */
// (also true whenever that arm is straight out at punch height: a punch the event detector merged or missed
// is still a punch, not a "dropped" guard hand - this is what drew the guard line along a punching arm)
const throwing = (ctx, side) => (i) => ctx.events.some((ev) => ev.side === side && i >= ev.start && i <= ev.end) || !!ctx.boxing?.extendedAt(side, i);
const at = (ctx, i, needs) => { const p = ctx.poses[i]; return p && p.vis(...needs) >= ctx.G.min_visibility ? p : null; };

const ARM = (s) => [s + '_shoulder', s + '_elbow', s + '_wrist'];
const FIST = (s) => [s + '_wrist', s + '_index', s + '_pinky'];
const FACE = ['nose', 'mouth_left', 'mouth_right'];
const LEGS = ['left_hip', 'right_hip', 'left_knee', 'right_knee', 'left_ankle', 'right_ankle'];
const HIPS = ['left_hip', 'right_hip'];

const hi = (v, P, k) => v - P[k];   // badness when bigger is worse
const lo = (v, P, k) => P[k] - v;   // badness when smaller is worse

// Rear hand at the chin - shared by guard/jab/hook
function rearHandCheck(id, group, scope, kb, priority, label) {
  return {
    id, group, scope, kb, priority, basis: 'source', label, okLabel: 'Rear hand stayed at the chin',
    needs: [...FIST('rear'), ...FACE, 'chin'],
    params: { max_fists: { value: 1.5, unit: 'fists', label: 'Max rear fist-to-chin distance', note: 'KB: ~1 fist; +0.5 margin for tracking noise' } },
    thresholdText: (P) => `rear fist within ${P.max_fists} fists of chin`,
    badness: (v, P) => hi(v, P, 'max_fists'),
    measure(p, ctx, P) {
      const v = fists(p, 'rear_fist', 'chin', ctx);
      return { value: v, pass: v <= P.max_fists, text: `${r1(v)} fists off chin`,
        draw: [D.zone(p, 'chin', P.max_fists, ctx), D.line(p, 'rear_fist', 'chin', `${r1(v)} fists`)] };
    },
    evaluate(e, ctx, P) {
      const b = maxOver(ctx, e.start, e.end, this.needs, (p) => fists(p, 'rear_fist', 'chin', ctx), throwing(ctx, 'rear'));
      if (!b) return null;
      return { ...this.measure(b.p, ctx, P), frame: b.i };
    },
  };
}

function extensionEval(chk, s, e, ctx, P) {
  // most-extended frame of the punch; judged with the 2D or 3D angle, whichever is trustworthy there
  let best = null;
  for (let i = Math.max(e.start, e.peak - 1); i <= Math.min(e.end, e.peak + 1); i++) {
    const p = at(ctx, i, chk.needs); if (!p) continue;
    const x = straightness(p, s, ctx, P);
    const margin = x.v - (x.src === '2D' ? P.min_angle : P.min_angle_3d);
    if (Number.isFinite(margin) && (!best || margin > best.margin)) best = { ...x, margin, i, p };
  }
  if (!best) return null;
  // value reported on the 2D scale so badness/sorting is comparable
  return { value: P.min_angle + best.margin, pass: best.margin >= 0, frame: best.i, text: `elbow ${Math.round(best.v)}° (${best.src})`,
    draw: [D.ang(best.p, s + '_shoulder', s + '_elbow', s + '_wrist', `${Math.round(best.v)}°`)] };
}

export const boxing = {
  id: 'boxing', name: 'Boxing', kbFile: 'data/boxing.json',
  roles: (stance) => (stance === 'southpaw' ? { lead: 'right', rear: 'left' } : { lead: 'left', rear: 'right' }),
  /** stance implied by the body's forward side (see kit.inferLeadSide) */
  stanceFromLead: (side) => (side === 'left' ? 'orthodox' : side === 'right' ? 'southpaw' : null),
  /** a punch (out and back) takes at least this long in real time; shorter = the slow-mo setting is wrong */
  minRealEventSeconds: 0.12,
  occlusionAware: true,
  stances: [
    { id: 'orthodox', label: 'Orthodox', hint: 'left foot & left hand forward' },
    { id: 'southpaw', label: 'Southpaw', hint: 'right foot & right hand forward' },
  ],
  views: [
    { id: 'front', label: 'Front', hint: 'Phone faces the boxer, like the opponent sees them' },
    { id: 'side', label: 'Side', hint: 'Phone at the boxer\'s open side, 90° to the punches' },
  ],
  filmingTips: [
    'Whole body in frame, head to feet (stance checks need the feet).',
    'Phone steady at chest height, 3-4 m (10-12 ft) away. Lean it on a bag or bench.',
    'One boxer in frame. Good light; avoid filming into the sun.',
    '5-10 seconds: 3-6 reps of the skill, back to guard between reps.',
  ],
  skills: [
    { id: 'guard', label: 'Guard & stance', kbSkill: 'bx-stance-guard', checks: ['guard', 'stance'], view: 'front' },
    { id: 'jab', label: 'Jab', kbSkill: 'bx-jab', checks: ['jab', 'guard'], view: 'front' },
    { id: 'cross', label: 'Cross', kbSkill: 'bx-cross', checks: ['cross', 'guard'], view: 'front' },
    { id: 'hook', label: 'Lead hook', kbSkill: 'bx-hook', checks: ['hook', 'guard'], view: 'front', beta: true },
    { id: 'shadow', label: 'Shadowboxing (all)', kbSkill: null, kbSkills: ['bx-stance-guard', 'bx-jab', 'bx-cross', 'bx-hook'], all: true, checks: ['guard', 'stance', 'jab', 'cross', 'hook'], view: 'front' },
  ],
  eventLabel: (t) => ({ lead_straight: 'jabs', rear_straight: 'crosses', lead_hook: 'hooks' })[t] || t,

  // Global tuning (all editable in Settings)
  globals: {
    fist_torso_ratio: { value: 0.2, label: '1 fist = this x torso length', unit: 'x', note: 'Adult fist ~10 cm, torso ~50 cm' },
    min_visibility: { value: 0.5, label: 'Min landmark visibility', unit: '0-1' },
    smoothing_frames: { value: 3, label: 'Smoothing window', unit: 'frames' },
    punch_ext_min: { value: 0.8, label: 'Punch detected when arm extension (2D/3D blend) reaches', unit: 'ratio' },
    punch_max_below_shoulder: { value: 2.5, label: 'Punch: wrist no lower than this below the shoulder', unit: 'fists' },
    punch_prominence: { value: 0.2, label: 'Min extension change for a punch', unit: 'ratio' },
    arm_torso_ratio: { value: 1.1, label: 'Arm length (shoulder-elbow-wrist) vs torso', unit: 'x' },
    min_arm_spread_2d: { value: 0.7, label: 'Use 2D elbow angle when the arm shows at least this share of its length', unit: '0-1' },
    hook_max_elbow: { value: 135, label: 'Hook: elbow angle below', unit: 'deg' },
    hook_elbow_raise_max: { value: 0.75, label: 'Hook: elbow within this far below shoulder', unit: 'fists' },
    hook_prominence: { value: 0.8, label: 'Hook: min elbow lift', unit: 'fists' },
    guard_fail_fraction: { value: 0.3, label: 'Guard fault if failing this share of guard time', unit: '0-1' },
    min_fault_duration_s: { value: 0.2, label: 'Guard fault needs at least this much failing time', unit: 's' },
    episode_gap_s: { value: 0.25, label: 'Merge fault moments closer than', unit: 's' },
    event_fail_fraction: { value: 0.25, label: 'Punch fault if failing this share of punches', unit: '0-1' },
    event_flag_halfwidth: { value: 2, label: 'Frames highlighted around a punch fault', unit: 'frames' },
    judge_min_conf: { value: 0.6, label: 'Judge a moment only if the body parts it needs are tracked at least this confidently', unit: '0-1' },
    view_front_max_deg: { value: 42, label: 'Front view: punches within this angle of the camera line', unit: 'deg' },
    view_side_min_deg: { value: 62, label: 'Side view: punches at least this angle from the camera line', unit: 'deg' },
  },

  detectEvents(ctx) {
    const { poses, G, sec } = ctx;
    const N = poses.length, events = [], notes = [];
    const series = (needs, fn, minVis = 0.3) => poses.map((p) => (p && p.vis(...needs) >= minVis ? fn(p) : NaN));
    const ext = { lead: series(ARM('lead'), (p) => ext3(p, 'lead')), rear: series(ARM('rear'), (p) => ext3(p, 'rear')) };
    // a straight arm hanging at the waist is not a punch (head and body shots are thrown at chest height or above)
    const atPunchHeight = (i, s) => poses[i] && below(poses[i], s + '_wrist', s + '_shoulder', ctx) < G.punch_max_below_shoulder;
    ctx.boxing = { ext, extendedAt: (s, i) => ext[s][i] >= G.punch_ext_min - 0.05 && atPunchHeight(i, s) };

    if (ctx.isPhoto) {
      for (const s of ['lead', 'rear']) {
        if (ext[s][0] >= G.punch_ext_min && atPunchHeight(0, s)) events.push({ type: s + '_straight', side: s, start: 0, peak: 0, end: 0, returned: true, peakExt: r1(ext[s][0]) });
      }
      return { events, guardFrames: events.length ? [] : [0], notes: events.length ? ['Photo shows a punch: guard checks skipped, punch checks run on this frame.'] : [] };
    }

    const W = sec(0.5), K = sec(0.12), R = sec(0.8);
    for (const s of ['lead', 'rear']) {
      const x = ext[s];
      for (let i = 0; i < N; i++) {
        const v = x[i];
        if (!(v >= G.punch_ext_min) || !atPunchHeight(i, s)) continue;
        let isMax = true;
        for (let j = Math.max(0, i - K); j <= Math.min(N - 1, i + K); j++) if (x[j] > v || (x[j] === v && j < i)) { isMax = false; break; }
        if (!isMax) continue;
        let s0 = -1;
        for (let j = Math.max(0, i - W); j < i; j++) if (Number.isFinite(x[j]) && (s0 < 0 || x[j] < x[s0])) s0 = j;
        if (s0 < 0 || v - x[s0] < G.punch_prominence) continue;
        const base = x[s0], amp = v - base;
        let start = s0;
        for (let j = i; j >= s0; j--) if (x[j] <= base + 0.15 * amp) { start = j; break; }
        let end = -1;
        for (let j = i + 1; j <= Math.min(N - 1, i + R); j++) if (x[j] <= base + 0.35 * amp) { end = j; break; }
        const returned = end >= 0;
        if (!returned) end = Math.min(N - 1, i + R);
        const last = events.filter((e) => e.side === s).at(-1);
        if (last && start <= last.end) continue; // same punch / overlapping
        events.push({ type: s + '_straight', side: s, start, peak: i, end, returned, peakExt: round(v, 3) });
      }
    }
    // both arms "peaking" within ~0.12 s is one punch seen twice (the other arm moves as the body
    // turns); keep the more extended one
    for (let a = 0; a < events.length; a++) for (let b = 0; b < events.length; b++) {
      const A = events[a], B = events[b];
      if (A && B && A !== B && A.side !== B.side && Math.abs(A.peak - B.peak) <= sec(0.12) && A.peakExt <= B.peakExt && !(A.peakExt === B.peakExt && a > b)) events[a] = null;
    }
    for (let k = events.length - 1; k >= 0; k--) if (!events[k]) events.splice(k, 1);
    // lead hooks: elbow lifts to ~shoulder height with the elbow bent (not an extended straight)
    const lift = series(['lead_elbow', 'lead_shoulder'], (p) => below(p, 'lead_elbow', 'lead_shoulder', ctx));
    const elb = series(ARM('lead'), (p) => elbow3(p, 'lead'));
    for (let i = 0; i < N; i++) {
      const v = lift[i];
      if (!(v <= G.hook_elbow_raise_max) || !(elb[i] <= G.hook_max_elbow)) continue;
      let isMin = true;
      for (let j = Math.max(0, i - K); j <= Math.min(N - 1, i + K); j++) if (lift[j] < v || (lift[j] === v && j < i)) { isMin = false; break; }
      if (!isMin) continue;
      let s0 = -1;
      for (let j = Math.max(0, i - W); j < i; j++) if (Number.isFinite(lift[j]) && (s0 < 0 || lift[j] > lift[s0])) s0 = j;
      if (s0 < 0 || lift[s0] - v < G.hook_prominence) continue;
      // not the retraction of a jab (elbow still up while the arm folds back) and not a straight arm
      if (events.some((e) => e.side === 'lead' && i >= e.start - sec(0.1) && i <= e.end + sec(0.3))) continue;
      if (ext.lead[i] >= G.punch_ext_min - 0.05) continue;
      // a hook is bent, and the bend shows in the picture (2D) too, not just in the 3D estimate
      if (!(elbow2(poses[i], 'lead') <= G.hook_max_elbow + 15)) continue;
      const amp = lift[s0] - v;
      let end = -1;
      for (let j = i + 1; j <= Math.min(N - 1, i + R); j++) if (lift[j] >= lift[s0] - 0.35 * amp) { end = j; break; }
      const last = events.filter((e) => e.type === 'lead_hook').at(-1);
      if (last && s0 <= last.end) continue;
      events.push({ type: 'lead_hook', side: 'lead', start: s0, peak: i, end: end < 0 ? Math.min(N - 1, i + R) : end, returned: end >= 0, peakElbow: r1(elb[i]) });
    }
    events.sort((a, b) => a.peak - b.peak);

    const pad = sec(0.1);
    const busy = new Uint8Array(N);
    for (const e of events) for (let j = Math.max(0, e.start - pad); j <= Math.min(N - 1, e.end + pad); j++) busy[j] = 1;
    const guardFrames = [];
    for (let i = 0; i < N; i++) {
      if (!poses[i] || busy[i]) continue;
      // an arm straight out at head/shoulder height = punching, not guarding (a hand hanging
      // at the waist is also "straight" but that IS a guard fault we want to see)
      const punching = (s) => ext[s][i] >= G.punch_ext_min - 0.05 && atPunchHeight(i, s);
      if (punching('lead') || punching('rear')) continue;
      guardFrames.push(i);
    }
    // Camera angle from the punches: a straight punch thrown toward the camera barely shows in the picture
    // (front view); thrown across it, it shows at full arm length (side view). angle = asin(shown / arm length).
    // jabs go straight down the target line; crosses travel across the body to the centre line and read wider
    const angOf = (list) => list.map((e) => {
      const p = poses[e.peak]; if (!p || p.vis(...ARM(e.side)) < 0.5) return NaN;
      const shown = dist(p.p2(e.side + '_shoulder'), p.p2(e.side + '_wrist'));
      const full = G.arm_torso_ratio * ctx.unit.torso2 * 0.95;
      return (Math.asin(Math.min(1, shown / full)) * 180) / Math.PI;
    }).filter(Number.isFinite).sort((a, b) => a - b);
    let view = null;
    if (ctx.unit.torso2 > 0) {
      let angs = angOf(events.filter((e) => e.type === 'lead_straight')), q = 0.5;
      if (angs.length < 3) { angs = angOf(events.filter((e) => e.type.endsWith('_straight'))); q = 0.35; } // crosses read wider
      if (angs.length >= 3) { // 3+ punches before trusting a camera-angle read
        const a = Math.round(angs[Math.floor((angs.length - 1) * q)]);
        view = { angle: a, n: angs.length, class: a <= G.view_front_max_deg ? 'front' : a >= G.view_side_min_deg ? 'side' : 'angled' };
      }
    }
    const n = (t) => events.filter((e) => e.type === t).length;
    const sk = ctx.skill.id;
    if (sk === 'jab' && !n('lead_straight') && n('rear_straight') >= 2)
      notes.push('Only rear-hand punches were found. Is the stance setting right (orthodox vs southpaw)?');
    if (sk === 'cross' && !n('rear_straight') && n('lead_straight') >= 2)
      notes.push('Only lead-hand punches were found. Is the stance setting right (orthodox vs southpaw)?');
    return { events, guardFrames, notes, view };
  },

  checks: [
    // ---------------- GUARD (between punches) ----------------
    rearHandCheck('guard_rear_hand', 'guard', 'guard', { skill: 'bx-stance-guard', checkpoint: 'bx-stance-guard-c03', fault: 'bx-stance-guard-f04' }, 1, 'Rear hand off the chin'),
    {
      id: 'guard_lead_hand', group: 'guard', scope: 'guard', priority: 2, basis: 'source',
      kb: { skill: 'bx-stance-guard', checkpoint: 'bx-stance-guard-c03', fault: 'bx-stance-guard-f04' },
      label: 'Lead hand low', okLabel: 'Lead hand at shoulder-to-eye height',
      needs: [...FIST('lead'), 'lead_shoulder'],
      params: { max_below: { value: 0.5, unit: 'fists', label: 'Lead fist may sit this far below the shoulder line', note: 'KB: shoulder-to-eye height' } },
      thresholdText: (P) => `lead fist no more than ${P.max_below} fist below shoulder height`,
      badness: (v, P) => hi(v, P, 'max_below'),
      measure(p, ctx, P) {
        const v = below(p, 'lead_fist', 'lead_shoulder', ctx);
        return { value: v, pass: v <= P.max_below, text: v > 0 ? `${r1(v)} fists below shoulder` : 'at/above shoulder',
          draw: [D.level(p, 'lead_shoulder', ctx, 'shoulder height'), D.dot(p, 'lead_fist', `${r1(v)} below`)] };
      },
    },
    {
      id: 'guard_elbow_flare', angleSensitive: true, group: 'guard', scope: 'guard', priority: 3, basis: 'estimated', views: ['front'],
      kb: { skill: 'bx-stance-guard', checkpoint: 'bx-stance-guard-c03', fault: 'bx-stance-guard-f04' },
      label: 'Elbows flared out', okLabel: 'Elbows tucked in',
      needs: [...ARM('lead'), ...ARM('rear')],
      params: { max_out: { value: 1.0, unit: 'fists', label: 'Elbow may stick out past the shoulder by', note: 'KB: elbows within ~1 fist of the torso (torso edge is inside the shoulder)' } },
      thresholdText: (P) => `elbows no more than ${P.max_out} fist outside the shoulders`,
      badness: (v, P) => hi(v, P, 'max_out'),
      measure(p, ctx, P) {
        const o = { lead: outward(p, 'lead', ctx), rear: outward(p, 'rear', ctx) };
        const s = o.lead >= o.rear ? 'lead' : 'rear', v = o[s];
        return { value: v, pass: v <= P.max_out, text: `${s} elbow ${r1(v)} fists out`,
          draw: [D.line(p, s + '_shoulder', s + '_elbow', `${r1(v)} fists out`), D.dot(p, s + '_elbow')] };
      },
    },
    {
      id: 'guard_elbow_high', group: 'guard', scope: 'guard', priority: 4, basis: 'source',
      kb: { skill: 'bx-stance-guard', checkpoint: 'bx-stance-guard-c03', fault: 'bx-stance-guard-f04' },
      label: 'Elbow higher than the fist', okLabel: 'Elbows below the fists',
      needs: [...FIST('lead'), ...FIST('rear'), 'lead_elbow', 'rear_elbow'],
      params: { max_above: { value: 0.25, unit: 'fists', label: 'Elbow may rise above its fist by', note: 'KB: elbows below wrist height' } },
      thresholdText: (P) => `elbow not more than ${P.max_above} fist above its fist`,
      badness: (v, P) => hi(v, P, 'max_above'),
      measure(p, ctx, P) {
        const a = { lead: -below(p, 'lead_elbow', 'lead_fist', ctx), rear: -below(p, 'rear_elbow', 'rear_fist', ctx) };
        const s = a.lead >= a.rear ? 'lead' : 'rear', v = a[s];
        return { value: v, pass: v <= P.max_above, text: `${s} elbow above fist`,
          draw: [D.line(p, s + '_elbow', s + '_fist', 'elbow up'), D.level(p, s + '_fist', ctx)] };
      },
    },
    {
      id: 'guard_chin', group: 'guard', scope: 'guard', priority: 2, basis: 'estimated',
      kb: { skill: 'bx-stance-guard', checkpoint: 'bx-stance-guard-c04', fault: 'bx-stance-guard-f03' },
      label: 'Chin up / standing tall', okLabel: 'Chin tucked',
      needs: ['nose', 'left_shoulder', 'right_shoulder'],
      params: { max_nose_above: { value: 1.8, unit: 'fists', label: 'Nose may sit above the shoulder line by', note: 'Estimated; calibrate on your boxers' } },
      thresholdText: (P) => `nose no more than ${P.max_nose_above} fists above the shoulder line`,
      badness: (v, P) => hi(v, P, 'max_nose_above'),
      measure(p, ctx, P) {
        const v = noseAbove(p, ctx);
        return { value: v, pass: v <= P.max_nose_above, text: `nose ${r1(v)} fists above shoulders`,
          draw: [D.level(p, 'mid_shoulder', ctx, 'shoulder line'), D.line(p, 'mid_shoulder', 'nose', `${r1(v)} fists`)] };
      },
    },
    // ---------------- STANCE ----------------
    {
      id: 'stance_width', angleSensitive: true, group: 'stance', scope: 'guard', priority: 3, basis: 'estimated',
      kb: { skill: 'bx-stance-guard', checkpoint: 'bx-stance-guard-c01', fault: 'bx-stance-guard-f01' },
      label: 'Feet too narrow (in line) or too wide', okLabel: 'Stance width OK',
      needs: ['left_ankle', 'right_ankle', 'left_shoulder', 'right_shoulder', 'left_hip', 'right_hip'],
      visReason: 'Feet not visible - film head to toe',
      params: {
        min_torso: { value: 0.3, unit: 'x torso', label: 'Feet at least this far apart on screen', note: 'KB: ~1.0-1.2x shoulder width; a bladed stance hides part of it from any one camera, so only extremes are flagged' },
        max_torso: { value: 1.5, unit: 'x torso', label: 'Feet at most this far apart on screen' },
      },
      thresholdText: (P) => `feet ${P.min_torso}-${P.max_torso}x torso length apart on screen`,
      badness: (v, P) => Math.max(P.min_torso - v, v - P.max_torso),
      measure(p, ctx, P) {
        const v = dist(p.p2('left_ankle'), p.p2('right_ankle')) / ctx.unit.torso2;
        const what = v < P.min_torso ? 'too narrow' : v > P.max_torso ? 'too wide' : 'ok';
        return { value: v, pass: what === 'ok', text: `feet ${what}`,
          draw: [D.line(p, 'left_ankle', 'right_ankle', `feet ${what}`)] };
      },
    },
    {
      id: 'stance_knees', group: 'stance', scope: 'guard', priority: 5, basis: 'source',
      kb: { skill: 'bx-stance-guard', checkpoint: 'bx-stance-guard-c02', fault: 'bx-stance-guard-f02' },
      label: 'Legs too straight (stiff)', okLabel: 'Knees slightly bent',
      needs: LEGS, visReason: 'Legs not visible - film head to toe',
      params: { max_knee: { value: 172, unit: 'deg', label: 'Average knee angle above this = legs locked', note: 'KB: ~150-170 deg' } },
      thresholdText: (P) => `average knee angle under ${P.max_knee} deg`,
      badness: (v, P) => hi(v, P, 'max_knee'),
      measure(p, ctx, P) {
        const L = angle(p.p3('lead_hip'), p.p3('lead_knee'), p.p3('lead_ankle')), R = angle(p.p3('rear_hip'), p.p3('rear_knee'), p.p3('rear_ankle'));
        const v = (L + R) / 2;
        return { value: v, pass: v <= P.max_knee, text: `knees ${Math.round(v)} deg`,
          draw: [D.ang(p, 'lead_hip', 'lead_knee', 'lead_ankle', `${Math.round(L)}°`), D.ang(p, 'rear_hip', 'rear_knee', 'rear_ankle', `${Math.round(R)}°`)] };
      },
    },
    {
      id: 'stance_rear_heel', group: 'stance', scope: 'guard', priority: 6, basis: 'estimated', views: ['side'],
      kb: { skill: 'bx-stance-guard', checkpoint: 'bx-stance-guard-c02', fault: 'bx-stance-guard-f02' },
      label: 'Rear heel flat', okLabel: 'Rear heel up',
      needs: ['rear_heel', 'rear_foot_index'], visReason: 'Rear foot not visible',
      params: { min_lift: { value: 0.15, unit: 'fists', label: 'Rear heel must sit above the toes by', note: 'KB: ~5 cm; foot points are noisy' } },
      thresholdText: (P) => `rear heel at least ${P.min_lift} fist above the toes`,
      badness: (v, P) => lo(v, P, 'min_lift'),
      measure(p, ctx, P) {
        const v = heelLift(p, ctx);
        return { value: v, pass: v >= P.min_lift, text: v < P.min_lift ? 'rear heel flat' : 'heel up',
          draw: [D.line(p, 'rear_heel', 'rear_foot_index', 'heel flat'), D.dot(p, 'rear_heel')] };
      },
    },
    // ---------------- JAB ----------------
    rearHandCheck('jab_rear_hand', 'jab', 'event:lead_straight', { skill: 'bx-jab', checkpoint: 'bx-jab-c03', fault: 'bx-jab-f03' }, 1, 'Rear hand drops during the jab'),
    {
      id: 'jab_chin_lift', group: 'jab', scope: 'event:lead_straight', priority: 2, basis: 'estimated', temporal: true,
      kb: { skill: 'bx-jab', checkpoint: 'bx-jab-c03', fault: 'bx-jab-f03' },
      label: 'Chin lifts on the jab', okLabel: 'Chin stayed down',
      needs: ['nose', 'left_shoulder', 'right_shoulder'],
      params: { max_rise: { value: 0.5, unit: 'fists', label: 'Head may rise above its start height by' } },
      thresholdText: (P) => `head rises less than ${P.max_rise} fist during the jab`,
      badness: (v, P) => hi(v, P, 'max_rise'),
      evaluate(e, ctx, P) {
        const p0 = at(ctx, e.start, this.needs); if (!p0) return null;
        const b0 = noseAbove(p0, ctx);
        const b = maxOver(ctx, e.start, e.end, this.needs, (p) => noseAbove(p, ctx) - b0); if (!b) return null;
        return { value: b.v, pass: b.v <= P.max_rise, frame: b.i, text: `chin up ${r1(b.v)} fists`,
          draw: [D.level(b.p, 'mid_shoulder', ctx, 'shoulders'), D.line(b.p, 'mid_shoulder', 'nose', 'chin up')] };
      },
    },
    {
      id: 'jab_extension', group: 'jab', scope: 'event:lead_straight', priority: 4, basis: 'estimated',
      kb: { skill: 'bx-jab', checkpoint: 'bx-jab-c02', fault: 'bx-jab-f02' },
      label: 'Jab not fully extended (pawing)', okLabel: 'Jab reached full extension',
      needs: ARM('lead'),
      params: {
        min_angle: { value: 155, unit: 'deg', label: 'Lead elbow angle at full extension at least (arm across the picture, 2D)', note: 'KB: ~165-180 deg; lowered for frame rate & tracking error' },
        min_angle_3d: { value: 140, unit: 'deg', label: 'Same, when punching toward the camera (3D estimate)', note: "MediaPipe's 3D reads a straight arm at ~145-150 deg" },
      },
      thresholdText: (P) => `lead elbow opens to ${P.min_angle} deg (2D) / ${P.min_angle_3d} deg (toward camera, 3D) or more`,
      badness: (v, P) => lo(v, P, 'min_angle'),
      evaluate(e, ctx, P) { return extensionEval(this, 'lead', e, ctx, P); },
    },
    {
      id: 'jab_elbow_flare', angleSensitive: true, group: 'jab', scope: 'event:lead_straight', priority: 3, basis: 'estimated',
      kb: { skill: 'bx-jab', checkpoint: 'bx-jab-c01', fault: null, drills: ['BX-D-JAB-MITT'] },
      coach: {
        cue: "'Elbow down - straight out from the guard.'",
        why: 'USA Boxing teaches the jab straight from the guard with the elbow pointing down; a flaring elbow pulls the fist off the straight line.',
      },
      label: 'Lead elbow flares on the jab', okLabel: 'Elbow stayed down on the jab',
      needs: ARM('lead'),
      params: { max_flare: { value: 1.0, unit: 'fists', label: 'Elbow may flare by', note: 'front: outside the shoulder; side: above the shoulder-wrist line' } },
      thresholdText: (P) => `elbow flare under ${P.max_flare} fist`,
      badness: (v, P) => hi(v, P, 'max_flare'),
      evaluate(e, ctx, P) {
        const p = at(ctx, e.peak, this.needs); if (!p) return null;
        const v = ctx.view === 'side'
          ? perpOffset2(p.p2('lead_elbow'), p.p2('lead_shoulder'), p.p2('lead_wrist')) / ctx.unit.fist2
          : outward(p, 'lead', ctx);
        return { value: v, pass: v <= P.max_flare, frame: e.peak, text: `elbow out ${r1(v)} fists`,
          draw: [D.line(p, 'lead_shoulder', 'lead_wrist', 'straight line'), D.dot(p, 'lead_elbow', 'elbow out')] };
      },
    },
    {
      id: 'jab_windup', group: 'jab', scope: 'event:lead_straight', priority: 3, basis: 'estimated', temporal: true,
      kb: { skill: 'bx-jab', checkpoint: 'bx-jab-c01', fault: 'bx-jab-f01' },
      label: 'Wind-up before the jab', okLabel: 'No wind-up',
      needs: [...FIST('lead'), 'lead_shoulder'],
      params: { max_windup: { value: 0.75, unit: 'fists', label: 'Fist may drop before launch by' } },
      thresholdText: (P) => `lead fist drops less than ${P.max_windup} fist before launch`,
      badness: (v, P) => hi(v, P, 'max_windup'),
      evaluate(e, ctx, P) {
        const a = Math.max(0, e.start - ctx.sec(0.3));
        const p0 = at(ctx, a, this.needs); if (!p0) return null;
        const b0 = below(p0, 'lead_fist', 'lead_shoulder', ctx);
        const b = maxOver(ctx, a, e.start, this.needs, (p) => below(p, 'lead_fist', 'lead_shoulder', ctx) - b0); if (!b) return null;
        return { value: b.v, pass: b.v <= P.max_windup, frame: b.i, text: `fist dropped ${r1(b.v)} fists first`,
          draw: [D.level(b.p, 'lead_shoulder', ctx, 'shoulder'), D.dot(b.p, 'lead_fist', 'drop')] };
      },
    },
    {
      id: 'jab_retract', group: 'jab', scope: 'event:lead_straight', priority: 4, basis: 'estimated', temporal: true,
      kb: { skill: 'bx-jab', checkpoint: 'bx-jab-c04', fault: 'bx-jab-f04' },
      label: 'Slow return to guard', okLabel: 'Jab snapped back',
      needs: ARM('lead'),
      params: { max_ratio: { value: 2.0, unit: 'x', label: 'Return time may be this x the punch-out time', note: 'KB: return <= out time; margin for frame rate' } },
      thresholdText: (P) => `return time under ${P.max_ratio}x the punch-out time`,
      badness: (v, P) => hi(v, P, 'max_ratio'),
      evaluate(e, ctx, P) {
        const t = (i) => ctx.frames[i].t;
        const out = Math.max(t(e.peak) - t(e.start), 1 / ctx.fps);
        const v = e.returned ? (t(e.end) - t(e.peak)) / out : 9;
        const p = at(ctx, e.end, this.needs) || at(ctx, e.peak, this.needs); if (!p) return null;
        return { value: v, pass: v <= P.max_ratio, frame: e.end, text: e.returned ? `back ${r1(v)}x slower than out` : 'hand lingered out',
          draw: [D.dot(p, 'lead_fist', e.returned ? 'slow back' : 'still out')] };
      },
    },
    {
      id: 'jab_return_low', group: 'jab', scope: 'event:lead_straight', priority: 3, basis: 'estimated', temporal: true,
      kb: { skill: 'bx-jab', checkpoint: 'bx-jab-c04', fault: 'bx-jab-f04' },
      label: 'Jab comes back low', okLabel: 'Jab came back high',
      needs: [...FIST('lead'), 'lead_shoulder'],
      params: { max_below: { value: 1.0, unit: 'fists', label: 'Fist may dip below the shoulder on the way back by' } },
      thresholdText: (P) => `lead fist stays within ${P.max_below} fist of shoulder height on the way back`,
      badness: (v, P) => hi(v, P, 'max_below'),
      evaluate(e, ctx, P) {
        const b = maxOver(ctx, e.peak, e.end, this.needs, (p) => below(p, 'lead_fist', 'lead_shoulder', ctx)); if (!b) return null;
        return { value: b.v, pass: b.v <= P.max_below, frame: b.i, text: `${r1(b.v)} fists below shoulder`,
          draw: [D.level(b.p, 'lead_shoulder', ctx, 'shoulder'), D.dot(b.p, 'lead_fist', 'low')] };
      },
    },
    // ---------------- CROSS ----------------
    {
      id: 'cross_lead_hand', group: 'cross', scope: 'event:rear_straight', priority: 1, basis: 'estimated',
      kb: { skill: 'bx-cross', checkpoint: 'bx-cross-c04', fault: 'bx-cross-f03' },
      label: 'Lead hand drops on the cross', okLabel: 'Lead hand stayed up',
      needs: [...FIST('lead'), ...FACE, 'chin'],
      params: { max_fists: { value: 2.0, unit: 'fists', label: 'Max lead fist-to-chin distance during the cross', note: 'KB: lead hand stays at face height' } },
      thresholdText: (P) => `lead fist within ${P.max_fists} fists of the chin`,
      badness: (v, P) => hi(v, P, 'max_fists'),
      evaluate(e, ctx, P) {
        const b = maxOver(ctx, e.start, e.end, this.needs, (p) => fists(p, 'lead_fist', 'chin', ctx), throwing(ctx, 'lead')); if (!b) return null;
        return { value: b.v, pass: b.v <= P.max_fists, frame: b.i, text: `lead hand ${r1(b.v)} fists off`,
          draw: [D.zone(b.p, 'chin', P.max_fists, ctx), D.line(b.p, 'lead_fist', 'chin', `${r1(b.v)} fists`)] };
      },
    },
    {
      id: 'cross_extension', group: 'cross', scope: 'event:rear_straight', priority: 5, basis: 'estimated',
      kb: { skill: 'bx-cross', checkpoint: 'bx-cross-c04', fault: null, drills: ['BX-D-PIVOT-CROSS'] },
      coach: { cue: "'All the way out - turn the fist over at the end.'", why: 'The manuals finish the cross with the arm fully extended and the palm down; stopping short gives up reach.' },
      label: 'Cross not fully extended', okLabel: 'Cross reached full extension',
      needs: ARM('rear'),
      params: {
        min_angle: { value: 155, unit: 'deg', label: 'Rear elbow angle at full extension at least (2D)', note: 'KB: ~165-180 deg' },
        min_angle_3d: { value: 140, unit: 'deg', label: 'Same, when punching toward the camera (3D estimate)' },
      },
      thresholdText: (P) => `rear elbow opens to ${P.min_angle} deg (2D) / ${P.min_angle_3d} deg (toward camera, 3D) or more`,
      badness: (v, P) => lo(v, P, 'min_angle'),
      evaluate(e, ctx, P) { return extensionEval(this, 'rear', e, ctx, P); },
    },
    {
      id: 'cross_hip_rotation', group: 'cross', scope: 'event:rear_straight', priority: 2, basis: 'estimated', temporal: true,
      kb: { skill: 'bx-cross', checkpoint: 'bx-cross-c01', fault: 'bx-cross-f01' },
      label: 'Arm punching (hips not turning)', okLabel: 'Hips turned into the cross',
      needs: HIPS,
      params: { min_deg: { value: 20, unit: 'deg', label: 'Hips must rotate at least', note: 'KB: pelvis ~45+ deg (estimate); 3D from one camera is rough' } },
      thresholdText: (P) => `hips rotate ${P.min_deg} deg or more`,
      badness: (v, P) => lo(v, P, 'min_deg'),
      evaluate(e, ctx, P) {
        const p0 = at(ctx, e.start, this.needs); if (!p0) return null;
        const y0 = hipYaw(p0);
        const b = maxOver(ctx, e.start, e.end, this.needs, (p) => Math.abs(angDiff(y0, hipYaw(p)))); if (!b) return null;
        const sh = Math.abs(angDiff(shoulderYaw(p0), shoulderYaw(b.p)));
        return { value: b.v, pass: b.v >= P.min_deg, frame: e.peak, text: `hips ${Math.round(b.v)}°, shoulders ${Math.round(sh)}°`,
          draw: [D.line(ctx.poses[e.peak] || b.p, 'left_hip', 'right_hip', `hips ${Math.round(b.v)}°`), D.line(ctx.poses[e.peak] || b.p, 'left_shoulder', 'right_shoulder')] };
      },
    },
    {
      id: 'cross_rear_heel', group: 'cross', scope: 'event:rear_straight', priority: 4, basis: 'estimated', temporal: true, views: ['side'],
      kb: { skill: 'bx-cross', checkpoint: 'bx-cross-c01', fault: 'bx-cross-f01' },
      label: 'Rear heel not turning', okLabel: 'Rear heel turned/lifted',
      needs: ['rear_heel', 'rear_foot_index'], visReason: 'Rear foot not visible',
      params: { min_lift: { value: 0.2, unit: 'fists', label: 'Rear heel must rise by', note: 'KB: rear heel turns out/up before impact' } },
      thresholdText: (P) => `rear heel rises ${P.min_lift} fist or more`,
      badness: (v, P) => lo(v, P, 'min_lift'),
      evaluate(e, ctx, P) {
        const p0 = at(ctx, e.start, this.needs); if (!p0) return null;
        const h0 = heelLift(p0, ctx);
        const b = maxOver(ctx, e.start, e.end, this.needs, (p) => heelLift(p, ctx) - h0); if (!b) return null;
        return { value: b.v, pass: b.v >= P.min_lift, frame: e.peak, text: 'rear heel stayed down',
          draw: [D.line(ctx.poses[e.peak] || b.p, 'rear_heel', 'rear_foot_index', 'heel down')] };
      },
    },
    {
      id: 'cross_lean', angleSensitive: true, group: 'cross', scope: 'event:rear_straight', priority: 2, basis: 'estimated',
      kb: { skill: 'bx-cross', checkpoint: 'bx-cross-c03', fault: 'bx-cross-f02' },
      label: 'Leaning / over-committing', okLabel: 'Head stayed over the lead knee',
      needs: ['nose', 'lead_knee', 'lead_ankle', 'rear_ankle'], visReason: 'Legs not visible - film head to toe',
      params: { max_past: { value: 1.0, unit: 'fists', label: 'Nose may go past the lead knee by', note: 'KB: nose stays over the lead knee' } },
      thresholdText: (P) => `nose no more than ${P.max_past} fist past the lead knee`,
      badness: (v, P) => hi(v, P, 'max_past'),
      evaluate(e, ctx, P) {
        const b = maxOver(ctx, e.start, e.end, this.needs, (p) => nosePastKnee(p, ctx)); if (!b) return null;
        return { value: b.v, pass: b.v <= P.max_past, frame: b.i, text: `head ${r1(b.v)} fists past knee`,
          draw: [D.line(b.p, 'nose', 'lead_knee', 'head past knee')] };
      },
    },
    {
      id: 'cross_weight_shift', angleSensitive: true, group: 'cross', scope: 'event:rear_straight', priority: 3, basis: 'estimated', temporal: true,
      kb: { skill: 'bx-cross', checkpoint: 'bx-cross-c03', fault: null, drills: ['BX-D-PIVOT-CROSS'], tipSources: ['BX9'] },
      coach: { cue: "'Push off the back foot - shift onto the lead leg as the hand goes.'", why: 'Straight punches thrown with a weight shift hit harder (BX9), and the rear leg is a key source of cross power (BX7).' },
      label: 'No weight shift into the cross', okLabel: 'Weight shifted forward',
      needs: ['left_hip', 'right_hip', 'lead_ankle', 'rear_ankle'], visReason: 'Feet not visible - film head to toe',
      params: { min_shift: { value: 0.05, unit: 'of stance', label: 'Hips must move toward the lead foot by', note: 'share of the stance length; estimate' } },
      thresholdText: (P) => `hips move forward ${Math.round(P.min_shift * 100)}% of stance length or more`,
      badness: (v, P) => lo(v, P, 'min_shift'),
      evaluate(e, ctx, P) {
        const p0 = at(ctx, e.start, this.needs); if (!p0) return null;
        const f0 = hipAlongStance(p0, ctx);
        const b = maxOver(ctx, e.start, e.end, this.needs, (p) => hipAlongStance(p, ctx) - f0); if (!b) return null;
        return { value: b.v, pass: b.v >= P.min_shift, frame: e.peak, text: `hips moved ${Math.round(b.v * 100)}%`,
          draw: [D.line(ctx.poses[e.peak] || b.p, 'rear_ankle', 'lead_ankle', 'stance'), D.dot(ctx.poses[e.peak] || b.p, 'mid_hip', 'weight back')] };
      },
    },
    // ---------------- LEAD HOOK ----------------
    {
      id: 'hook_elbow', group: 'hook', scope: 'event:lead_hook', priority: 2, basis: 'estimated',
      kb: { skill: 'bx-hook', checkpoint: 'bx-hook-c01', fault: 'bx-hook-f01' },
      label: 'Looping / wide hook', okLabel: 'Hook elbow near 90°',
      needs: ARM('lead'),
      params: {
        min_angle: { value: 65, unit: 'deg', label: 'Hook elbow angle at least', note: 'KB: ~80-100 deg (source); widened because 3D elbow angles are compressed' },
        max_angle: { value: 120, unit: 'deg', label: 'Hook elbow angle at most', note: 'KB: ~80-100 deg (source); widened for tracking error' },
      },
      thresholdText: (P) => `lead elbow ${P.min_angle}-${P.max_angle} deg at the hook`,
      badness: (v, P) => Math.max(P.min_angle - v, v - P.max_angle),
      evaluate(e, ctx, P) {
        const p = at(ctx, e.peak, this.needs); if (!p) return null;
        const v = elbow3(p, 'lead');
        return { value: v, pass: v >= P.min_angle && v <= P.max_angle, frame: e.peak, text: `elbow ${Math.round(v)}°`,
          draw: [D.ang(p, 'lead_shoulder', 'lead_elbow', 'lead_wrist', `${Math.round(v)}°`)] };
      },
    },
    rearHandCheck('hook_rear_hand', 'hook', 'event:lead_hook', { skill: 'bx-hook', checkpoint: 'bx-hook-c03', fault: 'bx-hook-f03' }, 1, 'Rear hand drops during the hook'),
    {
      id: 'hook_rotation', group: 'hook', scope: 'event:lead_hook', priority: 3, basis: 'estimated', temporal: true,
      kb: { skill: 'bx-hook', checkpoint: 'bx-hook-c02', fault: 'bx-hook-f02' },
      label: 'Arm-only hook (no body turn)', okLabel: 'Body turned with the hook',
      needs: HIPS,
      params: { min_deg: { value: 15, unit: 'deg', label: 'Hips must rotate at least' } },
      thresholdText: (P) => `hips rotate ${P.min_deg} deg or more`,
      badness: (v, P) => lo(v, P, 'min_deg'),
      evaluate(e, ctx, P) {
        const p0 = at(ctx, e.start, this.needs); if (!p0) return null;
        const y0 = hipYaw(p0);
        const b = maxOver(ctx, e.start, e.end, this.needs, (p) => Math.abs(angDiff(y0, hipYaw(p)))); if (!b) return null;
        return { value: b.v, pass: b.v >= P.min_deg, frame: e.peak, text: `hips ${Math.round(b.v)}°`,
          draw: [D.line(ctx.poses[e.peak] || b.p, 'left_hip', 'right_hip', `hips ${Math.round(b.v)}°`)] };
      },
    },
  ],
};
export default boxing;
