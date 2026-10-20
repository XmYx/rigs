// Auto-docking wiring (ui/src/open-events.js): window / terminal / panel open and close events → dock state, with the
// default-off settings leaving everything exactly as it was. No browser, no DOM — the dock is a stand-in with the same
// `state` + `act(fn)` surface as createAppDock().
import assert from 'node:assert/strict';
import { test } from 'node:test';

const E = await import('../ui/src/open-events.js');
const S = await import('../ui/src/app-dock-state.js');

/** A dock stand-in: holds a state and applies act() the way app-dock.js does (no change → same state). */
function fakeDock(settings = {}, initial = S.emptyState()) {
  const dock = {
    state: S.setSettings(initial, settings),
    acts: 0,
    act(fn) { const next = fn(dock.state); if (next && next !== dock.state) { dock.state = next; dock.acts++; } return dock.state; },
  };
  return dock;
}
const wire = (settings, initial) => { const bus = E.createOpenBus(); const dock = fakeDock(settings, initial); E.bindDock(bus, dock); return { bus, dock }; };
const ids = (dock) => dock.state.order.map((e) => e.id);
const win = (id, title = `W${id}`) => ({ id: String(id), title, icon: '▣' });
const pty = (id) => ({ id, nodeId: 'mac', title: `mac — ${id}` });

test('the bus is synchronous and a throwing listener does not break the emitter or the others', () => {
  const bus = E.createOpenBus();
  const seen = [];
  bus.on(() => { throw new Error('boom'); });
  const off = bus.on((ev) => seen.push(ev.type));
  assert.doesNotThrow(() => E.emitOpened('window', win(1), {}, bus));
  E.emitClosed('window', win(1), bus);
  off();
  E.emitTitle('window', win(1), bus);
  assert.deepEqual(seen, ['opened', 'closed']);
});

test('terminal and app windows get no window item; other windows do', () => {
  assert.equal(E.dockableWindow('term-win'), false);
  assert.equal(E.dockableWindow('term-win term-tabs-win'), false);
  assert.equal(E.dockableWindow('app-win'), false);
  assert.equal(E.dockableWindow(''), true);
  assert.equal(E.dockableWindow('ctl-win'), true);
  assert.equal(E.dockableWindow('sess-win'), true);
  assert.equal(E.dockableWindow(undefined), true);
});

test('both settings OFF (default): window, panel and terminal events leave the dock state untouched', () => {
  const { bus, dock } = wire({});
  const before = dock.state;
  E.emitOpened('window', win(7), {}, bus);
  E.emitOpened('panel', { id: 'trace', title: 'Trace' }, {}, bus);
  E.emitOpened('terminal', pty('p1'), { auto: true }, bus);
  E.emitOpened('terminal', pty('p2'), { auto: false }, bus);
  E.emitTitle('window', win(7, 'Renamed'), bus);
  E.emitClosed('window', win(7), bus);
  E.emitClosed('terminal', pty('p1'), bus);
  assert.equal(dock.state, before, 'the very same state object: nothing was even rewritten');
  assert.equal(dock.acts, 0);
});

test('autoDock ON: a new window gets an item, its title follows, closing removes it', () => {
  const { bus, dock } = wire({ autoDock: true });
  E.emitOpened('window', win(7, 'Files'), {}, bus);
  assert.deepEqual(ids(dock), ['window:7']);
  assert.equal(dock.state.items['window:7'].title, 'Files');
  assert.equal(dock.state.items['window:7'].icon, '▣');
  E.emitTitle('window', win(7, 'Files — /tmp'), bus);
  assert.equal(dock.state.items['window:7'].title, 'Files — /tmp');
  E.emitOpened('window', win(7, 'Files'), {}, bus); // a repeat does not duplicate
  assert.deepEqual(ids(dock), ['window:7']);
  E.emitClosed('window', win(7), bus);
  assert.deepEqual(ids(dock), []);
  assert.deepEqual(dock.state.items, {});
});

test('autoDock ON: panels dock and undock the same way, in the order they open', () => {
  const { bus, dock } = wire({ autoDock: true });
  E.emitOpened('panel', { id: 'trace', title: 'Trace', icon: '▤' }, {}, bus);
  E.emitOpened('window', win(2), {}, bus);
  E.emitOpened('panel', { id: 'usage', title: 'Usage' }, {}, bus);
  assert.deepEqual(ids(dock), ['panel:trace', 'window:2', 'panel:usage']);
  E.emitClosed('panel', { id: 'trace' }, bus);
  assert.deepEqual(ids(dock), ['window:2', 'panel:usage']);
});

test('turning autoDock off stops new docking but closing still cleans up what was docked', () => {
  const { bus, dock } = wire({ autoDock: true });
  E.emitOpened('window', win(1), {}, bus);
  dock.act((s) => S.setSettings(s, { autoDock: false }));
  E.emitOpened('window', win(2), {}, bus);
  assert.deepEqual(ids(dock), ['window:1']);
  E.emitClosed('window', win(1), bus);
  assert.deepEqual(ids(dock), []);
});

