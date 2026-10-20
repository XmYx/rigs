// The quick-task fast path (src/quick.js → src/chat.js): the tier a request needs, config.quick and the per-request
// override, the escalation marker, jarvisSend's lane choice + measurement, and one real fast turn against a stand-in
// `claude` binary (flags, trace span, the thread left as it was). No model, no daemon.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { after, test } from 'node:test';

// A throwaway RIGS home and a stand-in `claude` first on PATH: never the real ~/.rigs or Claude.
const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'rigs-quick-'));
const BIN = path.join(TMP, 'bin');
fs.mkdirSync(BIN);
const FAKE_LOG = path.join(TMP, 'claude-args.jsonl');
fs.writeFileSync(path.join(BIN, 'claude'), `#!${process.execPath}
const fs = require('node:fs');
const args = process.argv.slice(2);
if (args[0] === '--version') { console.log('9.9.9 (Claude Code)'); process.exit(0); }
fs.appendFileSync(process.env.FAKE_CLAUDE_LOG, JSON.stringify(args) + '\\n');
const reply = process.env.FAKE_CLAUDE_REPLY || 'It is 9 pm in Tokyo, sir.';
const model = args[args.indexOf('--model') + 1];
const out = (o) => console.log(JSON.stringify(o));
out({ type: 'system', subtype: 'init', session_id: 'quick-sess-1' });
out({ type: 'assistant', session_id: 'quick-sess-1', message: { content: [{ type: 'tool_use', id: 'tu1', name: 'mcp__rigs__mesh_status', input: {} }] } });
out({ type: 'user', session_id: 'quick-sess-1', message: { content: [{ type: 'tool_result', tool_use_id: 'tu1', content: 'ok' }] } });
if (process.env.FAKE_CLAUDE_SLEEP) Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, Number(process.env.FAKE_CLAUDE_SLEEP));
if (process.env.FAKE_CLAUDE_MAX_TURNS) {
  out({ type: 'stream_event', session_id: 'quick-sess-1', event: { type: 'content_block_delta', delta: { type: 'text_delta', text: 'Let me check, sir.' } } });
  out({ type: 'result', subtype: 'error_max_turns', session_id: 'quick-sess-1', is_error: true, result: null, errors: ['Reached maximum number of turns (8)'] });
  process.exit(1);
}
for (const part of reply.match(/.{1,5}/gs)) out({ type: 'stream_event', session_id: 'quick-sess-1', event: { type: 'content_block_delta', delta: { type: 'text_delta', text: part } } });
out({ type: 'result', session_id: 'quick-sess-1', is_error: false, result: reply, total_cost_usd: 0.001,
  usage: { input_tokens: 10, output_tokens: 5 }, modelUsage: { [model]: { inputTokens: 10, outputTokens: 5 } } });
`, { mode: 0o755 });
Object.assign(process.env, {
  RIGS_HOME: path.join(TMP, 'rigs'), RIGS_NO_OPENRIG: '1', RIGS_NO_AUTOUPDATE: '1', RIGS_NO_MIGRATIONS: '1', RIGS_NAME: 'test-node',
  RIGS_OLLAMA_URL: 'http://127.0.0.1:9', PATH: BIN + path.delimiter + process.env.PATH, FAKE_CLAUDE_LOG: FAKE_LOG,
});
after(() => fs.rmSync(TMP, { recursive: true, force: true }));

const { config, saveConfig } = await import('../src/config.js');
const Q = await import('../src/quick.js');
const { claudeFlags } = await import('../src/models.js');
const chat = await import('../src/chat.js');
const usage = await import('../src/usage.js');
const trace = await import('../src/trace.js');

const setQuick = (patch) => { const c = config(); c.quick = { ...c.quick, ...patch }; saveConfig(c); };

// ---------------------------------------------------------------- the tier

