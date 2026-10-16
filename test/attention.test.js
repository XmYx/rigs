// "An agent needs you" feed + auto-mode launch flags, against a throwaway HOME (never the real ~/.claude or ~/.codex).
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { test } from 'node:test';

const ROOT = fs.mkdtempSync(path.join(os.tmpdir(), 'rigs-attn-'));
process.env.HOME = process.env.USERPROFILE = ROOT;
process.env.RIGS_HOME = path.join(ROOT, '.rigs');
process.env.CODEX_HOME = path.join(ROOT, '.codex');
const attention = await import('../src/attention.js');
const { withNotify, installCodex, codexAutoProfileReady } = await import('../src/agentmodes.js');
const { agentModes, claudeFlags, codexFlags } = await import('../src/models.js');

const sessions = path.join(ROOT, '.claude', 'sessions');
fs.mkdirSync(sessions, { recursive: true });
const claudeFile = path.join(sessions, `${process.pid}.json`);
const claude = (status) => fs.writeFileSync(claudeFile, JSON.stringify({
  pid: process.pid, sessionId: 'sess-1', cwd: '/work/app', name: 'fix login', tmux: 'claude-app:@1.%3', status, statusUpdatedAt: 1000,
}));
const keys = (items) => items.map((x) => x.key).filter((k) => !k.startsWith('pane:') && !k.startsWith('rig:'));
const fresh = [];
attention.events.on('new', (items) => fresh.push(...items.map((x) => x.key)));

test('a waiting Claude session is reported with its tmux session; announced once, cleared when answered', async () => {
  claude('busy');
  await attention.refresh({ projects: [] }); // first pass only learns the current state
  claude('waiting');
  const items = await attention.refresh();
  const it = items.find((x) => x.key === 'claude:sess-1');
  assert.ok(it, JSON.stringify(items));
  assert.deepEqual(it.session, { kind: 'tmux', id: 'claude-app' });
  assert.equal(it.agent, 'claude');
  assert.ok(fresh.includes('claude:sess-1'));
  await attention.refresh();
  assert.equal(fresh.filter((k) => k === 'claude:sess-1').length, 1, 'not re-announced while still waiting');
  claude('idle');
  assert.ok(!keys(await attention.refresh()).includes('claude:sess-1'));
});

test('a dead Claude process never counts as waiting', async () => {
  fs.writeFileSync(path.join(sessions, '999999.json'), JSON.stringify({ pid: 999999, sessionId: 'ghost', status: 'waiting' }));
  assert.ok(!keys(await attention.refresh()).includes('claude:ghost'));
});

test('codex notify: approval-requested raises, the next turn event clears', async () => {
  attention.codexEvent({ type: 'approval-requested', 'thread-id': 't1', cwd: '/work/api', command: ['rm', '-rf', 'build'], tmux: 'codex-api' });
  let items = await attention.refresh();
  const it = items.find((x) => x.key === 'codex:t1');
  assert.ok(it);
  assert.match(it.reason, /rm -rf build/);
  assert.deepEqual(it.session, { kind: 'tmux', id: 'codex-api' });
  attention.codexEvent({ type: 'agent-turn-complete', 'thread-id': 't1' });
  items = await attention.refresh();
  assert.ok(!keys(items).includes('codex:t1'));
});

test('blocked project tasks need the user too, and survive hook-driven refreshes', async () => {
  const projects = [{ id: 'p1', name: 'Site', updatedAt: 5, tasks: [{ id: 't2', title: 'deploy', status: 'blocked', summary: 'needs the API key', assign: { provider: 'codex', node: 'magix' } }, { id: 't3', title: 'x', status: 'done' }] }];
  let items = await attention.refresh({ projects });
  assert.deepEqual(keys(items), ['task:p1:t2']);
  assert.equal(items.find((x) => x.key === 'task:p1:t2').reason, 'needs the API key');
  attention.codexEvent({ type: 'agent-turn-complete', 'thread-id': 'other' });
  items = await attention.refresh();
  assert.deepEqual(keys(items), ['task:p1:t2'], 'a refresh without projects keeps the last known ones');
  assert.equal(fresh.filter((k) => k === 'task:p1:t2').length, 1);
});

test('codex notify hook goes at the top of config.toml, idempotently, and never over a user notify', async () => {
  fs.mkdirSync(process.env.CODEX_HOME, { recursive: true });
  const cfg = path.join(process.env.CODEX_HOME, 'config.toml');
  fs.writeFileSync(cfg, 'model = "m"\n\n[features]\nx = true\n');
  await installCodex();
  const text = fs.readFileSync(cfg, 'utf8');
  assert.ok(text.indexOf('notify = [') < text.indexOf('[features]'), text);
  assert.match(text, /"hook", "codex"\]/);
  assert.ok(codexAutoProfileReady());
  assert.match(fs.readFileSync(path.join(process.env.CODEX_HOME, 'rigs-auto.config.toml'), 'utf8'), /approval_policy = "on-request"/);
  await installCodex();
  assert.equal(fs.readFileSync(cfg, 'utf8'), text, 'idempotent');
  assert.ok(withNotify('notify = ["mine"]\n[a]\n', ['x']).skipped);
});

