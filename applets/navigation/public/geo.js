// Pure navigation math shared by the browser (app.js) and the unit tests: distances, speed from GPS
// fixes, unit conversion, route progress along a polyline, and the text the HUD shows. No DOM here.

export const EARTH_RADIUS_M = 6371008.8;
export const KMH_PER_MS = 3.6;
export const MPH_PER_MS = 2.2369362920544025;

const rad = (d) => (d * Math.PI) / 180;
const deg = (r) => (r * 180) / Math.PI;

/** Great-circle distance in metres between {lat, lon} points. */
export function haversine(a, b) {
  const dLat = rad(b.lat - a.lat);
  const dLon = rad(b.lon - a.lon);
  const h = Math.sin(dLat / 2) ** 2 + Math.cos(rad(a.lat)) * Math.cos(rad(b.lat)) * Math.sin(dLon / 2) ** 2;
  return 2 * EARTH_RADIUS_M * Math.asin(Math.min(1, Math.sqrt(h)));
}

/** Initial bearing from a to b, degrees clockwise from north in [0, 360). */
export function bearing(a, b) {
  const y = Math.sin(rad(b.lon - a.lon)) * Math.cos(rad(b.lat));
  const x = Math.cos(rad(a.lat)) * Math.sin(rad(b.lat)) - Math.sin(rad(a.lat)) * Math.cos(rad(b.lat)) * Math.cos(rad(b.lon - a.lon));
  return normalizeHeading(deg(Math.atan2(y, x)));
}

export function normalizeHeading(h) {
  const n = h % 360;
  return n < 0 ? n + 360 : n;
}

/** Signed smallest rotation from `from` to `to`, in (-180, 180]. */
export function angleDelta(from, to) {
  const d = normalizeHeading(to - from);
  return d > 180 ? d - 360 : d;
}

/** Move `from` towards `to` by `t` (0..1) along the short way round. */
export function lerpHeading(from, to, t) {
  return normalizeHeading(from + angleDelta(from, to) * t);
}

export function msToKmh(ms) { return ms * KMH_PER_MS; }
export function msToMph(ms) { return ms * MPH_PER_MS; }
export function kmhToMs(kmh) { return kmh / KMH_PER_MS; }
export function mphToMs(mph) { return mph / MPH_PER_MS; }

/** Speed in m/s → the number shown for `unit` ('kmh' | 'mph'). */
export function speedIn(ms, unit) {
  return unit === 'mph' ? msToMph(ms) : msToKmh(ms);
}

/**
 * Speed in m/s between two fixes {lat, lon, t} (t in ms), or null when the pair can't give one:
 * same or reversed timestamps, or a gap so long the straight line says nothing about speed.
 */
export function speedFromFixes(prev, cur, { maxGapMs = 15000 } = {}) {
  if (!prev || !cur) return null;
  const dt = (cur.t - prev.t) / 1000;
  if (!(dt > 0) || dt * 1000 > maxGapMs) return null;
  return haversine(prev, cur) / dt;
}

/**
 * Turns a stream of geolocation fixes into a steady speed and heading. Prefers the device's own
 * coords.speed / coords.heading; otherwise derives them from successive fixes (over a short window,
 * so GPS jitter while parked doesn't read as walking pace) and smooths the result.
 */
export function createMotionEstimator({ windowMs = 4000, smoothing = 0.45, jitterM = 4 } = {}) {
  const fixes = [];
  let speed = null;
  let heading = null;
  return {
    update(fix) {
      fixes.push(fix);
      while (fixes.length > 2 && fix.t - fixes[0].t > windowMs) fixes.shift();
      let raw = null;
      let source = null;
      if (Number.isFinite(fix.speed) && fix.speed >= 0) { raw = fix.speed; source = 'gps'; }
      else if (fixes.length >= 2) {
        const first = fixes[0];
        const d = haversine(first, fix);
        const accuracy = Math.max(first.accuracy || 0, fix.accuracy || 0);
        raw = d < Math.max(jitterM, accuracy * 0.5) ? 0 : speedFromFixes(first, fix, { maxGapMs: windowMs * 4 });
        if (raw != null) source = 'derived';
      }
      if (raw != null) speed = speed == null ? raw : speed + (raw - speed) * (1 - smoothing);
      const prev = fixes.length >= 2 ? fixes[fixes.length - 2] : null;
      if (Number.isFinite(fix.heading) && (fix.speed == null || fix.speed > 0.5)) heading = normalizeHeading(fix.heading);
      else if (prev && haversine(prev, fix) > jitterM) heading = bearing(prev, fix);
      return { speed, heading, source };
    },
    reset() { fixes.length = 0; speed = null; heading = null; },
  };
}

