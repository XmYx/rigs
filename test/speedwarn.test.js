// Navigation applet: speed limits and speed cameras. maxspeed parsing, limit lookup, camera-ahead
// geometry and the warning-state table (public/speedwarn.js, pure), the Overpass/OSRM digesting
// (speedcams.js) and api/speedcams + api/route/limits with a stubbed upstream. No network.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { test } from 'node:test';

process.env.RIGS_HOME = fs.mkdtempSync(path.join(os.tmpdir(), 'rigs-nav-'));
const W = await import('../applets/navigation/public/speedwarn.js');
const G = await import('../applets/navigation/public/geo.js');
const C = await import('../applets/navigation/speedcams.js');
const S = await import('../applets/navigation/server.js');

const M_PER_DEG_LAT = 111195;
const pos = { lat: 47.5, lon: 19.05 };
/** A camera `m` metres north and `east` metres east of `pos`. */
const camAt = (m, east = 0, extra = {}) => ({ id: 'n1', lat: pos.lat + m / M_PER_DEG_LAT, lon: pos.lon + east / (M_PER_DEG_LAT * Math.cos((pos.lat * Math.PI) / 180)), maxspeed: null, direction: null, ...extra });

test('parseMaxspeed: km/h, mph, implicit zones, lists, and everything that is no number', () => {
  assert.equal(W.parseMaxspeed('50'), 50);
  assert.equal(W.parseMaxspeed(' 130 km/h'), 130);
  assert.equal(W.parseMaxspeed('30 mph'), 48);
  assert.equal(W.parseMaxspeed('70mph'), 113);
  assert.equal(W.parseMaxspeed('RO:urban'), 50);
  assert.equal(W.parseMaxspeed('ro:rural'), 90);
  assert.equal(W.parseMaxspeed('HU:motorway'), 130);
  assert.equal(W.parseMaxspeed('GB:nsl_single'), 96);
  assert.equal(W.parseMaxspeed('50;30'), 30, 'a list takes the lower value');
  assert.equal(W.parseMaxspeed('DE:motorway'), null, 'no general limit');
  assert.equal(W.parseMaxspeed('XX:urban'), null, 'unknown country');
  for (const v of ['none', 'signals', 'walk', 'variable', '', 'fast', '0', '999', null, undefined]) assert.equal(W.parseMaxspeed(v), null, String(v));
  assert.equal(W.parseMaxspeed({ speed: 50, unit: 'km/h' }), 50, 'OSRM annotation');
  assert.equal(W.parseMaxspeed({ speed: 30, unit: 'mph' }), 48);
  assert.equal(W.parseMaxspeed({ unknown: true }), null);
  assert.equal(W.parseMaxspeed({ none: true }), null);
});

test('currentLimit: the limit of the route segment the driver is on, null when unknown', () => {
  const limits = [50, 50, null, 30];
  assert.equal(W.currentLimit({ index: 1 }, limits), 50);
  assert.equal(W.currentLimit({ index: 2 }, limits), null);
  assert.equal(W.currentLimit({ index: 3 }, limits), 30);
  assert.equal(W.currentLimit({ index: 9 }, limits), null, 'past the end');
  assert.equal(W.currentLimit({ index: 0 }, null), null, 'route has no limits');
  assert.equal(W.currentLimit(null, limits), null);
  // geo.routeProgress hands over the segment index
  const route = { geometry: [[19, 47], [19, 47.001], [19, 47.002]], steps: [{ distance: 222, duration: 20, type: 'depart', location: [19, 47] }] };
  assert.equal(W.currentLimit(G.routeProgress(route, { lat: 47.0015, lon: 19 }), [50, 30]), 30);
});

test('cameraWarnRadius grows with speed from 300 m to 800 m', () => {
  assert.equal(W.cameraWarnRadius(0), 300);
  assert.equal(W.cameraWarnRadius(30), 300);
  assert.equal(W.cameraWarnRadius(80), 550);
  assert.equal(W.cameraWarnRadius(130), 800);
  assert.equal(W.cameraWarnRadius(250), 800);
  assert.equal(W.cameraWarnRadius(null), 300);
});

