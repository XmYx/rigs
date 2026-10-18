// Tool reuse: the keyword match that puts registry tools into task briefs and the planning prompt, the size of the
// text that tells agents about the registry, and the usage log that counts tool runs and searches. Scratch RIGS_HOME.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { test } from 'node:test';

process.env.RIGS_HOME = fs.mkdtempSync(path.join(os.tmpdir(), 'rigs-reuse-'));
process.env.RIGS_NAME = 'box';
process.env.RIGS_NO_MIGRATIONS = '1';
const T = await import('../src/toolbox.js');
const U = await import('../src/usage.js');
const P = await import('../src/planner.js');
const S = await import('../src/setup.js');

const CATALOG = [
  { kind: 'tool', id: 'screenshot-check', name: 'Screenshot check', node: 'box', tags: ['screenshot', 'ui', 'qa'], description: 'Capture a web page at phone and desktop size and report layout overflow.', uses: 4 },
  { kind: 'tool', id: 'sha256-text', name: 'SHA-256 of text', node: 'box', tags: ['hash'], description: 'Hash a string.', uses: 1 },
  { kind: 'tool', id: 'app-publish', name: 'Publish app', node: 'lap', tags: ['app-cloud', 'publish'], description: 'Register a web app in the App Cloud with a launch recipe and wait for /healthz.', uses: 2 },
  { kind: 'applet', id: 'wordcloud', name: 'Word cloud', node: 'box', tags: ['applet'], description: 'Word cloud: web applet in the App Cloud on box' },
  { kind: 'tool', id: 'log-parse', name: 'Log parser', node: 'box', tags: ['logs'], description: 'Parse transcript logs into rows.', uses: 0 },
];
const ids = (m) => m.map((x) => x.id);

test('stem and keywords: plurals, -ing, -ed, stop words', () => {
  assert.equal(T.stem('screenshots'), 'screenshot');
  assert.equal(T.stem('publishing'), 'publish');
  assert.equal(T.stem('published'), 'publish');
  assert.equal(T.stem('publishes'), 'publish');
  assert.equal(T.stem('queries'), 'query');
  assert.equal(T.stem('class'), 'class');
  assert.deepEqual(T.keywords('Take the screenshots, and publish the app'), ['take', 'screenshot', 'publish', 'app']);
  assert.deepEqual(T.keywords('write a new tool for the task'), [], 'only generic words');
});

test('matchTools: a task about screenshots names the screenshot tool, one about publishing an app the publisher', () => {
  assert.deepEqual(ids(T.matchTools(CATALOG, 'Verify the layout with screenshots at 390x844 and fix overflow')), ['screenshot-check']);
  const pub = T.matchTools(CATALOG, 'Publish the new dashboard as an app in the App Cloud, with a launch recipe');
  assert.equal(pub[0].id, 'app-publish');
  assert.ok(ids(pub).includes('wordcloud'), 'the applet shares the App Cloud words');
  assert.ok(pub.length <= 3);
});

test('matchTools: unrelated tasks and generic words match nothing; ties go to the most used', () => {
  assert.deepEqual(T.matchTools(CATALOG, 'Refactor the planner and write unit tests'), []);
  assert.deepEqual(T.matchTools(CATALOG, 'make a new tool'), []);
  assert.deepEqual(T.matchTools([], 'screenshots'), []);
  assert.deepEqual(T.matchTools(undefined, 'screenshots'), []);
  const twin = [{ id: 'a-hash', name: 'A hash', description: 'x', uses: 1 }, { id: 'b-hash', name: 'B hash', description: 'x', uses: 9 }];
  assert.deepEqual(ids(T.matchTools(twin, 'hash it')), ['b-hash', 'a-hash']);
  assert.equal(T.matchTools(CATALOG, 'screenshot ui qa layout overflow', { limit: 1 }).length, 1);
});

test('matchTools: a description alone needs three words, a tag plus a description word is enough', () => {
  const e = [{ id: 'zz', name: 'Zz', tags: ['transcript'], description: 'Turns a session into rows.' }];
  assert.deepEqual(ids(T.matchTools(e, 'transcript rows')), ['zz']);
  assert.deepEqual(T.matchTools(e, 'session'), [], 'one description word is too weak');
  assert.deepEqual(ids(T.matchTools(e, 'turns session rows')), ['zz']);
});

