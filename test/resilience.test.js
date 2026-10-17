// After updates, restarts and reboots the work carries on: dead seats are revived and told to continue,
// and anything that was in flight when the daemon stopped is recovered at once.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { test } from 'node:test';

process.env.RIGS_HOME = fs.mkdtempSync(path.join(os.tmpdir(), 'rigs-resilience-'));
const planner = await import('../src/planner.js');

const project = () => ({ id: 'p1', name: 'MadMax · FPS', owner: 'macbookpro', log: [], tasks: [] });
const task = () => ({ id: 't3', title: 'CPU pass', status: 'running', assign: { node: 'magix-system', provider: 'claude' },
  run: { mode: 'openrig', rig: 'mad-86d3', seat: 'team-code-opus@mad-86d3', qitem: 'q1', brief: '/b/t3.md' } });

test('a dead seat is revived and told to carry on (with its brief)', async () => {
  const calls = [];
  const ctx = { call: async (node, p, o) => { calls.push([node, p, o.body]); return p === 'work/revive' ? { ok: true, how: 'restored the team (conversations resumed)' } : { ok: true }; }, notify: () => {} };
  const p = project(); const t = task();
  assert.equal(await planner.watchTask(p, t, { state: 'seat-down' }, ctx), true);
  assert.deepEqual(calls.map((c) => c[1]), ['work/revive', 'work/nudge']);
  assert.match(calls[1][2].text, /interrupted .* task t3 of project p1/);
  assert.match(calls[1][2].text, /\/b\/t3\.md/);
  assert.equal(t.status, 'running');
  assert.match(p.log.at(-1).text, /restored the team .* told it to carry on/);
});

test('when reviving fails it is tried again on the next tick; a seat that keeps dying restarts the task from its brief', async () => {
  const ctx = { call: async (n, p) => (p === 'work/revive' ? { ok: false, reason: 'the seat did not come back' } : {}), notify: () => {} };
  const p = project(); const t = task();
  await planner.watchTask(p, t, { state: 'daemon-down' }, ctx);
  assert.equal(t.status, 'running');
  assert.match(p.log.at(-1).text, /will try again/);
  for (let i = 0; i < planner.MAX_REVIVES; i++) await planner.watchTask(p, t, { state: 'seat-down' }, ctx);
  assert.equal(t.status, 'todo', 'retried from scratch');
  assert.equal(t.revives, 0);
});

test('planning that was in flight when the daemon stopped is recovered at once, not after a timeout', async () => {
  const dir = path.join(process.env.RIGS_HOME, 'projects');
  fs.mkdirSync(dir, { recursive: true });
  const stale = { id: 'p2', slug: 'p2', name: 'P2', goal: 'g', owner: 'me', repo: {}, status: 'planning', tasks: [], log: [], createdAt: planner.BOOT - 60000, updatedAt: planner.BOOT - 60000 };
  fs.writeFileSync(path.join(dir, 'p2.json'), JSON.stringify(stale));
  await planner.tick({ call: async () => ({}), notify: () => {}, snapshot: async () => [] });
  const p = await planner.getProject('p2');
  assert.equal(p.status, 'draft');
  assert.match(p.log.at(-1).text, /planning never finished/);
});

test('a seat that turns out alive (a slow daemon, or only OpenRig itself restarted) is not nudged', async () => {
  const calls = [];
  const ctx = { call: async (n, p) => { calls.push(p); return p === 'work/revive' ? { ok: true, restored: false, how: 'the seat was alive' } : {}; }, notify: () => {} };
  const p = project(); const t = task();
  assert.equal(await planner.watchTask(p, t, { state: 'seat-down' }, ctx), false);
  assert.deepEqual(calls, ['work/revive'], 'no nudge');
  assert.equal(t.revives, 0, 'a false alarm does not count');
  assert.equal(p.log.length, 0);
  ctx.call = async (n, path) => { calls.push(path); return path === 'work/revive' ? { ok: true, restored: false, how: 'OpenRig was down — restarted it; the agent was unaffected' } : {}; };
  assert.equal(await planner.watchTask(p, t, { state: 'daemon-down' }, ctx), true);
  assert.match(p.log.at(-1).text, /restarted it; the agent was unaffected/);
  assert.ok(!calls.includes('work/nudge'));
});
