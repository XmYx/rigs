// "Blocked" must mean the agent said so or the session is genuinely silent: an agent still working in auto mode
// (busy seat, growing transcript, needs_input/blocked activity strings) is never flagged, and a stalled task
// that comes back to life goes back to running.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { after, test } from 'node:test';

process.env.RIGS_HOME = fs.mkdtempSync(path.join(os.tmpdir(), 'rigs-falseblocked-'));
const planner = await import('../src/planner.js');
const attention = await import('../src/attention.js');
const { STALL_MS, MAX_NUDGES } = planner;

const project = () => ({ id: 'pfb', name: 'JARVIS · router', owner: 'magix-system', status: 'running', log: [], tasks: [] });
const task = () => ({ id: 't2', title: 'Stop false blocked', status: 'running', assign: { node: 'magix-system', provider: 'claude' },
  run: { mode: 'openrig', rig: 'r', seat: 'team-code@r', qitem: 'q1' } });
const ctx = () => { const c = { calls: [], notes: [] }; c.call = async (n, s) => { c.calls.push(s); return { ok: true }; }; c.notify = (text, level) => c.notes.push({ text, level }); return c; };
const { config } = await import('../src/config.js');

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

test('a genuinely silent session is nudged, then failed into a retry — its agent stopped, nothing parked', async () => {
  const p = project(); const t = task(); const c = ctx();
  const quiet = { state: 'in-progress', idle: true, fingerprint: 'same', busy: false };
  await stall(p, t, c, quiet, Date.now());
  assert.equal(t.status, 'todo', 'queued for its next attempt');
  assert.equal(t.attempts, 1);
  assert.equal(t.stalled, undefined);
  assert.match(t.lastFailure, /^stalled: idle \d+ min without a report after 3 nudges/);
  assert.deepEqual(c.calls.filter((x) => x !== 'work/nudge'), ['work/stop']);
  assert.equal(c.calls.filter((x) => x === 'work/nudge').length, MAX_NUDGES);
  assert.equal(c.notes.length, 0, 'a retry is not news for Sir');
});

test('watchdog: no progress at all for stallMinutes fails the task even without an idle prompt', async () => {
  const p = project(); const t = task(); const c = ctx();
  const t0 = Date.now();
  t.run.startedAt = t0 - 2 * 3600000;
  // Not idle by the prompt line, no fingerprint — but the session has not moved for 61 minutes.
  assert.equal(await planner.watchTask(p, t, { state: 'in-progress', activityAt: t0 - 61 * 60000 }, c, t0), true);
  assert.equal(t.status, 'todo');
  assert.match(t.lastFailure, /^stalled: no progress for 61 min/);
  // 59 minutes is still within the window; a busy seat is never stalled.
  const u = task(); u.run.startedAt = t0 - 2 * 3600000;
  assert.equal(await planner.watchTask(p, u, { state: 'in-progress', activityAt: t0 - 59 * 60000 }, c, t0), false);
  assert.equal(await planner.watchTask(p, u, { state: 'in-progress', busy: true, activityAt: t0 - 5 * 3600000 }, c, t0), false);
  assert.equal(u.status, 'running');
});

test('with the loop off, a silent session still goes blocked, once, and tells Sir once', async () => {
  config().autonomy.enabled = false;
  try {
    const p = project(); const t = task(); const c = ctx();
    await stall(p, t, c, { state: 'in-progress', idle: true, fingerprint: 'same', busy: false, activityAt: 1 }, Date.now());
    assert.equal(t.status, 'blocked');
    assert.equal(t.stalled, true);
    assert.equal(c.notes.filter((n) => n.level === 'error').length, 1);
  } finally { config().autonomy.enabled = true; }
});

test('a stalled task (from before the loop) recovers to running when activity resumes, and the project recovers with it', async () => {
  const p = project(); const t = task(); const c = ctx();
  const now = Date.now();
  Object.assign(t, { status: 'blocked', stalled: true, summary: 'stalled: idle 60 min' });
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

test('the blocked toast fires once per real transition, not on every repeated report (loop off)', async () => {
  config().autonomy.enabled = false;
  after(() => { config().autonomy.enabled = true; });
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
