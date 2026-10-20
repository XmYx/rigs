// Desktop mode's pure logic (ui/src/desktop-model.js): grid layout around panels, saved positions, drop placement and
// drop targets, rubber-band and arrow-key selection, icon types, the sync badge, upload paths. The DOM side
// (ui/src/desktop.js) is checked in a real browser by scripts/desktop-mode-check.js.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { test } from 'node:test';
import * as M from '../ui/src/desktop-model.js';
import { registerJarvisProviders, createProviders, resolveMenu } from '../ui/src/ctx-providers.js';

const AREA = { x: 0, y: 100, w: 960, h: 500 }; // 10 columns × 5 rows of 96×100

test('gridOf / cellXY / cellAt', () => {
  assert.deepEqual(M.gridOf(AREA), { cols: 10, rows: 5 });
  assert.deepEqual(M.cellXY(2, 1, AREA), { x: 192, y: 200 });
  assert.deepEqual(M.cellAt(200, 210, AREA), { col: 2, row: 1 });
  assert.deepEqual(M.cellAt(-50, 9999, AREA), { col: 0, row: 4 }, 'clamped into the grid');
});

test('layoutIcons fills columns from the top-left and skips cells under panels', () => {
  const names = ['apps', 'files', 'reports', 'a.txt', 'b.csv', 'c.json', 'd.png'];
  const free = M.layoutIcons(names, { area: AREA });
  assert.deepEqual(names.map((n) => [free[n].col, free[n].row]), [[0, 0], [0, 1], [0, 2], [0, 3], [0, 4], [1, 0], [1, 1]]);
  // A panel over the first two columns (the inspector): icons start in column 2.
  const blocked = [{ x: 0, y: 0, w: 190, h: 900 }];
  const l = M.layoutIcons(names, { area: AREA, blocked });
  assert.ok(names.every((n) => l[n].col >= 2), JSON.stringify(l));
  assert.equal(l.apps.x, 192);
  // No two icons share a cell.
  assert.equal(new Set(Object.values(l).map((p) => `${p.col},${p.row}`)).size, names.length);
});

test('layoutIcons keeps saved cells, refuses bad or clashing ones, and overflows into extra columns', () => {
  const saved = { 'b.csv': { col: 7, row: 3 }, 'a.txt': { col: 7, row: 3 }, 'c.json': { col: 99, row: 0 }, 'd.png': { col: -1, row: 0 } };
  const l = M.layoutIcons(['a.txt', 'b.csv', 'c.json', 'd.png'], { area: AREA, saved });
  assert.deepEqual([l['a.txt'].col, l['a.txt'].row], [7, 3], 'the first claimant keeps the cell');
  assert.notDeepEqual([l['b.csv'].col, l['b.csv'].row], [7, 3]);
  assert.ok(l['c.json'].col < 10 && l['d.png'].col >= 0);
  // A saved cell under a panel is not used.
  const under = M.layoutIcons(['x'], { area: AREA, saved: { x: { col: 0, row: 0 } }, blocked: [{ x: 0, y: 100, w: 96, h: 100 }] });
  assert.notDeepEqual([under.x.col, under.x.row], [0, 0]);
  // 60 icons on a 10×5 grid: none overlap; the rest go to columns past the grid.
  const many = Array.from({ length: 60 }, (_, i) => `f${i}`);
  const big = M.layoutIcons(many, { area: AREA });
  assert.equal(new Set(Object.values(big).map((p) => `${p.col},${p.row}`)).size, 60);
  assert.equal(Math.max(...Object.values(big).map((p) => p.col)), 11);
});

test('placeDrop moves the grabbed icon to the pointed cell and keeps the group together', () => {
  const names = ['a', 'b', 'c', 'd'];
  const pos = M.layoutIcons(names, { area: AREA }); // a 0,0  b 0,1  c 0,2  d 0,3
  const one = M.placeDrop(['a'], 'a', { x: 5 * 96 + 10, y: 100 + 2 * 100 + 10 }, pos, { area: AREA });
  assert.deepEqual(one, { a: { col: 5, row: 2 } });
  // b and c dragged by c to (4,3): b lands one row above c, as it was.
  const two = M.placeDrop(['b', 'c'], 'c', { x: 4 * 96 + 5, y: 100 + 3 * 100 + 5 }, pos, { area: AREA });
  assert.deepEqual(two, { c: { col: 4, row: 3 }, b: { col: 4, row: 2 } });
  // Dropped on an icon that stays: the nearest free cell instead.
  const onD = M.placeDrop(['a'], 'a', { x: 5, y: 100 + 3 * 100 + 5 }, pos, { area: AREA });
  assert.notDeepEqual(onD.a, { col: 0, row: 3 });
  assert.ok(Math.abs(onD.a.col) + Math.abs(onD.a.row - 3) <= 2);
  // Dropped under a panel: pushed out of it.
  const panel = [{ x: 480, y: 100, w: 200, h: 500 }];
  const out = M.placeDrop(['a'], 'a', { x: 500, y: 150 }, pos, { area: AREA, blocked: panel });
  assert.ok(!M.cellBlocked(out.a.col, out.a.row, AREA, M.CELL, panel));
});

