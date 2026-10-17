// Navigation trips: the stats engine on synthetic tracks (known distance and speed, spikes rejected,
// acceleration and braking steps, standing still), the browser recorder's filtering, chunking,
// offline outbox and pagehide beacon, and the api/trips round-trip against a scratch applet server on
// a temp NAV_DATA_DIR. No network.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { test } from 'node:test';

process.env.RIGS_HOME = fs.mkdtempSync(path.join(os.tmpdir(), 'rigs-trips-'));
const { tripStats, aggregateTrips, cleanFixes } = await import('../applets/navigation/public/tripstats.js');
const R = await import('../applets/navigation/public/trips.js');
const { createTripStore, normalizePoint } = await import('../applets/navigation/tripstore.js');
const S = await import('../applets/navigation/server.js');

const M_PER_DEG = 111195; // metres per degree of latitude (geo.js EARTH_RADIUS_M)
const within = (got, want, frac, msg) => assert.ok(Math.abs(got - want) <= Math.abs(want) * frac, `${msg}: expected ${want} ±${frac * 100}%, got ${got}`);

/**
 * A drive due north along lon 19 from lat 47, one fix per `dt` s; `accel(t)` gives m/s². Returns the
 * fixes and the exact distance. Options: no device speed (derived only), position noise, a per-fix edit.
 */
function drive(accel, seconds, { dt = 1, gps = true, noiseM = 0, t0 = 1_790_000_000_000, edit } = {}) {
  let seed = 7;
  const rnd = () => (seed = (seed * 16807) % 2147483647) / 2147483647;
  const gauss = () => Math.sqrt(-2 * Math.log(rnd())) * Math.cos(2 * Math.PI * rnd());
  const pts = [];
  let x = 0, v = 0;
  for (let i = 0; i * dt <= seconds; i++) {
    const t = i * dt;
    const p = { t: t0 + Math.round(t * 1000), lat: 47 + (x + noiseM * gauss()) / M_PER_DEG, lon: 19 + (noiseM * gauss()) / (M_PER_DEG * Math.cos((47 * Math.PI) / 180)), speed: gps ? v : null, heading: 0, accuracy: 5, alt: null };
    pts.push(edit ? edit(p, i) : p);
    const v2 = Math.max(0, v + accel(t) * dt);
    x += ((v + v2) / 2) * dt;
    v = v2;
  }
  return { pts, distance: x };
}

// Accelerate 0 → 25 m/s at 2.5 m/s² (10 s), cruise 60 s, brake at 4 m/s² to a stop (6.25 s), stand.
const STEP = (t) => (t < 10 ? 2.5 : t < 70 ? 0 : t < 76.25 ? -4 : 0);

test('tripstats: constant speed — distance, duration, average and max speed', () => {
  for (const gps of [true, false]) {
    const { pts } = drive(() => 0, 120, { gps, edit: (p, i) => ({ ...p, lat: 47 + (i * 15) / M_PER_DEG, speed: gps ? 15 : null }) });
    const s = tripStats(pts);
    within(s.distance, 1800, 0.02, `distance (gps=${gps})`);
    assert.equal(s.duration, 120);
    within(s.movingTime, 120, 0.02, 'moving time');
    within(s.avgSpeed, 15, 0.02, 'avg speed');
    within(s.maxSpeed, 15, 0.02, 'max speed');
    assert.ok(s.maxAccel < 0.2 && s.maxBrake < 0.2, 'no acceleration at constant speed');
    assert.equal(s.pointCount, 121);
  }
});

