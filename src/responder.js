// The local live responder (config.quick.local; design and benchmarks in docs/local-responder.md): JARVIS's fast path
// answered by a model on a machine's own Ollama through a direct /api/chat tool loop — tens of milliseconds to the first
// token instead of seconds — with JARVIS's character and a read-only subset of the rigs MCP tools. Anything beyond them
// is handed back with [[ESCALATE]]. It is one more fast-path brain: chat.quickTurn picks it (quick.localResponder) and
// falls back to the Haiku turn when it can't start; escalation, timing and the ledger stay as they are.
//
// The machine that hosts the model runs the turn. When that is another machine (quick.local.node), the caller streams
// the turn from the host's POST /api/local/responder/turn; Ollama itself stays on the host's loopback.
import { config } from './config.js';
import { ESCALATE_MARKER, READ_ONLY_TOOLS, localSettings } from './quick.js';
import { log, truncate } from './util.js';

// ---------------------------------------------------------------- the prompt (pure)

// Which tool answers which kind of question.
const TOOL_USE = {
  mesh_status: 'machines, the mesh, what is online, CPU/memory load, installed agents',
  mesh_sessions: 'which sessions or agents are running',
  mesh_apps: 'App Cloud apps and whether they are up',
  project_list: 'projects, their tasks and progress',
  mesh_processes: "processes on one machine (needs the machine's name)",
  usage_report: 'tokens, time or money spent',
  trace_list: "Sir's recent requests and what happened to them",
  ui_open: 'opens the JARVIS file browser on a machine at a folder or file (path, a place like downloads or home, or a project name); use it whenever Sir asks to open, show or browse a folder or file',
};

/**
 * SOUL.md without its "Work" section and without the example exchanges that file work or report a status: the
 * responder can't file work and knows the mesh only through tools, so it must not learn to say "it's filed" or
 * "all quiet" from examples (docs/local-responder.md §3.2). Pure.
 */