test('a pinned item stays when its window closes (dimmed) and comes back live when it reopens — even with autoDock off', () => {
  const { bus, dock } = wire({ autoDock: true });
  E.emitOpened('panel', { id: 'trace', title: 'Trace' }, {}, bus);
  dock.act((s) => S.setPinned(s, 'panel:trace'));
  E.emitClosed('panel', { id: 'trace' }, bus);
  assert.equal(dock.state.items['panel:trace'].live, false);
  dock.act((s) => S.setSettings(s, { autoDock: false }));
  E.emitOpened('panel', { id: 'trace', title: 'Trace' }, {}, bus);
  assert.equal(dock.state.items['panel:trace'].live, true);
  assert.equal(dock.state.items['panel:trace'].pinned, true);
});

test('autoTabTerminals ON: several auto-opened terminals end up in one Terminals group', () => {
  const { bus, dock } = wire({ autoTabTerminals: true });
  for (const id of ['p1', 'p2', 'p3']) E.emitOpened('terminal', pty(id), { auto: true }, bus);
  assert.deepEqual(Object.keys(dock.state.groups), [S.TERMINAL_GROUP]);
  assert.deepEqual(dock.state.groups[S.TERMINAL_GROUP].items, ['terminal:p1', 'terminal:p2', 'terminal:p3']);
  assert.equal(dock.state.groups[S.TERMINAL_GROUP].name, 'Terminals');
  assert.deepEqual(ids(dock), [S.TERMINAL_GROUP]);
  E.emitClosed('terminal', pty('p2'), bus);
  assert.deepEqual(dock.state.groups[S.TERMINAL_GROUP].items, ['terminal:p1', 'terminal:p3']);
});

test('a terminal the user opens by hand keeps today\'s behaviour: never tabbed; docked loose only with autoDock', () => {
  const tabOnly = wire({ autoTabTerminals: true });
  const before = tabOnly.dock.state;
  E.emitOpened('terminal', pty('h1'), { auto: false }, tabOnly.bus);
  assert.equal(tabOnly.dock.state, before, 'autoTabTerminals alone ignores it');
  const both = wire({ autoDock: true, autoTabTerminals: true });
  E.emitOpened('terminal', pty('h1'), { auto: false }, both.bus);
  E.emitOpened('terminal', pty('a1'), { auto: true }, both.bus);
  assert.deepEqual(ids(both.dock), ['terminal:h1', S.TERMINAL_GROUP]);
  assert.deepEqual(both.dock.state.groups[S.TERMINAL_GROUP].items, ['terminal:a1']);
});

test('autoDock ON, autoTabTerminals OFF: auto-opened terminals are docked loose, not grouped', () => {
  const { bus, dock } = wire({ autoDock: true });
  E.emitOpened('terminal', pty('a1'), { auto: true }, bus);
  E.emitOpened('terminal', pty('a2'), { auto: true }, bus);
  assert.deepEqual(dock.state.groups, {});
  assert.deepEqual(ids(dock), ['terminal:a1', 'terminal:a2']);
});

test('user customisation survives: a terminal dragged out of the group is not pulled back when announced again', () => {
  const { bus, dock } = wire({ autoTabTerminals: true });
  E.emitOpened('terminal', pty('a1'), { auto: true }, bus);
  dock.act((s) => S.moveItem(s, 'terminal:a1', { group: null }));
  E.emitOpened('terminal', pty('a1'), { auto: true }, bus); // the same session announced again
  assert.deepEqual(dock.state.groups[S.TERMINAL_GROUP].items, [], 'stays out');
  assert.deepEqual(ids(dock).sort(), [S.TERMINAL_GROUP, 'terminal:a1'].sort());
});

test('malformed events are ignored', () => {
  const { bus, dock } = wire({ autoDock: true });
  const before = dock.state;
  bus.emit(null);
  bus.emit({ type: 'opened', kind: 'nope', source: { id: 1 } });
  bus.emit({ type: 'opened', kind: 'window', source: {} });
  bus.emit({ type: 'wat', kind: 'window', source: win(1) });
  assert.equal(dock.state, before);
});

test('settings reach the dock through persistence: both default to off, and on survives serialize → deserialize', () => {
  assert.equal(S.deserialize(null).settings.autoDock, false);
  assert.equal(S.deserialize(null).settings.autoTabTerminals, false);
  const on = S.setSettings(S.emptyState(), { autoDock: true, autoTabTerminals: true });
  const back = S.deserialize(S.serialize(on));
  assert.equal(back.settings.autoDock, true);
  assert.equal(back.settings.autoTabTerminals, true);
});

// ------------------------------------------------------------------ panels

function fakePanels(initial) {
  const panels = new Map(initial.map((p) => [p.id, { title: p.id, closed: false, removed: false, ...p }]));
  const subs = new Set();
  return {
    list: () => [...panels.values()],
    subscribe: (fn) => { subs.add(fn); return () => subs.delete(fn); },
    set(id, patch) { panels.set(id, { ...panels.get(id), ...patch }); for (const fn of subs) fn(); },
    add(p) { panels.set(p.id, { title: p.id, closed: false, removed: false, ...p }); for (const fn of subs) fn(); },
    subs,
  };
}
const record = (bus) => { const log = []; bus.on((ev) => log.push(`${ev.type}:${ev.kind}:${ev.source.id}`)); return log; };

