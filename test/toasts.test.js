// Notification rules (docs/notes/notifications-audit.md §2): quiet defaults, clamped caller timeouts, buttons stay
// reachable, and a closed attention banner only comes back for a new waiting agent.
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { bannerVisible, closedTexts, prefs, resumeAfter, toastAllowed, toastDuration } from '../ui/src/toasts.js';

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

const memStore = () => { const m = new Map(); return { getItem: (k) => (m.has(k) ? m.get(k) : null), setItem: (k, v) => m.set(k, String(v)) }; };

test('closed stays closed: the banner after its ×, a toast after its ×', () => {
  const p = prefs(memStore());
  const a = [{ key: 'm1:claude:s1', since: 100 }];
  assert.equal(bannerVisible([], p), false);
  assert.equal(bannerVisible(a, p), true);
  p.attnBanner = false;
  assert.equal(bannerVisible([...a, { key: 'm3:claude:s3', since: 300 }], p), false, 'a new agent does not bring it back');
  assert.equal(toastAllowed('Build finished', p), true);
  closedTexts.add('Build finished');
  assert.equal(toastAllowed('Build finished', p), false);
  assert.equal(toastAllowed('Something else', p), true);
});

test('notifications off silences toasts and the banner; the choice is remembered', () => {
  const store = memStore();
  prefs(store).notifications = false;
  const p = prefs(store);
  assert.equal(p.notifications, false);
  assert.equal(toastAllowed('anything', p), false);
  assert.equal(bannerVisible([{ key: 'k' }], p), false);
  assert.equal(prefs(null).notifications, true, 'no storage: on by default');
});
