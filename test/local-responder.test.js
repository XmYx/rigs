// The local live responder (config.quick.local → src/responder.js, wired into chat.quickTurn): settings and patching,
// when it takes a turn (only 'answer' requests on its tiers, only when enabled), the prompt, the narration guard, the
// Ollama tool loop against a fake Ollama, a turn streamed from another machine, the fallback chain (can't start →
// the Haiku turn; can't answer → the full brain, never both at once), the trace and ledger it leaves, and a pin of
// today's behaviour with the feature off. No real model, no daemon, never the real ~/.rigs.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { after, test } from 'node:test';

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// ---------------------------------------------------------------- a fake Ollama

const ollama = { loaded: ['qwen3:8b'], installed: ['qwen3:8b'], script: [], chats: [], warmups: [] };
const ndjson = (res, o) => { try { res.write(JSON.stringify(o) + '\n'); } catch {} };
const ollamaServer = http.createServer(async (req, res) => {
  let raw = '';
  for await (const c of req) raw += c;
  const b = raw ? JSON.parse(raw) : {};
  const json = (o) => { res.writeHead(200, { 'content-type': 'application/json' }); res.end(JSON.stringify(o)); };
  if (req.url === '/api/ps') return json({ models: ollama.loaded.map((name) => ({ name, model: name, size_vram: 7.6 * 1024 ** 3, context_length: 16384 })) });
  if (req.url === '/api/tags') return json({ models: ollama.installed.map((name) => ({ name, model: name })) });
  if (req.url !== '/api/chat') { res.writeHead(404); return res.end(); }
  if (b.stream === false) { ollama.warmups.push(b); return json({ done: true, message: { role: 'assistant', content: 'G' } }); }
  ollama.chats.push(b);
  const step = ollama.script.shift() || { text: 'Very good, sir.' };
  if (step.status) { res.writeHead(step.status, { 'content-type': 'application/json' }); return res.end(JSON.stringify({ error: step.body || 'boom' })); }
  res.writeHead(200, { 'content-type': 'application/x-ndjson' });
  if (step.delayMs) await sleep(step.delayMs);
  if (step.tool) ndjson(res, { message: { role: 'assistant', content: '', tool_calls: [{ function: { name: step.tool, arguments: step.args || {} } }] }, done: false });
  for (const part of String(step.text || '').match(/.{1,5}/gs) || []) ndjson(res, { message: { role: 'assistant', content: part }, done: false });
  if (step.errorAfter) { ndjson(res, { error: step.errorAfter }); return res.end(); }
  ndjson(res, { message: { role: 'assistant', content: '' }, done: true, prompt_eval_count: 120, eval_count: 12, total_duration: 5e7 });
  res.end();
});
await new Promise((r) => ollamaServer.listen(0, '127.0.0.1', r));
const OLLAMA_URL = `http://127.0.0.1:${ollamaServer.address().port}`;
const resetOllama = (o = {}) => Object.assign(ollama, { loaded: ['qwen3:8b'], installed: ['qwen3:8b'], script: [], chats: [], warmups: [] }, o);

// ---------------------------------------------------------------- a throwaway RIGS home and a stand-in `claude`

const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'rigs-responder-'));
const BIN = path.join(TMP, 'bin');
fs.mkdirSync(BIN);
const FAKE_LOG = path.join(TMP, 'claude-args.jsonl');
fs.writeFileSync(path.join(BIN, 'claude'), `#!${process.execPath}
const fs = require('node:fs');
const args = process.argv.slice(2);
if (args[0] === '--version') { console.log('9.9.9 (Claude Code)'); process.exit(0); }
fs.appendFileSync(process.env.FAKE_CLAUDE_LOG, JSON.stringify(args) + '\\n');
const reply = process.env.FAKE_CLAUDE_REPLY || 'Haiku here, sir.';
const model = args[args.indexOf('--model') + 1];
const out = (o) => console.log(JSON.stringify(o));
out({ type: 'system', subtype: 'init', session_id: 'quick-sess-1' });
for (const part of reply.match(/.{1,5}/gs)) out({ type: 'stream_event', session_id: 'quick-sess-1', event: { type: 'content_block_delta', delta: { type: 'text_delta', text: part } } });
out({ type: 'result', session_id: 'quick-sess-1', is_error: false, result: reply, total_cost_usd: 0.001,
  usage: { input_tokens: 10, output_tokens: 5 }, modelUsage: { [model]: { inputTokens: 10, outputTokens: 5 } } });
`, { mode: 0o755 });
Object.assign(process.env, {
  RIGS_HOME: path.join(TMP, 'rigs'), RIGS_NO_OPENRIG: '1', RIGS_NO_AUTOUPDATE: '1', RIGS_NO_MIGRATIONS: '1', RIGS_NAME: 'test-node',
  RIGS_OLLAMA_URL: OLLAMA_URL, PATH: BIN + path.delimiter + process.env.PATH, FAKE_CLAUDE_LOG: FAKE_LOG,
});
const hosts = [];
after(() => { ollamaServer.close(); for (const h of hosts) h.close(); fs.rmSync(TMP, { recursive: true, force: true }); });

