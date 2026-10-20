// The window chrome's wiring: the three title bar buttons (window-state.js buildChrome, used by wm.js), a minimized
// window reaching the app dock and coming back from it (open-events.js → app-dock-state.js), the right-click entries
// (ctx-providers.js), and a guard that every window in ui/src is made by wm.js. No DOM: elements are stand-ins.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { test } from 'node:test';

const W = await import('../ui/src/window-state.js');
const E = await import('../ui/src/open-events.js');
const S = await import('../ui/src/app-dock-state.js');
const M = await import('../ui/src/app-dock-model.js');
const { createProviders, registerJarvisProviders, resolveMenu } = await import('../ui/src/ctx-providers.js');

/** A stand-in for api.js h(): attributes, text and the click handler are all the chrome touches. */
function fakeH(tag, attrs = {}, ...children) {
  const el = {
    tag, attrs: {}, textContent: children.join(''), title: '',
    setAttribute(k, v) { this.attrs[k] = String(v); },
    getAttribute(k) { return this.attrs[k]; },
    click() { this.onclick?.({ stopPropagation: () => { this.stopped = true; } }); },
  };
  for (const [k, v] of Object.entries(attrs)) {
    if (k === 'onclick') el.onclick = v;
    else if (k === 'title') { el.title = v; el.attrs.title = v; }
    else el.setAttribute(k, v);
  }
  return el;
}

test('the title bar has minimize, maximize and close, in that order, with one style', () => {
  const acts = [];
  const chrome = W.buildChrome(fakeH, (a) => acts.push(a));
  assert.deepEqual(chrome.els.map((b) => b.textContent), ['–', '□', '✕']);
  assert.deepEqual(chrome.els.map((b) => b.getAttribute('aria-label')), ['Minimize', 'Maximize', 'Close']);
  assert.deepEqual(chrome.els.map((b) => b.getAttribute('class')), ['win-btn win-min', 'win-btn win-max', 'win-btn close']);
  assert.ok(chrome.els.every((b) => b.tag === 'button' && b.getAttribute('type') === 'button'));
  assert.equal(chrome.els[1].getAttribute('aria-pressed'), 'false');
  for (const b of chrome.els) b.click();
  assert.deepEqual(acts, ['minimize', 'toggleMaximize', 'close']);
  assert.ok(chrome.els.every((b) => b.stopped), 'a button click never reaches the bar (drag / double-click)');
});

test('buttons follow the state: maximized shows ❐ Restore (pressed), back to □ Maximize after restore', () => {
  const chrome = W.buildChrome(fakeH, () => {});
  let rec = W.initialRecord({ x: 1, y: 2, w: 300, h: 200 });
  const run = (a) => { rec = W.transition(rec, a); chrome.sync(rec); };
  run('toggleMaximize');
  const max = chrome.els[1];
  assert.deepEqual([max.textContent, max.getAttribute('aria-label'), max.title, max.getAttribute('aria-pressed')], ['❐', 'Restore', 'Restore', 'true']);
  run('minimize');
  run('restore');
  assert.equal(max.textContent, '❐', 'restored from the dock: still maximized');
  run('toggleMaximize');
  assert.deepEqual([max.textContent, max.getAttribute('aria-label'), max.getAttribute('aria-pressed')], ['□', 'Maximize', 'false']);
  assert.deepEqual(rec.rect, { x: 1, y: 2, w: 300, h: 200 }, 'exact previous rect');
  assert.deepEqual(W.chromeButtons(rec).map((b) => b.action), ['minimize', 'toggleMaximize', 'close'], 'same order in every state');
});

// ---------------------------------------------------------------- minimized windows and the app dock

function fakeDock(settings = {}, initial = S.emptyState()) {
  const dock = {
    state: S.setSettings(initial, settings),
    act(fn) { const next = fn(dock.state); if (next && next !== dock.state) dock.state = next; return dock.state; },
  };
  return dock;
}
const wire = (settings, initial) => { const bus = E.createOpenBus(); const dock = fakeDock(settings, initial); E.bindDock(bus, dock); return { bus, dock }; };
const win = { id: '7', title: 'Sessions — whole mesh', icon: '💬' };

