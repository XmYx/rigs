// Request trace explorer — the pure part (no DOM, no three.js; importable in Node, unit-tested in
// test/trace-panel.test.js). Spans are the shape src/trace.js documents: { traceId, spanId, parentId, kind, name,
// node, start, end, status, input, output, meta }. This module turns one trace's spans into:
//   - a 3D layout: time along x, one lane per machine (or seat) along z, tree depth along y (layoutTrace)
//   - the critical path: from the root, always the child that finished last (criticalPath)
//   - the summary strip: total time, self time per stage kind, tool-call counts, tokens and cost (summarize)
//   - the replay timeline: the order spans started and ended in (replayEvents)
// plus the colour, size and formatting rules the panel uses.

/** Stage groups the UI colours by. A span's kind maps to one (kindGroup); unknown kinds are "other". */
export const GROUPS = {
  intake: { label: 'intake', color: '#22d3ee' },
  router: { label: 'router', color: '#a78bfa' },
  brain: { label: 'brain', color: '#60a5fa' },
  planner: { label: 'planner', color: '#f59e0b' },
  handoff: { label: 'handoff', color: '#2dd4bf' },
  task: { label: 'task', color: '#4ade80' },
  tool: { label: 'tool call', color: '#f472b6' },
  event: { label: 'event', color: '#facc15' },
  other: { label: 'other', color: '#94a3b8' },
};
export const ERROR_COLOR = '#ef4444';
export const CRITICAL_COLOR = '#fde047';

/** intake | router | brain-turn | tool-call | handoff (t1) and the later stages (planner, dispatch, task runs…) → a group. */
export function kindGroup(kind) {
  const k = String(kind || '').toLowerCase();
  if (k === 'intake') return 'intake';
  if (k.startsWith('router') || k === 'route') return 'router';
  if (k.startsWith('tool')) return 'tool';
  if (/^(brain|assistant|turn|message|llm)/.test(k)) return 'brain';
  if (/^(plan|routing)/.test(k)) return 'planner';
  if (/^(handoff|dispatch)/.test(k)) return 'handoff';
  if (/^(task|run|seat|agent|review|merge)/.test(k)) return 'task';
  if (/^(question|answer|retry|escalat|ladder|guard|event|gap)/.test(k)) return 'event';
  return 'other';
}

export const isError = (s) => s?.status === 'error' || s?.meta?.error === true;
export const spanColor = (s) => (isError(s) ? ERROR_COLOR : GROUPS[kindGroup(s?.kind)].color);

const num = (v) => (Number.isFinite(Number(v)) ? Number(v) : 0);
/** Duration in ms; a running span lasts until `now`. */
export const spanDur = (s, now = Date.now()) => Math.max(0, (s.end ?? Math.max(now, s.start)) - s.start);
export const spanEnd = (s, now = Date.now()) => s.end ?? Math.max(now, s.start);
export const spanTokens = (s) => num(s?.meta?.inputTokens) + num(s?.meta?.outputTokens) + num(s?.meta?.cacheReadTokens) + num(s?.meta?.cacheWriteTokens);

/** The lane a span belongs to: its machine, or with by='seat' the seat/session that ran it (falls back to the machine). */
export function laneOf(s, by = 'node') {
  if (by === 'seat') return String(s.meta?.seat || s.meta?.session || s.meta?.sessionName || s.meta?.agent || s.node || '?');
  return String(s.node || '?');
}

/** Last record per spanId wins (a running span is written again when it ends). Returns spans sorted by start. */
export function mergeSpans(...lists) {
  const by = new Map();
  for (const list of lists) for (const s of list || []) if (s?.spanId) by.set(s.spanId, s);
  return [...by.values()].sort((a, b) => a.start - b.start || String(a.spanId).localeCompare(String(b.spanId)));
}

/** parentId → children (sorted by start) and the roots (no parent, or a parent this view does not hold). */
export function childrenOf(spans) {
  const ids = new Set(spans.map((s) => s.spanId));
  const kids = new Map();
  const roots = [];
  for (const s of [...spans].sort((a, b) => a.start - b.start)) {
    if (s.parentId && ids.has(s.parentId) && s.parentId !== s.spanId) {
      if (!kids.has(s.parentId)) kids.set(s.parentId, []);
      kids.get(s.parentId).push(s);
    } else roots.push(s);
  }
  return { kids, roots };
}

