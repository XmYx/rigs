// Navigation applet: pure geo/HUD math, the map style, config loading and the applet server
// (healthz, config.json, routing/search proxies with a fake upstream, static files), and traffic: the
// vector-tile reader, the synthetic model, api/traffic with stubbed providers and the car simulator.
// No network.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { test } from 'node:test';

process.env.RIGS_HOME = fs.mkdtempSync(path.join(os.tmpdir(), 'rigs-nav-'));
const G = await import('../applets/navigation/public/geo.js');
const { buildStyle, routeLayers, trafficLayers, TRAFFIC_SHADE } = await import('../applets/navigation/public/mapstyle.js');
const S = await import('../applets/navigation/server.js');
const T = await import('../applets/navigation/traffic.js');
const C = await import('../applets/navigation/public/traffic.js');

const near = (a, b, eps, msg) => assert.ok(Math.abs(a - b) <= eps, `${msg || ''} expected ${b} ± ${eps}, got ${a}`);

test('haversine: one degree of latitude / of longitude at the equator ≈ 111.2 km', () => {
  near(G.haversine({ lat: 0, lon: 0 }, { lat: 1, lon: 0 }), 111195, 1);
  near(G.haversine({ lat: 0, lon: 0 }, { lat: 0, lon: 1 }), 111195, 1);
  near(G.haversine({ lat: 47.4979, lon: 19.0402 }, { lat: 47.4979, lon: 19.0402 }), 0, 1e-9);
  // Budapest Deák tér → Hősök tere, straight line ≈ 2.5 km
  near(G.haversine({ lat: 47.4979, lon: 19.0548 }, { lat: 47.5149, lon: 19.0777 }), 2525, 40);
});

test('bearing and heading helpers', () => {
  near(G.bearing({ lat: 0, lon: 0 }, { lat: 1, lon: 0 }), 0, 1e-6);
  near(G.bearing({ lat: 0, lon: 0 }, { lat: 0, lon: 1 }), 90, 1e-6);
  near(G.bearing({ lat: 0, lon: 0 }, { lat: -1, lon: 0 }), 180, 1e-6);
  assert.equal(G.normalizeHeading(-90), 270);
  assert.equal(G.angleDelta(350, 10), 20);
  assert.equal(G.angleDelta(10, 350), -20);
  near(G.lerpHeading(350, 10, 0.5), 0, 1e-9);
  assert.equal(G.cardinal(0), 'N');
  assert.equal(G.cardinal(44), 'NE');
  assert.equal(G.cardinal(359), 'N');
  assert.equal(G.cardinal(260), 'W');
});

test('unit conversion: m/s ↔ km/h ↔ mph', () => {
  assert.equal(G.msToKmh(10), 36);
  near(G.msToMph(10), 22.3694, 1e-4);
  assert.equal(G.kmhToMs(36), 10);
  near(G.mphToMs(G.msToMph(13.7)), 13.7, 1e-12);
  assert.equal(G.speedIn(10, 'kmh'), 36);
  near(G.speedIn(10, 'mph'), 22.3694, 1e-4);
  near(G.msToMph(G.kmhToMs(100)), 62.137, 1e-3);
});

test('speedFromFixes: distance over time, null when the pair says nothing', () => {
  const a = { lat: 47.5, lon: 19.05, t: 0 };
  const b = { lat: 47.501, lon: 19.05, t: 10000 }; // 111.2 m north in 10 s
  near(G.speedFromFixes(a, b), 11.12, 0.01);
  assert.equal(G.speedFromFixes(a, { ...b, t: 0 }), null, 'same timestamp');
  assert.equal(G.speedFromFixes(b, a), null, 'reversed order');
  assert.equal(G.speedFromFixes(a, { ...b, t: 60000 }), null, 'gap too long');
  assert.equal(G.speedFromFixes(null, b), null);
});

test('motion estimator: GPS speed wins; otherwise speed and heading come from successive fixes', () => {
  const gps = G.createMotionEstimator();
  assert.deepEqual(gps.update({ lat: 47.5, lon: 19.05, t: 0, speed: 12.5, heading: 45 }), { speed: 12.5, heading: 45, source: 'gps' });

  const est = G.createMotionEstimator();
  let out = est.update({ lat: 47.5, lon: 19.05, t: 0, speed: null, heading: null, accuracy: 5 });
  assert.equal(out.speed, null, 'one fix has no speed');
  const step = 0.0000899; // ≈ 10 m north per fix
  for (let i = 1; i <= 6; i++) out = est.update({ lat: 47.5 + step * i, lon: 19.05, t: i * 1000, speed: null, heading: null, accuracy: 5 });
  assert.equal(out.source, 'derived');
  near(out.speed, 10, 0.2, 'derived speed');
  near(out.heading, 0, 0.5, 'derived heading');

  const parked = G.createMotionEstimator();
  for (let i = 0; i < 6; i++) out = parked.update({ lat: 47.5 + (i % 2) * 0.00001, lon: 19.05, t: i * 1000, speed: null, accuracy: 8 });
  assert.equal(out.speed, 0, 'GPS jitter while parked reads as standing still');
});

test('formatting: distances, durations, maneuvers', () => {
  assert.equal(G.formatDistance(347), '350 m');
  assert.equal(G.formatDistance(1234), '1.2 km');
  assert.equal(G.formatDistance(23456), '23 km');
  assert.equal(G.formatDistance(100, 'mph'), '330 ft');
  assert.equal(G.formatDistance(1609.344, 'mph'), '1.0 mi');
  assert.equal(G.formatDistance(NaN), '—');
  assert.equal(G.formatDuration(42), '42 s');
  assert.equal(G.formatDuration(725), '12 min');
  assert.equal(G.formatDuration(3900), '1 h 05 min');
  assert.equal(G.maneuverText({ type: 'turn', modifier: 'left', name: 'Andrássy út' }), 'Turn left onto Andrássy út');
  assert.equal(G.maneuverText({ type: 'turn', modifier: 'slight right', name: '' }), 'Turn slight right');
  assert.equal(G.maneuverText({ type: 'roundabout', exit: 3, name: 'Dózsa György út' }), 'At the roundabout, take the 3rd exit onto Dózsa György út');
  assert.equal(G.maneuverText({ type: 'rotary', exit: 1 }), 'At the roundabout, take the 1st exit');
  assert.equal(G.maneuverText({ type: 'roundabout', exit: 12 }), 'At the roundabout, take the 12th exit');
  assert.equal(G.maneuverText({ type: 'arrive' }), 'Arrive at destination');
  assert.equal(G.maneuverText({ type: 'new name', modifier: 'straight', name: 'Andrássy út' }), 'Continue on Andrássy út');
  assert.equal(G.maneuverArrow({ type: 'turn', modifier: 'right' }), '↱');
  assert.equal(G.maneuverArrow({ type: 'turn', modifier: 'slight left' }), '↖');
  assert.ok(G.zoomForSpeed(0) > G.zoomForSpeed(G.kmhToMs(120)), 'zooms out with speed');
});

