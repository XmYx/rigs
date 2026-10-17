// Work dashboard data: plan-limit parsing, transcript token accounting, project progress (no daemon needed).
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { after, test } from 'node:test';
import { fileURLToPath } from 'node:url';

// A throwaway RIGS home and agent homes for the usage ledger: never the real ~/.rigs, ~/.claude or ~/.codex.
const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'rigs-usage-'));
Object.assign(process.env, {
  RIGS_HOME: path.join(TMP, 'rigs'), RIGS_CLAUDE_DIR: path.join(TMP, 'claude'), RIGS_CODEX_DIR: path.join(TMP, 'codex'),
  RIGS_NO_OPENRIG: '1', RIGS_NO_AUTOUPDATE: '1', RIGS_NO_MIGRATIONS: '1', RIGS_NAME: 'test-node',
});
after(() => fs.rmSync(TMP, { recursive: true, force: true }));

const U = await import('../src/usage.js');

test('parseUsage: 5-hour, week and per-model weekly limits (limits[] first, model_scoped fallback)', () => {
  const r = {
    subscription_type: 'team',
    rate_limits: {
      five_hour: { utilization: 16, resets_at: '2026-10-17T02:59:59Z' },
      seven_day: { utilization: 62, resets_at: '2026-10-18T04:59:59Z' },
      limits: [{ kind: 'session', percent: 16 }, { kind: 'weekly_scoped', percent: 57, resets_at: '2026-10-18T04:59:59Z', scope: { model: { display_name: 'Fable' } } }],
      model_scoped: [{ display_name: 'Fable', utilization: 99 }, { display_name: 'Opus', utilization: 12, resets_at: null }],
    },
  };
  const u = U.parseUsage(r);
  assert.deepEqual(u.session, { pct: 16, resetsAt: '2026-10-17T02:59:59Z' });
  assert.equal(u.week.pct, 62);
  assert.deepEqual(u.models.map((m) => [m.name, m.pct]), [['Fable', 57], ['Opus', 12]]);
  assert.equal(u.subscription, 'team');
  assert.deepEqual(U.parseUsage(null), { session: null, week: null, models: [], subscription: null });
});

test('foldRecord: one API message written per content block counts once; todos give progress', () => {
  const acc = U.newAcc();
  const msg = (id, model, out, content = []) => ({ type: 'assistant', timestamp: '2026-10-17T00:00:00Z', message: { id, model, content, usage: { input_tokens: 2, output_tokens: out, cache_read_input_tokens: 1000, cache_creation_input_tokens: 10 } } });
  U.foldRecord(acc, msg('m1', 'claude-opus-5-5', 50, [{ type: 'text', text: 'a' }]));
  U.foldRecord(acc, msg('m1', 'claude-opus-5-5', 50, [{ type: 'tool_use', name: 'TodoWrite', input: { todos: [{ content: 'a', status: 'completed' }, { content: 'b', status: 'in_progress' }] } }]));
  U.foldRecord(acc, msg('m2', 'claude-haiku-5-5', 7));
  assert.equal(acc.perModel['claude-opus-5-5'].output, 50, 'm1 counted once');
  assert.equal(acc.perModel['claude-opus-5-5'].messages, 1);
  assert.equal(acc.perModel['claude-haiku-5-5'].output, 7);
  assert.equal(acc.lastModel, 'claude-haiku-5-5');
  assert.equal(acc.context, 1012);
  assert.deepEqual(acc.todos.map((t) => t.status), ['completed', 'in_progress'], 'todos still read from a repeated message');
});

test('projectProgress: only projects with work in flight, with percent and running tasks', () => {
  const ps = [
    { id: 'a', name: 'A', status: 'running', tasks: [{ id: 't1', title: 'x', status: 'done' }, { id: 't2', title: 'y', status: 'running', assign: { node: 'mac', model: 'claude-sonnet-5-5' } }, { id: 't3', title: 'z', status: 'failed' }, { id: 't4', status: 'todo' }] },
    { id: 'b', name: 'B', status: 'done', tasks: [{ status: 'done' }] },
  ];
  const [a, ...rest] = U.projectProgress(ps);
  assert.equal(rest.length, 0);
  assert.equal(a.pct, 25);
  assert.equal(a.blocked, 1);
  assert.deepEqual(a.running.map((t) => [t.title, t.node, t.model]), [['y', 'mac', 'claude-sonnet-5-5']]);
});

