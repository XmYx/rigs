import crypto from 'node:crypto';
import fs from 'node:fs';
import fsp from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { config, RIGS_HOME } from './config.js';
import { CLAUDE_OLLAMA, claudeFlags, claudeOllamaEnv, claudeOllamaFlags, claudeOllamaUrl, codexFlags, coreBrain, catalog, ollamaThink } from './models.js';
import { bin } from './tools.js';
import { escalationGate, localResponder, parseEscalation, quickBrain, quickNote, resolveQuick } from './quick.js';
import { runResponder } from './responder.js';
import { parseProjects, prerouteOn, route as routeRequest } from './router.js';
import * as trace from './trace.js';
import { claudeResultUsage, codexTurnUsage, ollamaUsage, recordChatTurn, recordRequest } from './usage.js';
import { APP_DIR, HOME, augmentedPath, readJson, spawnCmd, truncate, writeJsonAtomic } from './util.js';

/**
 * JARVIS chats. One conversation can hop between brains mid-stream (Claude Code, Codex, any
 * Ollama model): each brain is told what the others said since it last spoke, so swapping the
 * brain keeps the thread intact.
 */

const DIR = path.join(RIGS_HOME, 'chats');

export async function listChats() {
  await fsp.mkdir(DIR, { recursive: true });
  const names = (await fsp.readdir(DIR)).filter((n) => n.endsWith('.json'));
  const chats = await Promise.all(names.map((n) => readJson(path.join(DIR, n))));
  return chats.filter(Boolean).map((c) => ({ id: c.id, title: c.title, brain: c.brain, model: c.model, updatedAt: c.updatedAt, count: c.messages.length, project: c.project || '', ongoing: !!c.ongoing, main: !!c.main }))
    .sort((a, b) => b.updatedAt - a.updatedAt);
}

export async function getChat(id) {
  if (!/^[\w-]+$/.test(id)) return null;
  return readJson(path.join(DIR, id + '.json'));
}

async function saveChat(c) {
  c.updatedAt = Date.now();
  await writeJsonAtomic(path.join(DIR, c.id + '.json'), c);
}

function workRoot() {
  const r = config().brain.workRoot || '~';
  return r === '~' ? HOME : r.startsWith('~/') ? path.join(HOME, r.slice(2)) : r;
}

export async function createChat({ brain, model, effort, title, cwd, hidden, project, ongoing } = {}) {
  const c = {
    id: crypto.randomUUID(), title: title || 'New conversation', brain: brain || 'auto', model: model || '', effort: effort || '', cwd: cwd || workRoot(), hidden: !!hidden,
    project: project || '', ongoing: !!ongoing, main: false,
    createdAt: Date.now(), updatedAt: Date.now(), messages: [], claudeSessionId: null, codexThreadId: null, seen: {},
  };
  await saveChat(c);
  return c;
}

/** The JARVIS thread: the one long-running conversation that answers go into. Created on first use. */
export async function mainChat() {
  const existing = (await listChats()).find((c) => c.main);
  if (existing) return getChat(existing.id);
  const c = await createChat({ title: 'JARVIS' });
  c.main = true;
  await saveChat(c);
  return c;
}

/**
 * A RIGS report (a project finished, a task needs Sir, a merge landed) written into the JARVIS thread — and into the
 * thread the request came from — so it is there to read later and the brain sees it on its next turn.
 */
export async function postReport({ text, level = 'info', chatId = '', project = null } = {}) {
  const msg = { role: 'assistant', text: String(text || '').slice(0, 8000), brain: 'rigs', report: true, level, project: project?.id || '', ts: Date.now() };
  const main = await mainChat();
  const targets = [main];
  if (chatId && chatId !== main.id) { const c = await getChat(chatId).catch(() => null); if (c) targets.push(c); }
  for (const c of targets) {
    c.messages.push(msg);
    c.updatedAt = Date.now();
    await saveChat(c);
  }
  return { ok: true, chats: targets.map((c) => c.id) };
}

/** Archive the JARVIS thread (kept on disk, no longer routed to); the next answer starts a fresh one. */
export async function clearMainChat() {
  const existing = (await listChats()).find((c) => c.main);
  if (!existing) return { ok: true, cleared: false };
  const c = await getChat(existing.id);
  c.main = false;
  c.ongoing = false;
  await saveChat(c);
  return { ok: true, cleared: true };
}

export async function deleteChat(id) {
  if (!/^[\w-]+$/.test(id)) return false;
  await fsp.rm(path.join(DIR, id + '.json'), { force: true });
  return true;
}

/** Providers usable as a brain on this machine, with models + effort levels (see models.js). */
export async function availableBrains() {
  const core = coreBrain();
  return (await catalog()).map((p) => ({
    id: p.id, label: p.label, models: p.models, efforts: p.efforts, ...(p.signedIn === false ? { signedIn: false } : {}),
    ...(p.id === CLAUDE_OLLAMA ? { available: p.available, reason: p.reason || '', url: p.url, toolModels: p.toolModels } : {}),
    default: core.provider === p.id ? core.model : (p.default ?? (p.id === 'ollama' ? p.models[0] || '' : '')),
    defaultEffort: core.provider === p.id ? core.effort : '',
  }));
}

/** Pick provider/model/effort: explicit request → this machine's core brain → first available. */
async function resolveBrain(brain, model, effort) {
  const list = await availableBrains();
  const core = coreBrain();
  let b = brain && brain !== 'auto' ? list.find((x) => x.id === brain) : null;
  if (!b && core.provider !== 'auto') b = list.find((x) => x.id === core.provider);
  if (!b) b = list.find((x) => x.available !== false);
  if (!b) throw new Error('No brain available on this machine — install Claude Code, Codex or Ollama.');
  // Claude via Ollama is listed whenever the claude CLI is installed, so Settings can say why it can't run.
  if (b.id === CLAUDE_OLLAMA && b.available === false) throw new Error(`Claude via Ollama is not available: ${b.reason}`);
  const m = model || b.default || (b.id === 'ollama' ? b.models[0] : '');
  if (b.id === 'ollama' && !m) throw new Error('Ollama is running but has no models — `ollama pull llama3.2`.');
  if (b.id === CLAUDE_OLLAMA && !m) throw new Error('Claude via Ollama: Ollama has no model to run — `ollama pull qwen3-coder`.');
  if (b.id === CLAUDE_OLLAMA && !b.models.includes(m)) throw new Error(`Claude via Ollama: ${m} is not installed in Ollama at ${b.url} (installed: ${b.models.join(', ')}).`);
  const e = effort && b.efforts.includes(effort) ? effort : (b.defaultEffort || '');
  return { brain: b.id, model: m, effort: e };
}