/** Depth-first order (parents before children, siblings by start) with each span's depth: the waterfall's rows. */
export function treeOrder(spans) {
  const { kids, roots } = childrenOf(spans);
  const out = [];
  const seen = new Set();
  const walk = (s, depth) => {
    if (seen.has(s.spanId)) return;
    seen.add(s.spanId);
    out.push({ span: s, depth });
    for (const c of kids.get(s.spanId) || []) walk(c, depth + 1);
  };
  for (const r of roots) walk(r, 0);
  return out;
}

/**
 * The critical path: start at the root that ends last and keep stepping into the child that ends last. Those are the
 * stages the request waited on — shortening anything off the path does not make the answer come sooner.
 * Returns the spanIds in order (root first).
 */
export function criticalPath(spans, now = Date.now()) {
  if (!spans.length) return [];
  const { kids, roots } = childrenOf(spans);
  const latest = (list) => list.reduce((a, b) => (spanEnd(b, now) > spanEnd(a, now) ? b : a));
  const path = [];
  let cur = latest(roots);
  const seen = new Set();
  while (cur && !seen.has(cur.spanId)) {
    seen.add(cur.spanId);
    path.push(cur.spanId);
    const c = kids.get(cur.spanId);
    cur = c?.length ? latest(c) : null;
  }
  return path;
}

/** Length of the union of [a, b] intervals. */
function unionMs(intervals) {
  const iv = intervals.filter(([a, b]) => b > a).sort((x, y) => x[0] - y[0]);
  let total = 0;
  let cs = -Infinity;
  let ce = -Infinity;
  for (const [a, b] of iv) {
    if (a > ce) { if (ce > cs) total += ce - cs; cs = a; ce = b; } else ce = Math.max(ce, b);
  }
  if (ce > cs) total += ce - cs;
  return total;
}

/** Self time of each span: its duration minus the time covered by its children (clipped to it). Map spanId → ms. */
export function selfTimes(spans, now = Date.now()) {
  const { kids } = childrenOf(spans);
  const out = new Map();
  for (const s of spans) {
    const a = s.start;
    const b = spanEnd(s, now);
    const covered = unionMs((kids.get(s.spanId) || []).map((c) => [Math.max(a, c.start), Math.min(b, spanEnd(c, now))]));
    out.set(s.spanId, Math.max(0, b - a - covered));
  }
  return out;
}

/**
 * The summary strip: wall time, self time per stage group (sums to the time the tree accounts for, no double counting
 * of a parent and its children), tool calls by name, tokens and cost of the spans that carry them, machines, errors,
 * and the critical path's stages.
 */
export function summarize(spans, now = Date.now()) {
  if (!spans.length) return { spans: 0, totalMs: 0, groups: [], tools: [], toolCalls: 0, errors: 0, nodes: [], tokens: 0, costUsd: null, critical: [], criticalMs: 0, criticalSelf: [], running: 0 };
  const t0 = Math.min(...spans.map((s) => s.start));
  const t1 = Math.max(...spans.map((s) => spanEnd(s, now)));
  const self = selfTimes(spans, now);
  const groups = new Map();
  for (const s of spans) {
    const g = kindGroup(s.kind);
    const e = groups.get(g) || { group: g, label: GROUPS[g].label, color: GROUPS[g].color, count: 0, selfMs: 0 };
    e.count++;
    e.selfMs += self.get(s.spanId) || 0;
    groups.set(g, e);
  }
  const accounted = [...groups.values()].reduce((a, g) => a + g.selfMs, 0) || 1;
  for (const g of groups.values()) g.share = g.selfMs / accounted;
  const tools = new Map();
  for (const s of spans.filter((x) => kindGroup(x.kind) === 'tool')) {
    const e = tools.get(s.name) || { name: s.name, count: 0, ms: 0, errors: 0 };
    e.count++;
    e.ms += spanDur(s, now);
    if (isError(s)) e.errors++;
    tools.set(s.name, e);
  }
  const costed = spans.filter((s) => s.meta?.costUsd != null);
  const critical = criticalPath(spans, now);
  const byId = new Map(spans.map((s) => [s.spanId, s]));
  return {
    spans: spans.length, t0, t1, totalMs: t1 - t0,
    groups: [...groups.values()].sort((a, b) => b.selfMs - a.selfMs),
    tools: [...tools.values()].sort((a, b) => b.count - a.count || b.ms - a.ms),
    toolCalls: [...tools.values()].reduce((a, t) => a + t.count, 0),
    errors: spans.filter(isError).length,
    running: spans.filter((s) => s.end == null).length,
    nodes: [...new Set(spans.map((s) => s.node).filter(Boolean))],
    tokens: spans.reduce((a, s) => a + spanTokens(s), 0),
    costUsd: costed.length ? Math.round(costed.reduce((a, s) => a + num(s.meta.costUsd), 0) * 1e6) / 1e6 : null,
    critical,
    // From the request to the end of the last stage on the path (the root itself may end before its children do).
    criticalMs: critical.length ? Math.max(...critical.map((id) => spanEnd(byId.get(id), now))) - byId.get(critical[0]).start : 0,
    criticalSelf: critical.map((id) => ({ id, kind: byId.get(id).kind, name: byId.get(id).name, selfMs: self.get(id) || 0 })),
  };
}

