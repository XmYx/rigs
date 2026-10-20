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
  assert.match(src, /graph\??\.pause\(\)/, 'the render loop sleeps while the window is closed');
  assert.match(read('ui/src/graph.js'), /pause\(\) \{ paused = true; Graph\.pauseAnimation\(\); \}/);
  assert.match(src, /dropTimer = setTimeout\(drop, DROP_AFTER_MS\)/, 'closed for a while, the graph itself is freed');
  assert.match(src, /graph\.destroy\(\)/);
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

// ── Structure view: the diagram of how JARVIS is built must match the code it describes ──────────────────────────────
const S = await import('../ui/src/graphify-structure.js');

test('structure: every node is anchored to a real file and a symbol that is still in it', () => {
  const nodes = S.buildStructure().nodes.filter(S.isComponent);
  assert.ok(nodes.length >= 50, 'a real diagram, not a stub');
  const stale = [];
  for (const n of nodes) {
    const file = path.join(ROOT, n.src);
    if (!fs.existsSync(file)) { stale.push(`${n.id}: ${n.src} is gone`); continue; }
    if (!fs.readFileSync(file, 'utf8').includes(n.sym)) stale.push(`${n.id}: "${n.sym}" is no longer in ${n.src} — change the code first, then graphify-structure.js`);
  }
  assert.deepEqual(stale, []);
});

test('structure: ids unique, links join existing nodes, every node is wired in, types and kinds are known', () => {
  const { links } = S.buildStructure();
  const nodes = S.buildStructure().nodes.filter(S.isComponent);
  const ids = new Set(nodes.map((n) => n.id));
  assert.equal(ids.size, nodes.length, 'unique ids');
  for (const l of links) {
    assert.ok(ids.has(l.source), `link from unknown node ${l.source}`);
    assert.ok(ids.has(l.target), `link to unknown node ${l.target}`);
    assert.ok(S.S_LINKS[l.kind], `unknown link kind ${l.kind}`);
    assert.notEqual(l.source, l.target);
  }
  assert.equal(new Set(links.map((l) => `${l.source}>${l.target}`)).size, links.length, 'no duplicate links');
  const wired = new Set(links.flatMap((l) => [l.source, l.target]));
  assert.deepEqual(nodes.filter((n) => !wired.has(n.id)).map((n) => n.id), [], 'no orphan nodes');
  for (const n of nodes) {
    assert.ok(S.S_TYPES[n.type], `${n.id}: unknown type ${n.type}`);
    assert.ok(S.LANES.some((l) => l.id === n.lane), `${n.id}: unknown lane ${n.lane}`);
    assert.ok(n.desc && n.desc.length > 20, `${n.id}: says what it is`);
    assert.ok(Number.isFinite(n.fx) && Number.isFinite(n.fy), `${n.id}: pinned on the grid`);
    assert.ok(n.name.length <= 30, `${n.id}: the label must fit (${n.name.length} chars)`);
  }
  const at = nodes.map((n) => `${n.fx},${n.fy}`);
  assert.equal(new Set(at).size, at.length, 'no two nodes on the same spot');
  for (const t of Object.keys(S.S_TYPES).filter((k) => !S.S_TYPES[k].hidden)) assert.ok(nodes.some((n) => n.type === t), `type ${t} is used`);
  // The graph is mutated by 3d-force-graph: every call hands out fresh objects.
  assert.notEqual(S.buildStructure().nodes[0], nodes[0]);
  assert.notEqual(S.buildStructure().links[0], links[0]);
});

test('structure: each lane has a title to the left of its rows, and it is a label, not a component', () => {
  const all = S.buildStructure().nodes;
  const titles = all.filter((n) => n.type === 's-lane');
  assert.deepEqual(titles.map((n) => n.id), S.LANES.map((l) => `lane:${l.id}`));
  const left = Math.min(...all.filter(S.isComponent).map((n) => n.fx));
  for (const t of titles) assert.ok(t.fx < left, `${t.id} sits left of the diagram`);
  const ys = titles.map((t) => t.fy);
  assert.deepEqual([...ys].sort((a, b) => b - a), ys, 'lanes read top to bottom');
  assert.equal(M.summarizeStructure({ nodes: all, links: [] }).nodes, all.length - titles.length, 'titles are not counted as nodes');
  assert.equal(S.S_TYPES['s-lane'].hidden, true, 'and are not in the legend');
});

