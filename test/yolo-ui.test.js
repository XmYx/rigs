// YOLO window (ui/src/yolo.js): the pure model behind it (ui/src/yolo-model.js) in Node, plus static checks of the wiring.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const read = (f) => fs.readFileSync(path.join(ROOT, f), 'utf8');
const M = await import('../ui/src/yolo-model.js');

const start = { type: 'yolo-start', runId: 'r1', title: 'bouncing ball', task: 'a bouncing ball', node: 'magix-system', url: '/api/nodes/magix-system/yolo/r1/', at: 1000 };
const update = (step, extra = {}) => ({ type: 'yolo-update', runId: 'r1', step, file: 'index.html', files: ['index.html'], activity: 'Write index.html', at: 1000 + step * 1000, ...extra });
const done = (ok, extra = {}) => ({ type: 'yolo-done', runId: 'r1', ok, summary: 'Made a ball.', step: 2, errors: 0, timeToFirstFrameMs: 900, at: 9000, ...extra });

test('isYoloEvent accepts the three yolo events with a runId only', () => {
  assert.ok(M.isYoloEvent(start) && M.isYoloEvent(update(1)) && M.isYoloEvent(done(true)));
  assert.ok(!M.isYoloEvent({ type: 'yolo-update' }));
  assert.ok(!M.isYoloEvent({ type: 'tool', runId: 'r1' }));
  assert.ok(!M.isYoloEvent(null));
});

test('startRun gives a live run on the proxied url', () => {
  const s = M.startRun(start);
  assert.equal(s.status, 'live');
  assert.equal(s.url, '/api/nodes/magix-system/yolo/r1/');
  assert.equal(M.startRun({ ...start, url: undefined }).url, '/api/nodes/magix-system/yolo/r1/', 'built from the node when the url is missing');
  assert.equal(M.windowTitle(s), 'YOLO — bouncing ball · magix-system');
});

test('updates move the step and ask for a reload; the /ws and stream copies of one update change nothing', () => {
  let s = M.startRun(start);
  const a = M.applyEvent(s, update(1));
  assert.equal(a.step, 1); assert.equal(a.reloads, 1); assert.equal(a.activity, 'Write index.html');
  assert.equal(M.applyEvent(a, update(1)), a, 'duplicate step');
  assert.equal(M.applyEvent(a, update(0)), a, 'stale step');
  assert.equal(M.applyEvent(a, { ...update(5), runId: 'other' }), a, 'another run');
  assert.equal(M.applyEvent(a, update(2, { activity: 'Edit app.js', files: ['index.html', 'app.js'] })).files.length, 2);
});

test('done settles to done or failed and later events change nothing', () => {
  const live = M.applyEvent(M.startRun(start), update(1));
  const ok = M.applyEvent(live, done(true));
  assert.equal(ok.status, 'done'); assert.equal(ok.timeToFirstFrameMs, 900); assert.equal(ok.endedAt, 9000);
  assert.equal(M.applyEvent(ok, update(3)), ok);
  assert.equal(M.applyEvent(ok, done(false)), ok);
  const bad = M.applyEvent(live, done(false, { summary: 'Stopped by you', errors: 3 }));
  assert.equal(bad.status, 'failed'); assert.equal(bad.errors, 3); assert.equal(bad.activity, 'Stopped by you');
});

test('eventKey dedupes by type, run and step', () => {
  assert.notEqual(M.eventKey(update(1)), M.eventKey(update(2)));
  assert.equal(M.eventKey(update(1)), M.eventKey({ ...update(1), at: 5 }));
  assert.notEqual(M.eventKey(start), M.eventKey({ ...start, runId: 'r2' }));
});

test('elapsed counts to now while live and stops at the end', () => {
  const s = M.startRun(start);
  assert.equal(M.elapsed(s, 8000), '0:07');
  assert.equal(M.elapsed(s, 1000 + 83000), '1:23');
  assert.equal(M.elapsed({ ...s, endedAt: 4000 }, 99999), '0:03');
});

test('errorCount reads the errors endpoint (total counts dropped reports too)', () => {
  assert.equal(M.errorCount({ total: 7, errors: [{}] }), 7);
  assert.equal(M.errorCount({ errors: [{}, {}] }), 2);
  assert.equal(M.errorCount(null), 0);
});

test('stop and errors urls hang off the run url, with or without the trailing slash', () => {
  const s = M.startRun(start);
  assert.equal(M.stopUrl(s), '/api/nodes/magix-system/yolo/r1/stop');
  assert.equal(M.errorsUrl({ ...s, url: '/api/nodes/n/yolo/r1' }), '/api/nodes/n/yolo/r1/errors');
});

