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
  assert.deepEqual(X.settings({}), { enabled: false, images: 'auto', maxPerDoc: 60 });
  assert.equal(X.settings({ exhibits: { enabled: 'yes' } }).enabled, false, 'only a real true switches it on');
  assert.deepEqual(X.applyConfigPatch({}, { enabled: true, images: 'svg', maxPerDoc: 20 }), { enabled: true, images: 'svg', maxPerDoc: 20 });
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
  const PORT = 20000 + Math.floor(Math.random() * 20000);
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
    assert.deepEqual(await (await fetch(BASE + '/api/local/exhibits/config')).json(), { enabled: false, images: 'auto', maxPerDoc: 60 });

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
  } finally {
    server.kill();
  }
});