export function responderSoul(text) {
  return String(text || '')
    .replace(/\n## Work:[\s\S]*?(?=\n---\n|\n## |\n# )/, '\n')
    .split(/\n{2,}/).filter((para) => !/^Tony:/m.test(para) || !/\bfiled\b|dispatched|already at it|all quiet|nothing's stirred|build pass|alerts/i.test(para)).join('\n\n');
}

const clock = (now) => now.toLocaleString('en-GB', { weekday: 'long', hour: '2-digit', minute: '2-digit', day: 'numeric', month: 'long' });

/**
 * The responder's system prompt: JARVIS's character, the reply contract and its own rules, the escalation rule last
 * (small models weight the end). Everything but the last line is stable, so Ollama keeps its KV cache between turns;
 * the clock goes last. Pure.
 */
export function responderPrompt({ soul = '', persona = {}, name = '', model = '', tools = READ_ONLY_TOOLS, now = new Date() } = {}) {
  const humor = persona.humor ?? 60;
  return [
    soul ? responderSoul(soul) : '',
    soul ? '---' : '',
    `# Your role now: JARVIS's live first responder`,
    `You are ${persona.name || 'J.A.R.V.I.S.'}, the voice of RIGS OS (the user's control plane for every workstation on their Tailscale network), answering first and fast on a local model (${model || 'local'}). Address the user as "${persona.address || 'sir'}". Humor ${humor}%: ${humor > 70 ? 'dry, cheeky wit welcome' : humor > 30 ? 'a light touch of dry wit' : 'strictly professional'}.`,
    'Reply format: your reply is spoken aloud. Open with 1–2 short natural sentences, plain speech (no markdown, lists, code, paths or URLs), the answer first. Details for the screen may follow after a line containing only "---"; they are never read out. Simple answers skip the "---" part.',
    'You handle greetings, chat, short factual questions and quick read-only lookups yourself, briefly and in character.',
    '## Facts about the mesh come only from tools',
    'You know nothing about the machines, sessions, apps, projects, usage or recent requests except what a tool returns in this turn. Never describe any of them without calling the matching tool first; the example lines in your character notes are tone, not facts. Tools:',
    ...tools.map((t) => `- ${t}: ${TOOL_USE[t] || 'read-only lookup'}`),
    'Call the tool, then answer from its result. If a tool fails, say so plainly.',
    '## What you cannot do',
    tools.includes('ui_open') ? 'Opening the file browser with ui_open is the one action you may take; say what opened (and where it fell back to, if the result says missing).' : '',
    `You cannot file work, start agents or projects, run commands, write files, send messages, search the web or change any setting, and you must never say or imply that you did or will. For any request to build, make, write, fix, change, install, run, start, stop, send or research something, reply with only ${ESCALATE_MARKER} followed by one short reason, and nothing else: the full JARVIS brain takes it over from there.`,
    `Local time: ${clock(now)}. You run on "${name}".`,
  ].filter(Boolean).join('\n');
}

/**
 * A reply that only announces a lookup ("Of course, sir. Let me check the mesh status.") without calling a tool — the
 * one failure small models repeat. The runner keeps it as the spoken opener and asks once for the tool call. Pure.
 */
export function narratedToolCall(text) {
  const spoken = String(text || '').split(/\n\s*---/)[0].trim();
  return spoken.length > 0 && spoken.length < 200
    && /\b(?:let me|i'll|i will|allow me to|i'm going to)\s+(?:quickly\s+)?(?:check|look|see|pull|fetch|query|scan|find|get|review|take a look)\b|\b(?:checking|scanning|pulling up|looking up|querying)\b/i.test(spoken);
}
export const NUDGE = 'You announced a lookup but did not call a tool. Call the matching tool now. Do not repeat or rephrase what you already said.';

/** The last few messages before the current one, as chat messages for the model (like the fast path's recentContext). Pure. */
export function contextMessages(messages = [], { count = 6, chars = 800 } = {}) {
  return (messages || []).slice(-count).filter((m) => m && String(m.text || '').trim())
    .map((m) => ({ role: m.role === 'user' ? 'user' : 'assistant', content: truncate(String(m.text), chars) }));
}

/** Only names in READ_ONLY_TOOLS, whatever the caller asked for. Pure. */
export const allowedTools = (names) => (Array.isArray(names) ? names : READ_ONLY_TOOLS).filter((n) => READ_ONLY_TOOLS.includes(n));

// ---------------------------------------------------------------- tools

let toolsOverride = null;
/** Tests: replace the tool implementations ({ name, description, inputSchema, run }[]); null restores the rigs MCP. */
export function setResponderTools(list) { toolsOverride = list; }
async function toolCatalog() { return toolsOverride || (await import('./mcp.js')).TOOLS; }

const RESULT_CHARS = 6000;

/** The model's tool definitions and a runner for the allowed names; results are cut to ~6 kB. */
async function toolBox(names) {
  const allowed = allowedTools(names);
  const list = (await toolCatalog()).filter((t) => allowed.includes(t.name));
  return {
    names: list.map((t) => t.name),
    defs: list.map((t) => ({ type: 'function', function: { name: t.name, description: t.description, parameters: t.inputSchema || { type: 'object', properties: {} } } })),
    async run(name, args) {
      const t = list.find((x) => x.name === name);
      const a = typeof args === 'string' ? (() => { try { return JSON.parse(args || '{}'); } catch { return {}; } })() : args || {};
      const out = await t.run(a);
      const s = typeof out === 'string' ? out : JSON.stringify(out);
      return s.length > RESULT_CHARS ? s.slice(0, RESULT_CHARS) + ' …(cut)' : s;
    },
  };
}

// ---------------------------------------------------------------- Ollama

const ollamaBase = () => String(config().brain?.ollamaUrl || 'http://127.0.0.1:11434').replace(/\/$/, '');
const sameModel = (m, name) => m && (m.name === name || m.model === name || m.name === `${name}:latest` || m.model === `${name}:latest`);

async function ollamaGet(url, p, timeout = 2000) {
  const r = await fetch(url + p, { signal: AbortSignal.timeout(timeout) });
  if (!r.ok) throw new Error(`Ollama ${p} HTTP ${r.status}`);
  return r.json();
}

/** Is the model installed / loaded on this Ollama? → { reachable, installed, loaded, sizeVramMb, contextLength, error } */
export async function modelState(model, url = ollamaBase()) {
  let ps;
  try { ps = await ollamaGet(url, '/api/ps'); } catch (e) { return { reachable: false, installed: false, loaded: false, error: `Ollama at ${url} is not reachable (${e.cause?.code || e.message})` }; }
  const m = (ps.models || []).find((x) => sameModel(x, model));
  if (m) return { reachable: true, installed: true, loaded: true, sizeVramMb: Math.round((m.size_vram || 0) / 1048576), contextLength: m.context_length || null, expiresAt: m.expires_at || '' };
  let installed = false;
  try { installed = ((await ollamaGet(url, '/api/tags')).models || []).some((x) => sameModel(x, model)); } catch {}
  return { reachable: true, installed, loaded: false };
}

/** One streamed /api/chat round → { content, toolCalls, stats }. onFirst hears the first output, onText each text piece. */
async function chatRound(url, body, { signal, onText, onFirst }) {
  const r = await fetch(url + '/api/chat', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ ...body, stream: true }), signal });
  if (!r.ok) {
    const t = await r.text().catch(() => '');
    const e = new Error(`Ollama HTTP ${r.status}: ${truncate(t, 300)}`);
    e.status = r.status;
    e.body = t;
    throw e;
  }
  const out = { content: '', toolCalls: [], stats: null };
  const dec = new TextDecoder();
  let buf = '';
  const line = (l) => {
    if (!l.trim()) return;
    let e;
    try { e = JSON.parse(l); } catch { return; }
    if (e.error) throw new Error(`Ollama: ${e.error}`);
    const m = e.message || {};
    if (m.tool_calls?.length) { onFirst(); out.toolCalls.push(...m.tool_calls); }
    if (m.content) { onFirst(); out.content += m.content; onText(m.content); }
    if (e.done) out.stats = e;
  };
  for await (const chunk of r.body) {
    buf += dec.decode(chunk, { stream: true });
    let i;
    while ((i = buf.indexOf('\n')) >= 0) { const l = buf.slice(0, i); buf = buf.slice(i + 1); line(l); }
  }
  line(buf);
  return out;
}

