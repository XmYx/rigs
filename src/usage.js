// What is working right now, and what it costs — for the JARVIS work dashboard.
//  - Plan limits (5-hour session, weekly, weekly per model e.g. Fable): Claude Code's own `get_usage`
//    control request (no model call, no token handling here), cached for a few minutes.
//  - Codex limits: the newest non-null rate_limits in ~/.codex/sessions rollouts.
//  - Live Claude Code sessions: ~/.claude/sessions/<pid>.json (alive pids), their transcripts tailed
//    incrementally; tokens per model are summed once per API message (a response is written once per
//    content block, so records are deduplicated by message.id); progress from the latest todo list.
//  - The usage ledger: what each chat turn, planning call and task run spent (model, time, tokens, outcome) — below.
import crypto from 'node:crypto';
import fs from 'node:fs';
import fsp from 'node:fs/promises';
import path from 'node:path';
import { config, RIGS_HOME } from './config.js';
import { bin } from './tools.js';
import { HOME, augmentedPath, log, spawnCmd, truncate } from './util.js';

const CLAUDE_DIR = process.env.RIGS_CLAUDE_DIR || path.join(HOME, '.claude');
const CODEX_DIR = process.env.RIGS_CODEX_DIR || path.join(HOME, '.codex');
const PLAN_TTL = 180000;

// ---------------------------------------------------------------- plan limits

/** Normalise Claude Code's get_usage response into { session, week, models[], subscription }. Pure. */
export function parseUsage(r) {
  const rl = r?.rate_limits || r || {};
  const win = (w) => (w && typeof w.utilization === 'number' ? { pct: w.utilization, resetsAt: w.resets_at || null } : null);
  const models = [];
  for (const l of rl.limits || []) {
    if (l.kind !== 'weekly_scoped') continue;
    const name = l.scope?.model?.display_name || l.group || 'model';
    if (!models.some((m) => m.name === name)) models.push({ name, pct: l.percent, resetsAt: l.resets_at || null });
  }
  for (const m of rl.model_scoped || []) {
    if (!models.some((x) => x.name === m.display_name) && typeof m.utilization === 'number') models.push({ name: m.display_name, pct: m.utilization, resetsAt: m.resets_at || null });
  }
  return { session: win(rl.five_hour), week: win(rl.seven_day), models, subscription: r?.subscription_type || rl.subscription_type || null };
}

let plan = { at: 0, data: null, error: null, pending: null };

function runGetUsage() {
  return new Promise((resolve, reject) => {
    const claude = bin('claude');
    if (!claude) return reject(new Error('Claude Code is not installed here'));
    const env = { ...process.env, PATH: augmentedPath() };
    for (const k of Object.keys(env)) if (k.startsWith('CLAUDECODE') || k === 'CLAUDE_CODE_ENTRYPOINT') delete env[k];
    const child = spawnCmd(claude, ['-p', '--input-format', 'stream-json', '--output-format', 'stream-json', '--verbose'], { cwd: HOME, env, stdio: ['pipe', 'pipe', 'pipe'] });
    let out = '';
    let settled = false;
    const finish = (fn, v) => { if (settled) return; settled = true; clearTimeout(timer); try { child.stdin.end(); child.kill(); } catch {} fn(v); };
    const timer = setTimeout(() => finish(reject, new Error('get_usage timed out')), 30000);
    child.stdout.on('data', (d) => {
      out += d;
      for (const line of out.split('\n')) {
        let m;
        try { m = JSON.parse(line); } catch { continue; }
        if (m.type === 'control_response') {
          const r = m.response?.response;
          return r ? finish(resolve, r) : finish(reject, new Error(m.response?.error || 'no usage in the response'));
        }
      }
    });
    child.on('error', (e) => finish(reject, e));
    child.on('close', () => finish(reject, new Error('claude exited without usage')));
    child.stdin.write(JSON.stringify({ type: 'control_request', request_id: 'rigs-usage', request: { subtype: 'get_usage', skip_behaviors: true } }) + '\n');
  });
}

/** Plan limits for this machine's Claude account (cached; one refresh at a time). */
export async function planLimits({ force = false } = {}) {
  if (!force && plan.data && Date.now() - plan.at < PLAN_TTL) return { ...plan.data, at: plan.at, error: null };
  if (!plan.pending) {
    plan.pending = runGetUsage()
      .then((r) => { plan = { at: Date.now(), data: parseUsage(r), error: null, pending: null }; })
      .catch((e) => { plan = { ...plan, error: e.message, pending: null }; });
  }
  await plan.pending;
  return plan.data ? { ...plan.data, at: plan.at, error: plan.error } : { session: null, week: null, models: [], subscription: null, at: plan.at, error: plan.error };
}

async function tail(file, bytes) {
  const fh = await fsp.open(file, 'r');
  try {
    const { size } = await fh.stat();
    const start = Math.max(0, size - bytes);
    const buf = Buffer.alloc(size - start);
    await fh.read(buf, 0, buf.length, start);
    return buf.toString('utf8');
  } finally { await fh.close(); }
}

/** Codex 5-hour / weekly windows from the newest rollout that has them. */
export async function codexLimits() {
  const files = [];
  async function walk(d, depth) {
    let ents;
    try { ents = await fsp.readdir(d, { withFileTypes: true }); } catch { return; }
    for (const e of ents) {
      const p = path.join(d, e.name);
      if (e.isDirectory() && depth < 3) await walk(p, depth + 1);
      else if (e.isFile() && e.name.endsWith('.jsonl')) files.push(p);
    }
  }
  await walk(path.join(CODEX_DIR, 'sessions'), 0);
  const recent = (await Promise.all(files.map(async (f) => ({ f, m: (await fsp.stat(f).catch(() => ({ mtimeMs: 0 }))).mtimeMs })))).sort((a, b) => b.m - a.m).slice(0, 8);
  for (const { f } of recent) {
    for (const l of (await tail(f, 400000)).split('\n').reverse()) {
      if (!l.includes('"rate_limits"')) continue;
      let j;
      try { j = JSON.parse(l); } catch { continue; }
      const r = j.payload?.rate_limits;
      if (!r) continue;
      const w = (x) => (x ? { pct: Math.round(x.used_percent), resetsAt: x.resets_at ? new Date(x.resets_at * 1000).toISOString() : null } : null);
      return { session: w(r.primary), week: w(r.secondary), plan: r.plan_type || null };
    }
  }
  return null;
}

// ---------------------------------------------------------------- live sessions

const tails = new Map(); // transcript path → accumulator

export function newAcc() { return { offset: 0, seen: new Set(), perModel: {}, todos: null, lastModel: null, context: 0, lastAt: 0, title: '' }; }

