// Read the real frame rate of an MP4 / MOV (QuickTime) file from its boxes, without decoding:
// moov > trak (handler 'vide') > mdia > mdhd (timescale, duration) + minf > stbl > stts (frame count).
// Used to tell a genuine high-speed file (e.g. 240 fps, plays at normal speed) from a normal one, so the
// "slow-mo" factor never has to be guessed for those. Works on File/Blob (browser) and on Uint8Array (tests).

const u32 = (b, o) => ((b[o] << 24) | (b[o + 1] << 16) | (b[o + 2] << 8) | b[o + 3]) >>> 0;
const typ = (b, o) => String.fromCharCode(b[o], b[o + 1], b[o + 2], b[o + 3]);

async function readRange(src, start, end) {
  if (src instanceof Uint8Array) return src.subarray(start, Math.min(end, src.length));
  return new Uint8Array(await src.slice(start, end).arrayBuffer());
}
const sizeOf = (src) => (src instanceof Uint8Array ? src.length : src.size);

/** walk top-level boxes reading only headers; return the moov payload */
async function findMoov(src) {
  const n = sizeOf(src);
  let off = 0, guard = 0;
  while (off + 8 <= n && guard++ < 10000) {
    const h = await readRange(src, off, off + 16);
    let size = u32(h, 0); const t = typ(h, 4); let hdr = 8;
    if (size === 1) { size = u32(h, 8) * 2 ** 32 + u32(h, 12); hdr = 16; } else if (size === 0) size = n - off;
    if (size < hdr) return null;
    if (t === 'moov') return size > 64 * 1024 * 1024 ? null : readRange(src, off + hdr, off + size);
    off += size;
  }
  return null;
}
function* boxes(b, start = 0, end = b.length) {
  let o = start;
  while (o + 8 <= end) {
    let size = u32(b, o), hdr = 8; const t = typ(b, o + 4);
    if (size === 1) { size = u32(b, o + 8) * 2 ** 32 + u32(b, o + 12); hdr = 16; } else if (size === 0) size = end - o;
    if (size < hdr || o + size > end) return;
    yield { t, s: o + hdr, e: o + size };
    o += size;
  }
}
const child = (b, box, t) => { for (const c of boxes(b, box.s, box.e)) if (c.t === t) return c; return null; };

/** { fps, frames, duration, width, height } of the first video track, or null if it can't be read */
export async function videoInfo(src) {
  try {
    const moov = await findMoov(src); if (!moov) return null;
    for (const trak of boxes(moov)) {
      if (trak.t !== 'trak') continue;
      const mdia = child(moov, trak, 'mdia'); if (!mdia) continue;
      const hdlr = child(moov, mdia, 'hdlr'); if (!hdlr || typ(moov, hdlr.s + 8) !== 'vide') continue;
      const mdhd = child(moov, mdia, 'mdhd'); if (!mdhd) continue;
      const v = moov[mdhd.s];
      const timescale = v === 1 ? u32(moov, mdhd.s + 20) : u32(moov, mdhd.s + 12);
      const duration = v === 1 ? u32(moov, mdhd.s + 24) * 2 ** 32 + u32(moov, mdhd.s + 28) : u32(moov, mdhd.s + 16);
      const stbl = child(moov, child(moov, mdia, 'minf') || { s: 0, e: 0 }, 'stbl'); if (!stbl) continue;
      const stts = child(moov, stbl, 'stts'); if (!stts) continue;
      const cnt = u32(moov, stts.s + 4); let frames = 0, ticks = 0;
      for (let k = 0; k < cnt; k++) { const c = u32(moov, stts.s + 8 + 8 * k), d = u32(moov, stts.s + 12 + 8 * k); frames += c; ticks += c * d; }
      const tkhd = child(moov, trak, 'tkhd');
      let width = null, height = null;
      if (tkhd) { const tv = moov[tkhd.s], wo = tkhd.s + (tv === 1 ? 88 : 76); width = u32(moov, wo) / 65536; height = u32(moov, wo + 4) / 65536; }
      const dur = (ticks || duration) / timescale;
      if (!frames || !dur) return null;
      return { fps: Math.round((frames / dur) * 100) / 100, frames, duration: Math.round(dur * 1000) / 1000, width, height };
    }
  } catch (e) { /* unreadable / not MP4 */ }
  return null;
}

/**
 * Which slow-motion factor to analyse with. Slow-mo only ever applies to an UPLOADED clip that plays back
 * slowed down. In-app and camera-app recordings are normal speed; a genuine high-speed file (>= 100 fps,
 * plays at real speed in the browser) needs no factor either.
 */
export function decideSlowmo({ source = 'upload', chosen = 1, fileFps = null } = {}) {
  chosen = Math.max(1, +chosen || 1);
  if (source !== 'upload') return { slowmo: 1, note: chosen > 1 ? 'Recorded here at normal speed, so the slow-mo setting was not used.' : null };
  if (fileFps && fileFps >= 100) return { slowmo: 1, note: `This is a real high-speed video (${Math.round(fileFps)} fps), so timing is measured directly${chosen > 1 ? ' and the slow-mo setting was not needed' : ''}.` };
  return { slowmo: chosen, note: null };
}