test('nearestCameraAhead: ahead counts; behind, beside, too far and wrong-direction do not', () => {
  const ahead = W.nearestCameraAhead(pos, 0, [camAt(400)]);
  assert.ok(ahead && Math.abs(ahead.distanceM - 400) < 2);
  assert.equal(W.nearestCameraAhead(pos, 180, [camAt(400)]), null, 'behind');
  assert.equal(W.nearestCameraAhead(pos, 0, [camAt(-400)]), null, 'behind, heading north');
  assert.equal(W.nearestCameraAhead(pos, 0, [camAt(100, 400)]), null, 'off to the side, outside the cone');
  assert.ok(W.nearestCameraAhead(pos, 0, [camAt(400, 60)]), 'slightly off the road line, inside the cone');
  assert.equal(W.nearestCameraAhead(pos, 0, [camAt(900)]), null, 'too far');
  assert.ok(W.nearestCameraAhead(pos, 0, [camAt(900)], { maxM: 1000 }));
  // direction-restricted camera: only for traffic travelling that way (±60°)
  assert.ok(W.nearestCameraAhead(pos, 0, [camAt(400, 0, { direction: 10 })]), 'same direction of travel');
  assert.ok(W.nearestCameraAhead(pos, 0, [camAt(400, 0, { direction: 330 })]), 'within tolerance across north');
  assert.equal(W.nearestCameraAhead(pos, 0, [camAt(400, 0, { direction: 180 })]), null, 'camera enforces the opposite direction');
  assert.equal(W.nearestCameraAhead(pos, 0, [camAt(400, 0, { direction: 90 })]), null, 'camera enforces a crossing road');
  // nearest of several; unusable input
  const near = W.nearestCameraAhead(pos, 0, [camAt(600, 0, { id: 'far' }), camAt(200, 0, { id: 'near' }), camAt(-100, 0, { id: 'behind' })]);
  assert.equal(near.camera.id, 'near');
  assert.equal(W.nearestCameraAhead(pos, null, [camAt(400)]), null, 'heading unknown');
  assert.equal(W.nearestCameraAhead(pos, 0, []), null);
  assert.equal(W.nearestCameraAhead(pos, 0, [{ id: 'x' }]), null);
});

test('warningState: every state, tolerance, camera limit overrides the road limit', () => {
  const cam = { id: 'n1', maxspeed: null, direction: null };
  const w = (o) => W.warningState(o);
  // no camera
  assert.equal(w({ speedKmh: 50, limitKmh: 50 }), 'none');
  assert.equal(w({ speedKmh: 53, limitKmh: 50 }), 'none', 'within 3 km/h');
  assert.equal(w({ speedKmh: 54, limitKmh: 50 }), 'speeding');
  assert.equal(w({ speedKmh: 126, limitKmh: 120 }), 'none', '5% of 120 = 6: 126 is the edge');
  assert.equal(w({ speedKmh: 127, limitKmh: 120 }), 'speeding');
  assert.equal(w({ speedKmh: 90, limitKmh: null }), 'none', 'unknown limit: nothing to warn about');
  assert.equal(w({ speedKmh: null, limitKmh: 50 }), 'none');
  // camera in range (300 m radius at 50 km/h → 400 m at 70)
  assert.equal(w({ speedKmh: 45, limitKmh: 50, camera: cam, distanceM: 250 }), 'camera-near');
  assert.equal(w({ speedKmh: 60, limitKmh: 50, camera: cam, distanceM: 250 }), 'camera-speeding');
  assert.equal(w({ speedKmh: 60, limitKmh: 50, camera: cam, distanceM: 500 }), 'speeding', 'beyond the 450 m radius at 60 km/h');
  assert.equal(w({ speedKmh: 130, limitKmh: 130, camera: cam, distanceM: 790 }), 'camera-near', 'radius is 800 m at 130 km/h');
  assert.equal(w({ speedKmh: 60, limitKmh: 50, camera: cam }), 'speeding', 'no distance: the camera is ignored');
  assert.equal(w({ speedKmh: 40, limitKmh: null, camera: cam, distanceM: 100 }), 'camera-near', 'camera without any limit known');
  assert.equal(w({ speedKmh: 90, limitKmh: null, camera: cam, distanceM: 100 }), 'camera-near', 'unknown limit never speeding');
  // the camera's own limit wins when in range, both ways
  assert.equal(w({ speedKmh: 60, limitKmh: 90, camera: { ...cam, maxspeed: 50 }, distanceM: 200 }), 'camera-speeding');
  assert.equal(w({ speedKmh: 60, limitKmh: 40, camera: { ...cam, maxspeed: 70 }, distanceM: 200 }), 'camera-near');
  assert.equal(w({ speedKmh: 60, limitKmh: 90, camera: { ...cam, maxspeed: 50 }, distanceM: 600 }), 'none', 'out of range: road limit applies');
  assert.equal(w({ speedKmh: 60, limitKmh: 90, camera: { ...cam, maxspeed: 30 }, distanceM: 200 }), 'camera-speeding');
  assert.equal(w(), 'none');
});

