// Application dock state (ui/src/app-dock-state.js): groups, pin/hide, settings, merging live sources, magnification,
// persistence with migration and corrupt input, and the default-off auto-dock / auto-tab decisions. No browser, no DOM.
import assert from 'node:assert/strict';
import { test } from 'node:test';

const S = await import('../ui/src/app-dock-state.js');

const applet = (id, node = 'mac', extra = {}) => ({ node, id, name: id.toUpperCase(), icon: '▣', ...extra });
const rig = (id, online = true, rigs = true) => ({ id, name: `node ${id}`, online, rigs });
const A = (id, node = 'mac') => S.itemId('applet', `${node}/${id}`);

const deepFreeze = (o) => { if (o && typeof o === 'object' && !Object.isFrozen(o)) { Object.freeze(o); Object.values(o).forEach(deepFreeze); } return o; };

/** Throws unless every item is placed exactly once and nothing dangles. */
function check(s) {
  const seen = [];
  for (const e of s.order) {
    if (e.type === 'item') { assert.ok(s.items[e.id], `order names unknown item ${e.id}`); seen.push(e.id); }
    else { assert.equal(e.type, 'group'); assert.ok(s.groups[e.id], `order names unknown group ${e.id}`); }
  }
  for (const g of Object.values(s.groups)) for (const id of g.items) { assert.ok(s.items[id], `group ${g.id} names unknown item ${id}`); seen.push(id); }
  assert.deepEqual([...seen].sort(), Object.keys(s.items).sort(), 'every item is placed exactly once');
  assert.equal(new Set(s.order.map((e) => `${e.type}:${e.id}`)).size, s.order.length, 'no duplicate top-level entries');
  assert.deepEqual(Object.keys(s.groups).sort(), s.order.filter((e) => e.type === 'group').map((e) => e.id).sort(), 'every group is at the top level');
  return s;
}

// Layout mechanics are tested on a flat dock (autoGroup off); the default groups have their own tests below.
const flat = () => S.setSettings(S.emptyState(), { autoGroup: false });
const seeded = () => S.mergeSources(flat(), { applets: [applet('krea'), applet('files'), applet('notes')], rigs: [rig('mac'), rig('linux')] });
const topIds = (s) => s.order.map((e) => e.id);

test('defaults: bottom, no auto-hide, magnification on, auto-dock and auto-tab OFF', () => {
  const s = S.emptyState();
  assert.equal(s.settings.position, 'bottom');
  assert.equal(s.settings.autoHide, false);
  assert.equal(s.settings.magnification, true);
  assert.equal(s.settings.autoDock, false);
  assert.equal(s.settings.autoTabTerminals, false);
  assert.deepEqual(S.deserialize(null).settings, s.settings);
  assert.equal(S.DEFAULT_SETTINGS.autoDock, false);
  assert.equal(S.DEFAULT_SETTINGS.autoTabTerminals, false);
});

test('operations never mutate their input (deep-frozen states)', () => {
  let s = deepFreeze(seeded());
  s = deepFreeze(S.createGroup(s, { name: 'Work', items: [A('krea'), A('files')] }));
  const g = Object.keys(s.groups)[0];
  for (const f of [
    (x) => S.renameGroup(x, g, 'Tools'), (x) => S.ungroup(x, g), (x) => S.setCollapsed(x, g, true),
    (x) => S.moveItem(x, A('notes'), { group: g, index: 0 }), (x) => S.reorder(x, 'group', g, 2),
    (x) => S.setPinned(x, A('krea')), (x) => S.setHidden(x, A('krea')), (x) => S.removeItem(x, A('notes')),
    (x) => S.setPosition(x, 'left'), (x) => S.setAutoHide(x, true), (x) => S.setSettings(x, { magnifyStrength: 1 }),
    (x) => S.mergeSources(x, { applets: [], rigs: [] }), (x) => S.addItem(x, S.toItem('panel', { id: 'chat', title: 'Chat' })),
    (x) => S.onOpened(S.setSettings(x, { autoDock: true, autoTabTerminals: true }), { kind: 'terminal', source: { id: 'p1' } }),
  ]) assert.doesNotThrow(() => check(f(s))); // a frozen input would throw (strict mode) on any mutation
});

