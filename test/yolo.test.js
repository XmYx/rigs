// YOLO mode (src/yolo.js, chat.yoloTurn, the 'yolo' route): the marker, the router override (a YOLO request is never
// implement/plan/self; a request's yolo: false beats the text), settings and patching, sandbox path confinement, the
// injected client, the placeholder written before any model runs, debounced updates, the error channel, stop, and full
// runs with a stand-in `claude` — in process (events, trace, ledger, activeTurns) and through a real `rigs serve`
// (HTTP stream, WebSocket push, served files, an error the agent reads back, no project). Never the real ~/.rigs.
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import http from 'node:http';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { after, test } from 'node:test';
import { fileURLToPath, pathToFileURL } from 'node:url';
import WebSocket from 'ws';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const posix = process.platform !== 'win32';

// ---------------------------------------------------------------- a throwaway RIGS home and a stand-in `claude`
// It logs what it was started with (args, cwd, whether the placeholder page was already there), then plays the agent:
// FAKE_YOLO=page writes index.html + ball.js, reports a page error and reads the error list back like the prompt says;
// FAKE_YOLO=hang just waits (to be stopped).
const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'rigs-yolo-'));
const BIN = path.join(TMP, 'bin');
fs.mkdirSync(BIN);
const FAKE_LOG = path.join(TMP, 'claude-args.jsonl');
fs.writeFileSync(path.join(BIN, 'claude'), `#!${process.execPath}
const fs = require('node:fs');
const args = process.argv.slice(2);
if (args[0] === '--version') { console.log('9.9.9 (Claude Code)'); process.exit(0); }
const page = fs.existsSync('index.html') ? fs.readFileSync('index.html', 'utf8') : '';
const rec = { args, cwd: process.cwd(), placeholder: page.includes('content="placeholder"'), at: Date.now() };
const out = (o) => console.log(JSON.stringify(o));
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const tool = (name, input) => out({ type: 'assistant', session_id: 'yolo-sess', message: { content: [{ type: 'tool_use', id: 't' + Math.random(), name, input }] } });
(async () => {
  out({ type: 'system', subtype: 'init', session_id: 'yolo-sess' });
  const mode = process.env.FAKE_YOLO || 'page';
  if (mode === 'hang') { fs.appendFileSync(process.env.FAKE_CLAUDE_LOG, JSON.stringify(rec) + '\\n'); await sleep(60000); return; }
  if (args.includes('--resume')) {
    // a YOLOv2 follow-up: the same session changes the page and suggests an icon
    tool('Write', { file_path: 'ball.js' });
    fs.writeFileSync('ball.js', 'const c = document.getElementById("c"); const g = c.getContext("2d"); g.fillStyle = "red"; g.fillRect(10, 10, 40, 40);');
    fs.writeFileSync('icon.json', JSON.stringify({ emoji: '🔴' }));
    await sleep(350);
    fs.appendFileSync(process.env.FAKE_CLAUDE_LOG, JSON.stringify(rec) + '\\n');
    out({ type: 'result', session_id: 'yolo-sess', is_error: false, result: 'The ball is red and bigger now, sir.', usage: { input_tokens: 5, output_tokens: 4 } });
    return;
  }
  tool('Write', { file_path: 'index.html' });
  fs.writeFileSync('index.html', '<!doctype html><html><head><title>Ball</title></head><body><canvas id="c"></canvas><script src="ball.js"></script></body></html>');
  await sleep(350);
  tool('Write', { file_path: 'ball.js' });
  fs.writeFileSync('ball.js', 'const c = document.getElementById("c"); c.getContext("2d").fillRect(10, 10, 20, 20);');
  await sleep(350);
  // the page reports an error (as the injected client would) and the agent reads the list back (as the prompt says)
  const system = args[args.indexOf('--append-system-prompt') + 1] || '';
  const base = (system.match(/curl -s (\\S+)errors/) || [])[1];
  if (base) {
    try {
      await fetch(base + 'errors', { method: 'POST', headers: { 'content-type': 'text/plain' }, body: JSON.stringify({ type: 'error', message: 'ReferenceError: p5 is not defined', source: 'ball.js', line: 1 }) });
      tool('Bash', { command: 'curl -s ' + base + 'errors' });
      rec.errors = await (await fetch(base + 'errors')).json();
    } catch (e) { rec.fetchError = e.message; }
  }
  fs.appendFileSync(process.env.FAKE_CLAUDE_LOG, JSON.stringify(rec) + '\\n');
  const reply = 'A bouncing ball is on screen, sir.';
  const model = args[args.indexOf('--model') + 1];
  for (const part of reply.match(/.{1,6}/gs)) out({ type: 'stream_event', session_id: 'yolo-sess', event: { type: 'content_block_delta', delta: { type: 'text_delta', text: part } } });
  out({ type: 'result', session_id: 'yolo-sess', is_error: false, result: reply, total_cost_usd: 0.002,
    usage: { input_tokens: 20, output_tokens: 8 }, modelUsage: { [model]: { inputTokens: 20, outputTokens: 8 } } });
})();
`, { mode: 0o755 });
const HOME = path.join(TMP, 'rigs');
Object.assign(process.env, {
  RIGS_HOME: HOME, RIGS_NO_OPENRIG: '1', RIGS_NO_AUTOUPDATE: '1', RIGS_NO_MIGRATIONS: '1', RIGS_NAME: 'test-node',
  PATH: BIN + path.delimiter + process.env.PATH, FAKE_CLAUDE_LOG: FAKE_LOG,
});
let daemon = null;
after(() => { daemon?.kill(); Y._resetRuns(); fs.rmSync(TMP, { recursive: true, force: true }); });

const { config, saveConfig } = await import('../src/config.js');
const Y = await import('../src/yolo.js');
const K = await import('../src/yolo-keep.js');
const A = await import('../src/apps.js');
const R = await import('../src/router.js');
const chat = await import('../src/chat.js');
const usage = await import('../src/usage.js');
const trace = await import('../src/trace.js');

const fakeRuns = () => (fs.existsSync(FAKE_LOG) ? fs.readFileSync(FAKE_LOG, 'utf8').trim().split('\n').filter(Boolean).map((l) => JSON.parse(l)) : []);
const lastOf = async (kind) => (await usage.readRecords()).filter((r) => r.kind === kind).at(-1);
const setYolo = (patch) => { const c = config(); c.yolo = { ...c.yolo, ...patch }; saveConfig(c); };
const noRouter = async () => { throw new Error('the router must not run for a YOLO request'); };
const noWork = async () => { throw new Error('nothing is filed on the YOLO path'); };
const noSend = async () => { throw new Error('the full brain must not run'); };

// ---------------------------------------------------------------- the marker (pure)

const YES = [
  'yolo a p5 sketch of the mesh as orbiting planets', 'yolo it: chart my CPU history', 'chart my CPU history, yolo it',
  'make a bouncing ball in yolo mode', 'Jarvis, yolo a starfield', 'YOLO: a clock that ticks', 'just yolo this — a spinning cube',
  'hey jarvis yolo a sine wave', 'can you yolo a bouncing ball?', 'yolo mode: a fractal tree', 'please yolo a weather card for Budapest',
];
const NO = [
  'yellow', 'make the button yellow', 'you only live once', 'you only need one test', 'You Only Look Once is a detector',
  'what does yolo mean?', 'what is yolo mode?', 'how does yolo mode work', 'turn on yolo mode', 'switch yolo mode off', 'disable yolo',
  'rigs yolo off', 'yolo off', 'train a yolov8 model on my photos', 'yolo v8 object detection on the camera feed',
  'run yolo detection on these images', 'Yolanda sent the report', 'add a yolo mode to JARVIS', 'yolo', 'yolo it', '', null, undefined,
];

test('isYoloRequest: the word yolo as a mode marker — not yellow, "you only…", the vision model, questions or switching it', () => {
  for (const t of YES) assert.equal(Y.isYoloRequest(t), true, `should be YOLO: ${t}`);
  for (const t of NO) assert.equal(Y.isYoloRequest(t), false, `should not be YOLO: ${t}`);
  assert.equal(R.isYoloRequest, Y.isYoloRequest, 'the router exposes the same detector');
});

test('yoloTask / yoloTitle: the request without its marker, and a short title', () => {
  assert.equal(Y.yoloTask('yolo it: chart my CPU history'), 'chart my CPU history');
  assert.equal(Y.yoloTask('chart my CPU history, yolo it'), 'chart my CPU history');
  assert.equal(Y.yoloTask('make a bouncing ball in yolo mode'), 'make a bouncing ball');
  assert.equal(Y.yoloTask('Jarvis, yolo a p5 sketch of the mesh as orbiting planets'), 'a p5 sketch of the mesh as orbiting planets');
  assert.equal(Y.yoloTask('yolo mode: a fractal tree'), 'a fractal tree');
  assert.equal(Y.yoloTitle('chart my CPU history'), 'Chart my CPU history');
  assert.equal(Y.yoloTitle('a p5 sketch of the mesh as orbiting planets around the sun'), 'A p5 sketch of the mesh as orbiting…');
  assert.equal(Y.yoloTitle(''), 'YOLO');
});

test('resolveYolo: a request\'s yolo beats the text and config; the marker needs the mode on', () => {
  assert.equal(Y.resolveYolo({ text: 'yolo a starfield' }).on, true);
  assert.equal(Y.resolveYolo({ text: 'yolo a starfield' }).via, 'keyword');
  assert.deepEqual(Y.resolveYolo({ text: 'yolo a starfield', override: false }), { on: false, reason: 'yolo: false on this request' });
  assert.equal(Y.resolveYolo({ text: 'a bouncing ball in p5', override: true }).via, 'request', 'yolo: true without a marker');
  assert.equal(Y.resolveYolo({ text: 'a bouncing ball in p5', override: 'true' }).task, 'a bouncing ball in p5');
  assert.equal(Y.resolveYolo({ text: 'what time is it' }).on, false);
  assert.equal(Y.resolveYolo({ text: 'yolo a starfield', settings: { enabled: false } }).on, false, 'mode off: the marker is ignored');
  assert.equal(Y.resolveYolo({ text: 'a starfield', override: true, settings: { enabled: false } }).on, true, 'mode off: yolo: true still runs');
});

// ---------------------------------------------------------------- the router override

test('router: a YOLO request is decided before any engine and never becomes implement / plan / self / tool work', async () => {
  const asked = [];
  const engines = { jev: async (t) => { asked.push(t); return { route: 'implement', reason: 'jev says work' }; }, claude: async () => ({ route: 'plan' }) };
  const settings = R.routerSettings({ engine: 'jev', fallback: 'claude' });
  const ctx = { threads: [], projects: [], catalog: [], selfNode: 'test-node' };
  for (const text of ['yolo it: add a dark mode to the JARVIS dashboard', 'yolo a script to check disk on every machine', 'build the RIGS router a new view, yolo it']) {
    const d = await R.route(text, { ...ctx }, { settings, engines });
    assert.equal(d.route, 'yolo', text);
    assert.equal(d.work, undefined, 'nothing to file');
  }
  assert.deepEqual(asked, [], 'no engine was asked');
  // withWork on its own (the engines' decision for a YOLO text): yolo wins over the guard, self binding and tool work
  const w = R.withWork({ route: 'implement', work: [{ goal: 'x', workspace: 'rigs' }], threadId: 't1' }, 'yolo it: add a dark mode to the JARVIS dashboard', { selfNode: 'test-node' });
  assert.deepEqual([w.route, w.work, w.threadId], ['yolo', undefined, undefined]);
  // a model naming yolo for a request that isn't one is not trusted
  assert.notEqual(R.withWork({ route: 'yolo' }, 'what time is it?', {}).route, 'yolo');
});

test('router: yolo: false on the request beats the text (today\'s routing), and without a marker nothing changes', async () => {
  const engines = { jev: async () => ({ route: 'implement', reason: 'jev says work' }) };
  const settings = R.routerSettings({ engine: 'jev', fallback: 'rules' });
  const off = await R.route('yolo it: add a dark mode to the JARVIS dashboard', { threads: [], projects: [], catalog: [], selfNode: 'test-node', yolo: false }, { settings, engines });
  assert.equal(off.route, 'implement');
  assert.equal(off.work?.[0]?.self, true, 'bound as a RIGS change, as before');
  const plain = await R.route('add a dark mode to the JARVIS dashboard', { threads: [], projects: [], catalog: [], selfNode: 'test-node' }, { settings, engines });
  assert.equal(plain.route, 'implement');
  assert.deepEqual(R.heuristicRoute('make the button yellow'), { route: 'implement', reason: 'an imperative work request' });
  assert.ok(R.ROUTES.includes('yolo'));
  assert.equal(R.parseDecision('{"route":"yolo"}')?.route, 'yolo', 'a parsed yolo pick reaches withWork, which drops it (above)');
});