test('tripstats: acceleration and braking steps within 2%', () => {
  for (const [dt, gps] of [[1, true], [1, false], [0.2, true], [0.2, false]]) {
    const { pts, distance } = drive(STEP, 96, { dt, gps });
    const s = tripStats(pts);
    const tag = `dt=${dt} gps=${gps}`;
    within(s.distance, distance, 0.02, `distance ${tag}`);
    within(s.maxSpeed, 25, 0.02, `max speed ${tag}`);
    within(s.maxAccel, 2.5, 0.02, `max accel ${tag}`);
    // Derived speed is smoothed twice (positions, then speeds), which softens a 6 s brake a little.
    within(s.maxBrake, 4, gps ? 0.02 : 0.1, `max brake ${tag}`);
    // The standing at the end is not moving time, so the average is distance / ~76 s.
    within(s.movingTime, 76.25, 0.03, `moving time ${tag}`);
    within(s.avgSpeed, distance / 76.25, 0.03, `avg speed ${tag}`);
  }
});

test('tripstats: GPS speed spikes and position jumps are rejected', () => {
  const base = drive(STEP, 96).pts;
  const clean = tripStats(base);
  // A 400 km/h device-speed sample mid-cruise, a 200 km/h one next to it, and a fix 2 km sideways.
  const spiky = base.map((p, i) => (i === 40 ? { ...p, speed: 111 } : i === 41 ? { ...p, speed: 55 } : i === 55 ? { ...p, lon: p.lon + 0.03 } : p));
  const s = tripStats(spiky);
  within(s.maxSpeed, 25, 0.02, 'max speed ignores the spikes');
  within(s.distance, clean.distance, 0.02, 'distance ignores the teleported fix');
  within(s.maxAccel, 2.5, 0.02, 'no phantom acceleration from the spike');
  assert.equal(cleanFixes(spiky).length, base.length - 1, 'the teleported fix is dropped');
  // Noisy positions (2 m σ) with derived speed only: still close.
  const noisy = drive(STEP, 96, { gps: false, noiseM: 2 });
  const n = tripStats(noisy.pts);
  within(n.distance, noisy.distance, 0.03, 'distance under 2 m position noise');
  within(n.maxSpeed, 25, 0.06, 'max speed under 2 m position noise');
});

test('tripstats: standing still adds no distance; timeline, bbox and short inputs', () => {
  const parked = Array.from({ length: 120 }, (_, i) => ({ t: i * 1000, lat: 47 + (i % 3) * 0.000004, lon: 19, speed: 0, accuracy: 6 }));
  const p = tripStats(parked);
  assert.ok(p.distance < 1, `parked distance ${p.distance}`);
  assert.equal(p.movingTime, 0);
  assert.equal(p.avgSpeed, 0);

  const { pts } = drive(STEP, 96, { dt: 0.2 });
  const s = tripStats(pts);
  assert.ok(s.timeline.length <= 300 && s.timeline.length > 100, `timeline ${s.timeline.length}`);
  assert.ok(s.timeline.every((x, i, a) => i === 0 || (x.t >= a[i - 1].t && x.d >= a[i - 1].d)), 'timeline is monotonic');
  within(s.timeline[s.timeline.length - 1].d, s.distance, 0.001, 'timeline ends at the total distance');
  assert.ok(Math.max(...s.timeline.map((x) => x.v)) > 24);
  assert.deepEqual([s.bbox[0], s.bbox[1], s.bbox[2]], [19, 47, 19]);
  assert.equal(s.bbox[3], pts[pts.length - 1].lat);
  assert.deepEqual(s.start, { lat: 47, lon: 19 });
  assert.equal(tripStats(pts, { timeline: false }).timeline, undefined);

  assert.equal(tripStats([]).distance, 0);
  assert.equal(tripStats([{ t: 1, lat: 47, lon: 19 }]).pointCount, 1);
  assert.equal(tripStats(null).pointCount, 0);
});

