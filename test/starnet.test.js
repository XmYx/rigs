// StarNet space-station view (experimental; src/starnet.js, ui/src/starnet/, ui/starnet/): the station model built from
// the galaxy's data (deterministic, capped, ids back to JARVIS nodes), the flag (default off, old configs stay off,
// patch validation), the install subset and the /starnet/ route — and one scratch node end to end: 404 while off, the
// settings API and WS push switching it, an install from a local checkout (no sounds, LICENSE kept), the frame's index
// with the RIGS boot in front, the station frame fenced off the RIGS API, `rigs starnet` on/off/status/remove.
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { after, before, test } from 'node:test';
import { fileURLToPath } from 'node:url';
import WebSocket from 'ws';

const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'rigs-starnet-'));
Object.assign(process.env, { RIGS_HOME: path.join(TMP, 'unit'), RIGS_NO_OPENRIG: '1', RIGS_NO_AUTOUPDATE: '1', RIGS_NO_MIGRATIONS: '1' });
after(() => fs.rmSync(TMP, { recursive: true, force: true }));

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const S = await import('../src/starnet.js');
const M = await import('../ui/src/starnet/model.js');

// ------------------------------------------------------------------ model

const NOW = 1_800_000_000_000;
const sess = (machine, kind, id, o = {}) => ({ id: `s:${machine}:${kind}:${id}`, type: o.live ? 'live' : 'session', machine, name: o.title || id, session: { kind, id, title: o.title || id, project: o.project || '', live: !!o.live, updatedAt: o.updatedAt ?? NOW - 60000 } });
function graph({ machines = 2, perMachine = 3, offline = 1 } = {}) {
  const nodes = [{ id: 'mesh', type: 'mesh', name: 'TAILNET' }];
  for (let i = 0; i < machines; i++) {
    const m = `n${i}`;
    nodes.push({ id: `m:${m}`, type: 'machine', name: `box-${i}`, machine: m, platform: ['darwin', 'linux', 'win32'][i % 3] });
    for (let j = 0; j < perMachine; j++) nodes.push(sess(m, j % 2 ? 'codex' : 'claude', `${i}-${j}`, { live: j === 0, project: `proj${j}` }));
    nodes.push(sess(m, 'tmux', `${i}-shell`, { live: true })); // a shell is not a worker
    nodes.push({ id: `chat:${m}`, type: 'chat', machine: m, session: { kind: 'chat', id: 'c', live: false, updatedAt: NOW } });
  }
  for (let i = 0; i < offline; i++) nodes.push({ id: `m:off${i}`, type: 'offline', name: `gone-${i}`, machine: `off${i}` });
  nodes.push({ id: 'pj:p1', type: 'plan', name: 'Plan', plan: { status: 'running', tasks: [{ id: 't1', status: 'running' }] } });
  return { nodes, links: [] };
}

test('model: machines become rooms off the corridor, agent sessions become workers with desks', () => {
  const s = M.stationFromGraph(graph(), { now: NOW });
  const rooms = Object.values(s.doc.rooms);
  assert.equal(rooms.filter((r) => r.kind === 'corridor').length, 1);
  assert.equal(rooms.filter((r) => r.kind === 'bridge').length, 1, 'the bridge (JARVIS) room');
  assert.equal(rooms.length, 2 + 2 + 1, 'corridor + bridge + 2 machines + 1 offline');
  assert.equal(s.workers.length, 6, '3 agent sessions per machine; the tmux shell and the chat are not workers');
  for (const w of s.workers) {
    assert.ok(s.doc.props.some((p) => p.t === 'desk' && p.agentId === w.id), `${w.id} has a desk`);
    assert.equal(s.ids[w.id], w.node, 'worker id maps back to its JARVIS session node');
    assert.ok(w.room && s.doc.rooms[w.room], 'worker lives in its machine room');
    assert.ok(!w.id.includes(':'), 'StarNet-side ids carry no JARVIS session ids');
  }
  assert.equal(s.workers.filter((w) => w.working).length, 2, 'live sessions work');
  assert.equal(s.ids[s.rooms['m:n0']], 'm:n0', 'room ids map back to the machine node');
  assert.equal(s.rooms.mesh, 'bridge');
  assert.equal(s.ids.jarvis, 'mesh');
  assert.ok(s.hero.working, 'JARVIS works while a plan has a running task');
  const off = rooms.find((r) => r.kind === 'storage');
  assert.match(off.name, /OFFLINE/);
  const offProps = s.doc.props.filter((p) => p.x >= off.rects[0].x1 && p.x <= off.rects[0].x2 && p.y >= off.rects[0].y1 && p.y <= off.rects[0].y2);
  assert.ok(!offProps.some((p) => p.t === 'desk'), 'nobody works in an offline room');
});

