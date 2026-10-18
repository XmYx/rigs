// Pre-routing: the config.router toggle and engines (src/router.js), the measurement jarvisSend writes for every request
// (src/chat.js → usage ledger "request" records) and the time-saved stats (src/preroute-stats.js). No model, no daemon.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { after, test } from 'node:test';

// A throwaway RIGS home: never the real ~/.rigs.
const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'rigs-preroute-'));
Object.assign(process.env, {
  RIGS_HOME: path.join(TMP, 'rigs'), RIGS_NO_OPENRIG: '1', RIGS_NO_AUTOUPDATE: '1', RIGS_NO_MIGRATIONS: '1', RIGS_NAME: 'test-node',
});
after(() => fs.rmSync(TMP, { recursive: true, force: true }));

const { config, saveConfig } = await import('../src/config.js');
const R = await import('../src/router.js');
const chat = await import('../src/chat.js');
const usage = await import('../src/usage.js');
const trace = await import('../src/trace.js');
const S = await import('../src/preroute-stats.js');

const setPreroute = (on) => { const c = config(); c.router = { ...c.router, preroute: on }; saveConfig(c); };

// ---------------------------------------------------------------- settings

test('config.router: on by default with the LocalJev engine; bad values fall back to the defaults', () => {
  assert.equal(config().router.preroute, true);
  assert.equal(R.routerSettings(config().router).engine, 'jev');
  const s = R.routerSettings({ preroute: 'nope', engine: 'gpt', fallback: 'x', jev: { timeoutMs: 'soon', minProb: 7 } });
  assert.equal(s.preroute, true);
  assert.equal(s.engine, 'jev');
  assert.equal(s.fallback, 'claude');
  assert.equal(s.jev.timeoutMs, 8000);
  assert.equal(s.jev.minProb, 1);
  assert.equal(R.prerouteOn(undefined, { preroute: false }), false);
  assert.equal(R.prerouteOn('on', { preroute: false }), true, 'the per-request value wins');
  assert.equal(R.prerouteOn(false, { preroute: true }), false);
});

test('applyRouterPatch validates, keeps the masked key, and routerView masks it', () => {
  const cur = { jev: { apiKey: 'secret' } };
  assert.throws(() => R.applyRouterPatch(cur, { engine: 'gpt' }), /engine must be/);
  assert.throws(() => R.applyRouterPatch(cur, { preroute: 'maybe' }), /preroute must be/);
  const next = R.applyRouterPatch(cur, { preroute: false, jev: { apiKey: '••••', minProb: 0.6 } });
  assert.equal(next.preroute, false);
  assert.equal(next.jev.apiKey, 'secret');
  assert.equal(next.jev.minProb, 0.6);
  const v = R.routerView(next, [{ id: 'localjev', port: 8198 }]);
  assert.equal(v.jev.apiKey, '••••');
  assert.equal(v.jevUrl, 'http://127.0.0.1:8198', 'the LocalJev app registered here');
  assert.equal(R.jevUrl(R.routerSettings({ jev: { url: 'http://box:9/' } }), []), 'http://box:9');
  assert.equal(R.jevUrl(R.routerSettings({}), []), '');
});

// ---------------------------------------------------------------- the Jev engine

const THREADS = [{ id: 'c1', title: 'Dark mode for szuf' }];
const CATALOG = [{ node: 'magix-system', items: [{ name: 'szuf', title: 'SZÜF', path: '/home/m/szuf', kinds: ['node'], parts: [] }] }];
const ans = (choice, probabilities) => ({ type: 'choice', choice, probabilities });

test('jevRequest: route decided first, then only what that route needs', () => {
  const b = R.jevRequest('add a dark mode', { threads: THREADS, catalog: CATALOG, selfNode: 'magix-system' }, 'jev-latest');
  assert.deepEqual(Object.keys(b.questions), ['route', 'thread', 'workspace']);
  assert.ok(b.questions.route.criteria.continue);
  assert.ok(b.questions.workspace.criteria['szuf@magix-system'] && b.questions.workspace.criteria.rigs);
  assert.deepEqual(b.predecide, { question: 'route', enabled: true, gates: { answer: [], implement: ['workspace'], plan: ['workspace'], continue: ['thread'] } });
  const bare = R.jevRequest('hi', {});
  assert.deepEqual(Object.keys(bare.questions), ['route']);
  assert.equal(bare.questions.route.criteria.continue, undefined, 'no threads, no continue');
});

