// Navigation trips panel: the pure helpers behind it (speed and trip colours, speed-coloured
// segments, replay interpolation by real timestamps, the speed chart), the server pieces it uses
// (api/trips/tracks, api/reverse and its off switch), and that the page has every element the panel
// script addresses. No network: upstream geocoders are faked.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { test } from 'node:test';

process.env.RIGS_HOME = fs.mkdtempSync(path.join(os.tmpdir(), 'rigs-trips-panel-'));
const V = await import('../applets/navigation/public/tripsview.js');
const { speedProfile, tripStats } = await import('../applets/navigation/public/tripstats.js');
const { thinTrack } = await import('../applets/navigation/tripstore.js');
const S = await import('../applets/navigation/server.js');

const M_PER_DEG = 111195;
const PUBLIC = path.join(import.meta.dirname, '../applets/navigation/public');

/** A drive from (47, 19): `legs` of [seconds, m/s, heading°] at 1 Hz; returns fixes. */
function track(legs, { t0 = 1_790_000_000_000 } = {}) {
  const out = [];
  let lat = 47, lon = 19, t = t0;
  out.push({ t, lat, lon, speed: 0, heading: null, accuracy: 5 });
  for (const [secs, v, h] of legs) {
    for (let i = 0; i < secs; i++) {
      t += 1000;
      lat += (v * Math.cos((h * Math.PI) / 180)) / M_PER_DEG;
      lon += (v * Math.sin((h * Math.PI) / 180)) / (M_PER_DEG * Math.cos((lat * Math.PI) / 180));
      out.push({ t, lat, lon, speed: v, heading: h, accuracy: 5 });
    }
  }
  return out;
}