test('aggregateTrips: totals, overall average, top speed and longest trip', () => {
  const t = aggregateTrips([
    { id: 'a', distance: 1000, duration: 120, movingTime: 100, maxSpeed: 20, maxAccel: 2, maxBrake: 3, startedAt: 10, endedAt: 130 },
    { id: 'b', distance: 5000, duration: 400, movingTime: 300, maxSpeed: 30, maxAccel: 1, maxBrake: 5, startedAt: 500, endedAt: 900 },
    null, { id: 'bad' },
  ]);
  assert.equal(t.trips, 2);
  assert.equal(t.distance, 6000);
  assert.equal(t.duration, 520);
  assert.equal(t.movingTime, 400);
  assert.equal(t.avgSpeed, 15, 'total distance / total moving time');
  assert.equal(t.maxSpeed, 30);
  assert.equal(t.maxSpeedTrip, 'b');
  assert.deepEqual(t.longest, { id: 'b', distance: 5000, duration: 400 });
  assert.equal(t.maxBrake, 5);
  assert.equal(t.firstAt, 10);
  assert.equal(t.lastAt, 900);
  assert.equal(aggregateTrips([]).avgSpeed, 0);
});

// ---- Browser recorder --------------------------------------------------------------------------

function memoryStorage() {
  const m = new Map();
  return { getItem: (k) => (m.has(k) ? m.get(k) : null), setItem: (k, v) => m.set(k, String(v)), removeItem: (k) => m.delete(k) };
}

/** Feed fixes at 1 Hz north at `speed` m/s (gps:false → no device speed), ticking every 5 s. */
function feed(rec, clock, { from = 0, seconds, speed, startLat = 47, accuracy = 5, gps = true }) {
  let lat = startLat;
  const out = [];
  for (let i = 0; i < seconds; i++) {
    clock.t = from + i * 1000;
    out.push(rec.addFix({ t: clock.t, lat, lon: 19, speed: gps ? speed : null, heading: 0, accuracy }));
    lat += speed / M_PER_DEG;
    if (i % 5 === 4) rec.tick();
  }
  return { out, lastLat: lat - speed / M_PER_DEG };
}

test('recorder: drops inaccurate fixes and jitter, starts above 5 km/h, chunks every ~15 s, ends after 5 min still', async () => {
  const clock = { t: 0 };
  const posted = [];
  const fetchImpl = async (url, init) => { posted.push({ url, body: JSON.parse(init.body) }); return { ok: true, status: 200 }; };
  const storage = memoryStorage();
  const rec = R.createTripRecorder({ fetchImpl, storage, now: () => clock.t, source: 'sim' });

  assert.equal(rec.addFix({ t: 0, lat: 47, lon: 19, speed: 10, accuracy: 80 }), 'dropped', 'accuracy > 50 m');
  assert.equal(rec.addFix({ t: 0, lat: NaN, lon: 19 }), 'dropped');
  assert.ok(feed(rec, clock, { from: 1000, seconds: 20, speed: 0.1 }).out.every((x) => x === 'idle'), 'no trip while parked');
  assert.ok(feed(rec, clock, { from: 21000, seconds: 5, speed: 4 / 3.6 }).out.every((x) => x === 'idle'), 'walking pace is no trip');
  assert.equal(rec.status().recording, false);

  // Drive at 36 km/h for 60 s: the trip starts on the first fix, with the seconds before as pre-roll.
  const d = feed(rec, clock, { from: 26000, seconds: 60, speed: 10 });
  assert.ok(d.out.every((x) => x === 'kept'));
  const st = rec.status();
  assert.equal(st.recording, true);
  assert.match(st.id, /^\d{8}-\d{6}-[0-9a-z]{4}$/);
  assert.ok(st.points > 60, 'pre-roll + 60 fixes');
  await rec.flush();
  assert.ok(posted.length >= 3, `chunks every ~15 s, got ${posted.length}`);
  assert.deepEqual(posted.map((p) => p.body.seq), posted.map((_, i) => i), 'seq numbers in order');
  assert.ok(posted.every((p) => p.url === `api/trips/${st.id}/points` && p.body.source === 'sim' && !p.body.final));
  assert.ok(posted.every((p) => p.body.points.every((x) => Object.keys(x).join() === 't,lat,lon,speed,heading,accuracy,alt')));

  // Stop: wobbling < 3 m at 0 km/h keeps nothing; 5 min later the trip ends with a final chunk.
  for (let i = 1; i <= 310; i++) {
    clock.t = 86000 + i * 1000;
    assert.notEqual(rec.addFix({ t: clock.t, lat: d.lastLat + (i % 2) * 0.00001, lon: 19, speed: 0, accuracy: 5 }), 'kept', 'jitter while stopped');
    if (i % 5 === 0) await rec.tick();
  }
  assert.equal(rec.status().recording, false, 'ended after 5 min stationary');
  const last = posted[posted.length - 1].body;
  assert.equal(last.final, true);
  assert.equal(last.reason, 'stopped');
  assert.equal(rec.status().outbox, 0);
  assert.equal(storage.getItem(R.CURRENT_KEY), null, 'no open trip remembered');
});