// JARVIS's character: ~/.rigs/SOUL.md when Sir keeps his own copy (JARVIS may refine it), else persona/SOUL.md.
let soulCache = { file: '', mtime: 0, text: '' };
export function soul() {
  const own = path.join(RIGS_HOME, 'SOUL.md');
  const file = fs.existsSync(own) ? own : path.join(APP_DIR, 'persona', 'SOUL.md');
  try {
    const mtime = fs.statSync(file).mtimeMs;
    if (file !== soulCache.file || mtime !== soulCache.mtime) soulCache = { file, mtime, text: fs.readFileSync(file, 'utf8').replace(/<!--[\s\S]*?-->\s*/, '').trim() };
    return soulCache.text;
  } catch { return ''; }
}

/** JARVIS's operating rules (AGENTS.md): ~/.rigs/AGENTS.md if present, else persona/AGENTS.md. */
export function agentsRules() {
  const own = path.join(RIGS_HOME, 'AGENTS.md');
  const file = fs.existsSync(own) ? own : path.join(APP_DIR, 'persona', 'AGENTS.md');
  try { return fs.readFileSync(file, 'utf8').replace(/<!--[\s\S]*?-->\s*/, '').trim(); } catch { return ''; }
}

export function personaPrompt(meshSummary, projects = '') {
  const p = config().persona;
  const humor = p.humor ?? 60;
  const now = new Date();
  const character = p.soul === false ? '' : soul();
  const rules = agentsRules();
  return [
    character ? `${character}\n\n---\n# RIGS specifics` : '',
    rules ? `# Operating rules (AGENTS.md)\n${rules}\n` : '',
    `You are ${p.name}, the voice of RIGS OS — the user's personal control plane for every workstation on their Tailscale network.`,
    `Local time on this machine: ${now.toLocaleString('en-GB', { weekday: 'long', hour: '2-digit', minute: '2-digit', day: 'numeric', month: 'long' })}.`,
    `This brain is running on the machine "${config().name}" (${os.type()} ${os.release()}, ${process.arch}).`,
    `You work in the user's home (${workRoot()}): you may read, create and edit files there and run commands (git, builds, scripts) to get things done. Other machines' homes are reachable with the mesh_* tools. Be careful with destructive actions: never delete or overwrite the user's data without asking — move things to ~/.rigs/trash instead of deleting.`,
    `Address the user as "${p.address}". Humor setting ${humor}%: ${humor > 70 ? 'dry, cheeky wit welcome' : humor > 30 ? 'a light touch of dry wit' : 'strictly professional'}.`,
    `Reply format — spoken versus written: your reply is spoken aloud in your own voice, so open with a short spoken line: 1–2 natural sentences, plain speech (no markdown, lists, code, paths or URLs), the answer or outcome first. That line is all that is said. When more is useful — steps, details, lists, code, numbers, reasoning, links — add it after a line containing only "---" as a written description: it is shown on screen, never read out, and may be as long and structured as the content needs (markdown welcome). Don't repeat the spoken line there. For simple answers, skip the "---" part entirely.`,
    `Visual replies: the screen draws animated cards for structured content. In the written part (after "---") you may put a fenced block tagged visual containing one JSON object, instead of a table or list, whenever a picture is clearer: {"kind":"weather","place":"Budapest","condition":"rain","temp":14,"detail":"wind 18 km/h","forecast":[{"day":"Tue","condition":"sun","high":18,"low":9}]} · {"kind":"code","file":"src/x.js","language":"js","code":"...lines, prefix + for added and - for removed..."} · {"kind":"metrics","title":"magix-system","items":[{"label":"CPU","value":42,"max":100,"unit":"%","tone":"ok"}]} · {"kind":"steps","title":"Plan","items":[{"text":"Build","done":true},{"text":"Test","status":"running"}]} · {"kind":"status","title":"Mesh","items":[{"name":"macbook","state":"ok|warn|bad","value":"online"}]} · {"kind":"bars","title":"Sessions","items":[{"label":"claude","value":12}]}. Use them for weather, code changes, system numbers, plans and progress, mesh status; keep the spoken line plain. This is required, not optional: whenever the written part would contain weather, numbers, three or more items, machine or app status, code changes, a plan or progress, put the matching visual block in it instead of a list or table.`,
    'Capabilities you can use (when your harness exposes them as tools):',
    '- rigs MCP (mesh_*): list machines, run commands, read/write files, list/read/send to coding & chat sessions on ANY machine, start Claude Code/Codex/Ollama agents on a machine, ask another machine\'s brain, broadcast updates.',
    '- Opening folders and files: when Sir asks to open, show or browse a folder or a file ("open my Downloads folder", "show me the files in ~/rigs-dev on magix-system", "show it in Files"), call ui_open (view "files", the machine, the path / a place like downloads or home / a project nickname): it opens the RIGS file browser in JARVIS right there, a file with its folder open and the file selected. Never use Finder, `open`, xdg-open, explorer or mesh_control for this, and never answer with a text listing instead. Don\'t search the disk first when he named the place.',
    '- The shared folder: one folder kept in sync on every machine (`rigs shared path` prints it, default ~/RIGS-Shared). It is the default place for anything made for Sir that does not belong in a repository: ad-hoc apps in apps/<id>, files made for his requests in files/, reports in reports/. Web apps there are still published to the App Cloud. To show it, ui_open with path "shared" (or "@shared/reports").',
    '- REA (reverse engineer anything, `rea` MCP / `npx rea-agents@latest`): inspect binaries, Electron/JS apps, .NET, APKs, websites — use it whenever asked how some software works.',
    '- OpenRig (`rig` CLI): persistent agent teams (rigs/seats), `rig send`, `rig queue`, `rig ps`.',
    '- Linear (linear_* tools): linear_status, linear_issues (list / search), linear_issue (read one) are read-only — use them freely for Sir\'s questions about his issues. linear_create_issue, linear_update_issue and linear_comment change his workspace: call them only when Sir asks for that exact change, never on your own initiative or as a side effect, and say what you created or changed (identifier + link). If linear_status says it is not configured, tell him how to set the key (`rigs linear key`).',
    'Every instruction gets a brief reply in your own voice. Answer chat, questions and quick one-step actions yourself. Substantial work — writing or changing code, building something, multi-step research, long jobs — you do NOT do inline: file it with jarvis_task (pick the project from the list below, "rigs" for RIGS/JARVIS itself and anything on the go, or newProject for a new line of work); RIGS casts an agent for it (OpenRig seat when available) and it shows on the Work dashboard. Then say in one or two sentences what you set in motion, under which project and where. For a big multi-part goal, project_create with plan=true and dispatch=true plans and starts the whole thing.',
    '- Projects (project_create / project_list / project_dispatch): plan a goal into tasks and delegate each to the right machine, model and effort (Opus for elaborate work, Sonnet for simpler code, Haiku for simple text, Codex for cross-check reviews). Propose this when the user asks for multi-step work.',
    '- Stopping work: when Sir says stop, pause, hold, drop, "leave it for now" or "consider it done" about a project, call project_stop for it at once (and for each project he names) — do not wait for a running task to finish, do not offer to let it complete, and do not mark tasks done or skipped instead. Confirm in one line that it is paused and that uncommitted edits stay in the tree. A paused project stays paused: never dispatch, revive or file work into it until he says to resume (project_resume).',
    `- The mesh's own source lives in a public GitHub repo checked out on every node; changes pushed there roll out to all machines (mesh_update).`,
    meshSummary ? `Current mesh state:\n${meshSummary}` : '',
    projects ? `Projects (id · name · status · owner — file work under these):\n${projects}` : '',
  ].filter(Boolean).join('\n');
}