// ------------------------------------------------------------------ usage ledger

const T0 = Date.parse('2026-10-17T10:00:00Z');
const iso = (min) => new Date(T0 + min * 60000).toISOString();
const writeJsonl = (file, recs) => { fs.mkdirSync(path.dirname(file), { recursive: true }); fs.writeFileSync(file, recs.map((r) => JSON.stringify(r)).join('\n') + '\n'); };
const claudeMsg = (min, id, model, u) => ({ type: 'assistant', timestamp: iso(min), message: { id, model, content: [{ type: 'text', text: 'x' }], usage: { input_tokens: u[0], output_tokens: u[1], cache_read_input_tokens: u[2] || 0, cache_creation_input_tokens: u[3] || 0 } } });
const codexTotal = (min, input, cached, output) => ({ timestamp: iso(min), type: 'event_msg', payload: { type: 'token_count', info: { total_token_usage: { input_tokens: input, cached_input_tokens: cached, output_tokens: output, reasoning_output_tokens: 0, total_tokens: input + output }, last_token_usage: {} } } });

test('harness parsers: claude -p result, codex turn.completed, Ollama final chunk (fixture lines)', () => {
  const claude = JSON.parse('{"type":"result","subtype":"success","is_error":false,"duration_ms":8123,"num_turns":2,"result":"Done, Sir.","session_id":"s-1","total_cost_usd":0.0421,"usage":{"input_tokens":12,"cache_creation_input_tokens":3000,"cache_read_input_tokens":15000,"output_tokens":240},"modelUsage":{"claude-opus-5-5":{"inputTokens":12,"outputTokens":240,"cacheReadInputTokens":15000,"cacheCreationInputTokens":3000,"costUSD":0.04},"claude-haiku-5-5":{"inputTokens":300,"outputTokens":20,"cacheReadInputTokens":0,"cacheCreationInputTokens":0,"costUSD":0.0021}}}');
  const c = U.claudeResultUsage(claude);
  assert.deepEqual([c.inputTokens, c.outputTokens, c.cacheReadTokens, c.cacheWriteTokens], [312, 260, 15000, 3000], 'every model of the turn counts');
  assert.equal(c.costUsd, 0.0421);
  assert.equal(c.model, 'claude-opus-5-5');
  assert.equal(c.sessionId, 's-1');
  const bare = U.claudeResultUsage({ type: 'result', usage: { input_tokens: 5, output_tokens: 6, cache_read_input_tokens: 7, cache_creation_input_tokens: 8 } });
  assert.deepEqual([bare.inputTokens, bare.outputTokens, bare.cacheReadTokens, bare.cacheWriteTokens, bare.costUsd], [5, 6, 7, 8, null], 'usage alone when modelUsage is missing');
  assert.equal(U.claudeResultUsage({ type: 'assistant' }), null);

  // After --resume, modelUsage / total_cost_usd are the session's running totals (captured from claude -p 2.x):
  // the turn is the difference from the previous turn's totals, or its own `usage` when those are unknown.
  const turn1 = U.claudeResultUsage({ type: 'result', session_id: 's-2', total_cost_usd: 0.00408247, usage: { input_tokens: 2, output_tokens: 59, cache_read_input_tokens: 11697, cache_creation_input_tokens: 19679 }, modelUsage: { 'claude-haiku-5-5': { inputTokens: 2, outputTokens: 59, cacheReadInputTokens: 11697, cacheCreationInputTokens: 19679 } } });
  const r2 = { type: 'result', session_id: 's-2', total_cost_usd: 0.00441573, usage: { input_tokens: 2, output_tokens: 3, cache_read_input_tokens: 31376, cache_creation_input_tokens: 89 }, modelUsage: { 'claude-haiku-5-5': { inputTokens: 4, outputTokens: 62, cacheReadInputTokens: 43073, cacheCreationInputTokens: 19768 } } };
  const turn2 = U.claudeResultUsage(r2, { prev: turn1.cumulative, resumed: true });
  assert.deepEqual([turn2.inputTokens, turn2.outputTokens, turn2.cacheReadTokens, turn2.cacheWriteTokens], [2, 3, 31376, 89], 'only this turn');
  assert.equal(turn2.model, 'claude-haiku-5-5');
  assert.ok(Math.abs(turn2.costUsd - 0.00033326) < 1e-8);
  const blind = U.claudeResultUsage(r2, { resumed: true });
  assert.deepEqual([blind.inputTokens, blind.outputTokens, blind.cacheReadTokens, blind.cacheWriteTokens, blind.costUsd, blind.model], [2, 3, 31376, 89, null, 'claude-haiku-5-5'], 'resumed without totals: usage');
  const other = U.claudeResultUsage(r2, { prev: { ...turn1.cumulative, sessionId: 's-old' } });
  assert.equal(other.outputTokens, 62, "another session's totals are not subtracted");

  const codex = U.codexTurnUsage(JSON.parse('{"type":"turn.completed","usage":{"input_tokens":24763,"cached_input_tokens":24448,"output_tokens":122}}'));
  assert.deepEqual(codex, { inputTokens: 315, outputTokens: 122, cacheReadTokens: 24448, cacheWriteTokens: 0 }, 'cached input is split out of input');
  assert.equal(U.codexTurnUsage({ type: 'turn.started' }), null);
  // `codex exec resume` reports the thread's running total (captured from codex-cli 0.163): subtract the last turn's
  const c1 = { input_tokens: 28908, cached_input_tokens: 7168, output_tokens: 5 };
  const c2 = { type: 'turn.completed', usage: { input_tokens: 64280, cached_input_tokens: 35840, output_tokens: 10 } };
  assert.deepEqual(U.codexTurnUsage(c2, c1), { inputTokens: 6700, outputTokens: 5, cacheReadTokens: 28672, cacheWriteTokens: 0 });
  assert.equal(U.codexTurnUsage(c2, { ...c1, output_tokens: 99 }).outputTokens, 10, 'totals that went down are not a running total');

  const ollama = U.ollamaUsage(JSON.parse('{"model":"llama3.2","created_at":"2026-10-17T10:00:00Z","message":{"role":"assistant","content":""},"done":true,"done_reason":"stop","total_duration":2512000000,"load_duration":10000000,"prompt_eval_count":431,"prompt_eval_duration":300000000,"eval_count":57,"eval_duration":2100000000}'));
  assert.deepEqual(ollama, { inputTokens: 431, outputTokens: 57, cacheReadTokens: 0, cacheWriteTokens: 0, durationMs: 2512 });
  assert.equal(U.ollamaUsage({ done: false }), null);
});

