// The Finder-style file browser's pure model (ui/src/finder-model.js): sidebar from the mesh, paths and crumbs,
// Miller column derivation, back/forward history, sorting, filtering, selection ranges, shortcuts and preferences.
import assert from 'node:assert/strict';
import { test } from 'node:test';

const F = await import('../ui/src/finder-model.js');

const NODES = [
  { id: 'n-lin', name: 'magix-system', online: true, rigs: true, platform: 'linux', home: '/home/magix' },
  { id: 'ts:phone', name: 'iphone172', online: true, rigs: false, platform: 'ios' },
  { id: 'n-mac', name: 'macbookpro', online: true, rigs: true, self: true, platform: 'mac', home: '/Users/mix' },
  { id: 'n-old', name: 'attic', online: false, rigs: true, platform: 'linux' },
];

test('sidebar: every machine the mesh reports, this one first, offline and non-RIGS ones greyed out', () => {
  const s = F.sidebarModel(NODES, { current: 'n-mac' });
  assert.deepEqual(s.locations.map((l) => l.name), ['macbookpro', 'magix-system', 'attic', 'iphone172']);
  assert.deepEqual(s.locations.map((l) => l.browsable), [true, true, false, false]);
  assert.deepEqual(s.locations.map((l) => l.badge), ['online', 'online', 'offline', 'no RIGS']);
  assert.deepEqual(s.locations.map((l) => l.current), [true, false, false, false]);
  assert.equal(s.locations[0].icon, '💻');
  assert.equal(s.locations[1].icon, '🐧');
});

test('sidebar: favourites of the rig being browsed, with their real paths when its home is known', () => {
  const s = F.sidebarModel(NODES, { current: 'n-lin' });
  assert.deepEqual(s.favourites.map((f) => f.label), ['Home', 'Desktop', 'Documents', 'Downloads', 'RIGS Shared']);
  assert.deepEqual(s.favourites.map((f) => f.path), ['~', '~/Desktop', '~/Documents', '~/Downloads', '@shared']);
  assert.ok(s.favourites.every((f) => f.nodeId === 'n-lin'));
  assert.equal(s.favourites[3].full, '/home/magix/Downloads');
  assert.equal(s.favourites[4].full, ''); // the shared folder's place is only known on that machine
  assert.equal(F.activeFavourite(s.favourites, '/home/magix/Downloads/'), 'downloads');
  assert.equal(F.activeFavourite(s.favourites, '/home/magix/Downloads/x'), '');
  // A Windows home
  assert.equal(F.favouritePath('~/Documents', 'C:\\Users\\mix'), 'C:\\Users\\mix\\Documents');
  // Browsing a machine that went offline: no favourites to offer.
  assert.deepEqual(F.sidebarModel(NODES, { current: 'n-old' }).favourites, []);
  assert.deepEqual(F.sidebarModel([], {}), { locations: [], favourites: [] });
});

test('paths: parent, join and crumbs on POSIX and Windows', () => {
  assert.equal(F.parentOf('/Users/mix/Downloads'), '/Users/mix');
  assert.equal(F.parentOf('/Users/mix/Downloads/'), '/Users/mix');
  assert.equal(F.parentOf('/Users'), '/');
  assert.equal(F.parentOf('/'), null);
  assert.equal(F.parentOf('C:\\Users\\mix'), 'C:\\Users');
  assert.equal(F.parentOf('C:\\Users'), 'C:\\');
  assert.equal(F.parentOf('C:\\'), null);
  assert.equal(F.joinPath('/', 'etc'), '/etc');
  assert.equal(F.joinPath('/Users/mix', 'a b'), '/Users/mix/a b');
  assert.equal(F.joinPath('C:\\Users', 'mix'), 'C:\\Users\\mix');
  assert.deepEqual(F.crumbs('/Users/mix/Downloads', { rootName: 'macbookpro' }), [
    { name: 'macbookpro', path: '/' }, { name: 'Users', path: '/Users' }, { name: 'mix', path: '/Users/mix' }, { name: 'Downloads', path: '/Users/mix/Downloads' }]);
  assert.deepEqual(F.crumbs('C:\\Users\\mix').map((c) => c.path), ['C:\\', 'C:\\Users', 'C:\\Users\\mix']);
  assert.deepEqual(F.crumbs('/').map((c) => c.path), ['/']);
  assert.ok(F.isInside('/Users/mix/a', '/Users/mix'));
  assert.ok(F.isInside('/Users/mix', '/Users/mix/'));
  assert.ok(!F.isInside('/Users/mixer', '/Users/mix'));
});

