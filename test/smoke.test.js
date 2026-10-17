// End-to-end smoke test: boots a real node on a random port with a throwaway RIGS_HOME and
// exercises the API the UI and the MCP tools rely on. Runs on macOS, Ubuntu and Windows in CI.
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { after, before, test } from 'node:test';
import { fileURLToPath } from 'node:url';
import WebSocket from 'ws';
import { speakable } from '../src/tts.js';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const HOME = fs.mkdtempSync(path.join(os.tmpdir(), 'rigs-test-'));
const PORT = 20000 + Math.floor(Math.random() * 20000);
const BASE = `http://127.0.0.1:${PORT}`;
const env = { ...process.env, RIGS_NO_MIGRATIONS: '1', RIGS_NO_AUTOUPDATE: '1', RIGS_NO_OPENRIG: '1', RIGS_HOME: HOME, RIGS_SSH_DIR: path.join(HOME, 'ssh'), RIGS_PORT: String(PORT), RIGS_NAME: 'test-node', RIGS_PEERS: '', RIGS_MESH_TOKEN: 'test-token',
  // App Store: launcher scripts instead of systemd units, and nothing outside this throwaway home.
  RIGS_NO_SYSTEMD: '1', RIGS_SYSTEMD_USER_DIR: path.join(HOME, 'systemd-user'), RIGS_GPU_OVERSEER_CLIENTS: path.join(HOME, 'gpu-overseer', 'clients.json') };
let server;

async function get(p) {
  const r = await fetch(BASE + p);
  assert.equal(r.status, 200, `${p} → ${r.status} ${await r.clone().text()}`);
  return r.json();
}
async function post(p, body) {
  const r = await fetch(BASE + p, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) });
  const j = await r.json();
  assert.equal(r.status, 200, `${p} → ${r.status} ${JSON.stringify(j)}`);
  return j;
}

before(async () => {
  server = spawn(process.execPath, [path.join(ROOT, 'bin/rigs.js'), 'serve'], { env, stdio: ['ignore', 'pipe', 'pipe'] });
  let out = '';
  server.stdout.on('data', (d) => { out += d; });
  server.stderr.on('data', (d) => { out += d; });
  for (let i = 0; i < 100; i++) {
    try { if ((await fetch(BASE + '/api/self')).ok) return; } catch {}
    await new Promise((r) => setTimeout(r, 200));
  }
  throw new Error('server did not start:\n' + out);
});

after(() => {
  // An App Store app the tests started outlives the server; stop it before removing the home.
  for (const id of ['hello']) {
    try { const p = JSON.parse(fs.readFileSync(path.join(HOME, 'apps', id, 'app.pid'), 'utf8')); for (const pid of [p.child, p.launcher]) try { process.kill(pid); } catch {} } catch {}
  }
  server?.kill();
  fs.rmSync(HOME, { recursive: true, force: true });
});

test('serves the UI shell', async () => {
  const r = await fetch(BASE + '/');
  assert.equal(r.status, 200);
  assert.match(await r.text(), /RIGS OS/);
});

test('node info + mesh list include this node', async () => {
  const info = await get('/api/local/info');
  assert.equal(info.name, 'test-node');
  assert.ok(['mac', 'linux', 'windows'].includes(info.platform));
  assert.ok(info.stats.memTotal > 0);
  const nodes = await get('/api/nodes');
  assert.ok(nodes.find((n) => n.self && n.name === 'test-node'));
});

