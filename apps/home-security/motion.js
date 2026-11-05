// Home Security motion detection (t3, docs/home-security.md §4). Pure: no I/O, no timers, no clock reads.
// Fed fixed-size gray frames (1 byte per pixel, W×H) with their wall-clock time in ms.

export const EMA_ALPHA = 0.05;
export const WARMUP_MS = 2000;
export const LIGHTING_SCORE = 0.8;

const clampSens = (s) => Math.min(100, Math.max(1, Number.isFinite(Number(s)) ? Number(s) : 50));
/** |frame − background| above this counts as a changed pixel. Sensitivity 50 → 40. */
export const pixelThreshold = (sensitivity) => Math.round(70 - 0.6 * clampSens(sensitivity));
/** Fraction of mask pixels that must change for a frame to count as motion. Sensitivity 50 → 0.027. */
export const areaThreshold = (sensitivity) => 0.002 + (0.05 * (100 - clampSens(sensitivity))) / 100;

function pointInPolygon(x, y, pts) {
  let inside = false;
  for (let i = 0, j = pts.length - 1; i < pts.length; j = i++) {
    const [xi, yi] = pts[i]; const [xj, yj] = pts[j];
    if ((yi > y) !== (yj > y) && x < ((xj - xi) * (y - yi)) / (yj - yi) + xi) inside = !inside;
  }
  return inside;
}

const validZone = (z) => z && Array.isArray(z.points) && z.points.length >= 3
  && z.points.every((p) => Array.isArray(p) && p.length === 2 && p.every((v) => Number.isFinite(v)));

/**
 * Rasterize zones (normalized [0..1] polygons) into a mask. include zones (if any) limit detection to their union;
 * exclude zones are always removed. No zones = whole frame. Pixel centers are tested.
 * Returns { mask: Uint8Array(W*H) of 0/1, count, labels: Int16Array(W*H) index into zones of the include zone (-1) }.
 */
export function rasterizeZones(zones, width, height) {
  const list = (Array.isArray(zones) ? zones : []).filter(validZone);
  const inc = list.filter((z) => (z.mode || 'include') === 'include');
  const exc = list.filter((z) => z.mode === 'exclude');
  const mask = new Uint8Array(width * height);
  const labels = new Int16Array(width * height).fill(-1);
  let count = 0;
  for (let y = 0; y < height; y++) {
    const ny = (y + 0.5) / height;
    for (let x = 0; x < width; x++) {
      const nx = (x + 0.5) / width;
      const i = y * width + x;
      let on = inc.length === 0;
      for (let k = 0; k < inc.length; k++) if (pointInPolygon(nx, ny, inc[k].points)) { on = true; labels[i] = list.indexOf(inc[k]); break; }
      if (on && exc.some((z) => pointInPolygon(nx, ny, z.points))) on = false;
      if (on) { mask[i] = 1; count++; }
    }
  }
  return { mask, count, labels, zones: list };
}

/**
 * Per-camera frame scorer: EMA background, thresholded diff inside the zone mask.
 * feed(frame, t) → { score, motion, warming, lighting, zones: [names that fired] }.
 */
export function createDetector({ width, height, sensitivity = 50, zones = [], alpha = EMA_ALPHA, warmupMs = WARMUP_MS } = {}) {
  if (!(width > 0 && height > 0)) throw new Error('detector needs width and height');
  const n = width * height;
  let raster = rasterizeZones(zones, width, height);
  let pxT = pixelThreshold(sensitivity);
  let areaT = areaThreshold(sensitivity);
  let bg = null;
  let startedAt = null;
  const zoneHits = new Uint32Array(raster.zones.length);

  return {
    get width() { return width; },
    get height() { return height; },
    configure({ sensitivity: s, zones: z } = {}) {
      if (s !== undefined) { pxT = pixelThreshold(s); areaT = areaThreshold(s); }
      if (z !== undefined) raster = rasterizeZones(z, width, height);
    },
    reset() { bg = null; startedAt = null; },
    feed(frame, t) {
      if (!frame || frame.length < n) return { score: 0, motion: false, warming: true, lighting: false, zones: [] };
      if (!bg) { bg = new Float32Array(n); for (let i = 0; i < n; i++) bg[i] = frame[i]; startedAt = t; }
      const warming = t - startedAt < warmupMs;
      let changed = 0;
      zoneHits.fill(0);
      const { mask, count, labels } = raster;
      for (let i = 0; i < n; i++) {
        const v = frame[i];
        if (mask[i] && Math.abs(v - bg[i]) > pxT) { changed++; if (labels[i] >= 0) zoneHits[labels[i]]++; }
        bg[i] += alpha * (v - bg[i]);
      }
      const score = count ? changed / count : 0;
      if (warming) return { score, motion: false, warming: true, lighting: false, zones: [] };
      if (score > LIGHTING_SCORE) { // lighting change: re-seed the background, no motion
        for (let i = 0; i < n; i++) bg[i] = frame[i];
        return { score, motion: false, warming: false, lighting: true, zones: [] };
      }
      const motion = score >= areaT && count > 0;
      const fired = motion ? raster.zones.filter((z, k) => zoneHits[k] > 0).map((z) => z.name).filter(Boolean) : [];
      return { score, motion, warming: false, lighting: false, zones: fired };
    },
  };
}

