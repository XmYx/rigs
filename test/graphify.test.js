// Graphify window (ui/src/graphify.js): the pure model, the registration of the 'graphify' panel (page element,
// makeFloating call, toolbar button, phone sheet, Window / Tools menu entry, phone CSS) and its layout behaviour on
// the real dock layout engine — opens from hidden, floats, docks beside / as a tab, undocks, closes, restores to
// the same place and survives a "reload" (a second manager on the same storage). No browser.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const read = (f) => fs.readFileSync(path.join(ROOT, f), 'utf8');
const M = await import('../ui/src/graphify-model.js');
const D = await import('../ui/src/dock-layout.js');

test('summarize counts nodes, links and machines; shouldRun needs the window open and expanded', () => {
  assert.equal(M.summarize({ nodes: [], links: [] }).text, '0 nodes · 0 links');
  assert.equal(M.summarize(null).nodes, 0);
  const s = M.summarize({ nodes: [{ type: 'mesh' }, { type: 'machine' }, { type: 'offline' }, { type: 'agent' }], links: [{}] });
  assert.deepEqual([s.nodes, s.links, s.machines], [4, 1, 2]);
  assert.equal(s.text, '4 nodes · 1 link · 2 machines');
  assert.equal(M.summarize({ nodes: [{ type: 'machine' }], links: [] }).text, '1 node · 0 links · 1 machine');
  assert.equal(M.shouldRun({ closed: false, collapsed: false }), true);
  assert.equal(M.shouldRun({ closed: true, collapsed: false }), false);
  assert.equal(M.shouldRun({ closed: false, collapsed: true }), false);
  assert.equal(M.shouldRun(), true, 'nothing known yet counts as open');
});