test('a minimized window gets a dock item even with autoDock off; restoring takes it away again', () => {
  const { bus, dock } = wire();
  E.emitMinimized(win, null, bus);
  const it = dock.state.items['window:7'];
  assert.ok(it, 'reachable from the dock');
  assert.equal(it.minimized, true);
  assert.equal(it.title, 'Sessions — whole mesh');
  assert.deepEqual(S.minimizedItems(dock.state), ['window:7']);
  const stored = JSON.parse(S.serialize(dock.state)).items['window:7'];
  assert.ok(!('minimized' in stored) && !('transient' in stored), 'display state is never stored');
  E.emitRestored(win, null, bus);
  assert.equal(dock.state.items['window:7'], undefined, 'gone with the restore');
});

test('an auto-docked or pinned window item stays when restored; only the minimized mark goes', () => {
  const { bus, dock } = wire({ autoDock: true });
  E.emitOpened('window', win, {}, bus);
  E.emitMinimized(win, null, bus);
  assert.equal(dock.state.items['window:7'].minimized, true);
  E.emitRestored(win, null, bus);
  assert.ok(dock.state.items['window:7'] && !dock.state.items['window:7'].minimized);

  const b = wire();
  E.emitMinimized(win, null, b.bus);
  b.dock.act((s) => S.setPinned(s, 'window:7', true)); // pinned while minimized
  E.emitRestored(win, null, b.bus);
  assert.ok(b.dock.state.items['window:7'], 'pinned: kept');
  assert.equal(b.dock.state.items['window:7'].minimized, undefined);
});

test('an app or terminal window minimizes into the tile that already stands for it, when that tile is on the dock', () => {
  const initial = S.mergeSources(S.setSettings(S.emptyState(), { autoGroup: false }), { applets: [{ node: 'n1', id: 'szuf', name: 'Szuf' }] });
  const { bus, dock } = wire({}, initial);
  const rep = 'applet:n1/szuf';
  assert.ok(dock.state.order.some((e) => e.id === rep), 'a top-level applet tile');
  E.emitMinimized({ id: '3', title: 'Szuf — n1' }, rep, bus);
  assert.equal(dock.state.items[rep].minimized, true);
  assert.equal(dock.state.items['window:3'], undefined, 'no second item for the same window');
  E.emitRestored({ id: '3', title: 'Szuf — n1' }, rep, bus);
  assert.equal(dock.state.items[rep].minimized, undefined);

  // A terminal whose terminal item is not in the dock (autoDock off) falls back to a window item.
  E.emitMinimized({ id: '4', title: 'n1 — shell' }, 'terminal:pty-9', bus);
  assert.equal(dock.state.items['window:4'].minimized, true);
  E.emitRestored({ id: '4', title: 'n1 — shell' }, 'terminal:pty-9', bus);
  assert.equal(dock.state.items['window:4'], undefined);
});

test('an applet tucked into a group (or hidden) does not hide a minimized window: it gets its own tile', () => {
  const grouped = S.mergeSources(S.emptyState(), { applets: [{ node: 'n1', id: 'szuf', name: 'Szuf' }] }); // autoGroup (default) files it under its machine
  assert.ok(Object.values(grouped.groups).some((g) => g.items.includes('applet:n1/szuf')), 'grouped by default');
  const { bus, dock } = wire({}, grouped);
  E.emitMinimized({ id: '3', title: 'Szuf — n1' }, 'applet:n1/szuf', bus);
  assert.equal(dock.state.items['window:3'].minimized, true, 'its own top-level tile');
  assert.ok(dock.state.order.some((e) => e.id === 'window:3'));
  assert.equal(dock.state.items['applet:n1/szuf'].minimized, undefined);
  E.emitRestored({ id: '3', title: 'Szuf — n1' }, 'applet:n1/szuf', bus);
  assert.equal(dock.state.items['window:3'], undefined);

  const hidden = S.setHidden(S.mergeSources(S.setSettings(S.emptyState(), { autoGroup: false }), { applets: [{ node: 'n1', id: 'szuf', name: 'Szuf' }] }), 'applet:n1/szuf', true);
  const h = wire({}, hidden);
  E.emitMinimized({ id: '5', title: 'Szuf — n1' }, 'applet:n1/szuf', h.bus);
  assert.ok(h.dock.state.items['window:5']?.minimized, 'a hidden applet tile cannot stand for it either');
});

