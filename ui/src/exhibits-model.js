// The pure side of the Exhibit window (ui/src/exhibits.js): folding live pushes into a document, the picker's list,
// URLs and wording — and the live activity of the current request or task, derived from trace spans (see "Activity"
// below). No DOM; the one import is the shared secret redaction (src/redact.js, itself import-free), so
// test/exhibits-ui.test.js and test/exhibits.test.js run it in Node.
//
// Document shape (src/exhibits.js): { docId, scope: 'request'|'project', title, entries: [{ id, seq, kind, title,
// caption, visual, image: { src, file?, alt, source } | null, at }], final, finalAt, created, updated, dropped }.
// WebSocket pushes: { type: 'exhibit', docId, entry, final } · { type: 'exhibit-image', docId, entry } ·
// { type: 'exhibit-final', docId, at } · { type: 'exhibit-live', docId, kind, text, at } (a present-tense "now" line for a
// running stage, sent before any entry exists and never stored). 'exhibit-entry' is accepted as another name for 'exhibit'.

import { redact } from '../../src/redact.js';

export const KIND_LABEL = { intake: 'Request', plan: 'Plan', step: 'Step', code: 'Code', result: 'Result', milestone: 'Milestone', summary: 'Summary' };

/** Which push is this? 'entry' | 'image' | 'final' | 'live' | null. */
export function pushKind(m) {
  if (!m || !m.docId) return null;
  if (m.type === 'exhibit-live') return m.text ? 'live' : null;
  if (m.type === 'exhibit' || m.type === 'exhibit-entry') return m.entry ? 'entry' : null;
  if (m.type === 'exhibit-image') return m.entry ? 'image' : null;
  if (m.type === 'exhibit-final') return 'final';
  return null;
}

export const emptyDoc = (docId) => ({
  docId, scope: String(docId).startsWith('pr-') ? 'project' : 'request', title: '', entries: [], final: false, finalAt: null, created: null, updated: null, dropped: 0,
});

/**
 * Fold one push into a document (returns { doc, entry, isNew } — doc is the same object, changed in place). An entry
 * is placed by seq and deduplicated by id, so the same entry arriving by push and by a fetch is shown once; an image
 * push replaces the picture of the entry it names. Pure apart from mutating `doc`.
 */
export function applyPush(doc, m) {
  const kind = pushKind(m);
  if (!kind) return { doc, entry: null, isNew: false };
  if (kind === 'live') return { doc, entry: null, isNew: false };
  if (kind === 'final') {
    doc.final = true;
    doc.finalAt = m.at || doc.finalAt || Date.now();
    return { doc, entry: null, isNew: false };
  }
  const e = m.entry;
  const i = doc.entries.findIndex((x) => x.id === e.id);
  if (kind === 'image') {
    if (i >= 0) doc.entries[i] = { ...doc.entries[i], image: e.image || doc.entries[i].image };
    return { doc, entry: i >= 0 ? doc.entries[i] : null, isNew: false };
  }
  let isNew = false;
  if (i >= 0) doc.entries[i] = { ...doc.entries[i], ...e };
  else { doc.entries.push(e); doc.entries.sort((a, b) => (a.seq ?? 0) - (b.seq ?? 0)); isNew = true; }
  if (m.final) { doc.final = true; doc.finalAt = doc.finalAt || m.at || e.at || null; }
  doc.updated = Math.max(doc.updated || 0, e.at || 0) || doc.updated;
  return { doc, entry: doc.entries.find((x) => x.id === e.id), isNew };
}

/** Is this push the first one of a document this page has not seen? (the window opens for it) */
export const startsDocument = (seen, m) => ['entry', 'live'].includes(pushKind(m)) && !seen.has(m.docId);

/**
 * The ticker of a document: its last few "now" lines, newest last, repeats of the same text folded into one. Returns
 * a new array (the previous one is not changed). A final push clears it elsewhere (see clearTicker). Pure.
 */
export function pushLive(lines = [], m, max = 4) {
  if (pushKind(m) !== 'live') return lines;
  if (lines.at(-1)?.text === m.text) return lines;
  return [...lines, { text: String(m.text), kind: m.kind || '', at: m.at || Date.now() }].slice(-max);
}

