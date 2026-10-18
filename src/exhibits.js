import crypto from 'node:crypto';
import { EventEmitter } from 'node:events';
import fsp from 'node:fs/promises';
import path from 'node:path';
import { config, RIGS_HOME, saveConfig } from './config.js';
import { isTraceId, redact, redactValue } from './trace.js';
import { log } from './util.js';

/**
 * Exhibits (experimental, opt-in through config.exhibits): an illustrated running account of the work done for one
 * request from Sir (scope "request", docId = its traceId) and for one project (scope "project", docId "pr-<projectId>").
 *
 * Sources: the request-trace span stream (trace.events 'span', the same feed as the UI's live 'trace-span' push) and
 * the planner's project saves (planner.onProjectSaved: task done/failed/blocked, project done). Each turns into
 * exhibit entries:
 *   { docId, scope, traceId | projectId, seq, id, kind (intake|plan|step|code|result|milestone|summary), title,
 *     caption (short plain English, redacted), visual (a visual.js block: steps|code|metrics|status), image
 *     { src, alt, source: 'svg'|'comfyui'|'screenshot' } | null, at }
 *
 * Storage: append-only JSONL, RIGS_HOME/exhibits/<docId>.jsonl. Records: { t:'meta', … } (title, scope, ids),
 * { t:'entry', … }, { t:'image', id, image } (a ComfyUI picture swapped in for an entry's SVG), { t:'final', at }.
 * Reading folds them with mergeIntoDocument — the same pure function the writer uses — so a file replays exactly.
 * ComfyUI images are saved beside it in RIGS_HOME/exhibits/<docId>/<file>.png.
 *
 * Rules: nothing here runs on the request path. The span listener only queues; the work happens on a promise chain
 * after the current tick, and every failure is logged and dropped. With exhibits disabled (the default) the listener
 * returns at once and nothing is written. Every caption and visual goes through trace.redact / redactValue.
 */

export const ENTRY_KINDS = ['intake', 'plan', 'step', 'code', 'result', 'milestone', 'summary'];
export const IMAGE_MODES = ['auto', 'svg', 'comfyui', 'off'];
export const DEFAULTS = Object.freeze({ enabled: false, images: 'auto', maxPerDoc: 60, maxDocs: 200 });
export const events = new EventEmitter();
events.setMaxListeners(50);

/** config.exhibits with defaults applied. Pure. */
export function settings(cfg = config()) {
  const e = { ...DEFAULTS, ...(cfg?.exhibits || {}) };
  return {
    enabled: e.enabled === true,
    images: IMAGE_MODES.includes(e.images) ? e.images : DEFAULTS.images,
    maxPerDoc: Math.min(500, Math.max(5, Math.round(Number(e.maxPerDoc)) || DEFAULTS.maxPerDoc)),
    maxDocs: Math.min(5000, Math.max(10, Math.round(Number(e.maxDocs)) || DEFAULTS.maxDocs)),
  };
}

/** A settings patch from the API → the new config.exhibits (throws on bad values). Pure. */
export function applyConfigPatch(cur, patch = {}) {
  const next = settings({ exhibits: cur });
  if (patch.enabled !== undefined) next.enabled = patch.enabled === true || patch.enabled === 'true';
  if (patch.images !== undefined) {
    if (!IMAGE_MODES.includes(patch.images)) throw new Error(`images must be one of ${IMAGE_MODES.join(', ')}`);
    next.images = patch.images;
  }
  if (patch.maxPerDoc !== undefined) {
    const n = Number(patch.maxPerDoc);
    if (!Number.isFinite(n) || n < 5 || n > 500) throw new Error('maxPerDoc must be a number from 5 to 500');
    next.maxPerDoc = Math.round(n);
  }
  if (patch.maxDocs !== undefined) {
    const n = Number(patch.maxDocs);
    if (!Number.isFinite(n) || n < 10 || n > 5000) throw new Error('maxDocs must be a number from 10 to 5000');
    next.maxDocs = Math.round(n);
  }
  return next;
}

export const projectDocId = (projectId) => `pr-${String(projectId)}`;
export const isDocId = (s) => isTraceId(s) || /^pr-[\w-]{1,48}$/.test(String(s || ''));

// ---------------------------------------------------------------- spans → entries (pure)

const clip = (s, n) => { const t = String(s ?? '').replace(/\s+/g, ' ').trim(); return t.length > n ? t.slice(0, n - 1) + '…' : t; };
const textOf = (v) => (typeof v === 'string' ? v : v?.text ?? v?.reply ?? v?.preview ?? v?.summary ?? v?.error ?? '');
const safe = (s, n = 220) => clip(redact(s), n);
const secs = (ms) => (ms >= 60000 ? `${Math.round(ms / 6000) / 10} min` : `${Math.round(ms / 100) / 10} s`);
const durOf = (s) => (s.end && s.start ? s.end - s.start : 0);
const EDIT_TOOLS = /^(Edit|Write|MultiEdit|NotebookEdit|apply_patch|file_change|str_replace_editor|create_file)$/i;
const LANGS = { js: 'javascript', mjs: 'javascript', cjs: 'javascript', ts: 'typescript', tsx: 'tsx', jsx: 'jsx', py: 'python', cs: 'csharp', rs: 'rust', go: 'go', md: 'markdown', json: 'json', css: 'css', html: 'html', sh: 'bash', yml: 'yaml', yaml: 'yaml' };

/** An entry draft with every text field redacted (visual deeply). */
function draft(span, phase, kind, title, caption, visual, extra = {}) {
  return {
    id: `${span.spanId}:${phase}`, kind, title: safe(title, 90), caption: safe(caption, 240),
    visual: visual ? redactValue(visual) : null, at: phase === 'start' ? span.start : (span.end || span.start), ...extra,
  };
}

/**
 * One trace span → the exhibit entries it makes, as drafts { id, kind, title, caption, visual, at, final? } — usually
 * zero or one. Spans arrive twice (start, then end; last line wins in the trace store), so each draft's id names the
 * span and the phase and repeats are dropped by mergeIntoDocument. What makes an entry:
 *   intake start → intake; intake end → result (the reply) + final for the request document;
 *   router end → step (the route); brain-turn end → step; an editing tool call end → code; handoff end → milestone;
 *   plan end → plan; dispatch end → step; task start → step (a run began); event (retry/escalate/failed) → step.
 * Assistant messages, other tool calls and gap spans make none (too fine-grained for an exhibit). Pure.
 */
