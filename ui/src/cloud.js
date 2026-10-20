// The cloud: the full-screen 3D mesh galaxy behind everything (graph.js on #graph), which can be hidden because it is
// the heaviest thing JARVIS draws. Hidden means gone, not covered: the graph is destroyed (render loop and simulation
// stopped, no requestAnimationFrame, renderer disposed, WebGL context released, canvas removed) and the page shows its
// plain background. Showing it again builds a fresh graph from the state kept here.
//
// createCloud returns the same API as createGraph, so main.js keeps one `graph` object either way. While the cloud is
// hidden that API still answers from the last data it was given (get, nodes, neighbors, focused — search, the
// inspector and the voice commands work without it) and remembers forces, display, filters, attention and focus to
// replay on show. Pure apart from the injected createGraph and the `el` class (tested in test/cloud.test.js).

/** Ids within `depth` hops of `id` over `links` (source/target as ids or as the node objects 3d-force-graph puts there). */
export function neighborIds(links, id, depth = 1) {
  const adj = new Map();
  for (const l of links) {
    const s = l.source?.id ?? l.source;
    const t = l.target?.id ?? l.target;
    if (!adj.has(s)) adj.set(s, new Set());
    if (!adj.has(t)) adj.set(t, new Set());
    adj.get(s).add(t);
    adj.get(t).add(s);
  }
  const seen = new Set([id]);
  let frontier = [id];
  for (let d = 0; d < depth; d++) {
    const next = [];
    for (const x of frontier) for (const y of adj.get(x) || []) if (!seen.has(y)) { seen.add(y); next.push(y); }
    frontier = next;
  }
  return seen;
}

/**
 * deps: { createGraph(el, { onSelect, onBackground }) → graph.js API, onSelect, onBackground, visible = true,
 * onChange(visible) }.
 */
export function createCloud(el, deps) {
  const { createGraph } = deps;
  let g = null;
  let visible = false;
  // What the next graph is built with.
  const kept = { data: { nodes: [], links: [] }, byId: new Map(), forces: {}, display: {}, hidden: [], types: null, attention: [], focus: null, depth: 1, paused: false };

  function build() {
    g = createGraph(el, { onSelect: (n) => deps.onSelect?.(n), onBackground: () => deps.onBackground?.() });
    if (kept.types) g.setTypes(kept.types);
    if (Object.keys(kept.forces).length) g.setForces(kept.forces);
    if (Object.keys(kept.display).length) g.setDisplay(kept.display);
    g.setHidden(kept.hidden);
    g.setData(kept.data);
    g.setAttention(kept.attention);
    if (kept.focus && g.get(kept.focus)) g.focus(kept.focus, kept.depth);
    if (kept.paused) g.pause();
  }

  const api = {
    get Graph() { return g?.Graph || null; },
    get visible() { return visible; },
    /** Build the galaxy (again). No-op while it is shown. */
    show() {
      if (visible) return;
      visible = true;
      el.classList?.remove('cloud-off');
      build();
      deps.onChange?.(true);
    },
    /** Destroy the galaxy: nothing of it renders, ticks or holds GPU memory until show(). */
    hide() {
      if (!visible) return;
      visible = false;
      if (g) {
        kept.focus = g.focused;
        kept.depth = g.depth || kept.depth;
        g.destroy();
        g = null;
      }
      el.classList?.add('cloud-off');
      deps.onChange?.(false);
    },
    setVisible(on) { if (on) api.show(); else api.hide(); },
    toggle() { api.setVisible(!visible); return visible; },

    setData(data) {
      kept.data = data;
      if (g) {
        g.setData(data);
        kept.byId = new Map(g.nodes().map((n) => [n.id, n]));
      } else {
        // graph.js keeps the old node objects (and their positions); without it, the latest snapshot's nodes are the truth.
        kept.byId = new Map(data.nodes.map((n) => [n.id, n]));
        if (kept.focus && !kept.byId.has(kept.focus)) kept.focus = null;
      }
    },
    get(id) { return g ? g.get(id) : kept.byId.get(id); },
    nodes() { return g ? g.nodes() : kept.data.nodes; },
    neighbors(id, depth = 1) { return g ? g.neighbors(id, depth) : [...neighborIds(kept.data.links, id, depth)].map((x) => kept.byId.get(x)).filter(Boolean); },
    setAttention(ids) { kept.attention = [...ids]; g?.setAttention(ids); },
    focus(id, depth = api.depth, distance = 0, lift = 0) {
      if (!api.get(id)) return;
      kept.focus = id;
      kept.depth = depth;
      g?.focus(id, depth, distance, lift);
    },
    setDepth(d) { if (api.focused) api.focus(api.focused, d); },
    clearFocus() { kept.focus = null; g?.clearFocus(); },
    fit() { kept.focus = null; g?.fit(); },
    setForces(f) { Object.assign(kept.forces, f); g?.setForces(f); },
    setDisplay(d) { Object.assign(kept.display, d); g?.setDisplay(d); },
    setHidden(types) { kept.hidden = [...types]; g?.setHidden(types); },
    setTypes(types) { kept.types = types; g?.setTypes(types); },
    pause() { kept.paused = true; g?.pause(); },
    resume() { kept.paused = false; g?.resume(); },
    resize() { g?.resize(); },
    nodeAt(x, y) { return g ? g.nodeAt(x, y) : null; },
    destroy() { api.hide(); },
    get focused() { return g ? g.focused : kept.focus; },
    get depth() { return g ? g.depth : kept.depth; },
  };
  // The first build is not a change: onChange fires only for show()/hide() afterwards.
  if (deps.visible !== false) { visible = true; build(); } else el.classList?.add('cloud-off');
  return api;
}

const ON = /^(?:show|open|turn on|switch on|enable|bring back|restore)$/;
/**
 * "hide the cloud", "show me the galaxy", "turn the cloud off", "toggle cloud" → false / true / 'toggle'; anything
 * else → null. ("app cloud" and "cloud apps" are the App Cloud, not this.)
 */
export function cloudCommand(text) {
  const t = String(text || '').trim().toLowerCase().replace(/[.!?]+$/, '');
  const what = '(?:the |my )?(?:cloud|galaxy|mesh galaxy|3d galaxy|mesh cloud)';
  let m = t.match(new RegExp(`^(hide|close|turn off|switch off|disable|kill|stop|show|open|turn on|switch on|enable|bring back|restore|toggle)(?: me)? ${what}$`));
  if (m) return m[1] === 'toggle' ? 'toggle' : ON.test(m[1]);
  m = t.match(new RegExp(`^(?:turn|switch|put) ${what} (on|off|back on)$`));
  if (m) return m[1] !== 'off';
  m = t.match(new RegExp(`^${what} (on|off)$`));
  if (m) return m[1] === 'on';
  return null;
}