test('column view: the folders from the deepest root that holds the path down to it', () => {
  const roots = ['/Users/mix', '/Users/mix/RIGS-Shared', '/'];
  assert.deepEqual(F.columnPaths('/Users/mix/Downloads/pics', { roots }), ['/Users/mix', '/Users/mix/Downloads', '/Users/mix/Downloads/pics']);
  assert.deepEqual(F.columnPaths('/Users/mix/RIGS-Shared/reports', { roots }), ['/Users/mix/RIGS-Shared', '/Users/mix/RIGS-Shared/reports']);
  assert.deepEqual(F.columnPaths('/Users/mix', { roots }), ['/Users/mix']);
  assert.deepEqual(F.columnPaths('/etc/ssh', { roots: ['/Users/mix'] }), ['/', '/etc', '/etc/ssh']);
  assert.deepEqual(F.columnPaths('D:\\work\\x', { roots: ['C:\\Users\\mix', 'D:\\'] }), ['D:\\', 'D:\\work', 'D:\\work\\x']);
});

test('history: back, forward, a new place drops the forward entries, no duplicates, across machines', () => {
  let h = F.emptyHistory();
  assert.ok(!F.canBack(h) && !F.canForward(h));
  h = F.histPush(h, { nodeId: 'a', path: '/x' });
  h = F.histPush(h, { nodeId: 'a', path: '/x/' }); // the same folder
  assert.equal(h.stack.length, 1);
  h = F.histPush(h, { nodeId: 'a', path: '/x/y' });
  h = F.histPush(h, { nodeId: 'b', path: '/x/y' }); // same path, another machine = another place
  assert.equal(h.stack.length, 3);
  let r = F.histGo(h, -1);
  assert.deepEqual(r.loc, { nodeId: 'a', path: '/x/y' });
  r = F.histGo(r.history, -1);
  assert.deepEqual(r.loc, { nodeId: 'a', path: '/x' });
  assert.ok(!F.canBack(r.history) && F.canForward(r.history));
  assert.equal(F.histGo(r.history, -1).loc, null);
  const fwd = F.histGo(r.history, 1);
  assert.deepEqual(fwd.loc, { nodeId: 'a', path: '/x/y' });
  h = F.histPush(fwd.history, { nodeId: 'a', path: '/z' });
  assert.deepEqual(h.stack.map((s) => s.path), ['/x', '/x/y', '/z']);
  assert.ok(!F.canForward(h));
  h = F.histReplace(h, { nodeId: 'a', path: '/real/z' });
  assert.deepEqual(h.stack.at(-1), { nodeId: 'a', path: '/real/z' });
  let c = F.emptyHistory();
  for (let i = 0; i < 10; i++) c = F.histPush(c, { nodeId: 'a', path: `/${i}` }, 4);
  assert.deepEqual(c.stack.map((s) => s.path), ['/6', '/7', '/8', '/9']);
  assert.equal(c.index, 3);
});

const E = [
  { name: 'b.txt', path: '/d/b.txt', type: 'file', size: 300, mtime: 3 },
  { name: 'A folder', path: '/d/A folder', type: 'dir', size: 0, mtime: 1 },
  { name: 'img10.png', path: '/d/img10.png', type: 'file', size: 50, mtime: 9 },
  { name: 'img2.png', path: '/d/img2.png', type: 'file', size: 5000, mtime: 1 },
  { name: 'z folder', path: '/d/z folder', type: 'dir', size: 0, mtime: 7 },
  { name: 'archive.zip', path: '/d/archive.zip', type: 'file', size: 100, mtime: 5 },
];
const names = (l) => l.map((e) => e.name);

