// "Blocked" must mean the agent said so or the session is genuinely silent: an agent still working in auto mode
// (busy seat, growing transcript, needs_input/blocked activity strings) is never flagged, and a stalled task
// that comes back to life goes back to running.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { test } from 'node:test';

process.env.RIGS_HOME = fs.mkdtempSync(path.join(os.tmpdir(), 'rigs-falseblocked-'));
const planner = await import('../src/planner.js');
const attention = await import('../src/attention.js');
const { STALL_MS, MAX_NUDGES } = planner;

const project = () => ({ id: 'pfb', name: 'JARVIS · router', owner: 'magix-system', status: 'running', log: [], tasks: [] });
const task = () => ({ id: 't2', title: 'Stop false blocked', status: 'running', assign: { node: 'magix-system', provider: 'claude' },
  run: { mode: 'openrig', rig: 'r', seat: 'team-code@r', qitem: 'q1' } });
const ctx = () => { const c = { calls: [], notes: [] }; c.call = async (n, s) => { c.calls.push(s); return { ok: true }; }; c.notify = (text, level) => c.notes.push({ text, level }); return c; };

// Walk a task through the whole stall ladder with the same status each tick; returns the final time.
async function stall(p, t, c, st, t0) {
  let now = t0;
  await planner.watchTask(p, t, st, c, now);
  for (let i = 0; i <= MAX_NUDGES + 1 && t.status === 'running'; i++) { now += STALL_MS + 1000; await planner.watchTask(p, t, st, c, now); } // the tick only watches running tasks
  return now;
}

test('an auto-mode agent past the idle threshold is never blocked while it shows life', async () => {
  const t0 = Date.now();
  for (const live of [{ busy: true }, { activityAt: 0, busy: true }]) {
    const p = project(); const t = task(); const c = ctx();
    // The pane looks unchanged and the prompt line says idle, yet the seat is busy / its transcript keeps growing.
    let now = t0;
    for (let i = 0; i < MAX_NUDGES + 3; i++) { now += STALL_MS + 1000; await planner.watchTask(p, t, { state: 'in-progress', idle: true, fingerprint: 'same', ...live }, c, now); }
    assert.equal(t.status, 'running');
    assert.equal(c.calls.filter((x) => x === 'work/nudge').length, 0);
    assert.equal(c.notes.length, 0);
  }
  const p = project(); const t = task(); const c = ctx(); let now = t0;
  for (let i = 0; i < MAX_NUDGES + 3; i++) { now += STALL_MS + 1000; await planner.watchTask(p, t, { state: 'in-progress', idle: true, fingerprint: 'same', activityAt: now - 30000 }, c, now); }
  assert.equal(t.status, 'running', 'a transcript that grew within the stall window is activity');
});

test('a genuinely silent session still goes blocked, once, and tells Sir once', async () => {
  const p = project(); const t = task(); const c = ctx();
  const quiet = { state: 'in-progress', idle: true, fingerprint: 'same', busy: false, activityAt: 1 };
  await stall(p, t, c, quiet, Date.now());
  assert.equal(t.status, 'blocked');
  assert.equal(t.stalled, true);
  assert.equal(c.notes.filter((n) => n.level === 'error').length, 1);
  assert.equal(c.calls.filter((x) => x === 'work/nudge').length, MAX_NUDGES);
});

test('a stalled task recovers to running when activity resumes, and the project recovers with it', async () => {
  const p = project(); const t = task(); const c = ctx();
  const now = await stall(p, t, c, { state: 'in-progress', idle: true, fingerprint: 'same' }, Date.now());
  p.status = 'blocked';
  assert.equal(planner.recoverStalled(p, t, { state: 'in-progress', idle: true, activityAt: 1 }, now), false, 'still silent: stays blocked');
  assert.equal(t.status, 'blocked');
  assert.equal(planner.recoverStalled(p, t, { state: 'in-progress', busy: true }, now), true);
  assert.equal(t.status, 'running');
  assert.equal(t.stalled, false);
  assert.equal(p.status, 'running');
  // An agent-reported blocked is not the watchdog's to clear.
  const r = task(); r.status = 'blocked';
  assert.equal(planner.recoverStalled(p, r, { busy: true }, now), false);
});

test('the blocked toast fires once per real transition, not on every repeated report', async () => {
  const c = ctx();
  const p = await planner.createProject({ name: 'dedupe', goal: 'g', repoNode: 'magix-system', repoPath: path.join(os.tmpdir(), 'wt-fb') });
  p.tasks = [{ ...task(), id: 't1', deps: [] }, { ...task(), id: 't9', status: 'running', deps: [] }];
  await planner.saveProject(p);
  const errors = () => c.notes.filter((n) => n.level === 'error' && /“Stop false blocked” is blocked/.test(n.text)).length;
  c.notify = (text, level) => c.notes.push({ text, level });
  const tell = { call: c.call, notify: c.notify };
  await planner.updateTask(p.id, 't1', { status: 'blocked', summary: 'needs key' }, tell);
  await planner.updateTask(p.id, 't1', { status: 'blocked', summary: 'needs key' }, tell);
  assert.equal(errors(), 1);
  await planner.updateTask(p.id, 't1', { status: 'running' }, tell);
  await planner.updateTask(p.id, 't1', { status: 'blocked', summary: 'again' }, tell);
  assert.equal(errors(), 2, 'a new transition is announced again');
});

test('attention: auto-approved seats are not blocked/needs-input from activity strings alone', () => {
  const seat = (activity, extra = {}) => ({ session: `s-${activity}@r`, runtime: 'claude-code', status: 'running', activity, startupStatus: 'ready', title: activity, ...extra });
  assert.deepEqual(attention.rigNeeds([seat('blocked'), seat('running'), seat('idle-at-prompt'), seat('tool_blocked_by_hook')]), []);
  assert.deepEqual(attention.rigNeeds([seat('needs_input')]).map((x) => x.key), ['rig:s-needs_input@r'], 'a real wait is still reported');
});
