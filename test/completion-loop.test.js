// The completion loop: projects reach 100% without Sir. Failed or stalled tasks are retried one model rung higher
// within the attempt budget, agents' questions get the safe-default answer, deadlocks and parked merge conflicts are
// re-queued, a paused project is never revived, no task commits/pushes/switches branches outside a dev worktree,
// and the loop ends with exactly one "How did it work out, sir?".
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { test } from 'node:test';

const ROOT = fs.mkdtempSync(path.join(os.tmpdir(), 'rigs-loop-'));
process.env.RIGS_HOME = path.join(ROOT, '.rigs');
process.env.RIGS_NAME = 'macbookpro';
process.env.RIGS_DEV_ROOT = path.join(ROOT, 'rigs-dev');
process.env.RIGS_NO_OPENRIG = '1';
const P = await import('../src/planner.js');
const A = await import('../src/autonomy.js');
const W = await import('../src/work.js');
const { config } = await import('../src/config.js');

const machine = (name, platform, brains = ['claude', 'codex']) => ({
  node: { id: name, name, online: true, rigs: true, platform, gpus: [], stats: { cpu: 5, memUsed: 4, memTotal: 16 }, capabilities: {} },
  brains: brains.map((id) => ({ id, models: [], efforts: [] })), openrig: { daemon: 'running' },
});
let mesh = [machine('macbookpro', 'mac'), machine('magix-system', 'linux')];

function ctx(extra = {}) {
  const c = { calls: [], notes: [], status: {}, merge: null, projects: {} };
  Object.assign(c, {
    snapshot: async () => mesh,
    notify: (text, level) => c.notes.push({ text, level }),
    call: async (node, sub, { body } = {}) => {
      c.calls.push({ node, sub, body });
      if (sub === 'work/start') return { mode: 'openrig', rig: 'r', seat: `seat-${body.task.id}`, qitem: `q-${body.project.id}-${body.task.id}-${body.task.attempts || 0}`, session: { kind: 'rig', id: `seat-${body.task.id}` } };
      if (sub === 'work/status') return c.status[body.qitem] || { state: 'in-progress' };
      if (['work/nudge', 'work/stop'].includes(sub) || /^merge\/\w+\/(retry|resolved)$/.test(sub)) return { ok: true };
      if (sub === 'merge') return { queue: c.merge ? [c.merge] : [] };
      if (sub.startsWith('projects/')) { const p = c.projects[sub.split('/')[1]]; if (!p) throw new Error('project not found'); return p; }
      throw new Error('unexpected ' + sub);
    },
    ...extra,
  });
  return c;
}
const starts = (c, pid, tid) => c.calls.filter((x) => x.sub === 'work/start' && x.body.project.id === pid && (!tid || x.body.task.id === tid));
const reports = (c) => c.notes.filter((n) => /How did it work out, sir\?/.test(n.text));

/** A project with hand-made tasks, routed and dispatched. */
async function project(c, tasks, extra = {}) {
  const p = await P.createProject({ name: extra.name || 'loop', goal: 'g', repoNode: 'macbookpro', repoPath: path.join(ROOT, 'wt') });
  p.tasks = tasks.map((t) => ({ deps: [], needs: { platform: 'any', gpu: false, tool: '' }, suggest: {}, status: 'todo', assign: null, reason: '', run: null, summary: '', kind: 'code', size: 'M', ...t }));
  Object.assign(p, extra);
  P.routeProject(p, mesh);
  p.status = 'planned';
  await P.saveProject(p);
  return P.dispatchReady(p.id, c);
}

// ---------------------------------------------------------------- retry + escalation policy

