// Persistent OpenRig rigs: one per pinned project (lead + on-demand workers, idle workers stopped) and JARVIS's
// own rig with an overseer seat. The `rig` CLI is a fake (an injected runner), so this runs on every OS without
// OpenRig. Also: rig resolves under a service PATH, OpenRig health, and the intake route (default project).
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { after, before, test } from 'node:test';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const HOME = fs.mkdtempSync(path.join(os.tmpdir(), 'rigs-hubs-'));
process.env.RIGS_HOME = HOME;
process.env.RIGS_NAME = 'macbookpro';
const PROJ = path.join(HOME, 'MadMike');
fs.mkdirSync(PROJ, { recursive: true });
fs.writeFileSync(path.join(HOME, 'config.json'), JSON.stringify({ pinnedProjects: [{ name: 'MadMike', path: PROJ }] }));

const openrig = await import('../src/openrig.js');
const hubs = await import('../src/hubs.js');
const work = await import('../src/work.js');

/** A tiny in-memory OpenRig: seats, queue items and every command it was given. */
function fakeRig() {
  const st = { nodes: [], queue: [], calls: [], version: { code: 0, stdout: '0.6.10\n', stderr: '' } };
  const seat = (rig, id, extra = {}) => ({ rigName: rig, logicalId: `team.${id}`, canonicalSessionName: `team-${id}@${rig}`, sessionStatus: 'running', agentActivity: { state: 'idle-at-prompt' }, assignedWorkCount: 0, runtime: 'claude-code', ...extra });
  const ok = (stdout = '') => ({ code: 0, stdout, stderr: '' });
  const idOf = (file) => (fs.readFileSync(file, 'utf8').match(/(?:^|\n)\s*-?\s*id: ([\w-]+)/g) || []).map((l) => l.split('id: ')[1]).filter((x) => x !== 'team')[0];
  const find = (s) => st.nodes.find((n) => n.canonicalSessionName === s);
  st.run = async (cmd, args) => {
    st.calls.push(args);
    const [a, b] = args;
    if (a === '--version') return st.version;
    if (a === 'daemon') return ok('Daemon running on port 7433');
    if (a === 'ps') return ok(JSON.stringify(args.includes('--nodes') ? st.nodes : []));
    if (a === 'host') return ok('[]');
    if (a === 'spec') return ok('valid');
    if (a === 'up' && args.includes('--existing')) { for (const n of st.nodes.filter((x) => x.rigName === b)) n.sessionStatus = 'running'; return ok('{}'); }
    if (a === 'up') {
      const name = fs.readFileSync(b, 'utf8').match(/^name: (.+)$/m)[1];
      const n = seat(name, idOf(b));
      st.nodes.push(n);
      return ok(JSON.stringify({ stages: [{ detail: { nodes: [{ sessionName: n.canonicalSessionName }] } }] }));
    }
    if (a === 'add') { const n = seat(b, idOf(args[3])); st.nodes.push(n); return ok(JSON.stringify({ result: { node: { sessionName: n.canonicalSessionName } } })); }
    if (a === 'queue' && b === 'create') {
      const q = { qitemId: `qitem-${st.queue.length + 1}`, source: args[args.indexOf('--source') + 1], destinationSession: args[args.indexOf('--destination') + 1], state: 'pending', tags: args[args.indexOf('--tags') + 1]?.split(',') || [] };
      st.queue.push(q);
      return ok(`Created ${q.qitemId}`);
    }
    if (a === 'queue' && b === 'list') return ok(JSON.stringify(st.queue.filter((q) => q.state !== 'done')));
    if (a === 'send') return ok('sent');
    if (a === 'seat' && b === 'stop') { find(args[2]).sessionStatus = 'stopped'; return ok('{}'); }
    if (a === 'seat' && b === 'clean') return ok('{}');
    if (a === 'seat' && b === 'launch') { find(args[2]).sessionStatus = 'running'; return ok('{}'); }
    if (a === 'down') { for (const n of st.nodes.filter((x) => x.rigName === b)) n.sessionStatus = 'stopped'; return ok('{}'); }
    return { code: 1, stdout: '', stderr: `fake rig: unhandled ${args.join(' ')}` };
  };
  st.cmds = (verb) => st.calls.filter((c) => c.slice(0, verb.split(' ').length).join(' ') === verb);
  return st;
}

