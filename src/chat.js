import crypto from 'node:crypto';
import fsp from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { config, RIGS_HOME } from './config.js';
import { bin, ollamaModels } from './tools.js';
import { HOME, augmentedPath, readJson, spawnCmd, truncate, writeJsonAtomic } from './util.js';

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
  return chats.filter(Boolean).map((c) => ({ id: c.id, title: c.title, brain: c.brain, model: c.model, updatedAt: c.updatedAt, count: c.messages.length }))
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

export async function createChat({ brain, model, title, cwd } = {}) {
  const c = {
    id: crypto.randomUUID(), title: title || 'New conversation', brain: brain || 'auto', model: model || '', cwd: cwd || HOME,
    createdAt: Date.now(), updatedAt: Date.now(), messages: [], claudeSessionId: null, codexThreadId: null, seen: {},
  };
  await saveChat(c);
  return c;
}

export async function deleteChat(id) {
  if (!/^[\w-]+$/.test(id)) return false;
  await fsp.rm(path.join(DIR, id + '.json'), { force: true });
  return true;
}

export async function availableBrains() {
  const cfg = config().brain;
  const o = await ollamaModels();
  const brains = [];
  if (bin('claude')) brains.push({ id: 'claude', label: 'Claude Code', models: ['', 'opus', 'sonnet', 'haiku', 'fable'], default: cfg.claudeModel });
  if (bin('codex')) brains.push({ id: 'codex', label: 'Codex', models: [''], default: cfg.codexModel });
  if (o.running) brains.push({ id: 'ollama', label: 'Ollama', models: o.models.map((m) => m.name), default: cfg.ollamaModel || o.models[0]?.name || '' });
  return brains;
}

async function resolveBrain(brain, model) {
  const list = await availableBrains();
  let b = brain && brain !== 'auto' ? list.find((x) => x.id === brain) : null;
  if (!b && config().brain.default !== 'auto') b = list.find((x) => x.id === config().brain.default);
  if (!b) b = list[0];
  if (!b) throw new Error('No brain available on this machine — install Claude Code, Codex or Ollama.');
  const m = model || b.default || (b.id === 'ollama' ? b.models[0] : '');
  if (b.id === 'ollama' && !m) throw new Error('Ollama is running but has no models — `ollama pull llama3.2`.');
  return { brain: b.id, model: m };
}

export function personaPrompt(meshSummary) {
  const p = config().persona;
  const humor = p.humor ?? 60;
  return [
    `You are ${p.name}, the voice of RIGS OS — the user's personal control plane for every workstation on their Tailscale network.`,
    `This brain is running on the machine "${config().name}" (${os.type()} ${os.release()}, ${process.arch}).`,
    `Address the user as "${p.address}". Be brief: answers are spoken aloud, so 1–3 sentences unless asked for detail. Humor setting ${humor}%: ${humor > 70 ? 'dry, cheeky wit welcome' : humor > 30 ? 'a light touch of dry wit' : 'strictly professional'}.`,
    'Capabilities you can use (when your harness exposes them as tools):',
    '- rigs MCP (mesh_*): list machines, run commands, read/write files, list/read/send to coding & chat sessions on ANY machine, start Claude Code/Codex/Ollama agents on a machine, ask another machine\'s brain, broadcast updates.',
    '- REA (reverse engineer anything, `rea` MCP / `npx rea-agents@latest`): inspect binaries, Electron/JS apps, .NET, APKs, websites — use it whenever asked how some software works.',
    '- OpenRig (`rig` CLI): persistent agent teams (rigs/seats), `rig send`, `rig queue`, `rig ps`.',
    `- The mesh's own source lives in a public GitHub repo checked out on every node; changes pushed there roll out to all machines (mesh_update).`,
    meshSummary ? `Current mesh state:\n${meshSummary}` : '',
  ].filter(Boolean).join('\n');
}

/** Messages this brain hasn't seen yet (said by other brains / typed while another brain was active). */
function unseenContext(chat, brainKey) {
  const from = chat.seen?.[brainKey] ?? 0;
  const slice = chat.messages.slice(from, -1);
  if (!slice.length) return '';
  return 'Earlier in this conversation (handled by other brains):\n' + slice.map((m) => `${m.role === 'user' ? 'User' : `${m.brain || 'assistant'}`}: ${truncate(m.text, 2000)}`).join('\n') + '\n\nNow the user says:\n';
}

function cleanEnv() {
  const env = { ...process.env, PATH: augmentedPath() };
  for (const k of Object.keys(env)) if (k.startsWith('CLAUDECODE') || k === 'CLAUDE_CODE_ENTRYPOINT') delete env[k];
  return env;
}

