#!/usr/bin/env node
// Benchmark candidate brains for JARVIS's local live responder (docs/local-responder.md).
//
// Runs five typical JARVIS asks (mesh status, running sessions, a short fact, a "please build" request that must
// escalate, a greeting) through up to three integration styles and scores each reply:
//   direct         a plain Ollama /api/chat tool loop with a small read-only tool set (the real `rigs mcp` tool code)
//   claude-ollama  `claude -p` against Ollama's Anthropic endpoint with the rigs MCP (today's "Claude via Ollama")
//   claude         `claude -p` on Anthropic (the Haiku quick-lane baseline)
// Measures time to first token / first sentence / first answer token, decode tokens per second, prompt tokens,
// VRAM (Ollama /api/ps size_vram) and tool-call correctness.
//
// Arguments: one JSON object on stdin, in RIGS_TOOL_ARGS or as argv[2]. Everything has a default:
//   { models: ["qwen3:8b"], styles: ["direct"], runs: 2, url: "http://127.0.0.1:11434", numCtx: 16384,
//     claudeModel: "claude-haiku-5-5", questions: ["mesh", ...], prompt: "v2" | "v1", appDir, rigsMcp: [cmd, ...args],
//     out, unload: true, dryRun: false }
// Prints one JSON object { ok, summary[], table, results[] } on stdout; progress goes to stderr.
// Safety: only read-only rigs tools are offered (direct) or allowed (claude styles: every other rigs tool, Bash,
// Write, Edit, Task and the web tools are disallowed and only the rigs MCP server is loaded), so a reply can never file
// work, send a message or touch a machine. It loads models into Ollama (and unloads its own with keep_alive 0).
import { execFileSync, spawn } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));

async function readArgs() {
  if (process.argv[2]) return JSON.parse(process.argv[2]);
  if (process.env.RIGS_TOOL_ARGS) return JSON.parse(process.env.RIGS_TOOL_ARGS);
  if (process.stdin.isTTY) return {};
  let s = '';
  for await (const c of process.stdin) s += c;
  return s.trim() ? JSON.parse(s) : {};
}

/** The RIGS checkout whose src/ we import: appDir arg, RIGS_APP_DIR, this repo, then ~/.rigs/app. */
function findAppDir(a) {
  const c = [a.appDir, process.env.RIGS_APP_DIR, path.resolve(HERE, '../..'), path.join(os.homedir(), '.rigs', 'app')];
  return c.find((d) => d && fs.existsSync(path.join(d, 'src', 'mcp.js')));
}

// The read-only rigs MCP tools the responder may call (the design's allowed subset).
export const READ_ONLY_TOOLS = ['mesh_status', 'mesh_sessions', 'mesh_apps', 'project_list', 'mesh_processes', 'usage_report', 'trace_list'];
// Claude Code built-ins that must never run in a benchmark turn.
const DENY_BUILTINS = ['Bash', 'Write', 'Edit', 'MultiEdit', 'NotebookEdit', 'Task', 'Agent', 'WebSearch', 'WebFetch', 'KillShell', 'BashOutput'];

export const QUESTIONS = {
  mesh: { text: 'How is the mesh doing?', expect: { tools: ['mesh_status'], escalate: false } },
  sessions: { text: 'Which sessions are running right now?', expect: { tools: ['mesh_sessions'], escalate: false } },
  fact: { text: 'What is the capital of Australia?', expect: { tools: [], noTools: true, escalate: false, contains: /canberra/i } },
  build: { text: 'Please build me a small web app that tracks my fuel expenses.', expect: { escalate: true, noTools: true } },
  greeting: { text: 'Good evening, JARVIS.', expect: { tools: [], noTools: true, escalate: false, maxChars: 400 } },
};
// More of the same kinds, paraphrased (questions: "all" runs these too).
export const EXTENDED = {
  online: { text: 'Is the MacBook online?', expect: { tools: ['mesh_status'], escalate: false } },
  apps: { text: 'Which of my apps are down right now?', expect: { tools: ['mesh_apps'], escalate: false } },
  projects: { text: 'What are my projects up to?', expect: { tools: ['project_list'], escalate: false } },
  spend: { text: 'How many tokens did we use today?', expect: { tools: ['usage_report'], escalate: false } },
  joke: { text: 'Tell me a short joke.', expect: { tools: [], noTools: true, escalate: false } },
  thanks: { text: "Thanks, that's all for now.", expect: { tools: [], noTools: true, escalate: false, maxChars: 300 } },
  fix: { text: 'Fix the failing test in the router.', expect: { escalate: true, noTools: true } },
  web: { text: 'Search the web for the latest Node.js release.', expect: { escalate: true, noTools: true } },
};
const ALL_QUESTIONS = { ...QUESTIONS, ...EXTENDED };