/**
 * Event state machine. step(t, { motion, score, zones }) → list of actions:
 *   { type: 'open', startMs, peak, peakAt }          motion sustained for minDurationMs (startMs = first frame over threshold)
 *   { type: 'peak', id-less, peak, peakAt }          new peak score while active (thumbnail moment)
 *   { type: 'close', startMs, endMs, peak, frames, zones, reason: 'quiet' | 'max' }
 * idle → (sustained motion) → active → (no motion for postRollMs) → closed. maxEventMs splits long events.
 */
export function createEventMachine({ minDurationMs = 500, postRollMs = 10_000, maxEventMs = 600_000 } = {}) {
  let cfg = { minDurationMs, postRollMs, maxEventMs };
  let state = 'idle';
  let candidateStart = null; // first frame over threshold of a run not yet confirmed
  let ev = null; // { startMs, lastMotionMs, peak, peakAt, frames, zones:Set }

  const closeAct = (endMs, reason) => {
    const a = { type: 'close', startMs: ev.startMs, endMs, peak: ev.peak, peakAt: ev.peakAt, frames: ev.frames, zones: [...ev.zones], reason };
    ev = null; state = 'idle'; candidateStart = null;
    return a;
  };

  return {
    get state() { return state; },
    get current() { return ev && { ...ev, zones: [...ev.zones] }; },
    configure(c) { cfg = { ...cfg, ...Object.fromEntries(Object.entries(c || {}).filter(([, v]) => Number.isFinite(v))) }; },
    step(t, { motion = false, score = 0, zones = [] } = {}) {
      const out = [];
      if (state === 'idle') {
        if (!motion) { candidateStart = null; return out; }
        if (candidateStart === null) candidateStart = t;
        if (t - candidateStart >= cfg.minDurationMs) {
          state = 'active';
          ev = { startMs: candidateStart, lastMotionMs: t, peak: score, peakAt: t, frames: 1, zones: new Set(zones) };
          out.push({ type: 'open', startMs: ev.startMs, peak: score, peakAt: t });
        }
        return out;
      }
      // active
      if (motion) {
        ev.lastMotionMs = t; ev.frames++;
        for (const z of zones) ev.zones.add(z);
        if (score > ev.peak) { ev.peak = score; ev.peakAt = t; out.push({ type: 'peak', peak: score, peakAt: t }); }
        if (t - ev.startMs >= cfg.maxEventMs) {
          out.push(closeAct(t, 'max'));
          // continuing motion opens the next event at once
          state = 'active';
          ev = { startMs: t, lastMotionMs: t, peak: score, peakAt: t, frames: 1, zones: new Set(zones) };
          out.push({ type: 'open', startMs: t, peak: score, peakAt: t });
        }
      } else if (t - ev.lastMotionMs >= cfg.postRollMs) {
        out.push(closeAct(ev.lastMotionMs, 'quiet'));
      }
      return out;
    },
    /** Force-close (camera stopped / shutdown). */
    flush() { return state === 'active' ? [closeAct(ev.lastMotionMs, 'flush')] : []; },
  };
}

/** Clip window: [start − preRoll, end + postRoll]; end null (active) → open-ended (to: null). */
export function clipWindow({ startMs, endMs }, preRollSeconds, postRollSeconds) {
  return {
    from: startMs - Math.round(preRollSeconds * 1000),
    to: endMs === null || endMs === undefined ? null : endMs + Math.round(postRollSeconds * 1000),
  };
}

/** Do [aFrom, aTo) and a (possibly open-ended, `to: null` = now/infinity) window overlap? */
export function overlaps(aFrom, aTo, win) {
  return aFrom < (win.to ?? Infinity) && aTo > win.from;
}

/** Segments (sorted by start) that overlap a clip window. Pure pre-roll math for the clip/VOD builders. */
export function segmentsForWindow(segments, win) {
  return segments.filter((s) => overlaps(s.startMs, s.startMs + s.durMs, win));
}