test('parseJev: confident routes pass, unsure ones go to the fallback', () => {
  const ctx = { threads: THREADS, catalog: CATALOG };
  assert.equal(R.parseJev({ answers: { route: ans('answer', { answer: 0.8, implement: 0.2 }) } }, ctx, 'what time is it?').route, 'answer');
  assert.equal(R.parseJev({ answers: { route: ans('answer', { answer: 0.4, implement: 0.35 }) } }, ctx, 'x'), null, 'below minProb');
  assert.equal(R.parseJev({ answers: { route: ans('continue', { continue: 0.9 }), thread: ans('none', { none: 0.9 }) } }, ctx, 'x'), null, 'continue without a thread');
  const c = R.parseJev({ answers: { route: ans('continue', { continue: 0.9 }), thread: ans('c1', { c1: 0.7 }) } }, ctx, 'x');
  assert.equal(c.threadId, 'c1');
  // The workspace pick is used only when the request itself names no folder the keyword resolver knows.
  const w = R.parseJev({ answers: { route: ans('implement', { implement: 0.9 }), workspace: ans('szuf@magix-system', { 'szuf@magix-system': 0.8 }) } }, ctx, 'make the buttons bigger');
  assert.deepEqual(w.work, [{ title: '', goal: 'make the buttons bigger', workspace: 'szuf', machine: 'magix-system' }]);
  assert.equal(R.parseJev({ answers: { route: ans('plan', { answer: 0.3, plan: 0.5 }) } }, ctx, 'x'), null, 'a coin flip is not a decision');
  assert.equal(R.parseJev({ answers: { route: ans('plan', { plan: 0.9 }) } }, ctx, 'what time is it in Tokyo?'), null, 'a question is never filed as work on its say-so');
  const low = R.parseJev({ answers: { route: ans('implement', { implement: 0.9 }), workspace: ans('szuf@magix-system', { 'szuf@magix-system': 0.3 }) } }, ctx, 'make the buttons bigger');
  assert.equal(low.work, undefined);
});

test('jevRoute posts to /v1/systemone and returns null when the API is down', async () => {
  const s = R.routerSettings({ jev: { url: 'http://jev.test', apiKey: 'k' } });
  let seen;
  const fetchImpl = async (url, o) => { seen = { url, body: JSON.parse(o.body), auth: o.headers.authorization }; return new Response(JSON.stringify({ answers: { route: ans('answer', { answer: 0.9 }) } })); };
  const capture = {};
  const d = await R.jevRoute('how are you?', { threads: [], catalog: [], capture }, s, { fetchImpl });
  assert.equal(d.route, 'answer');
  assert.equal(seen.url, 'http://jev.test/v1/systemone');
  assert.equal(seen.auth, 'Bearer k');
  assert.equal(capture.engine, 'jev');
  const down = await R.jevRoute('x', { threads: [], catalog: [], capture: {} }, s, { fetchImpl: async () => { throw new Error('ECONNREFUSED'); } });
  assert.equal(down, null);
});

test('route: engine first, then its fallback, then keyword rules', async () => {
  const calls = [];
  const ctx = () => ({ threads: [], projects: [], catalog: [], capture: {} });
  const jevOk = async () => { calls.push('jev'); return { route: 'answer', reason: 'jev' }; };
  const jevNo = async () => { calls.push('jev'); return null; };
  const claudeOk = async () => { calls.push('claude'); return { route: 'answer', reason: 'claude' }; };
  const claudeNo = async () => { calls.push('claude'); return null; };
  const settings = R.routerSettings({ engine: 'jev', fallback: 'claude' });
  assert.equal((await R.route('tell me a joke', ctx(), { settings, engines: { jev: jevOk, claude: claudeOk } })).via, 'jev');
  assert.deepEqual(calls.splice(0), ['jev']);
  const c = ctx();
  assert.equal((await R.route('tell me a joke', c, { settings, engines: { jev: jevNo, claude: claudeOk } })).via, 'model');
  assert.deepEqual(calls.splice(0), ['jev', 'claude']);
  assert.equal(c.capture.tried[0].engine, 'jev');
  assert.equal((await R.route('tell me a joke', ctx(), { settings, engines: { jev: jevNo, claude: claudeNo } })).via, 'rules');
  assert.equal((await R.route('tell me a joke', ctx(), { settings: R.routerSettings({ engine: 'rules', fallback: 'rules' }), engines: { jev: jevOk, claude: claudeOk } })).via, 'rules');
  assert.deepEqual(calls.splice(0), ['jev', 'claude'], 'rules calls no engine');
  // A plain question Jev answered unsure about skips the slow fallback; Jev being down does not.
  const jevUnsure = async (t, c) => { calls.push('jev'); c.capture.unsure = true; return null; };
  const q = await R.route('how is the merge steward doing?', ctx(), { settings, engines: { jev: jevUnsure, claude: claudeOk } });
  assert.equal(q.route, 'answer');
  assert.equal(q.via, 'rules');
  assert.deepEqual(calls.splice(0), ['jev']);
  assert.equal((await R.route('how is the merge steward doing?', ctx(), { settings, engines: { jev: jevNo, claude: claudeOk } })).via, 'model');
  assert.deepEqual(calls.splice(0), ['jev', 'claude']);
});

