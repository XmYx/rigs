// Delegation: a request is split into work items, each bound to a real folder on a real machine, and planned
// against that project's own guide. Uses a fake home — never the real one.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { test } from 'node:test';

const ROOT = fs.mkdtempSync(path.join(os.tmpdir(), 'rigs-deleg-'));
process.env.RIGS_HOME = path.join(ROOT, '.rigs');
const ws = await import('../src/workspaces.js');
const router = await import('../src/router.js');
const { routeProject, workspaceBrief } = await import('../src/planner.js');
const { modelTag } = await import('../src/work.js');

const home = path.join(ROOT, 'home');
const mk = (rel, text = '') => { const f = path.join(home, rel); fs.mkdirSync(path.dirname(f), { recursive: true }); fs.writeFileSync(f, text); };
const dir = (rel) => fs.mkdirSync(path.join(home, rel), { recursive: true });
mk('PycharmProjects/MadMaxUnity/AGENTS.md', "# Mad Mike's Garage — Codex developer guide\n\nUnity project: share/\n");
mk('PycharmProjects/MadMaxUnity/share/ProjectSettings/ProjectVersion.txt', 'm_EditorVersion: 6000.6.3f1\n');
dir('PycharmProjects/MadMaxUnity/share/Assets/MadMax');
dir('PycharmProjects/MadMaxUnity/share/.git');
dir('PycharmProjects/MadMaxUnity/share/Library/PackageCache/deep');
mk('PycharmProjects/CyberNinja/AGENTS.md', '# AGENTS.md — how agents build CyberNinja (Mobile Cities RPG)\n## 1. Roles\n- **Overseer**\n');
mk('PycharmProjects/CyberNinja/CyberNinja/ProjectSettings/ProjectVersion.txt', 'm_EditorVersion: 6000.6.3f1\n');
dir('PycharmProjects/CyberNinja/CyberNinja/Assets');
mk('PycharmProjects/CyberNinja/ScrapBuilder/ProjectSettings/ProjectVersion.txt', 'm_EditorVersion: 6000.6.3f1\n');
dir('PycharmProjects/CyberNinja/ScrapBuilder/Assets');
mk('film/MadMaxFilm/ProjectSettings/ProjectVersion.txt', 'm_EditorVersion: 6000.6.3f1\n');
dir('film/MadMaxFilm/Assets');
mk('Downloads/somezip/package.json', '{}');
mk('Documents/notes/todo.txt', 'x');
mk('work/scratch/deep/tool/package.json', '{"name":"tool"}');

const items = ws.scan({ roots: [home], home, extraDirs: [path.join(home, 'work/scratch/deep/tool/src')] });
const byName = Object.fromEntries(items.map((x) => [x.name, x]));
const catalog = [{ node: 'magix-system', platform: 'linux', items }, { node: 'macbookpro', platform: 'darwin', items: [] }];

test('scan finds workspaces, their titles and nested Unity projects; skips Downloads and plain folders', () => {
  assert.ok(byName.MadMaxUnity, Object.keys(byName).join(','));
  assert.equal(byName.MadMaxUnity.title, "Mad Mike's Garage — Codex developer guide");
  assert.deepEqual(byName.MadMaxUnity.parts.filter((p) => p.kind === 'unity'), [{ rel: 'share', kind: 'unity', version: '6000.6.3f1' }]);
  assert.ok(byName.MadMaxUnity.kinds.includes('unity') && byName.MadMaxUnity.kinds.includes('git'));
  assert.deepEqual(byName.CyberNinja.parts.filter((p) => p.kind === 'unity').map((p) => p.rel).sort(), ['CyberNinja', 'ScrapBuilder']);
  assert.equal(byName.MadMaxFilm.unity, '6000.6.3f1');
  assert.ok(!byName.somezip && !byName.notes, 'Downloads and folders without markers are not workspaces');
  assert.ok(byName.tool, 'a folder an agent worked in is found even below the scan depth');
});