test('claudeSlice: only the window, each API message once, matched by the seat name the transcript records', () => {
  const seat = 'team-code-opus@rig-1';
  const recs = [
    { type: 'agent-name', agentName: seat, sessionId: 's' },
    { type: 'user', timestamp: iso(0), message: { role: 'user', content: 'peers: team-code-opus-2@rig-1' } },
    claudeMsg(5, 'm-before', 'claude-opus-5-5', [100, 100]),
    claudeMsg(15, 'm1', 'claude-opus-5-5', [1, 50, 1000, 10]),
    claudeMsg(15, 'm1', 'claude-opus-5-5', [1, 50, 1000, 10]), // same API message, second content block
    claudeMsg(20, 'm2', 'claude-haiku-5-5', [2, 5]),
    claudeMsg(40, 'm-after', 'claude-opus-5-5', [100, 100]),
  ];
  const s = U.claudeSlice(recs, { since: T0 + 10 * 60000, until: T0 + 30 * 60000, seat });
  assert.equal(s.matched, true);
  assert.deepEqual([s.inputTokens, s.outputTokens, s.cacheReadTokens, s.cacheWriteTokens], [3, 55, 1000, 10]);
  assert.deepEqual(Object.keys(s.models).sort(), ['claude-haiku-5-5', 'claude-opus-5-5']);
  assert.equal(s.messages, 2);
  assert.equal(U.claudeSlice(recs, { seat: 'team-code-opus-2@rig-1' }).matched, false, 'a peer named in the text is not this seat');
  assert.equal(U.claudeSlice([{ type: 'user', message: { content: [{ type: 'text', text: 'Read /h/.rigs/briefs/p/p-t1.md and carry out the task' }] } }], { brief: '/h/.rigs/briefs/p/p-t1.md' }).matched, true, 'a direct run is matched by its brief');
  assert.equal(U.claudeSlice([{ type: 'user', message: { content: 'Read C:/Users/me/.rigs/briefs/p/p-t1.md and carry out the task' } }], { brief: 'C:\\Users\\me\\.rigs\\briefs\\p\\p-t1.md' }).matched, true, 'Windows: the pointer has "/", the run "\\"');
});