test('recorder and store keep the speed limit and camera distance the HUD showed, for the replay', async () => {
  const clock = { t: 0 };
  const posted = [];
  const rec = R.createTripRecorder({ fetchImpl: async (url, init) => { posted.push(JSON.parse(init.body)); return { ok: true, status: 200 }; }, now: () => clock.t });
  for (let i = 0; i < 20; i++) {
    clock.t = i * 1000;
    rec.addFix({ t: clock.t, lat: 47 + (i * 10) / M_PER_DEG, lon: 19, speed: 10, accuracy: 5, lim: 50, camD: i > 10 ? 412.6 : null, camLim: i > 10 ? 40 : undefined });
  }
  await rec.end();
  const pts = posted.flatMap((c) => c.points);
  assert.ok(pts.length >= 19);
  assert.deepEqual(Object.keys(pts[0]).join(), 't,lat,lon,speed,heading,accuracy,alt,lim', 'no camera fields while none was ahead');
  assert.deepEqual([pts.at(-1).lim, pts.at(-1).camD, pts.at(-1).camLim], [50, 413, 40]);
  const stored = normalizePoint({ t: 1, lat: 47, lon: 19, lim: 50, camD: 'near', camLim: 40 });
  assert.deepEqual([stored.lim, 'camD' in stored, stored.camLim], [50, false, 40], 'numbers kept, anything else dropped');
  assert.ok(!('lim' in normalizePoint({ t: 1, lat: 47, lon: 19 })), 'older points keep their shape');
});

test('recorder: derived speed (no coords.speed) starts a trip; GPS wobble does not', () => {
  const clock = { t: 0 };
  const rec = R.createTripRecorder({ fetchImpl: async () => ({ ok: true, status: 200 }), now: () => clock.t });
  // ±2 m wobble round one spot for 30 s: displacement over 5 s stays under 5 km/h.
  for (let i = 0; i < 30; i++) assert.notEqual(rec.addFix({ t: i * 1000, lat: 47 + ((i % 3) - 1) * 0.000018, lon: 19, speed: null, accuracy: 8 }), 'kept');
  assert.equal(rec.status().recording, false);
  const { out } = feed(rec, clock, { from: 30000, seconds: 15, speed: 8, gps: false });
  assert.ok(rec.status().recording, 'recording once the derived speed passes 5 km/h');
  assert.ok(out.includes('kept'));
});