/** Fold one transcript record into a session accumulator (mutates `acc`). */
export function foldRecord(acc, rec) {
  if (rec.type === 'assistant' && rec.message?.usage) {
    const id = rec.message.id || rec.uuid;
    if (!acc.seen.has(id)) {
      acc.seen.add(id);
      const u = rec.message.usage;
      const m = rec.message.model || 'unknown';
      if (m.startsWith('<')) return; // Claude Code's own <synthetic> messages carry no real usage
      const t = acc.perModel[m] || (acc.perModel[m] = { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, messages: 0 });
      t.input += u.input_tokens || 0;
      t.output += u.output_tokens || 0;
      t.cacheRead += u.cache_read_input_tokens || 0;
      t.cacheWrite += u.cache_creation_input_tokens || 0;
      t.messages += 1;
      acc.lastModel = m;
      acc.context = (u.input_tokens || 0) + (u.cache_read_input_tokens || 0) + (u.cache_creation_input_tokens || 0);
    }
    for (const b of rec.message.content || []) {
      if (b.type === 'tool_use' && b.name === 'TodoWrite' && Array.isArray(b.input?.todos)) acc.todos = b.input.todos.map((x) => ({ text: x.content || x.activeForm || '', status: x.status }));
    }
  }
  if (rec.type === 'summary' && rec.summary) acc.title = rec.summary;
  if (rec.timestamp) acc.lastAt = Date.parse(rec.timestamp) || acc.lastAt;
}

async function readTranscript(file) {
  let acc = tails.get(file);
  if (!acc) { acc = newAcc(); tails.set(file, acc); }
  const st = await fsp.stat(file).catch(() => null);
  if (!st || st.size === acc.offset) return acc;
  if (st.size < acc.offset) { tails.delete(file); return readTranscript(file); } // rewritten
  const fh = await fsp.open(file, 'r');
  try {
    const buf = Buffer.alloc(st.size - acc.offset);
    await fh.read(buf, 0, buf.length, acc.offset);
    const end = buf.lastIndexOf(10); // only whole lines
    if (end < 0) return acc;
    for (const line of buf.subarray(0, end).toString('utf8').split('\n')) {
      if (!line) continue;
      try { foldRecord(acc, JSON.parse(line)); } catch { /* partial or foreign line */ }
    }
    acc.offset += end + 1;
  } finally { await fh.close(); }
  return acc;
}

const fileCache = new Map(); // sessionId → transcript path
async function findTranscript(sessionId) {
  const hit = fileCache.get(sessionId);
  if (hit && fs.existsSync(hit)) return hit;
  const root = path.join(CLAUDE_DIR, 'projects');
  for (const d of await fsp.readdir(root).catch(() => [])) {
    const f = path.join(root, d, sessionId + '.jsonl');
    if (fs.existsSync(f)) { fileCache.set(sessionId, f); return f; }
  }
  return null;
}

const alive = (pid) => { try { process.kill(pid, 0); return true; } catch (e) { return e.code === 'EPERM'; } };

/** Running Claude Code sessions on this machine with model/token usage and todo progress. */
export async function liveSessions() {
  const dir = path.join(CLAUDE_DIR, 'sessions');
  const byId = new Map();
  for (const f of await fsp.readdir(dir).catch(() => [])) {
    if (!f.endsWith('.json')) continue;
    let s;
    try { s = JSON.parse(await fsp.readFile(path.join(dir, f), 'utf8')); } catch { continue; }
    if (!s.sessionId || !s.pid || !alive(s.pid)) continue;
    const prev = byId.get(s.sessionId);
    // the same conversation can be open in several processes: one entry, the extra pids noted
    if (prev) { prev.pids.push(s.pid); if (s.status === 'busy') prev.status = 'busy'; continue; }
    byId.set(s.sessionId, { id: s.sessionId, pids: [s.pid], name: s.name || '', cwd: s.cwd || '', status: s.status || 'idle', kind: s.kind || '', startedAt: s.startedAt || null });
  }
  const out = [];
  for (const s of byId.values()) {
    const file = await findTranscript(s.id);
    const acc = file ? await readTranscript(file) : null;
    const todos = acc?.todos || null;
    const done = todos ? todos.filter((t) => t.status === 'completed').length : 0;
    const sum = (k) => (acc ? Object.values(acc.perModel).reduce((a, t) => a + t[k], 0) : 0);
    out.push({
      ...s,
      title: s.name || acc?.title || path.basename(s.cwd || '') || s.id.slice(0, 8),
      model: acc?.lastModel || null,
      models: acc ? Object.entries(acc.perModel).map(([model, t]) => ({ model, ...t })) : [],
      tokens: { input: sum('input'), output: sum('output'), cacheRead: sum('cacheRead'), cacheWrite: sum('cacheWrite') },
      context: acc?.context || 0,
      lastAt: acc?.lastAt || s.startedAt,
      progress: todos?.length ? { done, total: todos.length, pct: Math.round((done / todos.length) * 100), current: todos.find((t) => t.status === 'in_progress')?.text || '' } : null,
    });
  }
  return out.sort((a, b) => (b.status === 'busy') - (a.status === 'busy') || (b.lastAt || 0) - (a.lastAt || 0));
}

/** Projects with work in flight: done/total tasks, the running ones and how many are stuck. Pure. A project whose
 * tasks are all done is left out: the main "rigs" project stays 'running' for intake and would sit there at 100%. */
export function projectProgress(projects) {
  const finished = (p) => p.tasks?.length && p.tasks.every((t) => t.status === 'done');
  return (projects || []).filter((p) => (p.status === 'running' || p.tasks?.some((t) => t.status === 'running')) && !finished(p)).map((p) => {
    const total = p.tasks?.length || 0;
    const done = (p.tasks || []).filter((t) => t.status === 'done').length;
    return {
      id: p.id, name: p.name, status: p.status, done, total, pct: !total ? 0 : done === total ? 100 : Math.min(99, Math.round((done / total) * 100)), // 100% only when finished
      main: !!p.main,
      running: (p.tasks || []).filter((t) => t.status === 'running').map((t) => ({ id: t.id, title: t.title, node: t.assign?.node, model: t.assign?.model || t.assign?.provider, effort: t.assign?.effort, via: t.run?.mode === 'openrig' ? `OpenRig ${t.run.seat}` : t.run?.session ? `${t.run.session.kind} ${t.run.session.id}` : '', session: t.run?.session || null, startedAt: t.run?.startedAt || 0 })),
      blocked: (p.tasks || []).filter((t) => t.status === 'blocked' || t.status === 'failed').length,
    };
  });
}

// ---------------------------------------------------------------- usage ledger
// Append-only record of what each model spent: one line per JARVIS chat turn, planning call and task run, in
// RIGS_HOME/usage/<YYYY-MM>.jsonl (UTC month of the start). Tokens come from the harness itself where it reports
// them (claude -p result, codex turn.completed, Ollama's final chunk); a task's tokens are summed from its agent's
// own transcript, limited to the run's time window, since OpenRig seats are long-lived and carry many tasks.
// Capture is best-effort: nothing here may fail a chat or a task.

export const LEDGER_KINDS = ['chat-turn', 'task', 'plan', 'review', 'merge', 'request'];
// "request": one per request from Sir (chat.jarvisSend) with its timing in `request` — pre-routing on/off, route,
// routerMs, timeToFiledMs, timeToReplyMs (src/preroute-stats.js). It spends no tokens of its own and overlaps the turns
// it contains, so the usage report leaves it out unless asked for (kind=request).
export const LEDGER_STATUSES = ['done', 'failed', 'blocked', 'stopped'];
export const GROUP_BYS = ['model', 'project', 'task', 'node', 'day', 'provider', 'kind'];
const TOKEN_KEYS = ['inputTokens', 'outputTokens', 'cacheReadTokens', 'cacheWriteTokens'];