test('sorting: every list column both ways, folders on top, natural name order', () => {
  assert.deepEqual(names(F.sortEntries(E, { key: 'name', dir: 'asc' })), ['A folder', 'z folder', 'archive.zip', 'b.txt', 'img2.png', 'img10.png']);
  assert.deepEqual(names(F.sortEntries(E, { key: 'name', dir: 'desc' })), ['z folder', 'A folder', 'img10.png', 'img2.png', 'b.txt', 'archive.zip']);
  assert.deepEqual(names(F.sortEntries(E, { key: 'mtime', dir: 'desc' })), ['z folder', 'A folder', 'img10.png', 'archive.zip', 'b.txt', 'img2.png']);
  assert.deepEqual(names(F.sortEntries(E, { key: 'size', dir: 'asc' })), ['A folder', 'z folder', 'img10.png', 'archive.zip', 'b.txt', 'img2.png']);
  assert.deepEqual(names(F.sortEntries(E, { key: 'kind', dir: 'asc' })), ['A folder', 'z folder', 'b.txt', 'img2.png', 'img10.png', 'archive.zip']);
  assert.deepEqual(names(F.sortEntries(E, { key: 'mtime', dir: 'asc' }, { foldersFirst: false })).slice(0, 2), ['A folder', 'img2.png']);
  assert.notEqual(F.sortEntries(E), E); // never sorts in place
  assert.deepEqual(F.nextSort({ key: 'name', dir: 'asc' }, 'name'), { key: 'name', dir: 'desc' });
  assert.deepEqual(F.nextSort({ key: 'name', dir: 'asc' }, 'mtime'), { key: 'mtime', dir: 'desc' });
  assert.deepEqual(F.nextSort({ key: 'mtime', dir: 'desc' }, 'kind'), { key: 'kind', dir: 'asc' });
  assert.deepEqual(F.nextSort({ key: 'name', dir: 'asc' }, 'bogus'), { key: 'name', dir: 'asc' });
});

test('kinds and icons', () => {
  assert.equal(F.kindOf({ type: 'dir', name: 'x' }), 'Folder');
  assert.equal(F.kindOf({ type: 'file', name: 'a.PNG' }), 'PNG image');
  assert.equal(F.kindOf({ type: 'file', name: 'notes.txt' }), 'Plain Text');
  assert.equal(F.kindOf({ type: 'file', name: 'x.mp4' }), 'MP4 video');
  assert.equal(F.kindOf({ type: 'file', name: 'x.weird' }), 'WEIRD file');
  assert.equal(F.kindOf({ type: 'file', name: 'Makefile' }), 'Document');
  assert.equal(F.iconOf({ type: 'dir' }), '📁');
  assert.equal(F.iconOf({ type: 'file', name: 'song.mp3' }), '🎵');
  assert.equal(F.iconOf({ type: 'file', name: 'x.bin' }), '📄');
});

test('filter, unique names and rename rules', () => {
  assert.deepEqual(names(F.filterEntries(E, 'IMG')), ['img10.png', 'img2.png']);
  assert.deepEqual(names(F.filterEntries(E, 'folder z')), ['z folder']);
  assert.equal(F.filterEntries(E, '  '), E);
  assert.equal(F.uniqueName('untitled folder', ['a']), 'untitled folder');
  assert.equal(F.uniqueName('untitled folder', ['Untitled Folder', 'untitled folder 2']), 'untitled folder 3');
  assert.equal(F.badName('ok.txt'), '');
  assert.ok(F.badName(''));
  assert.ok(F.badName('a/b'));
  assert.ok(F.badName('a\\b'));
  assert.ok(F.badName('..'));
});

