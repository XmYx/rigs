// Routing policy tests: pure function over a fake mesh snapshot (no daemon, no models).
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { test } from 'node:test';

process.env.RIGS_HOME = fs.mkdtempSync(path.join(os.tmpdir(), 'rigs-planner-'));
const { routeProject } = await import('../src/planner.js');

const brain = (id, models = []) => ({ id, models, efforts: [] });
const machine = (name, { brains, cpu = 10, platform = 'linux', gpus = [], tools = {} }) => ({
  node: { id: name, name, online: true, rigs: true, platform, gpus, stats: { cpu, memUsed: 4, memTotal: 16 }, capabilities: tools },
  brains, openrig: { daemon: 'running' },
});

const mesh = [
  machine('mac', { brains: [brain('claude'), brain('codex'), brain('ollama', ['llama3.2'])], platform: 'mac', cpu: 30 }),
  machine('ubuntu', { brains: [brain('claude'), brain('codex')], cpu: 5, gpus: ['NVIDIA GeForce RTX 4090'], tools: { comfyui: { id: 'comfyui', label: 'ComfyUI', kinds: ['media'], url: 'http://127.0.0.1:8188', notes: 'GPU box' } } }),
  machine('win', { brains: [brain('claude')], platform: 'windows', cpu: 50 }),
];

const task = (id, kind, extra = {}) => ({ id, title: id, description: '', kind, size: 'M', deps: [], needs: { platform: 'any', gpu: false, tool: '' }, suggest: {}, status: 'todo', assign: null, ...extra });
const project = (tasks, extra = {}) => ({ id: 'p', name: 'p', goal: 'g', repo: { node: 'mac', path: '' }, gitUrl: 'https://example.com/x.git', tasks, ...extra });

test('tiers: Opus for elaborate code, Sonnet for simpler code, Haiku for docs', () => {
  const p = routeProject(project([task('a', 'code', { size: 'L' }), task('b', 'code', { size: 'S' }), task('c', 'docs')]), mesh);
  assert.equal(p.tasks[0].assign.model, 'claude-opus-5-5');
  assert.equal(p.tasks[0].assign.effort, 'high');
  assert.equal(p.tasks[1].assign.model, 'claude-sonnet-5-5');
  assert.equal(p.tasks[2].assign.model, 'claude-haiku-5-5');
});

test('review cross-checks: Claude-written code is reviewed by Codex, and vice versa', () => {
  const p = routeProject(project([task('a', 'code'), task('r', 'review', { deps: ['a'] })]), mesh);
  assert.equal(p.tasks[0].assign.provider, 'claude');
  assert.equal(p.tasks[1].assign.provider, 'codex');
  const q = routeProject(project([task('a', 'code', { assign: { node: 'mac', provider: 'codex', locked: true } }), task('r', 'review', { deps: ['a'] })]), mesh);
  assert.equal(q.tasks[1].assign.provider, 'claude');
  assert.match(q.tasks[1].reason, /cross-check/);
});

test('media tasks only go to a machine with the tool, and the brief learns how to reach it', () => {
  const p = routeProject(project([task('m', 'media')]), mesh);
  assert.equal(p.tasks[0].assign.node, 'ubuntu');
  assert.equal(p.tasks[0].needs.tool, 'comfyui');
  assert.match(p.tasks[0].toolInfo, /8188/);
});

test('Ollama is never a fallback; only "private" work uses it', () => {
  const onlyOllama = [machine('box', { brains: [brain('ollama', ['qwen3'])] })];
  const p = routeProject(project([task('a', 'code'), task('b', 'private')]), onlyOllama);
  assert.equal(p.tasks[0].assign, null);
  assert.match(p.tasks[0].reason, /no online machine/);
  assert.equal(p.tasks[1].assign.provider, 'ollama');
  assert.equal(p.tasks[1].assign.model, 'qwen3');
});

test('platform needs are respected and code stays next to a repo without a git URL', () => {
  const p = routeProject(project([task('w', 'code', { needs: { platform: 'windows', gpu: false, tool: '' } }), task('c', 'code')], { gitUrl: '', repo: { node: 'mac', path: '/src/x' } }), mesh);
  assert.equal(p.tasks[0].assign, null); // windows-only code task, but the repo can't leave the mac
  assert.equal(p.tasks[1].assign.node, 'mac');
});

test('work spreads across machines', () => {
  const p = routeProject(project([task('a', 'research'), task('b', 'research'), task('c', 'research'), task('d', 'research')]), mesh);
  assert.ok(new Set(p.tasks.map((t) => t.assign.node)).size >= 2);
});

test('planningPrompt: tool building is an ad-hoc task, never a dev-worktree or propose task', async () => {
  const { planningPrompt } = await import('../src/planner.js');
  const text = planningPrompt(project([]), [], '', []);
  assert.match(text, /ad-hoc store \(tool_register, then tool_run\)/);
  assert.match(text, /never plan a task to start a RIGS dev worktree, propose, or edit tools\/ seeds just to add a tool/);
});