export const ledgerDir = () => path.join(RIGS_HOME, 'usage');
const monthOf = (ms) => new Date(ms).toISOString().slice(0, 7);
const num = (x) => (Number.isFinite(Number(x)) && Number(x) > 0 ? Math.round(Number(x)) : 0);
const firstLine = (s) => String(s || '').split('\n').map((l) => l.trim()).find(Boolean) || '';

export function emptyTokens() { return { inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0 }; }

/** a + b for token counts (and costUsd when either has one). Pure. */
export function addTokens(a, b) {
  const out = emptyTokens();
  for (const k of TOKEN_KEYS) out[k] = num(a?.[k]) + num(b?.[k]);
  if (a?.costUsd != null || b?.costUsd != null) out.costUsd = (Number(a?.costUsd) || 0) + (Number(b?.costUsd) || 0);
  return out;
}

/** One clean ledger record: every field present, numbers coerced, text bounded. Pure (apart from a fresh id). */
export function makeRecord(x = {}) {
  const now = Date.now();
  const tsEnd = Number(x.tsEnd) || now;
  const tsStart = Number(x.tsStart) || tsEnd;
  const rec = {
    id: String(x.id || crypto.randomUUID()),
    tsStart, tsEnd, durationMs: x.durationMs != null ? num(x.durationMs) : Math.max(0, tsEnd - tsStart),
    node: String(x.node || config().name || ''),
    kind: LEDGER_KINDS.includes(x.kind) ? x.kind : 'chat-turn',
    provider: String(x.provider || ''), model: String(x.model || ''), effort: String(x.effort || ''),
    projectId: String(x.projectId || ''), projectName: truncate(x.projectName || '', 120),
    taskId: String(x.taskId || ''), taskTitle: truncate(x.taskTitle || '', 200), taskKind: String(x.taskKind || ''),
    sessionId: String(x.sessionId || ''), chatId: String(x.chatId || ''),
    ...Object.fromEntries(TOKEN_KEYS.map((k) => [k, num(x[k])])),
    costUsd: x.costUsd != null && Number.isFinite(Number(x.costUsd)) ? Math.round(Number(x.costUsd) * 1e6) / 1e6 : null,
    status: LEDGER_STATUSES.includes(x.status) ? x.status : 'done',
    outcome: truncate(String(x.outcome || '').replace(/\s+/g, ' ').trim(), 300),
    tokensFrom: String(x.tokensFrom || ''),
  };
  if (x.estimated) rec.estimated = true;
  if (x.attempt) rec.attempt = num(x.attempt);
  if (x.error) rec.error = truncate(x.error, 300);
  if (x.request) rec.request = requestTiming(x.request);
  if (x.lane) rec.lane = String(x.lane).slice(0, 20);
  if (x.tier) rec.tier = String(x.tier).slice(0, 20); // the fast path's tier when it is not the request's own (the local responder: 'local')
  if (x.models && Object.keys(x.models).length > 1) rec.models = Object.fromEntries(Object.entries(x.models).map(([m, t]) => [m, addTokens(t, null)]));
  return rec;
}

const msOrNull = (v) => (v == null || v === '' || !Number.isFinite(Number(v)) ? null : Math.max(0, Math.round(Number(v))));

/** The timing block of a "request" record, coerced. Pure. */
export function requestTiming(t = {}) {
  return {
    preroute: t.preroute !== false, route: String(t.route || '').slice(0, 20), via: String(t.via || '').slice(0, 20),
    routerMs: msOrNull(t.routerMs) ?? 0, timeToFiledMs: msOrNull(t.timeToFiledMs), timeToReplyMs: msOrNull(t.timeToReplyMs),
    filedBy: String(t.filedBy || '').slice(0, 20), ...(t.traceId ? { traceId: String(t.traceId).slice(0, 40) } : {}),
    // The quick-task fast path (src/quick.js): lane 'quick', its tier, and why it went to the full brain if it did.
    // tier 'local' = the local responder answered (src/responder.js); fallback = why it couldn't and Claude answered instead.
    // YOLO (src/yolo.js): lane 'yolo', the run id and the time from intake to the agent's first file in the sandbox.
    ...(t.lane === 'yolo' ? { lane: 'yolo', runId: String(t.runId || '').slice(0, 40), timeToFirstFrameMs: msOrNull(t.timeToFirstFrameMs) }
      : t.lane ? { lane: String(t.lane).slice(0, 20), tier: String(t.tier || '').slice(0, 20), ...(t.escalated ? { escalated: String(t.escalated).slice(0, 200) } : {}), ...(t.fallback ? { fallback: String(t.fallback).slice(0, 200) } : {}) } : {}),
  };
}

let appending = Promise.resolve();

/** Append a record to this machine's ledger. Never throws: a failure is logged and resolves to null. */
export function appendRecord(x) {
  let rec;
  try { rec = makeRecord(x); } catch (e) { log('usage ledger: bad record: ' + e.message); return Promise.resolve(null); }
  const done = appending.then(async () => {
    await fsp.mkdir(ledgerDir(), { recursive: true });
    await fsp.appendFile(path.join(ledgerDir(), monthOf(rec.tsStart) + '.jsonl'), JSON.stringify(rec) + '\n');
    return rec;
  }).catch((e) => { log('usage ledger: append failed: ' + e.message); return null; });
  appending = done;
  return done;
}

// ---------------------------------------------------------------- tool reuse (src/toolbox.js)
// The tool registry's own small log, next to the token ledger but in files of its own (tools-<YYYY-MM>.jsonl), so its
// events never count as runs in the token totals. One event per tool_run ("run"), per tracked tool_list ("list": the
// ids it returned) and per brief or plan that named tools ("hint").

export const TOOL_EVENTS = ['run', 'list', 'hint'];
const toolLog = (ms) => path.join(ledgerDir(), `tools-${monthOf(ms)}.jsonl`);

/** One clean tool event. Pure (apart from a fresh id). */
export function makeToolEvent(x = {}) {
  const ts = Number(x.ts) || Date.now();
  const ids = (Array.isArray(x.toolIds) ? x.toolIds : []).map((i) => String(i).slice(0, 60)).slice(0, 10);
  return {
    id: String(x.id || crypto.randomUUID()), ts, node: String(x.node || config().name || ''),
    event: TOOL_EVENTS.includes(x.event) ? x.event : 'run',
    toolId: String(x.toolId || '').slice(0, 60), toolIds: ids,
    ok: x.ok !== false, hits: x.hits != null ? num(x.hits) : ids.length,
    query: truncate(String(x.query || '').replace(/\s+/g, ' ').trim(), 120),
    durationMs: num(x.durationMs), trace: String(x.trace || ''), seat: String(x.seat || '').slice(0, 80),
    ...(x.error ? { error: truncate(String(x.error), 200) } : {}),
  };
}

