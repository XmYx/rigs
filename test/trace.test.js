// Request traces (src/trace.js): span rules (redaction, caps), the harness tool-call parser, the JSONL store, the
// summaries and mesh merge, retention, the trace in task briefs — and one JARVIS request end to end through a scratch
// node whose brain is a fake `claude` (router decision, brain turn, tool calls, a project_create handoff).
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { after, test } from 'node:test';
import { fileURLToPath } from 'node:url';
import { freePort } from './ports.js';

const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'rigs-trace-'));
Object.assign(process.env, {
  RIGS_HOME: path.join(TMP, 'rigs'), RIGS_NO_OPENRIG: '1', RIGS_NO_AUTOUPDATE: '1', RIGS_NO_MIGRATIONS: '1', RIGS_NAME: 'test-node',
});
after(() => fs.rmSync(TMP, { recursive: true, force: true }));

const T = await import('../src/trace.js');
const { config } = await import('../src/config.js');
const P = await import('../src/planner.js');
const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

test('redaction: secret-looking strings and secret-named keys never reach a span', () => {
  const s = T.redact('key sk-ant-api03-abcdefghijklmnopqrstuv and ghp_abcdefghijklmnopqrstuvwxyz0123 Authorization: Bearer abc.def.ghi https://me:hunter2@example.com/x?token=s3cr3tvalue password=letmein');
  for (const leak of ['abcdefghijklmnopqrstuv', 'ghp_abcdefghij', 'abc.def.ghi', 'hunter2', 's3cr3tvalue', 'letmein']) assert.ok(!s.includes(leak), `${leak} leaked: ${s}`);
  assert.match(s, /sk-ant-\*\*\*/);
  const v = T.redactValue({ cmd: 'curl -H "x-rigs-token: abcdef123456"', meshToken: 'zzz-secret', apiKey: 'k-123456', nested: [{ password: 'pw-1' }], tokens: 42, inputTokens: 7, authEnabled: true });
  assert.equal(v.meshToken, '***');
  assert.equal(v.apiKey, '***');
  assert.equal(v.nested[0].password, '***');
  assert.ok(!JSON.stringify(v).includes('abcdef123456'));
  assert.equal(v.inputTokens, 7, 'token counts are numbers, not secrets');
  assert.equal(v.authEnabled, true);
  const pk = T.redact('-----BEGIN OPENSSH PRIVATE KEY-----\nAAAAB3Nza\n-----END OPENSSH PRIVATE KEY-----');
  assert.equal(pk, '[redacted private key]');
  // header-style names with a hyphen: X-Api-Key, api-key
  for (const s of ['curl -H "X-Api-Key: abcd1234efgh" x', 'X-API-KEY=abcd1234efgh', 'api-key: abcd1234efgh']) assert.ok(!T.redact(s).includes('abcd1234efgh'), s);
});

test('caps: oversized input/output fields are truncated and marked; small ones are kept as they are', () => {
  const max = 500;
  assert.deepEqual(T.clean('short', max), { value: 'short', truncated: false });
  const long = T.clean('x'.repeat(2000), max);
  assert.equal(long.truncated, true);
  assert.match(long.value, /…\[truncated 1500 chars\]$/);
  const obj = T.clean({ rows: Array.from({ length: 200 }, (_, i) => ({ i, text: 'row ' + i })) }, max);
  assert.equal(obj.truncated, true);
  assert.equal(obj.value.truncated, true);
  assert.equal(obj.value.preview.length, max);
  config().traces = { ...config().traces, maxField: 300 };
  try {
    const span = T.makeSpan({ kind: 'tool-call', name: 'Bash', input: { command: 'cat big', env: 'API_KEY=sk-proj-abcdefghijklmnopqrstuvwxyz' }, output: 'y'.repeat(1000), meta: { durationMs: 5 } });
    assert.deepEqual(span.meta.truncated, ['output']);
    assert.ok(span.output.length < 400);
    assert.ok(!JSON.stringify(span).includes('abcdefghijklmnopqrstuvwxyz'), 'secrets are redacted before the cap');
    assert.equal(span.status, 'running', 'no end yet');
    assert.match(span.traceId, /^tr-\d{8}-[0-9a-f]{12}$/);
  } finally { config().traces = { ...config().traces, maxField: 8000 }; }
});

