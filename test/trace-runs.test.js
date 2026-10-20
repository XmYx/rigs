// Request traces past the brain's reply (src/trace.js + planner.js / work.js): a fixture Claude Code transcript slice
// → assistant + tool-call spans; a project run with a stubbed brain and a stubbed runner → plan, dispatch, task-run and
// event spans (retry / escalation / automatic answer) under the original request's trace; the mesh view of one trace
// merging spans from a mocked peer and marking the machines that did not answer. No real OpenRig is involved.
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import http from 'node:http';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { after, test } from 'node:test';
import { fileURLToPath } from 'node:url';

const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'rigs-trace-runs-'));
Object.assign(process.env, {
  RIGS_HOME: path.join(TMP, 'rigs'), RIGS_NO_OPENRIG: '1', RIGS_NO_AUTOUPDATE: '1', RIGS_NO_MIGRATIONS: '1', RIGS_NAME: 'magix-system',
});
after(() => fs.rmSync(TMP, { recursive: true, force: true }));

const T = await import('../src/trace.js');
const P = await import('../src/planner.js');
const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
// The fixture is dated 2026-10-18; spans are stored (and read back) by day, starting at the day in the trace id, which is
// today's. So every date in this file is rebased onto today's UTC day, or the test breaks the day after it was written.
const DAY = new Date().toISOString().slice(0, 10);
const FIXTURE = fs.readFileSync(path.join(ROOT, 'test/fixtures/claude-run-transcript.jsonl'), 'utf8').replaceAll('2026-10-18', DAY).split('\n').filter(Boolean).map((l) => JSON.parse(l));
const at = (iso) => Date.parse(iso.replace('2026-10-18', DAY));
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/** An indented one-line-per-span print of a tree (the evidence the task summary quotes). */
function printTree(roots, depth = 0, out = []) {
  for (const n of roots) {
    const meta = n.meta || {};
    const facts = [n.status, n.end != null ? `${n.end - n.start}ms` : 'running', n.node,
      meta.target && `→ ${meta.target}`, meta.seat && `seat ${meta.seat}`, meta.reported && `reported ${meta.reported}`,
      n.kind === 'assistant' && `${meta.inputTokens}+${meta.outputTokens} tok`, meta.toolCalls != null && n.kind !== 'assistant' && `${meta.toolCalls} tool calls`,
      meta.to && `to ${meta.to.model} ${meta.to.effort}`, meta.routing && `routing ${meta.routing.map((r) => `${r.task}→${r.node}/${r.model}`).join(', ')}`].filter(Boolean).join(' · ');
    out.push(`${'  '.repeat(depth)}- ${n.kind} "${n.name}" (${facts})`);
    printTree(n.children || [], depth + 1, out);
  }
  return out;
}

// ---------------------------------------------------------------- transcript slice → spans

