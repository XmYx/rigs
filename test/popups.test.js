// Session popups: dedupe, setting, stagger (UI bookkeeping, no DOM).
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { createPopups, STAGGER_MS } from '../ui/src/popups.js';

const msg = (id, extra = {}) => ({ type: 'notify', session: { nodeId: 'n1', nodeName: 'mac', kind: 'tmux', id, title: id, ...extra } });

function rig(enabled = true) {
  const opened = [];
  const timers = [];
  const p = createPopups({ enabled: () => enabled, open: (s) => opened.push(s.id), now: () => 1000, schedule: (fn, ms) => timers.push({ fn, ms }) });
  return { p, opened, timers };
}

test('a session message opens once; repeats and already-marked sessions are ignored', () => {
  const { p, timers } = rig();
  assert.equal(p.handle(msg('a')), true);
  assert.equal(p.handle(msg('a')), false);
  p.mark('n1', 'tmux', 'b');
  assert.equal(p.handle(msg('b')), false);
  assert.equal(timers.length, 1);
});

test('messages without a session, or with the setting off, do nothing', () => {
  assert.equal(rig().p.handle({ type: 'notify', text: 'hi' }), false);
  assert.equal(rig(false).p.handle(msg('a')), false);
});

test('several arriving at once are staggered', () => {
  const { p, timers, opened } = rig();
  ['a', 'b', 'c'].forEach((id) => p.handle(msg(id)));
  assert.deepEqual(timers.map((t) => t.ms), [0, STAGGER_MS, STAGGER_MS * 2]);
  timers.forEach((t) => t.fn());
  assert.deepEqual(opened, ['a', 'b', 'c']);
});
