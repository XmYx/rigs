// Sir's standing rule for agents: non-destructive work is pre-approved; RIGS changes go through the steward;
// other projects are not committed until he says so.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { test } from 'node:test';

process.env.RIGS_HOME = fs.mkdtempSync(path.join(os.tmpdir(), 'rigs-autonomy-policy-'));
const { autonomyBrief } = await import('../src/planner.js');
const { config } = await import('../src/config.js');

test('other projects: non-destructive steps pre-approved, no commits without Sir', () => {
  const b = autonomyBrief({ name: 'MadMax · FPS', repo: { node: 'magix-system', path: '/x' } });
  assert.match(b, /Pre-approved by Sir: everything non-destructive/);
  assert.match(b, /overrides any saved\s+habit of confirming/);
  assert.match(b, /Do not commit, push, merge, rebase or switch branches/);
  // A destructive step is skipped and listed, a classifier denial means another route — neither parks the task.
  assert.match(b, /finish everything else, report "done" and list the skipped step/);
  assert.match(b, /classifier denial means: take another route/);
  assert.doesNotMatch(b, /report status "blocked"/);
});

test('RIGS self-changes commit in their worktree for the merge steward', () => {
  const b = autonomyBrief({ name: 'JARVIS · mobile', selfDev: { branch: 'work/macbookpro/x' }, repo: { node: 'macbookpro', path: '/w' } });
  assert.match(b, /commit in your dev worktree; RIGS proposes the branch to the merge steward/);
  assert.doesNotMatch(b, /Do not commit/);
});

test('commitOtherProjects: "branch" no longer lets task agents commit outside a dev worktree', () => {
  config().agents.commitOtherProjects = 'branch';
  try {
    const b = autonomyBrief({ repo: {} });
    assert.match(b, /Do not commit, push, merge, rebase or switch branches/);
    assert.doesNotMatch(b, /commit on a work branch of your own/);
  } finally { config().agents.commitOtherProjects = 'ask'; }
});
