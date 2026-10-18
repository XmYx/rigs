// Dock layout engine (ui/src/dock-layout.js): pure tree operations, hide/restore exactness, normalisation
// under random operation sequences, drop zones, the smart-scale fit solver across phone → 4K viewports,
// persistence with the 'rigs.panels' migration, and the command API. No browser, no DOM.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { test } from 'node:test';

const D = await import('../ui/src/dock-layout.js');

const leaf = (id) => ({ type: 'panel', id });
const tabs = (panels, active = panels[0]) => ({ type: 'tabs', panels, active });
const split = (dir, children, ratios = children.map(() => 1 / children.length)) => ({ type: 'split', dir, ratios, children });
const withRoot = (root, extra = {}) => ({ ...D.emptyLayout(), root, ...extra });

/** Deterministic PRNG so failures reproduce. */
function rng(seed) {
  let s = seed >>> 0;
  return () => { s = (s + 0x6d2b79f5) >>> 0; let t = s; t = Math.imul(t ^ (t >>> 15), t | 1); t ^= t + Math.imul(t ^ (t >>> 7), t | 61); return ((t ^ (t >>> 14)) >>> 0) / 4294967296; };
}

/** Throws if a layout breaks an invariant: normalised tree, ratios sum to 1, each id in one place. */
function checkInvariants(layout) {
  const ids = [];
  const walk = (n) => {
    if (n.type === 'panel') { ids.push(n.id); return; }
    if (n.type === 'tabs') {
      assert.ok(n.panels.length >= 2, `tab group with ${n.panels.length} panel(s)`);
      assert.ok(n.panels.includes(n.active), 'active tab not in group');
      ids.push(...n.panels);
      return;
    }
    assert.equal(n.type, 'split');
    assert.ok(n.children.length >= 2, 'single-child split');
    assert.equal(n.ratios.length, n.children.length);
    assert.ok(n.ratios.every((r) => r > 0), 'non-positive ratio');
    assert.ok(Math.abs(n.ratios.reduce((a, b) => a + b, 0) - 1) < 1e-9, 'ratios do not sum to 1');
    n.children.forEach(walk);
  };
  if (layout.root) walk(layout.root);
  ids.push(...layout.floating.map((f) => f.id), ...Object.keys(layout.hidden));
  assert.equal(new Set(ids).size, ids.length, `panel listed twice: ${ids.join(',')}`);
}

/** Deep equality with a tolerance for floating-point ratios. */
function approxEqual(a, b, path = '') {
  if (typeof a === 'number' && typeof b === 'number') { assert.ok(Math.abs(a - b) < 1e-9, `${path}: ${a} vs ${b}`); return; }
  if (Array.isArray(a)) { assert.ok(Array.isArray(b) && a.length === b.length, `${path}: array length`); a.forEach((v, i) => approxEqual(v, b[i], `${path}[${i}]`)); return; }
  if (a && typeof a === 'object') {
    assert.ok(b && typeof b === 'object', `${path}: object`);
    assert.deepEqual(Object.keys(a).sort(), Object.keys(b).sort(), `${path}: keys`);
    for (const k of Object.keys(a)) approxEqual(a[k], b[k], `${path}.${k}`);
    return;
  }
  assert.equal(a, b, path);
}