test('recorder: chunks wait in the localStorage outbox while the server is down, then upload', async () => {
  const clock = { t: 0 };
  let up = false;
  const got = [];
  const fetchImpl = async (url, init) => {
    if (!up) throw new TypeError('Failed to fetch');
    got.push(JSON.parse(init.body));
    return { ok: true, status: 200 };
  };
  const storage = memoryStorage();
  const rec = R.createTripRecorder({ fetchImpl, storage, now: () => clock.t });
  feed(rec, clock, { from: 0, seconds: 50, speed: 12 });
  await rec.tick();
  const st = rec.status();
  assert.ok(st.outbox >= 3, `chunks queued: ${st.outbox}`);
  assert.match(st.lastError, /offline/);
  const saved = JSON.parse(storage.getItem(R.OUTBOX_KEY));
  assert.equal(saved.length, st.outbox, 'outbox persisted to localStorage');
  assert.equal(JSON.parse(storage.getItem(R.CURRENT_KEY)).id, st.id, 'open trip remembered');

  // A 5xx keeps them too.
  const rec5 = R.createTripRecorder({ fetchImpl: async () => ({ ok: false, status: 503 }), storage: memoryStorage() });
  feed(rec5, { t: 0 }, { from: 0, seconds: 20, speed: 12 });
  await rec5.tick();
  assert.ok(rec5.status().outbox >= 1);

  // Reload while offline: the new page finds the outbox, closes the dead page's trip, and uploads
  // everything once the server is back.
  const queued = saved.reduce((n, c) => n + c.points.length, 0);
  const again = R.createTripRecorder({ fetchImpl, storage, now: () => clock.t });
  assert.equal(again.status().outbox, saved.length + 1, 'plus a closing chunk for the abandoned trip');
  up = true;
  await again.flush();
  assert.equal(again.status().outbox, 0);
  assert.equal(JSON.parse(storage.getItem(R.OUTBOX_KEY)).length, 0);
  assert.equal(got.reduce((n, c) => n + c.points.length, 0), queued, 'every queued point arrived');
  assert.deepEqual(got.at(-1), { seq: saved.length, final: true, reason: 'closed', source: 'gps', points: [] });

  // A page killed mid-chunk (no pagehide): its unchunked fixes come back with the next visit.
  const crashStore = memoryStorage();
  const crashed = R.createTripRecorder({ fetchImpl: async () => { throw new Error('down'); }, storage: crashStore, now: () => clock.t });
  feed(crashed, clock, { from: 0, seconds: 8, speed: 12 });
  const crashedId = crashed.status().id;
  assert.equal(crashed.status().outbox, 0, 'nothing chunked yet');
  const sent = [];
  const next = R.createTripRecorder({ fetchImpl: async (u, init) => { sent.push({ u, b: JSON.parse(init.body) }); return { ok: true, status: 200 }; }, storage: crashStore, now: () => clock.t });
  await next.flush();
  assert.equal(sent.length, 1);
  assert.equal(sent[0].u, `api/trips/${crashedId}/points`);
  assert.equal(sent[0].b.final, true);
  assert.equal(sent[0].b.points.length, 8, 'the 8 unchunked fixes survived the crash');

  // A 4xx (410: the trip was deleted) is dropped instead of retried forever.
  const rec4 = R.createTripRecorder({ fetchImpl: async () => ({ ok: false, status: 410 }), storage: memoryStorage() });
  feed(rec4, { t: 0 }, { from: 0, seconds: 20, speed: 12 });
  await rec4.tick();
  assert.equal(rec4.status().outbox, 0);
  assert.match(rec4.status().lastError, /410/);
});

test('recorder: pagehide closes the trip and beacons the outbox, including the last chunk', () => {
  const clock = { t: 0 };
  const beacons = [];
  const storage = memoryStorage();
  const down = async () => { throw new Error('down'); };
  const rec = R.createTripRecorder({ fetchImpl: down, storage, now: () => clock.t, beacon: (url, b) => { beacons.push({ url, body: JSON.parse(b) }); return true; } });
  feed(rec, clock, { from: 0, seconds: 8, speed: 12 }); // under one chunk interval: all still pending
  const id = rec.status().id;
  assert.ok(rec.status().pending > 0);

  assert.equal(rec.pageHide(), 1, 'tab hidden: the pending fixes go out as a chunk');
  assert.equal(beacons[0].url, `api/trips/${id}/points`);
  assert.equal(beacons[0].body.final, false);
  assert.ok(rec.status().recording, 'hidden is not closed');

  feed(rec, clock, { from: 9000, seconds: 3, speed: 12, startLat: 47.001 });
  beacons.length = 0;
  assert.equal(rec.pageHide({ final: true }), 2);
  assert.deepEqual(beacons.map((b) => b.body.final), [false, true]);
  assert.equal(beacons[1].body.reason, 'closed');
  assert.equal(beacons[1].body.points.length, 3, 'the last fixes ride on the final chunk');
  assert.equal(rec.status().recording, false);
  assert.equal(JSON.parse(storage.getItem(R.OUTBOX_KEY)).length, 2, 'kept for resend; the server ignores repeats');

  // A big offline outbox beacons only what fits in 64 KB.
  const big = R.createTripRecorder({ storage: memoryStorage(), beacon: (u, b) => { assert.ok(b.length < 64000); return true; }, now: () => clock.t, fetchImpl: down });
  feed(big, clock, { from: 0, seconds: 1500, speed: 12 });
  const sent = big.pageHide();
  assert.ok(sent > 0 && sent < big.status().outbox, `${sent} of ${big.status().outbox}`);
});