test('briefSection / planNote: names the tools, stays short, says nothing extra without a match', () => {
  const sec = T.briefSection(T.matchTools(CATALOG, 'Take screenshots of the app and publish it'));
  assert.match(sec, /^## Reusable tools\n/);
  assert.match(sec, /tool_list/);
  assert.match(sec, /tool_register/);
  assert.match(sec, /tool_run/);
  assert.match(sec, /`screenshot-check` \(tool on box\)/);
  assert.match(sec, /`app-publish` \(tool on lap\)/);
  const bare = T.briefSection([]);
  assert.doesNotMatch(bare, /Likely matches/);
  assert.match(bare, /tool_list/);
  const applet = T.hintLines([CATALOG[3]])[0];
  assert.match(applet, /^- `wordcloud` \(applet on box\): Word cloud/);
  assert.match(T.planNote(T.matchTools(CATALOG, 'screenshots')), /Filed tools that fit this goal:\n {2}- `screenshot-check`/);
  assert.doesNotMatch(T.planNote([]), /Filed tools/);
  const long = T.hintLines([{ id: 'x', description: 'a'.repeat(300) }], { width: 40 })[0];
  assert.ok(long.length < 80 && long.endsWith('…'));
});

const approxTokens = (s) => Math.ceil(s.length / 4);

test('token budget: each addition for agents stays under 300 tokens (with three matches)', () => {
  const three = T.matchTools(CATALOG, 'screenshots app publish word cloud', { limit: 3 });
  assert.equal(three.length, 3);
  const brief = T.briefSection(three);
  const plan = T.planNote(T.matchTools(CATALOG, 'screenshots app publish word cloud', { limit: 5 }));
  const setup = T.AGENT_NOTE;
  for (const [name, text] of [['brief', brief], ['plan', plan], ['setup', setup]]) assert.ok(approxTokens(text) < 300, `${name} is ${approxTokens(text)} tokens`);
  assert.ok(approxTokens(T.BRIEF_NOTE) < 150);
});

test('agent instructions from setup carry the tool note exactly once, with plain backticks', () => {
  const text = S.agentInstructions();
  assert.equal(text.split(T.AGENT_NOTE).length - 1, 1);
  assert.match(text, /\*\*Reusable tools\*\*.*`tool_list`.*`tool_run`.*`tool_register`/);
  assert.doesNotMatch(text, /\\`/, 'no stray escapes in the written file');
});

const project = { id: 'p1', name: 'Demo', owner: 'box', goal: 'ship the dashboard', tasks: [], repo: { node: 'box', path: '' }, selfDev: null };
const task = (title, description) => ({ id: 't1', title, kind: 'code', size: 'M', deps: [], assign: { node: 'box', provider: 'claude', model: 'claude-sonnet-5-5', effort: 'high' }, description, acceptance: ['it works'], verify: 'npm test' });

test('taskPrompt: a brief for a task about screenshots and app publishing names the matching tools', () => {
  const t = task('Publish the dashboard app', 'Take screenshots of the finished app at phone size, then publish it to the App Cloud.');
  const text = P.taskPrompt(project, t, CATALOG);
  assert.match(text, /## Reusable tools\n/);
  assert.match(text, /Likely matches for this task/);
  assert.match(text, /`screenshot-check`/);
  assert.match(text, /`app-publish`/);
  assert.ok(text.indexOf('## Reusable tools') < text.indexOf('## How to work'));
  assert.deepEqual(ids(P.toolHints(CATALOG, t)).slice(0, 2).sort(), ['app-publish', 'screenshot-check']);
});

test('taskPrompt: no catalog (older ctx, mesh slow) still carries the paragraph, without matches', () => {
  const text = P.taskPrompt(project, task('Fix a typo', 'Fix the typo in the README.'));
  assert.match(text, /## Reusable tools\n.*tool_list/s);
  assert.doesNotMatch(text, /Likely matches/);
});

test('usage log: tool runs, searches and hints are counted per tool and kept out of the token ledger', async () => {
  const now = Date.now();
  await U.recordToolEvent({ event: 'run', toolId: 'screenshot-check', ok: true, durationMs: 800, trace: 'tr-20261018-aaaaaaaaaaaa', seat: 'team-x@rig', ts: now - 5000 });
  await U.recordToolEvent({ event: 'run', toolId: 'screenshot-check', ok: false, error: 'boom', ts: now - 4000 });
  await U.recordToolEvent({ event: 'run', toolId: 'sha256-text', ts: now - 3000 });
  await U.recordToolEvent({ event: 'list', query: 'screenshot', toolIds: ['screenshot-check', 'wordcloud'], ts: now - 2000 });
  await U.recordToolEvent({ event: 'list', query: 'nothing like it', toolIds: [], ts: now - 1500 });
  await U.recordToolEvent({ event: 'hint', toolIds: ['screenshot-check'], query: 'Publish the dashboard app', ts: now - 1000 });
  await U.recordToolEvent({ event: 'bogus', toolId: 'x', ts: now - 500 });
  const events = await U.readToolEvents({ since: now - 60000 });
  assert.equal(events.length, 7);
  assert.equal(events[0].toolId, 'screenshot-check');
  assert.equal(events[0].seat, 'team-x@rig');
  assert.equal(events[6].event, 'run', 'an unknown event kind is stored as a run');
  const r = U.toolReuse(events);
  assert.deepEqual([r.runs, r.failed, r.lists, r.listHits, r.listMisses, r.hinted], [4, 1, 2, 1, 1, 1]);
  const shot = r.byTool.find((x) => x.id === 'screenshot-check');
  assert.deepEqual([shot.runs, shot.failed, shot.listed, shot.hinted], [2, 1, 1, 1]);
  assert.equal(r.byTool[0].id, 'screenshot-check', 'most run first');
  assert.equal(r.byTool.find((x) => x.id === 'wordcloud').listed, 1);
  // not a token-ledger record: the monthly token files are untouched and the report's totals ignore it
  assert.deepEqual(fs.readdirSync(path.join(process.env.RIGS_HOME, 'usage')).filter((f) => /^\d{4}-\d{2}\.jsonl$/.test(f)), []);
  const rep = await U.report({ since: '1h' });
  assert.equal(rep.totals.count, 0);
  assert.equal(rep.toolReuse.runs, 4);
  assert.equal((await U.readToolEvents({ since: now + 60000 })).length, 0);
});

test('usage log: the mesh view adds every node\'s tool reuse', () => {
  const a = { runs: 2, failed: 1, lists: 1, listHits: 1, listMisses: 0, hinted: 0, byTool: [{ id: 'x', runs: 2, failed: 1, listed: 1, hinted: 0 }] };
  const b = { runs: 3, failed: 0, lists: 2, listHits: 1, listMisses: 1, hinted: 2, byTool: [{ id: 'x', runs: 1, failed: 0, listed: 0, hinted: 1 }, { id: 'y', runs: 2, failed: 0, listed: 1, hinted: 1 }] };
  const sum = U.addToolReuse(a, b);
  assert.deepEqual([sum.runs, sum.failed, sum.lists, sum.listHits, sum.listMisses, sum.hinted], [5, 1, 3, 2, 1, 2]);
  assert.deepEqual(sum.byTool, [{ id: 'x', runs: 3, failed: 1, listed: 1, hinted: 1 }, { id: 'y', runs: 2, failed: 0, listed: 1, hinted: 1 }]);
  assert.deepEqual(U.addToolReuse(U.emptyToolReuse(), undefined), U.emptyToolReuse());
  const agg = U.aggregateUsage([{ node: { name: 'a' }, report: { totals: U.totals([]), groups: {}, records: [], toolReuse: a } }, { node: { name: 'b' }, report: { totals: U.totals([]), groups: {}, records: [], toolReuse: b } }]);
  assert.equal(agg.toolReuse.runs, 5);
  assert.equal(U.aggregateUsage([{ node: { name: 'a' }, error: 'down' }]).toolReuse.runs, 0);
});