function streamProcess(cmd, args, { cwd, onLine, onStderr, signal }) {
  return new Promise((resolve) => {
    const child = spawnCmd(cmd, args, { cwd, env: cleanEnv(), stdio: ['ignore', 'pipe', 'pipe'] });
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

async function runClaude(chat, text, model, emit, meshSummary, signal) {
  const cfg = config().brain;
  const args = ['-p', unseenContext(chat, 'claude') + text, '--output-format', 'stream-json', '--verbose', '--include-partial-messages',
    '--append-system-prompt', personaPrompt(meshSummary), '--permission-mode', cfg.claudePermissionMode || 'default'];
  if (cfg.claudeAllowedTools?.length) args.push('--allowedTools', cfg.claudeAllowedTools.join(','));
  if (model) args.push('--model', model);
  if (chat.claudeSessionId) args.push('--resume', chat.claudeSessionId);
  let full = '';
  let error = null;
  const res = await streamProcess(bin('claude'), args, {
    cwd: chat.cwd || HOME, signal,
    onLine: (line) => {
      let e;
      try { e = JSON.parse(line); } catch { return; }
      if (e.session_id) chat.claudeSessionId = e.session_id;
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
        if (e.is_error) error = e.result || 'Claude Code returned an error';
        else if (!full && e.result) { full = e.result; emit({ type: 'delta', text: e.result }); }
      }
    },
  });
  if (res.code !== 0 && !full && !error) error = res.err.trim() || `claude exited with ${res.code}`;
  if (error && /authenticat|401|login/i.test(error)) error += ' — run `claude` once in a terminal on this machine and /login.';
  return { text: full, error };
}

async function runCodex(chat, text, model, emit, meshSummary, signal) {
  const cfg = config().brain;
  const prompt = (chat.codexThreadId ? '' : personaPrompt(meshSummary) + '\n\n') + unseenContext(chat, 'codex') + text;
  // `codex exec resume` takes its own option set (no --sandbox: that is fixed by the original session).
  const args = chat.codexThreadId
    ? ['exec', 'resume', '--json', '--skip-git-repo-check', ...(model ? ['-m', model] : []), chat.codexThreadId, prompt]
    : ['exec', '--json', '--skip-git-repo-check', '--sandbox', cfg.codexSandbox || 'read-only', ...(model ? ['-m', model] : []), prompt];
  let full = '';
  let error = null;
  const res = await streamProcess(bin('codex'), args, {
    cwd: chat.cwd || HOME, signal,
    onLine: (line) => {
      let e;
      try { e = JSON.parse(line); } catch { return; }
      if (e.type === 'thread.started' && e.thread_id) chat.codexThreadId = e.thread_id;
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
  return { text: full, error };
}

async function runOllama(chat, text, model, emit, meshSummary, signal) {
  const url = config().brain.ollamaUrl.replace(/\/$/, '') + '/api/chat';
  const messages = [{ role: 'system', content: personaPrompt(meshSummary) + '\n(You are running locally via Ollama without tools: if an action is needed, tell the user which machine/agent can do it, or suggest switching the brain to Claude Code or Codex.)' }];
  for (const m of chat.messages) messages.push({ role: m.role === 'user' ? 'user' : 'assistant', content: m.text });
  let full = '';
  try {
    const r = await fetch(url, { method: 'POST', body: JSON.stringify({ model, messages, stream: true }), headers: { 'content-type': 'application/json' }, signal });
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
          if (e.message?.content) { full += e.message.content; emit({ type: 'delta', text: e.message.content }); }
          if (e.error) return { text: full, error: e.error };
        } catch {}
      }
    }
  } catch (e) {
    if (e.name !== 'AbortError') return { text: full, error: 'Ollama: ' + e.message };
  }
  return { text: full, error: null };
}

/** Send a user message and stream the reply through `emit`. Persists everything. */
export async function sendMessage(id, { text, brain, model }, emit, { meshSummary = '', signal } = {}) {
  const chat = await getChat(id);
  if (!chat) throw new Error('chat not found');
  const resolved = await resolveBrain(brain || chat.brain, brain && brain !== chat.brain ? model : (model || chat.model));
  chat.brain = resolved.brain;
  chat.model = resolved.model;
  if (!chat.messages.length && chat.title === 'New conversation') chat.title = truncate(text.replace(/\s+/g, ' '), 60);
  chat.messages.push({ role: 'user', text, ts: Date.now() });
  emit({ type: 'start', brain: resolved.brain, model: resolved.model });
  const runner = resolved.brain === 'claude' ? runClaude : resolved.brain === 'codex' ? runCodex : runOllama;
  const out = await runner(chat, text, resolved.model, emit, meshSummary, signal);
  chat.seen = chat.seen || {};
  if (out.text) chat.messages.push({ role: 'assistant', text: out.text, brain: resolved.brain, model: resolved.model, ts: Date.now() });
  chat.seen[resolved.brain] = chat.messages.length;
  await saveChat(chat);
  if (out.error) emit({ type: 'error', message: out.error });
  emit({ type: 'done', text: out.text, brain: resolved.brain, model: resolved.model, chatId: chat.id, title: chat.title });
  return out;
}