test('escalation ladder: one rung up per retry (Sonnet medium → Opus high → Opus xhigh), the top rung stays', () => {
  const { ladder, maxAttempts } = A.settings();
  assert.equal(maxAttempts, 3, 'config.autonomy.maxAttempts defaults to 3');
  const step = (a) => { const n = A.nextAssign(a, ladder); return `${n.model} ${n.effort}`; };
  assert.equal(step({ provider: 'claude', model: 'claude-haiku-5-5', effort: 'low' }), 'claude-sonnet-5-5 medium');
  assert.equal(step({ provider: 'claude', model: 'claude-sonnet-5-5', effort: 'low' }), 'claude-sonnet-5-5 medium');
  assert.equal(step({ provider: 'claude', model: 'claude-sonnet-5-5', effort: 'medium' }), 'claude-opus-5-5 high');
  assert.equal(step({ provider: 'claude', model: 'claude-opus-5-5', effort: 'high' }), 'claude-opus-5-5 xhigh');
  assert.equal(step({ provider: 'claude', model: 'claude-opus-5-5', effort: 'xhigh' }), 'claude-opus-5-5 xhigh');
  // A model off the ladder (a Codex review at high) is placed by its effort, then moves up.
  assert.equal(step({ provider: 'codex', model: 'gpt-6.1-sol', effort: 'high' }), 'claude-opus-5-5 xhigh');
});

test('Codex is never used while it is switched off: not on the ladder, not for a retried Codex task', async () => {
  config().routing.avoid = ['codex'];
  config().autonomy.ladder = [{ provider: 'codex', model: 'gpt-6.1-sol', effort: 'high' }, ...A.DEFAULT_LADDER];
  try {
    assert.ok(A.settings().ladder.every((r) => r.provider === 'claude'));
    const c = ctx();
    const p = await project(c, [{ id: 't1', title: 'Review', kind: 'review', assign: { node: 'macbookpro', provider: 'codex', model: 'gpt-6.1-sol', effort: 'high', locked: true } }]);
    await P.updateTask(p.id, 't1', { status: 'failed', summary: 'review incomplete' }, c);
    const s = starts(c, p.id, 't1');
    assert.equal(s.at(-1).body.task.assign.provider, 'claude');
    assert.ok(s.slice(1).every((x) => x.body.task.assign.provider !== 'codex'));
  } finally { config().routing.avoid = []; config().autonomy.ladder = []; }
});

test('per-project budget: p.autonomy.maxAttempts overrides config.autonomy.maxAttempts', async () => {
  const c = ctx();
  const p = await project(c, [{ id: 't1', title: 'One shot' }], { autonomy: { maxAttempts: 1 } });
  const q = await P.updateTask(p.id, 't1', { status: 'failed', summary: 'nope' }, c);
  assert.equal(q.tasks[0].status, 'failed');
  assert.equal(starts(c, p.id).length, 1);
  assert.equal(reports(c).length, 1);
});

test('a dispatch failure is retried on the same model after a pause, and the loop waits for it', async () => {
  const c = ctx();
  let fail = true;
  const call = c.call;
  c.call = async (node, sub, o) => { if (sub === 'work/start' && fail) { c.calls.push({ node, sub, body: o.body }); throw new Error('duplicate session'); } return call(node, sub, o); };
  const p = await project(c, [{ id: 't1', title: 'Build' }]);
  let t = (await P.getProject(p.id)).tasks[0];
  assert.equal(t.status, 'todo');
  assert.equal(t.attempts, 1);
  assert.equal(t.escalate, undefined, 'the machine failed, not the model');
  assert.ok(t.retryAt > Date.now());
  assert.equal((await P.getProject(p.id)).status, 'running', 'a pending retry is not a stuck project');
  assert.equal(reports(c).length, 0);
  fail = false;
  await P.tick(c, t.retryAt + 1000);
  t = (await P.getProject(p.id)).tasks[0];
  assert.equal(t.status, 'running');
  assert.equal(starts(c, p.id).at(-1).body.task.assign.model, 'claude-sonnet-5-5');
});

// ---------------------------------------------------------------- self-answer rule

