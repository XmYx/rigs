// "Stop that project" sticks: a paused project's agents are stopped and nothing of it is dispatched, watched or
// revived again — not even by a planner tick that was already in flight — until Sir resumes it.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { test } from 'node:test';

process.env.RIGS_HOME = fs.mkdtempSync(path.join(os.tmpdir(), 'rigs-pause-'));
const planner = await import('../src/planner.js');
const DIR = path.join(process.env.RIGS_HOME, 'projects');
fs.mkdirSync(DIR, { recursive: true });

const run = { mode: 'openrig', rig: 'mad-86d3', seat: 'team-code-opus-2@mad-86d3', qitem: 'q4' };
function seed(id) {
  const p = { id, slug: id, name: 'MadMax · FPS', goal: 'g', owner: 'macbookpro', repo: { node: 'magix-system', path: '/x' }, status: 'running', log: [],
    createdAt: Date.now(), updatedAt: Date.now(), tasks: [
      { id: 't3', title: 'CPU pass', status: 'done', deps: [], assign: { node: 'magix-system', provider: 'claude' } },
      { id: 't4', title: 'Render pass', status: 'running', deps: ['t3'], assign: { node: 'magix-system', provider: 'claude' }, run },
      { id: 't5', title: 'Report', status: 'todo', deps: ['t4'], assign: { node: 'magix-system', provider: 'claude' } },
    ] };
  fs.writeFileSync(path.join(DIR, id + '.json'), JSON.stringify(p));
}
const recorder = (reply = () => ({})) => {
  const calls = [];
  return { calls, ctx: { call: async (node, p, o) => { calls.push(p); return reply(p, o); }, notify: () => {}, snapshot: async () => [] } };
};

test('pausing stops the running agents and keeps the project paused', async () => {
  seed('a1');
  const { calls, ctx } = recorder();
  const p = await planner.stopProject('a1', ctx, { reason: 'we may stop that project', by: 'JARVIS for Sir' });
  assert.equal(p.status, 'paused');
  assert.deepEqual(calls, ['work/stop']);
  assert.equal(p.tasks.find((t) => t.id === 't4').status, 'todo');
  assert.equal(p.paused.reason, 'we may stop that project');
  await assert.rejects(planner.dispatchReady('a1', ctx), /paused/);
});

test('the planner tick never watches, nudges or revives a paused project', async () => {
  seed('a2');
  const { ctx } = recorder();
  await planner.stopProject('a2', ctx);
  const later = recorder((p) => (p === 'work/status' ? { state: 'seat-down' } : { ok: true }));
  await planner.tick(later.ctx);
  assert.deepEqual(later.calls, []);
  assert.equal((await planner.getProject('a2')).status, 'paused');
});

test('a tick already in flight (reviving a seat) cannot write "running" back over the pause', async () => {
  seed('a3');
  let release;
  const gate = new Promise((r) => { release = r; });
  const { calls, ctx } = recorder(async (p) => {
    if (p === 'work/status') return { state: 'seat-down' };
    if (p === 'work/revive') { await gate; return { ok: true, how: 'restored the team' }; }
    return { ok: true };
  });
  const ticking = planner.tick(ctx);
  while (!calls.includes('work/revive')) await new Promise((r) => setTimeout(r, 5));
  const stopping = planner.stopProject('a3', ctx, { reason: 'stop now' });
  release();
  await ticking;
  const p = await stopping;
  assert.equal(p.status, 'paused');
  assert.equal(p.tasks.find((t) => t.id === 't4').status, 'todo');
  assert.ok(calls.lastIndexOf('work/stop') > calls.indexOf('work/revive'), 'the revived agent is stopped again');
  await planner.tick(ctx);
  assert.equal((await planner.getProject('a3')).status, 'paused');
});

test('work filed into a paused project waits; resuming starts the ready tasks again', async () => {
  seed('a4');
  const { calls, ctx } = recorder((p) => (p === 'work/start' ? { mode: 'openrig', seat: 's@r', rig: 'r' } : { ok: true }));
  await planner.stopProject('a4', ctx);
  const r = await planner.intake({ project: 'a4', instruction: 'one more thing', assign: undefined }, ctx);
  assert.equal(r.started, false);
  assert.ok(!calls.includes('work/start'));
  const p = await planner.resumeProject('a4', ctx);
  assert.equal(p.status, 'running');
  assert.equal(p.tasks.find((t) => t.id === 't4').status, 'running');
  assert.ok(calls.includes('work/start'));
});
