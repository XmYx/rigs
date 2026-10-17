// Autonomy end to end, without models or a daemon: Sir's request → right project + machine → plan with acceptance
// criteria and a final review → dispatch → retries, watchdog nudges, escalation → final report (and, for RIGS
// itself, propose → merge → report). Scenarios A and B are the acceptance cases from docs/self-improvement-2026-10-17.md.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { test } from 'node:test';

const ROOT = fs.mkdtempSync(path.join(os.tmpdir(), 'rigs-autonomy-'));
process.env.RIGS_HOME = path.join(ROOT, '.rigs');
process.env.RIGS_NAME = 'macbookpro';
const ws = await import('../src/workspaces.js');
const router = await import('../src/router.js');
const P = await import('../src/planner.js');

// magix-system: the Mad Mike Unity project and its nightly scheduled task. macbookpro: RIGS checkouts only.
const magixHome = path.join(ROOT, 'magix');
const macHome = path.join(ROOT, 'mac');
const mk = (home, rel, text = '') => { const f = path.join(home, rel); fs.mkdirSync(path.dirname(f), { recursive: true }); fs.writeFileSync(f, text); };
mk(magixHome, 'PycharmProjects/MadMaxUnity/AGENTS.md', "# Mad Mike's Garage — Codex developer guide\n");
mk(magixHome, 'PycharmProjects/MadMaxUnity/share/ProjectSettings/ProjectVersion.txt', 'm_EditorVersion: 6000.6.3f1\n');
fs.mkdirSync(path.join(magixHome, 'PycharmProjects/MadMaxUnity/share/Assets'), { recursive: true });
fs.mkdirSync(path.join(magixHome, 'PycharmProjects/MadMaxUnity/share/.git'), { recursive: true });
mk(magixHome, 'PycharmProjects/CyberNinja/AGENTS.md', '# AGENTS.md — how agents build CyberNinja\n');
mk(magixHome, '.claude/scheduled-tasks/madmikeupdate/SKILL.md', '---\nname: madmikeupdate\ndescription: Check the current game state, the roadmap, and implement what is next\n---\n\nOn a daily schedule, check the Roadmap, implement, test, document, create a nightly release.\n');
mk(macHome, 'Documents/Rigs/AGENTS.md', '# RIGS OS — notes for coding agents working on this repo\n');
fs.mkdirSync(path.join(macHome, 'Documents/Rigs/.git'), { recursive: true });
mk(macHome, 'IdeaProjects/finwatch/CLAUDE.md', '# finwatch\n');

const catalog = [
  { node: 'magix-system', platform: 'linux', items: ws.scan({ roots: [magixHome], home: magixHome }) },
  { node: 'macbookpro', platform: 'mac', items: ws.scan({ roots: [macHome], home: macHome }) },
];

const A = 'Mad Mike update on the macbook';
const B = 'JARVIS feature: make the mobile site more accessible and pleasing to use on mobile';

test('flows: a scheduled task is found and attached to its workspace by name', () => {
  const mm = catalog[0].items.find((x) => x.name === 'MadMaxUnity');
  assert.deepEqual(mm.flows.map((f) => f.name), ['madmikeupdate']);
  assert.match(mm.flows[0].prompt, /nightly release/);
  assert.ok(!catalog[0].items.find((x) => x.name === 'CyberNinja').flows);
  assert.match(ws.catalogLines(catalog).join('\n'), /flows: madmikeupdate/);
});

test('scenario A: "Mad Mike update on the macbook" runs the madmikeupdate flow where the project lives', () => {
  assert.equal(router.heuristicRoute(A).route, 'implement', 'keyword fallback: work, not talk');
  // Even if the router model calls it chat, a named flow is work.
  const d = router.withWork({ route: 'answer', reason: 'status' }, A, { catalog, selfNode: 'macbookpro' });
  assert.equal(d.route, 'implement');
  assert.equal(d.work.length, 1);
  const [w] = d.work;
  assert.equal(w.node, 'magix-system');
  assert.equal(w.workspace.name, 'MadMaxUnity');
  assert.equal(w.flow.name, 'madmikeupdate');
  assert.match(w.note, /lives on magix-system/);
  // The router model naming the machine Sir said still lands where the code is.
  const m = router.bindWork([{ title: 'Mad Mike update', goal: A, workspace: 'Mad Mike', machine: 'macbookpro' }], catalog, A, { selfNode: 'macbookpro' });
  assert.equal(m[0].node, 'magix-system');
  assert.equal(m[0].flow?.name, 'madmikeupdate');
  // A question about it stays a question.
  assert.equal(router.withWork({ route: 'answer' }, 'what did the Mad Mike update do last night?', { catalog }).route, 'answer');
});

