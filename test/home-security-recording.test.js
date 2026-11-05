// Home Security t3: motion detection, pre-roll event recording, timeline index, retention, settings.
// No ffmpeg needed: frames are synthetic gray buffers, segments are small fake files.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { after, test } from 'node:test';

const M = await import('../apps/home-security/motion.js');
const S = await import('../apps/home-security/store.js');
const R = await import('../apps/home-security/retention.js');
const Rec = await import('../apps/home-security/recorder.js');
const { segmentRelPath } = await import('../apps/home-security/ingest.js');

const dirs = [];
const tmp = () => { const d = fs.mkdtempSync(path.join(os.tmpdir(), 'hs-rec-')); dirs.push(d); return d; };
after(() => { for (const d of dirs) fs.rmSync(d, { recursive: true, force: true }); });

const DAY = 86_400_000;
const GB = 1024 ** 3;

// ── motion: thresholds, zones, detector ──────────────────────────────────────────────────────────────────────────

test('thresholds follow sensitivity: 50 → 40 / 0.027, more sensitive = lower, input clamped', () => {
  assert.equal(M.pixelThreshold(50), 40);
  assert.ok(Math.abs(M.areaThreshold(50) - 0.027) < 1e-9);
  assert.ok(M.pixelThreshold(90) < M.pixelThreshold(10));
  assert.ok(M.areaThreshold(90) < M.areaThreshold(10));
  assert.equal(M.pixelThreshold(1000), M.pixelThreshold(100));
  assert.equal(M.pixelThreshold(-5), M.pixelThreshold(1));
  assert.equal(M.pixelThreshold('junk'), 40);
});

const SQUARE = (mode, x0, y0, x1, y1, name) => ({ mode, name, points: [[x0, y0], [x1, y0], [x1, y1], [x0, y1]] });

test('rasterizeZones: no zones = whole frame; include limits; exclude always removes; invalid zones ignored', () => {
  assert.equal(M.rasterizeZones([], 10, 10).count, 100);
  assert.equal(M.rasterizeZones(undefined, 10, 10).count, 100);
  assert.equal(M.rasterizeZones([SQUARE('include', 0, 0, 0.5, 1)], 10, 10).count, 50);
  assert.equal(M.rasterizeZones([SQUARE('exclude', 0, 0, 0.5, 1)], 10, 10).count, 50);
  assert.equal(M.rasterizeZones([SQUARE('include', 0, 0, 1, 1), SQUARE('exclude', 0, 0, 0.5, 0.5)], 10, 10).count, 75);
  assert.equal(M.rasterizeZones([{ mode: 'include', points: [[0, 0], [1, 1]] }, { points: 'x' }, null], 10, 10).count, 100);
  const r = M.rasterizeZones([SQUARE('include', 0, 0, 0.5, 1, 'left')], 10, 10);
  assert.equal(r.mask[0], 1);
  assert.equal(r.mask[9], 0);
});

const W = 20; const H = 10;
const frame = (v = 100, patch) => { const f = new Uint8Array(W * H).fill(v); if (patch) patch(f); return f; };
const block = (x0, x1, v = 255) => (f) => { for (let y = 0; y < H; y++) for (let x = x0; x < x1; x++) f[y * W + x] = v; };

test('detector: warm-up never reports motion; then a changed block does; a static scene does not', () => {
  const d = M.createDetector({ width: W, height: H });
  const w = d.feed(frame(), 0);
  assert.equal(w.warming, true);
  assert.equal(d.feed(frame(100, block(0, 8)), 1000).motion, false); // still warming
  const q = d.feed(frame(), 2500);
  assert.equal(q.warming, false);
  assert.equal(q.motion, false);
  const m = d.feed(frame(100, block(0, 8)), 3000);
  assert.equal(m.motion, true);
  assert.ok(m.score > 0.3 && m.score < 0.5, `score ${m.score}`);
});

test('detector: a tiny change below the area threshold is not motion; sensitivity changes that', () => {
  const tiny = frame(100, (f) => { f[0] = 255; f[1] = 255; }); // 2 / 200 = 1 %
  const lo = M.createDetector({ width: W, height: H, sensitivity: 10, warmupMs: 0 });
  lo.feed(frame(), 0);
  assert.equal(lo.feed(tiny, 100).motion, false);
  const hi = M.createDetector({ width: W, height: H, sensitivity: 95, warmupMs: 0 });
  hi.feed(frame(), 0);
  assert.equal(hi.feed(tiny, 100).motion, true);
});

test('detector: noise below the pixel threshold is ignored', () => {
  const d = M.createDetector({ width: W, height: H, warmupMs: 0 });
  d.feed(frame(100), 0);
  assert.equal(d.feed(frame(100, (f) => f.fill(130)), 100).motion, false); // +30 < 40
});

test('detector: exclude zone hides motion, include zone reports its name', () => {
  const ex = M.createDetector({ width: W, height: H, warmupMs: 0, zones: [SQUARE('exclude', 0, 0, 0.5, 1)] });
  ex.feed(frame(), 0);
  assert.equal(ex.feed(frame(100, block(0, 10)), 100).motion, false);
  const ex2 = M.createDetector({ width: W, height: H, warmupMs: 0, zones: [SQUARE('exclude', 0, 0, 0.5, 1)] });
  ex2.feed(frame(), 0);
  assert.equal(ex2.feed(frame(100, block(10, 16)), 100).motion, true); // (a change over the whole unmasked area would be 'lighting')

  const inc = M.createDetector({ width: W, height: H, warmupMs: 0, zones: [SQUARE('include', 0, 0, 0.5, 1, 'porch'), SQUARE('include', 0.5, 0, 1, 1, 'drive')] });
  inc.feed(frame(), 0);
  const r = inc.feed(frame(100, block(0, 10)), 100);
  assert.equal(r.motion, true);
  assert.deepEqual(r.zones, ['porch']);
});

test('detector: a whole-frame lighting change re-seeds the background instead of firing', () => {
  const d = M.createDetector({ width: W, height: H, warmupMs: 0 });
  d.feed(frame(50), 0);
  const l = d.feed(frame(200), 100);
  assert.equal(l.lighting, true);
  assert.equal(l.motion, false);
  const after_ = d.feed(frame(200), 200);
  assert.equal(after_.motion, false);
  assert.equal(after_.score, 0);
});

test('detector: short or missing frame is ignored; reset forgets the background; configure swaps zones', () => {
  const d = M.createDetector({ width: W, height: H, warmupMs: 0 });
  assert.equal(d.feed(new Uint8Array(3), 0).motion, false);
  assert.equal(d.feed(null, 0).warming, true);
  d.feed(frame(), 0);
  d.reset();
  assert.equal(d.feed(frame(100, block(0, 10)), 50).motion, false); // re-seeded with this frame
  d.configure({ zones: [SQUARE('exclude', 0, 0, 1, 1)] });
  assert.equal(d.feed(frame(100, block(0, 10, 0)), 100).motion, false); // everything excluded
  assert.throws(() => M.createDetector({ width: 0, height: 5 }), /width and height/);
});

// ── event state machine ──────────────────────────────────────────────────────────────────────────────────────────

const M1 = { motion: true, score: 0.3 };
const M0 = { motion: false, score: 0 };

test('event machine: motion shorter than minDuration opens nothing', () => {
  const sm = M.createEventMachine({ minDurationMs: 500, postRollMs: 3000 });
  assert.deepEqual(sm.step(0, M1), []);
  assert.deepEqual(sm.step(200, M1), []);
  assert.deepEqual(sm.step(300, M0), []);
  assert.equal(sm.state, 'idle');
  assert.deepEqual(sm.step(1000, M1), []); // candidate restarts, does not inherit the old run
});

