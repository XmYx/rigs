// The hideable cloud (ui/src/cloud.js): hidden = the galaxy graph destroyed, its state kept and replayed on show.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { test } from 'node:test';
import { cloudCommand, createCloud, neighborIds } from '../ui/src/cloud.js';

/** A stand-in for graph.js createGraph that records calls. */
function fakeGraphs() {
  const made = [];
  const createGraph = (el, opts) => {
    const g = {
      opts, calls: [], destroyed: false, focusId: null, d: 1, data: { nodes: [], links: [] },
      setData(x) { this.calls.push(['setData', x.nodes.length]); this.data = x; },
      nodes() { return this.data.nodes; },
      get(id) { return this.data.nodes.find((n) => n.id === id); },
      neighbors(id) { return [this.get(id)]; },
      setAttention(a) { this.calls.push(['setAttention', [...a]]); },
      focus(id, depth) { this.focusId = id; this.d = depth; this.calls.push(['focus', id, depth]); },
      clearFocus() { this.focusId = null; }, fit() { this.focusId = null; this.calls.push(['fit']); },
      setForces(f) { this.calls.push(['setForces', f]); }, setDisplay(d) { this.calls.push(['setDisplay', d]); },
      setHidden(t) { this.calls.push(['setHidden', t]); }, setTypes(t) { this.calls.push(['setTypes', t]); },
      pause() { this.calls.push(['pause']); }, resume() { this.calls.push(['resume']); }, resize() {},
      nodeAt() { return 'hit'; }, destroy() { this.destroyed = true; },
      get focused() { return this.focusId; }, get depth() { return this.d; }, Graph: { real: true },
    };
    made.push(g);
    return g;
  };
  return { made, createGraph };
}
const el = () => { const cls = new Set(); return { cls, classList: { add: (c) => cls.add(c), remove: (c) => cls.delete(c) } }; };
const data = {
  nodes: [{ id: 'mesh', name: 'TAILNET' }, { id: 'm:a', name: 'mac' }, { id: 's:1', name: 'shell' }],
  links: [{ source: 'mesh', target: 'm:a' }, { source: { id: 'm:a' }, target: { id: 's:1' } }],
};

test('neighborIds walks links given as ids or node objects', () => {
  assert.deepEqual([...neighborIds(data.links, 'mesh', 1)].sort(), ['m:a', 'mesh']);
  assert.deepEqual([...neighborIds(data.links, 'mesh', 2)].sort(), ['m:a', 'mesh', 's:1']);
  assert.deepEqual([...neighborIds([], 'x', 3)], ['x']);
});

test('visible by default: one graph is built; hide destroys it and marks the element', () => {
  const { made, createGraph } = fakeGraphs();
  const changes = [];
  const e = el();
  const c = createCloud(e, { createGraph, onChange: (v) => changes.push(v) });
  assert.equal(made.length, 1);
  assert.equal(c.visible, true);
  assert.deepEqual(changes, [], 'the first build is not a change');
  assert.equal(c.Graph.real, true);
  c.hide();
  assert.equal(made[0].destroyed, true);
  assert.equal(c.visible, false);
  assert.equal(c.Graph, null);
  assert.ok(e.cls.has('cloud-off'));
  assert.deepEqual(changes, [false]);
  c.hide(); // idempotent
  assert.deepEqual(changes, [false]);
});

test('starting hidden builds nothing until show()', () => {
  const { made, createGraph } = fakeGraphs();
  const e = el();
  const c = createCloud(e, { createGraph, visible: false });
  assert.equal(made.length, 0);
  assert.ok(e.cls.has('cloud-off'));
  c.setData(data);
  c.show();
  assert.equal(made.length, 1);
  assert.ok(!e.cls.has('cloud-off'));
  assert.deepEqual(made[0].calls.find((x) => x[0] === 'setData'), ['setData', 3]);
});

test('while hidden the API answers from the kept data; show replays everything', () => {
  const { made, createGraph } = fakeGraphs();
  const c = createCloud(el(), { createGraph });
  c.setForces({ repel: 200 });
  c.setDisplay({ labels: false });
  c.hide();
  c.setData(data);
  c.setHidden(['session']);
  c.setAttention(new Set(['s:1']));
  c.setForces({ linkLength: 30 });
  c.setTypes({ x: 1 });
  assert.equal(c.get('m:a').name, 'mac');
  assert.equal(c.nodes().length, 3);
  assert.deepEqual(c.neighbors('m:a', 1).map((n) => n.id).sort(), ['m:a', 'mesh', 's:1']);
  assert.equal(c.nodeAt(1, 1), null);
  c.focus('m:a', 2);
  assert.equal(c.focused, 'm:a');
  assert.equal(c.depth, 2);
  c.focus('nope'); // unknown node: ignored
  assert.equal(c.focused, 'm:a');
  c.pause();
  c.show();
  const g = made[1];
  const names = g.calls.map((x) => x[0]);
  assert.deepEqual(names, ['setTypes', 'setForces', 'setDisplay', 'setHidden', 'setData', 'setAttention', 'focus', 'pause']);
  assert.deepEqual(g.calls[1][1], { repel: 200, linkLength: 30 });
  assert.deepEqual(g.calls[3][1], ['session']);
  assert.deepEqual(g.calls[5][1], ['s:1']);
  assert.deepEqual(g.calls[6], ['focus', 'm:a', 2]);
  assert.equal(c.nodeAt(1, 1), 'hit');
});