test('codexSlice: tokens in the window are the running total at its end minus the total before it', () => {
  const recs = [
    { timestamp: iso(0), type: 'session_meta', payload: { id: 'c1', cwd: '/w' } },
    { timestamp: iso(0), type: 'turn_context', payload: { model: 'gpt-5-codex' } },
    { timestamp: iso(0), type: 'event_msg', payload: { type: 'user_message', message: 'You are team-review-codex@rig-1' } },
    codexTotal(5, 1000, 600, 100),
    codexTotal(15, 3000, 2000, 300),
    codexTotal(15, 3000, 2000, 300), // repeated event
    codexTotal(25, 5000, 3500, 450),
    codexTotal(45, 9000, 7000, 900),
  ];
  const s = U.codexSlice(recs, { since: T0 + 10 * 60000, until: T0 + 30 * 60000, seat: 'team-review-codex@rig-1' });
  assert.equal(s.matched, true);
  // input 5000-1000=4000 of which cached 3500-600=2900 → uncached 1100; output 450-100=350
  assert.deepEqual([s.inputTokens, s.cacheReadTokens, s.outputTokens], [1100, 2900, 350]);
  assert.deepEqual(Object.keys(s.models), ['gpt-5-codex']);
  const none = U.codexSlice(recs, { since: T0 + 50 * 60000, until: T0 + 60 * 60000 });
  assert.equal(none.inputTokens + none.outputTokens, 0, 'nothing in an empty window');
});

test('taskUsage: a long-lived seat is billed only for the transcript slice between task start and end', async () => {
  const cwd = path.join(TMP, 'work', 'proj');
  const dir = path.join(process.env.RIGS_CLAUDE_DIR, 'projects', U.claudeProjectDir(cwd));
  const seat = 'team-code-opus@proj-rig';
  // One seat transcript carrying two tasks (t1 at 0–20 min, t2 at 30–50), a peer seat in the same folder, and a subagent.
  writeJsonl(path.join(dir, 'seat-session.jsonl'), [
    { type: 'agent-name', agentName: seat },
    claudeMsg(1, 'a1', 'claude-opus-5-5', [10, 100, 5000, 50]),
    claudeMsg(10, 'a2', 'claude-opus-5-5', [10, 200, 6000, 0]),
    claudeMsg(31, 'b1', 'claude-opus-5-5', [20, 400, 7000, 70]),
    claudeMsg(49, 'b2', 'claude-opus-5-5', [20, 800, 8000, 0]),
  ]);
  writeJsonl(path.join(dir, 'seat-session', 'subagents', 'agent-x.jsonl'), [claudeMsg(12, 'sub1', 'claude-haiku-5-5', [3, 30])]);
  writeJsonl(path.join(dir, 'peer-session.jsonl'), [{ type: 'agent-name', agentName: 'team-code-sonnet@proj-rig' }, claudeMsg(5, 'p1', 'claude-sonnet-5-5', [999, 999])]);
  const t1 = await U.taskUsage({ since: T0, until: T0 + 20 * 60000, cwd, seat });
  assert.deepEqual([t1.inputTokens, t1.outputTokens, t1.cacheReadTokens, t1.cacheWriteTokens], [23, 330, 11000, 50], 't1: its two messages + the subagent, not the peer');
  assert.deepEqual(t1.sessions.sort(), ['seat-session', 'seat-session/agent-x']);
  const t2 = await U.taskUsage({ since: T0 + 30 * 60000, until: T0 + 50 * 60000, cwd, seat });
  assert.deepEqual([t2.inputTokens, t2.outputTokens], [40, 1200], 't2: only its own slice of the same transcript');
  assert.equal((await U.taskUsage({ since: T0, until: T0 + 60 * 60000, cwd, seat: 'team-nobody@x' })).matched, 0);
  // Codex seats: matched by the seat name typed into the session.
  writeJsonl(path.join(process.env.RIGS_CODEX_DIR, 'sessions', '2026', '10', '17', 'rollout-2026-10-17T10-00-00-c1.jsonl'), [
    { timestamp: iso(0), type: 'session_meta', payload: { id: 'c1', cwd } },
    { timestamp: iso(0), type: 'turn_context', payload: { model: 'gpt-5-codex' } },
    { timestamp: iso(0), type: 'event_msg', payload: { type: 'user_message', message: 'session: team-review-codex@proj-rig' } },
    codexTotal(2, 100, 0, 10), codexTotal(18, 600, 200, 60),
  ]);
  const cx = await U.taskUsage({ since: T0 + 3 * 60000, until: T0 + 20 * 60000, cwd, seat: 'team-review-codex@proj-rig' });
  assert.deepEqual([cx.inputTokens, cx.cacheReadTokens, cx.outputTokens], [300, 200, 50]);
});

