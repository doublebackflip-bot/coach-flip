// Sport-agnostic rule engine.
// A sport module supplies: roles(stance), skills, globals, detectEvents(ctx), checks[].
// The core prepares poses, scale units, guard/event windows, runs checks, groups
// failing frames into episodes and returns a plain-JSON result (stored in IndexedDB).
import { Pose, smoothFrames } from './landmarks.js';
import { median, dist, round } from './geom.js';
import { inferLeadSide } from './kit.js';
import { markOcclusion } from './occlusion.js';
import { bodyView } from './view.js';

export function buildConfig(sport, overrides = {}) {
  const cfg = { globals: {}, checks: {} };
  for (const [k, p] of Object.entries(sport.globals)) cfg.globals[k] = overrides.globals?.[k] ?? p.value;
  for (const c of sport.checks) {
    cfg.checks[c.id] = { enabled: overrides.checks?.[c.id]?.enabled ?? true };
    for (const [k, p] of Object.entries(c.params || {})) cfg.checks[c.id][k] = overrides.checks?.[c.id]?.[k] ?? p.value;
  }
  return cfg;
}

/**
 * Analyse a tracked clip. Wraps analyzeOnce() with a slow-motion sanity check: if "slow-mo" is set but
 * the reps take an impossibly short real time (e.g. a 0.05 s jab), the clip is really normal speed
 * (the setting was left on, or the clip came from the in-app recorder) -> analyse at normal speed.
 */
export function analyze(input, opts) {
  const r = analyzeOnce(input, opts);
  const slowmo = Math.max(1, +opts.slowmo || 1);
  const minS = opts.sport.minRealEventSeconds;
  if (slowmo > 1 && !opts.isPhoto && minS && r.events.length >= 2) {
    const fr = input.frames;
    const real = median(r.events.map((e) => (fr[Math.min(e.end, fr.length - 1)].t - fr[e.start].t) / slowmo));
    if (real < minS) {
      const r1 = analyzeOnce(input, { ...opts, slowmo: 1 });
      r1.slowmoIgnored = slowmo;
      r1.notes.unshift(`Slow-mo ${slowmo}x was set, but the reps look like normal speed (${round(real, 2)} s each at ${slowmo}x would be impossibly fast), so this clip was analysed at normal speed.`);
      return r1;
    }
  }
  return r;
}