export function spanToExhibit(span) {
  if (!span || typeof span !== 'object' || !span.spanId) return [];
  const m = span.meta || {};
  const ended = span.end != null && span.status !== 'running';
  const failed = span.status === 'error';
  switch (span.kind) {
    case 'intake': {
      if (!ended) {
        const text = textOf(span.input);
        return [draft(span, 'start', 'intake', 'Request received', `Sir asked: “${clip(text, 160)}”`,
          { kind: 'steps', title: 'Request', items: [{ text: 'Received', done: true }, { text: 'Route', status: 'running' }, { text: 'Work' }, { text: 'Reply' }] })];
      }
      const reply = textOf(span.output);
      const caption = failed ? `The request ended with an error: ${clip(reply || 'no reply', 160)}`
        : span.status === 'stopped' ? 'The request was stopped before a full reply.'
          : reply ? `JARVIS replied: “${clip(reply, 180)}”` : `JARVIS finished in ${secs(durOf(span))}.`;
      return [draft(span, 'end', 'result', failed ? 'Request failed' : 'Reply delivered', caption,
        { kind: 'metrics', title: 'Request', items: [{ label: 'Time', value: Math.round(durOf(span) / 100) / 10, unit: ' s', max: Math.max(10, Math.ceil(durOf(span) / 1000)) }] }, { final: true })];
    }
    case 'router': {
      if (!ended) return [];
      if (span.status === 'skipped' || m.preroute === false) {
        return [draft(span, 'end', 'step', 'Sent straight to JARVIS', 'Pre-routing is off, so the request went directly to the JARVIS brain.', { kind: 'status', title: 'Route', items: [{ name: 'route', value: 'direct', state: 'ok' }] })];
      }
      const route = m.route || textOf(span.output) || 'decided';
      const why = m.reason ? ` because ${clip(m.reason, 120)}` : '';
      const items = [{ name: 'route', value: String(route), state: failed ? 'err' : 'ok' }, ...(m.via ? [{ name: 'via', value: String(m.via) }] : []), ...(m.routerMs ? [{ name: 'time', value: `${m.routerMs} ms` }] : [])];
      return [draft(span, 'end', 'step', `Routed: ${route}`, `The router classified the request as “${route}”${m.via ? ` (${m.via})` : ''}${why}.`, { kind: 'status', title: 'Route', items }, { projectId: m.projectId || undefined })];
    }
    case 'brain-turn': {
      const who = [m.model || span.name, m.effort].filter(Boolean).join(' · ');
      if (!ended) {
        // Shown as soon as the turn starts: a long turn must not leave the window silent.
        return [draft(span, 'start', 'step', 'Thinking…', `${who || 'The brain'} is working on it.`,
          { kind: 'steps', title: who || 'Brain turn', items: [{ text: 'Read the request', done: true }, { text: 'Think', status: 'running' }, { text: 'Reply' }] })];
      }
      const tok = (Number(m.inputTokens) || 0) + (Number(m.outputTokens) || 0);
      const items = [{ label: 'Time', value: Math.round(durOf(span) / 100) / 10, unit: ' s', max: Math.max(10, Math.ceil(durOf(span) / 1000)) }];
      if (tok) items.push({ label: 'Tokens', value: tok, max: Math.max(1000, tok) });
      return [draft(span, 'end', 'step', failed ? 'Brain turn failed' : 'JARVIS thought it through', `${who || 'The brain'} worked for ${secs(durOf(span))}${tok ? ` using ${tok.toLocaleString('en-US')} tokens` : ''}.`, { kind: 'metrics', title: who || 'Brain turn', items })];
    }
    case 'tool-call': {
      if (!ended || !EDIT_TOOLS.test(span.name || '')) return [];
      const inp = span.input && typeof span.input === 'object' ? span.input : {};
      const file = String(inp.file_path || inp.path || inp.notebook_path || inp.file || '');
      const body = String(inp.new_string ?? inp.content ?? inp.patch ?? inp.new_source ?? (Array.isArray(inp.edits) ? inp.edits.map((e) => e.new_string).join('\n') : '') ?? '');
      const lines = body.split('\n').slice(0, 14).map((l) => clip(l, 120));
      const base = file.split(/[\\/]/).pop() || span.name;
      return [draft(span, 'end', 'code', `Edited ${base}`, `${failed ? 'Tried to change' : 'Changed'} ${base}${lines.length > 1 ? ` (${body.split('\n').length} lines)` : ''}.`,
        { kind: 'code', file: base, language: LANGS[(base.split('.').pop() || '').toLowerCase()] || '', code: lines.join('\n') })];
    }
    case 'handoff': {
      if (!ended) return [];
      const goal = span.input?.goal || span.input?.title || span.input?.instruction || '';
      const tasks = m.taskIds || [];
      return [draft(span, 'end', 'milestone', failed ? 'Filing work failed' : 'Work filed', failed ? `Handing the work over failed: ${clip(textOf(span.output), 140)}`
        : `JARVIS handed the work on${goal ? `: ${clip(goal, 140)}` : ''}${m.projectId ? ` (project ${m.projectId}${tasks.length ? `, ${tasks.length} task${tasks.length === 1 ? '' : 's'}` : ''})` : ''}.`,
      { kind: 'status', title: 'Handoff', items: [{ name: span.name || 'handoff', value: failed ? 'failed' : 'filed', state: failed ? 'err' : 'ok' }, ...(m.owner ? [{ name: 'owner', value: m.owner }] : [])] }, { projectId: m.projectId || undefined })];
    }
    case 'plan': {
      if (!ended) return [];
      const tasks = Array.isArray(span.output?.tasks) ? span.output.tasks : [];
      const summary = span.output?.summary || '';
      return [draft(span, 'end', 'plan', failed ? 'Planning failed' : `Plan: ${tasks.length} task${tasks.length === 1 ? '' : 's'}`,
        failed ? `Planning failed: ${clip(textOf(span.output), 140)}` : summary ? clip(summary, 220) : `The work was broken into ${tasks.length} task${tasks.length === 1 ? '' : 's'}.`,
        { kind: 'steps', title: span.name || 'Plan', items: tasks.slice(0, 12).map((t) => ({ text: `${t.id}: ${clip(t.title, 80)}` })) }, { projectId: m.projectId || undefined })];
    }
    case 'dispatch': {
      if (!ended) return [];
      const inp = span.input || {};
      const t = inp.task || {};
      const who = [inp.provider, inp.model].filter(Boolean).join(' ');
      return [draft(span, 'end', 'step', failed ? `${t.id || m.taskId} could not start` : `${t.id || m.taskId} sent to ${m.target || inp.node}`,
        failed ? `Starting ${t.id || 'the task'} on ${m.target || inp.node} failed: ${clip(textOf(span.output), 140)}`
          : `“${clip(t.title, 100)}” went to ${m.target || inp.node}${who ? ` (${who})` : ''}${m.attempt > 1 ? `, attempt ${m.attempt}` : ''}.`,
        { kind: 'status', title: 'Dispatch', items: [{ name: t.id || m.taskId || 'task', value: m.target || inp.node || '', state: failed ? 'err' : 'ok' }, ...(who ? [{ name: 'agent', value: who }] : [])] }, { projectId: m.projectId || undefined })];
    }
    case 'task': {
      if (ended) return []; // its outcome comes from the project save (projectToExhibits), which knows the reported summary
      const t = span.input?.task || {};
      return [draft(span, 'start', 'step', `${t.id || m.taskId} started`, `${m.seat || m.model || 'An agent'} began “${clip(t.title, 110)}” on ${span.node}.`,
        { kind: 'steps', title: t.id || 'Task', items: [{ text: 'Started', done: true }, { text: clip(t.title, 70), status: 'running' }, { text: 'Report' }] }, { projectId: m.projectId || undefined })];
    }
    case 'event': {
      if (!/retry|escalat|fail|question|answer|stuck|ladder/i.test(span.name || '') && !failed) return [];
      return [draft(span, 'end', 'step', clip(span.name, 80), `${m.taskId ? `${m.taskId}: ` : ''}${clip(textOf(span.output) || textOf(span.input) || span.name, 200)}`,
        { kind: 'status', title: 'Event', items: [{ name: m.taskId || 'project', value: clip(span.name, 40), state: failed ? 'err' : 'warn' }] }, { projectId: m.projectId || undefined })];
    }
    default: return [];
  }
}

