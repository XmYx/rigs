// Window state model (ui/src/window-state.js) and its persistence in the dock layout store (ui/src/dock-layout.js,
// localStorage 'rigs.dock' version 2 `windows`), including the migration of version 1 and legacy 'rigs.panels' layouts.
// Pure: no DOM, the store is a Map-backed stand-in for localStorage.
import assert from 'node:assert/strict';
import { test } from 'node:test';

const W = await import('../ui/src/window-state.js');
const D = await import('../ui/src/dock-layout.js');

const R = { x: 120, y: 80, w: 760, h: 480 };
const steps = (rec, ...actions) => actions.reduce((r, a) => W.transition(r, a), rec);

test('a new window is normal at its rect; open on an open window changes nothing', () => {
  const r = W.transition(null, 'open', { rect: R, at: 5 });
  assert.deepEqual(r, { state: 'normal', rect: R, before: 'normal', at: 5 });
  assert.equal(W.transition(r, 'open'), r, 'same object back when nothing changes');
});

test('maximize keeps the rect; restore brings back the exact previous rect', () => {
  const r0 = W.initialRecord(R);
  const max = W.transition(r0, 'maximize', { at: 1 });
  assert.equal(max.state, 'maximized');
  assert.deepEqual(max.rect, R, 'the restore rect is kept while maximized');
  assert.equal(W.transition(max, 'move', { rect: { x: 8, y: 8, w: 1400, h: 860 } }), max, 'a maximized window never takes the stage rect as its own');
  const back = W.transition(max, 'restore');
  assert.equal(back.state, 'normal');
  assert.deepEqual(back.rect, R);
  assert.deepEqual(steps(r0, 'toggleMaximize', 'toggleMaximize').rect, R, 'toggle twice = where it was');
  assert.equal(steps(r0, 'toggleMaximize', 'toggleMaximize').state, 'normal');
});

test('minimize remembers normal vs maximized; restore and open return to it', () => {
  const r0 = W.initialRecord(R);
  const min = W.transition(r0, 'minimize');
  assert.deepEqual([min.state, min.before], ['minimized', 'normal']);
  assert.equal(W.transition(min, 'restore').state, 'normal');
  assert.deepEqual(W.transition(min, 'restore').rect, R, 'comes back in place');
  const maxMin = steps(r0, 'maximize', 'minimize');
  assert.deepEqual([maxMin.state, maxMin.before], ['minimized', 'maximized']);
  assert.equal(W.transition(maxMin, 'restore').state, 'maximized', 'a maximized window minimized comes back maximized');
  assert.equal(W.transition(maxMin, 'open').state, 'maximized');
  assert.deepEqual(steps(maxMin, 'restore', 'restore').rect, R, '…and restore from there is its old rect');
  assert.equal(W.transition(min, 'minimize'), min, 'minimize twice is a no-op');
  assert.equal(W.transition(min, 'move', { rect: { x: 1, y: 1, w: 10, h: 10 } }), min, 'a minimized window keeps its rect');
  assert.equal(W.transition(min, 'maximize').state, 'maximized', 'maximize from the dock');
});

test('close keeps rect and normal / maximized for the next open; move only changes a normal window', () => {
  const closed = steps(W.initialRecord(R), 'maximize', 'close');
  assert.deepEqual([closed.state, closed.before], ['closed', 'maximized']);
  assert.equal(W.transition(closed, 'open').state, 'maximized');
  assert.equal(steps(W.initialRecord(R), 'maximize', 'minimize', 'close').before, 'maximized', 'closed while minimized: what it was before that');
  assert.equal(W.transition(closed, 'toggleMaximize'), closed, 'a closed window cannot be maximized');
  const moved = W.transition(W.initialRecord(R), 'move', { rect: { x: 10.4, y: 20.6, w: 300, h: 200 }, at: 9 });
  assert.deepEqual(moved.rect, { x: 10, y: 21, w: 300, h: 200 }, 'rounded to whole pixels');
  assert.equal(moved.at, 9);
  for (const bad of [null, {}, { x: 1, y: 1, w: 0, h: 5 }, { x: 'a', y: 1, w: 5, h: 5 }, { x: NaN, y: 1, w: 5, h: 5 }]) {
    assert.equal(W.cleanRect(bad), null, JSON.stringify(bad));
  }
});