test('quickTier: the sample requests', () => {
  assert.equal(Q.quickTier('what time is it in Tokyo'), 'haiku');
  assert.equal(Q.quickTier('search the web for the latest Node LTS'), 'sonnet');
  assert.equal(Q.quickTier('summarize this paragraph: The mesh has four machines. Two are busy with builds, one is idle and the laptop is asleep. Nothing failed today.'), 'haiku');
  assert.equal(Q.quickTier('write a short report of mesh load'), 'sonnet');
});

test('quickTier: lookups, single tool calls and short summaries stay on Haiku; research, steps and long text go to Sonnet', () => {
  for (const t of ['look up the IP of magix-system', 'is the merge steward running?', 'read ~/notes/todo.md', 'show the sessions on the linux machine', 'summarize session abc123', 'hi jarvis']) {
    assert.equal(Q.quickTier(t), 'haiku', t);
  }
  for (const t of ['compare the load on all machines', 'what is the latest news about Node 24?', 'check disk space on each machine and then tell me which is fullest', 'what runs on magix? and what is it doing?', 'analyze why the build is slow']) {
    assert.equal(Q.quickTier(t), 'sonnet', t);
  }
  const long = 'summarize this: ' + 'The quick brown fox jumps over the lazy dog. '.repeat(60);
  assert.equal(Q.quickTierWhy(long).tier, 'sonnet');
  assert.match(Q.quickTierWhy(long).why, /summary of \d+ chars/);
  // Words inside pasted material don't decide: only the instruction part does.
  assert.equal(Q.quickTier('summarize this: our quarterly report compares web search engines across every machine in the office.'), 'haiku');
  assert.equal(Q.askPart('tl;dr: ' + 'x'.repeat(100)), 'tl;dr');
  assert.equal(Q.askPart('what time is it: Tokyo'), 'what time is it: Tokyo', 'nothing pasted');
});

test('quickTier: a router/request hint wins', () => {
  assert.equal(Q.quickTier('write a short report of mesh load', { tier: 'haiku' }), 'haiku');
  assert.equal(Q.quickTier('what time is it', { quick: 'standard' }), 'sonnet');
  assert.equal(Q.quickTier('what time is it', { tier: 'gpt' }), 'haiku', 'an unknown hint is ignored');
  assert.deepEqual(Q.quickTierWhy('x', { tier: 'sonnet' }), { tier: 'sonnet', why: 'hint: sonnet' });
});

// ---------------------------------------------------------------- settings and override

test('config.quick: on by default with Haiku low / Sonnet medium; bad values fall back', () => {
  assert.deepEqual(Q.quickSettings(config().quick), {
    enabled: true, simple: { provider: 'claude', model: 'claude-haiku-5-5', effort: 'low' },
    standard: { provider: 'claude', model: 'claude-sonnet-5-5', effort: 'medium' }, maxTurns: 8, timeoutMs: 90000,
  });
  const s = Q.quickSettings({ enabled: 'nope', simple: { provider: 'codex', effort: 'ultra' }, standard: { model: 'opus' }, maxTurns: 999, timeoutMs: 'soon' });
  assert.equal(s.enabled, true);
  assert.deepEqual(s.simple, { provider: 'claude', model: 'claude-haiku-5-5', effort: 'low' });
  assert.equal(s.standard.model, 'opus');
  assert.equal(s.maxTurns, 50);
  assert.equal(s.timeoutMs, 90000);
  assert.equal(Q.quickSettings({ enabled: 'off' }).enabled, false);
});

test('applyQuickPatch validates and merges per tier', () => {
  assert.throws(() => Q.applyQuickPatch({}, { enabled: 'maybe' }), /enabled must be/);
  assert.throws(() => Q.applyQuickPatch({}, { simple: { provider: 'codex' } }), /simple.provider must be/);
  assert.throws(() => Q.applyQuickPatch({}, { standard: { effort: 'ultra' } }), /standard.effort must be/);
  assert.throws(() => Q.applyQuickPatch({}, { simple: { model: ' ' } }), /model must not be empty/);
  assert.throws(() => Q.applyQuickPatch({}, { maxTurns: 'lots' }), /maxTurns must be a number/);
  const next = Q.applyQuickPatch({ simple: { model: 'haiku' } }, { enabled: false, standard: { effort: 'high' } });
  assert.equal(next.enabled, false);
  assert.equal(next.simple.model, 'haiku', 'kept');
  assert.deepEqual(next.standard, { provider: 'claude', model: 'claude-sonnet-5-5', effort: 'high' });
});

