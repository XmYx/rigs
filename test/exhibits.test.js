// Exhibits (src/exhibits.js): spans and project saves → exhibit entries, the append-only document, SVG images, the
// Markdown/HTML export, redaction of every caption and visual, the opt-in switch — and one JARVIS request end to end
// through a scratch node whose brain is a fake `claude` (no files while disabled; a final document once enabled).
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { after, test } from 'node:test';
import { fileURLToPath } from 'node:url';
import { freePort } from './ports.js';

const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'rigs-exhibits-'));
Object.assign(process.env, {
  RIGS_HOME: path.join(TMP, 'rigs'), RIGS_NO_OPENRIG: '1', RIGS_NO_AUTOUPDATE: '1', RIGS_NO_MIGRATIONS: '1', RIGS_NAME: 'test-node',
});
after(() => fs.rmSync(TMP, { recursive: true, force: true }));

const X = await import('../src/exhibits.js');
const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

const TR = 'tr-20261018-0123456789ab';
const span = (o) => ({ traceId: TR, spanId: 'sp-' + (o.id || 'aaaaaaaaaaaa'), parentId: '', node: 'test-node', start: 1000, end: 2000, status: 'ok', input: null, output: null, meta: {}, ...o });
const SECRETS = ['sk-ant-api03-SECRETSECRETSECRET', 'ghp_abcdefghijklmnopqrstuvwxyz0123', 'hunter2hunter2', 'eyJhbGciOiJIUzI1.eyJzdWIiOiIxMjM0.c2lnbmF0dXJlMTIz', 'Bearer abc.def.ghi'];
const assertClean = (v, what) => { const s = typeof v === 'string' ? v : JSON.stringify(v); for (const leak of ['SECRETSECRETSECRET', 'abcdefghijklmnopqrstuvwxyz0123', 'hunter2hunter2', 'c2lnbmF0dXJlMTIz', 'abc.def.ghi']) assert.ok(!s.includes(leak), `${leak} leaked in ${what}: ${s.slice(0, 400)}`); };

// A request whose every stage carries a secret somewhere.
const FIXTURE = [
  span({ id: '000000000001', kind: 'intake', name: 'jarvis/send', end: null, status: 'running', input: `deploy with key ${SECRETS[0]} please` }),
  span({ id: '000000000002', parentId: 'sp-000000000001', kind: 'router', name: 'route', output: { route: 'implement' }, meta: { route: 'implement', via: 'jev', reason: `token=${SECRETS[2]} in the text`, routerMs: 420 } }),
  span({ id: '000000000003', parentId: 'sp-000000000001', kind: 'brain-turn', name: 'claude claude-opus-5-5', start: 2000, end: 9000, meta: { model: 'claude-opus-5-5', effort: 'high', inputTokens: 1200, outputTokens: 300 } }),
  span({ id: '000000000004', parentId: 'sp-000000000003', kind: 'tool-call', name: 'Edit', input: { file_path: '/repo/src/app.js', old_string: 'a', new_string: `const auth = "${SECRETS[4]}";\nconst pw = 'password=${SECRETS[2]}';\nexport default auth;` } }),
  span({ id: '000000000005', parentId: 'sp-000000000003', kind: 'tool-call', name: 'Bash', input: { command: 'ls' } }),
  span({ id: '000000000006', parentId: 'sp-000000000003', kind: 'handoff', name: 'project_create', input: { goal: `Ship it (jwt ${SECRETS[3]})` }, meta: { projectId: 'p0001', taskIds: ['t1', 't2'] } }),
  span({ id: '000000000007', parentId: 'sp-000000000006', kind: 'plan', name: 'plan Ship it', output: { summary: 'Two steps.', tasks: [{ id: 't1', title: 'Build' }, { id: 't2', title: 'Test' }] } }),
  span({ id: '000000000008', parentId: 'sp-000000000006', kind: 'dispatch', name: 't1 → mac', input: { task: { id: 't1', title: 'Build' }, node: 'mac', provider: 'claude', model: 'claude-sonnet-5-5' }, meta: { projectId: 'p0001', taskId: 't1', attempt: 1, target: 'mac' } }),
  span({ id: '000000000009', parentId: 'sp-000000000003', kind: 'assistant', name: 'msg' }),
  span({ id: '000000000001', kind: 'intake', name: 'jarvis/send', start: 1000, end: 12000, input: `deploy with key ${SECRETS[0]} please`, output: { text: `Done, sir. I used ${SECRETS[1]}.` } }),
];

test('settings: off by default; the config patch is validated', () => {
  assert.deepEqual(X.settings({}), { enabled: false, images: 'auto', maxPerDoc: 60, maxDocs: 200 });
  assert.equal(X.settings({ exhibits: { enabled: 'yes' } }).enabled, false, 'only a real true switches it on');
  assert.deepEqual(X.applyConfigPatch({}, { enabled: true, images: 'svg', maxPerDoc: 20 }), { enabled: true, images: 'svg', maxPerDoc: 20, maxDocs: 200 });
  assert.throws(() => X.applyConfigPatch({}, { maxDocs: 3 }), /maxDocs/);
  assert.throws(() => X.applyConfigPatch({}, { images: 'gif' }), /images must be/);
  assert.throws(() => X.applyConfigPatch({}, { maxPerDoc: 1 }), /maxPerDoc/);
  assert.ok(X.isDocId(TR) && X.isDocId('pr-abc12') && !X.isDocId('../etc') && !X.isDocId('pr-'));
});

test('spanToExhibit: the stages that make entries, in kinds the UI knows; noise makes none', () => {
  const kinds = FIXTURE.map((s) => X.spanToExhibit(s).map((d) => d.kind).join(',') || '-');
  assert.deepEqual(kinds, ['intake', 'step', 'step', 'code', '-', 'milestone', 'plan', 'step', '-', 'result']);
  const all = FIXTURE.flatMap(X.spanToExhibit);
  for (const d of all) {
    assert.ok(X.ENTRY_KINDS.includes(d.kind));
    assert.ok(d.title && d.caption, JSON.stringify(d));
    assert.ok(['steps', 'code', 'metrics', 'status'].includes(d.visual?.kind), JSON.stringify(d.visual));
    assert.ok(d.caption.length <= 240 && d.title.length <= 90);
  }
  const [route] = X.spanToExhibit(FIXTURE[1]);
  assert.equal(route.title, 'Routed: implement');
  const [code] = X.spanToExhibit(FIXTURE[3]);
  assert.deepEqual([code.visual.file, code.visual.language], ['app.js', 'javascript']);
  const [reply] = X.spanToExhibit(FIXTURE.at(-1));
  assert.equal(reply.final, true);
  assert.notEqual(reply.id, X.spanToExhibit(FIXTURE[0])[0].id, 'start and end of one span are separate entries');
  assert.equal(X.spanToExhibit(span({ kind: 'task', end: null, status: 'running', input: { task: { id: 't1', title: 'Build' } }, meta: { projectId: 'p1', taskId: 't1' } }))[0].projectId, 'p1');
  assert.deepEqual(X.spanToExhibit(span({ kind: 'task' })), [], 'a run end is told by the project save');
  assert.deepEqual(X.spanToExhibit(span({ kind: 'router', end: null, status: 'running' })), [], 'running stages wait for their end');
  assert.deepEqual(X.spanToExhibit(null), []);
});

