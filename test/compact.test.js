// Self-compaction of the JARVIS main thread (src/compact.js, chat.compactChat): the context size taken from the last
// API call (a real `claude -p` result event), the threshold maths, the summary call and the fresh session it seeds,
// the failure path, a stale save that must not undo a compaction, and the Conversation window's divider rows.
// A stand-in `claude` logs every prompt; the summary call (`--no-session-persistence`) reads its prompt on stdin.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { after, test } from 'node:test';

const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'rigs-compact-'));
const BIN = path.join(TMP, 'bin');
fs.mkdirSync(BIN);
const FAKE_LOG = path.join(TMP, 'claude-args.jsonl');
// A brain turn replies "Re: <request>" and reports a context of FAKE_CTX tokens in its last call (and 4M cumulative
// cache reads in modelUsage, like the live thread). The summary call echoes the FACT lines it was given.
fs.writeFileSync(path.join(BIN, 'claude'), `#!${process.execPath}
const fs = require('node:fs');
const args = process.argv.slice(2);
if (args[0] === '--version') { console.log('9.9.9 (Claude Code)'); process.exit(0); }
const out = (o) => console.log(JSON.stringify(o));
if (args.includes('--no-session-persistence')) {
  const stdin = fs.readFileSync(0, 'utf8');
  fs.appendFileSync(process.env.FAKE_CLAUDE_LOG, JSON.stringify({ summary: true, args, stdin }) + '\\n');
  if (process.env.FAKE_SUMMARY_FAIL) { out({ type: 'result', is_error: true, result: 'Overloaded' }); process.exit(1); }
  const facts = stdin.split('\\n').filter((l) => l.includes('FACT')).map((l) => '- ' + l.replace(/^.*?: /, ''));
  out({ type: 'result', subtype: 'success', is_error: false, num_turns: 1, session_id: 'sum', result: '## Facts to remember\\n' + facts.join('\\n'), total_cost_usd: 0.01,
    usage: { input_tokens: 900, output_tokens: 80, cache_read_input_tokens: 0, cache_creation_input_tokens: 0 }, modelUsage: { 'claude-sonnet-5-5': { inputTokens: 900, outputTokens: 80 } } });
  process.exit(0);
}
fs.appendFileSync(process.env.FAKE_CLAUDE_LOG, JSON.stringify(args) + '\\n');
const r = args.indexOf('--resume');
const sid = r >= 0 ? args[r + 1] : 'sess-' + Math.random().toString(36).slice(2, 8);
const reply = 'Re: ' + args[1].split('\\n').at(-1);
const ctx = Number(process.env.FAKE_CTX || 5000);
const call = { input_tokens: 3, cache_read_input_tokens: ctx - 103, cache_creation_input_tokens: 100, output_tokens: 7 };
out({ type: 'system', subtype: 'init', session_id: sid });
out({ type: 'assistant', session_id: sid, message: { content: [{ type: 'text', text: reply }], usage: call } });
out({ type: 'stream_event', session_id: sid, event: { type: 'content_block_delta', delta: { type: 'text_delta', text: reply } } });
out({ type: 'result', session_id: sid, is_error: false, num_turns: 2, result: reply, total_cost_usd: 0.001,
  usage: { input_tokens: 9, output_tokens: 20, cache_read_input_tokens: 2 * ctx, cache_creation_input_tokens: 400, iterations: [{ ...call, type: 'message' }] },
  modelUsage: { 'claude-opus-5-5': { inputTokens: 9000, outputTokens: 2000, cacheReadInputTokens: 4000000, cacheCreationInputTokens: 90000 } } });
`, { mode: 0o755 });
Object.assign(process.env, {
  RIGS_HOME: path.join(TMP, 'rigs'), RIGS_NO_OPENRIG: '1', RIGS_NO_AUTOUPDATE: '1', RIGS_NO_MIGRATIONS: '1', RIGS_NAME: 'test-node',
  RIGS_OLLAMA_URL: 'http://127.0.0.1:9', PATH: BIN + path.delimiter + process.env.PATH, FAKE_CLAUDE_LOG: FAKE_LOG,
});
after(() => fs.rmSync(TMP, { recursive: true, force: true }));

const { config, saveConfig } = await import('../src/config.js');
const C = await import('../src/compact.js');
const M = await import('../src/main-chat.js');
const chat = await import('../src/chat.js');
const { transcriptRows, compactedLabel } = await import('../ui/src/compact-model.js');

