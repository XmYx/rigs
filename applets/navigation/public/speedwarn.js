// Speed limits and speed-camera warnings: pure functions shared by the browser (app.js), the server
// (maxspeed parsing for the Overpass fallback) and the unit tests. No DOM, no network.
import { angleDelta, bearing, haversine } from './geo.js';

const KMH_PER_MPH = 1.609344;

// OSM implicit limits, `maxspeed=<country>:<zone>`: [urban, rural, motorway] in km/h; null = no general
// limit (or one that depends on more than the zone). Only countries whose values we are sure of.
const IMPLICIT = {
  AT: [50, 100, 130], BE: [50, 70, 120], CH: [50, 80, 120], CZ: [50, 90, 130], DE: [50, 100, null],
  DK: [50, 80, 130], ES: [50, 90, 120], FR: [50, 80, 130], GB: [48, 96, 112], HR: [50, 90, 130],
  HU: [50, 90, 130], IE: [50, 80, 120], IT: [50, 90, 130], NL: [50, 80, 100], PL: [50, 90, 140],
  PT: [50, 90, 120], RO: [50, 90, 130], RS: [50, 80, 120], SI: [50, 90, 130], SK: [50, 90, 130],
};
const ZONE = { urban: 0, rural: 1, motorway: 2 };
// A few zones that are not the generic three but are the same everywhere we know.
const NAMED = { 'GB:nsl_single': 96, 'GB:nsl_dual': 112, 'GB:motorway': 112, 'HU:trunk': 110, 'RO:trunk': 100, 'PL:expressway': 120 };

const valid = (kmh) => (Number.isFinite(kmh) && kmh >= 5 && kmh <= 200 ? Math.round(kmh) : null);

/**
 * An OSM `maxspeed` value → km/h (whole number) or null. Handles '50', '50 km/h', '30 mph' (→ 48),
 * implicit values ('RO:urban', 'GB:nsl_single'), and lists ('50;30' → the lower one). 'none',
 * 'signals', 'walk', 'variable', empty and nonsense → null. OSRM's `{speed, unit}` objects are accepted too.
 */
export function parseMaxspeed(raw) {
  if (raw == null) return null;
  if (typeof raw === 'object') {
    if (!Number.isFinite(raw.speed)) return null;
    return valid(String(raw.unit || '').toLowerCase().startsWith('mph') ? raw.speed * KMH_PER_MPH : raw.speed);
  }
  if (typeof raw === 'number') return valid(raw);
  const parts = String(raw).split(';').map((s) => s.trim().toLowerCase()).filter(Boolean);
  let best = null;
  for (const part of parts) {
    const one = parseOne(part);
    if (one != null && (best == null || one < best)) best = one;
  }
  return best;
}

function parseOne(s) {
  const num = /^(\d+(?:\.\d+)?)\s*(km\/h|kmh|kph|mph)?$/.exec(s);
  if (num) return valid(num[2] === 'mph' ? Number(num[1]) * KMH_PER_MPH : Number(num[1]));
  const imp = /^([a-z]{2}(?:-[a-z]{2,3})?):([a-z_]+)$/.exec(s);
  if (!imp) return null;
  const key = `${imp[1].toUpperCase()}:${imp[2]}`;
  if (key in NAMED) return NAMED[key];
  const row = IMPLICIT[imp[1].toUpperCase()];
  return row && imp[2] in ZONE ? valid(row[ZONE[imp[2]]]) : null;
}

/**
 * The road limit (km/h) at the driver's place on the route, or null when unknown. `routeProgress` is
 * what geo.routeProgress returns (`index` = the route segment the driver is on); `limits` is the
 * per-segment array api/route (or api/route/limits) returns, aligned to the route geometry.
 */
export function currentLimit(routeProgress, limits) {
  if (!routeProgress || !Array.isArray(limits)) return null;
  const v = limits[routeProgress.index];
  return Number.isFinite(v) && v > 0 ? v : null;
}

/** How far ahead (m) a camera starts to count: 300 m up to 30 km/h, growing to 800 m at 130 km/h and above. */
export function cameraWarnRadius(speedKmh) {
  const v = Number.isFinite(speedKmh) ? speedKmh : 0;
  return Math.max(300, Math.min(800, 300 + (v - 30) * 5));
}

/**
 * The nearest camera the driver is about to pass: within `maxM`, inside `coneDeg` either side of the
 * heading, and — when the camera has a `direction` (the direction of travel it enforces, as OSM
 * `direction`/`camera:direction` is read here) — only when the driver travels that way (± `dirTolDeg`).
 * `pos` {lat, lon}, `heading` degrees. → {camera, distanceM} or null (also when heading is unknown).
 */
export function nearestCameraAhead(pos, heading, cameras, { maxM = 800, coneDeg = 40, dirTolDeg = 60 } = {}) {
  if (!pos || !Number.isFinite(heading) || !Array.isArray(cameras)) return null;
  let best = null;
  for (const camera of cameras) {
    if (!camera || !Number.isFinite(camera.lat) || !Number.isFinite(camera.lon)) continue;
    const distanceM = haversine(pos, camera);
    if (distanceM > maxM || (best && distanceM >= best.distanceM)) continue;
    // Right on top of the camera the bearing to it is noise: only the direction check can tell.
    if (distanceM > 15 && Math.abs(angleDelta(heading, bearing(pos, camera))) > coneDeg) continue;
    if (Number.isFinite(camera.direction) && Math.abs(angleDelta(heading, camera.direction)) > dirTolDeg) continue;
    best = { camera, distanceM };
  }
  return best;
}

/** Speeding tolerance (km/h) over a limit: 3 km/h or 5 %, whichever is larger. */
export const speedTolerance = (limitKmh) => Math.max(3, limitKmh * 0.05);

/**
 * What to show the driver:
 *  - 'camera-speeding': a camera is within the warning radius and the driver is over its limit (flash red/blue)
 *  - 'camera-near':     a camera is within the warning radius and the driver is not speeding
 *  - 'speeding':        no camera in range, but over the road limit (keep the limit on screen)
 *  - 'none':            otherwise, including when no limit is known
 * The camera's own `maxspeed` replaces the road limit once it is in range. `distanceM` is the distance
 * to `camera` (from nearestCameraAhead); without it the camera is ignored.
 */
export function warningState({ speedKmh, limitKmh, camera, distanceM } = {}) {
  const inRange = !!camera && Number.isFinite(distanceM) && distanceM <= cameraWarnRadius(speedKmh);
  const limit = inRange && Number.isFinite(camera.maxspeed) ? camera.maxspeed : limitKmh;
  const speeding = Number.isFinite(speedKmh) && Number.isFinite(limit) && limit > 0 && speedKmh > limit + speedTolerance(limit);
  if (inRange) return speeding ? 'camera-speeding' : 'camera-near';
  return speeding ? 'speeding' : 'none';
}