/** "350 m" / "1.2 km" (metric) or "500 ft" / "0.8 mi" (imperial). */
export function formatDistance(m, unit = 'kmh') {
  if (!Number.isFinite(m)) return '—';
  if (unit === 'mph') {
    const mi = m / 1609.344;
    if (mi < 0.1) return `${Math.max(0, Math.round((m * 3.28084) / 10) * 10)} ft`;
    return `${mi < 10 ? mi.toFixed(1) : Math.round(mi)} mi`;
  }
  if (m < 1000) return `${Math.max(0, Math.round(m / 10) * 10)} m`;
  return `${m < 10000 ? (m / 1000).toFixed(1) : Math.round(m / 1000)} km`;
}

/** "45 s", "12 min" or "1 h 05 min". */
export function formatDuration(s) {
  if (!Number.isFinite(s)) return '—';
  if (s < 60) return `${Math.max(0, Math.round(s))} s`;
  const min = Math.round(s / 60);
  if (min < 60) return `${min} min`;
  return `${Math.floor(min / 60)} h ${String(min % 60).padStart(2, '0')} min`;
}

const CARDINALS = ['N', 'NE', 'E', 'SE', 'S', 'SW', 'W', 'NW'];
export function cardinal(h) {
  return CARDINALS[Math.round(normalizeHeading(h) / 45) % 8];
}

// ---- Route geometry ------------------------------------------------------------------------------

const pt = (c) => ({ lon: c[0], lat: c[1] });

/** Cumulative distance (m) at each vertex of a [lon, lat][] line. */
export function cumulativeDistances(coords) {
  const out = [0];
  for (let i = 1; i < coords.length; i++) out.push(out[i - 1] + haversine(pt(coords[i - 1]), pt(coords[i])));
  return out;
}

/**
 * Nearest point on the line to `p` {lat, lon}: segment index, distance along the line, and the
 * perpendicular offset in metres. Uses a local flat projection, plenty for road-scale segments.
 * `fromIndex` limits the search to segments at or after that vertex.
 */
export function projectOnLine(coords, cum, p, fromIndex = 0) {
  if (coords.length === 1) return { index: 0, along: 0, offset: haversine(pt(coords[0]), p) };
  const kx = Math.cos(rad(p.lat)) * rad(1) * EARTH_RADIUS_M;
  const ky = rad(1) * EARTH_RADIUS_M;
  let best = { index: fromIndex, along: cum[fromIndex] || 0, offset: Infinity };
  for (let i = fromIndex; i < coords.length - 1; i++) {
    const ax = (coords[i][0] - p.lon) * kx, ay = (coords[i][1] - p.lat) * ky;
    const bx = (coords[i + 1][0] - p.lon) * kx, by = (coords[i + 1][1] - p.lat) * ky;
    const dx = bx - ax, dy = by - ay;
    const len2 = dx * dx + dy * dy;
    const t = len2 ? Math.max(0, Math.min(1, -(ax * dx + ay * dy) / len2)) : 0;
    const off = Math.hypot(ax + dx * t, ay + dy * t);
    if (off < best.offset) best = { index: i, along: cum[i] + (cum[i + 1] - cum[i]) * t, offset: off };
  }
  return best;
}

/** The point `dist` metres along the line, with the bearing of the segment it lies on. */
export function pointAlong(coords, cum, dist) {
  const total = cum[cum.length - 1];
  const d = Math.max(0, Math.min(total, dist));
  let i = 0;
  while (i < cum.length - 2 && cum[i + 1] < d) i++;
  const seg = cum[i + 1] - cum[i];
  const t = seg > 0 ? (d - cum[i]) / seg : 0;
  const a = coords[i], b = coords[Math.min(i + 1, coords.length - 1)];
  return {
    lon: a[0] + (b[0] - a[0]) * t,
    lat: a[1] + (b[1] - a[1]) * t,
    bearing: bearing(pt(a), pt(b)),
    index: i,
  };
}