const MARKER = '[[ESCALATE]]';

/** Score one reply against its question's expectation → { correct, why }. Pure. */
export function score(q, { text = '', tools = [], error = '' }) {
  const e = q.expect;
  const escalated = String(text).toUpperCase().includes(MARKER);
  const names = (tools || []).map((t) => t.replace(/^mcp__rigs__/, ''));
  if (error && !text) return { correct: false, why: `error: ${String(error).slice(0, 120)}` };
  if (e.escalate && !escalated) return { correct: false, why: 'did not escalate' };
  if (!e.escalate && escalated) return { correct: false, why: 'escalated needlessly' };
  for (const t of e.tools || []) if (!names.includes(t)) return { correct: false, why: `did not call ${t}` };
  if (e.noTools && names.length) return { correct: !!e.escalate, why: `called ${names.join(', ')}${e.escalate ? ' before escalating' : ' needlessly'}` };
  if (e.contains && !e.contains.test(text)) return { correct: false, why: `answer lacks ${e.contains}` };
  if (e.maxChars && text.length > e.maxChars) return { correct: false, why: `too long (${text.length} chars)` };
  if (!e.escalate && !String(text).trim()) return { correct: false, why: 'empty reply' };
  return { correct: true, why: 'ok' };
}

/**
 * A reply that only announces a lookup ("Of course, sir. Let me check the mesh status.") without calling a tool —
 * the one failure small models repeat. The runner keeps it as the spoken opener and asks for the tool call. Pure.
 */
export function narratedToolCall(text) {
  const spoken = String(text || '').split(/\n\s*---/)[0].trim();
  return spoken.length > 0 && spoken.length < 200
    && /\b(?:let me|i'll|i will|allow me to|i'm going to)\s+(?:quickly\s+)?(?:check|look|see|pull|fetch|query|scan|find|get|review|take a look)\b|\b(?:checking|scanning|pulling up|looking up|querying)\b/i.test(spoken);
}
export const NUDGE = 'You announced a lookup but did not call a tool. Call the matching tool now, without announcing it again.';

/** Index just past the first complete sentence, or -1. Pure. */
export function firstSentenceEnd(text) {
  const m = String(text).match(/^[\s\S]*?[.!?…](?=\s|$)/);
  return m && m[0].trim().length >= 2 ? m[0].length : -1;
}

/**
 * SOUL.md without its "Work" section and without the example exchanges that file work or report a status: the
 * responder can't file work and knows the mesh only through tools, so it must not learn to say "it's filed" or
 * "all quiet" from examples. Pure.
 */
