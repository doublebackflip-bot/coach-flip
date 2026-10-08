// Coach Flip - phone-first form check. UI + flow. Everything runs on the phone; nothing is uploaded.
import { analyze, buildConfig } from './engine/core.js';
import { indexKb, coachingFor } from './kb.js';
import { SPORTS, sportEntry, loadSportModule } from './sports/registry.js';
import { trackVideo, trackImage, loadVideo, releaseVideo, scanPeople } from './pose.js';
import { canRecordInApp, cameraSupport, openCamera, startRecording, stopStream, isIOS } from './recorder.js';
import { renderFrame, sizeCanvas } from './render.js';
import { store, uid } from './store.js';
import { videoInfo, decideSlowmo } from './mp4info.js';

const $ = (s, el = document) => el.querySelector(s);
const $$ = (s, el = document) => [...el.querySelectorAll(s)];
const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);
const app = $('#app');
const fmtT = (t) => `${Math.floor(t / 60)}:${(t % 60).toFixed(1).padStart(4, '0')}`;
const fmtDate = (ms) => new Date(ms).toLocaleString([], { month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' });

const S = {
  sportId: 'boxing', sport: null, kbx: null, athletes: [], athleteId: null,
  skillId: 'jab', view: 'front', slowmo: 1,
  prefs: { fps: 20, model: 'full', maxSeconds: 20, keepVideos: true, prefsV: 2 },
  overrides: {}, player: null, abort: null,
};
window.__coach = S; // handy for debugging / automated tests
export const APP_VERSION = '0.4.0';
const isStandalone = () => window.matchMedia?.('(display-mode: standalone)').matches || navigator.standalone === true;

// ---------------------------------------------------------------- boot
async function boot() {
  if ('serviceWorker' in navigator && location.protocol !== 'file:') navigator.serviceWorker.register('sw.js').catch(() => {});
  const saved = await store.getSetting('prefs', {});
  // v0.4: the default pose model moved from lite to full (more accurate). Older saved prefs still say 'lite'
  // only because that was the default, so move them once; a later explicit choice is kept.
  if ((saved.prefsV || 1) < 2) { if (saved.model === 'lite') delete saved.model; saved.prefsV = 2; }
  S.prefs = { ...S.prefs, ...saved };
  await loadSport(await store.getSetting('lastSport', 'boxing'));
  S.athletes = (await store.athletes()).sort((a, b) => a.name.localeCompare(b.name));
  S.athleteId = await store.getSetting('lastAthlete', S.athletes[0]?.id ?? null);
  if (!S.athletes.some((a) => a.id === S.athleteId)) S.athleteId = S.athletes[0]?.id ?? null;
  if (window.caches) caches.keys().then((k) => { S.swVersion = k.filter((x) => x.startsWith('coachflip')).join(',') || null; }).catch(() => {});
  // if we come back from a picker / camera app and the page survived, forget the "picker open" marker
  const clearPending = () => setTimeout(() => store.setSetting('pendingPicker', null), 2000);
  document.addEventListener('visibilitychange', () => { if (document.visibilityState === 'visible') clearPending(); });
  const SRC = { 'pick-record': 'phone camera app', 'pick-video': 'upload', 'pick-photo': 'photo picker' };
  for (const [id, kind] of [['pick-record', 'video'], ['pick-video', 'video'], ['pick-photo', 'photo']]) {
    $('#' + id).addEventListener('change', (e) => {
      const f = e.target.files[0]; e.target.value = ''; store.setSetting('pendingPicker', null);
      if (f) runAnalysis(f, kind, { source: SRC[id] });
    });
    $('#' + id).addEventListener('cancel', () => store.setSetting('pendingPicker', null));
  }
  // Android can kill the page while the phone's camera app is open (low memory) and reload it, losing the clip.
  const pend = await store.getSetting('pendingPicker', null);
  await store.setSetting('pendingPicker', null);
  home();
  if (pend && Date.now() - pend.at < 10 * 60 * 1000 && pend.id === 'pick-record') {
    app.insertAdjacentHTML('afterbegin', `<div class="notes warn" id="reload-note">The app restarted while the camera app was open (the phone freed memory), so the clip was lost. Use the <b>Record video</b> button: it records inside the app, so this can't happen.</div>`);
  }
}

/** switch sport: rules module + its knowledge base(s) + this sport's saved choices */
const kbCache = {};
async function loadSport(id) {
  if (!sportEntry(id)?.ready) id = 'boxing';
  const entry = sportEntry(id);
  S.sport = await loadSportModule(id);
  S.sportId = id;
  const kbs = await Promise.all(entry.kbs.map(async (f) => (kbCache[f] ??= await (await fetch(f)).json())));
  S.kbx = indexKb(kbs);
  S.overrides = await store.getSetting('overrides:' + id, {});
  // boxing kept its old (un-prefixed) keys from v0.1
  S.skillId = await store.getSetting('lastSkill:' + id, id === 'boxing' ? await store.getSetting('lastSkill', 'jab') : S.sport.skills[0].id);
  if (!skillDef()) S.skillId = S.sport.skills[0].id;
  S.view = await store.getSetting('lastView:' + id, id === 'boxing' ? await store.getSetting('lastView', 'front') : (skillDef().view || S.sport.views[0].id));
  if (!S.sport.views.some((v) => v.id === S.view)) S.view = S.sport.views[0].id;
  S.slowmo = 1; // never sticky: slow-mo is a property of one uploaded clip, not of the sport
  await store.setSetting('lastSport', id);
}
/** the athlete's stance for this sport (boxing: v0.1 field) */
const stanceOf = (a, sportId = S.sportId) => {
  if (!S.sport.stances?.length) return null;
  const v = a?.stances?.[sportId] ?? (sportId === 'boxing' ? a?.stance : null);
  return S.sport.stances.some((s) => s.id === v) ? v : S.sport.stances[0].id;
};
const athlete = () => S.athletes.find((a) => a.id === S.athleteId) || null;
const skillDef = (id = S.skillId) => S.sport.skills.find((s) => s.id === id);
const kbSkill = (id = S.skillId) => S.kbx.skills[skillDef(id)?.kbSkill || skillDef(id)?.kbSkills?.[0]] || null;
const kbSkillsOf = (sd) => [...new Set([...(sd?.kbSkills || []), sd?.kbSkill].filter(Boolean))].map((id) => S.kbx.skills[id]).filter(Boolean);
const isChecklist = (sd) => sd?.mode === 'checklist';
const analysisFps = (sd) => Math.min(30, Math.max(S.prefs.fps, sd?.minFps || 0));

// ---------------------------------------------------------------- home
async function home() {
  stopPlayer();
  const a = athlete();
  const recent = a ? (await store.sessions(a.id)).sort((x, y) => y.createdAt - x.createdAt).slice(0, 4) : [];
  const sk = skillDef(), kbs = kbSkill();
  const views = S.sport.views;
  const tips = sk?.filming?.length ? sk.filming : S.sport.filmingTips;
  const vHint = views.find((v) => v.id === S.view)?.hint;
  window.scrollTo(0, 0); app.innerHTML = `
  <header class="top"><div><h1>Coach Flip</h1><div class="sub">Film it. See it. Fix it.</div></div>
    <button class="icon-btn" id="go-settings" aria-label="Settings">⚙</button></header>

  <h2 style="margin-top:4px">Sport</h2>
  <div class="chips sports" role="group" aria-label="Sport">${SPORTS.filter((s) => s.ready).map((s) => `<button class="chip ${s.id === S.sportId ? 'on' : ''}" data-sport="${s.id}" aria-pressed="${s.id === S.sportId}">${s.icon || ''} ${esc(s.name)}</button>`).join('')}</div>

  <section class="card">
    <label class="field" for="athlete">Athlete</label>
    <div class="row">
      <select id="athlete">${S.athletes.length ? S.athletes.map((x) => `<option value="${esc(x.id)}" ${x.id === S.athleteId ? 'selected' : ''}>${esc(x.name)}</option>`).join('') : '<option value="">No athletes yet</option>'}</select>
      <button class="btn" id="add-athlete" style="flex:0 0 auto">+ Add</button>
    </div>
    <form id="new-athlete" hidden class="row" style="margin-top:8px">
      <input type="text" id="new-name" placeholder="Athlete's name" autocomplete="off" maxlength="40" />
      <button class="btn" style="flex:0 0 auto">Save</button>
    </form>
    ${a && S.sport.stances?.length ? `<label class="field">${esc(S.sport.stanceLabel || 'Stance')}</label>
    <div class="seg two">${S.sport.stances.map((s) => `<button class="opt" data-stance="${s.id}" aria-pressed="${stanceOf(a) === s.id}">${esc(s.label)}<small>${esc(s.hint)}</small></button>`).join('')}</div>` : ''}
  </section>

  <h2>What are we checking?</h2>
  <div class="seg">${S.sport.skills.map((s) => `<button class="opt" data-skill="${s.id}" aria-pressed="${s.id === S.skillId}">${esc(s.label)}${isChecklist(s) ? ' <span class="cl">CHECKLIST</span>' : s.beta ? ' <span class="beta">BETA</span>' : ''}</button>`).join('')}</div>
  ${isChecklist(sk) ? `<p class="hint">Coach checklist: the app tracks the skeleton and picks key moments; you tick the expert checkpoints by eye. ${esc(sk.checklistWhy || '')}</p>` : ''}

  <h2>Camera view</h2>
  <div class="seg ${views.length === 2 ? 'two' : views.length === 3 ? 'three' : ''}">${views.map((v) => `<button class="opt" data-view="${v.id}" aria-pressed="${v.id === S.view}">${esc(v.label)}<small>${esc(v.hint)}</small></button>`).join('')}</div>

  <div class="tip"><b>How to film${sk ? ' the ' + esc(sk.label.toLowerCase()) : ''}:</b>
    <ul>${tips.map((t) => `<li>${esc(t)}</li>`).join('')}
    ${kbs?.recommended_camera ? `<li><b>Expert setup:</b> ${esc(kbs.recommended_camera)}</li>` : ''}
    ${vHint ? `<li><b>${esc(views.find((v) => v.id === S.view).label)} view:</b> ${esc(vHint)}.</li>` : ''}
    ${sk?.view && sk.view !== S.view ? `<li><b>Tip:</b> this skill is best filmed from the ${esc(sk.view)}.</li>` : ''}</ul></div>

  <label class="field">Uploading a slow-motion video?</label>
  <div class="seg three slowmo">${[[1, 'Normal', '24-60 fps'], [4, 'Slow-mo 4x', '120 fps'], [8, 'Slow-mo 8x', '240 fps']].map(([v, l, h]) => `<button class="opt" data-slowmo="${v}" aria-pressed="${S.slowmo === v}">${l}<small>${h}</small></button>`).join('')}</div>
  <p class="hint">Only for an uploaded clip that plays back slowed down. Videos recorded with the Record button are always treated as normal speed, and real high-speed files (120/240 fps) are detected automatically. Resets after each analysis.</p>

  <button class="big primary" id="rec"><span class="em">🎥</span> Record video</button>
  <p class="hint center"><a href="#" id="rec-native">Use the phone's camera app instead</a></p>
  <button class="big" id="upl"><span class="em">🎞️</span> Upload a video</button>
  <button class="big" id="pho"><span class="em">📷</span> Photo / screenshot</button>

  ${recent.length ? `<h2>Recent for ${esc(a.name)}</h2><ul class="list">${recent.map(sessionRow).join('')}</ul>
    <button class="btn" id="go-history" style="width:100%;margin-top:8px">All sessions</button>` : ''}
  <p class="foot">Runs on this phone: video never leaves the device. Checks marked <span class="beta">BETA</span> use estimated thresholds and need calibrating against your own athletes.</p>`;

  $('#go-settings').onclick = settings;
  $('#athlete').onchange = async (e) => { S.athleteId = e.target.value; await store.setSetting('lastAthlete', S.athleteId); home(); };
  $('#add-athlete').onclick = () => { $('#new-athlete').hidden = false; $('#new-name').focus(); };
  $('#new-athlete').onsubmit = async (e) => { e.preventDefault(); const n = $('#new-name').value.trim(); if (n) { await addAthlete(n); home(); } };
  $$('[data-sport]').forEach((b) => (b.onclick = async () => { if (b.dataset.sport !== S.sportId) { await loadSport(b.dataset.sport); home(); } }));
  $$('[data-stance]').forEach((b) => (b.onclick = async () => {
    const x = athlete(); x.stances = { ...(x.stances || {}), [S.sportId]: b.dataset.stance };
    if (S.sportId === 'boxing') x.stance = b.dataset.stance;
    await store.putAthlete(x); home();
  }));
  $$('[data-skill]').forEach((b) => (b.onclick = async () => {
    S.skillId = b.dataset.skill; await store.setSetting('lastSkill:' + S.sportId, S.skillId);
    const v = skillDef().view; if (v && S.sport.views.some((x) => x.id === v)) { S.view = v; await store.setSetting('lastView:' + S.sportId, v); }
    home();
  }));
  $$('[data-view]').forEach((b) => (b.onclick = async () => { S.view = b.dataset.view; await store.setSetting('lastView:' + S.sportId, S.view); home(); }));
  $$('[data-slowmo]').forEach((b) => (b.onclick = async () => { S.slowmo = +b.dataset.slowmo; home(); }));
  $('#rec').onclick = () => (canRecordInApp() ? recorder() : openPicker('pick-record'));
  $('#rec-native').onclick = (e) => { e.preventDefault(); openPicker('pick-record'); };
  $('#upl').onclick = () => openPicker('pick-video');
  $('#pho').onclick = () => openPicker('pick-photo');
  $('#go-history')?.addEventListener('click', history);
  bindSessionRows();
}

async function addAthlete(name) {
  const a = { id: uid(), name, stance: 'orthodox', stances: {}, createdAt: Date.now() };
  await store.putAthlete(a);
  S.athletes.push(a); S.athletes.sort((x, y) => x.name.localeCompare(y.name));
  S.athleteId = a.id; await store.setSetting('lastAthlete', a.id);
  return a;
}

function sessionRow(x) {
  const faults = x.result.checks.filter((c) => c.status === 'fault').length;
  return `<li data-session="${esc(x.id)}"><img alt="" src="${x.thumb || 'icons/icon-192.png'}" />
    <div class="grow"><b>${x.sport && x.sport !== S.sportId ? esc(sportEntry(x.sport)?.name || x.sport) + ': ' : ''}${esc(x.skillLabel || (x.sport === S.sportId || !x.sport ? skillDef(x.skillId)?.label : null) || x.skillId)} · ${esc(x.view)}</b>
    <span class="hint">${fmtDate(x.createdAt)} · ${x.result.mode === 'checklist' ? 'coach checklist' : faults ? `<span style="color:var(--fault)">${faults} to fix</span>` : '<span style="color:var(--good)">looks good</span>'}</span></div>
    <button class="btn small">Open</button></li>`;
}
function bindSessionRows() {
  $$('[data-session]').forEach((li) => (li.onclick = async () => openSession(await store.session(li.dataset.session))));
}

// ---------------------------------------------------------------- pickers, recorder, errors
function openPicker(id) {
  store.setSetting('pendingPicker', { id, at: Date.now() });
  $('#' + id).click();
}

/** environment info for the "Debug info" box (so a coach can screenshot it for support) */
function baseDebug(extra = {}) {
  const sup = cameraSupport();
  return { app: APP_VERSION, sw: S.swVersion || null, ua: navigator.userAgent, standalone: isStandalone(), ios: isIOS(),
    screen: `${screen.width}x${screen.height}@${devicePixelRatio}`, secureContext: sup.secureContext, getUserMedia: sup.getUserMedia,
    mediaRecorder: sup.mediaRecorder, recorderMime: sup.mime, sport: S.sportId, skill: S.skillId, view: S.view, ...extra };
}
function errorScreen(title, message, debug, { retry } = {}) {
  stopCamera(); stopPlayer();
  window.scrollTo(0, 0); app.innerHTML = `<header class="top"><h1>${esc(title)}</h1></header>
    <p class="notes bad" id="err-msg">${esc(message)}</p>
    ${retry ? '<button class="big primary" id="err-retry">Try again</button>' : ''}
    <button class="big" id="err-native"><span class="em">📱</span> Use the phone's camera app</button>
    <button class="big" id="err-upload"><span class="em">🎞️</span> Upload a video</button>
    <button class="btn" id="back" style="width:100%">Back to start</button>
    <details class="debug" id="debug"><summary>Debug info (screenshot this for support)</summary><pre>${esc(JSON.stringify(debug, null, 1))}</pre></details>`;
  $('#back').onclick = home;
  $('#err-native').onclick = () => openPicker('pick-record');
  $('#err-upload').onclick = () => openPicker('pick-video');
  if (retry) $('#err-retry').onclick = retry;
  console.warn('Coach Flip error', title, message, debug);
}

function stopCamera() {
  if (S.cam) { try { S.cam.rec?.stop(); } catch (_) { /* ignore */ } stopStream(S.cam.stream); clearInterval(S.cam.timer); S.cam = null; }
}

// ---------------------------------------------------------------- in-app recorder
async function recorder(facing = S.prefs.facing || 'environment') {
  stopPlayer(); stopCamera();
  if (!athlete()) await addAthlete('My athlete');
  const sk = skillDef(), maxS = S.prefs.maxSeconds || 20;
  window.scrollTo(0, 0); app.innerHTML = `<header class="top"><button class="icon-btn" id="back" aria-label="Back">←</button>
    <div style="flex:1"><h1 style="font-size:1.25rem">Record · ${esc(sk.label)}</h1><div class="sub">${esc(S.sport.name)} · ${esc(athlete().name)} · ${esc(S.view)} view</div></div></header>
  <div class="rec-stage" id="rc-stage"><video id="rc-prev" playsinline webkit-playsinline muted autoplay></video>
    <div class="rec-badge" id="rc-badge">Starting camera…</div>
    <div class="rec-bar"><div id="rc-bar"></div></div></div>
  <p class="hint" id="rc-tip">Whole body in frame, head to feet. Phone still (lean it on something). Up to ${maxS} s; it stops by itself.</p>
  <button class="big primary rec-btn" id="rc-go" disabled><span class="em">⏺</span> Start recording</button>
  <div class="row" style="margin-top:8px"><button class="btn" id="rc-flip">🔄 Flip camera</button><button class="btn" id="rc-native">📱 Phone camera app</button></div>
  <button class="btn" id="rc-upload" style="width:100%;margin-top:8px">🎞️ Upload a video instead</button>`;
  $('#back').onclick = () => { stopCamera(); home(); };
  $('#rc-native').onclick = () => { stopCamera(); openPicker('pick-record'); };
  $('#rc-upload').onclick = () => { stopCamera(); openPicker('pick-video'); };
  $('#rc-flip').onclick = async () => { const f = facing === 'environment' ? 'user' : 'environment'; S.prefs.facing = f; recorder(f); };
  const dbg = baseDebug({ path: 'in-app recorder', facing });
  let stream;
  try { stream = await openCamera(facing); }
  catch (e) { errorScreen('Camera not available', e.message, { ...dbg, stage: 'getUserMedia', kind: e.kind, ...e.details }, { retry: () => recorder(facing) }); return; }
  if (!$('#rc-prev')) { stopStream(stream); return; } // user left meanwhile
  S.cam = { stream };
  const v = $('#rc-prev'); v.muted = true; v.srcObject = stream;
  try { await v.play(); } catch (_) { /* autoplay with a camera stream is allowed; ignore */ }
  const st = stream.getVideoTracks()[0]?.getSettings?.() || {};
  dbg.camera = { width: st.width, height: st.height, frameRate: st.frameRate, facingMode: st.facingMode, label: stream.getVideoTracks()[0]?.label };
  $('#rc-badge').textContent = `Ready · ${st.width || '?'}x${st.height || '?'}${st.frameRate ? ' · ' + Math.round(st.frameRate) + ' fps' : ''}`;
  const go = $('#rc-go'); go.disabled = false;
  go.onclick = () => {
    if (S.cam?.rec) { S.cam.rec.stop(); return; }
    let ctl;
    try {
      ctl = startRecording(stream, { maxSeconds: maxS, onTick: (t) => {
        const b = $('#rc-badge'); if (b) b.textContent = `● REC ${t.toFixed(1)} s · ${Math.max(0, maxS - t).toFixed(0)} s left`;
        const bar = $('#rc-bar'); if (bar) bar.style.width = `${Math.min(100, (100 * t) / maxS)}%`;
      } });
    } catch (e) { errorScreen('Recording not supported', e.message, { ...dbg, stage: 'MediaRecorder', ...e.details }); return; }
    S.cam.rec = ctl; dbg.recorderMime = ctl.mime;
    $('#rc-stage').classList.add('recording');
    go.innerHTML = '<span class="em">⏹</span> Stop'; go.classList.add('stop');
    $('#rc-flip').disabled = true;
    ctl.done.then(({ file, seconds, mime }) => {
      stopCamera();
      runAnalysis(file, 'video', { source: 'in-app recorder', durationHint: seconds, mime, camera: dbg.camera });
    }).catch((e) => errorScreen('Recording failed', e.message, { ...dbg, stage: 'recording', ...(e.details || { error: String(e) }) }, { retry: () => recorder(facing) }));
  };
}

// ---------------------------------------------------------------- analysis
function progressScreen(a) {
  window.scrollTo(0, 0); app.innerHTML = `<header class="top"><h1>Checking…</h1></header>
    <p class="summary">${esc(skillDef().label)} · ${esc(a.name)}</p>
    <p class="hint" id="stage">Loading the pose tracker (first time can take a few seconds)…</p>
    <div class="progress"><div id="bar"></div></div>
    <p class="hint" id="count"></p>
    <button class="big" id="cancel">Cancel</button>`;
  $('#cancel').onclick = () => { S.abort?.abort(); home(); };
}

/** "Tap your athlete": one frame with everyone outlined. Resolves {box, t} | null (auto) | 'cancel'. */
function pickAthleteScreen(scan, a) {
  return new Promise((resolve) => {
    const { canvas: src, people, t } = scan;
    S.scan = { t, people: people.map((p) => p.box) }; // for automated tests
    window.scrollTo(0, 0); app.innerHTML = `<header class="top"><h1>Who is ${esc(a.name)}?</h1></header>
      <p class="hint">${people.length} people in the picture. Tap the athlete so the app follows only them (coach, sparring partner and people in the background are ignored).</p>
      <div class="player picker"><canvas id="pk" aria-label="Video frame with the people outlined"></canvas></div>
      <div class="chips" id="pk-list">${people.map((p, i) => `<button class="chip" data-pk="${i}">${i + 1}${i === 0 ? '' : ''}</button>`).join('')}</div>
      <button class="big primary" id="pk-go" disabled>Track the athlete I tapped</button>
      <button class="big" id="pk-auto">Skip: pick the biggest, most central person</button>
      <button class="btn" id="pk-cancel" style="width:100%">Cancel</button>`;
    const cv = $('#pk'); cv.width = src.width; cv.height = src.height;
    const g = cv.getContext('2d');
    let sel = -1;
    const draw = () => {
      g.drawImage(src, 0, 0);
      people.forEach((p, i) => {
        const b = p.box, x = b.x0 * cv.width, y = b.y0 * cv.height, w = b.w * cv.width, h = b.h * cv.height;
        const pad = 0.06 * h;
        g.lineWidth = Math.max(3, cv.width / 200);
        g.strokeStyle = i === sel ? '#3ddc84' : 'rgba(255,255,255,0.9)';
        g.setLineDash(i === sel ? [] : [10, 6]);
        g.strokeRect(x - pad, y - pad, w + 2 * pad, h + 2 * pad);
        g.setLineDash([]);
        const r = Math.max(16, cv.width / 40);
        g.fillStyle = i === sel ? '#3ddc84' : 'rgba(0,0,0,0.7)';
        g.beginPath(); g.arc(x + w / 2, y - pad - r * 1.1, r, 0, 2 * Math.PI); g.fill();
        g.fillStyle = '#fff'; g.font = `bold ${Math.round(r * 1.2)}px system-ui,sans-serif`; g.textAlign = 'center'; g.textBaseline = 'middle';
        g.fillText(String(i + 1), x + w / 2, y - pad - r * 1.1);
      });
    };
    const choose = (i) => { sel = i; draw(); $('#pk-go').disabled = sel < 0; $$('[data-pk]').forEach((b) => b.classList.toggle('on', +b.dataset.pk === sel)); };
    cv.addEventListener('click', (ev) => {
      const r = cv.getBoundingClientRect(), x = (ev.clientX - r.left) / r.width, y = (ev.clientY - r.top) / r.height;
      let best = -1, bd = Infinity;
      people.forEach((p, i) => { const b = p.box, pad = 0.06 * b.h; const inside = x >= b.x0 - pad && x <= b.x1 + pad && y >= b.y0 - pad && y <= b.y1 + pad;
        const d = Math.hypot(x - b.cx, y - b.cy) + (inside ? -10 + b.w * b.h : 0); if (d < bd) { bd = d; best = i; } });
      choose(best);
    });
    $$('[data-pk]').forEach((b) => (b.onclick = () => choose(+b.dataset.pk)));
    $('#pk-go').onclick = () => resolve(sel >= 0 ? { box: people[sel].box, t } : null);
    $('#pk-auto').onclick = () => resolve(null);
    $('#pk-cancel').onclick = () => resolve('cancel');
    draw();
  });
}

async function runAnalysis(file, kind, extra = {}) {
  stopPlayer(); stopCamera();
  if (!athlete()) await addAthlete('My athlete');
  const a = athlete();
  const isPhoto = kind === 'photo';
  const debug = baseDebug({ path: extra.source || (isPhoto ? 'photo picker' : 'upload'), file: { name: file.name, type: file.type || '(none)', size: file.size },
    durationHint: extra.durationHint ?? null, recorderMime: extra.mime ?? cameraSupport().mime, camera: extra.camera });
  if (!isPhoto && file.type && !file.type.startsWith('video/')) {
    errorScreen("That isn't a video", `The file picked is "${file.type}". Pick a video file, or use Photo / screenshot for pictures.`, { ...debug, stage: 'file-type' }); return;
  }
  const url = URL.createObjectURL(file);
  S.abort = new AbortController();
  progressScreen(a);
  try {
    const fileInfo = isPhoto ? null : await videoInfo(file);
    debug.fileInfo = fileInfo;
    const opts = { model: S.prefs.model };
    debug.stage = isPhoto ? 'track-image' : 'track-video';
    // several people in the picture (coach, other boxers): let the coach tap the athlete once
    let athletePick = null;
    if (!isPhoto) {
      debug.stage = 'scan-people';
      $('#stage') && ($('#stage').textContent = 'Looking for the athlete…');
      try {
        const scan = await scanPeople(url, { model: S.prefs.model, durationHint: extra.durationHint });
        debug.people = scan?.people?.length ?? 0;
        if (scan?.people?.length >= 2) athletePick = await pickAthleteScreen(scan, a);
        if (athletePick === 'cancel') { URL.revokeObjectURL(url); home(); return; }
        progressScreen(a);
      } catch (e) { console.warn('people scan failed', e); debug.scanError = String(e.message || e); }
      debug.stage = 'track-video';
    }
    const track = isPhoto ? await trackImage(url, opts) : await trackVideo(url, {
      ...opts, athlete: athletePick || null, fps: analysisFps(skillDef()), maxSeconds: S.prefs.maxSeconds, signal: S.abort.signal, durationHint: extra.durationHint, debug,
      onProgress: (p, k, n) => { $('#bar') && ($('#bar').style.width = `${Math.round(p * 100)}%`); $('#stage') && ($('#stage').textContent = 'Tracking joints frame by frame…'); $('#count') && ($('#count').textContent = `${k} / ${n} frames`); },
    });
    debug.stage = 'analyze';
    $('#stage') && ($('#stage').textContent = 'Comparing with the expert checklist…');
    const stance = stanceOf(a);
    const sm = isPhoto ? { slowmo: 1, note: null } : decideSlowmo({ source: debug.path, chosen: S.slowmo, fileFps: fileInfo?.fps });
    const slowmo = sm.slowmo; S.slowmo = 1;
    debug.slowmo = slowmo;
    const result = analyze(track, { sport: S.sport, skillId: S.skillId, view: S.view, stance, overrides: S.overrides, isPhoto, slowmo });
    if (sm.note) result.notes.push(sm.note);
    if (isPhoto && result.events.length && S.sportId === 'boxing') result.notes.push('Extension is judged as if this photo is the moment of impact.');
    if (track.meta.truncated) result.notes.push(`Only the first ${S.prefs.maxSeconds} s were analysed (change in Settings).`);
    if (!isPhoto && !track.frames.some((f) => f.lm)) result.notes.push('No athlete was found in any frame. Film the whole body, well lit, from 3-5 m away.');
    const session = {
      id: uid(), athleteId: a.id, athleteName: a.name, createdAt: Date.now(), sport: S.sportId,
      skillId: S.skillId, skillLabel: skillDef().label, view: S.view, stance, slowmo, isPhoto, checklist: {},
      mediaType: file.type, fileName: file.name, source: debug.path, track, result, hasMedia: !!S.prefs.keepVideos,
    };
    debug.stage = 'save';
    if (S.prefs.keepVideos) {
      // a long 4K clip can exceed the phone's storage quota: keep the results, drop the video
      try { await store.putMedia(session.id, file, file.type); }
      catch (e) { session.hasMedia = false; result.notes.push("The video was too big to keep on this phone; the results are saved."); console.warn('putMedia failed', e); }
    }
    await store.putSession(session);
    await openSession(session, url);
  } catch (e) {
    if (e.name === 'AbortError') return;
    (e.name === 'VideoError' ? console.warn : console.error)(e);
    URL.revokeObjectURL(url);
    errorScreen(e.name === 'VideoError' ? "Couldn't read this video" : 'Something went wrong',
      e.name === 'VideoError' ? e.message : `${e.message || e}. Try a shorter clip (5-10 s) with the whole body in frame, or the in-app Record button.`,
      { ...debug, error: `${e.name}: ${e.message}`, ...(e.details || {}) });
  }
}

// ---------------------------------------------------------------- results
async function openSession(session, url = null) {
  stopPlayer();
  if ((session.sport || 'boxing') !== S.sportId) await loadSport(session.sport || 'boxing');
  if (!url && session.hasMedia) {
    const m = await store.media(session.id);
    if (m?.blob) url = URL.createObjectURL(m.blob);
  }
  S.current = session;
  const r = session.result;
  const faults = r.checks.filter((c) => c.status === 'fault');
  const oks = r.checks.filter((c) => c.status === 'ok');
  const unclear = r.checks.filter((c) => c.status === 'unclear');
  const skipped = r.checks.filter((c) => !['fault', 'ok', 'unclear'].includes(c.status));
  const used = new Set();
  const chkDefs = Object.fromEntries(S.sport.checks.map((c) => [c.id, c]));
  const sd = skillDef(session.skillId);
  const groups = sd?.checks || [];
  // events counted only for types some check of this skill uses (e.g. jabs for "Jab")
  const usedTypes = new Set(S.sport.checks.filter((c) => groups.includes(c.group) && c.scope.startsWith('event:')).flatMap((c) => c.scope.slice(6).split('|')));
  const evCount = {}; for (const e of r.events) if (usedTypes.has(e.type)) evCount[e.type] = (evCount[e.type] || 0) + 1;
  const evText = Object.entries(evCount).map(([t, n]) => `${n} ${S.sport.eventLabel(t)}`).join(', ');
  const checklistMode = r.mode === 'checklist';
  const kf = (r.keyframes || []).filter((k, i, arr) => arr.findIndex((x) => x.t === k.t) === i);
  session.checklist ??= {};

  window.scrollTo(0, 0); app.innerHTML = `
  <header class="top"><button class="icon-btn" id="back" aria-label="Back">←</button>
    <div style="flex:1"><h1 style="font-size:1.25rem">${esc(skillDef(session.skillId)?.label)} · ${esc(session.view)} view</h1>
    <div class="sub">${esc(S.sport.name)} · ${esc(session.athleteName)}${session.stance ? ' · ' + esc(session.stance) : ''}${session.slowmo > 1 ? ` · slow-mo ${session.slowmo}x` : ''} · ${fmtDate(session.createdAt)}</div></div></header>

  ${url ? `<div class="player"><canvas id="cv"></canvas></div>
  <div class="caption" id="cap"></div>
  ${kf.length > 1 && !session.isPhoto ? `<div class="chips keys" id="keys" aria-label="Key moments">${kf.map((k) => `<button class="chip" data-key="${k.t}">${esc(k.label)}</button>`).join('')}</div>` : ''}
  ${faults.length ? `<div class="chips focus" id="focus">${faults.map((c, i) => `<button class="chip" data-focus="${esc(c.id)}">${i + 1}. ${esc(c.label)}</button>`).join('')}<button class="chip" data-focus="">All</button></div>` : ''}
  ${session.isPhoto ? '' : `<div class="timeline" id="tl" aria-label="Timeline: red = problem frames"></div>
  <div class="controls"><button class="btn" id="prev" aria-label="Previous frame">◀︎ frame</button><button class="btn" id="play">▶ Play</button><button class="btn" id="next" aria-label="Next frame">frame ▶︎</button></div>
  <div class="speeds">${[0.25, 0.5, 1].map((s) => `<button class="opt" data-speed="${s}" aria-pressed="${s === 0.5}">${s === 1 ? '1x' : s === 0.5 ? '½ speed' : '¼ speed'}</button>`).join('')}
    <button class="opt" id="skel" aria-pressed="true">Skeleton</button>${session.track?.raw ? '<button class="opt" id="rawsk" aria-pressed="false" title="Show the tracker\'s raw output instead of the cleaned skeleton">Raw view</button>' : ''}</div>`}` : '<p class="notes">Video was not saved for this session (Settings → keep videos). Results below.</p>'}

  ${checklistMode ? `<p class="summary">Coach checklist</p><p class="hint">Automatic checks aren't reliable for this skill from one phone camera${sd?.checklistWhy ? ` (${esc(sd.checklistWhy)})` : ''}. Step through the key moments above with the skeleton on, and tick each point below.</p>`
    : `<p class="summary ${faults.length ? 'bad' : 'good'}">${faults.length ? `${faults.length} thing${faults.length > 1 ? 's' : ''} to fix${faults.length > 3 ? ' (top 3 first)' : ''}` : (oks.length ? 'Looks good!' : 'Not enough to check')}</p>`}
  <p class="hint">${session.isPhoto ? 'Photo' : `Checked ${r.meta.frames} frames (${(r.meta.frames / r.meta.fps).toFixed(1)} s)`}; athlete found in ${Math.round((100 * r.meta.posed) / Math.max(1, r.meta.frames))}%. ${evText ? 'Found: ' + evText + '.' : ''}</p>
  ${qualityHtml(session)}
  ${r.notes.length ? `<div class="notes">${r.notes.map(esc).join('<br>')}</div>` : ''}
  ${oks.length ? `<h2>Looks good</h2><div class="chips">${oks.map((c) => `<span class="chip good">✓ ${esc(c.okLabel)}${c.failed ? ` <span class="hint">(${esc(c.summary)})</span>` : ''}</span>`).join('')}</div>` : ''}

  ${faults.length ? `<h2>${faults.length > 3 ? 'Start with these 3' : 'Fix these'} (most important first)</h2>` : ''}
  ${faults.slice(0, 3).map((c, i) => faultCard(c, i, coachingFor(c, S.kbx, chkDefs[c.id], used))).join('')}
  ${faults.length > 3 ? `<details class="more"><summary>${faults.length - 3} more to work on later</summary>
    ${faults.slice(3).map((c, i) => faultCard(c, i + 3, coachingFor(c, S.kbx, chkDefs[c.id], used))).join('')}</details>` : ''}

  ${checklistHtml(session, sd, r)}
  ${unclear.length ? `<details ${unclear.length >= 3 ? 'open' : ''}><summary>Not clear enough to judge (${unclear.length})</summary><p class="hint">The body parts these need were hidden, guessed by the tracker, or the camera angle doesn't show them. No verdict rather than a wrong one.</p><ul>${unclear.map((c) => `<li><b>${esc(c.okLabel)}</b>: ${esc(c.reason || '')}</li>`).join('')}</ul></details>` : ''}
  ${skipped.length ? `<details><summary>Not checked this time (${skipped.length})</summary><ul>${skipped.map((c) => `<li><b>${esc(c.okLabel)}</b>: ${esc(c.reason || c.status)}</li>`).join('')}</ul></details>` : ''}

  <button class="big primary" id="again">🎥 Film another</button>
  <div class="row"><button class="btn" id="recheck">Re-check with current settings</button><button class="btn danger" id="del" style="flex:0 0 auto">Delete</button></div>
  <p class="foot">Engine ${esc(r.engine_version)} · KB ${esc(S.kbx.kb.kb_version)} (${esc(S.kbx.kb.generated_on)}) · ${esc(session.track.meta.model)} on ${esc(session.track.meta.delegate || '')}. Lines and angles are estimates from one camera.</p>`;

  $('#back').onclick = home;
  $('#again').onclick = home;
  $('#del').onclick = async () => { if (confirm('Delete this session?')) { await store.deleteSession(session.id); home(); } };
  $('#recheck').onclick = async () => {
    const a = S.athletes.find((x) => x.id === session.athleteId);
    const stance = a ? stanceOf(a) : session.stance;
    session.result = analyze(session.track, { sport: S.sport, skillId: session.skillId, view: session.view, stance, overrides: S.overrides, isPhoto: session.isPhoto, slowmo: /in-app|camera app/.test(session.source || '') ? 1 : session.slowmo || 1 });
    session.stance = stance; session.thumb = null;
    await store.putSession(session); openSession(session, url);
  };
  $$('[data-seek]').forEach((b) => (b.onclick = () => { S.player?.focus(b.closest('.fault')?.dataset.check ?? null); S.player?.seek(+b.dataset.seek); $('.player')?.scrollIntoView({ behavior: 'smooth', block: 'start' }); }));
  $$('[data-key]').forEach((b) => (b.onclick = () => { S.player?.seek(+b.dataset.key); $$('[data-key]').forEach((x) => x.classList.toggle('on', x === b)); }));
  $$('[data-tick]').forEach((b) => (b.onclick = async () => {
    const [id, val] = b.dataset.tick.split('|');
    session.checklist[id] = session.checklist[id] === val ? undefined : val;
    $$(`[data-tick^="${CSS.escape(id)}|"]`).forEach((x) => x.setAttribute('aria-pressed', session.checklist[id] === x.dataset.tick.split('|')[1]));
    const n = Object.values(session.checklist).filter(Boolean).length; const c = $('#cl-count'); if (c) c.textContent = n;
    await store.putSession(session);
  }));
  $$('[data-focus]').forEach((b) => (b.onclick = () => { S.player?.focus(b.dataset.focus || null); const c = r.checks.find((x) => x.id === b.dataset.focus); if (c?.instances?.length) S.player?.seek(c.instances[0].t); }));
  if (url) {
    // replay is a bonus: if this phone can't reopen the clip, still show the full results
    try { await startPlayer(session, url); }
    catch (e) {
      console.warn('player failed', e); stopPlayer();
      $('#cv')?.insertAdjacentHTML('beforebegin', `<p class="notes" id="player-note">Video replay isn't available for this clip on this phone (${esc(e.message || e)}). The results below are complete.</p>`);
    }
  }
}