const pin = { name: 'MadMike', path: PROJ };
const task = (id, kind, model, extra = {}) => ({ id, title: `task ${id}`, kind, size: 'M', assign: { node: 'macbookpro', provider: 'claude', model, effort: 'medium' }, ...extra });
const project = { id: 'p1', slug: 'madmike', name: 'MadMike' };
const brief = path.join(HOME, 'brief.md');
fs.writeFileSync(brief, 'do it');

let rig;
function useFake() { rig = fakeRig(); openrig._setRunner(rig.run); hubs._resetIdle(); return rig; }
after(() => openrig._setRunner(null));

test('a pinned folder maps to its hub rig; subfolders too; others are not pinned', () => {
  assert.equal(hubs.pinFor(path.join(PROJ, 'src')).path, PROJ);
  assert.equal(hubs.pinFor(path.join(HOME, 'elsewhere')), null);
  assert.match(hubs.hubRigName(pin), /^hub-madmike-[0-9a-f]{4}$/);
});

test('one persistent rig per pinned project: lead seat in the project folder, workers added on demand with the routed model', async () => {
  useFake();
  const r1 = await hubs.dispatchTask({ pin, project, task: task('t1', 'code', 'claude-opus-5-5'), dir: PROJ, brief, pointer: 'read brief' });
  const name = hubs.hubRigName(pin);
  assert.equal(r1.rig, name);
  assert.equal(r1.lead, `team-lead@${name}`);
  assert.equal(r1.seat, `team-code-opus@${name}`);
  assert.equal(r1.via, 'queue');
  assert.deepEqual(r1.newSeats, [`team-lead@${name}`, `team-code-opus@${name}`], 'both new seats surface as terminals');
  const spec = fs.readFileSync(path.join(HOME, 'rigs', name, 'rig.yaml'), 'utf8');
  assert.match(spec, /id: lead/);
  assert.match(spec, new RegExp(`cwd: ${JSON.stringify(path.resolve(PROJ)).replace(/[\\[\]]/g, '\\$&')}`));
  const frag = fs.readFileSync(path.join(HOME, 'rigs', name, 'code-opus.member.yaml'), 'utf8');
  assert.match(frag, /model: "claude-opus-5-5"/);
  assert.match(frag, /effort: "medium"/);
  assert.equal(rig.cmds('up').length, 1);
  assert.equal(rig.cmds('add').length, 1);

  // A second task of another kind: same rig (no rig up, no rig down), a new worker with its own model.
  rig.nodes.find((n) => n.canonicalSessionName === r1.seat).assignedWorkCount = 1;
  const r2 = await hubs.dispatchTask({ pin, project, task: task('t2', 'test', 'claude-sonnet-5-5'), dir: PROJ, brief, pointer: 'read brief' });
  assert.equal(r2.seat, `team-test-sonnet@${name}`);
  assert.deepEqual(r2.newSeats, [`team-test-sonnet@${name}`]);
  // Same kind while that worker is busy → a sibling seat.
  const r3 = await hubs.dispatchTask({ pin, project, task: task('t3', 'code', 'claude-opus-5-5'), dir: PROJ, brief, pointer: 'read brief' });
  assert.equal(r3.seat, `team-code-opus-2@${name}`);
  assert.equal(rig.cmds('up').length, 1, 'the rig was brought up once');
  assert.equal(rig.cmds('down').length, 0, 'never torn down per task');
  assert.equal(rig.cmds('queue create').length, 4, 'lead orientation + three tasks, each a queue item');
});