// ---- Server ------------------------------------------------------------------------------------

async function withTripServer(fn) {
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'rigs-trips-data-'));
  const { cfg } = S.loadNavConfig({ env: { RIGS_HOME: process.env.RIGS_HOME, NAV_DATA_DIR: dataDir }, configFile: path.join(process.env.RIGS_HOME, 'missing.json') });
  assert.equal(cfg.dataDir, dataDir);
  const server = S.createNavServer({ cfg, fetchImpl: async () => { throw new Error('no network in tests'); } });
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  const base = `http://127.0.0.1:${server.address().port}`;
  try { await fn(base, dataDir); } finally { await new Promise((r) => server.close(r)); }
}

const json = async (r) => ({ status: r.status, body: await r.json() });
const post = (url, body, type = 'application/json') => fetch(url, { method: 'POST', headers: { 'content-type': type }, body: typeof body === 'string' ? body : JSON.stringify(body) });

test('loadNavConfig: trips data dir from NAV_DATA_DIR, the config file, or ~/.rigs/navigation/trips', () => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'rigs-nav-cfg-'));
  const file = path.join(home, 'config.json');
  assert.equal(S.loadNavConfig({ env: { RIGS_HOME: home }, configFile: file }).cfg.dataDir, path.join(home, 'navigation', 'trips'));
  fs.writeFileSync(file, JSON.stringify({ navigation: { dataDir: path.join(home, 'elsewhere') } }));
  assert.equal(S.loadNavConfig({ env: { RIGS_HOME: home }, configFile: file }).cfg.dataDir, path.join(home, 'elsewhere'));
  assert.equal(S.loadNavConfig({ env: { RIGS_HOME: home, NAV_DATA_DIR: path.join(home, 'env') }, configFile: file }).cfg.dataDir, path.join(home, 'env'));
  assert.equal(S.publicConfig(S.loadNavConfig({ env: { RIGS_HOME: home }, configFile: file }).cfg).dataDir, undefined, 'the data path never reaches the browser');
});