test('selection: click, ⌘-click, shift ranges, select all, arrows in list and icon views, type-to-select', () => {
  const paths = ['/a', '/b', '/c', '/d', '/e', '/f', '/g'];
  let s = F.clickSelect({}, paths, '/b');
  s = F.clickSelect(s, paths, '/e', { shift: true });
  assert.deepEqual(s.picked, ['/b', '/c', '/d', '/e']);
  s = F.clickSelect(s, paths, '/a', { shift: true }); // the range turns around the same anchor
  assert.deepEqual(s.picked, ['/a', '/b']);
  s = F.clickSelect(s, paths, '/g', { ctrl: true });
  assert.deepEqual(s.picked, ['/a', '/b', '/g']);
  assert.deepEqual(F.selectAll(paths).picked, paths);
  assert.deepEqual(F.actionTargets(s.picked, '/g'), ['/a', '/b', '/g']);
  assert.deepEqual(F.actionTargets(s.picked, '/c'), ['/c']);

  // list view
  let k = F.arrowSelect({}, paths, 'ArrowDown');
  assert.deepEqual(k, { picked: ['/a'], anchor: '/a', focus: '/a' });
  k = F.arrowSelect(k, paths, 'ArrowDown');
  k = F.arrowSelect(k, paths, 'ArrowDown', { shift: true });
  k = F.arrowSelect(k, paths, 'ArrowDown', { shift: true });
  assert.deepEqual(k.picked, ['/b', '/c', '/d']);
  assert.equal(k.focus, '/d');
  k = F.arrowSelect(k, paths, 'ArrowUp', { shift: true });
  assert.deepEqual(k.picked, ['/b', '/c']);
  assert.deepEqual(F.arrowSelect(k, paths, 'ArrowLeft'), k); // no sideways move in a list
  assert.deepEqual(F.arrowSelect(k, paths, 'End').picked, ['/g']);
  assert.deepEqual(F.arrowSelect({}, paths, 'ArrowUp').picked, ['/g']);
  assert.deepEqual(F.arrowSelect({ picked: ['/a'] }, paths, 'ArrowUp').picked, ['/a']); // stays at the top
  // icon view, 3 per row
  let g = { picked: ['/b'], anchor: '/b', focus: '/b' };
  g = F.arrowSelect(g, paths, 'ArrowDown', { cols: 3 });
  assert.deepEqual(g.picked, ['/e']);
  g = F.arrowSelect(g, paths, 'ArrowRight', { cols: 3 });
  assert.deepEqual(g.picked, ['/f']);
  g = F.arrowSelect(g, paths, 'ArrowDown', { cols: 3 });
  assert.deepEqual(g.picked, ['/g']); // clamps to the last item
  assert.deepEqual(F.arrowSelect({}, [], 'ArrowDown'), { picked: [], anchor: null, focus: null });

  assert.equal(F.typeSelect(E, 'im'), '/d/img10.png');
  assert.equal(F.typeSelect(E, 'Z'), '/d/z folder');
  assert.equal(F.typeSelect(E, 'q'), null);
});

test('shortcuts: Finder keys with ⌘ (or Ctrl), nothing that edits text while typing', () => {
  const k = (key, mods = {}, code = '') => F.shortcutFor({ key, code, ...mods });
  assert.equal(k('ArrowUp', { metaKey: true }), 'up');
  assert.equal(k('ArrowDown', { metaKey: true }), 'open');
  assert.equal(k('o', { ctrlKey: true }, 'KeyO'), 'open');
  assert.equal(k('[', { metaKey: true }, 'BracketLeft'), 'back');
  assert.equal(k(']', { metaKey: true }, 'BracketRight'), 'forward');
  assert.equal(k('Backspace', { metaKey: true }), 'trash');
  assert.equal(k('N', { metaKey: true, shiftKey: true }, 'KeyN'), 'newFolder');
  assert.equal(k('a', { metaKey: true }, 'KeyA'), 'selectAll');
  assert.equal(k('P', { metaKey: true, shiftKey: true }, 'KeyP'), 'togglePreview');
  assert.equal(k('>', { metaKey: true, shiftKey: true }, 'Period'), 'toggleHidden');
  assert.equal(k('G', { metaKey: true, shiftKey: true }, 'KeyG'), 'goTo');
  assert.equal(k('f', { metaKey: true }, 'KeyF'), 'find');
  assert.equal(k('1', { metaKey: true }, 'Digit1'), 'view:icon');
  assert.equal(k('2', { metaKey: true }, 'Digit2'), 'view:list');
  assert.equal(k('3', { metaKey: true }, 'Digit3'), 'view:column');
  assert.equal(k('Enter'), 'rename');
  assert.equal(k('ArrowLeft'), 'arrow');
  assert.equal(k('ArrowLeft', { altKey: true, ctrlKey: true }), ''); // window tiling keys are left alone
  assert.equal(k('x'), '');
  // In a text field: ⌘A, ⌘⌫, Enter and arrows stay with the field; history and views still work.
  const t = (key, mods = {}, code = '') => F.shortcutFor({ key, code, ...mods }, { typing: true });
  assert.equal(t('a', { metaKey: true }, 'KeyA'), '');
  assert.equal(t('Backspace', { metaKey: true }), '');
  assert.equal(t('Enter'), '');
  assert.equal(t('ArrowDown'), '');
  assert.equal(t('[', { metaKey: true }, 'BracketLeft'), 'back');
  assert.equal(F.shortcutFor(null), '');
});

