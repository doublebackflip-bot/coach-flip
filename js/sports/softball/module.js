// Softball (fastpitch) rules: batting first, then windmill pitching, fielding and throwing.
// Checks link to KB checkpoints/faults in data/softball.json. No bat or ball tracking:
// "contact" is estimated as the moment the hands move fastest (it is within a frame or two
// of contact at 30 fps; film slow-mo for better timing).
import { dist, round, median } from '../../engine/geom.js';
import {
  D, r1, hi, lo, band, at, maxOver, minOver, series, fillGaps, smooth1, peaks, speed, ang3, elbowMax, knee, joint,
  trunkLean, ahead, width2, turnFromWidth, mid2, dotAt, segAt, medianSign, baseGlobals, facing, ARM, LEGS, HIPS, SHOULDERS, mk, yawSeries,
} from '../../engine/kit.js';

const T = (ctx) => ctx.unit.torso2;
const hands = (p) => mid2(p, 'lead_wrist', 'rear_wrist');
const HANDS = ['lead_wrist', 'rear_wrist'];
const sk = (id) => 'sb-' + id;

// ---------------------------------------------------------------- batting events
const yawAt = (y, i) => y[Math.max(0, Math.min(y.length - 1, i))];

function detectSwings(ctx) {
  const { poses, sec, G } = ctx;
  const N = poses.length;
  // a swing = fast rotation of the shoulder line (3D), whatever the camera angle
  const yS = yawSeries(ctx, 'rear_shoulder', 'lead_shoulder');
  const yH = yawSeries(ctx, 'rear_hip', 'lead_hip');
  ctx.yawS = yS; ctx.yawH = yH;
  const w = yS.map((v, i) => (Number.isFinite(yS[i + 1]) && Number.isFinite(yS[i - 1]) ? (Math.abs(yS[i + 1] - yS[i - 1]) / 2) * ctx.fps : NaN));
  // which way is the pitcher in the picture (open-side view): the lead hip is on the pitcher's side
  ctx.dirP = medianSign(ctx, HIPS, (p) => p.p2('lead_hip')[0] - p.p2('rear_hip')[0]);
  const pk = peaks(smooth1(w, 1), { min: G.swing_min_turn_speed, prom: G.swing_min_turn_speed * 0.4, win: sec(0.2), back: sec(0.5), gap: sec(1.0) });
  const swings = [];
  for (const i of pk) {
    const dir = Math.sign(yawAt(yS, i + 1) - yawAt(yS, i - 1)) || 1;
    // rotation start: going back, the last frame before the shoulders began turning (yaw stops changing in `dir`)
    let s0 = i;
    for (let j = i - 1; j >= Math.max(1, i - sec(0.6)); j--) { if (!Number.isFinite(yS[j])) break; if ((yS[j + 1] - yS[j]) * dir < (G.swing_min_turn_speed * 0.15) / ctx.fps) { s0 = j; break; } s0 = j; }
    // rotation end: going forward, first frame the shoulders stop turning
    let s1 = i;
    for (let j = i + 1; j <= Math.min(N - 2, i + sec(0.8)); j++) { if (!Number.isFinite(yS[j + 1])) break; s1 = j; if ((yS[j + 1] - yS[j]) * dir < (G.swing_min_turn_speed * 0.15) / ctx.fps) break; }
    const total = (yawAt(yS, s1) - yawAt(yS, s0)) * dir;
    if (!(total >= G.swing_min_turn)) continue;
    // contact ~ the shoulders are part-way round (no bat/ball tracking)
    let peak = s1;
    for (let j = s0; j <= s1; j++) if ((yS[j] - yS[s0]) * dir >= G.contact_turn_fraction * total) { peak = j; break; }
    // load = hands furthest back (from the lead shoulder, 3D) before the turn starts
    let load = s0, best = -Infinity;
    for (let j = Math.max(0, s0 - sec(0.8)); j <= s0; j++) {
      const p = poses[j]; if (!p || p.vis(...HANDS, 'lead_shoulder') < 0.3) continue;
      const h = p.p3('lead_wrist').map((x, k) => (x + p.p3('rear_wrist')[k]) / 2), d = dist(h, p.p3('lead_shoulder'));
      if (d > best + 1e-3) { best = d; load = j; }
    }
    const start = Math.max(0, load - sec(0.6));
    // toe-touch: the lead foot stops moving toward the pitcher (side view) / lead ankle settles (other views)
    let toeTouch = null, stride = NaN;
    if (ctx.view === 'side') {
      const ax = (j) => poses[j] && poses[j].vis('lead_ankle') >= 0.3 ? poses[j].p2('lead_ankle')[0] * ctx.dirP : NaN;
      const a0 = Math.max(0, load - sec(0.4));
      const xs = []; for (let j = a0; j <= peak; j++) xs.push(ax(j));
      if (xs.filter(Number.isFinite).length >= 3) {
        const mn = Math.min(...xs.filter(Number.isFinite)), last = ax(peak);
        stride = (last - mn) / T(ctx);
        if (stride >= 0.12) for (let j = a0; j <= peak; j++) if (ax(j) - mn >= 0.85 * (last - mn)) { toeTouch = j; break; }
      }
    } else {
      const fc = footContactBefore(ctx, s0 + 1, Math.max(1, s0 + 1 - load));
      if (fc > load && fc <= s0 + 1) toeTouch = fc;
    }
    if (toeTouch !== null) toeTouch = Math.max(load, Math.min(toeTouch, peak - 1));
    const noStride = toeTouch === null;
    if (noStride) toeTouch = Math.max(load, Math.min(s0, peak - 1));
    swings.push({ type: 'swing', side: 'lead', start, load, toeTouch, rotStart: s0, peak, end: Math.min(N - 1, Math.max(s1, peak + sec(0.5))), dir, turn: Math.round(total), stride: r1(stride), noStride });
  }
  return swings;
}