test('tripsview: speed colours follow the ramp; trip colours are distinct and never the map green', () => {
  assert.equal(V.speedColor(0), V.SPEED_STOPS[0][1]);
  assert.equal(V.speedColor(30 / 3.6), '#00ff88');
  assert.equal(V.speedColor(500), V.SPEED_STOPS.at(-1)[1], 'beyond the ramp: the last colour');
  assert.equal(V.speedColor(NaN), V.SPEED_STOPS[0][1]);
  const expr = V.speedColorExpr();
  assert.equal(expr[0], 'interpolate');
  assert.equal(expr.length, 3 + V.SPEED_STOPS.length * 2);

  const colors = Array.from({ length: 40 }, (_, i) => V.tripColor(i));
  assert.equal(new Set(colors).size, colors.length, 'no two of the first 40 trips share a colour');
  for (const c of colors) {
    assert.match(c, /^#[0-9a-f]{6}$/);
    const [r, g, b] = [1, 3, 5].map((i) => parseInt(c.slice(i, i + 2), 16));
    assert.ok(!(g > 200 && r < 120 && b < 170), `${c} is too close to the base map's neon green`);
  }
});

test('tripsview: speed segments join up, one feature per speed band, ids carried', () => {
  const prof = speedProfile(track([[20, 5, 0], [20, 15, 0], [20, 30, 90]]));
  const fc = V.speedSegments(prof, { id: 'x' });
  assert.ok(fc.features.length >= 3 && fc.features.length < prof.length / 4, `${fc.features.length} features for ${prof.length} fixes`);
  for (let i = 1; i < fc.features.length; i++) {
    assert.deepEqual(fc.features[i].geometry.coordinates[0], fc.features[i - 1].geometry.coordinates.at(-1), 'no gap between bands');
  }
  assert.ok(fc.features.every((f) => f.properties.id === 'x' && f.geometry.coordinates.length >= 2));
  const fast = fc.features.reduce((m, f) => Math.max(m, f.properties.v), 0);
  assert.ok(Math.abs(fast - 30) < 1.5, 'the fast band averages ~30 m/s');
  // [lon, lat, v] input (api/trips/tracks) works the same.
  assert.equal(V.speedSegments([[19, 47, 10], [19.001, 47, 10]]).features.length, 1);
  assert.deepEqual(V.speedSegments([]).features, []);
});

test('tripsview: replay follows the real timestamps, interpolates, and holds heading while stopped', () => {
  const fixes = track([[30, 10, 0], [20, 0, 0], [30, 10, 90]]);
  const tr = V.replayTrack(speedProfile(fixes));
  assert.equal(tr.t0, fixes[0].t);
  assert.equal(tr.t1, fixes.at(-1).t);
  const at = (s) => V.replayAt(tr, tr.t0 + s * 1000);
  assert.ok(Math.abs(at(10).heading - 0) < 3 || Math.abs(at(10).heading - 360) < 3, `north leg heading ${at(10).heading}`);
  assert.ok(Math.abs(at(65).heading - 90) < 3, `east leg heading ${at(65).heading}`);
  // Parked between 30 s and 50 s: the heading is held, not spun by the zero-length steps.
  const parked = [35, 40, 45].map((s) => at(s).heading);
  assert.ok(parked.every((h) => Math.abs(h - parked[0]) < 1e-6), 'heading held while stopped');
  assert.ok(at(40).v < 1.5, 'speed reads ~0 while parked');
  // Halfway between two fixes the position is halfway between them.
  const mid = V.replayAt(tr, (tr.pts[5].t + tr.pts[6].t) / 2);
  assert.ok(Math.abs(mid.lat - (tr.pts[5].lat + tr.pts[6].lat) / 2) < 1e-9);
  // Clamped at both ends.
  assert.equal(V.replayAt(tr, tr.t0 - 5000).i, 0);
  assert.equal(V.replayAt(tr, tr.t1 + 5000).i, tr.pts.length - 1);
  assert.equal(V.replayAt({ pts: [] }, 0), null);
});

test('tripsview: speed chart geometry, axis in the display unit, labels', () => {
  const s = tripStats(track([[60, 25, 0], [60, 10, 0]]));
  const m = V.chartModel(s.timeline, { w: 340, h: 132, unit: 'kmh' });
  assert.ok(m.line.startsWith('M') && m.area.endsWith('Z'));
  assert.ok(m.max >= 90 && m.max <= 120, `km/h axis max ${m.max}`);
  assert.equal(m.grid[0].label, '0');
  assert.ok(Math.abs(m.peak.v - s.maxSpeed) < 0.5, 'the peak dot is the top speed');
  assert.ok(Math.abs(m.tOf(m.xOf(30)) - 30) < 1e-9, 'x ↔ t round trip');
  const mph = V.chartModel(s.timeline, { unit: 'mph' });
  assert.ok(mph.max < m.max, 'mph axis is scaled to mph');
  assert.equal(V.chartModel([], {}).line, '');
  assert.ok(Math.abs(V.timelineAt(s.timeline, 30).v - 25) < 1, 'speed readout mid-leg');

  assert.equal(V.fmtClock(42), '0:42');
  assert.equal(V.fmtClock(3727), '1:02:07');
  assert.equal(V.fmtSpeed(25, 'kmh'), '90 km/h');
  assert.equal(V.fmtSpeed(25, 'mph'), '56 mph');
  assert.equal(V.fmtAccel(2.54), '2.5 m/s²');
  assert.equal(V.tripRoute({ start: { lat: 47.5, lon: 19.05 }, end: { lat: 47.51, lon: 19.08 }, places: { start: 'Deák tér', end: null } }), 'Deák tér → 47.5100, 19.0800');
  assert.equal(V.rangeSince('all', 1e12), null);
  assert.equal(V.rangeSince('7d', 1e12), 1e12 - 7 * 86400000);
  assert.equal(V.rangeSince('30d', 1e12), 1e12 - 30 * 86400000);
});

test('speedProfile and thinTrack: the stats speed per fix; a thinned track keeps its ends and shape', () => {
  const fixes = track([[200, 20, 0], [400, 0, 0], [200, 20, 90]]);
  const prof = speedProfile(fixes);
  const s = tripStats(fixes);
  assert.ok(Math.abs(Math.max(...prof.map((p) => p.v)) - s.maxSpeed) < 1e-9, 'same speed series as tripStats');
  const thin = thinTrack(fixes, 50);
  assert.ok(thin.length <= 52 && thin.length >= 40, `${thin.length} vertices`);
  assert.deepEqual(thin[0].slice(0, 2), [Math.round(fixes[0].lon * 1e5) / 1e5, Math.round(fixes[0].lat * 1e5) / 1e5]);
  assert.deepEqual(thin.at(-1).slice(0, 2), [Math.round(fixes.at(-1).lon * 1e5) / 1e5, Math.round(fixes.at(-1).lat * 1e5) / 1e5]);
  // 400 s parked spend no vertices: they are spread by distance.
  const parked = thin.filter((c) => c[2] < 1).length;
  assert.ok(parked <= 4, `${parked} vertices while parked`);
  assert.deepEqual(thinTrack([]), []);
});

async function withServer(cfgOver, fetchImpl, fn) {
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'rigs-trips-panel-data-'));
  const { cfg } = S.loadNavConfig({ env: { RIGS_HOME: process.env.RIGS_HOME, NAV_DATA_DIR: dataDir }, configFile: path.join(process.env.RIGS_HOME, 'missing.json') });
  const server = S.createNavServer({ cfg: { ...cfg, ...cfgOver }, fetchImpl });
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  try { await fn(`http://127.0.0.1:${server.address().port}`); } finally { await new Promise((r) => server.close(r)); }
}
const json = async (r) => ({ status: r.status, body: await r.json() });
const noNetwork = async () => { throw new Error('no network in tests'); };

