// JARVIS panels as windows (ui/src/panels.js over dock-layout.js): every panel has the wm.js title bar buttons
// (– minimize, □/❐ maximize/restore, ✕ close), the four window states in the 'rigs.dock' layout (version 3: `minimized`,
// `maximized`), the migration of saved layouts (collapsed → minimized, hidden → closed) from version 1 / 2 and the
// legacy 'rigs.panels', docked / tabbed behaviour, Reset layout, the app dock's minimized mark, and the menus.
// No DOM: pure model tests plus source checks for the DOM wiring.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { test } from 'node:test';

const D = await import('../ui/src/dock-layout.js');
const W = await import('../ui/src/window-state.js');
const E = await import('../ui/src/open-events.js');
const S = await import('../ui/src/app-dock-state.js');

const read = (p) => fs.readFileSync(new URL(`../${p}`, import.meta.url), 'utf8');
const leaf = (id) => ({ type: 'panel', id });
const NO_RECT = { x: null, y: null, w: null, h: null, vw: null, vh: null };

function memoryStorage(init = {}) {
  const m = new Map(Object.entries(init));
  return { getItem: (k) => (m.has(k) ? m.get(k) : null), setItem: (k, v) => m.set(k, String(v)), map: m };
}

/** A saved version 2 layout as a JARVIS page wrote it before panels became windows. */
const V2 = {
  version: 2,
  root: {
    type: 'split', dir: 'row', ratios: [0.25, 0.5, 0.25], children: [
      { type: 'tabs', panels: ['work', 'questions', 'agents'], active: 'questions' },
      leaf('stage'),
      { type: 'split', dir: 'column', ratios: [0.6, 0.4], children: [leaf('legend'), leaf('traces')] },
    ],
  },
  floating: [
    { id: 'dock', x: 400, y: 600, w: 520, h: 260, z: 2, vw: 1440, vh: 900 },
    { id: 'orb', x: null, y: null, w: null, h: null, z: 1, vw: null, vh: null },
  ],
  hidden: {
    usage: { kind: 'float', rect: { x: 900, y: 80, w: 380, h: 420, vw: 1440, vh: 900 } },
    desktops: { kind: 'float', rect: NO_RECT },
  },
  collapsed: ['dock', 'orb', 'questions', 'legend', 'usage'],
  windows: { 'files:n1': { state: 'maximized', rect: { x: 10, y: 20, w: 800, h: 500 }, before: 'normal', at: 5 } },
};

// ---------------------------------------------------------------- migration

test('migration: a version 2 layout keeps every place; collapsed panels are minimized, hidden ones closed', () => {
  const L = D.deserialize(JSON.stringify(V2));
  assert.equal(L.version, 3);
  assert.ok(!('collapsed' in L), 'the old field is gone');
  // Floating collapsed panels stay where they were, as their title strip.
  assert.deepEqual(L.floating, V2.floating);
  assert.equal(D.panelWindowState(L, 'dock'), 'minimized');
  assert.equal(D.panelWindowState(L, 'orb'), 'minimized', 'the face folds to its orb as before');
  // A collapsed docked panel or tab is minimized out of the tree, its place kept for the restore.
  assert.equal(D.panelWindowState(L, 'questions'), 'minimized');
  assert.equal(D.panelWindowState(L, 'legend'), 'minimized');
  assert.equal(D.pathOf(L, 'questions'), null);
  assert.equal(D.pathOf(L, 'legend'), null);
  assert.deepEqual(D.panelsIn(L.root), ['work', 'agents', 'stage', 'traces']);
  // Closed panels stay closed; a closed panel that was also collapsed is closed (it reopens normal).
  assert.equal(D.panelWindowState(L, 'usage'), 'closed');
  assert.equal(D.panelWindowState(L, 'desktops'), 'closed');
  assert.deepEqual(L.hidden.usage, V2.hidden.usage);
  assert.deepEqual(L.maximized, []);
  assert.deepEqual(L.windows, V2.windows, 'wm.js window records are untouched');
  assert.deepEqual(D.panelWindowState(L, 'work'), 'normal');

  // Restoring the minimized docked ones puts back exactly the tree that was saved.
  let back = D.panelAction(L, 'questions', 'restore');
  back = D.panelAction(back, 'legend', 'restore');
  assert.deepEqual(back.root, { ...V2.root, children: [{ ...V2.root.children[0], active: 'questions' }, ...V2.root.children.slice(1)] });
  // Reopening the closed one brings it back at its old rect, not minimized.
  const usage = D.panelAction(L, 'usage', 'open');
  assert.equal(D.panelWindowState(usage, 'usage'), 'normal');
  assert.deepEqual(usage.floating.find((f) => f.id === 'usage'), { id: 'usage', ...V2.hidden.usage.rect, z: 3 });
});