/** Title of the shown document: the server's, else the request's own words from its first entry. */
export function titleOf(doc) {
  if (doc.title) return doc.title;
  const first = doc.entries.find((e) => e.kind === 'intake') || doc.entries[0];
  return first ? first.title : docHeading(doc);
}

/** Summary row of a loaded document, as the list API gives them. */
export const summaryOf = (d, node = '') => ({ docId: d.docId, scope: d.scope, title: d.title || '', entries: d.entries.length, final: !!d.final, finalAt: d.finalAt || null, created: d.created || null, updated: d.updated || null, node });

/**
 * The picker's rows: the fetched list (mesh, newest first) with the documents this page knows live laid over it, by
 * docId, newest first, at most `limit`. Pure.
 */
export function pickerRows(listed = [], live = [], limit = 30) {
  const by = new Map();
  for (const d of listed) by.set(d.docId, d);
  for (const d of live) by.set(d.docId, { ...(by.get(d.docId) || {}), ...d, node: d.node || by.get(d.docId)?.node || '' });
  return [...by.values()].sort((a, b) => (b.updated || b.created || 0) - (a.updated || a.created || 0)).slice(0, limit);
}

const clip = (s, n) => (String(s).length > n ? String(s).slice(0, n - 1).trimEnd() + '…' : String(s));

/** Heading of a document: its title, else what it is. */
export const docHeading = (d) => d.title || (d.scope === 'project' ? `Project ${String(d.docId).slice(3)}` : `Request ${d.docId}`);

/** A picker option's label: "Request · add dark mode · 5 · live". */
export function rowLabel(d) {
  const kind = d.scope === 'project' ? 'Project' : 'Request';
  const n = d.entries ?? 0;
  return `${kind} · ${clip(d.title || d.docId, 44)} · ${n} · ${d.final ? 'final' : 'live'}`;
}

/** Entry count wording for the header. */
export const countText = (n) => `${n} exhibit${n === 1 ? '' : 's'}`;

/** Where the documents of `node` live on the API ('' → the gateway's own machine). */
export const docBase = (node) => `/api/nodes/${encodeURIComponent(node || 'self')}/exhibits`;

/** URL of the document, its export (format html|md, download adds Content-Disposition) or one of its stored images. */
export const docUrl = (node, docId) => `${docBase(node)}/${encodeURIComponent(docId)}`;
export const exportUrl = (node, docId, format = 'html', download = false) => `${docUrl(node, docId)}/export?format=${format === 'md' ? 'md' : 'html'}${download ? '&download=1' : ''}`;

/**
 * The src to show for an entry's picture. SVGs are data URIs and stay; a stored ComfyUI picture is named by `file`
 * and fetched through the node that holds it (its stored src is relative to that machine).
 */
export function imageSrc(entry, node, docId) {
  const img = entry?.image;
  if (!img?.src) return '';
  if (img.file && img.source === 'comfyui') return `${docUrl(node, docId)}/images/${encodeURIComponent(img.file)}`;
  return img.src;
}

/** Plain-text name of a card, for assistive tech (the live region announces new ones). */
export const entryText = (e) => `${KIND_LABEL[e.kind] || e.kind}: ${e.title}${e.caption ? '. ' + e.caption : ''}`;

/** The picked document after the list changed: keep it if still there, else the newest. Pure. */
export function keepSelection(rows, docId) {
  return rows.some((r) => r.docId === docId) ? docId : (rows[0]?.docId || null);
}

/**
 * Should a new document take over the window? Only when nothing is shown, the shown one is finished, or the person is
 * following the live work — never when they picked an older document to read.
 */
export function shouldFollow({ current, currentFinal, follow }) {
  return !current || currentFinal || follow;
}

/**
 * Fold a fetched document into the one this page holds (same docId): entries it lacks are added, the server's title,
 * final state and timestamps win. Nothing already shown is dropped. Returns the added entries. Pure apart from `doc`.
 */