test('event machine: opens at the first over-threshold frame, closes after postRoll of quiet at the last motion time', () => {
  const sm = M.createEventMachine({ minDurationMs: 500, postRollMs: 3000 });
  sm.step(1000, M1); sm.step(1200, M1); sm.step(1400, M1);
  const open = sm.step(1500, M1);
  assert.deepEqual(open, [{ type: 'open', startMs: 1000, peak: 0.3, peakAt: 1500 }]);
  assert.equal(sm.state, 'active');
  assert.equal(sm.step(1700, { motion: true, score: 0.5 })[0].type, 'peak');
  assert.deepEqual(sm.step(1900, { motion: true, score: 0.4 }), []); // not a new peak
  assert.deepEqual(sm.step(3000, M0), []);
  assert.deepEqual(sm.step(4800, M0), []); // 2900 quiet
  const [close] = sm.step(4900, M0);
  assert.equal(close.type, 'close');
  assert.equal(close.startMs, 1000);
  assert.equal(close.endMs, 1900);
  assert.equal(close.peak, 0.5);
  assert.equal(close.reason, 'quiet');
  assert.equal(close.frames, 3); // counted from the opening frame
  assert.equal(sm.state, 'idle');
});

test('event machine: motion inside the post-roll keeps the event going', () => {
  const sm = M.createEventMachine({ minDurationMs: 0, postRollMs: 3000 });
  sm.step(0, M1);
  sm.step(2000, M0);
  sm.step(2900, M1);
  assert.deepEqual(sm.step(5000, M0), []);
  assert.equal(sm.step(5900, M0)[0].endMs, 2900);
});

test('event machine: maxEvent splits a long event into consecutive ones; flush closes the active one', () => {
  const sm = M.createEventMachine({ minDurationMs: 0, postRollMs: 5000, maxEventMs: 2000 });
  sm.step(0, M1);
  const acts = sm.step(2000, M1);
  assert.deepEqual(acts.map((a) => a.type), ['close', 'open']);
  assert.equal(acts[0].reason, 'max');
  assert.equal(acts[0].endMs, 2000);
  assert.equal(acts[1].startMs, 2000);
  assert.equal(sm.state, 'active');
  const [f] = sm.flush();
  assert.equal(f.reason, 'flush');
  assert.deepEqual(sm.flush(), []);
});

test('event machine: zones accumulate; configure ignores non-numbers', () => {
  const sm = M.createEventMachine({ minDurationMs: 0, postRollMs: 100 });
  sm.step(0, { motion: true, score: 0.1, zones: ['a'] });
  sm.step(10, { motion: true, score: 0.1, zones: ['b'] });
  sm.configure({ postRollMs: 'x', maxEventMs: undefined });
  assert.deepEqual(sm.step(200, M0)[0].zones, ['a', 'b']);
});

// ── window math ──────────────────────────────────────────────────────────────────────────────────────────────────

test('clipWindow adds pre/post-roll; an active event is open-ended', () => {
  assert.deepEqual(M.clipWindow({ startMs: 100_000, endMs: 110_000 }, 4, 3), { from: 96_000, to: 113_000 });
  assert.deepEqual(M.clipWindow({ startMs: 100_000, endMs: null }, 10, 10), { from: 90_000, to: null });
  assert.deepEqual(M.clipWindow({ startMs: 100_000, endMs: 100_000 }, 0.5, 0.25), { from: 99_500, to: 100_250 });
});

test('overlaps / segmentsForWindow use half-open intervals', () => {
  const segs = [0, 2000, 4000, 6000, 8000].map((startMs) => ({ startMs, durMs: 2000 }));
  assert.deepEqual(M.segmentsForWindow(segs, { from: 3000, to: 6000 }).map((s) => s.startMs), [2000, 4000]);
  assert.deepEqual(M.segmentsForWindow(segs, { from: 4000, to: 6000 }).map((s) => s.startMs), [4000]); // touching ≠ overlapping
  assert.deepEqual(M.segmentsForWindow(segs, { from: 7000, to: null }).map((s) => s.startMs), [6000, 8000]);
  assert.deepEqual(M.segmentsForWindow(segs, { from: 20000, to: 30000 }), []);
});

// ── timeline helpers ─────────────────────────────────────────────────────────────────────────────────────────────

test('mergeSpans joins contiguous segments, splits at gaps over half a segment, clamps to the range', () => {
  const segs = [0, 2000, 4000, 10000, 12000].map((startMs) => ({ startMs, durMs: 2000 }));
  assert.deepEqual(Rec.mergeSpans(segs), [{ from: 0, to: 6000 }, { from: 10000, to: 14000 }]);
  assert.deepEqual(Rec.mergeSpans(segs, 1000, 11000), [{ from: 1000, to: 6000 }, { from: 10000, to: 11000 }]);
  assert.deepEqual(Rec.mergeSpans([]), []);
  assert.deepEqual(Rec.mergeSpans(segs, 50000, 60000), []);
});