test('normalizeCameras: nodes, enforcement relations, direction, no red-light cameras', () => {
  const cams = C.normalizeCameras({ elements: [
    { type: 'node', id: 1, lat: 47.5, lon: 19.05, tags: { highway: 'speed_camera', maxspeed: '50', direction: '90' } },
    { type: 'node', id: 2, lat: 47.51, lon: 19.06, tags: { highway: 'speed_camera' } },
    { type: 'node', id: 3, lat: 47.52, lon: 19.07, tags: { highway: 'speed_camera', enforcement: 'traffic_signals' } },
    { type: 'node', id: 4, lat: 47.53, lon: 19.08, tags: { enforcement: 'maxspeed', 'camera:direction': 'NW' } },
    { type: 'node', id: 5, lat: 47.54, lon: 19.09, tags: { highway: 'speed_camera', direction: 'forward', maxspeed: '30 mph' } },
    { type: 'node', id: 6, lat: 47.55, lon: 19.1 }, // relation device without tags of its own
    { type: 'node', id: 7, lat: 47.56, lon: 19.11, tags: { highway: 'bus_stop' } },
    { type: 'relation', id: 100, tags: { type: 'enforcement', enforcement: 'maxspeed', maxspeed: '70' }, members: [{ type: 'node', ref: 6, role: 'device' }, { type: 'way', ref: 9, role: 'from' }] },
  ] });
  assert.deepEqual(cams.map((c) => c.id), ['n1', 'n2', 'n4', 'n5', 'n6']);
  assert.deepEqual(cams[0], { id: 'n1', lat: 47.5, lon: 19.05, maxspeed: 50, direction: 90 });
  assert.deepEqual([cams[1].maxspeed, cams[1].direction], [null, null]);
  assert.equal(cams[2].direction, 315);
  assert.deepEqual([cams[3].maxspeed, cams[3].direction], [48, null], 'mph converted, "forward" is not a bearing');
  assert.equal(cams[4].maxspeed, 70, 'inherited from the relation');
  assert.deepEqual(C.normalizeCameras(null), []);
  assert.deepEqual(C.normalizeCameras({ elements: 'x' }), []);
});

test('route limits: OSRM annotation alignment and Overpass way matching', () => {
  const geom = [[19, 47], [19, 47.005], [19, 47.01]];
  const ann = (maxspeed) => ({ legs: [{ annotation: { maxspeed } }] });
  assert.deepEqual(C.osrmLimits(ann([{ speed: 50, unit: 'km/h' }, { speed: 30, unit: 'mph' }]), 3), [50, 48]);
  assert.deepEqual(C.osrmLimits(ann([{ speed: 50, unit: 'km/h' }, { unknown: true }]), 3), [50, null]);
  assert.equal(C.osrmLimits(ann([{ unknown: true }, { none: true }]), 3), null, 'nothing known: use the fallback');
  assert.equal(C.osrmLimits(ann([{ speed: 50, unit: 'km/h' }]), 3), null, 'not aligned to the geometry');
  assert.equal(C.osrmLimits({ legs: [{}] }, 3), null, 'server returned no annotation');
  assert.equal(C.osrmLimits({}, 3), null);

  const ways = C.normalizeWays({ elements: [
    { type: 'way', tags: { highway: 'primary', maxspeed: '50' }, geometry: [{ lat: 47, lon: 19 }, { lat: 47.005, lon: 19 }] },
    { type: 'way', tags: { highway: 'primary', maxspeed: '30 mph' }, geometry: [{ lat: 47.005, lon: 19 }, { lat: 47.01, lon: 19 }] },
    { type: 'way', tags: { highway: 'service', maxspeed: '10' }, geometry: [{ lat: 47, lon: 19.0003 }, { lat: 47.01, lon: 19.0003 }] }, // 22 m beside: loses to the nearer ones
    { type: 'way', tags: { highway: 'primary', maxspeed: 'none' }, geometry: [{ lat: 47, lon: 19 }, { lat: 47.01, lon: 19 }] },
    { type: 'way', tags: { highway: 'primary', maxspeed: '90' }, geometry: [{ lat: 47.0, lon: 19.01 }, { lat: 47.01, lon: 19.01 }] }, // far away
    { type: 'way', tags: { highway: 'primary', maxspeed: '70' }, geometry: [{ lat: 47.0025, lon: 18.999 }, { lat: 47.0025, lon: 19.001 }] }, // crossing road, other bearing
  ] });
  assert.equal(ways.length, 5, 'the unparseable maxspeed is dropped');
  assert.deepEqual(C.limitsFromWays(geom, ways), [50, 48]);
  assert.deepEqual(C.limitsFromWays(geom, []), [null, null]);
  assert.deepEqual(C.limitsFromWays([[19, 47]], ways), [], 'a single point has no segments');
  assert.deepEqual(C.chunkRanges([0, 10000, 20000, 30000, 40000, 45000]), [[0, 3], [3, 5]]);
  assert.equal(C.parseDirection('270'), 270);
  assert.equal(C.parseDirection('-90'), 270);
  assert.equal(C.parseDirection('forward'), null);
});

