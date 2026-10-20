// Trace explorer (ui/src/trace-panel.js): the pure layout and analysis behind it (ui/src/trace-layout.js) run on the
// fixture traces (test/fixtures/trace-fixtures.js, the span shape src/trace.js documents), the fixtures go through
// the real store and API shape, and the page has the elements the panel script addresses. No browser.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { test } from 'node:test';

process.env.RIGS_HOME = fs.mkdtempSync(path.join(os.tmpdir(), 'rigs-trace-panel-'));
process.env.RIGS_NO_OPENRIG = '1';
process.env.RIGS_NO_MIGRATIONS = '1';
process.env.RIGS_NO_AUTOUPDATE = '1';
const L = await import('../ui/src/trace-layout.js');
const { fixtureSpans, writeFixtures } = await import('./fixtures/trace-fixtures.js');

const NOW = Date.UTC(2026, 9, 18, 12, 0, 0);
const all = fixtureSpans(NOW);
const byTrace = (req) => {
  const root = all.find((s) => s.kind === 'intake' && s.input === req);
  return all.filter((s) => s.traceId === root.traceId);
};
const A = byTrace('what is the weather like?');
const B = byTrace('add dark mode to the dashboard');
const D = byTrace('check the build on macbookpro');

test('kindGroup covers the t1 kinds and the later stages; errors are red', () => {
  const want = { intake: 'intake', router: 'router', 'brain-turn': 'brain', 'tool-call': 'tool', handoff: 'handoff', plan: 'planner', dispatch: 'handoff', task: 'task', assistant: 'brain', event: 'event', gap: 'event', mystery: 'other' };
  for (const [k, g] of Object.entries(want)) assert.equal(L.kindGroup(k), g, k);
  assert.equal(L.spanColor({ kind: 'tool-call', status: 'error' }), L.ERROR_COLOR);
  assert.equal(L.spanColor({ kind: 'router', status: 'ok' }), L.GROUPS.router.color);
});

test('layoutTrace: time runs along x, lanes are machines (or seats), children sit below their parent', () => {
  const lay = L.layoutTrace(B, { now: NOW, even: false, width: 600 });
  assert.deepEqual(lay.lanes.map((l) => l.key).sort(), ['macbookpro', 'magix-system', 'win-desk']);
  const node = new Map(lay.nodes.map((n) => [n.id, n]));
  const sorted = [...lay.nodes].sort((a, b) => a.start - b.start);
  for (let i = 1; i < sorted.length; i++) assert.ok(sorted[i].x >= sorted[i - 1].x - 1e-9, 'x follows start time');
  for (const n of lay.nodes) {
    assert.equal(n.fx, n.x); assert.equal(n.fy, n.y); assert.equal(n.fz, n.z);
    const lane = lay.lanes.find((l) => l.key === n.lane);
    assert.ok(Math.abs(n.z - lane.z) < 30, 'a node sits in its lane');
    if (n.span.parentId && node.has(n.span.parentId)) assert.ok(n.y < node.get(n.span.parentId).y, 'child below parent');
  }
  assert.equal(lay.links.length, B.length - 1, 'one edge per non-root span');
  assert.ok(lay.links.some((l) => l.cross), 'the dispatch → task edges cross machines');
  const seats = L.layoutTrace(B, { now: NOW, lane: 'seat' }).lanes.map((l) => l.key);
  assert.ok(seats.includes('team-code-sonnet@hub-dash') && seats.includes('magix-system'), 'seat lanes, machine when no seat');
  const even = L.layoutTrace(B, { now: NOW, even: true, width: 600 });
  const xs = [...even.nodes].sort((a, b) => a.start - b.start).map((n) => n.x);
  assert.ok(Math.abs(xs[1] - xs[0] - (xs.at(-1) - xs.at(-2))) < 1e-6, 'even spacing in start order');
  const gap = { traceId: B[0].traceId, spanId: 'sp-0000000000ff', parentId: B.find((x) => x.name === 'dispatch t1, t2').spanId, kind: 'gap', name: 'macbookpro did not answer', node: 'macbookpro, win-desk', start: B[0].start + 50000, end: B[0].start + 50001, status: 'error', meta: { gap: true } };
  const withGap = L.layoutTrace([...B, gap], { now: NOW });
  assert.equal(withGap.lanes.length, 3, 'a mesh gap sits in its parent\'s lane, not a lane of its own');
  assert.equal(withGap.nodes.find((n) => n.id === gap.spanId).lane, 'magix-system');
  const flat = L.layoutTrace(B, { now: NOW, flat: true });
  assert.ok(flat.nodes.every((n) => n.z === 0), 'phone layout is flat');
  assert.equal(new Set(flat.lanes.map((l) => l.y)).size, 3, 'phone lanes stack along y');
});