// ---------------------------------------------------------------- the turn on this machine

let busy = 0;
let lastError = '';
let lastTurn = null;
let warming = null;

/**
 * Load the model and its prompt prefix into Ollama (one token generated) so the next turn starts warm. One at a time;
 * resolves to { ok, ms, error }.
 */
export function warm(settings = config().quick?.local, { soul = '', persona = config().persona || {}, name = config().name } = {}) {
  if (warming) return warming;
  const l = localSettings(settings);
  const url = ollamaBase();
  const t0 = Date.now();
  const system = responderPrompt({ soul, persona, name, model: l.model, tools: allowedTools(l.tools) });
  warming = fetch(url + '/api/chat', {
    method: 'POST', headers: { 'content-type': 'application/json' }, signal: AbortSignal.timeout(120000),
    body: JSON.stringify({ model: l.model, messages: [{ role: 'system', content: system }, { role: 'user', content: 'Good evening.' }], stream: false, keep_alive: l.keepAlive, options: { num_ctx: l.numCtx, num_predict: 1 }, ...(l.think === false ? { think: false } : {}) }),
  }).then(async (r) => (r.ok ? { ok: true, ms: Date.now() - t0 } : { ok: false, ms: Date.now() - t0, error: `Ollama HTTP ${r.status}: ${truncate(await r.text().catch(() => ''), 200)}` }))
    .catch((e) => ({ ok: false, ms: Date.now() - t0, error: e.message }))
    .then((r) => { if (!r.ok) { lastError = r.error; log(`responder: warming ${l.model} failed: ${r.error}`); } else log(`responder: ${l.model} warm in ${r.ms} ms`); return r; })
    .finally(() => { warming = null; });
  return warming;
}

/**
 * One responder turn on this machine's Ollama. emit hears { type: 'delta' | 'tool' | 'tool-result' }.
 * Resolves to { text, usage } plus at most one of:
 * - unavailable: nothing was shown and the turn can't answer (Ollama down, model not installed or not loaded — then it
 *   warms in the background —, no first token within firstTokenMs, an HTTP error before any output);
 * - escalate: it asked for a tool it doesn't have, or used up its tool rounds (an [[ESCALATE]] reply stays in text);
 * - error: it failed after output was shown.
 * Never throws.
 */