/** "Tracking quality" card: how well the app could follow the athlete in this clip, with filming tips */
function qualityHtml(session) {
  const q = session.track?.quality || session.track?.meta?.quality;
  if (!q || session.isPhoto) return '';
  const label = q.level === 'good' ? 'Good' : q.level === 'ok' ? 'OK' : 'Low';
  const tips = q.tips || [];
  return `<div class="quality ${esc(q.level)}" id="quality"><div class="qhead"><span class="qscore">${q.score}</span><div><b>Tracking quality: ${label}</b>
    <div class="hint">Athlete tracked in ${Math.round(100 * q.coverage)}% of the clip · joint confidence ${Math.round(100 * q.vis)}%${q.people > 1 ? ` · ${q.people} people in view (others ignored)` : ''}</div></div></div>
    ${q.level !== 'good' && tips.length ? `<p class="hint"><b>For a more reliable check next time:</b></p><ul>${tips.map((t) => `<li>${esc(t)}</li>`).join('')}</ul>` : ''}
    ${q.level === 'low' ? '<p class="hint">Results below are less certain; checks the app could not see well are listed as "not clear".</p>' : ''}</div>`;
}

const drillHtml = (d) => `<div class="drill"><h4>Drill: ${esc(d.name)}</h4>
      <p><b>Setup:</b> ${esc(d.setup)}</p><ol>${(d.steps || []).map((s) => `<li>${esc(s)}</li>`).join('')}</ol>
      <p><b>Dose:</b> ${esc(d.dosage)}</p><p><b>Why it works:</b> ${esc(d.why)}</p></div>`;