test('scenario B: "JARVIS feature: …" becomes a RIGS self-change, never the live checkout', () => {
  assert.equal(router.heuristicRoute(B).route, 'plan');
  const d = router.withWork(router.heuristicRoute(B), B, { catalog, selfNode: 'macbookpro' });
  assert.equal(d.route, 'plan');
  assert.equal(d.work.length, 1);
  assert.equal(d.work[0].self, true);
  assert.equal(d.work[0].node, 'macbookpro');
  // The model binding it to a RIGS checkout (or just "rigs") is the same self-change.
  const m = router.bindWork([{ title: 'Mobile a11y', goal: 'make the mobile site more accessible', workspace: 'Rigs', machine: '' }], catalog, B, { selfNode: 'macbookpro' });
  assert.equal(m[0].self, true);
  assert.ok(router.isRigsCheckout({ path: '/Users/mix/.rigs/app', title: '' }));
  // Talk about JARVIS is still talk.
  assert.equal(router.withWork({ route: 'answer' }, 'how is JARVIS doing today?', { catalog, selfNode: 'macbookpro' }).route, 'answer');
});

// ---------------------------------------------------------------- planning + lifecycle

const machine = (name, platform, brains = ['claude', 'codex']) => ({
  node: { id: name, name, online: true, rigs: true, platform, gpus: [], stats: { cpu: 5, memUsed: 4, memTotal: 16 }, capabilities: {} },
  brains: brains.map((id) => ({ id, models: [], efforts: [] })), openrig: { daemon: 'running' },
});
const mesh = [machine('macbookpro', 'mac'), machine('magix-system', 'linux')];

function ctx(extra = {}) {
  const c = { calls: [], notes: [], status: {}, merge: null };
  Object.assign(c, {
    snapshot: async () => mesh,
    notify: (text, level) => c.notes.push({ text, level }),
    call: async (node, sub, { body } = {}) => {
      c.calls.push({ node, sub, body });
      if (sub === 'work/start') return { mode: 'openrig', rig: 'r', seat: `seat-${body.task.id}`, qitem: `q-${body.project.id}-${body.task.id}`, session: { kind: 'rig', id: `seat-${body.task.id}` } };
      if (sub === 'work/status') return c.status[body.qitem] || { state: 'in-progress' };
      if (sub === 'work/nudge' || sub === 'work/stop') return { ok: true };
      if (sub === 'merge') return { queue: c.merge ? [c.merge] : [] };
      if (sub === 'work/find') return { run: c.found?.[`${body.project.id}-${body.task.id}`] || null };
      throw new Error('unexpected ' + sub);
    },
    ask: async () => ({ text: JSON.stringify({ summary: 's', tasks: [
      { id: 't1', title: 'Audit mobile UI', kind: 'research', size: 'S', acceptance: ['list of issues'], verify: 'screenshots at 390x844' },
      { id: 't2', title: 'Fix layout', kind: 'code', size: 'M', deps: ['t1'], acceptance: ['no horizontal scroll at 390px'], verify: 'npm test && npm run build' },
    ] }) }),
    ...extra,
  });
  return c;
}

test('every plan gets acceptance criteria and ends in a final review of the whole result', async () => {
  const c = ctx();
  const p = await P.createProject({ name: 'JARVIS · mobile', goal: B, repoNode: 'macbookpro', repoPath: path.join(ROOT, 'wt') });
  const planned = await P.planProject(p.id, c);
  assert.deepEqual(planned.tasks.map((t) => t.kind), ['research', 'code', 'review']);
  const review = planned.tasks[2];
  assert.deepEqual(review.deps, ['t2']);
  assert.deepEqual(planned.tasks[1].acceptance, ['no horizontal scroll at 390px']);
  assert.ok(planned.tasks.every((t) => t.assign?.node === 'macbookpro'), 'a local worktree keeps every task next to it');
  assert.equal(review.assign.provider, 'codex', 'the review cross-checks Claude\'s code');
  // An existing trailing review is kept as is.
  const t = P.ensureFinalReview([{ id: 'a', kind: 'code', deps: [] }, { id: 'b', kind: 'review', deps: ['a'] }]);
  assert.equal(t.length, 2);
});