test('liveLine: a present-tense "now" line for each running stage, redacted; none once it ends', () => {
  const run = (o) => X.liveLine(span({ end: null, status: 'running', ...o }));
  assert.equal(run({ kind: 'intake' }).text, 'Request received — on it.');
  assert.equal(run({ kind: 'brain-turn', meta: { model: 'claude-opus-5-5' } }).text, 'Thinking with claude-opus-5-5…');
  assert.equal(run({ kind: 'tool-call', name: 'mcp__rigs__project_create' }).text, 'Using project create…');
  assert.equal(run({ kind: 'tool-call', name: 'Edit', input: { file_path: '/a/b/app.js' } }).text, 'Using Edit on app.js…');
  assert.equal(run({ kind: 'dispatch', input: { task: { id: 't1' } }, meta: { target: 'mac' } }).text, 'Sending t1 to mac…');
  assert.equal(run({ kind: 'intake' }).docId, TR);
  assertClean(run({ kind: 'brain-turn', meta: { model: SECRETS[0] } }), 'live line');
  assert.equal(X.liveLine(FIXTURE[1]), null, 'ended stage');
  assert.equal(run({ kind: 'assistant' }), null);
});

test('redaction: no token or secret from the fixture reaches a caption, visual or export', () => {
  const all = FIXTURE.flatMap(X.spanToExhibit);
  assertClean(all, 'drafts');
  let doc = X.emptyDoc(TR);
  for (const d of all) doc = X.mergeIntoDocument(doc, { t: 'entry', ...d }).doc;
  doc = X.mergeIntoDocument(doc, { t: 'meta', title: `please use ${SECRETS[0]}` }).doc;
  assertClean(X.documentToMarkdown(doc), 'markdown');
  assertClean(X.documentToHTML(doc), 'html');
  const proj = X.projectToExhibits({ status: 'running', tasks: [{ id: 't1', status: 'running' }] }, { status: 'done', name: 'P', tasks: [{ id: 't1', title: 'Build', status: 'done', summary: `pushed with ${SECRETS[1]}` }] });
  assertClean(proj, 'project entries');
});

test('mergeIntoDocument: numbered, deduplicated, final closes it, maxPerDoc keeps the ending; pure', () => {
  const d0 = X.emptyDoc(TR);
  const a = X.mergeIntoDocument(d0, { t: 'entry', id: 'a', kind: 'intake', title: 'A', caption: 'a', at: 5 });
  assert.deepEqual(d0.entries, [], 'input untouched');
  assert.equal(a.entry.seq, 1);
  assert.equal(a.entry.docId, TR);
  assert.equal(a.entry.scope, 'request');
  assert.equal(X.mergeIntoDocument(a.doc, { t: 'entry', id: 'a', title: 'again' }).changed, false, 'same id once');
  const b = X.mergeIntoDocument(a.doc, { t: 'entry', id: 'b', kind: 'weird', title: 'B', at: 6 });
  assert.deepEqual([b.entry.seq, b.entry.kind], [2, 'step']);
  // cap: past maxPerDoc only a final entry gets in
  const full = X.mergeIntoDocument(b.doc, { t: 'entry', id: 'c', title: 'C' }, { maxPerDoc: 2 });
  assert.deepEqual([full.entry, full.doc.dropped, full.doc.entries.length], [null, 1, 2]);
  const fin = X.mergeIntoDocument(full.doc, { t: 'entry', id: 'z', kind: 'result', title: 'Z', final: true, at: 9 }, { maxPerDoc: 2 });
  assert.deepEqual([fin.doc.final, fin.doc.finalAt, fin.entry.seq], [true, 9, 3]);
  assert.equal(X.mergeIntoDocument(fin.doc, { t: 'entry', id: 'late', title: 'L' }).changed, false, 'final takes nothing new');
  const img = X.mergeIntoDocument(fin.doc, { t: 'image', id: 'a', image: { src: 'x.png', alt: 'a', source: 'comfyui' } });
  assert.equal(img.doc.entries[0].image.source, 'comfyui', 'an image can still land after final');
  assert.equal(X.mergeIntoDocument(X.emptyDoc('pr-p1'), { t: 'entry', id: 'q', title: 'Q' }).entry.projectId, 'p1');
});

test('parseDocument replays the JSONL exactly (bad lines skipped)', () => {
  const recs = [{ t: 'meta', at: 1, title: 'Hello' }, { t: 'entry', id: 'a', kind: 'intake', title: 'A', at: 2 }, { t: 'entry', id: 'b', kind: 'result', title: 'B', at: 3, final: true }, { t: 'image', id: 'a', image: { src: 'i.png', source: 'comfyui' } }];
  let doc = X.emptyDoc(TR);
  for (const r of recs) doc = X.mergeIntoDocument(doc, r).doc;
  const text = recs.map((r) => JSON.stringify(r)).join('\n') + '\n{broken\n';
  assert.deepEqual(X.parseDocument(TR, text), doc);
  assert.deepEqual(X.docSummary(doc).kinds, ['intake', 'result']);
});

test('projectToExhibits: baseline first; task outcomes and project done (final)', () => {
  const p = (status, tasks) => ({ id: 'p1', name: 'Proj', goal: 'Goal', status, updatedAt: 50, tasks });
  assert.deepEqual(X.projectToExhibits(null, p('running', [{ id: 't1', status: 'done' }])), [], 'first sight is a baseline');
  const r = X.projectToExhibits(p('running', [{ id: 't1', status: 'running' }, { id: 't2', status: 'todo' }]), p('running', [{ id: 't1', title: 'Build', status: 'done', summary: 'Built it.' }, { id: 't2', title: 'Test', status: 'failed' }]));
  assert.deepEqual(r.map((d) => [d.kind, d.title]), [['result', 't1 done: Build'], ['milestone', 't2 failed: Test']]);
  assert.equal(r[0].caption, 'Built it.');
  const done = X.projectToExhibits(p('running', [{ id: 't1', status: 'done' }]), p('done', [{ id: 't1', title: 'Build', status: 'done' }]));
  assert.deepEqual([done[0].kind, done[0].final], ['summary', true]);
  assert.deepEqual(X.projectToExhibits(p('running', []), { ...p('done', []), main: true }), [], 'the standing project never finishes');
});

