// Trip statistics, shared by the browser and the applet server (which caches each trip's summary in
// its file). Pure functions over recorded fixes {t (ms), lat, lon, speed (m/s|null), heading,
// accuracy, alt}; no DOM, no Node APIs.
//
// GPS is noisy in three ways this has to survive: positions wobble a few metres (inflating distance
// and derived speed), the device speed occasionally spikes (one 400 km/h sample in a 50 km/h drive),
// and fixes arrive at uneven intervals. So: impossible fixes are dropped, positions are lightly
// smoothed before measuring distance, speeds go through a time-window median (kills single spikes)
// and then a mean, and acceleration is a speed difference across a ~2.5 s window.
import { haversine } from './geo.js';

export const LIMITS = {
  maxSpeed: 90,          // m/s (324 km/h): anything faster is a GPS error, not a car
  maxAccel: 12,          // m/s²: beyond what a road car does, either way
  movingSpeed: 0.8,      // m/s (~3 km/h): below this the vehicle counts as standing
  gapMs: 30000,          // a longer gap between fixes is "signal lost", not one segment of driving
};

const SPEED_WINDOW_MS = 3000;   // median then mean over ±1.5 s
const ACCEL_WINDOW_MS = 2500;   // acceleration = Δv across this window
const TIMELINE_POINTS = 300;

const finite = (x) => typeof x === 'number' && Number.isFinite(x);

/** Sorted, de-duplicated fixes with finite coordinates, and with positions that imply impossible speed removed. */
export function cleanFixes(points, { maxSpeed = LIMITS.maxSpeed } = {}) {
  const sorted = (Array.isArray(points) ? points : [])
    .filter((p) => p && finite(p.t) && finite(p.lat) && finite(p.lon) && Math.abs(p.lat) <= 90 && Math.abs(p.lon) <= 180)
    .slice()
    .sort((a, b) => a.t - b.t);
  const out = [];
  for (const p of sorted) {
    const prev = out[out.length - 1];
    if (prev && p.t === prev.t) continue;
    // A position jump faster than any car is a bad fix: skip it and measure the next one against the
    // last good fix. (A long gap makes almost any jump plausible, which is right after a tunnel.)
    if (prev && haversine(prev, p) / ((p.t - prev.t) / 1000) > maxSpeed) continue;
    out.push(p);
  }
  return out;
}

/** Positions smoothed with a 1-2-1 kernel over neighbours (not across gaps); endpoints kept. */
function smoothPositions(fx) {
  return fx.map((p, i) => {
    const a = fx[i - 1];
    const b = fx[i + 1];
    if (!a || !b || p.t - a.t > LIMITS.gapMs || b.t - p.t > LIMITS.gapMs) return { lat: p.lat, lon: p.lon };
    return { lat: (a.lat + 2 * p.lat + b.lat) / 4, lon: (a.lon + 2 * p.lon + b.lon) / 4 };
  });
}

/** Indices [lo, hi] of the fixes within ±half ms of fx[i]. */
function windowAround(fx, i, half) {
  let lo = i;
  let hi = i;
  while (lo > 0 && fx[i].t - fx[lo - 1].t <= half) lo--;
  while (hi < fx.length - 1 && fx[hi + 1].t - fx[i].t <= half) hi++;
  return [lo, hi];
}

const median = (xs) => {
  const s = xs.slice().sort((a, b) => a - b);
  const m = s.length >> 1;
  return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2;
};

/**
 * Per-fix speed in m/s: the device's coords.speed when it is plausible, else the speed derived from
 * the smoothed positions around the fix; then a time-window median (rejects spikes) and mean.
 */
function speedSeries(fx, pos) {
  const derived = fx.map((p, i) => {
    const a = i > 0 && p.t - fx[i - 1].t <= LIMITS.gapMs ? i - 1 : i;
    const b = i < fx.length - 1 && fx[i + 1].t - p.t <= LIMITS.gapMs ? i + 1 : i;
    if (a === b) return 0;
    return haversine(pos[a], pos[b]) / ((fx[b].t - fx[a].t) / 1000);
  });
  const raw = fx.map((p, i) => (finite(p.speed) && p.speed >= 0 && p.speed <= LIMITS.maxSpeed ? p.speed : derived[i]));
  const half = SPEED_WINDOW_MS / 2;
  const win = fx.map((_, i) => windowAround(fx, i, half));
  const med = win.map(([lo, hi]) => median(raw.slice(lo, hi + 1)));
  return win.map(([lo, hi]) => {
    let s = 0;
    for (let k = lo; k <= hi; k++) s += med[k];
    return s / (hi - lo + 1);
  });
}

/** Acceleration (m/s²) at each fix: Δv across the ~ACCEL_WINDOW_MS around it; physically impossible values read 0. */
function accelSeries(fx, v) {
  const half = ACCEL_WINDOW_MS / 2;
  return fx.map((_, i) => {
    const [lo, hi] = windowAround(fx, i, half);
    const dt = (fx[hi].t - fx[lo].t) / 1000;
    if (hi === lo || dt < 1) return 0;
    const a = (v[hi] - v[lo]) / dt;
    return Math.abs(a) > LIMITS.maxAccel ? 0 : a;
  });
}

/**
 * Everything about one trip. `timeline` is downsampled to at most `timelinePoints` entries
 * {t: s since start, d: m driven so far, v: m/s, a: m/s²} for charts; leave it out with timeline:false.
 * Distances in m, times in s, speeds in m/s, accelerations in m/s² (maxBrake is positive).
 */