test('trackPanels: what is on screen at start is the baseline, not an open', () => {
  const bus = E.createOpenBus();
  const log = record(bus);
  const p = fakePanels([{ id: 'left' }, { id: 'trace', closed: true }]);
  E.trackPanels({ ...p, bus });
  assert.deepEqual(log, []);
});

test('trackPanels: showing a hidden panel is an open, hiding a shown one a close; collapse-only churn is silent', () => {
  const bus = E.createOpenBus();
  const log = record(bus);
  const p = fakePanels([{ id: 'left' }, { id: 'trace', closed: true }]);
  E.trackPanels({ ...p, bus });
  p.set('trace', { closed: false });
  p.set('left', { collapsed: true }); // layout change that is not hide / show
  p.set('left', { closed: true });
  p.set('trace', { closed: true });
  assert.deepEqual(log, ['opened:panel:trace', 'closed:panel:left', 'closed:panel:trace']);
});

test('trackPanels: a removed panel counts as closed, a restored one as opened; a panel registered later is baselined', () => {
  const bus = E.createOpenBus();
  const log = record(bus);
  const p = fakePanels([{ id: 'usage' }]);
  E.trackPanels({ ...p, bus });
  p.set('usage', { removed: true });
  p.set('usage', { removed: false });
  p.add({ id: 'late' }); // shows up visible after boot — not an "open"
  p.set('late', { closed: true });
  assert.deepEqual(log, ['closed:panel:usage', 'opened:panel:usage', 'closed:panel:late']);
});

test('trackPanels → bindDock end to end: autoDock off docks nothing, on docks the panel and closing removes it; stop() unsubscribes', () => {
  const bus = E.createOpenBus();
  const dock = fakeDock({});
  E.bindDock(bus, dock);
  const p = fakePanels([{ id: 'trace', title: 'Trace', closed: true }]);
  const tr = E.trackPanels({ ...p, bus });
  p.set('trace', { closed: false });
  assert.equal(dock.acts, 0, 'off: nothing docked');
  p.set('trace', { closed: true });
  dock.act((s) => S.setSettings(s, { autoDock: true }));
  p.set('trace', { closed: false });
  assert.deepEqual(ids(dock), ['panel:trace']);
  assert.equal(dock.state.items['panel:trace'].title, 'Trace');
  p.set('trace', { closed: true });
  assert.deepEqual(ids(dock), []);
  tr.stop();
  assert.equal(p.subs.size, 0);
});

// ------------------------------------------------------------------ reload + cleanup

test('the Terminals group disappears once its last terminal closes; a group with tabs left stays', () => {
  const { bus, dock } = wire({ autoTabTerminals: true });
  E.emitOpened('terminal', pty('a1'), { auto: true }, bus);
  E.emitOpened('terminal', pty('a2'), { auto: true }, bus);
  E.emitClosed('terminal', pty('a1'), bus);
  assert.deepEqual(Object.keys(dock.state.groups), [S.TERMINAL_GROUP]);
  E.emitClosed('terminal', pty('a2'), bus);
  assert.deepEqual(dock.state.groups, {});
  assert.deepEqual(ids(dock), []);
});

test('reconcileOnLoad: stale window/terminal items (even pinned) and the empty Terminals group go; shown panels stay', () => {
  let s = S.setSettings(S.emptyState(), { autoDock: true, autoTabTerminals: true });
  s = S.onOpened(s, { kind: 'window', source: win(3) });
  s = S.onOpened(s, { kind: 'terminal', source: pty('a1'), auto: true });
  s = S.onOpened(s, { kind: 'panel', source: { id: 'traces', title: 'Request traces' } });
  s = S.onOpened(s, { kind: 'panel', source: { id: 'agents', title: 'Active agents' } });
  s = S.setPinned(s, 'window:3');
  const next = E.reconcileOnLoad(s, [{ id: 'traces', title: 'Request traces', closed: false }, { id: 'agents', title: 'Active agents', closed: true }]);
  assert.deepEqual(Object.keys(next.items), ['panel:traces']);
  assert.deepEqual(next.groups, {});
  assert.deepEqual(next.order, [{ type: 'item', id: 'panel:traces' }]);
  assert.equal(next.settings.autoDock, true, 'settings are untouched');
  assert.equal(E.reconcileOnLoad(S.emptyState(), [{ id: 'x', closed: false }]).order.length, 0, 'panels that are merely open are not docked by a reload');
});

test('reconcileOnLoad keeps a pinned panel that is closed, dimmed', () => {
  let s = S.setSettings(S.emptyState(), { autoDock: true });
  s = S.setPinned(S.onOpened(s, { kind: 'panel', source: { id: 'traces', title: 'T' } }), 'panel:traces');
  const next = E.reconcileOnLoad(s, [{ id: 'traces', closed: true }]);
  assert.equal(next.items['panel:traces'].live, false);
});