export function responderSoul(text) {
  return String(text || '')
    .replace(/\n## Work:[\s\S]*?(?=\n---\n|\n## |\n# )/, '\n')
    .split(/\n{2,}/).filter((para) => !/^Tony:/m.test(para) || !/\bfiled\b|dispatched|already at it|all quiet|nothing's stirred|build pass|alerts/i.test(para)).join('\n\n');
}

// Which tool answers which kind of question (prompt v2).
const TOOL_USE = {
  mesh_status: 'machines, the mesh, what is online, CPU/memory load, installed agents',
  mesh_sessions: 'which sessions or agents are running',
  mesh_apps: 'App Cloud apps and whether they are up',
  project_list: 'projects, their tasks and progress',
  mesh_processes: "processes on one machine (needs the machine's name)",
  usage_report: 'tokens, time or money spent',
  trace_list: "Sir's recent requests and what happened to them",
};

/**
 * The live responder's system prompt: JARVIS's character, the reply contract, and the responder's own rules.
 * v1 = the first benchmark round (full SOUL.md, soft tool rule); v2 = the design (SOUL.md without its Work section,
 * an explicit tool map, "know nothing about the mesh without a tool", the escalation rule last). The stable part comes
 * first so Ollama's prompt cache keeps it; the clock is the last line.
 */
export async function responderPrompt(appDir, { model = '', tools = READ_ONLY_TOOLS, version = 'v2' } = {}) {
  const { soul } = await import(pathToFileURL(path.join(appDir, 'src', 'chat.js')).href);
  const { config } = await import(pathToFileURL(path.join(appDir, 'src', 'config.js')).href);
  const p = config().persona || {};
  const humor = p.humor ?? 60;
  const now = new Date();
  if (version === 'v2') {
    return [
      responderSoul(soul()),
      '---',
      `# Your role now: JARVIS's live first responder`,
      `You are ${p.name || 'J.A.R.V.I.S.'}, the voice of RIGS OS (the user's control plane for every workstation on their Tailscale network), answering first and fast on a local model (${model || 'local'}). Address the user as "${p.address || 'sir'}". Humor ${humor}%: ${humor > 70 ? 'dry, cheeky wit welcome' : humor > 30 ? 'a light touch of dry wit' : 'strictly professional'}.`,
      'Reply format: your reply is spoken aloud. Open with 1–2 short natural sentences, plain speech (no markdown, lists, code, paths or URLs), the answer first. Details for the screen may follow after a line containing only "---"; they are never read out. Simple answers skip the "---" part.',
      'You handle greetings, chat, short factual questions and quick read-only lookups yourself, briefly and in character.',
      '## Facts about the mesh come only from tools',
      'You know nothing about the machines, sessions, apps, projects, usage or recent requests except what a tool returns in this turn. Never describe any of them without calling the matching tool first; the example lines in your character notes are tone, not facts. Tools:',
      ...tools.map((t) => `- ${t}: ${TOOL_USE[t] || 'read-only lookup'}`),
      'Call the tool, then answer from its result. If a tool fails, say so plainly.',
      '## What you cannot do',
      `You cannot file work, start agents or projects, run commands, write files, send messages, search the web or change any setting, and you must never say or imply that you did or will. For any request to build, make, write, fix, change, install, run, start, stop, send or research something, reply with only ${MARKER} followed by one short reason, and nothing else: the full JARVIS brain takes it over from there.`,
      `Local time: ${now.toLocaleString('en-GB', { weekday: 'long', hour: '2-digit', minute: '2-digit', day: 'numeric', month: 'long' })}. You run on "${config().name}".`,
    ].join('\n');
  }
  return [
    soul(),
    '---',
    `You are ${p.name || 'J.A.R.V.I.S.'}, the voice of RIGS OS — the user's personal control plane for every workstation on their Tailscale network.`,
    `Local time: ${now.toLocaleString('en-GB', { weekday: 'long', hour: '2-digit', minute: '2-digit', day: 'numeric', month: 'long' })}. You run on "${config().name}".`,
    `Address the user as "${p.address || 'sir'}". Humor ${humor}%: ${humor > 70 ? 'dry, cheeky wit welcome' : humor > 30 ? 'a light touch of dry wit' : 'strictly professional'}.`,
    'Reply format: your reply is spoken aloud, so open with 1–2 short natural sentences, plain speech (no markdown, lists, code, paths or URLs), the answer first. Details that help on screen may follow after a line containing only "---"; they are shown, never read out. Simple answers skip the "---" part.',
    '# Live responder',
    `You are JARVIS's live first responder (${model || 'a local model'}). Answer greetings, chat, short factual questions and quick read-only lookups yourself, briefly and in character.`,
    `Your only tools are read-only: ${tools.join(', ')}. Call one only when the answer needs live mesh data, then answer from its result.`,
    `Anything else — writing or changing code, building something, starting agents or projects, sending messages, changing settings, web research, long multi-step work — you do not start and do not promise: reply with only ${MARKER} followed by one short reason, and nothing else. The full JARVIS brain then takes the request over.`,
  ].join('\n');
}

// ---------- Ollama helpers ----------
async function ollamaJson(url, p, body, timeout = 600000) {
  const r = await fetch(url + p, { method: body ? 'POST' : 'GET', headers: { 'content-type': 'application/json' }, body: body ? JSON.stringify(body) : undefined, signal: AbortSignal.timeout(timeout) });
  if (!r.ok) throw new Error(`Ollama ${p} HTTP ${r.status}: ${(await r.text()).slice(0, 200)}`);
  return r.json();
}
async function modelInfo(url, model) {
  const s = await ollamaJson(url, '/api/show', { model });
  return { capabilities: s.capabilities || [], params: s.details?.parameter_size || '', quant: s.details?.quantization_level || '', family: s.details?.family || '' };
}
function thinkFor(model, caps) {
  if (!caps.includes('thinking')) return undefined;
  return /gpt-oss/.test(model) ? 'low' : false; // gpt-oss can't switch thinking off, only down
}
/** GPU memory in use (MB) from nvidia-smi, or null where there is none (macOS, no NVIDIA GPU). */
function gpuUsedMb() {
  try { return Number(execFileSync('nvidia-smi', ['--query-gpu=memory.used', '--format=csv,noheader,nounits'], { encoding: 'utf8', timeout: 5000 }).split('\n')[0]) || null; } catch { return null; }
}
async function vramOf(url, model, before = null) {
  const ps = await ollamaJson(url, '/api/ps').catch(() => ({ models: [] }));
  const m = (ps.models || []).find((x) => x.name === model || x.model === model);
  const used = gpuUsedMb();
  // Ollama's size_vram can under-report (seen with gemma4); the nvidia-smi delta over the load is the cross-check.
  return m ? { vramMb: Math.round(m.size_vram / 1048576), totalMb: Math.round(m.size / 1048576), ctx: m.context_length || null, smiDeltaMb: before != null && used != null ? used - before : null } : null;
}
async function unload(url, model) { await ollamaJson(url, '/api/generate', { model, keep_alive: 0 }).catch(() => {}); }

/** One streamed /api/chat round → { content, thinking, toolCalls, t: {first, firstContent, firstSentence, end}, stats }. */
async function chatRound(url, body, t0) {
  const r = await fetch(url + '/api/chat', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ ...body, stream: true }), signal: AbortSignal.timeout(300000) });
  if (!r.ok) throw new Error(`Ollama /api/chat HTTP ${r.status}: ${(await r.text()).slice(0, 300)}`);
  const out = { content: '', thinking: '', toolCalls: [], t: {}, stats: null };
  const dec = new TextDecoder();
  let buf = '';
  for await (const chunk of r.body) {
    buf += dec.decode(chunk, { stream: true });
    let i;
    while ((i = buf.indexOf('\n')) >= 0) {
      const line = buf.slice(0, i).trim();
      buf = buf.slice(i + 1);
      if (!line) continue;
      const e = JSON.parse(line);
      if (e.error) throw new Error(e.error);
      const now = Date.now() - t0;
      const m = e.message || {};
      if ((m.content || m.thinking || m.tool_calls?.length) && out.t.first == null) out.t.first = now;
      if (m.thinking) out.thinking += m.thinking;
      if (m.content) {
        if (out.t.firstContent == null && m.content.trim()) out.t.firstContent = now;
        out.content += m.content;
        if (out.t.firstSentence == null && firstSentenceEnd(out.content) > 0) out.t.firstSentence = now;
      }
      if (m.tool_calls?.length) out.toolCalls.push(...m.tool_calls);
      if (e.done) { out.stats = e; out.t.end = now; }
    }
  }
  return out;
}

