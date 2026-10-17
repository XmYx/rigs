// Screen access/control over HTTP and MCP: routes refuse while off, succeed against a stubbed backend, kill at once,
// and announce every action. Only stubs and a throwaway RIGS_HOME are used; no real desktop is touched.
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { EventEmitter } from 'node:events';
import fs from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { after, before, test } from 'node:test';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const root = fs.mkdtempSync(path.join(os.tmpdir(), 'rigs-control-api-'));
process.env.RIGS_HOME = path.join(root, 'default');
const { createControl } = await import('../src/control.js');
const { createControlApi, controlCaller, wireControlEvents } = await import('../src/control-api.js');
const { callerHeader } = await import('../src/mcp.js');

const png = Buffer.from('89504e470d0a1a0a0000000d494844520000064000000384', 'hex'); // header fixture: 1600×900
const facts = { session: 'wayland', desktop: 'gnome', available: { gi: true, mutterScreenCast: 4, mutterRemoteDesktop: 1, 'gst-launch-1.0': true, rigsExtension: true }, displays: [{ id: 'DP-1', width: 3840, height: 2160, scale: 1.5, primary: true }], locked: false };

// ---- in-process: the real route handler over a real HTTP server, with a stub backend ----
let cfg = { name: 'test-node', control: { enabled: true, input: true, leaseIdleSec: 60, maxActionsPerMin: 120, maxShotsPerMin: 30, auditPreview: 64 } };
const calls = [];
const adapter = {
  events: new EventEmitter(),
  inspect: async () => structuredClone(facts),
  configure: async () => {},
  stop: async () => {},
  request: async (op, a) => {
    calls.push([op, a]);
    if (op === 'locked') return { locked: false };
    if (op === 'shot') { fs.writeFileSync(a.file, png); return { display: 'DP-1', sourceWidth: 3840, sourceHeight: 2160 }; }
    if (op === 'windows') return [{ id: 'opaque:2', title: 'Scratch', focused: true }];
    if (op === 'type') return { typed: a.text.length, via: 'keysym' };
    return {};
  },
};
const control = createControl({ platform: 'linux', home: path.join(root, 'inst'), getConfig: () => cfg, persistConfig: (v) => { cfg = v; }, adapter, permissions: async () => ({}), timeoutMs: 500 });
const granted = [];
const api = createControlApi({ control, access: { grant: async (p) => { granted.push(p); return { ok: true, permission: p }; } }, nodeName: () => 'test-node' });
const feed = [];
const wired = wireControlEvents({
  events: control.events, nodeName: () => 'test-node', settings: () => cfg.control,
  broadcast: (m) => feed.push(['ws', m]), notifyAll: async (m) => { feed.push(['notify', m]); }, osNotify: async (t, b) => { feed.push(['os', t, b]); },
});

let srv, base;
before(async () => {
  srv = http.createServer(async (req, res) => {
    const url = new URL(req.url, 'http://x');
    const body = async () => { const c = []; for await (const x of req) c.push(x); return c.length ? JSON.parse(Buffer.concat(c)) : {}; };
    try {
      const out = await api(url.pathname.replace(/^\/control\/?/, ''), req, res, url.searchParams, body);
      if (out !== undefined && !res.headersSent) { res.writeHead(200, { 'content-type': 'application/json' }); res.end(JSON.stringify(out)); }
    } catch (e) {
      res.writeHead(e.status || 500, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ error: e.message, ...(e.name === 'ControlError' ? { code: e.code, ...(e.fix ? { fix: e.fix } : {}) } : {}) }));
    }
  });
  await new Promise((r) => srv.listen(0, '127.0.0.1', r));
  base = `http://127.0.0.1:${srv.address().port}/control`;
});
after(async () => { await control.kill().catch(() => {}); srv?.close(); fs.rmSync(root, { recursive: true, force: true }); });