test('files: write, list, read, rename, trash', async () => {
  const dir = path.join(HOME, 'files');
  await post('/api/nodes/self/files/mkdir', { path: dir });
  await post('/api/nodes/self/files/text', { path: path.join(dir, 'a.txt'), text: 'hello mesh' });
  const put = await fetch(`${BASE}/api/nodes/self/files/write?path=${encodeURIComponent(path.join(dir, 'b.bin'))}`, { method: 'PUT', body: Buffer.from([1, 2, 3]) });
  assert.equal(put.status, 200);
  const list = await get(`/api/nodes/self/files?path=${encodeURIComponent(dir)}`);
  assert.deepEqual(list.entries.map((e) => e.name).sort(), ['a.txt', 'b.bin']);
  const read = await get(`/api/nodes/self/files/read?path=${encodeURIComponent(path.join(dir, 'a.txt'))}`);
  assert.equal(read.text, 'hello mesh');
  await post('/api/nodes/self/files/rename', { from: path.join(dir, 'a.txt'), to: path.join(dir, 'c.txt') });
  await post('/api/nodes/self/files/trash', { path: path.join(dir, 'c.txt') });
  const after2 = await get(`/api/nodes/self/files?path=${encodeURIComponent(dir)}`);
  assert.deepEqual(after2.entries.map((e) => e.name), ['b.bin']);
});

test('exec runs a shell command', async () => {
  const r = await post('/api/nodes/self/exec', { command: 'echo rigs-$((40+2))'.replace('$((40+2))', process.platform === 'win32' ? '$(40+2)' : '$((40+2))') });
  assert.equal(r.code, 0, r.stderr);
  assert.match(r.stdout, /rigs-42/);
});

test('terminal over WebSocket', async () => {
  const { id } = await post('/api/nodes/self/pty', { cols: 100, rows: 30 });
  const ws = new WebSocket(`ws://127.0.0.1:${PORT}/api/nodes/self/pty/${id}/ws`);
  let out = '';
  ws.on('message', (m) => { const j = JSON.parse(m); if (j.t === 'o') out += j.d; });
  await new Promise((r, j) => { ws.once('open', r); ws.once('error', j); });
  const marker = 'PTYOK' + Date.now();
  // Give slow login shells time to come up, then type until we see the echo.
  for (let i = 0; i < 40 && !out.includes(marker + '!'); i++) {
    if (i % 8 === 0) ws.send(JSON.stringify({ t: 'i', d: `echo ${marker}!\r` }));
    await new Promise((r) => setTimeout(r, 500));
  }
  ws.close();
  assert.ok(out.includes(marker + '!'), 'terminal echoed the marker');
});

test('sessions list includes the live terminal', async () => {
  const s = await get('/api/nodes/self/sessions');
  assert.ok(Array.isArray(s));
  assert.ok(s.some((x) => x.kind === 'pty'));
});

test('chats: create, list, delete', async () => {
  const c = await post('/api/nodes/self/chats', { brain: 'auto', title: 'test' });
  const list = await get('/api/nodes/self/chats');
  assert.ok(list.find((x) => x.id === c.id));
  const r = await fetch(`${BASE}/api/nodes/self/chats/${c.id}`, { method: 'DELETE' });
  assert.equal(r.status, 200);
});

test('rejects non-local callers without credentials', async () => {
  // Requests that claim a tailnet identity through the serve headers must match the owner.
  const r = await fetch(BASE + '/api/nodes', { headers: { 'tailscale-user-login': 'stranger@example.com' } });
  assert.equal(r.status, 403);
});

test('MCP server lists mesh tools and answers mesh_status', async () => {
  const mcp = spawn(process.execPath, [path.join(ROOT, 'bin/rigs.js'), 'mcp'], { env, stdio: ['pipe', 'pipe', 'inherit'] });
  const lines = [];
  let buf = '';
  mcp.stdout.on('data', (d) => { buf += d; let i; while ((i = buf.indexOf('\n')) >= 0) { lines.push(JSON.parse(buf.slice(0, i))); buf = buf.slice(i + 1); } });
  const send = (m) => mcp.stdin.write(JSON.stringify(m) + '\n');
  send({ jsonrpc: '2.0', id: 1, method: 'initialize', params: { protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name: 't', version: '1' } } });
  send({ jsonrpc: '2.0', id: 2, method: 'tools/list' });
  send({ jsonrpc: '2.0', id: 3, method: 'tools/call', params: { name: 'mesh_status', arguments: {} } });
  for (let i = 0; i < 50 && lines.length < 3; i++) await new Promise((r) => setTimeout(r, 200));
  mcp.kill();
  const byId = Object.fromEntries(lines.map((l) => [l.id, l]));
  assert.equal(byId[1].result.serverInfo.name, 'rigs');
  assert.ok(byId[2].result.tools.some((t) => t.name === 'mesh_exec'));
  assert.match(byId[3].result.content[0].text, /test-node/);
});