// ---------------------------------------------------------------- pitching / throwing / fielding events
function detectPitches(ctx) {
  const { poses, sec, G } = ctx;
  const wy = fillGaps(series(ctx, ARM('throw'), (p) => p.p2('throw_wrist')[1]), 2);
  const sp = smooth1(speed(ctx, 'throw_wrist', ARM('throw')), 1);
  ctx.dirT = medianSign(ctx, ['lead_ankle', 'rear_ankle'], (p) => p.p2('lead_ankle')[0] - p.p2('rear_ankle')[0]);
  const out = [];
  // release: fast throwing hand, down at hip height, shortly after the hand was above the head
  const pk = peaks(sp, { min: G.pitch_min_speed, prom: G.pitch_min_speed * 0.4, win: sec(0.15), back: sec(0.5), gap: sec(1.0) });
  for (const i of pk) {
    const p = poses[i]; if (!p) continue;
    let top = -1;
    for (let j = Math.max(0, i - sec(0.6)); j < i; j++) if (Number.isFinite(wy[j]) && (top < 0 || wy[j] < wy[top])) top = j;
    if (top < 0 || !(poses[top] && wy[top] < poses[top].p2('nose')[1])) continue; // hand never went over the head: not a windmill
    // release ~ when the hand passes the hip (lowest point of the circle) around the speed peak
    let rel = i;
    for (let j = Math.max(top, i - sec(0.1)); j <= Math.min(poses.length - 1, i + sec(0.1)); j++) if (wy[j] > wy[rel]) rel = j;
    const fc = footContactBefore(ctx, rel, sec(0.5));
    out.push({ type: 'pitch', side: 'throw', start: Math.max(0, top - sec(0.4)), top, peak: rel, fc, end: Math.min(poses.length - 1, rel + sec(0.4)) });
  }
  return out;
}
/** stride-foot contact: start of the last "still" stretch of the lead ankle before frame `i` */
function footContactBefore(ctx, i, back) {
  const { poses } = ctx;
  const lo = Math.max(1, i - back);
  // still = the ankle moves less than ~4% of a torso per 1/30 s
  const thr = 0.04 * ctx.unit.torso2 * (30 / ctx.fps);
  const v = (j) => { const p = poses[j], q = poses[j - 1]; if (!p || !q || p.vis('lead_ankle') < 0.3 || q.vis('lead_ankle') < 0.3) return NaN; return dist(p.p2('lead_ankle'), q.p2('lead_ankle')); };
  let last = -1;
  for (let j = i; j >= lo; j--) if (v(j) <= thr) { last = j; break; }
  if (last < 0) {
    // never still (blurred / noisy): fall back to the slowest frame
    let best = null, minV = Infinity;
    for (let j = lo; j <= i; j++) { const x = v(j); if (Number.isFinite(x) && x < minV) { minV = x; best = j; } }
    return best ?? Math.max(0, i - Math.round(back / 3));
  }
  let j = last;
  while (j - 1 >= lo && v(j - 1) <= thr) j--;
  // the foot was moving just before this stretch: contact = first still frame
  return Math.min(j, i);
}
function detectThrows(ctx) {
  const { poses, sec, G } = ctx;
  const sp = smooth1(speed(ctx, 'throw_wrist', ARM('throw')), 1);
  ctx.dirT = medianSign(ctx, ['lead_ankle', 'rear_ankle'], (p) => p.p2('lead_ankle')[0] - p.p2('rear_ankle')[0]);
  const out = [];
  for (const i of peaks(sp, { min: G.throw_min_speed, prom: G.throw_min_speed * 0.4, win: sec(0.15), back: sec(0.5), gap: sec(1.0) })) {
    const p = poses[i]; if (!p || p.vis(...ARM('throw')) < 0.3) continue;
    if (p.p2('throw_wrist')[1] > p.p2('throw_hip')[1]) continue; // overhand: hand above the hip at release
    const fc = footContactBefore(ctx, i, sec(0.5));
    out.push({ type: 'throw', side: 'throw', start: Math.max(0, fc - sec(0.3)), fc, peak: i, end: Math.min(poses.length - 1, i + sec(0.6)) });
  }
  return out;
}
function detectFielding(ctx) {
  const { poses, sec, G } = ctx;
  // fielding moment: glove hand at its lowest, well below the knees
  const gy = fillGaps(series(ctx, ['glove_wrist', 'mid_hip'], (p) => (p.p2('glove_wrist')[1] - p.p2('mid_hip')[1]) / ctx.unit.torso2), 2);
  const out = [];
  for (const i of peaks(gy, { min: G.field_min_reach, prom: 0.4, win: sec(0.3), back: sec(1.0), gap: sec(1.0) })) {
    out.push({ type: 'field', side: 'glove', start: Math.max(0, i - sec(0.5)), peak: i, end: Math.min(poses.length - 1, i + sec(1.0)) });
  }
  return out;
}

