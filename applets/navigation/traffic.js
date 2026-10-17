// Traffic for the navigation applet (docs/traffic-source.md): per-road congestion around a bbox, from
// TomTom Traffic Flow vector tiles when a key is configured, otherwise from the synthetic "assumed
// traffic" model over the OpenFreeMap road network. Both come out in one shape:
//   {source, updated, z, clipped, segments:[{id, coords, class, congestion, speedKmh, oneway?}]}
// Everything upstream is cached in memory only; the TomTom key never leaves this file except in the
// request URL (never logged, never in an error message).
import zlib from 'node:zlib';
import { cumulativeDistances, projectOnLine } from './public/geo.js';

// ---- Mapbox Vector Tile reader (protobuf varints, zig-zag, MoveTo/LineTo) ---------------------------

function reader(buf) {
  let pos = 0;
  const varint = () => {
    let v = 0, mul = 1, b;
    do { b = buf[pos++]; v += (b & 0x7f) * mul; mul *= 128; } while (b & 0x80);
    return v;
  };
  return {
    done: () => pos >= buf.length,
    varint,
    bytes() { const n = varint(); const s = buf.subarray(pos, pos + n); pos += n; return s; },
    skip(wire) {
      if (wire === 0) varint();
      else if (wire === 1) pos += 8;
      else if (wire === 2) pos += varint();
      else if (wire === 5) pos += 4;
      else throw new Error('mvt: unsupported wire type ' + wire);
    },
    double() { const v = buf.readDoubleLE(pos); pos += 8; return v; },
    float() { const v = buf.readFloatLE(pos); pos += 4; return v; },
  };
}

const zigzag = (n) => (n % 2 ? -(n + 1) / 2 : n / 2);

function packed(bytes) {
  const r = reader(bytes);
  const out = [];
  while (!r.done()) out.push(r.varint());
  return out;
}

function decodeValue(bytes) {
  const r = reader(bytes);
  let v = null;
  while (!r.done()) {
    const tag = r.varint(), f = Math.floor(tag / 8), w = tag & 7;
    if (f === 1) v = Buffer.from(r.bytes()).toString('utf8');
    else if (f === 2) v = r.float();
    else if (f === 3) v = r.double();
    else if (f === 4 || f === 5) v = r.varint();
    else if (f === 6) v = zigzag(r.varint());
    else if (f === 7) v = r.varint() !== 0;
    else r.skip(w);
  }
  return v;
}

/** MVT geometry commands → lines (each [[x, y], …] in tile units). Polygon rings come out as closed lines. */
export function decodeGeometry(cmds) {
  const lines = [];
  let x = 0, y = 0, line = null;
  for (let i = 0; i < cmds.length;) {
    const id = cmds[i] & 7, count = cmds[i] >> 3;
    i++;
    if (id === 7) { if (line && line.length) line.push(line[0]); continue; }
    for (let k = 0; k < count; k++) {
      x += zigzag(cmds[i++]); y += zigzag(cmds[i++]);
      if (id === 1) { line = [[x, y]]; lines.push(line); } else line.push([x, y]);
    }
  }
  return lines;
}

/**
 * Decodes the layers of a vector tile buffer. `only` limits decoding to those layer names (a central
 * z14 OpenFreeMap tile is ~600 KB; we only need `transportation`).
 * → {[layerName]: {extent, features:[{type, lines, properties}]}}
 */