// A project that was already running when exhibits came on: three tasks done / running / waiting, with a log.
const RUNNING = () => ({
  id: 'p0777', name: 'Backfill me', goal: 'Do the thing', request: `do the thing with key ${SECRETS[0]}`, summary: 'Three steps.', status: 'running', createdAt: 1000, updatedAt: 9000,
  log: [{ ts: 1500, text: 'planned 3 tasks' }, { ts: 2000, text: 't1 started on mac via seat-a' }, { ts: 5000, text: 't1 → done: built it' }],
  tasks: [
    { id: 't1', title: 'Build', status: 'done', summary: 'Built it.', attempts: 0, deps: [], assign: { node: 'mac', model: 'claude-opus-5-5' }, run: { seat: 'seat-a', startedAt: 2000 } },
    { id: 't2', title: 'Test', status: 'running', deps: ['t1'], assign: { node: 'mac', model: 'claude-opus-5-5' }, run: { seat: 'seat-b', startedAt: 6000 } },
    { id: 't3', title: 'Review', status: 'todo', deps: ['t1', 't2'], assign: { node: 'mac' } },
  ],
});

test('projectBackfill: intake, plan, a step per task and the outcomes so far; same ids as the live path; pure and redacted', () => {
  const p = RUNNING();
  const frozen = JSON.stringify(p);
  const r = X.projectBackfill(p);
  assert.equal(JSON.stringify(p), frozen, 'input untouched');
  assert.deepEqual(r.map((d) => `${d.kind}:${d.title}`), ['intake:Request received', 'plan:Plan: 3 tasks', 'step:t1 started', 'result:t1 done: Build', 'step:t2 started', 'step:t3 waiting']);
  assert.deepEqual(r.map((d) => d.at), [1000, 1500, 2000, 5000, 6000, 9000], 'times come from the project and its log');
  assert.ok(r.every((d) => d.id && d.caption && d.visual && !d.final));
  assert.equal(r[3].id, 'task:t1:done:0', 'the outcome uses the live path id, so a later live save cannot duplicate it');
  assert.match(r[0].caption, /^Sir asked: “do the thing with key sk-ant-\*\*\*/);
  assertClean(r, 'the backfill');
  assert.match(r[5].caption, /waits for t1, t2/);
  // a finished project ends on the final summary
  const done = X.projectBackfill({ ...RUNNING(), status: 'done', tasks: RUNNING().tasks.map((t) => ({ ...t, status: 'done' })) });
  assert.equal(done.at(-1).kind, 'summary');
  assert.equal(done.at(-1).final, true);
  assert.deepEqual(X.projectBackfill({ ...RUNNING(), main: true }), [], 'the standing project has no document');
  assert.deepEqual(X.projectBackfill(null), []);
  // a thin project (no log, no run records) still works
  assert.deepEqual(X.projectBackfill({ id: 'p1', tasks: [{ id: 't1', title: 'A', status: 'running' }] }).map((d) => d.kind), ['intake', 'plan', 'step']);
});

