// Callout placement for fault measurements (v0.5): keep text boxes OFF the athlete.
// Pure functions (no canvas) so they are unit-tested in Node.

/** athlete box in pixels from landmarks (visible points), padded; null if no landmarks */
export function athleteBoxPx(lm, W, H, pad = 0.04) {
  if (!lm) return null;
  const pts = lm.filter((p) => p[3] >= 0.3);
  if (pts.length < 4) return null;
  let x0 = Math.min(...pts.map((p) => p[0])) * W, x1 = Math.max(...pts.map((p) => p[0])) * W;
  let y0 = Math.min(...pts.map((p) => p[1])) * H, y1 = Math.max(...pts.map((p) => p[1])) * H;
  // the head reaches above the eyes/ears; the face points are the top landmarks
  const hh = (y1 - y0) * 0.06;
  const px = pad * W, py = pad * H;
  return { x0: Math.max(0, x0 - px), y0: Math.max(0, y0 - py - hh), x1: Math.min(W, x1 + px), y1: Math.min(H, y1 + py) };
}
export const overlap = (a, b) => Math.max(0, Math.min(a.x1, b.x1) - Math.max(a.x0, b.x0)) * Math.max(0, Math.min(a.y1, b.y1) - Math.max(a.y0, b.y0));
const inside = (r, W, H, m) => r.x0 >= m && r.y0 >= m && r.x1 <= W - m && r.y1 <= H - m;

/**
 * Place callouts [{w, h, ax, ay}] (size + anchor point, px) so they avoid the athlete box and each other.
 * Tries, in order of distance to the anchor, positions on every side of the athlete box (left/right at the
 * anchor's height, then stacked up/down; above/below). Falls back to the free corner with the least overlap.
 * Returns [{x0, y0, x1, y1, lx, ly, free}] where (lx, ly) is where the leader line leaves the box.
 */
export function placeCallouts(items, box, W, H, { gap = 8, margin = 4 } = {}) {
  const placed = [];
  for (const it of items) {
    const { w, h, ax, ay } = it;
    const cands = [];
    const add = (x, y) => { const r = { x0: x, y0: y, x1: x + w, y1: y + h }; if (inside(r, W, H, margin)) cands.push(r); };
    const ys = [], xs = [];
    for (let k = 0; k <= 12; k++) for (const s of k ? [1, -1] : [1]) ys.push(ay - h / 2 + s * k * (h + 4));
    for (let k = 0; k <= 12; k++) for (const s of k ? [1, -1] : [1]) xs.push(ax - w / 2 + s * k * (w / 3));
    if (box) {
      for (const y of ys) { add(box.x0 - gap - w, y); add(box.x1 + gap, y); }
      for (const x of xs) { add(x, box.y0 - gap - h); add(x, box.y1 + gap); }
    } else for (const y of ys) for (const x of xs) add(x, y);
    const dist = (r) => Math.hypot(Math.max(r.x0 - ax, 0, ax - r.x1), Math.max(r.y0 - ay, 0, ay - r.y1));
    const clash = (r) => (box ? overlap(r, box) : 0) + placed.reduce((s, p) => s + overlap(r, { x0: p.x0 - 2, y0: p.y0 - 2, x1: p.x1 + 2, y1: p.y1 + 2 }), 0);
    let best = null;
    for (const r of cands) { const c = clash(r), d = dist(r); if (c === 0 && (!best || d < best.d)) best = { r, d, free: true }; }
    if (!best) {
      // no free spot: least overlap anywhere along the edges (semi-transparent, so the body still shows through)
      const edge = [];
      for (let x = margin; x <= W - w - margin; x += Math.max(8, w / 4)) { edge.push({ x0: x, y0: margin, x1: x + w, y1: margin + h }); edge.push({ x0: x, y0: H - h - margin, x1: x + w, y1: H - margin }); }
      for (let y = margin; y <= H - h - margin; y += Math.max(8, h)) { edge.push({ x0: margin, y0: y, x1: margin + w, y1: y + h }); edge.push({ x0: W - w - margin, y0: y, x1: W - margin, y1: y + h }); }
      for (const r of edge.length ? edge : [{ x0: margin, y0: margin, x1: margin + w, y1: margin + h }]) { const c = clash(r), d = dist(r); if (!best || c < best.c || (c === best.c && d < best.d)) best = { r, c, d, free: false }; }
    }
    const r = best.r;
    placed.push({ ...r, lx: Math.max(r.x0, Math.min(r.x1, ax)), ly: Math.max(r.y0, Math.min(r.y1, ay)), free: best.free });
  }
  return placed;
}