test('wiring: both event paths reach the window, and it has phone rules', () => {
  const main = read('ui/src/main.js');
  assert.equal((main.match(/onYoloEvent\(/g) || []).length, 2, 'ws push and jarvis/send stream');
  const css = read('ui/src/styles.css');
  assert.match(css, /\.yolo-strip/);
  assert.match(css, /max-width: 640px[^{]*\{\s*\n\s*\.yolo-strip/);
  assert.match(read('ui/src/yolo.js'), /className: 'yolo-win'/);
});

test('prettyActivity shortens a tool step to the tool and its file', () => {
  assert.equal(M.prettyActivity('Write {"file_path":"/tmp/x/index.html"}'), 'Write index.html');
  assert.equal(M.prettyActivity('Bash {"command":"curl -s http://x/errors"}'), 'Bash errors');
  assert.equal(M.prettyActivity('Write index.html'), 'Write index.html');
  assert.equal(M.prettyActivity('Thinking {broken'), 'Thinking {broken');
  assert.equal(M.prettyActivity(undefined), '');
  const s = M.applyEvent(M.startRun(start), update(1, { activity: 'Edit {"file_path":"/a/b/app.js"}' }));
  assert.equal(s.activity, 'Edit app.js');
});

test('Keep as app: the button per state, the kept event, the request body and the app it opens', () => {
  const live = M.startRun(start);
  assert.deepEqual(M.keepButton(live), { label: '★ Keep as app', title: 'Stop the agent and keep this page as an App Cloud app', disabled: false, kept: false });
  const fin = M.applyEvent(live, done(true));
  assert.equal(M.keepButton(fin).title, 'Keep this page as an App Cloud app');
  assert.equal(M.keepButton(fin, 'asking').disabled, true, 'the form is open');
  assert.deepEqual([M.keepButton(fin, 'stopping').label, M.keepButton(fin, 'keeping').label], ['★ Stopping…', '★ Keeping…']);
  const keptAs = { id: 'orbit-test', node: 'magix-system', path: '/api/nodes/magix-system/apps/orbit-test/', name: 'Orbit test', icon: '🪐' };
  const kev = { type: 'yolo-kept', runId: 'r1', keptAs, at: 9500 };
  assert.ok(M.isYoloEvent(kev));
  const kept = M.applyEvent(fin, kev);
  assert.equal(kept.keptAs.id, 'orbit-test');
  assert.equal(M.applyEvent(kept, kev), kept, 'the same keep twice changes nothing');
  assert.deepEqual(M.keepButton(kept), { label: '★ Kept', title: 'Kept as Orbit test — open it', disabled: false, kept: true });
  assert.equal(M.startRun({ ...start, keptAs }).keptAs.id, 'orbit-test', 'a run that was kept reads Kept on reopen');
  assert.equal(M.keepUrl(fin), '/api/nodes/magix-system/yolo/r1/keep');
  assert.equal(M.metaUrl(fin), '/api/nodes/magix-system/yolo/r1/meta');
  assert.deepEqual(M.keepBody({ name: '  Orbit   test ', icon: '🪐' }, fin), { name: 'Orbit test', icon: '🪐' });
  assert.deepEqual(M.keepBody({ name: '', icon: '' }, fin), { name: 'bouncing ball' }, 'the run title when the name is empty');
  const cat = [{ id: 'orbit-test', node: 'magix-system', name: 'Orbit test', health: { status: 'up' } }];
  assert.equal(M.keptApp(keptAs, cat), cat[0], 'the catalog entry when there is one');
  assert.equal(M.keptApp(keptAs, [], { id: 'orbit-test', node: 'x', name: 'From server' }).node, 'magix-system');
  const built = M.keptApp(keptAs, []);
  assert.deepEqual([built.id, built.node, built.name, !!built.launchHere], ['orbit-test', 'magix-system', 'Orbit test', true], 'built from keptAs, started on open when down');
  assert.equal(M.keptApp(null, cat), null);
});

test('wiring: the Keep button is live, posts through the run\'s node and opens the app with the Apps opener', () => {
  const src = read('ui/src/yolo.js');
  assert.doesNotMatch(src, /not available yet/);
  assert.match(src, /keepUrl\(r\.state\)/);
  assert.match(src, /openApp\(a\)/);
  assert.match(src, /import \{[^}]*openApp[^}]*\} from '\.\/apps\.js'/);
  assert.match(read('ui/src/styles.css'), /\.yolo-keep-form/);
});

test('withMeta: a window opened for a run takes keptAs and, for a run that already ended, its end from the meta', () => {
  const live = M.startRun(start);
  assert.equal(M.withMeta(live, { runId: 'r1', status: 'running' }), live, 'a run still working: nothing changes');
  assert.equal(M.withMeta(live, { runId: 'other', status: 'done' }), live, 'another run');
  const keptAs = { id: 'orbit-test', node: 'magix-system', name: 'Orbit test' };
  const re = M.withMeta(live, { runId: 'r1', status: 'done', ok: true, summary: 'Planets.', errors: 2, updates: 4, startedAt: 1000, firstFrameAt: 1900, endedAt: 9000, keptAs });
  assert.deepEqual([re.status, re.ok, re.errors, re.step, re.endedAt, re.timeToFirstFrameMs, re.keptAs.id], ['done', true, 2, 4, 9000, 900, 'orbit-test']);
  assert.equal(M.keepButton(re).label, '★ Kept');
  assert.equal(M.withMeta(live, { runId: 'r1', status: 'stopped', ok: false }).status, 'failed');
  const ended = M.applyEvent(live, done(true));
  assert.equal(M.withMeta(ended, { runId: 'r1', status: 'done', ok: true }), ended, 'already ended: unchanged');
});