// ---------------------------------------------------------------- settings (pure)

test('yoloSettings / applyYoloPatch: defaults, validation, a fixed sandbox root', () => {
  const d = Y.yoloSettings();
  assert.deepEqual([d.enabled, d.provider, d.model, d.effort, d.maxTurns, d.timeoutMs, d.keep], [true, 'claude', 'claude-sonnet-5-5', 'low', 20, 180000, 200]);
  assert.equal(d.root, path.join(HOME, 'yolo'));
  const s = Y.yoloSettings({ enabled: 'off', provider: 'codex', effort: 'turbo', maxTurns: 999, timeoutMs: 5, model: '  ' });
  assert.deepEqual([s.enabled, s.provider, s.effort, s.maxTurns, s.timeoutMs, s.model], [false, 'claude', 'low', 100, 10000, 'claude-sonnet-5-5']);
  assert.deepEqual(Y.applyYoloPatch({}, { enabled: false }), { enabled: false, provider: 'claude', model: 'claude-sonnet-5-5', effort: 'low', maxTurns: 20, timeoutMs: 180000, keep: 200, v2: false });
  assert.equal(Y.applyYoloPatch({ enabled: false }, { model: 'claude-haiku-5-5', effort: 'medium' }).effort, 'medium');
  for (const [b, re] of [[{ enabled: 'maybe' }, /enabled/], [{ provider: 'ollama' }, /provider/], [{ effort: 'turbo' }, /effort/], [{ model: '' }, /model/], [{ maxTurns: 'lots' }, /maxTurns/], [{ root: '/tmp' }, /fixed/], [[], /expected/]]) {
    assert.throws(() => Y.applyYoloPatch({}, b), re);
  }
  assert.deepEqual([Y.yoloOverride(undefined), Y.yoloOverride(''), Y.yoloOverride('on'), Y.yoloOverride(false), Y.yoloOverride('nah')], [undefined, undefined, true, false, undefined]);
});

// ---------------------------------------------------------------- the sandbox (pure)

test('confinePath: stays inside the sandbox — no .., encoded .., dot-files, NUL or absolute escapes', () => {
  const root = path.join(TMP, 'box');
  assert.equal(Y.confinePath(root, ''), path.join(root, 'index.html'));
  assert.equal(Y.confinePath(root, 'js/app.js'), path.join(root, 'js', 'app.js'));
  assert.equal(Y.confinePath(root, 'sub/'), path.join(root, 'sub', 'index.html'));
  assert.equal(Y.confinePath(root, '/etc/passwd'), path.join(root, 'etc', 'passwd'), 'a leading slash is still inside');
  assert.equal(Y.confinePath(root, 'my%20page.html'), path.join(root, 'my page.html'));
  for (const bad of ['../x', 'a/../../x', '..%2Fx', '%2e%2e/x', '%2e%2e%2f%2e%2e%2fconfig.json', '..\\x', 'a\\..\\..\\x', '.yolo/meta', '.git/config', 'sub/.env', 'x%00.html', '%E0%A4%A']) {
    assert.equal(Y.confinePath(root, bad), null, bad);
  }
  assert.ok(Y.isRunId(Y.newRunId()));
  assert.equal(Y.isRunId('../etc'), false);
});

test('opaqueOriginRefused: a YOLO page (Origin: null) may read, report its errors and use apps — never write blind or open a socket', () => {
  const R = (o) => Y.opaqueOriginRefused({ origin: 'null', ...o });
  const id = 'y-20261020-120000-abcdef';
  for (const p of ['/api/local/jarvis/send', '/api/local/yolo/config', '/api/local/config', `/api/local/yolo/${id}/stop`, `/api/local/yolo/${id}/keep`, `/api/nodes/peer/yolo/${id}/keep`, '/api/nodes/peer/jarvis/send', `/api/local/yolo/${id}/errors/x`]) {
    assert.equal(R({ method: 'POST', pathname: p }), true, p);
  }
  assert.equal(R({ method: 'PUT', pathname: '/api/local/x' }), true);
  for (const p of ['/ws', '/api/local/pty/abc/ws', '/api/local/screen/stream']) assert.equal(R({ upgrade: true, pathname: p }), true, p);
  assert.equal(R({ method: 'POST', pathname: `/api/local/yolo/${id}/errors` }), false, 'its own error reports');
  assert.equal(R({ method: 'POST', pathname: `/api/nodes/peer/yolo/${id}/errors` }), false, 'through the node path too');
  assert.equal(R({ method: 'GET', pathname: '/api/local/config' }), false, 'reads: CORS already blocks them');
  assert.equal(R({ method: 'POST', pathname: '/api/nodes/peer/apps/krea/run' }), false, 'App Cloud apps decide for themselves');
  assert.equal(R({ upgrade: true, pathname: '/api/nodes/peer/apps/krea/ws' }), false);
  // any real origin, or none (CLI, MCP, peers), is not this check's business
  for (const origin of [undefined, '', 'http://127.0.0.1:4719', 'https://evil.example']) assert.equal(Y.opaqueOriginRefused({ origin, method: 'POST', pathname: '/api/local/jarvis/send' }), false, String(origin));
});