test('agents RIGS starts run in auto mode', () => {
  const m = agentModes();
  assert.deepEqual(claudeFlags({ model: 'claude-haiku-5-5', ...m.claude }), ['--model', 'claude-haiku-5-5', '--permission-mode', 'auto']);
  const cx = codexFlags({ model: 'gpt-6.1-sol', ...m.codex });
  assert.deepEqual(cx.slice(0, 6), ['-m', 'gpt-6.1-sol', '-s', 'workspace-write', '-a', 'on-request']);
  assert.ok(cx.includes('sandbox_workspace_write.network_access=true'));
});

test('OpenRig: live seats waiting on input count; detached seats that failed to start do not', () => {
  const items = attention.rigNeeds([
    { session: 'task-code@app-t2', runtime: 'claude-code', status: 'running', activity: 'needs_input', reason: 'selection_prompt', startupStatus: 'ready', title: 't2' },
    { session: 'task-code@app-t1', runtime: 'claude-code', status: 'running', activity: 'unknown', startupStatus: 'ready', title: 't1' },
    { session: 'advisor-lead@kernel', runtime: 'codex', status: 'detached', activity: 'unknown', reason: 'no_runtime_hook', startupStatus: 'attention_required', title: 'k' },
  ]);
  assert.deepEqual(items.map((x) => x.key), ['rig:task-code@app-t2']);
  assert.equal(items[0].reason, 'selection_prompt');
});

test('approval screens on agent panes are recognised (Claude, Codex approvals, Codex trust + hook review)', () => {
  const hit = (txt) => attention.CHROME.some((re) => re.test(txt));
  assert.ok(hit(' Do you want to proceed?\n ❯ 1. Yes\n   4. No\n Esc to cancel · Tab to amend'));
  assert.ok(hit('Would you like to run the following command?'));
  assert.ok(hit('  Trust this folder? Codex can read, edit, and run files here'));
  assert.ok(hit('  Hooks need review\n  1 hook is new or changed.'));
  assert.ok(!hit('$ npm test\n# pass 43\n# fail 0'));
});

test('node CLI wrappers: run the tool with its own Node, leave foreign files alone, heal when the install moves', { skip: process.platform === 'win32' }, async () => {
  const { ensureCliWrappers, wrapperTarget } = await import('../src/agentmodes.js');
  const pkg = path.join(ROOT, 'npm', 'lib', 'node_modules', 'fakecli');
  const npmBin = path.join(ROOT, 'npm', 'bin');
  fs.mkdirSync(pkg, { recursive: true });
  fs.mkdirSync(npmBin, { recursive: true });
  fs.writeFileSync(path.join(pkg, 'cli.js'), '#!/usr/bin/env node\nconsole.log("fakecli " + process.version);\n');
  fs.symlinkSync(path.join(pkg, 'cli.js'), path.join(npmBin, 'fakecli'));
  fs.symlinkSync(process.execPath, path.join(npmBin, 'node'));
  const local = path.join(ROOT, '.local', 'bin');
  const oldPath = process.env.PATH;
  process.env.PATH = `${npmBin}${path.delimiter}${oldPath}`;
  try {
    const r = await ensureCliWrappers({ tools: ['fakecli'], dir: local });
    assert.match(r.fakecli, /fakecli/, JSON.stringify(r));
    const w = path.join(local, 'fakecli');
    assert.equal(wrapperTarget(w), fs.realpathSync(path.join(pkg, 'cli.js')));
    assert.match(fs.readFileSync(w, 'utf8'), /exec '.*node' '.*cli\.js' "\$@"/);
    assert.equal((await ensureCliWrappers({ tools: ['fakecli'], dir: local })).fakecli, 'ok');
    fs.writeFileSync(path.join(local, 'other'), '#!/bin/sh\necho mine\n');
    assert.equal((await ensureCliWrappers({ tools: ['other'], dir: local })).other, 'left alone (not ours)');
  } finally { process.env.PATH = oldPath; }
});

test('failed tasks of active projects need the user; finished projects never blink', async () => {
  const items = await attention.refresh({ projects: [
    { id: 'pa', name: 'A', status: 'running', updatedAt: 1, tasks: [{ id: 't1', title: 'x', status: 'failed', summary: 'dispatch failed: rig up failed' }] },
    { id: 'pb', name: 'B', status: 'done', updatedAt: 1, tasks: [{ id: 't1', title: 'y', status: 'failed' }] },
  ] });
  assert.deepEqual(keys(items), ['task:pa:t1']);
});