test('api/trips/tracks: thinned [lon, lat, v] tracks, newest first, same since filter as the list', async () => {
  await withServer({}, noNetwork, async (base) => {
    const day = 86400000;
    const now = Date.now();
    for (const [id, t0] of [['20261001-080000-aaaa', now - 20 * day], ['20261015-080000-bbbb', now - 2 * day]]) {
      const pts = track([[300, 15, 45]], { t0 });
      const r = await fetch(`${base}/api/trips/${id}/points`, { method: 'POST', body: JSON.stringify({ seq: 0, points: pts, final: true }) });
      assert.equal(r.status, 200);
    }
    const all = await json(await fetch(base + '/api/trips/tracks'));
    assert.equal(all.status, 200);
    assert.deepEqual(all.body.tracks.map((t) => t.id), ['20261015-080000-bbbb', '20261001-080000-aaaa']);
    const t = all.body.tracks[0];
    assert.ok(t.coords.length > 50 && t.coords.length <= 402, `${t.coords.length} vertices`);
    assert.ok(t.coords.every((c) => c.length === 3 && c.every(Number.isFinite)));
    assert.ok(Math.abs(Math.max(...t.coords.map((c) => c[2])) - 15) < 0.5, 'speeds in m/s');
    const week = await json(await fetch(`${base}/api/trips/tracks?since=${now - 7 * day}`));
    assert.deepEqual(week.body.tracks.map((x) => x.id), ['20261015-080000-bbbb']);
    assert.equal((await fetch(base + '/api/trips/tracks', { method: 'POST', body: '{}' })).status, 405);
    assert.equal((await fetch(base + '/api/trips/tracks?since=nope')).status, 400);
    // Cached per file version: a second call gives the same answer.
    assert.deepEqual((await json(await fetch(base + '/api/trips/tracks'))).body, all.body);
  });
});

