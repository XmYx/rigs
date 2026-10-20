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
import { fileURLToPath } from 'node:url';
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
  assert.deepEqual([d.enabled, d.provider, d.model, d.effort, d.maxTurns, d.timeoutMs, d.keep], [true, 'claude', 'claude-sonnet-5-5', 'low', 20, 180000, 50]);
  assert.equal(d.root, path.join(HOME, 'yolo'));
  const s = Y.yoloSettings({ enabled: 'off', provider: 'codex', effort: 'turbo', maxTurns: 999, timeoutMs: 5, model: '  ' });
  assert.deepEqual([s.enabled, s.provider, s.effort, s.maxTurns, s.timeoutMs, s.model], [false, 'claude', 'low', 100, 10000, 'claude-sonnet-5-5']);
  assert.deepEqual(Y.applyYoloPatch({}, { enabled: false }), { enabled: false, provider: 'claude', model: 'claude-sonnet-5-5', effort: 'low', maxTurns: 20, timeoutMs: 180000, keep: 50 });
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
  for (const p of ['/api/local/jarvis/send', '/api/local/yolo/config', '/api/local/config', `/api/local/yolo/${id}/stop`, '/api/nodes/peer/jarvis/send', `/api/local/yolo/${id}/errors/x`]) {
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
    assert.equal((await nullPost('/api/nodes/test-node/jarvis/send', { text: 'implement something' })).status, 403);
    assert.equal((await (await fetch(BASE + '/api/local/yolo/config')).json()).keep, 50, 'config unchanged');
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
  } finally { ws.close(); daemon.kill(); daemon = null; }
});