function analyzeOnce(input, { sport, skillId, view, stance, overrides = {}, isPhoto = false, slowmo = 1 }) {
  const cfg = buildConfig(sport, overrides);
  const G = cfg.globals;
  const meta = { ...input.meta };
  view ??= sport.views?.[0]?.id ?? 'front';
  stance ??= sport.stances?.[0]?.id ?? null;
  // cleaned tracks (js/engine/tracking.js) are already filtered: don't smooth twice
  const smoothWin = input.meta?.cleaned ? 1 : (G.smoothing_frames ?? 3);
  // hands/face hidden behind the body (athlete turned away, far arm in a profile view) -> low confidence
  const smoothed = isPhoto ? input.frames : smoothFrames(input.frames, smoothWin);
  const frames = sport.occlusionAware ? markOcclusion(smoothed) : smoothed; // combat sports: hidden guard hand / far arm
  const skill0 = sport.skills.find((s) => s.id === skillId) || sport.skills[0];
  // Lead side from the body itself (mirror-proof): a selfie-camera video or a wrong stance setting
  // would otherwise swap jab/cross and lead/rear hands.
  let stanceNote = null, leadInfo = null;
  const stanceIn = stance;
  if (sport.stanceFromLead && !isPhoto && skill0.mode !== 'checklist') {
    leadInfo = inferLeadSide(frames);
    const s2 = leadInfo.side ? sport.stanceFromLead(leadInfo.side) : null;
    if (s2 && stance && s2 !== stance) {
      stanceNote = `Stance is set to ${stance}, but in this video the ${leadInfo.side} side is forward (${s2} stance, or a mirrored selfie video). Analysed as ${s2} so jab/cross and lead/rear hands match what was thrown.`;
      stance = s2;
    }
  }
  const roles = sport.roles(stance);
  const poses = frames.map((f) => (f.lm ? new Pose(f, meta, roles) : null));
  // fps = frames per REAL second. A slow-motion clip that plays back 4x slower has 4x more
  // real-time resolution, so durations (contact time, cadence...) must be scaled.
  slowmo = Math.max(1, +slowmo || 1);
  const videoFps = meta.fps || estimateFps(frames);
  const fps = videoFps * slowmo;
  const skill = skill0;

  // Scale: torso length (mid-shoulder -> mid-hip). Visible in both front and side views,
  // so it is a steadier yardstick than shoulder width. "1 fist" = fist_torso_ratio x torso.
  const okPoses = poses.filter((p) => p && p.vis('left_shoulder', 'right_shoulder', 'left_hip', 'right_hip') > 0.3);
  const torso2 = median(okPoses.map((p) => dist(p.p2('mid_shoulder'), p.p2('mid_hip'))));
  const torso3 = median(okPoses.map((p) => p.p3('mid_shoulder') && dist(p.p3('mid_shoulder'), p.p3('mid_hip'))));
  const fr = G.fist_torso_ratio ?? 0.2;
  const unit = { torso2, torso3, fist2: torso2 * fr, fist3: torso3 * fr };

  const ctx = { poses, frames, meta, fps, videoFps, slowmo, cfg, G, view, stance, skill, unit, isPhoto, sport,
    sec: (s) => Math.max(1, Math.round(s * fps)), rt: (i) => frames[i].t / slowmo };
  const result = {
    engine_version: '0.5.0', sport: sport.id, skill: skill.id, view, stance, isPhoto, mode: skill.mode || 'auto',
    meta: { ...meta, fps: videoFps, realFps: round(fps, 1), slowmo, frames: frames.length, posed: okPoses.length },
    unit: { torso_px: round(torso2, 1), fist_px: round(unit.fist2, 1) },
    events: [], checks: [], frameFlags: {}, notes: [], keyframes: [], metrics: [],
    stanceUsed: stance, stanceSet: stanceIn, lead: leadInfo,
  };
  if (stanceNote) result.notes.push(stanceNote);
  if (okPoses.length < (isPhoto ? 1 : 5)) {
    result.notes.push('No athlete found in enough frames. Film the whole body, one athlete in frame, good light.');
    return result;
  }

  // v0.5: camera angle from the body (chest direction) for sports that don't read it from the movement. Done before
  // the events so a wrong pick ("side" filmed from behind) is corrected before anything is measured.
  let bodyV = null;
  if (sport.bodyView && !isPhoto && skill.mode !== 'checklist' && skill.viewCheck !== false) {
    bodyV = bodyView(ctx);
    if (bodyV?.class && bodyV.class !== view && sport.views?.some((v) => v.id === bodyV.class)) { ctx.view = bodyV.class; result.view = bodyV.class; }
  }
  const ev = skill.mode === 'checklist' ? { events: [], guardFrames: [] } : sport.detectEvents(ctx);
  if (!ev.view && bodyV?.class) ev.view = bodyV;
  ctx.events = ev.events; ctx.guardFrames = ev.guardFrames || [];
  ctx.frameSets = { guard: ctx.guardFrames, ...(ev.frameSets || {}) };
  result.events = ev.events.map((e) => ({ ...e, t: round(frames[e.peak].t, 3) }));
  result.guardFrameCount = ctx.guardFrames.length;
  if (ev.notes) result.notes.push(...ev.notes);
  // camera angle read from the movement (sport-specific, e.g. how much a straight punch shows across the picture)
  if (ev.view && !isPhoto) {
    const V = ev.view;
    result.viewDetected = V;
    const vlabel = (v) => sport.views?.find((x) => x.id === v)?.label?.toLowerCase() || v;
    const supported = (v) => sport.views?.some((x) => x.id === v);
    const body = V.basis === 'body';
    if (V.class === 'angled') {
      ctx.angled = true;
      result.notes.push(V.note || (body
        ? `Camera looks about ${V.angle}° off square-on (a 3/4 view). Checks that need a square-on view are marked "not clear". For the most checks, film exactly from the side or straight-on.`
        : `Camera looks about ${V.angle}° off the line of the punches (a 3/4 view). Checks that need a square-on view are marked "not clear". For the most checks, film straight-on (front) or exactly from the side.`));
    } else if (!supported(V.class)) {
      // e.g. filmed from behind when the sport has no rear view: view-dependent checks can't be judged
      ctx.angled = true; ctx.gateReason = V.gateReason || 'Not clear enough to judge from behind the athlete';
      result.notes.push(V.note || `The camera looks to be behind the athlete (back to the camera), not a ${vlabel(view)} view. Checks that need the ${vlabel(view)} view are marked "not clear". Film from the ${vlabel(sport.views?.[0]?.id)} for the full check.`);
    } else if (ctx.view !== view) {
      // already switched before / while detecting the events (body view, softball batting)
      result.view = ctx.view;
      result.notes.push(V.note || `This looks like a ${vlabel(ctx.view)} view, not ${vlabel(view)}: analysed as ${vlabel(ctx.view)}.`);
    } else if (V.class !== view) {
      result.notes.push(V.note || `This looks like a ${vlabel(V.class)} view (punches about ${V.angle}° from the camera line), not ${vlabel(view)}: analysed as ${vlabel(V.class)}.`);
      ctx.view = V.class; result.view = V.class;
    }
  }
  if (ev.metrics) result.metrics.push(...ev.metrics);
  // keyframes for scrubbing (coach checklist mode, and the timeline ticks)
  result.keyframes = (sport.keyframes?.(ctx, ev) || pickKeyframes(ctx)).map((k) => ({ ...k, t: round(frames[k.i].t, 3) }));
  if (skill.mode === 'checklist') return result;

  const flag = (i, item) => { (result.frameFlags[i] ??= []).push(item); };

  for (const chk of sport.checks) {
    if (!skill.checks.some((g) => chk.group === g)) continue;
    const P = cfg.checks[chk.id];
    const base = {
      id: chk.id, label: chk.label, okLabel: chk.okLabel, group: chk.group, kb: chk.kb, basis: chk.basis,
      priority: chk.priority ?? 5, thresholdText: chk.thresholdText(P), beta: chk.basis !== 'source',
    };
    if (!P.enabled) { result.checks.push({ ...base, status: 'disabled' }); continue; }
    if (ctx.angled && (chk.angleSensitive || (chk.views && chk.views.length < (sport.views?.length || 2)))) {
      // parts that are simply out of the picture -> "not visible" (more useful advice than "camera angle")
      const seen = chk.needs?.length ? ctx.poses.filter((p) => p && p.vis(...chk.needs) >= G.min_visibility).length / (ctx.poses.length || 1) : 1;
      if (seen < 0.2) result.checks.push({ ...base, status: 'not_visible', reason: chk.visReason || 'Body parts needed for this check were not visible' });
      else result.checks.push({ ...base, status: 'unclear', reason: ctx.gateReason || `Not clear enough to judge from this camera angle (~${result.viewDetected?.angle}° off square-on)` });
      continue;
    }
    if (chk.views && !chk.views.includes(ctx.view)) { result.checks.push({ ...base, status: 'wrong_view', reason: `Needs a ${chk.views.join('/')} view` }); continue; }
    if (isPhoto && chk.temporal) { result.checks.push({ ...base, status: 'needs_video', reason: 'Needs video (movement over time)' }); continue; }
    if (!isPhoto && chk.minRealFps && fps < chk.minRealFps - 0.5) {
      result.checks.push({ ...base, status: 'needs_slowmo', reason: `Needs ${chk.minRealFps}+ fps: film in slow-mo and set "slow-motion" before analysing (this clip: ${Math.round(fps)} fps)` }); continue;
    }

    if (chk.scope === 'clip') {
      const m = chk.evaluateClip(ctx, P);
      if (!m || m.status) { result.checks.push({ ...base, status: m?.status || 'not_visible', reason: m?.reason || chk.visReason || 'Not enough clean movement to measure' }); continue; }
      const isFault = !m.pass;
      if (isFault && Number.isInteger(m.frame)) flag(m.frame, { check: chk.id, label: chk.label, draw: m.draw, text: m.text, key: true });
      result.checks.push({ ...base, status: isFault ? 'fault' : 'ok', checked: 1, failed: isFault ? 1 : 0, score: isFault ? 0 : 1,
        summary: m.summary || m.text, typical: round(m.value, 2),
        instances: isFault && Number.isInteger(m.frame) ? [{ frame: m.frame, t: round(frames[m.frame].t, 3), value: round(m.value, 2), text: m.text }] : [] });
      continue;
    }
    if (chk.scope === 'guard' || chk.scope.startsWith('frames:')) {
      const setName = chk.scope === 'guard' ? 'guard' : chk.scope.slice(7);
      const res = runFrameCheck(chk, P, ctx, setName);
      if (res.status !== 'checked') { result.checks.push({ ...base, ...res }); continue; }
      const fconf = median(res.fails.map((f) => f.conf));
      const failFrac = res.fails.length / res.checked;
      const episodes = groupEpisodes(res.fails, ctx.sec(G.episode_gap_s));
      const isFault = isPhoto ? res.fails.length > 0 : failFrac >= G.guard_fail_fraction && res.fails.length >= Math.min(ctx.sec(G.min_fault_duration_s), res.checked);
      const instances = episodes.map((e) => {
        const worst = e.frames.reduce((a, b) => (chk.badness(b.m.value, P) > chk.badness(a.m.value, P) ? b : a));
        return { frame: worst.i, t: round(frames[worst.i].t, 3), start_t: round(frames[e.frames[0].i].t, 3), end_t: round(frames[e.frames.at(-1).i].t, 3), value: round(worst.m.value, 2), text: worst.m.text };
      }).sort((a, b) => chk.badness(b.value, P) - chk.badness(a.value, P));
      if (isFault) for (const f of res.fails) flag(f.i, { check: chk.id, label: chk.label, draw: f.m.draw, text: f.m.text });
      result.checks.push({
        ...base, status: isFault ? 'fault' : 'ok', checked: res.checked, failed: res.fails.length, ...(isFault ? confOf(fconf, meta) : {}),
        score: round(1 - failFrac, 2), summary: isFault ? `${Math.round(failFrac * 100)}% of ${frameLabel(sport, setName)}` : `OK in ${Math.round((1 - failFrac) * 100)}% of ${frameLabel(sport, setName)}`,
        typical: round(median(res.all), 2), instances: isFault ? instances.slice(0, 5) : [],
      });
    } else {
      // event scope, e.g. 'event:lead_straight' (several types: 'event:a|b')
      const type = chk.scope.split(':')[1];
      const types = type.split('|');
      const evs = ctx.events.filter((e) => types.includes(e.type));
      if (!evs.length) { result.checks.push({ ...base, status: 'no_events', reason: `No ${sport.eventLabel(type)} detected` }); continue; }
      const found = []; let unclear = 0;
      for (const e of evs) {
        const m = chk.evaluate(e, ctx, P);
        if (!m || !Number.isFinite(m.value)) continue; // could not be measured at all (parts out of the picture)
        // judge a rep only if the body parts this check needs are tracked confidently at its key frame
        const k = m.frame ?? e.peak, pk = ctx.poses[k];
        const conf = pk && chk.needs ? pk.vis(...chk.needs) : 1;
        if (conf < (G.judge_min_conf ?? 0.6)) { unclear++; continue; }
        found.push({ e, m, conf });
      }
      if (!found.length) {
        result.checks.push({ ...base, status: unclear ? 'unclear' : 'not_visible', reason: unclear ? 'Not clear enough to judge: the body parts this needs were hidden or tracked unsure at the key moments' : (chk.visReason || 'Body parts needed for this check were not visible') });
        continue;
      }
      const fails = found.filter((f) => !f.m.pass);
      const isFault = fails.length / found.length >= G.event_fail_fraction && fails.length > 0;
      if (isFault) for (const f of fails) {
        const k = f.m.frame ?? f.e.peak;
        for (let i = Math.max(0, k - G.event_flag_halfwidth); i <= Math.min(frames.length - 1, k + G.event_flag_halfwidth); i++)
          flag(i, { check: chk.id, label: chk.label, draw: f.m.draw, text: f.m.text, key: i === k });
      }
      result.checks.push({
        ...base, status: isFault ? 'fault' : 'ok', checked: found.length, failed: fails.length, unclear, ...(isFault ? confOf(median(fails.map((f) => f.conf)), meta) : {}),
        score: round(1 - fails.length / found.length, 2),
        summary: `${fails.length} of ${found.length} ${sport.eventLabel(type)}`,
        typical: round(median(found.map((f) => f.m.value)), 2),
        instances: fails.map((f) => ({ frame: f.m.frame ?? f.e.peak, t: round(frames[f.m.frame ?? f.e.peak].t, 3), value: round(f.m.value, 2), text: f.m.text }))
          .sort((a, b) => chk.badness(b.value, P) - chk.badness(a.value, P)).slice(0, 8),
      });
    }
  }
  // Coach the most important things first: faults by priority, then by how often they happened.
  // Faults of the skill being filmed (e.g. jab checks when "Jab" is picked) come before general guard faults.
  const primary = skill.checks[0];
  const rk = (c) => rank(c) + (c.status === 'fault' && skill.checks.length > 1 && c.group !== primary && !skill.all && skill.id !== 'shadow' ? 25 : 0);
  result.checks.sort((a, b) => rk(a) - rk(b));
  return result;
}

