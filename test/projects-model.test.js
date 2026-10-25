// Projects window list (ui/src/projects-model.js): search, status / machine filters and sort (default: active, then latest).
import assert from 'node:assert/strict';
import { test } from 'node:test';

const M = await import('../ui/src/projects-model.js');
const P = (id, status, updatedAt, extra = {}) => ({ id, name: id, status, updatedAt, owner: 'mac', goal: '', tasks: [], ...extra });
const list = [
  P('old-done', 'done', '2026-10-01T00:00:00Z'),
  P('new-planned', 'planned', '2026-10-24T00:00:00Z', { owner: 'linux' }),
  P('old-running', 'running', '2026-10-10T00:00:00Z', { goal: 'Ship the voice picker' }),
  P('blocked', 'blocked', '2026-10-20T00:00:00Z', { tasks: [{ title: 'Fix janitor', status: 'done' }, { title: 'x', status: 'todo' }] }),
  P('new-running', 'running', '2026-10-23T00:00:00Z'),
];
const ids = (v) => M.viewProjects(list, v).map((p) => p.id);

test('default view puts active projects first, newest first within each rank', () => {
  assert.deepEqual(ids({}), ['new-running', 'old-running', 'blocked', 'new-planned', 'old-done']);
});

test('latest, oldest, name and progress sorts', () => {
  assert.deepEqual(ids({ sort: 'latest' }), ['new-planned', 'new-running', 'blocked', 'old-running', 'old-done']);
  assert.equal(ids({ sort: 'oldest' })[0], 'old-done');
  assert.deepEqual(ids({ sort: 'name' }), ['blocked', 'new-planned', 'new-running', 'old-done', 'old-running']);
  assert.equal(ids({ sort: 'progress' })[0], 'blocked');
});

test('status and machine filters', () => {
  assert.deepEqual(ids({ status: 'active' }), ['new-running', 'old-running']);
  assert.ok(!ids({ status: 'open' }).includes('old-done'));
  assert.deepEqual(ids({ status: 'done' }), ['old-done']);
  assert.deepEqual(ids({ machine: 'linux' }), ['new-planned']);
  assert.deepEqual(M.machinesOf(list), ['linux', 'mac']);
});

test('search matches name, goal and task titles; every word must match', () => {
  assert.deepEqual(ids({ q: 'voice' }), ['old-running']);
  assert.deepEqual(ids({ q: 'JANITOR' }), ['blocked']);
  assert.deepEqual(ids({ q: 'voice janitor' }), []);
  assert.equal(ids({ q: '  ' }).length, list.length);
});

test('normalizeView falls back to defaults for unknown values', () => {
  assert.deepEqual(M.normalizeView({ sort: 'nope', status: 'weird', q: 3 }), M.DEFAULT_VIEW);
  assert.deepEqual(M.normalizeView(null), M.DEFAULT_VIEW);
});