export async function localTurn({ text, context = [], settings, soul = '', persona = config().persona || {}, name = config().name, emit = () => {}, signal } = {}) {
  const l = localSettings(settings);
  const url = ollamaBase();
  const t0 = Date.now();
  const state = await modelState(l.model, url);
  if (!state.loaded) {
    const why = !state.reachable ? state.error : !state.installed ? `${l.model} is not installed in Ollama (ollama pull ${l.model})` : `${l.model} is not loaded yet (warming it up)`;
    if (state.reachable && state.installed) warm(l, { soul, persona, name });
    lastError = why;
    lastTurn = { at: t0, ms: Date.now() - t0, model: l.model, status: 'unavailable' };
    return { text: '', usage: null, unavailable: why };
  }
  const box = await toolBox(l.tools);
  const messages = [{ role: 'system', content: responderPrompt({ soul, persona, name, model: l.model, tools: box.names }) }, ...context, { role: 'user', content: String(text || '') }];
  const ac = new AbortController();
  const stopAll = () => ac.abort();
  signal?.addEventListener('abort', stopAll, { once: true });
  let shown = false; // anything reached the screen (text or a tool call)
  let first = false;
  let noFirstToken = false;
  const firstTimer = setTimeout(() => { if (!first) { noFirstToken = true; ac.abort(); } }, l.firstTokenMs);
  const onFirst = () => { if (!first) { first = true; clearTimeout(firstTimer); } };
  let full = '';
  let nudged = false;
  let needSep = false; // after the narration guard's nudge the answer continues the spoken opener
  let think = l.think === false ? false : undefined;
  let ranTools = 0;
  const usage = { model: l.model, inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0, costUsd: 0, durationMs: 0 };
  const done = (r) => {
    clearTimeout(firstTimer);
    signal?.removeEventListener('abort', stopAll);
    usage.durationMs = Date.now() - t0;
    if (r.error || r.unavailable) lastError = r.error || r.unavailable;
    lastTurn = { at: t0, ms: usage.durationMs, model: l.model, status: r.unavailable ? 'unavailable' : r.error ? 'error' : r.escalate ? 'escalated' : 'ok', tools: ranTools };
    return { text: full, usage, ...r };
  };
  busy++;
  try {
    for (let round = 0; round < l.maxRounds; round++) {
      let res;
      const body = { model: l.model, messages, tools: box.defs, keep_alive: l.keepAlive, options: { num_ctx: l.numCtx }, ...(think !== undefined ? { think } : {}) };
      try {
        res = await chatRound(url, body, {
          signal: ac.signal, onFirst,
          onText: (t) => { const s = (needSep ? ' ' : '') + t; needSep = false; full += s; shown = true; emit({ type: 'delta', text: s }); },
        });
      } catch (e) {
        if (signal?.aborted) return done({});
        if (noFirstToken) return done({ unavailable: `no first token from ${l.model} within ${l.firstTokenMs} ms` });
        // a model without a thinking switch rejects `think`: once more without it
        if (!shown && think !== undefined && e.status === 400 && /think/i.test(e.body || '')) { think = undefined; round--; continue; }
        return done(shown ? { error: e.message } : { unavailable: e.message });
      }
      if (res.stats) {
        usage.inputTokens += Number(res.stats.prompt_eval_count) || 0;
        usage.outputTokens += Number(res.stats.eval_count) || 0;
      }
      if (!res.toolCalls.length && l.guard && !nudged && !ranTools && narratedToolCall(res.content)) {
        // keep the announcement as the spoken opener (already streamed and spoken) and ask once for the tool it announced
        nudged = true;
        needSep = true;
        messages.push({ role: 'assistant', content: res.content.split(/\n\s*---/)[0].trim() }, { role: 'system', content: NUDGE });
        continue;
      }
      if (!res.toolCalls.length) return done({});
      messages.push({ role: 'assistant', content: res.content || '', tool_calls: res.toolCalls });
      for (const c of res.toolCalls) {
        const toolName = c.function?.name || '';
        if (!box.names.includes(toolName)) return done({ escalate: `needs ${toolName || 'a tool'}, which the local responder does not have` });
        const id = `rt-${t0.toString(36)}-${++ranTools}`;
        const input = c.function?.arguments || {};
        shown = true;
        emit({ type: 'tool', id, name: toolName, input: truncate(JSON.stringify(input), 300) });
        let output;
        let status = 'ok';
        try { output = await box.run(toolName, input); } catch (e) { output = JSON.stringify({ error: e.message }); status = 'error'; }
        emit({ type: 'tool-result', id, name: toolName, output: truncate(output, 2000), status });
        messages.push({ role: 'tool', tool_name: toolName, content: output });
        if (signal?.aborted) return done({});
      }
    }
    return done({ escalate: `used up its ${l.maxRounds} tool rounds` });
  } catch (e) {
    return done(shown ? { error: e.message } : { unavailable: e.message });
  } finally { busy--; }
}