// ---------------------------------------------------------------- checks
const BAT_VIEW = ['side'];
const batChecks = [
  // stance (frame-based: works on a photo of the stance too)
  mk({
    id: 'bat_stance_width', group: 'stance', scope: 'frames:stance', priority: 6, views: BAT_VIEW,
    kb: { skill: sk('bat-stance-load'), checkpoint: 'sb-bat-stance-load-c01', fault: null, drills: ['SB-D-WALL-LOAD'] },
    coach: { cue: "'Feet a little wider than your shoulders - athletic, not tall.'", why: 'A balanced, shoulder-width-plus base lets the hitter load and rotate without swaying (USA Softball / Earleywine stance absolutes).' },
    label: 'Stance too narrow or too wide', okLabel: 'Stance width OK',
    needs: ['lead_ankle', 'rear_ankle', ...HIPS, ...SHOULDERS], visReason: 'Feet not visible - film head to toe',
    params: { min_torso: { value: 0.6, unit: 'x torso', label: 'Feet at least this far apart', note: 'KB: 1.0-1.5x shoulder width (~0.8-1.2 torso lengths)' }, max_torso: { value: 1.7, unit: 'x torso', label: 'Feet at most this far apart' } },
    thresholdText: (P) => `feet ${P.min_torso}-${P.max_torso}x torso length apart`,
    badness: (v, P) => band(v, P, 'min_torso', 'max_torso'),
    measure(p, ctx, P) {
      const v = dist(p.p2('lead_ankle'), p.p2('rear_ankle')) / T(ctx);
      const what = v < P.min_torso ? 'too narrow' : v > P.max_torso ? 'too wide' : 'ok';
      return { value: v, pass: what === 'ok', text: `feet ${what} (${r1(v)}x torso)`, draw: [D.line(p, 'lead_ankle', 'rear_ankle', `feet ${what}`)] };
    },
  }),
  mk({
    id: 'bat_knees', group: 'stance', scope: 'frames:stance', priority: 5,
    kb: { skill: sk('bat-stance-load'), checkpoint: 'sb-bat-stance-load-c01', fault: 'sb-bat-stance-load-f03' },
    label: 'Rigid, upright stance (knees locked)', okLabel: 'Knees flexed in the stance',
    needs: LEGS, visReason: 'Legs not visible - film head to toe',
    params: { max_knee: { value: 170, unit: 'deg', label: 'Average knee angle above this = locked', note: 'KB: knee angle ~150-165 deg' } },
    thresholdText: (P) => `average knee angle under ${P.max_knee} deg`,
    badness: (v, P) => hi(v, P, 'max_knee'),
    measure(p, ctx, P) {
      const L = ang3(p, 'lead_hip', 'lead_knee', 'lead_ankle'), R = ang3(p, 'rear_hip', 'rear_knee', 'rear_ankle'), v = (L + R) / 2;
      return { value: v, pass: v <= P.max_knee, text: `knees ${Math.round(v)}°`, draw: [D.ang(p, 'lead_hip', 'lead_knee', 'lead_ankle', `${Math.round(L)}°`), D.ang(p, 'rear_hip', 'rear_knee', 'rear_ankle', `${Math.round(R)}°`)] };
    },
  }),
  mk({
    id: 'bat_hands_set', group: 'stance', scope: 'frames:stance', priority: 6,
    kb: { skill: sk('bat-stance-load'), checkpoint: 'sb-bat-stance-load-c02', fault: null, drills: ['SB-D-TWO-TEE'] },
    coach: { cue: "'Hands at the back shoulder - knob down, ready to go.'", why: 'Hands set near the rear shoulder keep the swing short to the ball; hands that sit low or far away have to travel further (USA Softball hitting fundamentals).' },
    label: 'Hands not set at the back shoulder', okLabel: 'Hands set near the back shoulder',
    needs: [...ARM('rear'), 'lead_wrist'],
    params: { max_forearms: { value: 2.0, unit: 'forearms', label: 'Hands within this many forearm lengths of the rear shoulder', note: 'KB: within ~1 forearm; 3D depth from one camera is noisy, hence the margin' }, max_low: { value: 0.5, unit: 'x torso', label: 'Hands may sit below the rear shoulder by' } },
    thresholdText: (P) => `hands within ${P.max_forearms} forearm lengths of the rear shoulder and not more than ${P.max_low}x torso below it`,
    badness: (v, P) => hi(v, P, 'max_forearms'),
    measure(p, ctx, P) {
      const h3 = p.p3('lead_wrist').map((x, i) => (x + p.p3('rear_wrist')[i]) / 2);
      const fore = dist(p.p3('rear_elbow'), p.p3('rear_wrist'));
      const v = dist(h3, p.p3('rear_shoulder')) / (fore || 1e-9);
      const low = (hands(p)[1] - p.p2('rear_shoulder')[1]) / T(ctx);
      const pass = v <= P.max_forearms && low <= P.max_low;
      const text = low > P.max_low ? `hands low (${r1(low)}x torso under the shoulder)` : `hands ${r1(v)} forearms from shoulder`;
      return { value: low > P.max_low ? Math.max(v, P.max_forearms + (low - P.max_low)) : v, pass, text, draw: [segAt(p, hands(p), p.p2('rear_shoulder'), text), dotAt(p, hands(p))] };
    },
  }),
  // load
  mk({
    id: 'bat_sway', group: 'load', scope: 'event:swing', priority: 2, temporal: true, views: BAT_VIEW,
    kb: { skill: sk('bat-stance-load'), checkpoint: 'sb-bat-stance-load-c03', fault: 'sb-bat-stance-load-f01' },
    label: 'Swaying back on the load', okLabel: 'Head stayed centred on the load',
    needs: ['nose', ...HIPS],
    params: { max_back: { value: 0.35, unit: 'x torso', label: 'Head may drift toward the catcher by', note: 'KB: < ~1 head width' } },
    thresholdText: (P) => `head drifts back less than ${P.max_back}x torso length during the load`,
    badness: (v, P) => hi(v, P, 'max_back'),
    evaluate(e, ctx, P) {
      const p0 = at(ctx, e.start, this.needs), p1 = at(ctx, e.load, this.needs); if (!p0 || !p1) return null;
      const v = ((p0.p2('nose')[0] - p1.p2('nose')[0]) * ctx.dirP) / T(ctx);
      return { value: v, pass: v <= P.max_back, frame: e.load, text: `head drifted back ${r1(v)}x torso`, draw: [segAt(p1, p0.p2('nose'), p1.p2('nose'), 'head drift'), D.vert(p1, 'nose', ctx)] };
    },
  }),
  // stride
  mk({
    id: 'bat_early_hands', group: 'stride', scope: 'event:swing', priority: 3, temporal: true, views: BAT_VIEW,
    kb: { skill: sk('bat-stride'), checkpoint: 'sb-bat-stride-c02', fault: 'sb-bat-stride-f02' },
    label: 'Hands go early (no separation at toe-touch)', okLabel: 'Hands stayed back at toe-touch',
    needs: [...HANDS, 'rear_shoulder'],
    params: { max_forward: { value: 0.3, unit: 'x torso', label: 'Hands may be ahead of the rear shoulder at toe-touch by', note: 'KB: hands still near the rear shoulder when the front foot lands' } },
    thresholdText: (P) => `hands no more than ${P.max_forward}x torso ahead of the rear shoulder at toe-touch`,
    badness: (v, P) => hi(v, P, 'max_forward'),
    evaluate(e, ctx, P) {
      const p = at(ctx, e.toeTouch, this.needs); if (!p) return null;
      const v = ((hands(p)[0] - p.p2('rear_shoulder')[0]) * ctx.dirP) / T(ctx);
      return { value: v, pass: v <= P.max_forward, frame: e.toeTouch, text: e.noStride ? 'no stride seen; hands already going' : `hands ${r1(v)}x torso forward at toe-touch`, draw: [D.vert(p, 'rear_shoulder', ctx, 'rear shoulder'), dotAt(p, hands(p), 'hands')] };
    },
  }),
  mk({
    id: 'bat_lunge', group: 'stride', scope: 'event:swing', priority: 2, views: BAT_VIEW,
    kb: { skill: sk('bat-stride'), checkpoint: 'sb-bat-stride-c03', fault: 'sb-bat-stride-f01' },
    label: 'Lunging / drifting forward', okLabel: 'Head stayed back over the base',
    needs: ['nose', 'lead_ankle', 'rear_ankle'], visReason: 'Feet not visible - film head to toe',
    params: { max_past: { value: 0.3, unit: 'x torso', label: 'Head may be past the middle of the feet (toward the pitcher) by', note: 'KB: no more than a few cm past the stride/rear-foot midpoint' } },
    thresholdText: (P) => `head no more than ${P.max_past}x torso past the middle of the stance at contact`,
    badness: (v, P) => hi(v, P, 'max_past'),
    evaluate(e, ctx, P) {
      const p = at(ctx, e.peak, this.needs); if (!p) return null;
      const m = mid2(p, 'lead_ankle', 'rear_ankle');
      const v = ((p.p2('nose')[0] - m[0]) * ctx.dirP) / T(ctx);
      return { value: v, pass: v <= P.max_past, frame: e.peak, text: `head ${r1(v)}x torso past centre`, draw: [{ k: 'vline', x: m[0] / p.W, y: (m[1] - 0.6 * T(ctx)) / p.H, h: (1.6 * T(ctx)) / ctx.meta.height, text: 'centre' }, D.dot(p, 'nose', 'head')] };
    },
  }),
  // rotation
  mk({
    id: 'bat_hip_turn', group: 'swing', scope: 'event:swing', priority: 1, temporal: true,
    kb: { skill: sk('bat-swing'), checkpoint: 'sb-bat-swing-c01', fault: 'sb-bat-swing-f02' },
    label: 'Arms-only swing (hips not turning)', okLabel: 'Hips turned through the swing',
    needs: HIPS,
    params: { min_deg: { value: 35, unit: 'deg', label: 'Hips must turn at least (load to finish)', note: '3D estimate from the pose model, which under-reads rotation; KB ~90 deg by the finish' } },
    thresholdText: (P) => `hips turn ${P.min_deg} deg or more from the load to the finish`,
    badness: (v, P) => lo(v, P, 'min_deg'),
    evaluate(e, ctx, P) {
      const y = ctx.yawH; if (!y) return null;
      let v = -Infinity;
      for (let j = e.peak; j <= e.end; j++) if (Number.isFinite(y[j])) v = Math.max(v, (y[j] - yawAt(y, e.load)) * e.dir);
      const p = at(ctx, e.peak, this.needs); if (!p || !Number.isFinite(v)) return null;
      return { value: v, pass: v >= P.min_deg, frame: e.peak, text: `hips turned ~${Math.round(v)}°`, draw: [D.line(p, 'lead_hip', 'rear_hip', `hips ~${Math.round(v)}°`), D.line(p, 'lead_shoulder', 'rear_shoulder')] };
    },
  }),
  mk({
    id: 'bat_hips_lead', group: 'swing', scope: 'event:swing', priority: 3, temporal: true, minRealFps: 90,
    kb: { skill: sk('bat-swing'), checkpoint: 'sb-bat-swing-c01', fault: 'sb-bat-swing-f02' },
    label: 'Shoulders turn before the hips (sequence)', okLabel: 'Hips led the shoulders',
    needs: [...HIPS, ...SHOULDERS],
    params: { min_lead: { value: 0, unit: 'deg', label: 'Halfway through the turn, hips must be turned at least this much more than the shoulders' } },
    thresholdText: (P) => `halfway from the start of the turn to contact, hip turn minus shoulder turn >= ${P.min_lead} deg`,
    badness: (v, P) => lo(v, P, 'min_lead'),
    evaluate(e, ctx, P) {
      if (!ctx.yawH || !ctx.yawS) return null;
      // the hips start turning a little before the shoulders: begin a few frames before the shoulder turn
      const s0 = Math.max(e.load, (e.rotStart ?? e.load) - ctx.sec(0.1));
      const m = Math.round((s0 + e.peak) / 2), p = at(ctx, m, this.needs); if (!p) return null;
      const v = ((yawAt(ctx.yawH, m) - yawAt(ctx.yawH, s0)) - (yawAt(ctx.yawS, m) - yawAt(ctx.yawS, s0))) * e.dir;
      if (!Number.isFinite(v)) return null;
      return { value: v, pass: v >= P.min_lead, frame: m, text: `hips ${v >= 0 ? 'ahead' : 'behind'} by ${Math.round(Math.abs(v))}°`, draw: [D.line(p, 'lead_hip', 'rear_hip', 'hips'), D.line(p, 'lead_shoulder', 'rear_shoulder', 'shoulders')] };
    },
  }),
  mk({
    id: 'bat_rear_heel', group: 'swing', scope: 'event:swing', priority: 4, temporal: true,
    kb: { skill: sk('bat-swing'), checkpoint: 'sb-bat-swing-c02', fault: 'sb-bat-swing-f02' },
    label: 'Back foot stays flat (no pivot)', okLabel: 'Back heel came up and turned',
    needs: ['rear_heel', 'rear_foot_index'], visReason: 'Back foot not visible - film head to toe',
    params: { min_lift: { value: 0.3, unit: 'fists', label: 'Back heel must rise by (by contact)', note: "KB: rear heel rises, laces turn to the pitcher" } },
    thresholdText: (P) => `back heel rises ${P.min_lift} fist or more by contact`,
    badness: (v, P) => lo(v, P, 'min_lift'),
    evaluate(e, ctx, P) {
      const p0 = at(ctx, e.start, this.needs); if (!p0) return null;
      const y0 = p0.p2('rear_heel')[1];
      const b = maxOver(ctx, e.toeTouch, Math.min(e.end, e.peak + 1), this.needs, (p) => (y0 - p.p2('rear_heel')[1]) / ctx.unit.fist2); if (!b) return null;
      return { value: b.v, pass: b.v >= P.min_lift, frame: e.peak, text: b.v >= P.min_lift ? 'heel up' : 'back heel flat', draw: [D.line(ctx.poses[e.peak] || b.p, 'rear_heel', 'rear_foot_index', 'heel flat'), D.dot(ctx.poses[e.peak] || b.p, 'rear_heel')] };
    },
  }),
  mk({
    id: 'bat_front_leg', group: 'swing', scope: 'event:swing', priority: 4,
    kb: { skill: sk('bat-swing'), checkpoint: 'sb-bat-swing-c03', fault: null, drills: ['SB-D-PVC-SEQ'] },
    coach: { cue: "'Brace the front leg - hit against a firm front side.'", why: 'A front leg that firms up at contact stops the forward drift so the body rotates around it, transferring energy to the bat (KB checkpoint: lead knee extends toward 160-180 deg).' },
    label: 'Front leg soft at contact (no brace)', okLabel: 'Front leg braced at contact',
    needs: ['lead_hip', 'lead_knee', 'lead_ankle'], visReason: 'Legs not visible - film head to toe',
    params: { min_knee: { value: 150, unit: 'deg', label: 'Front knee angle at contact at least', note: 'KB: ~160-180 deg; lowered for tracking' } },
    thresholdText: (P) => `front knee ${P.min_knee} deg or straighter at contact`,
    badness: (v, P) => lo(v, P, 'min_knee'),
    evaluate(e, ctx, P) {
      const b = maxOver(ctx, e.peak - 1, e.peak + 1, ['lead_hip', 'lead_knee', 'lead_ankle'], (p) => ang3(p, 'lead_hip', 'lead_knee', 'lead_ankle')); if (!b) return null;
      return { value: b.v, pass: b.v >= P.min_knee, frame: b.i, text: `front knee ${Math.round(b.v)}°`, draw: [D.ang(b.p, 'lead_hip', 'lead_knee', 'lead_ankle', `${Math.round(b.v)}°`)] };
    },
  }),
  mk({
    id: 'bat_shoulder_drop', group: 'swing', scope: 'event:swing', priority: 3,
    kb: { skill: sk('bat-swing'), checkpoint: 'sb-bat-swing-c04', fault: 'sb-bat-swing-f03' },
    label: 'Back shoulder drops (uppercut)', okLabel: 'Shoulders stayed level enough',
    needs: SHOULDERS,
    params: { max_drop: { value: 0.45, unit: 'x torso', label: 'Back shoulder may sit below the front shoulder at contact by', note: 'Some tilt is normal (low pitches); estimate' } },
    thresholdText: (P) => `back shoulder no more than ${P.max_drop}x torso below the front shoulder at contact`,
    badness: (v, P) => hi(v, P, 'max_drop'),
    evaluate(e, ctx, P) {
      const p = at(ctx, e.peak, this.needs); if (!p) return null;
      const v = (p.p2('rear_shoulder')[1] - p.p2('lead_shoulder')[1]) / T(ctx);
      return { value: v, pass: v <= P.max_drop, frame: e.peak, text: `back shoulder ${r1(v)}x torso low`, draw: [D.line(p, 'lead_shoulder', 'rear_shoulder', 'shoulder tilt'), D.level(p, 'lead_shoulder', ctx)] };
    },
  }),
  // finish
  mk({
    id: 'bat_head_pull', group: 'finish', scope: 'event:swing', priority: 2, temporal: true,
    kb: { skill: sk('bat-finish'), checkpoint: 'sb-bat-swing-c05', fault: 'sb-bat-finish-f01' },
    label: 'Head pulls off the ball', okLabel: 'Head stayed still to contact',
    needs: ['nose', ...SHOULDERS],
    params: { max_move: { value: 0.3, unit: 'x torso', label: 'Head may move between toe-touch and contact by', note: 'KB: within a few cm' } },
    thresholdText: (P) => `head moves less than ${P.max_move}x torso from toe-touch to contact`,
    badness: (v, P) => hi(v, P, 'max_move'),
    evaluate(e, ctx, P) {
      const p0 = at(ctx, e.toeTouch, this.needs), p1 = at(ctx, e.peak, this.needs); if (!p0 || !p1) return null;
      const v = dist(p0.p2('nose'), p1.p2('nose')) / T(ctx);
      return { value: v, pass: v <= P.max_move, frame: e.peak, text: `head moved ${r1(v)}x torso`, draw: [segAt(p1, p0.p2('nose'), p1.p2('nose'), 'head moved'), D.dot(p1, 'nose')] };
    },
  }),
  mk({
    id: 'bat_extension', group: 'finish', scope: 'event:swing', priority: 5,
    kb: { skill: sk('bat-finish'), checkpoint: 'sb-bat-finish-c01', fault: null, drills: ['SB-D-HOLD-FINISH', 'SB-D-TEE-ROAD'] },
    coach: { cue: "'Through the ball, not around it - long arms after contact.'", why: 'Both arms should extend through the ball just after contact; cutting the extension short pulls the barrel out of the hitting zone early (KB: elbows near full extension shortly after contact).' },
    label: 'No extension through the ball', okLabel: 'Arms extended through contact',
    needs: [...ARM('lead'), ...ARM('rear')],
    params: { min_angle: { value: 140, unit: 'deg', label: 'Both elbows open to at least (after contact)', note: 'KB: ~160-180 deg; lowered because the pose model under-reads blurred arms' }, window_s: { value: 0.45, unit: 's', label: 'Look this long after the estimated contact' } },
    thresholdText: (P) => `both elbows reach ${P.min_angle} deg within ${P.window_s} s after contact`,
    badness: (v, P) => lo(v, P, 'min_angle'),
    evaluate(e, ctx, P) {
      const b = maxOver(ctx, e.peak, Math.min(ctx.poses.length - 1, e.peak + ctx.sec(P.window_s)), this.needs, (p) => Math.min(elbowMax(p, 'lead'), elbowMax(p, 'rear'))); if (!b) return null;
      return { value: b.v, pass: b.v >= P.min_angle, frame: b.i, text: `elbows only ${Math.round(b.v)}°`, draw: [D.ang(b.p, 'lead_shoulder', 'lead_elbow', 'lead_wrist', `${Math.round(elbowMax(b.p, 'lead'))}°`), D.ang(b.p, 'rear_shoulder', 'rear_elbow', 'rear_wrist', `${Math.round(elbowMax(b.p, 'rear'))}°`)] };
    },
  }),
  mk({
    id: 'bat_finish_balance', group: 'finish', scope: 'event:swing', priority: 4, views: BAT_VIEW,
    kb: { skill: sk('bat-finish'), checkpoint: 'sb-bat-finish-c02', fault: 'sb-bat-finish-f02' },
    label: 'Off-balance finish', okLabel: 'Balanced finish between the feet',
    needs: [...HIPS, 'lead_ankle', 'rear_ankle'], visReason: 'Feet not visible - film head to toe',
    params: { margin: { value: 0.15, unit: 'of stance', label: 'Hips may be outside the feet by (share of stance length)' } },
    thresholdText: (P) => `hips between the feet at the finish (±${Math.round(P.margin * 100)}% of the stance)`,
    badness: (v, P) => Math.abs(v - 0.5) - (0.5 + P.margin),
    evaluate(e, ctx, P) {
      const p = at(ctx, e.end, this.needs) || at(ctx, e.end - 2, this.needs); if (!p) return null;
      const ra = p.p2('rear_ankle')[0], la = p.p2('lead_ankle')[0];
      const v = (p.p2('mid_hip')[0] - ra) / ((la - ra) || 1e-9);
      const ok = v >= -P.margin && v <= 1 + P.margin;
      return { value: v, pass: ok, frame: e.end, text: v < 0 ? 'falling back' : v > 1 ? 'falling forward' : 'balanced', draw: [D.line(p, 'rear_ankle', 'lead_ankle', 'base'), D.dot(p, 'mid_hip', v < 0 ? 'hips behind' : 'hips past')] };
    },
  }),
];