/** Style "direct": the responder's own tool loop over /api/chat. */
async function runDirect({ url, model, numCtx, think, system, toolDefs, toolRun, text, maxRounds = 4, guard = true }) {
  const t0 = Date.now();
  const messages = [{ role: 'system', content: system }, { role: 'user', content: text }];
  const tools = [];
  const rounds = [];
  let toolMs = 0;
  let final = null;
  let nudged = false;
  let opener = '';
  for (let round = 0; round < maxRounds; round++) {
    const res = await chatRound(url, { model, messages, tools: toolDefs, ...(think !== undefined ? { think } : {}), keep_alive: '15m', options: { num_ctx: numCtx } }, t0);
    rounds.push(res);
    if (!res.toolCalls.length && guard && !nudged && !tools.length && narratedToolCall(res.content)) {
      // keep the announcement as the spoken opener and ask once for the tool call it announced
      nudged = true;
      opener = res.content.split(/\n\s*---/)[0].trim();
      messages.push({ role: 'assistant', content: opener }, { role: 'system', content: NUDGE });
      continue;
    }
    if (!res.toolCalls.length) { final = res; break; }
    messages.push({ role: 'assistant', content: res.content || '', tool_calls: res.toolCalls });
    for (const c of res.toolCalls) {
      const name = c.function?.name || '';
      tools.push(name);
      const ts = Date.now();
      let result;
      try { result = await toolRun(name, c.function?.arguments || {}); } catch (e) { result = { error: e.message }; }
      toolMs += Date.now() - ts;
      messages.push({ role: 'tool', tool_name: name, content: JSON.stringify(result).slice(0, 6000) });
    }
  }
  const last = final || rounds.at(-1);
  const st = last?.stats || {};
  const first = rounds[0];
  return {
    text: (opener ? opener + ' ' : '') + (last?.content || ''), tools, rounds: rounds.length, toolMs, nudged,
    firstTokenMs: first?.t.first ?? null, // first output of any kind (a tool call or text)
    firstAnswerMs: last?.t.firstContent ?? null, // first token of the spoken answer (after tool rounds)
    firstSentenceMs: last?.t.firstSentence ?? null,
    totalMs: Date.now() - t0,
    promptTokens: first?.stats?.prompt_eval_count ?? null,
    promptMs: first?.stats?.prompt_eval_duration ? Math.round(first.stats.prompt_eval_duration / 1e6) : null,
    outputTokens: rounds.reduce((n, r) => n + (r.stats?.eval_count || 0), 0),
    tokPerSec: st.eval_count && st.eval_duration ? +(st.eval_count / (st.eval_duration / 1e9)).toFixed(1) : null,
    thinkingChars: rounds.reduce((n, r) => n + r.thinking.length, 0),
  };
}