/** Messages this brain hasn't seen yet (said by other brains / typed while another brain was active). */
function unseenContext(chat, brainKey) {
  const from = chat.seen?.[brainKey] ?? 0;
  const slice = chat.messages.slice(from, -1);
  if (!slice.length) return '';
  return 'Earlier in this conversation (handled by other brains):\n' + slice.map((m) => `${m.role === 'user' ? 'User' : `${m.brain || 'assistant'}`}: ${truncate(m.text, 2000)}`).join('\n') + '\n\nNow the user says:\n';
}

/** The last few messages before the current one, for a fast-path turn (a fresh session that resumes nothing). */
function recentContext(chat, { messages = 6, chars = 800 } = {}) {
  const slice = chat.messages.slice(0, -1).slice(-messages);
  if (!slice.length) return '';
  return 'Recently in this conversation:\n' + slice.map((m) => `${m.role === 'user' ? 'User' : 'JARVIS'}: ${truncate(m.text, chars)}`).join('\n') + '\n\nNow the user says:\n';
}

function cleanEnv() {
  const env = { ...process.env, PATH: augmentedPath() };
  for (const k of Object.keys(env)) if (k.startsWith('CLAUDECODE') || k === 'CLAUDE_CODE_ENTRYPOINT') delete env[k];
  return env;
}

function streamProcess(cmd, args, { cwd, onLine, onStderr, signal, env = {} }) {
  return new Promise((resolve) => {
    const child = spawnCmd(cmd, args, { cwd, env: { ...cleanEnv(), ...env }, stdio: ['ignore', 'pipe', 'pipe'] });
    let buf = '';
    let err = '';
    const kill = () => { try { child.kill(); } catch {} };
    signal?.addEventListener('abort', kill, { once: true });
    child.stdout.on('data', (d) => {
      buf += d;
      let i;
      while ((i = buf.indexOf('\n')) >= 0) {
        const line = buf.slice(0, i).trim();
        buf = buf.slice(i + 1);
        if (line) onLine(line);
      }
    });
    child.stderr.on('data', (d) => { err += d; onStderr?.(String(d)); });
    child.on('error', (e) => resolve({ code: -1, err: String(e.message) }));
    child.on('close', (code) => { if (buf.trim()) onLine(buf.trim()); signal?.removeEventListener('abort', kill); resolve({ code, err }); });
  });
}

async function runClaude(chat, text, model, effort, emit, meshSummary, signal, projects = '', { tools, env, viaOllama = false, quick = null } = {}) {
  const cfg = config().brain;
  // The local-model variant is the same harness, stream and tools on another endpoint; it keeps its own Claude session
  // and usage totals (a session started against Anthropic's API is not resumed against Ollama, or the other way round).
  // A fast-path turn (quick = { maxTurns }, src/quick.js) is a fresh session every time with the last few messages as
  // context: it never resumes or replaces the JARVIS thread's own Claude session.
  const key = viaOllama ? CLAUDE_OLLAMA : 'claude';
  const sessionKey = viaOllama ? 'claudeOllamaSessionId' : quick ? 'quickSessionId' : 'claudeSessionId';
  const usageKey = viaOllama ? 'claudeOllamaUsage' : quick ? 'quickUsage' : 'claudeUsage';
  const system = personaPrompt(meshSummary, projects) + (quick ? '\n\n' + quickNote({ model, maxTurns: quick.maxTurns }) : '');
  const args = ['-p', (quick ? recentContext(chat) : unseenContext(chat, key)) + text, '--output-format', 'stream-json', '--verbose', '--include-partial-messages',
    '--append-system-prompt', system, '--permission-mode', cfg.claudePermissionMode || 'auto'];
  if (cfg.claudeAllowedTools?.length) args.push('--allowedTools', cfg.claudeAllowedTools.join(','));
  args.push('--add-dir', workRoot());
  args.push(...(viaOllama ? claudeOllamaFlags({ model }) : claudeFlags({ model, effort, ...(quick ? { maxTurns: quick.maxTurns } : {}) })));
  const resumed = !quick && !!chat[sessionKey];
  if (resumed) args.push('--resume', chat[sessionKey]);
  if (viaOllama) env = { ...env, ...claudeOllamaEnv({ url: claudeOllamaUrl(cfg), model }) };
  let full = '';
  let error = null;
  let usage = null;
  const res = await streamProcess(bin('claude'), args, {
    cwd: chat.cwd || HOME, signal, env,
    onLine: (line) => {
      let e;
      try { e = JSON.parse(line); } catch { return; }
      tools?.feed('claude', e);
      if (e.session_id) chat[sessionKey] = e.session_id;
      if (e.type === 'stream_event' && e.event?.type === 'content_block_delta' && e.event.delta?.type === 'text_delta') {
        full += e.event.delta.text;
        emit({ type: 'delta', text: e.event.delta.text });
      } else if (e.type === 'stream_event' && e.event?.type === 'content_block_start' && e.event.content_block?.type === 'text' && full && !full.endsWith('\n')) {
        full += '\n\n'; emit({ type: 'delta', text: '\n\n' });
      } else if (e.type === 'assistant') {
        for (const b of e.message?.content || []) if (b.type === 'tool_use') emit({ type: 'tool', name: b.name, input: truncate(JSON.stringify(b.input), 300) });
      } else if (e.type === 'system' && e.subtype === 'api_retry') {
        emit({ type: 'status', text: `retrying (${e.error || e.error_status})…` });
      } else if (e.type === 'result') {
        // the session's running totals stay on the chat: the next (resumed) turn is counted as the difference
        try {
          usage = claudeResultUsage(e, { prev: chat[usageKey], resumed });
          chat[usageKey] = usage.cumulative; delete usage.cumulative;
          if (viaOllama) usage.costUsd = 0; // local model: nothing is billed (Claude Code would price it as a Claude model)
        } catch {}
        // --max-turns (the fast path) ends with is_error, no result and errors: ['Reached maximum number of turns (8)']
        if (e.is_error) error = e.result || (Array.isArray(e.errors) && e.errors.join('; ')) || 'Claude Code returned an error';
        else if (!full && e.result) { full = e.result; emit({ type: 'delta', text: e.result }); }
      }
    },
  });
  if (res.code !== 0 && !full && !error) error = res.err.trim() || `claude exited with ${res.code}`;
  if (viaOllama) {
    if (error) error = `Claude via Ollama (${model} at ${claudeOllamaUrl(cfg)}): ${error}`;
    if (error && /ECONNREFUSED|fetch failed|unable to connect|connection (refused|error)/i.test(error)) error += ' — is Ollama running?';
  } else if (error && /authenticat|401|login/i.test(error)) error += ' — run `claude` once in a terminal on this machine and /login.';
  return { text: full, error, usage };
}