test('groups: create takes the first member\'s slot, rename, collapse, ungroup restores the items in place', () => {
  let s = seeded(); // order: krea files notes mac linux
  s = check(S.createGroup(s, { name: 'Work', items: [A('files'), A('notes')] }));
  assert.deepEqual(s.order.map((e) => e.type), ['item', 'group', 'item', 'item']);
  const g = s.order[1].id;
  assert.deepEqual(s.groups[g].items, [A('files'), A('notes')]);
  s = S.renameGroup(s, g, '  Tools ');
  assert.equal(s.groups[g].name, 'Tools');
  assert.equal(S.renameGroup(s, g, '   '), s, 'blank rename is ignored');
  s = S.setCollapsed(s, g, true);
  assert.equal(s.groups[g].collapsed, true);
  s = check(S.ungroup(s, g));
  assert.deepEqual(topIds(s), [A('krea'), A('files'), A('notes'), S.itemId('rig', 'mac'), S.itemId('rig', 'linux')]);
  assert.deepEqual(s.groups, {});
  assert.equal(S.ungroup(s, 'g9'), s, 'unknown group is a no-op');
});

test('groups: ids come from a counter and never collide; unknown members are skipped', () => {
  let s = seeded();
  s = S.createGroup(s, { items: [A('krea'), 'applet:ghost'] });
  s = S.createGroup(s, { items: [A('files')] });
  s = S.createGroup(s, { id: 'g1', items: [] }); // taken → another id
  assert.equal(Object.keys(s.groups).length, 3);
  assert.deepEqual(s.groups.g1.items, [A('krea')]);
  check(s);
});

test('move into / out of a group, with an index, and a moved item leaves its old group', () => {
  let s = seeded();
  s = S.createGroup(s, { id: 'g1', name: 'A', items: [A('krea')] });
  s = S.createGroup(s, { id: 'g2', name: 'B', items: [] });
  s = S.moveItem(s, A('files'), { group: 'g1', index: 0 });
  assert.deepEqual(s.groups.g1.items, [A('files'), A('krea')]);
  s = S.moveItem(s, A('files'), { group: 'g2' });
  assert.deepEqual(s.groups.g1.items, [A('krea')]);
  assert.deepEqual(s.groups.g2.items, [A('files')]);
  s = check(S.moveItem(s, A('krea'), { group: null, index: 0 }));
  assert.equal(s.order[0].id, A('krea'));
  assert.equal(S.moveItem(s, A('krea'), { group: 'nope' }), s);
  assert.equal(S.moveItem(s, 'applet:ghost', { group: 'g1' }), s);
});

test('reorder: items and whole groups move among the top-level entries; indexes clamp', () => {
  let s = S.createGroup(seeded(), { id: 'g1', items: [A('notes')] }); // krea files g1 mac linux
  s = check(S.reorder(s, 'group', 'g1', 0));
  assert.deepEqual(topIds(s).slice(0, 3), ['g1', A('krea'), A('files')]);
  s = S.reorder(s, 'item', A('krea'), 99);
  assert.equal(topIds(s).at(-1), A('krea'));
  assert.equal(S.reorder(s, 'item', A('krea'), -5).order[0].id, A('krea'));
  assert.equal(S.reorder(s, 'item', A('krea'), topIds(s).length - 1), s, 'same slot is a no-op');
  assert.equal(S.reorder(s, 'item', A('notes'), 0), s, 'a grouped item is not a top-level entry');
});

test('pin and hide: flags toggle, hidden items leave the view but stay in the state', () => {
  let s = seeded();
  s = S.setPinned(s, A('krea'));
  assert.equal(s.items[A('krea')].pinned, true);
  assert.equal(S.setPinned(s, A('krea')), s, 'already pinned');
  s = S.setHidden(s, A('files'));
  assert.ok(s.items[A('files')]);
  const names = S.dockView(s).map((e) => e.item?.id);
  assert.ok(!names.includes(A('files')) && names.includes(A('krea')));
  s = S.createGroup(s, { id: 'g1', items: [A('files'), A('notes')] });
  const grp = S.dockView(s).find((e) => e.type === 'group');
  assert.deepEqual(grp.items.map((i) => i.id), [A('notes')], 'hidden member is not rendered');
  s = S.setHidden(s, A('files'), false);
  assert.equal(S.dockView(s).find((e) => e.type === 'group').items.length, 2);
  assert.equal(S.setPinned(s, 'applet:ghost'), s);
});