test("the dock item's menu offers Restore for a minimized window and the label says so", () => {
  const { bus, dock } = wire();
  E.emitMinimized(win, null, bus);
  const opened = [];
  const entries = M.itemEntries(dock.state, 'window:7', dock.act, { open: (it) => opened.push(it.id) });
  assert.equal(entries[0].label, 'Restore');
  entries[0].run();
  assert.deepEqual(opened, ['window:7'], 'Restore = the click path (main.js open → layout-actions.openPanel → wm.focusWindow)');
  const src = fs.readFileSync(new URL('../ui/src/app-dock.js', import.meta.url), 'utf8');
  assert.match(src, /it\.minimized \? ' \(minimized\)' : ''/, 'accessible name says minimized');
  assert.match(src, /it\.minimized \? ' min' : ''/, 'tile shows it (styles.css .adock-tile.min)');
});

// ---------------------------------------------------------------- right-click entries

function menuFor(window) {
  const calls = [];
  const rec = (name) => (...a) => { calls.push([name, ...a]); };
  const reg = createProviders();
  registerJarvisProviders(reg, { window: { minimize: rec('min'), isMin: () => false, toggleMax: rec('max'), isMax: () => false, closeOthers: rec('closeOthers'), closeAll: rec('closeAll'), count: () => 3, ...window } });
  return { calls, entries: resolveMenu(reg, [{ kind: 'window', id: '5', data: { title: 'Files' } }]) };
}
const rows = (entries) => entries.filter((e) => !e.sep && !e.header);

test('window menu: Minimize, Maximize, Close in the title bar order, each running its action', () => {
  const { calls, entries } = menuFor();
  const r = rows(entries);
  const names = r.map((e) => e.label || e.cmd);
  const at = (l) => names.indexOf(l);
  assert.ok(at('Minimize') >= 0 && at('Minimize') < at('Maximize') && at('Maximize') < at('Close'), names.join(', '));
  assert.deepEqual(r.slice(at('Minimize'), at('Close') + 1).map((e) => e.icon), ['–', '□', '✕']);
  r[at('Minimize')].run();
  r[at('Maximize')].run();
  assert.deepEqual(calls, [['min', '5'], ['max', '5']]);
  assert.equal(r[at('Close')].cmd, 'window.hide');
});

test('window menu follows the state: a maximized window offers Restore size, a minimized one Restore', () => {
  const max = rows(menuFor({ isMax: () => true }).entries);
  assert.ok(max.find((e) => e.label === 'Restore size' && e.icon === '❐'));
  const min = rows(menuFor({ isMin: () => true }).entries);
  assert.equal(min[0].label, 'Restore');
  assert.equal(min.find((e) => e.label === 'Minimize').disabled, true);
  const none = rows(menuFor({ minimize: undefined }).entries);
  assert.ok(!none.some((e) => e.label === 'Minimize'), 'an entry whose action is not wired is left out');
});

// ---------------------------------------------------------------- one chrome for every window

const SRC = new URL('../ui/src/', import.meta.url);
const sources = (dir = SRC.pathname) => fs.readdirSync(dir, { withFileTypes: true }).flatMap((d) => (d.isDirectory() ? sources(path.join(dir, d.name)) : d.name.endsWith('.js') ? [path.join(dir, d.name)] : []));

test('every window in ui/src is made by wm.js openWindow (one chrome for all)', () => {
  const files = sources();
  assert.ok(files.length > 40);
  const outside = [];
  for (const f of files) {
    if (f.endsWith(`${path.sep}wm.js`)) continue;
    const code = fs.readFileSync(f, 'utf8');
    // A hand-built window would carry the window classes or the old close / maximize buttons itself.
    if (/class:\s*['`][^'`]*\bwin(-bar|-body)?\b(?!-)/.test(code) || /classList\.add\(\s*['`]win['`]/.test(code) || /aria-label['"]?:\s*['"]Maximize/.test(code)) outside.push(path.relative(SRC.pathname, f));
  }
  assert.deepEqual(outside, [], `windows built outside wm.js: ${outside.join(', ')}`);
  const wm = fs.readFileSync(new URL('wm.js', SRC), 'utf8');
  assert.match(wm, /buildChrome\(h,/, 'wm.js builds its buttons from window-state.js');
  assert.match(wm, /\.\.\.chrome\.els\)/, 'and puts them last in the title bar, after the window tools');
  const openers = files.filter((f) => /\bopenWindow\(/.test(fs.readFileSync(f, 'utf8')) && !f.endsWith(`${path.sep}wm.js`));
  assert.ok(openers.length >= 10, `openWindow callers: ${openers.length}`);
});
