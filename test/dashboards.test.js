// Dashboards (D5): an App Cloud app with `opensFor: { workspace, keywords, path }` is matched against a task when it is
// claimed (project repo basename / name / goal × task title / description / kind), opened in Sir's UI through
// ui_open view "app", recorded on the task and in the project log, and the brief tells the agent Sir is watching.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { test } from 'node:test';

process.env.RIGS_HOME = fs.mkdtempSync(path.join(os.tmpdir(), 'rigs-dash-'));
process.env.RIGS_NAME = 'macbookpro';
process.env.RIGS_NO_OPENRIG = '1';
const D = await import('../src/dashboards.js');
const P = await import('../src/planner.js');
const W = await import('../src/work.js');

const bodyApp = { id: 'body-matching', name: 'Body Matching', node: 'macbookpro', port: 8731, opensFor: { workspace: 'body_matching_implementation', keywords: ['train', 'training', 'epoch', 'fine-tune'], path: '/training' } };
const plainApp = { id: 'notes', name: 'Notes', node: 'magix-system', port: 8800 };
const apps = [bodyApp, plainApp, { id: 'broken', name: 'Broken', node: 'x', opensFor: 'nope' }];
const project = (over = {}) => ({ id: 'p1', name: 'Body matching', goal: 'train the v4 body matching model', repo: { node: 'magix-system', path: '/home/magix/body_matching_implementation' }, ...over });
const task = (over = {}) => ({ id: 't3', title: 'Train v4 for 20 epochs', description: 'run the training script', kind: 'code', ...over });

test('dashboardsFor: workspace matches the repo basename, the project name or a word of the goal; keywords are whole words', () => {
  const [m] = D.dashboardsFor(project(), task(), apps);
  assert.deepEqual({ id: m.id, name: m.name, node: m.node, path: m.path }, { id: 'body-matching', name: 'Body Matching', node: 'macbookpro', path: '/training' });
  assert.deepEqual(m.keywords, ['train', 'training'], 'the keywords that hit, as whole words ("epochs" is not "epoch")');
  // the workspace can be the project's name or appear as a word in its goal (case-insensitive) when the repo path differs
  assert.equal(D.dashboardsFor(project({ repo: { node: 'x', path: '/elsewhere' }, name: 'BODY_MATCHING_IMPLEMENTATION' }), task(), apps).length, 1);
  assert.equal(D.dashboardsFor(project({ repo: { node: 'x', path: '' }, name: 'x', goal: 'fine-tune in body_matching_implementation tonight' }), task({ title: 'Fine-tune it' }), apps).length, 1);
  // no workspace match, no keyword match, or a keyword inside another word → nothing opens
  assert.equal(D.dashboardsFor(project({ repo: { node: 'x', path: '/other' }, name: 'other', goal: 'other' }), task(), apps).length, 0);
  assert.equal(D.dashboardsFor(project(), task({ title: 'Write the README', description: 'docs only', kind: 'docs' }), apps).length, 0);
  assert.equal(D.dashboardsFor(project(), task({ title: 'Restrain the budget', description: '' }), apps).length, 0, '"restrain" is not "train"');
  // the kind counts as text too; apps without (or with a broken) opensFor never match; no apps → no match
  assert.equal(D.dashboardsFor(project(), task({ title: 'x', description: '', kind: 'train' }), apps).length, 1);
  assert.deepEqual(D.dashboardsFor(project(), task(), []), []);
  assert.deepEqual(D.dashboardsFor(project(), task(), null), []);
});