test('ledger: append (rotated by month), read by range, aggregate by model/project/task/node/day', async () => {
  const sep = Date.parse('2026-09-30T23:00:00Z');
  const oct = Date.parse('2026-10-02T09:00:00Z');
  await U.appendRecord({ id: 'r1', tsStart: sep, tsEnd: sep + 60000, kind: 'task', provider: 'claude', model: 'claude-opus-5-5', projectId: 'p1', projectName: 'Alpha', taskId: 't1', taskTitle: 'Build', node: 'mac', inputTokens: 10, outputTokens: 100, cacheReadTokens: 1000, costUsd: 0.5, status: 'done' });
  await U.appendRecord({ id: 'r2', tsStart: oct, tsEnd: oct + 120000, kind: 'review', provider: 'claude', model: 'claude-sonnet-5-5', projectId: 'p1', projectName: 'Alpha', taskId: 't2', node: 'linux', inputTokens: 5, outputTokens: 50, status: 'failed' });
  await U.appendRecord({ id: 'r3', tsStart: oct + 3600000, tsEnd: oct + 3601000, provider: 'ollama', model: 'llama3.2', node: 'linux', inputTokens: 40, outputTokens: 4, status: 'done' });
  const files = fs.readdirSync(U.ledgerDir()).sort();
  assert.deepEqual(files, ['2026-09.jsonl', '2026-10.jsonl']);
  assert.equal((await U.readRecords()).length, 3);
  assert.deepEqual((await U.readRecords({ since: oct })).map((r) => r.id), ['r2', 'r3']);
  // same id written again (a backfill that later found the transcript): the last line wins
  await U.appendRecord({ id: 'r3', tsStart: oct + 3600000, tsEnd: oct + 3601000, provider: 'ollama', model: 'llama3.2', node: 'linux', inputTokens: 41, outputTokens: 4, status: 'done' });
  const all = await U.readRecords();
  assert.equal(all.length, 3);
  assert.equal(all.find((r) => r.id === 'r3').inputTokens, 41);
  const r1 = all.find((r) => r.id === 'r1');
  assert.equal(r1.durationMs, 60000);
  assert.equal(r1.kind, 'task');
  assert.equal(all.find((r) => r.id === 'r3').kind, 'chat-turn', 'default kind');

  const s = U.summarize(all, { groupBy: '' });
  assert.equal(s.totals.count, 3);
  assert.equal(s.totals.totalTokens, 10 + 100 + 1000 + 5 + 50 + 41 + 4);
  assert.equal(s.totals.costUsd, 0.5);
  assert.deepEqual([s.totals.done, s.totals.failed], [2, 1]);
  assert.deepEqual(Object.keys(s.groups), ['model', 'project', 'task', 'node', 'day']);
  assert.equal(s.groups.model[0].key, 'claude-opus-5-5', 'biggest spender first');
  assert.deepEqual(s.groups.project.map((g) => [g.label, g.count]), [['Alpha', 2], ['JARVIS chat', 1]]);
  assert.deepEqual(s.groups.task.map((g) => g.key).sort(), ['(chat-turn)', 'p1/t1', 'p1/t2']);
  assert.deepEqual(s.groups.node.map((g) => [g.key, g.count]), [['mac', 1], ['linux', 2]]);
  assert.deepEqual(s.groups.day.map((g) => g.key), ['2026-09-30', '2026-10-02'], 'days in date order');
  assert.equal(s.records[0].id, 'r3', 'newest first');
  assert.throws(() => U.summarize(all, { groupBy: 'colour' }), /groupBy must be one of/);
  assert.equal(U.parseTime('24h', T0), T0 - 86400000);
  assert.equal(U.parseTime('2026-10-17T10:00:00Z'), T0);
});