const runClaudeOllama = (chat, text, model, effort, emit, meshSummary, signal, projects, opts) => runClaude(chat, text, model, effort, emit, meshSummary, signal, projects, { ...opts, viaOllama: true });

async function runCodex(chat, text, model, effort, emit, meshSummary, signal, projects = '', { tools, env } = {}) {
  const cfg = config().brain;
  const prompt = (chat.codexThreadId ? '' : personaPrompt(meshSummary, projects) + '\n\n') + unseenContext(chat, 'codex') + text;
  // `codex exec resume` takes its own option set (no --sandbox: that is fixed by the original session).
  const flags = codexFlags({ model, effort });
  const args = chat.codexThreadId
    ? ['exec', 'resume', '--json', '--skip-git-repo-check', ...flags, chat.codexThreadId, prompt]
    : ['exec', '--json', '--skip-git-repo-check', '--sandbox', cfg.codexSandbox || 'workspace-write', ...(cfg.codexSandbox === 'workspace-write' ? ['--add-dir', workRoot()] : []), ...flags, prompt];
  let full = '';
  let error = null;
  let usage = null;
  // turn.completed reports the thread's running total: a resumed turn is the difference from the last one seen
  // (kept on the chat); resumed without it, the turn's own share is unknown and it is filed without tokens.
  const resumed = !!chat.codexThreadId;
  const prev = chat.codexUsage?.threadId === chat.codexThreadId ? chat.codexUsage.usage : null;
  const res = await streamProcess(bin('codex'), args, {
    cwd: chat.cwd || HOME, signal, env,
    onLine: (line) => {
      let e;
      try { e = JSON.parse(line); } catch { return; }
      tools?.feed('codex', e);
      if (e.type === 'thread.started' && e.thread_id) chat.codexThreadId = e.thread_id;
      else if (e.type === 'turn.completed' && e.usage) {
        try { usage = resumed && !prev ? null : codexTurnUsage(e, prev); chat.codexUsage = { threadId: chat.codexThreadId, usage: e.usage }; } catch {}
      }
      else if (e.type === 'item.completed' && e.item?.type === 'agent_message') {
        const t = (full ? '\n\n' : '') + (e.item.text || '');
        full += t; emit({ type: 'delta', text: t });
      } else if ((e.type === 'item.started' || e.type === 'item.completed') && e.item?.type === 'command_execution') {
        if (e.type === 'item.started') emit({ type: 'tool', name: 'shell', input: truncate(e.item.command, 300) });
      } else if (e.type === 'item.completed' && e.item?.type === 'mcp_tool_call') {
        emit({ type: 'tool', name: `${e.item.server}.${e.item.tool}`, input: '' });
      } else if (e.type === 'error' || e.type === 'turn.failed') {
        error = e.message || e.error?.message || 'codex error';
      }
    },
  });
  if (res.code !== 0 && !full && !error) error = res.err.trim().split('\n').slice(-3).join(' ') || `codex exited with ${res.code}`;
  return { text: full, error, usage };
}

async function runOllama(chat, text, model, effort, emit, meshSummary, signal, projects = '', { tools } = {}) {
  const url = config().brain.ollamaUrl.replace(/\/$/, '') + '/api/chat';
  const messages = [{ role: 'system', content: personaPrompt(meshSummary, projects) + '\n(You are running locally via Ollama without tools: if an action is needed, tell the user which machine/agent can do it, or suggest switching the brain to Claude Code or Codex.)' }];
  for (const m of chat.messages) messages.push({ role: m.role === 'user' ? 'user' : 'assistant', content: m.text });
  let full = '';
  let usage = null;
  try {
    const think = ollamaThink(effort);
    const req = (withThink) => fetch(url, { method: 'POST', body: JSON.stringify({ model, messages, stream: true, ...(withThink && think !== undefined ? { think } : {}) }), headers: { 'content-type': 'application/json' }, signal });
    let r = await req(true);
    // Models without thinking support reject `think`; retry without it rather than failing the turn.
    if (!r.ok && think !== undefined) { const t = await r.text(); if (/think/i.test(t)) { emit({ type: 'status', text: `${model} has no thinking mode — answering without it` }); r = await req(false); } else return { text: '', error: `Ollama HTTP ${r.status}: ${t}` }; }
    if (!r.ok) return { text: '', error: `Ollama HTTP ${r.status}: ${await r.text()}` };
    const dec = new TextDecoder();
    let buf = '';
    for await (const chunk of r.body) {
      buf += dec.decode(chunk, { stream: true });
      let i;
      while ((i = buf.indexOf('\n')) >= 0) {
        const line = buf.slice(0, i).trim();
        buf = buf.slice(i + 1);
        if (!line) continue;
        try {
          const e = JSON.parse(line);
          tools?.feed('ollama', e);
          if (e.message?.thinking && !full) emit({ type: 'thinking', text: e.message.thinking });
          if (e.message?.content) { full += e.message.content; emit({ type: 'delta', text: e.message.content }); }
          if (e.done) usage = ollamaUsage(e);
          if (e.error) return { text: full, error: e.error, usage };
        } catch {}
      }
    }
  } catch (e) {
    if (e.name !== 'AbortError') return { text: full, error: 'Ollama: ' + e.message, usage };
  }
  return { text: full, error: null, usage };
}