test('model: rooms touch the corridor and never overlap each other', () => {
  for (const machines of [1, 2, 3, 6, 9]) {
    const s = M.stationFromGraph(graph({ machines, perMachine: 1, offline: 0 }), { now: NOW });
    const rects = Object.values(s.doc.rooms).map((r) => ({ id: r.id, kind: r.kind, ...r.rects[0] }));
    const cor = rects.find((r) => r.kind === 'corridor');
    for (const a of rects) {
      for (const b of rects) if (a !== b) assert.ok(a.x2 < b.x1 || b.x2 < a.x1 || a.y2 < b.y1 || b.y2 < a.y1, `${a.id} overlaps ${b.id}`);
      if (a === cor) continue;
      assert.ok(a.y2 + 1 === cor.y1 || a.y1 - 1 === cor.y2, `${a.id} touches the corridor (auto-door)`);
      assert.ok(a.x1 >= cor.x1 && a.x2 <= cor.x2, `${a.id} is along the corridor`);
    }
    assert.ok(cor.x2 - cor.x1 + 1 <= 240, 'within StarNet\'s station span');
  }
});

test('model: deterministic — the same mesh gives the same station whatever the node order; the key follows layout only', () => {
  const g = graph({ machines: 3 });
  const a = M.stationFromGraph(g, { now: NOW });
  const b = M.stationFromGraph({ nodes: [...g.nodes].reverse(), links: [] }, { now: NOW });
  assert.deepEqual(a, b);
  // a session finishing its turn changes work state, not the layout
  const g2 = structuredClone(g);
  g2.nodes.find((n) => n.session?.live && n.session.kind === 'claude').session.live = false;
  const c = M.stationFromGraph(g2, { now: NOW });
  assert.equal(c.key, a.key);
  assert.notDeepEqual(c.workers, a.workers);
  // a new machine re-lays the floor
  assert.notEqual(M.stationFromGraph(graph({ machines: 4 }), { now: NOW }).key, a.key);
});

test('model: workers are capped per room, needs-you and live first; stale idle sessions have gone home', () => {
  const g = graph({ machines: 1, perMachine: 0, offline: 0 });
  for (let j = 0; j < 20; j++) g.nodes.push(sess('n0', 'claude', `x${j}`, { updatedAt: NOW - j * 60000 }));
  g.nodes.push(sess('n0', 'claude', 'old', { updatedAt: NOW - 13 * 3600000 }));
  g.nodes.push(sess('n0', 'codex', 'live', { live: true, updatedAt: NOW - 20 * 3600000 }));
  g.nodes.push(sess('n0', 'claude', 'ask', { updatedAt: NOW - 20 * 3600000 }));
  const s = M.stationFromGraph(g, { now: NOW, attention: new Set(['s:n0:claude:ask']) });
  assert.equal(s.workers.length, M.MAX_WORKERS);
  assert.equal(s.ids[s.workers[0].id], 's:n0:claude:ask');
  assert.ok(s.workers[0].attention);
  assert.equal(s.ids[s.workers[1].id], 's:n0:codex:live');
  assert.ok(!s.workers.some((w) => s.ids[w.id] === 's:n0:claude:old'));
  assert.equal(new Set(s.doc.props.filter((p) => p.t === 'desk').map((p) => `${p.x},${p.y}`)).size, M.MAX_WORKERS + 1, 'one desk each (+ JARVIS), none stacked');
});

