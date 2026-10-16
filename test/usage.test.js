// Work dashboard data: plan-limit parsing, transcript token accounting, project progress (no daemon needed).
import assert from 'node:assert/strict';
import { test } from 'node:test';

const U = await import('../src/usage.js');

test('parseUsage: 5-hour, week and per-model weekly limits (limits[] first, model_scoped fallback)', () => {
  const r = {
    subscription_type: 'team',
    rate_limits: {
      five_hour: { utilization: 16, resets_at: '2026-10-17T02:59:59Z' },
      seven_day: { utilization: 62, resets_at: '2026-10-18T04:59:59Z' },
      limits: [{ kind: 'session', percent: 16 }, { kind: 'weekly_scoped', percent: 57, resets_at: '2026-10-18T04:59:59Z', scope: { model: { display_name: 'Fable' } } }],
      model_scoped: [{ display_name: 'Fable', utilization: 99 }, { display_name: 'Opus', utilization: 12, resets_at: null }],
    },
  };
  const u = U.parseUsage(r);
  assert.deepEqual(u.session, { pct: 16, resetsAt: '2026-10-17T02:59:59Z' });
  assert.equal(u.week.pct, 62);
  assert.deepEqual(u.models.map((m) => [m.name, m.pct]), [['Fable', 57], ['Opus', 12]]);
  assert.equal(u.subscription, 'team');
  assert.deepEqual(U.parseUsage(null), { session: null, week: null, models: [], subscription: null });
});

test('foldRecord: one API message written per content block counts once; todos give progress', () => {
  const acc = U.newAcc();
  const msg = (id, model, out, content = []) => ({ type: 'assistant', timestamp: '2026-10-17T00:00:00Z', message: { id, model, content, usage: { input_tokens: 2, output_tokens: out, cache_read_input_tokens: 1000, cache_creation_input_tokens: 10 } } });
  U.foldRecord(acc, msg('m1', 'claude-opus-5-5', 50, [{ type: 'text', text: 'a' }]));
  U.foldRecord(acc, msg('m1', 'claude-opus-5-5', 50, [{ type: 'tool_use', name: 'TodoWrite', input: { todos: [{ content: 'a', status: 'completed' }, { content: 'b', status: 'in_progress' }] } }]));
  U.foldRecord(acc, msg('m2', 'claude-haiku-5-5', 7));
  assert.equal(acc.perModel['claude-opus-5-5'].output, 50, 'm1 counted once');
  assert.equal(acc.perModel['claude-opus-5-5'].messages, 1);
  assert.equal(acc.perModel['claude-haiku-5-5'].output, 7);
  assert.equal(acc.lastModel, 'claude-haiku-5-5');
  assert.equal(acc.context, 1012);
  assert.deepEqual(acc.todos.map((t) => t.status), ['completed', 'in_progress'], 'todos still read from a repeated message');
});

test('projectProgress: only projects with work in flight, with percent and running tasks', () => {
  const ps = [
    { id: 'a', name: 'A', status: 'running', tasks: [{ id: 't1', title: 'x', status: 'done' }, { id: 't2', title: 'y', status: 'running', assign: { node: 'mac', model: 'claude-sonnet-5-5' } }, { id: 't3', title: 'z', status: 'failed' }, { id: 't4', status: 'todo' }] },
    { id: 'b', name: 'B', status: 'done', tasks: [{ status: 'done' }] },
  ];
  const [a, ...rest] = U.projectProgress(ps);
  assert.equal(rest.length, 0);
  assert.equal(a.pct, 25);
  assert.equal(a.blocked, 1);
  assert.deepEqual(a.running.map((t) => [t.title, t.node, t.model]), [['y', 'mac', 'claude-sonnet-5-5']]);
});
