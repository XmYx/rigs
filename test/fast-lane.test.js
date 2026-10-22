// Wave A — the fast lane (docs/request-to-result-2026-10-22.md §3): the router spawn without MCP or tools, rules first,
// the capped and cached context prep, the stable system prompt with the [now: …] block, the lean MCP set of bounded
// turns, the quick-lane watchdog's timing decision, the fast-path note and tool-done events. A stand-in `claude` logs
// every argv; no model, no daemon.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { after, test } from 'node:test';

// A throwaway RIGS home and a stand-in `claude` first on PATH: never the real ~/.rigs or Claude.
const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'rigs-fast-lane-'));
const BIN = path.join(TMP, 'bin');
fs.mkdirSync(BIN);
const FAKE_LOG = path.join(TMP, 'claude-args.jsonl');
fs.writeFileSync(path.join(BIN, 'claude'), `#!${process.execPath}
const fs = require('node:fs');
const args = process.argv.slice(2);
if (args[0] === '--version') { console.log('9.9.9 (Claude Code)'); process.exit(0); }
fs.appendFileSync(process.env.FAKE_CLAUDE_LOG, JSON.stringify(args) + '\\n');
// the router model: a text reply with one JSON decision
if (args[args.indexOf('--output-format') + 1] === 'text') { console.log(process.env.FAKE_ROUTER_REPLY || '{"route":"answer","reason":"the model says answer","title":"","work":[]}'); process.exit(0); }
const model = args[args.indexOf('--model') + 1];
const sid = 'fl-sess-1';
const out = (o) => console.log(JSON.stringify(o));
out({ type: 'system', subtype: 'init', session_id: sid });
out({ type: 'assistant', session_id: sid, message: { content: [{ type: 'tool_use', id: 'tu9', name: 'mcp__rigs__mesh_status', input: {} }] } });
out({ type: 'user', session_id: sid, message: { content: [{ type: 'tool_result', tool_use_id: 'tu9', content: 'ok', is_error: false }] } });
const reply = process.env.FAKE_CLAUDE_REPLY || 'Done, sir.';
out({ type: 'stream_event', session_id: sid, event: { type: 'content_block_delta', delta: { type: 'text_delta', text: reply } } });
out({ type: 'result', session_id: sid, is_error: false, result: reply, total_cost_usd: 0.001,
  usage: { input_tokens: 10, output_tokens: 5 }, modelUsage: { [model]: { inputTokens: 10, outputTokens: 5 } } });
`, { mode: 0o755 });
Object.assign(process.env, {
  RIGS_HOME: path.join(TMP, 'rigs'), RIGS_NO_OPENRIG: '1', RIGS_NO_AUTOUPDATE: '1', RIGS_NO_MIGRATIONS: '1', RIGS_NAME: 'test-node',
  RIGS_OLLAMA_URL: 'http://127.0.0.1:9', PATH: BIN + path.delimiter + process.env.PATH, FAKE_CLAUDE_LOG: FAKE_LOG,
});
after(() => fs.rmSync(TMP, { recursive: true, force: true }));

const { config, saveConfig } = await import('../src/config.js');
const R = await import('../src/router.js');
const Q = await import('../src/quick.js');
const chat = await import('../src/chat.js');
const { APP_DIR } = await import('../src/util.js');

{ const c = config(); c.quick = { ...c.quick, enabled: true, local: { ...(c.quick?.local || {}), enabled: false } }; saveConfig(c); }
const posix = process.platform !== 'win32';
const runs = () => (fs.existsSync(FAKE_LOG) ? fs.readFileSync(FAKE_LOG, 'utf8').trim().split('\n').filter(Boolean).map((l) => JSON.parse(l)) : []);
const arg = (a, flag) => a[a.indexOf(flag) + 1];
const ctx = (threads = []) => ({ threads, projects: [], catalog: [], capture: {}, rules: '' });

// ---------------------------------------------------------------- A1 the router spawn

test('A1: the router model runs without MCP servers, tools or a saved session, in plan mode', { skip: !posix && 'stand-in claude is a POSIX script' }, async () => {
  fs.rmSync(FAKE_LOG, { force: true });
  const c = ctx();
  const d = await R.modelRoute('tell me a joke', c, { model: 'claude-haiku-5-5' });
  assert.equal(d.route, 'answer');
  const a = runs().at(-1);
  assert.equal(a[0], '-p');
  assert.equal(arg(a, '--output-format'), 'text');
  assert.equal(arg(a, '--permission-mode'), 'plan');
  assert.equal(arg(a, '--model'), 'claude-haiku-5-5');
  const i = a.indexOf('--strict-mcp-config');
  assert.ok(i > 0);
  assert.deepEqual(a.slice(i), ['--strict-mcp-config', '--mcp-config', '{"mcpServers":{}}', '--tools', '', '--no-session-persistence'], 'the lean flags, the JSON as one argv element, --tools with an empty argument');
  assert.deepEqual(JSON.parse(arg(a, '--mcp-config')), { mcpServers: {} });
  assert.equal(c.capture.engine, 'claude');
});

