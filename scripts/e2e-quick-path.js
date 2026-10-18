#!/usr/bin/env node
// Live check of the quick-task fast path on a scratch daemon started from this checkout (never ~/.rigs/app):
//   node scripts/e2e-quick-path.js [--only a,b,c] [--no-baseline]
// Sends three trivial requests through the real POST /api/local/jarvis/send with pre-routing on, once with the fast path
// (quick default) and once with quick:false, then reads each request's trace and the usage ledger and prints a table.
// Needs the real `claude` CLI. The scratch home borrows the installed config (brain, router, mesh token) but never its
// port or OpenRig registration. Writes the run to docs/audits/quick-path-e2e.log.
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const LOG = path.join(ROOT, 'docs', 'audits', 'quick-path-e2e.log');
const PORT = 20000 + Math.floor(Math.random() * 20000);
const BASE = `http://127.0.0.1:${PORT}`;
const HOME = fs.mkdtempSync(path.join(os.tmpdir(), 'rigs-e2e-quick-'));
const arg = (n) => { const i = process.argv.indexOf(n); return i >= 0 ? process.argv[i + 1] : ''; };
const BASELINE = !process.argv.includes('--no-baseline');
const TIMEOUT = 5 * 60 * 1000;

const REQUESTS = [
  { id: 'a', name: 'web search', text: 'search the web: what is the current Node.js LTS version?', tools: /^(WebSearch|WebFetch)$/, want: 'sonnet', budgetMs: 45000 },
  { id: 'b', name: 'tool use', text: 'how loaded is magix-system right now?', tools: /mesh_(status|exec)/, want: 'haiku', budgetMs: 20000 },
  { id: 'c', name: 'report', text: 'give me a short report of which machines are online and their load', tools: /mesh_(status|exec)/, want: 'sonnet', budgetMs: 45000 },
];
const only = arg('--only') ? arg('--only').split(',') : null;

const lines = [];
const t0 = Date.now();
const out = (s) => { const l = `[+${((Date.now() - t0) / 1000).toFixed(1).padStart(5)}s] ${s}`; lines.push(l); console.log(l); };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// Scratch config: the installed one (brain, router, persona, mesh token) without its port, name, OpenRig and speech.
const installed = (() => { try { return JSON.parse(fs.readFileSync(path.join(os.homedir(), '.rigs', 'config.json'), 'utf8')); } catch { return {}; } })();
const { port: _p, openrig: _o, ...rest } = installed;
fs.writeFileSync(path.join(HOME, 'config.json'), JSON.stringify({
  ...rest, name: installed.name || os.hostname().split('.')[0],
  persona: { ...(rest.persona || {}), speakAloud: 'never' },
  openrig: { registerPeers: false, hubs: { enabled: false, jarvis: false } },
  router: { ...(rest.router || {}) },
}, null, 2));

const env = { ...process.env, RIGS_HOME: HOME, RIGS_PORT: String(PORT), RIGS_NO_OPENRIG: '1', RIGS_NO_AUTOUPDATE: '1', RIGS_NO_MIGRATIONS: '1', RIGS_NO_SYSTEMD: '1' };
delete env.TMUX;
const server = spawn(process.execPath, [path.join(ROOT, 'bin/rigs.js'), 'serve'], { env, stdio: ['ignore', 'pipe', 'pipe'] });
let serverOut = '';
server.stdout.on('data', (d) => { serverOut += d; });
server.stderr.on('data', (d) => { serverOut += d; });

const api = async (p, body) => {
  const r = await fetch(BASE + p, body ? { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) } : {});
  const j = await r.json();
  if (!r.ok) throw new Error(`${p} → ${r.status} ${JSON.stringify(j)}`);
  return j;
};