/** Append a tool event to this machine's log. Never throws (nothing here may fail a tool call or a dispatch). */
export function recordToolEvent(x) {
  let ev;
  try { ev = makeToolEvent(x); } catch (e) { log('tool log: bad event: ' + e.message); return Promise.resolve(null); }
  const done = appending.then(async () => {
    await fsp.mkdir(ledgerDir(), { recursive: true });
    await fsp.appendFile(toolLog(ev.ts), JSON.stringify(ev) + '\n');
    return ev;
  }).catch((e) => { log('tool log: append failed: ' + e.message); return null; });
  appending = done;
  return done;
}

/** Tool events with ts in [since, until], oldest first. */
export async function readToolEvents({ since = 0, until = Infinity } = {}) {
  const files = (await fsp.readdir(ledgerDir()).catch(() => [])).filter((f) => /^tools-\d{4}-\d{2}\.jsonl$/.test(f)).sort();
  const from = since ? monthOf(since) : '';
  const to = Number.isFinite(until) ? monthOf(until) : '9999-99';
  const out = [];
  for (const f of files) {
    const m = f.slice(6, 13);
    if (m < from || m > to) continue;
    for (const line of (await fsp.readFile(path.join(ledgerDir(), f), 'utf8').catch(() => '')).split('\n')) {
      if (!line) continue;
      try { const e = JSON.parse(line); if (e.ts >= since && e.ts <= until) out.push(e); } catch {}
    }
  }
  return out.sort((a, b) => a.ts - b.ts);
}

export const emptyToolReuse = () => ({ runs: 0, failed: 0, lists: 0, listHits: 0, listMisses: 0, hinted: 0, byTool: [] });

/**
 * Tool reuse counts: runs (and failed ones), lists (with hits / misses), briefs and plans that named tools, and per
 * tool how often it ran, was listed or was named. Pure; byTool is most used first.
 */
export function toolReuse(events) {
  const out = emptyToolReuse();
  const by = new Map();
  const row = (id) => { if (!by.has(id)) by.set(id, { id, runs: 0, failed: 0, listed: 0, hinted: 0 }); return by.get(id); };
  for (const e of events || []) {
    if (e.event === 'run') { out.runs++; const r = row(e.toolId || '(unknown)'); r.runs++; if (e.ok === false) { out.failed++; r.failed++; } }
    else if (e.event === 'list') { out.lists++; if ((e.hits || 0) > 0) out.listHits++; else out.listMisses++; for (const i of e.toolIds || []) row(i).listed++; }
    else if (e.event === 'hint') { out.hinted++; for (const i of e.toolIds || []) row(i).hinted++; }
  }
  out.byTool = [...by.values()].sort((a, b) => b.runs - a.runs || b.listed - a.listed || b.hinted - a.hinted || a.id.localeCompare(b.id));
  return out;
}

/** Two toolReuse sums added up (the mesh view adds every node's). Pure. */
export function addToolReuse(a, b) {
  const out = { ...emptyToolReuse(), ...a, byTool: [] };
  for (const k of ['runs', 'failed', 'lists', 'listHits', 'listMisses', 'hinted']) out[k] = (Number(a?.[k]) || 0) + (Number(b?.[k]) || 0);
  const by = new Map();
  for (const r of [...(a?.byTool || []), ...(b?.byTool || [])]) {
    const x = by.get(r.id) || { id: r.id, runs: 0, failed: 0, listed: 0, hinted: 0 };
    for (const k of ['runs', 'failed', 'listed', 'hinted']) x[k] += Number(r[k]) || 0;
    by.set(r.id, x);
  }
  out.byTool = [...by.values()].sort((x, y) => y.runs - x.runs || y.listed - x.listed || y.hinted - x.hinted || x.id.localeCompare(y.id));
  return out;
}

/** Records whose run overlaps [since, until] (ms; either may be omitted), oldest first. */
export async function readRecords({ since = 0, until = Infinity } = {}) {
  const files = (await fsp.readdir(ledgerDir()).catch(() => [])).filter((f) => /^\d{4}-\d{2}\.jsonl$/.test(f)).sort();
  // A run is filed under the month it started in: one month of slack before `since` catches long runs.
  const from = since ? monthOf(since - 31 * 86400000) : '';
  const to = Number.isFinite(until) ? monthOf(until) : '9999-99';
  const out = [];
  for (const f of files) {
    const m = f.slice(0, 7);
    if (m < from || m > to) continue;
    const text = await fsp.readFile(path.join(ledgerDir(), f), 'utf8').catch(() => '');
    for (const line of text.split('\n')) {
      if (!line) continue;
      let r;
      try { r = JSON.parse(line); } catch { continue; }
      if (r.tsEnd >= since && r.tsStart <= until) out.push(r);
    }
  }
  // Append-only: a record written again under the same id (a backfill re-run that found the transcript) replaces it.
  const byId = new Map();
  for (const r of out) byId.set(r.id, r);
  return [...byId.values()].sort((a, b) => a.tsStart - b.tsStart);
}

/** The key (and a readable label) a record is grouped under. */
export function groupKey(r, by) {
  if (by === 'model') return { key: r.model || r.provider || 'unknown', label: r.model || r.provider || 'unknown' };
  if (by === 'project') return { key: r.projectId || '(none)', label: r.projectName || (r.projectId ? r.projectId : r.kind === 'chat-turn' ? 'JARVIS chat' : '(none)') };
  if (by === 'task') return r.taskId ? { key: `${r.projectId}/${r.taskId}`, label: r.taskTitle || r.taskId } : { key: `(${r.kind})`, label: r.kind === 'chat-turn' ? 'chat turns' : r.kind };
  if (by === 'node') return { key: r.node || 'unknown', label: r.node || 'unknown' };
  if (by === 'day') { const d = new Date(r.tsStart).toISOString().slice(0, 10); return { key: d, label: d }; }
  if (by === 'provider') return { key: r.provider || 'unknown', label: r.provider || 'unknown' };
  if (by === 'kind') return { key: r.kind, label: r.kind };
  throw new Error(`groupBy must be one of ${GROUP_BYS.join(', ')}`);
}

/** Sums over a set of records: count, time, tokens, cost (null when no record had one), statuses. Pure. */
export function totals(records) {
  const t = { count: 0, durationMs: 0, ...emptyTokens(), totalTokens: 0, costUsd: null, done: 0, failed: 0, blocked: 0, stopped: 0, estimated: 0 };
  for (const r of records) {
    t.count++;
    t.durationMs += num(r.durationMs);
    for (const k of TOKEN_KEYS) t[k] += num(r[k]);
    if (r.costUsd != null) t.costUsd = Math.round(((t.costUsd || 0) + Number(r.costUsd)) * 1e6) / 1e6;
    if (t[r.status] != null) t[r.status]++;
    if (r.estimated) t.estimated++;
  }
  t.totalTokens = TOKEN_KEYS.reduce((a, k) => a + t[k], 0);
  return t;
}

