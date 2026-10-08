// Draws the frame + skeleton + fault graphics onto a canvas. Coordinates from the engine are
// normalised (0..1) so the same drawing works at any canvas size.
import { SKELETON } from './engine/landmarks.js';
import { athleteBoxPx, placeCallouts } from './labels.js';

export const COLORS = { bone: '#ffffff', joint: '#00e5ff', fault: '#ff1f1f', good: '#00d26a', ink: '#000000' };

export function sizeCanvas(canvas, w, h, maxW = 1280) {
  const s = Math.min(1, maxW / w);
  canvas.width = Math.round(w * s); canvas.height = Math.round(h * s);
}

const W0 = (g) => g.canvas.width;
const FONT = (fs) => `700 ${fs}px Oswald, system-ui, -apple-system, "Segoe UI", Roboto, sans-serif`;
/** a measurement callout box at a placed rect (semi-transparent so the picture shows through) */
function calloutBox(g, r, text, fs, bg, fg) {
  g.save(); g.globalAlpha = 0.86; g.fillStyle = bg;
  g.beginPath(); g.roundRect ? g.roundRect(r.x0, r.y0, r.x1 - r.x0, r.y1 - r.y0, fs / 3) : g.rect(r.x0, r.y0, r.x1 - r.x0, r.y1 - r.y0); g.fill();
  g.globalAlpha = 1; g.fillStyle = fg; g.font = FONT(fs); g.textBaseline = 'middle'; g.fillText(text, r.x0 + fs * 0.4, (r.y0 + r.y1) / 2 + 1);
  g.restore();
}

function stroke(g, pts, color, lw, dash) {
  g.save(); g.lineCap = 'round'; g.lineJoin = 'round';
  if (dash) g.setLineDash(dash);
  g.strokeStyle = COLORS.ink; g.globalAlpha *= 0.7; g.lineWidth = lw + Math.max(1.5, lw * 0.8); g.beginPath(); pts.forEach(([x, y], i) => (i ? g.lineTo(x, y) : g.moveTo(x, y))); g.stroke();
  g.globalAlpha /= 0.7; g.strokeStyle = color; g.lineWidth = lw; g.beginPath(); pts.forEach(([x, y], i) => (i ? g.lineTo(x, y) : g.moveTo(x, y))); g.stroke();
  g.restore();
}

export function drawSkeleton(g, lm, { color = COLORS.bone, alpha = 0.9 } = {}) {
  if (!lm) return;
  // thin lines + small joints so the body stays visible under the graphics
  const W = g.canvas.width, H = g.canvas.height, lw = Math.max(1.5, W / 360);
  g.save(); g.globalAlpha = alpha;
  for (const [a, b] of SKELETON) {
    if (lm[a][3] < 0.3 || lm[b][3] < 0.3) continue;
    stroke(g, [[lm[a][0] * W, lm[a][1] * H], [lm[b][0] * W, lm[b][1] * H]], color, lw);
  }
  for (const i of [0, 11, 12, 13, 14, 15, 16, 23, 24, 25, 26, 27, 28]) {
    if (lm[i][3] < 0.3) continue;
    g.fillStyle = COLORS.ink; g.beginPath(); g.arc(lm[i][0] * W, lm[i][1] * H, lw * 1.6, 0, 7); g.fill();
    g.fillStyle = COLORS.joint; g.beginPath(); g.arc(lm[i][0] * W, lm[i][1] * H, lw * 1.1, 0, 7); g.fill();
  }
  g.restore();
}

/**
 * Fault graphics. Lines/angles/circles are drawn thin on the body; their measurement text goes into callouts placed
 * OFF the athlete (nearest free side, thin leader line). No banner on the picture: the fault title is shown in the
 * caption bar above the video. opts: {labels: show callouts, lm: athlete landmarks for the box}
 */