function cleanEnv(extra = {}) {
  const env = { ...process.env };
  for (const k of Object.keys(env)) if (k.startsWith('CLAUDECODE') || k === 'CLAUDE_CODE_ENTRYPOINT' || k === 'RIGS_TRACE') delete env[k];
  return { ...env, ...extra };
}

/** Styles "claude" / "claude-ollama": one `claude -p` turn the way chat.quickTurn runs it, with only safe tools. */
async function runClaudeTurn({ appDir, model, viaOllama, url, system, text, mcpConfig, disallowed, allowed, maxTurns = 8, timeoutMs = 180000 }) {
  const { claudeOllamaEnv } = await import(pathToFileURL(path.join(appDir, 'src', 'models.js')).href);
  const args = ['-p', text, '--output-format', 'stream-json', '--verbose', '--include-partial-messages', '--append-system-prompt', system,
    '--permission-mode', 'default', '--strict-mcp-config', '--mcp-config', JSON.stringify(mcpConfig),
    '--allowedTools', allowed.join(','), '--disallowedTools', disallowed.join(','), '--model', model, '--max-turns', String(maxTurns)];
  if (!viaOllama) args.push('--effort', 'low');
  const env = cleanEnv(viaOllama ? claudeOllamaEnv({ url, model }) : {});
  const t0 = Date.now();
  const out = { text: '', tools: [], firstTokenMs: null, firstAnswerMs: null, firstSentenceMs: null, totalMs: 0, promptTokens: null, outputTokens: null, error: '', apiMs: null, turns: null };
  let answerStart = 0; // text after the last tool call is the answer
  await new Promise((resolve) => {
    const child = spawn('claude', args, { cwd: os.homedir(), env, stdio: ['ignore', 'pipe', 'pipe'] });
    const timer = setTimeout(() => { out.error = `timed out after ${timeoutMs} ms`; child.kill(); }, timeoutMs);
    let buf = '';
    let err = '';
    child.stdout.on('data', (d) => {
      buf += d;
      let i;
      while ((i = buf.indexOf('\n')) >= 0) {
        const line = buf.slice(0, i).trim();
        buf = buf.slice(i + 1);
        let e;
        try { e = JSON.parse(line); } catch { continue; }
        const now = Date.now() - t0;
        if (e.type === 'stream_event' && e.event?.type === 'content_block_start' && e.event.content_block?.type === 'tool_use') {
          if (out.firstTokenMs == null) out.firstTokenMs = now;
          out.tools.push(e.event.content_block.name);
          answerStart = out.text.length; out.firstAnswerMs = null; out.firstSentenceMs = null;
        }
        if (e.type === 'stream_event' && e.event?.type === 'content_block_delta' && e.event.delta?.type === 'text_delta') {
          if (out.firstTokenMs == null) out.firstTokenMs = now;
          out.text += e.event.delta.text;
          if (out.firstAnswerMs == null && out.text.slice(answerStart).trim()) out.firstAnswerMs = now;
          if (out.firstSentenceMs == null && firstSentenceEnd(out.text.slice(answerStart)) > 0) out.firstSentenceMs = now;
        }
        if (e.type === 'result') {
          out.apiMs = e.duration_api_ms ?? null; out.turns = e.num_turns ?? null;
          const u = e.usage || {};
          out.promptTokens = (u.input_tokens || 0) + (u.cache_read_input_tokens || 0) + (u.cache_creation_input_tokens || 0);
          out.outputTokens = u.output_tokens ?? null;
          if (e.is_error) out.error = e.result || (e.errors || []).join('; ') || 'error';
          if (!out.text && e.result) out.text = e.result;
        }
      }
    });
    child.stderr.on('data', (d) => { err += d; });
    child.on('close', (code) => { clearTimeout(timer); if (code && !out.error && !out.text) out.error = err.trim().slice(-300) || `exit ${code}`; out.totalMs = Date.now() - t0; resolve(); });
  });
  out.text = out.text.slice(answerStart) || out.text;
  out.tokPerSec = null; // the harness doesn't report decode time
  return out;
}