/** Is a turn running here (the GPU overseer must not unload the model mid-sentence)? */
export const isBusy = () => busy > 0;

/** This machine's view of the responder: settings, whether its Ollama has the model loaded, the last turn. */
export async function status() {
  const l = localSettings(config().quick?.local);
  const node = l.node || config().name;
  const host = node === config().name;
  return {
    ...l, node, self: config().name, host,
    ...(host ? { ollamaUrl: ollamaBase(), ...(await modelState(l.model)) } : {}),
    busy: busy > 0, warming: !!warming, lastError, lastTurn,
  };
}

// ---------------------------------------------------------------- another machine hosts the model

let peerLookup = () => null;
/** server.js hands in discovery: name → peer node ({ name, url, online, rigs, viaToken }). */
export function setPeers(fn) { peerLookup = typeof fn === 'function' ? fn : () => null; }

/**
 * Stream a turn from the host's POST /api/local/responder/turn (NDJSON). Same result contract as localTurn; a host
 * that is offline, not running RIGS, too old for the route or silent past firstTokenMs → unavailable.
 */
export async function remoteTurn(nodeName, { text, context = [], settings, emit = () => {}, signal, trace = null } = {}) {
  const l = localSettings(settings);
  const node = peerLookup(nodeName);
  if (!node) return { text: '', usage: null, unavailable: `${nodeName} is not in the mesh` };
  if (!node.online || !node.rigs) return { text: '', usage: null, unavailable: `${nodeName} is ${node.online ? 'not running RIGS' : 'offline'}` };
  const ac = new AbortController();
  const stopAll = () => ac.abort();
  signal?.addEventListener('abort', stopAll, { once: true });
  let first = false;
  let silent = false;
  // the host has its own first-token timer; this one only covers a host that never answers
  const waitMs = l.firstTokenMs + 2000;
  const timer = setTimeout(() => { if (!first) { silent = true; ac.abort(); } }, waitMs);
  let full = '';
  let shown = false;
  let result = null;
  const headers = { 'content-type': 'application/json', 'x-rigs-via': config().name, ...(node.viaToken ? { 'x-rigs-token': config().meshToken } : {}) };
  try {
    const r = await fetch(node.url.replace(/\/$/, '') + '/api/local/responder/turn', { method: 'POST', headers, body: JSON.stringify({ text, context, local: l, trace }), signal: ac.signal });
    if (!r.ok) {
      const t = await r.text().catch(() => '');
      return { text: '', usage: null, unavailable: r.status === 404 ? `${nodeName} does not serve the local responder (RIGS too old?)` : `${nodeName}: HTTP ${r.status} ${truncate(t, 160)}` };
    }
    const dec = new TextDecoder();
    let buf = '';
    const line = (raw) => {
      if (!raw.trim()) return;
      let e;
      try { e = JSON.parse(raw); } catch { return; }
      if (e.type !== 'ping' && !first) { first = true; clearTimeout(timer); }
      if (e.type === 'delta') { full += e.text || ''; shown = true; emit({ type: 'delta', text: e.text || '' }); }
      else if (e.type === 'tool') { shown = true; emit(e); }
      else if (e.type === 'tool-result' || e.type === 'status') emit(e);
      else if (e.type === 'done' || e.type === 'unavailable' || e.type === 'error') result = e;
    };
    for await (const chunk of r.body) {
      buf += dec.decode(chunk, { stream: true });
      let i;
      while ((i = buf.indexOf('\n')) >= 0) { const raw = buf.slice(0, i); buf = buf.slice(i + 1); line(raw); }
    }
    line(buf);
  } catch (e) {
    if (signal?.aborted) return { text: full, usage: null };
    if (silent) return { text: '', usage: null, unavailable: `${nodeName} sent nothing within ${waitMs} ms` };
    return shown ? { text: full, usage: null, error: `${nodeName}: ${e.message}` } : { text: '', usage: null, unavailable: `${nodeName} unreachable: ${e.cause?.code || e.message}` };
  } finally { clearTimeout(timer); signal?.removeEventListener('abort', stopAll); }
  if (!result) return shown ? { text: full, usage: null, error: `${nodeName}: the stream ended early` } : { text: '', usage: null, unavailable: `${nodeName}: the stream ended without a reply` };
  if (result.type === 'unavailable') return { text: '', usage: null, unavailable: `${nodeName}: ${result.reason}` };
  if (result.type === 'error') return shown ? { text: full, usage: result.usage || null, error: result.message } : { text: '', usage: null, unavailable: `${nodeName}: ${result.message}` };
  return { text: full, usage: result.usage || null, ...(result.escalate ? { escalate: result.escalate } : {}) };
}