const toolName = (n) => String(n || '').replace(/^mcp__[^_]+(?:_[^_]+)*?__/, '').replace(/_/g, ' ');

/**
 * The live "now" line for a stage that just started: a short present-tense status the window shows at once (it is not
 * stored; the entries are the record). null when the span is not running or is too fine to mention. Redacted. Pure.
 */
export function liveLine(span) {
  if (!span?.spanId || span.end != null || span.status !== 'running') return null;
  const m = span.meta || {};
  const t = span.input?.task || {};
  const text = {
    intake: () => 'Request received — on it.',
    router: () => 'Working out where this goes…',
    'brain-turn': () => `Thinking with ${m.model || span.name || 'the brain'}…`,
    'tool-call': () => `Using ${clip(toolName(span.name), 40)}${span.input?.file_path ? ` on ${String(span.input.file_path).split(/[\\/]/).pop()}` : ''}…`,
    handoff: () => 'Filing the work…',
    plan: () => 'Drawing up the plan…',
    dispatch: () => `Sending ${t.id || m.taskId || 'a task'} to ${m.target || span.input?.node || 'a machine'}…`,
    task: () => `${t.id || m.taskId || 'A task'} is running on ${span.node}…`,
  }[span.kind];
  return text ? { docId: span.traceId, kind: span.kind, text: safe(text(), 120), at: span.start || Date.now() } : null;
}

/**
 * A project's saved state against the last one seen → entry drafts (task reached done/failed/blocked; project done →
 * summary + final). `prev` null = first sight: nothing (a baseline only, so a restart does not replay history). Pure.
 */
export function projectToExhibits(prev, next) {
  if (!prev || !next || next.main) return [];
  const out = [];
  const at = next.updatedAt || Date.now();
  const before = new Map((prev.tasks || []).map((t) => [t.id, t]));
  for (const t of next.tasks || []) {
    const old = before.get(t.id);
    if (!['done', 'failed', 'blocked'].includes(t.status) || old?.status === t.status) continue;
    const ok = t.status === 'done';
    out.push({
      id: `task:${t.id}:${t.status}:${t.attempts || 0}`, kind: ok ? 'result' : 'milestone', at,
      title: safe(`${t.id} ${ok ? 'done' : t.status}: ${t.title}`, 90),
      caption: safe(t.summary ? clip(t.summary, 230) : `${t.title} is ${t.status}.`, 240),
      visual: redactValue({ kind: 'status', title: t.id, items: [{ name: t.id, value: t.status, state: ok ? 'ok' : 'err' }, ...(t.assign?.node ? [{ name: 'machine', value: t.assign.node }] : []), ...(t.assign?.model ? [{ name: 'model', value: t.assign.model }] : [])] }),
    });
  }
  if (next.status === 'done' && prev.status !== 'done') {
    const tasks = next.tasks || [];
    out.push({
      id: `project:done:${at}`, kind: 'summary', at, final: true, title: safe(`${next.name || 'Project'} complete`, 90),
      caption: safe(`All ${tasks.length} task${tasks.length === 1 ? '' : 's'} done. ${next.summary ? clip(next.summary, 160) : clip(next.goal || '', 160)}`, 240),
      visual: redactValue({ kind: 'steps', title: next.name || 'Project', items: tasks.slice(0, 12).map((t) => ({ text: `${t.id}: ${clip(t.title, 70)}`, done: t.status === 'done' })) }),
    });
  }
  return out;
}

/**
 * A project's whole story from its current saved state → entry drafts, for a project that was already running when
 * exhibits came on (live saves only grow a document from diffs, so it has none). The same drafts the live path makes
 * where it can — task outcomes and project done come from projectToExhibits(empty → current), with the same ids — plus
 * an intake and a plan entry from the request and goal, and a step per task that has started (or still waits). Ids are
 * fixed per project, so mergeIntoDocument drops repeats: attaching twice adds nothing, and later live saves append.
 * Times come from the project's log where it names them. Order: intake, plan, the rest by time, the final summary last. Pure.
 */
export function projectBackfill(project) {
  if (!project?.id || project.main) return [];
  const tasks = project.tasks || [];
  const log = Array.isArray(project.log) ? project.log : [];
  const created = project.createdAt || project.updatedAt || Date.now();
  const logAt = (re) => { const l = [...log].reverse().find((x) => re.test(String(x?.text || ''))); return Number(l?.ts) || 0; };
  const esc1 = (id) => String(id).replace(/[^\w-]/g, '\\$&');
  const out = [];
  const request = project.request || project.goal || '';
  out.push({
    id: 'backfill:intake', kind: 'intake', at: created, title: safe('Request received', 90),
    caption: safe(`Sir asked: “${clip(request, 160)}”`, 240),
    visual: redactValue({ kind: 'steps', title: 'Request', items: [{ text: 'Received', done: true }, { text: 'Plan', done: tasks.length > 0 }, { text: 'Work', ...(project.status === 'done' ? { done: true } : { status: 'running' }) }, { text: 'Reply', done: project.status === 'done' }] }),
  });
  out.push({
    id: 'backfill:plan', kind: 'plan', at: logAt(/^planned \d+ tasks?/) || created + 1,
    title: safe(`Plan: ${tasks.length} task${tasks.length === 1 ? '' : 's'}`, 90),
    caption: safe(project.summary ? clip(project.summary, 220) : `The work was broken into ${tasks.length} task${tasks.length === 1 ? '' : 's'}.`, 240),
    visual: redactValue({ kind: 'steps', title: project.name || 'Plan', items: tasks.slice(0, 12).map((t) => ({ text: `${t.id}: ${clip(t.title, 80)}` })) }),
  });
  const mid = [];
  for (const t of tasks) {
    const started = t.run?.startedAt || logAt(new RegExp(`^${esc1(t.id)} started`));
    const where = t.run?.seat || t.assign?.model || t.assign?.provider || 'An agent';
    if (started || t.status !== 'todo') {
      const at = started || project.updatedAt || created;
      mid.push({
        id: `backfill:${t.id}:start`, kind: 'step', at, title: safe(`${t.id} started`, 90),
        caption: safe(`${where} began “${clip(t.title, 110)}”${t.assign?.node ? ` on ${t.assign.node}` : ''}.`, 240),
        visual: redactValue({ kind: 'steps', title: t.id, items: [{ text: 'Started', done: true }, { text: clip(t.title, 70), ...(t.status === 'running' ? { status: 'running' } : { done: true }) }, { text: 'Report', done: ['done', 'failed', 'blocked'].includes(t.status) }] }),
      });
    } else {
      const deps = Array.isArray(t.deps) ? t.deps : [];
      mid.push({
        id: `backfill:${t.id}:queued`, kind: 'step', at: project.updatedAt || created, title: safe(`${t.id} waiting`, 90),
        caption: safe(`“${clip(t.title, 110)}” had not started yet${deps.length ? `; it waits for ${deps.join(', ')}` : ''}.`, 240),
        visual: redactValue({ kind: 'status', title: t.id, items: [{ name: t.id, value: 'queued', state: 'warn' }, ...(deps.length ? [{ name: 'after', value: deps.join(', ') }] : [])] }),
      });
    }
  }
  let final = null;
  for (const d of projectToExhibits({ tasks: [], status: 'planning' }, project)) {
    const m = /^task:([\w-]+):(done|failed|blocked):/.exec(d.id);
    const at = m ? logAt(new RegExp(`^${esc1(m[1])} → ${m[2]}`)) || d.at : d.at;
    if (d.final) final = { ...d, at }; else mid.push({ ...d, at });
  }
  mid.sort((a, b) => a.at - b.at); // stable: equal times keep task order
  return [...out, ...mid, ...(final ? [final] : [])];
}