export function decodeMvt(buf, only = null) {
  const out = {};
  const r = reader(buf);
  while (!r.done()) {
    const tag = r.varint();
    if (tag >> 3 !== 3 || (tag & 7) !== 2) { r.skip(tag & 7); continue; }
    const lr = reader(r.bytes());
    let name = '', extent = 4096;
    const keys = [], values = [], feats = [];
    while (!lr.done()) {
      const t = lr.varint(), f = t >> 3;
      if (f === 1) name = Buffer.from(lr.bytes()).toString('utf8');
      else if (f === 2) feats.push(lr.bytes());
      else if (f === 3) keys.push(Buffer.from(lr.bytes()).toString('utf8'));
      else if (f === 4) values.push(lr.bytes());
      else if (f === 5) extent = lr.varint();
      else lr.skip(t & 7);
    }
    if (only && !only.includes(name)) continue;
    const vals = values.map(decodeValue);
    const features = feats.map((fb) => {
      const fr = reader(fb);
      let type = 0, tags = [], geom = [];
      while (!fr.done()) {
        const t = fr.varint(), f = t >> 3;
        if (f === 2) tags = packed(fr.bytes());
        else if (f === 3) type = fr.varint();
        else if (f === 4) geom = packed(fr.bytes());
        else fr.skip(t & 7);
      }
      const properties = {};
      for (let i = 0; i + 1 < tags.length; i += 2) properties[keys[tags[i]]] = vals[tags[i + 1]];
      return { type, lines: decodeGeometry(geom), properties };
    });
    out[name] = { extent, features };
  }
  return out;
}

// ---- Tile maths ---------------------------------------------------------------------------------

export function lonLatToTile(lon, lat, z) {
  const n = 2 ** z;
  const s = Math.sin((Math.max(-85.0511, Math.min(85.0511, lat)) * Math.PI) / 180);
  return [((lon + 180) / 360) * n, (0.5 - Math.log((1 + s) / (1 - s)) / (4 * Math.PI)) * n];
}

export function tileToLonLat(x, y, z) {
  const n = 2 ** z;
  return [(x / n) * 360 - 180, (Math.atan(Math.sinh(Math.PI * (1 - (2 * y) / n))) * 180) / Math.PI];
}

/** Tile zoom for a map zoom: the geometry tiles' own grid, z12–14. */
export const tileZoomFor = (z) => Math.max(12, Math.min(14, Math.round(z)));

/**
 * Tiles covering bbox [w, s, e, n] at zoom z, nearest the bbox centre first, at most `max`.
 * → {tiles:[[x, y]], clipped}
 */
export function tilesForBbox([w, s, e, n], z, max = 16) {
  const [x0, y0] = lonLatToTile(w, n, z).map(Math.floor);
  const [x1, y1] = lonLatToTile(e, s, z).map((v) => Math.ceil(v) - 1);
  const [cx, cy] = lonLatToTile((w + e) / 2, (s + n) / 2, z);
  const tiles = [];
  for (let x = x0; x <= Math.max(x0, x1); x++) for (let y = y0; y <= Math.max(y0, y1); y++) tiles.push([x, y]);
  const d = (t) => Math.hypot(t[0] + 0.5 - cx, t[1] + 0.5 - cy);
  tiles.sort((a, b) => d(a) - d(b));
  return { tiles: tiles.slice(0, max), clipped: tiles.length > max };
}

/**
 * Clips a line to the square [0, extent]² (Liang–Barsky per segment). A line that leaves and re-enters
 * comes back as several parts. This drops the tile buffer, so roads crossing tile edges aren't doubled.
 */
export function clipLine(line, extent) {
  const parts = [];
  let cur = null;
  const push = (p) => {
    if (!cur) { cur = [p]; parts.push(cur); return; }
    const last = cur[cur.length - 1];
    if (last[0] !== p[0] || last[1] !== p[1]) cur.push(p);
  };
  for (let i = 0; i + 1 < line.length; i++) {
    const [ax, ay] = line[i], [bx, by] = line[i + 1];
    const dx = bx - ax, dy = by - ay;
    let t0 = 0, t1 = 1, ok = true;
    for (const [p, q] of [[-dx, ax], [dx, extent - ax], [-dy, ay], [dy, extent - ay]]) {
      if (p === 0) { if (q < 0) { ok = false; break; } continue; }
      const t = q / p;
      if (p < 0) { if (t > t1) { ok = false; break; } if (t > t0) t0 = t; }
      else { if (t < t0) { ok = false; break; } if (t < t1) t1 = t; }
    }
    if (!ok) { cur = null; continue; }
    if (t0 > 0) cur = null; // entered from outside: a new part
    push([ax + dx * t0, ay + dy * t0]);
    push([ax + dx * t1, ay + dy * t1]);
    if (t1 < 1) cur = null; // left the tile
  }
  return parts.filter((p) => p.length >= 2);
}