// ---------------------------------------------------------------- A2 rules first

test('A2: confidentRules — browse requests, plain questions and lookups answer; thread overlap, imperatives and long asks are left to the engines', () => {
  const browse = R.confidentRules('open my Downloads folder');
  assert.deepEqual(browse, { route: 'answer', reason: 'opens a folder or file in the file browser (rules)' });
  assert.equal(R.confidentRules('show me the files in ~/rigs-dev on magix-system').route, 'answer');
  assert.deepEqual(R.confidentRules('what is the weather in Budapest?'), { route: 'answer', reason: 'a plain question (rules)' });
  assert.equal(R.confidentRules('how is the merge steward doing?').reason, 'a plain question (rules)');
  // "show the last 10 uefa winners" is not a QUESTION (no question word, no "?"): the SHOW/LIST lookup pattern takes it
  assert.equal(R.isClearQuestion('show the last 10 uefa winners'), false);
  assert.deepEqual(R.confidentRules('show the last 10 uefa winners'), { route: 'answer', reason: 'a lookup (rules)' });
  assert.equal(R.confidentRules('list the top 5 processes on magix').route, 'answer');
  assert.equal(R.confidentRules('please tell me the latest news about rust').route, 'answer');
  assert.equal(R.confidentRules('tell me the latest changes in ~/rigs-dev/x'), null, 'a lookup that names a path (and is no browse request): the model decides');
  assert.equal(R.confidentRules('show the latest files in ~/Downloads/x').reason, 'opens a folder or file in the file browser (rules)', 'a browse request naming a path opens the file browser');
  // a question sharing its subject with an ongoing thread: null (the engines may continue that thread)
  const threads = [{ id: 't1', title: 'Dark mode for the szuf dashboard' }];
  assert.equal(R.confidentRules('how is the dark mode for the szuf dashboard going?', threads), null);
  assert.equal(R.confidentRules('how is the dark mode for the szuf dashboard going?', []).route, 'answer', 'the same question with no such thread');
  // imperatives, polite or not, are never decided here — and nothing here is ever implement or plan
  assert.equal(R.confidentRules('fix the router'), null);
  assert.equal(R.confidentRules('can you add a dark mode to szuf?'), null);
  assert.equal(R.confidentRules('show the last build and fix it'), null);
  assert.equal(R.confidentRules(`what do you think about ${'this long plan '.repeat(25)}?`), null, 'a long ask');
  assert.equal(R.confidentRules(''), null);
  assert.equal(R.confidentRules('build a login page'), null);
});

test('A2: route — rules first decides at once (via rules, no engine), yolo still wins, rulesFirst:false keeps the old behaviour', async () => {
  const calls = [];
  const jev = async () => { calls.push('jev'); return { route: 'answer', reason: 'jev' }; };
  const claude = async () => { calls.push('claude'); return { route: 'answer', reason: 'claude' }; };
  const on = R.routerSettings({ engine: 'jev', fallback: 'claude' });
  const c = ctx();
  const d = await R.route('what is the weather in Budapest?', c, { settings: on, engines: { jev, claude } });
  assert.deepEqual([d.route, d.via, d.reason], ['answer', 'rules', 'a plain question (rules)']);
  assert.equal(c.capture.engine, 'rules', 'the trace says the rules decided');
  assert.deepEqual(calls, [], 'no engine asked');
  const b = await R.route('open my Downloads folder', ctx(), { settings: on, engines: { jev, claude } });
  assert.deepEqual([b.route, b.via], ['answer', 'rules']);
  assert.deepEqual(calls, []);
  // an ambiguous ask (an imperative) still goes to the engines
  assert.equal((await R.route('add a dark mode to szuf', ctx(), { settings: on, engines: { jev, claude } })).via, 'jev');
  assert.deepEqual(calls.splice(0), ['jev']);
  // a question overlapping an ongoing thread goes to the engines too
  const threads = [{ id: 't1', title: 'Dark mode for the szuf dashboard' }];
  assert.equal((await R.route('how is the dark mode for the szuf dashboard going?', ctx(threads), { settings: on, engines: { jev, claude } })).via, 'jev');
  assert.deepEqual(calls.splice(0), ['jev']);
  // yolo beats the rules
  const y = await R.route('yolo what is the weather in Budapest?', ctx(), { settings: on, engines: { jev, claude } });
  assert.equal(y.route, 'yolo');
  assert.deepEqual(calls, []);
  // rulesFirst off: the question reaches the engine as before
  const off = R.routerSettings({ engine: 'jev', fallback: 'claude', rulesFirst: false });
  const o = await R.route('what is the weather in Budapest?', ctx(), { settings: off, engines: { jev, claude } });
  assert.deepEqual([o.via, calls.splice(0)], ['jev', ['jev']]);
});