/** Send a user message and stream the reply through `emit`. Persists everything. */
/** JARVIS conversations answering right now (for the work dashboard): id → { id, title, brain, model, startedAt, text }. */
export const activeTurns = new Map();
/** Traced brain turns running now: chatId → { provider, ctx } (trace.js), for handoffs that arrive without a context. */
const tracedTurns = new Map();
/**
 * Codex may start its MCP servers with a cleared environment, so RIGS_TRACE can be lost on the way to the rigs MCP: a
 * handoff from a Codex agent then attaches to the one traced Codex turn running here. Null when none or several run.
 */
export function soleActiveTrace(callerAgent = '') {
  const turns = [...tracedTurns.values()];
  return callerAgent === 'codex' && turns.length === 1 && turns[0].provider === 'codex' ? { ...turns[0].ctx } : null;
}

export async function sendMessage(id, { text, brain, model, effort, usage }, emit, opts = {}) {
  activeTurns.set(id, { id, title: '', brain: brain || '', model: model || '', startedAt: Date.now(), text: truncate(text, 120) });
  try { return await sendMessageInner(id, { text, brain, model, effort, usage }, emit, opts); } finally { activeTurns.delete(id); }
}

/** Threads a request may continue: ongoing work (implement/plan) touched in the last three days. */
export async function ongoingThreads({ days = 3, limit = 8 } = {}) {
  const cutoff = Date.now() - days * 86400000;
  const all = await listChats();
  const main = all.filter((c) => c.main);
  const ongoing = all.filter((c) => c.ongoing && c.updatedAt >= cutoff && c.count > 0 && !c.main);
  return [...main, ...ongoing].slice(0, limit);
}

// A brain's own handoff tool (claude "mcp__rigs__jarvis_task", codex "rigs.project_create"): the moment work was filed.
const HANDOFF_TOOL = /(?:^|[_.])(?:jarvis_task|project_create)$/;

/**
 * Send a request from Sir. With pre-routing on (config.router.preroute, or opts.preroute for this request) it goes
 * through the router first: answers go to the JARVIS thread (see mainChat); implement and plan work opens its own
 * thread, unless the router finds it belongs to an ongoing thread, which is then continued; work bound to a folder is
 * filed by RIGS itself. The chosen route is emitted first ({ type: 'route' }) so the screen can show it, and it is
 * handed to the brain as a hint. With pre-routing off the request goes straight to the JARVIS thread without a hint
 * and the brain decides and files work itself (jarvis_task / project_create).
 *
 * Either way the request is measured — router time, time from intake to the first work filed (by the router or by the
 * brain's handoff tool), time to the brain's reply — emitted as { type: 'timing' } and written to the usage ledger as
 * one "request" record (src/preroute-stats.js turns those into time saved). opts.router / opts.send replace the
 * router and the brain turn (tests).
 *
 * The quick-task fast path (src/quick.js, config.quick, opts.quick per request): a request routed "answer" runs as one
 * bounded turn on Haiku (simple) or Sonnet (search, multi-tool, report) — quickTurn — instead of the full brain. When
 * that turn hands it back (the fast brain asks for the full brain, hits its limit, fails or times out) the request
 * re-runs on the normal JARVIS thread, told what the fast turn already ran; the fast turn and the full turn never run
 * at the same time. The measurement carries lane 'quick', the tier and the escalation reason. opts.sendQuick
 * replaces the fast turn (tests).
 */
export async function jarvisSend(text, { brain, model, effort } = {}, emit, opts = {}) {
  const t0 = opts.startedAt || Date.now();
  const m = { preroute: prerouteOn(opts.preroute), route: '', via: '', routerMs: 0, filedAt: 0, filedBy: '', chatId: '', model: '', lane: '', tier: '', escalated: '' };
  const send = opts.send || sendMessage;
  let out;
  let failed = false;
  try {
    const { chatId, hint, decision } = m.preroute ? await preroutedTurn(text, { brain, model, effort }, emit, opts, m) : await directTurn(text, emit, opts);
    m.chatId = chatId;
    const onTool = (name, r) => { if (!m.filedAt && r.status === 'ok' && HANDOFF_TOOL.test(name || '')) Object.assign(m, { filedAt: r.end || Date.now(), filedBy: 'brain' }); };
    // A request that names no brain goes to the thread's own: a thread set to Codex / Ollama / Claude via Ollama is left alone too.
    const threadBrain = !brain && m.route === 'answer' ? (await getChat(chatId))?.brain || '' : '';
    const q = resolveQuick({ text, route: m.preroute ? m.route : '', override: opts.quick, brain: brain || threadBrain, routeInfo: decision || {}, settings: config().quick });
    if (q.on) {
      Object.assign(m, { lane: 'quick', tier: q.tier });
      const r = await (opts.sendQuick || quickTurn)(chatId, text, q, emit, { ...opts, hint, onTool });
      // the local responder (src/responder.js) reports the tier that actually answered: 'local', or the Claude tier it fell back to
      if (r?.tier) m.tier = r.tier;
      if (r?.fallback) m.fallback = r.fallback;
      if (r?.escalate == null || opts.signal?.aborted) return (out = r);
      m.escalated = r.escalate;
      if (opts.trace) trace.recordSpan({ traceId: opts.trace.traceId, parentId: opts.trace.parentId || '', kind: 'event', name: 'escalate', start: Date.now(),
        input: { reason: r.escalate, ran: r.tools || [] }, output: 'handed to the full JARVIS brain', meta: { lane: 'quick', tier: m.tier, model: r.model || q.model, effort: r.model ? '' : q.effort, to: 'full' } });
      // reset: what the fast turn already streamed (text before a tool call, a cut-off reply) is not part of the answer.
      emit({ type: 'status', text: 'handing this to the full brain…', reset: true });
      const ran = r.tools?.length ? ` It already ran: ${r.tools.slice(0, 8).join('; ')} — don't repeat what is done.` : '';
      out = await send(chatId, { text, brain, model, effort }, emit, { ...opts, hint: `${hint}\n[The fast path (${r.model || q.model}) handed this request to you: ${r.escalate}.${ran}]`.trim(), onTool });
      return out;
    }
    out = await send(chatId, { text, brain, model, effort }, emit, { ...opts, hint, onTool });
    return out;
  } catch (e) { failed = true; throw e; } finally {
    const end = Date.now();
    const timing = {
      preroute: m.preroute, route: m.route, via: m.via, routerMs: m.routerMs,
      timeToFiledMs: m.filedAt ? Math.max(0, m.filedAt - t0) : null, filedBy: m.filedBy,
      timeToReplyMs: !failed && !opts.signal?.aborted && out && !out.error ? end - t0 : null,
      ...(m.lane ? { lane: m.lane, tier: m.tier, ...(m.escalated ? { escalated: m.escalated } : {}), ...(m.fallback ? { fallback: m.fallback } : {}) } : {}),
    };
    emit({ type: 'timing', ...timing });
    await recordRequest({ tsStart: t0, tsEnd: end, chatId: m.chatId, model: m.model, traceId: opts.trace?.traceId || '', status: opts.signal?.aborted ? 'stopped' : failed || out?.error ? 'failed' : 'done', ...timing });
  }
}

