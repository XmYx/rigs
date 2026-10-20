// Top menu bar: the command registry's when/enabled logic and shortcut matching, and the Removed-items store's
// remove → restore round trip (pure UI modules, no DOM).
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { test } from 'node:test';
import { createRegistry, formatShortcut, inTextField, matchShortcut, parseShortcut } from '../ui/src/commands.js';
import { createRemovedStore } from '../ui/src/removed-store.js';

const key = (k, mods = {}) => ({ key: k, code: /^[a-z]$/i.test(k) ? `Key${k.toUpperCase()}` : '', ctrlKey: false, metaKey: false, altKey: false, shiftKey: false, ...mods });

function memStorage(init = {}) {
  const m = new Map(Object.entries(init));
  return { getItem: (k) => (m.has(k) ? m.get(k) : null), setItem: (k, v) => m.set(k, String(v)), removeItem: (k) => m.delete(k), m };
}

// ------------------------------------------------------------------ registry

test('register needs an id and run(); unknown commands are neither visible nor enabled', () => {
  const r = createRegistry();
  assert.throws(() => r.register({ id: 'x' }));
  assert.throws(() => r.register({ run() {} }));
  assert.equal(r.isVisible('nope'), false);
  assert.equal(r.isEnabled('nope'), false);
  assert.equal(r.run('nope'), false);
});

test('when hides a command, enabled greys it out, and run only runs enabled commands', () => {
  const r = createRegistry();
  const ran = [];
  r.register({ id: 'undo', label: 'Undo', when: (ctx) => !ctx.phone, enabled: (ctx) => ctx.canUndo, run: (ctx, a) => { ran.push(a); return 'done'; } });
  assert.equal(r.isVisible('undo', { phone: true }), false);
  assert.equal(r.isEnabled('undo', { phone: true, canUndo: true }), false, 'not applicable → not enabled either');
  assert.equal(r.isVisible('undo', { phone: false }), true);
  assert.equal(r.isEnabled('undo', { canUndo: false }), false);
  assert.equal(r.run('undo', { canUndo: false }, 1), false);
  assert.deepEqual(ran, []);
  assert.equal(r.run('undo', { canUndo: true }, 2), 'done');
  assert.deepEqual(ran, [2]);
});

test('a predicate that throws counts as false instead of breaking the menu', () => {
  const r = createRegistry();
  r.register({ id: 'a', label: 'A', when: () => { throw new Error('boom'); }, run() {} });
  r.register({ id: 'b', label: 'B', enabled: () => { throw new Error('boom'); }, run() {} });
  assert.equal(r.isVisible('a'), false);
  assert.equal(r.isVisible('b'), true);
  assert.equal(r.isEnabled('b'), false);
});

test('labels and checked state can depend on context and arguments; run() without a return gives true', () => {
  const r = createRegistry();
  r.register({ id: 'panel', label: (ctx, a) => `${a.title}${ctx.x ? '!' : ''}`, checked: (c, a) => a.open, run() {} });
  assert.equal(r.label('panel', { x: true }, { title: 'Chat', open: true }), 'Chat!');
  assert.equal(r.isChecked('panel', {}, { title: 'Chat', open: true }), true);
  assert.equal(r.isChecked('panel', {}, { title: 'Chat', open: false }), false);
  assert.equal(r.run('panel', {}, { title: 'Chat' }), true);
  assert.equal(r.label('missing'), 'missing');
});