test('dashboardSection: the brief tells the agent Sir is watching and how to keep the dashboard fed', () => {
  const s = D.dashboardSection([{ id: 'body-matching', name: 'Body Matching', node: 'macbookpro', path: '/training' }]);
  assert.match(s, /^## Dashboard\nSir is watching Body Matching at \/training on macbookpro/);
  assert.match(s, /mirror_magix_run\.sh <run>/);
  assert.match(s, /report the dashboard path in your summary/);
  assert.equal(D.dashboardSection([]), '');
  const brief = W.enrichBrief('# t\n\n## Task\nx\n\n## How to work\n- stay', { dashboards: [{ id: 'a', name: 'A', node: 'n', path: '/p' }] });
  assert.match(brief, /## Dashboard[\s\S]*## How to work/, 'the section goes before "How to work"');
});

test('on claim, a matching dashboard is opened through ui_open view "app", kept on the task, logged, and reaches the brief', async () => {
  const opened = [];
  const calls = [];
  const mesh = [{ node: { id: 'macbookpro', name: 'macbookpro', online: true, rigs: true, platform: 'mac', gpus: [], stats: { cpu: 5, memUsed: 4, memTotal: 16 }, capabilities: {} }, brains: [{ id: 'claude', models: [], efforts: [] }], openrig: { daemon: 'running' } }];
  const ctx = {
    snapshot: async () => mesh, notify: () => {},
    apps: async () => apps,
    uiOpen: async (body) => { opened.push(body); return { ok: true, delivered: 1 }; },
    call: async (node, sub, { body }) => { calls.push({ node, sub, body }); return { mode: 'direct', cwd: '/w', session: { kind: 'tmux', id: 's' } }; },
  };
  const p = await P.createProject({ name: 'Body matching', goal: 'train the v4 body matching model', repoNode: 'macbookpro', repoPath: '/Users/mix/body_matching_implementation' });
  const { task: t } = await P.addTask(p.id, { title: 'Train v4 for 20 epochs', description: 'run the training', kind: 'code', size: 'M' }, mesh);
  await P.saveProject(Object.assign(await P.getProject(p.id), { status: 'planned' }));
  const after = await P.dispatchReady(p.id, ctx);
  await new Promise((r) => setTimeout(r, 30));
  assert.deepEqual(opened, [{ view: 'app', app: 'body-matching', node: 'macbookpro', path: '/training' }]);
  const start = calls.find((c) => c.sub === 'work/start');
  assert.equal(start.body.task.dashboards[0].id, 'body-matching', 'the start body carries the matches for work.js');
  assert.equal(after.tasks.find((x) => x.id === t.id).dashboards[0].path, '/training');
  const logged = (await P.getProject(p.id)).log.map((l) => l.text);
  assert.ok(logged.some((l) => l === `opened dashboard body-matching for ${t.id}`), logged.join('\n'));
  // work.js adds the Dashboard section to the brief the agent reads
  const brief = W.enrichBrief(start.body.prompt, start.body.task);
  assert.match(brief, /## Dashboard\nSir is watching Body Matching at \/training on macbookpro/);
});

test('a failed UI push never holds up or fails the start; it is logged on the project', async () => {
  const mesh = [{ node: { id: 'macbookpro', name: 'macbookpro', online: true, rigs: true, platform: 'mac', gpus: [], stats: { cpu: 5, memUsed: 4, memTotal: 16 }, capabilities: {} }, brains: [{ id: 'claude', models: [], efforts: [] }], openrig: { daemon: 'running' } }];
  const ctx = {
    snapshot: async () => mesh, notify: () => {}, apps: async () => apps,
    uiOpen: async () => { throw new Error('no UI connected'); },
    call: async () => ({ mode: 'direct', cwd: '/w', session: { kind: 'tmux', id: 's' } }),
  };
  const p = await P.createProject({ name: 'Body matching 2', goal: 'training run', repoNode: 'macbookpro', repoPath: '/x/body_matching_implementation' });
  await P.addTask(p.id, { title: 'Start training', description: '', kind: 'code', size: 'S' }, mesh);
  await P.saveProject(Object.assign(await P.getProject(p.id), { status: 'planned' }));
  const after = await P.dispatchReady(p.id, ctx);
  assert.equal(after.tasks[0].status, 'running');
  await new Promise((r) => setTimeout(r, 30));
  assert.ok((await P.getProject(p.id)).log.some((l) => /could not open dashboard body-matching for t1: no UI connected/.test(l.text)));
});