test('toolCollector: claude tool_use/tool_result pairs, codex items, ollama tool_calls', () => {
  let t = 1000;
  const now = () => (t += 10);
  const started = [];
  const ended = [];
  const c = T.toolCollector({ onStart: (k, x) => started.push([k, x]), onEnd: (k, x) => ended.push([k, x]) }, now);
  c.feed('claude', { type: 'assistant', message: { content: [{ type: 'text', text: 'checking' }, { type: 'tool_use', id: 'tu1', name: 'Bash', input: { command: 'ls' } }] } });
  c.feed('claude', { type: 'assistant', message: { content: [{ type: 'tool_use', id: 'tu2', name: 'mcp__rigs__mesh_status', input: {} }] } });
  c.feed('claude', { type: 'user', message: { content: [{ type: 'tool_result', tool_use_id: 'tu1', content: 'a\nb' }] } });
  c.feed('claude', { type: 'user', message: { content: [{ type: 'tool_result', tool_use_id: 'tu2', is_error: true, content: [{ type: 'text', text: 'daemon down' }] }] } });
  assert.deepEqual(started.map(([k, x]) => [k, x.name]), [['tu1', 'Bash'], ['tu2', 'mcp__rigs__mesh_status']]);
  assert.deepEqual(ended.map(([k, x]) => [k, x.status, x.output]), [['tu1', 'ok', 'a\nb'], ['tu2', 'error', 'daemon down']]);
  assert.ok(ended[0][1].meta.durationMs > 0);

  started.length = 0; ended.length = 0;
  c.feed('codex', { type: 'item.started', item: { id: 'i1', type: 'command_execution', command: 'git status', status: 'in_progress' } });
  c.feed('codex', { type: 'item.completed', item: { id: 'i1', type: 'command_execution', command: 'git status', aggregated_output: 'clean', exit_code: 0, status: 'completed' } });
  c.feed('codex', { type: 'item.completed', item: { id: 'i2', type: 'mcp_tool_call', server: 'rigs', tool: 'jarvis_task', arguments: { title: 'x' }, result: { content: [] }, status: 'completed' } });
  c.feed('codex', { type: 'item.completed', item: { id: 'i3', type: 'agent_message', text: 'hi' } });
  assert.deepEqual(ended.map(([k, x]) => [k, x.status]), [['i1', 'ok'], ['i2', 'ok']]);
  assert.deepEqual(started.map(([, x]) => x.name), ['shell', 'rigs.jarvis_task']);

  ended.length = 0;
  c.feed('ollama', { message: { tool_calls: [{ function: { name: 'get_weather', arguments: { city: 'Budapest' } } }] } });
  assert.equal(ended.length, 1);
  c.feed('claude', { type: 'assistant', message: { content: [{ type: 'tool_use', id: 'tu9', name: 'Read', input: {} }] } });
  assert.deepEqual(c.pending(), ['tu9']);
  c.close();
  assert.equal(ended.at(-1)[1].status, 'stopped', 'a call without a result ends as stopped');
});