test('the module touches no DOM and imports nothing', () => {
  const src = fs.readFileSync(new URL('../ui/src/dock-layout.js', import.meta.url), 'utf8');
  const code = src.replace(/\/\/.*$/gm, '').replace(/\/\*[\s\S]*?\*\//g, '');
  assert.doesNotMatch(code, /\b(document|window|localStorage|sessionStorage|navigator|HTMLElement|requestAnimationFrame)\b/);
  assert.doesNotMatch(code, /^\s*import\b/m);
  for (const name of ['dock', 'undock', 'moveTab', 'reorder', 'setActiveTab', 'resizeSplit', 'hide', 'restore', 'removePanel', 'normalize',
    'serialize', 'deserialize', 'migrateLegacy', 'dropZoneAt', 'solveFit', 'dockPanel', 'floatPanel', 'hidePanel', 'restorePanel', 'resetLayout', 'listPanels']) {
    assert.equal(typeof D[name], 'function', name);
  }
});

test('dock: edges split the target, center makes tabs, same-direction parents get a sibling', () => {
  let l = withRoot(leaf('a'));
  l = D.dock(l, 'b', 'a', 'right');
  approxEqual(l.root, split('row', [leaf('a'), leaf('b')], [0.5, 0.5]));
  l = D.dock(l, 'c', 'b', 'right'); // same direction: b's half is split, no nesting
  approxEqual(l.root, split('row', [leaf('a'), leaf('b'), leaf('c')], [0.5, 0.25, 0.25]));
  l = D.dock(l, 'd', 'a', 'bottom', { share: 0.4 });
  approxEqual(l.root.children[0], split('column', [leaf('a'), leaf('d')], [0.6, 0.4]));
  l = D.dock(l, 'e', 'c', 'center');
  approxEqual(l.root.children[2], tabs(['c', 'e'], 'e'));
  l = D.dock(l, 'f', 'e', 'tab'); // 'tab' is an alias of center, joins the existing group
  approxEqual(l.root.children[2], tabs(['c', 'e', 'f'], 'f'));
  l = D.dock(l, 'g', 'root', 'left');
  assert.equal(l.root.dir, 'row');
  assert.deepEqual(l.root.children[0], leaf('g'));
  approxEqual(l.root.ratios, [0.3, 0.7]);
  checkInvariants(l);
  // Docking into an empty layout makes the panel the root; docking a floating panel takes it off the float layer.
  let m = D.undock(D.emptyLayout(), 'x', { x: 10, y: 10, w: 200, h: 100 });
  m = D.dock(m, 'x', 'root', 'right');
  assert.deepEqual(m.root, leaf('x'));
  assert.equal(m.floating.length, 0);
  // Bad zone or self target: unchanged
  assert.equal(D.dock(l, 'a', 'a', 'left'), l);
  assert.equal(D.dock(l, 'z', 'a', 'middle'), l);
});

test('operations never mutate their input', () => {
  const l = withRoot(split('row', [leaf('a'), tabs(['b', 'c'])]), { floating: [{ id: 'f', x: 1, y: 2, w: 300, h: 200, z: 1, vw: null, vh: null }] });
  const before = JSON.stringify(l);
  D.dock(l, 'f', 'a', 'top');
  D.undock(l, 'b', { x: 5, y: 5, w: 100, h: 100 });
  D.hide(l, 'c');
  D.moveTab(l, 'a', 'b', 0);
  D.reorder(l, 'c', 0);
  D.resizeSplit(l, [], [0.7, 0.3]);
  D.removePanel(l, 'a');
  assert.equal(JSON.stringify(l), before);
});

test('undock, moveTab, reorder, setActiveTab, resizeSplit', () => {
  let l = withRoot(split('row', [leaf('a'), tabs(['b', 'c', 'd'], 'c')], [0.4, 0.6]));
  l = D.setActiveTab(l, 'd');
  assert.equal(l.root.children[1].active, 'd');
  l = D.reorder(l, 'd', 0);
  assert.deepEqual(l.root.children[1].panels, ['d', 'b', 'c']);
  l = D.moveTab(l, 'a', 'b', 1); // a leaves its leaf (split collapses) and joins the group at index 1
  approxEqual(l.root, tabs(['d', 'a', 'b', 'c'], 'a'));
  l = D.undock(l, 'b', { x: 40, y: 50, w: 320, h: 240, vw: 1920, vh: 1080 });
  approxEqual(l.root, tabs(['d', 'a', 'c'], 'a'));
  assert.deepEqual(l.floating, [{ id: 'b', x: 40, y: 50, w: 320, h: 240, vw: 1920, vh: 1080, z: 1 }]);
  l = D.undock(l, 'c', { x: 0, y: 0, w: 100, h: 100 });
  assert.equal(l.floating.find((f) => f.id === 'c').z, 2, 'newly floated panel goes on top');
  l = D.raise(l, 'b');
  assert.equal(l.floating.find((f) => f.id === 'b').z, 3);
  l = D.setFloatingRect(l, 'b', { x: 99 });
  assert.equal(l.floating.find((f) => f.id === 'b').x, 99);
  assert.equal(l.floating.find((f) => f.id === 'b').w, 320);

  let s = withRoot(split('row', [leaf('a'), leaf('b'), leaf('c')]));
  s = D.reorder(s, 'a', 2);
  assert.deepEqual(D.panelsIn(s.root), ['b', 'c', 'a']);
  s = D.resizeSplit(s, [], [2, 1, 1]);
  approxEqual(s.root.ratios, [0.5, 0.25, 0.25]);
  s = D.resizeSplit(s, [], [1, 0, -3]); // nothing collapses to zero
  assert.ok(s.root.ratios.every((r) => r >= 0.019));
  assert.equal(D.resizeSplit(s, [], [1, 1]), s, 'wrong ratio count is ignored');
  assert.equal(D.resizeSplit(s, [0], [1, 1]), s, 'path that is not a split is ignored');
});

test('hide then restore puts a panel back exactly where it was', () => {
  const cases = [
    withRoot(leaf('a')), // the only panel
    withRoot(split('row', [leaf('a'), leaf('b')], [0.3, 0.7])), // split collapses on hide
    withRoot(split('row', [leaf('a'), leaf('b'), leaf('c')], [0.2, 0.3, 0.5])), // 3-way split keeps its shares
    withRoot(split('row', [leaf('a'), split('column', [leaf('b'), leaf('c')], [0.65, 0.35])], [0.25, 0.75])),
    withRoot(split('column', [split('column', [leaf('a'), leaf('b')], [0.4, 0.6]), leaf('c')], [0.5, 0.5])), // nested same-direction split
    withRoot(split('row', [tabs(['a', 'b'], 'b'), leaf('c')], [0.6, 0.4])), // two tabs collapse to a panel
    withRoot(split('row', [tabs(['a', 'b', 'c'], 'a'), leaf('d')], [0.6, 0.4])),
    withRoot(split('row', [leaf('d'), leaf('e')]), { floating: [{ id: 'a', x: 12, y: 34, w: 420, h: 300, z: 3, vw: 1920, vh: 1080 }, { id: 'b', x: 1, y: 2, w: 3, h: 4, z: 5, vw: null, vh: null }] }),
  ];
  for (const l of cases) {
    const ids = D.listLayoutPanels(l).map((p) => p.id);
    for (const id of ids) {
      const hidden = D.hide(l, id);
      checkInvariants(hidden);
      assert.equal(D.panelStatus(hidden, id), 'hidden');
      const back = D.restore(hidden, id);
      checkInvariants(back);
      approxEqual(back.root, l.root, `restore ${id} tree`);
      const f0 = l.floating.find((f) => f.id === id);
      if (f0) {
        const f1 = back.floating.find((f) => f.id === id);
        const { z: _a, ...r0 } = f0;
        const { z: _b, ...r1 } = f1;
        assert.deepEqual(r1, r0, `restore ${id} floating rect`);
      }
    }
  }
});

test('restore still finds its place after other panels moved, and falls back sensibly', () => {
  // Hide c, then move a away: c goes back next to b (its recorded neighbour), at its old share.
  let l = withRoot(split('row', [leaf('a'), leaf('b'), leaf('c')], [0.2, 0.3, 0.5]));
  l = D.hide(l, 'c');
  l = D.undock(l, 'a', { x: 0, y: 0, w: 100, h: 100 });
  l = D.restore(l, 'c');
  approxEqual(l.root, split('row', [leaf('b'), leaf('c')], [0.5, 0.5]));
  // Hide two panels, restore in either order: both come back, tree stays valid.
  const base = withRoot(split('row', [leaf('a'), split('column', [leaf('b'), leaf('c')]), leaf('d')]));
  for (const order of [['b', 'c'], ['c', 'b']]) {
    let m = D.hide(D.hide(base, 'b'), 'c');
    for (const id of order) { m = D.restore(m, id); checkInvariants(m); }
    assert.deepEqual(new Set(D.panelsIn(m.root)), new Set(['a', 'b', 'c', 'd']));
  }
  // Every neighbour gone: the panel docks at the root edge rather than disappearing.
  let n = withRoot(split('row', [leaf('a'), leaf('b')]));
  n = D.hide(n, 'a');
  n = D.removePanel(n, 'b');
  n = D.restore(n, 'a');
  assert.deepEqual(n.root, leaf('a'));
  assert.equal(D.restore(n, 'a'), n, 'restoring a visible panel is a no-op');
  assert.equal(D.hide(n, 'nope'), n, 'hiding an unknown panel is a no-op');
});

test('tree stays normalised after random dock / undock / hide / restore / remove sequences', () => {
  const ids = ['left', 'legend', 'topbar', 'orb', 'dock', 'work', 'questions', 'usage', 'desktops', 'traces', 'agents', 'bar'];
  const zones = ['left', 'right', 'top', 'bottom', 'center', 'tab'];
  for (let seed = 1; seed <= 60; seed++) {
    const r = rng(seed);
    const pick = (a) => a[Math.floor(r() * a.length)];
    let l = D.ensurePanels(D.emptyLayout(), ids);
    for (let step = 0; step < 150; step++) {
      const id = pick(ids);
      const other = pick(ids);
      const op = Math.floor(r() * 10);
      if (op <= 2) l = D.dock(l, id, r() < 0.15 ? 'root' : other, pick(zones), { share: 0.1 + r() * 0.8 });
      else if (op === 3) l = D.undock(l, id, { x: r() * 1000, y: r() * 600, w: 200 + r() * 300, h: 100 + r() * 300 });
      else if (op === 4) l = D.hide(l, id);
      else if (op === 5) l = D.restore(l, id);
      else if (op === 6) l = D.moveTab(l, id, other, Math.floor(r() * 4));
      else if (op === 7) l = D.reorder(l, id, Math.floor(r() * 4));
      else if (op === 8) { const p = D.pathOf(l, id); if (p?.length) l = D.resizeSplit(l, p.slice(0, -1), D.nodeAt(l, p.slice(0, -1)).ratios.map(() => r())); }
      else if (r() < 0.2) { l = D.removePanel(l, id); l = D.ensurePanels(l, [id]); }
      try { checkInvariants(l); } catch (e) { e.message += ` (seed ${seed}, step ${step}, op ${op} ${id}→${other})`; throw e; }
      // Every panel is still somewhere.
      assert.deepEqual(new Set(D.listLayoutPanels(l).map((p) => p.id)), new Set(ids), `lost a panel (seed ${seed}, step ${step})`);
      // Hiding anything and restoring it straight away is exact, whatever the tree looks like.
      if (step % 5 === 0) {
        const t = pick(ids);
        if (D.panelStatus(l, t) === 'docked') approxEqual(D.restore(D.hide(l, t), t).root, l.root, `seed ${seed} step ${step} hide/restore ${t}`);
      }
    }
  }
});

test('normalize collapses empty tabs, one-tab groups and single-child splits', () => {
  assert.equal(D.normalize(tabs([])), null);
  assert.deepEqual(D.normalize(tabs(['a'])), leaf('a'));
  assert.deepEqual(D.normalize(split('row', [tabs([]), split('column', [leaf('a')])])), leaf('a'));
  approxEqual(D.normalize(split('row', [leaf('a'), leaf('b')], [3, 1])).ratios, [0.75, 0.25]);
  approxEqual(D.normalize(split('row', [leaf('a'), leaf('b')], [0, 'x'])).ratios, [0.5, 0.5]);
  assert.equal(D.normalize(tabs(['a', 'b'], 'zzz')).active, 'a');
});

test('dropZoneAt returns the five zones', () => {
  const r = { x: 100, y: 100, w: 200, h: 100 };
  assert.equal(D.dropZoneAt(r, { x: 200, y: 150 }), 'center');
  assert.equal(D.dropZoneAt(r, { x: 105, y: 150 }), 'left');
  assert.equal(D.dropZoneAt(r, { x: 295, y: 150 }), 'right');
  assert.equal(D.dropZoneAt(r, { x: 200, y: 102 }), 'top');
  assert.equal(D.dropZoneAt(r, { x: 200, y: 198 }), 'bottom');
  assert.equal(D.dropZoneAt(r, { x: 50, y: 150 }), null);
  assert.equal(D.dropZoneAt({ left: 0, top: 0, width: 100, height: 100 }, { x: 50, y: 50 }), 'center', 'DOMRect-like input');
  assert.equal(D.dropZoneAt(r, { x: 200, y: 140 }, { edge: 0.6 }), 'top', 'edge fraction is tunable');
  assert.equal(D.dropZoneAt({ x: 0, y: 0, w: 0, h: 10 }, { x: 0, y: 5 }), null);
});

// A realistic JARVIS layout placed on a 1920×1080 screen.
const HOME = { w: 1920, h: 1080 };
const homeFloating = () => [
  { id: 'left', x: 12, y: 12, w: 320, h: 900, z: 1 },
  { id: 'legend', x: 1600, y: 12, w: 300, h: 260, z: 2 },
  { id: 'topbar', x: 760, y: 8, w: 400, h: 44, z: 3 },
  { id: 'orb', x: 860, y: 360, w: 200, h: 240, z: 4 },
  { id: 'dock', x: 600, y: 760, w: 720, h: 220, z: 5 },
  { id: 'work', x: 1500, y: 300, w: 400, h: 520, z: 6 },
  { id: 'bar', x: 560, y: 1000, w: 800, h: 64, z: 7 },
  { id: 'wide', x: -40, y: 400, w: 2100, h: 120, z: 8 }, // already wider than the screen
].map((f) => ({ ...f, vw: HOME.w, vh: HOME.h }));
const MINS = { left: { w: 220, h: 160 }, legend: { w: 180, h: 120 }, topbar: { w: 260, h: 40 }, orb: { w: 120, h: 140 }, dock: { w: 280, h: 120 }, work: { w: 260, h: 200 }, bar: { w: 300, h: 56 }, wide: { w: 300, h: 80 } };

function viewports() {
  const out = [];
  for (let i = 0; i <= 40; i++) { const t = i / 40; out.push({ w: Math.round(390 + t * (3840 - 390)), h: Math.round(844 + t * (2160 - 844)) }); }
  for (const w of [390, 412, 768, 1024, 1280, 1440, 1920, 2560, 3840]) for (const h of [600, 844, 900, 1080, 1440, 2160]) out.push({ w, h });
  return out;
}

function assertOnScreen(res, vp, label) {
  const eps = 1e-6;
  const all = [...res.floating.filter((f) => f.x !== null), ...Object.entries(res.docked).map(([id, r]) => ({ id, ...r }))];
  for (const r of all) {
    assert.ok(r.x >= -eps && r.y >= -eps && r.x + r.w <= vp.w + eps && r.y + r.h <= vp.h + eps,
      `${label}: ${r.id} off screen at ${vp.w}x${vp.h}: ${JSON.stringify({ x: r.x, y: r.y, w: r.w, h: r.h })}`);
    assert.ok(r.w > 0 && r.h > 0, `${label}: ${r.id} has no size`);
  }
}

/** Pairwise order of centres per axis; ties count as compatible with either order. */
function assertSameOrder(a, b, label, tol = 1e-6) {
  for (const axis of ['x', 'y']) {
    const len = axis === 'x' ? 'w' : 'h';
    const c = (f) => f[axis] + f[len] / 2;
    for (let i = 0; i < a.length; i++) {
      for (let j = i + 1; j < a.length; j++) {
        const d0 = c(a[i]) - c(a[j]);
        const d1 = c(b[i]) - c(b[j]);
        if (Math.abs(d0) <= tol || Math.abs(d1) <= tol) continue;
        assert.equal(Math.sign(d0), Math.sign(d1), `${label}: ${a[i].id}/${a[j].id} swapped on ${axis}`);
      }
    }
  }
  assert.deepEqual(a.map((f) => f.z), b.map((f) => f.z), `${label}: z order changed`);
}

test('fit solver: every visible panel on screen from 390x844 to 3840x2160', () => {
  const root = split('row', [leaf('left'), split('column', [leaf('work'), tabs(['usage', 'traces'])], [0.6, 0.4])], [0.25, 0.75]);
  for (const vp of viewports()) {
    assertOnScreen(D.solveFit({ viewport: vp, floating: homeFloating(), mins: MINS, mode: 'fit' }), vp, 'floating');
    assertOnScreen(D.solveFit({ viewport: vp, root, mins: MINS, mode: 'fit' }), vp, 'docked');
    assertOnScreen(D.solveFit({ viewport: vp, floating: homeFloating(), root, dockRect: { x: 0, y: 0, w: vp.w * 0.3, h: vp.h }, mins: MINS, mode: 'fit', margin: 8 }), vp, 'both');
  }
});

test('fit solver: small resizes (≤8px) never reorder panels or jump them', () => {
  for (const vp of viewports()) {
    const a = D.solveFit({ viewport: vp, floating: homeFloating(), mins: MINS }).floating;
    for (const [dw, dh] of [[1, 0], [0, 1], [8, 0], [0, 8], [-8, -8], [5, -3], [8, 8]]) {
      const vp2 = { w: vp.w + dw, h: vp.h + dh };
      const b = D.solveFit({ viewport: vp2, floating: homeFloating(), mins: MINS }).floating;
      assertSameOrder(a, b, `${vp.w}x${vp.h} → ${vp2.w}x${vp2.h}`);
      for (let i = 0; i < a.length; i++) {
        const move = Math.max(Math.abs(a[i].x - b[i].x), Math.abs(a[i].y - b[i].y), Math.abs(a[i].w - b[i].w), Math.abs(a[i].h - b[i].h));
        assert.ok(move <= 3 * Math.max(Math.abs(dw), Math.abs(dh)) + 1e-6, `${a[i].id} jumped ${move.toFixed(2)}px for a ${dw},${dh} resize at ${vp.w}x${vp.h}`);
      }
    }
  }
});

test('fit solver: random layouts stay on screen and keep their order across sweeps', () => {
  for (let seed = 1; seed <= 25; seed++) {
    const r = rng(seed * 7919);
    const ref = { w: 800 + Math.round(r() * 3000), h: 600 + Math.round(r() * 1500) };
    const n = 2 + Math.floor(r() * 8);
    const floating = [];
    const mins = {};
    for (let i = 0; i < n; i++) {
      const w = 100 + r() * ref.w * 0.6;
      const h = 60 + r() * ref.h * 0.6;
      floating.push({ id: `p${i}`, x: r() * (ref.w - w * 0.5), y: r() * (ref.h - h * 0.5), w, h, z: i + 1, vw: ref.w, vh: ref.h });
      mins[`p${i}`] = { w: 120 + r() * 200, h: 48 + r() * 150 };
    }
    let prev = null;
    for (let w = 390, h = 844; w <= 3840; w += 7, h = Math.round(844 + ((w - 390) / 3450) * 1316)) {
      const vp = { w, h };
      const res = D.solveFit({ viewport: vp, floating, mins });
      assertOnScreen(res, vp, `seed ${seed}`);
      if (prev) assertSameOrder(prev, res.floating, `seed ${seed} at ${w}x${h}`);
      prev = res.floating;
    }
  }
});

test('fit solver: home layout untouched at home, shrink before scale, scale only when minimums overflow', () => {
  const inside = homeFloating().filter((f) => f.id !== 'wide');
  const same = D.solveFit({ viewport: HOME, floating: inside, mins: MINS });
  assert.equal(same.scale, 1);
  approxEqual(same.floating, inside);
  // Off mode: rects as given, even off screen.
  const off = D.solveFit({ viewport: { w: 390, h: 844 }, floating: homeFloating(), mins: MINS, mode: 'off' });
  assert.equal(off.scale, 1);
  approxEqual(off.floating, homeFloating());
  // A panel wider than the screen whose minimum fits: it shrinks, nothing scales.
  const shrink = D.solveFit({ viewport: { w: 1000, h: 800 }, floating: [{ id: 'w', x: 0, y: 0, w: 1500, h: 300, z: 1 }], mins: { w: { w: 400, h: 100 } } });
  assert.equal(shrink.scale, 1);
  assert.equal(shrink.floating[0].w, 1000);
  // Minimum wider than the screen: one shared scale factor, panel fills exactly its scaled minimum.
  const scaled = D.solveFit({ viewport: { w: 390, h: 844 }, floating: [{ id: 'w', x: 0, y: 0, w: 900, h: 300, z: 1 }], mins: { w: { w: 780, h: 100 } } });
  assert.ok(Math.abs(scaled.scale - 0.5) < 1e-9);
  assert.ok(Math.abs(scaled.floating[0].w - 390) < 1e-9);
  // Docked minimums wider than the screen scale the docked tree too.
  const dockedScaled = D.solveFit({ viewport: { w: 390, h: 844 }, root: split('row', [leaf('a'), leaf('b'), leaf('c')]), mins: { a: { w: 260, h: 100 }, b: { w: 260, h: 100 }, c: { w: 260, h: 100 } } });
  assert.ok(Math.abs(dockedScaled.scale - 0.5) < 1e-9);
  // Panels without a rect (CSS default place) pass through untouched.
  const pass = D.solveFit({ viewport: { w: 390, h: 844 }, floating: [{ id: 'n', x: null, y: null, w: null, h: null, z: 1 }] });
  assert.deepEqual(pass.floating, [{ id: 'n', x: null, y: null, w: null, h: null, z: 1 }]);
});

test('layoutTree honours ratios and per-panel minimums', () => {
  const root = split('row', [leaf('a'), leaf('b')], [0.1, 0.9]);
  const r = D.layoutTree(root, { x: 0, y: 0, w: 1000, h: 500 }, { a: { w: 300, h: 10 } });
  assert.equal(r.a.w, 300);
  assert.equal(r.b.w, 700);
  assert.equal(r.b.x, 300);
  const t = D.layoutTree(tabs(['x', 'y']), { x: 5, y: 6, w: 7, h: 8 });
  assert.deepEqual(t.x, t.y);
  assert.deepEqual(D.minSizeOf(split('column', [leaf('a'), leaf('b')]), { a: { w: 300, h: 100 } }), { w: 300, h: 148 });
});

test('serialize / deserialize round-trips and rejects junk', () => {
  let l = withRoot(split('row', [leaf('a'), tabs(['b', 'c'], 'c')], [0.3, 0.7]));
  l = D.undock(l, 'd', { x: 1, y: 2, w: 300, h: 200, vw: 1920, vh: 1080 });
  l = D.hide(l, 'b');
  l = D.setCollapsed(l, 'a', true);
  const s = D.serialize(l);
  assert.equal(JSON.parse(s).version, D.VERSION);
  assert.deepEqual(D.deserialize(s), l);
  assert.deepEqual(D.deserialize(JSON.parse(s)), l);
  assert.deepEqual(D.restore(D.deserialize(s), 'b').root, D.restore(l, 'b').root, 'hidden place survives storage');
  for (const junk of ['{nope', 'null', '[]', 42, null, undefined, JSON.stringify({ version: 99, root: leaf('a') })]) {
    assert.deepEqual(D.deserialize(junk), D.emptyLayout(), String(junk));
  }
  // Duplicate ids keep only their first place; broken nodes are dropped; result is normalised.
  const messy = D.deserialize({ version: 1, root: split('row', [leaf('a'), tabs(['a', 'b']), { type: 'weird' }, split('column', [leaf('c')])]), floating: [{ id: 'b', x: 0, y: 0, w: 1, h: 1, z: 1 }, { id: 'e', x: 'x' }], hidden: { c: { kind: 'float', rect: {} }, f: { kind: 'bogus' }, g: { kind: 'split', anchors: ['a', 3] } }, collapsed: ['a', 'zz'] });
  checkInvariants(messy);
  approxEqual(messy.root, split('row', [leaf('a'), leaf('b'), leaf('c')]));
  assert.deepEqual(messy.floating.map((f) => f.id), ['e']);
  assert.deepEqual(messy.floating[0].x, null);
  assert.deepEqual(Object.keys(messy.hidden), ['g']);
  assert.deepEqual(messy.hidden.g.anchors, ['a']);
  assert.deepEqual(messy.collapsed, ['a']);
});

test("migration from 'rigs.panels' keeps current users' layout", () => {
  // The shape panels.js writes today.
  const legacy = {
    left: { closed: false, collapsed: true, pos: { left: 24, top: 30, width: '340px', height: '700px' } },
    topbar: { closed: false, collapsed: false, pos: { left: 700, top: 8, width: null, height: null } },
    usage: { closed: true },
    work: { closed: true, collapsed: false, pos: { left: 1500, top: 300, width: '420px', height: null } },
    dock: { closed: false, collapsed: false },
    junk: 'x',
  };
  const l = D.deserialize(JSON.stringify(legacy), { viewport: { w: 1920, h: 1080 } });
  checkInvariants(l);
  assert.equal(l.version, 1);
  assert.equal(l.root, null, 'nothing was docked before');
  assert.deepEqual(l.floating.find((f) => f.id === 'left'), { id: 'left', x: 24, y: 30, w: 340, h: 700, vw: 1920, vh: 1080, z: 1 });
  assert.deepEqual(l.floating.find((f) => f.id === 'topbar'), { id: 'topbar', x: 700, y: 8, w: null, h: null, vw: 1920, vh: 1080, z: 2 });
  assert.deepEqual(l.floating.find((f) => f.id === 'dock'), { id: 'dock', x: null, y: null, w: null, h: null, vw: null, vh: null, z: 3 }, 'no saved position = CSS default place');
  assert.deepEqual(Object.keys(l.hidden).sort(), ['usage', 'work']);
  assert.deepEqual(l.hidden.work.rect, { x: 1500, y: 300, w: 420, h: null, vw: 1920, vh: 1080 });
  assert.deepEqual(l.collapsed, ['left']);
  // Restoring a panel that was closed in the old format brings it back at its old position.
  const back = D.restore(l, 'work');
  assert.equal(back.floating.find((f) => f.id === 'work').x, 1500);
  assert.equal(D.panelStatus(D.migrateLegacy(null), 'x'), null);
});

test('command API: load (with migration), dock / float / hide / restore / reset / list, persistence', () => {
  const store = new Map([['rigs.panels', JSON.stringify({ left: { closed: false, pos: { left: 10, top: 20, width: '300px', height: '500px' } }, usage: { closed: true } })]]);
  const storage = { getItem: (k) => store.get(k) ?? null, setItem: (k, v) => store.set(k, v) };
  const m = D.createDockManager();
  m.registerPanel('left', { title: 'Side panel' });
  m.registerPanel('usage', { title: 'Tokens & time' });
  m.registerPanel('work', { title: 'Active projects' });
  const seen = [];
  m.subscribe((_, cause) => seen.push(cause));
  m.attach({ storage, viewport: () => ({ w: 1280, h: 800 }) });
  assert.ok(store.has('rigs.dock'), 'saved in the new key');
  assert.ok(store.has('rigs.panels'), 'old key left alone');
  const byId = () => Object.fromEntries(m.listPanels().map((p) => [p.id, p]));
  assert.equal(byId().left.status, 'floating');
  assert.equal(byId().left.title, 'Side panel');
  assert.equal(byId().usage.status, 'hidden');
  assert.equal(byId().work.status, 'floating', 'a panel the old state never saw floats at its CSS place');

  m.dockPanel('left', 'root', 'left');
  m.dockPanel('work', 'left', 'right');
  assert.equal(byId().work.status, 'docked');
  const docked = JSON.stringify(m.getLayout().root);
  m.hidePanel('work');
  assert.equal(byId().work.status, 'hidden');
  m.restorePanel('work');
  assert.equal(JSON.stringify(m.getLayout().root), docked, 'restore puts it back where it was');
  m.floatPanel('work', { x: 5, y: 6, w: 300, h: 200 });
  assert.equal(byId().work.status, 'floating');
  m.togglePanel('usage');
  assert.equal(byId().usage.status, 'floating');

  // A fresh manager on the same storage sees the same layout.
  const m2 = D.createDockManager();
  m2.attach({ storage });
  assert.deepEqual(m2.getLayout(), m.getLayout());

  m.resetLayout();
  assert.deepEqual(m.listPanels().map((p) => p.status), ['floating', 'floating', 'floating']);
  assert.ok(seen.includes('load') && seen.includes('dock') && seen.includes('hide') && seen.includes('reset'));

  // Storage that throws (private mode) never breaks the commands.
  const bad = D.createDockManager({ storage: { getItem() { throw new Error('denied'); }, setItem() { throw new Error('denied'); } } });
  bad.attach();
  bad.registerPanel('a');
  bad.hidePanel('a');
  assert.equal(bad.listPanels()[0].status, 'hidden');

  // The shared manager and its function exports work without any storage.
  D.dockManager.registerPanel('solo', { title: 'Solo' });
  D.dockPanel('solo', 'root', 'right');
  assert.equal(D.listPanels().find((p) => p.id === 'solo').status, 'docked');
  D.hidePanel('solo');
  D.restorePanel('solo');
  assert.equal(D.listPanels().find((p) => p.id === 'solo').status, 'docked');
  D.floatPanel('solo', { x: 1, y: 1, w: 200, h: 100 });
  D.resetLayout();
  assert.equal(D.listPanels().find((p) => p.id === 'solo').status, 'floating');
});