test('migration: through the manager a stored version 2 layout is rewritten as version 3 and survives the next reload', () => {
  const storage = memoryStorage({ 'rigs.dock': JSON.stringify(V2) });
  const a = D.createDockManager();
  a.attach({ storage });
  const saved = JSON.parse(storage.getItem('rigs.dock'));
  assert.equal(saved.version, 3);
  assert.deepEqual(saved.minimized.sort(), ['dock', 'legend', 'orb', 'questions']);
  assert.deepEqual(saved.maximized, []);
  assert.ok(!('collapsed' in saved));
  const b = D.createDockManager(); // the next page load reads version 3 as it is
  b.attach({ storage });
  assert.deepEqual(b.getLayout(), a.getLayout());
  assert.deepEqual(b.listPanels().filter((p) => p.minimized).map((p) => p.id).sort(), ['dock', 'legend', 'orb', 'questions']);
});

test("migration: the legacy 'rigs.panels' state: collapsed → minimized, closed → closed (closed wins over collapsed)", () => {
  const legacy = {
    left: { closed: false, collapsed: true, pos: { left: 24, top: 30, width: '340px', height: '700px' } },
    work: { closed: true, collapsed: true, pos: { left: 1500, top: 300, width: '420px', height: null } },
    dock: { closed: false, collapsed: false },
  };
  const storage = memoryStorage({ 'rigs.panels': JSON.stringify(legacy) });
  const m = D.createDockManager();
  m.attach({ storage, viewport: () => ({ w: 1920, h: 1080 }) });
  const L = m.getLayout();
  assert.equal(L.version, 3);
  assert.deepEqual(['left', 'work', 'dock'].map((id) => D.panelWindowState(L, id)), ['minimized', 'closed', 'normal']);
  assert.deepEqual(L.floating.find((f) => f.id === 'left'), { id: 'left', x: 24, y: 30, w: 340, h: 700, vw: 1920, vh: 1080, z: 1 });
  assert.equal(JSON.parse(storage.getItem('rigs.dock')).version, 3, 'written back in the new format');
});

test('migration: version 1 (no windows) the same way; a version 3 layout round-trips with its window states', () => {
  const v1 = { ...V2, version: 1, windows: undefined };
  const L = D.deserialize(v1);
  assert.deepEqual(L.windows, {});
  assert.equal(D.panelWindowState(L, 'legend'), 'minimized');
  let l = D.panelAction(L, 'work', 'maximize');
  l = D.panelAction(l, 'dock', 'restore');
  assert.deepEqual(D.deserialize(D.serialize(l)), l);
  assert.deepEqual([D.panelWindowState(D.deserialize(D.serialize(l)), 'work'), D.panelWindowState(D.deserialize(D.serialize(l)), 'dock')], ['maximized', 'normal']);
  // A minimized id that is in a stored v3 tree (hand-edited, or a stale writer) is moved out of the tree on load.
  const odd = D.deserialize({ version: 3, root: { type: 'split', dir: 'row', ratios: [0.5, 0.5], children: [leaf('a'), leaf('stage')] }, floating: [], hidden: {}, minimized: ['a', 'ghost'], maximized: ['stage', 'nope'] });
  assert.equal(D.pathOf(odd, 'a'), null);
  assert.equal(D.panelWindowState(odd, 'a'), 'minimized');
  assert.deepEqual(odd.maximized, ['stage'], 'unknown ids dropped');
});