// ---------------------------------------------------------------- A3 context prep

test('A3: listChats keeps an mtime-checked index — a second listing parses no file, a changed file is parsed again', async () => {
  const dir = path.join(process.env.RIGS_HOME, 'chats');
  fs.mkdirSync(dir, { recursive: true });
  for (let i = 0; i < 5; i++) fs.writeFileSync(path.join(dir, `idx-${i}.json`), JSON.stringify({ id: `idx-${i}`, title: `chat ${i}`, brain: 'claude', model: '', updatedAt: 1000 + i, messages: [{ role: 'user', text: 'hi', ts: 1 }], seen: {} }));
  const before = chat.chatIndexStats().reads;
  const first = await chat.listChats();
  assert.ok(first.filter((c) => c.id.startsWith('idx-')).length === 5);
  const afterFirst = chat.chatIndexStats().reads;
  assert.ok(afterFirst - before >= 5, 'the new files were parsed');
  const second = await chat.listChats();
  assert.equal(chat.chatIndexStats().reads, afterFirst, 'nothing parsed again');
  assert.deepEqual(second.map((c) => c.id), first.map((c) => c.id));
  // a change on disk (another writer, a quick turn) is picked up: size and mtime differ
  fs.writeFileSync(path.join(dir, 'idx-2.json'), JSON.stringify({ id: 'idx-2', title: 'chat 2 renamed', brain: 'claude', model: '', updatedAt: 5000, messages: [{ role: 'user', text: 'hi', ts: 1 }, { role: 'assistant', text: 'hello', ts: 2 }], seen: {} }));
  const third = await chat.listChats();
  assert.equal(chat.chatIndexStats().reads, afterFirst + 1, 'only the changed file');
  const two = third.find((c) => c.id === 'idx-2');
  assert.deepEqual([two.title, two.count], ['chat 2 renamed', 2]);
  assert.equal(third[0].id, 'idx-2', 'sorted by updatedAt');
  // a deleted file leaves the index
  fs.rmSync(path.join(dir, 'idx-4.json'));
  assert.ok(!(await chat.listChats()).some((c) => c.id === 'idx-4'));
  assert.equal(chat.chatIndexStats().reads, afterFirst + 1);
  for (let i = 0; i < 4; i++) fs.rmSync(path.join(dir, `idx-${i}.json`), { force: true });
});

test('A3: cappedWorkspaces — a fast catalog comes through, a slow one falls back to the last known while it refreshes the cache', async () => {
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
  assert.deepEqual(await chat.cappedWorkspaces(undefined), [], 'no resolver: no catalog');
  const a = [{ node: 'a', platform: 'mac', items: [] }];
  assert.deepEqual(await chat.cappedWorkspaces(async () => a, { capMs: 500 }), a);
  assert.deepEqual(chat.cachedWorkspaces(), a);
  // slow: the cap returns the last known value; the slow call keeps running and lands in the cache
  const b = [{ node: 'b', platform: 'linux', items: [] }];
  const t0 = Date.now();
  assert.deepEqual(await chat.cappedWorkspaces(() => sleep(300).then(() => b), { capMs: 50 }), a, 'the last known catalog');
  assert.ok(Date.now() - t0 < 250, 'did not wait for the slow call');
  await sleep(400);
  assert.deepEqual(chat.cachedWorkspaces(), b, 'the slow call refreshed the cache');
  // a failing resolver keeps the last catalog; a resolver returning junk too
  assert.deepEqual(await chat.cappedWorkspaces(async () => { throw new Error('peer down'); }, { capMs: 500 }), b);
  assert.deepEqual(await chat.cappedWorkspaces(async () => null, { capMs: 500 }), b);
  // concurrent callers share one in-flight call
  let calls = 0;
  const slow = () => { calls++; return sleep(120).then(() => a); };
  const [x, y] = await Promise.all([chat.cappedWorkspaces(slow, { capMs: 500 }), chat.cappedWorkspaces(slow, { capMs: 500 })]);
  assert.deepEqual([x, y, calls], [a, a, 1]);
});