test('settings: position (left/right/bottom only), autoHide, magnification, strength clamped, bad values ignored', () => {
  let s = S.emptyState();
  for (const p of ['left', 'right', 'bottom']) assert.equal(S.setPosition(s, p).settings.position, p);
  assert.equal(S.setPosition(s, 'top'), s);
  assert.equal(S.setPosition(s, 7), s);
  assert.equal(S.setAutoHide(s, true).settings.autoHide, true);
  s = S.setSettings(s, { magnifyStrength: 5, magnification: false });
  assert.equal(s.settings.magnifyStrength, 1);
  assert.equal(s.settings.magnification, false);
  assert.equal(S.setSettings(s, { magnifyStrength: -2 }).settings.magnifyStrength, 0);
  const same = S.setSettings(s, { magnifyStrength: 'big', autoHide: 'yes', position: null, bogus: 1 });
  assert.equal(same, s, 'invalid fields change nothing');
  assert.equal('bogus' in S.setSettings(s, { bogus: 1, autoHide: true }).settings, false);
});

test('merge: new applets and online rigs are appended; offline or agent-less rigs are not docked', () => {
  const s = S.mergeSources(flat(), { applets: [applet('krea')], rigs: [rig('a'), rig('b', false), rig('c', true, false)] });
  assert.deepEqual(topIds(s), [A('krea'), 'rig:a']);
  check(s);
});

test('merge keeps the custom layout: order, groups, pin, hide survive a refresh with new and removed sources', () => {
  let s = seeded();
  s = S.createGroup(s, { id: 'g1', name: 'Work', items: [A('files'), A('notes')] });
  s = S.reorder(s, 'group', 'g1', 0);
  s = S.setPinned(s, A('krea'));
  s = S.setHidden(s, S.itemId('rig', 'linux'));
  const before = JSON.stringify(s);
  const same = S.mergeSources(s, { applets: [applet('krea'), applet('files'), applet('notes')], rigs: [rig('mac'), rig('linux')] });
  assert.equal(JSON.stringify(same), before, 'an identical refresh changes nothing');
  const next = check(S.mergeSources(s, { applets: [applet('krea', 'mac', { name: 'Krea 2' }), applet('files'), applet('fresh')], rigs: [rig('mac')] }));
  assert.equal(topIds(next)[0], 'g1', 'group stays first');
  assert.deepEqual(next.groups.g1.items, [A('files')], 'the vanished applet leaves its group');
  assert.equal(next.items[A('krea')].title, 'Krea 2', 'title refreshes');
  assert.equal(next.items[A('krea')].pinned, true);
  assert.equal(topIds(next).at(-1), A('fresh'), 'new applet goes to the end');
  assert.ok(!next.items[A('notes')] && !next.items['rig:linux']);
});

test('merge: a pinned item whose source vanished stays, marked not live, and comes back live', () => {
  let s = S.setPinned(seeded(), A('krea'));
  s = S.mergeSources(s, { applets: [applet('files')] });
  assert.equal(s.items[A('krea')].live, false);
  assert.ok(topIds(s).includes(A('krea')));
  s = S.mergeSources(s, { applets: [applet('files'), applet('krea')] });
  assert.equal(s.items[A('krea')].live, true);
});

test('merge: a source that was not polled leaves its items alone; panels/windows/terminals are never added by a merge', () => {
  let s = seeded();
  s = S.mergeSources(s, { panels: [{ id: 'chat', title: 'Chat' }], windows: [{ id: 4, title: 'W' }], terminals: [{ id: 'p1' }] });
  assert.equal(Object.keys(s.items).length, 5);
  s = S.addItem(s, S.toItem('panel', { id: 'chat', title: 'Chat' }));
  s = S.mergeSources(s, { applets: [] }); // only applets polled → the panel stays
  assert.ok(s.items['panel:chat']);
  s = S.mergeSources(s, { panels: [{ id: 'chat', title: 'Chat (2)' }] });
  assert.equal(s.items['panel:chat'].title, 'Chat (2)');
  s = S.mergeSources(s, { panels: [] });
  assert.ok(!s.items['panel:chat'], 'closed panel leaves the dock');
  assert.equal(S.mergeSources(s, null), s);
});