test('names are matched by meaning: nicknames, typos, titles; machines by OS or name', () => {
  const mm = ws.resolve({ workspace: 'MadMikeUnity', machine: 'the linux machine' }, catalog);
  assert.equal(mm.node, 'magix-system');
  assert.equal(mm.workspace.name, 'MadMaxUnity');
  assert.ok(ws.score('MadMikeUnity', byName.MadMaxFilm) < mm.score - 0.3);
  const cn = ws.resolve({ workspace: 'cyberninja', machine: 'on the same machine' }, catalog, { previousNode: 'magix-system' });
  assert.equal(cn.workspace.name, 'CyberNinja');
  assert.deepEqual(ws.matchMachine('the same machine', [{ name: 'macbookpro', platform: 'darwin' }]), [], '"machine" is not "mac"');
  assert.deepEqual(ws.matchMachine('my mac', [{ name: 'macbookpro', platform: 'darwin' }, { name: 'magix-system', platform: 'linux' }]), ['macbookpro']);
  assert.ok(!ws.resolve({ workspace: 'Zebra Tracker' }, catalog).workspace, 'no false match');
});

const REQUEST = 'improve the fps on MadMikeUnity on the linux machine and outline the openrig project for cyberninja on the same machine';

test('the router model\'s work items are validated and bound to folders', () => {
  const raw = JSON.stringify({ route: 'plan', title: 'Unity work', reason: 'two goals', work: [
    { title: 'Improve FPS', goal: 'improve the fps on MadMikeUnity', workspace: 'MadMaxUnity', machine: 'magix-system' },
    { title: 'Outline OpenRig project', goal: 'outline the openrig project for cyberninja', workspace: 'CyberNinja', machine: 'magix-system' },
  ] });
  const d = router.parseDecision(raw, [], []);
  assert.equal(d.work.length, 2);
  const bound = router.bindWork(d.work, catalog, REQUEST);
  assert.deepEqual(bound.map((b) => [b.node, b.workspace?.name]), [['magix-system', 'MadMaxUnity'], ['magix-system', 'CyberNinja']]);
  assert.equal(bound[0].request, REQUEST);
});

test('without a model, keyword rules still split the request into one item per named project', () => {
  const items = router.heuristicWork(REQUEST, catalog);
  assert.deepEqual(items.map((i) => i.workspace), ['MadMaxUnity', 'CyberNinja']);
  const bound = router.bindWork(items, catalog, REQUEST);
  assert.ok(bound.every((b) => b.node === 'magix-system' && !b.unresolved));
});

test('a part that names no known folder is not filed; it comes back for JARVIS to ask about', () => {
  const bound = router.bindWork([{ title: 'x', goal: 'speed up the Zebra Tracker', workspace: 'ZebraTracker', machine: '' }], catalog);
  assert.equal(bound[0].unresolved, true);
});

test('a folder that exists on one machine keeps all its tasks there; briefs describe the workspace', () => {
  const p = {
    name: 'MadMaxUnity · Improve FPS', goal: 'improve fps', repo: { node: 'magix-system', path: byName.MadMaxUnity.path }, gitUrl: '',
    workspace: { ...byName.MadMaxUnity }, tasks: [
      { id: 't1', title: 'profile', kind: 'research', size: 'M', deps: [], needs: { platform: 'any', gpu: false, tool: '' }, status: 'todo', suggest: {} },
      { id: 't2', title: 'docs', kind: 'docs', size: 'S', deps: [], needs: { platform: 'any', gpu: false, tool: '' }, status: 'todo', suggest: {} },
    ],
  };
  const snap = [
    { node: { name: 'macbookpro', online: true, rigs: true, platform: 'darwin', stats: { cpu: 1, memUsed: 1, memTotal: 10 } }, brains: [{ id: 'claude', models: [] }] },
    { node: { name: 'magix-system', online: true, rigs: true, platform: 'linux', stats: { cpu: 90, memUsed: 9, memTotal: 10 } }, brains: [{ id: 'claude', models: [] }] },
  ];
  routeProject(p, snap);
  assert.deepEqual(p.tasks.map((t) => t.assign?.node), ['magix-system', 'magix-system'], 'even on a busier machine');
  const b = workspaceBrief(p);
  assert.match(b, /Unity project\(s\): share \(Unity 6000\.6\.3f1\)/);
  assert.match(b, /Agent guide\(s\): AGENTS\.md/);
});

test('team seats are named by role and model', () => {
  assert.equal(modelTag({ provider: 'claude', model: 'claude-opus-5-5' }), 'opus');
  assert.equal(modelTag({ provider: 'claude', model: 'sonnet' }), 'sonnet');
  assert.equal(modelTag({ provider: 'codex', model: 'gpt-6.1-sol' }), 'codex');
});