// ---------------------------------------------------------------- documents (pure)

export const emptyDoc = (docId) => ({ docId, scope: isTraceId(docId) ? 'request' : 'project', title: '', traceId: isTraceId(docId) ? docId : undefined, projectId: isTraceId(docId) ? undefined : docId.slice(3), entries: [], final: false, finalAt: null, created: null, updated: null, dropped: 0 });

/**
 * Fold one record into a document; returns { doc, changed, entry } (entry = the stored entry when one was added).
 * Records: { t:'meta', title?, traceId?, projectId? } | { t:'entry', …draft } | { t:'image', id, image } | { t:'final', at }.
 * Entries are deduplicated by id and numbered (seq) in arrival order. A final document takes no new entries (images
 * may still land). Past maxPerDoc only final entries are kept (and `dropped` counts the rest). An entry with
 * final: true also finalizes the document. Pure: returns a new doc, never mutates the input.
 */
export function mergeIntoDocument(doc, rec, { maxPerDoc = DEFAULTS.maxPerDoc } = {}) {
  const t = rec?.t || 'entry';
  const at = Number(rec?.at) || Date.now();
  const same = { doc, changed: false, entry: null };
  if (t === 'meta') {
    const next = { ...doc, created: doc.created ?? at, updated: Math.max(doc.updated || 0, at) };
    if (rec.title && !doc.title) next.title = safe(rec.title, 120);
    if (rec.traceId && !doc.traceId) next.traceId = rec.traceId;
    if (rec.projectId && !doc.projectId) next.projectId = rec.projectId;
    return { doc: next, changed: true, entry: null };
  }
  if (t === 'final') return doc.final ? same : { doc: { ...doc, final: true, finalAt: at, updated: Math.max(doc.updated || 0, at) }, changed: true, entry: null };
  if (t === 'image') {
    const i = doc.entries.findIndex((e) => e.id === rec.id);
    if (i < 0 || !rec.image?.src) return same;
    const entries = doc.entries.slice();
    entries[i] = { ...entries[i], image: rec.image };
    return { doc: { ...doc, entries }, changed: true, entry: entries[i] };
  }
  if (!rec?.id || doc.final || doc.entries.some((e) => e.id === rec.id)) return same;
  if (doc.entries.length >= maxPerDoc && !rec.final) return { doc: { ...doc, dropped: (doc.dropped || 0) + 1 }, changed: true, entry: null };
  const entry = {
    docId: doc.docId, scope: doc.scope, ...(doc.traceId ? { traceId: doc.traceId } : {}), ...(doc.projectId ? { projectId: doc.projectId } : {}),
    seq: doc.entries.length + 1, id: String(rec.id), kind: ENTRY_KINDS.includes(rec.kind) ? rec.kind : 'step',
    title: String(rec.title || ''), caption: String(rec.caption || ''), visual: rec.visual || null, image: rec.image || null, at,
  };
  const next = { ...doc, entries: [...doc.entries, entry], created: doc.created ?? at, updated: Math.max(doc.updated || 0, at) };
  if (rec.final) Object.assign(next, { final: true, finalAt: at });
  return { doc: next, changed: true, entry };
}

/** JSONL text → document (bad lines skipped). Pure. */
export function parseDocument(docId, text, opts = {}) {
  let doc = emptyDoc(docId);
  for (const line of String(text || '').split('\n')) {
    if (!line.trim()) continue;
    let rec;
    try { rec = JSON.parse(line); } catch { continue; }
    doc = mergeIntoDocument(doc, rec, { maxPerDoc: Infinity, ...opts }).doc;
  }
  return doc;
}

/** Summary row for the list endpoint. Pure. */
export const docSummary = (d) => ({ docId: d.docId, scope: d.scope, title: d.title, traceId: d.traceId, projectId: d.projectId, entries: d.entries.length, final: d.final, finalAt: d.finalAt, created: d.created, updated: d.updated, kinds: [...new Set(d.entries.map((e) => e.kind))] });

// ---------------------------------------------------------------- images: themed SVG (pure, deterministic)

const GLYPH = {
  intake: '<path d="M-26 -16h52v30h-30l-14 12v-12h-8z" fill="none" stroke="currentColor" stroke-width="4" stroke-linejoin="round"/><circle cx="-10" cy="-1" r="3"/><circle cx="0" cy="-1" r="3"/><circle cx="10" cy="-1" r="3"/>',
  plan: '<rect x="-24" y="-26" width="48" height="56" rx="6" fill="none" stroke="currentColor" stroke-width="4"/><path d="M-14 -10h28M-14 2h28M-14 14h18" stroke="currentColor" stroke-width="4" stroke-linecap="round"/>',
  step: '<path d="M-24 0h40M4 -14l14 14-14 14" fill="none" stroke="currentColor" stroke-width="5" stroke-linecap="round" stroke-linejoin="round"/>',
  code: '<path d="M-12 -18l-16 18 16 18M12 -18l16 18-16 18M5 -24l-10 48" fill="none" stroke="currentColor" stroke-width="4.5" stroke-linecap="round" stroke-linejoin="round"/>',
  result: '<circle r="26" fill="none" stroke="currentColor" stroke-width="4"/><path d="M-12 1l8 9 17-19" fill="none" stroke="currentColor" stroke-width="5" stroke-linecap="round" stroke-linejoin="round"/>',
  milestone: '<path d="M-14 28v-56M-14 -26h32l-8 12 8 12h-32" fill="none" stroke="currentColor" stroke-width="4.5" stroke-linecap="round" stroke-linejoin="round"/>',
  summary: '<path d="M0 -28l8 17 19 3-14 13 4 19L0 15l-17 9 4-19-14-13 19-3z" fill="none" stroke="currentColor" stroke-width="4" stroke-linejoin="round"/>',
};
const HUE = { intake: 196, plan: 266, step: 168, code: 140, result: 128, milestone: 38, summary: 48 };
const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