test('api/trips: upload chunks, list, detail with stats, totals, rename, delete to trash', async () => {
  await withTripServer(async (base, dataDir) => {
    assert.deepEqual((await json(await fetch(base + '/api/trips'))).body, { trips: [] }, 'empty before the first trip');

    const { pts, distance } = drive(STEP, 96);
    const id = '20261017-120000-abcd';
    const chunks = [pts.slice(0, 30), pts.slice(30, 60), pts.slice(60)];
    for (const [i, c] of chunks.entries()) {
      const r = await json(await post(`${base}/api/trips/${id}/points`, { seq: i, points: c, final: i === 2, source: 'sim' }));
      assert.equal(r.status, 200);
      assert.equal(r.body.added, c.length);
    }
    // A resent chunk (lost reply) sent the way a beacon sends it (text/plain): nothing is duplicated.
    const dup = await json(await post(`${base}/api/trips/${id}/points`, JSON.stringify({ seq: 1, points: chunks[1] }), 'text/plain;charset=UTF-8'));
    assert.equal(dup.body.added, 0);
    assert.equal(dup.body.pointCount, pts.length);

    const file = JSON.parse(fs.readFileSync(path.join(dataDir, id + '.json'), 'utf8'));
    assert.equal(file.status, 'done');
    assert.equal(file.points.length, pts.length);
    assert.equal(file.source, 'sim');
    within(file.summary.distance, distance, 0.02, 'summary cached in the trip file');
    assert.deepEqual(fs.readdirSync(dataDir).filter((f) => f.endsWith('.tmp')), [], 'no temp files left behind');

    const list = (await json(await fetch(base + '/api/trips'))).body.trips;
    assert.equal(list.length, 1);
    assert.equal(list[0].id, id);
    within(list[0].maxSpeed, 25, 0.02, 'listed max speed');
    assert.equal(list[0].points, undefined, 'the list carries summaries, not points');

    const detail = await json(await fetch(`${base}/api/trips/${id}`));
    assert.equal(detail.status, 200);
    assert.equal(detail.body.points.length, pts.length);
    within(detail.body.stats.maxAccel, 2.5, 0.02, 'detail max accel');
    within(detail.body.stats.maxBrake, 4, 0.02, 'detail max brake');
    assert.ok(detail.body.stats.timeline.length > 10);
    assert.equal(detail.body.seqs, undefined);

    // A second trip, still recording, whose chunks arrive out of order.
    const id2 = '20261017-130000-efgh';
    const second = drive(() => 0, 60, { t0: 1_790_000_500_000, edit: (p, i) => ({ ...p, lat: 47 + (i * 10) / M_PER_DEG, speed: 10 }) }).pts;
    await post(`${base}/api/trips/${id2}/points`, { seq: 1, points: second.slice(30) });
    await post(`${base}/api/trips/${id2}/points`, { seq: 0, points: second.slice(0, 30) });
    const d2 = (await json(await fetch(`${base}/api/trips/${id2}`))).body;
    assert.equal(d2.status, 'recording');
    assert.ok(d2.points.every((p, i, a) => i === 0 || p.t > a[i - 1].t), 'points merged in time order');
    within(d2.stats.distance, 600, 0.02, 'second trip distance');

    assert.deepEqual((await json(await fetch(base + '/api/trips'))).body.trips.map((t) => t.id), [id2, id], 'newest first');
    const sum = (await json(await fetch(base + '/api/trips/summary'))).body;
    assert.equal(sum.trips, 2);
    within(sum.distance, distance + 600, 0.02, 'total distance');
    within(sum.maxSpeed, 25, 0.02, 'top speed');
    assert.equal(sum.maxSpeedTrip, id);
    assert.equal(sum.longest.id, id);
    assert.equal((await json(await fetch(`${base}/api/trips/summary?since=${1_790_000_400_000}`))).body.trips, 1, 'since filter');
    assert.equal((await json(await fetch(`${base}/api/trips?until=${new Date(1_790_000_400_000).toISOString()}`))).body.trips.length, 1, 'until filter (ISO)');
    assert.equal((await fetch(`${base}/api/trips?since=yesterday`)).status, 400);

    const named = await json(await fetch(`${base}/api/trips/${id}`, { method: 'PATCH', body: JSON.stringify({ title: 'Andrássy loop', places: { start: 'Deák tér', end: 'Városliget' } }) }));
    assert.equal(named.body.title, 'Andrássy loop');
    assert.equal((await json(await fetch(base + '/api/trips'))).body.trips.find((t) => t.id === id).places.end, 'Városliget');

    // Delete moves the file to trash/, and a late chunk for it is refused (410) so the client drops it.
    assert.deepEqual((await json(await fetch(`${base}/api/trips/${id}`, { method: 'DELETE' }))).body, { ok: true, trashed: id });
    assert.equal(fs.existsSync(path.join(dataDir, id + '.json')), false);
    assert.equal(JSON.parse(fs.readFileSync(path.join(dataDir, 'trash', id + '.json'), 'utf8')).points.length, pts.length, 'the whole trip is kept in trash');
    assert.equal((await fetch(`${base}/api/trips/${id}`)).status, 404);
    assert.equal((await post(`${base}/api/trips/${id}/points`, { seq: 9, points: pts.slice(0, 2) })).status, 410);
    assert.deepEqual((await json(await fetch(base + '/api/trips'))).body.trips.map((t) => t.id), [id2]);
    assert.equal((await fetch(`${base}/api/trips/${id}`, { method: 'DELETE' })).status, 404);

    // Validation.
    assert.equal((await post(`${base}/api/trips/bad id!/points`, { points: [] })).status, 400);
    assert.equal((await post(`${base}/api/trips/${id2}/points`, '{not json')).status, 400);
    assert.equal((await post(`${base}/api/trips/${id2}/points`, { points: 'nope' })).status, 400);
    assert.equal((await fetch(`${base}/api/trips/${id2}/points`)).status, 405);
    assert.equal((await fetch(`${base}/api/trips`, { method: 'POST', body: '{}' })).status, 405);

    // The existing routes are untouched.
    assert.deepEqual((await json(await fetch(base + '/healthz'))).body, { ok: true });
    assert.equal((await fetch(base + '/healthz', { method: 'POST' })).status, 405);
    assert.equal((await fetch(base + '/config.json', { method: 'DELETE' })).status, 405);
    assert.equal((await fetch(base + '/api/route?from=1,2')).status, 400);
    assert.equal((await fetch(base + '/trips.js')).status, 200);
    assert.equal((await fetch(base + '/tripstats.js')).status, 200);
  });
});