/** Coach checklist: the KB checkpoints and faults for this skill, ticked by the coach.
 * In auto mode only what the automatic checks did NOT cover is listed for ticking. */
function checklistHtml(session, sd, r) {
  const skills = kbSkillsOf(sd);
  if (!skills.length) return '';
  const auto = r.mode !== 'checklist';
  const covered = new Set(r.checks.filter((c) => ['ok', 'fault'].includes(c.status)).flatMap((c) => [c.kb?.checkpoint, c.kb?.fault]).filter(Boolean));
  const st = session.checklist || {};
  const tick = (id) => `<span class="ticks"><button class="opt yes" data-tick="${esc(id)}|yes" aria-pressed="${st[id] === 'yes'}" aria-label="Looks right">✓</button><button class="opt no" data-tick="${esc(id)}|no" aria-pressed="${st[id] === 'no'}" aria-label="Needs work">✗</button></span>`;
  let n = 0;
  const body = skills.map((k) => {
    const cps = k.checkpoints.filter((c) => !auto || !covered.has(c.id));
    const fs = (k.faults || []).filter((f) => !auto || !covered.has(f.id));
    if (!cps.length && !fs.length) return '';
    n += cps.length + fs.length;
    const tip = (k.pro_tips || [])[0];
    return `<div class="clskill"><h3>${esc(k.name)}</h3>
      ${cps.length ? `<p class="hint">Good form: tick ✓ if you see it, ✗ if it needs work.</p><ul class="cl">${cps.map((c) => `<li>${tick(c.id)}<span>${esc(c.description)}${c.camera_view ? ` <span class="hint">(${esc(c.camera_view)} view)</span>` : ''}</span></li>`).join('')}</ul>` : ''}
      ${fs.length ? `<p class="hint">Common faults: tick ✗ if you see it.</p>${fs.map((f) => {
        const drills = (f.drill_ids || []).map((id) => S.kbx.drills[id]).filter(Boolean);
        return `<details class="clfault"><summary>${tick(f.id)} ${esc(f.name)}</summary>
          ${f.video_signs ? `<p><b>Looks like:</b> ${esc(f.video_signs)}</p>` : ''}
          ${f.correction_cue ? `<p class="cue">Say: ${esc(f.correction_cue)}</p>` : ''}
          ${f.why_it_matters ? `<p><b>Why it matters:</b> ${esc(f.why_it_matters)}</p>` : ''}
          ${drills.map(drillHtml).join('')}
          <p class="sources"><b>Sources:</b> ${(f.source_ids || []).map((id) => S.kbx.sources[id]).filter(Boolean).map((s) => `<a href="${esc(s.url)}" target="_blank" rel="noopener">${esc(s.name)}</a>`).join(' · ')}</p></details>`;
      }).join('')}` : ''}
      ${tip && !auto ? `<p class="protip"><b>Pro tip:</b> ${esc(tip.tip)}</p>` : ''}</div>`;
  }).join('');
  if (!n) return '';
  const done = Object.values(st).filter(Boolean).length;
  return `<section class="checklist" id="checklist"><h2>${auto ? 'Coach checklist (not auto-checked)' : 'Checklist'} <span class="hint">· <span id="cl-count">${done}</span> ticked</span></h2>
    ${auto ? '<p class="hint">These expert checkpoints can\'t be measured reliably from one camera. Judge them by eye using the key moments.</p>' : ''}${body}</section>`;
}