/** Records grouped by one dimension, biggest token spend first (days in date order). Pure. */
export function aggregate(records, by) {
  const groups = new Map();
  for (const r of records) {
    const { key, label } = groupKey(r, by);
    if (!groups.has(key)) groups.set(key, { key, label, records: [] });
    groups.get(key).records.push(r);
  }
  const out = [...groups.values()].map((g) => ({ key: g.key, label: g.label, ...totals(g.records) }));
  return by === 'day' ? out.sort((a, b) => a.key.localeCompare(b.key)) : out.sort((a, b) => b.totalTokens - a.totalTokens || b.durationMs - a.durationMs);
}

/** `groupBy` query → list of dimensions (comma-separated; empty means all five main ones). */
export function parseGroupBy(s) {
  const list = String(s || '').split(',').map((x) => x.trim()).filter(Boolean);
  const want = list.length ? list : ['model', 'project', 'task', 'node', 'day'];
  for (const g of want) if (!GROUP_BYS.includes(g)) throw new Error(`groupBy must be one of ${GROUP_BYS.join(', ')}`);
  return want;
}

/** A date query value: ms, ISO date, or a relative "24h" / "7d" / "30m". */
export function parseTime(v, now = Date.now()) {
  if (v == null || v === '') return null;
  const s = String(v).trim();
  const rel = s.match(/^(\d+(?:\.\d+)?)\s*([mhdw])$/i);
  if (rel) return now - Number(rel[1]) * { m: 60000, h: 3600000, d: 86400000, w: 604800000 }[rel[2].toLowerCase()];
  if (/^\d{10,}$/.test(s)) return Number(s);
  const t = Date.parse(s);
  if (Number.isNaN(t)) throw new Error(`bad time "${s}" — use ms, an ISO date or e.g. 24h / 7d`);
  return t;
}

/** Filter + shape records into the API answer: newest records first (up to `limit`), totals and the groupings. */
export function summarize(records, { groupBy, limit = 500, node, since = null, until = null } = {}) {
  const dims = parseGroupBy(groupBy);
  const sorted = [...records].sort((a, b) => b.tsStart - a.tsStart);
  return {
    ...(node ? { node } : {}), since, until, groupBy: dims, count: records.length,
    totals: totals(records),
    groups: Object.fromEntries(dims.map((d) => [d, aggregate(records, d)])),
    records: sorted.slice(0, Math.max(0, Number(limit) || 0)),
    truncated: sorted.length > limit,
  };
}

/** This machine's ledger for GET /api/local/usage (query: since, until, groupBy, limit, kind, project). */
export async function report(q = {}) {
  const since = parseTime(q.since);
  const until = parseTime(q.until);
  let recs = await readRecords({ since: since || 0, until: until ?? Infinity });
  recs = q.kind ? recs.filter((r) => r.kind === q.kind) : recs.filter((r) => r.kind !== 'request');
  if (q.project) recs = recs.filter((r) => r.projectId === q.project);
  const out = summarize(recs, { groupBy: q.groupBy, limit: q.limit != null && q.limit !== '' ? Number(q.limit) : 500, node: config().name, since, until });
  out.toolReuse = toolReuse(await readToolEvents({ since: since || 0, until: until ?? Infinity }));
  return out;
}

/** Two totals (or group rows) added up; costUsd stays null only when neither side had one. Pure. */
export function addTotals(a, b) {
  const out = { ...a };
  for (const [k, v] of Object.entries(b)) {
    if (k === 'key' || k === 'label') { out[k] ??= v; continue; }
    if (k === 'costUsd') { out.costUsd = a.costUsd == null && v == null ? null : Math.round(((Number(a.costUsd) || 0) + (Number(v) || 0)) * 1e6) / 1e6; continue; }
    if (typeof v === 'number') out[k] = (Number(a[k]) || 0) + v;
  }
  return out;
}

/**
 * Mesh-wide ledger (GET /api/usage), following aggregateApps: results = [{ node, report } | { node, error }]. Each
 * node sums its own ledger in full (totals, groups); here those sums are added up per key and the newest records of
 * every node are merged, so a record limit never skews the numbers.
 */
export function aggregateUsage(results, q = {}) {
  const dims = parseGroupBy(q.groupBy);
  const limit = q.limit != null && q.limit !== '' ? Number(q.limit) : 500;
  let sum = totals([]);
  let reuse = emptyToolReuse();
  const groups = Object.fromEntries(dims.map((d) => [d, new Map()]));
  const records = [];
  const errors = [];
  for (const r of results) {
    if (r.error) { errors.push({ node: r.node.name, error: r.error }); continue; }
    const rep = r.report || {};
    sum = addTotals(sum, rep.totals || totals([]));
    reuse = addToolReuse(reuse, rep.toolReuse);
    for (const d of dims) for (const g of rep.groups?.[d] || []) groups[d].set(g.key, groups[d].has(g.key) ? addTotals(groups[d].get(g.key), g) : { ...g });
    records.push(...(rep.records || []));
  }
  records.sort((a, b) => b.tsStart - a.tsStart);
  const order = (d, list) => (d === 'day' ? list.sort((a, b) => a.key.localeCompare(b.key)) : list.sort((a, b) => b.totalTokens - a.totalTokens || b.durationMs - a.durationMs));
  return {
    since: parseTime(q.since), until: parseTime(q.until), groupBy: dims, count: sum.count, totals: sum,
    groups: Object.fromEntries(dims.map((d) => [d, order(d, [...groups[d].values()])])),
    records: records.slice(0, Math.max(0, limit)), truncated: records.length > limit || results.some((r) => r.report?.truncated),
    toolReuse: reuse, nodes: results.map((r) => r.node.name), errors,
  };
}

// ---------------------------------------------------------------- harness usage parsers (pure)

/** The model that did most of the work (most tokens, cache included) among { model: tokens }. */
export function mainModel(models, fallback = '') {
  const size = (t) => TOKEN_KEYS.reduce((a, k) => a + num(t[k]), 0);
  return Object.entries(models || {}).sort((a, b) => size(b[1]) - size(a[1]))[0]?.[0] || fallback || '';
}

/**
 * Claude Code `-p --output-format stream-json` final {type:"result"} event → tokens, cost, per-model split.
 * modelUsage and total_cost_usd are the whole session's so far — after `--resume` they include every earlier turn — so
 * a resumed turn is the difference from `prev`, the totals the chat's previous turn saw (returned as `cumulative`).
 * Resumed without them, `usage` (this turn's main-loop calls) is all that is known. `usage` is per turn.
 */