test('every state is reachable and no action leaves the four states', () => {
  const seen = new Set();
  let frontier = [W.initialRecord(R)];
  for (let depth = 0; depth < 4; depth++) {
    const next = [];
    for (const r of frontier) {
      for (const a of W.ACTIONS) {
        const n = W.transition(r, a, { rect: { x: 1, y: 2, w: 3, h: 4 } });
        assert.ok(W.STATES.includes(n.state), `${r.state} --${a}--> ${n.state}`);
        assert.ok(n.before === 'normal' || n.before === 'maximized');
        if (!seen.has(n.state)) next.push(n);
        seen.add(n.state);
      }
    }
    frontier = next;
  }
  assert.deepEqual([...seen].sort(), [...W.STATES].sort());
});

test('normalizeRecord repairs junk; the windows map keeps the newest MAX_WINDOWS', () => {
  assert.equal(W.normalizeRecord(null), null);
  assert.equal(W.normalizeRecord([]), null);
  assert.deepEqual(W.normalizeRecord({ state: 'weird', rect: 'x', before: 'minimized', at: 'now' }), { state: 'normal', rect: null, before: 'normal', at: 0 });
  let map = {};
  for (let i = 0; i < W.MAX_WINDOWS + 5; i++) map = W.putWindow(map, `k${i}`, { ...W.initialRecord(R), at: i });
  assert.equal(Object.keys(map).length, W.MAX_WINDOWS);
  assert.ok(!('k0' in map) && 'k64' in map, 'the oldest go first');
  assert.equal(W.putWindow(map, 'k64', map.k64), map, 'unchanged record = same map');
  const gone = W.putWindow(map, 'k64', null);
  assert.ok(!('k64' in gone) && 'k64' in map, 'null forgets, without touching the input');
  assert.equal(W.putWindow(map, '', W.initialRecord(R)), map, 'an empty key is refused');
  assert.deepEqual(W.normalizeWindows({ a: { state: 'maximized', rect: R, at: 2 }, '': { state: 'normal' }, b: 7 }), { a: { state: 'maximized', rect: R, before: 'normal', at: 2 } });
});

// ---------------------------------------------------------------- the dock layout store

function memoryStorage(init = {}) {
  const m = new Map(Object.entries(init));
  return { getItem: (k) => (m.has(k) ? m.get(k) : null), setItem: (k, v) => m.set(k, String(v)), map: m };
}

test("window state persists in 'rigs.dock' across a reload", () => {
  const storage = memoryStorage();
  const a = D.createDockManager();
  a.attach({ storage });
  a.registerPanel('work', { title: 'Work' });
  a.setWindow('app:n1/szuf', W.transition(W.initialRecord(R, 1), 'maximize', { at: 2 }));
  a.setWindow('files:n1', W.transition(W.initialRecord({ x: 30, y: 40, w: 900, h: 500 }, 3), 'minimize', { at: 4 }));
  const stored = JSON.parse(storage.getItem('rigs.dock'));
  assert.equal(stored.version, 2);
  assert.equal(stored.windows['app:n1/szuf'].state, 'maximized');

  const b = D.createDockManager(); // a fresh page
  b.attach({ storage });
  assert.deepEqual(b.getWindow('app:n1/szuf'), { state: 'maximized', rect: R, before: 'normal', at: 2 });
  const files = b.getWindow('files:n1');
  assert.deepEqual([files.state, files.before, files.rect], ['minimized', 'normal', { x: 30, y: 40, w: 900, h: 500 }]);
  assert.equal(W.transition(files, 'open').state, 'normal', 'opened again after the reload: on the stage at its rect');
  assert.equal(b.getWindow('nope'), null);
  assert.deepEqual(b.listPanels().map((p) => p.id), ['work'], 'panels are untouched');
});