export function mergeDoc(doc, fetched) {
  const added = [];
  for (const e of fetched?.entries || []) {
    const r = applyPush(doc, { type: 'exhibit', docId: doc.docId, entry: e });
    if (r.isNew) added.push(e);
  }
  if (!fetched) return added;
  if (fetched.title) doc.title = fetched.title;
  if (fetched.final) { doc.final = true; doc.finalAt = fetched.finalAt || doc.finalAt; }
  for (const k of ['created', 'updated', 'dropped']) if (fetched[k] != null) doc[k] = Math.max(Number(doc[k]) || 0, Number(fetched[k]) || 0) || fetched[k];
  return added;
}

// ------------------------------------------------------------------ Activity: trace spans → what is being built
//
// The top of the window follows the actual work through the trace span stream (src/trace.js; the server pushes every
// span it writes as { type: 'trace-span', span }, and the window polls /api/traces/<id> for spans other machines hold).
// Spans are kept per trace (foldSpans), the scope is the picked document or else the work that is running now, else
// the most recent work (pickScope), and activityOf turns that scope's spans into: a title, the steps with their status
// and progress, the files touched (read / edit / create / delete, with a count), and the tool calls (newest first, a
// short redacted result, running / ok / error / stopped). Every string shown passes redact() — the same rules trace.js
// applies when it writes a span — and every list is capped.

export const ANIM_MODES = ['off', 'auto', 'always'];
/** The Exhibit animations setting, normalised (default 'auto'). */
export const animMode = (v) => (ANIM_MODES.includes(v) ? v : 'auto');

export const ACTIVITY_LIMITS = { traces: 12, spans: 800, files: 24, tools: 12 };
const STALE_MS = 15 * 60000; // a stage reported running with no news for this long was lost (a restart), not working
const RUN_STALE_MS = 3 * 3600000; // task runs report their tool calls only when they end, so they stay "working" longer
const MINOR = new Set(['tool-call', 'assistant', 'gap']);

const spanAt = (s) => Math.max(Number(s.start) || 0, Number(s.end) || 0);
const lastAtOf = (spans) => spans.reduce((a, s) => Math.max(a, spanAt(s)), 0);
const byStart = (a, b) => (a.start || 0) - (b.start || 0);
const oneLine = (s) => String(s ?? '').replace(/\s+/g, ' ').trim();
const safe = (s, n) => clip(redact(oneLine(s)), n);

/**
 * Fold spans into `store` (Map traceId → { traceId, spans: Map spanId → span, lastAt }). The last write of a span id
 * wins (a span is written when it starts and again when it ends) — except that an ended span is never replaced by a
 * running copy of itself (a fetch answered after the live push that ended it). At most `traces` traces are kept (the least recently
 * active go first) and `spans` per trace (finished tool calls and model messages go first). Returns the set of traceIds
 * that changed. Mutates `store`.
 */
export function foldSpans(store, spans, { traces = ACTIVITY_LIMITS.traces, spans: perTrace = ACTIVITY_LIMITS.spans } = {}) {
  const changed = new Set();
  for (const s of [].concat(spans || [])) {
    if (!s?.traceId || !s.spanId) continue;
    let t = store.get(s.traceId);
    if (!t) { t = { traceId: s.traceId, spans: new Map(), lastAt: 0 }; store.set(s.traceId, t); }
    const had = t.spans.get(s.spanId);
    if (had && had.end != null && s.end == null) continue;
    t.spans.set(s.spanId, s);
    t.lastAt = Math.max(t.lastAt, spanAt(s));
    changed.add(s.traceId);
  }
  for (const id of changed) {
    const t = store.get(id);
    if (t.spans.size <= perTrace) continue;
    const drop = [...t.spans.values()].sort((a, b) => (MINOR.has(b.kind) && b.status !== 'running') - (MINOR.has(a.kind) && a.status !== 'running') || byStart(a, b));
    for (const s of drop.slice(0, t.spans.size - perTrace)) t.spans.delete(s.spanId);
  }
  if (store.size > traces) {
    for (const t of [...store.values()].sort((a, b) => a.lastAt - b.lastAt).slice(0, store.size - traces)) { store.delete(t.traceId); changed.delete(t.traceId); }
  }
  return changed;
}