export function claudeResultUsage(e, { prev = null, resumed = false } = {}) {
  if (!e || e.type !== 'result') return null;
  const cum = {};
  for (const [m, u] of Object.entries(e.modelUsage || {})) {
    cum[m] = { inputTokens: num(u.inputTokens), outputTokens: num(u.outputTokens), cacheReadTokens: num(u.cacheReadInputTokens), cacheWriteTokens: num(u.cacheCreationInputTokens) };
  }
  const cumCost = e.total_cost_usd ?? e.cost_usd ?? null;
  const sessionId = e.session_id || '';
  const cumulative = { sessionId, models: cum, costUsd: cumCost };
  const u = e.usage || {};
  const fromUsage = { inputTokens: num(u.input_tokens), outputTokens: num(u.output_tokens), cacheReadTokens: num(u.cache_read_input_tokens), cacheWriteTokens: num(u.cache_creation_input_tokens) };
  let models = cum;
  let costUsd = cumCost;
  const before = prev && prev.sessionId === sessionId ? prev.models || {} : null;
  // A session whose totals went down was not carried over (nothing to subtract): take it as this turn's.
  const carried = before && Object.entries(before).every(([m, t]) => TOKEN_KEYS.every((k) => num(cum[m]?.[k]) >= num(t[k])));
  if (carried) {
    models = {};
    for (const [m, t] of Object.entries(cum)) {
      const d = Object.fromEntries(TOKEN_KEYS.map((k) => [k, num(t[k]) - num(before[m]?.[k])]));
      if (TOKEN_KEYS.some((k) => d[k])) models[m] = d;
    }
    costUsd = cumCost != null && prev.costUsd != null ? Math.max(0, cumCost - prev.costUsd) : null;
  } else if (resumed) {
    models = { [mainModel(cum) || 'unknown']: fromUsage };
    costUsd = null;
  }
  // modelUsage covers every model the turn used (e.g. a Haiku side call); usage alone is the main model's.
  const sum = Object.values(models).reduce((a, t) => addTokens(a, t), emptyTokens());
  const tokens = Object.keys(models).length || carried ? sum : fromUsage;
  return { ...tokens, costUsd, durationMs: num(e.duration_ms), model: mainModel(models, mainModel(cum)), models, sessionId, cumulative };
}

/**
 * Codex `exec --json` {type:"turn.completed", usage} → tokens (Codex counts cached input inside input_tokens). The
 * usage is the thread's running total, also after `exec resume`: `prev` is the raw usage the previous turn reported.
 */
export function codexTurnUsage(e, prev = null) {
  if (!e || e.type !== 'turn.completed' || !e.usage) return null;
  const u = e.usage;
  const keys = ['input_tokens', 'cached_input_tokens', 'output_tokens'];
  const base = prev && keys.every((k) => num(u[k]) >= num(prev[k])) ? prev : null;
  const d = (k) => num(u[k]) - num(base?.[k]);
  const cached = d('cached_input_tokens');
  return { inputTokens: Math.max(0, d('input_tokens') - cached), outputTokens: d('output_tokens'), cacheReadTokens: cached, cacheWriteTokens: 0 };
}

/** Ollama /api/chat final chunk {done:true, prompt_eval_count, eval_count, total_duration (ns)} → tokens + time. */
export function ollamaUsage(e) {
  if (!e || !e.done) return null;
  return { inputTokens: num(e.prompt_eval_count), outputTokens: num(e.eval_count), cacheReadTokens: 0, cacheWriteTokens: 0, durationMs: num((e.total_duration || 0) / 1e6) };
}

// ---------------------------------------------------------------- transcript slices (pure)

const inWindow = (ts, since, until) => { const t = Date.parse(ts); return Number.isFinite(t) && t >= since && t <= until; };
const userText = (c) => (typeof c === 'string' ? c : Array.isArray(c) ? c.filter((b) => b?.type === 'text' || b?.type === 'input_text').map((b) => b.text).join('\n') : '');
// work.js hands agents the brief path with "/" separators, also on Windows where the run records it with "\".
const hasBrief = (text, brief) => !!brief && (text.includes(brief) || text.includes(brief.replace(/\\/g, '/')));

/**
 * Claude Code transcript records → the tokens spent in [since, until] (per model; each API message once) and whether
 * the transcript belongs to `seat` (its agent-name / custom-title) or got `brief` typed into it.
 */
export function claudeSlice(records, { since = 0, until = Infinity, seat = '', brief = '' } = {}) {
  const acc = newAcc();
  let matched = false;
  let first = 0;
  let last = 0;
  for (const rec of records) {
    if (!rec || typeof rec !== 'object') continue;
    if (seat && ((rec.type === 'agent-name' && rec.agentName === seat) || (rec.type === 'custom-title' && rec.customTitle === seat))) matched = true;
    if (rec.type === 'user' && hasBrief(userText(rec.message?.content), brief)) matched = true;
    if (rec.type !== 'assistant' || !rec.message?.usage || !inWindow(rec.timestamp, since, until)) continue;
    foldRecord(acc, rec);
    const t = Date.parse(rec.timestamp);
    first = first || t;
    last = t;
  }
  return { matched, ...perModelToTokens(acc.perModel), first, last };
}

function perModelToTokens(perModel) {
  const models = {};
  let messages = 0;
  for (const [m, t] of Object.entries(perModel)) {
    models[m] = { inputTokens: t.input, outputTokens: t.output, cacheReadTokens: t.cacheRead, cacheWriteTokens: t.cacheWrite };
    messages += t.messages || 0;
  }
  const tokens = Object.values(models).reduce((a, t) => addTokens(a, t), emptyTokens());
  return { ...tokens, models, messages };
}

/**
 * Codex rollout records → tokens spent in [since, until]: the running total_token_usage at the end of the window minus
 * the total before it (robust to repeated token_count events), attributed to the session's model.
 */
export function codexSlice(records, { since = 0, until = Infinity, seat = '', brief = '' } = {}) {
  let matched = false;
  let model = '';
  let before = null;
  let atEnd = null;
  let first = 0;
  let last = 0;
  let cwd = '';
  for (const rec of records) {
    const p = rec?.payload || {};
    if (rec?.type === 'session_meta') cwd = p.cwd || cwd;
    if (rec?.type === 'turn_context' && p.model) model = p.model;
    if (rec?.type === 'event_msg' && p.type === 'user_message' && ((seat && String(p.message || '').includes(seat)) || hasBrief(String(p.message || ''), brief))) matched = true;
    if (rec?.type === 'response_item' && p.type === 'message' && p.role === 'user') {
      const t = userText(p.content);
      if ((seat && t.includes(seat)) || hasBrief(t, brief)) matched = true;
    }
    if (rec?.type !== 'event_msg' || p.type !== 'token_count' || !p.info?.total_token_usage) continue;
    const ts = Date.parse(rec.timestamp);
    if (!Number.isFinite(ts)) continue;
    if (ts < since) before = p.info.total_token_usage;
    else if (ts <= until) { atEnd = p.info.total_token_usage; first = first || ts; last = ts; }
  }
  const d = (k) => Math.max(0, num(atEnd?.[k]) - num(before?.[k]));
  const cached = d('cached_input_tokens');
  const tokens = atEnd ? { inputTokens: Math.max(0, d('input_tokens') - cached), outputTokens: d('output_tokens'), cacheReadTokens: cached, cacheWriteTokens: 0 } : emptyTokens();
  const models = atEnd ? { [model || 'codex']: tokens } : {};
  return { matched, ...tokens, models, messages: atEnd ? 1 : 0, first, last, cwd };
}

// ---------------------------------------------------------------- task runs: transcripts on this machine

async function readJsonl(file) {
  const text = await fsp.readFile(file, 'utf8').catch(() => '');
  const out = [];
  for (const line of text.split('\n')) {
    if (!line) continue;
    try { out.push(JSON.parse(line)); } catch { /* partial or foreign line */ }
  }
  return out;
}