test('preferences: view, sort and pane widths survive a round trip and bad values are repaired', () => {
  const mem = new Map();
  const storage = { getItem: (k) => mem.get(k) ?? null, setItem: (k, v) => mem.set(k, v) };
  assert.deepEqual(F.loadPrefs(storage), F.normalizePrefs(null));
  assert.equal(F.loadPrefs(storage).view, 'list');
  F.savePrefs(storage, { view: 'column', sort: { key: 'size', dir: 'desc' }, sidebarW: 220, previewW: 410, previewOpen: false });
  assert.deepEqual(F.loadPrefs(storage), { view: 'column', sort: { key: 'size', dir: 'desc' }, sidebarW: 220, previewW: 410, previewOpen: false });
  const fixed = F.normalizePrefs({ view: 'gallery', sort: { key: 'colour' }, sidebarW: 5, previewW: 99999 });
  assert.equal(fixed.view, 'list');
  assert.deepEqual(fixed.sort, { key: 'name', dir: 'asc' });
  assert.equal(fixed.sidebarW, F.LIMITS.sidebar[0]);
  assert.equal(fixed.previewW, F.LIMITS.preview[1]);
  mem.set(F.PREFS_KEY, '{not json');
  assert.equal(F.loadPrefs(storage).view, 'list');
  assert.equal(F.loadPrefs(null).view, 'list');
  const throwing = { getItem: () => { throw new Error('denied'); }, setItem: () => { throw new Error('denied'); } };
  assert.equal(F.loadPrefs(throwing).view, 'list');
  assert.equal(F.savePrefs(throwing, { view: 'icon' }).view, 'icon');
});

test('status line', () => {
  assert.equal(F.statusText({ total: 1 }), '1 item');
  assert.equal(F.statusText({ total: 12 }), '12 items');
  assert.equal(F.statusText({ total: 12, shown: 3, filtered: true }), '3 items of 12');
  assert.equal(F.statusText({ total: 12, shown: 12, selected: 2 }), '2 of 12 items selected');
});

// ------------------------------------------------------------------ drag and drop

import {
  clashText, dragPayload, dropAction, dropEffect, findClashes, parseDrag, peekUndo, popUndo, pushUndo, undoCalls, UNDO_LIMIT, shortcutFor,
} from '../ui/src/finder-model.js';

const srcOf = (nodeId, ...paths) => ({ nodeId, nodeName: nodeId, items: paths.map((p) => ({ path: p, name: p.split('/').pop(), type: p.endsWith('/') ? 'dir' : undefined })) });

test('dropAction: same rig moves, Option copies, another rig always copies', () => {
  const s = srcOf('a', '/h/x/f.txt');
  assert.equal(dropAction(s, { nodeId: 'a', path: '/h/y' }), 'move');
  assert.equal(dropAction(s, { nodeId: 'a', path: '/h/y' }, { alt: true }), 'copy');
  assert.equal(dropAction(s, { nodeId: 'b', path: '~' }), 'pull');
  assert.equal(dropAction(s, { nodeId: 'b', path: '~' }, { alt: true }), 'pull');
  assert.equal(dropEffect('move'), 'move');
  assert.equal(dropEffect('copy'), 'copy');
  assert.equal(dropEffect('pull'), 'copy', 'the copy badge shows for a cross-rig drop');
  assert.equal(dropEffect('none'), 'none');
});

test('dropAction: no drop onto where it already is, onto itself, or a folder into its own subtree', () => {
  const f = srcOf('a', '/h/x/f.txt');
  assert.equal(dropAction(f, { nodeId: 'a', path: '/h/x' }), 'none', 'a move to its own folder');
  assert.equal(dropAction(f, { nodeId: 'a', path: '/h/x' }, { alt: true }), 'copy', 'Option duplicates beside itself');
  const d = { nodeId: 'a', nodeName: 'a', items: [{ path: '/h/dir', name: 'dir', type: 'dir' }] };
  assert.equal(dropAction(d, { nodeId: 'a', path: '/h/dir' }), 'none');
  assert.equal(dropAction(d, { nodeId: 'a', path: '/h/dir/sub' }), 'none');
  assert.equal(dropAction(d, { nodeId: 'a', path: '/h/dir/sub' }, { alt: true }), 'none');
  assert.equal(dropAction(d, { nodeId: 'a', path: '/h/dir2' }), 'move', 'a sibling with the same prefix is not inside it');
  assert.equal(dropAction(d, { nodeId: 'b', path: '/h/dir' }), 'pull', 'another rig has its own /h/dir');
  const mixed = srcOf('a', '/h/x/a.txt', '/h/y/b.txt');
  assert.equal(dropAction(mixed, { nodeId: 'a', path: '/h/x' }), 'move', 'one item elsewhere makes it a move');
  assert.equal(dropAction(null, { nodeId: 'a', path: '/h' }), 'none');
  assert.equal(dropAction(f, { nodeId: 'a', path: '' }), 'none');
});