/**
 * The host side of POST /api/local/responder/turn: runs the turn on this machine's Ollama with this machine's own
 * SOUL.md and persona and streams it as NDJSON events (delta, tool, tool-result), then one of done
 * { text, usage, escalate? } · unavailable { reason } (always before any delta) · error { message }. The caller's
 * settings are validated again, so a caller can narrow the tools but never widen them.
 */
export async function hostTurn(b = {}, emit, { soul = '', signal } = {}) {
  const settings = localSettings({ ...(config().quick?.local || {}), ...(b.local || {}) });
  const context = (Array.isArray(b.context) ? b.context : []).slice(-6)
    .filter((m) => m && typeof m.content === 'string').map((m) => ({ role: m.role === 'user' ? 'user' : 'assistant', content: truncate(m.content, 800) }));
  const r = await localTurn({ text: String(b.text || ''), context, settings, soul, emit, signal });
  if (r.unavailable) emit({ type: 'unavailable', reason: r.unavailable });
  else if (r.error) emit({ type: 'error', message: r.error, usage: r.usage });
  else emit({ type: 'done', text: r.text, usage: r.usage, ...(r.escalate ? { escalate: r.escalate } : {}) });
  return r;
}

// ---------------------------------------------------------------- the fast-path runner (chat.tracedRun)

/**
 * The runner chat.quickTurn hands to tracedRun when the local responder is on: same signature as runClaude / runOllama.
 * opts.local = localResponder()'s settings (with node), opts.soul = SOUL.md, opts.self = this machine. Tool calls feed
 * the trace collector (opts.tools) as tool-call spans with their real results; the screen sees { type: 'tool' }.
 * Resolves to { text, error, usage } plus escalate / unavailable (then error says so too, for the span and ledger).
 */
export async function runResponder(chat, text, model, effort, emit, meshSummary, signal, projects, { tools, local, soul = '', self = config().name, trace = null } = {}) {
  const settings = { ...local, model: model || local?.model };
  const context = contextMessages((chat?.messages || []).slice(0, -1));
  const relay = (e) => {
    if (e.type === 'tool') {
      tools?.feed('claude', { type: 'assistant', message: { content: [{ type: 'tool_use', id: e.id, name: e.name, input: safeJson(e.input) }] } });
      emit({ type: 'tool', name: e.name, input: e.input });
    } else if (e.type === 'tool-result') {
      tools?.feed('claude', { type: 'user', message: { content: [{ type: 'tool_result', tool_use_id: e.id, content: e.output, is_error: e.status === 'error' }] } });
    } else emit(e);
  };
  const node = local?.node || self;
  const r = node === self
    ? await localTurn({ text, context, settings, soul, emit: relay, signal })
    : await remoteTurn(node, { text, context, settings, emit: relay, signal, trace });
  // a local turn is never billed: cost 0 in the span and ledger, also for an attempt that couldn't start
  const usage = { model: settings.model, inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0, ...(r.usage || {}), costUsd: 0 };
  if (r.unavailable) return { text: '', error: `local responder unavailable: ${r.unavailable}`, unavailable: r.unavailable, usage };
  return { text: r.text, error: r.error || null, usage, ...(r.escalate ? { escalate: r.escalate } : {}) };
}

function safeJson(s) { if (typeof s !== 'string') return s; try { return JSON.parse(s); } catch { return s; } }