/** The scope an exhibit document stands for: a request document (docId = its traceId) → that trace, `pr-<id>` → that project. */
export const docScope = (docId) => (!docId ? null : String(docId).startsWith('pr-') ? { projectId: String(docId).slice(3) } : { traceId: String(docId) });

/** The spans of a scope, oldest first: one trace, or every trace that carries the project (its request, plan, dispatches, runs). */
export function scopeSpans(store, scope) {
  if (!scope) return [];
  if (scope.traceId) return [...(store.get(scope.traceId)?.spans.values() || [])].sort(byStart);
  const out = [];
  for (const t of store.values()) {
    const spans = [...t.spans.values()];
    if (spans.some((s) => s.meta?.projectId === scope.projectId)) out.push(...spans);
  }
  return out.sort(byStart);
}

/**
 * Which work the activity shows. A document the person picked to read (`pinned`) → its scope. Otherwise the trace that
 * is working now (the one that moved last), else the most recently active one — the last task, finished. Pure.
 */
export function pickScope(store, { pinned = null, now = Date.now() } = {}) {
  if (pinned) return pinned;
  const all = [...store.values()].sort((a, b) => b.lastAt - a.lastAt);
  const t = all.find((x) => isActive([...x.spans.values()], now)) || all[0];
  return t ? { traceId: t.traceId } : null;
}

/** Is a scope working right now? A stage or task still running that has had news recently enough. Pure. */
export function isActive(spans, now = Date.now()) {
  const last = lastAtOf(spans);
  if (spans.some((s) => s.status === 'running' && now - last < (s.kind === 'task' || s.kind === 'dispatch' ? RUN_STALE_MS : STALE_MS))) return true;
  return [...taskStates(spans).values()].some((t) => t.status === 'running' && now - last < RUN_STALE_MS);
}

const TASK_STATUS = { running: 'running', ok: 'ok', error: 'error', stopped: 'stopped', skipped: 'stopped' };

/**
 * The tasks of a scope by id → { id, title, status: pending | running | ok | error | stopped, node, at }, from the plan
 * (routing / output.tasks), handoffs (meta.taskIds), dispatches (a started task is running until its run reports) and
 * task runs (their end status). Later spans win, so a retry shows running again. Pure.
 */
export function taskStates(spans) {
  const tasks = new Map();
  const set = (id, fields) => { if (!id) return; const t = tasks.get(id) || { id, title: '', status: 'pending', node: '', at: 0 }; tasks.set(id, { ...t, ...Object.fromEntries(Object.entries(fields).filter(([, v]) => v != null && v !== '')) }); };
  for (const s of [...spans].sort(byStart)) {
    const m = s.meta || {};
    if (s.kind === 'plan') for (const r of m.routing || s.output?.tasks || []) { const id = r.task || r.id; if (!tasks.has(id)) set(id, { title: r.title, node: r.node }); }
    else if (s.kind === 'handoff') for (const id of m.taskIds || []) { if (!tasks.has(id)) set(id, {}); }
    else if (s.kind === 'dispatch' && m.taskId) set(m.taskId, { title: s.input?.task?.title, node: m.target, status: s.status === 'error' ? 'error' : 'running', at: s.start });
    else if (s.kind === 'task' && m.taskId) set(m.taskId, { title: s.input?.task?.title, node: s.node, status: TASK_STATUS[s.status] || 'running', at: spanAt(s) });
    else if (s.kind === 'event' && m.taskId && s.name === 'failed') set(m.taskId, { status: 'error', at: spanAt(s) });
  }
  return tasks;
}

const HANDOFF_LABEL = { 'file-work': 'Filed work', jarvis_task: 'Filed a task', project_create: 'Created a project', project_dispatch: 'Dispatched the project' };
const shortModel = (m) => String(m || '').replace(/^claude-/, '');

/**
 * The steps of a scope in the order they happened → [{ id, label, status: pending | running | ok | error | stopped, at }]:
 * the request, the routing decision, each brain turn, each handoff, the plan, one step per task (its live state), and
 * the reply (pending while the request runs). Tool calls and model messages are not steps (they are the tool list). Pure.
 */
