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
const { personaPrompt } = await import('../src/chat.js');

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

test('an instruction with no project goes to the main project, which is created on first use, and starts at once', async () => {
  const c = ctx();
  const r = await P.intake({ title: 'Dark mode for the dashboard', instruction: 'Add a dark mode to the work dashboard', kind: 'code', size: 'S' }, c);
  assert.equal(r.project.id, P.MAIN_ID);
  assert.equal(r.project.main, true);
  assert.equal(r.started, true);
  assert.equal(r.task.assign.node, 'ubuntu');
  assert.equal(r.task.assign.model, 'claude-sonnet-5-5');
  assert.equal(r.task.run.seat, 'seat-t1');
  assert.equal(c.calls.length, 1);
  assert.equal(c.calls[0].sub, 'work/start');
  assert.match(c.calls[0].body.prompt, /RIGS · JARVIS/);
  const again = await P.intake({ title: 'Second', instruction: 'Another thing' }, c);
  assert.equal(again.task.id, 't2', 'the main project is reused, tasks keep numbering');
  assert.equal(c.calls.length, 2, 'only the new task is started');
  const listed = (await P.listProjects()).find((p) => p.id === P.MAIN_ID);
  assert.equal(listed.main, true);
  assert.equal(listed.tasks[1].run.seat, 'seat-t2');
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
  const prompt = personaPrompt('- ubuntu: linux online', '- rigs · RIGS · JARVIS · running · on ubuntu');
  assert.match(prompt, /You are JARVIS, not FRIDAY/);
  assert.match(prompt, /jarvis_task/);
  assert.match(prompt, /Local time on this machine/);
  assert.match(prompt, /- rigs · RIGS · JARVIS/);
  fs.writeFileSync(path.join(process.env.RIGS_HOME, 'SOUL.md'), '# JARVIS\nSir\'s own soul rule: always mention tea.');
  assert.match(personaPrompt(''), /always mention tea/);
  assert.doesNotMatch(personaPrompt(''), /not FRIDAY/);
});