/** Pre-routing off: straight to the JARVIS thread. The trace keeps a router span, marked skipped. */
async function directTurn(text, emit, opts) {
  const rspan = opts.trace ? trace.startSpan({ ...opts.trace, kind: 'router', name: 'route', input: { text }, meta: { preroute: false } }) : null;
  const chat = await mainChat();
  rspan?.end({ status: 'skipped', output: { route: '', reason: 'pre-routing is off: the brain decides and files work itself' }, meta: { preroute: false, chatId: chat.id, routerMs: 0 } });
  emit({ type: 'route', route: 'direct', reason: 'pre-routing is off', via: 'off', preroute: false, chatId: chat.id, title: chat.title, projectId: '', continued: false, work: [], unclear: [] });
  return { chatId: chat.id, hint: '' };
}

/** Pre-routing on: the router decides, RIGS files bound work, and the brain gets the decision as a hint. */
async function preroutedTurn(text, { brain, model, effort }, emit, opts, m) {
  const threads = await ongoingThreads();
  const projects = parseProjects(opts.projects || '');
  const catalog = opts.workspaces ? await opts.workspaces().catch(() => []) : [];
  // The router's span hangs off the request's intake span (opts.trace); capture gets the router model's prompt + reply.
  const capture = {};
  const rspan = opts.trace ? trace.startSpan({ ...opts.trace, kind: 'router', name: 'route', input: { text, threads: threads.map((t) => ({ id: t.id, title: t.title })), projects: projects.map((p) => p.id) }, meta: { preroute: true } }) : null;
  let decision;
  const r0 = Date.now();
  try { decision = await (opts.router || routeRequest)(text, { rules: agentsRules(), threads, projects, catalog, selfNode: config().name, capture }); }
  catch (e) { m.routerMs = Date.now() - r0; rspan?.end({ status: 'error', output: { error: e.message, prompt: capture.prompt, reply: capture.reply } }); throw e; }
  Object.assign(m, { routerMs: Date.now() - r0, route: decision.route, via: decision.via || '', model: decision.via && decision.via !== 'rules' ? capture.model || '' : '' });
  // Work the router bound to real folders is filed by RIGS itself (one planned project + agent team each);
  // the brain only tells Sir what was set in motion. Parts it couldn't bind are left to the brain to ask about.
  const bound = (decision.work || []).filter((w) => !w.unresolved);
  const unclear = (decision.work || []).filter((w) => w.unresolved);
  let filed = [];
  const isContinue = decision.route === 'continue' && decision.threadId;
  const chat = isContinue
    ? await getChat(decision.threadId)
    : decision.route === 'answer'
      ? await mainChat()
      : await createChat({
        brain, model, effort, title: decision.title || truncate(text.replace(/\s+/g, ' '), 60),
        project: decision.projectId || '', ongoing: true,
      });
  rspan?.end({
    status: chat ? 'ok' : 'error',
    input: { text, prompt: capture.prompt || null, threads: threads.map((t) => ({ id: t.id, title: t.title })), projects: projects.map((p) => p.id) },
    output: { route: decision.route, projectId: decision.projectId || '', threadId: decision.threadId || '', title: decision.title || '', reason: decision.reason || '', reply: capture.reply ?? null, work: (decision.work || []).map((w) => ({ title: w.title, goal: w.goal, node: w.node || '', workspace: w.workspace?.name || '', unresolved: !!w.unresolved })) },
    meta: { preroute: true, route: decision.route, projectId: decision.projectId || '', threadId: decision.threadId || '', chatId: chat?.id || '', via: decision.via || '', reason: decision.reason || '', model: m.model, routerMs: m.routerMs, ...(capture.tried ? { tried: capture.tried } : {}), ...(capture.error ? { modelError: capture.error } : {}) },
  });
  if (!chat) throw new Error('thread not found');
  if (bound.length && opts.onWork) {
    try { filed = await opts.onWork(bound, { chatId: chat.id, trace: rspan?.ctx || null }); } catch (e) { emit({ type: 'error', message: 'filing the work failed: ' + e.message }); }
    if (filed.length) Object.assign(m, { filedAt: Date.now(), filedBy: 'router' });
  }
  let hint = isContinue ? '' : `[routed: ${decision.route}${decision.projectId ? ` · project ${decision.projectId}` : ''} · ${decision.reason || decision.via}]`;
  if (filed.length) {
    hint += `\n[RIGS already filed this request as ${filed.length} project${filed.length > 1 ? 's' : ''} — the core brain is planning each with the project's own agent guide, then an OpenRig team is cast for it: ${filed.map((f, i) => `${i + 1}) ${f.name} → ${f.node}:${f.path} (project ${f.id})${f.flow ? ` running its "${f.flow}" flow` : ''}${f.note ? ` — ${f.note}` : ''}`).join('; ')}. Agents verify their own work, a final review checks it, and RIGS reports back when it is done${filed.some((f) => f.self) ? ' (RIGS changes are then merged by the merge steward, tested and rolled out to every machine)' : ''}. Do NOT file these again (no jarvis_task or project_create for them). Tell Sir in one or two sentences what was set in motion and where; progress shows on the Work dashboard.]`;
  }
  if (unclear.length) {
    hint += `\n[Could not tell which project ${unclear.length > 1 ? 'these parts mean' : 'this part means'}: ${unclear.map((u) => `"${u.goal}"${u.candidates?.length ? ` — candidates: ${u.candidates.map((c) => `${c.name} on ${c.node} (${c.path})`).join(', ')}` : ' — no matching folder found'}`).join('; ')}. Ask Sir which one before filing it.]`;
  }
  emit({ type: 'route', route: decision.route, reason: decision.reason, via: decision.via, preroute: true, chatId: chat.id, title: chat.title, projectId: decision.projectId || '', continued: !!isContinue,
    work: filed, unclear: unclear.map((u) => ({ goal: u.goal, candidates: u.candidates })) });
  return { chatId: chat.id, hint, decision };
}

