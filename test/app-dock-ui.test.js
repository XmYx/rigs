// The app dock's render-side logic (ui/src/app-dock-model.js): snapshot → sources, geometry and magnification inputs,
// drag-and-drop outcomes (reorder, group by dropping onto, into/out of a group), menu entries, edge reserve — and two
// source checks: the dock draws only from the state module, and its CSS moves existing panels only while it reserves an edge.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { test } from 'node:test';

const S = await import('../ui/src/app-dock-state.js');
const M = await import('../ui/src/app-dock-model.js');

const snap = [
  { node: { id: 'n-mac', name: 'macbookpro', online: true, rigs: true }, apps: [{ id: 'krea', name: 'Krea', icon: '🎨' }, { id: 'notes', name: 'Notes' }] },
  { node: { id: 'n-lin', name: 'linux', online: true, rigs: true }, apps: [{ id: 'fuel', name: 'Fuel', icon: '⛽' }] },
  { node: { id: 'n-off', name: 'iphone', online: false, rigs: false } },
];
const seeded = () => S.mergeSources(S.emptyState(), M.sourcesFromSnapshot(snap, { isRemoved: (a) => a.id === 'notes' }));
const A = (node, id) => `applet:${node}/${id}`;
const view = (s) => S.dockView(s).map((v) => (v.type === 'group' ? `[${v.group.name}:${v.items.map((i) => i.id).join(',')}]` : v.item.id));
const slotsOf = (s, size = 40) => S.dockView(s).map((v, i) => ({ type: v.type, id: v.type === 'group' ? v.group.id : v.item.id, start: i * (size + 6), end: i * (size + 6) + size }));

test('snapshot → sources: every app (by node id) minus removed ones, every machine; offline rigs left out of the dock', () => {
  const src = M.sourcesFromSnapshot(snap, { isRemoved: (a) => a.nodeId === 'n-mac' && a.id === 'notes' });
  assert.deepEqual(src.applets.map((a) => `${a.node}/${a.id}`), ['n-mac/krea', 'n-lin/fuel']);
  assert.deepEqual(src.rigs.map((r) => r.id), ['n-mac', 'n-lin', 'n-off']);
  const s = S.mergeSources(S.emptyState(), src);
  assert.deepEqual(view(s), [A('n-mac', 'krea'), A('n-lin', 'fuel'), 'rig:n-mac', 'rig:n-lin'], 'offline machine is not shown');
  assert.equal(s.items[A('n-mac', 'krea')].icon, '🎨');
  assert.deepEqual(M.sourcesFromSnapshot(null), { applets: [], rigs: [] });
});

test('a pinned rig that goes offline stays, dimmed (live: false)', () => {
  let s = S.setPinned(seeded(), 'rig:n-lin', true);
  s = S.mergeSources(s, M.sourcesFromSnapshot([snap[0], { node: { ...snap[1].node, online: false } }]));
  assert.equal(s.items['rig:n-lin'].live, false);
  assert.ok(view(s).includes('rig:n-lin'));
});

test('geometry: icons shrink to fit, rest centres are symmetric around the dock centre and spaced by size + gap', () => {
  assert.equal(M.fitIcon(5, 2000), M.ICON);
  assert.equal(M.fitIcon(60, 1000), M.MIN_ICON);
  const mid = M.fitIcon(20, 800);
  assert.ok(mid < M.ICON && mid > M.MIN_ICON);
  assert.ok(M.restLength(20, mid) <= 800);
  const c = M.restCentres(4, 40, 500);
  assert.deepEqual(c.map((x) => x - c[0]), [0, 46, 92, 138]);
  assert.equal((c[0] + c[3]) / 2, 500);
  assert.deepEqual(M.restCentres(0, 40, 500), []);
  assert.equal(M.axisOf('bottom'), 'x');
  assert.equal(M.axisOf('left'), 'y');
});

test('magnification input: the icon under the cursor grows most, neighbours less, far ones not at all; easing settles', () => {
  const st = { magnification: true, magnifyStrength: 0.6 };
  const c = M.restCentres(7, 46, 500);
  const scales = S.magnifyScales(c, c[3], st, M.RADIUS);
  assert.ok(Math.abs(scales[3] - 1.6) < 1e-9);
  assert.ok(scales[2] < scales[3] && scales[2] > 1 && Math.abs(scales[2] - scales[4]) < 1e-9);
  assert.equal(scales[0], 1);
  assert.deepEqual(S.magnifyScales(c, c[3], { ...st, magnification: false }), c.map(() => 1));
  let cur = c.map(() => 1);
  let settled = false;
  for (let i = 0; i < 200 && !settled; i++) [cur, settled] = M.easeScales(cur, scales, 16);
  assert.ok(settled);
  assert.deepEqual(cur, scales);
  const [[one]] = M.easeScales([1], [2], 70);
  assert.ok(one > 1.62 && one < 1.64, 'one time constant ≈ 63% of the way');
});