const pitchChecks = [
  mk({
    id: 'pitch_arm_straight', group: 'pitch', scope: 'event:pitch', priority: 2,
    kb: { skill: sk('pitch-windmill'), checkpoint: 'sb-pitch-windmill-c02', fault: 'sb-pitch-windmill-f03' },
    label: 'Bent arm at the top of the circle', okLabel: 'Long arm at 12 o\'clock',
    needs: ARM('throw'),
    params: { min_angle: { value: 150, unit: 'deg', label: 'Throwing elbow at the top at least', note: 'KB: ~160-180 deg' } },
    thresholdText: (P) => `throwing elbow ${P.min_angle} deg or straighter at 12 o'clock`,
    badness: (v, P) => lo(v, P, 'min_angle'),
    evaluate(e, ctx, P) {
      const b = maxOver(ctx, e.top - 1, e.top + 1, this.needs, (p) => elbowMax(p, 'throw')); if (!b) return null;
      return { value: b.v, pass: b.v >= P.min_angle, frame: b.i, text: `elbow ${Math.round(b.v)}° at the top`, draw: [D.ang(b.p, 'throw_shoulder', 'throw_elbow', 'throw_wrist', `${Math.round(b.v)}°`)] };
    },
  }),
  mk({
    id: 'pitch_lean_back', group: 'pitch', scope: 'event:pitch', priority: 1, views: ['side'],
    kb: { skill: sk('pitch-windmill'), checkpoint: 'sb-pitch-windmill-c03', fault: 'sb-pitch-windmill-f02' },
    label: 'Leaning back at foot contact', okLabel: 'Trunk upright/forward at foot contact',
    needs: [...HIPS, ...SHOULDERS],
    params: { max_back: { value: 10, unit: 'deg', label: 'Trunk may lean back (toward 2nd base) by', note: 'KB: upright to slightly forward' } },
    thresholdText: (P) => `trunk leans back less than ${P.max_back} deg at stride-foot contact`,
    badness: (v, P) => hi(v, P, 'max_back'),
    evaluate(e, ctx, P) {
      const p = at(ctx, e.fc, this.needs); if (!p) return null;
      const v = -trunkLean(p, ctx.dirT);
      return { value: v, pass: v <= P.max_back, frame: e.fc, text: v > 0 ? `leaning back ${Math.round(v)}°` : 'upright', draw: [D.line(p, 'mid_hip', 'mid_shoulder', `${Math.round(v)}° back`), D.vert(p, 'mid_hip', ctx, 'vertical')] };
    },
  }),
  mk({
    id: 'pitch_brush', group: 'pitch', scope: 'event:pitch', priority: 3,
    kb: { skill: sk('pitch-windmill'), checkpoint: 'sb-pitch-windmill-c05', fault: 'sb-pitch-windmill-f03' },
    label: 'Wide release (arm away from the hip)', okLabel: 'Hand came through close to the hip',
    needs: [...ARM('throw'), 'throw_hip'],
    params: { max_fists: { value: 1.5, unit: 'fists', label: 'Throwing hand passes within this of the hip at release', note: 'KB: ~1 hand-width' } },
    thresholdText: (P) => `throwing hand within ${P.max_fists} fists of the hip at release`,
    badness: (v, P) => hi(v, P, 'max_fists'),
    evaluate(e, ctx, P) {
      const b = minOver(ctx, e.peak - 1, e.peak + 1, this.needs, (p) => dist(p.p2('throw_wrist'), p.p2('throw_hip')) / ctx.unit.fist2); if (!b) return null;
      return { value: b.v, pass: b.v <= P.max_fists, frame: b.i, text: `hand ${r1(b.v)} fists from hip`, draw: [D.zone(b.p, 'throw_hip', P.max_fists, ctx), D.line(b.p, 'throw_wrist', 'throw_hip', `${r1(b.v)} fists`)] };
    },
  }),
  mk({
    id: 'pitch_stride', group: 'pitch', scope: 'event:pitch', priority: 4, views: ['side'], temporal: true,
    kb: { skill: sk('pitch-windmill'), checkpoint: 'sb-pitch-windmill-c01', fault: 'sb-pitch-windmill-f04' },
    label: 'Short stride / weak drive', okLabel: 'Good drive and stride',
    needs: ['lead_ankle', 'rear_ankle'], visReason: 'Feet not visible - film head to toe',
    params: { min_stride: { value: 1.2, unit: 'x torso', label: 'Feet apart at stride-foot contact at least', note: 'Estimate; long drive strides are typical of good windmill pitchers' } },
    thresholdText: (P) => `feet at least ${P.min_stride}x torso apart at stride-foot contact`,
    badness: (v, P) => lo(v, P, 'min_stride'),
    evaluate(e, ctx, P) {
      const p = at(ctx, e.fc, this.needs); if (!p) return null;
      const v = dist(p.p2('lead_ankle'), p.p2('rear_ankle')) / T(ctx);
      return { value: v, pass: v >= P.min_stride, frame: e.fc, text: `stride ${r1(v)}x torso`, draw: [D.line(p, 'rear_ankle', 'lead_ankle', `stride ${r1(v)}x`)] };
    },
  }),
  mk({
    id: 'pitch_knee_collapse', group: 'pitch', scope: 'event:pitch', priority: 5, views: ['side'], temporal: true,
    kb: { skill: sk('pitch-windmill'), checkpoint: 'sb-pitch-windmill-c04', fault: null, drills: ['SB-D-POWERLINE'] },
    coach: { cue: "'Land firm on the front leg - post up and let the arm whip.'", why: 'The stride leg takes braking forces above body weight; a front knee that keeps collapsing leaks energy and loads the knee (KB c04).' },
    label: 'Front knee collapses after landing', okLabel: 'Firm front leg after landing',
    needs: ['lead_hip', 'lead_knee', 'lead_ankle'], visReason: 'Legs not visible - film head to toe',
    params: { max_extra: { value: 45, unit: 'deg', label: 'Extra knee bend after foot contact at most', note: 'KB: no collapse > ~45 deg' } },
    thresholdText: (P) => `front knee bends less than ${P.max_extra} deg more after landing`,
    badness: (v, P) => hi(v, P, 'max_extra'),
    evaluate(e, ctx, P) {
      const p0 = at(ctx, e.fc, this.needs); if (!p0) return null;
      const k0 = knee(p0, 'lead', ctx);
      const b = minOver(ctx, e.fc, Math.min(e.end, e.fc + ctx.sec(0.3)), this.needs, (p) => knee(p, 'lead', ctx)); if (!b) return null;
      const v = k0 - b.v;
      return { value: v, pass: v <= P.max_extra, frame: b.i, text: `knee bent ${Math.round(v)}° more`, draw: [D.ang(b.p, 'lead_hip', 'lead_knee', 'lead_ankle', `${Math.round(b.v)}°`)] };
    },
  }),
];