test('aggregateUsage: node sums add up per key; records merged newest first; offline nodes listed', () => {
  const rep = (node, recs) => ({ node: { name: node }, report: U.summarize(recs, { groupBy: 'model,node', limit: 1 }) });
  const a = U.makeRecord({ id: 'a', tsStart: T0, node: 'mac', model: 'claude-opus-5-5', inputTokens: 10, outputTokens: 10, costUsd: 0.1 });
  const b = U.makeRecord({ id: 'b', tsStart: T0 + 1000, node: 'mac', model: 'claude-opus-5-5', inputTokens: 5, outputTokens: 5 });
  const c = U.makeRecord({ id: 'c', tsStart: T0 + 2000, node: 'linux', model: 'claude-opus-5-5', inputTokens: 1, outputTokens: 1, costUsd: 0.2 });
  const out = U.aggregateUsage([rep('mac', [a, b]), rep('linux', [c]), { node: { name: 'win' }, error: 'offline' }], { groupBy: 'model,node', limit: 10 });
  assert.equal(out.totals.count, 3, 'totals come from every record, not the limited record lists');
  assert.equal(out.totals.totalTokens, 32);
  assert.equal(out.totals.costUsd, 0.3);
  assert.deepEqual(out.groups.model.map((g) => [g.key, g.count, g.totalTokens]), [['claude-opus-5-5', 3, 32]]);
  assert.deepEqual(out.groups.node.map((g) => g.key), ['mac', 'linux']);
  assert.deepEqual(out.records.map((r) => r.id), ['c', 'b'], 'each node sent its newest record');
  assert.equal(out.truncated, true);
  assert.deepEqual(out.errors, [{ node: 'win', error: 'offline' }]);
});