const STATUS_ORDER = { fault: 0, ok: 1, no_events: 2, unclear: 3, not_visible: 3, needs_video: 4, needs_slowmo: 5, wrong_view: 6, disabled: 7 };
/** how sure we are about a fault: landmark confidence at the failing moments, capped by the clip's tracking quality */
function confOf(c, meta) {
  let level = !Number.isFinite(c) ? 'medium' : c >= 0.85 ? 'high' : c >= 0.7 ? 'medium' : 'low';
  const q = meta?.quality?.score;
  if (Number.isFinite(q) && q < 50 && level === 'high') level = 'medium';
  if (Number.isFinite(q) && q < 30) level = 'low';
  return { confidence: level, conf: round(c, 2) };
}
const frameLabel = (sport, set) => sport.frameLabels?.[set] || (set === 'guard' ? 'guard time' : 'the clip');
const rank = (c) => STATUS_ORDER[c.status] * 1000 + (c.status === 'fault' ? c.priority * 10 + (c.score ?? 0) * 9 : c.priority);

function runFrameCheck(chk, P, ctx, setName = 'guard') {
  const idx = ctx.frameSets[setName] || [];
  if (!idx.length) {
    const why = ctx.sport.noFramesReason?.(setName, ctx);
    return { status: 'no_events', reason: why || (ctx.isPhoto ? 'Photo shows a punch, not the guard' : 'No still guard moments found between punches') };
  }
  const fails = [], all = [];
  let checked = 0, unsure = 0, gone = 0;
  const judge = ctx.G.judge_min_conf ?? 0.6;
  for (const i of idx) {
    const p = ctx.poses[i];
    if (!p) continue;
    const conf = p.vis(...chk.needs);
    // below the visibility floor: hidden behind the body / tracked unsure (-> "not clear") vs simply out of the picture
    if (conf < ctx.G.min_visibility) { 
      const outside = chk.needs.some((n) => { const q = p.p2(n); return !q || q[0] < 0 || q[1] < 0 || q[0] > ctx.meta.width || q[1] > ctx.meta.height; });
      if (!outside && (ctx.frames[i]?.occluded?.length || conf >= 0.2)) unsure++; else gone++;
      continue;
    }
    const m = chk.measure(p, ctx, P);
    if (!m || !Number.isFinite(m.value)) continue;
    // a failing frame only counts if we're confident about the body parts it measured
    if (!m.pass && conf < judge) { unsure++; continue; }
    checked++; all.push(m.value);
    if (!m.pass) fails.push({ i, m, conf });
  }
  const minFrames = ctx.isPhoto ? 1 : Math.max(3, Math.round(idx.length * 0.15));
  if (checked < minFrames) return unsure > gone
    ? { status: 'unclear', reason: 'Not clear enough to judge: the body parts this needs were hidden or tracked unsure' }
    : { status: 'not_visible', reason: chk.visReason || 'Body parts needed for this check were not visible' };
  return { status: 'checked', checked, fails, all };
}