test('quickOverride: true | false | haiku | sonnet, anything else = use config', () => {
  assert.equal(Q.quickOverride(true), true);
  assert.equal(Q.quickOverride('false'), false);
  assert.equal(Q.quickOverride(false), false);
  assert.equal(Q.quickOverride('Haiku'), 'haiku');
  assert.equal(Q.quickOverride('sonnet'), 'sonnet');
  assert.equal(Q.quickOverride('simple'), 'haiku');
  assert.equal(Q.quickOverride(undefined), undefined);
  assert.equal(Q.quickOverride('banana'), undefined);
});

test('resolveQuick: only "answer" requests, override beats config, other brains left alone', () => {
  const on = Q.resolveQuick({ text: 'what time is it in Tokyo', route: 'answer', settings: {} });
  assert.deepEqual(on, { on: true, tier: 'haiku', why: 'a quick time', provider: 'claude', model: 'claude-haiku-5-5', effort: 'low', maxTurns: 8, timeoutMs: 90000, forced: false });
  const report = Q.resolveQuick({ text: 'write a short report of mesh load', route: 'answer', brain: 'claude', settings: {} });
  assert.equal(report.model, 'claude-sonnet-5-5');
  assert.equal(report.effort, 'medium');
  for (const route of ['implement', 'plan', 'continue', '']) assert.equal(Q.resolveQuick({ text: 'x', route, settings: {} }).on, false, route);
  assert.equal(Q.resolveQuick({ text: 'x', route: 'implement', override: true, settings: {} }).on, false, 'never for work, even forced');
  assert.deepEqual(Q.resolveQuick({ text: 'x', route: 'answer', override: false, settings: {} }), { on: false, reason: 'quick: false on this request' });
  assert.equal(Q.resolveQuick({ text: 'x', route: 'answer', settings: { enabled: false } }).on, false);
  assert.equal(Q.resolveQuick({ text: 'x', route: 'answer', override: true, settings: { enabled: false } }).on, true, 'quick: true beats config');
  assert.equal(Q.resolveQuick({ text: 'x', route: 'answer', brain: 'codex', settings: {} }).on, false, 'the Codex brain stays untouched');
  assert.equal(Q.resolveQuick({ text: 'x', route: 'answer', brain: 'claude-ollama', settings: {} }).reason, 'the claude-ollama brain was asked for');
  const forced = Q.resolveQuick({ text: 'what time is it', route: 'answer', override: 'sonnet', settings: { standard: { model: 'sonnet' } } });
  assert.deepEqual([forced.tier, forced.model, forced.effort, forced.forced], ['sonnet', 'sonnet', 'medium', true]);
});

test('quickBrain maps a tier through the catalog', () => {
  const brains = [{ id: 'claude', efforts: ['low', 'medium', 'high'], default: 'claude-opus-5-5' }, { id: 'claude-ollama', available: false, efforts: [] }];
  assert.deepEqual(Q.quickBrain({ provider: 'claude', model: 'claude-haiku-5-5', effort: 'low' }, brains), { brain: 'claude', model: 'claude-haiku-5-5', effort: 'low' });
  assert.equal(Q.quickBrain({ provider: 'claude', model: 'm', effort: 'max' }, brains).effort, '', 'an effort the provider lacks is dropped');
  assert.equal(Q.quickBrain({ provider: 'claude', model: 'm' }, []), null, 'no claude here');
  assert.deepEqual(claudeFlags({ model: 'claude-haiku-5-5', effort: 'low', maxTurns: 8 }), ['--model', 'claude-haiku-5-5', '--effort', 'low', '--max-turns', '8']);
  assert.deepEqual(claudeFlags({ model: 'opus', effort: 'high' }), ['--model', 'opus', '--effort', 'high'], 'unchanged without maxTurns');
});