async function jsonlFilesSince(dir, since, depth = 0, maxDepth = 0) {
  const out = [];
  for (const e of await fsp.readdir(dir, { withFileTypes: true }).catch(() => [])) {
    const p = path.join(dir, e.name);
    if (e.isDirectory() && depth < maxDepth) out.push(...await jsonlFilesSince(p, since, depth + 1, maxDepth));
    else if (e.isFile() && e.name.endsWith('.jsonl')) {
      const st = await fsp.stat(p).catch(() => null);
      if (st && st.mtimeMs >= since) out.push(p);
    }
  }
  return out;
}

/** Claude Code's folder name for a working directory (every non-alphanumeric character becomes "-"). */
export const claudeProjectDir = (cwd) => String(cwd || '').replace(/[^a-zA-Z0-9]/g, '-');

/**
 * The transcripts of one task run on THIS machine: the Claude Code sessions that belong to its seat (by name) or were
 * handed its brief — in the run's own folder first, every other folder only when nothing there matches (a symlinked
 * cwd) — with their subagent transcripts; else the Codex rollouts that match. Each comes with its slice over
 * [since, until]. → [{ id, provider, records, slice, sub }]. The usage ledger sums the slices (taskUsage); request
 * traces turn the records into spans (trace.recordRunEnd).
 */
export async function runTranscripts({ since, until = Date.now(), cwd = '', seat = '', brief = '' } = {}) {
  since = Number(since) || 0;
  until = Number(until) || Date.now();
  const markers = { since, until, seat, brief };
  const out = [];
  if (!seat && !brief) return out;
  const root = path.join(CLAUDE_DIR, 'projects');
  const own = cwd ? path.join(root, claudeProjectDir(cwd)) : '';
  const all = (await fsp.readdir(root).catch(() => [])).map((d) => path.join(root, d));
  for (const dirs of [own && fs.existsSync(own) ? [own] : [], all.filter((d) => d !== own)]) {
    for (const dir of dirs) {
      for (const file of await jsonlFilesSince(dir, since)) {
        const records = await readJsonl(file);
        const s = claudeSlice(records, markers);
        if (!s.matched) continue;
        const id = path.basename(file, '.jsonl');
        out.push({ id, provider: 'claude', records, slice: s, sub: false });
        for (const sub of await jsonlFilesSince(path.join(dir, id, 'subagents'), since)) {
          const subRecords = await readJsonl(sub);
          out.push({ id: `${id}/${path.basename(sub, '.jsonl')}`, provider: 'claude', records: subRecords, slice: claudeSlice(subRecords, { since, until }), sub: true });
        }
      }
    }
    if (out.length) return out;
  }
  for (const file of await jsonlFilesSince(path.join(CODEX_DIR, 'sessions'), since, 0, 3)) {
    const records = await readJsonl(file);
    const s = codexSlice(records, markers);
    if (s.matched) out.push({ id: path.basename(file, '.jsonl'), provider: 'codex', records, slice: s, sub: false });
  }
  return out;
}

/**
 * Tokens one task run spent on THIS machine: the slices of its transcripts (runTranscripts), summed over [since, until]
 * only. Subagent transcripts of a matched session count too.
 * → { inputTokens…, models, sessions: [ids], matched: n, provider }.
 */
export async function taskUsage(q = {}) {
  let total = emptyTokens();
  const models = {};
  const sessions = [];
  for (const { id, slice: s } of await runTranscripts(q)) {
    total = addTokens(total, s);
    for (const [m, t] of Object.entries(s.models)) models[m] = addTokens(models[m], t);
    sessions.push(id);
  }
  return { ...total, models, sessions, matched: sessions.length };
}

// ---------------------------------------------------------------- capture into the ledger

let slicer = null;

/** The server wires how to read a run's transcripts on any machine: (node, query) → taskUsage on that node. */
export function setSlicer(fn) { slicer = fn; }


/** A JARVIS chat turn (or a planning call, kind "plan") → one ledger record. Never throws. */
export async function recordChatTurn({ chat, tag, brain, model, effort, startedAt, out, aborted, lane = '', tier = '' }) {
  try {
    const u = out?.usage || null;
    const t = tag || {};
    return await appendRecord({
      tsStart: startedAt, tsEnd: Date.now(),
      kind: LEDGER_KINDS.includes(t.kind) ? t.kind : 'chat-turn',
      // The model the harness reports ("claude-haiku-5-5") over the alias asked for ("haiku"), so a model is one row.
      provider: brain, model: u?.model || model || '', effort,
      projectId: t.projectId || chat?.project || '', projectName: t.projectName || '', taskId: t.taskId || '', taskTitle: t.taskTitle || (t.kind ? chat?.title : '') || '',
      chatId: chat?.id || '', sessionId: u?.sessionId || chat?.claudeSessionId || chat?.codexThreadId || '',
      ...(u ? { inputTokens: u.inputTokens, outputTokens: u.outputTokens, cacheReadTokens: u.cacheReadTokens, cacheWriteTokens: u.cacheWriteTokens, costUsd: u.costUsd ?? null, models: u.models } : {}),
      tokensFrom: u ? 'harness' : 'none',
      status: aborted ? 'stopped' : out?.error ? 'failed' : 'done',
      outcome: out?.error && !out?.text ? out.error : firstLine(out?.text),
      ...(lane ? { lane } : {}), ...(tier ? { tier } : {}),
    });
  } catch (e) { log('usage ledger: chat turn: ' + e.message); return null; }
}

/** One request from Sir (chat.jarvisSend) → one "request" ledger record with its timing. Never throws. */
export async function recordRequest(x = {}) {
  try {
    const t = requestTiming(x);
    return await appendRecord({
      tsStart: x.tsStart, tsEnd: x.tsEnd, kind: 'request', provider: t.via === 'jev' ? 'jev' : t.via === 'model' ? 'claude' : '', model: x.model || '',
      chatId: x.chatId || '', status: x.status, tokensFrom: 'none', request: { ...t, traceId: x.traceId }, ...(t.lane ? { lane: t.lane } : {}),
      outcome: (t.preroute ? `pre-routed: ${t.route || '?'} (${t.via || '?'}, ${t.routerMs} ms)${t.filedBy ? `, filed by ${t.filedBy}` : ''}` : `pre-routing off${t.filedBy ? ', filed by the brain' : ''}`)
        + (t.lane === 'quick' ? `, fast path ${t.tier}${t.fallback ? ` (local responder unavailable: ${t.fallback})` : ''}${t.escalated ? ` → full brain (${t.escalated})` : ''}` : '')
        + (t.lane === 'yolo' ? `, YOLO run ${t.runId || '?'}${t.timeToFirstFrameMs != null ? `, first frame after ${t.timeToFirstFrameMs} ms` : ', no frame'}` : ''),
    });
  } catch (e) { log('usage ledger: request: ' + e.message); return null; }
}

/** Ledger kind for a project task. */
export const taskLedgerKind = (taskKind) => (taskKind === 'review' ? 'review' : taskKind === 'merge' ? 'merge' : 'task');

/**
 * A task run ended (reported, failed, stalled, stopped): sum its transcript slice on the machine it ran on and file one
 * record here. e = { node, project:{id,name}, task:{id,title,kind,attempts}, assign, run, since, until, status, summary }.
 * Never throws; a transcript that can't be read leaves a record without tokens (tokensFrom "none", error set).
 */