const AGENT = { 'x-rigs-caller': JSON.stringify({ agent: 'claude', session: 's1', seat: 'seat@rig' }) };
const get = (p, headers = AGENT) => fetch(base + p, { headers });
const post = (p, body = {}, headers = AGENT) => fetch(base + p, { method: 'POST', headers: { 'content-type': 'application/json', ...headers }, body: JSON.stringify(body) });

test('disabled: status answers, every other route refuses with a code', async () => {
  cfg = { ...cfg, control: { ...cfg.control, enabled: false, input: false } };
  const s = await (await get('')).json();
  assert.equal(s.enabled, false);
  for (const r of [await get('/screenshot'), await get('/windows'), await post('/pointer', { action: 'click', x: 1, y: 1 }), await post('/type', { text: 'x' }), await post('/key', { combo: 'enter' }), await post('/focus', { id: 'a' })]) {
    assert.equal(r.status, 403);
    assert.equal((await r.json()).code, 'off');
  }
  assert.deepEqual(calls.filter(([op]) => op !== 'locked'), [], 'a refused call must not reach the desktop');
});

test('enable: an agent is refused, a confirmed human surface succeeds', async () => {
  const refused = await post('/enable', { enabled: true, input: true, confirm: 'test-node' });
  assert.equal(refused.status, 403);
  assert.equal((await refused.json()).code, 'not-allowed');
  const wrong = await post('/enable', { enabled: true, confirm: 'nope' }, {});
  assert.equal(wrong.status, 403);
  const ok = await post('/enable', { enabled: true, input: true, confirm: 'test-node' }, {});
  assert.equal(ok.status, 200);
  assert.equal(cfg.control.enabled, true);
  assert.ok(feed.some(([k, m]) => k === 'notify' && /now on/.test(m.text)));
});

test('enabled: screenshot is an image with scale headers; windows, focus, pointer, type, key reach the backend', async () => {
  const r = await get('/screenshot?maxWidth=800');
  assert.equal(r.status, 200);
  assert.equal(r.headers.get('content-type'), 'image/png');
  assert.ok(r.headers.get('x-rigs-shot'));
  assert.ok(Number(r.headers.get('x-rigs-scale')) > 0);
  assert.deepEqual([...Buffer.from(await r.arrayBuffer()).subarray(0, 4)], [0x89, 0x50, 0x4e, 0x47]);
  const w = await (await get('/windows')).json();
  assert.equal(w[0].title, 'Scratch');
  assert.equal((await post('/focus', { id: 'opaque:2' })).status, 200);
  assert.equal((await post('/pointer', { action: 'click', x: 10, y: 20 })).status, 200);
  const t = await (await post('/type', { text: 'hello', secret: true })).json();
  assert.equal(t.typed, 5);
  assert.equal((await post('/key', { combo: 'ctrl+a' })).status, 200);
  const ops = calls.map(([op]) => op);
  for (const op of ['shot', 'windows', 'focus', 'move', 'type']) assert.ok(ops.includes(op), `${op} reached the backend: ${ops}`);
  const audit = await (await get('/audit?limit=20')).json();
  assert.ok(audit.some((l) => l.op === 'type' && l.args.length === 5 && !JSON.stringify(l).includes('hello')), 'secret text is never logged');
  assert.equal(audit.find((l) => l.op === 'screenshot').caller.agent, 'claude');
});

test('a second agent is refused while the first holds the screen', async () => {
  const r = await get('/windows', { 'x-rigs-caller': JSON.stringify({ agent: 'codex', session: 'other' }) });
  assert.equal(r.status, 409);
  assert.equal((await r.json()).code, 'busy');
});