test('saving a window record tells listeners with its own cause and is skipped when nothing changed', () => {
  const m = D.createDockManager();
  m.attach({ storage: memoryStorage() });
  const causes = [];
  m.subscribe((_L, cause) => causes.push(cause));
  const r = W.initialRecord(R, 1);
  m.setWindow('k', r);
  m.setWindow('k', { ...r }); // same content
  assert.deepEqual(causes, ['windows']);
  m.setWindow('k', null);
  assert.deepEqual(m.getLayout().windows, {});
});

test('migration: a version 1 layout keeps its panels and gains an empty windows map', () => {
  const v1 = {
    version: 1,
    root: { type: 'split', dir: 'row', ratios: [0.3, 0.7], children: [{ type: 'tabs', panels: ['work', 'questions'], active: 'work' }, { type: 'panel', id: 'stage' }] },
    floating: [{ id: 'chat', x: 10, y: 20, w: 300, h: 400, z: 3, vw: 1440, vh: 900 }],
    hidden: { usage: { kind: 'float', rect: { x: null, y: null, w: null, h: null, vw: null, vh: null } } },
    collapsed: ['chat'],
  };
  const L = D.deserialize(JSON.stringify(v1));
  assert.equal(L.version, D.VERSION);
  assert.equal(D.VERSION, 2);
  assert.deepEqual(L.windows, {});
  assert.deepEqual(L.root, v1.root);
  assert.deepEqual(L.floating, v1.floating);
  assert.deepEqual(Object.keys(L.hidden), ['usage']);
  assert.deepEqual(L.collapsed, ['chat']);
  assert.deepEqual(D.deserialize(D.serialize(L)), L, 'and round-trips as version 2');

  // Through the manager, as a page load does: the stored v1 text is read, migrated and written back as v2.
  const storage = memoryStorage({ 'rigs.dock': JSON.stringify(v1) });
  const m = D.createDockManager();
  m.attach({ storage });
  const now = JSON.parse(storage.getItem('rigs.dock'));
  assert.equal(now.version, 2);
  assert.deepEqual(now.windows, {});
  assert.deepEqual(now.root, v1.root);
  assert.equal(m.getWindow('anything'), null);
});

test("migration: legacy 'rigs.panels' state lands in version 2 with no windows; unreadable versions start clean", () => {
  const storage = memoryStorage({ 'rigs.panels': JSON.stringify({ left: { closed: false, collapsed: false, pos: { left: 24, top: 30, width: '340px', height: '700px' } } }) });
  const m = D.createDockManager();
  m.attach({ storage, viewport: () => ({ w: 1440, h: 900 }) });
  const L = m.getLayout();
  assert.equal(L.version, 2);
  assert.deepEqual(L.windows, {});
  assert.deepEqual(L.floating.map((f) => f.id), ['left']);
  assert.deepEqual(D.deserialize({ version: 99, windows: { a: { state: 'normal' } } }), D.emptyLayout());
  assert.deepEqual(D.deserialize({ version: 2, windows: { a: { state: 'maximized', rect: R, at: 1 }, b: 'junk' } }).windows, { a: { state: 'maximized', rect: R, before: 'normal', at: 1 } });
});

test('panel operations and reset keep the layout well-formed with windows in it', () => {
  let L = D.setWindow(D.emptyLayout(), 'k', W.initialRecord(R));
  L = D.undock(L, 'p', { x: 1, y: 2, w: 300, h: 200 });
  L = D.hide(L, 'p');
  L = D.restore(L, 'p');
  assert.deepEqual(Object.keys(L.windows), ['k'], 'panel ops carry the windows map along');
  assert.equal(D.setWindow(L, 'k', L.windows.k), L, 'unchanged = same layout');
  const m = D.createDockManager();
  m.attach({ storage: memoryStorage() });
  m.setWindow('k', W.initialRecord(R));
  m.resetLayout();
  assert.deepEqual(m.getLayout().windows, {}, 'Reset layout forgets remembered windows too');
});
