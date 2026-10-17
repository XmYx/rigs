// Traffic cars for the navigation applet: turns api/traffic segments into a small road network and
// moves car silhouettes along it, denser and slower where congestion is high. Pure (no DOM, no map):
// app.js feeds it data and time, and draws features() as one GeoJSON source. Unit-tested in node.

const rad = (d) => (d * Math.PI) / 180;
const M_PER_DEG_LAT = 110540;
const mPerDegLon = (lat) => 111320 * Math.cos(rad(lat));
const ARTERIAL = new Set(['motorway', 'trunk', 'primary', 'secondary', 'tertiary']);

/** Cars per km of road (both directions): 2 + 18·congestion on arterials, half that on minor roads. */
export function carsPerKm(cls, congestion) {
  const d = 2 + 18 * Math.max(0, Math.min(1, congestion));
  return ARTERIAL.has(cls) ? d : d / 2;
}

/** Stable u ∈ [0, 1) from a string (FNV-1a), so the same road always gets the same car count. */
function hash01(s) {
  let h = 0x811c9dc5;
  for (let i = 0; i < s.length; i++) { h ^= s.charCodeAt(i); h = Math.imul(h, 0x01000193); }
  return (h >>> 0) / 4294967296;
}

const keyOf = (c) => `${c[0].toFixed(5)},${c[1].toFixed(5)}`;

/** One api/traffic segment → what the simulator needs: flat-projected cumulative lengths in metres. */
function prepare(s) {
  const kx = mPerDegLon(s.coords[0][1]);
  const cum = [0];
  for (let i = 1; i < s.coords.length; i++) {
    const [ax, ay] = s.coords[i - 1], [bx, by] = s.coords[i];
    cum.push(cum[i - 1] + Math.hypot((bx - ax) * kx, (by - ay) * M_PER_DEG_LAT));
  }
  return {
    id: s.id, coords: s.coords, cum, len: cum[cum.length - 1], cls: s.class, oneway: !!s.oneway,
    congestion: s.congestion, speed: Math.max(0, s.speedKmh) / 3.6, kx,
    mid: s.coords[Math.floor(s.coords.length / 2)],
    // Two-way roads: cars keep right of the centre line, further out on wide roads.
    lane: s.oneway ? 0 : ARTERIAL.has(s.class) ? 3.2 : 1.8,
    startKey: keyOf(s.coords[0]), endKey: keyOf(s.coords[s.coords.length - 1]),
    target: 0, count: 0,
  };
}

/**
 * @param {{maxCars?: number, rand?: () => number}} o
 * setData(segments, center) replaces the network (cars on surviving roads keep going),
 * step(dt) moves every car dt seconds, features() is the GeoJSON to draw.
 */