const fieldChecks = [
  mk({
    id: 'field_legs', group: 'field', scope: 'event:field', priority: 1,
    kb: { skill: sk('field-groundball'), checkpoint: 'sb-field-groundball-c02', fault: 'sb-field-groundball-f02' },
    label: 'Bending at the waist (legs straight)', okLabel: 'Got low with the legs',
    needs: LEGS, visReason: 'Legs not visible - film head to toe',
    params: { max_knee: { value: 150, unit: 'deg', label: 'Average knee angle when fielding at most', note: 'KB: hips and knees bent, glove on the ground (estimate)' } },
    thresholdText: (P) => `average knee angle under ${P.max_knee} deg at the fielding moment`,
    badness: (v, P) => hi(v, P, 'max_knee'),
    evaluate(e, ctx, P) {
      const p = at(ctx, e.peak, this.needs); if (!p) return null;
      const L = joint(p, 'left_hip', 'left_knee', 'left_ankle', ctx), R = joint(p, 'right_hip', 'right_knee', 'right_ankle', ctx), v = (L + R) / 2;
      return { value: v, pass: v <= P.max_knee, frame: e.peak, text: `knees ${Math.round(v)}° - legs straight`, draw: [D.ang(p, 'left_hip', 'left_knee', 'left_ankle', `${Math.round(L)}°`), D.ang(p, 'right_hip', 'right_knee', 'right_ankle', `${Math.round(R)}°`)] };
    },
  }),
  mk({
    id: 'field_out_front', group: 'field', scope: 'event:field', priority: 2, views: ['side'],
    kb: { skill: sk('field-groundball'), checkpoint: 'sb-field-groundball-c01', fault: 'sb-field-groundball-f01' },
    label: 'Fielding between the feet (too deep)', okLabel: 'Glove out in front',
    needs: ['glove_wrist', 'left_foot_index', 'right_foot_index'], visReason: 'Glove or feet not visible',
    params: { min_ahead: { value: 0.25, unit: 'x torso', label: 'Glove ahead of the toes by at least', note: 'KB: about a forearm in front (triangle apex)' } },
    thresholdText: (P) => `glove at least ${P.min_ahead}x torso in front of the toes`,
    badness: (v, P) => lo(v, P, 'min_ahead'),
    evaluate(e, ctx, P) {
      const p = at(ctx, e.peak, this.needs); if (!p) return null;
      const dir = facing(p);
      const toes = Math.max(p.p2('left_foot_index')[0] * dir, p.p2('right_foot_index')[0] * dir) * dir;
      const v = ((p.p2('glove_wrist')[0] - toes) * dir) / T(ctx);
      return { value: v, pass: v >= P.min_ahead, frame: e.peak, text: `glove ${r1(v)}x torso ${v >= 0 ? 'ahead of' : 'behind'} toes`, draw: [{ k: 'vline', x: toes / p.W, y: p.p2('glove_wrist')[1] / p.H, h: (0.8 * T(ctx)) / ctx.meta.height, text: 'toes' }, D.dot(p, 'glove_wrist', 'glove')] };
    },
  }),
  mk({
    id: 'field_transfer', group: 'field', scope: 'event:field', priority: 3, temporal: true,
    kb: { skill: sk('field-groundball'), checkpoint: 'sb-field-groundball-c04', fault: 'sb-field-groundball-f03' },
    label: 'Slow transfer to the throwing shoulder', okLabel: 'Quick transfer',
    needs: ['throw_wrist', 'throw_shoulder'],
    params: { max_s: { value: 0.7, unit: 's', label: 'Ball hand up at the throwing shoulder within', note: 'KB: ~0.5 s' } },
    thresholdText: (P) => `ball hand reaches throwing-shoulder height within ${P.max_s} s of the catch`,
    badness: (v, P) => hi(v, P, 'max_s'),
    evaluate(e, ctx, P) {
      for (let i = e.peak; i <= e.end; i++) {
        const p = at(ctx, i, this.needs); if (!p) continue;
        if (p.p2('throw_wrist')[1] <= p.p2('throw_shoulder')[1] + 0.2 * T(ctx)) {
          const v = ctx.rt(i) - ctx.rt(e.peak);
          return { value: v, pass: v <= P.max_s, frame: i, text: `transfer ${v.toFixed(2)} s`, draw: [D.level(p, 'throw_shoulder', ctx, 'shoulder'), D.dot(p, 'throw_wrist')] };
        }
      }
      const p = at(ctx, e.end, this.needs); if (!p) return null;
      return { value: 9, pass: false, frame: e.end, text: 'ball never came up to throw', draw: [D.level(p, 'throw_shoulder', ctx, 'shoulder'), D.dot(p, 'throw_wrist', 'still low')] };
    },
  }),
];

