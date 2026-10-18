#!/usr/bin/env node
// Fixture request traces in the span shape src/trace.js documents, for the trace explorer (ui/src/trace-panel.js):
// unit tests import fixtureSpans(); a scratch server gets them with
//   node test/fixtures/trace-fixtures.js <RIGS_HOME>     → writes <RIGS_HOME>/traces/<YYYY-MM-DD>.jsonl
// Times are relative to now so the server's retention (config.traces.days) never prunes them.
//   A  "what is the weather like?"        answer: intake → router → brain turn → 3 tool calls (one failed)
//   B  "add dark mode to the dashboard"   implement on 3 machines: router → brain → project_create handoff → plan
//                                         → dispatch → task runs (seat lanes) with assistant turns and tool calls
//   C  "summarise yesterday's logs"       error: the brain turn failed
//   D  "check the build on macbookpro"    still running (end null)
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

let seq = 0;
const hex12 = (n) => n.toString(16).padStart(12, '0');
const day = (ms) => new Date(ms).toISOString().slice(0, 10).replace(/-/g, '');

function traceBuilder(t0, node, request) {
  const traceId = `tr-${day(t0)}-${hex12(0xabc000 + ++seq)}`;
  const spans = [];
  const add = (parent, kind, name, at, ms, x = {}) => {
    const s = {
      traceId, spanId: `sp-${hex12(++seq)}`, parentId: parent?.spanId || '', kind, name, node: x.node || parent?.node || node,
      start: t0 + at, end: ms == null ? null : t0 + at + ms, status: x.status || (ms == null ? 'running' : 'ok'),
      input: x.input ?? null, output: x.output ?? null, meta: x.meta || {},
    };
    spans.push(s);
    return s;
  };
  const root = add(null, 'intake', 'jarvis/send', 0, null, { input: request });
  return { traceId, spans, root, add };
}