const posix = process.platform !== 'win32';
const CLAUDE = { brain: 'claude', model: 'claude-opus-5-5', effort: 'high' };
const log = () => (fs.existsSync(FAKE_LOG) ? fs.readFileSync(FAKE_LOG, 'utf8').trim().split('\n').filter(Boolean).map((l) => JSON.parse(l)) : []);
const turns = () => log().filter((x) => Array.isArray(x));
const summaries = () => log().filter((x) => x.summary);
const msg = (role, text, extra = {}) => ({ role, text, ts: 0, ...extra });
const setCompact = (patch) => { const c = config(); c.brain = { ...c.brain, compact: { ...C.compactSettings(c.brain.compact), ...patch } }; saveConfig(c); };

// A real `claude -p --output-format stream-json` result (Haiku, three calls in one turn: two Bash tool calls, a reply).
const REAL_RESULT = { type: 'result', subtype: 'success', is_error: false, num_turns: 3, session_id: 'ebceb6b6-c4f3-4280-a94e-37e944e96170', total_cost_usd: 0.00497958,
  usage: { input_tokens: 6, cache_creation_input_tokens: 20878, cache_read_input_tokens: 72638, output_tokens: 154, output_tokens_details: { thinking_tokens: 0 },
    server_tool_use: { web_search_requests: 0, web_fetch_requests: 0 }, service_tier: 'standard', cache_creation: { ephemeral_1h_input_tokens: 20878, ephemeral_5m_input_tokens: 0 },
    inference_geo: 'global', iterations: [{ input_tokens: 2, output_tokens: 4, cache_read_input_tokens: 32470, cache_creation_input_tokens: 105, cache_creation: { ephemeral_5m_input_tokens: 0, ephemeral_1h_input_tokens: 105 }, type: 'message' }],
    speed: 'standard', fallback_credit: null },
  modelUsage: { 'claude-haiku-5-5': { inputTokens: 6, outputTokens: 154, cacheReadInputTokens: 72638, cacheCreationInputTokens: 20878, webSearchRequests: 0, costUSD: 0.00497958, contextWindow: 1000000, maxOutputTokens: 128000 } },
  result: 'ok', duration_ms: 5372 };

// ---------------------------------------------------------------- usage maths (pure)

test('contextTokens: the last API call of a real result, not the turn sum or the session totals', () => {
  assert.equal(C.contextTokens(REAL_RESULT), 2 + 32470 + 105);
  const summed = 6 + 72638 + 20878;
  assert.notEqual(C.contextTokens(REAL_RESULT), summed);
  // without iterations: the last assistant event's usage; a one-call turn's usage is that call's; else unknown
  const noIter = { ...REAL_RESULT, usage: { ...REAL_RESULT.usage, iterations: undefined } };
  assert.equal(C.contextTokens(noIter, { input_tokens: 2, cache_read_input_tokens: 28471, cache_creation_input_tokens: 3999 }), 32472);
  assert.equal(C.contextTokens(noIter), null);
  assert.equal(C.contextTokens({ type: 'result', num_turns: 1, usage: { input_tokens: 5, cache_read_input_tokens: 1000, cache_creation_input_tokens: 50 } }), 1055);
  assert.equal(C.contextTokens({ type: 'result', usage: { input_tokens: 5, iterations: [{ input_tokens: 1, type: 'compaction' }] } }, { input_tokens: 77 }), 77);
});

test('compactSettings / applyCompactPatch: defaults, validation', () => {
  assert.deepEqual(C.compactSettings(), C.COMPACT_DEFAULTS);
  assert.deepEqual(C.compactSettings({ atTokens: 5, keepMessages: -1, model: '', enabled: 'yes' }), C.COMPACT_DEFAULTS);
  assert.equal(C.applyCompactPatch({}, { atTokens: 20000 }).atTokens, 20000);
  assert.equal(C.applyCompactPatch({ atTokens: 20000 }, { enabled: false }).atTokens, 20000);
  assert.throws(() => C.applyCompactPatch({}, { atTokens: 'lots' }), /atTokens/);
  assert.throws(() => C.applyCompactPatch({}, { keepMessages: 500 }), /keepMessages/);
  assert.equal(config().brain.compact.atTokens, 100000); // the config default
});

