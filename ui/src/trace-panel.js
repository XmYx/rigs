import ForceGraph3D from '3d-force-graph';
import * as THREE from 'three';
import { CSS2DObject, CSS2DRenderer } from 'three/examples/jsm/renderers/CSS2DRenderer.js';
import { ago, api, h } from './api.js';
import { announce, prefersReducedMotion } from './a11y.js';
import { isPhone } from './mobile.js';
import { lowPower, pixelRatio } from './perf.js';
import { currentTheme } from './themes.js';
import { openWindow } from './wm.js';
import { tagCtx } from './ctx-tag.js';
import {
  CRITICAL_COLOR, ERROR_COLOR, GROUPS, filterList, fmtMs, fmtNum, fmtUsd, isError, kindGroup, layoutTrace, mergeSpans, present,
  replayEvents, selfTimes, spanDur, spanTokens, stateAt, summarize, treeOrder,
} from './trace-layout.js';

// "Request traces" — every request from Sir, looked back at (src/trace.js records them; the pure layout and analysis
// is trace-layout.js). The floating panel lists recent requests from the mesh /api/traces (prompt, route, duration,
// cost, status, machines; range, route, status and text filters). Opening one shows the trace explorer window:
//   - a 3D DAG (3d-force-graph): time along x, a lane per machine or seat along z, children below their parent;
//     colour = stage kind (red = error), size = duration or tokens, a bar per span for how long it ran
//   - a timeline (2D waterfall) of the same spans
//   - replay: a scrubber over the spans in the order they ran, with particles along each edge as its stage starts
//   - the critical path (the chain the request waited on) and a summary strip (total time, self time per stage
//     kind, tool calls)
//   - a drawer with the clicked span's input and output (truncation marked), model, tokens, cost and timings
// "All activity" (openActivity) is the same explorer over the latest N requests at once, on one time axis: new
// requests and their spans appear as they happen.
// Phones get the list, a flat graph without labels and a bottom sheet for the drawer. Running traces update live from
// the UI WebSocket ({ type: 'trace-span' }, local spans) and by polling ?after= (spans written on other machines).

