import crypto from 'node:crypto';
import { EventEmitter } from 'node:events';
import fsp from 'node:fs/promises';
import path from 'node:path';
import { config, RIGS_HOME } from './config.js';
import { log } from './util.js';

/**
 * Request traces: every request from Sir gets one traceId at intake, and everything done for it — the router's
 * decision, each brain turn, every tool call inside it, the handoffs that file work — is a span in that trace's tree.
 *
 * Storage: append-only JSONL, RIGS_HOME/traces/<YYYY-MM-DD>.jsonl (the UTC day the span started), one span per line.
 * A span is written when it starts (status "running", end null) and again when it ends; readers keep the LAST line per
 * spanId, so a trace can be watched live while it runs. Every write is also emitted on `events` ('span'), which the
 * server pushes to the UI ({ type: 'trace-span', span }).
 *
 * Span schema (one JSON object per line):
 *   traceId   "tr-YYYYMMDD-<12 hex>" — minted at intake (newTraceId); the date is the UTC day the request came in
 *   spanId    "sp-<12 hex>"
 *   parentId  spanId of the parent span, "" for the root (the intake span)
 *   kind      intake | router | brain-turn | tool-call | handoff, and past the brain's reply: plan (the planning call)
 *             | dispatch (owner → the machine that runs a task) | task (one run of a task, on the machine that ran it)
 *             | assistant (one model message of that run) | event (retry, escalate, question, failed) | gap (mesh view
 *             only: a machine that holds part of the trace did not answer)
 *   name      what ran: "jarvis/send", "route", "claude claude-haiku-5-5", the tool name, "jarvis_task"…
 *   node      the machine that wrote the span (config().name)
 *   start     ms epoch; end: ms epoch, or null while running
 *   status    running | ok | error | stopped | skipped (a stage switched off: the router with config.router.preroute false)
 *   input     what the stage got (request text, prompt, tool args) — redacted and capped (see clean)
 *   output    what it produced (reply, tool result, decision) — redacted and capped
 *   meta      stage facts. brain-turn: { provider, model, effort, chatId, sessionId, inputTokens, outputTokens,
 *             cacheReadTokens, cacheWriteTokens, costUsd } (the same harness numbers the usage ledger files);
 *             router: { preroute, route, projectId, threadId, chatId, via (jev | model | rules), reason, routerMs, tried }; tool-call: { durationMs, toolUseId };
 *             handoff: { projectId, taskIds, owner }; plan: { provider, model, effort, node, via, routing: [{ task, node,
 *             provider, model, effort, why }] }; dispatch: { projectId, taskId, attempt, target (the machine) }; task:
 *             { projectId, taskId, attempt, provider, model, effort, mode, seat, session, gitGuard, reported, tokens… };
 *             assistant: { model, messageId, inputTokens, outputTokens, cacheReadTokens, cacheWriteTokens, toolCalls };
 *             event: { taskId, attempt, … }; truncated: ["input"|"output"] when a field was cut to the cap
 *
 * Past the brain's reply (planner.js, work.js): the planning call is a plan span (the brain turn it makes is its
 * child); each start of a task is a dispatch span on the owner, and the run itself a task span written by the machine
 * that ran it (work.startTask). When the run ends, that machine reads the run's transcript slice (the one the usage
 * ledger reads) and adds an assistant span per model message and a tool-call span per tool use (recordRunEnd).
 * Retries, model-ladder steps and automatic answers are event spans under the run.
 *
 * Rules, all here: every input/output/meta passes through clean() — secret-looking values are redacted (redact,
 * redactValue) and each field is capped at config().traces.maxField characters (cut fields are marked in
 * meta.truncated). config().traces = { enabled, days, maxField }: enabled=false writes nothing; day files older than
 * `days` are deleted by prune() (the server runs it at start and daily).
 *
 * A trace crosses process and machine boundaries as a context { traceId, parentId }: the brain's harness gets it in
 * RIGS_TRACE ("traceId:parentId"), the rigs MCP sends it back in the x-rigs-trace header and in handoff bodies, projects
 * and tasks keep it (p.trace, t.trace) and their briefs name it, so spans written later on any machine attach to the
 * same tree.
 */

export const KINDS = ['intake', 'router', 'brain-turn', 'tool-call', 'handoff', 'plan', 'dispatch', 'task', 'assistant', 'event', 'gap'];
export const STATUSES = ['running', 'ok', 'error', 'stopped', 'skipped'];
export const events = new EventEmitter();
events.setMaxListeners(50);

const DEFAULTS = { enabled: true, days: 14, maxField: 8000 };
export function settings() {
  const t = { ...DEFAULTS, ...(config().traces || {}) };
  return { enabled: t.enabled !== false, days: Math.max(1, Number(t.days) || DEFAULTS.days), maxField: Math.max(200, Number(t.maxField) || DEFAULTS.maxField) };
}

const dir = () => path.join(RIGS_HOME, 'traces');
const dayOf = (ms) => new Date(ms).toISOString().slice(0, 10);
const hex = (n) => crypto.randomBytes(n).toString('hex');

export function newTraceId(now = Date.now()) { return `tr-${dayOf(now).replace(/-/g, '')}-${hex(6)}`; }
export function newSpanId() { return `sp-${hex(6)}`; }
export const isTraceId = (s) => /^tr-\d{8}-[0-9a-f]{12}$/.test(String(s || ''));
const isSpanId = (s) => /^sp-[0-9a-f]{12}$/.test(String(s || ''));

