// Notices with an Open button and the notification history (ui/src/notify-history.js, main.js): the pure parts in
// Node, plus static checks of the toast button, the history window, the Tools menu entry and the openFiledWork pref.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const read = (f) => fs.readFileSync(path.join(ROOT, f), 'utf8');
const N = await import('../ui/src/notify-history.js');
const { BRIDGED } = await import('../ui/src/prefs-bridge.js');
const { itemById } = await import('../ui/src/settings-model.js');

test('noticeAction: open (a ui-open push) and run actions, nothing else', () => {
  const push = { type: 'ui-open', id: 'uo-1', view: 'model', nodeId: 'n', path: '/x/chair.glb' };
  assert.deepEqual(N.noticeAction({ action: { type: 'open', open: push } }), { kind: 'open', label: 'Open', open: push });
  assert.equal(N.noticeAction({ action: { type: 'open', label: 'Show it', open: push } }).label, 'Show it');
  assert.deepEqual(N.noticeAction({ action: { type: 'run', node: 'mac', command: 'ls', title: 'List' } }), { kind: 'run', label: 'Run', node: 'mac', command: 'ls', title: 'List' });
  assert.equal(N.noticeAction({ action: { type: 'open' } }), null);
  assert.equal(N.noticeAction({ action: { type: 'attention', item: {} } }), null);
  assert.equal(N.noticeAction({}), null);
  assert.equal(N.noticeAction(null), null);
});

test('noticeOf / pushNotice: notify events are kept (not session pop-ups), newest last, 50 at most, repeats within 2 s folded', () => {
  assert.equal(N.noticeOf({ type: 'mesh' }), null);
  assert.equal(N.noticeOf({ type: 'notify', text: 'x', session: { id: 's' } }), null);
  assert.equal(N.noticeOf({ type: 'notify', text: '' }), null);
  const e = N.noticeOf({ type: 'notify', text: 'Done.', from: 'agent', level: 'ok', action: { type: 'open', open: { type: 'ui-open', view: 'url', url: 'https://a' } } }, 1000);
  assert.deepEqual([e.at, e.from, e.text, e.level, e.action.kind], [1000, 'agent', 'Done.', 'ok', 'open']);
  let list = [];
  for (let i = 0; i < 60; i++) N.pushNotice(list, N.noticeOf({ type: 'notify', text: `n${i}` }, i * 5000));
  assert.equal(list.length, N.HISTORY_CAP);
  assert.equal(list[0].text, 'n10');
  assert.equal(list.at(-1).text, 'n59');
  N.pushNotice(list, N.noticeOf({ type: 'notify', text: 'n59' }, 59 * 5000 + 500));
  assert.equal(list.at(-1).text, 'n59');
  assert.equal(list.length, N.HISTORY_CAP, 'the repeat was folded');
  assert.equal(N.pushNotice(list, null), list);
  assert.equal(N.shortText('Ready.\n---\nlong details'), 'Ready.');
  assert.equal(N.shortText('Ready.'), 'Ready.');
});

test('main.js: a notify with an open action gets an Open toast button that runs onUiOpen; history is kept even while toasts are off; Tools › Notifications', () => {
  const main = read('ui/src/main.js');
  assert.match(main, /pushNotice\(notifyHistory, noticeOf\(m\)\)/);
  assert.ok(main.indexOf('pushNotice(notifyHistory') < main.indexOf("if (m.type === 'notify' && !prefs().notifications)"), 'recorded before the notifications switch is checked');
  assert.match(main, /action\?\.type === 'open' && action\.open\) return \{ label: action\.label \|\| 'Open', run: \(\) => onUiOpen\(\{ \.\.\.action\.open, id: '' \}\) \}/);
  assert.match(main, /const act = noticeButton\(m\.action\);/);
  assert.match(main, /function openNotifications\(\)/);
  assert.match(main, /notifications: \(\) => openNotifications\(\)/);
  const jc = read('ui/src/jarvis-commands.js');
  assert.match(jc, /id: 'tools\.notifications'[^\n]*when: \(\) => !!deps\.notifications/);
  assert.match(jc, /\{ cmd: 'tools\.notifications' \}/);
  assert.match(read('ui/src/styles.css'), /\.notify-row \{/);
});

test('route event: filed work opens the Projects window once, without focus, behind the openFiledWork preference (default on)', () => {
  const main = read('ui/src/main.js');
  assert.match(main, /openFiledWork\(e, filedOpen\)/);
  assert.match(main, /function openFiledWork\(e, opened\) \{\s*if \(opened\.done \|\| !store\.get\('openFiledWork', true\) \|\| !\['plan', 'implement'\]\.includes\(e\.route\)\) return;/);
  assert.match(main, /projectsWindow\(\{ owner, id: projectId \}, \{ focus: false \}\)/);
  const it = itemById('ui.openFiledWork');
  assert.ok(it && it.control === 'switch' && it.default === true, 'a switch in System Preferences, on by default');
  assert.equal(it.pref.key, 'rigs.openFiledWork');
  assert.ok(BRIDGED['ui.openFiledWork'], 'bridged to the live store');
  assert.match(read('ui/src/projects.js'), /focus = true \}\) \{/);
});

test('tool chips: a tool-done event resolves the chip of the tool event with the same id; without ids chips resolve when the reply ends', () => {
  const main = read('ui/src/main.js');
  assert.match(main, /if \(e\.id\) chipsById\.set\(String\(e\.id\), chip\);/);
  assert.match(main, /e\.type === 'tool-done'\) \{[\s\S]*?chip\.done\(e\.ok !== false\); chips\.delete\(chip\)/);
  assert.match(main, /for \(const c of chips\) c\.done\(true\);/);
});

test('C5: mergeNotices folds the server\'s history (GET notify/history) into the page\'s list — by time, no duplicates, the last 50', () => {
  const mine = [{ at: 30, from: 'a', text: 'three', level: 'info', action: null }];
  const server = [{ at: 10, from: 'a', text: 'one', level: 'info', action: null }, { at: 30, from: 'a', text: 'three', level: 'info', action: null }, { at: 20, from: 'b', text: 'two', level: 'ok', action: { kind: 'open', label: 'Open', open: { view: 'url', url: 'https://x' } } }];
  const m = N.mergeNotices(mine, server);
  assert.deepEqual(m.map((n) => n.text), ['one', 'two', 'three']);
  assert.equal(m[1].action.open.url, 'https://x');
  assert.deepEqual(N.mergeNotices([], [null, undefined]), []);
  const many = Array.from({ length: 70 }, (_, i) => ({ at: i, from: 'a', text: `n${i}`, level: 'info', action: null }));
  const capped = N.mergeNotices([], many);
  assert.equal(capped.length, 50);
  assert.equal(capped[0].text, 'n20');
  assert.notEqual(N.mergeNotices(mine, []), mine, 'a new list');
});