// ---------------------------------------------------------------- the toggle in jarvisSend

/** A brain turn stand-in: records what it was sent; `filing` makes it call jarvis_task like a real brain would. */
function fakeSend(sent, { filing = false } = {}) {
  return async (chatId, msg, emit, opts) => {
    sent.push({ chatId, text: msg.text, hint: opts.hint });
    if (filing) opts.onTool('mcp__rigs__jarvis_task', { status: 'ok', end: Date.now() });
    emit({ type: 'done', text: 'Done, sir.', chatId });
    return { text: 'Done, sir.' };
  };
}

async function requestRecords() {
  return (await usage.readRecords()).filter((r) => r.kind === 'request');
}

test('pre-routing off: the router is not called, no [routed] hint, a skipped router span, one measurement', async () => {
  setPreroute(false);
  let routerCalls = 0;
  const router = async () => { routerCalls++; return { route: 'answer', via: 'rules', reason: 'x' }; };
  const sent = [];
  const events = [];
  const intake = trace.startSpan({ kind: 'intake', name: 'jarvis/send', input: 'add a dark mode to szuf' });
  await chat.jarvisSend('add a dark mode to szuf', {}, (e) => events.push(e), { router, send: fakeSend(sent, { filing: true }), trace: intake.ctx });
  assert.equal(routerCalls, 0, 'the router model is not called');
  assert.equal(sent.length, 1);
  assert.equal(sent[0].hint, '', 'no [routed] hint');
  assert.equal(sent[0].chatId, (await chat.mainChat()).id, 'straight to the JARVIS thread');
  const route = events.find((e) => e.type === 'route');
  assert.equal(route.preroute, false);
  const timing = events.find((e) => e.type === 'timing');
  assert.equal(timing.preroute, false);
  assert.equal(timing.filedBy, 'brain', 'the brain filed the work itself');
  assert.ok(timing.timeToFiledMs >= 0 && timing.timeToReplyMs >= timing.timeToFiledMs);
  await trace.flush();
  const spans = await trace.readSpans({ traceId: intake.traceId });
  const rspan = spans.find((s) => s.kind === 'router');
  assert.equal(rspan.status, 'skipped');
  assert.equal(rspan.meta.preroute, false);
  const recs = await requestRecords();
  assert.equal(recs.length, 1);
  assert.equal(recs[0].request.preroute, false);
  assert.equal(recs[0].request.traceId, intake.traceId);
});