test('compactionCut / needsCompaction: the threshold on the live session, the last keepMessages conversation messages kept', () => {
  const messages = [];
  for (let i = 0; i < 10; i++) messages.push(msg(i % 2 ? 'assistant' : 'user', `m${i}`), msg('assistant', `report ${i}`, { report: true, brain: 'rigs' }));
  const c = { messages, claudeSessionId: 's1', context: { claude: { tokens: 99999, sessionId: 's1' } }, claudeUsage: { sessionId: 's1', models: { x: { cacheReadTokens: 4e6 } } } };
  // the last 4 conversation messages are m6..m9: the cut is at m6 (index 12); reports after it stay too
  assert.equal(C.compactionCut(c, 4), 12);
  assert.equal(C.compactionCut(c, 0), 20);
  assert.equal(C.compactionCut(c, 50), 0);
  const s = { atTokens: 100000, keepMessages: 4 };
  assert.equal(C.needsCompaction(c, 'claude', s), false, 'one token short');
  c.context.claude.tokens = 100000;
  assert.equal(C.needsCompaction(c, 'claude', s), true);
  assert.equal(C.needsCompaction(c, 'claude', { ...s, enabled: false }), false);
  assert.equal(C.needsCompaction({ ...c, claudeSessionId: 's2' }, 'claude', s), false, 'measured on a session that is gone');
  assert.equal(C.needsCompaction(c, 'claude', { ...s, keepMessages: 50 }), false, 'nothing to summarise');
  assert.equal(C.needsCompaction({ ...c, compaction: { summary: 'x', upto: 12 } }, 'claude', s), false, 'nothing new since the last cut');
  assert.equal(C.needsCompaction(c, 'codex', s), false);
  // a session that starts near the threshold (persona + tools + a seeded summary) is not compacted after every turn
  const near = (tokens, start) => ({ ...c, context: { claude: { tokens, start, sessionId: 's1' } } });
  assert.equal(C.needsCompaction(near(100500, 99000), 'claude', s), false, 'grown less than 10% of atTokens since its first turn');
  assert.equal(C.needsCompaction(near(109000, 99000), 'claude', s), true);
  assert.equal(C.needsCompaction(near(100000, 40000), 'claude', s), true);
  const low = { ...s, atTokens: 30000 }; // under a fresh session's size: a late MCP server's tools (+4k) is not a reason
  assert.equal(C.needsCompaction(near(42000, 37800), 'claude', low), false, 'less than MIN_GROWTH.tokens');
  assert.equal(C.needsCompaction(near(46000, 37800), 'claude', low), true);
});

test('summaryPrompt: previous summary + the stretch to the cut, bounded with the newest kept', () => {
  const messages = [msg('user', 'old'), msg('user', 'FACT one'), msg('assistant', 'r'.repeat(5000), { report: true }), msg('user', 'kept')];
  const p = C.summaryPrompt({ messages, compaction: { summary: 'Earlier: Sir likes tea.', upto: 1 } }, 3);
  assert.match(p.prompt, /^Summary of the conversation before this stretch:\nEarlier: Sir likes tea\./);
  assert.match(p.prompt, /User: FACT one/);
  assert.doesNotMatch(p.prompt, /User: old|User: kept/);
  assert.ok(p.prompt.includes('RIGS report: ' + 'r'.repeat(599) + '…'), 'reports cut to 600 chars');
  const big = C.summaryPrompt({ messages: Array.from({ length: 100 }, (_, i) => msg('user', `n${i} ` + 'z'.repeat(3000))) }, 100, { totalChars: 20000 });
  assert.ok(big.prompt.length < 21000 && big.omitted > 0 && /the \d+ oldest left out/.test(big.prompt) && big.prompt.includes('User: n99'));
});

test('applyCompaction seeds a fresh session: summary + the kept messages, sessions dropped, nothing deleted', () => {
  const messages = [msg('user', 'FACT: the cat is Pixel'), msg('assistant', 'noted'), msg('user', 'q2'), msg('assistant', 'a2'), msg('user', 'q3'), msg('assistant', 'a3')];
  const c = { messages: [...messages], claudeSessionId: 'old', codexThreadId: 'th', seen: { claude: 6, codex: 2 }, context: { claude: { tokens: 120000, sessionId: 'old' } } };
  C.applyCompaction(c, { summary: '- the cat is Pixel', upto: 2, tokensBefore: 120000, model: 'm', brain: 'claude', ts: 1000 });
  assert.equal(c.messages.length, 6);
  assert.equal(c.claudeSessionId, null);
  assert.equal(c.codexThreadId, null);
  assert.deepEqual(c.compaction.sessions, { claudeSessionId: 'old', codexThreadId: 'th' });
  assert.deepEqual(c.seen, { claude: 2, codex: 2 });
  assert.deepEqual(c.context, {});
  assert.deepEqual(c.compactions, [{ ts: 1000, tokensBefore: 120000, upto: 2, model: 'm', brain: 'claude', reason: 'auto', chars: 18 }]);
  c.messages.push(msg('user', 'now'));
  const seed = M.unseenContext(c, 'claude', { withSummary: true });
  assert.match(seed, /^Summary of the conversation before this \(compacted\):\n- the cat is Pixel\n\nThe conversation since that summary:\nUser: q2\nJARVIS: a2\nUser: q3\nJARVIS: a3\n\nNow the user says:\n$/);
  assert.match(M.threadContext(c), /^Summary of the conversation before this \(compacted\):\n- the cat is Pixel[\s\S]*User: q2/);
  assert.throws(() => C.applyCompaction({ messages }, { summary: '  ', upto: 1 }), /empty/);
});