/** Words of `s` wrapped into at most `rows` lines of `width` characters (the last one ends in … when cut). */
function wrap(s, width, rows) {
  const words = String(s || '').split(/\s+/).filter(Boolean);
  const out = [];
  let cur = '';
  let i = 0;
  for (; i < words.length && out.length < rows; i++) {
    const w = words[i].length > width ? words[i].slice(0, width - 1) + '…' : words[i];
    if (cur && (cur + ' ' + w).length > width) { out.push(cur); cur = w; } else cur = cur ? cur + ' ' + w : w;
  }
  if (cur && out.length < rows) out.push(cur); else if (cur) i--;
  if (i < words.length && out.length) out[out.length - 1] = clip(out[out.length - 1], width - 1).replace(/…?$/, '…');
  return out;
}

/**
 * The deterministic illustration of an entry: a dark JARVIS-style card, a glyph by kind, the title and the document's
 * title, and an orbit pattern seeded from the entry id (same entry → same picture). Returns the SVG text. Pure.
 */
export function svgFor(entry, { docTitle = '' } = {}) {
  const kind = ENTRY_KINDS.includes(entry.kind) ? entry.kind : 'step';
  const seed = crypto.createHash('sha1').update(String(entry.id || entry.title || kind)).digest();
  const hue = (HUE[kind] + (seed[0] % 24) - 12 + 360) % 360;
  const fg = `hsl(${hue} 90% 66%)`;
  const dim = `hsl(${hue} 60% 40%)`;
  const W = 640; const H = 360;
  let orbits = '';
  for (let i = 0; i < 5; i++) {
    const r = 70 + seed[i + 1] % 120; const a = (seed[i + 6] / 255) * Math.PI * 2;
    orbits += `<circle cx="160" cy="180" r="${r}" fill="none" stroke="${dim}" stroke-opacity="${(0.18 + (seed[i + 11] % 30) / 100).toFixed(2)}" stroke-dasharray="${2 + seed[i + 2] % 8} ${4 + seed[i + 3] % 14}"/>`;
    orbits += `<circle cx="${(160 + r * Math.cos(a)).toFixed(1)}" cy="${(180 + r * Math.sin(a)).toFixed(1)}" r="${2 + seed[i + 4] % 4}" fill="${fg}" opacity="0.8"/>`;
  }
  const title = wrap(entry.title || kind, 20, 3); // 20 chars at 26px fit the 320px right of the glyph
  const sub = clip(docTitle, 44);
  return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${W} ${H}" width="${W}" height="${H}" role="img" aria-label="${esc(entry.title || kind)}">`
    + `<defs><radialGradient id="g" cx="25%" cy="50%" r="80%"><stop offset="0" stop-color="hsl(${hue} 70% 18%)"/><stop offset="1" stop-color="#05080d"/></radialGradient></defs>`
    + `<rect width="${W}" height="${H}" rx="18" fill="url(#g)"/>`
    + `<rect x="1" y="1" width="${W - 2}" height="${H - 2}" rx="17" fill="none" stroke="${dim}" stroke-opacity="0.6"/>`
    + orbits
    + `<g transform="translate(160 180) scale(1.6)" color="${fg}" fill="${fg}">${GLYPH[kind]}</g>`
    + `<text x="300" y="88" fill="${fg}" fill-opacity="0.7" font-family="ui-monospace,Menlo,Consolas,monospace" font-size="15" letter-spacing="3">${esc(kind.toUpperCase())}${entry.seq ? ` · ${String(entry.seq).padStart(2, '0')}` : ''}</text>`
    + title.map((l, i) => `<text x="300" y="${140 + i * 38}" fill="#e8f4ff" font-family="system-ui,Segoe UI,Helvetica,Arial,sans-serif" font-size="26" font-weight="600">${esc(l)}</text>`).join('')
    + (sub ? `<text x="300" y="${H - 40}" fill="${fg}" fill-opacity="0.85" font-family="system-ui,Segoe UI,Helvetica,Arial,sans-serif" font-size="16">${esc(sub)}</text>` : '')
    + '</svg>';
}

export const svgDataUri = (svg) => `data:image/svg+xml;base64,${Buffer.from(svg).toString('base64')}`;

/** The SVG image object for an entry. Pure. */
export const svgImage = (entry, docTitle = '') => ({ src: svgDataUri(svgFor(entry, { docTitle })), alt: `${entry.kind}: ${entry.title}`, source: 'svg' });

/** The txt2img prompt for an entry's illustration (built from the redacted title only). Pure. */
export function imagePrompt(entry, docTitle = '') {
  const mood = { intake: 'a glowing message arriving', plan: 'a holographic blueprint being drawn', step: 'machinery in motion', code: 'luminous code flowing on glass panels', result: 'a completed glowing artifact', milestone: 'a flag planted on a summit at dusk', summary: 'a grand finished control room' }[entry.kind] || 'abstract machinery';
  return `${mood}, about "${clip(entry.title, 80)}"${docTitle ? ` for the project "${clip(docTitle, 60)}"` : ''}, futuristic JARVIS interface style, dark background with cyan and amber light, clean editorial illustration, no text`;
}

// ---------------------------------------------------------------- export (pure)

/** A visual block as plain Markdown. */
function visualMd(v) {
  if (!v) return '';
  const items = (v.items || []).slice(0, 16);
  if (v.kind === 'code') return '```' + (v.language || '') + '\n' + String(v.code || '') + '\n```';
  if (v.kind === 'steps') return items.map((t, i) => `${i + 1}. ${t.done === true || t.status === 'done' ? '✓ ' : t.status === 'running' ? '… ' : ''}${t.text || t.label || ''}`).join('\n');
  if (v.kind === 'metrics') return items.map((m) => `- **${m.label || ''}**: ${m.value ?? 0}${m.unit || ''}`).join('\n');
  if (v.kind === 'status') return items.map((it) => `- **${it.name || ''}**: ${it.value || it.state || ''}`).join('\n');
  return '';
}

/** A visual block as static HTML (the export has no scripts; the live window uses visual.js). */
function visualHtml(v) {
  if (!v) return '';
  const items = (v.items || []).slice(0, 16);
  const cap = v.title ? `<div class="cap">${esc(v.title)}</div>` : '';
  if (v.kind === 'code') return `<div class="vz">${cap || `<div class="cap">${esc(v.file || v.language || 'code')}</div>`}<pre><code>${esc(v.code || '')}</code></pre></div>`;
  if (v.kind === 'steps') return `<div class="vz">${cap}<ol class="steps">${items.map((t) => `<li class="${t.done === true || t.status === 'done' ? 'done' : t.status === 'running' ? 'run' : ''}">${esc(t.text || t.label || '')}</li>`).join('')}</ol></div>`;
  if (v.kind === 'metrics') return `<div class="vz">${cap}<div class="metrics">${items.map((m) => `<div><b>${esc(m.value ?? 0)}${esc(m.unit || '')}</b><small>${esc(m.label || '')}</small></div>`).join('')}</div></div>`;
  if (v.kind === 'status') return `<div class="vz">${cap}<div class="tiles">${items.map((it) => `<div class="tile ${esc(it.state || 'ok')}"><b>${esc(it.name || '')}</b><small>${esc(it.value || it.state || '')}</small></div>`).join('')}</div></div>`;
  return '';
}