test('route geometry: point along, projection, progress to the next maneuver and ETA', () => {
  // Straight north along lon 19: 0 → 111 m (turn) → 222 m (arrive).
  const route = {
    geometry: [[19, 47], [19, 47.001], [19, 47.002]],
    steps: [
      { type: 'depart', location: [19, 47], duration: 10 },
      { type: 'turn', modifier: 'right', location: [19, 47.001], duration: 10 },
      { type: 'arrive', location: [19, 47.002], duration: 0 },
    ],
  };
  const cum = G.cumulativeDistances(route.geometry);
  near(cum[2], 222.4, 0.2);
  const mid = G.pointAlong(route.geometry, cum, cum[2] / 2);
  near(mid.lat, 47.001, 1e-6);
  near(mid.bearing, 0, 1e-6);
  const hit = G.projectOnLine(route.geometry, cum, { lat: 47.0005, lon: 19.0001 });
  near(hit.along, 55.6, 0.2);
  near(hit.offset, 7.6, 0.2);

  const pr = G.routeProgress(route, { lat: 47.0005, lon: 19 });
  assert.equal(pr.nextIndex, 1);
  assert.equal(pr.nextStep.type, 'turn');
  near(pr.toNext, 55.6, 0.3);
  near(pr.remaining, 166.8, 0.3);
  near(pr.timeLeft, 15, 0.05);
  assert.equal(pr.arrived, false);
  const end = G.routeProgress(route, { lat: 47.00199, lon: 19 });
  assert.equal(end.nextStep.type, 'arrive');
  assert.equal(end.arrived, true);
});

test('map style: near-black base, neon-green strokes, muted labels, no POIs', () => {
  const style = buildStyle({ tiles: 'https://tiles.example/planet', glyphs: 'https://tiles.example/fonts/{fontstack}/{range}.pbf' });
  assert.equal(style.version, 8);
  assert.equal(style.sources.omt.url, 'https://tiles.example/planet');
  assert.match(style.glyphs, /\{fontstack\}/);
  const lum = (hex) => { const n = parseInt(hex.slice(1), 16); return (((n >> 16) & 255) + ((n >> 8) & 255) + (n & 255)) / 3; };
  const bg = style.layers.find((l) => l.type === 'background');
  assert.ok(lum(bg.paint['background-color']) < 10, 'background is near-black');
  for (const l of style.layers.filter((x) => x.type === 'fill')) assert.ok(lum(l.paint['fill-color']) < 15, `${l.id} fill is near-black`);
  assert.ok(!style.layers.some((l) => ['poi', 'housenumber', 'aerodrome_label', 'mountain_peak'].includes(l['source-layer'])), 'no POI layers');
  const greenish = (c) => { const n = parseInt(c.slice(1), 16); return ((n >> 8) & 255) > ((n >> 16) & 255) * 2; };
  for (const id of ['road-motorway', 'road-primary', 'road-minor', 'water-edge', 'park-edge', 'building-edge']) {
    const l = style.layers.find((x) => x.id === id);
    assert.ok(l && l.type === 'line' && greenish(l.paint['line-color']), `${id} is a green stroke`);
  }
  assert.ok(style.layers.some((l) => l.type === 'fill-extrusion' && l['source-layer'] === 'building'), '3D buildings');
  const labels = style.layers.filter((l) => l.type === 'symbol');
  assert.ok(labels.length >= 3);
  for (const l of labels) assert.ok(greenish(l.paint['text-color']), `${l.id} label is green`);
  assert.deepEqual(routeLayers('route').map((l) => l.id), ['route-glow', 'route-line', 'route-core']);
  assert.ok(routeLayers()[0].paint['line-blur'], 'route has a glow');
});

test('loadNavConfig: env beats file beats defaults; bad values warn without echoing them', () => {
  const file = path.join(process.env.RIGS_HOME, 'config.json');
  fs.writeFileSync(file, JSON.stringify({ navigation: { port: 9999, tilesUrl: 'https://tiles.example/x/', routingUrl: 'javascript:alert(1)?token=s3cr3t-route', demo: { from: [19.1, 47.6], to: 'nope' }, secretToken: 's3cr3t-file' } }));
  const { cfg, warnings } = S.loadNavConfig({ env: { RIGS_HOME: process.env.RIGS_HOME } });
  assert.equal(cfg.port, 9999);
  assert.equal(cfg.tilesUrl, 'https://tiles.example/x');
  assert.equal(cfg.routingUrl, S.DEFAULTS.routingUrl, 'invalid URL falls back');
  assert.deepEqual(cfg.demo.from, [19.1, 47.6]);
  assert.deepEqual(cfg.demo.to, S.DEFAULTS.demo.to);
  assert.equal(warnings.length, 2);
  assert.ok(!warnings.join(' ').includes('s3cr3t'), 'warnings never contain the rejected value');

  const env = S.loadNavConfig({ env: { RIGS_HOME: process.env.RIGS_HOME, NAV_PORT: '8800', NAV_SEARCH_URL: 'http://photon.local:2322' } }).cfg;
  assert.equal(env.port, 8800);
  assert.equal(env.searchUrl, 'http://photon.local:2322');

  const none = S.loadNavConfig({ env: {}, configFile: path.join(process.env.RIGS_HOME, 'missing.json') }).cfg;
  assert.equal(none.port, 8731);

  const pub = S.publicConfig(cfg);
  assert.deepEqual(Object.keys(pub).sort(), ['demo', 'glyphs', 'provider', 'tiles', 'traffic']);
  assert.ok(!JSON.stringify(pub).includes('s3cr3t'), 'other config fields never reach the browser');
});