test('store: a span is written running then finished (last line wins), list filters, get builds the tree', async () => {
  const intake = T.startSpan({ kind: 'intake', name: 'jarvis/send', input: 'what is the weather?' });
  const router = intake.child({ kind: 'router', name: 'route' });
  await router.end({ output: { route: 'answer' }, meta: { route: 'answer', via: 'rules' } });
  const turn = intake.child({ kind: 'brain-turn', name: 'claude claude-haiku-5-5', meta: { provider: 'claude', model: 'claude-haiku-5-5' } });
  const tool = turn.child({ kind: 'tool-call', name: 'WebSearch', input: { q: 'weather' } });
  await T.flush();
  const live = await T.get(intake.traceId);
  assert.equal(live.summary.status, 'running', 'visible while it runs');
  assert.equal(live.spans.find((s) => s.spanId === tool.spanId).end, null);
  await tool.end({ output: 'sunny' });
  await turn.end({ output: 'Sunny, sir.', meta: { inputTokens: 10, outputTokens: 5, costUsd: 0.001 } });
  await intake.end({ output: { text: 'Sunny, sir.' } });
  const failed = T.startSpan({ kind: 'intake', name: 'jarvis/send', input: 'build me a thing' });
  await failed.child({ kind: 'router', name: 'route', meta: { route: 'implement' } }).end({ meta: { route: 'implement' } });
  await failed.end({ status: 'error', output: { error: 'boom' } });

  const t = await T.get(intake.traceId);
  assert.equal(t.spans.length, 4, 'one entry per span, not per line');
  assert.equal(t.tree.length, 1);
  const root = t.tree[0];
  assert.equal(root.kind, 'intake');
  assert.deepEqual(root.children.map((c) => c.kind), ['router', 'brain-turn']);
  assert.deepEqual(root.children[1].children.map((c) => [c.kind, c.output, c.status]), [['tool-call', 'sunny', 'ok']]);
  assert.deepEqual([t.summary.status, t.summary.route, t.summary.toolCalls, t.summary.inputTokens, t.summary.costUsd, t.summary.models], ['ok', 'answer', 1, 10, 0.001, ['claude-haiku-5-5']]);
  const lines = fs.readFileSync(path.join(process.env.RIGS_HOME, 'traces', new Date().toISOString().slice(0, 10) + '.jsonl'), 'utf8').trim().split('\n');
  assert.ok(lines.length > t.spans.length, 'append-only: running and finished lines both kept');
  for (const l of lines) assert.deepEqual(Object.keys(JSON.parse(l)), ['traceId', 'spanId', 'parentId', 'kind', 'name', 'node', 'start', 'end', 'status', 'input', 'output', 'meta']);

  const all = await T.list({});
  assert.equal(all.node, 'test-node');
  assert.ok(all.traces.some((x) => x.traceId === intake.traceId) && all.traces.some((x) => x.traceId === failed.traceId));
  assert.deepEqual((await T.list({ route: 'implement' })).traces.map((x) => x.traceId), [failed.traceId]);
  assert.deepEqual((await T.list({ status: 'error' })).traces.map((x) => x.traceId), [failed.traceId]);
  assert.equal((await T.list({ q: 'weather' })).traces[0].request, 'what is the weather?');
  const later = await T.get(intake.traceId, { after: Date.now() + 1000 });
  assert.equal(later.spans.length, 0, 'after= returns only what changed since');
  assert.equal(await T.get('not-a-trace'), null);
});

test('read cache: a trace\'s day files are read once; spans written afterwards reach polls, finishSpan and run ends without re-reading', async () => {
  const fsp = await import('node:fs/promises');
  T._resetTraceCache();
  const reads = [];
  T._setReadFile((f) => { reads.push(path.basename(f)); return fsp.readFile(f, 'utf8'); });
  try {
    const root = T.startSpan({ kind: 'intake', name: 'jarvis/send', input: 'cached?' });
    await T.flush();
    T._resetTraceCache(); // the span is on disk only: the first read has to load it
    const first = await T.get(root.traceId);
    assert.equal(first.spans.length, 1);
    const n = reads.length;
    assert.ok(n >= 1, 'the first read loads the day file(s)');
    await T.get(root.traceId);
    await T.get(root.traceId, { after: Date.now() - 1000 });
    assert.equal(reads.length, n, 'polls do not read the files again');
    // Spans written by this process land in the cache as they are written: a poll right after sees them.
    const tool = root.child({ kind: 'tool-call', name: 'Read', input: { path: 'x' } });
    const live = await T.get(root.traceId);
    assert.equal(live.spans.find((s) => s.spanId === tool.spanId)?.status, 'running', 'visible before the append is even flushed');
    await tool.end({ output: 'ok' });
    const ended = await T.get(root.traceId);
    assert.deepEqual([ended.spans.length, ended.spans.find((s) => s.spanId === tool.spanId).status], [2, 'ok']);
    // finishSpan amends from the cache, and recordRunEnd (the same read) too.
    const fin = await T.finishSpan(root.traceId, tool.spanId, { meta: { extra: 1 } });
    assert.equal(fin.meta.extra, 1);
    const run = await T.recordRunEnd({ trace: { traceId: root.traceId, parentId: root.spanId }, status: 'done', summary: 'did it', since: Date.now() - 50 });
    assert.equal(run.status, 'ok');
    assert.equal((await T.get(root.traceId)).spans.length, 3);
    assert.equal(reads.length, n, 'none of that re-read the day files');
    await root.end({ output: { text: 'yes' } });
    assert.equal((await T.get(root.traceId)).summary.status, 'ok');
    // What the cache serves is what a cold read of the files gives (the on-disk format is unchanged).
    const cached = (await T.get(root.traceId)).spans;
    T._resetTraceCache();
    const cold = (await T.get(root.traceId)).spans;
    assert.deepEqual(cold, cached);
    // LRU: past TRACE_CACHE_SIZE traces the oldest is evicted and read from disk again when asked for.
    const before = reads.length;
    for (let i = 0; i < T.TRACE_CACHE_SIZE; i++) { const s = T.startSpan({ kind: 'intake', name: `t${i}` }); await s.end(); await T.get(s.traceId); }
    assert.ok(reads.length > before);
    const mid = reads.length;
    await T.get(root.traceId);
    assert.ok(reads.length > mid, 'evicted: loaded from disk again');
    const again = reads.length;
    await T.get(root.traceId);
    assert.equal(reads.length, again, 'and cached once more');
  } finally { T._setReadFile(null); }
});