test('forEvent finds the command for a shortcut, skips text fields unless global, and honours enabled', () => {
  const r = createRegistry();
  let canUndo = true;
  r.register({ id: 'undo', label: 'Undo', shortcut: 'Mod+Z', enabled: () => canUndo, run() {} });
  r.register({ id: 'menubar', label: 'Menu bar', shortcut: 'Mod+Shift+M', global: true, run() {} });
  r.register({ id: 'redo', label: 'Redo', shortcut: ['Mod+Shift+Z', 'Mod+Y'], run() {} });
  assert.equal(r.forEvent(key('z', { ctrlKey: true }))?.id, 'undo');
  assert.equal(r.forEvent(key('z', { metaKey: true }), { mac: true })?.id, 'undo');
  assert.equal(r.forEvent(key('z', { metaKey: true }), { mac: false }), null, 'Meta+Z is not Mod+Z off a Mac');
  assert.equal(r.forEvent(key('z', { ctrlKey: true }), { inText: true }), null, 'Ctrl+Z in a field stays the field\'s undo');
  assert.equal(r.forEvent(key('M', { ctrlKey: true, shiftKey: true }), { inText: true })?.id, 'menubar');
  assert.equal(r.forEvent(key('y', { ctrlKey: true }))?.id, 'redo');
  assert.equal(r.forEvent(key('Z', { ctrlKey: true, shiftKey: true }))?.id, 'redo');
  canUndo = false;
  assert.equal(r.forEvent(key('z', { ctrlKey: true })), null);
});

test('shortcut parsing, matching and display', () => {
  assert.deepEqual(parseShortcut('Mod+Shift+M'), { mod: true, shift: true, alt: false, ctrl: false, meta: false, key: 'm' });
  assert.equal(matchShortcut('F10', key('F10')), true);
  assert.equal(matchShortcut('?', key('?', { shiftKey: true })), true, 'a symbol ignores the Shift it needs');
  assert.equal(matchShortcut('/', key('/')), true);
  assert.equal(matchShortcut('/', key('/', { ctrlKey: true })), false);
  assert.equal(matchShortcut('Alt+W', { key: '∑', code: 'KeyW', altKey: true }), true, 'Alt+letter on a Mac matches by physical key');
  assert.equal(matchShortcut('Mod+Z', key('z', { ctrlKey: true, altKey: true })), false);
  assert.equal(formatShortcut('Mod+Shift+M', true), '⇧⌘M');
  assert.equal(formatShortcut('Mod+Shift+M', false), 'Ctrl+Shift+M');
  assert.equal(formatShortcut(['Mod+Shift+Z', 'Mod+Y'], false), 'Ctrl+Shift+Z');
  assert.equal(formatShortcut('F10'), 'F10');
});

test('inTextField: inputs, textareas and editable content are typing targets; buttons and checkboxes are not', () => {
  assert.equal(inTextField({ tagName: 'INPUT', type: 'text' }), true);
  assert.equal(inTextField({ tagName: 'INPUT', type: 'search' }), true);
  assert.equal(inTextField({ tagName: 'INPUT', type: 'checkbox' }), false);
  assert.equal(inTextField({ tagName: 'TEXTAREA' }), true);
  assert.equal(inTextField({ tagName: 'DIV', isContentEditable: true }), true);
  assert.equal(inTextField({ tagName: 'BUTTON', closest: () => null }), false);
  assert.equal(inTextField(null), false);
});

// ------------------------------------------------------------------ removed-items store

test('remove → restore round trip persists, and a fresh store (a reload) sees the same list', () => {
  const storage = memStorage();
  let t = 1000;
  const s = createRemovedStore({ storage, now: () => t++ });
  const seen = [];
  s.subscribe((c) => seen.push(`${c.op}:${c.item?.id}`));
  const it = s.remove({ kind: 'app', id: 'mac/krea', label: 'Krea Studio', icon: '🎨' });
  assert.deepEqual(it, { kind: 'app', id: 'mac/krea', label: 'Krea Studio', icon: '🎨', at: 1000 });
  assert.equal(s.remove({ kind: 'app', id: 'mac/krea', label: 'again' }), null, 'removing twice is a no-op');
  s.remove({ kind: 'panel', id: 'usage', label: 'Tokens & time' });
  assert.equal(s.isRemoved('app', 'mac/krea'), true);
  assert.equal(s.size, 2);

  const reloaded = createRemovedStore({ storage });
  assert.deepEqual(reloaded.list().map((x) => `${x.kind}:${x.id}`), ['app:mac/krea', 'panel:usage']);
  assert.equal(reloaded.canUndo(), false, 'undo history is per page');

  assert.equal(reloaded.restore('panel', 'usage').label, 'Tokens & time');
  assert.equal(reloaded.restore('panel', 'usage'), null);
  assert.deepEqual(createRemovedStore({ storage }).list('panel'), [], 'the restore survives a reload too');
  assert.deepEqual(createRemovedStore({ storage }).list('app').map((x) => x.id), ['mac/krea']);
  assert.deepEqual(seen, ['remove:mac/krea', 'remove:usage']);
});

