// Speed cameras and speed limits from OpenStreetMap for the navigation applet:
//   cameras(bbox)             OSM speed cameras (Overpass) → [{id, lat, lon, maxspeed, direction}]
//   camerasAlongRoute(route)  the same, only those within ~80 m of a route polyline
//   routeLimits(route)        per-segment road limit (km/h | null) aligned to the route geometry
// Everything degrades to empty/null data with a status string instead of throwing: a dead Overpass
// must never break routing. Upstream calls go through the polite cached client from server.js.
import { angleDelta, bearing, haversine, projectOnLine } from './public/geo.js';
import { parseMaxspeed } from './public/speedwarn.js';

const CARDINALS = { N: 0, NNE: 22.5, NE: 45, ENE: 67.5, E: 90, ESE: 112.5, SE: 135, SSE: 157.5, S: 180, SSW: 202.5, SW: 225, WSW: 247.5, W: 270, WNW: 292.5, NW: 315, NNW: 337.5 };
const CAMERA_TTL = 6 * 60 * 60 * 1000; // cameras move rarely
const FAIL_TTL = 30 * 1000; // after a failure, leave Overpass alone for a moment
const SNAP = 0.05; // degrees: cached camera boxes snap outward to this grid, so panning shares them
export const MAX_BBOX_SPAN = 0.5; // degrees per side for one cameras query
const MAX_CHUNKS = 6; // a route is queried in ≤6 pieces; the rest of a very long route has no limits
const CHUNK_M = 25000;
const CORRIDOR_M = 80;
const MATCH_M = 30;

/** OSM `direction` / `camera:direction`: degrees or a compass point → degrees [0,360), else null ('forward' etc.). */
export function parseDirection(raw) {
  if (raw == null) return null;
  const s = String(raw).trim();
  if (/^-?\d+(\.\d+)?$/.test(s)) return ((Number(s) % 360) + 360) % 360;
  return s.toUpperCase() in CARDINALS ? CARDINALS[s.toUpperCase()] : null;
}

const snapDown = (v) => Math.floor(v / SNAP + 1e-9) * SNAP;
const snapUp = (v) => Math.ceil(v / SNAP - 1e-9) * SNAP;
const r5 = (v) => Math.round(v * 1e5) / 1e5;

/** Overpass QL for the cameras in a box: the nodes, plus enforcement relations with their `device` nodes. */
export function camerasQuery([w, s, e, n]) {
  const b = `${s},${w},${n},${e}`;
  return `[out:json][timeout:40];(node["highway"="speed_camera"](${b});node["enforcement"="maxspeed"](${b}););out body;`
    + `rel["type"="enforcement"]["enforcement"="maxspeed"](${b})->.r;.r out body;node(r.r:"device");out body;`;
}

/** Overpass response → [{id, lat, lon, maxspeed, direction}]; red-light cameras and duplicates dropped. */
export function normalizeCameras(data) {
  const els = Array.isArray(data?.elements) ? data.elements : [];
  const nodes = new Map();
  for (const el of els) if (el.type === 'node' && Number.isFinite(el.lat) && Number.isFinite(el.lon)) nodes.set(el.id, el);
  // A relation's maxspeed applies to its device nodes that have none of their own.
  const inherited = new Map();
  for (const el of els) {
    if (el.type !== 'relation') continue;
    const limit = parseMaxspeed(el.tags?.maxspeed);
    for (const m of el.members || []) if (m.type === 'node' && m.role === 'device' && !inherited.has(m.ref)) inherited.set(m.ref, limit);
  }
  const out = [];
  for (const el of nodes.values()) {
    const t = el.tags || {};
    const enf = t.enforcement;
    const isCam = t.highway === 'speed_camera' || enf === 'maxspeed' || enf === 'average_speed' || inherited.has(el.id);
    if (!isCam) continue;
    if (enf && enf !== 'maxspeed' && enf !== 'average_speed') continue; // traffic_signals, no_stopping, …
    out.push({
      id: `n${el.id}`, lat: r5(el.lat), lon: r5(el.lon),
      maxspeed: parseMaxspeed(t.maxspeed) ?? inherited.get(el.id) ?? null,
      direction: parseDirection(t['camera:direction'] ?? t.direction),
    });
  }
  return out;
}

// ---- Route limits ---------------------------------------------------------------------------------