test('transcriptSpans: a Claude Code slice → assistant spans with tokens, and ordered tool-call spans with args, results, durations and errors', () => {
  const since = at('2026-10-18T10:00:00.000Z');
  const until = at('2026-10-18T10:00:22.000Z');
  const spans = T.transcriptSpans(FIXTURE, { traceId: 'tr-20261018-aaaaaaaaaaaa', parentId: 'sp-000000000001', node: 'box', since, until, session: 'sess-fixture' });
  const msgs = spans.filter((s) => s.kind === 'assistant');
  const tools = spans.filter((s) => s.kind === 'tool-call');
  assert.deepEqual(msgs.map((m) => m.meta.messageId), ['msg_A', 'msg_B', 'msg_C'], 'the message before the window is left out');
  for (const m of msgs) assert.equal(m.parentId, 'sp-000000000001');
  // each API message once (Claude Code repeats its usage on every block record)
  assert.deepEqual(msgs.map((m) => [m.meta.inputTokens, m.meta.outputTokens, m.meta.cacheReadTokens, m.meta.cacheWriteTokens, m.meta.toolCalls]), [[3, 40, 1000, 200, 1], [5, 60, 1200, 0, 2], [7, 90, 1500, 10, 2]]);
  assert.equal(msgs[0].input, 'Read /home/x/.rigs/briefs/demo/demo-t1.md and carry out the task it describes.', 'the prompt that started it');
  assert.equal(msgs[0].output, 'Running the tests first.');
  assert.deepEqual([msgs[0].start, msgs[0].end], [since, at('2026-10-18T10:00:03.000Z')], 'a message lasts from its input to its last block');
  assert.equal(msgs[1].start, at('2026-10-18T10:00:13.000Z'), 'the next message starts when the tool result came back');

  assert.deepEqual(tools.map((t) => t.name), ['Bash', 'Read', 'Grep', 'mcp__rigs__project_task_update', 'Bash'], 'ordered by start');
  const [bash, read, grep, report, hung] = tools;
  assert.deepEqual(bash.input, { command: 'npm test', description: 'Run the tests' });
  assert.match(bash.output, /# pass 5/);
  assert.deepEqual([bash.status, bash.meta.durationMs, bash.meta.toolUseId, bash.parentId], ['ok', 10000, 'toolu_1', msgs[0].spanId]);
  assert.deepEqual([read.output, read.meta.durationMs, read.parentId], ["import crypto from 'node:crypto';", 2000, msgs[1].spanId]);
  assert.deepEqual([grep.status, grep.output, grep.meta.durationMs], ['error', 'No matches found', 500], 'is_error → an error span');
  assert.deepEqual([report.status, report.meta.durationMs], ['ok', 4500], 'a result that arrives just after the window still closes its call');
  assert.equal(hung.status, 'stopped', 'a call without a result ends stopped');
  assert.equal(hung.meta.noResult, true);
  // stable ids: reading the same slice again writes the same spans (last line wins), never duplicates
  const again = T.transcriptSpans(FIXTURE, { traceId: 'tr-20261018-aaaaaaaaaaaa', parentId: 'sp-000000000001', node: 'box', since, until, session: 'sess-fixture' });
  assert.deepEqual(again.map((s) => s.spanId), spans.map((s) => s.spanId));
  assert.deepEqual(T.runTotals(spans), { messages: 3, toolCalls: 5, toolErrors: 1, inputTokens: 15, outputTokens: 190, cacheReadTokens: 3700, cacheWriteTokens: 210 });
});

test('transcriptSpans: a Codex rollout → assistant spans with token counts and function-call spans', () => {
  const ts = (s) => `${DAY}T11:00:${String(s).padStart(2, '0')}.000Z`;
  const recs = [
    { type: 'turn_context', timestamp: ts(0), payload: { model: 'gpt-6.1-sol' } },
    { type: 'response_item', timestamp: ts(1), payload: { type: 'message', role: 'user', content: [{ type: 'input_text', text: 'Read the brief' }] } },
    { type: 'response_item', timestamp: ts(3), payload: { type: 'message', role: 'assistant', id: 'm1', content: [{ type: 'output_text', text: 'Looking.' }] } },
    { type: 'response_item', timestamp: ts(4), payload: { type: 'function_call', name: 'shell', arguments: '{"command":["ls"]}', call_id: 'c1' } },
    { type: 'response_item', timestamp: ts(6), payload: { type: 'function_call_output', call_id: 'c1', output: 'Exit code: 2\nls: no such file' } },
    { type: 'event_msg', timestamp: ts(6), payload: { type: 'token_count', info: { last_token_usage: { input_tokens: 120, cached_input_tokens: 100, output_tokens: 15 } } } },
  ];
  const spans = T.transcriptSpans(recs, { traceId: 'tr-20261018-bbbbbbbbbbbb', parentId: 'sp-000000000002', node: 'box', provider: 'codex', session: 'rollout-1' });
  assert.deepEqual(spans.map((s) => [s.kind, s.name]), [['assistant', 'gpt-6.1-sol'], ['tool-call', 'shell']]);
  assert.deepEqual([spans[0].input, spans[0].output, spans[0].meta.inputTokens, spans[0].meta.cacheReadTokens, spans[0].meta.outputTokens], ['Read the brief', 'Looking.', 20, 100, 15]);
  assert.deepEqual([spans[1].input, spans[1].status, spans[1].meta.durationMs, spans[1].parentId], [{ command: ['ls'] }, 'error', 2000, spans[0].spanId]);
});

test('recordRunEnd: the run\'s task span is finished on the machine that ran it, with the transcript\'s spans under it', async () => {
  const intake = T.startSpan({ kind: 'intake', name: 'jarvis/send', input: 'unit' });
  const run = T.startRun({ traceId: intake.traceId, parentId: intake.spanId }, {
    project: { id: 'demo', name: 'Demo' }, task: { id: 't1', title: 'Do it', kind: 'code', size: 'S', assign: { provider: 'claude', model: 'claude-opus-5-5', effort: 'high' } },
    prompt: 'the brief', run: { mode: 'openrig', seat: 'team-code-opus@demo-1234', qitem: 'q-1' }, gitGuard: { devWorktree: true, branch: 'work/x/y', stripped: [] }, start: at('2026-10-18T09:59:59.000Z'),
  });
  assert.equal(run.parentId, intake.spanId);
  const seen = [];
  const r = await T.recordRunEnd({ trace: run, since: at('2026-10-18T10:00:00.000Z'), until: at('2026-10-18T10:00:22.000Z'), status: 'done', summary: 'tests pass', seat: 'team-code-opus@demo-1234', brief: '/b.md' },
    { transcripts: async (q) => { seen.push(q); return [{ id: 'sess-fixture', provider: 'claude', records: FIXTURE }]; } });
  assert.deepEqual(seen.map((q) => [q.seat, q.brief]), [['team-code-opus@demo-1234', '/b.md']]);
  assert.deepEqual([r.spans, r.toolCalls, r.messages, r.status], [8, 5, 3, 'ok']);
  const t = await T.get(intake.traceId);
  const task = t.spans.find((s) => s.spanId === run.spanId);
  assert.deepEqual([task.kind, task.status, task.end, task.output.summary, task.meta.reported, task.meta.seat, task.meta.gitGuard.devWorktree, task.meta.inputTokens, task.meta.toolCalls, task.meta.sessions],
    ['task', 'ok', at('2026-10-18T10:00:22.000Z'), 'tests pass', 'done', 'team-code-opus@demo-1234', true, 15, 5, ['sess-fixture']]);
  assert.equal(task.input.brief, 'the brief', 'the brief the run got (and the start fields) survive the end');
  assert.equal(t.spans.filter((s) => s.parentId === run.spanId && s.kind === 'assistant').length, 3);
  assert.equal(T.runEndBody({ run: { traceRun: run, seat: 's', brief: 'b', cwd: '/w' }, since: 1, until: 2, status: 'failed', summary: 'x', task: { attempts: 1 } }).attempt, 2);
  assert.equal(T.runEndBody({ run: { seat: 's' } }), null, 'an untraced run sends nothing');
});

// ---------------------------------------------------------------- a whole project run

const machine = (name) => ({
  node: { id: name, name, online: true, rigs: true, platform: 'linux', gpus: [], stats: { cpu: 5, memUsed: 4, memTotal: 16 }, capabilities: {} },
  brains: [{ id: 'claude', models: [], efforts: [] }], openrig: { daemon: 'running' },
});

test('a project run (stubbed brain + stubbed runner) → plan, dispatch, per-task run, transcript and event spans under the request\'s trace', async () => {
  const intake = T.startSpan({ kind: 'intake', name: 'jarvis/send', input: 'build the demo feature' });
  const handoff = intake.child({ kind: 'handoff', name: 'project_create' });
  const asked = [];
  const runs = [];
  let sessions = 0;
  // the runner's machine maps the fixture transcript into each run's window (real runs take minutes, this one ms)
  const transcripts = async (q) => {
    const f0 = at('2026-10-18T10:00:00.000Z');
    const scale = (q.until - q.since - 2) / 22000;
    const records = FIXTURE.map((r) => (r.timestamp ? { ...r, timestamp: new Date(q.since + 1 + (at(r.timestamp) - f0) * scale).toISOString() } : r));
    return [{ id: `sess-${++sessions}`, provider: 'claude', records }];
  };
  const pending = [];
  P.onRunEnd((e) => { const pr = T.recordRunEnd(T.runEndBody(e), { transcripts }); pending.push(pr); return pr; });
  const ctx = {
    calls: [], notes: [],
    snapshot: async () => [machine('magix-system'), machine('macbookpro')],
    notify: (text) => ctx.notes.push(text),
    ask: async (node, prompt, opts) => {
      asked.push({ node, prompt, trace: opts.trace });
      return { text: JSON.stringify({ summary: 'build then review', tasks: [
        { id: 't1', title: 'Build the feature', kind: 'code', size: 'M', description: 'build it', acceptance: ['works'], verify: 'npm test', deps: [] },
        { id: 't2', title: 'Review it', kind: 'review', size: 'S', description: 'check it', acceptance: ['ok'], verify: 'npm test', deps: ['t1'] },
      ] }) };
    },
    call: async (node, sub, { body } = {}) => {
      ctx.calls.push({ node, sub, body });
      if (sub === 'work/start') {
        // what work.startTask does on the runner's machine once its agent is up
        const r = { mode: 'openrig', rig: 'demo-1234', seat: `seat-${body.task.id}`, qitem: `q-${body.task.id}-${body.task.attempts || 0}`, cwd: '/w', brief: `/briefs/${body.task.id}.md`, session: { kind: 'rig', id: `seat-${body.task.id}` } };
        const traceRun = T.startRun(body.trace, { project: body.project, task: body.task, prompt: body.prompt, run: r, gitGuard: { devWorktree: true, branch: 'work/magix-system/demo', stripped: [] } });
        runs.push(traceRun);
        return { ...r, traceRun };
      }
      if (sub === 'work/nudge') return { ok: true };
      throw new Error('unexpected ' + sub);
    },
  };

  const p0 = await P.createProject({ name: 'Demo', goal: 'build the demo feature', repoNode: 'magix-system', repoPath: path.join(TMP, 'wt') });
  p0.trace = handoff.ctx;
  await P.saveProject(p0);
  let p = await P.planProject(p0.id, ctx);
  assert.equal(p.tasks.length, 2);
  // t1 starts on the ladder's first rung so a failure steps it up
  p.tasks[0].assign = { ...p.tasks[0].assign, model: 'claude-sonnet-5-5', effort: 'medium' };
  await P.saveProject(p);
  await P.dispatchReady(p.id, ctx);
  await sleep(40);
  await P.updateTask(p.id, 't1', { status: 'blocked', summary: 'Which test runner should I use?' }, ctx); // answered automatically
  await sleep(40);
  await P.updateTask(p.id, 't1', { status: 'failed', summary: 'tests failed: 2 of 5' }, ctx); // retried one rung up, started again
  await sleep(40);
  await P.updateTask(p.id, 't1', { status: 'done', summary: 'built; 5/5 tests pass' }, ctx); // starts t2
  await sleep(40);
  p = await P.updateTask(p.id, 't2', { status: 'done', summary: 'reviewed: goal met' }, ctx);
  assert.equal(p.status, 'done');
  intake.end({ output: 'done' });
  handoff.end({ meta: { projectId: p.id } });
  await Promise.all(pending);
  await T.flush();

  const t = await T.get(intake.traceId);
  const of = (k) => t.spans.filter((s) => s.kind === k);
  for (const s of t.spans) assert.equal(s.traceId, intake.traceId);
  assert.equal(t.tree.length, 1, 'one tree under the original request');
  console.log(`span tree of the fixture project run (${t.spans.length} spans):\n${printTree(t.tree).join('\n')}`);

  const [plan] = of('plan');
  assert.equal(plan.parentId, handoff.spanId);
  assert.equal(asked[0].trace.parentId, plan.spanId, 'the planning brain turn hangs under the plan span');
  assert.match(plan.input.prompt, /You are the planning brain of RIGS/);
  assert.deepEqual(plan.output.tasks.map((x) => x.id), ['t1', 't2'], 'the plan JSON');
  assert.deepEqual(plan.meta.routing.map((r) => [r.task, r.node, r.provider]), [['t1', 'magix-system', 'claude'], ['t2', 'magix-system', 'claude']]);
  assert.ok(plan.meta.routing.every((r) => r.why && 'model' in r && 'effort' in r), 'routing says why');

  const dispatches = of('dispatch');
  assert.deepEqual(dispatches.map((d) => [d.meta.taskId, d.meta.attempt, d.meta.target, d.parentId === handoff.spanId]), [['t1', 1, 'magix-system', true], ['t1', 2, 'magix-system', true], ['t2', 1, 'magix-system', true]]);
  assert.deepEqual([dispatches[0].input.model, dispatches[1].input.model, dispatches[1].input.effort], ['claude-sonnet-5-5', 'claude-opus-5-5', 'high'], 'the retry went one rung up');

  const tasks = of('task');
  assert.equal(tasks.length, 3);
  for (const [i, run] of runs.entries()) {
    const s = tasks.find((x) => x.spanId === run.spanId);
    assert.equal(s.parentId, dispatches[i].spanId, 'each run under its dispatch');
    assert.equal(s.meta.gitGuard.branch, 'work/magix-system/demo');
    assert.equal(s.meta.inputTokens, 15, 'tokens from the run\'s transcript slice');
    assert.equal(t.spans.filter((x) => x.kind === 'tool-call' && t.spans.find((m) => m.spanId === x.parentId)?.parentId === s.spanId).length, 5, 'its tool calls');
  }
  const run1 = tasks.find((x) => x.spanId === runs[0].spanId);
  assert.deepEqual([run1.status, run1.meta.reported, run1.output.summary], ['error', 'failed', 'tests failed: 2 of 5']);
  assert.deepEqual([tasks.find((x) => x.spanId === runs[1].spanId).output.summary, tasks.find((x) => x.spanId === runs[2].spanId).meta.seat], ['built; 5/5 tests pass', 'seat-t2']);

  const ev = of('event');
  const question = ev.find((e) => e.name === 'question');
  assert.equal(question.parentId, runs[0].spanId, 'the question was asked in the first run');
  assert.equal(question.input, 'Which test runner should I use?');
  assert.match(question.output, /Take the safe default/);
  assert.equal(question.meta.answer, 'safe default (automatic)');
  const esc = ev.find((e) => e.name === 'escalate');
  assert.equal(esc.parentId, runs[0].spanId);
  assert.deepEqual([esc.input, esc.meta.from.model, esc.meta.to.model, esc.meta.to.effort, esc.meta.nextAttempt], ['tests failed: 2 of 5', 'claude-sonnet-5-5', 'claude-opus-5-5', 'high', 2]);

  const sum = t.summary;
  assert.deepEqual([sum.taskRuns, sum.toolCalls, sum.taskIds.sort()], [3, 15, ['t1', 't2']]);
  assert.equal(sum.inputTokens, 45);
});

test('retryOrFail: a task out of attempts leaves a "failed" event; a machine failure retries without escalating', async () => {
  const intake = T.startSpan({ kind: 'intake', name: 'x' });
  const p = { id: 'pp', owner: 'magix-system', name: 'P', trace: intake.ctx, autonomy: { maxAttempts: 2 }, log: [], tasks: [] };
  const t = { id: 't1', title: 'T', kind: 'code', attempts: 0, assign: { node: 'a', provider: 'claude', model: 'claude-opus-5-5', effort: 'xhigh' }, run: { traceRun: { traceId: intake.traceId, spanId: 'sp-0000000000aa' } } };
  assert.equal(P.retryOrFail(p, t, 'dispatch to a failed: ECONNREFUSED', { escalate: false, delayMs: 60000 }), 'retry');
  t.run = { traceRun: { traceId: intake.traceId, spanId: 'sp-0000000000bb' } };
  assert.equal(P.retryOrFail(p, t, 'stalled'), 'failed');
  await T.flush();
  const ev = (await T.get(intake.traceId)).spans.filter((s) => s.kind === 'event');
  assert.deepEqual(ev.map((e) => [e.name, e.parentId, e.status]), [['retry', 'sp-0000000000aa', 'ok'], ['failed', 'sp-0000000000bb', 'error']]);
  assert.deepEqual([ev[0].meta.escalate, ev[0].meta.delayMs, ev[0].meta.to], [false, 60000, null]);
});

// ---------------------------------------------------------------- mesh: one trace from several machines

test('mergeTrace: spans from two machines form one tree; a machine that was sent work but did not answer is a marked gap', () => {
  const tr = 'tr-20261018-cccccccccccc';
  const s = (spanId, parentId, kind, node, extra = {}) => ({ traceId: tr, spanId, parentId, kind, name: kind, node, start: 1000 + Number(spanId.slice(-2)), end: 2000, status: 'ok', input: null, output: null, meta: {}, ...extra });
  const owner = [s('sp-000000000001', '', 'intake', 'a'), s('sp-000000000002', 'sp-000000000001', 'dispatch', 'a', { meta: { target: 'b', taskId: 't1' } }), s('sp-000000000003', 'sp-000000000001', 'dispatch', 'a', { meta: { target: 'c', taskId: 't2' } })];
  const peer = [s('sp-000000000004', 'sp-000000000002', 'task', 'b'), s('sp-000000000005', 'sp-000000000004', 'tool-call', 'b')];
  const m = T.mergeTrace(tr, [{ node: { name: 'a' }, report: { spans: owner } }, { node: { name: 'b' }, report: { spans: peer } }, { node: { name: 'c' }, error: 'offline' }]);
  assert.equal(m.tree.length, 1);
  const [d1, d2] = m.tree[0].children;
  assert.deepEqual(d1.children.map((x) => [x.kind, x.node, x.children.length]), [['task', 'b', 1]]);
  assert.deepEqual(d2.children.map((x) => [x.kind, x.node, x.status, x.meta.error]), [['gap', 'c', 'error', 'offline']]);
  assert.deepEqual(m.gaps, [{ node: 'c', error: 'offline', parentId: 'sp-000000000003', taskId: 't2' }]);
  assert.deepEqual(m.errors, [{ node: 'c', error: 'offline' }]);
  assert.equal(m.summary.spans, 5, 'the summary counts real spans only');
});

test('API: mesh GET /api/traces/<id> gathers a trace from a mocked peer and marks the unreachable machines', { skip: process.platform === 'win32' && 'spawns a scratch node' }, async () => {
  const traceId = 'tr-20261018-dddddddddddd';
  const now = Date.now();
  const span = (spanId, parentId, kind, node, meta = {}, extra = {}) => ({ traceId, spanId, parentId, kind, name: `${kind} ${spanId.slice(-2)}`, node, start: now + Number.parseInt(spanId.slice(-2), 16), end: now + 500, status: 'ok', input: null, output: null, meta, ...extra });
  // peer-b answers with the run it did; peer-c is up but its trace store fails; "ghost" is never seen at all
  const peers = {
    'peer-b': (url) => (url.startsWith('/api/local/traces/') ? [200, { traceId, node: 'peer-b', spans: [span('sp-0000000000b1', 'sp-000000000002', 'task', 'peer-b', { seat: 'team-code@x' }), span('sp-0000000000b2', 'sp-0000000000b1', 'assistant', 'peer-b'), span('sp-0000000000b3', 'sp-0000000000b2', 'tool-call', 'peer-b', {}, { status: 'error' })] }] : null),
    'peer-c': (url) => (url.startsWith('/api/local/traces/') ? [500, { error: 'disk full' }] : null),
  };
  const fakes = await Promise.all(Object.entries(peers).map(([name, route]) => new Promise((resolve) => {
    const srv = http.createServer((req, res) => {
      const r = req.url.startsWith('/api/local/info') ? [200, { id: `id-${name}`, name, platform: 'linux', version: 'test' }] : route(req.url) || [404, { error: 'not found' }];
      res.writeHead(r[0], { 'content-type': 'application/json' });
      res.end(JSON.stringify(r[1]));
    }).listen(0, '127.0.0.1', () => resolve(srv));
  })));
  const HOME = path.join(TMP, 'mesh-node');
  const RHOME = path.join(HOME, '.rigs');
  fs.mkdirSync(path.join(RHOME, 'traces'), { recursive: true });
  const own = [span('sp-000000000001', '', 'intake', 'test-node', {}, { input: 'build it on three machines' }),
    span('sp-000000000002', 'sp-000000000001', 'dispatch', 'test-node', { target: 'peer-b', taskId: 't1' }),
    span('sp-000000000003', 'sp-000000000001', 'dispatch', 'test-node', { target: 'peer-c', taskId: 't2' }),
    span('sp-000000000004', 'sp-000000000001', 'dispatch', 'test-node', { target: 'ghost', taskId: 't3' })];
  fs.writeFileSync(path.join(RHOME, 'traces', new Date(now).toISOString().slice(0, 10) + '.jsonl'), own.map((x) => JSON.stringify(x)).join('\n') + '\n');
  // a port the OS says is free: a random one in 20000-40000 can collide with another run's server or an ephemeral port
  const PORT = await new Promise((resolve) => { const s = net.createServer().listen(0, '127.0.0.1', () => { const { port } = s.address(); s.close(() => resolve(port)); }); });
  const BASE = `http://127.0.0.1:${PORT}`;
  const env = {
    ...process.env, HOME, RIGS_HOME: RHOME, RIGS_SSH_DIR: path.join(HOME, 'ssh'), RIGS_CLAUDE_DIR: path.join(HOME, 'claude'), RIGS_CODEX_DIR: path.join(HOME, 'codex'),
    RIGS_PORT: String(PORT), RIGS_NAME: 'test-node', RIGS_MESH_TOKEN: 'test-token', RIGS_OLLAMA_URL: 'http://127.0.0.1:9',
    RIGS_PEERS: fakes.map((f) => `http://127.0.0.1:${f.address().port}`).join(','),
  };
  const server = spawn(process.execPath, [path.join(ROOT, 'bin/rigs.js'), 'serve'], { env, stdio: ['ignore', 'pipe', 'pipe'] });
  let log = '';
  server.stdout.on('data', (d) => { log += d; });
  server.stderr.on('data', (d) => { log += d; });
  try {
    let m = null;
    for (let i = 0; i < 100; i++) {
      try {
        const r = await fetch(`${BASE}/api/traces/${traceId}`);
        if (r.ok) { m = await r.json(); if (['peer-b', 'peer-c'].every((n) => m.nodes.includes(n))) break; }
      } catch {}
      await sleep(200);
    }
    assert.ok(m && m.nodes.includes('peer-b') && m.nodes.includes('peer-c'), 'the scratch node never saw both peers:\n' + JSON.stringify(m) + log);
    assert.deepEqual(new Set(m.spans.filter((s) => s.kind !== 'gap').map((s) => s.node)), new Set(['test-node', 'peer-b']), 'spans from both machines');
    assert.equal(m.tree.length, 1);
    const kids = Object.fromEntries(m.tree[0].children.map((d) => [d.meta.target, d.children.map((c) => `${c.kind}@${c.node}${c.kind === 'gap' ? `: ${c.meta.error}` : ''}`)]));
    assert.deepEqual(kids, { 'peer-b': ['task@peer-b'], 'peer-c': ['gap@peer-c: disk full'], ghost: ['gap@ghost: not reachable'] });
    assert.deepEqual(m.gaps.map((g) => [g.node, g.taskId]), [['peer-c', 't2'], ['ghost', 't3']]);
    assert.deepEqual(m.errors, [{ node: 'peer-c', error: 'disk full' }]);
    assert.equal(m.summary.status, 'ok', 'a failed tool call inside a run does not fail the trace');
    assert.equal(m.summary.taskRuns, 1);
  } finally {
    server.kill();
    for (const f of fakes) f.close();
  }
});