const { config, saveConfig } = await import('../src/config.js');
const Q = await import('../src/quick.js');
const R = await import('../src/responder.js');
const chat = await import('../src/chat.js');
const usage = await import('../src/usage.js');
const trace = await import('../src/trace.js');

// The read-only tools, faked: what the model gets and what each call returns.
const toolCalls = [];
const fakeTool = (name, out) => ({ name, description: `fake ${name}`, inputSchema: { type: 'object', properties: {} }, run: async (a) => { toolCalls.push({ name, a }); return out; } });
R.setResponderTools([
  fakeTool('mesh_status', [{ name: 'macbookpro', online: true }, { name: 'magix-system', online: true }]),
  fakeTool('mesh_sessions', [{ node: 'magix-system', sessions: [] }]),
  fakeTool('mesh_exec', { ok: true }), // in the catalog, but never handed to the model
]);

const setQuick = (patch) => { const c = config(); c.quick = { ...c.quick, ...patch }; saveConfig(c); };
const setLocal = (l) => setQuick({ local: l === null ? undefined : { enabled: true, node: '', ...l } });
const answerRouter = async () => ({ route: 'answer', via: 'jev', reason: 'a question' });
function fakeSend(sent) {
  return async (chatId, msg, emit, opts) => {
    sent.push({ chatId, text: msg.text, hint: opts.hint });
    emit({ type: 'done', text: 'Full brain here, sir.', chatId });
    return { text: 'Full brain here, sir.' };
  };
}
const claudeRuns = () => (fs.existsSync(FAKE_LOG) ? fs.readFileSync(FAKE_LOG, 'utf8').trim().split('\n').filter(Boolean).length : 0);
const lastOf = async (kind) => (await usage.readRecords()).filter((r) => r.kind === kind).at(-1);
const posix = process.platform !== 'win32';

// ---------------------------------------------------------------- settings and patching (pure)

test('localSettings: off by default; tools only from the read-only set; numbers clamped; bad values fall back', () => {
  const d = Q.localSettings();
  assert.deepEqual([d.enabled, d.node, d.model, d.tiers, d.think, d.numCtx, d.keepAlive, d.maxRounds, d.guard, d.firstTokenMs, d.timeoutMs],
    [false, '', 'qwen3:8b', ['haiku'], false, 16384, '30m', 4, true, 2500, 30000]);
  assert.deepEqual(d.tools, Q.READ_ONLY_TOOLS);
  const s = Q.localSettings({ enabled: 'on', tools: ['mesh_status', 'mesh_exec', 'mesh_write_file', 'jarvis_task', 'mesh_status'], tiers: ['Sonnet', 'opus'], numCtx: 1, maxRounds: 99, keepAlive: 'forever', firstTokenMs: 'soon' });
  assert.equal(s.enabled, true);
  assert.deepEqual(s.tools, ['mesh_status'], 'a configured tool outside the read-only set never survives');
  assert.deepEqual(s.tiers, ['sonnet']);
  assert.deepEqual([s.numCtx, s.maxRounds, s.keepAlive, s.firstTokenMs], [2048, 10, '30m', 2500]);
});

test('quickSettings keeps a configured local block (validated) and adds none when there is none', () => {
  assert.equal('local' in Q.quickSettings({}), false, 'a config without it reads exactly as before');
  const s = Q.quickSettings({ local: { enabled: true, model: 'gpt-oss:20b', tools: ['mesh_apps', 'mesh_kill'] } });
  assert.deepEqual([s.local.enabled, s.local.model, s.local.tools], [true, 'gpt-oss:20b', ['mesh_apps']]);
});

test('applyQuickPatch: local merges onto the current block and refuses what it cannot take', () => {
  const on = Q.applyQuickPatch({}, { local: { enabled: true } });
  assert.deepEqual([on.enabled, on.local.enabled, on.local.model], [true, true, 'qwen3:8b']);
  const next = Q.applyQuickPatch({ local: { enabled: true, model: 'gpt-oss:20b' } }, { local: { node: 'magix-system' } });
  assert.deepEqual([next.local.enabled, next.local.model, next.local.node], [true, 'gpt-oss:20b', 'magix-system'], 'kept');
  assert.throws(() => Q.applyQuickPatch({}, { local: { tools: ['mesh_exec'] } }), /read-only tools/);
  assert.throws(() => Q.applyQuickPatch({}, { local: { enabled: 'maybe' } }), /local.enabled must be/);
  assert.throws(() => Q.applyQuickPatch({}, { local: { model: ' ' } }), /local.model must not be empty/);
  assert.throws(() => Q.applyQuickPatch({}, { local: { tiers: ['opus'] } }), /local.tiers/);
  assert.throws(() => Q.applyQuickPatch({}, { local: 'on' }), /local must be/);
  const off = Q.applyQuickPatch({ local: { enabled: true } }, { enabled: false });
  assert.equal(off.local.enabled, true, 'a patch without local leaves it as it was');
});

// ---------------------------------------------------------------- which turns it takes (pure)