test('pre-routing on: the router is called and the brain gets the [routed] hint; opts.preroute overrides config', async () => {
  setPreroute(true);
  let routerCalls = 0;
  const router = async () => { routerCalls++; return { route: 'answer', via: 'jev', reason: 'a question' }; };
  const sent = [];
  const events = [];
  await chat.jarvisSend('what time is it?', {}, (e) => events.push(e), { router, send: fakeSend(sent) });
  assert.equal(routerCalls, 1);
  assert.match(sent[0].hint, /^\[routed: answer/);
  const timing = events.find((e) => e.type === 'timing');
  assert.equal(timing.preroute, true);
  assert.equal(timing.route, 'answer');
  assert.equal(timing.via, 'jev');
  assert.equal(timing.timeToFiledMs, null);
  // Per request: off although config says on.
  await chat.jarvisSend('what time is it?', {}, () => {}, { router, send: fakeSend(sent), preroute: false });
  assert.equal(routerCalls, 1);
  assert.equal(sent[1].hint, '');
  const recs = await requestRecords();
  assert.deepEqual(recs.slice(-2).map((r) => r.request.preroute), [true, false]);
  // Request records stay out of the usage dashboard's totals unless asked for.
  assert.equal((await usage.report({})).records.filter((r) => r.kind === 'request').length, 0);
  assert.ok((await usage.report({ kind: 'request' })).count >= 3);
});

test('router-filed work: timeToFiledMs comes from RIGS filing it, not the brain', async () => {
  setPreroute(true);
  const router = async () => ({ route: 'implement', via: 'jev', reason: 'work', title: 'Dark mode', work: [{ title: 'Dark mode', goal: 'add a dark mode', node: 'test-node', workspace: { name: 'szuf' } }] });
  const events = [];
  const onWork = async (items) => items.map(() => ({ id: 'p1', name: 'SZÜF · Dark mode', node: 'test-node', path: '/x' }));
  await chat.jarvisSend('add a dark mode to szuf', {}, (e) => events.push(e), { router, onWork, send: fakeSend([]) });
  const timing = events.find((e) => e.type === 'timing');
  assert.equal(timing.filedBy, 'router');
  assert.ok(timing.timeToFiledMs != null);
});

// ---------------------------------------------------------------- time saved

const rec = (preroute, route, { routerMs = 0, filed = null, reply = null } = {}) => ({ kind: 'request', request: { preroute, route, routerMs, timeToFiledMs: filed, timeToReplyMs: reply } });

test('prerouteStats: measured baseline from requests with pre-routing off', () => {
  const records = [
    rec(false, '', { filed: 20000, reply: 25000 }), rec(false, '', { filed: 30000, reply: 35000 }), // work, brain filed
    rec(false, '', { reply: 6000 }), // answer
    rec(true, 'implement', { routerMs: 600, filed: 2000, reply: 9000 }), rec(true, 'plan', { routerMs: 700, filed: 4000, reply: 12000 }),
    rec(true, 'answer', { routerMs: 500, reply: 6500 }),
  ];
  const s = S.prerouteStats(records);
  assert.equal(s.estimated, false);
  assert.deepEqual(s.preroute, { on: 3, off: 3 });
  const w = s.classes.work;
  assert.equal(w.off.medianMs, 25000);
  assert.equal(w.on.medianMs, 3000);
  assert.equal(w.on.routerMedianMs, 650);
  assert.equal(w.baselineSource, 'measured');
  assert.equal(w.savedPerRequestMs, 22000);
  assert.equal(w.totalSavedMs, 44000);
  assert.equal(s.classes.answer.savedPerRequestMs, -500, 'pre-routing an answer costs its router time');
  assert.equal(s.total.savedMs, 43500);
  assert.equal(s.total.requests, 3);
});

test('prerouteStats: no off samples → estimated baselines (answers: on minus router; work: config, else history)', () => {
  const records = [rec(true, 'implement', { routerMs: 500, filed: 1500, reply: 8000 }), rec(true, 'answer', { routerMs: 400, reply: 5400 })];
  const s = S.prerouteStats(records, { history: { chatTurnMedianMs: 18000, chatTurnN: 40 } });
  assert.equal(s.estimated, true);
  assert.equal(s.classes.work.baselineSource, 'history');
  assert.equal(s.classes.work.savedPerRequestMs, 16500);
  assert.equal(s.classes.answer.baselineSource, 'on-minus-router');
  assert.equal(s.classes.answer.baselineMs, 5000);
  assert.equal(s.classes.answer.savedPerRequestMs, -400);
  const cfg = S.prerouteStats(records, { baselineMs: { work: 30000 }, history: { chatTurnMedianMs: 18000, chatTurnN: 40 } });
  assert.equal(cfg.classes.work.baselineSource, 'config');
  assert.equal(cfg.classes.work.savedPerRequestMs, 28500);
  const none = S.prerouteStats([rec(true, 'plan', { routerMs: 500, filed: 1500 })]);
  assert.equal(none.classes.work.baselineSource, 'none');
  assert.equal(none.classes.work.savedPerRequestMs, null);
  assert.equal(none.total.savedMs, 0);
});

test('prerouteStats: a slow router makes the saving negative, and says so', () => {
  const records = [rec(false, '', { reply: 4000 }), rec(false, '', { reply: 5000 }), rec(true, 'answer', { routerMs: 9000, reply: 13500 })];
  const s = S.prerouteStats(records);
  assert.equal(s.classes.answer.savedPerRequestMs, -9000);
  assert.equal(s.total.savedMs, -9000);
  assert.equal(s.estimated, false);
});

test('aggregateStats merges machines before taking medians', () => {
  const node = (name) => ({ name });
  const r = S.aggregateStats([
    { node: node('a'), report: { requests: 1, preroute: { on: 0, off: 1 }, total: {}, records: [rec(false, '', { reply: 6000 })], history: { chatTurnMedianMs: 10000, chatTurnN: 1 } } },
    { node: node('b'), report: { requests: 1, preroute: { on: 1, off: 0 }, total: {}, records: [rec(true, 'answer', { routerMs: 500, reply: 5000 })], history: { chatTurnMedianMs: 20000, chatTurnN: 3 } } },
    { node: node('c'), error: 'offline' },
  ]);
  assert.deepEqual(r.nodes, ['a', 'b']);
  assert.equal(r.errors[0].node, 'c');
  assert.equal(r.classes.answer.savedPerRequestMs, 1000);
  assert.equal(r.history.chatTurnMedianMs, 17500);
});