export function drawFlags(g, flags, { labels = true, lm = null, cssW = null } = {}) {
  if (!flags?.length) return null;
  // callout text ~12 CSS px on the phone, whatever the video resolution
  const k = W0(g) / (cssW || Math.min(W0(g), 400));
  const W = g.canvas.width, H = g.canvas.height, lw = Math.max(2, W / 300), fs = Math.max(11, Math.round(12 * k));
  const P = ([x, y]) => [x * W, y * H];
  // thin red frame = "problem frame"
  g.save(); g.strokeStyle = COLORS.fault; g.lineWidth = Math.max(3, W / 240); g.strokeRect(0, 0, W, H); g.restore();
  const callouts = [];
  const call = (text, at, bg = 'rgba(190,20,40,1)', fg = '#fff') => { if (text) callouts.push({ text, ax: at[0], ay: at[1], bg, fg }); };
  for (const f of flags) {
    for (const d of f.draw || []) {
      if (d.k === 'line') {
        stroke(g, [P(d.a), P(d.b)], COLORS.fault, lw);
        call(d.text, P([(d.a[0] + d.b[0]) / 2, (d.a[1] + d.b[1]) / 2]));
      } else if (d.k === 'circle') {
        const c = P(d.c);
        g.save(); g.setLineDash([lw * 2.5, lw * 2]); g.strokeStyle = COLORS.good; g.lineWidth = lw * 0.8;
        g.beginPath(); g.arc(c[0], c[1], d.r * W, 0, 7); g.stroke(); g.restore();
      } else if (d.k === 'angle') {
        const [a, b, c] = [P(d.a), P(d.b), P(d.c)];
        stroke(g, [a, b, c], COLORS.fault, lw);
        const a1 = Math.atan2(a[1] - b[1], a[0] - b[0]), a2 = Math.atan2(c[1] - b[1], c[0] - b[0]);
        let da = a2 - a1; while (da > Math.PI) da -= 2 * Math.PI; while (da < -Math.PI) da += 2 * Math.PI;
        g.save(); g.strokeStyle = '#ffd400'; g.lineWidth = lw * 0.8; g.beginPath(); g.arc(b[0], b[1], fs * 1.4, a1, a1 + da, da < 0); g.stroke(); g.restore();
        call(d.text, b);
      } else if (d.k === 'hline') {
        const c = P([d.x, d.y]), half = (d.w * W) / 2;
        stroke(g, [[c[0] - half, c[1]], [c[0] + half, c[1]]], '#ffd400', lw * 0.7, [lw * 3, lw * 2]);
        call(d.text, [c[0] + half, c[1]], 'rgba(255,212,0,1)', '#000');
      } else if (d.k === 'vline') {
        const c = P([d.x, d.y]), half = (d.h * H) / 2;
        stroke(g, [[c[0], c[1] - half], [c[0], c[1] + half]], '#ffd400', lw * 0.7, [lw * 3, lw * 2]);
        call(d.text, [c[0], c[1] - half], 'rgba(255,212,0,1)', '#000');
      } else if (d.k === 'dot') {
        const c = P(d.c);
        g.save(); g.fillStyle = COLORS.fault; g.strokeStyle = '#000'; g.lineWidth = 2;
        g.beginPath(); g.arc(c[0], c[1], lw * 2, 0, 7); g.fill(); g.stroke(); g.restore();
        call(d.text, c);
      }
    }
  }
  if (!labels || !callouts.length) return { box: athleteBoxPx(lm, W, H), rects: [] };
  // one callout per text (the same measurement can be drawn twice)
  const uniq = callouts.filter((c, i, arr) => arr.findIndex((x) => x.text === c.text) === i).slice(0, 4);
  g.save(); g.font = FONT(fs);
  const items = uniq.map((c) => ({ ...c, w: g.measureText(c.text).width + fs * 0.8, h: fs * 1.5 }));
  g.restore();
  const box = athleteBoxPx(lm, W, H);
  const rects = placeCallouts(items, box, W, H, { gap: fs * 0.6 });
  rects.forEach((r, i) => {
    const it = items[i];
    // thin leader line from the callout to the measured point
    g.save(); g.strokeStyle = it.bg; g.globalAlpha = 0.9; g.lineWidth = Math.max(1, lw * 0.5);
    g.beginPath(); g.moveTo(r.lx, r.ly); g.lineTo(it.ax, it.ay); g.stroke();
    g.beginPath(); g.arc(it.ax, it.ay, Math.max(2, lw), 0, 7); g.fillStyle = it.bg; g.fill(); g.restore();
    calloutBox(g, r, it.text, fs, it.bg, it.fg);
  });
  return { box, rects };
}

/** full frame render: picture + skeleton + (optional) fault graphics. Returns the label layout (for tests). */
export function renderFrame(canvas, source, frame, flags, opts = {}) {
  const g = canvas.getContext('2d');
  g.drawImage(source, 0, 0, canvas.width, canvas.height);
  if (opts.overlays === false) return null;
  if (opts.skeleton !== false && frame?.lm) drawSkeleton(g, frame.lm, { color: opts.raw ? '#ffb000' : flags?.length ? '#ffe0e0' : COLORS.bone });
  if (flags?.length) return drawFlags(g, flags, { labels: opts.labels !== false, lm: frame?.lm, cssW: canvas.clientWidth || null });
  return null;
}