test('magnification curve: peak at the cursor, symmetric, monotone, 1 at and beyond the radius', () => {
  const cfg = { magnification: true, magnifyStrength: 0.8 };
  assert.ok(Math.abs(S.magnifyScale(0, cfg) - 1.8) < 1e-9);
  assert.equal(S.magnifyScale(120, cfg), 1);
  assert.equal(S.magnifyScale(500, cfg), 1);
  assert.equal(S.magnifyScale(-37, cfg), S.magnifyScale(37, cfg));
  let prev = Infinity;
  for (let d = 0; d <= 120; d += 10) { const v = S.magnifyScale(d, cfg); assert.ok(v <= prev + 1e-12 && v >= 1); prev = v; }
  assert.equal(S.magnifyScale(0, { magnification: false, magnifyStrength: 1 }), 1, 'off → 1');
  assert.equal(S.magnifyScale(0, { magnification: true, magnifyStrength: 0 }), 1, 'strength 0 → 1');
  assert.equal(S.magnifyScale(NaN, cfg), 1);
  assert.ok(S.magnifyScale(0, { magnification: true, magnifyStrength: 9 }) <= 2, 'strength is clamped');
  assert.ok(Math.abs(S.magnifyScale(0, cfg, 60) - 1.8) < 1e-9 && S.magnifyScale(60, cfg, 60) === 1, 'custom radius');
});

test('magnifyScales: one scale per icon centre; cursor away → all 1', () => {
  const centres = [20, 70, 120, 170, 400];
  const sc = S.magnifyScales(centres, 120, { magnification: true, magnifyStrength: 1 });
  assert.equal(sc.length, 5);
  assert.equal(Math.max(...sc), sc[2]);
  assert.equal(sc[4], 1);
  assert.ok(Math.abs(sc[1] - sc[3]) < 1e-9);
  assert.deepEqual(S.magnifyScales(centres, null), [1, 1, 1, 1, 1]);
  assert.deepEqual(S.magnifyScales(centres, 120, { magnification: false }), [1, 1, 1, 1, 1]);
});

test('serialize → deserialize round-trips the whole state', () => {
  let s = seeded();
  s = S.createGroup(s, { name: 'Work', items: [A('files')] });
  s = S.setPinned(s, A('krea'));
  s = S.setHidden(s, A('notes'));
  s = S.setPosition(S.setSettings(s, { autoDock: true, magnifyStrength: 0.25 }), 'right');
  const text = S.serialize(s);
  assert.equal(typeof text, 'string');
  assert.deepEqual(S.deserialize(text), s);
  assert.deepEqual(S.deserialize(JSON.parse(text)), s, 'also accepts a parsed object');
  assert.equal(JSON.parse(text).v, S.VERSION);
});

test('deserialize: corrupt or hostile input gives safe defaults, never throws', () => {
  const empty = S.emptyState();
  for (const bad of [null, undefined, '', 'not json', '{', '[]', '42', 'null', 7, [], true, '"str"']) assert.deepEqual(S.deserialize(bad), empty, String(bad));
  const messy = S.deserialize(JSON.stringify({
    v: 1, nextGroup: 'x',
    settings: { position: 'top', autoHide: 'yes', magnifyStrength: 77, autoDock: 1, autoTabTerminals: 'true', magnification: null },
    items: { 'applet:a': { title: 5, pinned: 'y', ref: { ok: 1, nested: { no: 1 }, fn: null } }, 'bogus:b': {}, 'panel:p': 'str', __proto__x: {} },
    groups: { g1: { name: 9, items: ['applet:a', 'applet:a', 'applet:zzz', 3] }, '!bad': {}, g2: [] },
    order: [{ type: 'item', id: 'applet:a' }, { type: 'group', id: 'g1' }, { type: 'group', id: 'g1' }, { type: 'group', id: 'nope' }, null, 5, { type: 'item', id: 'ghost' }],
  }));
  check(messy);
  assert.equal(messy.settings.position, 'bottom');
  assert.equal(messy.settings.autoDock, false, 'non-boolean autoDock falls back to off');
  assert.equal(messy.settings.autoTabTerminals, false);
  assert.equal(messy.settings.magnifyStrength, 1);
  assert.deepEqual(Object.keys(messy.items), ['applet:a']);
  assert.deepEqual(messy.items['applet:a'].ref, { ok: 1, fn: null });
  assert.deepEqual(messy.groups.g1.items, ['applet:a']);
  assert.equal(messy.groups.g1.name, 'Group');
  assert.deepEqual(messy.order, [{ type: 'group', id: 'g1' }], 'the item sits in the group, so only the group is top level');
  assert.ok(messy.nextGroup >= 2);
});