// ---------------------------------------------------------------- the four states

const base = () => {
  let l = D.ensurePanels({ ...D.emptyLayout(), root: leaf('stage') }, ['a', 'b', 'c']);
  l = D.undock(l, 'a', { x: 50, y: 60, w: 300, h: 200, vw: 1440, vh: 900 });
  return l;
};

test('floating: minimize keeps the rect (title strip in place); restore, maximize, close and reopen follow the window model', () => {
  let l = base();
  const rect = l.floating.find((f) => f.id === 'a');
  l = D.panelAction(l, 'a', 'minimize');
  assert.equal(D.panelWindowState(l, 'a'), 'minimized');
  assert.deepEqual(l.floating.find((f) => f.id === 'a'), rect, 'a floating panel stays where it is');
  assert.equal(D.panelAction(l, 'a', 'minimize'), l, 'minimize twice: nothing changes');
  l = D.panelAction(l, 'a', 'restore');
  assert.equal(D.panelWindowState(l, 'a'), 'normal');

  l = D.panelAction(l, 'a', 'toggleMaximize');
  assert.equal(D.panelWindowState(l, 'a'), 'maximized');
  assert.deepEqual(l.floating.find((f) => f.id === 'a'), rect, 'maximize keeps the place for the restore');
  l = D.panelAction(l, 'a', 'minimize');
  assert.equal(D.panelWindowState(l, 'a'), 'minimized');
  l = D.panelAction(l, 'a', 'restore');
  assert.equal(D.panelWindowState(l, 'a'), 'maximized', 'a maximized panel minimized comes back maximized');
  l = D.panelAction(l, 'a', 'restore');
  assert.equal(D.panelWindowState(l, 'a'), 'normal');
  assert.deepEqual(l.floating.find((f) => f.id === 'a'), rect, 'exact previous rect');

  l = D.panelAction(D.panelAction(l, 'a', 'minimize'), 'a', 'close');
  assert.equal(D.panelWindowState(l, 'a'), 'closed', 'closing a minimized panel closes it');
  l = D.panelAction(l, 'a', 'open');
  assert.equal(D.panelWindowState(l, 'a'), 'normal', 'and it reopens normal, where it was');
  assert.deepEqual(l.floating.find((f) => f.id === 'a'), { ...rect, z: l.floating.find((f) => f.id === 'a').z });
  l = D.panelAction(D.panelAction(l, 'a', 'maximize'), 'a', 'close');
  assert.equal(D.panelAction(l, 'a', 'open').maximized.includes('a'), true, 'closed while maximized: reopens maximized, as a window does');
  assert.equal(D.panelAction(l, 'a', 'minimize'), l, 'a closed panel cannot be minimized');
  assert.equal(D.panelAction(l, 'zz', 'close'), l, 'unknown panel: nothing');
});

