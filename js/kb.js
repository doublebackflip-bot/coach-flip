// Knowledge-base helpers: turn an engine check result into coaching content
// (cue, why, drills with steps/dosage, pro tip, sources). Pure functions, no DOM.
export function indexKb(kbIn) {
  // one KB or several (e.g. kickboxing + boxing for the shared punch checks); the first is the main one
  const kbs = Array.isArray(kbIn) ? kbIn : [kbIn];
  const kb = kbs[0];
  const idx = { kb, kbs, skills: {}, checkpoints: {}, faults: {}, drills: {}, sources: {}, tipsBySkill: {}, skillOfCheckpoint: {}, allTips: [] };
  for (const k of kbs) for (const s of k.sources) idx.sources[s.id] ??= s;
  for (const sk of kbs.flatMap((k) => k.skills)) {
    idx.skills[sk.id] = sk;
    for (const c of sk.checkpoints) { idx.checkpoints[c.id] = c; idx.skillOfCheckpoint[c.id] = sk.id; }
    for (const f of sk.faults) idx.faults[f.id] = f;
    for (const d of sk.drills) idx.drills[d.id] = d;
    idx.tipsBySkill[sk.id] = sk.pro_tips || [];
    idx.allTips.push(...(sk.pro_tips || []).map((t) => ({ ...t, skill: sk.id })));
  }
  for (const k of kbs) idx.allTips.push(...(k.general_tips || []).filter((t) => t && t.tip));
  return idx;
}

/** coaching content for one check; usedTips avoids repeating the same pro tip */
export function coachingFor(check, kbx, chkDef, usedTips = new Set()) {
  const ref = check.kb || {};
  const cp = kbx.checkpoints[ref.checkpoint] || null;
  const fault = ref.fault ? kbx.faults[ref.fault] : null;
  const drillIds = [...new Set([...(fault?.drill_ids || []), ...(ref.drills || [])])];
  const drills = drillIds.map((id) => kbx.drills[id]).filter(Boolean);
  const srcIds = [...new Set([...(cp?.source_ids || []), ...(fault?.source_ids || [])])];
  // pro tip: prefer one sharing sources with this fault, not already shown
  const skillId = ref.skill || kbx.skillOfCheckpoint[ref.checkpoint];
  let tips = kbx.tipsBySkill[skillId] || [];
  if (!tips.length) tips = kbx.allTips.filter((t) => (t.source_ids || []).some((s) => srcIds.includes(s))).concat(kbx.allTips); // skill has none: borrow a related one
  const want = new Set(ref.tipSources || srcIds);
  let tip = tips.find((t) => !usedTips.has(t.tip) && (t.source_ids || []).some((s) => want.has(s))) || tips.find((t) => !usedTips.has(t.tip)) || tips[0] || null;
  if (tip) usedTips.add(tip.tip);
  const allSrc = [...new Set([...srcIds, ...drills.flatMap((d) => d.source_ids), ...(tip?.source_ids || [])])];
  return {
    faultName: fault?.name || check.label,
    goodForm: cp?.description || null,
    rule: cp?.measurable_angle_or_rule || null,
    kbThresholdConfidence: cp?.threshold_confidence || null,
    cue: chkDef?.coach?.cue || fault?.correction_cue || null,
    why: chkDef?.coach?.why || fault?.why_it_matters || (cp ? `Good form: ${cp.description}` : null),
    videoSigns: fault?.video_signs || null,
    drills, tip,
    sources: allSrc.map((id) => kbx.sources[id]).filter(Boolean),
  };
}
