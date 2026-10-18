// Token and tool-call totals from a Claude Code transcript (.jsonl) or a RIGS usage ledger month file
// (~/.rigs/usage/<YYYY-MM>.jsonl), streamed line by line so a multi-GB file stays cheap. Message text is never
// returned: transcripts hold pasted credentials. { "path": "~/.claude/projects/<dir>/<session>.jsonl" }
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import readline from 'node:readline';

const args = JSON.parse(process.env.RIGS_TOOL_ARGS || process.argv[2] || '{}');
const done = (o) => { console.log(JSON.stringify(o)); process.exit(o.ok ? 0 : 1); };
const num = (v) => (Number.isFinite(Number(v)) ? Number(v) : 0);

const SAMPLE = [
  { type: 'user', timestamp: '2026-10-18T10:00:00.000Z', sessionId: 'sample', message: { role: 'user', content: 'hello' } },
  { type: 'assistant', timestamp: '2026-10-18T10:00:05.000Z', message: { id: 'm1', model: 'claude-sonnet-5-5', usage: { input_tokens: 10, output_tokens: 200, cache_read_input_tokens: 1000, cache_creation_input_tokens: 50 }, content: [{ type: 'tool_use', id: 't1', name: 'Bash', input: {} }] } },
  { type: 'assistant', timestamp: '2026-10-18T10:00:06.000Z', message: { id: 'm1', model: 'claude-sonnet-5-5', usage: { input_tokens: 10, output_tokens: 200, cache_read_input_tokens: 1000, cache_creation_input_tokens: 50 }, content: [{ type: 'tool_use', id: 't2', name: 'TodoWrite', input: { todos: [{ status: 'completed' }, { status: 'pending' }] } }] } },
  { type: 'assistant', timestamp: '2026-10-18T10:01:00.000Z', message: { id: 'm2', model: '<synthetic>', usage: { input_tokens: 1, output_tokens: 1 }, content: [] } },
];

const groupBys = ['model', 'project', 'task', 'node', 'day', 'provider', 'kind'];
const groupBy = String(args.groupBy || 'model');
if (!groupBys.includes(groupBy)) done({ ok: false, error: `groupBy must be one of ${groupBys.join(', ')}` });
const keyOf = (r) => (groupBy === 'day' ? new Date(r.tsStart).toISOString().slice(0, 10)
  : groupBy === 'project' ? r.projectName || r.projectId || '(none)'
    : groupBy === 'task' ? (r.taskId ? `${r.projectId}/${r.taskId}` : `(${r.kind})`) : r[groupBy] || 'unknown');

async function* lines(file) {
  const rl = readline.createInterface({ input: fs.createReadStream(file), crlfDelay: Infinity });
  for await (const l of rl) if (l.trim()) yield l;
}

async function parse(source, format) {
  const out = { format, records: 0, skipped: 0 };
  const seen = new Set();
  const toolSeen = new Set();
  const models = {};
  const toolCalls = {};
  const groups = {};
  const todos = {};
  let first = 0;
  let last = 0;
  let context = 0;
  let sessionId = '';
  for await (const raw of source) {
    let rec;
    try { rec = typeof raw === 'string' ? JSON.parse(raw) : raw; } catch { out.skipped++; continue; }
    out.records++;
    if (format === 'ledger') {
      const g = groups[keyOf(rec)] || (groups[keyOf(rec)] = { runs: 0, inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0, durationMs: 0, costUsd: null });
      g.runs++;
      for (const k of ['inputTokens', 'outputTokens', 'cacheReadTokens', 'cacheWriteTokens', 'durationMs']) g[k] += num(rec[k]);
      if (rec.costUsd != null) g.costUsd = Math.round(((g.costUsd || 0) + num(rec.costUsd)) * 1e6) / 1e6;
      continue;
    }
    sessionId = sessionId || rec.sessionId || '';
    const at = Date.parse(rec.timestamp);
    if (at) { first = first && first < at ? first : at; last = Math.max(last, at); }
    const msg = rec.message;
    if (rec.type !== 'assistant' || !msg) continue;
    const id = msg.id || rec.uuid;
    const model = msg.model || 'unknown';
    if (msg.usage && !seen.has(id) && !model.startsWith('<')) { // <synthetic> messages carry no real usage
      seen.add(id);
      const u = msg.usage;
      const m = models[model] || (models[model] = { messages: 0, input: 0, output: 0, cacheRead: 0, cacheWrite: 0 });
      m.messages++;
      m.input += num(u.input_tokens);
      m.output += num(u.output_tokens);
      m.cacheRead += num(u.cache_read_input_tokens);
      m.cacheWrite += num(u.cache_creation_input_tokens);
      context = num(u.input_tokens) + num(u.cache_read_input_tokens) + num(u.cache_creation_input_tokens);
    }
    for (const b of Array.isArray(msg.content) ? msg.content : []) {
      if (b.type !== 'tool_use' || toolSeen.has(b.id)) continue;
      toolSeen.add(b.id);
      toolCalls[b.name] = (toolCalls[b.name] || 0) + 1;
      if (b.name === 'TodoWrite' && Array.isArray(b.input?.todos)) { for (const k of Object.keys(todos)) delete todos[k]; for (const t of b.input.todos) todos[t.status || 'unknown'] = (todos[t.status || 'unknown'] || 0) + 1; }
    }
  }
  if (format === 'ledger') return { ...out, groupBy, groups: Object.fromEntries(Object.entries(groups).sort((a, b) => (b[1].inputTokens + b[1].outputTokens + b[1].cacheReadTokens + b[1].cacheWriteTokens) - (a[1].inputTokens + a[1].outputTokens + a[1].cacheReadTokens + a[1].cacheWriteTokens))) };
  const sum = (k) => Object.values(models).reduce((a, m) => a + m[k], 0);
  return {
    ...out, sessionId, firstAt: first ? new Date(first).toISOString() : null, lastAt: last ? new Date(last).toISOString() : null,
    models, totals: { messages: sum('messages'), input: sum('input'), output: sum('output'), cacheRead: sum('cacheRead'), cacheWrite: sum('cacheWrite') },
    contextTokens: context, toolCalls, todos,
  };
}

try {
  if (args.dryRun) done({ ok: true, dryRun: true, sample: true, ...(await parse(SAMPLE, 'transcript')) });
  if (!args.path) done({ ok: false, error: 'path is required: a transcript .jsonl or a usage ledger .jsonl' });
  const file = path.resolve(String(args.path).replace(/^~(?=$|[\\/])/, os.homedir()));
  if (!fs.existsSync(file) || !fs.statSync(file).isFile()) done({ ok: false, error: `${file} is not a file` });
  let format = String(args.format || 'auto');
  if (format === 'auto') format = /^\d{4}-\d{2}\.jsonl$/.test(path.basename(file)) ? 'ledger' : 'transcript';
  if (!['ledger', 'transcript'].includes(format)) done({ ok: false, error: 'format must be auto, transcript or ledger' });
  done({ ok: true, file, ...(await parse(lines(file), format)) });
} catch (e) {
  done({ ok: false, error: e.message });
}