test('injectClient: first in <head>, prefix per folder, relative scripts get crossorigin, CDN scripts do not', () => {
  const page = '<!doctype html><html><head><title>x</title><script src="https://cdn.jsdelivr.net/npm/p5@1.11.3/lib/p5.min.js"></script></head><body><script src="sketch.js"></script><script>1</script></body></html>';
  const out = Y.injectClient(page, { prefix: '', step: 3 });
  assert.ok(out.indexOf('__yolo/client.js') < out.indexOf('p5.min.js'), 'before every other script');
  assert.match(out, /<head><script src="__yolo\/client\.js" data-step="3"><\/script>/);
  assert.match(out, /<script src="sketch\.js" crossorigin>/);
  assert.match(out, /<script src="https:\/\/cdn\.jsdelivr\.net[^>]*"><\/script>/, 'CDN script unchanged');
  assert.match(out, /<script>1<\/script>/);
  assert.match(Y.injectClient('<p>bare</p>', { prefix: '../' }), /^<script src="\.\.\/__yolo\/client\.js"/);
  assert.match(Y.injectClient('<html><body>x</body></html>'), /^<html><script src="__yolo/);
  assert.match(Y.CLIENT_JS, /unhandledrejection/);
  assert.match(Y.CLIENT_JS, /console\.error = /);
  assert.match(Y.CLIENT_JS, /__yolo\/events/);
  assert.ok(Y.isPlaceholder(Y.placeholderHtml({ title: '<b>x</b>' })));
  assert.doesNotMatch(Y.placeholderHtml({ title: '<b>x</b>' }), /<b>x<\/b>/, 'the title is escaped');
});

test('yoloPrompt: page first, relative assets, the error check, no git / filing, one spoken line', () => {
  const p = Y.yoloPrompt({ dir: '/r/y-1', base: 'http://127.0.0.1:4719/api/local/yolo/y-1/', model: 'claude-sonnet-5-5', maxTurns: 20, timeoutMs: 180000 });
  for (const re of [/index\.html/, /first frame/, /relative path/, /cdn\.jsdelivr\.net/, /python3/, /curl -s http:\/\/127\.0\.0\.1:4719\/api\/local\/yolo\/y-1\/errors/, /never run git/, /jarvis_task/, /rigs_propose/, /ONE short spoken line/]) assert.match(p, re);
  assert.ok(Y.YOLO_BLOCKED_TOOLS.includes('mcp__rigs__jarvis_task') && Y.YOLO_BLOCKED_TOOLS.includes('mcp__rigs__project_create') && Y.YOLO_BLOCKED_TOOLS.includes('mcp__rigs__rigs_propose') && Y.YOLO_BLOCKED_TOOLS.includes('Bash(git:*)'));
});

// ---------------------------------------------------------------- run lifecycle and serving (a tiny server over Y.handle)

const readJson = async (req) => { let s = ''; for await (const c of req) s += c; return s ? JSON.parse(s) : {}; };
function sandboxServer(root) {
  const srv = http.createServer(async (req, res) => {
    const u = new URL(req.url, 'http://x');
    const m = u.pathname.match(/^\/yolo\/([^/]+)(?:\/([\s\S]*))?$/);
    try {
      if (!m) throw Object.assign(new Error('no'), { status: 404 });
      const out = await Y.handle(req, res, m[1], m[2], { query: u.searchParams, body: () => readJson(req), root });
      if (out !== undefined && !res.headersSent) { res.writeHead(200, { 'content-type': 'application/json' }); res.end(JSON.stringify(out)); }
    } catch (e) { if (!res.headersSent) { res.writeHead(e.status || 500, { 'content-type': 'application/json' }); res.end(JSON.stringify({ error: e.message })); } }
  });
  return new Promise((r) => srv.listen(0, '127.0.0.1', () => r({ srv, base: `http://127.0.0.1:${srv.address().port}` })));
}
const rawGet = (base, p) => new Promise((resolve, reject) => {
  const u = new URL(base);
  http.get({ host: u.hostname, port: u.port, path: p }, (res) => { let b = ''; res.on('data', (d) => { b += d; }); res.on('end', () => resolve({ status: res.statusCode, headers: res.headers, body: b })); }).on('error', reject);
});

test('prune: an unfinished YOLOv2 run (running or idle, live or only on disk) is never deleted; finished runs are, and stop watching', async () => {
  const root = path.join(TMP, 'runs-prune');
  fs.mkdirSync(root, { recursive: true });
  // Runs from before a restart (meta on disk, not live here): a finished v1, an idle v2 (revivable), an interrupted v2, a failed v1.
  const mk = (sec, meta) => {
    const id = Y.newRunId(new Date(Date.UTC(2020, 0, 1, 0, 0, sec)));
    fs.mkdirSync(path.join(root, id));
    fs.writeFileSync(path.join(root, id, 'index.html'), '<html>');
    fs.writeFileSync(path.join(root, `${id}.json`), JSON.stringify({ runId: id, ...meta }));
    return id;
  };
  const oldDone = mk(1, { status: 'done' });
  const oldIdleV2 = mk(2, { status: 'idle', v2: true, sessionId: 's-old' });
  const oldRunningV2 = mk(3, { status: 'running', v2: true, sessionId: 's-old2' });
  const oldFailed = mk(4, { status: 'failed' });
  // Live runs in this daemon: a finished v1, an idle v2 (its window is open, Sir may still send feedback), a running v2.
  const finished = await Y.createRun({ text: 'yolo a', root, keep: 1000 });
  assert.ok(Y._isWatching(finished.runId), 'a running run watches its sandbox');
  await Y.finishRun(finished.runId, { ok: true, summary: 'done' });
  assert.equal(Y._isWatching(finished.runId), false, 'finished: the recursive watcher is closed');
  const idle = await Y.createRun({ text: 'yolo b', root, keep: 1000, v2: true });
  Y.setSession(idle.runId, 'sess-b');
  await Y.endTurn(idle.runId, { ok: true, summary: 'first turn', reply: 'Here, sir.' });
  assert.equal((await Y.getRun(idle.runId, root)).status, 'idle');
  assert.ok(Y._isWatching(idle.runId), 'an idle v2 run keeps watching: the next turn writes here');
  const running = await Y.createRun({ text: 'yolo c', root, keep: 1000, v2: true });
  const removed = await Y._prune(root, 0);
  assert.deepEqual(removed.sort(), [oldDone, oldFailed, finished.runId].sort(), 'only finished runs go, however old');
  for (const id of [oldIdleV2, oldRunningV2, idle.runId, running.runId]) {
    assert.ok(fs.existsSync(path.join(root, id)) && fs.existsSync(path.join(root, `${id}.json`)), `${id} kept`);
  }
  for (const id of removed) assert.ok(!fs.existsSync(path.join(root, id)) && !fs.existsSync(path.join(root, `${id}.json`)), `${id} removed`);
  assert.equal(await Y.getRun(finished.runId, root), null, 'a pruned run is forgotten');
  // Kept as an app: nothing writes to the sandbox until a follow-up turn, so the watcher closes; beginTurn opens it again.
  await Y.markKept(idle.runId, { id: 'kept-b', node: 'test-node', path: '/apps/kept-b/' }, root);
  assert.equal(Y._isWatching(idle.runId), false, 'kept: not watching');
  const begun = await Y.beginTurn(idle.runId, { text: 'make it blue' }, { root });
  assert.equal(begun.turn, 2);
  assert.ok(Y._isWatching(idle.runId), 'a new turn watches again');
  await Y.endTurn(idle.runId, { ok: true, summary: 'blue now' });
  // createRun's own prune (keep - 1) honours the same rule: 3 unfinished + 2 on disk stay with keep 1.
  const another = await Y.createRun({ text: 'yolo d', root, keep: 1 });
  for (const id of [oldIdleV2, oldRunningV2, idle.runId, running.runId, another.runId]) assert.ok(fs.existsSync(path.join(root, id)), `${id} still there`);
  await Y.finishRun(another.runId, { ok: true });
  await Y.finishRun(running.runId, { ok: false, summary: 'x' });
  Y._resetRuns();
  assert.equal(Y._isWatching(idle.runId), false, '_resetRuns closes every watcher');
});

test('createRun: the placeholder page and yolo-start exist before anything else runs; writes become debounced updates', async () => {
  const root = path.join(TMP, 'runs-a');
  const seen = [];
  const listen = (e) => seen.push(e);
  Y.events.on('event', listen);
  try {
    const run = await Y.createRun({ text: 'yolo a starfield', task: 'a starfield', node: 'test-node', root });
    assert.ok(Y.isRunId(run.runId));
    assert.equal(run.dir, path.join(root, run.runId));
    assert.ok(Y.isPlaceholder(fs.readFileSync(path.join(run.dir, 'index.html'), 'utf8')), 'placeholder on disk when createRun returns');
    assert.deepEqual([run.startEvent.type, run.startEvent.url, run.startEvent.localUrl, run.startEvent.title], ['yolo-start', `/api/nodes/test-node/yolo/${run.runId}/`, `/api/local/yolo/${run.runId}/`, 'A starfield']);
    assert.deepEqual(seen.map((e) => e.type), ['yolo-start'], 'emitted on the bus too, with no update for the placeholder');
    const mine = [];
    Y.onRun(run.runId, (e) => mine.push(e));
    // the placeholder reported late (macOS FSEvents does that for the write right before the watch): no update, no first frame
    fs.writeFileSync(path.join(run.dir, 'index.html'), fs.readFileSync(path.join(run.dir, 'index.html')));
    await sleep(Y.YOLO_DEBOUNCE_MS + 250);
    assert.equal(mine.filter((e) => e.type === 'yolo-update').length, 0, 'the placeholder is not an update');
    assert.equal((await Y.getRun(run.runId, root)).firstFrameAt, null, 'nor the first frame');
    Y.setActivity(run.runId, 'Write index.html');
    for (const f of ['index.html', 'a.js', 'b.json']) fs.writeFileSync(path.join(run.dir, f), f);
    fs.writeFileSync(path.join(run.dir, '.hidden'), 'x');
    await sleep(Y.YOLO_DEBOUNCE_MS + 250);
    const ups = mine.filter((e) => e.type === 'yolo-update');
    assert.equal(ups.length, 1, 'three quick writes = one update');
    assert.deepEqual([ups[0].step, [...ups[0].files].sort(), ups[0].activity], [1, ['a.js', 'b.json', 'index.html'], 'Write index.html']);
    fs.mkdirSync(path.join(run.dir, 'data'));
    fs.writeFileSync(path.join(run.dir, 'data', 'cpu.json'), '[]');
    const done = await Y.finishRun(run.runId, { ok: true, summary: 'A starfield, sir.' });
    assert.equal(done.type, 'yolo-done');
    assert.equal(done.ok, true);
    assert.ok(done.step >= 2, 'the last writes are flushed before done');
    assert.equal(typeof done.timeToFirstFrameMs, 'number');
    const meta = await Y.getRun(run.runId, root);
    assert.deepEqual([meta.status, meta.ok, meta.updates >= 2], ['done', true, true]);
    assert.equal((await Y.listRuns({ root }))[0].runId, run.runId);
  } finally { Y.events.off('event', listen); }
});

test('serving: confined files, injected client, sandbox headers, 308 to the slash, errors in and out, stop', async () => {
  const root = path.join(TMP, 'runs-b');
  const { srv, base } = await sandboxServer(root);
  try {
    const run = await Y.createRun({ text: 'yolo a ball', root });
    fs.writeFileSync(path.join(root, 'secret.txt'), 'top secret');
    fs.mkdirSync(path.join(run.dir, 'sub'));
    fs.writeFileSync(path.join(run.dir, 'sub', 'page.html'), '<html><head></head><body><script src="x.js"></script></body></html>');
    fs.writeFileSync(path.join(run.dir, 'data.json'), '{"cpu":[1,2]}');
    if (posix) fs.symlinkSync(path.join(root, 'secret.txt'), path.join(run.dir, 'link.txt'));
    const idx = await rawGet(base, `/yolo/${run.runId}/`);
    assert.equal(idx.status, 200);
    assert.match(idx.body, /content="placeholder"/);
    assert.match(idx.body, /<head><script src="__yolo\/client\.js"/);
    assert.match(idx.headers['content-security-policy'], /^sandbox allow-scripts/);
    assert.doesNotMatch(idx.headers['content-security-policy'], /allow-same-origin/, 'opaque origin: the page cannot read the JARVIS API');
    assert.equal(idx.headers['access-control-allow-origin'], '*');
    assert.match((await rawGet(base, `/yolo/${run.runId}/sub/page.html`)).body, /<script src="\.\.\/__yolo\/client\.js"/);
    const data = await rawGet(base, `/yolo/${run.runId}/data.json`);
    assert.deepEqual([data.status, data.headers['content-type'], data.body], [200, 'application/json; charset=utf-8', '{"cpu":[1,2]}']);
    const redirect = await rawGet(base, `/yolo/${run.runId}`);
    assert.deepEqual([redirect.status, redirect.headers.location], [308, `${run.runId}/`]);
    for (const p of [`/yolo/${run.runId}/..%2Fsecret.txt`, `/yolo/${run.runId}/%2e%2e%2fsecret.txt`, `/yolo/${run.runId}/.hidden`, ...(posix ? [`/yolo/${run.runId}/link.txt`] : [])]) {
      const r = await rawGet(base, p);
      assert.equal(r.status, 403, p);
      assert.doesNotMatch(r.body, /top secret/);
    }
    assert.equal((await rawGet(base, `/yolo/${run.runId}/nope.js`)).status, 404);
    assert.equal((await rawGet(base, '/yolo/not-a-run/')).status, 400);
    const client = await rawGet(base, `/yolo/${run.runId}/__yolo/client.js`);
    assert.deepEqual([client.status, client.headers['content-type']], [200, 'text/javascript; charset=utf-8']);
    // the page posts errors (text/plain, as the client does), the agent reads them back
    const post = (b) => fetch(`${base}/yolo/${run.runId}/errors`, { method: 'POST', headers: { 'content-type': 'text/plain' }, body: JSON.stringify(b) }).then((r) => r.json());
    assert.deepEqual(await post({ type: 'error', message: 'TypeError: x is undefined', source: 'x.js', line: 3, col: 7 }), { ok: true, seq: 1 });
    assert.deepEqual(await post({ type: 'weird', message: 'y'.repeat(5000) }), { ok: true, seq: 2 });
    const errs = await (await fetch(`${base}/yolo/${run.runId}/errors`)).json();
    assert.deepEqual([errs.total, errs.errors.map((e) => e.type), errs.errors[0].message, errs.errors[1].message.length], [2, ['error', 'error'], 'TypeError: x is undefined', 2000]);
    assert.deepEqual((await (await fetch(`${base}/yolo/${run.runId}/errors?after=1`)).json()).errors.map((e) => e.seq), [2]);
    const opt = await fetch(`${base}/yolo/${run.runId}/errors`, { method: 'OPTIONS' });
    assert.equal(opt.status, 204);
    // stop: aborts the attached controller
    const ac = new AbortController();
    Y.attachAbort(run.runId, ac);
    assert.deepEqual(await (await fetch(`${base}/yolo/${run.runId}/stop`, { method: 'POST' })).json(), { ok: true, stopped: true });
    assert.equal(ac.signal.aborted, true);
    await Y.finishRun(run.runId, { ok: false, summary: 'stopped' });
    assert.equal((await Y.getRun(run.runId, root)).status, 'stopped');
    assert.equal((await (await fetch(`${base}/yolo/${run.runId}/meta`)).json()).status, 'stopped');
  } finally { srv.close(); }
});

test('events stream: hello with the step, update on a write, done at the end', async () => {
  const root = path.join(TMP, 'runs-c');
  const { srv, base } = await sandboxServer(root);
  try {
    const run = await Y.createRun({ text: 'yolo a ball', root });
    const ac = new AbortController();
    const r = await fetch(`${base}/yolo/${run.runId}/__yolo/events`, { signal: ac.signal });
    assert.equal(r.headers.get('content-type'), 'text/event-stream; charset=utf-8');
    let text = '';
    const reader = r.body.getReader();
    const pump = (async () => { try { for (;;) { const { value, done } = await reader.read(); if (done) break; text += Buffer.from(value).toString(); } } catch {} })();
    await sleep(100);
    fs.writeFileSync(path.join(run.dir, 'index.html'), '<p>frame</p>');
    await sleep(Y.YOLO_DEBOUNCE_MS + 250);
    await Y.finishRun(run.runId, { ok: true });
    await pump;
    assert.match(text, /event: hello\ndata: \{"runId":"[^"]+","step":0,"status":"running"\}/);
    assert.match(text, /event: update\ndata: .*"file":"index\.html"/);
    assert.match(text, /event: done\ndata: .*"ok":true/);
  } finally { srv.close(); }
});

// ---------------------------------------------------------------- full runs (jarvisSend → yoloTurn → stand-in claude)

test('a YOLO request end to end: route yolo, placeholder before the model, live updates, done — no router, no work, no project', { skip: !posix && 'stand-in claude is a POSIX script' }, async () => {
  setYolo({ enabled: true });
  fs.rmSync(FAKE_LOG, { force: true });
  process.env.FAKE_YOLO = 'page';
  const events = [];
  let midRun = null;
  const intake = trace.startSpan({ kind: 'intake', name: 'jarvis/send', input: 'yolo a bouncing ball in p5' });
  const out = await chat.jarvisSend('yolo a bouncing ball in p5', {}, (e) => {
    events.push(e);
    if (e.type === 'yolo-update' && !midRun) midRun = [...chat.activeTurns.values()].find((t) => t.runId === e.runId) || null;
  }, { router: noRouter, onWork: noWork, send: noSend, sendQuick: noSend, trace: intake.ctx });
  intake.end({ status: 'ok' });
  assert.equal(out.text, 'A bouncing ball is on screen, sir.');
  const types = events.map((e) => e.type);
  const runId = events.find((e) => e.type === 'yolo-start').runId;
  assert.ok(types.indexOf('route') < types.indexOf('yolo-start') && types.indexOf('yolo-start') < types.indexOf('start'), `order: ${types.join(' ')}`);
  const route = events.find((e) => e.type === 'route');
  assert.deepEqual(route, { type: 'route', route: 'yolo', reason: 'a YOLO marker in the request', via: 'keyword', preroute: true, chatId: route.chatId, title: 'JARVIS', projectId: '', continued: false, work: [], unclear: [] });
  assert.deepEqual(events.find((e) => e.type === 'start'), { type: 'start', brain: 'claude', model: 'claude-sonnet-5-5', effort: 'low', lane: 'yolo', runId });
  const ups = events.filter((e) => e.type === 'yolo-update');
  assert.ok(ups.length >= 2, 'one update per burst of writes');
  assert.ok(ups.some((u) => u.files.includes('index.html')) && ups.some((u) => u.files.includes('ball.js')));
  assert.deepEqual(events.filter((e) => e.type === 'tool').map((e) => e.name).slice(0, 2), ['Write', 'Write'], 'the agent\'s steps are in the stream');
  const done = events.find((e) => e.type === 'yolo-done');
  assert.deepEqual([done.ok, done.runId, typeof done.timeToFirstFrameMs], [true, runId, 'number']);
  assert.ok(types.indexOf('yolo-done') < types.indexOf('done'));
  assert.deepEqual([events.find((e) => e.type === 'done').lane, events.find((e) => e.type === 'done').runId], ['yolo', runId]);
  assert.equal(midRun?.lane, 'yolo', 'listed in activeTurns with lane yolo while it runs');
  assert.equal([...chat.activeTurns.values()].some((t) => t.runId === runId), false, 'and gone after');
  // the model was started in the sandbox, after the placeholder was there, fresh, bounded, without the filing tools
  const [run] = fakeRuns();
  assert.equal(run.cwd, fs.realpathSync(path.join(HOME, 'yolo', runId)));
  assert.equal(run.placeholder, true, 'the placeholder page existed before the model process started');
  const arg = (k) => run.args[run.args.indexOf(k) + 1];
  assert.deepEqual([arg('--model'), arg('--effort'), arg('--max-turns')], ['claude-sonnet-5-5', 'low', '20']);
  assert.ok(!run.args.includes('--resume'));
  assert.match(arg('--disallowedTools'), /mcp__rigs__jarvis_task.*mcp__rigs__project_create.*mcp__rigs__rigs_propose.*Bash\(git:\*\)/);
  assert.match(arg('--append-system-prompt'), /# YOLO mode[\s\S]*curl -s http:\/\/127\.0\.0\.1:\d+\/api\/local\/yolo\/y-[\w-]+\/errors/);
  assert.equal(run.args[1], 'a bouncing ball in p5', 'the model gets the task without the marker');
  // served: the agent's page, not the placeholder
  assert.doesNotMatch(fs.readFileSync(path.join(HOME, 'yolo', runId, 'index.html'), 'utf8'), /placeholder/);
  // nothing filed, planned or proposed
  assert.equal(fs.existsSync(path.join(HOME, 'projects')) ? fs.readdirSync(path.join(HOME, 'projects')).length : 0, 0, 'no project');
  // trace: a router span with route yolo, a brain-turn span with lane yolo
  await trace.flush();
  const spans = await trace.readSpans({ traceId: intake.traceId });
  const router = spans.find((s) => s.kind === 'router');
  assert.deepEqual([router.meta.route, router.output.route, router.meta.via], ['yolo', 'yolo', 'keyword']);
  const bt = spans.find((s) => s.kind === 'brain-turn');
  assert.deepEqual([bt.meta.lane, bt.meta.runId, bt.meta.model, bt.status], ['yolo', runId, 'claude-sonnet-5-5', 'ok']);
  assert.ok(spans.filter((s) => s.kind === 'tool-call' && s.parentId === bt.spanId).length >= 2, 'tool calls as child spans');
  assert.ok(!spans.some((s) => s.kind === 'handoff' || s.kind === 'plan'), 'no handoff or plan');
  // ledger: the request with lane yolo, the run and time to first frame; the turn with lane yolo
  const req = await lastOf('request');
  assert.deepEqual([req.request.route, req.request.lane, req.request.runId, req.status], ['yolo', 'yolo', runId, 'done']);
  assert.equal(typeof req.request.timeToFirstFrameMs, 'number');
  assert.ok(req.request.timeToFirstFrameMs <= req.request.timeToReplyMs);
  assert.match(req.outcome, /YOLO run y-.*first frame after \d+ ms/);
  const turn = await lastOf('chat-turn');
  assert.deepEqual([turn.lane, turn.provider, turn.model], ['yolo', 'claude', 'claude-sonnet-5-5']);
  const timing = events.find((e) => e.type === 'timing');
  assert.deepEqual([timing.lane, timing.runId, typeof timing.timeToFirstFrameMs], ['yolo', runId, 'number']);
  // the JARVIS thread keeps the exchange
  const main = await chat.mainChat();
  assert.deepEqual(main.messages.slice(-2).map((m) => [m.role, m.lane || '', m.runId || '']), [['user', '', ''], ['assistant', 'yolo', runId]]);
});

test('yolo: false on a request with a marker = today\'s path; yolo: true without one = a YOLO run', { skip: !posix && 'stand-in claude is a POSIX script' }, async () => {
  const routed = [];
  const router = async (t, ctx) => { routed.push([t, ctx.yolo]); return { route: 'answer', via: 'rules', reason: 'a question' }; };
  const quick = [];
  const out = await chat.jarvisSend('yolo a bouncing ball in p5', {}, () => {}, { yolo: false, router, sendQuick: async (id, text) => { quick.push(text); return { text: 'Quick here.' }; }, send: noSend });
  assert.equal(out.text, 'Quick here.');
  assert.deepEqual(routed, [['yolo a bouncing ball in p5', false]], 'the router ran, told yolo: false');
  assert.equal(quick.length, 1);
  const runs = [];
  const r2 = await chat.jarvisSend('a bouncing ball in p5', {}, () => {}, { yolo: true, router: noRouter, sendYolo: async (id, text, y) => { runs.push([text, y.via]); return { text: 'ok', runId: 'y-1' }; } });
  assert.equal(r2.text, 'ok');
  assert.deepEqual(runs, [['a bouncing ball in p5', 'request']]);
  // the mode switched off: the marker is ignored
  setYolo({ enabled: false });
  const routed2 = [];
  await chat.jarvisSend('yolo a starfield', {}, () => {}, { router: async (t) => { routed2.push(t); return { route: 'answer', via: 'rules' }; }, sendQuick: async () => ({ text: 'q' }), sendYolo: noSend });
  assert.deepEqual(routed2, ['yolo a starfield']);
  setYolo({ enabled: true });
});

test('stop: POST …/stop ends a running agent; yolo-done says ok: false and the reply says so', { skip: !posix && 'stand-in claude is a POSIX script' }, async () => {
  process.env.FAKE_YOLO = 'hang';
  const events = [];
  const t0 = Date.now();
  const out = await chat.jarvisSend('yolo a slow fractal', {}, (e) => {
    events.push(e);
    if (e.type === 'start' && e.lane === 'yolo') setTimeout(() => Y.stopRun(e.runId), 300);
  }, { router: noRouter, onWork: noWork, send: noSend });
  process.env.FAKE_YOLO = 'page';
  assert.ok(Date.now() - t0 < 20000, 'it did not wait for the agent');
  const done = events.find((e) => e.type === 'yolo-done');
  assert.equal(done.ok, false);
  assert.equal((await Y.getRun(done.runId)).status, 'stopped');
  assert.match(out.text, /Stopped, sir/);
  assert.equal(events.filter((e) => e.type === 'error').length, 0, 'a stop is not an error');
});

// ---------------------------------------------------------------- through a real daemon: HTTP stream, WebSocket, served files

test('daemon: jarvis/send {yolo: true} → window URL at once, updates on /ws, the page served, an error the agent read back, no project', { skip: !posix && 'stand-in claude is a POSIX script' }, async () => {
  const PORT = await new Promise((resolve) => { const s = net.createServer().listen(0, '127.0.0.1', () => { const { port } = s.address(); s.close(() => resolve(port)); }); });
  const BASE = `http://127.0.0.1:${PORT}`;
  const DHOME = path.join(TMP, 'daemon-home');
  fs.rmSync(FAKE_LOG, { force: true });
  const env = { ...process.env, RIGS_HOME: DHOME, RIGS_SSH_DIR: path.join(DHOME, 'ssh'), RIGS_PORT: String(PORT), RIGS_PEERS: '', RIGS_MESH_TOKEN: 'test-token',
    RIGS_NO_SYSTEMD: '1', RIGS_SYSTEMD_USER_DIR: path.join(DHOME, 'systemd-user'), RIGS_GPU_OVERSEER_CLIENTS: path.join(DHOME, 'gpu', 'clients.json'), FAKE_YOLO: 'page' };
  daemon = spawn(process.execPath, [path.join(ROOT, 'bin/rigs.js'), 'serve'], { env, stdio: ['ignore', 'pipe', 'pipe'] });
  let log = '';
  daemon.stdout.on('data', (d) => { log += d; });
  daemon.stderr.on('data', (d) => { log += d; });
  for (let i = 0; i < 100; i++) { try { if ((await fetch(BASE + '/api/self')).ok) break; } catch {} await sleep(150); }
  // the window URL names this machine: it answers from the first moment, before discovery has listed the machine
  assert.equal((await fetch(BASE + '/api/nodes/test-node/yolo/config')).status, 200);
  // switch Jev off so nothing waits on a router engine (the YOLO path never asks one anyway)
  await fetch(BASE + '/api/local/router', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ engine: 'rules', fallback: 'rules' }) });
  assert.equal((await (await fetch(BASE + '/api/local/yolo/config', { method: 'POST', body: JSON.stringify({ enabled: true }) })).json()).enabled, true);
  const ws = new WebSocket(`ws://127.0.0.1:${PORT}/ws`);
  const pushed = [];
  ws.on('message', (d) => { const m = JSON.parse(String(d)); if (String(m.type).startsWith('yolo-')) pushed.push(m); });
  await new Promise((r) => ws.on('open', r));
  try {
    const t0 = Date.now();
    const r = await fetch(BASE + '/api/local/jarvis/send', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ text: 'yolo a bouncing ball in p5', yolo: true }) });
    const events = [];
    let firstUrlAt = 0;
    let buf = '';
    for await (const chunk of r.body) {
      buf += Buffer.from(chunk).toString();
      let i;
      while ((i = buf.indexOf('\n')) >= 0) { const line = buf.slice(0, i).trim(); buf = buf.slice(i + 1); if (!line) continue; const e = JSON.parse(line); events.push(e); if (e.type === 'yolo-start' && !firstUrlAt) firstUrlAt = Date.now(); }
    }
    const start = events.find((e) => e.type === 'yolo-start');
    assert.ok(start, `a yolo-start in the stream:\n${JSON.stringify(events)}\n${log}`);
    assert.ok(firstUrlAt - t0 < 3000, `the window URL arrived ${firstUrlAt - t0} ms after the request`);
    assert.equal(start.url, `/api/nodes/test-node/yolo/${start.runId}/`);
    assert.equal(events.find((e) => e.type === 'done')?.text, 'A bouncing ball is on screen, sir.');
    await sleep(100);
    assert.deepEqual([...new Set(pushed.filter((e) => e.runId === start.runId).map((e) => e.type))], ['yolo-start', 'yolo-update', 'yolo-done'], 'pushed to the UI socket');
    // listed, served (locally and through the node path), errors the agent read back while it worked
    const list = await (await fetch(BASE + '/api/local/yolo')).json();
    assert.equal(list.runs[0].runId, start.runId);
    assert.equal(list.runs[0].status, 'done');
    for (const u of [start.localUrl, start.url, `${start.url}index.html`]) {
      const page = await fetch(BASE + u);
      const html = await page.text();
      assert.equal(page.status, 200, u);
      assert.match(html, /<title>Ball<\/title>/, u);
      assert.match(html, /__yolo\/client\.js/);
      assert.match(html, /<script src="ball\.js" crossorigin>/);
      assert.match(page.headers.get('content-security-policy'), /^sandbox/);
    }
    assert.equal((await fetch(BASE + start.localUrl.replace(/\/$/, ''), { redirect: 'manual' })).status, 308);
    assert.equal((await fetch(`${BASE}${start.localUrl}..%2F..%2Fconfig.json`)).status, 403);
    // the page runs in an opaque origin: it may report its errors, but not change anything else blind
    const nullPost = (u, body) => fetch(BASE + u, { method: 'POST', headers: { origin: 'null', 'content-type': 'text/plain' }, body: JSON.stringify(body) });
    assert.equal((await nullPost(`${start.localUrl}errors`, { type: 'console', message: 'from the page' })).status, 200);
    assert.equal((await nullPost('/api/local/yolo/config', { keep: 7 })).status, 403);
    // Keep as app: only JARVIS may keep a run — never the page itself (Origin: null), locally or through the node path
    for (const u of [`${start.localUrl}keep`, `${start.url}keep`]) {
      const k = await nullPost(u, { name: 'From the page' });
      assert.equal(k.status, 403, u);
      assert.match((await k.json()).error, /opaque origin/);
    }
    assert.equal((await (await fetch(`${BASE}${start.localUrl}meta`)).json()).keptAs, undefined, 'nothing was kept');
    const unknownKeep = await fetch(`${BASE}/api/local/yolo/y-20200101-000000-abcdef/keep`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: '{}' });
    assert.equal(unknownKeep.status, 404);
    assert.match((await unknownKeep.json()).error, /no such YOLO run/);
    const badKeep = await fetch(`${BASE}${start.localUrl}keep`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ id: 'Not Valid!' }) });
    assert.equal(badKeep.status, 400, 'an invalid explicit id');
    assert.equal((await nullPost('/api/nodes/test-node/jarvis/send', { text: 'implement something' })).status, 403);
    assert.equal((await (await fetch(BASE + '/api/local/yolo/config')).json()).keep, 200, 'config unchanged');
    const sock = new WebSocket(`ws://127.0.0.1:${PORT}/ws`, { headers: { origin: 'null' } });
    assert.match(await new Promise((r) => { sock.on('open', () => r('open')); sock.on('error', (e) => r(e.message)); }), /403/);
    const [agent] = fakeRuns();
    assert.equal(agent.errors?.total, 1, `the agent read the page error back: ${JSON.stringify(agent)}`);
    assert.equal(agent.errors.errors[0].message, 'ReferenceError: p5 is not defined');
    assert.equal(agent.cwd, fs.realpathSync(path.join(DHOME, 'yolo', start.runId)));
    // the trace and the ledger on the daemon
    const traceId = events.find((e) => e.type === 'trace').traceId;
    await sleep(200);
    const spans = (await (await fetch(`${BASE}/api/local/traces/${traceId}`)).json()).spans;
    assert.equal(spans.find((s) => s.kind === 'router')?.meta.route, 'yolo');
    assert.equal(spans.find((s) => s.kind === 'brain-turn')?.meta.lane, 'yolo');
    assert.equal(spans.find((s) => s.kind === 'intake')?.meta?.timing?.lane, 'yolo');
    // nothing filed
    assert.equal(fs.existsSync(path.join(DHOME, 'projects')) ? fs.readdirSync(path.join(DHOME, 'projects')).length : 0, 0, 'no project for the run');
    const cli = await new Promise((resolve) => { const c = spawn(process.execPath, [path.join(ROOT, 'bin/rigs.js'), 'yolo', 'list'], { env }); let o = ''; c.stdout.on('data', (d) => { o += d; }); c.on('close', () => resolve(o)); });
    assert.match(cli, new RegExp(`${start.runId}\\s+done`));
    const st = await new Promise((resolve) => { const c = spawn(process.execPath, [path.join(ROOT, 'bin/rigs.js'), 'yolo', 'status'], { env }); let o = ''; c.stdout.on('data', (d) => { o += d; }); c.on('close', () => resolve(o)); });
    assert.match(st, /^yolo mode on · claude claude-sonnet-5-5 \(low\) · max 20 turns, 180 s/);
    assert.doesNotMatch(st, /v2/, 'v2 is off by default');
    // YOLOv2 follow-ups: never from the page itself; a v1 run takes none
    for (const u of [`${start.localUrl}message`, `${start.url}message`]) assert.equal((await nullPost(u, { text: 'make it red' })).status, 403, u);
    const v1msg = await fetch(`${BASE}${start.localUrl}message`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ text: 'make it red' }) });
    assert.equal(v1msg.status, 409);
    const cliRun = (...a) => new Promise((resolve) => { const c = spawn(process.execPath, [path.join(ROOT, 'bin/rigs.js'), ...a], { env }); let o = ''; c.stdout.on('data', (d) => { o += d; }); c.stderr.on('data', (d) => { o += d; }); c.on('close', (code) => resolve({ code, o })); });
    assert.match((await cliRun('yolo', 'v2', 'on')).o, /^yolo mode on .* · v2 on \(multi-turn, subagents\)/);
    assert.equal((await (await fetch(BASE + '/api/local/yolo/config')).json()).v2, true);
    assert.doesNotMatch((await cliRun('yolo', 'v2', 'off')).o, /v2 on/);
    assert.equal((await (await fetch(BASE + '/api/local/yolo/config')).json()).v2, false);
    assert.equal((await cliRun('yolo', 'v2', 'maybe')).code, 1);
  } finally { ws.close(); daemon.kill(); daemon = null; }
});

