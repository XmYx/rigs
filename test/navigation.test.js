// Navigation applet: pure geo/HUD math, the map style, config loading and the applet server
// (healthz, config.json, routing/search proxies with a fake upstream, static files). No network.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { test } from 'node:test';

process.env.RIGS_HOME = fs.mkdtempSync(path.join(os.tmpdir(), 'rigs-nav-'));
const G = await import('../applets/navigation/public/geo.js');
const { buildStyle, routeLayers } = await import('../applets/navigation/public/mapstyle.js');
const S = await import('../applets/navigation/server.js');

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
  assert.deepEqual(Object.keys(pub).sort(), ['demo', 'glyphs', 'provider', 'tiles']);
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
    for (const f of ['app.js', 'geo.js', 'mapstyle.js', 'style.css']) {
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