test('the brief carries acceptance criteria, verification and a definition of done', async () => {
  const c = ctx();
  const p = await P.createProject({ name: 'brief', goal: 'g', repoNode: 'macbookpro', repoPath: path.join(ROOT, 'wt2') });
  await P.planProject(p.id, c);
  await P.dispatchReady(p.id, c);
  const brief = c.calls.find((x) => x.sub === 'work/start').body.prompt;
  assert.match(brief, /## Acceptance criteria\n- \[ \] list of issues/);
  assert.match(brief, /## Verify with\nscreenshots at 390x844/);
  assert.match(brief, /## Definition of done/);
  assert.match(brief, /never stop to ask/);
});

test('scenario A plan: the flow runs on magix-system, reviewed by the other agent', async () => {
  const c = ctx();
  const p = await P.createProject({ name: "Mad Mike's Garage · madmikeupdate", goal: A, repoNode: 'magix-system', repoPath: '/home/magix/PycharmProjects/MadMaxUnity' });
  p.flow = { name: 'madmikeupdate', description: 'nightly', prompt: 'create a nightly release', source: 'claude scheduled task' };
  await P.saveProject(p);
  const planned = await P.planFlow(p.id, c);
  assert.deepEqual(planned.tasks.map((t) => [t.kind, t.assign.node]), [['code', 'magix-system'], ['review', 'magix-system']]);
  assert.equal(planned.tasks[1].assign.provider, 'codex');
  await P.dispatchReady(p.id, c);
  assert.match(c.calls.find((x) => x.sub === 'work/start').body.prompt, /madmikeupdate[\s\S]*create a nightly release/);
});

async function runningProject(c, extra = {}) {
  const p = await P.createProject({ name: 'life', goal: 'g', repoNode: 'macbookpro', repoPath: path.join(ROOT, 'wt3') });
  Object.assign(p, extra);
  await P.saveProject(p);
  await P.planProject(p.id, c);
  return P.dispatchReady(p.id, c);
}

test('a failed task is retried with escalation up to the attempt budget, then the loop ends with one report', async () => {
  const c = ctx();
  const p = await runningProject(c);
  const starts = () => c.calls.filter((x) => x.sub === 'work/start' && x.body.project.id === p.id && x.body.task.id === 't1');
  assert.deepEqual([starts()[0].body.task.assign.model, starts()[0].body.task.assign.effort], ['claude-sonnet-5-5', 'medium']);
  let q = await P.updateTask(p.id, 't1', { status: 'failed', summary: 'screenshot tool missing' }, c);
  assert.equal(q.tasks[0].status, 'running', 'retried at once');
  assert.equal(q.tasks[0].attempts, 1);
  assert.deepEqual([starts()[1].body.task.assign.model, starts()[1].body.task.assign.effort], ['claude-opus-5-5', 'high'], 'one rung up');
  const retryBrief = starts()[1].body.prompt;
  assert.match(retryBrief, /Previous attempt 1 did not finish\nscreenshot tool missing/);
  assert.match(retryBrief, /attempt 2, escalated to claude-opus-5-5 high/);
  q = await P.updateTask(p.id, 't1', { status: 'failed', summary: 'still missing' }, c);
  assert.equal(q.tasks[0].status, 'running');
  assert.deepEqual([starts()[2].body.task.assign.model, starts()[2].body.task.assign.effort], ['claude-opus-5-5', 'xhigh']);
  assert.match(starts()[2].body.prompt, /Earlier: attempt 1 \(claude-sonnet-5-5 medium\): screenshot tool missing/);
  q = await P.updateTask(p.id, 't1', { status: 'failed', summary: 'tool really missing' }, c);
  assert.equal(q.tasks[0].status, 'failed', 'budget (3 attempts) spent');
  assert.equal(starts().length, 3);
  assert.equal((await P.getProject(p.id)).status, 'blocked');
  const reports = c.notes.filter((n) => /How did it work out, sir\?/.test(n.text));
  assert.equal(reports.length, 1, 'Sir hears it once');
  assert.match(reports[0].text, /stopped at 0%: the attempt budget is spent/);
  assert.match(reports[0].text, /\*\*Retried\*\*\n- Audit mobile UI: attempt 1 claude claude-sonnet-5-5 medium — screenshot tool missing; attempt 2 claude claude-opus-5-5 high/);
  assert.match(reports[0].text, /\*\*Still open\*\*[\s\S]*Audit mobile UI: failed — tool really missing/);
  await P.tick(c);
  assert.equal(c.notes.filter((n) => /How did it work out/.test(n.text)).length, 1, 'never twice for the same end');
});

test('watchdog: an idle agent is nudged, then escalated; a silent exit is retried', async () => {
  const c = ctx();
  const p = await runningProject(c);
  const t0 = Date.now();
  c.status[`q-${p.id}-t1`] = { state: 'in-progress', idle: true };
  await P.tick(c, t0); // idle noticed
  await P.tick(c, t0 + P.STALL_MS + 1000);
  const nudges = () => c.calls.filter((x) => x.sub === 'work/nudge' && x.body.qitem === `q-${p.id}-t1`);
  assert.equal(nudges().length, 1);
  assert.match(nudges()[0].body.text, /project_task_update/);
  for (let i = 2; i <= P.MAX_NUDGES + 1; i++) await P.tick(c, t0 + i * (P.STALL_MS + 1000));
  assert.equal(nudges().length, P.MAX_NUDGES);
  // No progress after every nudge: the watchdog fails it, stops the old agent and the retry starts a stronger one.
  const st = (await P.getProject(p.id)).tasks[0];
  assert.equal(st.status, 'running');
  assert.equal(st.attempts, 1);
  assert.match(st.history[0].why, /^stalled: idle \d+ min without a report after 3 nudges/);
  assert.equal(st.assign.model, 'claude-opus-5-5');
  assert.equal(c.calls.filter((x) => x.sub === 'work/stop' && x.body.qitem === `q-${p.id}-t1`).length, 1);

  const c2 = ctx();
  const p2 = await runningProject(c2);
  c2.status[`q-${p2.id}-t1`] = { state: 'ended' };
  await P.tick(c2);
  const t = (await P.getProject(p2.id)).tasks[0];
  assert.equal(t.status, 'running', 'restarted');
  assert.equal(t.attempts, 1);
});

test('a finished project is reported with its evidence; a RIGS change is proposed, merged, then reported', async () => {
  const c = ctx();
  const p = await runningProject(c);
  for (const id of ['t1', 't2', 't3']) await P.updateTask(p.id, id, { status: 'done', summary: `${id} verified` }, c);
  assert.equal((await P.getProject(p.id)).status, 'done');
  const report = c.notes.at(-1).text;
  assert.match(report, /^life reached 100%: 3 tasks done\. How did it work out, sir\?\n---\n/);
  assert.equal(c.notes.filter((n) => /How did it work out/.test(n.text)).length, 1);
  assert.match(report, /t2 verified/);

  const proposed = [];
  const c2 = ctx({ propose: async (pr) => { proposed.push(pr.repo.path); return { id: 'm1', steward: 'macbookpro' }; } });
  const s = await runningProject(c2, { selfDev: { branch: 'work/macbookpro/mobile', topic: 'mobile' } });
  for (const id of ['t1', 't2', 't3']) await P.updateTask(s.id, id, { status: 'done', summary: 'ok' }, c2);
  assert.equal((await P.getProject(s.id)).status, 'merging');
  assert.equal(proposed.length, 1);
  c2.merge = { id: 'm1', status: 'checks-failed', failedStage: 'npm test', output: 'not ok 3' };
  await P.tick(c2);
  let pr = await P.getProject(s.id);
  assert.equal(pr.status, 'running');
  assert.equal(pr.tasks.at(-1).id, 'fix1');
  assert.match(c2.calls.filter((x) => x.sub === 'work/start').at(-1).body.prompt, /not ok 3/);
  await P.updateTask(s.id, 'fix1', { status: 'done', summary: 'fixed' }, c2);
  assert.equal(proposed.length, 2, 'proposed again after the fix');
  c2.merge = { id: 'm1', status: 'merged', sha: 'abc1234' };
  await P.tick(c2);
  pr = await P.getProject(s.id);
  assert.equal(pr.status, 'done');
  assert.match(c2.notes.at(-1).text, /merged and rolled out\. How did it work out, sir\?[\s\S]*Merged as abc1234/);
  assert.equal(c2.notes.filter((n) => /How did it work out/.test(n.text)).length, 1, 'one report, at the merge — not at the proposal');
});

test('planning that died with the daemon is restarted for projects Sir asked to run', async () => {
  const c = ctx();
  const p = await P.createProject({ name: 'stuck', goal: 'g', repoNode: 'macbookpro', repoPath: path.join(ROOT, 'wt4') });
  Object.assign(p, { status: 'planning', autoRun: true });
  await P.saveProject(p);
  await P.tick(c, Date.now() + 25 * 60 * 1000);
  await new Promise((r) => setTimeout(r, 200));
  const after = await P.getProject(p.id);
  assert.ok(['planned', 'running'].includes(after.status), after.status);
  assert.ok(after.log.some((l) => /planning never finished — planning again/.test(l.text)));
});

test('a task left blocked is re-queued by the tick instead of waiting for Sir', async () => {
  const c = ctx();
  const p = await runningProject(c);
  const pr = await P.getProject(p.id);
  Object.assign(pr.tasks[0], { status: 'blocked', summary: 'needs Sir\'s go-ahead', run: null }); // reported before the loop existed
  await P.saveProject(pr);
  await P.tick(c);
  await P.tick(c);
  const after = await P.getProject(p.id);
  assert.equal(after.status, 'running');
  assert.equal(after.tasks[0].status, 'running', 'started again');
  assert.match(after.tasks[0].history[0].why, /was blocked: needs Sir's go-ahead/);
  assert.ok(!c.notes.some((n) => /needs you/.test(n.text)));
});

test('with the loop switched off (autonomy.enabled=false) a project nothing can move is escalated to Sir', async () => {
  const { config } = await import('../src/config.js');
  config().autonomy.enabled = false;
  try {
    const c = ctx();
    const p = await runningProject(c);
    const pr = await P.getProject(p.id);
    pr.tasks[0].status = 'blocked';
    await P.saveProject(pr);
    await P.tick(c);
    assert.equal((await P.getProject(p.id)).status, 'blocked');
    assert.ok(c.notes.some((n) => /needs you/.test(n.text)));
  } finally { config().autonomy.enabled = true; }
});

test('concurrent reports and ticks never lose a write or cast a second agent', async () => {
  const c = ctx();
  const p = await runningProject(c);
  // The audit reports done while a tick runs: t2 starts exactly once and stays running.
  await Promise.all([P.updateTask(p.id, 't1', { status: 'done', summary: 'audit' }, c), P.tick(c), P.tick(c)]);
  const after = await P.getProject(p.id);
  assert.equal(after.tasks[1].status, 'running');
  assert.ok(after.tasks[1].run, 'its run handle survived');
  assert.equal(c.calls.filter((x) => x.sub === 'work/start' && x.body.task.id === 't2' && x.body.project.id === p.id).length, 1);
});

test('a task stuck "starting" whose agent is in fact running is adopted, not cast again', async () => {
  const c = ctx();
  const p = await runningProject(c);
  const pr = await P.getProject(p.id);
  Object.assign(pr.tasks[0], { status: 'starting', run: null, startingAt: Date.now() - 20 * 60 * 1000 });
  await P.saveProject(pr);
  c.found = { [`${p.id}-t1`]: { mode: 'openrig', seat: 'team-code-opus@x', qitem: 'q-live', session: { kind: 'rig', id: 'team-code-opus@x' } } };
  const starts = c.calls.filter((x) => x.sub === 'work/start').length;
  await P.tick(c);
  const t = (await P.getProject(p.id)).tasks[0];
  assert.equal(t.status, 'running');
  assert.equal(t.run.qitem, 'q-live');
  assert.equal(c.calls.filter((x) => x.sub === 'work/start').length, starts, 'no second agent');
});

test('the installed checkout stays clean: no agents run in it, injected guide blocks are removed', async () => {
  const { isInstall } = await import('../src/work.js');
  const { APP_DIR } = await import('../src/util.js');
  const { cleanInjectedGuides } = await import('../src/updater.js');
  assert.ok(isInstall(APP_DIR) && isInstall(path.join(APP_DIR, 'ui')));
  assert.ok(!isInstall(path.join(ROOT, 'wt')));
  const dir = fs.mkdtempSync(path.join(ROOT, 'install-'));
  const M = ['OpenRig', 'MANAGED', 'BLOCK'].join(' '); // spelled out, the merge guard would flag this test file
  fs.writeFileSync(path.join(dir, 'CLAUDE.md'), `# Claude Code instructions\n\nRead AGENTS.md.\n\n\n<!-- BEGIN ${M}: openrig-start.md -->\n# OpenRig Start\n<!-- END ${M}: openrig-start.md -->\n`);
  assert.deepEqual(cleanInjectedGuides(dir), ['CLAUDE.md']);
  assert.equal(fs.readFileSync(path.join(dir, 'CLAUDE.md'), 'utf8'), '# Claude Code instructions\n\nRead AGENTS.md.\n');
  assert.deepEqual(cleanInjectedGuides(dir), []);
});