test('models catalog + core brain round-trip', async () => {
  const cat = await get('/api/local/models');
  assert.ok(Array.isArray(cat));
  const set = await post('/api/local/brain/core', { provider: 'claude', model: 'claude-opus-5-5', effort: 'high' });
  assert.equal(set.model, 'claude-opus-5-5');
  assert.equal((await get('/api/local/brain/core')).effort, 'high');
});

test('projects: create, add task by hand, route, delete', async () => {
  const p = await post('/api/nodes/self/projects', { name: 'smoke', goal: 'test the planner API' });
  assert.equal(p.policy, 'builtin:auto', 'project agents run in auto mode by default');
  const withTask = await post(`/api/nodes/self/projects/${p.id}/tasks`, { title: 'write docs', kind: 'docs' });
  assert.equal(withTask.tasks.length, 1);
  assert.equal(withTask.status, 'planned');
  const routed = await post(`/api/nodes/self/projects/${p.id}/route`, { unlock: true });
  assert.ok('reason' in routed.tasks[0]);
  const r = await fetch(`${BASE}/api/nodes/self/projects/${p.id}`, { method: 'DELETE' });
  assert.equal(r.status, 200);
});

test('tts: speakable text + engine info (engine-independent)', async () => {
  assert.equal(speakable('## Done\n\nSee **[the docs](https://x.y/z)** and `rigs start`.\n```js\nconsole.log(1)\n```\nBye.'), 'Done See the docs and rigs start. Bye.');
  assert.equal(speakable('   '), '');
  assert.equal(speakable('a'.repeat(5000)).length, 4000);
  const info = await get('/api/local/tts');
  assert.ok('engine' in info && Array.isArray(info.voices));
});

test('access: the node can read and write its home', async () => {
  const a = await get('/api/local/access?force=1');
  assert.equal(a.home.read, true);
  assert.equal(a.home.write, true);
  assert.ok(Array.isArray(a.folders));
});

test('attention: feed per node + mesh-wide, codex hook endpoint', async () => {
  assert.ok(Array.isArray(await get('/api/local/attention')));
  const mesh = await get('/api/mesh/attention');
  assert.ok(mesh.some((g) => g.node && Array.isArray(g.items)));
  const r = await post('/api/local/attention/codex', { type: 'agent-turn-complete', 'thread-id': 'smoke' });
  assert.equal(r.ok, true);
});

// ---------------------------------------------------------------- App Store (src/appstore.js)

const HELLO_PORT = 40000 + Math.floor(Math.random() * 20000);
function putHello() {
  // A tiny node app from test/fixtures, copied out of the repo, launched by the launcher script (RIGS_NO_SYSTEMD).
  fs.mkdirSync(path.join(HOME, 'appstore', 'catalog'), { recursive: true });
  fs.writeFileSync(path.join(HOME, 'appstore', 'catalog', 'hello.json'), JSON.stringify({
    id: 'hello', name: 'Hello', icon: '👋', description: 'smoke-test app', version: '1.0.0',
    source: { type: 'rigs', path: 'test/fixtures/appstore-hello', copy: true }, runtime: { type: 'node' },
    port: HELLO_PORT, healthPath: '/healthz', healthTimeoutSec: 30, env: { HELLO_PORT: '{port}' },
    launch: { command: ['{node}', '{appDir}/server.mjs'] },
  }));
}
async function helloAnswers() {
  try { return (await fetch(`http://127.0.0.1:${HELLO_PORT}/healthz`, { signal: AbortSignal.timeout(1000) })).ok; } catch { return false; }
}
async function waitFor(pred, ms = 10000) {
  for (const end = Date.now() + ms; Date.now() < end; await new Promise((r) => setTimeout(r, 200))) if (await pred()) return true;
  return false;
}