const when = (ms) => (ms ? new Date(ms).toISOString().replace('T', ' ').slice(0, 19) + ' UTC' : '');
const docHeading = (doc) => doc.title || (doc.scope === 'project' ? `Project ${doc.projectId}` : `Request ${doc.traceId}`);
const docLine = (doc) => `${doc.scope === 'project' ? `Project ${doc.projectId}` : `Request ${doc.traceId}`} · ${doc.entries.length} exhibit${doc.entries.length === 1 ? '' : 's'} · ${doc.final ? `final ${when(doc.finalAt)}` : 'in progress'}`;

/**
 * The document as Markdown. Images: `image(entry)` gives the src to use (default: the stored src, which is a data URI
 * for SVGs; the service passes inlined data URIs for ComfyUI pictures). Pure.
 */
export function documentToMarkdown(doc, { image = (e) => e.image?.src || '' } = {}) {
  const lines = [`# ${docHeading(doc)}`, '', `*${docLine(doc)}*`, ''];
  for (const e of doc.entries) {
    lines.push(`## ${e.seq}. ${e.title}`, '', `*${e.kind} · ${when(e.at)}*`, '');
    const src = image(e);
    if (src) lines.push(`![${String(e.image?.alt || e.title).replace(/[[\]]/g, '')}](${src})`, '');
    if (e.caption) lines.push(e.caption, '');
    const v = visualMd(e.visual);
    if (v) lines.push(v, '');
  }
  if (doc.dropped) lines.push(`*${doc.dropped} more step${doc.dropped === 1 ? '' : 's'} were left out (maxPerDoc).*`, '');
  return lines.join('\n');
}

/** The document as one self-contained HTML page (inline CSS, images as data URIs, no scripts). Pure. */
export function documentToHTML(doc, { image = (e) => e.image?.src || '' } = {}) {
  const css = `:root{color-scheme:dark;--bg:#05080d;--card:#0b131d;--line:#1d3346;--fg:#e8f4ff;--dim:#8fb3cc;--acc:#4fd1ff;--ok:#46e39a;--warn:#ffc04d;--err:#ff6b6b}
@media (prefers-color-scheme: light){:root{color-scheme:light;--bg:#f4f7fa;--card:#fff;--line:#d6e2ec;--fg:#0b1a26;--dim:#4d6a80;--acc:#0a84c7}}
*{box-sizing:border-box}body{margin:0;background:var(--bg);color:var(--fg);font:16px/1.5 system-ui,Segoe UI,Helvetica,Arial,sans-serif}
main{max-width:860px;margin:0 auto;padding:32px 16px 64px}h1{font-size:28px;margin:0 0 4px}.sub{color:var(--dim);margin:0 0 28px}
article{background:var(--card);border:1px solid var(--line);border-radius:14px;padding:18px;margin:0 0 18px;animation:in .5s ease both}
article h2{font-size:19px;margin:0 0 2px}.meta{color:var(--dim);font-size:13px;margin:0 0 12px;text-transform:uppercase;letter-spacing:.08em}
article img{width:100%;height:auto;border-radius:10px;display:block;margin:0 0 12px}.caption{margin:0 0 12px}
.vz{border-top:1px solid var(--line);padding-top:10px}.cap{color:var(--acc);font-size:13px;margin-bottom:6px}
pre{background:#02050a;color:#cfe8ff;padding:12px;border-radius:8px;overflow:auto;font:13px/1.45 ui-monospace,Menlo,Consolas,monospace}
.steps{margin:0;padding-left:22px}.steps li.done{color:var(--ok)}.steps li.run{color:var(--acc)}
.metrics,.tiles{display:flex;flex-wrap:wrap;gap:10px}.metrics div,.tile{border:1px solid var(--line);border-radius:8px;padding:8px 12px;min-width:110px}
.metrics b,.tile b{display:block}.metrics small,.tile small{color:var(--dim)}.tile.err{border-color:var(--err)}.tile.warn{border-color:var(--warn)}.tile.ok{border-color:var(--ok)}
@keyframes in{from{opacity:0;transform:translateY(8px)}to{opacity:1;transform:none}}@media (prefers-reduced-motion: reduce){article{animation:none}}`;
  const arts = doc.entries.map((e) => {
    const src = image(e);
    return `<article id="e${e.seq}"><h2>${e.seq}. ${esc(e.title)}</h2><p class="meta">${esc(e.kind)} · ${esc(when(e.at))}</p>`
      + (src ? `<img src="${esc(src)}" alt="${esc(e.image?.alt || e.title)}">` : '')
      + (e.caption ? `<p class="caption">${esc(e.caption)}</p>` : '') + visualHtml(e.visual) + '</article>';
  }).join('\n');
  return `<!doctype html>\n<html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>${esc(clip(docHeading(doc), 80))}</title><style>${css}</style></head>`
    + `<body><main><h1>${esc(docHeading(doc))}</h1><p class="sub">${esc(docLine(doc))}</p>\n${arts}\n`
    + (doc.dropped ? `<p class="sub">${doc.dropped} more step${doc.dropped === 1 ? '' : 's'} were left out (maxPerDoc).</p>` : '') + '</main></body></html>\n';
}

/** Mesh view: per-node lists → one list, newest first (a doc held by several machines is listed once per machine). Pure. */
export function aggregateExhibits(results) {
  const docs = [];
  const nodes = [];
  for (const r of results) {
    if (!r || r.error) { if (r?.node) nodes.push({ node: r.node, error: r.error || 'no answer' }); continue; }
    nodes.push({ node: r.node, docs: (r.docs || []).length, enabled: r.enabled });
    for (const d of r.docs || []) docs.push({ ...d, node: r.node });
  }
  docs.sort((a, b) => (b.updated || 0) - (a.updated || 0));
  return { docs, nodes };
}

// ---------------------------------------------------------------- the service (I/O)

const PNG_FILE = /^[\w.-]{1,120}\.png$/;

/**
 * The exhibit service. Injectable for tests: getSettings, home (where exhibits/ lives), comfy (the ComfyUI service of
 * src/comfyui.js, or null), now. handleSpan / handleProject never throw and never wait for the work they queue.
 */
