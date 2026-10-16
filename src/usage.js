// What is working right now, and what it costs — for the JARVIS work dashboard.
//  - Plan limits (5-hour session, weekly, weekly per model e.g. Fable): Claude Code's own `get_usage`
//    control request (no model call, no token handling here), cached for a few minutes.
//  - Codex limits: the newest non-null rate_limits in ~/.codex/sessions rollouts.
//  - Live Claude Code sessions: ~/.claude/sessions/<pid>.json (alive pids), their transcripts tailed
//    incrementally; tokens per model are summed once per API message (a response is written once per
//    content block, so records are deduplicated by message.id); progress from the latest todo list.
import fs from 'node:fs';
import fsp from 'node:fs/promises';
import path from 'node:path';
import { bin } from './tools.js';
import { HOME, augmentedPath, spawnCmd } from './util.js';

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

/** Projects with work in flight: done/total tasks, the running ones and how many are stuck. Pure. */
export function projectProgress(projects) {
  return (projects || []).filter((p) => p.status === 'running' || p.tasks?.some((t) => t.status === 'running')).map((p) => {
    const total = p.tasks?.length || 0;
    const done = (p.tasks || []).filter((t) => t.status === 'done').length;
    return {
      id: p.id, name: p.name, status: p.status, done, total, pct: total ? Math.round((done / total) * 100) : 0,
      main: !!p.main,
      running: (p.tasks || []).filter((t) => t.status === 'running').map((t) => ({ id: t.id, title: t.title, node: t.assign?.node, model: t.assign?.model || t.assign?.provider, effort: t.assign?.effort, via: t.run?.mode === 'openrig' ? `OpenRig ${t.run.seat}` : t.run?.session ? `${t.run.session.kind} ${t.run.session.id}` : '', session: t.run?.session || null, startedAt: t.run?.startedAt || 0 })),
      blocked: (p.tasks || []).filter((t) => t.status === 'blocked' || t.status === 'failed').length,
    };
  });
}