test('keepCompaction: a chat object read before a compaction does not write the old session and summary back', () => {
  const disk = { compaction: { summary: 'S', upto: 4, ts: 2000, sessions: { claudeSessionId: 'old' } }, compactions: [{ ts: 2000, upto: 4 }], seen: { claude: 4 }, context: {}, claudeSessionId: null };
  const stale = { claudeSessionId: 'old', quickSessionId: 'q', seen: { claude: 9 }, context: { claude: { tokens: 1 } } };
  C.keepCompaction(disk, stale);
  assert.equal(stale.claudeSessionId, null);
  assert.equal(stale.quickSessionId, 'q');
  assert.deepEqual(stale.seen, { claude: 4 });
  assert.equal(stale.compaction.summary, 'S');
  // a session started after the compaction is kept; an object already as new is left alone
  const newer = { claudeSessionId: 'new', compaction: { ts: 2000 }, seen: { claude: 7 } };
  assert.equal(C.keepCompaction(disk, newer).seen.claude, 7);
  assert.equal(C.keepCompaction(disk, { claudeSessionId: 'new' }).claudeSessionId, 'new');
});

test('compactStatus: context only for the live session, threshold, last compaction', () => {
  const c = { id: 'abc', brain: 'claude', messages: [msg('user', 'a')], claudeSessionId: 's', context: { claude: { tokens: 50000, sessionId: 's', ts: 5 } },
    compactions: [{ ts: 1, upto: 1, tokensBefore: 120000, chars: 10 }], compaction: { summary: 'S', upto: 1, ts: 1 } };
  const st = C.compactStatus(c, { atTokens: 100000 });
  assert.equal(st.contextTokens, 50000);
  assert.equal(st.percent, 50);
  assert.equal(st.last.summary, 'S');
  assert.equal(C.compactStatus({ ...c, claudeSessionId: null }, {}).contextTokens, null);
});

test('transcriptRows: a divider before the first message after each compaction', () => {
  const ms = ['a', 'b', 'c', 'd'].map((t) => msg('user', t));
  const kinds = (rows) => rows.map((r) => (r.kind === 'msg' ? r.m.text : '|'));
  assert.deepEqual(kinds(transcriptRows(ms, [{ upto: 2 }])), ['a', 'b', '|', 'c', 'd']);
  assert.deepEqual(kinds(transcriptRows(ms, [{ upto: 1 }, { upto: 3 }], 2)), ['c', '|', 'd'], 'one before the window start is not drawn');
  assert.deepEqual(kinds(transcriptRows(ms, [{ upto: 4 }])), ['a', 'b', 'c', 'd', '|']);
  assert.deepEqual(kinds(transcriptRows(ms)), ['a', 'b', 'c', 'd']);
  assert.match(compactedLabel({ tokensBefore: 102345, ts: 1 }).title, /at 102k tokens/);
});

// ---------------------------------------------------------------- the JARVIS thread end to end (stand-in claude)

const say = async (id, text) => {
  const out = await chat.sendMessage(id, { text, ...CLAUDE }, () => {});
  await chat.compactionRunning(id); // the background compaction a turn may have started
  return out;
};

