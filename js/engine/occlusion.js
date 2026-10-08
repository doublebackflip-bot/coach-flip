// Occlusion-aware confidence. MediaPipe often reports a hidden hand (behind the body when the athlete
// turns away, or the far arm in a profile view) with HIGH visibility and a guessed position (e.g. on the
// back). Rules that then measure that hand produce false faults. Here we lower the visibility of points
// that are very probably hidden, so checks report "not clear" instead of judging a guess.
const HANDS = [13, 14, 15, 16, 17, 18, 19, 20, 21, 22]; // elbows, wrists, fingers
const FACE = [0, 1, 2, 3, 4, 5, 6, 9, 10];
const CAP = 0.35;

function inPoly(x, y, poly) {
  let inside = false;
  for (let i = 0, j = poly.length - 1; i < poly.length; j = i++) {
    const [xi, yi] = poly[i], [xj, yj] = poly[j];
    if ((yi > y) !== (yj > y) && x < ((xj - xi) * (y - yi)) / (yj - yi) + xi) inside = !inside;
  }
  return inside;
}

/** returns frames with copied lm arrays where probably-hidden points get visibility <= CAP (frame.occluded = [indices]) */
export function markOcclusion(frames) {
  return frames.map((f) => {
    if (!f?.lm || !f.wlm || f.occluded) return f;
    const L = f.lm, Wd = f.wlm;
    if (Math.min(L[11][3], L[12][3], L[23][3], L[24][3]) < 0.5) return f;
    // aspect-correct 2D (x is a fraction of width, y of height); the ratio only matters for the torso polygon test,
    // which is scale-free, and for the facing test, which compares x-distances with each other
    const sw = L[11][0] - L[12][0], hw = L[23][0] - L[24][0];
    const torsoH = Math.abs((L[23][1] + L[24][1]) / 2 - (L[11][1] + L[12][1]) / 2) || 0.1;
    const facingAway = sw < -0.05 * torsoH && hw < -0.02 * torsoH; // left shoulder AND hip on the image left = seen from behind
    const zT = (Wd[11][2] + Wd[12][2] + Wd[23][2] + Wd[24][2]) / 4;
    // torso quad, expanded 15% around its centre
    const quad = [L[11], L[12], L[24], L[23]].map((p) => [p[0], p[1]]);
    const cx = quad.reduce((s, p) => s + p[0], 0) / 4, cy = quad.reduce((s, p) => s + p[1], 0) / 4;
    const big = quad.map(([x, y]) => [cx + (x - cx) * 1.15, cy + (y - cy) * 1.15]);
    // head region (for hands hidden in front of the face when seen from behind)
    const xs = [L[11][0], L[12][0]], headTop = Math.min(L[0][1], L[7][1], L[8][1]) - 0.35 * torsoH;
    const occ = [];
    for (const j of HANDS) {
      const [x, y] = L[j];
      const behind = Wd[j][2] > zT + 0.05; // farther from the camera than the torso
      const overBody = inPoly(x, y, big) || (facingAway && y >= headTop && y <= cy && x >= Math.min(...xs) - 0.1 * torsoH && x <= Math.max(...xs) + 0.1 * torsoH);
      if (overBody && (behind || facingAway) && L[j][3] > CAP) occ.push(j);
    }
    if (facingAway) for (const j of FACE) if (L[j][3] > CAP) occ.push(j);
    if (!occ.length) return { ...f, occluded: [] };
    const lm = L.map((p, i) => (occ.includes(i) ? [p[0], p[1], p[2], Math.min(p[3], CAP)] : p));
    return { ...f, lm, occluded: occ, facingAway };
  });
}