function faultCard(c, i, k) {
  const beta = c.beta ? '<span class="beta" title="Estimated threshold - calibrate in Settings">BETA</span>' : '<span class="srcbadge" title="Threshold from the expert source (with a tracking margin)">SOURCE</span>';
  const drills = k.drills.map(drillHtml).join('');
  return `<article class="fault" id="f-${esc(c.id)}" data-check="${esc(c.id)}">
    <h3>${i + 1}. ${esc(c.label)} ${beta}${c.confidence ? ` <span class="conf ${esc(c.confidence)}" title="How sure the app is: tracking confidence of the body parts at the flagged moments">${esc(c.confidence)} confidence</span>` : ''}</h3>
    <p class="freq">${esc(c.summary)}</p>
    ${c.instances?.length ? `<div class="moments">${c.instances.slice(0, 6).map((x) => `<button class="btn small" data-seek="${x.t}">▶ ${fmtT(x.t)}</button>`).join('')}</div>` : ''}
    ${k.cue ? `<p class="cue">Say: ${esc(k.cue)}</p>` : ''}
    ${k.why ? `<p><b>Why it matters:</b> ${esc(k.why)}</p>` : ''}
    ${drills}
    ${k.tip ? `<p class="protip"><b>Pro tip:</b> ${esc(k.tip.tip)}</p>` : ''}
    <details><summary>What good looks like &amp; how it was measured</summary>
      ${k.goodForm ? `<p>${esc(k.goodForm)}</p>` : ''}
      <p><b>App check:</b> ${esc(c.thresholdText)}. Typical value this clip: ${esc(c.typical)}. ${c.beta ? 'Threshold is an estimate (BETA).' : ''}</p>
      ${k.rule ? `<p><b>Expert rule:</b> ${esc(k.rule)}</p>` : ''}</details>
    <p class="sources"><b>Sources:</b> ${k.sources.map((s) => `<a href="${esc(s.url)}" target="_blank" rel="noopener">${esc(s.name)}</a>`).join(' · ')}</p>
  </article>`;
}