test('App Store API: catalog, install end to end, open through the App Cloud, uninstall to trash', async () => {
  putHello();
  const cat = await get('/api/local/appstore');
  assert.deepEqual(cat.errors, []);
  assert.equal(cat.node, 'test-node');
  assert.ok(cat.apps.some((a) => a.id === 'navigation'), 'the built-in catalog is served');
  assert.equal(cat.apps.find((a) => a.id === 'hello').install.state, 'not-installed');
  assert.ok((await get('/api/nodes/self/appstore')).apps.some((a) => a.id === 'hello'), 'reachable through /api/nodes/<node>/');
  assert.equal((await get('/api/local/appstore/hello')).manifest.port, HELLO_PORT);

  const started = await post('/api/nodes/self/appstore/hello/install', {});
  assert.equal(started.state, 'running');
  let job;
  await waitFor(async () => (job = await get('/api/local/appstore/hello/job')).state !== 'running', 60000);
  assert.equal(job.state, 'done', JSON.stringify(job, null, 2));
  assert.deepEqual(job.steps.map((s) => s.status), ['done', 'done', 'skipped', 'skipped', 'skipped', 'skipped', 'done', 'done', 'done']);
  assert.ok(job.log.some((l) => /Hello is installed/.test(l)));
  const app = (await get('/api/local/apps')).apps.find((a) => a.id === 'hello');
  assert.match(app.launch.command, /launch\.mjs/);
  const page = await fetch(`${BASE}/api/nodes/self/apps/hello/`);
  assert.equal(await page.text(), 'hello from the app store');
  assert.equal((await get('/api/local/appstore')).apps.find((a) => a.id === 'hello').install.state, 'installed');

  const out = await post('/api/local/appstore/hello/uninstall', {});
  assert.equal(out.unregistered, true);
  assert.ok(out.stopped.length >= 1, JSON.stringify(out));
  assert.ok(out.trashed.some((p) => p.startsWith(path.join(HOME, 'trash'))), JSON.stringify(out));
  assert.ok(await waitFor(async () => !(await helloAnswers())), 'the app is stopped');
  assert.ok(!(await get('/api/local/apps')).apps.some((a) => a.id === 'hello'));
  assert.equal((await get('/api/local/appstore')).apps.find((a) => a.id === 'hello').install.state, 'not-installed');

  const missing = await fetch(`${BASE}/api/local/appstore/nope/install`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: '{}' });
  assert.equal(missing.status, 404);
  const badPort = await fetch(`${BASE}/api/local/appstore/hello/install`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: '{"port":0}' });
  assert.equal(badPort.status, 400);
});

test('App Store MCP tools: appstore_list and appstore_install (wait, then uninstall)', async () => {
  putHello();
  const mcp = spawn(process.execPath, [path.join(ROOT, 'bin/rigs.js'), 'mcp'], { env, stdio: ['pipe', 'pipe', 'inherit'] });
  const replies = new Map();
  let buf = '';
  mcp.stdout.on('data', (d) => { buf += d; let i; while ((i = buf.indexOf('\n')) >= 0) { const msg = JSON.parse(buf.slice(0, i)); replies.set(msg.id, msg); buf = buf.slice(i + 1); } });
  let next = 1;
  const call = async (name, args) => {
    const id = ++next;
    mcp.stdin.write(JSON.stringify({ jsonrpc: '2.0', id, method: 'tools/call', params: { name, arguments: args } }) + '\n');
    await waitFor(() => replies.has(id), 90000);
    const r = replies.get(id).result;
    assert.ok(!r.isError, r.content[0].text);
    return JSON.parse(r.content[0].text);
  };
  try {
    mcp.stdin.write(JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'initialize', params: { protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name: 't', version: '1' } } }) + '\n');
    const listed = await call('appstore_list', {});
    assert.equal(listed.node, 'test-node');
    assert.equal(listed.apps.find((a) => a.id === 'hello').install.state, 'not-installed');
    const job = await call('appstore_install', { id: 'hello', wait: true, waitSec: 60 });
    assert.equal(job.state, 'done', JSON.stringify(job, null, 2));
    assert.ok(job.steps.some((s) => s.startsWith('✓ Register in the App Cloud')), job.steps.join('\n'));
    assert.ok(await helloAnswers());
    assert.equal((await call('appstore_list', { node: 'self' })).apps.find((a) => a.id === 'hello').install.state, 'installed');
    const out = await call('appstore_install', { id: 'hello', uninstall: true });
    assert.equal(out.unregistered, true);
    assert.ok(await waitFor(async () => !(await helloAnswers())), 'the app is stopped');
  } finally { mcp.kill(); }
});

