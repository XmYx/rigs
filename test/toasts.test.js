// Notification rules (docs/notes/notifications-audit.md §2): quiet defaults, clamped caller timeouts, buttons stay
// reachable, and a closed attention banner only comes back for a new waiting agent.
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { attnKey, bannerVisible, resumeAfter, toastDuration } from '../ui/src/toasts.js';

test('toasts close themselves: level defaults, caller ms clamped to 3–30 s, 20 s minimum with a button', () => {
  assert.equal(toastDuration('info'), 4000);
  assert.equal(toastDuration('ok'), 4000);
  assert.equal(toastDuration('error'), 8000);
  assert.equal(toastDuration('attn'), 20000);
  assert.equal(toastDuration('weird'), 4000);
  assert.equal(toastDuration('ok', 12000), 12000);
  assert.equal(toastDuration('ok', 500), 3000);
  assert.equal(toastDuration('ok', 600000), 30000);
  assert.equal(toastDuration('ok', 9000, true), 20000);
  assert.equal(toastDuration('ok', 60000, true), 30000);
  assert.equal(resumeAfter(300), 2000);
  assert.equal(resumeAfter(5000), 5000);
});

test('a closed attention banner stays closed until a new agent (or a new wait) needs Sir', () => {
  const a = { key: 'm1:claude:s1', since: 100 };
  const b = { key: 'm2:codex:s2', since: 200 };
  assert.equal(bannerVisible([], new Set()), false);
  assert.equal(bannerVisible([a], new Set()), true);
  const closed = new Set([a, b].map(attnKey));
  assert.equal(bannerVisible([a, b], closed), false);
  assert.equal(bannerVisible([a], closed), false, 'one resolving does not bring it back');
  assert.equal(bannerVisible([a, { key: 'm3:claude:s3', since: 300 }], closed), true, 'a new agent does');
  assert.equal(bannerVisible([{ ...a, since: 400 }], closed), true, 'the same agent waiting again does');
});