// ---------------------------------------------------------------- player
function stopPlayer() { if (S.player) { S.player.stop(); S.player = null; } }

async function startPlayer(session, url) {
  const cv = $('#cv'); const r = session.result; const frames = session.track.frames;
  // focus = show one fault at a time on the video + timeline (less clutter); null = all faults
  let focus = r.checks.find((c) => c.status === 'fault')?.id ?? null;
  const flagsAt = (i) => { const f = (r.frameFlags[i] || []).filter((x) => !focus || x.check === focus); return f.length ? f : null; };
  const markFocus = () => $$('[data-focus]').forEach((b) => b.classList.toggle('on', (b.dataset.focus || null) === focus));
  let skeleton = true;
  const caption = (i) => {
    const f = flagsAt(i);
    $('#cap').innerHTML = f ? f.map((x) => `<div class="bad">⚠ ${esc(x.label)}${x.text ? ' - ' + esc(x.text) : ''}</div>`).filter((v, j, arr) => arr.indexOf(v) === j).join('')
      : `<div class="ok">${frames[i]?.lm ? '✓ No problem on this frame' : 'No athlete found on this frame'}</div>`;
  };
  if (session.isPhoto) {
    const img = new Image(); img.src = url; await img.decode();
    sizeCanvas(cv, img.naturalWidth, img.naturalHeight);
    const redraw = () => { renderFrame(cv, img, frames[0], flagsAt(0)); caption(0); markFocus(); };
    redraw();
    S.player = { stop() {}, seek() {}, img, canvas: cv, focus(id) { focus = id; redraw(); } };
    await ensureThumb(session, cv);
    return;
  }
  const v = await loadVideo(url, { durationHint: session.track?.meta?.duration });
  sizeCanvas(cv, v.videoWidth, v.videoHeight);
  const fps = r.meta.fps, maxT = frames.at(-1).t + 1 / fps;
  const idxAt = (t) => { let lo = 0, hi = frames.length - 1; while (lo < hi) { const m = (lo + hi + 1) >> 1; if (frames[m].t <= t + 1e-3) lo = m; else hi = m - 1; } return lo; };
  let raf = 0, stopped = false;
  let showRaw = false; const raw = session.track.raw;
  const draw = () => { const i = idxAt(v.currentTime); renderFrame(cv, v, showRaw && raw?.[i] ? raw[i] : frames[i], flagsAt(i), { skeleton, raw: showRaw }); caption(i); head(v.currentTime); };
  const seek = async (t) => { v.pause(); v.currentTime = Math.max(0, Math.min(t, maxT - 0.001)); await new Promise((res) => v.addEventListener('seeked', res, { once: true })); draw(); playBtn(); };
  const loop = () => { if (stopped) return; if (v.currentTime >= maxT) { v.pause(); } draw(); if (!v.paused) raf = requestAnimationFrame(loop); else playBtn(); };
  const playBtn = () => { const b = $('#play'); if (b) b.textContent = v.paused ? '▶ Play' : '❚❚ Pause'; };

  // timeline: red = flagged frames (merged runs), ticks = detected punches
  const tl = $('#tl');
  const paintTimeline = () => {
  const runs = []; const idxs = Object.keys(r.frameFlags).map(Number).filter((i) => flagsAt(i)).sort((a, b) => a - b);
  for (const i of idxs) { const last = runs.at(-1); if (last && i - last[1] <= 1) last[1] = i; else runs.push([i, i]); }
  tl.innerHTML = runs.map(([a, b]) => `<div class="mk" style="left:${(100 * frames[a].t) / maxT}%;width:${(100 * (frames[b].t - frames[a].t + 1 / fps)) / maxT}%"></div>`).join('')
    + r.events.map((e) => `<div class="ev" style="left:${(100 * e.t) / maxT}%"></div>`).join('') + '<div class="head" id="head"></div>';
  head(v.currentTime); markFocus();
  };
  function head(t) { const h = $('#head'); if (h) h.style.left = `${Math.min(100, (100 * t) / maxT)}%`; }
  paintTimeline();
  const scrub = (ev) => { const b = tl.getBoundingClientRect(); seek(((ev.clientX - b.left) / b.width) * maxT); };
  tl.addEventListener('pointerdown', (ev) => { scrub(ev); tl.setPointerCapture(ev.pointerId); });
  tl.addEventListener('pointermove', (ev) => { if (ev.buttons) scrub(ev); });

  v.playbackRate = 0.5;
  $('#play').onclick = async () => { if (v.paused) { if (v.currentTime >= maxT - 0.05) v.currentTime = 0; await v.play().catch(() => {}); loop(); } else v.pause(); playBtn(); };
  $('#prev').onclick = () => seek(v.currentTime - 1 / fps);
  $('#next').onclick = () => seek(v.currentTime + 1 / fps);
  $$('[data-speed]').forEach((b) => (b.onclick = () => { v.playbackRate = +b.dataset.speed; $$('[data-speed]').forEach((x) => x.setAttribute('aria-pressed', x === b)); }));
  $('#skel').onclick = (e) => { skeleton = !skeleton; e.target.setAttribute('aria-pressed', skeleton); draw(); };
  $('#rawsk')?.addEventListener('click', (e) => { showRaw = !showRaw; e.target.setAttribute('aria-pressed', showRaw); draw(); });
  S.player = { stop() { stopped = true; cancelAnimationFrame(raf); releaseVideo(v); }, seek, video: v, canvas: cv,
    focus(id) { focus = id; paintTimeline(); draw(); } };

  // open on the worst moment of the most important fault so the coach sees it immediately
  const first = r.checks.find((c) => c.status === 'fault' && c.instances?.length);
  await seek(first ? first.instances[0].t : 0);
  await ensureThumb(session, cv);
}