test('model: an agent in tmux or a terminal (as agents/start runs it) is a worker; a shell is not', () => {
  assert.equal(M.workerKind({ kind: 'tmux', agent: 'claude' }), 'claude');
  assert.equal(M.workerKind({ kind: 'pty', agent: 'codex' }), 'codex');
  assert.equal(M.workerKind({ kind: 'rig', agent: 'claude' }), 'rig');
  for (const s of [{ kind: 'tmux', agent: 'shell' }, { kind: 'tmux', agent: 'ssh' }, { kind: 'pty', agent: 'shell' }, { kind: 'chat', agent: 'claude' }, null]) assert.equal(M.workerKind(s), null, JSON.stringify(s));
  const g = graph({ machines: 1, perMachine: 0, offline: 0 });
  g.nodes.push({ id: 's:n0:tmux:claude-x-1a2b', type: 'live', machine: 'n0', session: { kind: 'tmux', agent: 'claude', id: 'claude-x-1a2b', title: 'claude-x-1a2b', project: 'x', live: true, updatedAt: NOW } });
  const s = M.stationFromGraph(g, { now: NOW });
  assert.deepEqual(s.workers.map((w) => [s.ids[w.id], w.color, w.working]), [['s:n0:tmux:claude-x-1a2b', '#f5a65b', true]], 'one worker, coloured as Claude, at its desk');
});

test('model: apps and tools are clickable props; everything on a machine frames its room; plans and tasks the bridge', () => {
  const g = graph({ machines: 2, perMachine: 1, offline: 0 });
  g.nodes.push(
    { id: 'app:n0:b', type: 'app', machine: 'n0', name: 'B' }, { id: 'app:n0:a', type: 'app', machine: 'n0', name: 'A' }, { id: 'app:n0:c', type: 'app', machine: 'n0', name: 'C' },
    { id: 'tool:n0:z', type: 'tool', machine: 'n0', name: 'Z' }, { id: 'tool:n0:y', type: 'tool', machine: 'n0', name: 'Y' },
    { id: 'a:n1:codex', type: 'agent', machine: 'n1', agent: 'codex' }, { id: 'o:n1:llama', type: 'model', machine: 'n1' },
    { id: 'tk:p1:t1', type: 'task', name: 't1' }, { id: 'p:proj0', type: 'project', name: 'proj0', machines: ['n1', 'n0'] });
  const s = M.stationFromGraph(g, { now: NOW });
  const target = (t) => s.doc.props.filter((p) => p.t === t).map((p) => s.ids[p.id]);
  assert.deepEqual(target('gigs_servercart'), ['app:n0:a', 'app:n0:b'], 'two carts, the first apps by id');
  assert.deepEqual(target('studio'), ['tool:n0:y']);
  assert.ok(target('workbench').every(Boolean) && target('war_intelcab').length === 2, 'workbenches and intel cabinets select too');
  const r0 = s.rooms['m:n0'];
  const r1 = s.rooms['m:n1'];
  assert.equal(s.rooms['app:n0:c'], r0, 'an app without a cart still frames its room');
  assert.equal(s.rooms['a:n1:codex'], r1);
  assert.equal(s.rooms['o:n1:llama'], r1);
  assert.equal(s.rooms['pj:p1'], 'bridge');
  assert.equal(s.rooms['tk:p1:t1'], 'bridge');
  assert.equal(s.rooms['p:proj0'], [r0, r1].sort()[0], 'a project frames the first of its rooms');
  assert.deepEqual(M.stationFromGraph({ nodes: [...g.nodes].reverse(), links: [] }, { now: NOW }), s, 'still deterministic');
});