const r6 = (v) => Math.round(v * 1e6) / 1e6;

/** Tile-local lines of one feature → clipped [[lon, lat], …] parts. */
function toLonLatParts(lines, extent, z, x, y) {
  const out = [];
  for (const line of lines) {
    for (const part of clipLine(line, extent)) {
      const coords = [];
      for (const [px, py] of part) {
        const [lon, lat] = tileToLonLat(x + px / extent, y + py / extent, z);
        const c = [r6(lon), r6(lat)];
        const last = coords[coords.length - 1];
        if (!last || last[0] !== c[0] || last[1] !== c[1]) coords.push(c);
      }
      if (coords.length >= 2) out.push(coords);
    }
  }
  return out;
}

// ---- The synthetic model --------------------------------------------------------------------------

/** Per-class load L and free-flow speed V (km/h), urban Hungary. */
export const CLASSES = {
  motorway: { L: 0.60, V: 100 },
  trunk: { L: 0.55, V: 80 },
  primary: { L: 0.50, V: 50 },
  secondary: { L: 0.42, V: 50 },
  tertiary: { L: 0.32, V: 40 },
  minor: { L: 0.14, V: 30 },
  service: { L: 0.06, V: 15 },
};
const MAJOR = ['motorway', 'trunk', 'primary', 'secondary'];

/** Classes served at a map zoom: below 13 only motorway…secondary, below 15 no minor/service. */
export function classesForZoom(z) {
  if (z < 13) return MAJOR;
  if (z < 15) return [...MAJOR, 'tertiary'];
  return Object.keys(CLASSES);
}

const gauss = (h, mu, sigma) => Math.exp(-((h - mu) ** 2) / (2 * sigma * sigma));

/** Time-of-day demand D(h), 0..1, `h` the local hour as a fraction. */
export function demand(h, weekend) {
  if (weekend) return Math.min(1, 0.06 + 0.5 * gauss(h, 13.5, 3.5));
  return Math.min(1, 0.08 + 0.42 * gauss(h, 12.5, 3.2) + 0.55 * gauss(h, 7.75, 1.1) + 0.6 * gauss(h, 16.75, 1.5));
}

/** Route closeness bump R: 0.12 within 100 m of the route, falling linearly to 0 at 500 m. */
export function routeBump(d) {
  if (!Number.isFinite(d) || d >= 500) return 0;
  return d <= 100 ? 0.12 : 0.12 * (1 - (d - 100) / 400);
}

/** Stable u ∈ [0, 1) from a string (FNV-1a). */
export function hash01(s) {
  let h = 0x811c9dc5;
  for (let i = 0; i < s.length; i++) { h ^= s.charCodeAt(i); h = Math.imul(h, 0x01000193); }
  return (h >>> 0) / 4294967296;
}

/**
 * congestion = clamp(L·(0.2 + 1.2·D) + R + J, 0, 0.95), speedKmh = max(3, round(V·(1 − congestion))).
 * `t` = {hour (fraction), minutes (since midnight), weekend}, `u` = hash of the segment id.
 */
export function syntheticTraffic(cls, t, u, routeDist = Infinity) {
  const c = CLASSES[cls];
  if (!c) return null;
  const D = demand(t.hour, t.weekend);
  const J = 0.16 * (u - 0.5) + 0.06 * Math.sin(2 * Math.PI * (t.minutes / 20 + u));
  const congestion = Math.max(0, Math.min(0.95, c.L * (0.2 + 1.2 * D) + routeBump(routeDist) + J));
  return { congestion: Math.round(congestion * 100) / 100, speedKmh: Math.max(3, Math.round(c.V * (1 - congestion))) };
}

// Fixed-date public holidays in Hungary (where Sir drives and the demo runs); movable feasts are not modelled.
const HOLIDAYS = new Set(['1-1', '3-15', '5-1', '8-20', '10-23', '11-1', '12-24', '12-25', '12-26']);

