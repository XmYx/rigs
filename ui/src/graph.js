import ForceGraph3D from '3d-force-graph';
import * as THREE from 'three';
import { UnrealBloomPass } from 'three/examples/jsm/postprocessing/UnrealBloomPass.js';
import { CSS2DObject, CSS2DRenderer } from 'three/examples/jsm/renderers/CSS2DRenderer.js';

// Node types — the legend on the right, like the "brain galaxy" in the reference video.
export const TYPES = {
  mesh: { label: 'Tailnet', color: '#e2e8f0' },
  machine: { label: 'Machines', color: '#2dd4bf' },
  agent: { label: 'Agents', color: '#f5c451' },
  skill: { label: 'Skills', color: '#c084fc' },
  model: { label: 'Models', color: '#818cf8' },
  project: { label: 'Projects', color: '#60a5fa' },
  session: { label: 'Sessions', color: '#4ade80' },
  live: { label: 'Live', color: '#f472b6' },
  chat: { label: 'Chats', color: '#fb923c' },
  rig: { label: 'Rigs', color: '#f87171' },
  tool: { label: 'Tools', color: '#22d3ee' },
  plan: { label: 'Plans', color: '#fde047' },
  task: { label: 'Tasks', color: '#a3e635' },
  offline: { label: 'Offline', color: '#475569' },
};

const AGENT_LABEL = { claude: 'Claude Code', codex: 'Codex', ollama: 'Ollama', rig: 'OpenRig', shell: 'Shell' };

