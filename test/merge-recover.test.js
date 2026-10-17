// A merge in flight when the steward restarted (update, crash, reboot) is picked up again, not stuck forever.
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { test } from 'node:test';

const ROOT = fs.mkdtempSync(path.join(os.tmpdir(), 'rigs-merge-recover-'));
process.env.RIGS_HOME = path.join(ROOT, 'home');
process.env.RIGS_DEV_ROOT = path.join(ROOT, 'dev');
for (const k of ['GIT_AUTHOR_NAME', 'GIT_COMMITTER_NAME']) process.env[k] = 'tester';
for (const k of ['GIT_AUTHOR_EMAIL', 'GIT_COMMITTER_EMAIL']) process.env[k] = 'tester@example.com';
const merge = await import('../src/merge.js');
const git = (cwd, ...args) => execFileSync('git', args, { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim();

test('a request left "checking" by a restart is merged on the next pass', async () => {
  const origin = path.join(ROOT, 'origin.git');
  const app = path.join(ROOT, 'app');
  fs.mkdirSync(origin);
  git(origin, 'init', '--bare', '-q', '-b', 'main');
  git(ROOT, 'clone', '-q', origin, app);
  fs.writeFileSync(path.join(app, 'package.json'), JSON.stringify({ name: 't', scripts: { build: 'node -e 0', test: 'node -e 0' } }));
  git(app, 'add', '.'); git(app, 'commit', '-q', '-m', 'init'); git(app, 'branch', '-M', 'main'); git(app, 'push', '-q', 'origin', 'main');
  const w = await merge.startWork('survive restart', { repo: app });
  fs.writeFileSync(path.join(w.dir, 'x.txt'), 'x\n');
  git(w.dir, 'add', '.'); git(w.dir, 'commit', '-q', '-m', 'x');
  const d = await merge.describe(w.dir);
  const r = await merge.enqueue({ node: 'tester', dir: w.dir, branch: d.branch, title: 'x', commits: d.commits });
  // Simulate the daemon dying mid-check.
  const qf = path.join(process.env.RIGS_HOME, 'merge', 'queue.json');
  const q = JSON.parse(fs.readFileSync(qf, 'utf8'));
  q.requests.find((x) => x.id === r.id).status = 'checking';
  fs.writeFileSync(qf, JSON.stringify(q));
  const ctx = { fetchBundle: (req) => merge.bundle(req.dir, req.branch), cleanup: (req) => merge.cleanupWork(req.dir, req.branch), rollout: async () => {}, notify: () => {}, resolve: async () => ({}) };
  await merge.processQueue(ctx, app);
  const after = merge.queue().find((x) => x.id === r.id);
  assert.equal(after.status, 'merged', JSON.stringify(after.log));
  assert.ok(after.log.some((l) => /steward restarted while checking/.test(l.text)));
});