export function createExhibits({ getSettings = () => settings(), home = RIGS_HOME, comfy = null, now = Date.now, comfyPollMs = 3000, comfyTimeoutMs = 10 * 60000, maxComfyPerDoc = 8 } = {}) {
  const dir = path.join(home, 'exhibits');
  const docs = new Map(); // docId → doc (cache; files are the truth)
  const spanProject = new Map(); // spanId → projectId (a handoff's children inherit its project)
  const traceTitle = new Map(); // traceId → request text
  const projects = new Map(); // projectId → last saved snapshot
  const codeCount = new Map(); // parent spanId → code entries sent to the project document
  let chain = Promise.resolve();
  const comfyQueue = [];
  let comfyBusy = null;
  let comfyProbe = { at: 0, ok: false, preset: null };
  const comfyCount = new Map(); // docId → images queued

  const file = (docId) => path.join(dir, `${docId}.jsonl`);
  const queue = (fn) => { chain = chain.then(fn).catch((e) => log('exhibits: ' + e.message)); return chain; };
  const trim = (m, n = 2000) => { if (m.size > n) for (const k of [...m.keys()].slice(0, m.size - n)) m.delete(k); };

  const sizes = new Map(); // docId → file size when this service last read or wrote it (a different size = written by someone else)
  const sizeOf = async (docId) => (await fsp.stat(file(docId)).catch(() => null))?.size ?? null;

  async function load(docId) {
    const size = await sizeOf(docId);
    if (docs.has(docId) && (size == null || sizes.get(docId) === size)) return docs.get(docId);
    // Not cached, or the file changed behind our back (a backfill script, another process): read it again.
    const text = await fsp.readFile(file(docId), 'utf8').catch(() => null);
    const doc = text == null ? null : parseDocument(docId, text);
    if (doc) { docs.set(docId, doc); sizes.set(docId, Buffer.byteLength(text)); trim(docs, 200); trim(sizes, 200); }
    return doc;
  }

  async function append(docId, rec) {
    await fsp.mkdir(dir, { recursive: true });
    await fsp.appendFile(file(docId), JSON.stringify(rec) + '\n');
    sizes.set(docId, await sizeOf(docId));
  }

  /** Retention: past maxDocs documents, the least recently written go (with their images). Never the one being written. */
  async function prune(keep) {
    const { maxDocs } = getSettings();
    const names = (await fsp.readdir(dir).catch(() => [])).filter((f) => f.endsWith('.jsonl') && isDocId(f.slice(0, -6)));
    if (names.length <= maxDocs) return;
    const stats = await Promise.all(names.map(async (f) => ({ id: f.slice(0, -6), m: (await fsp.stat(path.join(dir, f)).catch(() => null))?.mtimeMs || 0 })));
    stats.sort((a, b) => a.m - b.m);
    for (const { id } of stats.slice(0, names.length - maxDocs)) {
      if (id === keep) continue;
      docs.delete(id); comfyCount.delete(id);
      await fsp.rm(file(id), { force: true });
      await fsp.rm(path.join(dir, id), { recursive: true, force: true });
    }
  }

  /** Add one record to a document (created with a meta line when new). Returns the stored entry, if one was added. */
  async function put(docId, rec, metaRec) {
    if (metaRec?.title) metaRec = { ...metaRec, title: safe(metaRec.title, 120) };
    let doc = await load(docId);
    if (!doc) {
      const meta = { t: 'meta', at: now(), ...metaRec };
      doc = mergeIntoDocument(emptyDoc(docId), meta).doc;
      await append(docId, meta);
      await prune(docId);
    } else if (metaRec?.title && !doc.title) {
      const meta = { t: 'meta', at: now(), title: metaRec.title };
      doc = mergeIntoDocument(doc, meta).doc;
      await append(docId, meta);
    }
    docs.set(docId, doc);
    const { maxPerDoc, images } = getSettings();
    let r = mergeIntoDocument(doc, rec, { maxPerDoc });
    if (!r.changed) return null;
    if (rec.t === 'entry' && r.entry && images !== 'off') {
      // The SVG is drawn once the entry has its seq; it is stored with the entry so the file holds the picture.
      r = mergeIntoDocument(doc, { ...rec, image: svgImage(r.entry, r.doc.title) }, { maxPerDoc });
    }
    // An entry past maxPerDoc is not written (only counted in memory); entries, images and finals are.
    // Live first, disk second: the window gets the entry before the append finishes.
    docs.set(docId, r.doc);
    if (rec.t === 'entry' && r.entry) {
      try { events.emit('entry', { docId, entry: r.entry, final: r.doc.final }); } catch {}
      if (images === 'comfyui' || images === 'auto') maybeComfy(docId, r.entry, r.doc.title);
    } else if (rec.t === 'image' && r.entry) try { events.emit('image', { docId, entry: r.entry }); } catch {}
    if (r.doc.final && !doc.final) try { events.emit('final', { docId, at: r.doc.finalAt }); } catch {}
    if (rec.t !== 'entry' || r.entry) await append(docId, rec.t === 'entry' ? { ...rec, image: r.entry.image } : rec);
    return r.entry;
  }

  // ---- ComfyUI: one small txt2img at a time, only when this machine's ComfyUI answers; the SVG stays until it lands.
  async function comfyReady() {
    if (!comfy) return null;
    if (now() - comfyProbe.at < 60000) return comfyProbe.ok ? comfyProbe : null;
    comfyProbe = { at: now(), ok: false, preset: null };
    try {
      const m = await comfy.models();
      const preset = (m?.presets || [])[0];
      if (preset) comfyProbe = { at: now(), ok: true, preset: preset.id };
    } catch { /* not configured / unreachable: SVG only */ }
    return comfyProbe.ok ? comfyProbe : null;
  }
  function maybeComfy(docId, entry, docTitle) {
    if (!comfy || !['intake', 'plan', 'milestone', 'result', 'summary'].includes(entry.kind)) return;
    const n = comfyCount.get(docId) || 0;
    if (n >= maxComfyPerDoc) return;
    comfyCount.set(docId, n + 1);
    trim(comfyCount, 500);
    comfyQueue.push({ docId, entry, docTitle });
    if (comfyQueue.length > 40) comfyQueue.shift();
    if (!comfyBusy) comfyBusy = pumpComfy().finally(() => { comfyBusy = null; });
  }
  async function pumpComfy() {
    while (comfyQueue.length) {
      const job = comfyQueue.shift();
      const ready = await comfyReady();
      if (!ready) { comfyQueue.length = 0; break; }
      try { await comfyOne(job, ready); } catch (e) { log(`exhibits: comfyui image for ${job.docId}/${job.entry.id}: ${e.message}`); }
    }
  }
  async function comfyOne({ docId, entry, docTitle }, ready) {
    // submit() checks the graph against /object_info and takes the GPU-overseer lease itself.
    let j = await comfy.submit({ kind: 'txt2img', label: 'exhibit', params: { prompt: imagePrompt(entry, docTitle), preset: ready.preset, width: 768, height: 432 } });
    const until = now() + comfyTimeoutMs;
    while (!['done', 'error', 'cancelled'].includes(j.state)) {
      if (now() > until) { try { await comfy.cancel(j.id); } catch {} throw new Error('timed out'); }
      await new Promise((r) => setTimeout(r, comfyPollMs));
      j = comfy.job(j.id);
    }
    const out = j.outputs?.[0];
    if (j.state !== 'done' || !out) throw new Error(j.error?.message || j.error || `job ${j.state}`);
    const r = await comfy.view(out);
    const bytes = Buffer.from(await r.arrayBuffer());
    const name = `${entry.seq}-${crypto.createHash('sha1').update(entry.id).digest('hex').slice(0, 10)}.png`;
    await fsp.mkdir(path.join(dir, docId), { recursive: true });
    await fsp.writeFile(path.join(dir, docId, name), bytes);
    await queue(() => put(docId, { t: 'image', id: entry.id, at: now(), image: { src: `api/local/exhibits/${docId}/images/${name}`, file: name, alt: `${entry.kind}: ${entry.title}`, source: 'comfyui' } }));
  }

  // ---- inputs

  async function onSpan(span) {
    if (span.kind === 'intake' && span.input) { traceTitle.set(span.traceId, clip(textOf(span.input), 100)); trim(traceTitle); }
    let projectId = span.meta?.projectId || spanProject.get(span.parentId) || '';
    if (projectId) { spanProject.set(span.spanId, projectId); trim(spanProject); }
    for (const d of spanToExhibit(span)) {
      projectId = d.projectId || projectId;
      const { projectId: _p, ...rest } = d;
      const rec = { t: 'entry', ...rest };
      // The request's own document (a final one takes nothing more), and the project's when the span belongs to one.
      await put(span.traceId, rec, { traceId: span.traceId, title: traceTitle.get(span.traceId) || '' });
      // A task run's edits reach its project's document, a few per run (they arrive in bulk when the run ends).
      const codeOk = span.kind !== 'tool-call' || (codeCount.set(span.parentId, (codeCount.get(span.parentId) || 0) + 1).get(span.parentId) <= 3);
      if (span.kind === 'tool-call') trim(codeCount, 500);
      if (projectId && codeOk && !['intake', 'router', 'brain-turn'].includes(span.kind)) {
        const name = projects.get(projectId)?.name || span.meta?.projectName || '';
        await put(projectDocId(projectId), { ...rec, final: false }, { projectId, title: name, traceId: span.traceId });
      }
    }
  }

  async function onProject(p) {
    const prev = projects.get(p.id) || null;
    projects.set(p.id, p);
    trim(projects, 500);
    for (const d of projectToExhibits(prev, p)) await put(projectDocId(p.id), { t: 'entry', ...d }, { projectId: p.id, title: p.name || '' });
  }

  const snapshot = (p) => ({ id: p.id, main: !!p.main, status: p.status, name: p.name, goal: p.goal, summary: p.summary, updatedAt: p.updatedAt,
    tasks: (p.tasks || []).map((t) => ({ id: t.id, title: t.title, status: t.status, summary: t.summary, attempts: t.attempts, assign: t.assign ? { node: t.assign.node, model: t.assign.model } : null })) });

  return {
    dir,
    /** A span was written (trace.events 'span'). Returns at once. */
    handleSpan(span) {
      if (!span?.spanId || !getSettings().enabled) return;
      // The "now" line goes out at once, ahead of the queue and any disk work.
      const live = liveLine(span);
      if (live) try { events.emit('live', live); } catch {}
      queue(() => onSpan(span));
    },
    /** A project was saved (planner.onProjectSaved). Returns at once; the snapshot is taken now. */
    handleProject(p) {
      if (!p?.id || p.main || !getSettings().enabled) return;
      const snap = snapshot(p);
      queue(() => onProject(snap));
    },
    /**
     * Backfill a project's document from its saved state (projectBackfill) — idempotent, safe next to live saves.
     * Needs exhibits switched on (the opt-in holds). Returns { docId, added, entries, final }; throws when off or not a project.
     */
    async attach(project) {
      if (!getSettings().enabled) throw new Error('exhibits are off (Experimental › Exhibits, or POST /api/local/exhibits/config {"enabled":true})');
      if (!project?.id || project.main) throw new Error('not a project that has exhibits');
      const docId = projectDocId(project.id);
      const snap = snapshot(project);
      let result; let failure;
      await queue(async () => {
        try {
          let added = 0;
          for (const d of projectBackfill(project)) if (await put(docId, { t: 'entry', ...d }, { projectId: project.id, title: project.name || '' })) added++;
          // The next live save diffs against this state instead of being taken as a first-sight baseline.
          if (!projects.has(project.id)) { projects.set(project.id, snap); trim(projects, 500); }
          const doc = await load(docId);
          result = { docId, added, entries: doc?.entries.length || 0, final: !!doc?.final };
        } catch (e) { failure = e; throw e; }
      });
      if (failure || !result) throw failure || new Error('attach failed');
      return result;
    },
    /** Resolves when queued work is on disk (tests, export after a run). */
    flush: () => chain,
    /** Resolves when the ComfyUI queue is empty (tests). */
    comfyIdle: () => comfyBusy || Promise.resolve(),
    async list() {
      await chain;
      const files = (await fsp.readdir(dir).catch(() => [])).filter((f) => f.endsWith('.jsonl'));
      const out = [];
      for (const f of files) {
        const id = f.slice(0, -6);
        if (!isDocId(id)) continue;
        const d = await load(id);
        if (d) out.push(docSummary(d));
      }
      out.sort((a, b) => (b.updated || 0) - (a.updated || 0));
      return { node: config().name, enabled: getSettings().enabled, settings: getSettings(), docs: out };
    },
    async get(docId) {
      if (!isDocId(docId)) return null;
      await chain;
      const d = await load(docId);
      return d ? { ...d, node: config().name } : null;
    },
    /** One stored ComfyUI image: { bytes, mime } or null. */
    async image(docId, name) {
      if (!isDocId(docId) || !PNG_FILE.test(String(name))) return null;
      const bytes = await fsp.readFile(path.join(dir, docId, name)).catch(() => null);
      return bytes ? { bytes, mime: 'image/png' } : null;
    },
    /** The document as md | html with every image inlined as a data URI: { mime, body, ext } or null. */
    async exportDoc(docId, format = 'html') {
      const d = await this.get(docId);
      if (!d) return null;
      const inline = new Map();
      for (const e of d.entries) {
        if (e.image?.source !== 'comfyui') continue;
        const img = e.image.file ? await this.image(docId, e.image.file) : null;
        inline.set(e.id, img ? `data:image/png;base64,${img.bytes.toString('base64')}` : svgImage(e, d.title).src);
      }
      const image = (e) => inline.get(e.id) || e.image?.src || '';
      return format === 'md'
        ? { mime: 'text/markdown; charset=utf-8', body: documentToMarkdown(d, { image }), ext: 'md' }
        : { mime: 'text/html; charset=utf-8', body: documentToHTML(d, { image }), ext: 'html' };
    },
  };
}

/** POST /api/local/exhibits/config: patch config.exhibits and save. Returns the new settings. */
export function saveSettings(patch) {
  const cfg = config();
  cfg.exhibits = applyConfigPatch(cfg.exhibits, patch || {});
  saveConfig(cfg);
  return settings(cfg);
}
