import { h } from './api.js';
import { GRAPHIFY_TITLE, VIEWS, VIEW_KEY, VIEW_LABEL, normalizeView, shouldRun, summarize, summarizeStructure } from './graphify-model.js';
import { GRID, LANES, S_LINKS, S_TYPES, buildStructure, connections } from './graphify-structure.js';

// The Graphify window, in two views of the same graph.js machinery (createGraph — one graph implementation for the
// galaxy, this window and the structure diagram):
//  · Structure (default) — how JARVIS itself is built and meant to work: tool surfaces, the pre-routing algorithm, the
//    project → agent pipeline, the completion loop, the merge steward, as pinned nodes and directed edges
//    (graphify-structure.js; each node is anchored to a source file + symbol and checked by test/graphify.test.js).
//    Clicking a node focuses its neighbours and opens a detail card (what it is, the rule it applies, where it lives).
//  · Mesh — the live mesh graph (machines, agents, tools, apps, rigs, projects, sessions) from buildGraph(visibleSnap()).
// It is a normal JARVIS panel (panels.js makeFloating, id 'graphify'): it opens from the Window / Tools menu or the 🕸
// button, floats, docks, closes and keeps its layout across a reload. The WebGL scene is created on first open and its
// render loop is paused while the window is closed or collapsed.

/**
 * `deps`: createGraph (graph.js), types (graph.js TYPES, the mesh palette), data() → { nodes, links } for the current mesh
 * snapshot, hidden() → mesh node types to hide, onSelect(node) when a mesh node is clicked, attention() → mesh node ids
 * that need the user.
 */
const DROP_AFTER_MS = 20000; // a closed or collapsed Graphify keeps its graph this long (quick reopen), then frees it

