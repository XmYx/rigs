// The JARVIS main thread is one continuous conversation across lanes (src/main-chat.js, src/chat.js): the quick lane's
// history budget, the compaction-summary hook, work requests mirrored from their threads, the full brain told about
// each of them exactly once, and writes that land while a turn runs kept. A stand-in `claude` logs every prompt.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { after, test } from 'node:test';

// A throwaway RIGS home and a stand-in `claude` first on PATH: never the real ~/.rigs or Claude.
const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'rigs-main-chat-'));
const BIN = path.join(TMP, 'bin');
fs.mkdirSync(BIN);
const FAKE_LOG = path.join(TMP, 'claude-args.jsonl');
// Replies "Re: <the request>", so each answer is recognisable in later prompts.
fs.writeFileSync(path.join(BIN, 'claude'), `#!${process.execPath}
const fs = require('node:fs');
const args = process.argv.slice(2);
if (args[0] === '--version') { console.log('9.9.9 (Claude Code)'); process.exit(0); }
fs.appendFileSync(process.env.FAKE_CLAUDE_LOG, JSON.stringify(args) + '\\n');
const r = args.indexOf('--resume');
const sid = r >= 0 ? args[r + 1] : 'sess-' + Math.random().toString(36).slice(2, 8);
const reply = 'Re: ' + args[1].split('\\n').at(-1);
const model = args[args.indexOf('--model') + 1];
const out = (o) => console.log(JSON.stringify(o));
out({ type: 'system', subtype: 'init', session_id: sid });
if (process.env.FAKE_CLAUDE_SLEEP) Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, Number(process.env.FAKE_CLAUDE_SLEEP));
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
const M = await import('../src/main-chat.js');
const chat = await import('../src/chat.js');

{ const c = config(); c.quick = { ...c.quick, enabled: true, local: { ...(c.quick?.local || {}), enabled: false } }; saveConfig(c); }
const posix = process.platform !== 'win32';
const CLAUDE = { brain: 'claude', model: 'claude-opus-5-5', effort: 'high' };
const answerRouter = async () => ({ route: 'answer', via: 'jev', reason: 'a question' });
const implementRouter = async () => ({ route: 'implement', via: 'jev', reason: 'work', title: 'Dark mode for szuf' });
const prompts = () => (fs.existsSync(FAKE_LOG) ? fs.readFileSync(FAKE_LOG, 'utf8').trim().split('\n').filter(Boolean).map((l) => JSON.parse(l)) : []);
const lastPrompt = () => prompts().at(-1);
// the last prompt's text, without the router's one-line hint
const asked = () => lastPrompt()[1].replace(/\[routed: [^\]]*\]\n/g, '');
const count = (s, sub) => s.split(sub).length - 1;
const msg = (role, text, extra = {}) => ({ role, text, ts: 0, ...extra });

// ---------------------------------------------------------------- the budget (pure)

test('threadContext: the last 30 conversation messages, not 6×800; reports shortened and capped; the request left out', () => {
  const messages = [];
  for (let i = 1; i <= 40; i++) {
    messages.push(msg(i % 2 ? 'user' : 'assistant', `message ${i} ` + 'x'.repeat(i === 39 ? 5000 : 100)));
    for (let r = 0; r < 5; r++) messages.push(msg('assistant', `report ${i}.${r} ` + 'y'.repeat(1000), { brain: 'rigs', report: true }));
  }
  messages.push(msg('user', 'the request itself'));
  const ctx = M.threadContext({ messages });
  for (let i = 11; i <= 40; i++) assert.match(ctx, new RegExp(`message ${i} `), `message ${i} is in the last 30`);
  assert.doesNotMatch(ctx, /message 10 /, 'the 31st-newest is not');
  assert.equal(count(ctx, 'RIGS report: '), 8, 'the newest 8 reports');
  assert.match(ctx, /RIGS report: report 40\.4 /);
  assert.ok(ctx.split('\n').filter((l) => l.startsWith('RIGS report:')).every((l) => l.length <= 'RIGS report: '.length + 300));
  assert.ok(ctx.includes('x'.repeat(1500)) && !ctx.includes('x'.repeat(2000)), 'a recent long message is cut at 2000 chars');
  assert.doesNotMatch(ctx, /the request itself/);
  assert.match(ctx, /^\(\d+ earlier messages not shown\.\)\nRecently in this conversation:\n/);
  assert.match(ctx, /\n\nNow the user says:\n$/);
  const b = M.MAIN_CONTEXT;
  const max = b.recent * b.recentChars + (b.messages - b.recent) * b.olderChars + b.reports * b.reportChars;
  assert.ok(ctx.length < max + 2000, `stays within the documented budget (${ctx.length} < ${max} + labels)`);
  assert.equal(M.threadContext({ messages: [msg('user', 'only the request')] }), '', 'nothing before it, no context');
});

test('compaction hook: a stored summary comes first and history starts where it ends', () => {
  const messages = [msg('user', 'old question'), msg('assistant', 'old answer'), msg('user', 'newer question'), msg('assistant', 'newer answer'), msg('user', 'now')];
  const c = { messages, compaction: { summary: 'Sir asked about szuf; it was fixed.', upto: 2 } };
  assert.deepEqual(M.compactionSummary(c), { text: 'Sir asked about szuf; it was fixed.', upto: 2 });
  assert.equal(M.compactionSummary({ messages }), null);
  const ctx = M.threadContext(c);
  assert.match(ctx, /^Summary of the conversation before this \(compacted\):\nSir asked about szuf; it was fixed\.\n\nRecently in this conversation:\nUser: newer question\nJARVIS: newer answer\n/);
  assert.doesNotMatch(ctx, /old question/);
  // a resumed brain has the summarised part in its own session: no summary, only what it hasn't seen
  c.seen = { claude: 1 };
  assert.doesNotMatch(M.unseenContext(c, 'claude'), /Summary/);
  assert.match(M.unseenContext(c, 'claude', { withSummary: true }), /^Summary of the conversation before this[\s\S]*User: newer question/);
});

test('unseenContext: what other lanes said since the brain\'s last turn, labelled, once', () => {
  const c = { seen: { claude: 2 }, messages: [
    msg('user', 'seen q'), msg('assistant', 'seen a', { brain: 'claude' }),
    msg('user', 'quick q'), msg('assistant', 'quick a', { brain: 'claude', lane: 'quick' }),
    ...[M.mirrorMessage({ role: 'user', text: 'add a dark mode', chatId: 'w1', route: 'implement', title: 'Dark mode' }),
      M.mirrorMessage({ role: 'assistant', text: 'Filed it, sir.', chatId: 'w1', route: 'implement', title: 'Dark mode', brain: 'claude' })],
    msg('assistant', 'Merged.', { brain: 'rigs', report: true }),
    msg('user', 'now'),
  ] };
  const u = M.unseenContext(c, 'claude');
  assert.equal(u, 'Earlier in this conversation (since your last turn — answered on the fast path, routed to work threads, or reported by RIGS):\n'
    + 'User: quick q\nJARVIS (fast path): quick a\nUser (routed to implement · thread "Dark mode"): add a dark mode\nJARVIS (in that implement thread): Filed it, sir.\nRIGS report: Merged.\n\nNow the user says:\n');
  c.seen.claude = c.messages.length - 1;
  assert.equal(M.unseenContext(c, 'claude'), '', 'nothing new, nothing replayed');
  assert.equal(M.mirrorMessage({ role: 'assistant', text: '  ', chatId: 'w1' }), null, 'an empty reply is not mirrored');
});

test('appendedSince: what another writer added after a read, without what this copy already holds', () => {
  const a = msg('user', 'a', { ts: 1 });
  const b = msg('assistant', 'report', { ts: 2, report: true });
  const mine = msg('user', 'mine', { ts: 3 });
  assert.deepEqual(M.appendedSince({ messages: [a, b] }, 1, [a, mine]), [b]);
  assert.deepEqual(M.appendedSince({ messages: [a, b] }, 1, [a, b]), []);
  assert.deepEqual(M.appendedSince(null, 1, [a]), []);
  assert.deepEqual(M.appendedSince({ messages: [a, b] }, undefined, [a]), [], 'a chat never read has nothing to merge');
});

// ---------------------------------------------------------------- end to end (stand-in claude)

test('3 quick answers and 1 implement request: the next answer\'s prompt holds all of them; the full brain hears each once', { skip: !posix && 'stand-in claude is a POSIX script' }, async () => {
  fs.rmSync(FAKE_LOG, { force: true });
  const asks = ['what time is it in Tokyo', 'how is the weather in Budapest', 'which machines are online'];
  for (const q of asks) {
    const out = await chat.jarvisSend(q, {}, () => {}, { router: answerRouter });
    assert.equal(out.text, `Re: ${q}`);
  }
  assert.ok(prompts().every((a) => !a.includes('--resume')), 'quick turns are fresh sessions');
  const events = [];
  const work = await chat.jarvisSend('add a dark mode to szuf', CLAUDE, (e) => events.push(e), { router: implementRouter });
  assert.equal(work.text, 'Re: add a dark mode to szuf');
  const workId = events.find((e) => e.type === 'route').chatId;
  const main = await chat.mainChat();
  assert.notEqual(workId, main.id, 'implement runs in its own thread');
  const mirrored = main.messages.filter((m) => m.mirror);
  assert.deepEqual(mirrored.map((m) => [m.role, m.text, m.chatId, m.route, m.title]), [
    ['user', 'add a dark mode to szuf', workId, 'implement', 'Dark mode for szuf'],
    ['assistant', 'Re: add a dark mode to szuf', workId, 'implement', 'Dark mode for szuf'],
  ]);
  assert.equal((await chat.getChat(workId)).messages.length, 2, 'the work thread keeps its own turn');

  // the next quick answer sees all four requests and their answers
  await chat.jarvisSend('and in Paris?', {}, () => {}, { router: answerRouter });
  const p = asked();
  for (const q of asks) { assert.ok(p.includes(`User: ${q}\nJARVIS: Re: ${q}`), q); }
  assert.ok(p.includes('User (routed to implement · thread "Dark mode for szuf"): add a dark mode to szuf\nJARVIS (in that implement thread): Re: add a dark mode to szuf'));
  assert.ok(p.endsWith('Now the user says:\nand in Paris?'));

  // the full brain: told each of them exactly once, then nothing again
  await chat.jarvisSend('sum up what I asked today', CLAUDE, () => {}, { router: answerRouter, quick: false });
  const f1 = lastPrompt();
  for (const q of [...asks, 'and in Paris?']) {
    assert.equal(count(f1[1], `User: ${q}\n`), 1, `"${q}" once`);
    assert.equal(count(f1[1], `JARVIS (fast path): Re: ${q}\n`), 1, `its answer once`);
  }
  assert.equal(count(f1[1], 'User (routed to implement · thread "Dark mode for szuf"): add a dark mode to szuf\n'), 1);
  assert.equal(count(f1[1], 'JARVIS (in that implement thread): Re: add a dark mode to szuf\n'), 1);
  const afterFull = await chat.getChat(main.id);
  assert.ok(afterFull.claudeSessionId, 'the thread has its own session now');
  assert.equal(afterFull.seen.claude, afterFull.messages.length);
  await chat.jarvisSend('thanks', CLAUDE, () => {}, { router: answerRouter, quick: false });
  const f2 = lastPrompt();
  assert.equal(f2[f2.indexOf('--resume') + 1], afterFull.claudeSessionId, 'full turns resume the thread\'s session');
  assert.equal(asked(), 'thanks', 'nothing replayed twice');
  // a quick answer in between is told once on the next full turn, and the quick turn never touched the session
  await chat.jarvisSend('what time is it in Lima', {}, () => {}, { router: answerRouter });
  assert.equal((await chat.getChat(main.id)).claudeSessionId, afterFull.claudeSessionId);
  await chat.jarvisSend('ok', CLAUDE, () => {}, { router: answerRouter, quick: false });
  assert.equal(asked(), 'Earlier in this conversation (since your last turn — answered on the fast path, routed to work threads, or reported by RIGS):\nUser: what time is it in Lima\nJARVIS (fast path): Re: what time is it in Lima\n\nNow the user says:\nok');
});

test('a report or mirror written while a full turn runs is kept, and the brain is told about it next turn', { skip: !posix && 'stand-in claude is a POSIX script' }, async () => {
  const main = await chat.mainChat();
  process.env.FAKE_CLAUDE_SLEEP = '800';
  let turn;
  try {
    turn = chat.jarvisSend('a slow one', CLAUDE, () => {}, { router: answerRouter, quick: false });
    await new Promise((r) => setTimeout(r, 300));
    await chat.postReport({ text: 'Project szuf is done.' });
    await turn;
  } finally { delete process.env.FAKE_CLAUDE_SLEEP; }
  const c = await chat.getChat(main.id);
  const texts = c.messages.map((m) => m.text);
  assert.ok(texts.includes('Project szuf is done.'), 'the report survived the turn\'s save');
  assert.ok(texts.includes('Re: a slow one'));
  assert.ok(c.seen.claude <= texts.indexOf('Project szuf is done.'), 'the report sits after the turn\'s seen mark');
  await chat.jarvisSend('next', CLAUDE, () => {}, { router: answerRouter, quick: false });
  assert.match(asked(), /RIGS report: Project szuf is done\.\n\nNow the user says:\nnext$/);
});

test('chats/main/clear is still the explicit reset: the next answer starts a fresh thread with no history', { skip: !posix && 'stand-in claude is a POSIX script' }, async () => {
  const before = await chat.mainChat();
  assert.deepEqual(await chat.clearMainChat(), { ok: true, cleared: true });
  await chat.jarvisSend('hello again', {}, () => {}, { router: answerRouter });
  const fresh = await chat.mainChat();
  assert.notEqual(fresh.id, before.id);
  assert.equal(asked(), 'hello again', 'no history carried over');
});