// ---------------------------------------------------------------- redaction + caps (pure)

const SECRET_KEY = /^(?:.*[_-])?(?:pass(?:word|wd)?|secret|token|api[_-]?key|apikey|auth(?:orization)?|cookie|credentials?|private[_-]?key|session[_-]?key)$|^(?:meshToken|authHeader|accessToken|refreshToken|apiKey|clientSecret)$/i;
const SECRET_PATTERNS = [
  [/-----BEGIN [A-Z ]*PRIVATE KEY-----[\s\S]*?(?:-----END [A-Z ]*PRIVATE KEY-----|$)/g, '[redacted private key]'],
  [/\bsk-ant-[\w-]{10,}/g, 'sk-ant-***'],
  [/\bsk-(?:proj-)?[A-Za-z0-9_-]{20,}/g, 'sk-***'],
  [/\b(?:ghp|gho|ghu|ghs|ghr)_[A-Za-z0-9]{20,}/g, 'gh*_***'],
  [/\bgithub_pat_[A-Za-z0-9_]{20,}/g, 'github_pat_***'],
  [/\bxox[abposr]-[A-Za-z0-9-]{10,}/g, 'xox*-***'],
  [/\bAKIA[0-9A-Z]{16}\b/g, 'AKIA***'],
  [/\bAIza[0-9A-Za-z_-]{30,}/g, 'AIza***'],
  [/\bhf_[A-Za-z0-9]{8,}/g, 'hf_***'],
  [/\beyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}/g, '[redacted jwt]'],
  [/(bearer\s+)[^\s"']+/gi, '$1***'],
  [/(\b(?:x-rigs-token|authorization|cookie)\s*[:=]\s*)[^\s"',}]+/gi, '$1***'],
  [/((?:--token|--password|--api-key|--secret)[= ])[^\s&"']+/gi, '$1***'],
  [/(\b[\w-]*(?:token|password|passwd|secret|api_?key)\s*[=:]\s*["']?)[^\s&"',}*]{4,}/gi, '$1***'],
  [/(\/\/[^/\s:@]+:)[^@\s/]+@/g, '$1***@'],
];

/** Hide secret-looking values in a string (API keys, tokens, bearer headers, passwords, URL credentials, private keys). */
export function redact(s) {
  let out = String(s ?? '');
  for (const [re, to] of SECRET_PATTERNS) out = out.replace(re, to);
  return out;
}

/** Deep copy with every string redacted and every secret-named key's value replaced. Pure. */
export function redactValue(v, depth = 0) {
  if (typeof v === 'string') return redact(v);
  if (v == null || typeof v !== 'object') return v;
  if (depth > 12) return '[too deep]';
  if (Array.isArray(v)) return v.map((x) => redactValue(x, depth + 1));
  const out = {};
  for (const [k, x] of Object.entries(v)) out[k] = SECRET_KEY.test(k) && x != null && x !== '' && typeof x !== 'boolean' && typeof x !== 'number' ? '***' : redactValue(x, depth + 1);
  return out;
}

/**
 * One input/output field made safe to store: redacted, then capped at `max` characters of its JSON. A string that is
 * too long is cut and ends in "…[truncated N chars]"; a structure becomes { truncated: true, chars, preview }.
 * Returns { value, truncated }. Pure.
 */
export function clean(v, max = settings().maxField) {
  if (v === undefined) return { value: null, truncated: false };
  const r = redactValue(v);
  if (typeof r === 'string') return r.length > max ? { value: `${r.slice(0, max)}…[truncated ${r.length - max} chars]`, truncated: true } : { value: r, truncated: false };
  let s;
  try { s = JSON.stringify(r); } catch { return { value: '[unserializable]', truncated: true }; }
  if (s === undefined) return { value: null, truncated: false };
  return s.length > max ? { value: { truncated: true, chars: s.length, preview: s.slice(0, max) }, truncated: true } : { value: r, truncated: false };
}

/** A complete, clean span from loose fields. Pure apart from fresh ids. */
export function makeSpan(x = {}) {
  const max = settings().maxField;
  const input = clean(x.input, max);
  const output = clean(x.output, max);
  let meta = clean(x.meta || {}, max).value || {};
  if (meta.truncated === true && meta.preview) meta = { metaTruncated: true, preview: meta.preview };
  const truncated = [...new Set([...(Array.isArray(meta.truncated) ? meta.truncated : []), ...(input.truncated ? ['input'] : []), ...(output.truncated ? ['output'] : [])])];
  if (truncated.length) meta.truncated = truncated; else delete meta.truncated;
  const start = Number(x.start) || Date.now();
  return {
    traceId: isTraceId(x.traceId) ? x.traceId : newTraceId(start),
    spanId: isSpanId(x.spanId) ? x.spanId : newSpanId(),
    parentId: isSpanId(x.parentId) ? x.parentId : '',
    kind: String(x.kind || 'span').slice(0, 40),
    name: redact(String(x.name || x.kind || '')).slice(0, 200),
    node: String(x.node || config().name || ''),
    start, end: x.end == null ? null : Number(x.end) || Date.now(),
    status: STATUSES.includes(x.status) ? x.status : (x.end == null ? 'running' : 'ok'),
    input: input.value, output: output.value, meta,
  };
}

// ---------------------------------------------------------------- writing

let appending = Promise.resolve();

/** Append one span line (and emit it live). Never throws; resolves to the stored span or null (disabled / failed). */
export function writeSpan(x) {
  if (!settings().enabled) return Promise.resolve(null);
  let span;
  try { span = makeSpan(x); } catch (e) { log('traces: bad span: ' + e.message); return Promise.resolve(null); }
  const done = appending.then(async () => {
    await fsp.mkdir(dir(), { recursive: true });
    await fsp.appendFile(path.join(dir(), dayOf(span.start) + '.jsonl'), JSON.stringify(span) + '\n');
    try { events.emit('span', span); } catch {}
    return span;
  }).catch((e) => { log('traces: append failed: ' + e.message); return null; });
  appending = done;
  return done;
}

/** Resolves when every span written so far is on disk. */
export const flush = () => appending;

/**
 * Start a span: written now as "running", finished with .end(). handle.ctx is the { traceId, parentId } to hand to
 * child stages. Works the same when tracing is off (nothing is written).
 */
export function startSpan({ traceId, parentId = '', kind, name, input, meta = {}, start = Date.now() } = {}) {
  const base = { traceId: isTraceId(traceId) ? traceId : newTraceId(start), spanId: newSpanId(), parentId, kind, name, node: config().name, start };
  const state = { input, output: undefined, meta: { ...meta } };
  let ended = false;
  writeSpan({ ...base, ...state, end: null, status: 'running' });
  const merge = ({ input: i, output: o, meta: m } = {}) => {
    if (i !== undefined) state.input = i;
    if (o !== undefined) state.output = o;
    if (m) state.meta = { ...state.meta, ...m };
  };
  return {
    traceId: base.traceId, spanId: base.spanId,
    get ctx() { return { traceId: base.traceId, parentId: base.spanId }; },
    get ended() { return ended; },
    /** Add facts while it runs (written as another "running" line, so live viewers see them). */
    update(fields) { if (ended) return Promise.resolve(null); merge(fields); return writeSpan({ ...base, ...state, end: null, status: 'running' }); },
    end({ status = 'ok', end = Date.now(), ...fields } = {}) {
      if (ended) return Promise.resolve(null);
      ended = true;
      merge(fields);
      return writeSpan({ ...base, ...state, end, status });
    },
    child(opts) { return startSpan({ ...opts, traceId: base.traceId, parentId: base.spanId }); },
  };
}

/** A finished span written in one go (a tool call whose start and end are both known). */
export function recordSpan(x) { return writeSpan({ ...x, end: x.end ?? Date.now(), status: x.status || 'ok' }); }

/**
 * Finish (or amend) a span written earlier, possibly by another process: its last stored line with `fields` on top
 * (meta merged). Resolves to the new span, or null when this machine holds no such span.
 */
export async function finishSpan(traceId, spanId, { meta, ...fields } = {}) {
  if (!isTraceId(traceId) || !isSpanId(spanId)) return null;
  await flush();
  const old = (await readSpans({ traceId })).find((s) => s.spanId === spanId);
  if (!old) return null;
  return writeSpan({ ...old, ...fields, meta: { ...(old.meta || {}), ...(meta || {}) } });
}

/** A span id derived from stable facts (a tool_use id…), so reading the same transcript twice never duplicates spans. */
export const stableSpanId = (...parts) => `sp-${crypto.createHash('sha1').update(parts.join('|')).digest('hex').slice(0, 12)}`;

/** "traceId:parentId" / "traceId" (RIGS_TRACE, x-rigs-trace) or { traceId, parentId } → context, or null. Pure. */
export function parseContext(v) {
  if (!v) return null;
  if (typeof v === 'object') return isTraceId(v.traceId) ? { traceId: v.traceId, parentId: isSpanId(v.parentId) ? v.parentId : '' } : null;
  const [t, p] = String(v).trim().split(':');
  return isTraceId(t) ? { traceId: t, parentId: isSpanId(p) ? p : '' } : null;
}
export const formatContext = (c) => (c?.traceId ? `${c.traceId}${c.parentId ? ':' + c.parentId : ''}` : '');

// ---------------------------------------------------------------- tool calls in harness streams (pure parser)

/**
 * Follows the tool calls of one brain turn in its harness stream: feed(provider, event) for each parsed line. A call
 * that begins comes out through onStart(key, { name, input, start, meta }); when its result arrives,
 * onEnd(key, { output, status, end, meta }) with meta.durationMs. Claude (`claude -p --output-format stream-json`):
 * assistant tool_use blocks paired with the user tool_result of the same id. Codex (`codex exec --json`): item.started /
 * item.completed of command_execution, mcp_tool_call, file_change and web_search. Ollama: message.tool_calls (asked
 * for by the model; the stream carries no result, so they start and end at once). close() ends whatever never got a
 * result (the turn ended or was aborted) as "stopped". Pure apart from the callbacks.
 */
export function toolCollector({ onStart = () => {}, onEnd = () => {} } = {}, now = () => Date.now()) {
  const open = new Map();
  let seq = 0;
  const begin = (key, call) => { open.set(key, call); onStart(key, call); };
  const finish = (key, fields) => {
    const c = open.get(key);
    if (!c) return;
    open.delete(key);
    const end = now();
    onEnd(key, { ...fields, end, meta: { ...c.meta, ...(fields.meta || {}), durationMs: end - c.start } });
  };
  const CODEX = { command_execution: 'shell', mcp_tool_call: '', file_change: 'file_change', web_search: 'web_search' };
  return {
    feed(provider, e) {
      if (!e || typeof e !== 'object') return;
      if (provider === 'claude') {
        if (e.type === 'assistant') {
          for (const b of e.message?.content || []) if (b.type === 'tool_use' && b.id && !open.has(b.id)) begin(b.id, { name: b.name, input: b.input, start: now(), meta: { toolUseId: b.id } });
        } else if (e.type === 'user' && Array.isArray(e.message?.content)) {
          for (const b of e.message.content) if (b.type === 'tool_result' && open.has(b.tool_use_id)) {
            const out = Array.isArray(b.content) ? b.content.map((x) => (x.type === 'text' ? x.text : `[${x.type}]`)).join('\n') : b.content;
            finish(b.tool_use_id, { output: out, status: b.is_error ? 'error' : 'ok' });
          }
        }
      } else if (provider === 'codex') {
        const it = e.item;
        if (!it || !/^item\.(started|updated|completed)$/.test(e.type) || !(it.type in CODEX)) return;
        const key = it.id || `${it.type}-${++seq}`;
        if (!open.has(key)) {
          const name = it.type === 'mcp_tool_call' ? `${it.server}.${it.tool}` : CODEX[it.type];
          const input = it.type === 'command_execution' ? it.command : it.type === 'mcp_tool_call' ? it.arguments : it.type === 'web_search' ? it.query : it.changes;
          begin(key, { name, input, start: now(), meta: { itemId: it.id || '' } });
        }
        if (e.type === 'item.completed') {
          const failed = it.status === 'failed' || !!it.error || (it.exit_code != null && it.exit_code !== 0);
          const output = it.type === 'command_execution' ? it.aggregated_output : it.type === 'mcp_tool_call' ? (it.error || it.result) : it.type === 'file_change' ? it.changes : it.status;
          finish(key, { output, status: failed ? 'error' : 'ok', meta: it.exit_code != null ? { exitCode: it.exit_code } : {} });
        }
      } else if (provider === 'ollama') {
        for (const c of e.message?.tool_calls || []) {
          const key = `ollama-${++seq}`;
          begin(key, { name: c.function?.name || 'tool', input: c.function?.arguments, start: now(), meta: { note: 'asked for by the model; no result in the stream' } });
          finish(key, { output: null, status: 'ok' });
        }
      }
    },
    pending: () => [...open.keys()],
    close(status = 'stopped') { for (const k of [...open.keys()]) finish(k, { output: null, status }); },
  };
}

// ---------------------------------------------------------------- task runs: transcript slices → spans (pure)

const tsOf = (rec) => Date.parse(rec?.timestamp);
const blockText = (c) => (typeof c === 'string' ? c : Array.isArray(c) ? c.map((x) => (x?.type === 'text' || x?.type === 'output_text' || x?.type === 'input_text' ? x.text : `[${x?.type}]`)).join('\n') : c);

/**
 * One agent transcript (Claude Code JSONL, or a Codex rollout with provider "codex") limited to a run's window →
 * spans: one "assistant" span per model message (its text, model and token counts; it lasts from the input that
 * prompted it to its last block) and, as its children, one "tool-call" span per tool use (args, result, duration,
 * error flag; a call that never got a result ends "stopped"). Results that arrive just after `until` (the call that
 * reported the run) still close their call. Span ids are derived from the message / call ids, so a slice read twice
 * writes the same spans again (last line wins) instead of new ones. Pure.
 */
export function transcriptSpans(records, { traceId, parentId = '', node = '', since = 0, until = Infinity, session = '', provider = 'claude' } = {}) {
  const inWin = (t) => Number.isFinite(t) && t >= since && t <= until;
  const base = { traceId, node };
  const msgs = new Map(); // message id → assistant span under construction
  const calls = new Map(); // tool call id → tool span under construction
  let lastInputAt = 0;
  let lastPrompt = '';
  let lastMsg = null;
  let codexModel = '';
  const message = (id, t, model) => {
    if (!msgs.has(id)) {
      msgs.set(id, { ...base, spanId: stableSpanId(traceId, session, id), parentId, kind: 'assistant', name: model || provider, start: lastInputAt && lastInputAt <= t ? lastInputAt : t, end: t, status: 'ok',
        input: lastPrompt || undefined, text: [], meta: { model: model || '', messageId: id, session, inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0, toolCalls: 0 } });
      lastPrompt = '';
    }
    const m = msgs.get(id);
    m.end = Math.max(m.end, t);
    lastMsg = m;
    return m;
  };
  const openCall = (m, id, name, input, t) => {
    if (calls.has(id)) return;
    m.meta.toolCalls++;
    calls.set(id, { ...base, spanId: stableSpanId(traceId, session, id), parentId: m.spanId, kind: 'tool-call', name: name || 'tool', start: t, end: null, status: 'running', input, output: null, meta: { toolUseId: id, session } });
  };
  const closeCall = (id, output, isError, t) => {
    const c = calls.get(id);
    if (!c || c.end != null) return;
    Object.assign(c, { end: Math.max(t, c.start), output, status: isError ? 'error' : 'ok' });
    c.meta.durationMs = c.end - c.start;
  };
  for (const rec of records || []) {
    if (!rec || typeof rec !== 'object') continue;
    const t = tsOf(rec);
    if (provider === 'codex') {
      const p = rec.payload || {};
      if (rec.type === 'response_item' && p.type === 'message' && p.role === 'user') { if (inWin(t)) { lastInputAt = t; lastPrompt = blockText(p.content); } continue; }
      if (rec.type === 'event_msg' && p.type === 'token_count' && p.info?.last_token_usage && lastMsg && inWin(t)) {
        const u = p.info.last_token_usage;
        const cached = num(u.cached_input_tokens);
        Object.assign(lastMsg.meta, { inputTokens: lastMsg.meta.inputTokens + Math.max(0, num(u.input_tokens) - cached), outputTokens: lastMsg.meta.outputTokens + num(u.output_tokens), cacheReadTokens: lastMsg.meta.cacheReadTokens + cached });
        continue;
      }
      if (rec.type === 'turn_context' && p.model) { codexModel = p.model; continue; }
      if (rec.type !== 'response_item') continue;
      if (/^(function_call|custom_tool_call|local_shell_call)$/.test(p.type) && inWin(t)) {
        const m = lastMsg && t - lastMsg.end < 600000 ? lastMsg : message(`codex-${p.call_id || t}`, t, codexModel);
        let input = p.arguments ?? p.input ?? p.action;
        if (typeof input === 'string') { try { input = JSON.parse(input); } catch {} }
        openCall(m, p.call_id || `call-${t}`, p.name || p.type, input, t);
      } else if (/^(function_call_output|custom_tool_call_output|local_shell_call_output)$/.test(p.type)) {
        const out = typeof p.output === 'string' ? p.output : p.output?.content ?? p.output;
        closeCall(p.call_id, out, /exit code: [1-9]|"exit_code":\s*[1-9]|^error/i.test(String(typeof out === 'string' ? out : JSON.stringify(out))), t);
        if (inWin(t)) lastInputAt = t;
      } else if (p.type === 'message' && p.role === 'assistant' && inWin(t)) {
        const m = message(p.id || `codex-msg-${t}`, t, codexModel);
        m.text.push(blockText(p.content));
      }
      continue;
    }
    // Claude Code: one "assistant" record per content block (same message.id); tool results come back in "user" records.
    if (rec.type === 'user' && rec.message) {
      const c = rec.message.content;
      const results = Array.isArray(c) ? c.filter((b) => b?.type === 'tool_result') : [];
      for (const b of results) closeCall(b.tool_use_id, blockText(b.content), !!b.is_error, t);
      if (!inWin(t)) continue;
      lastInputAt = t;
      if (!results.length) lastPrompt = blockText(c);
      continue;
    }
    if (rec.type !== 'assistant' || !rec.message || !inWin(t)) continue;
    const msg = rec.message;
    const m = message(msg.id || rec.uuid || `msg-${t}`, t, msg.model);
    const u = msg.usage;
    if (u) Object.assign(m.meta, { inputTokens: num(u.input_tokens), outputTokens: num(u.output_tokens), cacheReadTokens: num(u.cache_read_input_tokens), cacheWriteTokens: num(u.cache_creation_input_tokens) });
    for (const b of Array.isArray(msg.content) ? msg.content : []) {
      if (b?.type === 'text' && b.text) m.text.push(b.text);
      else if (b?.type === 'tool_use' && b.id) openCall(m, b.id, b.name, b.input, t);
    }
  }
  const out = [];
  for (const m of [...msgs.values()].sort((a, b) => a.start - b.start)) {
    const { text, ...span } = m;
    out.push({ ...span, output: text.join('\n') || null });
    for (const c of [...calls.values()].filter((x) => x.parentId === m.spanId).sort((a, b) => a.start - b.start)) {
      if (c.end == null) { c.end = Math.max(c.start, Number.isFinite(until) ? Math.min(until, m.end) : m.end); c.status = 'stopped'; c.meta = { ...c.meta, noResult: true, durationMs: c.end - c.start }; }
      out.push(c);
    }
  }
  return out;
}

/** Token and tool-call totals of a run's transcript spans. Pure. */
export function runTotals(spans) {
  const msgs = spans.filter((s) => s.kind === 'assistant');
  const sum = (k) => msgs.reduce((a, s) => a + num(s.meta?.[k]), 0);
  return { messages: msgs.length, toolCalls: spans.filter((s) => s.kind === 'tool-call').length, toolErrors: spans.filter((s) => s.kind === 'tool-call' && s.status === 'error').length,
    inputTokens: sum('inputTokens'), outputTokens: sum('outputTokens'), cacheReadTokens: sum('cacheReadTokens'), cacheWriteTokens: sum('cacheWriteTokens') };
}

/**
 * A task run started on THIS machine (work.startTask): its "task" span, running until the run ends. `ctx` is the trace
 * context from the brief / work/start body (the dispatch span as parent). Returns { traceId, spanId, parentId } — kept
 * on the run handle (run.traceRun) so the end of the run finds the span — or null for an untraced task.
 */
export function startRun(ctx, { project = {}, task = {}, prompt = '', run = {}, gitGuard = null, start = Date.now() } = {}) {
  const c = parseContext(ctx);
  if (!c || !settings().enabled) return null;
  const a = task.assign || {};
  const span = startSpan({ ...c, kind: 'task', name: `${task.id || 'task'} ${task.title || ''}`.trim(), start, input: { task: { id: task.id, title: task.title, kind: task.kind, size: task.size }, brief: prompt },
    meta: { projectId: project.id || '', projectName: project.name || '', taskId: task.id || '', attempt: (task.attempts || 0) + 1, provider: a.provider || '', model: a.model || '', effort: a.effort || '',
      mode: run.mode || '', seat: run.seat || '', rig: run.rig || '', qitem: run.qitem || '', session: run.session?.id || '', cwd: run.cwd || '', ...(gitGuard ? { gitGuard } : {}) } });
  return { traceId: span.traceId, spanId: span.spanId, parentId: c.parentId };
}

/** What the owner sends to the run's machine when a run ends (planner.onRunEnd e → traces/run-end body), or null. Pure. */
export function runEndBody(e) {
  const tr = e?.run?.traceRun;
  if (!tr || !isTraceId(tr.traceId)) return null;
  return { trace: tr, since: e.since, until: e.until, status: e.status, summary: e.summary || '', cwd: e.run.cwd || '', seat: e.run.seat || '', brief: e.run.brief || '', attempt: (e.task?.attempts || 0) + 1 };
}

const RUN_STATUS = { done: 'ok', failed: 'error', blocked: 'stopped', stopped: 'stopped' };

/**
 * The end of a task run, on the machine that ran it (POST /api/local/traces/run-end): the run's transcript slice
 * (`transcripts(q)` → [{ id, provider, records }], usage.runTranscripts) becomes assistant + tool-call spans under the
 * run's task span, which is then finished with the reported status, the agent's summary and the run's totals. A run
 * reported twice (blocked, then done) covers two windows of the same span. Never throws.
 */
export async function recordRunEnd(b = {}, { transcripts = async () => [] } = {}) {
  const tr = b.trace || {};
  if (!isTraceId(tr.traceId) || !settings().enabled) return null;
  const since = Number(b.since) || 0;
  const until = Number(b.until) || Date.now();
  const runId = isSpanId(tr.spanId) ? tr.spanId : stableSpanId(tr.traceId, 'run', tr.parentId || '', since);
  let found = [];
  let error = '';
  if (b.seat || b.brief) { try { found = (await transcripts({ since, until, cwd: b.cwd || '', seat: b.seat || '', brief: b.brief || '' })) || []; } catch (e) { error = e.message; } }
  const spans = found.flatMap((f) => transcriptSpans(f.records, { traceId: tr.traceId, parentId: runId, node: config().name, since, until, session: f.id || '', provider: f.provider || 'claude' }));
  for (const s of spans) writeSpan(s);
  const totals = runTotals(spans);
  const fields = { end: until, status: RUN_STATUS[b.status] || 'ok', output: { reported: b.status || '', summary: b.summary || '' },
    meta: { reported: b.status || '', ...totals, sessions: found.map((f) => f.id).filter(Boolean), ...(error ? { transcriptError: error } : (b.seat || b.brief) && !found.length ? { transcriptError: 'no transcript found for this run' } : {}) } };
  // A second window of the same run (reported blocked, then done) adds to what the first one counted.
  await flush();
  const old = (await readSpans({ traceId: tr.traceId })).find((s) => s.spanId === runId);
  if (old?.meta?.messages != null && old.end != null) for (const k of Object.keys(totals)) fields.meta[k] += num(old.meta[k]);
  const run = old ? await finishSpan(tr.traceId, runId, fields)
    : await writeSpan({ traceId: tr.traceId, spanId: runId, parentId: tr.parentId || '', kind: 'task', name: `task run (attempt ${b.attempt || 1})`, start: since, ...fields });
  await flush();
  return { traceId: tr.traceId, spanId: runId, spans: spans.length, ...totals, status: run?.status || fields.status, ...(fields.meta.transcriptError ? { error: fields.meta.transcriptError } : {}) };
}

// ---------------------------------------------------------------- reading

const traceDay = (id) => `${id.slice(3, 7)}-${id.slice(7, 9)}-${id.slice(9, 11)}`;

/** Spans from the day files in [since, until] (ms) — or of one trace — last line per spanId, oldest first. */
export async function readSpans({ since = 0, until = Infinity, traceId = '' } = {}) {
  const files = (await fsp.readdir(dir()).catch(() => [])).filter((f) => /^\d{4}-\d{2}-\d{2}\.jsonl$/.test(f)).sort();
  // A trace's spans start on or after the day in its id (a long project keeps adding spans for days).
  const from = traceId ? traceDay(traceId) : since ? dayOf(since) : '';
  const to = !traceId && Number.isFinite(until) ? dayOf(until) : '9999-99-99';
  const byId = new Map();
  for (const f of files) {
    const d = f.slice(0, 10);
    if (d < from || d > to) continue;
    const text = await fsp.readFile(path.join(dir(), f), 'utf8').catch(() => '');
    for (const line of text.split('\n')) {
      if (!line || (traceId && !line.includes(traceId))) continue;
      let s;
      try { s = JSON.parse(line); } catch { continue; }
      if (traceId && s.traceId !== traceId) continue;
      byId.set(s.spanId, s);
    }
  }
  return [...byId.values()].sort((a, b) => a.start - b.start);
}

const num = (v) => Number(v) || 0;
const textOf = (v) => (typeof v === 'string' ? v : v?.text ?? v?.preview ?? '');

/** One trace's summary from its spans (any order, any machines). Pure. */
export function summarizeTrace(spans) {
  const sorted = [...spans].sort((a, b) => a.start - b.start);
  const root = sorted.find((s) => s.kind === 'intake') || sorted.find((s) => !s.parentId) || sorted[0];
  const router = sorted.find((s) => s.kind === 'router');
  const turns = sorted.filter((s) => s.kind === 'brain-turn');
  const handoffs = sorted.filter((s) => s.kind === 'handoff');
  // Tokens: each brain turn's harness numbers plus each task run's transcript totals (its assistant spans are not
  // counted again).
  const runs = sorted.filter((s) => s.kind === 'task');
  const costed = [...turns, ...runs];
  const end = sorted.some((s) => s.end == null) ? null : Math.max(...sorted.map((s) => s.end));
  // A failed tool call (a grep with no match…) is the agent's business; the trace fails when a stage does.
  const has = (st) => sorted.some((s) => s.kind !== 'tool-call' && s.status === st);
  return {
    traceId: root.traceId, start: root.start, end, durationMs: end == null ? null : end - root.start,
    status: has('error') ? 'error' : has('running') ? 'running' : has('stopped') ? 'stopped' : 'ok',
    node: root.node, nodes: [...new Set(sorted.map((s) => s.node))], request: String(textOf(root.input)).slice(0, 240),
    route: router?.meta?.route || '',
    projectIds: [...new Set([router?.meta?.projectId, ...handoffs.map((h) => h.meta?.projectId)].filter(Boolean))],
    taskIds: [...new Set([...handoffs.flatMap((h) => h.meta?.taskIds || []), ...runs.map((r) => r.meta?.taskId)].filter(Boolean))],
    spans: sorted.length, toolCalls: sorted.filter((s) => s.kind === 'tool-call').length, brainTurns: turns.length, handoffs: handoffs.length, taskRuns: runs.length,
    models: [...new Set(costed.map((t) => t.meta?.model).filter(Boolean))],
    inputTokens: costed.reduce((a, t) => a + num(t.meta?.inputTokens), 0), outputTokens: costed.reduce((a, t) => a + num(t.meta?.outputTokens), 0),
    costUsd: turns.some((t) => t.meta?.costUsd != null) ? Math.round(turns.reduce((a, t) => a + num(t.meta?.costUsd), 0) * 1e6) / 1e6 : null,
  };
}

/** Spans → nested tree (children by start time); a span whose parent is missing becomes a root. Pure. */
export function buildTree(spans) {
  const nodes = new Map(spans.map((s) => [s.spanId, { ...s, children: [] }]));
  const roots = [];
  for (const n of [...nodes.values()].sort((a, b) => a.start - b.start)) {
    const p = n.parentId && nodes.get(n.parentId);
    if (p && p !== n) p.children.push(n); else roots.push(n);
  }
  return roots;
}

/** Spans grouped into trace summaries, filtered (route, status, q) and newest first. Pure. */
export function listFromSpans(spans, { route = '', status = '', q = '', limit = 100 } = {}) {
  const by = new Map();
  for (const s of spans) { if (!by.has(s.traceId)) by.set(s.traceId, []); by.get(s.traceId).push(s); }
  let list = [...by.values()].map(summarizeTrace);
  if (route) list = list.filter((t) => t.route === route);
  if (status) list = list.filter((t) => t.status === status);
  if (q) { const w = String(q).toLowerCase(); list = list.filter((t) => t.request.toLowerCase().includes(w) || t.traceId.includes(w)); }
  list.sort((a, b) => b.start - a.start);
  const n = Math.max(0, Number(limit) || 0);
  return { count: list.length, traces: list.slice(0, n), truncated: list.length > n };
}

/**
 * GET /api/local/traces — this machine's trace summaries, newest first. Query: since (ms | ISO | "24h" | "7d", default
 * 7d), until, route (answer | implement | plan | continue), status (running | ok | error | stopped), q (text), limit.
 * parseTime is usage.parseTime (passed in to keep this module free of the usage ledger).
 */
export async function list(q = {}, parseTime = (v) => (v ? Number(v) || Date.parse(v) : null)) {
  const since = parseTime(q.since) ?? Date.now() - 7 * 86400000;
  const until = parseTime(q.until) ?? Infinity;
  const out = listFromSpans(await readSpans({ since, until }), { route: q.route, status: q.status, q: q.q, limit: q.limit ?? 100 });
  return { node: config().name, since, until: Number.isFinite(until) ? until : null, ...out };
}

/**
 * GET /api/local/traces/<id> — the spans this machine holds for one trace, flat and as a tree, with its summary.
 * after (ms): only spans that started or ended since then, plus those still running (for live polling).
 */
export async function get(traceId, { after = 0 } = {}) {
  if (!isTraceId(traceId)) return null;
  let spans = await readSpans({ traceId });
  const summary = spans.length ? summarizeTrace(spans) : null;
  if (Number(after)) spans = spans.filter((s) => Math.max(s.start, s.end || 0) >= Number(after) || s.status === 'running');
  return { traceId, node: config().name, summary, spans, tree: buildTree(spans) };
}

const STATUS_RANK = { error: 3, running: 2, stopped: 1, ok: 0 };
/** The same trace seen from two machines → one summary (the earliest root keeps request and route). Pure. */
export function mergeSummaries(a, b) {
  const first = a.start <= b.start ? a : b;
  const uniq = (k) => [...new Set([...(a[k] || []), ...(b[k] || [])])];
  const end = a.end == null || b.end == null ? null : Math.max(a.end, b.end);
  return {
    ...first, end, durationMs: end == null ? null : end - first.start,
    status: (STATUS_RANK[a.status] ?? 0) >= (STATUS_RANK[b.status] ?? 0) ? a.status : b.status,
    request: first.request || a.request || b.request, route: first.route || a.route || b.route,
    nodes: uniq('nodes'), projectIds: uniq('projectIds'), taskIds: uniq('taskIds'), models: uniq('models'),
    spans: a.spans + b.spans, toolCalls: a.toolCalls + b.toolCalls, brainTurns: a.brainTurns + b.brainTurns, handoffs: a.handoffs + b.handoffs, taskRuns: (a.taskRuns || 0) + (b.taskRuns || 0),
    inputTokens: a.inputTokens + b.inputTokens, outputTokens: a.outputTokens + b.outputTokens,
    costUsd: a.costUsd == null && b.costUsd == null ? null : Math.round(((a.costUsd || 0) + (b.costUsd || 0)) * 1e6) / 1e6,
  };
}

/** Mesh-wide list (GET /api/traces), like aggregateUsage: results = [{ node, report } | { node, error }]. Pure. */
export function aggregateTraces(results, q = {}) {
  const by = new Map();
  const errors = [];
  for (const r of results) {
    if (r.error) { errors.push({ node: r.node.name, error: r.error }); continue; }
    for (const t of r.report?.traces || []) by.set(t.traceId, by.has(t.traceId) ? mergeSummaries(by.get(t.traceId), t) : { ...t });
  }
  let traces = [...by.values()];
  // A trace that started elsewhere may have matched the filter on only one machine: filter the merged view again.
  if (q.route) traces = traces.filter((t) => t.route === q.route);
  if (q.status) traces = traces.filter((t) => t.status === q.status);
  traces.sort((a, b) => b.start - a.start);
  const limit = Math.max(0, Number(q.limit ?? 100) || 0);
  return { count: traces.length, traces: traces.slice(0, limit), truncated: traces.length > limit || results.some((r) => r.report?.truncated), nodes: results.map((r) => r.node.name), errors };
}

/**
 * Mesh-wide one trace (GET /api/traces/<id>): every machine's spans in one tree. A machine that did not answer
 * (results entry with `error`, e.g. "offline") but that the trace sent work to (a dispatch span's meta.target) is a
 * hole in the tree: each such dispatch gets a "gap" child naming the machine and why, and `gaps` lists them, so the
 * tree is drawn with the hole marked instead of failing. Pure.
 */
export function mergeTrace(traceId, results) {
  const byId = new Map();
  const errors = [];
  for (const r of results) {
    if (r.error) { errors.push({ node: r.node.name, error: r.error }); continue; }
    for (const s of r.report?.spans || []) byId.set(s.spanId, s);
  }
  const real = [...byId.values()];
  const answered = new Set(results.filter((r) => !r.error).map((r) => r.node.name));
  const why = new Map(errors.map((e) => [e.node, e.error]));
  const gaps = [];
  for (const d of real.filter((s) => s.kind === 'dispatch' && s.meta?.target && !answered.has(s.meta.target) && s.status !== 'error')) {
    const n = d.meta.target;
    gaps.push({ node: n, error: why.get(n) || 'not reachable', parentId: d.spanId, taskId: d.meta.taskId || '' });
    real.push({ traceId, spanId: stableSpanId(traceId, 'gap', d.spanId), parentId: d.spanId, kind: 'gap', name: `${n} did not answer`, node: n, start: d.end || d.start, end: d.end || d.start,
      status: 'error', input: null, output: `The spans ${n} holds for this run are missing: ${why.get(n) || 'it is not reachable'}.`, meta: { gap: true, error: why.get(n) || 'not reachable', taskId: d.meta.taskId || '' } });
  }
  const spans = real.sort((a, b) => a.start - b.start);
  return { traceId, summary: byId.size ? summarizeTrace([...byId.values()]) : null, spans, tree: buildTree(spans), nodes: results.map((r) => r.node.name), errors, gaps };
}

// ---------------------------------------------------------------- retention

/** Delete day files older than config().traces.days. Returns the names removed. */
export async function prune(now = Date.now()) {
  const keepFrom = dayOf(now - settings().days * 86400000);
  const old = (await fsp.readdir(dir()).catch(() => [])).filter((f) => /^\d{4}-\d{2}-\d{2}\.jsonl$/.test(f) && f.slice(0, 10) < keepFrom);
  for (const f of old) await fsp.rm(path.join(dir(), f), { force: true }).catch(() => {});
  return old;
}