test('App Cloud registration accepts and persists per-OS launch recipes (POST /api/local/apps and mesh_app_register)', async () => {
  const launch = { systemd: 'dual.service', windows: { command: 'dual.cmd --port 18299', cwd: '~\\dual', env: { DUAL: '1' } }, darwin: { command: 'dual-mac' } };
  const r = await post('/api/local/apps', { id: 'dual', name: 'Dual', port: 18299, healthPath: '/healthz', launch });
  const app = r.apps.find((a) => a.id === 'dual');
  assert.deepEqual(app.launch, launch);
  const here = { linux: { systemd: 'dual.service' }, darwin: { command: 'dual-mac', cwd: '', env: {} }, win32: { command: 'dual.cmd --port 18299', cwd: '~\\dual', env: { DUAL: '1' } } }[process.platform];
  assert.deepEqual(app.launchHere, here);
  const saved = JSON.parse(fs.readFileSync(path.join(HOME, 'config.json'), 'utf8')).apps.find((a) => a.id === 'dual');
  assert.deepEqual(saved.launch, launch);
  const bad = await fetch(`${BASE}/api/local/apps`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ id: 'bad', port: 1, launch: { windows: { systemd: 'x' } } }) });
  assert.equal(bad.status, 400);
  assert.match(await bad.text(), /Linux only/);

  // mesh_app_register goes through /api/nodes/self/…, which answers once the first discovery scan has run.
  assert.ok(await waitFor(async () => (await fetch(`${BASE}/api/nodes/self/apps`)).ok, 30000), 'discovery knows this node');
  const mcp = spawn(process.execPath, [path.join(ROOT, 'bin/rigs.js'), 'mcp'], { env, stdio: ['pipe', 'pipe', 'inherit'] });
  const replies = new Map();
  let buf = '';
  mcp.stdout.on('data', (d) => { buf += d; let i; while ((i = buf.indexOf('\n')) >= 0) { const msg = JSON.parse(buf.slice(0, i)); replies.set(msg.id, msg); buf = buf.slice(i + 1); } });
  try {
    mcp.stdin.write(JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'initialize', params: { protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name: 't', version: '1' } } }) + '\n');
    mcp.stdin.write(JSON.stringify({ jsonrpc: '2.0', id: 2, method: 'tools/list', params: {} }) + '\n');
    await waitFor(() => replies.has(2), 30000);
    const schema = replies.get(2).result.tools.find((t) => t.name === 'mesh_app_register').inputSchema.properties.launch;
    for (const k of ['systemd', 'command', 'linux', 'darwin', 'windows']) assert.ok(schema.properties[k], `launch.${k} in the schema`);
    const mlaunch = { systemd: 'mcpdual.service', windows: { command: 'mcpdual.exe' } };
    mcp.stdin.write(JSON.stringify({ jsonrpc: '2.0', id: 3, method: 'tools/call', params: { name: 'mesh_app_register', arguments: { node: 'self', id: 'mcpdual', port: 18298, launch: mlaunch } } }) + '\n');
    await waitFor(() => replies.has(3), 30000);
    assert.ok(!replies.get(3).result.isError, replies.get(3).result.content[0].text);
    assert.deepEqual((await get('/api/local/apps')).apps.find((a) => a.id === 'mcpdual').launch, mlaunch);
  } finally { mcp.kill(); }
  for (const id of ['dual', 'mcpdual']) await post('/api/local/apps', { id, remove: true });
});