test('upstream normalizers: OSRM, Photon, Nominatim', () => {
  const osrm = S.normalizeOsrm({ code: 'Ok', routes: [{ distance: 500, duration: 60, geometry: { coordinates: [[19, 47], [19, 47.004]] }, legs: [{ steps: [
    { name: 'A utca', distance: 400, duration: 50, maneuver: { type: 'depart', location: [19, 47] } },
    { name: '', ref: 'M0', distance: 100, duration: 10, maneuver: { type: 'turn', modifier: 'left', location: [19, 47.0036] } },
    { name: 'B utca', distance: 0, duration: 0, maneuver: { type: 'arrive', location: [19, 47.004] } },
  ] }] }] });
  assert.equal(osrm.distance, 500);
  assert.equal(osrm.geometry.length, 2);
  assert.deepEqual(osrm.steps.map((s) => [s.type, s.modifier, s.name]), [['depart', undefined, 'A utca'], ['turn', 'left', 'M0'], ['arrive', undefined, 'B utca']]);
  assert.equal(S.normalizeOsrm({ code: 'NoRoute' }), null);

  const photon = S.normalizePhoton({ features: [{ geometry: { coordinates: [19.07, 47.51] }, properties: { name: 'Hősök tere', district: 'Városliget', city: 'Budapest', country: 'Magyarország' } }, { properties: {} }] });
  assert.deepEqual(photon, [{ label: 'Hősök tere', detail: 'Városliget, Budapest, Magyarország', lon: 19.07, lat: 47.51 }]);

  const dupes = S.normalizePhoton({ features: [
    { geometry: { coordinates: [19.0566, 47.5103] }, properties: { name: 'Nyugati pályaudvar', city: 'Budapest' } },
    { geometry: { coordinates: [19.0571, 47.5108] }, properties: { name: 'Nyugati pályaudvar', city: 'Budapest' } },
    { geometry: { coordinates: [19.0566, 47.5103] }, properties: { name: 'Nyugati pályaudvar M', city: 'Budapest' } },
    { geometry: { coordinates: [17.9, 47.1] }, properties: { name: 'Nyugati pályaudvar', city: 'Elsewhere' } },
  ] });
  assert.deepEqual(dupes.map((r) => r.detail), ['Budapest', 'Budapest', 'Elsewhere'], 'same place twice is dropped, same name far away is kept');

  const nom = S.normalizeNominatim([{ lat: '47.5', lon: '19.04', name: 'Lánchíd', display_name: 'Lánchíd, I. kerület, Budapest, Magyarország' }, { lat: 'x', lon: 'y' }]);
  assert.deepEqual(nom, [{ label: 'Lánchíd', detail: 'I. kerület, Budapest, Magyarország', lon: 19.04, lat: 47.5 }]);
});

// ---- Server ----

function fakeFetch(handler) {
  const calls = [];
  const fn = async (url, opts) => {
    calls.push({ url, ua: opts?.headers?.['user-agent'] });
    const body = await handler(url);
    if (body instanceof Error) throw body;
    return { ok: true, status: 200, json: async () => body };
  };
  fn.calls = calls;
  return fn;
}

async function withServer(fetchImpl, fn) {
  const { cfg } = S.loadNavConfig({ env: { RIGS_HOME: process.env.RIGS_HOME }, configFile: path.join(process.env.RIGS_HOME, 'missing.json') });
  const server = S.createNavServer({ cfg, fetchImpl });
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  const base = `http://127.0.0.1:${server.address().port}`;
  try { await fn(base); } finally { await new Promise((r) => server.close(r)); }
}