/** Turn the mesh snapshot into graph nodes/links. */
export function buildGraph(snapshot) {
  const nodes = [];
  const links = [];
  const add = (n) => { nodes.push(n); return n; };
  const link = (source, target, kind = 'default') => links.push({ source, target, kind });
  add({ id: 'mesh', type: 'mesh', name: 'TAILNET', val: 30 });
  const projects = new Map();
  const skillRea = { id: 'skill:rea', type: 'skill', name: 'REA', val: 12, detail: 'Reverse Engineer Anything — MCP for every coding agent' };
  const skillRigs = { id: 'skill:rigs', type: 'skill', name: 'rigs MCP', val: 10, detail: 'Mesh tools for agents (mesh_* )' };
  let reaUsed = false;
  let rigsUsed = false;

  for (const entry of snapshot) {
    const m = entry.node;
    const mid = 'm:' + m.id;
    const up = m.online && m.rigs;
    add({ id: mid, type: up ? 'machine' : 'offline', name: m.name, val: 70, machine: m.id, data: m, platform: m.platform });
    link('mesh', mid, 'mesh');
    if (!up) continue;
    const t = m.tools || {};
    const agents = {};
    for (const a of ['claude', 'codex', 'ollama', 'rig']) {
      if (!t[a]) continue;
      agents[a] = add({ id: `a:${m.id}:${a}`, type: 'agent', name: AGENT_LABEL[a], agent: a, machine: m.id, val: 16, detail: t[a] });
      link(mid, agents[a].id, 'agent');
      if ((a === 'claude' || a === 'codex') && t.reaRegistered?.[a]) { link(agents[a].id, skillRea.id, 'skill'); reaUsed = true; }
      if ((a === 'claude' || a === 'codex') && t.rigsRegistered?.[a]) { link(agents[a].id, skillRigs.id, 'skill'); rigsUsed = true; }
    }
    for (const b of entry.brains || []) {
      if (b.id !== 'ollama' || !agents.ollama) continue;
      for (const model of b.models.slice(0, 12)) {
        const id = `o:${m.id}:${model}`;
        add({ id, type: 'model', name: model, machine: m.id, model, val: 5 });
        link(agents.ollama.id, id, 'model');
      }
    }
    for (const c of Object.values(m.capabilities || {})) {
      const id = `tool:${m.id}:${c.id}`;
      add({ id, type: 'tool', name: c.label, machine: m.id, tool: c, val: 9 });
      link(mid, id, 'tool');
    }
    const rigNodes = new Map();
    for (const r of entry.openrig?.rigs || []) {
      const id = `r:${m.id}:${r.name}`;
      rigNodes.set(r.name, add({ id, type: 'rig', name: r.name, machine: m.id, val: 10, data: r }));
      link(agents.rig?.id || mid, id, 'rig');
    }
    let count = 0;
    for (const s of entry.sessions || []) {
      if (count++ > 60) break;
      const id = `s:${m.id}:${s.kind}:${s.id}`;
      const type = s.kind === 'chat' ? 'chat' : s.live ? 'live' : 'session';
      add({ id, type, name: s.title, machine: m.id, session: s, val: s.live ? 5 : 2.2 });
      const parent = s.kind === 'rig' && rigNodes.get(s.rig) ? rigNodes.get(s.rig).id : agents[s.agent]?.id || mid;
      link(parent, id, s.live ? 'live' : 'session');
      // An SSH session bridges the two machines: draw it from the machine it came from.
      if (s.sshFrom) { const from = snapshot.find((e) => e.node.name === s.sshFrom); if (from) link(`m:${from.node.id}`, id, 'live'); }
      if (s.project && s.kind !== 'chat') {
        const key = s.project.toLowerCase();
        if (!projects.has(key)) projects.set(key, add({ id: 'p:' + key, type: 'project', name: s.project, val: 6, machines: new Set() }));
        const p = projects.get(key);
        p.machines.add(m.id);
        link(id, p.id, 'project');
      }
    }
  }
  // Plans and their tasks: each task hangs off its plan and points at the agent/machine it's delegated to.
  const machineByName = new Map(snapshot.map((e) => [e.node.name, e.node]));
  for (const entry of snapshot) {
    for (const pj of entry.projects || []) {
      if (pj.status === 'done' && Date.now() - pj.updatedAt > 3 * 86400000) continue;
      const pid = `pj:${pj.id}`;
      add({ id: pid, type: 'plan', name: pj.name, val: 14, plan: pj, owner: entry.node.id });
      link(`m:${entry.node.id}`, pid, 'plan');
      for (const t of pj.tasks) {
        const tid = `tk:${pj.id}:${t.id}`;
        add({ id: tid, type: 'task', name: `${t.id} ${t.title}`, val: t.status === 'running' ? 5 : 3, task: t, plan: pj, live: t.status === 'running' });
        link(pid, tid, 'plan');
        const target = t.assign && machineByName.get(t.assign.node);
        if (target) link(tid, target.id && ['claude', 'codex', 'ollama'].includes(t.assign.provider) ? `a:${target.id}:${t.assign.provider}` : `m:${target.id}`, t.status === 'running' ? 'live' : 'delegate');
      }
    }
  }
  // Drop links whose agent endpoint doesn't exist (e.g. provider not detected on that machine).
  const ids = new Set(nodes.map((n) => n.id).concat(reaUsed ? [skillRea.id] : [], rigsUsed ? [skillRigs.id] : []));
  for (let i = links.length - 1; i >= 0; i--) if (!ids.has(links[i].source) || !ids.has(links[i].target)) links.splice(i, 1);
  if (reaUsed) add(skillRea);
  if (rigsUsed) add(skillRigs);
  for (const p of projects.values()) { p.val = 5 + Math.min(16, p.machines.size * 4); p.machines = [...p.machines]; }
  return { nodes, links };
}

function labelFor(n) {
  if (n.type === 'session' || n.type === 'live' || n.type === 'chat' || n.type === 'model' || n.type === 'task') return null;
  return n.name;
}