export function stepsOf(spans) {
  const steps = [];
  const tasks = taskStates(spans);
  const placed = new Set();
  const addTask = (id) => {
    if (placed.has(id) || !tasks.has(id)) return;
    placed.add(id);
    const t = tasks.get(id);
    steps.push({ id: 'task:' + id, label: safe(`${id}${t.title ? ' · ' + t.title : ''}`, 80), status: t.status, at: t.at, task: true });
  };
  let intake = null;
  for (const s of [...spans].sort(byStart)) {
    const m = s.meta || {};
    if (s.kind === 'intake') { if (!intake) { intake = s; steps.push({ id: s.spanId, label: 'Request received', status: 'ok', at: s.start }); } }
    else if (s.kind === 'router' && s.status !== 'skipped') steps.push({ id: s.spanId, label: `Routed: ${safe(m.route || s.output?.route || 'decided', 30)}`, status: s.status, at: s.start });
    else if (s.kind === 'brain-turn') steps.push({ id: s.spanId, label: `Thinking · ${safe(shortModel(m.model) || s.name, 40)}`, status: s.status, at: s.start });
    else if (s.kind === 'handoff') { steps.push({ id: s.spanId, label: HANDOFF_LABEL[s.name] || safe(s.name, 40), status: s.status, at: s.start }); for (const id of m.taskIds || []) addTask(id); }
    else if (s.kind === 'plan') {
      const n = (m.routing || s.output?.tasks || []).length;
      steps.push({ id: s.spanId, label: n ? `Planned ${n} task${n === 1 ? '' : 's'}` : 'Planning', status: s.status, at: s.start });
      for (const r of m.routing || s.output?.tasks || []) addTask(r.task || r.id);
    } else if ((s.kind === 'dispatch' || s.kind === 'task') && m.taskId) addTask(m.taskId);
  }
  for (const id of tasks.keys()) addTask(id);
  if (intake) steps.push({ id: 'reply', label: 'Reply', status: intake.status === 'running' ? 'pending' : intake.status, at: intake.end || null });
  return steps;
}

/** A tool's own name without its MCP server prefix: mcp__rigs__mesh_write_file / rigs.mesh_write_file → mesh_write_file. */
export const toolBase = (name) => String(name || 'tool').replace(/^mcp__[^_]+(?:_[^_]+)*?__/, '').replace(/^[\w-]+\.(?=\w)/, '');

/** One field of a tool call's input: from the object, or from the JSON preview of an input cut to the trace's field cap. */
export function inputField(input, key) {
  if (input == null) return undefined;
  if (typeof input === 'object' && !input.truncated) return input[key];
  const text = typeof input === 'string' ? input : typeof input.preview === 'string' ? input.preview : '';
  const m = text.match(new RegExp(`"${key}"\\s*:\\s*"((?:[^"\\\\]|\\\\.)*)"`));
  if (!m) return undefined;
  try { return JSON.parse(`"${m[1]}"`); } catch { return m[1]; }
}

const FILE_TOOLS = { Read: 'read', NotebookRead: 'read', mesh_read_file: 'read', Edit: 'edit', MultiEdit: 'edit', NotebookEdit: 'edit', Write: 'write', mesh_write_file: 'write' };
const MARK_RANK = { read: 0, edit: 1, delete: 2, create: 3 };
const textOut = (o) => (o == null ? '' : typeof o === 'string' ? o : typeof o.preview === 'string' ? o.preview : JSON.stringify(o));

/** The files one tool call touched → [{ path, node, mark: read | edit | create | delete | write }] ('write' = Write, resolved later). */
function touchesOf(s) {
  const base = toolBase(s.name);
  const node = inputField(s.input, 'node') || '';
  if (FILE_TOOLS[base]) {
    const p = inputField(s.input, 'file_path') || inputField(s.input, 'notebook_path') || inputField(s.input, 'path');
    return p ? [{ path: String(p), node: base.startsWith('mesh_') ? String(node) : '', mark: FILE_TOOLS[base] }] : [];
  }
  if (base === 'file_change' || base === 'apply_patch') { // Codex: [{ path, kind: 'add' | 'update' | 'delete' | { type } }]
    const list = Array.isArray(s.input) ? s.input : Array.isArray(s.input?.changes) ? s.input.changes : [];
    return list.filter((c) => c?.path).map((c) => { const k = typeof c.kind === 'string' ? c.kind : c.kind?.type; return { path: String(c.path), node: '', mark: k === 'add' ? 'create' : k === 'delete' ? 'delete' : 'edit' }; });
  }
  return [];
}