export function tripStats(points, { timeline = true, timelinePoints = TIMELINE_POINTS } = {}) {
  const fx = cleanFixes(points);
  if (fx.length < 2) {
    const p = fx[0];
    const out = {
      pointCount: fx.length, startedAt: p?.t ?? null, endedAt: p?.t ?? null,
      distance: 0, duration: 0, movingTime: 0, avgSpeed: 0, maxSpeed: 0, maxAccel: 0, maxBrake: 0,
      bbox: p ? [p.lon, p.lat, p.lon, p.lat] : null,
      start: p ? { lat: p.lat, lon: p.lon } : null, end: p ? { lat: p.lat, lon: p.lon } : null,
    };
    return timeline ? { ...out, timeline: [] } : out;
  }

  const pos = smoothPositions(fx);
  const v = speedSeries(fx, pos);
  const a = accelSeries(fx, v);
  const cum = [0];
  let distance = 0;
  let movingTime = 0;
  for (let i = 1; i < fx.length; i++) {
    const dt = (fx[i].t - fx[i - 1].t) / 1000;
    const d = haversine(pos[i - 1], pos[i]);
    // Standing still, the position still creeps by GPS wobble; that is not distance. Across a signal
    // gap the speed series says nothing, so judge the gap by its straight-line speed.
    const moving = dt > LIMITS.gapMs / 1000 ? d / dt >= LIMITS.movingSpeed : (v[i - 1] + v[i]) / 2 >= LIMITS.movingSpeed;
    if (moving) { distance += d; movingTime += dt; }
    cum.push(distance);
  }
  let w = Infinity, s = Infinity, e = -Infinity, n = -Infinity;
  for (const p of fx) { w = Math.min(w, p.lon); e = Math.max(e, p.lon); s = Math.min(s, p.lat); n = Math.max(n, p.lat); }
  const first = fx[0];
  const last = fx[fx.length - 1];
  const out = {
    pointCount: fx.length,
    startedAt: first.t,
    endedAt: last.t,
    distance,
    duration: (last.t - first.t) / 1000,
    movingTime,
    avgSpeed: movingTime > 0 ? distance / movingTime : 0,
    maxSpeed: v.reduce((m, x) => Math.max(m, x), 0),
    maxAccel: a.reduce((m, x) => Math.max(m, x), 0),
    maxBrake: a.reduce((m, x) => Math.max(m, -x), 0),
    bbox: [w, s, e, n],
    start: { lat: first.lat, lon: first.lon },
    end: { lat: last.lat, lon: last.lon },
  };
  if (timeline) out.timeline = downsample(fx, v, a, cum, timelinePoints);
  return out;
}

const round = (x, dp) => { const f = 10 ** dp; return Math.round(x * f) / f; };

/** Average into at most `max` equal time buckets, so a 3-hour trip charts as cheaply as a 3-minute one. */
function downsample(fx, v, a, cum, max) {
  const t0 = fx[0].t;
  const span = Math.max(1, fx[fx.length - 1].t - t0);
  const buckets = Math.min(max, fx.length);
  const out = [];
  let i = 0;
  for (let b = 0; b < buckets; b++) {
    const end = b === buckets - 1 ? Infinity : t0 + (span * (b + 1)) / buckets;
    let k = 0, tv = 0, vv = 0, av = 0, d = 0;
    for (; i < fx.length && fx[i].t <= end; i++, k++) { tv += fx[i].t; vv += v[i]; av += a[i]; d = cum[i]; }
    if (k) out.push({ t: round((tv / k - t0) / 1000, 1), d: round(d, 1), v: round(vv / k, 2), a: round(av / k, 2) });
  }
  return out;
}

/**
 * Totals across trip summaries (tripStats outputs carrying an `id`): count, distance, time, overall
 * average (total distance / total moving time), top speed and longest trip (by distance).
 */
export function aggregateTrips(summaries) {
  const list = (Array.isArray(summaries) ? summaries : []).filter((x) => x && finite(x.distance));
  const totals = {
    trips: list.length, distance: 0, duration: 0, movingTime: 0, avgSpeed: 0,
    maxSpeed: 0, maxSpeedTrip: null, maxAccel: 0, maxBrake: 0,
    longest: null, firstAt: null, lastAt: null,
  };
  for (const x of list) {
    totals.distance += x.distance;
    totals.duration += x.duration || 0;
    totals.movingTime += x.movingTime || 0;
    if ((x.maxSpeed || 0) > totals.maxSpeed) { totals.maxSpeed = x.maxSpeed; totals.maxSpeedTrip = x.id ?? null; }
    totals.maxAccel = Math.max(totals.maxAccel, x.maxAccel || 0);
    totals.maxBrake = Math.max(totals.maxBrake, x.maxBrake || 0);
    if (!totals.longest || x.distance > totals.longest.distance) totals.longest = { id: x.id ?? null, distance: x.distance, duration: x.duration || 0 };
    if (finite(x.startedAt)) totals.firstAt = totals.firstAt == null ? x.startedAt : Math.min(totals.firstAt, x.startedAt);
    if (finite(x.endedAt)) totals.lastAt = totals.lastAt == null ? x.endedAt : Math.max(totals.lastAt, x.endedAt);
  }
  totals.avgSpeed = totals.movingTime > 0 ? totals.distance / totals.movingTime : 0;
  return totals;
}
