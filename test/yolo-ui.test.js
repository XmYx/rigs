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

// ── YOLOv2: conversation, composer, icon, hidden state ──────────────────────────────────────────────────────────────
const v2start = { ...start, v2: true };
const msg = (role, turn, at, text, extra = {}) => ({ type: 'yolo-message', runId: 'r1', role, turn, at, text, ...extra });
const idleDone = (turn, extra = {}) => done(true, { idle: true, turn, step: 2, at: 5000 + turn, ...extra });

test('mergeMessages dedupes by role/turn/time, keeps order, returns the same array when nothing is new', () => {
  const a = [msg('user', 1, 1000, 'hi')];
  assert.equal(M.mergeMessages(a, [msg('user', 1, 1000, 'hi')]), a, 'the /ws and meta copies of one message');
  const b = M.mergeMessages(a, [msg('assistant', 1, 3000, 'done'), msg('user', 2, 2000, 'bigger'), { role: 'system', text: 'x' }, null, { role: 'user' }]);
  assert.deepEqual(b.map((m) => m.text), ['hi', 'bigger', 'done']);
  assert.ok(b.slice(1).every((m) => !('type' in m) && !('runId' in m)), 'event envelope stripped');
  assert.equal(M.mergeMessages(b, undefined), b);
  const many = M.mergeMessages([], Array.from({ length: 230 }, (_, i) => msg('user', 1, i + 1, `m${i}`)));
  assert.equal(many.length, 200);
  assert.equal(many.at(-1).text, 'm229');
});

test('a v2 run: idle after each turn, live again on the follow-up, turns of the same step still count', () => {
  let s = M.startRun(v2start);
  assert.ok(s.v2);
  s = M.applyEvent(s, update(1));
  s = M.applyEvent(s, msg('assistant', 1, 4000, 'Made a ball.'));
  s = M.applyEvent(s, idleDone(1));
  assert.equal(s.status, 'idle');
  assert.equal(M.STATUS_LABEL[s.status], 'ready');
  assert.equal(s.messages.length, 1);
  assert.equal(M.applyEvent(s, idleDone(1)), s, 'a repeated done');
  const s2 = M.applyEvent(s, msg('user', 2, 6000, 'make it blue', { feedback: { text: 'blue' } }));
  assert.equal(s2.status, 'live');
  assert.equal(s2.turn, 2);
  assert.equal(s2.endedAt, 0);
  assert.equal(M.elapsed(s2, 9000), '0:03', 'the clock restarts per turn');
  // the next turn wrote nothing: its done has the same step; it must not be deduped with the first
  assert.notEqual(M.eventKey(idleDone(1)), M.eventKey(idleDone(2)));
  assert.equal(M.applyEvent(s2, idleDone(2)).status, 'idle');
  // the user message never arrived on this socket: the update, then the done of turn 3 still move the run
  const lost = M.applyEvent(s, update(5));
  assert.equal(lost.status, 'live');
  assert.equal(M.applyEvent(s, idleDone(3)).turn, 3);
  // v1 behaviour is untouched
  const v1 = M.applyEvent(M.applyEvent(M.startRun(start), update(1)), done(true));
  assert.equal(v1.status, 'done');
  assert.equal(M.applyEvent(v1, msg('user', 2, 7000, 'more')).status, 'done', 'a finished run does not come back');
});

test('withMeta restores an idle v2 run with its conversation and icon', () => {
  const meta = { runId: 'r1', v2: true, status: 'idle', turn: 2, ok: true, summary: 'ok', updates: 4, startedAt: 1000, firstFrameAt: 1800, endedAt: 8000,
    icon: { emoji: '🏀', at: 3 }, messages: [msg('user', 1, 1000, 'a ball'), msg('assistant', 1, 4000, 'done')] };
  const s = M.withMeta(M.startRun(start), meta);
  assert.equal(s.status, 'idle');
  assert.equal(s.turn, 2);
  assert.equal(s.step, 4);
  assert.equal(s.messages.length, 2);
  assert.equal(s.icon.emoji, '🏀');
  assert.equal(M.withMeta(s, meta), s, 'idempotent');
  assert.equal(M.withMeta(M.startRun(start), { runId: 'r1', v2: true, status: 'running', turn: 2, messages: [] }).status, 'live');
});

test('icon: emoji, svg in the sandbox, fallback ⚡', () => {
  let s = M.startRun(v2start);
  assert.deepEqual(M.iconView(s), { text: '⚡', img: '' }, 'none suggested');
  s = M.applyEvent(s, { type: 'yolo-icon', runId: 'r1', icon: { svg: 'icon.svg', at: 5 }, at: 5 });
  assert.deepEqual(M.iconView(s), { text: '⚡', img: '/api/nodes/magix-system/yolo/r1/icon.svg' }, 'the bar draws the svg, the dock keeps text');
  const withEmoji = M.applyEvent(s, { type: 'yolo-icon', runId: 'r1', icon: { emoji: '🏀', svg: 'icon.svg', at: 6 } });
  assert.deepEqual(M.iconView(withEmoji), { text: '🏀', img: '' });
  assert.equal(M.applyEvent(withEmoji, { type: 'yolo-icon', runId: 'r1', icon: { emoji: '🏀', svg: 'icon.svg', at: 7 } }), withEmoji, 'same icon again');
  for (const bad of ['../x.svg', 'https://evil/x.svg', '//evil/x.svg']) assert.equal(M.iconView({ ...s, icon: { svg: bad } }).img, '', bad);
  assert.equal(M.applyEvent(s, { type: 'yolo-icon', runId: 'r1', icon: {} }), s, 'an empty icon changes nothing');
  assert.equal(M.iconView(M.startRun(start)).text, '⚡', 'a v1 run too');
  assert.equal(M.applyEvent(M.startRun(start), { type: 'yolo-icon', runId: 'r1', icon: { emoji: '🎲' } }).icon.emoji, '🎲', 'v1 runs suggest icons as well');
});