// ---------------------------------------------------------------- A4 the stable system prompt and the [now: …] block

test('A4: personaPrompt is identical a minute apart with different live stats; the live facts move to liveContext', () => {
  const mesh = '- test-node (this machine): mac · agents: claude · tools: comfyui\n- magix-system: linux · agents: claude, codex';
  const realNow = Date.now;
  const p1 = chat.personaPrompt(mesh);
  Date.now = () => realNow() + 60000;
  const p2 = chat.personaPrompt(mesh);
  Date.now = realNow;
  assert.equal(p1, p2, 'the same system prompt a minute later (prompt cache survives a resumed turn)');
  assert.doesNotMatch(p1, /Local time on this machine|Projects \(id · name|cpu \d+% mem/);
  assert.match(p1, /Machines in the mesh[\s\S]*magix-system: linux · agents: claude, codex/, 'the static mesh shape stays in the system prompt');
  assert.match(p1, /\[now: …\] block/);
  // the live block: clock, mesh live line, the 12 most recent projects, one line, under 1200 chars
  const projects = Array.from({ length: 20 }, (_, i) => `- p${i} · Project number ${i} · running · on magix-system`).join('\n');
  const now = new Date(2026, 9, 22, 12, 41);
  const live = chat.liveContext({ now, mesh: 'test-node (mac, online, cpu 7% mem 40%), magix-system (linux, online, NVIDIA RTX 4090, comfyui)', projects });
  assert.match(live, /^\[now: Thursday 22 October, 12:41 · mesh: test-node \(mac, online, cpu 7% mem 40%\), magix-system \(linux, online, NVIDIA RTX 4090, comfyui\) · active projects: p0 · Project number 0 · running · on magix-system; /);
  assert.ok(live.includes('p11 · Project number 11') && !live.includes('p12 · Project number 12'), 'the 12 most recent');
  assert.match(live, /\(\+8 more: project_list\)\]$/);
  assert.ok(!live.includes('\n'), 'one line');
  assert.ok(live.length <= 1200, `under 1200 chars (${live.length})`);
  assert.equal(chat.liveContext({ now }), '[now: Thursday 22 October, 12:41]');
  const long = chat.liveContext({ now, projects: Array.from({ length: 12 }, (_, i) => `- p${i} · ${'x'.repeat(120)}`).join('\n') });
  assert.ok(long.length <= 1200 && long.endsWith(']'), 'capped');
});

test('A4+A5+A8: a quick turn gets the [now: …] block at the top of its prompt, only the rigs MCP server, and tool/tool-done events with ids; the main thread keeps the full MCP set', { skip: !posix && 'stand-in claude is a POSIX script' }, async () => {
  fs.rmSync(FAKE_LOG, { force: true });
  const main = await chat.mainChat();
  const q = Q.resolveQuick({ text: 'what time is it', route: 'answer', settings: {} });
  const events = [];
  const opts = { meshSummary: '- test-node (this machine): mac · agents: claude', live: 'test-node (mac, online, cpu 7% mem 40%)', projects: '- rigs-main · RIGS · JARVIS · on test-node' };
  const out = await chat.quickTurn(main.id, 'what time is it', q, (e) => events.push(e), opts);
  assert.equal(out.text, 'Done, sir.');
  const a = runs().at(-1);
  assert.match(a[1], /^\[now: \w+ \d+ \w+, \d\d:\d\d · mesh: test-node \(mac, online, cpu 7% mem 40%\) · active projects: rigs-main · RIGS · JARVIS · on test-node\]\n/);
  assert.ok(a[1].endsWith('\nwhat time is it'), 'the block, then the (empty) thread context and the message');
  const system = arg(a, '--append-system-prompt');
  assert.doesNotMatch(system, /Local time on this machine|cpu 7%|rigs-main · RIGS/, 'nothing live in the system prompt');
  assert.match(system, /# Fast path[\s\S]*never `find ~`/, 'the fast-path note with the no-disk-scan line (A7)');
  // A5: the lean MCP set
  assert.ok(a.includes('--strict-mcp-config'));
  const mcp = JSON.parse(arg(a, '--mcp-config'));
  assert.deepEqual(Object.keys(mcp.mcpServers), ['rigs']);
  assert.deepEqual(mcp.mcpServers.rigs, { type: 'stdio', command: process.execPath, args: [path.join(APP_DIR, 'bin', 'rigs.js'), 'mcp'], env: {} });
  assert.deepEqual(mcp, chat.leanMcpConfig());
  assert.equal(arg(a, '--max-turns'), '8');
  // A8: tool and tool-done carry the tool_use id
  const tool = events.find((e) => e.type === 'tool');
  assert.deepEqual([tool.id, tool.name], ['tu9', 'mcp__rigs__mesh_status']);
  const done = events.find((e) => e.type === 'tool-done');
  assert.deepEqual(done, { type: 'tool-done', id: 'tu9', name: 'mcp__rigs__mesh_status', ok: true });
  assert.ok(events.indexOf(tool) < events.indexOf(done));

  // the main thread (a full turn): the same block heads the prompt, no --strict-mcp-config, no --mcp-config
  const full = await chat.sendMessage(main.id, { text: 'hello there', brain: 'claude', model: 'claude-opus-5-5' }, () => {}, opts);
  assert.equal(full.text, 'Done, sir.');
  const f = runs().at(-1);
  assert.match(f[1], /^\[now: [^\n]*active projects: rigs-main · RIGS · JARVIS · on test-node\]\n/);
  assert.ok(f[1].endsWith('hello there'));
  assert.ok(!f.includes('--strict-mcp-config') && !f.includes('--mcp-config'), 'the user\'s full MCP set');
  assert.doesNotMatch(arg(f, '--append-system-prompt'), /Local time on this machine|# Fast path/);
});

test('A5: leanMcpConfig mirrors the ~/.claude.json rigs registration (node, bin/rigs.js mcp, stdio, empty env)', () => {
  assert.deepEqual(chat.leanMcpConfig({ node: '/usr/local/bin/node', appDir: '/opt/rigs' }), {
    mcpServers: { rigs: { type: 'stdio', command: '/usr/local/bin/node', args: ['/opt/rigs/bin/rigs.js', 'mcp'], env: {} } },
  });
  const d = chat.leanMcpConfig();
  assert.equal(d.mcpServers.rigs.command, process.execPath);
  assert.equal(d.mcpServers.rigs.args[0], path.join(APP_DIR, 'bin', 'rigs.js'));
  assert.ok(fs.existsSync(d.mcpServers.rigs.args[0]), 'the file it names exists');
});

// ---------------------------------------------------------------- A6 the watchdog's timing decision

test('A6: quickStall — nothing before the cold-start grace plus stallMs, then stalled; a progress event restarts the clock; 0 switches it off', () => {
  const s = (now, lastEventAt = 0, stallMs = 20000) => Q.quickStall({ now, startedAt: 100000, lastEventAt, stallMs });
  assert.deepEqual(s(100000), { stalled: false, reason: '', checkInMs: 28000 }, 'at start: look again when grace + stall have passed');
  assert.equal(s(127999).stalled, false, 'cold start: 8 s grace, then 20 s');
  assert.deepEqual(s(128000), { stalled: true, reason: 'quick turn made no progress for 20 s', checkInMs: 0 });
  assert.equal(s(127999, 102000).stalled, false, 'an event inside the grace does not shorten it');
  assert.equal(s(128000, 102000).stalled, true);
  assert.deepEqual(s(130000, 130000), { stalled: false, reason: '', checkInMs: 20000 }, 'a delta just now: 20 s more');
  assert.equal(s(149999, 130000).stalled, false);
  assert.equal(s(150000, 130000).stalled, true);
  assert.deepEqual(s(999999, 0, 0), { stalled: false, reason: '', checkInMs: 0 }, 'off');
  assert.equal(Q.quickStall({ now: 5, startedAt: 0, stallMs: 1000, graceMs: 0 }).checkInMs, 995);
  assert.deepEqual(Q.QUICK_PROGRESS_EVENTS, ['delta', 'tool', 'tool-done']);
  assert.equal(Q.resolveQuick({ text: 'x', route: 'answer', settings: {} }).stallMs, 20000, 'the turn carries config.quick.stallMs');
  assert.equal(Q.resolveQuick({ text: 'x', route: 'answer', settings: { stallMs: 5000 } }).stallMs, 5000);
});

// ---------------------------------------------------------------- A7 the fast-path note

test('A7: the fast-path note tells the brain how to find a named folder or file without a disk scan', () => {
  const note = Q.quickNote({ model: 'claude-haiku-5-5', maxTurns: 8 });
  assert.ok(note.includes('To find a named folder or file, use what you already know (the project record, the thread, mesh_workspaces), or mesh_list_dir / `find <likely parent> -maxdepth 3`; never `find ~` or a whole-disk search.'));
  assert.match(note, /\[\[ESCALATE\]\]/);
});