test('vodPlaylist: ENDLIST, program date time per segment, discontinuity between segments (timestamps reset)', () => {
  const pl = Rec.vodPlaylist([{ startMs: 0, durMs: 2000 }, { startMs: 2000, durMs: 2000 }, { startMs: 9000, durMs: 2500 }], (s) => `seg/${s.startMs}.ts`);
  assert.ok(pl.startsWith('#EXTM3U'));
  assert.ok(pl.includes('#EXT-X-PLAYLIST-TYPE:VOD'));
  assert.ok(pl.includes('#EXT-X-TARGETDURATION:3'));
  assert.equal(pl.match(/#EXT-X-DISCONTINUITY\n/g).length, 2);
  assert.equal(pl.match(/#EXT-X-PROGRAM-DATE-TIME/g).length, 3);
  assert.ok(pl.includes('seg/9000.ts'));
  assert.ok(pl.trimEnd().endsWith('#EXT-X-ENDLIST'));
});

// ── store: settings ──────────────────────────────────────────────────────────────────────────────────────────────

test('default settings are valid and frozen; normalizeSettings fills gaps without mutating defaults', () => {
  assert.deepEqual(S.validateSettings(structuredClone(S.DEFAULT_SETTINGS)), []);
  assert.ok(Object.isFrozen(S.DEFAULT_SETTINGS));
  const n = S.normalizeSettings({ retention: { maxGB: 5 } });
  assert.equal(n.retention.maxGB, 5);
  assert.equal(n.retention.maxDays, 14);
  assert.equal(S.DEFAULT_SETTINGS.retention.maxGB, 50);
  assert.deepEqual(S.normalizeSettings('junk'), S.normalizeSettings({}));
});

test('normalizeSettings clamps ringSeconds to preRoll + 2 segments', () => {
  const n = S.normalizeSettings({ recording: { preRollSeconds: 30, segmentSeconds: 4, ringSeconds: 10 } });
  assert.equal(n.recording.ringSeconds, 38);
});

test('deepMerge merges objects, replaces arrays, ignores prototype pollution keys', () => {
  const out = S.deepMerge({ a: { b: 1, c: [1, 2] }, d: 1 }, JSON.parse('{"a":{"c":[9]},"__proto__":{"x":1},"constructor":{"y":1}}'));
  assert.deepEqual(out, { a: { b: 1, c: [9] }, d: 1 });
  assert.equal({}.x, undefined);
});

test('validateSettings reports each bad field in words', () => {
  const bad = structuredClone(S.DEFAULT_SETTINGS);
  bad.recording.defaultMode = 'always';
  bad.recording.segmentSeconds = 0;
  bad.motion.sensitivity = 101;
  bad.motion.width = 100.5;
  bad.retention.maxGB = 0;
  bad.retention.maxDays = 20; bad.retention.eventMaxDays = 10;
  bad.discovery.extraCidrs = ['8.8.8.0/24', '10.0.0.0/8', 'x'];
  bad.discovery.ports = [0];
  bad.live.hlsWindowSegments = 1;
  bad.ffmpeg.hwaccel = 'gpu';
  const e = S.validateSettings(bad).join('\n');
  for (const frag of ['recording.defaultMode', 'recording.segmentSeconds', 'motion.sensitivity', 'motion.width', 'retention.maxGB',
    'eventMaxDays must be ≥', 'RFC1918', '/22 or narrower', 'not an IPv4 CIDR', 'discovery.ports', 'live.hlsWindowSegments', 'ffmpeg.hwaccel']) {
    assert.ok(e.includes(frag), `missing: ${frag}\n${e}`);
  }
  assert.ok(S.validateSettings({}).length > 0);
  assert.ok(S.validateSettings(null).length > 0);
});

test('store settings: PATCH deep-merges, validates, persists atomically; bad patch changes nothing', async () => {
  const dir = tmp();
  const store = await S.openStore(dir);
  assert.equal(store.getSettings().retention.maxGB, 50);
  const ok = store.patchSettings({ retention: { maxGB: 10 }, version: 99 });
  assert.equal(ok.ok, true);
  assert.equal(ok.settings.retention.maxDays, 14);
  assert.equal(ok.settings.version, 1);
  assert.equal(ok.previous.retention.maxGB, 50);
  assert.equal(JSON.parse(fs.readFileSync(path.join(dir, 'settings.json'), 'utf8')).retention.maxGB, 10);
  assert.ok(!fs.readdirSync(dir).some((f) => f.endsWith('.tmp')));

  const bad = store.patchSettings({ retention: { maxGB: -1 }, motion: { sensitivity: 500 } });
  assert.equal(bad.ok, false);
  assert.ok(bad.errors.length >= 2);
  assert.equal(store.getSettings().retention.maxGB, 10);
  assert.equal(store.patchSettings([]).ok, false);
  assert.equal(store.patchSettings(null).ok, false);
  store.close();

  const again = await S.openStore(dir); // survives a restart
  assert.equal(again.getSettings().retention.maxGB, 10);
  again.close();
});

test('loadSettings: a corrupt or invalid settings.json falls back to defaults instead of crashing', () => {
  const dir = tmp();
  fs.writeFileSync(path.join(dir, 'settings.json'), '{not json');
  assert.deepEqual(S.loadSettings(dir), S.normalizeSettings({}));
  fs.writeFileSync(path.join(dir, 'settings.json'), JSON.stringify({ retention: { maxGB: -5 } }));
  assert.equal(S.loadSettings(dir).retention.maxGB, 50);
});

test('cameras/secrets files: atomic, secrets are 0600, bad content reads as empty', () => {
  const dir = tmp();
  assert.deepEqual(S.loadCameras(dir), []);
  assert.deepEqual(S.loadSecrets(dir), {});
  S.saveCameras(dir, [{ id: 'a' }]);
  S.saveSecrets(dir, { a: { username: 'u', password: 'p' } });
  assert.deepEqual(S.loadCameras(dir), [{ id: 'a' }]);
  assert.equal(S.loadSecrets(dir).a.password, 'p');
  if (process.platform !== 'win32') assert.equal(fs.statSync(path.join(dir, 'secrets.json')).mode & 0o777, 0o600);
  fs.writeFileSync(path.join(dir, 'cameras.json'), '{"not":"a list"}');
  fs.writeFileSync(path.join(dir, 'secrets.json'), '[1]');
  assert.deepEqual(S.loadCameras(dir), []);
  assert.deepEqual(S.loadSecrets(dir), {});
});

// ── store: index ─────────────────────────────────────────────────────────────────────────────────────────────────

test('store index: segments dedupe, range queries overlap, segmentAt / nextSegment, usage', async () => {
  const store = await S.openStore(tmp());
  const T = 1_800_000_000_000;
  for (let i = 0; i < 5; i++) assert.ok(store.addSegment({ camera: 'a', startMs: T + i * 2000, durMs: 2000, path: `segments/a/${i}.ts`, bytes: 100 }));
  assert.equal(store.addSegment({ camera: 'a', startMs: T, durMs: 2000, path: 'dup.ts', bytes: 1 }), null);
  store.addSegment({ camera: 'b', startMs: T + 1000, durMs: 2000, path: 'segments/b/0.ts', bytes: 50 });

  assert.deepEqual(store.segments('a', T + 3000, T + 6000).map((s) => s.startMs), [T + 2000, T + 4000]);
  assert.equal(store.segments('a', T + 4000, T + 4001).length, 1);
  assert.equal(store.segments(null, T, T + 10000).length, 6);
  assert.equal(store.segmentAt('a', T + 5000).startMs, T + 4000);
  assert.equal(store.segmentAt('a', T + 10_000), null); // after the last segment's end
  assert.equal(store.segmentAt('a', T - 10), null);
  assert.equal(store.nextSegment('a', T + 100).startMs, T + 2000);
  assert.equal(store.nextSegment('a', T + 99_999), null);
  assert.deepEqual(store.lastSegments('a', 2).map((s) => s.startMs), [T + 6000, T + 8000]);
  assert.deepEqual(store.segmentCameras().sort(), ['a', 'b']);
  assert.deepEqual(store.segmentUsage().a, { bytes: 500, count: 5, oldestMs: T });
  assert.equal(store.segmentsBefore('a', T + 4000).length, 2);
  store.deleteSegment(store.segmentByStart('a', T).id);
  assert.equal(store.segmentByStart('a', T), null);
  store.close();
});

test('store index: events CRUD, filters, newest first, cursor, patch fields', async () => {
  const store = await S.openStore(tmp());
  const mk = (id, camera, startMs, endMs) => store.insertEvent({ id, camera, startMs, endMs, clipFromMs: startMs - 1000, clipToMs: endMs === null ? null : endMs + 1000, peak: 0.2, frames: 3, zones: ['z'], createdMs: 1 });
  mk('e1', 'a', 1000, 2000); mk('e2', 'b', 5000, 6000); mk('e3', 'a', 9000, null);
  assert.deepEqual(store.listEvents().map((e) => e.id), ['e3', 'e2', 'e1']);
  assert.deepEqual(store.listEvents({ camera: 'a' }).map((e) => e.id), ['e3', 'e1']);
  assert.deepEqual(store.listEvents({ before: 9000 }).map((e) => e.id), ['e2', 'e1']);
  assert.deepEqual(store.listEvents({ from: 5500, to: 8000 }).map((e) => e.id), ['e2']);
  assert.equal(store.listEvents({ limit: 1 }).length, 1);
  assert.deepEqual(store.openEvents().map((e) => e.id), ['e3']);
  assert.equal(store.getEvent('e1').zones[0], 'z');
  const p = store.patchEvent('e1', { locked: true, reviewed: true, note: 'x'.repeat(3000) });
  assert.equal(p.locked, true);
  assert.equal(p.reviewed, true);
  assert.equal(p.note.length, 2000);
  assert.deepEqual(store.listEvents({ locked: true }).map((e) => e.id), ['e1']);
  assert.deepEqual(store.listEvents({ reviewed: false }).map((e) => e.id), ['e3', 'e2']);
  assert.equal(store.patchEvent('e1', { note: null }).note, null);
  store.updateEventProgress('e3', { endMs: 9500, clipToMs: 10500, peak: 0.9, frames: 7, zones: [] });
  assert.equal(store.getEvent('e3').endMs, 9500);
  assert.deepEqual(store.eventsBetween('a', 9200, 9300).map((e) => e.id), ['e3']);
  store.deleteEvent('e2');
  assert.equal(store.getEvent('e2'), null);
  store.close();
});

test('store.transaction rolls back on error', async () => {
  const store = await S.openStore(tmp());
  assert.throws(() => store.transaction(() => { store.addSegment({ camera: 'a', startMs: 1, durMs: 1, path: 'p', bytes: 1 }); throw new Error('boom'); }), /boom/);
  assert.equal(store.segmentByStart('a', 1), null);
  store.close();
});

// ── retention: victim selection (pure) ───────────────────────────────────────────────────────────────────────────

const NOW = 1_800_000_000_000;
const seg = (id, camera, ageDays, bytes = 1000, durMs = 2000) => ({ id, camera, startMs: NOW - ageDays * DAY, durMs, bytes });
const ev = (id, camera, ageDays, extra = {}) => {
  const startMs = NOW - ageDays * DAY;
  return { id, camera, startMs, endMs: startMs + 5000, clipFromMs: startMs - 10_000, clipToMs: startMs + 15_000, locked: false, ...extra };
};
const SET = { retention: { maxGB: 50, maxDays: 14, eventMaxDays: 30, minFreeGB: 2 } };

test('age: footage older than maxDays goes, recent stays', () => {
  const v = R.selectVictims({ segments: [seg(1, 'a', 20), seg(2, 'a', 15), seg(3, 'a', 13), seg(4, 'a', 0.1)], events: [], now: NOW, settings: SET });
  assert.deepEqual(v.segments, [1, 2]);
  assert.equal(v.reasons.ageSegments, 2);
  assert.equal(v.overLimit, false);
});

test('age: footage covered by a kept event outlives maxDays; once the event ages out, its footage goes too', () => {
  const e = ev('e1', 'a', 20); // 20 days < eventMaxDays 30
  const covered = { id: 1, camera: 'a', startMs: e.startMs - 2000, durMs: 2000, bytes: 1000 };
  const otherCam = { ...covered, id: 2, camera: 'b' };
  const v = R.selectVictims({ segments: [covered, otherCam], events: [e], now: NOW, settings: SET });
  assert.deepEqual(v.segments, [2]); // another camera's footage is not protected
  assert.deepEqual(v.events, []);

  const old = ev('e2', 'a', 40);
  const oldSeg = { id: 3, camera: 'a', startMs: old.startMs, durMs: 2000, bytes: 1000 };
  const v2 = R.selectVictims({ segments: [oldSeg], events: [old], now: NOW, settings: SET });
  assert.deepEqual(v2.events, ['e2']);
  assert.deepEqual(v2.segments, [3]);
});

test('age: locked events and open events are never aged out; their footage stays', () => {
  const locked = ev('L', 'a', 60, { locked: true });
  const open = ev('O', 'a', 60, { endMs: null, clipToMs: null });
  const s = { id: 1, camera: 'a', startMs: locked.startMs, durMs: 2000, bytes: 1 };
  const v = R.selectVictims({ segments: [s], events: [locked, open], now: NOW, settings: SET });
  assert.deepEqual(v.events, []);
  assert.deepEqual(v.segments, []);
});

test('eventMaxDays can never be below maxDays', () => {
  const e = ev('e1', 'a', 16);
  const v = R.selectVictims({ segments: [], events: [e], now: NOW, settings: { retention: { maxDays: 20, eventMaxDays: 5 } } });
  assert.deepEqual(v.events, []);
});

test('size: continuous footage goes first, oldest first across cameras, until under the cap', () => {
  const segments = [seg(1, 'a', 3, 10 * GB), seg(2, 'b', 2, 10 * GB), seg(3, 'a', 1, 10 * GB), seg(4, 'b', 0.5, 10 * GB), seg(5, 'a', 0.1, 10 * GB), seg(6, 'b', 0.05, 10 * GB)];
  const v = R.selectVictims({ segments, events: [], now: NOW, settings: { retention: { maxGB: 35, maxDays: 14, eventMaxDays: 30, minFreeGB: 0 } } });
  assert.deepEqual(v.segments, [1, 2, 3]); // 60 → 30 GB
  assert.equal(v.reasons.sizeSegments, 3);
  assert.equal(v.overLimit, false);
  assert.equal(v.bytes, 30 * GB);
});

test('size: event footage and events only after continuous footage; locked events are never deleted', () => {
  const e1 = ev('e1', 'a', 5, { bytes: 1 * GB });
  const eL = ev('eL', 'a', 6, { bytes: 1 * GB, locked: true });
  const s1 = { id: 1, camera: 'a', startMs: e1.startMs, durMs: 2000, bytes: 20 * GB }; // covered by e1
  const s2 = { id: 2, camera: 'a', startMs: NOW - DAY, durMs: 2000, bytes: 20 * GB }; // continuous
  const s3 = { id: 3, camera: 'a', startMs: eL.startMs, durMs: 2000, bytes: 20 * GB }; // covered by the locked event
  const v = R.selectVictims({ segments: [s1, s2, s3], events: [e1, eL], now: NOW, settings: { retention: { maxGB: 15, maxDays: 14, eventMaxDays: 30, minFreeGB: 0 } } });
  assert.ok(v.segments.includes(2));
  assert.ok(v.segments.includes(1) && v.events.includes('e1'), 'unlocked event goes when continuous footage is not enough');
  assert.ok(!v.segments.includes(3) && !v.events.includes('eL'), 'locked stays');
  assert.equal(v.overLimit, true, 'locked footage alone is over the cap and is still kept');
});

test('size: low free disk space triggers deletion like the size cap; clip caches go last', () => {
  const e = ev('e1', 'a', 1, { bytes: 3 * GB, cacheBytes: 2 * GB, locked: true });
  const v = R.selectVictims({ segments: [], events: [e], now: NOW, settings: { retention: { maxGB: 50, maxDays: 14, eventMaxDays: 30, minFreeGB: 5 } }, usage: { totalBytes: 3 * GB, freeBytes: 4 * GB } });
  assert.deepEqual(v.caches, ['e1']);
  assert.deepEqual(v.events, []);
  assert.equal(v.overLimit, false);
});

test('selectVictims on nothing is a no-op', () => {
  assert.deepEqual(R.selectVictims({ segments: [], events: [], now: NOW, settings: SET }), { segments: [], events: [], caches: [], bytes: 0, reasons: { ageSegments: 0, ageEvents: 0, sizeSegments: 0, sizeEvents: 0, sizeCaches: 0 }, overLimit: false });
});

// ── retention: safeRemove confinement ────────────────────────────────────────────────────────────────────────────

function fixture() {
  const dir = tmp();
  const outside = tmp();
  fs.mkdirSync(path.join(dir, 'segments/cam/d/h'), { recursive: true });
  fs.mkdirSync(path.join(dir, 'events/e1'), { recursive: true });
  fs.writeFileSync(path.join(dir, 'segments/cam/d/h/1.ts'), 'x');
  fs.writeFileSync(path.join(dir, 'events/e1/thumb.jpg'), 'x');
  fs.writeFileSync(path.join(dir, 'settings.json'), '{}');
  fs.writeFileSync(path.join(dir, 'index.sqlite'), 'db');
  fs.writeFileSync(path.join(outside, 'precious.txt'), 'keep');
  return { dir, outside };
}

test('safeRemove deletes files and folders inside segments/ and events/', () => {
  const { dir } = fixture();
  assert.equal(R.safeRemove(dir, 'segments/cam/d/h/1.ts'), true);
  assert.equal(fs.existsSync(path.join(dir, 'segments/cam/d/h/1.ts')), false);
  assert.equal(R.safeRemove(dir, 'events/e1'), true);
  assert.equal(fs.existsSync(path.join(dir, 'events/e1')), false);
  assert.equal(R.safeRemove(dir, 'events/gone'), false); // already gone
});

test('safeRemove refuses traversal, absolute paths, other data files, the roots themselves and junk', () => {
  const { dir, outside } = fixture();
  const log = [];
  for (const rel of ['../x', 'segments/../settings.json', 'settings.json', 'index.sqlite', path.join(outside, 'precious.txt'), '/etc/hosts',
    'C:\\x', '', 'segments\0x', 'segments', 'events', null, undefined, 42]) {
    assert.equal(R.safeRemove(dir, rel, (m) => log.push(m)), false, String(rel));
  }
  assert.ok(fs.existsSync(path.join(dir, 'settings.json')));
  assert.ok(fs.existsSync(path.join(dir, 'index.sqlite')));
  assert.ok(fs.existsSync(path.join(dir, 'segments')));
  assert.ok(fs.existsSync(path.join(outside, 'precious.txt')));
  assert.ok(log.length >= 10);
});

test('safeRemove: a symlinked folder inside segments/ cannot be used to reach outside; symlinks are unlinked, not followed', { skip: process.platform === 'win32' }, () => {
  const { dir, outside } = fixture();
  fs.symlinkSync(outside, path.join(dir, 'segments/escape'));
  assert.equal(R.safeRemove(dir, 'segments/escape/precious.txt'), false);
  assert.ok(fs.existsSync(path.join(outside, 'precious.txt')));
  // the link itself is inside the tree: unlink it, never recurse into the target
  assert.equal(R.safeRemove(dir, 'segments/escape'), true);
  assert.equal(fs.existsSync(path.join(dir, 'segments/escape')), false);
  assert.ok(fs.existsSync(path.join(outside, 'precious.txt')));
  // a dangling target and a symlinked data root
  fs.symlinkSync(path.join(outside, 'precious.txt'), path.join(dir, 'events/e1/link'));
  assert.equal(R.safeRemove(dir, 'events/e1'), true);
  assert.ok(fs.existsSync(path.join(outside, 'precious.txt')));
});

test('safeRemove refuses everything when the data dir is missing', () => {
  assert.equal(R.safeRemove(path.join(os.tmpdir(), 'hs-definitely-missing-dir'), 'segments/a'), false);
});

test('pruneEmptyDirs removes empty hour and day folders but keeps the camera folder', () => {
  const { dir } = fixture();
  R.safeRemove(dir, 'segments/cam/d/h/1.ts');
  R.pruneEmptyDirs(dir, 'segments/cam/d/h/1.ts');
  assert.equal(fs.existsSync(path.join(dir, 'segments/cam/d')), false);
  assert.equal(fs.existsSync(path.join(dir, 'segments/cam')), true);
});

// ── retention: end to end on a real store ────────────────────────────────────────────────────────────────────────

function addFootage(store, dir, camera, startMs, count, bytes = 1000) {
  for (let i = 0; i < count; i++) {
    const t = startMs + i * 2000;
    const rel = segmentRelPath(camera, t);
    fs.mkdirSync(path.dirname(path.join(dir, rel)), { recursive: true });
    fs.writeFileSync(path.join(dir, rel), Buffer.alloc(bytes));
    store.addSegment({ camera, startMs: t, durMs: 2000, path: rel, bytes });
  }
}

test('runRetention: aged footage is deleted from disk and index, kept event footage and locked events survive', async () => {
  const dir = tmp();
  const store = await S.openStore(dir);
  const now = Date.now();
  addFootage(store, dir, 'cam', now - 20 * DAY, 5); // old, unprotected
  addFootage(store, dir, 'cam', now - 20 * DAY + 100_000, 3); // old, covered by event
  addFootage(store, dir, 'cam', now - 60_000, 5); // recent
  store.insertEvent({ id: 'keep', camera: 'cam', startMs: now - 20 * DAY + 102_000, endMs: now - 20 * DAY + 103_000, clipFromMs: now - 20 * DAY + 100_000, clipToMs: now - 20 * DAY + 106_000, peak: 0.5, frames: 3, zones: [] });
  fs.mkdirSync(path.join(dir, 'events/keep'), { recursive: true });
  fs.writeFileSync(path.join(dir, 'events/keep/thumb.jpg'), 'jpg');
  const oldEnd = now - 40 * DAY;
  store.insertEvent({ id: 'old', camera: 'cam', startMs: oldEnd - 3000, endMs: oldEnd, clipFromMs: oldEnd - 13000, clipToMs: oldEnd + 10000, peak: 0.5, frames: 3, zones: [] });
  store.insertEvent({ id: 'lockedold', camera: 'cam', startMs: oldEnd - 3000, endMs: oldEnd, clipFromMs: oldEnd - 13000, clipToMs: oldEnd + 10000, peak: 0.5, frames: 3, zones: [] });
  store.patchEvent('lockedold', { locked: true });
  for (const id of ['old', 'lockedold']) { fs.mkdirSync(path.join(dir, 'events', id), { recursive: true }); fs.writeFileSync(path.join(dir, 'events', id, 'thumb.jpg'), 'jpg'); }

  const r = R.runRetention({ store, settings: store.getSettings(), now });
  assert.equal(r.deleted.events, 1);
  assert.equal(r.deleted.segments, 5);
  assert.ok(r.deleted.bytes >= 5000);
  assert.equal(r.overLimit, false);
  assert.equal(fs.existsSync(path.join(dir, 'events/old')), false);
  assert.equal(store.getEvent('old'), null);
  assert.ok(store.getEvent('lockedold'));
  assert.ok(fs.existsSync(path.join(dir, 'events/lockedold/thumb.jpg')));
  assert.ok(store.getEvent('keep'));
  assert.equal(store.segments('cam', now - 21 * DAY, now - 19 * DAY).length, 3); // the event's footage
  assert.equal(store.segments('cam', now - 120_000, now).length, 5);
  assert.equal(fs.readdirSync(path.join(dir, 'segments/cam')).length >= 1, true);
  // second run is a no-op
  assert.equal(R.runRetention({ store, settings: store.getSettings(), now }).deleted.segments, 0);
  store.close();
});

test('runRetention: an index row whose file is already gone is dropped, not counted as freed bytes', async () => {
  const dir = tmp();
  const store = await S.openStore(dir);
  const now = Date.now();
  addFootage(store, dir, 'cam', now - 30 * DAY, 1);
  fs.rmSync(path.join(dir, 'segments'), { recursive: true });
  fs.mkdirSync(path.join(dir, 'segments'));
  const r = R.runRetention({ store, settings: store.getSettings(), now });
  assert.equal(r.deleted.segments, 1);
  assert.equal(r.deleted.bytes, 0);
  assert.equal(store.allSegments().length, 0);
  store.close();
});

test('storageReport totals segments + events and flags the cap', async () => {
  const dir = tmp();
  const store = await S.openStore(dir);
  addFootage(store, dir, 'cam', Date.now() - 10_000, 2, 500);
  fs.mkdirSync(path.join(dir, 'events/e'), { recursive: true });
  fs.writeFileSync(path.join(dir, 'events/e/thumb.jpg'), Buffer.alloc(300));
  const rep = R.storageReport(store, store.getSettings());
  assert.equal(rep.segmentsBytes, 1000);
  assert.equal(rep.eventsBytes, 300);
  assert.equal(rep.totalBytes, 1300);
  assert.equal(rep.cameras.cam, 1000);
  assert.equal(rep.maxBytes, 50 * GB);
  assert.equal(rep.overLimit, false);
  store.close();
});

// ── recorder: motion → event with pre-roll → API ─────────────────────────────────────────────────────────────────

const T0 = 1_800_000_000_000;

async function rig(settings = {}) {
  const dir = tmp();
  let clock = T0 + 30_000;
  const logs = [];
  const emitted = [];
  const rec = await Rec.createRecorder({
    dataDir: dir, timers: false, node: 'testnode', now: () => clock, log: (m) => logs.push(m), emit: (type, d) => emitted.push({ type, d }),
    settings: { recording: { preRollSeconds: 4, postRollSeconds: 3, segmentSeconds: 2, defaultMode: 'continuous' }, ...settings },
  });
  const server = http.createServer((req, res) => {
    rec.handle(req, res, new URL(req.url, 'http://x'), { self: { node: 'testnode', base: './' } }).then((h) => { if (!h) { res.writeHead(404); res.end(); } }, () => { res.writeHead(500); res.end(); });
  });
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  const base = `http://127.0.0.1:${server.address().port}`;
  const get = async (p, init) => { const r = await fetch(base + p, init); const t = await r.text(); let j = null; try { j = JSON.parse(t); } catch { /* not json */ } return { status: r.status, headers: r.headers, text: t, json: j }; };
  return { dir, rec, base, get, emitted, logs, setClock: (t) => { clock = t; }, close: async () => { await new Promise((r) => server.close(r)); rec.close(); } };
}

function feedSegments(rec, dir, camera, fromMs, toMs, step = 2000) {
  for (let t = fromMs; t < toMs; t += step) {
    const rel = segmentRelPath(camera, t);
    fs.mkdirSync(path.dirname(path.join(dir, rel)), { recursive: true });
    fs.writeFileSync(path.join(dir, rel), Buffer.alloc(200));
    rec.onSegment({ camera, startMs: t, durMs: step, path: rel });
  }
}

/** 5 fps frames from fromMs to toMs; a block is in the picture while t is in [motionFrom, motionTo). */
function feedFrames(rec, camera, fromMs, toMs, motionFrom, motionTo) {
  for (let t = fromMs; t < toMs; t += 200) {
    const moving = t >= motionFrom && t < motionTo;
    rec.onFrame({ camera, frame: frame(100, moving ? block(0, 8) : undefined), width: W, height: H, t });
  }
}

test('recorder: one short movement → exactly one event with the configured pre/post-roll and a thumbnail', async () => {
  const r = await rig();
  try {
    fs.mkdirSync(path.join(r.dir, 'live/cam-a'), { recursive: true });
    fs.writeFileSync(path.join(r.dir, 'live/cam-a/latest.jpg'), Buffer.from([0xff, 0xd8, 0xff, 0xd9]));
    feedSegments(r.rec, r.dir, 'cam-a', T0, T0 + 24_000);
    feedFrames(r.rec, 'cam-a', T0, T0 + 24_000, T0 + 10_000, T0 + 11_000);

    const list = await r.get('/api/events');
    assert.equal(list.status, 200);
    assert.equal(list.json.events.length, 1);
    const e = list.json.events[0];
    assert.equal(e.camera, 'cam-a');
    assert.equal(e.node, 'testnode');
    assert.equal(e.start, T0 + 10_000);
    assert.equal(e.end, T0 + 10_800); // last frame with motion
    assert.equal(e.clipFrom, T0 + 6_000, 'pre-roll 4 s before the movement');
    assert.equal(e.clipTo, T0 + 13_800, 'post-roll 3 s after it');
    assert.equal(e.locked, false);
    assert.equal(e.reviewed, false);
    assert.equal(e.thumb, `api/events/${e.id}/thumb.jpg`);
    assert.equal(e.clip, `api/events/${e.id}/clip.m3u8`);
    assert.ok(e.peak > 0.2);

    const kinds = r.emitted.filter((x) => x.type === 'event').map((x) => x.d.type);
    assert.deepEqual(kinds, ['opened', 'closed']);
    assert.ok(r.emitted.some((x) => x.type === 'motion' && x.d.camera === 'cam-a'));

    const one = await r.get(`/api/events/${e.id}`);
    assert.equal(one.json.id, e.id);

    const th = await r.get(`/api/events/${e.id}/thumb.jpg`);
    assert.equal(th.status, 200);
    assert.equal(th.headers.get('content-type'), 'image/jpeg');

    // clip playlist: first segment starts at or before the pre-roll point, within one segment of it; only this camera's footage
    const clip = await r.get(`/api/events/${e.id}/clip.m3u8`);
    assert.equal(clip.status, 200);
    assert.match(clip.headers.get('content-type'), /mpegurl/);
    const starts = [...clip.text.matchAll(/seg\/(\d+)\.ts/g)].map((m) => Number(m[1]));
    assert.deepEqual(starts, [T0 + 6000, T0 + 8000, T0 + 10000, T0 + 12000]);
    assert.ok(clip.text.includes(`../../cameras/cam-a/seg/${T0 + 6000}.ts`));
    assert.ok(clip.text.includes('#EXT-X-ENDLIST'));
  } finally { await r.close(); }
});

test('recorder: a static scene records no event; the same movement in an excluded zone neither', async () => {
  const r = await rig();
  try {
    feedFrames(r.rec, 'cam-a', T0, T0 + 20_000, 0, 0);
    assert.deepEqual((await r.get('/api/events')).json.events, []);
  } finally { await r.close(); }

  const dir = tmp();
  const rec = await Rec.createRecorder({
    dataDir: dir, timers: false, log: () => {},
    getCamera: () => ({ id: 'z', motion: { enabled: true, sensitivity: null, zones: [SQUARE('exclude', 0, 0, 0.5, 1)] } }),
    settings: { recording: { postRollSeconds: 1 } },
  });
  feedFrames(rec, 'z', T0, T0 + 12_000, T0 + 6000, T0 + 7000);
  assert.equal(rec.store.allEvents().length, 0);
  rec.close();
});

test('recorder: per-camera motion off, global motion off and mode "off" disable detection', async () => {
  const dir = tmp();
  let cam = { id: 'c', motion: { enabled: false } };
  const rec = await Rec.createRecorder({ dataDir: dir, timers: false, log: () => {}, getCamera: () => cam, settings: { recording: { postRollSeconds: 1 } } });
  feedFrames(rec, 'c', T0, T0 + 10_000, T0 + 5000, T0 + 6000);
  assert.equal(rec.store.allEvents().length, 0);
  cam = { id: 'c', mode: 'off', motion: { enabled: true } };
  feedFrames(rec, 'c', T0 + 20_000, T0 + 30_000, T0 + 25_000, T0 + 26_000);
  assert.equal(rec.store.allEvents().length, 0);
  cam = { id: 'c', motion: { enabled: true } };
  rec.store.patchSettings({ motion: { enabled: false } });
  feedFrames(rec, 'c', T0 + 40_000, T0 + 50_000, T0 + 45_000, T0 + 46_000);
  assert.equal(rec.store.allEvents().length, 0);
  rec.close();
});

test('recorder: stopCamera and close finish an open event instead of leaving it open', async () => {
  const r = await rig();
  try {
    feedFrames(r.rec, 'cam-a', T0, T0 + 8_000, T0 + 5_000, T0 + 8_000);
    assert.equal(r.rec.store.openEvents().length, 1);
    const open = (await r.get('/api/events')).json.events[0];
    assert.equal(open.end, null);
    assert.equal(open.clipTo, null);
    r.rec.stopCamera('cam-a');
    assert.equal(r.rec.store.openEvents().length, 0);
    const done = (await r.get('/api/events')).json.events[0];
    assert.ok(done.end >= done.start);
    assert.equal(done.clipTo, done.end + 3000);
  } finally { await r.close(); }
});

test('recorder: reconcile closes events left open by a crash and drops index rows for missing files', async () => {
  const dir = tmp();
  const now = Date.now();
  const store = await S.openStore(dir);
  addFootage(store, dir, 'cam', now - 60_000, 4);
  store.addSegment({ camera: 'cam', startMs: now - 20_000, durMs: 2000, path: 'segments/cam/missing.ts', bytes: 1 });
  store.insertEvent({ id: 'cam-crash', camera: 'cam', startMs: now - 58_000, endMs: null, clipFromMs: now - 68_000, clipToMs: null, peak: 0.4, frames: 3, zones: [] });
  const rec = await Rec.createRecorder({ dataDir: dir, store, timers: false, log: () => {}, now: () => now });
  assert.equal(store.openEvents().length, 0);
  const e = store.getEvent('cam-crash');
  assert.ok(e.endMs >= e.startMs);
  assert.ok(e.clipToMs > e.endMs);
  assert.equal(store.segmentByStart('cam', now - 20_000), null);
  rec.close();
});

test('recorder: onSegment ignores junk and never double-inserts', async () => {
  const r = await rig();
  try {
    assert.equal(r.rec.onSegment({ camera: '', startMs: 1, path: 'x' }), null);
    assert.equal(r.rec.onSegment({ camera: 'a', startMs: NaN, path: 'x' }), null);
    assert.equal(r.rec.onSegment({ camera: 'a', startMs: 1 }), null);
    assert.ok(r.rec.onSegment({ camera: 'a', startMs: 1000, durMs: 2000, path: 'segments/a/x.ts', bytes: 5 }));
    assert.equal(r.rec.onSegment({ camera: 'a', startMs: 1000, durMs: 2000, path: 'segments/a/x.ts', bytes: 5 }), null);
    assert.equal(r.rec.liveSegments('a', 5).length, 1);
    assert.equal(r.rec.segmentPath('a', 1000), path.join(r.dir, 'segments/a/x.ts'));
    assert.equal(r.rec.segmentPath('a', 999), null);
  } finally { await r.close(); }
});

// ── recorder: timeline API ───────────────────────────────────────────────────────────────────────────────────────

test('timeline: merged spans per camera with events; aligned lookup across cameras; gaps report the next footage', async () => {
  const r = await rig();
  try {
    feedSegments(r.rec, r.dir, 'cam-a', T0, T0 + 24_000);
    feedSegments(r.rec, r.dir, 'cam-b', T0 + 1_000, T0 + 5_000); // starts 1 s off cam-a's grid
    feedSegments(r.rec, r.dir, 'cam-b', T0 + 20_000, T0 + 24_000);
    feedFrames(r.rec, 'cam-a', T0, T0 + 20_000, T0 + 10_000, T0 + 11_000);

    const tl = await r.get(`/api/timeline?from=${T0}&to=${T0 + 30_000}`);
    assert.equal(tl.status, 200);
    assert.deepEqual(tl.json.nodes.map((n) => n.node), ['testnode']);
    const a = tl.json.cameras.find((c) => c.camera === 'cam-a');
    const b = tl.json.cameras.find((c) => c.camera === 'cam-b');
    assert.deepEqual(a.spans, [{ from: T0, to: T0 + 24_000 }]);
    assert.equal(a.events.length, 1);
    assert.equal(a.events[0].start, T0 + 10_000);
    assert.equal(b.spans.length, 2);
    assert.deepEqual(b.spans[1], { from: T0 + 20_000, to: T0 + 24_000 });
    assert.deepEqual(b.events, []);

    const at = await r.get(`/api/timeline/at?t=${T0 + 9_000}`);
    const aa = at.json.cameras.find((c) => c.camera === 'cam-a');
    assert.equal(aa.segment.start, T0 + 8_000);
    assert.equal(aa.offsetMs, 1_000);
    assert.equal(aa.gap, false);
    assert.equal(aa.segment.url, `api/cameras/cam-a/seg/${T0 + 8_000}.ts`);
    const ab = at.json.cameras.find((c) => c.camera === 'cam-b');
    assert.equal(ab.gap, true);
    assert.equal(ab.segment, null);
    assert.equal(ab.nextStart, T0 + 20_000);

    const atB = await r.get(`/api/timeline/at?t=${T0 + 3_500}`);
    const bb = atB.json.cameras.find((c) => c.camera === 'cam-b');
    assert.equal(bb.segment.start, T0 + 3_000);
    assert.equal(bb.offsetMs, 500);
  } finally { await r.close(); }
});

test('timeline: bad ranges are 400', async () => {
  const r = await rig();
  try {
    assert.equal((await r.get('/api/timeline')).status, 400);
    assert.equal((await r.get('/api/timeline?from=5&to=5')).status, 400);
    assert.equal((await r.get('/api/timeline?from=abc&to=9')).status, 400);
    assert.equal((await r.get(`/api/timeline?from=0&to=${8 * DAY}`)).status, 400);
    assert.equal((await r.get('/api/timeline/at')).status, 400);
    assert.equal((await r.get('/api/timeline/at?t=zzz')).status, 400);
  } finally { await r.close(); }
});

test('vod.m3u8: covers the requested range, 404 without footage, 400 for bad or over-long ranges', async () => {
  const r = await rig();
  try {
    feedSegments(r.rec, r.dir, 'cam-a', T0, T0 + 12_000);
    const v = await r.get(`/api/cameras/cam-a/vod.m3u8?from=${T0 + 3_000}&to=${T0 + 7_000}`);
    assert.equal(v.status, 200);
    assert.match(v.headers.get('content-type'), /mpegurl/);
    assert.deepEqual([...v.text.matchAll(/seg\/(\d+)\.ts/g)].map((m) => Number(m[1])), [T0 + 2000, T0 + 4000, T0 + 6000]);
    assert.equal((await r.get(`/api/cameras/cam-a/vod.m3u8?from=${T0 + 50_000}&to=${T0 + 60_000}`)).status, 404);
    assert.equal((await r.get('/api/cameras/cam-a/vod.m3u8?from=9&to=1')).status, 400);
    assert.equal((await r.get(`/api/cameras/cam-a/vod.m3u8?from=0&to=${7 * 3_600_000}`)).status, 400);
  } finally { await r.close(); }
});

// ── recorder: event library API ──────────────────────────────────────────────────────────────────────────────────

async function twoEvents(r) {
  feedSegments(r.rec, r.dir, 'cam-a', T0, T0 + 60_000);
  feedSegments(r.rec, r.dir, 'cam-b', T0, T0 + 60_000);
  feedFrames(r.rec, 'cam-a', T0, T0 + 20_000, T0 + 5_000, T0 + 6_000);
  feedFrames(r.rec, 'cam-b', T0, T0 + 40_000, T0 + 30_000, T0 + 31_000);
  return (await r.get('/api/events')).json.events;
}

test('events API: newest first, camera / time / cursor filters, node filter', async () => {
  const r = await rig();
  try {
    const all = await twoEvents(r);
    assert.deepEqual(all.map((e) => e.camera), ['cam-b', 'cam-a']);
    assert.deepEqual((await r.get('/api/events?camera=cam-a')).json.events.map((e) => e.camera), ['cam-a']);
    assert.deepEqual((await r.get(`/api/events?from=${T0 + 20_000}&to=${T0 + 50_000}`)).json.events.map((e) => e.camera), ['cam-b']);
    const page1 = (await r.get('/api/events?limit=1')).json;
    assert.equal(page1.events.length, 1);
    assert.equal(page1.next, page1.events[0].start);
    const page2 = (await r.get(`/api/events?limit=1&before=${page1.next}`)).json;
    assert.equal(page2.events[0].camera, 'cam-a');
    assert.equal((await r.get('/api/events?node=other')).json.events.length, 0);
    assert.equal((await r.get('/api/events?node=testnode')).json.events.length, 2);
  } finally { await r.close(); }
});

test('events API: lock / review / note via PATCH, then filter by them; invalid bodies are 400', async () => {
  const r = await rig();
  try {
    const [newest, oldest] = await twoEvents(r);
    const p = await r.get(`/api/events/${oldest.id}`, { method: 'PATCH', body: JSON.stringify({ locked: true, note: 'dog' }) });
    assert.equal(p.status, 200);
    assert.equal(p.json.locked, true);
    assert.equal(p.json.note, 'dog');
    assert.deepEqual((await r.get('/api/events?locked=true')).json.events.map((e) => e.id), [oldest.id]);
    const rv = await r.get(`/api/events/${newest.id}`, { method: 'PATCH', body: JSON.stringify({ reviewed: true }) });
    assert.equal(rv.json.reviewed, true);
    assert.deepEqual((await r.get('/api/events?reviewed=false')).json.events.map((e) => e.id), [oldest.id]);
    assert.equal((await r.get(`/api/events/${oldest.id}`, { method: 'PATCH', body: JSON.stringify({ locked: 'yes' }) })).status, 400);
    assert.equal((await r.get(`/api/events/${oldest.id}`, { method: 'PATCH', body: JSON.stringify({ note: 5 }) })).status, 400);
    assert.equal((await r.get(`/api/events/${oldest.id}`, { method: 'PATCH', body: '{nope' })).status, 400);
    assert.equal((await r.get(`/api/events/${oldest.id}`, { method: 'PATCH', body: JSON.stringify({ note: null }) })).json.note, null);
  } finally { await r.close(); }
});

test('events API: DELETE removes the event and its folder; unknown and malformed ids', async () => {
  const r = await rig();
  try {
    const [e] = await twoEvents(r);
    fs.mkdirSync(path.join(r.dir, 'events', e.id), { recursive: true });
    fs.writeFileSync(path.join(r.dir, 'events', e.id, 'thumb.jpg'), 'x');
    assert.equal((await r.get(`/api/events/${e.id}`, { method: 'DELETE' })).status, 204);
    assert.equal((await r.get(`/api/events/${e.id}`)).status, 404);
    assert.equal(fs.existsSync(path.join(r.dir, 'events', e.id)), false);
    assert.equal((await r.get('/api/events/nope-123')).status, 404);
    assert.equal((await r.get('/api/events/a%20b')).status, 400);
    assert.equal((await r.get('/api/events/x/clip.m3u8')).status, 404);
    // the footage is untouched by deleting an event
    assert.ok(r.rec.store.segments('cam-b', T0, T0 + 60_000).length > 0);
  } finally { await r.close(); }
});

test('clip.m3u8 for an event with no footage is 404', async () => {
  const r = await rig();
  try {
    r.rec.store.insertEvent({ id: 'lonely', camera: 'x', startMs: T0, endMs: T0 + 1000, clipFromMs: T0 - 1000, clipToMs: T0 + 2000, peak: 0.1, frames: 1, zones: [] });
    assert.equal((await r.get('/api/events/lonely/clip.m3u8')).status, 404);
  } finally { await r.close(); }
});

// ── recorder: settings + storage API ─────────────────────────────────────────────────────────────────────────────

test('settings API: GET, valid PATCH (deep merge + hook), invalid PATCH is 400 with errors[] and changes nothing', async () => {
  const r = await rig();
  const hook = [];
  try {
    const g = await r.get('/api/settings');
    assert.equal(g.status, 200);
    assert.equal(g.json.recording.preRollSeconds, 4);
    const ok = await r.get('/api/settings', { method: 'PATCH', body: JSON.stringify({ retention: { maxGB: 5 } }) });
    assert.equal(ok.status, 200);
    assert.equal(ok.json.retention.maxGB, 5);
    assert.equal(ok.json.retention.maxDays, 14);
    assert.equal(ok.json.recording.preRollSeconds, 4);
    const bad = await r.get('/api/settings', { method: 'PATCH', body: JSON.stringify({ retention: { maxGB: 0 }, motion: { sensitivity: 200 } }) });
    assert.equal(bad.status, 400);
    assert.ok(Array.isArray(bad.json.errors) && bad.json.errors.length >= 2);
    assert.equal(typeof bad.json.error, 'string');
    assert.equal((await r.get('/api/settings')).json.retention.maxGB, 5);
    assert.equal((await r.get('/api/settings', { method: 'PATCH', body: '[]' })).status, 400);
    assert.equal((await r.get('/api/settings', { method: 'DELETE' })).status, 405);
    // the server hook is called with new and previous settings
    const res = { writeHead() {}, end() {} };
    await r.rec.handle({ method: 'PATCH', url: '/api/settings', on(ev, cb) { if (ev === 'data') cb(Buffer.from('{"live":{"snapshotFps":2}}')); if (ev === 'end') cb(); return this; } }, res, '/api/settings', { onSettingsChanged: (n, p) => hook.push([n.live.snapshotFps, p.live.snapshotFps]) });
    assert.deepEqual(hook, [[2, 1]]);
  } finally { await r.close(); }
});

test('settings PATCH: oversized body is refused', async () => {
  const r = await rig();
  try {
    const big = await r.get('/api/settings', { method: 'PATCH', body: JSON.stringify({ ffmpeg: { path: 'x'.repeat(70_000) } }) }).catch((e) => ({ status: 'aborted', e }));
    assert.ok(big.status === 413 || big.status === 'aborted' || big.status === 400, String(big.status));
    assert.equal((await r.get('/api/settings')).json.ffmpeg.path, '');
  } finally { await r.close(); }
});

test('storage API reports bytes; retention/run deletes aged footage and reports before / after', async () => {
  const r = await rig();
  try {
    const now = Date.now();
    r.setClock(now);
    feedSegments(r.rec, r.dir, 'cam-a', now - 20 * DAY, now - 20 * DAY + 10_000); // 5 aged segments
    feedSegments(r.rec, r.dir, 'cam-a', now - 20_000, now - 10_000);
    const st = await r.get('/api/storage');
    assert.equal(st.status, 200);
    assert.equal(st.json.segmentsBytes, 2000);
    assert.equal(st.json.maxBytes, 50 * GB);
    assert.equal(typeof st.json.overLimit, 'boolean');
    assert.equal(st.json.cameras['cam-a'], 2000);
    const run = await r.get('/api/storage/retention/run', { method: 'POST' });
    assert.equal(run.status, 200);
    assert.equal(run.json.deleted.segments, 5);
    assert.equal(run.json.before.segmentsBytes, 2000);
    assert.equal(run.json.after.segmentsBytes, 1000);
    assert.ok(r.logs.some((l) => /retention: deleted 5 segments/.test(l)));
  } finally { await r.close(); }
});

// ── recorder: motion-mode ring trimmer ───────────────────────────────────────────────────────────────────────────

test('trim (motion mode): drops footage older than the ring, keeps what an event covers, ignores continuous cameras', async () => {
  const dir = tmp();
  const now = T0 + 600_000;
  const cams = { m: { id: 'm', mode: 'motion' }, c: { id: 'c' } };
  const rec = await Rec.createRecorder({
    dataDir: dir, timers: false, log: () => {}, now: () => now, getCamera: (id) => cams[id],
    settings: { recording: { defaultMode: 'continuous', segmentSeconds: 2, preRollSeconds: 4, postRollSeconds: 3, ringSeconds: 20 } },
  });
  feedSegments(rec, dir, 'm', T0, T0 + 600_000, 2000); // 300 segments; ring keeps the last 20 s
  feedSegments(rec, dir, 'c', T0, T0 + 20_000, 2000);
  rec.store.insertEvent({ id: 'm-keep', camera: 'm', startMs: T0 + 100_000, endMs: T0 + 101_000, clipFromMs: T0 + 96_000, clipToMs: T0 + 104_000, peak: 0.3, frames: 3, zones: [] });
  const removed = rec.trim();
  assert.ok(removed > 250, `removed ${removed}`);
  const left = rec.store.segments('m', T0, T0 + 600_000).map((s) => s.startMs);
  assert.ok(left.includes(T0 + 96_000) && left.includes(T0 + 102_000), 'event footage kept');
  assert.ok(left.includes(T0 + 598_000), 'ring kept');
  assert.ok(!left.includes(T0 + 50_000));
  assert.equal(rec.store.segments('c', T0, T0 + 30_000).length, 10, 'continuous camera untouched');
  assert.equal(fs.existsSync(path.join(dir, segmentRelPath('m', T0 + 50_000))), false);
  rec.close();
});

test('unknown routes are not handled by the recorder', async () => {
  const r = await rig();
  try {
    assert.equal((await r.get('/api/nothing')).status, 404);
    assert.equal((await r.get('/api/events/x/other.bin')).status, 404);
  } finally { await r.close(); }
});