/** A path for display: the home folder as ~, split into the file's name and its folder. */
export function splitPath(p) {
  const s = redact(String(p)).replace(/^\/(?:Users|home)\/[^/]+(?=\/|$)/, '~').replace(/^[A-Z]:\\Users\\[^\\]+/i, '~');
  const i = Math.max(s.lastIndexOf('/'), s.lastIndexOf('\\'));
  return { name: i >= 0 ? s.slice(i + 1) || s : s, dir: i > 0 ? s.slice(0, i) : '' };
}

/**
 * The files a scope touched, newest touch first → { files: [{ key, path, node, name, dir, mark, count, at, error }],
 * total }. The mark is the strongest thing done to the file (create > delete > edit > read); a Write is a create when
 * its result says so (or the file was not seen before) and an edit otherwise. At most `max` files. Pure.
 */
export function filesTouched(spans, { max = ACTIVITY_LIMITS.files } = {}) {
  const files = new Map();
  for (const s of spans.filter((x) => x.kind === 'tool-call').sort(byStart)) {
    for (const t of touchesOf(s)) {
      const key = `${t.node}:${t.path}`;
      const f = files.get(key);
      let mark = t.mark;
      if (mark === 'write') { const out = textOut(s.output); mark = /\bcreated\b/i.test(out) ? 'create' : /updated|overwr/i.test(out) || f ? 'edit' : 'create'; }
      if (!f) files.set(key, { key, path: redact(t.path), node: t.node, ...splitPath(t.path), mark, count: 1, at: s.start, error: s.status === 'error' });
      else Object.assign(f, { count: f.count + 1, at: Math.max(f.at, s.start), mark: MARK_RANK[mark] > MARK_RANK[f.mark] ? mark : f.mark, error: s.status === 'error' });
    }
  }
  const all = [...files.values()].sort((a, b) => b.at - a.at);
  return { files: all.slice(0, max), total: all.length };
}

/** What a tool call was aimed at, short and redacted: its file, command, pattern, query or URL. */
export function toolTarget(s) {
  const base = toolBase(s.name);
  const f = (k) => inputField(s.input, k);
  const node = f('node');
  const touched = touchesOf(s);
  if (touched.length) { // the file's own name must survive a narrow row: its last three path segments
    const parts = splitPath(touched[0].path);
    const segs = (parts.dir ? `${parts.dir}/${parts.name}` : parts.name).split(/[\\/]/);
    const tail = (segs.length > 3 ? '…/' : '') + segs.slice(-3).join('/');
    return safe((node && base.startsWith('mesh_') ? node + ':' : '') + tail + (touched.length > 1 ? ` +${touched.length - 1}` : ''), 90);
  }
  if (typeof s.input === 'string') return safe(s.input.split('\n')[0], 90);
  const v = f('command') || f('pattern') || f('query') || f('url') || f('description') || f('prompt') || f('goal') || f('title') || f('id');
  if (v != null) return safe((node ? node + ': ' : '') + String(v).split('\n')[0], 90);
  return node ? safe(node, 90) : '';
}

/** A short, redacted summary of a tool call's result ('' while it runs). */
export function toolSummary(s) {
  if (s.status === 'running') return '';
  const base = toolBase(s.name);
  const out = textOut(s.output);
  if (!out.trim()) return s.status === 'stopped' ? 'no result recorded' : s.status === 'error' ? 'failed' : 'done';
  if (s.status !== 'error') {
    if (base === 'Read' || base === 'mesh_read_file') { const n = out.split('\n').length; return `${n} line${n === 1 ? '' : 's'}${s.meta?.truncated?.includes('output') ? '+' : ''}`; }
    if (base === 'Write' || base === 'mesh_write_file') return /\bcreated\b/i.test(out) ? 'created' : 'written';
    if (base === 'Edit' || base === 'MultiEdit' || base === 'NotebookEdit') return 'edited';
  }
  const line = out.split('\n').map((l) => l.trim()).find((l) => l && !/^[{}[\]]+$/.test(l)) || out;
  return safe(line, 100);
}