test('docked: minimize and close act on the tab (exact place back); maximize zooms without changing the tree', () => {
  let l = base();
  l = D.dock(l, 'b', 'stage', 'left', { share: 0.3 });
  l = D.dock(l, 'c', 'b', 'center');
  l = D.setActiveTab(l, 'b');
  const tree = l.root;
  // Minimize the active tab: it leaves the group, the other tab shows.
  let m = D.panelAction(l, 'b', 'minimize');
  assert.equal(D.panelWindowState(m, 'b'), 'minimized');
  assert.equal(D.pathOf(m, 'b'), null);
  assert.deepEqual(m.root.children[0], leaf('c'), 'the group falls back to the tab that is left');
  m = D.panelAction(m, 'b', 'restore');
  assert.deepEqual(m.root, tree, 'back in its tab, at its index, active again');
  // Close the same way; reopen puts it back.
  const closed = D.panelAction(l, 'b', 'close');
  assert.equal(D.panelWindowState(closed, 'b'), 'closed');
  assert.deepEqual(D.panelAction(closed, 'b', 'open').root, tree);
  // Maximize: the tree is untouched, so restoring is exact.
  const max = D.panelAction(l, 'c', 'maximize');
  assert.equal(D.panelWindowState(max, 'c'), 'maximized');
  assert.deepEqual(max.root, tree);
  assert.deepEqual(D.panelAction(max, 'c', 'restore'), l);
  // A minimized strip dropped into the tree is shown again: minimized panels never sit in the tree.
  const strip = D.panelAction(D.undock(l, 'b', { x: 1, y: 2, w: 300, h: 200 }), 'b', 'minimize');
  const docked = D.dock(strip, 'b', 'stage', 'right');
  assert.equal(D.panelWindowState(docked, 'b'), 'normal');
  assert.equal(D.panelWindowState(D.moveTab(strip, 'b', 'c', 0), 'b'), 'normal');
});

test('Reset layout clears every minimized / maximized panel back to the defaults', () => {
  const storage = memoryStorage();
  const defaults = () => ({ ...D.emptyLayout(), root: leaf('stage'), floating: [{ id: 'a', ...NO_RECT, z: 1 }, { id: 'b', ...NO_RECT, z: 2 }], hidden: { c: { kind: 'float', rect: NO_RECT } } });
  const m = D.createDockManager({ defaults });
  for (const id of ['a', 'b', 'c']) m.registerPanel(id, { title: id.toUpperCase(), hidden: id === 'c' });
  m.attach({ storage });
  const causes = [];
  m.subscribe((_L, cause) => causes.push(cause));
  m.panelAction('a', 'minimize');
  m.panelAction('b', 'maximize');
  m.panelAction('c', 'open');
  assert.deepEqual(['a', 'b', 'c'].map((id) => m.panelState(id)), ['minimized', 'maximized', 'normal']);
  assert.deepEqual(causes, ['minimize', 'maximize', 'open'], 'listeners hear each action (docking.js re-renders)');
  m.resetLayout();
  assert.deepEqual(['a', 'b', 'c'].map((id) => m.panelState(id)), ['normal', 'normal', 'closed']);
  assert.deepEqual([m.getLayout().minimized, m.getLayout().maximized], [[], []]);
  assert.deepEqual(m.listPanels().filter((p) => p.id !== 'stage').map((p) => [p.id, p.state]), [['a', 'normal'], ['b', 'normal'], ['c', 'closed']]);
});

// ---------------------------------------------------------------- the title bar buttons

function fakeH(tag, attrs = {}, ...children) {
  const el = {
    tag, attrs: {}, textContent: children.join(''), title: '',
    setAttribute(k, v) { this.attrs[k] = String(v); },
    getAttribute(k) { return this.attrs[k]; },
    click() { this.onclick?.({ stopPropagation() {} }); },
  };
  for (const [k, v] of Object.entries(attrs)) {
    if (k === 'onclick') el.onclick = v;
    else if (k === 'title') { el.title = v; el.attrs.title = v; }
    else el.setAttribute(k, v);
  }
  return el;
}