test('every action is announced: lease notice, native notice, live event and an attention item', () => {
  assert.ok(feed.some(([k, m]) => k === 'notify' && /taking control of test-node/.test(m.text) && m.level === 'attention'), 'lease start notified');
  assert.ok(feed.some(([k, t]) => k === 'os' && t === 'JARVIS is controlling this screen'), 'native notification');
  const ws = feed.filter(([k]) => k === 'ws').map(([, m]) => m);
  assert.ok(ws.some((m) => m.type === 'control' && m.op === 'pointer' && /claude/.test(m.by)));
  const [item] = wired.items();
  assert.equal(item.key, 'control:test-node');
  assert.equal(item.title, 'JARVIS is controlling this screen');
  assert.deepEqual(item.stop, { method: 'POST', path: 'control/kill' });
  assert.ok(item.actions >= 5);
});

test('kill disables control at once, persists, and later calls are refused', async () => {
  const r = await post('/kill', { reason: 'test' });
  assert.equal(r.status, 200);
  assert.equal(cfg.control.enabled, false);
  assert.equal((await get('/screenshot')).status, 403);
  assert.equal((await (await get('')).json()).killed.reason, 'test');
  assert.deepEqual(wired.items(), []);
  assert.ok(feed.some(([k, m]) => k === 'notify' && /was stopped/.test(m.text)));
});

test('input off: looking is allowed, acting is not; wrong method and unknown route', async () => {
  const on = await post('/enable', { enabled: true, input: false, confirm: 'test-node' }, {});
  assert.equal(on.status, 200);
  assert.equal((await get('/windows')).status, 200);
  const r = await post('/pointer', { action: 'click', x: 1, y: 1 });
  assert.equal(r.status, 403);
  assert.equal((await r.json()).code, 'input-off');
  assert.equal((await post('/windows')).status, 405);
  assert.equal((await get('/nope')).status, 404);
});

test('grant is forwarded to the access module', async () => {
  const r = await post('/grant', { permission: 'input' });
  assert.equal(r.status, 200);
  assert.deepEqual(granted, ['input']);
  assert.equal((await post('/grant', {})).status, 400);
});

test('controlCaller: MCP calls are agents, plain requests are people; via comes from the proxy header', () => {
  const agent = controlCaller({ headers: { 'x-rigs-caller': JSON.stringify({ agent: 'codex', session: 'x', seat: 's@r', cwd: '/p' }), 'x-rigs-via': 'macbookpro' }, rigsAuth: { via: 'token', who: 'peer' } }, 'me');
  assert.deepEqual([agent.via, agent.from, agent.agent, agent.human], ['mcp', 'macbookpro', 'codex', false]);
  const human = controlCaller({ headers: {}, rigsAuth: { via: 'loopback', who: 'me' } }, 'me');
  assert.deepEqual([human.via, human.from, human.human], ['loopback', 'me', true]);
  assert.equal(controlCaller({ headers: { 'x-rigs-caller': 'not json' } }, 'me').human, false);
  assert.equal(controlCaller({}, 'me').human, true);
});

test('MCP sends an ASCII-only caller header naming the agent and seat', () => {
  const h = callerHeader({ CLAUDECODE: '1', CLAUDE_CODE_SESSION_ID: 'abc', OPENRIG_SESSION_NAME: 'team-code@rig' }, '/home/ü/proj');
  assert.match(h, /^[\x20-\x7e]+$/);
  const c = JSON.parse(h);
  assert.deepEqual([c.agent, c.session, c.seat, c.cwd], ['claude', 'abc', 'team-code@rig', '/home/ü/proj']);
  assert.equal(JSON.parse(callerHeader({ CODEX_THREAD_ID: 't' }, '/x')).agent, 'codex');
});

// ---- smoke: a real node with the default (on) configuration ----
const HOME = fs.mkdtempSync(path.join(os.tmpdir(), 'rigs-test-'));
const PORT = 20000 + Math.floor(Math.random() * 20000);
const BASE = `http://127.0.0.1:${PORT}`;
let server;

