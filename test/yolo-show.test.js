// Yolo apps surface in JARVIS only when asked: the pure show-request detection (src/yolo.js isYoloShowRequest), the
// flag carried through resolveYolo → createRun → yolo-start, the quiet reply that keeps the result reachable, the agent
// not being able to open things itself, and the UI gate (opens only on the requesting stream, only with show).
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';

process.env.RIGS_HOME = fs.mkdtempSync(path.join(os.tmpdir(), 'rigs-yolo-show-'));
const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const Y = await import('../src/yolo.js');
const M = await import('../ui/src/yolo-model.js');

test('isYoloShowRequest: an explicit ask to see the result', () => {
  for (const t of [
    'yolo a p5 sketch of the mesh and show it in JARVIS',
    'yolo it: a clock, open it here',
    'yolo a bouncing ball, then pop it up',
    'yolo a chart of my CPU history. Show it in a window.',
    'Yolo a pong game and show me',
    'yolo a todo list; open it in JARVIS',
    'yolo a starfield and bring it up on screen',
    'chart my CPU history, yolo it, and display it here',
    'yolo a clock — show the result',
    'in yolo mode build a timer and show it',
  ]) assert.equal(Y.isYoloShowRequest(t), true, t);
});

test('isYoloShowRequest: plain yolo requests and page descriptions are not show requests', () => {
  for (const t of [
    'yolo a p5 sketch of the mesh as orbiting planets',
    'chart my CPU history, yolo it',
    'yolo a chart that shows my CPU history',
    'yolo a sketch showing orbiting planets',
    'yolo an app that opens a file picker',
    'yolo a dashboard with a window per machine',
    'yolo a landing page with a show more button',
    'yolo a slideshow viewer',
    'in yolo mode make a tool that displays disk usage',
    '', null, undefined,
  ]) assert.equal(Y.isYoloShowRequest(t), false, String(t));
});

test('isYoloShowRequest: refusals and quiet asks win over the verb', () => {
  for (const t of [
    "yolo a clock, don't show it",
    'yolo a clock and do not open it',
    'yolo a clock without opening a window',
    'yolo a clock, no popup please',
    'yolo a clock and never pop it up',
    'yolo a clock silently, show it later',
    'yolo a clock in the background and show it',
  ]) assert.equal(Y.isYoloShowRequest(t), false, t);
});

test('isYoloShowRequest: words in the page description do not cancel an explicit show', () => {
  for (const t of [
    'yolo a timer with start and stop buttons and show it',
    'yolo a clock without seconds and show it in JARVIS',
    'yolo a starfield moving in the background and show it',
    'yolo a quietly pulsing orb and show it',
    'yolo a house with no windows and show it',
  ]) assert.equal(Y.isYoloShowRequest(t), true, t);
  for (const t of ['yolo a clock, stop showing windows', 'yolo a clock without showing it', 'quietly yolo a clock, show it later']) assert.equal(Y.isYoloShowRequest(t), false, t);
});

test('resolveYolo carries show: from the text, and a per-request show beats it', () => {
  const on = (text, show) => Y.resolveYolo({ text, show, settings: { enabled: true } });
  assert.equal(on('yolo a clock').show, false);
  assert.equal(on('yolo a clock and show it in JARVIS').show, true);
  assert.equal(on('yolo a clock', true).show, true);
  assert.equal(on('yolo a clock and show it', false).show, false);
  assert.equal(Y.resolveYolo({ text: 'a clock', override: true, settings: { enabled: false } }).show, false);
  assert.equal(Y.resolveYolo({ text: 'a clock, show it here', override: true, settings: {} }).show, true);
});