/**
 * OSRM `annotation.maxspeed` (per leg: {speed, unit} | {unknown:true} | {none:true}) → per-segment km/h
 * | null aligned to `geometry`, or null when absent or not aligned (then the Overpass fallback runs).
 */
export function osrmLimits(route, geometryLength) {
  const legs = route?.legs;
  if (!Array.isArray(legs) || !legs.length) return null;
  const out = [];
  for (const leg of legs) {
    const ms = leg?.annotation?.maxspeed;
    if (!Array.isArray(ms)) return null;
    for (const m of ms) out.push(parseMaxspeed(m));
  }
  if (out.length !== geometryLength - 1) return null;
  return out.some((v) => v != null) ? out : null; // all-unknown is no better than "no data": try the fallback
}

/** Overpass QL for every way with a maxspeed tag in a box, with geometry. */
export function waysQuery([w, s, e, n]) {
  return `[out:json][timeout:40];way["highway"]["maxspeed"](${s},${w},${n},${e});out tags geom;`;
}

const CELL = 0.001; // ~100 m
const cellKey = (x, y) => `${Math.floor(x / CELL)},${Math.floor(y / CELL)}`;

/**
 * Per-segment limits for `geometry` ([lon,lat][]) from Overpass ways [{limit, coords}]: each segment takes the
 * limit of the nearest way within 30 m that runs the same way (±30°, either direction); null if none.
 */
export function limitsFromWays(geometry, ways) {
  const index = new Map();
  for (const w of ways) {
    for (let i = 0; i + 1 < w.coords.length; i++) {
      const a = w.coords[i], b = w.coords[i + 1];
      const seg = { limit: w.limit, a, b, brg: bearing({ lon: a[0], lat: a[1] }, { lon: b[0], lat: b[1] }) };
      const x0 = Math.floor(Math.min(a[0], b[0]) / CELL), x1 = Math.floor(Math.max(a[0], b[0]) / CELL);
      const y0 = Math.floor(Math.min(a[1], b[1]) / CELL), y1 = Math.floor(Math.max(a[1], b[1]) / CELL);
      for (let x = x0; x <= x1; x++) for (let y = y0; y <= y1; y++) {
        const k = `${x},${y}`;
        if (!index.has(k)) index.set(k, []);
        index.get(k).push(seg);
      }
    }
  }
  const out = [];
  for (let i = 0; i + 1 < geometry.length; i++) {
    const a = geometry[i], b = geometry[i + 1];
    const mid = { lon: (a[0] + b[0]) / 2, lat: (a[1] + b[1]) / 2 };
    const brg = bearing({ lon: a[0], lat: a[1] }, { lon: b[0], lat: b[1] });
    let best = null, bestOff = MATCH_M;
    for (let dx = -1; dx <= 1; dx++) for (let dy = -1; dy <= 1; dy++) {
      const segs = index.get(cellKey(mid.lon + dx * CELL, mid.lat + dy * CELL));
      if (!segs) continue;
      for (const s of segs) {
        const d = Math.abs(angleDelta(brg, s.brg));
        if (Math.min(d, 180 - d) > 30) continue;
        const off = projectOnLine([s.a, s.b], [0, haversine({ lon: s.a[0], lat: s.a[1] }, { lon: s.b[0], lat: s.b[1] })], mid).offset;
        if (off < bestOff) { best = s.limit; bestOff = off; }
      }
    }
    out.push(best);
  }
  return out;
}

/** Overpass `out tags geom` response → [{limit, coords:[[lon,lat]…]}], ways without a usable limit dropped. */
export function normalizeWays(data) {
  const out = [];
  for (const el of Array.isArray(data?.elements) ? data.elements : []) {
    if (el.type !== 'way' || !Array.isArray(el.geometry)) continue;
    const limit = parseMaxspeed(el.tags?.maxspeed);
    if (limit != null) out.push({ limit, coords: el.geometry.map((g) => [g.lon, g.lat]) });
  }
  return out;
}

/** Split a polyline into index ranges [from, to] (shared end vertex) of about `lenM` each. */
export function chunkRanges(cum, lenM = CHUNK_M) {
  const out = [];
  let from = 0;
  for (let i = 1; i < cum.length; i++) {
    if (cum[i] - cum[from] >= lenM || i === cum.length - 1) { out.push([from, i]); from = i; }
  }
  return out;
}