export function createTrafficSim({ maxCars = 240, rand = Math.random } = {}) {
  let segs = new Map();
  let ends = new Map(); // endpoint key → [{seg, at: 'start' | 'end'}]
  let cars = [];
  const fc = { type: 'FeatureCollection', features: [] };

  function place(car, seg, s, dir) {
    if (car.seg) car.seg.count--;
    car.seg = seg; car.s = s; car.dir = dir; car.i = 0;
    seg.count++;
  }

  function spawn(seg, k) {
    // Evenly spread with a per-car offset; on two-way roads every other car drives the other way.
    const car = { seg: null, s: 0, dir: 1, i: 0, wobble: 0.94 + 0.12 * rand() };
    place(car, seg, ((k + rand() * 0.6) / Math.max(1, seg.target)) * seg.len, seg.oneway || k % 2 === 0 ? 1 : -1);
    return car;
  }

  function setData(segments, center) {
    const next = new Map();
    for (const raw of segments || []) {
      if (!raw || !Array.isArray(raw.coords) || raw.coords.length < 2) continue;
      const seg = prepare(raw);
      if (seg.len >= 1) next.set(seg.id, seg);
    }
    // Car budget: the roads nearest the vehicle first, until maxCars.
    const [cx, cy] = center || [0, 0];
    const kx = mPerDegLon(cy);
    const dist = (s) => Math.hypot((s.mid[0] - cx) * kx, (s.mid[1] - cy) * M_PER_DEG_LAT);
    const order = [...next.values()].sort((a, b) => dist(a) - dist(b));
    let budget = maxCars;
    for (const seg of order) {
      const want = Math.floor((seg.len / 1000) * carsPerKm(seg.cls, seg.congestion) + hash01(seg.id));
      seg.target = Math.max(0, Math.min(want, budget));
      budget -= seg.target;
    }
    ends = new Map();
    for (const seg of next.values()) {
      for (const [key, at] of [[seg.startKey, 'start'], [seg.endKey, 'end']]) {
        if (!ends.has(key)) ends.set(key, []);
        ends.get(key).push({ seg, at });
      }
    }
    // Keep cars whose road is still there (same id), up to its new target; then top every road up.
    const kept = [];
    for (const car of cars) {
      const seg = next.get(car.seg.id);
      if (!seg || seg.count >= seg.target) continue;
      car.seg = null;
      place(car, seg, Math.min(car.s, seg.len), seg.oneway ? 1 : car.dir);
      kept.push(car);
    }
    for (const seg of order) {
      for (let k = seg.count; k < seg.target; k++) kept.push(spawn(seg, k));
    }
    segs = next;
    cars = kept;
    fc.features = cars.map(() => ({ type: 'Feature', properties: { b: 0, c: 0 }, geometry: { type: 'Point', coordinates: [0, 0] } }));
  }

  /** At the end of its road a car turns onto a connected road with room, else reappears on a road short of cars. */
  function advance(car) {
    const seg = car.seg;
    const key = car.dir > 0 ? seg.endKey : seg.startKey;
    const options = (ends.get(key) || []).filter((o) => o.seg !== seg && (o.at === 'start' || !o.seg.oneway) && o.seg.count < o.seg.target + 1);
    if (options.length) {
      // Busier roads draw more of the flow, like real traffic.
      const w = options.map((o) => carsPerKm(o.seg.cls, o.seg.congestion));
      let r = rand() * w.reduce((a, b) => a + b, 0);
      let k = 0;
      while (k < options.length - 1 && (r -= w[k]) > 0) k++;
      return place(car, options[k].seg, 0, options[k].at === 'start' ? 1 : -1);
    }
    let short = null;
    for (const s of segs.values()) if (s.target - s.count > (short ? short.target - short.count : 0)) short = s;
    const to = short || seg;
    place(car, to, rand() * to.len, to.oneway || rand() < 0.5 ? 1 : -1);
  }

  function step(dt) {
    if (!(dt > 0)) return;
    for (const car of cars) {
      car.s += car.seg.speed * car.wobble * dt;
      if (car.s >= car.seg.len) advance(car);
    }
  }

  /** Position and heading of a car: distance s along its road in its direction, kept right on two-way roads. */
  function locate(car) {
    const { coords, cum, len, kx, lane } = car.seg;
    const d = car.dir > 0 ? Math.min(car.s, len) : Math.max(0, len - car.s);
    let i = Math.min(car.i, cum.length - 2);
    while (i > 0 && cum[i] > d) i--;
    while (i < cum.length - 2 && cum[i + 1] < d) i++;
    car.i = i;
    const a = coords[i], b = coords[i + 1];
    const piece = cum[i + 1] - cum[i];
    const t = piece > 0 ? (d - cum[i]) / piece : 0;
    let ex = (b[0] - a[0]) * kx * car.dir, ny = (b[1] - a[1]) * M_PER_DEG_LAT * car.dir;
    const h = Math.hypot(ex, ny) || 1;
    ex /= h; ny /= h;
    // Right of travel is the heading turned 90° clockwise: (east, north) → (north, −east).
    return {
      lon: a[0] + (b[0] - a[0]) * t + (ny * lane) / kx,
      lat: a[1] + (b[1] - a[1]) * t - (ex * lane) / M_PER_DEG_LAT,
      bearing: ((Math.atan2(ex, ny) * 180) / Math.PI + 360) % 360,
    };
  }

  function features() {
    for (let k = 0; k < cars.length; k++) {
      const p = locate(cars[k]);
      const f = fc.features[k];
      f.geometry.coordinates[0] = p.lon;
      f.geometry.coordinates[1] = p.lat;
      f.properties.b = Math.round(p.bearing);
      f.properties.c = cars[k].seg.congestion;
    }
    return fc;
  }

  return {
    setData, step, features, locate,
    get cars() { return cars; },
    get segments() { return segs; },
  };
}

/** GeoJSON lines for the street-shading layer: one feature per segment, carrying class and congestion. */
export function shadeFeatures(segments) {
  return {
    type: 'FeatureCollection',
    features: (segments || []).map((s) => ({
      type: 'Feature',
      properties: { class: s.class, congestion: s.congestion },
      geometry: { type: 'LineString', coordinates: s.coords },
    })),
  };
}