test('composerState: shown for v2 only, disabled while a turn runs or the run is over', () => {
  assert.equal(M.composerState(M.startRun(start)).shown, false);
  const live = M.startRun(v2start);
  assert.deepEqual([M.composerState(live).shown, M.composerState(live).disabled], [true, true]);
  const idle = M.applyEvent(live, idleDone(1));
  assert.equal(M.composerState(idle).disabled, false);
  assert.equal(M.composerState(idle, true).disabled, true, 'while sending');
  assert.equal(M.composerState({ ...idle, status: 'failed' }).disabled, true);
});

test('messageBody: a plain message, and feedback bundled with the page errors', () => {
  assert.deepEqual(M.messageBody({ text: '  bigger  ' }), { text: 'bigger' });
  assert.equal(M.canSendBody(M.messageBody({ text: '  ' })), false);
  const errs = [{ type: 'error', message: 'x is not defined', source: 'http://h/r1/game.js', line: 12 }, { type: 'unhandledrejection', message: 'boom' }];
  const b = M.messageBody({ text: 'ball sticks', errors: errs, feedback: true });
  assert.equal(b.text, 'ball sticks');
  assert.deepEqual(b.feedback.console, ['error: x is not defined (game.js:12)', 'unhandledrejection: boom']);
  assert.equal(b.feedback.text, 'ball sticks');
  const bare = M.messageBody({ errors: errs, feedback: true });
  assert.ok(bare.text && M.canSendBody(bare), 'errors alone are feedback');
  assert.equal(M.canSendBody(M.messageBody({ feedback: true })), true, 'a bare feedback still has the default line');
  assert.equal(M.messageBody({ errors: Array.from({ length: 50 }, (_, i) => ({ message: `e${i}` })), feedback: true }).feedback.console.length, M.FEEDBACK_MAX_CONSOLE);
  assert.equal(M.messageBody({ text: 'look', screenshot: 'data:image/png;base64,AA==' }).feedback.screenshot, 'data:image/png;base64,AA==');
  assert.equal(M.messageUrl(M.startRun(start)), '/api/nodes/magix-system/yolo/r1/message');
});

test('conversation visibility: saved choice per run, narrow default hidden, cap, junk tolerated', () => {
  assert.equal(M.convoHidden({}, 'r1', false), false, 'wide: shown');
  assert.equal(M.convoHidden({}, 'r1', true), true, 'narrow: collapsed by default');
  assert.equal(M.convoHidden({ r1: false }, 'r1', true), false, 'a saved choice beats the default');
  assert.equal(M.convoHidden({ r1: true }, 'r1', false), true);
  assert.equal(M.convoHidden({ r2: true }, 'r1', false), false, 'per window');
  const map = M.withConvoHidden({}, 'r1', true);
  assert.deepEqual(M.readHiddenMap(JSON.stringify(map)), { r1: true }, 'survives the localStorage round trip');
  let big = {};
  for (let i = 0; i < M.CONVO_CAP + 10; i++) big = M.withConvoHidden(big, `run${i}`, i % 2 === 0);
  assert.equal(Object.keys(big).length, M.CONVO_CAP);
  assert.ok(!('run0' in big) && 'run69' in big);
  for (const junk of ['', '{', 'null', '[1]', '7', undefined]) assert.deepEqual(M.readHiddenMap(junk), {}, String(junk));
  assert.deepEqual(M.readHiddenMap('{"a":true,"b":"x"}'), { a: true });
  assert.equal(M.convoToggle(true, 3).label, '💬 Show chat (3)');
  assert.equal(M.convoToggle(false).pressed, true);
});

test('turnStarted makes an idle run live on the next turn and leaves a live one alone', () => {
  const idle = M.applyEvent(M.startRun(v2start), idleDone(1));
  const t = M.turnStarted(idle, 2, 9000);
  assert.deepEqual([t.status, t.turn, t.endedAt, t.startedAt], ['live', 2, 0, 9000]);
  assert.equal(M.turnStarted(t, 3), t);
});

test('the window wires the conversation, composer, feedback, icon and toggle', () => {
  const ui = read('ui/src/yolo.js');
  for (const needle of ['messageUrl(', 'messageBody(', 'composerState(', 'convoHidden(', 'iconView(', 'win.setIcon', 'yolo-convo', 'Send feedback']) assert.ok(ui.includes(needle), needle);
  assert.ok(read('ui/src/wm.js').includes('setIcon'), 'wm.js lets a window change its icon (title bar + dock)');
  assert.ok(read('ui/src/styles.css').includes('.yolo-convo'), 'styles');
});
