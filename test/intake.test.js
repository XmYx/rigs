// Intake: every instruction lands in a project (the main RIGS · JARVIS one by default), routed and started
// right away; and JARVIS's character (SOUL.md) reaches the persona prompt. No daemon, no models.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { test } from 'node:test';

process.env.RIGS_HOME = fs.mkdtempSync(path.join(os.tmpdir(), 'rigs-intake-'));
process.env.RIGS_NAME = 'ubuntu';
const P = await import('../src/planner.js');
const { personaPrompt, liveContext } = await import('../src/chat.js');

const mesh = [{
  node: { id: 'ubuntu', name: 'ubuntu', online: true, rigs: true, platform: 'linux', gpus: [], stats: { cpu: 5, memUsed: 4, memTotal: 16 }, capabilities: {} },
  brains: [{ id: 'claude', models: [], efforts: [] }], openrig: { daemon: 'running' },
}];
function ctx() {
  const calls = [];
  return {
    calls,
    snapshot: async () => mesh,
    call: async (node, sub, { body }) => { calls.push({ node, sub, body }); return { mode: 'openrig', rig: `${body.project.slug}-${body.task.id}`, seat: `seat-${body.task.id}`, qitem: 'qitem-1', session: { kind: 'rig', id: `seat-${body.task.id}` } }; },
    notify: () => {},
  };
}

/** The background start (D1) has finished when the task is no longer "starting". */
async function settled(id, taskId, ms = 2000) {
  for (let i = 0; i < ms / 10; i++) {
    const t = (await P.getProject(id)).tasks.find((x) => x.id === taskId);
    if (t.status !== 'starting') return t;
    await new Promise((r) => setTimeout(r, 10));
  }
  throw new Error(`${taskId} is still starting after ${ms} ms`);
}

test('an instruction with no project goes to the main project, which is created on first use, and starts at once', async () => {
  const c = ctx();
  const r = await P.intake({ title: 'Dark mode for the dashboard', instruction: 'Add a dark mode to the work dashboard', kind: 'code', size: 'S' }, c);
  assert.equal(r.project.id, P.MAIN_ID);
  assert.equal(r.project.main, true);
  // D1: the reply comes back once the task is claimed and placed; the seat is cast in the background.
  assert.equal(r.started, true, 'started = claimed and placed');
  assert.equal(r.pending, true, 'the agent seat is still being cast');
  assert.equal(r.task.status, 'starting');
  assert.equal(r.task.run, null);
  assert.equal(r.task.assign.node, 'ubuntu');
  assert.equal(r.task.assign.model, 'claude-sonnet-5-5');
  assert.match(r.task.reason, /code → claude claude-sonnet-5-5/);
  const t1 = await settled(P.MAIN_ID, 't1');
  assert.equal(t1.status, 'running');
  assert.equal(t1.run.seat, 'seat-t1');
  assert.equal(c.calls.length, 1);
  assert.equal(c.calls[0].sub, 'work/start');
  assert.match(c.calls[0].body.prompt, /RIGS · JARVIS/);
  const again = await P.intake({ title: 'Second', instruction: 'Another thing' }, c);
  assert.equal(again.task.id, 't2', 'the main project is reused, tasks keep numbering');
  await settled(P.MAIN_ID, 't2');
  assert.equal(c.calls.length, 2, 'only the new task is started');
  const listed = (await P.listProjects()).find((p) => p.id === P.MAIN_ID);
  assert.equal(listed.main, true);
  assert.equal(listed.tasks[1].run.seat, 'seat-t2');
});

test('D1: the intake reply does not wait for a slow seat; a start that fails is retried by the loop, never surfaced as an intake error', async () => {
  let release;
  const gate = new Promise((r) => { release = r; });
  const c = ctx();
  const inner = c.call;
  c.call = async (node, sub, o) => { if (sub === 'work/start') await gate; return inner(node, sub, o); };
  const t0 = Date.now();
  const r = await P.intake({ title: 'Slow seat', instruction: 'cast a seat that takes a while' }, c);
  assert.ok(Date.now() - t0 < 500, 'the reply came back before the seat was up');
  assert.equal(r.started, true);
  assert.equal(r.pending, true);
  assert.equal((await P.getProject(P.MAIN_ID)).tasks.find((x) => x.id === r.task.id).status, 'starting');
  release();
  const t = await settled(P.MAIN_ID, r.task.id);
  assert.equal(t.status, 'running');
  assert.equal(t.run.seat, `seat-${r.task.id}`);
  // a failing start
  const bad = ctx();
  bad.call = async (node, sub) => { if (sub === 'work/start') throw new Error('rig up failed'); return inner(node, sub, {}); };
  const r2 = await P.intake({ title: 'Doomed', instruction: 'the machine cannot cast it' }, bad);
  assert.equal(r2.pending, true);
  const t2 = await settled(P.MAIN_ID, r2.task.id);
  assert.equal(t2.status, 'todo', 'back to todo with a retry scheduled (retryOrFail)');
  assert.equal(t2.attempts, 1);
  assert.ok(t2.retryAt > Date.now());
  assert.ok((await P.getProject(P.MAIN_ID)).log.some((l) => new RegExp(`${r2.task.id} dispatch failed .*rig up failed`).test(l.text)));
});

test('newProject creates a project for the work; an existing planned project only starts the new task', async () => {
  const c = ctx();
  const r = await P.intake({ title: 'Prop browser', instruction: 'Build a prop browser', newProject: { name: 'Props', goal: 'Tools for game props' } }, c);
  assert.notEqual(r.project.id, P.MAIN_ID);
  assert.equal(r.project.name, 'Props');
  assert.equal(r.started, true);

  const planned = await P.createProject({ name: 'Planned', goal: 'g' });
  await P.addTask(planned.id, { title: 'waiting task', kind: 'code' }, mesh);
  const before = c.calls.length;
  const r2 = await P.intake({ project: planned.id, title: 'urgent fix', instruction: 'fix it now' }, c);
  assert.equal(r2.started, true);
  assert.equal(c.calls.length, before + 1, 'the waiting task is not started');
  const p = await P.getProject(planned.id);
  assert.equal(p.tasks.find((t) => t.title === 'waiting task').status, 'todo');
  await assert.rejects(P.intake({ project: 'nope', title: 'x', instruction: 'y' }, c), /not found/);
});

test('JARVIS speaks from SOUL.md (or ~/.rigs/SOUL.md) and sees the projects to file work under', () => {
  const prompt = personaPrompt('- ubuntu: linux · agents: claude');
  assert.match(prompt, /You are JARVIS, not FRIDAY/);
  assert.match(prompt, /jarvis_task/);
  // A4: the clock, live stats and the project list live in the turn's [now: …] block, not the (cached) system prompt
  assert.doesNotMatch(prompt, /Local time on this machine|cpu \d+% mem/);
  assert.match(prompt, /opens with a \[now: …\] block/);
  assert.match(prompt, /Machines in the mesh[\s\S]*- ubuntu: linux · agents: claude/);
  assert.match(liveContext({ projects: '- rigs · RIGS · JARVIS · running · on ubuntu' }), /active projects: rigs · RIGS · JARVIS · running · on ubuntu\]$/);
  fs.writeFileSync(path.join(process.env.RIGS_HOME, 'SOUL.md'), '# JARVIS\nSir\'s own soul rule: always mention tea.');
  assert.match(personaPrompt(''), /always mention tea/);
  assert.doesNotMatch(personaPrompt(''), /not FRIDAY/);
});