/** Local clock for the demand curve: {hour, minutes, weekend} at `date` in IANA zone `tz` (else the server's). */
export function localClock(date, tz) {
  const opts = { hourCycle: 'h23', weekday: 'short', month: 'numeric', day: 'numeric', hour: 'numeric', minute: 'numeric' };
  let parts;
  try { parts = new Intl.DateTimeFormat('en-US', { ...opts, timeZone: tz || undefined }).formatToParts(date); }
  catch { parts = new Intl.DateTimeFormat('en-US', opts).formatToParts(date); }
  const p = Object.fromEntries(parts.map((x) => [x.type, x.value]));
  const minutes = (Number(p.hour) % 24) * 60 + Number(p.minute);
  const weekend = p.weekday === 'Sat' || p.weekday === 'Sun' || HOLIDAYS.has(`${Number(p.month)}-${Number(p.day)}`);
  return { hour: minutes / 60, minutes, weekend };
}

/** A route geometry with what distToRoute needs precomputed. */
export function routeInfo(geometry) {
  let w = Infinity, s = Infinity, e = -Infinity, n = -Infinity;
  for (const [x, y] of geometry) { w = Math.min(w, x); e = Math.max(e, x); s = Math.min(s, y); n = Math.max(n, y); }
  return { geometry, cum: cumulativeDistances(geometry), bbox: [w, s, e, n] };
}

/** Distance (m) from a road to the route: the nearest of its two ends and middle vertex. */
function distToRoute(coords, route) {
  if (!route) return Infinity;
  const [w, s, e, n] = route.bbox;
  const mid = coords[Math.floor(coords.length / 2)];
  // ≈ 600 m outside the route's box gets no bump anyway; skip the projection.
  if (mid[0] < w - 0.008 || mid[0] > e + 0.008 || mid[1] < s - 0.0055 || mid[1] > n + 0.0055) return Infinity;
  let best = Infinity;
  for (const c of [coords[0], mid, coords[coords.length - 1]]) {
    best = Math.min(best, projectOnLine(route.geometry, route.cum, { lon: c[0], lat: c[1] }).offset);
  }
  return best;
}

/**
 * OpenMapTiles `transportation` layer of one tile → roads [{id, coords, class, oneway?}], clipped to
 * the tile, tunnels and non-road classes dropped, `oneway: -1` turned round.
 */
export function omtRoads(decoded, z, x, y) {
  const layer = decoded.transportation;
  if (!layer) return [];
  const out = [];
  layer.features.forEach((f, fi) => {
    const p = f.properties;
    if (f.type !== 2 || !CLASSES[p.class] || p.brunnel === 'tunnel') return;
    toLonLatParts(f.lines, layer.extent, z, x, y).forEach((coords, pi) => {
      if (p.oneway === -1) coords.reverse();
      const seg = { id: `omt:${z}/${x}/${y}:${fi}:${pi}`, coords, class: p.class };
      if (p.oneway === 1 || p.oneway === -1) seg.oneway = true;
      out.push(seg);
    });
  });
  return out;
}

const ROAD_TYPE_CLASS = {
  'Motorway': 'motorway', 'International road': 'trunk', 'Major road': 'primary', 'Secondary road': 'secondary',
  'Connecting road': 'tertiary', 'Major local road': 'tertiary', 'Local road': 'minor', 'Minor local road': 'minor',
};

/** TomTom `Traffic flow` layer (relative) of one tile → segments in the contract shape. */
export function tomtomSegments(decoded, z, x, y) {
  const layer = decoded['Traffic flow'];
  if (!layer) return [];
  const out = [];
  layer.features.forEach((f, fi) => {
    const p = f.properties;
    if (f.type !== 2) return;
    const cls = p.road_category ? (p.road_category === 'street' ? 'minor' : p.road_category) : (ROAD_TYPE_CLASS[p.road_type] || 'service');
    if (!CLASSES[cls]) return;
    const closed = p.road_closure === true;
    const level = Number(p.traffic_level);
    if (!closed && !Number.isFinite(level)) return;
    const lv = Math.max(0, Math.min(1, level));
    const congestion = closed ? 1 : Math.round((1 - lv) * 100) / 100;
    const speedKmh = closed ? 0 : Math.round(CLASSES[cls].V * lv);
    toLonLatParts(f.lines, layer.extent, z, x, y).forEach((coords, pi) => {
      const seg = { id: `tt:${z}/${x}/${y}:${fi}:${pi}`, coords, class: cls, congestion, speedKmh };
      if (p.traffic_road_coverage === 'one_side') seg.oneway = true;
      out.push(seg);
    });
  });
  return out;
}