test('node size grows with duration or tokens, log-scaled and bounded', () => {
  const tool = A.find((s) => s.name === 'mesh_status');
  const brain = A.find((s) => s.kind === 'brain-turn');
  assert.ok(L.nodeVal(brain, 'duration', NOW) > L.nodeVal(tool, 'duration', NOW));
  assert.ok(L.nodeVal(brain, 'tokens', NOW) > L.nodeVal(tool, 'tokens', NOW));
  assert.equal(L.nodeVal(tool, 'tokens', NOW), 1);
  assert.ok(L.nodeVal({ start: 0, end: 1e12 }, 'duration') <= 41);
});

test('criticalPath follows the child that finished last; self time never double counts', () => {
  const ids = L.criticalPath(B, NOW);
  const names = ids.map((id) => B.find((s) => s.spanId === id).name);
  assert.deepEqual(names, ['jarvis/send', 'claude claude-opus-5-5', 'project_create', 'plan', 't3 Review', 'Bash']);
  const self = L.selfTimes(A, NOW);
  const brain = A.find((s) => s.kind === 'brain-turn');
  // a 7400 ms turn whose tool calls cover 2100 + 180 + 2900 ms of it
  assert.equal(self.get(brain.spanId), 7400 - (2100 + 180 + 2900));
});

test('summarize: total time, time per stage kind, tool-call counts, tokens, cost, errors', () => {
  const s = L.summarize(A, NOW);
  assert.equal(s.totalMs, 8120);
  assert.equal(s.toolCalls, 3);
  assert.equal(s.errors, 1);
  assert.deepEqual(s.nodes, ['magix-system']);
  assert.equal(s.costUsd, 0.0214);
  assert.equal(s.tokens, 5210 + 184 + 21000);
  assert.ok(Math.abs(s.groups.reduce((a, g) => a + g.share, 0) - 1) < 1e-9, 'shares add up to 100%');
  assert.equal(s.groups.find((g) => g.group === 'tool').selfMs, 2100 + 180 + 2900);
  assert.deepEqual(s.tools.map((t) => t.name).sort(), ['WebFetch', 'WebSearch', 'mesh_status']);
  assert.equal(s.tools.find((t) => t.name === 'WebFetch').errors, 1);
  const b = L.summarize(B, NOW);
  assert.equal(b.tools[0].name, 'Bash');
  assert.equal(b.tools[0].count, 3);
  assert.deepEqual(b.nodes.sort(), ['macbookpro', 'magix-system', 'win-desk']);
  assert.equal(b.criticalSelf.length, b.critical.length);
  assert.equal(b.criticalMs, 750000, 'request → end of the review, though the intake span itself ended after 6.1 s');
  const d = L.summarize(D, NOW);
  assert.equal(d.running, 3, 'intake, brain turn and one tool call still run');
  assert.equal(d.totalMs, 40e3, 'running spans last until now');
  assert.deepEqual(L.summarize([]).groups, []);
});