test('deserialize: a polluted __proto__ key in stored JSON does not leak onto the state', () => {
  const s = S.deserialize('{"v":1,"items":{"__proto__":{"polluted":1}},"groups":{"__proto__":{}},"settings":{"__proto__":{"autoDock":true}}}');
  assert.equal(({}).polluted, undefined);
  assert.equal(s.settings.autoDock, false);
  assert.deepEqual(s.items, {});
  assert.deepEqual(s.groups, {});
});

test('deserialize migrates the unversioned v0 shape (flat settings, group list) through v1 to the current version', () => {
  const v0 = {
    position: 'left', autoHide: true,
    items: [{ id: 'applet:mac/krea', title: 'Krea' }, { id: 'applet:mac/files', title: 'Files', pinned: true }, { id: 'rig:mac' }],
    groups: [{ id: 'g1', name: 'Work', items: ['applet:mac/files'] }],
  };
  const s = check(S.deserialize(JSON.stringify(v0)));
  assert.equal(s.v, S.VERSION);
  assert.equal(s.settings.position, 'left');
  assert.equal(s.settings.autoHide, true);
  assert.equal(s.settings.autoDock, false);
  assert.deepEqual(s.groups.g1.items, ['applet:mac/files']);
  assert.equal(s.items['applet:mac/files'].pinned, true);
  assert.deepEqual(s.order, [{ type: 'item', id: 'applet:mac/krea' }, { type: 'item', id: 'rig:mac' }, { type: 'group', id: 'g1' }]);
  assert.equal(S.deserialize({ v: 99, settings: { position: 'right' } }).settings.position, 'right', 'a newer version is read as far as it matches');
});

const term = (id = 'p1') => ({ kind: 'terminal', source: { id, nodeId: 'mac', title: 'zsh' } });
const panelEvt = { kind: 'panel', source: { id: 'chat', title: 'Chat' } };
const winEvt = { kind: 'window', source: { id: 3, title: 'Files', icon: '🗂' } };

test('auto-dock / auto-tab OFF (the default): opened events change nothing at all', () => {
  const s = seeded();
  for (const ev of [term(), panelEvt, winEvt, { kind: 'applet', source: applet('new') }]) assert.equal(S.onOpened(s, ev), s);
  assert.equal(S.onOpened(S.emptyState(), term()).order.length, 0);
});

test('autoDock ON: panels, windows and terminals are docked once, at the end; re-opening does not duplicate', () => {
  let s = S.setSettings(seeded(), { autoDock: true });
  const n = s.order.length;
  s = check(S.onOpened(s, panelEvt));
  s = check(S.onOpened(s, winEvt));
  s = check(S.onOpened(s, term()));
  assert.equal(s.order.length, n + 3);
  assert.deepEqual(topIds(s).slice(-3), ['panel:chat', 'window:3', 'terminal:p1']);
  assert.equal(s.items['window:3'].icon, '🗂');
  assert.equal(S.onOpened(s, panelEvt).order.length, s.order.length);
  assert.deepEqual(Object.keys(S.onOpened(s, { kind: 'wat', source: { id: 1 } }).items), Object.keys(s.items), 'unknown kind ignored');
  assert.equal(S.onOpened(s, { kind: 'panel', source: {} }), s, 'record without id ignored');
});