test('structure: the routing algorithm shown is the one in router.js, the tool families are real MCP tools', () => {
  const { links } = S.buildStructure();
  const nodes = S.buildStructure().nodes.filter(S.isComponent);
  const router = read('src/router.js');
  const routes = JSON.parse(router.match(/export const ROUTES = (\[[^\]]*\])/)[1].replace(/'/g, '"'));
  assert.deepEqual(routes, ['answer', 'implement', 'plan', 'continue']);
  const shown = nodes.filter((n) => n.type === 's-route').map((n) => n.name).sort();
  assert.deepEqual(shown, [...routes].sort(), 'one route node per router route');
  const out = links.filter((l) => l.source === 'd-route').map((l) => l.target).sort();
  assert.deepEqual(out, nodes.filter((n) => n.type === 's-route').map((n) => n.id).sort(), 'the decision leads to each route');
  const engines = router.match(/export const ENGINES = (\[[^\]]*\])/)[1];
  for (const e of ['jev', 'claude', 'rules']) assert.match(engines, new RegExp(`'${e}'`));
  assert.deepEqual(nodes.filter((n) => n.id.startsWith('eng-')).map((n) => n.id), ['eng-jev', 'eng-claude', 'eng-rules'], 'engines in fallback order');

  const mcp = read('src/mcp.js');
  const claimed = nodes.flatMap((n) => n.tools || []);
  assert.ok(claimed.length >= 40);
  assert.deepEqual(claimed.filter((t) => !new RegExp(`name: '${t}'`).test(mcp)), [], 'every tool listed under a family exists in src/mcp.js');
  assert.equal(new Set(claimed).size, claimed.length, 'a tool belongs to one family');

  // The loop and the steward are what planner.js / merge.js say they are.
  const planner = read('src/planner.js');
  for (const [k, re] of [['attempts per task', /export const MAX_ATTEMPTS = \d+/], ['nudges', /export const MAX_NUDGES = \d+/], ['revives', /export const MAX_REVIVES = \d+/]]) assert.match(planner, re, k);
  const ladder = read('src/autonomy.js').match(/DEFAULT_LADDER = \[([\s\S]*?)\];/)[1];
  assert.deepEqual([...ladder.matchAll(/model: '([^']+)', effort: '([^']+)'/g)].map((m) => `${m[1]} ${m[2]}`),
    ['claude-sonnet-5-5 medium', 'claude-opus-5-5 high', 'claude-opus-5-5 xhigh'], 'the ladder drawn (Sonnet medium → Opus high → Opus xhigh) is the configured one');
  const merge = read('src/merge.js');
  assert.ok(merge.indexOf("run(npm, ['run', 'build']") > 0 && merge.indexOf("run(npm, ['run', 'build']") < merge.indexOf("run(npm, ['test']"), 'build runs before tests');
  assert.match(merge, /merges ONE request at a time/, 'serial merging');
  assert.match(merge, /FORBIDDEN = \/\^\(node_modules\|ui\\\/dist[|)]/, 'the policy gate drawn is the forbidden-paths rule');
});

test('structure: connections() lists what is wired to a node, in and out', () => {
  const data = S.buildStructure();
  const c = S.connections(data, 'd-retry');
  assert.deepEqual(c.filter((x) => x.dir === 'out').map((x) => x.id).sort(), ['blocked', 'ladder']);
  assert.deepEqual(c.filter((x) => x.dir === 'in').map((x) => x.id).sort(), ['d-status', 'self-answer']);
  assert.equal(c.find((x) => x.id === 'ladder').label, 'yes');
  assert.deepEqual(S.connections(data, 'nope'), []);
  const live = { nodes: data.nodes, links: data.links.map((l) => ({ ...l, source: { id: l.source }, target: { id: l.target } })) };
  assert.equal(S.connections(live, 'd-retry').length, c.length, 'also after 3d-force-graph replaced the ids by node objects');
});

test('views: structure is the default, the choice is validated, the header says what is on screen', () => {
  assert.equal(M.DEFAULT_VIEW, 'structure');
  assert.deepEqual(M.VIEWS, ['structure', 'mesh']);
  assert.equal(M.normalizeView('mesh'), 'mesh');
  assert.equal(M.normalizeView('galaxy'), 'structure');
  assert.equal(M.normalizeView(null), 'structure');
  const s = M.summarizeStructure(S.buildStructure());
  assert.equal(s.lanes, 5);
  assert.ok(s.decisions >= 8);
  assert.match(s.text, /^\d+ nodes · \d+ links · 5 lanes · \d+ decisions$/);
  assert.equal(M.summarizeStructure(null).text, '0 nodes · 0 links');
  assert.deepEqual([S.STRUCTURE_FACTS.nodes, S.STRUCTURE_FACTS.links], [s.nodes, s.links]);
});

test('the window wires both views on the one graph module: palette switch, arrows, link labels, toggle, detail card', () => {
  const g = read('ui/src/graphify.js');
  assert.match(g, /graph\.setTypes\(view === 'structure' \? S_TYPES : deps\.types\)/, 'the palette follows the view');
  assert.match(g, /aria-pressed/, 'the toggle is a pressed-state button group');
  assert.match(g, /'aria-label': 'Jump to a node'/, 'every node can be opened without the canvas (keyboard, phone)');
  assert.match(g, /update\(\) \{ if \(active && view === 'mesh'\) draw\(\); \}/, 'the structure does not redraw with the mesh');
  assert.match(g, /localStorage/, 'the chosen view is remembered');
  assert.match(read('ui/src/main.js'), /createGraphify\(\$\('#graphify'\), \{ createGraph, types: TYPES,/);
  const gr = read('ui/src/graph.js');
  assert.match(gr, /setTypes\(types\)/);
  assert.match(gr, /linkDirectionalArrowLength\(\(l\) => \(l\.arrow \? 4 : 0\)\)/, 'directed links get arrowheads');
  assert.match(gr, /linkLabel\(/);
  assert.match(gr, /state\.types\[n\.type\]/, 'the galaxy keeps TYPES as the default palette');
  const css = read('ui/src/styles.css');
  assert.match(css, /\.gfy-detail\[hidden\] \{ display: none; \}/);
  assert.match(css, /#graphify\[data-view=mesh\] \.gfy-legend/);
  assert.match(g, /canvas\.dataset\.lod = px >= 85 \? 'near' : px >= 44 \? 'mid' : 'far'/, 'labels thin out with the zoom');
  assert.match(css, /\.gfy-canvas\[data-lod=far\] \.nlabel:not\(\.t-s-lane\)/, 'zoomed out only the lane titles stay');
  assert.match(g, /\.filter\(Boolean\)\); \/\/ replaceChildren turns a null/, 'no "null" text in the card');
  assert.match(css, /\.gfy-detail \{ z-index: 5;/, 'the card sits above the node labels');
  assert.match(css, /\.gfy-canvas \{ position: absolute; inset: 0; z-index: 0;/, 'whose labels are confined to the canvas stacking context');
});