// ---- Server, with a stubbed Overpass and OSRM ----

const OVERPASS = 'https://overpass-api.de/api/interpreter?data=';
function fakeUpstream({ osrm, overpass }) {
  const calls = [];
  const fn = async (url) => {
    calls.push(url);
    const body = url.startsWith(OVERPASS) ? await overpass(decodeURIComponent(url.slice(OVERPASS.length))) : url.includes('/route/v1/driving/') ? await osrm(url) : {};
    if (body instanceof Error) throw body;
    return { ok: true, status: 200, json: async () => body };
  };
  fn.calls = calls;
  return fn;
}
async function withServer(fetchImpl, fn, env = {}) {
  const { cfg } = S.loadNavConfig({ env: { RIGS_HOME: process.env.RIGS_HOME, ...env }, configFile: path.join(process.env.RIGS_HOME, 'missing.json') });
  const server = S.createNavServer({ cfg, fetchImpl });
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  try { await fn(`http://127.0.0.1:${server.address().port}`); } finally { await new Promise((r) => server.close(r)); }
}
const getJson = async (url) => { const r = await fetch(url); return { status: r.status, body: await r.json() }; };
const ROUTE_GEOM = [[19, 47], [19, 47.005], [19, 47.01]];
const osrmRoute = (legExtra = {}) => ({ code: 'Ok', routes: [{ distance: 1112, duration: 90, geometry: { coordinates: ROUTE_GEOM }, legs: [{ steps: [{ name: 'X', maneuver: { type: 'depart', location: [19, 47] } }], ...legExtra }] }] });

test('server: NAV_OVERPASS_URL is configurable and validated', () => {
  const ok = S.loadNavConfig({ env: { RIGS_HOME: process.env.RIGS_HOME, NAV_OVERPASS_URL: 'http://localhost:12345/' }, configFile: path.join(process.env.RIGS_HOME, 'none.json') });
  assert.equal(ok.cfg.overpassUrl, 'http://localhost:12345');
  const bad = S.loadNavConfig({ env: { RIGS_HOME: process.env.RIGS_HOME, NAV_OVERPASS_URL: 'ftp://x' }, configFile: path.join(process.env.RIGS_HOME, 'none.json') });
  assert.equal(bad.cfg.overpassUrl, S.DEFAULTS.overpassUrl);
  assert.ok(bad.warnings.some((w) => /overpassUrl/.test(w)));
  assert.ok(!bad.warnings.join('').includes('ftp://x'), 'never echoes the value');
});

test('server: api/speedcams by bbox: Overpass → cameras in the box, cached, validated', async () => {
  const f = fakeUpstream({ osrm: () => ({}), overpass: () => ({ elements: [
    { type: 'node', id: 1, lat: 47.5, lon: 19.05, tags: { highway: 'speed_camera', maxspeed: '50', direction: '45' } },
    { type: 'node', id: 2, lat: 47.5, lon: 19.08, tags: { highway: 'speed_camera' } }, // inside the snapped box, outside the request
  ] }) });
  await withServer(f, async (base) => {
    const r = await getJson(base + '/api/speedcams?bbox=19.04,47.49,19.06,47.51');
    assert.equal(r.status, 200);
    assert.equal(r.body.status, 'ok');
    assert.deepEqual(r.body.cameras, [{ id: 'n1', lat: 47.5, lon: 19.05, maxspeed: 50, direction: 45 }]);
    assert.match(decodeURIComponent(f.calls[0]), /node\["highway"="speed_camera"\]\(47\.45,19,47\.55,19\.1\)/, 'box snapped outward to the 0.05° grid');
    await getJson(base + '/api/speedcams?bbox=19.045,47.495,19.055,47.505');
    assert.equal(f.calls.length, 1, 'a nearby box shares the cached answer');
    assert.equal((await getJson(base + '/api/speedcams')).status, 400);
    assert.equal((await getJson(base + '/api/speedcams?bbox=1,2,3')).status, 400);
    assert.equal((await getJson(base + '/api/speedcams?bbox=19,47,20,48')).status, 400, 'more than 0.5° a side');
  });
});