const throwChecks = [
  mk({
    id: 'throw_closed', group: 'throw', scope: 'event:throw', priority: 1, views: ['side'], temporal: true,
    kb: { skill: sk('throw-overhand'), checkpoint: 'sb-throw-overhand-c01', fault: 'sb-throw-overhand-f01' },
    label: 'Throwing open / all arm', okLabel: 'Front shoulder pointed at the target',
    needs: SHOULDERS,
    params: { max_open: { value: 40, unit: 'deg', label: 'Shoulders may be turned open at stride-foot contact by', note: 'KB: within ~20 deg of the throw line; estimated from the on-screen shoulder width' } },
    thresholdText: (P) => `shoulders open less than ${P.max_open} deg at stride-foot contact`,
    badness: (v, P) => hi(v, P, 'max_open'),
    evaluate(e, ctx, P) {
      const w0 = maxOver(ctx, e.start, e.peak, this.needs, (p) => width2(p, 'left_shoulder', 'right_shoulder', ctx));
      const p = at(ctx, e.fc, this.needs); if (!p || !w0) return null;
      const v = turnFromWidth(width2(p, 'left_shoulder', 'right_shoulder', ctx), w0.v);
      return { value: v, pass: v <= P.max_open, frame: e.fc, text: `shoulders ~${Math.round(v)}° open`, draw: [D.line(p, 'glove_shoulder', 'throw_shoulder', `open ~${Math.round(v)}°`)] };
    },
  }),
  mk({
    id: 'throw_slot', group: 'throw', scope: 'event:throw', priority: 2, views: ['front'],
    kb: { skill: sk('throw-overhand'), checkpoint: 'sb-throw-overhand-c02', fault: 'sb-throw-overhand-f02', drills: ['SB-D-POPFEET'] },
    label: 'Low / drop-down arm slot', okLabel: 'Three-quarter arm slot',
    needs: ARM('throw'),
    params: { max_below: { value: 0.0, unit: 'fists', label: 'Throwing elbow may sit below shoulder height by', note: 'KB: elbow below shoulder height = drop-down slot' } },
    thresholdText: (P) => `throwing elbow at or above shoulder height at release (tolerance ${P.max_below} fist)`,
    badness: (v, P) => hi(v, P, 'max_below'),
    evaluate(e, ctx, P) {
      const p = at(ctx, e.peak, this.needs); if (!p) return null;
      const v = (p.p2('throw_elbow')[1] - p.p2('throw_shoulder')[1]) / ctx.unit.fist2;
      return { value: v, pass: v <= P.max_below, frame: e.peak, text: v > 0 ? `elbow ${r1(v)} fists below shoulder` : 'elbow up', draw: [D.level(p, 'throw_shoulder', ctx, 'shoulder'), D.line(p, 'throw_shoulder', 'throw_elbow'), D.dot(p, 'throw_elbow', 'elbow')] };
    },
  }),
  mk({
    id: 'throw_follow', group: 'throw', scope: 'event:throw', priority: 4, views: ['front'], temporal: true,
    kb: { skill: sk('throw-overhand'), checkpoint: 'sb-throw-overhand-c03', fault: null, drills: ['SB-D-POPFEET'] },
    coach: { cue: "'Finish across - throwing hand to the opposite hip.'", why: 'Following through across the body lets the arm decelerate over a long path and keeps the throw on line (KB c03).' },
    label: 'Short follow-through', okLabel: 'Finished across the body',
    needs: ['throw_wrist', ...HIPS],
    params: { min_across: { value: 0.0, unit: 'x torso', label: 'Throwing hand must cross past the body midline by' } },
    thresholdText: (P) => `throwing hand crosses ${P.min_across}x torso past the midline after release`,
    badness: (v, P) => lo(v, P, 'min_across'),
    evaluate(e, ctx, P) {
      const b = maxOver(ctx, e.peak, e.end, this.needs, (p) => {
        const toGlove = Math.sign(p.p2('glove_hip')[0] - p.p2('throw_hip')[0]) || 1;
        return ((p.p2('throw_wrist')[0] - p.p2('mid_hip')[0]) * toGlove) / T(ctx);
      }); if (!b) return null;
      return { value: b.v, pass: b.v >= P.min_across, frame: b.i, text: b.v >= P.min_across ? 'across' : 'arm stopped short', draw: [D.vert(b.p, 'mid_hip', ctx, 'midline'), D.dot(b.p, 'throw_wrist')] };
    },
  }),
];