/** Distance along the line of each step's maneuver point (steps carry `location` [lon, lat]). */
export function stepOffsets(coords, cum, steps) {
  let from = 0;
  return steps.map((s) => {
    // Maneuvers come in route order, so search forward from the previous one (a route can pass
    // the same spot twice).
    const hit = projectOnLine(coords, cum, pt(s.location), from);
    from = hit.index;
    return hit.along;
  });
}

/**
 * Where we are on a route: the next maneuver, distance to it, and what is left. `route` is the
 * shape the server returns from api/route (geometry [lon, lat][], steps with distance/duration).
 */
export function routeProgress(route, p) {
  if (!route.cum) route.cum = cumulativeDistances(route.geometry);
  if (!route.stepAt) route.stepAt = stepOffsets(route.geometry, route.cum, route.steps);
  const total = route.cum[route.cum.length - 1];
  const hit = projectOnLine(route.geometry, route.cum, p);
  let next = route.steps.length - 1;
  for (let i = 0; i < route.steps.length; i++) {
    if (route.stepAt[i] > hit.along + 1) { next = i; break; }
  }
  const remaining = Math.max(0, total - hit.along);
  // Time left: the untravelled share of the current step plus every later step.
  let timeLeft = 0;
  for (let i = 0; i < route.steps.length; i++) {
    const start = route.stepAt[i];
    const end = i + 1 < route.steps.length ? route.stepAt[i + 1] : total;
    if (end <= hit.along) continue;
    const len = end - start;
    const share = len > 0 ? Math.min(1, (end - Math.max(start, hit.along)) / len) : 1;
    timeLeft += (route.steps[i].duration || 0) * share;
  }
  return {
    along: hit.along,
    offset: hit.offset,
    nextIndex: next,
    nextStep: route.steps[next],
    toNext: Math.max(0, (route.stepAt[next] ?? total) - hit.along),
    remaining,
    timeLeft,
    arrived: remaining < 20,
  };
}

// ---- Maneuver text -------------------------------------------------------------------------------

function ordinal(n) {
  const s = ['th', 'st', 'nd', 'rd'];
  const v = n % 100;
  return n + (s[(v - 20) % 10] || s[v] || s[0]);
}

/** A short instruction for an OSRM-style step {type, modifier, name, exit}. */
export function maneuverText(step) {
  if (!step) return '';
  const { type, modifier = '', name = '', exit } = step;
  const onto = name ? ` onto ${name}` : '';
  switch (type) {
    case 'depart': return name ? `Head along ${name}` : 'Head out';
    case 'arrive': return 'Arrive at destination';
    case 'roundabout':
    case 'rotary':
      return exit ? `At the roundabout, take the ${ordinal(exit)} exit${onto}` : `Enter the roundabout${onto}`;
    case 'exit roundabout':
    case 'exit rotary': return `Exit the roundabout${onto}`;
    case 'merge': return `Merge${onto}`;
    case 'on ramp': return `Take the ramp${onto}`;
    case 'off ramp': return `Take the exit${onto}`;
    case 'fork': return `Keep ${modifier.includes('left') ? 'left' : 'right'}${onto}`;
    case 'continue':
    case 'new name': return name ? `Continue on ${name}` : 'Continue straight';
    default:
      if (modifier === 'straight' || !modifier) return name ? `Continue on ${name}` : 'Continue straight';
      if (modifier === 'uturn') return `Make a U-turn${onto}`;
      return `Turn ${modifier}${onto}`;
  }
}

/** A single arrow glyph for the maneuver. */
export function maneuverArrow(step) {
  if (!step) return '↑';
  if (step.type === 'arrive') return '◎';
  if (step.type === 'roundabout' || step.type === 'rotary') return '↻';
  const m = step.modifier || '';
  if (m === 'uturn') return '↶';
  if (m.includes('left')) return m.includes('slight') ? '↖' : '↰';
  if (m.includes('right')) return m.includes('slight') ? '↗' : '↱';
  return '↑';
}

/** Follow-cam zoom: closer in town, further out at motorway speed. */
export function zoomForSpeed(ms) {
  const kmh = Math.max(0, msToKmh(ms || 0));
  return 17.4 - Math.min(1, kmh / 130) * 2.2;
}