/**
 * One brain turn with its bookkeeping: a traced request makes the turn a brain-turn span (each tool call in its stream
 * a child span) and hands the harness RIGS_TRACE, so handoffs it makes through the rigs MCP attach under it; onTool
 * hears every finished tool call, traced or not; the turn is filed in the usage ledger. `meta` adds facts to the span
 * (the fast path's lane, tier…), `lane` tags the ledger record, `runOpts` go to the runner.
 */
async function tracedRun({ chat, runner, resolved, sent, emit, meshSummary, projects, signal, tctx, onTool, onToolStart, usage, sessionKey, meta = {}, lane = '', tier = '', runOpts = {} }) {
  const startedAt = Date.now();
  const ctx = trace.parseContext(tctx);
  const span = ctx ? trace.startSpan({ ...ctx, kind: 'brain-turn', name: `${resolved.brain} ${resolved.model}`.trim(), input: sent, start: startedAt,
    meta: { provider: resolved.brain, model: resolved.model, effort: resolved.effort, chatId: chat.id, ...meta, ...(usage?.kind ? { purpose: usage.kind } : {}), ...(usage?.projectId ? { projectId: usage.projectId } : {}) } }) : null;
  const toolSpans = new Map();
  const toolNames = new Map();
  const tools = span || onTool || onToolStart ? trace.toolCollector({
    onStart: (key, c) => { toolNames.set(key, c.name); try { onToolStart?.(c); } catch {} if (span) toolSpans.set(key, span.child({ kind: 'tool-call', name: c.name, input: c.input, meta: c.meta, start: c.start })); },
    onEnd: (key, r) => { toolSpans.get(key)?.end(r); toolSpans.delete(key); try { onTool?.(toolNames.get(key), r); } catch {} toolNames.delete(key); },
  }) : null;
  if (span) tracedTurns.set(chat.id, { provider: resolved.brain, ctx: span.ctx });
  let out;
  try {
    out = await runner(chat, sent, resolved.model, resolved.effort, emit, meshSummary, signal, projects, { ...runOpts, tools, env: span ? { RIGS_TRACE: trace.formatContext(span.ctx) } : {} });
  } catch (e) {
    tools?.close('error');
    span?.end({ status: 'error', output: { error: e.message } });
    throw e;
  } finally { if (span) tracedTurns.delete(chat.id); }
  tools?.close('stopped');
  if (span) {
    const u = out.usage || null;
    span.end({
      status: signal?.aborted ? 'stopped' : out.error ? 'error' : 'ok',
      output: out.error && !out.text ? { error: out.error } : out.text,
      meta: {
        model: u?.model || resolved.model, sessionId: u?.sessionId || chat[sessionKey] || chat.codexThreadId || '', tokensFrom: u ? 'harness' : 'none',
        ...(u ? { inputTokens: u.inputTokens || 0, outputTokens: u.outputTokens || 0, cacheReadTokens: u.cacheReadTokens || 0, cacheWriteTokens: u.cacheWriteTokens || 0, costUsd: u.costUsd ?? null } : {}),
        ...(out.error ? { error: out.error } : {}),
      },
    });
  }
  await recordChatTurn({ chat, tag: usage, brain: resolved.brain, model: resolved.model, effort: resolved.effort, startedAt, out, aborted: !!signal?.aborted, lane, tier });
  return out;
}

/**
 * The quick-task fast path (src/quick.js): one bounded turn on the tier's model (`q` from resolveQuick) in the given
 * thread, in a fresh Claude session — the thread's own brain, model, effort and session are left as they were. Same
 * persona and tools as the full brain. Resolves to the turn's output, or to { escalate: reason, ran } when the full
 * brain should answer instead: the fast brain said so (ESCALATE_MARKER), it hit its turn limit or another error, timed
 * out (q.timeoutMs), or the tier's provider isn't available here. Then nothing of the turn stays in the thread. A turn
 * that already filed work (jarvis_task / project_create) is never re-run: that work was handed off as usual.
 *
 * With the local responder on (config.quick.local or quick: 'local', see quick.localResponder) the turn runs on the
 * local model instead (src/responder.js: read-only tools, its own timeout quick.local.timeoutMs) and the result carries
 * tier 'local' and the model. When the responder can't start (host or Ollama down, model not loaded, no first token in
 * time) nothing has been shown: the Claude turn above answers instead, and the result says why (fallback). One after
 * the other, never both at once. With it off this is exactly the Claude turn.
 */