test('escalation: the marker is found, held back from the screen and swallowed', () => {
  assert.deepEqual(Q.parseEscalation('[[ESCALATE]] needs a long investigation'), { reason: 'needs a long investigation' });
  assert.deepEqual(Q.parseEscalation('  [[escalate]]'), { reason: 'needs the full brain' });
  assert.equal(Q.parseEscalation('It is 9 pm, sir.'), null);
  const seen = [];
  const g = Q.escalationGate((e) => seen.push(e));
  for (const t of [' [[ES', 'CAL', 'ATE]] too', ' deep']) g.emit({ type: 'delta', text: t });
  g.emit({ type: 'tool', name: 'x' });
  g.flush();
  assert.equal(g.escalating, true);
  assert.deepEqual(seen, [{ type: 'tool', name: 'x' }], 'no text reached the screen');
  const seen2 = [];
  const g2 = Q.escalationGate((e) => seen2.push(e));
  for (const t of ['[', 'It is', ' 9 pm']) g2.emit({ type: 'delta', text: t });
  g2.flush();
  assert.deepEqual(seen2.map((e) => e.text).join(''), '[It is 9 pm');
  const seen3 = [];
  const g3 = Q.escalationGate((e) => seen3.push(e));
  g3.emit({ type: 'delta', text: '[[' });
  g3.flush();
  assert.equal(seen3[0].text, '[[', 'a short reply that only looked like the marker is released at the end');
});

// ---------------------------------------------------------------- jarvisSend: lane choice and measurement

const answerRouter = async () => ({ route: 'answer', via: 'jev', reason: 'a question' });
function fakeSend(sent) {
  return async (chatId, msg, emit, opts) => {
    sent.push({ chatId, text: msg.text, hint: opts.hint });
    emit({ type: 'done', text: 'Full brain here, sir.', chatId });
    return { text: 'Full brain here, sir.' };
  };
}
function fakeQuick(calls, result) {
  return async (chatId, text, q, emit) => {
    calls.push({ chatId, text, q });
    if (result.escalate) return result;
    emit({ type: 'done', text: result.text, chatId, lane: 'quick' });
    return result;
  };
}
const requestRecords = async () => (await usage.readRecords()).filter((r) => r.kind === 'request');

test('an "answer" request takes the fast path: no full-brain turn, lane quick in timing, ledger and trace', async () => {
  setQuick({ enabled: true });
  const sent = [];
  const calls = [];
  const events = [];
  const intake = trace.startSpan({ kind: 'intake', name: 'jarvis/send', input: 'what time is it in Tokyo' });
  const out = await chat.jarvisSend('what time is it in Tokyo', { brain: 'claude', model: 'claude-opus-5-5' }, (e) => events.push(e),
    { router: answerRouter, send: fakeSend(sent), sendQuick: fakeQuick(calls, { text: '9 pm, sir.' }), trace: intake.ctx });
  assert.equal(out.text, '9 pm, sir.');
  assert.equal(sent.length, 0, 'the full brain never ran');
  assert.equal(calls.length, 1);
  assert.deepEqual([calls[0].q.tier, calls[0].q.model, calls[0].q.effort], ['haiku', 'claude-haiku-5-5', 'low']);
  const timing = events.find((e) => e.type === 'timing');
  assert.deepEqual([timing.lane, timing.tier, timing.escalated], ['quick', 'haiku', undefined]);
  assert.ok(timing.timeToReplyMs >= 0);
  const rec = (await requestRecords()).at(-1);
  assert.equal(rec.lane, 'quick');
  assert.equal(rec.request.lane, 'quick');
  assert.equal(rec.request.tier, 'haiku');
  assert.ok(rec.request.timeToReplyMs >= 0);
  assert.match(rec.outcome, /fast path haiku/);
});