test('idle workers are stopped after the timeout, the lead never; a stopped worker is relaunched when work comes back', async () => {
  useFake();
  const name = hubs.hubRigName(pin);
  const r = await hubs.dispatchTask({ pin, project, task: task('t1', 'code', 'claude-opus-5-5'), dir: PROJ, brief, pointer: 'p' });
  rig.queue.forEach((q) => (q.state = 'done'));
  const t0 = Date.now();
  assert.deepEqual((await hubs.reapIdle({ now: t0, idleMs: 60000 })).stopped, [], 'first idle sighting starts the clock');
  assert.deepEqual((await hubs.reapIdle({ now: t0 + 30000, idleMs: 60000 })).stopped, []);
  // Work queued to it keeps it alive even when its pane looks idle.
  rig.queue.push({ qitemId: 'q-x', destinationSession: r.seat, state: 'pending' });
  assert.deepEqual((await hubs.reapIdle({ now: t0 + 90000, idleMs: 60000 })).stopped, []);
  rig.queue.at(-1).state = 'done';
  assert.deepEqual((await hubs.reapIdle({ now: t0 + 100000, idleMs: 60000 })).stopped, []);
  const out = await hubs.reapIdle({ now: t0 + 200000, idleMs: 60000 });
  assert.deepEqual(out.stopped, [r.seat]);
  assert.deepEqual(rig.cmds('seat stop').map((c) => c[2]), [r.seat]);
  assert.equal((await hubs.reapIdle({ now: t0 + 9e9, idleMs: 60000 })).stopped.length, 0, `the lead (team-lead@${name}) is never stopped`);
  // The next task for that seat relaunches it in place rather than adding a seat.
  const again = await hubs.dispatchTask({ pin, project, task: task('t2', 'code', 'claude-opus-5-5'), dir: PROJ, brief, pointer: 'p' });
  assert.equal(again.seat, r.seat);
  assert.deepEqual(rig.cmds('seat launch').map((c) => c[2]), [r.seat]);
  assert.equal(rig.cmds('add').length, 1);
});

test('tasks enter via rig queue; a follow-up is queued to the seat that holds the context', async () => {
  useFake();
  const r = await hubs.dispatchTask({ pin, project, task: task('t1', 'code', 'claude-opus-5-5'), dir: PROJ, brief, pointer: 'p' });
  const queued = rig.cmds('queue create').length;
  const seats = rig.cmds('add').length;
  const f = await hubs.dispatchTask({ pin, project, task: task('t1', 'code', 'claude-opus-5-5', { lastSeat: r.seat }), dir: PROJ, brief, pointer: 'Read the brief again: it failed because X' });
  assert.equal(f.via, 'follow-up');
  assert.equal(f.seat, r.seat);
  assert.ok(f.qitem, 'a follow-up has a queue item, so the watchdog can follow it and a pause can cancel it');
  assert.equal(rig.cmds('queue create').length, queued + 1);
  assert.equal(rig.cmds('add').length, seats, 'no new seat for a follow-up');
  // A follow-up to a seat that is busy with other work is queued instead (it would interrupt).
  rig.nodes.find((n) => n.canonicalSessionName === r.seat).assignedWorkCount = 1;
  openrig.invalidate();
  const g = await hubs.dispatchTask({ pin, project, task: task('t4', 'code', 'claude-opus-5-5', { followUp: r.seat }), dir: PROJ, brief, pointer: 'p' });
  assert.equal(g.via, 'queue');
  // "Send to lead" from the project window types into the lead.
  const s = await hubs.sendToHub(PROJ, 'What is the state of the build?');
  assert.equal(s.seat, `team-lead@${hubs.hubRigName(pin)}`);
});

test('work.startTask sends tasks in a pinned folder to the hub rig; stopping one stops only its worker', async () => {
  useFake();
  const r = await work.startTask({ project, task: task('t9', 'code', 'claude-opus-5-5'), prompt: 'brief', workdir: path.join(PROJ, 'sub'), mode: 'openrig' }).catch((e) => ({ error: e.message }));
  if (r.error) {
    // No OpenRig agent library on this machine (CI): startTask refuses openrig mode — the hub path is covered above.
    assert.match(r.error, /OpenRig/);
    return;
  }
  assert.equal(r.hub, true);
  assert.equal(r.rig, hubs.hubRigName(pin));
  await work.stopTask(r);
  assert.deepEqual(rig.cmds('seat stop').map((c) => c[2]), [r.seat]);
  assert.equal(rig.cmds('down').length, 0);
  assert.deepEqual(rig.cmds('queue update').map((c) => [c[2], c[4]]), [[r.qitem, 'canceled']], 'its queue item is canceled so nothing picks it up again');
});