test('task runs: the planner reports non-overlapping stretches; capture failures never throw', async () => {
  const planner = await import('../src/planner.js');
  const got = [];
  planner.onRunEnd((e) => got.push(e));
  const p = { id: 'p9', name: 'Nine', tasks: [] };
  const t = { id: 't1', title: 'Do it', kind: 'code', assign: { node: 'mac', provider: 'claude', model: 'claude-opus-5-5', effort: 'high' }, startingAt: T0, run: { mode: 'openrig', seat: 's@r', cwd: '/w', startedAt: T0 + 5000 } };
  const first = planner.runEnded(p, t, 'blocked', 'need a key');
  assert.equal(first.since, T0, 'the first stretch starts at dispatch');
  const second = planner.runEnded(p, t, 'done', 'shipped');
  assert.equal(second.since, first.until, 'the next stretch starts where the last ended');
  assert.equal(planner.runEnded(p, { ...t, run: null }, 'done'), null, 'no run, nothing to record');
  await new Promise((r) => setImmediate(r));
  assert.deepEqual(got.map((e) => e.status), ['blocked', 'done']);
  planner.onRunEnd(null);

  // retryOrFail closes the attempt's stretch as failed before clearing the run
  const seen = [];
  planner.onRunEnd((e) => seen.push(e));
  const t2 = { id: 't2', title: 'x', assign: { node: 'mac', provider: 'claude' }, startingAt: T0, run: { seat: 's@r' } };
  planner.retryOrFail({ id: 'p9', name: 'Nine', tasks: [t2], log: [] }, t2, 'boom');
  await new Promise((r) => setImmediate(r));
  assert.deepEqual(seen.map((e) => [e.status, e.task.attempts]), [['failed', 0]]);
  planner.onRunEnd(null);

  const e = { node: 'mac', project: { id: 'p9', name: 'Nine' }, task: { id: 't1', title: 'Do it', kind: 'review' }, assign: t.assign, run: t.run, since: T0, until: T0 + 600000, status: 'done', summary: 'All green.\nDetails…' };
  const ok = await U.recordTaskRun(e, { slice: async (node, q) => { assert.equal(node, 'mac'); assert.equal(q.seat, 's@r'); return { inputTokens: 7, outputTokens: 70, cacheReadTokens: 700, cacheWriteTokens: 0, models: { 'claude-opus-5-5': { inputTokens: 7, outputTokens: 70, cacheReadTokens: 700, cacheWriteTokens: 0 } }, sessions: ['abc'], matched: 1 }; } });
  assert.equal(ok.kind, 'review');
  assert.equal(ok.durationMs, 600000);
  assert.deepEqual([ok.provider, ok.model, ok.effort, ok.node, ok.status, ok.tokensFrom], ['claude', 'claude-opus-5-5', 'high', 'mac', 'done', 'transcript']);
  assert.deepEqual([ok.inputTokens, ok.outputTokens, ok.cacheReadTokens], [7, 70, 700]);
  assert.equal(ok.outcome, 'All green. Details…');
  const broken = await U.recordTaskRun(e, { slice: async () => { throw new Error('machine offline'); } });
  assert.equal(broken.tokensFrom, 'none');
  assert.match(broken.error, /machine offline/);
  assert.equal(broken.inputTokens, 0);
  // a chat turn files the model the harness reports, not the alias it was asked for
  const turn = await U.recordChatTurn({ chat: { id: 'c' }, brain: 'claude', model: 'haiku', startedAt: T0, out: { text: 'hi', usage: { inputTokens: 1, model: 'claude-haiku-5-5', models: {} } } });
  assert.equal(turn.model, 'claude-haiku-5-5');
  // even an unwritable ledger only logs
  const realDir = U.ledgerDir();
  fs.rmSync(realDir, { recursive: true, force: true });
  fs.writeFileSync(realDir, 'not a directory');
  assert.equal(await U.appendRecord({ id: 'x' }), null);
  assert.equal(await U.recordChatTurn({ chat: { id: 'c' }, brain: 'claude', startedAt: T0, out: { text: 'hi' } }), null);
  fs.rmSync(realDir, { force: true });
});

test('backfill: estimated records from project task history, once', async () => {
  const projects = path.join(process.env.RIGS_HOME, 'projects');
  fs.mkdirSync(projects, { recursive: true });
  const cwd = path.join(TMP, 'work', 'proj');
  fs.writeFileSync(path.join(projects, 'bf1.json'), JSON.stringify({
    id: 'bf1', name: 'Backfilled', updatedAt: T0 + 3600000,
    log: [{ ts: T0 + 20 * 60000, text: 't1 → done: built it' }],
    tasks: [
      { id: 't1', title: 'Build', kind: 'code', status: 'done', summary: 'built it', assign: { node: 'test-node', provider: 'claude', model: 'claude-opus-5-5' }, startingAt: T0, run: { seat: 'team-code-opus@proj-rig', cwd, startedAt: T0 + 1000 } },
      { id: 't2', title: 'Later', status: 'todo', assign: { node: 'test-node' } },
    ],
  }));
  const slice = (node, q) => U.taskUsage(q);
  const r = await U.backfill({ slice });
  assert.equal(r.tasks, 1);
  const rec = (await U.readRecords()).find((x) => x.projectId === 'bf1');
  assert.equal(rec.estimated, true);
  assert.equal(rec.durationMs, 20 * 60000);
  assert.deepEqual([rec.inputTokens, rec.outputTokens], [23, 330], 'the same slice a live capture would take');
  assert.equal((await U.backfill({ slice })).tasks, 0, 'nothing new the second time');
});

