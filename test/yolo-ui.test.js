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