test('a question ("blocked") is answered automatically with the safe default, logged, and the task keeps running', async () => {
  const c = ctx();
  const p = await project(c, [{ id: 't1', title: 'Retire projects' }]);
  const q = await P.updateTask(p.id, 't1', { status: 'blocked', summary: 'Should I run project_stop on the live projects? It needs the user\'s OK.' }, c);
  const t = q.tasks[0];
  assert.equal(t.status, 'running');
  assert.equal(q.status, 'running');
  assert.equal(t.questions.length, 1);
  assert.match(t.questions[0].question, /project_stop on the live projects/);
  await new Promise((r) => setImmediate(r));
  const nudge = c.calls.find((x) => x.sub === 'work/nudge');
  assert.equal(nudge.body.qitem, t.run.qitem, 'typed into its own session');
  assert.match(nudge.body.text, /Take the safe default and carry on/);
  assert.match(nudge.body.text, /Stay inside the task/);
  assert.match(nudge.body.text, /never commit, push or switch branches outside a RIGS dev worktree/);
  assert.match(nudge.body.text, /skip it, finish everything else, and report "done"/);
  assert.ok(!c.notes.some((n) => n.level === 'error'), 'not escalated to Sir');
  // After maxSelfAnswers answers, another "blocked" is a failed attempt → retried one rung up.
  for (let i = 1; i < A.settings().maxAnswers; i++) await P.updateTask(p.id, 't1', { status: 'blocked', summary: 'still unsure' }, c);
  const r = await P.updateTask(p.id, 't1', { status: 'blocked', summary: 'still unsure' }, c);
  assert.equal(r.tasks[0].attempts, 1);
  assert.match(r.tasks[0].history[0].why, /still blocked after 3 automatic answers/);
  assert.equal(r.tasks[0].status, 'running', 'the retry started');
});

test('a permission prompt holding the session is declined (safe default) and answered after answerAfterSec', async () => {
  const c = ctx();
  const p = project0();
  const t = p.tasks[0];
  const st = { state: 'in-progress', needsInput: true, question: 'Do you want to run rm -rf build/? 1. Yes 2. No' };
  const t0 = Date.now();
  await P.watchTask(p, t, st, c, t0);
  assert.equal(c.calls.length, 0, 'not at once — the agent may answer itself');
  await P.watchTask(p, t, st, c, t0 + 91000);
  await new Promise((r) => setImmediate(r));
  const n = c.calls.find((x) => x.sub === 'work/nudge');
  assert.equal(n.body.dismiss, true, 'Escape first: decline, never approve');
  assert.match(t.questions[0].question, /rm -rf build/);
  assert.equal(t.status, 'running');
  // It keeps sitting on prompts: after maxSelfAnswers it is failed and retried.
  let now = t0 + 91000;
  for (let i = 0; i < 6 && t.status === 'running'; i++) { now += 91000; await P.watchTask(p, t, st, c, now); }
  assert.equal(t.status, 'todo');
  assert.match(t.lastFailure, /kept waiting for input after 3 automatic answers/);
  assert.equal(c.calls.filter((x) => x.sub === 'work/stop').length, 1);
});

function project0() {
  return { id: 'px', name: 'P', owner: 'macbookpro', status: 'running', log: [], tasks: [
    { id: 't1', title: 'T', status: 'running', deps: [], assign: { node: 'macbookpro', provider: 'claude', model: 'claude-sonnet-5-5', effort: 'medium' }, run: { mode: 'openrig', seat: 's@r', qitem: 'q1', startedAt: Date.now() } },
  ] };
}

// ---------------------------------------------------------------- paused stays paused