/** Node size (three-forcegraph nodeVal, ~volume) by duration or tokens; log-scaled so a 2 h task run and a 40 ms tool call both stay visible. */
export function nodeVal(s, by = 'duration', now = Date.now()) {
  const v = by === 'tokens' ? spanTokens(s) : spanDur(s, now);
  const unit = by === 'tokens' ? 50 : 20;
  return 1 + Math.min(40, Math.log10(1 + v / unit) * 6);
}

/**
 * The 3D layout. x = time from the first span (linear, or `even` = by start order so a burst of fast tool calls next
 * to a long task run still spreads out), y = tree depth (children below their parent, spans that land on the same
 * spot nudged apart), z = lane (machine or seat). `flat` (the phone's simplified graph) keeps z at 0 and stacks the
 * lanes along y instead. Returns { nodes, links, lanes, axis } with fixed positions (fx/fy/fz) for 3d-force-graph.
 */
export function layoutTrace(spans, { now = Date.now(), lane = 'node', size = 'duration', even = false, width = 600, laneGap = 90, depthGap = 34, flat = false } = {}) {
  const sorted = [...spans].sort((a, b) => a.start - b.start);
  if (!sorted.length) return { nodes: [], links: [], lanes: [], axis: { t0: 0, t1: 0, ticks: [] }, scale: 1, width, maxDepth: 0, depthGap };
  const t0 = sorted[0].start;
  const t1 = Math.max(...sorted.map((s) => spanEnd(s, now)));
  const T = Math.max(1, t1 - t0);
  const scale = width / T;
  const order = new Map(sorted.map((s, i) => [s.spanId, i]));
  const step = width / Math.max(1, sorted.length - 1);
  const xOf = (s) => (even ? order.get(s.spanId) * step : (s.start - t0) * scale);
  // A mesh gap (a machine that did not answer, meta.gap) sits in its parent's lane rather than a lane of its own.
  const byId = new Map(sorted.map((s) => [s.spanId, s]));
  const laneFor = (s) => (s.meta?.gap && byId.has(s.parentId) ? laneOf(byId.get(s.parentId), lane) : laneOf(s, lane));
  const laneKeys = [...new Set(sorted.map(laneFor))];
  const laneIdx = new Map(laneKeys.map((k, i) => [k, i]));
  const mid = (laneKeys.length - 1) / 2;
  const depth = new Map(treeOrder(sorted).map((r) => [r.span.spanId, r.depth]));
  const maxDepth = Math.max(0, ...depth.values());
  const laneY = (li) => (flat ? -(li - mid) * (maxDepth + 2) * depthGap : 0);
  // Spans that land on the same spot (same lane, depth and nearly the same x) are fanned out a little.
  const slot = new Map();
  const nodes = sorted.map((s) => {
    const li = laneIdx.get(laneFor(s));
    const d = depth.get(s.spanId) || 0;
    const x = xOf(s) - width / 2;
    const key = `${li}:${d}:${Math.round(x / 6)}`;
    const k = slot.get(key) || 0;
    slot.set(key, k + 1);
    const y = laneY(li) - d * depthGap - k * 9;
    const z = flat ? 0 : (li - mid) * laneGap + k * 6;
    const len = even ? Math.max(2, step * 0.6) : Math.max(0, spanDur(s, now) * scale);
    return { id: s.spanId, span: s, start: s.start, end: s.end, x, y, z, fx: x, fy: y, fz: z, len, depth: d, lane: laneKeys[li], val: nodeVal(s, size, now), color: spanColor(s), group: kindGroup(s.kind) };
  });
  const ids = new Set(nodes.map((n) => n.id));
  const laneOfId = new Map(nodes.map((n) => [n.id, n.lane]));
  const links = sorted.filter((s) => s.parentId && ids.has(s.parentId) && s.parentId !== s.spanId)
    .map((s) => ({ source: s.parentId, target: s.spanId, start: s.start, cross: laneOfId.get(s.parentId) !== laneOfId.get(s.spanId) }));
  const lanes = laneKeys.map((k, i) => ({ key: k, z: flat ? 0 : (i - mid) * laneGap, y: laneY(i) }));
  return { nodes, links, lanes, axis: { t0, t1, ticks: even ? [] : timeTicks(T).map((ms) => ({ ms, x: ms * scale - width / 2 })) }, scale, width, maxDepth, depthGap };
}