test('JARVIS gets a persistent rig whose overseer receives the intake and is the source of the fan-out', async () => {
  useFake();
  const j = await hubs.ensureJarvis();
  assert.equal(j.rig, 'jarvis');
  assert.equal(j.lead, 'team-overseer@jarvis');
  assert.equal(await hubs.overseer(), 'team-overseer@jarvis');
  // Fan-out: the project rig's queue item is recorded as coming from the overseer.
  const r = await hubs.dispatchTask({ pin, project, task: task('t1', 'code', 'claude-opus-5-5'), dir: PROJ, brief, pointer: 'p', source: 'team-overseer@jarvis' });
  assert.equal(rig.queue.find((q) => q.destinationSession === r.seat).source, 'team-overseer@jarvis');
  // The overseer owns Sir's instruction as a queue item that says where the work went.
  const o = await hubs.overseerIntake({ instruction: 'Add a dark mode', project: { id: 'rigs', name: 'RIGS · JARVIS', owner: 'macbookpro' }, task: { id: 't1', title: 'Dark mode', kind: 'code', size: 'S', assign: { node: 'macbookpro', provider: 'claude' } }, run: r });
  assert.equal(o.seat, 'team-overseer@jarvis');
  const q = rig.queue.find((x) => x.qitemId === o.qitem);
  assert.equal(q.destinationSession, 'team-overseer@jarvis');
  assert.ok(q.tags.includes('intake'));
  // Up/down from the hub UI keeps the record: down stops every seat, up restores them (conversations resume).
  await hubs.down(PROJ);
  assert.ok(rig.nodes.filter((n) => n.rigName === r.rig).every((n) => n.sessionStatus === 'stopped'));
  const st = await hubs.status();
  assert.equal(st.pins[0].up, false);
  await hubs.up(PROJ);
  assert.ok(rig.cmds('up').some((c) => c.includes('--existing')));
  const st2 = await hubs.status();
  assert.equal(st2.pins[0].up, true);
  assert.ok(st2.pins[0].seats.some((s) => s.lead));
  assert.equal(st2.jarvis.rig, 'jarvis');
});

test('rig runs with the daemon\'s own Node first on PATH; a broken Node is reported as OpenRig health', async () => {
  const seen = [];
  openrig._setRunner(async (cmd, args, opts) => { seen.push(opts.env.PATH); return { code: 0, stdout: '0.6.10', stderr: '' }; });
  await openrig.rigRun(['--version']);
  assert.equal(seen[0].split(path.delimiter)[0], path.dirname(process.execPath));
  openrig._setRunner(async () => ({ code: 134, stdout: '', stderr: 'dyld[123]: Library not loaded: /opt/homebrew/opt/icu4c/lib/libicui18n.71.dylib\n  Referenced from: /opt/homebrew/Cellar/node@18/bin/node' }));
  const st = await openrig.status(true);
  assert.equal(st.healthy, false);
  assert.match(st.health, /OpenRig cannot run: the Node\.js it starts with is broken \(missing libicui18n\.71\.dylib\)/);
  assert.equal(await hubs.available(), false, 'no rigs are started on a node with a broken OpenRig');
  assert.match(openrig.diagnose('SyntaxError: Unexpected token'), /newer Node/);
  openrig._setRunner(null);
});

test('rig resolves outside the service PATH: RIGS\'s pinned wrapper first, then nvm installs', { skip: process.platform === 'win32' }, async () => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'rigs-home-'));
  const script = `
    import fs from 'node:fs'; import path from 'node:path';
    const home = process.env.HOME;
    const nvm = path.join(home, '.nvm', 'versions', 'node', 'v22.23.3', 'bin');
    fs.mkdirSync(nvm, { recursive: true }); fs.writeFileSync(path.join(nvm, 'rig'), '#!/bin/sh\\n', { mode: 0o755 });
    const { bin } = await import(${JSON.stringify(path.join(ROOT, 'src/tools.js'))});
    const a = bin('rig');
    fs.mkdirSync(path.join(home, '.local', 'bin'), { recursive: true }); fs.writeFileSync(path.join(home, '.local', 'bin', 'rig'), '#!/bin/sh\\n', { mode: 0o755 });
    const { clearWhichCache } = await import(${JSON.stringify(path.join(ROOT, 'src/util.js'))}); clearWhichCache();
    console.log(JSON.stringify([a, bin('rig')]));`;
  // augmentedPath() appends dirname(process.execPath); a node that lives beside a real `rig` (nvm) would win, so run a lone copy.
  const nodeDir = path.join(home, 'node-only'); fs.mkdirSync(nodeDir);
  const nodeBin = path.join(nodeDir, 'node'); fs.copyFileSync(process.execPath, nodeBin);
  const out = await new Promise((res) => {
    const p = spawn(nodeBin, ['--input-type=module', '-e', script], { env: { HOME: home, PATH: '/usr/bin:/bin', RIGS_HOME: path.join(home, '.rigs') } });
    let o = ''; p.stdout.on('data', (d) => (o += d)); p.stderr.on('data', (d) => (o += d)); p.on('close', () => res(o));
  });
  const [a, b] = JSON.parse(out.trim().split('\n').at(-1));
  // The lone node copy has no rig beside it, so the fake nvm tree decides (a real nvm rig next to the test's own
  // node is never on this child's path).
  assert.equal(a, path.join(home, '.nvm', 'versions', 'node', 'v22.23.3', 'bin', 'rig'));
  assert.equal(b, path.join(home, '.local', 'bin', 'rig'));
});