const RANGES = [['24h', '24h'], ['7d', '7 days'], ['30d', '30 days']];
const ROUTES = [['', 'any route'], ['answer', 'answer'], ['implement', 'implement'], ['plan', 'plan'], ['continue', 'continue']];
const STATUSES = [['', 'any status'], ['ok', 'ok'], ['error', 'error'], ['running', 'running'], ['stopped', 'stopped']];
const ICON = { ok: '✓', error: '✗', running: '◌', stopped: '■' };
const MODEL = (m) => String(m || '').replace(/^claude-/, '');
const clock = (t) => new Date(t).toLocaleString([], { month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit', second: '2-digit' });
const pref = (k, d) => { try { return localStorage.getItem('rigs.traces.' + k) ?? d; } catch { return d; } };
const setPref = (k, v) => { try { localStorage.setItem('rigs.traces.' + k, v); } catch { /* private mode */ } };
const colorOf = (s) => (isError(s) ? ERROR_COLOR : GROUPS[kindGroup(s.kind)].color);

const ALL = '*'; // the explorer key of the all-activity view
const explorers = new Map(); // traceId (or ALL) → Set of open explorers (live spans go to them)
let listPanel = null;

/** A span arrived over the UI WebSocket: refresh the list soon and feed any open explorer of that trace. */
export function onTraceSpan(span) {
  if (!span?.traceId) return;
  listPanel?.poke();
  for (const ex of explorers.get(span.traceId) || []) ex.add([span]);
  for (const ex of explorers.get(ALL) || []) ex.add([span]);
}

// ---------------------------------------------------------------- the list panel

/** Mount the Request traces panel into `el`. Returns { refresh, setActive, poke }. */
export function createTraces(el) {
  const meta = h('span', { class: 'wk-meta' }, '');
  const head = h('div', { class: 'wk-head keep' }, h('span', { class: 'wk-title' }, 'Request traces'), meta);
  const f = { range: pref('range', '24h'), route: '', status: '', q: '' };
  const chips = h('div', { class: 'us-chips', role: 'group', 'aria-label': 'Time range' });
  const sel = (opts, key, label) => h('select', { class: 'tr-sel', 'aria-label': label, onchange: (e) => { f[key] = e.target.value; refresh(); } }, ...opts.map(([v, l]) => h('option', { value: v }, l)));
  const search = h('input', { class: 'search tr-search', type: 'search', placeholder: 'Search requests…', 'aria-label': 'Search requests', oninput: () => { f.q = search.value; draw(); clearTimeout(qTimer); qTimer = setTimeout(refresh, 400); } });
  const filters = h('div', { class: 'tr-filters' }, sel(ROUTES, 'route', 'Route'), sel(STATUSES, 'status', 'Status'), search);
  const body = h('div', { class: 'wk-list', role: 'list' });
  const allBtn = h('button', { class: 'tb tr-allbtn', title: 'Every recent request in one live 3D view', onclick: () => openActivity() }, h('span', { class: 'tr-livedot', 'aria-hidden': 'true' }), 'All activity · live');
  el.append(head, allBtn, chips, filters, body);
  let qTimer = null;
  let timer = null;
  let pokeTimer = null;
  let active = false;
  let last = null;

  function drawChips() {
    chips.replaceChildren(...RANGES.map(([v, l]) => h('button', { class: 'tb' + (v === f.range ? ' on' : ''), 'aria-pressed': String(v === f.range), onclick: () => { f.range = v; setPref('range', v); drawChips(); refresh(); } }, l)));
  }

  function row(t) {
    const st = t.status || 'ok';
    const open = () => openTrace(t.traceId, t);
    return tagCtx(h('div', { class: `wk-row tr-item ${st}`, role: 'listitem', tabindex: '0', title: `${t.request}\n${t.traceId}`, onclick: open, onkeydown: (e) => { if (e.key === 'Enter') open(); } },
      h('div', { class: 'wk-rtitle' }, h('span', { class: `tr-st ${st}`, title: st, 'aria-label': st }, ICON[st] || '·'), h('span', { class: 'tr-req' }, t.request || '(no text)'), h('b', {}, st === 'running' ? 'live' : fmtMs(t.durationMs))),
      h('div', { class: 'wk-rmeta' }, [t.route || '—', fmtUsd(t.costUsd), `${t.spans} spans`, t.toolCalls ? `${t.toolCalls} tools` : null, ago(t.start)].filter(Boolean).join(' · ')),
      h('div', { class: 'tr-nodes' }, ...(t.nodes || []).map((n) => h('span', { class: 'tr-node' }, n)), ...(t.models || []).slice(0, 2).map((m) => h('span', { class: 'tr-model' }, MODEL(m))))), 'trace', t.traceId, { traceId: t.traceId, summary: t });
  }

  function draw() {
    if (!last) return;
    const list = filterList(last.traces, f);
    meta.textContent = `${list.length}${last.truncated ? '+' : ''}`;
    const nodes = list.map(row);
    if (last.errors?.length) nodes.push(h('div', { class: 'muted small' }, `No answer from ${last.errors.map((e) => e.node).join(', ')}.`));
    body.replaceChildren(...(nodes.length ? nodes : [h('div', { class: 'muted small pad' }, f.q || f.route || f.status ? 'No request matches these filters.' : 'No requests traced in this range.')]));
  }

  async function refresh() {
    try {
      const qs = new URLSearchParams({ since: f.range, limit: '60' });
      if (f.route) qs.set('route', f.route);
      if (f.status) qs.set('status', f.status);
      if (f.q) qs.set('q', f.q);
      last = await api('/api/traces?' + qs);
      draw();
    } catch (e) { if (!last) body.replaceChildren(h('div', { class: 'muted small pad' }, e.message)); }
  }
  function setActive(on) {
    active = on;
    clearInterval(timer);
    if (on) { refresh(); timer = setInterval(refresh, 15000); }
  }
  function poke() { if (!active) return; clearTimeout(pokeTimer); pokeTimer = setTimeout(refresh, 1500); }
  drawChips();
  listPanel = { refresh, setActive, poke };
  return listPanel;
}

// ---------------------------------------------------------------- the explorer window

/** The all-activity view: the latest requests (5, 12 or 30) in one explorer, kept live. */
export function openActivity() { return openTrace(ALL); }

/** Open the explorer for one trace (summary = its list row, shown while the spans load). */
export function openTrace(traceId, summary = null) {
  const phone = isPhone();
  const all = traceId === ALL;
  const S = {
    spans: [], errors: [], view: pref('view', '3d'), size: pref('size', 'duration'), lane: pref('lane', 'node'), even: pref('even', '1') === '1',
    crit: true, sel: null, step: null, playing: false, graph: null, layout: null, fitted: false, lastPoll: 0,
    limit: Number(pref('limit', '12')) || 12, requests: new Map(), // all-activity: traceId → its list row
  };
  const title = all ? 'All activity · live' : summary?.request ? `Trace · ${summary.request.slice(0, 60)}` : `Trace ${traceId}`;
  const win = openWindow({ title, icon: '🧭', width: 1240, height: 780, className: 'trace-win', onClose: () => destroy() });

  const strip = h('div', { class: 'tr-strip', role: 'region', 'aria-label': 'Trace summary' }, h('span', { class: 'muted small' }, all ? 'Loading the latest requests…' : summary ? `${summary.request || traceId} — loading ${summary.spans} spans…` : 'Loading…'));
  const seg = (key, opts, label) => h('div', { class: 'tr-seg', role: 'group', 'aria-label': label }, ...opts.map(([v, l, tipText]) => h('button', {
    class: 'tb' + (String(S[key]) === v ? ' on' : ''), 'aria-pressed': String(String(S[key]) === v), title: tipText || l, 'data-v': v,
    onclick: (e) => {
      S[key] = key === 'even' ? v === 'true' : key === 'limit' ? Number(v) : v;
      setPref(key, key === 'even' ? (S.even ? '1' : '0') : v);
      if (key === 'limit') { load(); return; }
      for (const b of e.currentTarget.parentNode.children) { const on = b.dataset.v === v; b.classList.toggle('on', on); b.setAttribute('aria-pressed', String(on)); }
      relayout();
    },
  }, l)));
  const playBtn = h('button', { class: 'tb tr-play', title: 'Replay the request in the order its stages ran (space)', 'aria-label': 'Replay', onclick: () => (S.playing ? pause() : play()) }, '▶');
  const scrub = h('input', { type: 'range', class: 'tr-scrub', min: '0', max: '0', value: '0', step: '1', 'aria-label': 'Replay position', oninput: () => { pause(); seek(Number(scrub.value)); } });
  const tLabel = h('span', { class: 'tr-tlabel' }, '');
  const critBtn = h('button', { class: 'tb on', 'aria-pressed': 'true', title: 'Highlight the critical path: the chain of stages the request waited on', onclick: () => { S.crit = !S.crit; critBtn.classList.toggle('on', S.crit); critBtn.setAttribute('aria-pressed', String(S.crit)); paint(); } }, '⚡ Critical path');
  const fitBtn = h('button', { class: 'tb', title: 'Fit the graph to the window', 'aria-label': 'Fit the graph', onclick: () => S.graph?.zoomToFit(500, 40) }, '⤢');
  const tools = h('div', { class: 'tr-tools' },
    seg('view', [['3d', '3D'], ['timeline', 'Timeline']], 'View'),
    seg('size', [['duration', 'Size: time', 'Node size by duration'], ['tokens', 'Size: tokens', 'Node size by tokens']], 'Node size'),
    seg('lane', [['node', 'Lanes: machines'], ['seat', 'Lanes: seats']], 'Lanes'),
    seg('even', [['true', 'Spread', 'Space spans evenly in start order'], ['false', 'Real time', 'x = real time']], 'Time axis'),
    all ? seg('limit', [['5', 'Last 5'], ['12', '12'], ['30', '30']], 'Requests shown') : null,
    critBtn, fitBtn,
    h('div', { class: 'tr-replay' }, playBtn, scrub, tLabel));
  const stage3d = h('div', { class: 'tr-3d', role: 'img', 'aria-label': 'Trace graph in 3D: time runs left to right, one lane per machine' });
  const timeline = h('div', { class: 'tr-timeline', role: 'list', 'aria-label': 'Trace timeline' });
  const drawer = h('aside', { class: 'tr-drawer', role: 'region', 'aria-label': 'Span details', hidden: true });
  const stage = h('div', { class: 'tr-stage' }, stage3d, timeline);
  const main = h('div', { class: 'tr-main' }, stage, drawer);
  win.body.classList.add('tr-body');
  win.body.append(strip, tools, main);

  let pollTimer = null;
  let playTimer = null;
  let redrawTimer = null;
  let destroyed = false;
  const me = {
    add: (spans) => {
      const known = new Set(S.spans.map((s) => s.traceId));
      S.spans = mergeSpans(S.spans, spans);
      if (all) { keepLatest(); if (spans.some((s) => !known.has(s.traceId))) S.fitted = false; } // a new request: fit it in
      scheduleRedraw();
    },
  };
  if (!explorers.has(traceId)) explorers.set(traceId, new Set()); // traceId is ALL for the all-activity view
  explorers.get(traceId).add(me);

  function destroy() {
    destroyed = true;
    clearInterval(pollTimer); clearInterval(playTimer); clearTimeout(redrawTimer);
    explorers.get(traceId)?.delete(me);
    if (!explorers.get(traceId)?.size) explorers.delete(traceId);
    for (const n of S.layout?.nodes || []) n.__parts?.label?.element.remove();
    try { S.graph?._destructor(); } catch { /* already gone */ }
    S.graph = null;
  }

  // ------------------------------------------------------------ data
  async function loadAll() {
    const list = await api(`/api/traces?${new URLSearchParams({ since: '7d', limit: String(S.limit) })}`);
    S.requests = new Map((list.traces || []).map((t) => [t.traceId, t]));
    const full = await Promise.all([...S.requests.keys()].map((id) => api(`/api/traces/${encodeURIComponent(id)}`).catch(() => null)));
    S.spans = mergeSpans(...full.map((r) => r?.spans || []));
    S.errors = list.errors || [];
    S.lastPoll = Date.now();
    S.fitted = false;
    redraw();
  }
  async function load() {
    if (all) { try { await loadAll(); } catch (e) { strip.replaceChildren(h('span', { class: 'muted small' }, e.message)); } return; }
    try {
      const r = await api(`/api/traces/${encodeURIComponent(traceId)}`);
      S.spans = mergeSpans(r.spans);
      // Machines that did not answer (r.errors) and the gaps they leave in the tree (r.gaps, also 'gap' spans).
      S.errors = [...(r.errors || []), ...(r.gaps || []).filter((g) => !(r.errors || []).some((e) => e.node === g.node))];
      S.lastPoll = Date.now();
      redraw();
    } catch (e) { strip.replaceChildren(h('span', { class: 'muted small' }, e.message)); }
  }
  // Spans written on other machines are not pushed to this UI: poll for changes while anything still runs.
  async function poll() {
    if (destroyed) return;
    if (all) return pollAll();
    if (!S.spans.some((s) => s.end == null)) return;
    try {
      const after = S.lastPoll - 5000;
      S.lastPoll = Date.now();
      const r = await api(`/api/traces/${encodeURIComponent(traceId)}?after=${after}`);
      if (r.spans?.length) me.add(r.spans);
    } catch { /* next poll */ }
  }
  // All activity: new requests anywhere on the mesh, and spans of the running ones written on other machines.
  async function pollAll() {
    try {
      const list = await api(`/api/traces?${new URLSearchParams({ since: '24h', limit: String(S.limit) })}`);
      const fresh = (list.traces || []).filter((t) => !S.requests.has(t.traceId) || t.status === 'running' || S.requests.get(t.traceId).status === 'running');
      for (const t of list.traces || []) S.requests.set(t.traceId, t);
      const after = S.lastPoll - 5000;
      S.lastPoll = Date.now();
      const got = await Promise.all(fresh.map((t) => api(`/api/traces/${encodeURIComponent(t.traceId)}${S.spans.some((s) => s.traceId === t.traceId) ? `?after=${after}` : ''}`).catch(() => null)));
      const spans = got.flatMap((r) => r?.spans || []);
      if (spans.length) me.add(spans);
    } catch { /* next poll */ }
  }
  // All activity keeps only the latest S.limit requests (by when they came in).
  function keepLatest() {
    const first = new Map();
    for (const s of S.spans) if (!first.has(s.traceId) || s.start < first.get(s.traceId)) first.set(s.traceId, s.start);
    if (first.size <= S.limit) return;
    const keep = new Set([...first].sort((a, b) => b[1] - a[1]).slice(0, S.limit).map(([id]) => id));
    S.spans = S.spans.filter((s) => keep.has(s.traceId));
  }
  function scheduleRedraw() { clearTimeout(redrawTimer); redrawTimer = setTimeout(redraw, 250); }

  // ------------------------------------------------------------ derived state
  let sum = null;
  let self = new Map();
  let crit = new Set();
  let critLinks = new Set();
  let events = [];
  let byId = new Map();
  const now = () => Date.now();

  function redraw() {
    if (destroyed) return;
    const t = now();
    sum = summarize(S.spans, t);
    self = selfTimes(S.spans, t);
    crit = new Set(sum.critical);
    critLinks = new Set(sum.critical.slice(1).map((id, i) => `${sum.critical[i]}>${id}`));
    events = replayEvents(S.spans);
    byId = new Map(S.spans.map((s) => [s.spanId, s]));
    scrub.max = String(events.length);
    if (S.step == null || S.step > events.length) { S.step = null; scrub.value = String(events.length); }
    renderStrip();
    stage.dataset.view = S.view;
    // The 3D canvas stays laid out (visibility, not display: none) so its size is right when it comes back; it just stops drawing.
    if (S.view === '3d') { S.graph?.resumeAnimation(); renderGraph(); } else { S.graph?.pauseAnimation(); renderTimeline(); }
    if (S.sel && byId.has(S.sel)) renderDrawer();
    applyCursor();
  }
  function relayout() { S.fitted = false; redraw(); }

  // ------------------------------------------------------------ summary strip
  function renderStrip() {
    const stat = (k, v, tipText) => h('div', { class: 'us-stat', title: tipText || '' }, h('b', {}, v), h('span', {}, k));
    const groups = sum.groups;
    const pct = (g) => Math.round(g.share * 100);
    const bar = h('div', { class: 'tr-kbar', role: 'img', 'aria-label': 'Time per stage kind: ' + groups.map((g) => `${g.label} ${pct(g)}%`).join(', ') },
      ...groups.map((g) => h('i', { style: { width: (g.share * 100).toFixed(2) + '%', background: g.color }, title: `${g.label}: ${fmtMs(g.selfMs)} self time (${pct(g)}%), ${g.count} span${g.count === 1 ? '' : 's'}` })));
    const legend = h('div', { class: 'tr-legend' }, ...groups.map((g) => h('span', { class: 'tr-chip', title: `${g.count} span${g.count === 1 ? '' : 's'}, self time (children not counted twice)` }, h('i', { style: { background: g.color } }), `${g.label} ${fmtMs(g.selfMs)}`, h('em', {}, ` ${pct(g)}%`))));
    const toolChips = sum.tools.slice(0, phone ? 3 : 6).map((x) => h('span', { class: 'tr-chip tool' + (x.errors ? ' err' : ''), title: `${x.count} call${x.count === 1 ? '' : 's'}, ${fmtMs(x.ms)} in total${x.errors ? `, ${x.errors} failed` : ''}` }, `${x.name} ×${x.count}`, h('em', {}, ' ' + fmtMs(x.ms))));
    // The stage on the critical path with the most self time is where shaving time pays off first.
    const hot = [...sum.criticalSelf].sort((a, b) => b.selfMs - a.selfMs)[0];
    const path = sum.criticalSelf.map((c) => `${GROUPS[kindGroup(c.kind)].label} ${c.name}`).join(' → ');
    strip.replaceChildren(
      h('div', { class: 'us-stats tr-stats' },
        all ? stat('requests', String(new Set(S.spans.map((s) => s.traceId)).size)) : null,
        stat('total', fmtMs(sum.totalMs), all ? 'From the first request to the last stage' : 'From the request to the last stage'), stat('spans', String(sum.spans)), stat('machines', String(sum.nodes.length), sum.nodes.join(', ')),
        stat('tools', String(sum.toolCalls)), stat('tokens', fmtNum(sum.tokens)), stat('cost', fmtUsd(sum.costUsd)), stat('errors', String(sum.errors))),
      h('div', { class: 'tr-sumcol' },
        h('div', { class: 'tr-sumrow' }, h('span', { class: 'tr-k' }, 'time per stage'), bar), legend,
        toolChips.length ? h('div', { class: 'tr-sumrow wrap' }, h('span', { class: 'tr-k' }, 'tool calls'), ...toolChips) : null,
        h('div', { class: 'tr-sumrow wrap tr-critline', title: path },
          h('span', { class: 'tr-k crit' }, all ? '⚡ critical path (latest-ending request)' : '⚡ critical path'), h('b', {}, fmtMs(sum.criticalMs)), h('span', { class: 'muted' }, ` · ${sum.critical.length} stages`),
          hot ? h('button', { class: 'tr-link', title: 'Open the slowest stage on the critical path', onclick: () => select(hot.id) }, `slowest: ${hot.name} ${fmtMs(hot.selfMs)}`) : null,
          sum.running ? h('span', { class: 'tr-live' }, `● live · ${sum.running} running`) : null),
        S.errors.length ? h('div', { class: 'muted small' }, `Not reachable: ${[...new Set(S.errors.map((e) => e.node))].join(', ')} — their spans are missing.`) : null));
  }

  // ------------------------------------------------------------ 3D graph
  let decor = null; // lanes, axis and the replay cursor (rebuilt with the layout)
  let cursorPlane = null;
  const linkKey = (l) => `${l.source?.id ?? l.source}>${l.target?.id ?? l.target}`;
  const onCrit = (l) => S.crit && critLinks.has(linkKey(l));

  function ensureGraph() {
    if (S.graph) return S.graph;
    const labelRenderer = new CSS2DRenderer();
    labelRenderer.domElement.style.pointerEvents = 'none';
    const g = new ForceGraph3D(stage3d, { controlType: 'orbit', extraRenderers: [labelRenderer] })
      .backgroundColor(currentTheme().graph.background)
      .showNavInfo(false)
      .nodeId('id')
      .nodeThreeObject((n) => nodeObject(n))
      .nodeThreeObjectExtend(false)
      .nodeLabel((n) => tip(n.span))
      .linkColor((l) => (onCrit(l) ? CRITICAL_COLOR : l.cross ? '#5eead4' : '#64748b'))
      .linkWidth((l) => (onCrit(l) ? 1.6 : l.cross ? 0.7 : 0.3))
      .linkOpacity(0.7)
      .linkCurvature((l) => (l.cross ? 0.2 : 0))
      .linkDirectionalArrowLength(phone ? 0 : 3)
      .linkDirectionalArrowRelPos(1)
      .linkDirectionalArrowColor((l) => (onCrit(l) ? CRITICAL_COLOR : '#94a3b8'))
      .linkDirectionalParticleWidth(2.6)
      .linkDirectionalParticleSpeed(0.035)
      .linkDirectionalParticleColor((l) => l.target?.color || '#ffffff')
      .onNodeClick((n) => select(n.id))
      .onNodeHover((n) => { stage3d.style.cursor = n ? 'pointer' : 'grab'; })
      .onBackgroundClick(() => select(null))
      .cooldownTicks(1)
      .warmupTicks(0);
    for (const f of ['charge', 'link', 'center']) g.d3Force(f, null); // positions are the layout's (fx/fy/fz)
    g.renderer().setPixelRatio(pixelRatio());
    const light = new THREE.DirectionalLight(0xffffff, 0.8);
    light.position.set(100, 200, 300);
    g.scene().add(light);
    win.onResize(() => { if (S.graph && stage3d.clientWidth) S.graph.width(stage3d.clientWidth).height(stage3d.clientHeight); });
    S.graph = g;
    return g;
  }

  function nodeObject(n) {
    const grp = new THREE.Group();
    const r = Math.cbrt(n.val) * (phone ? 2.6 : 3.4);
    const color = new THREE.Color(n.color);
    const mat = new THREE.MeshLambertMaterial({ color, transparent: true, opacity: n.span.end == null ? 0.7 : 0.95, emissive: color, emissiveIntensity: 0.25 });
    const res = lowPower() ? 8 : 16;
    const sphere = new THREE.Mesh(new THREE.SphereGeometry(r, res, Math.max(6, res - 4)), mat);
    grp.add(sphere);
    // A bar along +x for how long the span ran (its share of the time axis).
    const bar = new THREE.Mesh(new THREE.BoxGeometry(1, 1.4, 1.4).translate(0.5, 0, 0), new THREE.MeshLambertMaterial({ color, transparent: true, opacity: 0.38 }));
    bar.scale.x = Math.max(0.001, n.len);
    bar.visible = n.len > r;
    grp.add(bar);
    if (n.span.end == null) grp.add(new THREE.Mesh(new THREE.TorusGeometry(r * 1.6, 0.35, 6, 24), new THREE.MeshBasicMaterial({ color: 0xffffff, transparent: true, opacity: 0.6 })));
    let label = null;
    if (!phone && (all ? n.group === 'intake' : n.group !== 'tool' || S.spans.length <= 40)) { // all activity: label each request's root only
      const div = document.createElement('div');
      div.className = 'nlabel tr-nlabel';
      div.textContent = (all && n.group === 'intake' ? `“${requestOf(n.span)}”` : n.group === 'tool' ? n.span.name : `${GROUPS[n.group].label} · ${n.span.name}`).slice(0, 48);
      if (all && n.group === 'intake') div.classList.add('tr-reqlabel');
      label = new CSS2DObject(div);
      label.position.set(0, r + 4, 0);
      grp.add(label);
    }
    n.__parts = { sphere, bar, mat, label, r };
    return grp;
  }

  function buildDecor(L) {
    const g = S.graph;
    if (decor) { g.scene().remove(decor); decor.traverse((o) => { o.geometry?.dispose(); o.material?.dispose?.(); if (o.isCSS2DObject) o.element.remove(); }); }
    decor = new THREE.Group();
    const W = L.width + 80;
    const floorY = -(L.maxDepth + 1) * L.depthGap;
    const label = (text, cls, x, y, z) => { const d = document.createElement('div'); d.className = cls; d.textContent = text; const o = new CSS2DObject(d); o.position.set(x, y, z); decor.add(o); return o; };
    L.lanes.forEach((ln, i) => {
      const geo = phone ? new THREE.PlaneGeometry(W, (L.maxDepth + 1.6) * L.depthGap) : new THREE.PlaneGeometry(W, 70);
      const m = new THREE.Mesh(geo, new THREE.MeshBasicMaterial({ color: i % 2 ? 0x2dd4bf : 0x60a5fa, transparent: true, opacity: 0.06, side: THREE.DoubleSide, depthWrite: false }));
      if (phone) m.position.set(0, ln.y - (L.maxDepth * L.depthGap) / 2, -12);
      else { m.rotation.x = -Math.PI / 2; m.position.set(0, floorY, ln.z); }
      decor.add(m);
      label(ln.key, 'nlabel tr-lane', phone ? 0 : -W / 2 - 10, phone ? ln.y + 12 : floorY + 4, ln.z);
    });
    // Time axis along the front edge of the floor (phone: under the lowest lane).
    const zFront = phone ? 0 : (L.lanes.at(-1)?.z || 0) + 45;
    const yAxis = phone ? (L.lanes.at(-1)?.y || 0) - (L.maxDepth + 1.3) * L.depthGap : floorY;
    const axisGeo = new THREE.BufferGeometry().setFromPoints([new THREE.Vector3(-L.width / 2, yAxis, zFront), new THREE.Vector3(L.width / 2, yAxis, zFront)]);
    decor.add(new THREE.Line(axisGeo, new THREE.LineBasicMaterial({ color: 0x475569 })));
    if (!phone) for (const tk of L.axis.ticks) label('+' + fmtMs(tk.ms), 'nlabel tr-tick', tk.x, yAxis - 4, zFront);
    label(S.even ? 'start order →' : 'time →', 'nlabel tr-tick', L.width / 2 + 24, yAxis, zFront);
    // The replay cursor: a thin vertical sheet at the current time.
    const tall = phone ? Math.max(200, L.lanes.length * (L.maxDepth + 2) * L.depthGap) : (L.maxDepth + 2) * L.depthGap;
    const deep = phone ? 40 : Math.max(120, L.lanes.length * 90 + 60);
    cursorPlane = new THREE.Mesh(new THREE.PlaneGeometry(deep, tall), new THREE.MeshBasicMaterial({ color: 0xfde047, transparent: true, opacity: 0.1, side: THREE.DoubleSide, depthWrite: false }));
    cursorPlane.rotation.y = Math.PI / 2;
    cursorPlane.position.set(0, yAxis + tall / 2, phone ? 0 : ((L.lanes[0]?.z || 0) + (L.lanes.at(-1)?.z || 0)) / 2);
    cursorPlane.visible = false;
    decor.add(cursorPlane);
    g.scene().add(decor);
  }

  function renderGraph() {
    if (!stage3d.clientWidth || !stage3d.clientHeight) { requestAnimationFrame(() => { if (!destroyed && S.view === '3d') renderGraph(); }); return; }
    const g = ensureGraph();
    g.width(stage3d.clientWidth).height(stage3d.clientHeight);
    const L = layoutTrace(S.spans, { now: now(), lane: S.lane, size: S.size, even: S.even, width: phone ? 300 : Math.max(500, Math.min(1600, S.spans.length * 40)), flat: phone, depthGap: phone ? 16 : 56, laneGap: phone ? 90 : 130 });
    // CSS2D labels of the nodes being replaced stay in the DOM unless removed here (the renderer no longer visits them).
    for (const n of S.layout?.nodes || []) n.__parts?.label?.element.remove();
    S.layout = L;
    g.graphData({ nodes: L.nodes, links: L.links });
    buildDecor(L);
    if (!S.fitted) {
      S.fitted = true;
      const dist = Math.max(260, L.width * 0.95);
      if (phone) g.cameraPosition({ x: 0, y: 0, z: dist * 1.3 }, { x: 0, y: 0, z: 0 }, 0);
      else g.cameraPosition({ x: -L.width * 0.15, y: dist * 0.18, z: dist * 0.9 }, { x: 0, y: -(L.maxDepth * L.depthGap) / 2, z: 0 }, 0);
      setTimeout(() => S.graph?.zoomToFit(prefersReducedMotion() ? 0 : 600, phone ? 30 : 40), 150);
    }
    paint();
  }

  /** Emphasis that depends on the selection and the critical-path toggle (no layout change). */
  function paint() {
    if (S.view === 'timeline') { renderTimeline(); return; }
    const g = S.graph;
    if (!g || !S.layout) return;
    for (const n of S.layout.nodes) {
      const p = n.__parts;
      if (!p) continue;
      const on = S.crit && crit.has(n.id);
      const selected = S.sel === n.id;
      p.mat.emissive.set(selected ? '#ffffff' : n.color);
      p.mat.emissiveIntensity = selected ? 0.7 : on ? 0.55 : 0.2;
      p.sphere.scale.setScalar(selected ? 1.45 : on ? 1.15 : 1);
      p.label?.element.classList.toggle('crit', on);
      p.label?.element.classList.toggle('sel', selected);
    }
    g.linkColor(g.linkColor()).linkWidth(g.linkWidth()).linkDirectionalArrowColor(g.linkDirectionalArrowColor());
    applyCursor();
  }

  // ------------------------------------------------------------ timeline (2D waterfall)
  function renderTimeline() {
    if (!sum) return;
    const T = Math.max(1, sum.totalMs);
    const pct = (ms) => `${((ms / T) * 100).toFixed(3)}%`;
    const ticks = h('div', { class: 'tr-ticks' }, ...(phone ? [0, 0.5, 1] : [0, 0.25, 0.5, 0.75, 1]).map((f) => h('span', { style: { left: `${f * 100}%` } }, '+' + fmtMs(f * T))));
    const rows = treeOrder(S.spans).map(({ span: s, depth }) => {
      const dur = spanDur(s, now());
      const c = colorOf(s);
      return h('div', {
        class: 'tr-row' + (S.crit && crit.has(s.spanId) ? ' crit' : '') + (S.sel === s.spanId ? ' sel' : '') + (isError(s) ? ' err' : ''), role: 'listitem', tabindex: '0', 'data-id': s.spanId,
        title: `${s.kind} · ${s.name} · ${fmtMs(dur)} · ${s.node}`, onclick: () => select(s.spanId), onkeydown: (e) => { if (e.key === 'Enter') select(s.spanId); },
      },
      h('div', { class: 'tr-rlabel', style: { paddingLeft: `${Math.min(depth, 8) * (phone ? 6 : 12) + 4}px` } }, h('i', { class: 'tr-dot', style: { background: c } }), h('span', {}, s.name), h('em', {}, fmtMs(dur))),
      h('div', { class: 'tr-track' }, h('div', { class: 'tr-bar' + (s.end == null ? ' running' : ''), style: { left: pct(s.start - sum.t0), width: `max(3px, ${pct(dur)})`, background: c } })));
    });
    const cursor = h('div', { class: 'tr-track tr-cursorbox', 'aria-hidden': 'true' }, h('div', { class: 'tr-cursor', hidden: true }));
    timeline.replaceChildren(h('div', { class: 'tr-row tr-axis' }, h('div', { class: 'tr-rlabel muted' }, phone ? `${S.spans.length} spans` : `${S.spans.length} spans · ${sum.nodes.length} machine${sum.nodes.length === 1 ? '' : 's'}`), h('div', { class: 'tr-track' }, ticks)), ...rows, cursor);
    applyCursor();
  }

  // ------------------------------------------------------------ replay
  // S.step = how many replay events have happened (null = the end: everything shown).
  function cursorTime() { return S.step == null ? Infinity : S.step === 0 ? (events[0]?.t ?? 0) - 1 : events[S.step - 1].t; }
  function seek(step) {
    const prev = S.step ?? events.length;
    S.step = step >= events.length ? null : Math.max(0, step);
    scrub.value = String(step);
    // Particles along the edge into each stage that started between the old and the new position.
    if (S.graph && S.view === '3d' && step > prev && !prefersReducedMotion()) {
      const started = new Set(events.slice(prev, step).filter((e) => e.type === 'start').map((e) => e.id));
      for (const l of S.graph.graphData().links) if (started.has(l.target?.id ?? l.target)) S.graph.emitParticle(l);
    }
    applyCursor();
  }
  function applyCursor() {
    if (!sum) return;
    const t = cursorTime();
    const live = !Number.isFinite(t);
    const ev = live ? null : events[Math.max(0, S.step - 1)];
    tLabel.textContent = live ? `${fmtMs(sum.totalMs)} · end` : `+${fmtMs(Math.max(0, t - sum.t0))} · ${S.step}/${events.length}${ev && S.step ? ` · ${ev.type === 'start' ? '▸' : '■'} ${byId.get(ev.id)?.name || ''}` : ''}`;
    if (S.view === '3d' && S.layout && S.graph) {
      for (const n of S.layout.nodes) {
        const obj = n.__threeObj;
        const p = n.__parts;
        if (!obj || !p) continue;
        const st = live ? 'done' : stateAt(n.span, t);
        obj.visible = st !== 'future';
        // A running stage's bar grows with the cursor.
        const grown = S.even ? n.len * Math.min(1, (t - n.start) / Math.max(1, spanDur(n.span, now()))) : (t - n.start) * S.layout.scale;
        p.bar.scale.x = Math.max(0.001, !live && st === 'active' ? Math.min(n.len, grown) : n.len);
        p.mat.opacity = !live && st === 'active' ? 1 : n.span.end == null ? 0.7 : 0.95;
      }
      for (const l of S.graph.graphData().links) {
        const vis = live || stateAt(l.target, t) !== 'future';
        if (l.__lineObj) l.__lineObj.visible = vis;
        if (l.__arrowObj) l.__arrowObj.visible = vis;
      }
      if (cursorPlane) {
        cursorPlane.visible = !live;
        if (!live) {
          const n = S.layout.nodes.find((x) => x.id === ev?.id);
          cursorPlane.position.x = S.even ? (n?.x ?? -S.layout.width / 2) + (ev?.type === 'end' ? n?.len || 0 : 0) : (t - sum.t0) * S.layout.scale - S.layout.width / 2;
        }
      }
    } else if (S.view === 'timeline') {
      for (const r of timeline.querySelectorAll('.tr-row[data-id]')) {
        const s = byId.get(r.dataset.id);
        const st = live || !s ? 'done' : stateAt(s, t);
        r.classList.toggle('future', st === 'future');
        r.classList.toggle('active', !live && st === 'active');
      }
      const c = timeline.querySelector('.tr-cursor');
      if (c) {
        c.hidden = live;
        if (!live) c.style.left = `${(Math.max(0, (t - sum.t0) / Math.max(1, sum.totalMs)) * 100).toFixed(3)}%`;
      }
    }
  }
  function play() {
    if (!events.length) return;
    if (S.step == null) seek(0);
    S.playing = true;
    playBtn.textContent = '⏸';
    playBtn.setAttribute('aria-label', 'Pause the replay');
    clearInterval(playTimer);
    playTimer = setInterval(() => {
      const next = (S.step ?? events.length) + 1;
      seek(next);
      if (next >= events.length) pause();
    }, Math.max(90, Math.min(600, 16000 / events.length)));
  }
  function pause() {
    S.playing = false;
    clearInterval(playTimer);
    playBtn.textContent = '▶';
    playBtn.setAttribute('aria-label', 'Replay');
  }

  // ------------------------------------------------------------ the span drawer (a bottom sheet on phones)
  function select(id) {
    S.sel = id && byId.has(id) ? id : null;
    if (S.sel) renderDrawer(); else drawer.hidden = true;
    const resized = main.classList.contains('has-drawer') !== !!S.sel && !phone;
    main.classList.toggle('has-drawer', !!S.sel);
    paint();
    // Opening or closing the side drawer changes the stage's width: resize the canvas and fit the graph again.
    if (resized) requestAnimationFrame(() => { if (S.graph && stage3d.clientWidth) { S.graph.width(stage3d.clientWidth).height(stage3d.clientHeight); S.graph.zoomToFit(prefersReducedMotion() ? 0 : 400, 40); } });
    if (S.sel) { const s = byId.get(S.sel); announce(`${s.kind} ${s.name}, ${fmtMs(spanDur(s, now()))}`); }
  }

  function block(title, v) {
    const p = present(v);
    if (!p.text) return h('section', { class: 'tr-io' }, h('h5', {}, title), h('div', { class: 'muted small' }, '—'));
    return h('section', { class: 'tr-io' },
      h('h5', {}, title, p.json ? h('em', {}, ' json') : null, h('button', { class: 'tr-copy', title: `Copy the ${title.toLowerCase()}`, 'aria-label': `Copy the ${title.toLowerCase()}`, onclick: () => navigator.clipboard?.writeText(p.text).catch(() => {}) }, '⧉')),
      h('pre', { class: 'tr-pre' + (p.json ? ' json' : ''), tabindex: '0' }, p.text),
      p.truncated ? h('div', { class: 'tr-trunc' }, `✂ truncated by the trace store — ${p.cut ? fmtNum(p.cut) + ' more characters were not kept' : 'the rest was not kept'} (config.traces.maxField)`) : null);
  }

  function renderDrawer() {
    const s = byId.get(S.sel);
    if (!s) return;
    const m = s.meta || {};
    const t0 = sum?.t0 ?? s.start;
    const dur = spanDur(s, now());
    const kv = (k, v) => (v == null || v === '' ? null : [h('dt', {}, k), h('dd', {}, v)]);
    const tok = spanTokens(s);
    const KNOWN = new Set(['provider', 'model', 'effort', 'inputTokens', 'outputTokens', 'cacheReadTokens', 'cacheWriteTokens', 'costUsd', 'seat', 'durationMs']);
    const extra = Object.fromEntries(Object.entries(m).filter(([k]) => !KNOWN.has(k)));
    const kids = S.spans.filter((x) => x.parentId === s.spanId);
    const parent = byId.get(s.parentId);
    drawer.hidden = false;
    drawer.replaceChildren(...[
      h('div', { class: 'tr-dhead' },
        h('i', { class: 'tr-dot', style: { background: colorOf(s) } }),
        h('div', { class: 'tr-dtitle' }, h('b', {}, s.name), h('span', { class: 'muted' }, ` ${s.kind}`)),
        h('span', { class: `tr-badge ${s.status}` }, s.status),
        h('button', { class: 'pclose', title: 'Close the details', 'aria-label': 'Close the details', onclick: () => select(null) }, '✕')),
      all ? h('div', { class: 'tr-req-of' }, h('span', { class: 'muted' }, 'request '), requestOf(s), h('button', { class: 'tr-link', title: 'Open this request on its own', onclick: () => openTrace(s.traceId, S.requests.get(s.traceId)) }, 'Open request ↗')) : null,
      S.crit && crit.has(s.spanId) ? h('div', { class: 'tr-oncrit' }, '⚡ on the critical path — the request waited on this stage') : null,
      h('dl', { class: 'tr-kv' },
        kv('machine', s.node), kv('seat', m.seat),
        kv('started', `+${fmtMs(s.start - t0)} · ${clock(s.start)}`),
        kv('duration', s.end == null ? `${fmtMs(dur)} so far (running)` : fmtMs(dur)),
        kv('self time', fmtMs(self.get(s.spanId) || 0)),
        kv('model', m.model ? [m.provider, MODEL(m.model), m.effort].filter(Boolean).join(' · ') : null),
        kv('tokens', tok ? `${fmtNum(tok)} — in ${fmtNum(m.inputTokens || 0)} · out ${fmtNum(m.outputTokens || 0)}${m.cacheReadTokens || m.cacheWriteTokens ? ` · cache ${fmtNum((m.cacheReadTokens || 0) + (m.cacheWriteTokens || 0))}` : ''}` : null),
        kv('cost', m.costUsd != null ? fmtUsd(m.costUsd) : null),
        kv('span', s.spanId)),
      Object.keys(extra).length ? h('details', { class: 'tr-meta' }, h('summary', {}, 'meta'), h('pre', { class: 'tr-pre json' }, JSON.stringify(extra, null, 2))) : null,
      block('Input', s.input), block('Output', s.output),
      parent || kids.length ? h('div', { class: 'tr-rel' },
        parent ? h('button', { class: 'tr-link', onclick: () => select(parent.spanId) }, `↑ ${parent.name}`) : null,
        ...kids.slice(0, 30).map((k) => h('button', { class: 'tr-link', onclick: () => select(k.spanId) }, h('i', { class: 'tr-dot', style: { background: colorOf(k) } }), ` ${k.name} ${fmtMs(spanDur(k, now()))}`))) : null,
    ].filter(Boolean));
  }

  function requestOf(s) {
    const row = S.requests.get(s.traceId);
    if (row?.request) return row.request;
    const root = S.spans.find((x) => x.traceId === s.traceId && x.kind === 'intake');
    return typeof root?.input === 'string' ? root.input : s.traceId;
  }

  function tip(s) {
    const esc = (x) => String(x ?? '').replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
    return `<div class="tip"><b>${esc(s.name)}</b><span>${esc(s.kind)} · ${fmtMs(spanDur(s, now()))} · ${esc(s.node)}${s.meta?.model ? ' · ' + esc(MODEL(s.meta.model)) : ''}${spanTokens(s) ? ' · ' + fmtNum(spanTokens(s)) + ' tok' : ''}</span></div>`;
  }

  // Keyboard: space = play/pause, ←/→ = one step.
  win.el.addEventListener('keydown', (e) => {
    if (e.target.closest('input, select, textarea, pre, button')) return;
    if (e.key === ' ') { e.preventDefault(); if (S.playing) pause(); else play(); }
    else if (e.key === 'ArrowRight' && events.length) { pause(); seek(Math.min(events.length, (S.step ?? events.length) + 1)); }
    else if (e.key === 'ArrowLeft' && events.length) { pause(); seek(Math.max(0, (S.step ?? events.length) - 1)); }
  });

  load();
  pollTimer = setInterval(poll, 4000);
  return { traceId, close: win.close, select };
}