test('settings: enabled=false records nothing; retention prunes day files older than days', async () => {
  config().traces = { ...config().traces, enabled: false };
  try { assert.equal(await T.writeSpan({ kind: 'intake' }), null); } finally { config().traces = { ...config().traces, enabled: true }; }
  const dir = path.join(process.env.RIGS_HOME, 'traces');
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, '2020-01-01.jsonl'), '{}\n');
  const recent = new Date(Date.now() - 2 * 86400000).toISOString().slice(0, 10);
  fs.writeFileSync(path.join(dir, recent + '.jsonl'), '');
  config().traces = { ...config().traces, days: 3 };
  try {
    assert.deepEqual(await T.prune(), ['2020-01-01.jsonl']);
    assert.ok(fs.existsSync(path.join(dir, recent + '.jsonl')));
  } finally { config().traces = { ...config().traces, days: 14 }; }
});

test('mesh: summaries of one trace on two machines merge; one trace\'s spans from both form one tree', () => {
  const now = Date.now();
  const root = T.makeSpan({ kind: 'intake', name: 'jarvis/send', node: 'mac', start: now, end: now + 50, status: 'ok', input: 'hi' });
  const turn = T.makeSpan({ traceId: root.traceId, parentId: root.spanId, kind: 'brain-turn', node: 'mac', start: now + 1, end: now + 40, meta: { model: 'm1', inputTokens: 3 } });
  const task = T.makeSpan({ traceId: root.traceId, parentId: turn.spanId, kind: 'task', node: 'linux', start: now + 30, end: null, meta: { model: 'm2' } });
  const a = T.summarizeTrace([root, turn]);
  const b = T.summarizeTrace([task]);
  const m = T.aggregateTraces([{ node: { name: 'mac' }, report: { traces: [a] } }, { node: { name: 'linux' }, report: { traces: [b] } }, { node: { name: 'win' }, error: 'offline' }]);
  assert.equal(m.count, 1);
  assert.deepEqual([m.traces[0].request, m.traces[0].status, m.traces[0].spans, m.traces[0].end], ['hi', 'running', 3, null]);
  assert.deepEqual(m.traces[0].nodes.sort(), ['linux', 'mac']);
  assert.deepEqual(m.errors, [{ node: 'win', error: 'offline' }]);
  const one = T.mergeTrace(root.traceId, [{ node: { name: 'mac' }, report: { spans: [root, turn] } }, { node: { name: 'linux' }, report: { spans: [task] } }]);
  assert.equal(one.tree.length, 1);
  assert.equal(one.tree[0].children[0].children[0].node, 'linux', 'the task span on another machine attaches under the turn');
  assert.deepEqual(T.parseContext(`${root.traceId}:${turn.spanId}`), { traceId: root.traceId, parentId: turn.spanId });
  assert.equal(T.parseContext('garbage'), null);
  assert.equal(T.formatContext({ traceId: root.traceId, parentId: turn.spanId }), `${root.traceId}:${turn.spanId}`);
});