test('the same three buttons as a window; on a minimized strip the first one is Restore (❐)', () => {
  const acts = [];
  const chrome = W.buildChrome(fakeH, (a) => acts.push(a));
  assert.deepEqual(chrome.els.map((b) => [b.getAttribute('class'), b.textContent]), [['win-btn win-min', '–'], ['win-btn win-max', '□'], ['win-btn close', '✕']]);
  chrome.sync({ state: 'minimized' });
  assert.deepEqual([chrome.els[0].textContent, chrome.els[0].getAttribute('aria-label'), chrome.els[0].getAttribute('data-win-act')], ['❐', 'Restore', 'restore']);
  chrome.els[0].click();
  chrome.sync({ state: 'normal' });
  chrome.els[0].click();
  chrome.els[1].click();
  chrome.els[2].click();
  assert.deepEqual(acts, ['restore', 'minimize', 'toggleMaximize', 'close']);
  assert.deepEqual(W.chromeButtons({ state: 'normal' }).map((b) => b.cls), W.chromeButtons({ state: 'minimized' }).map((b) => b.cls), 'same elements and order');
});

test('panels.js builds every panel title bar from the wm.js chrome; no old ▾ / ✕ buttons are left', () => {
  const src = read('ui/src/panels.js');
  assert.match(src, /import \{ buildChrome \} from '\.\/window-state\.js'/);
  assert.match(src, /const chrome = buildChrome\(h, \(action\) => panelAction\(id, action\)\)/);
  assert.match(src, /h\('span', \{ class: 'pctl keep'[^)]*\}, grip, \.\.\.chrome\.els\)/, 'grip, then – □ ✕');
  assert.doesNotMatch(src, /pcollapse|'▾'|panel-collapsed/);
  assert.match(src, /onState: \(state, info\) => showState\(id, state, info\)/);
  assert.match(src, /panel-min/);
  assert.match(src, /panel-max/);
  assert.match(src, /if \(isPhone\(\) && \(action === 'minimize' \|\| action === 'maximize' \|\| action === 'toggleMaximize'\)\) return;/, 'phones never minimize or maximize (✕ only)');
  assert.match(src, /pushBack\(p\.closeBack\)/, 'a phone sheet closes with back');
  assert.match(src, /docked \/ tabbed mode/i, 'the header comment documents the docked behaviour');
  // Every panel in the app goes through makeFloating (so every one gets the chrome).
  const main = read('ui/src/main.js');
  const ids = [...main.matchAll(/makeFloating\(\$\('[^']+'\), \{ id: '(\w+)'/g)].map((x) => x[1]);
  assert.deepEqual(ids, ['left', 'legend', 'topbar', 'orb', 'dock', 'work', 'questions', 'usage', 'desktops', 'traces', 'agents', 'graphify', 'footer']);
  assert.match(read('ui/src/ask-panel.js'), /makeFloating\(panel, \{ id: ID, title: 'Ask JARVIS'/);
  // The galaxy is not a panel, and the corner ☰ is not either: neither gets a close button.
  assert.doesNotMatch(main, /makeFloating\([^)]*id: 'stage'/);
});

test('docking.js draws the states: closed / stowed hidden, strip, maximized over the stage (dockArea)', () => {
  const src = read('ui/src/docking.js');
  assert.match(src, /const state = panelWindowState\(L, id\) \|\| 'normal';/);
  assert.match(src, /if \(it\.maximized\) \{ placeMax\(it\); return; \}/);
  assert.match(src, /function placeMax\(it\) \{[\s\S]*?const r = dockArea\(\);/);
  assert.match(src, /it\.maximized = state === 'maximized' && !isPhone\(\);/);
  const css = read('ui/src/styles.css');
  assert.match(css, /\.floating\.panel-min > :not\(\.keep\):not\(\.pctl\) \{ display: none !important; \}/);
  assert.match(css, /\.floating\.panel-max \{ z-index: 95 !important;/, 'over panels, under windows (z 100+)');
  assert.match(css, /#work \.pctl > :not\(\.close\)/, 'phones keep only ✕');
});

// ---------------------------------------------------------------- the app dock

test('a minimized panel is reached from the app dock: its tool tile is marked, else it gets a tile; restore takes it away', () => {
  const bus = E.createOpenBus();
  let state = S.mergeSources(S.emptyState(), { tools: S.TOOLS });
  // Tools start in their default stacks; take Work's out so its tile is a top-level one that can show the mark.
  const gid = Object.keys(state.groups).find((g) => state.groups[g].items.includes('tool:work'));
  state = S.ungroup(state, gid);
  const grouped = Object.keys(state.groups).find((g) => state.groups[g].items.includes('tool:usage'));
  assert.ok(grouped, 'Tokens & time is still in a stack');
  const dock = { get state() { return state; }, act(fn) { state = fn(state); } };
  E.bindDock(bus, dock);
  let panels = [
    { id: 'work', title: 'Active projects', closed: false, minimized: true, dockRef: 'tool:work' },
    { id: 'dock', title: 'Chat', closed: false, minimized: true, dockRef: null },
    { id: 'orb', title: 'JARVIS face', closed: false, minimized: false, dockRef: null },
    { id: 'usage', title: 'Tokens & time', closed: false, minimized: true, dockRef: 'tool:usage' },
  ];
  let fire = null;
  const t = E.trackPanels({ list: () => panels, subscribe: (fn) => { fire = fn; return () => {}; }, bus });
  // The first scan (page load) already shows the panels that were minimized.
  assert.equal(state.items['tool:work'].minimized, true, 'its own tool tile');
  assert.equal(state.items['panel:dock'].minimized, true, 'no tile of its own: a temporary panel tile');
  assert.equal(state.items['panel:dock'].kind, 'panel');
  assert.equal(state.items['panel:orb'], undefined);
  assert.ok(state.items['panel:usage']?.minimized && !state.items['tool:usage'].minimized, 'a tool tile inside a stack cannot stand for it: a tile of its own');
  // Restored: the mark goes, the temporary tile goes.
  panels = panels.map((p) => ({ ...p, minimized: false }));
  fire();
  assert.equal(state.items['tool:work'].minimized, undefined);
  assert.equal(state.items['panel:dock'], undefined);
  assert.equal(state.items['panel:usage'], undefined);
  // Minimized, then closed while minimized: restored first (the tile goes), never stuck.
  panels = panels.map((p) => (p.id === 'orb' ? { ...p, minimized: true } : p));
  fire();
  assert.equal(state.items['panel:orb'].minimized, true);
  panels = panels.map((p) => (p.id === 'orb' ? { ...p, closed: true, minimized: false } : p));
  fire();
  assert.equal(state.items['panel:orb'], undefined);
  t.stop();
  // After a reload a stored tile of a minimized panel goes (it is given back, temporary, by the first scan).
  const stored = S.addItem(S.emptyState(), S.toItem('panel', { id: 'dock', title: 'Chat' }));
  assert.equal(E.reconcileOnLoad(stored, [{ id: 'dock', title: 'Chat', closed: false, minimized: true }]).items['panel:dock'], undefined);
  assert.ok(E.reconcileOnLoad(stored, [{ id: 'dock', title: 'Chat', closed: false, minimized: false }]).items['panel:dock']);
});

test('main.js wires the tool tiles and the onToggle callbacks to the window states', () => {
  const main = read('ui/src/main.js');
  for (const id of ['work', 'questions', 'usage', 'desktops', 'traces', 'agents', 'graphify']) assert.match(main, new RegExp(`id: '${id}', title: '[^']+', dockRef: toolRef\\('${id}'\\)`), id);
  assert.match(main, /const toolRef = \(panel\) =>/);
  assert.doesNotMatch(main, /collapsed/, 'no panel callback reads the old collapsed flag');
  assert.match(main, /onToggle: \(\{ closed, minimized \}\) => work\.setActive\(!closed && !minimized\)/);
  // The Panels menu: a minimized panel is restored (not closed) from its entry.
  const cmds = read('ui/src/jarvis-commands.js');
  assert.match(cmds, /a\.open && a\.kind === 'panel' && !a\.minimized \? hidePanel\(a\) : focusPanel\(a\)/);
  assert.match(cmds, /id: 'window\.hide', label: 'Close'/);
});