test('api/reverse: Photon, Nominatim fallback, bad input, and the off switch', async () => {
  const calls = [];
  const photon = { features: [{ properties: { name: 'Ecuadori Nagykövetség', street: 'Andrássy út', housenumber: '20', district: 'Terézváros', city: 'Budapest' } }] };
  const nominatim = { name: '', address: { road: 'Bajcsy-Zsilinszky út', suburb: 'Lipótváros', city: 'Budapest' } };
  let photonDown = false;
  const fetchImpl = async (url) => {
    calls.push(url);
    if (url.includes('photon') && photonDown) return { ok: false, status: 503, json: async () => ({}) };
    return { ok: true, status: 200, json: async () => (url.includes('photon') ? photon : nominatim) };
  };
  await withServer({}, fetchImpl, async (base) => {
    const r = await json(await fetch(`${base}/api/reverse?lat=47.502212&lon=19.058111`));
    assert.equal(r.status, 200);
    assert.deepEqual(r.body, { place: 'Andrássy út, Terézváros', label: 'Andrássy út', area: 'Terézváros' });
    assert.match(calls[0], /\/reverse\?lat=47\.5022&lon=19\.0581&limit=1$/, 'coordinates rounded to ~10 m before they leave');
    photonDown = true;
    const n = await json(await fetch(`${base}/api/reverse?lat=47.5&lon=19.05`));
    assert.equal(n.body.place, 'Bajcsy-Zsilinszky út, Lipótváros');
    assert.ok(calls.some((u) => u.includes('nominatim') && u.includes('format=jsonv2')));
    assert.equal((await fetch(`${base}/api/reverse?lat=95&lon=19`)).status, 400);
    assert.equal((await fetch(`${base}/api/reverse?lat=47.5`)).status, 400);
  });
  await withServer({ reverseGeocode: false }, async () => { throw new Error('must not be called'); }, async (base) => {
    const r = await json(await fetch(`${base}/api/reverse?lat=47.5&lon=19.05`));
    assert.equal(r.status, 404);
    assert.match(r.body.error, /turned off/);
  });
  assert.equal(S.normalizePhotonReverse({ features: [] }), null);
  assert.equal(S.normalizeNominatimReverse({ error: 'Unable to geocode' }), null);
  assert.equal(S.normalizePhotonReverse({ features: [{ properties: { city: 'Érd' } }] }).place, 'Érd');
});

test('loadNavConfig: reverse geocoding on by default, off via NAV_REVERSE_GEOCODE or the config file', () => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'rigs-nav-rev-'));
  const file = path.join(home, 'config.json');
  assert.equal(S.loadNavConfig({ env: { RIGS_HOME: home }, configFile: file }).cfg.reverseGeocode, true);
  assert.equal(S.loadNavConfig({ env: { RIGS_HOME: home, NAV_REVERSE_GEOCODE: '0' }, configFile: file }).cfg.reverseGeocode, false);
  fs.writeFileSync(file, JSON.stringify({ navigation: { reverseGeocode: false } }));
  assert.equal(S.loadNavConfig({ env: { RIGS_HOME: home }, configFile: file }).cfg.reverseGeocode, false);
  assert.equal(S.publicConfig(S.loadNavConfig({ env: { RIGS_HOME: home }, configFile: file }).cfg).reverseGeocode, undefined);
});

test('trips panel markup: every element the panel and app scripts address exists in index.html', () => {
  const html = fs.readFileSync(path.join(PUBLIC, 'index.html'), 'utf8');
  const ids = new Set([...html.matchAll(/\bid="([^"]+)"/g)].map((m) => m[1]));
  for (const file of ['tripsui.js', 'app.js']) {
    const src = fs.readFileSync(path.join(PUBLIC, file), 'utf8');
    // Ids made at runtime by the panel's own templates.
    const made = new Set([...src.matchAll(/\bid="([^"$]+)"/g)].map((m) => m[1]));
    for (const [, id] of src.matchAll(/\$\('([\w-]+)'\)/g)) assert.ok(ids.has(id) || made.has(id), `${file} uses #${id}, missing from index.html`);
  }
  for (const rate of [1, 4, 16, 64]) assert.ok(html.includes(`data-rate="${rate}"`), `replay speed ${rate}× button`);
  assert.match(html, /id="rec"[^>]*hidden/, 'REC indicator starts hidden');
  assert.match(html, /id="confirm"[^>]*role="alertdialog"/, 'delete goes through a confirm dialog');
});