/** 2–9 round tick values (ms) across a duration. */
export function timeTicks(T) {
  const steps = [1, 2, 5, 10, 20, 50, 100, 200, 500, 1e3, 2e3, 5e3, 1e4, 2e4, 3e4, 6e4, 12e4, 3e5, 6e5, 9e5, 18e5, 36e5, 72e5, 144e5, 288e5, 864e5];
  const st = steps.find((x) => T / x <= 8) || steps.at(-1);
  const out = [];
  for (let v = 0; v <= T + 1e-9; v += st) out.push(v);
  return out;
}

/** Replay: every span start and end in time order ({ t, type: 'start'|'end', id }); ends of running spans are left out. */
export function replayEvents(spans) {
  const ev = [];
  for (const s of spans) {
    ev.push({ t: s.start, type: 'start', id: s.spanId });
    if (s.end != null) ev.push({ t: s.end, type: 'end', id: s.spanId });
  }
  return ev.sort((a, b) => a.t - b.t || (a.type === 'end' ? -1 : 1));
}

/** A span's state at replay time t: 'future' (not started), 'active' (running at t) or 'done'. */
export function stateAt(s, t) {
  if (t < s.start) return 'future';
  if (s.end == null || t < s.end) return 'active';
  return 'done';
}

// ---------------------------------------------------------------- formatting

export const fmtMs = (ms) => {
  if (ms == null) return '…';
  if (ms < 1000) return `${Math.round(ms)}ms`;
  const s = ms / 1000;
  if (s < 60) return `${s < 10 ? s.toFixed(1) : Math.round(s)}s`;
  if (s < 3600) return `${Math.floor(s / 60)}m ${Math.round(s % 60)}s`;
  return `${Math.floor(s / 3600)}h ${Math.round((s % 3600) / 60)}m`;
};
export const fmtUsd = (c) => (c == null ? '—' : c > 0 && c < 0.01 ? '<$0.01' : '$' + c.toFixed(c < 1 ? 3 : 2));
export const fmtNum = (n) => (n >= 1e6 ? (n / 1e6).toFixed(1) + 'M' : n >= 1e3 ? (n / 1e3).toFixed(n >= 1e4 ? 0 : 1) + 'k' : String(Math.round(n || 0)));

const TRUNC_RE = /…\[truncated (\d+) chars\]$/;
/**
 * A stored input/output for the drawer: { text, json, truncated, cut } — strings as text (JSON-looking strings
 * pretty-printed), structures as indented JSON; the store's truncation markers ("…[truncated N chars]" on strings,
 * { truncated, chars, preview } on structures) become truncated=true and cut = the number of characters dropped.
 */
export function present(v) {
  if (v == null || v === '') return { text: '', json: false, truncated: false, cut: 0 };
  if (typeof v === 'string') {
    const m = v.match(TRUNC_RE);
    const body = m ? v.slice(0, m.index) : v;
    const t = body.trim();
    if (!m && (t.startsWith('{') || t.startsWith('['))) {
      try { return { text: JSON.stringify(JSON.parse(t), null, 2), json: true, truncated: false, cut: 0 }; } catch { /* plain text */ }
    }
    return { text: body, json: false, truncated: !!m, cut: m ? Number(m[1]) : 0 };
  }
  if (typeof v === 'object' && v.truncated === true && typeof v.preview === 'string') {
    return { text: v.preview, json: true, truncated: true, cut: Math.max(0, num(v.chars) - v.preview.length) };
  }
  try { return { text: JSON.stringify(v, null, 2), json: true, truncated: false, cut: 0 }; } catch { return { text: String(v), json: false, truncated: false, cut: 0 }; }
}

/** Client-side filter for the list (the server filters too; this keeps the view right between polls). */
export function filterList(traces, { route = '', status = '', q = '', node = '' } = {}) {
  const w = String(q || '').toLowerCase();
  return (traces || []).filter((t) => (!route || t.route === route) && (!status || t.status === status) && (!node || (t.nodes || []).includes(node))
    && (!w || String(t.request || '').toLowerCase().includes(w) || String(t.traceId).includes(w) || (t.projectIds || []).some((p) => p.includes(w))));
}