// ---------------------------------------------------------------- Keep as app (src/yolo-keep.js)

const ID_RE = /^[a-z0-9][a-z0-9_-]{0,39}$/;

test('keepAppId: a valid App Cloud id from the title, unique against apps and folders, never a taken one', () => {
  assert.equal(K.keepAppId('A p5 sketch of orbiting planets'), 'p5-sketch-of-orbiting-planets');
  assert.equal(K.keepAppId('Orbit test'), 'orbit-test');
  assert.equal(K.keepAppId('Ünïcode — Ärger!!'), 'unicode-arger');
  assert.equal(K.keepAppId('🚀🚀'), 'yolo-app', 'nothing usable → yolo-app');
  assert.equal(K.keepAppId('', ['yolo-app']), 'yolo-app-2');
  assert.equal(K.keepAppId('Orbit test', ['orbit-test', 'Orbit-Test-2']), 'orbit-test-3', 'case-insensitive');
  const long = 'a p5 sketch of the whole mesh as orbiting planets around a bright sun';
  const first = K.keepAppId(long);
  assert.ok(first.length <= 40 && ID_RE.test(first), first);
  const taken = [first];
  for (let i = 0; i < 30; i++) {
    const next = K.keepAppId(long, taken);
    assert.ok(ID_RE.test(next) && next.length <= 40, next);
    assert.ok(!taken.includes(next), `never a taken id: ${next}`);
    taken.push(next);
  }
  for (const t of ['--', '___', '9 lives', 'x'.repeat(80), 'Ünï', '  the  ']) assert.ok(ID_RE.test(K.keepAppId(t)), t);
});