test('dropTarget finds the folder under the pointer, never a dragged one or a file', () => {
  const icons = [
    { name: 'apps', dir: true, x: 0, y: 100, w: 88, h: 92 },
    { name: 'notes.md', dir: false, x: 96, y: 100, w: 88, h: 92 },
    { name: 'reports', dir: true, x: 192, y: 100, w: 88, h: 92 },
  ];
  assert.equal(M.dropTarget({ x: 20, y: 120 }, icons), 'apps');
  assert.equal(M.dropTarget({ x: 120, y: 120 }, icons), null, 'a file is no drop target');
  assert.equal(M.dropTarget({ x: 200, y: 150 }, icons, ['reports']), null, 'not onto itself');
  assert.equal(M.dropTarget({ x: 500, y: 500 }, icons), null);
});

test('rubber band and arrow keys select icons', () => {
  const icons = [{ name: 'a', x: 0, y: 0, w: 80, h: 80 }, { name: 'b', x: 100, y: 0, w: 80, h: 80 }, { name: 'c', x: 0, y: 100, w: 80, h: 80 }];
  assert.deepEqual(M.rubberSelect(M.normRect(150, 50, 10, 10), icons), ['a', 'b']);
  assert.deepEqual(M.rubberSelect(M.normRect(90, 85, 95, 95), icons), []);
  const pos = { a: { col: 0, row: 0 }, b: { col: 1, row: 0 }, c: { col: 0, row: 1 }, d: { col: 1, row: 2 } };
  assert.equal(M.arrowMove('a', 'ArrowRight', pos), 'b');
  assert.equal(M.arrowMove('a', 'ArrowDown', pos), 'c');
  assert.equal(M.arrowMove('b', 'ArrowDown', pos), 'd', 'straight down beats a diagonal neighbour');
  assert.equal(M.arrowMove('a', 'ArrowLeft', pos), 'a', 'nothing to the left: stays');
  assert.equal(M.arrowMove(null, 'ArrowDown', pos), 'a', 'no selection: the first icon');
});

test('iconFor, appForFolder, paths and saved positions', () => {
  assert.deepEqual(M.iconFor({ type: 'dir', name: 'files' }), { glyph: '📁', kind: 'Folder', thumb: false });
  assert.equal(M.iconFor({ type: 'file', name: 'a.PNG', size: 10 }).thumb, true);
  assert.equal(M.iconFor({ type: 'file', name: 'huge.jpg', size: 50e6 }).thumb, false);
  assert.equal(M.iconFor({ type: 'file', name: 'sales.csv' }).glyph, '📊');
  assert.equal(M.iconFor({ type: 'file', name: 'data.json' }).glyph, '🧾');
  assert.equal(M.iconFor({ type: 'file', name: 'x.zip' }).kind, 'Archive');
  assert.equal(M.iconFor({ type: 'file', name: 'README' }).glyph, '📄');
  const apps = [{ id: 'wordcloud', name: 'Word cloud', icon: '☁️', nodeId: 'n1', node: 'magix' }, { id: 'other', nodeId: 'n2', node: 'mac' }];
  const self = { id: 'n1', name: 'magix' };
  assert.equal(M.appForFolder({ type: 'dir', name: 'wordcloud' }, 'apps', apps, self)?.id, 'wordcloud');
  assert.equal(M.appForFolder({ type: 'dir', name: 'wordcloud' }, '', apps, self), null, 'only inside apps/');
  assert.equal(M.appForFolder({ type: 'dir', name: 'other' }, 'apps', apps, self), null, 'an app on another machine');
  assert.equal(M.iconFor({ type: 'dir', name: 'wordcloud' }, { app: apps[0] }).glyph, '☁️');
  assert.equal(M.relPath('/home/u/RIGS-Shared', '/home/u/RIGS-Shared/apps/web'), 'apps/web');
  assert.equal(M.relPath('C:\\Users\\u\\RIGS-Shared', 'C:\\Users\\u\\RIGS-Shared'), '');
  assert.equal(M.relPath('/home/u/RIGS-Shared', '/etc'), null);
  assert.equal(M.joinPath('C:\\x\\', 'a.txt', '\\'), 'C:\\x\\a.txt');
  assert.equal(M.positionsKey('n1', 'apps'), 'desktop.pos.n1.apps');
  assert.equal(M.positionsKey('n1', ''), 'desktop.pos.n1..');
  assert.deepEqual(M.renameSaved({ a: { col: 1, row: 2 }, b: { col: 0, row: 0 } }, 'a', 'z'), { b: { col: 0, row: 0 }, z: { col: 1, row: 2 } });
  assert.deepEqual(M.pruneSaved({ a: 1, b: 2 }, ['b']), { b: 2 });
  assert.notEqual(M.listingSig([{ name: 'a', type: 'file', size: 1, mtime: 1 }]), M.listingSig([{ name: 'a', type: 'file', size: 2, mtime: 1 }]));
  assert.equal(M.listingSig([{ name: 'a', size: 1 }, { name: 'b', size: 1 }]), M.listingSig([{ name: 'b', size: 1 }, { name: 'a', size: 1 }]));
});