test('createRun: yolo-start has no show by default and show + target only when asked', async () => {
  const root = path.join(os.tmpdir(), `rigs-yolo-show-runs-${process.pid}`);
  const quiet = await Y.createRun({ text: 'yolo a clock', task: 'a clock', node: 'n', root });
  assert.equal('show' in quiet.startEvent, false);
  assert.equal('target' in quiet.startEvent, false);
  const loud = await Y.createRun({ text: 'yolo a clock, show it', task: 'a clock', node: 'n', show: true, root });
  assert.equal(loud.startEvent.show, true);
  assert.equal(loud.startEvent.target, 'requester');
  assert.equal(loud.meta.show, true);
  await Y.finishRun(quiet.runId, { ok: true }).catch(() => {});
  await Y.finishRun(loud.runId, { ok: true }).catch(() => {});
});

test('yoloWhere: a quiet run still says where its result is', () => {
  const w = Y.yoloWhere({ url: '/api/nodes/mac/yolo/y-1/', dir: '/h/yolo/y-1' });
  assert.match(w, /did not open a window/);
  assert.ok(w.includes('/api/nodes/mac/yolo/y-1/') && w.includes('/h/yolo/y-1'));
});

test('the agent cannot open a window, publish an app or notify every screen itself', () => {
  for (const t of ['mcp__rigs__ui_open', 'mcp__rigs__mesh_app_register', 'mcp__rigs__mesh_app_start', 'mcp__rigs__mesh_notify']) assert.ok(Y.YOLO_BLOCKED_TOOLS.includes(t), t);
});

test('UI gate: a window opens only for show, and only from the requesting stream', () => {
  const start = { type: 'yolo-start', runId: 'r1', title: 't', node: 'n', url: '/x/' };
  assert.equal(M.opensWindow(start, 'stream'), false, 'no auto-open by default');
  assert.equal(M.opensWindow(start, 'ws'), false);
  const shown = { ...start, show: true, target: 'requester' };
  assert.equal(M.opensWindow(shown, 'stream'), true, 'opens when asked, on the requester');
  assert.equal(M.opensWindow(shown, 'ws'), false, 'the mesh-wide push never opens it elsewhere');
  assert.equal(M.opensWindow(shown), false);
  assert.equal(M.opensWindow({ ...shown, type: 'yolo-update' }, 'stream'), false);
  assert.equal(M.opensWindow(null, 'stream'), false);
});

test('UI wiring: the stream path says so, the /ws path does not', () => {
  const main = fs.readFileSync(path.join(ROOT, 'ui/src/main.js'), 'utf8');
  assert.match(main, /onYoloEvent\(e, 'stream'\)/);
  assert.match(main, /onYoloEvent\(m\); \/\/ a YOLO run's window/);
  assert.match(fs.readFileSync(path.join(ROOT, 'ui/src/yolo.js'), 'utf8'), /opensWindow\(m, origin\)/);
});

test('yoloPrompt: a quiet run is told nothing is on screen; every run is told not to surface itself', () => {
  const base = { dir: '/r/y-1', base: 'http://127.0.0.1:4719/api/local/yolo/y-1/', model: 'm', maxTurns: 20, timeoutMs: 180000 };
  const shown = Y.yoloPrompt(base);
  assert.match(shown, /already shows \/r\/y-1\/index\.html in a live window/);
  const quiet = Y.yoloPrompt({ ...base, shown: false });
  assert.doesNotMatch(quiet, /already shows|window stays open|on screen now/);
  assert.match(quiet, /no window is open/);
  assert.match(quiet, /not on screen/);
  assert.doesNotMatch(Y.yoloPrompt({ ...base, shown: false, v2: true }), /window stays open/);
  for (const p of [shown, quiet]) assert.match(p, /Never open a window, publish an app or send a notice yourself/);
  const chat = fs.readFileSync(path.join(ROOT, 'src/chat.js'), 'utf8');
  assert.match(chat, /shown: run\.shown !== false/, 'yoloAgentTurn passes the run\'s shown flag');
  assert.match(chat, /shown: !!y\?\.show \}/, 'the first turn carries show from resolveYolo');
});