test('a project Sir paused is never revived: late failures, questions and ticks start nothing', async () => {
  const c = ctx();
  const p = await project(c, [{ id: 't1', title: 'A' }, { id: 't2', title: 'B' }]);
  await P.stopProject(p.id, c, { reason: 'leave it for now', by: 'JARVIS for Sir' });
  const before = c.calls.length;
  const mine = (x) => x.body?.project?.id === p.id || String(x.body?.qitem || '').startsWith(`q-${p.id}-`);
  await P.updateTask(p.id, 't1', { status: 'failed', summary: 'interrupted' }, c);
  await P.updateTask(p.id, 't2', { status: 'blocked', summary: 'what now?' }, c);
  await P.tick(c, Date.now() + 24 * 3600000);
  await new Promise((r) => setImmediate(r));
  const after = await P.getProject(p.id);
  assert.equal(after.status, 'paused');
  assert.deepEqual(c.calls.slice(before).filter(mine).map((x) => x.sub), [], 'no start, nudge, stop or answer');
  assert.equal(reports(c).length, 0);
});

test('a merge conflict whose resolver Sir paused is left alone; a failed resolver is replaced', async () => {
  const S = A.settings();
  const req = { id: 'm1', status: 'conflict', resolver: { project: 'r1' }, updatedAt: 0 };
  assert.equal(P.conflictAction(req, { status: 'paused' }, {}, Date.now(), S), 'paused');
  assert.equal(P.conflictAction(req, { status: 'running' }, {}, Date.now(), S), 'wait');
  assert.equal(P.conflictAction(req, { status: 'failed' }, {}, Date.now(), S), 'retry');
  assert.equal(P.conflictAction(req, null, {}, Date.now(), S), 'retry', 'resolver gone');
  assert.equal(P.conflictAction({ ...req, resolver: { error: 'duplicate session' } }, null, {}, Date.now(), S), 'retry');
  assert.equal(P.conflictAction({ ...req, resolver: null, updatedAt: Date.now() }, null, {}, Date.now(), S), 'wait', 'being cast');
  assert.equal(P.conflictAction(req, { status: 'failed' }, { conflictRetries: 3 }, Date.now(), S), 'exhausted');

  // Through the tick: paused → no retry call; failed → the steward re-queues it for a new kind-"merge" resolver.
  for (const [status, want] of [['paused', 0], ['failed', 1]]) {
    const id = `m${status}`;
    const c = ctx({ propose: async () => ({ id, steward: 'macbookpro' }) });
    const p = await project(c, [{ id: 't1', title: 'Change' }], { selfDev: { branch: 'work/macbookpro/x' } });
    await P.updateTask(p.id, 't1', { status: 'done', summary: 'ok' }, c);
    c.merge = { ...req, id };
    c.projects.r1 = { id: 'r1', status };
    await P.tick(c);
    assert.equal(c.calls.filter((x) => x.sub === `merge/${id}/retry`).length, want, status);
    const after = await P.getProject(p.id);
    assert.equal(after.status, 'merging');
    if (status === 'paused') assert.ok(after.log.some((l) => /paused by Sir — left as it is/.test(l.text)));
  }
});

test('a merge conflict whose resolver Sir deleted is never replaced by a new resolver', async () => {
  const c = ctx({ propose: async () => ({ id: 'mdel', steward: 'macbookpro' }) });
  const p = await project(c, [{ id: 't1', title: 'Change' }], { selfDev: { branch: 'work/macbookpro/del' } });
  await P.updateTask(p.id, 't1', { status: 'done', summary: 'ok' }, c);
  c.merge = { id: 'mdel', status: 'conflict', resolver: { project: 'gone1' }, updatedAt: 0 }; // no such project any more
  await P.tick(c, Date.now() + 3600000);
  assert.equal(c.calls.filter((x) => /^merge\/mdel\/(retry|resolved)$/.test(x.sub)).length, 0);
  const after = await P.getProject(p.id);
  assert.equal(after.status, 'merging');
  assert.ok(after.log.some((l) => /deleted by Sir — left as it is/.test(l.text)));
});

// ---------------------------------------------------------------- what a retry may not change