test('briefs: a task filed under a traced request names the trace, and work/start carries it', async () => {
  const mesh = [{ node: { id: 'test-node', name: 'test-node', online: true, rigs: true, platform: 'linux', gpus: [], stats: { cpu: 5, memUsed: 4, memTotal: 16 }, capabilities: {} }, brains: [{ id: 'claude', models: [], efforts: [] }], openrig: { daemon: 'running' } }];
  const calls = [];
  const ctx = {
    snapshot: async () => mesh, notify: () => {},
    call: async (node, sub, { body }) => { calls.push(body); return { mode: 'openrig', rig: 'r', seat: 's', qitem: 'q', session: { kind: 'rig', id: 's' } }; },
  };
  const tctx = { traceId: T.newTraceId(), parentId: T.newSpanId() };
  const r = await P.intake({ title: 'Traced', instruction: 'do the traced thing', trace: tctx }, ctx);
  assert.equal(r.started, true);
  const body = calls.at(-1);
  // work/start carries the trace with the dispatch span (a child of the handoff) as parent: the run hangs under it
  assert.equal(body.trace.traceId, tctx.traceId);
  await T.flush();
  const dispatch = (await T.readSpans({ traceId: tctx.traceId })).find((s) => s.spanId === body.trace.parentId);
  assert.deepEqual([dispatch.kind, dispatch.parentId], ['dispatch', tctx.parentId]);
  assert.ok(body.prompt.includes(`Request trace: \`${tctx.traceId}\``), body.prompt.slice(0, 600));
  assert.deepEqual((await P.getProject(r.project.id)).tasks.find((t) => t.id === r.task.id).trace, tctx);
  await P.intake({ title: 'Untraced', instruction: 'no trace here' }, ctx);
  assert.ok(!calls.at(-1).prompt.includes('Request trace'), 'untraced work has no trace line');
});

// A fake `claude`: answers the router with a JSON decision, and as the brain streams a reply with two tool calls — a
// Bash call with a secret and a huge result, and a project_create made for real against the node with RIGS_TRACE —
// then the result event with tokens and cost.
const FAKE_CLAUDE = String.raw`#!/usr/bin/env node
const args = process.argv.slice(2);
if (args.includes('--version')) { console.log('9.9.9 (fake)'); process.exit(0); }
const fmt = args[args.indexOf('--output-format') + 1];
if (fmt === 'text') { console.log('{"route":"answer","reason":"a question","title":"Weather check","work":[]}'); process.exit(0); }
const out = (e) => process.stdout.write(JSON.stringify(e) + '\n');
(async () => {
  out({ type: 'system', subtype: 'init', session_id: 'fake-session' });
  out({ type: 'stream_event', event: { type: 'content_block_delta', delta: { type: 'text_delta', text: 'Checking, sir. ' } } });
  out({ type: 'assistant', message: { content: [{ type: 'tool_use', id: 'toolu_1', name: 'Bash', input: { command: 'curl -H "Authorization: Bearer sk-ant-api03-SECRETSECRETSECRET" https://example.com' } }] } });
  out({ type: 'user', message: { content: [{ type: 'tool_result', tool_use_id: 'toolu_1', content: 'ok\n' + 'z'.repeat(20000) }] } });
  out({ type: 'assistant', message: { content: [{ type: 'tool_use', id: 'toolu_2', name: 'mcp__rigs__project_create', input: { goal: 'Trace test project' } }] } });
  const r = await fetch('http://127.0.0.1:' + process.env.RIGS_PORT + '/api/local/projects', { method: 'POST', headers: { 'content-type': 'application/json', 'x-rigs-trace': process.env.RIGS_TRACE || '' }, body: JSON.stringify({ goal: 'Trace test project' }) });
  const p = await r.json();
  out({ type: 'user', message: { content: [{ type: 'tool_result', tool_use_id: 'toolu_2', content: JSON.stringify({ id: p.id }) }] } });
  out({ type: 'stream_event', event: { type: 'content_block_delta', delta: { type: 'text_delta', text: 'Sunny, sir.' } } });
  out({ type: 'result', subtype: 'success', is_error: false, result: 'Checking, sir. Sunny, sir.', session_id: 'fake-session', total_cost_usd: 0.0123,
    usage: { input_tokens: 11, output_tokens: 22, cache_read_input_tokens: 333, cache_creation_input_tokens: 44 },
    modelUsage: { 'claude-haiku-5-5': { inputTokens: 11, outputTokens: 22, cacheReadInputTokens: 333, cacheCreationInputTokens: 44, costUSD: 0.0123 } } });
})();
`;