test('tripstore: a trip whose page died is finalised once stale; concurrent writes are serialised', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'rigs-trips-store-'));
  let t = 1_000_000;
  const store = createTripStore({ dir, now: () => t, staleMs: 60_000 });
  const { pts } = drive(() => 0, 40, { edit: (p, i) => ({ ...p, lat: 47 + (i * 12) / M_PER_DEG, speed: 12 }) });
  await Promise.all(Array.from({ length: 10 }, (_, i) => store.append('trip-concurrent', { seq: i, points: pts.slice(i * 4, i * 4 + 4) })));
  assert.equal((await store.get('trip-concurrent')).points.length, 40, 'ten concurrent chunks, none lost');
  assert.equal((await store.list())[0].status, 'recording');
  // Staleness goes by the file's mtime (server time), so age the file.
  const old = new Date(Date.now() - 120_000);
  fs.utimesSync(path.join(dir, 'trip-concurrent.json'), old, old);
  t = Date.now();
  const [s] = await store.list();
  assert.equal(s.status, 'done');
  assert.equal(s.endReason, 'timeout');
  within(s.distance, 468, 0.02, 'finalised summary');
  await store.append('trip-empty', { seq: 0, points: [] });
  assert.equal(await store.get('trip-empty'), null, 'an empty chunk does not create a trip');
});

test('recorder ↔ server: a recorded 5 Hz drive lands as one trip with plausible stats', async () => {
  await withTripServer(async (base) => {
    const clock = { t: 1_790_000_000_000 };
    const rec = R.createTripRecorder({ base: base + '/api/trips', storage: memoryStorage(), now: () => clock.t, source: 'sim' });
    const { pts, distance } = drive(STEP, 90, { dt: 0.2, t0: clock.t });
    for (const [i, p] of pts.entries()) {
      clock.t = p.t;
      rec.addFix(p);
      if (i % 25 === 0) await rec.tick();
    }
    await rec.end('stopped');
    assert.equal(rec.status().outbox, 0);
    const [trip] = (await json(await fetch(base + '/api/trips'))).body.trips;
    assert.equal(trip.status, 'done');
    assert.equal(trip.endReason, 'stopped');
    assert.equal(trip.source, 'sim');
    within(trip.distance, distance, 0.02, 'distance through the recorder');
    within(trip.maxSpeed, 25, 0.02, 'max speed through the recorder');
    within(trip.maxAccel, 2.5, 0.05, 'max accel through the recorder');
    within(trip.maxBrake, 4, 0.05, 'max brake through the recorder');
    assert.ok(trip.pointCount >= 70 && trip.pointCount <= 95, `~1 Hz kept, standing dropped: ${trip.pointCount}`);
  });
});