test('server: /healthz, /config.json and the UI with relative URLs only', async () => {
  await withServer(fakeFetch(() => ({})), async (base) => {
    const h = await fetch(base + '/healthz');
    assert.equal(h.status, 200);
    assert.deepEqual(await h.json(), { ok: true });

    const c = await (await fetch(base + '/config.json')).json();
    assert.equal(c.tiles, S.DEFAULTS.tilesUrl);
    assert.ok(Array.isArray(c.demo.from));

    const page = await fetch(base + '/');
    assert.equal(page.status, 200);
    assert.match(page.headers.get('content-type'), /text\/html/);
    const html = await page.text();
    assert.doesNotMatch(html, /(?:src|href)="\/(?!\/)/, 'no root-relative URLs in index.html');
    for (const f of ['app.js', 'geo.js', 'mapstyle.js', 'traffic.js', 'style.css']) {
      const r = await fetch(base + '/' + f);
      assert.equal(r.status, 200, f);
      const text = await r.text();
      assert.doesNotMatch(text, /fetch\(\s*['"`]\//, `${f}: no root-relative fetch`);
      assert.doesNotMatch(text, /url\(\s*['"]?\/(?!\/)/, `${f}: no root-relative CSS url()`);
    }
    assert.equal((await fetch(base + '/%2e%2e/server.js')).status, 404, 'no escaping public/');
    assert.equal((await fetch(base + '/nope.js')).status, 404);
    assert.equal((await fetch(base + '/healthz', { method: 'POST' })).status, 405);
  });
});

test('server: api/route proxies OSRM with a User-Agent, validates input and caches', async () => {
  const f = fakeFetch((url) => (url.includes('/route/v1/driving/') ? { code: 'Ok', routes: [{ distance: 10, duration: 2, geometry: { coordinates: [[19, 47], [19, 47.0001]] }, legs: [{ steps: [{ name: 'X', maneuver: { type: 'depart', location: [19, 47] } }] }] }] } : {}));
  await withServer(f, async (base) => {
    const r = await fetch(base + '/api/route?from=19,47&to=19,47.0001');
    assert.equal(r.status, 200);
    const route = await r.json();
    assert.equal(route.distance, 10);
    assert.equal(route.steps[0].name, 'X');
    assert.match(f.calls[0].url, /^https:\/\/router\.project-osrm\.org\/route\/v1\/driving\/19,47;19,47\.0001\?.*steps=true/);
    assert.match(f.calls[0].ua, /rigs-navigation-applet/);
    await fetch(base + '/api/route?from=19,47&to=19,47.0001');
    assert.equal(f.calls.length, 1, 'second identical request served from cache');
    assert.equal((await fetch(base + '/api/route?from=19,47&to=abc')).status, 400);
    assert.equal((await fetch(base + '/api/route?from=200,47&to=19,47')).status, 400);
  });
});

test('server: api/search uses Photon and falls back to Nominatim', async () => {
  const f = fakeFetch((url) => {
    if (url.startsWith('https://photon.komoot.io')) return new Error('photon down');
    return [{ lat: '47.5', lon: '19.04', name: 'Lánchíd', display_name: 'Lánchíd, Budapest' }];
  });
  await withServer(f, async (base) => {
    const r = await fetch(base + '/api/search?q=Lanchid&near=19.04,47.5');
    assert.equal(r.status, 200);
    const { results } = await r.json();
    assert.equal(results[0].label, 'Lánchíd');
    assert.match(f.calls[0].url, /photon\.komoot\.io\/api\/\?q=Lanchid.*lon=19\.04&lat=47\.5/);
    assert.match(f.calls[1].url, /nominatim\.openstreetmap\.org\/search\?format=jsonv2.*viewbox=/);
    assert.equal((await fetch(base + '/api/search?q=a')).status, 400);
  });
});

// ---- Traffic ----

// A tiny Mapbox Vector Tile encoder, enough to hand-build fixtures for the reader.
const varint = (n) => { const out = []; while (n > 127) { out.push((n % 128) | 128); n = Math.floor(n / 128); } out.push(n); return out; };
const pbField = (f, wire, payload) => [...varint(f * 8 + wire), ...payload];
const pbBytes = (f, arr) => pbField(f, 2, [...varint(arr.length), ...arr]);
const pbStr = (f, s) => pbBytes(f, [...Buffer.from(s)]);
const zz = (n) => (n << 1) ^ (n >> 31);
function lineCmds(pts, close = false) {
  const cmds = [1 | (1 << 3), zz(pts[0][0]), zz(pts[0][1]), 2 | ((pts.length - 1) << 3)];
  for (let i = 1; i < pts.length; i++) cmds.push(zz(pts[i][0] - pts[i - 1][0]), zz(pts[i][1] - pts[i - 1][1]));
  if (close) cmds.push(7 | (1 << 3));
  return cmds;
}
function mvtLayer(name, features, extent = 4096) {
  const keys = [], values = [];
  const idx = (list, v) => { const k = JSON.stringify(v); let i = list.findIndex((x) => JSON.stringify(x) === k); if (i < 0) { list.push(v); i = list.length - 1; } return i; };
  const encValue = (v) => {
    if (typeof v === 'string') return pbStr(1, v);
    if (typeof v === 'boolean') return pbField(7, 0, [v ? 1 : 0]);
    if (Number.isInteger(v)) return v >= 0 ? pbField(5, 0, varint(v)) : pbField(6, 0, varint(zz(v)));
    const b = Buffer.alloc(8); b.writeDoubleLE(v); return pbField(3, 1, [...b]);
  };
  const feats = features.map(({ type = 2, pts, props }) => {
    const tags = Object.entries(props).flatMap(([k, v]) => [idx(keys, k), idx(values, v)]);
    return pbBytes(2, [...pbField(3, 0, varint(type)), ...pbBytes(2, tags.flatMap(varint)), ...pbBytes(4, lineCmds(pts, type === 3).flatMap(varint))]);
  });
  return pbBytes(3, [...pbField(15, 0, [2]), ...pbStr(1, name), ...feats.flat(), ...keys.flatMap((k) => pbStr(3, k)), ...values.flatMap((v) => pbBytes(4, encValue(v))), ...pbField(5, 0, varint(extent))]);
}
const mvt = (...layers) => Buffer.from(layers.flat());

// Deák tér, Budapest: the tile docs/traffic-source.md decoded.
const TX = 9059, TY = 5729, TZ = 14;
const omtFixture = () => mvt(mvtLayer('water', [{ type: 3, pts: [[0, 0], [10, 0], [10, 10]], props: { class: 'river' } }]), mvtLayer('transportation', [
  { pts: [[-100, 2000], [4200, 2000]], props: { class: 'primary', oneway: 1 } }, // crosses both tile edges
  { pts: [[1000, 1000], [1000, 3000]], props: { class: 'minor' } },
  { pts: [[3000, 3000], [3000, 1000]], props: { class: 'secondary', oneway: -1 } }, // drawn backwards
  { pts: [[1500, 1500], [2500, 1500]], props: { class: 'path' } },                   // not a road
  { pts: [[1500, 2500], [2500, 2500]], props: { class: 'primary', brunnel: 'tunnel' } },
  { pts: [[4000, 4000], [4090, 4090]], props: { class: 'service' } },                // far corner
]));
const ttFixture = () => mvt(mvtLayer('Traffic flow', [
  { pts: [[0, 2000], [4096, 2000]], props: { road_category: 'primary', traffic_level: 0.31, traffic_road_coverage: 'one_side' } },
  { pts: [[1000, 0], [1000, 4096]], props: { road_type: 'Local road', traffic_level: 1 } },
  { pts: [[2000, 0], [2000, 4096]], props: { road_category: 'secondary', traffic_level: 0.9, road_closure: true } },
]));

test('traffic: the vector-tile reader decodes layers, properties and geometry', () => {
  const d = T.decodeMvt(omtFixture());
  assert.deepEqual(Object.keys(d).sort(), ['transportation', 'water']);
  assert.equal(d.transportation.extent, 4096);
  assert.equal(d.transportation.features.length, 6);
  assert.deepEqual(d.transportation.features[0].properties, { class: 'primary', oneway: 1 });
  assert.deepEqual(d.transportation.features[0].lines, [[[-100, 2000], [4200, 2000]]]);
  assert.equal(d.transportation.features[2].properties.oneway, -1, 'negative ints (sint) survive');
  assert.deepEqual(d.water.features[0].lines[0].at(-1), [0, 0], 'polygon rings are closed');
  assert.deepEqual(Object.keys(T.decodeMvt(omtFixture(), ['transportation'])), ['transportation'], 'other layers skipped');
  const tt = T.decodeMvt(ttFixture())['Traffic flow'].features;
  near(tt[0].properties.traffic_level, 0.31, 1e-12);
  assert.equal(tt[2].properties.road_closure, true);
});

test('traffic: tile maths, bbox cap and clipping to the tile', () => {
  const [x, y] = T.lonLatToTile(19.0548, 47.4979, 14).map(Math.floor);
  assert.deepEqual([x, y], [TX, TY], 'Deák tér is z14 tile 9059/5729');
  const [lon, lat] = T.tileToLonLat(TX, TY, TZ);
  assert.deepEqual(T.lonLatToTile(lon, lat, TZ).map((v) => Math.round(v * 1e6) / 1e6), [TX, TY]);
  assert.equal(T.tileZoomFor(16.4), 14);
  assert.equal(T.tileZoomFor(9), 12);
  const one = T.tilesForBbox([lon + 0.001, lat - 0.01, lon + 0.002, lat - 0.001], 14);
  assert.deepEqual(one, { tiles: [[TX, TY]], clipped: false });
  const big = T.tilesForBbox([18.9, 47.4, 19.2, 47.6], 14);
  assert.equal(big.tiles.length, 16);
  assert.equal(big.clipped, true, 'never more than 16 tiles; says so');
  const [cx, cy] = T.lonLatToTile(19.05, 47.5, 14);
  for (const [tx, ty] of big.tiles) assert.ok(Math.hypot(tx + 0.5 - cx, ty + 0.5 - cy) < 3, 'the 16 kept are the ones nearest the centre');

  assert.deepEqual(T.clipLine([[-100, 2000], [4200, 2000]], 4096), [[[0, 2000], [4096, 2000]]]);
  assert.deepEqual(T.clipLine([[-10, -10], [-5, -50]], 4096), [], 'outside: nothing');
  const twice = T.clipLine([[100, 100], [100, -100], [200, -100], [200, 100]], 4096);
  assert.deepEqual(twice, [[[100, 100], [100, 0]], [[200, 0], [200, 100]]], 'leaving and re-entering gives two parts');
});

test('traffic: OpenMapTiles and TomTom layers → contract segments', () => {
  const roads = T.omtRoads(T.decodeMvt(omtFixture()), TZ, TX, TY);
  assert.deepEqual(roads.map((r) => [r.id, r.class, !!r.oneway]), [
    ['omt:14/9059/5729:0:0', 'primary', true], ['omt:14/9059/5729:1:0', 'minor', false],
    ['omt:14/9059/5729:2:0', 'secondary', true], ['omt:14/9059/5729:5:0', 'service', false],
  ], 'path and tunnel dropped, ids are <src>:<z>/<x>/<y>:<feature>:<part>');
  const [w] = T.tileToLonLat(TX, TY, TZ), [e] = T.tileToLonLat(TX + 1, TY, TZ);
  near(roads[0].coords[0][0], Number(w.toFixed(6)), 1e-9, 'clipped at the west edge');
  near(roads[0].coords.at(-1)[0], Number(e.toFixed(6)), 1e-9, 'and the east edge');
  for (const c of roads.flatMap((r) => r.coords).flat()) assert.equal(c, Math.round(c * 1e6) / 1e6, '6 decimals');
  assert.ok(roads[2].coords[0][1] > roads[2].coords[1][1], 'oneway -1 (drawn northward) is turned round: cars drive the coords order, southward');

  const tt = T.tomtomSegments(T.decodeMvt(ttFixture()), TZ, TX, TY);
  assert.deepEqual(tt.map((s) => [s.id, s.class, s.congestion, s.speedKmh, !!s.oneway]), [
    ['tt:14/9059/5729:0:0', 'primary', 0.69, 16, true],  // congestion = 1 − traffic_level, speed = V × level
    ['tt:14/9059/5729:1:0', 'minor', 0, 30, false],      // road_type fallback
    ['tt:14/9059/5729:2:0', 'secondary', 1, 0, false],   // closure
  ]);
});

test('traffic: synthetic model is deterministic by class, hour and route', () => {
  // Demand curve: the doc's table.
  const D = [[3, 0.09, 0.07], [7.75, 0.77, 0.19], [12, 0.50, 0.52], [16.75, 0.85, 0.38], [21, 0.10, 0.11]];
  for (const [h, wd, we] of D) { near(T.demand(h, false), wd, 0.011, `weekday ${h}`); near(T.demand(h, true), we, 0.011, `weekend ${h}`); }
  // Worked example: a primary road on the route, weekday 17:30, u = 0.73 → 0.76, 12 km/h.
  const rush = { hour: 17.5, minutes: 1050, weekend: false };
  const ex = T.syntheticTraffic('primary', rush, 0.73, 50);
  near(ex.congestion, 0.76, 0.011);
  near(ex.speedKmh, 12, 1);
  assert.deepEqual(T.syntheticTraffic('primary', rush, 0.73, 50), ex, 'same inputs, same answer');
  // Same street jitter for all (same u and minute): the order is pure class load.
  const at = (cls) => T.syntheticTraffic(cls, rush, 0.5).congestion;
  const order = ['motorway', 'trunk', 'primary', 'secondary', 'tertiary', 'minor', 'service'].map((c) => at(c));
  for (let i = 1; i < order.length; i++) assert.ok(order[i - 1] >= order[i], `busier class first: ${order}`);
  const night = { hour: 3, minutes: 180, weekend: false }; // u = 0.5 and m = 180 → no jitter
  // The doc rounds this to "under 0.18"; the formula gives motorways 0.6·(0.2 + 1.2·0.087) = 0.18.
  for (const c of Object.keys(T.CLASSES)) assert.ok(T.syntheticTraffic(c, night, 0.5).congestion <= 0.19, `${c} quiet at 03:00`);
  assert.ok(at('primary') > T.syntheticTraffic('primary', night, 0.5).congestion + 0.3, 'rush hour is much heavier than night');
  // Route closeness: +0.12 within 100 m, fading out by 500 m.
  assert.equal(T.routeBump(80), 0.12);
  near(T.routeBump(300), 0.06, 1e-9);
  assert.equal(T.routeBump(600), 0);
  // Speeds fall with congestion and never claim a full stop.
  const s = T.syntheticTraffic('motorway', { hour: 17, minutes: 1020, weekend: false }, 0.99, 0);
  assert.ok(s.congestion <= 0.95 && s.speedKmh >= 3);
  assert.equal(T.syntheticTraffic('path', night, 0.5), null);
  // Class filter by zoom.
  assert.deepEqual(T.classesForZoom(12), ['motorway', 'trunk', 'primary', 'secondary']);
  assert.ok(!T.classesForZoom(14).includes('minor'));
  assert.ok(T.classesForZoom(16).includes('service'));
  // Local clock: weekday / weekend / fixed holiday, in the requested zone; a bad zone falls back.
  assert.deepEqual(T.localClock(new Date('2026-10-16T15:30:00Z'), 'Europe/Budapest'), { hour: 17.5, minutes: 1050, weekend: false });
  assert.equal(T.localClock(new Date('2026-10-17T15:30:00Z'), 'Europe/Budapest').weekend, true, 'Saturday');
  assert.equal(T.localClock(new Date('2026-10-23T08:00:00Z'), 'Europe/Budapest').weekend, true, '23 October is a holiday');
  assert.ok(Number.isFinite(T.localClock(new Date(), 'Not/AZone').hour));
});

// A fake upstream that serves the OpenFreeMap TileJSON + one tile and, optionally, TomTom.
function trafficFetch({ tomtom = () => new Response(ttFixture()), omt = () => new Response(omtFixture()) } = {}) {
  const calls = [];
  const fn = async (url, opts) => {
    calls.push({ url, ua: opts?.headers?.['user-agent'] });
    if (url === S.DEFAULTS.tilesUrl) return Response.json({ tiles: ['https://tiles.example/v1/{z}/{x}/{y}.pbf'], maxzoom: 14 });
    if (url.startsWith('https://tiles.example/v1/14/9059/5729.pbf')) return omt();
    if (url.startsWith('https://tiles.example/')) return new Response('', { status: 404 });
    if (url.startsWith('https://api.tomtom.com/traffic/map/4/tile/flow/relative/14/9059/5729.pbf')) return tomtom(url);
    return new Response('', { status: 404 });
  };
  fn.calls = calls;
  fn.count = (re) => calls.filter((c) => re.test(c.url)).length;
  return fn;
}

async function withNav({ fetchImpl, cfg: over = {}, now }, fn) {
  const { cfg } = S.loadNavConfig({ env: { RIGS_HOME: process.env.RIGS_HOME }, configFile: path.join(process.env.RIGS_HOME, 'missing.json') });
  const server = S.createNavServer({ cfg: { ...cfg, ...over }, fetchImpl, now });
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  const base = `http://127.0.0.1:${server.address().port}`;
  try { await fn(base); } finally { await new Promise((r) => server.close(r)); }
}

// The middle of the fixture tile, which leaves out the service road in its far corner.
const [W0, N0] = T.tileToLonLat(TX + 0.1, TY + 0.1, TZ);
const [E0, S0] = T.tileToLonLat(TX + 0.9, TY + 0.9, TZ);
const BBOX = [W0, S0, E0, N0].map((v) => v.toFixed(6)).join(',');
const CLASSES = new Set(['motorway', 'trunk', 'primary', 'secondary', 'tertiary', 'minor', 'service']);

function assertContract(body) {
  assert.ok(['tomtom', 'synthetic', 'none'].includes(body.source));
  assert.ok(!Number.isNaN(Date.parse(body.updated)), 'updated is an ISO time');
  assert.equal(typeof body.clipped, 'boolean');
  assert.ok(Array.isArray(body.segments));
  for (const s of body.segments) {
    assert.match(s.id, /^(omt|tt):\d+\/\d+\/\d+:\d+:\d+$/);
    assert.ok(Array.isArray(s.coords) && s.coords.length >= 2 && s.coords.every((c) => c.length === 2 && c.every(Number.isFinite)));
    assert.ok(CLASSES.has(s.class), s.class);
    assert.ok(s.congestion >= 0 && s.congestion <= 1);
    assert.ok(s.speedKmh >= 0);
    if ('oneway' in s) assert.equal(s.oneway, true);
  }
}

test('server: api/traffic without a key serves the synthetic model, clipped to the bbox and cached', async () => {
  const f = trafficFetch();
  await withNav({ fetchImpl: f }, async (base) => {
    const c = await (await fetch(base + '/config.json')).json();
    assert.deepEqual(c.traffic, { source: 'synthetic' });
    const r = await fetch(`${base}/api/traffic?bbox=${BBOX}&z=16&tz=Europe/Budapest&at=2026-10-16T15:30:00Z`);
    assert.equal(r.status, 200);
    assert.equal(r.headers.get('cache-control'), 'private, max-age=30');
    const body = await r.json();
    assertContract(body);
    assert.equal(body.source, 'synthetic');
    assert.equal(body.updated, '2026-10-16T15:30:00.000Z');
    assert.equal(body.z, 14);
    assert.deepEqual(body.segments.map((s) => s.class).sort(), ['minor', 'primary', 'secondary'], 'corner road outside the bbox is left out');
    const primary = body.segments.find((s) => s.class === 'primary');
    const minor = body.segments.find((s) => s.class === 'minor');
    assert.ok(primary.congestion > minor.congestion && primary.speedKmh < 50, 'rush hour loads the arterial');
    assert.match(f.calls[0].ua, /rigs-navigation-applet/);

    const again = await (await fetch(`${base}/api/traffic?bbox=${BBOX}&z=16&tz=Europe/Budapest&at=2026-10-16T15:30:00Z`)).json();
    assert.deepEqual(again, body, 'deterministic');
    assert.equal(f.count(/tiles\.example\/v1\/14/), 1, 'tile fetched once, then served from memory');
    assert.equal(f.count(/tomtom/), 0, 'no key: TomTom never called');

    const z14 = await (await fetch(`${base}/api/traffic?bbox=${BBOX}&z=14.4`)).json();
    assert.deepEqual(z14.segments.map((s) => s.class).sort(), ['primary', 'secondary'], 'minor roads dropped below z15');

    const gz = await fetch(`${base}/api/traffic?bbox=19.0,47.45,19.2,47.55&z=16`, { headers: { 'accept-encoding': 'gzip' } });
    assert.equal((await gz.json()).clipped, true, 'oversized bbox is capped, not refused');

    for (const q of ['bbox=1,2,3&z=16', 'bbox=19.1,47.5,19.0,47.6&z=16', 'bbox=a,b,c,d&z=16', `bbox=${BBOX}`]) {
      assert.equal((await fetch(`${base}/api/traffic?${q}`)).status, 400, q);
    }
  });
});

test('server: api/traffic routeId bumps the roads along the route', async () => {
  const [lonA, latA] = T.tileToLonLat(TX + 0.05, TY + 2000 / 4096, TZ);
  const [lonB, latB] = T.tileToLonLat(TX + 0.95, TY + 2000 / 4096, TZ);
  const f = trafficFetch();
  const osrm = async (url, opts) => (url.includes('/route/v1/driving/')
    ? Response.json({ code: 'Ok', routes: [{ distance: 1000, duration: 100, geometry: { coordinates: [[lonA, latA], [lonB, latB]] }, legs: [{ steps: [] }] }] })
    : f(url, opts));
  await withNav({ fetchImpl: osrm }, async (base) => {
    const route = await (await fetch(`${base}/api/route?from=${lonA},${latA}&to=${lonB},${latB}`)).json();
    assert.match(route.routeId, /^[0-9a-z]+$/);
    const q = `${base}/api/traffic?bbox=${BBOX}&z=16&tz=Europe/Budapest&at=2026-10-16T02:00:00Z`;
    const plain = (await (await fetch(q)).json()).segments.find((s) => s.class === 'primary');
    const onRoute = (await (await fetch(q + '&route=' + route.routeId)).json()).segments.find((s) => s.class === 'primary');
    near(onRoute.congestion - plain.congestion, 0.12, 0.011, 'the road the route runs along gets the +0.12 bump');
    const unknown = (await (await fetch(q + '&route=nope')).json()).segments.find((s) => s.class === 'primary');
    assert.equal(unknown.congestion, plain.congestion, 'unknown route ids are ignored');
  });
});

test('server: api/traffic uses TomTom when keyed, caches 60 s, falls back on 429/401 without leaking the key', async () => {
  const KEY = 'tt-test-key-1234567890';
  let clock = Date.parse('2026-10-16T15:30:00Z');
  const now = () => clock;
  const f = trafficFetch();
  await withNav({ fetchImpl: f, cfg: { tomtomKey: KEY }, now }, async (base) => {
    assert.deepEqual((await (await fetch(base + '/config.json')).json()).traffic, { source: 'tomtom' });
    assert.ok(!(await (await fetch(base + '/config.json')).text()).includes(KEY), 'key never reaches the browser');
    const r = await fetch(`${base}/api/traffic?bbox=${BBOX}&z=16`);
    const text = await r.text();
    assert.ok(!text.includes(KEY));
    const body = JSON.parse(text);
    assertContract(body);
    assert.equal(body.source, 'tomtom');
    assert.deepEqual(body.segments.map((s) => s.id).sort(), ['tt:14/9059/5729:0:0', 'tt:14/9059/5729:1:0', 'tt:14/9059/5729:2:0']);
    assert.match(f.calls.find((c) => /tomtom/.test(c.url)).url, /flow\/relative\/14\/9059\/5729\.pbf\?key=tt-test-key/);
    await fetch(`${base}/api/traffic?bbox=${BBOX}&z=16`);
    assert.equal(f.count(/tomtom/), 1, 'second poll within 60 s is served from memory');
    clock += 61000;
    await fetch(`${base}/api/traffic?bbox=${BBOX}&z=16`);
    assert.equal(f.count(/tomtom/), 2, 'refetched after 60 s');
    assert.equal((await (await fetch(`${base}/api/traffic?bbox=${BBOX}&z=16&source=synthetic`)).json()).source, 'synthetic', 'source=synthetic forces the fallback');
  });

  // 429 → synthetic for 15 min, then TomTom again.
  clock = Date.parse('2026-10-16T15:30:00Z');
  let status = 429;
  const limited = trafficFetch({ tomtom: () => (status === 200 ? new Response(ttFixture()) : new Response('{}', { status })) });
  await withNav({ fetchImpl: limited, cfg: { tomtomKey: KEY }, now }, async (base) => {
    assert.equal((await (await fetch(`${base}/api/traffic?bbox=${BBOX}&z=16`)).json()).source, 'synthetic');
    clock += 5 * 60000;
    assert.equal((await (await fetch(`${base}/api/traffic?bbox=${BBOX}&z=16`)).json()).source, 'synthetic');
    assert.equal(limited.count(/tomtom/), 1, 'no TomTom calls during the 15 min back-off');
    status = 200;
    limited.calls.length = 0;
    clock += 11 * 60000;
    assert.equal((await (await fetch(`${base}/api/traffic?bbox=${BBOX}&z=16`)).json()).source, 'tomtom');
  });

  // 401 → synthetic until restart; the one log line names the setting, never the key.
  const logs = [];
  const denied = trafficFetch({ tomtom: () => Response.json({ detailedError: { code: 'Unauthorized' } }, { status: 401 }) });
  const traffic = T.createTraffic({ cfg: { ...S.DEFAULTS, tomtomKey: KEY }, fetchImpl: denied, now, log: (...a) => logs.push(a.join(' ')), userAgent: S.USER_AGENT });
  const bbox = BBOX.split(',').map(Number);
  assert.equal((await traffic.get({ bbox, z: 16 })).source, 'synthetic');
  assert.equal((await traffic.get({ bbox, z: 16 })).source, 'synthetic');
  assert.equal(denied.count(/tomtom/), 1, 'a refused key is not retried');
  assert.equal(logs.length, 1);
  assert.match(logs[0], /NAV_TOMTOM_KEY/);
  assert.ok(!logs.join(' ').includes(KEY), 'logs never contain the key');

  // Daily budget: after trafficDailyTiles TomTom fetches, synthetic until the next UTC day.
  const budget = T.createTraffic({ cfg: { ...S.DEFAULTS, tomtomKey: KEY, trafficDailyTiles: 1 }, fetchImpl: trafficFetch(), now, userAgent: S.USER_AGENT });
  assert.equal((await budget.get({ bbox, z: 16 })).source, 'tomtom');
  clock += 61000;
  assert.equal((await budget.get({ bbox, z: 16 })).source, 'synthetic', 'budget spent');
});

test('server: api/traffic answers 200 with no segments when every source is down', async () => {
  const down = async () => { throw new Error('offline'); };
  await withNav({ fetchImpl: down }, async (base) => {
    const r = await fetch(`${base}/api/traffic?bbox=${BBOX}&z=16`);
    assert.equal(r.status, 200);
    const body = await r.json();
    assertContract(body);
    assert.equal(body.source, 'none');
    assert.deepEqual(body.segments, []);
  });
  await withNav({ fetchImpl: trafficFetch(), cfg: { trafficSource: 'off' } }, async (base) => {
    assert.deepEqual((await (await fetch(base + '/config.json')).json()).traffic, { source: 'off' });
    assert.equal((await (await fetch(`${base}/api/traffic?bbox=${BBOX}&z=16`)).json()).source, 'none');
  });
});

test('loadNavConfig: traffic settings from env and file, key validated without echoing it', () => {
  const file = path.join(process.env.RIGS_HOME, 'traffic.json');
  fs.writeFileSync(file, JSON.stringify({ navigation: { trafficSource: 'synthetic', tomtomKey: 'file-key-abcdef12', trafficDailyTiles: 100 } }));
  const fromFile = S.loadNavConfig({ env: {}, configFile: file }).cfg;
  assert.equal(fromFile.trafficSource, 'synthetic');
  assert.equal(fromFile.tomtomKey, 'file-key-abcdef12');
  assert.equal(fromFile.trafficDailyTiles, 100);
  assert.equal(S.trafficMode(fromFile), 'synthetic', 'forced synthetic even with a key');
  const env = S.loadNavConfig({ env: { NAV_TOMTOM_KEY: 'env-key-12345678', NAV_TRAFFIC_SOURCE: 'auto', NAV_TOMTOM_URL: 'http://tomtom.local' }, configFile: file }).cfg;
  assert.equal(env.tomtomKey, 'env-key-12345678');
  assert.equal(env.tomtomUrl, 'http://tomtom.local');
  assert.equal(S.trafficMode(env), 'tomtom');
  const bad = S.loadNavConfig({ env: { NAV_TOMTOM_KEY: 'bad key with spaces s3cr3t', NAV_TRAFFIC_SOURCE: 'waze', NAV_TRAFFIC_DAILY_TILES: '-1' }, configFile: path.join(process.env.RIGS_HOME, 'missing.json') });
  assert.equal(bad.cfg.tomtomKey, null);
  assert.equal(bad.cfg.trafficSource, 'auto');
  assert.equal(bad.cfg.trafficDailyTiles, 5000);
  assert.equal(bad.warnings.length, 3);
  assert.ok(!bad.warnings.join(' ').includes('s3cr3t'));
  assert.equal(S.trafficMode(bad.cfg), 'synthetic');
});

// ---- Traffic: cars and shading ----

function seededRand(seed = 1) {
  return () => { seed = (seed * 16807) % 2147483647; return (seed - 1) / 2147483646; };
}
// A 1 km north–south street at lon 19.05 starting at lat 47.5 (two-way), joined at its north end by a
// 1 km one-way street running east.
const NS_END = 47.5 + 1000 / 110540;
const street = (over) => ({ id: 'a', coords: [[19.05, 47.5], [19.05, NS_END]], class: 'primary', congestion: 0.1, speedKmh: 45, ...over });
const eastward = (over) => ({ id: 'b', coords: [[19.05, NS_END], [19.05 + 1000 / (111320 * Math.cos((NS_END * Math.PI) / 180)), NS_END]], class: 'primary', congestion: 0.1, speedKmh: 45, oneway: true, ...over });

test('traffic cars: density grows and speed falls with congestion; capped; one GeoJSON source', () => {
  assert.equal(C.carsPerKm('primary', 0), 2);
  assert.equal(C.carsPerKm('primary', 1), 20);
  assert.equal(C.carsPerKm('minor', 1), 10, 'halved on minor roads');

  const sim = C.createTrafficSim({ maxCars: 300, rand: seededRand() });
  sim.setData([street({ id: 'free', congestion: 0.1 }), street({ id: 'jam', congestion: 0.8, speedKmh: 9, coords: [[19.06, 47.5], [19.06, NS_END]] })], [19.05, 47.5]);
  const count = (id) => sim.cars.filter((c) => c.seg.id === id).length;
  assert.ok(count('free') >= 3 && count('free') <= 4, `free road: 2 + 18·0.1 ≈ 3.8 cars/km, got ${count('free')}`);
  assert.ok(count('jam') >= 16 && count('jam') <= 17, `jammed road: 2 + 18·0.8 = 16.4 cars/km, got ${count('jam')}`);
  const fc = sim.features();
  assert.equal(fc.type, 'FeatureCollection');
  assert.equal(fc.features.length, sim.cars.length, 'one point per car in one collection');
  for (const f of fc.features) assert.ok(Number.isFinite(f.properties.b) && f.geometry.type === 'Point');

  // Slower on the jammed road: after 2 s a free car has moved 5x as far as a jammed one.
  const before = sim.cars.map((c) => [c.seg.id, c.s]);
  sim.step(2);
  const moved = (id) => { const k = sim.cars.findIndex((c) => c.seg.id === id && c.s > 0); return sim.cars[k].s - before[k][1]; };
  near(moved('free') / moved('jam'), 45 / 9, 0.8);

  const capped = C.createTrafficSim({ maxCars: 10, rand: seededRand() });
  capped.setData([street({ id: 'far', congestion: 0.9, coords: [[19.2, 47.5], [19.2, NS_END]] }), street({ id: 'near', congestion: 0.9 })], [19.05, 47.5]);
  assert.equal(capped.cars.length, 10, 'never more than maxCars');
  assert.ok(capped.cars.every((c) => c.seg.id === 'near'), 'the roads nearest the vehicle get the cars');
});

test('traffic cars: heading-aligned, keep right on two-way roads, follow the network, survive refreshes', () => {
  const sim = C.createTrafficSim({ maxCars: 50, rand: seededRand(7) });
  sim.setData([street({ congestion: 0.5 }), eastward({ congestion: 0.5 })], [19.05, 47.5]);
  for (const car of sim.cars) {
    const p = sim.locate(car);
    if (car.seg.id === 'a') {
      near(p.bearing, car.dir > 0 ? 0 : 180, 0.5, 'northbound / southbound');
      assert.ok(car.dir > 0 ? p.lon > 19.05 : p.lon < 19.05, 'right-hand traffic: keep right of the centre line');
    } else {
      near(p.bearing, 90, 0.5, 'eastbound one-way');
      near(p.lat, NS_END, 1e-9, 'one-way roads: no lane offset');
    }
  }
  // A northbound car at the end of street a turns onto the one-way street b (its only exit).
  const car = sim.cars.find((c) => c.seg.id === 'a' && c.dir > 0);
  car.s = car.seg.len - 0.1;
  const b = sim.segments.get('b');
  b.target = b.count + 5; // room on b
  sim.step(1);
  assert.equal(car.seg.id, 'b');
  assert.equal(car.dir, 1);

  // A refresh with the same ids keeps the cars where they were.
  const s0 = sim.cars.map((c) => c.s);
  sim.setData([street({ congestion: 0.5 }), eastward({ congestion: 0.5 })], [19.05, 47.5]);
  assert.ok(sim.cars.some((c, i) => c.s === s0[i]), 'cars carry on across polls');
  sim.setData([], [19.05, 47.5]);
  assert.equal(sim.cars.length, 0);
  assert.deepEqual(sim.features().features, []);
});

test('traffic layers: shading darkens with congestion under labels; cars rotate and pitch with the map', () => {
  const { shade, cars } = trafficLayers('traffic', 'traffic-cars');
  assert.equal(shade.type, 'line');
  const style = buildStyle({ tiles: 'https://tiles.example/planet', glyphs: 'https://tiles.example/fonts/{fontstack}/{range}.pbf' });
  const ids = style.layers.map((l) => l.id);
  assert.ok(ids.indexOf('building-3d') < ids.indexOf('road-label'), 'inserting before building-3d keeps the shade under every label');
  // The veil: none at free flow, rising opacity and falling brightness with congestion.
  const lum = (hex) => { const n = parseInt(hex.slice(1), 16); return (((n >> 16) & 255) + ((n >> 8) & 255) + (n & 255)) / 3; };
  const op = TRAFFIC_SHADE.map((r) => r[2]);
  assert.equal(op[0], 0, 'free flow leaves the road colour alone');
  for (let i = 1; i < op.length; i++) assert.ok(op[i] > op[i - 1]);
  // What a neon primary road (#00ff88 at 0.9) looks like under the veil: darker at every step, never black.
  const road = [0, 255 * 0.9, 136 * 0.9];
  const seen = TRAFFIC_SHADE.map(([, color, a]) => { const n = parseInt(color.slice(1), 16); const v = [(n >> 16) & 255, (n >> 8) & 255, n & 255]; return road.reduce((s, c, i) => s + c * (1 - a) + v[i] * a, 0) / 3; });
  for (let i = 1; i < seen.length; i++) assert.ok(seen[i] < seen[i - 1], `heavier is darker: ${seen.map(Math.round)}`);
  assert.ok(seen.at(-1) > lum('#010403') + 20, 'jammed roads stay visible on the base');
  assert.equal(cars.type, 'symbol');
  assert.equal(cars.layout['icon-rotation-alignment'], 'map');
  assert.equal(cars.layout['icon-pitch-alignment'], 'map');
  assert.deepEqual(cars.layout['icon-rotate'], ['get', 'b']);
  assert.equal(cars.layout['icon-allow-overlap'], true);

  const gj = C.shadeFeatures([street({ congestion: 0.7 })]);
  assert.deepEqual(gj.features[0].properties, { class: 'primary', congestion: 0.7 });
  assert.equal(gj.features[0].geometry.type, 'LineString');
});
