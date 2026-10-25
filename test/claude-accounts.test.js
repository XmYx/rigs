// Several Claude accounts per machine (src/claude-accounts.js): the next run goes to the account with the most room.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { test } from 'node:test';

const home = fs.mkdtempSync(path.join(os.tmpdir(), 'rigs-accts-'));
process.env.RIGS_HOME = home;
const A = await import('../src/claude-accounts.js');
const { loadConfig } = await import('../src/config.js');

const list = [{ id: 'default', dir: '' }, { id: 'work', dir: '/w' }, { id: 'spare', dir: '/s' }];
const L = (session, week, extra = {}) => ({ session: { pct: session, resetsAt: extra.sReset || null }, week: { pct: week, resetsAt: null } });

test('auto picks the lowest weekly use among accounts under both thresholds', () => {
  const r = A.pickAccount(list, { default: L(10, 80), work: L(50, 20), spare: L(5, 40) });
  assert.equal(r.account.id, 'work');
  assert.match(r.why, /50 % of 5 h, 20 % of the week/);
});

test('an account over its 5-hour or weekly threshold is skipped; prefer keeps a session on its account while it has room', () => {
  const lim = { default: L(95, 10), work: L(10, 96), spare: L(30, 60) };
  assert.equal(A.pickAccount(list, lim).account.id, 'spare');
  assert.equal(A.pickAccount(list, { default: L(10, 50), work: L(10, 5) }, { prefer: 'default' }).account.id, 'default');
  assert.equal(A.pickAccount(list, { default: L(99, 50), work: L(10, 5) }, { prefer: 'default' }).account.id, 'work');
});

test('everything over: the one whose 5-hour window resets first; unknown usage only as a last resort', () => {
  const lim = { default: L(99, 10, { sReset: '2026-10-25T18:00:00Z' }), work: L(97, 10, { sReset: '2026-10-25T15:00:00Z' }), spare: { error: 'not logged in' } };
  assert.equal(A.pickAccount(list, lim).account.id, 'work');
  assert.equal(A.pickAccount(list, { default: { error: 'x' } }).account.id, 'default');
});

test('a fixed mode and a single account need no usage at all', () => {
  assert.equal(A.pickAccount(list, {}, { mode: 'spare' }).account.id, 'spare');
  assert.equal(A.pickAccount([list[0]], {}).account.id, 'default');
  assert.equal(A.pickAccount(list, {}, { mode: 'gone' }).why, 'no usage known yet');
});

test('add / use / remove an account; env, projects folders and the account of a transcript', async () => {
  const r = A.addAccount({ id: 'work', label: 'Work Max' });
  assert.ok(fs.statSync(r.dir).isDirectory());
  assert.match(r.login, /CLAUDE_CONFIG_DIR=.*claude \/login/);
  assert.deepEqual(A.accounts().map((a) => a.id), ['default', 'work']);
  assert.deepEqual(A.accountEnv(A.accounts()[1]), { CLAUDE_CONFIG_DIR: r.dir });
  assert.deepEqual(A.accountEnv(A.accounts()[0]), {});
  assert.ok(A.projectDirs().includes(path.join(r.dir, 'projects')));
  assert.equal(A.accountOfFile(path.join(r.dir, 'projects', '-Users-x', 'abc.jsonl')).id, 'work');
  assert.equal(A.accountOfFile('/elsewhere/projects/p/abc.jsonl').id, 'default');
  assert.throws(() => A.addAccount({ id: 'default' }), /not "default"/);
  assert.throws(() => A.setMode('nope'), /unknown account/);
  assert.equal(A.setMode('work').mode, 'work');
  assert.equal((await A.chooseAccount()).id, 'work');
  A.removeAccount('work');
  assert.equal(loadConfig().claude.mode, 'auto');
  assert.deepEqual(A.accounts().map((a) => a.id), ['default']);
  assert.equal((await A.chooseAccount()).id, 'default');
});

test('limitsFor caches per account and turns a failed read into { error }', async () => {
  A.resetAccountsCache();
  let calls = 0;
  const read = async () => { calls++; return L(1, 2); };
  const a = { id: 'x' };
  await A.limitsFor(a, { read });
  await A.limitsFor(a, { read });
  assert.equal(calls, 1);
  const bad = await A.limitsFor({ id: 'y' }, { read: async () => { throw new Error('not logged in'); } });
  assert.equal(bad.error, 'not logged in');
});