test('server: api/speedcams answers 200 with no cameras when Overpass is down', async () => {
  const f = fakeUpstream({ osrm: () => ({}), overpass: () => new Error('connect ECONNREFUSED') });
  await withServer(f, async (base) => {
    const r = await getJson(base + '/api/speedcams?bbox=19.04,47.49,19.06,47.51');
    assert.equal(r.status, 200);
    assert.equal(r.body.status, 'unavailable');
    assert.deepEqual(r.body.cameras, []);
    assert.match(r.body.error, /ECONNREFUSED/);
    const again = await getJson(base + '/api/speedcams?bbox=19.04,47.49,19.06,47.51');
    assert.equal(again.status, 200);
    assert.ok(f.calls.length <= 2, 'a failed Overpass is not hammered');
    assert.equal(f.calls.length, 1, 'the second request did not call Overpass again');
  });
});

test('server: api/route carries OSRM limits; api/route/limits and api/speedcams?route= use the route', async () => {
  const f = fakeUpstream({
    osrm: () => osrmRoute({ annotation: { maxspeed: [{ speed: 50, unit: 'km/h' }, { speed: 30, unit: 'mph' }] } }),
    overpass: () => ({ elements: [
      { type: 'node', id: 1, lat: 47.004, lon: 19.0002, tags: { highway: 'speed_camera', maxspeed: '50' } }, // on the route
      { type: 'node', id: 2, lat: 47.004, lon: 19.002, tags: { highway: 'speed_camera' } }, // 150 m off it
    ] }),
  });
  await withServer(f, async (base) => {
    const route = (await getJson(base + '/api/route?from=19,47&to=19,47.01')).body;
    assert.match(f.calls[0], /annotations=maxspeed/);
    assert.deepEqual(route.limits, [50, 48]);
    const lim = await getJson(base + `/api/route/limits?route=${route.routeId}`);
    assert.equal(lim.status, 200);
    assert.deepEqual(lim.body, { routeId: route.routeId, source: 'osrm', limits: [50, 48] });
    assert.equal(f.calls.length, 1, 'no Overpass call when OSRM had the limits');
    const cams = await getJson(base + `/api/speedcams?route=${route.routeId}`);
    assert.equal(cams.status, 200);
    assert.equal(cams.body.status, 'ok');
    assert.deepEqual(cams.body.cameras.map((c) => c.id), ['n1'], 'only cameras on the route');
    assert.equal((await getJson(base + '/api/route/limits?route=nope')).status, 404);
    assert.equal((await getJson(base + '/api/speedcams?route=nope')).status, 404);
  });
});

test('server: route limits fall back to Overpass way tags, and to null when that is down too', async () => {
  const ways = { elements: [
    { type: 'way', tags: { highway: 'primary', maxspeed: '50' }, geometry: [{ lat: 47, lon: 19 }, { lat: 47.005, lon: 19 }] },
    { type: 'way', tags: { highway: 'primary', maxspeed: '30 mph' }, geometry: [{ lat: 47.005, lon: 19 }, { lat: 47.01, lon: 19 }] },
  ] };
  const f = fakeUpstream({ osrm: () => osrmRoute(), overpass: () => ways });
  await withServer(f, async (base) => {
    const route = (await getJson(base + '/api/route?from=19,47&to=19,47.01')).body;
    assert.equal(route.limits, null, 'OSRM sent no annotation');
    const lim = (await getJson(base + `/api/route/limits?route=${route.routeId}`)).body;
    assert.equal(lim.source, 'overpass');
    assert.deepEqual(lim.limits, [50, 48]);
    assert.match(decodeURIComponent(f.calls.at(-1)), /way\["highway"\]\["maxspeed"\]/);
  });
  // a routing server that rejects the annotation still routes; Overpass down → null limits, still 200
  const down = fakeUpstream({ osrm: () => osrmRoute(), overpass: () => new Error('timeout') });
  const rejecting = async (url, o) => (url.includes('annotations=') ? { ok: false, status: 400, json: async () => ({}) } : down(url, o));
  await withServer(rejecting, async (base) => {
    const r = await getJson(base + '/api/route?from=19,47&to=19,47.01');
    assert.equal(r.status, 200);
    assert.equal(r.body.limits, null);
    const lim = await getJson(base + `/api/route/limits?route=${r.body.routeId}`);
    assert.equal(lim.status, 200);
    assert.deepEqual(lim.body, { routeId: r.body.routeId, source: 'none', limits: null });
  });
});