test('undo reverts the last remove or restore, redo does it again, and a new action clears redo', () => {
  const s = createRemovedStore({ storage: memStorage() });
  s.remove({ kind: 'panel', id: 'left', label: 'Side panel' });
  assert.equal(s.peekUndo().op, 'remove');
  assert.equal(s.undo().item.id, 'left');
  assert.equal(s.isRemoved('panel', 'left'), false);
  assert.equal(s.canRedo(), true);
  s.redo();
  assert.equal(s.isRemoved('panel', 'left'), true);
  s.restore('panel', 'left');
  assert.equal(s.peekUndo().op, 'restore');
  s.undo();
  assert.equal(s.isRemoved('panel', 'left'), true, 'undoing a restore removes it again');
  s.remove({ kind: 'panel', id: 'bar', label: 'Toolbar' });
  assert.equal(s.canRedo(), false);
  assert.equal(s.restoreAll().length, 2);
  assert.equal(s.size, 0);
  assert.equal(s.undo().op, 'restore');
  assert.equal(s.size, 1);
});

test('a broken or foreign storage value starts empty, and storage that throws is survivable', () => {
  assert.equal(createRemovedStore({ storage: memStorage({ 'rigs.removed': '{nope' }) }).size, 0);
  assert.equal(createRemovedStore({ storage: memStorage({ 'rigs.removed': '[{"id":"x"},null,{"kind":"app","id":"a/b"}]' }) }).size, 1);
  const throwing = { getItem() { throw new Error('denied'); }, setItem() { throw new Error('denied'); } };
  const s = createRemovedStore({ storage: throwing });
  assert.ok(s.remove({ kind: 'panel', id: 'x' }));
  assert.equal(s.isRemoved('panel', 'x'), true);
});

test('reload() re-reads storage written by another tab', () => {
  const storage = memStorage();
  const a = createRemovedStore({ storage });
  const b = createRemovedStore({ storage });
  a.remove({ kind: 'app', id: 'n/x', label: 'X' });
  assert.equal(b.isRemoved('app', 'n/x'), false);
  b.reload();
  assert.equal(b.isRemoved('app', 'n/x'), true);
});

// ------------------------------------------------------------------ jarvis-commands.js menus (source: it needs the DOM)

test('Window menu: the Ask JARVIS group is there and every menu entry is a registered command', () => {
  const src = fs.readFileSync(new URL('../ui/src/jarvis-commands.js', import.meta.url), 'utf8');
  const known = new Set([...src.matchAll(/id: '([\w.]+)'/g)].map((m) => m[1]));
  const used = new Set([...src.matchAll(/cmd: '([\w.]+)'/g)].map((m) => m[1]));
  for (const c of used) assert.ok(known.has(c), `${c} is in a menu but not registered`);
  for (const c of ['window.ask', 'window.askTopbar', 'window.askFloat', 'window.askHide']) assert.ok(used.has(c) && known.has(c), c);
  const shortcuts = [...src.matchAll(/shortcut: '([^']+)'/g)].map((m) => m[1]);
  assert.equal(new Set(shortcuts).size, shortcuts.length, 'no shortcut is bound twice');
  assert.ok(shortcuts.includes('Mod+K'), '⌘/Ctrl+K opens or focuses Ask JARVIS');
  assert.match(src, /id: 'window\.ask',[^\n]*global: true/, 'it works while typing in a field, as before');
  assert.ok(matchShortcut('Mod+K', key('k', { metaKey: true }), { mac: true }));
  assert.ok(matchShortcut('Mod+K', key('k', { ctrlKey: true }), { mac: false }));
});