export function fixtureSpans(now = Date.now()) {
  seq = 0;
  const out = [];

  // A — a plain answer with tool calls
  {
    const t = traceBuilder(now - 3 * 3600e3, 'magix-system', 'what is the weather like?');
    t.add(t.root, 'router', 'route', 12, 640, { input: { text: 'what is the weather like?', prompt: 'You are the router of JARVIS. Decide: answer | implement | plan | continue…' }, output: { route: 'answer', reason: 'a question JARVIS can answer itself' }, meta: { route: 'answer', via: 'model', model: 'claude-haiku-5-5' } });
    const b = t.add(t.root, 'brain-turn', 'claude claude-sonnet-5-5', 680, 7400, { input: 'Sir asks: what is the weather like?', output: 'It is 14 °C and overcast in Budapest, sir, with light rain expected after six.', meta: { provider: 'claude', model: 'claude-sonnet-5-5', effort: 'low', inputTokens: 5210, outputTokens: 184, cacheReadTokens: 21000, cacheWriteTokens: 0, costUsd: 0.0214 } });
    t.add(b, 'tool-call', 'WebSearch', 1500, 2100, { input: { query: 'weather Budapest now' }, output: { results: ['14 °C, overcast', 'rain from 18:00'] }, meta: { durationMs: 2100 } });
    t.add(b, 'tool-call', 'mesh_status', 3700, 180, { input: {}, output: { machines: ['magix-system', 'macbookpro', 'win-desk'] }, meta: { durationMs: 180 } });
    t.add(b, 'tool-call', 'WebFetch', 4000, 2900, { status: 'error', input: { url: 'https://example.invalid/forecast' }, output: 'fetch failed: ENOTFOUND', meta: { durationMs: 2900 } });
    Object.assign(t.root, { end: t.root.start + 8120, status: 'ok', output: 'It is 14 °C and overcast in Budapest, sir…' });
    out.push(...t.spans);
  }

  // B — an implement request across three machines
  {
    const long = 'diff --git a/ui/src/styles.css b/ui/src/styles.css\n' + '+  --panel: #0b0f14;\n'.repeat(420);
    const big = long.slice(0, 8000) + `…[truncated ${long.length - 8000} chars]`; // what the store keeps of an oversized field
    const seat1 = { seat: 'team-code-sonnet@hub-dash' };
    const seat2 = { seat: 'team-code-codex@hub-dash' };
    const t = traceBuilder(now - 2 * 3600e3, 'magix-system', 'add dark mode to the dashboard');
    t.add(t.root, 'router', 'route', 10, 820, { input: { text: 'add dark mode to the dashboard' }, output: { route: 'implement' }, meta: { route: 'implement', via: 'model', model: 'claude-haiku-5-5', projectId: 'a1b2c3d4e5' } });
    const b = t.add(t.root, 'brain-turn', 'claude claude-opus-5-5', 840, 5200, { input: 'Sir wants dark mode on the dashboard. File it as a project.', output: 'Filed as a project, sir: three tasks across the mesh.', meta: { provider: 'claude', model: 'claude-opus-5-5', effort: 'medium', inputTokens: 8400, outputTokens: 610, cacheReadTokens: 30200, costUsd: 0.1182 } });
    const h = t.add(b, 'handoff', 'project_create', 3000, 1900, { input: { goal: 'Dark mode for the dashboard', trace: t.traceId }, output: { projectId: 'a1b2c3d4e5', tasks: ['t1', 't2', 't3'] }, meta: { projectId: 'a1b2c3d4e5', taskIds: ['t1', 't2', 't3'], owner: 'magix-system' } });
    const p = t.add(h, 'plan', 'plan', 3100, 41000, { input: { goal: 'Dark mode for the dashboard', prompt: 'Plan this goal into tasks…' }, output: { tasks: [{ id: 't1', title: 'Theme tokens' }, { id: 't2', title: 'Dashboard styles' }, { id: 't3', title: 'Review' }] }, meta: { provider: 'claude', model: 'claude-opus-5-5', effort: 'medium', inputTokens: 12000, outputTokens: 2400, costUsd: 0.31, routing: [{ task: 't1', node: 'macbookpro', model: 'claude-sonnet-5-5', why: 'mac has the repo' }, { task: 't2', node: 'win-desk', model: 'gpt-5.5', why: 'idle machine' }] } });
    const d = t.add(p, 'dispatch', 'dispatch t1, t2', 44200, 900, { output: { t1: 'macbookpro · claude-sonnet-5-5', t2: 'win-desk · codex gpt-5.5' }, meta: { taskIds: ['t1', 't2'], target: 'macbookpro, win-desk', attempt: 1 } });
    const t1 = t.add(d, 'task', 't1 Theme tokens', 45300, 410000, { node: 'macbookpro', input: 'Brief: add theme tokens…', output: 'Done: tokens in ui/src/styles.css, commit 1a2b3c.', meta: { ...seat1, model: 'claude-sonnet-5-5', inputTokens: 88000, outputTokens: 9100, cacheReadTokens: 410000, costUsd: 0.94, retries: 0 } });
    const a1 = t.add(t1, 'assistant', 'turn 1', 46000, 21000, { output: 'Reading the stylesheet first.', meta: { ...seat1, inputTokens: 12000, outputTokens: 340 } });
    t.add(a1, 'tool-call', 'Read', 52000, 400, { input: { file_path: 'ui/src/styles.css' }, output: ':root { --panel: …', meta: { ...seat1, durationMs: 400 } });
    t.add(a1, 'tool-call', 'Grep', 53000, 700, { input: { pattern: '--panel' }, output: '12 matches', meta: { ...seat1, durationMs: 700 } });
    const a2 = t.add(t1, 'assistant', 'turn 2', 70000, 300000, { output: 'Editing and running the tests.', meta: { ...seat1, inputTokens: 40000, outputTokens: 5200 } });
    t.add(a2, 'tool-call', 'Edit', 80000, 1200, { input: { file_path: 'ui/src/styles.css', old_string: '--panel', new_string: '--panel-dark' }, output: big, meta: { ...seat1, durationMs: 1200, truncated: ['output'] } });
    t.add(a2, 'tool-call', 'Bash', 90000, 182000, { input: { command: 'npm test' }, output: '# tests 461\n# pass 461\n# fail 0', meta: { ...seat1, durationMs: 182000 } });
    t.add(a2, 'tool-call', 'Bash', 290000, 62000, { input: { command: 'npm run build' }, output: 'built ui/dist', meta: { ...seat1, durationMs: 62000 } });
    t.add(t1, 'event', 'reported', 455000, 300, { output: { status: 'done' }, meta: seat1 });
    const t2 = t.add(d, 'task', 't2 Dashboard styles', 45600, 520000, { node: 'win-desk', input: 'Brief: dashboard dark styles…', output: 'Done after one retry.', meta: { ...seat2, model: 'gpt-5.5', inputTokens: 64000, outputTokens: 7000, costUsd: 0.52, retries: 1 } });
    t.add(t2, 'tool-call', 'command_execution', 60000, 90000, { status: 'error', input: 'npm test', output: '1 failing: themes.test.js', meta: { ...seat2, exitCode: 1, durationMs: 90000 } });
    t.add(t2, 'event', 'retry', 152000, 200, { output: 'retry with gpt-5.5 high (model ladder: medium → high)', meta: { ...seat2, attempt: 2 } });
    t.add(t2, 'tool-call', 'file_change', 200000, 1500, { input: { path: 'ui/src/dashboard.css' }, output: 'updated', meta: { ...seat2, durationMs: 1500 } });
    t.add(t2, 'event', 'question', 260000, 4000, { input: 'may I run the full build?', output: 'Yes — non-destructive work is pre-approved (safe default).', meta: { ...seat2, autoAnswered: true } });
    t.add(t2, 'tool-call', 'command_execution', 270000, 230000, { input: 'npm test', output: '# pass 461', meta: { ...seat2, exitCode: 0, durationMs: 230000 } });
    const rv = t.add(p, 'task', 't3 Review', 570000, 180000, { node: 'magix-system', input: 'Brief: review the branch…', output: 'Approved; one nit fixed.', meta: { seat: 'team-review-opus@hub-dash', model: 'claude-opus-5-5', inputTokens: 30000, outputTokens: 2000, costUsd: 0.41 } });
    t.add(rv, 'tool-call', 'Bash', 600000, 150000, { input: { command: 'npm test && npm run build' }, output: '# pass 461', meta: { seat: 'team-review-opus@hub-dash', durationMs: 150000 } });
    Object.assign(t.root, { end: t.root.start + 6100, status: 'ok' });
    out.push(...t.spans);
  }

  // C — a failed brain turn
  {
    const t = traceBuilder(now - 50 * 60e3, 'magix-system', "summarise yesterday's logs");
    t.add(t.root, 'router', 'route', 8, 510, { output: { route: 'answer' }, meta: { route: 'answer', via: 'rules' } });
    const b = t.add(t.root, 'brain-turn', 'ollama qwen3:32b', 530, 30000, { node: 'win-desk', status: 'error', input: "summarise yesterday's logs", output: 'ollama: context length exceeded (131072)', meta: { provider: 'ollama', model: 'qwen3:32b', inputTokens: 131072, outputTokens: 0 } });
    t.add(b, 'tool-call', 'read_logs', 900, 12000, { input: { since: '24h' }, output: { lines: 48211 }, meta: { durationMs: 12000 } });
    Object.assign(t.root, { end: t.root.start + 30600, status: 'error' });
    out.push(...t.spans);
  }

  // D — still running
  {
    const t = traceBuilder(now - 40e3, 'magix-system', 'check the build on macbookpro');
    t.add(t.root, 'router', 'route', 9, 450, { output: { route: 'answer' }, meta: { route: 'answer', via: 'model', model: 'claude-haiku-5-5' } });
    const b = t.add(t.root, 'brain-turn', 'claude claude-sonnet-5-5', 470, null, { input: 'check the build on macbookpro', meta: { provider: 'claude', model: 'claude-sonnet-5-5', effort: 'low' } });
    t.add(b, 'tool-call', 'mesh_exec', 2000, 9000, { input: { node: 'macbookpro', command: 'npm run build' }, output: 'built ui/dist in 4.1s', meta: { durationMs: 9000 } });
    t.add(b, 'tool-call', 'mesh_exec', 12000, null, { input: { node: 'macbookpro', command: 'npm test' } });
    out.push(...t.spans);
  }
  return out;
}

/** Write the fixtures into <home>/traces/<YYYY-MM-DD>.jsonl (the UTC day each span started). Returns the files written. */
export function writeFixtures(home, now = Date.now()) {
  const dir = path.join(home, 'traces');
  fs.mkdirSync(dir, { recursive: true });
  const files = new Map();
  for (const s of fixtureSpans(now)) {
    const f = path.join(dir, new Date(s.start).toISOString().slice(0, 10) + '.jsonl');
    files.set(f, (files.get(f) || '') + JSON.stringify(s) + '\n');
  }
  for (const [f, text] of files) fs.appendFileSync(f, text);
  return [...files.keys()];
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const home = process.argv[2];
  if (!home) { console.error('usage: node test/fixtures/trace-fixtures.js <RIGS_HOME>'); process.exit(2); }
  console.log(writeFixtures(home).join('\n'));
}