test('a "private" task (local models only) is retried on its local model, never escalated to the cloud ladder', () => {
  const local = [machine('macbookpro', 'mac', ['claude', 'ollama'])];
  local[0].brains[1].models = ['llama3.2'];
  const p = { id: 'pv', name: 'PV', owner: 'macbookpro', repo: { node: 'macbookpro', path: '/x' }, gitUrl: '', log: [], tasks: [
    { id: 't1', title: 'Summarize my notes', kind: 'private', size: 'M', status: 'running', deps: [], needs: { platform: 'any', gpu: false, tool: '' }, suggest: {},
      assign: { node: 'macbookpro', provider: 'ollama', model: 'llama3.2', effort: 'off' }, run: { mode: 'direct' } },
  ] };
  assert.equal(P.retryOrFail(p, p.tasks[0], 'model gave up'), 'retry');
  assert.equal(p.tasks[0].escalate, undefined);
  assert.equal(p.tasks[0].assign.provider, 'ollama');
  // Even a stale escalation on a private task does not route it to another provider.
  p.tasks[0].escalate = { provider: 'claude', model: 'claude-opus-5-5', effort: 'high' };
  p.tasks[0].assign = null;
  P.routeProject(p, local, { onlyUnassigned: true });
  assert.equal(p.tasks[0].assign.provider, 'ollama');
});

test('an OpenRig queue item closed as blocked/denied is not the task finishing; a normal closure still is', async () => {
  const c = ctx();
  const p = project0();
  const t = p.tasks[0];
  assert.equal(await P.watchTask(p, t, { state: 'done', closure: 'blocked_on', idle: false, busy: true }, c), false);
  assert.equal(t.status, 'running', 'still owes a report');
  await P.watchTask(p, t, { state: 'done', closure: 'no-follow-on' }, c);
  assert.equal(t.status, 'done');
});

// ---------------------------------------------------------------- deadlocks

test('dependency deadlocks are re-queued: a cycle loses its closing edge, a blocked task is retried', () => {
  const p = { id: 'd', name: 'D', owner: 'm', log: [], tasks: [
    { id: 't1', status: 'todo', deps: ['t2'], assign: { node: 'm', provider: 'claude' } },
    { id: 't2', status: 'todo', deps: ['t1'], assign: { node: 'm', provider: 'claude' } },
    { id: 't3', status: 'blocked', summary: 'waiting for Sir', deps: [], assign: { node: 'm', provider: 'claude', model: 'claude-sonnet-5-5', effort: 'medium' } },
  ] };
  assert.equal(P.requeueDeadlocks(p), true);
  assert.equal([p.tasks[0].deps.length, p.tasks[1].deps.length].filter((n) => n === 0).length, 1, 'exactly one edge removed');
  assert.equal(p.tasks[2].status, 'todo');
  assert.equal(p.tasks[2].assign.model, 'claude-opus-5-5');
  assert.equal(P.requeueDeadlocks(p), false, 'nothing left to fix');
});

test('a task whose platform no machine has next to the folder is placed on the folder\'s machine, not stranded', () => {
  const p = { id: 'u', name: 'U', owner: 'magix-system', repo: { node: 'magix-system', path: '/home/x/repo' }, gitUrl: '', log: [], tasks: [
    { id: 't1', title: 'macOS test', kind: 'test', size: 'M', status: 'todo', deps: [], needs: { platform: 'mac', gpu: false, tool: '' }, suggest: {}, assign: null },
  ] };
  P.placeUnassigned(p, mesh);
  assert.equal(p.tasks[0].assign.node, 'magix-system');
  assert.match(p.tasks[0].relaxed, /needs.platform mac dropped/);
});

// ---------------------------------------------------------------- git guard