async function startNode() {
  const env = { ...process.env, RIGS_NO_MIGRATIONS: '1', RIGS_NO_AUTOUPDATE: '1', RIGS_NO_OPENRIG: '1', RIGS_HOME: HOME, RIGS_SSH_DIR: path.join(HOME, 'ssh'), RIGS_PORT: String(PORT), RIGS_NAME: 'test-node', RIGS_PEERS: '', RIGS_MESH_TOKEN: 'test-token' };
  server = spawn(process.execPath, [path.join(ROOT, 'bin/rigs.js'), 'serve'], { env, stdio: ['ignore', 'pipe', 'pipe'] });
  let out = '';
  server.stdout.on('data', (d) => { out += d; });
  server.stderr.on('data', (d) => { out += d; });
  for (let i = 0; i < 100; i++) {
    try { if ((await fetch(BASE + '/api/self')).ok) return; } catch {}
    await new Promise((r) => setTimeout(r, 200));
  }
  throw new Error('server did not start:\n' + out);
}
async function stopNode() {
  if (!server || server.exitCode != null) return;
  const exited = new Promise((r) => server.once('exit', r));
  server.kill();
  await exited;
}
before(startNode);
after(async () => { await stopNode(); fs.rmSync(HOME, { recursive: true, force: true }); });

const json = { 'content-type': 'application/json' };
const controlStatus = async () => (await fetch(`${BASE}/api/local/control`)).json();

test('smoke: a fresh node has control on; settings and agents cannot change it; a kill refuses every route and survives a restart', async () => {
  await fetch(`${BASE}/api/nodes`); // the first mesh scan registers this node, so /api/nodes/self resolves
  const s = await controlStatus();
  assert.equal(s.enabled, true);
  assert.equal(s.input, true);
  assert.equal(s.killed, null);
  // Only status is read while on: action routes would act on the desktop of the machine running the tests.
  await fetch(`${BASE}/api/local/config`, { method: 'POST', headers: json, body: JSON.stringify({ control: { enabled: false, input: false, allowFrom: ['x'] } }) });
  const patched = await controlStatus();
  assert.deepEqual([patched.enabled, patched.input], [true, true], 'a generic settings save cannot change control');
  const agentOff = await fetch(`${BASE}/api/local/control/enable`, { method: 'POST', headers: { ...json, 'x-rigs-caller': '{"agent":"claude"}' }, body: JSON.stringify({ enabled: true, input: true, confirm: 'test-node' }) });
  assert.equal(agentOff.status, 403, 'no agent may (re-)enable control');

  const k = await fetch(`${BASE}/api/local/control/kill`, { method: 'POST', headers: json, body: '{"reason":"smoke"}' });
  assert.equal(k.status, 200);
  const refused = async () => {
    for (const [method, p, body] of [['GET', '/screenshot'], ['GET', '/windows'], ['POST', '/pointer', { action: 'click', x: 1, y: 1 }], ['POST', '/type', { text: 'x' }], ['POST', '/key', { combo: 'enter' }]]) {
      for (const prefix of ['/api/local/control', '/api/nodes/self/control']) {
        const r = await fetch(BASE + prefix + p, { method, headers: json, body: body ? JSON.stringify(body) : undefined });
        assert.equal(r.status, 403, `${method} ${prefix}${p}`);
        assert.equal((await r.json()).code, 'off');
      }
    }
  };
  let st = await controlStatus();
  assert.deepEqual([st.enabled, st.input, st.killed?.reason], [false, false, 'smoke']);
  await refused();
  await fetch(`${BASE}/api/local/config`, { method: 'POST', headers: json, body: JSON.stringify({ control: { enabled: true, input: true } }) });
  assert.equal((await controlStatus()).enabled, false, 'a generic settings save cannot undo a kill');

  // Restart: the kill marker and the off config are on disk, so the node comes back killed.
  await stopNode();
  await startNode();
  await fetch(`${BASE}/api/nodes`);
  st = await controlStatus();
  assert.deepEqual([st.enabled, st.input, st.killed?.reason], [false, false, 'smoke']);
  await refused();
});