test('quick: false (per request or config) restores the previous path exactly', async () => {
  setQuick({ enabled: true });
  const sent = [];
  const calls = [];
  const events = [];
  await chat.jarvisSend('what time is it?', {}, (e) => events.push(e), { router: answerRouter, send: fakeSend(sent), sendQuick: fakeQuick(calls, { text: 'x' }), quick: false });
  setQuick({ enabled: false });
  await chat.jarvisSend('what time is it?', {}, (e) => events.push(e), { router: answerRouter, send: fakeSend(sent), sendQuick: fakeQuick(calls, { text: 'x' }) });
  assert.equal(calls.length, 0);
  assert.equal(sent.length, 2);
  assert.match(sent[0].hint, /^\[routed: answer · a question\]$/, 'the same hint as before');
  const timings = events.filter((e) => e.type === 'timing');
  assert.deepEqual(Object.keys(timings[0]).sort(), ['filedBy', 'preroute', 'route', 'routerMs', 'timeToFiledMs', 'timeToReplyMs', 'type', 'via'], 'no lane fields');
  const recs = (await requestRecords()).slice(-2);
  assert.ok(recs.every((r) => !r.lane && !r.request.lane));
  // quick: 'sonnet' forces the fast path on although config says off.
  await chat.jarvisSend('what time is it?', {}, () => {}, { router: answerRouter, send: fakeSend(sent), sendQuick: fakeQuick(calls, { text: 'x' }), quick: 'sonnet' });
  assert.equal(calls.at(-1).q.model, 'claude-sonnet-5-5');
  setQuick({ enabled: true });
});

test('work requests and pre-routing off never take the fast path', async () => {
  const sent = [];
  const calls = [];
  await chat.jarvisSend('add a dark mode to szuf', {}, () => {}, { router: async () => ({ route: 'implement', via: 'jev', reason: 'work' }), send: fakeSend(sent), sendQuick: fakeQuick(calls, { text: 'x' }) });
  await chat.jarvisSend('what time is it?', {}, () => {}, { router: answerRouter, send: fakeSend(sent), sendQuick: fakeQuick(calls, { text: 'x' }), preroute: false });
  await chat.jarvisSend('what time is it?', { brain: 'codex' }, () => {}, { router: answerRouter, send: fakeSend(sent), sendQuick: fakeQuick(calls, { text: 'x' }) });
  assert.equal(calls.length, 0);
  assert.equal(sent.length, 3);
});

test('a request that names no brain follows the thread: a JARVIS thread on Codex / Claude via Ollama keeps its brain', async () => {
  const main = await chat.mainChat();
  const sent = [];
  const calls = [];
  for (const b of ['codex', 'claude-ollama']) {
    await fs.promises.writeFile(path.join(process.env.RIGS_HOME, 'chats', main.id + '.json'), JSON.stringify({ ...main, brain: b }));
    await chat.jarvisSend('what time is it?', {}, () => {}, { router: answerRouter, send: fakeSend(sent), sendQuick: fakeQuick(calls, { text: 'x' }) });
  }
  assert.equal(calls.length, 0);
  assert.equal(sent.length, 2);
  await fs.promises.writeFile(path.join(process.env.RIGS_HOME, 'chats', main.id + '.json'), JSON.stringify(main));
});

