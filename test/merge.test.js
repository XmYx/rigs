// Merge steward end to end on real git repos: clean merge, conflict hand-off, failing checks.
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { test } from 'node:test';

const ROOT = fs.mkdtempSync(path.join(os.tmpdir(), 'rigs-merge-'));
process.env.RIGS_HOME = path.join(ROOT, 'home');
process.env.RIGS_DEV_ROOT = path.join(ROOT, 'dev');
for (const k of ['GIT_AUTHOR_NAME', 'GIT_COMMITTER_NAME']) process.env[k] = 'tester';
for (const k of ['GIT_AUTHOR_EMAIL', 'GIT_COMMITTER_EMAIL']) process.env[k] = 'tester@example.com';
const merge = await import('../src/merge.js');

const git = (cwd, ...args) => execFileSync('git', args, { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim();
const origin = path.join(ROOT, 'origin.git');
const app = path.join(ROOT, 'app');
fs.mkdirSync(origin);
git(origin, 'init', '--bare', '-q', '-b', 'main');
git(ROOT, 'clone', '-q', origin, app);
fs.writeFileSync(path.join(app, 'package.json'), JSON.stringify({ name: 't', scripts: { build: 'node -e 0', test: "node -e \"process.exit(require('fs').existsSync('BROKEN')?1:0)\"" } }));
fs.writeFileSync(path.join(app, 'f.txt'), 'line one\nline two\n');
git(app, 'add', '.');
git(app, 'commit', '-q', '-m', 'init');
git(app, 'branch', '-M', 'main');
git(app, 'push', '-q', 'origin', 'main');

const events = [];
const ctx = {
  fetchBundle: (req) => merge.bundle(req.dir, req.branch),
  cleanup: (req) => merge.cleanupWork(req.dir, req.branch),
  rollout: async () => events.push('rollout'),
  notify: (t) => events.push(t),
  resolve: async (req) => { events.push('resolve:' + req.conflicts.join(',')); return { node: 'here', provider: 'claude' }; },
};

async function work(topic, file, content) {
  const w = await merge.startWork(topic, { repo: app });
  fs.writeFileSync(path.join(w.dir, file), content);
  git(w.dir, 'add', '.');
  git(w.dir, 'commit', '-q', '-m', topic);
  const d = await merge.describe(w.dir);
  return merge.enqueue({ node: 'tester', dir: w.dir, branch: d.branch, title: topic, commits: d.commits });
}
const status = (id) => merge.queue().find((x) => x.id === id);
const originFile = (f) => git(app, 'show', `origin/main:${f}`);

test('clean branch is merged, pushed and rolled out', async () => {
  const r = await work('add a', 'a.txt', 'hello\n');
  assert.match(r.branch, /^work\/.+\/add-a$/);
  await merge.processQueue(ctx, app);
  assert.equal(status(r.id).status, 'merged', JSON.stringify(status(r.id).log));
  git(app, 'fetch', '-q', 'origin');
  assert.equal(originFile('a.txt'), 'hello');
  assert.ok(events.includes('rollout'));
  assert.ok(!fs.existsSync(r.dir), 'merged worktree is removed');
  const keep = await merge.startWork('keep me', { repo: app });
  fs.writeFileSync(path.join(keep.dir, 'draft.txt'), 'unsaved work\n');
  fs.symlinkSync(app, path.join(keep.dir, 'node_modules'));
  const c = await merge.cleanupWork(keep.dir, keep.branch);
  assert.equal(c.removed, false, 'untracked work is never deleted');
  assert.ok(fs.existsSync(path.join(keep.dir, 'draft.txt')));
  assert.throws(() => git(app, 'rev-parse', '--verify', r.branch), 'merged branch is deleted');
});

test('second worker on the same lines gets a resolver; nothing is overwritten', async () => {
  const b = await work('edit b', 'f.txt', 'line one (b)\nline two\n');
  const c = await work('edit c', 'f.txt', 'line one (c)\nline two\n');
  await merge.processQueue(ctx, app);
  assert.equal(status(b.id).status, 'merged');
  assert.equal(status(c.id).status, 'conflict');
  assert.deepEqual(status(c.id).conflicts, ['f.txt']);
  assert.ok(events.includes('resolve:f.txt'));
  git(app, 'fetch', '-q', 'origin');
  assert.match(originFile('f.txt'), /\(b\)/, "b's work is on main");
});

test('resolver commits the merge → steward re-checks and pushes', async () => {
  const c = merge.queue().find((x) => x.status === 'conflict');
  fs.writeFileSync(path.join(c.worktree, 'f.txt'), 'line one (b) (c)\nline two\n');
  git(c.worktree, 'add', 'f.txt');
  await merge.markResolved(c.id);
  await merge.processQueue(ctx, app);
  assert.equal(status(c.id).status, 'merged', JSON.stringify(status(c.id).log));
  git(app, 'fetch', '-q', 'origin');
  assert.match(originFile('f.txt'), /\(b\) \(c\)/);
});

test('failing checks are not merged and go back to the author', async () => {
  const d = await work('break it', 'BROKEN', 'x\n');
  await merge.processQueue(ctx, app);
  assert.equal(status(d.id).status, 'checks-failed');
  git(app, 'fetch', '-q', 'origin');
  assert.throws(() => originFile('BROKEN'));
});

test('a branch that commits node_modules (e.g. the worktree symlink) is refused', async () => {
  const w = await merge.startWork('sneaky deps', { repo: app });
  fs.symlinkSync(app, path.join(w.dir, 'node_modules'));
  fs.writeFileSync(path.join(w.dir, 'ok.txt'), 'x\n');
  git(w.dir, 'add', '-A', '-f');
  git(w.dir, 'commit', '-q', '-m', 'oops');
  await assert.rejects(() => merge.describe(w.dir), /node_modules/);
});

test('main itself is never a work branch', async () => {
  await assert.rejects(() => merge.describe(app), /work branch, not main|nothing to propose/);
});

test("OpenRig's managed blocks never reach the repo: refused on propose, stripped when RIGS proposes", async () => {
  const BLOCK = '\n\n<!-- BEGIN OpenRig MANAGED BLOCK: CULTURE-default.md -->\n# OpenRig default culture\n<!-- END OpenRig MANAGED BLOCK: CULTURE-default.md -->\n';
  assert.equal(merge.stripManaged('# Guide\n\nRead AGENTS.md.\n' + BLOCK), '# Guide\n\nRead AGENTS.md.\n');
  const w = await merge.startWork('managed-blocks', { repo: app });
  fs.writeFileSync(path.join(w.dir, 'CLAUDE.md'), '# Guide\n');
  fs.writeFileSync(path.join(w.dir, 'f.txt'), 'line one\nline two\nline three\n');
  git(w.dir, 'add', '.');
  git(w.dir, 'commit', '-q', '-m', 'real change');
  // A seat injects its blocks and an agent commits them along with its work.
  fs.appendFileSync(path.join(w.dir, 'CLAUDE.md'), BLOCK);
  git(w.dir, 'commit', '-q', '-am', 'more work');
  await assert.rejects(merge.describe(w.dir), /OpenRig's managed blocks into CLAUDE\.md/);
  // Injected again, uncommitted this time (a dirty tree would also block the proposal).
  fs.appendFileSync(path.join(w.dir, 'CLAUDE.md'), BLOCK.replaceAll('CULTURE-default', 'openrig-start'));
  assert.deepEqual((await merge.stripManagedBlocks(w.dir)).changed, ['CLAUDE.md']);
  assert.equal(fs.readFileSync(path.join(w.dir, 'CLAUDE.md'), 'utf8'), '# Guide\n');
  const d = await merge.describe(w.dir);
  assert.equal(d.commits.length, 3);
});

test('checkOutput: a failed run sends back the failing test blocks, not only the tail', () => {
  const block = ['# Subtest: flaky one', 'not ok 7 - flaky one', '  ---', '  error: |-', '    boom', '  ...'];
  const passing = Array.from({ length: 200 }, (_, i) => `ok ${i + 8} - fine ${i}`);
  const out = merge.checkOutput([...block, ...passing, '# tests 207', '# pass 206', '# fail 1'].join('\n'));
  assert.match(out, /not ok 7 - flaky one\n {2}---\n {2}error: \|-\n {4}boom/);
  assert.match(out, /# fail 1$/);
  assert.ok(out.length <= 4000);
  assert.equal(merge.checkOutput('build failed\nline 2'), 'build failed\nline 2', 'no TAP: just the tail');
});