/** One request through jarvis/send (NDJSON stream). Returns the events, the trace id and the wall-clock time. */
async function send(text, extra) {
  const t = Date.now();
  const r = await fetch(BASE + '/api/local/jarvis/send', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ text, preroute: true, ...extra }), signal: AbortSignal.timeout(TIMEOUT) });
  const events = [];
  let buf = '';
  for await (const chunk of r.body) {
    buf += Buffer.from(chunk).toString('utf8');
    let i;
    while ((i = buf.indexOf('\n')) >= 0) { const l = buf.slice(0, i).trim(); buf = buf.slice(i + 1); if (l) { try { events.push(JSON.parse(l)); } catch {} } }
  }
  return { events, wallMs: Date.now() - t, traceId: events.find((e) => e.type === 'trace')?.traceId };
}

const flat = (v) => (Array.isArray(v) ? v.flatMap(flat) : v && typeof v === 'object' ? [v, ...Object.values(v).flatMap(flat)] : []);

/** Route, lane, model, effort, tools and times from the trace plus tokens/cost from the usage ledger. */
async function inspect(res, startedAt) {
  await sleep(1500); // spans and ledger lines are appended asynchronously
  const tr = await api(`/api/local/traces/${res.traceId}`);
  const spans = tr.spans || [];
  const router = spans.find((s) => s.kind === 'router');
  const turn = spans.find((s) => s.kind === 'brain-turn');
  const tools = spans.filter((s) => s.kind === 'tool-call').map((s) => s.name);
  const done = res.events.findLast?.((e) => e.type === 'done') || [...res.events].reverse().find((e) => e.type === 'done');
  const handoff = spans.some((s) => s.kind === 'handoff' || s.kind === 'plan' || s.kind === 'dispatch');
  const route = router?.output?.route || router?.meta?.route || res.events.find((e) => e.type === 'route')?.route || '';
  // ledger: this month's file of the scratch home
  const month = new Date(startedAt).toISOString().slice(0, 7);
  const file = path.join(HOME, 'usage', `${month}.jsonl`);
  const recs = fs.existsSync(file) ? fs.readFileSync(file, 'utf8').trim().split('\n').map((l) => { try { return JSON.parse(l); } catch { return null; } }).filter(Boolean) : [];
  const mine = recs.filter((r) => r.request?.traceId === res.traceId || (r.tsStart >= startedAt - 1000 && r.tsStart <= Date.now() && r.kind !== 'request' && !r.request));
  const req = recs.find((r) => r.request?.traceId === res.traceId)?.request || {};
  const sum = (k) => mine.reduce((a, r) => a + (Number(r[k]) || 0), 0);
  const cost = mine.some((r) => r.costUsd != null) ? mine.reduce((a, r) => a + (Number(r.costUsd) || 0), 0) : null;
  const turnRec = mine.find((r) => r.model) || {};
  return {
    traceId: res.traceId, route: route || req.route || '', lane: req.lane || turn?.meta?.lane || done?.lane || '',
    model: turn?.meta?.model || done?.model || turnRec.model || '', effort: turn?.meta?.effort || done?.effort || turnRec.effort || '',
    tier: req.tier || turn?.meta?.tier || '', tools, handoff, escalated: req.escalated || '',
    timeToReplyMs: req.timeToReplyMs ?? null, routerMs: req.routerMs ?? null, wallMs: res.wallMs,
    tokens: sum('inputTokens') + sum('outputTokens') + sum('cacheReadTokens') + sum('cacheWriteTokens'), cost,
    text: String(done?.text || '').replace(/\s+/g, ' ').trim(), error: res.events.find((e) => e.type === 'error')?.message || '',
    projects: flat(res.events).filter((o) => o.type === 'work' || o.projectId).length,
  };
}