test('autoTabTerminals ON: terminals are tabbed into one Terminals group, created on demand and reused', () => {
  let s = S.setSettings(S.emptyState(), { autoDock: true, autoTabTerminals: true });
  s = check(S.onOpened(s, term('p1')));
  s = check(S.onOpened(s, term('p2')));
  s = check(S.onOpened(s, term('p3')));
  assert.equal(Object.keys(s.groups).length, 1);
  assert.equal(s.groups[S.TERMINAL_GROUP].name, 'Terminals');
  assert.deepEqual(s.groups[S.TERMINAL_GROUP].items, ['terminal:p1', 'terminal:p2', 'terminal:p3']);
  assert.deepEqual(s.order, [{ type: 'group', id: S.TERMINAL_GROUP }]);
  s = check(S.onOpened(s, term('p2')));
  assert.equal(s.groups[S.TERMINAL_GROUP].items.length, 3, 're-open is idempotent');
  const w = check(S.onOpened(s, panelEvt));
  assert.ok(w.order.some((e) => e.id === 'panel:chat') && !w.groups[S.TERMINAL_GROUP].items.includes('panel:chat'), 'non-terminals are not tabbed');
});

test('autoTabTerminals on, autoDock off: only terminals are docked, only into the group; autoDock on, tabbing off: terminals stay loose', () => {
  const tabOnly = S.setSettings(S.emptyState(), { autoTabTerminals: true });
  assert.equal(S.onOpened(tabOnly, panelEvt), tabOnly);
  const t = check(S.onOpened(tabOnly, term()));
  assert.deepEqual(t.groups[S.TERMINAL_GROUP].items, ['terminal:p1']);
  const dockOnly = check(S.onOpened(S.setSettings(S.emptyState(), { autoDock: true }), term()));
  assert.deepEqual(dockOnly.groups, {});
  assert.deepEqual(topIds(dockOnly), ['terminal:p1']);
});

test('auto-tab respects the user: an existing terminal item is moved into the group; a user-made Terminals group is reused', () => {
  let s = S.addItem(S.emptyState(), S.toItem('terminal', { id: 'p1', title: 'old' }));
  s = S.createGroup(s, { id: S.TERMINAL_GROUP, name: 'My shells' });
  s = S.setSettings(s, { autoTabTerminals: true });
  s = check(S.onOpened(s, term('p1')));
  assert.equal(s.groups[S.TERMINAL_GROUP].name, 'My shells');
  assert.deepEqual(s.groups[S.TERMINAL_GROUP].items, ['terminal:p1']);
});

test('onClosed: an auto-docked item leaves unless pinned (then it stays, not live)', () => {
  let s = S.setSettings(S.emptyState(), { autoDock: true, autoTabTerminals: true });
  s = S.onOpened(S.onOpened(s, term('p1')), term('p2'));
  s = S.setPinned(s, 'terminal:p2');
  s = check(S.onClosed(s, term('p1')));
  assert.deepEqual(s.groups[S.TERMINAL_GROUP].items, ['terminal:p2']);
  s = check(S.onClosed(s, term('p2')));
  assert.equal(s.items['terminal:p2'].live, false);
  assert.equal(S.onClosed(s, term('zzz')), s);
});

test('a terminal opened by hand (auto: false) is never tabbed; autoDock still docks it loose', () => {
  const hand = { ...term('h1'), auto: false };
  const tabOnly = S.setSettings(S.emptyState(), { autoTabTerminals: true });
  assert.equal(S.onOpened(tabOnly, hand), tabOnly, 'autoTabTerminals alone ignores a hand-opened terminal');
  const both = S.setSettings(S.emptyState(), { autoDock: true, autoTabTerminals: true });
  const s = check(S.onOpened(both, hand));
  assert.deepEqual(s.groups, {});
  assert.deepEqual(topIds(s), ['terminal:h1']);
  const auto = check(S.onOpened(s, { ...term('a1'), auto: true }));
  assert.deepEqual(auto.groups[S.TERMINAL_GROUP].items, ['terminal:a1'], 'an auto-opened one still tabs');
});