// ---------------------------------------------------------------- the intake route on a real node

const PORT = 20000 + Math.floor(Math.random() * 20000);
const BASE = `http://127.0.0.1:${PORT}`;
const NODE_HOME = fs.mkdtempSync(path.join(os.tmpdir(), 'rigs-intake-node-'));
let server;
before(async () => {
  // Every provider switched off: the intake files and routes the task but casts no real agent.
  fs.writeFileSync(path.join(NODE_HOME, 'config.json'), JSON.stringify({ routing: { avoid: ['claude', 'codex', 'ollama', 'stub'] } }));
  const env = { ...process.env, RIGS_NO_MIGRATIONS: '1', RIGS_NO_AUTOUPDATE: '1', RIGS_NO_OPENRIG: '1', RIGS_HOME: NODE_HOME, RIGS_SSH_DIR: path.join(NODE_HOME, 'ssh'), RIGS_PORT: String(PORT), RIGS_NAME: 'intake-node', RIGS_PEERS: '', RIGS_MESH_TOKEN: 'test-token' };
  server = spawn(process.execPath, [path.join(ROOT, 'bin/rigs.js'), 'serve'], { env, stdio: ['ignore', 'pipe', 'pipe'] });
  for (let i = 0; i < 100; i++) {
    try { if ((await fetch(BASE + '/api/nodes/self/info')).ok) return; } catch {}
    await new Promise((r) => setTimeout(r, 200));
  }
  throw new Error('server did not start');
});
after(() => { server?.kill(); });

async function intake(body) {
  const r = await fetch(BASE + '/api/nodes/self/projects/intake', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) });
  return { status: r.status, body: await r.json() };
}

test('jarvis_task on a fresh node: the default "rigs" project is created there (no "project not found")', async () => {
  const r = await intake({ title: 'Dark mode', instruction: 'Add a dark mode' });
  assert.equal(r.status, 200, JSON.stringify(r.body));
  assert.equal(r.body.project.id, 'rigs');
  assert.equal(r.body.project.owner, 'intake-node');
  const again = await intake({ title: 'Second', instruction: 'Another thing', project: 'rigs' });
  assert.equal(again.status, 200, JSON.stringify(again.body));
  assert.equal(again.body.task.id, 't2');
});

test('jarvis_task with newProject creates the project on the node that handles the intake', async () => {
  const r = await intake({ title: 'Scaffold', instruction: 'Start it', newProject: { name: 'Garden planner', goal: 'A garden planner app' } });
  assert.equal(r.status, 200, JSON.stringify(r.body));
  assert.equal(r.body.project.name, 'Garden planner');
  const unknown = await intake({ title: 'x', instruction: 'x', project: 'nope123' });
  assert.equal(unknown.status, 404);
  assert.match(unknown.body.error, /nope123 not found on any machine/);
});

test('RIGS_NO_OPENRIG=1 keeps a scratch node away from the real rig CLI (no overseer intake)', async () => {
  openrig._setRunner(null);
  process.env.RIGS_NO_OPENRIG = '1';
  try {
    const r = await openrig.rigRun(['queue', 'create']);
    assert.equal(r.code, -1);
    assert.equal(await hubs.overseer(), null);
    assert.equal(await hubs.overseerIntake({ instruction: 'x', project: { id: 'rigs', name: 'r', owner: 'o' }, task: { id: 't1', title: 'x', kind: 'code', size: 'S' } }), null);
  } finally { delete process.env.RIGS_NO_OPENRIG; }
});
