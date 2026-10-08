// Draws the frame + skeleton + fault graphics onto a canvas. Coordinates from the engine are
// normalised (0..1) so the same drawing works at any canvas size.
import { SKELETON } from './engine/landmarks.js';

export const COLORS = { bone: '#ffffff', joint: '#00e5ff', fault: '#ff1f1f', good: '#00d26a', ink: '#000000' };

export function sizeCanvas(canvas, w, h, maxW = 1280) {
  const s = Math.min(1, maxW / w);
  canvas.width = Math.round(w * s); canvas.height = Math.round(h * s);
}

function label(g, text, x, y, fs, bg = COLORS.fault, fg = '#fff') {
  if (!text) return;
  g.font = `800 ${fs}px system-ui, -apple-system, Segoe UI, Roboto, sans-serif`;
  const w = g.measureText(text).width + fs * 0.7, h = fs * 1.45;
  const W = g.canvas.width, H = g.canvas.height;
  x = Math.max(4, Math.min(W - w - 4, x)); y = Math.max(4, Math.min(H - h - 4, y));
  g.fillStyle = bg; g.strokeStyle = '#000'; g.lineWidth = Math.max(2, fs / 8);
  g.beginPath(); g.roundRect ? g.roundRect(x, y, w, h, fs / 3) : g.rect(x, y, w, h); g.fill(); g.stroke();
  g.fillStyle = fg; g.textBaseline = 'middle'; g.fillText(text, x + fs * 0.35, y + h / 2);
}

function stroke(g, pts, color, lw, dash) {
  g.save(); g.lineCap = 'round'; g.lineJoin = 'round';
  if (dash) g.setLineDash(dash);
  g.strokeStyle = COLORS.ink; g.lineWidth = lw + 4; g.beginPath(); pts.forEach(([x, y], i) => (i ? g.lineTo(x, y) : g.moveTo(x, y))); g.stroke();
  g.strokeStyle = color; g.lineWidth = lw; g.beginPath(); pts.forEach(([x, y], i) => (i ? g.lineTo(x, y) : g.moveTo(x, y))); g.stroke();
  g.restore();
}

export function drawSkeleton(g, lm, { color = COLORS.bone, alpha = 0.95 } = {}) {
  if (!lm) return;
  const W = g.canvas.width, H = g.canvas.height, lw = Math.max(3, W / 220);
  g.save(); g.globalAlpha = alpha;
  for (const [a, b] of SKELETON) {
    if (lm[a][3] < 0.3 || lm[b][3] < 0.3) continue;
    stroke(g, [[lm[a][0] * W, lm[a][1] * H], [lm[b][0] * W, lm[b][1] * H]], color, lw);
  }
  for (const i of [0, 11, 12, 13, 14, 15, 16, 23, 24, 25, 26, 27, 28]) {
    if (lm[i][3] < 0.3) continue;
    g.fillStyle = COLORS.ink; g.beginPath(); g.arc(lm[i][0] * W, lm[i][1] * H, lw * 1.4, 0, 7); g.fill();
    g.fillStyle = COLORS.joint; g.beginPath(); g.arc(lm[i][0] * W, lm[i][1] * H, lw, 0, 7); g.fill();
  }
  g.restore();
}

export function drawFlags(g, flags, { banner = true } = {}) {
  if (!flags?.length) return;
  const W = g.canvas.width, H = g.canvas.height, lw = Math.max(4, W / 150), fs = Math.max(16, Math.round(W / 34));
  const P = ([x, y]) => [x * W, y * H];
  // red frame around the picture = "problem frame"
  g.save(); g.strokeStyle = COLORS.fault; g.lineWidth = Math.max(8, W / 80); g.strokeRect(0, 0, W, H); g.restore();
  for (const f of flags) {
    for (const d of f.draw || []) {
      if (d.k === 'line') {
        stroke(g, [P(d.a), P(d.b)], COLORS.fault, lw);
        const m = P([(d.a[0] + d.b[0]) / 2, (d.a[1] + d.b[1]) / 2]);
        label(g, d.text, m[0] + fs * 0.4, m[1] - fs * 0.7, fs * 0.85);
      } else if (d.k === 'circle') {
        const c = P(d.c);
        g.save(); g.setLineDash([lw * 2, lw * 1.5]); g.strokeStyle = COLORS.good; g.lineWidth = lw * 0.8;
        g.beginPath(); g.arc(c[0], c[1], d.r * W, 0, 7); g.stroke(); g.restore();
      } else if (d.k === 'angle') {
        const [a, b, c] = [P(d.a), P(d.b), P(d.c)];
        stroke(g, [a, b, c], COLORS.fault, lw);
        const a1 = Math.atan2(a[1] - b[1], a[0] - b[0]), a2 = Math.atan2(c[1] - b[1], c[0] - b[0]);
        let da = a2 - a1; while (da > Math.PI) da -= 2 * Math.PI; while (da < -Math.PI) da += 2 * Math.PI;
        g.save(); g.strokeStyle = '#ffd400'; g.lineWidth = lw * 0.8; g.beginPath(); g.arc(b[0], b[1], fs * 1.6, a1, a1 + da, da < 0); g.stroke(); g.restore();
        label(g, d.text, b[0] + fs, b[1] + fs * 0.3, fs);
      } else if (d.k === 'hline') {
        const c = P([d.x, d.y]), half = (d.w * W) / 2;
        stroke(g, [[c[0] - half, c[1]], [c[0] + half, c[1]]], '#ffd400', lw * 0.7, [lw * 2, lw * 1.2]);
        if (d.text) label(g, d.text, c[0] + half + 6, c[1] - fs * 0.7, fs * 0.75, '#ffd400', '#000');
      } else if (d.k === 'vline') {
        // vertical reference (e.g. "hip vertical" for overstriding): dashed yellow plumb line
        const c = P([d.x, d.y]), half = (d.h * H) / 2;
        stroke(g, [[c[0], c[1] - half], [c[0], c[1] + half]], '#ffd400', lw * 0.7, [lw * 2, lw * 1.2]);
        if (d.text) label(g, d.text, c[0] + 6, c[1] - half, fs * 0.75, '#ffd400', '#000');
      } else if (d.k === 'dot') {
        const c = P(d.c);
        g.save(); g.fillStyle = COLORS.fault; g.strokeStyle = '#000'; g.lineWidth = 3;
        g.beginPath(); g.arc(c[0], c[1], lw * 2.2, 0, 7); g.fill(); g.stroke(); g.restore();
        label(g, d.text, c[0] + lw * 3, c[1] - fs * 0.7, fs * 0.85);
      }
    }
  }
  if (banner) {
    const names = [...new Set(flags.map((f) => f.label))];
    names.slice(0, 3).forEach((n, i) => label(g, '⚠ ' + n, fs * 0.6, fs * 0.6 + i * fs * 1.7, fs));
  }
}

/** full frame render: picture + skeleton + (optional) fault graphics */
export function renderFrame(canvas, source, frame, flags, opts = {}) {
  const g = canvas.getContext('2d');
  g.drawImage(source, 0, 0, canvas.width, canvas.height);
  if (opts.skeleton !== false && frame?.lm) drawSkeleton(g, frame.lm, { color: flags?.length ? '#ffe0e0' : COLORS.bone });
  if (flags?.length) drawFlags(g, flags, opts);
}