async function ensureThumb(session, cv) {
  if (session.thumb) return;
  const c = document.createElement('canvas'); c.width = 240; c.height = Math.round((240 * cv.height) / cv.width);
  c.getContext('2d').drawImage(cv, 0, 0, c.width, c.height);
  session.thumb = c.toDataURL('image/jpeg', 0.7);
  await store.putSession(session);
}

// ---------------------------------------------------------------- history
async function history() {
  stopPlayer();
  const a = athlete();
  const list = a ? (await store.sessions(a.id)).sort((x, y) => y.createdAt - x.createdAt) : [];
  // per-fault trend: how often each check has been a fault across this athlete's sessions
  const tally = {};
  for (const x of list) for (const c of x.result.checks) if (c.status === 'fault') tally[c.label] = (tally[c.label] || 0) + 1;
  const top = Object.entries(tally).sort((p, q) => q[1] - p[1]).slice(0, 5);
  window.scrollTo(0, 0); app.innerHTML = `<header class="top"><button class="icon-btn" id="back" aria-label="Back">←</button><h1 style="flex:1">${esc(a?.name || 'History')}</h1></header>
    ${top.length ? `<div class="card"><b>Most common faults (${list.length} sessions)</b><ul>${top.map(([k, n]) => `<li>${esc(k)}: ${n}x</li>`).join('')}</ul></div>` : ''}
    ${list.length ? `<ul class="list">${list.map(sessionRow).join('')}</ul>` : '<p>No sessions yet.</p>'}`;
  $('#back').onclick = home;
  bindSessionRows();
}