test('dropAt: before / onto zones, the dragged tile is never a target, groups are never dropped onto', () => {
  const slots = [{ type: 'item', id: 'a', start: 0, end: 40 }, { type: 'item', id: 'b', start: 46, end: 86 }, { type: 'group', id: 'g1', start: 92, end: 132 }];
  const d = { type: 'item', id: 'a' };
  assert.deepEqual(M.dropAt(slots, 5, d), { kind: 'before', index: 0 });
  assert.deepEqual(M.dropAt(slots, 66, d), { kind: 'onto', index: 1 });
  assert.deepEqual(M.dropAt(slots, 112, d), { kind: 'onto', index: 2 });
  assert.deepEqual(M.dropAt(slots, 84, d), { kind: 'before', index: 2 });
  assert.deepEqual(M.dropAt(slots, 500, d), { kind: 'before', index: 3 });
  assert.deepEqual(M.dropAt(slots, 20, d), { kind: 'before', index: 1 }, 'its own middle is not "onto itself"');
  assert.deepEqual(M.dropAt(slots, 66, { type: 'group', id: 'g1' }), { kind: 'before', index: 2 }, 'a group cannot go into an item');
});

test('drop onto another item creates a group in the target\'s place, named after their kind', () => {
  const s0 = seeded();
  const krea = A('n-mac', 'krea');
  const fuel = A('n-lin', 'fuel');
  const s = M.applyDrop(s0, { type: 'item', id: fuel, group: null }, { kind: 'onto', index: 0 });
  assert.deepEqual(view(s), [`[Applets:${krea},${fuel}]`, 'rig:n-mac', 'rig:n-lin']);
  // Dragging an earlier item onto a later one: the group lands where the target was.
  const s2 = M.applyDrop(s0, { type: 'item', id: krea, group: null }, { kind: 'onto', index: 2 });
  assert.deepEqual(view(s2), [fuel, `[Group:rig:n-mac,${krea}]`, 'rig:n-lin']);
  const s3 = M.applyDrop(s0, { type: 'item', id: 'rig:n-lin', group: null }, { kind: 'onto', index: 2 });
  assert.ok(view(s3).includes('[Rigs:rig:n-mac,rig:n-lin]'));
  assert.equal(M.groupNameFor({ kind: 'rig' }, { kind: 'applet' }), 'Group');
});

test('drop onto a group adds the item to it; drop in a popover reorders inside; drop on the dock takes it out', () => {
  const krea = A('n-mac', 'krea');
  const fuel = A('n-lin', 'fuel');
  let s = M.applyDrop(seeded(), { type: 'item', id: fuel, group: null }, { kind: 'onto', index: 0 });
  const gid = Object.keys(s.groups)[0];
  s = M.applyDrop(s, { type: 'item', id: 'rig:n-lin', group: null }, { kind: 'onto', index: 0 });
  assert.deepEqual(s.groups[gid].items, [krea, fuel, 'rig:n-lin']);
  s = M.applyDrop(s, { type: 'item', id: 'rig:n-lin', group: gid }, { kind: 'group', group: gid, index: 0 });
  assert.deepEqual(s.groups[gid].items, ['rig:n-lin', krea, fuel]);
  assert.equal(M.applyDrop(s, { type: 'item', id: krea, group: gid }, { kind: 'onto', index: 0 }), s, 'onto its own group: nothing to do');
  s = M.applyDrop(s, { type: 'item', id: krea, group: gid }, { kind: 'before', index: 2 });
  assert.deepEqual(view(s), [`[Applets:rig:n-lin,${fuel}]`, 'rig:n-mac', krea]);
});

test('reorder by dropping before a slot, for items and whole groups, skipping hidden items', () => {
  const krea = A('n-mac', 'krea');
  const fuel = A('n-lin', 'fuel');
  let s = seeded();
  s = M.applyDrop(s, { type: 'item', id: krea, group: null }, { kind: 'before', index: 4 });
  assert.deepEqual(view(s), [fuel, 'rig:n-mac', 'rig:n-lin', krea]);
  s = M.applyDrop(s, { type: 'item', id: krea, group: null }, { kind: 'before', index: 1 });
  assert.deepEqual(view(s), [fuel, krea, 'rig:n-mac', 'rig:n-lin']);
  s = S.setHidden(s, 'rig:n-mac', true);
  s = M.applyDrop(s, { type: 'item', id: fuel, group: null }, { kind: 'before', index: 2 }); // visible: fuel, krea, rig:n-lin
  assert.deepEqual(view(s), [krea, fuel, 'rig:n-lin']);
  s = S.createGroup(s, { name: 'Pair', items: [krea, fuel] });
  const gid = Object.keys(s.groups)[0];
  s = M.applyDrop(s, { type: 'group', id: gid, group: null }, { kind: 'before', index: 2 });
  assert.deepEqual(view(s), ['rig:n-lin', `[Pair:${krea},${fuel}]`]);
  assert.equal(M.applyDrop(s, null, { kind: 'before', index: 0 }), s);
});