/** Does a line touch bbox [w, s, e, n]? (Box overlap: a long straight piece can cross it with no vertex inside.) */
export function lineInBbox(coords, [w, s, e, n]) {
  let a = Infinity, b = Infinity, c = -Infinity, d = -Infinity;
  for (const [x, y] of coords) { a = Math.min(a, x); b = Math.min(b, y); c = Math.max(c, x); d = Math.max(d, y); }
  return a <= e && c >= w && b <= n && d >= s;
}

// ---- The service: providers, caches, budget ----------------------------------------------------

const MIN = 60 * 1000;
const HOUR = 60 * MIN;

/**
 * @param {{cfg, fetchImpl?, now?, log?, userAgent}} o  cfg carries tilesUrl, trafficSource, tomtomKey,
 *   tomtomUrl and trafficDailyTiles (see loadNavConfig).
 */
export function createTraffic({ cfg, fetchImpl = globalThis.fetch, now = () => Date.now(), log = () => {}, userAgent }) {
  const inflight = new Map();
  const omtTiles = new Map(); // `${z}/${x}/${y}` → {at, roads}, 24 h, at most 64
  const ttTiles = new Map();  // `${z}/${x}/${y}` → {at, segments}, 60 s (TomTom terms: ≤ 24 h, never on disk)
  let tileJson = null;        // {at, template}, re-read every 6 h
  const tt = { day: '', used: 0, backoffUntil: 0, disabled: false };

  async function getBuffer(url) {
    const host = new URL(url).host;
    const res = await fetchImpl(url, { headers: { 'user-agent': userAgent, accept: 'application/x-protobuf, application/json' }, signal: AbortSignal.timeout(10000) });
    if (!res.ok) throw Object.assign(new Error(`upstream ${host} HTTP ${res.status}`), { status: res.status });
    let buf = Buffer.from(await res.arrayBuffer());
    if (buf[0] === 0x1f && buf[1] === 0x8b) buf = zlib.gunzipSync(buf);
    return buf;
  }

  // Identical in-flight upstream fetches are shared, never duplicated.
  function once(key, fn) {
    if (inflight.has(key)) return inflight.get(key);
    const p = fn().finally(() => inflight.delete(key));
    inflight.set(key, p);
    return p;
  }

  function remember(map, key, value, max) {
    map.delete(key);
    map.set(key, value);
    while (map.size > max) map.delete(map.keys().next().value);
  }

  async function omtTemplate() {
    if (tileJson && now() - tileJson.at < 6 * HOUR) return tileJson.template;
    return once('tilejson', async () => {
      const tj = JSON.parse((await getBuffer(cfg.tilesUrl)).toString('utf8'));
      if (!Array.isArray(tj.tiles) || !tj.tiles[0]) throw new Error('tilejson has no tiles[]');
      tileJson = { at: now(), template: tj.tiles[0] };
      return tileJson.template;
    });
  }

  async function omtTile(z, x, y) {
    const key = `${z}/${x}/${y}`;
    const hit = omtTiles.get(key);
    if (hit && now() - hit.at < 24 * HOUR) return hit.roads;
    return once('omt:' + key, async () => {
      const url = (await omtTemplate()).replace('{z}', z).replace('{x}', x).replace('{y}', y);
      const roads = omtRoads(decodeMvt(await getBuffer(url), ['transportation']), z, x, y);
      remember(omtTiles, key, { at: now(), roads }, 64);
      return roads;
    });
  }

  async function tomtomTile(z, x, y) {
    const key = `${z}/${x}/${y}`;
    const hit = ttTiles.get(key);
    if (hit && now() - hit.at < MIN) return hit.segments;
    return once('tt:' + key, async () => {
      const day = new Date(now()).toISOString().slice(0, 10);
      if (tt.day !== day) { tt.day = day; tt.used = 0; }
      if (tt.used >= cfg.trafficDailyTiles) throw Object.assign(new Error('daily TomTom tile budget spent'), { budget: true });
      tt.used++;
      const url = `${cfg.tomtomUrl}/traffic/map/4/tile/flow/relative/${z}/${x}/${y}.pbf?key=${encodeURIComponent(cfg.tomtomKey)}`
        + '&tags=[road_category,road_subcategory,traffic_level,traffic_road_coverage,left_hand_traffic,road_closure]';
      const segments = tomtomSegments(decodeMvt(await getBuffer(url), ['Traffic flow']), z, x, y);
      remember(ttTiles, key, { at: now(), segments }, 64);
      return segments;
    });
  }

  /** The provider a request tries first: 'tomtom' | 'synthetic' | 'off'. */
  function primary(forced) {
    if (cfg.trafficSource === 'off') return 'off';
    if (forced === 'synthetic' || cfg.trafficSource === 'synthetic') return 'synthetic';
    if (!cfg.tomtomKey || tt.disabled || now() < tt.backoffUntil) return 'synthetic';
    return 'tomtom';
  }

  async function fromTomtom(tiles, z) {
    try {
      return (await Promise.all(tiles.map(([x, y]) => tomtomTile(z, x, y)))).flat();
    } catch (e) {
      if (e.status === 401 || e.status === 403) {
        if (!tt.disabled) log(`navigation traffic: TomTom refused the key (HTTP ${e.status}); check NAV_TOMTOM_KEY / navigation.tomtomKey. Assumed traffic until restart.`);
        tt.disabled = true;
      } else if (e.status === 429) {
        tt.backoffUntil = now() + 15 * MIN;
        log('navigation traffic: TomTom rate limit (HTTP 429); assumed traffic for 15 min');
      } else if (!e.budget) {
        log('navigation traffic: TomTom unavailable, using assumed traffic:', e.message);
      }
      return null;
    }
  }

  async function synthetic(tiles, z, at, tz, route) {
    const t = localClock(new Date(at), tz);
    const lists = await Promise.all(tiles.map(([x, y]) => omtTile(z, x, y)));
    const out = [];
    for (const roads of lists) {
      for (const r of roads) out.push({ ...r, ...syntheticTraffic(r.class, t, hash01(r.id), distToRoute(r.coords, route)) });
    }
    return out;
  }

  /**
   * @param {{bbox:number[], z:number, tz?:string, route?:object, source?:string, at?:number}} q  route from
   *   routeInfo(); `at` (ms) asks the synthetic model about another moment (the demo uses rush hour).
   */
  async function get({ bbox, z, tz, route, source, at: when }) {
    const tileZ = tileZoomFor(z);
    const { tiles, clipped } = tilesForBbox(bbox, tileZ);
    const wanted = new Set(classesForZoom(z));
    const pick = (segs) => segs.filter((s) => wanted.has(s.class) && lineInBbox(s.coords, bbox));
    const none = () => ({ source: 'none', updated: new Date(now()).toISOString(), z: tileZ, clipped, segments: [] });
    const first = primary(source);
    if (first === 'off') return none();
    if (first === 'tomtom') {
      const segs = await fromTomtom(tiles, tileZ);
      if (segs) return { source: 'tomtom', updated: new Date(now()).toISOString(), z: tileZ, clipped, segments: pick(segs) };
    }
    // A pure function of (tile lines, minute bucket, route): polls within a minute return identical numbers.
    const at = Math.floor((when ?? now()) / MIN) * MIN;
    try {
      const segs = await synthetic(tiles, tileZ, at, tz, route);
      return { source: 'synthetic', updated: new Date(at).toISOString(), z: tileZ, clipped, segments: pick(segs) };
    } catch (e) {
      log('navigation traffic: no road geometry either:', e.message);
      return none();
    }
  }

  return { get, primary, state: tt };
}