export async function quickTurn(id, text, q, emit, { meshSummary = '', projects = '', signal, hint = '', trace: tctx = null, onTool = null } = {}) {
  const chat = await getChat(id);
  if (!chat) throw new Error('chat not found');
  const local = localResponder(q, config().quick, { self: config().name, text });
  let resolved = local.on ? { brain: 'ollama', model: local.model, effort: '' } : quickBrain(q, await availableBrains());
  if (!resolved) return { escalate: `${q.provider} is not available on this machine`, ran: false, tools: [] };
  let tier = local.on ? 'local' : q.tier;
  chat.messages.push({ role: 'user', text, ts: Date.now() });
  emit({ type: 'start', brain: resolved.brain, model: resolved.model, effort: resolved.effort, lane: 'quick', tier, ...(local.on ? { node: local.node } : {}) });
  // Shown on the work dashboard as JARVIS answering, like a full turn (sendMessage); cleared before an escalation re-runs.
  activeTurns.set(id, { id, title: chat.title, brain: resolved.brain, model: resolved.model, startedAt: Date.now(), text: truncate(text, 120), lane: 'quick' });
  const gate = escalationGate(emit);
  const ran = [];
  let filed = false;
  const sent = hint ? `${hint}\n${text}` : text;
  // One bounded turn: its own abort (the timeout) on top of Sir's stop.
  const bounded = async (runner, meta, runOpts, timeoutMs, ledgerTier = '') => {
    const ac = new AbortController();
    let timedOut = false;
    const stop = () => ac.abort();
    signal?.addEventListener('abort', stop, { once: true });
    const timer = setTimeout(() => { timedOut = true; ac.abort(); }, timeoutMs);
    try {
      const out = await tracedRun({ chat, runner, resolved, sent, emit: gate.emit, meshSummary, projects, signal: ac.signal, tctx, usage: null, sessionKey: 'quickSessionId', lane: 'quick', tier: ledgerTier, meta,
        onToolStart: (c) => ran.push(`${c.name}${c.input ? ' ' + truncate(typeof c.input === 'string' ? c.input : JSON.stringify(c.input), 120) : ''}`),
        onTool: (name, r) => { if (r.status === 'ok' && HANDOFF_TOOL.test(name || '')) filed = true; onTool?.(name, r); },
        runOpts });
      return { out, timedOut, timeoutMs };
    } finally { clearTimeout(timer); signal?.removeEventListener('abort', stop); }
  };
  const claudeTurn = () => bounded(runClaude, { lane: 'quick', tier: q.tier, why: q.why, maxTurns: q.maxTurns, timeoutMs: q.timeoutMs }, { quick: { maxTurns: q.maxTurns } }, q.timeoutMs);
  let fallback = '';
  let res;
  try {
    if (!local.on) res = await claudeTurn();
    else {
      const soulText = config().persona?.soul === false ? '' : soul();
      res = await bounded(runResponder, { lane: 'quick', tier: 'local', why: q.why, claudeTier: q.tier, node: local.node, timeoutMs: local.timeoutMs, maxRounds: local.maxRounds },
        { local, soul: soulText, self: config().name }, local.timeoutMs, 'local');
      if (res.out.unavailable && !signal?.aborted) {
        // Nothing was shown: today's Claude turn answers instead (docs/local-responder.md §5.5).
        fallback = res.out.unavailable;
        if (tctx) trace.recordSpan({ traceId: tctx.traceId, parentId: tctx.parentId || '', kind: 'event', name: 'responder-fallback', start: Date.now(),
          input: { reason: fallback, node: local.node, model: local.model }, output: `the ${q.tier} fast path answers instead`, meta: { lane: 'quick', tier: q.tier, local: true } });
        const claude = quickBrain(q, await availableBrains());
        if (claude) {
          resolved = claude;
          tier = q.tier;
          emit({ type: 'start', brain: resolved.brain, model: resolved.model, effort: resolved.effort, lane: 'quick', tier, fallback });
          Object.assign(activeTurns.get(id) || {}, { brain: resolved.brain, model: resolved.model });
          res = await claudeTurn();
        }
      }
    }
  } finally { activeTurns.delete(id); }
  const { out, timedOut } = res;
  const lanes = local.on ? { tier, model: resolved.model, ...(fallback ? { fallback } : {}) } : {};
  const userStopped = !!signal?.aborted;
  const asked = out.escalate ? { reason: out.escalate } : parseEscalation(out.text);
  const escalate = userStopped || filed ? null
    : timedOut ? `the fast path timed out after ${Math.round(res.timeoutMs / 1000)} s`
      : asked ? asked.reason
        : out.error ? `the fast path failed: ${truncate(out.error, 160)}` : null;
  if (escalate) {
    chat.messages.pop(); // the full brain's turn records the request itself
    await saveChat(chat);
    return { escalate, ran: true, tools: ran, usage: out.usage, ...lanes };
  }
  gate.flush();
  if (out.text) chat.messages.push({ role: 'assistant', text: out.text, brain: resolved.brain, model: resolved.model, effort: resolved.effort, lane: 'quick', ...(tier === 'local' ? { tier } : {}), ts: Date.now() });
  await saveChat(chat);
  if (out.error) emit({ type: 'error', message: out.error });
  emit({ type: 'done', text: out.text, brain: resolved.brain, model: resolved.model, effort: resolved.effort, chatId: chat.id, title: chat.title, lane: 'quick', tier });
  return local.on ? Object.assign(out, lanes) : out;
}

/**
 * `usage` tags the turn in the usage ledger: { kind: 'plan', projectId, projectName } for a planning call (the
 * planner asks through a chat); plain chat turns are "chat-turn" under the chat's own project.
 */
async function sendMessageInner(id, { text, brain, model, effort, usage }, emit, { meshSummary = '', projects = '', signal, hint = '', trace: tctx = null, onTool = null } = {}) {
  const chat = await getChat(id);
  if (!chat) throw new Error('chat not found');
  const switching = brain && brain !== chat.brain;
  const resolved = await resolveBrain(brain || chat.brain, switching ? model : (model || chat.model), effort ?? (switching ? '' : chat.effort));
  chat.brain = resolved.brain;
  chat.model = resolved.model;
  chat.effort = resolved.effort;
  if (!chat.messages.length && chat.title === 'New conversation') chat.title = truncate(text.replace(/\s+/g, ' '), 60);
  chat.messages.push({ role: 'user', text, ts: Date.now() });
  emit({ type: 'start', brain: resolved.brain, model: resolved.model, effort: resolved.effort });
  const turn = activeTurns.get(id);
  if (turn) Object.assign(turn, { title: chat.title, brain: resolved.brain, model: resolved.model });
  const runner = resolved.brain === 'claude' ? runClaude : resolved.brain === CLAUDE_OLLAMA ? runClaudeOllama : resolved.brain === 'codex' ? runCodex : runOllama;
  const sent = hint ? `${hint}\n${text}` : text;
  const out = await tracedRun({ chat, runner, resolved, sent, emit, meshSummary, projects, signal, tctx, onTool, usage,
    sessionKey: resolved.brain === CLAUDE_OLLAMA ? 'claudeOllamaSessionId' : 'claudeSessionId', meta: resolved.brain === CLAUDE_OLLAMA ? { endpoint: claudeOllamaUrl() } : {} });
  chat.seen = chat.seen || {};
  if (out.text) chat.messages.push({ role: 'assistant', text: out.text, brain: resolved.brain, model: resolved.model, effort: resolved.effort, ts: Date.now() });
  chat.seen[resolved.brain] = chat.messages.length;
  await saveChat(chat);
  if (out.error) emit({ type: 'error', message: out.error });
  emit({ type: 'done', text: out.text, brain: resolved.brain, model: resolved.model, effort: resolved.effort, chatId: chat.id, title: chat.title });
  return out;
}