test('syncBadge reads the shared folder status', () => {
  const now = 1_000_000;
  assert.equal(M.syncBadge(null).tone, 'bad');
  assert.equal(M.syncBadge({ path: '/s', lastSync: now - 5000, peers: [{ node: 'mac', state: 'synced', lastSync: now - 5000 }] }, now).text, 'Synced 5s ago · 1/1 peer');
  assert.equal(M.syncBadge({ path: '/s', lastSync: now, peers: [{ node: 'mac', state: 'synced' }, { node: 'win', state: 'pending' }] }, now).tone, 'warn');
  assert.equal(M.syncBadge({ path: '/s', lastSync: now, peers: [{ node: 'mac', state: 'error', error: 'HTTP 500' }] }, now).tone, 'bad');
  assert.equal(M.syncBadge({ path: '/s', lastSync: now, peers: [{ node: 'mac', state: 'offline' }] }, now).text, 'Peers offline · 0s ago');
  assert.equal(M.syncBadge({ path: '/s', lastSync: now, peers: [] }, now).tone, 'idle');
  assert.match(M.syncBadge({ path: '/s', peers: [{ node: 'mac', state: 'error', error: 'boom' }] }, now).title, /mac: error · boom/);
});

test('uploadTargets keeps folder structure under the drop folder and drops unsafe paths', () => {
  const f = (name) => ({ name, size: 1 });
  assert.deepEqual(M.uploadTargets([{ path: 'a.txt', file: f('a.txt') }, { path: 'photos/b.jpg', file: f('b.jpg') }], 'files').map((x) => x.rel), ['files/a.txt', 'files/photos/b.jpg']);
  assert.deepEqual(M.uploadTargets([{ path: '../x', file: f('x') }, { path: '', file: f('') }, { file: f('c.md') }]).map((x) => x.rel), ['c.md']);
  assert.deepEqual(M.crumbs('apps/web'), [{ label: 'Shared', rel: '' }, { label: 'apps', rel: 'apps' }, { label: 'web', rel: 'apps/web' }]);
});

test('the desktop context menus offer New folder, New text file, Rename, Zip/Unzip, Open with and Show in Files', () => {
  const reg = createProviders();
  registerJarvisProviders(reg, {});
  const noop = () => {};
  const X = { open: noop, openWith: noop, zip: noop, unzip: noop, download: noop, rename: noop, trash: noop, showInFiles: noop };
  const file = { kind: 'file', id: '/s/a.zip', data: { entry: { type: 'file', name: 'a.zip', path: '/s/a.zip' }, actions: X, zip: true, tools: [{ id: 'text', label: 'Text editor', icon: '📝' }], openLabel: 'Open' } };
  const folder = { kind: 'folder', id: '/s', data: { path: '/s', actions: { newFolder: noop, newTextFile: noop, upload: noop, refresh: noop, showInFiles: noop, syncNow: noop } } };
  const labels = (targets) => resolveMenu(reg, targets, {}).map((i) => i.label).filter(Boolean);
  const onIcon = labels([file, folder]).join(' | ');
  for (const want of ['Open', 'Open with', 'Compress to zip', 'Extract here', 'Show in Files', 'Rename…', 'Move to trash…']) assert.ok(onIcon.includes(want), `${want} in: ${onIcon}`);
  const onDesk = labels([folder]).join(' | ');
  for (const want of ['New folder…', 'New text file…', 'Show in Files', 'Sync now']) assert.ok(onDesk.includes(want), `${want} in: ${onDesk}`);
  // The file browser's rows (no showInFiles / openLabel) keep their menu.
  const plain = labels([{ kind: 'file', id: 'x', data: { entry: { type: 'file', name: 'x.txt', path: '/x.txt' }, actions: { open: noop } } }]);
  assert.ok(plain.includes('Preview') && !plain.includes('Show in Files'), plain.join(' | '));
});

test('desktop.js wiring: mounted only while the cloud is hidden, everything torn down through one disposer, no animation loop', () => {
  const src = fs.readFileSync(new URL('../ui/src/desktop.js', import.meta.url), 'utf8');
  const main = fs.readFileSync(new URL('../ui/src/main.js', import.meta.url), 'utf8');
  assert.match(main, /desktopMode\.setActive\(!on\)/, 'syncCloud mounts it exactly when the cloud is off');
  assert.ok(!/requestAnimationFrame\(/.test(src), 'no rAF in desktop mode');
  assert.ok(!/(?<![.\w])(?:addEventListener|setInterval)\(/.test(src), 'listeners and timers go through the disposer');
  assert.match(src, /bin\.add\(\(\) => root\.remove\(\)\)/);
});
