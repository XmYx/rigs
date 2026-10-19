import { h } from './api.js';
import { GRAPHIFY_TITLE, shouldRun, summarize } from './graphify-model.js';

// The Graphify window: the mesh graph (graph.js — machines, agents, tools, apps, rigs, projects, sessions) in a
// panel of its own. It is a normal JARVIS panel (panels.js makeFloating, id 'graphify'): it opens from the Window /
// Tools menu or the 🕸 button, floats, docks beside or as a tab of other panels, closes, restores to the same place and
// keeps its layout across a reload. The same graph module and the same buildGraph() snapshot feed it as the
// full-screen galaxy; the WebGL scene is created on first open and its render loop is paused while the window is
// closed or collapsed. Clicking a node selects it in the galaxy and opens the side panel inspector.

/**
 * `deps`: createGraph (graph.js), data() → { nodes, links } for the current snapshot, hidden() → node types to hide,
 * onSelect(node) when a node is clicked, attention() → graph node ids that need the user.
 */
export function createGraphify(el, deps) {
  const meta = h('span', { class: 'wk-meta' }, '');
  const head = h('div', { class: 'wk-head keep' }, h('span', { class: 'wk-title' }, GRAPHIFY_TITLE), meta);
  const canvas = h('div', { class: 'gfy-canvas', role: 'img', 'aria-label': 'Mesh graph — machines, agents, tools, apps and projects. The side panel lists the same nodes for keyboard use.' });
  const empty = h('div', { class: 'gfy-empty muted small' }, 'Waiting for the mesh…');
  const fitBtn = h('button', { class: 'tb', title: 'Fit the whole graph', onclick: () => graph?.fit() }, '◎ Fit');
  const orbit = h('input', { type: 'checkbox', checked: true, onchange: () => graph?.setDisplay({ rotate: orbit.checked }) });
  const bar = h('div', { class: 'gfy-bar' }, fitBtn, h('label', { class: 'check gfy-orbit' }, orbit, ' orbit'));
  el.append(head, bar, h('div', { class: 'gfy-stage' }, canvas, empty));
  let graph = null;
  let active = false;
  let ro = null;
  let fitted = false;
  let touched = false;
  canvas.addEventListener('pointerdown', () => { touched = true; }, { passive: true });

  function draw() {
    if (!graph) return;
    const data = deps.data();
    meta.textContent = summarize(data).text;
    empty.hidden = data.nodes.length > 1;
    graph.setData(data);
    graph.setHidden(deps.hidden?.() || []);
    graph.setAttention(deps.attention?.() || []);
    if (!fitted && data.nodes.length > 1) { fitted = true; for (const ms of [1800, 5500]) setTimeout(() => { if (active && !touched) graph.fit(); }, ms); } // frame the whole graph in this window as the first layout settles, unless the user already took over
  }

  function ensure() {
    if (graph) return;
    graph = deps.createGraph(canvas, { onSelect: (n) => deps.onSelect?.(n), onBackground: () => {} });
    ro = new ResizeObserver(() => graph.resize());
    ro.observe(canvas);
  }

  return {
    /** Called by makeFloating's onToggle and after layout restore: render only while open and expanded. */
    setActive(on) {
      active = !!on;
      if (active) {
        ensure();
        graph.resume();
        graph.resize();
        draw();
      } else if (graph) graph.pause();
    },
    /** New mesh snapshot (or filters changed): redraw if the window is showing. */
    update() { if (active) draw(); },
    get active() { return active; },
    shouldRun,
    destroy() { ro?.disconnect(); },
  };
}