export function createGraph(el, { onSelect, onBackground }) {
  const state = {
    byId: new Map(), focus: null, depth: 1, highlight: new Set(), hidden: new Set(), labels: true, particles: true, rotate: true,
    data: { nodes: [], links: [] }, hover: null,
  };

  // Labels are HTML (CSS2D) so they stay crisp and aren't smeared by the bloom pass.
  const labelRenderer = new CSS2DRenderer();
  labelRenderer.domElement.style.pointerEvents = 'none';
  const Graph = new ForceGraph3D(el, { controlType: 'orbit', extraRenderers: [labelRenderer] })
    .backgroundColor('#04060a')
    .showNavInfo(false)
    .nodeId('id')
    .nodeVal((n) => n.val)
    .nodeRelSize(2.6)
    .nodeOpacity(0.92)
    .nodeResolution(16)
    .nodeVisibility((n) => !state.hidden.has(n.type))
    .linkVisibility((l) => !state.hidden.has(l.source.type ?? '') && !state.hidden.has(l.target.type ?? ''))
    .nodeColor((n) => colorFor(n))
    .nodeLabel((n) => `<div class="tip"><b>${escapeHtml(n.name)}</b><span>${TYPES[n.type]?.label || n.type}${n.session ? ' · ' + escapeHtml(n.session.kind) : ''}</span></div>`)
    .linkColor((l) => linkColor(l))
    .linkOpacity(0.32)
    .linkWidth((l) => (isLit(l) ? 0.9 : l.kind === 'mesh' ? 0.6 : 0.15))
    .linkDirectionalParticles((l) => (state.particles && (l.kind === 'live' || l.kind === 'mesh') ? (l.kind === 'live' ? 3 : 2) : 0))
    .linkDirectionalParticleWidth((l) => (l.kind === 'mesh' ? 1.4 : 1.1))
    .linkDirectionalParticleSpeed((l) => (l.kind === 'mesh' ? 0.004 : 0.01))
    .linkDirectionalParticleColor((l) => (l.kind === 'mesh' ? '#5eead4' : '#f9a8d4'))
    .nodeThreeObjectExtend(true)
    .nodeThreeObject((n) => decorate(n))
    .onNodeClick((n) => { onSelect?.(n); })
    .onNodeHover((n) => { el.style.cursor = n ? 'pointer' : 'grab'; state.hover = n; })
    .onBackgroundClick(() => onBackground?.())
    .onEngineStop(() => { if (!state.fitted) { state.fitted = true; Graph.zoomToFit(800, 30); } })
    .cooldownTicks(400)
    .warmupTicks(30);

  Graph.d3Force('charge').strength(-120);
  const ctl = Graph.controls();
  if (ctl) { ctl.autoRotateSpeed = 0.35; ctl.enableDamping = true; }
  Graph.d3Force('link').distance((l) => (l.kind === 'mesh' ? 140 : l.kind === 'agent' ? 50 : l.kind === 'project' ? 80 : 30));

  const bloom = new UnrealBloomPass(new THREE.Vector2(el.clientWidth, el.clientHeight), 0.8, 0.4, 0.22);
  Graph.postProcessingComposer().addPass(bloom);

  // Starfield backdrop.
  const stars = new THREE.BufferGeometry();
  const pts = new Float32Array(3000 * 3);
  for (let i = 0; i < pts.length; i++) pts[i] = (Math.random() - 0.5) * 6000;
  stars.setAttribute('position', new THREE.BufferAttribute(pts, 3));
  Graph.scene().add(new THREE.Points(stars, new THREE.PointsMaterial({ color: 0x334155, size: 2.2, sizeAttenuation: true, transparent: true, opacity: 0.7 })));

  function colorFor(n) {
    const base = TYPES[n.type]?.color || '#94a3b8';
    if (state.focus && !state.highlight.has(n.id)) return '#1e293b';
    return base;
  }
  function isLit(l) {
    if (!state.focus) return false;
    const s = l.source.id ?? l.source;
    const t = l.target.id ?? l.target;
    return state.highlight.has(s) && state.highlight.has(t);
  }
  function linkColor(l) {
    if (state.focus) return isLit(l) ? '#7dd3fc' : '#0f172a';
    if (l.kind === 'mesh') return '#2dd4bf';
    if (l.kind === 'live') return '#f472b6';
    if (l.kind === 'skill') return '#c084fc';
    if (l.kind === 'delegate') return '#a3e635';
    if (l.kind === 'plan') return '#a16207';
    if (l.kind === 'tool') return '#22d3ee';
    return '#3b5568';
  }

  function decorate(n) {
    const group = new THREE.Group();
    const label = labelFor(n);
    n.__label?.remove();
    n.__label = null;
    if (label) {
      const div = document.createElement('div');
      div.textContent = label.length > 30 ? label.slice(0, 29) + '…' : label;
      const obj = new CSS2DObject(div);
      obj.position.set(0, -(Math.cbrt(n.val) * 2.6 * 1.25 + 2), 0);
      obj.center.set(0.5, 0);
      group.add(obj);
      n.__label = div;
      styleLabel(n);
    }
    if (n.type === 'machine' || n.type === 'offline') {
      const r = Math.cbrt(n.val) * 2.6;
      const ring = new THREE.Mesh(new THREE.TorusGeometry(r * 1.7, 0.35, 8, 64), new THREE.MeshBasicMaterial({ color: n.type === 'machine' ? 0x5eead4 : 0x334155, transparent: true, opacity: 0.55 }));
      ring.rotation.x = Math.PI / 2.4;
      ring.userData.spin = true;
      group.add(ring);
    }
    if (n.type === 'mesh') {
      const r = Math.cbrt(n.val) * 2.6;
      for (let i = 0; i < 2; i++) {
        const ring = new THREE.Mesh(new THREE.TorusGeometry(r * (2 + i * 0.7), 0.25, 8, 80), new THREE.MeshBasicMaterial({ color: 0x94a3b8, transparent: true, opacity: 0.35 }));
        ring.rotation.x = Math.PI / 2 + i * 0.6;
        ring.userData.spin = true;
        group.add(ring);
      }
    }
    if (n.type === 'live' || (n.type === 'task' && n.live)) group.userData.pulse = true;
    n.__group = group;
    return group;
  }

  // Animate rings + pulse + slow auto-rotation.
  (function loop() {
    const t = performance.now() / 1000;
    for (const n of state.data.nodes) {
      const g = n.__group;
      if (!g) continue;
      for (const c of g.children) if (c.userData.spin) c.rotation.z += 0.004;
      if (g.userData.pulse) { const s = 1 + Math.sin(t * 3 + (n.x || 0)) * 0.25; g.scale.set(s, s, s); }
    }
    const controls = Graph.controls();
    if (controls) controls.autoRotate = state.rotate && !state.focus && !state.hover;
    requestAnimationFrame(loop);
  })();

  function neighbors(id, depth) {
    const adj = new Map();
    for (const l of state.data.links) {
      const s = l.source.id ?? l.source;
      const t = l.target.id ?? l.target;
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

  function styleLabel(n) {
    const el = n.__label;
    if (!el) return;
    const dim = state.focus && !state.highlight.has(n.id);
    // CSS2DRenderer owns style.display, so visibility is toggled with a class.
    const hide = !state.labels || state.hidden.has(n.type);
    el.className = `nlabel t-${n.type}${dim ? ' dim' : ''}${state.focus === n.id ? ' focus' : ''}${hide ? ' hide' : ''}`;
  }

  // Restyle in place (no object rebuilds, so no leaked label elements).
  function refreshStyles() {
    Graph.nodeColor(Graph.nodeColor()).linkColor(Graph.linkColor()).linkWidth(Graph.linkWidth());
    for (const n of state.data.nodes) styleLabel(n);
  }

  const api = {
    Graph,
    setData(data) {
      // Reuse node objects so the layout doesn't explode on every refresh.
      const nodes = data.nodes.map((n) => {
        const prev = state.byId.get(n.id);
        if (prev) { const { x, y, z, vx, vy, vz, fx, fy, fz, __group, ...rest } = prev; return Object.assign(prev, n, { x, y, z, vx, vy, vz, fx, fy, fz }); }
        return n;
      });
      state.byId = new Map(nodes.map((n) => [n.id, n]));
      const sig = (d) => d.nodes.map((n) => n.id + n.type + (n.session?.live ? 1 : 0) + (n.task?.status || '')).join('|') + d.links.map((l) => `${l.source.id ?? l.source}>${l.target.id ?? l.target}`).join('|');
      const changed = sig({ nodes, links: data.links }) !== state.sig;
      state.sig = sig({ nodes, links: data.links });
      for (const old of state.data.nodes) if (!state.byId.has(old.id)) old.__label?.remove();
      state.data = { nodes, links: data.links };
      if (changed) Graph.graphData(state.data);
      if (state.focus && !state.byId.has(state.focus)) api.clearFocus();
      else if (state.focus) { state.highlight = neighbors(state.focus, state.depth); refreshStyles(); }
    },
    get(id) { return state.byId.get(id); },
    nodes() { return state.data.nodes; },
    neighbors(id, depth = 1) { return [...neighbors(id, depth)].map((x) => state.byId.get(x)).filter(Boolean); },
    focus(id, depth = state.depth) {
      const n = state.byId.get(id);
      if (!n) return;
      state.focus = id;
      state.depth = depth;
      state.highlight = neighbors(id, depth);
      refreshStyles();
      // Keep the current viewing direction and slide in until the node sits at a fixed distance.
      const dist = n.type === 'machine' || n.type === 'offline' ? 260 : n.type === 'mesh' ? 320 : 150;
      const cam = Graph.camera().position;
      const dx = cam.x - (n.x || 0);
      const dy = cam.y - (n.y || 0);
      const dz = cam.z - (n.z || 0);
      const len = Math.hypot(dx, dy, dz) || 1;
      Graph.cameraPosition({ x: (n.x || 0) + (dx / len) * dist, y: (n.y || 0) + (dy / len) * dist, z: (n.z || 0) + (dz / len) * dist }, { x: n.x || 0, y: n.y || 0, z: n.z || 0 }, 1400);
    },
    setDepth(d) { if (state.focus) api.focus(state.focus, d); },
    clearFocus() {
      state.focus = null;
      state.highlight = new Set();
      refreshStyles();
    },
    fit() { api.clearFocus(); Graph.zoomToFit(900, 30); },
    setForces({ repel, linkLength }) {
      if (repel != null) Graph.d3Force('charge').strength(-repel);
      if (linkLength != null) Graph.d3Force('link').distance((l) => (l.kind === 'mesh' ? linkLength * 4 : l.kind === 'agent' ? linkLength * 1.4 : l.kind === 'project' ? linkLength * 2.4 : linkLength));
      Graph.d3ReheatSimulation();
    },
    setDisplay({ labels, particles, rotate }) {
      if (labels != null) state.labels = labels;
      if (particles != null) state.particles = particles;
      if (rotate != null) state.rotate = rotate;
      Graph.linkDirectionalParticles(Graph.linkDirectionalParticles());
      refreshStyles();
    },
    setHidden(types) { state.hidden = new Set(types); Graph.nodeVisibility(Graph.nodeVisibility()).linkVisibility(Graph.linkVisibility()); for (const n of state.data.nodes) styleLabel(n); },
    resize() { Graph.width(el.clientWidth).height(el.clientHeight); bloom.setSize(el.clientWidth, el.clientHeight); },
    get focused() { return state.focus; },
    get depth() { return state.depth; },
  };
  window.addEventListener('resize', () => api.resize());
  return api;
}

function escapeHtml(s) {
  return String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}