test('git guard: briefs lose every commit/push/branch-switch step outside a dev worktree; the rule is stated', () => {
  const brief = [
    'Resolve the conflicts. Then run npm test, git add the files and finish the merge with git commit --no-edit. Do not push.',
    '- git checkout -b feature/x',
    '- Commit on the worktree branch.',
    'Never commit, push or switch branches in this repo.',
    'Read git log origin/main and git status first.',
  ].join('\n');
  const out = A.guardBrief(brief, { devWorktree: false });
  assert.doesNotMatch(out.prompt, /git commit --no-edit|git checkout -b|Commit on the worktree branch/);
  assert.match(out.prompt, /Do not push\./, 'a prohibition stays');
  assert.match(out.prompt, /Never commit, push or switch branches in this repo\./);
  assert.match(out.prompt, /Read git log origin\/main and git status first\./, 'read-only git stays');
  assert.match(out.prompt, /## Git guard \(enforced by RIGS\)\nThis folder is not a RIGS dev worktree/);
  assert.equal(out.stripped.length, 3);
  // Inside a dev worktree commits are the work; pushes and branch switches are still out.
  const dev = A.guardBrief('Commit on the worktree branch. Then git push origin HEAD. git switch main to compare.', { devWorktree: true, branch: 'work/m/x' });
  assert.match(dev.prompt, /Commit on the worktree branch\./);
  assert.doesNotMatch(dev.prompt, /git push origin HEAD|git switch main/);
  assert.match(dev.prompt, /RIGS dev worktree on branch `work\/m\/x`: commit here/);
});

test('git guard: command check and the direct agent\'s deny rules', () => {
  for (const cmd of ['git commit -m x', 'git -C /repo push origin main', 'git checkout main', 'git switch -c x', 'git --no-pager rebase main', 'git pull --ff-only', 'git stash'])
    assert.ok(A.gitViolation(cmd), cmd);
  for (const cmd of ['git status', 'git log --oneline', 'git diff', 'git merge-base HEAD origin/main', 'git add src/x.js', 'npm test'])
    assert.equal(A.gitViolation(cmd), null, cmd);
  assert.equal(A.gitViolation('git commit -m x', { devWorktree: true }), null, 'commits are allowed in a dev worktree');
  assert.equal(A.gitViolation('git push', { devWorktree: true }), 'push');
  const line = W.directLine({ provider: 'claude', model: 'claude-opus-5-5', effort: 'high' }, 'Read /b.md', { devWorktree: false });
  assert.match(line, /--disallowedTools '(Bash\(git [\w-]+:\*\),?)+'/);
  for (const c of ['commit', 'push', 'checkout', 'switch']) assert.ok(line.includes(`Bash(git ${c}:*)`), c);
  assert.match(line, / -- 'Read \/b\.md'$/, 'the prompt can\'t be swallowed by the variadic flag');
  const dev = W.directLine({ provider: 'claude' }, 'p', { devWorktree: true });
  assert.ok(dev.includes('Bash(git push:*)') && !dev.includes('Bash(git commit:*)'));
});

test('git guard: a RIGS change never runs outside a dev worktree; briefs reaching agents are guarded', async () => {
  const outside = path.join(ROOT, 'elsewhere');
  fs.mkdirSync(outside, { recursive: true });
  const task = { id: 't1', title: 'x', kind: 'code', assign: { node: 'macbookpro', provider: 'claude' } };
  await assert.rejects(W.startTask({ project: { id: 'abcd1234', slug: 'x', name: 'x', selfDev: { branch: 'work/m/x' } }, task, prompt: 'p', workdir: outside, mode: 'direct' }),
    /refusing to run a RIGS change outside a dev worktree/);
  const wt = path.join(process.env.RIGS_DEV_ROOT, 'topic');
  fs.mkdirSync(wt, { recursive: true });
  assert.equal(W.isDevWorktree(wt), true);
  assert.equal(W.isDevWorktree(process.env.RIGS_DEV_ROOT), false, 'the dev root itself is not a worktree');
  assert.equal(W.isDevWorktree(outside), false);
  // Two resolver projects with the same slug never share a tmux session.
  assert.notEqual(W.sessionName({ slug: 'merge-conflict-wor', id: 'aaaa11' }, { id: 't1' }), W.sessionName({ slug: 'merge-conflict-wor', id: 'bbbb22' }, { id: 't1' }));
  assert.equal(W.sessionName({ slug: 'merge-conflict-wor', id: 'aaaa11' }, { id: 't1', attempts: 2 }), 'merge-conflict-wor-aaaa-t1-r2');
});

// ---------------------------------------------------------------- the end of the loop

test('100% → exactly one notification: done, retried, answered, open — and Sir\'s reply is stored', async () => {
  const c = ctx();
  const p = await project(c, [{ id: 't1', title: 'Fix layout' }, { id: 't2', title: 'Final review', kind: 'review', deps: ['t1'] }], { name: 'JARVIS · mobile' });
  await P.updateTask(p.id, 't1', { status: 'failed', summary: 'tests red' }, c);
  await P.updateTask(p.id, 't1', { status: 'blocked', summary: 'May I delete the old snapshots?' }, c);
  await P.updateTask(p.id, 't1', { status: 'done', summary: 'layout fixed, npm test green' }, c);
  await P.updateTask(p.id, 't2', { status: 'done', summary: 'verified' }, c);
  await P.tick(c);
  const r = reports(c);
  assert.equal(r.length, 1);
  const text = r[0].text;
  assert.match(text, /^JARVIS · mobile reached 100%: 2 tasks done, 1 after a retry\. How did it work out, sir\?\n---\n/);
  assert.match(text, /\*\*Done \(2\/2\)\*\*\n- Fix layout \(macbookpro, claude claude-opus-5-5 high\): layout fixed/);
  assert.match(text, /\*\*Retried\*\*\n- Fix layout: attempt 1 claude claude-sonnet-5-5 medium — tests red → done with claude claude-opus-5-5 high/);
  assert.match(text, /\*\*Answered automatically \(safe default\)\*\*\n- t1: May I delete the old snapshots\?/);
  assert.doesNotMatch(text, /Still open/);
  assert.match(text, /project_feedback — owner "macbookpro", project "[0-9a-f]+"/);
  const done = await P.getProject(p.id);
  assert.equal(done.status, 'done');
  const fb = await P.addFeedback(p.id, { text: 'Worked well, the retry was right.' });
  assert.equal(fb.feedback[0].text, 'Worked well, the retry was right.');
  assert.equal(fb.feedback[0].by, 'Sir');
});

test('an empty RIGS branch (no commits ahead of main) finishes the project instead of blocking it', async () => {
  const c = ctx({ propose: async () => ({ empty: true, branch: 'work/macbookpro/x' }) });
  const p = await project(c, [{ id: 't1', title: 'Send a Discord message', kind: 'text' }], { selfDev: { branch: 'work/macbookpro/x' } });
  await P.updateTask(p.id, 't1', { status: 'done', summary: 'sent' }, c);
  const after = await P.getProject(p.id);
  assert.equal(after.status, 'done');
  assert.ok(after.log.some((l) => /nothing to merge/.test(l.text)));
  assert.equal(reports(c).length, 1);
});

test('a failing propose is retried on a later tick before the loop gives up', async () => {
  let n = 0;
  const c = ctx({ propose: async () => { n++; if (n < 2) throw new Error('no merge steward online'); return { id: 'm9', steward: 'macbookpro' }; } });
  const p = await project(c, [{ id: 't1', title: 'Change' }], { selfDev: { branch: 'work/macbookpro/y' } });
  await P.updateTask(p.id, 't1', { status: 'done', summary: 'ok' }, c);
  let after = await P.getProject(p.id);
  assert.notEqual(after.status, 'blocked');
  assert.equal(after.selfDev.proposeFails, 1);
  await P.tick(c, after.selfDev.proposeRetryAt + 1000);
  after = await P.getProject(p.id);
  assert.equal(after.status, 'merging');
  assert.equal(reports(c).length, 0, 'not finished yet');
});