test('localResponder: only answer-routed fast-path turns on its tiers, only when enabled; a Claude tier on the request wins; quick: local forces it', () => {
  const answer = (o = {}) => Q.resolveQuick({ text: 'what time is it in Tokyo', route: 'answer', settings: {}, ...o });
  const on = { enabled: true, node: '' };
  assert.equal(Q.localResponder(answer(), {}).on, false, 'off by default');
  assert.match(Q.localResponder(answer(), {}).reason, /enabled is false/);
  const l = Q.localResponder(answer(), { local: on }, { self: 'magix-system' });
  assert.deepEqual([l.on, l.node, l.model, l.forced], [true, 'magix-system', 'qwen3:8b', false], "node '' = this machine");
  assert.equal(Q.localResponder(answer(), { local: { ...on, node: 'gpu-box' } }, { self: 'mac' }).node, 'gpu-box');
  const sonnet = answer({ text: 'search the web for the latest Node release' });
  assert.equal(sonnet.tier, 'sonnet');
  assert.equal(Q.localResponder(sonnet, { local: on }).on, false, 'the sonnet tier stays on Claude unless listed');
  assert.equal(Q.localResponder(sonnet, { local: { ...on, tiers: ['haiku', 'sonnet'] } }).on, true);
  for (const route of ['implement', 'plan', 'continue', '']) {
    assert.equal(Q.localResponder(Q.resolveQuick({ text: 'x', route, settings: {} }), { local: on }).on, false, `routed ${route || 'nowhere'}`);
  }
  assert.equal(Q.localResponder(answer({ override: 'haiku' }), { local: on }).on, false, 'quick: haiku means Claude Haiku');
  assert.equal(Q.localResponder(answer({ override: false }), { local: on }).on, false);
  const forced = Q.localResponder(answer({ override: 'local' }), {}, { self: 'x' });
  assert.deepEqual([forced.on, forced.forced], [true, true], 'quick: local on the request, even with the block off');
  assert.equal(Q.quickOverride('LOCAL'), 'local');
  assert.equal(answer({ override: 'local' }).local, true);
  assert.equal(answer({ override: 'sonnet' }).forcedTier, 'sonnet');
});

test('localResponder: asks about live data (weather, prices, scores) stay on the Claude tier, which can search', () => {
  const on = { local: { enabled: true, node: '' } };
  const ask = (text, o = {}) => Q.localResponder(Q.resolveQuick({ text, route: 'answer', settings: {}, ...o }), on, { self: 'magix-system', text });
  for (const text of ["What's the weather in Budapest right now?", 'Will it rain tomorrow?', 'What is the Bitcoin price today?', 'What was the score in the Arsenal game?', 'Euro to forint exchange rate?']) {
    const r = ask(text);
    assert.equal(r.on, false, text);
    assert.match(r.reason, /live data/);
  }
  for (const text of ['Good evening, JARVIS.', 'What is the capital of Australia?', 'Which apps are down?', 'How much have I spent on tokens today?', 'How far away is the Moon?']) {
    assert.equal(ask(text).on, true, text);
  }
  assert.equal(ask("What's the weather in Budapest?", { override: 'local' }).on, true, 'quick: local on the request still forces it');
  assert.equal(Q.liveInfo('Weather in Paris'), 'weather');
  assert.equal(Q.liveInfo('How is the mesh doing?'), '');
});

// ---------------------------------------------------------------- the prompt and the narration guard (pure)