test('the Graphify panel is registered: page element, panel, toolbar button, phone sheet, menus, phone CSS', () => {
  const html = read('ui/index.html');
  assert.match(html, /<aside id="graphify" class="panel"/);
  assert.match(html, /<button id="btn-graphify"[^>]*aria-label="Graphify/);
  const main = read('ui/src/main.js');
  assert.match(main, /createGraphify\(\$\('#graphify'\), \{ createGraph,/, 'reuses the galaxy graph module');
  assert.match(main, /makeFloating\(\$\('#graphify'\), \{ id: 'graphify', title: 'Graphify'[^}]*closedByDefault: true, closedOnPhone: true/);
  assert.match(main, /\$\('#btn-graphify'\)\.onclick = \(\) => togglePanel\('graphify'\)/);
  assert.match(main, /graphifyPanel\?\.update\(\)/, 'follows the mesh snapshot');
  assert.match(read('ui/src/mobile.js'), /\['btn-graphify', 'Graphify'\]/);
  const cmds = read('ui/src/jarvis-commands.js');
  assert.match(cmds, /id: 'tools\.graphify'[^\n]*focusPanel\('graphify'\)/);
  assert.match(cmds, /\{ cmd: 'tools\.graphify' \}/, 'listed in the Tools menu; the Window menu lists every panel registered through makeFloating');
  const css = read('ui/src/styles.css');
  assert.match(css, /#graphify \{ position: fixed;/);
  assert.match(css, /\.gfy-empty\[hidden\] \{ display: none; \}/, 'the waiting note really goes away once there is data');
  assert.match(css, /#graphify \{ top: var\(--hdr\) !important;[^}]*height: var\(--room\)/, 'full width under the header on a phone');
  const src = read('ui/src/graphify.js');
  assert.match(src, /setActive\(on\)/);
  assert.match(src, /graph\.pause\(\)/, 'the render loop sleeps while the window is closed');
  assert.match(read('ui/src/graph.js'), /pause\(\) \{ Graph\.pauseAnimation\(\); \}/);
});

function memStorage() {
  const m = new Map();
  return { getItem: (k) => m.get(k) ?? null, setItem: (k, v) => m.set(k, String(v)), m };
}

// Like panels.js defaults(): a closedByDefault panel starts hidden at its CSS place on a first run (nothing stored).
const NO_RECT = { x: null, y: null, w: null, h: null, vw: null, vh: null };
function manager(storage, { first = false } = {}) {
  const defaults = () => { const L = D.emptyLayout(); if (first) L.hidden.graphify = { kind: 'float', rect: { ...NO_RECT } }; return L; };
  const m = D.createDockManager({ defaults });
  for (const [id, title] of [['left', 'Side panel'], ['work', 'Active projects'], ['traces', 'Request traces']]) m.registerPanel(id, { title });
  m.registerPanel('graphify', { title: M.GRAPHIFY_TITLE, hidden: first });
  m.attach({ storage, viewport: () => ({ w: 1440, h: 900 }) });
  return m;
}
const status = (m, id) => m.listPanels().find((p) => p.id === id).status;

test('layout: starts closed, opens, floats, docks beside and as a tab, undocks, closes and restores in place', () => {
  const st = memStorage();
  const m = manager(st, { first: true });
  assert.equal(status(m, 'graphify'), 'hidden', 'closed by default');
  assert.equal(m.listPanels().find((p) => p.id === 'graphify').title, 'Graphify', 'the title the Window menu shows');
  m.restorePanel('graphify');
  assert.equal(status(m, 'graphify'), 'floating', 'opens as a floating window');

  m.dockPanel('left', 'root', 'left'); // a dock target must itself be docked
  m.dockPanel('graphify', 'left', 'right');
  assert.equal(status(m, 'graphify'), 'docked', 'docks beside the side panel');
  assert.equal(D.nodeAt(m.getLayout(), []).type, 'split');
  const beside = JSON.stringify(m.getLayout().root);
  m.hidePanel('graphify');
  assert.equal(status(m, 'graphify'), 'hidden', 'closes');
  m.restorePanel('graphify');
  assert.equal(JSON.stringify(m.getLayout().root), beside, 'reopens exactly where it was docked');

  m.dockPanel('graphify', 'left', 'tab');
  const tab = D.nodeAt(m.getLayout(), D.pathOf(m.getLayout(), 'graphify').slice(0, -1));
  assert.equal(tab.type, 'tabs');
  assert.ok(tab.panels.includes('graphify') && tab.panels.includes('left'), 'docks as a tab of another panel');

  m.floatPanel('graphify', { x: 40, y: 60, w: 560, h: 420 });
  assert.equal(status(m, 'graphify'), 'floating', 'undocks');
  const f = m.getLayout().floating.find((x) => x.id === 'graphify');
  assert.deepEqual([f.x, f.y, f.w, f.h], [40, 60, 560, 420]);

  m.resetLayout();
  assert.equal(status(m, 'graphify'), 'hidden', 'Reset layout puts it back to its default: closed');
  assert.equal(status(m, 'left'), 'floating', 'and the other panels to their CSS place');
});

test('layout survives a reload: a second manager on the same storage sees the open, docked and closed states', () => {
  const st = memStorage();
  const m = manager(st, { first: true });
  m.restorePanel('graphify');
  m.dockPanel('graphify', 'traces', 'bottom');
  const docked = m.getLayout();
  const reloaded = manager(st);
  assert.equal(status(reloaded, 'graphify'), 'docked');
  assert.deepEqual(reloaded.getLayout(), docked, 'same layout after a reload');

  reloaded.hidePanel('graphify');
  const again = manager(st);
  assert.equal(status(again, 'graphify'), 'hidden', 'closed stays closed after a reload');
  again.restorePanel('graphify');
  assert.equal(status(again, 'graphify'), 'docked', 'and restores to the dock place saved before the reload');
  assert.equal(JSON.stringify(again.getLayout().root), JSON.stringify(docked.root));

  const floating = manager(memStorage(), { first: true });
  floating.restorePanel('graphify');
  floating.floatPanel('graphify', { x: 12, y: 34, w: 500, h: 400 });
  const copy = memStorage();
  copy.setItem(D.STORAGE_KEY, D.serialize(floating.getLayout()));
  const f = manager(copy).getLayout().floating.find((x) => x.id === 'graphify');
  assert.deepEqual([f.x, f.y, f.w, f.h], [12, 34, 500, 400], 'a floating position and size persist');
});