test('dropAt + applyDrop on real slots: drag the first tile to the end', () => {
  const s = seeded();
  const krea = A('n-mac', 'krea');
  const drop = M.dropAt(slotsOf(s), 10_000, { type: 'item', id: krea });
  assert.equal(view(M.applyDrop(s, { type: 'item', id: krea, group: null }, drop)).at(-1), krea);
});

test('nudge moves left/right among visible entries and inside a group', () => {
  const krea = A('n-mac', 'krea');
  const fuel = A('n-lin', 'fuel');
  let s = M.nudge(seeded(), 'item', krea, 1);
  assert.deepEqual(view(s).slice(0, 2), [fuel, krea]);
  assert.equal(M.nudge(s, 'item', fuel, -1), s, 'the first one cannot go further left');
  s = S.createGroup(s, { name: 'G', items: [fuel, krea] });
  s = M.nudgeInGroup(s, krea, -1);
  assert.deepEqual(Object.values(s.groups)[0].items, [krea, fuel]);
  assert.equal(M.groupOf(s, krea).name, 'G');
  assert.equal(M.groupOf(s, 'rig:n-mac'), null);
});

test('menus: item pin/hide/group/move, group rename/ungroup, dock settings (position, auto-hide, magnification)', () => {
  let s = seeded();
  const act = (fn) => { s = fn(s); return s; };
  const krea = A('n-mac', 'krea');
  const find = (entries, label) => entries.find((e) => e.label?.startsWith(label));
  const opened = [];
  find(M.itemEntries(s, krea, act, { open: (it) => opened.push(it.id) }), 'Open').run();
  assert.deepEqual(opened, [krea]);
  find(M.itemEntries(s, krea, act), 'Keep in dock').run();
  assert.equal(s.items[krea].pinned, true);
  assert.equal(find(M.itemEntries(s, krea, act), 'Keep in dock').checked, true);
  find(M.itemEntries(s, krea, act), 'Move to group').submenu().find((e) => e.label === 'New group').run();
  const gid = Object.keys(s.groups)[0];
  assert.deepEqual(s.groups[gid].items, [krea]);
  find(M.itemEntries(s, krea, act), 'Take out of').run();
  assert.equal(M.groupOf(s, krea), null);
  find(M.itemEntries(s, A('n-lin', 'fuel'), act), 'Move to group').submenu().find((e) => e.label === 'Group').run();
  assert.deepEqual(s.groups[gid].items, [A('n-lin', 'fuel')]);
  find(M.itemEntries(s, krea, act), 'Hide from dock').run();
  assert.equal(s.items[krea].hidden, true);

  const renamed = [];
  find(M.groupEntries(s, gid, act, { rename: (id) => renamed.push(id), openGroup: () => {} }), 'Rename').run();
  assert.deepEqual(renamed, [gid]);
  s = M.rename(s, gid, '  Tools ');
  assert.equal(s.groups[gid].name, 'Tools');
  find(M.groupEntries(s, gid, act), 'Ungroup').run();
  assert.equal(s.groups[gid], undefined);

  find(M.settingsEntries(s, act), 'Position').submenu().find((e) => e.label === 'Left').run();
  assert.equal(s.settings.position, 'left');
  assert.equal(find(M.settingsEntries(s, act), 'Position').submenu().find((e) => e.checked).label, 'Left');
  find(M.settingsEntries(s, act), 'Automatically hide').run();
  assert.equal(s.settings.autoHide, true);
  find(M.settingsEntries(s, act), 'Magnification').run();
  assert.equal(s.settings.magnification, false);
  assert.equal(find(M.settingsEntries(s, act), 'Magnification size').disabled, true);
  act((x) => S.setSettings(x, { magnification: true }));
  find(M.settingsEntries(s, act), 'Magnification size').submenu().find((e) => e.label === 'Large').run();
  assert.equal(s.settings.magnifyStrength, 1);
  const hidden = find(M.settingsEntries(s, act), 'Hidden items');
  assert.equal(hidden.label, 'Hidden items (1)');
  hidden.submenu().find((e) => e.label === 'Show all').run();
  assert.equal(s.items[krea].hidden, false);
  assert.equal(find(M.settingsEntries(s, act, { phone: true }), 'Magnification').hint, 'off on phones');
  assert.equal(find(M.settingsEntries(s, act, { reducedMotion: true }), 'Magnification').hint, 'off: reduced motion');
  assert.ok(M.itemEntries(s, krea, act).some((e) => e.label === 'Move up'), 'a side dock moves up/down');
  assert.deepEqual(M.itemEntries(s, 'nope', act), []);
  // A pinned panel that was closed can be opened again (the tile, the popover and the menu agree); a closed window cannot.
  let p = S.setPinned(S.addItem(s, S.toItem('panel', { id: 'work', title: 'Work' })), 'panel:work', true);
  p = S.onClosed(p, { kind: 'panel', source: { id: 'work' } });
  p = S.setPinned(S.addItem(p, S.toItem('window', { id: '7', title: 'Notes' })), 'window:7', true);
  p = S.onClosed(p, { kind: 'window', source: { id: '7' } });
  const openOf = (id) => find(M.itemEntries(p, id, act, { open: () => {} }), 'Open');
  assert.equal(p.items['panel:work'].live, false);
  assert.deepEqual([openOf('panel:work').label, openOf('panel:work').disabled, M.canOpen(p.items['panel:work'])], ['Open', false, true]);
  assert.deepEqual([openOf('window:7').disabled, M.canOpen(p.items['window:7'])], [true, false]);
  assert.deepEqual(M.groupEntries(s, 'g404', act), []);
});