test('model: sessions with no desk are counted per room, never dropped silently', () => {
  const g = graph({ machines: 2, perMachine: 0, offline: 0 });
  for (let j = 0; j < 11; j++) g.nodes.push(sess('n0', 'claude', `x${j}`, { updatedAt: NOW - j * 60000 }));
  for (let j = 0; j < 4; j++) g.nodes.push(sess('n0', 'codex', `old${j}`, { updatedAt: NOW - 13 * 3600000 }));
  g.nodes.push(sess('n1', 'claude', 'one'));
  const s = M.stationFromGraph(g, { now: NOW });
  assert.deepEqual(s.overflow, { [s.rooms['m:n0']]: { desks: 3, older: 4 } }, 'n0: 3 past the 8 desks, 4 idle for over 12 h; n1 has room for all');
  assert.equal(s.workers.length, M.MAX_WORKERS + 1);
});

test('model: Filters apply — hidden session types leave the floor, hidden offline machines leave the station', () => {
  const s = M.stationFromGraph(graph(), { now: NOW, hidden: ['session', 'live', 'offline'] });
  assert.equal(s.workers.length, 0);
  assert.ok(!Object.values(s.doc.rooms).some((r) => r.kind === 'storage'));
});

test('model: diffWorkers says what to spawn, rename, light, dim and despawn', () => {
  const a = [{ id: 'w1', name: 'a', working: false }, { id: 'w2', name: 'b', working: true, attention: false }];
  const b = [{ id: 'w2', name: 'B', working: false, attention: true }, { id: 'w3', name: 'c', working: true }];
  assert.deepEqual(M.diffWorkers(a, b), { spawn: [b[1]], despawn: ['w1'], rename: [b[0]], work: ['w3'], idle: ['w2'], wait: ['w2'], release: [] });
});

test('sessions: a tmux session started by agents/start is that agent, even when the command does not say so', async () => {
  const { tmuxAgent } = await import('../src/sessions.js');
  assert.equal(tmuxAgent('claude-app-1a2b', '2.1.303'), 'claude', 'Claude Code\'s native binary titles its process with its version');
  assert.equal(tmuxAgent('codex-app-1a2b', 'node'), 'codex');
  assert.equal(tmuxAgent('claude-app-1a2b', 'zsh'), 'shell', 'the agent exited back to its shell');
  assert.equal(tmuxAgent('work', 'claude'), 'claude');
  assert.equal(tmuxAgent('work', 'bash'), 'shell');
  assert.equal(tmuxAgent('ssh-mac--2', 'ssh'), 'ssh');
});

// ------------------------------------------------------------------ flag, subset, route

test('flag: off by default, an old config without it stays off, the pinned ref unless a full sha is set', async () => {
  const { config } = await import('../src/config.js');
  assert.equal(config().experimental.starnet.enabled, false);
  assert.equal(S.settings({}).enabled, false);
  assert.equal(S.settings({ exhibits: { enabled: true } }).enabled, false);
  assert.equal(S.settings({ experimental: { starnet: { enabled: 'yes' } } }).enabled, false, 'only true is on');
  assert.equal(S.settings({}).ref, S.PINNED_REF);
  assert.equal(S.settings({ experimental: { starnet: { ref: 'main' } } }).ref, S.PINNED_REF);
  assert.match(S.PINNED_REF, /^[0-9a-f]{40}$/);
  assert.equal(S.settings({}).dir, path.join(process.env.RIGS_HOME, 'starnet', S.PINNED_REF));
  assert.deepEqual(S.applyConfigPatch(undefined, { enabled: true }), { enabled: true, ref: '', dir: '' });
  assert.deepEqual(S.applyConfigPatch({ enabled: true }, { enabled: false, ref: S.PINNED_REF }), { enabled: false, ref: '', dir: '' });
  assert.throws(() => S.applyConfigPatch({}, { ref: 'v0.13.5' }), /40-character/);
  assert.throws(() => S.applyConfigPatch({}, { dir: 3 }), /path string/);
});