const pad = (v, n) => String(v ?? '').padEnd(n).slice(0, n);
const secs = (ms) => (ms == null ? '—' : (ms / 1000).toFixed(1) + 's');
let ok = false;
try {
  out(`scratch daemon from ${ROOT} on :${PORT}, RIGS_HOME=${HOME}, pre-routing on`);
  for (let i = 0; ; i++) {
    try { if ((await fetch(BASE + '/api/self')).ok) break; } catch {}
    if (i > 150) throw new Error('server did not start:\n' + serverOut);
    await sleep(200);
  }
  try { await api('/api/mesh/refresh', {}); } catch {}
  const q = await api('/api/local/quick');
  out(`quick settings: ${JSON.stringify(q)}`);

  const rows = [];
  for (const r of REQUESTS.filter((x) => !only || only.includes(x.id))) {
    out(`(${r.id}) ${r.name}: "${r.text}"`);
    let t = Date.now();
    const fast = await send(r.text, {});
    const f = await inspect(fast, t);
    out(`    fast: lane=${f.lane || '-'} ${f.model} ${f.effort} tools=[${f.tools.join(',')}] ${secs(f.timeToReplyMs ?? f.wallMs)} ${f.trace || f.traceId}`);
    out(`    reply: ${f.text.slice(0, 240)}`);
    let b = null;
    if (BASELINE) {
      t = Date.now();
      const base = await send(r.text, { quick: false });
      b = await inspect(base, t);
      out(`    baseline (quick:false): lane=${b.lane || '-'} route=${b.route} ${b.model} ${b.effort} tools=[${b.tools.join(',')}] ${secs(b.timeToReplyMs ?? b.wallMs)} ${b.traceId}`);
      out(`    reply: ${b.text.slice(0, 240)}`);
    }
    rows.push({ r, f, b });
  }

  out('--- table ---');
  out(`${pad('request', 12)} ${pad('route', 8)} ${pad('lane', 6)} ${pad('model', 18)} ${pad('effort', 7)} ${pad('tools', 30)} ${pad('reply', 8)} ${pad('tokens', 9)} ${pad('cost', 8)} ${pad('base reply', 10)} ${pad('base tok', 9)} trace`);
  for (const { r, f, b } of rows) {
    const ms = (x) => x.timeToReplyMs ?? x.wallMs;
    const cost = (x) => (x.cost == null ? '—' : '$' + x.cost.toFixed(3));
    out(`${pad(r.name, 12)} ${pad(f.route, 8)} ${pad(f.lane, 6)} ${pad(f.model, 18)} ${pad(f.effort, 7)} ${pad([...new Set(f.tools)].join(','), 30)} ${pad(secs(ms(f)), 8)} ${pad(f.tokens, 9)} ${pad(cost(f), 8)} ${pad(b ? secs(ms(b)) : '—', 10)} ${pad(b ? b.tokens : '—', 9)} ${f.traceId}${b ? ' / ' + b.traceId : ''}`);
  }

  const checks = {};
  for (const { r, f, b } of rows) {
    const ms = f.timeToReplyMs ?? f.wallMs;
    checks[`${r.id}: answered on the quick lane, route answer, no project/handoff/escalation`] = f.lane === 'quick' && (!f.route || f.route === 'answer') && !f.handoff && !f.escalated && !f.error && f.text.length > 0;
    checks[`${r.id}: tool call in the trace (${r.tools})`] = f.tools.some((n) => r.tools.test(n));
    checks[`${r.id}: ${r.want} tier`] = f.model.includes(r.want);
    checks[`${r.id}: under ${r.budgetMs / 1000}s (${secs(ms)})`] = ms < r.budgetMs;
    if (b) checks[`${r.id}: faster than baseline (${secs(ms)} vs ${secs(b.timeToReplyMs ?? b.wallMs)})`] = ms < (b.timeToReplyMs ?? b.wallMs);
  }
  out('--- checks ---');
  for (const [k, v] of Object.entries(checks)) out(`${v ? 'PASS' : 'FAIL'}  ${k}`);
  ok = rows.length > 0 && Object.values(checks).every(Boolean);
  out(ok ? 'E2E PASSED' : 'E2E FAILED');
} catch (e) {
  out('E2E ERROR: ' + e.stack);
} finally {
  server.kill();
  fs.mkdirSync(path.dirname(LOG), { recursive: true });
  fs.writeFileSync(LOG, lines.join('\n') + '\n');
  fs.rmSync(HOME, { recursive: true, force: true });
  process.exit(ok ? 0 : 1);
}