test('past atTokens the next turn starts a fresh session seeded with the summary; every message stays in the file', { skip: !posix }, async () => {
  setCompact({ enabled: true, atTokens: 20000, keepMessages: 2 });
  const main = await chat.mainChat();
  process.env.FAKE_CTX = '8000';
  await say(main.id, 'FACT: my cat is called Pixel');
  await say(main.id, 'how are you');
  let c = await chat.getChat(main.id);
  const s1 = c.claudeSessionId;
  assert.equal(c.context.claude.tokens, 8000, 'the last call, not the 4M cumulative cache reads');
  assert.equal(c.context.claude.start, 8000, 'the session\'s size at its first turn');
  assert.equal(summaries().length, 0, 'below the threshold: no compaction');
  assert.ok(turns().at(-1).includes('--resume'));
  process.env.FAKE_CTX = '25000';
  await say(main.id, 'tell me about szuf');
  assert.equal(summaries().length, 1, 'one summary call after the turn that crossed atTokens');
  const sum = summaries()[0];
  assert.match(sum.stdin, /User: FACT: my cat is called Pixel/);
  assert.doesNotMatch(sum.stdin, /tell me about szuf/, 'the last keepMessages messages are kept, not summarised');
  assert.ok(sum.args.includes('claude-sonnet-5-5') && sum.args.includes('--max-turns') && sum.args.includes('--safe-mode'), 'no tools, one turn, none of Sir\'s CLAUDE.md / memory');
  c = await chat.getChat(main.id);
  assert.equal(c.messages.length, 6, 'nothing deleted');
  assert.equal(c.claudeSessionId, null);
  assert.equal(c.compaction.upto, 4);
  assert.equal(c.compactions.length, 1);
  assert.equal(c.compactions[0].tokensBefore, 25000);
  const st = await chat.mainCompactStatus();
  assert.equal(st.contextTokens, null);
  assert.equal(st.last.upto, 4);
  // the next turn: no --resume, a new session, the summary (with the early fact) and the two kept messages
  process.env.FAKE_CTX = '9000';
  await say(main.id, 'what is my cat called?');
  const t = turns().at(-1);
  assert.ok(!t.includes('--resume'), 'a fresh session');
  assert.match(t[1], /^\[now: [^\]]+\]\nSummary of the conversation before this \(compacted\):\n## Facts to remember\n- FACT: my cat is called Pixel\n[\s\S]*?\n\nThe conversation since that summary:\nUser: tell me about szuf\nJARVIS \(claude\): Re: tell me about szuf\n\nNow the user says:\nwhat is my cat called\?$/);
  c = await chat.getChat(main.id);
  assert.ok(c.claudeSessionId && c.claudeSessionId !== s1);
  assert.equal(c.context.claude.tokens, 9000);
  assert.equal(c.context.claude.start, 9000, 'a new session: a new start');
  // and the turn after resumes that new session with nothing replayed
  await say(main.id, 'thanks');
  assert.equal(turns().at(-1)[turns().at(-1).indexOf('--resume') + 1], c.claudeSessionId);
  assert.match(turns().at(-1)[1], /^\[now: [^\]]+\]\nthanks$/, 'only the [now: …] block before the message');
  assert.equal((await chat.getChat(main.id)).messages.length, 10);
});

test('a failed summary keeps the session and is retried on the next turn', { skip: !posix }, async () => {
  const main = await chat.mainChat();
  const before = summaries().length;
  process.env.FAKE_CTX = '30000';
  process.env.FAKE_SUMMARY_FAIL = '1';
  await say(main.id, 'FACT: the boat is blue');
  let c = await chat.getChat(main.id);
  const sid = c.claudeSessionId;
  assert.equal(summaries().length, before + 1, 'it tried');
  assert.ok(sid, 'the session is kept');
  assert.equal(c.compactions.length, 1, 'no compaction recorded');
  assert.match(c.compactFailed.error, /Overloaded/);
  await say(main.id, 'still there?');
  assert.equal(turns().at(-1)[turns().at(-1).indexOf('--resume') + 1], sid, 'the next turn resumes the same session');
  assert.equal(summaries().length, before + 2, 'and retries');
  delete process.env.FAKE_SUMMARY_FAIL;
  await say(main.id, 'one more');
  c = await chat.getChat(main.id);
  assert.equal(c.compactions.length, 2);
  assert.equal(c.compactFailed, undefined);
  assert.equal(c.claudeSessionId, null);
  assert.match(c.compaction.summary, /the boat is blue/);
  assert.match(summaries().at(-1).stdin, /^Summary of the conversation before this stretch:\n## Facts to remember\n- FACT: my cat is called Pixel/, 'the previous summary is carried into the next');
});

test('rigs compact now: forces one regardless of size; nothing to summarise is said so', { skip: !posix }, async () => {
  setCompact({ atTokens: 1000000 });
  const main = await chat.mainChat();
  process.env.FAKE_CTX = '5000';
  await say(main.id, 'hello again');
  await say(main.id, 'and again');
  const n = (await chat.getChat(main.id)).compactions.length;
  const r = await chat.compactMainNow();
  assert.equal(r.ok, true);
  assert.equal(r.status.compactions, n + 1);
  assert.equal(r.status.last.reason, 'manual');
  const again = await chat.compactMainNow();
  assert.equal(again.ok, false);
  assert.match(again.error, /nothing to compact yet/);
});