export const softball = {
  id: 'softball', name: 'Softball', kbFile: 'data/softball.json',
  roles: (stance) => (stance === 'left'
    ? { lead: 'right', rear: 'left', throw: 'left', glove: 'right' }
    : { lead: 'left', rear: 'right', throw: 'right', glove: 'left' }),
  stances: [
    { id: 'right', label: 'Right-handed', hint: 'bats & throws right' },
    { id: 'left', label: 'Left-handed', hint: 'bats & throws left' },
  ],
  stanceNote: 'Bats one side, throws the other? Pick the side for the skill you are filming.',
  views: [
    { id: 'side', label: 'Side', hint: 'Batting: facing the hitter\'s chest, across the plate' },
    { id: 'front', label: 'Front', hint: 'From the target / pitcher line' },
  ],
  filmingTips: [
    'Whole body in frame, head to feet, plus a little room in the swing/throw direction.',
    'Phone steady at hip height, 4-6 m away. Prop it on a bucket or fence.',
    'One athlete in frame; avoid filming into the sun.',
  ],
  skills: [
    { id: 'batting', label: 'Batting swing', kbSkill: 'sb-bat-swing', kbSkills: ['sb-bat-stance-load', 'sb-bat-stride', 'sb-bat-swing', 'sb-bat-finish'], checks: ['swing', 'stride', 'load', 'stance', 'finish'], all: true, view: 'side', minFps: 30,
      filming: ['Side view from the open side (facing the hitter\'s chest), hip height, square to the plate.', 'Use SLOW-MO (120-240 fps) if your phone has it, then set "Slow-mo" below. At normal speed contact is only 1-2 frames.', 'Tee or soft toss is fine: 2-4 swings per clip, reset between swings.'] },
    { id: 'pitching', label: 'Windmill pitch', kbSkill: 'sb-pitch-windmill', checks: ['pitch'], view: 'side', beta: true, minFps: 30,
      filming: ['Side view from the glove side, 10-15 m away, whole body and the stride in frame.', 'Slow-mo (120-240 fps) strongly recommended - the arm circle is very fast.', 'Behind the pitcher (rear view) is best for the power line: use the coach checklist for that.'] },
    { id: 'fielding', label: 'Fielding ground balls', kbSkill: 'sb-field-groundball', checks: ['field'], view: 'side', beta: true,
      filming: ['Side view at ground level, 3-5 m away, so the glove and both feet are visible.', 'Rolled or short-hop balls; one fielder in frame; 3-5 reps.'] },
    { id: 'throwing', label: 'Overhand throw', kbSkill: 'sb-throw-overhand', checks: ['throw'], view: 'front', beta: true, minFps: 30,
      filming: ['Side view (from the glove side) for the shoulder turn, OR front view from the target for arm slot and follow-through.', 'Slow-mo helps: the release lasts a few hundredths of a second.'] },
  ],
  frameLabels: { stance: 'stance frames' },
  noFramesReason: (set) => (set === 'stance' ? 'No still stance found before a swing' : null),
  eventLabel: (t) => ({ swing: 'swings', pitch: 'pitches', field: 'fielding reps', throw: 'throws' })[t] || t,
  globals: baseGlobals({
    swing_min_turn_speed: { value: 150, label: 'Swing: shoulders turn faster than', unit: 'deg/s' },
    swing_min_turn: { value: 35, label: 'Swing: shoulders turn at least', unit: 'deg', note: 'a real swing turns ~90 deg, but one camera under-reads 3D rotation by about half' },
    contact_turn_fraction: { value: 0.5, label: 'Contact estimate: share of the shoulder turn done', unit: '0-1' },
    pitch_min_speed: { value: 5, label: 'Pitch: throwing hand faster than', unit: 'torso/s' },
    throw_min_speed: { value: 5, label: 'Throw: throwing hand faster than', unit: 'torso/s' },
    field_min_reach: { value: 0.7, label: 'Fielding rep: glove below the hips by at least', unit: 'x torso' },
  }),

  detectEvents(ctx) {
    const skill = ctx.skill.id, notes = [];
    if (skill === 'batting') {
      if (ctx.isPhoto) {
        ctx.dirP = medianSign(ctx, HIPS, (p) => p.p2('lead_hip')[0] - p.p2('rear_hip')[0]);
        return { events: [], frameSets: { stance: [0] }, notes: ['Photo: stance checks only. Film a swing for the rest.'] };
      }
      const events = detectSwings(ctx);
      const stance = new Set();
      for (const e of events) for (let i = e.start; i <= e.load; i++) if (ctx.poses[i]) stance.add(i);
      if (!events.length) {
        notes.push('No swing found. Is the whole swing in the clip? Checking the stance only.');
        ctx.poses.forEach((p, i) => p && stance.add(i));
      }
      if (events.some((e) => e.noStride)) notes.push('No stride seen on some swings (no-stride hitters are fine): toe-touch was estimated.');
      if (ctx.fps < 60) notes.push(`Clip is ${Math.round(ctx.fps)} fps: contact timing is approximate. Slow-mo makes the swing checks more precise.`);
      return { events, frameSets: { stance: [...stance].sort((a, b) => a - b) }, notes };
    }
    if (ctx.isPhoto) return { events: [], notes: ['This skill needs a video: use the coach checklist with the photo.'] };
    const events = skill === 'pitching' ? detectPitches(ctx) : skill === 'throwing' ? detectThrows(ctx) : detectFielding(ctx);
    if (!events.length) notes.push(`No ${softball.eventLabel(({ pitching: 'pitch', throwing: 'throw', fielding: 'field' })[skill])} found - check that the whole motion is in frame.`);
    return { events, notes };
  },
  keyframes(ctx, ev) {
    const k = [];
    for (const e of ev.events) {
      if (e.type === 'swing') k.push({ i: e.start, label: 'Stance' }, { i: e.load, label: 'Load' }, { i: e.toeTouch, label: 'Toe-touch' }, { i: e.peak, label: 'Contact' }, { i: e.end, label: 'Finish' });
      else if (e.type === 'pitch') k.push({ i: e.top, label: '12 o\'clock' }, { i: e.fc, label: 'Foot contact' }, { i: e.peak, label: 'Release' });
      else if (e.type === 'throw') k.push({ i: e.fc, label: 'Foot contact' }, { i: e.peak, label: 'Release' }, { i: e.end, label: 'Follow-through' });
      else k.push({ i: e.peak, label: 'Fielding' });
    }
    return k.length ? k : null;
  },
  checks: [...batChecks, ...pitchChecks, ...fieldChecks, ...throwChecks],
};
export default softball;