test('keepSkip / stripYoloClient / keepRequest: what is copied, what is never stored, what a body may say', () => {
  assert.equal(K.keepSkip('index.html', 'file'), null);
  assert.equal(K.keepSkip('data/cpu.json', 'file'), null);
  assert.equal(K.keepSkip('data', 'dir'), null);
  assert.equal(K.keepSkip('.env', 'file'), 'dot-file');
  assert.equal(K.keepSkip('assets/.git', 'dir'), 'dot-file');
  assert.equal(K.keepSkip('__yolo', 'dir'), 'yolo-client');
  assert.equal(K.keepSkip('__yolo/client.js', 'file'), 'yolo-client');
  assert.equal(K.keepSkip('link.txt', 'symlink'), 'symlink');
  assert.equal(K.keepSkip('sock', 'other'), 'special');
  assert.equal(K.keepSkip('index.html~', 'file'), 'temp');
  assert.equal(K.keepSkip('../x', 'file'), 'outside');
  const served = Y.injectClient('<!doctype html><html><head><title>P</title></head><body><script src="sketch.js"></script></body></html>', { step: 3 });
  assert.match(served, /__yolo\/client\.js/);
  const stored = K.stripYoloClient(served);
  assert.doesNotMatch(stored, /__yolo/);
  assert.match(stored, /<title>P<\/title>/);
  assert.match(stored, /<script src="sketch\.js"/, 'the page\'s own scripts stay');
  assert.doesNotMatch(K.stripYoloClient(Y.placeholderHtml({ title: 'x' })), /rigs-yolo/);
  const meta = { title: 'Orbiting planets', task: 'a p5 sketch of orbiting planets' };
  assert.deepEqual(K.keepRequest({}, meta), { id: '', name: 'Orbiting planets', icon: '⚡', description: 'Kept from a YOLO run: a p5 sketch of orbiting planets', tags: ['yolo'] });
  assert.deepEqual(K.keepRequest({ id: 'Orbit', name: '  Orbit   test ', icon: '🪐', tags: ['p5', 'yolo', 'Space'] }, meta), { id: 'orbit', name: 'Orbit test', icon: '🪐', description: 'Kept from a YOLO run: a p5 sketch of orbiting planets', tags: ['yolo', 'p5', 'space'] });
  for (const b of [{ id: 'Not valid!' }, { id: '-x' }, { tags: 'p5' }, { tags: ['two words'] }, []]) assert.throws(() => K.keepRequest(b, meta), (e) => e.status === 400, JSON.stringify(b));
});