export async function recordTaskRun(e, { slice = slicer } = {}) {
  try {
    const run = e.run || {};
    let u = null;
    let error = '';
    const q = { since: e.since, until: e.until, cwd: run.cwd || '', seat: run.seat || '', brief: run.brief || '' };
    if (slice && (q.seat || q.brief)) {
      try { u = await slice(e.node, q); } catch (err) { error = 'transcript: ' + err.message; }
    }
    return await appendRecord({
      id: e.id, tsStart: e.since, tsEnd: e.until, node: e.node, kind: taskLedgerKind(e.task?.kind),
      provider: e.assign?.provider || '', model: mainModel(u?.models, e.assign?.model), effort: e.assign?.effort || '',
      projectId: e.project?.id, projectName: e.project?.name, taskId: e.task?.id, taskTitle: e.task?.title, taskKind: e.task?.kind,
      sessionId: (u?.sessions || []).join(',') || run.seat || run.session?.id || '',
      ...(u ? { inputTokens: u.inputTokens, outputTokens: u.outputTokens, cacheReadTokens: u.cacheReadTokens, cacheWriteTokens: u.cacheWriteTokens, models: u.models } : {}),
      tokensFrom: u?.matched ? 'transcript' : 'none', error: error || (u && !u.matched ? 'no transcript found for this run' : ''),
      status: e.status, outcome: e.summary, attempt: (e.task?.attempts || 0) + 1, estimated: e.estimated,
    });
  } catch (err) { log('usage ledger: task run: ' + err.message); return null; }
}

// ---------------------------------------------------------------- backfill (estimated)

async function readJsonDir(dir) {
  const out = [];
  for (const f of await fsp.readdir(dir).catch(() => [])) {
    if (!f.endsWith('.json')) continue;
    try { out.push(JSON.parse(await fsp.readFile(path.join(dir, f), 'utf8'))); } catch {}
  }
  return out;
}

/** When a task's run ended, from the project log ("t2 → done: …"); else the project's last update for a done task. */
export function taskEndFromLog(p, t, since) {
  const hits = (p.log || []).filter((e) => e.ts >= since && (e.text || '').startsWith(`${t.id} → `));
  if (hits.length) return hits[hits.length - 1].ts;
  return t.status === 'done' ? p.updatedAt || null : null;
}

async function findClaudeSessionFile(id) {
  if (!/^[\w-]+$/.test(id || '')) return null;
  const root = path.join(CLAUDE_DIR, 'projects');
  for (const d of await fsp.readdir(root).catch(() => [])) {
    const f = path.join(root, d, id + '.jsonl');
    if (fs.existsSync(f)) return f;
  }
  return null;
}

async function findCodexRollout(threadId) {
  if (!threadId) return null;
  const files = await jsonlFilesSince(path.join(CODEX_DIR, 'sessions'), 0, 0, 3);
  return files.find((f) => path.basename(f).includes(threadId)) || null;
}

/**
 * Best-effort ledger from what happened before it existed: project task runs (their time windows from the project log,
 * tokens from the run's transcript slice on its machine via the slicer) and JARVIS chat turns (tokens from the Claude
 * Code / Codex session behind the chat). Every record is estimated:true with a stable id, so running it again only
 * adds what is missing — or rewrites a record that had no tokens and now finds them.
 */
export async function backfill({ slice = slicer, now = Date.now() } = {}) {
  const have = new Map((await readRecords()).map((r) => [r.id, r]));
  const live = [...have.values()].filter((r) => !r.estimated);
  const need = (id) => !have.has(id) || (have.get(id).tokensFrom === 'none' && have.get(id).estimated);
  let tasks = 0;
  let chats = 0;
  for (const p of await readJsonDir(path.join(RIGS_HOME, 'projects'))) {
    for (const t of p.tasks || []) {
      if (!t.run || !t.assign?.node || !['done', 'failed', 'blocked'].includes(t.status)) continue;
      const since = t.startingAt || t.run.startedAt;
      const until = since && taskEndFromLog(p, t, since);
      if (!since || !until || until < since) continue;
      const id = `bf-${p.id}-${t.id}-${since}`;
      if (!need(id) || live.some((r) => r.projectId === p.id && r.taskId === t.id && Math.abs(r.tsStart - since) < 60000)) continue;
      const rec = await recordTaskRun({ id, node: t.assign.node, project: { id: p.id, name: p.name }, task: { id: t.id, title: t.title, kind: t.kind, attempts: t.attempts || 0 }, assign: t.assign, run: t.run, since, until, status: t.status, summary: t.summary, estimated: true }, { slice });
      if (rec) tasks++;
    }
  }
  for (const c of await readJsonDir(path.join(RIGS_HOME, 'chats'))) {
    const msgs = c.messages || [];
    const byBrain = {}; // brain → its session's transcript records (a chat can switch brains mid-conversation)
    for (let i = 0; i < msgs.length; i++) {
      const m = msgs[i];
      if (m.role !== 'assistant' || m.report || !['claude', 'codex', 'ollama'].includes(m.brain) || !m.ts) continue;
      const id = `bf-chat-${c.id}-${i}`;
      if (!need(id) || live.some((r) => r.chatId === c.id && Math.abs(r.tsEnd - m.ts) < 15000)) continue;
      let start = 0;
      for (let k = i - 1; k >= 0; k--) if (msgs[k].role === 'user') { start = msgs[k].ts || 0; break; }
      if (!start || start > m.ts) continue;
      if (!byBrain[m.brain]) {
        const file = c.claudeSessionId && m.brain === 'claude' ? await findClaudeSessionFile(c.claudeSessionId) : c.codexThreadId && m.brain === 'codex' ? await findCodexRollout(c.codexThreadId) : null;
        byBrain[m.brain] = file ? await readJsonl(file) : [];
      }
      const records = byBrain[m.brain];
      const u = records.length ? (m.brain === 'codex' ? codexSlice : claudeSlice)(records, { since: start - 1000, until: m.ts + 1000 }) : null;
      const plan = /^Plan · /.test(c.title || '');
      const rec = await appendRecord({
        id, tsStart: start, tsEnd: m.ts, kind: plan ? 'plan' : 'chat-turn', provider: m.brain, model: mainModel(u?.models, m.model || c.model || ''), effort: m.effort || '',
        projectId: c.project || '', projectName: plan ? c.title.replace(/^Plan · /, '') : '', taskTitle: plan ? c.title : '',
        chatId: c.id, sessionId: c.claudeSessionId || c.codexThreadId || '',
        ...(u && u.messages ? { inputTokens: u.inputTokens, outputTokens: u.outputTokens, cacheReadTokens: u.cacheReadTokens, cacheWriteTokens: u.cacheWriteTokens, models: u.models } : {}),
        tokensFrom: u && u.messages ? 'transcript' : 'none', status: 'done', outcome: firstLine(m.text), estimated: true,
      });
      if (rec) chats++;
    }
  }
  return { ok: true, tasks, chatTurns: chats, at: now };
}