test('install subset: renderer files only — no sidecar, desktop shell, website copy, skills or UI sounds', () => {
  for (const f of ['LICENSE', 'NOTICE.md', 'frontend/index.html', 'frontend/app/world.js', 'frontend/app/windows/x.js', 'shared/specialties.js', 'frontend/assets/sprites/a.png', 'frontend/assets/industrial/floor.png', 'frontend/assets/industrial/remaster/desk.png']) assert.ok(S.inSubset(f), f);
  for (const f of ['sidecar/index.js', 'src-tauri/x.rs', 'website/app/index.html', 'skills-catalog/a.md', 'frontend/assets/sfx/ui-click.wav', 'frontend/assets/sfx/LICENSE.md', 'frontend/assets/industrial/batch03/a.png', 'test/a.js']) assert.ok(!S.inSubset(f), f);
  for (const d of ['frontend', 'frontend/assets', 'frontend/assets/industrial']) assert.ok(S.inSubset(d, true), d);
  for (const d of ['website', 'sidecar', '.git', 'frontend/assets/sfx', 'frontend/assets/industrial/batch02']) assert.ok(!S.inSubset(d, true), d);
});

test('index transform: RIGS boot + stylesheet ahead of the first app script, /shared/ made relative, refuses moved markup', () => {
  const html = '<head><link rel="stylesheet" href="css/style.css"></head><body><script src="app/bootguard.js"></script><script src="/shared/specialties.js"></script></body>';
  const out = S.transformIndex(html);
  assert.ok(out.indexOf('_rigs/rigs-boot.js') < out.indexOf('app/bootguard.js'));
  assert.ok(out.indexOf('_rigs/rigs.css') < out.indexOf('app/bootguard.js'));
  assert.match(out, /src="shared\/specialties\.js"/);
  assert.doesNotMatch(out, /src="\/shared\//);
  assert.throws(() => S.transformIndex('<body><script src="js/a.js"></script></body>'), /inject/);
  assert.throws(() => S.transformIndex('<link href="https://fonts.googleapis.com/x"><script src="app/a.js"></script>'), /remote fonts/);
});

test('route paths: inside the install or ui/starnet only, no traversal, no sounds', () => {
  const dir = '/x/starnet/ref';
  assert.ok(S.resolvePath('/starnet/', dir).index);
  assert.ok(S.resolvePath('/starnet/index.html', dir).index);
  assert.equal(S.resolvePath('/starnet/app/world.js', dir).file, path.join(dir, 'frontend', 'app', 'world.js'));
  assert.equal(S.resolvePath('/starnet/shared/specialties.js', dir).file, path.join(dir, 'shared', 'specialties.js'));
  assert.equal(S.resolvePath('/starnet/_rigs/rigs-boot.js', dir, '/b').file, path.join('/b', 'rigs-boot.js'));
  assert.equal(S.resolvePath('/starnet/assets/sfx/ui-click.wav', dir), null);
  for (const p of ['/starnet/../../etc/passwd', '/starnet/%2e%2e/%2e%2e/etc/passwd', '/starnet/app/../../../LICENSE']) {
    const r = S.resolvePath(p, dir);
    assert.ok(!r || r.index || r.file.startsWith(path.join(dir, 'frontend') + path.sep), `${p} → ${r?.file}`);
  }
  assert.equal(S.resolvePath('/starnet/%E0%A4%A', dir), null, 'bad escapes');
});

test('off means off: the main bundle only imports the switch; the view chunk is loaded on demand', () => {
  const main = fs.readFileSync(path.join(ROOT, 'ui/src/main.js'), 'utf8');
  const sw = fs.readFileSync(path.join(ROOT, 'ui/src/starnet/index.js'), 'utf8');
  assert.match(main, /from '\.\/starnet\/index\.js'/);
  assert.doesNotMatch(main, /starnet\/(view|model)\.js/);
  assert.doesNotMatch(sw, /^import .*\.\/(view|model)\.js/m, 'no static import of the view or model');
  assert.match(sw, /import\('\.\/view\.js'\)/);
  // every StarNet file lives under these paths; nothing else in ui/ or src/ names the view internals
  assert.ok(fs.existsSync(path.join(ROOT, 'ui/starnet/rigs-boot.js')) && fs.existsSync(path.join(ROOT, 'ui/starnet/rigs.css')));
});

// ------------------------------------------------------------------ end to end on a scratch node

const HOME = path.join(TMP, 'node');
const PORT = 20000 + Math.floor(Math.random() * 20000);
const BASE = `http://127.0.0.1:${PORT}`;
const env = { ...process.env, RIGS_HOME: HOME, RIGS_SSH_DIR: path.join(HOME, 'ssh'), RIGS_PORT: String(PORT), RIGS_NAME: 'test-node', RIGS_PEERS: '', RIGS_MESH_TOKEN: 'test-token' };
let server;
const CHECKOUT = path.join(TMP, 'starnet-checkout');

before(async () => {
  // a StarNet-shaped checkout: renderer files, the sidecar, the website copy and the UI sounds
  const put = (rel, body) => { fs.mkdirSync(path.dirname(path.join(CHECKOUT, rel)), { recursive: true }); fs.writeFileSync(path.join(CHECKOUT, rel), body); };
  put('LICENSE', 'MIT License\nCopyright (c) 2026 Andrew Sims\n');
  put('NOTICE.md', 'notices\n');
  put('frontend/index.html', '<!doctype html><html><head><link rel="stylesheet" href="css/style.css"></head><body><script src="app/bootguard.js"></script><script src="/shared/specialties.js"></script><script src="app/world.js"></script></body></html>');
  put('frontend/app/world.js', 'var World = {};');
  put('frontend/app/bootguard.js', '');
  put('frontend/css/style.css', 'body{}');
  put('frontend/assets/sprites/a.png', 'png');
  put('frontend/assets/sfx/ui-click.wav', 'wav');
  put('frontend/assets/sfx/LICENSE.md', 'Bleeoop');
  put('shared/specialties.js', '// shared');
  put('sidecar/index.js', '// never installed');
  put('website/app/index.html', '<html>');
  fs.mkdirSync(HOME, { recursive: true });
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
after(() => server?.kill());

const json = async (p, o) => { const r = await fetch(BASE + p, o && { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(o) }); return { status: r.status, body: await r.json() }; };
const cli = (...a) => new Promise((resolve) => { const c = spawn(process.execPath, [path.join(ROOT, 'bin/rigs.js'), 'starnet', ...a], { env }); let o = ''; c.stdout.on('data', (d) => { o += d; }); c.stderr.on('data', (d) => { o += d; }); c.on('close', (code) => resolve({ code, out: o })); });
/** Connect a UI socket; once it is open, resolves to { next } — a promise of the next `type` push. */
function nextPush(type) {
  return new Promise((ready, fail) => {
    const ws = new WebSocket(`ws://127.0.0.1:${PORT}/ws`);
    ws.on('error', fail);
    ws.on('open', () => ready({ next: new Promise((resolve, reject) => {
      const t = setTimeout(() => { ws.close(); reject(new Error(`no ${type} push`)); }, 8000);
      ws.on('message', (d) => { const m = JSON.parse(d); if (m.type === type) { clearTimeout(t); ws.close(); resolve(m); } });
    }) }));
  });
}

test('e2e: off by default — /starnet/ is a 404 and nothing is installed', async () => {
  for (const p of ['/starnet/', '/starnet/app/world.js', '/starnet/_rigs/rigs-boot.js']) assert.equal((await fetch(BASE + p)).status, 404, p);
  const { body } = await json('/api/local/starnet/config');
  assert.equal(body.enabled, false);
  assert.equal(body.installed, false);
  assert.equal(body.ref, S.PINNED_REF);
  assert.equal((await json('/api/local/config')).body.experimental.starnet.enabled, false);
});

test('e2e: settings API on → push to open UIs; not installed → the frame is a 503 (the UI keeps the galaxy)', async () => {
  const push = await nextPush('starnet-config');
  const { status, body } = await json('/api/local/starnet/config', { enabled: true });
  assert.equal(status, 200);
  assert.equal(body.enabled, true);
  assert.equal((await push.next).enabled, true);
  assert.equal((await fetch(BASE + '/starnet/')).status, 503);
  assert.equal((await fetch(BASE + '/starnet/_rigs/rigs-boot.js')).status, 200, 'the RIGS boot ships with RIGS');
  assert.equal((await json('/api/local/starnet/config', { ref: 'main' })).status, 400);
  const persisted = JSON.parse(fs.readFileSync(path.join(HOME, 'config.json'), 'utf8'));
  assert.equal(persisted.experimental.starnet.enabled, true, 'saved in config.json');
});

test('e2e: install from a local checkout — subset only, LICENSE + notice kept, sounds left out; the frame is served', async () => {
  const { status, body } = await json('/api/local/starnet/install', { from: CHECKOUT });
  assert.equal(status, 200, JSON.stringify(body));
  assert.equal(body.installed, true);
  const dir = path.join(HOME, 'starnet', S.PINNED_REF);
  for (const f of ['LICENSE', 'NOTICE.md', 'RIGS-NOTICE.txt', 'frontend/app/world.js', 'shared/specialties.js']) assert.ok(fs.existsSync(path.join(dir, f)), f);
  for (const f of ['sidecar', 'website', 'frontend/assets/sfx']) assert.ok(!fs.existsSync(path.join(dir, f)), f);
  const html = await (await fetch(BASE + '/starnet/')).text();
  assert.ok(html.indexOf('_rigs/rigs-boot.js') > 0 && html.indexOf('_rigs/rigs-boot.js') < html.indexOf('app/bootguard.js'));
  assert.match(html, /src="shared\/specialties\.js"/);
  assert.equal(await (await fetch(BASE + '/starnet/app/world.js')).text(), 'var World = {};');
  assert.equal(await (await fetch(BASE + '/starnet/shared/specialties.js')).text(), '// shared');
  assert.equal((await fetch(BASE + '/starnet/assets/sfx/ui-click.wav')).status, 404);
  // %2e%2e is a dot-segment to the URL parser: this never reaches /starnet/ (RIGS's own page fallback answers)
  assert.doesNotMatch(await (await fetch(BASE + '/starnet/%2e%2e/%2e%2e/config.json')).text(), /meshToken|test-token/, 'no way out of the install');
  const again = await json('/api/local/starnet/install', { from: CHECKOUT });
  assert.equal(again.body.already, true, 'idempotent');
});

test('e2e: the station frame has no RIGS API access', async () => {
  const r = await fetch(BASE + '/api/local/config', { headers: { referer: `${BASE}/starnet/` } });
  assert.equal(r.status, 403);
  assert.equal((await fetch(BASE + '/api/local/config', { headers: { referer: `${BASE}/` } })).status, 200);
});

test('e2e: rigs starnet off/status/on through the running daemon; the general settings API switches it too', async () => {
  let r = await cli('off');
  assert.equal(r.code, 0, r.out);
  assert.match(r.out, /view off · installed/);
  assert.equal((await fetch(BASE + '/starnet/')).status, 404, 'off again: the frame is gone');
  // a frame already open finishes its in-flight asset loads quietly; it cannot start again
  assert.equal((await fetch(BASE + '/starnet/app/world.js', { headers: { referer: `${BASE}/starnet/` } })).status, 200);
  assert.equal((await fetch(BASE + '/starnet/', { headers: { referer: `${BASE}/starnet/` } })).status, 404);
  r = await cli('status');
  assert.match(r.out, /view off/);
  const push = await nextPush('starnet-config');
  await json('/api/local/config', { experimental: { starnet: { enabled: true } } });
  assert.equal((await push.next).enabled, true);
  assert.equal((await fetch(BASE + '/starnet/')).status, 200);
  r = await cli('on');
  assert.match(r.out, /view on · installed/);
});

test('e2e: rigs starnet remove leaves no residue; switching off restores the default', async () => {
  const r = await cli('remove');
  assert.equal(r.code, 0, r.out);
  assert.ok(!fs.existsSync(path.join(HOME, 'starnet')));
  assert.equal((await fetch(BASE + '/starnet/')).status, 503);
  await cli('off');
  assert.equal((await fetch(BASE + '/starnet/')).status, 404);
  assert.equal((await json('/api/local/starnet/config')).body.enabled, false);
});