// End to end through a real node: a JARVIS chat turn (Ollama brain, faked over HTTP) lands in the ledger, and the
// local and mesh-wide APIs return it with groupBy aggregates.
test('API: a chat turn is recorded; /api/local/usage and /api/usage aggregate it', async () => {
  const ollama = http.createServer((req, res) => {
    if (req.url === '/api/tags') { res.end(JSON.stringify({ models: [{ name: 'fake:1b', details: {} }] })); return; }
    if (req.url === '/api/chat') {
      req.resume();
      res.write(JSON.stringify({ message: { role: 'assistant', content: 'At your service, Sir.\n---\ndetails' }, done: false }) + '\n');
      res.end(JSON.stringify({ message: { role: 'assistant', content: '' }, done: true, prompt_eval_count: 321, eval_count: 12, total_duration: 900000000 }) + '\n');
      return;
    }
    res.statusCode = 404; res.end();
  });
  await new Promise((r) => ollama.listen(0, '127.0.0.1', r));
  const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
  const HOME = path.join(TMP, 'node');
  const PORT = 20000 + Math.floor(Math.random() * 20000);
  const BASE = `http://127.0.0.1:${PORT}`;
  writeJsonl(path.join(HOME, 'usage', '2026-10.jsonl'), [U.makeRecord({ id: 'seed-1', tsStart: Date.now() - 3600000, tsEnd: Date.now() - 3000000, node: 'test-node', kind: 'task', provider: 'claude', model: 'claude-opus-5-5', projectId: 'p1', projectName: 'Alpha', taskId: 't1', taskTitle: 'Build', inputTokens: 100, outputTokens: 1000, status: 'done', outcome: 'built' })]);
  const env = { ...process.env, RIGS_HOME: HOME, RIGS_SSH_DIR: path.join(HOME, 'ssh'), RIGS_PORT: String(PORT), RIGS_NAME: 'test-node', RIGS_PEERS: '', RIGS_MESH_TOKEN: 'test-token', RIGS_OLLAMA_URL: `http://127.0.0.1:${ollama.address().port}` };
  const server = spawn(process.execPath, [path.join(ROOT, 'bin/rigs.js'), 'serve'], { env, stdio: ['ignore', 'pipe', 'pipe'] });
  let out = '';
  server.stdout.on('data', (d) => { out += d; });
  server.stderr.on('data', (d) => { out += d; });
  try {
    let up = false;
    for (let i = 0; i < 100 && !up; i++) { try { up = (await fetch(BASE + '/api/self')).ok; } catch {} if (!up) await new Promise((r) => setTimeout(r, 200)); }
    assert.ok(up, 'server did not start:\n' + out);
    const post = async (p, body) => (await fetch(BASE + p, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) })).json();
    const c = await post('/api/local/chats', { title: 'usage test' });
    const done = await post(`/api/local/chats/${c.id}/send?wait=1`, { text: 'hello', brain: 'ollama', model: 'fake:1b' });
    assert.equal(done.type, 'done', JSON.stringify(done));

    const local = await (await fetch(BASE + '/api/local/usage?groupBy=model')).json();
    const turn = local.records.find((r) => r.chatId === c.id);
    assert.ok(turn, 'the chat turn is in the ledger: ' + JSON.stringify(local));
    assert.deepEqual([turn.kind, turn.provider, turn.model, turn.node, turn.status], ['chat-turn', 'ollama', 'fake:1b', 'test-node', 'done']);
    assert.deepEqual([turn.inputTokens, turn.outputTokens, turn.tokensFrom], [321, 12, 'harness']);
    assert.ok(turn.durationMs >= 0 && turn.tsEnd >= turn.tsStart);
    assert.equal(turn.outcome, 'At your service, Sir.');
    assert.deepEqual(local.groupBy, ['model']);
    assert.deepEqual(local.groups.model.map((g) => [g.key, g.count]), [['claude-opus-5-5', 1], ['fake:1b', 1]]);
    assert.equal(local.totals.totalTokens, 1100 + 333);

    const mesh = await (await fetch(BASE + '/api/usage?since=7d&groupBy=model,project,task,node,day')).json();
    assert.ok(mesh.nodes.includes('test-node'));
    assert.deepEqual(Object.keys(mesh.groups), ['model', 'project', 'task', 'node', 'day']);
    const self = mesh.groups.node.find((g) => g.key === 'test-node');
    assert.equal(self.count, 2);
    assert.equal(self.totalTokens, 1433);
    assert.ok(mesh.groups.task.some((g) => g.key === 'p1/t1' && g.label === 'Build'));
    assert.ok(mesh.records.some((r) => r.id === 'seed-1') && mesh.records.some((r) => r.chatId === c.id));
    const bad = await fetch(BASE + '/api/local/usage?groupBy=colour');
    assert.equal(bad.status, 400);
  } finally {
    server.kill();
    ollama.close();
  }
});