test('API: one JARVIS request → one trace (intake → router, brain turn → tool calls → handoff) over /api/local/traces and /api/traces', { skip: process.platform === 'win32' && 'the fake claude is a POSIX script' }, async () => {
  const HOME = path.join(TMP, 'node');
  const BIN = path.join(TMP, 'bin');
  fs.mkdirSync(BIN, { recursive: true });
  fs.writeFileSync(path.join(BIN, 'claude'), FAKE_CLAUDE, { mode: 0o755 });
  const PORT = await freePort();
  const BASE = `http://127.0.0.1:${PORT}`;
  const env = {
    ...process.env, HOME, RIGS_HOME: path.join(HOME, '.rigs'), RIGS_SSH_DIR: path.join(HOME, 'ssh'), RIGS_CLAUDE_DIR: path.join(HOME, 'claude'), RIGS_CODEX_DIR: path.join(HOME, 'codex'),
    RIGS_PORT: String(PORT), RIGS_NAME: 'test-node', RIGS_PEERS: '', RIGS_MESH_TOKEN: 'test-token', RIGS_OLLAMA_URL: 'http://127.0.0.1:9', PATH: `${BIN}${path.delimiter}${process.env.PATH}`,
  };
  fs.mkdirSync(HOME, { recursive: true });
  const server = spawn(process.execPath, [path.join(ROOT, 'bin/rigs.js'), 'serve'], { env, stdio: ['ignore', 'pipe', 'pipe'] });
  let log = '';
  server.stdout.on('data', (d) => { log += d; });
  server.stderr.on('data', (d) => { log += d; });
  try {
    let up = false;
    for (let i = 0; i < 100 && !up; i++) { try { up = (await fetch(BASE + '/api/self')).ok; } catch {} if (!up) await new Promise((r) => setTimeout(r, 200)); }
    assert.ok(up, 'server did not start:\n' + log);
    const res = await fetch(BASE + '/api/local/jarvis/send', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ text: 'the weather forecast for Budapest tomorrow', brain: 'claude', model: 'claude-haiku-5-5' }) });
    const events = (await res.text()).split('\n').filter(Boolean).map((l) => JSON.parse(l));
    const traceId = events.find((e) => e.type === 'trace')?.traceId;
    assert.ok(traceId, 'the stream names the trace first: ' + JSON.stringify(events));
    assert.equal(events.find((e) => e.type === 'done')?.text, 'Checking, sir. Sunny, sir.', JSON.stringify(events) + log);

    const list = await (await fetch(BASE + '/api/local/traces?since=1h')).json();
    assert.equal(list.node, 'test-node');
    const sum = list.traces.find((t) => t.traceId === traceId);
    assert.ok(sum, JSON.stringify(list));
    assert.deepEqual([sum.status, sum.route, sum.brainTurns, sum.toolCalls, sum.handoffs, sum.request], ['ok', 'answer', 1, 2, 1, 'the weather forecast for Budapest tomorrow']);
    assert.equal(sum.projectIds.length, 1);

    const t = await (await fetch(`${BASE}/api/local/traces/${traceId}`)).json();
    const byKind = (k) => t.spans.filter((s) => s.kind === k);
    const [intake] = byKind('intake');
    const [router] = byKind('router');
    const [turn] = byKind('brain-turn');
    const tools = byKind('tool-call');
    const [handoff] = byKind('handoff');
    assert.equal(intake.parentId, '');
    assert.deepEqual([intake.meta.via, intake.meta.who], ['loopback', 'local']);
    assert.equal(router.parentId, intake.spanId);
    assert.equal(turn.parentId, intake.spanId);
    assert.deepEqual(tools.map((s) => [s.name, s.parentId]), [['Bash', turn.spanId], ['mcp__rigs__project_create', turn.spanId]]);
    assert.equal(handoff.parentId, turn.spanId, 'the MCP handoff attaches to the turn that made it (RIGS_TRACE)');
    assert.equal(handoff.name, 'project_create');
    assert.equal(handoff.meta.projectId, sum.projectIds[0]);
    assert.deepEqual([router.meta.route, router.meta.via, router.meta.model], ['answer', 'model', 'claude-haiku-5-5']);
    assert.match(router.input.prompt, /You are the router of JARVIS/);
    assert.match(router.output.reply, /"route":"answer"/);
    assert.deepEqual([turn.meta.provider, turn.meta.model, turn.meta.inputTokens, turn.meta.outputTokens, turn.meta.cacheReadTokens, turn.meta.costUsd, turn.meta.sessionId], ['claude', 'claude-haiku-5-5', 11, 22, 333, 0.0123, 'fake-session']);
    assert.equal(turn.output, 'Checking, sir. Sunny, sir.');
    assert.match(turn.input, /the weather forecast for Budapest tomorrow/);
    for (const s of t.spans) { assert.equal(s.status, 'ok', `${s.kind} ${s.name}`); assert.ok(s.end >= s.start, `${s.kind} has timings`); assert.equal(s.node, 'test-node'); }
    assert.ok(!JSON.stringify(t).includes('SECRETSECRETSECRET'), 'the bearer token in the Bash call is redacted');
    assert.deepEqual(tools[0].meta.truncated, ['output'], 'the 20k tool result is cut to the cap');
    assert.equal(t.tree.length, 1);
    assert.deepEqual(t.tree[0].children.map((c) => c.kind), ['router', 'brain-turn']);
    const project = await (await fetch(`${BASE}/api/local/projects/${sum.projectIds[0]}`)).json();
    assert.deepEqual(project.trace, { traceId, parentId: handoff.spanId }, 'the project keeps the trace for its plan and briefs');

    const mesh = await (await fetch(BASE + '/api/traces?since=1h')).json();
    assert.deepEqual(mesh.nodes, ['test-node']);
    assert.ok(mesh.traces.some((x) => x.traceId === traceId));
    const meshOne = await (await fetch(`${BASE}/api/traces/${traceId}`)).json();
    assert.equal(meshOne.spans.length, t.spans.length);
    assert.equal((await fetch(`${BASE}/api/local/traces/tr-20200101-000000000000`)).status, 404);

    // the MCP server lists the trace tools and trace_list reaches the node
    const mcp = spawn(process.execPath, [path.join(ROOT, 'bin/rigs.js'), 'mcp'], { env, stdio: ['pipe', 'pipe', 'pipe'] });
    let mout = '';
    mcp.stdout.on('data', (d) => { mout += d; });
    mcp.stdin.write(JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/list' }) + '\n');
    mcp.stdin.write(JSON.stringify({ jsonrpc: '2.0', id: 2, method: 'tools/call', params: { name: 'trace_list', arguments: { since: '1h' } } }) + '\n');
    for (let i = 0; i < 50 && mout.split('\n').filter(Boolean).length < 2; i++) await new Promise((r) => setTimeout(r, 100));
    mcp.kill();
    const [tl, call] = mout.split('\n').filter(Boolean).map((l) => JSON.parse(l)).sort((a, b) => a.id - b.id);
    const names = tl.result.tools.map((x) => x.name);
    assert.ok(names.includes('trace_list') && names.includes('trace_get'), names.join(', '));
    assert.ok(JSON.parse(call.result.content[0].text).traces.some((x) => x.traceId === traceId), call.result.content[0].text.slice(0, 300));
  } finally {
    server.kill();
  }
});