test('focus survives a hide/show round trip; a node that left the mesh while hidden drops it', () => {
  const { made, createGraph } = fakeGraphs();
  const c = createCloud(el(), { createGraph });
  c.setData(data);
  c.focus('s:1', 1);
  c.hide();
  assert.equal(c.focused, 's:1');
  c.setData({ nodes: data.nodes.slice(0, 2), links: data.links.slice(0, 1) });
  assert.equal(c.focused, null);
  c.show();
  assert.ok(!made[1].calls.some((x) => x[0] === 'focus'));
});

test('toggle / setVisible flip it and report it', () => {
  const { made, createGraph } = fakeGraphs();
  const c = createCloud(el(), { createGraph });
  assert.equal(c.toggle(), false);
  assert.equal(c.toggle(), true);
  c.setVisible(true);
  assert.equal(made.length, 2);
  assert.equal(made[0].destroyed, true);
  assert.equal(made[1].destroyed, false);
});

test('cloudCommand understands the spoken and typed forms, and leaves the App Cloud alone', () => {
  for (const t of ['hide the cloud', 'Hide the cloud.', 'close the galaxy', 'turn off the cloud', 'turn the cloud off', 'switch the galaxy off', 'cloud off', 'disable the mesh galaxy', 'stop the cloud']) assert.equal(cloudCommand(t), false, t);
  for (const t of ['show the cloud', 'show me the galaxy', 'bring back the cloud', 'turn the cloud on', 'turn the cloud back on', 'cloud on', 'enable the 3d galaxy', 'open my cloud']) assert.equal(cloudCommand(t), true, t);
  assert.equal(cloudCommand('toggle the cloud'), 'toggle');
  assert.equal(cloudCommand('toggle cloud'), 'toggle');
  for (const t of ['show the app cloud', 'app cloud', 'show my apps', 'open the cloud app', 'what is the cloud', '', null]) assert.equal(cloudCommand(t), null, String(t));
});

test('UI wiring: persisted toggle in Display, top bar pill, Window menu command, JARVIS command; graph.js really stops', () => {
  const read = (f) => fs.readFileSync(new URL(`../${f}`, import.meta.url), 'utf8');
  const html = read('ui/index.html');
  assert.match(html, /<input id="d-cloud" type="checkbox">/);
  assert.match(html, /id="cloud-toggle"/);
  const main = read('ui/src/main.js');
  assert.match(main, /createCloud\(\$\('#graph'\), \{\s*createGraph, visible: store\.get\('cloud', !lowPower\(\)\)/, 'persisted; low-power devices start without it');
  assert.match(main, /onChange: \(on\) => \{ store\.set\('cloud', on\)/);
  assert.match(main, /const cloudCmd = cloudCommand\(t\);/);
  assert.ok(main.indexOf('cloudCommand(t)') < main.indexOf("(?:apps|applets|app cloud)"), 'the cloud command is matched before the app matchers');
  const cmds = read('ui/src/jarvis-commands.js');
  assert.match(cmds, /id: 'view\.cloud'[\s\S]*checked: \(\) => !!deps\.cloud\?\.visible\(\), run: \(\) => deps\.cloud\.toggle\(\)/);
  assert.match(cmds, /\{ cmd: 'view\.cloud' \}/);
  const g = read('ui/src/graph.js');
  assert.match(g, /destroy\(\) \{/);
  assert.match(g, /Graph\._destructor\(\)/);
  assert.match(g, /gl\.forceContextLoss\(\)/);
  assert.match(g, /if \(dead \|\| paused \|\| asleep \|\| document\.hidden\) \{ looping = false; return; \}/, 'the decoration loop ends instead of polling');
  assert.doesNotMatch(g, /setTimeout\(\(\) => requestAnimationFrame\(loop\), 500\)/);
  assert.match(g, /for \(const off of offs\.splice\(0\)\)/, 'listeners on document/window/theme/power are removed');
  assert.match(read('ui/src/styles.css'), /#graph\.cloud-off \{/);
});