function boxOf(points, pad = 0.002) {
  let w = Infinity, s = Infinity, e = -Infinity, n = -Infinity;
  for (const [x, y] of points) { w = Math.min(w, x); e = Math.max(e, x); s = Math.min(s, y); n = Math.max(n, y); }
  return [w - pad, s - pad, e + pad, n + pad];
}

/**
 * Overpass-backed service. `getJson(url, opts)` is the polite cached client from server.js; `overpassUrl`
 * the configured endpoint (NAV_OVERPASS_URL).
 */
export function createSpeedcams({ overpassUrl, getJson, now = Date.now, log = () => {} }) {
  const failures = new Map();
  const endpoint = (q) => `${overpassUrl}/api/interpreter?data=${encodeURIComponent(q)}`;

  /** One Overpass fetch, with a short negative cache so a dead server is not hammered. */
  async function fetchOverpass(q, opts) {
    const down = failures.get(q);
    if (down && now() - down < FAIL_TTL) throw new Error('Overpass recently failed');
    try { return await getJson(endpoint(q), opts); }
    catch (e) { failures.set(q, now()); if (failures.size > 200) failures.delete(failures.keys().next().value); throw e; }
  }

  async function snapped(bbox) {
    const box = [snapDown(bbox[0]), snapDown(bbox[1]), snapUp(bbox[2]), snapUp(bbox[3])].map(r5);
    return normalizeCameras(await fetchOverpass(camerasQuery(box), { ttlMs: CAMERA_TTL, timeoutMs: 45000 }));
  }

  /** → {status: 'ok' | 'unavailable', cameras, error?}; never throws. */
  async function cameras(bbox) {
    try {
      const inBox = (c) => c.lon >= bbox[0] && c.lon <= bbox[2] && c.lat >= bbox[1] && c.lat <= bbox[3];
      return { status: 'ok', cameras: (await snapped(bbox)).filter(inBox) };
    } catch (e) {
      log('navigation: speed cameras unavailable:', e.message);
      return { status: 'unavailable', cameras: [], error: e.message };
    }
  }

  /** Cameras within ~80 m of the route (`route` = traffic.routeInfo: {geometry, cum}). */
  async function camerasAlongRoute(route) {
    const seen = new Map();
    let failed = null;
    for (const [from, to] of chunkRanges(route.cum).slice(0, MAX_CHUNKS)) {
      const box = boxOf(route.geometry.slice(from, to + 1));
      if (box[2] - box[0] > MAX_BBOX_SPAN || box[3] - box[1] > MAX_BBOX_SPAN) { failed = 'route piece too large'; continue; }
      try { for (const c of await snapped(box)) seen.set(c.id, c); }
      catch (e) { failed = e.message; }
    }
    if (failed) log('navigation: speed cameras along route incomplete:', failed);
    const list = [...seen.values()].filter((c) => projectOnLine(route.geometry, route.cum, c).offset <= CORRIDOR_M);
    return failed && !list.length ? { status: 'unavailable', cameras: [], error: failed } : { status: failed ? 'partial' : 'ok', cameras: list, ...(failed ? { error: failed } : {}) };
  }

  /** Overpass fallback → {source: 'overpass' | 'none', limits: [...] | null}; never throws. */
  async function routeLimits(route) {
    const limits = new Array(Math.max(0, route.geometry.length - 1)).fill(null);
    let any = false;
    for (const [from, to] of chunkRanges(route.cum).slice(0, MAX_CHUNKS)) {
      const box = boxOf(route.geometry.slice(from, to + 1));
      if (box[2] - box[0] > MAX_BBOX_SPAN || box[3] - box[1] > MAX_BBOX_SPAN) continue;
      try {
        const ways = normalizeWays(await fetchOverpass(waysQuery(box), { cache: false, timeoutMs: 45000 }));
        const part = limitsFromWays(route.geometry.slice(from, to + 1), ways);
        for (let i = 0; i < part.length; i++) if (part[i] != null) { limits[from + i] = part[i]; any = true; }
      } catch (e) { log('navigation: route limits from Overpass unavailable:', e.message); }
    }
    return any ? { source: 'overpass', limits } : { source: 'none', limits: null };
  }

  return { cameras, camerasAlongRoute, routeLimits };
}