test('replay: starts and ends in order; stateAt future → active → done', () => {
  const ev = L.replayEvents(A);
  assert.equal(ev.length, A.length * 2);
  for (let i = 1; i < ev.length; i++) assert.ok(ev[i].t >= ev[i - 1].t);
  assert.equal(ev[0].type, 'start');
  assert.equal(L.replayEvents(D).filter((e) => e.type === 'end').length, D.filter((s) => s.end != null).length, 'running spans have no end event');
  const s = { start: 10, end: 20 };
  assert.equal(L.stateAt(s, 5), 'future'); assert.equal(L.stateAt(s, 15), 'active'); assert.equal(L.stateAt(s, 20), 'done');
  assert.equal(L.stateAt({ start: 10, end: null }, 1e15), 'active');
});

test('present: pretty JSON, plain text, and both truncation markers of the store', () => {
  assert.deepEqual(L.present({ a: 1 }), { text: '{\n  "a": 1\n}', json: true, truncated: false, cut: 0 });
  assert.equal(L.present('{"route":"answer"}').text, '{\n  "route": "answer"\n}');
  assert.deepEqual(L.present('hello'), { text: 'hello', json: false, truncated: false, cut: 0 });
  const cutStr = L.present('abc…[truncated 1234 chars]');
  assert.deepEqual([cutStr.text, cutStr.truncated, cutStr.cut], ['abc', true, 1234]);
  const cutObj = L.present({ truncated: true, chars: 9000, preview: '{"x":' });
  assert.deepEqual([cutObj.truncated, cutObj.cut, cutObj.text], [true, 8995, '{"x":']);
  assert.equal(L.present(null).text, '');
});

test('mergeSpans keeps the last record per span (running → finished) and filterList filters', () => {
  const run = { ...D[1], end: null, status: 'running' };
  const done = { ...D[1], end: D[1].start + 5, status: 'ok' };
  const m = L.mergeSpans([run], [done]);
  assert.equal(m.length, 1); assert.equal(m[0].status, 'ok');
  const list = [{ traceId: 'tr-1', request: 'Add dark mode', route: 'implement', status: 'ok', nodes: ['a'] }, { traceId: 'tr-2', request: 'weather', route: 'answer', status: 'error', nodes: ['b'] }];
  assert.deepEqual(L.filterList(list, { q: 'dark' }).map((t) => t.traceId), ['tr-1']);
  assert.deepEqual(L.filterList(list, { status: 'error' }).map((t) => t.traceId), ['tr-2']);
  assert.deepEqual(L.filterList(list, { route: 'implement', node: 'a' }).map((t) => t.traceId), ['tr-1']);
});

test('fixtures load through the real trace store and API shape', async () => {
  writeFixtures(process.env.RIGS_HOME);
  const trace = await import('../src/trace.js');
  const l = await trace.list({ since: '7d' });
  assert.equal(l.count, 4);
  const b = l.traces.find((t) => t.request === 'add dark mode to the dashboard');
  assert.equal(b.route, 'implement');
  assert.deepEqual([...b.nodes].sort(), ['macbookpro', 'magix-system', 'win-desk']);
  const full = await trace.get(b.traceId);
  assert.equal(full.spans.length, B.length);
  assert.equal(L.layoutTrace(full.spans).nodes.length, B.length);
});

test('the page has the panel, its button (also in the phone sheet) and the WebSocket hook', () => {
  const root = path.join(import.meta.dirname, '..');
  const html = fs.readFileSync(path.join(root, 'ui/index.html'), 'utf8');
  const main = fs.readFileSync(path.join(root, 'ui/src/main.js'), 'utf8');
  const mobile = fs.readFileSync(path.join(root, 'ui/src/mobile.js'), 'utf8');
  assert.match(html, /<aside id="traces"/);
  assert.match(html, /<button id="btn-traces"[^>]*aria-label=/);
  assert.match(main, /createTraces\(\$\('#traces'\)\)/);
  assert.match(main, /m\.type === 'trace-span'\) \{ onTraceSpan\(m\.span\);/);
  assert.match(mobile, /\['btn-traces', /);
});