test('escalation: the request re-runs on the full brain, told why and what already ran; an escalate event span', async () => {
  const sent = [];
  const calls = [];
  const events = [];
  const intake = trace.startSpan({ kind: 'intake', name: 'jarvis/send', input: 'why is the build slow' });
  const out = await chat.jarvisSend('why is the build slow', {}, (e) => events.push(e), { router: answerRouter, send: fakeSend(sent), trace: intake.ctx,
    sendQuick: fakeQuick(calls, { escalate: 'needs a long investigation', ran: true, tools: ['mcp__rigs__mesh_status {}'] }) });
  assert.equal(out.text, 'Full brain here, sir.');
  assert.equal(sent.length, 1);
  assert.match(sent[0].hint, /^\[routed: answer · a question\]\n\[The fast path \(claude-haiku-5-5\) handed this request to you: needs a long investigation\. It already ran: mcp__rigs__mesh_status \{\}/);
  const timing = events.find((e) => e.type === 'timing');
  assert.deepEqual([timing.lane, timing.escalated], ['quick', 'needs a long investigation']);
  assert.ok(events.find((e) => e.type === 'status' && /full brain/.test(e.text)).reset, 'the screen drops what the fast turn streamed');
  await trace.flush();
  const ev = (await trace.readSpans({ traceId: intake.traceId })).find((s) => s.kind === 'event' && s.name === 'escalate');
  assert.equal(ev.meta.lane, 'quick');
  assert.equal(ev.input.reason, 'needs a long investigation');
  const rec = (await requestRecords()).at(-1);
  assert.equal(rec.request.escalated, 'needs a long investigation');
  assert.match(rec.outcome, /→ full brain/);
});

// ---------------------------------------------------------------- a real fast turn (stand-in claude binary)

const posix = process.platform !== 'win32';

test('quickTurn runs one bounded claude turn on the tier model; brain-turn span lane quick; the thread keeps its brain and session', { skip: !posix && 'stand-in claude is a POSIX script' }, async () => {
  setQuick({ enabled: true });
  const main = await chat.mainChat();
  Object.assign(main, { brain: 'claude', model: 'claude-opus-5-5', effort: 'high', claudeSessionId: 'main-session' });
  main.messages.push({ role: 'user', text: 'earlier question', ts: 1 }, { role: 'assistant', text: 'earlier answer', brain: 'claude', ts: 2 });
  main.seen = { claude: main.messages.length };
  await fs.promises.writeFile(path.join(process.env.RIGS_HOME, 'chats', main.id + '.json'), JSON.stringify(main));
  fs.rmSync(FAKE_LOG, { force: true });
  const events = [];
  const intake = trace.startSpan({ kind: 'intake', name: 'jarvis/send', input: 'what time is it in Tokyo' });
  const out = await chat.jarvisSend('what time is it in Tokyo', { brain: 'claude', model: 'claude-opus-5-5' }, (e) => events.push(e), { router: answerRouter, trace: intake.ctx, send: () => { throw new Error('the full brain must not run'); } });
  assert.equal(out.text, 'It is 9 pm in Tokyo, sir.');
  const args = fs.readFileSync(FAKE_LOG, 'utf8').trim().split('\n').map((l) => JSON.parse(l));
  assert.equal(args.length, 1, 'one claude run');
  const a = args[0];
  assert.equal(a[a.indexOf('--model') + 1], 'claude-haiku-5-5');
  assert.equal(a[a.indexOf('--effort') + 1], 'low');
  assert.equal(a[a.indexOf('--max-turns') + 1], '8');
  assert.ok(!a.includes('--resume'), 'a fresh session');
  assert.match(a[a.indexOf('--append-system-prompt') + 1], /# Fast path[\s\S]*\[\[ESCALATE\]\]/);
  assert.match(a[a.indexOf('--append-system-prompt') + 1], /J\.A\.R\.V\.I\.S\./, 'in character');
  // (the work request an earlier test routed to implement is mirrored into the thread before these)
  assert.match(a[1], /Recently in this conversation:\n(?:.*\n)*User: earlier question\nJARVIS: earlier answer\n\nNow the user says:\n/);
  assert.equal(events.filter((e) => e.type === 'delta').map((e) => e.text).join(''), 'It is 9 pm in Tokyo, sir.');
  assert.equal(events.find((e) => e.type === 'start').lane, 'quick');
  await trace.flush();
  const spans = await trace.readSpans({ traceId: intake.traceId });
  const bt = spans.find((s) => s.kind === 'brain-turn');
  assert.deepEqual([bt.meta.lane, bt.meta.tier, bt.meta.model, bt.meta.effort, bt.status], ['quick', 'haiku', 'claude-haiku-5-5', 'low', 'ok']);
  assert.ok(spans.some((s) => s.kind === 'tool-call' && s.name === 'mcp__rigs__mesh_status' && s.parentId === bt.spanId));
  assert.ok(!spans.some((s) => s.kind === 'handoff'), 'no project or task filed');
  const after = await chat.getChat(main.id);
  assert.deepEqual([after.brain, after.model, after.effort, after.claudeSessionId], ['claude', 'claude-opus-5-5', 'high', 'main-session'], 'the thread keeps its full brain');
  assert.equal(after.quickSessionId, 'quick-sess-1');
  assert.deepEqual(after.messages.slice(-2).map((m) => [m.role, m.text, m.lane || '']), [['user', 'what time is it in Tokyo', ''], ['assistant', 'It is 9 pm in Tokyo, sir.', 'quick']]);
  assert.equal(after.seen.claude, after.messages.length - 2, 'the full brain will be told about the fast answer next turn');
  const turn = (await usage.readRecords()).filter((r) => r.kind === 'chat-turn').at(-1);
  assert.deepEqual([turn.lane, turn.model, turn.effort], ['quick', 'claude-haiku-5-5', 'low']);
});

test('quickTurn: the fast brain asks for the full brain → nothing shown, nothing kept, the request re-runs', { skip: !posix && 'stand-in claude is a POSIX script' }, async () => {
  process.env.FAKE_CLAUDE_REPLY = '[[ESCALATE]] needs a long investigation';
  try {
    const main = await chat.mainChat();
    const before = main.messages.length;
    const sent = [];
    const events = [];
    await chat.jarvisSend('why is every build slow this week', {}, (e) => events.push(e), { router: answerRouter, send: fakeSend(sent) });
    assert.equal(sent.length, 1, 'the full brain answered');
    assert.match(sent[0].hint, /handed this request to you: needs a long investigation\. It already ran: mcp__rigs__mesh_status/);
    assert.equal(events.filter((e) => e.type === 'delta').length, 0, 'the marker never reached the screen');
    assert.equal(events.filter((e) => e.type === 'done').length, 1, 'only the full brain finished');
    assert.equal((await chat.getChat(main.id)).messages.length, before, 'the fast turn left nothing in the thread (the fake full brain writes nothing)');
  } finally { delete process.env.FAKE_CLAUDE_REPLY; }
});

test('quickTurn: a fast turn that runs past timeoutMs is stopped and handed to the full brain', { skip: !posix && 'stand-in claude is a POSIX script' }, async () => {
  process.env.FAKE_CLAUDE_SLEEP = '3000';
  try {
    const main = await chat.mainChat();
    const before = main.messages.length;
    const q = { ...Q.resolveQuick({ text: 'what time is it', route: 'answer', settings: {} }), timeoutMs: 300 };
    const t0 = Date.now();
    const r = await chat.quickTurn(main.id, 'what time is it', q, () => {});
    assert.ok(Date.now() - t0 < 2500, 'stopped at the timeout, not when claude finished');
    assert.equal(r.escalate, 'the fast path timed out after 0 s');
    assert.equal((await chat.getChat(main.id)).messages.length, before);
  } finally { delete process.env.FAKE_CLAUDE_SLEEP; }
});

test('quickTurn: a fast turn that hits --max-turns is handed over with the reason; it shows on the dashboard while it runs', { skip: !posix && 'stand-in claude is a POSIX script' }, async () => {
  process.env.FAKE_CLAUDE_MAX_TURNS = '1';
  try {
    const main = await chat.mainChat();
    const before = main.messages.length;
    const q = Q.resolveQuick({ text: 'how loaded is magix?', route: 'answer', settings: {} });
    let seenActive = null;
    const r = await chat.quickTurn(main.id, 'how loaded is magix?', q, (e) => { if (e.type === 'delta') seenActive = chat.activeTurns.get(main.id); });
    assert.equal(r.escalate, 'the fast path failed: Reached maximum number of turns (8)');
    assert.deepEqual([seenActive?.lane, seenActive?.model], ['quick', 'claude-haiku-5-5'], 'listed as JARVIS answering');
    assert.ok(!chat.activeTurns.has(main.id), 'cleared before the full brain re-runs');
    assert.equal((await chat.getChat(main.id)).messages.length, before);
  } finally { delete process.env.FAKE_CLAUDE_MAX_TURNS; }
});