export function createGraphify(el, deps) {
  const store = {
    get() { try { return localStorage.getItem(VIEW_KEY); } catch { return null; } },
    set(v) { try { localStorage.setItem(VIEW_KEY, v); } catch { /* private window: the view just isn't remembered */ } },
  };
  let view = normalizeView(store.get());
  let structure = null; // the structure data of this activation (graph.js mutates what it is given)
  let graph = null;
  let active = false;
  let ro = null;
  let fitted = false;
  let touched = false;
  let shown = null; // id of the node the detail card describes

  const meta = h('span', { class: 'wk-meta' }, '');
  const head = h('div', { class: 'wk-head keep' }, h('span', { class: 'wk-title' }, GRAPHIFY_TITLE), meta);
  const canvas = h('div', { class: 'gfy-canvas', role: 'img' });
  const empty = h('div', { class: 'gfy-empty muted small' }, 'Waiting for the mesh…');
  const detail = h('div', { class: 'gfy-detail', role: 'region', 'aria-label': 'Node details', hidden: true });
  const fitBtn = h('button', { class: 'tb', title: 'Fit the whole graph', onclick: () => { hideDetail(); graph?.fit(); } }, '◎ Fit');
  const orbit = h('input', { type: 'checkbox', checked: view === 'mesh', onchange: () => graph?.setDisplay({ rotate: orbit.checked }) });
  const orbitLabel = h('label', { class: 'check gfy-orbit' }, orbit, ' orbit');
  const viewBtns = new Map(VIEWS.map((v) => [v, h('button', { class: 'tb gfy-view', type: 'button', 'aria-pressed': String(v === view), title: v === 'structure' ? 'How JARVIS is built and meant to work: tools, routing, projects, completion loop, merge steward' : 'The live mesh: machines, agents, tools, apps, sessions', onclick: () => setView(v) }, VIEW_LABEL[v])]));
  const outline = buildStructure().nodes.filter((n) => n.lane);
  const jump = h('select', { class: 'gfy-jump', 'aria-label': 'Jump to a node', onchange: () => { const n = graph?.get(jump.value); jump.value = ''; if (n && view === 'structure') pick(n); } },
    h('option', { value: '' }, 'Jump to…'),
    ...LANES.map((l) => h('optgroup', { label: l.label }, ...outline.filter((n) => n.lane === l.id).map((n) => h('option', { value: n.id }, n.name)))));
  const bar = h('div', { class: 'gfy-bar' }, h('div', { class: 'gfy-views', role: 'group', 'aria-label': 'View' }, ...viewBtns.values()), fitBtn, orbitLabel, jump);
  const legend = h('div', { class: 'gfy-legend', 'aria-hidden': 'true' },
    ...Object.values(S_TYPES).filter((t) => !t.hidden).map((t) => h('span', { class: 'gfy-lg' }, h('i', { style: { background: t.color } }), t.label)),
    ...Object.values(S_LINKS).map((t) => h('span', { class: 'gfy-lg' }, h('i', { class: 'ln', style: { background: t.color } }), t.label)));
  el.append(head, bar, legend, h('div', { class: 'gfy-stage' }, canvas, empty, detail));
  canvas.addEventListener('pointerdown', () => { touched = true; }, { passive: true });

  function hideDetail() {
    shown = null;
    detail.hidden = true;
    detail.replaceChildren();
    graph?.clearFocus();
  }

  /** A node of the structure view was chosen (click, tap or the jump list): light up its neighbours and describe it. */
  function pick(n) {
    if (n.type === 's-lane') return;
    shown = n.id;
    graph.focus(n.id, 1, 380, 62); // close enough to read the neighbours' labels, far enough to see them all; the node rides above the card
    const type = S_TYPES[n.type] || {};
    const conn = connections(structure, n.id);
    const row = (c) => h('button', { class: 'gfy-conn', type: 'button', onclick: () => { const x = graph.get(c.id); if (x) pick(x); } },
      h('span', { class: 'gfy-dir' }, c.dir === 'in' ? '←' : '→'), h('i', { class: 'ln', style: { background: S_LINKS[c.kind]?.color || '#3b5568' } }), h('span', {}, c.name), c.label ? h('em', {}, c.label) : null);
    detail.hidden = false;
    detail.replaceChildren(...[
      h('div', { class: 'gfy-d-head' }, h('i', { style: { background: type.color } }), h('b', {}, n.name), h('span', { class: 'chip' }, type.label || n.type),
        h('button', { class: 'tb gfy-d-x', type: 'button', 'aria-label': 'Close details', onclick: hideDetail }, '×')),
      h('p', { class: 'gfy-d-desc' }, n.desc || ''),
      n.src ? h('div', { class: 'gfy-d-src' }, h('code', {}, n.src), ' · ', h('code', {}, n.sym)) : null,
      n.tools?.length ? h('div', { class: 'gfy-d-tools' }, ...n.tools.map((t) => h('code', { class: 'chip' }, t))) : null,
      conn.length ? h('div', { class: 'gfy-d-conns' }, ...conn.map(row)) : null].filter(Boolean)); // replaceChildren turns a null into the text "null"
    detail.scrollTop = 0;
  }

  function drawMesh() {
    const data = deps.data();
    meta.textContent = summarize(data).text;
    empty.hidden = data.nodes.length > 1;
    graph.setData(data);
    graph.setHidden(deps.hidden?.() || []);
    graph.setAttention(deps.attention?.() || []);
    return data.nodes.length > 1;
  }

  function drawStructure() {
    if (!structure) structure = buildStructure();
    meta.textContent = summarizeStructure(structure).text;
    empty.hidden = true;
    graph.setData(structure);
    graph.setHidden([]);
    graph.setAttention([]);
    return true;
  }

  function draw() {
    if (!graph) return;
    const ready = view === 'structure' ? drawStructure() : drawMesh();
    if (!fitted && ready) { fitted = true; for (const ms of [view === 'structure' ? 900 : 1800, 5500]) setTimeout(() => { if (active && !touched && !shown) graph.fit(); }, ms); } // frame the whole graph in this window as the first layout settles, unless the user already took over
  }

  // Level of detail for the diagram: 66 labels cannot all be read at once. Zoomed out only the lane titles show, a little closer
  // the decisions, routes, agents and surfaces, close up every label (CSS: .gfy-canvas[data-lod]). The measure is the pixel width of one grid column.
  function lod() {
    if (!graph || view !== 'structure') { delete canvas.dataset.lod; return; }
    const a = graph.Graph.graph2ScreenCoords(0, 0, 0);
    const b = graph.Graph.graph2ScreenCoords(GRID.col, 0, 0);
    const px = Math.hypot(b.x - a.x, b.y - a.y);
    canvas.dataset.lod = px >= 85 ? 'near' : px >= 44 ? 'mid' : 'far';
  }
  let lodTimer = null;
  let dropTimer = null;
  function drop() {
    if (active || !graph) return;
    ro?.disconnect();
    ro = null;
    graph.destroy();
    graph = null;
    fitted = false;
    hideDetail();
  }

  function chrome() {
    for (const [v, b] of viewBtns) b.setAttribute('aria-pressed', String(v === view));
    el.dataset.view = view;
    canvas.setAttribute('aria-label', view === 'structure'
      ? 'Structure diagram of JARVIS — tool surfaces, routing, projects and agents, the completion loop and the merge steward. Use the Jump to list to open any node.'
      : 'Mesh graph — machines, agents, tools, apps and projects. The side panel lists the same nodes for keyboard use.');
  }

  function setView(v) {
    v = normalizeView(v);
    if (v === view) return;
    view = v;
    store.set(v);
    structure = null;
    fitted = false;
    touched = false;
    chrome();
    hideDetail();
    if (!graph) return;
    graph.setTypes(view === 'structure' ? S_TYPES : deps.types);
    orbit.checked = view === 'mesh'; // a diagram that is read stays still; the galaxy turns
    graph.setDisplay({ rotate: orbit.checked, linkOpacity: view === 'structure' ? 0.75 : 0.32 });
    if (active) draw();
  }

  function ensure() {
    if (graph) return;
    graph = deps.createGraph(canvas, { onSelect: (n) => { if (view === 'structure') pick(n); else deps.onSelect?.(n); }, onBackground: () => { if (view === 'structure') hideDetail(); } });
    graph.setTypes(view === 'structure' ? S_TYPES : deps.types);
    graph.setDisplay({ rotate: orbit.checked, linkOpacity: view === 'structure' ? 0.75 : 0.32 });
    ro = new ResizeObserver(() => graph.resize());
    ro.observe(canvas);
  }

  chrome();

  return {
    /** Called by makeFloating's onToggle and after layout restore: render only while open and expanded. */
    setActive(on) {
      active = !!on;
      if (active) {
        ensure();
        graph.resume();
        graph.resize();
        draw();
        lodTimer ||= setInterval(lod, 250);
        clearTimeout(dropTimer);
      } else {
        graph?.pause();
        clearInterval(lodTimer);
        lodTimer = null;
        // Closed for a while: free the graph itself (WebGL context, scene, listeners); opening builds a fresh one.
        clearTimeout(dropTimer);
        dropTimer = setTimeout(drop, DROP_AFTER_MS);
      }
    },
    /** New mesh snapshot (or filters changed): redraw if the window is showing the mesh. The structure does not change with it. */
    update() { if (active && view === 'mesh') draw(); },
    setView,
    get view() { return view; },
    get active() { return active; },
    shouldRun,
    destroy() { clearInterval(lodTimer); clearTimeout(dropTimer); drop(); },
  };
}