function groupEpisodes(fails, gap) {
  const eps = [];
  for (const f of fails) {
    const last = eps.at(-1);
    if (last && f.i - last.frames.at(-1).i <= gap) last.frames.push(f); else eps.push({ frames: [f] });
  }
  return eps;
}

/** Generic keyframes: split the clip into chunks and take the stillest posed frame of each
 * (held positions = clearest pictures for a coach to judge by eye). */
export function pickKeyframes(ctx, n = 6) {
  const { poses } = ctx;
  const N = poses.length;
  if (N === 1) return poses[0] ? [{ i: 0, label: 'Photo' }] : [];
  const motion = poses.map((p, i) => {
    const q = poses[i - 1] || poses[i + 1];
    if (!p || !q) return Infinity;
    let s = 0; for (let k = 11; k <= 28; k++) s += Math.hypot(p.raw.lm[k][0] - q.raw.lm[k][0], p.raw.lm[k][1] - q.raw.lm[k][1]);
    return s;
  });
  const out = [];
  for (let c = 0; c < n; c++) {
    const a = Math.floor((c * N) / n), b = Math.floor(((c + 1) * N) / n);
    let best = -1;
    for (let i = a; i < b; i++) if (poses[i] && (best < 0 || motion[i] < motion[best])) best = i;
    if (best >= 0) out.push({ i: best, label: `Moment ${out.length + 1}` });
  }
  return out;
}

function estimateFps(frames) {
  if (frames.length < 2) return 30;
  const dt = median(frames.slice(1).map((f, i) => f.t - frames[i].t));
  return dt > 0 ? 1 / dt : 30;
}