test('settings and groups survive a reload through the serializer (what the dock writes to localStorage)', () => {
  let s = seeded();
  s = S.setSettings(s, { position: 'right', autoHide: true, magnification: false, magnifyStrength: 0.3 });
  s = S.createGroup(s, { name: 'Rigs', items: ['rig:n-mac', 'rig:n-lin'] });
  const back = S.deserialize(S.serialize(s));
  assert.deepEqual(back.settings, s.settings);
  assert.deepEqual(view(back), view(s));
  assert.equal(M.STORAGE_KEY, 'rigs.appdock');
});

test('edge reserve: only the dock\'s edge, nothing while auto-hidden or on a phone', () => {
  const base = { ...S.DEFAULT_SETTINGS };
  assert.deepEqual(M.reserve(base), { left: 0, right: 0, bottom: M.ICON + 2 * M.PAD + M.EDGE });
  assert.deepEqual(M.reserve({ ...base, position: 'left' }, { size: 40 }), { left: 40 + 2 * M.PAD + M.EDGE, right: 0, bottom: 0 });
  assert.deepEqual(M.reserve({ ...base, autoHide: true }), { left: 0, right: 0, bottom: 0 });
  assert.deepEqual(M.reserve(base, { phone: true }), { left: 0, right: 0, bottom: 0 });
});

test('the dock is drawn only from the state module and calls back into main.js for every action', () => {
  const src = fs.readFileSync(new URL('../ui/src/app-dock.js', import.meta.url), 'utf8');
  assert.match(src, /from '\.\/app-dock-state\.js'/);
  assert.match(src, /dockView\(state\)/);
  assert.doesNotMatch(src, /\bapi\(|\bfetch\(/, 'no data fetching of its own');
  assert.doesNotMatch(src, /from '\.\/(apps|wm|panels|docking|layout-actions)\.js'/, 'no direct panel / window / app calls');
  assert.doesNotMatch(src, /onOpened|autoDock\b/, 'no auto-docking yet');
  const main = fs.readFileSync(new URL('../ui/src/main.js', import.meta.url), 'utf8');
  assert.match(main, /sourcesFromSnapshot\(snap, \{ isRemoved: isAppRemoved \}\)/);
  assert.match(main, /openApp\(a\)/);
});

test('dock CSS moves existing panels only while the dock reserves that edge', () => {
  const css = fs.readFileSync(new URL('../ui/src/styles.css', import.meta.url), 'utf8');
  const block = css.slice(css.indexOf('/* === APP DOCK ==='), css.indexOf('/* === END APP DOCK === */'));
  assert.ok(block.length > 1000);
  const existing = /#(bar|chat-dock|left|legend|orb-wrap|work|questions|usage|desktops|agents|toasts|activity|panels-btn|panels-menu|footer|traces|graphify|topbar)\b|\.win\.max/;
  const rules = block.replace(/\/\*[\s\S]*?\*\//g, '').match(/[^{}]+\{[^{}]*\}/g) || [];
  const touching = rules.map((r) => r.slice(0, r.indexOf('{')).trim()).filter((sel) => existing.test(sel));
  assert.ok(touching.length >= 5, 'the edge rules are there');
  for (const sel of touching) for (const one of sel.split(',')) assert.match(one.trim(), /^html\.adock-r[lrb] /, `"${one.trim()}" must be guarded by html.adock-r*`);
  assert.match(block, /:root\.adock-phone \{ --bar-bottom:/, 'phones lift the toolbar through --bar-bottom');
  assert.match(block, /prefers-reduced-motion: reduce/);
});