test('service attach: off → refused; on → document built; twice adds nothing; later live saves append', async () => {
  const home = path.join(TMP, 'attach');
  let on = false;
  const svc = X.createExhibits({ home, getSettings: () => ({ enabled: on, images: 'svg', maxPerDoc: 60 }) });
  await assert.rejects(svc.attach(RUNNING()), /exhibits are off/);
  assert.equal(fs.existsSync(path.join(home, 'exhibits')), false, 'nothing written while off');
  on = true;
  await assert.rejects(svc.attach({ ...RUNNING(), main: true }), /not a project/);

  const a = await svc.attach(RUNNING());
  assert.deepEqual(a, { docId: 'pr-p0777', added: 6, entries: 6, final: false });
  const file = path.join(home, 'exhibits', 'pr-p0777.jsonl');
  const first = fs.readFileSync(file, 'utf8');
  assert.match(first.split('\n')[0], /^\{"t":"meta".*"title":"Backfill me"/);
  assertClean(first, 'the stored file');
  const b = await svc.attach(RUNNING());
  assert.deepEqual(b, { docId: 'pr-p0777', added: 0, entries: 6, final: false });
  assert.equal(fs.readFileSync(file, 'utf8'), first, 'the second attach appends nothing to the file');

  // t2 finishes: the live save appends (the attach seeded the baseline, so this is a diff, not a first sight)
  const next = RUNNING(); next.tasks[1].status = 'done'; next.tasks[1].summary = 'Tested.'; next.updatedAt = 9500;
  svc.handleProject(next);
  await svc.flush();
  let doc = await svc.get('pr-p0777');
  assert.equal(doc.entries.length, 7);
  assert.equal(doc.entries.at(-1).title, 't2 done: Test');
  assert.deepEqual(doc.entries.map((e) => e.seq), [1, 2, 3, 4, 5, 6, 7]);
  // ...and attaching again afterwards, with t2 now done, still adds only what is new
  const c = await svc.attach(next);
  assert.equal(c.added, 0, 'the live t2 entry is recognised');
  assert.equal(c.entries, 7);

  // a file written behind the service's back (the one-off script, another process) is picked up, not shadowed by the cache
  const other = X.createExhibits({ home, getSettings: () => ({ enabled: true, images: 'svg', maxPerDoc: 60 }) });
  const later = RUNNING(); later.tasks[2].status = 'running'; later.tasks[2].run = { seat: 'seat-c', startedAt: 9600 }; later.updatedAt = 9600;
  assert.equal((await other.attach(later)).added, 1, 't3 started: the one new step');
  assert.equal((await svc.get('pr-p0777')).entries.length, 8, 'svc sees the entry the other service wrote');
  svc.handleProject({ ...later, tasks: later.tasks.map((t) => (t.id === 't3' ? { ...t, status: 'done', summary: 'Reviewed.' } : t)) });
  await svc.flush();
  doc = await svc.get('pr-p0777');
  assert.deepEqual(doc.entries.map((e) => e.seq), [1, 2, 3, 4, 5, 6, 7, 8, 9], 'a live save lands after it, numbered on');
  assert.equal(doc.entries.at(-1).title, 't3 done: Review');
  assert.equal(new Set(doc.entries.map((e) => e.id)).size, 9);

  // a restart reads it back, and a finished project closes the document
  const again = X.createExhibits({ home, getSettings: () => ({ enabled: true, images: 'svg', maxPerDoc: 60 }) });
  assert.equal((await again.get('pr-p0777')).entries.length, 9);
  const fin = RUNNING(); fin.status = 'done'; fin.tasks.forEach((t) => { t.status = 'done'; });
  const d = await again.attach(fin);
  assert.equal(d.final, true);
  assert.equal((await again.get('pr-p0777')).entries.at(-1).kind, 'summary');
  const md = (await again.exportDoc('pr-p0777', 'md')).body;
  assert.match(md, /^# Backfill me\n/);
  assertClean(md, 'the export');
});

test('svgFor: deterministic, themed per kind, escaped', () => {
  const e = { id: 'sp-1:end', kind: 'code', seq: 3, title: 'Edited <app>.js & more words that wrap across several lines of the card' };
  const a = X.svgFor(e, { docTitle: 'Ship "it"' });
  assert.equal(a, X.svgFor(e, { docTitle: 'Ship "it"' }), 'same entry, same picture');
  assert.notEqual(a, X.svgFor({ ...e, id: 'other' }, { docTitle: 'Ship "it"' }));
  assert.match(a, /^<svg xmlns="http:\/\/www\.w3\.org\/2000\/svg"/);
  assert.match(a, /CODE · 03/);
  assert.ok(a.includes('&lt;app&gt;.js &amp;') && !a.includes('<app>'), 'title escaped');
  assert.ok(a.includes('Ship &quot;it&quot;'));
  for (const kind of X.ENTRY_KINDS) assert.match(X.svgFor({ id: kind, kind, title: kind }), /<\/svg>$/);
  const img = X.svgImage(e, 'Doc');
  assert.equal(img.source, 'svg');
  assert.match(img.src, /^data:image\/svg\+xml;base64,/);
  assert.equal(Buffer.from(img.src.split(',')[1], 'base64').toString(), X.svgFor(e, { docTitle: 'Doc' }));
});

test('export: Markdown and one self-contained HTML page (images inline, no scripts, escaped)', () => {
  let doc = X.mergeIntoDocument(X.emptyDoc(TR), { t: 'meta', title: 'Make <b>it</b>' }).doc;
  for (const d of FIXTURE.flatMap(X.spanToExhibit)) {
    const r = X.mergeIntoDocument(doc, { t: 'entry', ...d });
    doc = X.mergeIntoDocument(doc, { t: 'entry', ...d, image: X.svgImage(r.entry, doc.title) }).doc;
  }
  assert.equal(doc.final, true);
  const md = X.documentToMarkdown(doc);
  assert.match(md, /^# Make <b>it<\/b>/);
  assert.match(md, /8 exhibits · final/);
  assert.match(md, /## 1\. Request received/);
  assert.match(md, /!\[intake: Request received\]\(data:image\/svg\+xml;base64,/);
  assert.match(md, /```javascript\n/);
  const html = X.documentToHTML(doc);
  assert.match(html, /^<!doctype html>/);
  assert.ok(!/<script/i.test(html), 'no scripts');
  assert.ok(!/src="(?!data:)/.test(html), 'every image is a data URI');
  assert.equal((html.match(/<img /g) || []).length, 8);
  assert.ok(html.includes('Make &lt;b&gt;it&lt;/b&gt;'));
  assert.match(html, /prefers-color-scheme: light/);
  const custom = X.documentToHTML(doc, { image: (e) => (e.seq === 1 ? 'data:image/png;base64,AAAA' : '') });
  assert.equal((custom.match(/<img /g) || []).length, 1);
});

test('aggregateExhibits: per-node lists, newest first, unreachable nodes noted', () => {
  const r = X.aggregateExhibits([{ node: 'a', enabled: true, docs: [{ docId: 'x', updated: 1 }] }, { node: 'b', enabled: false, docs: [{ docId: 'y', updated: 5 }] }, { node: 'c', error: 'down' }]);
  assert.deepEqual(r.docs.map((d) => [d.docId, d.node]), [['y', 'b'], ['x', 'a']]);
  assert.deepEqual(r.nodes.map((n) => n.node), ['a', 'b', 'c']);
});

test('service: disabled writes nothing; enabled builds request + project documents and finalizes them', async () => {
  const home = path.join(TMP, 'svc');
  let on = false;
  const svc = X.createExhibits({ home, getSettings: () => ({ enabled: on, images: 'svg', maxPerDoc: 60 }) });
  for (const s of FIXTURE) svc.handleSpan(s);
  await svc.flush();
  assert.equal(fs.existsSync(path.join(home, 'exhibits')), false, 'nothing written while disabled');

  on = true;
  const seen = [];
  const listener = (e) => seen.push(e);
  X.events.on('entry', listener);
  const t0 = performance.now();
  for (const s of FIXTURE) svc.handleSpan(s);
  assert.ok(performance.now() - t0 < 20, 'handleSpan only queues');
  // a span for the same trace after the reply is ignored by the (final) request document
  svc.handleSpan(span({ id: '00000000000a', kind: 'dispatch', name: 't2 → mac', input: { task: { id: 't2', title: 'Test' }, node: 'mac' }, meta: { projectId: 'p0001', taskId: 't2', attempt: 1, target: 'mac' } }));
  await svc.flush();
  X.events.off('entry', listener);
  const doc = await svc.get(TR);
  assert.deepEqual(doc.entries.map((e) => e.kind), ['intake', 'step', 'step', 'code', 'milestone', 'plan', 'step', 'result']);
  assert.deepEqual(doc.entries.map((e) => e.seq), [1, 2, 3, 4, 5, 6, 7, 8]);
  assert.equal(doc.final, true);
  assert.ok(doc.entries.every((e) => e.image?.source === 'svg' && e.caption && e.visual));
  assert.ok(doc.title.startsWith('deploy with key sk-ant-***'), doc.title);
  assertClean(fs.readFileSync(path.join(home, 'exhibits', TR + '.jsonl'), 'utf8'), 'the stored file');
  assert.ok(seen.some((e) => e.docId === TR && e.entry.kind === 'result' && e.final));

  // the project document: handoff, plan and dispatches (also the one after the reply), then task + project outcomes
  const P = { id: 'p0001', name: 'Ship it', goal: 'Ship', status: 'running', tasks: [{ id: 't1', title: 'Build', status: 'running' }, { id: 't2', title: 'Test', status: 'todo' }] };
  svc.handleProject(P);
  P.tasks[0].status = 'done'; P.tasks[0].summary = 'Built.';
  svc.handleProject(P); // a snapshot is taken at call time
  P.tasks[1].status = 'done'; P.status = 'done';
  svc.handleProject(P);
  await svc.flush();
  const pd = await svc.get('pr-p0001');
  assert.deepEqual(pd.entries.map((e) => `${e.kind}:${e.title}`), ['milestone:Work filed', 'plan:Plan: 2 tasks', 'step:t1 sent to mac', 'step:t2 sent to mac', 'result:t1 done: Build', 'result:t2 done: Test', 'summary:Ship it complete']);
  assert.equal(pd.final, true);
  assert.equal(pd.scope, 'project');
  assert.equal(pd.title, 'Ship it');

  // a fresh service (a restart) reads the same documents back from disk
  const again = X.createExhibits({ home, getSettings: () => ({ enabled: true, images: 'svg', maxPerDoc: 60 }) });
  assert.deepEqual((await again.get(TR)).entries, doc.entries);
  const list = await again.list();
  assert.deepEqual(list.docs.map((d) => d.docId).sort(), ['pr-p0001', TR].sort());
  const html = await again.exportDoc(TR, 'html');
  assert.equal(html.mime, 'text/html; charset=utf-8');
  assert.equal((html.body.match(/<img src="data:image\/svg\+xml/g) || []).length, 8);
  assert.equal((await again.exportDoc(TR, 'md')).ext, 'md');
  assert.equal(await again.get('../../etc'), null);
  assert.equal(await again.image(TR, '../x.png'), null);
});

test('service: ComfyUI pictures replace the SVG when they land; export inlines the PNG; unreachable ComfyUI → SVG only', async () => {
  const home = path.join(TMP, 'svc-comfy');
  const PNG = Buffer.from('89504e470d0a1a0a0000000d49484452', 'hex');
  const submitted = [];
  const comfy = {
    models: async () => ({ presets: [{ id: 'sdxl' }] }),
    submit: async (b) => { submitted.push(b); return { id: 'j' + submitted.length, state: 'queued' }; },
    job: (id) => ({ id, state: 'done', outputs: [{ filename: id + '.png', subfolder: '', type: 'output' }] }),
    view: async () => ({ arrayBuffer: async () => PNG }),
    cancel: async () => {},
  };
  const svc = X.createExhibits({ home, comfy, comfyPollMs: 5, getSettings: () => ({ enabled: true, images: 'auto', maxPerDoc: 60 }) });
  for (const s of FIXTURE) svc.handleSpan(s);
  await svc.flush();
  await svc.comfyIdle();
  await svc.flush();
  const doc = await svc.get(TR);
  const pics = doc.entries.filter((e) => e.image?.source === 'comfyui');
  assert.deepEqual(pics.map((e) => e.kind), ['intake', 'milestone', 'plan', 'result'], 'only the headline entries get a GPU picture');
  // 4 for the request document + the project document's own handoff and plan entries
  assert.deepEqual(submitted.map((b) => [b.kind, b.params.preset, b.label]), Array(6).fill(['txt2img', 'sdxl', 'exhibit']));
  assert.deepEqual((await svc.get('pr-p0001')).entries.map((e) => e.image.source), ['comfyui', 'comfyui', 'svg']);
  assert.ok(submitted.every((b) => !b.params.prompt.includes('SECRET')));
  assert.match(pics[0].image.src, new RegExp(`^api/local/exhibits/${TR}/images/1-[0-9a-f]{10}\\.png$`));
  assert.deepEqual((await svc.image(TR, pics[0].image.file)).bytes, PNG);
  const html = (await svc.exportDoc(TR, 'html')).body;
  assert.equal((html.match(/<img src="data:image\/png;base64,/g) || []).length, 4);
  assert.ok(!html.includes('api/local/exhibits'), 'no links back to the machine');

  const svc2 = X.createExhibits({ home: path.join(TMP, 'svc-nocomfy'), comfy: { models: async () => { throw new Error('unreachable'); } }, getSettings: () => ({ enabled: true, images: 'auto', maxPerDoc: 60 }) });
  for (const s of FIXTURE) svc2.handleSpan(s);
  await svc2.flush();
  await svc2.comfyIdle();
  assert.ok((await svc2.get(TR)).entries.every((e) => e.image.source === 'svg'));
});

// A fake `claude`: answers the router, then as the brain streams a reply with a Write tool call carrying a secret.
const FAKE_CLAUDE = String.raw`#!/usr/bin/env node
const args = process.argv.slice(2);
if (args.includes('--version')) { console.log('9.9.9 (fake)'); process.exit(0); }
const fmt = args[args.indexOf('--output-format') + 1];
if (fmt === 'text') { console.log('{"route":"answer","reason":"a question","title":"Greeting card","work":[]}'); process.exit(0); }
const out = (e) => process.stdout.write(JSON.stringify(e) + '\n');
out({ type: 'system', subtype: 'init', session_id: 'fake-session' });
out({ type: 'stream_event', event: { type: 'content_block_delta', delta: { type: 'text_delta', text: 'Writing it, sir. ' } } });
out({ type: 'assistant', message: { content: [{ type: 'tool_use', id: 'toolu_1', name: 'Write', input: { file_path: '/tmp/card/hello.js', content: 'const key = "sk-ant-api03-SECRETSECRETSECRET";\nconsole.log("hello, sir");' } }] } });
out({ type: 'user', message: { content: [{ type: 'tool_result', tool_use_id: 'toolu_1', content: 'ok' }] } });
out({ type: 'stream_event', event: { type: 'content_block_delta', delta: { type: 'text_delta', text: 'Done, sir.' } } });
out({ type: 'result', subtype: 'success', is_error: false, result: 'Writing it, sir. Done, sir.', session_id: 'fake-session', total_cost_usd: 0.01,
  usage: { input_tokens: 120, output_tokens: 34, cache_read_input_tokens: 0, cache_creation_input_tokens: 0 },
  modelUsage: { 'claude-haiku-5-5': { inputTokens: 120, outputTokens: 34, costUSD: 0.01 } } });
`;

test('API: off by default (no files); switched on, one JARVIS request → a final document with intake, route and reply, exported as HTML and Markdown', { skip: process.platform === 'win32' && 'the fake claude is a POSIX script' }, async () => {
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
  const send = async (text) => {
    const res = await fetch(BASE + '/api/local/jarvis/send', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ text, brain: 'claude', model: 'claude-haiku-5-5' }) });
    const events = (await res.text()).split('\n').filter(Boolean).map((l) => JSON.parse(l));
    assert.ok(events.some((e) => e.type === 'done'), JSON.stringify(events) + log);
    return events.find((e) => e.type === 'trace').traceId;
  };
  try {
    let up = false;
    for (let i = 0; i < 100 && !up; i++) { try { up = (await fetch(BASE + '/api/self')).ok; } catch {} if (!up) await new Promise((r) => setTimeout(r, 200)); }
    assert.ok(up, 'server did not start:\n' + log);
    assert.deepEqual(await (await fetch(BASE + '/api/local/exhibits/config')).json(), { enabled: false, images: 'auto', maxPerDoc: 60, maxDocs: 200 });

    await send('say hello in a file');
    await new Promise((r) => setTimeout(r, 300));
    assert.equal(fs.existsSync(path.join(env.RIGS_HOME, 'exhibits')), false, 'disabled: no exhibit files');
    assert.deepEqual((await (await fetch(BASE + '/api/local/exhibits')).json()).docs, []);

    const bad = await fetch(BASE + '/api/local/exhibits/config', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ images: 'gif' }) });
    assert.equal(bad.status, 400);
    const cfg = await (await fetch(BASE + '/api/local/exhibits/config', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ enabled: true, images: 'auto' }) })).json();
    assert.equal(cfg.enabled, true);

    const traceId = await send('write me a greeting card file');
    let doc = null;
    for (let i = 0; i < 50 && !doc?.final; i++) { const r = await fetch(`${BASE}/api/local/exhibits/${traceId}`); doc = r.ok ? await r.json() : null; if (!doc?.final) await new Promise((r2) => setTimeout(r2, 100)); }
    assert.ok(doc?.final, 'the document is final once the reply ends: ' + JSON.stringify(doc) + log);
    const kinds = doc.entries.map((e) => e.kind);
    assert.equal(kinds[0], 'intake');
    assert.equal(kinds.at(-1), 'result');
    assert.ok(doc.entries.some((e) => e.title.startsWith('Routed: ') || e.title === 'Sent straight to JARVIS'), JSON.stringify(doc.entries.map((e) => e.title)));
    assert.ok(kinds.includes('code'), 'the Write tool call is a code exhibit');
    for (const e of doc.entries) {
      assert.ok(e.caption && e.visual && e.image?.source === 'svg', JSON.stringify(e).slice(0, 300));
      assert.match(e.image.src, /^data:image\/svg\+xml;base64,/);
    }
    assertClean(doc, 'the API document');
    assert.equal(doc.entries.at(-1).caption, 'JARVIS replied: “Writing it, sir. Done, sir.”');

    const list = await (await fetch(BASE + '/api/local/exhibits')).json();
    assert.deepEqual(list.docs.map((d) => [d.docId, d.final]), [[traceId, true]]);
    const mesh = await (await fetch(BASE + '/api/exhibits')).json();
    assert.ok(mesh.docs.some((d) => d.docId === traceId && d.node === 'test-node'), JSON.stringify(mesh));

    const html = await fetch(`${BASE}/api/local/exhibits/${traceId}/export?format=html`);
    assert.equal(html.headers.get('content-type'), 'text/html; charset=utf-8');
    const page = await html.text();
    assert.match(page, /^<!doctype html>/);
    assert.equal((page.match(/<img src="data:image\/svg\+xml;base64,/g) || []).length, doc.entries.length);
    assert.ok(!/<script/i.test(page));
    assertClean(page, 'the HTML export');
    if (process.env.EXHIBITS_SAMPLE) { fs.mkdirSync(path.dirname(process.env.EXHIBITS_SAMPLE), { recursive: true }); fs.writeFileSync(process.env.EXHIBITS_SAMPLE, page); }
    const md = await fetch(`${BASE}/api/local/exhibits/${traceId}/export?format=md`);
    assert.equal(md.headers.get('content-type'), 'text/markdown; charset=utf-8');
    assert.match(await md.text(), /^# write me a greeting card file\n/);
    assert.equal((await fetch(`${BASE}/api/local/exhibits/${traceId}/export?format=pdf`)).status, 400);
    assert.equal((await fetch(`${BASE}/api/local/exhibits/pr-nope`)).status, 404);

    // attach: a project that existed before exhibits were on (a project file the planner reads)
    const post = (p, b) => fetch(BASE + p, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(b) });
    const prj = { ...RUNNING(), id: 'p0888' };
    fs.mkdirSync(path.join(env.RIGS_HOME, 'projects'), { recursive: true });
    fs.writeFileSync(path.join(env.RIGS_HOME, 'projects', 'p0888.json'), JSON.stringify(prj));
    assert.equal((await post('/api/local/exhibits/attach', {})).status, 400);
    assert.equal((await post('/api/local/exhibits/attach', { projectId: 'nope' })).status, 404);
    const at1 = await (await post('/api/local/exhibits/attach', { projectId: 'p0888' })).json();
    assert.deepEqual(at1, { docId: 'pr-p0888', added: 6, entries: 6, final: false });
    assert.deepEqual(await (await post('/api/local/exhibits/attach', { projectId: 'pr-p0888' })).json(), { docId: 'pr-p0888', added: 0, entries: 6, final: false });
    assert.ok((await (await fetch(BASE + '/api/local/exhibits')).json()).docs.some((d) => d.docId === 'pr-p0888' && d.entries === 6));
    assert.match(await (await fetch(`${BASE}/api/local/exhibits/pr-p0888/export?format=md`)).text(), /^# Backfill me\n/);
    // switched off again: refused, nothing more written
    await post('/api/local/exhibits/config', { enabled: false });
    assert.equal((await post('/api/local/exhibits/attach', { projectId: 'p0888' })).status, 409);
  } finally {
    server.kill();
  }
});

test('service: retention keeps at most maxDocs documents, oldest go first with their images', async () => {
  const home = fs.mkdtempSync(path.join(TMP, 'ret-'));
  const svc = X.createExhibits({ home, getSettings: () => ({ enabled: true, images: 'svg', maxPerDoc: 60, maxDocs: 10 }) });
  const ids = [];
  for (let i = 0; i < 13; i++) {
    const traceId = `tr-20261018-${String(i).padStart(12, '0')}`;
    ids.push(traceId);
    svc.handleSpan({ traceId, spanId: `sp-${i}`, kind: 'intake', start: 1000 + i, status: 'running', input: 'hello ' + i });
    await svc.flush();
    fs.utimesSync(path.join(svc.dir, `${traceId}.jsonl`), new Date(1e12 + i * 1000), new Date(1e12 + i * 1000));
  }
  const left = fs.readdirSync(svc.dir).filter((f) => f.endsWith('.jsonl')).sort();
  assert.equal(left.length, 10);
  assert.deepEqual(left, ids.slice(3).map((id) => `${id}.jsonl`));
});

// ---------------------------------------------------------------- the Exhibit window's activity (ui/src/exhibits-model.js)
// Spans in → the files touched, the tool calls and the step progress the window shows; redaction, caps, scope, motion.

const A = await import('../ui/src/exhibits-model.js');
const T = await import('../src/trace.js');
const at = (o) => span({ start: 1000, end: 1500, ...o });
const tool = (n, name, input, output, extra = {}) => at({ id: String(n).padStart(12, 'c'), parentId: 'sp-000000000003', kind: 'tool-call', name, input, output, start: 3000 + n * 10, end: 3005 + n * 10, ...extra });
const LIVE = [
  at({ id: '000000000001', kind: 'intake', name: 'jarvis/send', end: null, status: 'running', input: 'add a dark mode toggle' }),
  at({ id: '000000000002', parentId: 'sp-000000000001', kind: 'router', name: 'route', output: { route: 'answer' }, meta: { route: 'answer' } }),
  at({ id: '000000000003', parentId: 'sp-000000000001', kind: 'brain-turn', name: 'claude claude-opus-5-5', start: 2000, end: null, status: 'running', meta: { model: 'claude-opus-5-5' } }),
  tool(1, 'Read', { file_path: '/Users/mix/app/ui/src/themes.js' }, '     1\tline one\n     2\tline two\n     3\tline three'),
  tool(2, 'Edit', { file_path: '/Users/mix/app/ui/src/themes.js', old_string: 'a', new_string: 'b' }, 'The file /Users/mix/app/ui/src/themes.js has been updated.'),
  tool(3, 'Write', { file_path: '/Users/mix/app/ui/src/dark.css', content: 'x' }, 'File created successfully at: /Users/mix/app/ui/src/dark.css'),
  tool(4, 'mcp__rigs__mesh_write_file', { node: 'linux-box', path: '/home/mix/notes.md', content: 'x' }, { ok: true }),
  tool(5, 'Bash', { command: `curl -H "Authorization: Bearer ${SECRETS[0]}" https://x` }, `error: token=${SECRETS[2]} rejected`, { status: 'error' }),
  tool(6, 'Grep', { pattern: 'theme' }, null, { end: null, status: 'running' }),
];

test('activity: files touched — read / edit / create marks, counts, mesh paths, newest first', () => {
  const { files, total } = A.filesTouched(LIVE);
  assert.equal(total, 3);
  assert.deepEqual(files.map((f) => [f.node, f.name, f.mark, f.count]), [['linux-box', 'notes.md', 'create', 1], ['', 'dark.css', 'create', 1], ['', 'themes.js', 'edit', 2]]);
  assert.equal(files[2].dir, '~/app/ui/src', 'the home folder is shown as ~');
  // a Write over a file seen earlier (or that says "updated") is an edit; Codex file_change kinds map to create/edit/delete
  const more = A.filesTouched([tool(1, 'Read', { file_path: '/a/x.js' }, 'x'), tool(2, 'Write', { file_path: '/a/x.js', content: '' }, 'ok'),
    tool(3, 'file_change', [{ path: '/a/new.js', kind: 'add' }, { path: '/a/old.js', kind: { type: 'delete' } }], null)]).files;
  assert.deepEqual(more.map((f) => [f.name, f.mark]), [['new.js', 'create'], ['old.js', 'delete'], ['x.js', 'edit']]);
  // an input cut to the trace's field cap still yields its path (from the JSON preview)
  const cut = A.filesTouched([tool(1, 'Edit', { truncated: true, chars: 99999, preview: '{"file_path":"/a/big.js","old_string":"' }, 'ok')]).files;
  assert.equal(cut[0]?.name, 'big.js');
});

test('activity: tool calls — newest first, status, short redacted result summary', () => {
  const { calls, total, running, errors } = A.toolCalls(LIVE);
  assert.equal(total, 6); assert.equal(running, 1); assert.equal(errors, 1);
  assert.deepEqual(calls.map((c) => c.name), ['Grep', 'Bash', 'mesh_write_file', 'Write', 'Edit', 'Read']);
  assert.deepEqual(calls.map((c) => c.status), ['running', 'error', 'ok', 'ok', 'ok', 'ok']);
  assert.equal(calls[0].summary, '', 'a running call has no result yet');
  assert.equal(calls[0].target, 'theme');
  assert.equal(calls[2].target, 'linux-box:~/notes.md');
  assert.equal(calls[4].target, '…/ui/src/themes.js', 'a long path keeps its tail, so the file name shows');
  assert.equal(calls[3].summary, 'created');
  assert.equal(calls[4].summary, 'edited');
  assert.equal(calls[5].summary, '3 lines');
  assertClean(calls, 'tool calls'); // the Bearer token and the token= value in the error never show
  assert.match(calls[1].summary, /^error: token=\*\*\*/);
  assert.match(calls[1].target, /Authorization: \*\*\*/);
  // a long result is one short line
  const long = A.toolCalls([tool(1, 'Bash', { command: 'ls' }, `\n\n${'word '.repeat(80)}\nsecond line`)]).calls[0];
  assert.ok(long.summary.length <= 100 && long.summary.endsWith('…') && !long.summary.includes('second'));
  // stopped (no result recorded) is not shown as an error
  assert.deepEqual(A.toolCalls([tool(1, 'Bash', { command: 'x' }, null, { status: 'stopped' })]).calls.map((c) => [c.status, c.summary]), [['stopped', 'no result recorded']]);
});

test('activity: the UI redacts exactly as trace.js does (one shared module)', () => {
  for (const s of [...SECRETS, `--token ${SECRETS[1]}`, 'https://bob:hunter2@host/x', 'password: "abcdefgh"']) assert.equal(A.toolSummary(tool(1, 'Bash', 'x', s, { status: 'error' })), T.redact(s).replace(/\s+/g, ' ').trim().slice(0, 100));
});

test('activity: lists are capped', () => {
  const many = Array.from({ length: 50 }, (_, i) => tool(i + 1, 'Read', { file_path: `/r/f${i}.js` }, 'x'));
  const f = A.filesTouched(many);
  assert.equal(f.files.length, A.ACTIVITY_LIMITS.files); assert.equal(f.total, 50);
  assert.equal(f.files[0].name, 'f49.js', 'newest first');
  const t = A.toolCalls(many, { max: 5 });
  assert.equal(t.calls.length, 5); assert.equal(t.total, 50);
  const a = A.activityOf(many);
  assert.equal(a.tools.length, A.ACTIVITY_LIMITS.tools); assert.equal(a.files.length, A.ACTIVITY_LIMITS.files);
  // the span store keeps at most N traces (least recently active go first) and M spans per trace
  const store = new Map();
  for (let i = 0; i < 20; i++) A.foldSpans(store, { traceId: `tr-20261020-${String(i).padStart(12, '0')}`, spanId: 'sp-x', kind: 'intake', start: 1000 + i, status: 'ok' }, { traces: 5 });
  assert.equal(store.size, 5);
  assert.ok(store.has('tr-20261020-000000000019') && !store.has('tr-20261020-000000000000'));
  const one = new Map();
  A.foldSpans(one, [LIVE[0], ...many], { spans: 10 });
  assert.equal(one.get(TR).spans.size, 10);
  assert.ok(one.get(TR).spans.has('sp-000000000001'), 'stage spans outlive finished tool calls');
  // a stale fetch (the span still running) never undoes the live push that ended it
  const race = new Map();
  A.foldSpans(race, { ...LIVE[0], end: 5000, status: 'ok' });
  A.foldSpans(race, LIVE[0]);
  assert.equal(race.get(TR).spans.get('sp-000000000001').status, 'ok');
});

test('activity: steps and progress of a request and of a project with tasks', () => {
  const a = A.activityOf(LIVE, { now: 4000 });
  assert.equal(a.title, 'add a dark mode toggle');
  assert.equal(a.kind, 'request');
  assert.deepEqual(a.steps.map((s) => [s.label, s.status]), [['Request received', 'ok'], ['Routed: answer', 'ok'], ['Thinking · opus-5-5', 'running'], ['Reply', 'pending']]);
  assert.equal(a.done, 2); assert.equal(a.total, 4); assert.equal(a.tasks, null);
  assert.equal(a.current, 'Thinking · opus-5-5');
  assert.equal(a.active, true);
  const P = 'p1';
  const proj = [
    at({ id: '000000000001', kind: 'intake', name: 'jarvis/send', input: 'build the thing', status: 'ok', end: 9000 }),
    at({ id: '000000000004', parentId: 'sp-000000000001', kind: 'handoff', name: 'project_create', start: 1200, meta: { projectId: P, taskIds: [] } }),
    at({ id: '000000000005', kind: 'plan', name: 'plan Thing', start: 1300, meta: { projectId: P, routing: [{ task: 't1', title: 'Model' }, { task: 't2', title: 'UI' }] } }),
    at({ id: '000000000006', kind: 'dispatch', name: 't1 → mac', start: 1400, meta: { projectId: P, taskId: 't1', target: 'mac' }, input: { task: { id: 't1', title: 'Model' } } }),
    at({ id: '000000000007', parentId: 'sp-000000000006', kind: 'task', name: 't1 Model', start: 1500, end: 5000, meta: { projectId: P, projectName: 'Thing', taskId: 't1' } }),
    at({ id: '000000000008', kind: 'dispatch', name: 't2 → linux', start: 5100, meta: { projectId: P, taskId: 't2', target: 'linux' }, input: { task: { id: 't2', title: 'UI' } } }),
  ];
  const b = A.activityOf(proj, { now: 6000 });
  assert.equal(b.title, 'Thing'); assert.equal(b.kind, 'project'); assert.equal(b.request, 'build the thing');
  assert.deepEqual(b.steps.map((s) => [s.label, s.status]), [['Request received', 'ok'], ['Created a project', 'ok'], ['Planned 2 tasks', 'ok'], ['t1 · Model', 'ok'], ['t2 · UI', 'running'], ['Reply', 'ok']]);
  assert.deepEqual(b.tasks, { done: 1, total: 2 });
  assert.equal(b.active, true, 'a task started on another machine keeps the project working until its run reports');
  // the project scope gathers the spans that carry it, across traces
  const store = new Map();
  A.foldSpans(store, [...proj, { ...LIVE[0], traceId: 'tr-20261020-ffffffffffff' }]);
  assert.equal(A.scopeSpans(store, A.docScope('pr-p1')).length, proj.length);
  assert.equal(A.scopeSpans(store, A.docScope(TR)).length, proj.length);
});

test('activity: scope — a picked document wins, else the running work, else the most recent (idle fallback)', () => {
  const store = new Map();
  const old = 'tr-20261020-000000000aaa';
  const live = 'tr-20261020-000000000bbb';
  const now = Date.now();
  A.foldSpans(store, [{ traceId: live, spanId: 'sp-1', kind: 'intake', start: now - 60000, end: null, status: 'running' }]);
  A.foldSpans(store, [{ traceId: old, spanId: 'sp-2', kind: 'intake', start: now - 1000, end: now - 500, status: 'ok' }]);
  assert.deepEqual(A.pickScope(store, { now }), { traceId: live }, 'running work beats a more recent finished one');
  assert.deepEqual(A.pickScope(store, { pinned: { projectId: 'p9' }, now }), { projectId: 'p9' });
  A.foldSpans(store, [{ traceId: live, spanId: 'sp-1', kind: 'intake', start: now - 60000, end: now - 100, status: 'ok' }]);
  assert.deepEqual(A.pickScope(store, { now }), { traceId: live }, 'nothing running: the most recently active');
  assert.equal(A.activityOf(A.scopeSpans(store, { traceId: live }), { now }).active, false);
  assert.equal(A.pickScope(new Map()), null);
  assert.equal(A.activityOf([]), null);
  // a stage left "running" by a restart is not work going on forever
  assert.equal(A.isActive([{ kind: 'brain-turn', status: 'running', start: now - 3600000, end: null }], now), false);
});

test('activity: animation only while work runs, never when off, hidden, reduced motion or low power', () => {
  const base = { mode: 'auto', active: true, current: true };
  assert.equal(A.shouldAnimate(base), true);
  assert.equal(A.shouldAnimate({ ...base, current: false }), false, "auto moves only the running stage's card");
  assert.equal(A.shouldAnimate({ ...base, mode: 'always', current: false }), true);
  for (const k of ['hidden', 'reducedMotion', 'lowPower', 'documentView']) {
    assert.equal(A.shouldAnimate({ ...base, [k]: true }), false, k);
    assert.equal(A.shouldAnimate({ ...base, mode: 'always', [k]: true }), false, `always + ${k}`);
  }
  assert.equal(A.shouldAnimate({ ...base, active: false }), false, 'idle');
  assert.equal(A.shouldAnimate({ ...base, mode: 'always', active: false }), false, 'always, but idle');
  assert.equal(A.shouldAnimate({ ...base, mode: 'off' }), false);
  assert.equal(A.animMode('bogus'), 'auto'); assert.equal(A.animMode(null), 'auto'); assert.equal(A.animMode('off'), 'off');
});