const CALL_STATUS = { running: 'running', ok: 'ok', error: 'error', stopped: 'stopped', skipped: 'stopped' };

/**
 * The tool calls of a scope, newest first → { calls: [{ id, name, target, status: running | ok | error | stopped,
 * summary, at, durationMs, node }], total, running, errors }, at most `max`. Pure.
 */
export function toolCalls(spans, { max = ACTIVITY_LIMITS.tools } = {}) {
  const all = spans.filter((s) => s.kind === 'tool-call').sort((a, b) => (b.start || 0) - (a.start || 0));
  const calls = all.slice(0, max).map((s) => ({
    id: s.spanId, name: safe(toolBase(s.name), 40), target: toolTarget(s), status: CALL_STATUS[s.status] || 'ok', summary: toolSummary(s),
    at: s.start, durationMs: s.end != null ? Math.max(0, s.end - s.start) : null, node: s.node || '',
  }));
  return { calls, total: all.length, running: all.filter((s) => s.status === 'running').length, errors: all.filter((s) => s.status === 'error').length };
}

/**
 * Everything the window shows about a scope, from its spans: { title, kind: request | project | task, steps, done,
 * total, tasks: { done, total } | null, current (the running step's label), files, filesTotal, tools, toolsTotal,
 * toolsRunning, toolErrors, active, lastAt } — or null when the scope has no spans yet. Pure.
 */
export function activityOf(spans, { now = Date.now(), files: maxFiles, tools: maxTools } = {}) {
  if (!spans?.length) return null;
  const intake = spans.find((s) => s.kind === 'intake');
  const run = spans.find((s) => s.kind === 'task' && s.meta?.projectName) || spans.find((s) => s.meta?.projectName);
  const plan = spans.find((s) => s.kind === 'plan');
  const project = run?.meta?.projectName || (plan ? String(plan.name).replace(/^plan\s+/, '') : '');
  const text = intake ? (typeof intake.input === 'string' ? intake.input : intake.input?.text || intake.input?.message || '') : '';
  const steps = stepsOf(spans);
  const taskSteps = steps.filter((s) => s.task);
  const f = filesTouched(spans, { max: maxFiles });
  const t = toolCalls(spans, { max: maxTools });
  const running = [...steps].reverse().find((s) => s.status === 'running');
  return {
    title: safe(project || text || spans[0].name || 'Work', 140),
    request: project && text ? safe(text, 200) : '',
    kind: project ? 'project' : intake ? 'request' : 'task',
    steps, done: steps.filter((s) => s.status === 'ok').length, total: steps.length,
    tasks: taskSteps.length ? { done: taskSteps.filter((s) => s.status === 'ok').length, total: taskSteps.length } : null,
    current: running ? running.label : (t.calls[0]?.status === 'running' ? `${t.calls[0].name} ${t.calls[0].target}`.trim() : ''),
    files: f.files, filesTotal: f.total, tools: t.calls, toolsTotal: t.total, toolsRunning: t.running, toolErrors: t.errors,
    active: isActive(spans, now), lastAt: lastAtOf(spans),
  };
}

/**
 * Should a card's p5 sketch move? Never with the setting off, when nothing is working, while the window is hidden,
 * under reduced motion, on a low-power device or in Document view — the still frame is drawn instead. 'auto' animates
 * only the card of the stage running now (the newest card of a live document: its motion says "this is happening");
 * 'always' animates every visible card while work runs. Pure.
 */
export function shouldAnimate({ mode = 'auto', active = false, hidden = false, reducedMotion = false, lowPower = false, documentView = false, current = false } = {}) {
  const m = animMode(mode);
  if (m === 'off' || !active || hidden || reducedMotion || lowPower || documentView) return false;
  return m === 'always' || !!current;
}