const median = (xs) => { const v = xs.filter((x) => Number.isFinite(x)).sort((a, b) => a - b); if (!v.length) return null; const m = v.length >> 1; return v.length % 2 ? v[m] : Math.round((v[m - 1] + v[m]) / 2); };

async function main() {
  const a = await readArgs();
  const appDir = findAppDir(a);
  const url = String(a.url || process.env.OLLAMA_URL || 'http://127.0.0.1:11434').replace(/\/+$/, '');
  const models = a.models || ['qwen3:8b'];
  const styles = a.styles || ['direct'];
  const runs = Math.max(1, a.runs || 2);
  const numCtx = a.numCtx || 16384;
  const qids = a.questions === 'all' ? Object.keys(ALL_QUESTIONS) : a.questions || Object.keys(QUESTIONS);
  const claudeModel = a.claudeModel || 'claude-haiku-5-5';
  const rigsMcp = a.rigsMcp || [process.execPath, path.join(appDir || '', 'bin', 'rigs.js'), 'mcp'];
  const plan = { appDir, url, models, styles, runs, numCtx, questions: qids, claudeModel, rigsMcp, prompt: a.prompt || 'v2', guard: a.guard !== false };
  if (a.dryRun || !appDir) {
    process.stdout.write(JSON.stringify({ ok: !!appDir, dryRun: true, plan, ...(appDir ? {} : { error: 'no RIGS checkout found (appDir)' }) }) + '\n');
    return;
  }
  process.env.RIGS_NO_MIGRATIONS = '1';
  const { TOOLS } = await import(pathToFileURL(path.join(appDir, 'src', 'mcp.js')).href);
  const allowedTools = (a.tools || READ_ONLY_TOOLS).filter((n) => TOOLS.some((t) => t.name === n));
  const toolDefs = TOOLS.filter((t) => allowedTools.includes(t.name)).map((t) => ({ type: 'function', function: { name: t.name, description: t.description, parameters: t.inputSchema } }));
  const toolRun = async (name, args) => {
    const t = TOOLS.find((x) => x.name === name && allowedTools.includes(name));
    if (!t) return { error: `${name} is not available to the responder` };
    return t.run(typeof args === 'string' ? JSON.parse(args || '{}') : args || {});
  };
  const mcpConfig = { mcpServers: { rigs: { type: 'stdio', command: rigsMcp[0], args: rigsMcp.slice(1), env: {} } } };
  const allowedClaude = allowedTools.map((n) => `mcp__rigs__${n}`);
  const disallowedClaude = [...TOOLS.map((t) => t.name).filter((n) => !allowedTools.includes(n)).map((n) => `mcp__rigs__${n}`), ...DENY_BUILTINS];
  const results = [];
  const log = (...x) => process.stderr.write(x.join(' ') + '\n');

  const jobs = [];
  for (const style of styles) {
    if (style === 'claude') jobs.push({ style, model: claudeModel });
    else for (const model of models) jobs.push({ style, model });
  }
  for (let ji = 0; ji < jobs.length; ji++) {
    const { style, model } = jobs[ji];
    let info = null; let think; let coldMs = null; let vram = null;
    if (style !== 'claude') {
      try { info = await modelInfo(url, model); } catch (e) { results.push({ style, model, question: '-', error: e.message }); log('skip', model, e.message); continue; }
      if (!info.capabilities.includes('tools')) { results.push({ style, model, question: '-', error: 'no tools capability', capabilities: info.capabilities }); log('skip', model, 'no tools capability'); continue; }
      think = thinkFor(model, info.capabilities);
      const before = gpuUsedMb();
      const t = Date.now();
      // warm-up: load the model (cold start) with the same context size the direct runs use
      await ollamaJson(url, '/api/chat', { model, messages: [{ role: 'user', content: 'Hi' }], stream: false, keep_alive: '15m', ...(think !== undefined ? { think } : {}), options: { num_ctx: numCtx, num_predict: 1 } }).catch((e) => log('warm-up failed', e.message));
      coldMs = Date.now() - t;
      vram = await vramOf(url, model, before);
    }
    let system = await responderPrompt(appDir, { model, tools: allowedTools, version: a.prompt || 'v2' });
    if (style === 'claude') {
      // The baseline runs the real quick-lane prompt: persona + quickNote (Haiku files work with jarvis_task, here disallowed).
      const { personaPrompt } = await import(pathToFileURL(path.join(appDir, 'src', 'chat.js')).href);
      const { quickNote } = await import(pathToFileURL(path.join(appDir, 'src', 'quick.js')).href);
      system = personaPrompt('', '') + '\n\n' + quickNote({ model, maxTurns: 8 });
    }
    for (const qid of qids) {
      const q = ALL_QUESTIONS[qid];
      if (!q) { log('unknown question', qid); continue; }
      for (let run = 0; run < runs; run++) {
        let r;
        try {
          if (style === 'direct') r = await runDirect({ url, model, numCtx, think, system, toolDefs, toolRun, text: q.text, guard: a.guard !== false });
          else r = await runClaudeTurn({ appDir, model, viaOllama: style === 'claude-ollama', url, system, text: q.text, mcpConfig, allowed: allowedClaude, disallowed: disallowedClaude });
        } catch (e) { r = { text: '', tools: [], error: e.message }; }
        const s = score(q, r);
        const row = { style, model, question: qid, run, ...r, text: String(r.text || '').slice(0, 400), correct: s.correct, why: s.why, coldMs, vram, think, params: info?.params, quant: info?.quant };
        results.push(row);
        log(`${style} ${model} ${qid}#${run}: first ${r.firstTokenMs}ms answer ${r.firstAnswerMs}ms sentence ${r.firstSentenceMs}ms total ${r.totalMs}ms ${r.tokPerSec ?? '-'} tok/s prompt ${r.promptTokens} tools [${(r.tools || []).join(',')}] ${s.correct ? 'OK' : 'FAIL ' + s.why}${r.error ? ' err ' + String(r.error).slice(0, 100) : ''}`);
      }
    }
    // after claude-ollama runs, Ollama reports the context it actually loaded the model with
    if (style === 'claude-ollama') vram = await vramOf(url, model) || vram;
    for (const r of results) if (r.style === style && r.model === model) r.vram = vram;
    if (style !== 'claude' && a.unload !== false && !jobs.slice(ji + 1).some((j) => j.model === model)) await unload(url, model);
  }

  // Summary per style + model: latency medians over the chat questions (fact, greeting) and the tool questions
  // (mesh, sessions) separately, correctness over all.
  const groups = new Map();
  for (const r of results) { const k = `${r.style}|${r.model}`; if (!groups.has(k)) groups.set(k, []); groups.get(k).push(r); }
  const summary = [...groups.values()].map((rs) => {
    const r0 = rs[0];
    const ok = rs.filter((r) => r.text);
    const chatQs = ok.filter((r) => ['fact', 'greeting', 'joke', 'thanks'].includes(r.question));
    const toolQs = ok.filter((r) => ['mesh', 'sessions', 'online', 'apps', 'projects', 'spend'].includes(r.question));
    const escQs = ok.filter((r) => ['build', 'fix', 'web'].includes(r.question));
    const qs = [...new Set(rs.map((r) => r.question))].filter((q) => q !== '-');
    return {
      style: r0.style, model: r0.model, params: r0.params || '', quant: r0.quant || '', think: r0.think, coldMs: r0.coldMs ?? null, vramMb: r0.vram?.vramMb ?? null, smiDeltaMb: r0.vram?.smiDeltaMb ?? null, ctx: r0.vram?.ctx ?? null,
      ...(rs.every((r) => r.error && !r.text) ? { error: rs[0].error } : {}),
      chatFirstTokenMs: median(chatQs.map((r) => r.firstAnswerMs)), chatFirstSentenceMs: median(chatQs.map((r) => r.firstSentenceMs)), chatTotalMs: median(chatQs.map((r) => r.totalMs)),
      toolAnswerMs: median(toolQs.map((r) => r.firstAnswerMs)), toolFirstOutputMs: median(toolQs.map((r) => r.firstTokenMs)), toolTotalMs: median(toolQs.map((r) => r.totalMs)), toolExecMs: median(toolQs.map((r) => r.toolMs)),
      // the model's own share of a tool answer: first answer token minus the time the tools themselves took
      toolModelMs: median(toolQs.filter((r) => r.firstAnswerMs != null && r.toolMs != null).map((r) => r.firstAnswerMs - r.toolMs)),
      escalateMs: median(escQs.map((r) => r.totalMs)),
      tokPerSec: median(ok.map((r) => r.tokPerSec)), promptTokens: median(ok.map((r) => r.promptTokens)),
      nudged: rs.filter((r) => r.nudged).length,
      correct: `${rs.filter((r) => r.correct).length}/${rs.filter((r) => r.question !== '-').length}`,
      perQuestion: Object.fromEntries(qs.map((q) => [q, `${rs.filter((r) => r.question === q && r.correct).length}/${rs.filter((r) => r.question === q).length}`])),
    };
  });
  const f = (v) => (v == null ? '–' : v);
  const table = [
    '| style | model | first token (chat) | first sentence (chat) | answer after tool (model / incl. tool) | escalation decided | tok/s | prompt tok | VRAM MB (Ollama) | cold load | correct | per question |',
    '| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |',
    ...summary.map((s) => `| ${s.style} | ${s.model} | ${f(s.chatFirstTokenMs)} ms | ${f(s.chatFirstSentenceMs)} ms | ${f(s.toolModelMs)} / ${f(s.toolAnswerMs)} ms | ${f(s.escalateMs)} ms | ${f(s.tokPerSec)} | ${f(s.promptTokens)} | ${f(s.vramMb)} | ${f(s.coldMs)} ms | ${s.correct} | ${Object.entries(s.perQuestion).map(([q, v]) => `${q} ${v}`).join(', ')}${s.error ? ' · ' + s.error : ''} |`),
  ].join('\n');
  const result = { ok: true, plan, summary, table, results };
  if (a.out) fs.writeFileSync(a.out, JSON.stringify(result, null, 2));
  process.stdout.write(JSON.stringify(a.out ? { ok: true, out: a.out, summary, table } : result) + '\n');
}

if (process.argv[1] && fileURLToPath(import.meta.url) === path.resolve(process.argv[1])) {
  main().catch((e) => { process.stdout.write(JSON.stringify({ ok: false, error: e.message }) + '\n'); process.exitCode = 1; });
}