test('keepLaunch / keepUnitText / candidatePorts: a per-OS recipe the App Cloud accepts, an enabled unit, a free port', () => {
  const dir = path.join(os.homedir(), 'RIGS-Shared', 'apps', 'orbit');
  for (const unit of ['rigs-orbit.service', '']) {
    const launch = K.keepLaunch({ dir, port: 8901, unit });
    const { app, errors } = A.validateApp({ id: 'orbit', port: 8901, healthPath: '/healthz', launch, tags: ['yolo'] }, 'test-node');
    assert.deepEqual(errors, []);
    assert.deepEqual(A.launchFor(app.launch, 'linux'), unit ? { systemd: unit } : { command: 'node server.mjs 8901', cwd: '~/RIGS-Shared/apps/orbit', env: {} });
    assert.deepEqual(A.launchFor(app.launch, 'darwin'), { command: 'node server.mjs 8901', cwd: '~/RIGS-Shared/apps/orbit', env: {} });
    assert.deepEqual(A.launchFor(app.launch, 'win32'), { command: 'node server.mjs 8901', cwd: '~\\RIGS-Shared\\apps\\orbit', env: {} });
  }
  const unit = K.keepUnitText({ id: 'orbit', name: 'Orbit "test" 100%', dir, port: 8901, runId: 'y-20261020-120000-abcdef', node: '/usr/bin/node' });
  assert.match(unit, /^# Managed by RIGS: a kept YOLO run \(y-20261020-120000-abcdef\)/);
  assert.match(unit, new RegExp(`ExecStart="/usr/bin/node" "${dir.replace(/[\\/.]/g, '\\$&')}/server\\.mjs" 8901`));
  assert.match(unit, /WantedBy=default\.target/);
  assert.match(unit, /Environment="HOST=127\.0\.0\.1"/);
  assert.deepEqual(K.candidatePorts([8900, 8902], { from: 8900, to: 8903 }), [8901, 8903]);
  assert.equal(K.targetPort('http://127.0.0.1:8787'), 8787);
  assert.equal(K.homeRel(path.join(os.homedir(), 'a', 'b')), '~/a/b');
});

/** A finished run in `root` whose agent wrote a page, assets, and things that must never be kept. */
async function keptFixture(root, { task = 'a p5 sketch of orbiting planets', finish = true } = {}) {
  const run = await Y.createRun({ text: `yolo ${task}`, task, node: 'test-node', root });
  const w = (rel, body) => { fs.mkdirSync(path.dirname(path.join(run.dir, rel)), { recursive: true }); fs.writeFileSync(path.join(run.dir, rel), body); };
  // the agent saved a page with the client in it (as served), plus its assets
  w('index.html', Y.injectClient('<!doctype html><html><head><title>Orbits</title></head><body><script src="https://cdn.jsdelivr.net/npm/p5@1.9.0/lib/p5.min.js"></script><script src="sketch.js"></script></body></html>', { step: 2 }));
  w('sketch.js', 'function setup(){createCanvas(400,400)}');
  w('data/planets.json', '[{"name":"earth"}]');
  w('.env', 'SECRET=1');
  w('.cache/x.json', '{}');
  w('__yolo/client.js', '/* stale client */');
  if (posix) { fs.symlinkSync('/etc/hostname', path.join(run.dir, 'host-link')); fs.symlinkSync(path.join(run.dir, 'data'), path.join(run.dir, 'data-link')); }
  if (finish) await Y.finishRun(run.runId, { ok: true, summary: 'Planets, sir.' });
  return run;
}

/** Stand-ins for the I/O: a fake App Cloud, systemd and shared folder (never the real ones). */
function keepDeps(base, { systemd = true, failRegister = false } = {}) {
  const apps = [];
  const calls = { systemctl: [], register: [], startApp: [] };
  const deps = {
    systemd: () => systemd,
    unitDir: () => path.join(base, 'systemd-user'),
    systemctl: async (a) => { calls.systemctl.push(a.join(' ')); return { code: 0, stdout: '', stderr: '' }; },
    register: async (app) => {
      calls.register.push(app);
      if (failRegister) throw new Error('registry is read-only');
      const { app: valid, errors } = A.validateApp(app, 'test-node');
      if (!valid) throw Object.assign(new Error(errors.join('; ')), { status: 400 });
      apps.splice(0, apps.length, ...apps.filter((a) => a.id !== valid.id), { ...valid, health: { status: 'unknown' } });
    },
    localApps: () => apps,
    startApp: async (id) => { calls.startApp.push(id); return { started: true }; },
    probe: async () => ({ ok: true }),
    sharedRoot: () => path.join(base, 'RIGS-Shared'),
    node: () => 'test-node',
    trashDir: () => path.join(base, 'trash'),
    sleep: async () => {},
  };
  return { deps, apps, calls };
}

test('keepRun: copies the sandbox (no __yolo, dot-files or symlinks; no client in the HTML), writes a server, publishes it, records keptAs — once', async () => {
  const base = path.join(TMP, 'keep-a');
  const root = path.join(base, 'yolo');
  const { deps, apps, calls } = keepDeps(base);
  const seen = [];
  const listen = (e) => { if (e.type === 'yolo-kept') seen.push(e); };
  Y.events.on('event', listen);
  try {
    const run = await keptFixture(root);
    const r = await K.keepRun(run.runId, { name: 'Orbit test', icon: '🪐', tags: ['p5'] }, { root, deps });
    const dir = path.join(base, 'RIGS-Shared', 'apps', 'orbit-test');
    assert.equal(r.ok, true);
    assert.equal(r.already, false);
    assert.deepEqual(r.keptAs && [r.keptAs.id, r.keptAs.node, r.keptAs.path, r.keptAs.dir], ['orbit-test', 'test-node', '/api/nodes/test-node/apps/orbit-test/', dir]);
    // the copy
    const files = [];
    const walk = (d, rel = '') => { for (const e of fs.readdirSync(d, { withFileTypes: true })) { const r2 = rel ? `${rel}/${e.name}` : e.name; if (e.isDirectory()) walk(path.join(d, e.name), r2); else files.push(r2); } };
    walk(dir);
    assert.deepEqual(files.sort(), ['data/planets.json', 'index.html', 'server.mjs', 'sketch.js']);
    const why = Object.fromEntries(r.skipped.map((x) => [x.path, x.why]));
    assert.equal(why['.env'], 'dot-file');
    assert.equal(why['.cache'], 'dot-file');
    assert.equal(why.__yolo, 'yolo-client');
    if (posix) { assert.equal(why['host-link'], 'symlink'); assert.equal(why['data-link'], 'symlink'); }
    const html = fs.readFileSync(path.join(dir, 'index.html'), 'utf8');
    assert.doesNotMatch(html, /__yolo/, 'the YOLO client is not in the stored page');
    assert.match(html, /<script src="sketch\.js"/);
    // published: an enabled unit, the registration with a per-OS recipe, description + tags
    const unitFile = path.join(base, 'systemd-user', 'rigs-orbit-test.service');
    assert.match(fs.readFileSync(unitFile, 'utf8'), /^# Managed by RIGS: a kept YOLO run/);
    assert.deepEqual(calls.systemctl, ['daemon-reload', 'enable --now rigs-orbit-test.service']);
    assert.equal(calls.startApp.length, 0, 'systemd started it');
    const reg = calls.register[0];
    assert.deepEqual([reg.id, reg.name, reg.icon, reg.healthPath, reg.description, reg.tags], ['orbit-test', 'Orbit test', '🪐', '/healthz', 'Kept from a YOLO run: a p5 sketch of orbiting planets', ['yolo', 'p5']]);
    assert.ok(reg.port >= 8900 && reg.port <= 8999);
    assert.deepEqual(Object.keys(reg.launch).sort(), ['darwin', 'systemd', 'windows']);
    assert.equal(r.health, 'up');
    // recorded in the run meta and pushed
    assert.deepEqual((await Y.getRun(run.runId, root)).keptAs.id, 'orbit-test');
    assert.deepEqual(JSON.parse(fs.readFileSync(path.join(root, `${run.runId}.json`), 'utf8')).keptAs.path, '/api/nodes/test-node/apps/orbit-test/');
    assert.deepEqual(seen.map((e) => [e.runId, e.keptAs.id]), [[run.runId, 'orbit-test']]);
    // a second keep: the same app, nothing written again
    const again = await K.keepRun(run.runId, { name: 'Another name' }, { root, deps });
    assert.equal(again.already, true);
    assert.equal(again.app.id, 'orbit-test');
    assert.equal(again.keptAs.id, 'orbit-test');
    assert.equal(calls.register.length, 1);
    assert.equal(apps.length, 1);
    assert.equal(fs.readdirSync(path.join(base, 'RIGS-Shared', 'apps')).length, 1);
    // also after a daemon restart (the meta from disk)
    Y._resetRuns();
    assert.equal((await K.keepRun(run.runId, {}, { root, deps })).already, true);
  } finally { Y.events.off('event', listen); }
});

test('keepRun refuses a live run, an unknown run, a run without a first frame, a taken id and an existing folder — and never overwrites', async () => {
  const base = path.join(TMP, 'keep-b');
  const root = path.join(base, 'yolo');
  const { deps, apps, calls } = keepDeps(base, { systemd: false });
  const live = await keptFixture(root, { finish: false });
  await assert.rejects(K.keepRun(live.runId, {}, { root, deps }), (e) => e.status === 409 && /still live/.test(e.message));
  assert.equal(Y.isLive(live.runId), true);
  await Y.finishRun(live.runId, { ok: true });
  assert.equal(Y.isLive(live.runId), false);
  await assert.rejects(K.keepRun('y-20200101-000000-abcdef', {}, { root, deps }), (e) => e.status === 404);
  const blank = await Y.createRun({ task: 'nothing drawn', root });
  await Y.finishRun(blank.runId, { ok: false });
  await assert.rejects(K.keepRun(blank.runId, {}, { root, deps }), (e) => e.status === 409 && /first frame/.test(e.message));
  // someone else's folder of that name: an explicit id is refused, a derived one is suffixed; neither touches it
  const appsDir = path.join(base, 'RIGS-Shared', 'apps');
  fs.mkdirSync(path.join(appsDir, 'orbit'), { recursive: true });
  fs.writeFileSync(path.join(appsDir, 'orbit', 'index.html'), 'mine');
  await assert.rejects(K.keepRun(live.runId, { id: 'orbit' }, { root, deps }), (e) => e.status === 409 && /never overwritten/.test(e.message));
  const r = await K.keepRun(live.runId, { name: 'Orbit' }, { root, deps });
  assert.equal(r.keptAs.id, 'orbit-2');
  assert.equal(fs.readFileSync(path.join(appsDir, 'orbit', 'index.html'), 'utf8'), 'mine', 'the existing folder is untouched');
  assert.deepEqual(calls.startApp, ['orbit-2'], 'no systemd: started through its launch command');
  assert.equal(apps.find((a) => a.id === 'orbit-2').launch.command, `node server.mjs ${r.keptAs.port}`);
  // an id another app already has
  const other = await keptFixture(root, { task: 'a clock' });
  await assert.rejects(K.keepRun(other.runId, { id: 'orbit-2' }, { root, deps }), (e) => e.status === 409 && /already taken/.test(e.message));
  // a unit file RIGS did not write
  const sysd = keepDeps(base, { systemd: true });
  fs.mkdirSync(path.join(base, 'systemd-user'), { recursive: true });
  fs.writeFileSync(path.join(base, 'systemd-user', 'rigs-clock.service'), '[Unit]\nDescription=mine\n');
  await assert.rejects(K.keepRun(other.runId, {}, { root, deps: sysd.deps }), (e) => e.status === 409 && /not written by RIGS/.test(e.message));
  assert.equal(fs.existsSync(path.join(appsDir, 'clock')), false, 'nothing copied before the refusal');
  assert.equal(fs.readFileSync(path.join(base, 'systemd-user', 'rigs-clock.service'), 'utf8'), '[Unit]\nDescription=mine\n', 'the foreign unit is untouched');
});

test('keepRun undoes only what it made when publishing fails: its folder and unit go to the trash', async () => {
  const base = path.join(TMP, 'keep-c');
  const root = path.join(base, 'yolo');
  const { deps, calls } = keepDeps(base, { failRegister: true });
  const run = await keptFixture(root);
  await assert.rejects(K.keepRun(run.runId, { name: 'Broken' }, { root, deps }), (e) => /registry is read-only/.test(e.message));
  assert.equal(fs.existsSync(path.join(base, 'RIGS-Shared', 'apps', 'broken')), false);
  assert.equal(fs.existsSync(path.join(base, 'systemd-user', 'rigs-broken.service')), false);
  assert.ok(calls.systemctl.includes('disable --now rigs-broken.service'));
  assert.equal(fs.readdirSync(path.join(base, 'trash')).length, 2, 'folder + unit in the trash, never unlinked');
  assert.equal((await Y.getRun(run.runId, root)).keptAs, undefined);
});

test('the generated static server: /healthz, index.html and assets with their types, no .., dot-files, symlinks or itself', async () => {
  const base = path.join(TMP, 'keep-d');
  const root = path.join(base, 'yolo');
  const { deps } = keepDeps(base);
  const run = await keptFixture(root);
  const r = await K.keepRun(run.runId, { name: 'Served' }, { root, deps });
  const dir = r.keptAs.dir;
  fs.writeFileSync(path.join(dir, '.secret'), 'no');
  if (posix) fs.symlinkSync('/etc/hostname', path.join(dir, 'leak.txt'));
  const before = process.env.PORT;
  process.env.PORT = '0';
  const mod = await import(`${pathToFileURL(path.join(dir, 'server.mjs')).href}?t=${Date.now()}`);
  if (before === undefined) delete process.env.PORT; else process.env.PORT = before;
  const port = await mod.listening;
  const B = `http://127.0.0.1:${port}`;
  try {
    const hz = await fetch(`${B}/healthz`);
    assert.equal(hz.status, 200);
    const idx = await fetch(`${B}/`);
    assert.equal(idx.status, 200);
    assert.match(idx.headers.get('content-type'), /^text\/html/);
    const page = await idx.text();
    assert.match(page, /<title>Orbits<\/title>/);
    assert.doesNotMatch(page, /__yolo/);
    assert.match((await fetch(`${B}/sketch.js`)).headers.get('content-type'), /^text\/javascript/);
    assert.match((await fetch(`${B}/data/planets.json`)).headers.get('content-type'), /^application\/json/);
    const folder = await fetch(`${B}/data`, { redirect: 'manual' });
    assert.equal(folder.status, 301);
    assert.equal(folder.headers.get('location'), 'data/', 'relative');
    assert.equal((await fetch(`${B}/.secret`)).status, 403);
    // raw paths (fetch would normalise them first)
    const raw = (p) => new Promise((resolve, reject) => http.get({ host: '127.0.0.1', port, path: p }, (res) => { res.resume(); resolve(res.statusCode); }).on('error', reject));
    fs.writeFileSync(path.join(dir, '..', 'outside.txt'), 'outside the app folder');
    for (const p of ['/../outside.txt', '/%2e%2e/outside.txt', '/..%2foutside.txt', '/data/..%2f..%2foutside.txt']) assert.ok([403, 404].includes(await raw(p)), p);
    assert.equal(await raw('/..%2foutside.txt'), 403, 'an encoded .. is refused outright');
    assert.equal((await fetch(`${B}/server.mjs`)).status, 404, 'never serves itself');
    assert.equal((await fetch(`${B}/__yolo/client.js`)).status, 404);
    if (posix) assert.equal((await fetch(`${B}/leak.txt`)).status, 404, 'a symlink out of the folder');
    assert.equal((await fetch(`${B}/`, { method: 'POST' })).status, 405);
    assert.equal(mod.server.address().address, '127.0.0.1');
    // still untrusted agent output: the YOLO window's CSP sandbox (opaque origin) on every answer, CORS for its own files
    const csp = Y.SANDBOX_HEADERS['content-security-policy'];
    assert.match(csp, /^sandbox /);
    assert.doesNotMatch(csp, /allow-same-origin/);
    for (const p of ['/', '/sketch.js', '/data/planets.json', '/nope.html', '/healthz']) {
      const res = await fetch(`${B}${p}`);
      assert.equal(res.headers.get('content-security-policy'), csp, p);
      assert.equal(res.headers.get('access-control-allow-origin'), '*', p);
    }
    const pre = await fetch(`${B}/data/planets.json`, { method: 'OPTIONS' });
    assert.equal(pre.status, 204);
    assert.equal(pre.headers.get('access-control-allow-origin'), '*');
  } finally { await new Promise((res) => mod.server.close(res)); }
});

// ---------------------------------------------------------------- YOLOv2: multi-turn runs, subagents; suggested icons

const nextEvent = (pred, ms = 20000) => new Promise((resolve, reject) => {
  const fn = (e) => { if (pred(e)) { clearTimeout(t); Y.events.off('event', fn); resolve(e); } };
  const t = setTimeout(() => { Y.events.off('event', fn); reject(new Error('timed out waiting for a YOLO event')); }, ms);
  Y.events.on('event', fn);
});
const tinyPng = `data:image/png;base64,${Buffer.from('89504e470d0a1a0a0000000d49484452', 'hex').toString('base64')}`;

test('yolo.v2: a mesh-global switch, off by default, validated by applyYoloPatch', () => {
  assert.equal(Y.yoloSettings().v2, false);
  assert.equal(Y.yoloSettings({ v2: 'on' }).v2, true);
  assert.equal(Y.applyYoloPatch({}, { v2: true }).v2, true);
  assert.equal(Y.applyYoloPatch({ v2: true }, { enabled: false }).v2, true, 'other patches keep it');
  assert.equal(Y.applyYoloPatch({ v2: true }, { v2: 'off' }).v2, false);
  assert.throws(() => Y.applyYoloPatch({}, { v2: 'maybe' }), /v2/);
  assert.equal(config().yolo.v2, false, 'the default config has it off');
});

test('yoloPrompt v2 and the --agents JSON: delegation, a conversation, blocked tools stay blocked in subagents', () => {
  const base = { dir: '/r/y-1', base: 'http://127.0.0.1:4719/api/local/yolo/y-1/', model: 'claude-sonnet-5-5', maxTurns: 20, timeoutMs: 180000 };
  const v1 = Y.yoloPrompt(base);
  assert.doesNotMatch(v1, /web-research|quick-builder|conversation/, 'v1 has no subagents and no follow-ups');
  assert.match(v1, /icon\.json[\s\S]*icon\.svg/, 'both modes may suggest an icon');
  assert.match(v1, /8\. Finish with ONE short spoken line/);
  const v2 = Y.yoloPrompt({ ...base, v2: true });
  for (const re of [/180 s per turn/, /web-research/, /quick-builder/, /first frame yourself first/, /conversation/, /same session/, /icon\.json/, /never run git/, /Finish every turn with ONE short spoken line/]) assert.match(v2, re);
  const agents = Y.yoloAgents();
  assert.deepEqual(Object.keys(agents).sort(), ['quick-builder', 'web-research']);
  assert.deepEqual(agents['web-research'].tools, ['WebSearch', 'WebFetch']);
  assert.ok(['sonnet', 'haiku'].includes(agents['web-research'].model));
  assert.equal(agents['quick-builder'].model, 'haiku');
  assert.ok(agents['quick-builder'].tools.includes('Write'));
  for (const [name, a] of Object.entries(agents)) {
    assert.ok(a.description && a.prompt, name);
    assert.ok(!a.tools.some((t) => /^(?:Bash|mcp__)/.test(t) || Y.YOLO_BLOCKED_TOOLS.includes(t)), `${name}: no blocked, Bash or MCP tool`);
    assert.deepEqual(a.disallowedTools, Y.YOLO_BLOCKED_TOOLS, `${name} denies every blocked tool too`);
  }
  assert.deepEqual(JSON.parse(JSON.stringify(agents)), agents, 'plain JSON for --agents');
  const f = Y.yoloFollowUp({ text: 'make it red', feedback: { text: 'too small', console: 'warn x' }, errors: [{ type: 'error', message: 'boom', source: 'ball.js', line: 3 }], turn: 3, screenshot: '.feedback/turn-3.png' });
  for (const re of [/^Turn 3/, /make it red/, /too small/, /warn x/, /\.feedback\/turn-3\.png/, /\[error\] boom \(ball\.js:3\)/]) assert.match(f, re);
  assert.match(Y.yoloFollowUp({ text: 'ok' }), /No page errors/);
  assert.equal(Y.feedbackBlock(undefined), null);
  assert.equal(Y.feedbackBlock({}), null);
  assert.deepEqual(Y.feedbackBlock('looks off'), { text: 'looks off', console: '', screenshot: null });
  assert.equal(Y.feedbackBlock({ screenshot: tinyPng }).screenshot.ext, 'png');
  assert.equal(Y.feedbackBlock({ console: ['a', { b: 1 }] }).console, 'a\n{"b":1}');
  for (const bad of [{ screenshot: 'http://x/y.png' }, { screenshot: 'data:image/svg+xml;base64,PHN2Zz4=' }, { screenshot: `data:image/png;base64,${'A'.repeat(6 * 1024 * 1024)}` }, [1], 42]) {
    assert.throws(() => Y.feedbackBlock(bad), (e) => e.status === 400, JSON.stringify(bad).slice(0, 60));
  }
});

test('readSuggestedIcon: an emoji or a confined, small, script-free SVG — never traversal, scripts, oversize or symlinks out', () => {
  const dir = fs.mkdtempSync(path.join(TMP, 'icon-'));
  const w = (rel, body) => { fs.mkdirSync(path.dirname(path.join(dir, rel)), { recursive: true }); fs.writeFileSync(path.join(dir, rel), body); };
  const clear = () => { for (const n of fs.readdirSync(dir)) fs.rmSync(path.join(dir, n), { recursive: true, force: true }); };
  const SVG = '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 10 10"><circle cx="5" cy="5" r="4" fill="red"/></svg>';
  assert.equal(Y.readSuggestedIcon(dir), null, 'none suggested');
  w('icon.json', JSON.stringify({ emoji: '🪐' }));
  assert.deepEqual(Y.readSuggestedIcon(dir), { emoji: '🪐' });
  w('icon.json', JSON.stringify({ emoji: 'CPU' }));
  assert.deepEqual(Y.readSuggestedIcon(dir), { emoji: 'CPU' }, 'short text is fine');
  w('art/logo.svg', SVG);
  w('icon.json', JSON.stringify({ emoji: '🪐', svg: './art/logo.svg' }));
  assert.deepEqual(Y.readSuggestedIcon(dir), { emoji: '🪐', svg: 'art/logo.svg' });
  clear();
  w('icon.svg', SVG);
  assert.deepEqual(Y.readSuggestedIcon(dir), { svg: 'icon.svg' }, 'a plain icon.svg');
  // refused parts are left out; nothing valid → null (or the plain icon.svg)
  w('icon.json', JSON.stringify({ emoji: 'x'.repeat(17), svg: '../outside.svg' }));
  fs.writeFileSync(path.join(TMP, 'outside.svg'), SVG);
  assert.deepEqual(Y.readSuggestedIcon(dir), { svg: 'icon.svg' }, 'too long and traversal refused; icon.svg used instead');
  fs.rmSync(path.join(dir, 'icon.svg'));
  assert.equal(Y.readSuggestedIcon(dir), null);
  for (const svg of ['/etc/x.svg', '%2e%2e/outside.svg', '.hidden/x.svg', 'art/logo.png', 'icon.json']) {
    w('icon.json', JSON.stringify({ svg }));
    assert.equal(Y.readSuggestedIcon(dir), null, svg);
  }
  for (const [name, body] of [['script', '<svg><script>alert(1)</script></svg>'], ['handler', '<svg onload="alert(1)"></svg>'], ['foreign', '<svg><foreignObject><div/></foreignObject></svg>'],
    ['js-href', '<svg><a href="javascript:alert(1)"><circle r="1"/></a></svg>'], ['external', '<svg><image href="https://evil.example/x.png"/></svg>'], ['entity', '<?xml version="1.0"?><!DOCTYPE svg [<!ENTITY x "y">]><svg/>'],
    ['not-svg', '<html><body>hi</body></html>'], ['oversize', `<svg>${'<!-- pad -->'.repeat(4000)}</svg>`]]) {
    w('bad.svg', body);
    w('icon.json', JSON.stringify({ svg: 'bad.svg' }));
    assert.equal(Y.readSuggestedIcon(dir), null, name);
    assert.ok(Y.svgProblem(body), name);
  }
  assert.equal(Y.svgProblem(SVG), '');
  for (const bad of ['<b>', 'a"b', '', '   ', null, {}, '\u0007']) assert.equal(Y.iconText(bad), '', JSON.stringify(bad));
  if (posix) {
    clear();
    fs.symlinkSync(path.join(TMP, 'outside.svg'), path.join(dir, 'icon.svg'));
    assert.equal(Y.readSuggestedIcon(dir), null, 'a symlink out of the sandbox');
  }
  clear();
  w('icon.json', '{ not json');
  assert.equal(Y.readSuggestedIcon(dir), null);
});

test('a run picks up a suggested icon as it is written: meta.icon and a yolo-icon event (v1 too)', async () => {
  const root = path.join(TMP, 'icon-run');
  const run = await Y.createRun({ text: 'yolo a clock', task: 'a clock', node: 'test-node', root });
  const got = nextEvent((e) => e.type === 'yolo-icon' && e.runId === run.runId);
  fs.writeFileSync(path.join(run.dir, 'index.html'), '<!doctype html><title>Clock</title>');
  fs.writeFileSync(path.join(run.dir, 'icon.json'), JSON.stringify({ emoji: '⏰' }));
  const ev = await got;
  assert.equal(ev.icon.emoji, '⏰');
  assert.equal((await Y.getRun(run.runId, root)).icon.emoji, '⏰');
  await Y.finishRun(run.runId, { ok: true });
  const disk = JSON.parse(fs.readFileSync(path.join(root, `${run.runId}.json`), 'utf8'));
  assert.equal(disk.icon.emoji, '⏰');
  assert.equal(disk.v2, undefined, 'a v1 run has no conversation fields');
  assert.equal(disk.messages, undefined);
});

test('POST …/message: v2 only, 409 while a turn runs (not queued), 400 empty, Origin: null refused; idle → running → idle with messages[]', async () => {
  const root = path.join(TMP, 'msg');
  const { srv, base } = await sandboxServer(root);
  const post = (runId, b, headers = {}) => fetch(`${base}/yolo/${runId}/message`, { method: 'POST', headers: { 'content-type': 'application/json', ...headers }, body: JSON.stringify(b) });
  const begun = [];
  let release = null;
  Y.setTurnRunner(async (b) => { begun.push(b); await new Promise((r) => { release = r; }); await Y.endTurn(b.runId, { ok: true, summary: 'Red now, sir.', reply: 'Red now, sir.' }); });
  try {
    // a v1 run takes no messages
    const v1 = await Y.createRun({ text: 'yolo a ball', task: 'a ball', node: 'test-node', root });
    await Y.finishRun(v1.runId, { ok: true });
    const r1 = await post(v1.runId, { text: 'more' });
    assert.equal(r1.status, 409);
    assert.match((await r1.json()).error, /not a YOLOv2 run/);
    assert.equal((await post('y-20200101-000000-abcdef', { text: 'x' })).status, 404);
    // a v2 run: refused while its first turn runs, then idle and ready
    const run = await Y.createRun({ text: 'yolo a ball', task: 'a ball', node: 'test-node', root, v2: true });
    Y.addMessage(run.runId, { role: 'user', text: 'a ball' });
    Y.setSession(run.runId, 'sess-1');
    const busy = await post(run.runId, { text: 'make it red' });
    assert.equal(busy.status, 409);
    assert.match((await busy.json()).error, /still running[\s\S]*not queued/);
    const idleDone = await Y.endTurn(run.runId, { ok: true, summary: 'A ball, sir.', reply: 'A ball, sir.' });
    assert.deepEqual([idleDone.type, idleDone.idle, idleDone.turn], ['yolo-done', true, 1]);
    assert.equal((await Y.getRun(run.runId, root)).status, 'idle');
    assert.equal(Y.isLive(run.runId), false, 'idle is not live: Keep works on it');
    assert.equal((await post(run.runId, {})).status, 400);
    assert.equal((await post(run.runId, { text: '   ' })).status, 400);
    assert.equal((await post(run.runId, { feedback: { screenshot: 'nope' } })).status, 400);
    // the page itself (an opaque origin) may not drive the conversation
    assert.equal(Y.opaqueOriginRefused({ method: 'POST', pathname: `/api/local/yolo/${run.runId}/message`, origin: 'null' }), true);
    assert.equal(Y.opaqueOriginRefused({ method: 'POST', pathname: `/api/nodes/test-node/yolo/${run.runId}/message`, origin: 'null' }), true);
    Y.recordError(run.runId, { type: 'error', message: 'TypeError: x is undefined', source: 'ball.js', line: 7 });
    const ok = await post(run.runId, { text: 'make it red', feedback: { text: 'too small', screenshot: tinyPng } });
    assert.equal(ok.status, 200);
    assert.deepEqual(await ok.json(), { ok: true, runId: run.runId, turn: 2, status: 'running', errors: 1 });
    await sleep(20);
    assert.equal(begun.length, 1);
    assert.equal(begun[0].sessionId, 'sess-1');
    assert.equal(begun[0].dir, run.dir);
    assert.match(begun[0].prompt, /Turn 2[\s\S]*make it red[\s\S]*too small[\s\S]*\.feedback\/turn-2\.png[\s\S]*TypeError: x is undefined/);
    assert.ok(fs.existsSync(path.join(run.dir, '.feedback', 'turn-2.png')), 'the screenshot is in the sandbox (a dot-folder: never served or kept)');
    assert.equal((await rawGet(base, `/yolo/${run.runId}/.feedback/turn-2.png`)).status, 403);
    const again = await post(run.runId, { text: 'and bigger' });
    assert.equal(again.status, 409, 'one turn at a time');
    const done = nextEvent((e) => e.type === 'yolo-done' && e.runId === run.runId);
    release();
    assert.deepEqual([(await done).turn, (await done).idle], [2, true]);
    const meta = await (await fetch(`${base}/yolo/${run.runId}/meta`)).json();
    assert.deepEqual([meta.v2, meta.status, meta.turn, meta.sessionId], [true, 'idle', 2, 'sess-1']);
    assert.deepEqual(meta.messages.map((m) => [m.role, m.text, m.turn]), [['user', 'a ball', 1], ['assistant', 'A ball, sir.', 1], ['user', 'make it red', 2], ['assistant', 'Red now, sir.', 2]]);
    assert.deepEqual(meta.messages[2].feedback, { text: 'too small', screenshot: '.feedback/turn-2.png' });
    assert.equal(meta.messages[2].errors, 1);
    // after a daemon restart the idle run is picked up again from its meta
    Y._resetRuns();
    const back = await post(run.runId, { text: 'and bigger' });
    assert.equal(back.status, 200);
    assert.equal((await back.json()).turn, 3);
    const done3 = nextEvent((e) => e.type === 'yolo-done' && e.runId === run.runId && e.turn === 3);
    await sleep(20);
    release();
    await done3;
    assert.equal((await Y.getRun(run.runId, root)).messages.length, 6);
  } finally { Y.setTurnRunner(null); srv.close(); }
});

test('YOLOv2 end to end: --agents at the start, the session resumed in the same sandbox, feedback + errors in the turn, icon, Keep', { skip: !posix && 'stand-in claude is a POSIX script' }, async () => {
  setYolo({ enabled: true, v2: true });
  fs.rmSync(FAKE_LOG, { force: true });
  process.env.FAKE_YOLO = 'page';
  Y.setTurnRunner((b) => chat.yoloFollowUp(b, {}));
  const events = [];
  const all = (e) => events.push(e);
  Y.events.on('event', all);
  try {
    const out = await chat.jarvisSend('yolo a bouncing ball in p5', {}, () => {}, { router: noRouter, onWork: noWork, send: noSend, sendQuick: noSend });
    const runId = out.runId;
    assert.equal(out.text, 'A bouncing ball is on screen, sir.');
    let meta = await Y.getRun(runId);
    assert.deepEqual([meta.v2, meta.status, meta.ok, meta.turn, meta.sessionId], [true, 'idle', true, 1, 'yolo-sess'], 'idle, not done; the session kept');
    assert.deepEqual(meta.messages.map((m) => m.role), ['user', 'assistant']);
    const [first] = fakeRuns();
    const arg = (r, k) => r.args[r.args.indexOf(k) + 1];
    assert.deepEqual(Object.keys(JSON.parse(arg(first, '--agents'))).sort(), ['quick-builder', 'web-research']);
    assert.match(arg(first, '--disallowedTools'), /mcp__rigs__jarvis_task.*Bash\(git:\*\)/, 'still blocked for the session and its subagents');
    assert.match(arg(first, '--append-system-prompt'), /web-research[\s\S]*conversation/);
    assert.ok(!first.args.includes('--resume'));
    const done1 = events.find((e) => e.type === 'yolo-done' && e.runId === runId);
    assert.deepEqual([done1.idle, done1.turn], [true, 1]);
    // Sir tests it: an error shows up, then he sends feedback
    Y.recordError(runId, { type: 'rejection', message: 'NotAllowedError: play() failed', source: 'ball.js', line: 2 });
    const r = await Y.messageRun(runId, { text: 'make it red and bigger', feedback: { text: 'hard to see', console: ['warn: tiny'] } });
    assert.deepEqual([r.ok, r.turn, r.errors], [true, 2, 1]);
    await nextEvent((e) => e.type === 'yolo-done' && e.runId === runId && e.turn === 2);
    const second = fakeRuns().at(-1);
    assert.equal(arg(second, '--resume'), 'yolo-sess', 'the same Claude session');
    assert.equal(second.cwd, first.cwd, 'in the same sandbox');
    assert.ok(second.args.includes('--agents'));
    assert.match(arg(second, '--disallowedTools'), /mcp__rigs__project_create/);
    assert.match(second.args[1], /^Turn 2[\s\S]*make it red and bigger[\s\S]*hard to see[\s\S]*warn: tiny[\s\S]*NotAllowedError: play\(\) failed/);
    meta = await Y.getRun(runId);
    assert.deepEqual([meta.status, meta.turn, meta.ok], ['idle', 2, true]);
    assert.deepEqual(meta.messages.map((m) => [m.role, m.turn]), [['user', 1], ['assistant', 1], ['user', 2], ['assistant', 2]]);
    assert.equal(meta.messages[3].text, 'The ball is red and bigger now, sir.');
    assert.equal(meta.icon?.emoji, '🔴', 'the icon the agent suggested');
    const mine = events.filter((e) => e.runId === runId);
    for (const t of ['yolo-message', 'yolo-update', 'yolo-icon', 'yolo-done']) assert.ok(mine.some((e) => e.type === t), t);
    assert.ok(mine.findIndex((e) => e.type === 'yolo-message' && e.turn === 2 && e.role === 'assistant') < mine.findIndex((e) => e.type === 'yolo-done' && e.turn === 2));
    assert.ok(mine.some((e) => e.type === 'yolo-update' && e.files.includes('ball.js') && mine.indexOf(e) > mine.indexOf(done1)), 'the follow-up\'s writes reload the window');
    // traced as its own request, with the run id
    await trace.flush();
    const turnSpan = (await trace.readSpans({})).filter((s) => s.kind === 'brain-turn' && s.meta?.runId === runId && s.meta?.turn === 2);
    assert.equal(turnSpan.length, 1);
    assert.equal(turnSpan[0].meta.v2, true);
    // Keep as app on the idle run takes the suggested icon
    const kbase = path.join(TMP, 'keep-v2');
    const { deps, calls } = keepDeps(kbase);
    const kept = await K.keepRun(runId, { name: 'Red ball' }, { deps });
    assert.equal(kept.ok, true);
    assert.equal(calls.register[0].icon, '🔴');
    assert.equal(kept.keptAs.icon, '🔴');
  } finally {
    Y.events.off('event', all);
    Y.setTurnRunner(null);
    setYolo({ v2: false });
  }
});

test('keepRequest: the suggested icon when the body has none — emoji as the app icon, svg as iconSvg; ⚡ stays the fallback', () => {
  const meta = { title: 'Orbits', task: 'orbits' };
  assert.equal(K.keepRequest({}, meta).icon, '⚡');
  assert.equal(K.keepRequest({}, { ...meta, icon: { emoji: '🪐', at: 1 } }).icon, '🪐');
  assert.equal(K.keepRequest({ icon: '🚀' }, { ...meta, icon: { emoji: '🪐', svg: 'icon.svg' } }).icon, '🚀', 'the body wins');
  assert.equal(K.keepRequest({ icon: '🚀' }, { ...meta, icon: { emoji: '🪐', svg: 'icon.svg' } }).iconSvg, undefined);
  const svgOnly = K.keepRequest({}, { ...meta, icon: { svg: 'art/icon.svg' } });
  assert.deepEqual([svgOnly.icon, svgOnly.iconSvg], ['⚡', 'art/icon.svg']);
  assert.equal(K.keepRequest({}, { ...meta, icon: { emoji: '<script>' } }).icon, '⚡', 'a meta icon is re-checked');
  assert.equal(K.keepRequest({}, { ...meta, icon: { svg: '../../etc/x.svg' } }).iconSvg, undefined);
});

test('keepRun on a v1 run with a suggested icon.svg: the kept app records iconSvg', async () => {
  const base = path.join(TMP, 'keep-icon');
  const root = path.join(base, 'yolo');
  const { deps, calls } = keepDeps(base, { systemd: false });
  const run = await keptFixture(root, { finish: false });
  fs.writeFileSync(path.join(run.dir, 'icon.svg'), '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 4 4"><rect width="4" height="4"/></svg>');
  await Y.finishRun(run.runId, { ok: true, summary: 'Planets, sir.' });
  assert.deepEqual((await Y.getRun(run.runId, root)).icon && { svg: (await Y.getRun(run.runId, root)).icon.svg }, { svg: 'icon.svg' });
  const r = await K.keepRun(run.runId, {}, { root, deps });
  assert.deepEqual([r.keptAs.icon, r.keptAs.iconSvg, calls.register[0].icon], ['⚡', 'icon.svg', '⚡']);
  assert.ok(fs.existsSync(path.join(r.keptAs.dir, 'icon.svg')), 'the svg is in the kept folder');
});

test('mergeHistory: newest first, deduped by (node, runId), offline sources marked available: false', () => {
  const id = (sec) => Y.newRunId(new Date(Date.UTC(2021, 0, 1, 0, 0, sec)));
  const [a, b, c] = [id(1), id(2), id(3)];
  const r = Y.mergeHistory([
    { node: 'here', ok: true, runs: [{ runId: b, title: 'B', createdAt: 2000, status: 'done', endedAt: 2500 }, { runId: b, title: 'dup' }, { runId: 'junk' }] },
    { node: 'peer', ok: true, runs: [{ runId: c, title: 'C', createdAt: 3000, status: 'idle', v2: true, keptAs: { id: 'k' } }, { runId: b, title: 'same id other node', createdAt: 1500, status: 'done' }] },
    { node: 'gone', ok: false, error: 'offline', cachedAt: 99, runs: [{ runId: a, title: 'A', createdAt: 1000, status: 'done' }] },
    { node: 'slow', ok: false, error: 'no answer', runs: [] },
  ]);
  assert.deepEqual(r.runs.map((x) => [x.node, x.title, x.available]), [['peer', 'C', true], ['here', 'B', true], ['peer', 'same id other node', true], ['gone', 'A', false]]);
  assert.equal(r.runs[0].url, `/api/nodes/peer/yolo/${c}/`);
  assert.equal(r.runs[1].finishedAt, 2500);
  assert.deepEqual(r.runs[0].keptAs, { id: 'k' });
  assert.deepEqual(r.nodes, { here: { ok: true, count: 1 }, peer: { ok: true, count: 2 }, gone: { ok: false, count: 1, error: 'offline', cachedAt: 99 }, slow: { ok: false, count: 0, error: 'no answer' } });
  assert.equal(Y.mergeHistory([{ node: 'here', ok: true, runs: r.runs.map((x) => ({ ...x })) }], { limit: 2 }).runs.length, 2);
});

test('meshHistory: a slow or offline peer comes from its cache, never stalls; a fresh answer refreshes the cache', async () => {
  const home = fs.mkdtempSync(path.join(TMP, 'hist-'));
  const root = path.join(home, 'yolo');
  const mine = await Y.createRun({ text: 'yolo mine', root, keep: 1000 });
  await Y.finishRun(mine.runId, { ok: true });
  const peerRun = { runId: Y.newRunId(new Date(Date.UTC(2021, 0, 1))), title: 'P', createdAt: 5, status: 'done' };
  const peers = (over = {}) => [{ name: 'p1', online: true, fetch: async () => [peerRun], ...over }];
  let r = await Y.meshHistory({ selfNode: 'me', peers: peers(), root, home });
  assert.deepEqual(r.runs.map((x) => [x.node, x.available]), [['me', true], ['p1', true]]);
  assert.equal(Y.readHistoryCache(home).p1.runs[0].runId, peerRun.runId);
  const t0 = Date.now();
  r = await Y.meshHistory({ selfNode: 'me', peers: peers({ fetch: () => new Promise(() => {}) }), timeoutMs: 100, root, home });
  assert.ok(Date.now() - t0 < 2000, 'a hung peer is cut off');
  assert.deepEqual(r.runs.map((x) => [x.node, x.available]), [['me', true], ['p1', false]]);
  assert.equal(r.nodes.p1.ok, false);
  assert.ok(r.nodes.p1.cachedAt);
  r = await Y.meshHistory({ selfNode: 'me', peers: peers({ online: false }), root, home });
  assert.equal(r.nodes.p1.error, 'offline');
  r = await Y.meshHistory({ selfNode: 'me', peers: peers({ online: false, name: 'never-seen' }), root, home });
  assert.deepEqual(r.nodes['never-seen'], { ok: false, count: 0, error: 'offline' });
});

test('prune never removes a run keptAs points to; a finished never-kept run reopens from disk (page + meta + messages)', async () => {
  const root = path.join(TMP, 'prune-kept');
  const mk = (sec, meta) => {
    const id = Y.newRunId(new Date(Date.UTC(2019, 0, 1, 0, 0, sec)));
    fs.mkdirSync(path.join(root, id), { recursive: true });
    fs.writeFileSync(path.join(root, id, 'index.html'), '<html><body>hi</body></html>');
    fs.writeFileSync(path.join(root, `${id}.json`), JSON.stringify({ runId: id, ...meta }));
    return id;
  };
  const kept = mk(1, { status: 'done', keptAs: { id: 'a', node: 'n', path: '/p/' } });
  const plain = mk(2, { status: 'done', v2: true, messages: [{ role: 'user', text: 'hi', turn: 1 }, { role: 'assistant', text: 'there', turn: 1 }] });
  const stale = mk(3, { status: 'running', v2: true, sessionId: 's' });
  const removed = await Y._prune(root, 0);
  assert.deepEqual(removed, [plain], 'kept and unfinished stay');
  assert.ok(fs.existsSync(path.join(root, kept)));
  // A run a restart left behind: the page and meta come from disk.
  const again = mk(4, { status: 'done', v2: true, messages: [{ role: 'user', text: 'hi', turn: 1 }] });
  Y._resetRuns();
  const meta = await Y.handle({ method: 'GET' }, null, again, 'meta', { root });
  assert.equal(meta.messages[0].text, 'hi');
  assert.equal((await Y.handle({ method: 'GET' }, null, stale, 'meta', { root })).status, 'interrupted');
  let status = 0; let sent = '';
  const res = { writeHead: (s) => { status = s; }, end: (b) => { sent += b || ''; }, write: (b) => { sent += b; }, setHeader() {} };
  await Y.handle({ method: 'GET' }, res, again, '', { root });
  assert.equal(status, 200);
  assert.match(sent, /<body>hi<\/body>/);
});