test('responderPrompt: character without the Work section or filing examples, the tool map, escalation last, only the clock line changes', () => {
  const soulText = fs.readFileSync(new URL('../persona/SOUL.md', import.meta.url), 'utf8');
  const p1 = R.responderPrompt({ soul: soulText, persona: { name: 'J.A.R.V.I.S.', address: 'sir', humor: 60 }, name: 'magix-system', model: 'qwen3:8b', now: new Date(2026, 9, 20, 18, 0) });
  const p2 = R.responderPrompt({ soul: soulText, persona: { name: 'J.A.R.V.I.S.', address: 'sir', humor: 60 }, name: 'magix-system', model: 'qwen3:8b', now: new Date(2026, 9, 20, 18, 1) });
  assert.ok(!/## Work: every instruction lands somewhere/.test(p1), 'no Work section');
  assert.ok(!/already at it/i.test(p1), 'no filing example');
  assert.match(p1, /- mesh_status: machines/);
  assert.match(p1, /- trace_list: /);
  const lines1 = p1.split('\n');
  const lines2 = p2.split('\n');
  assert.deepEqual(lines1.slice(0, -1), lines2.slice(0, -1), 'a stable prefix for the KV cache');
  assert.notEqual(lines1.at(-1), lines2.at(-1));
  assert.match(lines1.at(-2), /\[\[ESCALATE\]\]/, 'the escalation rule comes last, before the clock');
  assert.match(R.responderPrompt({ tools: ['mesh_apps'] }), /- mesh_apps:/);
  assert.ok(!/- mesh_status:/.test(R.responderPrompt({ tools: ['mesh_apps'] })), 'only the tools it has');
});

test('narratedToolCall: an announced lookup without a tool call, not an answer or a pleasantry', () => {
  for (const t of ['Let me check the mesh status.', 'Of course, sir. Let me check the mesh status.', 'Scanning the mesh…', "I'll look that up, sir."]) assert.equal(R.narratedToolCall(t), true, t);
  for (const t of ['Canberra, sir.', 'I will be here, sir.', 'Good evening, sir.', '', 'Let me check '.repeat(30)]) assert.equal(R.narratedToolCall(t), false, t);
});

test('contextMessages: the last six messages, cut, as chat roles', () => {
  const msgs = Array.from({ length: 9 }, (_, i) => ({ role: i % 2 ? 'assistant' : 'user', text: `m${i}` + (i === 8 ? 'x'.repeat(900) : '') }));
  const c = R.contextMessages(msgs);
  assert.equal(c.length, 6);
  assert.deepEqual(c.map((m) => m.role), ['assistant', 'user', 'assistant', 'user', 'assistant', 'user']);
  assert.ok(c.at(-1).content.length <= 801);
});

// ---------------------------------------------------------------- the tool loop (fake Ollama)

const L = (o = {}) => Q.localSettings({ enabled: true, ...o });

test('localTurn: a tool round, then the answer; read-only tools only; thinking off, 16k context, keep_alive', async () => {
  resetOllama({ script: [{ tool: 'mesh_status' }, { text: 'Both machines are online, sir.' }] });
  toolCalls.length = 0;
  const events = [];
  const r = await R.localTurn({ text: 'How is the mesh doing?', settings: L(), emit: (e) => events.push(e) });
  assert.equal(r.text, 'Both machines are online, sir.');
  assert.ok(!r.unavailable && !r.error && !r.escalate);
  assert.deepEqual(toolCalls.map((t) => t.name), ['mesh_status']);
  assert.deepEqual(events.filter((e) => e.type === 'tool').map((e) => e.name), ['mesh_status']);
  assert.equal(events.filter((e) => e.type === 'tool-result')[0].status, 'ok');
  const [first, second] = ollama.chats;
  assert.deepEqual(first.tools.map((t) => t.function.name).sort(), ['mesh_sessions', 'mesh_status'], 'mesh_exec is never offered');
  assert.deepEqual([first.think, first.options.num_ctx, first.keep_alive, first.stream], [false, 16384, '30m', true]);
  assert.equal(first.messages[0].role, 'system');
  assert.match(second.messages.at(-1).content, /macbookpro/, 'the tool result goes back to the model');
  assert.equal(second.messages.at(-1).role, 'tool');
  assert.deepEqual([r.usage.inputTokens, r.usage.outputTokens, r.usage.costUsd, r.usage.model], [240, 24, 0, 'qwen3:8b']);
});

test('localTurn: the narration guard keeps the announcement as the opener and asks for the tool once', async () => {
  resetOllama({ script: [{ text: 'Let me check the mesh status.' }, { tool: 'mesh_status' }, { text: 'All online, sir.' }] });
  const deltas = [];
  const r = await R.localTurn({ text: 'How is the mesh doing?', settings: L(), emit: (e) => e.type === 'delta' && deltas.push(e.text) });
  assert.equal(r.text, 'Let me check the mesh status. All online, sir.');
  assert.equal(deltas.join(''), r.text, 'what was shown is the answer');
  assert.equal(ollama.chats.length, 3);
  assert.ok(ollama.chats[1].messages.some((m) => m.role === 'system' && m.content === R.NUDGE));
  // never twice in one turn
  resetOllama({ script: [{ text: 'Let me check.' }, { text: 'Let me check again.' }] });
  const r2 = await R.localTurn({ text: 'How is the mesh doing?', settings: L() });
  assert.equal(ollama.chats.length, 2);
  assert.equal(r2.text, 'Let me check. Let me check again.');
  // off with guard: false
  resetOllama({ script: [{ text: 'Let me check the mesh status.' }] });
  await R.localTurn({ text: 'How is the mesh doing?', settings: L({ guard: false }) });
  assert.equal(ollama.chats.length, 1);
});

test('localTurn: [[ESCALATE]] stays in the text; a tool outside the set or used-up rounds escalate', async () => {
  resetOllama({ script: [{ text: '[[ESCALATE]] building an app needs the full brain' }] });
  const r = await R.localTurn({ text: 'Please build me a small web app', settings: L() });
  assert.match(r.text, /^\[\[ESCALATE\]\] building an app/);
  resetOllama({ script: [{ tool: 'mesh_exec', args: { machine: 'x', command: 'rm -rf /' } }] });
  toolCalls.length = 0;
  const r2 = await R.localTurn({ text: 'clean up', settings: L() });
  assert.match(r2.escalate, /needs mesh_exec/);
  assert.equal(toolCalls.length, 0, 'never run');
  resetOllama({ script: [{ tool: 'mesh_status' }, { tool: 'mesh_status' }] });
  const r3 = await R.localTurn({ text: 'status?', settings: L({ maxRounds: 2 }) });
  assert.match(r3.escalate, /used up its 2 tool rounds/);
});

test('localTurn: unavailable before anything is shown — Ollama down, model missing, not loaded (warms), no first token, HTTP error', async () => {
  const url = config().brain.ollamaUrl;
  try {
    config().brain.ollamaUrl = 'http://127.0.0.1:9';
    assert.match((await R.localTurn({ text: 'hi', settings: L() })).unavailable, /not reachable/);
  } finally { config().brain.ollamaUrl = url; }
  resetOllama({ loaded: [], installed: [] });
  assert.match((await R.localTurn({ text: 'hi', settings: L() })).unavailable, /not installed in Ollama/);
  resetOllama({ loaded: [] });
  const cold = await R.localTurn({ text: 'hi', settings: L() });
  assert.match(cold.unavailable, /not loaded yet/);
  for (let i = 0; i < 50 && !ollama.warmups.length; i++) await sleep(10);
  assert.equal(ollama.warmups.length, 1, 'warms in the background');
  assert.deepEqual([ollama.warmups[0].options.num_predict, ollama.warmups[0].options.num_ctx, ollama.warmups[0].keep_alive], [1, 16384, '30m']);
  assert.equal(ollama.chats.length, 0, 'nothing asked of a cold model');
  resetOllama({ script: [{ delayMs: 800, text: 'late' }] });
  const t0 = Date.now();
  const slow = await R.localTurn({ text: 'hi', settings: L({ firstTokenMs: 200 }) });
  assert.match(slow.unavailable, /no first token from qwen3:8b within 200 ms/);
  assert.ok(Date.now() - t0 < 700);
  resetOllama({ script: [{ status: 500, body: 'error parsing tool call' }] });
  assert.match((await R.localTurn({ text: 'hi', settings: L() })).unavailable, /HTTP 500.*error parsing tool call/);
  resetOllama({ script: [{ text: 'Half an ans', errorAfter: 'runner died' }] });
  const broke = await R.localTurn({ text: 'hi', settings: L() });
  assert.deepEqual([broke.unavailable, broke.text], [undefined, 'Half an ans']);
  assert.match(broke.error, /runner died/, 'after text: an error, not unavailable');
});

// ---------------------------------------------------------------- another machine hosts the model

async function startHost() {
  const srv = http.createServer(async (req, res) => {
    let raw = '';
    for await (const c of req) raw += c;
    if (req.url !== '/api/local/responder/turn') { res.writeHead(404); return res.end('{}'); }
    res.writeHead(200, { 'content-type': 'application/x-ndjson' });
    await R.hostTurn(JSON.parse(raw), (e) => res.write(JSON.stringify(e) + '\n'), { soul: '' });
    res.end();
  });
  await new Promise((r) => srv.listen(0, '127.0.0.1', r));
  hosts.push(srv);
  return `http://127.0.0.1:${srv.address().port}`;
}

test('runResponder on another machine: the turn streams from the host; tools feed the trace; a host that is down or too old → unavailable', async () => {
  const hostUrl = await startHost();
  const peers = { 'gpu-box': { name: 'gpu-box', url: hostUrl, online: true, rigs: true }, asleep: { name: 'asleep', url: 'http://127.0.0.1:9', online: false, rigs: true }, old: { name: 'old', url: `${OLLAMA_URL}`, online: true, rigs: true } };
  R.setPeers((n) => peers[n] || null);
  try {
    resetOllama({ script: [{ tool: 'mesh_status' }, { text: 'Both online, sir.' }] });
    const events = [];
    const fed = [];
    const collector = { feed: (p, e) => fed.push([p, e.type]) };
    const fakeChat = { messages: [{ role: 'user', text: 'earlier' }, { role: 'assistant', text: 'earlier answer' }, { role: 'user', text: 'How is the mesh?' }] };
    const out = await R.runResponder(fakeChat, 'How is the mesh?', 'qwen3:8b', '', (e) => events.push(e), '', undefined, '', { tools: collector, local: L({ node: 'gpu-box' }), self: 'test-node' });
    assert.equal(out.text, 'Both online, sir.');
    assert.equal(out.error, null);
    assert.equal(out.usage.costUsd, 0);
    assert.deepEqual(events.map((e) => e.type).filter((t) => t !== 'delta'), ['tool'], 'the screen sees the tool, not its result');
    assert.deepEqual(fed, [['claude', 'assistant'], ['claude', 'user']], 'tool start and result feed the trace collector');
    assert.deepEqual(ollama.chats[0].messages.slice(1, 3).map((m) => m.content), ['earlier', 'earlier answer'], 'recent context went to the host');
    const down = await R.runResponder(fakeChat, 'x', 'qwen3:8b', '', () => {}, '', undefined, '', { local: L({ node: 'asleep' }), self: 'test-node' });
    assert.match(down.unavailable, /asleep is offline/);
    assert.match(down.error, /local responder unavailable/);
    const old = await R.runResponder(fakeChat, 'x', 'qwen3:8b', '', () => {}, '', undefined, '', { local: L({ node: 'old' }), self: 'test-node' });
    assert.match(old.unavailable, /does not serve the local responder/);
    assert.match((await R.runResponder(fakeChat, 'x', 'qwen3:8b', '', () => {}, '', undefined, '', { local: L({ node: 'nowhere' }), self: 'test-node' })).unavailable, /not in the mesh/);
    resetOllama({ loaded: [] });
    assert.match((await R.runResponder(fakeChat, 'x', 'qwen3:8b', '', () => {}, '', undefined, '', { local: L({ node: 'gpu-box' }), self: 'test-node' })).unavailable, /gpu-box: qwen3:8b is not loaded yet/);
  } finally { R.setPeers(null); }
});

test('hostTurn: a caller can narrow the tools but never widen them', async () => {
  resetOllama({ script: [{ text: 'Fine, sir.' }] });
  const events = [];
  await R.hostTurn({ text: 'hi', local: { tools: ['mesh_exec', 'mesh_sessions'] } }, (e) => events.push(e));
  assert.deepEqual(ollama.chats[0].tools.map((t) => t.function.name), ['mesh_sessions']);
  assert.deepEqual(events.at(-1).type, 'done');
});

// ---------------------------------------------------------------- the fast path end to end (jarvisSend → quickTurn)

test('feature off (the default): today’s Haiku turn exactly — no Ollama call, no local fields in events, ledger or trace', { skip: !posix && 'stand-in claude is a POSIX script' }, async () => {
  setQuick({ enabled: true, local: undefined });
  resetOllama();
  fs.rmSync(FAKE_LOG, { force: true });
  const events = [];
  const intake = trace.startSpan({ kind: 'intake', name: 'jarvis/send', input: 'what time is it in Tokyo' });
  const out = await chat.jarvisSend('what time is it in Tokyo', {}, (e) => events.push(e), { router: answerRouter, trace: intake.ctx, send: () => { throw new Error('the full brain must not run'); } });
  assert.equal(out.text, 'Haiku here, sir.');
  assert.equal(claudeRuns(), 1);
  assert.equal(ollama.chats.length + ollama.warmups.length, 0, 'Ollama untouched');
  const start = events.find((e) => e.type === 'start');
  assert.deepEqual(start, { type: 'start', brain: 'claude', model: 'claude-haiku-5-5', effort: 'low', lane: 'quick', tier: 'haiku' });
  assert.equal(events.find((e) => e.type === 'done').tier, 'haiku');
  const timing = events.find((e) => e.type === 'timing');
  assert.deepEqual(Object.keys(timing).sort(), ['filedBy', 'lane', 'preroute', 'route', 'routerMs', 'tier', 'timeToFiledMs', 'timeToReplyMs', 'type', 'via']);
  await trace.flush();
  const spans = await trace.readSpans({ traceId: intake.traceId });
  const bt = spans.find((s) => s.kind === 'brain-turn');
  assert.deepEqual(Object.keys(bt.meta).filter((k) => ['lane', 'tier', 'why', 'maxTurns', 'timeoutMs', 'local', 'node', 'claudeTier'].includes(k)).sort(), ['lane', 'maxTurns', 'tier', 'timeoutMs', 'why']);
  assert.ok(!spans.some((s) => s.name === 'responder-fallback'));
  const turn = await lastOf('chat-turn');
  assert.deepEqual([turn.lane, turn.provider, 'tier' in turn], ['quick', 'claude', false]);
  const req = await lastOf('request');
  assert.deepEqual([req.request.lane, req.request.tier, 'fallback' in req.request], ['quick', 'haiku', false]);
  // switched off explicitly behaves the same
  setLocal({ enabled: false });
  fs.rmSync(FAKE_LOG, { force: true });
  await chat.jarvisSend('what time is it in Tokyo', {}, () => {}, { router: answerRouter, send: () => { throw new Error('no'); } });
  assert.equal(claudeRuns(), 1);
  assert.equal(ollama.chats.length, 0);
});

test('feature on: an answer request runs on the local model — tier local in events, span, chat-turn and request records, cost 0', { skip: !posix && 'stand-in claude is a POSIX script' }, async () => {
  setLocal({});
  resetOllama({ script: [{ tool: 'mesh_status' }, { text: 'Both machines are online, sir.' }] });
  fs.rmSync(FAKE_LOG, { force: true });
  const main = await chat.mainChat();
  const before = main.messages.length;
  const events = [];
  const intake = trace.startSpan({ kind: 'intake', name: 'jarvis/send', input: 'How is the mesh doing?' });
  const out = await chat.jarvisSend('How is the mesh doing?', {}, (e) => events.push(e), { router: answerRouter, trace: intake.ctx, send: () => { throw new Error('the full brain must not run'); } });
  assert.equal(out.text, 'Both machines are online, sir.');
  assert.equal(claudeRuns(), 0, 'Haiku never ran');
  assert.deepEqual(events.find((e) => e.type === 'start'), { type: 'start', brain: 'ollama', model: 'qwen3:8b', effort: '', lane: 'quick', tier: 'local', node: 'test-node' });
  assert.equal(events.filter((e) => e.type === 'delta').map((e) => e.text).join(''), 'Both machines are online, sir.', 'streams through the same delta events');
  assert.deepEqual(events.filter((e) => e.type === 'tool').map((e) => e.name), ['mesh_status']);
  assert.equal(events.find((e) => e.type === 'done').tier, 'local');
  assert.equal(events.filter((e) => e.type === 'status' && e.reset).length, 0);
  const timing = events.find((e) => e.type === 'timing');
  assert.deepEqual([timing.lane, timing.tier, typeof timing.timeToReplyMs], ['quick', 'local', 'number']);
  await trace.flush();
  const spans = await trace.readSpans({ traceId: intake.traceId });
  const bt = spans.find((s) => s.kind === 'brain-turn');
  assert.deepEqual([bt.name, bt.meta.lane, bt.meta.tier, bt.meta.provider, bt.meta.model, bt.meta.costUsd, bt.status], ['ollama qwen3:8b', 'quick', 'local', 'ollama', 'qwen3:8b', 0, 'ok']);
  const tc = spans.find((s) => s.kind === 'tool-call' && s.parentId === bt.spanId);
  assert.equal(tc.name, 'mesh_status');
  assert.match(JSON.stringify(tc.output), /macbookpro/, 'the tool span has the real result');
  const turn = await lastOf('chat-turn');
  assert.deepEqual([turn.lane, turn.tier, turn.provider, turn.model, turn.costUsd, turn.inputTokens], ['quick', 'local', 'ollama', 'qwen3:8b', 0, 240]);
  const req = await lastOf('request');
  assert.deepEqual([req.request.lane, req.request.tier, req.status], ['quick', 'local', 'done']);
  assert.equal(typeof req.request.timeToReplyMs, 'number');
  const after = await chat.getChat(main.id);
  assert.deepEqual(after.messages.slice(before).map((m) => [m.role, m.brain || '', m.lane || '', m.tier || '']), [['user', '', '', ''], ['assistant', 'ollama', 'quick', 'local']]);
});

test('feature on: work requests still take the router path; a Claude tier on the request stays on Claude', { skip: !posix && 'stand-in claude is a POSIX script' }, async () => {
  setLocal({});
  resetOllama();
  fs.rmSync(FAKE_LOG, { force: true });
  const sent = [];
  await chat.jarvisSend('add a dark mode to szuf', {}, () => {}, { router: async () => ({ route: 'implement', via: 'jev', reason: 'work' }), send: fakeSend(sent) });
  assert.equal(sent.length, 1, 'the full brain, as today');
  assert.equal(ollama.chats.length, 0);
  await chat.jarvisSend('what time is it?', {}, () => {}, { router: answerRouter, send: fakeSend(sent), quick: 'haiku' });
  assert.equal(claudeRuns(), 1, 'quick: haiku = Claude Haiku');
  assert.equal(ollama.chats.length, 0);
  await chat.jarvisSend('what time is it?', {}, () => {}, { router: answerRouter, send: fakeSend(sent), quick: false });
  assert.equal(ollama.chats.length, 0, 'quick: false = the full brain');
  assert.equal(sent.length, 2);
});

test('quick: local on a request runs it locally even with the block off', { skip: !posix && 'stand-in claude is a POSIX script' }, async () => {
  setLocal(null);
  resetOllama({ script: [{ text: 'Canberra, sir.' }] });
  fs.rmSync(FAKE_LOG, { force: true });
  const out = await chat.jarvisSend('What is the capital of Australia?', {}, () => {}, { router: answerRouter, quick: 'local', send: () => { throw new Error('no'); } });
  assert.equal(out.text, 'Canberra, sir.');
  assert.equal(claudeRuns(), 0);
});

test('fallback: the local model can’t start → the Haiku turn answers once, nothing reset; the trace and request record say why', { skip: !posix && 'stand-in claude is a POSIX script' }, async () => {
  setLocal({ model: 'qwen3:missing' });
  resetOllama();
  fs.rmSync(FAKE_LOG, { force: true });
  const events = [];
  const sent = [];
  const intake = trace.startSpan({ kind: 'intake', name: 'jarvis/send', input: 'What is the capital of Australia?' });
  const out = await chat.jarvisSend('What is the capital of Australia?', {}, (e) => events.push(e), { router: answerRouter, trace: intake.ctx, send: fakeSend(sent) });
  assert.equal(out.text, 'Haiku here, sir.');
  assert.equal(claudeRuns(), 1, 'Haiku ran once');
  assert.equal(sent.length, 0, 'the full brain did not');
  assert.equal(ollama.chats.length, 0);
  assert.deepEqual(events.filter((e) => e.type === 'start').map((e) => [e.brain, e.tier]), [['ollama', 'local'], ['claude', 'haiku']]);
  assert.equal(events.filter((e) => e.type === 'status' && e.reset).length, 0, 'nothing was shown, nothing to reset');
  assert.equal(events.filter((e) => e.type === 'done').length, 1);
  assert.equal(events.find((e) => e.type === 'done').tier, 'haiku');
  await trace.flush();
  const spans = await trace.readSpans({ traceId: intake.traceId });
  const fb = spans.find((s) => s.name === 'responder-fallback');
  assert.match(fb.input.reason, /qwen3:missing is not installed/);
  assert.deepEqual(spans.filter((s) => s.kind === 'brain-turn').map((s) => [s.meta.tier, s.status]), [['local', 'error'], ['haiku', 'ok']]);
  const req = await lastOf('request');
  assert.deepEqual([req.request.tier, req.status], ['haiku', 'done']);
  assert.match(req.request.fallback, /not installed/);
  assert.match(req.outcome, /local responder unavailable/);
  const turns = (await usage.readRecords()).filter((r) => r.kind === 'chat-turn').slice(-2);
  assert.deepEqual(turns.map((t) => [t.provider, t.tier || '', t.status]), [['ollama', 'local', 'failed'], ['claude', '', 'done']]);
  assert.equal(turns[0].costUsd, 0, 'the attempt that could not start is filed at cost 0');
  // Ollama down, the same way
  const url = config().brain.ollamaUrl;
  setLocal({});
  fs.rmSync(FAKE_LOG, { force: true });
  try {
    config().brain.ollamaUrl = 'http://127.0.0.1:9';
    const o2 = await chat.jarvisSend('What is the capital of Australia?', {}, () => {}, { router: answerRouter, send: fakeSend(sent) });
    assert.equal(o2.text, 'Haiku here, sir.');
    assert.equal(claudeRuns(), 1);
    assert.match((await lastOf('request')).request.fallback, /not reachable/);
  } finally { config().brain.ollamaUrl = url; }
});

test('escalation: [[ESCALATE]] from the local model → the full brain once, nothing shown, Haiku never runs', { skip: !posix && 'stand-in claude is a POSIX script' }, async () => {
  setLocal({});
  resetOllama({ script: [{ text: '[[ESCALATE]] building an app needs the full brain' }] });
  fs.rmSync(FAKE_LOG, { force: true });
  const main = await chat.mainChat();
  const before = main.messages.length;
  const events = [];
  const sent = [];
  const intake = trace.startSpan({ kind: 'intake', name: 'jarvis/send', input: 'build' });
  await chat.jarvisSend('Please build me a small app that tracks my fuel expenses.', {}, (e) => events.push(e), { router: answerRouter, send: fakeSend(sent), trace: intake.ctx });
  assert.equal(sent.length, 1, 'the full brain answered');
  assert.match(sent[0].hint, /The fast path \(qwen3:8b\) handed this request to you: building an app needs the full brain/);
  assert.equal(claudeRuns(), 0, 'no Haiku in between');
  assert.equal(events.filter((e) => e.type === 'delta').length, 0, 'the marker never reached the screen');
  assert.equal(events.filter((e) => e.type === 'done').length, 1);
  assert.equal((await chat.getChat(main.id)).messages.length, before);
  const req = await lastOf('request');
  assert.deepEqual([req.request.tier, req.request.escalated], ['local', 'building an app needs the full brain']);
  await trace.flush();
  const esc = (await trace.readSpans({ traceId: intake.traceId })).find((s) => s.name === 'escalate');
  assert.deepEqual([esc.meta.tier, esc.meta.model], ['local', 'qwen3:8b']);
});

test('escalation: a failure after text → the full brain with reset; a tool outside the set → the full brain; never Haiku', { skip: !posix && 'stand-in claude is a POSIX script' }, async () => {
  setLocal({});
  fs.rmSync(FAKE_LOG, { force: true });
  const sent = [];
  resetOllama({ script: [{ text: 'Well, sir, the', errorAfter: 'runner died' }] });
  const events = [];
  await chat.jarvisSend('How is the mesh doing?', {}, (e) => events.push(e), { router: answerRouter, send: fakeSend(sent) });
  assert.equal(sent.length, 1);
  assert.equal(events.filter((e) => e.type === 'status' && e.reset).length, 1, 'the screen drops what the local model streamed');
  assert.match((await lastOf('request')).request.escalated, /the fast path failed: .*runner died/);
  resetOllama({ script: [{ tool: 'mesh_exec' }] });
  await chat.jarvisSend('Free some disk on magix', {}, () => {}, { router: answerRouter, send: fakeSend(sent) });
  assert.equal(sent.length, 2);
  assert.match((await lastOf('request')).request.escalated, /needs mesh_exec/);
  assert.equal(claudeRuns(), 0);
});

test('timeout: a local turn past quick.local.timeoutMs goes to the full brain', { skip: !posix && 'stand-in claude is a POSIX script' }, async () => {
  setLocal({ timeoutMs: 2000 });
  fs.rmSync(FAKE_LOG, { force: true });
  resetOllama({ script: [{ tool: 'mesh_status' }, { delayMs: 3000, text: 'late' }] });
  const sent = [];
  const t0 = Date.now();
  await chat.jarvisSend('How is the mesh doing?', {}, () => {}, { router: answerRouter, send: fakeSend(sent) });
  assert.ok(Date.now() - t0 < 2900, 'stopped at the local timeout');
  assert.equal(sent.length, 1);
  assert.match((await lastOf('request')).request.escalated, /timed out after 2 s/);
  assert.equal(claudeRuns(), 0);
});