test('dragPayload / parseDrag: multi-item drags round-trip; the older single-item form still parses', () => {
  const p = dragPayload({ nodeId: 'a', nodeName: 'Mac', entries: [{ path: '/h/a.txt', name: 'a.txt', type: 'file' }, { path: '/h/d', name: 'd', type: 'dir' }] });
  assert.equal(p.path, '/h/a.txt', 'the first item stays at the top level for desktop.js');
  const back = parseDrag(JSON.stringify(p));
  assert.deepEqual(back.items.map((i) => i.path), ['/h/a.txt', '/h/d']);
  assert.equal(back.nodeName, 'Mac');
  assert.deepEqual(parseDrag(JSON.stringify({ nodeId: 'a', path: '/h/z.txt', name: 'z.txt' })).items, [{ path: '/h/z.txt', name: 'z.txt', type: undefined }]);
  for (const bad of ['', 'nope', '{}', JSON.stringify({ nodeId: 'a' }), JSON.stringify({ path: '/x' }), JSON.stringify({ nodeId: 'a', items: [{ name: 'no path' }] })]) assert.equal(parseDrag(bad), null, bad);
});

test('findClashes / clashText: names that exist, worded like Finder', () => {
  assert.deepEqual(findClashes(['a', 'b', 'c'], ['c', 'a', 'z']), ['a', 'c']);
  assert.deepEqual(findClashes(['a'], []), []);
  assert.deepEqual(findClashes(['Notes.txt'], ['notes.txt']), ['Notes.txt'], 'case-blind: on macOS/Windows it is the same file');
  const one = clashText(['Report.pdf'], { verb: 'moving', where: '“Docs”' });
  assert.match(one.title, /An item named “Report.pdf” already exists in “Docs”/);
  assert.match(one.detail, /keep both, replace.*moving.*skip.*~\/\.rigs\/trash/);
  const many = clashText(['a', 'b', 'c', 'd', 'e', 'f'], { verb: 'copying' });
  assert.match(many.title, /6 items already exist/);
  assert.match(many.detail, /“a”, “b”, “c”, “d” and 2 more/);
});

test('undo stack: newest last, capped, and undoCalls moves items back to their original folder under their old name', () => {
  let st = [];
  assert.equal(peekUndo(st), null);
  st = pushUndo(st, { kind: 'move', nodeId: 'a', items: [{ from: '/h/x/a.txt', to: '/h/y/a.txt' }, { from: '/h/x/b.txt', to: '/h/y/b (2).txt' }, { from: '/h/z/c.txt', to: '/h/y/c.txt' }] });
  st = pushUndo(st, { kind: 'rename', nodeId: 'a', items: [{ from: '/h/y/old.txt', to: '/h/y/new.txt' }] });
  assert.equal(pushUndo(st, { kind: 'move', items: [] }), st, 'an empty entry is ignored');
  assert.equal(peekUndo(st).kind, 'rename');
  assert.deepEqual(undoCalls(peekUndo(st)), [{ dest: '/h/y', paths: [{ from: '/h/y/new.txt', name: 'old.txt' }] }]);
  st = popUndo(st);
  assert.deepEqual(undoCalls(peekUndo(st)), [
    { dest: '/h/x', paths: [{ from: '/h/y/a.txt', name: 'a.txt' }, { from: '/h/y/b (2).txt', name: 'b.txt' }] },
    { dest: '/h/z', paths: [{ from: '/h/y/c.txt', name: 'c.txt' }] },
  ]);
  let big = [];
  for (let i = 0; i < UNDO_LIMIT + 5; i++) big = pushUndo(big, { kind: 'move', items: [{ from: `/a/${i}`, to: `/b/${i}` }] });
  assert.equal(big.length, UNDO_LIMIT);
  assert.equal(peekUndo(big).items[0].from, `/a/${UNDO_LIMIT + 4}`);
});

test('shortcutFor: ⌘Z is undo, but not while typing', () => {
  assert.equal(shortcutFor({ metaKey: true, key: 'z', code: 'KeyZ' }), 'undo');
  assert.equal(shortcutFor({ ctrlKey: true, key: 'z', code: 'KeyZ' }), 'undo');
  assert.equal(shortcutFor({ metaKey: true, key: 'z', code: 'KeyZ' }, { typing: true }), '');
});