// ---------------------------------------------------------------- settings
async function settings() {
  stopPlayer();
  const cfg = buildConfig(S.sport, S.overrides);
  const est = await store.estimate();
  const groups = [...new Set(S.sport.checks.map((c) => c.group))];
  const num = (name, val, p) => `<div class="param"><label for="${name}">${esc(p.label)} <span class="hint">(${esc(p.unit)})</span></label>
     <input type="number" step="any" id="${name}" name="${name}" value="${val}" inputmode="decimal" />${p.note ? `<div class="note">${esc(p.note)}</div>` : ''}</div>`;
  window.scrollTo(0, 0); app.innerHTML = `<header class="top"><button class="icon-btn" id="back" aria-label="Back">←</button><h1 style="flex:1">Settings</h1></header>
  <form id="sf">
    <h2>Analysis</h2>
    <label class="field" for="fps">Frames per second to analyse</label>
    <select id="fps">${[[12, 'Fast (12)'], [20, 'Normal (20)'], [30, 'Detailed (30, slower)']].map(([v, l]) => `<option value="${v}" ${S.prefs.fps == v ? 'selected' : ''}>${l}</option>`).join('')}</select>
    <label class="field" for="model">Pose model</label>
    <select id="model"><option value="full" ${S.prefs.model === 'full' ? 'selected' : ''}>Full: accurate (recommended)</option><option value="heavy" ${S.prefs.model === 'heavy' ? 'selected' : ''}>Accurate (slower): heavy model, 30 MB download once</option><option value="lite" ${S.prefs.model === 'lite' ? 'selected' : ''}>Lite: fastest, for older phones</option></select>
    <p class="hint">Accurate (slower) takes longer per clip (about 1.3x on a laptop, can be up to 2x on older phones). It helps with small or partly hidden athletes.</p>
    <label class="field" for="maxs">Max clip length analysed</label>
    <select id="maxs">${[10, 20, 30].map((v) => `<option value="${v}" ${S.prefs.maxSeconds == v ? 'selected' : ''}>${v} seconds</option>`).join('')}</select>
    <label class="switch"><input type="checkbox" id="keep" ${S.prefs.keepVideos ? 'checked' : ''}/> Keep videos on this phone (for replay)</label>

    <h2>Check thresholds</h2>
    <p class="hint">${esc(S.sport.name)}. <span class="beta">BETA</span> = estimated number, not stated by the source. Tune these on your own athletes; use "Re-check with current settings" on a session to see the effect without filming again.</p>
    ${groups.map((g, gi) => `<details ${gi === 0 ? 'open' : ''}><summary>${esc(S.sport.groupLabels?.[g] || (g[0].toUpperCase() + g.slice(1)).replace(/_/g, ' '))} checks</summary>
      ${S.sport.checks.filter((c) => c.group === g).map((c) => `<div class="set">
        <label class="switch"><input type="checkbox" name="en:${c.id}" ${cfg.checks[c.id].enabled ? 'checked' : ''}/> ${esc(c.okLabel)} ${c.basis === 'source' ? '<span class="srcbadge">SOURCE</span>' : '<span class="beta">BETA</span>'}</label>
        <div class="hint">${c.views ? 'View: ' + c.views.join('/') + ' only. ' : ''}KB: ${esc(c.kb.checkpoint)}</div>
        ${Object.entries(c.params || {}).map(([k, p]) => num(`p:${c.id}:${k}`, cfg.checks[c.id][k], p)).join('')}
      </div>`).join('')}</details>`).join('')}
    <details><summary>Advanced (detection &amp; scale)</summary>
      ${Object.entries(S.sport.globals).map(([k, p]) => num(`g:${k}`, cfg.globals[k], p)).join('')}</details>
    <button class="big primary" type="submit">Save settings</button>
    <button class="btn" type="button" id="reset" style="width:100%">Reset thresholds to defaults</button>
  </form>
  <h2>Athletes &amp; data</h2>
  <ul class="list">${S.athletes.map((a) => `<li><div class="grow"><b>${esc(a.name)}</b><span class="hint">${esc(stanceOf(a) || '')}</span></div><button class="btn small danger" data-del-ath="${esc(a.id)}">Delete</button></li>`).join('')}</ul>
  <p class="hint">${est ? `Using ${(est.usage / 1e6).toFixed(1)} MB of ${(est.quota / 1e6).toFixed(0)} MB available.` : ''}</p>
  <h2>About</h2>
  <p class="hint">Coach Flip v${APP_VERSION} · ${esc(S.sport.name)}. Expert knowledge base: ${S.kbx.kb.sources.length} sources (${esc(S.kbx.kb.sources.filter((s) => s.verification === 'full_text_reviewed').map((s) => s.author_or_org).filter(Boolean).join(', '))} reviewed in full). Pose tracking: Google MediaPipe Pose Landmarker (Apache-2.0), running on this phone.</p>`;
  $('#back').onclick = home;
  $('#reset').onclick = async () => { S.overrides = {}; await store.setSetting('overrides:' + S.sportId, {}); settings(); };
  $$('[data-del-ath]').forEach((b) => (b.onclick = async () => {
    if (!confirm('Delete this athlete and all their sessions?')) return;
    await store.deleteAthlete(b.dataset.delAth); S.athletes = S.athletes.filter((a) => a.id !== b.dataset.delAth);
    if (S.athleteId === b.dataset.delAth) S.athleteId = S.athletes[0]?.id ?? null; settings();
  }));
  $('#sf').onsubmit = async (e) => {
    e.preventDefault();
    S.prefs = { ...S.prefs, fps: +$('#fps').value, model: $('#model').value, maxSeconds: +$('#maxs').value, keepVideos: $('#keep').checked };
    await store.setSetting('prefs', S.prefs);
    const o = { globals: {}, checks: {} };
    for (const el of $$('#sf input')) {
      const [kind, a, b] = el.name.split(':');
      if (kind === 'g' && el.value !== '' && +el.value !== S.sport.globals[a].value) o.globals[a] = +el.value;
      if (kind === 'p' && el.value !== '' && +el.value !== S.sport.checks.find((c) => c.id === a).params[b].value) (o.checks[a] ??= {})[b] = +el.value;
      if (kind === 'en' && !el.checked) (o.checks[a] ??= {}).enabled = false;
    }
    S.overrides = o; await store.setSetting('overrides:' + S.sportId, o);
    home();
  };
}

boot().catch((e) => { console.error(e); window.scrollTo(0, 0); app.innerHTML = `<p class="notes">Could not start: ${esc(e.message)}</p>`; });
